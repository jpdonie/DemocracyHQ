"""HTTP layer: timeouts, retries with backoff, rate limits, hashing, safe downloads."""

import hashlib

import pytest
import requests

from dhq.http import DEFAULT_USER_AGENT, FetchError, Fetcher, FetchResult, user_agent

from dhq.remotezip import RemoteZip

from conftest import FakeResponse, make_zip

URL = "https://source.example.test/data.json"


def test_success_returns_content_and_its_hash(fetcher, session):
    session.on(URL, FakeResponse(200, b'{"a": 1}'))
    result = fetcher.get(URL)
    assert result.json() == {"a": 1}
    assert result.sha256 == hashlib.sha256(b'{"a": 1}').hexdigest()
    assert session.calls[0]["timeout"] == fetcher.timeout  # every request carries a timeout


def test_retries_a_failing_source_with_growing_delays(fetcher, session, sleeps):
    session.on(URL, FakeResponse(503), FakeResponse(502), FakeResponse(200, b"ok"))
    assert fetcher.get(URL).content == b"ok"
    assert len(session.calls) == 3
    assert sleeps == [1.5, 3.0]


def test_honours_retry_after_on_rate_limit_and_caps_it(fetcher, session, sleeps):
    session.on(URL, FakeResponse(429, headers={"Retry-After": "7"}), FakeResponse(429, headers={"Retry-After": "9999"}), FakeResponse(200, b"ok"))
    assert fetcher.get(URL).content == b"ok"
    assert sleeps == [7.0, 120.0]


def test_gives_up_after_the_configured_attempts(fetcher, session, sleeps):
    session.on(URL, FakeResponse(503))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL)
    assert info.value.status == 503
    assert len(session.calls) == 3  # first try + 2 retries
    assert len(sleeps) == 2  # no pointless wait after the last attempt


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_does_not_retry_or_work_around_a_refusal(fetcher, session, sleeps, status):
    session.on(URL, FakeResponse(status))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL)
    assert info.value.status == status
    assert len(session.calls) == 1
    assert sleeps == []


def test_retries_network_errors_then_reports_them(fetcher, session):
    session.on(URL, requests.ConnectionError("down"), requests.Timeout("slow"), FakeResponse(200, b"ok"))
    assert fetcher.get(URL).content == b"ok"
    session.on(URL, requests.ConnectionError("down"))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL)
    assert info.value.status is None
    assert "ConnectionError" in str(info.value)


def test_error_message_never_contains_request_headers(fetcher, session):
    session.on(URL, FakeResponse(403))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL, headers={"Authorization": "Token synthetic-secret-value"})
    assert "synthetic-secret-value" not in str(info.value)


def test_minimum_interval_between_requests(session, sleeps):
    polite = Fetcher(session=session, min_interval=5.0, sleep=sleeps.append)
    session.on(URL, FakeResponse(200, b"ok"))
    polite.get(URL)
    polite.get(URL)
    assert len(sleeps) == 1 and 4.0 < sleeps[0] <= 5.0


def test_default_client_name_is_generic_and_is_not_a_browser(session):
    session.on(URL, FakeResponse(200, b"ok"))
    Fetcher(session=session).get(URL)
    sent = session.calls[0]["headers"]["User-Agent"]
    assert sent == DEFAULT_USER_AGENT
    assert "Mozilla" not in sent and "Chrome" not in sent and "@" not in sent


def test_client_name_can_be_set_by_the_operator(monkeypatch):
    monkeypatch.setenv("DHQ_USER_AGENT", "my-deployment/1.0 (+https://example.test/contact)")
    assert user_agent() == "my-deployment/1.0 (+https://example.test/contact)"
    monkeypatch.setenv("DHQ_USER_AGENT", "bad\r\nX-Injected: 1")
    assert user_agent() == DEFAULT_USER_AGENT


def test_download_is_atomic_and_reuses_the_cached_file(fetcher, session, tmp_path):
    session.on(URL, FakeResponse(200, b"first"))
    dest = tmp_path / "cache" / "file.bin"
    assert fetcher.download(URL, dest).read_bytes() == b"first"
    assert not dest.with_suffix(".bin.part").exists()
    session.on(URL, FakeResponse(200, b"second"))
    assert fetcher.download(URL, dest).read_bytes() == b"first"  # cached
    assert fetcher.download(URL, dest, force=True).read_bytes() == b"second"


def test_failed_download_leaves_the_previous_file_untouched(fetcher, session, tmp_path):
    dest = tmp_path / "file.bin"
    dest.write_bytes(b"verified copy")
    session.on(URL, FakeResponse(503))
    with pytest.raises(FetchError):
        fetcher.download(URL, dest, force=True)
    assert dest.read_bytes() == b"verified copy"
    assert list(tmp_path.iterdir()) == [dest]


def test_json_with_byte_order_mark():
    assert FetchResult(URL, 200, b"\xef\xbb\xbf{\"a\": 1}", {}).json() == {"a": 1}


def test_retry_after_is_not_waited_for_after_the_last_attempt(fetcher, session, sleeps):
    session.on(URL, FakeResponse(503, headers={"Retry-After": "120"}))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL)
    assert info.value.status == 503 and len(session.calls) == 3
    assert sleeps == [120.0, 120.0]  # waits before the second and third attempts only


def test_a_request_can_be_made_once_and_its_failure_tells_what_the_server_asked_for(fetcher, session, sleeps):
    # A caller that asks for many files makes each request once and waits once for all the failed ones.
    session.on(URL, FakeResponse(502, headers={"Retry-After": "60"}))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL, attempts=1)
    assert len(session.calls) == 1 and sleeps == []
    assert info.value.retry_after == 60.0 and info.value.may_pass and "after 1 attempt " in str(info.value)
    fetcher.wait(info.value.retry_after)
    assert sleeps == [60.0]
    # A refusal names no wait, and asking again does not help.
    session.on(URL, FakeResponse(404))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL, attempts=1)
    assert info.value.retry_after is None and not info.value.may_pass
    # A request that failed in transit can pass later.
    session.on(URL, requests.ConnectionError("down"))
    with pytest.raises(FetchError) as info:
        fetcher.get(URL, attempts=1)
    assert info.value.status is None and info.value.may_pass


def test_head_is_retried_under_the_same_policy_and_never_leaks_a_raw_network_error(fetcher, session, sleeps):
    session.on("HEAD " + URL, FakeResponse(503), requests.ConnectionError("down"), FakeResponse(200, b"", {"Last-Modified": "x"}))
    assert fetcher.head(URL)["Last-Modified"] == "x"
    assert sleeps == [1.5, 3.0] and session.urls("HEAD") == [URL] * 3
    session.on("HEAD " + URL, requests.ConnectionError("down"))
    with pytest.raises(FetchError) as info:
        fetcher.head(URL)
    assert info.value.status is None and "ConnectionError" in str(info.value)
    session.on("HEAD " + URL, FakeResponse(404))
    asked = len(session.calls)
    with pytest.raises(FetchError) as info:
        fetcher.head(URL)
    assert info.value.status == 404 and len(session.calls) == asked + 1  # a refusal is not retried


def test_a_range_request_answered_with_the_whole_file_is_refused_before_its_body_is_read(fetcher, session):
    whole = FakeResponse(200, bytes(3 * 1024 * 1024))
    session.on(URL, whole)
    with pytest.raises(FetchError) as info:
        fetcher.get_range(URL, 0, 99, total=len(whole.body))
    assert info.value.status == 200 and whole.bytes_read == 0
    assert session.calls[-1]["headers"]["Range"] == "bytes=0-99" and session.calls[-1]["stream"] is True


@pytest.mark.parametrize("content_range", [None, "bytes 100-199/5000", "bytes 0-99/4000"], ids=["missing", "another range", "another file size"])
def test_a_range_answer_that_does_not_state_the_requested_range_is_refused_unread(fetcher, session, content_range):
    answer = FakeResponse(206, bytes(100), {"Content-Range": content_range} if content_range else {})
    session.on(URL, answer)
    with pytest.raises(FetchError, match="not the requested"):
        fetcher.get_range(URL, 0, 99, total=5000)
    assert answer.bytes_read == 0 and len(session.calls) == 1


def test_a_remote_zip_never_reads_a_whole_archive_sent_in_place_of_a_range(fetcher, session):
    data = make_zip({"a.txt": "A" * 100})
    whole = FakeResponse(200, data)
    session.on("HEAD " + URL, FakeResponse(200, b"", {"Accept-Ranges": "bytes", "Content-Length": str(len(data))}))
    session.on(URL, whole)
    with pytest.raises(FetchError, match="non-retryable response"):
        RemoteZip(URL, fetcher)
    assert whole.bytes_read == 0 and session.calls[-1]["stream"] is True


def test_a_body_larger_than_expected_is_not_read_to_the_end(session, sleeps):
    small = Fetcher(session=session, retries=2, sleep=sleeps.append, max_bytes=1024 * 1024 + 1)
    declared = FakeResponse(200, bytes(3 * 1024 * 1024), {"Content-Length": str(3 * 1024 * 1024)})
    session.on(URL, declared)
    with pytest.raises(FetchError, match="larger than"):
        small.get(URL)
    assert declared.bytes_read == 0  # refused on its declared size
    undeclared = FakeResponse(200, bytes(3 * 1024 * 1024))
    session.on(URL, undeclared)
    with pytest.raises(FetchError, match="larger than"):
        small.get(URL)
    assert undeclared.bytes_read == 2 * 1024 * 1024 and sleeps == []  # stopped at the second chunk, and not retried


def test_a_request_has_an_overall_deadline(session, sleeps):
    ticks = iter(range(0, 10_000, 4))
    slow = Fetcher(session=session, retries=2, sleep=sleeps.append, deadline=10, clock=lambda: next(ticks))
    dripping = FakeResponse(200, bytes(5 * 1024 * 1024))
    session.on(URL, dripping)
    with pytest.raises(FetchError, match="not complete within 10 seconds"):
        slow.get(URL)
    assert dripping.bytes_read < len(dripping.body) and len(session.calls) == 1
    # Waiting for a retry that would end after the deadline is pointless: the request gives up instead.
    session.on(URL, FakeResponse(503, headers={"Retry-After": "60"}))
    with pytest.raises(FetchError, match="no time left"):
        slow.get(URL)
    assert sleeps == [] and len(session.calls) == 2
