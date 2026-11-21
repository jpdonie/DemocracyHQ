import { BILL, expect, heading, open, test } from './fixtures';

test.describe('Voting law change monitor', () => {
  test('lists the tracked measures and filters them by reported status', async ({ page }) => {
    await open(page, '#/laws');
    await expect(heading(page)).toHaveText('California election legislation');
    const status = page.locator('.filters-status');
    await expect(status).toContainText(/^\d+ measures in this dataset/);
    const total = Number((await status.innerText()).match(/^(\d+)/)![1]);
    expect(total).toBeGreaterThanOrEqual(50);

    await page.getByRole('combobox', { name: 'Status as reported' }).selectOption('Chaptered');
    await expect(page).toHaveURL(/status=Chaptered/);
    await expect(status).toContainText(new RegExp(`^\\d+ measures of ${total} match these filters`));
    const chaptered = Number((await status.innerText()).match(/^(\d+)/)![1]);
    expect(chaptered).toBeGreaterThan(0);
    expect(chaptered).toBeLessThan(total);
    await expect(page.locator('main ul.rows > li')).toHaveCount(chaptered);

    await page.getByRole('searchbox', { name: 'Search bill number or subject' }).fill('AB 604');
    await expect(status).toContainText(/^\d measures? of/);
    await page.locator('main ul.rows > li a.row-title').filter({ has: page.locator('.bill-id', { hasText: /^CA AB 604$/ }) }).click();
    await expect(page).toHaveURL(new RegExp(`#/laws/${BILL.id}$`));
    await expect(heading(page)).toHaveText(BILL.heading);
  });

  test('keeps legislative status, enactment, effective date and the courts apart', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const standing = page.getByRole('region', { name: 'Where this measure stands' });
    for (const name of ['Legislative status', 'Enactment', 'Effective date', 'In the courts']) {
      await expect(standing.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(standing).toContainText('Chaptered (Chapter 96, Statutes of 2025)');
    await expect(standing).toContainText('Approved by the Governor');
    // The effective date is not shown bare: the bill text makes a chapter conditional on another measure.
    await expect(standing.locator('.status-condition').filter({ hasText: 'operative only if' })).toBeVisible();
    await expect(standing.locator('.status-condition').getByRole('link', { name: 'CA ACA 8' })).toHaveAttribute('href', '#/laws/ca-20252026-aca8');
    // A court case linked by its own record is listed, with the caveat that the list may be incomplete.
    await expect(standing.locator('a.case-name').first()).toBeVisible();
    await expect(standing).toContainText('Legislative status does not show whether a court has blocked');
  });

  test('shows the official history and links every version to the legislature', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    const versions = page.getByRole('region', { name: 'Text versions' });
    await expect(versions.getByRole('row')).toHaveCount(5); // header + four versions
    const official = versions.locator('a[href^="https://leginfo.legislature.ca.gov/"]');
    await expect(official).toHaveCount(4);
    // The word count and the text beside it must not run together.
    const gaps = await versions.locator('tbody tr').evaluateAll((rows) => rows.map((row) => {
      const [, , words, change] = [...row.querySelectorAll('td')];
      if (!words || !change) return -1;
      const range = document.createRange();
      range.selectNodeContents(words);
      const number = range.getBoundingClientRect();
      range.selectNodeContents(change);
      return Math.round(range.getBoundingClientRect().left - number.right);
    }));
    for (const gap of gaps) expect(gap, 'space between the word count and the next column').toBeGreaterThanOrEqual(8);

    const history = page.getByRole('region', { name: 'Legislative history' });
    const key = await history.locator('ol.entries > li').count();
    expect(key).toBeGreaterThan(2);
    await history.getByRole('radio', { name: /^All actions/ }).click();
    await expect(page).toHaveURL(/history=all/);
    expect(await history.locator('ol.entries > li').count()).toBeGreaterThan(key);
    await expect(history).toContainText('Chaptered by Secretary of State');
    // Switching back and forth must show exactly the rows the label counts, the same rows each time.
    const rows = history.locator('ol.entries > li');
    const allRows = await rows.allInnerTexts();
    const seen: Record<string, string[]> = { all: allRows };
    for (const [which, name] of [['key', /^Key actions/], ['all', /^All actions/], ['key', /^Key actions/], ['all', /^All actions/]] as const) {
      const radio = history.getByRole('radio', { name });
      await radio.click();
      const expected = Number((await radio.locator('xpath=..').innerText()).match(/\((\d+)\)/)![1]);
      await expect(rows).toHaveCount(expected);
      const now = await rows.allInnerTexts();
      seen[which] ??= now;
      expect(now, `${which} rows after switching`).toEqual(seen[which]);
    }

    await expect(page.locator('.source-line')).toContainText('Last checked by DemocracyHQ');
  });

  test('compares two real text versions of a bill', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await page.getByRole('link', { name: /^Compare with Introduced/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/laws/${BILL.id}/compare\\?from=${BILL.from}&to=${BILL.to}$`));
    await expect(heading(page)).toHaveText(`Compare text versions: ${BILL.heading}`);

    const summary = page.locator('.diff-summary');
    await expect(summary).toContainText('Introduced (Feb 13, 2025)');
    await expect(summary).toContainText('Amended Senate (Aug 18, 2025)');
    await expect(summary).toContainText(/[\d,]+ paragraphs? added/);
    // Added and removed text is marked up as insertions and deletions, not only by colour.
    expect(await page.locator('.diff ins').count()).toBeGreaterThan(10);
    expect(await page.locator('.diff del').count()).toBeGreaterThan(0);
    // Both versions link to the official text, which controls.
    await expect(page.getByRole('link', { name: 'Introduced (external site)' })).toHaveAttribute('href', new RegExp(`cversion=${BILL.from}$`));
    await expect(page.getByRole('link', { name: 'Amended Senate (external site)' })).toHaveAttribute('href', new RegExp(`cversion=${BILL.to}$`));

    // The choice of versions lives in the address, so a comparison can be shared.
    await page.getByRole('combobox', { name: 'Later version' }).selectOption({ label: 'Chaptered, Aug 21, 2025' });
    await expect(page).toHaveURL(/to=20250AB60496CHP/);
    await expect(summary).toContainText('Chaptered (Aug 21, 2025)');
    await page.getByRole('link', { name: 'Back to the measure' }).click();
    await expect(heading(page)).toHaveText(BILL.heading);
  });

  test('says so when the filters match nothing', async ({ page }) => {
    await open(page, '#/laws?q=zzzzqq');
    await expect(page.getByText('No measure in this dataset matches these filters.')).toBeVisible();
    await expect(page.getByText('A data gap is not evidence of absence.').first()).toBeVisible();
  });
});
