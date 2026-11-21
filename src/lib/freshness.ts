import type { SourceRecord } from '../types/schemas';
import { daysBetween } from './format';

export type FreshnessState = 'fresh' | 'stale' | 'failed' | 'credential_missing' | 'never_checked';

export interface Freshness {
  state: FreshnessState;
  /** Whole days since the last successful check; null when the source was never retrieved. */
  ageDays: number | null;
  label: string;
}

/**
 * Staleness is computed in the browser from the last *successful* check, so a
 * deployment that stops refreshing shows as stale on its own, without a new build.
 */
export function sourceFreshness(
  source: Pick<SourceRecord, 'processingStatus' | 'lastSuccessfulCheck' | 'staleAfterDays'>,
  nowIso: string,
): Freshness {
  const ageDays = source.lastSuccessfulCheck ? daysBetween(source.lastSuccessfulCheck, nowIso) : null;
  if (source.processingStatus === 'credential_missing') {
    return { state: 'credential_missing', ageDays, label: 'Not active: needs an API credential' };
  }
  if (ageDays === null) {
    return { state: source.processingStatus === 'failed' ? 'failed' : 'never_checked', ageDays, label: 'Never retrieved' };
  }
  const age = ageDays <= 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
  if (source.processingStatus === 'failed') {
    return { state: 'failed', ageDays, label: `Last refresh failed; showing data checked ${age}` };
  }
  if (source.processingStatus === 'stale' || ageDays > source.staleAfterDays) {
    return { state: 'stale', ageDays, label: `Stale: last checked ${age}` };
  }
  return { state: 'fresh', ageDays, label: `Checked ${age}` };
}

export function isRecordStale(lastCheckedAt: string, staleAfterDays: number, nowIso: string): boolean {
  const age = daysBetween(lastCheckedAt, nowIso);
  return age === null || age > staleAfterDays;
}
