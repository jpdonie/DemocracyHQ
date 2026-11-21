"""Who holds office: the rules ``party-*``, the readers of the four sources, and the stage that publishes the result.

SYNTHETIC TEST DATA. Every member, governor, count and date here is invented (see ``synthetic_officials``).
"""

from __future__ import annotations

import pytest

import dhq.run as pipeline
from dhq import government
from dhq.adapters import officials
from dhq.schemas import Government
from dhq.util import write_json

import synthetic_officials as syn
from conftest import FakeResponse
from test_run import T1, T2, env  # noqa: F401 - env is a fixture


# --- rule party-group-1: which label counts with which party --------------------------------

@pytest.mark.parametrize("label, group", [
    ("Republican", "R"), ("R", "R"), ("Democratic", "D"), ("Democrat", "D"), ("D", "D"),
    ("Democratic-Farmer-Labor", "D"), ("Democratic-Nonpartisan League", "D"), ("Democratic-NPL", "D"),
    ("Democratic/Working Families", "D"), ("Republican/Conservative", "R"), ("  republican  ", "R"),
    ("Independent", "I"), ("I", "I"), ("ID", "I"), ("Nonpartisan", "N"),
    ("Working Families/Democratic", "O"), ("Libertarian", "O"), ("Progressive/Democratic", "O"),
    ("Forward", "O"), ("", "O"), (None, "O"),
])
def test_a_label_is_counted_with_a_party_only_by_the_published_rule(label, group):
    assert government.party_group(label) == group


def test_a_label_that_only_resembles_a_party_name_is_not_counted_with_it():
    """"Democratic Socialists" or "Republican Liberty" name another party; only the listed forms count."""
    assert [government.party_group(label) for label in ("Democratic Socialists", "Republican Liberty", "Independent Republican")] == ["O", "O", "O"]


def test_the_count_keeps_the_labels_the_source_wrote():
    parties = government.tally(["Republican"] * 3 + ["Democratic", "Democratic/Working Families", "Democratic/Working Families", "Forward", "Libertarian"])
    assert [(p["group"], p["name"], p["seats"]) for p in parties] == [("R", "Republican", 3), ("D", "Democratic", 3), ("O", "Forward", 1), ("O", "Libertarian", 1)]
    assert parties[1]["labels"] == [{"label": "Democratic/Working Families", "seats": 2}, {"label": "Democratic", "seats": 1}]


def test_a_member_without_a_label_is_counted_and_said_to_have_none():
    assert government.tally(["", None]) == [{"group": "O", "name": "No party given", "seats": 2, "labels": [{"label": "No party given", "seats": 2}]}]


# --- rule party-seats-1: when a chamber has a colour ----------------------------------------

def test_a_chamber_has_a_colour_only_with_more_than_half_of_all_seats():
    assert government.majority(government.tally(syn.split(40, 21)), 40) == "R"
    assert government.majority(government.tally(syn.split(40, 19)), 40) == "D"
    assert government.majority(government.tally(syn.split(40, 20)), 40) is None  # an even split


def test_a_vacant_seat_counts_against_the_majority():
    """Twenty of thirty-nine members are more than half of the members, and exactly half of the forty seats."""
    assert government.majority(government.tally(["Republican"] * 20 + ["Democratic"] * 19), 40) is None


def test_the_largest_group_has_no_colour_while_independents_hold_the_balance():
    parties = government.tally(["Republican"] * 19 + ["Democratic"] * 17 + ["Independent"] * 4)
    assert government.majority(parties, 40) is None


def test_without_the_number_of_seats_there_is_no_majority():
    assert government.majority(government.tally(["Republican"] * 30), None) is None


def test_a_chamber_that_lists_more_members_than_it_has_seats_is_published_without_seats_or_colour():
    made = government.chamber(key="upper", name="Senate", labels=["Republican"] * 6, seats=5, source_id="s", source_url="https://example.org/a",
                              as_of=None, checked_at=T1)
    assert (made["members"], made["seats"], made["vacant"], made["lead"]) == (6, None, None, None)


def test_a_majority_the_source_states_is_used_and_said_to_be_stated():
    made = government.chamber(key="lower", name="House", labels=["R"] * 217 + ["D"] * 215, seats=435, source_id="s", source_url="https://example.org/a",
                              as_of="2026-06-01", checked_at=T1, stated_majority="R")
    assert (made["lead"], made["leadBasis"], made["vacant"]) == ("R", "stated", 3)
    assert government.majority(made["parties"], made["seats"]) is None  # 217 of 435 is not more than half


# --- rule party-trifecta-1: when a government is held by one party ---------------------------

def _chamber(lead_labels, seats, key="upper"):
    return government.chamber(key=key, name=key, labels=lead_labels, seats=seats, source_id="s", source_url="https://example.org/a", as_of=None, checked_at=T1)


def _governor(party):
    return government.executive(office="Governor", name="Synthetic Governor", party=party, term_started="2023-01-07", source_id="g",
                                source_url="https://example.org/g", checked_at=T1)


def test_one_party_holds_a_government_when_it_has_the_executive_and_every_chamber():
    both = [_chamber(syn.split(5, 3), 5), _chamber(syn.split(9, 5), 9, "lower")]
    assert government.control(_governor("Republican"), both) == "R"
    assert government.control(_governor("Democratic"), both) == "divided"
    assert government.control(_governor("Republican"), [both[0], _chamber(syn.split(9, 4), 9, "lower")]) == "divided"
    assert government.control(_governor("Democratic"), [_chamber(syn.split(5, 2), 5), _chamber(syn.split(9, 4), 9, "lower")]) == "D"


def test_a_tied_chamber_or_an_independent_governor_makes_a_government_divided():
    tied = [_chamber(syn.split(4, 2), 4), _chamber(syn.split(9, 5), 9, "lower")]
    assert government.control(_governor("Republican"), tied) == "divided"
    assert government.control(_governor("Independent"), [_chamber(syn.split(5, 3), 5)]) == "divided"


def test_a_government_with_a_part_that_was_not_read_is_not_determined():
    chambers = [_chamber(syn.split(5, 3), 5), _chamber(syn.split(9, 5), 9, "lower")]
    assert government.control(None, chambers) == "undetermined"
    assert government.control(_governor("Republican"), []) == "undetermined"


def test_a_legislature_elected_without_party_labels_is_not_determined():
    assert government.control(_governor("Republican"), [_chamber(["Nonpartisan"] * 5, 5, "legislature")]) == "undetermined"


def test_a_state_with_a_single_missing_chamber_is_not_determined():
    """A legislature of two chambers of which only one was kept from an earlier run says nothing about the other."""
    made = government.government(unit_id="state:06", name="California", holder=_governor("Democratic"), chambers=[_chamber(syn.split(5, 1), 5)],
                                 expected_chambers=("upper", "lower"))
    assert (made["control"], made["missingChambers"]) == ("undetermined", ["lower"])


# --- the Clerk's list of the House ------------------------------------------------------------

def test_the_house_is_read_seat_by_seat_and_the_members_without_a_vote_are_set_apart():
    listed = officials.read_house(syn.house_xml(syn.house_seats(218, 214, independent=1, vacant=2), caucus={432: "R"}))
    assert (listed["seats"], len(listed["labels"]), listed["nonVoting"]) == (435, 433, 6)
    assert (listed["asOf"], listed["statedMajority"], listed["congress"]) == ("2026-06-01", "R", "199")
    assert listed["caucus"] == [{"party": "I", "caucus": "R", "members": 1}]
    made = government.house_chamber(listed, source_id=officials.HOUSE_SOURCE_ID, source_url=officials.HOUSE_URL, checked_at=T1)
    assert (made["members"], made["seats"], made["vacant"], made["lead"], made["leadBasis"]) == (433, 435, 2, "R", "stated")
    assert "6 members without a vote on the floor" in made["note"] and "1 member listed as Independent sits with the Republican caucus" in made["note"]


def test_a_house_list_that_is_cut_short_or_not_xml_is_refused():
    with pytest.raises(officials.SourceFormatError, match="expected the whole House"):
        officials.read_house(syn.house_xml(syn.house_seats(100, 100)))
    with pytest.raises(officials.SourceFormatError, match="not well-formed"):
        officials.read_house(b"<html><body>Service unavailable")


def test_a_seated_member_without_a_party_stops_the_house_from_being_published():
    broken = syn.house_xml(syn.house_seats(218, 217)).replace(b"<party>R</party>", b"<party/>", 1)
    with pytest.raises(officials.SourceFormatError, match="names no party"):
        officials.read_house(broken)


# --- the Senate's list ------------------------------------------------------------------------

def test_the_senate_is_read_with_the_day_of_its_last_change():
    listed = officials.read_senate(syn.senate_xml(["R"] * 53 + ["D"] * 45 + ["I"] * 2))
    assert (len(listed["labels"]), listed["asOf"]) == (100, "2026-05-30")
    made = government.senate_chamber(listed, officials.SENATE_SEATS, source_id=officials.SENATE_SOURCE_ID, source_url=officials.SENATE_URL, checked_at=T1)
    assert (made["lead"], made["vacant"], made["leadBasis"]) == ("R", 0, "seats")
    assert "does not say which party's caucus an independent senator sits with" in made["note"]


def test_fifty_senators_of_a_hundred_are_not_a_majority_whatever_the_vice_president_may_do():
    listed = officials.read_senate(syn.senate_xml(["R"] * 50 + ["D"] * 50))
    made = government.senate_chamber(listed, officials.SENATE_SEATS, source_id="s", source_url=officials.SENATE_URL, checked_at=T1)
    assert made["lead"] is None and made["note"] is None


@pytest.mark.parametrize("parties", [["R"] * 60, ["R"] * 101, ["R"] * 99 + [""]])
def test_a_senate_list_of_the_wrong_size_or_without_a_party_is_refused(parties):
    with pytest.raises(officials.SourceFormatError):
        officials.read_senate(syn.senate_xml(parties))


# --- the governors' pages ---------------------------------------------------------------------

def test_the_governors_are_read_from_the_list_and_each_page():
    states = [name for _, name in syn.FIFTY.values()]
    found = officials.read_governor_list(syn.governor_list_html(states))
    assert len(found) == 50
    assert found[0] == {"state": "Alabama", "name": "Synthetic Alabama", "url": "https://www.nga.org/governors/alabama/"}
    assert officials.read_governor(syn.governor_page_html("Alabama", "Republican")) == {"party": "Republican", "termStarted": "2023-01-07"}


def test_a_list_of_governors_in_another_layout_is_refused():
    with pytest.raises(officials.SourceFormatError, match="expected at least 50"):
        officials.read_governor_list("<html><body><ul><li>Alabama: Gov. Synthetic</li></ul></body></html>")


@pytest.mark.parametrize("page", [
    syn.governor_page_html("Alabama", None),
    syn.governor_page_html("Alabama", "Republican", terms="January 5, 2015 - January 7, 2019"),
])
def test_a_page_without_a_party_or_without_a_current_term_is_not_a_sitting_governor(page):
    with pytest.raises(officials.SourceFormatError, match="no party or marks no term as current"):
        officials.read_governor(page)


# --- the files of state legislators -----------------------------------------------------------

def test_legislators_are_read_by_chamber_with_their_label_and_district():
    listed = officials.read_legislators(syn.legislators_csv({"upper": ["Republican", "Democratic/Working Families"], "lower": ["Democratic"]}))
    assert listed == {"upper": [{"party": "Republican", "district": "1"}, {"party": "Democratic/Working Families", "district": "2"}],
                      "lower": [{"party": "Democratic", "district": "1"}]}


@pytest.mark.parametrize("content, said", [
    (b"id,name,party\nx,Synthetic,Republican\n", "expected current_party"),
    (syn.CSV_HEAD.encode() + b"\n", "lists no member"),
    (syn.legislators_csv({"executive": ["Republican"]}), "in the chamber 'executive'"),
])
def test_a_file_of_legislators_in_another_form_is_refused(content, said):
    with pytest.raises(officials.SourceFormatError, match=said):
        officials.read_legislators(content)


def test_the_chambers_of_a_state_follow_the_table_of_seats():
    table = {"upper": {"name": "Senate", "seats": 5}, "lower": {"name": "House", "seats": 9}}
    chambers, problems = government.state_chambers(
        {"upper": [{"party": p, "district": "1"} for p in syn.split(5, 3)], "lower": [{"party": p, "district": "1"} for p in syn.split(8, 4)]},
        table, source_id="o", source_url="https://example.org/x.csv", as_of="2026-05-29", checked_at=T1)
    assert problems == []
    assert [(c["chamber"], c["name"], c["members"], c["seats"], c["vacant"], c["lead"]) for c in chambers] == [
        ("upper", "Senate", 5, 5, 0, "R"), ("lower", "House", 8, 9, 1, None)]


def test_members_without_a_numbered_district_are_set_apart_where_the_table_says_so():
    table = {"lower": {"name": "House", "seats": 3, "numberedDistrictsOnly": True}}
    members = [{"party": "Democratic", "district": "1"}, {"party": "Democratic", "district": "2"}, {"party": "Republican", "district": "3"},
               {"party": "Independent", "district": "Passamaquoddy Tribe"}]
    chambers, problems = government.state_chambers({"lower": members}, table, source_id="o", source_url="https://example.org/x.csv", as_of=None, checked_at=T1)
    assert (chambers[0]["members"], chambers[0]["lead"], problems) == (3, "D", [])
    assert chambers[0]["note"] == ("The source also lists 1 member who does not sit for a numbered district and has no vote on the floor. "
                                   "Such members are not counted.")


def test_a_chamber_with_more_members_than_seats_is_reported_for_a_maintainer():
    chambers, problems = government.state_chambers({"upper": [{"party": "Republican", "district": str(i)} for i in range(6)]},
                                                   {"upper": {"name": "Senate", "seats": 5}}, source_id="o", source_url="https://example.org/x.csv",
                                                   as_of=None, checked_at=T1)
    assert chambers[0]["lead"] is None and problems == ["Senate: the source lists 6 members, the table of chambers has 5 seats"]


def test_a_source_that_lists_other_chambers_than_the_table_is_refused():
    with pytest.raises(ValueError, match="the table of chambers has"):
        government.state_chambers({"legislature": [{"party": "Nonpartisan", "district": "1"}]}, {"upper": {"name": "Senate", "seats": 5}},
                                  source_id="o", source_url="https://example.org/x.csv", as_of=None, checked_at=T1)


# --- the stage ----------------------------------------------------------------------------------

SOURCES = (officials.SENATE_SOURCE_ID, officials.HOUSE_SOURCE_ID, officials.GOVERNORS_SOURCE_ID, officials.LEGISLATORS_SOURCE_ID)


@pytest.fixture
def country(env, session):  # noqa: F811
    write_json(env.seeds_dir / "chambers.json", syn.chambers_table(one_house=("NE",)))
    syn.serve_country(session, governors={"California": "Democratic", "Kansas": "Democratic", "Nebraska": "Republican"}, legislatures={
        "CA": {"upper": syn.split(syn.UPPER_SEATS, 1), "lower": syn.split(syn.LOWER_SEATS, 2)},
        "NE": {"legislature": ["Nonpartisan"] * syn.UPPER_SEATS},
        "MN": {"upper": syn.split(syn.UPPER_SEATS, 2, other=["Democratic-Farmer-Labor"] * 3), "lower": syn.split(syn.LOWER_SEATS, 4)},
    })
    return env


def governments(env_):
    return {record["id"]: record for record in env_.read("government.json")["governments"]}


def test_the_stage_publishes_the_country_and_the_fifty_states(country):
    code, ctx = country.run(["government"])
    assert code == 0
    published = governments(country)
    assert len(published) == 51 and all(Government(**record) for record in published.values())
    assert {published[key]["control"] for key in ("state:01", "state:48")} == {"R"}
    assert published["state:06"]["control"] == "D"       # a Democratic governor and both chambers
    assert published["state:20"]["control"] == "divided"  # Kansas: a Democratic governor, Republican chambers
    assert published["state:27"]["control"] == "divided"  # Minnesota: a tied lower chamber (4 of 9 with a vacancy)
    assert published["state:31"]["control"] == "undetermined"  # Nebraska: no party labels
    senate = published["state:27"]["chambers"][0]
    assert (senate["lead"], [p["labels"] for p in senate["parties"] if p["group"] == "D"]) == ("D", [[{"label": "Democratic-Farmer-Labor", "seats": 3}]])
    assert {country.source(s)["processingStatus"] for s in SOURCES} == {"ok"}
    assert country.source(officials.LEGISLATORS_SOURCE_ID)["sourcePublishedAt"].startswith("2026-05-29")
    assert country.read("government.json")["generatedAt"] == T1


def test_the_country_is_not_determined_while_no_source_names_the_presidents_party(country):
    country.run(["government"])
    nation = governments(country)["nation:US"]
    assert (nation["control"], nation["executive"]) == ("undetermined", None)
    assert "none of the sources read here names the President's party" in nation["executiveNote"]
    assert [(c["name"], c["lead"], c["seats"]) for c in nation["chambers"]] == [("Senate", "R", 100), ("House of Representatives", "R", 435)]


def test_the_rules_are_published_with_the_others(country):
    country.run(["government"])
    rules = {rule["ruleId"]: rule for rule in country.read("classification.json")["otherRules"]}
    assert {government.GROUP_RULE_ID, government.SEATS_RULE_ID, government.TRIFECTA_RULE_ID} <= set(rules)
    assert "vacant seats included" in rules[government.SEATS_RULE_ID]["description"]


def test_a_source_that_fails_keeps_what_was_published_from_it_with_its_own_day(country, session):
    country.run(["government"], now=T1)
    session.on(officials.SENATE_URL, FakeResponse(503))
    session.on(syn.legislators_url("TX"), FakeResponse(200, b"<html>Not found</html>"))
    code, ctx = country.run(["government"], now=T2)
    assert code == 1
    published = governments(country)
    senate, house = published["nation:US"]["chambers"]
    assert (senate["checkedAt"], house["checkedAt"]) == (T1, T2)
    assert [c["checkedAt"] for c in published["state:48"]["chambers"]] == [T1, T1]
    assert published["state:48"]["control"] == "R"
    assert [c["checkedAt"] for c in published["state:01"]["chambers"]] == [T2, T2]
    failed = country.source(officials.LEGISLATORS_SOURCE_ID)
    assert failed["processingStatus"] == "failed" and "1 of 50 legislatures could not be read (TX)" in failed["statusDetail"]
    assert country.source(officials.SENATE_SOURCE_ID)["lastSuccessfulCheck"] == T1
    assert country.source(officials.HOUSE_SOURCE_ID)["processingStatus"] == "ok"


def test_a_first_run_without_the_governors_publishes_no_colour_for_any_state(country, session):
    session.on(officials.GOVERNORS_URL, FakeResponse(200, "<html><body>A new layout</body></html>"))
    code, ctx = country.run(["government"])
    assert code == 1
    published = governments(country)
    assert {record["control"] for key, record in published.items() if key.startswith("state:")} == {"undetermined"}
    assert published["state:01"]["executiveNote"] == "No governor was read for this state."
    assert published["state:01"]["chambers"][0]["lead"] == "R"  # the chambers are still shown


def test_one_governor_whose_page_cannot_be_read_stops_the_whole_source_and_keeps_the_earlier_governors(country, session):
    country.run(["government"], now=T1)
    session.on(syn.governor_url("Ohio"), FakeResponse(200, syn.governor_page_html("Ohio", None)))
    code, ctx = country.run(["government"], now=T2)
    assert code == 1
    published = governments(country)
    assert published["state:39"]["executive"]["checkedAt"] == T1 and published["state:01"]["executive"]["checkedAt"] == T1
    assert "Ohio" in country.source(officials.GOVERNORS_SOURCE_ID)["statusDetail"]


def test_a_stated_majority_that_the_seats_contradict_is_queued_for_a_maintainer(country, session):
    session.on(officials.HOUSE_URL, FakeResponse(200, syn.house_xml(syn.house_seats(215, 220), majority="R")))
    code, ctx = country.run(["government"])
    house = governments(country)["nation:US"]["chambers"][1]
    assert (house["lead"], house["leadBasis"]) == ("R", "stated")
    queued = [item for item in ctx.queue if item["kind"] == "stated_majority_differs"]
    assert len(queued) == 1 and "the members listed give D more than half" in queued[0]["detail"]


def test_a_chamber_with_more_members_than_seats_is_queued_and_has_no_colour(country, session):
    session.on(syn.legislators_url("OH"), FakeResponse(200, syn.legislators_csv({"upper": syn.split(syn.UPPER_SEATS + 1, 4), "lower": syn.split(syn.LOWER_SEATS, 5)})))
    code, ctx = country.run(["government"])
    ohio = governments(country)["state:39"]
    assert (ohio["chambers"][0]["seats"], ohio["chambers"][0]["lead"], ohio["control"]) == (None, None, "undetermined")
    assert any(item["kind"] == "chamber_size" and item["entity"] == "state:39" for item in ctx.queue)


def test_a_table_of_chambers_that_does_not_list_the_fifty_states_stops_the_stage(country):
    table = syn.chambers_table()
    del table["states"]["WY"]
    write_json(country.seeds_dir / "chambers.json", table)
    code, ctx = country.run(["government"])
    assert code != 0 and not (country.public / "government.json").exists()
