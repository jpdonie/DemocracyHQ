/**
 * Global search across places, courts, cases and bills. Results are deterministic prefix matches. Only when a query
 * matches nothing are close spellings offered, and they are labelled as suggestions, never mixed into the results.
 */
import type { LegalCaseSummary, LegislativeInstrumentSummary } from '../types/schemas';
import { billLabel, identifierVariants, isFederalBill } from './bills';
import {
  FEDERAL_CIRCUIT_ID, SCOTUS_ID, courtCitation, courtFullName, courtHash, courtShortName, fixedFullName, type CourtDirectory,
} from './courts';
import { normalizeText } from './filters';
import { NATION_KEY, STATE_ABBR, stateKind, type GeoIndex, type GeoUnit } from './geo';
import { buildHash } from './router';

export type SearchKind = 'place' | 'court' | 'case' | 'bill';

export interface SearchEntry {
  kind: SearchKind;
  id: string;
  label: string;
  detail: string;
  hash: string;
  /** Normalised text the query is matched against. */
  text: string;
  /** Lower sorts first among equal matches. */
  rank: number;
}

function placeEntry(unit: GeoUnit): SearchEntry {
  const abbr = STATE_ABBR[unit.stateFips] ?? '';
  let detail: string = stateKind(unit.stateFips);
  let alias = abbr;
  let rank = 0;
  if (unit.layer === 'county') {
    detail = 'County, 2025 boundaries';
    alias = `${abbr}`;
    rank = 2;
  } else if (unit.layer === 'cd119' || unit.layer === 'cd120') {
    const number = unit.geoid.slice(2);
    const short = number === '00' || number === '98' ? 'AL' : String(Number(number));
    detail = unit.layer === 'cd119' ? 'Congressional district, 119th Congress' : 'Congressional district, 120th Congress (2026 elections)';
    alias = `${abbr}-${short} ${abbr}${short} ${abbr} ${short} ${abbr}-${number}`;
    rank = unit.layer === 'cd120' ? 1 : 1.5;
  }
  return {
    kind: 'place', id: unit.key, label: unit.name, detail, hash: buildHash(['place', unit.key]),
    text: normalizeText(`${unit.name} ${alias} ${unit.geoid}`), rank,
  };
}

/** The United States as one place: where the measures of Congress and the federal courts are gathered. */
function nationEntry(unit: GeoUnit): SearchEntry {
  return {
    kind: 'place', id: unit.key, label: unit.name, detail: 'Federal level: Congress and the federal courts', hash: buildHash(['place', unit.key]),
    text: normalizeText(`${unit.name} US U.S. USA federal nationwide Congress`), rank: -1,
  };
}

/**
 * The fourteen courts. A regional circuit is also found by the states it is made of, so that typing a state's name
 * shows the court of appeals for it.
 */
function courtEntries(courts: CourtDirectory, geo: GeoIndex | null): SearchEntry[] {
  const entries: SearchEntry[] = [{
    kind: 'court', id: SCOTUS_ID, label: fixedFullName(SCOTUS_ID)!, detail: 'The highest federal court', hash: courtHash(SCOTUS_ID),
    text: normalizeText('Supreme Court of the United States SCOTUS'), rank: 0,
  }];
  for (const court of courts.appeals) {
    const states = court.states.map((fips) => geo?.stateName(fips) ?? '').filter(Boolean);
    const short = courtShortName(court, court.id);
    entries.push({
      kind: 'court', id: court.id, label: short,
      detail: court.id === FEDERAL_CIRCUIT_ID ? 'Court of appeals with no region: it takes cases by subject' : states.length > 0 ? `Appeals from ${states.join(', ')}` : courtFullName(court, court.id),
      hash: courtHash(court.id),
      text: normalizeText(`${short} ${courtFullName(court, court.id)} ${courtCitation(court.id)} ${court.id} ${states.join(' ')}`), rank: 1,
    });
  }
  return entries;
}

export function buildSearchIndex(
  geo: GeoIndex | null,
  cases: readonly LegalCaseSummary[],
  bills: readonly LegislativeInstrumentSummary[],
  courts: CourtDirectory | null = null,
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  if (geo) {
    const nation = geo.get(NATION_KEY);
    if (nation) entries.push(nationEntry(nation));
    for (const layer of ['state', 'cd120', 'cd119', 'county'] as const) for (const unit of geo.all(layer)) entries.push(placeEntry(unit));
  }
  if (courts) entries.push(...courtEntries(courts, geo));
  for (const c of cases) {
    const court = c.courtId === SCOTUS_ID ? fixedFullName(SCOTUS_ID)! : courtShortName(courts?.get(c.courtId), c.courtId);
    entries.push({
      kind: 'case', id: c.id, label: c.caseName, detail: `No. ${c.docketNumber}, ${court}`,
      hash: buildHash(['litigation', c.id]),
      text: normalizeText(`${c.caseName} ${c.docketNumber} no. ${c.docketNumber} ${c.lowerCourt.caseNumbers.join(' ')} ${c.courtId === SCOTUS_ID ? '' : court}`), rank: 0,
    });
  }
  for (const b of bills) {
    entries.push({
      kind: 'bill', id: b.id, label: billLabel(b), detail: b.subject ?? b.title ?? b.session,
      hash: buildHash(['laws', b.id]),
      text: normalizeText(`${isFederalBill(b) ? '' : b.stateAbbr} ${identifierVariants(b.identifier).join(' ')} ${b.subject ?? ''} ${b.chapter?.citation ?? ''}`), rank: 0,
    });
  }
  return entries;
}

/** A label as it is compared with what was typed: without full stops, so "hr 22" is "H.R. 22" and "v" is "v.". */
const undotted = (text: string) => text.replace(/\./g, '').replace(/\s+/g, ' ').trim();

function score(entry: SearchEntry, query: string, tokens: readonly string[]): number | null {
  const words = entry.text.split(' ');
  for (const token of tokens) {
    if (!words.some((word) => word.startsWith(token))) return null;
  }
  const label = undotted(normalizeText(entry.label));
  const typed = undotted(query);
  let value = entry.rank;
  if (label === typed) value -= 10;
  else if (label.startsWith(typed)) value -= 5;
  else if (entry.text.includes(query)) value -= 2;
  return value + entry.label.length / 1000;
}

export interface SearchGroup { kind: SearchKind; title: string; entries: SearchEntry[]; total: number }

const GROUP_TITLES: Readonly<Record<SearchKind, string>> = { place: 'Places', court: 'Courts', case: 'Court cases', bill: 'Legislation' };
/** The order the groups are listed in. */
export const GROUP_ORDER: readonly SearchKind[] = ['place', 'court', 'case', 'bill'];

/**
 * The longest query that is searched. A name, docket number or bill number is far shorter; text pasted by mistake
 * (a paragraph, a page) is cut here so that each keystroke stays quick.
 */
export const MAX_QUERY_LENGTH = 200;

function normalizedQuery(rawQuery: string): string {
  return normalizeText(rawQuery.slice(0, MAX_QUERY_LENGTH * 2)).slice(0, MAX_QUERY_LENGTH).trim();
}

export function search(index: readonly SearchEntry[], rawQuery: string, perGroup = 6): SearchGroup[] {
  const query = normalizedQuery(rawQuery);
  if (query.length < 2) return [];
  const tokens = [...new Set(query.split(' '))];
  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  for (const entry of index) {
    const value = score(entry, query, tokens);
    if (value !== null) scored.push({ entry, score: value });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label));
  const groups: SearchGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const matches = scored.filter((s) => s.entry.kind === kind);
    if (matches.length > 0) groups.push({ kind, title: GROUP_TITLES[kind], entries: matches.slice(0, perGroup).map((m) => m.entry), total: matches.length });
  }
  return groups;
}

/* ---------- close spellings ---------- */

/** Words shorter than this are never matched approximately: short words have too many neighbours. */
export const FUZZY_MIN_LENGTH = 5;

/**
 * Close spellings are looked for only in a short query: a name or a title of a few words. A longer query (often text
 * pasted by mistake) gets no suggestions, so the search never holds up the page comparing it with every indexed word.
 */
export const FUZZY_MAX_WORDS = 6;

/** Typed words longer than this are not matched approximately (no indexed name is that long). */
const FUZZY_MAX_LENGTH = 30;

/** Edits allowed for a word of this length: one up to 7 letters, two from 8. */
function allowedEdits(length: number): number {
  return length >= 8 ? 2 : 1;
}

/** Edit distance with adjacent transpositions (optimal string alignment): "calais" is one edit from "callais". */
export function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      current.push(value);
    }
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}

const bare = (word: string) => word.replace(/[^\p{L}\p{N}]+/gu, '');
const fuzzyToken = (token: string) => bare(token).length >= FUZZY_MIN_LENGTH && bare(token).length <= FUZZY_MAX_LENGTH && /\p{L}/u.test(token);

/** Edits between a typed word and a word in the index, also counting a typed word that is the start of a longer one. */
function closeness(token: string, word: string): number {
  if (word.startsWith(token)) return 0;
  const max = allowedEdits(token.length);
  if (word.length + 1 < token.length - max) return Infinity;
  let best = Infinity;
  for (const length of [word.length, token.length - 1, token.length, token.length + 1]) {
    if (length < 1 || length > word.length) continue;
    best = Math.min(best, editDistance(token, word.slice(0, length)));
  }
  return best <= max ? best : Infinity;
}

const wordCache = new WeakMap<readonly SearchEntry[], { words: string[][]; vocabulary: Set<string> }>();

function indexWords(index: readonly SearchEntry[]) {
  let cached = wordCache.get(index);
  if (!cached) {
    const words = index.map((entry) => entry.text.split(' ').map(bare).filter(Boolean));
    cached = { words, vocabulary: new Set(words.flat()) };
    wordCache.set(index, cached);
  }
  return cached;
}

export interface SearchResult {
  groups: SearchGroup[];
  /** True when nothing matched exactly and the groups hold close spellings instead. */
  approximate: boolean;
}

/**
 * Exact results when there are any. Otherwise, for a query of up to six words, entries whose words are within one or two
 * edits of each typed word of 5 or more letters (shorter words must still match exactly), offered as "Did you mean"
 * suggestions.
 */
export function searchWithSuggestions(index: readonly SearchEntry[], rawQuery: string, perGroup = 6): SearchResult {
  const exact = search(index, rawQuery, perGroup);
  const query = normalizedQuery(rawQuery);
  if (exact.length > 0 || query.length < 2) return { groups: exact, approximate: false };
  const tokens = [...new Set(query.split(' '))];
  if (tokens.length > FUZZY_MAX_WORDS || !tokens.some(fuzzyToken)) return { groups: [], approximate: false };
  const { words, vocabulary } = indexWords(index);
  // For each long typed word, the indexed words close to it and how many edits away they are.
  const close = tokens.map((token) => {
    if (!fuzzyToken(token)) return null;
    const typed = bare(token);
    const near = new Map<string, number>();
    for (const word of vocabulary) {
      const edits = closeness(typed, word);
      if (edits !== Infinity) near.set(word, edits);
    }
    return near;
  });
  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  index.forEach((entry, i) => {
    const entryWords = words[i]!;
    const rawWords = entry.text.split(' ');
    let edits = 0;
    for (let t = 0; t < tokens.length; t += 1) {
      const near = close[t];
      if (!near) {
        if (!rawWords.some((word) => word.startsWith(tokens[t]!))) return;
        continue;
      }
      let best = Infinity;
      for (const word of entryWords) best = Math.min(best, near.get(word) ?? Infinity);
      if (best === Infinity) return;
      edits += best;
    }
    scored.push({ entry, score: edits * 10 + entry.rank + entry.label.length / 1000 });
  });
  scored.sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label));
  const groups: SearchGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const matches = scored.filter((s) => s.entry.kind === kind);
    if (matches.length > 0) groups.push({ kind, title: GROUP_TITLES[kind], entries: matches.slice(0, perGroup).map((m) => m.entry), total: matches.length });
  }
  return { groups, approximate: groups.length > 0 };
}
