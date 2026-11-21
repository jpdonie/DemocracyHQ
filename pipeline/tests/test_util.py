"""Determinism helpers: stable JSON, hashing, idempotent writes, clock, .env reader."""

import json
import logging
import os
from datetime import datetime, timezone

import pytest

from dhq.util import content_hash, http_date_to_iso, load_dotenv, now_iso, read_json, stable_json, write_json


def test_stable_json_is_independent_of_key_order():
    a = {"b": [1, 2], "a": {"y": "é", "x": None}}
    b = {"a": {"x": None, "y": "é"}, "b": [1, 2]}
    assert stable_json(a) == stable_json(b) == '{"a":{"x":null,"y":"é"},"b":[1,2]}'
    assert content_hash(a) == content_hash(b)
    assert content_hash(a) != content_hash({**a, "b": [2, 1]})


def test_write_json_is_idempotent(tmp_path):
    path = tmp_path / "nested" / "file.json"
    assert write_json(path, {"b": 1, "a": 2}) is True
    first = path.read_bytes()
    assert write_json(path, {"a": 2, "b": 1}) is False  # same data, nothing rewritten
    assert path.read_bytes() == first
    assert write_json(path, {"a": 3, "b": 1}) is True
    assert read_json(path) == {"a": 3, "b": 1}
    assert [p.name for p in path.parent.iterdir()] == ["file.json"]  # no temp file left behind


def test_read_json_default_for_a_missing_file(tmp_path):
    assert read_json(tmp_path / "missing.json") is None
    assert read_json(tmp_path / "missing.json", {"x": 1}) == {"x": 1}


def test_clock_can_be_pinned(monkeypatch):
    monkeypatch.setenv("DHQ_NOW", "2026-01-01T00:00:00Z")
    assert now_iso() == "2026-01-01T00:00:00Z"
    monkeypatch.delenv("DHQ_NOW")
    assert now_iso().endswith("Z") and len(now_iso()) == 20


def test_a_pinned_clock_is_ignored_outside_the_tests_unless_explicitly_allowed(monkeypatch, caplog):
    """A ``DHQ_NOW`` left in a ``.env`` file must not back-date a real run."""
    monkeypatch.delenv("PYTEST_CURRENT_TEST")
    monkeypatch.delenv("DHQ_ALLOW_NOW", raising=False)
    monkeypatch.setenv("DHQ_NOW", "2020-01-01T00:00:00Z")
    with caplog.at_level(logging.WARNING, logger="dhq.util"):
        now = now_iso()
    real = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs((datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") - real).total_seconds()) < 60  # the real clock
    assert "DHQ_NOW is set but ignored" in caplog.text
    monkeypatch.setenv("DHQ_ALLOW_NOW", "1")
    assert now_iso() == "2020-01-01T00:00:00Z"
    monkeypatch.setenv("DHQ_NOW", "2020-01-01")
    with pytest.raises(ValueError, match="DHQ_NOW must be a UTC timestamp"):
        now_iso()


def test_http_date_to_iso():
    assert http_date_to_iso("Thu, 05 Dec 2024 13:07:34 GMT") == "2024-12-05T13:07:34Z"
    assert http_date_to_iso("not a date") is None
    assert http_date_to_iso(None) is None


def test_load_dotenv_reads_keys_without_overriding_or_revealing_values(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\n\nSYN_A=one\nSYN_B='two words'\nSYN_EMPTY=\nSYN_PRESET=from-file\nnot a line\n1BAD=x\n", encoding="utf-8"
    )
    for name in ("SYN_A", "SYN_B", "SYN_EMPTY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SYN_PRESET", "from-environment")
    loaded = load_dotenv(env)
    assert sorted(loaded) == ["SYN_A", "SYN_B"]  # names only
    assert os.environ["SYN_A"] == "one" and os.environ["SYN_B"] == "two words"
    assert os.environ["SYN_PRESET"] == "from-environment"
    assert "SYN_EMPTY" not in os.environ
    assert load_dotenv(tmp_path / "missing.env") == []
    for name in ("SYN_A", "SYN_B"):
        monkeypatch.delenv(name, raising=False)


def test_example_env_file_contains_no_values():
    from dhq.util import REPO_ROOT

    for line in (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key in ("COURTLISTENER_API_TOKEN", "OPENSTATES_API_KEY"):
            assert value == "", f"{key} must be empty in .env.example"
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    # Every local settings file (.env, .env.local, .env.production, ...) is ignored; only the example is shared.
    assert ".env*" in ignored and "!.env.example" in ignored
    assert ignored.index("!.env.example") > ignored.index(".env*")  # the later rule wins in .gitignore
    json.dumps(ignored)
