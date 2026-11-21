/** Formatting helpers. Dates are rendered in UTC so a docket date never shifts by a day with the reader's time zone. */

const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});
const NUMBER = new Intl.NumberFormat('en-US');

export function parseIso(value: string): Date | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Apr 29, 2026". Returns the fallback for missing or unparseable input, never an invented date. */
export function formatDate(value: string | null | undefined, fallback = 'Not recorded'): string {
  if (!value) return fallback;
  const date = parseIso(value);
  return date ? DATE.format(date) : fallback;
}

/** "Nov 20, 2026, 01:12 UTC" */
export function formatDateTime(value: string | null | undefined, fallback = 'Never'): string {
  if (!value) return fallback;
  const date = parseIso(value);
  return date ? `${DATE_TIME.format(date)} UTC` : fallback;
}

export function formatNumber(value: number | null | undefined, fallback = 'Not available'): string {
  return typeof value === 'number' && Number.isFinite(value) ? NUMBER.format(value) : fallback;
}

export function formatPercent(fraction: number | null | undefined, digits = 1, fallback = 'Not available'): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return fallback;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSignedPercent(fraction: number, digits = 2): string {
  const pct = fraction * 100;
  const text = Math.abs(pct).toFixed(digits);
  if (Number(text) === 0) return `${text}%`;
  return `${pct > 0 ? '+' : '−'}${text}%`;
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = parseIso(fromIso);
  const to = parseIso(toIso);
  if (!from || !to) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${NUMBER.format(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Human label for a snake_case code such as an event type. */
export function humanize(code: string): string {
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
