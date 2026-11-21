"""Supreme Court of the United States dockets (the Court's public docket pages).

``https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/<docket>.html``
is the Court's own docket page, the one a person reads. The adapter parses it,
keeps every proceeding as an individual event, classifies entries with
documented regular-expression rules (``EVENT_RULES``) and never derives an
overall "case status".

Why the page and not the JSON files: the Court also publishes each docket as
JSON under ``/RSS/Cases/JSON/``, and this adapter read those until 2026-11-20.
The Court's ``robots.txt`` asks all robots to stay out of ``/rss/``. The paths
differ only in letter case and the server does not distinguish case, so the
JSON files are treated as covered by that rule and are no longer requested. The
docket pages are not excluded, and they list filing links for older dockets
that the JSON files omit. ``robots.txt`` also sets ``Crawl-delay: 1``; callers
must leave at least ``MIN_INTERVAL`` seconds between requests to this host.

Privacy: the page includes counsel phone numbers, addresses and e-mail
addresses. None of that is copied; only the official caption is published.
"""

from __future__ import annotations

import html
import logging
import re
import subprocess
import tempfile
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional

from ..http import FetchError, Fetcher
from ..schemas import (
    CourtDocument,
    DispositiveEntry,
    EvidenceRef,
    LegalCase,
    LegalEvent,
    LowerCourtInfo,
    QuestionsPresented,
    Verification,
    VerificationStatus,
)
from ..util import content_hash, sha256_bytes

log = logging.getLogger("dhq.scotus")

SOURCE_ID = "scotus-docket"
DOCKET_URL = "https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/{docket}.html"
#: Seconds between requests to supremecourt.gov. The Court's robots.txt sets "Crawl-delay: 1".
MIN_INTERVAL = 1.1

# Ordered: first match wins. Each rule id is shown in the interface next to the
# classified entry so a reader can audit (and dispute) the classification.
# ``level`` (published as "rulesOn") says what an entry rules on:
#   "case"        - the Court's disposition of the case or petition itself
#   "application" - a ruling on an application (a stay, an injunction or another request
#                   addressed to a Justice under Rules 21 to 23)
#   "review"      - an order on whether the Court will hear the case (a grant of review, probable
#                   jurisdiction noted, or consideration of jurisdiction postponed). It disposes of
#                   nothing, so it is never chosen as a docket's latest ruling.
#   None          - not a ruling that disposes of anything
# The first three rules come before everything else on purpose: an entry that
# says a paper was not accepted, was distributed for conference, or that the
# Court asked for a response is not the filing, motion or brief it mentions.
EVENT_RULES: list[tuple[str, str, str, Optional[str], str]] = [
    # (ruleId, eventType, significance, level, pattern)
    ("sc-not-accepted", "not_accepted", "routine", None, r"\bnot accepted for filing\b"),
    ("sc-distributed", "conference_distribution", "routine", None, r"\bDISTRIBUTED for Conference\b|^Rescheduled|^CIRCULATED"),
    ("sc-response-requested", "response_requested", "routine", None, r"^Response\b.*\brequested\b|^Response Requested"),
    # A ruling on a motion that carries a separate writing, or that concerns the judgment itself.
    ("sc-motion-ruling-noted", "motion_ruling", "major", None,
     r"^(Joint m|M)otions?\b.*\b(GRANTED|DENIED|granted|denied|dismissed)\b.*\(Detached [Oo]pinion\)"
     r"|^(Joint m|M)otions?\b.*\b(recall|stay) the (judgment|mandate)\b.*\b(GRANTED|DENIED|granted|denied)\b"),
    ("sc-motion-ruling", "motion_ruling", "routine", None,
     r"^(Joint m|M)otions?\b.*\b(GRANTED|DENIED|granted|denied|dismissed|is extended|are extended)\b"),
    ("sc-motion", "motion", "routine", None, r"^(Joint m|M)otions?\b"),
    ("sc-procedural-app", "procedural_application", "routine", None,
     r"^Application\b.{0,80}?\([0-9A-Z]+\).{0,220}?(extend(ing)? the time|word limit|in excess of|leave to file|to file a consolidated)"),
    ("sc-opinion", "decision", "major", "case", r"\bdelivered the opinion\b|\bOpinion per curiam\b"),
    ("sc-summary", "summary_disposition", "major", "case",
     r"^Petition GRANTED\.\s+Judgment (VACATED|REVERSED)|\bwe (reverse|affirm|vacate) the\b|\bsummarily (affirmed|reversed)\b"
     r"|^(Judgments?|Adjudged to be)\b.*\b(AFFIRMED|REVERSED|VACATED|DISMISSED|affirmed|reversed|vacated)\b"),
    ("sc-app-ruling", "application_ruling", "major", "application",
     r"^(\[See Detached Opinion[^\]]*\]\s*)?(The )?[Aa]pplication\b.*\b(granted|denied|dismissed|GRANTED|DENIED)\b"
     r"|\b[Tt]he application\b[^.]*\breferred to the Court is (granted|denied|dismissed)\b"),
    ("sc-interim-order", "interim_order", "major", None,
     r"^Order (entered|issued) by|administratively stayed|^The stays? heretofore entered"),
    # Orders in which the Court itself states or changes the question, or asks for more briefing on one.
    ("sc-question-order", "question_order", "major", None,
     r"\b[Qq]uestions? presented\b[^.:]*\b(is|are)\b( amended)?( as follows)?:|\b(is|are) (directed|invited) to file (a )?supplemental\b"),
    ("sc-jurisdiction-postponed", "jurisdiction_postponed", "major", "review",
     r"^Further consideration of the question of jurisdiction is (POSTPONED|postponed)"),
    ("sc-review-granted", "review_granted", "major", "review", r"^Petition GRANTED|(?i:\bprobable jurisdiction (is )?noted\b)"),
    # A rehearing ruling comes after the disposition and does not replace it.
    ("sc-rehearing", "rehearing_ruling", "major", None, r"^(Petition for )?[Rr]ehearing\b.*\b(DENIED|GRANTED|denied|granted)\b"),
    ("sc-review-denied", "review_denied", "major", "case", r"^Petition DENIED"),
    ("sc-dismissed", "dismissed", "major", "case", r"^(Petition|Appeal|The appeal|Case|Writ of certiorari)\b.*\b(DISMISSED|dismissed)\b"),
    ("sc-argued", "argued", "major", None, r"^(Argued|Reargued)\."),
    ("sc-judgment-issued", "judgment_issued", "major", None, r"^(Judgment|JUDGMENT)( and mandate)? (Issued|issued|ISSUED)|^Mandate issued"),
    ("sc-reargument", "restored_for_reargument", "major", None, r"restored to the calendar for reargument"),
    ("sc-set-argument", "argument_scheduled", "routine", None, r"^SET FOR (RE)?ARGUMENT|^ARGUMENT SET FOR"),
    ("sc-initiating", "initiating_filing", "major", None,
     r"^Petition for a writ of certiorari( before judgment)? filed|^Statement as to jurisdiction filed|^Application\b.{0,80}?\([0-9A-Z]+\).*(submitted to|filed)"),
    ("sc-app-referred", "application_referred", "routine", None, r"^Application \([0-9A-Z]+\) referred to the Court"),
    ("sc-time-ext", "time_extension", "routine", None, r"extend(ing)? the time|extension of time|^Order extending time"),
    ("sc-amicus", "amicus_brief", "routine", None, r"^Briefs? amic(us|i) curiae|^Amic(us|i) briefs?\b"),
    ("sc-filing", "filing", "routine", None,
     r"^(Brief|Reply|Response|Opposition|Supplemental|Appendix|Joint appendix|Joint Appendix|Sur-reply|Notice|Notification|Consolidated brief|Petition for (a )?rehearing)\b"),
    ("sc-scheduling", "scheduling_notice", "routine", None,
     r"^Because the Court has consolidated|briefs on the merits are to be filed|^Any motion pertaining to the oral argument|^Th(is|ese) cases? (is|are) consolidated"),
    ("sc-record", "record", "routine", None,
     r"^Record |^The record |^Letter |^Waiver\b|^Blanket [Cc]onsent|^Joint Blanket Consent|^Consent to the filing|electronically received"),
]
_COMPILED = [(rid, etype, sig, level, re.compile(pattern)) for rid, etype, sig, level, pattern in EVENT_RULES]
#: The levels an entry may be chosen as a docket's latest ruling from, in order of precedence.
DISPOSITIVE_LEVELS = ("case", "application")

_TAG_RE = re.compile(r"<[^>]+>")
_HREF_RE = re.compile(r"""<a\b[^>]*?(?<![\w-])href\s*=\s*['"]([^'"]+)['"][^>]*>(.*?)</a>""", re.I | re.S)
#: The Court's markup sometimes closes an anchor's opening tag twice ("<a href='...'>>Opinion</a>").
#: The second ">" is a slip in the markup, not part of the entry, and is dropped.
_STRAY_GT_RE = re.compile(r"(<a\b[^>]*>)\s*>+", re.I)
_ROLE_RE = re.compile(r",?\s*(Appellants?|Petitioners?|Applicants?|Respondents?|Appellees?|Plaintiffs?|Defendants?)\s*$", re.I)


def clean_text(value: str) -> str:
    """Strip markup from a docket field. Output is plain text, never HTML."""
    text = html.unescape(_TAG_RE.sub("", value or ""))
    return re.sub(r"\s+", " ", text).strip()


def classify_entry(text: str) -> tuple[str, str, str, Optional[str]]:
    for rid, etype, sig, level, pattern in _COMPILED:
        if pattern.search(text):
            return rid, etype, sig, level
    return "sc-other", "docket_entry", "routine", None


def parse_date(value: Optional[str], formats=("%b %d %Y", "%B %d, %Y", "%m/%d/%Y")) -> Optional[str]:
    value = (value or "").strip()
    if not value:
        return None
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date: {value!r}")


def short_party(title: str) -> str:
    return _ROLE_RE.sub("", clean_text(title)).strip().rstrip(",")


def case_name(petitioner: str, respondent: str) -> str:
    return f"{short_party(petitioner)} v. {short_party(respondent)}"


def is_safe_document_url(url: str) -> bool:
    return url.startswith("https://www.supremecourt.gov/")


class PdfTextError(RuntimeError):
    """No text could be taken from a document: it is not a PDF, or ``pdftotext`` is missing, timed out or failed."""


def extract_pdf_text(pdf_bytes: bytes) -> Optional[str]:
    """Text of a (short) PDF via poppler's ``pdftotext``.

    ``None`` means the PDF was read and has no text layer. Anything that stops the
    PDF from being read raises :class:`PdfTextError`, so that a broken tool or an
    HTML page served in place of the PDF is never taken for a document without text.
    """
    if b"%PDF-" not in pdf_bytes[:1024]:
        raise PdfTextError("the response is not a PDF file")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(pdf_bytes)
        try:
            proc = subprocess.run(["pdftotext", "-layout", "-nopgbrk", str(src), "-"], capture_output=True, timeout=60)
        except FileNotFoundError as exc:
            raise PdfTextError("pdftotext is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise PdfTextError("pdftotext timed out") from exc
        if proc.returncode != 0:
            raise PdfTextError(f"pdftotext exited with status {proc.returncode}: {proc.stderr.decode('utf-8', errors='replace')[:200]}")
        text = proc.stdout.decode("utf-8", errors="replace")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return text or None


class DocketPageError(ValueError):
    """The page is not a docket page, or its layout is not the one this parser knows."""


_ITEM_RE = re.compile(r'<table class="ProceedingItem">(.*?)</table>', re.S)
_ITEM_DATE_RE = re.compile(r'<td class="ProceedingDate">(.*?)</td>', re.S)
_ITEM_BODY_RE = re.compile(r'<td class="ProceedingDate">.*?</td>\s*<td[^>]*>(.*?)<span class="documentlinks">(.*?)</span>\s*</td>', re.S)
_INFO_ROW_RE = re.compile(r'<td width="200">\s*<span>([^<]*)</span>\s*</td>\s*<td>\s*<span>(.*?)</span>\s*</td>', re.S)
_NUMBER_RE = re.compile(r'<span class="DocketInfoTitle">\s*No\.\s*([0-9A-Za-z-]+)')
_RELATED_RE = re.compile(r'<span\s+class="DocketInfoTitle">\s*<span>\s*<span>(.*?)</span>', re.S)
_TITLE_RE = re.compile(r'<span class="title">(.*?)</span>', re.S)
_META_RE = re.compile(r"""<META name='([^']+)' content='(.*?)'>""")
_BR_TAIL_RE = re.compile(r"(\s|<br\s*/?>)+$", re.I)
_STAMP_RE = re.compile(r"^\d{14,}_")


class _Anchors(HTMLParser):
    """Every closed ``<a>`` in a piece of markup with its attributes and text, whatever order the attributes are in."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: List[tuple[dict, str]] = []
        self._open: Optional[tuple[dict, List[str]]] = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "a":
            self._open = ({name.lower(): (value or "").strip() for name, value in attrs}, [])

    def handle_data(self, data: str) -> None:
        if self._open:
            self._open[1].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._open:
            self.found.append((self._open[0], re.sub(r"\s+", " ", "".join(self._open[1])).strip()))
            self._open = None


def _anchors(markup: str) -> List[tuple[dict, str]]:
    parser = _Anchors()
    parser.feed(markup)
    parser.close()
    return parser.found


def _file_name(url: str) -> Optional[str]:
    """The name the filer gave a document, as it appears at the end of its address."""
    from urllib.parse import unquote

    name = _STAMP_RE.sub("", unquote(url.rsplit("/", 1)[-1])).strip()
    return name or None


def parse_docket_page(page: str) -> dict:
    """Read one docket page into a plain dictionary.

    The keys are the ones the Court uses in its own JSON rendering of a docket
    (``CaseNumber``, ``ProceedingsandOrder``, ``Links`` and so on), so that
    :func:`normalise` has one input shape. Entry text keeps its inline markup;
    ``normalise`` strips it. Raises :class:`DocketPageError` when the page has
    no docket number or no proceedings table, so that a layout change at the
    source stops the import instead of producing an empty record.
    """
    start = page.find('<table id="docketinfo"')
    proceedings = page.find('id="proceedings"')
    if start < 0 or proceedings < 0:
        raise DocketPageError("docket page layout not recognised: no docket information or proceedings section")
    info = page[start:proceedings]
    number = _NUMBER_RE.search(info)
    if not number:
        raise DocketPageError("docket page layout not recognised: no docket number")
    meta = {name: html.unescape(value) for name, value in _META_RE.findall(page)}
    rows = {clean_text(label).rstrip(":").strip(): clean_text(value) for label, value in _INFO_ROW_RE.findall(info)}

    petitioner, respondent = meta.get("Petitioner", ""), meta.get("Respondent", "")
    title = _TITLE_RE.search(info)
    if title:
        parts = re.split(r"<br\s*/?>\s*v\.\s*<br\s*/?>", title.group(1), maxsplit=1, flags=re.I)
        if len(parts) == 2:
            petitioner, respondent = clean_text(parts[0]), clean_text(parts[1])

    related: List[dict] = []
    related_match = _RELATED_RE.search(info)
    if related_match:
        words = clean_text(related_match.group(1)).replace(",", " ").split()
        if len(words) >= 2:
            related = [{"RelatedType": words[0], "DisplayCaseNumber": docket} for docket in words[1:]]

    entries: List[dict] = []
    for block in _ITEM_RE.findall(page[proceedings:]):
        date = _ITEM_DATE_RE.search(block)
        body = _ITEM_BODY_RE.search(block)
        if not date or not body:
            raise DocketPageError("docket page layout not recognised: a proceedings row has no date or no text")
        links = []
        for attrs, label in _anchors(body.group(2)):
            url = attrs.get("href", "")
            if url and "documentanchor" in attrs.get("class", "").lower().split():
                links.append({"Description": label or "Document", "File": _file_name(url), "DocumentUrl": url})
        entries.append({"Date": clean_text(date.group(1)), "Text": _BR_TAIL_RE.sub("", body.group(1)).strip(), "Links": links})
    if not entries:
        raise DocketPageError("docket page layout not recognised: no proceedings rows")

    qp = next((attrs["href"] for attrs, label in _anchors(info) if label.lower() == "questions presented" and attrs.get("href")), None)
    return {
        "CaseNumber": number.group(1),
        "sJsonCaseType": meta.get("CaseType"),
        "sJsonCreationDate": meta.get("creation_date"),
        "PetitionerTitle": petitioner,
        "RespondentTitle": respondent,
        "DocketedDate": rows.get("Docketed") or meta.get("Docketed"),
        "Links": f"Linked with {rows['Linked with']}" if rows.get("Linked with") else None,
        "LowerCourt": rows.get("Lower Ct"),
        "LowerCourtCaseNumbers": rows.get("Case Numbers"),
        "LowerCourtDecision": rows.get("Decision Date"),
        "LowerCourtRehearingDenied": rows.get("Rehearing Denied"),
        "QPLink": qp,
        "RelatedCaseNumber": related,
        "ProceedingsandOrder": entries,
    }


def normalise(docket: str, payload: dict, *, checked_at: str, first_observed: Optional[str] = None,
              qp_text: Optional[str] = None) -> LegalCase:
    """Convert one docket JSON payload into a :class:`LegalCase`."""
    number = (payload.get("CaseNumber") or "").strip()
    if number.upper() != docket.upper():
        raise ValueError(f"docket mismatch: asked for {docket}, feed says {number!r}")
    case_id = f"scotus-{docket.lower()}"
    source_url = DOCKET_URL.format(docket=docket)
    events: List[LegalEvent] = []
    documents: List[CourtDocument] = []
    # Latest ruling on the case itself wins over later rulings on applications
    # (a stay application is often decided after the merits opinion). An order on
    # whether to hear the case ("review") disposes of nothing and is never the ruling.
    latest_ruling: dict[str, DispositiveEntry] = {}
    for index, entry in enumerate(payload.get("ProceedingsandOrder") or []):
        raw_text = _STRAY_GT_RE.sub(r"\1", entry.get("Text") or "")
        text = clean_text(raw_text)
        date = parse_date(entry.get("Date"))
        if not text or not date:
            continue
        rule_id, event_type, significance, level = classify_entry(text)
        doc_ids: List[str] = []
        for d_index, link in enumerate(entry.get("Links") or []):
            url = (link.get("DocumentUrl") or "").strip()
            if not is_safe_document_url(url):
                continue
            doc_id = f"{case_id}-e{index}-d{d_index}"
            documents.append(CourtDocument(
                id=doc_id, caseId=case_id, entryIndex=index,
                title=clean_text(link.get("File") or link.get("Description") or "Document"),
                filingDate=date, documentType=clean_text(link.get("Description") or "Document"),
                url=url, availability="public_link",
                accessNote="Hosted by supremecourt.gov; linked, not mirrored.",
            ))
            doc_ids.append(doc_id)
        # Opinions are linked inline in the entry text rather than in Links.
        for o_index, (href, label) in enumerate(_HREF_RE.findall(raw_text)):
            if not is_safe_document_url(href):
                continue
            doc_id = f"{case_id}-e{index}-o{o_index}"
            documents.append(CourtDocument(
                id=doc_id, caseId=case_id, entryIndex=index, title=f"{clean_text(label).capitalize()} (linked in docket entry)",
                filingDate=date, documentType="Opinion" if "opinion" in label.lower() else "Linked document",
                url=href, availability="public_link", accessNote="Hosted by supremecourt.gov; linked, not mirrored.",
            ))
            doc_ids.append(doc_id)
        events.append(LegalEvent(
            id=f"{case_id}-e{index}", eventType=event_type, date=date, entityType="case", entityId=case_id,
            description=text, significance=significance, classificationRule=rule_id,
            evidence=EvidenceRef(url=source_url, sourceId=SOURCE_ID), documentIds=doc_ids,
        ))
        if level in DISPOSITIVE_LEVELS:
            latest_ruling[level] = DispositiveEntry(date=date, text=text, eventType=event_type, ruleId=rule_id)

    lower_numbers = [n.strip() for n in re.split(r"[;,]", (payload.get("LowerCourtCaseNumbers") or "").strip("() ")) if n.strip()]
    qp_link = payload.get("QPLink")
    questions = None
    if qp_link:
        questions = QuestionsPresented(url=qp_url(payload), text=qp_text, textHash=sha256_bytes(qp_text.encode()) if qp_text else None)
    dates = [e.date for e in events]
    body = dict(
        id=case_id,
        externalIds={"scotusDocket": docket},
        caseName=case_name(payload.get("PetitionerTitle", ""), payload.get("RespondentTitle", "")),
        petitionerTitle=clean_text(payload.get("PetitionerTitle", "")),
        respondentTitle=clean_text(payload.get("RespondentTitle", "")),
        docketNumber=docket,
        courtId="scotus",
        jurisdiction="Federal",
        docketType=clean_text(payload.get("sJsonCaseType") or "") or None,
        dateDocketed=parse_date(payload.get("DocketedDate")),
        dateFirstEntry=min(dates) if dates else None,
        sourceLastActivity=max(dates) if dates else None,
        entryCount=len(events),
        documentCount=len(documents),
        issueTags=[],
        lowerCourt=LowerCourtInfo(
            name=clean_text(payload.get("LowerCourt") or "") or None,
            caseNumbers=lower_numbers,
            decisionDate=parse_date(payload.get("LowerCourtDecision")),
            rehearingDeniedDate=parse_date(payload.get("LowerCourtRehearingDenied")),
        ),
        latestDispositiveEntry=next((latest_ruling[level] for level in DISPOSITIVE_LEVELS if level in latest_ruling), None),
        stateFips=[],
        sourceUrl=source_url,
        sourceId=SOURCE_ID,
        sourcePublishedAt=parse_date(payload.get("sJsonCreationDate")),
        firstObservedAt=first_observed or checked_at,
        lastCheckedAt=checked_at,
        verification=Verification(
            status=VerificationStatus.VERIFIED_PRIMARY, method="automated_primary_retrieval", checkedAt=checked_at,
            note="Read from the Supreme Court's public docket page and schema-validated. Not reviewed by a lawyer.",
        ),
        relatedDockets=[
            {"type": clean_text(r.get("RelatedType", "")), "docket": clean_text(r.get("DisplayCaseNumber", ""))}
            for r in (payload.get("RelatedCaseNumber") or [])
        ],
        linkedNote=clean_text(payload.get("Links") or "") or None,
        questionsPresented=questions,
        events=events,
        documents=documents,
    )
    hash_basis = {k: v for k, v in LegalCase(**body, contentHash="").model_dump(mode="json").items()
                  if k not in {"firstObservedAt", "lastCheckedAt", "verification", "contentHash"}}
    return LegalCase(**body, contentHash=content_hash(hash_basis))


def fetch_payload(fetcher: Fetcher, docket: str) -> dict:
    """Fetch one docket page and parse it. The caller's fetcher must honour ``MIN_INTERVAL``."""
    result = fetcher.get(DOCKET_URL.format(docket=docket))
    try:
        payload = parse_docket_page(result.text())
    except DocketPageError as exc:
        # The site answers an unknown docket number with a search page, not a 404.
        raise FetchError(result.url, result.status, str(exc)) from exc
    if payload["CaseNumber"].upper() != docket.upper():
        raise FetchError(result.url, result.status, f"asked for docket {docket}, the page is for {payload['CaseNumber']}")
    return payload


def qp_url(payload: dict) -> Optional[str]:
    link = payload.get("QPLink")
    return "https://www.supremecourt.gov/" + link.replace("../", "").lstrip("/") if link else None
