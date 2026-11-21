/**
 * Calendar facts about the California Legislature's 2025–26 Regular Session that the bill pages cite. They come from
 * the California Constitution, not from the official bill data, so they are kept here, in one place, with their
 * citations. Whether a date has passed is judged against the data release (the manifest's generatedAt, or a record's
 * last check), never against the reader's clock, so a page says the same thing to every reader of the same release.
 */
import type { LegislativeInstrumentSummary } from '../types/schemas';

export const CA_SESSION_2025_26 = {
  /** The session string the official bill data gives for these measures. */
  session: '2025-2026 Regular Session',
  /**
   * Cal. Const. art. IV, § 10(c): no bill may be passed by either house on or after September 1 of an even-numbered
   * year, except statutes calling elections, statutes providing for tax levies or appropriations for the usual current
   * expenses of the State, urgency statutes, and bills passed after being vetoed by the Governor.
   */
  lastDayToPassBills: '2026-08-31',
  /** Cal. Const. art. IV, § 3(a): each session adjourns sine die at midnight on November 30 of the even-numbered year. */
  sessionEnds: '2026-11-30',
} as const;

/** The statuses, as the Legislature records them, of a measure that has not passed both houses and is not final. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(['In Committee Process', 'Pending Referral', 'In Floor Process']);

/** Only bills are subject to the art. IV, § 10(c) deadline; constitutional amendments and resolutions are not. */
const BILL_TYPES: ReadonlySet<string> = new Set(['Assembly Bill', 'Senate Bill']);

/** What a page says about a bill that still shows a pending status after the deadline. */
export function passageDeadlineNote(asOf: string): string {
  const ends = asOf.slice(0, 10) > CA_SESSION_2025_26.sessionEnds ? 'ended' : 'ends';
  return 'The last day for each house to pass bills in the 2025–26 session was August 31, 2026 (California Constitution, article IV, '
    + `section 10(c), which lists exceptions such as urgency statutes), and the session ${ends} on November 30, 2026 (article IV, `
    + 'section 3(a)). The status shown is the one the Legislature records.';
}

/** True when the data release is dated after the last day to pass bills. `asOf` is a release or check date, never "now". */
export function afterPassageDeadline(asOf: string | null | undefined): boolean {
  return Boolean(asOf) && asOf!.slice(0, 10) > CA_SESSION_2025_26.lastDayToPassBills;
}

/**
 * True for an Assembly or Senate bill of the 2025–26 Regular Session whose recorded status is still pending (in
 * committee, pending referral or in floor process) in a data release dated after the last day to pass bills.
 */
export function pendingAfterDeadline(bill: Pick<LegislativeInstrumentSummary, 'session' | 'measureType' | 'legislativeStatus'>, asOf: string | null | undefined): boolean {
  return bill.session === CA_SESSION_2025_26.session
    && BILL_TYPES.has(bill.measureType)
    && PENDING_STATUSES.has(bill.legislativeStatus.currentStatus ?? '')
    && afterPassageDeadline(asOf);
}
