"""Court of appeals cases from GovInfo: the record reader, the selection rule, the labelling rules and the scan.

Every case, party and passage here is invented (see ``synthetic_federal``). Courts and districts keep their real
names, because the adapter checks them.
"""

import hashlib

import pytest

from dhq.adapters import uscourts
from dhq.http import Fetcher

import synthetic_federal as fed
from conftest import FakeResponse

PKG = "USCOURTS-ca5-25-30725"
OPINION = "PUBLISHED AUTHORED OPINION filed. Originating case number: 1:24-cv-00001."
NOW = "2026-06-01T10:00:00Z"


def record_of(package=PKG, title="Synthetic Voters League v. Synthetic County", documents=None, **kw):
    documents = documents or [fed.document(0, "2026-03-10", OPINION)]
    return uscourts.parse_record(fed.mods(package, title, documents, **kw), package)


# --- the record ---------------------------------------------------------------------------

def test_a_record_is_read_as_plain_values_with_documents_in_order():
    record = record_of(documents=[fed.document(1, "2026-04-02", "ERRATA SHEET filed."), fed.document(0, "2026-03-10", OPINION)],
                       nature=("441", "Civil Rights Voting"),
                       parties=[("Synthetic Voters League", "Plaintiff - Appellant"), ("Board of Elections", "Defendant - Appellee"),
                                ("Board of Elections", "Defendant - Appellee"), ("A Clerk", "Not Party")])
    assert (record["court"], record["caseNumber"], record["docket"]) == ("ca5", "25-30725", "25-30725")
    assert (record["natureOfSuitCode"], record["natureOfSuit"]) == ("441", "Civil Rights Voting")
    # A party listed twice is listed once, and someone the record marks as not a party is left out.
    assert record["parties"] == [{"name": "Synthetic Voters League", "role": "Plaintiff - Appellant"},
                                 {"name": "Board of Elections", "role": "Defendant - Appellee"}]
    assert [(d["sequence"], d["date"]) for d in record["documents"]] == [(0, "2026-03-10"), (1, "2026-04-02")]
    assert record["documents"][0]["url"] == f"https://www.govinfo.gov/content/pkg/{PKG}/pdf/{PKG}-0.pdf"
    assert uscourts.case_id(PKG) == "ca5-25-30725" and uscourts.case_id("USCOURTS-caDC-25-05012") == "cadc-25-05012"
    assert uscourts.case_id("USCOURTS-ca13-25-02017") == "cafc-25-02017"


def test_the_entry_text_is_cleaned_without_changing_a_word():
    mojibake = "Appellant" + chr(0xE2) + chr(0x80) + chr(0x99) + "s motion"  # an apostrophe that arrived as mis-decoded UTF-8
    # The record holds a second layer of character references and HTML tags; the builder adds the outer layer.
    entry = f"&lt;b&gt;UNPUBLISHED&lt;/b&gt; PER CURIAM OPINION filed.&lt;br&gt;{mojibake} &amp; brief; see &lt;a href='x'&gt;order&lt;/a&gt;"
    record = record_of(documents=[fed.document(0, "2026-03-10", entry)], title="Smith &amp; Jones v. Board")
    assert record["documents"][0]["text"] == "UNPUBLISHED PER CURIAM OPINION filed. Appellant’s motion & brief; see order"
    assert record["title"] == "Smith & Jones v. Board"
    # Characters that are not mis-decoded UTF-8 are left exactly as they are.
    assert uscourts.repair_encoding("Señor Peña, café") == "Señor Peña, café"


@pytest.mark.parametrize("change, message", [
    (lambda xml: xml.replace(b"<caseNumber>25-30725</caseNumber>", b"<caseNumber>25-30726</caseNumber>"), "asked for"),
    (lambda xml: xml.replace(b"<courtCode>ca5</courtCode>", b"<courtCode>ca4</courtCode>"), "asked for"),
    (lambda xml: xml.replace(f"id-{PKG}-0".encode(), b"id-USCOURTS-ca5-25-99999-0"), "does not belong"),
    (lambda xml: xml.replace(b"<dateIssued>2026-03-10</dateIssued>", b"<dateIssued>2026-02-30</dateIssued>"), "no date"),
    (lambda xml: xml.replace(b"for the Fifth Circuit", b"for the Fourth Circuit"), "not of the"),
    (lambda xml: b"<!DOCTYPE mods [<!ENTITY x 'y'>]>" + xml, "document type or entities"),
    (lambda xml: xml.replace(b"<mods ", b"<html "), "not well-formed"),
    (lambda xml: b"<html><body>Error</body></html>", "not a metadata record"),
    (lambda xml: xml[:xml.index(b"<relatedItem")] + b"</mods>", "no documents"),
    (lambda xml: xml.replace(b"<title>Synthetic Voters League v. Synthetic County</title>", b"<title> </title>"), "no case title"),
])
def test_a_record_of_another_case_or_of_no_case_is_refused(change, message):
    xml = fed.mods(PKG, "Synthetic Voters League v. Synthetic County", [fed.document(0, "2026-03-10", OPINION)])
    with pytest.raises(uscourts.RecordError, match=message):
        uscourts.parse_record(change(xml), PKG)


def test_a_document_address_is_published_only_when_the_record_gives_exactly_the_expected_one():
    xml = fed.mods(PKG, "Synthetic v. Board", [fed.document(0, "2026-03-10", OPINION)]).replace(
        f"/pdf/{PKG}-0.pdf".encode(), b"/pdf/../../evil.pdf")
    assert uscourts.parse_record(xml, PKG)["documents"][0]["url"] is None


# --- the listing ----------------------------------------------------------------------------

def test_a_sitemap_gives_each_package_with_the_time_it_last_changed():
    court = uscourts.court_of(PKG)
    listed, odd = uscourts.parse_sitemap(fed.sitemap({
        PKG: "2026-05-20T12:00:00.123Z", "USCOURTS-ca5-25-00001": "2026-01-02T03:04:05.000Z",
        "USCOURTS-ca4-25-00001": "2026-01-02T03:04:05.000Z", "USCOURTS-ca5-oddity": "2026-01-02T03:04:05.000Z"}), court)
    assert listed == {PKG: "2026-05-20T12:00:00.123Z", "USCOURTS-ca5-25-00001": "2026-01-02T03:04:05.000Z"}
    assert odd == ["USCOURTS-ca4-25-00001", "USCOURTS-ca5-oddity"]  # another court's package, and something that is not a package


@pytest.mark.parametrize("page, message", [
    ("<html><body>Service unavailable</body></html>", "not a sitemap"),
    (fed.sitemap({PKG: "2026-05-20T12:00:00.123Z"}).replace("<lastmod>2026-05-20T12:00:00.123Z</lastmod>", ""), "1 entries, but only 0"),
])
def test_a_page_that_is_not_a_complete_sitemap_stops_the_listing(page, message):
    with pytest.raises(uscourts.ListingError, match=message):
        uscourts.parse_sitemap(page, uscourts.court_of(PKG))


# --- the selection rule -----------------------------------------------------------------------

def evaluate(texts, exclusion=None, **kw):
    documents = [fed.document(i, f"2026-03-{10 + i:02d}", OPINION) for i in range(len(texts))]
    record = record_of(documents=documents, **kw)
    return uscourts.evaluate(record, {f"{PKG}-{i}": text for i, text in enumerate(texts)}, exclusion)


def test_counts_are_taken_after_line_breaks_and_broken_words_are_joined():
    counts = uscourts.count_text("The Board of\nElections counted absen-\ntee bal-\nlots of registered\n voters.")
    assert (counts["wordMatches"], counts["phraseMatches"]) == (3, 3)  # Elections, ballots, voters; Board of Elections, absentee, registered voters
    assert counts["words"] == 10 and counts["density"] == 300.0
    assert dict(counts["phrases"]) == {"board of elections": 1, "absentee": 1, "registered voters": 1}


def test_an_opinion_about_an_election_is_selected_and_one_that_mentions_an_election_is_not():
    selected = evaluate([fed.election_opinion()])
    assert (selected["outcome"], selected["tests"], selected["document"]) == ("selected", ["long"], f"{PKG}-0")
    assert selected["counts"][f"{PKG}-0"]["wordMatches"] == 16
    # One sentence about an election in a long contract opinion: enough words for no test.
    mention = evaluate([fed.election_opinion(sentences=1, filler=60)])
    assert (mention["outcome"], mention["tests"]) == ("", [])
    assert evaluate([fed.other_opinion()])["outcome"] == ""


def test_the_three_text_tests_have_the_published_thresholds():
    long_text = {"words": 10000, "wordMatches": 20, "phraseMatches": 8, "density": 2.0, "laborMatches": 0}
    assert uscourts.text_test(long_text, None) == "long"
    assert uscourts.text_test({**long_text, "density": 1.9}, None) is None
    assert uscourts.text_test({**long_text, "phraseMatches": 7}, None) is None
    dense = {"words": 1000, "wordMatches": 8, "phraseMatches": 3, "density": 8.0, "laborMatches": 0}
    assert uscourts.text_test(dense, None) == "dense"
    assert uscourts.text_test({**dense, "wordMatches": 7, "density": 7.0}, None) is None
    few = {"words": 5000, "wordMatches": 3, "phraseMatches": 0, "density": 0.6, "laborMatches": 0}
    assert uscourts.text_test(few, "Synthetic County Board of Elections") == "party" and uscourts.text_test(few, None) is None
    assert uscourts.text_test({**few, "wordMatches": 2}, "Synthetic County Board of Elections") is None
    # A union representation election is not a public election.
    assert uscourts.text_test({**long_text, "laborMatches": 10}, None) is None
    assert uscourts.text_test({**long_text, "laborMatches": 4}, None) == "long"


def test_the_courts_own_classification_as_a_voting_case_selects_a_case_whatever_its_text():
    by_record = evaluate([fed.other_opinion()], nature=("441", "Civil Rights Voting"))
    assert (by_record["outcome"], by_record["tests"], by_record["document"]) == ("selected", ["record"], f"{PKG}-0")
    both = evaluate([fed.election_opinion()], nature=("441", "Civil Rights Voting"))
    assert both["tests"] == ["record", "long"]


def test_a_case_the_record_files_under_another_field_of_law_is_not_selected_by_its_text():
    assert evaluate([fed.election_opinion()], nature=("190", "Other Contract Actions"))["outcome"] == ""
    assert evaluate([fed.election_opinion()], nature=("440", "Other Civil Rights"))["outcome"] == "selected"


def test_a_party_that_is_an_election_authority_lowers_the_number_of_words_needed():
    text = fed.election_opinion(sentences=1, filler=60)
    assert evaluate([text])["outcome"] == ""
    by_party = evaluate([text], parties=[("Synthetic County Board of Elections", "Defendant - Appellee")])
    assert (by_party["outcome"], by_party["tests"], by_party["party"]) == ("selected", ["party"], "Synthetic County Board of Elections")
    # The case title counts like a party: the record of a case against an election board often lists no parties.
    by_title = uscourts.evaluate(record_of(title="Synthetic Voter v. Board of Elections"), {f"{PKG}-0": text})
    assert (by_title["outcome"], by_title["tests"]) == ("selected", ["party"])


def test_a_labor_opinion_about_a_representation_election_is_not_selected():
    labor = ("The National Labor Relations Board ordered a representation election in the bargaining unit after the union "
             "filed unfair labor practice charges under the National Labor Relations Act. ") * 6
    assert evaluate([fed.election_opinion() + labor])["outcome"] == ""


def test_a_clerks_cover_letter_is_not_counted_and_a_document_before_the_starting_day_is_not_read():
    letter = "United States Court of Appeals. Dear Counsel: The court has issued an opinion in this case. " + fed.ELECTION_SENTENCE * 6
    result = evaluate([letter])
    assert (result["outcome"], result["coverLetters"], result["documents"], result["unreadable"]) == ("", [f"{PKG}-0"], 1, 0)
    assert uscourts.is_cover_letter(letter) and not uscourts.is_cover_letter(fed.election_opinion())
    old = record_of(documents=[fed.document(0, "2024-12-31", OPINION)])
    assert uscourts.evaluate(old, {})["documents"] == 0 and uscourts.evaluate(old, {})["outcome"] == ""
    unreadable = evaluate([None], nature=("441", "Civil Rights Voting"))
    assert (unreadable["outcome"], unreadable["unreadable"], unreadable["document"]) == ("selected", 1, None)


def test_an_exclusion_takes_effect_only_when_its_passage_is_found_in_the_opinion():
    text = fed.election_opinion("The student council of a synthetic high school held an election in the spring. ")
    found = evaluate([text], fed.exclusion(PKG, "The student council of a synthetic high school held an election"))
    assert (found["outcome"], found["exclusionProblem"]) == ("excluded", None)
    missing = evaluate([text], fed.exclusion(PKG, "The student council of another school held no election at all"))
    assert missing["outcome"] == "selected" and missing["exclusionProblem"]
    # An exclusion never adds a case: one the rule does not select stays unselected.
    assert evaluate([fed.other_opinion()], fed.exclusion(PKG, "The supplier delivered the widgets late"))["outcome"] == ""


def test_changing_a_selection_pattern_requires_a_new_rule_id():
    """The published scan state is reused only for the rule id it was made with. A changed pattern under the same id
    would leave every case that was read before unread, so the id must change with the patterns (and this hash with it)."""
    parts = [uscourts.WORD_PATTERN.pattern, uscourts.PHRASE_PATTERN.pattern, uscourts.LABOR_PATTERN.pattern, uscourts.AUTHORITY_PATTERN.pattern,
             uscourts.COVER_LETTER_PATTERN.pattern, repr(sorted(uscourts.TEXT_TESTS.items())), repr(sorted(uscourts.OTHER_FIELD_CODES)),
             repr((uscourts.LABOR_MIN_MATCHES, uscourts.LABOR_RATIO, uscourts.VOTING_NATURE_OF_SUIT, uscourts.SINCE, uscourts.COVER_LETTER_WINDOW))]
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    assert (uscourts.SELECTION_RULE_ID, digest) == ("circuit-select-1", "c44092987df9e8673abce13295f31167a9f6b4b584110954f1f892b9374f325d")


# --- labels read from the record and the opinion -------------------------------------------------

@pytest.mark.parametrize("entry, expected", [
    ("PUBLISHED AUTHORED OPINION filed.", ("ca-doc-opinion", "opinion", "Opinion", "major")),
    ("ERRATA to the opinion filed.", ("ca-doc-errata", "errata", "Errata", "routine")),
    ("NON DISPOSITIVE PUBLISHED ORDER filed.", ("ca-doc-order", "order", "Order", "major")),
    ("FILED MEMORANDUM DISPOSITION.", ("ca-doc-decision", "decision", "Decision", "major")),
    ("JUDGMENT ENTERED AND FILED.", ("ca-doc-judgment", "judgment", "Judgment", "major")),
    ("Document posted.", ("ca-doc-other", "court_document", "Document", "major")),
    ("", ("ca-doc-other", "court_document", "Document", "major")),
])
def test_what_a_document_is_called_comes_from_the_courts_entry(entry, expected):
    assert uscourts.classify_document(entry) == expected


@pytest.mark.parametrize("entry, expected", [
    ("UNPUBLISHED PER CURIAM OPINION filed.", "Unpublished"), ("NOT PRECEDENTIAL OPINION Coram: X.", "Unpublished"),
    ("Opinion issued by court. [Non-published]", "Unpublished"), ("PUBLISHED AUTHORED OPINION filed.", "Published"),
    ("PRECEDENTIAL OPINION Coram: X.", "Published"), ("OPINION filed.", None),
])
def test_publication_is_stated_only_when_the_entry_states_it(entry, expected):
    assert uscourts.publication_of(entry) == expected


def test_the_court_below_is_quoted_from_the_opinions_own_line():
    url = f"https://www.govinfo.gov/content/pkg/{PKG}/pdf/{PKG}-0.pdf"
    origin = uscourts.find_origin("No. 25-30725\nAppeal from the United States District Court\nfor the Western District of Texas\nUSDC No. 1:24-CV-1\n"
                                  + fed.election_opinion(), url)
    assert (origin.court, origin.stateFips, origin.ruleId) == ("United States District Court for the Western District of Texas", "48", "origin-court-1")
    assert origin.documentUrl == url and "Western District of Texas" in origin.quote
    columbia = uscourts.find_origin("On Appeal from the United States District Court for the District of Columbia (No. 1:24-cv-1)", url)
    assert (columbia.court, columbia.stateFips) == ("United States District Court for the District of Columbia", "11")
    # A court named in another form is not guessed at.
    assert uscourts.find_origin("On Appeal from the U.S. District Court, E.D. Pa. (No. 2:24-cv-1)", url) is None
    assert uscourts.find_origin(fed.other_opinion() * 40 + "Appeal from the United States District Court for the District of Utah", url) is None


def test_a_caption_set_in_two_columns_is_read_column_by_column():
    caption = ("SYNTHETIC VOTERS LEAGUE,              )   On Appeal from the United\n"
               "     Plaintiff-Appellant,             )   States District Court for the\n"
               "v.                                    )   Eastern District of Michigan\n"
               "BOARD OF CANVASSERS,                  )\n")
    origin = uscourts.find_origin(caption, f"https://www.govinfo.gov/content/pkg/{PKG}/pdf/{PKG}-0.pdf")
    assert (origin.court, origin.stateFips) == ("United States District Court for the Eastern District of Michigan", "26")


def test_two_cases_share_an_opinion_only_when_the_same_text_is_filed_in_both_on_the_same_day():
    text = fed.election_opinion() * 20
    key = uscourts.same_opinion_key(text)
    assert key and uscourts.same_opinion_key(text.replace(" ", "\n").upper()) == key and uscourts.same_opinion_key("A short order.") is None

    def case(case_id, court="ca5"):
        return {"id": case_id, "courtId": court, "docketNumber": case_id[4:], "caseName": f"Synthetic {case_id}",
                "documents": [{"id": f"{case_id}-d0"}, {"id": f"{case_id}-d1"}]}

    cases = [case("ca5-25-1"), case("ca5-25-2"), case("ca5-25-3"), case("ca4-25-4", court="ca4")]
    uscourts.decided_together(cases, {
        "ca5-25-1": [("ca5-25-1-d0", "2026-03-10", key), ("ca5-25-1-d1", "2026-04-01", "other")],
        "ca5-25-2": [("ca5-25-2-d1", "2026-03-10", key)],
        "ca5-25-3": [("ca5-25-3-d0", "2026-03-11", key)],   # the same text on another day
        "ca4-25-4": [("ca4-25-4-d0", "2026-03-10", key)],   # the same text in another court
    })
    assert cases[0]["decidedWith"] == [{"caseId": "ca5-25-2", "docket": "25-2", "caseName": "Synthetic ca5-25-2"}]
    assert cases[1]["decidedWith"] == [{"caseId": "ca5-25-1", "docket": "25-1", "caseName": "Synthetic ca5-25-1"}]
    assert cases[2]["decidedWith"] == [] and cases[3]["decidedWith"] == []
    assert cases[0]["documents"] == [{"id": "ca5-25-1-d0", "sameTextAs": ["ca5-25-2-d1"]}, {"id": "ca5-25-1-d1", "sameTextAs": []}]
    assert cases[1]["documents"][1] == {"id": "ca5-25-2-d1", "sameTextAs": ["ca5-25-1-d0"]}
    assert uscourts.case_of_document("ca5-25-2-d1") == "ca5-25-2"


def test_a_case_record_says_why_it_was_selected_and_links_every_document():
    documents = [fed.document(0, "2026-03-10", OPINION), fed.document(1, "2026-04-02", "ERRATA SHEET filed.")]
    record = record_of(documents=documents, nature=("441", "Civil Rights Voting"), parties=[("Board of Elections", "Defendant - Appellee")])
    texts = {f"{PKG}-0": "Appeal from the United States District Court for the Middle District of Louisiana\n" + fed.election_opinion(),
             f"{PKG}-1": "Page 3, line 2: replace a word."}
    case = uscourts.build_case(record, texts, uscourts.evaluate(record, texts), checked_at=NOW, changed_at="2026-05-20T12:00:00.123Z")
    assert (case.id, case.courtId, case.docketNumber, case.sourceId) == ("ca5-25-30725", "ca5", "25-30725", "govinfo-uscourts")
    assert case.sourceUrl == f"https://www.govinfo.gov/app/details/{PKG}" and case.sourcePublishedAt == "2026-05-20T12:00:00Z"
    assert (case.dateFirstEntry, case.sourceLastActivity, case.entryCount, case.documentCount) == ("2026-03-10", "2026-04-02", 2, 2)
    assert [(e.eventType, e.significance, e.documentIds) for e in case.events] == [
        ("opinion", "major", ["ca5-25-30725-d0"]), ("errata", "routine", ["ca5-25-30725-d1"])]
    # The latest ruling is the opinion, not the errata sheet that follows it.
    assert (case.latestDispositiveEntry.eventType, case.latestDispositiveEntry.date, case.publication) == ("opinion", "2026-03-10", "Published")
    assert (case.origin.stateFips, case.stateFips) == ("22", [])  # where the case began is recorded; no state is claimed for the case
    selection = case.selection
    assert (selection.ruleId, selection.tests, selection.natureOfSuitCode, selection.documentId) == (
        "circuit-select-1", ["record", "long"], "441", "ca5-25-30725-d0")
    assert (selection.wordMatches, selection.phraseMatches) == (16, 16) and selection.phrases[0].count == 4
    assert case.parties[0].name == "Board of Elections" and case.verification.status.value == "verified_primary"
    assert all(doc.url.startswith(f"https://www.govinfo.gov/content/pkg/{PKG}/pdf/") for doc in case.documents)


# --- the scan ---------------------------------------------------------------------------------

@pytest.fixture
def courts(session, monkeypatch):
    monkeypatch.setattr(uscourts, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    listed = fed.Courts(session)
    listed.add(PKG, "Synthetic Voters League v. Board of Elections", [fed.election_opinion()])
    listed.add("USCOURTS-ca5-25-00002", "Synthetic Supplier v. Synthetic Buyer", [fed.other_opinion()])
    listed.add("USCOURTS-ca11-25-00003", "Synthetic Pupil v. Synthetic School", [fed.election_opinion("The student council held its election. ")])
    listed.add("USCOURTS-ca11-25-00006", "Synthetic Lender v. Synthetic Borrower", [fed.other_opinion()])
    listed.serve()
    return listed


SCHOOL = "USCOURTS-ca11-25-00003"  # selected by the rule's counts unless a test lists it as an exclusion


def scan(session, tmp_path, previous=None, exclusions=None, now=NOW):
    fetcher = Fetcher(session=session, retries=1, backoff=0, sleep=lambda s: None)
    return uscourts.scan(fetcher, tmp_path / "cache", previous, exclusions or {}, now=now, workers=2)


def test_the_first_scan_reads_every_listed_case_and_records_what_the_rule_found(courts, session, tmp_path):
    result = scan(session, tmp_path, exclusions={SCHOOL: fed.exclusion(SCHOOL, "The student council held its election.")})
    assert (result.full, result.listed, result.read, result.failed) == (True, 4, 4, {})
    assert list(result.selected) == [PKG] and list(result.excluded) == [SCHOOL]
    assert result.state["packages"]["ca5"] == {"25-30725": ["2026-05-20T12:00:00.123Z", 1, 0, 0, 1], "25-00002": ["2026-05-20T12:00:00.123Z", 1, 0, 0, 0]}
    assert result.state["packages"]["ca11"] == {"25-00003": ["2026-05-20T12:00:00.123Z", 1, 0, 0, 2], "25-00006": ["2026-05-20T12:00:00.123Z", 1, 0, 0, 0]}
    assert (result.state["ruleId"], result.state["since"], result.state["fields"]) == ("circuit-select-1", "2025-01-01", uscourts.STATE_FIELDS)
    coverage = uscourts.coverage(result.state)
    assert coverage["ca5"] == {"cases": 2, "documents": 2, "coverLetters": 0, "unreadableDocuments": 0, "selected": 1, "excluded": 0}
    assert coverage["cafc"]["cases"] == 0 and coverage["ca11"]["excluded"] == 1


def test_a_later_scan_reads_only_what_is_new_changed_or_in_the_dataset(courts, session, tmp_path):
    first = scan(session, tmp_path)
    courts.add("USCOURTS-ca5-25-00004", "Another Synthetic Supplier v. Buyer", [fed.other_opinion()])
    courts.add("USCOURTS-ca5-25-00002", "Synthetic Supplier v. Synthetic Buyer", [fed.other_opinion(), fed.election_opinion()],
               changed="2026-05-30T09:00:00.000Z")  # a second document arrived: an election opinion
    courts.serve()
    before = len(fed.packages_read(session))
    second = scan(session, tmp_path, previous=first.state, now="2026-06-02T10:00:00Z")
    assert not second.full and (second.listed, second.read) == (5, 4)
    # The unchanged, unselected case in the Eleventh Circuit is not read again; the two selected cases are, from GovInfo itself.
    assert sorted(fed.packages_read(session)[before:]) == [SCHOOL, "USCOURTS-ca5-25-00002", "USCOURTS-ca5-25-00004", PKG]
    assert sorted(second.selected) == [SCHOOL, "USCOURTS-ca5-25-00002", PKG]
    assert second.state["packages"]["ca11"] == first.state["packages"]["ca11"]


def test_a_scan_state_of_another_rule_is_not_reused(courts, session, tmp_path):
    first = scan(session, tmp_path)
    second = scan(session, tmp_path, previous={**first.state, "ruleId": "circuit-select-0"})
    assert second.full and second.read == 4


def test_a_case_that_cannot_be_read_keeps_what_the_earlier_scan_found_and_is_read_again_next_time(courts, session, tmp_path):
    first = scan(session, tmp_path)
    session.on(uscourts.RECORD_URL.format(package=PKG), FakeResponse(503))
    second = scan(session, tmp_path, previous=first.state)
    assert list(second.failed) == [PKG] and second.kept == [PKG] and list(second.selected) == [SCHOOL]
    assert second.state["packages"]["ca5"]["25-30725"] == first.state["packages"]["ca5"]["25-30725"]
    courts.serve()
    third = scan(session, tmp_path, previous=second.state)
    assert sorted(third.selected) == [SCHOOL, PKG] and third.failed == {}


def test_a_new_case_that_cannot_be_read_is_left_unlisted_so_that_it_is_read_on_the_next_run(courts, session, tmp_path):
    first = scan(session, tmp_path)
    courts.add("USCOURTS-ca5-25-00005", "Synthetic Unreadable v. Board", [fed.election_opinion()])
    courts.serve()
    session.on(uscourts.DOCUMENT_URL.format(package="USCOURTS-ca5-25-00005", granule="USCOURTS-ca5-25-00005-0"), FakeResponse(500))
    second = scan(session, tmp_path, previous=first.state)
    assert list(second.failed) == ["USCOURTS-ca5-25-00005"] and second.kept == []
    assert "25-00005" not in second.state["packages"]["ca5"]


def test_a_list_that_shrinks_by_more_than_a_tenth_stops_the_scan(courts, session, tmp_path):
    first = scan(session, tmp_path)
    for number in range(10, 30):
        courts.add(f"USCOURTS-ca5-25-000{number}", "Synthetic Supplier v. Buyer", [fed.other_opinion()])
    courts.serve()
    grown = scan(session, tmp_path, previous=first.state)
    for number in range(10, 14):
        courts.remove(f"USCOURTS-ca5-25-000{number}")
    courts.serve()
    with pytest.raises(uscourts.ListingError, match="Fifth Circuit"):
        scan(session, tmp_path, previous=grown.state)


def test_a_selected_case_that_leaves_the_list_is_reported(courts, session, tmp_path):
    first = scan(session, tmp_path)
    for number in range(10, 30):  # so that one case leaving is not a shrinking list
        courts.add(f"USCOURTS-ca5-25-000{number}", "Synthetic Supplier v. Buyer", [fed.other_opinion()])
    courts.serve()
    grown = scan(session, tmp_path, previous=first.state)
    courts.remove(PKG)
    courts.serve()
    result = scan(session, tmp_path, previous=grown.state)
    assert result.unlisted == [PKG] and list(result.selected) == [SCHOOL]


def test_too_many_unreadable_cases_stop_the_scan(session, tmp_path, monkeypatch):
    monkeypatch.setattr(uscourts, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    listed = fed.Courts(session)
    for number in range(40):
        listed.add(f"USCOURTS-ca5-25-000{number:02d}", "Synthetic Supplier v. Buyer", [fed.other_opinion()])
    listed.serve()
    for number in range(30):
        session.on(uscourts.RECORD_URL.format(package=f"USCOURTS-ca5-25-000{number:02d}"), FakeResponse(503))
    with pytest.raises(RuntimeError, match="30 of 40 packages could not be read"):
        scan(session, tmp_path)


def test_a_changed_case_is_read_again_and_an_unchanged_one_comes_from_the_cache(courts, session, tmp_path):
    scan(session, tmp_path)
    before = len(session.urls())
    scan(session, tmp_path)  # no earlier state: a full scan again, but nothing has changed since the cache was filled
    again = session.urls()[before:]
    assert not [url for url in again if "/metadata/pkg/" in url or "/content/pkg/" in url]
    courts.add("USCOURTS-ca5-25-00002", "Synthetic Supplier v. Synthetic Buyer", [fed.election_opinion()], changed="2026-05-31T00:00:00.000Z")
    courts.serve()
    result = scan(session, tmp_path)
    assert sorted(result.selected) == [SCHOOL, "USCOURTS-ca5-25-00002", PKG]
