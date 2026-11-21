"""Transparent issue classification.

Tags are assigned only by the keyword rules below. Every assigned tag records
the rule id, the field that matched and the matched text, so a reader can see
*why* a record carries a tag. Tags describe subject matter; they are not legal
conclusions and say nothing about the merits.
"""

from __future__ import annotations

import re
from typing import Iterable, List

from .schemas import IssueTag

# (tag, label, ruleId, pattern)
ISSUE_RULES: list[tuple[str, str, str, str]] = [
    ("voting-rights-act", "Voting Rights Act (federal)", "tag-vra-3",
     r"(?<!California )(?<!State )Voting Rights Act|52 U\.\s?S\.\s?C\.\s?§\s?1030[1-9]"),
    ("state-voting-rights-act", "State voting rights acts", "tag-svra-1", r"California Voting Rights Act|\bstate voting rights act"),
    ("redistricting", "Redistricting", "tag-redist-1", r"redistrict\w*|districting (plan|map)|congressional (map|district)|gerrymander\w*|legislative districts?|reapportion\w*"),
    ("racial-gerrymandering", "Racial gerrymandering claims", "tag-racial-2", r"racial(ly)? gerrymander\w*|race predominated"),
    ("partisan-gerrymandering", "Partisan gerrymandering claims", "tag-partisan-1", r"partisan(-| )gerrymander\w*"),
    ("mail-voting", "Mail and absentee voting", "tag-mail-2",
     r"vot(e|ing)(-| )by(-| )mail|mail(-in)? ballots?|absentee ballots?|ballots? (to be )?received .{0,40}after|early ballot|all-mailed ballot"),
    ("registration", "Voter registration", "tag-reg-1", r"voter registration|registration record|register(ed)? to vote|proof of citizenship|National Voter Registration Act|voter rolls?"),
    ("voter-id", "Voter identification", "tag-id-2", r"voter (identification|ID)\b(?! envelopes?)|photo identification"),
    ("ballot-access", "Ballot access and candidate qualification", "tag-ballot-2",
     r"primary ballot|ballot access|excluded? from the .{0,40}ballot|nomination (papers|documents)|qualifications for office|ballot designation|elective office: |(eligib\w+ (for|to hold)|disqualif\w+ from( holding)?) .{0,30}(elective|public) office"),
    ("election-administration", "Election administration", "tag-admin-2",
     r"out-of-\s?precinct|polling places?|vote centers?|ballot-collection|provisional ballots?|precinct (maps?|boards?)|official canvass|poll workers?"
     r"|signature (verification|comparison)|language (assistance|accessibility)|ballots?:? (processing|counting|curing|drop ?box(es)?)|voter information guides?"
     r"|election materials|elections cybersecurity|conduct of (the |an )?elections?"),
    ("certification", "Canvass, results and certification", "tag-cert-2",
     r"certif(y|ication|ied) .{0,30}(election|results|vote)|official canvass|results of (the|an|any) election|statement of (the )?vote|tie votes?"),
    ("voting-technology", "Voting technology", "tag-tech-1", r"voting (system|machine|technology)s?|ballot marking device|remote accessible vote by mail system"),
    ("elections-clause", "Elections Clause and federal election timing", "tag-clause-1", r"Elections? (and Electors )?Clauses?|Manner of holding Elections|election-day statutes|federal Election Day"),
    ("direct-democracy", "Initiatives, referenda and recalls", "tag-direct-3",
     r"\brecall (elections?|petitions?)|\brecalls? of .{0,40}?offic(ers?|ials?)\b"
     r"|\b(statewide|local|voter|ballot|citizens?) initiatives?\b|(?<!for or against any )\binitiatives? (and|or) referend(um|a)\b"
     r"|(?<!1974, an )\binitiative (measures?|petitions?|statutes?|constitutional amendments?)\b|(^|: )initiatives?\b"
     r"|\breferend(um|a)\b|ballot measures?|local (tax |bond )?measures?|title and summary"),
    ("campaign-finance", "Campaign finance and political advertising", "tag-cf-1", r"Political Reform Act|campaign (finance|financing|contributions?|mass mailing)|contributions? in|deceptive (media|audio)|advertisements?"),
]
_COMPILED = [(tag, label, rid, re.compile(pattern, re.I | re.M)) for tag, label, rid, pattern in ISSUE_RULES]
TAG_LABELS = {tag: label for tag, label, _, _ in ISSUE_RULES}

#: A match inside a phrase of a rule's exclusion pattern does not count for that rule. Campaign-finance law names
#: ballot measures only as something a committee or a payment supports or opposes ("committees that support candidates
#: and ballot measures", "any committee for or against any initiative or referendum measure"); that says nothing about
#: initiatives, referenda or recalls. Nor does the sentence with which a digest says that an act the bill amends was
#: itself adopted by initiative ("The Voters FIRST Act, an initiative measure approved by the electors as Proposition 11",
#: "The act is an initiative measure that authorizes the Legislature to amend its provisions").
ISSUE_EXCLUSIONS: dict[str, str] = {
    "direct-democracy":
        r"\bballot measure committees?\b"
        r"|\bcommittees? for or against (a|an|any|the) (initiative or referendum|state or local ballot|ballot) measures?\b"
        r"|\b(support(s|ed|ing)?|oppos(e|es|ed|ing)|support of|opposition to)\b[^.;:]{0,60}?\b(candidates?|offices?)\b[^.;:]{0,40}?\bballot measures?\b"
        r"|\b(support(s|ed|ing)?|oppos(e|es|ed|ing)|support of|opposition to)\b[^.;:]{0,60}?\bballot measures?\b[^.;:]{0,60}?\b(candidates?|offices?)\b"
        r"|\ban initiative measure (that authorizes the Legislature to amend|approved by the (electors|voters))\b",
}
_EXCLUDED = {tag: re.compile(pattern, re.I | re.M) for tag, pattern in ISSUE_EXCLUSIONS.items()}
#: Field mode for a California digest. For the tags listed here, only the digest's sentences that say what the bill
#: would do are read: a state bill's digest names the federal Voting Rights Act when it describes existing law, which
#: does not make the federal act the bill's subject.
DIGEST = "digest"
PROPOSAL_ONLY_IN_DIGEST = {"voting-rights-act"}
_WOULD_RE = re.compile(r"\bwould\b", re.I)

#: A word broken at the end of a line of a typeset PDF ("gerryman-" / "dered", "race predomi-" / "nated").
_LINE_HYPHEN_RE = re.compile(r"([A-Za-z]+) ?-[ \t]*\n[ \t]*([a-z][A-Za-z]*)")
_HYPHENATED_RE = re.compile(r"[A-Za-z]+(?:-[A-Za-z]+)+")
#: Words that begin hyphenated compounds in these documents ("well-known", "case-specific", "three-judge") and are not
#: a syllable that a typesetter splits off a longer word. A line-end hyphen after one of them is kept.
_COMPOUND_HEADS = frozenset({"well", "self", "case", "party", "two", "three", "half", "vote", "voter", "race"})


def join_line_hyphens(text: str) -> str:
    """``text`` with the words a PDF broke across lines put back together, for the keyword rules only.

    Opinions are typeset with hyphenation, so "racially gerryman-" at the end of one line and "dered" at the start of
    the next would escape every rule. A hyphen at the end of a line followed by a lower-case continuation is removed
    with the line break. Where the document writes the same pair with a hyphen elsewhere on one line ("out-of-precinct"),
    or the first part is a word that begins compounds ("well-" / "known"), the hyphen is kept, since it is part of the
    word. Quoted passages are still checked against the text as extracted.
    """
    pairs = set()
    for word in _HYPHENATED_RE.findall(text):
        parts = word.lower().split("-")
        pairs.update(zip(parts, parts[1:]))

    def join(match: re.Match) -> str:
        left, right = match.group(1), match.group(2)
        keep = (left.lower(), right.lower()) in pairs or left.lower() in _COMPOUND_HEADS
        return f"{left}-{right}" if keep else f"{left}{right}"

    return _LINE_HYPHEN_RE.sub(join, text)

#: Rule id recorded on a tag a maintainer added by hand, with a passage that supports it.
CURATED_RULE_ID = "tag-curated-1"

#: In a long document a rule must match at least this many times ...
LONG_TEXT_MIN_MATCHES = 5
#: ... and at least this share of the count of the most frequently matching rule.
LONG_TEXT_SHARE = 0.15
#: Sentences of a California digest that say who pays for a new duty. They name
#: "elections officials" in almost every election bill and say nothing about its subject.
_MANDATE_RE = re.compile(r"state-mandated local program|reimburse local agencies|Commission on State Mandates|no reimbursement is required", re.I)
_SENTENCE_RE = re.compile(r"(?<=[.;])\s+(?=[A-Z(])")


def without_mandate_text(digest: str) -> str:
    """A digest without its state-mandate (fiscal boilerplate) sentences.

    Only the sentence that contains the boilerplate is dropped. A paragraph often
    describes what the bill does and then ends with "By imposing new duties on
    local elections officials, the bill would create a state-mandated local program."
    """
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n", digest or ""):
        kept = [sentence for sentence in _SENTENCE_RE.split(paragraph) if not _MANDATE_RE.search(sentence)]
        if kept:
            paragraphs.append(" ".join(kept))
    return "\n\n".join(paragraphs)


def _running_text(text: str, match: re.Match) -> bool:
    """False for a hit inside a table of contents or authorities, or inside a web address."""
    context = text[max(0, match.start() - 80):match.end() + 80]
    return re.search(r"\.{4,}|(\. ){4,}|https?://", context) is None


def _sentence_spans(text: str) -> List[tuple[int, int]]:
    starts = [0] + [m.end() for m in _SENTENCE_RE.finditer(text)]
    return list(zip(starts, starts[1:] + [len(text)]))


def _counted(tag: str, pattern: re.Pattern, text: str, mode: str | None) -> List[re.Match]:
    """The matches of one rule in one field that count: not inside an excluded phrase and, in a digest, in a sentence
    the rule reads."""
    found = list(pattern.finditer(text))
    excluded = _EXCLUDED.get(tag)
    if excluded and found:
        spans = [(m.start(), m.end()) for m in excluded.finditer(text)]
        found = [m for m in found if not any(start < m.end() and m.start() < end for start, end in spans)]
    if mode == DIGEST and tag in PROPOSAL_ONLY_IN_DIGEST and found:
        read = [(start, end) for start, end in _sentence_spans(text) if _WOULD_RE.search(text, start, end)]
        found = [m for m in found if any(start <= m.start() < end for start, end in read)]
    return found


def classify(fields: Iterable[tuple]) -> List[IssueTag]:
    """Apply the rules to ``(fieldName, text)`` or ``(fieldName, text, mode)`` entries.

    The first field that satisfies a rule wins for that tag.

    * No mode: a short, authoritative field (a caption, the questions presented,
      a bill's subject line). One match assigns the tag.
    * ``"digest"``: a California Legislative Counsel's digest. One match assigns
      the tag, but for the rules in ``PROPOSAL_ONLY_IN_DIGEST`` only the sentences
      that say what the bill would do are read.
    * ``"long"``: a whole filing or opinion. A rule must be prominent: at least
      ``LONG_TEXT_MIN_MATCHES`` matches and at least ``LONG_TEXT_SHARE`` of the
      count of the rule that matches most often. The text shown with the tag is
      the first match in running text, not one in a table of authorities.

    In every mode a match inside a phrase of the rule's exclusion pattern (``ISSUE_EXCLUSIONS``) does not count.
    """
    tags: List[IssueTag] = []
    seen: set[str] = set()
    materialised = [(entry[0], entry[1], entry[2] if len(entry) > 2 else None) for entry in fields if entry[1]]
    counts: dict[int, dict[str, list]] = {}
    for position, (_name, text, mode) in enumerate(materialised):
        if mode == "long":
            counts[position] = {tag: _counted(tag, pattern, text, mode) for tag, _l, _r, pattern in _COMPILED}
    for tag, _label, rule_id, pattern in _COMPILED:
        for position, (name, text, mode) in enumerate(materialised):
            if tag in seen:
                break
            if mode == "long":
                matches = counts[position][tag]
                top = max(len(found) for found in counts[position].values())
                if len(matches) < LONG_TEXT_MIN_MATCHES or len(matches) < LONG_TEXT_SHARE * top:
                    continue
            else:
                matches = _counted(tag, pattern, text, mode)[:1]
            if not matches:
                continue
            match = next((m for m in matches if _running_text(text, m)), matches[0]) if mode == "long" else matches[0]
            start, end = max(0, match.start() - 40), min(len(text), match.end() + 40)
            # Widen to whole words (by at most 30 characters) so that an excerpt never starts or ends mid-word.
            for _ in range(30):
                if start == 0 or text[start - 1].isspace():
                    break
                start -= 1
            for _ in range(30):
                if end == len(text) or text[end].isspace():
                    break
                end += 1
            snippet = re.sub(r"\s+", " ", text[start:end]).strip()
            tags.append(IssueTag(tag=tag, ruleId=rule_id, matchedField=name, matchedText=snippet,
                                 matchCount=len(matches) if mode == "long" else None))
            seen.add(tag)
    return tags


def curated_tag(tag: str, document: str, passage: str) -> IssueTag:
    """A tag a maintainer added by hand. ``passage`` must already have been found in ``document``."""
    if tag not in TAG_LABELS:
        raise ValueError(f"unknown tag {tag!r}")
    return IssueTag(tag=tag, ruleId=CURATED_RULE_ID, matchedField=document, matchedText=passage, matchCount=None)


def rules_document() -> dict:
    """Published as ``data/classification.json`` for the methodology page."""
    return {
        "issueRules": [{"tag": t, "label": l, "ruleId": r, "pattern": p, **({"exclusionPattern": ISSUE_EXCLUSIONS[t]} if t in ISSUE_EXCLUSIONS else {})}
                       for t, l, r, p in ISSUE_RULES],
        "curatedRuleId": CURATED_RULE_ID,
        "note": "Tags are produced by case-insensitive keyword rules applied to the stated field. "
                "In a caption, the questions presented or a bill's subject line and title, one match assigns the tag. "
                "In a bill's digest one match assigns the tag too, but the sentences about state-mandated local costs are not read, "
                "because they name elections officials in almost every election bill. "
                f"For the {TAG_LABELS['voting-rights-act']} rule only the digest's sentences that contain the word 'would', which "
                "say what the bill would do, are read, because a digest also names the federal act when it describes existing law. "
                f"For the {TAG_LABELS['direct-democracy']} rule a match does not count inside a campaign-finance phrase, where a "
                "committee or a payment supports or opposes a candidate or a ballot measure, or inside the words with which a digest says "
                "that an act the bill amends was itself adopted by initiative; the phrases are those of this pattern: "
                + ISSUE_EXCLUSIONS["direct-democracy"] + " . "
                "In text taken from a PDF (questions presented, filings and opinions), a word that the document breaks across two "
                "lines with a hyphen is joined again before the rules are applied; the hyphen is kept where the document also writes "
                "the word with one, or the first part is one of these words, which begin compounds: "
                + ", ".join(f"'{w}'" for w in sorted(_COMPOUND_HEADS)) + ". "
                "Where a docket has no questions presented, the full text of its initiating filing or opinion is read instead, "
                f"and a rule must be prominent there: at least {LONG_TEXT_MIN_MATCHES} matches, and at least "
                f"{round(LONG_TEXT_SHARE * 100)}% as many as the rule that matches most often in that document. "
                f"A tag with rule id {CURATED_RULE_ID} was added by a maintainer where the rules miss the central subject of a case; "
                "it is shown with the passage it rests on, which is checked against the cited document on every run. "
                "Tags indicate subject matter only. They are not legal conclusions and can be wrong or incomplete.",
    }
