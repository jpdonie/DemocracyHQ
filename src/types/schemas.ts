/**
 * Runtime-validated data model.
 *
 * These zod schemas mirror `pipeline/dhq/schemas.py` (pydantic). The published
 * JSON is validated twice: by pydantic before publishing and by these schemas in
 * CI (`npm run data:validate`) and again in the browser when a file is loaded.
 *
 * Date semantics are deliberately separate fields and are never collapsed:
 *   date / *Date          when the event happened (court or legislature)
 *   sourcePublishedAt     when the source says it published the record
 *   firstObservedAt       when DemocracyHQ first saw the record
 *   lastCheckedAt         when DemocracyHQ last successfully retrieved it
 */
import { z } from 'zod';

export const VERIFICATION_STATUSES = [
  'verified_primary',
  'imported_secondary',
  'awaiting_review',
  'disputed',
  'outdated',
  'unavailable',
] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  /**
   * maintainer_curated: a link written by a maintainer whose quoted passage was found in the cited document. Curated
   * links published before that value existed carry rule_derived, which stays valid.
   */
  method: z.enum(['automated_primary_retrieval', 'automated_secondary_import', 'rule_derived', 'manual_review', 'maintainer_curated']),
  checkedAt: z.string(),
  note: z.string().nullable().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)');
const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'expected an ISO timestamp in UTC');
const httpsUrl = z.string().regex(/^https:\/\//, 'expected an https URL');
/**
 * A California bill id (ca-20252026-ab604). It names the bill's published file, so nothing else is accepted. Mirrors the
 * pipeline's pattern (pipeline/dhq/schemas.py, CaBillId).
 */
export const CA_BILL_ID_PATTERN = /^ca-\d{8}-[a-z]{2,3}\d{1,5}$/;
export const CaBillIdSchema = z.string().regex(CA_BILL_ID_PATTERN, 'expected a California bill id (ca-<session>-<type><number>)');

export const SourceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: httpsUrl,
  sourceType: z.enum(['official_bulk', 'official_api', 'official_web', 'secondary_api', 'curated']),
  authority: z.string(),
  retrievedAt: isoDateTime.nullable().optional(),
  lastSuccessfulCheck: isoDateTime.nullable().optional(),
  lastAttempt: isoDateTime.nullable().optional(),
  sourcePublishedAt: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  license: z.string(),
  attribution: z.string(),
  processingStatus: z.enum(['ok', 'failed', 'stale', 'credential_missing', 'not_run']),
  statusDetail: z.string().nullable().optional(),
  knownLimitations: z.array(z.string()),
  geographicCoverage: z.string(),
  temporalCoverage: z.string(),
  updateCadence: z.string(),
  recordCount: z.number().int().nullable().optional(),
  staleAfterDays: z.number().int().positive(),
  credentialEnv: z.string().nullable().optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const CourtSchema = z.object({
  id: z.string(),
  name: z.string(),
  courtType: z.enum(['federal_supreme', 'federal_appellate', 'federal_district', 'state_supreme', 'state_appellate', 'state_trial', 'other']),
  jurisdiction: z.string(),
  website: httpsUrl.nullable().optional(),
});
export type Court = z.infer<typeof CourtSchema>;

export const IssueTagSchema = z.object({
  tag: z.string(),
  ruleId: z.string(),
  matchedField: z.string(),
  matchedText: z.string(),
  /** Number of matches, present when the field needed more than one match to assign the tag. */
  matchCount: z.number().int().nullable().optional(),
});
export type IssueTag = z.infer<typeof IssueTagSchema>;

export const EvidenceRefSchema = z.object({
  url: httpsUrl,
  /** The passage relied on, as it appears in the cited document. `[…]` separates parts quoted in order. */
  quote: z.string().nullable().optional(),
  terms: z.array(z.string()).nullable().optional(),
  /** Which document the passage is from, in words (for example "the questions presented"). */
  document: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const LegalEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  date: isoDate,
  entityType: z.enum(['case', 'bill', 'geography']),
  entityId: z.string(),
  description: z.string(),
  significance: z.enum(['major', 'routine']),
  classificationRule: z.string().nullable().optional(),
  evidence: EvidenceRefSchema,
  documentIds: z.array(z.string()),
});
export type LegalEvent = z.infer<typeof LegalEventSchema>;

export const CourtDocumentSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  entryIndex: z.number().int(),
  title: z.string(),
  filingDate: isoDate,
  documentType: z.string(),
  url: httpsUrl.nullable().optional(),
  availability: z.enum(['public_link', 'restricted', 'unavailable']),
  accessNote: z.string().nullable().optional(),
});
export type CourtDocument = z.infer<typeof CourtDocumentSchema>;

export const DispositiveEntrySchema = z.object({
  date: isoDate,
  text: z.string(),
  eventType: z.string(),
  ruleId: z.string(),
});

export const LegalCaseSummarySchema = z.object({
  id: z.string(),
  externalIds: z.record(z.string(), z.string()),
  caseName: z.string().min(1),
  petitionerTitle: z.string(),
  respondentTitle: z.string(),
  docketNumber: z.string().min(1),
  courtId: z.string(),
  jurisdiction: z.string(),
  docketType: z.string().nullable().optional(),
  dateDocketed: isoDate.nullable().optional(),
  dateFirstEntry: isoDate.nullable().optional(),
  sourceLastActivity: isoDate.nullable().optional(),
  entryCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  issueTags: z.array(IssueTagSchema),
  lowerCourt: z.object({
    name: z.string().nullable().optional(),
    caseNumbers: z.array(z.string()),
    decisionDate: isoDate.nullable().optional(),
    rehearingDeniedDate: isoDate.nullable().optional(),
  }),
  latestDispositiveEntry: DispositiveEntrySchema.nullable().optional(),
  stateFips: z.array(z.string()),
  sourceUrl: httpsUrl,
  sourceId: z.string(),
  sourcePublishedAt: z.string().nullable().optional(),
  firstObservedAt: isoDateTime,
  lastCheckedAt: isoDateTime,
  verification: VerificationSchema,
});
export type LegalCaseSummary = z.infer<typeof LegalCaseSummarySchema>;

export const LegalCaseSchema = LegalCaseSummarySchema.extend({
  relatedDockets: z.array(z.record(z.string(), z.string())),
  linkedNote: z.string().nullable().optional(),
  /** Other published cases that came from the same lower-court case number. */
  sameLowerCourt: z.array(z.record(z.string(), z.string())).default([]),
  questionsPresented: z
    .object({ url: httpsUrl, text: z.string().nullable().optional(), textHash: z.string().nullable().optional() })
    .nullable()
    .optional(),
  events: z.array(LegalEventSchema),
  documents: z.array(CourtDocumentSchema),
  contentHash: z.string(),
});
export type LegalCase = z.infer<typeof LegalCaseSchema>;

export const LegislativeActionSchema = z.object({
  date: isoDate,
  sequence: z.number().int(),
  /** The legislature's id for the history row; it gives the order of rows recorded on the same day. */
  historyId: z.string().nullable().optional(),
  text: z.string(),
  /** Where the measure was after this action, in the legislature's words. */
  location: z.string().nullable().optional(),
  /** Set when the legislature later marked the action as not standing (for example "Rescinded"). */
  status: z.string().nullable().optional(),
  eventType: z.string(),
  significance: z.enum(['major', 'routine']),
  /** Id of the pattern rule that assigned eventType. */
  classificationRule: z.string().nullable().optional(),
});
export type LegislativeAction = z.infer<typeof LegislativeActionSchema>;

export const DiffMetaSchema = z.object({
  previousVersionId: z.string(),
  blocksAdded: z.number().int(),
  blocksRemoved: z.number().int(),
  blocksUnchanged: z.number().int(),
  similarity: z.number(),
});

export const LawVersionSchema = z.object({
  id: z.string(),
  instrumentId: z.string(),
  label: z.string(),
  versionDate: isoDate,
  versionNum: z.number().int(),
  subject: z.string().nullable().optional(),
  officialUrl: httpsUrl,
  textPath: z.string().nullable().optional(),
  textAvailability: z.enum(['mirrored', 'link_only']),
  textHash: z.string().nullable().optional(),
  sourceHash: z.string().nullable().optional(),
  blockCount: z.number().int().nullable().optional(),
  wordCount: z.number().int().nullable().optional(),
  diff: DiffMetaSchema.nullable().optional(),
  sourceMember: z.string().nullable().optional(),
});
export type LawVersion = z.infer<typeof LawVersionSchema>;

export const LegislativeStatusSchema = z.object({
  measureState: z.string().nullable().optional(),
  currentStatus: z.string().nullable().optional(),
  currentHouse: z.string().nullable().optional(),
  currentLocation: z.string().nullable().optional(),
});

export const ChapterSchema = z.object({
  year: z.string().nullable().optional(),
  number: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  citation: z.string().nullable().optional(),
});

export const LegislativeInstrumentSummarySchema = z.object({
  id: z.string(),
  state: z.string().length(2),
  stateAbbr: z.string().length(2),
  session: z.string(),
  identifier: z.string().min(1),
  measureType: z.string(),
  title: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  leadAuthors: z.string().nullable().optional(),
  legislativeStatus: LegislativeStatusSchema,
  chapter: ChapterSchema.nullable().optional(),
  introducedDate: isoDate.nullable().optional(),
  lastActionDate: isoDate.nullable().optional(),
  lastActionText: z.string().nullable().optional(),
  versionCount: z.number().int().nonnegative(),
  issueTags: z.array(IssueTagSchema),
  officialUrl: httpsUrl,
  sourceId: z.string(),
  firstObservedAt: isoDateTime,
  lastCheckedAt: isoDateTime,
  verification: VerificationSchema,
});
export type LegislativeInstrumentSummary = z.infer<typeof LegislativeInstrumentSummarySchema>;

/**
 * A California bill in the bill index. Its id names the bill's file, so it must match CA_BILL_ID_PATTERN. The generic
 * summary above stays open because it also describes secondary imports (legislation_secondary.json), whose ids have
 * another form.
 */
export const CaliforniaBillSummarySchema = LegislativeInstrumentSummarySchema.extend({ id: CaBillIdSchema });

export const EffectiveInfoSchema = z.object({
  date: isoDate.nullable().optional(),
  basis: z.enum(['not_verified', 'immediate_effect_flag', 'stated_in_text', 'not_enacted', 'not_applicable']),
  note: z.string(),
});

/** A sentence of the official text in which the measure makes all or part of itself conditional (rule ca-cond-1). */
export const TextConditionSchema = z.object({ text: z.string(), versionId: z.string(), ruleId: z.string() });
export type TextCondition = z.infer<typeof TextConditionSchema>;

/**
 * A sentence of the latest mirrored text saying that a provision remains in effect only until a date (or an event) and
 * is then repealed (rule ca-sunset-1). It applies to the provision the sentence names, and only if the measure is
 * enacted. `date` is the date the sentence states, when it states one.
 */
export const ExpiryClauseSchema = z.object({ text: z.string(), versionId: z.string(), ruleId: z.string(), date: isoDate.nullable().optional() });
export type ExpiryClause = z.infer<typeof ExpiryClauseSchema>;

export const LegislativeInstrumentSchema = CaliforniaBillSummarySchema.extend({
  digest: z.string().nullable().optional(),
  actions: z.array(LegislativeActionSchema),
  approvedDate: isoDate.nullable().optional(),
  chapteredDate: isoDate.nullable().optional(),
  vetoedDate: isoDate.nullable().optional(),
  effective: EffectiveInfoSchema,
  conditions: z.array(TextConditionSchema).default([]),
  expiryClauses: z.array(ExpiryClauseSchema).default([]),
  indicators: z.record(z.string(), z.string()),
  versions: z.array(LawVersionSchema),
  affectedStatutes: z.array(z.object({ action: z.string(), code: z.string().nullable().optional(), text: z.string() })),
  judicialNote: z.string(),
  sourcePublishedAt: z.string().nullable().optional(),
  contentHash: z.string(),
  selection: z.object({ ruleId: z.string(), matchedText: z.string(), matchedField: z.string() }).optional(),
});
export type LegislativeInstrument = z.infer<typeof LegislativeInstrumentSchema>;

/** One mirrored official text version. Blocks are `[kind, text]`: p paragraph, s section label, a amending clause, h heading. */
export const VersionTextSchema = z.object({
  versionId: z.string(),
  instrumentId: z.string(),
  label: z.string(),
  versionDate: isoDate,
  title: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  digest: z.array(z.string()).nullable().optional(),
  blocks: z.array(z.tuple([z.enum(['p', 's', 'a', 'h']), z.string()])),
  textHash: z.string(),
  officialUrl: httpsUrl,
  sourceId: z.string(),
});
export type VersionText = z.infer<typeof VersionTextSchema>;
export type TextBlock = VersionText['blocks'][number];

export const EntityRefSchema = z.object({ type: z.enum(['case', 'bill', 'geography']), id: z.string() });
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const EntityRelationshipSchema = z.object({
  id: z.string(),
  source: EntityRefSchema,
  target: EntityRefSchema,
  relationshipType: z.string(),
  scope: z.object({
    kind: z.enum(['statewide', 'county', 'congressional_district', 'multi_state', 'unknown']),
    note: z.string().nullable().optional(),
  }),
  support: EvidenceRefSchema,
  basis: z.enum(['rule_derived', 'curated']),
  ruleId: z.string().nullable().optional(),
  verification: VerificationSchema,
});
export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>;

export const LAYERS = ['state', 'county', 'cd119', 'cd120'] as const;
export const LayerSchema = z.enum(LAYERS);
export type Layer = z.infer<typeof LayerSchema>;

const LayerInfoSchema = z.object({
  file: z.string(),
  object: z.string(),
  featureCount: z.number().int().positive(),
  sourceId: z.string(),
  vintage: z.string(),
  label: z.string(),
  geoType: z.enum(['state', 'county', 'congressional_district']),
  sourcePublishedAt: z.string().nullable().optional(),
});
export type LayerInfo = z.infer<typeof LayerInfoSchema>;

/** Row: [key, name, stateFips, west, south, east, north]. West may be < -180 where a unit crosses the antimeridian. */
const GeoRowSchema = z.tuple([z.string().regex(/^(state|county|cd119|cd120):[0-9A-Z]+$/), z.string(), z.string().length(2), z.number(), z.number(), z.number(), z.number()]);
export const GeoIndexSchema = z.object({
  fields: z.array(z.string()),
  layers: z.record(LayerSchema, LayerInfoSchema),
  rows: z.array(GeoRowSchema),
});
export type GeoIndexFile = z.infer<typeof GeoIndexSchema>;

export const CountyCdSchema = z.object({
  sourceId: z.string(),
  description: z.string(),
  /** [county GEOID, district GEOID, land area m², water area m²]. The areas are the Bureau's own, for the part. */
  pairs: z.array(z.tuple([z.string().length(5), z.string().length(4)], z.number().int().nonnegative())),
});

export const PopulationFileSchema = z.object({
  dataset: z.object({
    id: z.string(),
    title: z.string(),
    censusYear: z.number().int(),
    sourceId: z.string(),
    tables: z.string(),
    geographyNote: z.string(),
    sourcePublishedAt: z.string().nullable().optional(),
    methodology: z.string(),
  }),
  variables: z.array(z.object({ key: z.string(), code: z.string(), label: z.string(), universe: z.string() })),
  rows: z.record(z.string(), z.array(z.number().int().nonnegative())),
});
export type PopulationFile = z.infer<typeof PopulationFileSchema>;

export const RedistrictingFileSchema = z.object({
  congress120: z.object({
    statesWithNewBoundaries: z.array(z.string().length(2)),
    quote: z.string(),
    /** The Bureau's sentence that every other state is unchanged; 119th Congress counts are carried over on its strength. */
    unchangedQuote: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    sourceId: z.string(),
    sourceUrl: httpsUrl,
    checkedAt: isoDateTime,
  }),
  districtCounts: z.object({ cd119: z.record(z.string(), z.number().int()), cd120: z.record(z.string(), z.number().int()) }),
  /** Safeguard for carrying 119th Congress counts onto 120th Congress districts. */
  areaCheck: z
    .object({
      method: z.string(),
      tolerance: z.number(),
      compared: z.number().int(),
      largestRelativeDifference: z.number(),
      mismatches: z.array(z.string()),
      redrawnStatesWithDifferingAreas: z.array(z.string()),
    })
    .optional(),
  populationAvailability: z.object({ cd119: z.string(), cd120: z.string() }),
});
export type RedistrictingFile = z.infer<typeof RedistrictingFileSchema>;

export const EVENT_CATEGORIES = ['litigation', 'legislation', 'geography'] as const;
export const TimelineEventSchema = z.object({
  id: z.string(),
  date: isoDate,
  category: z.enum(EVENT_CATEGORIES),
  eventType: z.string(),
  entityType: z.enum(['case', 'bill', 'geography']),
  entityId: z.string(),
  entityLabel: z.string(),
  description: z.string(),
  sourceUrl: httpsUrl,
  geoKeys: z.array(z.string()),
  ruleId: z.string().nullable().optional(),
  /**
   * For a bill's action: the official subject line of the latest text version dated before the action, or null when
   * none is, or when a version is dated the same day (the record then does not say which text the action concerned).
   * The site compares it with the bill's current subject line (src/lib/billHistory.ts). Older releases do not carry it.
   */
  subjectInForce: z.string().nullable().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const ManifestSchema = z.object({
  schemaVersion: z.number().int(),
  generatedAt: isoDateTime,
  counts: z.object({
    cases: z.number().int(),
    bills: z.number().int(),
    relationships: z.number().int(),
    events: z.number().int(),
    geographicUnits: z.number().int(),
  }),
  reviewQueue: z.object({ items: z.number().int(), byKind: z.record(z.string(), z.number().int()) }),
  sources: z.record(
    z.string(),
    z.object({
      processingStatus: SourceRecordSchema.shape.processingStatus,
      lastSuccessfulCheck: isoDateTime.nullable().optional(),
      lastAttempt: isoDateTime.nullable().optional(),
    }),
  ),
  contentHash: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ClassificationFileSchema = z.object({
  issueRules: z.array(z.object({ tag: z.string(), label: z.string(), ruleId: z.string(), pattern: z.string() })),
  note: z.string(),
  docketEntryRules: z.array(
    z.object({ ruleId: z.string(), eventType: z.string(), significance: z.string(), rulesOn: z.string().nullable().optional(), pattern: z.string() }),
  ),
  legislativeActionRules: z.array(z.object({ ruleId: z.string(), eventType: z.string(), significance: z.string(), pattern: z.string() })),
  /** Rules that are not keyword patterns: curation and selection rules, and the text-change rule. */
  otherRules: z.array(z.object({ ruleId: z.string(), appliesTo: z.string(), description: z.string() })).default([]),
});
export type ClassificationFile = z.infer<typeof ClassificationFileSchema>;

export const CaseIndexSchema = z.object({ cases: z.array(LegalCaseSummarySchema) });
export const BillIndexSchema = z.object({
  bills: z.array(CaliforniaBillSummarySchema),
  selection: z.object({
    ruleId: z.string(),
    pattern: z.string(),
    /** Subjects removed before the pattern is applied. */
    exclusionPattern: z.string().nullable().optional(),
    appliedTo: z.string(),
    totalBillsInSession: z.number().int(),
  }),
});
export type BillIndex = z.infer<typeof BillIndexSchema>;
export const RelationshipFileSchema = z.object({ relationships: z.array(EntityRelationshipSchema) });
export const EventsFileSchema = z.object({ events: z.array(TimelineEventSchema) });
export const SourcesFileSchema = z.object({ sources: z.array(SourceRecordSchema) });
export const CourtsFileSchema = z.object({ courts: z.array(CourtSchema) });
