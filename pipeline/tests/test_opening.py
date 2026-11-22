"""Rule ``about-opinion-1``: the opening passage of an opinion, read from the layout of its PDF.

The layouts are synthetic and written in the form of poppler's ``pdftohtml -xml``: every piece of text with its place
on the page and its type size. No court's document is used.
"""
from __future__ import annotations

from typing import List, Optional, Sequence
from xml.sax.saxutils import escape

import pytest

from dhq import opening

#: Type sizes by font id: the body, footnotes and footnote marks, the stamp of the court's filing system.
FONTS = {0: 16, 1: 10, 2: 12}
HEIGHTS = {0: 18, 1: 11, 2: 14}
MARGIN, INDENT, EDGE = 100, 130, 600


def piece(top: int, left: int, text: str, *, right: Optional[int] = None, font: int = 0) -> str:
    width = (right - left) if right is not None else len(text) * 7
    return f'<text top="{top}" left="{left}" width="{width}" height="{HEIGHTS[font]}" font="{font}">{escape(text)}</text>'


def layout(*pages: Sequence[str]) -> str:
    out = []
    for number, pieces in enumerate(pages, start=1):
        fonts = "".join(f'<fontspec id="{i}" size="{size}" family="Times" color="#000000"/>\n' for i, size in FONTS.items()) if number == 1 else ""
        out.append(f'<page number="{number}" position="absolute" top="0" left="0" height="1188" width="918">\n{fonts}' + "\n".join(pieces) + "\n</page>")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<pdf2xml>\n' + "\n".join(out) + "\n</pdf2xml>\n"


def paragraph(top: int, lines: Sequence[str], *, indent: bool = True, pitch: int = 22) -> List[str]:
    """A justified paragraph: every line runs to the right edge but the last, and the first is set in."""
    out = []
    for index, text in enumerate(lines):
        left = INDENT if indent and index == 0 else MARGIN
        last = index == len(lines) - 1
        out.append(piece(top + index * pitch, left, text, right=None if last else EDGE))
    return out


def stamp(page: int) -> str:
    return piece(20, 180, f"Case: 25-1 Document: 14 Page: {page} Date Filed: 01/02/2026", font=2)


CAPTION = [
    piece(100, 300, "UNITED STATES COURT OF APPEALS"), piece(122, 330, "FOR THE FIFTH CIRCUIT"),
    piece(180, 240, "SYNTHETIC VOTERS LEAGUE, Plaintiff-Appellant,"), piece(202, 430, "v."),
    piece(224, 260, "SYNTHETIC COUNTY, Defendant-Appellee."),
]
PANEL = piece(300, MARGIN, "Before ALPHA, BETA, and GAMMA, Circuit Judges.")
AUTHOR = piece(330, MARGIN, "ALPHA, Circuit Judge:")
OPENING = ("The Synthetic Voters League appeals the district court's dismissal of its challenge to the county's rule on late "
           "absentee ballots. We hold that the League has standing and reverse the judgment of the district court.")
BACKGROUND = ["The county adopted the rule in 2024 after a dispute over ballots that", "reached the clerk a day late, and the League sued the next year."]


def test_the_passage_is_the_first_paragraph_after_the_author_without_heads_footnotes_and_their_marks():
    page = [
        stamp(1), *CAPTION, PANEL, AUTHOR,
        piece(360, INDENT, "The Synthetic Voters League appeals the district court's dismissal of", right=EDGE),
        # The second line is set in three pieces: the footnote mark stands between two sentences, raised and small.
        piece(382, MARGIN, "its challenge to the county's rule on late absentee ballots.", right=520),
        piece(380, 521, "1", font=1),
        piece(382, 530, " We hold", right=EDGE),
        piece(404, MARGIN, "that the League has standing and reverse the judgment of the district"),
        piece(426, MARGIN, "court."),
        piece(470, 300, "I. BACKGROUND"),
        *paragraph(500, BACKGROUND),
        piece(900, MARGIN, "1", font=1), piece(900, 112, "The rule is printed in the county's election manual of 2024.", font=1),
        piece(950, 440, "1"),
    ]
    found = opening.opening_passage(layout(page))
    assert found == opening.Opening(text=OPENING, cut=False, page=1, paragraph=1)


def test_a_paragraph_that_crosses_a_page_is_followed_past_the_running_head():
    first = [stamp(1), *CAPTION, PANEL, AUTHOR,
             *paragraph(860, ["The Synthetic Voters League appeals the district court's dismissal of", "its challenge to the county's rule on late absentee"]),
             piece(950, 440, "1")]
    first[-2] = piece(882, MARGIN, "its challenge to the county's rule on late absentee", right=EDGE)  # the page ends inside the sentence
    second = [stamp(2),
              *paragraph(100, ["ballots. We hold that the League has standing and reverse the judgment", "of the district court."], indent=False),
              piece(170, 300, "I. BACKGROUND"), *paragraph(200, BACKGROUND), piece(950, 440, "2")]
    assert opening.opening_passage(layout(first, second)).text == OPENING


ESSAY = ["Elections are the instrument by which a free people governs itself, and", "every generation has had to defend that instrument anew."]
ASKS = ["This appeal asks whether a county may reject an absentee ballot that was", "mailed before election day and reached the clerk one day after it."]


def test_the_first_paragraph_is_quoted_even_where_a_later_one_says_more_about_the_case():
    # "Opening of the opinion" is the label a reader sees: the passage is the opinion's first paragraph, whatever it says.
    page = [stamp(1), *CAPTION, PANEL, AUTHOR, *paragraph(360, ESSAY), *paragraph(420, ASKS),
            piece(480, 300, "I. BACKGROUND"), *paragraph(510, BACKGROUND)]
    found = opening.opening_passage(layout(page))
    assert found.paragraph == 1 and found.text.startswith("Elections are the instrument") and found.text.endswith("anew.")


def test_where_the_first_paragraph_cannot_be_quoted_the_next_one_is_and_says_which_it_is():
    # A citation fills the first paragraph: too few of its characters are letters for it to pass as a sentence of prose.
    cites = ["See 52 U.S.C. 10301; 52 U.S.C. 10302; 52 U.S.C. 10303(f)(4); 599 U.S. 1, 17-19", "(2023); 594 U.S. 647, 656-66 (2021); 478 U.S. 30, 44-51, 79 (1986)."]
    page = [stamp(1), *CAPTION, PANEL, AUTHOR, *paragraph(360, cites), *paragraph(420, ASKS),
            piece(480, 300, "I. BACKGROUND"), *paragraph(510, BACKGROUND)]
    found = opening.opening_passage(layout(page))
    assert found.paragraph == 2
    assert found.text == ("This appeal asks whether a county may reject an absentee ballot that was mailed before election day and "
                          "reached the clerk one day after it.")


def test_a_passage_with_the_signs_of_a_wrongly_mapped_typeface_is_not_quoted():
    # Some files give other signs for the joined letters "ff" and "ffi". Both readings of the file agree on them, so
    # only the signs themselves show that the passage is not what the court wrote.
    broken = ["The county clerk o\u0134ered each voter a second ballot, and the o\u011ccial count", "of the election was certified two days later by the board."]
    page = [stamp(1), *CAPTION, PANEL, AUTHOR, *paragraph(360, broken), *paragraph(420, ASKS)]
    found = opening.opening_passage(layout(page))
    assert found.paragraph == 2 and found.text.startswith("This appeal asks")
    assert opening.legible("Pe\u00f1a v. Mu\u00f1oz \u2014 \u00a7 2 of the \u201cAct\u201d") and not opening.legible("o\u0134ered")


def test_a_passage_the_court_sets_in_from_the_margin_ends_the_paragraph_and_is_not_quoted():
    # The set-in lines outnumber the lines at the margin, as on a page that a quoted clause fills.
    inner = 150
    page = [stamp(1), *CAPTION, PANEL, AUTHOR,
            piece(360, INDENT, "Two clauses of the Constitution give the state legislatures power over", right=EDGE),
            piece(382, MARGIN, "federal elections. The Elections Clause gives them the first word on the", right=EDGE),
            piece(404, MARGIN, "rules for elections to Congress:"),
            piece(440, inner, "The Times, Places and Manner of holding Elections for Senators and", right=560),
            piece(458, inner, "Representatives, shall be prescribed in each State by the Legislature", right=560),
            piece(476, inner, "thereof; but the Congress may at any time by Law make or alter such", right=560),
            piece(494, inner, "Regulations, except as to the Places of chusing Senators, and no other", right=560),
            piece(512, inner, "body of a State may prescribe them in the place of its Legislature."),
            piece(548, MARGIN, "U.S. Const. art. I, sec. 4, cl. 1. The Electors Clause does the same for the", right=EDGE),
            piece(570, MARGIN, "appointment of the electors of the President."),
            *paragraph(606, ["Twenty-seven members of the legislature sued the Governor over an order", "that registers voters at state offices without an act of the legislature."])]
    paragraphs = [" ".join(line.text for line in lines) for lines in opening.opening_paragraphs(opening.body_pages(layout(page)))]
    assert [text[:22] for text in paragraphs] == ["Two clauses of the Con", "Twenty-seven members o"]
    assert paragraphs[0].endswith("rules for elections to Congress:")
    found = opening.opening_passage(layout(page))
    # The paragraph is quoted as far as its whole sentences go; the clause and the rest of the paragraph are left out.
    assert found == opening.Opening(text="Two clauses of the Constitution give the state legislatures power over federal elections.",
                                    cut=False, page=1, paragraph=1)


def test_a_page_with_two_lines_of_the_court_above_a_long_set_in_passage_takes_the_margin_of_the_next_page():
    inner = 150
    clause = [piece(430 + 18 * index, inner, f"Line {index + 1} of a long clause of the statute that the court sets out in full here", right=560)
              for index in range(9)]
    first = [stamp(1), *CAPTION, PANEL, AUTHOR,
             piece(360, INDENT, "The League challenges the statute that governs the count of late ballots,", right=EDGE),
             piece(382, MARGIN, "and the whole dispute turns on the words of its second section, which reads:"),
             *clause]
    second = [stamp(2), *paragraph(100, [f"The district court read line {index + 1} of the clause as the county had asked it to." for index in range(9)] + ["It then dismissed."])]
    # One long line at the margin is too few to count on its own page: the margin is known from the next page.
    paragraphs = [" ".join(line.text for line in lines) for lines in opening.opening_paragraphs(opening.body_pages(layout(first, second)))]
    assert paragraphs[0].endswith("of its second section, which reads:")
    assert paragraphs[1].startswith("The district court read line 1") and not any("of a long clause" in text for text in paragraphs)
    assert opening.opening_passage(layout(first, second)).text.startswith("The district court read line 1")


def test_an_order_without_an_author_begins_under_its_heading_and_its_formula_is_passed_over():
    page = [stamp(1), *CAPTION, PANEL, piece(330, 380, "ORDER"),
            *paragraph(360, ["This appeal was considered on the record from the United States District", "Court for the Western District of Texas and on the briefs of the parties."]),
            *paragraph(420, ["Synthetic Smith appeals the district court's order dismissing his complaint", "against the county board of elections for failure to state a claim."]),
            *paragraph(480, ["We affirm for the reasons the district court gave in its order of last May."])]
    found = opening.opening_passage(layout(page))
    assert found.text == "Synthetic Smith appeals the district court's order dismissing his complaint against the county board of elections for failure to state a claim."
    assert found.paragraph == 1  # the words every order begins with are not counted as a paragraph of the opinion


def test_a_document_that_names_neither_panel_nor_author_has_no_passage():
    page = [stamp(1), *CAPTION, piece(300, 380, "ORDER"),
            *paragraph(330, ["The appeal is dismissed on the stipulation of the parties under Rule 42(b)", "of the Federal Rules of Appellate Procedure, each side to bear its costs."])]
    assert opening.opening_passage(layout(page)) is None
    assert opening.opening_passage(layout([])) is None and opening.opening_passage("") is None


def test_a_signature_at_the_foot_of_an_order_is_not_taken_for_the_author():
    page = [stamp(1), *CAPTION, PANEL,
            *paragraph(330, ["Synthetic Smith appeals the district court's order dismissing his complaint", "against the county board of elections for failure to state a claim."]),
            piece(420, 400, "Entered for the Court"), piece(442, 400, "Per Curiam")]
    assert opening.opening_passage(layout(page)).text.startswith("Synthetic Smith appeals")


def test_lines_set_at_uneven_distances_stay_one_paragraph():
    # Some courts' files set the lines of one paragraph 18, 27 and 22 units apart. Only the usual distance of the page
    # says what a wider gap is; the first gap of the paragraph does not.
    page = [stamp(1), *CAPTION, PANEL, AUTHOR,
            piece(740, INDENT, "This appeal asks us to make one such hard judgment. We must decide", right=EDGE),
            piece(758, MARGIN, "whether the requirement that mail-in ballots which arrive in undated", right=EDGE),
            piece(785, MARGIN, "return envelopes be discarded complies with the Constitution, as the", right=EDGE),
            piece(807, MARGIN, "district court held it does not.")]
    found = opening.opening_passage(layout(page))
    assert found.text == ("This appeal asks us to make one such hard judgment. We must decide whether the requirement that mail-in ballots "
                          "which arrive in undated return envelopes be discarded complies with the Constitution, as the district court "
                          "held it does not.")


def test_a_run_of_white_space_alone_still_parts_two_sentences():
    page = [stamp(1), *CAPTION, PANEL, AUTHOR,
            piece(360, INDENT, "In this redistricting dispute the plaintiffs moved to compel discovery", right=EDGE),
            piece(382, MARGIN, "from legislators who are not parties, among others.", right=460),
            piece(382, 460, " ", right=463),
            piece(382, 463, "The district court", right=EDGE),
            piece(404, MARGIN, "largely denied the motions, so the plaintiffs appealed.")]
    assert "among others. The district court largely denied" in opening.opening_passage(layout(page)).text


def test_a_word_broken_at_the_end_of_a_line_is_joined_as_the_opinion_writes_it_elsewhere():
    page = [stamp(1), *CAPTION, PANEL, AUTHOR,
            piece(360, INDENT, "The League appeals the dismissal of its challenge to the gerryman-", right=EDGE),
            piece(382, MARGIN, "dered districts and to the county's campaign-", right=EDGE),
            piece(404, MARGIN, "finance rules, which the district court upheld.")]
    text = "The plan was gerrymandered. The campaign-finance rules were adopted in 2024."
    assert opening.opening_passage(layout(page), text) is None  # the plain text does not hold the passage at all
    found = opening.opening_passage(layout(page), "The League appeals the dismissal of its challenge to the gerrymandered districts and to the "
                                                  "county's campaign-finance rules, which the district court upheld. " + text)
    assert found.text == ("The League appeals the dismissal of its challenge to the gerrymandered districts and to the county's "
                          "campaign-finance rules, which the district court upheld.")


def test_a_passage_is_published_only_if_every_letter_of_it_stands_in_the_plain_text():
    whole = "ALPHA, Circuit Judge:\n" + OPENING.replace("ballots. We", "ballots.1 We").replace("the judgment", "the judg-\nment")
    assert opening.confirmed(OPENING, whole, [])                                 # a footnote mark and a line-end hyphen are not letters
    assert not opening.confirmed(OPENING.replace("reverse", "affirm"), whole, [])  # a word the document does not have there
    assert not opening.confirmed(OPENING, "", [])
    # A word the layout reading dropped: every other letter is in the document in order, and the passage is still refused.
    assert not opening.confirmed(OPENING.replace("has standing and ", ""), whole, [])
    assert not opening.confirmed(OPENING.replace("has standing and ", ""), whole)


def test_other_matter_may_stand_inside_a_passage_only_where_it_crosses_a_page():
    plain = ("ALPHA, Circuit Judge:\nThe Synthetic Voters League appeals the district court's dismissal of its challenge to the county's rule on "
             "late absentee ballots.1 We hold that the\n1 The rule is printed in the county's election manual of 2024.\nCase: 25-1 Document: 14 Page: 2 Date Filed: 01/02/2026\n"
             "League has standing and reverse the judg-\nment of the district court.")
    at = len(opening._letters(OPENING[:OPENING.index("League has standing")]))
    assert opening.confirmed(OPENING, plain, [at])       # the footnote and the page head lie at the page break
    assert not opening.confirmed(OPENING, plain, [])     # no page break: the passage would have to stand there whole
    assert not opening.confirmed(OPENING, plain, [at - 9])  # a break elsewhere does not excuse the gap
    assert opening.confirmed(OPENING, plain)             # pages not known (a passage published before): the head of a page lies between
    scattered = " x ".join(OPENING[i:i + 30] for i in range(0, len(OPENING), 30))
    assert not opening.confirmed(OPENING, scattered) and not opening.confirmed(OPENING, scattered, [at])
    # The matter between two pages is a page's footnotes at most: a passage whose halves lie a document apart is refused.
    apart = plain.replace("Date Filed: 01/02/2026", "Date Filed: 01/02/2026\n" + "x" * (opening.PAGE_GAP_LETTERS + 1))
    assert not opening.confirmed(OPENING, apart, [at]) and not opening.confirmed(OPENING, apart)
    # Pages not known: words a court added inside the passage are not the head of a page, and the passage is refused.
    amended = ("ALPHA, Circuit Judge:\n" + OPENING).replace("the League has standing", "the League, on this record and for these claims, has standing")
    assert not opening.confirmed(OPENING, amended)


def test_the_page_breaks_of_a_paragraph_are_counted_in_letters():
    def line(page: int, text: str) -> opening.Line:
        return opening.Line(page=page, top=0, bottom=18, text=text)

    assert opening.page_breaks([line(1, "The League ap-"), line(1, "peals. It"), line(2, "has standing.")]) == [len("TheLeagueappealsIt")]
    assert opening.page_breaks([line(1, "One line.")]) == []


def test_a_passage_the_plain_text_does_not_hold_is_not_published():
    page = [stamp(1), *CAPTION, PANEL, AUTHOR,
            *paragraph(360, ["The Synthetic Voters League appeals the district court's dismissal of", "its challenge to the county's rule on late absentee ballots."])]
    assert opening.opening_passage(layout(page)).text.startswith("The Synthetic Voters League appeals")
    assert opening.opening_passage(layout(page), "The text of some other document, which says nothing of the kind.") is None


def test_the_usual_line_distance_is_the_median_of_the_page_and_a_short_page_takes_that_of_the_document():
    def lines(page: int, tops: Sequence[int]) -> List[opening.Line]:
        return [opening.Line(page=page, top=top, bottom=top + 18, text="x") for top in tops]

    pitches = opening.pitches_of(lines(1, [100, 122, 144, 166, 188, 240, 262, 284]) + lines(2, [100, 130]))
    assert pitches == {1: 22.0, 2: 22.0}


def test_bytes_that_are_not_a_pdf_are_refused():
    with pytest.raises(opening.LayoutError, match="not a PDF"):
        opening.pdf_layout(b"<html><body>Service unavailable</body></html>")
