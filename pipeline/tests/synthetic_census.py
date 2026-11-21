"""SYNTHETIC Census Bureau files for stage tests. Invented counts and shapes, not real ones.

Boundary archives hold a placeholder ``.shp`` only: mapshaper is replaced by :func:`fake_mapshaper`,
which writes the TopoJSON and CSV files the pipeline asks for, with the feature counts the geo stage
checks (56 states, about 3,250 counties, 441 districts in each Congress). The population files follow
the pipe-delimited layout and column offsets the adapter reads; every count adds up, as in the real files.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from dhq.adapters import census_geo, census_pop
from dhq.util import STATES, census_dir_name

from conftest import make_zip

# --- boundaries -----------------------------------------------------------------------

TIGER_STATES = list(STATES)
#: 441 districts: eight in each state, except seven in the last seven.
DISTRICTS = [f"{fips}{n:02d}" for i, fips in enumerate(TIGER_STATES) for n in range(1, (8 if i < 49 else 7) + 1)]
COUNTIES = [f"{fips}{2 * n + 1:03d}" for fips in TIGER_STATES for n in range(58)]
#: The states the synthetic page lists as redrawn; their districts' land areas differ between the two files.
REDRAWN = ["06", "48", "49"]
PAGE = ("<html><body><p>Three states (California, Texas, and Utah) delineated new boundaries for the 2026 election cycle. "
        "All other states, the District of Columbia, and Puerto Rico had no changes to their congressional district "
        "boundaries from the 2024 cycle.</p></body></html>")


def boundary_urls() -> Dict[str, str]:
    """Address -> name of the shapefile inside, for every archive the geo stage downloads."""
    urls = {f"{census_geo.GENZ_BASE}/{stem}.zip": f"{stem}.shp" for stem in census_geo.CB_FILES.values()}
    urls.update({f"{census_geo.TIGER_CD_BASE}/tl_2026_{fips}_cd120.zip": f"tl_2026_{fips}_cd120.shp" for fips in TIGER_STATES})
    return urls


def serve_boundaries(session, last_modified: str = "Mon, 09 Nov 2026 20:30:21 GMT", tiger_modified: Optional[str] = None) -> None:
    for url, shp in boundary_urls().items():
        session.serve_bytes(url, make_zip({shp: b"synthetic shapes"}), last_modified=(tiger_modified or last_modified) if "TIGER" in url else last_modified)


def _topology(layer: str) -> dict:
    if layer == "state":
        features = [{"GEOID": fips, "NAME": name, "STUSPS": abbr} for fips, (abbr, name) in STATES.items()]
    elif layer == "county":
        features = [{"GEOID": geoid, "NAMELSAD": f"Synthetic County {geoid[2:]}"} for geoid in COUNTIES]
    else:
        features = [{"GEOID": geoid, "NAMELSAD": f"Congressional District {int(geoid[2:])}"} for geoid in DISTRICTS]
    return {
        "type": "Topology",
        "arcs": [[[i % 100, i // 100], [1, 1]] for i in range(len(features))],
        "objects": {layer: {"type": "GeometryCollection", "geometries": [
            {"type": "Polygon", "arcs": [[i]], "properties": props} for i, props in enumerate(features)]}},
    }


def _write_csv(path: Path, header: List[str], rows: Iterable[list]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def fake_mapshaper(args: Iterable[str]) -> None:
    """Stands in for the mapshaper command line: writes the file named after ``-o``, as mapshaper would."""
    args = [str(a) for a in args]
    out = Path(args[-1])
    if "format=csv" in args:
        if out.name == "cd119_aland.csv":
            _write_csv(out, ["GEOID", "ALAND"], ([g, 1_000_000 + i] for i, g in enumerate(DISTRICTS)))
        elif out.name == "cd120_aland.csv":
            _write_csv(out, ["GEOID", "ALAND"], ([g, 1_000_000 + i + (5000 if g[:2] in REDRAWN else 0)] for i, g in enumerate(DISTRICTS)))
        else:  # county parts within 119th Congress districts
            _write_csv(out, ["STATEFP", "CD119FP", "COUNTYFP", "ALAND", "AWATER"], ([c[:2], "01", c[2:], 5000, 10] for c in COUNTIES))
        return
    layer = args[args.index("-rename-layers") + 1]
    out.write_text(json.dumps(_topology(layer)), encoding="utf-8")


# --- population -------------------------------------------------------------------------

#: Synthetic totals: three counties and two districts per state, adding up to the state total.
COUNTY_TOTALS = {"06": [1000, 2000, 3000], "48": [400, 500, 600]}
DISTRICT_TOTALS = {"06": [2500, 3500], "48": [700, 800]}


def _unit(total: int) -> tuple[Dict[str, int], Dict[str, int]]:
    """Race and origin groups, and the voting-age groups, that add up exactly."""
    def groups(t: int) -> Dict[str, int]:
        parts = {"hispanic": t // 4, "white": t // 2, "black": t // 10, "aian": 1, "asian": 2, "nhpi": 1, "other": 1}
        return {"total": t, **parts, "multi": t - sum(parts.values())}
    return groups(total), groups(total * 3 // 4)


def values(total: int) -> List[int]:
    """The published row for a unit with this total."""
    eth, vap = _unit(total)
    return census_pop._compose(total, eth, vap)


def _segment_row(logrecno: int, first: int, start: int, cells: Dict[str, int], width: int = 150) -> str:
    row = ["SYN", "ZZ", "000", "01", f"{logrecno:07d}"] + ["0"] * (width - 5)
    row[5] = str(first)
    for name, offset in census_pop.REL.items():
        row[start + offset] = str(cells[name])
    return "|".join(row)


def _geo_line(sumlev: int, logrecno: int, geoid: str, field3: str = "00", pop100: int = 0) -> str:
    row = ["SYNGEO", "ZZ", f"{sumlev:03d}", field3, "00", "", "", f"{logrecno:07d}", "", geoid] + [""] * 10
    row[-7] = str(pop100)
    return "|".join(row)


def national_file(states: Iterable[str]) -> bytes:
    geo, seg1, seg2 = [], [], []
    for n, fips in enumerate(states, start=1):
        total = sum(COUNTY_TOTALS[fips])
        eth, vap = _unit(total)
        geo.append(_geo_line(40, n, fips))
        seg1.append(_segment_row(n, total, census_pop.PL_SEG1_P2, eth))
        seg2.append(_segment_row(n, vap["total"], census_pop.PL_SEG2_P4, vap))
    return make_zip({"usgeo2020.npl": "\n".join(geo), "us000012020.npl": "\n".join(seg1), "us000022020.npl": "\n".join(seg2)})


def county_file(fips: str, totals: Optional[List[int]] = None) -> bytes:
    abbr = STATES[fips][0].lower()
    totals = totals or COUNTY_TOTALS[fips]
    units = [(40, fips, sum(totals))] + [(50, f"{fips}{2 * i + 1:03d}", t) for i, t in enumerate(totals)] + [(140, f"{fips}001000100", 0)]
    geo, seg1, seg2 = [], [], []
    for n, (sumlev, geoid, total) in enumerate(units, start=1):
        eth, vap = _unit(total)
        geo.append(_geo_line(sumlev, n, geoid))
        seg1.append(_segment_row(n, total, census_pop.PL_SEG1_P2, eth))
        seg2.append(_segment_row(n, vap["total"], census_pop.PL_SEG2_P4, vap))
    return make_zip({f"{abbr}geo2020.pl": "\n".join(geo), f"{abbr}000012020.pl": "\n".join(seg1), f"{abbr}000022020.pl": "\n".join(seg2)})


def district_file(fips: str) -> bytes:
    abbr = STATES[fips][0].lower()
    totals = DISTRICT_TOTALS[fips]
    units = [(40, fips, sum(totals))] + [(500, f"{fips}{i + 1:02d}", t) for i, t in enumerate(totals)] + [(500, f"{fips}ZZ", 0)]
    geo, eth_rows, vap_rows = [], [], []
    for n, (sumlev, geoid, total) in enumerate(units, start=1):
        eth, vap = _unit(total)
        geo.append(_geo_line(sumlev, n, geoid, field3="00" if sumlev == 40 else "19", pop100=total))
        eth_rows.append(_segment_row(n, 0, census_pop.CD_SEG_ETHNICITY[1], eth))
        vap_rows.append(_segment_row(n, 0, census_pop.CD_SEG_VAP[1], vap))
    eth_rows.append(_segment_row(len(units) + 1, 0, census_pop.CD_SEG_ETHNICITY[1], _unit(0)[0]))
    vap_rows.append(_segment_row(len(units) + 1, 0, census_pop.CD_SEG_VAP[1], _unit(0)[1]))
    return make_zip({f"{abbr}geo2020.cd19": "\n".join(geo), f"{abbr}000052020.cd19": "\n".join(eth_rows),
                     f"{abbr}000062020.cd19": "\n".join(vap_rows)})


def national_url() -> str:
    return f"{census_pop.PL_BASE}/National/us2020.npl.zip"


def county_url(fips: str) -> str:
    return f"{census_pop.PL_BASE}/{census_dir_name(fips)}/{STATES[fips][0].lower()}2020.pl.zip"


def district_url(fips: str) -> str:
    return f"{census_pop.CD119_BASE}/{census_dir_name(fips)}/{STATES[fips][0].lower()}2020.cd19.zip"


def serve_population(session, states: Iterable[str], last_modified: str = "Thu, 05 Dec 2024 13:07:34 GMT") -> None:
    states = list(states)
    session.serve_bytes(national_url(), national_file(states), last_modified=last_modified)
    for fips in states:
        session.serve_bytes(county_url(fips), county_file(fips), last_modified=last_modified)
        session.serve_bytes(district_url(fips), district_file(fips), last_modified=last_modified)
