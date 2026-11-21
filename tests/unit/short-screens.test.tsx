// @vitest-environment jsdom
/**
 * Fixes after the independent check of the final review round (group UX): Back and Forward on a very short screen,
 * the heading brought into view there, and searching short queries at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMMEDIATE_MAX_LENGTH, searchesAtOnce } from '../../src/components/GlobalSearch';
import { focusHeadingWhenShown, restorePlaceWhenShown } from '../../src/lib/focus';
import { TINY_COMPACT_QUERY } from '../../src/lib/media';
import { resetPlaces, trackPlaces } from '../../src/lib/scrollMemory';

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

/** Pretend the screen matches only the given queries. */
function screenMatches(queries: string[]) {
  window.matchMedia = ((query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

describe('the browser does not move the page on Back and Forward (DB5, Forward on a very short screen)', () => {
  it('turns the browser’s own scroll restoration off while places are kept, and back on after', () => {
    resetPlaces();
    window.history.scrollRestoration = 'auto';
    const stop = trackPlaces(() => null, () => null);
    expect(window.history.scrollRestoration).toBe('manual');
    stop();
    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('puts the page back at the top when the place recorded there was the top', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const panel = document.createElement('main');
    panel.innerHTML = '<h1 tabindex="-1">Record</h1>';
    document.body.append(panel);
    // jsdom lays nothing out, so the page never looks tall enough: the place is restored when the wait ends.
    const stop = restorePlaceWhenShown(panel, { top: 0, windowTop: 0, link: null }, null, 10);
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    stop();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(document.activeElement).toBe(panel.querySelector('h1'));
  });
});

describe('the focused heading is on screen on a very short screen (DB2, DB5)', () => {
  it('brings the heading into view when the page scrolls as one document', async () => {
    screenMatches([TINY_COMPACT_QUERY]);
    const panel = document.createElement('main');
    panel.innerHTML = '<h1 tabindex="-1">Record</h1>';
    document.body.append(panel);
    const heading = panel.querySelector('h1')!;
    const scrolled = vi.fn();
    heading.scrollIntoView = scrolled;
    const stop = focusHeadingWhenShown(panel, null);
    await nextFrame();
    stop();
    expect(document.activeElement).toBe(heading);
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' });
  });

  it('leaves the scroll position alone in the regular layouts', async () => {
    screenMatches([]);
    const panel = document.createElement('main');
    panel.innerHTML = '<h1 tabindex="-1">Record</h1>';
    document.body.append(panel);
    const heading = panel.querySelector('h1')!;
    const scrolled = vi.fn();
    heading.scrollIntoView = scrolled;
    const stop = focusHeadingWhenShown(panel, null);
    await nextFrame();
    stop();
    expect(document.activeElement).toBe(heading);
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('short queries are searched as they are typed (DB10)', () => {
  it('searches a short query at once and waits only for a long one', () => {
    expect(searchesAtOnce('')).toBe(true);
    expect(searchesAtOnce('lou')).toBe(true);
    expect(searchesAtOnce('Louisiana v. Callais')).toBe(true);
    expect(searchesAtOnce('x'.repeat(IMMEDIATE_MAX_LENGTH))).toBe(true);
    expect(searchesAtOnce('x'.repeat(IMMEDIATE_MAX_LENGTH + 1))).toBe(false);
    expect(searchesAtOnce('a b c d e f g')).toBe(false);
    expect(searchesAtOnce(Array.from({ length: 300 }, (_, i) => `word${i}`).join(' '))).toBe(false);
  });
});
