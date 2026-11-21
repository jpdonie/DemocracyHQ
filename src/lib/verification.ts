import type { VerificationStatus } from '../types/schemas';

export const VERIFICATION_LABELS: Readonly<Record<VerificationStatus, string>> = {
  verified_primary: 'Checked against the official source',
  imported_secondary: 'Imported from secondary source',
  awaiting_review: 'Awaiting review',
  disputed: 'Disputed',
  outdated: 'Outdated',
  unavailable: 'Unavailable',
};

/** What each state means in practice. Shown on the methodology page. */
export const VERIFICATION_MEANINGS: Readonly<Record<VerificationStatus, string>> = {
  verified_primary:
    'The record was retrieved from the official publisher (a court, legislature or the Census Bureau) and parsed without error, and it links to that source. It matches what the source published when DemocracyHQ last checked it. DemocracyHQ’s own rule outputs shown with it (entry labels, issue tags, the latest-ruling entry and derived dates) and the link descriptions written by maintainers are not part of that check. It does not mean a lawyer reviewed it. On a link between records, the state means that the quoted passage was found in the cited document when that document was last fetched.',
  imported_secondary:
    'The record came from a non-official aggregator and has not been compared with the primary source. Treat it as a lead and confirm with the court or legislature.',
  awaiting_review:
    'An automatic check could not be completed and a maintainer has not yet looked at the record. Curated links never carry this state: a link whose passage is not found in its document is not published at all.',
  disputed: 'A reader or maintainer has reported a specific problem with the record that has not been resolved yet.',
  outdated: 'The source has changed or been superseded since the record was captured, and DemocracyHQ has not captured the new version.',
  unavailable: 'DemocracyHQ does not have this information. This is a gap in the dataset, not a statement that nothing exists.',
};

/**
 * States that nothing in DemocracyHQ assigns yet. They are part of the published data format so that a later process
 * can use them; the methodology page marks them as defined but not yet used.
 */
export const UNASSIGNED_STATUSES: ReadonlySet<VerificationStatus> = new Set<VerificationStatus>(['awaiting_review', 'disputed', 'outdated']);

/** Shown beside a record's badge, so the label never appears without what its check leaves out. */
export const RECORD_CHECK_SCOPE =
  'The check covers what the source published. Labels, issue tags and dates that DemocracyHQ derives by its own rules (such as a case’s latest ruling entry or a bill’s effective date) are not part of it, and no lawyer has reviewed the record.';

/** Shown beside the badge of a link between records that a maintainer wrote. */
export const LINK_CHECK_SCOPE =
  'The link and its description were written by maintainers. The quoted passage was found in the cited document when that document was last fetched; the check does not test the description.';

export const METHOD_LABELS: Readonly<Record<string, string>> = {
  automated_primary_retrieval: 'Retrieved automatically from the official source and parsed without error',
  automated_secondary_import: 'Imported automatically from an aggregator',
  rule_derived: 'Produced by a published rule and checked against the cited text',
  maintainer_curated: 'Written by a maintainer; the quoted passage was found in the cited document when it was last fetched',
  manual_review: 'Compared with the primary source by a maintainer',
};
