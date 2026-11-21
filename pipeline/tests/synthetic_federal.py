"""SYNTHETIC records of Congress and of the courts of appeals for the tests. Invented, not real.

The builders below lay invented measures and cases out the way the sources lay out real ones: a bill status
record and a bill text as the Government Publishing Office publishes them, and GovInfo's sitemap and metadata
record for a court of appeals case. No measure, member, case, party or passage here exists. Courts and districts
keep their real names, because the adapters check them.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Sequence
from xml.sax.saxutils import escape, quoteattr

from dhq import circuits
from dhq.adapters import congress, uscourts

from conftest import FakeResponse, make_zip

# --- Congress ---------------------------------------------------------------------------

LOC = "Library of Congress"


def action(date: str, text: str, code: str = "", source: str = LOC, kind: str = "Floor", time: str = "", votes: Sequence[dict] = ()) -> dict:
    return {"date": date, "text": text, "code": code, "source": source, "kind": kind, "time": time, "votes": list(votes)}


INTRODUCED = action("2025-01-03", "Introduced in House", "1000", kind="IntroReferral")


def text_package(kind: str, number: int, version: str = "ih") -> str:
    return f"BILLS-{congress.CONGRESS}{kind}{number}{version}"


def status_record(kind: str, number: int, *, title: str, official: Optional[str] = None, short_titles: Iterable[str] = (),
                  policy_area: Optional[str] = "Government Operations and Politics", actions: Sequence[dict] = (INTRODUCED,),
                  versions: Sequence[tuple] = (), summary: Optional[str] = None, related: Sequence[tuple] = (),
                  law: Optional[str] = None, congress_number: int = congress.CONGRESS, legislation_url: Optional[str] = None) -> bytes:
    """A bill status record. ``versions`` are ``(label, date, version code)``; ``related`` are ``(type, number, relationship)``."""
    def item(tag: str, value: object) -> str:
        return f"<{tag}>{escape(str(value))}</{tag}>" if value not in (None, "") else ""

    titles = "".join(f"<item>{item('titleType', kind_)}{item('title', text)}</item>" for kind_, text in (
        [("Official Title as Introduced", official)] if official else []) + [("Short Title(s) as Introduced", t) for t in short_titles])
    acts = "".join(
        "<item>" + item("actionDate", a["date"]) + item("actionTime", a["time"]) + item("text", a["text"]) + item("type", a["kind"])
        + item("actionCode", a["code"]) + f"<sourceSystem>{item('name', a['source'])}</sourceSystem>"
        + ("<recordedVotes>" + "".join(
            "<recordedVote>" + item("chamber", v["chamber"]) + item("rollNumber", v["rollNumber"]) + item("url", v["url"])
            + item("sessionNumber", v.get("session")) + "</recordedVote>" for v in a["votes"]) + "</recordedVotes>" if a["votes"] else "")
        + "</item>" for a in actions)
    texts = "".join(
        f"<item>{item('type', label)}{item('date', date + 'T05:00:00Z')}<formats><item>"
        f"{item('url', congress.TEXT_URL.format(package=text_package(kind, number, code)))}</item></formats></item>"
        for label, date, code in versions)
    rel = "".join(
        f"<item>{item('type', r_kind.upper())}{item('number', r_number)}{item('congress', congress_number)}{item('title', 'A synthetic related measure')}"
        f"<relationshipDetails><item>{item('type', relationship)}{item('identifiedBy', 'CRS')}</item></relationshipDetails></item>"
        for r_kind, r_number, relationship in related)
    summaries = (f"<summaries><summary>{item('actionDesc', 'Introduced in House')}{item('actionDate', '2025-01-03')}"
                 f"{item('updateDate', '2025-02-01T12:00:00Z')}<text><![CDATA[{summary}]]></text></summary></summaries>" if summary else "")
    latest = actions[0] if actions else None
    return ("<?xml version=\"1.0\" encoding=\"utf-8\"?><billStatus><bill>"
            + item("number", number) + item("type", kind.upper()) + item("congress", congress_number)
            + item("introducedDate", "2025-01-03") + item("updateDate", "2025-06-01T08:00:00Z")
            + item("legislationUrl", legislation_url) + item("title", title) + f"<titles>{titles}</titles>"
            + (f"<policyArea>{item('name', policy_area)}</policyArea>" if policy_area else "")
            + "<subjects><legislativeSubjects><item><name>Synthetic subject term</name></item></legislativeSubjects></subjects>"
            + "<sponsors><item><fullName>Rep. Synthetic, Ada [X-ZZ-1]</fullName><party>X</party><state>ZZ</state><district>1</district></item></sponsors>"
            + "<cosponsors><item><fullName>Rep. Invented, Bo [Y-ZZ-2]</fullName></item>"
              "<item><fullName>Rep. Withdrawn, Cy [Y-ZZ-3]</fullName><sponsorshipWithdrawnDate>2025-02-02</sponsorshipWithdrawnDate></item></cosponsors>"
            + "<committees><item><name>Synthetic Administration Committee</name><chamber>House</chamber></item></committees>"
            + f"<actions>{acts}</actions>{summaries}<textVersions>{texts}</textVersions><relatedBills>{rel}</relatedBills>"
            + (f"<laws><item><type>Public Law</type><number>{law}</number></item></laws>" if law else "")
            + (f"<latestAction>{item('actionDate', latest['date'])}{item('text', latest['text'])}</latestAction>" if latest else "")
            + "</bill></billStatus>").encode("utf-8")


def bill_text(official_title: str, sections: Sequence[tuple]) -> bytes:
    """A bill text in the House and Senate's bill DTD. ``sections`` are ``(number, heading, [paragraphs])``."""
    body = "".join(
        f"<section><enum>{number}.</enum><header>{escape(heading)}</header>"
        + "".join(f"<subsection><enum>({chr(97 + i)})</enum><text>{escape(paragraph)}</text></subsection>" for i, paragraph in enumerate(paragraphs))
        + "</section>" for number, heading, paragraphs in sections)
    return (f"<?xml version=\"1.0\"?><bill><form><official-title>{escape(official_title)}</official-title></form>"
            f"<legis-body>{body}</legis-body></bill>").encode("utf-8")


def archive(kind: str, records: Dict[int, bytes]) -> bytes:
    """The status archive of one measure type. A real archive is never empty, so an unselected measure fills it."""
    members = {f"BILLSTATUS-{congress.CONGRESS}{kind}{number}.xml": data for number, data in records.items()}
    members.setdefault(f"BILLSTATUS-{congress.CONGRESS}{kind}99999.xml", status_record(
        kind, 99999, title="A synthetic measure about bridges", official="To name a synthetic bridge.", policy_area="Transportation and Public Works"))
    return make_zip(members)


def serve_congress(session, records: Dict[str, Dict[int, bytes]], texts: Dict[str, bytes],
                   last_modified: str = "Mon, 01 Jun 2026 08:00:00 GMT") -> None:
    """Serve the eight status archives (``records``: measure type -> number -> record) and the text versions by package id."""
    for kind in congress.MEASURE_TYPES:
        session.serve_bytes(congress.ARCHIVE_URL.format(congress=congress.CONGRESS, kind=kind), archive(kind, records.get(kind, {})),
                            last_modified=last_modified)
    for package, data in texts.items():
        session.serve_bytes(congress.TEXT_URL.format(package=package), data, last_modified=last_modified)


# --- courts of appeals --------------------------------------------------------------------

#: Sentences an election opinion is made of: four election words and four election phrases each.
ELECTION_SENTENCE = "The Board of Elections rejected absentee ballots cast by registered voters in the general election. "
OTHER_SENTENCE = "The supplier delivered the widgets late and the buyer withheld payment under the agreement. "


def election_opinion(heading: str = "", sentences: int = 4, filler: int = 6) -> str:
    """An opinion the selection rule's "long" test selects: enough election words and phrases, and dense enough."""
    return heading + ELECTION_SENTENCE * sentences + OTHER_SENTENCE * filler


def other_opinion(heading: str = "", sentences: int = 30) -> str:
    return heading + OTHER_SENTENCE * sentences


def document(sequence: int, date: str, entry: str, *, url: bool = True) -> dict:
    return {"sequence": sequence, "date": date, "entry": entry, "url": url}


def mods(package: str, title: str, documents: Sequence[dict], *, nature: Optional[tuple] = None, parties: Sequence[tuple] = (),
         court_name: Optional[str] = None) -> bytes:
    """GovInfo's metadata record for one case. ``nature`` is ``(code, name)``; ``parties`` are ``(name, role)``."""
    court = uscourts.court_of(package)
    number = package.split("-", 2)[2]
    extension = (f"<extension><docClass>USCOURTS</docClass><courtType>Appellate</courtType><courtCode>{court.code}</courtCode>"
                 f"<caseNumber>{number}</caseNumber>"
                 + (f"<natureSuitCode>{nature[0]}</natureSuitCode><natureSuit>{escape(nature[1])}</natureSuit>" if nature else "")
                 + "".join(f"<party fullName={quoteattr(name)} role={quoteattr(role)}/>" for name, role in parties) + "</extension>")
    items = "".join(
        f"<relatedItem type=\"constituent\" ID=\"id-{package}-{doc['sequence']}\">"
        f"<titleInfo><subTitle>{escape(doc['entry'])}</subTitle></titleInfo><originInfo><dateIssued>{doc['date']}</dateIssued></originInfo>"
        + (f"<location><url access=\"raw object\">{uscourts.DOCUMENT_URL.format(package=package, granule=package + '-' + str(doc['sequence']))}</url></location>"
           if doc["url"] else "")
        + f"<extension><courtName>{escape(court_name or court.name)}</courtName><docketText>{escape(doc['entry'])}</docketText></extension>"
        "</relatedItem>" for doc in documents)
    short = f"{number[:2]}-{int(number[3:])}"
    # The court data appears twice in a real record, identically.
    return (f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><mods xmlns=\"http://www.loc.gov/mods/v3\"><titleInfo><title>{escape(title)}</title></titleInfo>"
            f"<identifier type=\"preferred citation\">{number};{short}</identifier>{extension}{extension}{items}</mods>").encode("utf-8")


def sitemap(entries: Dict[str, str]) -> str:
    urls = "".join(f"<url><loc>https://www.govinfo.gov/app/details/{package}</loc>  <lastmod>{changed}</lastmod></url>"
                   for package, changed in entries.items())
    return f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">{urls}</urlset>"


class Courts:
    """The cases GovInfo "lists" in a test: change them and call :meth:`serve` again to model a later day."""

    def __init__(self, session, year: int = 2026):
        self.session = session
        self.year = year
        self.cases: Dict[str, dict] = {}

    def add(self, package: str, title: str, texts: Sequence[str], *, changed: str = "2026-05-20T12:00:00.123Z",
            entries: Optional[Sequence[str]] = None, dates: Optional[Sequence[str]] = None, **record) -> str:
        """Add or replace a case with one document for each text. Returns the case id."""
        entries = entries or ["PUBLISHED AUTHORED OPINION filed. Originating case number: 1:24-cv-00001."] * len(texts)
        dates = dates or [f"2026-03-{10 + i:02d}" for i in range(len(texts))]
        documents = [document(i, dates[i], entries[i]) for i in range(len(texts))]
        self.cases[package] = {"title": title, "texts": list(texts), "changed": changed, "documents": documents, "record": record}
        return uscourts.case_id(package)

    def remove(self, package: str) -> None:
        del self.cases[package]

    def serve(self) -> None:
        by_court: Dict[str, Dict[str, str]] = {court.code: {} for court in circuits.CIRCUITS}
        for package, case in self.cases.items():
            by_court[uscourts.court_of(package).code][package] = case["changed"]
            self.session.on(uscourts.RECORD_URL.format(package=package),
                            FakeResponse(200, mods(package, case["title"], case["documents"], **case["record"])))
            for doc, text in zip(case["documents"], case["texts"]):
                self.session.on(uscourts.DOCUMENT_URL.format(package=package, granule=f"{package}-{doc['sequence']}"), FakeResponse(200, text))
        for code, listed in by_court.items():
            # A court with no cases in a year has no sitemap for it: GovInfo answers 404, as the unscripted address does here.
            url = uscourts.SITEMAP_URL.format(court=code, year=self.year)
            if listed:
                self.session.on(url, FakeResponse(200, sitemap(listed)))
            else:
                self.session.routes.pop(url, None)


def exclusion(package: str, quote: str, reason: str = "The election in this synthetic case is not a public election.", name: str = "Synthetic") -> dict:
    return {"package": package, "caseName": name, "reason": reason, "quote": quote}


def packages_read(session) -> List[str]:
    """The packages whose metadata record was requested, in order."""
    prefix = uscourts.RECORD_URL.split("{")[0]
    return [url[len(prefix):].split("/")[0] for url in session.urls() if url.startswith(prefix)]
