"""Dockets of voting cases in the federal district courts from the RECAP Archive on CourtListener: the list of
dockets, their entries, the published record, the limit of requests and the stage.

Every case, party and entry here is invented. The names of real district courts are kept, because the adapter reads
the state from a court's name.
"""

import json

import pytest

from dhq.adapters import cl_dockets, cl_opinions
from dhq.adapters.cl_opinions import Budget
from dhq.http import FetchError
from dhq.schemas import LegalCase

from conftest import FakeResponse, tree
from test_cl_opinions import DISTRICT, FILES, LEAGUE, SEARCH, STAGES, STORE, SUPPLIER, TOKEN, Search, serve_files, signed  # noqa: F401 - signed is a fixture
from test_run import T1, T2, env  # noqa: F401 - env is a fixture

ENTRIES = cl_dockets.ENTRIES_URL


def docket(docket_id, filed="2026-03-02", *, court_id="gand", court="District Court, N.D. Georgia", citation="N.D. Ga.",
           name="Synthetic Voters v. Synthetic Registrar", number="1:26-cv-00001", nature="441 Civil Rights: Voting", stamp="2026-03-05T10:00:00Z"):
    """One result of CourtListener's search for dockets, with the fields the adapter reads. Invented content."""
    return {"docket_id": docket_id, "dateFiled": filed, "dateTerminated": None, "court_id": court_id, "court": court,
            "court_citation_string": citation, "caseName": name, "docketNumber": number, "suitNature": nature, "cause": "52:10101 Voting Rights Act",
            "docket_absolute_url": f"/docket/{docket_id}/synthetic/", "meta": {"timestamp": stamp},
            # Held by the archive and never read: parties and lawyers are not published.
            "party": ["Synthetic Voter"], "attorney": ["Synthetic Lawyer"]}


def filing(number, description="", *, attachment=None, path=None):
    return {"document_number": str(number), "attachment_number": attachment, "description": description, "is_available": bool(path),
            "filepath_local": path, "absolute_url": f"/docket/1/{number}/synthetic/"}


def entry(number, day, description, documents=None):
    return {"entry_number": number, "date_filed": day, "description": description,
            "recap_documents": [filing(number)] if documents is None else documents}


ENTRY_LIST = [
    entry(1, "2026-03-02", "COMPLAINT against Synthetic Registrar, filed by Synthetic Voters.  (Attachments: # 1 Exhibit A)",
          [filing(1, "Complaint", path="recap/gov.uscourts.gand.1/gov.uscourts.gand.1.1.0.pdf"),
           filing(1, "Exhibit A", attachment=1, path="recap/gov.uscourts.gand.1/gov.uscourts.gand.1.1.1.pdf"),
           filing(1, "Exhibit B", attachment=2)]),
    entry(2, "2026-03-04", "", [filing(2, "Summons Issued")]),
    entry(None, "2026-03-09", "Minute Entry for proceedings held before the court.", []),
    entry(3, None, "An entry the archive gives no date", []),
]


class Dockets:
    """What CourtListener "returns" for the entries of a docket, ``size`` entries a page."""

    def __init__(self, session, by_docket, size=20):
        self.session, self.by_docket, self.size = session, by_docket, size
        self.asked = []
        session.on(ENTRIES, self.first)

    def first(self, url, headers, params):
        self.asked.append(int(params["docket"]))
        assert params["omit"] == cl_dockets.OMIT and "Token " in headers["Authorization"]
        return self.page(int(params["docket"]), 0)

    def page(self, docket_id, start):
        found = self.by_docket.get(docket_id)
        if isinstance(found, FakeResponse):
            return found
        following = None
        if start + self.size < len(found):
            following = f"{ENTRIES}?docket={docket_id}&page={start // self.size + 2}"
            self.session.on(following, lambda url, headers, params, d=docket_id, s=start + self.size: self.page(d, s))
        return FakeResponse(200, {"next": following, "previous": None, "results": found[start : start + self.size]})


# --- the list of dockets -------------------------------------------------------------------------------

def test_a_docket_is_kept_with_the_fields_that_are_used_and_never_with_its_parties():
    kept = cl_dockets.compact(docket(7))
    assert kept == {"docket": 7, "court": "gand", "courtName": "District Court, N.D. Georgia", "citation": "N.D. Ga.",
                    "name": "Synthetic Voters v. Synthetic Registrar", "docketNumber": "1:26-cv-00001", "filed": "2026-03-02", "terminated": None,
                    "nature": "Civil Rights: Voting", "cause": "52:10101 Voting Rights Act", "url": "/docket/7/synthetic/", "stamp": "2026-03-05T10:00:00Z"}


@pytest.mark.parametrize("change", [
    {"suitNature": "3441 Civil Rights Voting"},  # the code of an appeal, which the search also returns
    {"suitNature": "440 Civil Rights: Other"},
    {"suitNature": ""},
    {"court": "Court of Appeals for the Eighth Circuit", "court_id": "ca8"},
    {"court": "District Court, Synthetic Territory"},  # a court that cannot be placed in a state
    {"dateFiled": "2023-12-31"},
    {"dateFiled": None},
    {"docket_id": "7"},
    {"caseName": " "},
    {"docketNumber": ""},
])
def test_a_docket_the_rule_does_not_take_is_left_out(change):
    assert cl_dockets.compact({**docket(7), **change}) is None


def test_the_nature_of_suit_is_taken_when_the_clerk_gave_the_code_alone():
    assert cl_dockets.compact({**docket(7), "suitNature": "441"})["nature"] == ""
    assert cl_dockets.compact({**docket(7), "docket_absolute_url": "https://elsewhere.example/x"})["url"] == ""


def test_the_list_is_asked_for_by_the_clerks_code_and_followed_on_the_search_only(fetcher, session, signed):
    second = SEARCH + "?cursor=2"
    session.on(SEARCH, FakeResponse(200, {"count": 3, "results": [docket(2), docket(1, court="Court of Appeals for the Eleventh Circuit")], "next": second}))
    session.on(second, FakeResponse(200, {"count": 3, "results": [docket(3), docket(2)], "next": None}))
    budget = Budget(5)
    assert [found["docket"] for found in cl_dockets.list_dockets(fetcher, budget)] == [2, 3] and budget.used == 2
    first = session.calls[0]
    assert first["params"] == {"type": "d", "q": 'suitNature:"441"', "filed_after": cl_dockets.SINCE, "order_by": "dateFiled desc"}
    assert all(call["headers"]["Authorization"] == f"Token {TOKEN}" for call in session.calls)

    session.on(SEARCH, FakeResponse(200, {"count": 1, "results": [docket(2)], "next": "https://elsewhere.example/api/search/?cursor=2"}))
    with pytest.raises(FetchError, match="outside CourtListener's search"):
        cl_dockets.list_dockets(fetcher, Budget(5))
    assert not any("elsewhere.example" in url for url in session.urls())
    # A list that does not fit into the requests of the run is not taken in part.
    session.on(SEARCH, FakeResponse(200, {"count": 3, "results": [docket(2)], "next": second}))
    assert cl_dockets.list_dockets(fetcher, Budget(1)) is None


def test_the_entries_of_a_docket_are_only_taken_whole(fetcher, session, signed):
    served = Dockets(session, {5: [entry(n, "2026-03-02", f"Entry {n}") for n in range(1, 6)]}, size=2)
    budget = Budget(3)
    assert [item["entry_number"] for item in cl_dockets.read_entries(fetcher, 5, budget)] == [1, 2, 3, 4, 5] and budget.used == 3
    assert cl_dockets.read_entries(fetcher, 5, Budget(2)) is None
    assert served.asked == [5, 5]
    session.on(ENTRIES, FakeResponse(200, {"results": [], "next": "https://elsewhere.example/api/docket-entries/?page=2"}))
    with pytest.raises(FetchError, match="outside CourtListener's docket entries"):
        cl_dockets.read_entries(fetcher, 5, Budget(3))


# --- the record ----------------------------------------------------------------------------------------

def test_a_docket_is_published_as_what_the_archive_holds_and_no_more():
    case = cl_dockets.build_case(cl_dockets.compact(docket(7)), ENTRY_LIST, checked_at=T2, first_observed=T1)
    assert isinstance(case, LegalCase) and case.id == "cl-7" and case.externalIds == {"courtlistenerDocketId": "7"}
    assert (case.docketType, case.jurisdiction, case.courtId, case.natureOfSuit) == ("recap", "Federal", "gand", "441 Civil Rights: Voting")
    assert case.court.model_dump() == {"name": "United States District Court for the Northern District of Georgia", "courtType": "federal_district",
                                       "stateFips": "13", "citation": "N.D. Ga.", "ruleId": "court-state-1"}
    assert (case.dateDocketed, case.dateFirstEntry, case.sourceLastActivity) == ("2026-03-02", "2026-03-02", "2026-03-09")
    # Every dated entry in the clerk's words, with its number; an entry without text names its documents.
    assert [event.description for event in case.events] == [
        "1. COMPLAINT against Synthetic Registrar, filed by Synthetic Voters. (Attachments: # 1 Exhibit A)",
        "2. Summons Issued",
        "Minute Entry for proceedings held before the court.",
    ]
    assert {(event.eventType, event.significance, event.classificationRule) for event in case.events} == {("docket_entry", "routine", "recap-entry-1")}
    assert all(event.evidence.url == "https://www.courtlistener.com/docket/7/synthetic/" for event in case.events)
    # A filing is listed only where the archive holds a copy of it.
    assert [(doc.id, doc.title, doc.documentType, doc.url, doc.entryIndex) for doc in case.documents] == [
        ("cl-7-d1", "Document 1: Complaint", "Filing", STORE + "recap/gov.uscourts.gand.1/gov.uscourts.gand.1.1.0.pdf", 0),
        ("cl-7-d2", "Document 1, attachment 1: Exhibit A", "Attachment", STORE + "recap/gov.uscourts.gand.1/gov.uscourts.gand.1.1.1.pdf", 0),
    ]
    assert case.events[0].documentIds == ["cl-7-d1", "cl-7-d2"] and case.events[1].documentIds == []
    assert (case.entryCount, case.documentCount) == (3, 2)
    # The clerk's code selects the case; nothing is counted, no ruling is named and no state is said to be concerned.
    assert case.selection.model_dump(exclude_none=True) == {"ruleId": "docket-select-1", "tests": ["record"], "natureOfSuitCode": "441",
                                                            "natureOfSuit": "Civil Rights: Voting", "phrases": []}
    assert case.latestDispositiveEntry is None and case.stateFips == [] and case.about is None and case.parties == []
    assert (case.verification.status.value, case.firstObservedAt, case.lastCheckedAt, case.sourcePublishedAt) == ("imported_secondary", T1, T2, "2026-03-05T10:00:00Z")
    assert "4 document record(s)" in case.verification.note and "a copy of 2 of them" in case.verification.note
    assert "Synthetic Lawyer" not in case.model_dump_json()


def test_a_docket_without_entries_is_still_a_case_and_a_file_outside_the_archive_is_not_linked():
    empty = cl_dockets.build_case(cl_dockets.compact(docket(8)), [], checked_at=T1)
    assert (empty.entryCount, empty.dateFirstEntry, empty.sourceLastActivity) == (0, "2026-03-02", "2026-03-02")
    odd = [entry(1, "2026-03-02", "", [filing(1, path="../secret.pdf")]), entry(2, "2026-03-03", "x" * 5000 + " end", [])]
    case = cl_dockets.build_case(cl_dockets.compact(docket(8)), odd, checked_at=T1)
    assert case.documents == [] and case.events[0].description == "1. The archive holds no text for this entry."
    assert len(case.events[1].description) <= cl_dockets.MAX_ENTRY_TEXT + 6 and case.events[1].description.endswith(" …")


def test_a_record_changes_its_hash_only_when_the_docket_does():
    one = cl_dockets.build_case(cl_dockets.compact(docket(7)), ENTRY_LIST, checked_at=T1)
    again = cl_dockets.build_case(cl_dockets.compact(docket(7)), ENTRY_LIST, checked_at=T2, first_observed=T1)
    more = cl_dockets.build_case(cl_dockets.compact(docket(7)), [*ENTRY_LIST, entry(4, "2026-03-10", "ORDER")], checked_at=T2)
    assert one.contentHash == again.contentHash != more.contentHash


# --- a run ---------------------------------------------------------------------------------------------

def test_a_run_reads_the_dockets_never_read_first_and_leaves_an_unchanged_one_alone(fetcher, session, signed):
    search = Search(session)
    search.dockets = [docket(1, "2026-01-05"), docket(2, "2026-02-05"), docket(3, "2026-03-05"), docket(4, "2026-04-05", stamp="2026-04-09T10:00:00Z")]
    served = Dockets(session, {n: [entry(1, "2026-01-05", "COMPLAINT")] for n in (1, 2, 3, 4)})
    first = cl_dockets.refresh(fetcher, {}, now=T1, requests=3)
    # One request for the list, then the newest dockets as far as the requests go; the others wait.
    assert served.asked == [4, 3] and sorted(first.built) == ["cl-3", "cl-4"] and first.waiting == [2, 1] and first.requests == 3
    assert "used up" in first.limited

    published = {cid: case.model_dump(mode="json") for cid, case in first.built.items()}
    search.dockets[3] = docket(4, "2026-04-05", stamp="2026-05-01T10:00:00Z")  # CourtListener has changed its record of docket 4
    served.asked.clear()
    second = cl_dockets.refresh(fetcher, published, now=T2, requests=10)
    # The dockets never read come first, then the one that changed. Docket 3 has not changed and costs no request.
    assert served.asked == [2, 1, 4] and sorted(second.built) == ["cl-1", "cl-2", "cl-4"] and second.waiting == [] and second.limited is None
    assert second.built["cl-4"].firstObservedAt == T1 and sorted(second.listed) == [1, 2, 3, 4]


def test_a_docket_that_cannot_be_read_fails_alone_and_a_list_that_shrank_is_not_believed(fetcher, session, sleeps, signed):
    search = Search(session)
    search.dockets = [docket(1), docket(2)]
    Dockets(session, {1: FakeResponse(500, "broken"), 2: [entry(1, "2026-03-02", "COMPLAINT")]})
    result = cl_dockets.refresh(fetcher, {}, now=T1, requests=20)
    assert sorted(result.built) == ["cl-2"] and list(result.failed) == [1] and result.waiting == []

    published = {f"cl-{n}": {"sourcePublishedAt": "x"} for n in range(1, 6)}
    with pytest.raises(cl_opinions.ListingError, match="less than half"):
        cl_dockets.refresh(fetcher, published, now=T2, requests=20)


def test_a_refusal_for_the_limit_ends_the_reading_and_keeps_what_was_read(fetcher, session, sleeps, signed):
    search = Search(session)
    search.dockets = [docket(1, "2026-01-05"), docket(2, "2026-02-05")]
    Dockets(session, {2: [entry(1, "2026-02-05", "COMPLAINT")], 1: FakeResponse(429, "slow down", headers={"Retry-After": "60"})})
    result = cl_dockets.refresh(fetcher, {}, now=T1, requests=20)
    assert sorted(result.built) == ["cl-2"] and result.waiting == [1] and "limit of requests" in result.limited and sleeps == []


def test_the_dockets_and_the_search_together_stay_within_the_tokens_limits():
    # CourtListener allows the token twenty requests a minute and a thousand an hour; both lists go out at one pace.
    assert cl_opinions.REQUESTS_PER_RUN + cl_dockets.REQUESTS_PER_RUN <= 1000 * 0.7


# --- the stage -----------------------------------------------------------------------------------------

@pytest.fixture
def dockets(env, session, signed):  # noqa: F811
    env.search = Search(session, [LEAGUE, SUPPLIER, DISTRICT])
    serve_files(session, FILES)
    # Docket 103 is the district court case that is also found by its decisions; docket 900 is known by its docket only.
    env.search.dockets = [docket(103, court_id="txnd", court="District Court, N.D. Texas", citation="N.D. Tex.", name="Synthetic Voters v. Synthetic County"),
                          docket(900)]
    env.served = Dockets(session, {103: ENTRY_LIST, 900: ENTRY_LIST[:1]})
    return env


def test_the_stage_publishes_the_dockets_beside_the_cases_found_by_their_decisions(dockets, session, tmp_path, caplog):
    with caplog.at_level("DEBUG"):
        code, ctx = dockets.run(STAGES, now=T1)
    assert code == 0
    index = dockets.read("decisions/index.json")
    assert sorted(case["id"] for case in index["cases"]) == ["cl-101", "cl-103", "cl-900"]
    assert index["dockets"] == {"ruleId": "docket-select-1", "entryRuleId": "recap-entry-1", "courtStateRuleId": "court-state-1", "since": cl_dockets.SINCE,
                                "query": 'suitNature:"441"', "natureOfSuitCode": "441", "listed": 2, "listedAt": T1, "published": 2, "waiting": 0, "readInThisRun": 2}
    # A case whose docket the archive holds is published from the docket, not from its decisions.
    both = dockets.read("decisions/cases/cl-103.json")
    assert both["docketType"] == "recap" and both["entryCount"] == 3 and both["selection"]["ruleId"] == "docket-select-1"
    assert dockets.read("decisions/cases/cl-101.json")["docketType"] is None
    # The ledger of the scan of decisions still counts it as a case selected by its decisions.
    assert index["coverage"]["txnd"]["selected"] == 1 and "gand" not in index["coverage"]
    summary = next(case for case in index["cases"] if case["id"] == "cl-900")
    assert summary["natureOfSuit"] == "441 Civil Rights: Voting" and "events" not in summary
    source = dockets.source("courtlistener-api")
    assert (source["processingStatus"], source["recordCount"], source["statusDetail"]) == ("ok", 3, None)
    rules = {rule["ruleId"] for rule in dockets.read("classification.json")["otherRules"]}
    assert {"docket-select-1", "recap-entry-1"} <= rules
    # A docket is not flagged for a maintainer to read, and none of its entries enters the timeline.
    assert not any(item["kind"] == "new_selection" and item["entity"] in ("cl-103", "cl-900") for item in ctx.review)
    assert not any(event["entityId"].startswith("cl-") for event in dockets.read("events.json")["events"])
    # The token goes to CourtListener's own interface only, and is written nowhere.
    for call in session.calls:
        assert ("Authorization" in call["headers"]) == call["url"].startswith(cl_dockets.API_ROOT), call["url"]
    assert TOKEN not in b"".join(tree(tmp_path).values()).decode("utf-8", errors="replace") + caplog.text


def test_a_second_run_reads_no_docket_again_and_changes_nothing_but_the_decisions_check(dockets):
    dockets.run(STAGES, now=T1)
    before = dockets.read("decisions/cases/cl-900.json")
    dockets.served.asked.clear()
    code, ctx = dockets.run(STAGES, now=T2)
    assert code == 0 and dockets.served.asked == []
    assert dockets.read("decisions/cases/cl-900.json") == before
    index = dockets.read("decisions/index.json")
    assert (index["dockets"]["listedAt"], index["dockets"]["published"], index["dockets"]["readInThisRun"]) == (T2, 2, 0)


def test_a_run_that_cannot_reach_every_docket_says_how_many_wait(dockets, monkeypatch):
    monkeypatch.setenv("DHQ_CL_DOCKET_REQUESTS", "2")
    code, ctx = dockets.run(STAGES, now=T1)
    assert code == 0
    index = dockets.read("decisions/index.json")
    assert (index["dockets"]["published"], index["dockets"]["waiting"]) == (1, 1)
    assert "1 of 2 dockets of the RECAP Archive have not been read yet" in dockets.source("courtlistener-api")["statusDetail"]
    monkeypatch.setenv("DHQ_CL_DOCKET_REQUESTS", "50")
    dockets.run(STAGES, now=T2)
    assert dockets.read("decisions/index.json")["dockets"]["waiting"] == 0


def test_a_list_of_dockets_that_cannot_be_read_keeps_the_dockets_published_before(dockets, monkeypatch):
    dockets.run(STAGES, now=T1)
    monkeypatch.setenv("DHQ_CL_DOCKET_REQUESTS", "0")
    code, ctx = dockets.run(STAGES, now=T2)
    assert code == 0
    index = dockets.read("decisions/index.json")
    assert sorted(case["id"] for case in index["cases"]) == ["cl-101", "cl-103", "cl-900"]
    assert (index["dockets"]["listed"], index["dockets"]["listedAt"], index["dockets"]["published"]) == (2, T1, 2)
    assert "the dockets published before are kept" in dockets.source("courtlistener-api")["statusDetail"]


def test_a_docket_that_leaves_the_list_is_no_longer_published_and_its_case_is_shown_from_its_decisions_again(dockets):
    dockets.run(STAGES, now=T1)
    dockets.search.dockets = [docket(900)]  # the clerk has given docket 103 another nature of suit
    code, ctx = dockets.run(STAGES, now=T2)
    index = dockets.read("decisions/index.json")
    assert sorted(case["id"] for case in index["cases"]) == ["cl-101", "cl-103", "cl-900"] and index["dockets"]["published"] == 1
    again = dockets.read("decisions/cases/cl-103.json")
    assert again["docketType"] is None and again["selection"]["ruleId"] == "court-select-1"
    assert not any(item["kind"] == "regression" for item in ctx.review)

    dockets.search.dockets = []
    dockets.run(STAGES, now=T2)
    # Half of the published dockets or more gone at once is not believed: the list is refused and the dockets stay.
    assert "cl-900" in json.dumps(dockets.read("decisions/index.json")["cases"])
