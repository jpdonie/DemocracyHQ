"""The Congress and court of appeals stages, run through ``run()`` against synthetic sources.

HTTP is scripted (see ``synthetic_federal``) and the PDF reader is replaced by one that takes a document's bytes
as its text. Everything else is the code the pipeline runs: the downloads, the selection rules, the checks against
what was published before, the timeline and the validation.
"""

import pytest

import dhq.run as pipeline
from dhq.adapters import congress, uscourts
from dhq.util import write_json

import synthetic_federal as fed
from conftest import FakeResponse, tree
from test_run import T1, T2, T3, env  # noqa: F401 - env is a fixture

LAWS = ["congress", "relationships", "events"]
COURTS = ["circuits", "relationships", "events"]
OFFICIAL = "To require synthetic proof of eligibility to register an individual to vote in elections for Federal office, and for other purposes."
SECTIONS_1 = [("1", "Short title", ["This Act may be cited as the Synthetic Voter Eligibility Act."]),
              ("2", "Proof", ["A State shall accept a synthetic document for voter registration."])]
SECTIONS_2 = [SECTIONS_1[0], ("2", "Proof", ["A State shall accept a synthetic document for voter registration within 30 days."])]


def measures(passed: bool = True) -> dict:
    """Two measures the rule selects (a bill with two text versions and a Senate resolution) and one it does not."""
    bill_actions = [fed.action("2025-04-10", "Passed/agreed to in House: On passage Passed by recorded vote: 220 - 208.", "8000")] if passed else []
    return {
        "hr": {
            22: fed.status_record("hr", 22, title="Synthetic Voter Eligibility Act", official=OFFICIAL, actions=[*bill_actions, fed.INTRODUCED],
                                  versions=([("Engrossed in House", "2025-04-10", "eh")] if passed else []) + [("Introduced in House", "2025-01-03", "ih")],
                                  summary="<p>This bill requires synthetic proof of eligibility for voter registration.</p>"),
            40: fed.status_record("hr", 40, title="Synthetic Harbor Dredging Act", official="To dredge a synthetic harbor.",
                                  policy_area="Water Resources Development"),
        },
        "sres": {5: fed.status_record("sres", 5, title="A resolution recognizing synthetic poll workers on Election Day.",
                                      actions=[fed.action("2025-02-03", "Submitted in Senate", "10000", kind="IntroReferral")],
                                      versions=[("Introduced in Senate", "2025-02-03", "is")])},
    }


TEXTS = {
    "BILLS-119hr22ih": fed.bill_text(OFFICIAL, SECTIONS_1), "BILLS-119hr22eh": fed.bill_text(OFFICIAL, SECTIONS_2),
    "BILLS-119sres5is": (b"<resolution><form><official-title>Recognizing synthetic poll workers.</official-title></form>"
                         b"<resolution-body><section><text>That the Senate recognizes synthetic poll workers.</text></section></resolution-body></resolution>"),
}


@pytest.fixture
def laws(env, session):  # noqa: F811
    fed.serve_congress(session, measures(), TEXTS)
    return env


# --- Congress ---------------------------------------------------------------------------------

def test_the_congress_stage_publishes_the_selected_measures_with_their_texts(laws):
    code, ctx = laws.run(LAWS)
    assert code == 0
    index = laws.read("congress/index.json")
    assert [b["id"] for b in index["bills"]] == ["us-119-hr22", "us-119-sres5"]  # latest action first
    selection = index["selection"]
    assert (selection["ruleId"], selection["congress"]) == ("us-select-1", 119)
    # Every record of all eight archives was read: the three above and the filler measure each synthetic archive holds.
    assert selection["totalMeasuresRead"] == 3 + 8 and selection["selectedByTest"] == {"named": 2, "general": 0, "other": 0}
    assert selection["pattern"] == congress.SELECTION_PATTERN.pattern and selection["generalAreas"] == ["Government Operations and Politics"]
    bill = laws.read("congress/bills/us-119-hr22.json")
    # The display title is read first, and it already meets the test: the record says which title and which words.
    assert bill["selection"] == {"ruleId": "us-select-1", "test": "named", "matchedText": "Voter Eligibility",
                                 "matchedField": "Display title", "matchedTitle": "Synthetic Voter Eligibility Act"}
    assert (bill["state"], bill["stateAbbr"], bill["sourceId"]) == ("US", "US", "govinfo-billstatus")
    assert bill["legislativeStatus"]["currentStatus"] == "Passed the House"
    assert [t["tag"] for t in bill["issueTags"]] == ["registration"]
    assert all(t["ruleId"] and t["matchedField"] and t["matchedText"] for t in bill["issueTags"])
    for version in bill["versions"]:
        text = laws.read(version["textPath"])
        assert version["textPath"].startswith("congress/text/") and text["textHash"] == version["textHash"]
        assert text["instrumentId"] == bill["id"] and text["sourceId"] == "govinfo-bills"
    assert sorted(p.name for p in (laws.public / "congress" / "text").iterdir()) == [
        "BILLS-119hr22eh.json", "BILLS-119hr22ih.json", "BILLS-119sres5is.json"]
    assert not (laws.public / "congress" / "bills" / "us-119-hr40.json").exists()


def test_a_measure_of_congress_is_listed_under_the_nation_and_under_no_state(laws):
    laws.run(LAWS)
    events = [e for e in laws.read("events.json")["events"] if e["entityId"] == "us-119-hr22"]
    assert {e["eventType"] for e in events} == {"introduced", "passed_house", "text_version_changed"}
    assert all(e["geoKeys"] == ["nation:US"] and e["ruleId"] and e["category"] == "legislation" for e in events)
    assert {e["entityLabel"] for e in events} == {"H.R. 22 (119th Congress)"}
    assert laws.read("manifest.json")["counts"] == {
        "cases": 0, "bills": 2, "supremeCourtCases": 0, "appealsCourtCases": 0, "stateBills": 0, "federalBills": 2,
        "relationships": 0, "events": 4, "geographicUnits": 2}


def test_both_congress_sources_are_recorded_with_what_they_hold(laws):
    laws.run(LAWS)
    status, texts = laws.source("govinfo-billstatus"), laws.source("govinfo-bills")
    assert (status["processingStatus"], status["recordCount"], status["sourcePublishedAt"]) == ("ok", 2, "2026-06-01T08:00:00Z")
    assert (texts["processingStatus"], texts["recordCount"], texts["statusDetail"]) == ("ok", 3, None)
    assert status["contentHash"] and texts["contentHash"] and status["contentHash"] != texts["contentHash"]


def test_every_rule_a_federal_record_cites_is_published(laws, courts):
    laws.run(["congress", "circuits", "relationships", "events"])
    rules = laws.read("classification.json")
    known = {r["ruleId"] for group in ("issueRules", "federalActionRules", "circuitDocumentRules", "otherRules") for r in rules[group]}
    cited = {e["ruleId"] for e in laws.read("events.json")["events"]}
    for bill in laws.read("congress/index.json")["bills"]:
        record = laws.read(f"congress/bills/{bill['id']}.json")
        cited |= {t["ruleId"] for t in record["issueTags"]} | {a["classificationRule"] for a in record["actions"]} | {record["selection"]["ruleId"]}
    for summary in laws.read("circuits/index.json")["cases"]:
        case = laws.read(f"circuits/cases/{summary['id']}.json")
        cited |= {t["ruleId"] for t in case["issueTags"]} | {e["classificationRule"] for e in case["events"]} | {case["selection"]["ruleId"]}
        cited |= {case["origin"]["ruleId"]} if case["origin"] else set()
    cited |= {entry["ruleId"] for entry in laws.read("circuits/index.json")["exclusions"]}
    assert cited <= known | {"diff-meta-1"} and {"us-select-1", "us-status-1", "circuit-select-1", "circuit-exclusion-1", "cover-letter-1",
                                               "origin-court-1", "publication-1", "same-opinion-1", "circuit-composition-1"} <= known


def test_the_same_congress_input_at_the_same_time_gives_identical_bytes_and_a_later_run_moves_only_the_check_time(laws):
    laws.run(LAWS, now=T1)
    first = tree(laws.public)
    laws.run(LAWS, now=T1)
    assert tree(laws.public) == first
    before = laws.read("congress/bills/us-119-hr22.json")
    code, ctx = laws.run(LAWS, now=T2)
    after = laws.read("congress/bills/us-119-hr22.json")
    assert code == 0 and ctx.review == []
    assert (after["firstObservedAt"], before["lastCheckedAt"], after["lastCheckedAt"]) == (T1, T1, T2)
    assert after["contentHash"] == before["contentHash"]


def test_a_text_version_that_cannot_be_retrieved_keeps_the_last_verified_record(laws, session):
    laws.run(LAWS, now=T1)
    kept = (laws.public / "congress/bills/us-119-hr22.json").read_bytes()
    session.on("HEAD " + congress.TEXT_URL.format(package="BILLS-119hr22eh"), FakeResponse(503))
    code, ctx = laws.run(LAWS, now=T2)
    assert code == 1
    assert (laws.public / "congress/bills/us-119-hr22.json").read_bytes() == kept
    assert (laws.public / "congress/text/BILLS-119hr22eh.json").exists()  # the kept record still points at its texts
    assert laws.read("congress/bills/us-119-sres5.json")["lastCheckedAt"] == T2  # the other measure was refreshed
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("bill_failed", "us-119-hr22")]
    status, texts = laws.source("govinfo-billstatus"), laws.source("govinfo-bills")
    assert status["processingStatus"] == "ok" and "1 of 2 measures could not be rebuilt" in status["statusDetail"]
    assert (texts["processingStatus"], texts["lastSuccessfulCheck"], texts["lastAttempt"]) == ("failed", T1, T2)


def test_a_new_measure_whose_text_cannot_be_retrieved_is_not_published_half_built(env, session):  # noqa: F811
    fed.serve_congress(session, measures(), {k: v for k, v in TEXTS.items() if k != "BILLS-119sres5is"})
    code, ctx = env.run(LAWS)
    assert code == 1
    assert [b["id"] for b in env.read("congress/index.json")["bills"]] == ["us-119-hr22"]
    assert not (env.public / "congress/bills/us-119-sres5.json").exists()


def test_a_measure_that_loses_a_text_version_is_held_for_review(laws, session):
    laws.run(LAWS, now=T1)
    kept = (laws.public / "congress/bills/us-119-hr22.json").read_bytes()
    fed.serve_congress(session, measures(passed=False), TEXTS, last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = laws.run(LAWS, now=T2)
    assert code == 0
    assert (laws.public / "congress/bills/us-119-hr22.json").read_bytes() == kept
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("regression", "us-119-hr22")]
    assert "held for review" in laws.source("govinfo-billstatus")["statusDetail"]


def many_measures(count: int) -> dict:
    return {"hr": {number: fed.status_record("hr", number, title=f"Synthetic Voter Registration Act No. {number}") for number in range(1, count + 1)}}


def test_measures_may_leave_one_at_a_time_but_not_many_at_once(env, session):  # noqa: F811
    fed.serve_congress(session, many_measures(12), {})
    env.run(LAWS, now=T1)
    assert len(env.read("congress/index.json")["bills"]) == 12
    # One of twelve leaves: its record is no longer published, and the queue says so.
    fed.serve_congress(session, many_measures(11), {}, last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0 and len(env.read("congress/index.json")["bills"]) == 11
    assert not (env.public / "congress/bills/us-119-hr12.json").exists()
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("bill_left_selection", "us-119-hr12")]
    # Half of them leave at once: that looks like a broken archive, so the published set stays as it is.
    before = tree(env.public / "congress")
    fed.serve_congress(session, many_measures(5), {}, last_modified="Wed, 03 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T3)
    assert code == 1 and tree(env.public / "congress") == before
    assert env.source("govinfo-billstatus")["processingStatus"] == "failed"
    assert "6 of the 11 published measures" in env.source("govinfo-billstatus")["statusDetail"]


def test_a_newly_selected_measure_is_queued_for_a_maintainer_to_look_at_once(env, session):  # noqa: F811
    fed.serve_congress(session, many_measures(3), {})
    code, ctx = env.run(LAWS, now=T1)
    assert ctx.review == []  # the first publication is the reviewed starting set
    fed.serve_congress(session, many_measures(4), {}, last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("new_selection", "us-119-hr4")]
    code, ctx = env.run(LAWS, now=T3)
    assert ctx.review == []


def test_an_archive_in_which_nothing_is_selected_is_refused(env, session):  # noqa: F811
    fed.serve_congress(session, {}, {})
    code, ctx = env.run(LAWS)
    assert code == 1 and not (env.public / "congress").exists()
    assert "matched no measures" in env.source("govinfo-billstatus")["statusDetail"]


def test_an_archive_served_as_an_error_page_is_refused(laws, session):
    laws.run(LAWS, now=T1)
    before = tree(laws.public / "congress")
    url = congress.ARCHIVE_URL.format(congress=119, kind="hr")
    session.serve_bytes(url, b"<html><body>Temporarily unavailable</body></html>", last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = laws.run(LAWS, now=T2)
    assert code == 1 and tree(laws.public / "congress") == before
    assert "not a ZIP archive" in laws.source("govinfo-billstatus")["statusDetail"]


def test_a_record_that_describes_another_measure_than_its_file_name_is_not_read(env, session):  # noqa: F811
    records = measures()
    records["hr"][23] = fed.status_record("hr", 24, title="Synthetic Voter Registration Act of another number")
    fed.serve_congress(session, records, TEXTS)
    code, ctx = env.run(LAWS)
    assert code == 0 and [b["id"] for b in env.read("congress/index.json")["bills"]] == ["us-119-hr22", "us-119-sres5"]
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("status_record_unreadable", "BILLSTATUS-119hr23.xml")]


# --- courts of appeals ------------------------------------------------------------------------

LEAGUE, SUPPLIER, SCHOOL = "USCOURTS-ca5-25-30725", "USCOURTS-ca5-25-00002", "USCOURTS-ca11-25-00003"
SCHOOL_QUOTE = "The student council of a synthetic high school held its election in the spring."
ORIGIN = "Appeal from the United States District Court for the Western District of Texas\n"


@pytest.fixture
def courts(env, session, monkeypatch):  # noqa: F811
    monkeypatch.setattr(uscourts, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    write_json(env.seeds_dir / "circuit_exclusions.json", {"exclusions": [fed.exclusion(SCHOOL, SCHOOL_QUOTE, name="Synthetic Pupil v. Synthetic School")]})
    listed = fed.Courts(session)
    listed.add(LEAGUE, "Synthetic Voters League v. Synthetic County", [ORIGIN + fed.election_opinion()],
               parties=[("Synthetic Voters League", "Plaintiff - Appellant"), ("Synthetic County", "Defendant - Appellee")])
    listed.add(SUPPLIER, "Synthetic Supplier v. Synthetic Buyer", [fed.other_opinion()])
    listed.add(SCHOOL, "Synthetic Pupil v. Synthetic School", [fed.election_opinion(SCHOOL_QUOTE + " ")])
    listed.serve()
    env.courts = listed
    return env


def test_the_circuits_stage_publishes_the_selected_cases_and_how_they_were_selected(courts):
    code, ctx = courts.run(COURTS)
    assert code == 0 and ctx.review == []
    index = courts.read("circuits/index.json")
    assert [c["id"] for c in index["cases"]] == ["ca5-25-30725"]
    summary = index["cases"][0]
    assert (summary["courtId"], summary["publication"], summary["origin"]["stateFips"], summary["stateFips"]) == ("ca5", "Published", "48", [])
    assert "events" not in summary and "selection" not in summary and "parties" not in summary and summary["decidedWith"] == []
    case = courts.read("circuits/cases/ca5-25-30725.json")
    assert case["selection"]["tests"] == ["long"] and case["selection"]["documentId"] == "ca5-25-30725-d0"
    assert case["sourceUrl"] == f"https://www.govinfo.gov/app/details/{LEAGUE}" and case["sourcePublishedAt"] == "2026-05-20T12:00:00Z"
    assert index["selection"]["ruleId"] == "circuit-select-1" and index["selection"]["phrasePattern"] == uscourts.PHRASE_PATTERN.pattern
    assert (index["selection"]["totalCasesRead"], index["selection"]["totalDocumentsRead"]) == (3, 3)
    assert index["coverage"]["ca5"] == {"cases": 2, "documents": 2, "coverLetters": 0, "unreadableDocuments": 0, "selected": 1, "excluded": 0}
    assert index["coverage"]["ca11"]["excluded"] == 1 and index["coverage"]["cafc"]["cases"] == 0
    assert courts.read("circuits/scan.json")["packages"]["ca5"]["25-00002"] == ["2026-05-20T12:00:00.123Z", 1, 0, 0, 0]
    source = courts.source("govinfo-uscourts")
    assert (source["processingStatus"], source["recordCount"], source["sourcePublishedAt"], source["statusDetail"]) == ("ok", 1, "2026-05-20T12:00:00Z", None)
    assert courts.read("manifest.json")["counts"]["appealsCourtCases"] == 1


def test_a_case_a_maintainer_removed_is_published_with_the_passage_that_shows_why(courts):
    courts.run(COURTS)
    assert courts.read("circuits/index.json")["exclusions"] == [{
        "package": SCHOOL, "caseId": "ca11-25-00003", "courtId": "ca11", "docketNumber": "25-3", "caseName": "Synthetic Pupil v. Synthetic School",
        "reason": "The election in this synthetic case is not a public election.", "quote": SCHOOL_QUOTE,
        "documentUrl": f"https://www.govinfo.gov/content/pkg/{SCHOOL}/pdf/{SCHOOL}-0.pdf",
        "sourceUrl": f"https://www.govinfo.gov/app/details/{SCHOOL}", "tests": ["long"], "ruleId": "circuit-exclusion-1", "checkedAt": T1}]
    assert not (courts.public / "circuits/cases/ca11-25-00003.json").exists()


def test_an_exclusion_whose_passage_is_not_in_the_opinion_leaves_the_case_in_and_is_queued(courts):
    write_json(courts.seeds_dir / "circuit_exclusions.json", {"exclusions": [
        fed.exclusion(SCHOOL, "The pupils of another school held no election at all."),
        fed.exclusion(SUPPLIER, "The supplier delivered the widgets late"),          # the rule does not select this case anyway
        fed.exclusion("USCOURTS-ca5-25-99999", "A case GovInfo does not list at all"),
        {"package": "USCOURTS-ca5-25-30725", "quote": "No reason is given for this one"},
        fed.exclusion("../../etc/passwd", "Not a package"),
    ]})
    code, ctx = courts.run(COURTS)
    index = courts.read("circuits/index.json")
    assert code == 0 and [c["id"] for c in index["cases"]] == ["ca5-25-30725", "ca11-25-00003"] and index["exclusions"] == []
    assert sorted((r["kind"], r["entity"]) for r in ctx.review) == [
        ("exclusion_check_failed", "ca11-25-00003"), ("exclusion_unusable", "../../etc/passwd"), ("exclusion_unusable", "USCOURTS-ca5-25-30725"),
        ("exclusion_unused", "ca5-25-00002"), ("exclusion_unused", "ca5-25-99999")]


def test_a_decision_is_listed_under_its_circuit_and_under_no_state(courts):
    courts.run(COURTS)
    events = courts.read("events.json")["events"]
    assert [(e["entityId"], e["eventType"], e["geoKeys"], e["category"]) for e in events] == [("ca5-25-30725", "opinion", ["circuit:05"], "litigation")]
    assert events[0]["entityLabel"] == "Synthetic Voters League v. Synthetic County (Fifth Circuit, No. 25-30725)"
    assert events[0]["sourceUrl"] == f"https://www.govinfo.gov/content/pkg/{LEAGUE}/pdf/{LEAGUE}-0.pdf" and events[0]["ruleId"] == "ca-doc-opinion"


def test_one_opinion_that_decides_two_appeals_links_the_cases_and_appears_once_in_the_timeline(courts):
    shared = ORIGIN + fed.election_opinion() * 12
    second = "USCOURTS-ca5-25-30726"
    courts.courts.add(LEAGUE, "Synthetic Voters League v. Synthetic County", [shared])
    courts.courts.add(second, "Synthetic Voters League v. Synthetic State", [shared, "A short order of its own."],
                      entries=["PUBLISHED AUTHORED OPINION filed.", "ORDER filed."], dates=["2026-03-10", "2026-03-10"])
    courts.courts.serve()
    code, ctx = courts.run(COURTS)
    assert code == 0
    first, other = courts.read("circuits/cases/ca5-25-30725.json"), courts.read("circuits/cases/ca5-25-30726.json")
    assert first["decidedWith"] == [{"caseId": "ca5-25-30726", "docket": "25-30726", "caseName": "Synthetic Voters League v. Synthetic State"}]
    assert other["decidedWith"] == [{"caseId": "ca5-25-30725", "docket": "25-30725", "caseName": "Synthetic Voters League v. Synthetic County"}]
    assert first["documents"][0]["sameTextAs"] == ["ca5-25-30726-d0"] and [d["sameTextAs"] for d in other["documents"]] == [["ca5-25-30725-d0"], []]
    assert {c["id"]: [d["caseId"] for d in c["decidedWith"]] for c in courts.read("circuits/index.json")["cases"]} == {
        "ca5-25-30725": ["ca5-25-30726"], "ca5-25-30726": ["ca5-25-30725"]}
    events = [(e["entityId"], e["eventType"], e["entityLabel"]) for e in courts.read("events.json")["events"]]
    # The shared opinion is listed once, under the first case, with both numbers; the second case's own order stays.
    assert sorted(events) == [
        ("ca5-25-30725", "opinion", "Synthetic Voters League v. Synthetic County (Fifth Circuit, Nos. 25-30725, 25-30726)"),
        ("ca5-25-30726", "order", "Synthetic Voters League v. Synthetic State (Fifth Circuit, No. 25-30726)")]


def test_the_same_court_input_at_the_same_time_gives_identical_bytes_and_a_later_run_reads_only_what_it_must(courts, session):
    courts.run(COURTS, now=T1)
    first = tree(courts.public)
    before = len(fed.packages_read(session))
    code, ctx = courts.run(COURTS, now=T1)
    assert tree(courts.public) == first
    # The unselected case is not read again; the selected one and the excluded one are checked on every run.
    assert sorted(fed.packages_read(session)[before:]) == [SCHOOL, LEAGUE]
    code, ctx = courts.run(COURTS, now=T2)
    case = courts.read("circuits/cases/ca5-25-30725.json")
    assert code == 0 and ctx.review == [] and (case["firstObservedAt"], case["lastCheckedAt"]) == (T1, T2)
    assert courts.read("circuits/index.json")["exclusions"][0]["checkedAt"] == T2


def test_a_case_that_cannot_be_read_keeps_its_last_verified_record_and_its_check_time(courts, session):
    courts.run(COURTS, now=T1)
    kept = (courts.public / "circuits/cases/ca5-25-30725.json").read_bytes()
    session.on(uscourts.RECORD_URL.format(package=LEAGUE), FakeResponse(503))
    session.on(uscourts.RECORD_URL.format(package=SCHOOL), FakeResponse(503))
    code, ctx = courts.run(COURTS, now=T2)
    assert (courts.public / "circuits/cases/ca5-25-30725.json").read_bytes() == kept
    assert sorted((r["kind"], r["entity"]) for r in ctx.review) == [("fetch_failed", "ca11-25-00003"), ("fetch_failed", "ca5-25-30725")]
    # The excluded case stays excluded on the strength of its last check, which keeps its own date.
    assert [(e["caseId"], e["checkedAt"]) for e in courts.read("circuits/index.json")["exclusions"]] == [("ca11-25-00003", T1)]
    source = courts.source("govinfo-uscourts")
    assert code == 1 and source["processingStatus"] == "failed" and "2 of 2 cases read in this run could not be retrieved" in source["statusDetail"]
    assert source["lastSuccessfulCheck"] == T1


def test_a_case_that_shrinks_is_held_for_review(courts):
    courts.courts.add(LEAGUE, "Synthetic Voters League v. Synthetic County", [ORIGIN + fed.election_opinion(), "An errata sheet."],
                      entries=["PUBLISHED AUTHORED OPINION filed.", "ERRATA SHEET filed."])
    courts.courts.serve()
    courts.run(COURTS, now=T1)
    kept = (courts.public / "circuits/cases/ca5-25-30725.json").read_bytes()
    courts.courts.add(LEAGUE, "Synthetic Voters League v. Synthetic County", [ORIGIN + fed.election_opinion()], changed="2026-06-01T12:00:00.000Z")
    courts.courts.serve()
    code, ctx = courts.run(COURTS, now=T2)
    assert (courts.public / "circuits/cases/ca5-25-30725.json").read_bytes() == kept
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("regression", "ca5-25-30725")]


def many_cases(listed: fed.Courts, count: int) -> None:
    for number in range(1, count + 1):
        listed.add(f"USCOURTS-ca4-25-{number:05d}", f"Synthetic Voter No. {number} v. Synthetic County", [fed.election_opinion(f"Case number {number}. ")])
    listed.serve()


def test_cases_may_leave_one_at_a_time_but_not_many_at_once(courts):
    many_cases(courts.courts, 12)
    courts.run(COURTS, now=T1)
    assert len(courts.read("circuits/index.json")["cases"]) == 13
    # The court replaces one opinion by a text that is not about an election: the rule no longer selects the case.
    courts.courts.add("USCOURTS-ca4-25-00012", "Synthetic Voter No. 12 v. Synthetic County", [fed.other_opinion()], changed="2026-06-01T12:00:00.000Z")
    courts.courts.serve()
    code, ctx = courts.run(COURTS, now=T2)
    assert code == 0 and len(courts.read("circuits/index.json")["cases"]) == 12
    assert not (courts.public / "circuits/cases/ca4-25-00012.json").exists()
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("case_left_selection", "ca4-25-00012")]
    assert "no longer selects it" in ctx.review[0]["detail"]
    # Six more at once: the published set stays as it is until a maintainer has looked.
    before = tree(courts.public / "circuits")
    for number in range(1, 7):
        courts.courts.add(f"USCOURTS-ca4-25-{number:05d}", f"Synthetic Voter No. {number} v. Synthetic County", [fed.other_opinion()],
                          changed="2026-06-02T12:00:00.000Z")
    courts.courts.serve()
    code, ctx = courts.run(COURTS, now=T3)
    assert code == 1 and tree(courts.public / "circuits") == before
    assert "6 of the 12 published court of appeals cases" in courts.source("govinfo-uscourts")["statusDetail"]


def test_a_newly_selected_case_is_queued_for_a_maintainer_to_read_once(courts):
    courts.run(COURTS, now=T1)
    courts.courts.add("USCOURTS-ca9-26-00100", "Synthetic Elector v. Synthetic Registrar", [fed.election_opinion()])
    courts.courts.serve()
    code, ctx = courts.run(COURTS, now=T2)
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("new_selection", "ca9-26-00100")]
    code, ctx = courts.run(COURTS, now=T3)
    assert ctx.review == []


def test_a_listing_that_cannot_be_read_publishes_nothing_new(courts, session):
    courts.run(COURTS, now=T1)
    before = tree(courts.public / "circuits")
    session.on(uscourts.SITEMAP_URL.format(court="ca5", year=2026), FakeResponse(200, "<html><body>Service unavailable</body></html>"))
    code, ctx = courts.run(COURTS, now=T2)
    assert code == 1 and tree(courts.public / "circuits") == before
    assert "not a sitemap" in courts.source("govinfo-uscourts")["statusDetail"]


def test_a_first_run_in_which_nothing_is_selected_publishes_no_empty_set(env, session, monkeypatch):  # noqa: F811
    monkeypatch.setattr(uscourts, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    write_json(env.seeds_dir / "circuit_exclusions.json", {"exclusions": []})
    listed = fed.Courts(session)
    listed.add(SUPPLIER, "Synthetic Supplier v. Synthetic Buyer", [fed.other_opinion()])
    listed.serve()
    code, ctx = env.run(COURTS)
    assert code == 1 and not (env.public / "circuits").exists()


def test_a_case_record_that_does_not_belong_in_its_folder_blocks_the_publication(courts, monkeypatch):
    real = uscourts.build_case

    def wrong_source(*args, **kwargs):
        case = real(*args, **kwargs)
        return case.model_copy(update={"sourceId": "scotus-docket"})

    monkeypatch.setattr(uscourts, "build_case", wrong_source)
    code, ctx = courts.run(COURTS)
    assert code == 2 and not (courts.public / "circuits").exists()
