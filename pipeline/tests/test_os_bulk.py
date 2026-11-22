"""The measures of the state legislatures, read from Open States' bulk data (``dhq.adapters.os_bulk``).

SYNTHETIC TEST DATA. The tables below follow the column names of Open States' CSV archives; every measure, title, id,
name and address in them is invented for the tests.
"""

import csv
import io
import zipfile

import pytest

from dhq import about
from dhq.adapters import os_bulk
from dhq.http import CredentialMissing
from dhq.schemas import StateMeasure, StateMeasureSummary

from conftest import FakeResponse

CHECKED = "2026-06-15T12:00:00Z"
ARCHIVE = "https://data.openstates.org/csv/latest/XX_2026_csv_synthetic.zip"


def a_session(state="22", abbr="LA", identifier="2026", url=ARCHIVE):
    return os_bulk.Session(state=state, abbr=abbr, identifier=identifier, name=f"{identifier} Regular Session",
                           classification="primary", start="2026-03-09", end="2026-06-01", url=url)


def table(rows, columns):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return out.getvalue().encode("utf-8")


BILL_COLUMNS = ["id", "identifier", "title", "classification", "subject", "session_identifier", "jurisdiction", "organization_classification"]


def bill(number, title, subjects=(), classification="['bill']"):
    return {"id": f"ocd-bill/synthetic-{number}", "identifier": f"HB {number}", "title": title, "classification": classification,
            "subject": repr(list(subjects)), "session_identifier": "2026", "jurisdiction": "Synthetica", "organization_classification": "lower"}


# --- the selection rule ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("value, expected", [
    ("['Elections', 'Voting']", ["Elections", "Voting"]),
    ("['Elections; Voting']", ["Elections", "Voting"]),  # a legislature that joins its subjects with semicolons
    ("[]", []),
    ("", []),
    ("not a list", ["not a list"]),
])
def test_the_subjects_of_a_measure_are_read_from_the_tables_list(value, expected):
    assert os_bulk.subjects_of(value) == expected


@pytest.mark.parametrize("title, subjects, test, words", [
    ("Provides relative to the qualifications of registrars", ["Elections"], "subject", "Elections"),
    ("Relating to synthetic matters", ["Campaign Finance", "Ethics"], "subject", "Campaign Finance"),
    ("Provides for the deadline of absentee ballots", [], "named", "absentee ballots"),
    ("Revises the voter registration application", [], "named", "voter registration"),
    ("Requires a hand count of mail-in ballots", [], "named", "mail-in ballots"),
    ("Elections; making changes; effective date.", [], "general", "Elections"),
])
def test_a_measure_is_selected_by_its_subjects_or_its_title(title, subjects, test, words):
    found = os_bulk.selection_match(title, subjects)
    assert found and (found["test"], found["matchedText"]) == (test, words)
    assert found["matchedField"] == ("Subject" if test == "subject" else "Title")


def test_an_election_subject_among_many_needs_an_election_title_as_well():
    subjects = ["Taxation", "Counties", "Elections", "Property", "Schools"]
    assert os_bulk.selection_match("Relating to the assessment of synthetic property", subjects) is None
    found = os_bulk.selection_match("Relating to property tax elections", subjects)
    assert found["test"] == "subject" and found["matchedText"] == "Elections"


@pytest.mark.parametrize("subject", ["Proxy voting", "Shareholders voting rights", "Condominium elections", "Legislative voting procedures"])
def test_a_subject_that_names_the_voting_of_another_body_does_not_select(subject):
    assert os_bulk.selection_match("Relating to synthetic matters", [subject]) is None


@pytest.mark.parametrize("title", [
    "Requires spousal consent to election of certain pension payout options",
    "Election of a member's retirement annuity modification",
    "Adds a 60-day requirement for filing an election with the association",
    "Proposing a constitutional amendment to be submitted to the qualified voters of the state",
    "Relating to the calculation of the voter-approval tax rate of a taxing unit",
    "Constitution; synthetic trust fund; appropriation; ballot title; filing.",
    "homeowners' associations; voting; elections",
    "labor organizations; elections; recertification requirement",
    "Relating to the election of officers of the House of Representatives",
    "Allowing counties to impose a synthetic tax, subject to the will of the voters.",
    "Authorizes the sale of liquor approved by local option election",
    "Relates to proxy voting by members of a synthetic board",
])
def test_a_title_that_uses_an_election_word_in_another_sense_does_not_select(title):
    assert os_bulk.selection_match(title, []) is None


@pytest.mark.parametrize("title, classification, expected", [
    ("Commends the Honorable Jane Roe on her election as mayor", ["resolution"], True),
    ("COMMENDATIONS: Commends John Doe on his election as president of a society", ["resolution"], True),
    ("Commending the Synthetic Electoral Board Association.", ["bill"], True),  # a resolution Open States records as a bill
    ("Joint resolution congratulating a synthetic official on re-election", ["bill"], True),
    ("A RESOLUTION recognizing the guiding principles of elections", ["resolution"], True),
    ("League of Synthetic Voters; recognize", ["resolution"], True),
    ("CONDOLENCES: Expresses the condolences of the House on the death of a poll worker", ["resolution"], True),
    ("Recognizing a medical bill as proof of residence on election day", ["bill"], False),
    ("Recognizing election day.", ["bill"], False),
    ("An Act to establish a holiday honoring a president, to promote voter participation", ["bill"], False),
    ("Commending the voters by proposing an amendment", ["constitutional amendment"], False),
])
def test_a_ceremonial_resolution_is_not_legislation(title, classification, expected):
    assert os_bulk.ceremonial(title, classification) is expected


# --- the stage a measure reached -------------------------------------------------------------------------------

def action(day, kinds=(), body="lower", order=0):
    return {"date": day, "text": "Synthetic action", "classification": list(kinds), "organization": body, "order": order}


@pytest.mark.parametrize("actions, state, stage", [
    ([action("2026-01-02", ["introduction"])], "22", "Introduced"),
    ([], "22", "Introduced"),
    ([action("2026-01-02", ["passage"])], "22", "Passed one chamber"),
    ([action("2026-01-02", ["passage"]), action("2026-02-02", ["passage"], body="upper")], "22", "Passed the legislature"),
    ([action("2026-01-02", ["passage"], body="legislature")], "31", "Passed the legislature"),  # Nebraska has one chamber
    ([action("2026-01-02", ["passage"]), action("2026-02-02", ["passage"], body="upper"), action("2026-02-03", ["executive-receipt"], body="executive")], "22", "Sent to the governor"),
    ([action("2026-02-03", ["executive-veto"], body="executive")], "22", "Vetoed"),
    ([action("2026-02-03", ["executive-signature"], body="executive")], "22", "Signed by the governor"),
    ([action("2026-02-03", ["executive-veto"]), action("2026-03-01", ["became-law"])], "22", "Became law"),
])
def test_the_stage_is_the_furthest_step_the_actions_record(actions, state, stage):
    assert os_bulk.stage_of(actions, state) == stage


# --- the sessions read -----------------------------------------------------------------------------------------

def jurisdiction(abbr, sessions):
    return {"id": f"ocd-jurisdiction/country:us/state:{abbr}/government", "name": abbr, "legislative_sessions": sessions}


def session_entry(identifier, start, end, url=ARCHIVE):
    return {"identifier": identifier, "name": identifier, "classification": "primary", "start_date": start, "end_date": end,
            "downloads": [{"data_type": "csv", "url": url}] if url else []}


def test_the_sessions_read_are_those_since_2025_with_an_archive_and_california_is_left_out():
    sessions, skipped = os_bulk.sessions_of([
        jurisdiction("la", [session_entry("2024", "2024-03-11", "2024-06-03"), session_entry("2026", "2026-03-09", "2026-06-01")]),
        jurisdiction("tx", [session_entry("89R", "2025-01-14", "2025-06-02"), session_entry("892", "2025-08-01", "", url=None)]),
        jurisdiction("ca", [session_entry("20252026", "2025-01-06", "2026-08-31")]),
        jurisdiction("pr", [session_entry("2025-2028", "2025-01-02", "2028-12-31")]),
        {"id": "ocd-jurisdiction/country:us/state:zz/government", "legislative_sessions": []},
    ])
    assert [(s.abbr, s.identifier, s.state) for s in sessions] == [("LA", "2026", "22"), ("TX", "89R", "48")]
    assert skipped == {"noArchive": 1, "leftOut:CA": 1, "leftOut:PR": 1, "unknownJurisdiction": 1}


def test_the_key_is_required_and_a_blank_one_counts_as_missing(monkeypatch):
    with pytest.raises(CredentialMissing, match="OPENSTATES_API_KEY is not set"):
        os_bulk.api_key()
    monkeypatch.setenv("OPENSTATES_API_KEY", "   ")
    with pytest.raises(CredentialMissing):
        os_bulk.api_key()


def test_the_jurisdictions_are_asked_for_with_the_key_in_a_header_only(fetcher, session):
    session.on(os_bulk.JURISDICTIONS_URL, FakeResponse(200, {"results": [jurisdiction("la", [])], "pagination": {"max_page": 2}}),
               FakeResponse(200, {"results": [jurisdiction("tx", [])], "pagination": {"max_page": 2}}))
    found = os_bulk.jurisdictions(fetcher, "synthetic-key")
    assert [j["name"] for j in found] == ["la", "tx"]
    assert [c["params"]["page"] for c in session.calls] == [1, 2]
    assert all(c["headers"]["X-API-KEY"] == "synthetic-key" and "synthetic-key" not in c["url"] for c in session.calls)


# --- links -----------------------------------------------------------------------------------------------------

def test_an_address_is_shown_only_over_https():
    assert os_bulk.secure_url("https://legis.example.test/bill?name=HF 91&ga=91") == "https://legis.example.test/bill?name=HF%2091&ga=91"
    assert os_bulk.secure_url("http://legis.example.test/bill/1") is None
    assert os_bulk.secure_url("http://legis.example.test/bill/1", {"legis.example.test"}) == "https://legis.example.test/bill/1"
    assert os_bulk.secure_url("http://other.example.test/bill/1", {"legis.example.test"}) is None
    assert os_bulk.secure_url("javascript:alert(1)") is None
    assert os_bulk.secure_url("https://legis.example.test/a<b") is None
    assert os_bulk.https_hosts(["https://A.example.test/x", "http://b.example.test/y", ""]) == {"a.example.test"}


def test_an_http_only_host_is_asked_whether_it_serves_https(fetcher, session):
    docs = [{"state": "24", "selected": [{"sources": ["http://plain.example.test/bill/1", "https://secure.example.test/bill/1"]}]}]
    assert os_bulk.http_only_hosts(docs, {"24": set()}) == {"plain.example.test": "http://plain.example.test/bill/1"}
    assert os_bulk.http_only_hosts(docs, {"24": {"plain.example.test"}}) == {}
    session.on("https://plain.example.test/bill/1", FakeResponse(200, b"<html>page</html>"))
    assert os_bulk.confirm_https(fetcher, "http://plain.example.test/bill/1") is True
    session.on("https://plain.example.test/bill/2", FakeResponse(404, b"missing"))
    assert os_bulk.confirm_https(fetcher, "http://plain.example.test/bill/2") is False
    # A redirect back to plain http is refused by the fetcher, so the host does not count as serving https.
    session.on("https://plain.example.test/bill/3", FakeResponse(301, b"", {"Location": "http://plain.example.test/bill/3"}))
    assert os_bulk.confirm_https(fetcher, "http://plain.example.test/bill/3") is False


# --- reading a session -----------------------------------------------------------------------------------------

def tables():
    bills = [
        bill(1, "ELECTIONS: Provides relative to absentee ballots", ["Elections"]),
        bill(2, "Provides relative to synthetic fisheries"),
        bill(3, "COMMENDATIONS: Commends Jane Roe on her election as mayor", classification="['resolution']"),
        bill(4, "Provides relative to early voting", classification="['bill']"),
        bill(5, "Confirms an appointment to the board of elections", classification="['appointment']"),
        bill(6, "Provides for the voting of synthetic districts", classification="['resolution']"),
        {**bill(7, "Provides relative to absentee ballots again"), "identifier": "HB 1"},  # the same number twice
    ]
    return {
        "bills": table(bills, BILL_COLUMNS),
        "bill_abstracts": table([
            {"id": "a1", "bill_id": "ocd-bill/synthetic-1", "abstract": "An Act relating to absentee ballots.", "note": "title"},
            {"id": "a2", "bill_id": "ocd-bill/synthetic-1", "abstract": "Requires that an absentee ballot received after the close of the polls on election day not be counted.", "note": "summary"},
            {"id": "a3", "bill_id": "ocd-bill/synthetic-6", "abstract": "A RESOLUTION recognizing and commending the synthetic districts; and for other purposes.", "note": "description"},
        ], ["id", "bill_id", "abstract", "note"]),
        "bill_sources": table([
            {"id": "s1", "note": "", "url": "https://legis.example.test/bill?b=HB 1", "bill_id": "ocd-bill/synthetic-1"},
            {"id": "s2", "note": "", "url": "http://plain.example.test/HB4", "bill_id": "ocd-bill/synthetic-4"},
            {"id": "s3", "note": "", "url": "https://other.example.test/HB2", "bill_id": "ocd-bill/synthetic-2"},
        ], ["id", "note", "url", "bill_id"]),
        "bill_actions": table([
            {"id": "x2", "bill_id": "ocd-bill/synthetic-1", "organization_id": "ocd-organization/lower", "description": "Passed the House",
             "date": "2026-04-02", "classification": "['passage']", "order": "2"},
            {"id": "x1", "bill_id": "ocd-bill/synthetic-1", "organization_id": "ocd-organization/lower", "description": "Introduced",
             "date": "2026-03-09", "classification": "['introduction']", "order": "1"},
            {"id": "x3", "bill_id": "ocd-bill/synthetic-4", "organization_id": "ocd-organization/lower", "description": "Prefiled",
             "date": "not a date", "classification": "[]", "order": "1"},
        ], ["id", "bill_id", "organization_id", "description", "date", "classification", "order"]),
        "bill_sponsorships": table([
            {"id": "p1", "name": "Rep. Synthetic One", "entity_type": "person", "organization_id": "", "person_id": "", "bill_id": "ocd-bill/synthetic-1", "primary": "True", "classification": "primary"},
            {"id": "p2", "name": "Rep. Synthetic Two", "entity_type": "person", "organization_id": "", "person_id": "", "bill_id": "ocd-bill/synthetic-1", "primary": "False", "classification": "cosponsor"},
        ], ["id", "name", "entity_type", "organization_id", "person_id", "bill_id", "primary", "classification"]),
        "bill_versions": table([
            {"id": "v1", "bill_id": "ocd-bill/synthetic-1", "note": "Introduced", "date": "2026-03-09", "classification": "", "extras": "{}"},
            {"id": "v2", "bill_id": "ocd-bill/synthetic-1", "note": "Engrossed", "date": "", "classification": "", "extras": "{}"},
        ], ["id", "bill_id", "note", "date", "classification", "extras"]),
        "bill_version_links": table([
            {"id": "l1", "media_type": "application/pdf", "url": "https://legis.example.test/hb1.pdf", "version_id": "v1"},
            {"id": "l2", "media_type": "text/html", "url": "http://plain.example.test/hb1-engrossed.html", "version_id": "v2"},
        ], ["id", "media_type", "url", "version_id"]),
    }


def test_a_session_is_read_table_by_table_and_only_the_selected_measures_keep_their_details():
    data = tables()
    doc = os_bulk.read_session(a_session(), data.get)
    assert doc["measuresRead"] == 7
    selected = {raw["identifier"]: raw for raw in doc["selected"]}
    # The fisheries measure is not selected; the ceremonial resolution, the appointment and the resolution whose abstract
    # shows it to be ceremonial are left out as not legislation; the second "HB 1" is passed over.
    assert sorted(selected) == ["HB 1", "HB 4"]
    assert doc["skipped"] == {"notLegislation": 3, "sameIdentifier": 1}
    first = selected["HB 1"]
    assert first["id"] == "os-la-2026-hb1" and first["openStatesId"] == "ocd-bill/synthetic-1"
    assert first["match"] == {"test": "subject", "matchedText": "Elections", "matchedField": "Subject"}
    assert [a["text"] for a in first["actions"]] == ["Introduced", "Passed the House"]  # put in date order
    assert first["sources"] == ["https://legis.example.test/bill?b=HB 1"]
    assert [s["name"] for s in first["sponsors"]] == ["Rep. Synthetic One", "Rep. Synthetic Two"]
    assert [v["note"] for v in first["versions"]] == ["Introduced", "Engrossed"]
    assert selected["HB 4"]["actions"] == []  # an action without a real date is not kept
    # The hosts the archive gives over https, for any measure: the evidence rule secure-link-1 reads.
    assert doc["httpsHosts"] == ["legis.example.test", "other.example.test"]


def test_the_tables_of_an_archive_are_found_by_the_end_of_their_names():
    names = ["LA/2026/LA_2026_bills.csv", "LA/2026/LA_2026_bill_sources.csv", "LA/2026/LA_2026_bill_actions.csv", "LA/2026/readme.txt"]
    assert os_bulk.table_members(names) == {"bills": names[0], "bill_sources": names[1], "bill_actions": names[2]}


def test_an_archive_is_read_by_range_requests(fetcher, session):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in tables().items():
            archive.writestr(f"LA/2026/LA_2026_{name}.csv", data)
    session.serve_bytes(ARCHIVE, buffer.getvalue())
    doc = os_bulk.read_archive(a_session(), fetcher)
    assert sorted(raw["identifier"] for raw in doc["selected"]) == ["HB 1", "HB 4"]
    assert all(call["headers"].get("Range") for call in session.calls if call["method"] == "GET")


# --- the published record --------------------------------------------------------------------------------------

def built(secure=()):
    doc = os_bulk.read_session(a_session(), tables().get)
    raws = {raw["identifier"]: raw for raw in doc["selected"]}
    return doc, raws, {key: os_bulk.build(raw, doc, secure, checked_at=CHECKED, first_observed=None) for key, raw in raws.items()}


def test_the_record_says_what_the_measure_is_why_it_is_listed_and_where_to_read_it():
    _doc, _raws, records = built()
    record = records["HB 1"]
    StateMeasure(**record)
    StateMeasureSummary(**{k: record[k] for k in StateMeasureSummary.model_fields if k in record})
    assert (record["state"], record["stateAbbr"], record["session"]) == ("22", "LA", "2026 Regular Session")
    assert record["measureType"] == "Bill" and record["leadAuthors"] == "Rep. Synthetic One"
    assert record["legislativeStatus"] == {"currentStatus": "Passed one chamber"}
    assert (record["introducedDate"], record["lastActionDate"], record["lastActionText"]) == ("2026-03-09", "2026-04-02", "Passed the House")
    assert record["officialUrl"] == "https://legis.example.test/bill?b=HB%201"
    assert record["selection"] == {"ruleId": "state-select-1", "test": "subject", "matchedText": "Elections", "matchedField": "Subject"}
    assert record["verification"]["status"] == "imported_secondary"
    # The abstract that only repeats the title is passed over; the summary is quoted, with no address of its own.
    assert record["about"]["source"] == "abstract" and record["about"]["text"].startswith("Requires that an absentee ballot")
    assert record["about"]["url"] is None and record["about"]["ruleId"] == about.ABSTRACT_RULE_ID
    assert [(tag["tag"], tag["matchedField"]) for tag in record["issueTags"]] == [("mail-voting", "Title")]
    # The engrossed text is given over http only, so it is not shown; the version count follows.
    assert [v["note"] for v in record["versions"]] == ["Introduced"] and record["versionCount"] == 1


def test_a_measure_without_a_secure_page_of_the_legislature_is_not_listed():
    _doc, _raws, records = built()
    assert records["HB 4"] is None
    _doc, _raws, records = built(secure={"plain.example.test"})
    assert records["HB 4"]["officialUrl"] == "https://plain.example.test/HB4"
    assert records["HB 1"]["versionCount"] == 2


def test_the_first_observation_is_kept_from_the_earlier_release():
    doc, raws, _records = built()
    record = os_bulk.build(raws["HB 1"], doc, (), checked_at=CHECKED, first_observed="2026-01-01T00:00:00Z")
    assert record["firstObservedAt"] == "2026-01-01T00:00:00Z" and record["lastCheckedAt"] == CHECKED


@pytest.mark.parametrize("classification, label", [
    (["bill"], "Bill"), (["joint resolution"], "Joint resolution"), (["bill", "appropriation"], "Bill (appropriation)"),
    ([], "Bill"), (["synthetic kind"], "Synthetic kind"),
])
def test_the_kind_of_measure_is_named_as_open_states_records_it(classification, label):
    assert os_bulk.measure_type(classification) == label


def test_at_most_three_lead_authors_are_named():
    sponsors = [{"name": f"Member {n}", "primary": True} for n in range(5)] + [{"name": "Cosponsor", "primary": False}]
    assert os_bulk.lead_authors(sponsors) == "Member 0, Member 1, Member 2 and 2 more"
    assert os_bulk.lead_authors([{"name": "Cosponsor", "primary": False}]) is None
