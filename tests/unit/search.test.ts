import { describe, expect, it } from 'vitest';
import { GeoIndex } from '../../src/lib/geo';
import { buildSearchIndex, editDistance, search, searchWithSuggestions } from '../../src/lib/search';
import { makeBill, makeCase, makeGeoIndexFile } from './fixtures';

const geo = new GeoIndex(makeGeoIndexFile());
const index = buildSearchIndex(geo, [makeCase()], [makeBill()]);

const labels = (query: string, kind: 'place' | 'case' | 'bill') => search(index, query).find((g) => g.kind === kind)?.entries.map((e) => e.label) ?? [];

describe('global search', () => {
  it('returns nothing for queries shorter than two characters', () => {
    expect(search(index, '')).toEqual([]);
    expect(search(index, 'c')).toEqual([]);
  });

  it('finds a state by name and ranks it before its counties and districts', () => {
    expect(labels('california', 'place')[0]).toBe('California');
    expect(labels('texas', 'place')[0]).toBe('Texas');
  });

  it('finds a congressional district by postal shorthand', () => {
    const groups = search(index, 'CA-2');
    const ids = groups.find((g) => g.kind === 'place')!.entries.map((e) => e.id);
    expect(ids).toContain('cd120:0602');
    expect(ids).toContain('cd119:0602');
    expect(ids.indexOf('cd120:0602')).toBeLessThan(ids.indexOf('cd119:0602'));
  });

  it('tells the two district vintages apart in the detail line', () => {
    const entries = search(index, 'CA-2').find((g) => g.kind === 'place')!.entries;
    expect(new Set(entries.map((e) => e.detail))).toEqual(new Set(['Congressional district, 119th Congress', 'Congressional district, 120th Congress (2026 elections)']));
  });

  it('finds a county and a place by GEOID', () => {
    expect(labels('harris', 'place')).toEqual(['Harris County, Texas']);
    expect(labels('06037', 'place')).toEqual(['Los Angeles County, California']);
  });

  it('finds a case by party name, docket number or lower-court number', () => {
    expect(labels('alpha', 'case')).toEqual(['Synthetic Alpha v. Synthetic Beta']);
    expect(labels('99-0001', 'case')).toEqual(['Synthetic Alpha v. Synthetic Beta']);
    expect(labels('1:25-cv-00001', 'case')).toEqual(['Synthetic Alpha v. Synthetic Beta']);
  });

  it('finds a bill by number with or without a space', () => {
    expect(labels('ab1', 'bill')).toEqual(['CA AB 1']);
    expect(labels('ab 1', 'bill')).toEqual(['CA AB 1']);
  });

  it('requires every word to match and never guesses at a near miss', () => {
    expect(search(index, 'alpha zeta')).toEqual([]);
    expect(search(index, 'califronia')).toEqual([]);
  });

  it('reports the total and limits each group', () => {
    const group = search(index, 'congressional district', 2).find((g) => g.kind === 'place')!;
    expect(group.entries).toHaveLength(2);
    expect(group.total).toBe(8);
  });

  it('links each result to its route', () => {
    const groups = search(index, 'synthetic');
    expect(groups.find((g) => g.kind === 'case')!.entries[0]!.hash).toBe('#/litigation/synthetic-case-1');
    expect(search(index, 'california')[0]!.entries[0]!.hash).toBe('#/place/state:06');
  });
});

describe('place kinds in search results', () => {
  it('calls a territory a territory and the District of Columbia a federal district, not a state', () => {
    const file = makeGeoIndexFile();
    file.rows.push(['state:11', 'District of Columbia', '11', -77.1, 38.8, -76.9, 39], ['state:72', 'Puerto Rico', '72', -67.3, 17.9, -65.2, 18.5]);
    const places = buildSearchIndex(new GeoIndex(file), [], []);
    const detail = (query: string) => search(places, query)[0]!.entries[0]!.detail;
    expect(detail('district of columbia')).toBe('Federal district');
    expect(detail('puerto rico')).toBe('Territory');
    expect(detail('virgin islands')).toBe('Territory');
    expect(detail('texas')).toBe('State');
  });
});

describe('close spellings', () => {
  const suggest = (query: string) => searchWithSuggestions(index, query);

  it('counts a transposition or a doubled letter as one edit', () => {
    expect(editDistance('calais', 'callais')).toBe(1);
    expect(editDistance('louisianna', 'louisiana')).toBe(1);
    expect(editDistance('texsa', 'texas')).toBe(1);
    expect(editDistance('alpha', 'alpha')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('returns the exact results, unmarked, whenever anything matches', () => {
    const result = suggest('california');
    expect(result.approximate).toBe(false);
    expect(result.groups).toEqual(search(index, 'california'));
  });

  it('offers close spellings of a word of five or more letters when nothing matches', () => {
    const result = suggest('califronia');
    expect(result.approximate).toBe(true);
    expect(result.groups.find((g) => g.kind === 'place')!.entries[0]!.label).toBe('California');
    expect(suggest('synthetc alpha').groups.find((g) => g.kind === 'case')!.entries.map((e) => e.label)).toEqual(['Synthetic Alpha v. Synthetic Beta']);
  });

  it('allows two edits only in long words, and puts the closest spelling first', () => {
    expect(suggest('califrnai').approximate).toBe(true);
    expect(suggest('txeas').groups.flatMap((g) => g.entries.map((e) => e.label))[0]).toBe('Texas');
    expect(suggest('tixos').groups).toEqual([]);
  });

  it('never guesses at short words or numbers, and still requires every word to match', () => {
    expect(suggest('texs')).toEqual({ groups: [], approximate: false });
    expect(suggest('99-0002')).toEqual({ groups: [], approximate: false });
    expect(suggest('califronia zeta')).toEqual({ groups: [], approximate: false });
  });
});
