"""Issue tags come only from published keyword rules, and each records why it was assigned."""

from dhq import classify
from dhq.classify import ISSUE_RULES, LONG_TEXT_MIN_MATCHES, classify as tag


def tags_of(fields):
    return {t.tag: t for t in tag(fields)}


def test_one_match_in_a_short_authoritative_field_assigns_the_tag():
    found = tags_of([("questions presented", "Whether the State's congressional districting plan violates Section 2.")])
    assert set(found) == {"redistricting"}
    t = found["redistricting"]
    assert t.ruleId == "tag-redist-1"
    assert t.matchedField == "questions presented"
    assert "districting plan" in t.matchedText
    assert t.matchCount is None


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
