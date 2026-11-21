/**
 * A quiet notice when a newer data release has been published since the page was opened. Every file this page loads
 * is requested for the release it started with, so the notice is the only way a long-open tab learns of a new one.
 * It checks when the tab comes back into view, at most once per `minIntervalMs`.
 */
import { useEffect, useRef, useState } from 'react';
import type { Manifest } from '../types/schemas';
import { checkForNewRelease } from '../lib/data';
import { formatDateTime } from '../lib/format';

const systemNow = () => Date.now();

export function ReleaseNotice({ check = checkForNewRelease, minIntervalMs = 5 * 60_000, now = systemNow }: {
  check?: () => Promise<Manifest | null>; minIntervalMs?: number; now?: () => number;
}) {
  const [newer, setNewer] = useState<Manifest | null>(null);
  const lastCheck = useRef(now());
  useEffect(() => {
    let cancelled = false;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || newer) return;
      if (now() - lastCheck.current < minIntervalMs) return;
      lastCheck.current = now();
      check().then((manifest) => { if (!cancelled && manifest) setNewer(manifest); }, () => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check, minIntervalMs, now, newer]);
  return (
    <div role="status" className="release-notice-wrap">
      {newer ? (
        <p className="release-notice">
          The data was updated ({formatDateTime(newer.generatedAt)}); reload to see the latest release.{' '}
          <button type="button" className="btn btn-quiet" onClick={() => window.location.reload()}>Reload</button>
        </p>
      ) : null}
    </div>
  );
}
