"""Text of one version of a federal bill or resolution, from the XML the Government Publishing Office publishes.

Source: ``https://www.govinfo.gov/content/pkg/BILLS-<congress><type><number><version>/xml/…``. Two formats are in
use: the House and Senate's bill, resolution and amendment DTDs, and United States Legislative Markup (USLM), which
newer enrolled measures use.

The text is published as blocks ``[kind, text]`` (``h`` heading, ``s`` section heading, ``p`` paragraph), the same
shape as the California texts, so the same reader and the same comparison work for both.

**Self-check.** A version's text is published only if every letter and digit of the document's body appears in the
blocks, in the same order, and nothing else does. Labels that the printed bill adds and the XML leaves out ("Sec.",
"Title") are kept apart from the document's own words for that comparison. A document that fails it, or that has a
structure this module does not know, raises :class:`BillTextError`; its version is then listed with a link and no
mirrored text. Nothing is ever published from a document that did not pass.

Text that the document marks as deleted (struck through in a reported version) is left out: the blocks are the
text of *this* version, not a redline.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import List, Optional, Tuple

#: Levels above a section. The XML gives the designation ("I") and the heading; the printed bill adds the level's name.
HEADING_LEVELS = {"division": "Division", "title": "Title", "subtitle": "Subtitle", "part": "Part", "subpart": "Subpart",
                  "chapter": "Chapter", "subchapter": "Subchapter", "constitution-article": "Article"}
#: Levels below a section: each is one paragraph ("(a) Heading.—Text").
TEXT_LEVELS = {"subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem"}
#: Elements whose children are walked one by one.
CONTAINERS = {"legis-body", "resolution-body", "preamble", "engrossed-amendment-body", "amendment-body", "amendment",
              "amendment-block", "list", "whereas-group", "rules-clause", "committee-appointment-paragraph"}
BODIES = ("legis-body", "resolution-body", "preamble", "engrossed-amendment-body", "amendment-body")
TOC_ENTRIES = {"toc-entry", "multi-column-toc-entry", "toc-quoted-entry"}

USLM = "{http://schemas.gpo.gov/xml/uslm}"
USLM_HEADING_LEVELS = {"division", "title", "subtitle", "part", "subpart", "chapter", "subchapter", "article", "level"}
USLM_TEXT_LEVELS = {"subsection", "paragraph", "subparagraph", "clause", "subclause", "item", "subitem", "subsubitem"}
USLM_CONTAINERS = {"main", "quotedContent", "preamble", "recitals", "appropriations"}

_LETTERS = "0-9A-Za-z" + chr(0xC0) + "-" + chr(0x24F)
_WORD = re.compile("[" + _LETTERS + "]+")
_NOT_LETTERS = re.compile("[^" + _LETTERS + "]+")
_SPACE = re.compile(r"\s+")
OPEN_QUOTE, CLOSE_QUOTE = chr(0x201C), chr(0x201D)
#: An entity reference other than the five that XML itself defines. With a DOCTYPE that names an external DTD, the
#: parser would drop such a reference without an error, and its text with it.
_FOREIGN_ENTITY = re.compile(rb"&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)")
#: Largest document parsed. The longest bill of the 119th Congress so far is under 2 MB.
MAX_XML_BYTES = 32 * 1024 * 1024


class BillTextError(ValueError):
    """The document is not one this module can turn into text it can vouch for."""


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _deleted(el: ET.Element) -> bool:
    return _local(el.tag) == "deleted-phrase" or el.get("changed") == "deleted"


def _inline(el: Optional[ET.Element], out: List[str]) -> None:
    """All text under ``el`` in document order, leaving out what the document marks as deleted.

    A ``quote`` element is put between quotation marks, as the printed bill does; the XML leaves them to the
    stylesheet. The self-check compares letters and digits only, so the marks do not enter into it.
    """
    if el is None or not isinstance(el.tag, str) or _deleted(el):
        return
    quoted = _local(el.tag) in ("quote", "quotedText")
    if quoted:
        out.append(OPEN_QUOTE)
    if el.text:
        out.append(el.text)
    for child in el:
        _inline(child, out)
        if child.tail:
            out.append(child.tail)
    if quoted:
        out.append(CLOSE_QUOTE)


def _flat(el: Optional[ET.Element]) -> str:
    out: List[str] = []
    _inline(el, out)
    return _SPACE.sub(" ", "".join(out)).strip()


def _squeeze(text: Optional[str]) -> str:
    return _SPACE.sub(" ", text or "").strip()


class _Blocks:
    """Blocks as ``(kind, label, text)``: ``label`` is added for the reader, ``text`` is the document's own."""

    def __init__(self) -> None:
        self.items: List[Tuple[str, str, str]] = []

    def emit(self, kind: str, text: str, label: str = "") -> None:
        if text:
            self.items.append((kind, label, text))

    def close_quoted(self, start: int, closing: str) -> None:
        """Mark the blocks from ``start`` on as quoted text, the way the printed bill does: an opening quotation
        mark before each paragraph, a closing one after the last, and then the punctuation that follows the quoted
        block ("." or "; and"), which belongs to its last paragraph."""
        if len(self.items) == start:
            self.emit("p", closing)
            return
        for index in range(start, len(self.items)):
            kind, label, text = self.items[index]
            self.items[index] = (kind, OPEN_QUOTE + label, text)
        kind, label, last = self.items[-1]
        glue = "" if not closing or re.match(r"^[.;,:)]", closing) else " "
        self.items[-1] = (kind, label, last + CLOSE_QUOTE + glue + closing)


def _walk_dtd(body: ET.Element, blocks: _Blocks) -> None:
    def head_of(el: ET.Element) -> Tuple[str, str]:
        return _flat(el.find("enum")), _flat(el.find("header"))

    def walk_children(el: ET.Element, skip: Tuple[str, ...] = ()) -> None:
        blocks.emit("p", _squeeze(el.text))
        for child in el:
            if isinstance(child.tag, str) and child.tag not in skip:
                walk(child)
            blocks.emit("p", _squeeze(child.tail))

    def walk_toc(el: ET.Element) -> None:
        blocks.emit("p", _squeeze(el.text))
        for child in el:
            if not isinstance(child.tag, str) or _deleted(child):
                pass
            elif any(sub.tag in TOC_ENTRIES or sub.tag == "toc" for sub in child.iter() if sub is not child):
                walk_toc(child)  # an entry that holds a table of contents of its own
            else:
                blocks.emit("p", _flat(child))
            blocks.emit("p", _squeeze(child.tail))

    def walk(el: ET.Element) -> None:
        if _deleted(el):
            return
        tag = el.tag
        if tag in HEADING_LEVELS:
            enum, header = head_of(el)
            blocks.emit("h", "—".join(x for x in (enum, header) if x), (HEADING_LEVELS[tag] + " ") if enum else "")
            walk_children(el, skip=("enum", "header"))
        elif tag == "section":
            enum, header = head_of(el)
            blocks.emit("s", " ".join(x for x in (enum, header) if x), "Sec. " if enum else "")
            walk_children(el, skip=("enum", "header"))
        elif tag in TEXT_LEVELS:
            enum, header = head_of(el)
            text = _flat(el.find("text"))
            lead = " ".join(x for x in (enum, header) if x)
            blocks.emit("p", lead + ".—" + text if header and text else " ".join(x for x in (lead, text) if x))
            blocks.emit("p", _squeeze(el.text))
            first_text = el.find("text")
            for child in el:
                if isinstance(child.tag, str) and child.tag not in ("enum", "header") and child is not first_text:
                    walk(child)
                blocks.emit("p", _squeeze(child.tail))
        elif tag == "quoted-block":
            start = len(blocks.items)
            walk_children(el, skip=("after-quoted-block",))
            blocks.close_quoted(start, " ".join(x for x in (_flat(c) for c in el.findall("after-quoted-block")) if x))
        elif tag == "toc":
            walk_toc(el)
        elif tag == "table":
            rows = list(el.iter("row"))
            for row in rows:
                cells = [_flat(cell) for cell in row if cell.tag == "entry"]
                blocks.emit("p", " | ".join(cell for cell in cells if cell))
            if not rows:
                blocks.emit("p", _flat(el))
        elif tag in CONTAINERS:
            walk_children(el)
        else:
            # A paragraph of its own: text, whereas, continuation-text, list-item, amendment-instruction and the like.
            blocks.emit("p", _flat(el))

    walk(body)


def _walk_uslm(body: ET.Element, blocks: _Blocks) -> None:
    def child_text(el: ET.Element, name: str) -> str:
        return _flat(el.find(f"{USLM}{name}"))

    def walk(el: ET.Element) -> None:
        tag = _local(el.tag)
        if tag in USLM_HEADING_LEVELS or tag == "section" or tag in USLM_TEXT_LEVELS:
            # USLM carries the printed designation itself ("SEC. 2.", "TITLE I—"), so no label is added.
            num, heading = child_text(el, "num"), child_text(el, "heading")
            lead = " ".join(x for x in (num, heading) if x)
            first = next((c for c in el if _local(c.tag) in ("content", "chapeau")), None) if tag in USLM_TEXT_LEVELS else None
            if tag in USLM_TEXT_LEVELS:
                blocks.emit("p", " ".join(x for x in (lead, _flat(first)) if x))
            else:
                blocks.emit("s" if tag == "section" else "h", lead)
            blocks.emit("p", _squeeze(el.text))
            for child in el:
                if isinstance(child.tag, str) and _local(child.tag) not in ("num", "heading") and child is not first:
                    walk(child)
                blocks.emit("p", _squeeze(child.tail))
        elif tag in USLM_CONTAINERS:
            start = len(blocks.items)
            blocks.emit("p", _squeeze(el.text))
            for child in el:
                if isinstance(child.tag, str):
                    walk(child)
                blocks.emit("p", _squeeze(child.tail))
            if tag == "quotedContent" and len(blocks.items) > start:
                blocks.close_quoted(start, "")
        elif tag == "toc":
            entries = [e for e in el.iter() if _local(e.tag) in ("referenceItem", "tocItem") and not any(
                _local(s.tag) in ("referenceItem", "tocItem") for s in e.iter() if s is not e)]
            for entry in entries:
                blocks.emit("p", _flat(entry))
            if not entries:
                blocks.emit("p", _flat(el))
        else:
            # content, chapeau, continuation, longTitle, enactingFormula, resolvingClause, p and the like.
            blocks.emit("p", _flat(el))

    walk(body)


def parse_bill_text(xml_bytes: bytes) -> dict:
    """Blocks of one version's text, after the self-check described in the module docstring.

    Returns ``{"blocks": [[kind, text], …], "wordCount": n, "format": "dtd" | "uslm", "officialTitle": str}``.
    Raises :class:`BillTextError` when the document cannot be read, has an unknown structure or fails the check.
    """
    if len(xml_bytes) > MAX_XML_BYTES:
        raise BillTextError(f"document of {len(xml_bytes)} bytes is larger than the {MAX_XML_BYTES} expected")
    head = xml_bytes[:4096].decode("utf-8", errors="replace")
    if "<!ENTITY" in head or re.search(r"<!DOCTYPE[^>]*\[", head):
        raise BillTextError("refusing XML with an internal DTD subset or an entity declaration")
    if _FOREIGN_ENTITY.search(xml_bytes):
        raise BillTextError("refusing XML with an entity reference that XML does not define itself")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise BillTextError(f"not well-formed XML: {exc}") from exc

    blocks = _Blocks()
    reference: List[str] = []
    if root.tag in ("bill", "resolution", "amendment-doc"):
        bodies = [el for el in root if el.tag in BODIES]
        for body in bodies:
            _walk_dtd(body, blocks)
            _inline(body, reference)
        form = root.find("form")
        official_title = _flat(form.find("official-title")) if form is not None else ""
        kind = "dtd"
    elif root.tag in (f"{USLM}bill", f"{USLM}resolution"):
        bodies = [el for el in root if el.tag == f"{USLM}main"]
        for body in bodies:
            _walk_uslm(body, blocks)
            _inline(body, reference)
        official_title = _flat(root.find(f"{USLM}main/{USLM}longTitle/{USLM}officialTitle"))
        kind = "uslm"
    else:
        raise BillTextError(f"unexpected root element {_local(root.tag)!r}")
    if not bodies:
        raise BillTextError("the document has no body")

    expected = _NOT_LETTERS.sub("", "".join(reference))
    found = _NOT_LETTERS.sub("", "".join(text for _kind, _label, text in blocks.items))
    if expected != found:
        at = next((i for i, (a, b) in enumerate(zip(expected, found)) if a != b), min(len(expected), len(found)))
        raise BillTextError(
            f"self-check failed at letter {at}: the document reads {expected[max(0, at - 30):at + 40]!r}, the blocks read "
            f"{found[max(0, at - 30):at + 40]!r} ({len(expected)} letters and digits in the document, {len(found)} in the blocks)")
    if not blocks.items:
        raise BillTextError("the document's body has no text")
    out = [[kind_, label + text] for kind_, label, text in blocks.items]
    return {
        "blocks": out,
        "wordCount": sum(len(_WORD.findall(text)) for _kind, text in out),
        "format": kind,
        "officialTitle": official_title,
    }
