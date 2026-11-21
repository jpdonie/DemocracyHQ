"""Who sits in Congress and in the state legislatures, and who the governors are, as four sources list them.

``house``
    The Clerk of the House publishes the list of members as XML, with the date it was published and the majority
    party. Each seat is listed, a vacant one without a member.
``senate``
    The Senate publishes its members as XML, with each senator's party and the time of the last change.
``governors``
    The National Governors Association, the governors' own association, has a page for each sitting governor that
    names the party and the terms served.
``legislators``
    Open States publishes the current members of every state legislature as one CSV file per state, compiled from the
    legislatures' own sites. It is a secondary source, and its files carry no date of their own: the date the server
    reports for the file's last change is published instead.

Every function returns plain values read from the source. What is made of them (which label counts with which
party, when a chamber has a colour) is decided in :mod:`dhq.government`.
"""
from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Dict, List, Optional

from ..http import Fetcher

HOUSE_SOURCE_ID = "house-clerk-members"
SENATE_SOURCE_ID = "senate-members"
GOVERNORS_SOURCE_ID = "nga-governors"
LEGISLATORS_SOURCE_ID = "openstates-people"

HOUSE_URL = "https://clerk.house.gov/xml/lists/MemberData.xml"
SENATE_URL = "https://www.senate.gov/general/contact_information/senators_cfm.xml"
GOVERNORS_URL = "https://www.nga.org/governors/"
LEGISLATORS_URL = "https://data.openstates.org/people/current/{abbr}.csv"

#: The number of senators: two from each of the fifty states (U.S. Const. art. I, § 3; amend. XVII).
SENATE_SEATS = 100
#: Entries of the House list that are not representatives: they have no vote on the floor and no seat among the 435.
NON_VOTING = ("Delegate", "Resident Commissioner")


class SourceFormatError(ValueError):
    """A source no longer has the form this reader was written for. Nothing is published from it."""


def _text(element: Optional[ET.Element], path: str) -> str:
    found = element.find(path) if element is not None else None
    return (found.text or "").strip() if found is not None else ""


def _xml(content: bytes, what: str) -> ET.Element:
    try:
        return ET.fromstring(content)
    except ET.ParseError as exc:
        raise SourceFormatError(f"{what} is not well-formed XML: {exc}") from exc


def _day(value: str, formats: tuple[str, ...]) -> Optional[str]:
    for form in formats:
        try:
            return datetime.strptime(" ".join(value.split()), form).date().isoformat()
        except ValueError:
            continue
    return None


# --- House of Representatives -----------------------------------------------------

def read_house(content: bytes) -> dict:
    """The seats of the House as the Clerk lists them.

    Returns ``{"asOf", "congress", "statedMajority", "labels", "seats", "nonVoting", "caucus"}``: ``labels`` is the party
    of each seated representative, ``seats`` the number of seats listed for representatives (a vacant seat is listed
    without a member), ``caucus`` how many members listed under one party sit with another party's caucus.
    """
    root = _xml(content, "The Clerk's list of members")
    members = root.findall("./members/member")
    if root.tag != "MemberData" or len(members) < 400:
        raise SourceFormatError(f"The Clerk's list of members has {len(members)} entries under <{root.tag}>; expected the whole House")
    labels: List[str] = []
    seats = non_voting = 0
    caucus: Dict[str, int] = {}
    for member in members:
        info = member.find("member-info")
        if info is None:
            raise SourceFormatError("An entry of the Clerk's list has no <member-info>")
        if _text(info, "district") in NON_VOTING:
            non_voting += 1
            continue
        seats += 1
        if not _text(info, "bioguideID"):
            continue  # a vacant seat
        party, sits_with = _text(info, "party"), _text(info, "caucus")
        if not party:
            raise SourceFormatError(f"The Clerk's list names no party for the member of {_text(member, 'statedistrict')}")
        labels.append(party)
        if sits_with and sits_with != party:
            caucus[f"{party}>{sits_with}"] = caucus.get(f"{party}>{sits_with}", 0) + 1
    stated = _text(root, "./title-info/majority")
    return {
        "asOf": _day(root.get("publish-date", ""), ("%B %d, %Y",)),
        "congress": _text(root, "./title-info/congress-num") or None,
        "statedMajority": stated or None,
        "labels": labels, "seats": seats, "nonVoting": non_voting,
        "caucus": [{"party": key.split(">")[0], "caucus": key.split(">")[1], "members": count} for key, count in sorted(caucus.items())],
    }


def house(fetcher: Fetcher) -> dict:
    return read_house(fetcher.get(HOUSE_URL).content)


# --- Senate -----------------------------------------------------------------------

def read_senate(content: bytes) -> dict:
    """The senators as the Senate lists them: ``{"asOf", "labels"}``."""
    root = _xml(content, "The Senate's list of senators")
    members = root.findall("./member")
    if root.tag != "contact_information" or not 80 <= len(members) <= SENATE_SEATS:
        raise SourceFormatError(f"The Senate's list has {len(members)} entries under <{root.tag}>; expected up to {SENATE_SEATS} senators")
    labels = [_text(member, "party") for member in members]
    if not all(labels):
        raise SourceFormatError("The Senate's list names no party for a senator")
    updated = _text(root, "last_updated")
    return {"asOf": updated[:10] if re.match(r"\d{4}-\d{2}-\d{2}", updated) else None, "labels": labels}


def senate(fetcher: Fetcher) -> dict:
    return read_senate(fetcher.get(SENATE_URL).content)


# --- governors --------------------------------------------------------------------

_GOVERNOR_LINK_RE = re.compile(
    r'<a\s+href="(https://www\.nga\.org/governors/[a-z-]+/)"[^>]*>\s*<div class="current-governors__item__image">.*?'
    r'<small class="state">([^<]+)</small>\s*([^<]+?)\s*</div>', re.S)
_ITEM_RE = r'<label class="label">{label}</label>(.*?)</li>'
_TERM_RE = re.compile(r"([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*Current\b")


def read_governor_list(page: str) -> List[dict]:
    """The sitting governors the association lists: ``{"state", "name", "url"}`` for each, in the page's order."""
    found = [{"state": unescape(state).strip(), "name": re.sub(r"^Gov\.\s+", "", " ".join(unescape(name).split())), "url": url}
             for url, state, name in _GOVERNOR_LINK_RE.findall(page)]
    if len(found) < 50:
        raise SourceFormatError(f"The governors' association lists {len(found)} governors in the form this reader knows; expected at least 50")
    return found


def _item(page: str, label: str) -> Optional[str]:
    match = re.search(_ITEM_RE.format(label=re.escape(label)), page, re.S)
    if not match:
        return None
    return " ".join(unescape(re.sub(r"<br\s*/?>", " | ", match.group(1))).split()) or None


def read_governor(page: str) -> dict:
    """What a governor's page states: ``{"party", "termStarted"}``.

    ``termStarted`` is the first day of the term the page marks as current. A governor whose page names no party, or
    marks no term as current, is not published: the page may then be of a former governor.
    """
    party, terms = _item(page, "Party"), _item(page, "Terms")
    current = _TERM_RE.search(terms or "")
    if not party or not current:
        raise SourceFormatError("The governor's page states no party or marks no term as current")
    return {"party": party, "termStarted": _day(current.group(1), ("%B %d, %Y",))}


def governors(fetcher: Fetcher) -> List[dict]:
    """Every sitting governor: ``{"state", "name", "url", "party", "termStarted"}``."""
    out = []
    for entry in read_governor_list(fetcher.get(GOVERNORS_URL).text()):
        try:
            out.append({**entry, **read_governor(fetcher.get(entry["url"]).text())})
        except SourceFormatError as exc:
            raise SourceFormatError(f"{entry['state']}: {exc}") from exc
    return out


# --- state legislators ------------------------------------------------------------

LEGISLATOR_COLUMNS = ("current_party", "current_chamber", "current_district")
CHAMBER_KEYS = ("upper", "lower", "legislature")


def read_legislators(content: bytes) -> Dict[str, List[dict]]:
    """Every current member as ``{"party", "district"}``, by chamber ("upper", "lower", or "legislature" where there is one house)."""
    reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
    if not reader.fieldnames or any(column not in reader.fieldnames for column in LEGISLATOR_COLUMNS):
        raise SourceFormatError(f"The file of legislators has the columns {reader.fieldnames}; expected {', '.join(LEGISLATOR_COLUMNS)}")
    by_chamber: Dict[str, List[dict]] = {}
    for row in reader:
        key = (row.get("current_chamber") or "").strip()
        if key not in CHAMBER_KEYS:
            raise SourceFormatError(f"The file of legislators places a member in the chamber {key!r}")
        by_chamber.setdefault(key, []).append({"party": (row.get("current_party") or "").strip(),
                                               "district": (row.get("current_district") or "").strip()})
    if not by_chamber:
        raise SourceFormatError("The file of legislators lists no member")
    return by_chamber


def legislators(fetcher: Fetcher, abbr: str) -> dict:
    """``{"url", "asOf", "chambers"}`` for one state. ``asOf`` is the day the server says the file last changed."""
    url = LEGISLATORS_URL.format(abbr=abbr.lower())
    result = fetcher.get(url)
    changed = next((value for name, value in result.headers.items() if name.lower() == "last-modified"), None)
    try:
        as_of = parsedate_to_datetime(changed).date().isoformat() if changed else None
    except (TypeError, ValueError):
        as_of = None
    return {"url": url, "asOf": as_of, "chambers": read_legislators(result.content)}
