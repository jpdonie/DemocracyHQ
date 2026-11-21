import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GeoIndex } from '../../src/lib/geo';
import { contrastRatio, LINE_CONTRAST, linesFadeInto, populationTheme, redrawnTheme } from '../../src/lib/mapTheme';
import { makeGeoIndexFile, makePopulationFile, makeRedistricting, populationRow } from './fixtures';

/** The colour tokens as the site defines them. */
const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const color = (name: string) => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
  if (!match) throw new Error(`no colour token ${name}`);
  return match[1]!;
};
const RAMP = ['--ramp-1', '--ramp-2', '--ramp-3', '--ramp-4', '--ramp-5'].map(color);

describe('boundary lines on a shaded map', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#85551b', '#85551b')).toBe(1);
  });

  it('knows that brown district lines vanish in the darkest population class (the same colour)', () => {
    expect(linesFadeInto(color('--geo'), RAMP)).toBe(true);
    expect(linesFadeInto(color('--ink-3'), RAMP)).toBe(true);
    // On the light "new boundaries" tint the brown lines are fine and are kept.
    expect(linesFadeInto(color('--geo'), [color('--geo-tint')])).toBe(false);
    expect(linesFadeInto(color('--geo'), [])).toBe(false);
  });

  it('draws an ink line over a land casing that stands out from every ramp step', () => {
    for (const step of RAMP) {
      expect(Math.max(contrastRatio(color('--ink'), step), contrastRatio(color('--land'), step)), step).toBeGreaterThanOrEqual(LINE_CONTRAST);
    }
  });
});

describe('the "new boundaries" theme', () => {
  const file = makeGeoIndexFile();
  file.rows.push(
    ['state:11', 'District of Columbia', '11', -77.1, 38.8, -76.9, 39], ['cd120:1198', 'Delegate District (at Large), District of Columbia', '11', -77.1, 38.8, -76.9, 39],
    ['cd120:7898', 'Delegate District (at Large), United States Virgin Islands', '78', -65, 17, -64, 18],
  );
  const geo = new GeoIndex(file);
  const quote = 'All other states, the District of Columbia, and Puerto Rico had no changes to their congressional district boundaries from the 2024 cycle.';

  it('explains the unshaded districts with what the Census Bureau states, and no more', () => {
    const theme = redrawnTheme('cd120', geo, makeRedistricting({ congress120: { ...makeRedistricting().congress120, unchangedQuote: quote } }));
    expect([...theme.classOf.keys()].sort()).toEqual(['4801', '4802']);
    expect(theme.plain).toBe('Census Bureau reports no change from the 2024 cycle');
    expect(theme.note).toContain(quote);
    // The statement names the District of Columbia and Puerto Rico but not the island areas: those are hatched, not called unchanged.
    expect(theme.hatch && theme.hatch.geoids !== 'rest' && [...theme.hatch.geoids]).toEqual(['7898']);
    expect(theme.hatch!.label).toMatch(/Not covered by the Census Bureau/);
  });

  it('claims nothing about unchanged boundaries when the statement is missing', () => {
    const theme = redrawnTheme('cd120', geo, makeRedistricting());
    expect(theme.plain).toBe('Not listed by the Census Bureau as having new boundaries');
    expect(theme.hatch).toBeNull();
  });

  it('is the only theme with plain, unexplained land', () => {
    const counts = makePopulationFile({ '0601': populationRow(760000) });
    expect(populationTheme('cd119', geo, counts, makeRedistricting()).plain).toBeNull();
  });
});
