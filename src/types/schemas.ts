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
/**
 * The id of a measure of the U.S. Congress (us-119-hr22): the Congress, the measure type and the number. It names the
 * measure's published file too. Mirrors the pipeline's pattern (pipeline/dhq/schemas.py, UsBillId).
 */
export const US_BILL_ID_PATTERN = /^us-\d{3}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)\d{1,5}$/;
export const UsBillIdSchema = z.string().regex(US_BILL_ID_PATTERN, 'expected the id of a measure of Congress (us-<congress>-<type><number>)');
/** The id of any measure published in full: a California bill or a measure of Congress. */
export const BillIdSchema = z.string().refine((id) => CA_BILL_ID_PATTERN.test(id) || US_BILL_ID_PATTERN.test(id), 'expected the id of a California bill or of a measure of Congress');
/** A court of appeals case id (ca5-25-30725): the court and the court's own case number. Mirrors CIRCUIT_CASE_ID_PATTERN. */
export const CIRCUIT_CASE_ID_PATTERN = /^(?:ca(?:[1-9]|1[01])|cadc|cafc)-\d{2}-\d{1,6}$/;
/** A Supreme Court docket's id here (scotus-24-109). */
export const SCOTUS_CASE_ID_PATTERN = /^scotus-[0-9A-Za-z]+-[0-9A-Za-z]+$/;

export const SourceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: httpsUrl,
  sourceType: z.enum(['official_bulk', 'official_api', 'official_web', 'secondary_api', 'secondary_bulk', 'secondary_web', 'curated']),
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

/** The statute that says which states a circuit is made of, with the words relied on. */
export const CourtBasisSchema = z.object({
  citation: z.string(),
  url: httpsUrl,
  /** The statute's entry for the circuit, as it stands in the cited edition of the United States Code. */
  quote: z.string(),
  /** A second provision, for a territory that the table in section 41 does not name. */
  also: z.array(z.object({ citation: z.string(), url: httpsUrl, quote: z.string() })).nullable().optional(),
});

export const CourtSchema = z.object({
  id: z.string(),
  name: z.string(),
  courtType: z.enum(['federal_supreme', 'federal_appellate', 'federal_district', 'state_supreme', 'state_appellate', 'state_trial', 'other']),
  jurisdiction: z.string(),
  website: httpsUrl.nullable().optional(),
  /** "Fifth Circuit": the name used in lists. */
  shortName: z.string().nullable().optional(),
  /** The map unit of a regional circuit (circuit:05). The Supreme Court and the Federal Circuit have none. */
  geoKey: z.string().regex(/^circuit:[0-9A-Z]{2}$/).nullable().optional(),
  /** FIPS codes of the states and territories whose federal district courts the circuit hears appeals from. */
  states: z.array(z.string().length(2)).default([]),
  basis: CourtBasisSchema.nullable().optional(),
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

/**
 * A tag the keyword rules assigned to a court of appeals case and a maintainer took off (rule tag-removal-1): the
 * tag as the rule had assigned it, the reason, and the passage of the case's own document that shows it.
 */
export const RemovedTagSchema = IssueTagSchema.extend({
  removalRuleId: z.string(),
  reason: z.string(),
  quote: z.string(),
  quoteUrl: httpsUrl,
});
export type RemovedTag = z.infer<typeof RemovedTagSchema>;

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
  /**
   * Court of appeals decisions only: ids of documents of other cases in the dataset that have the same text, which is
   * how a court files one opinion that decides several appeals (rule same-opinion-1).
   */
  sameTextAs: z.array(z.string()).default([]),
});
export type CourtDocument = z.infer<typeof CourtDocumentSchema>;

export const DispositiveEntrySchema = z.object({
  date: isoDate,
  text: z.string(),
  eventType: z.string(),
  ruleId: z.string(),
});

/** The court a case came from, read from the opinion by rule origin-court-1. It says where the case began, not what it is about. */
export const CaseOriginSchema = z.object({
  court: z.string(),
  /** FIPS code of the state or territory the district court sits in, when the court's name gives one. */
  stateFips: z.string().length(2).nullable().optional(),
  quote: z.string(),
  documentUrl: httpsUrl,
  ruleId: z.string(),
});
export type CaseOrigin = z.infer<typeof CaseOriginSchema>;

/** Another case in the dataset that the court decided in the same opinion (rule same-opinion-1). */
export const DecidedWithSchema = z.object({ caseId: z.string(), caseName: z.string(), docket: z.string() });

/** The official texts a record's "about" line may be quoted from. */
export const ABOUT_SOURCES = ['crs-summary', 'official-title', 'digest', 'question-presented', 'cited-passage', 'docket-entry', 'opinion', 'abstract'] as const;
/**
 * What a record is about, in the words of an official text. It is a quotation taken by a published rule (about-*),
 * never a summary written for this site: `source` says which text is quoted and `url` where it is published.
 */
export const AboutTextSchema = z.object({
  text: z.string().min(20).max(700),
  source: z.enum(ABOUT_SOURCES),
  url: httpsUrl.nullable().optional(),
  /** The date of the quoted text, where it has one of its own (a summary, a docket entry, an opinion). */
  date: isoDate.nullable().optional(),
  /** True when the quotation stops inside a sentence; it is then shown with an ellipsis. */
  cut: z.boolean().default(false),
  /** For a Question Presented quoted as the first of several: how many there are. */
  of: z.number().int().min(2).nullable().optional(),
  /** For a cited passage: which document of the docket it is from, and whose words it is. */
  document: z.string().nullable().optional(),
  /**
   * For a Question Presented: the latest further question an order of the Court put to the parties, in the Court's
   * words, with the date of the order where the Court's document gives it. It is shown after the question presented.
   */
  later: z
    .object({ text: z.string().min(20).max(700), date: isoDate.nullable().optional(), cut: z.boolean().default(false) })
    .nullable()
    .optional(),
  /** For the opening of an opinion: which paragraph of the opinion is quoted, where its first could not be. */
  paragraph: z.number().int().min(2).nullable().optional(),
  ruleId: z.string(),
});
export type AboutText = z.infer<typeof AboutTextSchema>;
export const TermCountSchema = z.object({ term: z.string(), count: z.number().int() });

/**
 * Why a court of appeals case is in the dataset: the selection rule, the tests of it that the case met ("record",
 * "long", "dense", "party") and what the rule counted in the opinion it rests on.
 */
export const CaseSelectionSchema = z.object({
  ruleId: z.string(),
  tests: z.array(z.string()).min(1),
  natureOfSuitCode: z.string().nullable().optional(),
  natureOfSuit: z.string().nullable().optional(),
  documentId: z.string().nullable().optional(),
  documentUrl: httpsUrl.nullable().optional(),
  wordCount: z.number().int().nullable().optional(),
  wordMatches: z.number().int().nullable().optional(),
  phraseMatches: z.number().int().nullable().optional(),
  /** Election words per 1,000 words of the document. */
  density: z.number().nullable().optional(),
  phrases: z.array(TermCountSchema).default([]),
  /** For the "party" test: the party, or the case title, that names an election authority. */
  party: z.string().nullable().optional(),
});
export type CaseSelection = z.infer<typeof CaseSelectionSchema>;

/** The kinds of court a case of a federal district court or of a state court can be in. */
export const OTHER_COURT_TYPES = ['federal_district', 'state_supreme', 'state_appellate', 'state_trial'] as const;

/**
 * The court of a case of a federal district court or of a state court. The Supreme Court and the courts of appeals are
 * fixed in number and listed by the site itself; these courts are named on each of their cases.
 */
export const CaseCourtSchema = z.object({
  name: z.string().min(1),
  courtType: z.enum(OTHER_COURT_TYPES),
  /** The state, district or territory the court belongs to, read from its name (rule court-state-1). */
  stateFips: z.string().length(2).nullable().optional(),
  /** The court as a citation names it ("N.D. Tex."), as the source gives it. */
  citation: z.string().nullable().optional(),
  ruleId: z.string(),
});
export type CaseCourt = z.infer<typeof CaseCourtSchema>;

export const LegalCaseSummarySchema = z.object({
  id: z.string(),
  externalIds: z.record(z.string(), z.string()),
  caseName: z.string().min(1),
  petitionerTitle: z.string(),
  respondentTitle: z.string(),
  docketNumber: z.string().min(1),
  courtId: z.string(),
  /** Cases of federal district courts and of state courts only: the court, which the site does not list itself. */
  court: CaseCourtSchema.nullable().optional(),
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
  /** Court of appeals decisions only: where the appeal came from, as the opinion states it. */
  origin: CaseOriginSchema.nullable().optional(),
  /** Court of appeals decisions only: "Published" or "Unpublished", when the court's entry for the opinion says so. */
  publication: z.string().nullable().optional(),
  /** Court of appeals decisions only: the nature of suit in the court's record, when it gives one. */
  natureOfSuit: z.string().nullable().optional(),
  /** Court of appeals decisions only: other cases in the dataset decided in the same opinion. */
  decidedWith: z.array(DecidedWithSchema).default([]),
  /** What the case is about, quoted from the Question Presented, a document of the docket or the opening of the opinion. */
  about: AboutTextSchema.nullable().optional(),
  /**
   * Court of appeals decisions only: the election phrases the selection rule found most often in the opinion it rests
   * on (at most four). They show why the case is listed.
   */
  matchedTerms: z.array(TermCountSchema).optional(),
  sourceUrl: httpsUrl,
  sourceId: z.string(),
  sourcePublishedAt: z.string().nullable().optional(),
  firstObservedAt: isoDateTime,
  lastCheckedAt: isoDateTime,
  verification: VerificationSchema,
});
export type LegalCaseSummary = z.infer<typeof LegalCaseSummarySchema>;

export const LegalCaseSchema = LegalCaseSummarySchema.extend({
  /** Parties as the court's record lists them. The Supreme Court's dockets give party titles instead. */
  parties: z.array(z.object({ name: z.string(), role: z.string().nullable().optional() })).default([]),
  selection: CaseSelectionSchema.nullable().optional(),
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
  /** Tags the rules assigned and a maintainer removed, each with its reason and passage. */
  removedTags: z.array(RemovedTagSchema).default([]),
  contentHash: z.string(),
});
export type LegalCase = z.infer<typeof LegalCaseSchema>;

/** A roll-call vote that the record of a federal measure links from an action. */
export const RecordedVoteSchema = z.object({
  chamber: z.string(),
  rollNumber: z.string(),
  /** The chamber's own page for the vote (clerk.house.gov or senate.gov). */
  url: httpsUrl,
  session: z.string().nullable().optional(),
});
export type RecordedVote = z.infer<typeof RecordedVoteSchema>;

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
  /** Measures of Congress only: the action code the record gives the entry. */
  code: z.string().nullable().optional(),
  /** Measures of Congress only: who recorded the entry ("House floor actions", "Senate", "Library of Congress"). */
  source: z.string().nullable().optional(),
  /** Measures of Congress only: time of day (Eastern), which the record gives for House floor entries. */
  time: z.string().nullable().optional(),
  /** Measures of Congress only: roll-call votes the record links from the action. */
  votes: z.array(RecordedVoteSchema).default([]),
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
  instrumentId: BillIdSchema,
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

/**
 * Why a measure is in the dataset: the selection rule and the words it matched. A measure of Congress also says which
 * test of the rule it met ("named", "general" or "other") and the title the words stand in.
 */
export const BillSelectionSchema = z.object({
  ruleId: z.string(),
  matchedText: z.string(),
  matchedField: z.string(),
  test: z.string().nullable().optional(),
  matchedTitle: z.string().nullable().optional(),
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
  /** What the measure would do, quoted from its official summary, digest or title. */
  about: AboutTextSchema.nullable().optional(),
  /** Why the measure is listed: the words of its title or subject line that the selection rule matched. */
  selection: BillSelectionSchema.nullable().optional(),
  officialUrl: httpsUrl,
  sourceId: z.string(),
  firstObservedAt: isoDateTime,
  lastCheckedAt: isoDateTime,
  verification: VerificationSchema,
});
export type LegislativeInstrumentSummary = z.infer<typeof LegislativeInstrumentSummarySchema>;

/**
 * A California bill in the bill index. Its id names the bill's file, so it must match CA_BILL_ID_PATTERN. The generic
 * summary above stays open because the measures of the other state legislatures (state-legislation/) have ids of
 * another form.
 */
export const CaliforniaBillSummarySchema = LegislativeInstrumentSummarySchema.extend({ id: CaBillIdSchema });
/** A measure of Congress in the index of federal measures. Its id names the measure's file, so it must match US_BILL_ID_PATTERN. */
export const FederalBillSummarySchema = LegislativeInstrumentSummarySchema.extend({ id: UsBillIdSchema, state: z.literal('US'), stateAbbr: z.literal('US') });
/** A summary of either kind, as the lists and the search hold them. */
export const PublishedBillSummarySchema = LegislativeInstrumentSummarySchema.extend({ id: BillIdSchema });
export type PublishedBillSummary = z.infer<typeof PublishedBillSummarySchema>;

/** The state code federal measures carry in place of a state FIPS code. */
export const FEDERAL_STATE = 'US';

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

export const SponsorSchema = z.object({
  /** The member as the official record names them ("Rep. Roy, Chip [R-TX-21]"). */
  name: z.string(),
  party: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  district: z.string().nullable().optional(),
});

/** A measure that the official record of a federal measure names as related, with who identified the relation. */
export const RelatedMeasureSchema = z.object({
  identifier: z.string(),
  title: z.string().nullable().optional(),
  /** "Identical bill", "Related bill", "Procedurally related" and so on, in the record's words. */
  relationship: z.string(),
  /** Who identified it: the Congressional Research Service, the House or the Senate. */
  identifiedBy: z.string(),
  /** The measure's id here, when it is in the dataset. */
  id: UsBillIdSchema.nullable().optional(),
  officialUrl: httpsUrl.nullable().optional(),
});
export type RelatedMeasure = z.infer<typeof RelatedMeasureSchema>;

export const LegislativeInstrumentSchema = PublishedBillSummarySchema.extend({
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
  selection: BillSelectionSchema.nullable().optional(),
  // --- measures of Congress only ---
  sponsors: z.array(SponsorSchema).default([]),
  cosponsorCount: z.number().int().nonnegative().nullable().optional(),
  /** The policy area the Congressional Research Service assigned, if it has assigned one. */
  policyArea: z.string().nullable().optional(),
  /** The legislative subject terms the Congressional Research Service assigned. */
  legislativeSubjects: z.array(z.string()).default([]),
  committees: z.array(z.string()).default([]),
  /** Short titles the official record lists besides the display title. */
  shortTitles: z.array(z.string()).default([]),
  relatedMeasures: z.array(RelatedMeasureSchema).default([]),
  /** The official record the page was parsed from (the bill status file), as opposed to the page `officialUrl`. */
  sourceRecordUrl: httpsUrl.nullable().optional(),
  /** Which version of the official summary `digest` is, and its date ("Introduced in House", 2025-01-03). */
  digestVersion: z.string().nullable().optional(),
  digestDate: isoDate.nullable().optional(),
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

/**
 * The map layers. `nation` is the United States as one unit (the federal level) and `circuit` the twelve regional
 * federal judicial circuits, drawn from the state boundaries; the other four are the Census Bureau's units.
 */
export const LAYERS = ['nation', 'circuit', 'state', 'county', 'cd119', 'cd120'] as const;
export const LayerSchema = z.enum(LAYERS);
export type Layer = z.infer<typeof LayerSchema>;

const LayerInfoSchema = z.object({
  file: z.string(),
  object: z.string(),
  featureCount: z.number().int().positive(),
  sourceId: z.string(),
  vintage: z.string(),
  label: z.string(),
  geoType: z.enum(['nation', 'judicial_circuit', 'state', 'county', 'congressional_district']),
  sourcePublishedAt: z.string().nullable().optional(),
});
export type LayerInfo = z.infer<typeof LayerInfoSchema>;

/**
 * Row: [key, name, stateFips, west, south, east, north]. West may be < -180 where a unit crosses the antimeridian.
 * The nation and the judicial circuits lie in no single state, so their state code is empty.
 */
const GeoRowSchema = z.tuple([
  z.string().regex(/^(nation|circuit|state|county|cd119|cd120):[0-9A-Z]+$/),
  z.string(),
  z.string().regex(/^(?:|[0-9]{2})$/, 'expected a two-digit state code, or nothing'),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
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
    /** The parts of `cases` and `bills`. Releases made before the federal level existed do not carry them. */
    supremeCourtCases: z.number().int().optional(),
    appealsCourtCases: z.number().int().optional(),
    /** Cases of federal district courts and of state courts (decisions/). Releases made before they were read do not carry it. */
    districtAndStateCourtCases: z.number().int().optional(),
    stateBills: z.number().int().optional(),
    federalBills: z.number().int().optional(),
    /** Measures of the other state legislatures, read from Open States (state-legislation/). Not among `bills`. */
    stateLegislationBills: z.number().int().optional(),
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
  /** How an action in the record of a measure of Congress is classified: by its action code or, failing that, its text. */
  federalActionRules: z
    .array(z.object({ ruleId: z.string(), eventType: z.string(), significance: z.string(), pattern: z.string(), actionCodes: z.array(z.string()).default([]) }))
    .default([]),
  /** How a document GovInfo holds for a court of appeals case is classified, from the court's entry for it. */
  circuitDocumentRules: z
    .array(z.object({ ruleId: z.string(), eventType: z.string(), significance: z.string(), pattern: z.string(), documentType: z.string() }))
    .default([]),
  /** The rule id a tag carries when a maintainer added it. */
  curatedRuleId: z.string().optional(),
  /** Rules that are not keyword patterns: curation and selection rules, and the text-change rule. */
  otherRules: z.array(z.object({
    ruleId: z.string(),
    appliesTo: z.string(),
    description: z.string(),
    /** For the rule that names the stage of a measure of Congress: its stages, from the first to the furthest. */
    order: z.array(z.string()).optional(),
  })).default([]),
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

/** The index of measures of Congress (congress/index.json), with the selection rule as it was applied. */
export const FederalBillIndexSchema = z.object({
  bills: z.array(FederalBillSummarySchema),
  selection: z.object({
    ruleId: z.string(),
    congress: z.number().int(),
    appliedTo: z.string(),
    /** Titles that name election law ("named" test). */
    pattern: z.string(),
    /** Election words that select a measure in the policy areas of `generalAreas`. */
    generalPattern: z.string(),
    generalAreas: z.array(z.string()),
    /** Election words that select a measure in the policy areas of `otherAreas`. */
    otherPattern: z.string(),
    otherAreas: z.array(z.string()),
    /** Titles and policy areas removed before the tests are applied. */
    exclusionPattern: z.string(),
    excludedAreas: z.array(z.string()),
    /** The tests in words, by name. */
    tests: z.record(z.string(), z.string()),
    selectedByTest: z.record(z.string(), z.number().int()),
    totalMeasuresRead: z.number().int(),
  }),
});
export type FederalBillIndex = z.infer<typeof FederalBillIndexSchema>;

/**
 * A measure of a state legislature read from Open States (os-<state>-<session>-<number>, all lower-case letters and
 * digits). Mirrors STATE_MEASURE_ID_PATTERN in the pipeline's schemas.
 */
export const STATE_MEASURE_ID_PATTERN = /^os-[a-z]{2}-[a-z0-9]{1,40}-[a-z0-9]{1,40}$/;
export const StateMeasureIdSchema = z.string().regex(STATE_MEASURE_ID_PATTERN, 'expected the id of a measure of a state legislature (os-<state>-<session>-<number>)');
export const StateMeasureSummarySchema = LegislativeInstrumentSummarySchema.extend({ id: StateMeasureIdSchema, selection: BillSelectionSchema });
export type StateMeasureSummary = z.infer<typeof StateMeasureSummarySchema>;
export const StateActionSchema = z.object({ date: isoDate, text: z.string().min(1), classification: z.array(z.string()) });
export const StateVersionSchema = z.object({
  note: z.string(),
  date: isoDate.nullable().optional(),
  links: z.array(z.object({ url: httpsUrl, mediaType: z.string().nullable().optional() })).min(1),
});
/** A measure of a state legislature with what Open States records of it: its actions, sponsors and text versions. */
export const StateMeasureSchema = StateMeasureSummarySchema.extend({
  /** The subjects the legislature files the measure under, as Open States records them. */
  subjects: z.array(z.string()),
  actions: z.array(StateActionSchema),
  versions: z.array(StateVersionSchema),
  sponsors: z.array(z.object({ name: z.string().min(1), primary: z.boolean(), classification: z.string().nullable().optional() })),
  /** Every address of the legislature's pages Open States names for the measure that can be shown (rule secure-link-1). */
  sources: z.array(httpsUrl).min(1),
  openStatesId: z.string().min(1),
});
export type StateMeasure = z.infer<typeof StateMeasureSchema>;
export const StateMeasureFileSchema = z.object({ bills: z.array(StateMeasureSchema) });
/** One session of a state legislature that was read, and what came of it. */
export const StateSessionSchema = z.object({
  state: z.string().length(2),
  stateAbbr: z.string().length(2),
  identifier: z.string(),
  name: z.string(),
  classification: z.string(),
  start: isoDate.nullable().optional(),
  end: isoDate.nullable().optional(),
  measuresRead: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  listed: z.number().int().nonnegative(),
  /** Measures the rule selected that are not listed, because Open States gives no secure page of the legislature for them. */
  withoutSecureLink: z.number().int().nonnegative(),
});
export type StateSession = z.infer<typeof StateSessionSchema>;
export const StateLegislationIndexSchema = z.object({
  bills: z.array(StateMeasureSummarySchema),
  scannedAt: isoDateTime,
  sessions: z.array(StateSessionSchema),
  selection: z.object({
    ruleId: z.string(),
    statusRuleId: z.string(),
    linkRuleId: z.string(),
    appliedTo: z.string(),
    since: isoDate,
    tests: z.record(z.string(), z.string()),
    subjectPattern: z.string(),
    subjectExclusions: z.string(),
    maxSubjects: z.number().int(),
    namedPattern: z.string(),
    generalPattern: z.string(),
    exclusionPattern: z.string(),
    notLegislation: z.array(z.string()),
    ceremonialPattern: z.string(),
    resolutionCeremonialPattern: z.string(),
    stages: z.array(z.string()),
    totalMeasuresRead: z.number().int(),
    selected: z.number().int(),
    listed: z.number().int(),
    withoutSecureLink: z.number().int(),
    selectedByTest: z.record(z.string(), z.number().int()),
    notLegislationLeftOut: z.number().int(),
    leftOut: z.array(z.object({ state: z.string().length(2), stateAbbr: z.string().length(2), reason: z.string() })),
  }),
});
export type StateLegislationIndex = z.infer<typeof StateLegislationIndexSchema>;

/** What was read for one court of appeals, and what came of it. */
export const CircuitCoverageSchema = z.object({
  cases: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  /** Documents that are a clerk's cover letter and not a decision (rule cover-letter-1). */
  coverLetters: z.number().int().nonnegative(),
  unreadableDocuments: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  /** Cases the rule selects that are on the published list of exclusions. */
  excluded: z.number().int().nonnegative(),
});
export type CircuitCoverage = z.infer<typeof CircuitCoverageSchema>;

/** A case the selection rule picks that a maintainer removed, with the passage of the opinion that shows why. */
export const CircuitExclusionSchema = z.object({
  caseId: z.string(),
  caseName: z.string(),
  courtId: z.string(),
  docketNumber: z.string(),
  package: z.string(),
  reason: z.string(),
  quote: z.string(),
  documentUrl: httpsUrl,
  sourceUrl: httpsUrl,
  tests: z.array(z.string()),
  ruleId: z.string(),
  checkedAt: isoDateTime,
});
export type CircuitExclusion = z.infer<typeof CircuitExclusionSchema>;

/** The index of court of appeals cases (circuits/index.json), with the selection rule and what was read per court. */
export const CircuitIndexSchema = z.object({
  cases: z.array(LegalCaseSummarySchema),
  coverage: z.record(z.string(), CircuitCoverageSchema),
  exclusions: z.array(CircuitExclusionSchema),
  scannedAt: isoDateTime,
  selection: z.object({
    ruleId: z.string(),
    exclusionRuleId: z.string(),
    coverLetterRuleId: z.string(),
    appliedTo: z.string(),
    /** Only cases with a document issued on or after this date are read. */
    since: isoDate,
    totalCasesRead: z.number().int(),
    totalDocumentsRead: z.number().int(),
    /** The nature-of-suit code that marks a voting case in the court's record. */
    votingNatureOfSuit: z.string(),
    /** Nature-of-suit codes of other fields of law; a case with one of them is not selected by its text. */
    otherFieldCodes: z.record(z.string(), z.string()),
    wordPattern: z.string(),
    phrasePattern: z.string(),
    authorityPattern: z.string(),
    laborPattern: z.string(),
    laborMinMatches: z.number().int(),
    laborRatio: z.number(),
    coverLetterPattern: z.string(),
    /** The thresholds of the text tests, by test name. */
    textTests: z.record(z.string(), z.record(z.string(), z.number())),
  }),
});
export type CircuitIndex = z.infer<typeof CircuitIndexSchema>;

/**
 * The ledger of the court of appeals scan (circuits/scan.json): every case read, by court and case number, with the
 * values named in `fields`. The site does not display it; it is published so the count of cases read can be checked.
 */
export const CircuitScanSchema = z.object({
  ruleId: z.string(),
  scannedAt: isoDateTime,
  since: isoDate,
  fields: z.array(z.string()),
  outcomes: z.record(z.string(), z.string()),
  packages: z.record(z.string(), z.record(z.string(), z.tuple([z.string(), z.number().int(), z.number().int(), z.number().int(), z.number().int()]))),
});

/** A case id of a federal district court or state court case: "cl-" and CourtListener's number of the docket. */
export const DECISION_CASE_ID_PATTERN = /^cl-[0-9]{1,12}$/;

/** What was read for one federal district court or state court, and what came of it. */
export const DecisionCoverageSchema = z.object({
  name: z.string().min(1),
  courtType: z.enum(OTHER_COURT_TYPES),
  stateFips: z.string().length(2).nullable().optional(),
  cases: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  unreadableDocuments: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
});
export type DecisionCoverage = z.infer<typeof DecisionCoverageSchema>;

/**
 * The index of the cases of federal district courts and of state courts (decisions/index.json), with the selection
 * rule and what was read for each court. The records are made from the decisions CourtListener holds.
 */
export const DecisionIndexSchema = z.object({
  cases: z.array(LegalCaseSummarySchema),
  coverage: z.record(z.string(), DecisionCoverageSchema),
  scannedAt: isoDateTime,
  selection: z.object({
    ruleId: z.string(),
    courtStateRuleId: z.string(),
    /** The rule whose text tests are applied to a decision: the rule for the courts of appeals. */
    textRuleId: z.string(),
    appliedTo: z.string(),
    since: isoDate,
    /** The words and phrases CourtListener's search is asked for; a decision with any one of them is a candidate. */
    searchTerms: z.array(z.string()),
    /** The kinds of court read, by the code CourtListener gives a court's jurisdiction. */
    courtTypes: z.record(z.string(), z.string()),
    /** How many decisions the search returned, and how many of them were not read, by reason. */
    candidates: z.number().int(),
    skipped: z.record(z.string(), z.number().int()),
    totalCasesRead: z.number().int(),
    totalDocumentsRead: z.number().int(),
    /**
     * CourtListener limits how often its search may be asked, so the list of candidates is kept month by month: how
     * many months there are, how many have been read at all, and when the list that was read longest ago was read.
     */
    months: z.number().int().positive(),
    monthsListed: z.number().int().nonnegative(),
    oldestListingAt: isoDateTime.nullable(),
    wordPattern: z.string(),
    phrasePattern: z.string(),
    authorityPattern: z.string(),
    laborPattern: z.string(),
    laborMinMatches: z.number().int(),
    laborRatio: z.number(),
    textTests: z.record(z.string(), z.record(z.string(), z.number())),
  }),
});
export type DecisionIndex = z.infer<typeof DecisionIndexSchema>;

/** The ledger of that scan (decisions/scan.json): every case read, by CourtListener's docket number. Not displayed. */
export const DecisionScanSchema = z.object({
  ruleId: z.string(),
  scannedAt: isoDateTime,
  since: isoDate,
  query: z.string(),
  fields: z.array(z.string()),
  outcomes: z.record(z.string(), z.string()),
  candidates: z.number().int(),
  skipped: z.record(z.string(), z.number().int()),
  courts: z.record(z.string(), z.object({ name: z.string(), courtType: z.enum(OTHER_COURT_TYPES), stateFips: z.string().nullable().optional() })),
  cases: z.record(z.string(), z.tuple([z.string(), z.string(), z.number().int(), z.number().int(), z.number().int()])),
  /** The list of candidates, month by month: the next run reads only some months anew and takes the rest from here. */
  listing: z.object({
    months: z.record(z.string().regex(/^\d{4}-\d{2}$/), z.object({ listedAt: isoDateTime, candidates: z.number().int().nonnegative(), skipped: z.record(z.string(), z.number().int()) })),
    entryFields: z.array(z.string()),
    documentFields: z.array(z.string()),
    entries: z.array(z.array(z.unknown())),
  }),
});

/** The judicial circuits and the statute they are drawn from (geo/circuits.json). */
export const CircuitsFileSchema = z.object({
  courts: z.array(CourtSchema),
  statute: z.object({
    ruleId: z.string(),
    sourceId: z.string(),
    edition: z.string(),
    /** The date the cited edition says it is current through. */
    currentThrough: isoDate,
    checkedAt: isoDateTime,
    sections: z.array(z.object({ citation: z.string(), url: httpsUrl })),
  }),
  /** State FIPS code to the id of the court of appeals for its circuit. */
  circuitOfState: z.record(z.string().length(2), z.string()),
  /** States and territories on the map that are in no circuit. */
  withoutCircuit: z.array(z.string().length(2)),
  /** Places the statute names that the map does not draw. */
  notOnTheMap: z.array(z.string()),
});
export type CircuitsFile = z.infer<typeof CircuitsFileSchema>;
/**
 * A Supreme Court docket and the court of appeals case it comes from, paired by rule case-below-1: the Court's docket
 * names that court of appeals as the court below and gives the case's docket number. Neither record states the pairing
 * in so many words, so the link carries what the docket says and where.
 */
export const CaseLinkSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  /** The Supreme Court docket. */
  review: z.object({ caseId: z.string(), docket: z.string(), caseName: z.string() }),
  /** The court of appeals case. */
  below: z.object({ caseId: z.string(), docket: z.string(), caseName: z.string(), courtId: z.string() }),
  /** The court below and its case number, as the Supreme Court's docket gives them. */
  court: z.string(),
  number: z.string(),
  /** The Supreme Court's docket page, which gives both. */
  sourceUrl: httpsUrl,
});
export type CaseLink = z.infer<typeof CaseLinkSchema>;
export const RelationshipFileSchema = z.object({
  relationships: z.array(EntityRelationshipSchema),
  /** Absent from a file written before rule case-below-1 existed. */
  caseLinks: z.array(CaseLinkSchema).default([]),
});
export const EventsFileSchema = z.object({ events: z.array(TimelineEventSchema) });
export const SourcesFileSchema = z.object({ sources: z.array(SourceRecordSchema) });
export const CourtsFileSchema = z.object({ courts: z.array(CourtSchema) });

// --- who holds office (rules party-*) ---

/** The group a party label is counted with: Republican, Democratic, Independent, Nonpartisan, or another party. */
export const PARTY_GROUPS = ['R', 'D', 'I', 'N', 'O'] as const;
export type PartyGroup = (typeof PARTY_GROUPS)[number];
/** The two parties that are given a colour. */
export const ColouredPartySchema = z.enum(['R', 'D']);
export type ColouredParty = z.infer<typeof ColouredPartySchema>;

export const PartySeatsSchema = z.object({
  group: z.enum(PARTY_GROUPS),
  /** "Republican", "Democratic", "Independent", "Nonpartisan", or the source's own label for another party. */
  name: z.string().min(1),
  seats: z.number().int().min(1),
  /** The count under each label exactly as the source writes it. */
  labels: z.array(z.object({ label: z.string().min(1), seats: z.number().int().min(1) })).min(1),
});
export type PartySeats = z.infer<typeof PartySeatsSchema>;

export const ChamberSeatsSchema = z.object({
  chamber: z.enum(['upper', 'lower', 'legislature']),
  name: z.string().min(1),
  /** The members the source lists who hold a seat with a vote. */
  members: z.number().int().min(0),
  /** The number of seats, vacant ones included; null when the source lists more members than the chamber has seats. */
  seats: z.number().int().min(1).nullable(),
  vacant: z.number().int().min(0).nullable(),
  parties: z.array(PartySeatsSchema),
  /** The party the chamber is shown in the colour of (rule party-seats-1), or null. */
  lead: ColouredPartySchema.nullable(),
  leadBasis: z.enum(['seats', 'stated']),
  note: z.string().nullable(),
  sourceId: z.string().min(1),
  sourceUrl: httpsUrl,
  /** The day the source gives for its list, where it gives one. */
  asOf: isoDate.nullable(),
  checkedAt: isoDateTime,
  ruleId: z.string().min(1),
});
export type ChamberSeats = z.infer<typeof ChamberSeatsSchema>;

export const OfficeHolderSchema = z.object({
  office: z.enum(['President', 'Governor']),
  name: z.string().min(1),
  /** The party as the source writes it, and the group it is counted with. */
  party: z.string().min(1),
  group: z.enum(PARTY_GROUPS),
  termStarted: isoDate.nullable(),
  sourceId: z.string().min(1),
  sourceUrl: httpsUrl,
  checkedAt: isoDateTime,
});
export type OfficeHolder = z.infer<typeof OfficeHolderSchema>;

export const GOVERNMENT_CONTROLS = ['R', 'D', 'divided', 'undetermined'] as const;
export type GovernmentControl = (typeof GOVERNMENT_CONTROLS)[number];

export const GovernmentSchema = z.object({
  /** The key of the map unit: nation:US or state:<FIPS>. */
  id: z.string().regex(/^(?:nation:US|state:\d{2})$/),
  name: z.string().min(1),
  /** R or D: the executive and every chamber are that party's. divided: they are not. undetermined: a part has no party or no source. */
  control: z.enum(GOVERNMENT_CONTROLS),
  executive: OfficeHolderSchema.nullable(),
  executiveNote: z.string().nullable(),
  chambers: z.array(ChamberSeatsSchema),
  /** The chambers of the legislature that no source was read for. */
  missingChambers: z.array(z.enum(['upper', 'lower', 'legislature'])),
  ruleId: z.string().min(1),
});
export type Government = z.infer<typeof GovernmentSchema>;

export const GovernmentFileSchema = z.object({ generatedAt: isoDateTime, governments: z.array(GovernmentSchema) });
export type GovernmentFile = z.infer<typeof GovernmentFileSchema>;
