"""Supreme Court docket adapter, exercised with synthetic dockets and synthetic docket pages."""

import json
import re
import shutil

import pytest

from dhq.adapters import scotus
from dhq.http import FetchError
from dhq.schemas import VerificationStatus

from conftest import SC, FakeResponse, docket_url, qp_url, render_docket_page, synthetic_docket

CHECKED = "2026-06-15T12:00:00Z"


def normalise(payload=None, number="99-0001", **kw):
    return scotus.normalise(number, payload or synthetic_docket(number), checked_at=CHECKED, **kw)


def test_basic_fields_come_straight_from_the_docket():
    case = normalise()
    assert case.id == "scotus-99-0001"
    assert case.docketNumber == "99-0001"
    assert case.caseName == "Synthetic Alpha, et al. v. Synthetic Beta, Secretary of State of Synthetica"
    assert case.dateDocketed == "2026-01-10"
    assert case.lowerCourt.caseNumbers == ["25-9999", "25-9998"]
    assert case.lowerCourt.decisionDate == "2025-10-01"
    assert case.lowerCourt.rehearingDeniedDate is None
    assert case.sourceUrl.startswith("https://www.supremecourt.gov/")
    assert case.questionsPresented.url == qp_url("99-0001")


def test_every_docket_entry_is_kept_as_its_own_dated_event():
    case = normalise()
    assert [(e.date, e.eventType, e.significance, e.classificationRule) for e in case.events] == [
        ("2026-01-05", "initiating_filing", "major", "sc-initiating"),
        ("2026-02-01", "record", "routine", "sc-record"),
        ("2026-02-18", "conference_distribution", "routine", "sc-distributed"),
        ("2026-03-09", "review_denied", "major", "sc-review-denied"),
    ]
    assert case.entryCount == 4
    assert case.dateFirstEntry == "2026-01-05"
    assert case.sourceLastActivity == "2026-03-09"
    assert case.events[3].description == "Petition DENIED."  # the court's words, unchanged


def test_there_is_no_overall_case_status_field():
    fields = set(normalise().model_dump())
    assert not {"status", "caseStatus", "outcome", "isActive", "decided"} & fields
    assert normalise().latestDispositiveEntry.text == "Petition DENIED."


def test_no_ruling_entry_means_none_not_pending():
    entries = [{"Date": "Jan 05 2026", "Text": "Petition for a writ of certiorari filed."}]
    assert normalise(synthetic_docket(entries=entries)).latestDispositiveEntry is None


def test_ruling_on_the_case_outranks_a_later_ruling_on_an_application():
    entries = [
        {"Date": "Jan 05 2026", "Text": "Application (99A1) for a stay, submitted to Justice Synthetic."},
        {"Date": "Mar 01 2026", "Text": "Judgment REVERSED and case REMANDED. Synthetic, J., delivered the opinion of the Court."},
        {"Date": "Mar 20 2026", "Text": "Application (99A2) for a stay of the mandate denied by the Court."},
    ]
    case = normalise(synthetic_docket(entries=entries))
    assert case.latestDispositiveEntry.eventType == "decision"
    assert case.latestDispositiveEntry.date == "2026-03-01"
    assert case.events[2].eventType == "application_ruling"


@pytest.mark.parametrize("text,expected", [
    ("Motion for leave to file amicus brief GRANTED.", "motion_ruling"),
    ("Application (99A5) to extend the time to file a petition, submitted to Justice Synthetic.", "procedural_application"),
    ("Application of Synthetic Alpha, et al. (99A6) to file a brief on the merits in excess of the word limit, submitted to Justice Synthetic.", "procedural_application"),
    ("Petition GRANTED.", "review_granted"),
    ("Argued. For petitioner: Synthetic Counsel.", "argued"),
    ("Brief amici curiae of Synthetic States filed.", "amicus_brief"),
    ("Amici brief of Synthetic Lawyers, et al. filed.", "amicus_brief"),
    ("Consolidated brief of synthetic respondents filed.", "filing"),
    ("Something the rules have never seen.", "docket_entry"),
])
def test_entry_rules(text, expected):
    assert scotus.classify_entry(text)[1] == expected


# Each text below has the shape of a real kind of docket entry; names and numbers are invented.
@pytest.mark.parametrize("text,expected_type,expected_significance,expected_level", [
    # A ruling on an application that opens with a preamble, not with the word "Application".
    ("To permit the losing party time to file a petition for rehearing, the Clerk ordinarily waits 32 days. Sup. Ct. Rule 45.3. "
     "Thus, the application to issue the judgment forthwith presented to Justice Synthetic and by him referred to the Court is granted. "
     "Justice Other dissents. (Detached Opinion)", "application_ruling", "major", "application"),
    ("Application (99A7) denied by the Court.", "application_ruling", "major", "application"),
    ("[See Detached Opinion for full order language.] The application for stay presented to Justice Synthetic and by him referred to the Court is granted.",
     "application_ruling", "major", "application"),
    # The Court writes this in capitals on some dockets and in sentence case on others.
    # An order on whether the Court will hear the case rules on "review", not on an application.
    ("PROBABLE JURISDICTION NOTED.", "review_granted", "major", "review"),
    ("Probable jurisdiction noted.", "review_granted", "major", "review"),
    # Postponing the question of jurisdiction is not noting it.
    ("Further consideration of the question of jurisdiction is POSTPONED to the hearing of the case on the merits.",
     "jurisdiction_postponed", "major", "review"),
    ("Order entered by Justice Synthetic: the order below is hereby administratively stayed.", "interim_order", "major", None),
    ("Order issued by Justice Synthetic: All county boards are hereby ordered to segregate the ballots.", "interim_order", "major", None),
    # Orders in which the Court itself frames or adds a question.
    ("This case is consolidated with No. 99-0002, and a total of one hour is allotted for oral argument. The question presented in these cases is: "
     "Whether the synthetic plan is lawful.", "question_order", "major", None),
    ("Upon consideration of the motion to amend the question presented, the question presented in these cases is amended as follows: Whether a synthetic plan is lawful.",
     "question_order", "major", None),
    ("The parties are directed to file supplemental briefs addressing the following question: Whether a synthetic district is lawful.", "question_order", "major", None),
    ("The parties and the Solicitor General are invited to file supplemental letter briefs addressing the following question.", "question_order", "major", None),
    # What the Court or a Justice does is not a party's filing.
    ("Response to application (99A8) requested by Justice Synthetic, due by 4 p.m. on January 29, 2031.", "response_requested", "routine", None),
    ("Response Requested. (Due October 3, 2031)", "response_requested", "routine", None),
    ("Response to motion from respondent Synthetic Beta filed.", "filing", "routine", None),
    ("Amicus brief of Synthetic Institute not accepted for filing. (To be corrected - January 7, 2031)", "not_accepted", "routine", None),
    ("Motion of Synthetic Person for leave to participate in oral argument not accepted for filing. (February 6, 2031)", "not_accepted", "routine", None),
    ("Motion DISTRIBUTED for Conference of 12/6/2031.", "conference_distribution", "routine", None),
    ("Motion to extend the time to file the joint appendix is extended to and including January 2, 2031.", "motion_ruling", "routine", None),
    ("Motions to extend the time to file a response are granted and the time is extended to and including August 11, 2031.", "motion_ruling", "routine", None),
    ("Motion for divided argument filed by respondents GRANTED.", "motion_ruling", "routine", None),
    # A motion ruling that carries a separate writing, or that concerns the judgment, is a key entry.
    ("Motion to expedite consideration DENIED. Statement of Justice Synthetic. (Detached Opinion)", "motion_ruling", "major", None),
    ("Motion to recall the judgment DENIED.", "motion_ruling", "major", None),
    # An opinion, and dispositions without one.
    ("Judgment REVERSED and case REMANDED. Synthetic, J., delivered the opinion of the Court.", "decision", "major", "case"),
    ("Adjudged to be AFFIRMED. Opinion per curiam.", "decision", "major", "case"),
    ("Adjudged to be AFFIRMED.", "summary_disposition", "major", "case"),
    ("Judgment VACATED and case REMANDED for further consideration in light of Synthetic v. Example, 600 U. S. ___ (2031).", "summary_disposition", "major", "case"),
    ("Petition GRANTED. Judgment VACATED and case REMANDED.", "summary_disposition", "major", "case"),
    ("Appeal dismissed for want of jurisdiction.", "dismissed", "major", "case"),
    # A rehearing ruling follows the disposition and must not replace it.
    ("Rehearing DENIED.", "rehearing_ruling", "major", None),
    ("Petition for Rehearing DENIED.", "rehearing_ruling", "major", None),
    ("Petition for rehearing filed.", "filing", "routine", None),
    # Notices that schedule or consolidate.
    ("Because the Court has consolidated these cases for briefing and oral argument, future filings will be reflected on the docket of No. 99-0001.",
     "scheduling_notice", "routine", None),
    ("Waiver of the 14-day waiting period for the distribution of the petition filed by petitioner.", "record", "routine", None),
])
def test_entry_rules_tell_court_actions_from_filings(text, expected_type, expected_significance, expected_level):
    _rule, event_type, significance, level = scotus.classify_entry(text)
    assert (event_type, significance, level) == (expected_type, expected_significance, expected_level)


def test_every_rule_id_is_unique_and_every_pattern_compiles():
    ids = [rule[0] for rule in scotus.EVENT_RULES]
    assert len(ids) == len(set(ids))
    assert "sc-other" not in ids


def test_a_rehearing_denial_does_not_replace_the_decision_as_the_latest_disposition():
    entries = [
        {"Date": "Mar 01 2026", "Text": "Judgment REVERSED and case REMANDED. Synthetic, J., delivered the opinion of the Court."},
        {"Date": "Apr 20 2026", "Text": "Rehearing DENIED."},
    ]
    case = normalise(synthetic_docket(entries=entries))
    assert case.latestDispositiveEntry.eventType == "decision"
    assert case.latestDispositiveEntry.date == "2026-03-01"
    assert case.events[1].eventType == "rehearing_ruling"


def test_an_application_ruling_with_a_preamble_is_the_latest_ruling_on_an_application_docket():
    entries = [
        {"Date": "Apr 29 2026", "Text": "Application (99A9) of Synthetic Alpha, et al. to issue the judgment forthwith, submitted to Justice Synthetic."},
        {"Date": "May 04 2026", "Text": "To permit the losing party time to file a petition for rehearing, the Clerk waits 32 days. "
                                        "Thus, the application to issue the judgment forthwith presented to Justice Synthetic and by him referred to the Court is granted."},
    ]
    case = normalise(synthetic_docket("99A9", entries=entries, sJsonCaseType="Application"), number="99A9")
    assert case.latestDispositiveEntry.eventType == "application_ruling"
    assert case.latestDispositiveEntry.date == "2026-05-04"


def test_unrecognised_entries_are_routine_and_labelled_as_unclassified():
    assert scotus.classify_entry("Something the rules have never seen.") == ("sc-other", "docket_entry", "routine", None)


def test_only_documents_hosted_by_the_court_are_linked():
    case = normalise()
    assert [d.url for d in case.documents] == [f"{SC}/DocketPDF/99/99-0001/1/petition.pdf"]
    assert case.documentCount == 1
    assert case.documents[0].availability == "public_link"
    assert case.events[0].documentIds == [case.documents[0].id]


def test_markup_on_the_docket_never_reaches_the_published_text():
    entries = [{"Date": "Mar 01 2026",
                "Text": "Judgment AFFIRMED. <script>alert(1)</script><a href='https://www.supremecourt.gov/opinions/25pdf/99-0001_x.pdf'>Opinion</a> &amp; <b>order</b>."}]
    case = normalise(synthetic_docket(entries=entries, PetitionerTitle="<i>Synthetic</i> Alpha, Petitioner"))
    dumped = json.dumps(case.model_dump(mode="json"))
    assert "<script" not in dumped and "<b>" not in dumped and "<i>" not in dumped
    assert case.events[0].description == "Judgment AFFIRMED. alert(1)Opinion & order."
    assert [d.documentType for d in case.documents] == ["Opinion"]
    assert case.petitionerTitle == "Synthetic Alpha, Petitioner"


def test_a_javascript_or_foreign_link_in_an_entry_is_dropped():
    entries = [{"Date": "Mar 01 2026", "Text": "Order. <a href='javascript:alert(1)'>x</a> <a href='https://evil.example.test/opinions/x.pdf'>Opinion</a>"}]
    assert normalise(synthetic_docket(entries=entries)).documents == []


def test_counsel_contact_details_are_never_copied():
    dumped = json.dumps(normalise().model_dump(mode="json"))
    for private in ("555-0100", "counsel@example.test", "1 Synthetic Plaza", "Synthetic Counsel", "Synthetic Firm"):
        assert private not in dumped


def test_a_payload_for_a_different_docket_is_rejected():
    with pytest.raises(ValueError, match="docket mismatch"):
        scotus.normalise("99-0002", synthetic_docket("99-0001"), checked_at=CHECKED)


def test_an_unreadable_date_is_an_error_not_a_guess():
    with pytest.raises(ValueError, match="unrecognised date"):
        normalise(synthetic_docket(entries=[{"Date": "sometime in March", "Text": "Petition DENIED."}]))
    assert scotus.parse_date("") is None
    assert scotus.parse_date("Mar 09 2026") == "2026-03-09"
    assert scotus.parse_date("March 9, 2026") == "2026-03-09"


def test_entries_without_text_or_date_are_skipped_not_invented():
    entries = [{"Date": "", "Text": "Petition DENIED."}, {"Date": "Mar 09 2026", "Text": "  "}, {"Date": "Mar 10 2026", "Text": "Rehearing DENIED."}]
    case = normalise(synthetic_docket(entries=entries))
    assert [e.description for e in case.events] == ["Rehearing DENIED."]


def test_verification_and_timestamps_are_separate():
    case = scotus.normalise("99-0001", synthetic_docket(), checked_at=CHECKED, first_observed="2026-01-11T00:00:00Z")
    assert case.verification.status == VerificationStatus.VERIFIED_PRIMARY
    assert case.verification.method == "automated_primary_retrieval"
    assert "Not reviewed by a lawyer" in case.verification.note
    assert case.firstObservedAt == "2026-01-11T00:00:00Z"
    assert case.lastCheckedAt == CHECKED
    assert case.sourcePublishedAt == "2026-06-01"
    assert case.sourceLastActivity == "2026-03-09"


def test_content_hash_ignores_when_we_looked_and_changes_when_the_docket_does():
    a = scotus.normalise("99-0001", synthetic_docket(), checked_at="2026-06-15T12:00:00Z")
    b = scotus.normalise("99-0001", synthetic_docket(), checked_at="2026-06-16T12:00:00Z")
    assert a.contentHash == b.contentHash
    longer = synthetic_docket()
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    assert scotus.normalise("99-0001", longer, checked_at=CHECKED).contentHash != a.contentHash


def test_questions_presented_text_is_hashed_when_available():
    case = normalise(qp_text="Whether a synthetic question is presented.")
    assert case.questionsPresented.text == "Whether a synthetic question is presented."
    assert len(case.questionsPresented.textHash) == 64
    assert normalise(synthetic_docket(qp=False)).questionsPresented is None


# stage_scotus reads each docket through fetch_payload; its document requests are tested in test_run.py.

def test_fetch_rejects_the_page_the_site_returns_for_an_unknown_docket(fetcher, session):
    session.on(docket_url("99-0404"), FakeResponse(200, b"<!DOCTYPE html><html>File not found</html>"))
    with pytest.raises(FetchError, match="layout not recognised"):
        scotus.fetch_payload(fetcher, "99-0404")


def test_fetch_rejects_a_page_for_a_different_docket(fetcher, session):
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0777")))
    with pytest.raises(FetchError, match="the page is for 99-0777"):
        scotus.fetch_payload(fetcher, "99-0001")


# --- the page reader ------------------------------------------------------------------

def test_the_page_reader_returns_what_the_page_shows():
    source = synthetic_docket(
        "99-0001", Links="Linked with 99A1, 99A2", LowerCourtRehearingDenied="November 3, 2025",
        RelatedCaseNumber=[{"RelatedType": "Vide", "DisplayCaseNumber": "99-0002"}])
    parsed = scotus.parse_docket_page(render_docket_page(source))
    for key in ("CaseNumber", "sJsonCaseType", "sJsonCreationDate", "PetitionerTitle", "RespondentTitle", "DocketedDate", "Links",
                "LowerCourt", "LowerCourtCaseNumbers", "LowerCourtDecision", "LowerCourtRehearingDenied", "QPLink", "RelatedCaseNumber"):
        assert parsed[key] == source[key], key
    assert [(e["Date"], e["Text"]) for e in parsed["ProceedingsandOrder"]] == [(e["Date"], e["Text"]) for e in source["ProceedingsandOrder"]]


def test_the_page_reader_keeps_filing_links_with_the_entry_they_belong_to():
    parsed = scotus.parse_docket_page(render_docket_page(synthetic_docket()))
    first, second = parsed["ProceedingsandOrder"][0], parsed["ProceedingsandOrder"][1]
    assert [(link["Description"], link["DocumentUrl"]) for link in first["Links"]] == [
        ("Petition", f"{SC}/DocketPDF/99/99-0001/1/petition.pdf"), ("Proof of Service", "https://files.example.test/pos.pdf")]
    assert second["Links"] == []


def test_a_document_is_named_from_its_address_without_the_upload_stamp():
    entries = [{"Date": "Jan 05 2026", "Text": "Petition for a writ of certiorari filed.",
                "Links": [{"Description": "Main Document", "DocumentUrl": f"{SC}/DocketPDF/99/99-0001/1/20260105101010123_Synthetic%20Petition%20-%20Final.pdf"}]}]
    parsed = scotus.parse_docket_page(render_docket_page(synthetic_docket(entries=entries)))
    assert parsed["ProceedingsandOrder"][0]["Links"][0]["File"] == "Synthetic Petition - Final.pdf"
    case = normalise(parsed)
    assert (case.documents[0].title, case.documents[0].documentType) == ("Synthetic Petition - Final.pdf", "Main Document")


def test_a_docket_read_from_its_page_equals_the_same_docket_given_directly():
    source = synthetic_docket()
    for entry in source["ProceedingsandOrder"]:
        for link in entry.get("Links") or []:
            link["File"] = scotus._file_name(link["DocumentUrl"])
    from_page = normalise(scotus.parse_docket_page(render_docket_page(source)))
    direct = normalise(source)
    assert from_page.model_dump(mode="json") == direct.model_dump(mode="json")


def test_the_page_reader_does_not_depend_on_the_order_of_attributes():
    opinion = f"{SC}/opinions/25pdf/99-0001_x.pdf"
    source = synthetic_docket()
    source["ProceedingsandOrder"].append({"Date": "Mar 20 2026", "Text": f"Judgment AFFIRMED. <a href='{opinion}'>Opinion</a>"})
    page = render_docket_page(source)
    changed = re.sub(r'<a  href= (\S+)\s+class="documentanchor"', r'<a class="documentanchor" href="\1"', page)
    changed = changed.replace('<a href="../qp/99-0001qp.pdf">Questions Presented</a>', '<a href="../qp/99-0001qp.pdf" target="_blank">Questions Presented</a>')
    changed = changed.replace(f"<a href='{opinion}'>", f"<a target='_blank' href='{opinion}'>")
    assert changed.count('<a class="documentanchor" href=') == 2 and 'target="_blank">Questions Presented' in changed
    parsed = scotus.parse_docket_page(changed)
    assert parsed["QPLink"] == "../qp/99-0001qp.pdf"
    assert [link["DocumentUrl"] for link in parsed["ProceedingsandOrder"][0]["Links"]] == [
        f"{SC}/DocketPDF/99/99-0001/1/petition.pdf", "https://files.example.test/pos.pdf"]
    assert [d.url for d in normalise(parsed).documents] == [f"{SC}/DocketPDF/99/99-0001/1/petition.pdf", opinion]


def test_a_document_that_cannot_be_read_is_an_error_not_a_document_without_text(monkeypatch):
    with pytest.raises(scotus.PdfTextError, match="not a PDF"):
        scotus.extract_pdf_text(b"<html><body>Service temporarily unavailable</body></html>")
    if shutil.which("pdftotext"):
        with pytest.raises(scotus.PdfTextError, match="exited with status"):
            scotus.extract_pdf_text(b"%PDF-1.4 synthetic bytes that are not a whole PDF")
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(scotus.PdfTextError, match="not installed"):
        scotus.extract_pdf_text(b"%PDF-1.4 synthetic")


@pytest.mark.parametrize("broken", [
    lambda page: page.replace('<table id="docketinfo"', '<table id="something-else"'),
    lambda page: page.replace('id="proceedings"', 'id="renamed"'),
    lambda page: page.replace('class="ProceedingItem"', 'class="Renamed"'),
    lambda page: page.replace('class="ProceedingDate"', 'class="Renamed"'),
    lambda page: page.replace('<span class="DocketInfoTitle">No. ', '<span class="DocketInfoTitle">'),
])
def test_a_changed_page_layout_is_an_error_not_an_empty_docket(broken):
    with pytest.raises(scotus.DocketPageError):
        scotus.parse_docket_page(broken(render_docket_page(synthetic_docket())))


def test_counsel_contact_details_on_the_page_are_never_copied():
    page = render_docket_page(synthetic_docket())
    assert "counsel@example.test" in page and "555-0100" in page  # they are on the page
    dumped = json.dumps(normalise(scotus.parse_docket_page(page)).model_dump(mode="json"))
    for private in ("555-0100", "counsel@example.test", "1 Synthetic Plaza", "Synthetic Counsel"):
        assert private not in dumped


def test_a_stray_bracket_left_by_the_courts_markup_is_dropped():
    entries = [{"Date": "Dec 04 2025", "Text": "Application granted. Justice Synthetic concurs. "
                                               "(Detached <a href = 'https://www.supremecourt.gov/opinions/25pdf/99a1_x.pdf#page=4'>>Opinion</a>)"}]
    case = normalise(synthetic_docket(entries=entries))
    assert case.events[0].description.endswith("(Detached Opinion)")
    assert case.documents[0].title == "Opinion (linked in docket entry)"
