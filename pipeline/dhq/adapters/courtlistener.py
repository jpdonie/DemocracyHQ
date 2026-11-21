"""CourtListener / RECAP (Free Law Project) - optional, token-gated.

Activated by ``COURTLISTENER_API_TOKEN``. Without it the adapter raises
:class:`CredentialMissing` and the pipeline records ``credential_missing``;
nothing is fabricated. Imported dockets are secondary-source records: they are
labelled ``imported_secondary`` and carry no geographic scope until a
maintainer adds one with evidence.

IMPORTANT: CourtListener is not a complete or real-time mirror of court
filings. ``sourceLastActivity`` therefore means "latest filing CourtListener
knows about", never "nothing has happened since".
"""

from __future__ import annotations

import os
import re
from typing import Iterable, List, Optional

from ..http import CredentialMissing, FetchError, Fetcher
from ..schemas import LegalCaseSummary, LowerCourtInfo, Verification, VerificationStatus

SOURCE_ID = "courtlistener-api"
API_ROOT = "https://www.courtlistener.com/api/rest/v4/"
SEARCH_URL = API_ROOT + "search/"
ENV = "COURTLISTENER_API_TOKEN"


def token() -> str:
    value = os.environ.get(ENV, "").strip()
    if not value:
        raise CredentialMissing(f"{ENV} is not set")
    return value


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _day(value: object) -> Optional[str]:
    """The ``YYYY-MM-DD`` part of a date or timestamp; ``None`` for anything else."""
    return value[:10] if isinstance(value, str) and _DATE.match(value) else None


def normalise_result(item: dict, *, checked_at: str, first_observed: Optional[str] = None) -> Optional[LegalCaseSummary]:
    """One search result as a secondary-source record, or ``None`` when it has no docket number.

    A docket that cannot be cited is left out rather than published with a made-up number.
    """
    if not (item.get("docketNumber") or "").strip():
        return None
    docket_id = str(item["docket_id"])
    docs = item.get("recap_documents") or []
    filed_dates = sorted(day for day in (_day(d.get("entry_date_filed")) for d in docs) if day)
    absolute = item.get("docket_absolute_url") or f"/docket/{docket_id}/"
    return LegalCaseSummary(
        id=f"cl-{docket_id}",
        externalIds={"courtlistenerDocketId": docket_id, **({"pacerCaseId": str(item["pacer_case_id"])} if item.get("pacer_case_id") else {})},
        caseName=item.get("caseName") or "Untitled docket",
        petitionerTitle="", respondentTitle="",
        docketNumber=item["docketNumber"].strip(),
        courtId=f"cl-{item.get('court_id', 'unknown')}",
        jurisdiction="Federal",
        docketType=None,
        dateDocketed=_day(item.get("dateFiled")),
        dateFirstEntry=filed_dates[0] if filed_dates else None,
        # Only what the archive has seen; see module docstring.
        sourceLastActivity=filed_dates[-1] if filed_dates else None,
        entryCount=0, documentCount=len(docs), issueTags=[],
        lowerCourt=LowerCourtInfo(),
        latestDispositiveEntry=None,  # never inferred from dateTerminated or similar metadata
        stateFips=[],
        sourceUrl="https://www.courtlistener.com" + absolute,
        sourceId=SOURCE_ID, sourcePublishedAt=None,
        firstObservedAt=first_observed or checked_at, lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.IMPORTED_SECONDARY, method="automated_secondary_import", checkedAt=checked_at,
            note="Imported from CourtListener/RECAP, which is not a complete record of the court's docket.",
        ),
    )


def search_dockets(fetcher: Fetcher, query: str, *, checked_at: str, max_pages: int = 3) -> List[LegalCaseSummary]:
    """Run one RECAP docket search (``type=r``) following cursor pagination."""
    headers = {"Authorization": f"Token {token()}"}
    url: Optional[str] = SEARCH_URL
    params: Optional[dict] = {"q": query, "type": "r", "order_by": "dateFiled desc"}
    seen: dict[str, LegalCaseSummary] = {}
    for _ in range(max_pages):
        if not url:
            break
        payload = fetcher.get(url, headers=headers, params=params).json()
        for item in payload.get("results") or []:
            if "docket_id" not in item:
                continue
            case = normalise_result(item, checked_at=checked_at)
            if case:
                seen.setdefault(case.id, case)  # de-duplicate across pages and queries
        url, params = payload.get("next"), None
        if url and not (isinstance(url, str) and url.startswith(API_ROOT)):
            # The token goes with every request, so a page address is followed only on the API itself.
            raise FetchError(str(url), None, "the response names a next page outside the CourtListener API; it was not requested")
    return list(seen.values())


def run(fetcher: Fetcher, queries: Iterable[str], *, checked_at: str) -> List[LegalCaseSummary]:
    merged: dict[str, LegalCaseSummary] = {}
    for query in queries:
        for case in search_dockets(fetcher, query, checked_at=checked_at):
            merged.setdefault(case.id, case)
    return sorted(merged.values(), key=lambda c: c.id)
