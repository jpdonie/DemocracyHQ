/**
 * Who governs: the party map of the states, the block on the page of a state and of the country, and the count on
 * the overview. The figures change as seats change hands, so every expectation is read from government.json as the
 * site publishes it; the tests check that the page says what the file says, and nothing more.
 */
import type { Page } from '@playwright/test';
import { clickMap, dataFile, expect, expectOnly, heading, mapReady, open, test } from './fixtures';

interface Chamber { chamber: string; name: string; seats: number | null; lead: 'R' | 'D' | null; parties: Array<{ group: string; name: string; seats: number }> }
interface Record { id: string; name: string; control: 'R' | 'D' | 'divided' | 'undetermined'; executive: { name: string; party: string; group: string } | null; chambers: Chamber[] }

async function published(page: Page): Promise<Record[]> {
  return page.evaluate(async () => (await (await fetch('data/government.json')).json()).governments as Record[]);
}

const seats = (chamber: Chamber, group: string) => chamber.parties.filter((entry) => entry.group === group).reduce((total, entry) => total + entry.seats, 0);
const PARTY = { R: 'Republican', D: 'Democratic' } as const;
const HEADLINE = { R: 'Republican trifecta', D: 'Democratic trifecta', divided: 'Divided government', undetermined: 'Not determined' } as const;

test.describe('Who governs', () => {
  test('the overview counts the fifty states and the seats of Congress as the published file does, and offers the party map', async ({ page }) => {
    await open(page, '#/');
    const states = (await published(page)).filter((record) => record.id.startsWith('state:'));
    expect(states).toHaveLength(50);
    const count = (control: Record['control']) => states.filter((record) => record.control === control).length;
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    const rows = block.getByRole('list', { name: 'Who governs, by party' }).getByRole('listitem');
    await expect(rows.nth(0)).toContainText('State governments');
    await expect(rows.nth(0)).toContainText(`Republican ${count('R')}`);
    await expect(rows.nth(0)).toContainText(`Democratic ${count('D')}`);
    await expect(rows.nth(0)).toContainText(`Divided ${count('divided')}`);
    // Under the states, the two chambers of Congress, each with the seats the file gives.
    const nation = (await published(page)).find((record) => record.id === 'nation:US')!;
    await expect(rows).toHaveCount(1 + nation.chambers.length);
    for (const [index, chamber] of nation.chambers.entries()) {
      await expect(rows.nth(index + 1)).toContainText(`U.S. ${chamber.name}`);
      await expect(rows.nth(index + 1)).toContainText(`Democratic ${seats(chamber, 'D')}`);
      await expect(rows.nth(index + 1)).toContainText(`Republican ${seats(chamber, 'R')}`);
    }
    await expect(block).toContainText('not an election result');
    await expect(block.getByRole('link', { name: 'Congress in detail' })).toHaveAttribute('href', '#/place/nation:US');

    await block.getByRole('link', { name: 'Colour the map by party control' }).click();
    await expect(page).toHaveURL(/#\/\?shade=party$/);
    await expect(page.getByRole('radio', { name: 'Party control' })).toBeChecked();
    await expect(page.locator('.legend')).toContainText('Party control of the state governments');
    await expect(page.locator('.legend')).toContainText('Not determined, or not covered');
    await expect(block.getByRole('link', { name: 'Back to the map of records' })).toBeVisible();
  });

  test('the party map colours each state by its record and keeps the colouring from state to state', async ({ page }) => {
    await open(page, '#/?shade=party', { withMap: true });
    await mapReady(page, 'state');
    const states = (await published(page)).filter((record) => record.id.startsWith('state:'));
    // The fill of the states is a match of GEOIDs to colours: every state held by one party must be in the list of that party's colour.
    const fills = await page.evaluate(() => {
      const map = (window as unknown as { __dhqMap: { getPaintProperty(layer: string, name: string): unknown } }).__dhqMap;
      const style = getComputedStyle(document.documentElement);
      const expression = map.getPaintProperty('state-fill', 'fill-color') as unknown[];
      const byColour: { [colour: string]: string[] } = {};
      for (let i = 2; i + 1 < expression.length; i += 2) byColour[String(expression[i + 1])] = expression[i] as string[];
      return { byColour, red: style.getPropertyValue('--party-r').trim(), blue: style.getPropertyValue('--party-d').trim(), split: style.getPropertyValue('--party-split').trim() };
    });
    const idsOf = (control: Record['control']) => states.filter((record) => record.control === control).map((record) => record.id.slice(6)).sort();
    expect([...(fills.byColour[fills.red] ?? [])].sort()).toEqual(idsOf('R'));
    expect([...(fills.byColour[fills.blue] ?? [])].sort()).toEqual(idsOf('D'));
    expect([...(fills.byColour[fills.split] ?? [])].sort()).toEqual(idsOf('divided'));

    // Kansas, by a click on the map: the page of the state opens and the map stays coloured by party.
    await clickMap(page, [-98.3, 38.5]);
    await expect(page).toHaveURL(/#\/place\/state:20\?shade=party$/);
    await expect(heading(page)).toHaveText('Kansas');
    await expect(page.getByRole('radio', { name: 'Party control' })).toBeChecked();
    await page.getByRole('main').getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(/#\/\?shade=party$/);

    // Back to the records: the colours of the parties leave the map.
    await page.getByRole('radio', { name: 'Records', exact: true }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.legend')).not.toContainText('Party control');
  });

  test('the tooltip of a state names the parts each party holds', async ({ page }) => {
    await open(page, '#/?shade=party', { withMap: true });
    await mapReady(page, 'state');
    const texas = (await published(page)).find((record) => record.id === 'state:48')!;
    const point = await page.evaluate(() => {
      const map = (window as unknown as { __dhqMap: { project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement } }).__dhqMap;
      const projected = map.project([-99.0, 31.5]);
      const box = map.getCanvas().getBoundingClientRect();
      return { x: box.left + projected.x, y: box.top + projected.y };
    });
    await page.mouse.move(point.x, point.y);
    const tooltip = page.locator('.map-tooltip');
    await expect(tooltip).toContainText('Texas');
    if (texas.control === 'R' || texas.control === 'D') await expect(tooltip).toContainText(`${PARTY[texas.control]} governor and legislature`);
    else await expect(tooltip).toContainText(/governor|Not determined/);
  });

  test('the page of a state names the governor and counts each chamber as the file does', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    const record = (await published(page)).find((entry) => entry.id === 'state:06')!;
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    await expect(block).toContainText(HEADLINE[record.control]);
    const parts = block.getByRole('list', { name: 'The offices of California by party' }).getByRole('listitem');
    await expect(parts).toHaveCount(1 + record.chambers.length);
    await expect(parts.nth(0)).toContainText('Governor');
    await expect(parts.nth(0)).toContainText(record.executive!.name);
    for (const [index, chamber] of record.chambers.entries()) {
      const part = parts.nth(index + 1);
      await expect(part).toContainText(chamber.name);
      await expect(part).toContainText(`Democratic ${seats(chamber, 'D')}`);
      await expect(part).toContainText(`Republican ${seats(chamber, 'R')}`);
      await expect(part).toContainText(chamber.lead ? `${PARTY[chamber.lead]} majority` : /No majority|Not worked out|No party labels/);
      if (chamber.seats !== null) await expect(part).toContainText(`${chamber.seats} seats; more than half is ${Math.floor(chamber.seats / 2) + 1}.`);
    }
    // The bars are for the eye: the figures stand beside them as text, and the bars are kept from assistive technology.
    await expect(block.locator('.seatbar').first()).toHaveAttribute('aria-hidden', 'true');

    await block.getByText('Sources, dates and rules').click();
    await expect(block).toContainText('They are not an election result');
    await expect(block.getByRole('link', { name: /Rules party-group-1/ })).toHaveAttribute('href', '#/sources?section=rules');

    // The sources of the block are listed with the other sources of the page.
    await page.getByRole('tab', { name: 'Sources' }).click();
    const list = page.getByRole('region', { name: 'Sources behind this page' });
    await expect(list).toContainText('National Governors Association');
    await expect(list).toContainText('Open States');
  });

  test('the page of the country shows the chambers of Congress and says what is not known of the Presidency', async ({ page }) => {
    await open(page, '#/place/nation:US');
    await expect(heading(page)).toHaveText('United States');
    const nation = (await published(page)).find((entry) => entry.id === 'nation:US')!;
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    await expect(block).toContainText(HEADLINE[nation.control]);
    const parts = block.getByRole('list', { name: 'The offices of United States by party' }).getByRole('listitem');
    await expect(parts.nth(0)).toContainText('President');
    if (!nation.executive) {
      await expect(parts.nth(0)).toContainText('Not determined');
      await expect(block).toContainText('none of the sources read here names the President');
    } else {
      await expect(parts.nth(0)).toContainText(nation.executive.name);
    }
    const [senate, house] = nation.chambers as [Chamber, Chamber];
    await expect(parts.nth(1)).toContainText(`Republican ${seats(senate, 'R')}`);
    await expect(parts.nth(1)).toContainText('100 seats; more than half is 51.');
    await expect(parts.nth(2)).toContainText('House of Representatives');
    await expect(parts.nth(2)).toContainText(`Democratic ${seats(house, 'D')}`);
    await expect(parts.nth(2)).toContainText('435 seats; more than half is 218.');
    await expect(parts.nth(2)).toContainText('The majority is the one the Clerk of the House states in the list.');
  });

  test('a legislature elected without party labels is not coloured, and the page says why', async ({ page }) => {
    await open(page, '#/place/state:31');
    await expect(heading(page)).toHaveText('Nebraska');
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    await expect(block).toContainText('Not determined');
    await expect(block).toContainText('The members of the Nebraska Legislature are elected without party labels.');
    await expect(block).toContainText('No party labels');
    await expect(block).not.toContainText('Republican 0');
  });

  test('the District of Columbia is said not to be covered, and a county has no such block', async ({ page }) => {
    await open(page, '#/place/state:11');
    await expect(heading(page)).toHaveText('District of Columbia');
    await expect(page.getByRole('region', { name: 'Who governs', exact: true })).toContainText('Who holds office is shown for the fifty states only. It is not shown for a federal district.');
    await open(page, '#/place/county:06071');
    await expect(heading(page)).toHaveText('San Bernardino County, California');
    await expect(page.getByRole('region', { name: 'Who governs', exact: true })).toHaveCount(0);
  });

  test('when the file cannot be loaded the block says so and the rest of the page is shown', async ({ page, problems }) => {
    await page.route(dataFile('government.json'), (route) => route.fulfill({ status: 503, body: 'unavailable' }));
    await open(page, '#/place/state:06?shade=party');
    await expect(heading(page)).toHaveText('California');
    const block = page.getByRole('region', { name: 'Who governs', exact: true });
    await expect(block).toContainText('Could not load who holds office.');
    await expect(block).not.toContainText('trifecta');
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('39,538,223');
    await expect(page.locator('.legend')).toContainText('The party figures could not be loaded, so the states are not coloured.');
    expectOnly(problems, 'government.json', 503);
  });
});
