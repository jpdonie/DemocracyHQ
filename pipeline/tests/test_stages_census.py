"""The geo and population stages, run through ``run()`` against synthetic Census files.

HTTP is scripted and mapshaper is replaced (see ``synthetic_census``); everything else is the
code the pipeline runs: the downloads and their checks, the Census page, the per-state files and
the merge with what was published before.
"""

import pytest

import dhq.run as pipeline
from dhq.adapters import census_geo, census_pop

import synthetic_census as census
from conftest import FakeResponse, tree
from test_run import T1, T2, T3, env  # noqa: F401 - env is a fixture

T4 = "2026-06-04T10:00:00Z"


@pytest.fixture
def geo(env, session, monkeypatch):  # noqa: F811
    monkeypatch.setattr(census_geo, "_mapshaper", census.fake_mapshaper)
    census.serve_boundaries(session)
    session.on(pipeline.CD120_PAGE, FakeResponse(200, census.PAGE))
    return env


@pytest.fixture
def population(env, session, monkeypatch):  # noqa: F811
    monkeypatch.setattr(census_pop, "PL_STATES", ["06", "48"])
    census.serve_population(session, ["06", "48"])
    return env


# --- geography ------------------------------------------------------------------------

def test_the_geo_stage_publishes_the_layers_and_the_states_the_bureau_lists_as_redrawn(geo):
    code, ctx = geo.run(["geo"], now=T1)
    assert code == 0
    index = geo.read("geo/index.json")
    assert {name: info["featureCount"] for name, info in index["layers"].items()} == {"state": 56, "county": 3248, "cd119": 441, "cd120": 441}
    assert geo.read("redistricting.json")["congress120"]["statesWithNewBoundaries"] == census.REDRAWN
    assert geo.read("redistricting.json")["areaCheck"]["mismatches"] == []
    assert {geo.source(s)["processingStatus"] for s in ("census-cb-2025", "census-tiger-2026-cd120", "census-cd120-page")} == {"ok"}
    assert geo.source("census-tiger-2026-cd120")["sourcePublishedAt"] == "2026-11-09T20:30:21Z"


def test_when_the_census_page_cannot_be_read_the_last_verified_list_stays(geo, session):
    geo.run(["geo"], now=T1)
    listed = (geo.public / "redistricting.json").read_bytes()
    session.on(pipeline.CD120_PAGE, FakeResponse(503))
    code, ctx = geo.run(["geo"], now=T2)
    assert code == 1  # the page source failed, although the boundaries were refreshed
    assert (geo.public / "redistricting.json").read_bytes() == listed
    assert geo.source("census-cb-2025")["lastSuccessfulCheck"] == T2
    page = geo.source("census-cd120-page")
    assert (page["processingStatus"], page["lastSuccessfulCheck"], page["lastAttempt"]) == ("failed", T1, T2)


def test_new_120th_congress_files_without_a_readable_page_keep_the_old_boundaries_and_fail_the_page(geo, session):
    geo.run(["geo"], now=T1)
    before = tree(geo.public / "geo")
    census.serve_boundaries(session, tiger_modified="Tue, 10 Nov 2026 15:00:00 GMT")  # the Bureau replaced the district files
    session.on(pipeline.CD120_PAGE, FakeResponse(503))
    code, ctx = geo.run(["geo"], now=T2)
    assert code == 1
    assert tree(geo.public / "geo") == before
    for source_id in ("census-cb-2025", "census-tiger-2026-cd120", "census-cd120-page"):
        record = geo.source(source_id)
        assert (record["processingStatus"], record["lastSuccessfulCheck"], record["lastAttempt"]) == ("failed", T1, T2), source_id


def test_a_boundary_file_served_as_an_html_page_is_refused_and_fetched_again_on_the_next_run(geo, session):
    geo.run(["geo"], now=T1)
    before = tree(geo.public / "geo")
    url = f"{census_geo.GENZ_BASE}/{census_geo.CB_FILES['state']}.zip"
    replaced = census.make_zip({"cb_2025_us_state_5m.shp": b"synthetic shapes, second edition"})
    session.serve_bytes(url, replaced, last_modified="Tue, 10 Nov 2026 15:00:00 GMT")
    session.on(url, FakeResponse(200, "<html><body>Temporarily unavailable</body></html>"))  # an error page with status 200
    code, ctx = geo.run(["geo"], now=T2)
    assert code == 1 and tree(geo.public / "geo") == before
    assert geo.source("census-cb-2025")["processingStatus"] == "failed"
    assert "not a ZIP archive" in geo.source("census-cb-2025")["statusDetail"]
    # Next week the real file is served under the same date and size: it is downloaded, not taken for the refused page.
    session.serve_bytes(url, replaced, last_modified="Tue, 10 Nov 2026 15:00:00 GMT")
    gets = session.urls().count(url)
    code, _ = geo.run(["geo"], now=T3)
    assert code == 0 and session.urls().count(url) == gets + 1
    assert geo.source("census-cb-2025")["sourcePublishedAt"] == "2026-11-10T15:00:00Z"


# --- population -------------------------------------------------------------------------

def counties(env, fips):  # noqa: F811
    return {geoid: row for geoid, row in env.read("population/county.json")["rows"].items() if geoid.startswith(fips)}


def test_the_population_stage_publishes_counts_that_add_up(population):
    code, _ = population.run(["population"], now=T1)
    assert code == 0
    assert population.read("population/state.json")["rows"] == {"06": census.values(6000), "48": census.values(1500)}
    assert counties(population, "48") == {"48001": census.values(400), "48003": census.values(500), "48005": census.values(600)}
    assert population.read("population/cd119.json")["rows"]["0602"] == census.values(3500)
    assert population.source("census-pl-2020")["recordCount"] == 2 + 6
    assert population.read("population/county.json")["dataset"]["sourcePublishedAt"] == "2024-12-05T13:07:34Z"


def test_a_state_whose_file_fails_keeps_its_earlier_rows_and_the_counts_say_what_is_published(population, session):
    population.run(["population"], now=T1)
    earlier = counties(population, "48")
    session.on("HEAD " + census.county_url("48"), FakeResponse(503))
    session.serve_bytes(census.county_url("06"), census.county_file("06", [1100, 2000, 3000]))  # a revised count
    code, ctx = population.run(["population"], now=T2)
    assert code == 0
    assert counties(population, "48") == earlier  # kept from the first run
    assert counties(population, "06")["06001"] == census.values(1100)  # refreshed
    assert ("population_state_failed", "county:48") in [(r["kind"], r["entity"]) for r in ctx.review]
    record = population.source("census-pl-2020")
    assert record["statusDetail"] == "1 state file(s) failed; previous rows kept"
    assert record["recordCount"] == 2 + 6  # the published rows, not only the ones fetched in this run


def test_a_state_that_fails_on_its_first_run_is_not_said_to_keep_earlier_rows(population, session):
    session.on("HEAD " + census.county_url("48"), FakeResponse(503))
    code, _ = population.run(["population"], now=T1)
    assert counties(population, "48") == {}
    detail = population.source("census-pl-2020")["statusDetail"]
    assert detail == "1 state file(s) failed; no rows had been published for those states, so they have none"
    assert population.source("census-pl-2020")["recordCount"] == 2 + 3


def test_when_every_state_file_fails_the_published_date_of_the_kept_rows_stays(population, session):
    population.run(["population"], now=T1)
    rows = population.read("population/county.json")["rows"]
    for fips in ("06", "48"):
        session.on("HEAD " + census.county_url(fips), FakeResponse(503))
    code, _ = population.run(["population"], now=T2)
    assert code == 1
    county = population.read("population/county.json")
    assert county["rows"] == rows and county["dataset"]["sourcePublishedAt"] == "2024-12-05T13:07:34Z"
    record = population.source("census-pl-2020")
    assert (record["processingStatus"], record["lastSuccessfulCheck"]) == ("failed", T1)
    assert record["statusDetail"] == "no county rows retrieved; 2 state file(s) failed; previous rows kept"


# --- the review queue across weekly and daily runs ------------------------------------------

def test_the_items_of_a_stage_that_did_not_run_stay_in_the_queue(population, session):
    session.on("HEAD " + census.county_url("48"), FakeResponse(503))
    population.run(["population"], now=T1)  # the weekly run: one state file failed
    code, ctx = population.run(["scotus", "relationships", "events"], now=T2)  # the daily run does not touch population
    assert code == 0
    queue = population.read("manifest.json")["reviewQueue"]
    assert queue["byKind"]["population_state_failed"] == 1
    assert ("population_state_failed", "county:48") in [(r["kind"], r["entity"]) for r in pipeline.read_json(population.staging / "review.json")["items"]]
    # When the population stage runs again, its own items replace the earlier ones.
    session.serve_bytes(census.county_url("48"), census.county_file("48"))
    population.run(["population"], now=T3)
    assert "population_state_failed" not in population.read("manifest.json")["reviewQueue"]["byKind"]
