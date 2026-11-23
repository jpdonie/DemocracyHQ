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
#: A measure of the U.S. Congress (``us-119-hr22``): Congress, measure type and number. Mirrors
#: ``congress.BILL_ID_PATTERN`` and the zod schema's bill id.
US_BILL_ID_PATTERN = r"us-[0-9]{3}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)[0-9]{1,5}"
UsBillId = Annotated[str, StringConstraints(pattern=rf"^{US_BILL_ID_PATTERN}$")]
#: The id of any measure published in full: a California bill or a measure of Congress. It names the measure's file.
BillId = Annotated[str, StringConstraints(pattern=rf"^(?:ca-[0-9]{{8}}-[a-z]{{2,3}}[0-9]{{1,5}}|{US_BILL_ID_PATTERN})$")]
#: A court of appeals decision's case id (``ca5-25-30725``): the court and the court's own case number.
CIRCUIT_CASE_ID_PATTERN = r"(?:ca(?:[1-9]|1[01])|cadc|cafc)-[0-9]{2}-[0-9]{1,6}"
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
    sourceType: Literal["official_bulk", "official_api", "official_web", "secondary_api", "secondary_bulk", "secondary_web", "curated"]
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


class CourtBasis(Model):
    """The statute that says which states a circuit is made of, with the words relied on."""

    citation: str
    url: HttpsUrl
    #: The statute's entry for the circuit, as it stands in the cited edition of the United States Code.
    quote: str
    #: A second provision, for a territory that the table in section 41 does not name.
    also: Optional[List[Dict[str, str]]] = None


class Court(Model):
    id: str
    name: str
    courtType: Literal["federal_supreme", "federal_appellate", "federal_district", "state_supreme", "state_appellate", "state_trial", "other"]
    jurisdiction: str
    website: Optional[str] = None
    #: "Fifth Circuit": the name used in lists.
    shortName: Optional[str] = None
    #: The map unit of a regional circuit (``circuit:05``). The Supreme Court and the Federal Circuit have none.
    geoKey: Optional[str] = None
    #: FIPS codes of the states and territories whose federal district courts the circuit hears appeals from.
    states: List[str] = Field(default_factory=list)
    basis: Optional[CourtBasis] = None


class IssueTag(Model):
    tag: str
    ruleId: str
    matchedField: str
    matchedText: str
    #: Number of matches, recorded when the field needed more than one match.
    matchCount: Optional[int] = None


class RemovedTag(Model):
    """A tag a keyword rule assigned to a record and a maintainer removed, published with the record so that the removal
    can be seen and checked."""

    tag: str
    #: The rule that had assigned the tag, and what it had matched.
    ruleId: str
    matchedField: str
    matchedText: str
    matchCount: Optional[int] = None
    #: The rule the removal follows (``tag-removal-1``).
    removalRuleId: str
    reason: str
    #: A passage of the record's own document that shows what the record is about, found there on this run.
    quote: str
    quoteUrl: HttpsUrl


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
    #: Court of appeals decisions only: ids of documents of other cases in the dataset that have the same text, which
    #: is how a court files one opinion that decides several appeals. Derived by rule ``same-opinion-1``.
    sameTextAs: List[str] = Field(default_factory=list)


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


class CaseParty(Model):
    name: str
    #: The role as the court's record gives it ("Plaintiff - Appellee").
    role: Optional[str] = None


class CaseOrigin(Model):
    """The court a case came from, read from the opinion by rule ``origin-court-1``. It says where the case began,
    not what it is about."""

    court: str
    #: FIPS code of the state or territory the district court sits in, when the court's name gives one.
    stateFips: Optional[str] = None
    quote: str
    documentUrl: HttpsUrl
    ruleId: str


class TermCount(Model):
    term: str
    count: int


class LaterQuestion(Model):
    """A question an order of the Supreme Court put to the parties after the question presented, in the Court's words."""

    text: Annotated[str, StringConstraints(min_length=20, max_length=700)]
    #: The date of the order, where the Court's document gives it.
    date: Optional[IsoDate] = None
    cut: bool = False


class AboutText(Model):
    """What a record is about, in the words of an official text. It is a quotation taken by a published rule
    (:mod:`dhq.about`), never a summary written for this site."""

    text: Annotated[str, StringConstraints(min_length=20, max_length=700)]
    #: The official text quoted: the Congressional Research Service's summary, the measure's official title, the
    #: Legislative Counsel's Digest, the Question Presented, a passage cited from a document of the docket, an entry
    #: of the docket, or the opening of the opinion.
    source: Literal["crs-summary", "official-title", "digest", "question-presented", "cited-passage", "docket-entry", "opinion", "abstract"]
    #: Where the quoted text is published.
    url: Optional[HttpsUrl] = None
    #: The date of the quoted text, where it has one of its own (a summary, a docket entry, an opinion).
    date: Optional[IsoDate] = None
    #: True when the quotation stops inside a sentence; the reader is shown an ellipsis.
    cut: bool = False
    #: For a Question Presented quoted as the first of several: how many there are.
    of: Optional[int] = Field(default=None, ge=2)
    #: For a cited passage: which document of the docket it is from, and whose words it is.
    document: Optional[str] = None
    #: For a Question Presented: the latest further question an order of the Court put to the parties, where there
    #: is one. It is shown after the question presented and does not replace it.
    later: Optional[LaterQuestion] = None
    #: For the opening of an opinion: which paragraph of the opinion is quoted, where its first could not be.
    paragraph: Optional[int] = Field(default=None, ge=2)
    ruleId: str


class CaseSelection(Model):
    """Why a court of appeals case is in the dataset: the selection rule, the tests of it that the case met, and what
    the rule counted in the opinion it rests on."""

    ruleId: str
    #: The tests met: "record" (the court's record classifies the case as a voting case), and "long", "dense" or
    #: "party" (counts in an opinion).
    tests: List[str] = Field(min_length=1)
    #: Nature of suit as the court's record gives it, when it gives one ("441", "Civil Rights Voting").
    natureOfSuitCode: Optional[str] = None
    natureOfSuit: Optional[str] = None
    #: The document the counts below were taken from: the one that met a text test or, for a case selected by the
    #: record alone, the one with the most election words. None when no document of the case could be read.
    documentId: Optional[str] = None
    documentUrl: Optional[HttpsUrl] = None
    wordCount: Optional[int] = None
    #: Matches of the rule's election words in that document.
    wordMatches: Optional[int] = None
    #: Matches of the rule's election phrases in that document.
    phraseMatches: Optional[int] = None
    #: Election words per 1,000 words of the document.
    density: Optional[float] = None
    #: The phrases found, most frequent first, with their counts.
    phrases: List[TermCount] = Field(default_factory=list)
    #: For the "party" test: the party, or the case title, that names an election authority.
    party: Optional[str] = None


class CaseCourt(Model):
    """The court of a case of a federal district court or of a state court. The Supreme Court and the courts of
    appeals are fixed in number and listed by the site itself; these courts are named on each of their cases."""

    name: NonEmpty
    courtType: Literal["federal_district", "state_supreme", "state_appellate", "state_trial"]
    #: The state, district or territory the court belongs to, read from its name (rule ``court-state-1``).
    stateFips: Optional[str] = None
    #: The court as a citation names it ("N.D. Tex."), as the source gives it.
    citation: Optional[str] = None
    ruleId: str


class LegalCaseSummary(Model):
    id: str
    externalIds: Dict[str, str]
    caseName: NonEmpty
    petitionerTitle: str
    respondentTitle: str
    docketNumber: NonEmpty
    courtId: str
    #: Cases of federal district courts and of state courts only: the court, which the site does not list itself.
    court: Optional[CaseCourt] = None
    jurisdiction: str
    #: "recap" for a case of a federal district court made from its docket in the RECAP Archive (rule
    #: ``docket-select-1``) and not from decisions. The site words such a record differently.
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
    #: Court of appeals decisions only: where the appeal came from, as the opinion states it.
    origin: Optional[CaseOrigin] = None
    #: Court of appeals decisions only: "Published" or "Unpublished", when the court's entry for the opinion says so.
    publication: Optional[str] = None
    #: Court of appeals decisions and dockets of the RECAP Archive: the nature of suit in the court's record, when it
    #: gives one.
    natureOfSuit: Optional[str] = None
    #: Court of appeals decisions only: other cases in the dataset that the court decided in the same opinion.
    #: Derived by rule ``same-opinion-1`` from the texts of the opinions; the record does not state it.
    decidedWith: List[Dict[str, str]] = Field(default_factory=list)
    #: What the case is about, quoted from the Question Presented, the docket or the opening of the opinion.
    about: Optional[AboutText] = None
    #: Court of appeals decisions only: the election phrases the selection rule found most often in the opinion it
    #: rests on (at most four). They show why the case is listed; the full count is in the case's own file.
    matchedTerms: List[TermCount] = Field(default_factory=list)
    sourceUrl: HttpsUrl
    sourceId: str
    sourcePublishedAt: Optional[str] = None
    firstObservedAt: IsoDateTime
    lastCheckedAt: IsoDateTime
    verification: Verification


class LegalCase(LegalCaseSummary):
    #: Parties as the court's record lists them. The Supreme Court's dockets give party titles instead.
    parties: List[CaseParty] = Field(default_factory=list)
    selection: Optional[CaseSelection] = None
    #: As stated on the Court's docket ("Vide" dockets).
    relatedDockets: List[Dict[str, str]] = Field(default_factory=list)
    linkedNote: Optional[str] = None
    #: Other dockets in the dataset with the same lower court and a lower-court case number for the same case.
    #: Derived by rule ``same-lower-court-2``; the Court does not state it.
    sameLowerCourt: List[Dict[str, str]] = Field(default_factory=list)
    questionsPresented: Optional[QuestionsPresented] = None
    #: Tags the keyword rules assigned and a maintainer removed (rule ``tag-removal-1``).
    removedTags: List[RemovedTag] = Field(default_factory=list)
    events: List[LegalEvent]
    documents: List[CourtDocument]
    contentHash: str


class RecordedVote(Model):
    """A roll-call vote that the record of a federal measure links from an action."""

    chamber: str
    rollNumber: str
    #: The chamber's own page for the vote (clerk.house.gov or senate.gov).
    url: HttpsUrl
    #: The session of the Congress, "1" or "2".
    session: Optional[str] = None


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
    #: Id of the pattern rule that assigned eventType (``ca-other`` or ``us-other`` when none matched).
    classificationRule: Optional[str] = None
    # --- measures of Congress only -------------------------------------------------
    #: The action code the record gives the entry.
    code: Optional[str] = None
    #: Who recorded the entry: "House floor actions", "House committee actions", "Senate" or "Library of Congress".
    source: Optional[str] = None
    #: Time of day (Eastern), which the record gives for House floor entries only.
    time: Optional[str] = None
    votes: List[RecordedVote] = Field(default_factory=list)


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
    instrumentId: BillId
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


class BillSelection(Model):
    """Why a measure is in the dataset: the selection rule and the words it matched. A measure of Congress also says
    which test of the rule it met ("named", "general" or "other") and the title the words stand in."""

    ruleId: str
    matchedText: str
    matchedField: str
    test: Optional[str] = None
    matchedTitle: Optional[str] = None


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
    #: What the measure would do, quoted from its official summary, digest or title.
    about: Optional[AboutText] = None
    #: Why the measure is listed: the words of its title or subject line that the selection rule matched.
    selection: Optional[BillSelection] = None
    officialUrl: HttpsUrl
    sourceId: str
    firstObservedAt: IsoDateTime
    lastCheckedAt: IsoDateTime
    verification: Verification


class Sponsor(Model):
    #: The member as the official record names them ("Rep. Roy, Chip [R-TX-21]").
    name: str
    party: Optional[str] = None
    state: Optional[str] = None
    district: Optional[str] = None


class RelatedMeasure(Model):
    """A measure that the official record of a federal measure names as related, with who identified the relation."""

    identifier: str
    title: Optional[str] = None
    #: "Identical bill", "Related bill", "Procedurally related" and so on, in the record's words.
    relationship: str
    #: Who identified it: the Congressional Research Service, the House or the Senate.
    identifiedBy: str
    #: The measure's id here, when it is in the dataset.
    id: Optional[str] = None
    officialUrl: Optional[HttpsUrl] = None


#: A measure of a state legislature read from Open States (``os-la-2025-hb281``): the state, the session and the
#: measure's number, in lower-case letters and digits. It is unique within the published set. Mirrors
#: ``os_bulk.MEASURE_ID_PATTERN`` and the zod schema's state measure id.
STATE_MEASURE_ID_PATTERN = r"os-[a-z]{2}-[a-z0-9]{1,40}-[a-z0-9]{1,40}"
StateMeasureId = Annotated[str, StringConstraints(pattern=rf"^{STATE_MEASURE_ID_PATTERN}$")]


class StateAction(Model):
    date: IsoDate
    text: NonEmpty
    #: Open States' classification of the action ("introduction", "passage", "executive-signature", ...).
    classification: List[str]


class StateVersionLink(Model):
    url: HttpsUrl
    mediaType: Optional[str] = None


class StateVersion(Model):
    note: str
    date: Optional[IsoDate] = None
    links: List[StateVersionLink] = Field(min_length=1)


class StateSponsor(Model):
    name: NonEmpty
    primary: bool
    classification: Optional[str] = None


class StateMeasureSummary(LegislativeInstrumentSummary):
    id: StateMeasureId
    selection: BillSelection


class StateMeasure(StateMeasureSummary):
    """A measure of a state legislature as Open States records it, with its actions, sponsors and text versions."""

    #: The subjects the legislature files the measure under, as Open States records them.
    subjects: List[str]
    actions: List[StateAction]
    versions: List[StateVersion]
    sponsors: List[StateSponsor]
    #: Every address of the legislature's pages Open States names for the measure that can be shown (rule secure-link-1).
    sources: List[HttpsUrl] = Field(min_length=1)
    #: Open States' own id of the measure.
    openStatesId: NonEmpty


class LegislativeInstrument(LegislativeInstrumentSummary):
    #: Only California bills and measures of Congress are full instruments. The summary model also carries the
    #: secondary (Open States) records, whose ids have another form, so the pattern is set here.
    id: BillId
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
    # --- measures of Congress only -------------------------------------------------
    sponsors: List[Sponsor] = Field(default_factory=list)
    cosponsorCount: Optional[int] = None
    #: The policy area the Congressional Research Service assigned, if it has assigned one.
    policyArea: Optional[str] = None
    #: The legislative subject terms the Congressional Research Service assigned.
    legislativeSubjects: List[str] = Field(default_factory=list)
    committees: List[str] = Field(default_factory=list)
    #: Short titles the official record lists besides the display title.
    shortTitles: List[str] = Field(default_factory=list)
    relatedMeasures: List[RelatedMeasure] = Field(default_factory=list)
    #: The official record this page was parsed from (the bill status file), as opposed to the page ``officialUrl``.
    sourceRecordUrl: Optional[HttpsUrl] = None
    #: Which version of the official summary ``digest`` is, and its date ("Introduced in House", 2025-01-03).
    digestVersion: Optional[str] = None
    digestDate: Optional[IsoDate] = None


class GeographicUnit(Model):
    key: str  # "<layer>:<GEOID>", e.g. "cd120:0612"
    geoid: str
    name: str
    geoType: Literal["nation", "judicial_circuit", "state", "county", "congressional_district"]
    layer: Literal["nation", "circuit", "state", "county", "cd119", "cd120"]
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


class CaseLinkEnd(Model):
    caseId: str
    docket: str
    caseName: str


class CaseBelowEnd(CaseLinkEnd):
    #: The court of appeals the case is in.
    courtId: str


class CaseLink(Model):
    """A Supreme Court docket and the court of appeals case it comes from (rule ``case-below-1``).

    The Court's docket names the court below and its case number; the pairing with a case in the dataset is derived
    from those two statements and is not stated by either record.
    """

    id: str
    ruleId: str
    review: CaseLinkEnd
    below: CaseBelowEnd
    #: The court below and its case number, as the Supreme Court's docket gives them.
    court: str
    number: str
    #: The Supreme Court's docket page.
    sourceUrl: HttpsUrl


# --- who holds office (rules party-*) ---------------------------------------------

#: The group a party label is counted with: Republican, Democratic, Independent, Nonpartisan, or another party.
PartyGroup = Literal["R", "D", "I", "N", "O"]
#: The party a chamber or a government is shown in the colour of. Only these two have a colour.
ColouredParty = Literal["R", "D"]


class LabelSeats(Model):
    #: The party label exactly as the source writes it.
    label: NonEmpty
    seats: int = Field(ge=1)


class PartySeats(Model):
    """The members counted with one party (rule ``party-group-1``), and the labels they were listed under."""

    group: PartyGroup
    #: "Republican", "Democratic", "Independent", "Nonpartisan", or the source's own label for another party.
    name: NonEmpty
    seats: int = Field(ge=1)
    labels: List[LabelSeats] = Field(min_length=1)


class ChamberSeats(Model):
    """One chamber: the members a source lists, by party, and whether one party holds more than half of the seats."""

    chamber: Literal["upper", "lower", "legislature"]
    name: NonEmpty
    #: The members the source lists who hold a seat with a vote.
    members: int = Field(ge=0)
    #: The number of seats, vacant ones included. ``None`` when the source lists more members than the chamber has seats.
    seats: Optional[int] = Field(default=None, ge=1)
    vacant: Optional[int] = Field(default=None, ge=0)
    parties: List[PartySeats]
    #: The party the chamber is shown in the colour of (rule ``party-seats-1``), or ``None``.
    lead: Optional[ColouredParty] = None
    #: "seats": counted from the members listed. "stated": the source itself states the majority (the House).
    leadBasis: Literal["seats", "stated"]
    note: Optional[str] = None
    sourceId: NonEmpty
    sourceUrl: HttpsUrl
    #: The day the source gives for its list, where it gives one.
    asOf: Optional[IsoDate] = None
    #: When DemocracyHQ last read the list.
    checkedAt: IsoDateTime
    ruleId: NonEmpty


class OfficeHolder(Model):
    """The President or a governor, as a source names them."""

    office: Literal["President", "Governor"]
    name: NonEmpty
    #: The party as the source writes it, and the group it is counted with.
    party: NonEmpty
    group: PartyGroup
    #: The first day of the term the source marks as current.
    termStarted: Optional[IsoDate] = None
    sourceId: NonEmpty
    sourceUrl: HttpsUrl
    checkedAt: IsoDateTime


class Government(Model):
    """The executive and the chambers of the United States or of one state, and what rule ``party-trifecta-1`` makes of them."""

    #: The key of the map unit: ``nation:US`` or ``state:<FIPS>``.
    id: Annotated[str, StringConstraints(pattern=r"^(?:nation:US|state:[0-9]{2})$")]
    name: NonEmpty
    #: "R" or "D": the executive and every chamber are that party's. "divided": they are not. "undetermined": a part
    #: carries no party label or was not read from a source.
    control: Literal["R", "D", "divided", "undetermined"]
    executive: Optional[OfficeHolder] = None
    #: Why no executive is given, when none is.
    executiveNote: Optional[str] = None
    chambers: List[ChamberSeats]
    #: The chambers of the legislature that no source was read for, in this run or before.
    missingChambers: List[Literal["upper", "lower", "legislature"]] = Field(default_factory=list)
    ruleId: NonEmpty
