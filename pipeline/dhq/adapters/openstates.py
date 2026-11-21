"""Open States / Plural Open API v3 - optional, key-gated bill metadata.

Activated by ``OPENSTATES_API_KEY``. Used for breadth (other states) while the
deep, text-level tracking comes from official state bulk data. Imported bills
are secondary-source records with link-only versions.
"""

from __future__ import annotations

import os
import re
from typing import List, Optional

from ..http import CredentialMissing, Fetcher
from ..schemas import LegislativeInstrumentSummary, LegislativeStatus, Verification, VerificationStatus
from ..util import STATE_BY_NAME, STATES

SOURCE_ID = "openstates-api"
BILLS_URL = "https://v3.openstates.org/bills"
ENV = "OPENSTATES_API_KEY"


def api_key() -> str:
    value = os.environ.get(ENV, "").strip()
    if not value:
        raise CredentialMissing(f"{ENV} is not set")
    return value


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _day(value: object) -> Optional[str]:
    return value[:10] if isinstance(value, str) and _DATE.match(value) else None


def normalise_bill(item: dict, *, checked_at: str) -> Optional[LegislativeInstrumentSummary]:
    jurisdiction = (item.get("jurisdiction") or {}).get("name", "")
    fips = STATE_BY_NAME.get(jurisdiction.lower())
    if not fips:
        return None  # not a state we can place; skipped rather than guessed
    sources = item.get("sources") or []
    official = sources[0]["url"] if sources else item.get("openstates_url")
    if not official or not official.startswith("https://") or not (item.get("identifier") or "").strip():
        return None  # nothing a reader could cite or open safely
    return LegislativeInstrumentSummary(
        id="os-" + item["id"].replace("ocd-bill/", ""),
        state=fips, stateAbbr=STATES[fips][0], session=str(item.get("session", "")),
        identifier=item.get("identifier", ""), measureType=", ".join(item.get("classification") or []) or "bill",
        title=item.get("title"), subject="; ".join(item.get("subject") or []) or None, leadAuthors=None,
        legislativeStatus=LegislativeStatus(currentStatus=item.get("latest_action_description")),
        chapter=None, introducedDate=_day(item.get("first_action_date")),
        lastActionDate=_day(item.get("latest_action_date")),
        lastActionText=item.get("latest_action_description"),
        versionCount=len(item.get("versions") or []), issueTags=[], officialUrl=official, sourceId=SOURCE_ID,
        firstObservedAt=checked_at, lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.IMPORTED_SECONDARY, method="automated_secondary_import", checkedAt=checked_at,
            note="Imported from Open States; compare with the linked official bill page.",
        ),
    )


def search_bills(fetcher: Fetcher, jurisdiction: str, query: str, *, checked_at: str, max_pages: int = 2) -> List[LegislativeInstrumentSummary]:
    # The Fetcher follows a redirect of a request that carries this key only to the same host over https.
    headers = {"X-API-KEY": api_key()}
    out: dict[str, LegislativeInstrumentSummary] = {}
    for page in range(1, max_pages + 1):
        payload = fetcher.get(BILLS_URL, headers=headers, params={
            "jurisdiction": jurisdiction, "q": query, "page": page, "per_page": 20,
            "include": ["sources", "versions"], "sort": "latest_action_desc",
        }).json()
        for item in payload.get("results") or []:
            bill = normalise_bill(item, checked_at=checked_at)
            if bill:
                out.setdefault(bill.id, bill)
        if page >= (payload.get("pagination") or {}).get("max_page", 1):
            break
    return list(out.values())
