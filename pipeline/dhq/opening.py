"""The opening passage of a court opinion, read from the layout of its PDF (rule ``about-opinion-1``).

A list of cases should say what each case is about, and it should say so in the court's words, not in words written
for this site. An opinion nearly always opens with a paragraph that says who appeals from what. This module finds that
paragraph and quotes its first sentences. Nothing is reworded.

The plain text of a PDF is not enough for this: at the foot of a page the footnotes run into the body, a footnote
number sits in the middle of a sentence, and a paragraph that crosses a page is cut by the running head. The layout is
read instead, with poppler's ``pdftohtml -xml``, which gives every piece of text its place on the page and its type
size. That is what tells a footnote number (small type, raised) from the "2" in "Section 2", and a footnote from the
body above it.

What the rule does, in order:

1. Every page loses its running head, its page number, its footnotes (from the first line that begins with a footnote
   mark to the foot of the page) and every line set in smaller type than the body.
2. The opinion begins after the line that names its author ("SMITH, Circuit Judge.", "PER CURIAM:", the forms of the
   courts of the states such as "ROWAN, PRESIDING JUSTICE, FOR THE COURT:" or "ROWAN, J.—Voters in ...") or, where
   there is none, after the line that names the panel ("Before A, B, and C, Circuit Judges.", "(By: A, C.J., ...)"),
   or else after the heading of the opinion near the head of the file ("MEMORANDUM OPINION", "O P I N I O N"). A
   judge's name that signs an order, or names the judge of the court appealed from, is not the author's line, and a
   panel named at the foot of the opinion is not its beginning.
3. Headings are passed over, and so are the words that every order begins with ("This appeal was considered on the
   record ..."), the list of counsel, the caption set again above the text, the line that names who joined the opinion
   and the disposition alone ("Affirmed."). The number a court sets before each paragraph ("¶1", "{¶ 1}") is left out. The first paragraph of prose after them is taken, across a page break if it continues there. A
   passage the court sets in from the margin (a statute, a clause of the Constitution) ends the paragraph and is not
   quoted: it carries no quotation marks, so it would read as the court's words.
4. Footnote marks are left out. A word that the page broke across two lines is joined again.
5. The paragraph is quoted from its beginning, sentence by sentence, until the quotation is long enough to say what the
   case is about.
6. The passage is checked against the plain text of the same file, which another program reads: its letters must stand
   there one after the other, with none left out. Other matter may stand between them only where the passage crosses
   a page, because the plain text runs the footnotes and the page head in there.
7. A paragraph that fails a check (too short, not a sentence, a remnant of a page head in it, not found in the plain
   text) is not quoted. The next paragraph is then tried, up to the first heading and the fourth paragraph, and the
   quotation says which paragraph of the opinion it is. Where none passes, the case has no quotation. An opinion that
   begins "I respectfully dissent" or "I concur" is a separate opinion: it has none either.
"""
from __future__ import annotations

import html
import re
import subprocess
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .about import MAX_CHARS, MIN_CHARS, join_lines, quotation, sentence_ends

RULE_ID = "about-opinion-1"
#: How many pages of an opinion are laid out. The opinion proper can start several pages in (a syllabus, the list of
#: counsel), and its first paragraph can cross a page.
LAYOUT_PAGES = 16


class LayoutError(ValueError):
    """The PDF could not be laid out (a broken tool, or a file that is not a PDF)."""


def pdf_layout(pdf_bytes: bytes, pages: int = LAYOUT_PAGES) -> str:
    """The layout of the first ``pages`` pages of a PDF, as poppler's ``pdftohtml -xml`` writes it."""
    if b"%PDF-" not in pdf_bytes[:1024]:
        raise LayoutError("the response is not a PDF file")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(pdf_bytes)
        try:
            proc = subprocess.run(["pdftohtml", "-xml", "-i", "-q", "-stdout", "-l", str(pages), str(src)],
                                  capture_output=True, timeout=120)
        except FileNotFoundError as exc:
            raise LayoutError("pdftohtml is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise LayoutError("pdftohtml timed out") from exc
        if proc.returncode != 0:
            raise LayoutError(f"pdftohtml exited with status {proc.returncode}: {proc.stderr.decode('utf-8', errors='replace')[:200]}")
        return proc.stdout.decode("utf-8", errors="replace")


# --- reading the layout ---------------------------------------------------------------------------------

@dataclass
class Piece:
    """One run of text as the PDF sets it."""
    top: int
    left: int
    width: int
    height: int
    size: int
    text: str


@dataclass
class Line:
    page: int
    top: int
    bottom: int
    pieces: List[Piece] = field(default_factory=list)
    #: Where a run of white space alone stands in the line: its left edge.
    blanks: List[int] = field(default_factory=list)
    #: Filled by :func:`_finish`.
    text: str = ""
    left: int = 0
    right: int = 0
    size: int = 0
    starts_with_mark: bool = False


_PAGE_RE = re.compile(r'<page number="(\d+)"[^>]*>(.*?)</page>', re.S)
_FONT_RE = re.compile(r'<fontspec id="(\d+)" size="(-?\d+)"')
_TEXT_RE = re.compile(r'<text top="(-?\d+)" left="(-?\d+)" width="(-?\d+)" height="(-?\d+)" font="(\d+)">(.*?)</text>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")
#: A footnote mark: a number or a reference sign standing alone in small type.
_MARK_RE = re.compile(r"^\s*(?:\d{1,3}|[*†‡§¶]{1,3})\s*$")
#: Small type: at most this share of the size of the body.
_MARK_SIZE = 0.82
_SMALL_LINE = 0.9
#: Joined letters a typeface draws as one sign are written as their letters.
_LIGATURES = str.maketrans({"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st"})


def _pieces(layout: str) -> List[Tuple[int, List[Piece]]]:
    sizes: Dict[str, int] = {}
    pages = []
    for number, body in _PAGE_RE.findall(layout):
        for font_id, size in _FONT_RE.findall(body):
            sizes[font_id] = int(size)
        found = []
        for top, left, width, height, font, inner in _TEXT_RE.findall(body):
            text = html.unescape(_TAG_RE.sub("", inner)).replace("\xa0", " ")
            if text:
                # A run of white space alone is kept: it may be all that parts two sentences (see ``_finish``).
                found.append(Piece(int(top), int(left), int(width), int(height), sizes.get(font, 0), text))
        pages.append((int(number), found))
    return pages


def body_size(pages: List[Tuple[int, List[Piece]]]) -> int:
    """The type size most of the text is set in."""
    weight: Counter = Counter()
    for _, pieces in pages:
        for piece in pieces:
            weight[piece.size] += len(piece.text.strip())
    return weight.most_common(1)[0][0] if weight else 0


def _is_mark(piece: Piece, body: int) -> bool:
    return piece.size <= body * _MARK_SIZE and bool(_MARK_RE.match(piece.text))


def _finish(line: Line, body: int) -> None:
    line.pieces.sort(key=lambda p: p.left)
    first = line.pieces[0]
    line.starts_with_mark = _is_mark(first, body)
    kept = [p for p in line.pieces if not _is_mark(p, body)]
    text = ""
    right = None
    after_mark = False
    for piece in line.pieces:
        if _is_mark(piece, body):
            after_mark = bool(text)
            continue
        words = piece.text
        if after_mark:
            # Where a footnote mark stood between a word and the punctuation after it, or between two sentences.
            if re.match(r"\s*[,;:.)]", words):
                text, words = text.rstrip(), words.lstrip()
            elif not text.endswith(" ") and not words.startswith(" "):
                text += " "
            after_mark = False
        elif text and right is not None and not text.endswith(" ") and not words.startswith(" ") and (
                piece.left - right > max(piece.size, 1) * 0.2 or any(right - 1 <= blank <= piece.left for blank in line.blanks)):
            text += " "
        text += words
        right = piece.left + piece.width
    line.text = re.sub(r"\s+", " ", text.translate(_LIGATURES)).strip()
    line.left = min((p.left for p in kept), default=first.left)
    line.right = max((p.left + p.width for p in kept), default=first.left + first.width)
    weight: Counter = Counter()
    for piece in kept:
        weight[piece.size] += len(piece.text.strip())
    line.size = weight.most_common(1)[0][0] if weight else first.size


def page_lines(number: int, pieces: List[Piece], body: int) -> List[Line]:
    """The lines of a page from top to bottom. A raised footnote mark belongs to the line it is raised from."""
    lines: List[Line] = []
    # Body-size pieces first, so that each line's band is that of its ordinary text and a raised mark then falls in it.
    for piece in sorted((p for p in pieces if p.text.strip()), key=lambda p: (p.size < body * _MARK_SIZE, p.top, p.left)):
        centre = piece.top + piece.height / 2
        home = next((line for line in lines if line.top <= centre <= line.bottom), None)
        if home is None:
            home = Line(page=number, top=piece.top, bottom=piece.top + piece.height)
            lines.append(home)
        home.pieces.append(piece)
    for piece in pieces:
        if not piece.text.strip():
            centre = piece.top + piece.height / 2
            home = next((line for line in lines if line.top <= centre <= line.bottom), None)
            if home is not None:
                home.blanks.append(piece.left)
    lines.sort(key=lambda line: line.top)
    for line in lines:
        _finish(line, body)
    return [line for line in lines if line.text or line.starts_with_mark]


#: Running heads that the courts' filing system stamps on each page, and page numbers.
_HEAD_RES = [
    re.compile(r"\bAppellate Case:"), re.compile(r"\bDate Filed:"), re.compile(r"\bDocument:? ?\d[\d-]*\b.*\bPage:? ?\d+"),
    re.compile(r"^USCA\d* (?:Case|Appeal)\b"), re.compile(r"^Case:? [\w:.-]+,? +Document\b"), re.compile(r"\bPage \d+ of \d+$"),
    re.compile(r"\bPg: ?\d+ of \d+"), re.compile(r"\bEntry ID: ?\d+"), re.compile(r"\bPage: ?\d+\b.*\bFiled:"),
    re.compile(r"^-? ?\d{1,3} ?-?$"), re.compile(r"^Nos?\. [\d,\s&-]+(?:and [\d-]+)?$"),
    re.compile(r"^(?=.*\d)[\d\s-]*(?:Opinion|Order) of the Court[\d\s-]*$"),
]
_RULE_RE = re.compile(r"^[_\-\s—–]{5,}$")


def _is_head(text: str) -> bool:
    return any(pattern.search(text) for pattern in _HEAD_RES)


def _head_key(line: Line) -> Tuple[int, str]:
    return round(line.top / 6), re.sub(r"\d+", "#", line.text)


def repeated_heads(pages: List[List[Line]]) -> set:
    """Lines that stand at the same height with the same words (page numbers aside) on several pages: running heads."""
    seen: Counter = Counter()
    for lines in pages:
        for key in {_head_key(line) for line in lines if len(line.text) <= 90}:
            seen[key] += 1
    needed = max(3, round(len(pages) * 0.4))
    return {key for key, count in seen.items() if count >= needed}


def clean_page(lines: List[Line], body: int, heads: Optional[set] = None) -> List[Line]:
    """The body text of a page: without running head, page number, footnotes and lines in smaller type."""
    kept: List[Line] = []
    for index, line in enumerate(lines):
        if line.starts_with_mark:
            break  # the footnotes run from here to the foot of the page
        if _RULE_RE.match(line.text):
            following = next((other for other in lines[index + 1:] if other.text), None)
            # A rule above the footnotes, in a court that sets its footnote numbers in the size of the text.
            if following is not None and (following.starts_with_mark or re.match(r"^(?:\d{1,3}|\*{1,3}|†)\s+\S", following.text)) \
                    and line.top > lines[0].top + (lines[-1].top - lines[0].top) * 0.4:
                break
            continue
        if _is_head(line.text) or line.size < body * _SMALL_LINE or (heads and _head_key(line) in heads):
            continue
        if not any(c.isalnum() for c in line.text):
            continue  # "* * *" and the like
        kept.append(line)
    return kept


def body_pages(layout: str) -> List[List[Line]]:
    """The body text of each laid-out page, as lines."""
    raw = _pieces(layout)
    body = body_size(raw)
    if not body:
        return []
    pages = [page_lines(number, pieces, body) for number, pieces in raw]
    heads = repeated_heads(pages)
    return [clean_page(lines, body, heads) for lines in pages]


# --- finding the opening paragraphs -----------------------------------------------------------------------

_BEFORE_RE = re.compile(r"^(?:Before|BEFORE|Present|PRESENT)\b:?|^\(By:")
_PANEL_END_RE = re.compile(r"\b(?:Judges?|Justices?)\b\.?[\s*]*$|\bJudges?\b\.|\bJJ\.[\s*]*$")
#: The line that opens the opinion by naming its author. A concurrence or dissent is named differently
#: ("..., Circuit Judge, concurring:", "Smith, J., dissenting") and does not match. The federal courts write
#: "SMITH, Circuit Judge:"; the courts of the states write "ISHEE, JUSTICE, FOR THE COURT:", "HUDSON, Chief Justice.",
#: "F O S T E R, Judge:" or "GORDON MCCLOUD, J.—Voters in Benton County ...", with the opinion on the same line; the
#: Court of Chancery of Delaware writes "McCORMICK, C." for its Chancellor and "LASTER, V.C." for a Vice Chancellor.
_NAME = r"(?!Before\b|BEFORE\b|The Honorable\b|THE HONORABLE\b|Hon\.|HON\.)[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’\- ]{1,48}"
_AUTHOR_RE = re.compile(
    r"^(?:" + _NAME + r", (?:(?:Chief|Senior|Circuit|District) ){1,2}Judge|P(?:ER|er) C(?:URIAM|uriam)"
    r"|" + _NAME + r", (?:(?i:chief|presiding|associate|senior|acting) )?(?i:justice|judge)(?:, (?i:for the court))?(?=\s*[.:—–])"
    r"|" + _NAME + r", (?:(?:Vice )?Chancellor|C\. ?J|P\. ?J|V\. ?C|C|J)\.(?=\s*(?:[:—–]|--|$)))\s*[.:]?\s*"
)
_BYLINE_RE = re.compile(r"\b(?:Opinion|Dissent|Concurrence|Memorandum|Order|Statement)\b.*\bby\b", re.I)
_SENTENCE_STOP_RE = re.compile(r"[.?!:][\"”’)\]]*$")
#: How many paragraphs from the start of the opinion are considered, and how many lines are read for them.
OPENING_PARAGRAPHS = 4
_MAX_LINES = 120


@dataclass
class _Frame:
    """Where the body text of a page runs: its left and right edges."""
    left: int
    right: int

    def indented(self, line: Line) -> bool:
        return line.left > self.left + 9

    def short(self, line: Line) -> bool:
        return line.right < self.right - (self.right - self.left) * 0.12


def _long(lines: List[Line]) -> List[Line]:
    return [line for line in lines if len(line.text) >= 45]


#: The share of a page's long lines that must begin at an edge for it to count as the margin, and the least number.
_MARGIN_SHARE = 0.12
_MARGIN_LINES = 3


def _frame(lines: List[Line]) -> Optional[_Frame]:
    """The edges of the body text among ``lines``.

    The left edge is the leftmost one that several long lines begin at, not the one most lines begin at: on a page
    that a set-in quotation fills, most lines begin further in, and the margin is still where the court's own lines
    begin. Where no edge has enough lines, the most common one is taken.
    """
    long_lines = _long(lines)
    if not long_lines:
        return None
    lefts = Counter(round(line.left / 3) * 3 for line in long_lines)
    needed = max(_MARGIN_LINES, round(len(long_lines) * _MARGIN_SHARE))
    populated = [left for left, count in lefts.items() if count >= needed]
    rights = sorted(line.right for line in long_lines)
    return _Frame(left=min(populated) if populated else lefts.most_common(1)[0][0], right=rights[int(len(rights) * 0.85)])


#: A page needs this many long lines of body text for its own edges to be measured.
_FRAME_LINES = 8


def frames_of(lines: List[Line]) -> Dict[int, _Frame]:
    """The edges of the body text on each page of ``lines`` (the opinion from where it begins).

    A page with enough text is measured by itself. A page with little text (the page the opinion begins on, below the
    caption) takes the width of the well-filled pages and starts at its own leftmost long line. Pages are measured
    one by one because a file can set its odd and even pages at different margins.
    """
    by_page: Dict[int, List[Line]] = {}
    for line in lines:
        by_page.setdefault(line.page, []).append(line)
    measured = {page: _frame(items) for page, items in by_page.items() if len(_long(items)) >= _FRAME_LINES}
    # A page on which too few lines begin at the margin to be counted (two lines of the court, then a long set-in
    # quotation) takes the margin of the other pages, provided one of its own long lines begins there.
    margins = sorted({frame.left for frame in measured.values() if frame})
    for page, frame in measured.items():
        begins = [margin for margin in margins if frame and margin < frame.left - 9
                  and any(abs(line.left - margin) <= 4 for line in _long(by_page[page]))]
        if begins:
            frame.left = begins[0]
    widths = sorted(frame.right - frame.left for frame in measured.values() if frame)
    width = widths[len(widths) // 2] if widths else None
    frames: Dict[int, _Frame] = {}
    for page, items in by_page.items():
        if measured.get(page):
            frames[page] = measured[page]
            continue
        long_lines = _long(items) or items
        left = min(line.left for line in long_lines)
        right = left + width if width else max(line.right for line in long_lines)
        frames[page] = _Frame(left=left, right=right)
    return frames


#: A page needs this many line gaps for its own line pitch to be measured.
_PITCH_GAPS = 6


def pitches_of(lines: List[Line]) -> Dict[int, float]:
    """The usual distance from one line of body text to the next, for each page of ``lines``.

    It is the median of the page's own line gaps, so one closely or widely set pair of lines does not stand for the
    page. A page with few lines takes the median over the whole of ``lines``.
    """
    gaps: Dict[int, List[int]] = {}
    for above, below in zip(lines, lines[1:]):
        if above.page == below.page and below.top > above.top:
            gaps.setdefault(above.page, []).append(below.top - above.top)
    every = sorted(gap for items in gaps.values() for gap in items)
    overall = float(every[len(every) // 2]) if every else 0.0
    pitches: Dict[int, float] = {}
    for page in {line.page for line in lines}:
        own = sorted(gaps.get(page, []))
        pitches[page] = float(own[len(own) // 2]) if len(own) >= _PITCH_GAPS else overall
    return pitches


def _is_heading(line: Line, frame: _Frame) -> bool:
    text = line.text
    words = text.split()
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True
    if _BYLINE_RE.search(text) and len(words) <= 14:
        return True
    upper = sum(1 for c in letters if c.isupper()) / len(letters)
    if upper > 0.85 and len(words) <= 14:
        return True  # "ORDER AND JUDGMENT", "I. BACKGROUND", "O R D E R"
    if re.match(r"^(?:[IVX]{1,4}|[A-Z]|\d{1,2})\.(?: [A-Z][\w’' -]{0,60})?$", text):
        return True  # "I.", "A. Background", "1. Standing"
    # A short line that is not a sentence and stops well before the right edge: "Background", "Standard of Review".
    return frame.short(line) and len(words) <= 12 and not re.search(r"[.?!][\"”’)\]]*$", text)


def _starts_prose(text: str) -> bool:
    return bool(re.match(r"^[\"“‘'\[(]?[A-Z0-9]", text)) and len(text.split()) >= 4


#: The number some courts set before each paragraph ("¶1.", "[¶ 2]", "{¶ 3}"). It is not part of the court's sentence, and,
#: like a footnote mark, it is left out of a quotation.
_PARAGRAPH_NUMBER_RE = re.compile(r"^[\[{]?¶\s*\d{1,3}[\]}]?\.?\s+")


def _without_number(line: Line) -> Line:
    match = _PARAGRAPH_NUMBER_RE.match(line.text)
    return replace(line, text=line.text[match.end():]) if match else line


#: The heading above the text of an order or opinion.
_TITLE_RE = re.compile(r"^(?:O ?R ?D ?E ?R|J ?U ?D ?G ?M ?E ?N ?T|OPINION(?: OF THE COURT)?|MEMORANDUM(?: OPINION)?|ORDER AND JUDGMENT|SUMMARY ORDER)[\s*]*$")
#: The heading of an opinion of a court that names no panel above it, as a district court's opinion or many a state
#: court's: "MEMORANDUM OPINION", "OPINION AND ORDER", "O P I N I O N", "OPINION OF THE COURT BY GINOZA, J., IN WHICH",
#: or the words above an order of the Court of Appeals of Georgia. It is looked for near the head of the document.
_OPENING_TITLE_RE = re.compile(
    r"^(?:(?:MEMORANDUM )?OPINION(?: OF THE COURT)?(?: AND (?:ORDER|JUDGMENT))?|MEMORANDUM(?: DECISION)?(?: AND ORDER)?|DECISION AND ORDER"
    r"|OPINION ON (?:REHEARING|MOTION)[A-Z ]{0,40}|(?i:OPINION OF THE COURT BY) .{3,60}|(?:The )?Court of Appeals hereby passes the following order:?)[\s*]*$")
_TITLE_SEARCH_LINES = 90
#: A panel named below such a heading and this many lines of prose is named at the end of the opinion, not above it.
_PANEL_AFTER_TITLE = 8
_SIGNATURE_RE = re.compile(r"^(?:Entered for the Court|FOR THE COURT)\b", re.I)
#: The line above the signature of an order in some courts of the states: "PANEL: Jj. Maxa, Lee, Che".
_PANEL_LINE_RE = re.compile(r"^PANEL:")
#: The line that names the court appealed from, whose judge is named on the next line: "An Appeal from the Circuit
#: Court for Miami-Dade County, Christopher" above "Green, Judge.".
_LOWER_COURT_RE = re.compile(r"^(?:An? )?(?:Appeals?|Petition|Writ|Review|Certiorari|Original Proceeding)\b.*\b(?:from|for|of|to)\b")
#: How far below the line naming the panel a heading such as "ORDER" is still looked for (a caption may lie between).
_TITLE_WINDOW = 45


def _unspaced(text: str) -> str:
    """A heading set in spaced letters read as a word: "O P I N I O N" as "OPINION"."""
    return re.sub(r"(?<=\b[A-Z]) (?=[A-Z]\b)", "", text)


#: The small words a judge's name may hold. Any other word in small letters shows that the line names something else
#: ("Court of Appeals Hudson, C.J." names the court appealed from and, beside it, the author).
_PARTICLES = {"de", "la", "le", "del", "della", "van", "von", "der", "den", "du", "di", "da", "dos", "das", "y", "e", "st.", "mc", "mac"}


def _author_match(text: str) -> Optional["re.Match[str]"]:
    """The match of the line that names the opinion's author, where the name is a person's."""
    match = _AUTHOR_RE.match(text)
    if not match:
        return None
    name = text[:match.end()].split(",")[0]
    if any(word[:1].islower() and word.lower() not in _PARTICLES for word in name.split()):
        return None
    return match


def _bare_author(text: str) -> bool:
    match = _author_match(text)
    return bool(match) and not text[match.end():].strip()


def _signs(flat: List[Line], index: int) -> bool:
    """Whether the line naming a judge at ``index`` signs a document instead of opening an opinion: it stands among
    other judges' names ("Danner, J." above "Greenwood, P. J."), or under "FOR THE COURT" or the list of the panel."""
    if any(0 <= other < len(flat) and _bare_author(flat[other].text) for other in (index - 1, index + 1)):
        return True
    return any(_SIGNATURE_RE.match(flat[other].text) or _PANEL_LINE_RE.match(flat[other].text) for other in range(max(0, index - 3), index))


def _names_court_below(flat: List[Line], index: int) -> bool:
    """Whether the judge named at ``index`` is the judge of the court appealed from: the line above names that court
    and runs on into the judge's name ("Appeal from the District Court for Synthetic County: Jane" above "Roe, Judge.")."""
    return index > 0 and bool(_LOWER_COURT_RE.match(flat[index - 1].text)) and not re.search(r"\.[\"”’)\]]*$", flat[index - 1].text)


def _body_start(flat: List[Line]) -> Tuple[Optional[int], Optional[str]]:
    """``(index, rest)``: the line the opinion's text begins on, and the text that follows the author's name where
    both stand on one line. ``(None, None)`` when neither the author nor the panel is named."""
    panel_end: Optional[int] = None
    title = next((index for index in range(min(_TITLE_SEARCH_LINES, len(flat))) if _OPENING_TITLE_RE.match(_unspaced(flat[index].text))), None)
    for index, line in enumerate(flat):
        if _BEFORE_RE.match(line.text):
            if title is not None and sum(1 for other in flat[title + 1:index] if len(other.text) >= 60) >= _PANEL_AFTER_TITLE:
                break  # a court that names the panel below its opinion ("Before Golemon, C.J., ..." under "PER CURIAM")
            for end in range(index, min(index + 5, len(flat))):
                # "(By: Devens, C.J., McKenna, ..., JJ., and ... Judge Gluck, assigned by reason of vacancy)"
                if _PANEL_END_RE.search(flat[end].text) if not line.text.startswith("(") else flat[end].text.rstrip().endswith(")"):
                    panel_end = end
                    # A court that sets each judge on a line of their own: the panel ends with the last of them.
                    while panel_end + 1 < len(flat) and re.search(r"\bJudge\.?$", flat[panel_end + 1].text):
                        panel_end += 1
                    break
            break
    first = (panel_end + 1) if panel_end is not None else 0
    for index in range(first, len(flat)):
        text = flat[index].text
        match = _author_match(text)
        if not match:
            continue
        before = flat[index - 1].text if index else ""
        if _SIGNATURE_RE.match(before):
            break  # "Per Curiam" under "Entered for the Court" signs an order; it does not open one
        rest = text[match.end():].strip().lstrip("—–-").strip()
        if (not rest and _signs(flat, index)) or _names_court_below(flat, index):
            continue  # the judges who sign an order, or the judge of the court appealed from
        if rest and not re.match(r"^[\"“‘'\[(]?[A-Z0-9]", rest):
            continue  # "Smith, J., filed a dissenting opinion": the author of another opinion is named
        if not re.search(r"[.:]\s*$", match.group(0)):
            # A name without a full stop or colon opens the opinion only where it stands alone under the heading
            # "OPINION", or, for "PER CURIAM", directly under the panel.
            per_curiam = "uriam" in match.group(0).lower()
            if rest or not (_TITLE_RE.match(before) or (per_curiam and panel_end is not None and index - panel_end <= 6)):
                continue
        return (index, rest) if rest else (index + 1, None)
    if panel_end is None:
        # No panel and no author: the opinion begins below its heading, where one stands near the head of the document.
        return (title + 1, None) if title is not None else (None, None)
    start = panel_end + 1
    for index in range(start, min(start + _TITLE_WINDOW, len(flat))):
        if _TITLE_RE.match(flat[index].text):
            start = index + 1
    return start, None


#: Lines of one set-in passage begin at the same place, within this many units.
_SET_IN_TOLERANCE = 6


def opening_paragraphs(pages: List[List[Line]]) -> List[List[Line]]:
    """The first paragraphs of the opinion's own prose, up to its first heading: each a list of lines.

    A passage that is set in from the margin line after line is a quotation the court sets apart (a statute, a clause
    of the Constitution). It has no quotation marks, so run into the court's sentence it would read as the court's
    words. It ends the paragraph before it and is left out, and so is the rest of that paragraph where it goes on
    below the quotation, because it begins in the middle of the court's thought.
    """
    flat = [line for page in pages for line in page]
    start, rest_of_first = _body_start(flat)
    if start is None:
        return []
    frames = frames_of(flat[start:])
    pitches = pitches_of(flat[start:])

    def set_in(lines: List[Line]) -> bool:
        return all(frames[line.page].indented(line) for line in lines)

    paragraphs: List[List[Line]] = []
    current: List[Line] = []
    after_set_in = False

    def close() -> None:
        """End the paragraph being read: it is kept when it is the court's own prose."""
        nonlocal current, after_set_in
        joined = " ".join(line.text for line in current)
        if _not_prose(joined, joined):
            current = []  # the list of counsel, the caption, the names of the judges: passed over like a heading
            return
        if len(current) >= 2 and set_in(current):
            after_set_in = True
        elif after_set_in and not frames[current[0].page].indented(current[0]):
            after_set_in = False  # the paragraph before the set-in passage, going on below it: left out, once
        else:
            after_set_in = False
            paragraphs.append(current)
        current = []

    index = start
    if rest_of_first:
        rest_of_first = _PARAGRAPH_NUMBER_RE.sub("", rest_of_first)
        first = flat[index]
        current.append(Line(page=first.page, top=first.top, bottom=first.bottom, text=rest_of_first, left=first.left,
                            right=first.right, size=first.size))
        index += 1
    read = 0
    while index < len(flat) and read < _MAX_LINES:
        line = flat[index]
        frame = frames[line.page]
        index += 1
        read += 1
        if not current:
            line = _without_number(line)
            if _is_heading(line, frame) or not _starts_prose(line.text):
                if paragraphs:
                    break  # the first heading after the opening paragraphs ends them
                continue
            current = [line]
            continue
        last = current[-1]
        ended = bool(_SENTENCE_STOP_RE.search(last.text))
        line_in = frame.indented(line)
        gap = line.top - last.top
        pitch = pitches.get(line.page) or gap
        if len(current) >= 2 and set_in(current):
            # A set-in passage goes on while lines begin where its lines begin and follow at its own distance. A line at
            # the margin, a line set in differently (the first line of the court's next paragraph) or a wider gap ends it.
            stays = line_in and abs(line.left - min(item.left for item in current)) <= _SET_IN_TOLERANCE
            if stays and line.page == last.page:
                own = last.top - current[-2].top if current[-2].page == last.page else 0
                stays = gap > 0 and not (own > 0 and gap > own * 1.45)
            new = not stays
        elif set_in(current) and line_in and not ended and (line.page != last.page or 0 < gap <= pitch * 1.45):
            # A second line set in like the first, where the first did not end a sentence: a set-in passage begins. The
            # second line of a paragraph of the court's own returns to the margin.
            new = False
        elif line.page != last.page:
            # Across a page a paragraph that was left unfinished continues, and it continues at the margin.
            new = _is_heading(line, frame) or (ended and (line_in or frames[last.page].short(last)))
        else:
            new = (line_in or gap > pitch * 1.45 or gap <= 0 or (ended and frame.short(last))
                   or (ended and _is_heading(line, frame)))
        if not new:
            current.append(line)
            continue
        close()
        if len(paragraphs) >= OPENING_PARAGRAPHS:
            break
        index -= 1  # the line that ended the paragraph is looked at again: it begins the next one or is a heading
        read -= 1
    if current and len(paragraphs) < OPENING_PARAGRAPHS:
        close()
    return paragraphs


# --- from paragraphs to a quotation -------------------------------------------------------------------------

_ARTIFACT_RES = [re.compile(r"Appellate Case|Date Filed|Document: ?\d|USCA\d|Page: ?\d"), re.compile(r"_{4,}")]


#: Signs an opinion is set in besides the letters, digits and punctuation of the keyboard.
_SIGNS = set("§¶°·½¼¾×©®™•…–—‐‑‒―‘’‚“”„′″†‡€£ ")


def legible(text: str) -> bool:
    """Whether every character of a passage is one an opinion is written in.

    A PDF whose typeface is mapped wrongly gives other signs for the joined letters "ff" and "ffi", or for a whole run
    of words, and both readings of the file then agree on them. Such signs lie outside the letters of Western European
    languages, so a passage that holds a letter beyond them, or a sign that is not listed, is not quoted. A name
    written with such a letter is refused with it: a passage is rather not quoted than quoted wrongly.
    """
    for character in text:
        if character in _SIGNS or " " <= character <= "~":
            continue
        if unicodedata.category(character).startswith("L") and "\u00c0" <= character <= "\u00ff":
            continue
        return False
    return True


def passes(text: str) -> bool:
    """Whether a passage may be published as a quotation."""
    if not MIN_CHARS <= len(text) <= MAX_CHARS + 20:
        return False
    if not legible(text):
        return False
    if not re.match(r"^[\"“‘'\[(]?[A-Z0-9]", text):
        return False
    if any(pattern.search(text) for pattern in _ARTIFACT_RES):
        return False
    letters = sum(1 for c in text if c.isalpha() or c == " ")
    return letters / len(text) >= 0.8 and len(text.split()) >= 10


#: The list of counsel at the head of a state court's opinion: "Jane Roe, of Roe LLP, Miami, for Appellant." It ends
#: by naming the party, or it names a law firm or a public office and, anywhere, the party it acts for.
_PARTY = (r"(?:the )?(?:appellants?|appellees?|petitioners?|respondents?|plaintiffs?|defendants?|relators?|intervenors?|real part(?:y|ies)"
          r"|amic(?:us|i)\b")
_COUNSEL_RE = re.compile(r"\bfor " + _PARTY + r"[^.]*|(?:the )?(?:state|people|commonwealth)\b[^.]*)\.?$|^(?:Attorneys?|Counsel)(?: for\b|:)", re.I)
_FIRM_RE = re.compile(r"\b(?:L\.?L\.?P|P\.?L\.?L\.?C|L\.?L\.?C|P\.A|P\.C|PL|Law (?:Firms?|Offices?|Group)|Attorneys? General|Solicitor General"
                      r"|Public Defender|County Counsel|District Attorney|Esq)\b")
_FOR_PARTY_RE = re.compile(r"\b(?:Counsel )?for " + _PARTY + r")", re.I)
#: The caption of the case, set again above the text in some files: "Holtz et al. v. Moreles, as Registrar of Voters".
_CAPTION_RE = re.compile(r"^(?P<first>.*?)\sv(?:s)?\.\s.*?(?P<last>\bet al\.|\betc\.)?$")
_CAPTION_WORDS = 20
#: The line that names who wrote the opinion and who joined it: "Presiding Judge Vásquez authored the opinion of the
#: Court, in which Chief Judge Staring ... concurred."
_JOINED_RE = re.compile(r"^[^.]{0,120}?\b(?:authored|delivered|wrote|announced)\b (?:the )?(?:majority |plurality |unanimous )?"
                        r"(?:opinion|judgment|decision)\b", re.I)


#: The end of a list of the judges of a panel.
_JUDGES_RE = re.compile(r"\b(?:JJ|Judges?|Justices?)\.$")
#: Words of the court's prose that a list of counsel does not hold.
_PROSE_WORDS_RE = re.compile(r"\b(?:is|are|was|were|has|have|had|held|holds|hold|we|our|us|court|granted|denied|entered|affirm|affirmed|"
                             r"reverse|reversed|appeals|appealed|sued|seeks|sought|claims|contends|argues|developed|concluded|decide)\b", re.I)


def _is_counsel(paragraph: str) -> bool:
    """Whether a paragraph is a list of counsel: one sentence, without the words of the court's prose, that ends by
    naming the party, or that names a law firm or a public office and the party it acts for."""
    if not (_COUNSEL_RE.search(paragraph) or (_FIRM_RE.search(paragraph) and _FOR_PARTY_RE.search(paragraph))):
        return False
    return not sentence_ends(paragraph) and not _PROSE_WORDS_RE.search(paragraph)


def _not_prose(paragraph: str, text: str) -> bool:
    """Whether a paragraph is matter set above an opinion instead of the court's prose: the list of counsel, the
    caption of the case, or the line that names the author and the judges who joined."""
    if _is_counsel(paragraph):
        return True
    caption = _CAPTION_RE.match(paragraph)
    if caption and len(paragraph.split()) < _CAPTION_WORDS and (
            caption.group("last") or not re.search(r"\b(?!et\b|al\b)[a-z]{2,}", caption.group("first"))):
        return True  # "Holtz et al. v. Moreles, as Registrar of Voters, etc., et al.", not "The judgment ... in light of Watson v. RNC"
    if _JUDGES_RE.search(paragraph) and not sentence_ends(paragraph) and not _PROSE_WORDS_RE.search(paragraph):
        return True  # the panel: "Alpha, C.J., Beta, Gamma, and Delta, JJ."
    return bool(_JOINED_RE.match(text))
#: The first words of a separate opinion. Where the opinion read begins so, it is a dissent or a concurrence, and no
#: passage of it is quoted.
_SEPARATE_RE = re.compile(r"^I (?:respectfully )?(?:dissent|concur)\b|^I (?:write|agree)\b.{0,60}\b(?:separately|majority)\b")
#: The disposition set above an opinion ("Vacated and remanded for entry of judgment."): the court's words, but not
#: on what the case is about.
_DISPOSITION_RE = re.compile(r"^(?:Affirmed|Reversed|Vacated|Remanded|Dismissed|Modified|Writ (?:granted|denied))\b[^.]{0,100}\.$", re.I)
#: Openings that every order of a court shares: they say how the case was heard, not what it is about.
_FORMULA_RE = re.compile(
    r"^(?:This (?:appeal|case|cause|matter) (?:was|is|came|comes) (?:considered|submitted|before|on)\b|After examining the briefs\b|"
    r"(?:IT IS )?(?:HEREBY )?ORDERED\b|Upon (?:due )?consideration\b|The court has (?:reviewed|considered)\b|Unpublished opinions are not\b)", re.I)


#: How many letters of other matter (the footnotes at the foot of a page, the head of the next) may stand in the plain
#: text between two parts of a passage, where the passage crosses a page.
PAGE_GAP_LETTERS = 6000
#: Where the page breaks of a passage are not known, each of its two parts must be at least this long.
CONFIRM_PART_LETTERS = 12


def _letters(text: str) -> str:
    return "".join(c.lower() for c in unicodedata.normalize("NFKC", text) if c.isalpha())


def _chained(text: str, parts: List[str], anchor: int, at: int) -> bool:
    """Whether ``parts`` stand in ``text`` in order with ``parts[anchor]`` at ``at`` and no more than a page's other
    matter between one part and the next."""
    end = at + len(parts[anchor])
    for part in parts[anchor + 1:]:
        found = text.find(part, end, end + PAGE_GAP_LETTERS + len(part))
        if found < 0:
            return False
        end = found + len(part)
    start = at
    for part in reversed(parts[:anchor]):
        found = text.rfind(part, max(0, start - PAGE_GAP_LETTERS - len(part)), start)
        if found < 0:
            return False
        start = found
    return True


def _in_parts(text: str, parts: List[str]) -> bool:
    anchor = max(range(len(parts)), key=lambda index: len(parts[index]))
    at = text.find(parts[anchor])
    while at >= 0:
        if _chained(text, parts, anchor, at):
            return True
        at = text.find(parts[anchor], at + 1)
    return False


def _letters_at(text: str) -> Tuple[str, List[int]]:
    """The letters of ``text`` in lower case, and where each of them stands in ``text``."""
    letters, places = [], []
    for place, character in enumerate(text):
        if character.isalpha():
            for letter in character.lower():
                letters.append(letter)
                places.append(place)
    return "".join(letters), places


def _across_a_page(passage_letters: str, document_text: str) -> bool:
    """Whether the passage lies in the document in two parts with the head of a page between them."""
    plain = unicodedata.normalize("NFKC", document_text)
    text, places = _letters_at(plain)
    low, high = 0, len(passage_letters)
    while low < high:  # the longest beginning of the passage that the text holds
        middle = (low + high + 1) // 2
        if passage_letters[:middle] in text:
            low = middle
        else:
            high = middle - 1
    if low < CONFIRM_PART_LETTERS or len(passage_letters) - low < CONFIRM_PART_LETTERS:
        return False
    first, second = passage_letters[:low], passage_letters[low:]
    at = text.find(first)
    while at >= 0:
        end = at + low
        found = text.find(second, end, end + PAGE_GAP_LETTERS + len(second))
        if found >= 0:
            between = plain[places[end - 1] + 1:places[found]]
            if any(_is_head(line.strip()) for line in between.splitlines() if line.strip()):
                return True
        at = text.find(first, at + 1)
    return False


def confirmed(passage: str, document_text: str, breaks: Optional[List[int]] = None) -> bool:
    """Whether the letters of ``passage`` stand in ``document_text``, one after the other with none left out.

    The passage is read from the layout of the PDF, the document text by another program from the same file. A word
    the layout reading dropped or doubled is therefore not in the document text as the passage has it, and the passage
    is not published. Only where the passage crosses a page may other matter stand between its letters, because the
    plain text runs the footnotes and the page head in there: ``breaks`` gives those places, as counts of letters from
    the beginning of the passage.

    Without ``breaks`` the pages of the passage are not known (a passage published before, whose layout cannot be read
    in this run). It must then stand in the document whole, or in two parts with a line between them that is the head
    of a page (the stamp of the court's filing system, a page number). Words a court added to or took out of the
    passage are not such a line, so an amended opinion does not keep the passage of the one it replaced.

    Spacing, punctuation, digits and the case of letters are not compared: footnote marks are digits, and line-end
    hyphens differ between the two readings.
    """
    wanted, text = _letters(passage), _letters(document_text)
    if not wanted:
        return False
    if breaks is not None:
        cuts = sorted({at for at in breaks if 0 < at < len(wanted)})
        return _in_parts(text, [wanted[a:b] for a, b in zip([0, *cuts], [*cuts, len(wanted)])])
    return wanted in text or _across_a_page(wanted, document_text)


def page_breaks(lines: List[Line]) -> List[int]:
    """Where a paragraph crosses a page: the count of its letters above each break."""
    breaks, count = [], 0
    for above, below in zip(lines, lines[1:]):
        count += len(_letters(above.text))
        if below.page != above.page:
            breaks.append(count)
    return breaks


@dataclass
class Opening:
    text: str
    #: True when the quotation stops inside a sentence.
    cut: bool
    page: int
    #: Which paragraph of the opinion's prose is quoted, counted from 1. It is 1 unless an earlier paragraph could not
    #: be quoted. The words that every order begins with are not counted as a paragraph.
    paragraph: int


def opening_passage(layout: str, document_text: str = "") -> Optional[Opening]:
    """The opening passage of the opinion laid out in ``layout``, or ``None`` when the rule finds none it may publish.

    The first paragraph of the opinion's prose is taken. Where it cannot be quoted (it fails a check of
    :func:`passes`, or it is not found in the plain text), the next one is, up to the first heading and the fourth
    paragraph, and the passage then says which paragraph it is. ``document_text`` is the plain text of the same
    document; it is used to tell a hyphen that belongs to a word from one the typesetter put at the end of a line, and
    a passage whose letters are not found in it (:func:`confirmed`) is not taken.
    """
    pages = body_pages(layout)
    number = 0
    for lines in opening_paragraphs(pages):
        paragraph = join_lines([line.text for line in lines], document_text)
        text, cut = quotation(paragraph)
        if _SEPARATE_RE.match(text):
            return None  # a dissent or a concurrence: not the court's opinion
        if _FORMULA_RE.match(text) or _DISPOSITION_RE.match(paragraph):
            continue  # the words every order begins with, or the disposition alone: not a paragraph on the case
        if _not_prose(paragraph, text):
            continue  # the list of counsel, the caption, the names of the judges: not the court's prose
        number += 1
        if not cut and not re.search(r"[.?!][\"”’)\]]*$", text):
            continue  # the paragraph could not be followed to the end of a sentence
        if passes(text) and (not document_text or confirmed(text, document_text, page_breaks(lines))):
            return Opening(text=text, cut=cut, page=lines[0].page, paragraph=number)
    return None
