"""The thirteen federal judicial circuits and their courts of appeals.

Which states and territories make up each circuit is set by statute, 28 U.S.C. § 41, and for the
Northern Mariana Islands by 48 U.S.C. § 1821(a). The table below is this project's copy. It is never
published on its own word: :func:`verify_composition` compares it with the text of both provisions
as GovInfo publishes them in the United States Code, and the published record quotes the statute's
entry for each circuit. If the statute and the table disagree, nothing new is published.

A circuit is where appeals from the federal district courts of its states are heard. It says nothing
about what a case concerns, and a decision of one circuit binds only the courts of that circuit.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

from .util import STATES, STATE_BY_NAME

#: The edition of the United States Code that is read. GovInfo publishes one edition a year.
USCODE_EDITION = 2024
SECTION_41_URL = f"https://www.govinfo.gov/content/pkg/USCODE-{USCODE_EDITION}-title28/html/USCODE-{USCODE_EDITION}-title28-partI-chap3-sec41.htm"
SECTION_1821_URL = (f"https://www.govinfo.gov/content/pkg/USCODE-{USCODE_EDITION}-title48/html/"
                    f"USCODE-{USCODE_EDITION}-title48-chap17-subchapII-sec1821.htm")
SOURCE_ID = "govinfo-uscode"
#: The sentence of 48 U.S.C. § 1821(a) that places the Northern Mariana Islands in a circuit.
NORTHERN_MARIANAS_SENTENCE = "The Northern Mariana Islands shall constitute a part of the same judicial circuit of the United States as Guam."
#: Names in the statute's table that are not a present-day state or territory with a boundary on the map.
NOT_ON_THE_MAP = ("District of the Canal Zone",)
#: How the statute names a territory, where that differs from the Census Bureau's name.
STATUTE_NAMES = {"virgin islands": "78"}


@dataclass(frozen=True)
class Circuit:
    """One court of appeals. ``code`` is GovInfo's code for the court, ``statute_name`` the circuit's name in section 41."""

    id: str
    code: str
    statute_name: str
    name: str
    short_name: str
    #: The map unit, ``circuit:<geoid>``. The Federal Circuit hears appeals by subject from every district and has none.
    geoid: Optional[str]
    website: str
    #: FIPS codes of the states and territories, in the order of the statute.
    states: tuple[str, ...] = ()

    @property
    def geo_key(self) -> Optional[str]:
        return f"circuit:{self.geoid}" if self.geoid else None


def _regional(number: int, word: str, states: str) -> Circuit:
    return Circuit(id=f"ca{number}", code=f"ca{number}", statute_name=word,
                   name=f"United States Court of Appeals for the {word} Circuit", short_name=f"{word} Circuit",
                   geoid=f"{number:02d}", website=f"https://www.ca{number}.uscourts.gov/", states=tuple(states.split()))


CIRCUITS: List[Circuit] = [
    _regional(1, "First", "23 25 33 72 44"),            # Maine, Massachusetts, New Hampshire, Puerto Rico, Rhode Island
    _regional(2, "Second", "09 36 50"),                 # Connecticut, New York, Vermont
    _regional(3, "Third", "10 34 42 78"),               # Delaware, New Jersey, Pennsylvania, Virgin Islands
    _regional(4, "Fourth", "24 37 45 51 54"),           # Maryland, North Carolina, South Carolina, Virginia, West Virginia
    _regional(5, "Fifth", "22 28 48"),                  # Louisiana, Mississippi, Texas
    _regional(6, "Sixth", "21 26 39 47"),               # Kentucky, Michigan, Ohio, Tennessee
    _regional(7, "Seventh", "17 18 55"),                # Illinois, Indiana, Wisconsin
    _regional(8, "Eighth", "05 19 27 29 31 38 46"),     # Arkansas, Iowa, Minnesota, Missouri, Nebraska, North Dakota, South Dakota
    # Alaska, Arizona, California, Idaho, Montana, Nevada, Oregon, Washington, Guam, Hawaii; then the Northern Mariana Islands
    _regional(9, "Ninth", "02 04 06 16 30 32 41 53 66 15 69"),
    _regional(10, "Tenth", "08 20 35 40 49 56"),        # Colorado, Kansas, New Mexico, Oklahoma, Utah, Wyoming
    _regional(11, "Eleventh", "01 12 13"),              # Alabama, Florida, Georgia
    Circuit(id="cadc", code="caDC", statute_name="District of Columbia",
            name="United States Court of Appeals for the District of Columbia Circuit", short_name="D.C. Circuit",
            geoid="DC", website="https://www.cadc.uscourts.gov/", states=("11",)),
    Circuit(id="cafc", code="ca13", statute_name="Federal",
            name="United States Court of Appeals for the Federal Circuit", short_name="Federal Circuit",
            geoid=None, website="https://www.cafc.uscourts.gov/"),
]
BY_ID: Dict[str, Circuit] = {c.id: c for c in CIRCUITS}
BY_CODE: Dict[str, Circuit] = {c.code: c for c in CIRCUITS}
REGIONAL: List[Circuit] = [c for c in CIRCUITS if c.geoid]
#: FIPS code of a state or territory -> the id of its court of appeals.
CIRCUIT_OF_STATE: Dict[str, str] = {fips: c.id for c in REGIONAL for fips in c.states}
#: States and territories on the map that the statutes place in no circuit (American Samoa has no federal district court).
WITHOUT_CIRCUIT: List[str] = sorted(set(STATES) - set(CIRCUIT_OF_STATE))


class CompositionError(ValueError):
    """The statute as published does not say what the table in this module says."""


_ROW_RE = re.compile(r'<td class="left">(.*?)</td>\s*<td class="right">(.*?)</td>', re.S)
_EDITION_RE = re.compile(r"United States Code, (\d{4}) Edition")
_CURRENT_RE = re.compile(r"currentthrough:(\d{4})(\d{2})(\d{2})")


def _plain(markup: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", markup))).strip()


def _edition(page: str) -> tuple[str, Optional[str]]:
    edition = _EDITION_RE.search(page)
    if not edition:
        raise CompositionError("the page does not name an edition of the United States Code")
    current = _CURRENT_RE.search(page)
    return f"United States Code, {edition.group(1)} Edition", ("-".join(current.groups()) if current else None)


def verify_composition(section_41: str, section_1821: str) -> dict:
    """Compare the table in this module with the two provisions and return what the statute says.

    ``section_41`` and ``section_1821`` are the pages GovInfo serves for the two sections. The result gives, for each
    circuit, the statute's own entry (``quotes``), the edition read and the date the edition is current through.
    Raises :class:`CompositionError` when a circuit is missing from the statute's table, when the statute names a
    place the table does not have (or the reverse), or when the sentence about the Northern Mariana Islands is not found.
    """
    start, end = section_41.find("field-start:statute"), section_41.find("field-end:statute")
    if start < 0 or end < start or "Number and composition of circuits" not in section_41:
        raise CompositionError("the page is not section 41 of title 28 in the layout this check knows")
    rows = {_plain(left): _plain(right) for left, right in _ROW_RE.findall(section_41[start:end])}
    if len(rows) != len(CIRCUITS):
        raise CompositionError(f"the statute's table has {len(rows)} circuits, not {len(CIRCUITS)}")
    statute_1821 = _plain(section_1821[section_1821.find("field-start:statute"):section_1821.find("field-end:statute")]
                          if "field-start:statute" in section_1821 else "")
    if "District Court for the Northern Mariana Islands" not in section_1821 or NORTHERN_MARIANAS_SENTENCE not in statute_1821:
        raise CompositionError("section 1821 of title 48 does not contain the sentence that places the Northern Mariana Islands "
                               "in the same circuit as Guam")
    quotes: Dict[str, str] = {}
    for circuit in CIRCUITS:
        entry = rows.get(circuit.statute_name)
        if entry is None:
            raise CompositionError(f"the statute's table has no entry named {circuit.statute_name!r}")
        quotes[circuit.id] = entry
        if not circuit.geoid:
            if entry != "All Federal judicial districts.":
                raise CompositionError(f"the statute's entry for the Federal Circuit reads {entry!r}")
            continue
        named: List[str] = []
        for name in (part.strip() for part in entry.rstrip(".").split(",")):
            if name in NOT_ON_THE_MAP:
                continue
            fips = STATUTE_NAMES.get(name.lower()) or STATE_BY_NAME.get(name.lower())
            if not fips:
                raise CompositionError(f"the statute's entry for the {circuit.short_name} names {name!r}, which is not a known state or territory")
            named.append(fips)
        # The Northern Mariana Islands are placed by section 1821 of title 48, not by this table.
        expected = [fips for fips in circuit.states if not (fips == "69" and circuit.id == "ca9")]
        if len(named) != len(set(named)) or set(named) != set(expected):
            raise CompositionError(f"the statute's entry for the {circuit.short_name} reads {entry!r}; the table here has "
                                   + ", ".join(STATES[f][1] for f in expected))
    if "66" not in BY_ID["ca9"].states or "69" not in BY_ID["ca9"].states:
        raise CompositionError("the table here does not place Guam and the Northern Mariana Islands in the same circuit")
    edition, current = _edition(section_41)
    edition_1821, _current = _edition(section_1821)
    if edition != edition_1821:
        raise CompositionError(f"the two sections were read from different editions ({edition}; {edition_1821})")
    return {"quotes": quotes, "edition": edition, "currentThrough": current}


def court_records(verified: dict) -> List[dict]:
    """The thirteen courts as published records, each with the statute's words for its circuit."""
    records = []
    for circuit in CIRCUITS:
        basis = {"citation": "28 U.S.C. § 41", "url": SECTION_41_URL, "quote": verified["quotes"][circuit.id]}
        if circuit.id == "ca9":
            basis["also"] = [{"citation": "48 U.S.C. § 1821(a)", "url": SECTION_1821_URL, "quote": NORTHERN_MARIANAS_SENTENCE}]
        records.append({
            "id": circuit.id, "name": circuit.name, "courtType": "federal_appellate", "jurisdiction": "Federal",
            "website": circuit.website, "shortName": circuit.short_name, "geoKey": circuit.geo_key,
            "states": sorted(circuit.states), "basis": basis,
        })
    return records
