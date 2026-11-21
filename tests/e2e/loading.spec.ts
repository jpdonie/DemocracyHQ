import { readFile } from 'node:fs/promises';
import type { Page, Route } from '@playwright/test';
import { BILL, CASE, dataFile, expect, expectOnly, heading, open, test } from './fixtures';

/**
 * A file that is still loading, or that failed, is never shown as "nothing exists": these tests delay or fail one
 * data file at a time and check what each view says meanwhile.
 */

const LINKED_CASE = { id: 'scotus-25a839', name: /^David Tangipa, et al\. v\. Gavin Newsom/ };
const unavailable = (route: Route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service unavailable' });
const after = (ms: number) => async (route: Route) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await route.continue();
};
/** Holds a request until the test calls release(), so a check made "while it loads" never races the clock. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return {
    handler: async (route: Route) => { await opened; await route.continue(); },
    release: () => open(),
  };
}

async function download(page: Page, button: string): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  return readFile(await file.path(), 'utf8');
}

test.describe('Focus on a record that is still loading', () => {
  test('opening an uncached case or bill from the keyboard puts focus on its heading once it arrives', async ({ page }) => {
    const caseFile = gate();
    await page.route(dataFile(`litigation/cases/${CASE.id}.json`), caseFile.handler);
    await page.route(dataFile(`legislation/bills/${BILL.id}.json`), after(800));

    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    await page.locator('.rows').getByRole('link', { name: CASE.name, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Loading this case' })).toBeVisible();
    caseFile.release();
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(heading(page)).toBeFocused();

    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Legislation' }).click();
    await expect(heading(page)).toHaveText('California election legislation');
    await page.locator('.rows').getByRole('link', { name: /^CA AB 604\b/ }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText(BILL.heading);
    await expect(heading(page)).toBeFocused();
  });

  test('choosing a bill in the search box puts focus on its heading', async ({ page }) => {
    await open(page, '#/sources');
    await expect(heading(page)).toHaveText('Data sources and methodology');
    const search = page.getByRole('combobox', { name: 'Search places, cases and bills' });
    await search.fill('AB 808');
    await expect(page.getByRole('option').first()).toContainText('AB 808');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('California AB 808');
    await expect(heading(page)).toBeFocused();
  });

  test('focus is not taken back from the search box if the reader moved there while the record loaded', async ({ page }) => {
    const caseFile = gate();
    await page.route(dataFile(`litigation/cases/${CASE.id}.json`), caseFile.handler);
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    await page.locator('.rows').getByRole('link', { name: CASE.name, exact: true }).click();
    // The new view is drawn and waiting for its record when the reader moves to the search box.
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Loading this case' })).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    const search = page.getByRole('combobox', { name: 'Search places, cases and bills' });
    await search.focus();
    caseFile.release();
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(search).toBeFocused();
  });

  test('focus is not taken from the search box if the reader moved there before the new view was even drawn', async ({ page }) => {
    const caseFile = gate();
    await page.route(dataFile(`litigation/cases/${CASE.id}.json`), caseFile.handler);
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(page.locator(`.rows a[href="#/litigation/${CASE.id}"]`)).toBeVisible();
    // The click and the move to the search box in one task: before the address changes and the new view renders.
    await page.evaluate((id) => {
      document.querySelector<HTMLAnchorElement>(`.rows a[href="#/litigation/${id}"]`)!.click();
      document.querySelector<HTMLInputElement>('.topnav input[role="combobox"]')!.focus();
    }, CASE.id);
    caseFile.release();
    await expect(heading(page)).toHaveText(CASE.name);
    await expect(page.getByRole('combobox', { name: 'Search places, cases and bills' })).toBeFocused();
  });

  test('a record that cannot be loaded still has a heading, and focus moves to it', async ({ page, problems }) => {
    const GILL = 'scotus-16-1161';
    await page.route(dataFile(`litigation/cases/${GILL}.json`), unavailable);
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    await page.locator(`.rows a[href="#/litigation/${GILL}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('main').getByRole('alert')).toContainText('Could not load this case.');
    await expect(heading(page)).toHaveText('Court case could not be loaded');
    await expect(heading(page)).toBeFocused();
    expectOnly(problems, `litigation/cases/${GILL}.json`, 503);

    // An address that names no record in this dataset.
    for (const [hash, text, file] of [
      ['#/litigation/scotus-00-0000', 'Court case not found', 'litigation/cases/scotus-00-0000.json'],
      ['#/laws/ca-20252026-zz0', 'Measure not found', 'legislation/bills/ca-20252026-zz0.json'],
      ['#/laws/ca-20252026-zz0/compare', 'Text versions not found', 'legislation/bills/ca-20252026-zz0.json'],
      ['#/pack/case/scotus-00-0000', 'Source pack not found', 'litigation/cases/scotus-00-0000.json'],
    ] as const) {
      await page.evaluate((to) => { window.location.hash = to; }, hash);
      await expect(heading(page)).toHaveText(text);
      await expect(heading(page)).toBeFocused();
      expectOnly(problems, file, 404);
    }
  });
});

test.describe('Links between records while relationships.json is loading or failed', () => {
  test('a failed file is reported on the case page, in its export and print pack, and on the bill page', async ({ page, problems }) => {
    await page.route(dataFile('relationships.json'), unavailable);
    await open(page, `#/litigation/${LINKED_CASE.id}`);
    await expect(heading(page)).toHaveText(LINKED_CASE.name);
    const links = page.getByRole('region', { name: 'Places and legislation linked to this case' });
    await expect(links.getByRole('alert')).toContainText('Could not load the links between records.');
    await expect(links).not.toContainText('No place or bill has been linked');

    const pack = JSON.parse(await download(page, 'Download JSON'));
    expect(pack.notices).toContainEqual(expect.stringContaining('The links between records (relationships.json) could not be loaded'));
    expect(pack.items.filter((item: { section: string }) => item.section === 'link')).toEqual([]);

    await page.getByRole('link', { name: 'Open print summary' }).click();
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await expect(page.locator('.pack-notice').filter({ hasText: 'relationships.json' })).toBeVisible();

    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const courts = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'In the courts' }) });
    await expect(courts.getByRole('alert')).toContainText('Could not load the links to court cases.');
    await expect(courts).not.toContainText('No linked case in this dataset');
    await expect(page.getByRole('region', { name: 'Linked measures and places' }).getByRole('alert')).toBeVisible();

    await open(page, `#/pack/bill/${BILL.id}`);
    await expect(page.locator('.pack-notice').filter({ hasText: 'relationships.json' })).toBeVisible();
    expectOnly(problems, 'relationships.json', 503);
  });

  test('a slow file shows "Loading", never "no link", and the export waits for it', async ({ page }) => {
    const held = gate();
    await page.route(dataFile('relationships.json'), held.handler);
    await open(page, `#/litigation/${LINKED_CASE.id}`);
    await expect(heading(page)).toHaveText(LINKED_CASE.name);
    const links = page.getByRole('region', { name: 'Places and legislation linked to this case' });
    await expect(links.getByRole('status')).toHaveText('Loading the links to places and legislation');
    await expect(links).not.toContainText('No place or bill has been linked');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    await expect(page.locator('.export [role=status]')).toContainText('The source pack is not ready yet.');
    held.release();
    await expect(links.getByRole('link', { name: 'California' })).toBeVisible({ timeout: 15_000 });
    await expect(links).not.toContainText('Loading');
  });

  test('a slow file keeps the bill\'s court cell and the print pack waiting instead of listing no links', async ({ page }) => {
    const first = gate();
    await page.route(dataFile('relationships.json'), first.handler);
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const courts = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'In the courts' }) });
    await expect(courts.getByRole('status')).toHaveText('Loading linked court cases');
    await expect(courts).not.toContainText('No linked case in this dataset');
    first.release();
    await expect(courts.getByRole('link', { name: LINKED_CASE.name })).toBeVisible({ timeout: 15_000 });

    await page.unroute(dataFile('relationships.json'));
    const second = gate();
    await page.route(dataFile('relationships.json'), second.handler);
    await page.reload();
    await open(page, `#/pack/case/${LINKED_CASE.id}`);
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Loading the source pack' })).toBeVisible();
    second.release();
    await expect(page.getByRole('heading', { name: /^Links between records and their support \(\d+\)$/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pack-notice').filter({ hasText: 'relationships.json' })).toHaveCount(0);
  });
});

test.describe('A place waits only for the files each part uses', () => {
  test('with relationships.json failed, the place pack says the links failed, not the case index', async ({ page, problems }) => {
    await page.route(dataFile('relationships.json'), unavailable);
    await open(page, '#/place/state:06?tab=sources');
    await expect(heading(page)).toHaveText('California');
    await page.waitForLoadState('networkidle');
    const pack = JSON.parse(await download(page, 'Download JSON'));
    expect(pack.notices).toContainEqual(expect.stringContaining('The links between records (relationships.json) could not be loaded, so this pack lists no court cases for this place'));
    expect(pack.notices.filter((notice: string) => notice.includes('litigation/index.json'))).toEqual([]);
    expect(pack.items.filter((item: { section: string }) => item.section === 'court_case' || item.section === 'link')).toEqual([]);
    expect(await download(page, 'Download CSV')).toContain('Notice: The links between records (relationships.json) could not be loaded');

    await page.getByRole('link', { name: 'Open print summary' }).click();
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await expect(page.locator('.pack-notice').filter({ hasText: 'relationships.json' })).toBeVisible();
    await expect(page.locator('.pack-notice').filter({ hasText: 'litigation/index.json' })).toHaveCount(0);
    expectOnly(problems, 'relationships.json', 503);
  });

  test('with events.json failed, the cases and bills still show, and the timeline says it failed', async ({ page, problems }) => {
    await page.route(dataFile('events.json'), unavailable);
    await open(page, '#/place/state:06?tab=litigation');
    await expect(heading(page)).toHaveText('California');
    const tabs = page.getByRole('tablist', { name: 'Sections for this place' });
    await expect(tabs.getByRole('tab', { name: /^Litigation \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole('tabpanel').getByRole('link', { name: LINKED_CASE.name })).toBeVisible();
    await expect(page.getByRole('tabpanel')).not.toContainText('Loading');

    await tabs.getByRole('tab', { name: /^Legislation \(\d+\)$/ }).click();
    await expect(page.getByRole('tabpanel').getByRole('link', { name: /^CA [A-Z]+ \d+\b/ }).first()).toBeVisible();

    await tabs.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('Could not load the timeline.');

    await tabs.getByRole('tab', { name: 'Overview' }).click();
    const records = page.getByRole('region', { name: 'Records tied to this place' });
    await expect(records.getByRole('link', { name: /^\d+ court cases?$/ })).toBeVisible();
    await expect(records.getByRole('link', { name: /^\d+ tracked measures?$/ })).toBeVisible();
    await expect(records.getByRole('alert')).toContainText('Could not load the dated events.');

    await tabs.getByRole('tab', { name: 'Sources' }).click();
    const pack = JSON.parse(await download(page, 'Download JSON'));
    expect(pack.notices).toContainEqual(expect.stringContaining('The timeline (events.json) could not be loaded'));
    expect(pack.items.some((item: { section: string }) => item.section === 'court_case')).toBe(true);
    expectOnly(problems, 'events.json', 503);
  });

  test('with the place index failed, the place view and the search say so instead of loading forever', async ({ page, problems }) => {
    await page.route(dataFile('geo/index.json'), unavailable);
    await open(page, '#/place/state:06');
    await expect(page.locator('main').getByRole('alert')).toContainText('Could not load the place index.');
    await expect(heading(page)).toHaveText('Place could not be loaded');
    await expect(page.locator('main')).not.toContainText('Loading this place');

    const search = page.getByRole('combobox', { name: 'Search places, cases and bills' });
    await search.fill('california');
    const results = page.getByRole('listbox', { name: 'Search results' });
    await expect(results).toContainText('The index of places could not be loaded, so it is not searched.');
    await expect(results).not.toContainText('still loading');
    await search.fill('callais');
    await expect(page.getByRole('option').first()).toContainText('Callais');
    expectOnly(problems, 'geo/index.json', 503);
  });
});

test.describe('The list of sources while sources.json is loading or failed', () => {
  test('a failed file is reported on the place, in each export and in the print pack, never shown as no sources', async ({ page, problems }) => {
    await page.route(dataFile('sources.json'), unavailable);
    await open(page, '#/place/state:06?tab=sources');
    await expect(heading(page)).toHaveText('California');
    const used = page.getByRole('region', { name: 'Sources behind this page' });
    await expect(used.getByRole('alert')).toContainText('Could not load the list of sources.');
    await page.waitForLoadState('networkidle');
    const notice = 'The list of sources (sources.json) could not be loaded';
    const placePack = JSON.parse(await download(page, 'Download JSON'));
    expect(placePack.notices).toContainEqual(expect.stringContaining(notice));
    expect(await download(page, 'Download CSV')).toContain(`Notice: ${notice}`);
    await page.getByRole('link', { name: 'Open print summary' }).click();
    const reuse = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sources and reuse terms' }) });
    await expect(reuse).toContainText(notice);

    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await page.waitForLoadState('networkidle');
    const casePack = JSON.parse(await download(page, 'Download JSON'));
    expect(casePack.notices).toContainEqual(expect.stringContaining(notice));
    expect(casePack.sources).toEqual([]);
    await page.getByRole('link', { name: 'Open print summary' }).click();
    await expect(reuse).toContainText(notice);
    await expect(page.locator('.pack-notice').filter({ hasText: 'sources.json' })).toBeVisible();
    expectOnly(problems, 'sources.json', 503);
  });

  test('a slow file keeps the case export waiting instead of listing no sources', async ({ page }) => {
    const held = gate();
    await page.route(dataFile('sources.json'), held.handler);
    const arrived = page.waitForResponse(dataFile('sources.json'));
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    // The links have loaded, so only the list of sources can hold the export back.
    await expect(page.getByRole('region', { name: 'Places and legislation linked to this case' }).getByRole('status')).toHaveCount(0);
    await page.getByRole('button', { name: 'Download JSON' }).click();
    await expect(page.locator('.export [role=status]')).toContainText('The source pack is not ready yet.');
    held.release();
    await arrived;
    await page.waitForLoadState('networkidle');
    const pack = JSON.parse(await download(page, 'Download JSON'));
    expect(pack.sources.length).toBeGreaterThan(0);
    expect(pack.items[0].sourceName).not.toBeNull();
    expect(pack.notices.filter((notice: string) => notice.includes('sources.json'))).toEqual([]);
  });
});

test.describe('Data releases and loading', () => {
  test('every data file except the manifest is requested for the release the manifest names', async ({ page }) => {
    const urls: string[] = [];
    page.on('request', (request) => { if (request.url().includes('/data/')) urls.push(request.url()); });
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    await page.waitForLoadState('networkidle');
    // The map is loaded lazily, so its boundary file can arrive after the page first goes quiet.
    await expect.poll(() => urls.some((u) => /\.topo\.json/.test(u)), { timeout: 20_000 }).toBe(true);
    const manifest = await (await page.request.get('data/manifest.json')).json();
    const release = encodeURIComponent(manifest.contentHash || manifest.generatedAt);
    const [manifests, others] = [urls.filter((u) => /\/data\/manifest\.json/.test(u)), urls.filter((u) => !/\/data\/manifest\.json/.test(u))];
    expect(manifests.length).toBeGreaterThan(0);
    for (const url of manifests) expect(url).toMatch(/\/data\/manifest\.json$/);
    expect(others.some((u) => u.includes(`/data/litigation/cases/${CASE.id}.json`))).toBe(true);
    expect(others.some((u) => /\.topo\.json/.test(u))).toBe(true);
    for (const url of others) expect(url).toMatch(new RegExp(`\\?v=${release}$`));
  });

  test('the map code, the boundary files and the dated events load only once a view that shows them is opened', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname));
    const mapFiles = () => requested.filter((path) => /maplibre|\.topo\.json$|\/data\/events\.json$/.test(path));
    await open(page, '#/sources');
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await page.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Watchlist' }).click();
    await expect(heading(page)).toHaveText('Your watchlist');
    await open(page, `#/pack/case/${CASE.id}`);
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(mapFiles()).toEqual([]);

    await page.getByRole('link', { name: 'DemocracyHQ, overview map' }).click();
    await expect(page.locator('.mapstage canvas')).toBeVisible();
    expect(mapFiles().some((path) => /maplibre/.test(path))).toBe(true);
    await expect.poll(() => mapFiles().some((path) => path.endsWith('/data/geo/states.topo.json'))).toBe(true);
    // The home page lists the latest dated events, so it is the first view here that asks for them.
    await expect(page.getByRole('region', { name: 'Latest dated events' }).getByRole('listitem').first()).toBeVisible();
    expect(mapFiles().some((path) => path.endsWith('/data/events.json'))).toBe(true);
  });

  test('a date in the address that does not exist is not applied as a filter', async ({ page }) => {
    await open(page, '#/litigation?from=2020-02-31&to=2099-13-45');
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(page.locator('.filters-status')).toContainText(/^\d+ dockets in this dataset/);

    await open(page, '#/place/state:06?tab=timeline&from=2026-02-31');
    await expect(heading(page)).toHaveText('California');
    const status = page.getByRole('tabpanel').locator('.filters-status');
    await expect(status).toContainText(/^\d+ events/, { timeout: 20_000 }); // events.json is the largest file
    await expect(status).not.toContainText(' of ');
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('');
  });

  test('a filter value that is not one of the choices is not applied', async ({ page }) => {
    await open(page, '#/litigation?tag=no-such-issue&ruling=made_up');
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(page.locator('.filters-status')).toContainText(/^\d+ dockets in this dataset/);
    await expect(page.getByLabel('Issue', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Latest ruling entry', { exact: true })).toHaveValue('');
  });
});
