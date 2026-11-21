"""Measures of Congress: the status record reader, the selection rule, the action and stage rules, and the text reader.

Every measure, member and passage here is invented (see ``synthetic_federal``).
"""

import hashlib

import pytest

from dhq.adapters import bill_text, congress
from dhq import http
from dhq.http import FetchError
from dhq.schemas import LegislativeAction

import synthetic_federal as fed
from conftest import FakeResponse

OFFICIAL = "To require synthetic proof of eligibility to register an individual to vote in elections for Federal office, and for other purposes."


# --- the status record ------------------------------------------------------------------

def test_a_status_record_is_read_as_plain_values():
    record = congress.parse_status(fed.status_record(
        "hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL, short_titles=["SVE Act"],
        actions=[fed.action("2025-04-10", "Passed/agreed to in House: On passage Passed by recorded vote: 220 - 208 (Roll no. 102).", "8000",
                            votes=[{"chamber": "House", "rollNumber": "102", "url": "https://clerk.house.gov/evs/2025/roll102.xml", "session": "1"}]),
                 fed.INTRODUCED],
        versions=[("Introduced in House", "2025-01-03", "ih")], summary="<p><b>Synthetic Act</b></p><p>This bill requires proof.</p><ul><li>One.</li></ul>",
        related=[("s", 128, "Identical bill")], legislation_url="https://www.congress.gov/bill/119th-congress/house-bill/22"))
    assert (record["kind"], record["number"], record["congress"]) == ("hr", 22, 119)
    assert record["titles"] == [("Display title", "Synthetic Voter Eligibility Act"), ("Official Title as Introduced", OFFICIAL),
                                ("Short Title(s) as Introduced", "SVE Act")]
    assert record["policyArea"] == "Government Operations and Politics" and record["introduced"] == "2025-01-03"
    assert record["sponsors"] == [{"name": "Rep. Synthetic, Ada [X-ZZ-1]", "party": "X", "state": "ZZ", "district": "1"}]
    assert record["cosponsors"] == 1  # a withdrawn cosponsor is not counted
    assert record["actions"][0]["votes"] == [{"chamber": "House", "rollNumber": "102", "url": "https://clerk.house.gov/evs/2025/roll102.xml", "session": "1"}]
    assert record["summaries"][0]["paragraphs"] == ["Synthetic Act", "This bill requires proof.", "• One."]
    assert record["versions"] == [{"label": "Introduced in House", "date": "2025-01-03",
                                   "urls": ["https://www.govinfo.gov/content/pkg/BILLS-119hr22ih/xml/BILLS-119hr22ih.xml"]}]
    assert record["related"] == [{"kind": "s", "number": 128, "congress": 119, "title": "A synthetic related measure",
                                  "relationships": ["Identical bill"], "identifiedBy": ["CRS"]}]
    assert record["legislationUrl"] == "https://www.congress.gov/bill/119th-congress/house-bill/22"


@pytest.mark.parametrize("data, message", [
    (b"<billStatus><bill><number>1</number><type>HR</type><congress>119</congress></bill>", "not well-formed"),
    (b"<html><body>Not found</body></html>", "not a bill status record"),
    (b"<billStatus><bill><number>x</number><type>HR</type><congress>119</congress></bill></billStatus>", "not as expected"),
    (b"<billStatus><bill><number>1</number><type>ZZ</type><congress>119</congress></bill></billStatus>", "not as expected"),
    (b"<!DOCTYPE billStatus [<!ENTITY x 'y'>]><billStatus><bill/></billStatus>", "document type or entities"),
])
def test_what_is_not_a_status_record_is_refused(data, message):
    with pytest.raises(congress.StatusRecordError, match=message):
        congress.parse_status(data)


def test_ids_and_addresses_are_built_from_the_measure_type_and_number():
    assert congress.bill_id("hjres", 7) == "us-119-hjres7" and congress.identifier("hjres", 7) == "H.J.Res. 7"
    assert congress.measure_url("s", 128) == "https://www.congress.gov/bill/119th-congress/senate-bill/128"
    assert congress.session_label(119) == "119th Congress (2025–2026)"
    assert [congress.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 101, 111, 112)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "101st", "111th", "112th"]


# --- the selection rule -------------------------------------------------------------------

@pytest.mark.parametrize("titles, area, test, matched", [
    # A title that names election law is selected whatever the policy area.
    ([("Display title", "Synthetic Voter Registration Modernization Act")], "Science, Technology, Communications", "named", "Voter Registration"),
    ([("Display title", "A synthetic act"), ("Official Title as Introduced", "To amend the Help America Vote Act of 2002.")], None, "named", "Help America Vote Act"),
    # A general election word counts in Government Operations and Politics, or while no area is assigned.
    ([("Display title", "To require a synthetic report on apportionment.")], "Government Operations and Politics", "general", "apportionment"),
    ([("Display title", "To require a synthetic report on apportionment.")], None, "general", "apportionment"),
    # A narrower list of words counts in three more areas.
    ([("Display title", "To punish synthetic threats against voters.")], "Crime and Law Enforcement", "other", "voters"),
])
def test_a_measure_is_selected_by_what_its_titles_say(titles, area, test, matched):
    found = congress.selection_match(titles, area)
    assert found is not None and (found["test"], found["matchedText"]) == (test, matched)
    assert found["matchedTitle"] in [title for _kind, title in titles]


@pytest.mark.parametrize("titles, area", [
    # The general word is not enough outside the listed areas.
    ([("Display title", "To require a synthetic report on apportionment.")], "Transportation and Public Works"),
    ([("Display title", "To punish synthetic threats against electors.")], "Crime and Law Enforcement"),
    # Elections in other countries.
    ([("Display title", "Condemning the synthetic presidential election in Ruritania and its voter suppression.")], "International Affairs"),
    # Procedure of the chambers and voting outside public elections are removed before a title is read.
    ([("Display title", "Providing for consideration of the bill (H.R. 22) to amend the National Voter Registration Act.")], "Congress"),
    ([("Display title", "Relating to the election of the Speaker.")], "Congress"),
    ([("Display title", "To permit proxy voting in synthetic committees.")], "Government Operations and Politics"),
    ([("Display title", "To name a synthetic bridge.")], "Government Operations and Politics"),
])
def test_a_measure_that_only_seems_to_concern_elections_is_not_selected(titles, area):
    assert congress.selection_match(titles, area) is None


def test_changing_a_selection_pattern_requires_a_new_rule_id():
    """The published rule id names the patterns. Whoever changes one must give the rule a new id (and update this hash),
    so that a reader can tell which rule selected a measure."""
    parts = [congress.SELECTION_PATTERN.pattern, congress.GENERAL_PATTERN.pattern, congress.OTHER_PATTERN.pattern, congress.EXCLUSION_PATTERN.pattern,
             repr(congress.GENERAL_AREAS), repr(congress.OTHER_AREAS), repr(congress.EXCLUDED_AREAS)]
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    assert (congress.SELECTION_RULE_ID, digest) == ("us-select-1", "7a77e051d8f40335b22410f49576999fcb875409bbf1f97810b6a99dde446e23")


# --- actions and the stage ------------------------------------------------------------------

@pytest.mark.parametrize("text, code, source, kind, expected", [
    ("Became Public Law No: 119-4.", "36000", fed.LOC, "BecameLaw", ("us-became-law", "became_law", "major")),
    ("Signed by President.", "E30000", fed.LOC, "President", ("us-signed", "approved_by_president", "major")),
    ("Vetoed by President.", "31000", fed.LOC, "Veto", ("us-vetoed", "vetoed", "major")),
    ("Passed/agreed to in House: On passage Passed by recorded vote: 220 - 208.", "8000", fed.LOC, "Floor", ("us-passed-house", "passed_house", "major")),
    ("Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.", "17000", fed.LOC, "Floor", ("us-passed-senate", "passed_senate", "major")),
    ("Failed of passage/not agreed to in Senate: Cloture not invoked.", "18000", fed.LOC, "Floor", ("us-failed-senate", "vote_failed", "major")),
    ("Reported by the Committee on Synthetic Matters. H. Rept. 119-1.", "5000", fed.LOC, "Committee", ("us-reported", "reported", "major")),
    ("Introduced in Senate", "10000", fed.LOC, "IntroReferral", ("us-introduced", "introduced", "major")),
    # The chambers' own entries are never read as a step, whatever they say.
    ("On passage Passed by recorded vote: 220 - 208 (Roll no. 102).", "H37100", "House floor actions", "Floor", ("us-other", "floor_action", "routine")),
    ("Referred to the House Committee on Synthetic Matters.", "H11100", "House floor actions", "IntroReferral", ("us-other", "referral", "routine")),
    # A standard line whose code and wording do not go together is not labelled.
    ("Passed/agreed to in House.", "17000", fed.LOC, "Floor", ("us-other", "floor_action", "routine")),
    ("Something else entirely.", None, None, None, ("us-other", "legislative_action", "routine")),
])
def test_only_the_standard_lines_of_the_library_of_congress_are_read_as_steps(text, code, source, kind, expected):
    assert congress.classify_action(text, code, source, kind) == expected


def _actions(*pairs):
    return [LegislativeAction(date="2025-02-01", sequence=i, text="synthetic", eventType=event, significance="major", classificationRule=rule)
            for i, (event, rule) in enumerate(pairs, start=1)]


@pytest.mark.parametrize("kind, steps, stage", [
    ("hr", [("introduced", "us-introduced")], "Introduced"),
    ("hr", [("introduced", "us-introduced"), ("reported", "us-reported")], "Reported by committee"),
    ("hr", [("passed_house", "us-passed-house")], "Passed the House"),
    ("s", [("passed_senate", "us-passed-senate"), ("vote_failed", "us-failed-house")], "Passed the Senate"),
    ("hr", [("vote_failed", "us-failed-senate")], "Failed in the Senate"),
    # A vote of passage in each chamber is not passage by Congress: the two can be on different texts.
    ("hr", [("passed_house", "us-passed-house"), ("passed_senate", "us-passed-senate")], "Passed House and Senate, not sent to the President"),
    ("hconres", [("passed_house", "us-passed-house"), ("passed_senate", "us-passed-senate")], "Agreed to in House and Senate"),
    ("hres", [("passed_house", "us-passed-house")], "Agreed to in the House"),
    ("sres", [("vote_failed", "us-failed-senate")], "Not agreed to in the Senate"),
    ("hr", [("passed_house", "us-passed-house"), ("passed_senate", "us-passed-senate"), ("presented_to_president", "us-presented")], "Sent to the President"),
    ("hr", [("presented_to_president", "us-presented"), ("vetoed", "us-vetoed")], "Vetoed"),
    ("hr", [("vetoed", "us-vetoed"), ("became_law", "us-became-law")], "Became law"),
])
def test_the_stage_is_the_furthest_step_a_measure_reached(kind, steps, stage):
    assert congress.derive_status(kind, _actions(*steps)) == stage
    assert stage in congress.STATUS_ORDER


def test_a_vote_of_passage_in_each_chamber_is_never_called_passage_by_congress():
    """One chamber can pass the other's bill with an amendment. The record then has a vote of passage in each chamber
    and no text both agreed to, so neither the stage nor the note may say that the measure passed Congress."""
    assert not any("both chambers" in stage.lower() for stage in congress.STATUS_ORDER)
    bill = congress.effective_info("s", "A synthetic act", congress.PASSED_IN_EACH, None, None, None)
    assert bill.basis == "not_enacted" and "does not show that both passed the same text" in bill.note
    resolution = congress.effective_info("sconres", "A synthetic resolution", congress.AGREED_IN_EACH, None, None, None)
    assert resolution.basis == "not_applicable" and "whether both agreed to the same text is not read" in resolution.note
    assert "has not been agreed to in both chambers" in congress.effective_info("sconres", "A synthetic resolution", "Introduced", None, None, None).note


def test_no_effective_date_is_ever_asserted():
    law = congress.effective_info("hr", "A synthetic act", "Became law", "2025-03-01", None, "Public Law 119-4")
    assert (law.date, law.basis) == (None, "not_verified") and "Public Law 119-4 on March 1, 2025" in law.note
    assert congress.effective_info("hr", "A synthetic act", "Introduced", None, None, None).basis == "not_enacted"
    assert congress.effective_info("hres", "A synthetic resolution", "Agreed to in the House", None, None, None).basis == "not_applicable"
    amendment = congress.effective_info("hjres", "Proposing an amendment to the Constitution of the United States.", "Introduced", None, None, None)
    assert amendment.basis == "not_enacted" and "three fourths of the States" in amendment.note


# --- a measure's record -----------------------------------------------------------------------

class Texts:
    """Stands in for the store of text versions."""

    def __init__(self, documents):
        self.documents = documents

    def get(self, package):
        if package not in self.documents:
            raise OSError(f"{package} not scripted")
        return self.documents[package]


def _entry(data: bytes) -> dict:
    record = congress.parse_status(data)
    return {"record": record, "matched": congress.selection_match(record["titles"], record["policyArea"]), "sourceHash": "0" * 64}


SECTIONS_1 = [("1", "Short title", ["This Act may be cited as the Synthetic Voter Eligibility Act."]),
              ("2", "Proof", ["A State shall accept a synthetic document.", "The Commission shall publish a form."])]
SECTIONS_2 = [SECTIONS_1[0], ("2", "Proof", ["A State shall accept a synthetic document.", "The Commission shall publish a form within 30 days."])]


def test_a_record_carries_its_versions_in_order_with_mirrored_text_and_a_comparison():
    data = fed.status_record(
        "hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL, short_titles=["SVE Act"],
        actions=[fed.action("2025-04-10", "Passed/agreed to in House: On passage Passed.", "8000"),
                 fed.action("2025-04-10", "On passage Passed by recorded vote.", "H37100", source="House floor actions", time="10:31:00"),
                 fed.INTRODUCED],
        # Listed newest first, as the record does.
        versions=[("Engrossed in House", "2025-04-10", "eh"), ("Introduced in House", "2025-01-03", "ih")],
        summary="<p>This bill requires synthetic proof of eligibility to register to vote.</p>", related=[("s", 128, "Identical bill")])
    texts = Texts({"BILLS-119hr22ih": fed.bill_text(OFFICIAL, SECTIONS_1), "BILLS-119hr22eh": fed.bill_text(OFFICIAL, SECTIONS_2)})
    instrument, text_records, notes = congress.build_instrument(_entry(data), texts, checked_at="2026-06-01T10:00:00Z", in_dataset={"us-119-s128"})
    assert notes == []
    assert (instrument.id, instrument.state, instrument.identifier, instrument.measureType) == ("us-119-hr22", "US", "H.R. 22", "House Bill")
    assert (instrument.subject, instrument.title, instrument.shortTitles) == ("Synthetic Voter Eligibility Act", OFFICIAL, ["SVE Act"])
    assert instrument.legislativeStatus.currentStatus == "Passed the House" and instrument.legislativeStatus.measureState == "Engrossed in House"
    assert [(v.id, v.versionNum, v.textAvailability, v.textPath) for v in instrument.versions] == [
        ("BILLS-119hr22ih", 1, "mirrored", "congress/text/BILLS-119hr22ih.json"),
        ("BILLS-119hr22eh", 2, "mirrored", "congress/text/BILLS-119hr22eh.json")]
    assert instrument.versions[0].diff is None
    assert (instrument.versions[1].diff.previousVersionId, instrument.versions[1].diff.blocksAdded, instrument.versions[1].diff.blocksRemoved) == (
        "BILLS-119hr22ih", 1, 1)
    assert text_records["BILLS-119hr22ih"]["blocks"][:3] == [
        ["s", "Sec. 1. Short title"], ["p", "(a) This Act may be cited as the Synthetic Voter Eligibility Act."], ["s", "Sec. 2. Proof"]]
    # Oldest first; the House's own floor entry of the same day stays a routine line beside the standard one.
    assert [(a.sequence, a.eventType, a.significance) for a in instrument.actions] == [
        (1, "introduced", "major"), (2, "floor_action", "routine"), (3, "passed_house", "major")]
    assert instrument.actions[1].time == "10:31:00" and instrument.actions[1].source == "House floor actions"
    assert instrument.digest == "This bill requires synthetic proof of eligibility to register to vote." and instrument.digestVersion == "Introduced in House"
    assert [(r.identifier, r.relationship, r.identifiedBy, r.id) for r in instrument.relatedMeasures] == [("S. 128", "Identical bill", "CRS", "us-119-s128")]
    assert instrument.officialUrl == "https://www.congress.gov/bill/119th-congress/house-bill/22"
    assert instrument.sourceRecordUrl == "https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr22.xml"
    assert instrument.effective.date is None and instrument.verification.status.value == "verified_primary"


def test_a_text_that_fails_the_readers_check_is_listed_with_a_link_only_and_a_missing_one_holds_the_measure():
    data = fed.status_record("hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL,
                             versions=[("Introduced in House", "2025-01-03", "ih")])
    unreadable = Texts({"BILLS-119hr22ih": b"<bill><legis-body><section><enum>1.</enum><header>One</header><header>Lost words</header></section></legis-body></bill>"})
    instrument, text_records, notes = congress.build_instrument(_entry(data), unreadable, checked_at="2026-06-01T10:00:00Z")
    assert text_records == {} and instrument.versions[0].textAvailability == "link_only" and instrument.versions[0].textPath is None
    assert len(notes) == 1 and "listed with a link only" in notes[0] and "self-check failed" in notes[0]
    with pytest.raises(congress.BillTextUnavailable, match="BILLS-119hr22ih"):
        congress.build_instrument(_entry(data), Texts({}), checked_at="2026-06-01T10:00:00Z")


# --- the text versions of a run, checked together ---------------------------------------

def _text_url(package: str) -> str:
    return congress.TEXT_URL.format(package=package)


def _served(package: str) -> FakeResponse:
    return FakeResponse(200, f"<bill>{package}</bill>", {"Last-Modified": "Mon, 01 Jun 2026 08:00:00 GMT"})


def test_text_versions_the_server_failed_are_asked_for_again_together_after_one_pause(fetcher, session, sleeps, tmp_path):
    store = congress.TextStore(fetcher, tmp_path)
    first, second, third = "BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"
    come_back_later = FakeResponse(502, b"error", {"Retry-After": "60"})
    session.on(_text_url(first), _served(first))
    session.on(_text_url(second), come_back_later, _served(second))
    session.on(_text_url(third), come_back_later, come_back_later, _served(third))
    assert store.check([first, second, third]) == {}
    # One pause for a round, however many versions the server failed in it: the minute it asked for.
    assert sleeps == [60.0, 60.0]
    assert [session.urls().count(_text_url(package)) for package in (first, second, third)] == [1, 2, 3]
    # What was checked is read from the copy held, without another request.
    assert store.get(third) == b"<bill>BILLS-119hr3ih</bill>"
    assert len(session.calls) == 6


def test_a_text_version_that_does_not_exist_is_asked_for_once(fetcher, session, sleeps, tmp_path):
    store = congress.TextStore(fetcher, tmp_path)
    missing, there = "BILLS-119hr1ih", "BILLS-119hr2ih"  # the first is not served: the answer is 404
    session.on(_text_url(there), _served(there))
    failed = store.check([missing, there])
    assert list(failed) == [missing] and failed[missing].status == 404
    assert sleeps == []
    with pytest.raises(FetchError):
        store.get(missing)
    assert session.urls().count(_text_url(missing)) == 1
    assert store.get(there) == b"<bill>BILLS-119hr2ih</bill>"


def test_a_text_version_is_asked_for_a_limited_number_of_times_with_longer_pauses(fetcher, session, sleeps, tmp_path):
    store = congress.TextStore(fetcher, tmp_path)
    package = "BILLS-119hr1ih"
    session.on(_text_url(package), FakeResponse(502))  # no wait is named: the pauses double, up to a minute
    failed = store.check([package])
    assert failed[package].status == 502
    assert session.urls().count(_text_url(package)) == http.ROUNDS == 12
    assert sleeps == [5.0, 10.0, 20.0, 40.0] + [60.0] * 7
    with pytest.raises(FetchError):
        store.get(package)
    assert session.urls().count(_text_url(package)) == 12  # the answer of the check stands for the run


def test_a_server_that_answers_no_request_at_all_is_not_asked_again(fetcher, session, sleeps, tmp_path):
    store = congress.TextStore(fetcher, tmp_path)
    packages = [f"BILLS-119hr{number}ih" for number in range(1, http.DOWN_AT + 1)]
    for package in packages:
        session.on(_text_url(package), FakeResponse(502, b"error", {"Retry-After": "60"}))
    failed = store.check(packages)
    assert sorted(failed) == sorted(packages)
    assert sleeps == [] and len(session.calls) == len(packages)


def test_the_text_versions_of_the_selected_measures_are_listed_for_the_check():
    listed = fed.status_record("hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL,
                               versions=[("Engrossed in House", "2025-04-10", "eh"), ("Introduced in House", "2025-01-03", "ih")])
    other = fed.status_record("sres", 5, title="A resolution recognizing synthetic poll workers on Election Day.",
                              versions=[("Introduced in Senate", "2025-02-03", "is")])
    selected = {"us-119-hr22": _entry(listed), "us-119-sres5": _entry(other), "unreadable": {"record": {}}}
    assert congress.text_packages(selected) == ["BILLS-119hr22eh", "BILLS-119hr22ih", "BILLS-119sres5is"]


def test_a_version_the_record_lists_without_a_text_address_is_left_out_and_noted():
    data = fed.status_record("hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL).replace(
        b"<textVersions></textVersions>", b"<textVersions><item><type>Enrolled Bill</type><date>2025-05-01T04:00:00Z</date><formats/></item></textVersions>")
    instrument, _texts, notes = congress.build_instrument(_entry(data), Texts({}), checked_at="2026-06-01T10:00:00Z")
    assert instrument.versions == [] and instrument.versionCount == 0
    assert notes == ["text version 'Enrolled Bill' has no usable XML address or date in the status record; it is not listed"]


def test_a_text_address_of_another_measure_is_never_followed():
    data = fed.status_record("hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL,
                             versions=[("Introduced in House", "2025-01-03", "ih")]).replace(b"BILLS-119hr22ih", b"BILLS-119hr23ih")
    instrument, _texts, notes = congress.build_instrument(_entry(data), Texts({}), checked_at="2026-06-01T10:00:00Z")
    assert instrument.versions == [] and "no usable XML address" in notes[0]


# --- the text reader ------------------------------------------------------------------------

def test_the_text_reader_keeps_every_word_and_adds_only_the_printed_labels():
    parsed = bill_text.parse_bill_text(
        b"<bill><form><official-title>To do a synthetic thing.</official-title></form><legis-body>"
        b"<title><enum>I</enum><header>Synthetic matters</header>"
        b"<section><enum>101.</enum><header>Amendment</header><text>Section 5 is amended by inserting after subsection (a) the following:</text>"
        b"<quoted-block><subsection><enum>(b)</enum><header>Rule</header><text>A <quote>synthetic voter</quote> may <deleted-phrase>not </deleted-phrase>register.</text>"
        b"</subsection><after-quoted-block>.</after-quoted-block></quoted-block></section></title></legis-body></bill>")
    assert parsed["format"] == "dtd" and parsed["officialTitle"] == "To do a synthetic thing."
    assert parsed["blocks"] == [
        ["h", "Title I—Synthetic matters"], ["s", "Sec. 101. Amendment"],
        ["p", "Section 5 is amended by inserting after subsection (a) the following:"],
        # Quoted text carries the marks the printed bill gives it, and the phrase the document marks as deleted is left out.
        ["p", "“(b) Rule.—A “synthetic voter” may register.”."]]
    assert parsed["wordCount"] == 25


def test_the_text_reader_reads_the_newer_markup_too():
    uslm = "http://schemas.gpo.gov/xml/uslm"
    parsed = bill_text.parse_bill_text(
        f"<bill xmlns=\"{uslm}\"><main><longTitle><officialTitle>To do a synthetic thing.</officialTitle></longTitle>"
        "<section><num>SECTION 1.</num><heading>SHORT TITLE.</heading><content>This Act is the Synthetic Act.</content></section>"
        "</main></bill>".encode("utf-8"))
    assert parsed["format"] == "uslm" and parsed["officialTitle"] == "To do a synthetic thing."
    assert parsed["blocks"][-2:] == [["s", "SECTION 1. SHORT TITLE."], ["p", "This Act is the Synthetic Act."]]


@pytest.mark.parametrize("data, message", [
    (b"<bill><legis-body><section><enum>1.</enum><header>One</header><header>Lost words</header></section></legis-body></bill>", "self-check failed"),
    (b"<report><legis-body/></report>", "unexpected root element 'report'"),
    (b"<bill><form/></bill>", "no body"),
    (b"<bill><legis-body></legis-body></bill>", "no text"),
    (b"<!DOCTYPE bill [<!ENTITY x 'y'>]><bill><legis-body><text>&x;</text></legis-body></bill>", "internal DTD subset"),
    (b"<!DOCTYPE bill SYSTEM 'bill.dtd'><bill><legis-body><text>caf&eacute;</text></legis-body></bill>", "entity reference"),
    (b"<bill><legis-body><text>unclosed</legis-body></bill>", "not well-formed"),
])
def test_a_document_the_reader_cannot_vouch_for_is_refused(data, message):
    with pytest.raises(bill_text.BillTextError, match=message):
        bill_text.parse_bill_text(data)
