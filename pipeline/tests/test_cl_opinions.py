"""Decisions of federal district courts and of state courts from CourtListener: the list of candidates and its
limit of requests, the rules for courts and documents, the selection, the published record, the scan and the stage.

Every case, party and passage here is invented. States and the names of real kinds of court are kept, because the
adapter reads the state from a court's name.
"""

import json

import pytest

from dhq.adapters import cl_opinions, uscourts
from dhq.http import FetchError
from dhq.schemas import LegalCase
from dhq.util import write_json

import synthetic_federal as fed
from conftest import FakeResponse, tree
from test_run import T1, T2, T3, env  # noqa: F401 - env is a fixture

SEARCH = cl_opinions.SEARCH_URL
STORE = cl_opinions.STORAGE_ROOT
TOKEN = "synthetic-secret-token-123"
NOW = "2026-06-01T10:00:00Z"
#: Every month the list has on the day of ``NOW``: January 2025 to June 2026.
MONTHS = cl_opinions.months(cl_opinions.SINCE, NOW[:10])
STAGES = ["courtlistener", "scotus", "relationships", "events"]


def opinion(doc_id, path, kind="combined-opinion", sha1=None, court_url=""):
    return {"id": doc_id, "type": kind, "sha1": sha1 or f"{doc_id:040x}", "local_path": path, "download_url": court_url}


def item(cluster, docket, date, *, court_id="la", court="Supreme Court of Louisiana", jurisdiction="S", citation="La.",
         name="Synthetic Voters v. Synthetic Parish", number="2026-C-00001", status="Published", opinions=None):
    """One result of CourtListener's search for decisions, with the fields the adapter reads. Invented content."""
    if opinions is None:
        opinions = [opinion(cluster * 10, f"pdf/{date[:4]}/{date[5:7]}/{date[8:]}/synthetic_{cluster}.pdf")]
    return {"cluster_id": cluster, "docket_id": docket, "dateFiled": date, "court_id": court_id, "court": court,
            "court_citation_string": citation, "court_jurisdiction": jurisdiction, "caseName": name, "docketNumber": number,
            "status": status, "absolute_url": f"/opinion/{cluster}/synthetic/", "opinions": opinions}


class Search:
    """What CourtListener's search "returns" in a test, by the month a decision was filed in, ``size`` results a page."""

    def __init__(self, session, items=(), size=20):
        self.session, self.items, self.size = session, list(items), size
        #: The months asked for, in order, and every request with what it sent.
        self.asked = []
        self.requests = []
        #: What the search "returns" for dockets of the RECAP Archive (test_cl_dockets.py), and how often it was asked.
        self.dockets = []
        self.docket_requests = []
        session.on(SEARCH, self.first)

    def first(self, url, headers, params):
        if params.get("type") == "d":
            self.docket_requests.append({"headers": headers, "params": params})
            return FakeResponse(200, {"count": len(self.dockets), "results": list(self.dockets), "next": None})
        self.requests.append({"headers": headers, "params": params})
        month = params["filed_after"][:7]
        self.asked.append(month)
        return self.page(month, 0)

    def page(self, month, start):
        found = [i for i in self.items if i["dateFiled"][:7] == month]
        following = None
        if start + self.size < len(found):
            following = f"{SEARCH}?cursor={month}-{start + self.size}"
            self.session.on(following, lambda url, headers, params, m=month, s=start + self.size: self.following(m, s, headers, params))
        return FakeResponse(200, {"count": len(found), "results": found[start : start + self.size], "next": following})

    def following(self, month, start, headers, params):
        self.requests.append({"headers": headers, "params": params})
        return self.page(month, start)


def serve_files(session, files):
    for path, text in files.items():
        session.on(STORE + path, FakeResponse(200, text))


def state_of(listing):
    """The part of a published scan state the list of candidates is read back from."""
    return {"ruleId": cl_opinions.SELECTION_RULE_ID, "since": cl_opinions.SINCE, "query": cl_opinions.SEARCH_QUERY, "listing": listing.document()}


@pytest.fixture
def signed(monkeypatch):
    monkeypatch.setenv("COURTLISTENER_API_TOKEN", TOKEN)
    monkeypatch.setattr(cl_opinions, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    monkeypatch.setattr(cl_opinions.opening, "pdf_layout", fed.layout_of)


# --- months ----------------------------------------------------------------------------------

def test_the_months_run_from_the_starting_day_to_today():
    assert cl_opinions.months("2025-11-15", "2026-02-03") == ["2025-11", "2025-12", "2026-01", "2026-02"]
    assert cl_opinions.months("2026-02-01", "2026-02-28") == ["2026-02"]
    assert (MONTHS[0], MONTHS[-1], len(MONTHS)) == ("2025-01", "2026-06", 18)
    assert cl_opinions.month_days("2028-02") == ("2028-02-01", "2028-02-29")
    # The first month is never asked for from before the starting day.
    assert cl_opinions.month_days("2025-01", since="2025-01-20") == ("2025-01-20", "2025-01-31")


# --- courts ----------------------------------------------------------------------------------

@pytest.mark.parametrize("name, fips", [
    ("Supreme Court of Louisiana", "22"),
    ("West Virginia Supreme Court", "54"),            # not Virginia
    ("Court of Appeals of Virginia", "51"),
    ("Court of Appeals of Arkansas", "05"),           # not Kansas
    ("Court of Appeals of Kansas", "20"),
    ("District Court, N.D. Texas", "48"),
    ("District Court, District of Columbia", "11"),
    ("District Court, D. Puerto Rico", "72"),
    ("District Court, Virgin Islands", "78"),
    ("Supreme Court of the Virgin Islands", "78"),
    ("District Court, Northern Mariana Islands", "69"),
    ("Supreme Court of the United States", None),     # no state in the name
    ("Synthetic Court of Texas and Oklahoma", None),  # two states
    ("Indianapolis Synthetic Court", None),           # a state's name only as part of a word
])
def test_a_court_is_placed_by_the_one_state_its_name_holds(name, fips):
    assert cl_opinions.court_state(name) == fips


def test_a_district_court_is_shown_under_its_full_name_and_any_other_court_under_courtlisteners():
    assert cl_opinions.court_name("District Court, N.D. Texas", "FD") == "United States District Court for the Northern District of Texas"
    assert cl_opinions.court_name("District Court, D. Maryland", "FD") == "United States District Court for the District of Maryland"
    assert cl_opinions.court_name("District Court, District of Columbia", "FD") == "United States District Court for the District of Columbia"
    assert cl_opinions.court_name("District Court, Virgin Islands", "FD") == "District Court, Virgin Islands"
    assert cl_opinions.court_name("Supreme Court of Louisiana", "S") == "Supreme Court of Louisiana"
    # A state court that happens to be called a district court is not renamed.
    assert cl_opinions.court_name("District Court, N.D. Texas", "ST") == "District Court, N.D. Texas"


# --- one search result -------------------------------------------------------------------------

def test_a_search_result_is_kept_with_the_fields_that_are_used():
    entry = cl_opinions.compact(item(7, 70, "2026-03-02T00:00:00-08:00", opinions=[opinion(72, "pdf/b.pdf", "dissent"), opinion(71, "pdf/a.pdf"),
                                                                              {"type": "combined-opinion"}]))
    assert entry == {
        "cluster": 7, "docket": 70, "date": "2026-03-02", "court": "la", "courtName": "Supreme Court of Louisiana", "citation": "La.",
        "jurisdiction": "S", "name": "Synthetic Voters v. Synthetic Parish", "docketNumber": "2026-C-00001", "status": "Published",
        "url": "/opinion/7/synthetic/",
        # In the order of CourtListener's numbers; a document without a number is left out.
        "documents": [{"id": 71, "kind": "combined-opinion", "sha1": f"{71:040x}", "path": "pdf/a.pdf", "courtUrl": ""},
                      {"id": 72, "kind": "dissent", "sha1": f"{72:040x}", "path": "pdf/b.pdf", "courtUrl": ""}]}
    assert cl_opinions.unpack_entry(cl_opinions.pack_entry(entry)) == entry
    for broken in ({"cluster_id": None}, {"docket_id": "70"}, {"dateFiled": "March 2"}, {"court_id": ""}):
        assert cl_opinions.compact({**item(7, 70, "2026-03-02"), **broken}) is None


@pytest.mark.parametrize("change, why", [
    ({}, None),
    ({"court_jurisdiction": "F"}, "otherCourt"),          # a court of appeals: read from GovInfo, not from here
    ({"court_jurisdiction": "FB"}, "otherCourt"),         # a bankruptcy court
    ({"caseName": "  "}, "noCaseName"),
    ({"caseName": "Unknown Case Name"}, "noCaseName"),
    ({"docketNumber": ""}, "noDocketNumber"),
    ({"court": "Synthetic Tribal Court"}, "noState"),
    ({"opinions": []}, "noDocument"),
])
def test_a_candidate_that_cannot_be_shown_soundly_is_not_read_and_the_reason_is_named(change, why):
    assert cl_opinions.usable(cl_opinions.compact({**item(7, 70, "2026-03-02"), **change})) == why


# --- one month of the list ---------------------------------------------------------------------

def test_a_month_is_asked_for_by_its_days_and_every_page_is_followed_on_the_search_only(fetcher, session, signed):
    search = Search(session, [item(n, 100 + n, f"2026-03-{n:02d}") for n in range(1, 6)], size=2)
    # A result that is listed twice is taken once; one the search returns for a month it was not filed in is left
    # to the list of its own month.
    search.items += [item(1, 101, "2026-03-01"), {**item(9, 109, "2026-03-09"), "dateFiled": "2026-04-01"}]
    budget = cl_opinions.Budget(10)
    found = cl_opinions.list_month(fetcher, "2026-03", budget)
    assert [entry["cluster"] for entry in found] == [1, 2, 3, 4, 5]
    assert budget.used == 3 and len(search.requests) == 3
    assert search.requests[0]["params"] == {"type": "o", "q": cl_opinions.SEARCH_QUERY, "filed_after": "2026-03-01",
                                            "filed_before": "2026-03-31", "order_by": "dateFiled desc"}
    # The following pages are asked for at the address the search named, with nothing added.
    assert [request["params"] for request in search.requests[1:]] == [None, None]
    assert all(request["headers"]["Authorization"] == f"Token {TOKEN}" for request in search.requests)
    assert all(url.startswith(SEARCH) for url in session.urls())


def test_a_month_is_only_taken_whole_and_one_that_cannot_be_finished_costs_one_request(fetcher, session, signed):
    search = Search(session, [item(n, 100 + n, f"2026-03-{n:02d}") for n in range(1, 6)], size=2)
    # The first page says there are five decisions, three pages: with two requests the month is not read on.
    budget = cl_opinions.Budget(2)
    assert cl_opinions.list_month(fetcher, "2026-03", budget) is None
    assert budget.used == 1 and len(session.urls()) == 1
    # A search that gives no count is read until the requests run out, and the month is still not taken in part.
    session.on(SEARCH, lambda url, headers, params: FakeResponse(200, {k: v for k, v in json.loads(search.first(url, headers, params).body).items() if k != "count"}))
    budget = cl_opinions.Budget(2)
    assert cl_opinions.list_month(fetcher, "2026-03", budget) is None
    assert budget.used == 2
    # Three requests are enough.
    session.on(SEARCH, search.first)
    assert len(cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(3))) == 5


@pytest.mark.parametrize("next_page", ["https://elsewhere.example.test/collect", "http://www.courtlistener.com/api/rest/v4/search/?cursor=abc",
                                       "https://www.courtlistener.com.example.test/api/rest/v4/search/", 7])
def test_the_token_is_never_sent_to_a_next_page_outside_the_search(fetcher, session, signed, next_page):
    session.on(SEARCH, FakeResponse(200, {"results": [item(1, 101, "2026-03-01")], "next": next_page}))
    with pytest.raises(FetchError, match="outside CourtListener's search"):
        cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))
    assert session.urls() == [SEARCH]


def test_a_refusal_for_the_limit_of_requests_is_not_asked_again(fetcher, session, sleeps, signed):
    session.on(SEARCH, FakeResponse(429, {"detail": "Request was throttled."}, {"Retry-After": "1636"}))
    with pytest.raises(cl_opinions.RateLimited) as limit:
        cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))
    assert limit.value.retry_after == 1636 and "1636 seconds" in str(limit.value)
    assert session.urls() == [SEARCH] and sleeps == []


def test_a_page_that_fails_is_asked_for_again_twice_and_an_answer_that_is_no_list_is_refused(fetcher, session, sleeps, signed):
    session.on(SEARCH, FakeResponse(503), FakeResponse(503), FakeResponse(200, {"results": [item(1, 101, "2026-03-01")], "next": None}))
    assert [entry["cluster"] for entry in cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))] == [1]
    assert sleeps == [5.0, 10.0]
    session.on(SEARCH, FakeResponse(503))
    with pytest.raises(FetchError):
        cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))
    for body in ({"detail": "synthetic"}, {"results": "none"}, ["a list"], "<html>Service unavailable</html>"):
        session.on(SEARCH, FakeResponse(200, body))
        with pytest.raises(cl_opinions.ListingError):
            cl_opinions.list_month(fetcher, "2026-03", cl_opinions.Budget(10))


# --- the list, month by month ----------------------------------------------------------------------

def test_a_run_reads_the_newest_months_first_then_the_months_never_read_then_those_read_longest_ago(fetcher, session, signed):
    search = Search(session, [item(1, 101, "2026-06-01"), item(2, 102, "2026-03-05"), item(3, 103, "2025-01-02")])
    first = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=5)
    assert search.asked == first.read == ["2026-06", "2026-05", "2026-04", "2026-03", "2026-02"]
    assert first.requests == 5 and sorted(first.entries) == [1, 2] and first.limited is None
    assert first.months["2026-03"] == {"listedAt": T1, "candidates": 1, "skipped": {}}
    # The next day: the two newest months again, then on through the months never read.
    search.asked.clear()
    second = cl_opinions.refresh_listing(fetcher, state_of(first), now=T2, requests=4)
    assert search.asked == ["2026-06", "2026-05", "2026-01", "2025-12"]
    assert second.months["2026-06"]["listedAt"] == T2 and second.months["2026-04"]["listedAt"] == T1
    # Once every month is held, the requests left go to the months read longest ago, the earlier month first.
    whole = cl_opinions.refresh_listing(fetcher, state_of(second), now=T2, requests=13)
    assert sorted(whole.months) == MONTHS and sorted(whole.entries) == [1, 2, 3] and whole.requests == 13
    search.asked.clear()
    third = cl_opinions.refresh_listing(fetcher, state_of(whole), now=T3, requests=5)
    assert search.asked == ["2026-06", "2026-05", "2026-02", "2026-03", "2026-04"]
    assert third.read == search.asked and sorted(third.months) == MONTHS


def test_a_month_read_again_replaces_what_the_list_held_for_it(fetcher, session, signed):
    search = Search(session, [item(1, 101, "2026-06-01"), item(2, 102, "2026-06-02"), item(3, 103, "2026-05-05")])
    first = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=2)
    assert sorted(first.entries) == [1, 2, 3]
    # CourtListener no longer returns one decision, gives another a new file, and moves the third to the month before.
    search.items = [item(2, 102, "2026-06-02", opinions=[opinion(20, "pdf/2026/06/02/synthetic_2.pdf", sha1="f" * 40)]), item(3, 103, "2026-04-28")]
    second = cl_opinions.refresh_listing(fetcher, state_of(first), now=T2, requests=3)
    assert sorted(second.entries) == [2, 3]
    assert second.entries[2]["documents"][0]["sha1"] == "f" * 40 and second.entries[3]["date"] == "2026-04-28"
    assert [second.months[month]["candidates"] for month in ("2026-06", "2026-05", "2026-04")] == [1, 0, 1]


def test_a_month_that_returns_far_less_than_before_is_doubted_and_its_list_is_kept(fetcher, session, signed):
    search = Search(session, [item(n, 100 + n, f"2026-06-{n:02d}") for n in range(1, 13)])
    first = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=1)
    assert first.months["2026-06"]["candidates"] == 12
    search.items = search.items[:5]
    doubted = cl_opinions.refresh_listing(fetcher, state_of(first), now=T2, requests=1)
    assert doubted.doubted == ["2026-06"] and doubted.read == []
    assert len(doubted.entries) == 12 and doubted.months["2026-06"] == {"listedAt": T1, "candidates": 12, "skipped": {}}
    # Half of what the month held before is believed.
    search.items = [item(n, 100 + n, f"2026-06-{n:02d}") for n in range(1, 7)]
    believed = cl_opinions.refresh_listing(fetcher, state_of(first), now=T2, requests=1)
    assert believed.doubted == [] and len(believed.entries) == 6 and believed.months["2026-06"]["listedAt"] == T2


def test_candidates_that_are_not_read_are_counted_by_reason_and_never_listed(fetcher, session, signed):
    Search(session, [item(1, 101, "2026-06-01"), item(2, 102, "2026-06-02", jurisdiction="F", court_id="ca5", court="Court of Appeals for the Fifth Circuit"),
                     item(3, 103, "2026-06-03", jurisdiction="FB", court_id="lawb", court="United States Bankruptcy Court, W.D. Louisiana"),
                     item(4, 104, "2026-06-04", number=""), item(5, 105, "2026-06-05", jurisdiction="")])
    listing = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=1)
    assert sorted(listing.entries) == [1]
    assert listing.months["2026-06"] == {"listedAt": T1, "candidates": 5, "skipped": {"noDocketNumber": 1, "otherCourt:?": 1, "otherCourt:F": 1, "otherCourt:FB": 1}}


def test_the_limit_of_requests_ends_the_reading_and_keeps_what_was_read(fetcher, session, sleeps, signed):
    search = Search(session, [item(1, 101, "2026-06-01"), item(2, 102, "2026-05-02")])
    ok = search.first
    session.on(SEARCH, lambda url, headers, params: ok(url, headers, params) if len(search.asked) < 2
               else FakeResponse(429, {"detail": "Request was throttled."}, {"Retry-After": "600"}))
    listing = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=40)
    assert listing.read == ["2026-06", "2026-05"] and sorted(listing.entries) == [1, 2]
    assert listing.limited.retry_after == 600 and listing.requests == 3 and sleeps == []


def test_a_month_that_does_not_fit_into_the_requests_left_is_left_for_the_next_run(fetcher, session, signed):
    Search(session, [item(1, 101, "2026-06-01"), *(item(10 + n, 110 + n, f"2026-05-{n:02d}") for n in range(1, 6))], size=2)
    listing = cl_opinions.refresh_listing(fetcher, None, now=T1, requests=3)
    assert listing.read == ["2026-06"] and "2026-05" not in listing.months and sorted(listing.entries) == [1]
    # May needs three pages and two requests are left: its first page is read, and no more.
    assert listing.requests == 2


def test_a_list_made_by_another_rule_or_query_or_in_other_fields_is_not_used(fetcher, session, signed):
    Search(session, [item(1, 101, "2026-06-01")])
    state = state_of(cl_opinions.refresh_listing(fetcher, None, now=T1, requests=1))
    assert cl_opinions.listing_of(state)[0].keys() == {"2026-06"}
    for change in ({"ruleId": "court-select-0"}, {"since": "2024-01-01"}, {"query": "ballot"},
                   {"listing": {**state["listing"], "entryFields": ["cluster"]}}, {"listing": {**state["listing"], "documentFields": ["id"]}}):
        assert cl_opinions.listing_of({**state, **change}) == ({}, {})
    assert cl_opinions.listing_of(None) == ({}, {})


# --- documents -------------------------------------------------------------------------------

def test_a_document_is_named_by_the_kind_courtlistener_gives_it():
    assert cl_opinions.document_kind("combined-opinion") == ("cl-doc-opinion", "Opinion")
    assert cl_opinions.document_kind("lead-opinion") == ("cl-doc-opinion", "Lead opinion")
    assert cl_opinions.document_kind("dissent") == ("cl-doc-separate", "Dissenting opinion")
    assert cl_opinions.document_kind("concurring-in-part-and-dissenting-in-part") == ("cl-doc-separate", "Opinion concurring in part and dissenting in part")
    # A kind the rule does not know is not guessed at.
    assert cl_opinions.document_kind("synthetic-kind") == ("cl-doc-opinion", "Document")
    assert cl_opinions.document_kind("") == ("cl-doc-opinion", "Document")


def test_only_a_plain_relative_path_becomes_an_address_of_the_file():
    assert cl_opinions.file_url("pdf/2026/03/02/synthetic voters v. parish (1).pdf") == STORE + "pdf/2026/03/02/synthetic%20voters%20v.%20parish%20%281%29.pdf"
    for path in ("", "/etc/passwd", "../secret.pdf", "pdf/../../secret.pdf", "https://elsewhere.example.test/a.pdf", "pdf//a.pdf", "pdf/a.pdf?x=1", "pdf/a.pdf#x"):
        assert cl_opinions.file_url(path) is None


def test_a_decision_published_as_a_web_page_is_read_without_its_tags():
    page = (b"<html><head><title>Synthetic</title><style>p { color: red }</style></head><body><script>var x = 1;</script>"
            b"<p>The Board of&nbsp;Elections   rejected the ballots.</p><p>We <b>affirm</b>.<br>So ordered.</p></body></html>")
    assert cl_opinions.html_text(page) == "The Board of Elections rejected the ballots.\nWe affirm .\nSo ordered."
    assert cl_opinions.html_text(b"<html><body>  </body></html>") is None


def test_a_file_is_read_once_and_again_only_when_courtlistener_replaces_it(fetcher, session, tmp_path, signed):
    doc = cl_opinions.compact(item(7, 70, "2026-03-02"))["documents"][0]
    session.on(STORE + doc["path"], FakeResponse(200, "The first text."))
    reader = cl_opinions.Reader(fetcher, tmp_path)
    assert reader.text(doc) == reader.text(doc) == "The first text."
    assert len(session.urls()) == 1
    session.on(STORE + doc["path"], FakeResponse(200, "The second text."))
    assert reader.text({**doc, "sha1": "a" * 40}) == "The second text."
    # A path that is no plain relative one is never asked for.
    assert reader.text({**doc, "path": "https://elsewhere.example.test/a.pdf"}) is None
    assert len(session.urls()) == 2 and all(url.startswith(STORE) for url in session.urls())


# --- the selection rule ----------------------------------------------------------------------------

def entries_of(*items):
    return [cl_opinions.compact(i) for i in items]


def test_a_decision_about_an_election_is_selected_and_one_that_mentions_an_election_is_not():
    entries = entries_of(item(7, 70, "2026-03-02"))
    selected = cl_opinions.evaluate(entries, {70: fed.election_opinion()})
    assert (selected["outcome"], selected["tests"], selected["document"], selected["party"]) == ("selected", ["long"], 70, None)
    assert selected["counts"][70]["wordMatches"] == 16 and (selected["documents"], selected["unreadable"]) == (1, 0)
    mention = cl_opinions.evaluate(entries, {70: fed.election_opinion(sentences=1, filler=60)})
    assert (mention["outcome"], mention["tests"], mention["document"]) == ("", [], None)
    assert cl_opinions.evaluate(entries, {70: fed.other_opinion()})["outcome"] == ""


def test_a_title_that_names_a_body_that_runs_elections_needs_fewer_election_words():
    text = fed.election_opinion(sentences=1, filler=60)
    assert cl_opinions.evaluate(entries_of(item(7, 70, "2026-03-02", name="Synthetic Voter v. Synthetic Parish")), {70: text})["outcome"] == ""
    registrar = entries_of(item(7, 70, "2026-03-02", name="Synthetic Voter v. Synthetic Registrar of Voters"))
    found = cl_opinions.evaluate(registrar, {70: text})
    assert (found["outcome"], found["tests"], found["party"]) == ("selected", ["party"], "Synthetic Voter v. Synthetic Registrar of Voters")


def test_the_selection_rests_on_the_document_with_the_most_election_words_and_counts_what_could_not_be_read():
    entries = entries_of(item(7, 70, "2026-03-02", opinions=[opinion(71, "pdf/a.pdf"), opinion(72, "pdf/b.pdf", "dissent"), opinion(73, "pdf/c.pdf")]),
                         item(8, 70, "2026-04-02", opinions=[opinion(81, "pdf/d.pdf")]))
    found = cl_opinions.evaluate(entries, {71: fed.election_opinion(), 72: fed.election_opinion(sentences=6), 73: None, 81: fed.other_opinion()})
    assert (found["outcome"], found["document"], found["documents"], found["unreadable"]) == ("selected", 72, 4, 1)
    # No document could be read: nothing is selected, and nothing is claimed.
    unread = cl_opinions.evaluate(entries, {71: None, 72: None, 73: None, 81: None})
    assert (unread["outcome"], unread["unreadable"], unread["counts"]) == ("", 4, {})


def test_the_opening_is_quoted_from_a_decision_of_the_court_and_never_from_a_dissent():
    entries = entries_of(item(7, 70, "2026-03-02", opinions=[opinion(71, "pdf/a.pdf"), opinion(72, "pdf/b.pdf", "dissent"), opinion(73, "pdf/c.pdf")]),
                         item(8, 70, "2026-04-02", opinions=[opinion(81, "pdf/d.pdf")]))
    texts = {71: fed.election_opinion(), 72: fed.election_opinion(sentences=6), 73: None, 81: fed.other_opinion()}
    result = cl_opinions.CaseResult(docket=70, entries=entries, texts=texts, evaluation=cl_opinions.evaluate(entries, texts))
    # The selection rests on the dissent; its opening is not the court's: the court's decision with most election words is.
    assert result.evaluation["document"] == 72 and cl_opinions.court_document(result) == 71
    only_dissent = {71: None, 72: fed.election_opinion(sentences=6), 73: None, 81: None}
    alone = cl_opinions.CaseResult(docket=70, entries=entries, texts=only_dissent, evaluation=cl_opinions.evaluate(entries, only_dissent))
    assert alone.evaluation["document"] == 72 and cl_opinions.court_document(alone) is None


# --- the published record --------------------------------------------------------------------------

def test_a_selected_case_is_published_as_what_courtlistener_holds_and_no_more():
    entries = entries_of(
        item(8, 70, "2026-04-02", status="Unpublished", opinions=[opinion(81, "pdf/2026/04/02/synthetic_8.pdf", "dissent")]),
        item(7, 70, "2026-03-02", opinions=[opinion(71, "pdf/2026/03/02/synthetic_7.pdf", court_url="https://courts.example.test/opinions/7.pdf"),
                                           opinion(72, "", "concurrence")]))
    texts = {71: fed.election_opinion(sentences=5), 72: None, 81: fed.other_opinion()}
    case = cl_opinions.build_case(entries, texts, cl_opinions.evaluate(entries, texts), checked_at=NOW)
    assert LegalCase(**case.model_dump()) == case
    assert (case.id, case.sourceId, case.jurisdiction, case.courtId) == ("cl-70", "courtlistener-api", "State", "la")
    assert case.externalIds == {"courtlistenerDocketId": "70", "courtlistenerClusterIds": "7,8"}
    assert case.court.model_dump() == {"name": "Supreme Court of Louisiana", "courtType": "state_supreme", "stateFips": "22", "citation": "La.",
                                       "ruleId": "court-state-1"}
    # The state of the court is not a link of the case to that state.
    assert case.stateFips == [] and case.parties == [] and (case.petitionerTitle, case.respondentTitle) == ("", "")
    assert (case.dateDocketed, case.dateFirstEntry, case.sourceLastActivity) == (None, "2026-03-02", "2026-04-02")
    assert case.sourceUrl == "https://www.courtlistener.com/opinion/8/synthetic/"
    assert case.verification.status.value == "imported_secondary" and "not from the court itself" in case.verification.note

    # The documents in the order of their dates; CourtListener gives no docket text, so a line names the kind and no more.
    assert [(event.date, event.description, event.classificationRule) for event in case.events] == [
        ("2026-03-02", "Opinion, published", "cl-doc-opinion"), ("2026-03-02", "Concurring opinion, published", "cl-doc-separate"),
        ("2026-04-02", "Dissenting opinion, unpublished", "cl-doc-separate")]
    assert all(event.eventType == "opinion" and event.evidence.sourceId == "courtlistener-api" for event in case.events)
    # The latest opinion of the court, not the dissent filed after it.
    assert case.latestDispositiveEntry.model_dump() == {"date": "2026-03-02", "text": "Opinion, published", "eventType": "opinion", "ruleId": "cl-doc-opinion"}
    assert case.publication == "Published"
    first, second, third = case.documents
    assert (first.id, first.title, first.url, first.availability) == ("cl-70-d1", "Opinion of 2026-03-02", STORE + "pdf/2026/03/02/synthetic_7.pdf", "public_link")
    assert "not checked here: https://courts.example.test/opinions/7.pdf" in first.accessNote
    # A document CourtListener holds no file for links to its page for the decision.
    assert second.url == "https://www.courtlistener.com/opinion/7/synthetic/" and "gives no file for this document" in second.accessNote
    assert third.documentType == "Dissenting opinion"

    selection = case.selection
    assert (selection.ruleId, selection.tests, selection.documentId, selection.documentUrl) == ("court-select-1", ["long"], "cl-70-d1", first.url)
    assert (selection.wordMatches, selection.phraseMatches) == (20, 20) and selection.phrases[0].count == 5
    # The issue is read from the text of the decision the selection rests on, by the rules every case is labelled by.
    assert [(tag.tag, tag.matchedField) for tag in case.issueTags] == [("mail-voting", "full text of the opinion")]
    assert case.matchedTerms == selection.phrases[: cl_opinions.MATCHED_TERMS]


def test_decisions_one_court_files_under_two_dockets_with_one_number_are_one_case():
    first = item(7, 75, "2026-03-02", number="31510, 31547")
    again = item(8, 71, "2026-03-02", number="31510,31547 ", opinions=[opinion(81, "pdf/2026/03/02/synthetic_8_1.pdf")])
    other_court = item(9, 72, "2026-03-02", number="31510, 31547", court_id="sd", court="South Dakota Supreme Court")
    modified = item(10, 73, "2026-04-02", number="31510, 31547M")
    grouped = cl_opinions.group_dockets(entries_of(first, again, other_court, modified))
    assert sorted(grouped) == [71, 72, 73] and sorted(entry["docket"] for entry in grouped[71]) == [71, 75]
    texts = {70: fed.election_opinion(), 81: fed.election_opinion(sentences=6)}
    case = cl_opinions.build_case(grouped[71], texts, cl_opinions.evaluate(grouped[71], texts), checked_at=NOW)
    assert case.id == "cl-71" and case.externalIds["courtlistenerDocketId"] == "71,75" and case.documentCount == 2
    # A docket without a number is a case of its own.
    unnumbered = cl_opinions.group_dockets(entries_of(item(7, 75, "2026-03-02", number=""), item(8, 71, "2026-03-02", number="")))
    assert sorted(unnumbered) == [71, 75]


def test_a_federal_district_court_is_federal_and_keeps_the_time_it_was_first_seen():
    entries = entries_of(item(7, 70, "2026-03-02", court_id="txnd", court="District Court, N.D. Texas", jurisdiction="FD", citation="N.D. Tex.",
                              number="3:25-cv-00001", status="Unknown Status"))
    texts = {70: fed.election_opinion()}
    case = cl_opinions.build_case(entries, texts, cl_opinions.evaluate(entries, texts), checked_at=T2, first_observed=T1)
    assert (case.jurisdiction, case.court.courtType, case.court.stateFips) == ("Federal", "federal_district", "48")
    assert case.court.name == "United States District Court for the Northern District of Texas"
    assert (case.firstObservedAt, case.lastCheckedAt) == (T1, T2)
    # A status CourtListener does not give as published or unpublished is not shown as either.
    assert case.events[0].description == "Opinion" and case.publication is None
    again = cl_opinions.build_case(entries, texts, cl_opinions.evaluate(entries, texts), checked_at=T3, first_observed=T1)
    assert again.contentHash == case.contentHash  # the time of the check is not part of what changed


# --- the scan ----------------------------------------------------------------------------------------

LEAGUE = item(1, 101, "2026-06-01", name="Synthetic Voters League v. Synthetic Parish")
SUPPLIER = item(2, 102, "2026-06-02", name="Synthetic Supplier v. Synthetic Buyer", number="2026-C-00002")
DISTRICT = item(3, 103, "2026-05-05", court_id="txnd", court="District Court, N.D. Texas", jurisdiction="FD", citation="N.D. Tex.",
                name="Synthetic Voter v. Synthetic County", number="3:25-cv-00001")
DISSENT = item(4, 103, "2026-05-20", court_id="txnd", court="District Court, N.D. Texas", jurisdiction="FD", citation="N.D. Tex.",
               name="Synthetic Voter v. Synthetic County", number="3:25-cv-00001", opinions=[opinion(40, "html/2026/05/20/synthetic_4.html", "dissent")])
FILES = {
    "pdf/2026/06/01/synthetic_1.pdf": fed.opinion_with_opening(fed.election_opinion()),
    "pdf/2026/06/02/synthetic_2.pdf": fed.other_opinion(),
    "pdf/2026/05/05/synthetic_3.pdf": fed.election_opinion(sentences=6),
    "html/2026/05/20/synthetic_4.html": "<html><body><p>I would hold that the voters lack standing.</p></body></html>",
}


@pytest.fixture
def listed(fetcher, session, signed):
    search = Search(session, [LEAGUE, SUPPLIER, DISTRICT, DISSENT])
    serve_files(session, FILES)
    return search


def scan_of(fetcher, cache, previous=None, now=T1, requests=2):
    listing = cl_opinions.refresh_listing(fetcher, previous, now=now, requests=requests)
    return cl_opinions.scan(fetcher, cache, previous, listing, now=now)


def test_the_scan_reads_every_candidate_and_keeps_what_the_rule_found(fetcher, session, tmp_path, listed):
    result = scan_of(fetcher, tmp_path)
    assert sorted(result.selected) == [101, 103] and result.failed == {} and result.kept == [] and result.unlisted == []
    assert (result.listed, result.read, result.full) == (4, 3, True)
    state = result.state
    assert state["fields"] == ["court", "fingerprint", "documents", "unreadableDocuments", "outcome"]
    assert {docket: row[0:1] + row[2:] for docket, row in state["cases"].items()} == {
        "101": ["la", 1, 0, 1], "102": ["la", 1, 0, 0], "103": ["txnd", 2, 0, 1]}
    assert state["courts"] == {
        "la": {"name": "Supreme Court of Louisiana", "courtType": "state_supreme", "stateFips": "22"},
        "txnd": {"name": "United States District Court for the Northern District of Texas", "courtType": "federal_district", "stateFips": "48"}}
    assert (state["candidates"], state["skipped"], state["scannedAt"]) == (4, {}, T1)
    assert cl_opinions.coverage(state) == {
        "la": {**state["courts"]["la"], "cases": 2, "documents": 2, "unreadableDocuments": 0, "selected": 1},
        "txnd": {**state["courts"]["txnd"], "cases": 1, "documents": 2, "unreadableDocuments": 0, "selected": 1}}
    # The list of candidates is part of the state, so the next run starts from it.
    assert sorted(cl_opinions.listing_of(state)[1]) == [1, 2, 3, 4]
    # The decisions of one case are read together; the dissent published as a web page is one of its documents.
    case = result.selected[103]
    assert [entry["cluster"] for entry in case.entries] == [3, 4] and case.texts[40] == "I would hold that the voters lack standing."
    assert case.evaluation["document"] == 30


def test_a_case_that_was_not_selected_is_read_again_only_when_its_decisions_change(fetcher, session, tmp_path, listed):
    first = scan_of(fetcher, tmp_path / "one")
    session.calls.clear()
    second = scan_of(fetcher, tmp_path / "two", first.state, now=T2)
    # A selected case is read on every run; the contract case is not asked for again.
    assert sorted(url for url in session.urls() if url.startswith(STORE)) == sorted(
        STORE + path for path in FILES if path != "pdf/2026/06/02/synthetic_2.pdf")
    assert (second.read, second.full) == (2, False) and second.state["cases"] == first.state["cases"]
    # CourtListener replaces the file of the contract case with one about an election.
    listed.items[1] = item(2, 102, "2026-06-02", name="Synthetic Supplier v. Synthetic Buyer", number="2026-C-00002",
                           opinions=[opinion(20, "pdf/2026/06/02/synthetic_2.pdf", sha1="f" * 40)])
    session.on(STORE + "pdf/2026/06/02/synthetic_2.pdf", FakeResponse(200, fed.election_opinion()))
    third = scan_of(fetcher, tmp_path / "three", second.state, now=T3)
    assert sorted(third.selected) == [101, 102, 103] and third.state["cases"]["102"][4] == cl_opinions.SELECTED


def test_a_selected_case_that_cannot_be_read_keeps_its_place_and_one_no_longer_listed_is_named(fetcher, session, tmp_path, listed):
    first = scan_of(fetcher, tmp_path / "one")
    session.on(STORE + "pdf/2026/06/01/synthetic_1.pdf", FakeResponse(404))
    listed.items = [LEAGUE, SUPPLIER]  # the district court's case is no longer returned for May
    second = scan_of(fetcher, tmp_path / "two", first.state, now=T2)
    assert second.selected == {} and second.kept == [101] and second.unlisted == [103]
    assert list(second.failed) == [101] and "FetchError" in second.failed[101]
    assert second.state["cases"] == {"101": first.state["cases"]["101"], "102": first.state["cases"]["102"]}


def test_a_scan_in_which_too_many_cases_cannot_be_read_is_not_published(fetcher, session, tmp_path, signed):
    Search(session, [item(n, 100 + n, f"2026-06-{n % 28 + 1:02d}", number=f"2026-C-{n:05d}") for n in range(1, 28)], size=50)
    with pytest.raises(RuntimeError, match="27 of 27 cases could not be read"):
        scan_of(fetcher, tmp_path)


# --- the stage -----------------------------------------------------------------------------------------

@pytest.fixture
def decisions(env, session, signed):  # noqa: F811
    env.search = Search(session, [LEAGUE, SUPPLIER, DISTRICT, DISSENT])
    serve_files(session, FILES)
    return env


def test_the_stage_publishes_the_selected_cases_with_the_list_they_were_selected_from(decisions):
    code, ctx = decisions.run(STAGES)
    assert code == 0
    index = decisions.read("decisions/index.json")
    assert [case["id"] for case in index["cases"]] == ["cl-101", "cl-103"]  # latest decision first
    selection = index["selection"]
    assert (selection["ruleId"], selection["since"], selection["textRuleId"]) == ("court-select-1", cl_opinions.SINCE, uscourts.SELECTION_RULE_ID)
    assert selection["searchTerms"] == list(cl_opinions.SEARCH_TERMS) and selection["courtTypes"] == cl_opinions.COURT_TYPES
    assert (selection["candidates"], selection["skipped"], selection["totalCasesRead"], selection["totalDocumentsRead"]) == (4, {}, 3, 4)
    assert (selection["months"], selection["monthsListed"], selection["oldestListingAt"]) == (18, 18, T1)
    assert index["coverage"]["txnd"] == {"name": "United States District Court for the Northern District of Texas", "courtType": "federal_district",
                                         "stateFips": "48", "cases": 1, "documents": 2, "unreadableDocuments": 0, "selected": 1}
    assert decisions.search.asked == MONTHS[::-1][:2] + MONTHS[::-1][2:]  # the newest first, each month asked for once

    case = decisions.read("decisions/cases/cl-101.json")
    summary = index["cases"][0]
    assert {key: value for key, value in case.items() if key in summary} == summary and "events" not in summary
    assert (case["verification"]["status"], case["sourceId"], case["stateFips"]) == ("imported_secondary", "courtlistener-api", [])
    assert case["court"] == {"name": "Supreme Court of Louisiana", "courtType": "state_supreme", "stateFips": "22", "citation": "La.", "ruleId": "court-state-1"}
    # The opening passage of the decision, quoted from CourtListener's copy of the file.
    assert case["about"]["text"] == fed.OPENING and case["about"]["source"] == "opinion"
    assert case["about"]["url"] == STORE + "pdf/2026/06/01/synthetic_1.pdf"
    district = decisions.read("decisions/cases/cl-103.json")
    assert [event["description"] for event in district["events"]] == ["Opinion, published", "Dissenting opinion, published"]
    # A web page cannot be laid out, and the opinion without a marked opening gets no passage: nothing is made up.
    assert district["about"] is None

    scan = decisions.read("decisions/scan.json")
    assert sorted(scan["listing"]["months"]) == MONTHS and len(scan["listing"]["entries"]) == 4
    assert sorted(scan["cases"]) == ["101", "102", "103"]
    source = decisions.source("courtlistener-api")
    assert (source["processingStatus"], source["recordCount"], source["statusDetail"]) == ("ok", 2, None)
    assert decisions.read("manifest.json")["counts"]["districtAndStateCourtCases"] == 2
    rules = {rule["ruleId"] for rule in decisions.read("classification.json")["otherRules"]}
    assert {"court-select-1", "court-state-1", "cl-doc-opinion", "cl-doc-separate"} <= rules
    # No case of these courts is put on a place's timeline in this release, and none is linked to a place.
    assert not any(event["entityId"].startswith("cl-") for event in decisions.read("events.json")["events"])
    assert not any("cl-" in json.dumps(link) for link in decisions.read("relationships.json")["relationships"])


def test_the_token_is_used_for_the_search_only_and_never_written_anywhere(decisions, session, tmp_path, caplog):
    write_json(decisions.public / "litigation_secondary.json", {"cases": []})  # what the stage published before it read decisions
    with caplog.at_level("DEBUG"):
        code, ctx = decisions.run(STAGES)
    assert code == 0
    for call in session.calls:
        sent = "Authorization" in call["headers"]
        assert sent == call["url"].startswith(SEARCH), call["url"]
    written = b"".join(tree(tmp_path).values()).decode("utf-8", errors="replace") + caplog.text
    assert TOKEN not in written
    # The file of the stage's earlier form is taken out of the published data.
    assert not (decisions.public / "litigation_secondary.json").exists()
    # The decisions are kept apart from the cases read from the courts' own records.
    assert "cl-101" not in json.dumps(decisions.read("litigation/index.json"))


def test_a_second_run_changes_nothing_but_the_times_of_the_check(decisions):
    decisions.run(STAGES, now=T1)
    before = decisions.read("decisions/cases/cl-101.json")
    code, ctx = decisions.run(STAGES, now=T2)
    assert code == 0 and [item for item in ctx.review if item["entity"].startswith("cl-")] == []
    after = decisions.read("decisions/cases/cl-101.json")
    assert (after["firstObservedAt"], after["lastCheckedAt"], after["contentHash"]) == (T1, T2, before["contentHash"])
    assert {**after, "lastCheckedAt": None, "verification": None} == {**before, "lastCheckedAt": None, "verification": None}


def test_a_run_asks_the_search_no_more_often_than_it_may_and_says_which_months_are_still_unread(decisions, monkeypatch):
    monkeypatch.setenv("DHQ_CL_REQUESTS", "3")
    code, ctx = decisions.run(STAGES, now=T1)
    assert code == 0 and decisions.search.asked == ["2026-06", "2026-05", "2026-04"]
    selection = decisions.read("decisions/index.json")["selection"]
    assert (selection["months"], selection["monthsListed"]) == (18, 3)
    detail = decisions.source("courtlistener-api")["statusDetail"]
    assert "15 of 18 months of CourtListener's list have not been read yet (2025-01 to 2026-03)" in detail
    # The next run goes on where this one stopped.
    decisions.search.asked.clear()
    decisions.run(STAGES, now=T2)
    assert decisions.search.asked == ["2026-06", "2026-05", "2026-03"]
    assert decisions.read("decisions/index.json")["selection"]["monthsListed"] == 4


def test_a_run_that_is_refused_for_the_limit_keeps_the_list_it_holds_and_says_so(decisions, session):
    decisions.run(STAGES, now=T1)
    session.on(SEARCH, FakeResponse(429, {"detail": "Request was throttled."}, {"Retry-After": "1636"}))
    code, ctx = decisions.run(STAGES, now=T2)
    assert code == 0
    assert [case["id"] for case in decisions.read("decisions/index.json")["cases"]] == ["cl-101", "cl-103"]
    source = decisions.source("courtlistener-api")
    assert source["processingStatus"] == "ok" and "no month of the list was read again in this run" in source["statusDetail"]
    assert "1636 seconds" in source["statusDetail"]
    assert decisions.read("decisions/index.json")["selection"]["oldestListingAt"] == T1


def test_a_first_run_that_is_refused_for_the_limit_publishes_nothing(decisions, session):
    session.on(SEARCH, FakeResponse(429, {"detail": "Request was throttled."}, {"Retry-After": "1636"}))
    code, ctx = decisions.run(STAGES)
    assert code == 1 and not (decisions.public / "decisions").exists()
    source = decisions.source("courtlistener-api")
    assert source["processingStatus"] == "failed" and "no month of CourtListener's list of decisions could be read" in source["statusDetail"]


def test_a_foreign_next_page_fails_the_stage_and_gets_no_token(decisions, session):
    session.on(SEARCH, FakeResponse(200, {"results": [LEAGUE], "next": "https://elsewhere.example.test/collect"}))
    code, _ = decisions.run(STAGES)
    assert code == 1
    source = decisions.source("courtlistener-api")
    assert source["processingStatus"] == "failed" and "outside CourtListener's search" in source["statusDetail"]
    assert not (decisions.public / "decisions").exists()
    assert not any("elsewhere.example.test" in url for url in session.urls())


def test_a_first_run_in_which_nothing_is_selected_publishes_no_empty_set(decisions):
    decisions.search.items = [SUPPLIER]
    code, ctx = decisions.run(STAGES)
    assert code == 1 and not (decisions.public / "decisions").exists()
    assert "refusing to publish an empty set" in decisions.source("courtlistener-api")["statusDetail"]


def test_a_month_that_returns_far_less_than_before_is_flagged_and_its_cases_stay(decisions):
    extra = [item(100 + n, 200 + n, f"2026-06-{n:02d}", name="Synthetic Supplier v. Synthetic Buyer", number=f"2026-C-{n:05d}",
                  opinions=[opinion(20, "pdf/2026/06/02/synthetic_2.pdf")]) for n in range(3, 13)]
    decisions.search.items += extra
    decisions.run(STAGES, now=T1)
    decisions.search.items = [DISTRICT, DISSENT]  # June returns nothing at all
    code, ctx = decisions.run(STAGES, now=T2)
    assert code == 0
    assert [(flag["kind"], flag["entity"]) for flag in ctx.review if flag["kind"] == "listing_shrank"] == [("listing_shrank", "courtlistener-api:2026-06")]
    assert [case["id"] for case in decisions.read("decisions/index.json")["cases"]] == ["cl-101", "cl-103"]


def test_a_case_that_leaves_the_list_leaves_the_published_set_and_a_maintainer_is_told(decisions, session):
    more = [item(50 + n, 500 + n, f"2026-04-{n:02d}", name=f"Synthetic Voter {n} v. Synthetic Parish", number=f"2026-C-1{n:04d}",
                 opinions=[opinion(500 + n, "pdf/2026/04/synthetic_more.pdf")]) for n in range(1, 11)]
    decisions.search.items += more
    session.on(STORE + "pdf/2026/04/synthetic_more.pdf", FakeResponse(200, fed.election_opinion()))
    decisions.run(STAGES, now=T1)
    assert len(decisions.read("decisions/index.json")["cases"]) == 12
    # One of twelve is no longer returned for its month: within what may leave at once.
    decisions.search.items.remove(more[0])
    code, ctx = decisions.run(STAGES, now=T2)
    assert code == 0 and not (decisions.public / "decisions/cases/cl-501.json").exists()
    left = [flag for flag in ctx.review if flag["kind"] == "case_left_selection"]
    assert [flag["entity"] for flag in left] == ["cl-501"]
    assert "CourtListener's search no longer returns it" in left[0]["detail"] and "no longer published" in left[0]["detail"]
    # Three more at once is more than a tenth of the published cases: the set stays as it was until someone has looked.
    for gone in more[1:4]:
        decisions.search.items.remove(gone)
    code, ctx = decisions.run(STAGES, now=T3)
    assert code == 1 and len(decisions.read("decisions/index.json")["cases"]) == 11
    assert "would leave the published set at once" in decisions.source("courtlistener-api")["statusDetail"]


def test_a_newly_selected_case_is_flagged_once_for_a_maintainer_to_read(decisions, session):
    decisions.run(STAGES, now=T1)
    decisions.search.items.append(item(9, 109, "2026-06-09", name="Synthetic Candidate v. Synthetic Registrar of Voters", number="2026-C-00009"))
    session.on(STORE + "pdf/2026/06/09/synthetic_9.pdf", FakeResponse(200, fed.election_opinion(sentences=1, filler=60)))
    code, ctx = decisions.run(STAGES, now=T2)
    assert code == 0
    flags = [(flag["kind"], flag["entity"]) for flag in ctx.review if flag["entity"].startswith("cl-")]
    assert flags == [("new_selection", "cl-109")]
    assert decisions.read("decisions/cases/cl-109.json")["selection"]["tests"] == ["party"]
    code, ctx = decisions.run(STAGES, now=T3)
    assert [flag for flag in ctx.review if flag["entity"].startswith("cl-")] == []


def test_the_search_is_asked_within_the_tokens_limits():
    # The token allows twenty requests a minute and a thousand an hour; a run keeps under both, with room for a
    # second run in the same hour, and still has the requests to read every month of the list.
    assert 60 / cl_opinions.SEARCH_INTERVAL <= 15
    assert 2 * cl_opinions.REQUESTS_PER_RUN <= 1000
    every = cl_opinions.months(cl_opinions.SINCE, "2026-12-31")
    assert cl_opinions.REQUESTS_PER_RUN >= 10 * len(every)
