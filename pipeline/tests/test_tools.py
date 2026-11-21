"""Tests for the hand-run checking tools.

SYNTHETIC TEST DATA. The dockets, entries and addresses below are invented; off-site
addresses use the reserved ``example.test`` domain. The tools' network paths are not
exercised here: the docket checker is run on synthetic pages laid out like the Court's.
"""

from __future__ import annotations

import json

from conftest import render_docket_page, synthetic_docket
from tools import check_links, verify_dockets


SC = "https://www.supremecourt.gov"


def published_docket() -> dict:
    """The published record of the synthetic docket, as the pipeline would write it."""
    return {
        "docketNumber": "99-9001",
        "petitionerTitle": "Synthetic Alpha, et al., Petitioners",
        "respondentTitle": "Synthetic Beta, Secretary of State of Synthetica",
        "dateDocketed": "2026-01-10",
        "events": [
            {"date": "2026-01-05", "description": "Petition for a writ of certiorari filed. (Response due February 9, 2026)"},
            {"date": "2026-02-01", "description": "Waiver of right of respondent Synthetic Beta to respond filed."},
            {"date": "2026-02-18", "description": "DISTRIBUTED for Conference of 3/6/2026."},
            {"date": "2026-03-09", "description": "Petition DENIED."},
        ],
        "documents": [{"url": f"{SC}/DocketPDF/99/99-9001/1/petition.pdf"}],
    }


def live(**overrides) -> dict:
    """What the page reader finds on the Court's page for the synthetic docket."""
    return verify_dockets.read_page(render_docket_page(synthetic_docket("99-9001", **overrides)))


def test_the_page_reader_finds_the_header_entries_and_links():
    page = live()
    assert (page["number"], page["petitioner"], page["respondent"], page["docketed"]) == (
        "99-9001", "Synthetic Alpha, et al., Petitioners", "Synthetic Beta, Secretary of State of Synthetica", "2026-01-10")
    assert [e["date"] for e in page["entries"]] == ["2026-01-05", "2026-02-01", "2026-02-18", "2026-03-09"]
    assert page["entries"][0]["links"][0] == f"{SC}/DocketPDF/99/99-9001/1/petition.pdf"


def test_identical_docket_matches():
    counts, notes = verify_dockets.compare(published_docket(), live())
    assert counts == {"entries": 4, "matched": 4, "differ": 0, "missing_live": 0, "new_live": 0, "header_diffs": 0,
                      "links": 1, "links_missing_live": 0, "links_unpublished": 0}
    assert notes == []


def test_markup_and_spacing_in_an_entry_do_not_count_as_a_difference():
    entries = synthetic_docket("99-9001")["ProceedingsandOrder"]
    entries[1] = {"Date": "Feb 01 2026", "Text": "Waiver of right of respondent <i>Synthetic Beta</i> to\n   respond&nbsp;filed."}
    counts, notes = verify_dockets.compare(published_docket(), live(ProceedingsandOrder=entries))
    assert counts["matched"] == 4 and notes == []


def test_changed_date_is_reported_as_a_difference():
    entries = synthetic_docket("99-9001")["ProceedingsandOrder"]
    entries[1]["Date"] = "Feb 02 2026"
    counts, notes = verify_dockets.compare(published_docket(), live(ProceedingsandOrder=entries))
    assert counts["matched"] == 3 and counts["differ"] == 1
    assert any("date differs" in note for note in notes)


def test_entry_missing_from_the_court_is_reported():
    entries = synthetic_docket("99-9001")["ProceedingsandOrder"][:-1]
    counts, notes = verify_dockets.compare(published_docket(), live(ProceedingsandOrder=entries))
    assert counts["missing_live"] == 1
    assert any("published entry not on the Court's page" in note for note in notes)


def test_new_entry_at_the_court_is_counted_but_is_not_a_mismatch():
    entries = synthetic_docket("99-9001")["ProceedingsandOrder"] + [{"Date": "May 05 2026", "Text": "Rehearing DENIED."}]
    counts, notes = verify_dockets.compare(published_docket(), live(ProceedingsandOrder=entries))
    assert counts["matched"] == 4 and counts["new_live"] == 1 and counts["differ"] == 0 and counts["missing_live"] == 0
    assert any("newest 2026-05-05" in note for note in notes)


def test_header_differences_are_reported():
    counts, _ = verify_dockets.compare(published_docket(), live(RespondentTitle="Another Synthetic Party", DocketedDate="January 11, 2026"))
    assert counts["header_diffs"] == 2


def test_a_page_for_another_docket_is_reported():
    counts, notes = verify_dockets.compare(published_docket(), verify_dockets.read_page(render_docket_page(synthetic_docket("99-9002"))))
    assert counts["header_diffs"] >= 1 and any("the page is for '99-9002'" in note for note in notes)


def test_published_filing_link_absent_from_the_court_is_reported():
    published = published_docket()
    published["documents"].append({"url": f"{SC}/DocketPDF/99/99-9001/2/invented.pdf"})
    counts, notes = verify_dockets.compare(published, live())
    assert counts["links"] == 2 and counts["links_missing_live"] == 1
    assert any("published link(s) not on the Court's page" in note for note in notes)


def test_a_court_link_left_out_of_the_published_file_is_counted():
    published = published_docket()
    published["documents"] = []
    counts, notes = verify_dockets.compare(published, live())
    # Only the Court's own addresses are compared; the off-site proof of service is not.
    assert counts["links_unpublished"] == 1
    assert any("not in the published file" in note for note in notes)


def test_link_collection_skips_mirrored_bill_text(tmp_path):
    (tmp_path / "legislation" / "text").mkdir(parents=True)
    (tmp_path / "legislation" / "text" / "v1.json").write_text(json.dumps({"blocks": [["p", "See https://prose.example.test/."]]}))
    (tmp_path / "legislation" / "bills.json").write_text(json.dumps([{"officialUrl": "https://a.example.test/bill/1"}, {"officialUrl": "https://a.example.test/bill/2"}]))
    (tmp_path / "sources.json").write_text(json.dumps([{"url": "https://b.example.test/data"}]))
    assert check_links.collect(tmp_path) == {
        "a.example.test": ["https://a.example.test/bill/1", "https://a.example.test/bill/2"],
        "b.example.test": ["https://b.example.test/data"],
    }


def test_sample_is_evenly_spaced_and_deterministic():
    items = [f"u{i:02d}" for i in range(11)]
    assert check_links.spaced(items, 3) == ["u00", "u05", "u10"]
    assert check_links.spaced(items, 0) == items
    assert check_links.spaced(items, 50) == items
    assert check_links.spaced(items, 1) == ["u00"]
