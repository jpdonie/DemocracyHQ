import { describe, expect, it } from 'vitest';
import { GeoIndex, geoKey, isDistrictLayer, parseGeoKey, shortLabel, unionBbox } from '../../src/lib/geo';
import { datasetFor, districtDeviation, groupBreakdown, groupsSumToTotal, populationFor } from '../../src/lib/population';
import { classIndex, populationTheme, quantileBreaks, redrawnTheme, roundBreak, linkedRecordsTheme, legislationTheme } from '../../src/lib/mapTheme';
import { makeGeoIndexFile, makePopulationFile, makeRedistricting, populationRow } from './fixtures';

const geo = new GeoIndex(makeGeoIndexFile());
// Synthetic counts keyed by GEOID, as in the published files.
const cd119 = makePopulationFile({ '0601': populationRow(760000), '0602': populationRow(761000), '4801': populationRow(766000), '4802': populationRow(768000) });
const states = makePopulationFile({ '06': populationRow(1521000), '48': populationRow(1534000) }, 'synthetic-state');
const counties = makePopulationFile({ '06037': populationRow(10000000) }, 'synthetic-county');
const redistricting = makeRedistricting();

describe('geographic keys', () => {
  it('parses and builds "<layer>:<GEOID>" keys', () => {
    expect(parseGeoKey('cd120:0612')).toEqual({ layer: 'cd120', geoid: '0612' });
    expect(parseGeoKey('county:06037')).toEqual({ layer: 'county', geoid: '06037' });
    expect(geoKey('state', '06')).toBe('state:06');
  });

  it('keeps leading zeros: a GEOID is text, never a number', () => {
    expect(parseGeoKey('state:06')?.geoid).toBe('06');
    expect(parseGeoKey('state:6')).toBeNull();
  });

  it('rejects unknown layers and malformed keys', () => {
    for (const bad of ['precinct:0601', 'cd118:0601', 'state', 'state:', ':06', 'state:06:1', 'state:../x', '']) expect(parseGeoKey(bad)).toBeNull();
  });

  it('treats the two Congress layers as different places with the same number', () => {
    expect(geo.get('cd119:0601')?.layer).toBe('cd119');
    expect(geo.get('cd120:0601')?.layer).toBe('cd120');
    expect(geo.get('cd119:0601')).not.toBe(geo.get('cd120:0601'));
    expect(isDistrictLayer('cd119') && isDistrictLayer('cd120') && !isDistrictLayer('county')).toBe(true);
  });

  it('indexes units by layer and state', () => {
    expect(geo.inState('cd120', '06').map((u) => u.geoid)).toEqual(['0601', '0602']);
    expect(geo.inState('county', '48').map((u) => u.name)).toEqual(['Harris County, Texas']);
    expect(geo.inState('county', '36')).toEqual([]);
    expect(geo.stateName('06')).toBe('California');
    expect(geo.stateName('99')).toBe('State 99');
    expect(geo.size).toBe(13);
  });

  it('labels units briefly', () => {
    expect(shortLabel(geo.get('state:06')!)).toBe('CA');
    expect(shortLabel(geo.get('county:06037')!)).toBe('Los Angeles');
    expect(shortLabel(geo.get('cd120:0602')!)).toBe('2');
    expect(shortLabel({ key: 'cd120:0200', layer: 'cd120', geoid: '0200', name: 'x', stateFips: '02', bbox: [0, 0, 1, 1] })).toBe('At large');
  });

  it('unions bounding boxes', () => {
    expect(unionBbox([])).toBeNull();
    expect(unionBbox([[-10, 0, -5, 5], [-7, -2, 3, 4]])).toEqual([-10, -2, 3, 5]);
  });
});

describe('population lookups join on GEOID and respect the vintage of the counts', () => {
  it('chooses the dataset by layer', () => {
    expect(datasetFor('state:06')).toBe('state');
    expect(datasetFor('county:06037')).toBe('county');
    expect(datasetFor('cd119:0601')).toBe('cd119');
    expect(datasetFor('cd120:0601')).toBe('cd119');
    expect(datasetFor('nonsense')).toBeNull();
  });

  it('returns the published row for a state, a county and a 119th Congress district', () => {
    const state = populationFor('state:06', states, redistricting);
    expect(state.status === 'available' && state.values.total).toBe(1521000);
    const county = populationFor('county:06037', counties, redistricting);
    expect(county.status === 'available' && county.values.total).toBe(10000000);
    const district = populationFor('cd119:4801', cd119, redistricting);
    expect(district.status === 'available' && district.values.total).toBe(766000);
    expect(district.status === 'available' && district.carriedFrom).toBeUndefined();
  });

  it('withholds counts for 120th Congress districts in a state with new boundaries', () => {
    const result = populationFor('cd120:4801', cd119, redistricting);
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toMatch(/has not yet published 2020 Census counts/);
    // The 119th Congress row with the same number exists, and must not leak through.
    expect(cd119.rows['4801']).toBeDefined();
  });

  it('carries 119th Congress counts to a 120th Congress district only in an unchanged state, and says so', () => {
    const result = populationFor('cd120:0601', cd119, redistricting);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.values.total).toBe(760000);
    expect(result.carriedFrom).toBe('cd119:0601');
    expect(result.note).toMatch(/no new boundaries/);
  });

  it('withholds a carried count when the district failed the land-area check', () => {
    const flagged = makeRedistricting({ areaCheck: { ...redistricting.areaCheck!, mismatches: ['0601'] } });
    const result = populationFor('cd120:0601', cd119, flagged);
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toMatch(/land area differs/);
    expect(populationFor('cd120:0602', cd119, flagged).status).toBe('available');
    // The 119th Congress district itself is unaffected.
    expect(populationFor('cd119:0601', cd119, flagged).status).toBe('available');
  });

  it('shows nothing for 120th Congress districts when the list of redrawn states cannot be loaded', () => {
    expect(populationFor('cd120:0601', cd119, null).status).toBe('unavailable');
  });

  it('reports a missing row as unavailable with a reason, never as zero', () => {
    const county = populationFor('county:48201', counties, redistricting);
    expect(county).toEqual({ status: 'unavailable', reason: expect.stringMatching(/^No count is shown for this county equivalent/) });
    expect(populationFor('cd119:0699', cd119, redistricting).status).toBe('unavailable');
    expect(populationFor('state:78', states, redistricting).status).toBe('unavailable');
    expect(populationFor('bogus', states, redistricting).status).toBe('unavailable');
  });

  it('refuses a row whose length does not match the variable list', () => {
    const broken = makePopulationFile({ '06': [1, 2, 3] }, 'synthetic-state');
    expect(populationFor('state:06', broken, redistricting).status).toBe('unavailable');
  });
});

describe('group breakdown', () => {
  const values = Object.fromEntries(cd119.variables.map((v, i) => [v.key, cd119.rows['0601']![i]!]));

  it('checks that the mutually exclusive groups add up to the total', () => {
    expect(groupsSumToTotal(values)).toBe(true);
    expect(groupsSumToTotal({ ...values, white: values.white! + 1 })).toBe(false);
    expect(groupsSumToTotal({})).toBe(false);
  });

  it('computes shares of total and of voting-age population that sum to one', () => {
    const rows = groupBreakdown(values);
    expect(rows).toHaveLength(8);
    expect(rows.reduce((a, r) => a + (r.share ?? 0), 0)).toBeCloseTo(1, 10);
    expect(rows.reduce((a, r) => a + (r.vapShare ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it('gives no share when the total is zero', () => {
    expect(groupBreakdown({ total: 0, vap_total: 0 }).every((r) => r.share === null && r.vapShare === null)).toBe(true);
  });
});

describe('district deviation from the ideal population', () => {
  it('is computed within one state and one plan', () => {
    const d = districtDeviation('0601', cd119)!;
    expect(d.districts).toBe(2);
    expect(d.ideal).toBe(760500);
    expect(d.persons).toBe(-500);
    expect(d.fraction).toBeCloseTo(-500 / 760500, 12);
  });

  it('is not computed for a single-district state or an unknown district', () => {
    const single = makePopulationFile({ '0200': populationRow(733000) });
    expect(districtDeviation('0200', single)).toBeNull();
    expect(districtDeviation('0699', cd119)).toBeNull();
  });
});

describe('map themes never grade places by how many records the dataset holds', () => {
  it('"linked records" is a yes/no class with everything else hatched as not in this dataset', () => {
    const theme = linkedRecordsTheme(new Map([['06', 14], ['48', 1], ['36', 0]]), 'cases');
    expect(theme.classes).toHaveLength(1);
    expect(theme.classOf.get('06')).toBe(theme.classOf.get('48'));
    expect(theme.classOf.has('36')).toBe(false);
    expect(theme.hatch).toEqual({ geoids: 'rest', label: expect.stringMatching(/Not evidence that none exists/) });
  });

  it('legislation is a yes/no class, with the count and the reason for an empty state in the tooltip', () => {
    const theme = legislationTheme(new Map([['06', 300], ['22', 4], ['36', 0]]), false, new Map([['24', 'Not listed yet: no secure address.'], ['22', 'never shown']]));
    expect(theme.classes).toHaveLength(1);
    expect(theme.classOf.get('06')).toBe(theme.classOf.get('22'));
    expect(theme.classOf.has('36')).toBe(false);
    expect(theme.hatch).toEqual({ geoids: 'rest', label: expect.stringMatching(/Not evidence that none exists/) });
    expect(theme.detailOf?.get('22')).toBe('4 election measures of the state’s legislature in this dataset');
    expect(theme.detailOf?.get('24')).toBe('Not listed yet: no secure address.');
    const filtered = legislationTheme(new Map([['22', 1]]), true);
    expect(filtered.detailOf?.get('22')).toBe('1 measure of the state’s legislature matches the filters');
    expect(filtered.title).toBe('State legislation that matches the filters');
  });

  it('marks the districts of states with new boundaries', () => {
    const theme = redrawnTheme('cd120', geo, redistricting);
    expect([...theme.classOf.keys()].sort()).toEqual(['4801', '4802']);
  });

  it('population shading hatches units without a compatible count', () => {
    const theme = populationTheme('cd120', geo, cd119, redistricting);
    expect(theme.hatch && theme.hatch.geoids !== 'rest' && [...theme.hatch.geoids].sort()).toEqual(['4801', '4802']);
    expect([...theme.classOf.keys()].sort()).toEqual(['0601', '0602']);
    const withheld = populationTheme('cd120', geo, cd119, makeRedistricting({ areaCheck: { ...redistricting.areaCheck!, mismatches: ['0602'] } }));
    expect(withheld.hatch && withheld.hatch.geoids !== 'rest' && withheld.hatch.geoids.has('0602')).toBe(true);
    expect(populationTheme('cd120', geo, cd119, null).classOf.size).toBe(0);
    expect(populationTheme('cd119', geo, cd119, redistricting).hatch).toBeNull();
  });

  it('class limits are rounded to two significant digits and are the limits actually used', () => {
    expect(roundBreak(761234)).toBe(760000);
    expect(roundBreak(0)).toBe(0);
    const breaks = quantileBreaks([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 5);
    expect(breaks).toEqual([30, 50, 70, 90]);
    expect(classIndex(29, breaks)).toBe(0);
    expect(classIndex(30, breaks)).toBe(1);
    expect(classIndex(1000, breaks)).toBe(4);
  });

  it('labels every population class with its limits', () => {
    const theme = populationTheme('state', geo, states, redistricting);
    expect(theme.classes.length).toBeGreaterThan(0);
    for (const c of theme.classes) expect(c.label).toMatch(/Under|or more|to under/);
  });
});
