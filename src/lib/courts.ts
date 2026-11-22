/**
 * The federal courts the site covers: the Supreme Court and the thirteen courts of appeals.
 *
 * Twelve of the courts of appeals are regional: each hears appeals from the federal district courts of the states and
 * territories its circuit is made of, which 28 U.S.C. § 41 lists. Those are the circuits drawn on the map. The
 * thirteenth, the Federal Circuit, takes cases by subject from every district, so it has no area of its own.
 */
import type { CircuitsFile, Court, LegalCaseSummary } from '../types/schemas';
import { CIRCUIT_CASE_ID_PATTERN, type OTHER_COURT_TYPES } from '../types/schemas';
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

/**
 * The court a case is in, from its id: "ca5" for ca5-25-30725, the Supreme Court for scotus-24-109. An id of neither
 * form (a mistyped address) names no court.
 */
export function courtIdOfCase(caseId: string): string | null {
  if (CIRCUIT_CASE_ID_PATTERN.test(caseId)) return caseId.slice(0, caseId.indexOf('-'));
  return caseId.startsWith(`${SCOTUS_ID}-`) ? SCOTUS_ID : null;
}

/** Whether a case's court passes the court filter: one court by its id, or "appeals" for any court of appeals. */
export function matchesCourt(courtId: string, filter: string): boolean {
  return filter === ALL_APPEALS ? isAppealsCourtId(courtId) : courtId === filter;
}

/* ---------- kinds of court ---------- */

/** What kind of court a case is in: one of the two federal kinds the site lists itself, or the kind its record names. */
export type CourtKind = 'federal_supreme' | 'federal_appellate' | (typeof OTHER_COURT_TYPES)[number];
export type CourtSystem = 'federal' | 'state';
export type CourtLevel = 'supreme' | 'appellate' | 'trial';
type CourtOf = Pick<LegalCaseSummary, 'courtId' | 'court'>;

/** The kind of court a case is in. Null for a record that names neither a known court nor a kind (none is published). */
export function courtKind(record: CourtOf): CourtKind | null {
  if (record.courtId === SCOTUS_ID) return 'federal_supreme';
  if (isAppealsCourtId(record.courtId)) return 'federal_appellate';
  return record.court?.courtType ?? null;
}

export function systemOfKind(kind: CourtKind): CourtSystem {
  return kind.startsWith('federal_') ? 'federal' : 'state';
}

/** The level of a kind of court within its system. A federal district court is the trial court of the federal system. */
export function levelOfKind(kind: CourtKind): CourtLevel {
  return kind.endsWith('_supreme') ? 'supreme' : kind.endsWith('_appellate') ? 'appellate' : 'trial';
}

export function courtSystem(record: CourtOf): CourtSystem | null {
  const kind = courtKind(record);
  return kind ? systemOfKind(kind) : null;
}

export function courtLevel(record: CourtOf): CourtLevel | null {
  const kind = courtKind(record);
  return kind ? levelOfKind(kind) : null;
}

export function isCourtSystem(value: string | undefined): value is CourtSystem {
  return value === 'federal' || value === 'state';
}

export function isCourtLevel(value: string | undefined): value is CourtLevel {
  return value === 'supreme' || value === 'appellate' || value === 'trial';
}

/** The courts of one system and level, as a menu or a sentence names them. Without a system the name fits both. */
export function levelName(level: CourtLevel, system?: CourtSystem | null): string {
  if (system === 'federal') return level === 'supreme' ? 'Supreme Court' : level === 'appellate' ? 'Courts of appeals' : 'District courts';
  if (system === 'state') return level === 'supreme' ? 'State supreme courts' : level === 'appellate' ? 'State appellate courts' : 'State trial courts';
  return level === 'supreme' ? 'Supreme courts' : level === 'appellate' ? 'Appellate courts' : 'Trial courts';
}

/**
 * How a case is known. The Supreme Court's dockets are the Court's own; a court of appeals case is known from the
 * documents GovInfo holds for it; a case of a district court or a state court from the decisions CourtListener holds.
 * The three are worded differently wherever a record is shown.
 */
export type RecordBasis = 'docket' | 'govinfo' | 'courtlistener';

export function recordBasis(record: Pick<LegalCaseSummary, 'courtId'>): RecordBasis {
  if (record.courtId === SCOTUS_ID) return 'docket';
  return isAppealsCourtId(record.courtId) ? 'govinfo' : 'courtlistener';
}

/** Where the name of a case's court leads: the court's page for the fourteen federal courts, else the list of its cases. */
export function caseCourtHash(record: CourtOf): string {
  return isCourtId(record.courtId) ? courtHash(record.courtId) : buildHash(['litigation'], { court: record.courtId });
}

/** A case's court by its full name: "United States Court of Appeals for the Fifth Circuit", "Supreme Court of Oklahoma". */
export function caseCourtFullName(record: CourtOf, court?: Court): string {
  return record.court?.name ?? courtFullName(court, record.courtId);
}

/**
 * A case's court as a list names it: "Supreme Court of the United States", "Fifth Circuit", and for the other courts
 * the name the record gives, with a federal district court shortened to "U.S. District Court, N.D. Texas" style only
 * where the record gives a citation form; otherwise its name in full.
 */
export function caseCourtListName(record: CourtOf, court?: Court): string {
  if (record.courtId === SCOTUS_ID) return fixedFullName(SCOTUS_ID)!;
  if (record.court) return record.court.name.replace(/^United States District Court for the /, 'U.S. District Court, ');
  return courtShortName(court, record.courtId);
}

/** A case's court in a citation's parentheses: "5th Cir.", "N.D. Tex.", or the court's name where no short form is given. */
export function caseCourtCitation(record: CourtOf): string {
  return record.court ? (record.court.citation || record.court.name) : courtCitation(record.courtId);
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

/** How many published cases each kind of court has, and how many different courts of that kind have one. */
export function casesByKind(cases: readonly CourtOf[]): Map<CourtKind, { cases: number; courts: number }> {
  const courtsOf = new Map<CourtKind, Set<string>>();
  const counts = new Map<CourtKind, { cases: number; courts: number }>();
  for (const record of cases) {
    const kind = courtKind(record);
    if (!kind) continue;
    const seen = courtsOf.get(kind) ?? new Set<string>();
    courtsOf.set(kind, seen.add(record.courtId));
    counts.set(kind, { cases: (counts.get(kind)?.cases ?? 0) + 1, courts: seen.size });
  }
  return counts;
}

/** The cases of the courts of the states, of every level together. */
export function stateCourtCases(counts: ReadonlyMap<CourtKind, { cases: number; courts: number }>): { cases: number; courts: number } {
  const kinds: CourtKind[] = ['state_supreme', 'state_appellate', 'state_trial'];
  return kinds.reduce((total, kind) => ({ cases: total.cases + (counts.get(kind)?.cases ?? 0), courts: total.courts + (counts.get(kind)?.courts ?? 0) }), { cases: 0, courts: 0 });
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
