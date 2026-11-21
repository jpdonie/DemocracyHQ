"""Pipeline fixes from the final review (group PIPE). SYNTHETIC test data unless a test says otherwise.

The short passages quoted from the Court's opinion in No. 25A608 (Abbott v. League of United Latin American
Citizens) are U.S. Government works; they are used to test the hyphen join on the line breaks that PDF has.
"""

import json
import re
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

import dhq.run as pipeline
from dhq import classify
from dhq.adapters import ca_leginfo, congress, scotus
from dhq.evidence import find_passage
from dhq.http import Fetcher
from dhq.schemas import CaBillId, LawVersion, LegislativeInstrument, LegislativeInstrumentSummary, Verification
from dhq.sources import SOURCES
from dhq.util import write_json

import synthetic_ca as syn
from conftest import SC, FakeResponse, docket_url, make_zip, qp_url, synthetic_docket
from test_run import COURT, LAWS, NAMES_MEASURE, SEED_LINK, CASE_LINK, T1, env  # noqa: F401 - env is a fixture

SEEDS = Path(__file__).resolve().parents[1] / "seeds"
CHECKED = "2026-06-15T12:00:00Z"


# --- W7: the Assembly's Joint Rule 56 filing is clerical, not a second death ------------------------------------

@pytest.fixture
def archive(session, tmp_path):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    return ca_leginfo.CaliforniaArchive(Fetcher(session=session, retries=0, sleep=lambda s: None), 2025, cache=tmp_path / "cache")


def history(bill_id, *entries):
    rows = []
    for n, (date, text) in enumerate(entries, start=1):
        out = [None] * 13
        out[0], out[1], out[2], out[3], out[6], out[8], out[9] = bill_id, str(n), f"{date} 00:00:00", text, str(n), "Applied", "Assembly"
        rows.append(out)
    return rows


def build(archive, bill_id, rows):
    selected = ca_leginfo.select_bills(archive.table("BILL_TBL.dat"), archive.table("BILL_VERSION_TBL.dat"))
    return ca_leginfo.build_instrument(archive, selected[bill_id], rows, checked_at=CHECKED)[0]


def test_an_assembly_bill_that_died_has_one_key_died_action(archive):
    bill = build(archive, syn.A, history(
        syn.A, ("2026-01-06", "Read first time. To print."),
        ("2026-02-02", "From committee: Filed with the Chief Clerk pursuant to Joint Rule 56."),
        ("2026-02-02", "Died pursuant to Art. IV, Sec. 10(c) of the Constitution."),
    ))
    died = [a for a in bill.actions if a.eventType == "died"]
    assert [a.text for a in died] == ["Died pursuant to Art. IV, Sec. 10(c) of the Constitution."]
    filing = next(a for a in bill.actions if "Chief Clerk" in a.text)
    assert (filing.classificationRule, filing.eventType, filing.significance) == ("ca-committee", "committee_action", "routine")
    # The Senate records no separate death entry: its Joint Rule 56 return is the death.
    assert ca_leginfo.classify_action("Returned to Secretary of Senate pursuant to Joint Rule 56.") == ("ca-died", "died", "major")


# --- C7 / W22: a veto is final only when the history says so ----------------------------------------------------

OVERRIDE_NOTE = ("Vetoed by the Governor. A vetoed bill is not enacted unless the Legislature overrides the veto "
                 "(Cal. Const. art. IV, § 10(a)); no override is recorded in the data as of the last check. It has no effective date.")


def test_a_vetoed_bill_is_described_as_open_to_override_until_the_history_records_the_veto_stands():
    info = ca_leginfo.effective_info("AB", "Vetoed", None, "2026-09-30", None, {}, [])
    assert (info.date, info.basis, info.note) == (None, "not_enacted", OVERRIDE_NOTE)
    stands = ca_leginfo.effective_info("AB", "Vetoed", None, "2026-01-12", None, {}, [], "2026-01-22")
    assert stands.basis == "not_enacted" and stands.date is None
    assert stands.note == ("Vetoed by the Governor. The official history records on January 22, 2026, that the veto stands, "
                           "so the bill was not enacted. It has no effective date.")


@pytest.mark.parametrize("closing", ["Veto sustained.", "Consideration of Governor's veto stricken from file."])
def test_the_history_entry_that_ends_a_veto_is_read_into_the_effective_date_note(archive, closing):
    vetoed = [("2026-01-06", "Read first time. To print."), ("2026-09-30", "Vetoed by Governor.")]
    assert build(archive, syn.A, history(syn.A, *vetoed)).effective.note == OVERRIDE_NOTE
    bill = build(archive, syn.A, history(syn.A, *vetoed, ("2026-11-10", closing)))
    assert bill.vetoedDate == "2026-09-30"
    assert "records on November 10, 2026, that the veto stands" in bill.effective.note
    # An entry that would end a veto means nothing before there is one.
    early = build(archive, syn.A, history(syn.A, ("2026-01-02", closing), *vetoed))
    assert early.effective.note == OVERRIDE_NOTE


# --- C2 / W3 / DL15: an order on whether to hear a case is never the docket's ruling ----------------------------

def normalise(entries, number="99-0001", **kw):
    return scotus.normalise(number, synthetic_docket(number, entries=entries, **kw), checked_at=CHECKED)


@pytest.mark.parametrize("text", ["Petition GRANTED.", "PROBABLE JURISDICTION NOTED.",
                                  "Further consideration of the question of jurisdiction is postponed to the hearing of the case on the merits."])
def test_a_grant_of_review_disposes_of_nothing(text):
    assert scotus.classify_entry(text)[3] == "review"
    case = normalise([{"Date": "Jan 05 2026", "Text": "Petition for a writ of certiorari filed."}, {"Date": "Feb 20 2026", "Text": text}])
    assert case.latestDispositiveEntry is None


def test_a_later_grant_of_review_does_not_replace_a_ruling_on_an_application():
    case = normalise([
        {"Date": "Jan 05 2026", "Text": "Application (99A1) for a stay, submitted to Justice Synthetic."},
        {"Date": "Jan 20 2026", "Text": "Application (99A1) granted by the Court."},
        {"Date": "Feb 20 2026", "Text": "Petition GRANTED."},
    ])
    assert (case.latestDispositiveEntry.eventType, case.latestDispositiveEntry.date) == ("application_ruling", "2026-01-20")
    assert case.events[2].eventType == "review_granted"


def test_the_published_rules_say_what_each_entry_rules_on(env):
    env.run(COURT)
    rules_on = {r["ruleId"]: r["rulesOn"] for r in env.read("classification.json")["docketEntryRules"]}
    assert rules_on["sc-review-granted"] == rules_on["sc-jurisdiction-postponed"] == "review"
    assert rules_on["sc-review-denied"] == "case" and rules_on["sc-app-ruling"] == "application"
    assert set(scotus.DISPOSITIVE_LEVELS) == {"case", "application"}


def test_the_ruling_is_chosen_only_from_the_dispositive_levels_in_their_order(monkeypatch):
    entries = [{"Date": "Jan 05 2026", "Text": "Application (99A1) for a stay, submitted to Justice Synthetic."},
               {"Date": "Jan 20 2026", "Text": "Application (99A1) granted by the Court."},
               {"Date": "Mar 02 2026", "Text": "Petition DENIED."},
               {"Date": "Apr 20 2026", "Text": "Petition GRANTED."}]
    assert normalise(entries).latestDispositiveEntry.eventType == "review_denied"
    monkeypatch.setattr(scotus, "DISPOSITIVE_LEVELS", ("application", "case"))
    assert normalise(entries).latestDispositiveEntry.eventType == "application_ruling"
    monkeypatch.setattr(scotus, "DISPOSITIVE_LEVELS", ("review",))
    assert normalise(entries).latestDispositiveEntry.eventType == "review_granted"


# --- C1 / W20: curated links say they are curated ---------------------------------------------------------------

def test_curated_links_carry_the_maintainer_curated_method(env):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE]})
    env.run(COURT)
    rels = {r["id"]: r for r in env.read("relationships.json")["relationships"]}
    assert rels[CASE_LINK]["verification"]["method"] == "maintainer_curated"
    assert rels[SEED_LINK]["verification"]["method"] == "maintainer_curated"


def test_links_published_before_the_new_method_still_validate():
    assert Verification(status="verified_primary", method="rule_derived", checkedAt=T1).method == "rule_derived"
    assert Verification(status="verified_primary", method="maintainer_curated", checkedAt=T1).method == "maintainer_curated"
    with pytest.raises(ValidationError):
        Verification(status="verified_primary", method="curated_by_hand", checkedAt=T1)


# --- C6: the Sources page says what happens to a dead opinion link -----------------------------------------------

def test_the_source_status_says_dead_links_are_shown_as_text(env, session):
    dead = f"{SC}/opinions/25pdf/99-0001_dead.pdf"
    docket = synthetic_docket("99-0001")
    docket["ProceedingsandOrder"].append({"Date": "Mar 20 2026", "Text": f"Judgment AFFIRMED. <a href='{dead}'>Opinion</a>"})
    session.on(docket_url("99-0001"), FakeResponse(200, docket))
    session.on("HEAD " + dead, FakeResponse(404))
    env.run(COURT)
    detail = env.source("scotus-docket")["statusDetail"]
    assert "1 opinion or order link(s) given on the Court's dockets answered not found when checked" in detail
    assert "published as unavailable, with the date of the check" in detail
    assert "show their addresses as text, not as links" in detail
    assert "marked unavailable" not in detail


# --- C4: a bill id names a file, so its parts are checked before anything is written ----------------------------

#: The reviewer's row: the measure_num column of BILL_TBL holds a path that climbs out of the staging folder.
TRAVERSAL_BILL, TRAVERSAL_NUM = "202520260AB9", "1/../../../../../escaped"


def archive_with(bill_cells):
    m = syn.members()
    cells = {0: TRAVERSAL_BILL, 1: "20252026", 2: "0", 3: "AB", 4: "9", 5: "Introduced", 11: "Y", 16: "Assembly", 17: "x", **bill_cells}
    m["BILL_TBL.dat"] += (syn.row(20, cells) + "\n").encode()
    m["BILL_VERSION_TBL.dat"] += (syn.row(17, {0: "20250AB999INT", 1: TRAVERSAL_BILL, 2: "99", 3: "2026-01-06 00:00:00", 4: "Introduced",
                                               6: "Elections: x.", 14: None, 15: "Y"}) + "\n").encode()
    m["BILL_HISTORY_TBL.dat"] += (syn.row(12, {0: TRAVERSAL_BILL, 2: "2026-01-06 00:00:00", 3: "Read first time. To print.", 6: "1"}) + "\n").encode()
    return make_zip(m)


@pytest.mark.parametrize("cells, part", [
    ({4: TRAVERSAL_NUM}, f"measure number {TRAVERSAL_NUM!r}"),
    ({1: "2025/../../../../escaped"}, "session year '2025/../../../../escaped'"),
    ({3: "AB/../../../../escaped/"}, "measure type 'AB/../../../../escaped/'"),
    ({4: None}, "measure number None"),
])
def test_a_bill_table_row_with_a_malformed_id_part_is_refused_and_the_run_carries_on(env, session, tmp_path, cells, part):
    session.serve_bytes(syn.ARCHIVE_URL, archive_with(cells))
    code, ctx = env.run(LAWS)
    assert code == 0
    failed = [r for r in ctx.review if r["kind"] == "bill_failed"]
    assert [r["entity"] for r in failed] == [f"BILL_TBL row '{TRAVERSAL_BILL}'"]
    assert part in failed[0]["detail"] and "no id or file is made from it" in failed[0]["detail"]
    # Nothing was written for the row, inside or outside the sandbox's folders.
    assert not list(tmp_path.rglob("escaped*"))
    assert not [p for p in tmp_path.rglob("*") if p.is_dir() and p.name.startswith("ca-")]
    index = env.read("legislation/index.json")
    assert sorted(b["identifier"] for b in index["bills"]) == ["AB 1", "AB 5", "ACA 3"]
    assert all(re.fullmatch(ca_leginfo.BILL_ID_PATTERN, b["id"]) for b in index["bills"])
    assert sorted(p.name for p in (env.public / "legislation" / "bills").iterdir()) == [
        "ca-20252026-ab1.json", "ca-20252026-ab5.json", "ca-20252026-aca3.json"]
    assert env.source("ca-leginfo-bulk")["statusDetail"].startswith("1 of 4 bills could not be rebuilt")


def test_instrument_id_checks_each_part():
    assert ca_leginfo.instrument_id([syn.A, "20252026", "0", "ACA", "15"]) == "ca-20252026-aca15"
    for bad in (["x", "20252026", "0", "ab", "1"], ["x", "2025", "0", "AB", "1"], ["x", "20252026", "0", "AB", "123456"],
                ["x", "20252026", "0", "ABCD", "1"], ["x", "20252026", "0", "AB", "1 "], ["x"]):
        with pytest.raises(ca_leginfo.BillIdError):
            ca_leginfo.instrument_id(bad)


def test_the_schemas_refuse_a_bill_id_of_another_shape(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS)
    bill = env.read("legislation/bills/ca-20252026-ab1.json")
    bill.pop("selection")
    LegislativeInstrument(**bill)
    for bad in (f"ca-20252026-ab{TRAVERSAL_NUM}", "ca-2025-ab1", "CA-20252026-AB1", "ca-20252026-ab123456", "ca-20252026-ab1.json"):
        with pytest.raises(ValidationError):
            LegislativeInstrument(**{**bill, "id": bad})
        with pytest.raises(ValidationError):
            TypeAdapter(CaBillId).validate_python(bad)
    with pytest.raises(ValidationError):
        LawVersion(**{**bill["versions"][0], "instrumentId": f"ca-20252026-ab{TRAVERSAL_NUM}"})
    # The summary model also carries the secondary (Open States) bills, whose ids have another form.
    summary = {k: v for k, v in bill.items() if k in LegislativeInstrumentSummary.model_fields}
    assert LegislativeInstrumentSummary(**{**summary, "id": "os-ocd-bill-synthetic"}).id == "os-ocd-bill-synthetic"


def test_validation_refuses_a_staged_index_that_lists_a_bill_id_of_another_shape(tmp_path):
    ctx = pipeline.Context(public=tmp_path / "public", staging=tmp_path / "staging", cache=tmp_path / "cache")
    write_json(ctx.staging / "legislation" / "index.json", {"bills": [{"id": f"ca-20252026-ab{TRAVERSAL_NUM}"}]})
    with pytest.raises(RuntimeError, match="does not have the form"):
        pipeline.stage_validate(ctx)


# --- DL10: the selection's denominator counts regular-session measures only ------------------------------------

def test_the_session_total_leaves_out_extraordinary_session_measures(env, session):
    m = syn.members()
    m["BILL_TBL.dat"] += (syn.row(20, {0: "202520261AB1", 1: "20252026", 2: "1", 3: "AB", 4: "1", 5: "Introduced", 11: "Y"}) + "\n").encode()
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(m))
    env.run(LAWS)
    assert env.read("legislation/index.json")["selection"]["totalBillsInSession"] == 5
    assert ca_leginfo.regular_session_count([["a", "20252026", "0"], ["b", "20252026", "1"], ["c", "20252026", None]]) == 2


# --- C3 / DL9: repeal dates are quoted beside the effective date ------------------------------------------------

@pytest.mark.parametrize("sentence, date", [
    ("This section shall remain in effect only until January 1, 2030, and as of that date is repealed.", "2030-01-01"),
    ("This chapter shall remain in effect only until January 1, 2031, and as of that date is repealed, unless a later enacted "
     "statute that is enacted before January 1, 2031, deletes or extends that date.", "2031-01-01"),
    ("Sections 2 and 3 of this act shall remain in effect only until December 31, 2029, and as of that date are repealed.", "2029-12-31"),
    ("This section shall remain in effect only until the effective date of Senate Constitutional Amendment 3 of the 2025–26 "
     "Regular Session, and as of that date is repealed.", None),
    ("This section shall remain in effect only until February 30, 2030, and as of that date is repealed.", None),
])
def test_a_sunset_sentence_is_quoted_whole_with_its_date_when_it_states_one(sentence, date):
    blocks = [["p", f"(a) The synthetic duty applies. {sentence} (c) Another synthetic subdivision."]]
    assert ca_leginfo.expiry_clauses_in(blocks) == [(sentence, date)]


def test_sentences_that_are_not_sunsets_are_left_out_and_a_repeated_one_is_quoted_once():
    sunset = "This section shall remain in effect only until January 1, 2030, and as of that date is repealed."
    blocks = [["p", "This section shall remain in effect regardless of any other law."], ["p", sunset], ["p", sunset],
              ["p", "Section 99 of the Elections Code is repealed."]]
    assert ca_leginfo.expiry_clauses_in(blocks) == [(sunset, "2030-01-01")]


def test_a_bill_carries_the_sunset_sentences_of_its_latest_mirrored_text(env, session):
    sunset = "This section shall remain in effect only until January 1, 2030, and as of that date is repealed."
    m = syn.members()
    m["lob/a97.lob"] = syn.caml("Elections: synthetic ballots.", [syn.P1_AMENDED, syn.P2, sunset], version_id="20250AB197CHP")
    m["lob/a99.lob"] = syn.caml("Elections: synthetic ballots.", [syn.P1, syn.P2, sunset.replace("2030", "2028")], version_id="20250AB199INT")
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(m))
    code, _ = env.run(LAWS)
    assert code == 0
    bill = env.read("legislation/bills/ca-20252026-ab1.json")
    assert bill["expiryClauses"] == [{"text": sunset, "versionId": "20250AB197CHP", "ruleId": "ca-sunset-1", "date": "2030-01-01"}]
    assert env.read("legislation/bills/ca-20252026-ab5.json")["expiryClauses"] == []
    other = {r["ruleId"]: r for r in env.read("classification.json")["otherRules"]}
    assert ca_leginfo.SUNSET_PATTERN.pattern in other["ca-sunset-1"]["description"]
    # The pattern takes the sentence with or without "only"; the description says so.
    assert "shall remain in effect until, or only until, a date or an event" in other["ca-sunset-1"]["description"]
    without_only = "This section shall remain in effect until January 1, 2029, and as of that date is repealed."
    assert ca_leginfo.expiry_clauses_in([["p", without_only]]) == [(without_only, "2029-01-01")]


# --- DL6: one case below, written two ways --------------------------------------------------------------------

@pytest.mark.parametrize("a, b, same", [
    ("3:21-cv-00259-DCG-JES-JVB", "EP-21-CV-00259-DCG-JES-JVB", True),  # division number and office letters, same panel
    ("3:21-cv-00259", "EP-21-CV-00259", False),  # ... but without the judges' initials they cannot be matched
    ("3:21-cv-00259-ABC", "21-cv-259-abc", True),
    ("3:21-cv-00259", "21-cv-259", False),
    ("21-cv-259", "2021-CV-00259", True),
    ("3:21-cv-259", "3:21-cv-00259-ABC", True),
    ("3:21-cv-259-ABC", "3:21-cv-259-XYZ", False),
    ("1:21-cv-00259-ABC", "3:21-cv-00259-ABC", False),  # two divisions number their cases separately
    ("SA-21-CV-00259-ABC", "EP-21-CV-00259-ABC", False),
    ("21-cv-259", "21-cr-259", False),
    ("21-cv-259", "22-cv-259", False),
    ("25-9999", "25-9999", True),  # a court of appeals number must agree exactly
    ("25-9999", "25-09999", False),
    ("No. 25-9999", "25-9999", False),
])
def test_lower_court_numbers_are_compared_after_setting_aside_their_spelling(a, b, same):
    assert pipeline.same_lower_court_number(a, b) is same
    assert pipeline.same_lower_court_number(b, a) is same


def lower(docket, court, *numbers):
    return {"id": f"scotus-{docket}", "docketNumber": docket, "caseName": f"Synthetic {docket}",
            "lowerCourt": {"name": court, "caseNumbers": list(numbers)}}


def test_dockets_whose_numbers_below_are_spelled_differently_are_paired_in_the_same_court_only():
    court = "United States District Court for the Western District of Synthetica"
    records = [lower("99A1", court, "3:21-cv-00259-ABC-DEF-GHI"), lower("99-0002", court.upper(), "EP-21-CV-00259-ABC-DEF-GHI"),
               lower("99-0003", "United States District Court for the Eastern District of Synthetica", "3:21-cv-00259"),
               lower("99-0004", court, "1:21-cv-00259")]
    pipeline._same_lower_court(records)
    by_id = {r["docketNumber"]: r["sameLowerCourt"] for r in records}
    assert by_id["99A1"] == [{"caseId": "scotus-99-0002", "docket": "99-0002", "caseName": "Synthetic 99-0002", "number": "EP-21-CV-00259-ABC-DEF-GHI"}]
    assert by_id["99-0002"] == [{"caseId": "scotus-99A1", "docket": "99A1", "caseName": "Synthetic 99A1", "number": "3:21-cv-00259-ABC-DEF-GHI"}]
    assert by_id["99-0003"] == by_id["99-0004"] == []
    rules = {r["ruleId"] for r in pipeline.OTHER_RULES}
    assert "same-lower-court-2" in rules and "same-lower-court-1" not in rules


# --- DL8: campaign-finance phrases and existing-law mentions do not tag a bill --------------------------------

DIGEST = "Legislative Counsel's digest"


def tags(*fields):
    return {t.tag for t in classify.classify(fields)}


@pytest.mark.parametrize("text", [
    "Existing law, the Political Reform Act of 1974, regulates committees that support or oppose candidates and ballot measures.",
    "This bill would require a ballot measure committee to file a synthetic report.",
    "This bill would prohibit any committee for or against any initiative or referendum measure from accepting a synthetic payment.",
    "This bill would apply to a payment made in opposition to a ballot measure or a candidate for office.",
])
def test_campaign_finance_phrases_about_ballot_measures_are_not_direct_democracy(text):
    assert "direct-democracy" not in tags((DIGEST, text, classify.DIGEST))
    assert "direct-democracy" not in tags(("official subject line", text))


def test_a_digest_that_says_an_amended_act_was_adopted_by_initiative_is_not_direct_democracy():
    text = ("Existing law, the Political Reform Act of 1974, regulates synthetic campaigns. The act is an initiative measure that "
            "authorizes the Legislature to amend its provisions by a 2/3 vote of each house. The Voters FIRST Act, an initiative "
            "measure approved by the electors as Proposition 11, establishes a synthetic commission. This bill would amend the act.")
    assert "direct-democracy" not in tags((DIGEST, text, classify.DIGEST))
    assert "direct-democracy" in tags((DIGEST, text + " The bill would also change the signature deadline for an initiative petition.",
                                       classify.DIGEST))


def test_a_bill_about_ballot_measures_themselves_is_still_tagged():
    assert "direct-democracy" in tags((DIGEST, "This bill would change how the title and summary of a ballot measure is prepared.", classify.DIGEST))
    text = "This bill would apply to committees that support candidates. It would also change the deadline to qualify a ballot measure."
    assert "direct-democracy" in tags((DIGEST, text, classify.DIGEST))


def test_a_digest_names_the_federal_voting_rights_act_as_the_bills_subject_only_in_what_the_bill_would_do():
    existing = ("Existing federal law, the Voting Rights Act of 1965, prohibits a voting qualification that results in a denial of "
                "the right to vote on account of race. This bill would change the synthetic notice period.")
    assert "voting-rights-act" not in tags((DIGEST, existing, classify.DIGEST))
    proposal = existing + " The bill would require a county to comply with Section 2 of the federal Voting Rights Act of 1965."
    assert "voting-rights-act" in tags((DIGEST, proposal, classify.DIGEST))
    # A subject line or title is short and authoritative: one match still assigns the tag.
    assert "voting-rights-act" in tags(("official subject line", "Elections: federal Voting Rights Act."))


def test_the_published_rules_name_their_exclusions_and_new_ids():
    rules = {r["tag"]: r for r in classify.rules_document()["issueRules"]}
    assert rules["direct-democracy"]["ruleId"] == "tag-direct-4" and rules["voting-rights-act"]["ruleId"] == "tag-vra-5"
    assert rules["redistricting"]["ruleId"] == "tag-redist-2"
    for tag in ("direct-democracy", "redistricting", "voting-rights-act"):
        assert rules[tag]["exclusionPattern"] == classify.ISSUE_EXCLUSIONS[tag]
    assert "exclusionPattern" not in rules["registration"]
    note = classify.rules_document()["note"]
    assert "'would'" in note and "breaks across two lines with a hyphen" in note


def test_the_rule_for_the_stage_of_a_measure_of_congress_publishes_its_stages_in_order(env):
    # The site lists stages in this order from a list of its own (FEDERAL_STAGES); the data check compares the two.
    env.run(["relationships", "events"])
    rule = next(r for r in env.read("classification.json")["otherRules"] if r["ruleId"] == congress.STATUS_RULE_ID)
    assert rule["order"] == congress.STATUS_ORDER
    assert rule["order"][0] == "Introduced" and rule["order"][-1] == "Became law"
    assert [r["ruleId"] for r in env.read("classification.json")["otherRules"] if "order" in r] == [congress.STATUS_RULE_ID]


# --- DN3: a word a PDF breaks across lines is joined before the rules read it ------------------------------------

#: Lines of the Court's opinion in No. 25A608 as text extraction gives them (pages 1 and 5 to 6).
OPINION_25A608 = ("several States have in recent months redrawn their con-\ngressional districts in ways that are predicted to favor the\n"
                  "one: It had to choose between the plaintiffs’ “race predomi-\nnated” account and the State’s “race never entered the\n"
                  "to advance partisan interests, “Texas racially gerryman-\ndered the 2025 Map.” Ibid.\n")


def test_line_break_hyphens_are_joined_for_the_rules():
    joined = classify.join_line_hyphens(OPINION_25A608)
    assert "redrawn their congressional districts" in joined
    assert "“race predominated” account" in joined
    assert "“Texas racially gerrymandered the 2025 Map.”" in joined
    assert classify.join_line_hyphens("racially gerryman -\ndered") == "racially gerrymandered"
    # A word the document also writes with a hyphen on one line keeps it; a capitalised next line is not a continuation.
    assert classify.join_line_hyphens("an out-of-precinct ballot; two out-of-\nprecinct ballots") == "an out-of-precinct ballot; two out-of-precinct ballots"
    assert classify.join_line_hyphens("Section 2 -\nThe State") == "Section 2 -\nThe State"
    # A compound broken after a word that begins compounds keeps its hyphen; a syllable does not.
    assert classify.join_line_hyphens("a well-\nknown rule; a case-\nspecific inquiry; the three-\njudge court") == \
        "a well-known rule; a case-specific inquiry; the three-judge court"
    assert classify.join_line_hyphens("the Four-\nteenth Amendment; these state-\nments") == "the Fourteenth Amendment; these statements"
    # The evidence check reads the text as extracted, and finds a passage either way.
    assert find_passage("“Texas racially gerrymandered the 2025 Map.”", OPINION_25A608) is None


def test_in_a_long_text_a_rule_counts_the_words_the_pdf_broke():
    text = ("The State racially gerryman-\ndered the map. " * 3 + "The court found the State racially gerrymandered the map. " * 2
            + "The plaintiffs said race predomi-\nnated in drawing the lines. ")
    field = "full text of the initiating filing or opinion"
    assert "racial-gerrymandering" not in tags((field, text, "long"))
    joined = classify.classify([(field, classify.join_line_hyphens(text), "long")])
    racial = next(t for t in joined if t.tag == "racial-gerrymandering")
    assert racial.matchCount == 6


def test_a_docket_is_tagged_from_the_joined_questions_but_keeps_them_as_extracted(env, session):
    qp = ("QUESTION PRESENTED\nWhether the State of California's congressional districting plan, enacted as Synthetic Bill 9, is lawful.\n"
          "Whether the District Court erred in finding that the plan was racially gerryman-\ndered.")
    session.on(qp_url("99-0001"), FakeResponse(200, qp))
    code, _ = env.run(COURT)
    assert code == 0
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert case["questionsPresented"]["text"] == qp
    racial = next(t for t in case["issueTags"] if t["tag"] == "racial-gerrymandering")
    assert racial["matchedField"] == "questions presented" and "racially gerrymandered" in racial["matchedText"]
    assert env.read("relationships.json")["relationships"][0]["verification"]["status"] == "verified_primary"


# --- W8, DL13, DN1, DN2, DN5, W21: the curated seeds --------------------------------------------------------------

def case_seeds():
    return {c["docket"]: c for c in json.loads((SEEDS / "cases.json").read_text(encoding="utf-8"))["cases"]}


def passages(seed):
    return [g.get("quote") or "" for g in seed.get("geographies", [])] + [t.get("quote") or "" for t in seed.get("tags", [])]


PARTISAN_DOCKETS = ("16-1161", "17-333", "18-422", "18-726", "21-1271")
#: Passages that start inside a sentence and keep its sense, checked by hand: "[Did the district court violate Vieth ...]
#: when it held that ...", "[In the decision below, however,] the Ninth Circuit held that ..." and "[But] in October 2019, ...".
FRAGMENT_PASSAGES = {"16-1161", "19-1258", "20-542"}


def test_partisan_gerrymandering_passages_treat_the_parties_alike():
    seeds = case_seeds()
    partisan = {d for d, s in seeds.items() if any(t.get("tag") == "partisan-gerrymandering" for t in s.get("tags", []))
                or any(re.search(r"partisan gerrymander", q, re.I) for q in passages(s))}
    assert partisan <= set(PARTISAN_DOCKETS) and set(PARTISAN_DOCKETS) <= set(seeds)
    naming = {d for d in PARTISAN_DOCKETS if any(re.search(r"\b(Republican|Democrat)", q) for q in passages(seeds[d]))}
    assert naming in (set(), set(PARTISAN_DOCKETS)), f"only some partisan-gerrymandering passages name a party: {sorted(naming)}"


def test_link_passages_are_not_one_side_characterising_the_other():
    seeds = case_seeds()
    for docket, seed in seeds.items():
        for quote in passages(seed):
            assert not re.search(r"\bThe (dissent|concurrence|majority) (would|wants|levels|claims)\b", quote), (docket, quote)
    assert "unambiguous deadline" not in " ".join(passages(seeds["20-542"]))
    # The order's three sentences are quoted whole: who did not oppose the application, and who did.
    assert passages(seeds["25A1197"])[0].startswith("Appellant Louisiana does not oppose this application. And while the Robinson "
                                                    "appellants oppose it,") and "[…]" not in passages(seeds["25A1197"])[0]
    # No. 22-807 quotes the opinion of the Court, not the appellants' account of the District Court's reasoning.
    for geo in seeds["22-807"]["geographies"]:
        assert geo["evidenceUrl"] == "https://www.supremecourt.gov/opinions/23pdf/22-807_3e04.pdf"
        assert geo["evidenceLabel"].endswith("the passage is from the opinion of the Court")
        assert geo["quote"].startswith("South Carolina has seven congressional districts, and this case concerns two of them")
    # A link's passage is a whole sentence or question, so that leaving out its first words cannot turn its sense around.
    for docket, seed in seeds.items():
        for geo in seed.get("geographies", []):
            first = geo["quote"].lstrip("“\"'(")
            assert first[:1].isupper() or first[:1].isdigit() or docket in FRAGMENT_PASSAGES, (docket, geo["key"], geo["quote"][:60])
    readme = json.loads((SEEDS / "cases.json").read_text(encoding="utf-8"))["_readme"]
    readme = readme if isinstance(readme, str) else " ".join(readme)
    assert "Apply party labels symmetrically" in readme and "characterises another Justice's or another party's position" in readme
    assert "not a party's framing" in seeds["21-1086"]["geographies"][0]["evidenceLabel"]


ACA15_QUOTE = ("This section shall become operative only if Assembly Constitutional Amendment 8 of the 2025–26 Regular Session is "
               "approved by the voters and takes effect and subdivision (b) of Section 4 becomes operative.")


def test_aca_15_is_linked_to_aca_8_like_its_companion_bills():
    seed = json.loads((SEEDS / "relationships.json").read_text(encoding="utf-8"))
    links = [r for r in seed["relationships"] if r["source"] == "bill:ca-20252026-aca15"]
    assert [(r["target"], r["relationshipType"], r["evidenceIn"], r["quote"]) for r in links] == [
        ("bill:ca-20252026-aca8", "operative_only_if", "bill:ca-20252026-aca15", ACA15_QUOTE)]
    readme = seed["_readme"] if isinstance(seed["_readme"], str) else " ".join(seed["_readme"])
    assert "characterises another Justice's or another party's position" in readme


@pytest.mark.skipif(not (Path(__file__).resolve().parents[1] / ".cache/ca/2025/lob/by-version/20250ACA1599INT.xml").exists(),
                    reason="the official ACA 15 text is not in the local cache")
def test_the_aca_15_passage_is_in_its_official_text():
    """Reads the cached official text when a maintainer's machine has it; the cache is not part of the repository."""
    xml = (Path(__file__).resolve().parents[1] / ".cache/ca/2025/lob/by-version/20250ACA1599INT.xml").read_bytes()
    parsed = ca_leginfo.parse_bill_xml(xml)
    assert find_passage(ACA15_QUOTE, "\n".join(text for _kind, text in parsed["blocks"])) is None


# --- W10, W15, W19: source register wording --------------------------------------------------------------------

def test_the_source_register_wording():
    assert all("monthly" not in s["updateCadence"] for s in SOURCES.values())
    assert "checked weekly" in SOURCES["census-pl-2020"]["updateCadence"]
    assert "checked weekly" in SOURCES["census-cd119-sf"]["updateCadence"]
    licence = SOURCES["scotus-docket"]["license"]
    assert "17 U.S.C. § 105" in licence and "not U.S. Government works" in licence and "Questions Presented" in licence
    limits = " ".join(SOURCES["census-tiger-2026-cd120"]["knownLimitations"])
    assert "the Census Bureau has not yet tabulated counts for redrawn districts" in limits
    assert "no official population counts exist" not in limits


# --- DL2 on the timeline: each bill event carries the subject line in force when it happened ---------------------

def test_a_bill_event_carries_the_subject_line_of_the_version_in_force():
    from dhq.run import _subject_in_force
    versions = [
        {"versionDate": "2025-02-13", "subject": "Voter registration: residency confirmation."},
        {"versionDate": "2025-08-18", "subject": "Redistricting: congressional districts."},
    ]
    # A vote after introduction and before the subject-changing amendment was taken on the first subject.
    assert _subject_in_force(versions, "2025-04-01", "passed_house") == "Voter registration: residency confirmation."
    # After the amendment, the new subject is in force.
    assert _subject_in_force(versions, "2025-08-21", "passed_house") == "Redistricting: congressional districts."


def test_no_subject_is_given_when_the_record_cannot_say_which_text_an_event_concerned():
    from dhq.run import _subject_in_force
    versions = [
        {"versionDate": "2025-02-13", "subject": "Voter registration: residency confirmation."},
        {"versionDate": "2025-08-18", "subject": "Redistricting: congressional districts."},
    ]
    assert _subject_in_force(versions, "2025-08-18", "passed_house") is None  # a version dated the same day
    assert _subject_in_force(versions, "2025-02-01", "introduced") is None  # no version before it
    assert _subject_in_force(versions, "2025-04-01", "amended") is None  # it adopted amendments printed later
    assert _subject_in_force([{"versionDate": "2025-02-13", "subject": " "}], "2025-04-01", "passed_house") is None
