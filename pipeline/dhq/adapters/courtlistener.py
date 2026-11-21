"""CourtListener (Free Law Project): the address of its search and the token it needs.

The token is read from ``COURTLISTENER_API_TOKEN``. Without it :func:`token` raises :class:`CredentialMissing` and the
pipeline records ``credential_missing``; nothing is fabricated. What is read from CourtListener, and how, is in
``cl_opinions``.
"""

from __future__ import annotations

import os

from ..http import CredentialMissing

SOURCE_ID = "courtlistener-api"
API_ROOT = "https://www.courtlistener.com/api/rest/v4/"
SEARCH_URL = API_ROOT + "search/"
ENV = "COURTLISTENER_API_TOKEN"


def token() -> str:
    value = os.environ.get(ENV, "").strip()
    if not value:
        raise CredentialMissing(f"{ENV} is not set")
    return value
