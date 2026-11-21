import { BILL, CASE, expect, heading, open, SITE_PREFIX, test } from './fixtures';

/**
 * The site is served under a sub-path with no rewrite rules, exactly like a
 * GitHub Pages project site. The shared fixture already fails any test that
 * requests something outside the sub-path; these tests add the cold-load cases.
 */
test.describe('Static hosting under a sub-path', () => {
  test('the test server really is a sub-path host with no fallback', async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    expect((await request.get(`${origin}/`)).status()).toBe(404);
    expect((await request.get(`${origin}/assets/`)).status()).toBe(404);
    expect((await request.get(`${origin}/data/manifest.json`)).status()).toBe(404);
    expect((await request.get(`${origin}${SITE_PREFIX}litigation/${CASE.id}`)).status()).toBe(404);
    expect((await request.get(`${origin}${SITE_PREFIX}`)).status()).toBe(200);
    expect((await request.get(`${origin}${SITE_PREFIX}data/manifest.json`)).status()).toBe(200);
  });

  test('the page shell uses only relative addresses', async ({ request, baseURL }) => {
    const html = await (await request.get(baseURL!)).text();
    const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(absolute, 'root-relative addresses break under a sub-path').toEqual([]);
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]*)"/g)].map((m) => m[1]);
    expect(external, 'the shell loads nothing from another host').toEqual([]);
  });

  const deepLinks: Array<[string, string | RegExp]> = [
    ['#/', /^Election litigation, voting laws/],
    ['#/litigation', 'Election litigation'],
    [`#/litigation/${CASE.id}`, CASE.name],
    ['#/laws', 'Election legislation'],
    [`#/laws/${BILL.id}`, BILL.heading],
    [`#/laws/${BILL.id}/compare?from=${BILL.from}&to=${BILL.to}`, `Compare text versions: ${BILL.heading}`],
    ['#/redistricting', 'Districts and boundaries'],
    ['#/place/state:06', 'California'],
    ['#/place/county:06037?tab=timeline', 'Los Angeles County, California'],
    ['#/place/cd120:0612', 'California Congressional District 12'],
    ['#/sources', 'Data sources and methodology'],
    ['#/about', 'About DemocracyHQ'],
    ['#/watchlist', 'Your watchlist'],
    [`#/pack/case/${CASE.id}`, new RegExp(CASE.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
  ];
  for (const [hash, title] of deepLinks) {
    test(`opens ${hash} directly`, async ({ page }) => {
      await open(page, hash);
      await expect(heading(page)).toHaveText(title);
      await page.waitForLoadState('networkidle');
    });
  }

  test('shows a not-found page for an address that does not exist', async ({ page }) => {
    await open(page, '#/nope/xyz');
    await expect(heading(page)).toHaveText('Page not found');
    await page.getByRole('link', { name: 'Go to the map' }).click();
    await expect(heading(page)).toHaveText(/^Election litigation, voting laws/);
  });

  test('the browser back button returns to the earlier view', async ({ page }) => {
    await open(page, '#/litigation');
    await page.getByRole('link', { name: CASE.name }).click();
    await expect(heading(page)).toHaveText(CASE.name);
    await page.goBack();
    await expect(heading(page)).toHaveText('Election litigation');
    await page.goForward();
    await expect(heading(page)).toHaveText(CASE.name);
  });
});

test.describe('Data sources and methodology', () => {
  test('lists every source with its freshness, licence and limits', async ({ page }) => {
    await open(page, '#/sources');
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await expect(page.getByText('A data gap is not evidence of absence.').first()).toBeVisible();

    const sources = page.getByRole('region', { name: 'Sources and freshness' });
    await expect(sources).toContainText('Data release generated');
    for (const name of ['U.S. Census Bureau', 'Supreme Court of the United States', 'California']) {
      await expect(sources).toContainText(name);
    }
    await expect(sources.getByText('Last successful check').first()).toBeVisible();
    // The secondary sources say what they are, and what has not been checked.
    await expect(sources).toContainText('CourtListener');
    await expect(sources).toContainText('is a collection, not a court');
    await expect(sources).toContainText('have not been checked against the official bill pages');

    for (const section of ['Coverage and selection', 'Verification states', 'Dates', 'Classification rules', 'Geography', 'Processing', 'Corrections']) {
      await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: section })).toBeVisible();
    }
    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Verification states' }).click();
    await expect(page).toHaveURL(/section=verification/);
    await expect(page.getByRole('heading', { name: 'Verification states' })).toBeInViewport();
  });

  test('states plainly what the site is not', async ({ page }) => {
    await open(page, '#/about');
    await expect(page.getByText('Not legal advice.')).toBeVisible();
    // Exact: the site footer also says the site is "not an official source".
    await expect(page.getByText('Not an official source.', { exact: true })).toBeVisible();
    await expect(page.getByText('Not complete.')).toBeVisible();
  });
});
