"""Dockets of voting cases in the federal district courts, from the RECAP Archive on CourtListener.

The ninety-four federal district courts keep their dockets on PACER, which charges for every page. The RECAP Archive
of the Free Law Project (https://www.courtlistener.com/recap/) holds the copies of dockets and filings that its users
and its own programs have bought or been given. CourtListener's collection of decisions holds the opinions of very few
district courts for recent years, so a case of a district court is found here by its docket, not by a decision.

What this adapter does:

* It asks CourtListener's search for the dockets filed since ``SINCE`` to which the court's clerk gave the nature of
  suit 441, "Civil Rights: Voting" (``SELECTION_RULE_ID``). The clerk's code selects the case; nothing is counted and
  nothing is judged by this project.
* Of those it keeps the dockets of federal district courts whose court it can place in a state by the court's name.
* For each it reads the docket entries the archive holds and builds one record: every entry with its date and the
  clerk's text, and a link to each filing of which the archive holds a copy.

What it does not do: it buys nothing from PACER. The archive holds what somebody has put there, so a docket may lack
its latest entries or most of its filings, and a case nobody has opened on PACER through RECAP is not there at all. A
case the clerk filed under another nature of suit is not found by this rule. Every record says that it comes from the
archive and not from the court (``imported_secondary``).

Privacy: the case title and the clerk's entries are published as the archive gives them. The lists of parties and of
lawyers that the archive also holds are not read.
"""

from __future__ import annotations

import logging
import re
from typing import Callable, Dict, List, Optional

from .. import classify
from ..http import FetchError, Fetcher
from ..schemas import (
    CaseCourt,
    CaseSelection,
    CourtDocument,
    EvidenceRef,
    LegalCase,
    LegalEvent,
    LowerCourtInfo,
    Verification,
    VerificationStatus,
)
from ..util import content_hash
from . import cl_opinions
from .cl_opinions import Budget, ListingError, RateLimited
from .courtlistener import API_ROOT, SEARCH_URL, token

log = logging.getLogger("dhq.cl_dockets")

SOURCE_ID = cl_opinions.SOURCE_ID
SINCE = cl_opinions.SINCE
ENTRIES_URL = API_ROOT + "docket-entries/"

SELECTION_RULE_ID = "docket-select-1"
#: The nature of suit a clerk gives a voting case when it is filed in a federal district court.
NATURE_CODE = "441"
SEARCH_QUERY = f'suitNature:"{NATURE_CODE}"'
#: What ``docketType`` says of a record made from a docket of the archive. The site words such a record differently
#: from one made from decisions.
DOCKET_TYPE = "recap"
ENTRY_RULE_ID = "recap-entry-1"
#: A run asks CourtListener for at most this many pages of dockets and docket entries, twenty entries a page, at the
#: pace of the search (``cl_opinions.SEARCH_INTERVAL``). With the search's own requests a run stays well under the
#: thousand an hour the token is allowed. Dockets that are not read in a run keep their published record and are read
#: on a later one, those never read first.
REQUESTS_PER_RUN = 300
#: A list of dockets that holds less than this share of the dockets published before is not believed.
MIN_LISTING_SHARE = 0.5
#: The clerk's text of an entry is published up to this many characters.
MAX_ENTRY_TEXT = 4000
#: Fields of the answer that are not read and would make it many times larger.
OMIT = "recap_documents__plain_text,recap_documents__tags,tags"

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NATURE_RE = re.compile(rf"^{NATURE_CODE}(?:\s+(.*))?$")
_SPACE_RE = re.compile(r"\s+")


def _text(value: object) -> str:
    return _SPACE_RE.sub(" ", value).strip() if isinstance(value, str) else ""


def _day(value: object) -> Optional[str]:
    return value if isinstance(value, str) and _DAY_RE.match(value) else None


def compact(item: dict) -> Optional[dict]:
    """One search result (a docket) with the fields that are used, or ``None`` when the rule does not take it: it is
    not a docket of a federal district court that can be placed in a state, the clerk's nature of suit is not 441
    (the search also returns the appellate codes 1441, 2441 and 3441), or it lacks an id, a title, a number or the
    day it was filed."""
    docket, filed = item.get("docket_id"), _day(item.get("dateFiled"))
    court_name, name, number = _text(item.get("court")), _text(item.get("caseName")), _text(item.get("docketNumber"))
    nature = _NATURE_RE.match(_text(item.get("suitNature")))
    if not isinstance(docket, int) or not filed or filed < SINCE or not item.get("court_id") or not name or not number or not nature:
        return None
    if not court_name.startswith("District Court, ") or not cl_opinions.court_state(court_name):
        return None
    url = item.get("docket_absolute_url")
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    return {
        "docket": docket, "court": str(item["court_id"]), "courtName": court_name, "citation": _text(item.get("court_citation_string")),
        "name": name, "docketNumber": number, "filed": filed, "terminated": _day(item.get("dateTerminated")),
        "nature": _text(nature.group(1)), "cause": _text(item.get("cause")),
        "url": url if isinstance(url, str) and url.startswith("/docket/") else "",
        # When CourtListener last changed its record of the docket: a docket whose stamp has not moved is not read again.
        "stamp": _text(meta.get("timestamp")),
    }


def list_dockets(fetcher: Fetcher, budget: Budget) -> Optional[List[dict]]:
    """Every docket the rule takes, or ``None`` when the run's requests ran out before the list was read whole."""
    headers = {"Authorization": f"Token {token()}"}
    url: Optional[str] = SEARCH_URL
    params: Optional[dict] = {"type": "d", "q": SEARCH_QUERY, "filed_after": SINCE, "order_by": "dateFiled desc"}
    found: Dict[int, dict] = {}
    while url:
        if not budget.take():
            return None
        payload = cl_opinions._page(fetcher, url, params, headers)
        for item in payload["results"]:
            entry = compact(item) if isinstance(item, dict) else None
            if entry:
                found.setdefault(entry["docket"], entry)
        url, params = payload.get("next"), None
        if url and not (isinstance(url, str) and url.startswith(SEARCH_URL)):
            raise FetchError(str(url), None, "the response names a next page outside CourtListener's search; it was not requested")
    return sorted(found.values(), key=lambda entry: entry["docket"])


def read_entries(fetcher: Fetcher, docket: int, budget: Budget) -> Optional[List[dict]]:
    """The docket entries the archive holds for one docket, in the order of the docket, or ``None`` when the run's
    requests ran out before all of them were read. A docket is only ever taken whole."""
    headers = {"Authorization": f"Token {token()}"}
    url: Optional[str] = ENTRIES_URL
    params: Optional[dict] = {"docket": str(docket), "order_by": "recap_sequence_number,entry_number", "omit": OMIT}
    entries: List[dict] = []
    while url:
        if not budget.take():
            return None
        payload = cl_opinions._page(fetcher, url, params, headers)
        entries.extend(item for item in payload["results"] if isinstance(item, dict))
        url, params = payload.get("next"), None
        if url and not (isinstance(url, str) and url.startswith(ENTRIES_URL)):
            raise FetchError(str(url), None, "the response names a next page outside CourtListener's docket entries; it was not requested")
    return entries


def _entry_text(entry: dict) -> str:
    """The clerk's text of an entry. Where the archive holds none (an entry known only from a filing's notice), the
    short descriptions of its documents stand in, and where there are none of those either, a line that says so."""
    text = _text(entry.get("description"))
    if not text:
        text = "; ".join(filter(None, (_text(doc.get("description")) for doc in entry.get("recap_documents") or [] if isinstance(doc, dict))))
    if not text:
        return "The archive holds no text for this entry."
    return text if len(text) <= MAX_ENTRY_TEXT else text[:MAX_ENTRY_TEXT].rsplit(" ", 1)[0] + " …"


def build_case(docket: dict, entries: List[dict], *, checked_at: str, first_observed: Optional[str] = None) -> LegalCase:
    """The record of one docket: every dated entry the archive holds, and each filing it holds a copy of."""
    cid = cl_opinions.case_id(docket["docket"])
    page = cl_opinions.SITE_ROOT + docket["url"] if docket["url"] else cl_opinions.SITE_ROOT + "/"
    events: List[LegalEvent] = []
    documents: List[CourtDocument] = []
    held = 0
    for entry in entries:
        day = _day(entry.get("date_filed"))
        if not day:
            continue
        number = entry.get("entry_number")
        document_ids: List[str] = []
        for doc in entry.get("recap_documents") or []:
            if not isinstance(doc, dict):
                continue
            held += 1
            url = cl_opinions.file_url(str(doc.get("filepath_local") or "")) if doc.get("is_available") else None
            if not url:
                continue
            attachment = doc.get("attachment_number")
            label = f"Document {doc.get('document_number') or number or ''}".strip() + (f", attachment {attachment}" if attachment else "")
            title = _text(doc.get("description"))
            document_id = f"{cid}-d{len(documents) + 1}"
            documents.append(CourtDocument(
                id=document_id, caseId=cid, entryIndex=len(events), title=f"{label}: {title}"[:300] if title else label, filingDate=day,
                documentType="Attachment" if attachment else "Filing", url=url, availability="public_link",
                accessNote="CourtListener's copy of the filing, from the RECAP Archive. Not fetched from the court.",
            ))
            document_ids.append(document_id)
        events.append(LegalEvent(
            id=f"{cid}-e{len(events) + 1}", eventType="docket_entry", date=day, entityType="case", entityId=cid,
            description=(f"{number}. " if isinstance(number, int) else "") + _entry_text(entry), significance="routine",
            classificationRule=ENTRY_RULE_ID, evidence=EvidenceRef(url=page, sourceId=SOURCE_ID, document="The docket as the RECAP Archive holds it"),
            documentIds=document_ids,
        ))
    dates = [event.date for event in events] or [docket["filed"]]
    name = docket["courtName"]
    body = dict(
        id=cid,
        externalIds={"courtlistenerDocketId": str(docket["docket"])},
        caseName=docket["name"],
        petitionerTitle="",
        respondentTitle="",
        docketNumber=docket["docketNumber"],
        courtId=docket["court"],
        court=CaseCourt(name=cl_opinions.court_name(name, "FD"), courtType="federal_district", stateFips=cl_opinions.court_state(name),
                        citation=docket["citation"] or None, ruleId=cl_opinions.COURT_STATE_RULE_ID),
        jurisdiction="Federal",
        docketType=DOCKET_TYPE,
        dateDocketed=docket["filed"],
        dateFirstEntry=min(dates),
        sourceLastActivity=max(dates),
        entryCount=len(events),
        documentCount=len(documents),
        issueTags=classify.classify([("case title", docket["name"])]),
        lowerCourt=LowerCourtInfo(),
        latestDispositiveEntry=None,
        stateFips=[],
        natureOfSuit=f"{NATURE_CODE} {docket['nature']}".strip(),
        sourceUrl=page,
        sourceId=SOURCE_ID,
        sourcePublishedAt=docket["stamp"] or None,
        firstObservedAt=first_observed or checked_at,
        lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.IMPORTED_SECONDARY, method="automated_secondary_import", checkedAt=checked_at,
            note="Read from the docket as the RECAP Archive on CourtListener (Free Law Project) holds it, not from the court's own "
                 f"system (PACER), and schema-validated. The archive holds {held} document record(s) for the entries read and a copy of "
                 f"{len(documents)} of them; it may lack the latest entries. Not reviewed by a lawyer.",
        ),
        parties=[],
        selection=CaseSelection(ruleId=SELECTION_RULE_ID, tests=["record"], natureOfSuitCode=NATURE_CODE, natureOfSuit=docket["nature"] or None),
        events=events,
        documents=documents,
    )
    hash_basis = {k: v for k, v in LegalCase(**body, contentHash="").model_dump(mode="json").items()
                  if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash"}}
    return LegalCase(**body, contentHash=content_hash(hash_basis))


class Refresh:
    """What one run made of the dockets."""

    def __init__(self) -> None:
        #: Every docket the rule takes, by CourtListener's number; ``None`` when the list could not be read in this run.
        self.listed: Optional[Dict[int, dict]] = None
        #: Records built in this run, by case id.
        self.built: Dict[str, LegalCase] = {}
        #: Dockets that could not be read, with the reason.
        self.failed: Dict[int, str] = {}
        #: Listed dockets that are neither built in this run nor published and unchanged: they wait for a later run.
        self.waiting: List[int] = []
        #: Why the run stopped asking, when it did.
        self.limited: Optional[str] = None
        self.requests = 0


def is_docket_record(record: Optional[dict]) -> bool:
    return bool(record) and record.get("docketType") == DOCKET_TYPE


def refresh(fetcher: Fetcher, published: Dict[str, dict], *, now: str, requests: int = REQUESTS_PER_RUN,
            progress: Optional[Callable[[int, int], None]] = None) -> Refresh:
    """List the dockets and read as many of them as the run's requests allow.

    ``published`` holds the records published before that were made from a docket, by case id. A docket that has no
    such record is read first, the newest first; then the dockets whose record CourtListener has changed since they
    were read. A docket whose stamp has not moved keeps its record without a request.
    """
    result = Refresh()
    budget = Budget(requests)
    try:
        listed = list_dockets(fetcher, budget)
    except RateLimited as exc:
        result.limited = str(exc)
        listed = None
    if listed is None:
        result.limited = result.limited or "the requests of the run were used up before the list of dockets was read"
        result.requests = budget.used
        return result
    if published and len(listed) < MIN_LISTING_SHARE * len(published):
        raise ListingError(f"CourtListener's search lists {len(listed)} dockets, less than half of the {len(published)} published before")
    result.listed = {docket["docket"]: docket for docket in listed}

    def stale(docket: dict) -> bool:
        before = published.get(cl_opinions.case_id(docket["docket"]))
        return not before or not docket["stamp"] or before.get("sourcePublishedAt") != docket["stamp"]

    queue = sorted((docket for docket in listed if stale(docket)),
                   key=lambda docket: (cl_opinions.case_id(docket["docket"]) in published, tuple(-ord(c) for c in docket["filed"]), docket["docket"]))
    for position, docket in enumerate(queue):
        cid = cl_opinions.case_id(docket["docket"])
        if result.limited:
            if cid not in published:
                result.waiting.append(docket["docket"])
            continue
        try:
            entries = read_entries(fetcher, docket["docket"], budget)
        except RateLimited as exc:
            result.limited = str(exc)
            entries = None
        except (FetchError, ListingError) as exc:
            result.failed[docket["docket"]] = f"{type(exc).__name__}: {exc}"[:300]
            continue
        if entries is None:
            result.limited = result.limited or "the requests of the run were used up"
            if cid not in published:
                result.waiting.append(docket["docket"])
            continue
        result.built[cid] = build_case(docket, entries, checked_at=now, first_observed=(published.get(cid) or {}).get("firstObservedAt"))
        if progress:
            progress(position + 1, len(queue))
    result.requests = budget.used
    return result


def selection_document() -> dict:
    """The rule as published with the data."""
    return {"ruleId": SELECTION_RULE_ID, "since": SINCE, "query": SEARCH_QUERY, "natureOfSuitCode": NATURE_CODE,
            "courtStateRuleId": cl_opinions.COURT_STATE_RULE_ID, "entryRuleId": ENTRY_RULE_ID}
