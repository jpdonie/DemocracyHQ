"""The two machine checks on a curated link: the passage is in the document, and it names the place.

SYNTHETIC TEST DATA: the documents and passages below are invented.
"""

from dhq import evidence

STATES = {"06": "California", "48": "Texas"}
UNITS = {"county:06001": "Alameda County, California"}

DOCUMENT = """QUESTIONS PRESENTED
1. Whether the State's con-
gressional districting plan, enacted as “Synthetic Bill 9,” violated§ 2 of the
Voting Rights Act.
2. Whether the district court erred in its remedy for District 5."""


def test_line_breaks_hyphenation_case_and_quote_style_do_not_matter():
    assert evidence.find_passage('whether the state\'s CONGRESSIONAL districting plan, enacted as "Synthetic Bill 9," violated § 2', DOCUMENT) is None


def test_every_other_character_must_agree():
    problem = evidence.find_passage("Whether the State's congressional districting plan, enacted as Synthetic Bill 8", DOCUMENT)
    assert problem and problem.startswith("not found in the cited document")


def test_parts_separated_by_an_ellipsis_must_appear_in_order():
    first, second = "Whether the State's congressional districting plan", "erred in its remedy for District 5"
    assert evidence.find_passage(f"{first} […] {second}", DOCUMENT) is None
    assert evidence.find_passage(f"{second} […] {first}", DOCUMENT) is not None


def test_a_part_too_short_to_be_meaningful_is_refused():
    problem = evidence.find_passage("Whether the State's congressional districting plan […] District 5", DOCUMENT)
    assert problem and "shorter than 25 characters" in problem


def test_a_missing_passage_or_document_is_a_failure_not_a_pass():
    assert evidence.find_passage(None, DOCUMENT) == "no passage is recorded"
    assert evidence.find_passage("   ", DOCUMENT) == "no passage is recorded"
    assert evidence.find_passage("Whether the State's congressional districting plan", "") == "the cited document has no text"


def test_a_state_link_needs_the_state_name():
    assert evidence.names_place("the State of California's congressional plan", "state:06", STATES) is None
    assert evidence.names_place("the State's congressional plan", "state:06", STATES) == "California"


def test_a_county_link_needs_the_county_name_when_the_index_is_at_hand():
    assert evidence.names_place("elections in Alameda County were", "county:06001", STATES, UNITS) is None
    assert evidence.names_place("elections in the county were", "county:06001", STATES, UNITS) == "Alameda County"


def test_a_district_link_needs_its_number_and_not_a_longer_one():
    assert evidence.names_place("the remedy for District 5", "cd119:0605", STATES) is None
    assert evidence.names_place("the remedy for CD 05", "cd120:0605", STATES) is None
    assert evidence.names_place("the remedy for District 15", "cd119:0605", STATES) == "District 5"
    assert evidence.names_place("the remedy for District 50", "cd119:0605", STATES) == "District 5"
