/**
 * What a record is about: every row of a list quotes an official text, names which text it is, and shows why the
 * record is listed. The page of the record repeats the quotation with a link to the text and to the published rule.
 */
import { axeViolations, BILL, CASE, expect, heading, open, test } from './fixtures';

const POLELLE = { id: 'ca11-22-14031', docket: '22-14031' }; // decided by the Eleventh Circuit on 11 March 2025
const SAVE_ACT = 'us-119-hr22';
/** A measure whose official title says nothing about elections: a House amendment gave it the SAVE Act's text. */
const RETITLED = { id: 'us-119-s1383', label: 'S. 1383' };
/** Listed for a short title; its summary happens to use the words the rule matched in that title. */
const SUMMARY_USES_WORDS = { id: 'us-119-hr8130', label: 'H.R. 8130' };
/** The first paragraph of this opinion is a citation the rule does not quote, so the second is quoted and says so. */
const SECOND_PARAGRAPH = { id: 'ca5-25-50246', docket: '25-50246' };

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

  test('a summary that uses the matched words does not stand in for the title the rule matched', async ({ page }) => {
    // The selection rule reads titles. The summary of H.R. 8130 speaks of voter registration too, but the rule never
    // read it: the row still names the title, and nothing is marked in the summary.
    await open(page, '#/laws?jur=us&q=Filer+Voter+Act');
    const row = rows(page).filter({ has: page.locator('.bill-id', { hasText: SUMMARY_USES_WORDS.label }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-why')).toContainText('Also titled');
    await expect(row.locator('.row-why q')).toHaveText('Tax Filer Voter Registration Act');
    await expect(row.locator('.row-why mark.hit')).toHaveText('Voter Registration');
    await expect(row.locator('.row-about-src')).toHaveText('Congressional Research Service summary');
    await expect(row.locator('.row-about q')).toContainText('voter registration agencies');
    await expect(row.locator('.row-about mark')).toHaveCount(0);
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
    // The passage is the first paragraph of the opinion: it begins where the court begins.
    await expect(row.locator('.row-about-src')).toHaveText('Opening of the opinion of Mar 11, 2025');
    await expect(row.locator('.row-about q')).toHaveText(/^Michael J\. Polelle is a voter in Sarasota County, Florida, who has not registered with a political party\./);
    // The phrases the selection rule counted in the opinion are marked where the passage has them.
    await expect(row.locator('.row-about q mark.hit', { hasText: 'primary elections' })).toHaveCount(1);
    // Why the case is listed: the words of the rule, counted in the opinion.
    await expect(row.locator('.row-why')).toContainText(/In the opinion: “primary elections” \d+×/);
    // The quotation stands above the line with the latest ruling.
    const order = await row.evaluate((li) => [...li.children].map((child) => child.className.split(' ')[0]));
    expect(order.indexOf('row-about')).toBeGreaterThan(order.indexOf('row-meta'));
    expect(order.indexOf('row-about')).toBeLessThan(order.indexOf('row-line'));
  });

  test('where the first paragraph of an opinion cannot be quoted, the row says which paragraph it quotes', async ({ page }) => {
    await open(page, `#/litigation?q=${SECOND_PARAGRAPH.docket}`);
    const row = rows(page).filter({ has: page.locator(`a[href$="#/litigation/${SECOND_PARAGRAPH.id}"]`) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-about-src')).toHaveText(/^Paragraph 2 of the opinion of /);
    await expect(row.locator('.row-about q')).toContainText('the Texas Legislature enacted the Election Protection and Integrity Act of 2021');
  });

  test('a Supreme Court docket shows the question presented, and the words of a quotation can be searched', async ({ page }) => {
    await open(page, '#/litigation');
    await page.getByRole('searchbox', { name: 'Search case name, docket number or quoted passage' }).fill('race predominated in the Legislature');
    const row = rows(page).filter({ has: page.getByRole('link', { name: CASE.name }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.row-about-src').first()).toHaveText('Question presented (first of 4)');
    await expect(row.locator('.row-about q').first()).toHaveText('Did the majority err in finding that race predominated in the Legislature\'s enactment of S.B. 8?');
    // The question the Court itself put to the parties when it set the case for reargument follows, as the Court set it.
    const later = row.locator('.row-about-later');
    await expect(later.locator('.row-about-src')).toHaveText('Further question from the Court, order of Aug 1, 2025');
    await expect(later.locator('q')).toHaveText(/^WHETHER THE STATE’S INTENTIONAL CREATION OF A SECOND MAJORITY-MINORITY CONGRESSIONAL DISTRICT VIOLATES/);
    // It can be searched like the question presented.
    await page.getByRole('searchbox', { name: 'Search case name, docket number or quoted passage' }).fill('intentional creation of a second majority-minority');
    await expect(rows(page).filter({ has: page.getByRole('link', { name: CASE.name }) })).toHaveCount(1);

    await open(page, '#/laws?jur=us');
    await page.getByRole('searchbox', { name: 'Search measure number, title or summary' }).fill('documentary proof of U.S. citizenship');
    await expect(rows(page).filter({ has: page.locator(`a[href$="#/laws/${SAVE_ACT}"]`) })).toHaveCount(1);
  });

  test('the page of a case repeats the quotation with its source and the rule that chose it', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const block = page.locator('figure.about-block');
    await expect(block.locator('figcaption')).toHaveText('Question presented (first of 4)');
    await expect(block.locator('blockquote').first()).toContainText('Did the majority err in finding that race predominated');
    await expect(block.locator('.about-later-src')).toHaveText('Further question from the Court, order of Aug 1, 2025');
    await expect(block.locator('blockquote').nth(1)).toContainText('FOURTEENTH OR FIFTEENTH AMENDMENTS');
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
