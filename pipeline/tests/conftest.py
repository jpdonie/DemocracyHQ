"""Shared test helpers.

SYNTHETIC TEST DATA. Every docket, bill, count and URL built in this folder is invented
for the tests. None of it describes a real case, measure or place, and none of it is
written to ``public/data``. No test request leaves the machine: an autouse fixture replaces the real
transport so an accidental request fails the test (the network-layer tests in
test_network_limits.py talk only to servers they start on 127.0.0.1).
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Callable, Dict, List, Optional, Union

import pytest
import requests

from dhq.http import Fetcher


class FakeResponse:
    def __init__(self, status: int = 200, content: Union[bytes, str, dict, list] = b"", headers: Optional[dict] = None):
        if isinstance(content, DocketPayload):
            content = render_docket_page(content)
        if isinstance(content, (dict, list)):
            content = json.dumps(content)
        if isinstance(content, str):
            content = content.encode("utf-8")
        self.status_code = status
        self.body = content
        self.headers = headers or {}
        #: Bytes the client actually read from the body, streamed or through ``content``.
        self.bytes_read = 0

    @property
    def content(self) -> bytes:
        """The whole body at once, as ``requests`` reads it for a request that is not streamed."""
        self.bytes_read += len(self.body)
        return self.body

    def iter_content(self, chunk_size: int = 1):
        for start in range(0, len(self.body), chunk_size):
            chunk = self.body[start : start + chunk_size]
            self.bytes_read += len(chunk)
            yield chunk

    def close(self) -> None:
        pass


Handler = Union[FakeResponse, Exception, Callable[[str, dict, Optional[dict]], FakeResponse]]


class FakeSession:
    """Stands in for ``requests.Session``. Each URL has a queue of scripted answers.

    The last answer in a queue repeats, so ``[error, error, ok]`` models a source that
    recovers and ``[ok]`` models one that always answers.
    """

    def __init__(self) -> None:
        self.routes: Dict[str, List[Handler]] = {}
        self.calls: List[dict] = []

    def on(self, url: str, *answers: Handler) -> "FakeSession":
        self.routes[url] = list(answers)
        return self

    def serve_bytes(self, url: str, data: bytes, last_modified: str = "Mon, 01 Jun 2026 08:00:00 GMT") -> "FakeSession":
        """Serve ``data`` with byte-range support, like a static file server."""

        def handler(_url: str, headers: dict, _params: Optional[dict]) -> FakeResponse:
            spec = headers.get("Range")
            if not spec:
                return FakeResponse(200, data)
            start, end = (int(x) for x in spec.replace("bytes=", "").split("-"))
            end = min(end, len(data) - 1)
            return FakeResponse(206, data[start : end + 1], {"Content-Range": f"bytes {start}-{end}/{len(data)}"})

        self.routes[url] = [handler]
        self.routes["HEAD " + url] = [FakeResponse(200, b"", {"Accept-Ranges": "bytes", "Content-Length": str(len(data)), "Last-Modified": last_modified})]
        return self

    def _answer(self, key: str, url: str, headers: dict, params: Optional[dict]) -> FakeResponse:
        queue = self.routes.get(key)
        if queue is None:
            return FakeResponse(404, b"not scripted")
        answer = queue[0] if len(queue) == 1 else queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            return answer(url, headers, params)
        return answer

    def get(self, url, headers=None, params=None, timeout=None, stream=False):  # noqa: ANN001 - mirrors requests
        self.calls.append({"method": "GET", "url": url, "headers": dict(headers or {}), "params": params, "timeout": timeout, "stream": stream})
        response = self._answer(url, url, headers or {}, params)
        if not stream:
            response.content  # noqa: B018 - requests reads the whole body before it returns a response that is not streamed
        return response

    def head(self, url, headers=None, timeout=None, allow_redirects=True):  # noqa: ANN001
        self.calls.append({"method": "HEAD", "url": url, "headers": dict(headers or {})})
        return self._answer("HEAD " + url, url, headers or {}, None)

    def urls(self, method: str = "GET") -> List[str]:
        return [c["url"] for c in self.calls if c["method"] == method]


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Any request that reaches the real transport fails the test."""

    def refuse(self, request, **kwargs):  # noqa: ANN001
        raise AssertionError(f"test tried to reach the network: {request.url}")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", refuse)
    for name in ("COURTLISTENER_API_TOKEN", "OPENSTATES_API_KEY", "DHQ_USER_AGENT", "DHQ_NOW"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def session() -> FakeSession:
    return FakeSession()


@pytest.fixture
def sleeps() -> List[float]:
    return []


@pytest.fixture
def fetcher(session, sleeps) -> Fetcher:
    return Fetcher(session=session, retries=2, backoff=1.5, sleep=sleeps.append)


def make_zip(members: Dict[str, Union[bytes, str]], compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def tree(root: Path) -> Dict[str, bytes]:
    """Every file under ``root`` with its bytes, for byte-for-byte comparisons."""
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


# --- synthetic Supreme Court docket ---------------------------------------------------

SC = "https://www.supremecourt.gov"


class DocketPayload(dict):
    """A synthetic docket. Handed to :class:`FakeResponse`, it is served as a docket page."""


def render_docket_page(payload: dict) -> str:
    """Lay a synthetic docket out the way the Court's public docket page is laid out.

    The markup below copies the structure of the real page (the docket information
    table, one ``ProceedingItem`` table per entry, unquoted addresses on the filing
    links) so that the adapter's page reader is tested against the same shapes. The
    content is invented.
    """
    def esc(value: object) -> str:
        return str(value or "").replace("&", "&amp;")

    number = payload["CaseNumber"]
    related = payload.get("RelatedCaseNumber") or []
    vide = ""
    if related:
        vide = f"\n {related[0]['RelatedType']}\n " + ", ".join(r["DisplayCaseNumber"] for r in related) + "\n "
    rows = [f"""<tr>
 <td width="200"><span>Docketed:</span></td>
 <td><span>{esc(payload.get('DocketedDate'))}</span></td>
 </tr>"""]
    if payload.get("Links"):
        rows.append(f"""<tr id="dip">
 <td width="200"><span>Linked with:</span></td>
 <td><span>{esc(str(payload['Links']).replace('Linked with ', ''))}</span></td>
 </tr>""")
    for label, key in (("Lower Ct:", "LowerCourt"), ("&nbsp;&nbsp;&nbsp;Case Numbers:", "LowerCourtCaseNumbers"),
                       ("&nbsp;&nbsp;&nbsp;Decision Date:", "LowerCourtDecision"), ("&nbsp;&nbsp;&nbsp;Rehearing Denied:", "LowerCourtRehearingDenied")):
        if payload.get(key):
            rows.append(f"""<tr>
 <td width="200"><span>{label}</span></td>
 <td><span>{esc(payload[key])}
 </span></td>
 </tr>""")
    if payload.get("QPLink"):
        rows.append(f"""<tr>
 <td colspan="2"><span><a href="{payload['QPLink']}">Questions Presented</a> </span></td>
 </tr>""")
    cards = []
    for entry in payload.get("ProceedingsandOrder") or []:
        anchors = "".join(f"""
                                    <a  href= {link.get('DocumentUrl', '')}
                                    class="documentanchor" target="_blank">{esc(link.get('Description'))}</a>
                                """ for link in entry.get("Links") or [])
        cards.append(f"""
        <div class="card">
            <table class="ProceedingItem">
                <tr>
                    <td class="ProceedingDate">{esc(entry.get('Date'))}</td>
                    <td>{entry.get('Text') or ''} <br />
                        <span class="documentlinks">
                            {anchors}
                        </span>
                    </td>
                </tr>
            </table>
          </div>
""")
    counsel = "".join(f"<tr><td>{c['Attorney']}</td><td>{c['Address']}, {c['City']}</td><td>{c['Phone']}</td><td>{c['Email']}</td></tr>"
                      for c in payload.get("Petitioner") or [] if isinstance(c, dict))
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<title>Docket for {number} </title>
<META name='creation_date' content='{payload.get('sJsonCreationDate') or ''}'>
<META name='CaseType' content='{payload.get('sJsonCaseType') or ''}'>
<META name='Petitioner' content='{esc(payload.get('PetitionerTitle'))}'>
<META name='Respondent' content='{esc(payload.get('RespondentTitle'))}'>
<META name='Docketed' content='{esc(payload.get('DocketedDate'))}'>
</head><body>
<table id="docketinfo" class="Basic-Table table"><tr><td><a href='/rss/cases/{number}.xml'>RSS</a></td></tr>
 <tbody>
 <tr>
 <td class="InfoTitle" colspan="2"><span class="DocketInfoTitle">No. {number} <br /></span><span
 class="DocketInfoTitle"><span><span>{vide}</span></span></span></td>
 </tr>
 <tr>
 <td width="200"><span>Title:</span></td>
 <td>
 <span class="title">{payload.get('PetitionerTitle') or ''}<br />
 v. <br /> {payload.get('RespondentTitle') or ''}
 </span>
 </td>
 </tr>
 {''.join(rows)}
 </tbody>
 </table>
    <div id="proceedings" class="col-lg-8">
      <div class="coloredheader">Proceedings and Orders</div>
{''.join(cards)}
    </div>
    <table class="ContactTable">{counsel}</table>
</body></html>"""


def synthetic_docket(number: str = "99-0001", *, entries: Optional[List[dict]] = None, qp: bool = True, **overrides) -> dict:
    """A synthetic docket, keyed the way the adapter's page reader returns one. Invented content."""
    payload = DocketPayload({
        "CaseNumber": number,
        "sJsonCaseType": "Paid",
        "sJsonCreationDate": "06/01/2026",
        "DocketedDate": "January 10, 2026",
        "PetitionerTitle": "Synthetic Alpha, et al., Petitioners",
        "RespondentTitle": "Synthetic Beta, Secretary of State of Synthetica",
        "LowerCourt": "United States Court of Appeals for the Synthetic Circuit",
        "LowerCourtCaseNumbers": "(25-9999, 25-9998)",
        "LowerCourtDecision": "October 1, 2025",
        "LowerCourtRehearingDenied": "",
        "QPLink": f"../qp/{number}qp.pdf" if qp else None,
        "RelatedCaseNumber": [],
        "ProceedingsandOrder": entries if entries is not None else [
            {"Date": "Jan 05 2026", "Text": "Petition for a writ of certiorari filed. (Response due February 9, 2026)",
             "Links": [{"Description": "Petition", "File": "Petition.pdf", "DocumentUrl": f"{SC}/DocketPDF/99/{number}/1/petition.pdf"},
                       {"Description": "Proof of Service", "File": "pos.pdf", "DocumentUrl": "https://files.example.test/pos.pdf"}]},
            {"Date": "Feb 01 2026", "Text": "Waiver of right of respondent Synthetic Beta to respond filed."},
            {"Date": "Feb 18 2026", "Text": "DISTRIBUTED for Conference of 3/6/2026."},
            {"Date": "Mar 09 2026", "Text": "Petition DENIED."},
        ],
        # The real page carries counsel contact details. None of this may be copied.
        "Petitioner": [{"Attorney": "Synthetic Counsel", "IsCounselofRecord": True, "Title": "Synthetic Firm LLP",
                        "Address": "1 Synthetic Plaza", "City": "Nowhere", "State": "ZZ", "Zip": "00000",
                        "Phone": "555-0100", "Email": "counsel@example.test", "PartyName": "Synthetic Alpha"}],
    })
    payload.update(overrides)
    return payload


def docket_url(number: str) -> str:
    return f"{SC}/search.aspx?filename=/docket/docketfiles/html/public/{number}.html"


def qp_url(number: str) -> str:
    return f"{SC}/qp/{number}qp.pdf"
