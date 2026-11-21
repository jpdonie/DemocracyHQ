/**
 * Hash-based routing. The whole application state that matters for sharing
 * (module, record, place, layer, filters) lives in the URL fragment, so links
 * work on GitHub Pages under any subpath without server rewrites.
 */
import { useSyncExternalStore } from 'react';

export interface Route {
  /** Decoded path segments, e.g. ['place', 'cd120:0612']. */
  path: string[];
  query: Record<string, string>;
}

export type QueryInput = Record<string, string | number | null | undefined>;

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  // Only the first '?' starts the query: a '?' typed into a hand-made link (#/litigation?q=a?b) belongs to a value.
  const mark = raw.indexOf('?');
  const pathPart = mark < 0 ? raw : raw.slice(0, mark);
  const queryPart = mark < 0 ? '' : raw.slice(mark + 1);
  const path = pathPart.split('/').filter(Boolean).map(safeDecode);
  const query: Record<string, string> = {};
  new URLSearchParams(queryPart).forEach((value, key) => {
    if (value !== '') query[key] = value;
  });
  return { path, query };
}

export function buildHash(path: string | readonly string[], query: QueryInput = {}): string {
  const segments = typeof path === 'string' ? path.split('/').filter(Boolean) : path;
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',');
  return `#/${segments.map(encodeSegment).join('/')}${search ? `?${search}` : ''}`;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

let cachedHash: string | null = null;
let cachedRoute: Route = { path: [], query: {} };

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, () => cachedRoute);
}

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  if (hash === window.location.hash) return;
  noteMoveStart(hash);
  if (options.replace) {
    // The entry's state is kept: it names the entry, so the reader's place in it can be found again (see scrollMemory.ts).
    window.history.replaceState(window.history.state, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

/** Merge a patch into the current query string. Used by filters; replaces history so typing does not flood Back. */
export function patchQuery(route: Route, patch: QueryInput, options: { replace?: boolean } = { replace: true }): void {
  navigate(buildHash(route.path, { ...route.query, ...patch }), options);
}

/* ---------- where a move to another view started ---------- */

/**
 * After a move the new view's heading takes focus, unless the reader has put focus somewhere else meanwhile. That needs
 * the element that had focus when the move started. It is recorded here, when the link is followed or `navigate` is
 * called, because by the time React has rendered the new view the reader may already have moved focus (for example
 * into the search box), and that element would be mistaken for the one that started the move.
 */
let pendingStart: { element: Element | null; link: Element | null; hash: string } | null = null;
let lastStart: Element | null = null;
let lastLink: Element | null = null;

/** The link a move was made from: the link clicked, or the focused element when it is a link (Enter on a link). */
function linkOf(element: Element | null): Element | null {
  return element instanceof HTMLAnchorElement ? element : null;
}

function noteMoveStart(hash: string, link: Element | null = null): void {
  // The address as the browser will report it, so that it can be matched against location.hash when it changes.
  pendingStart = { element: document.activeElement, link: link ?? linkOf(document.activeElement), hash: new URL(hash, window.location.href).hash };
}

function onHashChange(): void {
  // The record belongs to the move to its own address; any other change of address (Back, Forward, an edited address)
  // starts from whatever has focus now.
  if (pendingStart && pendingStart.hash === window.location.hash) {
    lastStart = pendingStart.element;
    lastLink = pendingStart.link;
    pendingStart = null;
  } else {
    lastStart = document.activeElement;
    lastLink = linkOf(document.activeElement);
  }
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
  // Following a link to the current address changes nothing.
  if (link.hash === window.location.hash) return;
  noteMoveStart(link.hash, link);
}

/**
 * Start recording where moves start. Called once when the app starts. Clicks are read on the window after the page's own
 * handlers, so a link whose click a handler cancels (the skip link) is not counted as a move.
 */
export function trackMoveStarts(): () => void {
  window.addEventListener('click', onClick);
  window.addEventListener('hashchange', onHashChange, { capture: true });
  return () => {
    window.removeEventListener('click', onClick);
    window.removeEventListener('hashchange', onHashChange, { capture: true });
    pendingStart = null;
    lastStart = null;
    lastLink = null;
  };
}

/** The element that had focus when the latest move to another address started (null before any move). */
export function moveStartedOn(): Element | null {
  return lastStart;
}

/** The link the latest move to another address was made from, if it was made from a link (null otherwise). */
export function moveLink(): Element | null {
  return lastLink;
}

/** Absolute, shareable URL for a hash route. */
export function shareUrl(hash: string): string {
  return `${window.location.origin}${window.location.pathname}${hash}`;
}
