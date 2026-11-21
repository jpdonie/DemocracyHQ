"""California legislation adapter, exercised with a synthetic bulk archive."""

import hashlib

import pytest

from dhq.adapters import ca_leginfo
from dhq.http import Fetcher

import synthetic_ca as syn
from conftest import make_zip

CHECKED = "2026-06-15T12:00:00Z"


@pytest.fixture
def archive(session, tmp_path):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    return ca_leginfo.CaliforniaArchive(Fetcher(session=session, retries=0, sleep=lambda s: None), 2025, cache=tmp_path / "cache")


def build(archive, bill_id):
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))
    history = archive.table("BILL_HISTORY_TBL.dat")
    return ca_leginfo.build_instrument(archive, selected[bill_id], [h for h in history if h[0] == bill_id], checked_at=CHECKED)


# --- table format ---------------------------------------------------------------------

def _cached_archive(session, tmp_path, last_modified):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(), last_modified=last_modified)
    return ca_leginfo.CaliforniaArchive(Fetcher(session=session, retries=0, sleep=lambda s: None), 2025, cache=tmp_path / "cache")


def test_reading_a_table_deletes_the_cached_tables_of_other_archive_dates(session, tmp_path):
    cache = tmp_path / "cache"
    first = _cached_archive(session, tmp_path, "Mon, 01 Jun 2026 08:00:00 GMT")
    expected = first.table("BILL_TBL.dat")
    first.table("BILL_VERSION_TBL.dat")
    assert sorted(p.name for p in cache.glob("*.dat")) == [
        "BILL_TBL.dat.2026-06-01T080000Z.dat", "BILL_VERSION_TBL.dat.2026-06-01T080000Z.dat"]
    # Left by an adapter that cached tables without a date, and a text cached by version id (kept).
    (cache / "CODES_TBL.dat").write_bytes(b"old")
    (cache / "lob" / "by-version").mkdir(parents=True)
    (cache / "lob" / "by-version" / "20250AB199INT.xml").write_bytes(b"<kept/>")

    second = _cached_archive(session, tmp_path, "Tue, 02 Jun 2026 08:00:00 GMT")
    assert second.table("BILL_TBL.dat") == expected
    # Only the table read so far is cached for the new date; every table of the earlier date is gone.
    assert sorted(p.name for p in cache.glob("*.dat")) == ["BILL_TBL.dat.2026-06-02T080000Z.dat"]
    assert (cache / "lob" / "by-version" / "20250AB199INT.xml").read_bytes() == b"<kept/>"


def test_tables_of_the_current_archive_date_are_kept_and_reused(session, tmp_path):
    cache = tmp_path / "cache"
    archive = _cached_archive(session, tmp_path, "Mon, 01 Jun 2026 08:00:00 GMT")
    archive.table("BILL_TBL.dat")
    archive.table("BILL_HISTORY_TBL.dat")
    again = _cached_archive(session, tmp_path, "Mon, 01 Jun 2026 08:00:00 GMT")
    reads_before = len(session.urls())
    again.table("BILL_TBL.dat")
    again.table("BILL_HISTORY_TBL.dat")
    assert sorted(p.name for p in cache.glob("*.dat")) == [
        "BILL_HISTORY_TBL.dat.2026-06-01T080000Z.dat", "BILL_TBL.dat.2026-06-01T080000Z.dat"]
    assert len(session.urls()) == reads_before  # both tables came from the cache


def test_without_an_archive_date_nothing_is_cached_or_deleted(session, tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "BILL_TBL.dat.2026-06-01T080000Z.dat").write_bytes(b"from an earlier date")
    archive = _cached_archive(session, tmp_path, "")
    assert archive.archive_modified is None
    archive.table("BILL_TBL.dat")
    assert [p.name for p in cache.glob("*.dat")] == ["BILL_TBL.dat.2026-06-01T080000Z.dat"]


def test_a_table_that_cannot_be_read_deletes_nothing(session, tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "BILL_TBL.dat.2026-05-31T080000Z.dat").write_bytes(b"from an earlier date")
    archive = _cached_archive(session, tmp_path, "Mon, 01 Jun 2026 08:00:00 GMT")

    def broken(text):
        raise ValueError("synthetic: unreadable table")

    monkeypatch.setattr(ca_leginfo, "parse_table", broken)
    with pytest.raises(ValueError, match="unreadable table"):
        archive.table("BILL_TBL.dat")
    assert (cache / "BILL_TBL.dat.2026-05-31T080000Z.dat").exists()


def test_parse_table_handles_quotes_nulls_and_multi_line_cells():
    text = "`a`\tNULL\t`two\nlines`\t7\n\n`b`\t``\tNULL\t8\n"
    assert ca_leginfo.parse_table(text) == [["a", None, "two\nlines", "7"], ["b", "", None, "8"]]


# --- selection rule -------------------------------------------------------------------

def test_selection_uses_the_latest_official_subject_line_and_records_the_match(archive):
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))
    assert set(selected) == {syn.A, syn.C, syn.E}
    assert selected[syn.A]["matched"] == "Elections"
    assert selected[syn.E]["matched"] == "Voter"
    assert syn.B not in selected  # subject does not match the published pattern
    assert syn.D not in selected  # inactive in the source


def test_inactive_versions_are_ignored(archive):
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))
    assert [v[0] for v in selected[syn.A]["versions"]] == ["20250AB199INT", "20250AB198AMD", "20250AB197CHP"]


# --- bill text ------------------------------------------------------------------------

def test_text_is_extracted_as_blocks_in_document_order():
    parsed = ca_leginfo.parse_bill_xml(syn.caml("Elections: synthetic ballots.", [syn.P1, syn.P2]))
    assert parsed["subject"] == "Elections: synthetic ballots."
    assert parsed["title"] == "An act relating to synthetic elections."
    assert parsed["digest"] == ["Existing law is synthetic.", "This bill would stay synthetic."]
    assert parsed["blocks"] == [
        ["s", "SEC. 1."], ["a", "Section 990 is added to the Elections Code, to read:"], ["s", "990."], ["p", syn.P1],
        ["s", "SEC. 2."], ["a", "Section 991 is added to the Elections Code, to read:"], ["s", "991."], ["p", syn.P2],
    ]
    assert parsed["statutes"][0] == {"action": "IS_ADDED", "code": "ELEC", "text": "Section 990 is added to the Elections Code, to read:"}
    assert parsed["indicators"] == {"ImmediateEffect": "NO", "VoteRequired": "MAJORITY"}


def test_struck_text_kept_in_processing_instructions_is_not_part_of_the_version():
    xml = syn.caml("Elections.", ["Ballots are due in <?xm-deletion_mark data=\"three\"?>seven days."])
    assert ca_leginfo.parse_bill_xml(xml)["blocks"][-1] == ["p", "Ballots are due in seven days."]


def test_xml_with_a_dtd_or_entities_is_refused():
    hostile = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'
    with pytest.raises(ValueError, match="DTD/entity"):
        ca_leginfo.parse_bill_xml(hostile)


def test_diff_meta_counts_paragraphs():
    meta = ca_leginfo.diff_meta("V1", ["a", "b", "c"], ["a", "x", "c", "d"])
    assert (meta.previousVersionId, meta.blocksUnchanged, meta.blocksAdded, meta.blocksRemoved) == ("V1", 2, 2, 1)
    assert meta.similarity == round(4 / 7, 4)
    assert ca_leginfo.diff_meta("V1", [], []).similarity == 1.0


# --- legislative history rules --------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("Chaptered by Secretary of State - Chapter 7, Statutes of 2026.", ("ca-chaptered", "chaptered", "major")),
    ("Approved by the Governor.", ("ca-approved", "approved_by_governor", "major")),
    ("Vetoed by Governor.", ("ca-vetoed", "vetoed", "major")),
    ("Enrolled and presented to the Governor at 3 p.m.", ("ca-enrolled", "enrolled", "major")),
    ("Read third time. Passed. Ordered to the Senate.", ("ca-passed", "passed_house", "major")),
    ("Read first time. To print.", ("ca-introduced", "introduced", "major")),
    ("Died on file pursuant to Joint Rule 56.", ("ca-died", "died", "major")),
    ("Referred to Com. on ELECTIONS.", ("ca-committee", "committee_action", "routine")),
    ("A synthetic step no rule describes.", ("ca-other", "legislative_action", "routine")),
])
def test_action_rules(text, expected):
    assert ca_leginfo.classify_action(text) == expected


# --- building a record ----------------------------------------------------------------

def test_instrument_keeps_the_official_identifiers_and_status_words(archive):
    bill, _ = build(archive, syn.A)
    assert bill.id == "ca-20252026-ab1"
    assert (bill.identifier, bill.measureType, bill.session) == ("AB 1", "Assembly Bill", "2025-2026 Regular Session")
    assert bill.legislativeStatus.measureState == "Chaptered"  # exactly as the legislature reports it
    assert bill.chapter.citation == "Chapter 7, Statutes of 2026"
    assert bill.subject == "Elections: synthetic ballots."
    assert bill.officialUrl == "https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB1"
    assert bill.verification.status.value == "verified_primary"
    assert bill.sourcePublishedAt == "2026-06-01T08:00:00Z"


def test_versions_are_ordered_and_each_mirrored_text_is_hashed(archive):
    bill, texts = build(archive, syn.A)
    assert [(v.label, v.versionDate, v.textAvailability) for v in bill.versions] == [
        ("Introduced", "2026-01-06", "mirrored"), ("Amended Assembly", "2026-03-01", "mirrored"), ("Chaptered", "2026-05-01", "mirrored"),
    ]
    assert bill.introducedDate == "2026-01-06"
    for version in bill.versions:
        text = texts[version.id]
        joined = "\n".join(block[1] for block in text["blocks"])
        assert version.textHash == text["textHash"] == hashlib.sha256(joined.encode()).hexdigest()
        assert version.textPath == f"legislation/text/{version.id}.json"
        assert version.officialUrl.endswith(f"cversion={version.id}")
        assert len(version.sourceHash) == 64
    assert bill.versions[0].diff is None
    assert (bill.versions[1].diff.blocksAdded, bill.versions[1].diff.blocksRemoved) == (1, 1)
    assert (bill.versions[2].diff.blocksAdded, bill.versions[2].diff.blocksRemoved) == (4, 0)


def test_a_version_the_source_gives_no_text_for_is_link_only_and_never_filled_in(session, tmp_path):
    members = syn.members()
    members["BILL_VERSION_TBL.dat"] = members["BILL_VERSION_TBL.dat"].replace(b"`lob/a98.lob`", b"NULL")
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members))
    archive = ca_leginfo.CaliforniaArchive(Fetcher(session=session, retries=0, sleep=lambda s: None), 2025, cache=tmp_path / "cache")
    bill, texts = build(archive, syn.A)
    amended = bill.versions[1]
    assert amended.textAvailability == "link_only"
    assert amended.textPath is None and amended.textHash is None and amended.diff is None
    assert amended.id not in texts
    assert amended.officialUrl.startswith("https://leginfo.legislature.ca.gov/")
    # The next mirrored version is compared with the last version whose text is known.
    assert bill.versions[2].diff.previousVersionId == bill.versions[0].id


@pytest.mark.parametrize("member", [
    None,  # listed in the version table, absent from the archive
    b"<caml:MeasureDoc",  # not well-formed
    syn.caml("Elections: synthetic ballots.", [syn.P1, syn.P2], version_id="20250AB199INT"),  # another version's text
    syn.caml("Elections: synthetic ballots.", [syn.P1, syn.P2]),  # says nothing about which version it is
])
def test_a_listed_text_that_cannot_be_read_parsed_or_matched_fails_the_bill(session, tmp_path, member):
    members = syn.members()
    if member is None:
        del members["lob/a98.lob"]
    else:
        members["lob/a98.lob"] = member
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members))
    archive = ca_leginfo.CaliforniaArchive(Fetcher(session=session, retries=0, sleep=lambda s: None), 2025, cache=tmp_path / "cache")
    with pytest.raises(ca_leginfo.VersionTextError, match="20250AB198AMD"):
        build(archive, syn.A)


def test_the_id_a_text_gives_itself_is_compared_in_the_tables_form():
    assert ca_leginfo.caml_version_id("20250SB__097099INT") == "20250SB97099INT"
    assert ca_leginfo.caml_version_id(syn.caml_id("20250ACA399INT")) == "20250ACA399INT"
    assert ca_leginfo.caml_version_id("20250AB__000199INT") != "20250AB198AMD"


def test_history_is_kept_entry_by_entry_in_date_order(archive):
    bill, _ = build(archive, syn.A)
    assert [(a.date, a.eventType) for a in bill.actions] == [
        ("2026-01-06", "introduced"), ("2026-02-01", "legislative_action"), ("2026-03-01", "amended"),
        ("2026-04-01", "passed_house"), ("2026-04-30", "approved_by_governor"), ("2026-05-01", "chaptered"),
    ]
    assert bill.actions[1].text == "Some synthetic step that spans two lines."
    assert all(a.classificationRule for a in bill.actions)
    assert (bill.approvedDate, bill.chapteredDate, bill.vetoedDate) == ("2026-04-30", "2026-05-01", None)
    assert (bill.lastActionDate, bill.lastActionText) == ("2026-05-01", "Chaptered by Secretary of State - Chapter 7, Statutes of 2026.")


def test_enactment_does_not_imply_an_effective_date(archive):
    bill, _ = build(archive, syn.A)
    assert bill.chapteredDate == "2026-05-01"
    assert bill.effective.date is None
    assert bill.effective.basis == "not_verified"
    assert "has not verified one" in bill.effective.note


def test_effective_date_is_given_only_when_the_source_flags_immediate_effect(archive):
    bill, _ = build(archive, syn.E)
    assert bill.indicators["ImmediateEffect"] == "YES"
    assert (bill.effective.date, bill.effective.basis) == ("2026-05-04", "immediate_effect_flag")
    assert "individual provisions may state other operative dates" in bill.effective.note


def test_a_constitutional_amendment_never_gets_an_effective_date(archive):
    bill, texts = build(archive, syn.C)
    assert bill.measureType == "Assembly Constitutional Amendment"
    assert bill.chapteredDate == "2026-05-03"
    assert bill.effective.date is None and "only if the voters approve" in bill.effective.note
    assert texts[bill.versions[0].id]["blocks"][-1] == ["p", "The synthetic constitution is amended."]


def test_legislative_status_says_nothing_about_the_courts(archive):
    bill, _ = build(archive, syn.A)
    assert "does not show whether a court has blocked" in bill.judicialNote
    assert not {"enforceable", "inEffect", "blocked", "enjoined"} & set(bill.model_dump())


def test_content_hash_ignores_the_time_of_the_check(archive):
    a, _ = build(archive, syn.A)
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))
    b, _ = ca_leginfo.build_instrument(archive, selected[syn.A], archive.table("BILL_HISTORY_TBL.dat"), checked_at="2026-07-01T00:00:00Z")
    assert a.contentHash == b.contentHash and a.lastCheckedAt != b.lastCheckedAt


# --- rules added after the first review -----------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("Veto sustained.", ("ca-veto-stands", "veto_stands", "major")),
    ("Consideration of Governor's veto stricken from file.", ("ca-veto-stands", "veto_stands", "major")),
    ("Action rescinded whereby the bill was read third time and passed.", ("ca-rescinded", "action_rescinded", "major")),
    ("Assembly refused to concur in Senate amendments.", ("ca-vote-failed", "vote_failed", "major")),
    ("Read third time. Refused passage. (Ayes 30. Noes 40.)", ("ca-vote-failed", "vote_failed", "major")),
    ("Senate amendments concurred in. To Engrossing and Enrolling.", ("ca-concurred", "concurred", "major")),
    ("Read. Adopted. (Ayes 70. Noes 0.)", ("ca-passed", "passed_house", "major")),
    ("Adopted and to Assembly.", ("ca-passed", "passed_house", "major")),
    # The Assembly files a bill with the Chief Clerk after recording its death under art. IV, sec. 10(c): clerical, not a second death.
    ("From committee: Filed with the Chief Clerk pursuant to Joint Rule 56.", ("ca-committee", "committee_action", "routine")),
    ("Returned to Secretary of Senate pursuant to Joint Rule 56.", ("ca-died", "died", "major")),
    ("From committee without further action.", ("ca-died", "died", "major")),
    # Taking a bill off the floor calendar does not end it.
    ("Stricken from file.", ("ca-other", "legislative_action", "routine")),
    ("Enrolled and filed with the Secretary of State at 4 p.m.", ("ca-enrolled", "enrolled", "major")),
])
def test_later_action_rules(text, expected):
    assert ca_leginfo.classify_action(text) == expected


@pytest.mark.parametrize("subject,matched", [
    ("Elections: vote by mail ballots.", "Elections"),
    ("Recall elections: procedures.", "Recall elections"),
    ("Initiative measures: signatures.", "Initiative measures"),
    ("Initiatives: fiscal analysis.", "Initiatives"),
    ("Political Reform Act of 1974: campaign contributions.", "Political Reform Act"),
    # Words that look electoral but are not.
    ("Taxation: water's-edge election.", None),
    ("Marine Carbon Initiative.", None),
    ("Cannabis: product recall.", None),
    ("Penal Code: recall and resentencing.", None),
    # The Political Reform Act's ethics and lobbying provisions are left out by name.
    ("Political Reform Act of 1974: lobbying.", None),
    ("Political Reform Act of 1974: statements of economic interests.", None),
])
def test_selection_rule_two(subject, matched):
    assert ca_leginfo.selection_match(subject) == matched


def _bill(bill_id: str, session_num: str) -> list:
    row = [None] * 19
    row[0], row[1], row[2], row[11] = bill_id, "20252026", session_num, "Y"
    return row


def _version(bill_id: str, subject: str) -> list:
    row = [None] * 17
    row[0], row[1], row[2], row[6], row[15] = f"{bill_id}INT", bill_id, "99", subject, "Y"
    return row


def test_only_regular_session_measures_are_selected():
    bills = [_bill("202520260AB9", "0"), _bill("202520261AB9", "1")]
    versions = [_version("202520260AB9", "Elections."), _version("202520261AB9", "Elections.")]
    assert set(ca_leginfo.select_bills(bills, versions)) == {"202520260AB9"}


def test_whole_and_part_numbers_of_a_fraction_stay_apart():
    xml = syn.caml("Elections.", ["a fee of 1<caml:Fraction><caml:Numerator>1</caml:Numerator><caml:Denominator>2</caml:Denominator></caml:Fraction> percent "
                                  "and a <caml:Fraction><caml:Numerator>2</caml:Numerator><caml:Denominator>3</caml:Denominator></caml:Fraction> vote"])
    assert ca_leginfo.parse_bill_xml(xml)["blocks"][-1] == ["p", "a fee of 1 1/2 percent and a 2/3 vote"]


def test_spacing_elements_are_kept_as_spaces():
    xml = syn.caml("Elections.", ['(a)<xhtml:span class="EnSpace"/>(1)<xhtml:span class="EnSpace"/>If the voter'])
    assert ca_leginfo.parse_bill_xml(xml)["blocks"][-1] == ["p", "(a) (1) If the voter"]


def test_sentences_that_make_the_measure_conditional_are_found():
    blocks = [
        ["p", "This act shall become operative only if Synthetic Constitutional Amendment 8 is approved by the voters."],
        ["p", "Sections 2 and 3 of this act shall become operative only if Synthetic Bill 10 is enacted."],
        ["p", "(a) Sections 1 to 4.1, inclusive, of this act shall become effective only when submitted to and approved by the voters."],
        ["p", "This act shall become operative on January 1, 2027."],
        ["p", "This act shall become operative only if Synthetic Constitutional Amendment 8 is approved by the voters."],
    ]
    assert ca_leginfo.conditions_in(blocks) == [blocks[0][1], blocks[1][1], blocks[2][1]]


def _effective(measure_type="AB", status="Chaptered", chaptered="2026-05-01", vetoed=None, chapter_type="CHP", immediate="NO", conditions=()):
    return ca_leginfo.effective_info(measure_type, status, chaptered, vetoed, chapter_type, {"ImmediateEffect": immediate}, list(conditions))


def test_effective_information_by_kind_of_measure_and_outcome():
    resolution = _effective("ACR", chapter_type="CHR")
    assert (resolution.date, resolution.basis) == (None, "not_applicable") and "not a statute" in resolution.note
    pending_amendment = _effective("ACA", status="In Assembly", chaptered=None)
    assert pending_amendment.basis == "not_enacted" and "voters' approval" in pending_amendment.note
    vetoed = _effective(status="Vetoed", chaptered=None, vetoed="2026-09-30")
    assert (vetoed.date, vetoed.basis) == (None, "not_enacted") and "Vetoed" in vetoed.note
    died = _effective(status="Died", chaptered=None)
    assert died.basis == "not_enacted" and '"Died"' in died.note
    urgent = _effective(immediate="YES")
    assert (urgent.date, urgent.basis) == ("2026-05-01", "immediate_effect_flag")
    ordinary = _effective()
    assert (ordinary.date, ordinary.basis) == (None, "not_verified") and "conditional" not in ordinary.note
    conditional = _effective(conditions=["This act shall become operative only if a synthetic amendment is approved."])
    assert "whether they were met is not recorded here" in conditional.note


def test_history_rows_on_the_same_day_and_sequence_keep_the_order_they_were_recorded(archive):
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))

    def row(history_id, text, status="Applied"):
        out = [None] * 13
        out[0], out[1], out[2], out[3], out[6], out[8], out[9] = syn.A, history_id, "2026-04-01 00:00:00", text, "3", status, "Assembly Floor"
        return out

    history = [row("12", "Read third time. Passed. Ordered to the Senate."), row("9", "Read third time. Refused passage."),
               row("10", "Approved by the Governor.", status="Rescinded")]
    bill, _ = ca_leginfo.build_instrument(archive, selected[syn.A], history, checked_at=CHECKED)
    assert [a.historyId for a in bill.actions] == ["9", "10", "12"]
    rescinded = bill.actions[1]
    assert (rescinded.status, rescinded.significance, rescinded.location) == ("Rescinded", "routine", "Assembly Floor")
    assert bill.approvedDate is None  # an action that was undone does not count
