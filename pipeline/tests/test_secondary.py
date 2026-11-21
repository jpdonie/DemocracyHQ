"""Optional, credential-gated adapters: the credentials of both, and the records made from Open States.

The responses below are SYNTHETIC. They follow the field names in the service's public API documentation; they were
not recorded from the live service. What is read from CourtListener is tested in test_cl_opinions.py.
"""

import pytest

from dhq.adapters import cl_opinions, courtlistener, openstates
from dhq.http import CredentialMissing
from dhq.schemas import VerificationStatus

from conftest import FakeResponse

CHECKED = "2026-06-15T12:00:00Z"


def test_without_a_token_the_adapter_refuses_and_makes_no_request(fetcher, session):
    with pytest.raises(CredentialMissing, match="COURTLISTENER_API_TOKEN is not set"):
        cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))
    with pytest.raises(CredentialMissing, match="OPENSTATES_API_KEY is not set"):
        openstates.search_bills(fetcher, "tx", "elections", checked_at=CHECKED)
    assert session.calls == []


def test_a_blank_token_counts_as_missing(monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "   ")
    with pytest.raises(CredentialMissing):
        courtlistener.token()


def os_item(**overrides):
    item = {
        "id": "ocd-bill/00000000-0000-0000-0000-000000000001", "session": "2026S", "identifier": "HB 1",
        "jurisdiction": {"name": "Texas"}, "classification": ["bill"], "title": "Relating to synthetic elections.",
        "subject": ["Elections"], "first_action_date": "2026-01-10", "latest_action_date": "2026-03-01T00:00:00+00:00",
        "latest_action_description": "Referred to committee", "versions": [{}, {}],
        "sources": [{"url": "https://capitol.example.test/hb1"}], "openstates_url": "https://openstates.example.test/hb1",
    }
    item.update(overrides)
    return item


def test_openstates_record_is_labelled_secondary_and_links_the_official_page():
    bill = openstates.normalise_bill(os_item(), checked_at=CHECKED)
    assert bill.id == "os-00000000-0000-0000-0000-000000000001"
    assert (bill.state, bill.stateAbbr) == ("48", "TX")
    assert bill.officialUrl == "https://capitol.example.test/hb1"
    assert bill.lastActionDate == "2026-03-01"
    assert bill.verification.status == VerificationStatus.IMPORTED_SECONDARY
    # The aggregator's last action is reported as text; no measure state, chapter or effective date is derived.
    assert bill.legislativeStatus.measureState is None
    assert bill.legislativeStatus.currentStatus == "Referred to committee"
    assert bill.chapter is None


def test_openstates_skips_what_it_cannot_place_or_link():
    assert openstates.normalise_bill(os_item(jurisdiction={"name": "Synthetica"}), checked_at=CHECKED) is None
    assert openstates.normalise_bill(os_item(sources=[], openstates_url=None), checked_at=CHECKED) is None
    assert openstates.normalise_bill(os_item(sources=[{"url": "http://capitol.example.test/hb1"}]), checked_at=CHECKED) is None
    assert openstates.normalise_bill(os_item(identifier=""), checked_at=CHECKED) is None


def test_openstates_search_pages_and_deduplicates(fetcher, session, monkeypatch):
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-key")
    second = os_item(id="ocd-bill/00000000-0000-0000-0000-000000000002", identifier="HB 2")
    session.on(openstates.BILLS_URL,
               FakeResponse(200, {"results": [os_item(), os_item()], "pagination": {"max_page": 2}}),
               FakeResponse(200, {"results": [second], "pagination": {"max_page": 2}}))
    bills = openstates.search_bills(fetcher, "tx", "elections", checked_at=CHECKED)
    assert [b.identifier for b in bills] == ["HB 1", "HB 2"]
    assert [c["params"]["page"] for c in session.calls] == [1, 2]
    assert all(c["headers"]["X-API-KEY"] == "synthetic-key" for c in session.calls)
