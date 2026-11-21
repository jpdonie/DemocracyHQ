"""The table of states for each judicial circuit, and its check against the statute.

The two pages under ``tests/fixtures/uscode`` are the official text of 28 U.S.C. § 41 and 48 U.S.C. § 1821 as GovInfo
serves it (see the README there). Everything else in this file is derived from them: a state moved to another circuit,
a missing row, a page of another edition.
"""

from pathlib import Path

import pytest

from dhq import circuits
from dhq.schemas import Court
from dhq.util import STATES

FIXTURES = Path(__file__).parent / "fixtures" / "uscode"
SECTION_41 = (FIXTURES / "USCODE-2024-title28-partI-chap3-sec41.htm").read_text(encoding="utf-8")
SECTION_1821 = (FIXTURES / "USCODE-2024-title48-chap17-subchapII-sec1821.htm").read_text(encoding="utf-8")


def test_the_table_says_what_the_statute_says():
    verified = circuits.verify_composition(SECTION_41, SECTION_1821)
    assert verified["edition"] == "United States Code, 2024 Edition"
    assert verified["currentThrough"] == "2025-01-06"
    assert set(verified["quotes"]) == {court.id for court in circuits.CIRCUITS}
    assert verified["quotes"]["ca1"] == "Maine, Massachusetts, New Hampshire, Puerto Rico, Rhode Island."
    assert verified["quotes"]["cafc"] == "All Federal judicial districts."
    # The statute still names the Canal Zone; it is quoted as it stands and is not a unit on the map.
    assert verified["quotes"]["ca5"] == "District of the Canal Zone, Louisiana, Mississippi, Texas."


def test_every_state_and_territory_is_in_exactly_one_circuit_except_american_samoa():
    placed = [fips for court in circuits.REGIONAL for fips in court.states]
    assert len(placed) == len(set(placed)) == 55
    assert set(placed) | {"60"} == set(STATES)
    assert circuits.WITHOUT_CIRCUIT == ["60"]
    assert circuits.CIRCUIT_OF_STATE["69"] == circuits.CIRCUIT_OF_STATE["66"] == "ca9"
    assert len(circuits.REGIONAL) == 12 and circuits.BY_ID["cafc"].geo_key is None


def test_the_published_court_records_quote_the_statute_and_validate():
    records = circuits.court_records(circuits.verify_composition(SECTION_41, SECTION_1821))
    courts = {record["id"]: Court(**record) for record in records}
    assert len(courts) == 13
    assert courts["ca5"].geoKey == "circuit:05" and courts["ca5"].states == ["22", "28", "48"]
    assert courts["ca5"].basis.citation == "28 U.S.C. § 41" and courts["ca5"].basis.url == circuits.SECTION_41_URL
    assert courts["cadc"].geoKey == "circuit:DC" and courts["cadc"].shortName == "D.C. Circuit"
    assert courts["cafc"].geoKey is None and courts["cafc"].states == []
    # The Northern Mariana Islands are placed by another provision, which the Ninth Circuit's record quotes too.
    assert courts["ca9"].basis.also == [{"citation": "48 U.S.C. § 1821(a)", "url": circuits.SECTION_1821_URL,
                                         "quote": circuits.NORTHERN_MARIANAS_SENTENCE}]
    assert all(court.basis.also is None for court_id, court in courts.items() if court_id != "ca9")


@pytest.mark.parametrize("change, message", [
    # A state moved from the Sixth Circuit to the Seventh.
    (lambda page: page.replace("Kentucky, Michigan, Ohio, Tennessee.", "Kentucky, Ohio, Tennessee.")
                      .replace("Illinois, Indiana, Wisconsin.", "Illinois, Indiana, Michigan, Wisconsin."), "Sixth Circuit"),
    # A circuit loses a state that no other circuit gains.
    (lambda page: page.replace("Connecticut, New York, Vermont.", "Connecticut, New York."), "Second Circuit"),
    # A name the table does not know.
    (lambda page: page.replace("Alabama, Florida, Georgia.", "Alabama, Florida, Georgia, Atlantis."), "Atlantis"),
    # The same state named twice in one entry.
    (lambda page: page.replace("Alabama, Florida, Georgia.", "Alabama, Florida, Florida, Georgia."), "Eleventh Circuit"),
    # A row is missing.
    (lambda page: page.replace('<td class="left">Tenth </td>', '<td class="other">Tenth </td>'), "12 circuits"),
    # A circuit is renamed.
    (lambda page: page.replace('<td class="left">Tenth </td>', '<td class="left">Fourteenth </td>'), "'Tenth'"),
    (lambda page: page.replace("All Federal judicial districts.", "All Federal judicial districts and territories."), "Federal Circuit"),
    (lambda page: "<html><body>The requested page was not found.</body></html>", "not section 41"),
    (lambda page: page.replace("United States Code, 2024 Edition", "United States Code"), "does not name an edition"),
])
def test_a_statute_that_says_something_else_stops_the_check(change, message):
    with pytest.raises(circuits.CompositionError, match=message):
        circuits.verify_composition(change(SECTION_41), SECTION_1821)


@pytest.mark.parametrize("change, message", [
    (lambda page: page.replace("the same judicial circuit of the United States as Guam", "the Ninth Circuit"), "Northern Mariana Islands"),
    (lambda page: "<html><body>The requested page was not found.</body></html>", "Northern Mariana Islands"),
    (lambda page: page.replace("United States Code, 2024 Edition", "United States Code, 2023 Edition"), "different editions"),
])
def test_the_provision_on_the_northern_mariana_islands_must_be_there_in_the_same_edition(change, message):
    with pytest.raises(circuits.CompositionError, match=message):
        circuits.verify_composition(SECTION_41, change(SECTION_1821))


def test_the_sentence_must_be_in_the_statute_itself_not_in_a_note_below_it():
    statute_end = SECTION_1821.find("field-end:statute")
    moved = (SECTION_1821[:statute_end].replace(circuits.NORTHERN_MARIANAS_SENTENCE, "")
             + SECTION_1821[statute_end:] + f"<p>{circuits.NORTHERN_MARIANAS_SENTENCE}</p>")
    with pytest.raises(circuits.CompositionError, match="Northern Mariana Islands"):
        circuits.verify_composition(SECTION_41, moved)
