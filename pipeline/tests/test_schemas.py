"""The pipeline's models reject malformed records before anything is published.

These tests exercise the pydantic models only; they do not load the site's zod schemas. Agreement with
those is checked on the published files by ``scripts/validate-data.mjs``, which the scheduled workflow
runs before it commits.
"""

import pytest
from pydantic import ValidationError

from dhq.adapters import scotus
from dhq.schemas import EffectiveInfo, LegalCase, LegislativeAction, SourceRecord, Verification
from dhq.sources import SOURCES

from conftest import synthetic_docket

CHECKED = "2026-06-15T12:00:00Z"


def case_dict(**overrides):
    record = scotus.normalise("99-0001", synthetic_docket(), checked_at=CHECKED).model_dump(mode="json")
    record.update(overrides)
    return record


def test_a_well_formed_record_passes():
    assert LegalCase(**case_dict()).docketNumber == "99-0001"


@pytest.mark.parametrize("field,value", [
    ("dateDocketed", "10 January 2026"),
    ("dateDocketed", "2026-1-10"),
    ("dateDocketed", "2026-02-30"),
    ("sourceLastActivity", "2026-03-09T00:00:00Z"),
    ("lastCheckedAt", "2026-06-15"),
    ("lastCheckedAt", "2026-06-15T12:00:00+02:00"),
    ("firstObservedAt", "yesterday"),
    ("sourceUrl", "http://www.supremecourt.gov/x"),
    ("sourceUrl", "javascript:alert(1)"),
    ("caseName", ""),
    ("docketNumber", ""),
    ("entryCount", -1),
])
def test_malformed_values_are_rejected(field, value):
    with pytest.raises(ValidationError):
        LegalCase(**case_dict(**{field: value}))


def test_unknown_fields_are_rejected_so_nothing_slips_into_the_published_model():
    with pytest.raises(ValidationError):
        LegalCase(**case_dict(confidenceScore=0.93))
    with pytest.raises(ValidationError):
        LegalCase(**case_dict(caseStatus="pending"))


def test_verification_has_a_closed_set_of_states_and_no_score():
    assert set(Verification.model_fields) == {"status", "method", "checkedAt", "note"}
    with pytest.raises(ValidationError):
        Verification(status="probably_fine", method="manual_review", checkedAt=CHECKED)
    with pytest.raises(ValidationError):
        Verification(status="verified_primary", method="ai_review", checkedAt=CHECKED)


def test_effective_date_needs_a_documented_basis():
    with pytest.raises(ValidationError):
        EffectiveInfo(date="2027-01-01", basis="assumed_january_1", note="")
    assert EffectiveInfo(date=None, basis="not_verified", note="x").date is None


def test_action_dates_must_be_real_dates():
    with pytest.raises(ValidationError):
        LegislativeAction(date="2026-13-01", sequence=1, text="x", eventType="introduced", significance="major")


def test_every_registered_source_is_complete():
    for source_id, static in SOURCES.items():
        record = SourceRecord(id=source_id, processingStatus="not_run", **static)
        assert record.url.startswith("https://")
        assert record.license and record.attribution and record.authority
        assert record.geographicCoverage and record.temporalCoverage and record.updateCadence
        assert record.staleAfterDays > 0
    assert SOURCES["courtlistener-api"]["credentialEnv"] == "COURTLISTENER_API_TOKEN"
    assert SOURCES["openstates-api"]["credentialEnv"] == "OPENSTATES_API_KEY"
    assert any("have not been checked against the official bill pages" in note for note in SOURCES["openstates-api"]["knownLimitations"])
    # CourtListener is read: its entry says that it is a collection and not a court, and that a token is needed.
    limits = SOURCES["courtlistener-api"]["knownLimitations"]
    assert any("is a collection, not a court" in note for note in limits) and any("Requires an API token" in note for note in limits)
    assert SOURCES["courtlistener-api"]["sourceType"] == "secondary_api"
