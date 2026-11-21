import { BILL, expect, heading, open, test } from './fixtures';

test.describe('Geographic research workspace', () => {
  test('brings population, cases, legislation, a timeline and sources together for one place', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    const population = page.getByRole('region', { name: 'Population, 2020 Census' });
    await expect(population).toContainText('39,538,223');
    await expect(population.getByRole('table')).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Sections for this place' });
    await tabs.getByRole('tab', { name: /^Litigation/ }).click();
    await expect(page).toHaveURL(/tab=litigation/);
    await expect(page.getByRole('tabpanel')).toContainText('No. 25A839, Supreme Court of the United States');

    await tabs.getByRole('tab', { name: /^Legislation/ }).click();
    await expect(page.getByRole('tabpanel').locator('ul.rows > li').first()).toBeVisible();

    await tabs.getByRole('tab', { name: 'Sources' }).click();
    const sources = page.getByRole('tabpanel');
    await expect(sources).toContainText('U.S. Census Bureau');
    await expect(sources.locator('a[href^="https://www2.census.gov/"]').first()).toBeVisible();
  });

  test('shows every section tab in full, with none cut off or hidden behind a scroll', async ({ page }) => {
    // California has the longest tab labels in the dataset (three- and four-digit counts).
    await open(page, '#/place/state:06');
    const tabs = page.getByRole('tablist', { name: 'Sections for this place' });
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    const box = await tabs.evaluate((list) => {
      const outer = list.getBoundingClientRect();
      return {
        scrolls: list.scrollWidth > list.clientWidth + 1,
        outside: [...list.querySelectorAll('[role="tab"]')]
          .filter((tab) => { const r = tab.getBoundingClientRect(); return r.left < outer.left - 1 || r.right > outer.right + 1; })
          .map((tab) => tab.textContent),
      };
    });
    expect(box.scrolls, 'tab list scrolls sideways').toBe(false);
    expect(box.outside, 'tabs outside the tab list').toEqual([]);
  });

  test('answers "What changed here?" with dated, source-linked events that can be filtered', async ({ page }) => {
    await open(page, '#/place/state:06?tab=timeline');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'What changed here?' })).toBeVisible();
    const status = panel.locator('.filters-status');
    await expect(status).toContainText(/^\d+ events/);
    const all = Number((await status.innerText()).match(/^([\d,]+)/)![1]!.replace(/,/g, ''));
    expect(all).toBeGreaterThan(100);
    await expect(panel.locator('time').first()).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Source (external site)' }).first()).toHaveAttribute('href', /^https:\/\//);

    await panel.getByRole('checkbox', { name: 'Legislature' }).uncheck();
    await expect(status).toContainText(new RegExp(`^\\d+ events of ${all}`));
    const rest = Number((await status.innerText()).match(/^(\d+)/)![1]);
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThan(all);
    await expect(page).toHaveURL(/cat=litigation,geography/);
  });

  test('moves between a place, a court case and a bill without losing the thread', async ({ page }) => {
    await open(page, '#/place/state:06?tab=litigation');
    await page.getByRole('tabpanel').getByRole('link', { name: /Tangipa/ }).click();
    await expect(page).toHaveURL(/#\/litigation\/scotus-25a839$/);
    await expect(heading(page)).toContainText('Tangipa');

    // From the case to the measure its own filings name, with the supporting quote on show.
    const links = page.getByRole('region', { name: 'Places and legislation linked to this case' });
    await expect(links.locator('q').first()).toBeVisible();
    await links.getByRole('link', { name: 'CA AB 604' }).click();
    await expect(page).toHaveURL(new RegExp(`#/laws/${BILL.id}$`));
    await expect(heading(page)).toHaveText(BILL.heading);

    // And back from the measure to the case, then on to the place.
    await page.getByRole('region', { name: 'Where this measure stands' }).getByRole('link', { name: /Tangipa/ }).click();
    await expect(page).toHaveURL(/#\/litigation\/scotus-25a839$/);
    await page.getByRole('region', { name: 'Places and legislation linked to this case' }).getByRole('link', { name: 'California', exact: true }).click();
    await expect(page).toHaveURL(/#\/place\/state:06$/);
    await expect(heading(page)).toHaveText('California');

    // The module switch in the header works from anywhere.
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Redistricting' }).click();
    await expect(heading(page)).toHaveText('Districts and boundaries');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Legislation' }).click();
    await expect(heading(page)).toHaveText('Election legislation');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Litigation' }).click();
    await expect(heading(page)).toHaveText('Election litigation');
  });

  test('never borrows counts from a different district plan', async ({ page }) => {
    // California drew new districts for 2026 and the Census Bureau has not published counts for them.
    await open(page, '#/place/cd120:0612');
    await expect(heading(page)).toHaveText('California Congressional District 12');
    const redrawn = page.getByRole('region', { name: 'Population, 2020 Census' });
    await expect(redrawn).toContainText('Unavailable');
    await expect(redrawn).toContainText('describe different areas and are not shown here');
    await expect(redrawn).not.toContainText('758,548');

    // The district with the same number under the earlier plan has its own published count.
    await page.getByRole('link', { name: 'The district with the same number in the 119th Congress' }).click();
    await expect(page).toHaveURL(/#\/place\/cd119:0612$/);
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('758,548');
  });

  test('finds a place, a case and a bill from the search box', async ({ page }) => {
    await open(page, '#/');
    const search = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    await search.fill('los angeles');
    await page.getByRole('option', { name: /Los Angeles County, California/ }).click();
    await expect(page).toHaveURL(/#\/place\/county:06037$/);
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('10,014,009');

    await search.fill('callais');
    await page.getByRole('option', { name: /^Louisiana v\. Phillip Callais/ }).click();
    await expect(page).toHaveURL(/#\/litigation\/scotus-24-109$/);

    await search.fill('AB 604');
    await page.getByRole('option', { name: /AB 604/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`#/laws/${BILL.id}$`));
  });

  test('keeps a watchlist in this browser only', async ({ page }) => {
    await open(page, '#/place/county:06037');
    await page.getByRole('button', { name: 'Add to watchlist' }).click();
    await expect(page.getByRole('button', { name: 'Remove from watchlist' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Watchlist' }).click();
    await expect(heading(page)).toHaveText('Your watchlist');
    await expect(page.getByText('saved only in this browser on this device')).toBeVisible();
    await expect(page.getByRole('link', { name: /Los Angeles County/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: /Los Angeles County/ })).toBeVisible();
    await page.getByRole('button', { name: /^Remove/ }).click();
    await expect(page.getByText('Nothing on your watchlist yet.')).toBeVisible();
  });

  test('copies a link that reopens the same view', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '#/place/state:06?tab=timeline');
    await page.getByRole('button', { name: 'Copy link' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith(baseURL!)).toBe(true);

    // The copied link carries the open tab, not only the place.
    expect(copied).toContain('tab=timeline');
    await page.goto('about:blank');
    await page.goto(copied);
    await expect(heading(page)).toHaveText('California');
    await expect(page.getByRole('tab', { name: /^Timeline/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('explains an unknown place key', async ({ page }) => {
    await open(page, '#/place/zzz:1');
    await expect(heading(page)).toHaveText('Place not found');
    await expect(page.getByRole('link', { name: 'Back to the map' })).toBeVisible();
  });
});
