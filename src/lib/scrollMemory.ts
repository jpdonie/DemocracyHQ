/**
 * The reader's place in each view, kept per browser history entry, so that Back and Forward return to where the reader
 * was (how far down the panel, and the link that was followed from it) instead of to the top of the view.
 *
 * Each history entry is named in its `history.state` (the router keeps that state when it replaces an address). When
 * the address changes, the place in the view being left is recorded under that entry's name, before the next view is
 * drawn. Places live in memory only: nothing is stored or sent anywhere.
 */

/** Where the reader was in a view. */
export interface ViewPlace {
  /** The panel's scroll position. */
  top: number;
  /** The page's own scroll position (on a very short screen the page scrolls, not the panel). */
  windowTop: number;
  /** The link in the panel that the reader followed away from this view: its address, and which of the links with that address it was. */
  link: { href: string; nth: number } | null;
}

/** How the current view was reached: a new entry, Back or Forward to an entry seen before, or the same entry with a new address. */
export interface Arrival {
  kind: 'new' | 'traverse' | 'same';
  place: ViewPlace | null;
}

const places = new Map<string, ViewPlace>();
let currentEntry: string | null = null;
let arrival: Arrival = { kind: 'new', place: null };
let counter = 0;

function entryOf(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as { dhqEntry?: unknown }).dhqEntry;
  return typeof value === 'string' ? value : null;
}

/** The current entry's name, giving it one if it has none. */
function nameEntry(): string {
  const existing = entryOf(window.history.state);
  if (existing) return existing;
  counter += 1;
  const name = `${Date.now().toString(36)}.${counter}`;
  const state: unknown = window.history.state;
  try {
    window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), dhqEntry: name }, '');
  } catch {
    // A browser that refuses the state simply does not get its place back.
  }
  return name;
}

function linkPlace(panel: HTMLElement, element: Element | null): ViewPlace['link'] {
  const link = element?.closest('a[href]');
  if (!link || !panel.contains(link)) return null;
  const href = link.getAttribute('href')!;
  const same = [...panel.querySelectorAll('a[href]')].filter((a) => a.getAttribute('href') === href);
  return { href, nth: Math.max(0, same.indexOf(link)) };
}

/** The link a place names, in the view as it is drawn now. */
export function findPlaceLink(panel: HTMLElement, link: ViewPlace['link']): HTMLElement | null {
  if (!link) return null;
  const same = [...panel.querySelectorAll<HTMLElement>('a[href]')].filter((a) => a.getAttribute('href') === link.href);
  return same[link.nth] ?? same[0] ?? null;
}

/**
 * Start keeping places. `panel` gives the scrolling panel; `linkFollowed` gives the link the latest move was made from
 * (the router records it). Returns the clean-up function.
 */
export function trackPlaces(panel: () => HTMLElement | null, linkFollowed: () => Element | null): () => void {
  currentEntry = nameEntry();
  // The app puts the page back itself. Left to the browser, Chrome restores the page's scroll position between popstate
  // and hashchange, so the position read below would already be the next entry's, not the one being left.
  const history = window.history as History & { scrollRestoration?: ScrollRestoration };
  const previousRestoration = history.scrollRestoration;
  try {
    if (previousRestoration) history.scrollRestoration = 'manual';
  } catch {
    // A browser that does not allow it keeps its own behaviour.
  }
  const onHashChange = () => {
    const element = panel();
    if (currentEntry && element) {
      places.set(currentEntry, { top: element.scrollTop, windowTop: window.scrollY, link: linkPlace(element, linkFollowed()) });
    }
    const entry = entryOf(window.history.state);
    if (entry && entry === currentEntry) arrival = { kind: 'same', place: null };
    else if (entry) arrival = { kind: 'traverse', place: places.get(entry) ?? null };
    else arrival = { kind: 'new', place: null };
    currentEntry = entry ?? nameEntry();
  };
  // Listeners on the window run in the order they were added, so this must be added before the app subscribes to the
  // address (see main.tsx): the place is then read before the next view is drawn.
  window.addEventListener('hashchange', onHashChange, { capture: true });
  return () => {
    window.removeEventListener('hashchange', onHashChange, { capture: true });
    try {
      if (previousRestoration) history.scrollRestoration = previousRestoration;
    } catch {
      // See above.
    }
  };
}

/** How the latest change of address was made, and, for Back or Forward, the place recorded for that entry. */
export function lastArrival(): Arrival {
  return arrival;
}

/** For tests: forget every place. */
export function resetPlaces(): void {
  places.clear();
  currentEntry = null;
  arrival = { kind: 'new', place: null };
}
