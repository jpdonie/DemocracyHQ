import { dataFile, expect, heading, mapReady, open, test } from './fixtures';

/**
 * Verification wording, the methodology page, case-page documents whose address answered "not found", and the copy on
 * the home, About and place pages. These run on the published release in public/data.
 */

test.describe('Documents the Court’s docket links to an address that answered "not found"', () => {
  test('are shown as text with the dated note and the address, not as a link', async ({ page }) => {
    // The opinion in Gill v. Whitford: the published data marks it unavailable (HTTP 404 when checked).
    await open(page, '#/litigation/scotus-16-1161');
    await expect(heading(page)).toHaveText(/Gill/);
    const address = 'https://www.supremecourt.gov/opinions/17pdf/16-1161_dc8f.pdf';
    const item = page.locator('.entry-docs li').filter({ hasText: address });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Opinion (linked in docket entry): shown without a link.');
    await expect(item).toContainText(/The Court's docket gives this address, which answered 404 \(not found\) when checked on [A-Z][a-z]{2} \d{1,2}, \d{4}\./);
    await expect(item.getByRole('link')).toHaveCount(0);
    await expect(page.locator(`a[href="${address}"]`)).toHaveCount(0);
    // The address can be selected and copied as text.
    await expect(item.locator('.hash')).toHaveText(address);
  });

  test('a document that answers keeps its link', async ({ page }) => {
    await open(page, '#/litigation/scotus-24-109?entries=all');
    await expect(heading(page)).toHaveText('Louisiana v. Phillip Callais, et al.');
    await expect(page.locator('a[href*="25a1197_097c.pdf"]')).toHaveCount(0);
    await expect(page.locator('.entry-docs a.ext').first()).toBeVisible();
  });
});

test.describe('Verification wording', () => {
  test('a record’s badge says what was checked and what was not', async ({ page }) => {
    await open(page, '#/litigation/scotus-24-109');
    const source = page.getByRole('complementary', { name: 'Source and verification' });
    await expect(source).toContainText('Checked against the official source');
    await expect(source).toContainText('Retrieved automatically from the official source and parsed without error');
    await expect(source).toContainText('are not part of it, and no lawyer has reviewed the record.');
    await expect(page.getByText('Verified against primary source')).toHaveCount(0);
    const links = page.getByRole('region', { name: 'Places and legislation linked to this case' });
    await expect(links.locator('.link-foot').first()).toContainText('the check does not test the description');
  });

  test('the methodology page marks unused states and what a correction report does not do', async ({ page }) => {
    await open(page, '#/sources?section=verification');
    await expect(heading(page)).toHaveText('Data sources and methodology');
    const section = page.getByRole('region', { name: 'Verification states' });
    await expect(section).toContainText('Reporting a correction does not change a record’s badge.');
    const meaning = (label: string) => section.locator('.definitions > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
    await expect(meaning('Checked against the official source')).toContainText('parsed without error');
    await expect(meaning('Checked against the official source')).toContainText('Every record in this release carries this state.');
    for (const label of ['Awaiting review', 'Disputed', 'Outdated']) {
      await expect(meaning(label)).toContainText('Defined but not yet used: nothing in DemocracyHQ assigns this state, and no record carries it.');
    }
    await expect(meaning('Imported from secondary source')).toContainText('No record in this release carries this state.');
  });

  test('the methodology page does not promise dates taken from the bill text or routine hand-run checks', async ({ page }) => {
    await open(page, '#/sources?section=dates');
    const dates = page.getByRole('region', { name: 'Dates' });
    await expect(dates).not.toContainText('a date stated in the bill text');
    await expect(dates).toContainText('Effective or operative dates written into the bill text are not extracted, so “Not verified” does not mean the text states no date.');
    const processing = page.getByRole('region', { name: 'Processing' });
    await expect(processing).toContainText('Two hand-run tools, not part of the scheduled run');
    await expect(processing).not.toContainText('are sample-checked by a separate tool');
  });

  test('"Rules on" names whether the Court will hear the case separately from an application', async ({ page }) => {
    // Until the pipeline republishes the rules, the published file still files these rules under "application"; this
    // test answers the file with the new value.
    await page.route(dataFile('classification.json'), async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { docketEntryRules: Array<{ ruleId: string; rulesOn: string | null }> };
      for (const rule of body.docketEntryRules) if (rule.ruleId === 'sc-review-granted' || rule.ruleId === 'sc-jurisdiction-postponed') rule.rulesOn = 'review';
      await route.fulfill({ response, json: body });
    });
    await open(page, '#/sources?section=rules');
    const table = page.getByRole('table').filter({ has: page.getByRole('cell', { name: 'sc-review-granted', exact: true }) });
    const row = (ruleId: string) => table.getByRole('row').filter({ has: page.getByRole('cell', { name: ruleId, exact: true }) });
    await expect(row('sc-review-granted')).toContainText('Whether the Court will hear the case');
    await expect(row('sc-jurisdiction-postponed')).toContainText('Whether the Court will hear the case');
    await expect(row('sc-app-ruling')).toContainText('An application');
    await expect(row('sc-opinion')).toContainText('The case itself');
    const rules = page.getByRole('region', { name: 'Classification rules' });
    await expect(rules).toContainText('an order on whether the Court will hear the case is never chosen');
    await expect(rules).not.toContainText('disposes of the case or of an application');
  });
});

test.describe('Home, About and place pages', () => {
  test('the home page lists the states with curated links alphabetically and says what it lists', async ({ page }) => {
    await open(page, '#/');
    const sentence = page.locator('.view-home p').filter({ hasText: 'States with at least one curated link to a court case or bill in this dataset, in alphabetical order:' });
    await expect(sentence).toBeVisible();
    await expect(page.getByText('States with the most linked records')).toHaveCount(0);
    const names = await sentence.getByRole('link').allTextContents();
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-US')));
    await expect(page.locator('.module-case p')).toContainText('where the docket links them, the questions presented');
  });

  test('the About page states the licence scope as NOTICE does', async ({ page }) => {
    await open(page, '#/about');
    const licence = page.getByRole('region', { name: 'Source code and licence' });
    await expect(licence).toContainText('That licence covers the code, the documentation and the design files written for this project.');
    await expect(licence).not.toContainText('covers the code only');
    await expect(page.getByRole('region', { name: 'What this is not' })).not.toContainText('stated on every page');
  });

  test('a place outside California says its legislation is not tracked, without claims about it', async ({ page }) => {
    await open(page, '#/place/state:36?tab=legislation');
    await expect(heading(page)).toHaveText('New York');
    await expect(page.getByText('Election legislation for New York is not tracked here.')).toBeVisible();
    await expect(page.getByText('has election legislation that is not shown here')).toHaveCount(0);
  });

  test('the place timeline says it holds key entries only', async ({ page }) => {
    await open(page, '#/place/state:06?tab=timeline');
    await expect(page.getByRole('region', { name: 'What changed here?' })).toContainText('Key entries only, newest first');
  });

  test('a Connecticut planning region does not mention the island areas', async ({ page }) => {
    await open(page, '#/place/county:09110');
    const population = page.getByRole('region', { name: 'Population, 2020 Census' });
    await expect(population).toContainText('Connecticut’s planning regions replaced its counties');
    await expect(population).not.toContainText('island areas');
  });

  test('the legend calls the boundary file’s date the server’s date, and the coverage hatch makes no claim about other states', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await expect(page.locator('.legend-vintage')).toContainText('Source file dated');
    await expect(page.locator('.legend-vintage')).toContainText('(the server’s date for the current file)');
    await expect(page.locator('.legend-vintage')).not.toContainText('published');
    await open(page, '#/laws', { withMap: true });
    await mapReady(page, 'state');
    await expect(page.locator('.legend .legend-hatch')).toHaveText('Not covered: election legislation here is not tracked by DemocracyHQ.');
  });
});

test.describe('Copy link when the clipboard is refused', () => {
  test('keeps the address in a read-only field until the next action', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('refused')) }, configurable: true });
    });
    await open(page, '#/litigation/scotus-24-109');
    await expect(heading(page)).toHaveText('Louisiana v. Phillip Callais, et al.');
    await page.getByRole('button', { name: 'Copy link' }).click();
    const field = page.getByRole('textbox', { name: 'Link to this page' });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('readonly', '');
    await expect(field).toHaveValue(/#\/litigation\/scotus-24-109$/);
    await page.waitForTimeout(5_000);
    await expect(field).toBeVisible();
  });
});
