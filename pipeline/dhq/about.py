"""What a record is about, in the words of an official source (rules ``about-*``).

A list of measures or cases is only useful if each row says at once what the record is about. DemocracyHQ does not
write such a line itself: a sentence composed for this site could be wrong in ways no reader can check. Each record
instead carries a short quotation from a text an official body published about it, with the place it stands in:

- a measure of Congress: the summary written by the Congressional Research Service, or, where none has been published
  yet, the measure's official title when the list shows it under another title (rules ``about-crs-1``, ``about-title-1``);
- a California bill: the Legislative Counsel's Digest, from the first sentence that says what the bill would do
  (``about-digest-1``);
- a Supreme Court docket: the question presented, from the document the Court publishes for the case; for a docket
  that has none, the passage of one of its documents that a maintainer cited to show which place the case concerns,
  and which the pipeline finds in that document on every run; and failing that the first entry of the docket
  (``about-question-1``, ``about-cited-1``, ``about-docket-1``);
- a case decided by a court of appeals, a district court or a court of a state: the opening passage of the opinion
  (``about-opinion-1``, see :mod:`dhq.opening`).

The quotation starts at the beginning of a sentence and runs whole sentences, until it is long enough for a row. Only a
first sentence that is longer than a row can hold is cut, at a word, and the record says so (``cut``).
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

CRS_RULE_ID = "about-crs-1"
TITLE_RULE_ID = "about-title-1"
DIGEST_RULE_ID = "about-digest-1"
QUESTION_RULE_ID = "about-question-1"
CITED_RULE_ID = "about-cited-1"
DOCKET_RULE_ID = "about-docket-1"
OPINION_RULE_ID = "about-opinion-1"

#: A quotation is not extended by another sentence once it has this many characters ...
ENOUGH_CHARS = 220
#: ... and never runs longer than this. A longer first sentence is cut at a word and marked as cut.
MAX_CHARS = 560
MIN_CHARS = 60


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


#: Abbreviations after which a full stop does not end a sentence.
_ABBREVIATIONS = {
    "v", "vs", "no", "nos", "u.s", "u.s.c", "inc", "co", "corp", "ltd", "mr", "ms", "mrs", "dr", "jr", "sr", "st", "fed", "civ", "crim",
    "app", "cir", "stat", "ann", "const", "art", "amend", "cl", "sec", "rev", "gov", "sen", "rep", "hon", "al", "i.e", "e.g", "cf",
    "id", "ex", "dkt", "doc", "ecf", "compl", "supp", "ch", "tit", "para", "pp", "op", "cal", "tex", "miss", "ala", "ariz", "ark", "colo", "conn", "del",
    "fla", "ga", "ill", "ind", "kan", "ky", "la", "mass", "md", "mich", "minn", "mo", "mont", "neb", "nev", "okla", "or", "pa", "tenn",
    "va", "vt", "wash", "wis", "wyo", "n.c", "s.c", "n.d", "s.d", "n.y", "n.j", "n.m", "n.h", "w.va", "d.c", "dep't", "dept", "ass'n",
    "assn", "comm'n", "dist", "div", "ct", "atty", "gen", "sup", "pub", "reg", "res", "sess", "ed", "eds", "etc", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec", "f", "p", "r",
    # Words of a citation: codes, reporters, records and the names of parties and bodies.
    "elec", "cnty", "cntys", "cong", "rec", "am", "pls", "pl", "nat", "nat'l", "int'l", "comm", "comm'r", "mt", "ft", "bd", "educ", "ins",
    "univ", "mun", "admin", "auth", "bros", "bldg", "ctr", "cmty", "def", "defs", "resp", "pet", "br", "mem", "mot", "tr", "hr'g", "aff",
    "decl", "exh", "exs", "sch", "soc", "serv", "servs", "sys", "tel", "transp", "twp", "mfg", "mgmt", "gov't", "envtl", "fin", "indus",
    "info", "legis", "lab", "liab", "litig", "org", "prod", "prot", "rd", "ry", "sav", "sec'y", "ave", "blvd", "hwy", "evid", "proc",
    "prac", "subd", "subds", "par", "vol", "seq", "cert", "approx", "est", "assoc", "commw", "constr", "dev", "distrib", "emp", "enf",
    "fed'n", "grp", "hosp", "hous", "indep", "inst", "invs", "jud", "ne", "nw", "se", "sw", "pship", "prop", "props",
    "pub'g", "rehab", "retd", "rts", "sols", "tech", "techs", "telecomm", "util", "utils", "cas", "bankr", "mil", "vet", "rptr",
}
_SENTENCE_END_RE = re.compile(r"[.?!][\"”’)\]]*(?= [\"“‘\[(]?[A-Z])")
#: A short capitalised word before a full stop is more often an abbreviation the list above does not hold ("Tex. Elec.
#: Code", "Fulton Cnty. Bd.") than the end of a sentence ("... under the Act. The court ..."). It ends a sentence only
#: when the next word is one a sentence commonly begins with. An ending missed this way makes a quotation run on to the
#: next one; a wrong ending would cut it inside a sentence without saying so.
_SHORT_WORD = 5
_OPENERS = {
    "a", "an", "the", "this", "that", "these", "those", "it", "its", "he", "she", "they", "we", "his", "her", "their", "our", "i",
    "in", "on", "at", "by", "for", "to", "of", "from", "with", "under", "after", "before", "during", "since", "until", "upon", "as",
    "and", "but", "or", "nor", "yet", "so", "if", "when", "while", "where", "whether", "because", "although", "though", "unless",
    "once", "here", "there", "then", "thus", "now", "today", "nevertheless", "however", "moreover", "instead", "indeed", "accordingly",
    "each", "every", "any", "no", "not", "none", "all", "both", "some", "most", "many", "such", "other", "another", "one", "two",
    "three", "four", "five", "several", "who", "what", "which", "how", "why", "plaintiffs", "plaintiff", "defendants", "defendant",
    "appellants", "appellant", "appellees", "appellee", "petitioners", "petitioner", "respondents", "respondent", "congress",
    "existing", "according", "following", "does", "did", "do", "is", "are", "was", "were", "may", "can", "must", "should",
    "would", "could", "will", "having", "given", "like", "unlike", "despite", "without", "within", "among", "between", "over",
    "only", "even", "still", "also", "further", "finally", "first", "second", "third", "next", "later", "soon", "shortly",
}


def sentence_ends(text: str) -> List[int]:
    """Positions just after each sentence of ``text`` that is followed by another."""
    ends = []
    for match in _SENTENCE_END_RE.finditer(text):
        before = text[:match.start()]
        word = re.search(r"([\w.'’]+)$", before)
        raw = word.group(1).rstrip(".") if word else ""
        token = raw.lower()
        if text[match.start()] == ".":
            if token in _ABBREVIATIONS or re.fullmatch(r"[a-z]", token) or re.fullmatch(r"(?:[a-z]\.)+[a-z]?", token):
                continue
            following = re.match(r" [\"“‘\[(]?([A-Za-z’']+)", text[match.end():])
            if (raw[:1].isupper() and raw.isalpha() and len(raw) <= _SHORT_WORD
                    and (following is None or following.group(1).lower() not in _OPENERS)):
                continue
        ends.append(match.end())
    return ends


def quotation(paragraph: str) -> Tuple[str, bool]:
    """``(text, cut)``: the paragraph from its beginning, sentence by sentence, until it is long enough.

    ``cut`` is true when the text stops inside a sentence (the first sentence is longer than a row can hold).
    """
    ends = sentence_ends(paragraph)
    if re.search(r"[.?!][\"”’)\]]*$", paragraph):
        ends.append(len(paragraph))
    chosen = 0
    for end in ends:
        if end > MAX_CHARS:
            break
        chosen = end
        if end >= ENOUGH_CHARS:
            break
    if chosen:
        return paragraph[:chosen], False
    if len(paragraph) <= MAX_CHARS:
        return paragraph, False  # no sentence ends in it; the caller does not publish such a passage
    space = paragraph.rfind(" ", 0, MAX_CHARS)
    return paragraph[:space].rstrip(" ,;:"), True


_LINE_HYPHEN_RE = re.compile(r"([A-Za-z]{2,})-$")
#: A word, or a pair of words, that the plain text of a document breaks with a hyphen at the end of a line.
_LINE_BROKEN_RE = re.compile(r"[A-Za-z]+-[^\S\n]*\n\s*[A-Za-z]+")


#: First parts that form compounds with a hyphen ("self-described"), for a pair the document writes nowhere else.
_COMPOUND_HEADS = {"self", "well", "quasi", "vice", "cross", "court", "one", "two", "three", "four", "five", "six", "first", "second",
                   "third", "state", "so", "then", "long", "short", "high", "low", "full", "part", "single"}


def _hyphen_stays(left: str, right: str, document: str) -> bool:
    """Whether the hyphen at the end of a line belongs to the word ("campaign-" / "finance") or only divides it
    ("gerryman-" / "dered"), judged from the rest of the document: it stays where the document writes the pair with a
    hyphen on one line; it goes where the document writes the joined word; and where the document has neither, it stays
    only if both parts are words the document uses by themselves."""
    left, right = left.lower(), right.lower()
    hyphenated = len(re.findall(rf"\b{re.escape(left)}-{re.escape(right)}\b", document))
    joined = len(re.findall(rf"\b{re.escape(left + right)}\b", document))
    if hyphenated or joined:
        return hyphenated > joined
    if left in _COMPOUND_HEADS:
        return True
    # The two halves of a word that a line of the document breaks are not words it uses by themselves.
    unbroken = _LINE_BROKEN_RE.sub(" ", document)
    return bool(re.search(rf"\b{re.escape(left)}\b(?!-)", unbroken)) and bool(re.search(rf"(?<!-)\b{re.escape(right)}\b", unbroken))


def join_lines(lines: List[str], document: str = "") -> str:
    """The lines as one text. A word the page broke across two lines is joined again (see :func:`_hyphen_stays`)."""
    lowered = document.lower()
    text = ""
    for line in lines:
        match = _LINE_HYPHEN_RE.search(text)
        word = re.match(r"[A-Za-z]+", line)
        if match and word:
            # A capital after the hyphen is a name in two parts ("Williams-" / "Yulee"): the hyphen is part of it.
            keep = word.group(0)[0].isupper() or _hyphen_stays(match.group(1), word.group(0), lowered)
            text = (text if keep else text[:-1]) + line
        elif re.search(r"\S[—–]$", text):
            text += line  # a dash set without spaces takes none at the end of a line either
        else:
            text += (" " if text else "") + line
    return re.sub(r"\s+", " ", text).strip()


# --- the sources ----------------------------------------------------------------------------------------------

def _about(text: str, source: str, rule_id: str, *, cut: bool = False, url: Optional[str] = None, date: Optional[str] = None,
           of: Optional[int] = None, document: Optional[str] = None, later: Optional[dict] = None,
           paragraph: Optional[int] = None) -> dict:
    return {"text": text, "source": source, "url": url, "date": date, "cut": cut, "of": of, "document": document, "later": later,
            "paragraph": paragraph, "ruleId": rule_id}


def _is_sentence(text: str) -> bool:
    return bool(re.search(r"[.?!][\"”’)\]]*$", text)) and len(text.split()) >= 6


def _paragraphs(text: str) -> List[str]:
    return [flat for flat in (_flat(part) for part in re.split(r"\n\s*\n", text)) if flat]


def crs_summary(digest: Optional[str], *, url: Optional[str], date: Optional[str]) -> Optional[dict]:
    """The beginning of the first paragraph of the summary that is a sentence: a summary opens with the measure's short
    title on a line of its own, and that line is passed over."""
    for paragraph in _paragraphs(digest or ""):
        if _is_sentence(paragraph):
            text, cut = quotation(paragraph)
            return _about(text, "crs-summary", CRS_RULE_ID, cut=cut, url=url, date=date)
    return None


def official_title(title: Optional[str], shown: Optional[str], *, url: Optional[str]) -> Optional[dict]:
    """The official title, for a measure that has no summary and is listed under another title."""
    title = _flat(title or "")
    if not title or title == _flat(shown or ""):
        return None
    text, cut = quotation(title)
    return _about(text, "official-title", TITLE_RULE_ID, cut=cut, url=url)


#: The sentence of a digest that says what the measure would do.
_WOULD_RE = re.compile(r"^(?:This|The) (?:bill|measure|resolution|constitutional amendment)\b.*\bwould\b")


def counsel_digest(digest: Optional[str], *, url: Optional[str]) -> Optional[dict]:
    """The Legislative Counsel's Digest from its first sentence that says what the bill would do ("This bill would
    ..."), to the end of that paragraph or until the quotation is long enough. A digest first describes existing law;
    that part is passed over. A digest without such a sentence is quoted from its beginning."""
    paragraphs = _paragraphs(digest or "")
    for paragraph in paragraphs:
        start = 0
        for end in [*sentence_ends(paragraph), len(paragraph)]:
            if _WOULD_RE.match(paragraph[start:end].strip()):
                text, cut = quotation(paragraph[start:].strip())
                return _about(text, "digest", DIGEST_RULE_ID, cut=cut, url=url)
            start = end
    for paragraph in paragraphs:
        if _is_sentence(paragraph):
            text, cut = quotation(paragraph)
            return _about(text, "digest", DIGEST_RULE_ID, cut=cut, url=url)
    return None


_QP_HEADING_RE = re.compile(r"^\s*QUESTIONS? PRESENTED:?\s*$", re.I)
#: What the Court adds below the question: the grant, an order, the argument calendar.
_QP_TAIL_RE = re.compile(r"^\s*(?:CERT\. ?GRANTED|JURISDICTION (?:NOTED|POSTPONED)|PROBABLE JURISDICTION|FURTHER CONSIDERATION|"
                         r"CONSOLIDATED WITH|EXPEDITED BRIEFING|THE (?:PETITION|MOTION|APPLICATION) (?:FOR|TO|OF)\b)", re.I)
_QP_ASKED_RE = re.compile(r"\bquestions? presented\b[^.?:]{0,60}\b(?:is|are)\b[^.?:]{0,40}:\s*", re.I)
_QP_WHETHER_RE = re.compile(r"(?:^|(?<=[.?!] ))[^.?!]{0,40}\bquestions? presented\b[^.?:]{0,40}\b(?:is|are) whether\b", re.I)
_QP_NUMBER_RE = re.compile(r"^\(?(\d{1,2})[.)]\s*")


def _qp_paragraphs(text: str) -> List[str]:
    """The paragraphs of a Questions Presented document below its heading. A paragraph begins after an empty line or at
    a line that is set in from the margin; lines that belong to the Court's orders below the question are left out."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if _QP_HEADING_RE.match(line):
            lines = lines[index + 1:]
            break
    paragraphs: List[List[str]] = []
    fresh = True
    for line in lines:
        if not line.strip() or line.strip() in {"□", "•"}:
            fresh = True
            continue
        if _QP_TAIL_RE.match(line):
            fresh = True
            paragraphs.append([])  # an order line: kept out of the paragraph before it, and dropped below
            continue
        if fresh or line[:1].isspace() or _QP_NUMBER_RE.match(line.strip()):
            paragraphs.append([])
        paragraphs[-1].append(line.strip())
        fresh = False
    # Digits glued to the last full stop of a paragraph are the page's number, not the Court's words ("§10301.21").
    return [re.sub(r"(?<=[a-z\d]\.)\d{1,3}$", "", join_lines(lines_, text)) for lines_ in paragraphs if lines_]


def _numbered_from(paragraphs: List[str], index: int) -> int:
    """How many numbered questions begin at ``paragraphs[index]``: 0 unless it is numbered "1", else the length of the
    run 1, 2, 3 ... that follows (a question may run over several paragraphs)."""
    first = _QP_NUMBER_RE.match(paragraphs[index])
    if not first or first.group(1) != "1":
        return 0
    count = 1
    for paragraph in paragraphs[index + 1:]:
        match = _QP_NUMBER_RE.match(paragraph)
        if match and int(match.group(1)) == count + 1:
            count += 1
    return count


#: An order of the Court that puts a further question to the parties: "... ADDRESSING THE FOLLOWING QUESTION ...: WHETHER ...".
_QP_FURTHER_RE = re.compile(r"\baddressing the following questions?\b[^:?.]{0,80}:\s*", re.I)
_QP_ORDER_DATE_RE = re.compile(r"\border of ([a-z]+) (\d{1,2}), (\d{4})", re.I)
#: How far above the question the line that heads its order is looked for, in characters of the document's text.
_QP_ORDER_HEAD = 240
_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december")


def further_question(text: Optional[str]) -> Optional[dict]:
    """``{"text", "date", "cut"}``: the latest question an order of the Court put to the parties after the question
    presented, or ``None``.

    The Court's document for a case goes on below the question with the Court's orders in the case. An order can ask
    the parties to brief a further question ("... are directed to file supplemental briefs addressing the following
    question ...: Whether ..."). Such a question can come to be what the case turns on, and the question the parties
    presented does not show it. The question is quoted as the Court set it, which is in capitals, with the date of the
    order where the document gives one. It does not replace the question presented; it is shown after it.
    """
    flat = re.sub(r"\s+", " ", text or "")
    orders = [match.start() for match in _QP_FURTHER_RE.finditer(flat)]
    found: Optional[dict] = None
    seen = 0
    for paragraph in _qp_paragraphs(text or ""):
        for match in _QP_FURTHER_RE.finditer(paragraph):
            seen += 1
            rest = paragraph[match.end():].strip()
            ends = sentence_ends(rest)
            question, cut = (rest[:ends[0]] if ends else rest).strip(), False
            if len(question) > MAX_CHARS:
                question, cut = question[:question.rfind(" ", 0, MAX_CHARS)].rstrip(" ,;:"), True
            if len(question) < 25 or not (cut or re.search(r"[.?]$", question)):
                continue
            # The date stands in the line that heads the order ("ORDER OF MAY 4, 2023"), close above the question.
            date = None
            if seen <= len(orders):
                head = flat[max(0, orders[seen - 1] - _QP_ORDER_HEAD):orders[seen - 1]]
                for month, day, year in _QP_ORDER_DATE_RE.findall(head):
                    if month.lower() in _MONTHS:
                        date = f"{year}-{_MONTHS.index(month.lower()) + 1:02d}-{int(day):02d}"
            found = {"text": question, "date": date, "cut": cut}
    return found


def question_presented(text: Optional[str], *, url: Optional[str]) -> Optional[dict]:
    """The question a Supreme Court case presents, from the Court's Questions Presented document.

    The document usually tells the story of the case before it asks the question. The question is looked for in this
    order: what follows the words "the question presented is:" (the latest such passage, since an order of the Court
    can amend the question); the sentence "the question presented is whether ..."; the first of several numbered
    questions; the first paragraph that begins with "Whether" or ends with a question mark; and otherwise the
    beginning of the document's text. A further question that a later order of the Court put to the parties is
    carried with it (:func:`further_question`).
    """
    paragraphs = _qp_paragraphs(text or "")
    if not paragraphs:
        return None

    def made(passage: str, of: Optional[int] = None) -> Optional[dict]:
        quoted, cut = quotation(passage)
        if len(quoted) < 25:
            return None
        return _about(quoted, "question-presented", QUESTION_RULE_ID, cut=cut, url=url, of=of, later=further_question(text))

    for index in range(len(paragraphs) - 1, -1, -1):
        match = None
        for match in _QP_ASKED_RE.finditer(paragraphs[index]):
            pass
        if match:
            rest, at = paragraphs[index][match.end():].strip(), index
            if not rest and index + 1 < len(paragraphs):
                rest, at = paragraphs[index + 1], index + 1
            numbered = _numbered_from(paragraphs, at) if at != index else 0
            found = made(_QP_NUMBER_RE.sub("", rest), of=numbered if numbered > 1 else None) if rest else None
            if found:
                return found
    for paragraph in paragraphs:
        match = _QP_WHETHER_RE.search(paragraph)
        if match:
            found = made(paragraph[match.start():].strip())
            if found:
                return found
    for index, paragraph in enumerate(paragraphs):
        if _numbered_from(paragraphs, index):
            count = _numbered_from(paragraphs, index)
            found = made(_QP_NUMBER_RE.sub("", paragraph), of=count if count > 1 else None)
            if found:
                return found
            break
    for paragraph in paragraphs:
        if re.match(r"^Whether\b", paragraph, re.I) or paragraph.endswith("?"):
            found = made(paragraph)
            if found:
                return found
    return made(paragraphs[0])


def cited_passage(links: List[dict]) -> Optional[dict]:
    """The passage cited for the first of a docket's links to a place (rule ``cases-seed-2``): a maintainer chose it
    from a document of the docket, and the pipeline found it there. ``document`` says which document it is from, in
    the words published with the link; from a party's filing it is that party's account."""
    for link in links:
        support = link.get("support") or {}
        quote = _flat(support.get("quote") or "")
        if not quote or not support.get("url"):
            continue
        text, cut = (quote, False) if len(quote) <= MAX_CHARS else quotation(quote)
        # A passage that stops before the end of its sentence is marked like one that was cut.
        cut = cut or not re.search(r"[.?!][\"”’)\]]*$", text)
        return _about(text, "cited-passage", CITED_RULE_ID, cut=cut, url=support["url"], document=support.get("document"))
    return None


def docket_entry(events: List[dict], *, url: Optional[str]) -> Optional[dict]:
    """The entry that opens a docket ("Application (23A449) to vacate stay, submitted to Justice Alito."), for a docket
    that has no Questions Presented document."""
    opening = sorted((e for e in events if e.get("eventType") == "initiating_filing" and e.get("description")),
                     key=lambda e: (e.get("date") or "", e.get("id") or ""))
    if not opening:
        return None
    text, cut = quotation(_flat(opening[0]["description"]))
    return _about(text, "docket-entry", DOCKET_RULE_ID, cut=cut, url=url, date=opening[0].get("date"))


def opinion(text: str, cut: bool, *, url: str, date: Optional[str], paragraph: int = 1) -> dict:
    """The opening passage :mod:`dhq.opening` found in an opinion, as a record's ``about``. ``paragraph`` is carried
    only where the passage is not the opinion's first paragraph, so that the line can say which one it is."""
    return _about(text, "opinion", OPINION_RULE_ID, cut=cut, url=url, date=date, paragraph=paragraph if paragraph > 1 else None)


#: A passage shorter than this says nothing about a record and is not published.
SHORTEST = 20


def _worth(found: Optional[dict]) -> Optional[dict]:
    return found if found and len(found["text"]) >= SHORTEST else None


def of_bill(record: dict) -> Optional[dict]:
    """``about`` for a published measure: a measure of Congress or a California bill."""
    url = record.get("officialUrl")
    if record.get("stateAbbr") == "US":
        return (_worth(crs_summary(record.get("digest"), url=url, date=record.get("digestDate")))
                or _worth(official_title(record.get("title"), record.get("subject"), url=url)))
    return _worth(counsel_digest(record.get("digest"), url=url))


def of_docket(record: dict, links: Optional[List[dict]] = None) -> Optional[dict]:
    """``about`` for a Supreme Court docket. ``links`` are its published links to places, in the order of the seed."""
    questions = record.get("questionsPresented") or {}
    return (_worth(question_presented(questions.get("text"), url=questions.get("url")))
            or _worth(cited_passage(links or []))
            or _worth(docket_entry(record.get("events") or [], url=record.get("sourceUrl"))))


#: The rules as they are published in classification.json.
RULES = [
    {"ruleId": CRS_RULE_ID, "appliesTo": "What a measure of Congress is about, in a list and at the head of its page",
     "description": "Quoted from the summary the Congressional Research Service wrote for the measure: the beginning of the first "
                    "paragraph that is a sentence (a summary opens with the short title on a line of its own, which is passed over). "
                    "Nothing is reworded. The quotation runs in whole sentences until it is at least "
                    f"{ENOUGH_CHARS} characters long and never beyond {MAX_CHARS}; a first sentence longer than that is cut at a "
                    "word and shown with an ellipsis. The same lengths hold for every rule below."},
    {"ruleId": TITLE_RULE_ID, "appliesTo": "What a measure of Congress without a published summary is about",
     "description": "Where the Congressional Research Service has not published a summary yet and the measure is listed under a "
                    "short title, its official title is quoted. A measure that is listed under its official title has no further line."},
    {"ruleId": DIGEST_RULE_ID, "appliesTo": "What a California bill is about",
     "description": "Quoted from the Legislative Counsel's Digest, starting at its first sentence that says what the bill would do "
                    "(the pattern " + _WOULD_RE.pattern + " at the start of a sentence). A digest first describes existing law; that "
                    "part is passed over. A digest without such a sentence is quoted from its beginning."},
    {"ruleId": QUESTION_RULE_ID, "appliesTo": "What a Supreme Court case is about",
     "description": "Quoted from the Questions Presented document the Court publishes for the case. The question is looked for in "
                    "this order: what follows the words 'the question presented is:' (the latest such passage, since an order of the "
                    "Court can amend the question); the sentence 'the question presented is whether ...'; the first of several "
                    "numbered questions, with their number; the first paragraph that begins with 'Whether' or ends with a question "
                    "mark; otherwise the beginning of the text. Lines the Court adds below the question (the grant, the argument "
                    "calendar) are left out. Where an order of the Court below the question puts a further question to the "
                    "parties ('... are directed to file supplemental briefs addressing the following question: ...'), the "
                    "latest such question is shown after the question presented, as the Court set it (in capitals), with the "
                    "date of the order."},
    {"ruleId": CITED_RULE_ID, "appliesTo": "What a Supreme Court docket without a Questions Presented document is about",
     "description": "The passage cited for the first of the docket's links to a place is shown (rule cases-seed-2): a maintainer "
                    "chose it from a document of the docket, and the pipeline finds it in that document on every run that refreshes "
                    "the docket. The line names the document. A passage from the filing that opened the docket is the account of "
                    "the party that filed it, not a finding of the Court. A passage that begins or stops inside a sentence is "
                    "shown with an ellipsis."},
    {"ruleId": DOCKET_RULE_ID, "appliesTo": "What a Supreme Court docket with neither a Questions Presented document nor a cited passage is about",
     "description": "The entry that opens the docket is quoted, for example an application for a stay. It names the kind of "
                    "request, not its subject; the issue tags and the court below say more."},
    {"ruleId": OPINION_RULE_ID, "appliesTo": "What a case decided by a court of appeals, a district court or a court of a state is about",
     "description": "Quoted from the opening of the opinion the selection rule rests on. The layout of the opinion's first pages is "
                    "read (poppler's pdftohtml), so that running heads, page numbers, footnotes and footnote marks can be told from "
                    "the text by their place and type size and left out. The opinion begins after the line that names its author "
                    "('SMITH, Circuit Judge.', 'PER CURIAM:', 'ROWAN, PRESIDING JUSTICE, FOR THE COURT:', 'ROWAN, J.—', "
                    "'McCORMICK, C.') or, where there is none, after the line that names the panel ('Before ...', '(By: ...)'), "
                    "or else after the heading of the opinion near the head of the file ('MEMORANDUM OPINION', 'O P I N I O N'). "
                    "A judge's name that signs an order (under 'FOR THE COURT', or among other judges' names), that names the "
                    "judge of the court appealed from, or that stands beside other words is not taken for the author, and a "
                    "panel named below the opinion is not taken for its beginning. Its first paragraph is quoted. The numbers "
                    "some courts set before each paragraph ('¶1', '{¶ 1}') are left out. The list of counsel, the caption set "
                    "again above the text, the line that names who joined the opinion, the disposition alone ('Affirmed.') and "
                    "the words every order begins with ('This appeal was considered on the record ...') are passed over, and "
                    "so is a passage the court sets in from the margin, such as a statute it quotes: it carries no quotation "
                    "marks and would read as the court's words. A file whose opinion begins 'I respectfully dissent' or 'I "
                    "concur' is a separate opinion and has no quotation. A word the page broke across "
                    "two lines is joined again, with or without its hyphen as the rest of the opinion writes it. The passage is "
                    "then checked against the plain text of the same file, read by another program (pdftotext): its letters "
                    "must stand there one after the other, with none left out; other matter may stand between them only where "
                    "the passage crosses a page, since the plain text runs the footnotes and the page head in there. A "
                    "paragraph that fails a check (too short, not ending with a sentence, a remnant of a page head in it, a "
                    "character of a wrongly mapped typeface, not found in the plain text) is not quoted. The next paragraph is "
                    "then tried, up to the first heading and the fourth paragraph, and the line says which paragraph of the "
                    "opinion it quotes. Where none passes, the case has no quotation."},
]
for _rule in RULES:
    _rule["description"] = _rule["description"].strip() + (
        "" if _rule["ruleId"] == DOCKET_RULE_ID else
        f" The quotation runs whole sentences until it has {ENOUGH_CHARS} characters; a first sentence longer than {MAX_CHARS} "
        "characters is cut at a word and marked as cut.")
