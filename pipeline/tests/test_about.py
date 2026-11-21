"""Rules ``about-*``: what a record is about, quoted from an official text. Synthetic texts only."""
from __future__ import annotations

import pytest

from dhq import about
from dhq.schemas import AboutText

SENTENCE = "The county counts every absentee ballot that reaches the clerk by the close of the polls on election day."  # 105 characters


def test_a_quotation_runs_in_whole_sentences_until_it_is_long_enough():
    paragraph = " ".join([SENTENCE] * 5)
    text, cut = about.quotation(paragraph)
    assert (text, cut) == (" ".join([SENTENCE] * 3), False)  # two sentences are shorter than a row should hold
    assert about.ENOUGH_CHARS <= len(text) <= about.MAX_CHARS


def test_a_sentence_that_is_long_enough_stands_alone():
    long_sentence = "The League " + "and the voters of the county " * 8 + "appeal the judgment."
    assert about.quotation(f"{long_sentence} {SENTENCE}") == (long_sentence, False)


def test_a_full_stop_after_an_abbreviation_does_not_end_a_sentence():
    paragraph = ("The League sued under 52 U.S.C. § 20501 and Fed. R. Civ. P. 65 in Synthetic League v. Synthetic County, No. 25-1, "
                 "and the district court dismissed the complaint for want of standing, as the county had asked. The League appeals.")
    assert about.sentence_ends(paragraph) == [paragraph.index(" The League appeals.")]
    assert about.sentence_ends("Smith v. Jones was decided by the D.C. Circuit. It is binding here.") == [47]


def test_only_a_first_sentence_that_no_row_can_hold_is_cut_and_it_is_cut_at_a_word():
    endless = "Whether " + "the county may reject a ballot that arrives late and " * 14 + "nothing else."
    text, cut = about.quotation(endless)
    assert cut and len(text) <= about.MAX_CHARS and endless.startswith(text + " ")
    assert not text.endswith((",", ";", ":", " "))


def test_a_text_without_the_end_of_a_sentence_is_returned_whole_for_the_caller_to_judge():
    assert about.quotation("An Act to amend the Elections Code") == ("An Act to amend the Elections Code", False)


@pytest.mark.parametrize("lines, document, joined", [
    (["the districts were gerryman-", "dered by the legislature"], "a gerrymandered map", "the districts were gerrymandered by the legislature"),
    (["the state's campaign-", "finance law"], "under campaign-finance rules", "the state's campaign-finance law"),
    (["as held in Williams-", "Yulee v. Florida Bar"], "", "as held in Williams-Yulee v. Florida Bar"),
    (["a self-", "described poll watcher"], "", "a self-described poll watcher"),
    (["the vote-", "counting machines"], "each vote was counted; the counting took a day", "the vote-counting machines"),
    (["the appel-", "lants filed late"], "the court heard the parties", "the appellants filed late"),
    (["rights of felons—", "even those released"], "", "rights of felons—even those released"),
    (["a plain line", "follows another"], "", "a plain line follows another"),
])
def test_a_word_the_page_broke_is_joined_as_the_document_writes_it(lines, document, joined):
    assert about.join_lines(lines, document) == joined


# --- measures -------------------------------------------------------------------------------------------

CRS = ("Synthetic Voter Registration Act of 2025\n\nThis bill requires each state to offer voter registration at every "
       "office that issues a driver's license, and to send each new voter a notice within ten days.\n\nThe bill also "
       "funds the offices.")
URL = "https://www.congress.gov/bill/119th-congress/house-bill/22"


def test_a_measure_of_congress_is_described_by_the_first_sentences_of_its_official_summary():
    found = about.of_bill({"stateAbbr": "US", "digest": CRS, "digestDate": "2025-01-03", "officialUrl": URL, "subject": "Synthetic Act",
                           "title": "A bill to require voter registration at licensing offices."})
    assert found == {"text": "This bill requires each state to offer voter registration at every office that issues a driver's license, "
                             "and to send each new voter a notice within ten days.",
                     "source": "crs-summary", "url": URL, "date": "2025-01-03", "cut": False, "of": None, "document": None,
                     "ruleId": "about-crs-1"}
    AboutText(**found)


def test_without_a_summary_the_official_title_is_quoted_when_the_list_shows_another_title():
    record = {"stateAbbr": "US", "digest": None, "officialUrl": URL, "subject": "Synthetic Voter Registration Act of 2025",
              "title": "A bill to require each state to offer voter registration at every office that issues a driver's license."}
    found = about.of_bill(record)
    assert (found["source"], found["ruleId"], found["text"], found["date"]) == ("official-title", "about-title-1", record["title"], None)
    # Listed under its official title already: a second line would only repeat the first.
    assert about.of_bill({**record, "subject": record["title"]}) is None
    assert about.of_bill({**record, "title": None}) is None


DIGEST = ("Existing law requires a county elections official to mail a ballot to every registered voter. Existing law requires the "
          "ballot to be returned by election day.\n\nThis bill would instead require the ballot to be counted if it is postmarked by "
          "election day and received within seven days. The bill would also require the official to notify the voter of a ballot "
          "that is rejected, and would make related findings and declarations.\n\nVote: majority.")


def test_a_california_bill_is_described_from_the_sentence_of_its_digest_that_says_what_it_would_do():
    found = about.of_bill({"stateAbbr": "CA", "digest": DIGEST, "officialUrl": "https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB1"})
    assert found["text"].startswith("This bill would instead require the ballot to be counted") and found["text"].endswith("findings and declarations.")
    assert (found["source"], found["ruleId"], found["cut"]) == ("digest", "about-digest-1", False)
    assert "Existing law" not in found["text"]


def test_a_digest_that_never_says_this_bill_would_is_quoted_from_its_beginning():
    found = about.counsel_digest("This measure memorializes the Congress to protect the right of every citizen to vote in federal elections.", url=None)
    assert found["text"].startswith("This measure memorializes")
    assert about.counsel_digest("", url=None) is None and about.counsel_digest(None, url=None) is None


# --- Supreme Court dockets ------------------------------------------------------------------------------

QP_URL = "https://www.supremecourt.gov/qp/25-00001qp.pdf"


def question(text: str) -> dict:
    return about.question_presented(text, url=QP_URL)


def test_the_question_is_what_follows_the_words_the_question_presented_is():
    text = ("25-1 SYNTHETIC LEAGUE V. SYNTHETIC COUNTY\n\nQUESTION PRESENTED:\n\nThe county rejected four hundred absentee ballots that "
            "arrived after election day.\nThe court of appeals upheld the rule.\n\nThe question presented is:\n\nWhether a county may "
            "reject an absentee ballot that was mailed before election day and arrived after it.\n\nCERT. GRANTED 1/10/2026\n")
    found = question(text)
    assert found["text"] == "Whether a county may reject an absentee ballot that was mailed before election day and arrived after it."
    assert (found["source"], found["ruleId"], found["url"], found["of"]) == ("question-presented", "about-question-1", QP_URL, None)
    AboutText(**found)


def test_the_first_of_several_numbered_questions_is_quoted_with_their_number():
    text = ("QUESTIONS PRESENTED:\n\nThe State redrew its districts in 2025.\n\nThe questions presented are:\n\n1. Whether the "
            "district court erred in finding that race predominated in the drawing of the second district.\n\n2. Whether the plan "
            "satisfies strict scrutiny.\n\n3. Whether the case is moot.\n")
    found = question(text)
    assert found["text"] == "Whether the district court erred in finding that race predominated in the drawing of the second district."
    assert found["of"] == 3


def test_a_question_asked_in_a_sentence_and_one_that_ends_with_a_question_mark_are_found():
    in_sentence = question("QUESTION PRESENTED:\n\nState law counts ballots that arrive late. The question presented is whether the "
                           "federal election-day statutes preempt a state law that counts such ballots.\n")
    assert in_sentence["text"] == "The question presented is whether the federal election-day statutes preempt a state law that counts such ballots."
    asked = question("QUESTION PRESENTED:\n\nThe State's highest court removed a candidate from the ballot.\n\nDid the court err in "
                     "ordering the candidate excluded from the primary ballot?\n")
    assert asked["text"] == "Did the court err in ordering the candidate excluded from the primary ballot?"


def test_a_page_number_glued_to_the_last_word_is_not_the_courts_word():
    found = question("QUESTION PRESENTED:\n\nWhether the State's plan violates Section 2 of the Voting Rights Act, 52 U.S.C. §10301.21\n")
    assert found["text"].endswith("52 U.S.C. §10301.")


def test_a_docket_without_a_question_is_described_by_the_entry_that_opens_it():
    record = {"questionsPresented": None, "sourceUrl": "https://www.supremecourt.gov/docket/docketfiles/html/public/25a1.html", "events": [
        {"id": "e2", "eventType": "order", "date": "2026-02-02", "description": "Application (25A1) denied by the Court."},
        {"id": "e1", "eventType": "initiating_filing", "date": "2026-01-20",
         "description": "Application (25A1) to vacate the stay entered by the court of appeals, submitted to Justice Alito."},
    ]}
    found = about.of_docket(record)
    assert found == {"text": "Application (25A1) to vacate the stay entered by the court of appeals, submitted to Justice Alito.",
                     "source": "docket-entry", "url": record["sourceUrl"], "date": "2026-01-20", "cut": False, "of": None,
                     "document": None, "ruleId": "about-docket-1"}
    assert about.of_docket({"events": [], "sourceUrl": record["sourceUrl"]}) is None


def link(quote: str, document: str = "the filing that opened this docket, written by the party seeking relief (not a ruling)") -> dict:
    return {"source": {"type": "case", "id": "scotus-25a1"}, "target": {"type": "geography", "id": "state:48"},
            "support": {"url": "https://www.supremecourt.gov/DocketPDF/25/25A1/1/application.pdf", "quote": quote, "document": document}}


def test_a_docket_without_a_question_is_described_by_the_passage_cited_for_its_first_link_to_a_place():
    record = {"questionsPresented": {"url": QP_URL, "text": None}, "sourceUrl": "https://www.supremecourt.gov/docket/docketfiles/html/public/25a1.html",
              "events": [{"id": "e1", "eventType": "initiating_filing", "date": "2026-01-20", "description": "Application (25A1) for a stay, submitted to Justice Alito."}]}
    whole = "Respondents challenged the new map of the State, contending that the legislature's motive was predominantly racial."
    found = about.of_docket(record, [link(whole), link("A second passage, cited for another place the case concerns.")])
    assert found == {"text": whole, "source": "cited-passage", "url": "https://www.supremecourt.gov/DocketPDF/25/25A1/1/application.pdf",
                     "date": None, "cut": False, "of": None, "ruleId": "about-cited-1",
                     "document": "the filing that opened this docket, written by the party seeking relief (not a ruling)"}
    AboutText(**found)
    # A passage that stops inside its sentence says so, and the reader is shown an ellipsis.
    assert about.of_docket(record, [link("preclude the State from using the congressional district boundaries enacted in 2025")])["cut"] is True
    # The Court's own question comes first where the docket has one.
    asked = {**record, "questionsPresented": {"url": QP_URL, "text": "QUESTION PRESENTED:\n\nWhether the State's plan violates Section 2 of the Voting Rights Act.\n"}}
    assert about.of_docket(asked, [link(whole)])["source"] == "question-presented"
    # Without a link the entry that opens the docket is all there is.
    assert about.of_docket(record, [])["source"] == "docket-entry"


def test_a_passage_too_short_to_say_anything_is_not_published():
    assert about.of_bill({"stateAbbr": "US", "digest": None, "subject": "Synthetic Act", "title": "A bill."}) is None
    assert about.of_docket({"events": [{"id": "e1", "eventType": "initiating_filing", "date": "2026-01-20", "description": "Filed."}]}) is None


def test_every_rule_is_published_with_its_description():
    ids = [rule["ruleId"] for rule in about.RULES]
    assert ids == ["about-crs-1", "about-title-1", "about-digest-1", "about-question-1", "about-cited-1", "about-docket-1", "about-opinion-1"]
    assert all(rule["appliesTo"] and len(rule["description"]) > 80 for rule in about.RULES)
