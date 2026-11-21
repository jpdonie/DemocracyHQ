/**
 * Bill pages, packs and exports: the final-review fixes (W1, W2/DL1, W6, W22, DL2, DL3/DN4, DL4, DL5, DL9, DL14, DB11)
 * and the zod side of contracts C1, C3 and C4. Real records are read from public/data; everything else is synthetic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BillIndexSchema, CaliforniaBillSummarySchema, LegislativeInstrumentSchema, LegislativeInstrumentSummarySchema, VerificationSchema,
  type LegislativeInstrument,
} from '../../src/types/schemas';
import { differentSubject, earlierSubject, earlierSubjectNote, sameSubject, versionInForce } from '../../src/lib/billHistory';
import { afterPassageDeadline, passageDeadlineNote, pendingAfterDeadline } from '../../src/lib/caSession';
import { BALLOT_RESULTS_NOTE, entityNamer, packForBill, packForCase, packForPlace, packToCsv, turnsOnBallot } from '../../src/lib/export';
import { GeoIndex } from '../../src/lib/geo';
import { METHOD_LABELS, VERIFICATION_LABELS } from '../../src/lib/verification';
import { effectiveHeadline, effectiveHeadlineGuide } from '../../src/features/legislation/BillDetail';
import { makeBill, makeCase, makeEvent, makeFullBill, makeFullCase, makeGeoIndexFile, makeManifest, makeRelationship, makeSource, NOW } from './fixtures';

const data = (path: string) => JSON.parse(readFileSync(new URL(`../../public/data/${path}`, import.meta.url), 'utf8'));
const realBill = (id: string): LegislativeInstrument => LegislativeInstrumentSchema.parse(data(`legislation/bills/${id}.json`));
const link = (hash: string) => `https://example.test/app/${hash}`;
const LEGINFO = 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB604';
const bulk = makeSource({ id: 'synthetic-bulk', name: 'Synthetic bulk archive', url: 'https://example.test/bulk/', sourceType: 'official_bulk' });
const base = { now: NOW, link, manifest: makeManifest(), sources: [makeSource(), bulk] };

describe('zod: the contracts other groups rely on', () => {
  it('C1: accepts the new method maintainer_curated, and still accepts rule_derived on curated links', () => {
    for (const method of ['maintainer_curated', 'rule_derived']) {
      expect(VerificationSchema.safeParse({ status: 'verified_primary', method, checkedAt: NOW }).success, method).toBe(true);
    }
    expect(VerificationSchema.safeParse({ status: 'verified_primary', method: 'guessed', checkedAt: NOW }).success).toBe(false);
  });

  it('C3: expiryClauses defaults to an empty list and takes a stated date or none', () => {
    const { expiryClauses: _omit, ...without } = makeFullBill();
    expect(LegislativeInstrumentSchema.parse(without).expiryClauses).toEqual([]);
    const clauses = [
      { text: 'This section shall remain in effect only until January 1, 2027, and as of that date is repealed.', versionId: 'V1', ruleId: 'ca-sunset-1', date: '2027-01-01' },
      { text: 'This chapter shall remain in effect only until a new map is certified.', versionId: 'V1', ruleId: 'ca-sunset-1', date: null },
    ];
    expect(LegislativeInstrumentSchema.parse({ ...makeFullBill(), expiryClauses: clauses }).expiryClauses).toEqual(clauses);
    expect(LegislativeInstrumentSchema.safeParse({ ...makeFullBill(), expiryClauses: [{ ...clauses[0], date: 'January 1, 2027' }] }).success).toBe(false);
  });

  it('C4: a California bill id must match ca-<8 digits>-<type><number>, in the index and in the record', () => {
    for (const bad of ['ca-20252026-ab1/../../../../package', 'ca-20252026-AB604', 'ca-2025-ab604', 'ca-20252026-ab123456', '../ca-20252026-ab1']) {
      expect(LegislativeInstrumentSchema.safeParse(makeFullBill({ id: bad })).success, bad).toBe(false);
      expect(CaliforniaBillSummarySchema.safeParse(makeBill({ id: bad })).success, bad).toBe(false);
      expect(BillIndexSchema.safeParse({ bills: [makeBill({ id: bad })], selection: { ruleId: 'r', pattern: 'p', appliedTo: 'a', totalBillsInSession: 1 } }).success, bad).toBe(false);
    }
    expect(LegislativeInstrumentSchema.safeParse(makeFullBill({ id: 'ca-20252026-aca8' })).success).toBe(true);
    // Secondary imports (legislation_secondary.json) have ids of another form and keep the open summary schema.
    expect(LegislativeInstrumentSummarySchema.safeParse(makeBill({ id: 'os-abc123', verification: { status: 'imported_secondary', method: 'automated_secondary_import', checkedAt: NOW } })).success).toBe(true);
  });

  it('the current data release still validates', () => {
    expect(BillIndexSchema.safeParse(data('legislation/index.json')).success).toBe(true);
  });
});

describe('DL2: the subject a measure carried when each action was taken', () => {
  const noted = (id: string, date: string, eventType?: string) => {
    const bill = realBill(id);
    return bill.actions.filter((a) => a.date === date && (!eventType || a.eventType === eventType)).map((a) => earlierSubject(bill, a));
  };

  it('notes the votes taken before a gut-and-amend (AB 604, AB 282, SB 280)', () => {
    expect(noted('ca-20252026-ab604', '2025-04-01', 'passed_house')).toEqual(['Voter registration: residency confirmation.']);
    expect(noted('ca-20252026-ab282', '2025-05-08', 'passed_house')).toEqual(['Discrimination: housing: source of income.']);
    expect(noted('ca-20252026-sb280', '2025-05-29', 'passed_house')[0]).toBe('Political Reform Act of 1974: prohibition on contributions in state and local government office buildings.');
    expect(earlierSubjectNote('Voter registration: residency confirmation.')).toBe('Taken when the measure’s subject was: Voter registration: residency confirmation.');
  });

  it('does not note an action dated the same day as a new version, whose text the record does not identify', () => {
    const ab604 = realBill('ca-20252026-ab604');
    expect(versionInForce(ab604.versions, '2025-08-18')).toBeNull();
    expect(noted('ca-20252026-ab604', '2025-08-18').every((s) => s === null)).toBe(true);
    // The introduction is dated the day of the introduced version.
    expect(noted('ca-20252026-ab604', '2025-02-13')).toEqual([null]);
  });

  it('does not flag AB 1664, whose votes were on the elections text: "voting systems" became "voting technology"', () => {
    const ab1664 = realBill('ca-20252026-ab1664');
    expect(ab1664.actions.filter((a) => a.significance === 'major').map((a) => earlierSubject(ab1664, a)).filter(Boolean)).toEqual([]);
    expect(noted('ca-20252026-ab1664', '2026-05-21', 'passed_house')).toEqual([null]);
    // An exact comparison of the two lines (what the reviewer's checker did) would have flagged that vote.
    const atVote = versionInForce(ab1664.versions, '2026-05-21')!.subject!;
    expect(atVote).not.toBe(ab1664.subject);
    expect(sameSubject(atVote, ab1664.subject!)).toBe(true);
  });

  it('tells a reworded subject line from a different subject', () => {
    expect(sameSubject('Elections: voter registration information: elected officials.', 'Elections: voter registration information: elected officials and candidates.')).toBe(true);
    expect(sameSubject('Political Reform Act of 1974: amendments.', 'Political Reform Act of 1974: Citizens Redistricting Commission.')).toBe(false);
    expect(sameSubject('Elections: tie votes.', 'All-mailed ballot elections: vote centers.')).toBe(false);
    expect(sameSubject('Voter registration: residency confirmation.', 'Redistricting: congressional districts.')).toBe(false);
  });

  it('carries the note into the pack, and gives each version row its official subject', () => {
    const pack = packForBill({ ...base, record: realBill('ca-20252026-ab604'), relationships: [], linkedCases: [] });
    const vote = pack.items.find((i) => i.section === 'event' && i.date === '2025-04-01')!;
    expect(vote.detail).toContain('(Ayes 75. Noes 1.');
    expect(vote.detail).toMatch(/Taken when the measure’s subject was: Voter registration: residency confirmation\.$/);
    const introduced = pack.items.find((i) => i.section === 'text_version' && i.id === '20250AB60499INT')!;
    expect(introduced.detail).toMatch(/^Official subject line: Voter registration: residency confirmation\. /);
  });
});

describe('DL4: bills still pending after the last day to pass bills', () => {
  const pending = makeBill({ session: '2025-2026 Regular Session', measureType: 'Senate Bill', legislativeStatus: { measureState: 'Amended Senate', currentStatus: 'In Committee Process' } });

  it('is judged against the data release, not the reader’s clock', () => {
    expect(afterPassageDeadline('2026-08-31T23:00:00Z')).toBe(false);
    expect(afterPassageDeadline('2026-09-01T00:00:00Z')).toBe(true);
    expect(pendingAfterDeadline(pending, '2026-06-14T10:00:00Z')).toBe(false);
    expect(pendingAfterDeadline(pending, '2026-11-20T16:16:39Z')).toBe(true);
  });

  it('applies only to Assembly and Senate bills of the session whose status is still pending', () => {
    const asOf = '2026-11-20T16:16:39Z';
    for (const status of ['In Committee Process', 'Pending Referral', 'In Floor Process']) {
      expect(pendingAfterDeadline({ ...pending, legislativeStatus: { currentStatus: status } }, asOf), status).toBe(true);
    }
    expect(pendingAfterDeadline({ ...pending, legislativeStatus: { currentStatus: 'Chaptered' } }, asOf)).toBe(false);
    expect(pendingAfterDeadline({ ...pending, measureType: 'Assembly Constitutional Amendment' }, asOf)).toBe(false);
    expect(pendingAfterDeadline({ ...pending, measureType: 'Senate Concurrent Resolution' }, asOf)).toBe(false);
    expect(pendingAfterDeadline({ ...pending, session: '2027-2028 Regular Session' }, asOf)).toBe(false);
  });

  it('cites the Constitution and says the status is the one the Legislature records', () => {
    const note = passageDeadlineNote('2026-11-20T16:16:39Z');
    expect(note).toBe('The last day for each house to pass bills in the 2025–26 session was August 31, 2026 (California Constitution, article IV, section 10(c), which lists exceptions such as urgency statutes), and the session ends on November 30, 2026 (article IV, section 3(a)). The status shown is the one the Legislature records.');
    expect(passageDeadlineNote('2026-12-02T00:00:00Z')).toContain('the session ended on November 30, 2026');
  });

  it('counts the real release’s pending bills, and the pack says it next to their status', () => {
    const index = BillIndexSchema.parse(data('legislation/index.json'));
    const asOf = data('manifest.json').generatedAt as string;
    const affected = index.bills.filter((b) => pendingAfterDeadline(b, asOf));
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.every((b) => b.measureType === 'Assembly Bill' || b.measureType === 'Senate Bill')).toBe(true);
    const pack = packForBill({ ...base, manifest: { ...makeManifest(), generatedAt: asOf }, record: realBill(affected[0]!.id), relationships: [], linkedCases: [] });
    expect(pack.items[0]!.detail).toContain('The last day for each house to pass bills');
  });
});

describe('W22 (C7): a vetoed bill', () => {
  it('reads "None: vetoed, not enacted as of the last check", and the Sources page lists that headline', () => {
    const vetoed = makeFullBill({ approvedDate: null, chapteredDate: null, chapter: null, vetoedDate: '2026-09-27', legislativeStatus: { currentStatus: 'Vetoed' }, effective: { date: null, basis: 'not_enacted', note: 'n' } });
    expect(effectiveHeadline(vetoed)).toBe('None: vetoed, not enacted as of the last check');
    expect(effectiveHeadlineGuide()).toContain('“None: vetoed, not enacted as of the last check”');
  });
});

describe('DL5 and DL9: what the effective-date entry says beside the date', () => {
  it('says that ballot results are not tracked where taking effect turns on a vote of the people', () => {
    expect(turnsOnBallot(makeFullBill({ measureType: 'Assembly Constitutional Amendment', chapteredDate: '2025-08-21' }), [])).toBe(true);
    expect(turnsOnBallot(makeFullBill(), ['This chapter shall become operative only if ACA 8 is approved by the voters.'])).toBe(true);
    expect(turnsOnBallot(makeFullBill(), ['This section shall take effect only if Senate Bill 1360 does not take effect.'])).toBe(false);
    const pack = packForBill({ ...base, record: realBill('ca-20252026-ab604'), relationships: [], linkedCases: [] });
    expect(pack.items.find((i) => i.id === 'ca-20252026-ab604:effective')!.detail).toContain(BALLOT_RESULTS_NOTE);
    expect(BALLOT_RESULTS_NOTE).toMatch(/does not track ballot or election results.*Secretary of State’s Statement of Vote/);
  });

  it('quotes an expiry clause with its rule, and says it applies only to the provision named, and only if enacted', () => {
    const clause = { text: 'This section shall remain in effect only until January 1, 2027, and as of that date is repealed.', versionId: 'ZZV1', ruleId: 'ca-sunset-1', date: '2027-01-01' };
    const enacted = packForBill({ ...base, record: makeFullBill({ expiryClauses: [clause] }), relationships: [], linkedCases: [] });
    const detail = enacted.items.find((i) => i.title === 'Effective date')!.detail!;
    expect(detail).toContain(`Expiry stated in the text (2027-01-01), found by rule ca-sunset-1 in version Introduced: “${clause.text}” It applies to the provision that sentence names`);
    const died = packForBill({ ...base, record: makeFullBill({ expiryClauses: [clause], approvedDate: null, chapteredDate: null, chapter: null, legislativeStatus: { currentStatus: 'Died' } }), relationships: [], linkedCases: [] });
    expect(died.items.find((i) => i.title === 'Effective date')!.detail).toContain('would apply only if this measure were enacted');
  });
});

describe('DL14: a bill pack names the bulk archive as the checked source', () => {
  const record = makeFullBill({
    officialUrl: LEGINFO, sourceId: 'synthetic-bulk',
    versions: makeFullBill().versions.map((v, i) => ({ ...v, officialUrl: `${LEGINFO}&v=${i}`, sourceMember: i === 0 ? 'BILL_VERSION_TBL_1.lob' : null, sourceHash: i === 0 ? 'b'.repeat(64) : null })),
  });
  const pack = packForBill({ ...base, record, relationships: [], linkedCases: [] });

  it('gives the bulk archive as the source and the leginfo page separately, as not machine-checked', () => {
    for (const row of pack.items.filter((i) => i.section !== 'link' && i.id !== `${record.id}:courts`)) {
      expect(row.sourceUrl, row.id).not.toMatch(/leginfo\.legislature/);
      if (row.pageUrl) expect(row.pageUrl).toMatch(/^https:\/\/leginfo\.legislature\.ca\.gov\//);
    }
    expect(pack.items[0]).toMatchObject({ sourceName: 'Synthetic bulk archive', sourceUrl: 'https://example.test/bulk/', pageUrl: LEGINFO });
    expect(pack.items[0]!.verificationMethod).toBe(METHOD_LABELS.automated_primary_retrieval);
    const csv = packToCsv(pack);
    expect(csv.split('\r\n')[0]).toContain('official_page_url_not_machine_checked');
  });

  it('labels the hash as a hash of the extracted text, and names the archive file', () => {
    const version = pack.items.find((i) => i.section === 'text_version')!;
    expect(version.detail).toContain('Text extracted from BILL_VERSION_TBL_1.lob in the official bulk archive.');
    expect(version.detail).toContain(`SHA-256 hash of the extracted text, not of the official file: ${'a'.repeat(64)}.`);
    expect(version.detail).toContain(`SHA-256 hash of BILL_VERSION_TBL_1.lob as read from the archive: ${'b'.repeat(64)}.`);
    expect(version.detail).not.toMatch(/Text hash \(SHA-256\)/);
  });
});

describe('W1: a link row carries how it was checked and what the check does not test', () => {
  const note = 'The link and its description were written by a maintainer. The quoted passage was found in the cited document on this date. The check shows that the document says this; it does not check the description.';
  const r = makeRelationship({ verification: { status: 'verified_primary', method: 'maintainer_curated', checkedAt: NOW, note } });

  it('in JSON, CSV and the item the print view reads', () => {
    const pack = packForCase({ ...base, record: makeFullCase(), relationships: [r] });
    const row = pack.items.find((i) => i.section === 'link')!;
    expect(row.verificationLabel).toBe(VERIFICATION_LABELS.verified_primary);
    expect(row.verificationMethod).toBe(METHOD_LABELS.maintainer_curated ?? 'maintainer_curated');
    expect(row.verificationNote).toBe(note);
    const csv = packToCsv(pack);
    expect(csv.split('\r\n')[0]).toContain(',verification_method,verification_note,');
    expect(csv).toContain(note);
  });
});

describe('W2 / DL1 (C6): an unavailable court document is never exported as a working link', () => {
  const dead = 'https://example.test/court/99-0001/opinion_dead.pdf';
  const accessNote = 'The Court\'s docket gives this address, which answered 404 (not found) when checked on 2026-11-20. The Court may have moved the file.';
  const record = makeFullCase({
    documents: [
      ...makeFullCase().documents,
      { id: 'synthetic-case-1:d3', caseId: 'synthetic-case-1', entryIndex: 2, title: 'Opinion (linked in docket entry)', filingDate: '2026-03-01', documentType: 'Opinion', url: dead, availability: 'unavailable', accessNote },
    ],
    events: makeFullCase().events.map((e) => (e.id === 'synthetic-case-1:e3' ? { ...e, documentIds: ['synthetic-case-1:d3'] } : e)),
  });
  const pack = packForCase({ ...base, record, relationships: [] });

  it('uses the docket page as the entry’s source and carries the address and note as text', () => {
    const entry = pack.items.find((i) => i.id === 'synthetic-case-1:e3')!;
    expect(entry.sourceUrl).toBe('https://example.test/court/99-0001');
    expect(entry.documentAvailability).toBe('unavailable');
    expect(entry.documentAvailabilityNote).toContain(dead);
    expect(entry.documentAvailabilityNote).toContain('answered 404 (not found) when checked on 2026-11-20');
    expect(pack.items.some((i) => i.sourceUrl === dead || i.pageUrl === dead)).toBe(false);
    const working = pack.items.find((i) => i.id === 'synthetic-case-1:e1')!;
    expect(working).toMatchObject({ sourceUrl: 'https://example.test/court/99-0001/petition.pdf', documentAvailability: 'public_link', documentAvailabilityNote: null });
  });

  it('does the same for the real Gill v. Whitford opinion link', () => {
    const real = packForCase({ ...base, record: data('litigation/cases/scotus-16-1161.json'), relationships: [] });
    const entry = real.items.find((i) => i.id === 'scotus-16-1161-e82')!;
    expect(entry.sourceUrl).toMatch(/^https:\/\/www\.supremecourt\.gov\/search\.aspx\?filename=\/docket\//);
    expect(entry.documentAvailability).toBe('unavailable');
    expect(entry.documentAvailabilityNote).toContain('https://www.supremecourt.gov/opinions/17pdf/16-1161_dc8f.pdf');
  });
});

describe('DB11: a case pack’s sections and link titles', () => {
  const geo = new GeoIndex(makeGeoIndexFile());
  const toBill = makeRelationship({ id: 'rel-bill', target: { type: 'bill', id: 'ca-99999999-zz1' }, relationshipType: 'litigation_concerns_measure' });
  const pack = packForCase({
    ...base, record: makeFullCase(), relationships: [makeRelationship({ relationshipType: 'concerns_congressional_plan' }), toBill],
    nameOf: entityNamer({ geo, bills: [makeBill()], cases: [makeCase()] }),
  });

  it('files the Questions Presented under court documents, not under court cases', () => {
    expect(pack.items.find((i) => i.id === 'synthetic-case-1:qp')!.section).toBe('court_document');
    expect(pack.items.filter((i) => i.section === 'court_case')).toEqual([]);
  });

  it('titles a link by the names of the place or bill, not by raw keys', () => {
    const titles = pack.items.filter((i) => i.section === 'link').map((i) => i.title);
    expect(titles).toEqual(['Concerns a congressional district plan of California', 'Litigation concerning CA AB 1']);
    expect(titles.join(' ')).not.toMatch(/state:06|geography|ca-99999999/);
  });

  it('names a bill from its id when no index is given', () => {
    const plain = packForCase({ ...base, record: makeFullCase(), relationships: [toBill] });
    expect(plain.items.find((i) => i.section === 'link')!.title).toBe('Litigation concerning CA ZZ 1');
  });
});

describe('After verification: DL2 notes on amend-and-pass votes and on timeline events', () => {
  const noted = (id: string, date: string, eventType?: string) => {
    const bill = realBill(id);
    return bill.actions.filter((a) => a.date === date && (!eventType || a.eventType === eventType)).map((a) => earlierSubject(bill, a));
  };

  it('does not note a committee vote that adopted the amendments that changed the subject (AB 1511, SB 73)', () => {
    // Each vote adopted amendments printed a day or a few days later in a version with a different subject line.
    expect(noted('ca-20252026-ab1511', '2025-04-30', 'amended')).toEqual([null]);
    expect(noted('ca-20252026-sb73', '2026-05-07', 'amended')).toEqual([null]);
  });

  it('still notes an amend-and-pass vote whose amendments kept the subject (AB 282, 2025-04-09)', () => {
    expect(noted('ca-20252026-ab282', '2025-04-09', 'amended')).toEqual(['Discrimination: housing: source of income.']);
    // And the gut-and-amend votes are still noted.
    expect(noted('ca-20252026-ab604', '2025-04-01', 'passed_house')).toEqual(['Voter registration: residency confirmation.']);
  });

  it('gives a subject only when it differs from the current one', () => {
    expect(differentSubject('Voter registration: residency confirmation.', 'Redistricting: congressional districts.')).toBe('Voter registration: residency confirmation.');
    expect(differentSubject('Elections: voting systems.', 'Elections: voting technology.')).toBeNull();
    expect(differentSubject(null, 'Elections.')).toBeNull();
    expect(differentSubject('Elections.', null)).toBeNull();
  });

  it('carries the note into a place pack when the event gives the subject in force, and only then', () => {
    const geo = new GeoIndex(makeGeoIndexFile());
    const bill = makeBill({ subject: 'Redistricting: congressional districts.' });
    const event = (subjectInForce?: string | null) => makeEvent({
      id: 'ev-bill', category: 'legislation', eventType: 'passed_house', entityType: 'bill', entityId: bill.id, description: 'Read third time. Passed.',
      sourceUrl: LEGINFO, ...(subjectInForce === undefined ? {} : { subjectInForce }),
    });
    const pack = (e: ReturnType<typeof event>) => packForPlace({
      ...base, unit: geo.get('state:06')!, vintage: 'v', geoSourceId: 'synthetic-census', cases: [], bills: [bill], events: [e], population: null, billCoverageNote: null,
    }).items.find((i) => i.id === 'ev-bill')!;
    expect(pack(event('Voter registration: residency confirmation.')).detail).toBe('Read third time. Passed. Taken when the measure’s subject was: Voter registration: residency confirmation.');
    expect(pack(event('Redistricting: congressional districts.')).detail).toBe('Read third time. Passed.');
    expect(pack(event(null)).detail).toBe('Read third time. Passed.');
    expect(pack(event()).detail).toBe('Read third time. Passed.');
  });
});

describe('After verification: link rows', () => {
  it('a curated link from a release that still says rule_derived gets the maintainer label, matching its own note', () => {
    const curated = makeRelationship({ basis: 'curated', verification: { status: 'verified_primary', method: 'rule_derived', checkedAt: NOW, note: 'The link and its description were written by a maintainer.' } });
    const ruled = makeRelationship({ id: 'rel-ruled', basis: 'rule_derived', verification: { status: 'verified_primary', method: 'rule_derived', checkedAt: NOW, note: null } });
    const rows = packForCase({ ...base, record: makeFullCase(), relationships: [curated, ruled] }).items.filter((i) => i.section === 'link');
    expect(rows.map((r) => r.verificationMethod)).toEqual([METHOD_LABELS.maintainer_curated, METHOD_LABELS.rule_derived]);
  });

  it('a passage on a leginfo page is never left without a source address', () => {
    const onPage = makeRelationship({ support: { url: LEGINFO, quote: 'the State of Synthetic', sourceId: null } });
    const row = (sources: typeof base.sources | null) => packForCase({ ...base, sources, record: makeFullCase(), relationships: [onPage] }).items.find((i) => i.section === 'link')!;
    // The source list names the bulk archive: it is the source, and the page is marked as not machine-checked.
    const archive = makeSource({ id: 'ca-leginfo-bulk', name: 'California bulk data', url: 'https://downloads.leginfo.legislature.ca.gov/' });
    expect(row([makeSource(), archive])).toMatchObject({ sourceName: 'California bulk data', sourceUrl: 'https://downloads.leginfo.legislature.ca.gov/', pageUrl: LEGINFO });
    // Without it, the page is the only address the pack has.
    expect(row(null)).toMatchObject({ sourceUrl: LEGINFO, pageUrl: LEGINFO });
    expect(row([makeSource()])).toMatchObject({ sourceUrl: LEGINFO, pageUrl: LEGINFO });
  });
});
