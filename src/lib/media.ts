import { useEffect, useState } from 'react';

/** The compact layout (map, bottom sheet, tab bar). Keep in step with the 899px query in app.css. */
export const COMPACT_QUERY = '(max-width: 899px)';
/** A phone held upright: the top bar's search box is too narrow for its full placeholder. */
export const NARROW_QUERY = '(max-width: 30em)';
/** A compact screen held sideways: too short for a half-height sheet. Keep in step with app.css. */
export const SHORT_COMPACT_QUERY = '(max-width: 899px) and (max-height: 500px)';
/**
 * A compact screen so short that fixed bars would leave almost no room (a 1366 x 768 laptop screen at 400% zoom is about
 * 342 x 164 CSS pixels): the page then scrolls as one document. Keep in step with app.css.
 */
export const TINY_COMPACT_QUERY = '(max-width: 899px) and (max-height: 300px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
