import { brokenWords, CASE, expect, heading, open, test } from './fixtures';

/** Desktop and tablet layout: the app frame, the reading panel and type. */
test.describe('App frame', () => {
  const views: Array<[string, string | RegExp]> = [
    ['#/', /^Election law, state by state/],
    [`#/litigation/${CASE.id}`, CASE.name],
    ['#/sources', 'Data sources and methodology'],
  ];
  for (const viewport of [{ width: 1366, height: 768 }, { width: 820, height: 1180 }]) {
    for (const [hash, title] of views) {
      test(`the document is exactly the viewport on ${hash} at ${viewport.width} px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await open(page, hash);
        await expect(heading(page)).toHaveText(title);
        await page.waitForLoadState('networkidle');
        // Hidden text inside the scrolling panel used to make the document taller than the app, so one wheel turn
        // over the navigation bar scrolled the whole frame away and left a blank strip.
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight }));
        expect(size.scroll).toBe(size.inner);
        await page.mouse.move(viewport.width / 2, 20);
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
      });
    }
  }
});

test.describe('Reading panel', () => {
  test('tables keep their words whole', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(page.getByRole('region', { name: 'Issue tags' }).getByRole('table')).toBeVisible();
    expect(await brokenWords(page, 'main .table')).toEqual([]);
  });

  test('segmented controls are only as wide as their options', async ({ page }) => {
    await open(page, '#/redistricting');
    await expect(heading(page)).toHaveText('Districts and boundaries');
    const gaps = await page.locator('main .segmented-options').evaluateAll((groups) => groups.map((group) => {
      const right = Math.max(...[...group.querySelectorAll('label')].map((label) => label.getBoundingClientRect().right));
      return group.getBoundingClientRect().right - right;
    }));
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(2);
  });

  test('headlines use sizes on the type scale, and the home headline is the sans', async ({ page }) => {
    const scale = [12, 14, 15, 16, 19, 24, 32, 42];
    const styleOf = () => heading(page).evaluate((el) => ({ family: getComputedStyle(el).fontFamily, size: parseFloat(getComputedStyle(el).fontSize) }));
    await open(page, '#/');
    await expect(heading(page)).toHaveText('Election law, state by state, from the record');
    const home = await styleOf();
    expect(home.family).toMatch(/^"?Archivo/);
    expect(scale).toContain(home.size);
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    expect(scale).toContain((await styleOf()).size);
  });
});

test.describe('Very wide screen', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('the reading panel grows toward the reading measure', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const width = (await page.locator('.panel').boundingBox())!.width;
    expect(width).toBeGreaterThan(600);
    expect(width).toBeLessThanOrEqual(42 * 16 + 1);
    expect(await brokenWords(page, 'main .table')).toEqual([]);
  });
});
