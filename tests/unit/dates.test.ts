import { describe, expect, it } from 'vitest';
import { daysBetween, formatDate, formatDateTime, formatNumber, formatPercent, formatSignedPercent, humanize, parseIso, plural } from '../../src/lib/format';
import { isRecordStale, sourceFreshness } from '../../src/lib/freshness';
import { makeSource, NOW } from './fixtures';

describe('date formatting', () => {
  it('renders a docket date in UTC so it never shifts by a day', () => {
    expect(formatDate('2026-04-29')).toBe('Apr 29, 2026');
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate('2026-12-31T23:59:59Z')).toBe('Dec 31, 2026');
  });

  it('labels timestamps as UTC', () => {
    expect(formatDateTime('2026-11-20T01:12:00Z')).toBe('Nov 20, 2026, 01:12 UTC');
  });

  it('never invents a date for missing or unreadable input', () => {
    expect(formatDate(null)).toBe('Not recorded');
    expect(formatDate(undefined)).toBe('Not recorded');
    expect(formatDate('')).toBe('Not recorded');
    expect(formatDate('sometime in spring')).toBe('Not recorded');
    expect(formatDateTime(null)).toBe('Never');
    expect(parseIso('2026-13-45')).toBeNull();
  });

  it('counts whole days between timestamps', () => {
    expect(daysBetween('2026-06-14T10:00:00Z', '2026-06-15T12:00:00Z')).toBe(1);
    expect(daysBetween('2026-06-14T13:00:00Z', '2026-06-15T12:00:00Z')).toBe(0);
    expect(daysBetween('2026-06-01', '2026-06-15')).toBe(14);
    expect(daysBetween('garbage', '2026-06-15')).toBeNull();
  });
});

describe('number formatting', () => {
  it('groups thousands and refuses to print a non-number as a count', () => {
    expect(formatNumber(331449281)).toBe('331,449,281');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(null)).toBe('Not available');
    expect(formatNumber(Number.NaN)).toBe('Not available');
  });

  it('formats shares and signed deviations', () => {
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(null)).toBe('Not available');
    expect(formatSignedPercent(0.0012)).toBe('+0.12%');
    expect(formatSignedPercent(-0.0012)).toBe('−0.12%');
    expect(formatSignedPercent(0.000001)).toBe('0.00%');
  });

  it('pluralises and humanises', () => {
    expect(plural(1, 'case')).toBe('1 case');
    expect(plural(1234, 'case')).toBe('1,234 cases');
    expect(plural(2, 'county', 'counties')).toBe('2 counties');
    expect(humanize('cert_denied')).toBe('Cert denied');
  });
});

describe('source freshness is computed from the last successful check', () => {
  it('is fresh inside the window', () => {
    const f = sourceFreshness(makeSource(), NOW);
    expect(f).toEqual({ state: 'fresh', ageDays: 1, label: 'Checked 1 day ago' });
  });

  it('says "today" for a check made the same day', () => {
    expect(sourceFreshness(makeSource({ lastSuccessfulCheck: '2026-06-15T06:00:00Z' }), NOW).label).toBe('Checked today');
  });

  it('turns stale by itself when the deployment stops refreshing', () => {
    const f = sourceFreshness(makeSource({ lastSuccessfulCheck: '2026-06-01T10:00:00Z', staleAfterDays: 7 }), NOW);
    expect(f.state).toBe('stale');
    expect(f.label).toBe('Stale: last checked 14 days ago');
    // Exactly on the limit is still fresh; one day more is stale.
    expect(sourceFreshness(makeSource({ lastSuccessfulCheck: '2026-06-08T12:00:00Z', staleAfterDays: 7 }), NOW).state).toBe('fresh');
    expect(sourceFreshness(makeSource({ lastSuccessfulCheck: '2026-06-07T12:00:00Z', staleAfterDays: 7 }), NOW).state).toBe('stale');
  });

  it('a failed refresh shows the age of the data still on display, not the time of the failed attempt', () => {
    const f = sourceFreshness(makeSource({ processingStatus: 'failed', lastSuccessfulCheck: '2026-06-10T10:00:00Z', lastAttempt: '2026-06-15T11:00:00Z' }), NOW);
    expect(f.state).toBe('failed');
    expect(f.ageDays).toBe(5);
    expect(f.label).toBe('Last refresh failed; showing data checked 5 days ago');
  });

  it('distinguishes never retrieved, failed before any success, and missing credential', () => {
    expect(sourceFreshness(makeSource({ processingStatus: 'not_run', lastSuccessfulCheck: null }), NOW)).toEqual({ state: 'never_checked', ageDays: null, label: 'Never retrieved' });
    expect(sourceFreshness(makeSource({ processingStatus: 'failed', lastSuccessfulCheck: null }), NOW).state).toBe('failed');
    expect(sourceFreshness(makeSource({ processingStatus: 'credential_missing', lastSuccessfulCheck: null }), NOW)).toEqual({
      state: 'credential_missing', ageDays: null, label: 'Not active: needs an API credential',
    });
  });

  it('treats a record with an unreadable check time as stale, never as fresh', () => {
    expect(isRecordStale('not a date', 7, NOW)).toBe(true);
    expect(isRecordStale('2026-06-14T10:00:00Z', 7, NOW)).toBe(false);
    expect(isRecordStale('2026-05-01T10:00:00Z', 7, NOW)).toBe(true);
  });
});
