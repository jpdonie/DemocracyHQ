"""Re-check of the published Supreme Court dockets against the Court's docket pages, with a separate reader.

    cd pipeline && python -m tools.verify_dockets [--limit N]

For every docket in public/data/litigation/cases/ this fetches the Court's
public docket page again and compares it with what is published: the docket
number, both titles, the docketed date, every entry's date and text, and every
filing link.

It does not use the adapter's reader. The adapter reads the page structure and
the links inside entry text with regular expressions, and the filing and
Questions Presented links with its own subclass of Python's HTML parser; this
tool walks the whole page with a separate HTML parser class. The two share no
project code except the HTTP client, though both rest on the standard library's
HTML parser for links. Two readers written separately that agree on every entry
are better evidence than one reader checked against itself.

Two differences between the page and the published text are expected and are
removed before comparing:

* markup inside an entry (<i>, <a>) and runs of white space;
* a stray ">" that the Court's markup sometimes leaves at the start of a link
  label ("<a href='...'>>Opinion</a>"), which the published text drops.

An entry the Court added after the last pipeline run is reported and counted
(new_live) and is not compared, but the filing links on it count as links not
yet published (links_unpublished), which makes the tool exit 1: run the pipeline
first. The tool needs the network, waits
a second between requests as the Court's robots.txt asks, and is not part of the
test suite.

Exit status 0 means every published entry and filing link was found unchanged.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

from dhq.http import FetchError, Fetcher

REPO = Path(__file__).resolve().parents[2]
CASES = REPO / "public" / "data" / "litigation" / "cases"
PAGE = "https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/{docket}.html"


def squash(text: object) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def iso(value: object) -> Optional[str]:
    text = squash(value)
    for pattern in ("%b %d %Y", "%B %d, %Y", "%b %d, %Y", "%B %d %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            continue
    return None


class DocketPage(HTMLParser):
    """Walks a docket page and collects its header and its entries."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.number: Optional[str] = None
        self.title_parts: list[str] = [""]
        self.rows: dict[str, str] = {}
        self.entries: list[dict] = []
        self._where: Optional[str] = None  # which piece of text is being collected
        self._label = ""
        self._value = ""
        self._in_proceedings = False
        self._anchor_start = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        a = {key: (value or "") for key, value in attrs}
        classes = a.get("class", "").split()
        if tag == "div" and a.get("id") == "proceedings":
            self._in_proceedings = True
            self._where = None
            return
        if not self._in_proceedings:
            if tag == "span" and "DocketInfoTitle" in classes and self.number is None:
                self._where = "number"
            elif tag == "span" and "title" in classes:
                self._where = "title"
            elif tag == "br" and self._where == "title":
                self.title_parts.append("")
            elif tag == "td" and a.get("width") == "200":
                self._where, self._label = "label", ""
            elif tag == "td" and self._where == "after-label":
                self._where, self._value = "value", ""
            return
        if tag == "table" and "ProceedingItem" in classes:
            self.entries.append({"date": "", "text": "", "links": [], "inline": []})
            self._where = None
        elif tag == "td" and "ProceedingDate" in classes:
            self._where = "date"
        elif tag == "td" and self.entries and self._where == "after-date":
            self._where = "text"
        elif tag == "span" and "documentlinks" in classes:
            self._where = "links"
        elif tag == "a" and self.entries:
            if self._where == "links" and "documentanchor" in classes:
                self.entries[-1]["links"].append(a.get("href", "").strip())
            elif self._where == "text":
                self.entries[-1]["inline"].append(a.get("href", "").strip())
                self._anchor_start = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self._anchor_start = False
        if not self._in_proceedings:
            if tag == "span" and self._where in ("number", "title"):
                self._where = None
            elif tag == "td" and self._where == "label":
                self._where = "after-label"
            elif tag == "td" and self._where == "value":
                self.rows[squash(self._label).rstrip(":").strip()] = squash(self._value)
                self._where = None
            return
        if tag == "td" and self._where == "date":
            self._where = "after-date"
        elif tag == "table" and self.entries:
            self._where = None

    def handle_data(self, data: str) -> None:
        if self._where == "number":
            found = re.search(r"No\.\s*([0-9A-Za-z-]+)", data)
            if found:
                self.number = found.group(1)
        elif self._where == "title":
            self.title_parts[-1] += data
        elif self._where == "label":
            self._label += data
        elif self._where == "value":
            self._value += data
        elif self._where == "date" and self.entries:
            self.entries[-1]["date"] += data
        elif self._where == "text" and self.entries:
            if self._anchor_start:
                # A stray ">" at the start of a link label is a slip in the Court's markup.
                data = data.lstrip().lstrip(">")
                self._anchor_start = False
            self.entries[-1]["text"] += data


def read_page(page: str) -> dict:
    """The header and entries of one docket page, read with the HTML parser."""
    parser = DocketPage()
    parser.feed(page)
    parser.close()
    parts = [squash(part) for part in parser.title_parts]
    petitioner, respondent = "", ""
    if "v." in parts:
        split = parts.index("v.")
        petitioner, respondent = squash(" ".join(parts[:split])), squash(" ".join(parts[split + 1:]))
    return {
        "number": parser.number,
        "petitioner": petitioner,
        "respondent": respondent,
        "docketed": iso(parser.rows.get("Docketed")),
        "entries": [{"date": iso(e["date"]), "text": squash(e["text"]), "links": e["links"], "inline": e["inline"]} for e in parser.entries],
    }


def compare(published: dict, live: dict) -> tuple[dict[str, int], list[str]]:
    """Compare one published docket with what :func:`read_page` found on the Court's page. Pure; no network."""
    counts = {"entries": 0, "matched": 0, "differ": 0, "missing_live": 0, "new_live": 0, "header_diffs": 0,
              "links": 0, "links_missing_live": 0, "links_unpublished": 0}
    notes: list[str] = []
    docket = published["docketNumber"]

    if (live.get("number") or "").upper() != docket.upper():
        notes.append(f"docket number: the page is for {live.get('number')!r}")
    if live.get("petitioner") != squash(published.get("petitionerTitle")):
        notes.append(f"petitioner title: published {published.get('petitionerTitle')!r}, page {live.get('petitioner')!r}")
    if live.get("respondent") != squash(published.get("respondentTitle")):
        notes.append(f"respondent title: published {published.get('respondentTitle')!r}, page {live.get('respondent')!r}")
    if live.get("docketed") != published.get("dateDocketed"):
        notes.append(f"docketed date: published {published.get('dateDocketed')!r}, page {live.get('docketed')!r}")
    counts["header_diffs"] = len(notes)

    remaining = [(e["date"], e["text"]) for e in live.get("entries") or []]
    for entry in ((e["date"], squash(e["description"])) for e in published["events"]):
        counts["entries"] += 1
        if entry in remaining:
            remaining.remove(entry)
            counts["matched"] += 1
            continue
        same_text = [candidate for candidate in remaining if candidate[1] == entry[1]]
        if same_text:
            counts["differ"] += 1
            notes.append(f"date differs for entry {entry[1][:70]!r}: published {entry[0]}, page {same_text[0][0]}")
            remaining.remove(same_text[0])
        else:
            counts["missing_live"] += 1
            notes.append(f"published entry not on the Court's page: {entry[0]} {entry[1][:90]!r}")
    counts["new_live"] = len(remaining)
    if remaining:
        newest = max((d for d, _ in remaining if d), default=None)
        notes.append(f"{len(remaining)} entr{'y' if len(remaining) == 1 else 'ies'} on the Court's page not in the published file (newest {newest})")

    ours = {d["url"] for d in published.get("documents", []) if d.get("url")}
    theirs = {url for e in live.get("entries") or [] for url in e["links"] + e["inline"] if url.startswith("https://www.supremecourt.gov/")}
    counts["links"] = len(ours)
    extra = sorted(ours - theirs)
    absent = sorted(theirs - ours)
    counts["links_missing_live"], counts["links_unpublished"] = len(extra), len(absent)
    if extra:
        notes.append(f"{len(extra)} published link(s) not on the Court's page, e.g. {extra[0]}")
    if absent:
        notes.append(f"{len(absent)} link(s) on the Court's page not in the published file, e.g. {absent[0]}")
    return counts, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    parser.add_argument("--limit", type=int, default=0, help="check only the first N dockets")
    args = parser.parse_args()

    fetcher = Fetcher(min_interval=1.1)
    files = sorted(CASES.glob("*.json"))
    if args.limit:
        files = files[: args.limit]
    totals = {"dockets": 0, "entries": 0, "matched": 0, "differ": 0, "missing_live": 0, "new_live": 0, "header_diffs": 0,
              "links": 0, "links_missing_live": 0, "links_unpublished": 0, "unreachable": 0}
    for path in files:
        published = json.loads(path.read_text(encoding="utf-8"))
        docket = published["docketNumber"]
        try:
            live = read_page(fetcher.get(PAGE.format(docket=docket)).text())
        except (FetchError, ValueError) as exc:
            totals["unreachable"] += 1
            print(f"{docket}: could not fetch the Court's docket page ({exc})")
            continue
        totals["dockets"] += 1
        counts, notes = compare(published, live)
        for key, value in counts.items():
            totals[key] += value
        print(f"{docket}: {counts['matched']} of {counts['entries']} published entries and "
              f"{counts['links'] - counts['links_missing_live']} of {counts['links']} published links match the Court's page"
              + ("" if not notes else "\n  - " + "\n  - ".join(notes)))

    print("\nSummary: " + ", ".join(f"{k}={v}" for k, v in totals.items()))
    clean = all(totals[key] == 0 for key in ("differ", "missing_live", "header_diffs", "links_missing_live", "links_unpublished", "unreachable"))
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
