/**
 * How a measure is named, by the legislature it belongs to. A measure of Congress is cited by its own number
 * ("H.R. 22"). A state bill carries its state ("CA AB 604"), because bill numbers repeat from state to state.
 */
import { FEDERAL_STATE, STATE_MEASURE_ID_PATTERN, type LegislativeInstrumentSummary } from '../types/schemas';
import { STATE_NAME } from './geo';

type Named = Pick<LegislativeInstrumentSummary, 'state' | 'stateAbbr' | 'identifier'>;

export function isFederalBill(bill: Pick<LegislativeInstrumentSummary, 'state'>): boolean {
  return bill.state === FEDERAL_STATE;
}

/** "H.R. 22" for a measure of Congress, "CA AB 604" for a state bill. */
export function billLabel(bill: Named): string {
  return isFederalBill(bill) ? bill.identifier : `${bill.stateAbbr} ${bill.identifier}`;
}

/** The state of a state bill as a text names it ("Louisiana"), or its abbreviation where the name is not known. */
export function stateLabel(bill: Named): string {
  return STATE_NAME[bill.state] ?? bill.stateAbbr;
}

/**
 * A measure of a state legislature read from Open States (os-<state>-<session>-<number>): every state's but California's,
 * whose bills are read from the Legislature's own data and published in full.
 */
export function isStateMeasureId(id: string): boolean {
  return STATE_MEASURE_ID_PATTERN.test(id);
}

export function isStateMeasure(bill: Pick<LegislativeInstrumentSummary, 'id'>): boolean {
  return isStateMeasureId(bill.id);
}

/**
 * The stages a measure of a state legislature read from Open States can have reached, from the first to the furthest,
 * as rule state-status-1 orders them (os_bulk.STAGES in the pipeline).
 */
export const STATE_STAGES: readonly string[] = [
  'Introduced', 'Passed one chamber', 'Passed the legislature', 'Sent to the governor', 'Vetoed', 'Signed by the governor', 'Became law',
];

/** The measure as a heading names it: "H.R. 22" for a measure of Congress, "California AB 604" for a state bill. */
export function billHeading(bill: Named): string {
  return isFederalBill(bill) ? bill.identifier : `${stateLabel(bill)} ${bill.identifier}`;
}

/** "119th Congress" from "119th Congress (2025–2026)". A state's session is given as the legislature names it. */
export function shortSession(session: string): string {
  return session.replace(/\s*\([^)]*\)\s*$/, '');
}

/** The label with its session, for places where measures of different sessions can meet: "H.R. 22, 119th Congress". */
export function billLabelWithSession(bill: Named & Pick<LegislativeInstrumentSummary, 'session'>): string {
  return `${billLabel(bill)}, ${shortSession(bill.session)}`;
}

/**
 * The legislature a measure belongs to as an address gives it: "us" for Congress, the state's postal abbreviation in
 * lower case for a state legislature ("ca").
 */
export function billJurisdiction(bill: Pick<LegislativeInstrumentSummary, 'state' | 'stateAbbr'>): string {
  return isFederalBill(bill) ? 'us' : bill.stateAbbr.toLowerCase();
}

/**
 * What the status line of a measure is. California's Legislature reports a status of its own, which is shown as
 * reported. Congress's record has none, and Open States gives none: the stage is the furthest step among the recorded
 * actions, worked out by rule us-status-1 or state-status-1.
 */
export function statusNoun(bill: Pick<LegislativeInstrumentSummary, 'state' | 'id'>): string {
  return isFederalBill(bill) || isStateMeasure(bill) ? 'Stage reached' : 'Status as reported';
}

/**
 * The ways a measure's number is typed: "H.R. 22" is also looked for as "H.R.22", "HR 22" and "HR22", and "AB 604"
 * as "AB604".
 */
export function identifierVariants(identifier: string): string[] {
  const plain = identifier.replace(/\./g, '');
  return [...new Set([identifier, identifier.replace(/\s+/g, ''), plain, plain.replace(/\s+/g, '')])];
}

/** The kinds of measure in Congress, as its ids spell them and as they are cited. */
const US_KINDS: Readonly<Record<string, string>> = {
  hr: 'H.R.', s: 'S.', hjres: 'H.J.Res.', sjres: 'S.J.Res.', hconres: 'H.Con.Res.', sconres: 'S.Con.Res.', hres: 'H.Res.', sres: 'S.Res.',
};

/**
 * A measure's label from its id alone, for a link to a measure that no loaded index names: "H.R. 22" from
 * "us-119-hr22", "CA AB 604" from "ca-20252026-ab604".
 */
export function billLabelFromId(id: string): string | null {
  const federal = /^us-\d{3}-([a-z]+)(\d{1,5})$/.exec(id);
  if (federal) return US_KINDS[federal[1]!] ? `${US_KINDS[federal[1]!]} ${federal[2]}` : null;
  const state = /^([a-z]{2})-\d{8}-([a-z]{2,3})(\d{1,5})$/.exec(id);
  return state ? `${state[1]!.toUpperCase()} ${state[2]!.toUpperCase()} ${state[3]}` : null;
}

/**
 * Whether a measure is adopted rather than enacted. In California that is every resolution and constitutional
 * amendment. In Congress it is a simple or a concurrent resolution: a joint resolution is acted on like a bill.
 */
export function isAdoptedMeasure(bill: Pick<LegislativeInstrumentSummary, 'state' | 'measureType'>): boolean {
  return isFederalBill(bill) ? /^(?:House|Senate) (?:Concurrent )?Resolution$/.test(bill.measureType) : /Resolution|Constitutional Amendment/.test(bill.measureType);
}

/**
 * The stages a measure of Congress can have reached, from the first to the furthest, as rule us-status-1 orders them
 * (STATUS_ORDER in the pipeline). The site uses the order only to list stages; a stage it does not know is listed last.
 */
export const FEDERAL_STAGES: readonly string[] = [
  'Introduced', 'Reported by committee', 'Failed in the House', 'Failed in the Senate', 'Not agreed to in the House', 'Not agreed to in the Senate',
  'Passed the House', 'Passed the Senate', 'Agreed to in the House', 'Agreed to in the Senate', 'Passed House and Senate, not sent to the President',
  'Agreed to in House and Senate', 'Sent to the President', 'Vetoed', 'Became law',
];

/**
 * The two stages that mean a vote of passage in each chamber and no later step. The votes can be on different texts
 * (one chamber passes the other's bill with an amendment), so wherever one of them is shown a sentence says so.
 */
export const PASSED_IN_EACH_STAGES: ReadonlySet<string> = new Set(['Passed House and Senate, not sent to the President', 'Agreed to in House and Senate']);
export const PASSED_IN_EACH_NOTE = 'Each chamber has voted to pass this measure. The record does not show that both passed the same text: one chamber can pass the other’s bill with an amendment, which the first must then accept.';
/** The same in a few words, for a row of a list. */
export const PASSED_IN_EACH_SHORT = 'a vote in each chamber, not necessarily on the same text';
/** The same for a table or a menu of stages, where no single measure is meant. */
export const PASSED_IN_EACH_LIST_NOTE = 'A stage that names both chambers means a vote of passage in each. The record does not show that both passed the same text: one chamber can pass the other’s bill with an amendment, which the first must then accept.';

/**
 * Where a stage stands in that order, from 0 for "Introduced". A stage the list does not hold, or none, ranks -1: below
 * every known stage, so that it is never taken for the furthest and sorts last in a list ordered by how far a measure got.
 */
export function stageRank(stage: string | null | undefined): number {
  return FEDERAL_STAGES.indexOf(stage ?? '');
}

/** The source of the texts of the measures of Congress (sources.json). Their status record names another source, the measure's own. */
export const FEDERAL_TEXT_SOURCE_ID = 'govinfo-bills';
