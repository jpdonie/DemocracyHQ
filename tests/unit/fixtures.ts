/**
 * SYNTHETIC TEST FIXTURES. NOT REAL RECORDS.
 *
 * Everything built here is invented for unit tests: the case names, docket numbers,
 * bill numbers, counts and URLs do not describe any real court case, bill or place.
 * The host `example.test` is reserved for testing and can never resolve. Nothing in
 * this file is imported by the application or copied into `public/data`.
 */
import type {
  EntityRelationship, GeoIndexFile, LegalCase, LegalCaseSummary, LegislativeInstrument, LegislativeInstrumentSummary,
  Manifest, PopulationFile, RedistrictingFile, SourceRecord, TimelineEvent, VersionText,
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
    courtId: 'synthetic-court',
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
        documentType: 'petition', url: `${SYNTHETIC_HOST}/court/99-0001/petition.pdf`, availability: 'public_link', accessNote: null,
      },
    ],
    contentHash: 'synthetic',
    ...overrides,
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

export function makeFullBill(overrides: Partial<LegislativeInstrument> = {}): LegislativeInstrument {
  return {
    ...makeBill(),
    digest: null,
    actions: [
      { date: '2026-01-06', sequence: 1, historyId: '101', text: 'Read first time.', location: 'Assembly Desk', eventType: 'introduced', significance: 'major', classificationRule: 'ca-synthetic-1' },
      { date: '2026-05-01', sequence: 2, historyId: '102', text: 'Chaptered by Secretary of State.', location: null, eventType: 'chaptered', significance: 'major', classificationRule: 'ca-synthetic-2' },
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

const LAYER_INFO = (label: string, geoType: 'state' | 'county' | 'congressional_district') => ({
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
