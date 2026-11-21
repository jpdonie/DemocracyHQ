"""Optional, credential-gated adapters (CourtListener, Open States).

The responses below are SYNTHETIC. They follow the field names in each service's public
API documentation; they were not recorded from the live services, which have never been
called by this project because no credential was available.
"""

import pytest

from dhq.adapters import courtlistener, openstates
from dhq.http import CredentialMissing, FetchError
from dhq.schemas import VerificationStatus

from conftest import FakeResponse

CHECKED = "2026-06-15T12:00:00Z"


def cl_item(docket_id=101, **overrides):
    item = {
        "docket_id": docket_id, "caseName": "Synthetic Voters v. Synthetic County", "docketNumber": "1:26-cv-00001",
        "court_id": "synd", "dateFiled": "2026-02-01", "dateTerminated": "2026-05-01", "docket_absolute_url": f"/docket/{docket_id}/synthetic/",
        "pacer_case_id": 555,
        "recap_documents": [{"entry_date_filed": "2026-02-01"}, {"entry_date_filed": "2026-04-10"}, {"entry_date_filed": None}],
    }
    item.update(overrides)
    return item


def test_without_a_token_the_adapter_refuses_and_makes_no_request(fetcher, session):
    with pytest.raises(CredentialMissing, match="COURTLISTENER_API_TOKEN is not set"):
        courtlistener.search_dockets(fetcher, "redistricting", checked_at=CHECKED)
    with pytest.raises(CredentialMissing, match="OPENSTATES_API_KEY is not set"):
        openstates.search_bills(fetcher, "tx", "elections", checked_at=CHECKED)
    assert session.calls == []


def test_a_blank_token_counts_as_missing(monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "   ")
    with pytest.raises(CredentialMissing):
        courtlistener.token()


def test_courtlistener_record_is_labelled_secondary_and_infers_nothing():
    case = courtlistener.normalise_result(cl_item(), checked_at=CHECKED)
    assert case.id == "cl-101"
    assert case.verification.status == VerificationStatus.IMPORTED_SECONDARY
    assert case.verification.method == "automated_secondary_import"
    assert "not a complete record" in case.verification.note
    assert case.sourceUrl == "https://www.courtlistener.com/docket/101/synthetic/"
    assert case.sourceLastActivity == "2026-04-10"  # latest filing the archive knows about
    assert case.dateFirstEntry == "2026-02-01"
    # "dateTerminated" is metadata, not a ruling: no disposition, place or topic is derived from it.
    assert case.latestDispositiveEntry is None
    assert case.stateFips == [] and case.issueTags == []
    assert case.externalIds == {"courtlistenerDocketId": "101", "pacerCaseId": "555"}


def test_courtlistener_docket_without_a_number_is_left_out_not_given_one():
    assert courtlistener.normalise_result(cl_item(docketNumber=""), checked_at=CHECKED) is None
    assert courtlistener.normalise_result(cl_item(docketNumber=None), checked_at=CHECKED) is None


def test_courtlistener_dates_are_normalised_or_dropped_never_guessed():
    case = courtlistener.normalise_result(cl_item(dateFiled="2026-02-01T05:00:00-08:00", recap_documents=[{"entry_date_filed": "garbage"}]), checked_at=CHECKED)
    assert case.dateDocketed == "2026-02-01" and case.sourceLastActivity is None


def test_courtlistener_docket_without_documents_has_no_activity_date():
    case = courtlistener.normalise_result(cl_item(recap_documents=[]), checked_at=CHECKED)
    assert case.sourceLastActivity is None and case.documentCount == 0


def test_courtlistener_search_follows_pages_removes_duplicates_and_sends_the_token_only_there(fetcher, session, monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "synthetic-token")
    page2 = "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc"
    session.on(courtlistener.SEARCH_URL, FakeResponse(200, {"results": [cl_item(101), cl_item(102), {"no_docket": True}], "next": page2}))
    session.on(page2, FakeResponse(200, {"results": [cl_item(102), cl_item(103)], "next": None}))
    cases = courtlistener.search_dockets(fetcher, "redistricting", checked_at=CHECKED)
    assert [c.id for c in cases] == ["cl-101", "cl-102", "cl-103"]
    assert [c["headers"]["Authorization"] for c in session.calls] == ["Token synthetic-token"] * 2
    assert all(c["url"].startswith("https://www.courtlistener.com/") for c in session.calls)
    assert session.calls[0]["params"] == {"q": "redistricting", "type": "r", "order_by": "dateFiled desc"}
    assert session.calls[1]["params"] is None


def test_courtlistener_run_merges_queries_and_sorts(fetcher, session, monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "synthetic-token")
    session.on(courtlistener.SEARCH_URL, FakeResponse(200, {"results": [cl_item(202), cl_item(201)], "next": None}))
    cases = courtlistener.run(fetcher, ["a", "b"], checked_at=CHECKED)
    assert [c.id for c in cases] == ["cl-201", "cl-202"]


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


@pytest.mark.parametrize("next_page", ["https://elsewhere.example.test/collect", "http://www.courtlistener.com/api/rest/v4/search/?cursor=abc",
                                       "https://www.courtlistener.com.example.test/api/rest/v4/search/"])
def test_courtlistener_never_sends_the_token_to_a_next_page_outside_the_api(fetcher, session, monkeypatch, next_page):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", "synthetic-token")
    session.on(courtlistener.SEARCH_URL, FakeResponse(200, {"results": [cl_item(101)], "next": next_page}))
    session.on(next_page, FakeResponse(200, {"results": [cl_item(102)], "next": None}))
    with pytest.raises(FetchError, match="outside the CourtListener API"):
        courtlistener.search_dockets(fetcher, "redistricting", checked_at=CHECKED)
    assert session.urls() == [courtlistener.SEARCH_URL]
