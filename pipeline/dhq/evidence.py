"""Checking that a quoted passage really is in the document it cites.

A link between two records is written by a maintainer. What the pipeline can
check by machine is narrow, and this module is all of it:

* :func:`find_passage` - the quoted passage is in the cited document;
* :func:`names_place` - a passage that ties a court case to a place names that place.

Neither check reads the passage for meaning. A passage that is found proves
that the document says those words. It does not prove the maintainer's
description of the link, which is shown to readers as the maintainer's.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Mapping, Optional

#: Marks words left out between two parts of one quotation.
ELLIPSIS = "[…]"
#: A quoted part shorter than this (counted without spaces) is too easy to find by chance.
MIN_PART_LENGTH = 25

#: What :func:`comparable` ignores, in words, for notes and rule descriptions shown to readers.
IGNORED_IN_WORDS = ("ignoring white space, hyphens and dashes, letter case and the style of quotation marks, "
                    "and reading Unicode compatibility characters (such as ligatures and superscript digits) as their plain forms")

_QUOTE_MARKS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "′": "'"})
_IGNORED = re.compile(r"[\s­\-‐‑‒–—―]+")


def comparable(text: str) -> str:
    """``text`` reduced to what must agree between a quotation and its source.

    Text taken out of a PDF breaks lines in the middle of sentences and words
    ("con- gressional") and loses or gains spaces around symbols ("violated§ 2").
    So white space, hyphens and dashes are ignored, letter case is ignored,
    typographic quotation marks count as plain ones and Unicode compatibility
    characters are read as their plain forms (NFKC: a ligature as its letters,
    a superscript digit as the digit). Every letter, digit and other mark must
    still agree, in order.
    """
    text = unicodedata.normalize("NFKC", text).translate(_QUOTE_MARKS)
    return _IGNORED.sub("", text).casefold()


def find_passage(quote: Optional[str], document: Optional[str]) -> Optional[str]:
    """``None`` when every part of ``quote`` is in ``document`` in order, else the reason it is not."""
    if not quote or not quote.strip():
        return "no passage is recorded"
    if not document:
        return "the cited document has no text"
    haystack = comparable(document)
    position = 0
    for part in quote.split(ELLIPSIS):
        needle = comparable(part)
        if len(needle) < MIN_PART_LENGTH:
            return f"a quoted part is shorter than {MIN_PART_LENGTH} characters: {part.strip()!r}"
        found = haystack.find(needle, position)
        if found < 0:
            return f"not found in the cited document: {part.strip()[:120]!r}"
        position = found + len(needle)
    return None


def names_place(quote: str, key: str, state_names: Mapping[str, str], unit_names: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """``None`` when ``quote`` names the place ``key``, else what it should have named.

    * ``state:SS`` - the state's name.
    * ``county:SSCCC`` - the county's name ("Galveston County"), when the geography index is at hand.
    * ``cd119:SSDD`` / ``cd120:SSDD`` - the district's number after "District" or "CD".

    A court's location or a party's name can satisfy this check, which is why it
    is only a guard against a passage about the wrong place, not a proof.
    """
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", quote).translate(_QUOTE_MARKS)).casefold()
    layer, _, code = key.partition(":")
    if layer == "state":
        name = state_names.get(code)
        if name and name.casefold() not in text:
            return name
    elif layer == "county":
        full = (unit_names or {}).get(key)
        name = full.split(",")[0] if full else None
        if name and name.casefold() not in text:
            return name
    elif layer in ("cd119", "cd120") and code[2:].isdigit():
        number = int(code[2:])
        if number and not re.search(rf"\b(district|cd)\s?0?{number}\b", text):
            return f"District {number}"
    return None
