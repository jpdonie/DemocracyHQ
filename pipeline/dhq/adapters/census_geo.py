"""Census Bureau boundary geometry -> optimised TopoJSON.

Layers and vintages (never mixed silently; each published layer records its
source dataset in ``sources.json`` and in every ``GeographicUnit``):

* state, county, cd119 - 2025 Cartographic Boundary Files, 1:5,000,000
  (``GENZ2025``). cd119 = districts of the 119th Congress (Jan 2025 - Jan 2027).
* cd120 - 2026 TIGER/Line shapefiles (``TIGER2026/CD``), districts of the 120th
  Congress as collected by the Census Redistricting Data Program. TIGER/Line
  polygons extend over water, so they are clipped to the 2025 cartographic
  state shoreline (1:500,000) and then simplified. This mirrors how the Bureau
  derives cartographic boundary files but the result is a DemocracyHQ
  derivative for display, not an official product.
* circuit, nation - the state layer merged by DemocracyHQ: the states of each
  federal judicial circuit (the table in :mod:`dhq.circuits`, which is checked
  against 28 U.S.C. § 41 before anything is published) and all states and
  territories together. They are drawn from the same simplified state
  boundaries, so their outlines lie on the state outlines. They show which
  states belong together; they are not an official map of anything.

Geometry work is delegated to mapshaper (deterministic, topology preserving).
"""

from __future__ import annotations

import csv
import json
import logging
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Optional, Iterable

from ..circuits import REGIONAL
from ..http import FetchError, Fetcher
from ..util import CACHE_DIR, REPO_ROOT, STATES, http_date_to_iso, write_bytes_atomic

log = logging.getLogger("dhq.census_geo")

GENZ_BASE = "https://www2.census.gov/geo/tiger/GENZ2025/shp"
TIGER_CD_BASE = "https://www2.census.gov/geo/tiger/TIGER2026/CD"
MAPSHAPER = REPO_ROOT / "node_modules" / ".bin" / "mapshaper"

CB_FILES = {
    "state": "cb_2025_us_state_5m",
    "county": "cb_2025_us_county_5m",
    "cd119": "cb_2025_us_cd119_5m",
    "state500k": "cb_2025_us_state_500k",
    "county_cd119": "cb_2025_us_county_within_cd119_500k",
}


#: Largest file taken from one boundary archive, and largest total, as the archive's directory states them. The
#: largest member today is the county-within-district shapefile (about 19.5 MB), and no archive unpacks to more
#: than about 20 MB.
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024


def _unzip(zip_path: Path, dest: Path) -> Path:
    """Unpack a boundary archive, which is untrusted input, into ``dest``.

    Names are flattened, so no member can be written outside ``dest``. An archive whose
    directory states a member or a total above the limits is refused before anything is
    unpacked, and each member is inflated a megabyte at a time: ``zipfile`` stops at the
    stated size and checks the CRC, so a member cannot unpack to more than it states.
    """
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = [info for info in zf.infolist() if not info.is_dir()]
        largest = max(members, key=lambda info: info.file_size, default=None)
        total = sum(info.file_size for info in members)
        if (largest and largest.file_size > MAX_MEMBER_BYTES) or total > MAX_ARCHIVE_BYTES:
            raise ValueError(f"{zip_path.name} refused: its directory states {total} bytes in all, the largest member "
                             f"{largest.file_size if largest else 0} bytes; at most {MAX_ARCHIVE_BYTES} in all and "
                             f"{MAX_MEMBER_BYTES} for one member are expected")
        for info in members:
            name = Path(info.filename).name
            if name in ("", ".", ".."):
                continue
            with zf.open(info) as source, (dest / name).open("wb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
                written = target.tell()
            if written != info.file_size:
                raise ValueError(f"{zip_path.name} refused: {info.filename} unpacks to {written} bytes, "
                                 f"its directory states {info.file_size}")
    return dest


def _mapshaper(args: Iterable[str]) -> None:
    cmd = [str(MAPSHAPER), *args]
    log.info("mapshaper %s", " ".join(str(a) for a in args)[:300])
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        raise RuntimeError(f"mapshaper failed: {proc.stderr[-2000:]}")


def _current_copy(fetcher: Fetcher, url: str, dest: Path) -> Optional[str]:
    """Make ``dest`` the file the Bureau serves now; return that file's Last-Modified date.

    The Bureau regenerates boundary files in place (Missouri's 2026 files were
    replaced on November 10, 2026, with a notice to download them again). A copy is
    therefore reused only while the server reports the same Last-Modified date and
    size as when it was downloaded. The date returned describes the file actually
    used, not merely the one on the server.
    """
    headers = fetcher.head(url)
    modified = http_date_to_iso(headers.get("Last-Modified"))
    length = headers.get("Content-Length") or ""
    stamp = f"{modified or ''}|{length}"
    sidecar = dest.with_suffix(".modified")
    kept = sidecar.read_text(encoding="utf-8") if sidecar.exists() else None
    if kept != stamp or not dest.exists():
        # Every file fetched here is a ZIP archive. A body of another size than announced, or an HTML
        # page served with status 200, is refused before it replaces the copy or the stamp is recorded,
        # so it is not reused on later runs.
        incoming = fetcher.download(url, dest.with_name(dest.name + ".new"), force=True)
        size = incoming.stat().st_size
        with incoming.open("rb") as handle:
            magic = handle.read(4)
        problems = [f"{size} bytes where the server announced {length}"] if length.isdigit() and size != int(length) else []
        if magic != b"PK\x03\x04":
            problems.append("not a ZIP archive")
        if problems:
            incoming.unlink()
            raise FetchError(url, 200, f"downloaded file refused ({'; '.join(problems)}); the earlier copy, if any, is kept")
        incoming.replace(dest)
        write_bytes_atomic(sidecar, stamp.encode("utf-8"), root=dest.parent)
    return (sidecar.read_text(encoding="utf-8").split("|")[0]) or None


def download_sources(fetcher: Fetcher, cache: Path = CACHE_DIR / "geo") -> dict:
    """Download all boundary archives that changed; return provenance (url, last-modified) of the files used."""
    provenance: dict[str, dict] = {}
    for key, stem in CB_FILES.items():
        url = f"{GENZ_BASE}/{stem}.zip"
        dest = cache / f"{stem}.zip"
        modified = _current_copy(fetcher, url, dest)
        _unzip(dest, cache / stem)
        provenance[key] = {"url": url, "lastModified": modified, "bytes": dest.stat().st_size}
    cd_dir = cache / "tl_2026_cd120"
    latest = None
    total = 0
    for fips in STATES:
        stem = f"tl_2026_{fips}_cd120"
        url = f"{TIGER_CD_BASE}/{stem}.zip"
        dest = cache / "tiger" / f"{stem}.zip"
        modified = _current_copy(fetcher, url, dest)
        if modified and (latest is None or modified > latest):
            latest = modified
        total += dest.stat().st_size
        _unzip(dest, cd_dir)
    provenance["cd120"] = {"url": TIGER_CD_BASE + "/", "lastModified": latest, "bytes": total, "files": len(STATES)}
    return provenance


#: How the state layer is simplified. The circuit and nation layers are merged from states simplified the same way.
STATE_SIMPLIFY = ["-simplify", "visvalingam", "weighted", "55%", "keep-shapes", "-clean"]
NATION_GEOID = "US"
NATION_NAME = "United States"


def build_layers(out_dir: Path, cache: Path = CACHE_DIR / "geo") -> dict[str, Path]:
    """Run mapshaper to produce the six published TopoJSON layers."""
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs: dict[str, Path] = {}
    common_out = ["format=topojson", "quantization=1000000", "bbox"]

    state_shp = cache / CB_FILES["state"] / f"{CB_FILES['state']}.shp"
    outputs["state"] = out_dir / "states.topo.json"
    _mapshaper([
        str(state_shp), "-rename-layers", "state",
        "-filter-fields", "GEOID,STUSPS,NAME",
        *STATE_SIMPLIFY,
        "-o", *common_out, str(outputs["state"]),
    ])

    # The states of each regional circuit, merged. A state the statute places in no circuit is left out.
    circuit_of = json.dumps({fips: circuit.geoid for circuit in REGIONAL for fips in circuit.states}, sort_keys=True)
    circuit_names = json.dumps({circuit.geoid: circuit.short_name for circuit in REGIONAL}, sort_keys=True)
    outputs["circuit"] = out_dir / "circuits.topo.json"
    _mapshaper([
        str(state_shp), "-rename-layers", "circuit",
        "-filter-fields", "GEOID",
        *STATE_SIMPLIFY,
        "-each", f"CIRCUIT = ({circuit_of})[GEOID] || null",
        "-filter", "CIRCUIT !== null",
        "-dissolve", "CIRCUIT",
        "-each", f"GEOID = CIRCUIT, NAME = ({circuit_names})[CIRCUIT]",
        "-filter-fields", "GEOID,NAME",
        "-clean",
        "-o", *common_out, str(outputs["circuit"]),
    ])

    # Every state and territory of the state layer as one shape, for records that apply nationwide.
    outputs["nation"] = out_dir / "nation.topo.json"
    _mapshaper([
        str(state_shp), "-rename-layers", "nation",
        "-filter-fields", "GEOID",
        *STATE_SIMPLIFY,
        "-dissolve",
        "-each", f"GEOID = '{NATION_GEOID}', NAME = '{NATION_NAME}'",
        "-clean",
        "-o", *common_out, str(outputs["nation"]),
    ])

    county_shp = cache / CB_FILES["county"] / f"{CB_FILES['county']}.shp"
    outputs["county"] = out_dir / "counties.topo.json"
    _mapshaper([
        str(county_shp), "-rename-layers", "county",
        "-filter-fields", "GEOID,STATEFP,NAME,NAMELSAD,STUSPS",
        "-simplify", "visvalingam", "weighted", "45%", "keep-shapes",
        "-clean",
        "-o", *common_out, str(outputs["county"]),
    ])

    cd119_shp = cache / CB_FILES["cd119"] / f"{CB_FILES['cd119']}.shp"
    outputs["cd119"] = out_dir / "cd119.topo.json"
    _mapshaper([
        str(cd119_shp), "-rename-layers", "cd119",
        "-filter", "CD119FP !== 'ZZ'",
        "-each", "CDFP=CD119FP",
        "-filter-fields", "GEOID,STATEFP,CDFP,NAMELSAD",
        "-simplify", "visvalingam", "weighted", "50%", "keep-shapes",
        "-clean",
        "-o", *common_out, str(outputs["cd119"]),
    ])

    # cd120: merge the per-state TIGER/Line files, clip to the cartographic
    # shoreline, then simplify. ``ZZ`` marks water not assigned to a district.
    cd_dir = cache / "tl_2026_cd120"
    shp_files = sorted(str(p) for p in cd_dir.glob("tl_2026_*_cd120.shp"))
    if len(shp_files) != len(STATES):
        raise RuntimeError(f"expected {len(STATES)} TIGER cd120 shapefiles, found {len(shp_files)}")
    state500k = cache / CB_FILES["state500k"] / f"{CB_FILES['state500k']}.shp"
    outputs["cd120"] = out_dir / "cd120.topo.json"
    _mapshaper([
        "-i", *shp_files, "combine-files",
        "-merge-layers", "force",
        "-rename-layers", "cd120",
        "-filter", "CD120FP !== 'ZZ'",
        "-each", "CDFP=CD120FP",
        "-filter-fields", "GEOID,STATEFP,CDFP,NAMELSAD",
        "-clip", str(state500k),
        "-simplify", "visvalingam", "weighted", "3.2%", "keep-shapes",
        "-clean",
        "-filter-slivers", "min-area=200000",
        "-o", *common_out, str(outputs["cd120"]),
    ])
    return outputs


def county_cd119_pairs(cache: Path = CACHE_DIR / "geo") -> list[dict]:
    """Official county-within-district parts from the Census relationship layer."""
    stem = CB_FILES["county_cd119"]
    shp = cache / stem / f"{stem}.shp"
    out_csv = cache / f"{stem}.csv"
    _mapshaper([str(shp), "-o", "format=csv", str(out_csv)])
    areas: dict[tuple[str, str], list[int]] = {}
    with out_csv.open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            state = row["STATEFP"].zfill(2)
            cd = row["CD119FP"].zfill(2)
            county = row["COUNTYFP"].zfill(3)
            if cd == "ZZ":
                continue
            # The Bureau's own land and water area of the part, so that a water-only or tiny part can be told apart.
            total = areas.setdefault((state + county, state + cd), [0, 0])
            total[0] += int(float(row.get("ALAND") or 0))
            total[1] += int(float(row.get("AWATER") or 0))
    return [{"county": c, "cd119": d, "aland": a[0], "awater": a[1]} for (c, d), a in sorted(areas.items())]


def district_land_areas(cache: Path = CACHE_DIR / "geo") -> dict[str, dict[str, int]]:
    """Official land area (``ALAND``, square metres) of every district in both source files.

    The figures are the Census Bureau's own attributes, read before any clipping or
    simplification, so they describe the official districts and not the drawn shapes.
    """
    out: dict[str, dict[str, int]] = {"cd119": {}, "cd120": {}}
    cd119_shp = cache / CB_FILES["cd119"] / f"{CB_FILES['cd119']}.shp"
    cd119_csv = cache / "cd119_aland.csv"
    _mapshaper([str(cd119_shp), "-filter", "CD119FP !== 'ZZ'", "-filter-fields", "GEOID,ALAND", "-o", "format=csv", str(cd119_csv)])
    shp_files = sorted(str(f) for f in (cache / "tl_2026_cd120").glob("tl_2026_*_cd120.shp"))
    cd120_csv = cache / "cd120_aland.csv"
    _mapshaper(["-i", *shp_files, "combine-files", "-merge-layers", "force", "-filter", "CD120FP !== 'ZZ'",
                "-filter-fields", "GEOID,ALAND", "-o", "format=csv", str(cd120_csv)])
    for layer, path in (("cd119", cd119_csv), ("cd120", cd120_csv)):
        with path.open(encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                out[layer][row["GEOID"].zfill(4)] = int(float(row["ALAND"]))
    return out


def compare_unchanged_districts(aland119: dict[str, int], aland120: dict[str, int], redrawn_states: Iterable[str],
                                tolerance: float = 0.001) -> dict:
    """Check that districts in states reported as unchanged really look unchanged.

    DemocracyHQ shows 119th Congress population counts for 120th Congress districts
    only where the Census Bureau reports the boundaries as unchanged. This is the
    safeguard behind that rule: for every such district the official land area in
    the two files must agree within ``tolerance`` (relative), and every district
    number must exist in both. Anything else is reported so the counts can be
    withheld and a person can look.
    """
    redrawn = set(redrawn_states)
    mismatches: list[dict] = []
    compared = 0
    largest = 0.0
    for geoid in sorted(set(aland119) | set(aland120)):
        if geoid[:2] in redrawn:
            continue
        a, b = aland119.get(geoid), aland120.get(geoid)
        if a is None or b is None:
            mismatches.append({"geoid": geoid, "aland119": a, "aland120": b, "relativeDifference": None,
                               "reason": "district number present in only one of the two files"})
            continue
        compared += 1
        base = max(a, b)
        diff = abs(a - b) / base if base else 0.0
        largest = max(largest, diff)
        if diff > tolerance:
            mismatches.append({"geoid": geoid, "aland119": a, "aland120": b, "relativeDifference": round(diff, 6),
                               "reason": "official land area differs between the two files"})
    return {"tolerance": tolerance, "compared": compared, "largestRelativeDifference": round(largest, 6), "mismatches": mismatches}


# --- TopoJSON helpers ----------------------------------------------------------

def topo_feature_bboxes(topo: dict, layer: str) -> dict[str, list[float]]:
    """Decode quantised arcs and return ``GEOID -> [w, s, e, n]``.

    Alaska's Aleutian chain crosses the antimeridian; for any feature whose raw
    extent is wider than 180 degrees the eastern-hemisphere part is shifted by
    -360 so ``fitBounds`` receives a compact box.
    """
    scale = topo.get("transform", {}).get("scale", [1, 1])
    translate = topo.get("transform", {}).get("translate", [0, 0])
    decoded: list[list[tuple[float, float]]] = []
    for arc in topo["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
        decoded.append(points)

    def arc_points(index: int) -> list[tuple[float, float]]:
        return decoded[index] if index >= 0 else decoded[~index]

    def collect(arcs, acc: list[tuple[float, float]]) -> None:
        for item in arcs:
            if isinstance(item, list):
                collect(item, acc)
            else:
                acc.extend(arc_points(item))

    result: dict[str, list[float]] = {}
    for geom in topo["objects"][layer]["geometries"]:
        points: list[tuple[float, float]] = []
        if geom.get("arcs"):
            collect(geom["arcs"], points)
        if not points:
            continue
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        if max(xs) - min(xs) > 180:
            xs = [x - 360 if x > 0 else x for x in xs]
        result[geom["properties"]["GEOID"]] = [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]
    return result


def load_topo(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
