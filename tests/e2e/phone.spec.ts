import type { Page } from '@playwright/test';
import { axeViolations, BILL, brokenWords, CASE, clickMap, expect, heading, mapReady, open, sidewaysOverflow, test } from './fixtures';

/** Runs in the phone project only (see playwright.config.ts). */
test.describe('Phone layout', () => {
  test('moves between the sections with the tab bar', async ({ page }) => {
    await open(page, '#/');
    await expect(heading(page)).toHaveText(/^Election litigation, voting laws/);
    const tabbar = page.getByRole('navigation', { name: 'Sections' });
    await expect(tabbar).toBeVisible();
    // The desktop module links are replaced by the tab bar, not shown twice.
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeHidden();

    await tabbar.getByRole('link', { name: 'Litigation' }).tap();
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(tabbar.getByRole('link', { name: 'Litigation' })).toHaveAttribute('aria-current', 'page');
    await tabbar.getByRole('link', { name: 'Laws' }).tap();
    await expect(heading(page)).toHaveText('Election legislation');
    await tabbar.getByRole('link', { name: 'Districts' }).tap();
    await expect(heading(page)).toHaveText('Districts and boundaries');
    await tabbar.getByRole('link', { name: 'Sources', exact: true }).tap();
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await tabbar.getByRole('link', { name: 'Map' }).tap();
    await expect(heading(page)).toHaveText(/^Election litigation, voting laws/);
  });

  test('the bottom sheet grows and shrinks, and never traps the map behind it', async ({ page }) => {
    await open(page, '#/');
    const app = page.locator('.app');
    await expect(app).toHaveAttribute('data-sheet', 'half');
    const map = page.getByRole('region', { name: 'Map', exact: true });
    await expect(map).toBeVisible();

    await page.getByRole('button', { name: 'Show more detail' }).tap();
    await expect(app).toHaveAttribute('data-sheet', 'full');
    await expect(page.getByRole('button', { name: 'Show more detail' })).toBeDisabled();
    // With the sheet covering the map, the map's controls leave the tab order and the accessibility tree.
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();

    await page.getByRole('button', { name: 'Show more map' }).tap();
    await page.getByRole('button', { name: 'Show more map' }).tap();
    await expect(app).toHaveAttribute('data-sheet', 'peek');
    await expect(page.getByRole('button', { name: 'Show more map' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    // The heading of the current view stays readable above the tab bar.
    await expect(heading(page)).toBeInViewport();
  });

  test('a state can be opened by tapping the map', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await clickMap(page, [-98.3, 38.5]);
    await expect(page).toHaveURL(/#\/place\/state:20$/);
    await expect(heading(page)).toHaveText('Kansas');
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('2,937,880');
  });

  test('a case and a bill are readable without sideways scrolling', async ({ page }) => {
    await expectNoSidewaysOverflow(page);
  });

  test('every section tab of a place is visible without sideways scrolling', async ({ page }) => {
    await open(page, '#/place/state:06');
    const tabs = page.getByRole('tablist', { name: 'Sections for this place' });
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    const hidden = await tabs.evaluate((list) => {
      const outer = list.getBoundingClientRect();
      return [...list.querySelectorAll('[role="tab"]')]
        .filter((tab) => { const r = tab.getBoundingClientRect(); return r.left < outer.left - 1 || r.right > outer.right + 1; })
        .map((tab) => tab.textContent);
    });
    expect(hidden).toEqual([]);
  });

  test('search opens a place', async ({ page }) => {
    await open(page, '#/');
    const search = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    await search.fill('wyoming');
    await page.getByRole('option', { name: /^Wyoming State/ }).tap();
    await expect(page).toHaveURL(/#\/place\/state:56$/);
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('576,851');
  });

  for (const [hash, title] of [['#/', /^Election litigation, voting laws/], ['#/place/state:06', 'California'], [`#/litigation/${CASE.id}`, CASE.name], [`#/laws/${BILL.id}`, BILL.heading], ['#/sources', 'Data sources and methodology'], ['#/place/county:06037', 'Los Angeles County, California']] as const) {
    test(`no automated accessibility violations on ${hash}`, async ({ page }) => {
      await open(page, hash);
      await expect(heading(page)).toHaveText(title);
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('no automated accessibility violations with the related-geography lists open', async ({ page }) => {
    // The lists sit in closed disclosures, where axe cannot see them: open every one first.
    for (const hash of ['#/place/state:06', '#/place/county:06037']) {
      await open(page, hash);
      const lists = page.locator('details.unit-list');
      await expect(lists.first(), `related lists on ${hash}`).toBeAttached();
      await page.waitForLoadState('networkidle');
      for (const summary of await lists.locator('summary').all()) await summary.tap();
      await expect(lists.locator('ul').first()).toBeVisible();
      // Every link is a row at least 24px tall (WCAG 2.2, 2.5.8).
      const short = await lists.evaluateAll((all) => all.flatMap((list) => [...list.querySelectorAll('a')].map((a) => a.getBoundingClientRect().height).filter((h) => h < 24)));
      expect(short, `links under 24px on ${hash}`).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    }
  });
});

const READING_VIEWS = [
  [`#/litigation/${CASE.id}`, CASE.name],
  [`#/laws/${BILL.id}`, BILL.heading],
  [`#/laws/${BILL.id}/compare?from=${BILL.from}&to=${BILL.to}`, `Compare text versions: ${BILL.heading}`],
  ['#/sources', 'Data sources and methodology'],
  ['#/place/state:06', 'California'],
  [`#/pack/bill/${BILL.id}`, /AB 604/],
  ['#/pack/place/state:06', 'California'],
  ['#/redistricting', 'Districts and boundaries'],
] as const;

/**
 * Neither the page nor the scrolling panel may be wider than the screen. At the normal text size no table needs
 * its own sideways scroller either; at a large text size (`textScale`) a table may scroll inside its scroller.
 */
async function expectNoSidewaysOverflow(page: Page, textScale = 1) {
  for (const [hash, title] of READING_VIEWS) {
    await open(page, hash);
    await expect(heading(page)).toHaveText(title);
    await page.waitForLoadState('networkidle');
    if (textScale !== 1) await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale * 100}%`; }, textScale);
    // The table scrollers measure themselves when the text size changes; let that settle.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overflow = await sidewaysOverflow(page);
    expect(overflow.document, `sideways overflow of the page on ${hash}`).toBeLessThanOrEqual(0);
    expect(overflow.panel, `sideways overflow of the panel on ${hash}`).toBeLessThanOrEqual(0);
    if (textScale === 1) expect(overflow.tables, `a table wider than the panel on ${hash}`).toBeLessThanOrEqual(0);
  }
}

test.describe('Phone layout, details', () => {
  test('tables keep their words whole', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(page.getByRole('region', { name: 'Issue tags' }).getByRole('table')).toBeVisible();
    expect(await brokenWords(page, 'main .table')).toEqual([]);
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    expect(await brokenWords(page, 'main .table')).toEqual([]);
  });

  test('the search results fit the screen', async ({ page }) => {
    await open(page, '#/');
    await page.getByRole('combobox', { name: 'Search places, courts, cases and bills' }).fill('california');
    const list = page.getByRole('listbox', { name: 'Search results' });
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect((await sidewaysOverflow(page)).document).toBeLessThanOrEqual(0);
  });

  test('keyboard focus is never hidden under the sheet bar', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    await page.waitForLoadState('networkidle');
    // Scroll a link in the middle of the panel up behind the sticky bar, focus the next control, then go back one stop.
    const hidden = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.panel')!;
      const stops = [...panel.querySelectorAll<HTMLElement>('a[href], button, summary, input, select, [tabindex="0"]')].filter((el) => el.getBoundingClientRect().height > 0);
      const small = stops.filter((el) => el.getBoundingClientRect().height < 40 && el.closest('.view'));
      const target = small[Math.floor(small.length / 2)]!;
      const next = stops[stops.indexOf(target) + 1]!;
      target.dataset.probe = 'target';
      next.focus({ preventScroll: true });
      const bar = document.querySelector('.sheet-bar')!.getBoundingClientRect();
      panel.scrollTop += target.getBoundingClientRect().top - bar.top - 4;
      return target.getBoundingClientRect().bottom <= bar.bottom;
    });
    expect(hidden, 'the link starts out behind the sheet bar').toBe(true);
    await page.keyboard.press('Shift+Tab');
    const target = page.locator('[data-probe="target"]');
    await expect(target).toBeFocused();
    const barBottom = await page.locator('.sheet-bar').evaluate((bar) => bar.getBoundingClientRect().bottom);
    expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(barBottom);
  });

  test('the sheet buttons keep focus at either end and say how big the sheet is', async ({ page }) => {
    await open(page, '#/');
    const more = page.getByRole('button', { name: 'Show more detail' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.app')).toHaveAttribute('data-sheet', 'full');
    await expect(more).toBeDisabled();
    await expect(more).toBeFocused();
    await expect(more).toHaveAccessibleDescription(/full height/);
    await expect(page.getByRole('status').filter({ hasText: 'Panel at full height' })).toHaveCount(1);

    const less = page.getByRole('button', { name: 'Show more map' });
    await less.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('.app')).toHaveAttribute('data-sheet', 'peek');
    await expect(less).toBeFocused();
    await expect(less).toHaveAccessibleDescription(/lowered/);
  });

  test('the watchlist and the about page are reachable from the top bar', async ({ page }) => {
    await open(page, '#/litigation');
    const more = page.locator('.topnav-more > summary');
    await more.tap();
    const menu = page.getByRole('navigation', { name: 'Other pages' });
    await expect(menu).toBeVisible();
    await menu.getByRole('link', { name: 'Watchlist' }).tap();
    await expect(heading(page)).toHaveText('Your watchlist');
    await expect(menu).toBeHidden();

    await more.tap();
    await menu.getByRole('link', { name: 'About and corrections' }).tap();
    await expect(heading(page)).toHaveText('About DemocracyHQ');
  });

  test('the More menu closes when keyboard focus moves on past it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await page.locator('.topnav-more > summary').focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('navigation', { name: 'Other pages' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'Watchlist' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'About and corrections' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
    // The controls that take focus next are not covered by the menu (WCAG 2.2, 2.4.11).
    for (const name of ['Show more map', 'Show more detail']) {
      const button = page.getByRole('button', { name });
      await expect(button).toBeFocused();
      const covered = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(hit && el.contains(hit));
      });
      expect(covered, `${name} is covered`).toBe(false);
      await page.keyboard.press('Tab');
    }
  });

  test('the search placeholder is not cut off in the top bar', async ({ page }) => {
    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await open(page, '#/litigation');
      await expect(heading(page)).toHaveText('Election litigation');
      const fit = await placeholderFit(page);
      expect(fit.need, `placeholder "${fit.text}" at ${width}px`).toBeLessThanOrEqual(fit.room);
    }
  });

  test('adding to the watchlist offers a way to the list, and the pressed button keeps its contrast', async ({ page }) => {
    await open(page, '#/place/county:06037');
    await page.getByRole('button', { name: 'Add to watchlist' }).tap();
    // On a touch screen the hover state stays after a tap; the pressed button must still read white on dark.
    await expect(page.getByRole('button', { name: 'Remove from watchlist' })).toHaveCSS('background-color', 'rgb(23, 35, 59)');
    await page.waitForLoadState('networkidle');
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('link', { name: 'View watchlist' }).tap();
    await expect(heading(page)).toHaveText('Your watchlist');
    await expect(page.getByRole('link', { name: /Los Angeles County/ })).toBeVisible();
  });

  test('directory filters fold away, and clearing them keeps focus', async ({ page }) => {
    await open(page, '#/litigation?tag=redistricting&q=louisiana');
    await expect(heading(page)).toHaveText('Election litigation');
    const status = page.locator('.filters-status');
    await expect(status).toContainText(/match these filters/);
    // The selects sit behind a disclosure that counts what is set; the result count stays on screen.
    await expect(page.getByText('More filters (1 set)')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Issue' })).toBeHidden();
    await expect(status).toBeInViewport();

    const clear = status.getByRole('button', { name: 'Clear filters' });
    expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await clear.tap();
    await expect(status).toContainText(/^\d+ cases in this dataset/);
    await expect(status).toBeFocused();
  });

  test('the result count stays near the top while the folded filters are open', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [hash, searchName, query] of [['#/litigation', 'Search case name, docket number or quoted passage', 'louisiana'], ['#/laws', 'Search measure number, title or summary', 'district']] as const) {
      await open(page, hash);
      await page.getByRole('searchbox', { name: searchName }).fill(query);
      await page.getByText('More filters', { exact: true }).tap();
      const issue = page.getByRole('combobox', { name: 'Issue' });
      await expect(issue).toBeVisible();
      await issue.selectOption({ index: 1 });
      await expect(page.getByText('More filters (1 set)')).toBeVisible();
      const status = page.locator('.filters-status');
      await expect(status, `result count on ${hash}`).toContainText(/match these filters/);
      await expect(status, `result count on ${hash}`).toBeInViewport();
    }
  });

  test('fields are at least 16px, so a phone browser does not zoom into them', async ({ page }) => {
    await open(page, '#/litigation');
    await page.getByText('More filters', { exact: true }).tap();
    const small = await page.evaluate(() => [...document.querySelectorAll('input, select')]
      .filter((el) => (el as HTMLElement).getBoundingClientRect().height > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => el.getAttribute('aria-label') ?? el.id));
    expect(small).toEqual([]);
  });

  test('the main touch targets are at least 44px tall', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const heights = await page.evaluate(() => Object.fromEntries(
      ['.brand', '.back-link', '.source-line-foot a', '.segmented-options label', '.entry-docs a'].map((selector) => [selector, Math.min(...[...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect().height))]),
    ));
    for (const [selector, height] of Object.entries(heights)) expect(height, selector).toBeGreaterThanOrEqual(44);

    // A timeline's "Source" link is one short line of text; its hit area reaches 15px above and below it.
    await open(page, '#/place/state:06?tab=timeline');
    await expect(heading(page)).toHaveText('California');
    const link = page.locator('.timeline-foot a').first();
    const reach = await link.evaluate((a) => {
      a.scrollIntoView({ block: 'center' });
      const box = a.getBoundingClientRect();
      const hits = (y: number) => { const el = document.elementFromPoint(box.left + 8, y); return Boolean(el && a.contains(el)); };
      return { above: hits(box.top - 14), below: hits(box.bottom + 14) };
    });
    expect(reach).toEqual({ above: true, below: true });
  });

  test('the tab bar keeps its height when the home-indicator inset is added', async ({ page, context }) => {
    // Emulate the bottom inset an iPhone with a home indicator reports (Chromium reports none by default).
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 34 } });
    await open(page, '#/');
    await expect(page.locator('.tabbar')).toHaveCSS('padding-bottom', '34px');
    const tabs = page.getByRole('navigation', { name: 'Sections' }).getByRole('link');
    for (const tab of await tabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const tabbar = await page.locator('.tabbar').boundingBox();
    expect(tabbar!.y + tabbar!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  });

  test('at 200% text size the tab bar labels stay apart and the sheet bar keeps one row', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '#/');
    await expect(heading(page)).toBeVisible();
    // Text-only zoom, as a browser's text-size setting applies it.
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect((await sidewaysOverflow(page)).document).toBeLessThanOrEqual(0);
    const labels = await page.locator('.tabbar a').evaluateAll((links) => links.map((a) => ({ fits: a.scrollWidth <= a.clientWidth + 1, box: a.getBoundingClientRect().toJSON() as DOMRect })));
    for (const [i, label] of labels.entries()) {
      expect(label.fits, `tab ${i} label fits its column`).toBe(true);
      expect(label.box.right, `tab ${i} on screen`).toBeLessThanOrEqual(390);
      if (i > 0) expect(label.box.left).toBeGreaterThanOrEqual(labels[i - 1]!.box.right - 0.5);
    }
    // No label is broken inside a word ("Litigat / ion").
    expect(await brokenWords(page, '.tabbar')).toEqual([]);
    // The search box keeps room for its placeholder.
    const fit = await placeholderFit(page);
    expect(fit.need, `placeholder "${fit.text}"`).toBeLessThanOrEqual(fit.room);
    // Each sheet bar button stays one line high: its label folds into the icon instead of wrapping.
    const buttons = await page.locator('.sheet-bar button').evaluateAll((all) => all.map((b) => ({ top: b.getBoundingClientRect().top, height: b.getBoundingClientRect().height, min: parseFloat(getComputedStyle(b).minHeight) })));
    expect(buttons[0]!.top).toBeCloseTo(buttons[1]!.top, 0);
    for (const button of buttons) expect(button.height).toBeLessThanOrEqual(button.min + 1);
    await expect(page.getByRole('button', { name: 'Show more detail' })).toBeVisible();
  });

  test('at 200% text size the reading views stay within the panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoSidewaysOverflow(page, 2);
  });

  test('a place tab raises the sheet and brings its content into view', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    const app = page.locator('.app');
    await expect(app).toHaveAttribute('data-sheet', 'half');
    await page.getByRole('tab', { name: /^Litigation/ }).tap();
    await expect(page).toHaveURL(/tab=litigation/);
    await expect(app).toHaveAttribute('data-sheet', 'full');
    await expect(page.getByRole('tab', { name: /^Litigation/ })).toBeInViewport();
    await expect(page.locator('#place-panel-litigation')).toBeInViewport();

    // A shared link to a tab opens with the sheet raised.
    await open(page, '#/place/state:02?tab=litigation');
    await expect(heading(page)).toHaveText('Alaska');
    await expect(app).toHaveAttribute('data-sheet', 'full');
    await expect(page.locator('#place-panel-litigation')).toBeInViewport();
  });

  test('the export link on a place raises the sheet and focuses the source pack', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    await page.getByRole('link', { name: 'Export source pack' }).tap();
    await expect(page).toHaveURL(/tab=sources/);
    await expect(page.locator('.app')).toHaveAttribute('data-sheet', 'full');
    const packHeading = page.getByRole('heading', { name: 'Legal source pack' });
    await expect(packHeading).toBeFocused();
    await expect(packHeading).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Download JSON' })).toBeInViewport();
  });

  test('the litigation hint does not point at a map the sheet may be covering', async ({ page }) => {
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    const hint = page.locator('main .hint');
    await expect(hint).toContainText('“State” in More filters');
    await expect(hint).not.toContainText('Select a state on the map');
  });
});

test.describe('Small phone, 360 x 640', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('reading views fit the screen', async ({ page }) => {
    await expectNoSidewaysOverflow(page);
  });

  test('the population table keeps its words whole', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' }).getByRole('table')).toBeVisible();
    expect(await brokenWords(page, 'main .table')).toEqual([]);
  });

  for (const hash of ['#/', '#/redistricting', '#/redistricting?shade=population']) {
    test(`the map controls do not cover each other or the map on ${hash}`, async ({ page }) => {
      await open(page, hash, { withMap: true });
      await mapReady(page, hash === '#/' ? 'state' : 'cd120');
      await expectMapControlsApart(page);
      // The half-height sheet leaves the map at least 17.5rem.
      expect((await page.locator('.mapstage').boundingBox())!.height).toBeGreaterThanOrEqual(279);
    });
  }

  test('the population legend starts closed with a key on its summary, and opens with the no-data class first', async ({ page }) => {
    await open(page, '#/redistricting?shade=population', { withMap: true });
    await mapReady(page, 'cd120');
    const legend = page.locator('.legend');
    // Closed, so it covers neither the map nor the other controls (see the test above); the summary shows the colours in use.
    await expect(legend).not.toHaveAttribute('open', '');
    const key = legend.locator('.legend-key');
    await expect(key).toBeVisible();
    expect(await key.locator('.legend-key-ramp .swatch').count()).toBeGreaterThan(1);
    await expect(key.locator('.swatch-hatch')).toHaveCount(1);

    await legend.locator(':scope > summary').tap();
    await expect(legend).toHaveAttribute('open', '');
    await expect(key).toBeHidden();
    const hatch = legend.locator('.legend-hatch');
    await expect(hatch).toContainText('No count shown');
    const [box, frame] = [await hatch.boundingBox(), await legend.boundingBox()];
    expect(box!.y + box!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    // The rest scrolls inside the legend, and the summary that closes it stays at the top.
    const summaryOffset = await legend.evaluate((box) => {
      box.scrollTop = box.scrollHeight;
      return box.querySelector(':scope > summary')!.getBoundingClientRect().top - box.getBoundingClientRect().top;
    });
    expect(summaryOffset).toBeLessThanOrEqual(1);
    await expect(legend.getByText('Boundary vintage and notes')).toBeInViewport();
  });
});

test.describe('Narrow phone, 320 x 568', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('reading views fit the screen, tables included', async ({ page }) => {
    await expectNoSidewaysOverflow(page);
  });

  test('the party map is chosen from a menu, and the block of who governs fits the screen', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await page.getByRole('combobox', { name: 'States coloured by' }).selectOption('party');
    await expect(page).toHaveURL(/shade=party/);
    await mapReady(page, 'state');
    await expectMapControlsApart(page);
    // The closed legend shows the three colours and the hatch of the party map.
    await expect(page.locator('.legend summary .legend-key .swatch')).toHaveCount(4);

    await open(page, '#/place/state:20?shade=party');
    await expect(heading(page)).toHaveText('Kansas');
    await page.getByRole('button', { name: 'Show more detail' }).tap();
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    await expect(block.getByRole('list', { name: 'The offices of Kansas by party' }).getByRole('listitem')).toHaveCount(3);
    expect(await brokenWords(page, '.gov')).toEqual([]);
    const overflow = await sidewaysOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.panel).toBeLessThanOrEqual(0);
  });

  test('the closed legend keeps its key on one line between the zoom buttons and the edge', async ({ page }) => {
    await open(page, '#/redistricting?shade=population', { withMap: true });
    await mapReady(page, 'cd120');
    const key = page.locator('.legend-key');
    await expect(key).toBeVisible();
    const [keyBox, legendBox] = [await key.boundingBox(), await page.locator('.legend').boundingBox()];
    expect(keyBox!.x + keyBox!.width).toBeLessThanOrEqual(legendBox!.x + legendBox!.width);
    await expectMapControlsApart(page);
  });
});

test.describe('Phone held sideways, 844 x 390', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  for (const hash of ['#/', '#/redistricting', '#/redistricting?shade=population']) {
    test(`the map opens with the sheet lowered and its controls apart on ${hash}`, async ({ page }) => {
      await open(page, hash, { withMap: true });
      await mapReady(page, hash === '#/' ? 'state' : 'cd120');
      await expect(page.locator('.app')).toHaveAttribute('data-sheet', 'peek');
      await expectMapControlsApart(page);
      // No half-height step: one press of "Show more detail" opens the full panel.
      await page.getByRole('button', { name: 'Show more detail' }).tap();
      await expect(page.locator('.app')).toHaveAttribute('data-sheet', 'full');
    });
  }
});

/** The width the search placeholder needs, and the room the search box gives it. */
async function placeholderFit(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.search input')!;
    const style = getComputedStyle(input);
    const probe = document.createElement('span');
    probe.textContent = input.placeholder;
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing'] as const) probe.style[property] = style[property];
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' });
    document.body.append(probe);
    const need = probe.getBoundingClientRect().width;
    probe.remove();
    return { text: input.placeholder, need, room: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
}

/** The floating map controls sit inside the map, and none covers another or the map's fitted area. */
async function expectMapControlsApart(page: Page) {
  const boxes = await page.evaluate(() => {
    const map = (window as unknown as { __dhqMap: { getBounds(): { getNorth(): number; getSouth(): number }; project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement } }).__dhqMap;
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
    const canvas = map.getCanvas().getBoundingClientRect();
    // The contiguous states' northern, southern and eastern extremes and southern California, where the controls used to land.
    const points = ([[-123.0, 48.9], [-110.0, 48.9], [-100.0, 48.9], [-97.4, 25.9], [-81.0, 25.2], [-68.5, 46.5], [-117.1, 32.8]] as Array<[number, number]>).map((lngLat) => {
      const p = map.project(lngLat);
      const x = canvas.left + p.x;
      const y = canvas.top + p.y;
      const hit = document.elementFromPoint(x, y);
      return { lngLat, onMap: hit === map.getCanvas() };
    });
    return { stage: box('.mapstage'), controls: { layer: box('.layer-control'), zoom: box('.map-zoom'), jump: box('.map-insets'), legend: box('.legend') }, points };
  });
  const entries = Object.entries(boxes.controls);
  for (const [name, b] of entries) {
    expect(b.top, `${name} top`).toBeGreaterThanOrEqual(boxes.stage.top);
    expect(b.bottom, `${name} bottom`).toBeLessThanOrEqual(boxes.stage.bottom);
  }
  for (const [i, [a, ab]] of entries.entries()) {
    for (const [b, bb] of entries.slice(i + 1)) {
      const overlap = ab.left < bb.right && bb.left < ab.right && ab.top < bb.bottom && bb.top < ab.bottom;
      expect(overlap, `${a} overlaps ${b}`).toBe(false);
    }
  }
  expect(boxes.points.filter((p) => !p.onMap).map((p) => p.lngLat), 'points of the fitted map under a control').toEqual([]);
}
