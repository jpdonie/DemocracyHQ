"""Whole pipeline runs against synthetic sources: publishing, idempotence, failure recovery.

Everything is written under pytest's temporary directory. The real ``public/data`` and the
real seed lists are never read or written by these tests.
"""

import io
import json
import re
import shutil
import zipfile

import pytest
import requests

import dhq.run as pipeline
from dhq.adapters import os_bulk, scotus
from dhq.http import Fetcher
from dhq.util import read_json, write_json

import synthetic_ca as syn
from conftest import SC, FakeResponse, docket_url, make_zip, qp_url, render_docket_page, synthetic_docket, tree

T1, T2, T3 = "2026-06-01T10:00:00Z", "2026-06-02T10:00:00Z", "2026-06-03T10:00:00Z"
ARCHIVE_URL = "https://data.openstates.org/csv/latest/LA_2026_csv_synthetic.zip"
#: The env fixture replaces the PDF reader; tests of what happens when it fails put the real one back.
REAL_EXTRACT_PDF_TEXT = scotus.extract_pdf_text

QP_1 = "QUESTION PRESENTED\nWhether the State of California's congressional districting plan, enacted as Synthetic Bill 9, is lawful."
QP_2 = "QUESTION PRESENTED\nWhether absentee ballots received after election day may be counted."

CASE_SEEDS = {"cases": [
    {"docket": "99-0001", "evidence": "qp", "geographies": [
        {"key": "state:06", "scope": "statewide", "relationship": "concerns_congressional_plan", "note": "Synthetic note.",
         "quote": "Whether the State of California's congressional districting plan, enacted as Synthetic Bill 9, is lawful."}]},
    {"docket": "99-0002", "evidence": "qp", "geographies": [
        {"key": "state:48", "scope": "statewide", "relationship": "concerns_state_law",
         "quote": "Whether Texas law allows absentee ballots to be counted after election day."}]},
]}

GEO_INDEX = {"fields": [], "layers": {}, "rows": [["state:06", "California", "06", 0, 0, 1, 1], ["state:48", "Texas", "48", 0, 0, 1, 1]]}


@pytest.fixture
def env(tmp_path, monkeypatch, session):
    """A sandboxed pipeline: temporary folders, synthetic seeds, scripted HTTP."""
    seeds = tmp_path / "seeds"
    write_json(seeds / "cases.json", CASE_SEEDS)
    write_json(seeds / "relationships.json", {"relationships": []})
    monkeypatch.setattr(pipeline, "SEEDS_DIR", seeds)
    monkeypatch.setattr(scotus, "extract_pdf_text", lambda data: data.decode("utf-8") or None)
    write_json(tmp_path / "public" / "geo" / "index.json", GEO_INDEX)
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0001")))
    session.on(qp_url("99-0001"), FakeResponse(200, QP_1))
    session.on(docket_url("99-0002"), FakeResponse(200, synthetic_docket("99-0002", PetitionerTitle="Synthetic Gamma, Petitioner", RespondentTitle="Synthetic Delta")))
    session.on(qp_url("99-0002"), FakeResponse(200, QP_2))

    class Env:
        public = tmp_path / "public"
        staging = tmp_path / "staging"
        seeds_dir = seeds

        def run(self, stages, now=T1):
            monkeypatch.setenv("DHQ_NOW", now)
            ctx = pipeline.Context(public=self.public, staging=self.staging, cache=tmp_path / "cache",
                                   fetcher_factory=lambda **kw: Fetcher(session=session, retries=1, backoff=0, sleep=lambda s: None))
            code = pipeline.run(list(stages), ctx)
            return code, ctx

        def read(self, rel):
            return read_json(self.public / rel)

        def source(self, source_id):
            return next(s for s in self.read("sources.json")["sources"] if s["id"] == source_id)

    return Env()


COURT = ["scotus", "relationships", "events"]


# --- a first, clean run ---------------------------------------------------------------

def test_first_run_publishes_validated_records(env):
    code, ctx = env.run(COURT)
    assert code == 0
    index = env.read("litigation/index.json")["cases"]
    assert [c["id"] for c in index] == ["scotus-99-0002", "scotus-99-0001"]
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert case["entryCount"] == 4 and case["stateFips"] == ["06"]
    assert case["questionsPresented"]["text"] == QP_1
    # What the case is about: the Court's question, quoted, in the list and in the record.
    assert case["about"] == index[1]["about"] == {
        "text": "Whether the State of California's congressional districting plan, enacted as Synthetic Bill 9, is lawful.",
        "source": "question-presented", "url": case["questionsPresented"]["url"], "date": None, "cut": False, "of": None, "document": None, "later": None, "paragraph": None,
        "ruleId": "about-question-1"}
    assert [t["tag"] for t in case["issueTags"]] == ["redistricting"]
    assert case["issueTags"][0]["matchedField"] == "questions presented"
    assert env.read("manifest.json")["counts"] == {
        "cases": 2, "bills": 0, "supremeCourtCases": 2, "appealsCourtCases": 0, "districtAndStateCourtCases": 0, "stateBills": 0, "federalBills": 0, "stateLegislationBills": 0,
        "relationships": 1, "events": 4, "geographicUnits": 2}


def test_a_link_is_published_only_when_its_quoted_passage_is_in_the_cited_document(env):
    _, ctx = env.run(COURT)
    rels = {r["id"]: r for r in env.read("relationships.json")["relationships"]}
    good = rels["rel-scotus-99-0001-state-06"]
    assert good["verification"]["status"] == "verified_primary"
    assert good["support"]["url"] == qp_url("99-0001")
    assert good["support"]["quote"] == "Whether the State of California's congressional districting plan, enacted as Synthetic Bill 9, is lawful."
    assert good["support"]["terms"] is None
    assert "Questions Presented" in good["support"]["document"]
    assert "does not check the description" in good["verification"]["note"]
    assert good["ruleId"] == "cases-seed-2"
    # The second docket's passage is not in its document: the link is not published at all, and a maintainer is told.
    assert "rel-scotus-99-0002-state-48" not in rels
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("evidence_check_failed", "scotus-99-0002->state:48")]
    assert "link not published" in ctx.review[0]["detail"]
    assert env.read("manifest.json")["reviewQueue"] == {"items": 1, "byKind": {"evidence_check_failed": 1}}
    # Without a published link the docket has no state.
    assert env.read("litigation/cases/scotus-99-0002.json")["stateFips"] == []


def test_a_passage_that_does_not_name_the_place_is_not_published(env, session):
    seeds = json.loads((env.seeds_dir / "cases.json").read_text())
    seeds["cases"][0]["geographies"][0]["key"] = "state:48"  # the passage names California, not Texas
    write_json(env.seeds_dir / "cases.json", seeds)
    _, ctx = env.run(COURT)
    assert env.read("relationships.json")["relationships"] == []
    flagged = [r for r in ctx.review if r["entity"] == "scotus-99-0001->state:48"]
    assert flagged and "does not name Texas" in flagged[0]["detail"]


def test_a_passage_may_skip_words_but_must_keep_its_order(env):
    seeds = json.loads((env.seeds_dir / "cases.json").read_text())
    geo = seeds["cases"][0]["geographies"][0]
    geo["quote"] = "Whether the State of California's congressional districting plan […] enacted as Synthetic Bill 9, is lawful."
    write_json(env.seeds_dir / "cases.json", seeds)
    env.run(COURT)
    assert "rel-scotus-99-0001-state-06" in {r["id"] for r in env.read("relationships.json")["relationships"]}
    geo["quote"] = "enacted as Synthetic Bill 9, is lawful. […] Whether the State of California's congressional districting plan"
    write_json(env.seeds_dir / "cases.json", seeds)
    env.run(COURT, now=T2)
    assert "rel-scotus-99-0001-state-06" not in {r["id"] for r in env.read("relationships.json")["relationships"]}


def test_a_curated_tag_is_published_with_its_passage_only_when_the_passage_is_found(env):
    seeds = json.loads((env.seeds_dir / "cases.json").read_text())
    seeds["cases"][0]["tags"] = [
        {"tag": "partisan-gerrymandering", "quote": "Whether the State of California's congressional districting plan, enacted as Synthetic Bill 9"},
        {"tag": "mail-voting", "quote": "a sentence about mail ballots that the document does not contain"},
    ]
    write_json(env.seeds_dir / "cases.json", seeds)
    _, ctx = env.run(COURT)
    tags = {t["tag"]: t for t in env.read("litigation/cases/scotus-99-0001.json")["issueTags"]}
    assert tags["partisan-gerrymandering"]["ruleId"] == "tag-curated-1"
    assert tags["partisan-gerrymandering"]["matchedText"].startswith("Whether the State of California")
    assert "mail-voting" not in tags
    assert [r["entity"] for r in ctx.review if r["kind"] == "curated_tag_check_failed"] == ["scotus-99-0001#mail-voting"]


def test_a_seed_may_cite_only_a_document_the_docket_links(env):
    seeds = json.loads((env.seeds_dir / "cases.json").read_text())
    seeds["cases"][0]["geographies"][0]["evidenceUrl"] = "https://www.supremecourt.gov/opinions/25pdf/not-on-this-docket.pdf"
    write_json(env.seeds_dir / "cases.json", seeds)
    _, ctx = env.run(COURT)
    assert "rel-scotus-99-0001-state-06" not in {r["id"] for r in env.read("relationships.json")["relationships"]}
    flagged = [r for r in ctx.review if r["entity"] == "scotus-99-0001->state:06"]
    assert flagged and "is not linked from docket" in flagged[0]["detail"]


def test_a_dead_opinion_link_is_published_as_unavailable_not_as_a_working_link(env, session):
    live, dead, unsure = (f"{SC}/opinions/25pdf/99-0001_{name}.pdf" for name in ("live", "dead", "unsure"))
    docket = synthetic_docket("99-0001")
    docket["ProceedingsandOrder"].append({"Date": "Mar 20 2026", "Text": (
        f"Judgment AFFIRMED. Synthetic, J., delivered the opinion of the Court. <a href='{live}'>Opinion</a> "
        f"<a href='{dead}#page=4'>Opinion</a> <a href='{unsure}'>Opinion</a>")})
    session.on(docket_url("99-0001"), FakeResponse(200, docket))
    session.on("HEAD " + live, FakeResponse(200))
    session.on("HEAD " + dead, FakeResponse(404))
    session.on("HEAD " + unsure, FakeResponse(503))
    _, ctx = env.run(COURT)
    documents = {d["url"].split("#")[0]: d for d in env.read("litigation/cases/scotus-99-0001.json")["documents"]}
    assert documents[live]["availability"] == "public_link"
    assert documents[dead]["availability"] == "unavailable"
    assert "answered 404" in documents[dead]["accessNote"] and T1[:10] in documents[dead]["accessNote"]
    assert documents[unsure]["availability"] == "public_link"  # a server error proves nothing about the link
    assert "1 opinion or order link(s)" in env.source("scotus-docket")["statusDetail"]
    # The fragment is not sent; filing links are not probed; a server error is retried as a GET would be.
    assert session.urls("HEAD") == [live, dead, unsure, unsure]


def test_an_entry_no_rule_recognises_is_queued_for_a_maintainer(env, session):
    docket = synthetic_docket("99-0001")
    docket["ProceedingsandOrder"].append({"Date": "Mar 20 2026", "Text": "Something the rules have never seen, which might be an order."})
    session.on(docket_url("99-0001"), FakeResponse(200, docket))
    _, ctx = env.run(COURT)
    flagged = [r for r in ctx.review if r["kind"] == "unclassified_entry"]
    assert [r["entity"] for r in flagged] == ["scotus-99-0001"]
    assert "1 docket entry matched no labelling rule" in flagged[0]["detail"] and "2026-03-20" in flagged[0]["detail"]
    assert env.read("manifest.json")["reviewQueue"]["byKind"]["unclassified_entry"] == 1


def test_an_application_docket_with_no_recognised_ruling_is_queued_for_a_maintainer(env, session):
    entries = [{"Date": "Jan 05 2026", "Text": "Application (99A1) for a stay, submitted to Justice Synthetic."}]
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0001", entries=entries, sJsonCaseType="Application")))
    _, ctx = env.run(COURT)
    assert [r["entity"] for r in ctx.review if r["kind"] == "application_without_ruling"] == ["scotus-99-0001"]
    entries.append({"Date": "Jan 20 2026", "Text": "Application (99A1) denied by the Court."})
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0001", entries=entries, sJsonCaseType="Application")))
    _, ctx = env.run(COURT, now=T2)
    assert [r for r in ctx.review if r["kind"] == "application_without_ruling"] == []


def test_dockets_from_the_same_case_below_point_at_each_other(env, session):
    env.run(COURT)
    first = env.read("litigation/cases/scotus-99-0001.json")
    second = env.read("litigation/cases/scotus-99-0002.json")
    assert first["sameLowerCourt"] == [{"caseId": "scotus-99-0002", "docket": "99-0002", "caseName": second["caseName"], "number": "25-9998"}]
    assert second["sameLowerCourt"][0]["caseId"] == "scotus-99-0001"
    assert all("sameLowerCourt" not in row for row in env.read("litigation/index.json")["cases"])
    # The same number in a different court is a different case.
    session.on(docket_url("99-0002"), FakeResponse(200, synthetic_docket("99-0002", LowerCourt="Supreme Court of Synthetica")))
    env.run(COURT, now=T2)
    assert env.read("litigation/cases/scotus-99-0001.json")["sameLowerCourt"] == []
    assert env.read("litigation/cases/scotus-99-0002.json")["sameLowerCourt"] == []


SYNTHETIC_CIRCUIT = "United States Court of Appeals for the Synthetic Circuit"


def appeal(case_id: str, docket: str, court: str = "ca5") -> dict:
    return {"id": case_id, "docketNumber": docket, "caseName": f"Synthetic {case_id}", "courtId": court}


def docket_from(number: str, court: str, *numbers: str) -> dict:
    return {"id": f"scotus-{number}", "docketNumber": number, "caseName": f"Synthetic docket {number}",
            "sourceUrl": f"https://www.supremecourt.gov/docket/{number}.html", "lowerCourt": {"name": court, "caseNumbers": list(numbers)}}


def test_a_docket_is_paired_with_the_case_below_only_by_the_court_and_number_the_docket_gives():
    names = {SYNTHETIC_CIRCUIT.casefold(): "ca5", "united states court of appeals for the other circuit": "ca8"}
    appeals = [appeal("ca5-25-09999", "25-9999"), appeal("ca8-25-09998", "25-9998", "ca8"), appeal("ca5-24-00007", "24-7")]
    links = pipeline.cases_below([
        docket_from("99-0001", SYNTHETIC_CIRCUIT, "25-9999", "25-9998"),              # the second number is a case of another court
        docket_from("99-0002", SYNTHETIC_CIRCUIT.upper(), "24-00007"),                # letter case and leading zeros do not matter
        docket_from("99-0003", "Supreme Court of Synthetica", "25-9999"),             # not a court of appeals
        docket_from("99-0004", SYNTHETIC_CIRCUIT, "3:25-cv-9999", "25-9999-cv"),      # numbers of another form
        docket_from("99-0005", SYNTHETIC_CIRCUIT),
    ], appeals, names)
    assert links == [
        {"id": "below-scotus-99-0001-ca5-25-09999", "ruleId": "case-below-1",
         "review": {"caseId": "scotus-99-0001", "docket": "99-0001", "caseName": "Synthetic docket 99-0001"},
         "below": {"caseId": "ca5-25-09999", "docket": "25-9999", "caseName": "Synthetic ca5-25-09999", "courtId": "ca5"},
         "court": SYNTHETIC_CIRCUIT, "number": "25-9999", "sourceUrl": "https://www.supremecourt.gov/docket/99-0001.html"},
        {"id": "below-scotus-99-0002-ca5-24-00007", "ruleId": "case-below-1",
         "review": {"caseId": "scotus-99-0002", "docket": "99-0002", "caseName": "Synthetic docket 99-0002"},
         "below": {"caseId": "ca5-24-00007", "docket": "24-7", "caseName": "Synthetic ca5-24-00007", "courtId": "ca5"},
         "court": SYNTHETIC_CIRCUIT.upper(), "number": "24-00007", "sourceUrl": "https://www.supremecourt.gov/docket/99-0002.html"},
    ]
    # A number that would name two cases of the court is paired with neither.
    twice = [appeal("ca5-25-09999", "25-9999"), appeal("ca5-25-9999", "25-09999")]
    assert pipeline.cases_below([docket_from("99-0001", SYNTHETIC_CIRCUIT, "25-9999")], twice, names) == []


def test_the_pairings_are_published_with_the_links_and_only_for_cases_in_the_dataset(env):
    # Both dockets name the Synthetic Circuit and Nos. 25-9999 and 25-9998 as the case below.
    env.run(COURT)
    assert env.read("relationships.json")["caseLinks"] == []          # no court of appeals case is published
    write_json(env.public / "geo" / "circuits.json", {"courts": [{"id": "ca5", "name": SYNTHETIC_CIRCUIT}]})
    write_json(env.public / "circuits" / "index.json", {"cases": [appeal("ca5-25-09998", "25-9998")]})
    env.run(["relationships"], now=T2)
    links = env.read("relationships.json")["caseLinks"]
    assert [(link["review"]["caseId"], link["below"]["caseId"], link["number"]) for link in links] == [
        ("scotus-99-0001", "ca5-25-09998", "25-9998"), ("scotus-99-0002", "ca5-25-09998", "25-9998")]
    assert links[0]["sourceUrl"] == env.read("litigation/cases/scotus-99-0001.json")["sourceUrl"]
    assert "case-below-1" in {rule["ruleId"] for rule in env.read("classification.json")["otherRules"]}


def test_the_timeline_carries_a_long_court_order_in_full(env, session):
    long_order = "Application (99A1) granted by the Court. " + "The order of the court below is stayed pending appeal. " * 30 + "Justice Synthetic dissents."
    assert len(long_order) > 1500
    docket = synthetic_docket("99-0001")
    docket["ProceedingsandOrder"].append({"Date": "Mar 20 2026", "Text": long_order})
    session.on(docket_url("99-0001"), FakeResponse(200, docket))
    env.run(COURT)
    event = next(e for e in env.read("events.json")["events"] if e["eventType"] == "application_ruling")
    assert event["description"] == long_order


def test_timeline_holds_only_major_dated_entries_with_their_source_and_rule(env):
    env.run(COURT)
    events = env.read("events.json")["events"]
    assert {e["eventType"] for e in events} == {"initiating_filing", "review_denied"}
    assert all(e["ruleId"] and e["sourceUrl"].startswith("https://www.supremecourt.gov/") for e in events)
    assert [e["date"] for e in events] == sorted((e["date"] for e in events), reverse=True)
    # A Supreme Court docket is listed under the nation and under the places it is linked to.
    assert {tuple(e["geoKeys"]) for e in events if e["entityId"] == "scotus-99-0001"} == {("nation:US", "state:06")}


def test_source_metadata_is_recorded_for_every_source(env):
    env.run(COURT)
    record = env.source("scotus-docket")
    assert record["processingStatus"] == "ok"
    assert record["lastSuccessfulCheck"] == record["lastAttempt"] == record["retrievedAt"] == T1
    assert record["recordCount"] == 2
    for source in env.read("sources.json")["sources"]:
        assert source["url"].startswith("https://") and source["license"] and source["attribution"]
        assert source["knownLimitations"] is not None and source["staleAfterDays"] > 0
    assert env.source("ca-leginfo-bulk")["processingStatus"] == "not_run"
    assert env.source("ca-leginfo-bulk")["lastSuccessfulCheck"] is None


def test_published_rule_ids_cover_every_rule_cited_by_the_data(env):
    env.run(COURT)
    rules = env.read("classification.json")
    known = {r["ruleId"] for group in ("issueRules", "docketEntryRules", "legislativeActionRules", "otherRules") for r in rules[group]} | {"sc-other"}
    cited = {e["ruleId"] for e in env.read("events.json")["events"]} | {r["ruleId"] for r in env.read("relationships.json")["relationships"]}
    for case in env.read("litigation/index.json")["cases"]:
        cited |= {t["ruleId"] for t in case["issueTags"]} | {case["about"]["ruleId"]}
    assert cited <= known and "about-question-1" in cited


# --- idempotence and timestamps -------------------------------------------------------

def test_the_same_input_at_the_same_time_gives_identical_bytes(env):
    env.run(COURT)
    first = tree(env.public)
    env.run(COURT)
    assert tree(env.public) == first


def test_a_later_run_moves_only_the_check_time(env):
    env.run(COURT, now=T1)
    before = env.read("litigation/cases/scotus-99-0001.json")
    env.run(COURT, now=T2)
    after = env.read("litigation/cases/scotus-99-0001.json")
    assert after["firstObservedAt"] == before["firstObservedAt"] == T1
    assert (before["lastCheckedAt"], after["lastCheckedAt"]) == (T1, T2)
    assert after["contentHash"] == before["contentHash"]
    assert after["sourceLastActivity"] == before["sourceLastActivity"]  # the court's date is not ours to move
    assert env.source("scotus-docket")["lastSuccessfulCheck"] == T2


def test_duplicate_seed_entries_produce_one_record(env):
    seeds = read_json(env.seeds_dir / "cases.json")
    seeds["cases"].append({"docket": "99-0001", "evidence": "qp", "geographies": []})
    write_json(env.seeds_dir / "cases.json", seeds)
    _, ctx = env.run(COURT)
    ids = [c["id"] for c in env.read("litigation/index.json")["cases"]]
    assert sorted(ids) == ["scotus-99-0001", "scotus-99-0002"]
    assert ("duplicate_seed", "scotus-99-0001") in [(r["kind"], r["entity"]) for r in ctx.review]
    rel_ids = [r["id"] for r in env.read("relationships.json")["relationships"]]
    assert len(rel_ids) == len(set(rel_ids))


# --- failure recovery: verified data is never replaced by a bad response ---------------

def bad_then_check(env, session, answer, kind="fetch_failed"):
    env.run(COURT, now=T1)
    kept_case = (env.public / "litigation/cases/scotus-99-0001.json").read_bytes()
    session.on(docket_url("99-0001"), answer)
    code, ctx = env.run(COURT, now=T2)
    assert (env.public / "litigation/cases/scotus-99-0001.json").read_bytes() == kept_case
    assert env.read("litigation/cases/scotus-99-0001.json")["lastCheckedAt"] == T1  # shows as not refreshed
    assert env.read("litigation/cases/scotus-99-0002.json")["lastCheckedAt"] == T2  # the healthy docket moved on
    assert (kind, "scotus-99-0001") in [(r["kind"], r["entity"]) for r in ctx.review]
    rels = {r["id"]: r for r in env.read("relationships.json")["relationships"]}
    assert rels["rel-scotus-99-0001-state-06"]["verification"] == {"status": "verified_primary", "method": "maintainer_curated", "checkedAt": T1,
                                                                    "note": rels["rel-scotus-99-0001-state-06"]["verification"]["note"]}
    return code, ctx


def test_an_unavailable_source_keeps_the_last_verified_record(env, session):
    code, _ = bad_then_check(env, session, FakeResponse(503))
    assert code == 0
    record = env.source("scotus-docket")
    assert record["processingStatus"] == "ok"
    assert record["statusDetail"] == "1 of 2 dockets could not be refreshed; last verified copies kept"


def test_a_network_failure_keeps_the_last_verified_record(env, session):
    bad_then_check(env, session, requests.ConnectionError("synthetic outage"))


def test_an_html_error_page_served_with_status_200_is_not_parsed(env, session):
    bad_then_check(env, session, FakeResponse(200, "<html><body>Service temporarily unavailable</body></html>"))


@pytest.mark.parametrize("cut", ["before the proceedings", "inside the last entry"])
def test_a_truncated_docket_page_is_not_published(env, session, cut):
    page = render_docket_page(synthetic_docket("99-0001"))
    end = page.index('id="proceedings"') if cut == "before the proceedings" else page.index("Petition DENIED.")
    # Cut before the entries, the page is not a docket page; cut inside them, it has fewer entries than the published record.
    bad_then_check(env, session, FakeResponse(200, page[:end]), kind="fetch_failed" if cut == "before the proceedings" else "regression")


def test_a_payload_for_another_docket_is_not_published(env, session):
    bad_then_check(env, session, FakeResponse(200, synthetic_docket("99-0777")))


def test_a_payload_missing_required_fields_is_not_published(env, session):
    payload = synthetic_docket("99-0001")
    payload["ProceedingsandOrder"] = [{"Date": "not a date", "Text": "Petition DENIED."}]
    bad_then_check(env, session, FakeResponse(200, payload))


def test_a_docket_that_suddenly_has_fewer_entries_is_held_for_review(env, session):
    shorter = synthetic_docket("99-0001")
    shorter["ProceedingsandOrder"] = shorter["ProceedingsandOrder"][:2]
    env.run(COURT, now=T1)
    kept = (env.public / "litigation/cases/scotus-99-0001.json").read_bytes()
    session.on(docket_url("99-0001"), FakeResponse(200, shorter))
    code, ctx = env.run(COURT, now=T2)
    assert code == 0
    assert (env.public / "litigation/cases/scotus-99-0001.json").read_bytes() == kept
    flagged = [r for r in ctx.review if r["kind"] == "regression"]
    assert len(flagged) == 1 and "2 < 4" in flagged[0]["detail"]


def test_a_docket_that_grows_is_updated(env, session):
    longer = synthetic_docket("99-0001")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    env.run(COURT, now=T1)
    old_hash = env.read("litigation/cases/scotus-99-0001.json")["contentHash"]
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert case["contentHash"] != old_hash
    assert case["entryCount"] == 5 and case["sourceLastActivity"] == "2026-04-01"
    assert case["events"][-1]["eventType"] == "rehearing_ruling"
    assert case["latestDispositiveEntry"]["text"] == "Petition DENIED."  # a rehearing ruling does not replace the disposition
    assert (case["firstObservedAt"], case["lastCheckedAt"]) == (T1, T2)  # first seen on the first run, last checked now


def test_when_every_docket_fails_the_source_is_marked_failed_and_data_stays(env, session):
    env.run(COURT, now=T1)
    before = tree(env.public / "litigation")
    session.on(docket_url("99-0001"), FakeResponse(503))
    session.on(docket_url("99-0002"), FakeResponse(503))
    code, _ = env.run(COURT, now=T2)
    assert tree(env.public / "litigation") == before
    record = env.source("scotus-docket")
    assert record["processingStatus"] == "failed"
    assert record["lastSuccessfulCheck"] == T1  # staleness stays visible
    assert record["lastAttempt"] == T2
    assert "2 of 2 dockets could not be refreshed" in record["statusDetail"]
    assert env.read("manifest.json")["sources"]["scotus-docket"]["processingStatus"] == "failed"
    assert code == 1  # no stage raised, but a failed source must still fail the scheduled run


def test_a_first_run_with_no_data_publishes_no_empty_dataset(env, session):
    session.on(docket_url("99-0001"), FakeResponse(503))
    session.on(docket_url("99-0002"), FakeResponse(503))
    code, _ = env.run(COURT, now=T1)
    assert code == 1
    assert not (env.public / "litigation").exists()
    record = env.source("scotus-docket")
    assert record["processingStatus"] == "failed" and record["lastSuccessfulCheck"] is None
    assert "no Supreme Court dockets could be retrieved" in record["statusDetail"]


def test_a_crashing_stage_does_not_stop_the_others(env, monkeypatch):
    def boom(ctx):
        ctx.published_dirs.append("legislation")
        raise RuntimeError("synthetic crash")

    monkeypatch.setitem(pipeline.STAGES, "california", (boom, ["ca-leginfo-bulk"]))
    code, _ = env.run(["california", *COURT])
    assert code == 1
    assert len(env.read("litigation/index.json")["cases"]) == 2
    assert not (env.public / "legislation").exists()
    record = env.source("ca-leginfo-bulk")
    assert record["processingStatus"] == "failed" and record["statusDetail"] == "RuntimeError: synthetic crash"


def test_invalid_output_blocks_the_whole_publication(env, monkeypatch):
    env.run(COURT, now=T1)
    before = tree(env.public)

    def corrupt(ctx):
        pipeline.stage_scotus(ctx)
        path = ctx.staging / "litigation" / "cases" / "scotus-99-0001.json"
        record = read_json(path)
        record["dateDocketed"] = "10 January 2026"  # not an ISO date
        record["sourceUrl"] = "http://insecure.example.test/"
        write_json(path, record)

    monkeypatch.setitem(pipeline.STAGES, "scotus", (corrupt, ["scotus-docket"]))
    code, _ = env.run(COURT, now=T2)
    assert code == 2
    assert tree(env.public) == before  # nothing at all was replaced


# --- curated links between records ----------------------------------------------------

def test_links_to_unknown_records_are_dropped_and_reported(env):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [
        {"source": "case:scotus-99-0001", "target": "bill:zz-does-not-exist", "relationshipType": "litigation_concerns_measure",
         "scope": {"kind": "statewide"}, "evidenceIn": "case:scotus-99-0001", "quote": "congressional districting plan, enacted as Synthetic Bill 9"},
        {"source": "case:scotus-99-0001", "target": "geography:state:06", "relationshipType": "names_measure",
         "scope": {"kind": "statewide"}, "evidenceIn": "case:scotus-99-0001", "quote": "the State of California's congressional districting plan, enacted as Synthetic Bill 9"},
    ]})
    _, ctx = env.run(COURT)
    ids = [r["id"] for r in env.read("relationships.json")["relationships"]]
    assert "rel-scotus-99-0001-names-measure-state-06" in ids
    assert not any("zz-does-not-exist" in i for i in ids)
    assert [(r["kind"], r["detail"]) for r in ctx.review if r["kind"] == "relationship_dropped"] == [("relationship_dropped", "unknown bill zz-does-not-exist")]


def test_a_partial_run_does_not_downgrade_a_link_it_could_not_recheck(env):
    seed = {"source": "case:scotus-99-0001", "target": "geography:state:06", "relationshipType": "names_measure",
            "scope": {"kind": "statewide"}, "evidenceIn": "case:scotus-99-0001", "quote": "the State of California's congressional districting plan, enacted as Synthetic Bill 9"}
    write_json(env.seeds_dir / "relationships.json", {"relationships": [seed]})
    env.run(COURT, now=T1)
    rel_id = "rel-scotus-99-0001-names-measure-state-06"
    first = next(r for r in env.read("relationships.json")["relationships"] if r["id"] == rel_id)
    assert first["verification"]["status"] == "verified_primary"

    # The court stage does not run, so the evidence document is not fetched this time.
    code, ctx = env.run(["relationships", "events"], now=T2)
    assert code == 0 and ctx.review == []
    again = next(r for r in env.read("relationships.json")["relationships"] if r["id"] == rel_id)
    assert again == first  # same status and the same, older, check time
    assert len(env.read("relationships.json")["relationships"]) == 2  # the case-to-place link is kept too

    # If a maintainer edits the quote, the old check no longer covers it.
    write_json(env.seeds_dir / "relationships.json", {"relationships": [{**seed, "quote": "a different quote"}]})
    _, ctx = env.run(["relationships", "events"], now=T3)
    assert rel_id not in [r["id"] for r in env.read("relationships.json")["relationships"]]
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("evidence_unavailable", rel_id)]


NAMES_MEASURE = {"source": "case:scotus-99-0001", "target": "geography:state:06", "relationshipType": "names_measure", "scope": {"kind": "statewide"},
                 "evidenceIn": "case:scotus-99-0001", "quote": "the State of California's congressional districting plan, enacted as Synthetic Bill 9"}
CASE_LINK, SEED_LINK = "rel-scotus-99-0001-state-06", "rel-scotus-99-0001-names-measure-state-06"


def links(env):
    return {r["id"]: r for r in env.read("relationships.json")["relationships"]}


def test_links_a_maintainer_withdrew_are_not_kept_when_the_docket_cannot_be_fetched(env, session):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE]})
    env.run(COURT, now=T1)
    assert {CASE_LINK, SEED_LINK} <= set(links(env))
    seeds = read_json(env.seeds_dir / "cases.json")
    seeds["cases"][0]["geographies"] = []
    write_json(env.seeds_dir / "cases.json", seeds)
    write_json(env.seeds_dir / "relationships.json", {"relationships": []})
    session.on(docket_url("99-0001"), FakeResponse(503))
    code, ctx = env.run(COURT, now=T2)
    assert code == 0 and not {CASE_LINK, SEED_LINK} & set(links(env))
    kept = env.read("litigation/cases/scotus-99-0001.json")
    assert kept["lastCheckedAt"] == T1 and kept["stateFips"] == []  # no published link files it under California any more
    assert [(r["kind"], r["entity"]) for r in ctx.review if r["entity"].startswith("scotus-99-0001")] == [("fetch_failed", "scotus-99-0001")]
    # A run that does not fetch dockets at all does not bring the withdrawn link back either.
    env.run(["relationships", "events"], now=T3)
    assert CASE_LINK not in links(env)


def test_when_the_docket_cannot_be_fetched_each_link_is_kept_once_with_its_last_check(env, session):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE]})
    env.run(COURT, now=T1)
    before = links(env)
    session.on(docket_url("99-0001"), FakeResponse(503))
    code, ctx = env.run(COURT, now=T2)
    assert code == 0
    assert links(env)[CASE_LINK] == before[CASE_LINK] and links(env)[SEED_LINK] == before[SEED_LINK]  # checked at T1
    assert not [r for r in ctx.review if r["kind"] == "relationship_dropped"]


def test_a_link_whose_seed_was_edited_is_not_kept_on_its_old_check(env, session):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE]})
    env.run(COURT, now=T1)
    seeds = read_json(env.seeds_dir / "cases.json")
    seeds["cases"][0]["geographies"][0]["quote"] = "Whether the State of California's congressional districting plan is lawful"
    write_json(env.seeds_dir / "cases.json", seeds)
    write_json(env.seeds_dir / "relationships.json", {"relationships": [{**NAMES_MEASURE, "quote": "a quote the maintainer corrected"}]})
    session.on(docket_url("99-0001"), FakeResponse(503))
    _, ctx = env.run(COURT, now=T2)
    assert not {CASE_LINK, SEED_LINK} & set(links(env))
    flagged = {(r["kind"], r["entity"]) for r in ctx.review}
    assert {("evidence_unavailable", "scotus-99-0001->state:06"), ("evidence_unavailable", SEED_LINK)} <= flagged
    # The same holds when the litigation stage does not run, and for a changed scope.
    seeds["cases"][0]["geographies"][0]["quote"] = CASE_SEEDS["cases"][0]["geographies"][0]["quote"]
    seeds["cases"][0]["geographies"][0]["scope"] = "county"
    write_json(env.seeds_dir / "cases.json", seeds)
    env.run(["relationships", "events"], now=T3)
    assert CASE_LINK not in links(env)


@pytest.mark.parametrize("change", ["withdrawn", "scope", "note"])
@pytest.mark.parametrize("not_rechecked", ["the docket cannot be fetched", "the litigation stage does not run"])
def test_a_published_case_link_whose_seed_changed_is_not_carried(env, session, not_rechecked, change):
    env.run(COURT, now=T1)
    assert CASE_LINK in links(env)
    seeds = read_json(env.seeds_dir / "cases.json")
    if change == "withdrawn":
        seeds["cases"][0]["geographies"] = []
    elif change == "scope":
        seeds["cases"][0]["geographies"][0]["scope"] = "county"
    else:
        seeds["cases"][0]["geographies"][0]["note"] = "A note the maintainer rewrote."
    write_json(env.seeds_dir / "cases.json", seeds)
    if not_rechecked == "the docket cannot be fetched":
        session.on(docket_url("99-0001"), FakeResponse(503))
        _, ctx = env.run(COURT, now=T2)
        assert env.read("litigation/cases/scotus-99-0001.json")["stateFips"] == []
    else:
        _, ctx = env.run(["relationships", "events"], now=T2)
    assert CASE_LINK not in links(env)
    flagged = [(r["kind"], r["entity"]) for r in ctx.review if r["entity"].startswith("scotus-99-0001")]
    expected = [] if change == "withdrawn" else [("evidence_unavailable", "scotus-99-0001->state:06")]
    assert flagged == ([("fetch_failed", "scotus-99-0001")] if not_rechecked == "the docket cannot be fetched" else []) + expected


@pytest.mark.parametrize("edit", [
    {"scope": {"kind": "county", "note": "Only one county."}},
    {"evidenceLabel": "a description of the document the maintainer rewrote"},
    {"evidenceIn": "case:scotus-99-0002"},
], ids=["scope", "evidenceLabel", "evidenceIn"])
def test_when_the_docket_cannot_be_fetched_a_seeded_link_whose_seed_was_edited_is_not_kept(env, session, edit):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE]})
    env.run(COURT, now=T1)
    assert SEED_LINK in links(env)
    write_json(env.seeds_dir / "relationships.json", {"relationships": [{**NAMES_MEASURE, **edit}]})
    for number in ("99-0001", "99-0002"):
        session.on(docket_url(number), FakeResponse(503))
    _, ctx = env.run(COURT, now=T2)
    assert SEED_LINK not in links(env)
    assert links(env)[CASE_LINK]["verification"]["checkedAt"] == T1  # its own seed is unchanged
    assert ("evidence_unavailable", SEED_LINK) in [(r["kind"], r["entity"]) for r in ctx.review]


def test_a_relationship_id_produced_twice_is_an_internal_error_not_a_dropped_link(env):
    env.run(COURT, now=T1)
    before = (env.public / "relationships.json").read_bytes()
    write_json(env.seeds_dir / "relationships.json", {"relationships": [NAMES_MEASURE, {**NAMES_MEASURE, "quote": "California's congressional districting plan"}]})
    code, ctx = env.run(COURT, now=T2)
    assert code == 1
    assert (env.public / "relationships.json").read_bytes() == before
    assert not [r for r in ctx.review if r["kind"] == "relationship_dropped"]


@pytest.mark.parametrize("breakage", ["pdftotext is missing", "an HTML page is served in place of the PDF"])
def test_a_document_that_cannot_be_read_is_a_failed_fetch_not_a_document_without_text(env, session, monkeypatch, breakage):
    env.run(COURT, now=T1)
    before = env.read("litigation/cases/scotus-99-0001.json")
    link_before = links(env)[CASE_LINK]
    monkeypatch.setattr(scotus, "extract_pdf_text", REAL_EXTRACT_PDF_TEXT)
    if breakage == "pdftotext is missing":
        monkeypatch.setenv("PATH", "/nonexistent")
        for number, text in (("99-0001", QP_1), ("99-0002", QP_2)):
            session.on(qp_url(number), FakeResponse(200, b"%PDF-1.4\n" + text.encode()))
    else:
        for number in ("99-0001", "99-0002"):
            session.on(qp_url(number), FakeResponse(200, "<html><body>Please try again later.</body></html>"))
    code, ctx = env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert case["lastCheckedAt"] == T2  # the docket page itself was read and the docket refreshed
    assert case["questionsPresented"] == before["questionsPresented"]  # the text read earlier from the same address
    assert case["issueTags"] == before["issueTags"] and case["stateFips"] == ["06"]
    assert links(env)[CASE_LINK] == link_before  # kept with its earlier check
    assert ("document_unavailable", "scotus-99-0001") in [(r["kind"], r["entity"]) for r in ctx.review]
    record = env.source("scotus-docket")
    assert "2 cited document(s) could not be retrieved or read" in record["statusDetail"]
    assert record["processingStatus"] == "failed" and record["lastSuccessfulCheck"] == T1 and code == 1  # no passage was checked


def test_the_court_reordering_attributes_on_its_links_changes_nothing(env, session):
    page = render_docket_page(synthetic_docket("99-0001"))
    session.on(docket_url("99-0001"), FakeResponse(200, page))
    env.run(COURT, now=T1)
    before = env.read("litigation/cases/scotus-99-0001.json")
    changed = re.sub(r'<a  href= (\S+)\s+class="documentanchor"', r'<a class="documentanchor" href="\1"', page)
    changed = changed.replace('<a href="../qp/99-0001qp.pdf">Questions Presented</a>', '<a href="../qp/99-0001qp.pdf" target="_blank">Questions Presented</a>')
    assert changed != page
    session.on(docket_url("99-0001"), FakeResponse(200, changed))
    code, ctx = env.run(COURT, now=T2)
    after = env.read("litigation/cases/scotus-99-0001.json")
    assert code == 0 and after["lastCheckedAt"] == T2
    assert {k: v for k, v in after.items() if k not in ("lastCheckedAt", "verification")} == {
        k: v for k, v in before.items() if k not in ("lastCheckedAt", "verification")}
    assert links(env)[CASE_LINK]["verification"]["checkedAt"] == T2


@pytest.mark.parametrize("change,shrunk", [
    ("the Questions Presented link is gone", "Questions Presented link 0 < 1"),
    ("the filing links are gone", "documents 0 < 1"),
])
def test_a_docket_that_loses_its_questions_or_its_documents_is_held_for_review(env, session, change, shrunk):
    env.run(COURT, now=T1)
    kept = (env.public / "litigation/cases/scotus-99-0001.json").read_bytes()
    link_before = links(env)[CASE_LINK]
    smaller = synthetic_docket("99-0001", qp=change != "the Questions Presented link is gone")
    if change == "the filing links are gone":
        smaller["ProceedingsandOrder"][0]["Links"] = []
    session.on(docket_url("99-0001"), FakeResponse(200, smaller))
    code, ctx = env.run(COURT, now=T2)
    assert (env.public / "litigation/cases/scotus-99-0001.json").read_bytes() == kept
    assert links(env)[CASE_LINK] == link_before  # the held record keeps its links as they were checked
    flagged = [r["detail"] for r in ctx.review if r["kind"] == "regression"]
    assert len(flagged) == 1 and shrunk in flagged[0]


def unavailable(ctx):
    """Each ``document_unavailable`` item by docket, without the error that opens it."""
    return {r["entity"]: r["detail"].split("; ", 1)[1] for r in ctx.review if r["kind"] == "document_unavailable"}


def test_a_dead_questions_document_does_not_freeze_the_docket(env, session):
    write_json(env.seeds_dir / "cases.json", {"cases": [{"docket": "99-0001", "evidence": "initiating", "geographies": []},
                                                        {"docket": "99-0003", "evidence": "qp", "geographies": []}]})
    session.on(f"{SC}/DocketPDF/99/99-0001/1/petition.pdf", FakeResponse(200, "Petition text about synthetic elections."))
    session.on(docket_url("99-0003"), FakeResponse(200, synthetic_docket("99-0003")))
    session.on(qp_url("99-0003"), FakeResponse(404))
    code, ctx = env.run(COURT, now=T1)
    assert code == 0 and sorted(c["id"] for c in env.read("litigation/index.json")["cases"]) == ["scotus-99-0001", "scotus-99-0003"]
    assert env.read("litigation/cases/scotus-99-0003.json")["questionsPresented"] == {"url": qp_url("99-0003"), "text": None, "textHash": None}
    assert unavailable(ctx) == {"scotus-99-0003": "the docket was published for the first time without it; "
                                                  "no Questions Presented text is published until it can be read"}
    assert env.source("scotus-docket")["statusDetail"] == "1 cited document(s) could not be retrieved or read"
    # Later the Court moves the first docket's Questions Presented file, and the docket gains an entry.
    session.on(qp_url("99-0001"), FakeResponse(404))
    longer = synthetic_docket("99-0001")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    code, ctx = env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert code == 0 and (case["entryCount"], case["lastCheckedAt"]) == (5, T2)
    assert case["questionsPresented"]["text"] == QP_1  # the copy read from the same address on the first run
    assert unavailable(ctx)["scotus-99-0001"] == ("the docket was refreshed without it; "
                                                  "the Questions Presented text read from the same address on an earlier run is kept")
    # A docket that is held for another reason is not said to be refreshed.
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0001")))
    _, ctx = env.run(COURT, now=T3)
    assert env.read("litigation/cases/scotus-99-0001.json")["lastCheckedAt"] == T2
    assert unavailable(ctx)["scotus-99-0001"] == ("the docket was not refreshed: its new record is smaller than the published one "
                                                  "and is held for review, so the published record stays as it was")


def test_a_dead_cited_filing_is_marked_and_what_cites_it_keeps_its_last_check(env, session):
    petition = f"{SC}/DocketPDF/99/99-0001/1/petition.pdf"
    seeds = read_json(env.seeds_dir / "cases.json")
    seeds["cases"][0]["evidence"] = "initiating"
    seeds["cases"][0]["tags"] = [{"tag": "partisan-gerrymandering", "quote": "congressional districting plan, enacted as Synthetic Bill 9"}]
    write_json(env.seeds_dir / "cases.json", seeds)
    session.on(petition, FakeResponse(200, "Petition. " + QP_1))
    env.run(COURT, now=T1)
    tags_before = env.read("litigation/cases/scotus-99-0001.json")["issueTags"]
    link_before = links(env)[CASE_LINK]
    assert link_before["support"]["url"] == petition and "partisan-gerrymandering" in [t["tag"] for t in tags_before]
    session.on(petition, FakeResponse(404))
    longer = synthetic_docket("99-0001")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    code, ctx = env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert code == 0 and (case["entryCount"], case["lastCheckedAt"]) == (5, T2)
    assert case["issueTags"] == tags_before and case["stateFips"] == ["06"]
    assert links(env)[CASE_LINK] == link_before
    filing = next(d for d in case["documents"] if d["url"] == petition)
    assert filing["availability"] == "unavailable" and "answered 404" in filing["accessNote"]
    assert unavailable(ctx)["scotus-99-0001"] == "the docket was refreshed without it; 2 link(s) or tag(s) that cite it keep their last published check"
    assert env.source("scotus-docket")["statusDetail"] == (
        "1 cited document(s) could not be retrieved or read; 2 link(s) or tag(s) that cite them keep their last check")
    # Once the maintainer edits the passage, the earlier check no longer covers it.
    seeds["cases"][0]["geographies"][0]["quote"] = "Whether the State of California's congressional districting plan is lawful"
    seeds["cases"][0]["tags"][0]["quote"] = "California's congressional districting plan"
    write_json(env.seeds_dir / "cases.json", seeds)
    _, ctx = env.run(COURT, now=T3)
    assert CASE_LINK not in links(env)
    assert "partisan-gerrymandering" not in [t["tag"] for t in env.read("litigation/cases/scotus-99-0001.json")["issueTags"]]
    flagged = {(r["kind"], r["entity"]) for r in ctx.review}
    assert {("evidence_unavailable", "scotus-99-0001->state:06"), ("curated_tag_check_failed", "scotus-99-0001#partisan-gerrymandering")} <= flagged
    assert unavailable(ctx)["scotus-99-0001"] == ("the docket was refreshed without it; 2 link(s) or tag(s) that cite it are not published, "
                                                  "as no earlier check of the same passage applies")
    assert env.source("scotus-docket")["statusDetail"].endswith("; 2 link(s) or tag(s) that cite them are not published")


def test_what_the_rules_found_in_an_initiating_filing_that_cannot_be_read_is_kept(env, session):
    petition = f"{SC}/DocketPDF/99/99-0001/1/petition.pdf"
    write_json(env.seeds_dir / "cases.json", {"cases": [{"docket": "99-0001", "evidence": "initiating", "geographies": []}]})
    session.on(docket_url("99-0001"), FakeResponse(200, synthetic_docket("99-0001", qp=False)))  # no Questions Presented
    session.on(petition, FakeResponse(200, "Petition.\n\n" + "\n\n".join(["The State redrew its congressional districting plan in 2025."] * 6)))
    env.run(COURT, now=T1)
    tags_before = env.read("litigation/cases/scotus-99-0001.json")["issueTags"]
    assert [(t["tag"], t["matchedField"]) for t in tags_before] == [("redistricting", pipeline.LONG_EVIDENCE_FIELD)]
    session.on(petition, FakeResponse(404))
    longer = synthetic_docket("99-0001", qp=False)
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    code, ctx = env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert (case["entryCount"], case["lastCheckedAt"]) == (5, T2)
    assert case["issueTags"] == tags_before
    assert unavailable(ctx)["scotus-99-0001"] == "the docket was refreshed without it; 1 link(s) or tag(s) that cite it keep their last published check"


def test_a_questions_document_moved_to_an_address_that_cannot_be_read_does_not_hold_the_docket(env, session):
    env.run(COURT, now=T1)
    before = env.read("litigation/cases/scotus-99-0001.json")
    link_before = links(env)[CASE_LINK]
    moved = f"{SC}/qp/99-0001qp_new.pdf"
    longer = synthetic_docket("99-0001", QPLink="../qp/99-0001qp_new.pdf")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    session.on(moved, FakeResponse(404))
    code, ctx = env.run(COURT, now=T2)
    case = env.read("litigation/cases/scotus-99-0001.json")
    assert code == 0 and (case["entryCount"], case["lastCheckedAt"]) == (5, T2)
    # The text read from the old address is not shown as the text of the new one.
    assert case["questionsPresented"] == {"url": moved, "text": None, "textHash": None}
    # What the rules found in it, and the link citing it, keep their last check, as for any document that cannot be read.
    assert case["issueTags"] == before["issueTags"] and case["stateFips"] == ["06"]
    assert links(env)[CASE_LINK] == link_before
    assert "regression" not in [r["kind"] for r in ctx.review]
    assert unavailable(ctx)["scotus-99-0001"] == ("the docket was refreshed without it; no Questions Presented text is published until it can be read; "
                                                  "2 link(s) or tag(s) that cite it keep their last published check")


def test_only_docket_pages_and_their_documents_are_requested_never_the_excluded_feed_folder(env, session):
    """The Court's robots.txt excludes /rss/ and sets a crawl delay of one second."""
    env.run(COURT)
    assert session.urls() == [docket_url("99-0001"), qp_url("99-0001"), docket_url("99-0002"), qp_url("99-0002")]
    assert not any("/rss/" in url.lower() for url in session.urls("GET") + session.urls("HEAD"))
    assert scotus.MIN_INTERVAL >= 1.0


# --- legislation stage with a synthetic archive ---------------------------------------

LAWS = ["california", "relationships", "events"]


def test_legislation_run_publishes_selected_bills_with_mirrored_text(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    code, _ = env.run(LAWS)
    assert code == 0
    index = env.read("legislation/index.json")
    assert sorted(b["identifier"] for b in index["bills"]) == ["AB 1", "AB 5", "ACA 3"]
    assert index["selection"]["ruleId"] == "ca-select-2" and index["selection"]["totalBillsInSession"] == 5
    bill = env.read("legislation/bills/ca-20252026-ab1.json")
    assert bill["selection"] == {"ruleId": "ca-select-2", "matchedText": "Elections", "matchedField": "official subject line (latest version)"}
    # The list carries the words the rule matched and what the bill would do, quoted from the Legislative Counsel's Digest.
    listed = next(b for b in index["bills"] if b["id"] == bill["id"])
    assert listed["selection"] == bill["selection"] and listed["about"] == bill["about"]
    assert (bill["about"]["source"], bill["about"]["ruleId"], bill["about"]["url"]) == ("digest", "about-digest-1", bill["officialUrl"])
    assert bill["about"]["text"] in " ".join(bill["digest"].split())
    assert all(t["ruleId"] and t["matchedField"] and t["matchedText"] for t in bill["issueTags"])
    for version in bill["versions"]:
        text = env.read(version["textPath"])
        assert text["textHash"] == version["textHash"] and text["instrumentId"] == bill["id"]
    events = [e for e in env.read("events.json")["events"] if e["entityId"] == bill["id"]]
    assert {e["eventType"] for e in events} == {"introduced", "passed_house", "approved_by_governor", "chaptered", "text_version_changed"}
    assert all(e["geoKeys"] == ["state:06"] and e["ruleId"] for e in events)
    assert env.source("ca-leginfo-bulk")["sourcePublishedAt"] == "2026-06-01T08:00:00Z"


def test_a_bill_that_loses_versions_is_held_and_published_text_is_never_deleted(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(extra_version=True))
    env.run(LAWS, now=T1)
    kept = (env.public / "legislation/bills/ca-20252026-ab5.json").read_bytes()
    assert (env.public / "legislation/text/20250AB598AMD.json").exists()

    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(extra_version=False), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    assert (env.public / "legislation/bills/ca-20252026-ab5.json").read_bytes() == kept
    assert [(r["kind"], r["entity"]) for r in ctx.review if r["kind"] == "regression"] == [("regression", "ca-20252026-ab5")]
    assert (env.public / "legislation/text/20250AB598AMD.json").exists()  # an official version, once mirrored, stays


def test_one_unreadable_bill_does_not_take_the_others_down(env, session, monkeypatch):
    from dhq.adapters import ca_leginfo

    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    kept = (env.public / "legislation/bills/ca-20252026-ab5.json").read_bytes()
    real = ca_leginfo.build_instrument

    def flaky(archive, entry, history, **kw):
        if entry["bill"][0] == syn.E:
            raise ValueError("synthetic parse failure")
        return real(archive, entry, history, **kw)

    monkeypatch.setattr(ca_leginfo, "build_instrument", flaky)
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    assert (env.public / "legislation/bills/ca-20252026-ab5.json").read_bytes() == kept  # still checked at T1
    assert env.read("legislation/bills/ca-20252026-ab1.json")["lastCheckedAt"] == T2
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("bill_failed", "ca-20252026-ab5")]
    assert env.source("ca-leginfo-bulk")["statusDetail"].startswith("1 of 3 bills could not be rebuilt")
    assert len(env.read("legislation/index.json")["bills"]) == 3


def test_later_stages_do_not_read_what_a_failed_stage_staged(env, session, monkeypatch):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    bill_events = [e for e in env.read("events.json")["events"] if e["entityType"] == "bill"]
    assert bill_events
    index_before = (env.public / "legislation/index.json").read_bytes()

    def half_done(ctx):
        write_json(ctx.staging / "legislation/index.json", {"bills": []})
        raise RuntimeError("synthetic crash after staging")

    monkeypatch.setitem(pipeline.STAGES, "california", (half_done, ["ca-leginfo-bulk"]))
    code, _ = env.run(LAWS, now=T2)
    assert code == 1
    assert (env.public / "legislation/index.json").read_bytes() == index_before
    assert [e for e in env.read("events.json")["events"] if e["entityType"] == "bill"] == bill_events


def test_the_source_register_names_the_current_selection_rule():
    from dhq.adapters import ca_leginfo
    from dhq.sources import SOURCES

    text = " ".join(SOURCES["ca-leginfo-bulk"]["knownLimitations"])
    assert ca_leginfo.SELECTION_RULE_ID in text
    assert not re.search(r"ca-select-(?!" + ca_leginfo.SELECTION_RULE_ID.split("-")[-1] + r"\b)\d", text)


def test_an_archive_where_nothing_matches_is_refused(env, session):
    from conftest import make_zip

    members = syn.members()
    table = members["BILL_VERSION_TBL.dat"]
    for word in (b"Elections", b"Voter registration", b"ballots"):
        table = table.replace(word, b"Parking")
    members["BILL_VERSION_TBL.dat"] = table
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members))
    code, _ = env.run(LAWS)
    assert code == 1
    assert not (env.public / "legislation").exists()
    assert "refusing to publish an empty legislation set" in env.source("ca-leginfo-bulk")["statusDetail"]


def blocks_of(env, version_id):
    return [text for kind, text in env.read(f"legislation/text/{version_id}.json")["blocks"] if kind == "p"]


def test_a_re_export_that_renumbers_the_text_members_does_not_move_text_between_versions(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.positional_archive())
    env.run(LAWS, now=T1)
    assert blocks_of(env, "20250AB199INT") == [syn.P1, syn.P2]
    # The next weekly export places a new version first, so every member after it is renumbered. The cache is kept.
    session.serve_bytes(syn.ARCHIVE_URL, syn.positional_archive(insert_first=True), last_modified="Mon, 08 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0 and ctx.review == []
    assert blocks_of(env, "20250AB199INT") == [syn.P1, syn.P2]  # still the introduced text, not the amended one
    assert blocks_of(env, "20250AB198AMD") == [syn.P1_AMENDED, syn.P2]
    assert env.read("legislation/bills/ca-20252026-ab1.json")["lastCheckedAt"] == T2


def test_a_text_that_names_another_version_fails_its_bill_and_the_last_verified_record_stays(env, session, tmp_path):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    kept_bill = (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes()
    kept_text = (env.public / "legislation/text/20250AB199INT.json").read_bytes()
    members = syn.members()
    members["lob/a99.lob"] = members["lob/a98.lob"]  # the member listed for the introduced version holds the amended text
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    assert (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes() == kept_bill
    assert (env.public / "legislation/text/20250AB199INT.json").read_bytes() == kept_text
    flagged = [r for r in ctx.review if r["kind"] == "bill_failed"]
    assert [r["entity"] for r in flagged] == ["ca-20252026-ab1"] and "identifies itself as '20250AB__000198AMD'" in flagged[0]["detail"]
    assert env.source("ca-leginfo-bulk")["statusDetail"].startswith(
        "1 of 3 bills could not be rebuilt (1 because a version's text could not be read, parsed or matched to its version)")


@pytest.mark.parametrize("member", [None, b"<caml:MeasureDoc", b""], ids=["unreadable", "unparseable", "empty"])
def test_a_version_text_that_cannot_be_read_never_turns_mirrored_text_into_a_bare_link(env, session, tmp_path, member):
    write_json(env.seeds_dir / "relationships.json", {"relationships": [
        {"source": "bill:ca-20252026-ab1", "target": "bill:ca-20252026-aca3", "relationshipType": "synthetic_reference", "scope": {"kind": "statewide"},
         "evidenceIn": "bill:ca-20252026-ab1", "quote": "A third synthetic section is added."}]})
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    kept = (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes()
    members = syn.members()
    if member is None:
        del members["lob/a97.lob"]
    else:
        members["lob/a97.lob"] = member
    shutil.rmtree(tmp_path / "cache")  # as on a CI runner whose cache was lost
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes() == kept
    assert (env.public / "legislation/text/20250AB197CHP.json").exists()
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("bill_failed", "ca-20252026-ab1")]
    assert "20250AB197CHP" in ctx.review[0]["detail"]
    assert "1 because a version's text could not be read" in env.source("ca-leginfo-bulk")["statusDetail"]
    assert [r["id"] for r in env.read("relationships.json")["relationships"]] == ["rel-ca-20252026-ab1-synthetic-reference-ca-20252026-aca3"]


def test_a_new_bill_whose_listed_text_member_is_empty_is_not_published_as_a_bare_link(env, session):
    members = syn.members()
    members["lob/a97.lob"] = b""  # listed in the version table, but holds nothing
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members))
    code, ctx = env.run(LAWS, now=T1)
    assert code == 0
    assert sorted(b["identifier"] for b in env.read("legislation/index.json")["bills"]) == ["AB 5", "ACA 3"]
    assert not (env.public / "legislation/bills/ca-20252026-ab1.json").exists()
    assert [(r["kind"], r["entity"]) for r in ctx.review] == [("bill_failed", "ca-20252026-ab1")]
    assert "20250AB197CHP" in ctx.review[0]["detail"] and "empty" in ctx.review[0]["detail"]
    assert "1 because a version's text could not be read" in env.source("ca-leginfo-bulk")["statusDetail"]


def test_a_bill_whose_mirrored_texts_shrink_is_held_for_review(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    kept = (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes()
    # Same versions and history, but the export no longer gives the chaptered version a text member.
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(with_chaptered_text=False), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    assert (env.public / "legislation/bills/ca-20252026-ab1.json").read_bytes() == kept
    assert (env.public / "legislation/text/20250AB197CHP.json").exists()
    flagged = [r["detail"] for r in ctx.review if r["kind"] == "regression"]
    assert len(flagged) == 1 and "mirrored texts 2 < 3" in flagged[0]
    assert "1 rebuilt bill(s) were smaller than the published record" in env.source("ca-leginfo-bulk")["statusDetail"]


@pytest.mark.parametrize("cause", ["every bill fails to build", "every bill is smaller than the published one"])
def test_when_no_bill_is_refreshed_the_source_is_marked_failed(env, session, monkeypatch, cause):
    from dhq.adapters import ca_leginfo

    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    before = tree(env.public / "legislation")
    if cause == "every bill fails to build":
        def broken(*args, **kwargs):
            raise ValueError("synthetic: every bill fails to rebuild")
        monkeypatch.setattr(ca_leginfo, "build_instrument", broken)
        session.serve_bytes(syn.ARCHIVE_URL, syn.archive(), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    else:
        members = syn.members()
        members["BILL_HISTORY_TBL.dat"] = b"\n"  # a truncated history table
        session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, _ = env.run(LAWS, now=T2)
    assert code == 1
    assert tree(env.public / "legislation") == before
    record = env.source("ca-leginfo-bulk")
    assert record["processingStatus"] == "failed" and record["lastSuccessfulCheck"] == T1 and record["lastAttempt"] == T2
    assert "3 " in record["statusDetail"] and env.read("manifest.json")["sources"]["ca-leginfo-bulk"]["processingStatus"] == "failed"


def test_a_held_bill_publishes_none_of_the_rejected_texts(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(extra_version=True))
    env.run(LAWS, now=T1)
    # The next export reissues AB 5's amended version under a new id, and one of its history rows was withdrawn.
    members = syn.members(extra_version=True)
    members["BILL_VERSION_TBL.dat"] = members["BILL_VERSION_TBL.dat"].replace(b"20250AB598AMD", b"20250AB597AMD")
    members["lob/e98.lob"] = members["lob/e98.lob"].replace(syn.caml_id("20250AB598AMD").encode(), syn.caml_id("20250AB597AMD").encode())
    members["BILL_HISTORY_TBL.dat"] = b"\n".join(line for line in members["BILL_HISTORY_TBL.dat"].split(b"\n") if f"`{syn.E}`".encode() not in line) + b"\n"
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0 and [(r["kind"], r["entity"]) for r in ctx.review] == [("regression", "ca-20252026-ab5")]
    referenced = {v["textPath"].split("/")[-1] for b in env.read("legislation/index.json")["bills"]
                  for v in env.read(f"legislation/bills/{b['id']}.json")["versions"] if v.get("textPath")}
    assert {p.name for p in (env.public / "legislation/text").glob("*.json")} == referenced
    assert not (env.public / "legislation/text/20250AB597AMD.json").exists()


def test_a_staged_text_no_bill_points_at_blocks_the_whole_publication(env, session, monkeypatch):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    before = tree(env.public)

    def with_orphan(ctx):
        pipeline.stage_california(ctx)
        write_json(ctx.staging / "legislation/text/20250AB100INT.json", {"versionId": "20250AB100INT", "blocks": []})

    monkeypatch.setitem(pipeline.STAGES, "california", (with_orphan, ["ca-leginfo-bulk"]))
    code, _ = env.run(LAWS, now=T2)
    assert code == 2
    assert tree(env.public) == before


# --- optional credentials -------------------------------------------------------------

def test_missing_credentials_are_reported_and_break_nothing(env, session):
    code, ctx = env.run(["courtlistener", "openstates", *COURT])
    assert code == 0
    for source_id, name in (("courtlistener-api", "COURTLISTENER_API_TOKEN"), ("openstates-api", "OPENSTATES_API_KEY")):
        record = env.source(source_id)
        assert record["processingStatus"] == "credential_missing"
        assert name in record["statusDetail"] and record["credentialEnv"] == name
        assert record["lastSuccessfulCheck"] is None
    assert not (env.public / "decisions").exists()
    assert not (env.public / "legislation_secondary.json").exists()
    assert not (env.public / "state-legislation").exists()
    assert len(env.read("litigation/index.json")["cases"]) == 2
    assert not any("courtlistener.com" in u or "openstates.org" in u for u in session.urls())


def test_a_configured_key_is_used_but_never_written_anywhere(env, session, monkeypatch, tmp_path, caplog):
    """Open States. The same is tested for CourtListener's token with its stage, in test_cl_opinions.py."""
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-secret-key-456")
    monkeypatch.setenv("DHQ_LINK_CHECKS", "0")
    serve_open_states(session)
    with caplog.at_level("DEBUG"):
        code, ctx = env.run(["openstates", *COURT])
    assert code == 0
    assert env.source("openstates-api")["processingStatus"] == "ok"
    asked = [call for call in session.calls if call["url"] == os_bulk.JURISDICTIONS_URL]
    assert asked and all(call["headers"]["X-API-KEY"] == "synthetic-secret-key-456" for call in asked)
    # The archives need no key, and get none.
    assert all("X-API-KEY" not in call["headers"] for call in session.calls if call["url"] != os_bulk.JURISDICTIONS_URL)
    written = b"".join(tree(tmp_path).values()).decode("utf-8", errors="replace") + caplog.text
    assert "synthetic-secret-key-456" not in written


def test_unknown_stage_names_are_rejected_with_exit_code_4():
    with pytest.raises(SystemExit) as stopped:
        pipeline.main(["publish"])
    assert stopped.value.code == 4  # argparse's own 2 would read as "the pipeline's validation failed"


def test_an_unknown_option_exits_4_and_help_still_exits_0(capsys):
    with pytest.raises(SystemExit) as stopped:
        pipeline.main(["--no-such-option"])
    assert stopped.value.code == 4
    with pytest.raises(SystemExit) as helped:
        pipeline.main(["--help"])
    assert helped.value.code == 0


@pytest.mark.parametrize("broken", ["load_dotenv", "run"])
def test_an_unexpected_error_outside_the_stages_exits_4(monkeypatch, broken):
    def boom(*args, **kwargs):
        raise RuntimeError(f"synthetic failure in {broken}")

    monkeypatch.setattr(pipeline, "load_dotenv", lambda path: [])
    monkeypatch.setattr(pipeline, broken, boom)
    assert pipeline.main(["scotus"]) == 4


def _command(*code_before_start: str, args=()):
    """Run ``python -m dhq.run`` in a child process from the pipeline folder; nothing is fetched or published."""
    import subprocess
    import sys
    from pathlib import Path

    start = "; ".join([*code_before_start, f"sys.argv = ['dhq.run', *{list(args)!r}]",
                       "import runpy", "runpy.run_module('dhq.run', run_name='__main__', alter_sys=True)"])
    return subprocess.run([sys.executable, "-c", f"import sys; {start}"], cwd=Path(pipeline.__file__).resolve().parents[1],
                          capture_output=True, text=True, timeout=120)


def test_the_command_exits_4_on_an_unknown_stage():
    done = _command(args=["no-such-stage"])
    assert done.returncode == 4, done.stderr
    assert "unknown stage(s): no-such-stage" in done.stderr


def test_the_command_exits_4_when_the_pipeline_cannot_be_imported():
    # pydantic made unimportable: the command must not end with Python's default 1 ("a source failed").
    done = _command("sys.modules['pydantic'] = None", args=["scotus"])
    assert done.returncode == 4, done.stderr
    assert "the pipeline could not be loaded; nothing was published" in done.stderr
    assert "ImportError" in done.stderr or "ModuleNotFoundError" in done.stderr


def test_the_command_still_shows_its_help():
    done = _command(args=["--help"])
    assert done.returncode == 0 and "DemocracyHQ data pipeline" in done.stdout


def test_the_workflow_stage_list_names_exactly_the_pipeline_stages():
    """ingest.yml checks a requested stage list against STAGE_NAMES before it starts the pipeline."""
    from pathlib import Path

    workflow = (Path(pipeline.__file__).resolve().parents[2] / ".github" / "workflows" / "ingest.yml").read_text(encoding="utf-8")
    listed = re.search(r"^\s+STAGE_NAMES: (.+)$", workflow, re.M).group(1).split()
    daily = re.search(r"^\s+DAILY_STAGES: (.+)$", workflow, re.M).group(1).split()
    assert sorted(listed) == sorted(pipeline.STAGES)
    assert set(daily) <= set(pipeline.STAGES)


def test_the_closing_log_line_the_workflow_looks_for_is_written_only_when_the_run_published(env, session, monkeypatch, caplog):
    """ingest.yml takes exit code 1 for "a source failed, the rest was published" only when the run log holds this
    line. Python's own exit code 1, when it stops before the pipeline runs, leaves no such line."""
    import logging
    from pathlib import Path

    from dhq.cli import LOG_FORMAT

    workflow = (Path(pipeline.__file__).resolve().parents[2] / ".github" / "workflows" / "ingest.yml").read_text(encoding="utf-8")
    needle = re.search(r"grep -Fq '([^']+)' \.\./pipeline-run\.log", workflow).group(1)
    formatter = logging.Formatter(LOG_FORMAT)  # the format of `python -m dhq.run`, which the workflow logs

    def logged_run(now):
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="dhq.run"):
            code, _ = env.run(COURT, now=now)
        return code, "\n".join(formatter.format(record) for record in caplog.records)

    code, text = logged_run(T1)
    assert code == 0 and needle in text
    session.on(docket_url("99-0001"), FakeResponse(503))
    session.on(docket_url("99-0002"), FakeResponse(503))
    code, text = logged_run(T2)
    assert code == 1 and needle in text  # a failed source; the rest was published

    def broken_register(**record):
        raise ValueError("synthetic failure while publishing")

    monkeypatch.setattr(pipeline, "SourceRecord", broken_register)
    code, text = logged_run(T3)
    assert code == 3 and needle not in text  # nothing was published


# --- the measures of the state legislatures (Open States) ----------------------------------------------------

def open_states_archive(**changes):
    """A session archive built from the synthetic tables of test_os_bulk.py, with ``changes`` to its tables."""
    from test_os_bulk import tables
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in {**tables(), **changes}.items():
            archive.writestr(f"LA/2026/LA_2026_{name}.csv", data)
    return buffer.getvalue()


def serve_open_states(session, url=ARCHIVE_URL, data=None):
    sessions = [{"identifier": "2026", "name": "2026 Regular Session", "classification": "primary", "start_date": "2026-03-09",
                 "end_date": "2026-06-01", "downloads": [{"data_type": "csv", "url": url}]}]
    session.on(os_bulk.JURISDICTIONS_URL, FakeResponse(200, {
        "results": [{"id": "ocd-jurisdiction/country:us/state:la/government", "name": "Louisiana", "legislative_sessions": sessions}],
        "pagination": {"max_page": 1}}))
    session.serve_bytes(url, data if data is not None else open_states_archive())


def test_the_measures_of_the_state_legislatures_are_published_by_state(env, session, monkeypatch):
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-key")
    monkeypatch.setenv("DHQ_LINK_CHECKS", "0")
    serve_open_states(session)
    code, _ = env.run(["openstates", *COURT])
    assert code == 0
    index = env.read("state-legislation/index.json")
    assert [bill["id"] for bill in index["bills"]] == ["os-la-2026-hb1"]
    assert env.read("state-legislation/la.json")["bills"][0]["actions"][-1]["text"] == "Passed the House"
    # The measure given at an http address only is counted, not listed.
    assert index["selection"]["withoutSecureLink"] == 1 and index["sessions"][0]["withoutSecureLink"] == 1
    assert index["selection"]["ruleId"] == "state-select-1" and index["selection"]["totalMeasuresRead"] == 7
    assert "note" not in index["bills"][0]["verification"]  # the index stays small; the state file has the note
    assert env.source("openstates-api")["processingStatus"] == "ok"
    assert "plain.example.test" not in " ".join(call["url"] for call in session.calls)  # DHQ_LINK_CHECKS=0 asks no host


def test_an_unchanged_archive_is_not_read_again_and_a_broken_one_keeps_the_last_read(env, session, monkeypatch):
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-key")
    monkeypatch.setenv("DHQ_LINK_CHECKS", "0")
    serve_open_states(session)
    env.run(["openstates", *COURT])
    session.calls.clear()
    code, _ = env.run(["openstates", *COURT], now=T2)
    assert code == 0
    assert not any(call["url"] == ARCHIVE_URL for call in session.calls)
    first = env.read("state-legislation/index.json")["bills"][0]
    assert first["firstObservedAt"] == T1 and first["lastCheckedAt"] == T2
    # A new archive that cannot be read leaves the last read of the session in place, and says so.
    serve_open_states(session, url=ARCHIVE_URL.replace(".zip", "-2.zip"), data=b"not a zip archive")
    code, _ = env.run(["openstates", *COURT], now=T3)
    assert code == 1
    assert [bill["id"] for bill in env.read("state-legislation/index.json")["bills"]] == ["os-la-2026-hb1"]
    assert "could not be read" in env.source("openstates-api")["statusDetail"]


def test_a_host_that_serves_https_is_asked_once_and_its_measures_are_listed(env, session, monkeypatch):
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-key")
    serve_open_states(session)
    session.on("https://plain.example.test/HB4", FakeResponse(200, b"<html>HB 4</html>"))
    code, _ = env.run(["openstates", *COURT])
    assert code == 0
    ids = [bill["id"] for bill in env.read("state-legislation/index.json")["bills"]]
    assert sorted(ids) == ["os-la-2026-hb1", "os-la-2026-hb4"]
    session.calls.clear()
    env.run(["openstates", *COURT], now=T2)
    assert not any("plain.example.test" in call["url"] for call in session.calls)  # asked again only after a week


def test_a_state_whose_list_would_shrink_by_more_than_a_quarter_keeps_its_published_list(env, session, monkeypatch):
    monkeypatch.setenv("OPENSTATES_API_KEY", "synthetic-key")
    monkeypatch.setenv("DHQ_LINK_CHECKS", "0")
    serve_open_states(session)
    env.run(["openstates", *COURT])
    # The next archive's measure no longer names an election matter.
    from test_os_bulk import BILL_COLUMNS, bill, table
    renamed = open_states_archive(bills=table([bill(1, "Provides relative to synthetic fisheries")], BILL_COLUMNS))
    serve_open_states(session, url=ARCHIVE_URL.replace(".zip", "-3.zip"), data=renamed)
    code, ctx = env.run(["openstates", *COURT], now=T2)
    assert code == 0
    assert [bill["id"] for bill in env.read("state-legislation/index.json")["bills"]] == ["os-la-2026-hb1"]
    assert any(item["kind"] == "state_measures_left" and item["entity"] == "LA" for item in ctx.review)


def test_the_census_page_must_state_both_which_states_were_redrawn_and_that_the_others_were_not():
    # Wording of the Census Bureau's 120th Congress page (two sentences, quoted).
    page = ("Nine states (Alabama, California, Florida, Louisiana, North Carolina, Ohio, Tennessee, Texas, and Utah) delineated new "
            "boundaries for the 2026 election cycle. All other states, the District of Columbia, and Puerto Rico had no changes to "
            "their congressional district boundaries from the 2024 cycle.")
    assert pipeline.NINE_STATES_RE.search(page).group(1) == "Nine"
    assert pipeline.UNCHANGED_RE.search(page).group(0).endswith("from the 2024 cycle.")
    assert pipeline.UNCHANGED_RE.search(page.split("All other")[0]) is None


# --- the review queue -----------------------------------------------------------------

def review_file(env):
    return read_json(env.staging / "review.json")


def test_the_queue_keeps_the_items_of_stages_that_did_not_run(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(COURT, now=T1)  # flags the second docket's passage
    code, ctx = env.run(LAWS, now=T2)  # the court stage does not run
    assert code == 0 and ("evidence_check_failed", "scotus-99-0002->state:48") not in [(r["kind"], r["entity"]) for r in ctx.review]
    items = review_file(env)["items"]
    assert [(r["kind"], r["entity"], r["stage"], r["flaggedAt"]) for r in items] == [
        ("evidence_check_failed", "scotus-99-0002->state:48", "scotus", T1)]
    assert env.read("manifest.json")["reviewQueue"] == {"items": 1, "byKind": {"evidence_check_failed": 1}}
    # Once the court stage runs again and the passage is found, the item is gone.
    seeds = read_json(env.seeds_dir / "cases.json")
    seeds["cases"][1]["geographies"] = []
    write_json(env.seeds_dir / "cases.json", seeds)
    env.run(COURT, now=T3)
    assert review_file(env)["items"] == [] and env.read("manifest.json")["reviewQueue"]["items"] == 0


def test_a_stage_that_fails_keeps_its_earlier_items_and_what_it_flagged_before_failing_is_not_queued(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(extra_version=True))
    env.run(LAWS, now=T1)
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive(extra_version=False), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    env.run(LAWS, now=T2)  # AB 5 lost a version: its earlier record stays published, held for review
    held = [("regression", "ca-20252026-ab5", T2)]
    # The next export would take too many bills out of the set: the stage flags each of them, then fails.
    members = syn.members(extra_version=True)
    members["BILL_TBL.dat"] = members["BILL_TBL.dat"].split(b"\n", 1)[0] + b"\n"
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Wed, 03 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T3)
    assert code == 1 and env.source("ca-leginfo-bulk")["processingStatus"] == "failed"
    items = review_file(env)["items"]
    # The published bills are still those the earlier item describes; the failed attempt's items describe nothing published.
    assert [(r["kind"], r["entity"], r["flaggedAt"]) for r in items if not r.get("notPublished")] == held
    assert sorted((r["kind"], r["entity"]) for r in items if r.get("notPublished")) == [
        ("bill_left_selection", "ca-20252026-ab5"), ("bill_left_selection", "ca-20252026-aca3")]
    assert env.read("manifest.json")["reviewQueue"] == {"items": 1, "byKind": {"regression": 1}}
    # A run that does not touch the bills carries the queue of the published data, not the failed attempt's items.
    env.run(["relationships", "events"], now="2026-06-04T10:00:00Z")
    assert [(r["kind"], r["entity"], r["flaggedAt"]) for r in review_file(env)["items"]] == held


def test_a_run_that_fails_validation_still_leaves_its_review_items_and_does_not_become_the_queue(env, monkeypatch):
    env.run(COURT, now=T1)

    def corrupt(ctx):
        pipeline.stage_scotus(ctx)
        ctx.flag("synthetic_problem", "scotus-99-0001", "explains the failure")
        path = ctx.staging / "litigation" / "cases" / "scotus-99-0001.json"
        write_json(path, {**read_json(path), "dateDocketed": "10 January 2026"})

    real = pipeline.STAGES["scotus"]
    monkeypatch.setitem(pipeline.STAGES, "scotus", (corrupt, ["scotus-docket"]))
    code, _ = env.run(COURT, now=T2)
    assert code == 2
    items = review_file(env)["items"]
    assert ("synthetic_problem", "scotus-99-0001", True) in [(r["kind"], r["entity"], r.get("notPublished")) for r in items]
    # A later run that does not refresh the dockets carries the queue of the published data, not the failed run's items.
    monkeypatch.setitem(pipeline.STAGES, "scotus", real)
    env.run(["relationships", "events"], now=T3)
    assert [(r["kind"], r["flaggedAt"]) for r in review_file(env)["items"]] == [("evidence_check_failed", T1)]


# --- status details, staleness ----------------------------------------------------------

def test_a_docket_that_fails_before_it_was_ever_published_is_not_said_to_be_kept(env, session):
    session.on(docket_url("99-0002"), FakeResponse(503))
    code, _ = env.run(COURT, now=T1)
    assert code == 0
    assert env.source("scotus-docket")["statusDetail"] == "1 of 2 dockets could not be refreshed; none had been published before, so none is listed"


def test_a_record_that_has_not_been_refreshed_for_longer_than_its_source_allows_fails_the_run(env, session):
    env.run(COURT, now=T1)
    session.on(docket_url("99-0001"), FakeResponse(503))
    code, ctx = env.run(COURT, now="2026-06-07T10:00:00Z")  # six days: within the seven the source allows
    assert code == 0 and not [r for r in ctx.review if r["kind"] == "stale_record"]
    code, ctx = env.run(COURT, now="2026-06-09T10:00:00Z")  # eight days
    assert code == 1
    assert [(r["kind"], r["entity"]) for r in ctx.review if r["kind"] == "stale_record"] == [("stale_record", "scotus-99-0001")]
    record = env.source("scotus-docket")
    assert record["processingStatus"] == "ok" and record["lastSuccessfulCheck"] == "2026-06-09T10:00:00Z"  # the other docket was refreshed
    assert record["statusDetail"].endswith("; 1 record(s) not refreshed for more than 7 days")


# --- publishing -----------------------------------------------------------------------

def leftovers(env):
    return sorted(p.name for p in env.public.parent.iterdir() if p.name.startswith(".public"))


def test_a_failure_while_publishing_leaves_the_published_tree_as_it_was_and_exits_3(env, session, monkeypatch):
    env.run(COURT, now=T1)
    before = tree(env.public)
    longer = synthetic_docket("99-0001")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))

    def broken_register(**record):
        raise ValueError("synthetic failure after the new directories were placed")

    monkeypatch.setattr(pipeline, "SourceRecord", broken_register)
    code, _ = env.run(COURT, now=T2)
    assert code == 3
    assert tree(env.public) == before and leftovers(env) == []
    assert all(r.get("notPublished") for r in review_file(env)["items"] if r["flaggedAt"] == T2)


def test_a_swap_that_fails_half_way_puts_the_published_tree_back(env, monkeypatch):
    import pathlib

    env.run(COURT, now=T1)
    before = tree(env.public)
    real_rename = pathlib.Path.rename

    def rename(self, target):
        if self.name == ".public.incoming":
            raise OSError("synthetic: the disk is full")
        return real_rename(self, target)

    monkeypatch.setattr(pathlib.Path, "rename", rename)
    code, _ = env.run(COURT, now=T2)
    assert code == 3 and tree(env.public) == before


def test_a_publish_that_was_killed_between_the_two_renames_is_recovered_by_the_next_run(env):
    env.run(COURT, now=T1)
    before = env.read("litigation/cases/scotus-99-0001.json")
    env.public.rename(env.public.with_name(".public.previous"))  # the published tree, set aside
    (env.public.with_name(".public.incoming") / "half").mkdir(parents=True)  # the new one, never moved into place
    code, _ = env.run(["relationships", "events"], now=T2)
    assert code == 0 and leftovers(env) == []
    assert env.read("litigation/cases/scotus-99-0001.json") == before
    assert env.read("manifest.json")["generatedAt"] == T2


def test_an_unusable_pinned_clock_publishes_nothing(env, tmp_path, monkeypatch):
    env.run(COURT, now=T1)
    before = tree(env.public)
    real = pipeline.Context
    monkeypatch.setattr(pipeline, "Context", lambda: real(public=env.public, staging=env.staging, cache=tmp_path / "cache"))
    monkeypatch.setenv("DHQ_NOW", "2026-06-02")  # a date, as it might be left in a .env file
    assert pipeline.run(COURT) == 2
    assert tree(env.public) == before


def test_the_manifest_and_each_source_carry_a_hash_of_the_published_files(env, session):
    import hashlib

    def expected(paths):
        lines = "".join(f"{p}\t{hashlib.sha256((env.public / p).read_bytes()).hexdigest()}\n" for p in sorted(paths))
        return hashlib.sha256(lines.encode()).hexdigest()

    env.run(COURT, now=T1)
    files = sorted(str(p.relative_to(env.public)) for p in env.public.rglob("*") if p.is_file())
    manifest = env.read("manifest.json")
    assert manifest["contentHash"] == expected([p for p in files if p != "manifest.json"])
    assert env.source("scotus-docket")["contentHash"] == expected([p for p in files if p.startswith("litigation/") or p == "courts.json"])
    assert env.source("ca-leginfo-bulk")["contentHash"] is None  # nothing published from it
    # The same input gives the same hash; a changed record changes it.
    env.run(COURT, now=T1)
    assert env.read("manifest.json")["contentHash"] == manifest["contentHash"]
    longer = synthetic_docket("99-0001")
    longer["ProceedingsandOrder"].append({"Date": "Apr 01 2026", "Text": "Rehearing DENIED."})
    session.on(docket_url("99-0001"), FakeResponse(200, longer))
    env.run(COURT, now=T1)
    assert env.read("manifest.json")["contentHash"] != manifest["contentHash"]


# --- the California set -------------------------------------------------------------------

def test_a_bill_that_leaves_the_selection_is_flagged(env, session, monkeypatch):
    monkeypatch.setattr(pipeline, "MAX_SHARE_LEAVING", 0.5)
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    members = syn.members()
    members["BILL_VERSION_TBL.dat"] = members["BILL_VERSION_TBL.dat"].replace(b"Voter registration: synthetic urgency.", b"Parking: synthetic urgency.")
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    assert sorted(b["identifier"] for b in env.read("legislation/index.json")["bills"]) == ["AB 1", "ACA 3"]
    flagged = [r for r in ctx.review if r["kind"] == "bill_left_selection"]
    assert [r["entity"] for r in flagged] == ["ca-20252026-ab5"] and "no longer selects it under rule ca-select-2" in flagged[0]["detail"]


@pytest.mark.parametrize("cause", ["a truncated bill table", "subject lines changed"])
def test_a_set_that_would_shrink_too_far_is_not_published(env, session, cause):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    before = tree(env.public / "legislation")
    members = syn.members()
    if cause == "a truncated bill table":
        members["BILL_TBL.dat"] = members["BILL_TBL.dat"].split(b"\n", 1)[0] + b"\n"  # only AB 1 is left
    else:
        members["BILL_VERSION_TBL.dat"] = members["BILL_VERSION_TBL.dat"].replace(b"Voter registration: synthetic urgency.", b"Parking: synthetic urgency.")
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 1
    assert tree(env.public / "legislation") == before
    record = env.source("ca-leginfo-bulk")
    assert record["processingStatus"] == "failed" and record["lastSuccessfulCheck"] == T1 and "the previous set is kept" in record["statusDetail"]
    left = {r["entity"]: r["detail"] for r in ctx.review if r["kind"] == "bill_left_selection"}
    assert set(left) == ({"ca-20252026-ab5", "ca-20252026-aca3"} if cause == "a truncated bill table" else {"ca-20252026-ab5"})
    assert all("it stays published" in detail for detail in left.values())


def test_a_cached_table_that_does_not_match_the_archive_is_read_again(env, session, tmp_path):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    cached = next((tmp_path / "cache" / "ca" / "2025").glob("BILL_TBL.dat.*.dat"))
    cached.write_bytes(cached.read_bytes()[: cached.stat().st_size // 3])  # cut short, as by an interrupted write
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0 and ctx.review == []
    assert sorted(b["identifier"] for b in env.read("legislation/index.json")["bills"]) == ["AB 1", "AB 5", "ACA 3"]
    assert env.read("legislation/index.json")["selection"]["totalBillsInSession"] == 5


def test_tables_are_not_cached_for_an_archive_without_a_date(env, session, tmp_path):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    session.on("HEAD " + syn.ARCHIVE_URL, FakeResponse(200, b"", {"Accept-Ranges": "bytes", "Content-Length": str(len(syn.archive()))}))
    code, _ = env.run(LAWS, now=T1)
    assert code == 0 and len(env.read("legislation/index.json")["bills"]) == 3
    assert list((tmp_path / "cache" / "ca" / "2025").glob("*.dat")) == []


def test_an_official_file_that_changes_under_the_same_version_id_is_flagged(env, session):
    session.serve_bytes(syn.ARCHIVE_URL, syn.archive())
    env.run(LAWS, now=T1)
    members = syn.members()
    members["lob/e99.lob"] = syn.caml("Voter registration: synthetic urgency.", ["Registration is synthetic."], immediate="YES",
                                      title="An act relating to synthetic elections, as corrected.", version_id="20250AB599INT")
    session.serve_bytes(syn.ARCHIVE_URL, make_zip(members), last_modified="Tue, 02 Jun 2026 08:00:00 GMT")
    code, ctx = env.run(LAWS, now=T2)
    assert code == 0
    flagged = [r for r in ctx.review if r["kind"] == "version_source_changed"]
    assert [r["entity"] for r in flagged] == ["ca-20252026-ab5"]
    assert "20250AB599INT" in flagged[0]["detail"] and flagged[0]["detail"].endswith("the extracted text is unchanged")
