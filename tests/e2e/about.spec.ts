/**
 * What a record is about: every row of a list quotes an official text, names which text it is, and shows why the
 * record is listed. The page of the record repeats the quotation with a link to the text and to the published rule.
 */
import { axeViolations, BILL, CASE, expect, heading, open, test } from './fixtures';

const POLELLE = { id: 'ca11-22-14031', docket: '22-14031' }; // decided by the Eleventh Circuit on 11 March 2025
const SAVE_ACT = 'us-119-hr22';
/** A measure whose official title says nothing about elections: a House amendment gave it the SAVE Act's text. */
const RETITLED = { id: 'us-119-s1383', label: 'S. 1383' };

const rows = (page: import('@playwright/test').Page) => page.locator('main ul.rows > li.row');

test.describe('What a record is about', () => {
  test('a measure listed for a later title shows that title and the official summary', async ({ page }) => {
    await open(page, '#/laws?jur=us&q=Veterans+Advisory+Committee+on+Equal+Access');
    const row = rows(page).filter({ has: page.locator('.bill-id', { hasText: RETITLED.label }) });
    await expect(row).toHaveCount(1);
    // The title the record is listed for is on the row, with the place it was read from.
    const why = row.locator('.row-why');
    await expect(why).toContainText('Also titled');
    await expect(why.locator('q')).toHaveText('Safeguard American Voter Eligibility Act');
    await expect(why.locator('mark.hit')).toHaveText('Voter Eligibility');
    await expect(why).toContainText('Engrossed Amendment House');
    // What the measure does is quoted from the Congressional Research Service, and the row says so.
    const about = row.locator('.row-about');
    await expect(about.locator('.row-about-src')).toHaveText('Congressional Research Service summary');
    await expect(about.locator('q')).toContainText('documentary proof of U.S. citizenship when registering to vote');
    await expect(about.locator('q')).toHaveAttribute('cite', /^https:\/\/www\.congress\.gov\/bill\/119th-congress\/senate-bill\/1383/);
  });

  test('a California bill is described in the words of the Legislative Counsel’s Digest', async ({ page }) => {
    await open(page, '#/laws?jur=ca&q=AB+604');
    const row = rows(page).filter({ has: page.locator(`a[href$="#/laws/${BILL.id}"]`) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-about-src')).toHaveText('Legislative Counsel’s Digest');
    await expect(row.locator('.row-about q')).toContainText(/^This bill would /);
  });

  test('a decision of a court of appeals opens with the court’s own account of the case', async ({ page }) => {
    await open(page, `#/litigation?q=${POLELLE.docket}`);
    const row = rows(page);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-about-src')).toHaveText('Opening of the opinion of Mar 11, 2025');
    await expect(row.locator('.row-about q')).toContainText('Polelle filed suit');
    // Why the case is listed: the words of the rule, counted in the opinion.
    await expect(row.locator('.row-why')).toContainText(/In the opinion: “primary elections” \d+×/);
    // The quotation stands above the line with the latest ruling.
    const order = await row.evaluate((li) => [...li.children].map((child) => child.className.split(' ')[0]));
    expect(order.indexOf('row-about')).toBeGreaterThan(order.indexOf('row-meta'));
    expect(order.indexOf('row-about')).toBeLessThan(order.indexOf('row-line'));
  });

  test('a Supreme Court docket shows the question presented, and the words of a quotation can be searched', async ({ page }) => {
    await open(page, '#/litigation');
    await page.getByRole('searchbox', { name: 'Search case name, docket number or quoted passage' }).fill('race predominated in the Legislature');
    const row = rows(page).filter({ has: page.getByRole('link', { name: CASE.name }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-about-src')).toHaveText('Question presented (first of 4)');
    await expect(row.locator('.row-about q')).toHaveText('Did the majority err in finding that race predominated in the Legislature\'s enactment of S.B. 8?');

    await open(page, '#/laws?jur=us');
    await page.getByRole('searchbox', { name: 'Search measure number, title or summary' }).fill('documentary proof of U.S. citizenship');
    await expect(rows(page).filter({ has: page.locator(`a[href$="#/laws/${SAVE_ACT}"]`) })).toHaveCount(1);
  });

  test('the page of a case repeats the quotation with its source and the rule that chose it', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const block = page.locator('figure.about-block');
    await expect(block.locator('figcaption')).toHaveText('Question presented (first of 4)');
    await expect(block.locator('blockquote')).toContainText('Did the majority err in finding that race predominated');
    await expect(block.getByRole('link', { name: /the Court’s document/ })).toHaveAttribute('href', /^https:\/\/www\.supremecourt\.gov\/qp\//);
    await block.getByRole('link', { name: 'Rule about-question-1' }).click();
    await expect(page).toHaveURL(/#\/sources\?section=rules$/);
    await expect(page.locator('main')).toContainText('about-question-1');
  });

  test('the pages of a decided appeal and of two measures quote the same texts as their rows', async ({ page }) => {
    await open(page, `#/litigation/${POLELLE.id}`);
    const opinion = page.locator('figure.about-block');
    await expect(opinion.locator('figcaption')).toHaveText('Opening of the opinion of Mar 11, 2025');
    await expect(opinion.getByRole('link', { name: /the opinion on GovInfo/ })).toHaveAttribute('href', /^https:\/\/www\.govinfo\.gov\//);
    await expect(opinion).toContainText('Rule about-opinion-1');

    await open(page, `#/laws/${SAVE_ACT}`);
    const summary = page.locator('figure.about-block');
    await expect(summary.locator('figcaption')).toHaveText('Congressional Research Service summary');
    await expect(summary.locator('blockquote')).toContainText('documentary proof of U.S. citizenship');
    await expect(summary.getByRole('link', { name: /Congress\.gov/ })).toHaveAttribute('href', /^https:\/\/www\.congress\.gov\//);

    await open(page, `#/laws/${BILL.id}`);
    const digest = page.locator('figure.about-block');
    await expect(digest.locator('figcaption')).toHaveText('Legislative Counsel’s Digest');
    await expect(digest.getByRole('link', { name: /California Legislative Information/ })).toHaveAttribute('href', /^https:\/\/leginfo\.legislature\.ca\.gov\//);
  });

  test('rows with a quotation and marked words pass the accessibility checks', async ({ page }) => {
    await open(page, '#/laws?jur=us&q=Voter+Eligibility');
    await expect(rows(page).first()).toBeVisible();
    await expect(page.locator('main mark.hit').first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await open(page, '#/litigation?q=primary+elections');
    await expect(rows(page).first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
