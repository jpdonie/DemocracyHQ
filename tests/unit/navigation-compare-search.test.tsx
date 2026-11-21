// @vitest-environment jsdom
/**
 * Navigation, version comparison, search and watchlist behaviour (final review round, group UX).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from '@testing-library/react';
import { diffWordsWithSpace } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import { packTitle } from '../../src/App';
import { rulingExcerpt } from '../../src/features/litigation/CaseDirectory';
import { isReversed } from '../../src/features/legislation/VersionCompare';
import { focusAfterRemoval, onSharedGithubOrigin } from '../../src/features/watchlist/WatchlistPage';
import { diffBlocks, markedText, mergeWordRuns, type WordPart } from '../../src/lib/diff';
import { filterCases, knownCaseFilters } from '../../src/lib/filters';
import { GeoIndex } from '../../src/lib/geo';
import { buildSearchIndex, FUZZY_MAX_WORDS, searchWithSuggestions } from '../../src/lib/search';
import { lastArrival, resetPlaces, trackPlaces } from '../../src/lib/scrollMemory';
import type { TextBlock } from '../../src/types/schemas';
import { makeCase } from './fixtures';

const DATA = join(__dirname, '../../public/data');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the state filter of the case list (DB1)', () => {
  const cases = [makeCase({ id: 'a', stateFips: ['48'] }), makeCase({ id: 'b', stateFips: ['22'] })];
  const onMap = (fips: string) => ['48', '22', '56', '72'].includes(fips);

  it('keeps a state on the map that no case links to, so the list is empty rather than unfiltered', () => {
    const filters = knownCaseFilters({ state: '56' }, cases, onMap);
    expect(filters.state).toBe('56');
    expect(filterCases(cases, filters)).toEqual([]);
  });

  it('still drops a code that is not a state on the map, and keeps a state a case links to', () => {
    expect(knownCaseFilters({ state: '99' }, cases, onMap).state).toBeUndefined();
    expect(knownCaseFilters({ state: '__proto__' }, cases, onMap).state).toBeUndefined();
    expect(knownCaseFilters({ state: '48' }, cases, onMap).state).toBe('48');
    // Without the map's index (still loading), only the states the cases link to are known.
    expect(knownCaseFilters({ state: '56' }, cases).state).toBeUndefined();
  });
});

describe('ruling excerpts in the case list (DL7)', () => {
  it('keeps the operative words of a long order visible, in the docket’s own words', () => {
    const index = JSON.parse(readFileSync(join(DATA, 'litigation/index.json'), 'utf8')) as { cases: Array<{ id: string; latestDispositiveEntry?: { text: string } | null }> };
    const order = index.cases.find((c) => c.id === 'scotus-25a1197')?.latestDispositiveEntry?.text;
    expect(order, 'the 25A1197 order is in the dataset').toBeTruthy();
    const excerpt = rulingExcerpt(order!);
    expect(excerpt).toMatch(/is granted\./);
    expect(excerpt.length).toBeLessThan(order!.length);
    // Every word shown is the docket's: the excerpt without its omission marks is a passage of the text.
    expect(order).toContain(excerpt.replace(/^… /, '').replace(/ …$/, ''));
    expect(excerpt.startsWith('… ')).toBe(true);
  });

  it('cuts at the end when the operative words come early, and leaves a short text alone', () => {
    const early = `Application (24A1) for stay presented to Justice X and by him referred to the Court is granted. ${'Further text. '.repeat(20)}`;
    expect(rulingExcerpt(early)).toBe(`${early.slice(0, 190).trimEnd()}…`);
    expect(rulingExcerpt('Petition DENIED.')).toBe('Petition DENIED.');
  });

  it('every ruling in the dataset shows an operative word when its text has one', () => {
    const index = JSON.parse(readFileSync(join(DATA, 'litigation/index.json'), 'utf8')) as { cases: Array<{ latestDispositiveEntry?: { text: string } | null }> };
    const operative = /\b(granted|denied|dismissed|affirmed|reversed|vacated|remanded|stayed)\b/i;
    for (const c of index.cases) {
      const text = c.latestDispositiveEntry?.text;
      if (text && operative.test(text)) expect(rulingExcerpt(text), text.slice(0, 60)).toMatch(operative);
    }
  });
});

describe('edited paragraphs as shown (DB3)', () => {
  const merge = (a: string, b: string) => mergeWordRuns(diffWordsWithSpace(a, b));
  const reading = (parts: WordPart[], without: 'ins' | 'del') => markedText(parts).filter((p) => p.mark !== without).map((p) => p.text).join('');

  it('never shows a space between two characters that are together in either version', () => {
    // A quotation mark followed by an added word: moving the space out of the mark would read “ ballot” in the earlier text.
    const cases: Array<[string, string]> = [
      ['the “ballot” is', 'the “mail ballot” is'],
      ['Section 1385.01 of the', 'Section 89517.5 of the'],
      ['elected official’s spouse', 'elected officials spouse'],
      ['A ballot is counted.', 'A mail ballot is counted.'],
      ['voters who have not yet cast it may', 'voters who have not submitted it may'],
    ];
    for (const [a, b] of cases) {
      const parts = merge(a, b);
      expect(reading(parts, 'ins').replace(/\s+/g, ' ')).toBe(a);
      expect(reading(parts, 'del').replace(/\s+/g, ' ')).toBe(b);
    }
  });

  it('keeps a space outside the mark where it joins another space, and marks a removal followed directly by its replacement', () => {
    const shown = markedText(merge('A ballot is counted.', 'A mail ballot is counted.'));
    expect(shown.find((p) => p.mark === 'ins')?.text).toBe('mail');
    const replaced = markedText(merge('Section 5.', 'Section 6.'));
    expect(replaced.map((p) => [p.mark, p.text, p.adjoins])).toEqual([[null, 'Section ', false], ['del', '5', false], ['ins', '6', true], [null, '.', false]]);
  });
});

describe('paragraphs that are not one edit (DB4)', () => {
  it('come as one run of removed paragraphs, then one run of added paragraphs', () => {
    const before: TextBlock[] = [['p', 'Keep this.'], ['p', '(a) The total number of votes cast.'], ['p', '(b) The number of votes cast for each candidate.'], ['p', 'End.']];
    const after: TextBlock[] = [['p', 'Keep this.'], ['p', '(1) Before drawing a draft map, hold hearings.'], ['p', '(2) After all draft maps are drawn, publish them.'], ['p', 'End.']];
    expect(diffBlocks(before, after).rows.map((r) => r.kind)).toEqual(['equal', 'delete', 'delete', 'insert', 'insert', 'equal']);
  });

  it('still pairs an edited paragraph among unrelated ones, keeping each version in order', () => {
    const before: TextBlock[] = [['p', 'Unrelated old text about polling hours.'], ['p', 'A ballot is counted if it arrives within three days.'], ['p', 'Old closing words on recount fees.']];
    const after: TextBlock[] = [['p', 'New wording on campaign filings entirely.'], ['p', 'A ballot is counted if it arrives within seven days.'], ['p', 'Another new paragraph on signature cure.']];
    const rows = diffBlocks(before, after).rows;
    expect(rows.map((r) => r.kind)).toEqual(['delete', 'insert', 'change', 'delete', 'insert']);
    const oldOrder = rows.flatMap((r) => ('oldIndex' in r ? [r.oldIndex] : []));
    const newOrder = rows.flatMap((r) => ('newIndex' in r ? [r.newIndex] : []));
    expect(oldOrder).toEqual([0, 1, 2]);
    expect(newOrder).toEqual([0, 1, 2]);
  });
});

describe('versions in reverse order (DB9)', () => {
  const versions = [
    { id: 'INT', versionDate: '2025-02-13' },
    { id: 'AMD', versionDate: '2025-04-01' },
    { id: 'AMD2', versionDate: '2025-04-01' },
    { id: 'CHP', versionDate: '2025-08-21' },
  ] as Parameters<typeof isReversed>[0];

  it('is reversed when the earlier version is dated later, or on the same day listed later', () => {
    expect(isReversed(versions, 'CHP', 'INT')).toBe(true);
    expect(isReversed(versions, 'INT', 'CHP')).toBe(false);
    expect(isReversed(versions, 'AMD2', 'AMD')).toBe(true);
    expect(isReversed(versions, 'AMD', 'AMD2')).toBe(false);
    expect(isReversed(versions, 'INT', 'INT')).toBe(false);
    expect(isReversed(versions, 'nope', 'INT')).toBe(false);
  });
});

describe('global search on pasted text (DB10)', () => {
  const geo = new GeoIndex(JSON.parse(readFileSync(join(DATA, 'geo/index.json'), 'utf8')));
  const cases = (JSON.parse(readFileSync(join(DATA, 'litigation/index.json'), 'utf8')) as { cases: Parameters<typeof buildSearchIndex>[1] }).cases;
  const bills = (JSON.parse(readFileSync(join(DATA, 'legislation/index.json'), 'utf8')) as { bills: Parameters<typeof buildSearchIndex>[2] }).bills;
  const index = buildSearchIndex(geo, cases, bills);
  const words = 'the qualified elector shall present identification documents before receiving provisional ballots'.split(' ');
  const paste = (n: number) => Array.from({ length: n }, (_, i) => `${words[i % words.length]}${i % 7 === 0 ? 'x' : ''}`).join(' ');

  it('answers 300 and 1,500 pasted words quickly, with no suggestions', () => {
    for (const n of [300, 1500]) {
      const start = performance.now();
      const result = searchWithSuggestions(index, paste(n));
      // Before the bound, 300 words took about 2 s here and 1,500 words about 10 s.
      expect(performance.now() - start, `${n} words`).toBeLessThan(250);
      expect(result.groups).toEqual([]);
    }
  });

  it('still suggests close spellings for a short query, and never for one longer than the bound', () => {
    expect(searchWithSuggestions(index, 'lousiana').approximate).toBe(true);
    const long = Array.from({ length: FUZZY_MAX_WORDS + 1 }, () => 'lousiana').map((w, i) => `${w}${'x'.repeat(i)}`).join(' ');
    expect(searchWithSuggestions(index, long).groups).toEqual([]);
  });
});

describe('source pack titles (DB12)', () => {
  it('name the subject of the pack', () => {
    const cases = [{ id: 'scotus-24-109', caseName: 'Louisiana v. Callais', docketNumber: '24-109' }];
    const bills = [{ id: 'ca-1', stateAbbr: 'CA', identifier: 'AB 604', subject: 'Redistricting: congressional districts.' }];
    const geo = { get: (key: string) => (key === 'state:22' ? { name: 'Louisiana' } : undefined) };
    expect(packTitle({ kind: 'case', id: 'scotus-24-109' }, cases, bills, geo)).toBe('Legal source pack: Louisiana v. Callais (No. 24-109)');
    expect(packTitle({ kind: 'bill', id: 'ca-1' }, cases, bills, geo)).toBe('Legal source pack: CA AB 604 (Redistricting: congressional districts)');
    expect(packTitle({ kind: 'place', id: 'state:22' }, cases, bills, geo)).toBe('Legal source pack: Louisiana');
    expect(packTitle({ kind: 'case', id: 'unknown' }, cases, bills, geo)).toBe('Legal source pack');
    expect(packTitle({ kind: 'case', id: 'scotus-24-109' }, null, null, null)).toBe('Legal source pack');
  });
});

describe('watchlist (DB6, DS7)', () => {
  it('moves focus to the next Remove button, then the last one, then the heading', () => {
    document.body.innerHTML = '<main><h1 tabindex="-1">Your watchlist</h1><ul id="l"><li><button data-remove>Remove a</button></li><li><button data-remove>Remove b</button></li></ul></main>';
    const list = document.getElementById('l')!;
    focusAfterRemoval(list, 0);
    expect(document.activeElement?.textContent).toBe('Remove a');
    focusAfterRemoval(list, 5);
    expect(document.activeElement?.textContent).toBe('Remove b');
    focusAfterRemoval(null, 0);
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('knows when the site shares a github.io origin with other sites', () => {
    expect(onSharedGithubOrigin('someone.github.io')).toBe(true);
    expect(onSharedGithubOrigin('SOMEONE.GITHUB.IO')).toBe(true);
    expect(onSharedGithubOrigin('github.io.example.org')).toBe(false);
    expect(onSharedGithubOrigin('democracy.example.org')).toBe(false);
    expect(onSharedGithubOrigin('127.0.0.1')).toBe(false);
  });
});

describe('places kept per history entry (DB5)', () => {
  it('records the place in the view being left and gives it back on Back', async () => {
    resetPlaces();
    window.history.replaceState(null, '', '#/laws');
    const panel = document.createElement('main');
    panel.innerHTML = '<a href="#/laws/x">x</a><a href="#/laws/y">y</a><a href="#/laws/y">y again</a>';
    document.body.append(panel);
    const link = panel.querySelectorAll('a')[2]!;
    let followed: Element | null = null;
    const stop = trackPlaces(() => panel, () => followed);
    const hashChange = () => new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    try {
      Object.defineProperty(panel, 'scrollTop', { value: 640, configurable: true, writable: true });
      followed = link;
      let changed = hashChange();
      window.location.hash = '#/laws/y';
      await changed;
      expect(lastArrival().kind).toBe('new');
      changed = hashChange();
      window.history.back();
      await changed;
      const arrival = lastArrival();
      expect(arrival.kind).toBe('traverse');
      expect(arrival.place).toMatchObject({ top: 640, link: { href: '#/laws/y', nth: 1 } });
    } finally {
      stop();
    }
  });
});
