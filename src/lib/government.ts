/**
 * Who holds the offices that make and sign election law: the governor and the chambers of a state, and for the
 * United States the President, the Senate and the House (government.json, rules party-*).
 *
 * The pipeline decides which party a chamber or a government is shown in the colour of. This module finds the record
 * of a place and puts into words what the record holds. It adds nothing: a part without a party is said to have none.
 */
import type { ChamberSeats, ColouredParty, Government, GovernmentControl, GovernmentFile, PartySeats } from '../types/schemas';
import { NATION_KEY } from './geo';

export const PARTY_NAMES: Readonly<Record<ColouredParty, string>> = { R: 'Republican', D: 'Democratic' };
export const CONTROL_NAMES: Readonly<Record<GovernmentControl, string>> = { R: 'Republican', D: 'Democratic', divided: 'Divided', undetermined: 'Not determined' };
/** The sources the records are read from, for the lists of sources of a place. */
export const GOVERNMENT_SOURCE_IDS = { federal: ['senate-members', 'house-clerk-members'], state: ['nga-governors', 'openstates-people'] } as const;

export class GovernmentIndex {
  readonly generatedAt: string;
  readonly all: readonly Government[];
  private readonly byId: Map<string, Government>;

  constructor(file: GovernmentFile) {
    this.generatedAt = file.generatedAt;
    this.all = file.governments;
    this.byId = new Map(file.governments.map((record) => [record.id, record]));
  }

  /** The record of a map unit ("state:06", "nation:US"), if one is published for it. */
  get(key: string): Government | undefined {
    return this.byId.get(key);
  }

  get nation(): Government | undefined {
    return this.byId.get(NATION_KEY);
  }

  /** The fifty states, in the order of the file. */
  get states(): Government[] {
    return this.all.filter((record) => record.id.startsWith('state:'));
  }
}

export function seatsOf(chamber: ChamberSeats, group: PartySeats['group']): number {
  return chamber.parties.filter((entry) => entry.group === group).reduce((total, entry) => total + entry.seats, 0);
}

/** The seats a party needs for more than half of the chamber, or null when the number of seats is not known. */
export function majorityMark(chamber: ChamberSeats): number | null {
  return chamber.seats === null ? null : Math.floor(chamber.seats / 2) + 1;
}

/** True for a chamber most of whose seats are held without a party label (the Nebraska Legislature). */
export function electedWithoutParties(chamber: ChamberSeats): boolean {
  return chamber.lead === null && chamber.seats !== null && seatsOf(chamber, 'N') * 2 > chamber.seats;
}

/**
 * Rule party-trifecta-1 as the pipeline applies it, worked out again from the published parts. The data check
 * compares the two, so a record cannot say "Republican" over parts that do not add up to it.
 */
export function controlOf(record: Pick<Government, 'executive' | 'chambers' | 'missingChambers'>): GovernmentControl {
  if (!record.executive || record.chambers.length === 0 || record.missingChambers.length > 0) return 'undetermined';
  if (record.chambers.some((chamber) => chamber.seats === null || electedWithoutParties(chamber))) return 'undetermined';
  const party = record.executive.group;
  if (party !== 'R' && party !== 'D') return 'divided';
  return record.chambers.every((chamber) => chamber.lead === party) ? party : 'divided';
}

/** Rule party-seats-1 for a chamber whose majority is counted from its seats. */
export function leadBySeats(chamber: Pick<ChamberSeats, 'parties' | 'seats'>): ColouredParty | null {
  if (chamber.seats === null) return null;
  for (const group of ['R', 'D'] as const) {
    const seats = chamber.parties.filter((entry) => entry.group === group).reduce((total, entry) => total + entry.seats, 0);
    if (seats * 2 > chamber.seats) return group;
  }
  return null;
}

const CHAMBER_WORDS: Readonly<Record<ChamberSeats['chamber'], string>> = { upper: 'upper chamber', lower: 'lower chamber', legislature: 'legislature' };

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "the Senate", "the House", but "the Nebraska Legislature" as it is. */
function theChamber(chamber: ChamberSeats): string {
  return `the ${chamber.name}`;
}

/** The office of the executive in running text: "governor", "President". */
function officeWord(record: Government): string {
  return record.id === NATION_KEY ? 'President' : 'governor';
}

/**
 * Why a government is "not determined", as one sentence. Each reason is one the record itself holds: no executive was
 * read, a chamber was not read, a list of members does not fit the seats, or the members carry no party label.
 */
export function whyUndetermined(record: Government): string {
  const reasons: string[] = [];
  if (!record.executive) reasons.push(record.executiveNote ?? `No ${officeWord(record)} was read from a source.`);
  for (const key of record.missingChambers) reasons.push(`No source could be read for the ${CHAMBER_WORDS[key]}.`);
  for (const chamber of record.chambers) {
    if (chamber.seats === null) reasons.push(`The source lists more members of ${theChamber(chamber)} than it has seats, so no majority is worked out.`);
    else if (electedWithoutParties(chamber)) reasons.push(`The members of ${theChamber(chamber)} are elected without party labels.`);
  }
  return reasons.join(' ');
}

/**
 * The parts of a government in a few words, the way a tooltip or a heading names them: "Republican governor and
 * legislature", "Democratic governor; Republican Senate and House", "Republican governor and Senate; no party holds
 * more than half of the House".
 */
export function controlSummary(record: Government): string {
  const office = officeWord(record);
  if (record.control === 'undetermined') return 'Not determined';
  if (record.control !== 'divided') {
    const party = PARTY_NAMES[record.control];
    if (record.id === NATION_KEY) return `${party} ${office}, ${list(record.chambers.map((chamber) => chamber.name))}`;
    return `${party} ${office} and legislature`;
  }
  // Group the parts by the party that holds them, in the order executive, upper, lower.
  const held = new Map<string, string[]>();
  const add = (side: string, part: string) => held.set(side, [...(held.get(side) ?? []), part]);
  const executive = record.executive!;
  add(executive.group === 'R' || executive.group === 'D' ? PARTY_NAMES[executive.group] : executive.party, office);
  const none: string[] = [];
  for (const chamber of record.chambers) {
    if (chamber.lead) add(PARTY_NAMES[chamber.lead], chamber.name);
    else none.push(theChamber(chamber));
  }
  const phrases = [...held].map(([side, parts]) => `${side} ${list(parts)}`);
  if (none.length > 0) phrases.push(`no party holds more than half of ${list(none)}`);
  return phrases.join('; ');
}

/** How many of the fifty states are held by each party, divided, or not determined. */
export function controlTally(states: readonly Government[]): Record<GovernmentControl, number> {
  const tally: Record<GovernmentControl, number> = { R: 0, D: 0, divided: 0, undetermined: 0 };
  for (const record of states) tally[record.control] += 1;
  return tally;
}

/** The seats of a chamber in the order they are drawn: Democratic from the left, Republican from the right, the others between. */
export interface SeatSegment { kind: 'D' | 'other' | 'vacant' | 'R'; seats: number; label: string }

export function seatSegments(chamber: ChamberSeats): SeatSegment[] {
  const others = chamber.parties.filter((entry) => entry.group !== 'R' && entry.group !== 'D');
  const segments: SeatSegment[] = [
    { kind: 'D', seats: seatsOf(chamber, 'D'), label: 'Democratic' },
    ...others.map((entry): SeatSegment => ({ kind: 'other', seats: entry.seats, label: entry.name })),
    { kind: 'vacant', seats: chamber.vacant ?? 0, label: 'Vacant' },
    { kind: 'R', seats: seatsOf(chamber, 'R'), label: 'Republican' },
  ];
  return segments.filter((segment) => segment.seats > 0);
}

/** "Republican 53, Democratic 45, Independent 2", largest first, then the vacant seats. */
export function seatLine(chamber: ChamberSeats): string {
  const parts = chamber.parties.map((entry) => `${entry.name} ${entry.seats}`);
  if (chamber.vacant) parts.push(`vacant ${chamber.vacant}`);
  return parts.join(', ');
}
