/**
 * The federal level and the courts: the page for the United States, the courts overview, a court of appeals, a case of
 * a court of appeals with a tag a maintainer removed, a measure of Congress, and the two selectors on the map.
 */
import type { Route } from '@playwright/test';
import { axeViolations, dataFile, expect, expectOnly, heading, open, test } from './fixtures';

const POLELLE = 'ca11-22-14031'; // Polelle v. Florida Secretary of State: two tags removed under rule tag-removal-1
const SAVE_ACT = 'us-119-hr22';

test.describe('Federal level', () => {
  test('the United States page gathers Congress, the federal courts and a timeline', async ({ page }) => {
    await open(page, '#/place/nation:US');
    await expect(heading(page)).toHaveText('United States');
    for (const name of ['Congress', 'Federal courts', 'Dated events', 'On the map']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Legislation \(\d+\)$/ })).toBeVisible();
    // No population figure is shown for the country as a whole, and the page says so.
    await expect(page.getByRole('region', { name: 'On the map' })).toContainText('No population figure is shown for the country as a whole.');
    await page.getByRole('tab', { name: /^Legislation/ }).click();
    await expect(page).toHaveURL(/tab=legislation/);
    await expect(page.getByRole('tabpanel').getByRole('link', { name: /H\.R\. 22\b/ }).first()).toBeVisible();
  });

  test('the level selector offers the federal level beside states, counties and districts', async ({ page }) => {
    await open(page, '#/');
    const level = page.getByRole('radiogroup', { name: 'Level' }).or(page.getByRole('group', { name: 'Level' }));
    for (const name of ['Federal', 'States', 'Counties', 'Districts']) await expect(level.getByRole('radio', { name, exact: true })).toBeVisible();
    await expect(level.getByRole('radio', { name: 'States', exact: true })).toBeChecked();
    await level.getByRole('radio', { name: 'Federal', exact: true }).click();
    await expect(page).toHaveURL(/#\/place\/nation:US/);
    await expect(heading(page)).toHaveText('United States');
    await expect(level.getByRole('radio', { name: 'Federal', exact: true })).toBeChecked();
  });

  test('a measure of Congress shows the stage reached, its text versions and why it is listed', async ({ page }) => {
    await open(page, `#/laws/${SAVE_ACT}`);
    await expect(heading(page)).toHaveText('H.R. 22');
    const standing = page.getByRole('region', { name: 'Where this measure stands' });
    await expect(standing).toContainText('Stage reached');
    await expect(standing).toContainText('Passed the House');
    await expect(page.getByRole('region', { name: 'Text versions' })).toContainText('Engrossed in House');
    await expect(page.getByRole('region', { name: 'Why this measure is listed, and its tags' })).toContainText('us-select-1');
    // The old name of the stage claimed more than the record shows.
    await expect(page.getByText(/passed both chambers/i)).toHaveCount(0);
  });

  test('the legislation list filters by legislature, and a stage is offered only within Congress', async ({ page }) => {
    await open(page, '#/laws?jur=us');
    await expect(heading(page)).toHaveText('Election legislation');
    await expect(page.locator('.filters-status')).toContainText(/^\d+ measures of Congress in this dataset/);
    await page.getByRole('combobox', { name: 'Stage reached' }).selectOption('Passed the House');
    await expect(page).toHaveURL(/status=Passed(\+|%20)the(\+|%20)House/);
    await expect(page.locator('main ul.rows > li').first()).toBeVisible();
    await expect(page.locator('main ul.rows .bill-id').first()).toHaveText(/^(H\.|S\.)/);
  });
});

test.describe('Courts', () => {
  test('the overview lists the Supreme Court and the thirteen courts of appeals', async ({ page }) => {
    await open(page, '#/courts');
    await expect(heading(page)).toHaveText('Federal courts');
    const appeals = page.getByRole('region', { name: 'Courts of appeals' });
    for (const name of ['First Circuit', 'Ninth Circuit', 'Eleventh Circuit', 'D.C. Circuit', 'Federal Circuit']) await expect(appeals.getByRole('link', { name, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'How the circuits are drawn' })).toContainText('28 U.S.C. § 41');
  });

  test('the court selector opens the Supreme Court and the circuits', async ({ page }) => {
    await open(page, '#/');
    const courts = page.getByRole('radiogroup', { name: 'Courts' }).or(page.getByRole('group', { name: 'Courts' }));
    await courts.getByRole('radio', { name: 'Circuits', exact: true }).click();
    await expect(page).toHaveURL(/#\/courts/);
    await expect(courts.getByRole('radio', { name: 'Circuits', exact: true })).toBeChecked();
    await courts.getByRole('radio', { name: 'Supreme Court', exact: true }).click();
    await expect(page).toHaveURL(/#\/court\/scotus/);
    await expect(heading(page)).toHaveText('Supreme Court of the United States');
  });

  test('the arrow keys go through all six choices of the map, and focus stays on the control', async ({ page }) => {
    await open(page, '#/');
    const control = page.locator('.layer-control');
    const radio = (name: string) => control.getByRole('radio', { name, exact: true });
    await radio('States').focus();
    // Each choice opens its own view; a reader going through them is not taken out of the control.
    for (const [name, address, title] of [
      ['Counties', /layer=county/, null],
      ['Districts', /layer=cd120/, null],
      ['Supreme Court', /#\/court\/scotus/, 'Supreme Court of the United States'],
      ['Circuits', /#\/courts/, 'Federal courts'],
      ['Federal', /#\/place\/nation:US/, 'United States'],
    ] as const) {
      await page.keyboard.press('ArrowRight');
      await expect(radio(name)).toBeChecked();
      await expect(page).toHaveURL(address);
      if (title) await expect(heading(page)).toHaveText(title);
      await expect(radio(name)).toBeFocused();
    }
  });

  test('an address that names no case marks no court on the map', async ({ page, problems }) => {
    await open(page, '#/litigation/bogus');
    await expect(heading(page)).toHaveText('Court case not found');
    const control = page.locator('.layer-control');
    await expect(control.getByRole('radio', { name: 'Supreme Court', exact: true })).not.toBeChecked();
    await expect(control.getByRole('radio', { name: 'States', exact: true })).toBeChecked();
    expectOnly(problems, 'litigation/cases/bogus.json', 404);
  });

  test('a pairing with a Supreme Court docket that could not be loaded is said, not left out', async ({ page, problems }) => {
    await page.route(dataFile('relationships.json'), (route: Route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service unavailable' }));
    // Paired with Supreme Court docket 24-1260 by rule case-below-1 when the file loads.
    await open(page, '#/litigation/ca5-24-60395');
    await expect(page.locator('main')).toContainText('In the Supreme Court');
    await expect(page.locator('main')).toContainText('Could not be loaded: the file of links between records failed to load');
    await expect(page.locator('main')).not.toContainText('Whether a decision was later reheard, vacated or reviewed is not recorded here.');
    expectOnly(problems, 'relationships.json', 503);
  });

  test('a court of appeals page names its states from the statute and says what was read', async ({ page }) => {
    await open(page, '#/court/ca9');
    await expect(heading(page)).toHaveText('United States Court of Appeals for the Ninth Circuit');
    const circuit = page.getByRole('region', { name: 'The circuit' });
    await expect(circuit).toContainText('Alaska, Arizona, California, Idaho, Montana, Nevada, Oregon, Washington, Guam, Hawaii.');
    await expect(circuit.getByRole('link', { name: 'California', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'What was read for this court' })).toContainText(/Cases with a document issued since Jan 1, 2025\d+/);
    await expect(page.getByRole('heading', { level: 2, name: /^Cases in this dataset \(\d+\)$/ })).toBeVisible();
  });

  test('the Federal Circuit is listed with no case and the reason', async ({ page }) => {
    await open(page, '#/court/cafc');
    await expect(heading(page)).toHaveText('United States Court of Appeals for the Federal Circuit');
    await expect(page.getByRole('heading', { level: 2, name: 'Cases in this dataset (0)' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'No circuit on the map' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'What was read for this court' })).toContainText(/Cases with a document issued since Jan 1, 20251,\d{3}/);
  });

  test('a state names its court of appeals, and a case of that court shows where it began', async ({ page }) => {
    await open(page, '#/place/state:12');
    await expect(heading(page)).toHaveText('Florida');
    await expect(page.getByRole('link', { name: /Eleventh Circuit/ }).first()).toBeVisible();
    await open(page, `#/litigation/${POLELLE}`);
    await expect(heading(page)).toHaveText('Michael Polelle v. Florida Secretary of State, et al');
    await expect(page.getByRole('region', { name: 'What the court’s record shows' })).toContainText('United States District Court for the Middle District of Florida');
    await expect(page.getByRole('region', { name: 'Why this case is listed' })).toContainText('circuit-select-1');
    await expect(page.getByRole('region', { name: /^Documents on GovInfo/ }).getByRole('link').first()).toHaveAttribute('href', /^https:\/\/www\.govinfo\.gov\//);
  });

  test('a tag a maintainer removed is shown with its reason and the passage, not silently dropped', async ({ page }) => {
    await open(page, `#/litigation/${POLELLE}`);
    const tags = page.getByRole('region', { name: 'Issue tags' });
    const removed = tags.locator('.removed-tags');
    await expect(removed.getByRole('heading', { name: 'Removed by a maintainer' })).toBeVisible();
    await expect(removed).toContainText('tag-removal-1');
    await expect(removed.locator('li')).toHaveCount(2);
    await expect(removed).toContainText('Florida’s closed system of primary elections prevents him from participating in any political party’s primary');
    await expect(removed.getByRole('link', { name: /the document/ }).first()).toHaveAttribute('href', /^https:\/\/www\.govinfo\.gov\/content\/pkg\/USCOURTS-ca11-22-14031\//);
  });

  test('the litigation list filters by court', async ({ page }) => {
    await open(page, '#/litigation?court=ca11');
    await expect(page.getByLabel('Court', { exact: true })).toHaveValue('ca11');
    await expect(page.locator('.filters-status')).toContainText(/^\d+ cases? of \d+ match these filters/);
    await open(page, '#/litigation?court=cafc');
    await expect(page.locator('.filters-status')).toContainText(/^0 cases of \d+ match these filters/);
  });
});

test.describe('Accessibility of the federal and court views', () => {
  for (const hash of ['#/place/nation:US', '#/courts', '#/court/ca9', '#/court/cafc', `#/litigation/${POLELLE}`, `#/laws/${SAVE_ACT}`, '#/laws?jur=us']) {
    test(`no violations on ${hash}`, async ({ page }) => {
      await open(page, hash);
      await expect(heading(page)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});
