import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EFFECTIVE_HEADLINES, effectiveHeadline, effectiveHeadlineGuide } from '../../src/features/legislation/BillDetail';
import { LegislativeInstrumentSchema, type LegislativeInstrument } from '../../src/types/schemas';
import { makeFullBill } from './fixtures';

const status = (currentStatus: string | null) => ({ measureState: currentStatus, currentStatus, currentHouse: null, currentLocation: null });
const notEnacted = (overrides: Partial<LegislativeInstrument> = {}) => makeFullBill({
  approvedDate: null, chapteredDate: null, chapter: null,
  effective: { date: null, basis: 'not_enacted', note: 'Not enacted.' },
  ...overrides,
});
const TEXTS: ReadonlySet<string> = new Set(Object.values(EFFECTIVE_HEADLINES).map((h) => h.text));

describe('effective-date headline', () => {
  it('shows a date only when the data has one', () => {
    expect(effectiveHeadline(makeFullBill({ effective: { date: '2026-01-01', basis: 'immediate_effect_flag', note: 'n' } }))).toBe('Jan 1, 2026');
    expect(effectiveHeadline(makeFullBill({ effective: { date: '2027-01-01', basis: 'stated_in_text', note: 'n' } }))).toBe('Jan 1, 2027');
    expect(effectiveHeadline(makeFullBill())).toBe('Not verified');
  });

  it('never says "yet": a bill still in the legislature is "not enacted as of the last check"', () => {
    for (const s of ['In Committee Process', 'Pending Referral', 'In Floor Process', null]) {
      const headline = effectiveHeadline(notEnacted({ legislativeStatus: status(s) }));
      expect(headline, String(s)).toBe('None: not enacted as of the last check');
      expect(headline).not.toMatch(/\byet\b/i);
    }
  });

  it('says "not enacted" for a bill that died or failed', () => {
    for (const s of ['Died', 'Failed']) expect(effectiveHeadline(notEnacted({ legislativeStatus: status(s) }))).toBe('None: not enacted');
  });

  it('does not call a veto final: the Legislature can override it (Cal. Const. art. IV, sec. 10(a))', () => {
    expect(effectiveHeadline(notEnacted({ legislativeStatus: status('Vetoed') }))).toBe('None: vetoed, not enacted as of the last check');
    expect(effectiveHeadline(notEnacted({ legislativeStatus: status('Enrolled'), vetoedDate: '2026-09-30' }))).toBe('None: vetoed, not enacted as of the last check');
  });

  it('says "not adopted" for a constitutional amendment, which is adopted and filed rather than enacted', () => {
    expect(effectiveHeadline(notEnacted({ measureType: 'Assembly Constitutional Amendment', legislativeStatus: status('Pending Referral') }))).toBe('None: not adopted as of the last check');
    expect(effectiveHeadline(notEnacted({ measureType: 'Senate Constitutional Amendment', legislativeStatus: status('Died') }))).toBe('None: not adopted');
  });

  it('says "Not applicable" for a resolution', () => {
    expect(effectiveHeadline(makeFullBill({ measureType: 'Senate Joint Resolution', effective: { date: null, basis: 'not_applicable', note: 'n' } }))).toBe('Not applicable');
  });

  it('the Sources page names every headline the cell can show, and the cell shows nothing else', () => {
    const guide = effectiveHeadlineGuide();
    for (const text of TEXTS) expect(guide).toContain(`“${text}”`);
    expect(guide.match(/“[^”]+”/g)?.length).toBe(TEXTS.size);
    expect(guide).not.toMatch(/\byet\b/i);

    // Every published bill gets a date or one of the listed headlines.
    const dir = new URL('../../public/data/legislation/bills/', import.meta.url);
    const seen = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const bill = LegislativeInstrumentSchema.parse(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
      const headline = effectiveHeadline(bill);
      if (bill.effective.date) expect(headline).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
      else {
        expect(TEXTS.has(headline), `${file}: ${headline}`).toBe(true);
        seen.add(headline);
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});
