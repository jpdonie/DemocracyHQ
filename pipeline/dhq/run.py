"""Pipeline entry point: ``python -m dhq.run [stage ...]``.

Stages (the numbers refer to docs/ARCHITECTURE.md):

1 discover   - seed lists and selection rules decide what is in scope
2 retrieve   - source adapters download with retries, backoff and rate limits
3 parse      - adapters turn raw payloads into typed records
4 dedupe     - stable ids; duplicates collapse on id
5 validate   - pydantic models, cross-file referential checks
6 normalise  - one schema per entity regardless of source
7 compare    - legislative version diffs, regression guard against published data
8 geo-check  - every geographic relationship must resolve to a known GEOID and
               pass its evidence check
9 review     - anything uncertain is written to staging/review.json, with the
               earlier items of stages that did not run or that failed in this run
10 publish   - the new release is built beside the published one and swapped in;
               only stages that succeeded replace published files; a failed
               stage keeps the last verified data and is reported as failed

Nothing is published for a stage that raised; the manifest then shows the last
successful check so the interface can display staleness honestly.
"""

from __future__ import annotations

import sys

if __name__ == "__main__":
    # ``python -m dhq.run`` runs this file as ``__main__``, before any of the imports below. It hands over to the
    # guarded entry point, which imports the pipeline as ``dhq.run`` and runs it, so that a failed import, like an
    # argument error or an unexpected error outside the stages, exits with code 4 and not with Python's 1.
    from .cli import main as _guarded_main

    sys.exit(_guarded_main())

# ruff: noqa: E402 - the imports follow the guard above on purpose
import argparse
import hashlib
import logging
import os
import re
import shutil
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, NoReturn, Optional

from . import about, circuits, classify, evidence, government
from .adapters import ca_leginfo, census_geo, census_pop, congress, courtlistener, officials, openstates, scotus, uscourts
from .cli import EXIT_UNEXPECTED, LOG_FORMAT
from .http import CredentialMissing, FetchError, Fetcher
from .schemas import (
    CIRCUIT_CASE_ID_PATTERN,
    CaseBelowEnd,
    CaseLink,
    CaseLinkEnd,
    Court,
    EntityRef,
    EntityRelationship,
    EvidenceRef,
    Government,
    IssueTag,
    LegalCase,
    LegislativeInstrument,
    RelationshipScope,
    RemovedTag,
    SourceRecord,
    Verification,
    VerificationStatus,
)
from .sources import SOURCES
from .util import (
    CACHE_DIR, PUBLIC_DATA, REPO_ROOT, SEEDS_DIR, STAGING_DIR, STATES, STATE_BY_NAME, content_hash, load_dotenv, now_iso,
    read_json, sha256_bytes, write_json,
)

log = logging.getLogger("dhq.run")

SCHEMA_VERSION = 1
CD120_PAGE = SOURCES["census-cd120-page"]["url"]
NINE_STATES_RE = re.compile(r"(\w+) states \(([^)]+)\)\s+delineated new boundaries for the 2026 election cycle", re.I)
#: The Bureau's affirmative statement that every other state is unchanged. Counts are carried over only on its strength.
UNCHANGED_RE = re.compile(r"All other states,? (the District of Columbia,? )?(and Puerto Rico )?had no changes to their congressional district boundaries[^.]*\.", re.I)


class Context:
    def __init__(self, public: Path = PUBLIC_DATA, staging: Path = STAGING_DIR, cache: Path = CACHE_DIR,
                 fetcher_factory: Optional[Callable[..., Fetcher]] = None):
        self.now = now_iso()
        self.public = public
        self.staging = staging / "data"
        self.scratch = staging / "work"
        self.cache = cache
        self.fetcher_factory = fetcher_factory or (lambda **kw: Fetcher(**kw))
        self.status: Dict[str, dict] = {}
        #: Review items raised in this run, each with the stage that raised it.
        self.review: List[dict] = []
        #: The queue published with this release: ``review`` (less the items of stages that raised) plus the
        #: earlier items of stages that did not run or that raised.
        self.queue: List[dict] = []
        self.stage: Optional[str] = None
        self.published_dirs: List[str] = []
        self.published_files: List[str] = []

    def ok(self, source_id: str, **extra) -> None:
        self.status[source_id] = {"processingStatus": "ok", "lastAttempt": self.now, "lastSuccessfulCheck": self.now,
                                  "retrievedAt": self.now, "statusDetail": None, **extra}

    def fail(self, source_id: str, status: str, detail: str) -> None:
        self.status[source_id] = {"processingStatus": status, "lastAttempt": self.now, "statusDetail": detail[:500]}

    def flag(self, kind: str, entity: str, detail: str) -> None:
        self.review.append({"kind": kind, "entity": entity, "detail": detail, "flaggedAt": self.now, "stage": self.stage})


# --- regression guard -----------------------------------------------------------

def keep_previous_if_regressed(ctx: Context, rel_path: str, new_obj: dict, metric: Callable[[dict], Dict[str, int]], entity: str) -> dict:
    """Never let a shorter/emptier record overwrite a previously verified one.

    A docket that suddenly has fewer entries or documents, or a bill with fewer
    versions or mirrored texts, is far more likely a truncated upstream response
    than a real change, so the published record is kept and the anomaly is
    queued for human review. ``metric`` gives named counts; any count that drops
    holds the record. The previous record itself is returned when it is kept.
    """
    previous = read_json(ctx.public / rel_path)
    if not previous:
        return new_obj
    new, old = metric(new_obj), metric(previous)
    shrunk = [f"{name} {new[name]} < {old[name]}" for name in old if new[name] < old[name]]
    if shrunk:
        ctx.flag("regression", entity, f"new record is smaller than the published one ({', '.join(shrunk)}); kept published version")
        return previous
    return new_obj


def _docket_size(record: dict) -> Dict[str, int]:
    qp = record.get("questionsPresented") or {}
    return {"entries": record.get("entryCount", 0), "documents": record.get("documentCount", 0),
            "Questions Presented link": int(bool(qp)), "Questions Presented text": int(bool(qp.get("text")))}


def _docket_size_unread_qp(record: dict) -> Dict[str, int]:
    """:func:`_docket_size` for a docket whose Questions Presented document could not be read in this run: its text is not compared."""
    return {**_docket_size(record), "Questions Presented text": 0}


def _bill_size(record: dict) -> Dict[str, int]:
    versions = record.get("versions", [])
    return {"versions": len(versions), "mirrored texts": sum(v.get("textAvailability") == "mirrored" for v in versions),
            "actions": len(record.get("actions", []))}


# --- stage: geography -----------------------------------------------------------

#: The key of the map unit for records that apply nationwide.
NATION_KEY = f"nation:{census_geo.NATION_GEOID}"
COMPOSITION_RULE_ID = "circuit-composition-1"


def circuits_document(verified: dict, checked_at: str) -> dict:
    """``geo/circuits.json``: the thirteen courts of appeals, each with the statute's words for its circuit, and the
    table of states the circuit map is drawn from. ``verified`` is what :func:`circuits.verify_composition` returned."""
    return {
        "courts": [Court(**record).model_dump(mode="json") for record in circuits.court_records(verified)],
        "statute": {
            "edition": verified["edition"], "currentThrough": verified["currentThrough"], "checkedAt": checked_at,
            "sourceId": circuits.SOURCE_ID, "ruleId": COMPOSITION_RULE_ID,
            "sections": [{"citation": "28 U.S.C. § 41", "url": circuits.SECTION_41_URL},
                         {"citation": "48 U.S.C. § 1821(a)", "url": circuits.SECTION_1821_URL}],
        },
        "circuitOfState": dict(sorted(circuits.CIRCUIT_OF_STATE.items())),
        # States and territories on the map that neither provision places in a circuit, and names in the statute's
        # table that are not a unit on the map.
        "withoutCircuit": list(circuits.WITHOUT_CIRCUIT),
        "notOnTheMap": list(circuits.NOT_ON_THE_MAP),
    }


def _circuit_composition(ctx: Context, fetcher: Fetcher) -> dict:
    """The document :func:`circuits_document` describes, checked against the statute in this run.

    When the statute says something else than the table in :mod:`dhq.circuits`, this raises and the stage publishes
    nothing. When the statute cannot be retrieved, the published document is kept, with the date of its own check,
    as long as it still describes the table as it is now; the source is then reported as failed. Without such a
    document this raises as well: a circuit map is never published on the table's word alone.
    """
    try:
        verified = circuits.verify_composition(fetcher.get(circuits.SECTION_41_URL).text(), fetcher.get(circuits.SECTION_1821_URL).text())
    except FetchError as exc:
        previous = read_json(ctx.public / "geo/circuits.json")
        try:
            earlier = {"quotes": {court["id"]: court["basis"]["quote"] for court in previous["courts"]},
                       "edition": previous["statute"]["edition"], "currentThrough": previous["statute"]["currentThrough"]}
            unchanged = circuits_document(earlier, previous["statute"]["checkedAt"]) == previous
        except (KeyError, TypeError, ValueError):
            unchanged = False
        if not unchanged:
            raise RuntimeError(f"the statute that says which states make up each circuit could not be read ({exc}), and no earlier "
                               "check of the table as it is now has been published") from exc
        log.error("circuit composition: %s", exc)
        ctx.fail(circuits.SOURCE_ID, "failed", f"{exc}; the composition checked on {previous['statute']['checkedAt'][:10]} is kept")
        return previous
    ctx.ok(circuits.SOURCE_ID, sourcePublishedAt=verified["currentThrough"], recordCount=len(circuits.CIRCUITS))
    return circuits_document(verified, ctx.now)


def stage_geo(ctx: Context) -> None:
    fetcher = ctx.fetcher_factory(timeout=180, min_interval=0.15)
    composition = _circuit_composition(ctx, fetcher)
    provenance = census_geo.download_sources(fetcher, ctx.cache / "geo")
    out = ctx.staging / "geo"
    layers = census_geo.build_layers(out, ctx.cache / "geo")
    merged = "2025 Cartographic Boundary File, 1:5,000,000 (state boundaries simplified and merged by DemocracyHQ for display)"
    meta = {
        "nation": ("census-cb-2025", merged, "United States", "nation"),
        "circuit": ("census-cb-2025", merged, "Federal judicial circuits", "judicial_circuit"),
        "state": ("census-cb-2025", "2025 Cartographic Boundary File, 1:5,000,000 (simplified further by DemocracyHQ for display)", "States and equivalent entities", "state"),
        "county": ("census-cb-2025", "2025 Cartographic Boundary File, 1:5,000,000 (simplified further by DemocracyHQ for display)", "Counties and equivalent entities", "county"),
        "cd119": ("census-cb-2025", "2025 Cartographic Boundary File, 1:5,000,000 (simplified further by DemocracyHQ for display)", "Congressional districts, 119th Congress", "congressional_district"),
        "cd120": ("census-tiger-2026-cd120", "2026 TIGER/Line Shapefiles (clipped to the shoreline and simplified by DemocracyHQ for display)", "Congressional districts, 120th Congress", "congressional_district"),
    }
    rows: List[list] = []
    layer_info: Dict[str, dict] = {}
    counts: Dict[str, Dict[str, int]] = {"cd119": {}, "cd120": {}}
    for layer, path in layers.items():
        topo = census_geo.load_topo(path)
        boxes = census_geo.topo_feature_bboxes(topo, layer)
        geoms = topo["objects"][layer]["geometries"]
        seen: set[str] = set()
        for geom in geoms:
            props = geom["properties"]
            geoid = props["GEOID"]
            if geoid in seen:
                raise ValueError(f"duplicate GEOID {geoid} in layer {layer}")
            seen.add(geoid)
            if geoid not in boxes:
                raise ValueError(f"feature without geometry {layer}:{geoid}")
            if layer in ("nation", "circuit"):
                # A merged unit lies in no single state: its row has no state code.
                rows.append([f"{layer}:{geoid}", props["NAME"], "", *boxes[geoid]])
                continue
            state_fips = geoid[:2]
            if state_fips not in STATES:
                raise ValueError(f"unknown state FIPS in {layer}:{geoid}")
            if layer == "state":
                name = props["NAME"]
            elif layer == "county":
                name = f"{props['NAMELSAD']}, {STATES[state_fips][1]}"
            else:
                name = f"{STATES[state_fips][1]} {props['NAMELSAD']}"
                counts[layer][state_fips] = counts[layer].get(state_fips, 0) + 1
            rows.append([f"{layer}:{geoid}", name, state_fips, *boxes[geoid]])
        source_id, vintage, label, geo_type = meta[layer]
        layer_info[layer] = {
            "file": f"geo/{path.name}", "object": layer, "featureCount": len(geoms), "sourceId": source_id,
            "vintage": vintage, "label": label, "geoType": geo_type,
            "sourcePublishedAt": provenance["state" if layer in ("nation", "circuit") else layer]["lastModified"],
        }
    expected = {"nation": 1, "circuit": len(circuits.REGIONAL), "state": 56, "cd119": 441, "cd120": 441}
    for layer, count in expected.items():
        if layer_info[layer]["featureCount"] != count:
            raise ValueError(f"layer {layer}: expected {count} features, got {layer_info[layer]['featureCount']}")
    if not 3200 <= layer_info["county"]["featureCount"] <= 3300:
        raise ValueError("county layer has an implausible feature count")
    keys = {row[0] for row in rows}
    missing = sorted({NATION_KEY, *(court.geo_key for court in circuits.REGIONAL)} - keys)
    if missing:
        raise ValueError(f"the merged layers lack {', '.join(missing)}")
    rows.sort(key=lambda r: r[0])
    write_json(out / "index.json", {"fields": ["key", "name", "stateFips", "w", "s", "e", "n"], "layers": layer_info, "rows": rows})
    write_json(out / "circuits.json", composition, indent=1)
    pairs = census_geo.county_cd119_pairs(ctx.cache / "geo")
    write_json(out / "county_cd119.json", {
        "sourceId": "census-cb-2025",
        "description": "County parts within 119th Congressional Districts, from the Census 'county within congressional district' cartographic boundary file. A county may appear in several districts. Each pair carries the Bureau's land and water area of the part, in square metres.",
        "pairs": [[p["county"], p["cd119"], p["aland"], p["awater"]] for p in pairs],
    })
    ctx.ok("census-cb-2025", sourcePublishedAt=provenance["state"]["lastModified"],
           recordCount=sum(layer_info[l]["featureCount"] for l in ("state", "county", "cd119")))
    ctx.ok("census-tiger-2026-cd120", sourcePublishedAt=provenance["cd120"]["lastModified"], recordCount=layer_info["cd120"]["featureCount"])
    ctx.published_dirs.append("geo")

    # Which states does the Census Bureau report as redrawn for the 120th Congress?
    try:
        page = fetcher.get(CD120_PAGE).text()
        text = re.sub(r"<[^>]+>", " ", page)
        text = re.sub(r"\s+", " ", text)
        match = NINE_STATES_RE.search(text)
        if not match:
            raise ValueError("expected sentence about states with new boundaries not found")
        unchanged = UNCHANGED_RE.search(text)
        if not unchanged:
            raise ValueError("expected sentence saying all other states had no changes not found")
        names = [n.strip().removeprefix("and ").strip() for n in match.group(2).split(",")]
        fips = sorted(STATE_BY_NAME[n.lower()] for n in names)
        missouri = re.search(r"IMPORTANT NOTE: (On September 23, 2026.*?elections\.)", text)
        # Safeguard for carrying 119th Congress counts onto 120th Congress districts:
        # in states reported as unchanged the official land areas must agree.
        areas = census_geo.district_land_areas(ctx.cache / "geo")
        check = census_geo.compare_unchanged_districts(areas["cd119"], areas["cd120"], fips)
        for item in check["mismatches"]:
            ctx.flag("district_area_mismatch", f"cd120:{item['geoid']}",
                     f"{item['reason']} (119th: {item['aland119']}, 120th: {item['aland120']}); population counts are withheld for this district")
        differing = census_geo.compare_unchanged_districts(areas["cd119"], areas["cd120"], [], check["tolerance"])["mismatches"]
        states_differing = sorted({item["geoid"][:2] for item in differing} & set(fips))
        for state_fips in sorted(set(fips) - set(states_differing)):
            ctx.flag("redrawn_state_without_area_change", f"state:{state_fips}",
                     "the Census Bureau lists this state as redrawn, but no district's land area differs between the two files")
        write_json(ctx.staging / "redistricting.json", {
            "congress120": {
                "statesWithNewBoundaries": fips,
                "quote": match.group(0),
                "unchangedQuote": unchanged.group(0),
                "note": (missouri.group(1) if missouri else None),
                "sourceId": "census-cd120-page", "sourceUrl": CD120_PAGE, "checkedAt": ctx.now,
            },
            "areaCheck": {
                "method": "Official land area (ALAND) of each identically numbered district compared between the 119th Congress cartographic boundary file and the 120th Congress TIGER/Line files, in states the Census Bureau reports as unchanged.",
                "tolerance": check["tolerance"],
                "compared": check["compared"],
                "largestRelativeDifference": check["largestRelativeDifference"],
                "mismatches": [item["geoid"] for item in check["mismatches"]],
                "redrawnStatesWithDifferingAreas": states_differing,
            },
            "districtCounts": {layer: dict(sorted(c.items())) for layer, c in counts.items()},
            "populationAvailability": {
                "cd119": "2020 Census 119th Congressional District Summary File",
                "cd120": "Not yet published by the Census Bureau. For states the Bureau reports as unchanged, the 119th Congress figures describe identical districts.",
            },
        })
        ctx.ok("census-cd120-page", recordCount=len(fips))
        ctx.published_files.append("redistricting.json")
    except Exception as exc:  # noqa: BLE001 - keep last verified list
        log.error("census 120th page: %s", exc)
        previous_sources = {s["id"]: s for s in (read_json(ctx.public / "sources.json") or {}).get("sources", [])}
        before = (previous_sources.get("census-tiger-2026-cd120") or {}).get("sourcePublishedAt")
        if before != provenance["cd120"]["lastModified"]:
            # New district boundaries without the Bureau's list of redrawn states would carry 119th Congress
            # counts onto districts that may have changed. Keep the previous boundaries and list together.
            ctx.fail("census-cd120-page", "failed", str(exc))
            raise RuntimeError("new 120th Congress boundary files arrived, but the Census Bureau's list of redrawn states "
                               f"could not be read ({exc}); the previous boundaries and list are kept") from exc
        ctx.fail("census-cd120-page", "failed", str(exc))


# --- stage: population ----------------------------------------------------------

def stage_population(ctx: Context) -> None:
    fetcher = ctx.fetcher_factory(timeout=180, min_interval=0.05)
    result = census_pop.all_populations(fetcher)
    out = ctx.staging / "population"
    failures = result["failures"]

    published: Dict[str, int] = {}
    earlier_states: Dict[str, set] = {}

    def dataset(name: str, title: str, source_id: str, kind: str, geography_note: str, rows: dict, provenance: dict) -> None:
        previous = read_json(ctx.public / f"population/{name}.json") or {}
        merged = dict(previous.get("rows", {}))  # states that failed keep their last verified rows
        merged.update(rows)
        published[name] = len(merged)
        earlier_states[name] = {geoid[:2] for geoid in previous.get("rows", {})}
        write_json(out / f"{name}.json", {
            "dataset": {
                "id": name, "title": title, "censusYear": 2020, "sourceId": source_id,
                "tables": "P1, P2, P3, P4" if kind == "pl" else "P1, P9, P11",
                "geographyNote": geography_note,
                # When every state file failed, the rows are all from the earlier file, and so is their date.
                "sourcePublishedAt": provenance.get("lastModified") or (previous.get("dataset") or {}).get("sourcePublishedAt"),
                "methodology": "Counts copied without modification from the Census Bureau summary file. Race categories are "
                               "'alone, not Hispanic or Latino'; Hispanic or Latino may be of any race. Categories sum to the total.",
            },
            "variables": census_pop.variable_definitions(kind),
            "rows": dict(sorted(merged.items())),
        })

    dataset("state", "2020 Census population by state", "census-pl-2020", "pl",
            "States, District of Columbia and Puerto Rico.", result["state"]["rows"], result["state"]["provenance"])
    dataset("county", "2020 Census population by county", "census-pl-2020", "pl",
            "Counties and equivalents as they existed for the 2020 Census. Joined to 2025 boundaries by GEOID.",
            result["county"]["rows"], result["county"]["provenance"])
    dataset("cd119", "2020 Census population by 119th Congress district", "census-cd119-sf", "dhc",
            "2020 Census counts retabulated by the Census Bureau for 119th Congress district boundaries.",
            result["cd119"]["rows"], result["cd119"]["provenance"])
    for f in failures:
        ctx.flag("population_state_failed", f"{f['dataset']}:{f['state']}", f["error"])

    def failed_files(name: str) -> Optional[str]:
        states = sorted({f["state"] for f in failures if f["dataset"] == name})
        if not states:
            return None
        without = [fips for fips in states if fips not in earlier_states[name]]
        if not without:
            return f"{len(states)} state file(s) failed; previous rows kept"
        if len(without) == len(states):
            return f"{len(states)} state file(s) failed; no rows had been published for those states, so they have none"
        return (f"{len(states)} state file(s) failed; previous rows kept, except for {len(without)} state(s) "
                f"with no rows published before ({', '.join(without)})")

    # recordCount is what the published files hold: rows fetched now plus rows kept from earlier runs.
    if len(result["county"]["rows"]) == 0:
        ctx.fail("census-pl-2020", "failed", "; ".join(filter(None, ["no county rows retrieved", failed_files("county")])))
    else:
        ctx.ok("census-pl-2020", sourcePublishedAt=result["county"]["provenance"].get("lastModified"),
               recordCount=published["state"] + published["county"], statusDetail=failed_files("county"))
    if len(result["cd119"]["rows"]) == 0:
        ctx.fail("census-cd119-sf", "failed", "; ".join(filter(None, ["no district rows retrieved", failed_files("cd119")])))
    else:
        ctx.ok("census-cd119-sf", sourcePublishedAt=result["cd119"]["provenance"].get("lastModified"),
               recordCount=published["cd119"], statusDetail=failed_files("cd119"))
    ctx.published_dirs.append("population")


# --- stage: litigation (Supreme Court) -------------------------------------------

#: How the document behind a link or tag is described to a reader.
EVIDENCE_LABELS = {
    "qp": "the Court's Questions Presented document for this docket, which usually reproduces the question as the party seeking review framed it",
    "initiating": "the filing that opened this docket, written by the party seeking relief (not a ruling)",
    "opinion": "an opinion or order of the Court linked from this docket",
    "url": "a document linked from this docket",
}
#: Verification method of a link a maintainer wrote, whose quoted passage the pipeline found in the cited document.
CURATED_METHOD = "maintainer_curated"
#: The field the issue rules read when a docket has Questions Presented text.
QP_FIELD = "questions presented"
#: The field the issue rules read when a docket has no Questions Presented text.
LONG_EVIDENCE_FIELD = "full text of the initiating filing or opinion"


class EvidenceNotCaseSpecific(Exception):
    """The linked document does not identify the docket on its first pages."""


class SeedError(ValueError):
    """The seed names a document the docket does not have."""


def opinion_names_docket(text: str, docket: str, window: int = 3000) -> bool:
    """True when the docket number appears on the first pages of an opinion."""
    docket = docket.strip()
    if not docket:
        return False
    pattern = re.escape(docket).replace(r"\-", "[-\u2010-\u2014]")
    return re.search(pattern, text[:window], re.I) is not None


class CaseDocuments:
    """The documents of one docket that a link or a tag may cite. Each is fetched once.

    ``which`` is ``"qp"`` (the Court's Questions Presented document), ``"initiating"``
    (the first document linked from the docket), ``"opinion"`` (the opinion linked
    from the latest docket entry that links one) or the full address of a document.
    An address is accepted only when the docket itself links it, so a link can
    never rest on a document from somewhere else.
    """

    def __init__(self, fetcher: Fetcher, payload: dict):
        self.fetcher = fetcher
        self.payload = payload
        self._texts: Dict[str, str] = {}
        #: Address -> why it could not be retrieved. Each failure is tried once per run.
        self.failed: Dict[str, FetchError] = {}

    def _linked(self) -> List[str]:
        addresses: List[str] = []
        for entry in self.payload.get("ProceedingsandOrder") or []:
            addresses.extend(link.get("DocumentUrl") or "" for link in entry.get("Links") or [])
            addresses.extend(href for href, _label in scotus._HREF_RE.findall(entry.get("Text") or ""))
        return [a.split("#")[0] for a in addresses if a]

    def address(self, which: str) -> Optional[str]:
        url: Optional[str] = None
        entries = self.payload.get("ProceedingsandOrder") or []
        if which == "qp":
            url = scotus.qp_url(self.payload) if self.payload.get("QPLink") else None
        elif which == "opinion":
            for entry in entries:
                for href, _label in scotus._HREF_RE.findall(entry.get("Text") or ""):
                    if "/opinions/" in href:
                        url = href.split("#")[0]
        elif which == "initiating":
            for entry in entries:
                links = entry.get("Links") or []
                if links:
                    url = links[0].get("DocumentUrl")
                    break
        elif which.startswith("https://"):
            if which.split("#")[0] not in self._linked():
                raise SeedError(f"{which} is not linked from docket {self.payload.get('CaseNumber')}")
            url = which.split("#")[0]
        else:
            raise SeedError(f"unknown evidence document {which!r}")
        return url if url and scotus.is_safe_document_url(url) else None

    def get(self, which: str) -> tuple[Optional[str], Optional[str]]:
        """``(address, text)``; both ``None`` when the docket has no such document.

        Raises :class:`FetchError` when the document cannot be retrieved or read, including
        when no text can be extracted from it: that says nothing about what it contains.
        """
        url = self.address(which)
        if not url:
            return None, None
        if url in self.failed:
            raise self.failed[url]
        if url not in self._texts:
            try:
                result = self.fetcher.get(url)
                try:
                    text = scotus.extract_pdf_text(result.content)
                except scotus.PdfTextError as exc:
                    raise FetchError(url, result.status, f"no text could be extracted: {exc}") from exc
            except FetchError as exc:
                self.failed[url] = exc
                raise
            if "/opinions/" in url and not opinion_names_docket(text or "", str(self.payload.get("CaseNumber") or "")):  # e.g. "20-542"
                # Some dockets link a whole volume of the U.S. Reports instead of a slip opinion.
                # A passage found somewhere in a volume says nothing about this case.
                raise EvidenceNotCaseSpecific(url)
            self._texts[url] = text
        return url, self._texts[url]

    @staticmethod
    def label(which: str, override: Optional[str] = None) -> str:
        return override or EVIDENCE_LABELS["url" if which.startswith("https://") else which]


def _check_opinion_links(fetcher: Fetcher, case: LegalCase, checked_on: str) -> int:
    """Ask the Court for each opinion or order linked inside a docket entry.

    The docket sometimes keeps an address after the Court has moved the file. An
    address that answers 404 or 410 is published as unavailable, with the date it
    was checked, instead of as a working link. Any other failure proves nothing
    about the link, so the record is left as it was. Filing links are not
    checked here: there are about two thousand of them.
    """
    dead = 0
    status_of: Dict[str, Optional[int]] = {}
    for doc in case.documents:
        if "-o" not in doc.id.rsplit("-e", 1)[-1] or not doc.url:
            continue
        address = doc.url.split("#")[0]
        if address not in status_of:
            try:
                fetcher.head(address)
                status_of[address] = 200
            except FetchError as exc:
                status_of[address] = exc.status
            except Exception as exc:  # noqa: BLE001 - a network failure says nothing about the link
                log.warning("could not check %s: %s", address, type(exc).__name__)
                status_of[address] = None
        if status_of[address] in (404, 410):
            dead += 1
            doc.availability = "unavailable"
            doc.accessNote = (f"The Court's docket gives this address, which answered {status_of[address]} (not found) "
                              f"when checked on {checked_on[:10]}. The Court may have moved the file.")
    return dead


#: A federal district court case number: an optional division ("3:") or office ("EP-") prefix, the year, the case type
#: and the sequence number, then optional judges' initials ("-DCG-JES-JVB"). Read after letter case is folded.
_DISTRICT_NUMBER_RE = re.compile(r"(?:(?P<division>\d{1,2}):|(?P<office>[a-z]{1,3})-)?(?P<year>\d{2}|\d{4})-(?P<type>[a-z]{2,4})-(?P<seq>\d{1,6})"
                                 r"(?P<judges>(?:-[a-z]{1,4})*)")


def _lower_court_number_key(number: str) -> tuple[str, Optional[str], str]:
    """What must agree between two spellings of one lower-court case number: the key, the prefix and the judges' initials.

    A district court writes one case as "3:21-cv-00259-DCG-JES-JVB" (division number) and as
    "EP-21-CV-00259-DCG-JES-JVB" (office letters). Letter case and leading zeros are set aside, and the key is the
    year, case type and sequence number. Any other form (a court of appeals or a state court number) is its own key and
    must agree exactly, apart from letter case and spacing.
    """
    text = re.sub(r"\s+", " ", number).strip().casefold()
    match = _DISTRICT_NUMBER_RE.fullmatch(text)
    if not match:
        return f"exact:{text}", None, ""
    prefix = f"{match['division']}:" if match["division"] else f"{match['office']}-" if match["office"] else None
    return f"district:{match['year'][-2:]}-{match['type']}-{int(match['seq'])}", prefix, match["judges"]


def same_lower_court_number(a: str, b: str) -> bool:
    """True when two lower-court case numbers of the same court name one case (see :func:`_lower_court_number_key`).

    Some districts number cases separately in each division or office: two different prefixes of the same kind
    ("1:" and "3:", or "SA-" and "EP-") are two cases. A division number cannot be matched to office letters from the
    number alone, so when one number has a division and the other office letters, or only one has a prefix, the
    judges' initials must be given on both and agree; the same year, type, sequence number and panel is one case.
    """
    (key_a, prefix_a, judges_a), (key_b, prefix_b, judges_b) = _lower_court_number_key(a), _lower_court_number_key(b)
    if key_a != key_b:
        return False
    if prefix_a == prefix_b:
        return not (judges_a and judges_b and judges_a != judges_b)
    if prefix_a and prefix_b and prefix_a[-1] == prefix_b[-1]:
        return False
    return bool(judges_a) and judges_a == judges_b


def _same_lower_court(records: List[dict]) -> None:
    """Point dockets at each other when they come from the same case below.

    Two dockets are paired only when the Court's docket gives both the same
    lower court and a lower-court case number that names the same case, read by
    :func:`same_lower_court_number`. The pairing is derived by this rule
    (``same-lower-court-2``) from the two dockets; the Court does not state it.
    Each side records the number as the other docket gives it.
    """
    for record in records:
        record["sameLowerCourt"] = []
    for i, a in enumerate(records):
        for b in records[i + 1:]:
            court_a, court_b = (a.get("lowerCourt") or {}).get("name"), (b.get("lowerCourt") or {}).get("name")
            if not court_a or not court_b or court_a.casefold() != court_b.casefold():
                continue
            numbers_a = (a.get("lowerCourt") or {}).get("caseNumbers") or []
            numbers_b = (b.get("lowerCourt") or {}).get("caseNumbers") or []
            shared = sorted(set(numbers_a) & set(numbers_b))
            if shared:
                as_a, as_b = shared[0], shared[0]
            else:
                pair = next(((x, y) for x in numbers_a for y in numbers_b if same_lower_court_number(x, y)), None)
                if not pair:
                    continue
                as_a, as_b = pair
            a["sameLowerCourt"].append({"caseId": b["id"], "docket": b["docketNumber"], "caseName": b["caseName"], "number": as_b})
            b["sameLowerCourt"].append({"caseId": a["id"], "docket": a["docketNumber"], "caseName": a["caseName"], "number": as_a})
    for record in records:
        record["sameLowerCourt"].sort(key=lambda r: r["docket"])


def _still_seeded(rel: dict, case_id: str, seed: dict, geo: dict) -> bool:
    """True when the current seed lists this published case-to-place link unchanged.

    Only then does an earlier check cover it: the same place, relationship, scope,
    quote and cited document.
    """
    which = geo.get("evidenceUrl") or geo.get("evidence") or seed.get("evidenceUrl") or seed.get("evidence", "qp")
    document = geo.get("evidenceLabel") or seed.get("evidenceLabel") or EVIDENCE_LABELS.get("url" if which.startswith("https://") else which)
    support = rel.get("support") or {}
    return (rel.get("ruleId") == "cases-seed-2" and rel.get("basis") == "curated"
            and rel.get("source") == {"type": "case", "id": case_id}
            and rel.get("target") == {"type": "geography", "id": geo.get("key")}
            and rel.get("relationshipType") == geo.get("relationship")
            and rel.get("scope") == {"kind": geo.get("scope"), "note": geo.get("note")}
            and support.get("quote") == geo.get("quote") and support.get("document") == document
            and (not which.startswith("https://") or support.get("url") == which.split("#")[0]))


def _carried_case_links(ctx: Context, previous_links: Dict[str, dict], case_id: str, seed: dict) -> List[dict]:
    """The published case-to-place links of a docket not re-checked in this run that its seed still lists unchanged."""
    carried: List[dict] = []
    for geo in seed.get("geographies", []):
        kept = previous_links.get(f"rel-{case_id}-{geo['key'].replace(':', '-')}")
        if kept and _still_seeded(kept, case_id, seed, geo):
            carried.append(kept)
        elif kept:
            ctx.flag("evidence_unavailable", f"{case_id}->{geo['key']}",
                     "link not published: its seed changed since the passage was last checked, and the docket was not re-checked in this run")
    return carried


def _unavailable_detail(exc: FetchError, *, held: bool, first: bool, qp: Optional[str], kept: int, dropped: int) -> str:
    """The review item of a cited document that could not be retrieved: what became of the docket and of what cites it."""
    parts = [f"a cited document could not be retrieved or read: {exc}"]
    if held:
        parts.append("the docket was not refreshed: its new record is smaller than the published one and is held for review, "
                     "so the published record stays as it was")
        return "; ".join(parts)
    parts.append("the docket was published for the first time without it" if first else "the docket was refreshed without it")
    if qp:
        parts.append(qp)
    if kept:
        parts.append(f"{kept} link(s) or tag(s) that cite it keep their last published check")
    if dropped:
        parts.append(f"{dropped} link(s) or tag(s) that cite it are not published, as no earlier check of the same passage applies")
    return "; ".join(parts)


def _states_of(links: List[dict]) -> List[str]:
    """State FIPS codes a docket is filed under, from its case-to-place links (as stage_scotus derives them)."""
    return [r["target"]["id"].split(":")[1] for r in links
            if r["target"]["id"].startswith("state:") and r["scope"]["kind"] in ("statewide", "county")]


def stage_scotus(ctx: Context) -> None:
    seeds = read_json(SEEDS_DIR / "cases.json")["cases"]
    fetcher = ctx.fetcher_factory(timeout=60, min_interval=scotus.MIN_INTERVAL)
    state_names = {fips: name for fips, (_abbr, name) in STATES.items()}
    unit_names = {row[0]: row[1] for row in (read_json(_staged_or_public(ctx, "geo/index.json")) or {}).get("rows", [])}
    out = ctx.staging / "litigation"
    evidence_dir = ctx.scratch / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    summaries: List[dict] = []
    records: List[dict] = []
    relationships: List[dict] = []
    previous_links = {r["id"]: r for r in (read_json(ctx.public / "relationships.json") or {}).get("relationships", [])}
    failures = never_published = 0
    dead_links = 0
    documents_read = documents_failed = 0
    #: Links and tags citing a document that could not be retrieved, on dockets that were refreshed.
    cited_kept = cited_dropped = 0
    unique: List[dict] = []
    seen_dockets: set[str] = set()
    for seed in seeds:
        if seed["docket"].upper() in seen_dockets:
            ctx.flag("duplicate_seed", f"scotus-{seed['docket'].lower()}", "docket is listed more than once in seeds/cases.json; the later entry was ignored")
            continue
        seen_dockets.add(seed["docket"].upper())
        unique.append(seed)
    seeds = unique
    for seed in seeds:
        docket = seed["docket"]
        case_id = f"scotus-{docket.lower()}"
        rel_path = f"litigation/cases/{case_id}.json"
        previous = read_json(ctx.public / rel_path)
        try:
            payload = scotus.fetch_payload(fetcher, docket)
            documents = CaseDocuments(fetcher, payload)
            default_doc = seed.get("evidenceUrl") or seed.get("evidence", "qp")
            # A cited document that cannot be retrieved does not stop the docket from being refreshed. Only the
            # links and tags that cite it are affected: each keeps its last published check, or is not published.
            cited: Counter = Counter()  # (address that could not be retrieved, "kept" or "dropped") -> links and tags citing it
            ev_error: Optional[FetchError] = None
            try:
                ev_url, ev_text = documents.get(default_doc)
            except EvidenceNotCaseSpecific as exc:
                ctx.flag("evidence_not_case_specific", case_id,
                         f"the linked opinion document does not name docket {docket} on its first pages, so it was not used as evidence: {exc}")
                ev_url, ev_text = None, None
            except FetchError as exc:
                ev_url, ev_text, ev_error = None, None, exc
            earlier_tags = (previous or {}).get("issueTags", [])
            qp_error: Optional[FetchError] = None
            try:
                qp_text = documents.get("qp")[1]
            except FetchError as exc:
                # The text read from the same address on an earlier run is the last verified copy; it is kept.
                earlier_qp = (previous or {}).get("questionsPresented") or {}
                qp_text = earlier_qp.get("text") if earlier_qp.get("url") == exc.url else None
                qp_error = exc
            case = scotus.normalise(docket, payload, checked_at=ctx.now,
                                    first_observed=(previous or {}).get("firstObservedAt"), qp_text=qp_text)
            fields = [("case caption", case.caseName)]
            # Words the PDF broke across lines are joined for the rules only; passages are checked against the text as extracted.
            if qp_text:
                fields.append((QP_FIELD, classify.join_line_hyphens(qp_text)))
            elif ev_text:
                fields.append((LONG_EVIDENCE_FIELD, classify.join_line_hyphens(ev_text), classify.LONG))
            case.issueTags = classify.classify(fields)
            if not qp_text:
                # The rules would have read a document that could not be retrieved: keep what they found in it last time.
                unread = {QP_FIELD: qp_error, LONG_EVIDENCE_FIELD: ev_error}
                assigned = {t.tag for t in case.issueTags}
                for earlier_tag in earlier_tags:
                    error = unread.get(earlier_tag.get("matchedField"))
                    if error and earlier_tag["tag"] not in assigned:
                        case.issueTags.append(IssueTag(**earlier_tag))
                        assigned.add(earlier_tag["tag"])
                        cited[error.url, "kept"] += 1
            for curated in seed.get("tags", []):
                if any(t.tag == curated["tag"] for t in case.issueTags):
                    continue  # the published rules already assign it
                which = curated.get("evidenceUrl") or curated.get("evidence") or default_doc
                try:
                    _tag_url, tag_text = documents.get(which)
                    problem = evidence.find_passage(curated.get("quote"), tag_text)
                except (EvidenceNotCaseSpecific, SeedError) as exc:
                    problem = str(exc)
                except FetchError as exc:
                    # Published before with this passage and this document: that check stands.
                    earlier = classify.curated_tag(curated["tag"], CaseDocuments.label(which, curated.get("evidenceLabel")), curated["quote"])
                    problem = None if earlier.model_dump(mode="json") in earlier_tags else (
                        f"the cited document could not be retrieved in this run and no earlier check of this passage exists ({exc})")
                    cited[exc.url, "dropped" if problem else "kept"] += 1
                if problem:
                    ctx.flag("curated_tag_check_failed", f"{case_id}#{curated['tag']}", f"tag not published: {problem}")
                    continue
                case.issueTags.append(classify.curated_tag(curated["tag"], CaseDocuments.label(which, curated.get("evidenceLabel")), curated["quote"]))
            dead_links += _check_opinion_links(fetcher, case, ctx.now)
            unclassified = [e for e in case.events if e.classificationRule == "sc-other"]
            if unclassified:
                ctx.flag("unclassified_entry", case_id,
                         f"{len(unclassified)} docket entr{'y' if len(unclassified) == 1 else 'ies'} matched no labelling rule and may hide a ruling; "
                         f"first: {unclassified[0].date} {unclassified[0].description[:160]!r}")
            if (case.docketType or "").lower() == "application" and not any(
                    e.eventType in ("application_ruling", "dismissed") for e in case.events):
                ctx.flag("application_without_ruling", case_id,
                         "application docket with no entry recognised as a ruling on the application; it may be pending, or a ruling may be worded in a way the rules miss")
            geo_keys: List[str] = []
            case_links: List[dict] = []
            for geo in seed.get("geographies", []):
                link_id = f"rel-{case_id}-{geo['key'].replace(':', '-')}"
                which = geo.get("evidenceUrl") or geo.get("evidence") or default_doc
                link_url: Optional[str] = None
                try:
                    link_url, link_text = documents.get(which)
                    problem = evidence.find_passage(geo.get("quote"), link_text)
                    if not problem:
                        unnamed = evidence.names_place(geo["quote"], geo["key"], state_names, unit_names)
                        problem = f"the passage does not name {unnamed}" if unnamed else None
                except (EvidenceNotCaseSpecific, SeedError) as exc:
                    problem = str(exc)
                except FetchError as exc:
                    kept = previous_links.get(link_id)
                    if kept and _still_seeded(kept, case_id, seed, geo):
                        case_links.append(kept)  # its last check stands, with the date of that check
                        geo_keys.extend(_states_of([kept]))
                        cited[exc.url, "kept"] += 1
                        continue
                    ctx.flag("evidence_unavailable", f"{case_id}->{geo['key']}",
                             f"link not published: the cited document could not be retrieved in this run and no earlier check of this passage exists ({exc})")
                    cited[exc.url, "dropped"] += 1
                    continue
                if problem:
                    # A link whose passage cannot be shown in the cited document is not published at all.
                    ctx.flag("evidence_check_failed", f"{case_id}->{geo['key']}", f"link not published: {problem} (document: {link_url or which})")
                    continue
                case_links.append(EntityRelationship(
                    id=link_id,
                    source=EntityRef(type="case", id=case_id), target=EntityRef(type="geography", id=geo["key"]),
                    relationshipType=geo["relationship"],
                    scope=RelationshipScope(kind=geo["scope"], note=geo.get("note")),
                    support=EvidenceRef(url=link_url, quote=geo["quote"], sourceId=scotus.SOURCE_ID,
                                        document=CaseDocuments.label(which, geo.get("evidenceLabel") or seed.get("evidenceLabel"))),
                    basis="curated", ruleId="cases-seed-2",
                    verification=Verification(
                        status=VerificationStatus.VERIFIED_PRIMARY, method=CURATED_METHOD, checkedAt=ctx.now,
                        note="The link and its description were written by a maintainer. The quoted passage was found in the cited document "
                             f"on this date, {evidence.IGNORED_IN_WORDS}. The check shows that the document says this; "
                             "it does not check the description.",
                    ),
                ).model_dump(mode="json"))
                if geo["key"].startswith("state:") and geo["scope"] in ("statewide", "county"):
                    geo_keys.append(geo["key"].split(":")[1])
            case.stateFips = sorted(set(geo_keys))
            documents_read += len(documents._texts)
            documents_failed += len(documents.failed)
            for url, exc in documents.failed.items():
                for doc in case.documents:
                    if exc.status in (404, 410) and (doc.url or "").split("#")[0] == url:
                        doc.availability = "unavailable"
                        doc.accessNote = (f"The Court's docket gives this address, which answered {exc.status} (not found) "
                                          f"when checked on {ctx.now[:10]}. The Court may have moved the file.")
            built = case.model_dump(mode="json")
            if previous and previous.get("contentHash") == built["contentHash"]:
                built["firstObservedAt"] = previous["firstObservedAt"]
            # Without text because its document could not be retrieved in this run (reported below), not because the
            # docket lost it: that alone does not hold the docket.
            metric = _docket_size_unread_qp if qp_error and not qp_text else _docket_size
            obj = keep_previous_if_regressed(ctx, rel_path, built, metric, case_id)
            for url, exc in documents.failed.items():
                qp_outcome = None
                if qp_error and url == qp_error.url:
                    qp_outcome = ("the Questions Presented text read from the same address on an earlier run is kept" if qp_text
                                  else "no Questions Presented text is published until it can be read")
                ctx.flag("document_unavailable", case_id, _unavailable_detail(
                    exc, held=obj is not built, first=not previous, qp=qp_outcome, kept=cited[url, "kept"], dropped=cited[url, "dropped"]))
            if obj is not built:
                # Held for review: the previous record stays published with its own links, as when the fetch fails.
                carried = _carried_case_links(ctx, previous_links, case_id, seed)
                relationships.extend(carried)
                records.append({**obj, "stateFips": sorted(set(_states_of(carried)))})
                continue
            relationships.extend(case_links)
            cited_kept += sum(n for (_url, outcome), n in cited.items() if outcome == "kept")
            cited_dropped += sum(n for (_url, outcome), n in cited.items() if outcome == "dropped")
            if ev_text:
                (evidence_dir / f"{case_id}.txt").write_text(ev_text, encoding="utf-8")
                write_json(evidence_dir / f"{case_id}.json", {"url": ev_url, "document": CaseDocuments.label(default_doc, seed.get("evidenceLabel"))})
        except Exception as exc:  # noqa: BLE001 - keep last verified record, report it
            failures += 1
            log.error("scotus %s failed: %s", docket, exc)
            ctx.flag("fetch_failed", case_id, str(exc)[:300])
            if not previous:
                never_published += 1
                continue
            # The last verified record is kept, so lastCheckedAt stays at the last successful check (shown as stale).
            # Only its case-to-place links that the current seed still lists unchanged keep their last check; links
            # from seeds/relationships.json are left to stage_relationships, which keeps their last check itself.
            carried = _carried_case_links(ctx, previous_links, case_id, seed)
            relationships.extend(carried)
            obj = {**previous, "stateFips": sorted(set(_states_of(carried)))}
        records.append(obj)
    if not records:
        raise RuntimeError("no Supreme Court dockets could be retrieved")
    _same_lower_court(records)
    links_of: Dict[str, List[dict]] = {}
    for link in relationships:
        links_of.setdefault(link["source"]["id"], []).append(link)
    for obj in records:
        # What the case is about, in the words of the Question Presented, of a passage cited from the docket's documents
        # or of the docket. It follows from the record and its published links, so a kept record gets it too.
        obj["about"] = about.of_docket(obj, links_of.get(obj["id"], []))
        write_json(out / "cases" / f"{obj['id']}.json", obj)
        summaries.append({k: obj[k] for k in obj if k not in (
            "events", "documents", "questionsPresented", "relatedDockets", "linkedNote", "sameLowerCourt", "contentHash",
            "parties", "selection")})
    summaries.sort(key=lambda s: (s.get("sourceLastActivity") or "", s["id"]), reverse=True)
    write_json(out / "index.json", {"cases": summaries})
    write_json(ctx.staging / "courts.json", {"courts": [Court(
        id="scotus", name="Supreme Court of the United States", courtType="federal_supreme", jurisdiction="Federal",
        website="https://www.supremecourt.gov/").model_dump(mode="json")]})
    write_json(ctx.scratch / "rel_cases.json", relationships)
    notes = []
    if failures:
        kept = failures - never_published
        outcome = ("last verified copies kept" if not never_published
                   else "none had been published before, so none is listed" if not kept
                   else f"last verified copies of {kept} kept; {never_published} never published before, so not listed")
        notes.append(f"{failures} of {len(seeds)} dockets could not be refreshed; {outcome}")
    if dead_links:
        notes.append(f"{dead_links} opinion or order link(s) given on the Court's dockets answered not found when checked; they are "
                     "published as unavailable, with the date of the check, and the case pages show their addresses as text, not as links")
    if documents_failed:
        notes.append(f"{documents_failed} cited document(s) could not be retrieved or read"
                     + (f"; {cited_kept} link(s) or tag(s) that cite them keep their last check" if cited_kept else "")
                     + (f"; {cited_dropped} link(s) or tag(s) that cite them are not published" if cited_dropped else ""))
    detail = "; ".join(notes) or None
    ctx.ok(scotus.SOURCE_ID, recordCount=len(summaries), statusDetail=detail)
    if failures == len(seeds):
        ctx.fail(scotus.SOURCE_ID, "failed", detail or "all dockets failed")
    elif documents_failed and not documents_read:
        # Not one cited document could be read (for example pdftotext is missing): no passage was checked in this run.
        ctx.fail(scotus.SOURCE_ID, "failed", detail)
    ctx.published_dirs.append("litigation")
    ctx.published_files.append("courts.json")


# --- stage: legislation (California) --------------------------------------------

#: Largest share of the published bills that may leave the set in one run. A larger drop looks more like a
#: truncated or broken export than like amended subject lines, so the previous set is kept for a maintainer to check.
MAX_SHARE_LEAVING = 0.1


def stage_california(ctx: Context, year: int = 2025) -> None:
    fetcher = ctx.fetcher_factory(timeout=180, min_interval=0.02)
    archive = ca_leginfo.CaliforniaArchive(fetcher, year, cache=ctx.cache / "ca" / str(year))
    bills = archive.table("BILL_TBL.dat")
    versions = archive.table("BILL_VERSION_TBL.dat")
    history = archive.table("BILL_HISTORY_TBL.dat")
    selected = ca_leginfo.select_bills(bills, versions)
    if not selected:
        raise RuntimeError("selection rule matched no bills; refusing to publish an empty legislation set")
    history_by_bill: Dict[str, list] = {}
    for row in history:
        history_by_bill.setdefault(row[0], []).append(row)
    out = ctx.staging / "legislation"
    summaries: List[dict] = []
    failures = text_failures = held = 0
    for bill_id in sorted(selected):
        entry = selected[bill_id]
        try:
            # The id names the bill's file: a row whose parts do not have the expected shape is never written.
            instrument_id = ca_leginfo.instrument_id(entry["bill"])
        except ca_leginfo.BillIdError as exc:
            failures += 1
            log.error("california: %s", exc)
            ctx.flag("bill_failed", f"BILL_TBL row {bill_id!r:.80}", str(exc)[:300])
            continue
        rel_path = f"legislation/bills/{instrument_id}.json"
        previous = read_json(ctx.public / rel_path)
        try:
            instrument, texts = ca_leginfo.build_instrument(
                archive, entry, history_by_bill.get(bill_id, []), checked_at=ctx.now,
                first_observed=(previous or {}).get("firstObservedAt"))
            instrument.issueTags = classify.classify([
                ("official subject line", instrument.subject or ""), ("official title", instrument.title or ""),
                ("Legislative Counsel's digest", classify.without_mandate_text(instrument.digest or ""), classify.DIGEST),
            ])
            built = instrument.model_dump(mode="json")
            built["selection"] = {"ruleId": ca_leginfo.SELECTION_RULE_ID, "matchedText": entry["matched"], "matchedField": "official subject line (latest version)"}
            # The Legislature reissues a corrected file under the same version id only rarely: a maintainer should see it.
            earlier_versions = {v["id"]: v for v in (previous or {}).get("versions", [])}
            for version in built["versions"]:
                before = earlier_versions.get(version["id"]) or {}
                if before.get("sourceHash") and version.get("sourceHash") and before["sourceHash"] != version["sourceHash"]:
                    ctx.flag("version_source_changed", instrument_id,
                             f"the official XML of version {version['id']} changed although its version id did not "
                             f"(SHA-256 {before['sourceHash'][:12]} became {version['sourceHash'][:12]}); the extracted text "
                             + ("is unchanged" if before.get("textHash") == version.get("textHash") else "changed too"))
            obj = keep_previous_if_regressed(ctx, rel_path, built, _bill_size, instrument_id)
            if obj is not built:
                held += 1
                texts = {}  # the kept record points at its own, already published texts; the rejected build's are not written
        except Exception as exc:  # noqa: BLE001 - one unreadable bill must not take the others down
            failures += 1
            text_failures += isinstance(exc, ca_leginfo.VersionTextError)
            log.error("california %s failed: %s", instrument_id, exc)
            ctx.flag("bill_failed", instrument_id, str(exc)[:300])
            if not previous:
                continue  # never published before: left out rather than published half-built
            obj, texts = previous, {}  # keep the last verified record; its check time is not advanced
        # What the bill would do, in the words of its digest. It follows from the record alone, so a record kept
        # from an earlier run gets it too.
        obj = {**obj, "about": about.of_bill(obj)}
        # The id and the version ids name files: each write must stay inside its folder (util.safe_path).
        write_json(out / "bills" / f"{instrument_id}.json", obj, root=out / "bills")
        for version_id, text in texts.items():
            write_json(out / "text" / f"{version_id}.json", text, root=out / "text")
        summaries.append(bill_summary(obj))
    earlier_ids = {b["id"] for b in (read_json(ctx.public / "legislation/index.json") or {}).get("bills", [])}
    left = sorted(earlier_ids - {s["id"] for s in summaries})
    refused = len(left) > MAX_SHARE_LEAVING * len(earlier_ids)
    in_table = {f"ca-{b[1]}-{b[3]}{b[4]}".lower() for b in bills}  # compared with published ids only, never used as a path
    for instrument_id in left:
        why = (f"this export no longer selects it under rule {ca_leginfo.SELECTION_RULE_ID}" if instrument_id in in_table
               else "this export's bill table does not list it")
        ctx.flag("bill_left_selection", instrument_id, f"published before, but {why}; " + (
            "it stays published because too many bills would leave at once" if refused else "its record and texts are no longer published"))
    if refused:
        raise RuntimeError(f"{len(left)} of the {len(earlier_ids)} published bills would leave the published set at once, more than "
                           f"{MAX_SHARE_LEAVING:.0%}; the previous set is kept until a maintainer has checked the export")
    summaries.sort(key=lambda s: (s.get("lastActionDate") or "", s["id"]), reverse=True)
    write_json(out / "index.json", {
        "bills": summaries,
        "selection": {"ruleId": ca_leginfo.SELECTION_RULE_ID, "pattern": ca_leginfo.SELECTION_PATTERN.pattern,
                      "exclusionPattern": ca_leginfo.EXCLUSION_PATTERN.pattern,
                      "appliedTo": "official subject line of each bill's latest version",
                      # Regular-session measures only: the rule leaves out the extraordinary sessions that share the table.
                      "totalBillsInSession": ca_leginfo.regular_session_count(bills)},
    })
    if not summaries:
        raise RuntimeError("no selected bill could be built; refusing to publish an empty legislation set")
    notes = []
    if failures:
        why = f" ({text_failures} because a version's text could not be read, parsed or matched to its version)" if text_failures else ""
        notes.append(f"{failures} of {len(selected)} bills could not be rebuilt{why}; last verified copies kept where they exist")
    if held:
        notes.append(f"{held} rebuilt bill(s) were smaller than the published record and are held for review")
    detail = "; ".join(notes) or None
    ctx.ok("ca-leginfo-bulk", sourcePublishedAt=archive.archive_modified, recordCount=len(summaries), statusDetail=detail)
    if failures + held == len(selected):
        # Not one bill was refreshed: the published set is entirely last week's, whatever the cause.
        ctx.fail("ca-leginfo-bulk", "failed", detail)
    ctx.published_dirs.append("legislation")


# --- stage: legislation (U.S. Congress) -----------------------------------------

#: The fields of a measure that its entry in an index carries.
BILL_SUMMARY_FIELDS = (
    "id", "state", "stateAbbr", "session", "identifier", "measureType", "title", "subject", "leadAuthors",
    "legislativeStatus", "chapter", "introducedDate", "lastActionDate", "lastActionText", "versionCount",
    "issueTags", "about", "officialUrl", "sourceId", "firstObservedAt", "lastCheckedAt", "verification")


def bill_summary(record: dict) -> dict:
    """A measure's entry in an index: the fields a list shows, with the words the selection rule matched."""
    summary = {field: record.get(field) for field in BILL_SUMMARY_FIELDS}
    if record.get("selection"):
        summary["selection"] = record["selection"]
    return summary
#: The fields the issue rules read for a measure of Congress.
CRS_SUMMARY_FIELD = "Congressional Research Service summary"


def congress_selection_document(total: int, by_test: Dict[str, int]) -> dict:
    """Rule ``us-select-1`` as published with the data: its tests, patterns and policy areas, and what it was applied to."""
    return {
        "ruleId": congress.SELECTION_RULE_ID, "congress": congress.CONGRESS, "tests": congress.SELECTION_TESTS,
        "pattern": congress.SELECTION_PATTERN.pattern,
        "generalPattern": congress.GENERAL_PATTERN.pattern, "generalAreas": [area for area in congress.GENERAL_AREAS if area],
        "otherPattern": congress.OTHER_PATTERN.pattern, "otherAreas": list(congress.OTHER_AREAS),
        "excludedAreas": list(congress.EXCLUDED_AREAS), "exclusionPattern": congress.EXCLUSION_PATTERN.pattern,
        "appliedTo": "every title the official record gives a measure (display, official and short titles), together with the "
                     "policy area the Congressional Research Service assigned to it",
        "totalMeasuresRead": total, "selectedByTest": {test: by_test.get(test, 0) for test in congress.SELECTION_TESTS},
    }


def stage_congress(ctx: Context) -> None:
    fetcher = ctx.fetcher_factory(timeout=180, min_interval=0.05)
    archives = congress.StatusArchives(fetcher, ctx.cache / "congress" / "status")
    texts = congress.TextStore(fetcher, ctx.cache / "congress" / "text")
    selected, total, problems = congress.select_measures(archives)
    for problem in problems:
        name, _sep, detail = problem.partition(": ")
        ctx.flag("status_record_unreadable", name, f"not read by the selection rule: {detail}"[:300])
    if not selected:
        raise RuntimeError("selection rule matched no measures of Congress; refusing to publish an empty set")
    out = ctx.staging / "congress"
    earlier_ids = {b["id"] for b in (read_json(ctx.public / "congress/index.json") or {}).get("bills", [])}
    in_dataset = set(selected)
    # Every text version is checked before the first measure is built, so that a server that fails some requests
    # is waited for once and not once for each file. A version that could not be had fails its measure below.
    texts.check(congress.text_packages(selected))
    summaries: List[dict] = []
    failures = text_failures = held = link_only = mirrored = 0
    for bill_id in sorted(selected):
        entry = selected[bill_id]
        rel_path = f"congress/bills/{bill_id}.json"
        previous = read_json(ctx.public / rel_path)
        try:
            instrument, text_records, notes = congress.build_instrument(
                entry, texts, checked_at=ctx.now, first_observed=(previous or {}).get("firstObservedAt"), in_dataset=in_dataset)
            instrument.issueTags = classify.classify([
                ("display title", instrument.subject or ""), ("official title", instrument.title or ""),
                ("short title", " ; ".join(instrument.shortTitles)), (CRS_SUMMARY_FIELD, instrument.digest or ""),
            ])
            built = instrument.model_dump(mode="json")
            built["selection"] = {"ruleId": congress.SELECTION_RULE_ID, **entry["matched"]}
            for note in notes:
                ctx.flag("text_version_note", bill_id, note[:300])
            earlier_versions = {v["id"]: v for v in (previous or {}).get("versions", [])}
            for version in built["versions"]:
                before = earlier_versions.get(version["id"]) or {}
                if before.get("sourceHash") and version.get("sourceHash") and before["sourceHash"] != version["sourceHash"]:
                    ctx.flag("version_source_changed", bill_id,
                             f"the official XML of version {version['id']} changed although its version id did not "
                             f"(SHA-256 {before['sourceHash'][:12]} became {version['sourceHash'][:12]}); the extracted text "
                             + ("is unchanged" if before.get("textHash") == version.get("textHash") else "changed too"))
            obj = keep_previous_if_regressed(ctx, rel_path, built, _bill_size, bill_id)
            if obj is not built:
                held += 1
                text_records = {}  # the kept record points at its own, already published texts
        except Exception as exc:  # noqa: BLE001 - one unreadable measure must not take the others down
            failures += 1
            text_failures += isinstance(exc, congress.BillTextUnavailable)
            log.error("congress %s failed: %s", bill_id, exc)
            ctx.flag("bill_failed", bill_id, str(exc)[:300])
            if not previous:
                continue  # never published before: left out rather than published half-built
            obj, text_records = previous, {}  # keep the last verified record; its check time is not advanced
        if earlier_ids and bill_id not in earlier_ids and obj.get("lastCheckedAt") == ctx.now:
            matched = obj["selection"]
            ctx.flag("new_selection", bill_id, f"newly selected by rule {congress.SELECTION_RULE_ID} (test \"{matched['test']}\": "
                                               f"{matched['matchedText']!r} in the {matched['matchedField']}); a maintainer should look at it once")
        # What the measure would do, in the words of its official summary or title. It follows from the record alone,
        # so a record kept from an earlier run gets it too.
        obj = {**obj, "about": about.of_bill(obj)}
        write_json(out / "bills" / f"{bill_id}.json", obj, root=out / "bills")
        for version_id, text in text_records.items():
            write_json(out / "text" / f"{version_id}.json", text, root=out / "text")
        mirrored += sum(v.get("textAvailability") == "mirrored" for v in obj.get("versions", []))
        link_only += sum(v.get("textAvailability") == "link_only" for v in obj.get("versions", []))
        summaries.append(bill_summary(obj))
    left = sorted(earlier_ids - {summary["id"] for summary in summaries})
    refused = len(left) > MAX_SHARE_LEAVING * len(earlier_ids)
    for bill_id in left:
        ctx.flag("bill_left_selection", bill_id, f"published before, but the records no longer select it under rule {congress.SELECTION_RULE_ID} "
                 "(or no longer list it); " + ("it stays published because too many measures would leave at once" if refused
                                              else "its record and texts are no longer published"))
    if refused:
        raise RuntimeError(f"{len(left)} of the {len(earlier_ids)} published measures of Congress would leave the published set at once, "
                           f"more than {MAX_SHARE_LEAVING:.0%}; the previous set is kept until a maintainer has checked the records")
    if not summaries:
        raise RuntimeError("no selected measure of Congress could be built; refusing to publish an empty set")
    summaries.sort(key=lambda summary: (summary.get("lastActionDate") or "", summary["id"]), reverse=True)
    by_test = Counter(entry["matched"]["test"] for entry in selected.values())
    write_json(out / "index.json", {"bills": summaries, "selection": congress_selection_document(total, by_test)})
    notes = []
    if failures:
        why = f" ({text_failures} because a text version could not be retrieved)" if text_failures else ""
        notes.append(f"{failures} of {len(selected)} measures could not be rebuilt{why}; last verified copies kept where they exist")
    if held:
        notes.append(f"{held} rebuilt measure(s) were smaller than the published record and are held for review")
    if problems:
        notes.append(f"{len(problems)} of {total} status records could not be read by the selection rule")
    detail = "; ".join(notes) or None
    ctx.ok(congress.SOURCE_ID, sourcePublishedAt=archives.latest_modified, recordCount=len(summaries), statusDetail=detail)
    ctx.ok(congress.TEXT_SOURCE_ID, recordCount=mirrored,
           statusDetail=(f"{link_only} text version(s) are listed with a link only, because their text did not pass the reader's check"
                         if link_only else None))
    if failures + held == len(selected):
        # Not one measure was refreshed: the published set is entirely an earlier run's, whatever the cause.
        ctx.fail(congress.SOURCE_ID, "failed", detail)
        ctx.fail(congress.TEXT_SOURCE_ID, "failed", detail)
    elif text_failures:
        ctx.fail(congress.TEXT_SOURCE_ID, "failed", f"{text_failures} measure(s) were not rebuilt because a text version could not be "
                                                    "retrieved; their last verified copies are kept")
    ctx.published_dirs.append("congress")


# --- stage: litigation (courts of appeals) --------------------------------------

EXCLUSION_RULE_ID = "circuit-exclusion-1"
#: The fields of a court of appeals case that only its own file carries.
CIRCUIT_DETAIL_FIELDS = ("events", "documents", "questionsPresented", "relatedDockets", "linkedNote", "sameLowerCourt", "contentHash",
                         "parties", "selection", "removedTags")
TAG_REMOVAL_RULE_ID = "tag-removal-1"


def _exclusion_seeds(ctx: Context) -> Dict[str, dict]:
    """The published list of exclusions by package. An entry that is not usable is reported and has no effect."""
    seeds: Dict[str, dict] = {}
    for entry in (read_json(SEEDS_DIR / "circuit_exclusions.json") or {}).get("exclusions", []):
        package = str(entry.get("package") or "")
        problem = None
        try:
            uscourts.court_of(package)
        except Exception:  # noqa: BLE001
            problem = "it does not name a package of a court of appeals"
        if not problem and package in seeds:
            problem = "the package is listed more than once; the later entry was ignored"
        if not problem and not (isinstance(entry.get("reason"), str) and entry["reason"].strip()):
            problem = "it gives no reason"
        if not problem and not (isinstance(entry.get("quote"), str) and entry["quote"].strip()):
            problem = "it quotes no passage"
        if problem:
            ctx.flag("exclusion_unusable", package[:80] or "(no package)", f"entry of seeds/circuit_exclusions.json ignored: {problem}")
            continue
        seeds[package] = entry
    return seeds


def _tag_removal_seeds(ctx: Context) -> Dict[str, List[dict]]:
    """The published list of tags a maintainer removed, by case. An entry that is not usable is reported and has no effect."""
    seeds: Dict[str, List[dict]] = {}
    for entry in (read_json(SEEDS_DIR / "tag_removals.json") or {}).get("removals", []):
        entity, tag = str(entry.get("entity") or ""), str(entry.get("tag") or "")
        problem = None
        if not re.fullmatch(CIRCUIT_CASE_ID_PATTERN, entity):
            problem = "it does not name a case of a court of appeals"
        elif tag not in classify.TAG_LABELS:
            problem = f"it names a tag that no rule assigns ({tag[:40]!r})"
        elif any(other["tag"] == tag for other in seeds.get(entity, [])):
            problem = "the tag is listed more than once for the case; the later entry was ignored"
        elif not (isinstance(entry.get("reason"), str) and entry["reason"].strip()):
            problem = "it gives no reason"
        elif not (isinstance(entry.get("quote"), str) and entry["quote"].strip()):
            problem = "it quotes no passage"
        if problem:
            ctx.flag("tag_removal_unusable", entity[:80] or "(no case)", f"entry of seeds/tag_removals.json ignored: {problem}")
            continue
        seeds.setdefault(entity, []).append(entry)
    return seeds


def remove_seeded_tags(case: dict, entries: List[dict], quoted_in: Callable[[str], Optional[str]]) -> List[str]:
    """Take the tags a maintainer listed off a case and record each removal on it (rule ``tag-removal-1``).

    ``quoted_in`` gives the address of the case's document in which a passage is found. A tag is removed only when the
    passage quoted for it is found there; otherwise the tag stays. Returns what could not be applied, for the review queue.
    """
    problems: List[str] = []
    for entry in entries:
        tag = next((t for t in case["issueTags"] if t["tag"] == entry["tag"]), None)
        if tag is None:
            problems.append(f"the rules do not assign the tag {entry['tag']!r} to this case (any more); the entry of seeds/tag_removals.json has no effect")
            continue
        url = quoted_in(entry["quote"])
        if not url:
            problems.append(f"the tag {entry['tag']!r} stays: the passage quoted for its removal was not found in the documents of the case")
            continue
        case["issueTags"] = [t for t in case["issueTags"] if t is not tag]
        case.setdefault("removedTags", []).append(RemovedTag(
            tag=tag["tag"], ruleId=tag["ruleId"], matchedField=tag["matchedField"], matchedText=tag["matchedText"], matchCount=tag.get("matchCount"),
            removalRuleId=TAG_REMOVAL_RULE_ID, reason=entry["reason"].strip(), quote=entry["quote"].strip(), quoteUrl=url).model_dump(mode="json"))
    if case.get("removedTags") and "contentHash" in case:
        # The hash covers the record as published, so it is made again once the tags are changed (same basis as build_case).
        case["contentHash"] = content_hash({k: v for k, v in case.items() if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash"}})
    return problems


def _quoted_in(result: uscourts.PackageResult, quote: str) -> Optional[str]:
    """The address of the first document of a case in which a quoted passage is found."""
    for doc in result.record["documents"]:
        text = result.texts.get(doc["granule"])
        if text and doc["url"] and evidence.find_passage(quote, text) is None:
            return doc["url"]
    return None


def stage_circuits(ctx: Context) -> None:
    seeds = _exclusion_seeds(ctx)
    tag_removals = _tag_removal_seeds(ctx)
    fetcher = ctx.fetcher_factory(timeout=120, min_interval=0.03)
    previous_state = read_json(ctx.public / "circuits/scan.json")
    previous_index = read_json(ctx.public / "circuits/index.json") or {}
    earlier_ids = {case["id"] for case in previous_index.get("cases", [])}
    result = uscourts.scan(fetcher, ctx.cache / "uscourts", previous_state, seeds, now=ctx.now,
                           progress=lambda done, of: log.info("courts of appeals: read %d of %d packages", done, of))
    out = ctx.staging / "circuits"
    reader = uscourts.Reader(fetcher, ctx.cache / "uscourts")

    for package, error in sorted(result.failed.items()):
        ctx.flag("fetch_failed", uscourts.case_id(package), f"the case could not be read from GovInfo: {error}"[:300])
    for entry in result.unrecognised[:20]:
        ctx.flag("listing_entry_unrecognised", entry[:80], "GovInfo lists this entry for a court of appeals, but it does not have the form of a case package; it was not read")

    records: List[dict] = []
    opinion_keys: Dict[str, List[tuple[str, str]]] = {}
    carried: List[dict] = []  # published records kept as they are: not read in this run, or held for review
    held = 0
    for package in sorted(result.selected):
        read = result.selected[package]
        case_id = uscourts.case_id(package)
        rel_path = f"circuits/cases/{case_id}.json"
        previous = read_json(ctx.public / rel_path)
        if read.evaluation["exclusionProblem"]:
            ctx.flag("exclusion_check_failed", case_id, "the case stays in the dataset: the passage quoted for its exclusion was not found in "
                                                        f"its documents ({read.evaluation['exclusionProblem']})"[:300])
        opening_passage, problem = uscourts.opinion_about(reader, read, (previous or {}).get("about"))
        if problem:
            ctx.flag("opening_unavailable", case_id, problem)
        case = uscourts.build_case(read.record, read.texts, read.evaluation, checked_at=ctx.now, changed_at=read.changed_at,
                                   first_observed=(previous or {}).get("firstObservedAt"), about=opening_passage)
        built = case.model_dump(mode="json")
        for problem in remove_seeded_tags(built, tag_removals.pop(case_id, []), lambda quote, read=read: _quoted_in(read, quote)):
            ctx.flag("tag_removal_not_applied", case_id, problem[:300])
        obj = keep_previous_if_regressed(ctx, rel_path, built, _docket_size, case_id)
        if obj is not built:
            held += 1
            carried.append(obj)
            fresh = {t["tag"] for t in built.get("removedTags", [])} - {t["tag"] for t in obj.get("removedTags", [])}
            if fresh:
                ctx.flag("tag_removal_held", case_id, f"the removal of {', '.join(sorted(fresh))} takes effect once the record is no longer held "
                                                      "for review; the published record still shows the tag")
            continue
        records.append(built)
        opinion_keys[case_id] = [(f"{case_id}-d{doc['sequence']}", doc["date"], key) for doc in read.record["documents"]
                                 if (key := uscourts.same_opinion_key(read.texts.get(doc["granule"])))]
    # What is left names a case that was not built in this run. One that could not be read keeps its published record.
    not_read = {uscourts.case_id(package) for package in result.kept}
    for case_id in sorted(set(tag_removals) - not_read):
        ctx.flag("tag_removal_unused", case_id, "entry of seeds/tag_removals.json has no effect: GovInfo does not list the case, rule "
                                                f"{uscourts.SELECTION_RULE_ID} does not select it, or it is on the list of exclusions")
    state_packages = uscourts.packages_of(result.state)
    never_published = 0
    for package in result.kept:
        previous = read_json(ctx.public / f"circuits/cases/{uscourts.case_id(package)}.json")
        if previous:
            carried.append(previous)  # the last verified record; its check time is not advanced
        elif state_packages.get(package, [None] * 5)[4] == uscourts.SELECTED:
            never_published += 1
    uscourts.decided_together(records, opinion_keys)
    # A record that was not rebuilt keeps the pairings it was published with, as far as the other case and its
    # document are still published, and the other side then lists it too.
    by_id = {record["id"]: record for record in records + carried}
    documents = {doc["id"]: doc for record in by_id.values() for doc in record["documents"]}
    for kept in carried:
        for doc in kept["documents"]:
            doc["sameTextAs"] = [other for other in doc.get("sameTextAs", []) if other in documents]
            for other in doc["sameTextAs"]:
                if doc["id"] not in documents[other].setdefault("sameTextAs", []):
                    documents[other]["sameTextAs"] = sorted([*documents[other]["sameTextAs"], doc["id"]])
        kept["decidedWith"] = [entry for entry in kept.get("decidedWith", []) if entry["caseId"] in by_id]
        for entry in kept["decidedWith"]:
            other = by_id[entry["caseId"]]
            if not any(item["caseId"] == kept["id"] for item in other.get("decidedWith", [])):
                other["decidedWith"] = sorted([*other.get("decidedWith", []), {"caseId": kept["id"], "docket": kept["docketNumber"],
                                                                               "caseName": kept["caseName"]}], key=lambda item: item["caseId"])
    records = sorted(by_id.values(), key=lambda record: record["id"])
    if not records:
        raise RuntimeError("the selection rule selected no court of appeals case; refusing to publish an empty set")

    left = sorted(earlier_ids - set(by_id))
    refused = len(left) > MAX_SHARE_LEAVING * len(earlier_ids)
    unlisted = {uscourts.case_id(package) for package in result.unlisted}
    excluded_now = {uscourts.case_id(package) for package in result.excluded}
    for case_id in left:
        why = ("GovInfo no longer lists it" if case_id in unlisted
               else "it is now on the published list of exclusions" if case_id in excluded_now
               else f"rule {uscourts.SELECTION_RULE_ID} no longer selects it")
        ctx.flag("case_left_selection", case_id, f"published before, but {why}; " + (
            "it stays published because too many cases would leave at once" if refused else "its record is no longer published"))
    if refused:
        raise RuntimeError(f"{len(left)} of the {len(earlier_ids)} published court of appeals cases would leave the published set at once, "
                           f"more than {MAX_SHARE_LEAVING:.0%}; the previous set is kept until a maintainer has checked the scan")
    if earlier_ids:
        for record in records:
            if record["id"] not in earlier_ids:
                ctx.flag("new_selection", record["id"], f"newly selected by rule {uscourts.SELECTION_RULE_ID} (tests met: "
                                                        f"{', '.join(record['selection']['tests'])}); a maintainer should read the opinion once")

    # The published list of exclusions: each entry whose passage was found in the case's documents in this run, and
    # each one published before whose case could not be read in this run and whose entry has not changed.
    exclusions: List[dict] = []
    earlier_exclusions = {entry["package"]: entry for entry in previous_index.get("exclusions", [])}
    for package in sorted(seeds):
        seed = seeds[package]
        read = result.excluded.get(package)
        if read is not None:
            exclusions.append({
                "package": package, "caseId": uscourts.case_id(package), "courtId": read.record["court"],
                "docketNumber": read.record["docket"], "caseName": read.record["title"], "reason": seed["reason"],
                "quote": seed["quote"], "documentUrl": _quoted_in(read, seed["quote"]),
                "sourceUrl": uscourts.DETAILS_URL.format(package=package), "tests": read.evaluation["tests"],
                "ruleId": EXCLUSION_RULE_ID, "checkedAt": ctx.now,
            })
            continue
        earlier = earlier_exclusions.get(package)
        if package in result.kept and earlier and (earlier.get("reason"), earlier.get("quote")) == (seed["reason"], seed["quote"]):
            exclusions.append(earlier)  # with the date of its own check
        elif package not in result.selected and package not in result.kept:
            ctx.flag("exclusion_unused", uscourts.case_id(package), "entry of seeds/circuit_exclusions.json has no effect: GovInfo does not list "
                                                                    f"the case, or rule {uscourts.SELECTION_RULE_ID} does not select it")

    for record in records:
        write_json(out / "cases" / f"{record['id']}.json", record, root=out / "cases")
    summaries = [{k: v for k, v in record.items() if k not in CIRCUIT_DETAIL_FIELDS} for record in records]
    summaries.sort(key=lambda summary: (summary.get("sourceLastActivity") or "", summary["id"]), reverse=True)
    coverage = uscourts.coverage(result.state)
    write_json(out / "index.json", {
        "cases": summaries,
        "selection": {**uscourts.selection_document(), "exclusionRuleId": EXCLUSION_RULE_ID,
                      "appliedTo": "every case of the thirteen courts of appeals that GovInfo lists with a document issued since "
                                   f"{uscourts.SINCE}: the nature of suit in the court's record, and the text of each such document",
                      "totalCasesRead": sum(row["cases"] for row in coverage.values()),
                      "totalDocumentsRead": sum(row["documents"] for row in coverage.values())},
        "coverage": coverage,
        "exclusions": exclusions,
        "scannedAt": ctx.now,
    })
    write_json(out / "scan.json", result.state)

    notes = []
    if result.failed:
        outcome = f"; the published records of {len(carried) - held} of them are kept" if len(carried) > held else ""
        notes.append(f"{len(result.failed)} of {result.read} cases read in this run could not be retrieved or parsed{outcome}")
    if never_published:
        notes.append(f"{never_published} selected case(s) could not be read and had not been published before, so they are not listed")
    if held:
        notes.append(f"{held} rebuilt case(s) were smaller than the published record and are held for review")
    if result.unrecognised:
        notes.append(f"{len(result.unrecognised)} entr{'y' if len(result.unrecognised) == 1 else 'ies'} of GovInfo's lists did not have the form of a case package")
    detail = "; ".join(notes) or None
    changed = max((entry[0] for entry in state_packages.values()), default=None)
    ctx.ok(uscourts.SOURCE_ID, sourcePublishedAt=uscourts.whole_seconds(changed), recordCount=len(summaries), statusDetail=detail)
    if len(carried) == len(records):
        # Not one case was refreshed: the published set is entirely an earlier run's.
        ctx.fail(uscourts.SOURCE_ID, "failed", detail or "no case could be refreshed")
    ctx.published_dirs.append("circuits")


# --- stage: optional secondary sources -------------------------------------------

def stage_courtlistener(ctx: Context) -> None:
    try:
        queries = read_json(SEEDS_DIR / "courtlistener_queries.json")["queries"]
        cases = courtlistener.run(ctx.fetcher_factory(timeout=60, min_interval=1.0), queries, checked_at=ctx.now)
    except CredentialMissing as exc:
        ctx.fail("courtlistener-api", "credential_missing", f"{exc}. Add the token as a repository secret to activate this source.")
        return
    write_json(ctx.staging / "litigation_secondary.json", {"cases": [c.model_dump(mode="json") for c in cases]})
    for case in cases:
        ctx.flag("secondary_import", case.id, "imported from CourtListener; geographic scope and issue tags need maintainer review")
    ctx.ok("courtlistener-api", recordCount=len(cases))
    ctx.published_files.append("litigation_secondary.json")


#: Open States jurisdictions queried when OPENSTATES_JURISDICTIONS is not set.
DEFAULT_OPENSTATES_JURISDICTIONS = ("tx", "fl", "nc", "oh")


def openstates_jurisdictions() -> List[str]:
    """The comma-separated OPENSTATES_JURISDICTIONS, or the default list when it is unset or blank.

    The scheduled workflow passes the repository variable of that name, which is an empty string when the variable
    does not exist, so blank must mean "not set" and never "query an empty jurisdiction"."""
    names = [name.strip() for name in os.environ.get("OPENSTATES_JURISDICTIONS", "").split(",")]
    return [name for name in names if name] or list(DEFAULT_OPENSTATES_JURISDICTIONS)


def stage_openstates(ctx: Context) -> None:
    try:
        openstates.api_key()
    except CredentialMissing as exc:
        ctx.fail("openstates-api", "credential_missing", f"{exc}. Add the key as a repository secret to activate this source.")
        return
    fetcher = ctx.fetcher_factory(timeout=60, min_interval=1.5)
    bills = []
    for jurisdiction in openstates_jurisdictions():
        bills.extend(openstates.search_bills(fetcher, jurisdiction, "elections", checked_at=ctx.now))
    write_json(ctx.staging / "legislation_secondary.json", {"bills": [b.model_dump(mode="json") for b in bills]})
    ctx.ok("openstates-api", recordCount=len(bills))
    ctx.published_files.append("legislation_secondary.json")


# --- stage: who holds office ------------------------------------------------------

GOVERNMENT_FILE = "government.json"
FIFTY_STATES = tuple(fips for fips, (abbr, _) in STATES.items() if abbr not in ("DC", "PR", "AS", "GU", "MP", "VI"))


def _previous_governments(ctx: Context) -> Dict[str, dict]:
    return {record["id"]: record for record in (read_json(ctx.public / GOVERNMENT_FILE) or {}).get("governments", [])}


def _kept_chambers(previous: Optional[dict], keys: tuple[str, ...]) -> List[dict]:
    """The chambers published before, with the day they were read, for a source that could not be read in this run."""
    return [chamber for chamber in (previous or {}).get("chambers", []) if chamber["chamber"] in keys]


def stage_government(ctx: Context) -> None:
    """``government.json``: the President (once a source is read for the office), the Senate and the House; for each of
    the fifty states the governor and the chambers of the legislature (rules ``party-*``).

    Each of the four sources stands on its own. One that cannot be read, or that no longer has the form its reader
    knows, is reported as failed, and what was published from it before stays, with the day it was read.
    """
    previous = _previous_governments(ctx)
    table = read_json(SEEDS_DIR / "chambers.json")["states"]
    if sorted(entry["fips"] for entry in table.values()) != sorted(FIFTY_STATES):
        raise SeedError("seeds/chambers.json does not list exactly the fifty states")
    official = ctx.fetcher_factory(timeout=60, min_interval=1.0)
    bulk = ctx.fetcher_factory(timeout=60, min_interval=0.3)

    # The United States.
    nation = previous.get(government.NATION_ID)
    federal: List[dict] = []
    try:
        listed = officials.senate(official)
        federal.append(government.senate_chamber(listed, officials.SENATE_SEATS, source_id=officials.SENATE_SOURCE_ID,
                                                 source_url=officials.SENATE_URL, checked_at=ctx.now))
        ctx.ok(officials.SENATE_SOURCE_ID, sourcePublishedAt=listed["asOf"], recordCount=len(listed["labels"]))
    except (FetchError, officials.SourceFormatError) as exc:
        log.error("senate: %s", exc)
        federal.extend(_kept_chambers(nation, ("upper",)))
        ctx.fail(officials.SENATE_SOURCE_ID, "failed", f"{exc}; the figures published before are kept")
    try:
        listed = officials.house(official)
        made = government.house_chamber(listed, source_id=officials.HOUSE_SOURCE_ID, source_url=officials.HOUSE_URL, checked_at=ctx.now)
        counted = government.majority(made["parties"], made["seats"])
        if made["leadBasis"] == "stated" and counted and counted != made["lead"]:
            ctx.flag("stated_majority_differs", government.NATION_ID,
                     f"the Clerk states the majority {made['lead']}, the members listed give {counted} more than half of the seats")
        federal.append(made)
        ctx.ok(officials.HOUSE_SOURCE_ID, sourcePublishedAt=listed["asOf"], recordCount=len(listed["labels"]))
    except (FetchError, officials.SourceFormatError) as exc:
        log.error("house: %s", exc)
        federal.extend(_kept_chambers(nation, ("lower",)))
        ctx.fail(officials.HOUSE_SOURCE_ID, "failed", f"{exc}; the figures published before are kept")
    federal.sort(key=lambda made: government.CHAMBER_ORDER.index(made["chamber"]))
    records = [government.government(unit_id=government.NATION_ID, name="United States", holder=None, chambers=federal,
                                     executive_note=government.NO_PRESIDENT_NOTE, expected_chambers=("upper", "lower"))]

    # The governors.
    governors: Dict[str, dict] = {}
    try:
        for entry in officials.governors(official):
            fips = STATE_BY_NAME.get(entry["state"].lower())
            if fips in FIFTY_STATES:
                governors[fips] = government.executive(office="Governor", name=entry["name"], party=entry["party"],
                                                       term_started=entry["termStarted"], source_id=officials.GOVERNORS_SOURCE_ID,
                                                       source_url=entry["url"], checked_at=ctx.now)
        if len(governors) != len(FIFTY_STATES):
            raise officials.SourceFormatError(f"the governors' association lists a governor for {len(governors)} of the fifty states")
        ctx.ok(officials.GOVERNORS_SOURCE_ID, recordCount=len(governors))
    except (FetchError, officials.SourceFormatError) as exc:
        log.error("governors: %s", exc)
        governors = {fips: previous[f"state:{fips}"]["executive"] for fips in FIFTY_STATES
                     if (previous.get(f"state:{fips}") or {}).get("executive")}
        ctx.fail(officials.GOVERNORS_SOURCE_ID, "failed", f"{exc}; the governors published before are kept")

    # The legislatures.
    failed: List[str] = []
    members = 0
    newest: Optional[str] = None
    for abbr, entry in sorted(table.items()):
        fips, unit_id = entry["fips"], f"state:{entry['fips']}"
        try:
            listed = officials.legislators(bulk, abbr)
            chambers, problems = government.state_chambers(listed["chambers"], entry["chambers"], source_id=officials.LEGISLATORS_SOURCE_ID,
                                                           source_url=listed["url"], as_of=listed["asOf"], checked_at=ctx.now)
            for problem in problems:
                ctx.flag("chamber_size", unit_id, problem)
            members += sum(chamber["members"] for chamber in chambers)
            newest = max(filter(None, [newest, listed["asOf"]]), default=None)
        except (FetchError, officials.SourceFormatError, ValueError) as exc:
            log.error("legislators of %s: %s", abbr, exc)
            failed.append(abbr)
            chambers = _kept_chambers(previous.get(unit_id), government.CHAMBER_ORDER)
        records.append(government.government(
            unit_id=unit_id, name=STATES[fips][1], holder=governors.get(fips), chambers=chambers,
            executive_note=None if fips in governors else "No governor was read for this state.",
            expected_chambers=tuple(entry["chambers"])))
    if failed:
        ctx.fail(officials.LEGISLATORS_SOURCE_ID, "failed",
                 f"the members of {len(failed)} of {len(table)} legislatures could not be read ({', '.join(failed)}); the figures published before are kept for them")
    else:
        ctx.ok(officials.LEGISLATORS_SOURCE_ID, sourcePublishedAt=newest, recordCount=members)

    write_json(ctx.staging / GOVERNMENT_FILE, {
        "generatedAt": ctx.now,
        "governments": [Government(**record).model_dump(mode="json") for record in records],
    })
    ctx.published_files.append(GOVERNMENT_FILE)


# --- stage: relationships and events --------------------------------------------

def _staged_or_public(ctx: Context, rel: str) -> Path:
    staged = ctx.staging / rel
    return staged if staged.exists() else ctx.public / rel


#: The published indexes of the cases and of the measures, each with the key its list has.
CASE_INDEXES = ("litigation/index.json", "circuits/index.json")
BILL_INDEXES = ("legislation/index.json", "congress/index.json")


def case_path(case_id: str) -> str:
    """Where a case's record is published: Supreme Court dockets and court of appeals cases have their own folders."""
    return f"{'litigation' if case_id.startswith('scotus-') else 'circuits'}/cases/{case_id}.json"


def bill_path(bill_id: str) -> str:
    """Where a measure's record is published: California bills and measures of Congress have their own folders."""
    return f"{'congress' if bill_id.startswith('us-') else 'legislation'}/bills/{bill_id}.json"


def _listed(ctx: Context, indexes: tuple[str, ...], key: str) -> List[dict]:
    """The entries of the given indexes as they are about to be published."""
    return [entry for rel in indexes for entry in (read_json(_staged_or_public(ctx, rel)) or {}).get(key, [])]


CASE_BELOW_RULE_ID = "case-below-1"
_APPEAL_NUMBER_RE = re.compile(r"\s*(\d{2})-0*(\d{1,6})\s*")


def appeal_number_key(number: Optional[str]) -> Optional[tuple[str, str]]:
    """A court of appeals case number as its two-digit year and its serial number without leading zeros ("23-03655"
    and "23-3655" are one number), or ``None`` for a number of another form, such as a district court's."""
    match = _APPEAL_NUMBER_RE.fullmatch(number or "")
    return (match.group(1), match.group(2)) if match else None


def cases_below(supreme: List[dict], appeals: List[dict], court_names: Dict[str, str]) -> List[dict]:
    """Pair each Supreme Court docket with the court of appeals case it comes from (rule ``case-below-1``).

    A docket is paired with a case of the dataset only when the Court's docket names that case's court as the lower
    court and one of the lower-court case numbers it gives is the case's docket number, read by
    :func:`appeal_number_key`. ``court_names`` maps the full name of each court of appeals, without letter case, to its
    id. A number that would name two cases of the court is paired with neither. The pairing is derived from the two
    records; neither states it.
    """
    by_number: Dict[tuple[str, tuple[str, str]], List[dict]] = {}
    for case in appeals:
        key = appeal_number_key(case.get("docketNumber"))
        if key:
            by_number.setdefault((case["courtId"], key), []).append(case)
    links: Dict[str, dict] = {}
    for docket in supreme:
        lower = docket.get("lowerCourt") or {}
        court_id = court_names.get((lower.get("name") or "").casefold())
        if not court_id:
            continue
        for number in lower.get("caseNumbers") or []:
            key = appeal_number_key(number)
            found = by_number.get((court_id, key), []) if key else []
            if len(found) != 1:
                continue
            case = found[0]
            link = CaseLink(
                id=f"below-{docket['id']}-{case['id']}", ruleId=CASE_BELOW_RULE_ID,
                review=CaseLinkEnd(caseId=docket["id"], docket=docket["docketNumber"], caseName=docket["caseName"]),
                below=CaseBelowEnd(caseId=case["id"], docket=case["docketNumber"], caseName=case["caseName"], courtId=case["courtId"]),
                court=lower["name"], number=number, sourceUrl=docket["sourceUrl"],
            )
            links[link.id] = link.model_dump(mode="json")
    return [links[link_id] for link_id in sorted(links)]


def stage_relationships(ctx: Context) -> None:
    index = read_json(_staged_or_public(ctx, "geo/index.json"))
    if not index:
        raise RuntimeError("geography index unavailable; cannot validate relationships")
    known_geo = {row[0] for row in index["rows"]}
    state_names = {fips: name for fips, (_abbr, name) in STATES.items()}
    unit_names = {row[0]: row[1] for row in index["rows"]}
    cases = {c["id"] for c in _listed(ctx, CASE_INDEXES, "cases")}
    bills = {b["id"] for b in _listed(ctx, BILL_INDEXES, "bills")}
    previous = {r["id"]: r for r in (read_json(ctx.public / "relationships.json") or {}).get("relationships", [])}
    staged_cases = read_json(ctx.scratch / "rel_cases.json")
    if staged_cases is None:
        # The litigation stage did not run: keep the published case-to-place links that the current seeds still list unchanged.
        staged_cases, seen_dockets = [], set()
        for case_seed in (read_json(SEEDS_DIR / "cases.json") or {}).get("cases", []):
            if case_seed["docket"].upper() not in seen_dockets:
                seen_dockets.add(case_seed["docket"].upper())
                staged_cases.extend(_carried_case_links(ctx, previous, f"scotus-{case_seed['docket'].lower()}", case_seed))
    relationships: List[dict] = list(staged_cases)

    def text_of(ref: str) -> Optional[str]:
        kind, ident = ref.split(":", 1)
        if kind == "case":
            path = ctx.scratch / "evidence" / f"{ident}.txt"
            return path.read_text(encoding="utf-8") if path.exists() else None
        bill = read_json(_staged_or_public(ctx, bill_path(ident)))
        if not bill:
            return None
        mirrored = [v for v in bill["versions"] if v.get("textPath")]
        if not mirrored:
            return None
        text = read_json(_staged_or_public(ctx, mirrored[-1]["textPath"]))
        return "\n".join(b[1] for b in text["blocks"]) if text else None

    def cited(ref: str) -> tuple[str, str]:
        """Address and description of the document a seed's ``evidenceIn`` names."""
        kind, ident = ref.split(":", 1)
        if kind == "case":
            noted = read_json(ctx.scratch / "evidence" / f"{ident}.json") or {}
            return noted.get("url") or "", noted.get("document") or EVIDENCE_LABELS["url"]
        bill = read_json(_staged_or_public(ctx, bill_path(ident))) or {}
        mirrored = [v for v in bill.get("versions", []) if v.get("textPath")]
        version = mirrored[-1] if mirrored else {}
        label = f"the official text of {bill.get('identifier', 'the measure')}, version \"{version.get('label', 'latest')}\" of {version.get('versionDate', 'unknown date')}"
        return version.get("officialUrl") or bill.get("officialUrl", ""), label

    def addresses_of(ref: str) -> set:
        """Addresses of the documents of the record a seed's ``evidenceIn`` names."""
        kind, ident = ref.split(":", 1)
        if kind == "case":
            case = read_json(_staged_or_public(ctx, case_path(ident))) or {}
            found = {(d.get("url") or "").split("#")[0] for d in case.get("documents", [])} | {(case.get("questionsPresented") or {}).get("url")}
        else:
            bill = read_json(_staged_or_public(ctx, bill_path(ident))) or {}
            found = {v.get("officialUrl") for v in bill.get("versions", [])} | {bill.get("officialUrl")}
        return found - {None, ""}

    for seed in read_json(SEEDS_DIR / "relationships.json")["relationships"]:
        s_kind, s_id = seed["source"].split(":", 1)
        t_kind, t_id = seed["target"].split(":", 1)
        rel_id = "rel-" + re.sub(r"[^a-z0-9]+", "-", f"{s_id}-{seed['relationshipType']}-{t_id}".lower()).strip("-")
        text = text_of(seed["evidenceIn"])
        if text is None:
            # The evidence document was not fetched in this run (its stage did not run, or the
            # download failed). That says nothing about the link, so the last published record is
            # kept exactly as it was, including the date it was last checked. It is only kept if
            # the seed still says what was checked: the same quote, scope and cited document.
            kept = previous.get(rel_id)
            support = (kept or {}).get("support") or {}
            if (kept and kept.get("basis") == "curated" and kept.get("ruleId") == "rel-seed-2" and support.get("quote") == seed.get("quote")
                    and kept.get("scope") == RelationshipScope(**seed["scope"]).model_dump(mode="json")
                    and support.get("url") in addresses_of(seed["evidenceIn"])
                    and (not seed.get("evidenceLabel") or support.get("document") == seed["evidenceLabel"])):
                relationships.append(kept)
                continue
            ctx.flag("evidence_unavailable", rel_id, f"link not published: {seed['evidenceIn']} was not fetched in this run and no earlier check of this passage exists")
            continue
        problem = evidence.find_passage(seed.get("quote"), text)
        if not problem and t_kind == "geography":
            unnamed = evidence.names_place(seed["quote"], t_id, state_names, unit_names)
            if unnamed:
                problem = f"the passage does not name {unnamed}"
        if problem:
            # A link whose passage cannot be shown in the cited document is not published at all.
            ctx.flag("evidence_check_failed", rel_id, f"link not published: {problem} (document: {seed['evidenceIn']})")
            continue
        url, document = cited(seed["evidenceIn"])
        relationships.append(EntityRelationship(
            id=rel_id, source=EntityRef(type=s_kind, id=s_id), target=EntityRef(type=t_kind, id=t_id),
            relationshipType=seed["relationshipType"], scope=RelationshipScope(**seed["scope"]),
            support=EvidenceRef(url=url, quote=seed["quote"], document=seed.get("evidenceLabel") or document),
            basis="curated", ruleId="rel-seed-2",
            verification=Verification(
                status=VerificationStatus.VERIFIED_PRIMARY, method=CURATED_METHOD, checkedAt=ctx.now,
                note="The link and its description were written by a maintainer. The quoted passage was found in the cited document "
                     f"on this date, {evidence.IGNORED_IN_WORDS}. The check shows that the document says this; "
                     "it does not check the description."),
        ).model_dump(mode="json"))

    # One id produced twice means two producers made the same link (or a seed is duplicated). Dropping either
    # copy could keep a stale one, so nothing is published and the stage fails.
    duplicates = sorted(rel_id for rel_id, count in Counter(rel["id"] for rel in relationships).items() if count > 1)
    if duplicates:
        raise RuntimeError(f"internal error: relationship id(s) produced more than once: {', '.join(duplicates[:10])}")

    # Stage 8: every endpoint must resolve.
    resolved: List[dict] = []
    for rel in relationships:
        problems = []
        for end in (rel["source"], rel["target"]):
            known = {"geography": known_geo, "case": cases, "bill": bills}[end["type"]]
            if end["id"] not in known:
                problems.append(f"unknown {end['type']} {end['id']}")
        if problems:
            ctx.flag("relationship_dropped", rel["id"], "; ".join(problems))
            continue
        resolved.append(rel)
    resolved.sort(key=lambda r: r["id"])
    # Supreme Court dockets and the court of appeals cases they come from, as the two indexes are about to be published.
    composition = read_json(_staged_or_public(ctx, "geo/circuits.json")) or {}
    court_names = {court["name"].casefold(): court["id"] for court in composition.get("courts", [])}
    case_links = cases_below(_listed(ctx, CASE_INDEXES[:1], "cases"), _listed(ctx, CASE_INDEXES[1:], "cases"), court_names)
    write_json(ctx.staging / "relationships.json", {"relationships": resolved, "caseLinks": case_links})
    ctx.published_files.append("relationships.json")


def _subject_in_force(versions: List[dict], date: str, event_type: str) -> Optional[str]:
    """The official subject line of the text version in force when a bill action was taken: the latest version dated
    before the action. None when no version is dated before it, when a version is dated that same day (the record does
    not say which text the action concerned), or when the action adopted amendments (they are printed in the next
    version, which may name another subject). The site compares it with the bill's current subject line, so that a vote
    taken before a "gut and amend" says which subject it was taken on (src/lib/billHistory.ts uses the same rule)."""
    if event_type == "amended" or any(v.get("versionDate") == date for v in versions):
        return None
    latest: Optional[dict] = None
    for version in versions:
        when = version.get("versionDate") or ""
        if when < date and (latest is None or when >= latest["versionDate"]):
            latest = version
    subject = (latest or {}).get("subject")
    return subject.strip() if isinstance(subject, str) and subject.strip() else None


def stage_events(ctx: Context) -> None:
    """Build the cross-entity timeline of *major* dated events (historical dates only)."""
    rels = (read_json(_staged_or_public(ctx, "relationships.json")) or {}).get("relationships", [])
    geo_for: Dict[str, List[str]] = {}
    for rel in rels:
        if rel["target"]["type"] != "geography":
            continue
        target = rel["target"]["id"]
        if target.startswith("state:") and rel["scope"]["kind"] not in ("statewide", "multi_state"):
            # The record concerns one county or district, which has its own link. Listing its events
            # under the state key would show them on every other county and district of that state.
            continue
        geo_for.setdefault(f"{rel['source']['type']}:{rel['source']['id']}", []).append(target)
    events: List[dict] = []
    for summary in (read_json(_staged_or_public(ctx, "litigation/index.json")) or {}).get("cases", []):
        case = read_json(_staged_or_public(ctx, f"litigation/cases/{summary['id']}.json")) or {}
        for ev in case.get("events", []):
            if ev["significance"] != "major":
                continue
            events.append({
                "id": ev["id"], "date": ev["date"], "category": "litigation", "eventType": ev["eventType"],
                "entityType": "case", "entityId": case["id"], "entityLabel": f"{case['caseName']} (No. {case['docketNumber']})",
                "description": ev["description"], "sourceUrl": ev["evidence"]["url"],
                # The Supreme Court is a court of the whole country, so its entries are listed under the nation as well
                # as under the places the docket is linked to.
                "geoKeys": sorted(set([NATION_KEY] + geo_for.get(f"case:{case['id']}", []))), "ruleId": ev.get("classificationRule"),
            })
    # A court of appeals decision is listed under its circuit only. A circuit covers several states and the decision
    # binds all of them alike, so no state is named. One opinion that decides several appeals is listed once, under
    # the first of those cases, with the numbers of all of them.
    appeals = {summary["id"]: read_json(_staged_or_public(ctx, case_path(summary["id"]))) or {}
               for summary in (read_json(_staged_or_public(ctx, "circuits/index.json")) or {}).get("cases", [])}
    for case_id in sorted(appeals):
        case = appeals[case_id]
        court = circuits.BY_ID.get(case.get("courtId"))
        keys = sorted(set(([court.geo_key] if court and court.geo_key else []) + geo_for.get(f"case:{case_id}", [])))
        same_text = {doc["id"]: doc.get("sameTextAs", []) for doc in case.get("documents", [])}
        for ev in case.get("events", []):
            if ev["significance"] != "major":
                continue
            shared = sorted({uscourts.case_of_document(other) for doc_id in ev.get("documentIds", []) for other in same_text.get(doc_id, [])}
                            & set(appeals))
            if any(other < case_id for other in shared):
                continue
            dockets = [case["docketNumber"]] + [appeals[other]["docketNumber"] for other in shared]
            events.append({
                "id": ev["id"], "date": ev["date"], "category": "litigation", "eventType": ev["eventType"],
                "entityType": "case", "entityId": case_id,
                "entityLabel": f"{case['caseName']} ({court.short_name if court else case.get('courtId')}, "
                               f"No{'s' if len(dockets) > 1 else ''}. {', '.join(dockets)})",
                "description": ev["description"], "sourceUrl": ev["evidence"]["url"], "geoKeys": keys, "ruleId": ev.get("classificationRule"),
            })
    for summary in _listed(ctx, BILL_INDEXES, "bills"):
        bill = read_json(_staged_or_public(ctx, bill_path(summary["id"]))) or {}
        federal = bill["state"] == "US"
        # A measure of Congress applies nationwide, so it is listed under the nation, not under any state.
        keys = sorted(set([NATION_KEY if federal else f"state:{bill['state']}"] + geo_for.get(f"bill:{bill['id']}", [])))
        # "H.R. 22 (119th Congress)": the session's own name ends in its years in brackets, which would nest here.
        label = (f"{bill['identifier']} ({bill['session'].split(' (')[0]})" if federal
                 else f"{bill['stateAbbr']} {bill['identifier']} ({bill['session']})")
        for i, action in enumerate(bill.get("actions", [])):
            if action["significance"] != "major":
                continue
            events.append({
                "id": f"{bill['id']}-a{i}", "date": action["date"], "category": "legislation", "eventType": action["eventType"],
                "entityType": "bill", "entityId": bill["id"], "entityLabel": label, "description": action["text"],
                "sourceUrl": bill["officialUrl"], "geoKeys": keys, "ruleId": action.get("classificationRule"),
                "subjectInForce": _subject_in_force(bill.get("versions", []), action["date"], action["eventType"]),
            })
        for version in bill.get("versions", [])[1:]:
            diff = version.get("diff")
            if not diff or (diff["blocksAdded"] == 0 and diff["blocksRemoved"] == 0):
                continue
            events.append({
                "id": f"{bill['id']}-v-{version['id']}", "date": version["versionDate"], "category": "legislation",
                "eventType": "text_version_changed", "entityType": "bill", "entityId": bill["id"], "entityLabel": label,
                "description": f"Official text version '{version['label']}' differs from the previous version: "
                               f"{diff['blocksAdded']} paragraph(s) added or changed, {diff['blocksRemoved']} removed or replaced.",
                "sourceUrl": version["officialUrl"], "geoKeys": keys, "ruleId": "diff-meta-1",
            })
    redistricting = read_json(_staged_or_public(ctx, "redistricting.json"))
    index = read_json(_staged_or_public(ctx, "geo/index.json")) or {"layers": {}}
    cd120 = index["layers"].get("cd120", {})
    if redistricting and cd120.get("sourcePublishedAt"):
        published = cd120["sourcePublishedAt"][:10]
        for fips in redistricting["congress120"]["statesWithNewBoundaries"]:
            events.append({
                "id": f"geo-cd120-{fips}", "date": published, "category": "geography", "eventType": "boundary_files_updated",
                "entityType": "geography", "entityId": f"state:{fips}", "entityLabel": f"{STATES[fips][1]} congressional districts",
                "description": "The Census Bureau lists this state among those with new congressional district boundaries for the 2026 "
                               "election cycle (120th Congress). The date is the one the Bureau's server gives for the current TIGER/Line "
                               "boundary file. The Bureau rewrites the files of all states together, so this is not the day this state's "
                               "boundaries were first published, and it is not the day the plan was adopted.",
                "sourceUrl": redistricting["congress120"]["sourceUrl"], "geoKeys": [f"state:{fips}"], "ruleId": None,
            })
    events.sort(key=lambda e: (e["date"], e["id"]), reverse=True)
    write_json(ctx.staging / "events.json", {"events": events})
    ctx.published_files.append("events.json")


#: Rules that are not keyword patterns. Published so that every rule id shown in the app can be looked up.
OTHER_RULES = [
    {"ruleId": "cases-seed-2", "appliesTo": "Which court cases are included, and which places they are linked to",
     "description": "A maintainer lists the docket and the places it concerns in pipeline/seeds/cases.json, each with a short description and "
                    "a passage quoted from a named document of that docket (the Court's Questions Presented document, the filing that opened "
                    "the docket, or an opinion or order). On every run that refreshes the docket the pipeline fetches the document and checks "
                    "that the passage is in it, "
                    f"{evidence.IGNORED_IN_WORDS}, and that the passage names the place. The check shows that the "
                    "document says this. It does not check the maintainer's description, and a passage from a party's filing is that party's "
                    "account. A link whose passage is not found is not published; it is listed in the review queue."},
    {"ruleId": "same-lower-court-2", "appliesTo": "Dockets shown as coming from the same case below",
     "description": "Two dockets in the dataset are shown as related when the Court's docket pages give both the same lower court and a "
                    "lower-court case number for the same case. A district court case number is compared without its letter case and "
                    "leading zeros, and its year, case type and sequence number must agree. Some districts number cases separately in "
                    "each division, so two different prefixes of the same kind (two division numbers, or two sets of office letters) "
                    "are read as two cases. Where one number has a division number and the other office letters, or only one has a "
                    "prefix, the judges' initials after the number must be given on both and agree (so 3:21-cv-00259-DCG-JES-JVB "
                    "and EP-21-CV-00259-DCG-JES-JVB agree). Other numbers must agree exactly. "
                    "The Court does not state the relation; it is derived by this rule."},
    {"ruleId": CASE_BELOW_RULE_ID, "appliesTo": "A Supreme Court docket shown with the court of appeals case it comes from",
     "description": "A Supreme Court docket is paired with a court of appeals case in the dataset when the Court's docket page names "
                    "that court of appeals as the lower court and gives a lower-court case number that is the case's docket number. "
                    "The court's name must agree in full, and the numbers are compared by their two-digit year and their serial "
                    "number without leading zeros. A number that would name two cases of the court is paired with neither. Neither "
                    "record states the pairing; it is derived by this rule, and each of the two pages links the other. Most dockets "
                    "from a court of appeals have no such link, because the case below is older than the documents read or was not "
                    "picked by the selection rule."},
    {"ruleId": "rel-seed-2", "appliesTo": "Links between a bill and another bill, a case or a place",
     "description": "A maintainer lists the link in pipeline/seeds/relationships.json together with a passage quoted from the official text "
                    "of the named bill version or from the named court document. On every run that has that text the pipeline checks that the "
                    "passage is in it, "
                    f"{evidence.IGNORED_IN_WORDS}; a passage that ties a bill or case to a place must also name the place. "
                    "A link whose passage is not found, or does not name the place, is not published; it is listed "
                    "in the review queue. The links are a hand-picked subset: the absence of a link does not mean two records are unrelated."},
    {"ruleId": classify.CURATED_RULE_ID, "appliesTo": "Subject tags added by a maintainer",
     "description": "Where the keyword rules miss the central subject of a case, a maintainer may add a tag in pipeline/seeds/cases.json "
                    "with a passage quoted from a document of that docket. The passage is checked in the same way as a link's passage, and "
                    "the tag is shown with it. A tag whose passage is not found is not published."},
    {"ruleId": ca_leginfo.SELECTION_RULE_ID, "appliesTo": "Which California measures are included",
     "description": "A measure is included when its latest official subject line matches the published keyword pattern, after the phrases "
                    "of the published exclusion pattern have been removed from it. The words 'initiative' and 'recall' count only in an "
                    "electoral sense, so a programme named an Initiative or a product recall is not included. "
                    "Both patterns and the number of measures they were applied to are published in legislation/index.json and shown "
                    "under Coverage and selection."},
    {"ruleId": ca_leginfo.CONDITION_RULE_ID, "appliesTo": "Conditions quoted beside a California measure's effective date",
     "description": "A sentence of the latest mirrored text is quoted as a condition when it says that the measure, or a named part of it, "
                    "shall become operative or take effect only if, when, upon or after something happens. The pattern is "
                    + ca_leginfo.CONDITION_PATTERN.pattern + " . Whether a condition was met is not recorded. A condition worded "
                    "differently is not found, so the absence of a quoted condition does not mean there is none."},
    {"ruleId": ca_leginfo.SUNSET_RULE_ID, "appliesTo": "Repeal dates quoted beside a California measure's effective date",
     "description": "A sentence of the latest mirrored text is quoted when it says that the measure, or a named part of it ('This section', "
                    "'This chapter'), shall remain in effect until, or only until, a date or an event and as of that date is repealed. The clause "
                    "applies to the provision the sentence names, not necessarily to the whole measure, and only if the measure is "
                    "enacted. Where the sentence gives a calendar date it is recorded; where it names an event, no date is recorded. "
                    "A sentence repeated in several sections is quoted once. The pattern is " + ca_leginfo.SUNSET_PATTERN.pattern
                    + " . A sunset worded differently (for example 'is repealed on' or 'becomes inoperative on') is not found, so the "
                    "absence of a quoted clause does not mean there is none, and a later statute may have changed the date."},
    {"ruleId": congress.SELECTION_RULE_ID, "appliesTo": "Which measures of Congress are included",
     "description": "Every measure of the Congress named in congress/index.json is read. A measure is included when one of its titles "
                    "(display, official or short title) meets one of three tests, tried in this order: the title names election law "
                    "(the first pattern); the title has a general election word (the second pattern) and the policy area the "
                    "Congressional Research Service assigned is Government Operations and Politics, or none is assigned yet; the title "
                    "has an election word (the third pattern) and the policy area is one of the three listed with it. A measure in the "
                    "policy area International Affairs is not included, because its titles speak of elections in other countries. Before "
                    "a title is read, the phrases of the exclusion pattern are removed from it: procedure of the two chambers (a rule "
                    "for the consideration of a bill, the election of the Speaker) and voting outside public elections (proxy voting, "
                    "votes of shareholders). Each measure's page names the test it met and the words that met it. The patterns, the "
                    "policy areas and the number of measures read are published in congress/index.json and shown under Coverage and "
                    "selection. A measure whose titles do not say that it concerns elections is missed."},
    {"ruleId": congress.STATUS_RULE_ID, "appliesTo": "The stage shown for a measure of Congress",
     "description": "The stage is the furthest step among the measure's recorded actions, read from the labels the action rules "
                    "assign: became law; vetoed; sent to the President; for a resolution of one chamber, agreed to (or not agreed to) "
                    "there; passed in each chamber; passed one chamber; failed in a chamber; reported by a committee; introduced. It "
                    "says how far the measure got, not what is happening to it now, and it is not an official status. The official "
                    f"record's own latest action is shown beside it. The stage '{congress.PASSED_IN_EACH}' (for a concurrent "
                    f"resolution, '{congress.AGREED_IN_EACH}') means only that the record has a vote of passage in each chamber. The "
                    "two votes can be on different texts, as when one chamber passes the other's bill with an amendment, so the stage "
                    "does not say that Congress has passed the measure.",
     # The stages from the first to the furthest. The site lists stages in this order; the data check compares the two.
     "order": list(congress.STATUS_ORDER)},
    {"ruleId": uscourts.SELECTION_RULE_ID, "appliesTo": "Which court of appeals cases are included",
     "description": "Every case of the thirteen courts of appeals that GovInfo lists with an opinion or order issued since "
                    f"{uscourts.SINCE} is read. A case is included when the court's own record gives it the nature of suit "
                    f"{uscourts.VOTING_NATURE_OF_SUIT} (Civil Rights: Voting), or when one of its documents meets one of three text "
                    "tests: 'long' (at least 8 election words, at least 8 election phrases and at least 2 election words in every "
                    "1,000 words), 'dense' (at least 8 election words, at least 3 phrases and at least 5 election words in every "
                    "1,000 words) or 'party' (a party or the case title names an election authority, and the document has at least 3 "
                    "election words). The text tests are not applied where the record gives the case a nature of suit of another "
                    "field of law (contract, torts, labor, intellectual property, securities, freedom of information), and a "
                    "document with many labor-law terms is not read as an election document, because union representation "
                    "elections are not public elections. A clerk's cover letter (rule " + uscourts.COVER_LETTER_RULE_ID + ") is not "
                    "counted. Counts are taken after words broken across lines are joined. Each case's page shows the tests it met, "
                    "the document they rest on and the phrases counted in it. The patterns, thresholds and nature of suit codes are "
                    "published in circuits/index.json, with the number of cases and documents read for each court. The rule counts "
                    "words: it can miss an election case, and it can include a case that only discusses elections."},
    {"ruleId": TAG_REMOVAL_RULE_ID, "appliesTo": "An issue tag of a court of appeals case that a maintainer removed",
     "description": "The issue rules count words. In a long opinion a rule can reach its count although the case is about "
                    "something else, for example where a court compares the standing of its plaintiffs with that in the "
                    "gerrymandering decisions. A maintainer may then list the case and the tag in pipeline/seeds/tag_removals.json, "
                    "with the reason and a passage of the opinion that shows what the case is about. On every run the pipeline "
                    "looks for the passage in the documents of the case, "
                    f"{evidence.IGNORED_IN_WORDS}. Only if it is found is the tag taken off, and the removal is then published "
                    "with the case and shown on its page under Issue tags, with the rule that had assigned the tag and the words it "
                    "had matched. If the passage is not found, the tag stays and the entry is listed in the review queue. A tag is "
                    "never removed because of who the parties are or how the case was decided."},
    {"ruleId": EXCLUSION_RULE_ID, "appliesTo": "Court of appeals cases the selection rule picks that a maintainer removed",
     "description": "A maintainer may list a case in pipeline/seeds/circuit_exclusions.json when the opinion itself shows that no public "
                    "election is at issue: an election of another kind (a student council, a union, a company board), a record that "
                    "classifies the case as a voting case by mistake, election cases cited only as precedent, or a dispute in which an "
                    "election office is only the employer. Each entry gives the reason and quotes a passage of the opinion. On every "
                    "run the pipeline looks for the passage in the documents of the case, "
                    f"{evidence.IGNORED_IN_WORDS}. Only if it is found is the case left out, and the entry is then published in "
                    "circuits/index.json and shown under Coverage and selection. If the passage is not found, the case stays in the "
                    "dataset and the entry is listed in the review queue. A case is never excluded because of who its parties are or "
                    "how it was decided."},
    {"ruleId": uscourts.COVER_LETTER_RULE_ID, "appliesTo": "Court of appeals documents that are a clerk's cover letter",
     "description": "Some courts send GovInfo the clerk's letter that tells counsel an opinion was issued, in place of the opinion. A "
                    "document is read as such a letter when the pattern " + uscourts.COVER_LETTER_PATTERN.pattern + " matches in its "
                    f"first {uscourts.COVER_LETTER_WINDOW:,} characters. The selection rule does not count such a document, and the "
                    "case page says that the file is the letter and not the opinion."},
    {"ruleId": uscourts.ORIGIN_RULE_ID, "appliesTo": "The district court a court of appeals case came from",
     "description": "The opinion's own line naming the court below is quoted when the pattern " + uscourts.ORIGIN_PATTERN.pattern
                    + f" matches in the first {uscourts.ORIGIN_WINDOW:,} characters of the opinion. The state is the one the district's "
                    "name gives. It says where the case began, not what it concerns: a case from one state can concern another, or "
                    "federal law alone. Many opinions name the court below in another form (an abbreviation, a caption set in "
                    "columns), and then no origin is shown; the absence of one does not mean the case did not come from a district court."},
    {"ruleId": uscourts.PUBLICATION_RULE_ID, "appliesTo": "Whether a court of appeals decision is shown as published or unpublished",
     "description": "Read from the court's own entry for the case's latest opinion, decision or judgment in GovInfo's record, and "
                    "from no other entry: 'Unpublished' when the pattern "
                    + uscourts.UNPUBLISHED_PATTERN.pattern + " matches, otherwise 'Published' when the pattern "
                    + uscourts.PUBLISHED_PATTERN.pattern + " matches, otherwise nothing is shown. The courts' rules on what an "
                    "unpublished decision is worth as precedent differ and are not stated here."},
    {"ruleId": uscourts.SAME_OPINION_RULE_ID, "appliesTo": "Court of appeals cases shown as decided together",
     "description": "Two cases of the same court are shown as decided together when each has a document of the same day whose text, "
                    f"reduced to its letters, is identical and at least {uscourts.SAME_OPINION_MIN_LETTERS:,} letters long. That is how "
                    "a court files one opinion that decides several appeals. The record does not state the relation; it is derived by "
                    "this rule. Such an opinion appears once in timelines, with the numbers of all its cases."},
    {"ruleId": COMPOSITION_RULE_ID, "appliesTo": "Which states and territories each judicial circuit is drawn with",
     "description": "The pipeline keeps a table of the states and territories of each circuit. On every run of the boundary stage it "
                    "reads 28 U.S.C. § 41 and 48 U.S.C. § 1821(a) in the edition of the United States Code that GovInfo publishes, and "
                    "compares the table with the statute's entry for every circuit. The map and the list of courts are published only "
                    "if they agree, and each court's page quotes the statute's entry. A name in the statute that is not a unit on the "
                    "map, and a unit on the map that the statute places in no circuit, are listed in geo/circuits.json. The circuit "
                    "outlines are the Census Bureau's state boundaries merged by DemocracyHQ, not an official map."},
    {"ruleId": "diff-meta-1", "appliesTo": "Timeline entries for a changed text version",
     "description": "A text version is listed as changed when the paragraph-level comparison with the previous official version adds or removes "
                    "at least one paragraph. The counts come from a standard longest-common-subsequence comparison of the extracted paragraphs."},
    *about.RULES,
    *government.RULES,
]


# --- stages: validate and publish ------------------------------------------------

def stage_validate(ctx: Context) -> None:
    """Re-validate everything about to be published. Raises on any error."""
    errors: List[str] = []
    seen_cases: set[str] = set()
    # A case id names its file, like a bill id: one that does not have the expected shape could point outside the folder.
    case_folders = (("litigation", r"scotus-[0-9a-z-]+", scotus.SOURCE_ID), ("circuits", CIRCUIT_CASE_ID_PATTERN, uscourts.SOURCE_ID))
    for folder, id_pattern, source_id in case_folders:
        listed = [str(summary.get("id") or "") for summary in (read_json(ctx.staging / folder / "index.json") or {}).get("cases", [])]
        files = sorted((ctx.staging / folder / "cases").glob("*.json")) if (ctx.staging / folder).exists() else []
        if (ctx.staging / folder).exists() and sorted(listed) != [path.stem for path in files]:
            errors.append(f"{folder}/index.json does not list exactly the cases that have a file in {folder}/cases")
        for path in files:
            obj = read_json(path)
            try:
                case = LegalCase(**obj)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{path.name}: {str(exc)[:200]}")
                continue
            if case.id in seen_cases:
                errors.append(f"duplicate case id {case.id}")
            seen_cases.add(case.id)
            if case.id != path.stem or not re.fullmatch(id_pattern, case.id) or case.sourceId != source_id:
                errors.append(f"{folder}/cases/{path.name}: the record's id or source does not belong in this folder")
            for doc in case.documents:
                if doc.url and not doc.url.startswith("https://"):
                    errors.append(f"{case.id}: non-https document url")
    for folder, id_pattern, form in (("legislation", ca_leginfo.BILL_ID_PATTERN, "ca-<session years>-<type><number>"),
                                     ("congress", congress.BILL_ID_PATTERN, "us-<congress>-<type><number>")):
        referenced: set[str] = set()
        # A bill id names its file. One that does not have the expected shape could point outside the folder.
        for summary in (read_json(ctx.staging / folder / "index.json") or {}).get("bills", []):
            if not re.fullmatch(id_pattern, str(summary.get("id") or "")):
                errors.append(f"{folder}/index.json: bill id {summary.get('id')!r:.80} does not have the form {form}")
        for path in sorted((ctx.staging / folder / "bills").glob("*.json")) if (ctx.staging / folder).exists() else []:
            obj = dict(read_json(path))
            try:
                bill = LegislativeInstrument(**obj)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{path.name}: {str(exc)[:200]}")
                continue
            if bill.id != path.stem or not re.fullmatch(id_pattern, bill.id):
                errors.append(f"{folder}/bills/{path.name}: the record's id does not belong in this folder")
            for version in bill.versions:
                referenced.add(version.textPath or "")
                if version.textPath and not version.textPath.startswith(f"{folder}/text/"):
                    errors.append(f"{bill.id}: text file {version.textPath} is outside {folder}/text")
                elif version.textPath and not (ctx.staging / version.textPath).exists() and not (ctx.public / version.textPath).exists():
                    errors.append(f"{bill.id}: missing text file {version.textPath}")
        # scripts/validate-data.mjs refuses a text file that no bill points at, and would block the whole commit.
        for path in sorted((ctx.staging / folder / "text").glob("*.json")) if (ctx.staging / folder).exists() else []:
            if f"{folder}/text/{path.name}" not in referenced:
                errors.append(f"orphan text file {folder}/text/{path.name}: no bill version points at it")
    composition = read_json(ctx.staging / "geo" / "circuits.json")
    if composition is not None:
        try:
            courts = [Court(**court) for court in composition["courts"]]
            if [court.id for court in courts] != [court.id for court in circuits.CIRCUITS]:
                errors.append("geo/circuits.json does not list the thirteen courts of appeals")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"geo/circuits.json: {str(exc)[:200]}")
    rel_path = ctx.staging / "relationships.json"
    if rel_path.exists():
        staged_links = read_json(rel_path)
        for rel in staged_links["relationships"]:
            try:
                EntityRelationship(**rel)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"relationship {rel.get('id')}: {str(exc)[:200]}")
        for link in staged_links.get("caseLinks", []):
            try:
                CaseLink(**link)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"case link {link.get('id')}: {str(exc)[:200]}")
    if errors:
        raise RuntimeError("validation failed: " + " | ".join(errors[:10]))


#: The published files that hold each source's records. A source's contentHash covers exactly these.
SOURCE_FILES: Dict[str, tuple[str, ...]] = {
    "census-cb-2025": ("geo/states.topo.json", "geo/counties.topo.json", "geo/cd119.topo.json", "geo/county_cd119.json",
                       "geo/circuits.topo.json", "geo/nation.topo.json"),
    "census-tiger-2026-cd120": ("geo/cd120.topo.json",),
    "census-cd120-page": ("redistricting.json",),
    "census-pl-2020": ("population/state.json", "population/county.json"),
    "census-cd119-sf": ("population/cd119.json",),
    "scotus-docket": ("litigation/", "courts.json"),
    "ca-leginfo-bulk": ("legislation/",),
    congress.SOURCE_ID: ("congress/index.json", "congress/bills/"),
    congress.TEXT_SOURCE_ID: ("congress/text/",),
    uscourts.SOURCE_ID: ("circuits/",),
    circuits.SOURCE_ID: ("geo/circuits.json",),
    "courtlistener-api": ("litigation_secondary.json",),
    "openstates-api": ("legislation_secondary.json",),
    # One file holds what four sources say; each source's hash therefore changes with any of them.
    officials.SENATE_SOURCE_ID: (GOVERNMENT_FILE,),
    officials.HOUSE_SOURCE_ID: (GOVERNMENT_FILE,),
    officials.GOVERNORS_SOURCE_ID: (GOVERNMENT_FILE,),
    officials.LEGISLATORS_SOURCE_ID: (GOVERNMENT_FILE,),
}


def files_hash(root: Path, paths: List[str]) -> Optional[str]:
    """SHA-256 over the sorted relative paths and the SHA-256 of each file's bytes; ``None`` for no file."""
    if not paths:
        return None
    digest = hashlib.sha256()
    for rel in sorted(paths):
        digest.update(f"{rel}\t{sha256_bytes((root / rel).read_bytes())}\n".encode("utf-8"))
    return digest.hexdigest()


def _swap_paths(public: Path) -> tuple[Path, Path]:
    """Where the next release is built, and where the published one waits while the two are swapped."""
    return public.with_name(f".{public.name}.incoming"), public.with_name(f".{public.name}.previous")


def _recover_interrupted_publish(public: Path) -> None:
    """Undo what a publish that was killed part-way left behind."""
    incoming, backup = _swap_paths(public)
    if backup.exists():
        if public.exists():
            shutil.rmtree(backup)  # the new release was swapped in; only its predecessor was left
        else:
            backup.rename(public)  # stopped between the two renames: the backup is the published release
    if incoming.exists():
        shutil.rmtree(incoming)


def stage_publish(ctx: Context) -> None:
    """Build the complete new release beside the published one, then swap it in.

    The new tree starts as a copy of the published one. The directories and files of the stages that
    succeeded replace theirs, and the rule list, source register and manifest are written into it. Only
    then is it swapped in: the published tree is renamed to a backup, the new tree takes its place, and the
    backup is removed. Anything that fails before that leaves the published tree as it was, and a failure of
    the second rename puts the backup back.
    """
    incoming, backup = _swap_paths(ctx.public)
    if incoming.exists():
        shutil.rmtree(incoming)
    try:
        _build_release(ctx, incoming)
        if backup.exists():
            shutil.rmtree(backup)
        if ctx.public.exists():
            ctx.public.rename(backup)
        try:
            incoming.rename(ctx.public)
        except BaseException:
            if backup.exists() and not ctx.public.exists():
                backup.rename(ctx.public)
            raise
    finally:
        if incoming.exists():
            shutil.rmtree(incoming, ignore_errors=True)
    if backup.exists():
        shutil.rmtree(backup)


def _build_release(ctx: Context, incoming: Path) -> None:
    if ctx.public.exists():
        shutil.copytree(ctx.public, incoming, ignore=shutil.ignore_patterns(".*.incoming"))
    else:
        incoming.mkdir(parents=True)
    for directory in dict.fromkeys(ctx.published_dirs):
        src, dst = ctx.staging / directory, incoming / directory
        if not src.exists():
            continue
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        if directory in ("legislation", "congress"):
            # A bill that could not be rebuilt keeps its last verified record, and that record still
            # points at its version texts. Keep those; drop the texts of bills no longer published.
            wanted = {version.get("textPath") for record in (dst / "bills").glob("*.json")
                      for version in (read_json(record) or {}).get("versions", [])}
            for old in (ctx.public / directory / "text").glob("*.json"):
                target = dst / "text" / old.name
                if f"{directory}/text/{old.name}" in wanted and not target.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(old, target)
    for name in dict.fromkeys(ctx.published_files):
        src = ctx.staging / name
        if src.exists():
            shutil.copy2(src, incoming / name)
    write_json(incoming / "classification.json", {
        **classify.rules_document(),
        "docketEntryRules": [{"ruleId": r, "eventType": e, "significance": s, "rulesOn": lvl, "pattern": p} for r, e, s, lvl, p in scotus.EVENT_RULES],
        "legislativeActionRules": [{"ruleId": r, "eventType": e, "significance": s, "pattern": p} for r, e, s, p in ca_leginfo.ACTION_RULES]
                                  + [{"ruleId": "ca-other", "eventType": "legislative_action", "significance": "routine", "pattern": "(any action no rule above matches)"}],
        # Measures of Congress: a rule reads only the standard lines the Library of Congress writes, by action code and wording.
        "federalActionRules": [{"ruleId": r, "eventType": e, "significance": s, "actionCodes": list(codes), "pattern": p}
                               for r, e, s, codes, p in congress.ACTION_RULES]
                              + [{"ruleId": congress.OTHER_RULE_ID, "eventType": "committee_action, floor_action, referral, calendar or legislative_action",
                                  "significance": "routine", "actionCodes": [],
                                  "pattern": "(any action no rule above matches; named by the kind the record gives it)"}],
        # Court of appeals documents: what a document is called, from the court's own entry for it. The first match wins.
        "circuitDocumentRules": [{"ruleId": r, "eventType": e, "documentType": label, "significance": s, "pattern": p}
                                 for r, e, label, s, p in uscourts.DOCUMENT_RULES]
                                + [{"ruleId": uscourts.OTHER_DOCUMENT_RULE[0], "eventType": uscourts.OTHER_DOCUMENT_RULE[1],
                                    "documentType": uscourts.OTHER_DOCUMENT_RULE[2], "significance": uscourts.OTHER_DOCUMENT_RULE[3],
                                    "pattern": "(any entry no rule above matches, or an entry without text)"}],
        "otherRules": OTHER_RULES,
    }, indent=1)

    published = sorted(p.relative_to(incoming).as_posix() for p in incoming.rglob("*") if p.is_file())
    previous = {s["id"]: s for s in (read_json(ctx.public / "sources.json") or {}).get("sources", [])}
    records: List[dict] = []
    for source_id, static in SOURCES.items():
        prior = previous.get(source_id, {})
        run = ctx.status.get(source_id)
        merged = {"id": source_id, **static}
        for key in ("retrievedAt", "lastSuccessfulCheck", "lastAttempt", "sourcePublishedAt", "recordCount", "statusDetail", "contentHash"):
            merged[key] = prior.get(key)
        merged["processingStatus"] = prior.get("processingStatus", "not_run")
        if run:
            merged.update({k: v for k, v in run.items() if v is not None or k == "statusDetail"})
            if run["processingStatus"] != "ok":
                # keep the earlier successful-check timestamp so staleness is visible
                merged["lastSuccessfulCheck"] = prior.get("lastSuccessfulCheck")
                merged["retrievedAt"] = prior.get("retrievedAt")
        merged["contentHash"] = files_hash(incoming, [rel for rel in published if any(
            rel == f or (f.endswith("/") and rel.startswith(f)) for f in SOURCE_FILES.get(source_id, ()))])
        records.append(SourceRecord(**merged).model_dump(mode="json"))
    write_json(incoming / "sources.json", {"sources": records}, indent=1)
    def listed(rel: str, key: str) -> int:
        return len((read_json(incoming / rel) or {}).get(key, []))

    counts = {
        # All cases and all measures, then each set on its own.
        "cases": sum(listed(rel, "cases") for rel in CASE_INDEXES),
        "bills": sum(listed(rel, "bills") for rel in BILL_INDEXES),
        "supremeCourtCases": listed("litigation/index.json", "cases"),
        "appealsCourtCases": listed("circuits/index.json", "cases"),
        "stateBills": listed("legislation/index.json", "bills"),
        "federalBills": listed("congress/index.json", "bills"),
        "relationships": len((read_json(incoming / "relationships.json") or {}).get("relationships", [])),
        "events": len((read_json(incoming / "events.json") or {}).get("events", [])),
        "geographicUnits": len((read_json(incoming / "geo/index.json") or {}).get("rows", [])),
    }
    queue = ctx.queue
    write_json(incoming / "manifest.json", {
        "schemaVersion": SCHEMA_VERSION, "generatedAt": ctx.now, "counts": counts,
        "reviewQueue": {"items": len(queue), "byKind": {k: sum(1 for r in queue if r["kind"] == k) for k in sorted({r["kind"] for r in queue})}},
        "sources": {r["id"]: {"processingStatus": r["processingStatus"], "lastSuccessfulCheck": r["lastSuccessfulCheck"], "lastAttempt": r["lastAttempt"]} for r in records},
        # Every published file except this one, so that any change to the release changes the hash.
        "contentHash": files_hash(incoming, [rel for rel in sorted(set(published) | {"sources.json"}) if rel != "manifest.json"]),
    }, indent=1)


STAGES: Dict[str, tuple[Callable[[Context], None], List[str]]] = {
    # name -> (function, source ids that fail if the stage raises)
    "geo": (stage_geo, ["census-cb-2025", "census-tiger-2026-cd120", circuits.SOURCE_ID]),
    "population": (stage_population, ["census-pl-2020", "census-cd119-sf"]),
    "scotus": (stage_scotus, [scotus.SOURCE_ID]),
    "california": (stage_california, ["ca-leginfo-bulk"]),
    "congress": (stage_congress, [congress.SOURCE_ID, congress.TEXT_SOURCE_ID]),
    "circuits": (stage_circuits, [uscourts.SOURCE_ID]),
    "courtlistener": (stage_courtlistener, ["courtlistener-api"]),
    "openstates": (stage_openstates, ["openstates-api"]),
    "government": (stage_government, [officials.SENATE_SOURCE_ID, officials.HOUSE_SOURCE_ID, officials.GOVERNORS_SOURCE_ID,
                                      officials.LEGISLATORS_SOURCE_ID]),
    "relationships": (stage_relationships, []),
    "events": (stage_events, []),
}
DEFAULT_ORDER = ["geo", "population", "scotus", "california", "congress", "circuits", "courtlistener", "openstates", "government",
                 "relationships", "events"]
#: Stages whose records the links and the timeline are built from: after any of them, those two are rebuilt.
RECORD_STAGES = ("geo", "scotus", "california", "congress", "circuits")


def _staged_files(ctx: Context) -> Dict[Path, int]:
    if not ctx.staging.exists():
        return {}
    return {p: p.stat().st_mtime_ns for p in ctx.staging.rglob("*") if p.is_file()}


def _discard_staged_since(ctx: Context, before: Dict[Path, int]) -> None:
    """Remove what a failed stage staged, so that no later stage reads data that will not be published."""
    for path, mtime in _staged_files(ctx).items():
        if before.get(path) != mtime:
            path.unlink()


def _timestamp(value: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.strptime(value or "", "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def _flag_stale_records(ctx: Context) -> int:
    """Flag every case and bill about to be published whose last successful check is older than its source allows.

    A docket or bill that fails run after run keeps its last verified record, which the site marks as stale
    once it is older than the source's ``staleAfterDays``. The run then exits 1, so that the scheduler reports it too.
    """
    now = _timestamp(ctx.now)
    stale: Counter = Counter()
    for rel, key in [(rel, "cases") for rel in CASE_INDEXES] + [(rel, "bills") for rel in BILL_INDEXES]:
        for record in (read_json(_staged_or_public(ctx, rel)) or {}).get(key, []):
            limit = SOURCES.get(record.get("sourceId"), {}).get("staleAfterDays")
            checked = _timestamp(record.get("lastCheckedAt"))
            if now and limit and checked and now - checked > timedelta(days=limit):
                stale[record["sourceId"]] += 1
                ctx.flag("stale_record", record["id"], f"last refreshed on {record['lastCheckedAt'][:10]}, more than the {limit} days "
                                                        f"after which a record from {record['sourceId']} is shown as stale")
    for source_id, count in stale.items():
        status = ctx.status.get(source_id)
        if status:
            status["statusDetail"] = "; ".join(filter(None, [
                status.get("statusDetail"), f"{count} record(s) not refreshed for more than {SOURCES[source_id]['staleAfterDays']} days"]))[:500]
    return sum(stale.values())


def run(stage_names: List[str], ctx: Optional[Context] = None) -> int:
    """Run the stages, validate what they staged and publish it.

    Exit codes: 0 every stage and source succeeded; 1 a stage raised, a source is marked failed or a record is
    stale (everything else is published); 2 the pipeline's own validation failed (or the clock setting is
    unusable) and nothing was published; 3 publishing itself failed and the published data was left as it was.
    An error that escapes this function is turned into exit code 4 by :func:`main` (nothing new was published).
    """
    if ctx is None:
        try:
            ctx = Context()
        except ValueError as exc:  # an unusable DHQ_NOW
            log.error("%s; nothing published", exc)
            return 2
    _recover_interrupted_publish(ctx.public)
    review_path = ctx.staging.parent / "review.json"
    # The queue that describes the data published now. Items of a run that published nothing are not part of it.
    try:
        earlier = [item for item in (read_json(review_path) or {}).get("items", []) if not item.get("notPublished")]
    except ValueError as exc:
        log.warning("the earlier review queue could not be read (%s); it is not carried over", exc)
        earlier = []
    if ctx.staging.exists():
        shutil.rmtree(ctx.staging)
    if ctx.scratch.exists():
        shutil.rmtree(ctx.scratch)
    failed: List[str] = []
    for name in stage_names:
        function, source_ids = STAGES[name]
        log.info("stage %s: start", name)
        ctx.stage = name
        dirs_before, files_before = list(ctx.published_dirs), list(ctx.published_files)
        staged_before = _staged_files(ctx)
        try:
            function(ctx)
            log.info("stage %s: ok", name)
        except Exception as exc:  # noqa: BLE001 - isolate stages; publish the rest
            log.exception("stage %s failed", name)
            failed.append(name)
            ctx.published_dirs, ctx.published_files = dirs_before, files_before  # publish nothing from this stage
            _discard_staged_since(ctx, staged_before)  # later stages read the published files instead
            for source_id in source_ids:
                ctx.fail(source_id, "failed", f"{type(exc).__name__}: {exc}")
    ctx.stage = None
    stale = _flag_stale_records(ctx)
    # A stage that did not run, or that raised, leaves its published files as they are, so its earlier items still
    # describe them. What a failed stage flagged in this run describes data that was discarded: it is kept beside
    # the queue, marked, and not carried into the next run.
    unchanged = (set(STAGES) - set(stage_names)) | set(failed)
    current = [item for item in ctx.review if item["stage"] not in failed]
    discarded = [{**item, "notPublished": True} for item in ctx.review if item["stage"] in failed]
    fresh = {(item["kind"], item["entity"]) for item in current}
    ctx.queue = current + [item for item in earlier if item.get("stage") in unchanged and (item["kind"], item["entity"]) not in fresh]
    # Written before validation, so that the artifact of a run that fails it holds the items that explain why.
    write_json(review_path, {"generatedAt": ctx.now, "items": ctx.queue + discarded}, indent=1)

    def nothing_published() -> None:
        # The published queue stays the earlier one; this run's items are kept beside it, marked.
        write_json(review_path, {"generatedAt": ctx.now, "items": [{**item, "notPublished": True} for item in ctx.review] + earlier}, indent=1)

    try:
        stage_validate(ctx)
    except Exception as exc:  # noqa: BLE001
        log.error("validation failed; nothing published: %s", exc)
        nothing_published()
        return 2
    try:
        stage_publish(ctx)
    except Exception:  # noqa: BLE001 - the swap is undone, so the published tree is the previous release
        log.exception("publishing failed; the published data was left as it was")
        nothing_published()
        return 3
    failed_sources = sorted(sid for sid, st in ctx.status.items() if st.get("processingStatus") == "failed")
    # ingest.yml reads exit code 1 as "the rest was published" only when the log has this line (see dhq/cli.py).
    log.info("published to %s (failed stages: %s; failed sources: %s; stale records: %d; review items: %d new, %d in the queue)",
             ctx.public, failed or "none", failed_sources or "none", stale, len(ctx.review), len(ctx.queue))
    # A source can fail without its stage raising (every docket unreachable, the Census page unreadable): the
    # previous data stays published, and the run still exits 1 so that the failure is visible to the scheduler.
    return 1 if failed or failed_sources or stale else 0


class _ArgumentParser(argparse.ArgumentParser):
    """Exits with EXIT_UNEXPECTED on an argument error, not with argparse's 2, which here means that the pipeline's
    own validation failed. ``--help`` still exits 0."""

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(EXIT_UNEXPECTED, f"{self.prog}: error: {message}\n")


def main(argv: Optional[List[str]] = None) -> int:
    """Command line: exit codes 0 to 3 as for :func:`run`; 4 (EXIT_UNEXPECTED) when the arguments are not accepted
    or an unexpected error stops the pipeline outside its stages. Exit code 1 keeps meaning "a stage or a source
    failed and the rest was published", which the scheduled workflow relies on."""
    parser = _ArgumentParser(description="DemocracyHQ data pipeline")
    parser.add_argument("stages", nargs="*", help=f"stages to run (default: all). Choices: {', '.join(STAGES)}")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format=LOG_FORMAT)
    logging.getLogger("dhq.run").setLevel(logging.INFO)
    unknown = [s for s in args.stages if s not in STAGES]
    if unknown:
        parser.error(f"unknown stage(s): {', '.join(unknown)}")
    try:
        loaded = load_dotenv(REPO_ROOT / ".env")
        if loaded:
            log.info("read %s from .env", ", ".join(sorted(loaded)))
        stages = args.stages or DEFAULT_ORDER
        if any(s in stages for s in RECORD_STAGES):
            stages = [s for s in stages if s not in ("relationships", "events")] + ["relationships", "events"]
        return run(stages)
    except Exception:  # noqa: BLE001 - exit 1 must keep meaning "a source failed, the rest was published"
        log.exception("the pipeline stopped on an unexpected error outside its stages; nothing new was published")
        return EXIT_UNEXPECTED


# ``python -m dhq.run`` starts at the guard at the top of this file (see dhq/cli.py).
