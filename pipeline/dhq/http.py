"""HTTP access with timeouts, retries with backoff, and rate-limit handling.

All network access in the pipeline goes through :class:`Fetcher` so that
behaviour is uniform and testable (tests inject a fake ``session``).
"""

from __future__ import annotations

import hashlib
import logging
import os
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Sequence
from urllib.parse import urljoin, urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool

log = logging.getLogger("dhq.http")

DEFAULT_USER_AGENT = "election-law-research-pipeline/0.1 (python-requests)"


def user_agent() -> str:
    """Client name sent with every request.

    The default is generic and names no project or person. A deployment that wants
    publishers to be able to reach its maintainers can set ``DHQ_USER_AGENT`` to a
    name with a contact address; that is a decision for whoever operates it.
    The client never presents itself as a web browser.
    """
    custom = os.environ.get("DHQ_USER_AGENT", "").strip()
    return custom if custom and "\n" not in custom and "\r" not in custom else DEFAULT_USER_AGENT

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
#: Largest body read by default. The biggest file the pipeline downloads whole is a boundary archive of about 13 MB.
DEFAULT_MAX_BYTES = 256 * 1024 * 1024
#: Longest a single request may take, retries and waits included. ``timeout`` bounds each socket operation only,
#: so a server that sends a byte now and then could otherwise hold a request open indefinitely.
DEFAULT_DEADLINE = 900.0
_CHUNK = 1024 * 1024
#: Redirects are followed by :class:`Fetcher` itself, never by ``requests``, so that each one is checked first.
REDIRECT_STATUS = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5
#: Request headers that carry a credential. ``requests`` drops ``Authorization`` when a redirect leads to another
#: host, but forwards every other header, an API key in ``X-API-KEY`` included. A request that carries any of these
#: therefore follows a redirect only to the same host and port, over https.
CREDENTIAL_HEADERS = frozenset({"authorization", "proxy-authorization", "x-api-key", "cookie"})


class FetchError(RuntimeError):
    """Raised when a resource cannot be retrieved after all retries.

    ``retry_after`` is the wait in seconds the server asked for with its last answer, when it named one.
    """

    def __init__(self, url: str, status: Optional[int], message: str, retry_after: Optional[float] = None):
        super().__init__(f"{message} [{status}] {url}")
        self.url = url
        self.status = status
        self.retry_after = retry_after

    @property
    def may_pass(self) -> bool:
        """Whether asking again later can succeed: the request failed in transit, or with an answer that is retried."""
        return self.status is None or self.status in RETRYABLE_STATUS


#: How often one of many files is asked for at most when the failed ones are asked for again together.
ROUNDS = 12
#: The pause before the second round when the server names none; it doubles from round to round, up to the longest.
ROUND_PAUSE = 5.0
ROUND_PAUSE_MAX = 60.0
#: A round that asked for this many files or more and had not one answered ends the rounds: the server is down.
DOWN_AT = 20


def in_rounds(fetcher: "Fetcher", items: Sequence[str], one: Callable[[str], Optional[BaseException]], *, what: str,
              workers: int = 4) -> Dict[str, BaseException]:
    """Do ``one`` for each item, and again for the items it failed, with one pause for all of them between two rounds.

    ``one`` makes each of its requests once (``attempts=1``) and returns what ended it, or nothing when it succeeded.
    An item is tried again when that is a :class:`FetchError` that :attr:`~FetchError.may_pass`. The pause is the
    longest wait the server asked for in the round, or a growing one when it named none. Returns the items that
    failed in the end, each with what ended its last attempt.

    A server can fail every second request for hours and ask with each failure to come back a minute later (GovInfo
    did, on 21 November 2026). Waiting that minute for each file in turn takes hours; waiting it once for all the
    failed files takes minutes, and no file is asked for sooner than the server said.
    """
    pending = list(dict.fromkeys(items))
    failed: Dict[str, BaseException] = {}
    for round_number in range(1, ROUNDS + 1):
        with ThreadPoolExecutor(max_workers=workers) as pool:
            ended = list(pool.map(one, pending))
        for item, error in zip(pending, ended):
            if error is None:
                failed.pop(item, None)
            else:
                failed[item] = error
        again = [item for item, error in zip(pending, ended) if isinstance(error, FetchError) and error.may_pass]
        if not again or round_number == ROUNDS:
            break
        if len(again) == len(pending) >= DOWN_AT:
            log.warning("%s: not one of %s was answered; not asked again in this run", what, len(pending))
            break
        asked = max((failed[item].retry_after or 0.0 for item in again), default=0.0)  # type: ignore[attr-defined]
        pause = asked or min(ROUND_PAUSE * 2 ** (round_number - 1), ROUND_PAUSE_MAX)
        log.warning("%s: %s of %s not answered in round %s; asked for again in %.0f s", what, len(again), len(pending), round_number, pause)
        fetcher.wait(pause)
        pending = again
    return failed


class CredentialMissing(RuntimeError):
    """Raised by adapters that need an API credential that is not configured."""


def _duplicate(source: Any) -> Optional[socket.socket]:
    """A duplicate of the socket behind ``source`` (a socket, or a response that has a ``fileno``), or ``None``.

    A duplicate, because the connection may close its own socket at any moment, and its
    file number may then be given to another connection. Shutting a duplicate down ends the
    connection that both share; closing it touches nothing else. It is a plain socket even
    when the connection uses TLS, so shutting it down never touches the TLS state that the
    reading thread uses.
    """
    fileno = getattr(source, "fileno", None)
    if not callable(fileno):
        return None
    try:
        fd = fileno()
        if not isinstance(fd, int) or fd < 0:
            return None
        dup = os.dup(fd)
    except (OSError, ValueError):
        return None
    try:
        return socket.socket(fileno=dup)
    except OSError:
        os.close(dup)
        return None


class _Deadline:
    """Shuts down every connection a request uses when the request's deadline passes.

    ``timeout`` bounds each socket operation only, so a server that sends a byte now and
    then, while the TLS handshake runs, while it sends its response headers or while it
    sends the body, could otherwise hold a request open indefinitely. Each connection the
    request uses is handed to :meth:`watch` as soon as its socket exists (by the
    connection classes below) or, for a session that does not use them, once the response
    headers have arrived. When the deadline passes, the sockets are shut down, which ends
    any read or write in progress on them. The timer thread starts with the first socket.
    """

    def __init__(self, seconds: float):
        self.fired = False
        self._ends = time.monotonic() + max(seconds, 0.0)
        self._lock = threading.Lock()
        self._socks: list[socket.socket] = []
        self._timer: Optional[threading.Timer] = None
        self._done = False

    def watch(self, source: Any) -> None:
        dup = _duplicate(source)
        if dup is None:
            return
        with self._lock:
            if self._done:  # the request is over; nothing to watch
                dup.close()
                return
            self._socks.append(dup)
            fired = self.fired
            if self._timer is None and not fired:
                self._timer = threading.Timer(max(self._ends - time.monotonic(), 0.0), self._fire)
                self._timer.daemon = True
                self._timer.start()
        if fired:  # a connection opened after the deadline passed
            _shut(dup)

    def _fire(self) -> None:
        with self._lock:
            self.fired = True
            socks = list(self._socks)
        for sock in socks:
            _shut(sock)

    def cancel(self) -> None:
        with self._lock:
            self._done = True
            timer = self._timer
        if timer is not None:
            timer.cancel()
            timer.join()  # a shutdown already under way finishes before the duplicates are closed
        with self._lock:
            socks, self._socks = self._socks, []
        for sock in socks:
            sock.close()


def _shut(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


#: The deadline of the request that the current thread is making, if any.
_current = threading.local()


def _watch_for_current_request(conn: Any, sock: Any) -> None:
    deadline = getattr(_current, "deadline", None)
    if deadline is not None and sock is not None and getattr(conn, "_dhq_watched_by", None) is not deadline:
        conn._dhq_watched_by = deadline
        deadline.watch(sock)


class _WatchedConnection:
    """Hands each socket of a connection to the deadline of the request that uses it.

    A new socket is handed over as soon as it is connected, before a TLS handshake or a
    proxy tunnel; a connection taken from the pool is handed over before its request is
    sent. So the deadline covers the handshake, the response headers and the body.
    """

    def _new_conn(self) -> Any:
        sock = super()._new_conn()  # type: ignore[misc]
        self._dhq_watched_by = None
        _watch_for_current_request(self, sock)
        return sock

    def request(self, *args: Any, **kwargs: Any) -> Any:
        _watch_for_current_request(self, getattr(self, "sock", None))
        return super().request(*args, **kwargs)  # type: ignore[misc]


class _WatchedHTTPConnection(_WatchedConnection, HTTPConnection):
    pass


class _WatchedHTTPSConnection(_WatchedConnection, HTTPSConnection):
    pass


class _WatchedHTTPPool(HTTPConnectionPool):
    ConnectionCls = _WatchedHTTPConnection


class _WatchedHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = _WatchedHTTPSConnection


_WATCHED_POOLS = {"http": _WatchedHTTPPool, "https": _WatchedHTTPSPool}


class _Adapter(HTTPAdapter):
    """requests' own transport, with connections that the request deadline can end (see :class:`_Deadline`)."""

    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = dict(_WATCHED_POOLS)

    def proxy_manager_for(self, proxy: str, **proxy_kwargs: Any) -> Any:
        manager = super().proxy_manager_for(proxy, **proxy_kwargs)
        if not proxy.lower().startswith("socks"):  # a SOCKS proxy has pool classes of its own
            manager.pool_classes_by_scheme = dict(_WATCHED_POOLS)
        return manager


def _no_redirect_target(resp: Any) -> None:
    return None


def _prepare(session: requests.Session) -> None:
    """Set up a ``requests`` session the way :class:`Fetcher` needs it.

    * It never follows a redirect on its own. With ``allow_redirects=False`` alone,
      ``requests`` still reads the whole body of a redirect to prepare the next request;
      here it sees no redirect target, so the body is left unread and :class:`Fetcher`
      decides on the redirect itself.
    * Its stock transports for http and https are replaced by :class:`_Adapter`, so the
      request deadline covers every phase of a request. A transport the caller mounted
      (anything other than requests' own ``HTTPAdapter``) is left in place; with it, the
      deadline covers the body only, from the moment the response headers have arrived.
    """
    session.get_redirect_target = _no_redirect_target  # type: ignore[method-assign]
    for prefix in ("https://", "http://"):
        if type(session.adapters.get(prefix)) is HTTPAdapter:
            session.mount(prefix, _Adapter())


class _Session(requests.Session):
    """The default session, set up by :func:`_prepare`."""

    def __init__(self) -> None:
        super().__init__()
        _prepare(self)


def _origin(url: str) -> tuple[str, str, Optional[int]]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        port = -1  # an unreadable port never matches
    return scheme, (parts.hostname or "").lower(), port or {"http": 80, "https": 443}.get(scheme)


def _redirect_refusal(source: str, target: str, credential: bool) -> Optional[str]:
    """Why a redirect from ``source`` to ``target`` is not followed, or ``None`` when it may be."""
    new = urlsplit(target).scheme.lower()
    if new not in ("http", "https"):
        return "it does not lead to a web address"
    if credential and (new != "https" or _origin(source) != _origin(target)):
        return ("the request carries a credential (an API key or token), which is sent only to the host it was "
                "meant for, over https")
    if urlsplit(source).scheme.lower() == "https" and new != "https":
        return "it leads from https to plain http"
    return None


@dataclass
class FetchResult:
    url: str
    status: int
    content: bytes
    headers: Mapping[str, str]

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest()

    def text(self, encoding: str = "utf-8") -> str:
        return self.content.decode(encoding, errors="replace")

    def json(self) -> Any:
        import json

        return json.loads(self.content.decode("utf-8-sig"))


class Fetcher:
    """Small wrapper around ``requests`` with polite defaults.

    * ``timeout`` applies to connect and to each read; ``deadline`` bounds the
      whole request, retries and waits included. It holds however slowly a server
      answers: when it passes, the connections the request uses are shut down,
      whether a TLS handshake, the response headers or the body is under way
      (see :class:`_Deadline`, and :func:`_prepare` for a session passed in).
    * Retries use exponential backoff (``backoff * 2**attempt``) and honour a
      numeric ``Retry-After`` header of an answer that is retried (at most 120
      seconds). GET and HEAD follow the same policy. A caller that asks for many
      files and retries the failed ones together passes ``attempts=1`` and waits
      once for all of them (:meth:`wait`).
    * Bodies are streamed: the status (and, for a range, ``Content-Range``) is
      checked before the body is read, and no more than ``max_bytes`` are read.
    * Redirects (at most ``MAX_REDIRECTS``) are followed by the Fetcher itself, and
      a redirect's body is never read (a ``requests`` session passed in is set up
      for this by :func:`_prepare`). None leads from https to plain http, and a
      request that carries a credential (``CREDENTIAL_HEADERS``) follows one only
      to the same host and port over https. Any other redirect ends the request
      with a :class:`FetchError`, without a retry.
    * ``min_interval`` enforces a minimum delay between requests per instance
      (per-source adapters each own a Fetcher, so this is a per-source limit).
    """

    def __init__(
        self,
        session: Optional[requests.Session] = None,
        *,
        timeout: float = 60.0,
        retries: int = 4,
        backoff: float = 1.5,
        min_interval: float = 0.0,
        sleep: Callable[[float], None] = time.sleep,
        headers: Optional[Mapping[str, str]] = None,
        deadline: float = DEFAULT_DEADLINE,
        max_bytes: int = DEFAULT_MAX_BYTES,
        clock: Callable[[], float] = time.monotonic,
    ):
        if session is None:
            session = _Session()
        elif isinstance(session, requests.Session):
            _prepare(session)
        self.session = session
        # A ``requests`` session is also told not to follow redirects; a test double follows none in any case.
        self._no_follow: dict[str, Any] = {"allow_redirects": False} if isinstance(self.session, requests.Session) else {}
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff
        self.min_interval = min_interval
        self.deadline = deadline
        self.max_bytes = max_bytes
        self._sleep = sleep
        self._clock = clock
        self._last_request = 0.0
        self.headers = {"User-Agent": user_agent(), **(headers or {})}
        self.request_count = 0

    def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        wait = self.min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            self._sleep(wait)

    def _late(self, url: str, status: Optional[int]) -> FetchError:
        return FetchError(url, status, f"response not complete within {self.deadline:g} seconds")

    def _body(self, url: str, resp: Any, limit: int, started: float, deadline: _Deadline) -> bytes:
        declared = str(resp.headers.get("Content-Length") or "")
        if declared.isdigit() and int(declared) > limit:
            raise FetchError(url, resp.status_code, f"response of {declared} bytes is larger than the {limit} expected")
        chunks: list[bytes] = []
        size = 0
        for chunk in resp.iter_content(chunk_size=_CHUNK):
            size += len(chunk)
            if size > limit:
                raise FetchError(url, resp.status_code, f"response is larger than the {limit} bytes expected")
            if deadline.fired or self._clock() - started > self.deadline:
                raise self._late(url, resp.status_code)
            chunks.append(chunk)
        if deadline.fired:  # a body without a stated length simply ends when the connection is shut down
            raise self._late(url, resp.status_code)
        return b"".join(chunks)

    def _open(self, method: str, url: str, headers: Mapping[str, str], params: Optional[Mapping[str, Any]],
              started: float, deadline: _Deadline) -> Any:
        """Send one request and follow its redirects; return the final response, its body unread."""
        credential = any(name.lower() in CREDENTIAL_HEADERS for name in headers)
        current, query = url, params
        for hop in range(MAX_REDIRECTS + 1):
            if hop:  # each redirect is a request of its own, spaced like any other
                self._throttle()
                self._last_request = time.monotonic()
            left = self.deadline - (self._clock() - started)
            if left <= 0:
                raise self._late(url, None)
            timeout = min(self.timeout, left)
            if method == "HEAD":
                resp = self.session.head(current, headers=headers, timeout=timeout, allow_redirects=False)
            else:
                resp = self.session.get(current, headers=headers, params=query, timeout=timeout, stream=True,
                                        **self._no_follow)
                # Already watched with :class:`_Adapter`; with a transport the caller chose, watched from here on.
                deadline.watch(getattr(resp, "raw", None))
            if deadline.fired:  # http.client takes a connection ended mid-headers as the end of the headers
                resp.close()
                raise self._late(url, resp.status_code)
            location = str(resp.headers.get("Location") or "") if resp.status_code in REDIRECT_STATUS else ""
            if not location:
                return resp
            resp.close()  # a redirect's body is never read
            target = urljoin(getattr(resp, "url", None) or current, location.strip())
            refusal = _redirect_refusal(current, target, credential)
            if refusal:
                where = "{0}://{1}".format(*_origin(target)[:2]) if _origin(target)[1] else "an unreadable address"
                raise FetchError(url, resp.status_code, f"redirect to {where} not followed: {refusal}")
            current, query = target, None
        raise FetchError(url, resp.status_code, f"more than {MAX_REDIRECTS} redirects")

    def wait(self, seconds: float) -> None:
        """Pause, by the same means as between two attempts (a test passes its own)."""
        if seconds > 0:
            self._sleep(seconds)

    def _request(self, method: str, url: str, *, headers: Optional[Mapping[str, str]] = None,
                 params: Optional[Mapping[str, Any]] = None, ok_statuses: tuple[int, ...] = (200,),
                 accept: Optional[Callable[[Any], None]] = None, max_bytes: Optional[int] = None,
                 attempts: Optional[int] = None) -> FetchResult:
        """One request under the retry policy. ``accept`` may refuse a response before its body is read."""
        merged = {**self.headers, **(headers or {})}
        limit = self.max_bytes if max_bytes is None else max_bytes
        deadline = _Deadline(self.deadline)
        outer = getattr(_current, "deadline", None)
        _current.deadline = deadline
        try:
            return self._attempts(method, url, merged, params, ok_statuses, accept, limit, deadline,
                                  self.retries + 1 if attempts is None else max(1, attempts))
        finally:
            _current.deadline = outer
            deadline.cancel()

    def _attempts(self, method: str, url: str, merged: Mapping[str, str], params: Optional[Mapping[str, Any]],
                  ok_statuses: tuple[int, ...], accept: Optional[Callable[[Any], None]], limit: int,
                  deadline: _Deadline, tries: int) -> FetchResult:
        started = self._clock()
        last_status: Optional[int] = None
        last_error = "request failed"
        attempts = 0
        for attempt in range(tries):
            self._throttle()
            self._last_request = time.monotonic()
            self.request_count += 1
            attempts += 1
            wait: Optional[float] = None
            try:
                resp = self._open(method, url, merged, params, started, deadline)
                try:
                    last_status = resp.status_code
                    if resp.status_code in ok_statuses:
                        if accept:
                            accept(resp)
                        content = b"" if method == "HEAD" else self._body(url, resp, limit, started, deadline)
                        return FetchResult(url, resp.status_code, content, resp.headers)
                finally:
                    resp.close()  # an unwanted body is never read
                if resp.status_code not in RETRYABLE_STATUS:
                    # 4xx such as 401/403/404 will not improve by retrying.
                    raise FetchError(url, resp.status_code, "non-retryable response")
                last_error = "retryable response"
                retry_after = str(resp.headers.get("Retry-After") or "")
                if retry_after.isdigit():
                    wait = min(float(retry_after), 120.0)
            except requests.RequestException as exc:  # network-level failure, also while reading the body
                if deadline.fired:  # the connection was ended by the deadline, not by the server
                    raise self._late(url, None) from None
                last_error = f"network error: {exc.__class__.__name__}"
                last_status = None
            if attempt == tries - 1:
                break  # no pointless wait after the last attempt
            delay = wait if wait is not None else self.backoff * (2**attempt)
            if self._clock() - started + delay > self.deadline:
                last_error += f"; no time left for another attempt within {self.deadline:g} seconds"
                break
            log.warning("retry %s in %.1fs: %s (%s)", attempt + 1, delay, url, last_error)
            self._sleep(delay)
        raise FetchError(url, last_status, f"{last_error} after {attempts} attempt{'' if attempts == 1 else 's'}", retry_after=wait)

    def get(
        self,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        params: Optional[Mapping[str, Any]] = None,
        ok_statuses: tuple[int, ...] = (200, 206),
        max_bytes: Optional[int] = None,
        attempts: Optional[int] = None,
    ) -> FetchResult:
        """``attempts`` is how often the request is made at most, when that is not ``retries + 1``."""
        return self._request("GET", url, headers=headers, params=params, ok_statuses=ok_statuses, max_bytes=max_bytes,
                             attempts=attempts)

    def get_range(self, url: str, start: int, end: int, total: Optional[int] = None) -> FetchResult:
        """Bytes ``start`` to ``end`` (inclusive) of ``url``.

        Only a 206 answer whose ``Content-Range`` names exactly this range (and, when
        ``total`` is given, a file of that size) is read, and no more than the range's
        length is read from it. A server that ignores the range and sends the whole
        file is refused before its body is read.
        """
        expected = f"bytes {start}-{end}/{'' if total is None else total}"

        def accept(resp: Any) -> None:
            stated = str(resp.headers.get("Content-Range") or "")
            if not (stated.startswith(expected) if total is None else stated == expected):
                raise FetchError(url, resp.status_code, f"answer covers {stated or 'no stated range'!r}, not the requested {expected!r}")

        result = self._request("GET", url, headers={"Range": f"bytes={start}-{end}"}, ok_statuses=(206,), accept=accept,
                               max_bytes=end - start + 1)
        if len(result.content) != end - start + 1:
            raise FetchError(url, result.status, "short range response")
        return result

    def head(self, url: str) -> Mapping[str, str]:
        return self._request("HEAD", url).headers

    def download(self, url: str, dest: Path, *, force: bool = False) -> Path:
        """Download ``url`` to ``dest`` atomically; reuse an existing file.

        The cache is keyed by path only; callers that need freshness pass
        ``force=True`` or compare ``Last-Modified`` via :meth:`head`.
        """
        dest = Path(dest)
        if dest.exists() and dest.stat().st_size > 0 and not force:
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        result = self.get(url)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(result.content)
        tmp.replace(dest)
        return dest
