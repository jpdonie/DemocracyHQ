import { CASE, expect, heading, open, test } from './fixtures';

test.describe('Litigation tracker', () => {
  test('lists the tracked dockets and filters them, with the filter kept in the address', async ({ page }) => {
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    const status = page.locator('.filters-status');
    await expect(status).toContainText(/^\d+ dockets in this dataset/);
    const total = Number((await status.innerText()).match(/^(\d+)/)![1]);
    expect(total).toBeGreaterThanOrEqual(20);

    await page.getByRole('combobox', { name: 'Issue' }).selectOption('redistricting');
    await expect(page).toHaveURL(/tag=redistricting/);
    await expect(status).toContainText(new RegExp(`^\\d+ dockets of ${total} match these filters`));
    const filtered = Number((await status.innerText()).match(/^(\d+)/)![1]);
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(total);
    // Every listed case carries the tag that was filtered on.
    const items = page.locator('main ul.rows > li').filter({ has: page.getByRole('link', { name: 'Redistricting', exact: true }) });
    await expect(items).toHaveCount(filtered);

    // The filtered view is a shareable address: loading it cold gives the same list.
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Issue' })).toHaveValue('redistricting');
    await expect(status).toContainText(`${filtered} dockets of ${total} match these filters`);

    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(status).toContainText(`${total} dockets in this dataset`);
  });

  test('searches by docket number and opens the case', async ({ page }) => {
    await open(page, '#/litigation');
    await page.getByRole('searchbox', { name: 'Search case name or docket number' }).fill(CASE.docket);
    await expect(page.locator('.filters-status')).toContainText(/^1 docket of \d+ match/);
    await page.getByRole('link', { name: CASE.name }).click();
    await expect(page).toHaveURL(new RegExp(`#/litigation/${CASE.id}$`));
    await expect(heading(page)).toHaveText(CASE.name);
  });

  test('shows a real docket with source-linked details', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(page.getByText(`No. ${CASE.docket}, Supreme Court of the United States`)).toBeVisible();

    await expect(page.getByRole('region', { name: 'What the docket shows' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Questions presented' })).toBeVisible();

    // Docket entries are dated and link to the Court's own files.
    const entries = page.getByRole('region', { name: 'Docket entries' });
    await expect(entries.locator('time').first()).toBeVisible();
    const filed = entries.locator('a[href^="https://www.supremecourt.gov/"]');
    const keyFilings = await filed.count();
    expect(keyFilings).toBeGreaterThan(0);
    // The full docket, not only the key entries, is one click away.
    await entries.getByRole('radio', { name: /^All entries/ }).click();
    await expect(page).toHaveURL(/entries=all/);
    await expect.poll(() => filed.count()).toBeGreaterThan(keyFilings);

    // The record states its source, when it was checked and how it was verified.
    const source = page.locator('.source-line');
    await expect(source).toContainText('Supreme Court of the United States');
    await expect(source).toContainText('Last checked by DemocracyHQ');
    await expect(source).toContainText('How it was checked');
    await expect(source.getByRole('link', { name: 'Report a correction' })).toBeVisible();
    await expect(page.locator(`a[href*="supremecourt.gov"][href*="${CASE.docket}"]`).first()).toBeVisible();
  });

  test('says so when the filters match nothing, and that a gap is not absence', async ({ page }) => {
    await open(page, '#/litigation?q=zzzzqq');
    await expect(page.locator('.filters-status')).toContainText(/^0 dockets of \d+ match these filters/);
    await expect(page.getByText('No case in this dataset matches these filters.')).toBeVisible();
    await expect(page.getByText('A data gap is not evidence of absence.').first()).toBeVisible();
  });

  test('explains a link to a case that is not in the dataset instead of failing silently', async ({ page, problems }) => {
    await open(page, '#/litigation/scotus-00-0000');
    await expect(page.getByText('Could not load this case.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'All court cases' })).toBeVisible();
    // The missing file is the point of this test; it is the only problem allowed.
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.includes('scotus-00-0000') || p.includes('status of 404'))).toBe(true);
    problems.length = 0;
  });
});
