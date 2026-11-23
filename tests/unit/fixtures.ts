/**
 * SYNTHETIC TEST FIXTURES. NOT REAL RECORDS.
 *
 * Everything built here is invented for unit tests: the case names, docket numbers,
 * bill numbers, counts and URLs do not describe any real court case, bill or place.
 * The host `example.test` is reserved for testing and can never resolve. Nothing in
 * this file is imported by the application or copied into `public/data`.
 */
import type {
  CircuitIndex, CircuitsFile, Court, DecisionIndex, EntityRelationship, FederalBillIndex, GeoIndexFile, LegalCase, LegalCaseSummary, LegislativeInstrument,
  LegislativeInstrumentSummary, Manifest, PopulationFile, RedistrictingFile, SourceRecord, StateLegislationIndex, StateMeasureSummary, TimelineEvent, VersionText,
} from '../../src/types/schemas';

export const NOW = '2026-06-15T12:00:00Z';
export const SYNTHETIC_HOST = 'https://example.test';

export function makeSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'synthetic-court',
    name: 'Synthetic Court Docket Feed',
    url: `${SYNTHETIC_HOST}/court`,
    sourceType: 'official_web',
    authority: 'Synthetic authority',
    retrievedAt: '2026-06-14T10:00:00Z',
    lastSuccessfulCheck: '2026-06-14T10:00:00Z',
    lastAttempt: '2026-06-14T10:00:00Z',
    sourcePublishedAt: null,
    contentHash: null,
    license: 'Synthetic licence',
    attribution: 'Synthetic attribution',
    processingStatus: 'ok',
    statusDetail: null,
    knownLimitations: [],
    geographicCoverage: 'Nowhere (synthetic)',
    temporalCoverage: 'Never (synthetic)',
    updateCadence: 'Never (synthetic)',
    recordCount: 2,
    staleAfterDays: 7,
    credentialEnv: null,
    ...overrides,
  };
}

export function makeCase(overrides: Partial<LegalCaseSummary> = {}): LegalCaseSummary {
  return {
    id: 'synthetic-case-1',
    externalIds: {},
    caseName: 'Synthetic Alpha v. Synthetic Beta',
    petitionerTitle: 'Synthetic Alpha, Petitioner',
    respondentTitle: 'Synthetic Beta',
    docketNumber: '99-0001',
    courtId: 'scotus', // a Supreme Court docket; makeAppealsCase gives a case of a court of appeals
    jurisdiction: 'federal',
    docketType: null,
    dateDocketed: '2026-01-10',
    dateFirstEntry: '2026-01-05',
    sourceLastActivity: '2026-03-01',
    entryCount: 3,
    documentCount: 1,
    issueTags: [{ tag: 'redistricting', ruleId: 'tag-synthetic-1', matchedField: 'questions presented', matchedText: 'congressional districts' }],
    lowerCourt: { name: 'Synthetic District Court', caseNumbers: ['1:25-cv-00001'], decisionDate: null, rehearingDeniedDate: null },
    latestDispositiveEntry: { date: '2026-03-01', text: 'Petition DENIED.', eventType: 'cert_denied', ruleId: 'entry-synthetic-1' },
    stateFips: ['06'],
    decidedWith: [],
    sourceUrl: `${SYNTHETIC_HOST}/court/99-0001`,
    sourceId: 'synthetic-court',
    sourcePublishedAt: null,
    firstObservedAt: '2026-01-11T00:00:00Z',
    lastCheckedAt: '2026-06-14T10:00:00Z',
    verification: { status: 'verified_primary', method: 'automated_primary_retrieval', checkedAt: '2026-06-14T10:00:00Z', note: null },
    ...overrides,
  };
}

export function makeFullCase(overrides: Partial<LegalCase> = {}): LegalCase {
  return {
    ...makeCase(),
    relatedDockets: [],
    linkedNote: null,
    sameLowerCourt: [],
    questionsPresented: { url: `${SYNTHETIC_HOST}/court/99-0001/qp.pdf`, text: 'Whether a synthetic question can be presented.', textHash: null },
    events: [
      {
        id: 'synthetic-case-1:e1', eventType: 'petition_filed', date: '2026-01-05', entityType: 'case', entityId: 'synthetic-case-1',
        description: 'Petition for a writ of certiorari filed.', significance: 'major', classificationRule: 'entry-synthetic-0',
        evidence: { url: `${SYNTHETIC_HOST}/court/99-0001`, quote: null, sourceId: 'synthetic-court' }, documentIds: ['synthetic-case-1:d1'],
      },
      {
        id: 'synthetic-case-1:e2', eventType: 'other', date: '2026-02-01', entityType: 'case', entityId: 'synthetic-case-1',
        description: 'Waiver of right of respondent to respond filed.', significance: 'routine', classificationRule: null,
        evidence: { url: `${SYNTHETIC_HOST}/court/99-0001`, quote: null, sourceId: 'synthetic-court' }, documentIds: [],
      },
      {
        id: 'synthetic-case-1:e3', eventType: 'cert_denied', date: '2026-03-01', entityType: 'case', entityId: 'synthetic-case-1',
        description: 'Petition DENIED.', significance: 'major', classificationRule: 'entry-synthetic-1',
        evidence: { url: `${SYNTHETIC_HOST}/court/99-0001`, quote: null, sourceId: 'synthetic-court' }, documentIds: [],
      },
    ],
    documents: [
      {
        id: 'synthetic-case-1:d1', caseId: 'synthetic-case-1', entryIndex: 0, title: 'Petition', filingDate: '2026-01-05',
        documentType: 'petition', url: `${SYNTHETIC_HOST}/court/99-0001/petition.pdf`, availability: 'public_link', accessNote: null, sameTextAs: [],
      },
    ],
    parties: [],
    removedTags: [],
    contentHash: 'synthetic',
    ...overrides,
  };
}

const APPEAL_OPINION = `${SYNTHETIC_HOST}/appeals/99-00001/opinion.pdf`;

/**
 * A case of a court of appeals as circuits/index.json lists it: decided by the Ninth Circuit on an appeal from a
 * district court in California. Its record holds one document, the opinion, and no docket.
 */
export function makeAppealsCase(overrides: Partial<LegalCaseSummary> = {}): LegalCaseSummary {
  return makeCase({
    id: 'ca9-99-00001',
    externalIds: { govinfoPackage: 'USCOURTS-ca9-99-00001' },
    caseName: 'Synthetic Voters League v. Synthetic Registrar',
    petitionerTitle: '',
    respondentTitle: '',
    docketNumber: '99-00001',
    courtId: 'ca9',
    jurisdiction: 'Federal',
    dateDocketed: null,
    dateFirstEntry: '2026-02-03',
    sourceLastActivity: '2026-02-03',
    entryCount: 1,
    documentCount: 1,
    issueTags: [{ tag: 'voter-id', ruleId: 'tag-synthetic-3', matchedField: 'full text of the opinion', matchedText: 'voter identification', matchCount: 7 }],
    lowerCourt: { name: null, caseNumbers: [], decisionDate: null, rehearingDeniedDate: null },
    latestDispositiveEntry: { date: '2026-02-03', text: 'Opinion issued by court. Decision: Affirmed. Opinion type: Published.', eventType: 'opinion', ruleId: 'ca-doc-opinion' },
    stateFips: [],
    origin: {
      court: 'United States District Court for the Synthetic District of California', stateFips: '06',
      quote: 'Appeal from the United States District Court for the Synthetic District of California', documentUrl: APPEAL_OPINION, ruleId: 'origin-synthetic-1',
    },
    publication: 'Published',
    natureOfSuit: 'Civil Rights Voting',
    sourceUrl: `${SYNTHETIC_HOST}/appeals/99-00001`,
    sourceId: 'synthetic-appeals',
    ...overrides,
  });
}

/** The record of that case: its parties, why the selection rule picked it, and the opinion. */
export function makeFullAppealsCase(overrides: Partial<LegalCase> = {}): LegalCase {
  return {
    ...makeAppealsCase(),
    parties: [{ name: 'Synthetic Voters League', role: 'Appellant' }, { name: 'Synthetic Registrar', role: 'Appellee' }],
    selection: {
      ruleId: 'circuit-select-synthetic', tests: ['nature of suit'], natureOfSuitCode: '441', natureOfSuit: 'Civil Rights Voting',
      documentId: 'ca9-99-00001-d0', documentUrl: APPEAL_OPINION, wordCount: 4000, wordMatches: 80, phraseMatches: 12, density: 20,
      phrases: [{ term: 'voter identification', count: 7 }], party: null,
    },
    relatedDockets: [],
    linkedNote: null,
    sameLowerCourt: [],
    questionsPresented: null,
    events: [
      {
        id: 'ca9-99-00001:e0', eventType: 'opinion', date: '2026-02-03', entityType: 'case', entityId: 'ca9-99-00001',
        description: 'Opinion issued by court. Decision: Affirmed. Opinion type: Published.', significance: 'major', classificationRule: 'ca-doc-opinion',
        evidence: { url: APPEAL_OPINION, quote: null, sourceId: 'synthetic-appeals' }, documentIds: ['ca9-99-00001-d0'],
      },
    ],
    documents: [
      {
        id: 'ca9-99-00001-d0', caseId: 'ca9-99-00001', entryIndex: 0, title: 'Opinion of 2026-02-03', filingDate: '2026-02-03',
        documentType: 'Opinion', url: APPEAL_OPINION, availability: 'public_link', accessNote: 'Hosted by example.test; linked, not mirrored.', sameTextAs: [],
      },
    ],
    removedTags: [],
    contentHash: 'synthetic',
    ...overrides,
  };
}

const COURT = (id: string, shortName: string, geoKey: string | null, states: string[]): Court => ({
  id, name: `United States Court of Appeals for the ${shortName}`, courtType: 'federal_appellate', jurisdiction: 'Federal',
  website: `${SYNTHETIC_HOST}/${id}`, shortName, geoKey, states,
  basis: geoKey ? { citation: '28 U.S.C. § 41 (synthetic)', url: `${SYNTHETIC_HOST}/statute/sec41`, quote: `Synthetic composition of the ${shortName}.`, also: null } : null,
});

/** The courts of appeals of the tiny map: California in the Ninth Circuit, Texas in the Fifth, the Virgin Islands in the Third. */
export function makeCircuitsFile(): CircuitsFile {
  return {
    courts: [
      COURT('ca3', 'Third Circuit', 'circuit:03', ['78']),
      COURT('ca5', 'Fifth Circuit', 'circuit:05', ['48']),
      COURT('ca9', 'Ninth Circuit', 'circuit:09', ['06']),
      COURT('cafc', 'Federal Circuit', null, []),
    ],
    statute: {
      ruleId: 'circuit-composition-synthetic', sourceId: 'synthetic-code', edition: 'Synthetic Code, 2024 Edition', currentThrough: '2025-01-06',
      checkedAt: '2026-06-14T10:00:00Z', sections: [{ citation: '28 U.S.C. § 41 (synthetic)', url: `${SYNTHETIC_HOST}/statute/sec41` }],
    },
    circuitOfState: { '06': 'ca9', '48': 'ca5', '78': 'ca3' },
    withoutCircuit: [],
    notOnTheMap: [],
  };
}

/** circuits/index.json with the cases given; what was read is invented and the Federal Circuit has no selected case. */
export function makeCircuitIndexFile(cases: LegalCaseSummary[] = [makeAppealsCase()]): CircuitIndex {
  const read = (id: string) => ({ cases: 40, documents: 42, coverLetters: 1, unreadableDocuments: 0, selected: cases.filter((c) => c.courtId === id).length, excluded: 0 });
  return {
    cases,
    coverage: { ca3: read('ca3'), ca5: read('ca5'), ca9: read('ca9'), cafc: read('cafc') },
    exclusions: [],
    scannedAt: '2026-06-14T10:00:00Z',
    selection: {
      ruleId: 'circuit-select-synthetic', exclusionRuleId: 'circuit-exclusion-synthetic', coverLetterRuleId: 'cover-letter-synthetic',
      appliedTo: 'every synthetic case', since: '2025-01-01', totalCasesRead: 160, totalDocumentsRead: 168, votingNatureOfSuit: '441',
      otherFieldCodes: {}, wordPattern: 'x', phrasePattern: 'x', authorityPattern: 'x', laborPattern: 'x', laborMinMatches: 10, laborRatio: 4,
      coverLetterPattern: 'x', textTests: {},
    },
  };
}

const DECISION_FILE = 'https://storage.courtlistener.com/pdf/2026/03/02/synthetic_voters_v._synthetic_parish.pdf';

/**
 * A case of a state court as decisions/index.json lists it: decided by the highest court of Louisiana and known from
 * the one decision CourtListener holds for it. The record names its court itself, because the site keeps no list of
 * the courts of the states.
 */
export function makeDecisionCase(overrides: Partial<LegalCaseSummary> = {}): LegalCaseSummary {
  return makeCase({
    id: 'cl-9000001',
    externalIds: { courtlistenerDocketId: '9000001', courtlistenerClusterIds: '8000001' },
    caseName: 'Synthetic Voters v. Synthetic Parish Board of Election Supervisors',
    petitionerTitle: '',
    respondentTitle: '',
    docketNumber: '2026-C-00001',
    courtId: 'la',
    court: { name: 'Supreme Court of Louisiana', courtType: 'state_supreme', stateFips: '22', citation: 'La.', ruleId: 'court-state-synthetic' },
    jurisdiction: 'State',
    dateDocketed: null,
    dateFirstEntry: '2026-03-02',
    sourceLastActivity: '2026-03-02',
    entryCount: 1,
    documentCount: 1,
    issueTags: [{ tag: 'mail-voting', ruleId: 'tag-synthetic-4', matchedField: 'full text of the opinion', matchedText: 'absentee ballots', matchCount: 9 }],
    lowerCourt: { name: null, caseNumbers: [], decisionDate: null, rehearingDeniedDate: null },
    latestDispositiveEntry: { date: '2026-03-02', text: 'Opinion, published', eventType: 'opinion', ruleId: 'cl-doc-opinion' },
    stateFips: [],
    publication: 'Published',
    matchedTerms: [{ term: 'absentee ballots', count: 9 }],
    sourceUrl: 'https://www.courtlistener.com/opinion/8000001/synthetic-voters-v-synthetic-parish/',
    sourceId: 'synthetic-courtlistener',
    verification: { status: 'imported_secondary', method: 'automated_secondary_import', checkedAt: '2026-06-14T10:00:00Z', note: 'Read from the copy CourtListener holds. Not reviewed by a lawyer.' },
    ...overrides,
  });
}

/** The same kind of record for a federal district court, which sits in Texas. */
export function makeDistrictCase(overrides: Partial<LegalCaseSummary> = {}): LegalCaseSummary {
  return makeDecisionCase({
    id: 'cl-9000002',
    externalIds: { courtlistenerDocketId: '9000002', courtlistenerClusterIds: '8000002' },
    caseName: 'Synthetic League v. Synthetic Secretary of State',
    docketNumber: '4:26-cv-00002',
    courtId: 'txnd',
    court: { name: 'United States District Court for the Northern District of Texas', courtType: 'federal_district', stateFips: '48', citation: 'N.D. Tex.', ruleId: 'court-state-synthetic' },
    jurisdiction: 'Federal',
    issueTags: [{ tag: 'voter-id', ruleId: 'tag-synthetic-3', matchedField: 'full text of the opinion', matchedText: 'voter identification', matchCount: 8 }],
    publication: null,
    latestDispositiveEntry: { date: '2026-03-02', text: 'Opinion', eventType: 'opinion', ruleId: 'cl-doc-opinion' },
    sourceUrl: 'https://www.courtlistener.com/opinion/8000002/synthetic-league-v-synthetic-secretary/',
    ...overrides,
  });
}

/** The record of the state court case: the decision CourtListener holds and why the selection rule picked the case. */
export function makeFullDecisionCase(overrides: Partial<LegalCase> = {}): LegalCase {
  const summary = makeDecisionCase();
  return {
    ...makeFullCase(),
    ...summary,
    questionsPresented: null,
    parties: [],
    removedTags: [],
    selection: {
      ruleId: 'court-select-synthetic', tests: ['dense'], documentId: 'cl-9000001-d1', documentUrl: DECISION_FILE,
      wordCount: 4200, wordMatches: 31, phraseMatches: 12, density: 7.4, phrases: [{ term: 'absentee ballots', count: 9 }], party: null,
      natureOfSuit: null, natureOfSuitCode: null,
    },
    events: [{
      id: 'cl-9000001-e1', eventType: 'opinion', date: '2026-03-02', entityType: 'case', entityId: 'cl-9000001', description: 'Opinion, published',
      significance: 'major', classificationRule: 'cl-doc-opinion', documentIds: ['cl-9000001-d1'],
      evidence: { url: DECISION_FILE, sourceId: 'synthetic-courtlistener', document: 'the copy of the court’s decision that CourtListener holds' },
    }],
    documents: [{
      id: 'cl-9000001-d1', caseId: 'cl-9000001', entryIndex: 1, title: 'Opinion of 2026-03-02', filingDate: '2026-03-02', documentType: 'Opinion',
      url: DECISION_FILE, availability: 'public_link', accessNote: 'The copy CourtListener holds, which is the file that was read. Linked, not mirrored.', sameTextAs: [],
    }],
    ...overrides,
  } as LegalCase;
}

/** decisions/index.json with the cases given; what was read is invented. */
const RECAP_FILE = 'https://storage.courtlistener.com/recap/gov.uscourts.gand.900/gov.uscourts.gand.900.1.0.pdf';

/** A voting case of a federal district court as its list entry gives it when it is read from its docket in the RECAP Archive. */
export function makeDocketCase(overrides: Partial<LegalCaseSummary> = {}): LegalCaseSummary {
  return makeDistrictCase({
    id: 'cl-9000900',
    externalIds: { courtlistenerDocketId: '9000900' },
    caseName: 'Synthetic Voters v. Synthetic Registrar',
    docketNumber: '1:26-cv-00900',
    courtId: 'gand',
    court: { name: 'United States District Court for the Northern District of Georgia', courtType: 'federal_district', stateFips: '13', citation: 'N.D. Ga.', ruleId: 'court-state-synthetic' },
    docketType: 'recap',
    dateDocketed: '2026-03-02',
    dateFirstEntry: '2026-03-02',
    sourceLastActivity: '2026-03-09',
    entryCount: 2,
    documentCount: 1,
    issueTags: [],
    latestDispositiveEntry: null,
    natureOfSuit: '441 Civil Rights: Voting',
    matchedTerms: [],
    sourceUrl: 'https://www.courtlistener.com/docket/9000900/synthetic-voters-v-synthetic-registrar/',
    sourcePublishedAt: '2026-03-10T08:00:00.000000Z',
    ...overrides,
  });
}

/** The record of that case: the entries of the docket the archive holds, and the one filing it has a copy of. */
export function makeFullDocketCase(overrides: Partial<LegalCase> = {}): LegalCase {
  const summary = makeDocketCase();
  const entry = (n: number, date: string, description: string, documentIds: string[]) => ({
    id: `cl-9000900-e${n}`, eventType: 'docket_entry', date, entityType: 'case' as const, entityId: 'cl-9000900', description,
    significance: 'routine' as const, classificationRule: 'recap-entry-1', documentIds,
    evidence: { url: summary.sourceUrl, sourceId: 'synthetic-courtlistener', document: 'The docket as the RECAP Archive holds it' },
  });
  return {
    ...makeFullCase(),
    ...summary,
    questionsPresented: null,
    parties: [],
    removedTags: [],
    selection: {
      ruleId: 'docket-select-2', tests: ['record'], natureOfSuitCode: '441', natureOfSuit: 'Civil Rights: Voting', documentId: null, documentUrl: null,
      wordCount: null, wordMatches: null, phraseMatches: null, density: null, phrases: [], party: null,
    },
    events: [
      entry(1, '2026-03-02', '1. COMPLAINT against Synthetic Registrar, filed by Synthetic Voters.', ['cl-9000900-d1']),
      entry(2, '2026-03-09', '2. ORDER setting a hearing on the motion for a preliminary injunction.', []),
    ],
    documents: [{
      id: 'cl-9000900-d1', caseId: 'cl-9000900', entryIndex: 0, title: 'Document 1: Complaint', filingDate: '2026-03-02', documentType: 'Filing',
      url: RECAP_FILE, availability: 'public_link', accessNote: 'CourtListener’s copy of the filing, from the RECAP Archive. Not fetched from the court.', sameTextAs: [],
    }],
    ...overrides,
  };
}

/** What decisions/index.json says about the dockets read from the RECAP Archive. */
export function makeDocketListing(overrides: Partial<NonNullable<DecisionIndex['dockets']>> = {}): NonNullable<DecisionIndex['dockets']> {
  return {
    ruleId: 'docket-select-2', entryRuleId: 'recap-entry-1', courtStateRuleId: 'court-state-synthetic', since: '2025-01-01', query: 'suitNature:"441" OR suitNature:voting',
    natureOfSuitCode: '441', listed: 180, listedAt: '2026-06-14T10:00:00Z', published: 150, waiting: 30, readInThisRun: 12, ...overrides,
  };
}

export function makeDecisionIndexFile(cases: LegalCaseSummary[] = [makeDecisionCase(), makeDistrictCase()]): DecisionIndex {
  const coverage: DecisionIndex['coverage'] = {};
  for (const record of cases) {
    if (!record.court) continue;
    const row = coverage[record.courtId] ?? { name: record.court.name, courtType: record.court.courtType, stateFips: record.court.stateFips, cases: 30, documents: 33, unreadableDocuments: 1, selected: 0 };
    coverage[record.courtId] = { ...row, selected: row.selected + 1 };
  }
  const courts = Object.keys(coverage).length;
  return {
    cases,
    coverage,
    scannedAt: '2026-06-14T10:00:00Z',
    selection: {
      ruleId: 'court-select-synthetic', courtStateRuleId: 'court-state-synthetic', textRuleId: 'circuit-select-synthetic',
      appliedTo: 'every synthetic decision', since: '2025-01-01', searchTerms: ['ballot', '"general election"'],
      courtTypes: { FD: 'federal_district', S: 'state_supreme', SA: 'state_appellate', ST: 'state_trial' },
      candidates: 30 * courts + 7, skipped: { 'otherCourt:F': 5, noState: 2 }, totalCasesRead: 30 * courts, totalDocumentsRead: 33 * courts,
      months: 18, monthsListed: 18, oldestListingAt: '2026-06-10T10:00:00Z',
      wordPattern: 'x', phrasePattern: 'x', authorityPattern: 'x', laborPattern: 'x', laborMinMatches: 10, laborRatio: 4,
      textTests: { party: { wordMatches: 3 } },
    },
  };
}

/** A measure of Congress as congress/index.json lists it. */
export function makeFederalBill(overrides: Partial<LegislativeInstrumentSummary> = {}): LegislativeInstrumentSummary {
  return makeBill({
    id: 'us-119-hr9001',
    state: 'US',
    stateAbbr: 'US',
    session: '119th Congress (2025–2026)',
    identifier: 'H.R. 9001',
    measureType: 'House Bill',
    title: 'To require synthetic proof of eligibility to register to vote, and for other purposes.',
    subject: 'Synthetic Voter Eligibility Act',
    leadAuthors: 'Rep. Synthetic, Member [R-TX-1]',
    legislativeStatus: { measureState: 'Engrossed in House', currentStatus: 'Passed the House', currentHouse: null, currentLocation: null },
    chapter: null,
    introducedDate: '2025-01-03',
    lastActionDate: '2025-04-10',
    lastActionText: 'Received in the Senate.',
    issueTags: [{ tag: 'voter-registration', ruleId: 'tag-synthetic-4', matchedField: 'official title', matchedText: 'register to vote' }],
    officialUrl: `${SYNTHETIC_HOST}/congress/hr9001`,
    sourceId: 'synthetic-congress',
    ...overrides,
  });
}

export function makeFederalBillIndexFile(bills: LegislativeInstrumentSummary[] = [makeFederalBill()]): FederalBillIndex {
  return {
    bills: bills as FederalBillIndex['bills'],
    selection: {
      ruleId: 'us-select-synthetic', congress: 119, appliedTo: 'titles and policy area', pattern: 'x', generalPattern: 'x', generalAreas: [],
      otherPattern: 'x', otherAreas: [], exclusionPattern: 'x', excludedAreas: [], tests: { named: 'Synthetic.' }, selectedByTest: { named: bills.length },
      totalMeasuresRead: 900,
    },
  };
}

export function makeBill(overrides: Partial<LegislativeInstrumentSummary> = {}): LegislativeInstrumentSummary {
  return {
    id: 'ca-99999999-zz1',
    state: '06',
    stateAbbr: 'CA',
    session: '2025-2026 (synthetic)',
    identifier: 'AB 1',
    measureType: 'AB',
    title: 'An act relating to synthetic elections.',
    subject: 'Elections: synthetic ballots.',
    leadAuthors: 'Synthetic Member',
    legislativeStatus: { measureState: 'Chaptered', currentStatus: 'Chaptered', currentHouse: null, currentLocation: null },
    chapter: { year: '2026', number: '1', type: 'CHP', citation: 'Chapter 1, Statutes of 2026 (synthetic)' },
    introducedDate: '2026-01-06',
    lastActionDate: '2026-05-01',
    lastActionText: 'Chaptered by Secretary of State.',
    versionCount: 2,
    issueTags: [{ tag: 'mail-voting', ruleId: 'tag-synthetic-2', matchedField: 'subject', matchedText: 'vote by mail' }],
    officialUrl: `${SYNTHETIC_HOST}/leg/ab1`,
    sourceId: 'synthetic-legislature',
    firstObservedAt: '2026-01-07T00:00:00Z',
    lastCheckedAt: '2026-06-14T10:00:00Z',
    verification: { status: 'verified_primary', method: 'automated_primary_retrieval', checkedAt: '2026-06-14T10:00:00Z', note: null },
    ...overrides,
  };
}

/** A measure of a state legislature as Open States records it (synthetic). */
export function makeStateMeasure(overrides: Partial<StateMeasureSummary> = {}): StateMeasureSummary {
  return {
    ...makeBill(),
    id: 'os-la-2026rs-hb12',
    state: '22',
    stateAbbr: 'LA',
    session: '2026 Regular Session',
    identifier: 'HB 12',
    measureType: 'Bill',
    title: 'Provides relative to absentee voting by mail (synthetic).',
    subject: null,
    chapter: null,
    legislativeStatus: { currentStatus: 'Passed one chamber' },
    selection: { ruleId: 'state-select-1', matchedText: 'absentee voting', matchedField: 'Title', test: 'named' },
    sourceId: 'openstates-api',
    verification: { status: 'imported_secondary', method: 'automated_secondary_import', checkedAt: '2026-06-14T10:00:00Z' },
    ...overrides,
  };
}

/** The index of the state legislatures' measures (synthetic): Louisiana listed, Maryland waiting for a secure link, Puerto Rico left out. */
export function makeStateLegislationIndex(bills: StateMeasureSummary[] = [makeStateMeasure()]): StateLegislationIndex {
  const session = (state: string, stateAbbr: string, listed: number, withoutSecureLink: number) => ({
    state, stateAbbr, identifier: '2026rs', name: '2026 Regular Session', classification: 'primary', start: '2026-03-09', end: '2026-06-01',
    measuresRead: 1000, selected: listed + withoutSecureLink, listed, withoutSecureLink,
  });
  return {
    bills,
    scannedAt: '2026-06-14T10:00:00Z',
    sessions: [session('22', 'LA', bills.length, 0), session('24', 'MD', 0, 7)],
    selection: {
      ruleId: 'state-select-1', statusRuleId: 'state-status-1', linkRuleId: 'secure-link-1', appliedTo: 'the title and the subjects', since: '2025-01-01',
      tests: { named: 'The title names an election matter.', general: 'The title holds an election word.', subject: 'A subject names elections.' },
      subjectPattern: 'x', subjectExclusions: 'x', maxSubjects: 3, namedPattern: 'x', generalPattern: 'x', exclusionPattern: 'x', notLegislation: [],
      ceremonialPattern: 'x', resolutionCeremonialPattern: 'x',
      stages: ['Introduced', 'Passed one chamber', 'Passed the legislature', 'Sent to the governor', 'Vetoed', 'Signed by the governor', 'Became law'],
      totalMeasuresRead: 2000, selected: bills.length + 7, listed: bills.length, withoutSecureLink: 7, selectedByTest: { named: bills.length },
      notLegislationLeftOut: 0,
      leftOut: [{ state: '06', stateAbbr: 'CA', reason: "California is read from the Legislature's own data" }, { state: '72', stateAbbr: 'PR', reason: 'Puerto Rico titles its measures in Spanish, which the rule does not read' }],
    },
  };
}

export function makeFullBill(overrides: Partial<LegislativeInstrument> = {}): LegislativeInstrument {
  return {
    ...makeBill(),
    digest: null,
    actions: [
      { date: '2026-01-06', sequence: 1, historyId: '101', text: 'Read first time.', location: 'Assembly Desk', eventType: 'introduced', significance: 'major', classificationRule: 'ca-synthetic-1', votes: [] },
      { date: '2026-05-01', sequence: 2, historyId: '102', text: 'Chaptered by Secretary of State.', location: null, eventType: 'chaptered', significance: 'major', classificationRule: 'ca-synthetic-2', votes: [] },
    ],
    approvedDate: '2026-04-30',
    chapteredDate: '2026-05-01',
    vetoedDate: null,
    effective: { date: null, basis: 'not_verified', note: 'The effective date has not been verified from the text.' },
    conditions: [],
    expiryClauses: [],
    indicators: {},
    versions: [
      {
        id: 'ZZV1', instrumentId: 'ca-99999999-zz1', label: 'Introduced', versionDate: '2026-01-06', versionNum: 99, subject: null,
        officialUrl: `${SYNTHETIC_HOST}/leg/ab1/v1`, textPath: 'legislation/text/ZZV1.json', textAvailability: 'mirrored', textHash: 'a'.repeat(64),
        sourceHash: null, blockCount: 3, wordCount: 30, diff: null, sourceMember: null,
      },
      {
        id: 'ZZV2', instrumentId: 'ca-99999999-zz1', label: 'Chaptered', versionDate: '2026-05-01', versionNum: 98, subject: null,
        officialUrl: `${SYNTHETIC_HOST}/leg/ab1/v2`, textPath: null, textAvailability: 'link_only', textHash: null,
        sourceHash: null, blockCount: null, wordCount: null,
        diff: { previousVersionId: 'ZZV1', blocksAdded: 1, blocksRemoved: 0, blocksUnchanged: 3, similarity: 0.9 }, sourceMember: null,
      },
    ],
    affectedStatutes: [],
    judicialNote: 'DemocracyHQ has no linked litigation for this measure. That is not evidence that none exists.',
    sourcePublishedAt: null,
    sponsors: [],
    legislativeSubjects: [],
    committees: [],
    shortTitles: [],
    relatedMeasures: [],
    contentHash: 'synthetic',
    ...overrides,
  };
}

export function makeVersionText(overrides: Partial<VersionText> = {}): VersionText {
  return {
    versionId: 'ZZV1', instrumentId: 'ca-99999999-zz1', label: 'Introduced', versionDate: '2026-01-06', title: null, subject: null, digest: null,
    blocks: [['s', 'SECTION 1.'], ['p', 'A synthetic ballot shall be counted.']],
    textHash: 'a'.repeat(64), officialUrl: `${SYNTHETIC_HOST}/leg/ab1/v1`, sourceId: 'synthetic-legislature',
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<EntityRelationship> = {}): EntityRelationship {
  return {
    id: 'rel-synthetic-1',
    source: { type: 'case', id: 'synthetic-case-1' },
    target: { type: 'geography', id: 'state:06' },
    relationshipType: 'case_concerns_state',
    scope: { kind: 'statewide', note: 'Synthetic scope note.' },
    support: { url: `${SYNTHETIC_HOST}/court/99-0001/petition.pdf`, quote: 'the State of Synthetic', sourceId: null },
    basis: 'curated',
    ruleId: 'rel-synthetic',
    verification: { status: 'verified_primary', method: 'rule_derived', checkedAt: '2026-06-14T10:00:00Z', note: null },
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'ev-synthetic-1', date: '2026-03-01', category: 'litigation', eventType: 'cert_denied', entityType: 'case', entityId: 'synthetic-case-1',
    entityLabel: 'Synthetic Alpha v. Synthetic Beta', description: 'Petition DENIED.', sourceUrl: `${SYNTHETIC_HOST}/court/99-0001`,
    geoKeys: ['state:06'], ruleId: 'entry-synthetic-1',
    ...overrides,
  };
}

const SYNTHETIC_LABELS: Record<string, string> = { total: 'Total population', white: 'White alone, not Hispanic or Latino' };
const VARIABLES: PopulationFile['variables'] = [
  'total', 'hispanic', 'white', 'black', 'aian', 'asian', 'nhpi', 'other', 'multi',
  'vap_total', 'vap_hispanic', 'vap_white', 'vap_black', 'vap_aian', 'vap_asian', 'vap_nhpi', 'vap_other', 'vap_multi',
].map((key) => ({ key, code: `SYN_${key}`, label: SYNTHETIC_LABELS[key] ?? key, universe: key.startsWith('vap_') ? 'Population 18 and over' : 'Total population' }));

/** One row whose groups add up to `total`. Numbers are invented. */
export function populationRow(total: number): number[] {
  const groups = [Math.floor(total * 0.3), Math.floor(total * 0.4), Math.floor(total * 0.1), 10, Math.floor(total * 0.1), 5, 7];
  const multi = total - groups.reduce((a, b) => a + b, 0);
  const all = [...groups, multi];
  const vapTotal = Math.floor(total * 0.75);
  const vap = all.map((count) => Math.floor(count * 0.75));
  vap[vap.length - 1] = vapTotal - vap.slice(0, -1).reduce((a, b) => a + b, 0);
  return [total, ...all, vapTotal, ...vap];
}

export function makePopulationFile(rows: Record<string, number[]>, id = 'synthetic-cd119'): PopulationFile {
  return {
    dataset: {
      id, title: 'Synthetic counts', censusYear: 2020, sourceId: 'synthetic-census', tables: 'P0', geographyNote: 'Synthetic.',
      sourcePublishedAt: null, methodology: 'Synthetic.',
    },
    variables: VARIABLES,
    rows,
  };
}

export function makeRedistricting(overrides: Partial<RedistrictingFile> = {}): RedistrictingFile {
  return {
    congress120: {
      statesWithNewBoundaries: ['48'],
      quote: 'Synthetic quote.',
      note: null,
      sourceId: 'synthetic-census',
      sourceUrl: `${SYNTHETIC_HOST}/census/cd120`,
      checkedAt: '2026-06-14T10:00:00Z',
    },
    districtCounts: { cd119: { '06': 2, '48': 2 }, cd120: { '06': 2, '48': 2 } },
    areaCheck: { method: 'Synthetic.', tolerance: 0.001, compared: 2, largestRelativeDifference: 0, mismatches: [], redrawnStatesWithDifferingAreas: ['48'] },
    populationAvailability: { cd119: 'Synthetic.', cd120: 'Synthetic.' },
    ...overrides,
  };
}

const LAYER_INFO = (label: string, geoType: 'nation' | 'judicial_circuit' | 'state' | 'county' | 'congressional_district') => ({
  file: 'geo/synthetic.topo.json', object: 'x', featureCount: 1, sourceId: 'synthetic-census', vintage: 'Synthetic vintage', label, geoType, sourcePublishedAt: null,
});

/** A tiny index: two states, two counties, and two districts per state in both Congress layers. Boxes are invented. */
export function makeGeoIndexFile(): GeoIndexFile {
  return {
    fields: ['key', 'name', 'stateFips', 'west', 'south', 'east', 'north'],
    layers: {
      state: LAYER_INFO('States', 'state'),
      county: LAYER_INFO('Counties', 'county'),
      cd119: LAYER_INFO('Districts 119', 'congressional_district'),
      cd120: LAYER_INFO('Districts 120', 'congressional_district'),
      // The two layers the site draws from the state boundaries. They add no row to the index.
      circuit: LAYER_INFO('Judicial circuits', 'judicial_circuit'),
      nation: LAYER_INFO('United States', 'nation'),
    },
    rows: [
      ['state:06', 'California', '06', -124, 32, -114, 42],
      ['state:48', 'Texas', '48', -107, 26, -93, 37],
      ['state:78', 'United States Virgin Islands', '78', -65, 17, -64, 18],
      ['county:06037', 'Los Angeles County, California', '06', -119, 33, -117, 35],
      ['county:48201', 'Harris County, Texas', '48', -96, 29, -95, 30],
      ['cd119:0601', 'Congressional District 1, California', '06', -124, 39, -120, 42],
      ['cd119:0602', 'Congressional District 2, California', '06', -124, 37, -122, 39],
      ['cd119:4801', 'Congressional District 1, Texas', '48', -96, 31, -94, 33],
      ['cd119:4802', 'Congressional District 2, Texas', '48', -96, 29, -95, 31],
      ['cd120:0601', 'Congressional District 1, California', '06', -124, 39, -120, 42],
      ['cd120:0602', 'Congressional District 2, California', '06', -124, 37, -122, 39],
      ['cd120:4801', 'Congressional District 1, Texas', '48', -96, 31, -94, 33],
      ['cd120:4802', 'Congressional District 2, Texas', '48', -96, 29, -95, 31],
    ],
  };
}

export function makeManifest(): Manifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-14T10:00:00Z',
    counts: { cases: 1, bills: 1, relationships: 1, events: 1, geographicUnits: 13 },
    reviewQueue: { items: 0, byKind: {} },
    sources: { 'synthetic-court': { processingStatus: 'ok', lastSuccessfulCheck: '2026-06-14T10:00:00Z', lastAttempt: '2026-06-14T10:00:00Z' } },
    contentHash: 'synthetic',
  };
}
