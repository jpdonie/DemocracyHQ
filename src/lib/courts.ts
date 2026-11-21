/**
 * The federal courts the site covers: the Supreme Court and the thirteen courts of appeals.
 *
 * Twelve of the courts of appeals are regional: each hears appeals from the federal district courts of the states and
 * territories its circuit is made of, which 28 U.S.C. § 41 lists. Those are the circuits drawn on the map. The
 * thirteenth, the Federal Circuit, takes cases by subject from every district, so it has no area of its own.
 */
import type { CircuitsFile, Court, LegalCaseSummary } from '../types/schemas';
import { CIRCUIT_CASE_ID_PATTERN } from '../types/schemas';
import { CONTIGUOUS_BOUNDS, unionBbox, type Bbox, type GeoIndex } from './geo';
import { buildHash } from './router';

export const SCOTUS_ID = 'scotus';
export const FEDERAL_CIRCUIT_ID = 'cafc';
/** The value of the court filter that stands for all thirteen courts of appeals together. */
export const ALL_APPEALS = 'appeals';

/** The court id of a regional circuit's map unit: "05" is ca5, "DC" is cadc. The mapping is fixed by the ids themselves. */
export function circuitCourtId(geoid: string): string | null {
  if (geoid === 'DC') return 'cadc';
  const number = /^(0[1-9]|1[01])$/.test(geoid) ? Number(geoid) : null;
  return number ? `ca${number}` : null;
}

/** The map unit of a regional circuit's court: "circuit:05" for ca5, "circuit:DC" for cadc. Null for the Federal Circuit and the Supreme Court. */
export function courtGeoKey(courtId: string): string | null {
  if (courtId === 'cadc') return 'circuit:DC';
  const match = /^ca([1-9]|1[01])$/.exec(courtId);
  return match ? `circuit:${match[1]!.padStart(2, '0')}` : null;
}

export function isAppealsCourtId(value: string | undefined): boolean {
  return /^(?:ca(?:[1-9]|1[01])|cadc|cafc)$/.test(value ?? '');
}

/** A court id as a route segment may give it: only the ids the site knows. */
export function isCourtId(value: string | undefined): boolean {
  return value === SCOTUS_ID || isAppealsCourtId(value);
}

/** The court a case is in, from its id: "ca5" for ca5-25-30725. Every other published case is a Supreme Court docket. */
export function courtIdOfCase(caseId: string): string {
  return CIRCUIT_CASE_ID_PATTERN.test(caseId) ? caseId.slice(0, caseId.indexOf('-')) : SCOTUS_ID;
}

/** Whether a case's court passes the court filter: one court by its id, or "appeals" for any court of appeals. */
export function matchesCourt(courtId: string, filter: string): boolean {
  return filter === ALL_APPEALS ? courtId !== SCOTUS_ID : courtId === filter;
}

export function courtHash(courtId: string): string {
  return buildHash(['court', courtId]);
}

const ORDINAL_WORDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh'];
/** Reporter-style abbreviations: "5th Cir.", and "2d" and "3d" as legal citations write them. */
const ORDINAL_CITES = ['1st', '2d', '3d', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th'];

function circuitNumber(courtId: string): number | null {
  const match = /^ca([1-9]|1[01])$/.exec(courtId);
  return match ? Number(match[1]) : null;
}

/**
 * The fourteen courts' names as fixed text, for the places the directory file does not reach: a search entry or a file
 * name made before geo/circuits.json has loaded. Wherever the file is at hand its own names are used; a test checks
 * that the two agree.
 */
export function fixedShortName(courtId: string): string | null {
  if (courtId === SCOTUS_ID) return 'Supreme Court';
  if (courtId === 'cadc') return 'D.C. Circuit';
  if (courtId === FEDERAL_CIRCUIT_ID) return 'Federal Circuit';
  const number = circuitNumber(courtId);
  return number ? `${ORDINAL_WORDS[number - 1]} Circuit` : null;
}

/** "United States Court of Appeals for the Fifth Circuit"; "Supreme Court of the United States". */
export function fixedFullName(courtId: string): string | null {
  if (courtId === SCOTUS_ID) return 'Supreme Court of the United States';
  if (courtId === 'cadc') return 'United States Court of Appeals for the District of Columbia Circuit';
  const short = fixedShortName(courtId);
  return short ? `United States Court of Appeals for the ${short}` : null;
}

/** The court as a citation names it in parentheses: "U.S.", "5th Cir.", "D.C. Cir.", "Fed. Cir.". */
export function courtCitation(courtId: string): string {
  if (courtId === SCOTUS_ID) return 'U.S.';
  if (courtId === 'cadc') return 'D.C. Cir.';
  if (courtId === FEDERAL_CIRCUIT_ID) return 'Fed. Cir.';
  const number = circuitNumber(courtId);
  return number ? `${ORDINAL_CITES[number - 1]} Cir.` : courtId;
}

export class CourtDirectory {
  readonly supreme: Court | undefined;
  /** The thirteen courts of appeals, in the statute's order: First to Eleventh, District of Columbia, Federal. */
  readonly appeals: readonly Court[];
  readonly statute: CircuitsFile['statute'];
  readonly withoutCircuit: readonly string[];
  readonly notOnTheMap: readonly string[];
  private readonly byId = new Map<string, Court>();
  private readonly byGeoKey = new Map<string, Court>();
  private readonly ofState: Readonly<Record<string, string>>;

  constructor(supremeCourts: readonly Court[], circuits: CircuitsFile) {
    this.supreme = supremeCourts.find((court) => court.id === SCOTUS_ID);
    this.appeals = circuits.courts;
    this.statute = circuits.statute;
    this.withoutCircuit = circuits.withoutCircuit;
    this.notOnTheMap = circuits.notOnTheMap;
    this.ofState = circuits.circuitOfState;
    for (const court of [...supremeCourts, ...circuits.courts]) {
      this.byId.set(court.id, court);
      if (court.geoKey) this.byGeoKey.set(court.geoKey, court);
    }
  }

  get(id: string): Court | undefined {
    return this.byId.get(id);
  }

  /** The court whose circuit a map unit is ("circuit:05"). */
  forGeoKey(key: string): Court | undefined {
    return this.byGeoKey.get(key);
  }

  /** The court of appeals for the circuit a state or territory is in, if it is in one. */
  forState(stateFips: string): Court | undefined {
    const id = this.ofState[stateFips];
    return id ? this.byId.get(id) : undefined;
  }

  /** The name used in lists: "Fifth Circuit", "Supreme Court". */
  shortName(id: string): string {
    return courtShortName(this.byId.get(id), id);
  }

  /** The court's full name: "United States Court of Appeals for the Fifth Circuit". */
  fullName(id: string): string {
    return courtFullName(this.byId.get(id), id);
  }

  /** The regional circuits: the twelve courts of appeals that have an area on the map. */
  get regional(): readonly Court[] {
    return this.appeals.filter((court) => Boolean(court.geoKey));
  }
}

export function courtShortName(court: Court | undefined, id: string): string {
  if (id === SCOTUS_ID) return 'Supreme Court';
  return court?.shortName ?? fixedShortName(id) ?? court?.name ?? id;
}

export function courtFullName(court: Court | undefined, id: string): string {
  return court?.name ?? fixedFullName(id) ?? id;
}

/**
 * The area the map shows for a regional circuit: its states among the contiguous 48 and the District of Columbia when
 * it has any, so that Alaska, Hawaii or a territory far away does not shrink the rest to a dot. The locator buttons
 * reach the others.
 */
export function circuitViewBbox(court: Court, geo: GeoIndex): Bbox | null {
  const boxes = court.states.map((fips) => geo.state(fips)?.bbox).filter((box): box is Bbox => Boolean(box));
  const [west, south, east, north] = CONTIGUOUS_BOUNDS;
  const near = boxes.filter((box) => box[0] >= west - 1 && box[2] <= east + 1 && box[1] >= south - 1 && box[3] <= north + 1);
  return unionBbox(near.length > 0 ? near : boxes);
}

/** How many published cases each court has. */
export function casesByCourt(cases: readonly LegalCaseSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of cases) counts.set(record.courtId, (counts.get(record.courtId) ?? 0) + 1);
  return counts;
}

/**
 * One row for each decision: a court of appeals files one opinion for appeals it decides together, and every one of
 * those appeals is a case of its own in the record. `decidedWith` (rule same-opinion-1) names the others, so the
 * group is listed once, under its first case in the order given, with the rest attached.
 */
export interface CaseGroup<T extends Pick<LegalCaseSummary, 'id' | 'decidedWith'>> {
  record: T;
  /** The other cases decided in the same opinion that are in the list given. */
  others: T[];
}

export function groupDecidedTogether<T extends Pick<LegalCaseSummary, 'id' | 'decidedWith'>>(cases: readonly T[]): CaseGroup<T>[] {
  const byId = new Map(cases.map((record) => [record.id, record]));
  const taken = new Set<string>();
  const groups: CaseGroup<T>[] = [];
  for (const record of cases) {
    if (taken.has(record.id)) continue;
    taken.add(record.id);
    const others: T[] = [];
    for (const partner of record.decidedWith) {
      const other = byId.get(partner.caseId);
      if (!other || taken.has(other.id)) continue;
      taken.add(other.id);
      others.push(other);
    }
    groups.push({ record, others });
  }
  return groups;
}
