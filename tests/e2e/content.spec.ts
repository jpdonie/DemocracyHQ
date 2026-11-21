import type { Page } from '@playwright/test';
import { BILL, CASE, expect, heading, mapReady, open, test } from './fixtures';

/** Wording, in-page links and map encodings that the reviews found wrong. */

const BILL_1164 = { id: 'ca-20252026-ab1164', from: '20250AB116496AMD', to: '20250AB116495AMD' };

test.describe('Links within a page', () => {
  test('the link to the docket entries scrolls to them instead of opening a missing page', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const link = page.locator('figcaption').getByRole('link', { name: 'docket entries' });
    await expect(link).toHaveAttribute('href', `#/litigation/${CASE.id}?section=docket`);
    await link.click();
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(page).toHaveURL(new RegExp(`#/litigation/${CASE.id}$`));
    const section = page.getByRole('heading', { name: 'Docket entries', level: 2 });
    await expect(section).toBeFocused();
    await expect(section).toBeInViewport();

    // The link's own address, opened cold, lands on the same section.
    await open(page, `#/litigation/${CASE.id}?section=docket`);
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(section).toBeFocused();
    await expect(section).toBeInViewport();
  });

  test('no page links to a bare fragment, which the router would read as a missing page', async ({ page }) => {
    const pages = [
      '#/', '#/litigation', `#/litigation/${CASE.id}`, '#/laws', `#/laws/${BILL.id}`, `#/laws/${BILL.id}/compare?from=${BILL.from}&to=${BILL.to}`,
      '#/redistricting', '#/place/state:06', '#/place/state:06?tab=sources', '#/place/cd120:0612?tab=timeline', '#/sources', '#/about', '#/watchlist',
      `#/pack/case/${CASE.id}`,
    ];
    for (const hash of pages) {
      await open(page, hash);
      await expect(heading(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      const bare = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
        .map((a) => a.getAttribute('href')!).filter((href) => !href.startsWith('#/')));
      expect(bare, `bare fragment links on ${hash}`).toEqual([]);
    }
  });

  test('the export link on a place goes to the source pack and focuses it', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    await page.getByRole('link', { name: 'Export source pack' }).click();
    await expect(page).toHaveURL(/#\/place\/state:06\?tab=sources$/);
    const packHeading = page.getByRole('heading', { name: 'Legal source pack' });
    await expect(packHeading).toBeFocused();
    await expect(packHeading).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Download JSON' })).toBeInViewport();
  });
});

test.describe('Court case wording', () => {
  test('the judgment is named apart from later orders', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    // The page of a case has two figures: the quotation at its head, and the ruling entry quoted from the docket.
    const caption = page.locator('figure.quote-block figcaption');
    await expect(caption).toContainText('2 later orders appear in the docket entries, and the judgment was issued on May 4, 2026.');

    // A case whose only later entry is the judgment does not call it an order.
    await open(page, '#/litigation/scotus-24-568');
    await expect(caption).toContainText('The judgment was issued on Feb 17, 2026; see the docket entries.');
    await expect(caption).not.toContainText('later order');
  });

  test('each document link in a docket entry has its own name', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}?entries=all`);
    await expect(heading(page)).toHaveText(CASE.name);
    const lists = page.locator('.entry-docs');
    await expect(lists.first()).toBeVisible();
    const names = await lists.evaluateAll((uls) => uls.map((ul) => [...ul.querySelectorAll('a')].map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim())));
    expect(names.length).toBeGreaterThan(10);
    for (const list of names) {
      expect(new Set(list).size, `link names in one entry: ${list.join(' | ')}`).toBe(list.length);
      for (const name of list) expect(name).not.toMatch(/^(\w[\w ]*): \1\b/);
    }
  });
});

test.describe('Places that are not states', () => {
  test('a territory and the federal district are named as such', async ({ page }) => {
    await open(page, '#/place/state:72');
    await expect(heading(page)).toHaveText('Puerto Rico');
    await expect(page.locator('.lede').first()).toHaveText(/^Territory \(PR\)\. Census GEOID 72\./);
    await expect(page.getByText('Legislation not covered for this territory yet')).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/this state\b/);

    await open(page, '#/place/state:11');
    await expect(page.locator('.lede').first()).toHaveText(/^Federal district \(DC\)\. Census GEOID 11\./);
    await expect(page.getByText('Legislation not covered for this federal district yet')).toBeVisible();

    await open(page, '#/');
    const search = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    await search.fill('district of columbia');
    await expect(page.getByRole('option', { name: /^District of Columbia/ }).first()).toContainText('Federal district');
    await search.fill('puerto rico');
    await expect(page.getByRole('option', { name: /^Puerto Rico/ }).first()).toContainText('Territory');
  });

  test('a population difference of one is "1 person"', async ({ page }) => {
    await open(page, '#/place/cd120:3607');
    await expect(page.locator('main')).toContainText(/\+1 person\b/);
    await expect(page.locator('main')).not.toContainText('1 persons');
  });
});

test.describe('Source pack', () => {
  test('a case pack says it lists key entries only, marks shortened text and keeps headings with their content in print', async ({ page }) => {
    await open(page, `#/pack/case/${CASE.id}`);
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await expect(page.locator('.pack-section-note')).toContainText(/^Key entries only: \d+ of \d+ docket entries, selected by the published rules/);
    await expect(page.locator('.pack-shortened').first()).toHaveText('[Shortened in this summary. The JSON and CSV downloads carry the full text.]');
    await page.emulateMedia({ media: 'print' });
    const breaks = await page.locator('.pack h2').evaluateAll((h2s) => h2s.map((h2) => getComputedStyle(h2).breakAfter));
    expect(breaks.length).toBeGreaterThan(1);
    expect(new Set(breaks)).toEqual(new Set(['avoid']));
  });
});

test.describe('Home', () => {
  test('the latest entries show each kind of record and fold same-day boundary entries into one row', async ({ page }) => {
    await open(page, '#/');
    const items = page.locator('main .timeline-item');
    await expect(items.first()).toBeVisible();
    await expect(page.locator('main .timeline-item.cat-litigation')).not.toHaveCount(0);
    await expect(page.locator('main .timeline-item.cat-legislation')).not.toHaveCount(0);
    const boundary = page.locator('main .timeline-item.cat-geography');
    await expect(boundary).toHaveCount(1);
    const entity = boundary.locator('.timeline-entity');
    const count = Number((await entity.innerText()).match(/\((\d+)\):/)?.[1]);
    expect(count).toBeGreaterThan(1);
    await expect(entity.getByRole('link')).toHaveCount(count);
    await expect(boundary.locator('.timeline-text')).toHaveText(/^The same entry for each: /);
  });
});

test.describe('Bill text', () => {
  test('the effective date states its caveat once, with no doubled full stop', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const cell = page.locator('.status-cell', { has: page.getByRole('heading', { name: 'Effective date' }) });
    await expect(cell).toBeVisible();
    const text = await cell.innerText();
    expect(text.match(/not recorded/g) ?? []).toHaveLength(1);
    expect(text).not.toMatch(/\.["”’]?\s*\./);
  });

  test('a replaced word is shown as a deletion and an insertion apart from each other', async ({ page }) => {
    await open(page, `#/laws/${BILL_1164.id}/compare?from=${BILL_1164.from}&to=${BILL_1164.to}`);
    const changed = page.locator('.blk-chg');
    await expect(changed.first()).toBeVisible({ timeout: 20_000 });
    const html = await changed.evaluateAll((ps) => ps.map((p) => p.innerHTML));
    // No space is added between them (it would be in neither text); a mark that follows another directly is set apart by a margin.
    expect(html.filter((h) => /<\/(del|ins)><(ins|del)>/.test(h)), 'a deletion that runs straight into an insertion with no margin').toEqual([]);
    expect(html.filter((h) => /<(del|ins)>\s|\s<\/(del|ins)>/.test(h)), 'a mark that starts or ends with a space').toEqual([]);
    expect(html.join('')).toContain('<del>yet cast</del><ins class="adjoins">submitted</ins>');
    const gap = await page.locator('.blk-chg ins.adjoins').first().evaluate((ins) => parseFloat(getComputedStyle(ins).marginInlineStart));
    expect(gap).toBeGreaterThan(2);
  });

  test('a compare link with unknown version ids names them', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}/compare?from=X&to=Y`);
    const notice = page.locator('.notice-missing');
    await expect(notice).toContainText('The link asks for text versions that are not available here.');
    await expect(notice.locator('.geoid')).toHaveText(['X', 'Y']);
    await expect(notice).toContainText('No version of California AB 604 in this dataset has this id.');
    await expect(notice).toContainText(/Showing the text of the .+ version instead\./);
  });
});

test.describe('Search', () => {
  test('a misspelt name offers close matches, without fetching anything', async ({ page }) => {
    await open(page, '#/');
    const search = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    await page.waitForLoadState('networkidle');
    const requests: string[] = [];
    // The map may still fetch label glyphs; the search itself must not ask the server for anything.
    page.on('request', (request) => { if (!/\/fonts\//.test(new URL(request.url()).pathname)) requests.push(request.url()); });
    await search.fill('louisianna');
    await expect(page.getByText('Did you mean:')).toBeVisible();
    await expect(page.getByRole('option', { name: /^Louisiana/ }).first()).toBeVisible();
    expect(requests).toEqual([]);
    await search.press('Enter');
    await expect(page).toHaveURL(/#\/place\/state:22$/);

    await search.fill('calais');
    await expect(page.getByRole('option', { name: /^Louisiana v\. Phillip Callais/ })).toBeVisible();
    await search.fill('zzzzzz');
    await expect(page.getByText('Did you mean:')).toBeHidden();
  });
});

/** Parse #rrggbb or rgb(r, g, b) into relative luminance (WCAG 2). */
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color.trim());
  const parts = hex ? hex.slice(1).map((h) => parseInt(h, 16)) : rgb ? rgb.slice(1).map(Number) : null;
  if (!parts) throw new Error(`unreadable colour ${color}`);
  const [r, g, b] = parts.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

async function linePaint(page: Page, layer: string) {
  return page.evaluate((name) => {
    const map = (window as unknown as { __dhqMap: { getPaintProperty(l: string, p: string): string; getLayoutProperty(l: string, p: string): string } }).__dhqMap;
    return {
      line: map.getPaintProperty(`${name}-line`, 'line-color'),
      casing: map.getPaintProperty(`${name}-casing`, 'line-color'),
      cased: map.getLayoutProperty(`${name}-casing`, 'visibility') === 'visible',
    };
  }, layer);
}

async function legendFills(page: Page) {
  return page.locator('.legend-classes li:not(.legend-hatch):not(.legend-plain) .swatch').evaluateAll((swatches) => swatches.map((s) => getComputedStyle(s).backgroundColor));
}

test.describe('Map encodings', () => {
  for (const layer of ['cd119', 'county', 'state'] as const) {
    test(`boundary lines stand out from every population class on the ${layer} layer`, async ({ page }) => {
      await open(page, `#/redistricting?layer=${layer}&shade=population`, { withMap: true });
      await mapReady(page, layer);
      await expect(page.locator('.legend')).toContainText('Total population, 2020 Census');
      const fills = await legendFills(page);
      expect(fills.length).toBeGreaterThanOrEqual(4);
      for (const name of layer === 'state' ? ['state'] : [layer, 'state']) {
        const paint = await linePaint(page, name);
        for (const fill of fills) {
          const best = Math.max(contrast(paint.line, fill), paint.cased ? contrast(paint.casing, fill) : 0);
          expect(best, `${name} lines on ${fill} (line ${paint.line}, casing ${paint.cased ? paint.casing : 'off'})`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  test('without shading, district lines keep their own colour and no casing', async ({ page }) => {
    await open(page, '#/redistricting?layer=cd119&shade=none', { withMap: true });
    await mapReady(page, 'cd119');
    // The map stage has its own values for the colour tokens: the line is in the stage's brown.
    const geo = await page.evaluate(() => getComputedStyle(document.querySelector('.mapstage')!).getPropertyValue('--geo').trim());
    const paint = await linePaint(page, 'cd119');
    expect(paint.line.toLowerCase()).toBe(geo.toLowerCase());
    expect(paint.cased).toBe(false);
  });

  test('the new-boundaries legend and tooltip say what an unshaded district means', async ({ page }) => {
    await open(page, '#/redistricting', { withMap: true });
    await mapReady(page, 'cd120');
    const legend = page.locator('.legend');
    await expect(legend.locator('.legend-plain')).toHaveText('Census Bureau reports no change from the 2024 cycle');
    await expect(legend.locator('.legend-hatch')).toHaveText('Not covered by the Census Bureau’s statement on unchanged boundaries');
    await expect(legend).toContainText('All other states, the District of Columbia, and Puerto Rico had no changes');

    // Kansas is not among the states with new boundaries.
    const kansas = await page.evaluate(() => {
      const map = (window as unknown as { __dhqMap: { project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement } }).__dhqMap;
      const point = map.project([-98.3, 38.5]);
      const box = map.getCanvas().getBoundingClientRect();
      return { x: box.left + point.x, y: box.top + point.y, onCanvas: document.elementFromPoint(box.left + point.x, box.top + point.y) === map.getCanvas() };
    });
    expect(kansas.onCanvas).toBe(true);
    await page.mouse.move(kansas.x, kansas.y);
    const tooltip = page.locator('.map-tooltip');
    await expect(tooltip).toContainText('Kansas');
    await expect(tooltip).toContainText('Census Bureau reports no change from the 2024 cycle');
  });
});
