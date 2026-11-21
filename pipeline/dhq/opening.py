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
2. The opinion begins after the line that names its author ("SMITH, Circuit Judge." or "PER CURIAM:") or, where there
   is none, after the line that names the panel ("Before A, B, and C, Circuit Judges.").
3. Headings are passed over. Of the first paragraphs of prose, up to the first heading inside the opinion, the first
   that speaks of the case is taken (it says who appeals, who sued, what is at issue), across a page break if it
   continues there.
4. Footnote marks are left out. A word that the page broke across two lines is joined again.
5. The paragraph is quoted from its beginning, sentence by sentence, until the quotation is long enough to say what the
   case is about.
6. The passage is checked against the plain text of the same file, which another program reads: its letters must stand
   there in the same order. A passage that fails a check (too short, not a sentence, a remnant of a page head in it,
   not found in the plain text) is not published at all: a case then simply has no quotation.
"""
from __future__ import annotations

import html
import re
import subprocess
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .about import MAX_CHARS, MIN_CHARS, join_lines, quotation

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

_BEFORE_RE = re.compile(r"^(?:Before|BEFORE|Present|PRESENT)\b:?")
_PANEL_END_RE = re.compile(r"\bJudges?\b\.?[\s*]*$|\bJudges?\b\.")
#: The line that opens the opinion by naming its author. A concurrence or dissent is named differently
#: ("..., Circuit Judge, concurring:") and does not match.
_AUTHOR_RE = re.compile(
r"^(?:(?!Before\b|BEFORE\b)[A-Z][A-Za-z.'’\- ]{1,48}, (?:(?:Chief|Senior|Circuit|District) ){1,2}Judge|P(?:ER|er) C(?:URIAM|uriam))\s*[.:]?\s*"
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


def _frame(lines: List[Line]) -> Optional[_Frame]:
    long_lines = _long(lines)
    if not long_lines:
        return None
    lefts = Counter(round(line.left / 3) * 3 for line in long_lines)
    rights = sorted(line.right for line in long_lines)
    return _Frame(left=lefts.most_common(1)[0][0], right=rights[int(len(rights) * 0.85)])


#: A page needs this many long lines of body text for its own edges to be measured.
_FRAME_LINES = 8


def frames_of(lines: List[Line]) -> Dict[int, _Frame]:
    """The edges of the body text on each page of ``lines`` (the opinion from where it begins).

    A page with enough text is measured by itself. A page with little text (the page the opinion begins on, below the
    caption) takes the width of the well-filled pages and starts at its own leftmost long line.
    """
    by_page: Dict[int, List[Line]] = {}
    for line in lines:
        by_page.setdefault(line.page, []).append(line)
    measured = {page: _frame(items) for page, items in by_page.items() if len(_long(items)) >= _FRAME_LINES}
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


#: The heading above the text of an order or opinion.
_TITLE_RE = re.compile(r"^(?:O ?R ?D ?E ?R|J ?U ?D ?G ?M ?E ?N ?T|OPINION(?: OF THE COURT)?|MEMORANDUM(?: OPINION)?|ORDER AND JUDGMENT|SUMMARY ORDER)[\s*]*$")
_SIGNATURE_RE = re.compile(r"^(?:Entered for the Court|FOR THE COURT)\b", re.I)
#: How far below the line naming the panel a heading such as "ORDER" is still looked for (a caption may lie between).
_TITLE_WINDOW = 45


def _body_start(flat: List[Line]) -> Tuple[Optional[int], Optional[str]]:
    """``(index, rest)``: the line the opinion's text begins on, and the text that follows the author's name where
    both stand on one line. ``(None, None)`` when neither the author nor the panel is named."""
    panel_end: Optional[int] = None
    for index, line in enumerate(flat):
        if _BEFORE_RE.match(line.text):
            for end in range(index, min(index + 5, len(flat))):
                if _PANEL_END_RE.search(flat[end].text):
                    panel_end = end
                    # A court that sets each judge on a line of their own: the panel ends with the last of them.
                    while panel_end + 1 < len(flat) and re.search(r"\bJudge\.?$", flat[panel_end + 1].text):
                        panel_end += 1
                    break
            break
    first = (panel_end + 1) if panel_end is not None else 0
    for index in range(first, len(flat)):
        text = flat[index].text
        match = _AUTHOR_RE.match(text)
        if not match:
            continue
        before = flat[index - 1].text if index else ""
        if _SIGNATURE_RE.match(before):
            break  # "Per Curiam" under "Entered for the Court" signs an order; it does not open one
        rest = text[match.end():].strip()
        if not re.search(r"[.:]\s*$", match.group(0)):
            # A name without a full stop or colon opens the opinion only where it stands alone under the heading
            # "OPINION", or, for "PER CURIAM", directly under the panel.
            per_curiam = "uriam" in match.group(0).lower()
            if rest or not (_TITLE_RE.match(before) or (per_curiam and panel_end is not None and index - panel_end <= 6)):
                continue
        return (index, rest) if rest else (index + 1, None)
    if panel_end is None:
        return None, None
    start = panel_end + 1
    for index in range(start, min(start + _TITLE_WINDOW, len(flat))):
        if _TITLE_RE.match(flat[index].text):
            start = index + 1
    return start, None


def opening_paragraphs(pages: List[List[Line]]) -> List[List[Line]]:
    """The first paragraphs of the opinion, up to its first heading: each a list of lines."""
    flat = [line for page in pages for line in page]
    start, rest_of_first = _body_start(flat)
    if start is None:
        return []
    frames = frames_of(flat[start:])
    pitches = pitches_of(flat[start:])

    paragraphs: List[List[Line]] = []
    current: List[Line] = []
    index = start
    if rest_of_first:
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
            if _is_heading(line, frame) or not _starts_prose(line.text):
                if paragraphs:
                    break  # the first heading after the opening paragraphs ends them
                continue
            current = [line]
            continue
        last = current[-1]
        ended = bool(_SENTENCE_STOP_RE.search(last.text))
        if line.page != last.page:
            # Across a page a paragraph that was left unfinished continues, and it continues at the margin.
            new = _is_heading(line, frame) or (ended and (frame.indented(line) or frames[last.page].short(last)))
        else:
            gap = line.top - last.top
            pitch = pitches.get(line.page) or gap
            new = (frame.indented(line) or gap > pitch * 1.45 or gap <= 0 or (ended and frame.short(last))
                   or (ended and _is_heading(line, frame)))
        if not new:
            current.append(line)
            continue
        paragraphs.append(current)
        current = []
        if len(paragraphs) >= OPENING_PARAGRAPHS:
            break
        index -= 1  # the line that ended the paragraph is looked at again: it begins the next one or is a heading
        read -= 1
    if current and len(paragraphs) < OPENING_PARAGRAPHS:
        paragraphs.append(current)
    return paragraphs


# --- from paragraphs to a quotation -------------------------------------------------------------------------

_ARTIFACT_RES = [re.compile(r"Appellate Case|Date Filed|Document: ?\d|USCA\d|Page: ?\d"), re.compile(r"_{4,}")]


def passes(text: str) -> bool:
    """Whether a passage may be published as a quotation."""
    if not MIN_CHARS <= len(text) <= MAX_CHARS + 20:
        return False
    if not re.match(r"^[\"“‘'\[(]?[A-Z0-9]", text):
        return False
    if any(pattern.search(text) for pattern in _ARTIFACT_RES):
        return False
    letters = sum(1 for c in text if c.isalpha() or c == " ")
    return letters / len(text) >= 0.8 and len(text.split()) >= 10


#: Words by which a paragraph speaks of the case before the court, and not yet of the law or of history.
_POSTURE_RE = re.compile(
    r"\b(?:appeals?|appealed|challeng\w+|sued|sues|lawsuit|suit|petition\w*|alleg\w+|claims?|claimed|this case|this action|"
    r"we (?:hold|consider|affirm|reverse|vacate|conclude|dismiss|must decide|agree|disagree)|the question|at issue|"
    r"district court|plaintiffs?|appellants?|petitioners?)\b", re.I)


#: Openings that every order of a court shares: they say how the case was heard, not what it is about.
_FORMULA_RE = re.compile(
    r"^(?:This (?:appeal|case|cause|matter) (?:was|is|came|comes) (?:considered|submitted|before|on)\b|After examining the briefs\b|"
    r"(?:IT IS )?(?:HEREBY )?ORDERED\b|Upon (?:due )?consideration\b|The court has (?:reviewed|considered)\b|Unpublished opinions are not\b)", re.I)


#: In how many pieces at most a passage may lie in the plain text of its document, and how long each but the last is.
CONFIRM_PIECES = 4
CONFIRM_PIECE_LETTERS = 12


def _letters(text: str) -> str:
    return "".join(c.lower() for c in unicodedata.normalize("NFKC", text) if c.isalpha())


def confirmed(passage: str, document_text: str) -> bool:
    """Whether the letters of ``passage`` stand in ``document_text`` in the same order.

    The passage is read from the layout of the PDF, the document text by another program from the same file. The plain
    text runs footnotes and page heads into the body, so the passage may lie there in a few pieces with such matter
    between them; within a piece every letter must follow the one before. Spacing, punctuation, digits and the case of
    letters are not compared: footnote marks are digits, and line-end hyphens differ between the two readings.
    """
    wanted, text = _letters(passage), _letters(document_text)
    position = 0
    for _piece in range(CONFIRM_PIECES):
        if not wanted:
            return True
        low, high = 0, len(wanted)
        while low < high:  # the longest start of what is left that the text holds from here on
            middle = (low + high + 1) // 2
            if text.find(wanted[:middle], position) >= 0:
                low = middle
            else:
                high = middle - 1
        if low < min(CONFIRM_PIECE_LETTERS, len(wanted)):
            return False
        position = text.find(wanted[:low], position) + low
        wanted = wanted[low:]
    return not wanted


@dataclass
class Opening:
    text: str
    #: True when the quotation stops inside a sentence.
    cut: bool
    page: int
    #: Which of the opening paragraphs is quoted, counted from 1.
    paragraph: int


def opening_passage(layout: str, document_text: str = "") -> Optional[Opening]:
    """The opening passage of the opinion laid out in ``layout``, or ``None`` when the rule finds none it may publish.

    Of the opinion's first paragraphs, up to its first heading, the first whose quotation speaks of the case is taken
    (it holds one of the words of ``_POSTURE_RE``), and the very first paragraph where none does. ``document_text`` is
    the plain text of the same document; it is used to tell a hyphen that belongs to a word from one the typesetter
    put at the end of a line, and a passage whose letters are not found in it in order (:func:`confirmed`) is not taken.
    """
    pages = body_pages(layout)
    candidates: List[Opening] = []
    for number, lines in enumerate(opening_paragraphs(pages), start=1):
        paragraph = join_lines([line.text for line in lines], document_text)
        text, cut = quotation(paragraph)
        if not cut and not re.search(r"[.?!][\"”’)\]]*$", text):
            continue  # the paragraph could not be followed to the end of a sentence
        if passes(text) and not _FORMULA_RE.match(text) and (not document_text or confirmed(text, document_text)):
            candidates.append(Opening(text=text, cut=cut, page=lines[0].page, paragraph=number))
    speaking = [candidate for candidate in candidates if _POSTURE_RE.search(candidate.text)]
    for group in (speaking, candidates):
        whole = [candidate for candidate in group if not candidate.cut]
        if whole or group:
            return (whole or group)[0]
    return None
