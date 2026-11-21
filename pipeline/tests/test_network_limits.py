"""Security hardening of the network layer and of file writes.

* the request deadline holds however slowly a server answers: response headers, a proxy tunnel or a body (DS4);
* ZIP members cannot inflate beyond a stated, bounded size (DS4);
* a request that carries a credential never follows a redirect to another host or to plain http (DS5);
* the write helpers refuse a path that leaves the folder it was meant for (DS2).

Most tests use the fake session from ``conftest``. The deadline and redirect tests that need a real socket talk to a
server on 127.0.0.1 started by the test itself; the guard against real network access stays in force for every other
address.
"""

from __future__ import annotations

import http.server
import os
import socket
import struct
import threading
import time
import tracemalloc
import zipfile
from urllib.parse import urlsplit

import pytest
import requests

from dhq.adapters import census_geo
from dhq.http import MAX_REDIRECTS, FetchError, Fetcher, _Session
from dhq.remotezip import RemoteZip
from dhq.util import UnsafePathError, safe_path, write_bytes_atomic, write_json

from conftest import FakeResponse, make_zip

#: The real transport, taken before the autouse guard in conftest replaces it for each test.
_REAL_SEND = requests.adapters.HTTPAdapter.send
URL = "https://api.example.test/bills"


@pytest.fixture
def loopback(monkeypatch):
    """Let requests reach servers on 127.0.0.1 only."""

    def send(self, request, **kwargs):  # noqa: ANN001
        if urlsplit(request.url).hostname != "127.0.0.1":
            raise AssertionError(f"test tried to reach the network: {request.url}")
        return _REAL_SEND(self, request, **kwargs)

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, handler: type):
        super().__init__(("127.0.0.1", 0), handler)
        self.accepted = 0

    def get_request(self):  # noqa: ANN202
        self.accepted += 1
        return super().get_request()


@pytest.fixture
def serve():
    """Start a server on 127.0.0.1 for the test; it is stopped and closed afterwards."""
    started: list[Server] = []

    def start(handler: type) -> Server:
        server = Server(handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        started.append(server)
        return server

    yield start
    for server in started:
        server.shutdown()
        server.server_close()


def plain_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False  # no proxy from the environment
    return session


def default_session() -> requests.Session:
    session = _Session()
    session.trust_env = False
    return session


@pytest.fixture
def raw_serve():
    """Start a bare TCP server on 127.0.0.1 that hands each connection to ``behaviour``."""
    listeners: list[socket.socket] = []

    def start(behaviour) -> int:  # noqa: ANN001
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)

        def accept() -> None:
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                threading.Thread(target=behaviour, args=(conn,), daemon=True).start()

        threading.Thread(target=accept, daemon=True).start()
        listeners.append(listener)
        return listener.getsockname()[1]

    yield start
    for listener in listeners:
        try:
            listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        listener.close()


def drip(data: bytes, prefix: bytes = b""):  # noqa: ANN201
    """A server behaviour: read the request, send ``prefix`` at once, then ``data`` one byte every 50 ms."""

    def behaviour(conn: socket.socket) -> None:
        with conn:
            try:
                conn.recv(65536)
                conn.sendall(prefix)
                for byte in data:
                    time.sleep(0.05)
                    conn.sendall(bytes([byte]))
            except OSError:
                return

    return behaviour


PADDING = b"X-Padding: " + b"a" * 200 + b"\r\n"
RESPONSE_HEAD = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n" + PADDING + b"\r\nok"
TUNNEL_ANSWER = b"HTTP/1.1 200 Connection established\r\n" + PADDING + b"\r\n"


# --- DS4: the deadline holds whatever the chunk boundaries -------------------------------------------------------

class Drip(http.server.BaseHTTPRequestHandler):
    """Announces a large body, then sends one byte every 50 ms (or, on /chunked, a chunk-size line that never ends)."""

    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/ok":
            self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
            return
        if self.path == "/moved":  # a redirect whose body takes 10 s to arrive
            self.wfile.write(b"HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 200\r\n\r\n")
        elif self.path == "/chunked":
            self.wfile.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
        else:
            self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\n\r\n")
        self.wfile.flush()
        for _ in range(200 if self.path == "/moved" else 2000):
            time.sleep(0.05)
            try:
                self.wfile.write(b"1")
                self.wfile.flush()
            except OSError:
                return

    def log_message(self, *args) -> None:  # noqa: ANN002
        pass


@pytest.mark.parametrize("path", ["/drip", "/chunked"])
def test_a_body_sent_a_byte_at_a_time_is_cut_off_at_the_deadline(loopback, serve, path):
    """Every byte arrives well within the socket timeout, so only the deadline can end the request."""
    server = serve(Drip)
    with plain_session() as session:
        fetcher = Fetcher(session=session, retries=2, timeout=5, deadline=1)
        started = time.monotonic()
        with pytest.raises(FetchError, match="not complete within 1 seconds"):
            fetcher.get(f"http://127.0.0.1:{server.server_port}{path}")
    assert time.monotonic() - started < 3  # the deadline (1 s), not a full 1 MB chunk (more than 14 hours)
    assert fetcher.request_count == 1  # not retried


@pytest.mark.parametrize("make_session", [default_session, plain_session], ids=["default", "passed-in"])
@pytest.mark.parametrize("phase", ["headers", "proxy-tunnel"])
def test_a_response_head_sent_a_byte_at_a_time_is_cut_off_at_the_deadline(loopback, raw_serve, make_session, phase):
    """Before the body: the status line and headers, or a proxy's answer to CONNECT, sent slowly (about 11 s)."""
    port = raw_serve(drip(RESPONSE_HEAD if phase == "headers" else TUNNEL_ANSWER))
    with make_session() as session:
        if phase == "headers":
            url = f"http://127.0.0.1:{port}/"
        else:
            session.proxies = {"https": f"http://127.0.0.1:{port}"}
            url = "https://127.0.0.1:9/never-reached"
        fetcher = Fetcher(session=session, retries=2, timeout=5, deadline=1)
        started = time.monotonic()
        with pytest.raises(FetchError, match="not complete within 1 seconds"):
            fetcher.get(url)
    assert time.monotonic() - started < 3
    assert fetcher.request_count == 1  # not retried


def test_headers_cut_short_by_the_deadline_are_not_taken_as_complete(loopback, raw_serve):
    """``http.client`` ends the headers where the connection ends, so a HEAD would otherwise return part of them."""
    port = raw_serve(drip(PADDING, prefix=b"HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\n"))
    with default_session() as session:
        fetcher = Fetcher(session=session, retries=0, timeout=5, deadline=1)
        with pytest.raises(FetchError, match="not complete within 1 seconds"):
            fetcher.head(f"http://127.0.0.1:{port}/")


def test_the_deadline_watch_leaves_connection_reuse_alone(loopback, serve):
    server = serve(Drip)
    for make_session in (default_session, plain_session):
        with make_session() as session:
            fetcher = Fetcher(session=session, retries=0)
            for _ in range(5):
                assert fetcher.get(f"http://127.0.0.1:{server.server_port}/ok").content == b"hello"
    assert server.accepted == 2  # one connection for each session
    assert not [t for t in threading.enumerate() if isinstance(t, threading.Timer)]  # no deadline timer left running


# --- DS5: redirects of credentialed requests -----------------------------------------------------------------------

def redirect(to: str, status: int = 302) -> FakeResponse:
    return FakeResponse(status, b"<html>moved</html>", {"Location": to})


@pytest.mark.parametrize("header", [{"X-API-KEY": "synthetic-key"}, {"Authorization": "Token synthetic-token"}])
@pytest.mark.parametrize("target", ["https://elsewhere.example.test/bills", "http://api.example.test/bills",
                                    "https://api.example.test:8443/bills"])
def test_a_credentialed_request_never_follows_a_redirect_to_another_origin(fetcher, session, sleeps, header, target):
    moved = redirect(target)
    session.on(URL, moved)
    session.on(target, FakeResponse(200, b"{}"))
    with pytest.raises(FetchError, match="not followed: the request carries a credential") as caught:
        fetcher.get(URL, headers=header)
    assert session.urls() == [URL]  # the other address was never asked
    assert moved.bytes_read == 0 and sleeps == []  # the redirect's body is not read, and nothing is retried
    assert list(header.values())[0] not in str(caught.value)


def test_a_credentialed_request_follows_a_redirect_on_its_own_host_over_https(fetcher, session):
    session.on(URL, redirect("/v3/bills?page=1", 301))
    session.on("https://api.example.test/v3/bills?page=1", FakeResponse(200, b'{"ok": true}'))
    assert fetcher.get(URL, headers={"X-API-KEY": "synthetic-key"}, params={"q": "x"}).json() == {"ok": True}
    assert session.urls() == [URL, "https://api.example.test/v3/bills?page=1"]
    assert session.calls[1]["params"] is None  # the redirect target carries its own query


def test_redirects_without_a_credential_are_followed_but_never_from_https_to_http(fetcher, session):
    session.on(URL, redirect("https://mirror.example.test/bills"))
    session.on("https://mirror.example.test/bills", FakeResponse(200, b"[]"))
    assert fetcher.get(URL).json() == []
    session.on(URL, redirect("http://mirror.example.test/bills"))
    with pytest.raises(FetchError, match="from https to plain http"):
        fetcher.get(URL)


def test_a_redirect_loop_ends(fetcher, session):
    session.on(URL, redirect(URL))
    with pytest.raises(FetchError, match=f"more than {MAX_REDIRECTS} redirects"):
        fetcher.get(URL)
    assert len(session.calls) == MAX_REDIRECTS + 1


def test_a_session_passed_in_does_not_read_a_redirect_body_either(loopback, serve):
    """``requests`` reads a redirect's whole body to prepare the next request unless the session is set up not to."""
    server = serve(Drip)
    with plain_session() as session:
        started = time.monotonic()
        assert Fetcher(session=session, retries=0).get(f"http://127.0.0.1:{server.server_port}/moved").content == b"hello"
    assert time.monotonic() - started < 2


def test_a_real_session_does_not_carry_an_api_key_to_another_host(loopback, serve):
    """The reviewer's reproduction: 127.0.0.1 answers 302 to another host name on another port."""
    seen = []

    class Sink(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append(dict(self.headers))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args) -> None:  # noqa: ANN002
            pass

    sink = serve(Sink)

    class Moved(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{sink.server_port}/bills")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args) -> None:  # noqa: ANN002
            pass

    moved = serve(Moved)
    for session in (plain_session(), _Session()):
        session.trust_env = False
        with session:
            fetcher = Fetcher(session=session, retries=0)
            with pytest.raises(FetchError, match="not followed"):
                fetcher.get(f"http://127.0.0.1:{moved.server_port}/bills", headers={"X-API-KEY": "synthetic-key"})
    assert seen == []
    # Without a credential the same redirect is followed (both are plain http on the test machine).
    with plain_session() as session:
        assert Fetcher(session=session, retries=0).get(f"http://127.0.0.1:{moved.server_port}/bills").json() == {}
    assert len(seen) == 1


# --- DS4: ZIP inflation is bounded ------------------------------------------------------------------------------------

def state_size(data: bytes, stated: int) -> bytes:
    """Rewrite the uncompressed size that the local header and the central directory state for every member."""
    out = bytearray(data)
    for signature, offset in ((b"PK\x03\x04", 22), (b"PK\x01\x02", 24)):
        at = out.find(signature)
        while at >= 0:
            out[at + offset: at + offset + 4] = struct.pack("<I", stated)
            at = out.find(signature, at + 4)
    return bytes(out)


ARCHIVE = "https://archive.example.test/pubinfo.zip"


def test_a_member_stated_to_be_larger_than_its_use_allows_is_refused_unread(fetcher, session):
    session.serve_bytes(ARCHIVE, make_zip({"BILL_VERSION_TBL_1.lob": b"\0" * 300_000, "BILL_TBL.dat": "x" * 300_000}))
    archive = RemoteZip(ARCHIVE, fetcher)
    before = len(session.calls)
    with pytest.raises(FetchError, match="more than the 100000 expected"):
        archive.member_bytes("BILL_VERSION_TBL_1.lob", max_bytes=100_000)
    with pytest.raises(FetchError, match="more than the 100000 expected"):
        archive.read("BILL_TBL.dat", max_bytes=100_000)
    assert len(session.calls) == before  # refused on the directory entry alone
    assert archive.read("BILL_TBL.dat") == b"x" * 300_000  # the defaults allow it


def test_a_member_that_inflates_beyond_its_stated_size_is_refused(fetcher, session):
    session.serve_bytes(ARCHIVE, state_size(make_zip({"BILL_VERSION_TBL_1.lob": b"\0" * 5_000_000}), 1000))
    archive = RemoteZip(ARCHIVE, fetcher)
    with pytest.raises(FetchError, match="does not inflate to the 1000 bytes"):
        archive.member_bytes("BILL_VERSION_TBL_1.lob")
    with pytest.raises(zipfile.BadZipFile):  # cut at the stated size, then the CRC fails
        archive.read("BILL_VERSION_TBL_1.lob")


def test_reading_a_member_never_inflates_much_more_than_it_states(fetcher, session):
    """``zipfile.ZipFile.read`` would inflate all 40 MB before cutting the result to the 1000 bytes stated."""
    session.serve_bytes(ARCHIVE, state_size(make_zip({"BILL_HISTORY_TBL.dat": b"\0" * 40_000_000}), 1000))
    archive = RemoteZip(ARCHIVE, fetcher)
    tracemalloc.start()
    try:
        with pytest.raises(zipfile.BadZipFile):
            archive.read("BILL_HISTORY_TBL.dat")
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 8_000_000


def test_a_member_that_ends_short_of_its_stated_size_is_refused(fetcher, session):
    session.serve_bytes(ARCHIVE, state_size(make_zip({"BILL_VERSION_TBL_1.lob": b"<xml/>"}), 7))
    with pytest.raises(FetchError, match="does not inflate to the 7 bytes"):
        RemoteZip(ARCHIVE, fetcher).member_bytes("BILL_VERSION_TBL_1.lob")


def test_lines_are_read_one_at_a_time_and_an_endless_line_is_refused(fetcher, session):
    session.serve_bytes(ARCHIVE, make_zip({"geo.txt": "a|1\r\nb|2\r\n" + "c" * 3000, "ok.txt": "x\ny\n"}))
    archive = RemoteZip(ARCHIVE, fetcher)
    assert archive.head_lines("geo.txt", 2) == ["a|1", "b|2"]
    assert list(archive.lines("ok.txt")) == ["x", "y"]
    with pytest.raises(FetchError, match="longer than 1000 bytes"):
        list(archive.lines("geo.txt", max_line=1000))


def test_a_boundary_archive_is_unpacked_within_its_stated_sizes(tmp_path, monkeypatch):
    good = tmp_path / "good.zip"
    good.write_bytes(make_zip({"folder/cb.shp": b"\1" * 5000, "../../escape.dbf": b"\2" * 10}))
    out = census_geo._unzip(good, tmp_path / "good")
    assert sorted(p.name for p in out.iterdir()) == ["cb.shp", "escape.dbf"]  # flattened into the folder
    assert (out / "cb.shp").read_bytes() == b"\1" * 5000

    monkeypatch.setattr(census_geo, "MAX_MEMBER_BYTES", 4000)
    with pytest.raises(ValueError, match="refused: its directory states"):
        census_geo._unzip(good, tmp_path / "refused")
    assert not any((tmp_path / "refused").iterdir())  # nothing was unpacked

    liar = tmp_path / "liar.zip"
    liar.write_bytes(state_size(make_zip({"cb.shp": b"\0" * 3_000_000}), 100))
    with pytest.raises(zipfile.BadZipFile):
        census_geo._unzip(liar, tmp_path / "liar")
    assert (tmp_path / "liar" / "cb.shp").stat().st_size <= 100


# --- DS2: writes stay inside their folder -----------------------------------------------------------------------------

def test_write_json_refuses_a_path_that_leaves_its_folder(tmp_path):
    bills = tmp_path / "staging" / "legislation" / "bills"
    traversal = bills / "ca-20252026-ab1/../../../../package.json"
    with pytest.raises(UnsafePathError, match="parent folder"):
        write_json(traversal, {"id": "x"})
    with pytest.raises(UnsafePathError, match="parent folder"):
        write_json(traversal, {"id": "x"}, root=bills)
    assert not (bills / "ca-20252026-ab1").exists()  # refused before any folder was made
    assert not (tmp_path / "package.json").exists()

    outside = tmp_path / "elsewhere"
    outside.mkdir()
    bills.mkdir(parents=True)
    os.symlink(outside, bills / "link")
    with pytest.raises(UnsafePathError, match="outside"):
        write_json(bills / "link" / "x.json", {}, root=bills)
    with pytest.raises(UnsafePathError, match="outside"):
        write_bytes_atomic(tmp_path / "x.dat", b"x", root=bills)
    with pytest.raises(UnsafePathError, match="outside"):  # a name that is an absolute path replaces the folder
        write_json(bills / str(outside / "x.json"), {}, root=bills)
    assert list(outside.iterdir()) == []

    assert write_json(bills / "ca-20252026-ab1.json", {"id": "ca-20252026-ab1"}, root=bills) is True
    write_bytes_atomic(bills / "deeper" / "y.xml", b"<x/>", root=bills)
    assert (bills / "deeper" / "y.xml").read_bytes() == b"<x/>"
    assert safe_path(bills, bills) == bills


def test_a_census_member_that_never_reaches_its_stop_line_is_refused():
    """census_pop reads only the head of each member; a member whose head never ends is refused, not read to the end."""
    import pytest
    from dhq.adapters import census_pop

    class FakeZip:
        def lines(self, name):
            def endless():
                while True:
                    yield "PLST|AL|040|00|00"
            return endless()

    with pytest.raises(ValueError, match="no end of the needed rows"):
        census_pop._head_until(FakeZip(), "algeo2020.pl", lambda line: False)
    assert census_pop._head_until(FakeZip(), "algeo2020.pl", lambda line: True) == []
