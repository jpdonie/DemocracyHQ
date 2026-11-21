"""SYNTHETIC California bulk-data archive for tests. Invented bills, not real ones.

The table layout (column positions) follows the Legislative Counsel's published ``.dat``
exports as the adapter reads them: tab separated, text in backticks, ``NULL`` for empty.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

from conftest import make_zip

ARCHIVE_URL = "https://downloads.leginfo.legislature.ca.gov/pubinfo_2025.zip"


def row(width: int, cells: Dict[int, Optional[str]]) -> str:
    out = []
    for i in range(width):
        value = cells.get(i)
        out.append("NULL" if value is None else f"`{value}`")
    return "\t".join(out)


def caml_id(version_id: str) -> str:
    """A version id written the way the CAML files write it: "20250AB199INT" becomes "20250AB__000199INT"."""
    session, measure_type, number, version_num, state = re.fullmatch(r"(\d{5})([A-Z]+)(\d+?)(\d\d)([A-Z]+)", version_id).groups()
    return f"{session}{measure_type:_<4}{int(number):04d}{version_num}{state}"


def caml(subject: str, paragraphs: List[str], *, immediate: str = "NO", title: str = "An act relating to synthetic elections.",
         container: str = "Bill", version_id: Optional[str] = None) -> bytes:
    body = "".join(
        f"<caml:BillSection><caml:Num>SEC. {i + 1}.</caml:Num>"
        f"<caml:ActionLine action=\"IS_ADDED\" xlink:href=\"urn:caml:codes:ELEC:2025:99{i}\">Section 99{i} is added to the Elections Code, to read:</caml:ActionLine>"
        f"<caml:Fragment><caml:LawSection><caml:Num>99{i}.</caml:Num><caml:LawSectionVersion><caml:Content><xhtml:p>{text}</xhtml:p></caml:Content></caml:LawSectionVersion></caml:LawSection></caml:Fragment>"
        f"</caml:BillSection>"
        for i, text in enumerate(paragraphs)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<caml:MeasureDoc xmlns:caml="http://lc.ca.gov/legalservices/schemas/caml.1#" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">'
        "<caml:Description>"
        + (f"<caml:Id>{caml_id(version_id)}</caml:Id>" if version_id else "")
        + f"<caml:Title>{title}</caml:Title>"
        f"<caml:GeneralSubject><caml:Subject>{subject}</caml:Subject></caml:GeneralSubject>"
        "<caml:DigestText><xhtml:p>Existing law is synthetic.</xhtml:p><xhtml:p>This bill would stay synthetic.</xhtml:p></caml:DigestText>"
        "<caml:AuthorText>Introduced by Assembly Member Synthetic</caml:AuthorText>"
        f"<caml:ImmediateEffect>{immediate}</caml:ImmediateEffect><caml:VoteRequired>MAJORITY</caml:VoteRequired>"
        "</caml:Description>"
        f"<caml:{container}>{body}</caml:{container}>"
        "</caml:MeasureDoc>"
    ).encode("utf-8")


def bill_row(bill_id: str, mtype: str, num: str, *, state: str = "Introduced", chapter: Optional[str] = None, active: str = "Y") -> str:
    return row(20, {
        0: bill_id, 1: "20252026", 2: "0", 3: mtype, 4: num, 5: state,
        6: "2026" if chapter else None, 7: "CHP" if chapter else None, 9: chapter, 11: active,
        15: "Synthetic location", 16: "Assembly", 17: "Synthetic status",
    })


def version_row(version_id: str, bill_id: str, num: int, date: str, label: str, subject: str, lob: Optional[str], active: str = "Y") -> str:
    return row(17, {0: version_id, 1: bill_id, 2: str(num), 3: f"{date} 00:00:00", 4: label, 6: subject, 14: lob, 15: active})


def history_row(bill_id: str, date: str, text: str, seq: int, chamber: Optional[str] = "Assembly") -> str:
    return row(12, {0: bill_id, 2: f"{date} 00:00:00", 3: text, 6: str(seq), 9: chamber})


A, B, C, D, E = "202520260AB1", "202520260SB2", "202520260ACA3", "202520260AB4", "202520260AB5"

P1 = "A synthetic ballot shall be counted if it is received within three days."
P1_AMENDED = "A synthetic ballot shall be counted if it is received within seven days."
P2 = "The elections official shall publish the synthetic count."


def members(*, drop_lob: Optional[str] = None, extra_version: bool = False, with_chaptered_text: bool = True) -> Dict[str, bytes]:
    """Archive members. ``drop_lob`` removes one text member to model a version whose text is missing."""
    versions = [
        version_row("20250AB199INT", A, 99, "2026-01-06", "Introduced", "Elections: synthetic ballots.", "lob/a99.lob"),
        version_row("20250AB198AMD", A, 98, "2026-03-01", "Amended Assembly", "Elections: synthetic ballots.", "lob/a98.lob"),
        version_row("20250AB197CHP", A, 97, "2026-05-01", "Chaptered", "Elections: synthetic ballots.", "lob/a97.lob" if with_chaptered_text else None),
        version_row("20250AB196OLD", A, 96, "2026-05-02", "Superseded", "Elections: synthetic ballots.", "lob/a96.lob", active="N"),
        version_row("20250SB299INT", B, 99, "2026-01-07", "Introduced", "Vehicles: synthetic parking.", "lob/b99.lob"),
        version_row("20250ACA399INT", C, 99, "2026-01-08", "Introduced", "Elections: synthetic amendment.", "lob/c99.lob"),
        version_row("20250AB499INT", D, 99, "2026-01-09", "Introduced", "Elections: withdrawn synthetic bill.", "lob/d99.lob"),
        version_row("20250AB599INT", E, 99, "2026-01-10", "Introduced", "Voter registration: synthetic urgency.", "lob/e99.lob"),
    ]
    if extra_version:
        versions.append(version_row("20250AB598AMD", E, 98, "2026-02-10", "Amended Assembly", "Voter registration: synthetic urgency.", "lob/e98.lob"))
    out: Dict[str, bytes] = {
        "BILL_TBL.dat": "\n".join([
            bill_row(A, "AB", "1", state="Chaptered", chapter="7"),
            bill_row(B, "SB", "2"),
            bill_row(C, "ACA", "3", state="Chaptered", chapter="9"),
            bill_row(D, "AB", "4", active="N"),
            bill_row(E, "AB", "5", state="Chaptered", chapter="11"),
        ]).encode() + b"\n",
        "BILL_VERSION_TBL.dat": ("\n".join(versions) + "\n").encode(),
        "BILL_HISTORY_TBL.dat": "\n".join([
            history_row(A, "2026-01-06", "Read first time. To print.", 1),
            history_row(A, "2026-03-01", "From committee chair, with author's amendments: Amend, and re-refer.", 2),
            history_row(A, "2026-04-01", "Read third time. Passed. Ordered to the Senate.", 3),
            history_row(A, "2026-04-30", "Approved by the Governor.", 4, None),
            history_row(A, "2026-05-01", "Chaptered by Secretary of State - Chapter 7, Statutes of 2026.", 5, None),
            history_row(A, "2026-02-01", "Some synthetic step\nthat spans two lines.", 6),
            history_row(C, "2026-05-03", "Chaptered by Secretary of State - Res. Chapter 9, Statutes of 2026.", 1, None),
            history_row(E, "2026-05-04", "Chaptered by Secretary of State - Chapter 11, Statutes of 2026.", 1, None),
        ]).encode() + b"\n",
        "lob/a99.lob": caml("Elections: synthetic ballots.", [P1, P2], version_id="20250AB199INT"),
        "lob/a98.lob": caml("Elections: synthetic ballots.", [P1_AMENDED, P2], version_id="20250AB198AMD"),
        "lob/a97.lob": caml("Elections: synthetic ballots.", [P1_AMENDED, P2, "A third synthetic section is added."], version_id="20250AB197CHP"),
        "lob/b99.lob": caml("Vehicles: synthetic parking.", ["Parking is synthetic."], version_id="20250SB299INT"),
        "lob/c99.lob": caml("Elections: synthetic amendment.", ["The synthetic constitution is amended."], container="Resolution", version_id="20250ACA399INT"),
        "lob/d99.lob": caml("Elections: withdrawn synthetic bill.", ["Withdrawn."], version_id="20250AB499INT"),
        "lob/e99.lob": caml("Voter registration: synthetic urgency.", ["Registration is synthetic."], immediate="YES", version_id="20250AB599INT"),
        "lob/e98.lob": caml("Voter registration: synthetic urgency.", ["Registration is synthetic.", "An added synthetic section."], immediate="YES",
                            version_id="20250AB598AMD"),
    }
    if drop_lob:
        out.pop(drop_lob, None)
    return out


def archive(**kw) -> bytes:
    return make_zip(members(**kw))


def positional_archive(*, insert_first: bool = False) -> bytes:
    """The archive with its text members named the way the real export names them: ``BILL_VERSION_TBL_<n>.lob``,
    where ``n`` is the row's position in this export. ``insert_first`` adds a version before all the others,
    as a later export may, which renumbers every member after it."""
    m = members()
    rows = m["BILL_VERSION_TBL.dat"].decode().strip("\n").split("\n")
    if insert_first:
        rows.insert(0, version_row("20250SB298AMD", B, 98, "2026-06-01", "Amended Senate", "Vehicles: synthetic parking.", "lob/b98.lob"))
        m["lob/b98.lob"] = caml("Vehicles: synthetic parking.", ["Parking is synthetic and amended."], version_id="20250SB298AMD")
    out = {name: data for name, data in m.items() if not name.startswith("lob/")}
    numbered = []
    for n, line in enumerate(rows, start=1):
        cells = line.split("\t")
        if cells[14] != "NULL":
            name = f"BILL_VERSION_TBL_{n}.lob"
            if cells[14].strip("`") in m:
                out[name] = m[cells[14].strip("`")]
            cells[14] = f"`{name}`"
        numbered.append("\t".join(cells))
    out["BILL_VERSION_TBL.dat"] = ("\n".join(numbered) + "\n").encode()
    return make_zip(out)
