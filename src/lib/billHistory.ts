/**
 * Which official subject line a bill carried when each action in its history was taken.
 *
 * A bill can be amended to deal with an entirely different subject after a house has voted on it ("gut and amend"), so
 * a vote listed under the bill's current subject can read as a vote on that subject. For each action, the version in
 * force is the latest text version dated on or before the action. When a version is dated the same day as the action,
 * the record does not say which text the action concerned, so no subject is given for it.
 */
import type { LawVersion, LegislativeAction, LegislativeInstrument } from '../types/schemas';

/** Short words that do not tell two subject lines apart. */
const CONNECTIVES: ReadonlySet<string> = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** The words of a subject line, lower case, without connectives, and with a plural "s" dropped ("elections" = "election"). */
function subjectWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word && !CONNECTIVES.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
}

/** The words of the most specific part of a subject line: the part after its last colon ("Elections: tie votes." gives tie, vote). */
function specificWords(text: string): string[] {
  const parts = text.split(':').map(subjectWords).filter((words) => words.length > 0);
  return parts[parts.length - 1] ?? [];
}

/**
 * Whether two official subject lines name the same subject. They do when they share at least half of their words and
 * their most specific parts share at least one word. A reworded line ("… or voting systems." and "… or voting
 * technology.") is the same subject; "Voter registration: residency confirmation." and "Redistricting: congressional
 * districts." are not, and neither are "Political Reform Act of 1974: amendments." and "Political Reform Act of 1974:
 * Citizens Redistricting Commission.", whose shared words are only the act's name.
 */
export function sameSubject(a: string, b: string): boolean {
  const left = new Set(subjectWords(a));
  const right = new Set(subjectWords(b));
  if (left.size === 0 || right.size === 0) return left.size === right.size;
  const shared = [...left].filter((word) => right.has(word)).length;
  if (shared === left.size && shared === right.size) return true;
  if (shared * 2 < new Set([...left, ...right]).size) return false;
  const specific = new Set(specificWords(b));
  return specificWords(a).some((word) => specific.has(word));
}

/** The text version in force on a date, or null when none is dated before it or one is dated that same day. */
export function versionInForce(versions: readonly LawVersion[], date: string): LawVersion | null {
  let latest: LawVersion | null = null;
  for (const version of versions) {
    if (version.versionDate <= date && (!latest || version.versionDate >= latest.versionDate)) latest = version;
  }
  return latest && latest.versionDate < date ? latest : null;
}

/** The first text version dated after a date, or null. */
function nextVersion(versions: readonly LawVersion[], date: string): LawVersion | null {
  let next: LawVersion | null = null;
  for (const version of versions) {
    if (version.versionDate > date && (!next || version.versionDate < next.versionDate)) next = version;
  }
  return next;
}

/**
 * `inForce` when it names a different subject from `current`, otherwise null. Used for a bill's own history and for a
 * timeline event that carries the subject line in force when it happened.
 */
export function differentSubject(inForce: string | null | undefined, current: string | null | undefined): string | null {
  const now = current?.trim();
  const then = inForce?.trim();
  return now && then && !sameSubject(then, now) ? then : null;
}

/**
 * The official subject line in force when an action was taken, when it names a different subject from the measure's
 * current subject line; otherwise null.
 *
 * An action that adopts amendments ("From committee: Amend, and do pass as amended") is a vote on the bill as amended,
 * and those amendments are printed in the next version, a few days later. When that next version names a different
 * subject from the version before the action, the record does not say which subject the vote concerned, so no subject
 * is given for it.
 */
export function earlierSubject(
  bill: Pick<LegislativeInstrument, 'subject' | 'versions'>,
  action: Pick<LegislativeAction, 'date'> & Partial<Pick<LegislativeAction, 'eventType'>>,
): string | null {
  const before = versionInForce(bill.versions, action.date)?.subject;
  const subject = differentSubject(before, bill.subject);
  if (!subject || action.eventType !== 'amended') return subject;
  const after = nextVersion(bill.versions, action.date)?.subject?.trim();
  return after && !sameSubject(subject, after) ? null : subject;
}

/** The sentence shown next to such an action, on the page and in the source pack. */
export function earlierSubjectNote(subject: string): string {
  return `Taken when the measure’s subject was: ${subject}${/[.?!]$/.test(subject) ? '' : '.'}`;
}

/** Said once above a history in which any action carries that sentence. */
export const EARLIER_SUBJECT_EXPLAINER =
  'An action taken while the official subject line named a different subject says so, judged from the latest text version dated before the action. '
  + 'An action dated the same day as a new version is not marked, because the record does not say which text it concerned. '
  + 'Nor is an action that adopted the amendments that changed the subject.';
