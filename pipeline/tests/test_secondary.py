"""Optional, credential-gated adapters: their credentials.

What is read from CourtListener is tested in test_cl_opinions.py, and what is read from Open States in test_os_bulk.py.
"""

import pytest

from dhq.adapters import cl_opinions, courtlistener, os_bulk
from dhq.http import CredentialMissing


def test_without_a_token_the_adapter_refuses_and_makes_no_request(fetcher, session):
    with pytest.raises(CredentialMissing, match="COURTLISTENER_API_TOKEN is not set"):
        cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))
    with pytest.raises(CredentialMissing, match="OPENSTATES_API_KEY is not set"):
        os_bulk.api_key()
    assert session.calls == []


def test_a_blank_token_counts_as_missing(monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "   ")
    with pytest.raises(CredentialMissing):
        courtlistener.token()
