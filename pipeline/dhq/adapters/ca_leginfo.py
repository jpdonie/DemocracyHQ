"""California Legislative Information - official bulk data.

Source: ``https://downloads.leginfo.legislature.ca.gov/pubinfo_<year>.zip``
(Legislative Counsel, published under Cal. Gov. Code § 10248). The public web
site ``leginfo.legislature.ca.gov`` sits behind a bot challenge, so nothing is
scraped from it; it is only linked.

The archive is ~1.3 GB. Tables are read as whole members; bill-version XML
(``.lob``) is fetched one member at a time with ranged requests.
"""

from __future__ import annotations

import difflib
import logging
import re
import xml.etree.ElementTree as ET
import zlib
from collections import defaultdict
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from ..http import Fetcher
from ..remotezip import RemoteZip
from ..schemas import (
    AffectedStatute,
    Chapter,
    DiffMeta,
    EffectiveInfo,
    ExpiryClause,
    TextCondition,
    LawVersion,
    LegislativeAction,
    LegislativeInstrument,
    LegislativeStatus,
    Verification,
    VerificationStatus,
)
from ..util import content_hash, http_date_to_iso, sha256_bytes, sha256_text, write_bytes_atomic

log = logging.getLogger("dhq.ca_leginfo")

SOURCE_ID = "ca-leginfo-bulk"
ARCHIVE_URL = "https://downloads.leginfo.legislature.ca.gov/pubinfo_{year}.zip"
BILL_URL = "https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id={bill_id}"
VERSION_URL = "https://leginfo.legislature.ca.gov/faces/billVersionsCompareClient.xhtml?bill_id={bill_id}&cversion={version_id}"

CAML = "{http://lc.ca.gov/legalservices/schemas/caml.1#}"
XHTML = "{http://www.w3.org/1999/xhtml}"

# Transparent selection rule (id ``ca-select-2``): a measure of the regular
# session is in scope when the official "subject" line of its latest version
# matches SELECTION_PATTERN after the phrases in EXCLUSION_PATTERN have been
# removed from it.
#
# Rule 1 matched the bare words "initiative", "recall" and "election", which
# brought in the Marine Carbon Initiative, a cannabis product recall, "recall and
# resentencing" in the Penal Code and a tax "water's-edge election", and it had no
# term for campaign finance or candidates. Rule 2 only accepts "initiative" and
# "recall" in an electoral sense, adds campaign finance, the Political Reform Act
# and candidacy, and leaves out the Act's ethics and lobbying provisions by name.
SELECTION_RULE_ID = "ca-select-2"
SELECTION_PATTERN = re.compile(
    r"\b(elections?|voters?|voting|vote by mail|ballots?|redistricting|referendum|referenda|congressional districts?|electors?)\b"
    r"|\brecall (elections?|petitions?)\b|\brecalls? of .{0,40}?offic(ers?|ials?)\b"
    r"|\binitiatives? (and|or) referend(um|a)\b|\b(statewide|local|voter|ballot|citizens?) initiatives?\b"
    r"|\binitiative (measures?|petitions?|statutes?|constitutional amendments?)\b|(^|: )initiatives?\b"
    r"|\bpolitical reform act\b|\bfair political practices\b|\bcampaign (statements?|contributions?|funds?|finance|financing|disclosures?|committees?|advertis\w+|expenditures?)\b"
    r"|\bpolitical (advertis\w+|part(y|ies)|committees?|contributions?)\b|\bcandidates?\b|\belective offices?\b|\bnonpartisan offices?\b|\bwrite-in\b",
    re.I,
)
EXCLUSION_PATTERN = re.compile(
    r"water['\u2019]s-edge election"
    r"|political reform act of 1974: (lobby\w*|prospective employment|travel expenditures|prediction market contracts|gifts?|conflicts? of interest|statements? of economic interests?)[^:]*",
    re.I,
)
#: Only the regular session. Extraordinary-session measures share the bill table but not the session.
REGULAR_SESSION_NUM = "0"


def selection_match(subject: str) -> Optional[str]:
    """The words of ``subject`` that bring a bill into scope, or ``None``."""
    match = SELECTION_PATTERN.search(EXCLUSION_PATTERN.sub(" ", subject or ""))
    return match.group(0).lstrip(": ") if match else None


MEASURE_NAMES = {
    "AB": "Assembly Bill", "SB": "Senate Bill", "ACA": "Assembly Constitutional Amendment",
    "SCA": "Senate Constitutional Amendment", "ACR": "Assembly Concurrent Resolution",
    "SCR": "Senate Concurrent Resolution", "AJR": "Assembly Joint Resolution", "SJR": "Senate Joint Resolution",
    "HR": "House Resolution", "SR": "Senate Resolution",
}

ACTION_RULES: list[tuple[str, str, str, str]] = [
    # (ruleId, eventType, significance, pattern) - first match wins
    ("ca-chaptered", "chaptered", "major", r"^Chaptered by Secretary of State"),
    ("ca-approved", "approved_by_governor", "major", r"^Approved by the Governor"),
    ("ca-vetoed", "vetoed", "major", r"^Vetoed by (the )?Governor"),
    ("ca-veto-stands", "veto_stands", "major", r"^Veto sustained|^Consideration of Governor's veto stricken from file"),
    ("ca-enrolled", "enrolled", "major", r"^Enrolled and (presented to the Governor|filed with the Secretary of State)"),
    ("ca-rescinded", "action_rescinded", "major", r"^Action rescinded"),
    ("ca-vote-failed", "vote_failed", "major", r"refused to concur|Refused passage|[Ff]ailed passage"),
    ("ca-concurred", "concurred", "major", r"(Senate|Assembly) amendments concurred in"),
    ("ca-passed", "passed_house", "major",
     r"Read third time(, amended)?\. .*Passed\.|^Read third time\. Passed|Urgency clause adopted\. Passed|^Read third time\. Adopted"
     r"|^Read\. Adopted|Adopted\. .*Ordered to the (Senate|Assembly)|^Adopted and to (Senate|Assembly)"),
    ("ca-introduced", "introduced", "major", r"^Introduced\.|^Read first time\. To print|^Introduced\. (Read first time|To Com)"),
    # The Assembly records a bill's death under Cal. Const. art. IV, § 10(c) itself ("Died pursuant to Art. IV, Sec. 10(c)")
    # and then files it with the Chief Clerk under Joint Rule 56: that filing is clerical, not a second death, and falls
    # to ca-committee. The Senate records no separate death entry; its "Returned to Secretary of Senate pursuant to
    # Joint Rule 56" is the only entry that records the death, so it stays here.
    ("ca-died", "died", "major",
     r"^Died |^Died on|^From committee without further action|^From committee: Without further action|Died on (the )?(inactive |third reading )?file"
     r"|^Returned to Secretary of Senate pursuant to Joint Rule"
     r"|^From (Assembly|Senate) without further action|Art\. IV, Sec\. 10\(c\)"),
    ("ca-amended", "amended", "routine", r"amended|Amended|author's amendments"),
    ("ca-committee", "committee_action", "routine", r"^From committee|^Referred to|^Re-referred|^In committee|hearing|Withdrawn from committee"),
]
#: Measure types that are resolutions, not statutes.
RESOLUTION_TYPES = {"ACR", "SCR", "AJR", "SJR", "HR", "SR"}
CONSTITUTIONAL_TYPES = {"ACA", "SCA"}

#: Rule ``ca-cond-1``: a sentence in which the measure makes itself, or part of itself, conditional.
CONDITION_RULE_ID = "ca-cond-1"
CONDITION_PATTERN = re.compile(
    r"\b(This|That) (act|bill|chapter|section|article|part|division|title|subdivision|paragraph|subparagraph)\b[^.;]{0,80}?"
    r"\bshall (become (operative|effective)|take effect|be operative) only (if|when|upon|after)\b"
    r"|\bSections? (?:[^.;]|\.(?=\d)){0,60}? of this (act|bill),? shall (become (operative|effective)|take effect) only (if|when|upon|after)\b"
)


def conditions_in(blocks: List[List[str]]) -> List[str]:
    """Sentences of a version's text in which the measure makes all or part of itself conditional."""
    found: List[str] = []
    for _kind, text in blocks:
        if CONDITION_PATTERN.search(text) and text not in found:
            found.append(text)
    return found


#: Rule ``ca-sunset-1``: a sentence in which the measure says that it, or a named part of it, remains in effect (only)
#: until a date or an event and is then repealed. The date is recorded when the sentence states one.
SUNSET_RULE_ID = "ca-sunset-1"
SUNSET_PATTERN = re.compile(
    r"(\b(This|That) (act|bill|chapter|section|article|part|division|title|subdivision|paragraph|subparagraph)\b"
    r"|\bSections? (?:[^.;]|\.(?=\d)){0,60}? of this (act|bill)\b)[^.;]{0,80}?"
    r"\bshall remain in effect (only )?until (?P<until>(?:(?!\. [A-Z(])[^;]){1,300}?),? and,? as of (that|such) date,? (is|are) repealed"
)
_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
_STATED_DATE_RE = re.compile(r"(" + "|".join(_MONTHS) + r") (\d{1,2}), (\d{4})")


def long_date(iso: str) -> str:
    """``2026-01-22`` as ``January 22, 2026``, the way the site writes dates in sentences; anything else unchanged."""
    try:
        day = datetime.strptime(iso, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return iso
    return f"{_MONTHS[day.month - 1]} {day.day}, {day.year}"


def expiry_clauses_in(blocks: List[List[str]]) -> List[tuple[str, Optional[str]]]:
    """``(sentence, date)`` for each sentence of a version's text that matches rule ``ca-sunset-1``.

    The sentence is quoted from its subject ("This section", "This chapter") to its full stop. ``date`` is the date
    as ``YYYY-MM-DD`` when the sentence gives one as the end of the period, and ``None`` when it names an event (for
    example the effective date of another measure). A sentence repeated in several sections is listed once.
    """
    found: List[tuple[str, Optional[str]]] = []
    for _kind, text in blocks:
        for match in SUNSET_PATTERN.finditer(text):
            end = match.end()
            stop = re.compile(r"\.(?!\d)").search(text, end)  # the rest of the sentence ("unless a later enacted statute ...")
            sentence = text[match.start():stop.end() if stop else len(text)].strip()
            stated = _STATED_DATE_RE.fullmatch(match.group("until").strip())
            date = None
            if stated:
                try:
                    date = datetime.strptime(stated.group(0), "%B %d, %Y").date().isoformat()
                except ValueError:
                    date = None  # a date that does not exist is quoted, not converted
            if (sentence, date) not in found:
                found.append((sentence, date))
    return found


_ACTION_COMPILED = [(rid, et, sig, re.compile(pat)) for rid, et, sig, pat in ACTION_RULES]


# --- table parsing --------------------------------------------------------------

def parse_table(text: str) -> List[List[Optional[str]]]:
    """Parse a ``.dat`` export (tab separated, backtick quoted, ``NULL``).

    Quoted fields may contain newlines, so physical lines are joined until the
    backtick count is even.
    """
    rows: List[List[Optional[str]]] = []
    pending = ""
    for line in text.split("\n"):
        candidate = f"{pending}\n{line}" if pending else line
        if candidate.count("`") % 2 == 1:
            pending = candidate
            continue
        pending = ""
        if not candidate.strip():
            continue
        fields: List[Optional[str]] = []
        for cell in candidate.split("\t"):
            if cell == "NULL":
                fields.append(None)
            elif len(cell) >= 2 and cell[0] == "`" and cell[-1] == "`":
                fields.append(cell[1:-1])
            else:
                fields.append(cell)
        rows.append(fields)
    return rows


def classify_action(text: str) -> tuple[str, str, str]:
    for rid, event_type, significance, pattern in _ACTION_COMPILED:
        if pattern.search(text):
            return rid, event_type, significance
    return "ca-other", "legislative_action", "routine"


# --- bill XML -------------------------------------------------------------------

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


#: Empty ``<span class="...">`` elements the legislature uses for spacing and for the
#: blank lines of printed forms.
_SPACERS = {"EnSpace": " ", "EmSpace": " ", "ThinSpace": " ", "UnderlinedLeaders": " ______ ", "SpacedLeaders": " . . . . . "}


def _pieces(el: ET.Element, out: List[str]) -> None:
    """Append the text of ``el`` to ``out``, keeping what plain concatenation loses.

    Joining the text nodes runs a fraction's numerator and denominator together
    ("1 1/2 percent" became "112 percent", a "2/3 vote" became a "23 vote") and
    drops the spacing elements, so "(a) (1) If" became "(a)(1)If".
    """
    tag = _local(el.tag)
    if tag == "Fraction":
        numerator, denominator = _text(el.find(f"{CAML}Numerator")), _text(el.find(f"{CAML}Denominator"))
        if not numerator or not denominator:
            raise ValueError("fraction without a numerator and a denominator")
        whole_number_before = bool(out) and out[-1][-1:].isdigit()
        out.append(f"{' ' if whole_number_before else ''}{numerator}/{denominator}")
        return
    if tag == "br":
        out.append(" ")
        return
    if tag == "span" and len(el) == 0 and not (el.text or "").strip():
        out.append(_SPACERS.get(el.get("class") or "", " "))
        return
    if el.text:
        out.append(el.text)
    for child in el:
        _pieces(child, out)
        if child.tail:
            out.append(child.tail)


def _text(el: Optional[ET.Element]) -> str:
    if el is None:
        return ""
    out: List[str] = []
    _pieces(el, out)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def parse_bill_xml(xml_bytes: bytes) -> dict:
    """Extract clean text from one CAML bill version.

    Deleted text lives only inside ``<?xm-deletion_mark?>`` processing
    instructions, which the parser drops; inserted text is ordinary content.
    The result is therefore the text of *this* version, not a redline.
    """
    head = xml_bytes[:4096].decode("utf-8", errors="replace")
    if "<!DOCTYPE" in head or "<!ENTITY" in head:
        raise ValueError("refusing XML with a DTD/entity declaration")
    root = ET.fromstring(xml_bytes)
    desc = root.find(f"{CAML}Description")
    # Bills use <caml:Bill>; resolutions and constitutional amendments use other
    # containers, so take the first top-level element that is not the description.
    bill = next((child for child in root if _local(child.tag) != "Description"), None)
    blocks: List[List[str]] = []

    def emit(kind: str, text: str) -> None:
        if text:
            blocks.append([kind, text])

    def walk(el: ET.Element) -> None:
        tag = _local(el.tag)
        if tag == "p":
            emit("p", _text(el))
        elif tag == "table":
            for row in el.iter(f"{XHTML}tr"):
                cells = [_text(c) for c in row if _local(c.tag) in ("td", "th")]
                emit("p", " | ".join(c for c in cells if c))
        elif tag == "BillSection":
            emit("s", _text(el.find(f"{CAML}Num")))
            emit("a", _text(el.find(f"{CAML}ActionLine")))
            for child in el:
                if _local(child.tag) not in ("Num", "ActionLine"):
                    walk(child)
        elif tag == "LawHeading":
            label = (el.get("type") or "").title()
            num = _text(el.find(f"{CAML}Num"))
            title = _text(el.find(f"{CAML}LawHeadingVersion/{CAML}LawHeadingText"))
            emit("h", " ".join(x for x in (label, num, title) if x))
            for child in el:
                if _local(child.tag) not in ("Num", "LawHeadingVersion"):
                    walk(child)
        elif tag == "LawSection":
            emit("s", _text(el.find(f"{CAML}Num")))
            for child in el:
                if _local(child.tag) != "Num":
                    walk(child)
        elif tag in ("Preamble", "Resolved", "Whereas"):
            if any(_local(c.tag) == "p" for c in el.iter()):
                for child in el:
                    walk(child)
            else:
                emit("p", _text(el))
        else:
            children = list(el)
            if children:
                if el.text and el.text.strip() and tag not in ("Bill", "Fragment", "Content", "LawSectionVersion"):
                    emit("p", re.sub(r"\s+", " ", el.text).strip())
                for child in children:
                    walk(child)
            else:
                emit("p", _text(el))

    if bill is not None:
        walk(bill)

    def d(path: str) -> str:
        return _text(desc.find(path)) if desc is not None else ""

    statutes = []
    if bill is not None:
        for line in bill.iter(f"{CAML}ActionLine"):
            href = line.get("{http://www.w3.org/1999/xlink}href") or ""
            code = re.search(r"urn:caml:codes:([A-Z]+):", href)
            statutes.append({"action": line.get("action") or "", "code": code.group(1) if code else None, "text": _text(line)})
    indicators = {}
    if desc is not None:
        for el in desc.iter():
            tag = _local(el.tag)
            if tag in ("VoteRequired", "Appropriation", "FiscalCommittee", "LocalProgram", "ImmediateEffect", "Urgency", "TaxLevy", "Election", "UsualCurrentExpenses", "BudgetBill"):
                indicators[tag] = _text(el)
    digest = []
    if desc is not None:
        digest_el = desc.find(f"{CAML}DigestText")
        if digest_el is not None:
            digest = [t for t in (_text(p) for p in digest_el.iter(f"{XHTML}p")) if t]
    authors = [_text(a) for a in desc.findall(f"{CAML}AuthorText")] if desc is not None else []
    return {
        "id": d(f"{CAML}Id"),
        "title": d(f"{CAML}Title"),
        "relatingClause": d(f"{CAML}RelatingClause"),
        "subject": d(f"{CAML}GeneralSubject/{CAML}Subject"),
        "authors": "; ".join(a for a in authors if a),
        "digest": digest,
        "blocks": blocks,
        "statutes": statutes,
        "indicators": indicators,
    }


def caml_version_id(raw: str) -> str:
    """The id a CAML document gives itself, written the way BILL_VERSION_TBL writes version ids.

    The XML pads the measure type with underscores and the measure number with zeros
    (``20250SB__097099INT``); the table does not (``20250SB97099INT``).
    """
    return re.sub(r"^(\d{5}[A-Z]+)0+(?=\d)", r"\1", raw.strip().replace("_", ""))


class VersionTextError(ValueError):
    """A version's text member is listed but could not be read, parsed or matched to the version."""


def diff_meta(previous_id: str, previous: List[str], current: List[str]) -> DiffMeta:
    matcher = difflib.SequenceMatcher(a=previous, b=current, autojunk=False)
    unchanged = sum(block.size for block in matcher.get_matching_blocks())
    return DiffMeta(
        previousVersionId=previous_id,
        blocksAdded=len(current) - unchanged,
        blocksRemoved=len(previous) - unchanged,
        blocksUnchanged=unchanged,
        similarity=round((2 * unchanged / (len(previous) + len(current))) if (previous or current) else 1.0, 4),
    )


# --- adapter --------------------------------------------------------------------

class CaliforniaArchive:
    """One ``pubinfo_<year>.zip`` session archive."""

    def __init__(self, fetcher: Fetcher, year: int, cache: Optional[Path] = None):
        self.year = year
        self.url = ARCHIVE_URL.format(year=year)
        self.rz = RemoteZip(self.url, fetcher)
        self.cache = cache
        self.archive_modified = http_date_to_iso(self.rz.last_modified)

    def table(self, name: str) -> List[List[Optional[str]]]:
        """One ``.dat`` table. A cached copy is kept per archive date and used only when it has the size and
        CRC that this archive's central directory gives for the member; without a date nothing is cached.

        Once a table of this archive has been read, the cached tables of other archive dates are deleted: they are
        never read again, and each date's tables are about 24 MB, so keeping them would grow the cache every day."""
        info = self.rz.zip.getinfo(name)
        stamp = (self.archive_modified or "").replace(":", "")
        cached = self.cache / f"{name}.{stamp}.dat" if self.cache and stamp else None
        data: Optional[bytes] = None
        if cached and cached.exists():
            data = cached.read_bytes()
            if len(data) != info.file_size or zlib.crc32(data) & 0xFFFFFFFF != info.CRC:
                log.warning("cached %s does not match the archive's directory; reading it again", cached.name)
                data = None
        if data is None:
            data = self.rz.read(name)
            if cached:
                # The member name comes from the archive, so the write must stay inside the cache folder.
                write_bytes_atomic(cached, data, root=self.cache)
        rows = parse_table(data.decode("utf-8", errors="replace"))
        if cached:
            self._prune_tables(stamp)
        return rows

    def _prune_tables(self, stamp: str) -> None:
        """Delete the cached tables that do not belong to the archive date ``stamp``.

        Every table of one archive carries the same date, so this removes only tables of earlier (or other) archive
        dates, and copies left by versions of this adapter that cached tables without a date. The bill-version
        texts under ``lob/`` are kept: they are cached by version id and stay valid across archive dates."""
        if not self.cache or not self.cache.is_dir():
            return
        for path in self.cache.glob("*.dat"):
            if path.is_file() and not path.name.endswith(f".{stamp}.dat"):
                try:
                    path.unlink()
                    log.info("removed %s, a cached table of another archive date", path.name)
                except OSError as exc:  # a cache that cannot be tidied is not a reason to fail the stage
                    log.warning("could not remove the superseded cached table %s: %s", path.name, exc)

    def lob(self, member: str, version_id: str) -> bytes:
        """The XML of one bill version.

        A member is named after its row's position in one particular export
        (``BILL_VERSION_TBL_<n>.lob``), and a re-export that inserts a row renumbers
        every later member. The cache is therefore keyed by version id, and a cached
        copy is used only when it has the size and CRC that this archive's central
        directory gives for the member.
        """
        if not re.fullmatch(r"[0-9A-Za-z_]+", version_id or ""):
            raise VersionTextError(f"unexpected version id {version_id!r}")
        info = self.rz.zip.getinfo(member)
        cached = self.cache / "lob" / "by-version" / f"{version_id}.xml" if self.cache else None
        if cached and cached.exists():
            data = cached.read_bytes()
            if len(data) == info.file_size and zlib.crc32(data) & 0xFFFFFFFF == info.CRC:
                return data
        data = self.rz.member_bytes(member)
        if cached:
            write_bytes_atomic(cached, data, root=self.cache)
        return data


#: Every California bill id has this shape (``ca-20252026-ab604``). The id is built from three BILL_TBL columns and
#: names the bill's published file, so a row whose parts do not have this shape is refused, never written.
#: The same pattern is on the id in the pydantic and zod schemas.
BILL_ID_PATTERN = r"^ca-[0-9]{8}-[a-z]{2,3}[0-9]{1,5}$"
_ID_PARTS = (("session year", 1, re.compile(r"[0-9]{8}")), ("measure type", 3, re.compile(r"[A-Z]{2,3}")),
             ("measure number", 4, re.compile(r"[0-9]{1,5}")))


class BillIdError(ValueError):
    """A BILL_TBL row whose session year, measure type or measure number does not have the expected shape."""


def instrument_id(bill: List[Optional[str]]) -> str:
    """The published id of a BILL_TBL row, after checking each part it is built from.

    Raises :class:`BillIdError` for a row whose session year is not eight digits, whose measure type is not two or
    three capital letters, or whose measure number is not one to five digits.
    """
    problems = [f"{name} {(bill[column] if len(bill) > column else None)!r:.60}" for name, column, pattern in _ID_PARTS
                if not pattern.fullmatch((bill[column] if len(bill) > column else None) or "")]
    if problems:
        raise BillIdError(f"bill table row {(bill[0] if bill else None)!r:.60} has an unexpected {', '.join(problems)}; "
                          "no id or file is made from it")
    value = f"ca-{bill[1]}-{bill[3]}{bill[4]}".lower()
    if not re.fullmatch(BILL_ID_PATTERN, value):  # cannot happen after the checks above; kept as the last guard
        raise BillIdError(f"bill id {value!r:.80} does not have the expected shape")
    return value


def regular_session_count(bills: Iterable[List[Optional[str]]]) -> int:
    """How many measures of the regular session the bill table lists: the pool the selection rule is applied to.
    Extraordinary-session measures share the table and are left out, as they are by :func:`select_bills`."""
    return sum(1 for bill in bills if (bill[2] or REGULAR_SESSION_NUM) == REGULAR_SESSION_NUM)


def session_label(session_year: str) -> str:
    return f"{session_year[:4]}-{session_year[4:]} Regular Session"


def select_bills(bills: Iterable[List[Optional[str]]], versions: Iterable[List[Optional[str]]]) -> Dict[str, dict]:
    """Apply the selection rule; return ``bill_id -> {bill, versions, matched}``."""
    by_bill: Dict[str, List[List[Optional[str]]]] = defaultdict(list)
    for v in versions:
        if (v[15] or "Y") == "Y":
            by_bill[v[1]].append(v)
    selected: Dict[str, dict] = {}
    for bill in bills:
        bill_id = bill[0]
        vs = sorted(by_bill.get(bill_id, []), key=lambda v: -int(v[2]))  # 99 = introduced
        if not vs or (bill[11] or "Y") != "Y" or (bill[2] or REGULAR_SESSION_NUM) != REGULAR_SESSION_NUM:
            continue
        latest_subject = vs[-1][6] or ""
        matched = selection_match(latest_subject)
        if matched:
            selected[bill_id] = {"bill": bill, "versions": vs, "matched": matched, "subject": latest_subject}
    return selected


def effective_info(measure_type: str, current_status: str, chaptered: Optional[str], vetoed: Optional[str],
                   chapter_type: Optional[str], indicators: Dict[str, str], conditions: List[str],
                   veto_stands: Optional[str] = None) -> EffectiveInfo:
    """What can be said about when a measure takes effect, from the official data alone.

    ``veto_stands`` is the date of a history entry recording that a veto stands (rule ``ca-veto-stands``), if any.
    """
    conditional = (" The text also makes all or part of the measure conditional; the conditions are quoted on this page, "
                   "and whether they were met is not recorded here.") if conditions else ""
    if measure_type in RESOLUTION_TYPES:
        state = "was adopted and filed with the Secretary of State" if chaptered else "has not been adopted by both houses"
        return EffectiveInfo(date=None, basis="not_applicable",
                             note=f"A resolution states a position or makes a request; it is not a statute and has no effective date. This one {state}.")
    if measure_type in CONSTITUTIONAL_TYPES:
        if chaptered:
            return EffectiveInfo(date=None, basis="not_verified",
                                 note="Adopted by both houses and filed with the Secretary of State. A constitutional amendment proposed by the "
                                      "Legislature takes effect only if the voters approve it (Cal. Const. art. XVIII). Ballot results are not a "
                                      "data field here; where a linked court record mentions the result, it is quoted on this page with its "
                                      "source." + conditional)
        return EffectiveInfo(date=None, basis="not_enacted",
                             note=f"Not adopted by both houses (official status: {current_status or 'not given'}). It would also need the voters' approval.")
    if vetoed and not chaptered:
        if veto_stands:
            return EffectiveInfo(date=None, basis="not_enacted",
                                 note=f"Vetoed by the Governor. The official history records on {long_date(veto_stands)}, that the veto "
                                      "stands, so the bill was not enacted. It has no effective date.")
        # The Legislature may still override the veto (two-thirds of each house) until the session ends.
        return EffectiveInfo(date=None, basis="not_enacted",
                             note="Vetoed by the Governor. A vetoed bill is not enacted unless the Legislature overrides the veto "
                                  "(Cal. Const. art. IV, § 10(a)); no override is recorded in the data as of the last check. "
                                  "It has no effective date.")
    if not chaptered:
        if current_status in ("Died", "Failed", "Failed Passage in Committee"):
            return EffectiveInfo(date=None, basis="not_enacted", note=f"Not enacted. The official status is \"{current_status}\".")
        return EffectiveInfo(date=None, basis="not_enacted",
                             note=f"Not enacted as of the date of the data (official status: {current_status or 'not given'}). It has no effective date.")
    if indicators.get("ImmediateEffect") == "YES":
        return EffectiveInfo(date=chaptered, basis="immediate_effect_flag",
                             note="The official bill data flags this measure as taking immediate effect. The date shown is the day it was "
                                  "chaptered by the Secretary of State; individual provisions may state other operative dates." + conditional)
    return EffectiveInfo(date=None, basis="not_verified",
                         note="No effective date is recorded in the official bill data and DemocracyHQ has not verified one. A "
                              "non-urgency statute enacted in a regular session generally takes effect on January 1 after a 90-day "
                              "period (Cal. Const. art. IV, § 8(c)), but a bill may state other operative dates." + conditional)


def build_instrument(archive: CaliforniaArchive, entry: dict, history: List[List[Optional[str]]], *,
                     checked_at: str, first_observed: Optional[str] = None,
                     workers: int = 6) -> tuple[LegislativeInstrument, Dict[str, dict]]:
    # BILL_TBL columns, as in the Legislature's own table definition: 0 bill_id, 1 session_year, 2 session_num,
    # 3 measure_type, 4 measure_num, 5 measure_state, 6 chapter_year, 7 chapter_type, 8 chapter_session_num,
    # 9 chapter_num, 10 latest_bill_version_id, 11 active_flg, 12 trans_uid, 13 trans_update, 14 current_location,
    # 15 current_secondary_loc, 16 current_house, 17 current_status, 18 days_31st_in_print.
    bill = entry["bill"]
    bill_id = bill[0]
    measure_type, measure_num = bill[3], bill[4]
    bill_key = instrument_id(bill)
    official_url = BILL_URL.format(bill_id=bill_id)

    # A version without a text member is link-only. A member that is listed but cannot be read,
    # parsed or matched to its version fails the whole bill, so its last verified record is kept
    # instead of being republished with that version's text missing.
    def load(v: List[Optional[str]]) -> tuple[List[Optional[str]], Optional[bytes]]:
        try:
            data = archive.lob(v[14], v[0]) if v[14] else None
        except Exception as exc:  # noqa: BLE001
            raise VersionTextError(f"text of version {v[0]} ({v[14]}) could not be read: {exc}") from exc
        if data is not None and not data:
            raise VersionTextError(f"text of version {v[0]} ({v[14]}) could not be read: the member is empty")
        return v, data

    with ThreadPoolExecutor(max_workers=workers) as pool:
        loaded = list(pool.map(load, entry["versions"]))

    versions: List[LawVersion] = []
    texts: Dict[str, dict] = {}
    previous: Optional[tuple[str, List[str]]] = None
    latest_parsed: Optional[dict] = None
    for v, xml_bytes in loaded:
        version_id = v[0]
        parsed = None
        if xml_bytes is not None:
            try:
                parsed = parse_bill_xml(xml_bytes)
            except Exception as exc:  # noqa: BLE001
                raise VersionTextError(f"text of version {version_id} ({v[14]}) could not be parsed: {exc}") from exc
            if caml_version_id(parsed["id"]) != version_id:
                raise VersionTextError(f"text member {v[14]} for version {version_id} identifies itself as {parsed['id'] or 'nothing'!r}")
        common = dict(
            id=version_id, instrumentId=bill_key, label=v[4] or "Version",
            versionDate=(v[3] or "")[:10], versionNum=int(v[2]), subject=v[6],
            officialUrl=VERSION_URL.format(bill_id=bill_id, version_id=version_id), sourceMember=v[14],
        )
        if parsed and parsed["blocks"]:
            block_texts = [b[1] for b in parsed["blocks"]]
            text_hash = sha256_text("\n".join(block_texts))
            diff = diff_meta(previous[0], previous[1], block_texts) if previous else None
            versions.append(LawVersion(
                **common, textPath=f"legislation/text/{version_id}.json", textAvailability="mirrored",
                textHash=text_hash, sourceHash=sha256_bytes(xml_bytes), blockCount=len(block_texts),
                wordCount=sum(len(t.split()) for t in block_texts), diff=diff,
            ))
            texts[version_id] = {
                "versionId": version_id, "instrumentId": bill_key, "label": common["label"],
                "versionDate": common["versionDate"], "title": parsed["title"], "subject": parsed["subject"],
                "digest": parsed["digest"], "blocks": parsed["blocks"], "textHash": text_hash,
                "officialUrl": common["officialUrl"], "sourceId": SOURCE_ID,
            }
            previous = (version_id, block_texts)
            latest_parsed = parsed
        else:
            versions.append(LawVersion(**common, textAvailability="link_only"))

    actions: List[LegislativeAction] = []
    approved = chaptered = vetoed = veto_stands = None
    # Rows that share a date and a sequence number are not stored in order; the
    # history id gives the order in which they were recorded.
    for row in sorted((h for h in history if h[0] == bill_id), key=lambda h: (h[2] or "", int(h[6] or 0), int(h[1] or 0))):
        text = re.sub(r"\s+", " ", row[3] or "").strip()
        date = (row[2] or "")[:10]
        if not text or not date:
            continue
        rule_id, event_type, significance = classify_action(text)
        status = row[8] if row[8] and row[8] != "Applied" else None
        if status:
            significance = "routine"  # a rescinded or reconsidered action is shown, but not as a key event
        actions.append(LegislativeAction(date=date, sequence=int(row[6] or 0), historyId=row[1], text=text, location=row[9],
                                         status=status, eventType=event_type, significance=significance,
                                         classificationRule=rule_id))
        if status:
            continue
        if event_type == "approved_by_governor":
            approved = date
        elif event_type == "chaptered":
            chaptered = date
        elif event_type == "vetoed":
            vetoed, veto_stands = date, None
        elif event_type == "veto_stands" and vetoed:
            veto_stands = date

    indicators = (latest_parsed or {}).get("indicators", {})
    current_status = bill[17] or ""
    latest_blocks = (latest_parsed or {}).get("blocks", [])
    conditions = conditions_in(latest_blocks)
    latest_text_version = next((v.id for v in reversed(versions) if v.textAvailability == "mirrored"), None)
    effective = effective_info(measure_type or "", current_status, chaptered, vetoed, bill[7], indicators, conditions, veto_stands)
    condition_records = [TextCondition(text=c, versionId=latest_text_version or "", ruleId=CONDITION_RULE_ID) for c in conditions]
    expiry_records = [ExpiryClause(text=text, versionId=latest_text_version or "", ruleId=SUNSET_RULE_ID, date=date)
                      for text, date in expiry_clauses_in(latest_blocks)]

    chapter = None
    if bill[9]:
        kind = "Resolution Chapter" if bill[7] == "CHR" else "Chapter"
        chapter = Chapter(year=bill[6], number=bill[9], type=bill[7], citation=f"{kind} {bill[9]}, Statutes of {bill[6]}")

    body = dict(
        id=bill_key, state="06", stateAbbr="CA", session=session_label(bill[1] or ""),
        identifier=f"{measure_type} {measure_num}", measureType=MEASURE_NAMES.get(measure_type or "", measure_type or ""),
        title=(latest_parsed or {}).get("title") or None, subject=entry["subject"] or None,
        leadAuthors=(latest_parsed or {}).get("authors") or None,
        legislativeStatus=LegislativeStatus(measureState=bill[5], currentStatus=bill[17], currentHouse=bill[16], currentLocation=bill[14]),
        chapter=chapter,
        introducedDate=versions[0].versionDate if versions else None,
        lastActionDate=actions[-1].date if actions else None,
        lastActionText=actions[-1].text if actions else None,
        versionCount=len(versions), issueTags=[], officialUrl=official_url, sourceId=SOURCE_ID,
        firstObservedAt=first_observed or checked_at, lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.VERIFIED_PRIMARY, method="automated_primary_retrieval", checkedAt=checked_at,
            note="Parsed from the Legislative Counsel's official bulk data. Not reviewed by a lawyer.",
        ),
        digest="\n\n".join((latest_parsed or {}).get("digest", [])) or None,
        actions=actions, approvedDate=approved, chapteredDate=chaptered, vetoedDate=vetoed,
        effective=effective, conditions=condition_records, expiryClauses=expiry_records, indicators=indicators, versions=versions,
        affectedStatutes=[AffectedStatute(**s) for s in (latest_parsed or {}).get("statutes", [])][:200],
        judicialNote="Legislative status does not show whether a court has blocked, narrowed or upheld any provision. "
                     "Check the linked litigation, which may be incomplete.",
        sourcePublishedAt=archive.archive_modified,
    )
    basis = {k: v for k, v in LegislativeInstrument(**body, contentHash="").model_dump(mode="json").items()
             if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash", "sourcePublishedAt", "selection"}}
    return LegislativeInstrument(**body, contentHash=content_hash(basis)), texts
