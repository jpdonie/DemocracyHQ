"""Measures of the U.S. Congress, from the bill status files and bill texts the Government Publishing Office publishes.

Sources (both on govinfo.gov, both U.S. Government works):

* Bill status bulk data: one archive per measure type and Congress, holding one XML record per measure with its
  titles, sponsors, committees, every recorded action, the Congressional Research Service's summary and policy
  area, related measures and the list of text versions. The records are written by the Library of Congress.
* Bill texts: one XML document per text version (introduced, reported, engrossed, enrolled ...), read by
  :mod:`dhq.adapters.bill_text`, which publishes a version's text only when it passes that module's self-check.

Which measures are included is decided by rule ``us-select-1`` below, from each measure's titles and its policy
area. Everything shown about a measure is copied from its status record; the only derived values are the event
labels of the actions (rules ``us-*``) and the stage (rule ``us-status-1``), each from published patterns.
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional

from ..http import FetchError, Fetcher, in_rounds
from ..schemas import (
    Chapter,
    EffectiveInfo,
    LawVersion,
    LegislativeAction,
    LegislativeInstrument,
    LegislativeStatus,
    RecordedVote,
    RelatedMeasure,
    Sponsor,
    Verification,
    VerificationStatus,
)
from ..util import content_hash, http_date_to_iso, iso_to_http_date, sha256_bytes, sha256_text, write_bytes_atomic
from . import bill_text
from .ca_leginfo import diff_meta, long_date

log = logging.getLogger("dhq.congress")

SOURCE_ID = "govinfo-billstatus"
TEXT_SOURCE_ID = "govinfo-bills"
#: The Congress whose measures are published. The 119th Congress sits from January 2025 to January 2027.
CONGRESS = 119

ARCHIVE_URL = "https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{kind}/BILLSTATUS-{congress}-{kind}.zip"
STATUS_URL = "https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{kind}/BILLSTATUS-{congress}{kind}{number}.xml"
TEXT_URL = "https://www.govinfo.gov/content/pkg/{package}/xml/{package}.xml"
TEXT_PAGE_URL = "https://www.govinfo.gov/app/details/{package}"
MEASURE_URL = "https://www.congress.gov/bill/{congress}{suffix}-congress/{slug}/{number}"

#: Measure type -> (how the measure is cited, its name, the word for it in a congress.gov address).
MEASURE_TYPES: Dict[str, tuple[str, str, str]] = {
    "hr": ("H.R.", "House Bill", "house-bill"),
    "s": ("S.", "Senate Bill", "senate-bill"),
    "hjres": ("H.J.Res.", "House Joint Resolution", "house-joint-resolution"),
    "sjres": ("S.J.Res.", "Senate Joint Resolution", "senate-joint-resolution"),
    "hconres": ("H.Con.Res.", "House Concurrent Resolution", "house-concurrent-resolution"),
    "sconres": ("S.Con.Res.", "Senate Concurrent Resolution", "senate-concurrent-resolution"),
    "hres": ("H.Res.", "House Resolution", "house-resolution"),
    "sres": ("S.Res.", "Senate Resolution", "senate-resolution"),
}
SIMPLE_RESOLUTIONS = {"hres", "sres"}
CONCURRENT_RESOLUTIONS = {"hconres", "sconres"}
JOINT_RESOLUTIONS = {"hjres", "sjres"}

BILL_ID_PATTERN = r"^us-[0-9]{3}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)[0-9]{1,5}$"
_MEMBER_RE = re.compile(r"^BILLSTATUS-(?P<congress>[0-9]{3})(?P<kind>hr|s|hjres|sjres|hconres|sconres|hres|sres)(?P<number>[0-9]{1,5})\.xml$")
_PACKAGE_RE = re.compile(r"^BILLS-(?P<congress>[0-9]{3})(?P<kind>hr|s|hjres|sjres|hconres|sconres|hres|sres)(?P<number>[0-9]{1,5})(?P<version>[a-z][a-z0-9]{1,7})$")

#: Largest status record read, and largest archive unpacked, as the archive's directory states them. The House
#: bills archive is about 34 MB and unpacks to about 250 MB; its largest record is under 4 MB.
MAX_RECORD_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024


# --- selection ------------------------------------------------------------------

SELECTION_RULE_ID = "us-select-1"
#: Phrases that name election law by themselves. A title that has one is selected whatever the measure's policy area.
SELECTION_PATTERN = re.compile(
    r"\bHelp America Vote Act\b|\bNational Voter Registration Act\b|\bVoting Rights Act\b|\bFederal Election Campaign Act\b"
    r"|\bUniformed and Overseas Citizens Absentee Voting Act\b|\bElectoral Count\b|\bFederal Election Commission\b|\bElection Assistance Commission\b"
    r"|\belections? for (?:Federal|public|State|local)[\w ,]{0,40}? office\b"
    r"|\b(?:Federal|State|local|general|primary|special|congressional|presidential|midterm) elections?\b"
    r"|\belections? (?:administration|officials?|workers?|infrastructure|security|integrity|day|mail|results?|observers?|systems?"
    r"|interference|subversion|fraud|crimes?|laws?|records?|equipment|technology|offic(?:es?|ials?))\b"
    r"|\bvoter (?:registration|identification|ID|rolls?|lists?|intimidation|suppression|purges?|eligibility|fraud|verification|roll"
    r"|education|outreach|turnout|data|information)\b"
    r"|\b(?:register(?:ing|ed)?|registration) to vote\b|\b(?:right|eligible|eligibility|entitled|qualified) to vote\b|\bvoting rights\b"
    r"|\bvoting (?:systems?|machines?|equipment|age|by mail|representation)\b"
    r"|\bnon-?citizens? (?:from )?voting\b|\bnoncitizen voting\b|\bvot(?:e|ing) (?:by|at|from) (?:mail|home)\b"
    r"|\bvote in (?:any |an |a )?(?:Federal |State |local )?elections?\b|\b(?:mail-?in|absentee|provisional|mail) (?:ballots?|voting|voters?)\b"
    r"|\bballot (?:boxes|box|drop boxes|drop box|measures?|access|harvesting|collection|initiatives?|integrity|tracking|processing"
    r"|counting|curing|secrecy)\b|\bcast(?:ing)? (?:a |their |his or her )?ballots?\b|\bballots? (?:cast|received|counted)\b"
    r"|\bpolling (?:places?|locations?|stations?)\b|\bearly voting\b|\branked[- ]choice voting\b|\bsame[- ]day (?:voter )?registration\b"
    r"|\bautomatic voter registration\b"
    r"|\bredistricting\b|\bgerrymander\w*|\belection contests?\b|\bcontested elections?\b|\bapportionment of Representatives\b"
    r"|\breapportionment\b|\bElectoral College\b|\belectoral votes?\b|\bpresidential electors?\b|\belectors for President\b"
    r"|\bcampaign (?:finance|contributions?|expenditures?|committees?|funds?|advertis\w+|communications?)\b"
    r"|\bpolitical (?:committees?|action committees?|advertis\w+|contributions?)\b|\bsuper ?PACs?\b|\bcorporate PACs?\b"
    r"|\bindependent expenditures?\b|\belectioneering\b|\bcontributions? (?:and|or) expenditures\b"
    r"|\bcandidates? for (?:Federal|public|elective|State|local|election|President|Congress|the Senate|the House|Senator|Representative"
    r"|(?:the )?office)\b|\bPresidential Election Campaign Fund\b|\bpresidential candidates?\b"
    r"|\bpresidential inaugural committees?\b",
    re.I)
#: General election words. They count only in a measure whose policy area is "Government Operations and Politics",
#: or that has no policy area yet.
GENERAL_PATTERN = re.compile(r"\b(?:elections?|electoral|electors?|voters?|voting|vote|votes|ballots?|apportionment|congressional districts?)\b", re.I)
GENERAL_AREAS = ("Government Operations and Politics", None)
#: A narrower list of election words, for the three other policy areas in which election measures are filed.
OTHER_PATTERN = re.compile(r"\b(?:elections?|electoral|voters?|voting|ballots?)\b", re.I)
OTHER_AREAS = ("Immigration", "Crime and Law Enforcement", "Civil Rights and Liberties, Minority Issues")
#: Measures in this policy area concern elections in other countries.
EXCLUDED_AREAS = ("International Affairs",)
#: Phrases removed from a title before it is read: procedure of the two chambers and voting outside public elections.
EXCLUSION_PATTERN = re.compile(
    r"^(?:Providing|Provides) for (?:the )?consideration of .*"
    r"|\belection of (?:the |a )?(?:Speaker|Clerk|President pro tempore|Secretary of the Senate|Sergeant at Arms)[^.;]*"
    r"|\bproxy voting\b|\bvoting by proxy\b|\bvoting rights associated with[^.;]*"
    r"|\bvot(?:e|es|ing) (?:of|by) (?:the )?(?:Members|shareholders?|justices?)[^.;]*",
    re.I)
#: The three tests, in the order they are tried, as they are named in a measure's record.
SELECTION_TESTS = {
    "named": "a title names election law",
    "general": "a title has an election word and the policy area is Government Operations and Politics (or none is assigned yet)",
    "other": "a title has an election word and the policy area is Immigration, Crime and Law Enforcement, or Civil Rights and Liberties, Minority Issues",
}


def selection_match(titles: List[tuple[str, str]], policy_area: Optional[str]) -> Optional[dict]:
    """Why a measure is selected, or ``None``. ``titles`` are ``(title type, title)`` pairs in the record's order."""
    if policy_area in EXCLUDED_AREAS:
        return None
    tests = [("named", SELECTION_PATTERN, True),
             ("general", GENERAL_PATTERN, policy_area in GENERAL_AREAS),
             ("other", OTHER_PATTERN, policy_area in OTHER_AREAS)]
    for test, pattern, applies in tests:
        if not applies:
            continue
        for kind, title in titles:
            match = pattern.search(EXCLUSION_PATTERN.sub(" ", title))
            if match:
                return {"test": test, "matchedText": match.group(0), "matchedField": kind, "matchedTitle": title}
    return None


# --- actions --------------------------------------------------------------------

#: The Library of Congress writes one standard line for each step a measure takes ("Passed/agreed to in House:
#: ..."), beside the chambers' own entries. The event labels are read from those lines only. Each rule: id, event
#: type, significance, the Library's action codes the line carries, and the pattern its text must match.
LOC_SOURCE = "Library of Congress"
ACTION_RULES: List[tuple[str, str, str, tuple[str, ...], str]] = [
    ("us-became-law", "became_law", "major", ("36000", "E40000", "41000"), r"^Became (?:Public|Private) Law No: ?[0-9]+-[0-9]+"),
    ("us-signed", "approved_by_president", "major", ("36000", "E30000", "29000"), r"^Signed by President"),
    ("us-veto-overridden", "veto_override_passed", "major", ("32000", "34000"), r"^Passed (?:House|Senate) over veto"),
    ("us-veto-sustained", "veto_override_failed", "major", ("33000", "35000"), r"^Failed of passage in (?:House|Senate) over veto"),
    ("us-vetoed", "vetoed", "major", ("31000",), r"^(?:Pocket )?[Vv]etoed by President"),
    ("us-presented", "presented_to_president", "major", ("28000",), r"^Presented to President"),
    ("us-conference", "conference_report_agreed", "major", ("23000", "25000"), r"^Conference report agreed to in (?:House|Senate)"),
    ("us-differences", "resolving_differences", "major", ("19500", "20500"), r"^Resolving differences -- (?:House|Senate) actions"),
    ("us-passed-house", "passed_house", "major", ("8000",), r"^Passed/agreed to in House"),
    ("us-passed-senate", "passed_senate", "major", ("17000",), r"^Passed/agreed to in Senate"),
    ("us-failed-house", "vote_failed", "major", ("9000",), r"^Failed of passage/not agreed to in House"),
    ("us-failed-senate", "vote_failed", "major", ("18000",), r"^Failed of passage/not agreed to in Senate"),
    ("us-reported", "reported", "major", ("5000", "14000", "1010"), r"[Rr]eported"),
    ("us-discharged", "committee_discharged", "routine", ("5500", "14500"), r"discharged"),
    ("us-introduced", "introduced", "major", ("1000", "10000", "1025", "10025", "Intro-H", "Intro-S"), r"^(?:Introduced|Submitted) in (?:the )?(?:House|Senate)"),
]
_ACTION_COMPILED = [(rid, et, sig, set(codes), re.compile(pat)) for rid, et, sig, codes, pat in ACTION_RULES]
#: What an entry no rule above matches is called, by the kind the record itself gives it.
OTHER_RULE_ID = "us-other"
OTHER_EVENT_TYPES = {"Committee": "committee_action", "Floor": "floor_action", "IntroReferral": "referral", "Calendars": "calendar",
                     "Discharge": "committee_action", "ResolvingDifferences": "floor_action", "Veto": "floor_action"}


def classify_action(text: str, code: Optional[str], source: Optional[str], kind: Optional[str]) -> tuple[str, str, str]:
    """``(rule id, event type, significance)`` of one recorded action."""
    if source == LOC_SOURCE and code:
        for rule_id, event_type, significance, codes, pattern in _ACTION_COMPILED:
            if code in codes and pattern.search(text):
                return rule_id, event_type, significance
    return OTHER_RULE_ID, OTHER_EVENT_TYPES.get(kind or "", "legislative_action"), "routine"


STATUS_RULE_ID = "us-status-1"
#: Each chamber has voted to pass the measure, and the record shows no later step. The two votes can be on different
#: texts (one chamber passes the other's bill with an amendment), so the names do not say that Congress passed it.
PASSED_IN_EACH = "Passed House and Senate, not sent to the President"
AGREED_IN_EACH = "Agreed to in House and Senate"


def derive_status(kind: str, actions: List[LegislativeAction]) -> str:
    """The stage a measure has reached, from the event labels of its actions (rule ``us-status-1``).

    The first line that applies is the stage: became law; vetoed; sent to the President; for a resolution of one
    chamber, agreed to there; passed in each chamber; passed one chamber; failed in a chamber; reported by a
    committee; introduced. It says how far the measure got, not what is happening to it now. "Passed in each chamber"
    means only that the record has a vote of passage in each: whether both passed the same text is not read.
    """
    seen = {a.eventType for a in actions}
    rules = {a.classificationRule for a in actions}
    if "became_law" in seen:
        return "Became law"
    if "vetoed" in seen:
        return "Vetoed"
    if "presented_to_president" in seen:
        return "Sent to the President"
    if kind in SIMPLE_RESOLUTIONS:
        chamber = "House" if kind == "hres" else "Senate"
        if f"passed_{chamber.lower()}" in seen:
            return f"Agreed to in the {chamber}"
        if "vote_failed" in seen:
            return f"Not agreed to in the {chamber}"
    else:
        if "passed_house" in seen and "passed_senate" in seen:
            return AGREED_IN_EACH if kind in CONCURRENT_RESOLUTIONS else PASSED_IN_EACH
        if "passed_house" in seen:
            return "Passed the House"
        if "passed_senate" in seen:
            return "Passed the Senate"
        if "us-failed-house" in rules:
            return "Failed in the House"
        if "us-failed-senate" in rules:
            return "Failed in the Senate"
    if "reported" in seen:
        return "Reported by committee"
    return "Introduced"


#: Every stage :func:`derive_status` can give, in the order a measure moves through them.
STATUS_ORDER = ["Introduced", "Reported by committee", "Failed in the House", "Failed in the Senate", "Not agreed to in the House",
                "Not agreed to in the Senate", "Passed the House", "Passed the Senate", "Agreed to in the House", "Agreed to in the Senate",
                PASSED_IN_EACH, AGREED_IN_EACH, "Sent to the President", "Vetoed", "Became law"]


# --- reading a status record ----------------------------------------------------

class StatusRecordError(ValueError):
    """A status record that cannot be read as the record of the measure its file name gives."""


def bill_id(kind: str, number: int, congress: int = CONGRESS) -> str:
    return f"us-{congress}-{kind}{number}"


def identifier(kind: str, number: int) -> str:
    return f"{MEASURE_TYPES[kind][0]} {number}"


def ordinal(number: int) -> str:
    if 10 <= number % 100 <= 20:
        return f"{number}th"
    return f"{number}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(number % 10, 'th') }"


def session_label(congress: int) -> str:
    """"119th Congress (2025–2026)": a Congress begins in January of the odd year after the election."""
    first = 1789 + 2 * (congress - 1)
    return f"{ordinal(congress)} Congress ({first}–{first + 1})"


def measure_url(kind: str, number: int, congress: int = CONGRESS) -> str:
    return MEASURE_URL.format(congress=congress, suffix=ordinal(congress)[len(str(congress)):], slug=MEASURE_TYPES[kind][2], number=number)


def _text(el: Optional[ET.Element], path: str) -> str:
    value = el.findtext(path) if el is not None else None
    return re.sub(r"\s+", " ", value).strip() if value else ""


def _day(value: str) -> Optional[str]:
    """The calendar day of a date or timestamp in the record, or ``None``.

    The records give text-version dates as midnight Eastern time written in UTC ("2025-04-10T04:00:00Z"), so the
    day is read from the first ten characters."""
    return value[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", value or "") else None


class _Paragraphs(HTMLParser):
    """The paragraphs of a summary, which the record carries as a small piece of HTML."""

    BLOCKS = {"p", "li", "div", "ul", "ol", "br", "h1", "h2", "h3", "h4", "table", "tr", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: List[str] = []
        self._current: List[str] = []
        self._bullet = False

    def _flush(self) -> None:
        text = re.sub(r"\s+", " ", "".join(self._current)).strip()
        if text:
            self.paragraphs.append(("• " if self._bullet else "") + text)
        self._current, self._bullet = [], False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.BLOCKS:
            self._flush()
            self._bullet = tag == "li"

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCKS:
            self._flush()

    def handle_data(self, data: str) -> None:
        self._current.append(data)


def summary_paragraphs(markup: str) -> List[str]:
    parser = _Paragraphs()
    parser.feed(markup or "")
    parser.close()
    parser._flush()
    return parser.paragraphs


def parse_status(xml_bytes: bytes) -> dict:
    """One status record as plain values. Raises :class:`StatusRecordError` for anything that is not one."""
    if len(xml_bytes) > MAX_RECORD_BYTES:
        raise StatusRecordError(f"the record is {len(xml_bytes)} bytes; at most {MAX_RECORD_BYTES} are read")
    if b"<!DOCTYPE" in xml_bytes[:4096] or b"<!ENTITY" in xml_bytes:
        raise StatusRecordError("the record declares a document type or entities, which a status record never does")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise StatusRecordError(f"not well-formed XML: {exc}") from exc
    bill = root.find("bill") if root.tag == "billStatus" else None
    if bill is None:
        raise StatusRecordError(f"the document is a <{root.tag}>, not a bill status record")
    kind = _text(bill, "type").lower()
    number, congress = _text(bill, "number"), _text(bill, "congress")
    if kind not in MEASURE_TYPES or not number.isdigit() or not congress.isdigit():
        raise StatusRecordError(f"measure type {kind!r}, number {number!r} or Congress {congress!r} is not as expected")

    titles: List[tuple[str, str]] = []
    display = _text(bill, "title")
    if display:
        titles.append(("Display title", display))
    for item in bill.findall("titles/item"):
        title, title_type = _text(item, "title"), _text(item, "titleType")
        if title and (title_type or "Title", title) not in titles:
            titles.append((title_type or "Title", title))

    actions = []
    for item in bill.findall("actions/item"):
        text = _text(item, "text")
        date = _day(_text(item, "actionDate"))
        if not text or not date:
            continue
        votes = []
        for vote in item.findall("recordedVotes/recordedVote"):
            url = _text(vote, "url")
            if url.startswith("https://"):
                votes.append({"chamber": _text(vote, "chamber"), "rollNumber": _text(vote, "rollNumber"), "url": url,
                              "session": _text(vote, "sessionNumber") or None})
        actions.append({"date": date, "time": _text(item, "actionTime") or None, "text": text, "kind": _text(item, "type") or None,
                        "code": _text(item, "actionCode") or None, "source": _text(item, "sourceSystem/name") or None, "votes": votes})

    summaries = []
    for item in bill.findall("summaries/summary"):
        paragraphs = summary_paragraphs(item.findtext("text") or "")
        if paragraphs:
            summaries.append({"version": _text(item, "actionDesc") or None, "date": _day(_text(item, "actionDate")),
                              "updated": _text(item, "updateDate"), "paragraphs": paragraphs})

    versions = []
    for item in bill.findall("textVersions/item"):
        urls = [_text(fmt, "url") for fmt in item.findall("formats/item")]
        versions.append({"label": _text(item, "type") or None, "date": _day(_text(item, "date")), "urls": [u for u in urls if u]})

    related = []
    for item in bill.findall("relatedBills/item"):
        r_kind, r_number, r_congress = _text(item, "type").lower(), _text(item, "number"), _text(item, "congress")
        if r_kind not in MEASURE_TYPES or not r_number.isdigit() or not r_congress.isdigit():
            continue
        details = [(_text(d, "type"), _text(d, "identifiedBy")) for d in item.findall("relationshipDetails/item")]
        related.append({"kind": r_kind, "number": int(r_number), "congress": int(r_congress), "title": _text(item, "title") or None,
                        "relationships": list(dict.fromkeys(t for t, _ in details if t)),
                        "identifiedBy": list(dict.fromkeys(b for _, b in details if b))})

    def member(item: ET.Element) -> dict:
        return {"name": _text(item, "fullName"), "party": _text(item, "party") or None, "state": _text(item, "state") or None,
                "district": _text(item, "district") or None}

    return {
        "kind": kind, "number": int(number), "congress": int(congress),
        "title": display, "titles": titles,
        "policyArea": _text(bill, "policyArea/name") or None,
        "subjects": [s for s in (_text(i, "name") for i in bill.findall("subjects/legislativeSubjects/item")) if s],
        "introduced": _day(_text(bill, "introducedDate")),
        "updated": _text(bill, "updateDate") or None,
        "legislationUrl": _text(bill, "legislationUrl") or None,
        "sponsors": [member(i) for i in bill.findall("sponsors/item") if _text(i, "fullName")],
        "cosponsors": sum(1 for i in bill.findall("cosponsors/item") if not _text(i, "sponsorshipWithdrawnDate")),
        "committees": [{"name": _text(i, "name"), "chamber": _text(i, "chamber") or None} for i in bill.findall("committees/item") if _text(i, "name")],
        "actions": actions, "summaries": summaries, "versions": versions, "related": related,
        "laws": [{"type": _text(i, "type"), "number": _text(i, "number")} for i in bill.findall("laws/item") if _text(i, "number")],
        "latestAction": {"date": _day(_text(bill, "latestAction/actionDate")), "text": _text(bill, "latestAction/text") or None},
    }


# --- the archives ---------------------------------------------------------------

class StatusArchives:
    """The bill status archives of one Congress, downloaded once per version the server offers."""

    def __init__(self, fetcher: Fetcher, cache: Path, congress: int = CONGRESS):
        self.fetcher = fetcher
        self.cache = cache
        self.congress = congress
        #: Measure type -> Last-Modified date of the archive in use.
        self.modified: Dict[str, Optional[str]] = {}

    def _current_copy(self, kind: str) -> Path:
        """The archive the server offers now. A cached copy is reused only while the server reports the same
        Last-Modified date and size as when it was downloaded; the archives are rebuilt whenever a record changes."""
        url = ARCHIVE_URL.format(congress=self.congress, kind=kind)
        dest = self.cache / f"BILLSTATUS-{self.congress}-{kind}.zip"
        headers = self.fetcher.head(url)
        modified = http_date_to_iso(headers.get("Last-Modified"))
        length = headers.get("Content-Length") or ""
        stamp = f"{modified or ''}|{length}"
        sidecar = dest.with_suffix(".modified")
        kept = sidecar.read_text(encoding="utf-8") if sidecar.exists() else None
        if kept != stamp or not dest.exists():
            incoming = self.fetcher.download(url, dest.with_name(dest.name + ".new"), force=True)
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
            write_bytes_atomic(sidecar, stamp.encode("utf-8"), root=self.cache)
        self.modified[kind] = sidecar.read_text(encoding="utf-8").split("|")[0] or None
        return dest

    def records(self, kind: str) -> Iterator[tuple[str, bytes]]:
        """``(member name, bytes)`` of every status record of one measure type.

        The archive is untrusted input: a member is read only when it is named as a status record of this Congress
        and type, and an archive whose directory states more than the limits is refused before anything is read."""
        path = self._current_copy(kind)
        with zipfile.ZipFile(path) as archive:
            members = [info for info in archive.infolist() if not info.is_dir()]
            total = sum(info.file_size for info in members)
            if total > MAX_ARCHIVE_BYTES:
                raise ValueError(f"{path.name} refused: its directory states {total} bytes in all; at most {MAX_ARCHIVE_BYTES} are expected")
            for info in members:
                match = _MEMBER_RE.match(Path(info.filename).name)
                if not match or match["kind"] != kind or int(match["congress"]) != self.congress:
                    continue
                if info.file_size > MAX_RECORD_BYTES:
                    raise ValueError(f"{path.name} refused: {info.filename} states {info.file_size} bytes; at most {MAX_RECORD_BYTES} are read")
                yield Path(info.filename).name, archive.read(info)

    @property
    def latest_modified(self) -> Optional[str]:
        dates = [d for d in self.modified.values() if d]
        return max(dates) if dates else None


_FIRST_ELEMENT_RE = re.compile(rb"<(?![?!])([A-Za-z_][\w:.-]*)")


def looks_like_bill_xml(data: bytes) -> bool:
    """Whether a document served for a text version is XML and not a web page: a server can answer 200 with an error
    page, which must not be kept as the text (its date would then be sent with every later request)."""
    head = data[:4096].lstrip()
    if not head.startswith(b"<") or head[:14].lower() == b"<!doctype html":
        return False
    first = _FIRST_ELEMENT_RE.search(head)
    return bool(first) and first.group(1).split(b":")[-1].lower() not in (b"html", b"head", b"body")


class TextStore:
    """The XML of bill text versions, each kept until the server says that it has changed.

    A copy already held is asked for again with its own date (``If-Modified-Since``): the server answers 304 when the
    file has not changed since, and the copy is kept. That is one request for a file, and it is answered where GovInfo
    fails a request for the file itself or for its headers alone.

    The versions a run needs are checked together before its measures are built (:meth:`check`). Each is asked for
    once, and the ones the server failed are asked for again after one pause for all of them (:func:`in_rounds`).
    """

    def __init__(self, fetcher: Fetcher, cache: Path):
        self.fetcher = fetcher
        self.cache = cache
        self._current: set[str] = set()  # versions whose copy was confirmed or fetched by check()
        self._failed: Dict[str, Exception] = {}  # versions check() could not retrieve

    def check(self, packages: Iterable[str], workers: int = 4) -> Dict[str, Exception]:
        """Bring the copies of these versions up to date. Returns what could not be retrieved, by version.

        A version that cannot be had by asking again (the server says it does not exist, or serves something that is
        not XML) is asked for once. :meth:`get` then answers from the copies, without another request.
        """
        def one(package: str) -> Optional[Exception]:
            try:
                self._retrieve(package, attempts=1)
            except Exception as exc:  # noqa: BLE001 - one version must not end the check of the others
                return exc
            self._current.add(package)
            return None

        failed = in_rounds(self.fetcher, sorted(set(packages) - self._current - set(self._failed)), one, what="bill text versions", workers=workers)
        self._failed.update(failed)
        return failed

    def get(self, package: str) -> bytes:
        if package in self._current:
            return (self.cache / f"{package}.xml").read_bytes()
        if package in self._failed:
            raise self._failed[package]
        return self._retrieve(package)

    def _retrieve(self, package: str, attempts: Optional[int] = None) -> bytes:
        if not _PACKAGE_RE.match(package):
            raise ValueError(f"{package!r} is not the id of a bill text version")
        url = TEXT_URL.format(package=package)
        dest = self.cache / f"{package}.xml"
        sidecar = dest.with_suffix(".modified")
        # A copy without a date (the server gave none) is fetched again in full.
        since = iso_to_http_date(sidecar.read_text(encoding="utf-8").strip()) if sidecar.exists() and dest.exists() else None
        if since:
            result = self.fetcher.get(url, headers={"If-Modified-Since": since}, ok_statuses=(200, 304), max_bytes=bill_text.MAX_XML_BYTES,
                                      attempts=attempts)
            if result.status == 304:
                return dest.read_bytes()
        else:
            result = self.fetcher.get(url, ok_statuses=(200,), max_bytes=bill_text.MAX_XML_BYTES, attempts=attempts)
        data = result.content
        if not looks_like_bill_xml(data):
            raise FetchError(url, 200, "the document served is not the XML of a text version")
        stamp = http_date_to_iso(result.headers.get("Last-Modified")) or ""
        write_bytes_atomic(dest, data, root=self.cache)
        write_bytes_atomic(sidecar, stamp.encode("utf-8"), root=self.cache)
        return data


def select_measures(archives: StatusArchives) -> tuple[Dict[str, dict], int, List[str]]:
    """``(selected, total, problems)``: the measures rule ``us-select-1`` selects, by id, each with its parsed record
    and why it was selected; the number of measures the rule read; and the records that could not be read."""
    selected: Dict[str, dict] = {}
    total = 0
    problems: List[str] = []
    for kind in MEASURE_TYPES:
        for name, data in archives.records(kind):
            total += 1
            try:
                record = parse_status(data)
                named = _MEMBER_RE.match(name)
                if (record["kind"], record["number"], record["congress"]) != (named["kind"], int(named["number"]), int(named["congress"])):
                    raise StatusRecordError(f"it describes {record['kind']} {record['number']} of the {record['congress']}th Congress")
            except StatusRecordError as exc:
                problems.append(f"{name}: {exc}")
                continue
            matched = selection_match(record["titles"], record["policyArea"])
            if matched:
                selected[bill_id(record["kind"], record["number"], record["congress"])] = {"record": record, "matched": matched, "sourceHash": sha256_bytes(data)}
    return selected, total, problems


# --- building a record ----------------------------------------------------------

#: The order of text versions that carry the same date: the order in which a measure moves through the chambers.
_VERSION_ORDER = ["ih", "is", "rih", "ris", "rfh", "rfs", "rh", "rs", "rch", "rcs", "pcs", "pch", "cph", "cps", "eh", "es", "rds", "rdh",
                  "eah", "eas", "ath", "ats", "enr"]


def _package_of(urls: List[str], kind: str, number: int, congress: int) -> Optional[str]:
    """The text version id (GovInfo package id) a version's XML address names, when it belongs to this measure."""
    for url in urls:
        match = re.fullmatch(r"https://www\.govinfo\.gov/content/pkg/(BILLS-[0-9a-z]+)/xml/\1\.xml", url)
        package = _PACKAGE_RE.match(match.group(1)) if match else None
        if package and (package["kind"], int(package["number"]), int(package["congress"])) == (kind, number, congress):
            return match.group(1)
    return None


def effective_info(kind: str, title: str, status: str, became_law: Optional[str], vetoed: Optional[str], law: Optional[str]) -> EffectiveInfo:
    """What can be said about a federal measure's effect from its status record alone. No effective date is asserted."""
    if kind in SIMPLE_RESOLUTIONS:
        chamber = "House" if kind == "hres" else "Senate"
        state = f"was agreed to in the {chamber}" if status.startswith("Agreed to") else f"has not been agreed to in the {chamber}"
        return EffectiveInfo(date=None, basis="not_applicable",
                             note=f"A simple resolution speaks for one chamber only. It is not a law and has no effective date. This one {state}.")
    if kind in CONCURRENT_RESOLUTIONS:
        state = ("The record shows a vote agreeing to this one in each chamber; whether both agreed to the same text is not read"
                 if status == AGREED_IN_EACH else "This one has not been agreed to in both chambers")
        return EffectiveInfo(date=None, basis="not_applicable",
                             note="A concurrent resolution is acted on by both chambers but is not sent to the President. It is not a law "
                                  f"and has no effective date. {state}.")
    if kind in JOINT_RESOLUTIONS and re.match(r"^Proposing an amendment to the Constitution", title or "", re.I):
        return EffectiveInfo(date=None, basis="not_enacted",
                             note="A joint resolution that proposes a constitutional amendment needs two thirds of each chamber and then "
                                  "ratification by three fourths of the States (U.S. Const. art. V). It is not sent to the President. "
                                  f"Stage reached: {status}.")
    if became_law:
        return EffectiveInfo(date=None, basis="not_verified",
                             note=f"Became {law or 'law'} on {long_date(became_law)}. The status record gives no effective date and DemocracyHQ "
                                  "has not verified one. An Act of Congress generally takes effect on the day it becomes law unless it states "
                                  "another date, and single provisions often state their own.")
    if vetoed:
        return EffectiveInfo(date=None, basis="not_enacted",
                             note=f"Vetoed by the President on {long_date(vetoed)}. A vetoed measure becomes law only if two thirds of each "
                                  "chamber vote to override the veto (U.S. Const. art. I, § 7); the status record shows no such law. "
                                  "It has no effective date.")
    each = (" Each chamber has voted to pass this measure, but the record does not show that both passed the same text: one chamber "
            "can pass the other's bill with an amendment, which the first must then accept." if status == PASSED_IN_EACH else "")
    return EffectiveInfo(date=None, basis="not_enacted",
                         note=f"Not enacted as of the date of the data (stage reached: {status}).{each} A bill becomes law only when both "
                              "chambers pass the same text and the President signs it, lets it become law without a signature, or is "
                              "overridden. It has no effective date.")


class BillTextUnavailable(Exception):
    """A text version could not be retrieved. The measure is not rebuilt, so that its last verified record is kept."""


def listed_versions(record: dict) -> tuple[List[dict], List[str]]:
    """The text versions a status record lists with a usable address and date, each with its package id, oldest first;
    and a note for each version that is not listed."""
    kind, number, congress = record["kind"], record["number"], record["congress"]
    notes: List[str] = []
    listed = []
    for version in record["versions"]:
        package = _package_of(version["urls"], kind, number, congress)
        if not package or not version["date"]:
            # Listed by the record before the Government Publishing Office has published its text, or without a date.
            notes.append(f"text version {version['label'] or 'without a name'!r} has no usable XML address or date in the status record; it is not listed")
            continue
        listed.append({**version, "package": package})
    code = lambda v: _PACKAGE_RE.match(v["package"])["version"]  # noqa: E731
    listed.sort(key=lambda v: (v["date"], _VERSION_ORDER.index(code(v)) if code(v) in _VERSION_ORDER else len(_VERSION_ORDER), v["package"]))
    return listed, notes


def text_packages(selected: Dict[str, dict]) -> List[str]:
    """Every text version the selected measures list, for :meth:`TextStore.check`."""
    packages: set[str] = set()
    for entry in selected.values():
        try:
            packages.update(version["package"] for version in listed_versions(entry["record"])[0])
        except Exception:  # noqa: BLE001 - a record that cannot be read fails its own measure when it is built
            continue
    return sorted(packages)


def build_instrument(entry: dict, texts: TextStore, *, checked_at: str, first_observed: Optional[str] = None,
                     in_dataset: Optional[set] = None, workers: int = 4) -> tuple[LegislativeInstrument, Dict[str, dict], List[str]]:
    """One measure's record, the texts of its versions by version id, and notes for the review queue.

    A version whose document fails the text reader's self-check is listed with its link and without mirrored text
    (and a note says so). A version whose document cannot be retrieved raises :class:`BillTextUnavailable`.
    """
    record = entry["record"]
    kind, number, congress = record["kind"], record["number"], record["congress"]
    key = bill_id(kind, number, congress)
    listed, notes = listed_versions(record)
    if len({v["package"] for v in listed}) != len(listed):
        raise StatusRecordError(f"{key}: the status record lists one text version twice")

    def load(version: dict) -> tuple[dict, bytes]:
        try:
            return version, texts.get(version["package"])
        except Exception as exc:  # noqa: BLE001
            raise BillTextUnavailable(f"text version {version['package']} could not be retrieved: {exc}") from exc

    with ThreadPoolExecutor(max_workers=workers) as pool:
        loaded = list(pool.map(load, listed))

    versions: List[LawVersion] = []
    text_records: Dict[str, dict] = {}
    previous: Optional[tuple[str, List[str]]] = None
    for index, (version, xml_bytes) in enumerate(loaded, start=1):
        package = version["package"]
        common = dict(id=package, instrumentId=key, label=version["label"] or "Text version", versionDate=version["date"], versionNum=index,
                      subject=None, officialUrl=TEXT_PAGE_URL.format(package=package), sourceMember=TEXT_URL.format(package=package))
        try:
            parsed = bill_text.parse_bill_text(xml_bytes)
        except bill_text.BillTextError as exc:
            notes.append(f"text version {package} is listed with a link only: {exc}")
            versions.append(LawVersion(**common, textAvailability="link_only", sourceHash=sha256_bytes(xml_bytes)))
            continue
        block_texts = [block[1] for block in parsed["blocks"]]
        text_hash = sha256_text("\n".join(block_texts))
        versions.append(LawVersion(
            **common, textPath=f"congress/text/{package}.json", textAvailability="mirrored", textHash=text_hash,
            sourceHash=sha256_bytes(xml_bytes), blockCount=len(block_texts), wordCount=parsed["wordCount"],
            diff=diff_meta(previous[0], previous[1], block_texts) if previous else None))
        text_records[package] = {
            "versionId": package, "instrumentId": key, "label": common["label"], "versionDate": common["versionDate"],
            "title": parsed["officialTitle"] or None, "subject": record["title"] or None, "digest": [], "blocks": parsed["blocks"],
            "textHash": text_hash, "officialUrl": common["officialUrl"], "sourceId": TEXT_SOURCE_ID,
        }
        previous = (package, block_texts)

    # The record lists actions newest first, and gives a time only for House floor entries. Reversing it and sorting
    # by day keeps the record's own order within a day. A line recorded twice with the same day and words (the
    # Library of Congress repeats some under two codes) is listed once, in the form a rule recognises.
    actions: List[LegislativeAction] = []
    seen_lines: Dict[tuple[str, str], int] = {}
    for item in sorted(reversed(record["actions"]), key=lambda a: a["date"]):
        rule_id, event_type, significance = classify_action(item["text"], item["code"], item["source"], item["kind"])
        action = LegislativeAction(
            date=item["date"], sequence=0, text=item["text"], eventType=event_type, significance=significance, classificationRule=rule_id,
            code=item["code"], source=item["source"], time=item["time"], votes=[RecordedVote(**v) for v in item["votes"]])
        at = seen_lines.get((item["date"], item["text"]))
        if at is not None:
            if actions[at].classificationRule == OTHER_RULE_ID and rule_id != OTHER_RULE_ID:
                actions[at] = action
            continue
        seen_lines[(item["date"], item["text"])] = len(actions)
        actions.append(action)
    for sequence, action in enumerate(actions, start=1):
        action.sequence = sequence

    def last_date(event_type: str) -> Optional[str]:
        return next((a.date for a in reversed(actions) if a.eventType == event_type), None)

    became_law, approved, vetoed = last_date("became_law"), last_date("approved_by_president"), last_date("vetoed")
    status = derive_status(kind, actions)
    chapter = None
    if record["laws"]:
        law = record["laws"][0]
        chapter = Chapter(year=None, number=law["number"], type=law["type"] or "Public Law", citation=f"{law['type'] or 'Public Law'} {law['number']}")

    display = record["title"]
    official = next((t for k, t in record["titles"] if k.startswith("Official Title") and t != display), None)
    short_titles = list(dict.fromkeys(t for k, t in record["titles"] if "Short Title" in k and t not in (display, official)))
    summary = max(record["summaries"], key=lambda s: (s["date"] or "", s["updated"] or ""), default=None)

    related: List[RelatedMeasure] = []
    for item in record["related"]:
        related_id = bill_id(item["kind"], item["number"], item["congress"])
        name = identifier(item["kind"], item["number"]) + ("" if item["congress"] == congress else f" ({ordinal(item['congress'])} Congress)")
        related.append(RelatedMeasure(
            identifier=name, title=item["title"], relationship="; ".join(item["relationships"]) or "Related measure",
            identifiedBy=", ".join(item["identifiedBy"]) or "not stated", id=related_id if in_dataset and related_id in in_dataset else None,
            officialUrl=measure_url(item["kind"], item["number"], item["congress"])))

    official_url = record["legislationUrl"] if (record["legislationUrl"] or "").startswith("https://www.congress.gov/") else measure_url(kind, number, congress)
    body = dict(
        id=key, state="US", stateAbbr="US", session=session_label(congress), identifier=identifier(kind, number),
        measureType=MEASURE_TYPES[kind][1], title=official, subject=display or official, leadAuthors="; ".join(s["name"] for s in record["sponsors"]) or None,
        legislativeStatus=LegislativeStatus(measureState=versions[-1].label if versions else None, currentStatus=status),
        chapter=chapter, introducedDate=record["introduced"],
        lastActionDate=actions[-1].date if actions else None, lastActionText=actions[-1].text if actions else None,
        versionCount=len(versions), issueTags=[], officialUrl=official_url, sourceId=SOURCE_ID,
        firstObservedAt=first_observed or checked_at, lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.VERIFIED_PRIMARY, method="automated_primary_retrieval", checkedAt=checked_at,
            note="Parsed from the bill status record and the bill texts published by the Government Publishing Office. Not reviewed by a lawyer."),
        digest="\n\n".join(summary["paragraphs"]) if summary else None,
        digestVersion=summary["version"] if summary else None, digestDate=summary["date"] if summary else None,
        actions=actions, approvedDate=approved, chapteredDate=became_law, vetoedDate=vetoed,
        effective=effective_info(kind, official or display, status, became_law, vetoed, chapter.citation if chapter else None),
        versions=versions,
        judicialNote="The stage shown does not say whether a court has blocked, narrowed or upheld any provision. "
                     "Check the linked litigation, which may be incomplete.",
        sourcePublishedAt=record["updated"],
        sponsors=[Sponsor(**s) for s in record["sponsors"]], cosponsorCount=record["cosponsors"],
        policyArea=record["policyArea"], legislativeSubjects=record["subjects"],
        committees=list(dict.fromkeys(c["name"] if not c["chamber"] or c["chamber"] in c["name"] else f"{c['chamber']} {c['name']}"
                                      for c in record["committees"])),
        shortTitles=short_titles, relatedMeasures=related,
        sourceRecordUrl=STATUS_URL.format(congress=congress, kind=kind, number=number),
    )
    basis = {k: v for k, v in LegislativeInstrument(**body, contentHash="").model_dump(mode="json").items()
             if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash", "sourcePublishedAt"}}
    return LegislativeInstrument(**body, contentHash=content_hash(basis)), text_records, notes

