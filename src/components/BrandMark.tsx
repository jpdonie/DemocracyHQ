/**
 * Brand mark: three benches inside a survey-sheet frame. The paths are one frame
 * of the "Isoline Assembly" generative study in /design; the seed and the export
 * script are recorded in design/README.md.
 */
import { MARK_PATHS } from './brandPaths';

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="60" height="60" rx="3" fill="none" stroke="currentColor" strokeWidth="3" />
      {MARK_PATHS.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={i === 0 ? 3 : 2.2} strokeLinecap="round" />)}
    </svg>
  );
}
