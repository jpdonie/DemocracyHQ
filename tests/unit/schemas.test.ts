import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BillIndexSchema, CaseIndexSchema, CourtSchema, CourtsFileSchema, EffectiveInfoSchema, EventsFileSchema, GeoIndexSchema, LegalCaseSchema, LegislativeInstrumentSchema,
  ManifestSchema, RelationshipFileSchema, SourceRecordSchema, SourcesFileSchema, TimelineEventSchema, VERIFICATION_STATUSES,
  VerificationSchema, VersionTextSchema,
} from '../../src/types/schemas';
import { VERIFICATION_LABELS, VERIFICATION_MEANINGS } from '../../src/lib/verification';
import { makeBill, makeEvent, makeFullBill, makeFullCase, makeGeoIndexFile, makeManifest, makeRelationship, makeSource, makeVersionText } from './fixtures';

/** A published data file (public/data). */
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../public/data/${path}`, import.meta.url), 'utf8'));

describe('runtime schemas accept well-formed records (synthetic fixtures)', () => {
  it('accepts every fixture', () => {
    expect(SourceRecordSchema.safeParse(makeSource()).success).toBe(true);
    expect(LegalCaseSchema.safeParse(makeFullCase()).success).toBe(true);
    expect(LegislativeInstrumentSchema.safeParse(makeFullBill()).success).toBe(true);
    expect(VersionTextSchema.safeParse(makeVersionText()).success).toBe(true);
    expect(RelationshipFileSchema.safeParse({ relationships: [makeRelationship()] }).success).toBe(true);
    expect(TimelineEventSchema.safeParse(makeEvent()).success).toBe(true);
    expect(GeoIndexSchema.safeParse(makeGeoIndexFile()).success).toBe(true);
    expect(ManifestSchema.safeParse(makeManifest()).success).toBe(true);
  });
});

describe('runtime schemas reject malformed records', () => {
  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(LegalCaseSchema.safeParse(makeFullCase({ dateDocketed: '01/10/2026' })).success).toBe(false);
    expect(LegalCaseSchema.safeParse(makeFullCase({ dateDocketed: '2026-1-10' })).success).toBe(false);
  });

  it('rejects a timestamp that is not UTC with seconds', () => {
    expect(LegalCaseSchema.safeParse(makeFullCase({ lastCheckedAt: '2026-06-14' })).success).toBe(false);
    expect(LegalCaseSchema.safeParse(makeFullCase({ lastCheckedAt: '2026-06-14T10:00:00+02:00' })).success).toBe(false);
  });

  it('rejects a source link that is not https', () => {
    expect(LegalCaseSchema.safeParse(makeFullCase({ sourceUrl: 'http://example.test/x' })).success).toBe(false);
    expect(LegalCaseSchema.safeParse(makeFullCase({ sourceUrl: 'javascript:alert(1)' })).success).toBe(false);
    expect(LegislativeInstrumentSchema.safeParse(makeFullBill({ officialUrl: 'ftp://example.test/x' })).success).toBe(false);
  });

  it('rejects a link that is not https in evidence, timeline events and court websites', () => {
    const relationship = makeRelationship();
    for (const url of ['http://example.test/x', 'javascript:alert(1)', 'data:text/html,x', '/relative']) {
      expect(RelationshipFileSchema.safeParse({ relationships: [{ ...relationship, support: { ...relationship.support, url } }] }).success).toBe(false);
      const fullCase = makeFullCase();
      const events = fullCase.events.map((e) => ({ ...e, evidence: { ...e.evidence, url } }));
      expect(LegalCaseSchema.safeParse({ ...fullCase, events }).success).toBe(false);
      expect(TimelineEventSchema.safeParse(makeEvent({ sourceUrl: url })).success).toBe(false);
      expect(CourtSchema.safeParse({ id: 'c', name: 'Court', courtType: 'other', jurisdiction: 'x', website: url }).success).toBe(false);
    }
    expect(CourtSchema.safeParse({ id: 'c', name: 'Court', courtType: 'other', jurisdiction: 'x', website: null }).success).toBe(true);
    expect(CourtSchema.safeParse({ id: 'c', name: 'Court', courtType: 'other', jurisdiction: 'x', website: 'https://example.test/' }).success).toBe(true);
  });

  it('rejects an unknown verification status and has no confidence-score field', () => {
    const bad = { ...makeFullCase(), verification: { status: 'probably_fine', method: 'manual_review', checkedAt: '2026-06-14T10:00:00Z' } };
    expect(LegalCaseSchema.safeParse(bad).success).toBe(false);
    expect(Object.keys(VerificationSchema.shape).sort()).toEqual(['checkedAt', 'method', 'note', 'status']);
  });

  it('rejects a missing required field instead of filling it in', () => {
    const { docketNumber: _omit, ...withoutDocket } = makeFullCase();
    expect(LegalCaseSchema.safeParse(withoutDocket).success).toBe(false);
    expect(LegalCaseSchema.safeParse(makeFullCase({ caseName: '' })).success).toBe(false);
  });

  it('rejects negative or fractional population-style counts', () => {
    expect(LegalCaseSchema.safeParse(makeFullCase({ entryCount: -1 })).success).toBe(false);
    expect(LegalCaseSchema.safeParse(makeFullCase({ entryCount: 1.5 })).success).toBe(false);
  });

  it('rejects a geographic key outside the four known layers', () => {
    const file = makeGeoIndexFile();
    file.rows.push(['precinct:0601', 'Synthetic precinct', '06', 0, 0, 1, 1] as never);
    expect(GeoIndexSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a text block of an unknown kind', () => {
    expect(VersionTextSchema.safeParse(makeVersionText({ blocks: [['x', 'text']] as never })).success).toBe(false);
  });
});

describe('legal statuses are separate fields and are never merged', () => {
  it('keeps legislative status, enactment dates, effective date and judicial note apart', () => {
    const bill = LegislativeInstrumentSchema.parse(makeFullBill());
    // Four different questions, four different places in the record.
    expect(bill.legislativeStatus.measureState).toBe('Chaptered');
    expect(bill.chapteredDate).toBe('2026-05-01');
    expect(bill.approvedDate).toBe('2026-04-30');
    expect(bill.effective).toEqual({ date: null, basis: 'not_verified', note: expect.any(String) });
    expect(bill.judicialNote).toMatch(/not evidence/i);
  });

  it('a chaptered bill does not get an effective date by implication', () => {
    expect(EffectiveInfoSchema.safeParse({ date: '2027-01-01', basis: 'assumed_january_1', note: '' }).success).toBe(false);
    // In the published records, every effective date rests on the official flag or the bill text, never on chaptering alone.
    const files = readdirSync(new URL('../../public/data/legislation/bills', import.meta.url)).filter((f) => f.endsWith('.json'));
    const implied: string[] = [];
    let chapteredWithoutDate = 0;
    for (const file of files) {
      const bill = LegislativeInstrumentSchema.parse(read(`legislation/bills/${file}`));
      if (bill.effective.date && !['immediate_effect_flag', 'stated_in_text'].includes(bill.effective.basis)) implied.push(file);
      if (bill.effective.date && !bill.chapteredDate) implied.push(file);
      if (bill.chapteredDate && !bill.effective.date) chapteredWithoutDate += 1;
    }
    expect(implied).toEqual([]);
    // The data does contain chaptered bills with no verified date, so the check above is not vacuous.
    expect(chapteredWithoutDate).toBeGreaterThan(0);
  });

  it('requires a judicial note on every bill', () => {
    const { judicialNote: _omit, ...rest } = makeFullBill();
    expect(LegislativeInstrumentSchema.safeParse(rest).success).toBe(false);
  });

  it('keeps event date, publication date, first-observed and last-checked timestamps as distinct fields', () => {
    const record = LegalCaseSchema.parse(makeFullCase({ sourcePublishedAt: '2026-03-02T00:00:00Z' }));
    const stamps = [record.sourceLastActivity, record.sourcePublishedAt, record.firstObservedAt, record.lastCheckedAt];
    expect(new Set(stamps).size).toBe(4);
  });
});

describe('verification states', () => {
  it('every state has a label and a documented meaning', () => {
    for (const status of VERIFICATION_STATUSES) {
      expect(VERIFICATION_LABELS[status].length).toBeGreaterThan(3);
      expect(VERIFICATION_MEANINGS[status].length).toBeGreaterThan(40);
    }
  });

  it('says plainly that "unavailable" is a gap and "verified" is not legal review', () => {
    expect(VERIFICATION_MEANINGS.unavailable).toMatch(/gap in the dataset/);
    expect(VERIFICATION_MEANINGS.verified_primary).toMatch(/does not mean a lawyer reviewed it/);
  });
});

describe('the published data release (real files in public/data)', () => {

  it('index files match their schemas', () => {
    expect(ManifestSchema.safeParse(read('manifest.json')).success).toBe(true);
    expect(SourcesFileSchema.safeParse(read('sources.json')).success).toBe(true);
    expect(CaseIndexSchema.safeParse(read('litigation/index.json')).success).toBe(true);
    expect(BillIndexSchema.safeParse(read('legislation/index.json')).success).toBe(true);
    expect(RelationshipFileSchema.safeParse(read('relationships.json')).success).toBe(true);
    expect(GeoIndexSchema.safeParse(read('geo/index.json')).success).toBe(true);
  });

  it('every case and bill record, the timeline and the courts file match their schemas (including https-only links)', () => {
    const failures: string[] = [];
    const check = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, path: string) => {
      const result = schema.safeParse(read(path));
      if (!result.success) failures.push(`${path}: ${result.error?.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    };
    const dir = (sub: string) => readdirSync(new URL(`../../public/data/${sub}`, import.meta.url)).filter((f) => f.endsWith('.json'));
    const cases = dir('litigation/cases');
    const bills = dir('legislation/bills');
    expect(cases.length).toBeGreaterThan(0);
    expect(bills.length).toBeGreaterThan(0);
    for (const file of cases) check(LegalCaseSchema, `litigation/cases/${file}`);
    for (const file of bills) check(LegislativeInstrumentSchema, `legislation/bills/${file}`);
    check(EventsFileSchema, 'events.json');
    check(CourtsFileSchema, 'courts.json');
    expect(failures).toEqual([]);
  });

  it('contains no synthetic fixture', () => {
    const text = JSON.stringify([read('litigation/index.json'), read('legislation/index.json'), read('relationships.json')]);
    expect(text).not.toMatch(/example\.test|synthetic/i);
    expect(makeBill().officialUrl).toContain('example.test');
  });
});
