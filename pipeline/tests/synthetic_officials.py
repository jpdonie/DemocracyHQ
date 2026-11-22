"""Synthetic lists of members and governors, laid out the way the four sources publish them.

SYNTHETIC TEST DATA. The markup copies the structure of the real files (the Clerk's ``MemberData`` XML, the Senate's
``contact_information`` XML, the governors' association's pages, an Open States CSV file), so that the readers are
tested against the same shapes. Every name, party count and date is invented.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from dhq.adapters import officials
from dhq.util import STATES

from conftest import FakeResponse, FakeSession

NOT_STATES = ("DC", "PR", "AS", "GU", "MP", "VI")
#: fips -> (abbreviation, name) of the fifty states.
FIFTY: Dict[str, Tuple[str, str]] = {fips: pair for fips, pair in sorted(STATES.items()) if pair[0] not in NOT_STATES}


# --- House of Representatives ---------------------------------------------------------

def house_member(index: int, party: Optional[str], *, caucus: Optional[str] = None, district: str = "1st") -> str:
    """One entry of the Clerk's list. ``party=None`` is a vacant seat: the seat is listed, without a member."""
    if party is None:
        info = f"<namelist/><bioguideID/><party/><caucus/><district>{district}</district>"
    else:
        info = (f"<namelist>Synthetic, Member {index}</namelist><bioguideID>S{index:06d}</bioguideID>"
                f"<party>{party}</party><caucus>{caucus or party}</caucus><district>{district}</district>")
    return f"<member><statedistrict>ZZ{index % 53:02d}</statedistrict><member-info>{info}</member-info></member>"


def house_xml(parties: Sequence[Optional[str]], *, majority: str = "R", published: str = "June 1, 2026", delegates: int = 6,
              caucus: Optional[Dict[int, str]] = None) -> bytes:
    """The Clerk's list: one seat for each entry of ``parties`` (``None`` is vacant), then the members without a vote."""
    members = [house_member(i, party, caucus=(caucus or {}).get(i)) for i, party in enumerate(parties)]
    members += [house_member(1000 + i, "D", district="Delegate" if i else "Resident Commissioner") for i in range(delegates)]
    return (f'<?xml version="1.0" encoding="UTF-8"?><MemberData publish-date="{published}"><title-info><congress-num>199</congress-num>'
            f"<majority>{majority}</majority><minority>{'D' if majority == 'R' else 'R'}</minority></title-info>"
            f"<members>{''.join(members)}</members></MemberData>").encode("utf-8")


def house_seats(republican: int, democratic: int, *, independent: int = 0, vacant: int = 0) -> List[Optional[str]]:
    return ["R"] * republican + ["D"] * democratic + ["I"] * independent + [None] * vacant


# --- Senate ---------------------------------------------------------------------------

def senate_xml(parties: Iterable[str], *, updated: str = "2026-05-30T12:08-05:00") -> bytes:
    members = "".join(f"<member>\n <member_full>Synthetic{i} ({party}-ZZ)</member_full>\n <party>{party}</party>\n <state>ZZ</state>\n</member>"
                      for i, party in enumerate(parties))
    return f'<?xml version="1.0" encoding="UTF-8"?><contact_information>{members}<last_updated>{updated}</last_updated></contact_information>'.encode("utf-8")


# --- governors ------------------------------------------------------------------------

def governor_url(state: str) -> str:
    return f"https://www.nga.org/governors/{state.lower().replace(' ', '-')}/"


def governor_list_html(states: Iterable[str]) -> str:
    items = "".join(f"""
          <li class="current-governors__item">
            <div class="current-governors__wrapper">
              <a
                href="{governor_url(state)}"
                target="_blank"
              >
                <div class="current-governors__item__image">
                  <img decoding="async" src="https://www.nga.org/wp-content/uploads/synthetic.jpg" alt="Synthetic {state}" />
                </div>
                <div class="current-governors__item__link">
                  <small class="state">{state}</small>
                  Gov. Synthetic {state}                </div>
              </a>
            </div>
          </li>""" for state in states)
    return f'<html><body><ul class="current-governors__list">{items}</ul></body></html>'


def governor_page_html(state: str, party: Optional[str], terms: str = "January 5, 2015 - January 7, 2019<br/>January 7, 2023 - Current") -> str:
    party_item = "" if party is None else f"""
          <li class="item">
            <label class="label">Party</label>
                          {party}                      </li>"""
    return f"""<html><body><h5 class="title__label">{state}</h5>
      <h1 class="title title--no-border">Gov. Synthetic {state}</h1>
      <ul class="list--horizontal">
          <li class="item">
            <label class="label">Terms</label>
                          {terms}                      </li>{party_item}
          <li class="item">
            <label class="label">Born</label>
                          January 1, 1960                      </li>
      </ul></body></html>"""


# --- state legislators ----------------------------------------------------------------

CSV_HEAD = "id,name,current_party,current_district,current_chamber,given_name"


def legislators_csv(chambers: Dict[str, Sequence[str]], *, districts: Optional[Dict[str, Sequence[str]]] = None) -> bytes:
    """An Open States file: ``chambers`` gives the party label of each member, by chamber key."""
    rows = [CSV_HEAD]
    for chamber, labels in chambers.items():
        named = (districts or {}).get(chamber)
        for i, label in enumerate(labels):
            district = named[i] if named else str(i + 1)
            quoted = f'"{label}"' if "," in label else label
            rows.append(f"ocd-person/synthetic-{chamber}-{i},Synthetic Member {i},{quoted},{district},{chamber},Synthetic")
    return ("\n".join(rows) + "\n").encode("utf-8")


def legislators_url(abbr: str) -> str:
    return officials.LEGISLATORS_URL.format(abbr=abbr.lower())


# --- a whole synthetic country --------------------------------------------------------

#: The seats of every synthetic chamber: small, so that a test can count them.
UPPER_SEATS, LOWER_SEATS = 5, 9


def chambers_table(*, one_house: Sequence[str] = ()) -> dict:
    """``seeds/chambers.json`` for the fifty states, with the synthetic number of seats. ``one_house`` names the
    states (by abbreviation) whose legislature has a single chamber."""
    states = {}
    for fips, (abbr, _) in FIFTY.items():
        if abbr in one_house:
            states[abbr] = {"fips": fips, "chambers": {"legislature": {"name": f"{abbr} Legislature", "seats": UPPER_SEATS}}}
        else:
            states[abbr] = {"fips": fips, "chambers": {"lower": {"name": "House", "seats": LOWER_SEATS}, "upper": {"name": "Senate", "seats": UPPER_SEATS}}}
    return {"about": "Synthetic table of chambers.", "states": states}


def split(seats: int, republican: int, *, other: Sequence[str] = ()) -> List[str]:
    """``republican`` Republicans, the labels in ``other``, and Democrats in the remaining seats."""
    return ["Republican"] * republican + list(other) + ["Democratic"] * (seats - republican - len(other))


def serve_country(session: FakeSession, *, governors: Optional[Dict[str, str]] = None, legislatures: Optional[Dict[str, Dict[str, Sequence[str]]]] = None,
                  house: Optional[bytes] = None, senate: Optional[bytes] = None, modified: str = "Fri, 29 May 2026 08:00:00 GMT") -> None:
    """Script every address the stage reads. Unless said otherwise every state has a Republican governor and
    Republican majorities in both chambers, the Senate is 53 to 47 and the House 220 to 215."""
    session.on(officials.SENATE_URL, FakeResponse(200, senate if senate is not None else senate_xml(["R"] * 53 + ["D"] * 47)))
    session.on(officials.HOUSE_URL, FakeResponse(200, house if house is not None else house_xml(house_seats(220, 215))))
    names = [name for _, name in FIFTY.values()] + ["Puerto Rico", "Guam"]
    session.on(officials.GOVERNORS_URL, FakeResponse(200, governor_list_html(names)))
    for name in names:
        session.on(governor_url(name), FakeResponse(200, governor_page_html(name, (governors or {}).get(name, "Republican"))))
    for fips, (abbr, _) in FIFTY.items():
        listed = (legislatures or {}).get(abbr) or {"upper": split(UPPER_SEATS, 3), "lower": split(LOWER_SEATS, 5)}
        session.on(legislators_url(abbr), FakeResponse(200, legislators_csv(listed), {"Last-Modified": modified}))
