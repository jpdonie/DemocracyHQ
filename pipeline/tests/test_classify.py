"""Issue tags come only from published keyword rules, and each records why it was assigned."""

from dhq import classify
from dhq.classify import ISSUE_RULES, LONG_TEXT_MIN_MATCHES, classify as tag


def tags_of(fields):
    return {t.tag: t for t in tag(fields)}


def test_one_match_in_a_short_authoritative_field_assigns_the_tag():
    found = tags_of([("questions presented", "Whether the State's congressional districting plan violates Section 2.")])
    assert set(found) == {"redistricting"}
    t = found["redistricting"]
    assert t.ruleId == "tag-redist-2"
    assert t.matchedField == "questions presented"
    assert "districting plan" in t.matchedText
    assert t.matchCount is None


def test_a_seat_named_by_its_district_is_not_redistricting():
    """An election contest names the seat it is about. The words "Congressional District" there are the seat's name."""
    contest = "Dismissing the election contest relating to the office of Representative from the Fourteenth Congressional District of Florida."
    assert "redistricting" not in tags_of([("display title", contest)])
    for seat in ("Representative from the at-large Congressional District of Alaska", "the Member from the Twenty-eighth Congressional District of Texas",
                 "the Delegate for the First Congressional District", "a Member of Congress from the Second Congressional District of Louisiana"):
        assert "redistricting" not in tags_of([("display title", seat)]), seat
    # Districts as the thing a measure is about are still read, and so is a title that does both.
    for title in ("To require the congressional districts established by a State to meet certain requirements.",
                  "Whether the State's second majority-minority congressional district is a racial gerrymander.",
                  "A bill on the congressional district of each Representative.",
                  "Condemning the redistricting that changed the seat of the Representative from the Ninth Congressional District of Texas."):
        assert "redistricting" in tags_of([("official title", title)]), title


def test_another_act_whose_name_ends_in_voting_rights_act_is_not_the_federal_act():
    """The Youth Voting Rights Act (H.R. 4916 and S. 5481 of the 119th Congress) is a bill of its own, not the act of 1965."""
    for name in ("Youth Voting Rights Act", "Native American Voting Rights Act of 2021", "California Voting Rights Act of 2001"):
        assert "voting-rights-act" not in tags_of([("display title", name)]), name
    for title in ("To amend the Voting Rights Act of 1965 to revise the criteria for determining which States are subject to section 4.",
                  "Fannie Lou Hamer, Rosa Parks, and Coretta Scott King Voting Rights Act Reauthorization and Amendments Act of 2006",
                  "Youth Voting Rights Act, a bill to enforce the twenty-sixth amendment and section 2 of the Voting Rights Act of 1965."):
        assert "voting-rights-act" in tags_of([("official title", title)]), title


def test_the_name_of_a_federal_project_is_not_a_voter_initiative():
    """The Ninth Circuit's order of October 30, 2026 in No. 26-7139 is about a project the Department of Homeland Security
    calls its "Unlawful Voter Initiative". The lines are as text extraction gives them."""
    order = ("2026, DHS began its Unlawful Voter Initiative (“Initiative”). The Initiative is a\ndepartmental project. Carrying out the\n"
             "Initiative includes door-to-door interrogations. Members fear DHS’s Unlawful Voter Initiative.\nThey are the people the\n"
             "Initiative has already targeted. The agencies are implementing the Unlawful Voter\nInitiative, in substantial part.\n")
    assert tag([("full text of the opinion", order * 4, classify.LONG)]) == []
    assert "direct-democracy" not in tags_of([("case caption", "In re Unlawful Voter Initiative")])
    # A voter initiative under that word's other meaning is still read, in a long document and in a caption.
    measure = "The voter initiative qualified for the ballot. Opponents of the ballot measure sued. "
    found = tags_of([("full text of the opinion", order + measure * 3, classify.LONG)])
    assert found["direct-democracy"].matchCount == 6 and "voter initiative qualified" in found["direct-democracy"].matchedText
    assert "direct-democracy" in tags_of([("case caption", "Committee for the Voter Initiative v. Synthetic Secretary of State")])


def test_a_line_of_a_long_document_is_not_a_subject_line():
    """A subject line that begins with "Initiatives" names its subject. In a filing a PDF breaks the lines anywhere."""
    assert "direct-democracy" in tags_of([("official subject line", "Initiatives: petition circulators.")])
    assert "direct-democracy" in tags_of([("official subject line", "Elections: initiatives.")])
    assert "direct-democracy" in tags_of([("digest", "(1) Existing law regulates synthetic petitions.\nInitiatives must be titled.", classify.DIGEST)])
    wrapped = "The agency announced the Synthetic Border\nInitiative in the spring and funded the\ninitiative for two years. "
    assert tag([("full text of the opinion", wrapped * 5, classify.LONG)]) == []
    # The beginning of the document itself is still a beginning, and words after a colon are read as before.
    assert "direct-democracy" in tags_of([("full text of the opinion", "Initiatives are proposed by petition. " + "Subject: initiatives. " * 4, classify.LONG)])


def test_matched_text_is_a_short_excerpt_of_the_source_not_a_summary():
    text = "x" * 500 + " voter identification " + "y" * 500
    t = tags_of([("subject", text)])["voter-id"]
    assert "voter identification" in t.matchedText
    assert len(t.matchedText) <= 70 + len("voter identification") + 70  # 40 characters each side, widened to whole words
    assert t.matchedText in " ".join(text.split())


def test_matched_text_never_starts_or_ends_mid_word():
    text = "The court held that the map of Louisiana likely violated Section 2 of the Voting Rights Act and ordered a remedy"
    found = tag([("subject", text)])
    assert found
    t = found[0]
    words = set(text.split())
    first, last = t.matchedText.split()[0], t.matchedText.split()[-1]
    assert first in words and last in words


def test_no_rule_no_tag():
    assert tag([("case caption", "Synthetic Alpha v. Synthetic Beta")]) == []
    assert tag([("subject", "")]) == []
    assert tag([]) == []


def test_first_field_that_matches_is_recorded():
    found = tags_of([("case caption", "In re Recall of Synthetic Official"), ("questions presented", "Whether the recall petition was valid.")])
    assert found["direct-democracy"].matchedField == "case caption"


def test_a_passing_mention_in_a_long_document_is_not_a_subject():
    body = "This filing concerns absentee ballots. " * 20 + "See generally the Voting Rights Act."
    found = tags_of([("full text", body, "long")])
    assert "mail-voting" in found
    assert "voting-rights-act" not in found  # one citation is not prominence
    assert found["mail-voting"].matchCount == 20


def test_long_document_needs_the_minimum_number_of_matches():
    few = "The polling place was moved. " * (LONG_TEXT_MIN_MATCHES - 1)
    enough = "The polling place was moved. " * LONG_TEXT_MIN_MATCHES
    assert tag([("full text", few, "long")]) == []
    assert [t.tag for t in tag([("full text", enough, "long")])] == ["election-administration"]


def test_long_document_needs_a_share_of_the_dominant_topic():
    body = "redistricting " * 100 + "voter registration " * 6
    found = tags_of([("full text", body, "long")])
    assert "redistricting" in found
    assert "registration" not in found  # 6 of 100 is below the 15% share
    body = "redistricting " * 100 + "voter registration " * 15
    assert "registration" in tags_of([("full text", body, "long")])


def test_candidate_filing_alone_is_not_ballot_access():
    assert "ballot-access" not in tags_of([("subject", "Campaign statements: candidate filing deadlines.")])


def test_rules_are_published_with_unique_ids():
    document = classify.rules_document()
    ids = [r["ruleId"] for r in document["issueRules"]]
    assert len(ids) == len(set(ids)) == len(ISSUE_RULES)
    assert {r["tag"] for r in document["issueRules"]} == set(classify.TAG_LABELS)
    assert "Tags indicate subject matter only" in document["note"]
    assert str(LONG_TEXT_MIN_MATCHES) in document["note"]


def test_every_tag_assigned_cites_a_published_rule():
    text = " ".join(["Voting Rights Act", "redistricting", "vote by mail", "voter registration", "photo identification",
                     "ballot access", "polling place", "election results", "voting system", "Elections Clause", "recall", "campaign finance"])
    published = {r["ruleId"] for r in classify.rules_document()["issueRules"]}
    found = tag([("subject", text)])
    assert len(found) >= 10
    assert {t.ruleId for t in found} <= published
