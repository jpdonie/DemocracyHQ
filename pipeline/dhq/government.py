"""Which party holds the offices that make and sign election law (rules ``party-*``).

For the United States these are the Presidency, the Senate and the House of Representatives; for a state, the
governor and the chambers of its legislature. This module holds the rules that turn what a source lists into the
figures and the one colour the site shows. The sources themselves are read in :mod:`dhq.adapters.officials`.

Nothing here is an election result and nothing is taken from memory. A chamber is described by the members a source
lists on the day it is read, counted by the party label the source gives each of them. An office is described by the
party the source names for its holder. Three published rules do the rest:

``party-group-1``
    Which labels are counted with the Republican and with the Democratic party (see :func:`party_group`).
``party-seats-1``
    When a chamber is shown in a party's colour: when the members counted with that party hold more than half of the
    chamber's seats, vacant seats included. One seat short of that, the chamber has no colour, however the remaining
    seats are split. The House of Representatives is the exception: its Clerk states the majority, and that
    statement is used.
``party-trifecta-1``
    When a government is shown as held by one party: when its executive is of that party and every chamber has that
    party's colour under ``party-seats-1``. Any other combination is "divided", and a government with a part that
    carries no party (Nebraska's legislature is elected without party labels), that no source was read for, or whose
    list of members does not fit its number of seats, is "not determined".

Seats say who was elected under which label. They do not say who runs a chamber: where members of both parties form
the governing coalition, the colour still follows the seats. The site says so wherever it shows them.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Mapping, Optional, Sequence

GROUP_RULE_ID = "party-group-1"
SEATS_RULE_ID = "party-seats-1"
TRIFECTA_RULE_ID = "party-trifecta-1"

REPUBLICAN, DEMOCRATIC, INDEPENDENT, NONPARTISAN, OTHER = "R", "D", "I", "N", "O"
#: The name each group is shown under. Labels of the group ``OTHER`` keep the source's own name.
GROUP_NAMES = {REPUBLICAN: "Republican", DEMOCRATIC: "Democratic", INDEPENDENT: "Independent", NONPARTISAN: "Nonpartisan", OTHER: "Other"}
#: The two parties that are given a colour.
COLOURED = (REPUBLICAN, DEMOCRATIC)
#: Names under which a state party of one of the two national parties is registered, as sources write them.
_AFFILIATES = {"democratic-farmer-labor": DEMOCRATIC, "democratic-nonpartisan league": DEMOCRATIC, "democratic-npl": DEMOCRATIC}
_SINGLE = {"republican": REPUBLICAN, "r": REPUBLICAN, "democratic": DEMOCRATIC, "democrat": DEMOCRATIC, "d": DEMOCRATIC,
           "independent": INDEPENDENT, "i": INDEPENDENT, "id": INDEPENDENT, "nonpartisan": NONPARTISAN, "non-partisan": NONPARTISAN}


def party_group(label: Optional[str]) -> str:
    """The group a party label is counted with (rule ``party-group-1``).

    "Republican" and "Democratic" (also written "Democrat", "R", "D") are their own groups. A label that names
    several parties, as states with fusion voting write it ("Democratic/Working Families", "Republican/Conservative"),
    is counted with the party it names first, when that is one of the two. The Minnesota Democratic-Farmer-Labor Party
    and the North Dakota Democratic-Nonpartisan League Party are the state parties of the Democratic Party and are
    counted with it. "Independent" and "Nonpartisan" are groups of their own, and every other label is "other".
    """
    text = " ".join((label or "").split()).lower()
    if not text:
        return OTHER
    if text in _AFFILIATES:
        return _AFFILIATES[text]
    first = text.split("/")[0].strip()
    return _SINGLE.get(first, OTHER)


def tally(labels: Iterable[Optional[str]]) -> List[dict]:
    """Members counted by group, largest first: ``{"group", "name", "seats", "labels"}``.

    ``labels`` gives the count under each label the source wrote, so that a reader sees what was counted together.
    The members of the group "other" are listed by their own labels, one entry each.
    """
    by_group: Dict[str, Dict[str, int]] = {}
    for label in labels:
        shown = " ".join((label or "").split()) or "No party given"
        group = party_group(label)
        key = group if group != OTHER else f"{OTHER}:{shown}"
        counts = by_group.setdefault(key, {})
        counts[shown] = counts.get(shown, 0) + 1
    out = []
    for key, counts in by_group.items():
        group = key.split(":", 1)[0]
        name = GROUP_NAMES[group] if group != OTHER else key.split(":", 1)[1]
        out.append({"group": group, "name": name, "seats": sum(counts.values()),
                    "labels": [{"label": label, "seats": seats} for label, seats in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]})
    order = {REPUBLICAN: 0, DEMOCRATIC: 1, INDEPENDENT: 2, NONPARTISAN: 3, OTHER: 4}
    return sorted(out, key=lambda entry: (-entry["seats"], order[entry["group"]], entry["name"]))


def seats_of(parties: List[dict], group: str) -> int:
    return sum(entry["seats"] for entry in parties if entry["group"] == group)


def majority(parties: List[dict], seats: Optional[int]) -> Optional[str]:
    """The party whose members hold more than half of ``seats`` (rule ``party-seats-1``), or ``None``.

    ``seats`` is the size of the chamber, vacant seats included. Without it there is no answer: more than half of
    the members listed is not the same thing, since a single vacancy would then decide an evenly split chamber.
    """
    if not seats:
        return None
    for group in COLOURED:
        if seats_of(parties, group) * 2 > seats:
            return group
    return None


def chamber(*, key: str, name: str, labels: Iterable[Optional[str]], seats: Optional[int], source_id: str, source_url: str,
            as_of: Optional[str], checked_at: str, stated_majority: Optional[str] = None, note: Optional[str] = None) -> dict:
    """One chamber as it is published. ``stated_majority`` is a majority the source itself states (the House).

    A chamber for which the source lists more members than it has seats is published without a number of seats and
    without a colour: one of the two figures is then wrong, and the caller queues it for a maintainer.
    """
    parties = tally(labels)
    listed = sum(entry["seats"] for entry in parties)
    known = seats if seats and listed <= seats else None
    return {
        "chamber": key, "name": name, "members": listed, "seats": known,
        "vacant": known - listed if known is not None else None,
        "parties": parties,
        "lead": stated_majority if stated_majority in COLOURED else majority(parties, known),
        "leadBasis": "stated" if stated_majority in COLOURED else "seats",
        "note": note, "sourceId": source_id, "sourceUrl": source_url, "asOf": as_of, "checkedAt": checked_at,
        "ruleId": SEATS_RULE_ID,
    }


def control(executive: Optional[Mapping[str, object]], chambers: List[dict], expected: Optional[Sequence[str]] = None) -> str:
    """"R", "D", "divided" or "undetermined" for one government (rule ``party-trifecta-1``).

    ``expected`` names the chambers the legislature has. A government of which one is missing, because its source
    could not be read and nothing was published from it before, is not determined: the chambers that were read say
    nothing about the one that was not.
    """
    if executive is None or not chambers:
        return "undetermined"
    if expected is not None and sorted(c["chamber"] for c in chambers) != sorted(expected):
        return "undetermined"
    for made in chambers:
        if made["seats"] is None:
            return "undetermined"  # the members listed do not fit the number of seats
        if made["lead"] is None and seats_of(made["parties"], NONPARTISAN) * 2 > made["seats"]:
            return "undetermined"  # a chamber elected without party labels
    party = executive.get("group")
    if party not in COLOURED:
        return "divided"
    return str(party) if all(made["lead"] == party for made in chambers) else "divided"


# --- the published records ----------------------------------------------------------

NATION_ID = "nation:US"
#: Said in place of the President until a source that names the President's party is read.
NO_PRESIDENT_NOTE = ("The Presidency is not part of this view yet: none of the sources read here names the President's party.")
CHAMBER_ORDER = ("upper", "lower", "legislature")


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def house_chamber(listed: Mapping[str, object], *, source_id: str, source_url: str, checked_at: str) -> dict:
    """The House of Representatives from what :func:`dhq.adapters.officials.read_house` returned."""
    notes = []
    if listed.get("nonVoting"):
        notes.append(f"The list also names {_plural(int(listed['nonVoting']), 'member', 'members')} without a vote on the floor "  # type: ignore[arg-type]
                     "(the delegates and the resident commissioner); they are not counted.")
    for entry in listed.get("caucus") or []:  # type: ignore[union-attr]
        notes.append(f"{_plural(entry['members'], 'member', 'members')} listed as {GROUP_NAMES.get(party_group(entry['party']), entry['party'])} "
                     f"{'sits' if entry['members'] == 1 else 'sit'} with the {GROUP_NAMES.get(party_group(entry['caucus']), entry['caucus'])} "
                     "caucus, as the Clerk records it.")
    return chamber(key="lower", name="House of Representatives", labels=listed["labels"], seats=int(listed["seats"]),  # type: ignore[arg-type]
                   source_id=source_id, source_url=source_url, as_of=listed.get("asOf"), checked_at=checked_at,  # type: ignore[arg-type]
                   stated_majority=listed.get("statedMajority"), note=" ".join(notes) or None)  # type: ignore[arg-type]


def senate_chamber(listed: Mapping[str, object], seats: int, *, source_id: str, source_url: str, checked_at: str) -> dict:
    """The Senate from what :func:`dhq.adapters.officials.read_senate` returned."""
    made = chamber(key="upper", name="Senate", labels=listed["labels"], seats=seats, source_id=source_id, source_url=source_url,  # type: ignore[arg-type]
                   as_of=listed.get("asOf"), checked_at=checked_at)  # type: ignore[arg-type]
    if seats_of(made["parties"], INDEPENDENT):
        made["note"] = "The list gives each senator's party. It does not say which party's caucus an independent senator sits with."
    return made


def state_chambers(listed: Mapping[str, List[Mapping[str, str]]], table: Mapping[str, Mapping[str, object]], *, source_id: str,
                   source_url: str, as_of: Optional[str], checked_at: str) -> tuple[List[dict], List[str]]:
    """The chambers of one state, and what a maintainer should look at.

    ``listed`` is what :func:`dhq.adapters.officials.read_legislators` returned, ``table`` the state's entry in
    ``seeds/chambers.json``. A chamber the table names and the source does not list, or the other way round, raises:
    the two no longer describe the same legislature.
    """
    if sorted(listed) != sorted(table):
        raise ValueError(f"the source lists the chambers {sorted(listed)}, the table of chambers has {sorted(table)}")
    chambers, problems = [], []
    for key in CHAMBER_ORDER:
        if key not in table:
            continue
        entry, members, note = table[key], list(listed[key]), None
        if entry.get("numberedDistrictsOnly"):
            voting = [member for member in members if member.get("district", "").isdigit()]
            if len(voting) != len(members):
                others = len(members) - len(voting)
                note = (f"The source also lists {_plural(others, 'member', 'members')} who {'does' if others == 1 else 'do'} not sit for a "
                        f"numbered district and {'has' if others == 1 else 'have'} no vote on the floor. Such members are not counted.")
            members = voting
        made = chamber(key=key, name=str(entry["name"]), labels=[member.get("party") for member in members], seats=int(entry["seats"]),  # type: ignore[call-overload]
                       source_id=source_id, source_url=source_url, as_of=as_of, checked_at=checked_at, note=note)
        if made["seats"] is None:
            problems.append(f"{entry['name']}: the source lists {made['members']} members, the table of chambers has {entry['seats']} seats")
        chambers.append(made)
    return chambers, problems


def executive(*, office: str, name: str, party: str, term_started: Optional[str], source_id: str, source_url: str, checked_at: str) -> dict:
    return {"office": office, "name": name, "party": party, "group": party_group(party), "termStarted": term_started,
            "sourceId": source_id, "sourceUrl": source_url, "checkedAt": checked_at}


def government(*, unit_id: str, name: str, holder: Optional[dict], chambers: List[dict], executive_note: Optional[str] = None,
               expected_chambers: Optional[Sequence[str]] = None) -> dict:
    """One government as it is published, with what rule ``party-trifecta-1`` makes of its parts."""
    present = [made["chamber"] for made in chambers]
    return {"id": unit_id, "name": name, "control": control(holder, chambers, expected_chambers), "executive": holder,
            "executiveNote": None if holder else executive_note, "chambers": chambers,
            "missingChambers": [key for key in CHAMBER_ORDER if key in (expected_chambers or ()) and key not in present],
            "ruleId": TRIFECTA_RULE_ID}


RULES = [
    {"ruleId": GROUP_RULE_ID, "appliesTo": "members of Congress and of the state legislatures, governors",
     "description": ("Which party a member is counted with. The label the source gives is used: \"Republican\" and \"Democratic\" are "
                     "counted as such. A label that names several parties, as states with fusion voting write it (\"Democratic/Working "
                     "Families\", \"Republican/Conservative\"), is counted with the party named first when that is one of the two. The "
                     "Minnesota Democratic-Farmer-Labor Party and the North Dakota Democratic-Nonpartisan League Party are the state "
                     "parties of the Democratic Party and are counted with it. \"Independent\" and \"Nonpartisan\" are counted on their "
                     "own, and so is every other label. The count under each label as the source wrote it is published beside the "
                     "total.")},
    {"ruleId": SEATS_RULE_ID, "appliesTo": "the Senate, the House of Representatives, the chambers of the state legislatures",
     "description": ("When a chamber is shown in red or blue. It is, when the members counted with the Republican or the Democratic "
                     "party hold more than half of the chamber's seats, vacant seats included. Otherwise it has no colour. For the House "
                     "of Representatives the majority its Clerk states is used. The figures are the members a source lists on the day "
                     "given; they are not an election result. Seats do not show who runs a chamber: where members of both parties form "
                     "the governing coalition, the colour still follows the seats.")},
    {"ruleId": TRIFECTA_RULE_ID, "appliesTo": "the United States and the fifty states",
     "description": ("When a government is shown as held by one party. It is, when the President or the governor is of that party and "
                     "every chamber is shown in that party's colour under rule party-seats-1. Any other combination is shown as divided. "
                     "A government with a part no source was read for, with a chamber whose list of members does not fit its number of "
                     "seats, or with a chamber elected without party labels (the Nebraska Legislature), is shown as not determined.")},
]
