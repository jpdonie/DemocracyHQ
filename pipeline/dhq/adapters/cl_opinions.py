"""Decisions of the federal district courts and of the state courts, from CourtListener (Free Law Project).

No official source lists the decisions of the ninety-four federal district courts or of the courts of the fifty
states in one place. CourtListener (https://www.courtlistener.com/) collects them: its programs fetch each decision
from the court's own website and keep a copy of the file. It is a secondary source, and every record made from it
says so (``imported_secondary``).

What this adapter does:

* It asks CourtListener's search for the decisions filed since ``SINCE`` that hold one of a published list of election
  words and phrases (``SEARCH_TERMS``). The search only draws up the list of candidates.
* Of the candidates it keeps those of a federal district court or of a state's supreme, appellate or trial court
  (``COURT_TYPES``) whose court it can place in a state by the court's name (``COURT_STATE_RULE_ID``).
* It reads the copy of each decision that CourtListener holds and applies the text tests of the rule for the courts
  of appeals (``uscourts.TEXT_TESTS``) to it. A case is selected by counts in a decision, never by a judgment of this
  project (``SELECTION_RULE_ID``).
* For a selected case it builds one record: the decisions CourtListener holds for the case that the search returned,
  each with the address of the copy that was read, the reason the case was selected, the subject tags and, where the
  rule for the opening of an opinion finds one, the passage it opens with.

What it does not do: it reads no docket. A record is known from decisions only, so it never says what else happened
in a case, and a case without a written decision is not listed at all. The courts of appeals and the Supreme Court
are not read here; the site reads them from official sources.

CourtListener is not complete, and it does not hold the same share of every court's decisions. Trial courts publish
few of their decisions, state trial courts hardly any. The numbers behind this are published with the data
(see :func:`coverage`).

Privacy: only the case title as CourtListener gives it is published. No party, judge or lawyer is listed.
"""

from __future__ import annotations

import calendar
import gzip
import hashlib
import html
import itertools
import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional
from urllib.parse import quote

from .. import about as about_rules
from .. import classify, opening
from ..http import FetchError, Fetcher, in_rounds
from ..schemas import (
    AboutText,
    CaseCourt,
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
from . import uscourts
from .courtlistener import SEARCH_URL, token
from .scotus import extract_pdf_text

log = logging.getLogger("dhq.cl_opinions")

SOURCE_ID = "courtlistener-api"
#: Decisions filed on or after this day are read: the same day as for the courts of appeals.
SINCE = uscourts.SINCE
SITE_ROOT = "https://www.courtlistener.com"
#: Where CourtListener keeps its copy of each decision's file.
STORAGE_ROOT = "https://storage.courtlistener.com/"
MAX_FILE_BYTES = 96 * 1024 * 1024

# --- the selection rule -----------------------------------------------------------------------------

SELECTION_RULE_ID = "court-select-1"
#: The kinds of court that are read, by the code CourtListener gives a court's jurisdiction.
COURT_TYPES: Dict[str, str] = {
    "FD": "federal_district",
    "S": "state_supreme",
    "SA": "state_appellate",
    "ST": "state_trial",
}
#: The words and phrases the search is asked for; a decision with any one of them is a candidate. They are the
#: election words of the rule for the courts of appeals, without "election" on its own (which the law of contracts,
#: of estates and of criminal procedure uses in other senses), and the phrases in which that rule counts "election".
SEARCH_TERMS: tuple[str, ...] = (
    "ballot", "ballots", "voter", "voters", "electoral", "electorate", "redistricting", "gerrymander", "gerrymandering",
    "reapportionment",
    '"election contest"', '"election code"', '"election law"', '"election laws"', '"election day"', '"election results"',
    '"election officials"', '"election commission"', '"election board"', '"board of elections"',
    '"primary election"', '"general election"', '"special election"', '"municipal election"', '"presidential election"',
    '"congressional election"', '"federal election"', '"state election"', '"local election"', '"judicial election"',
    '"runoff election"', '"recall election"', '"midterm election"',
)
SEARCH_QUERY = " OR ".join(SEARCH_TERMS)

COURT_STATE_RULE_ID = "court-state-1"
#: Two territories whose courts carry a shorter name than the territory's full one.
PLACE_SHORT_NAMES: Dict[str, str] = {"Virgin Islands": "78", "Northern Mariana Islands": "69"}
#: The names a court's name is searched for, longest first, so that "West Virginia" is found before "Virginia".
_PLACE_NAMES = sorted([*((name, fips) for fips, (_abbr, name) in STATES.items()), *PLACE_SHORT_NAMES.items()], key=lambda item: -len(item[0]))
#: How CourtListener abbreviates the district in the name of a federal district court.
_DISTRICT_WORDS = {"N.D.": "Northern District of", "S.D.": "Southern District of", "E.D.": "Eastern District of",
                   "W.D.": "Western District of", "M.D.": "Middle District of", "C.D.": "Central District of", "D.": "District of"}

#: What a document is, from the kind CourtListener gives it. The first group are decisions of the court; the second
#: are opinions of single judges beside one.
DOCUMENT_RULE_ID = "cl-doc-opinion"
SEPARATE_RULE_ID = "cl-doc-separate"
#: Decisions CourtListener files under two dockets of one court with one docket number are shown as one case.
SAME_DOCKET_RULE_ID = "cl-same-docket"
OPINION_KINDS: Dict[str, str] = {
    "combined-opinion": "Opinion",
    "unanimous-opinion": "Unanimous opinion",
    "lead-opinion": "Lead opinion",
    "plurality-opinion": "Plurality opinion",
    "on-the-merits": "Opinion on the merits",
    "rehearing": "Opinion on rehearing",
    "trial-court-opinion": "Opinion of the trial court",
    "in-part-opinion": "Opinion in part",
}
SEPARATE_KINDS: Dict[str, str] = {
    "concurrence": "Concurring opinion",
    "concurrence-in-part": "Opinion concurring in part",
    "concurring-in-part-and-dissenting-in-part": "Opinion concurring in part and dissenting in part",
    "dissent": "Dissenting opinion",
}
OTHER_KIND = "Document"
#: How many of the phrases the selection rule found a case's entry in the index names.
MATCHED_TERMS = uscourts.MATCHED_TERMS

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./ ()',&+\-]*$")
_PLACEHOLDER_RE = re.compile(r"^\s*(?:placeholder name|unknown case name|untitled)\s*$", re.I)


class ListingError(RuntimeError):
    """CourtListener's list of candidates could not be read, or is far shorter than the one before."""


# --- courts ---------------------------------------------------------------------------------------------

def court_state(name: str) -> Optional[str]:
    """The state, district or territory a court belongs to, read from the court's name (rule ``court-state-1``).

    The longest name of a state, of the District of Columbia or of a territory that stands in the court's name as
    whole words is taken ("West Virginia" before "Virginia", "Arkansas" never as "Kansas"); the Virgin Islands and
    the Northern Mariana Islands are also found under those short names. A name that holds none, or the names of two
    different places, places the court nowhere.
    """
    found: List[tuple[int, int, str]] = []
    for place, fips in _PLACE_NAMES:
        for match in re.finditer(rf"(?<![A-Za-z]){re.escape(place)}(?![A-Za-z])", name):
            if not any(start <= match.start() and match.end() <= end for start, end, _ in found):
                found.append((match.start(), match.end(), fips))
    places = {fips for _start, _end, fips in found}
    return places.pop() if len(places) == 1 else None


def court_name(name: str, jurisdiction: str) -> str:
    """The name a court is shown under. CourtListener writes a federal district court as "District Court, N.D. Texas";
    it is given its full name here. Every other name is CourtListener's own."""
    match = re.fullmatch(r"District Court, (N\.D\.|S\.D\.|E\.D\.|W\.D\.|M\.D\.|C\.D\.|D\.) (.+)", name) if jurisdiction == "FD" else None
    if match:
        return f"United States District Court for the {_DISTRICT_WORDS[match.group(1)]} {match.group(2)}"
    if jurisdiction == "FD" and name == "District Court, District of Columbia":
        return "United States District Court for the District of Columbia"
    return name


# --- the list of candidates -----------------------------------------------------------------------------

def _day(value: object) -> Optional[str]:
    return value[:10] if isinstance(value, str) and _DAY_RE.match(value) else None


def compact(item: dict) -> Optional[dict]:
    """One search result (a decision of a case) with the fields that are used, or ``None`` when it cannot be used:
    it lacks an id, a date or a court."""
    cluster, docket, day = item.get("cluster_id"), item.get("docket_id"), _day(item.get("dateFiled"))
    if not isinstance(cluster, int) or not isinstance(docket, int) or not day or not item.get("court_id"):
        return None
    documents = []
    for doc in item.get("opinions") or []:
        if isinstance(doc.get("id"), int):
            documents.append({"id": doc["id"], "kind": str(doc.get("type") or ""), "sha1": str(doc.get("sha1") or ""),
                              "path": str(doc.get("local_path") or ""), "courtUrl": str(doc.get("download_url") or "")})
    return {
        "cluster": cluster, "docket": docket, "date": day, "court": str(item["court_id"]), "courtName": str(item.get("court") or ""),
        "citation": str(item.get("court_citation_string") or ""), "jurisdiction": str(item.get("court_jurisdiction") or ""),
        "name": str(item.get("caseName") or "").strip(), "docketNumber": str(item.get("docketNumber") or "").strip(),
        "status": str(item.get("status") or ""), "url": str(item.get("absolute_url") or ""),
        "documents": sorted(documents, key=lambda doc: doc["id"]),
    }


#: CourtListener allows this project's token five requests a minute, fifty an hour and 125 a day, and its search
#: returns twenty decisions for a request. The list of candidates is therefore kept month by month, by the day a decision was filed,
#: and a run of the pipeline asks the search at most this many times ...
REQUESTS_PER_RUN = 40
#: ... first for the newest months, where new decisions appear, then for the months not read yet, then for the month
#: whose list is the oldest. Every month is so read again in turn.
NEWEST_MONTHS = 2
#: A month read again that returns less than this share of what it held before is not believed: its list stays.
MIN_MONTH_SHARE = 0.5
ENTRY_FIELDS = ["cluster", "docket", "date", "court", "courtName", "citation", "jurisdiction", "name", "docketNumber", "status", "url", "documents"]
DOCUMENT_FIELDS = ["id", "kind", "sha1", "path", "courtUrl"]


class RateLimited(RuntimeError):
    """CourtListener answered that the token has no request left for now."""

    def __init__(self, retry_after: Optional[float] = None):
        super().__init__(f"CourtListener's limit of requests is reached{f'; it names a wait of {retry_after:.0f} seconds' if retry_after else ''}")
        self.retry_after = retry_after


class Budget:
    """How many requests a run may still send to the search."""

    def __init__(self, limit: int):
        self.limit = max(0, int(limit))
        self.used = 0

    @property
    def left(self) -> int:
        return self.limit - self.used

    def take(self) -> bool:
        if self.used >= self.limit:
            return False
        self.used += 1
        return True


def months(since: str, today: str) -> List[str]:
    """Every month from the one ``since`` lies in to the one ``today`` lies in: ``["2025-01", ..., "2026-11"]``."""
    year, month = int(since[:4]), int(since[5:7])
    last = (int(today[:4]), int(today[5:7]))
    found: List[str] = []
    while (year, month) <= last:
        found.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return found


def month_days(month: str, since: str = SINCE) -> tuple[str, str]:
    """The first and the last day of a month that are asked for; the first is never before ``since``."""
    year, number = int(month[:4]), int(month[5:7])
    last = calendar.monthrange(year, number)[1]
    return max(f"{month}-01", since), f"{month}-{last:02d}"


def _page(fetcher: Fetcher, url: str, params: Optional[dict], headers: dict) -> dict:
    """One page of the search. A refusal for the limit of requests is not tried again: it would only use up the wait."""
    for attempt in range(3):
        try:
            payload = fetcher.get(url, headers=headers, params=params, attempts=1).json()
        except ValueError:
            raise ListingError("the search did not answer with JSON") from None
        except FetchError as exc:
            if exc.status == 429:
                raise RateLimited(exc.retry_after) from None
            if attempt == 2:
                raise
            fetcher.wait(5.0 * 2 ** attempt)
            continue
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ListingError("the search did not answer with a list of results")
        return payload
    raise ListingError("the search could not be read")  # pragma: no cover - the loop returns or raises


def list_month(fetcher: Fetcher, month: str, budget: Budget, *, since: str = SINCE) -> Optional[List[dict]]:
    """Every decision filed in one month that CourtListener's search returns for ``SEARCH_QUERY``, or ``None`` when
    the run's requests ran out before the month was read whole. A month is only ever taken whole, so a month whose
    first page says it needs more pages than the run has left is not read on: one request is spent, not several.

    A page address is followed only on the search itself, because the token goes with every request.
    """
    headers = {"Authorization": f"Token {token()}"}
    first, last = month_days(month, since)
    url: Optional[str] = SEARCH_URL
    params: Optional[dict] = {"type": "o", "q": SEARCH_QUERY, "filed_after": first, "filed_before": last, "order_by": "dateFiled desc"}
    found: Dict[int, dict] = {}
    while url:
        if not budget.take():
            return None
        payload = _page(fetcher, url, params, headers)
        count, size = payload.get("count"), len(payload["results"])
        if params is not None and isinstance(count, int) and size and payload.get("next") and math.ceil(count / size) - 1 > budget.left:
            return None
        for item in payload["results"]:
            entry = compact(item) if isinstance(item, dict) else None
            # A decision the search returns for a month it was not filed in belongs to the list of its own month.
            if entry and entry["date"][:7] == month and entry["date"] >= since:
                found.setdefault(entry["cluster"], entry)
        url, params = payload.get("next"), None
        if url and not (isinstance(url, str) and url.startswith(SEARCH_URL)):
            raise FetchError(str(url), None, "the response names a next page outside CourtListener's search; it was not requested")
    return sorted(found.values(), key=lambda entry: entry["cluster"])


def pack_entry(entry: dict) -> list:
    return [[[doc[name] for name in DOCUMENT_FIELDS] for doc in entry["documents"]] if name == "documents" else entry[name] for name in ENTRY_FIELDS]


def unpack_entry(row: list) -> dict:
    entry = dict(zip(ENTRY_FIELDS, row))
    entry["documents"] = [dict(zip(DOCUMENT_FIELDS, doc)) for doc in entry["documents"]]
    return entry


def listing_of(state: Optional[dict]) -> tuple[Dict[str, dict], Dict[int, dict]]:
    """``(months, entries)`` of a published scan state: for each month read, when it was read and what it returned;
    and every candidate that is read, by CourtListener's number for the decision. Both are empty for a state made by
    another rule, another starting day or another query, or laid out in other fields."""
    listing = (state or {}).get("listing") or {}
    same = bool(state) and state.get("ruleId") == SELECTION_RULE_ID and state.get("since") == SINCE and state.get("query") == SEARCH_QUERY \
        and listing.get("entryFields") == ENTRY_FIELDS and listing.get("documentFields") == DOCUMENT_FIELDS
    if not same:
        return {}, {}
    entries = {row[0]: unpack_entry(row) for row in listing.get("entries") or []}
    return dict(listing.get("months") or {}), entries


@dataclass
class Listing:
    #: For each month read so far: when, how many decisions the search returned, and how many were not read, by reason.
    months: Dict[str, dict]
    #: The candidates that are read, by CourtListener's number for the decision.
    entries: Dict[int, dict]
    #: The months read in this run, and those that returned too little to be believed.
    read: List[str] = field(default_factory=list)
    doubted: List[str] = field(default_factory=list)
    #: Set when CourtListener refused a request for its limit; the months read before it are kept.
    limited: Optional[RateLimited] = None
    requests: int = 0

    def document(self) -> dict:
        return {"months": dict(sorted(self.months.items())), "entryFields": ENTRY_FIELDS, "documentFields": DOCUMENT_FIELDS,
                "entries": [pack_entry(self.entries[cluster]) for cluster in sorted(self.entries)]}


def refresh_listing(fetcher: Fetcher, previous: Optional[dict], *, now: str, requests: int = REQUESTS_PER_RUN,
                    progress: Optional[Callable[[str, int], None]] = None) -> Listing:
    """Bring the list of candidates up to date as far as the run's requests reach.

    ``previous`` is the published scan state. The newest months are read first, then the months never read, then the
    months read longest ago. A month replaces what the list held for it: a decision CourtListener no longer returns
    for the month leaves the list.
    """
    held_months, entries = listing_of(previous)
    listing = Listing(months=held_months, entries=entries)
    every = months(SINCE, now[:10])
    newest = every[-NEWEST_MONTHS:][::-1]
    unread = [month for month in reversed(every) if month not in held_months and month not in newest]
    oldest = sorted((month for month in every if month in held_months and month not in newest), key=lambda month: (held_months[month].get("listedAt") or "", month))
    budget = Budget(requests)
    for month in newest + unread + oldest:
        try:
            found = list_month(fetcher, month, budget)
        except RateLimited as limit:
            listing.limited = limit
            break
        if found is None:
            break
        skipped: Dict[str, int] = {}
        usable_entries: List[dict] = []
        for entry in found:
            why = usable(entry)
            if why:
                key = f"{why}:{entry['jurisdiction'] or '?'}" if why == "otherCourt" else why
                skipped[key] = skipped.get(key, 0) + 1
            else:
                usable_entries.append(entry)
        before = held_months.get(month)
        if before and before.get("candidates", 0) >= 10 and len(found) < MIN_MONTH_SHARE * before["candidates"]:
            listing.doubted.append(month)
            continue
        for cluster in [cluster for cluster, entry in listing.entries.items() if entry["date"][:7] == month]:
            del listing.entries[cluster]
        for entry in usable_entries:
            listing.entries[entry["cluster"]] = entry
        listing.months[month] = {"listedAt": now, "candidates": len(found), "skipped": dict(sorted(skipped.items()))}
        listing.read.append(month)
        if progress:
            progress(month, len(found))
    listing.requests = budget.used
    return listing


def usable(entry: dict) -> Optional[str]:
    """Why a candidate is not read (a short key, counted in the published coverage), or ``None`` when it is read."""
    if entry["jurisdiction"] not in COURT_TYPES:
        return "otherCourt"
    if not entry["name"] or _PLACEHOLDER_RE.match(entry["name"]):
        return "noCaseName"
    if not entry["docketNumber"]:
        return "noDocketNumber"
    if not court_state(entry["courtName"]):
        return "noState"
    if not entry["documents"]:
        return "noDocument"
    return None


def _docket_key(entry: dict) -> tuple:
    """What names a case: its court and its docket number, compared without case, spaces and punctuation."""
    number = re.sub(r"[^a-z0-9]", "", entry["docketNumber"].lower())
    return (entry["court"], number) if number else (entry["court"], f"#{entry['docket']}")


def group_dockets(entries: Iterable[dict]) -> Dict[int, List[dict]]:
    """The decisions of the list grouped by case (rule ``cl-same-docket``): CourtListener sometimes files decisions of
    one case under two dockets, and decisions of one court with one docket number are one case. A case is keyed by the
    lowest of its dockets' ids."""
    groups: Dict[tuple, List[dict]] = {}
    for entry in entries:
        groups.setdefault(_docket_key(entry), []).append(entry)
    return {min(entry["docket"] for entry in group): group for group in groups.values()}


def fingerprint(entries: Iterable[dict]) -> str:
    """What changes when CourtListener changes a case's decisions: their ids, the checksums and the places of their files."""
    basis = "|".join(f"{entry['cluster']}:{doc['id']}:{doc['sha1']}:{doc['path']}" for entry in sorted(entries, key=lambda e: e["cluster"])
                     for doc in entry["documents"])
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


# --- reading a decision ---------------------------------------------------------------------------------

def file_url(path: str) -> Optional[str]:
    """The address of CourtListener's copy of a file, or ``None`` for a path that is not a plain relative one."""
    if not path or not _PATH_RE.match(path) or ".." in path or "//" in path:
        return None
    return STORAGE_ROOT + quote(path)


def html_text(data: bytes) -> Optional[str]:
    """The text of a decision that a court publishes as a web page: the tags are taken out, paragraphs keep their breaks."""
    page = data.decode("utf-8", errors="replace")
    page = re.sub(r"(?is)<(script|style|head)\b.*?</\1\s*>", " ", page)
    page = re.sub(r"(?i)<\s*(?:br|/p|/div|/h[1-6]|/li|/tr|/blockquote|/center|/pre)\b[^>]*>", "\n", page)
    text = html.unescape(re.sub(r"<[^>]*>", " ", page)).replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() or None


def _is_pdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


class Reader:
    """Reads CourtListener's copy of a document: its text, cached under the document's id and checksum, so that a
    file CourtListener replaces is read again."""

    def __init__(self, fetcher: Fetcher, cache: Path, attempts: Optional[int] = None):
        self.fetcher = fetcher
        self.cache = Path(cache)
        self.attempts = attempts

    def _stamp(self, doc: dict) -> str:
        return f"{doc['id']}.{re.sub(r'[^0-9a-f]', '', doc['sha1'].lower())[:16] or 'x'}"

    def text(self, doc: dict) -> Optional[str]:
        """The text of a document, or ``None`` when CourtListener holds no file for it or the file has no text."""
        url = file_url(doc["path"])
        if not url:
            return None
        path = self.cache / "text" / f"{self._stamp(doc)}.txt.gz"
        if path.exists():
            return gzip.decompress(path.read_bytes()).decode("utf-8") or None
        result = self.fetcher.get(url, max_bytes=MAX_FILE_BYTES, attempts=self.attempts)
        text = extract_pdf_text(result.content) if _is_pdf(doc["path"]) else html_text(result.content)
        write_bytes_atomic(path, gzip.compress((text or "").encode("utf-8"), mtime=0), root=self.cache)
        return text

    def layout(self, doc: dict) -> str:
        """Where each piece of text stands on the first pages of a PDF (see ``uscourts.Reader.layout``)."""
        url = file_url(doc["path"])
        if not url or not _is_pdf(doc["path"]):
            raise opening.LayoutError("the document is not a PDF file")
        path = self.cache / "layout" / f"{self._stamp(doc)}.xml.gz"
        if path.exists():
            return gzip.decompress(path.read_bytes()).decode("utf-8")
        result = self.fetcher.get(url, max_bytes=MAX_FILE_BYTES, attempts=self.attempts)
        layout = opening.pdf_layout(result.content)
        write_bytes_atomic(path, gzip.compress(layout.encode("utf-8"), mtime=0), root=self.cache)
        return layout


def evaluate(entries: List[dict], texts: Dict[int, Optional[str]]) -> dict:
    """Apply the selection rule to the decisions of one case.

    ``texts`` maps each document to its text, or to ``None`` when it could not be read. The text tests are those of
    the rule for the courts of appeals: "long", "dense", or "party" where the case title names a body that runs
    elections. The result names the test met, the document it rests on with its counts, and the outcome ("selected"
    or "").
    """
    documents = [doc for entry in entries for doc in entry["documents"]]
    readable = {doc["id"]: texts[doc["id"]] for doc in documents if texts.get(doc["id"])}
    counts = {doc_id: uscourts.count_text(text, phrases=False) for doc_id, text in readable.items()}
    result = {"documents": len(documents), "unreadable": len(documents) - len(readable), "tests": [], "document": None,
              "counts": counts, "party": None, "outcome": ""}
    title = entries[0]["name"]
    party = title if uscourts.AUTHORITY_PATTERN.search(title) else None
    met: Dict[int, str] = {}
    for doc_id in counts:
        if counts[doc_id]["wordMatches"] >= uscourts.MIN_WORD_MATCHES:
            counts[doc_id] = uscourts.count_text(readable[doc_id])
            test = uscourts.text_test(counts[doc_id], party)
            if test:
                met[doc_id] = test
    if not met:
        return result
    # The document with the most election words; the later one when two have the same number.
    best = max(met, key=lambda doc_id: (counts[doc_id]["wordMatches"], doc_id))
    result.update(tests=[met[best]], document=best, outcome="selected", party=party if met[best] == "party" else None)
    return result


# --- building the published record -------------------------------------------------------------------

def case_id(docket: int) -> str:
    return f"cl-{docket}"


def document_kind(kind: str) -> tuple[str, str]:
    """``(ruleId, what the document is)`` from the kind CourtListener gives a document."""
    if kind in OPINION_KINDS:
        return DOCUMENT_RULE_ID, OPINION_KINDS[kind]
    if kind in SEPARATE_KINDS:
        return SEPARATE_RULE_ID, SEPARATE_KINDS[kind]
    return DOCUMENT_RULE_ID, OTHER_KIND


def _court_link(url: str) -> Optional[str]:
    """The address a court published a document at, when it is a plain https address without a query of personal data."""
    return url if re.fullmatch(r"https://[A-Za-z0-9.-]+(?::\d+)?/[^\s<>\"']*", url or "") else None


def build_case(entries: List[dict], texts: Dict[int, Optional[str]], evaluation: dict, *, checked_at: str,
               first_observed: Optional[str] = None, about: Optional[dict] = None) -> LegalCase:
    """One selected case as a published record: the decisions of its docket that the search returned, in the order of
    their dates. ``about`` is the opening passage of the decision the selection rests on, where one was found."""
    entries = sorted(entries, key=lambda entry: (entry["date"], entry["cluster"]))
    latest = entries[-1]
    docket_ids = sorted({entry["docket"] for entry in entries})
    cid = case_id(docket_ids[0])
    events: List[LegalEvent] = []
    documents: List[CourtDocument] = []
    ruling: Optional[DispositiveEntry] = None
    publication: Optional[str] = None
    urls: Dict[int, Optional[str]] = {}
    sequence = 0
    for entry in entries:
        page = SITE_ROOT + entry["url"] if entry["url"].startswith("/") else None
        for doc in entry["documents"]:
            sequence += 1
            rule_id, label = document_kind(doc["kind"])
            copy = file_url(doc["path"])
            urls[doc["id"]] = copy
            doc_id = f"{cid}-d{sequence}"
            court_link = _court_link(doc["courtUrl"])
            note = "The copy CourtListener holds, which is the file that was read. Linked, not mirrored."
            if not copy:
                note = "CourtListener's record gives no file for this document; its page for the decision is linked instead."
            elif doc["id"] in texts and not texts[doc["id"]]:
                note += " The file has no text that a program can read."
            if court_link:
                note += f" The court's own address for the document, as CourtListener recorded it and not checked here: {court_link}"
            link = copy or page
            documents.append(CourtDocument(
                id=doc_id, caseId=cid, entryIndex=sequence, title=f"{label} of {entry['date']}", filingDate=entry["date"],
                documentType=label, url=link, availability="public_link" if link else "unavailable", accessNote=note,
            ))
            status = entry["status"] if entry["status"] in ("Published", "Unpublished") else None
            # CourtListener gives a decision no docket text: the line names the kind of document it lists, and no more.
            description = f"{label}{', ' + status.lower() if status else ''}"
            events.append(LegalEvent(
                id=f"{cid}-e{sequence}", eventType="opinion", date=entry["date"], entityType="case", entityId=cid,
                description=description, significance="major", classificationRule=rule_id,
                evidence=EvidenceRef(url=link or SITE_ROOT, sourceId=SOURCE_ID, document="the copy of the court's decision that CourtListener holds"),
                documentIds=[doc_id],
            ))
            if rule_id == DOCUMENT_RULE_ID:
                ruling = DispositiveEntry(date=entry["date"], text=description, eventType="opinion", ruleId=rule_id)
                publication = status
    best = evaluation["document"]
    best_counts = evaluation["counts"].get(best) if best is not None else None
    best_sequence = next((index for index, doc in enumerate((d for e in entries for d in e["documents"]), start=1) if doc["id"] == best), None)
    selection = CaseSelection(
        ruleId=SELECTION_RULE_ID, tests=evaluation["tests"],
        documentId=f"{cid}-d{best_sequence}" if best_sequence else None,
        documentUrl=urls.get(best) if best is not None else None,
        wordCount=best_counts["words"] if best_counts else None,
        wordMatches=best_counts["wordMatches"] if best_counts else None,
        phraseMatches=best_counts["phraseMatches"] if best_counts else None,
        density=round(best_counts["density"], 1) if best_counts else None,
        phrases=[TermCount(term=term, count=count) for term, count in (best_counts["phrases"][:8] if best_counts else [])],
        party=evaluation["party"],
    )
    fields: List[tuple] = [("case title", latest["name"])]
    if best is not None and texts.get(best):
        fields.append(("full text of the opinion", classify.join_line_hyphens(texts[best]), classify.LONG))
    jurisdiction = latest["jurisdiction"]
    dates = [event.date for event in events]
    body = dict(
        id=cid,
        externalIds={"courtlistenerDocketId": ",".join(str(docket) for docket in docket_ids),
                     "courtlistenerClusterIds": ",".join(str(entry["cluster"]) for entry in entries)},
        caseName=latest["name"],
        petitionerTitle="",
        respondentTitle="",
        docketNumber=latest["docketNumber"],
        courtId=latest["court"],
        court=CaseCourt(name=court_name(latest["courtName"], jurisdiction), courtType=COURT_TYPES[jurisdiction],
                        stateFips=court_state(latest["courtName"]), citation=latest["citation"] or None, ruleId=COURT_STATE_RULE_ID),
        jurisdiction="Federal" if jurisdiction == "FD" else "State",
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
        publication=publication,
        about=AboutText(**about) if about else None,
        matchedTerms=selection.phrases[:MATCHED_TERMS],
        sourceUrl=SITE_ROOT + latest["url"] if latest["url"].startswith("/") else SITE_ROOT,
        sourceId=SOURCE_ID,
        sourcePublishedAt=None,
        firstObservedAt=first_observed or checked_at,
        lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.IMPORTED_SECONDARY, method="automated_secondary_import", checkedAt=checked_at,
            note="Read from the copy of each decision that CourtListener (Free Law Project) holds, not from the court itself, and "
                 "schema-validated. CourtListener does not hold every decision of a court. Not reviewed by a lawyer.",
        ),
        parties=[],
        selection=selection,
        events=events,
        documents=documents,
    )
    hash_basis = {k: v for k, v in LegalCase(**body, contentHash="").model_dump(mode="json").items()
                  if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash"}}
    return LegalCase(**body, contentHash=content_hash(hash_basis))


# --- the scan -----------------------------------------------------------------------------------------

NOT_SELECTED, SELECTED = 0, 1
STATE_FIELDS = ["court", "fingerprint", "documents", "unreadableDocuments", "outcome"]
#: The scan stops, and the published data stays as it was, when more cases than this could not be read
#: (the larger of the number and the share of the cases read in the run) ...
MAX_FAILED_CASES = 25
MAX_FAILED_SHARE = 0.03


@dataclass
class CaseResult:
    docket: int
    entries: List[dict]
    texts: Dict[int, Optional[str]] = field(default_factory=dict)
    evaluation: Optional[dict] = None
    error: Optional[str] = None
    failure: Optional[BaseException] = None


@dataclass
class ScanResult:
    #: The scan state to publish: every case read, with what the rule found.
    state: dict
    #: Cases read in this run that the rule selects.
    selected: Dict[int, CaseResult]
    #: Selected before and not readable in this run: their published records stay as they are.
    kept: List[int]
    failed: Dict[int, str]
    #: Selected before, and no longer among the candidates.
    unlisted: List[int]
    listed: int
    read: int
    full: bool


def read_case(reader: Reader, docket: int, entries: List[dict]) -> CaseResult:
    result = CaseResult(docket=docket, entries=entries)
    try:
        texts = {doc["id"]: reader.text(doc) for entry in entries for doc in entry["documents"]}
        result.evaluation = evaluate(entries, texts)
        if result.evaluation["outcome"]:
            result.texts = texts
        else:
            result.evaluation["counts"] = {}
    except Exception as exc:  # noqa: BLE001 - one unreadable file fails its case, not the scan
        result.error = f"{type(exc).__name__}: {exc}"[:300]
        result.failure = exc
    return result


def court_document(result: CaseResult) -> Optional[int]:
    """The decision of the court whose opening is quoted: the document the selection rests on where it is one, else
    the readable decision of the court (not a separate opinion) with the most election words, the later one on a tie."""
    best = result.evaluation["document"]
    kinds = {doc["id"]: doc["kind"] for entry in result.entries for doc in entry["documents"]}
    if best is None or kinds.get(best) not in SEPARATE_KINDS:
        return best
    counts = result.evaluation.get("counts") or {}
    own = [doc_id for doc_id, kind in kinds.items() if kind not in SEPARATE_KINDS and result.texts.get(doc_id) and doc_id in counts]
    return max(own, key=lambda doc_id: (counts[doc_id]["wordMatches"], doc_id)) if own else None


def opinion_about(reader: Reader, result: CaseResult, earlier: Optional[dict] = None) -> tuple[Optional[dict], Optional[str]]:
    """``(about, problem)`` for a selected case: the opening passage of the decision the selection rests on, by the
    rule for the opening of an opinion (``about-opinion-1``). Only a PDF can be laid out; a decision published as a
    web page gets no passage. ``earlier`` is kept as in ``uscourts.opinion_about``.

    The passage is taken only from a decision of the court, never from the opinion of a single judge beside it: where
    the selection rests on a dissent or a concurrence, the court's own decision with the most election words is laid
    out instead."""
    best = court_document(result)
    found = next(((entry, doc) for entry in result.entries for doc in entry["documents"] if doc["id"] == best), None)
    text = result.texts.get(best) if best is not None else None
    if not found or not text or not _is_pdf(found[1]["path"]):
        return None, None
    entry, doc = found
    url = file_url(doc["path"])
    try:
        layout = reader.layout(doc)
    except Exception as exc:  # noqa: BLE001 - the passage is an addition to the record
        same = (bool(earlier) and earlier.get("source") == "opinion" and earlier.get("url") == url
                and opening.confirmed(earlier.get("text") or "", text))
        outcome = "the passage published before is still in the text of the decision and is kept" if same else "the case is published without one"
        return (earlier if same else None), f"the decision could not be laid out for its opening passage ({type(exc).__name__}: {exc}); {outcome}"[:300]
    passage = opening.opening_passage(layout, text)
    if not passage:
        return None, None
    return about_rules.opinion(passage.text, passage.cut, url=url, date=entry["date"], paragraph=passage.paragraph), None


def cases_of(state: Optional[dict]) -> Dict[int, list]:
    """``{docket: [court, fingerprint, documents, unreadable, outcome]}`` of a published scan state."""
    return {int(docket): entry for docket, entry in ((state or {}).get("cases") or {}).items() if str(docket).isdigit()}


def scan(files: Fetcher, cache: Path, previous: Optional[dict], listing: Listing, *, now: str, workers: int = 4,
         progress: Optional[Callable[[str, int, Optional[int]], None]] = None) -> ScanResult:
    """Read what is new or changed among the candidates, and apply the selection rule.

    ``files`` fetches the copies of the documents. ``previous`` is the published scan state: a case whose decisions
    are unchanged since it was found not to be selected is not read again; a selected case is read on every run.
    ``listing`` is the list of candidates as :func:`refresh_listing` left it.
    """
    usable_state = bool(previous) and previous.get("ruleId") == SELECTION_RULE_ID and previous.get("since") == SINCE \
        and previous.get("query") == SEARCH_QUERY
    before = cases_of(previous) if usable_state else {}
    dockets = group_dockets(listing.entries.values())
    skipped: Dict[str, int] = {}
    for month in listing.months.values():
        for key, count in (month.get("skipped") or {}).items():
            skipped[key] = skipped.get(key, 0) + count

    prints = {docket: fingerprint(entries) for docket, entries in dockets.items()}
    to_read = [docket for docket in sorted(dockets)
               if docket not in before or before[docket][1] != prints[docket] or before[docket][4] != NOT_SELECTED]
    reader = Reader(files, cache, attempts=1)
    results: Dict[int, CaseResult] = {}
    count = itertools.count(1)

    def read(key: str) -> Optional[BaseException]:
        docket = int(key)
        result = read_case(reader, docket, dockets[docket])
        first = docket not in results
        results[docket] = result
        done = next(count) if first else 0
        if progress and first and (done % 200 == 0 or done == len(to_read)):
            progress("read", done, len(to_read))
        return result.failure

    in_rounds(files, [str(docket) for docket in to_read], read, what="decisions on CourtListener", workers=workers)

    failed = {docket: result.error for docket, result in results.items() if result.error}
    if len(failed) > max(MAX_FAILED_CASES, MAX_FAILED_SHARE * len(to_read)):
        first = next(iter(failed.items()))
        raise RuntimeError(f"{len(failed)} of {len(to_read)} cases could not be read (first: {case_id(first[0])}: {first[1]})")

    cases: Dict[str, list] = {}
    selected: Dict[int, CaseResult] = {}
    kept: List[int] = []
    for docket in sorted(dockets):
        court = dockets[docket][0]["court"]
        result = results.get(docket)
        if result is None or result.error:
            if docket in before:
                cases[str(docket)] = before[docket]
                if result is not None and before[docket][4] != NOT_SELECTED:
                    kept.append(docket)
            continue
        evaluation = result.evaluation
        outcome = SELECTED if evaluation["outcome"] == "selected" else NOT_SELECTED
        cases[str(docket)] = [court, prints[docket], evaluation["documents"], evaluation["unreadable"], outcome]
        if outcome == SELECTED:
            selected[docket] = result
    unlisted = sorted(docket for docket, entry in before.items() if docket not in dockets and entry[4] == SELECTED)
    courts: Dict[str, dict] = {}
    for entries in dockets.values():
        first = entries[0]
        courts.setdefault(first["court"], {"name": court_name(first["courtName"], first["jurisdiction"]),
                                           "courtType": COURT_TYPES[first["jurisdiction"]],
                                           "stateFips": court_state(first["courtName"])})
    candidates = sum(month.get("candidates", 0) for month in listing.months.values())
    state = {
        "ruleId": SELECTION_RULE_ID, "since": SINCE, "query": SEARCH_QUERY, "scannedAt": now, "fields": STATE_FIELDS,
        "outcomes": {"0": "not selected", "1": "selected"},
        "candidates": candidates, "skipped": dict(sorted(skipped.items())), "courts": dict(sorted(courts.items())),
        "cases": cases, "listing": listing.document(),
    }
    return ScanResult(state=state, selected=selected, kept=sorted(kept), failed=failed, unlisted=unlisted,
                      listed=candidates, read=len(to_read), full=not usable_state)


def coverage(state: dict) -> Dict[str, dict]:
    """For each court with a candidate: its name, kind and state, how many cases and documents were read, and what
    the rule made of them."""
    table: Dict[str, dict] = {court: {**info, "cases": 0, "documents": 0, "unreadableDocuments": 0, "selected": 0}
                              for court, info in (state.get("courts") or {}).items()}
    for entry in (state.get("cases") or {}).values():
        row = table.get(entry[0])
        if row is None:
            continue
        row["cases"] += 1
        row["documents"] += entry[2]
        row["unreadableDocuments"] += entry[3]
        row["selected"] += int(entry[4] == SELECTED)
    return table


def selection_document() -> dict:
    """The selection rule as published with the data, so that every number shown beside a case can be checked."""
    return {
        "ruleId": SELECTION_RULE_ID, "since": SINCE, "searchTerms": list(SEARCH_TERMS), "courtTypes": COURT_TYPES,
        "courtStateRuleId": COURT_STATE_RULE_ID, "textRuleId": uscourts.SELECTION_RULE_ID,
        "wordPattern": uscourts.WORD_PATTERN.pattern, "phrasePattern": uscourts.PHRASE_PATTERN.pattern,
        "authorityPattern": uscourts.AUTHORITY_PATTERN.pattern, "laborPattern": uscourts.LABOR_PATTERN.pattern,
        "textTests": uscourts.TEXT_TESTS, "laborMinMatches": uscourts.LABOR_MIN_MATCHES, "laborRatio": uscourts.LABOR_RATIO,
    }
