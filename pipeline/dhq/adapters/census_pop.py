"""2020 Census counts for states, counties and 119th-Congress districts.

Sources (all keyless, official bulk files on www2.census.gov):

* states   - P.L. 94-171 Redistricting Data, National file (``us2020.npl.zip``)
* counties - P.L. 94-171 Redistricting Data, state files (``xx2020.pl.zip``)
* cd119    - 2020 Census 119th Congressional District Summary File (``xx2020.cd19.zip``)

Only the leading records of each state file are needed (state + counties come
first), so the adapter reads them through HTTP range requests instead of
downloading ~2 GB of block-level data.

Layout self-check: the CD119 file repeats the state total record. Its race /
ethnicity and voting-age cells must equal the P.L. 94-171 state values at the
column offsets below, otherwise the state is rejected. This guards against a
silent layout change.
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, List, Optional

from ..http import Fetcher
from ..remotezip import RemoteZip
from ..util import PL_STATES, STATES, census_dir_name, http_date_to_iso

log = logging.getLogger("dhq.census_pop")

PL_BASE = "https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171"
CD119_BASE = "https://www2.census.gov/programs-surveys/decennial/2020/data/119th-congressional-district-summary-file"

# Column offsets inside the pipe-delimited segment files (0-based; the first
# five columns are FILEID|STUSAB|CHARITER|CIFSN|LOGRECNO).
PL_SEG1_TOTAL = 5        # P1_001N
PL_SEG1_P2 = 76          # P2_001N .. (Hispanic or Latino, and not Hispanic or Latino by race)
PL_SEG2_P3_TOTAL = 5     # P3_001N (population 18 years and over)
PL_SEG2_P4 = 76          # P4_001N ..
CD_SEG_ETHNICITY = ("05", 131)  # DHC table P9, same first 11 cells as P.L. table P2
CD_SEG_VAP = ("06", 76)         # DHC table P11, same first 11 cells as P.L. table P4

# Offsets relative to the start of P2/P4 (and P9/P11).
REL = {"total": 0, "hispanic": 1, "white": 4, "black": 5, "aian": 6, "asian": 7, "nhpi": 8, "other": 9, "multi": 10}

VARIABLE_ORDER = [
    "total", "hispanic", "white", "black", "aian", "asian", "nhpi", "other", "multi",
    "vap_total", "vap_hispanic", "vap_white", "vap_black", "vap_aian", "vap_asian", "vap_nhpi", "vap_other", "vap_multi",
]

_LABELS = {
    "total": "Total population",
    "hispanic": "Hispanic or Latino (of any race)",
    "white": "White alone, not Hispanic or Latino",
    "black": "Black or African American alone, not Hispanic or Latino",
    "aian": "American Indian and Alaska Native alone, not Hispanic or Latino",
    "asian": "Asian alone, not Hispanic or Latino",
    "nhpi": "Native Hawaiian and Other Pacific Islander alone, not Hispanic or Latino",
    "other": "Some Other Race alone, not Hispanic or Latino",
    "multi": "Two or more races, not Hispanic or Latino",
}


def variable_definitions(kind: str) -> List[dict]:
    """``kind`` is ``pl`` (tables P1-P4) or ``dhc`` (tables P1, P9, P11)."""
    eth_table, vap_table = ("P2", "P4") if kind == "pl" else ("P9", "P11")
    total_code = "P1_001N"
    vap_total_code = "P3_001N" if kind == "pl" else "P11_001N"
    defs = []
    for key in VARIABLE_ORDER:
        base = key.replace("vap_", "")
        is_vap = key.startswith("vap_")
        if base == "total":
            code = vap_total_code if is_vap else total_code
        else:
            code = f"{vap_table if is_vap else eth_table}_{REL[base] + 1:03d}N"
        label = _LABELS[base]
        if is_vap:
            label = ("Population 18 years and over" if base == "total" else f"{label}, 18 years and over")
        defs.append({"key": key, "code": code, "label": label, "universe": "Population 18 years and over" if is_vap else "Total population"})
    return defs


def _ints(row: List[str], start: int) -> Dict[str, int]:
    return {name: int(row[start + off]) for name, off in REL.items()}


def _compose(total: int, eth: Dict[str, int], vap: Dict[str, int]) -> List[int]:
    if eth["total"] != total:
        raise ValueError(f"ethnicity table total {eth['total']} != P1 total {total}")
    parts = [eth[k] for k in ("hispanic", "white", "black", "aian", "asian", "nhpi", "other", "multi")]
    if sum(parts) != total:
        raise ValueError("race/ethnicity categories do not sum to total population")
    vparts = [vap[k] for k in ("hispanic", "white", "black", "aian", "asian", "nhpi", "other", "multi")]
    if sum(vparts) != vap["total"]:
        raise ValueError("voting-age categories do not sum to voting-age total")
    return [total, *parts, vap["total"], *vparts]


def _rows_by_logrecno(lines: Iterable[str], wanted: set[str]) -> Dict[str, List[str]]:
    found: Dict[str, List[str]] = {}
    for line in lines:
        row = line.split("|")
        if row[4] in wanted:
            found[row[4]] = row
            if len(found) == len(wanted):
                break
    return found


def state_population(fetcher: Fetcher) -> tuple[Dict[str, List[int]], dict]:
    """Return ``{state FIPS: values}`` from the national P.L. 94-171 file."""
    url = f"{PL_BASE}/National/us2020.npl.zip"
    rz = RemoteZip(url, fetcher, block_size=1024 * 1024)
    geo = [l.split("|") for l in rz.read("usgeo2020.npl").decode("latin-1").splitlines()]
    # Header fields: 2 SUMLEV, 3 GEOVAR, 4 GEOCOMP. GEOCOMP "00" = the whole unit, not a geographic component.
    states = {g[7]: g[9] for g in geo if g[2] == "040" and g[4] == "00"}
    seg1 = _rows_by_logrecno(rz.read("us000012020.npl").decode("latin-1").splitlines(), set(states))
    seg2 = _rows_by_logrecno(rz.read("us000022020.npl").decode("latin-1").splitlines(), set(states))
    rows: Dict[str, List[int]] = {}
    for logrecno, fips in states.items():
        r1, r2 = seg1[logrecno], seg2[logrecno]
        rows[fips] = _compose(int(r1[PL_SEG1_TOTAL]), _ints(r1, PL_SEG1_P2), _ints(r2, PL_SEG2_P4))
        if int(r2[PL_SEG2_P3_TOTAL]) != rows[fips][9]:
            raise ValueError(f"P3/P4 voting-age totals disagree for state {fips}")
    return rows, {"url": url, "lastModified": http_date_to_iso(rz.last_modified)}


#: The most lines read from the head of one member. The largest head the stage needs is a state line and its
#: counties (Texas has 254), or one line per district; a member that never reaches its stop line is refused.
MAX_HEAD_LINES = 20_000


def _head_until(rz: RemoteZip, name: str, stop) -> List[str]:
    out: List[str] = []
    # RemoteZip.lines refuses a line longer than 1 MB, so a hostile member cannot make one line fill memory.
    reader = rz.lines(name)
    try:
        for line in reader:
            if stop(line):
                break
            out.append(line)
            if len(out) > MAX_HEAD_LINES:
                raise ValueError(f"{name}: no end of the needed rows within {MAX_HEAD_LINES} lines")
    finally:
        reader.close()
    return out


def county_population(fetcher: Fetcher, fips: str) -> tuple[Dict[str, List[int]], dict]:
    """Counties (summary level 050) of one state from its P.L. 94-171 file."""
    abbr = STATES[fips][0].lower()
    url = f"{PL_BASE}/{census_dir_name(fips)}/{abbr}2020.pl.zip"
    rz = RemoteZip(url, fetcher, block_size=1024 * 1024)
    # File order is state (040), counties (050), then everything else.
    geo_lines = _head_until(rz, f"{abbr}geo2020.pl", lambda l: l.split("|")[2] not in ("040", "050"))
    counties = {}
    for line in geo_lines:
        g = line.split("|")
        if g[2] == "050" and g[4] == "00":  # GEOCOMP "00": the whole county
            counties[g[7]] = g[9]
    if not counties:
        raise ValueError(f"no county records found at the head of {url}")
    last = max(int(k) for k in counties)
    wanted = set(counties)
    seg1 = _rows_by_logrecno(_head_until(rz, f"{abbr}000012020.pl", lambda l: int(l.split("|", 5)[4]) > last), wanted)
    seg2 = _rows_by_logrecno(_head_until(rz, f"{abbr}000022020.pl", lambda l: int(l.split("|", 5)[4]) > last), wanted)
    rows: Dict[str, List[int]] = {}
    for logrecno, geoid in counties.items():
        r1, r2 = seg1[logrecno], seg2[logrecno]
        rows[geoid] = _compose(int(r1[PL_SEG1_TOTAL]), _ints(r1, PL_SEG1_P2), _ints(r2, PL_SEG2_P4))
    return rows, {"url": url, "lastModified": http_date_to_iso(rz.last_modified), "bytesFetched": rz.raw.bytes_fetched}


def cd119_population(fetcher: Fetcher, fips: str, state_values: Optional[List[int]]) -> tuple[Dict[str, List[int]], dict]:
    """Districts (summary level 500) of one state from the CD119 Summary File.

    ``state_values`` are the P.L. 94-171 values for the same state; the state
    record in the CD119 file must reproduce them (layout self-check).
    """
    abbr = STATES[fips][0].lower()
    url = f"{CD119_BASE}/{census_dir_name(fips)}/{abbr}2020.cd19.zip"
    rz = RemoteZip(url, fetcher, block_size=1024 * 1024)
    geo = [l.split("|") for l in rz.read(f"{abbr}geo2020.cd19").decode("latin-1").splitlines()]
    state_rec = [g[7] for g in geo if g[2] == "040" and g[3] == "00"]
    # Field 3 is GEOVAR ("19" = 119th Congress) in this product, not GEOCOMP.
    # "ZZ" marks zero-population water areas assigned to no district.
    districts = {g[7]: (g[9], int(g[-7])) for g in geo if g[2] == "500" and not g[9].endswith("ZZ")}
    if len({geoid for geoid, _ in districts.values()}) != len(districts):
        raise ValueError(f"duplicate district records in {url}")
    if not districts or len(state_rec) != 1:
        raise ValueError(f"unexpected geographic header in {url}")
    wanted = set(districts) | set(state_rec)
    last = max(int(k) for k in wanted)

    def segment(seg: str) -> Dict[str, List[str]]:
        return _rows_by_logrecno(
            _head_until(rz, f"{abbr}000{seg}2020.cd19", lambda l: int(l.split("|", 5)[4]) > last), wanted
        )

    seg_eth, seg_vap = segment(CD_SEG_ETHNICITY[0]), segment(CD_SEG_VAP[0])
    if state_values is not None:
        s_eth = _ints(seg_eth[state_rec[0]], CD_SEG_ETHNICITY[1])
        s_vap = _ints(seg_vap[state_rec[0]], CD_SEG_VAP[1])
        check = _compose(s_eth["total"], s_eth, s_vap)
        if check != state_values:
            raise ValueError(f"CD119 layout self-check failed for state {fips}: state record differs from P.L. 94-171")
    rows: Dict[str, List[int]] = {}
    for logrecno, (geoid, pop100) in districts.items():
        eth = _ints(seg_eth[logrecno], CD_SEG_ETHNICITY[1])
        vap = _ints(seg_vap[logrecno], CD_SEG_VAP[1])
        rows[geoid] = _compose(pop100, eth, vap)
    return rows, {"url": url, "lastModified": http_date_to_iso(rz.last_modified), "bytesFetched": rz.raw.bytes_fetched}


def all_populations(fetcher: Fetcher, states: Optional[List[str]] = None) -> dict:
    """Run all three datasets. A failing state is recorded, never fabricated."""
    states = states or PL_STATES
    state_rows, state_prov = state_population(fetcher)
    county_rows: Dict[str, List[int]] = {}
    cd_rows: Dict[str, List[int]] = {}
    failures: List[dict] = []
    latest = {"county": None, "cd119": None}
    for fips in states:
        try:
            rows, prov = county_population(fetcher, fips)
            county_rows.update(rows)
            latest["county"] = max(filter(None, [latest["county"], prov["lastModified"]]), default=None)
        except Exception as exc:  # noqa: BLE001 - recorded and surfaced in the manifest
            log.error("county population failed for %s: %s", fips, exc)
            failures.append({"dataset": "county", "state": fips, "error": str(exc)[:300]})
        try:
            rows, prov = cd119_population(fetcher, fips, state_rows.get(fips))
            cd_rows.update(rows)
            latest["cd119"] = max(filter(None, [latest["cd119"], prov["lastModified"]]), default=None)
        except Exception as exc:  # noqa: BLE001
            log.error("cd119 population failed for %s: %s", fips, exc)
            failures.append({"dataset": "cd119", "state": fips, "error": str(exc)[:300]})
        log.info("population %s done (counties=%d, districts=%d)", fips, len(county_rows), len(cd_rows))
    return {
        "state": {"rows": state_rows, "provenance": state_prov},
        "county": {"rows": county_rows, "provenance": {"url": PL_BASE + "/", "lastModified": latest["county"]}},
        "cd119": {"rows": cd_rows, "provenance": {"url": CD119_BASE + "/", "lastModified": latest["cd119"]}},
        "failures": failures,
    }
