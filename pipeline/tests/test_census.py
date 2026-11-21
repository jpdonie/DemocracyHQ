"""Census adapters: table arithmetic, layout self-checks, ranged zip reads, district area check."""

import zipfile

import pytest

from dhq.adapters import census_geo, census_pop
from dhq.http import FetchError
from dhq.remotezip import RemoteZip

from conftest import make_zip

EIGHT = ("hispanic", "white", "black", "aian", "asian", "nhpi", "other", "multi")


def table(total, parts):
    return {"total": total, **dict(zip(EIGHT, parts))}


def test_compose_copies_counts_unchanged_when_the_tables_agree():
    eth = table(100, [30, 40, 10, 2, 8, 1, 3, 6])
    vap = table(75, [20, 32, 8, 1, 7, 1, 2, 4])
    assert census_pop._compose(100, eth, vap) == [100, 30, 40, 10, 2, 8, 1, 3, 6, 75, 20, 32, 8, 1, 7, 1, 2, 4]


def test_compose_rejects_tables_that_disagree_instead_of_adjusting_them():
    good_vap = table(75, [20, 32, 8, 1, 7, 1, 2, 4])
    with pytest.raises(ValueError, match="!= P1 total"):
        census_pop._compose(101, table(100, [30, 40, 10, 2, 8, 1, 3, 6]), good_vap)
    with pytest.raises(ValueError, match="do not sum to total population"):
        census_pop._compose(100, table(100, [30, 40, 10, 2, 8, 1, 3, 5]), good_vap)
    with pytest.raises(ValueError, match="voting-age categories"):
        census_pop._compose(100, table(100, [30, 40, 10, 2, 8, 1, 3, 6]), table(75, [20, 32, 8, 1, 7, 1, 2, 5]))


def test_variable_definitions_name_the_census_table_cells():
    pl = {d["key"]: d for d in census_pop.variable_definitions("pl")}
    assert pl["total"]["code"] == "P1_001N"
    assert pl["hispanic"]["code"] == "P2_002N"
    assert pl["white"]["code"] == "P2_005N"
    assert pl["vap_total"]["code"] == "P3_001N"
    assert pl["vap_multi"]["code"] == "P4_011N"
    assert pl["vap_black"]["universe"] == "Population 18 years and over"
    dhc = {d["key"]: d for d in census_pop.variable_definitions("dhc")}
    assert dhc["hispanic"]["code"] == "P9_002N" and dhc["vap_total"]["code"] == "P11_001N"
    assert list(pl) == census_pop.VARIABLE_ORDER == list(dhc)


def test_rows_are_matched_by_record_number_not_by_position():
    lines = ["PLST|ZZ|000|01|0000003|9", "PLST|ZZ|000|01|0000001|7", "PLST|ZZ|000|01|0000002|8"]
    found = census_pop._rows_by_logrecno(lines, {"0000001", "0000003"})
    assert found["0000001"][5] == "7" and found["0000003"][5] == "9" and "0000002" not in found


# --- district land-area check ---------------------------------------------------------

def test_identical_areas_pass():
    result = census_geo.compare_unchanged_districts({"0601": 1000, "0602": 2000}, {"0601": 1000, "0602": 2000}, [])
    assert result == {"tolerance": 0.001, "compared": 2, "largestRelativeDifference": 0.0, "mismatches": []}


def test_small_measurement_differences_are_within_tolerance():
    result = census_geo.compare_unchanged_districts({"0601": 1_000_000}, {"0601": 1_000_500}, [])
    assert result["mismatches"] == [] and result["largestRelativeDifference"] == 0.0005


def test_a_changed_area_in_a_supposedly_unchanged_state_is_reported():
    result = census_geo.compare_unchanged_districts({"0601": 1_000_000, "0602": 5}, {"0601": 1_100_000, "0602": 5}, [])
    assert [m["geoid"] for m in result["mismatches"]] == ["0601"]
    assert result["mismatches"][0]["reason"] == "official land area differs between the two files"
    assert result["compared"] == 2


def test_a_district_number_in_only_one_file_is_reported():
    result = census_geo.compare_unchanged_districts({"0601": 10, "0602": 10}, {"0601": 10, "0603": 10}, [])
    assert sorted(m["geoid"] for m in result["mismatches"]) == ["0602", "0603"]
    assert all(m["relativeDifference"] is None for m in result["mismatches"])
    assert result["compared"] == 1


def test_states_reported_as_redrawn_are_not_compared():
    result = census_geo.compare_unchanged_districts({"4801": 10, "0601": 10}, {"4801": 99, "0601": 10}, ["48"])
    assert result["compared"] == 1 and result["mismatches"] == []


# --- bounding boxes from TopoJSON -----------------------------------------------------

def test_bounding_box_from_quantised_arcs():
    topo = {
        "transform": {"scale": [0.5, 0.5], "translate": [-100, 30]},
        "arcs": [[[0, 0], [10, 0], [0, 10]], [[10, 10], [-10, 0], [0, -10]]],
        "objects": {"x": {"geometries": [
            {"type": "Polygon", "arcs": [[0, 1]], "properties": {"GEOID": "06"}},
            {"type": "Polygon", "arcs": [[~0]], "properties": {"GEOID": "07"}},
            {"type": None, "properties": {"GEOID": "08"}},
        ]}},
    }
    boxes = census_geo.topo_feature_bboxes(topo, "x")
    assert boxes["06"] == [-100.0, 30.0, -95.0, 35.0]
    assert boxes["07"] == [-100.0, 30.0, -95.0, 35.0]  # a reversed arc covers the same points
    assert "08" not in boxes  # a unit with no geometry gets no box rather than a made-up one


def test_bounding_box_across_the_antimeridian_is_made_compact():
    topo = {
        "arcs": [[[-179, 51], [1, 1]], [[179, 51], [-1, 1]]],
        "objects": {"x": {"geometries": [{"type": "MultiPolygon", "arcs": [[[0]], [[1]]], "properties": {"GEOID": "02"}}]}},
    }
    west, south, east, north = census_geo.topo_feature_bboxes(topo, "x")["02"]
    assert (west, east) == (-182.0, -178.0) and east - west < 180
    assert (south, north) == (51.0, 52.0)


# --- reading members of a remote zip with range requests ------------------------------

ZIP_URL = "https://bulk.example.test/archive.zip"


def test_reads_one_member_without_downloading_the_archive(fetcher, session):
    filler = bytes(8 * 1024 * 1024)  # 8 MB that must not be transferred (the reader buffers 1 MB at a time)
    data = make_zip({"wanted.txt": "the wanted member\n" * 10, "filler.bin": filler}, zipfile.ZIP_STORED)
    session.serve_bytes(ZIP_URL, data)
    rz = RemoteZip(ZIP_URL, fetcher, block_size=64 * 1024)
    assert sorted(rz.names()) == ["filler.bin", "wanted.txt"]
    assert rz.read("wanted.txt") == b"the wanted member\n" * 10
    before = rz.raw.bytes_fetched
    assert rz.member_bytes("wanted.txt") == b"the wanted member\n" * 10
    assert rz.raw.bytes_fetched - before < 2048  # one exact ranged request for a small member
    assert rz.raw.bytes_fetched < len(data) / 3
    assert rz.last_modified == "Mon, 01 Jun 2026 08:00:00 GMT"
    assert all("Range" in c["headers"] for c in session.calls if c["method"] == "GET")


def test_head_lines_stops_early(fetcher, session):
    session.serve_bytes(ZIP_URL, make_zip({"rows.txt": "".join(f"row {i}\n" for i in range(1000))}))
    assert RemoteZip(ZIP_URL, fetcher).head_lines("rows.txt", 3) == ["row 0", "row 1", "row 2"]


def test_a_corrupted_member_is_rejected_by_its_checksum(fetcher, session):
    data = bytearray(make_zip({"a.txt": "A" * 2000}, zipfile.ZIP_STORED))
    offset = data.index(b"A" * 100)
    data[offset + 50] = ord("B")
    session.serve_bytes(ZIP_URL, bytes(data))
    with pytest.raises(FetchError, match="CRC mismatch"):
        RemoteZip(ZIP_URL, fetcher).member_bytes("a.txt")


def test_a_server_without_range_support_is_refused(fetcher, session):
    from conftest import FakeResponse

    session.on("HEAD " + ZIP_URL, FakeResponse(200, b"", {"Content-Length": "10"}))
    with pytest.raises(FetchError, match="does not advertise byte ranges"):
        RemoteZip(ZIP_URL, fetcher)


def test_a_truncated_range_response_is_an_error(fetcher, session):
    from conftest import FakeResponse

    data = make_zip({"a.txt": "A" * 5000}, zipfile.ZIP_STORED)
    session.on("HEAD " + ZIP_URL, FakeResponse(200, b"", {"Accept-Ranges": "bytes", "Content-Length": str(len(data))}))

    def cut_short(_url, headers, _params):
        start, end = (int(x) for x in headers["Range"].replace("bytes=", "").split("-"))
        return FakeResponse(206, data[start : start + 100], {"Content-Range": f"bytes {start}-{end}/{len(data)}"})

    session.on(ZIP_URL, cut_short)
    with pytest.raises(FetchError, match="short range response"):
        RemoteZip(ZIP_URL, fetcher, block_size=1024)


def test_a_boundary_file_is_downloaded_again_when_the_bureau_replaces_it(session, fetcher, tmp_path):
    from dhq.adapters import census_geo
    url = "https://www2.census.gov/geo/tiger/synthetic/tl_2026_99_cd120.zip"
    dest = tmp_path / "tl_2026_99_cd120.zip"
    first, regenerated = make_zip({"a.shp": "first file"}), make_zip({"a.shp": "regenerated file"})
    session.serve_bytes(url, first, last_modified="Mon, 09 Nov 2026 20:30:21 GMT")
    assert census_geo._current_copy(fetcher, url, dest) == "2026-11-09T20:30:21Z"
    assert census_geo._current_copy(fetcher, url, dest) == "2026-11-09T20:30:21Z"
    assert session.urls("GET") == [url]  # unchanged on the server: the copy is reused
    session.serve_bytes(url, regenerated, last_modified="Tue, 10 Nov 2026 15:00:00 GMT")
    assert census_geo._current_copy(fetcher, url, dest) == "2026-11-10T15:00:00Z"
    assert dest.read_bytes() == regenerated and session.urls("GET") == [url, url]
