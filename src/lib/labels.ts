import { loadClassification } from './data';
import { humanize } from './format';
import { useLoad } from './useLoad';

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();

/** Issue-tag labels come from the published rule file, so the interface and the rules cannot disagree. */
export function useTagLabels(): ReadonlyMap<string, string> {
  const classification = useLoad('tag-labels', async () => new Map((await loadClassification()).issueRules.map((rule) => [rule.tag, rule.label])));
  return classification.status === 'ready' ? classification.data : EMPTY_LABELS;
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  decision: 'Opinion or judgment',
  summary_disposition: 'Summary disposition',
  application_ruling: 'Ruling on an application',
  interim_order: 'Interim order',
  review_granted: 'Review granted or jurisdiction noted',
  review_denied: 'Review denied',
  dismissed: 'Dismissed',
  argued: 'Argued',
  judgment_issued: 'Judgment issued',
  restored_for_reargument: 'Restored for reargument',
  argument_scheduled: 'Argument scheduled',
  initiating_filing: 'Petition, appeal or application filed',
  application_referred: 'Application referred',
  procedural_application: 'Procedural application',
  time_extension: 'Extension of time',
  amicus_brief: 'Amicus brief',
  filing: 'Filing',
  motion: 'Motion',
  motion_ruling: 'Ruling on a motion',
  conference_distribution: 'Distributed for conference',
  record: 'Record',
  not_accepted: 'Not accepted for filing',
  response_requested: 'Response requested',
  question_order: 'Order on the questions or the parties',
  jurisdiction_postponed: 'Jurisdiction postponed to the merits',
  rehearing_ruling: 'Ruling on rehearing',
  scheduling_notice: 'Scheduling notice',
  docket_entry: 'Docket entry',
  introduced: 'Introduced',
  passed_house: 'Passed a house',
  passed_senate: 'Passed or agreed to in the Senate',
  reported: 'Reported by committee',
  committee_discharged: 'Committee discharged',
  presented_to_president: 'Presented to the President',
  approved_by_president: 'Signed by the President',
  became_law: 'Became law',
  veto_override_passed: 'Passed over the veto',
  veto_override_failed: 'Failed of passage over the veto',
  conference_report_agreed: 'Conference report agreed to',
  resolving_differences: 'Resolving differences between the chambers',
  enrolled: 'Enrolled',
  approved_by_governor: 'Approved by the Governor',
  chaptered: 'Chaptered',
  vetoed: 'Vetoed',
  veto_stands: 'Veto stands',
  action_rescinded: 'Earlier action rescinded',
  vote_failed: 'Vote failed',
  concurred: 'Amendments concurred in',
  died: 'Died',
  amended: 'Amended',
  committee_action: 'Committee action',
  floor_action: 'Floor action',
  referral: 'Referral',
  calendar: 'Calendar entry',
  legislative_action: 'Legislative action',
  text_version_changed: 'Text changed',
  opinion: 'Opinion',
  judgment: 'Judgment',
  order: 'Order',
  errata: 'Errata',
  procedural_termination: 'Procedural termination',
  court_document: 'Court document',
  boundary_data_published: 'Boundary data published',
  boundary_files_updated: 'Census boundary files updated',
};

/**
 * Labels that depend on whose record an entry comes from. The id of the rule that named the entry says so: "us-" is a
 * rule for the measures of Congress and "ca-doc-" a rule for the documents of the courts of appeals ("ca-" alone is a
 * rule for California's legislature). The same type means different things there: "passed_house" is either house in
 * Sacramento and the House of Representatives in Washington.
 */
const FEDERAL_EVENT_LABELS: Readonly<Record<string, string>> = {
  passed_house: 'Passed or agreed to in the House',
  vote_failed: 'Failed of passage or not agreed to',
  vetoed: 'Vetoed by the President',
};

const CIRCUIT_EVENT_LABELS: Readonly<Record<string, string>> = {
  decision: 'Decision',
};

export const isFederalRule = (ruleId: string | null | undefined): boolean => Boolean(ruleId?.startsWith('us-'));
export const isCircuitRule = (ruleId: string | null | undefined): boolean => Boolean(ruleId?.startsWith('ca-doc-'));

/**
 * The label of an event type. Pass the id of the rule that assigned the type wherever the record gives one, so that an
 * entry of Congress or of a court of appeals gets its own wording.
 */
export function eventLabel(eventType: string, ruleId?: string | null): string {
  const own = isFederalRule(ruleId) ? FEDERAL_EVENT_LABELS[eventType] : isCircuitRule(ruleId) ? CIRCUIT_EVENT_LABELS[eventType] : undefined;
  return own ?? EVENT_LABELS[eventType] ?? humanize(eventType);
}

const RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
  concerns_congressional_plan: 'Concerns a congressional district plan of',
  concerns_legislative_plan: 'Concerns a state legislative district plan of',
  concerns_local_plan: 'Concerns local district lines in',
  concerns_district: 'Concerns the district',
  concerns_state_law: 'Concerns an election law of',
  concerns_state_practice: 'Concerns an election practice of',
  concerns_ballot: 'Concerns the ballot in',
  located_in_state: 'The local government concerned is in',
  defines_congressional_districts: 'Defines congressional districts for',
  operative_only_if: 'Operative only if this measure takes effect:',
  operative_only_if_not: 'Operative only if this measure does not take effect:',
  adopts_districts_from: 'Adopts the districts set out in',
  submits_to_voters: 'Submits to the voters',
  litigation_concerns_measure: 'Litigation concerning',
};

export function relationshipLabel(type: string): string {
  return RELATIONSHIP_LABELS[type] ?? humanize(type);
}

/** The same links read from the other end, for the page of the record a link points to. */
const REVERSE_RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
  operative_only_if: 'Takes effect, in whole or in part, only if this measure does:',
  operative_only_if_not: 'Takes effect, in whole or in part, only if this measure does not:',
  adopts_districts_from: 'Adopts the districts this measure sets out:',
  submits_to_voters: 'Submitted this measure to the voters:',
  defines_congressional_districts: 'Congressional districts defined by',
  litigation_concerns_measure: 'Litigation concerning this measure:',
};

export function reverseRelationshipLabel(type: string): string {
  return REVERSE_RELATIONSHIP_LABELS[type] ?? `Linked from (${relationshipLabel(type).replace(/:$/, '').toLowerCase()})`;
}

export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  statewide: 'Whole state',
  county: 'County',
  congressional_district: 'Congressional district',
  multi_state: 'Several states',
  unknown: 'Scope not established',
};
