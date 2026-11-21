// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { buildHash, moveStartedOn, navigate, parseHash, patchQuery, shareUrl, trackMoveStarts } from '../../src/lib/router';
import { safePadding } from '../../src/lib/mapPadding';
import { clearWatchlist, isWatched, parseWatchlist, readWatchlist, toggleWatch } from '../../src/lib/watchlist';

describe('hash routes', () => {
  it('parses path segments and query values', () => {
    expect(parseHash('#/place/cd120:0612?tab=timeline&layer=cd120')).toEqual({ path: ['place', 'cd120:0612'], query: { tab: 'timeline', layer: 'cd120' } });
    expect(parseHash('')).toEqual({ path: [], query: {} });
    expect(parseHash('#/')).toEqual({ path: [], query: {} });
  });

  it('starts the query at the first question mark only, so a "?" in a hand-made link stays in its value', () => {
    expect(parseHash('#/litigation?q=a?b&tag=x')).toEqual({ path: ['litigation'], query: { q: 'a?b', tag: 'x' } });
    expect(parseHash('#/laws?').query).toEqual({});
  });

  it('drops empty query values and survives a malformed escape', () => {
    expect(parseHash('#/litigation?q=&tag=voter-id').query).toEqual({ tag: 'voter-id' });
    expect(parseHash('#/laws/%E0%A4%A').path).toEqual(['laws', '%E0%A4%A']);
  });

  it('builds stable links: sorted keys, empty values removed, readable colons and commas', () => {
    expect(buildHash(['place', 'cd120:0612'], { tab: 'timeline', layer: 'cd120', q: '', x: null, y: undefined })).toBe('#/place/cd120:0612?layer=cd120&tab=timeline');
    expect(buildHash('laws/ca-1/compare', { from: 'A', to: 'B' })).toBe('#/laws/ca-1/compare?from=A&to=B');
    expect(buildHash([], {})).toBe('#/');
    expect(buildHash(['litigation'], { cats: 'a,b', key: 'state:06' })).toBe('#/litigation?cats=a,b&key=state:06');
  });

  it('round-trips text that needs escaping', () => {
    const hash = buildHash(['litigation'], { q: 'smith & jones "v" #1 ?' });
    expect(parseHash(hash).query.q).toBe('smith & jones "v" #1 ?');
    expect(parseHash(buildHash(['laws', 'a/b c'])).path).toEqual(['laws', 'a/b c']);
  });

  it('makes share links that keep the sub-path the site is served from', () => {
    window.history.replaceState(null, '', '/some-repo/index.html');
    expect(shareUrl('#/laws/x')).toBe(`${window.location.origin}/some-repo/index.html#/laws/x`);
  });

  it('navigates and patches the query without touching the path', () => {
    navigate('#/litigation?tag=a');
    expect(window.location.hash).toBe('#/litigation?tag=a');
    patchQuery(parseHash(window.location.hash), { tag: null, q: 'x' });
    expect(window.location.hash).toBe('#/litigation?q=x');
  });
});

describe('map padding', () => {
  it('is left alone when the stage is large enough', () => {
    expect(safePadding({ top: 84, right: 64, bottom: 236, left: 76 }, { clientWidth: 900, clientHeight: 700 })).toEqual({ top: 84, right: 64, bottom: 236, left: 76 });
  });

  it('is scaled down so at least a third of a small stage stays free', () => {
    const p = safePadding({ top: 118, right: 20, bottom: 64, left: 20 }, { clientWidth: 390, clientHeight: 150 });
    expect(p.top + p.bottom).toBeLessThanOrEqual(100);
    expect(p.top).toBeGreaterThan(p.bottom);
    expect(p.left).toBe(20);
    expect(safePadding({ top: 0, right: 0, bottom: 0, left: 0 }, { clientWidth: 0, clientHeight: 0 })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('local watchlist', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('adds, finds and removes an item, newest first', () => {
    expect(toggleWatch({ type: 'case', id: 'synthetic-case-1', label: 'Synthetic Alpha v. Synthetic Beta' }, '2026-06-15T12:00:00Z')).toBe(true);
    toggleWatch({ type: 'place', id: 'state:06', label: 'California' }, '2026-06-15T12:01:00Z');
    expect(readWatchlist().map((i) => i.id)).toEqual(['state:06', 'synthetic-case-1']);
    expect(isWatched(readWatchlist(), 'case', 'synthetic-case-1')).toBe(true);
    expect(isWatched(readWatchlist(), 'bill', 'synthetic-case-1')).toBe(false);
    toggleWatch({ type: 'case', id: 'synthetic-case-1', label: 'x' });
    expect(readWatchlist().map((i) => i.id)).toEqual(['state:06']);
    clearWatchlist();
    expect(readWatchlist()).toEqual([]);
  });

  it('stores only type, id, label and time, under one local key', () => {
    toggleWatch({ type: 'bill', id: 'zz-2026-ab1', label: 'CA AB 1' }, '2026-06-15T12:00:00Z');
    expect(Object.keys(window.localStorage)).toEqual(['dhq.watchlist.v1']);
    expect(JSON.parse(window.localStorage.getItem('dhq.watchlist.v1')!)).toEqual([{ type: 'bill', id: 'zz-2026-ab1', label: 'CA AB 1', addedAt: '2026-06-15T12:00:00Z' }]);
  });

  it('ignores stored data that is damaged or of the wrong shape', () => {
    expect(parseWatchlist(null)).toEqual([]);
    expect(parseWatchlist('{not json')).toEqual([]);
    expect(parseWatchlist('{"a":1}')).toEqual([]);
    expect(parseWatchlist(JSON.stringify([{ type: 'voter', id: 'x', label: 'x', addedAt: 'x' }, { type: 'case', id: 1 }, { type: 'case', id: 'ok', label: 'Ok', addedAt: 't' }]))).toEqual([
      { type: 'case', id: 'ok', label: 'Ok', addedAt: 't' },
    ]);
  });
});

describe('where a move to another view started', () => {
  /** Resolves on the hashchange event for `hash` (an earlier test's event may still be queued). */
  const hashChangeTo = (hash: string) => new Promise<void>((resolve) => {
    const listener = () => {
      if (window.location.hash !== hash) return;
      window.removeEventListener('hashchange', listener);
      resolve();
    };
    window.addEventListener('hashchange', listener);
  });
  const element = <T extends HTMLElement>(el: T): T => {
    document.body.append(el);
    return el;
  };
  const link = (href: string) => element(Object.assign(document.createElement('a'), { href }));

  it('is the element focused when a link was followed, even if focus moved before the address changed', async () => {
    const stop = trackMoveStarts();
    try {
      window.history.replaceState(null, '', '/#/litigation');
      const caseLink = link('#/litigation/x');
      const search = element(document.createElement('input'));
      caseLink.focus();
      const changed = hashChangeTo('#/litigation/x');
      // The click and the move into the search box happen before the browser reports the new address.
      caseLink.click();
      search.focus();
      await changed;
      expect(moveStartedOn()).toBe(caseLink);
    } finally {
      stop();
      document.body.innerHTML = '';
    }
  });

  it('is the element focused when navigate() was called, and the focused element for a move without either', async () => {
    const stop = trackMoveStarts();
    try {
      window.history.replaceState(null, '', '/#/laws');
      const search = element(document.createElement('input'));
      const other = element(document.createElement('button'));
      search.focus();
      navigate('#/laws/x', { replace: true });
      other.focus();
      expect(moveStartedOn()).toBe(search);

      // Back, Forward or an edited address: whatever has focus at that point.
      const changed = hashChangeTo('#/sources');
      window.location.hash = '#/sources';
      await changed;
      expect(moveStartedOn()).toBe(other);
    } finally {
      stop();
      document.body.innerHTML = '';
    }
  });

  it('does not count a link whose click a handler cancelled', async () => {
    const stop = trackMoveStarts();
    try {
      window.history.replaceState(null, '', '/#/about');
      const skip = link('#/about?x=1');
      skip.addEventListener('click', (event) => event.preventDefault());
      const other = element(document.createElement('button'));
      skip.focus();
      skip.click();
      other.focus();
      const changed = hashChangeTo('#/watchlist');
      window.location.hash = '#/watchlist';
      await changed;
      expect(moveStartedOn()).toBe(other);
    } finally {
      stop();
      document.body.innerHTML = '';
    }
  });
});
