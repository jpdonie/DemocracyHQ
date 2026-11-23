"""United States courts of appeals: opinions and orders published on GovInfo (collection USCOURTS).

The Government Publishing Office publishes the opinions that the courts of appeals send it at
https://www.govinfo.gov/app/collection/uscourts. One "package" is one case of one court
(``USCOURTS-ca4-25-01018``). It holds one PDF for each opinion or order and a metadata record with
the court's own data about the case: its number and title, the parties and their roles, for about
half of the cases the nature of suit, and for each document its date and the court's docket entry.

What this adapter does:

* It lists every package of the thirteen courts whose latest document is from ``SINCE`` or later
  (GovInfo's sitemaps, one for each court and year, give the time each package last changed).
* It reads the record of each package that is new or has changed, and the text of each of its
  documents issued since ``SINCE``, and applies the published selection rule (``SELECTION_RULE_ID``).
  A case is selected by what the court's record says or by counts in its opinions, never by a
  judgment of this project, apart from a short published list of exclusions that each quote the opinion.
* For a selected case it builds one record with the parties, every document of the package as an
  event with the court's own entry text, and the reason the case was selected.

What it does not do: it never says which state a case concerns. A circuit covers several states and
a decision binds all of them alike, so a case is listed under its court only. Where the opinion names
the district court the appeal came from, that is recorded as the case's origin (``ORIGIN_RULE_ID``).

GovInfo is not complete. It holds what each court sends: for the Eighth Circuit mostly the clerk's
cover letter in place of the opinion, and for the Second and Ninth Circuits far fewer cases than for
the other large courts. The numbers behind this are published with the data (see ``coverage``).

Privacy: only the case title and the parties as the court's record names them are published. The
record carries no addresses or telephone numbers.
"""

from __future__ import annotations

import gzip
import itertools
import html
import logging
import re
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

from .. import about as about_rules
from .. import classify, evidence, opening
from ..circuits import BY_CODE, CIRCUITS, Circuit
from ..http import FetchError, Fetcher, in_rounds
from ..schemas import (
    AboutText,
    CaseOrigin,
    CaseParty,
    CaseSelection,
    CourtDocument,
    DispositiveEntry,
    EvidenceRef,
    LegalCase,
    LegalEvent,
    LowerCourtInfo,
    TermCount,
    Verification,
    VerificationStatus,
)
from ..util import STATES, content_hash, write_bytes_atomic
from .scotus import extract_pdf_text

log = logging.getLogger("dhq.uscourts")

SOURCE_ID = "govinfo-uscourts"
#: Documents issued on or after this day are read. A case whose latest document is older is not listed. The day is the
#: start of the election cycle of 2024, the latest one that published counts of election litigation cover, so that
#: what is found here can be compared with them.
SINCE = "2024-01-01"
SITEMAP_URL = "https://www.govinfo.gov/sitemap/USCOURTS/USCOURTS_{court}_{year}_sitemap.xml"
RECORD_URL = "https://www.govinfo.gov/metadata/pkg/{package}/mods.xml"
DETAILS_URL = "https://www.govinfo.gov/app/details/{package}"
DOCUMENT_URL = "https://www.govinfo.gov/content/pkg/{package}/pdf/{granule}.pdf"
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = 96 * 1024 * 1024
MODS = {"m": "http://www.loc.gov/mods/v3"}

COVER_LETTER_RULE_ID = "cover-letter-1"
#: For most Eighth Circuit opinions GovInfo holds, under the opinion's entry, the clerk's letter that tells counsel an
#: opinion was issued, and not the opinion. Such a letter says nothing about the case, so the rule does not count in it,
#: and the case page says what the file is. The pattern is read in the first ``COVER_LETTER_WINDOW`` characters.
COVER_LETTER_PATTERN = re.compile(
    r"\bDear [^:]{1,60}:\s*(?:The court (?:has |today )?issued an? (?:amended )?opinion in th(?:is|ese) cases?"
    r"|Enclosed is a copy of (?:the|an) (?:amended )?(?:opinion|order and judgment))", re.I)
COVER_LETTER_WINDOW = 4000

# --- the selection rule -----------------------------------------------------------------------------

SELECTION_RULE_ID = "circuit-select-1"
#: The nature of suit code with which a court's record classifies a case as a voting case ("Civil Rights Voting").
VOTING_NATURE_OF_SUIT = "441"
#: Election words. Each match counts once.
WORD_PATTERN = re.compile(r"\b(?:voters?|ballots?|elections?|electoral|electorate|redistrict\w*|gerrymander\w*|reapportion\w*)\b", re.I)
#: Election phrases: statutes, bodies, procedures and doctrines of election law. Each match counts once.
PHRASE_PATTERN = re.compile(
    r"Voting Rights Act|National Voter Registration Act|Help America Vote Act|Federal Election Campaign Act|Bipartisan Campaign Reform Act"
    r"|Uniformed and Overseas Citizens Absentee Voting Act|Electoral Count"
    r"|Federal Election Commission|Election Assistance Commission"
    r"|Boards? of Elections?|Elections? (?:Commission|Board)s?\b|Board of (?:State )?Canvassers|Registrars? of Voters|Supervisors? of Elections"
    r"|elections? (?:officials?|administrators?|supervisors?|directors?|judges?|workers?|inspectors?|clerks?)|poll (?:workers?|watchers?)"
    r"|Secretar(?:y|ies) of State"
    r"|voter registration|register(?:ed|ing)? to vote|registered voters?|voter rolls?|voter (?:identification|ID)\b"
    r"|voter (?:fraud|intimidation|suppression|turnout)"
    r"|(?:primary|general|special|municipal|presidential|congressional|federal|state|local|judicial|runoff|recall|midterm) elections?"
    r"|Election Day|elections? (?:code|laws?|contests?|results|fraud|cycles?|integrity|administration|procedures?)"
    r"|Elections Clause|Electors Clause|Electoral College"
    r"|polling (?:place|location|station)s?|\bprecincts?\b|\babsentee\b|mail-in|vot(?:e|ing)[- ]by[- ]mail|early voting|drop ?box(?:es)?"
    r"|redistrict\w*|gerrymander\w*|reapportion\w*|vote dilution|majority-minority|one[- ]person,? one[- ]vote"
    r"|candidates? for|\bcandidacy\b|public office|elected offic(?:e|ials?)|elective office"
    r"|ballot (?:access|measures?|initiatives?|questions?|propositions?)|\breferend(?:um|a)\b|recall petitions?|initiative petitions?"
    r"|campaign (?:finance|contributions?|expenditures?|committees?|funds?)|political (?:action )?committees?|independent expenditures?"
    r"|electioneering|political part(?:y|ies)"
    r"|right to vote|Fifteenth Amendment|Twenty-Sixth Amendment|Anderson-Burdick", re.I)
#: Words of labor law, where "election" means a union representation election or an election of union officers.
LABOR_PATTERN = re.compile(
    r"National Labor Relations|\bNLRB\b|bargaining unit|collective[- ]bargaining|representation election|unfair labor practices?"
    r"|Labor[- ]Management Reporting|Railway Labor Act|decertification|union (?:office|officers?|elections?)", re.I)
#: A party, or the case title, that names a body which runs or oversees elections.
AUTHORITY_PATTERN = re.compile(
    r"\bBoards? of Elections?\b|\bElections? (?:Commission|Board)s?\b|\bBoard of Election Commissioners\b|\bElection Commissioners?\b"
    r"|\bBoard of (?:State )?Canvassers\b|\bCanvassing Board\b|\bRegistrars? of Voters\b|\bSupervisors? of Elections\b"
    r"|\bFederal Election Commission\b|\bFEC\b|\bElection Assistance Commission\b|\bElections? (?:Division|Office)\b"
    r"|\bRegistry of Election Finance\b", re.I)
#: The three tests a document can meet. ``wordMatches`` and ``phraseMatches`` are minimum counts, ``density`` is the
#: minimum number of election words in 1,000 words of the document.
TEXT_TESTS: Dict[str, Dict[str, float]] = {
    "long": {"wordMatches": 8, "phraseMatches": 8, "density": 2.0},
    "dense": {"wordMatches": 8, "phraseMatches": 3, "density": 5.0},
    "party": {"wordMatches": 3},
}
#: A document is not read as an election document when it has at least this many labor-law matches and at least a
#: quarter as many labor-law matches as election words.
LABOR_MIN_MATCHES = 10
LABOR_RATIO = 4
#: Nature of suit codes of other fields of law. Where a court's record gives one of them, the text tests are not applied:
#: the case is a contract, tort, labor, intellectual property, securities or freedom-of-information case in which an
#: election is part of the facts.
OTHER_FIELD_CODES: Dict[str, str] = {
    **{code: "Contract" for code in ("110", "120", "130", "140", "150", "151", "152", "153", "160", "190", "195", "196")},
    **{code: "Torts" for code in ("310", "315", "320", "330", "340", "345", "350", "355", "360", "362", "365", "367", "368",
                                  "370", "371", "380", "385")},
    **{code: "Labor" for code in ("710", "720", "740", "751", "790", "791")},
    **{code: "Intellectual property" for code in ("820", "830", "835", "840")},
    "850": "Securities",
    "895": "Freedom of Information Act",
}

# --- other published rules ---------------------------------------------------------------------------

ORIGIN_RULE_ID = "origin-court-1"
#: Read in the first ``ORIGIN_WINDOW`` characters of an opinion: the line in which it names the court below.
ORIGIN_PATTERN = re.compile(
    r"(?:On )?(?:Appeals?|Petitions? for (?:a )?Writ of Mandamus) (?:from|to) (?:a |an |the )?"
    r"(?:(?:judgment|order|orders|decision|final judgment)s? of (?:a |an |the )?)?"
    r"(United\s+States\s+District\s+Court\s+for\s+the\s+((?:(?:Northern|Southern|Eastern|Western|Middle|Central)\s+)?District\s+of\s+(?:the\s+)?)"
    r"([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}))", re.I)
ORIGIN_WINDOW = 20000
#: Lines of the first page that are read as a caption set in two columns, with ")" between the columns.
ORIGIN_CAPTION_LINES = 60
#: How an opinion names a district, where that differs from the name of the state or territory.
_DISTRICT_NAMES = {**{name.lower(): fips for fips, (_abbr, name) in STATES.items()}, "columbia": "11", "virgin islands": "78",
                   "northern mariana islands": "69"}

PUBLICATION_RULE_ID = "publication-1"
UNPUBLISHED_PATTERN = re.compile(r"\b(?:un|non-?)published\b|\bnot precedential\b|\bnon-?precedential\b|\bnot for publication\b", re.I)
PUBLISHED_PATTERN = re.compile(r"\bpublished\b|\bprecedential\b|\bfor publication\b", re.I)

SAME_OPINION_RULE_ID = "same-opinion-1"
#: Two opinions are compared only when each has at least this many letters.
SAME_OPINION_MIN_LETTERS = 2000

#: What a document is, from the court's entry for it. Ordered: the first match wins.
DOCUMENT_RULES: list[tuple[str, str, str, str, str]] = [
    # (ruleId, eventType, document type shown, significance, pattern)
    ("ca-doc-errata", "errata", "Errata", "routine", r"\berrat(?:a|um)\b"),
    # An entry that opens with an order about an opinion ("ORDER AMENDING OPINION") is the order, not an opinion.
    ("ca-doc-order-on-opinion", "order", "Order", "major", r"\A\W*order (?:amending|correcting|modifying|vacating|withdrawing)\b"),
    ("ca-doc-opinion", "opinion", "Opinion", "major", r"\bopinions?\b"),
    ("ca-doc-decision", "decision", "Decision", "major", r"\bdisposition\b|\bterminated on the merits\b"),
    ("ca-doc-judgment", "judgment", "Judgment", "major", r"\bjudgments?\b"),
    ("ca-doc-order", "order", "Order", "major", r"\borders?\b"),
    ("ca-doc-procedural", "procedural_termination", "Procedural termination", "routine", r"\bprocedural termination\b"),
]
#: An entry that names no kind of document, or has no text at all. GovInfo's collection holds opinions and orders, so
#: the document is listed with the others.
OTHER_DOCUMENT_RULE = ("ca-doc-other", "court_document", "Document", "major")
_DOCUMENT_RULES = [(rid, etype, label, sig, re.compile(pattern, re.I)) for rid, etype, label, sig, pattern in DOCUMENT_RULES]
#: The kinds of document that can be a case's latest ruling.
RULING_TYPES = ("opinion", "decision", "judgment")

# --- reading the record ------------------------------------------------------------------------------

_PACKAGE_RE = re.compile(r"USCOURTS-(ca(?:[1-9]|1[0-3])|caDC)-([0-9]{2}-[0-9]{1,6})")
_SITEMAP_ENTRY_RE = re.compile(r"<loc>\s*https://www\.govinfo\.gov/app/details/([^<\s]+)\s*</loc>\s*<lastmod>\s*([^<\s]+)\s*</lastmod>")
_LASTMOD_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z")
_HTML_TAG_RE = re.compile(r"</?(?:a|b|br|i|u|em|strong|strike|span|font|p)\b[^<>]*>", re.I)
#: UTF-8 that was decoded as Latin-1 and encoded again (an apostrophe arrives as three characters, U+00E2 U+0080
#: U+0099): a character in the range of UTF-8 lead bytes followed by one to three in the range of continuation bytes.
_MOJIBAKE_RE = re.compile("[" + chr(0xC2) + "-" + chr(0xF4) + "][" + chr(0x80) + "-" + chr(0xBF) + "]{1,3}")
#: Roles with which a record lists people who are not parties to the appeal.
_NOT_PARTY_ROLES = {"not party", "non-participating", "not applicable"}
_DOCKET_RE = re.compile(r"[0-9]{2}-[0-9]{1,6}")


class RecordError(ValueError):
    """The record is not a GovInfo record of a court of appeals case, or not of the case asked for."""


class ListingError(RuntimeError):
    """A sitemap could not be read as a list of packages."""


def repair_encoding(text: str) -> str:
    """``text`` with characters put back that the record stores as mis-decoded UTF-8.

    Some docket entries reach GovInfo with their UTF-8 bytes read as Latin-1, so that an apostrophe arrives as an
    accented letter followed by two invisible control characters. A run of such characters is turned back only when
    it is valid UTF-8 as a whole; anything else is left exactly as it is.
    """
    def fix(match: re.Match) -> str:
        try:
            return match.group(0).encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return match.group(0)

    return _MOJIBAKE_RE.sub(fix, text)


def clean_record_text(value: Optional[str]) -> str:
    """A field of the record as plain text.

    The records carry a second layer of character references ("&amp;amp;"), HTML tags for line breaks, bold type and
    links, and mis-decoded UTF-8. All three are undone and white space is collapsed. No word is changed.
    """
    text = html.unescape(value or "")
    text = _HTML_TAG_RE.sub(" ", text)
    text = repair_encoding(text)
    return re.sub(r"\s+", " ", text).strip()


def court_of(package: str) -> Circuit:
    match = _PACKAGE_RE.fullmatch(package)
    if not match or match.group(1) not in BY_CODE:
        raise RecordError(f"{package!r} is not a package of a court of appeals")
    return BY_CODE[match.group(1)]


def case_id(package: str) -> str:
    """``ca4-25-01018`` for ``USCOURTS-ca4-25-01018``: the court and the court's own case number."""
    match = _PACKAGE_RE.fullmatch(package)
    if not match:
        raise RecordError(f"{package!r} is not a package of a court of appeals")
    return f"{court_of(package).id}-{match.group(2)}"


def _real_day(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    try:
        _date.fromisoformat(value)
    except ValueError:
        return None
    return value if len(value) == 10 else None


def parse_record(xml_bytes: bytes, package: str) -> dict:
    """One package's metadata record as plain values. Raises :class:`RecordError` for anything else."""
    court = court_of(package)
    if len(xml_bytes) > MAX_RECORD_BYTES:
        raise RecordError(f"the record is {len(xml_bytes)} bytes; at most {MAX_RECORD_BYTES} are read")
    if b"<!DOCTYPE" in xml_bytes[:4096] or b"<!ENTITY" in xml_bytes:
        raise RecordError("the record declares a document type or entities, which a GovInfo record never does")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise RecordError(f"not well-formed XML: {exc}") from exc
    if root.tag != f"{{{MODS['m']}}}mods":
        raise RecordError(f"the document is a <{root.tag}>, not a metadata record")
    extension = next((e for e in root.findall("m:extension", MODS) if e.find("m:courtCode", MODS) is not None), None)
    if extension is None:
        raise RecordError("the record has no court data")
    code = (extension.findtext("m:courtCode", namespaces=MODS) or "").strip()
    number = (extension.findtext("m:caseNumber", namespaces=MODS) or "").strip()
    if f"USCOURTS-{code}-{number}" != package:
        raise RecordError(f"asked for {package}, the record is for court {code!r}, case {number!r}")
    title = clean_record_text(root.findtext("m:titleInfo/m:title", namespaces=MODS))
    if not title:
        raise RecordError("the record has no case title")
    citation = (root.findtext("m:identifier[@type='preferred citation']", namespaces=MODS) or "").split(";")
    docket = citation[-1].strip() if len(citation) == 2 and _DOCKET_RE.fullmatch(citation[-1].strip()) else number
    parties: List[dict] = []
    for party in extension.findall("m:party", MODS):
        name, role = clean_record_text(party.get("fullName")), clean_record_text(party.get("role"))
        if not name or role.lower() in _NOT_PARTY_ROLES:
            continue
        entry = {"name": name, "role": role or None}
        if entry not in parties:
            parties.append(entry)
    documents: List[dict] = []
    for item in root.findall("m:relatedItem[@type='constituent']", MODS):
        granule = (item.get("ID") or "").removeprefix("id-")
        prefix, _, sequence = granule.rpartition("-")
        if prefix != package or not sequence.isdigit():
            raise RecordError(f"document id {granule!r} does not belong to {package}")
        day = _real_day(item.findtext("m:originInfo/m:dateIssued", namespaces=MODS))
        if not day:
            raise RecordError(f"document {granule} has no date")
        stated = (item.findtext("m:extension/m:courtName", namespaces=MODS) or "").strip()
        if stated and stated != court.name:
            raise RecordError(f"document {granule} is of {stated!r}, not of the {court.name}")
        # The address is built from the ids, never taken from the record; the record only has to agree with it.
        address = DOCUMENT_URL.format(package=package, granule=granule)
        given = [(u.text or "").strip() for u in item.findall("m:location/m:url", MODS) if u.get("access") == "raw object"]
        entry_text = clean_record_text(item.findtext("m:extension/m:docketText", namespaces=MODS)
                                       or item.findtext("m:titleInfo/m:subTitle", namespaces=MODS))
        documents.append({"granule": granule, "sequence": int(sequence), "date": day, "text": entry_text,
                          "url": address if address in given else None})
    if not documents:
        raise RecordError("the record lists no documents")
    if len({d["granule"] for d in documents}) != len(documents):
        raise RecordError("the record lists a document twice")
    documents.sort(key=lambda d: (d["date"], d["sequence"]))
    return {
        "package": package, "court": court.id, "caseNumber": number, "docket": docket, "title": title,
        "natureOfSuitCode": clean_record_text(extension.findtext("m:natureSuitCode", namespaces=MODS)) or None,
        "natureOfSuit": clean_record_text(extension.findtext("m:natureSuit", namespaces=MODS)) or None,
        "parties": parties, "documents": documents,
    }


def parse_sitemap(page: str, court: Circuit) -> tuple[Dict[str, str], List[str]]:
    """``({package: time it last changed}, [entries not recognised])`` of one court's sitemap for one year.

    Raises :class:`ListingError` when the page is not a sitemap or an entry has no change time, so that a change of
    layout at the source stops the scan instead of shortening the list.
    """
    if "<urlset" not in page[:2000]:
        raise ListingError("the page is not a sitemap")
    entries = _SITEMAP_ENTRY_RE.findall(page)
    if len(entries) != page.count("<url>"):
        raise ListingError(f"{page.count('<url>')} entries, but only {len(entries)} have an address and a change time in the expected form")
    listed: Dict[str, str] = {}
    unrecognised: List[str] = []
    for package, changed in entries:
        match = _PACKAGE_RE.fullmatch(package)
        if not match or match.group(1) != court.code or not _LASTMOD_RE.fullmatch(changed):
            unrecognised.append(package[:80])
            continue
        # A package listed twice keeps the later time.
        listed[package] = max(changed, listed.get(package, ""))
    return listed, unrecognised


def list_packages(fetcher: Fetcher, court: Circuit, years: Iterable[int]) -> tuple[Dict[str, str], List[str]]:
    """Every package of ``court`` in the sitemaps of ``years``. A year without a sitemap (404) has no packages."""
    listed: Dict[str, str] = {}
    unrecognised: List[str] = []
    for year in years:
        try:
            page = fetcher.get(SITEMAP_URL.format(court=court.code, year=year)).text()
        except FetchError as exc:
            if exc.status == 404:
                continue
            raise
        found, odd = parse_sitemap(page, court)
        for package, changed in found.items():
            listed[package] = max(changed, listed.get(package, ""))
        unrecognised.extend(odd)
    return listed, unrecognised


# --- counting and selecting ---------------------------------------------------------------------------

#: No text test can be met with fewer election words than this, so the phrases of such a document are not counted.
MIN_WORD_MATCHES = int(min(test["wordMatches"] for test in TEXT_TESTS.values()))


def count_text(text: str, *, phrases: bool = True) -> dict:
    """What the selection rule counts in one document.

    Words that the PDF breaks across two lines with a hyphen are joined first (as for the subject tags), and every run
    of white space, line breaks included, becomes one space, so that a phrase split over two lines is still found.
    With ``phrases=False`` only the words are counted: the phrase pattern is slow, and most opinions have no
    election word at all.
    """
    flat = re.sub(r"\s+", " ", classify.join_line_hyphens(text)).strip()
    words = len(flat.split())
    word_matches = sum(1 for _ in WORD_PATTERN.finditer(flat))
    counts: dict = {"words": words, "wordMatches": word_matches, "density": 1000 * word_matches / words if words else 0.0}
    if phrases:
        found = Counter(m.group(0).lower() for m in PHRASE_PATTERN.finditer(flat))
        counts.update(phraseMatches=sum(found.values()), laborMatches=sum(1 for _ in LABOR_PATTERN.finditer(flat)),
                      phrases=sorted(found.items(), key=lambda item: (-item[1], item[0])))
    return counts


def is_labor_document(counts: dict) -> bool:
    return counts["laborMatches"] >= LABOR_MIN_MATCHES and counts["laborMatches"] * LABOR_RATIO >= counts["wordMatches"]


def text_test(counts: dict, authority_party: Optional[str]) -> Optional[str]:
    """The first text test the document meets ("long", "dense" or "party"), or ``None``."""
    if is_labor_document(counts):
        return None
    for name in ("long", "dense"):
        test = TEXT_TESTS[name]
        if (counts["wordMatches"] >= test["wordMatches"] and counts["phraseMatches"] >= test["phraseMatches"]
                and counts["density"] >= test["density"]):
            return name
    if authority_party and counts["wordMatches"] >= TEXT_TESTS["party"]["wordMatches"]:
        return "party"
    return None


def authority_party(record: dict) -> Optional[str]:
    """The case title or the first party whose name is that of an election authority."""
    for name in [record["title"]] + [party["name"] for party in record["parties"]]:
        if AUTHORITY_PATTERN.search(name):
            return name
    return None


def is_cover_letter(text: str) -> bool:
    """True for the clerk's letter that tells counsel an opinion was issued (rule ``cover-letter-1``)."""
    return COVER_LETTER_PATTERN.search(re.sub(r"\s+", " ", text[:COVER_LETTER_WINDOW])) is not None


def evaluate(record: dict, texts: Dict[str, Optional[str]], exclusion: Optional[dict] = None) -> dict:
    """Apply the selection rule to one case.

    ``texts`` maps each document issued since ``SINCE`` to its text, or to ``None`` when the PDF has no text layer.
    The result names the tests met (``tests``), the document they rest on (``document``) with its counts, and the
    outcome: "selected", "excluded" (selected by the rule, but on the published list of exclusions, whose quoted
    passage was found in the opinion) or "". A clerk's cover letter is not counted in.
    """
    recent = [d for d in record["documents"] if d["date"] >= SINCE]
    letters = [d["granule"] for d in recent if texts.get(d["granule"]) and is_cover_letter(texts[d["granule"]])]
    readable = {d["granule"]: texts[d["granule"]] for d in recent if texts.get(d["granule"]) and d["granule"] not in letters}
    counts = {granule: count_text(text, phrases=False) for granule, text in readable.items()}
    result = {
        "documents": len(recent), "coverLetters": letters, "unreadable": len(recent) - len(readable) - len(letters),
        "tests": [], "document": None, "counts": counts, "party": None, "outcome": "", "exclusionProblem": None,
    }
    if not recent:
        return result
    tests: List[str] = []
    if record["natureOfSuitCode"] == VOTING_NATURE_OF_SUIT:
        tests.append("record")
    best: Optional[str] = None
    if record["natureOfSuitCode"] not in OTHER_FIELD_CODES:
        party = authority_party(record)
        met: Dict[str, str] = {}
        for granule in counts:
            if counts[granule]["wordMatches"] >= MIN_WORD_MATCHES:
                counts[granule] = count_text(readable[granule])
                test = text_test(counts[granule], party)
                if test:
                    met[granule] = test
        if met:
            # The document with the most election words; the later one when two have the same number.
            best = max(met, key=lambda g: (counts[g]["wordMatches"], g))
            tests.append(met[best])
            if met[best] == "party":
                result["party"] = party
    if not tests:
        return result
    if best is None and counts:
        best = max(counts, key=lambda g: (counts[g]["wordMatches"], g))
    if best is not None and "phrases" not in counts[best]:
        counts[best] = count_text(readable[best])
    result.update(tests=tests, document=best, outcome="selected")
    if exclusion:
        problems = [evidence.find_passage(exclusion.get("quote"), text) for text in readable.values()]
        if problems and any(problem is None for problem in problems):
            result["outcome"] = "excluded"
        else:
            result["exclusionProblem"] = (problems[0] if problems else "no document of the case could be read")
    return result


# --- building the published record -------------------------------------------------------------------

def classify_document(entry_text: str) -> tuple[str, str, str, str]:
    """``(ruleId, eventType, document type, significance)`` for a document, from the court's entry for it."""
    for rule_id, event_type, label, significance, pattern in _DOCUMENT_RULES:
        if pattern.search(entry_text):
            return rule_id, event_type, label, significance
    return OTHER_DOCUMENT_RULE


def publication_of(entry_text: str) -> Optional[str]:
    """"Unpublished" or "Published" when the court's entry says so, else ``None``."""
    if UNPUBLISHED_PATTERN.search(entry_text):
        return "Unpublished"
    if PUBLISHED_PATTERN.search(entry_text):
        return "Published"
    return None


def _right_column(text: str) -> str:
    """The right-hand column of a caption that the court sets in two columns with ")" between them (the Sixth Circuit
    does): what follows the last ")" on each of the first lines, joined. Empty when the page has no such caption."""
    parts = [line.rpartition(")")[2].strip() for line in text.split("\n")[:ORIGIN_CAPTION_LINES] if ")" in line]
    return " ".join(part for part in parts if part)


def find_origin(text: str, document_url: str) -> Optional[CaseOrigin]:
    """The district court an opinion says the appeal came from, with the opinion's own words.

    Only a line of the form "Appeal from the United States District Court for the ... District of <State>" on the
    opinion's first pages is read, and only when the district is named after a state or territory. Where the caption
    is set in two columns divided by ")" marks, the right-hand column is read as one line. An appeal from an agency, or
    a line worded or laid out differently, gives no origin.
    """
    for flat in (re.sub(r"\s+", " ", text[:ORIGIN_WINDOW]), _right_column(text)):
        for match in ORIGIN_PATTERN.finditer(flat):
            words = match.group(3).split()
            for size in range(min(len(words), 4), 0, -1):
                fips = _DISTRICT_NAMES.get(" ".join(words[:size]).lower())
                if not fips:
                    continue
                place = " ".join(words[:size])
                quote = (flat[match.start():match.start(3)] + place).strip()
                court = flat[match.start(1):match.start(3)] + place
                # Some courts write the line in capitals; the published name uses the usual capital letters.
                if court.isupper():
                    court = re.sub(r"\b(For|The|Of)\b", lambda m: m.group(1).lower(), court.title())
                return CaseOrigin(court=court, stateFips=fips, quote=quote, documentUrl=document_url, ruleId=ORIGIN_RULE_ID)
    return None


def _letters(text: str) -> str:
    return re.sub(r"[^A-Za-z]+", "", text).lower()


def same_opinion_key(text: Optional[str]) -> Optional[str]:
    """What two copies of one opinion have in common: its letters, without digits, punctuation and spacing.

    A court files one opinion in each of the appeals it decides together. The copies differ in the case number printed
    at the head of each page and in nothing else. ``None`` for a document too short to compare.
    """
    letters = _letters(text or "")
    return letters if len(letters) >= SAME_OPINION_MIN_LETTERS else None


#: How many of the phrases the selection rule found a case's entry in the index names.
MATCHED_TERMS = 4


def whole_seconds(changed_at: Optional[str]) -> Optional[str]:
    """GovInfo's change time without its fraction of a second, in the form every other timestamp here has."""
    return re.sub(r"\.[0-9]+Z$", "Z", changed_at) if changed_at else None


def build_case(record: dict, texts: Dict[str, Optional[str]], evaluation: dict, *, checked_at: str, changed_at: Optional[str] = None,
               first_observed: Optional[str] = None, about: Optional[dict] = None) -> LegalCase:
    """One selected case as a published record. ``changed_at`` is the time GovInfo says the package last changed;
    ``about`` is the opening passage of its opinion (:func:`opinion_about`), where one was found."""
    package = record["package"]
    cid = case_id(package)
    source_url = DETAILS_URL.format(package=package)
    counts = evaluation["counts"]
    events: List[LegalEvent] = []
    documents: List[CourtDocument] = []
    ruling: Optional[DispositiveEntry] = None
    publication: Optional[str] = None
    for doc in record["documents"]:
        rule_id, event_type, label, significance = classify_document(doc["text"])
        doc_id = f"{cid}-d{doc['sequence']}"
        note = "Hosted by govinfo.gov; linked, not mirrored."
        if doc["granule"] in evaluation["coverLetters"]:
            note = ("The file GovInfo holds for this entry is the clerk's letter telling counsel that the opinion was issued, not the "
                    "opinion itself. The court publishes its opinions on its own website.")
        elif doc["date"] >= SINCE and doc["granule"] in texts and not texts[doc["granule"]]:
            note += " The file has no text that a program can read."
        documents.append(CourtDocument(
            id=doc_id, caseId=cid, entryIndex=doc["sequence"], title=f"{label} of {doc['date']}", filingDate=doc["date"],
            documentType=label, url=doc["url"], availability="public_link" if doc["url"] else "unavailable",
            accessNote=note if doc["url"] else "GovInfo's record gives no address for this document.",
        ))
        description = doc["text"] or "(The court's record gives no text for this entry.)"
        events.append(LegalEvent(
            id=f"{cid}-e{doc['sequence']}", eventType=event_type, date=doc["date"], entityType="case", entityId=cid,
            description=description, significance=significance, classificationRule=rule_id,
            evidence=EvidenceRef(url=doc["url"] or source_url, sourceId=SOURCE_ID,
                                 document="the document GovInfo holds for this entry of the court's docket"),
            documentIds=[doc_id],
        ))
        if event_type in RULING_TYPES:
            ruling = DispositiveEntry(date=doc["date"], text=description, eventType=event_type, ruleId=rule_id)
            # What the entry of this decision says, and nothing where it does not say: a label carried over from an
            # earlier decision of the case would be shown beside a decision it does not describe.
            publication = publication_of(doc["text"])
    origin: Optional[CaseOrigin] = None
    for doc in reversed(record["documents"]):  # the latest opinion that names the court below
        text = texts.get(doc["granule"])
        if text and doc["url"]:
            origin = find_origin(text, doc["url"])
            if origin:
                break
    best = evaluation["document"]
    best_doc = next((d for d in record["documents"] if d["granule"] == best), None)
    best_counts = counts.get(best) if best else None
    selection = CaseSelection(
        ruleId=SELECTION_RULE_ID, tests=evaluation["tests"],
        natureOfSuitCode=record["natureOfSuitCode"], natureOfSuit=record["natureOfSuit"],
        documentId=f"{cid}-d{best_doc['sequence']}" if best_doc else None,
        documentUrl=best_doc["url"] if best_doc else None,
        wordCount=best_counts["words"] if best_counts else None,
        wordMatches=best_counts["wordMatches"] if best_counts else None,
        phraseMatches=best_counts["phraseMatches"] if best_counts else None,
        density=round(best_counts["density"], 1) if best_counts else None,
        phrases=[TermCount(term=term, count=count) for term, count in (best_counts["phrases"][:8] if best_counts else [])],
        party=evaluation["party"],
    )
    fields: List[tuple] = [("case title", record["title"])]
    if best and texts.get(best):
        fields.append(("full text of the opinion", classify.join_line_hyphens(texts[best]), classify.LONG))
    dates = [e.date for e in events]
    body = dict(
        id=cid,
        externalIds={"govinfoPackage": package},
        caseName=record["title"],
        petitionerTitle="",
        respondentTitle="",
        docketNumber=record["docket"],
        courtId=record["court"],
        jurisdiction="Federal",
        docketType=None,
        dateDocketed=None,
        dateFirstEntry=min(dates),
        sourceLastActivity=max(dates),
        entryCount=len(events),
        documentCount=len(documents),
        issueTags=classify.classify(fields),
        lowerCourt=LowerCourtInfo(),
        latestDispositiveEntry=ruling,
        stateFips=[],
        origin=origin,
        publication=publication,
        natureOfSuit=record["natureOfSuit"],
        about=AboutText(**about) if about else None,
        matchedTerms=selection.phrases[:MATCHED_TERMS],
        sourceUrl=source_url,
        sourceId=SOURCE_ID,
        sourcePublishedAt=whole_seconds(changed_at),
        firstObservedAt=first_observed or checked_at,
        lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.VERIFIED_PRIMARY, method="automated_primary_retrieval", checkedAt=checked_at,
            note="Read from GovInfo's record of the case, which the Government Publishing Office publishes from what the court "
                 "sends it, and schema-validated. Not reviewed by a lawyer.",
        ),
        parties=[CaseParty(**party) for party in record["parties"]],
        selection=selection,
        events=events,
        documents=documents,
    )
    hash_basis = {k: v for k, v in LegalCase(**body, contentHash="").model_dump(mode="json").items()
                  if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash"}}
    return LegalCase(**body, contentHash=content_hash(hash_basis))


def decided_together(cases: List[dict], keys: Dict[str, List[tuple[str, str, str]]]) -> None:
    """Point selected cases of one court at each other when they share an opinion (rule ``same-opinion-1``).

    ``keys`` maps a case id to ``(document id, date, key)`` for each of its documents that is long enough to compare
    (:func:`same_opinion_key`). Two documents of two cases are the same opinion when they are of the same court and
    day and have the same key. Each then lists the other (``sameTextAs``), and so do the two cases (``decidedWith``).
    """
    by_id = {case["id"]: case for case in cases}
    groups: Dict[tuple[str, str, str], List[tuple[str, str]]] = {}
    for cid, found in keys.items():
        if cid not in by_id:
            continue
        for doc_id, day, key in found:
            groups.setdefault((by_id[cid]["courtId"], day, key), []).append((cid, doc_id))
    documents: Dict[str, dict] = {}
    for case in cases:
        case["decidedWith"] = []
        for doc in case["documents"]:
            doc["sameTextAs"] = []
            documents[doc["id"]] = doc
    for members in groups.values():
        for cid, doc_id in members:
            for other, other_doc in members:
                if other == cid:
                    continue
                if other_doc not in documents[doc_id]["sameTextAs"]:
                    documents[doc_id]["sameTextAs"].append(other_doc)
                if not any(entry["caseId"] == other for entry in by_id[cid]["decidedWith"]):
                    by_id[cid]["decidedWith"].append({"caseId": other, "docket": by_id[other]["docketNumber"],
                                                     "caseName": by_id[other]["caseName"]})
    for case in cases:
        case["decidedWith"].sort(key=lambda entry: entry["caseId"])
        for doc in case["documents"]:
            doc["sameTextAs"].sort()


def case_of_document(document_id: str) -> str:
    """The case a document id belongs to (``ca5-25-30725-d2`` -> ``ca5-25-30725``)."""
    return document_id.rsplit("-d", 1)[0]


# --- the scan -----------------------------------------------------------------------------------------

#: Outcomes as the scan state stores them.
NOT_SELECTED, SELECTED, EXCLUDED = 0, 1, 2
OUTCOME_CODES = {"": NOT_SELECTED, "selected": SELECTED, "excluded": EXCLUDED}
STATE_FIELDS = ["lastModified", "documents", "coverLetters", "unreadableDocuments", "outcome"]
#: The scan stops, and the published data stays as it was, when more packages than this could not be read
#: (the larger of the number and the share of the packages read in the run).
MAX_FAILED_PACKAGES = 25
MAX_FAILED_SHARE = 0.02
#: ... or when a court's list is shorter than this share of the list of the previous scan.
MIN_LISTING_SHARE = 0.9


@dataclass
class PackageResult:
    package: str
    changed_at: str
    record: Optional[dict] = None
    texts: Dict[str, Optional[str]] = field(default_factory=dict)
    evaluation: Optional[dict] = None
    error: Optional[str] = None
    #: What ended the reading, kept so that a failed request that may pass later is made again (see ``scan``).
    failure: Optional[BaseException] = None


@dataclass
class ScanResult:
    #: The scan state to publish: every listed package with the time it last changed and what the rule found.
    state: dict
    #: Packages read in this run that the rule selects, or that are on the list of exclusions.
    selected: Dict[str, PackageResult]
    excluded: Dict[str, PackageResult]
    #: Selected or excluded packages that could not be read in this run: their published records stay as they are.
    kept: List[str]
    failed: Dict[str, str]
    #: Selected before, and no longer on GovInfo's list.
    unlisted: List[str]
    unrecognised: List[str]
    listed: int
    read: int
    full: bool


def _stamp(changed_at: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", changed_at)


class Reader:
    """Reads one package: its record and the text of its documents issued since ``SINCE``, with a cache keyed by the
    time GovInfo says the package last changed, so that a changed package is always read again."""

    def __init__(self, fetcher: Fetcher, cache: Path, attempts: Optional[int] = None):
        self.fetcher = fetcher
        self.cache = Path(cache)
        #: How often each request is made at most; a scan makes each once and reads the failed packages again together.
        self.attempts = attempts

    def record(self, package: str, changed_at: str, *, live: bool) -> dict:
        path = self.cache / "records" / f"{package}.{_stamp(changed_at)}.xml"
        if not live and path.exists():
            return parse_record(path.read_bytes(), package)
        result = self.fetcher.get(RECORD_URL.format(package=package), max_bytes=MAX_RECORD_BYTES, attempts=self.attempts)
        record = parse_record(result.content, package)
        write_bytes_atomic(path, result.content, root=self.cache)
        return record

    def text(self, package: str, granule: str, changed_at: str) -> Optional[str]:
        path = self.cache / "text" / f"{granule}.{_stamp(changed_at)}.txt.gz"
        if path.exists():
            return gzip.decompress(path.read_bytes()).decode("utf-8") or None
        result = self.fetcher.get(DOCUMENT_URL.format(package=package, granule=granule), max_bytes=MAX_PDF_BYTES, attempts=self.attempts)
        text = extract_pdf_text(result.content)
        write_bytes_atomic(path, gzip.compress((text or "").encode("utf-8"), mtime=0), root=self.cache)
        return text

    def layout(self, package: str, granule: str, changed_at: str) -> str:
        """Where each piece of text stands on a document's first pages (poppler's XML), cached like its plain text.

        The plain text is taken for every document of every case; the layout only for the opinion of a selected case,
        so the file is fetched once more for those.
        """
        path = self.cache / "layout" / f"{granule}.{_stamp(changed_at)}.xml.gz"
        if path.exists():
            return gzip.decompress(path.read_bytes()).decode("utf-8")
        result = self.fetcher.get(DOCUMENT_URL.format(package=package, granule=granule), max_bytes=MAX_PDF_BYTES, attempts=self.attempts)
        layout = opening.pdf_layout(result.content)
        write_bytes_atomic(path, gzip.compress(layout.encode("utf-8"), mtime=0), root=self.cache)
        return layout

    def read(self, package: str, changed_at: str, *, live: bool, exclusion: Optional[dict]) -> PackageResult:
        result = PackageResult(package=package, changed_at=changed_at)
        try:
            record = self.record(package, changed_at, live=live)
            texts = {doc["granule"]: self.text(package, doc["granule"], changed_at)
                     for doc in record["documents"] if doc["date"] >= SINCE and doc["url"]}
            result.evaluation = evaluate(record, texts, exclusion)
            if result.evaluation["outcome"]:
                result.record, result.texts = record, texts
            else:
                result.evaluation["counts"] = {}  # not needed for a case that is not selected
        except Exception as exc:  # noqa: BLE001 - a damaged cache file or an odd document fails its package, not the scan
            result.error = f"{type(exc).__name__}: {exc}"[:300]
            result.failure = exc
        return result


def opinion_about(reader: Reader, result: PackageResult, earlier: Optional[dict] = None) -> tuple[Optional[dict], Optional[str]]:
    """``(about, problem)`` for a selected case: the opening passage of the opinion the selection rests on.

    ``about`` is None where the case has no opinion a program can read, or where rule ``about-opinion-1`` finds no
    passage it may publish. ``earlier`` is the passage published before. Where the file cannot be laid out in this run,
    it is kept only if it is from the same document and its letters still stand in the document's plain text as this
    run reads it: a court can replace an opinion under the same address. ``problem`` then says what failed.
    """
    granule = result.evaluation["document"]
    doc = next((d for d in result.record["documents"] if d["granule"] == granule), None)
    text = result.texts.get(granule) if granule else None
    if not doc or not doc["url"] or not text or granule in result.evaluation["coverLetters"]:
        return None, None
    try:
        layout = reader.layout(result.package, granule, result.changed_at)
    except Exception as exc:  # noqa: BLE001 - the passage is an addition to the record: the case is published without it
        same = (bool(earlier) and earlier.get("source") == "opinion" and earlier.get("url") == doc["url"]
                and opening.confirmed(earlier.get("text") or "", text))
        outcome = "the passage published before is still in the text of the opinion and is kept" if same else "the case is published without one"
        return (earlier if same else None), f"the opinion could not be laid out for its opening passage ({type(exc).__name__}: {exc}); {outcome}"[:300]
    found = opening.opening_passage(layout, text)
    if not found:
        return None, None
    return about_rules.opinion(found.text, found.cut, url=doc["url"], date=doc["date"], paragraph=found.paragraph), None


def packages_of(state: Optional[dict]) -> Dict[str, list]:
    """``{package: [lastModified, documents, coverLetters, unreadable, outcome]}`` of a published scan state."""
    found: Dict[str, list] = {}
    for court in CIRCUITS:
        for number, entry in ((state or {}).get("packages") or {}).get(court.id, {}).items():
            found[f"USCOURTS-{court.code}-{number}"] = entry
    return found


def scan(fetcher: Fetcher, cache: Path, previous: Optional[dict], exclusions: Dict[str, dict], *, now: str, workers: int = 6,
         progress: Optional[Callable[[int, int], None]] = None) -> ScanResult:
    """List every package, read what is new or changed, and apply the selection rule.

    ``previous`` is the published scan state. When it is missing, or was made with another rule or another starting
    day, every listed package is read. Otherwise a package is read when it is new, when GovInfo gives it another change
    time than before, or when it was selected or excluded before (those are checked on every run).
    """
    usable = bool(previous) and previous.get("ruleId") == SELECTION_RULE_ID and previous.get("since") == SINCE
    before = packages_of(previous) if usable else {}
    years = range(int(SINCE[:4]), int(now[:4]) + 1)
    listing: Dict[str, str] = {}
    unrecognised: List[str] = []
    for court in CIRCUITS:
        listed, odd = list_packages(fetcher, court, years)
        earlier = sum(1 for package in before if court_of(package) is court)
        if earlier and len(listed) < MIN_LISTING_SHARE * earlier:
            raise ListingError(f"GovInfo lists {len(listed)} packages for the {court.short_name}; the previous scan had {earlier}")
        listing.update(listed)
        unrecognised.extend(odd)
    if not listing:
        raise ListingError("GovInfo lists no packages")

    to_read = [package for package in sorted(listing)
               if package not in before or before[package][0] != listing[package] or before[package][4] != NOT_SELECTED
               or package in exclusions]
    reader = Reader(fetcher, cache, attempts=1)
    results: Dict[str, PackageResult] = {}
    count = itertools.count(1)

    def read(package: str) -> Optional[BaseException]:
        known = before.get(package)
        # A case that is, or may become, a published record is read from GovInfo itself; the cache only saves reading
        # again what the scan has already seen in the same state.
        live = bool(known and known[4] != NOT_SELECTED) or package in exclusions
        result = reader.read(package, listing[package], live=live, exclusion=exclusions.get(package))
        first = package not in results
        results[package] = result
        done = next(count) if first else 0
        if progress and first and (done % 500 == 0 or done == len(to_read)):
            progress(done, len(to_read))
        return result.failure

    # Each request is made once; the packages a request failed for are read again together, after one pause for all.
    in_rounds(fetcher, to_read, read, what="court of appeals packages", workers=workers)

    failed = {package: result.error for package, result in results.items() if result.error}
    if len(failed) > max(MAX_FAILED_PACKAGES, MAX_FAILED_SHARE * len(to_read)):
        first = next(iter(failed.items()))
        raise RuntimeError(f"{len(failed)} of {len(to_read)} packages could not be read (first: {first[0]}: {first[1]})")

    packages: Dict[str, Dict[str, list]] = {court.id: {} for court in CIRCUITS}
    selected: Dict[str, PackageResult] = {}
    excluded: Dict[str, PackageResult] = {}
    kept: List[str] = []
    for package in sorted(listing):
        court, number = court_of(package), _PACKAGE_RE.fullmatch(package).group(2)
        result = results.get(package)
        if result is None or result.error:
            # Not read in this run, or not readable: what the previous scan found stands, with the change time it was
            # found at, so that a package that failed is read again on the next run.
            if package in before:
                packages[court.id][number] = before[package]
                if result is not None and before[package][4] != NOT_SELECTED:
                    kept.append(package)
            continue
        evaluation = result.evaluation
        packages[court.id][number] = [listing[package], evaluation["documents"], len(evaluation["coverLetters"]),
                                      evaluation["unreadable"], OUTCOME_CODES[evaluation["outcome"]]]
        if evaluation["outcome"] == "selected":
            selected[package] = result
        elif evaluation["outcome"] == "excluded":
            excluded[package] = result
    unlisted = sorted(package for package, entry in before.items() if package not in listing and entry[4] == SELECTED)
    state = {
        "ruleId": SELECTION_RULE_ID, "since": SINCE, "scannedAt": now, "fields": STATE_FIELDS,
        "outcomes": {"0": "not selected", "1": "selected", "2": "selected by the rule, but on the published list of exclusions"},
        "packages": packages,
    }
    return ScanResult(state=state, selected=selected, excluded=excluded, kept=sorted(kept), failed=failed, unlisted=unlisted,
                      unrecognised=unrecognised, listed=len(listing), read=len(to_read), full=not usable)


def coverage(state: dict) -> Dict[str, dict]:
    """For each court: how many cases GovInfo lists, how many documents were read and what the rule made of them."""
    table: Dict[str, dict] = {}
    for court in CIRCUITS:
        entries = list((state.get("packages") or {}).get(court.id, {}).values())
        table[court.id] = {
            "cases": len(entries),
            "documents": sum(entry[1] for entry in entries),
            "coverLetters": sum(entry[2] for entry in entries),
            "unreadableDocuments": sum(entry[3] for entry in entries),
            "selected": sum(1 for entry in entries if entry[4] == SELECTED),
            "excluded": sum(1 for entry in entries if entry[4] == EXCLUDED),
        }
    return table


def selection_document() -> dict:
    """The selection rule as published with the data, so that every number shown beside a case can be checked."""
    return {
        "ruleId": SELECTION_RULE_ID, "since": SINCE, "votingNatureOfSuit": VOTING_NATURE_OF_SUIT,
        "coverLetterRuleId": COVER_LETTER_RULE_ID, "coverLetterPattern": COVER_LETTER_PATTERN.pattern,
        "wordPattern": WORD_PATTERN.pattern, "phrasePattern": PHRASE_PATTERN.pattern,
        "authorityPattern": AUTHORITY_PATTERN.pattern, "laborPattern": LABOR_PATTERN.pattern,
        "textTests": TEXT_TESTS, "laborMinMatches": LABOR_MIN_MATCHES, "laborRatio": LABOR_RATIO,
        "otherFieldCodes": OTHER_FIELD_CODES,
    }
