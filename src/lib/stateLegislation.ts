/**
 * What was read of each state legislature through Open States (state-legislation/index.json), and why a legislature
 * has no measure listed. The list, the map and the page of a state all say it in the same words.
 */
import type { StateLegislationIndex, StateSession } from '../types/schemas';
import { STATE_NAME, stateFipsOfAbbr } from './geo';
import { plural } from './format';

/** What was read of one legislature: its sessions, how many measures they hold and what came of them. */
export interface LegislatureCoverage {
  state: string;
  stateAbbr: string;
  name: string;
  sessions: StateSession[];
  /** The measures Open States holds for those sessions. */
  measuresRead: number;
  listed: number;
  /** Measures the rule selected that are not listed, because Open States gives no secure page of the legislature for them. */
  withoutSecureLink: number;
  /** Why the legislature is not read at all, when it is one of those left out (California, Puerto Rico). */
  leftOut: string | null;
}

/** Every legislature the index reads or leaves out, by the lower-case abbreviation of its state. */
export function legislatureCoverage(index: StateLegislationIndex): Map<string, LegislatureCoverage> {
  const coverage = new Map<string, LegislatureCoverage>();
  const entry = (state: string, stateAbbr: string): LegislatureCoverage => {
    const key = stateAbbr.toLowerCase();
    let found = coverage.get(key);
    if (!found) {
      found = { state, stateAbbr, name: STATE_NAME[state] ?? stateAbbr, sessions: [], measuresRead: 0, listed: 0, withoutSecureLink: 0, leftOut: null };
      coverage.set(key, found);
    }
    return found;
  };
  for (const session of index.sessions) {
    const legislature = entry(session.state, session.stateAbbr);
    legislature.sessions.push(session);
    legislature.measuresRead += session.measuresRead;
    legislature.listed += session.listed;
    legislature.withoutSecureLink += session.withoutSecureLink;
  }
  for (const left of index.selection.leftOut) entry(left.state, left.stateAbbr).leftOut = left.reason;
  return coverage;
}

/** One legislature's coverage, by the abbreviation of its state in either case. */
export function coverageOf(index: StateLegislationIndex, stateAbbr: string): LegislatureCoverage | null {
  return legislatureCoverage(index).get(stateAbbr.toLowerCase()) ?? null;
}

/**
 * Why a legislature read through Open States has no measure listed, or null when it has one. California is read from
 * the Legislature's own data, so it is never named here.
 */
export function whyNoneListed(legislature: LegislatureCoverage): string | null {
  if (legislature.listed > 0 || legislature.stateAbbr === 'CA') return null;
  if (legislature.leftOut) return `Not covered: ${legislature.leftOut}.`;
  if (legislature.withoutSecureLink > 0) {
    return `Not listed yet: the selection rule picked ${plural(legislature.withoutSecureLink, 'measure')}, but Open States gives no secure address of the legislature’s page for ${legislature.withoutSecureLink === 1 ? 'it' : 'them'}, and this site links only to secure pages (rule secure-link-1). The daily update checks whether the legislature’s site answers securely.`;
  }
  if (legislature.sessions.length === 0) return 'No session of this legislature was read.';
  return `The selection rule picked none of the ${legislature.measuresRead.toLocaleString('en-US')} measures Open States holds for ${legislature.sessions.length === 1 ? 'the session' : 'the sessions'} read.`;
}

/**
 * The legislatures with no measure listed, in a few sentences for the coverage note of the list: those whose pages have
 * no secure address yet, those left out and why, and those of which the rule picked nothing.
 */
export function unlistedSummary(coverage: ReadonlyMap<string, LegislatureCoverage>): string | null {
  const all = [...coverage.values()].filter((l) => whyNoneListed(l)).sort((a, b) => a.name.localeCompare(b.name));
  const insecure = all.filter((l) => !l.leftOut && l.withoutSecureLink > 0).map((l) => l.name);
  const none = all.filter((l) => !l.leftOut && l.withoutSecureLink === 0).map((l) => l.name);
  const parts = [
    insecure.length > 0 ? `The measures of ${listNames(insecure)} are not listed yet: Open States gives no secure address of ${insecure.length === 1 ? 'its legislature’s pages' : 'their legislatures’ pages'}, and this site links only to secure pages (rule secure-link-1).` : null,
    ...all.filter((l) => l.leftOut).map((l) => `${l.leftOut}.`),
    none.length > 0 ? `The rule picked no measure of ${listNames(none)}.` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The legislatures with no measure listed, each with the reason, by state FIPS code: for the map's tooltip. */
export function unlistedNotes(index: StateLegislationIndex): Map<string, string> {
  const notes = new Map<string, string>();
  for (const legislature of legislatureCoverage(index).values()) {
    const why = whyNoneListed(legislature);
    const fips = stateFipsOfAbbr(legislature.stateAbbr) ?? legislature.state;
    if (why) notes.set(fips, why);
  }
  return notes;
}

/** Names joined as a sentence lists them: "Maryland", "Maryland and Vermont", "Iowa, Maryland and Vermont". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
