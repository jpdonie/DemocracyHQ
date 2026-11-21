import type { LegalCaseSummary, LegislativeInstrumentSummary } from '../types/schemas';

export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesQuery(haystack: readonly (string | null | undefined)[], query: string): boolean {
  const q = normalizeText(query);
  if (!q) return true;
  const text = normalizeText(haystack.filter(Boolean).join(' \n '));
  return q.split(' ').every((token) => text.includes(token));
}

export interface CaseFilters {
  q?: string;
  tag?: string;
  /** State FIPS code; matches cases whose record supports a link to that state. */
  state?: string;
  /** Event type of the latest dispositive docket entry, or "none". */
  ruling?: string;
  /** Inclusive ISO dates applied to the latest docket activity reported by the source. */
  from?: string;
  to?: string;
  sort?: 'activity' | 'docketed' | 'name';
}

export function filterCases(cases: readonly LegalCaseSummary[], filters: CaseFilters): LegalCaseSummary[] {
  const result = cases.filter((c) => {
    if (!matchesQuery([c.caseName, c.docketNumber, c.petitionerTitle, c.respondentTitle, c.lowerCourt.name, ...c.lowerCourt.caseNumbers], filters.q ?? '')) return false;
    if (filters.tag && !c.issueTags.some((t) => t.tag === filters.tag)) return false;
    if (filters.state && !c.stateFips.includes(filters.state)) return false;
    if (filters.ruling) {
      const type = c.latestDispositiveEntry?.eventType ?? 'none';
      if (type !== filters.ruling) return false;
    }
    // A record with no activity date cannot be shown to fall inside a date range, so it is excluded when one is set.
    if (filters.from && (!c.sourceLastActivity || c.sourceLastActivity < filters.from)) return false;
    if (filters.to && (!c.sourceLastActivity || c.sourceLastActivity > filters.to)) return false;
    return true;
  });
  const sort = filters.sort ?? 'activity';
  return result.sort((a, b) => {
    if (sort === 'name') return a.caseName.localeCompare(b.caseName);
    const key = sort === 'docketed' ? 'dateDocketed' : 'sourceLastActivity';
    return (b[key] ?? '').localeCompare(a[key] ?? '') || a.id.localeCompare(b.id);
  });
}

export interface BillFilters {
  q?: string;
  tag?: string;
  /** Measure state exactly as reported by the legislature, e.g. "Chaptered". */
  status?: string;
  type?: string;
  sort?: 'action' | 'number' | 'introduced';
}

/** "AB 604" -> ["AB", 604] for natural ordering. */
export function identifierParts(identifier: string): [string, number] {
  const match = /^([A-Za-z]+)\s*(\d+)$/.exec(identifier.trim());
  return match ? [match[1]!.toUpperCase(), Number(match[2])] : [identifier, 0];
}

export function filterBills(bills: readonly LegislativeInstrumentSummary[], filters: BillFilters): LegislativeInstrumentSummary[] {
  const result = bills.filter((b) => {
    if (!matchesQuery([b.identifier, b.identifier.replace(/\s+/g, ''), b.subject, b.title, b.leadAuthors, b.chapter?.citation], filters.q ?? '')) return false;
    if (filters.tag && !b.issueTags.some((t) => t.tag === filters.tag)) return false;
    if (filters.status && (b.legislativeStatus.currentStatus ?? 'Not recorded') !== filters.status) return false;
    if (filters.type && b.measureType !== filters.type) return false;
    return true;
  });
  const sort = filters.sort ?? 'action';
  return result.sort((a, b) => {
    if (sort === 'number') {
      const [pa, na] = identifierParts(a.identifier);
      const [pb, nb] = identifierParts(b.identifier);
      return pa.localeCompare(pb) || na - nb;
    }
    const key = sort === 'introduced' ? 'introducedDate' : 'lastActionDate';
    return (b[key] ?? '').localeCompare(a[key] ?? '') || a.id.localeCompare(b.id);
  });
}

/** Distinct values with counts, for building filter menus from the data itself. */
export function countBy<T>(items: readonly T[], keys: (item: T) => readonly string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) for (const key of new Set(keys(item))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/* ---------- query values from the address ---------- */

/** A positive whole number from the address (for example `show=160`), or `fallback` for anything else ("-5", "1.5", "abc"). */
export function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d{1,6}$/.test(value)) return fallback;
  const n = Number(value);
  return n > 0 ? n : fallback;
}

/**
 * A calendar date (YYYY-MM-DD) from the address, or undefined. Only a date that exists is accepted ("2020-02-31" and
 * "2099-13-45" are not), because a date field cannot show anything else: a filter applied from an impossible date would
 * narrow the list while the field looked empty.
 */
export function isoDateParam(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  // Year 0000 is not a valid date for a date field either.
  if (year < 1) return undefined;
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, does not read years below 100 as 19xx.
  date.setUTCFullYear(year, month - 1, day);
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

/** A filter value only when it is one of the choices the menu offers; otherwise no filter, so the list and the menu agree. */
export function knownValue(value: string | undefined, options: Iterable<string>): string | undefined {
  if (!value) return undefined;
  for (const option of options) if (option === value) return value;
  return undefined;
}

/**
 * Case filters with unknown menu values dropped (the menus are built from the cases themselves) and malformed dates ignored.
 * A state is kept when some case links to it, or when `isState` (the map's index of states and territories) knows it:
 * a state selected on the map that no case links to then gives an empty list, not the whole list. A code that is neither
 * (a mistyped link) is dropped.
 */
export function knownCaseFilters(filters: CaseFilters, cases: readonly LegalCaseSummary[], isState?: (fips: string) => boolean): CaseFilters {
  const state = filters.state;
  return {
    ...filters,
    tag: knownValue(filters.tag, cases.flatMap((c) => c.issueTags.map((t) => t.tag))),
    state: knownValue(state, cases.flatMap((c) => c.stateFips)) ?? (state && /^\d{2}$/.test(state) && isState?.(state) ? state : undefined),
    ruling: knownValue(filters.ruling, cases.map((c) => c.latestDispositiveEntry?.eventType ?? 'none')),
    from: isoDateParam(filters.from),
    to: isoDateParam(filters.to),
  };
}

/** Bill filters with unknown menu values dropped. */
export function knownBillFilters(filters: BillFilters, bills: readonly LegislativeInstrumentSummary[]): BillFilters {
  return {
    ...filters,
    tag: knownValue(filters.tag, bills.flatMap((b) => b.issueTags.map((t) => t.tag))),
    status: knownValue(filters.status, bills.map((b) => b.legislativeStatus.currentStatus ?? 'Not recorded')),
    type: knownValue(filters.type, bills.map((b) => b.measureType)),
  };
}
