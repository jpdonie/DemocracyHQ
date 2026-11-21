"""Typed, validated records shared by every pipeline stage.

These pydantic models mirror ``src/types/schemas.ts`` (zod) in the frontend.
Field names are camelCase on the wire so the published JSON is identical for
both languages; ``scripts/validate-data.mjs`` re-validates the published files
with the zod schemas in CI, so the two definitions cannot silently drift.

Date semantics (never collapsed into one "date" field):

* ``date`` / ``*Date``      - when the event happened in the world (court or legislature).
* ``sourcePublishedAt``     - when the source says it published/generated the record.
* ``firstObservedAt``       - when DemocracyHQ first saw the record.
* ``lastCheckedAt``         - when DemocracyHQ last successfully retrieved it.
"""

from __future__ import annotations

from datetime import date as _date
from enum import Enum
from typing import Annotated, Dict, List, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints


def _real_date(value: str) -> str:
    _date.fromisoformat(value)  # rejects 2026-02-30 as well as the wrong shape
    return value


def _real_timestamp(value: str) -> str:
    _date.fromisoformat(value[:10])
    return value


#: A calendar date exactly as ``YYYY-MM-DD``.
IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(_real_date)]
#: A UTC timestamp exactly as ``YYYY-MM-DDTHH:MM:SSZ``.
IsoDateTime = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"), AfterValidator(_real_timestamp)]
#: A California bill id (``ca-20252026-ab604``). It names the bill's published file, so nothing else is accepted.
#: Mirrors ``ca_leginfo.BILL_ID_PATTERN`` and the zod schema's bill id.
CaBillId = Annotated[str, StringConstraints(pattern=r"^ca-[0-9]{8}-[a-z]{2,3}[0-9]{1,5}$")]
#: Links are only ever published as https.
HttpsUrl = Annotated[str, StringConstraints(pattern=r"^https://")]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class VerificationStatus(str, Enum):
    """Documented in docs/DATA_SOURCES.md ("Verification states")."""

    VERIFIED_PRIMARY = "verified_primary"
    IMPORTED_SECONDARY = "imported_secondary"
    AWAITING_REVIEW = "awaiting_review"
    DISPUTED = "disputed"
    OUTDATED = "outdated"
    UNAVAILABLE = "unavailable"


class Verification(Model):
    status: VerificationStatus
    method: Literal[
        "automated_primary_retrieval",  # fetched from the official source and schema-validated
        "automated_secondary_import",  # fetched from a non-official aggregator
        "rule_derived",  # produced by a documented, deterministic rule
        "manual_review",  # a named maintainer compared it with the primary source
        # written by a maintainer; the quoted passage was found in the cited document when it was last fetched.
        # Curated links published before this value existed carry "rule_derived", which stays valid.
        "maintainer_curated",
    ]
    checkedAt: str
    note: Optional[str] = None


class SourceRecord(Model):
    id: str
    name: str
    url: HttpsUrl
    sourceType: Literal["official_bulk", "official_api", "official_web", "secondary_api", "curated"]
    authority: str
    retrievedAt: Optional[IsoDateTime] = None
    lastSuccessfulCheck: Optional[IsoDateTime] = None
    lastAttempt: Optional[IsoDateTime] = None
    sourcePublishedAt: Optional[str] = None
    contentHash: Optional[str] = None
    license: str
    attribution: str
    processingStatus: Literal["ok", "failed", "stale", "credential_missing", "not_run"]
    statusDetail: Optional[str] = None
    knownLimitations: List[str] = Field(default_factory=list)
    geographicCoverage: str
    temporalCoverage: str
    updateCadence: str
    recordCount: Optional[int] = None
    staleAfterDays: int = Field(default=14, gt=0)
    credentialEnv: Optional[str] = None


class Court(Model):
    id: str
    name: str
    courtType: Literal["federal_supreme", "federal_appellate", "federal_district", "state_supreme", "state_appellate", "state_trial", "other"]
    jurisdiction: str
    website: Optional[str] = None


class IssueTag(Model):
    tag: str
    ruleId: str
    matchedField: str
    matchedText: str
    #: Number of matches, recorded when the field needed more than one match.
    matchCount: Optional[int] = None


class EvidenceRef(Model):
    url: str
    #: A passage found verbatim in the document at ``url``.
    quote: Optional[str] = None
    #: Separate words or phrases that were each found in the document. Weaker than a
    #: passage: it shows what the document is about, not what it says.
    terms: Optional[List[str]] = None
    #: What the document at ``url`` is, in words a reader can weigh (a ruling, a party's filing, a bill text).
    document: Optional[str] = None
    sourceId: Optional[str] = None


class LegalEvent(Model):
    id: str
    eventType: str
    date: IsoDate  # the day the event occurred
    entityType: Literal["case", "bill", "geography"]
    entityId: str
    description: str
    significance: Literal["major", "routine"]
    classificationRule: Optional[str] = None
    evidence: EvidenceRef
    documentIds: List[str] = Field(default_factory=list)


class CourtDocument(Model):
    id: str
    caseId: str
    entryIndex: int
    title: str
    filingDate: IsoDate
    documentType: str
    url: Optional[HttpsUrl] = None
    availability: Literal["public_link", "restricted", "unavailable"]
    accessNote: Optional[str] = None


class LowerCourtInfo(Model):
    name: Optional[str] = None
    caseNumbers: List[str] = Field(default_factory=list)
    decisionDate: Optional[IsoDate] = None
    rehearingDeniedDate: Optional[IsoDate] = None


class QuestionsPresented(Model):
    url: HttpsUrl
    text: Optional[str] = None
    textHash: Optional[str] = None


class DispositiveEntry(Model):
    date: IsoDate
    text: str
    eventType: str
    ruleId: str


class LegalCaseSummary(Model):
    id: str
    externalIds: Dict[str, str]
    caseName: NonEmpty
    petitionerTitle: str
    respondentTitle: str
    docketNumber: NonEmpty
    courtId: str
    jurisdiction: str
    docketType: Optional[str] = None
    dateDocketed: Optional[IsoDate] = None
    dateFirstEntry: Optional[IsoDate] = None
    sourceLastActivity: Optional[IsoDate] = None
    entryCount: int = Field(ge=0)
    documentCount: int = Field(ge=0)
    issueTags: List[IssueTag]
    lowerCourt: LowerCourtInfo
    latestDispositiveEntry: Optional[DispositiveEntry] = None
    stateFips: List[str] = Field(default_factory=list)
    sourceUrl: HttpsUrl
    sourceId: str
    sourcePublishedAt: Optional[str] = None
    firstObservedAt: IsoDateTime
    lastCheckedAt: IsoDateTime
    verification: Verification


class LegalCase(LegalCaseSummary):
    #: As stated on the Court's docket ("Vide" dockets).
    relatedDockets: List[Dict[str, str]] = Field(default_factory=list)
    linkedNote: Optional[str] = None
    #: Other dockets in the dataset with the same lower court and a lower-court case number for the same case.
    #: Derived by rule ``same-lower-court-2``; the Court does not state it.
    sameLowerCourt: List[Dict[str, str]] = Field(default_factory=list)
    questionsPresented: Optional[QuestionsPresented] = None
    events: List[LegalEvent]
    documents: List[CourtDocument]
    contentHash: str


class LegislativeAction(Model):
    date: IsoDate
    sequence: int
    #: The Legislature's own id for the history row; it orders rows that share a date and sequence.
    historyId: Optional[str] = None
    text: str
    #: Where the measure was after the action (the official PRIMARY_LOCATION), not necessarily the body that acted.
    location: Optional[str] = None
    #: The official ACTION_STATUS when it is not "Applied", e.g. "Rescinded" or "Reconsidered".
    status: Optional[str] = None
    eventType: str
    significance: Literal["major", "routine"]
    #: Id of the pattern rule that assigned eventType (``ca-other`` when none matched).
    classificationRule: Optional[str] = None


class AffectedStatute(Model):
    action: str
    code: Optional[str] = None
    text: str


class DiffMeta(Model):
    previousVersionId: str
    blocksAdded: int
    blocksRemoved: int
    blocksUnchanged: int
    similarity: float


class LawVersion(Model):
    id: str
    instrumentId: CaBillId
    label: str
    versionDate: IsoDate
    versionNum: int
    subject: Optional[str] = None
    officialUrl: HttpsUrl
    textPath: Optional[str] = None
    textAvailability: Literal["mirrored", "link_only"]
    textHash: Optional[str] = None
    sourceHash: Optional[str] = None
    blockCount: Optional[int] = None
    wordCount: Optional[int] = None
    diff: Optional[DiffMeta] = None
    sourceMember: Optional[str] = None


class EffectiveInfo(Model):
    date: Optional[IsoDate] = None
    basis: Literal["not_verified", "immediate_effect_flag", "stated_in_text", "not_enacted", "not_applicable"]
    note: str


class TextCondition(Model):
    """A sentence in which a measure makes all or part of itself conditional (rule ``ca-cond-1``)."""

    text: str
    versionId: str
    ruleId: str


class ExpiryClause(Model):
    """A sentence in which a measure says that it, or a named part of it, remains in effect (only) until a date or
    event and is then repealed (rule ``ca-sunset-1``). It applies to the provision the sentence names, and only if
    the measure is enacted."""

    text: str
    versionId: str
    ruleId: str
    #: The date the sentence states, when it states one; ``None`` when it names an event instead.
    date: Optional[IsoDate] = None


class LegislativeStatus(Model):
    measureState: Optional[str] = None
    currentStatus: Optional[str] = None
    currentHouse: Optional[str] = None
    currentLocation: Optional[str] = None


class Chapter(Model):
    year: Optional[str] = None
    number: Optional[str] = None
    type: Optional[str] = None
    citation: Optional[str] = None


class LegislativeInstrumentSummary(Model):
    id: str
    state: Annotated[str, StringConstraints(min_length=2, max_length=2)]
    stateAbbr: Annotated[str, StringConstraints(min_length=2, max_length=2)]
    session: str
    identifier: NonEmpty
    measureType: str
    title: Optional[str] = None
    subject: Optional[str] = None
    leadAuthors: Optional[str] = None
    legislativeStatus: LegislativeStatus
    chapter: Optional[Chapter] = None
    introducedDate: Optional[IsoDate] = None
    lastActionDate: Optional[IsoDate] = None
    lastActionText: Optional[str] = None
    versionCount: int = Field(ge=0)
    issueTags: List[IssueTag]
    officialUrl: HttpsUrl
    sourceId: str
    firstObservedAt: IsoDateTime
    lastCheckedAt: IsoDateTime
    verification: Verification


class LegislativeInstrument(LegislativeInstrumentSummary):
    #: Only California records are full instruments. The summary model also carries the secondary (Open States)
    #: records, whose ids have another form, so the pattern is set here.
    id: CaBillId
    digest: Optional[str] = None
    actions: List[LegislativeAction]
    approvedDate: Optional[IsoDate] = None
    chapteredDate: Optional[IsoDate] = None
    vetoedDate: Optional[IsoDate] = None
    effective: EffectiveInfo
    #: Sentences of the latest text in which the measure makes all or part of itself conditional.
    conditions: List[TextCondition] = Field(default_factory=list)
    #: Sentences of the latest text that say a provision remains in effect (only) until a date or event and is then repealed.
    expiryClauses: List[ExpiryClause] = Field(default_factory=list)
    indicators: Dict[str, str] = Field(default_factory=dict)
    versions: List[LawVersion]
    affectedStatutes: List[AffectedStatute] = Field(default_factory=list)
    judicialNote: str
    sourcePublishedAt: Optional[str] = None
    contentHash: str


class GeographicUnit(Model):
    key: str  # "<layer>:<GEOID>", e.g. "cd120:0612"
    geoid: str
    name: str
    geoType: Literal["state", "county", "congressional_district"]
    layer: Literal["state", "county", "cd119", "cd120"]
    stateFips: str
    stateAbbr: str
    vintage: str
    sourceId: str
    bbox: List[float]
    districtCode: Optional[str] = None


class EntityRef(Model):
    type: Literal["case", "bill", "geography"]
    id: str


class RelationshipScope(Model):
    kind: Literal["statewide", "county", "congressional_district", "multi_state", "unknown"]
    note: Optional[str] = None


class EntityRelationship(Model):
    id: str
    source: EntityRef
    target: EntityRef
    relationshipType: str
    scope: RelationshipScope
    support: EvidenceRef
    basis: Literal["rule_derived", "curated"]
    ruleId: Optional[str] = None
    verification: Verification
