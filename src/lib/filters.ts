import type { LegalCaseSummary, LegislativeInstrumentSummary } from '../types/schemas';
import { billJurisdiction, identifierVariants, isFederalBill } from './bills';
import { STATE_ABBR } from './geo';
import { ALL_APPEALS, courtLevel, courtSystem, isCourtId, isCourtLevel, isCourtSystem, matchesCourt, type CourtLevel, type CourtSystem } from './courts';

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
  /**
   * State FIPS code. It matches the cases whose record supports a link to that state and the appeals that began in a
   * federal district court there (see `caseStates`).
   */
  state?: string;
  /** The federal courts or the courts of the states. */
  system?: CourtSystem;
  /** The level of the court within its system: the highest court, the appellate courts or the trial courts. */
  level?: CourtLevel;
  /** "scotus", "appeals" (any of the thirteen courts of appeals) or the id of one court. */
  court?: string;
  /** Event type of the latest dispositive docket entry, or "none". */
  ruling?: string;
  /** Inclusive ISO dates applied to the latest docket activity reported by the source. */
  from?: string;
  to?: string;
  sort?: 'activity' | 'docketed' | 'name';
}

/**
 * The states a case is listed under: those its record links it to, for an appeal the state of the district court it
 * came from, and for a case of a district court or a state court the state of that court. The last two say where the
 * case began or is heard, not what it concerns; the views that use them say so.
 */
export function caseStates(c: Pick<LegalCaseSummary, 'stateFips' | 'origin' | 'court'>): string[] {
  const states = [...c.stateFips];
  for (const fips of [c.origin?.stateFips, c.court?.stateFips]) if (fips && !states.includes(fips)) states.push(fips);
  return states.length === c.stateFips.length ? c.stateFips : states;
}

/** How many cases are listed under each state (see `caseStates`), for the litigation list's map. */
export function caseStateCounts(cases: readonly Pick<LegalCaseSummary, 'stateFips' | 'origin' | 'court'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of cases) for (const stateFips of caseStates(record)) counts.set(stateFips, (counts.get(stateFips) ?? 0) + 1);
  return counts;
}

/** The date a case is ordered by when sorted by its start: the docketing date, or the first entry the source holds. */
export function caseStartDate(c: Pick<LegalCaseSummary, 'dateDocketed' | 'dateFirstEntry'>): string {
  return c.dateDocketed ?? c.dateFirstEntry ?? '';
}

export function filterCases(cases: readonly LegalCaseSummary[], filters: CaseFilters): LegalCaseSummary[] {
  const result = cases.filter((c) => {
    // The search reads what a row shows: the names and numbers, and the passage quoted on what the case is about.
    if (!matchesQuery([c.caseName, c.docketNumber, c.petitionerTitle, c.respondentTitle, c.lowerCourt.name, c.origin?.court, c.court?.name, ...c.lowerCourt.caseNumbers, c.about?.text, c.about?.later?.text], filters.q ?? '')) return false;
    if (filters.tag && !c.issueTags.some((t) => t.tag === filters.tag)) return false;
    if (filters.state && !caseStates(c).includes(filters.state)) return false;
    if (filters.system && courtSystem(c) !== filters.system) return false;
    if (filters.level && courtLevel(c) !== filters.level) return false;
    if (filters.court && !matchesCourt(c.courtId, filters.court)) return false;
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
    const key = sort === 'docketed' ? caseStartDate : (c: LegalCaseSummary) => c.sourceLastActivity ?? '';
    return key(b).localeCompare(key(a)) || a.id.localeCompare(b.id);
  });
}

export interface BillFilters {
  q?: string;
  tag?: string;
  /**
   * The legislature: "us" for Congress, a state's postal abbreviation in lower case for its legislature ("ca"), or
   * "states" for every state legislature.
   */
  jur?: string;
  /**
   * The status line of the measure: for a state bill the status as its legislature reports it ("Chaptered"), for a
   * measure of Congress the stage reached ("Passed the House"). The two use different terms, so a status is only
   * applied within one legislature.
   */
  status?: string;
  type?: string;
  sort?: 'action' | 'number' | 'introduced';
}

/** "AB 604" -> ["AB", 604] and "H.J.Res. 12" -> ["H.J.RES.", 12], for natural ordering. */
export function identifierParts(identifier: string): [string, number] {
  const match = /^(.*?)\s*(\d+)$/.exec(identifier.trim());
  return match && match[1] ? [match[1].toUpperCase(), Number(match[2])] : [identifier, 0];
}

const statusOf = (b: LegislativeInstrumentSummary) => b.legislativeStatus.currentStatus ?? 'Not recorded';

/** The value of `jur` that stands for every state legislature. */
export const ALL_STATES = 'states';

/** Whether a measure belongs to the legislature `jur` names (see `BillFilters.jur`). */
export function inJurisdiction(b: Pick<LegislativeInstrumentSummary, 'state' | 'stateAbbr'>, jur: string | undefined): boolean {
  if (!jur) return true;
  return jur === ALL_STATES ? !isFederalBill(b) : billJurisdiction(b) === jur;
}

/** The lower-case abbreviations of the states and territories the map knows, which `jur` may name though no measure is listed. */
const KNOWN_STATES: ReadonlySet<string> = new Set(Object.values(STATE_ABBR).map((abbr) => abbr.toLowerCase()));

export function filterBills(bills: readonly LegislativeInstrumentSummary[], filters: BillFilters): LegislativeInstrumentSummary[] {
  const result = bills.filter((b) => {
    // The search reads what a row shows: number and titles (also the title the selection rule matched), and the passage quoted on what the measure would do.
    if (!matchesQuery([...identifierVariants(b.identifier), b.subject, b.title, b.selection?.matchedTitle, b.selection?.matchedText, b.leadAuthors, b.chapter?.citation, b.about?.text], filters.q ?? '')) return false;
    if (filters.tag && !b.issueTags.some((t) => t.tag === filters.tag)) return false;
    if (!inJurisdiction(b, filters.jur)) return false;
    if (filters.status && statusOf(b) !== filters.status) return false;
    if (filters.type && b.measureType !== filters.type) return false;
    return true;
  });
  const sort = filters.sort ?? 'action';
  return result.sort((a, b) => {
    if (sort === 'number') {
      // Congress first, then each legislature's measures by kind and number.
      const [pa, na] = identifierParts(a.identifier);
      const [pb, nb] = identifierParts(b.identifier);
      return Number(isFederalBill(b)) - Number(isFederalBill(a)) || a.stateAbbr.localeCompare(b.stateAbbr) || pa.localeCompare(pb) || na - nb;
    }
    const key = sort === 'introduced' ? 'introducedDate' : 'lastActionDate';
    return (b[key] ?? '').localeCompare(a[key] ?? '') || a.id.localeCompare(b.id);
  });
}

/** How many measures of each state's own legislature a list holds, by state FIPS code, for the map of legislation. */
export function billStateCounts(bills: readonly Pick<LegislativeInstrumentSummary, 'state'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of bills) if (!isFederalBill(b)) counts.set(b.state, (counts.get(b.state) ?? 0) + 1);
  return counts;
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
 * A state is kept when some case is listed under it, or when `isState` (the map's index of states and territories) knows it:
 * a state selected on the map that no case is listed under then gives an empty list, not the whole list. A code that is
 * neither (a mistyped link) is dropped. A court is kept when it is one of the fourteen the site knows, whether or not
 * any of its cases is published: the Federal Circuit then gives an empty list with the reason, not the whole list.
 * Any other court is kept when one of its cases is published. A system or a level is kept when it is one of the words
 * the menus use. "appeals" as a court, which older links use for the thirteen courts of appeals together, is read as
 * the federal system at the appellate level, which is what the menus now call it.
 */
export function knownCaseFilters(filters: CaseFilters, cases: readonly LegalCaseSummary[], isState?: (fips: string) => boolean): CaseFilters {
  const state = filters.state;
  const allAppeals = filters.court === ALL_APPEALS;
  return {
    ...filters,
    tag: knownValue(filters.tag, cases.flatMap((c) => c.issueTags.map((t) => t.tag))),
    state: knownValue(state, cases.flatMap(caseStates)) ?? (state && /^\d{2}$/.test(state) && isState?.(state) ? state : undefined),
    system: allAppeals ? 'federal' : isCourtSystem(filters.system) ? filters.system : undefined,
    level: allAppeals ? 'appellate' : isCourtLevel(filters.level) ? filters.level : undefined,
    court: allAppeals ? undefined : isCourtId(filters.court) ? filters.court : knownValue(filters.court, cases.map((c) => c.courtId)),
    ruling: knownValue(filters.ruling, cases.map((c) => c.latestDispositiveEntry?.eventType ?? 'none')),
    from: isoDateParam(filters.from),
    to: isoDateParam(filters.to),
  };
}

/**
 * Bill filters with unknown menu values dropped. A status or a type is kept only within one legislature, because
 * Congress and a state legislature use different terms for both. A link that gives one without a legislature (as
 * links did while there was a single legislature) is read as the legislature that uses that term, when only one does.
 */
export function knownBillFilters(filters: BillFilters, bills: readonly LegislativeInstrumentSummary[]): BillFilters {
  const legislatures = [...new Set(bills.map(billJurisdiction))];
  // Every state legislature together; or a state the map knows though none of its measures is listed, which then gives
  // an empty list with the reason rather than the whole list.
  let jur = filters.jur === ALL_STATES && bills.some((b) => !isFederalBill(b)) ? ALL_STATES
    : knownValue(filters.jur, legislatures) ?? (filters.jur && KNOWN_STATES.has(filters.jur) ? filters.jur : undefined);
  if (!jur && (filters.status || filters.type)) {
    const using = legislatures.filter((legislature) => bills.some((b) => billJurisdiction(b) === legislature
      && (!filters.status || statusOf(b) === filters.status) && (!filters.type || b.measureType === filters.type)));
    if (using.length === 1) jur = using[0];
  }
  const pool = jur ? bills.filter((b) => inJurisdiction(b, jur)) : bills;
  // A status or a kind is one legislature's word: not applied to all of them, nor to every state at once.
  const single = Boolean(jur && jur !== ALL_STATES);
  return {
    ...filters,
    jur,
    tag: knownValue(filters.tag, pool.flatMap((b) => b.issueTags.map((t) => t.tag))),
    status: single ? knownValue(filters.status, pool.map(statusOf)) : undefined,
    type: single ? knownValue(filters.type, pool.map((b) => b.measureType)) : undefined,
  };
}
