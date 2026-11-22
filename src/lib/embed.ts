/**
 * The site inside another page. Any view can be shown in a frame: its address with `?embed=1` before the `#`
 * (`https://example.org/?embed=1#/place/state:22`). The value stands before the `#`, so it stays while the reader moves
 * from view to view inside the frame. The embedded form has a lower top bar and a link that opens the same view on
 * the full site in a new tab.
 */

/** True when the address asks for the embedded form. `?embed=0` and no value at all do not. */
export function isEmbedded(search: string = window.location.search): boolean {
  const value = new URLSearchParams(search).get('embed');
  return value !== null && value !== '0' && value !== 'false';
}

/** The address of a view on the full site: where the frame was loaded from, without `embed`. */
export function fullSiteUrl(hash: string, location: Pick<Location, 'origin' | 'pathname' | 'search'> = window.location): string {
  const query = new URLSearchParams(location.search);
  query.delete('embed');
  const rest = query.toString();
  return `${location.origin}${location.pathname}${rest ? `?${rest}` : ''}${hash}`;
}

/** The address of a view in its embedded form. */
export function embedUrl(hash: string, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${location.origin}${location.pathname}?embed=1${hash}`;
}

/** The markup that puts a view into another page. */
export function embedCode(hash: string, title: string, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  const safe = title.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<iframe src="${embedUrl(hash, location)}" title="${safe}" width="100%" height="720" style="border:0" loading="lazy"></iframe>`;
}
