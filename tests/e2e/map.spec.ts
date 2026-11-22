import { clickMap, expect, heading, mapReady, open, test } from './fixtures';

test.describe('Map', () => {
  test('draws real state boundaries and opens a state when it is clicked', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await expect(heading(page)).toHaveText('Election law, state by state, from the record');
    await mapReady(page, 'state');

    const drawn = await page.evaluate(() => {
      const map = (window as unknown as { __dhqMap: { queryRenderedFeatures(o: { layers: string[] }): Array<{ properties: { GEOID?: string } }> } }).__dhqMap;
      return [...new Set(map.queryRenderedFeatures({ layers: ['state-fill'] }).map((f) => f.properties.GEOID))].length;
    });
    // The opening view frames the contiguous states: 48 states and the District of Columbia.
    expect(drawn).toBeGreaterThanOrEqual(49);

    await clickMap(page, [-98.3, 38.5]);
    await expect(page).toHaveURL(/#\/place\/state:20$/);
    await expect(heading(page)).toHaveText('Kansas');
    await expect(page.getByText('State (KS). Census GEOID 20.')).toBeVisible();
    // 2020 Census P.L. 94-171 count for Kansas.
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('2,937,880');
  });

  test('switches to counties and opens a county when it is clicked', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    // The control is driven by the address, so click it and then read the state back.
    await page.getByRole('radio', { name: 'Counties' }).click();
    await expect(page).toHaveURL(/layer=county/);
    await expect(page.getByRole('radio', { name: 'Counties' })).toBeChecked();
    await mapReady(page, 'county');

    await clickMap(page, [-116.2, 34.8]);
    await expect(page).toHaveURL(/#\/place\/county:06071$/);
    await expect(heading(page)).toHaveText('San Bernardino County, California');
    await expect(page.getByText('County. Census GEOID 06071.')).toBeVisible();
    await expect(page.getByText(/The outline on the map is from the 2025 Cartographic Boundary File/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('2,181,654');
  });

  test('opens a congressional district and keeps the two district plans apart', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await page.getByRole('radio', { name: 'Districts' }).click();
    await expect(page).toHaveURL(/layer=cd120/);
    await expect(page.getByRole('radio', { name: '2026 elections' })).toBeChecked();
    await mapReady(page, 'cd120');

    // The legend states which plan and which boundary file is on screen.
    await page.getByText('Boundary vintage and notes').click();
    await expect(page.locator('.legend-vintage')).toContainText('2026 TIGER/Line');

    await clickMap(page, [-107.5, 43.0]);
    await expect(page).toHaveURL(/#\/place\/cd120:5600$/);
    await expect(heading(page)).toHaveText('Wyoming Congressional District (at Large)');
    await expect(page.getByText('Congressional district, 120th Congress. Census GEOID 5600.')).toBeVisible();

    // The earlier plan is a separate layer with its own keys and its own boundary file.
    await open(page, '#/?layer=cd119', { withMap: true });
    await expect(page.getByRole('radio', { name: '119th Congress' })).toBeChecked();
    await mapReady(page, 'cd119');
    await page.getByText('Boundary vintage and notes').click();
    await expect(page.locator('.legend-vintage')).toContainText('2025 Cartographic Boundary');
    await clickMap(page, [-107.5, 43.0]);
    await expect(page).toHaveURL(/#\/place\/cd119:5600$/);
    await expect(page.getByText('Congressional district, 119th Congress. Census GEOID 5600.')).toBeVisible();
  });

  test('reaches Alaska through the locator, which the opening view does not show', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await page.getByRole('navigation', { name: 'Jump the map to an area' }).getByRole('button', { name: 'Alaska' }).click();
    await page.waitForFunction(() => {
      const map = (window as unknown as { __dhqMap: { getCenter(): { lng: number }; isMoving(): boolean } }).__dhqMap;
      return !map.isMoving() && map.getCenter().lng < -130;
    });
    await mapReady(page, 'state');
    await clickMap(page, [-150, 64.5]);
    await expect(page).toHaveURL(/#\/place\/state:02$/);
    await expect(heading(page)).toHaveText('Alaska');
    await expect(page.getByRole('region', { name: 'Population, 2020 Census' })).toContainText('733,391');
  });

  test('returns to the national view from a place', async ({ page }) => {
    await open(page, '#/place/state:20', { withMap: true });
    await mapReady(page, 'state');
    const zoomedIn = await page.evaluate(() => (window as unknown as { __dhqMap: { getZoom(): number } }).__dhqMap.getZoom());
    await page.getByRole('link', { name: 'DemocracyHQ, overview map' }).click();
    await expect(heading(page)).toHaveText(/^Election law, state by state/);
    await page.waitForFunction((before) => {
      const map = (window as unknown as { __dhqMap: { getZoom(): number; isMoving(): boolean } }).__dhqMap;
      return !map.isMoving() && map.getZoom() < before - 1;
    }, zoomedIn);
  });

  test('drops the tooltip when the map is moved from the keyboard', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    const texas = await page.evaluate(() => {
      const map = (window as unknown as { __dhqMap: { project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement } }).__dhqMap;
      const point = map.project([-99.0, 31.5]);
      const box = map.getCanvas().getBoundingClientRect();
      return { x: box.left + point.x, y: box.top + point.y };
    });
    await page.mouse.move(texas.x, texas.y);
    const tooltip = page.locator('.map-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Texas');
    // The pointer rests while the map pans under it, so the tooltip would name a state that is no longer there.
    await page.getByRole('region', { name: /^Map of the United States/ }).focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(tooltip).toBeHidden();
  });

  test('marks districts with no published count as unavailable instead of shading them', async ({ page }) => {
    await open(page, '#/redistricting?shade=population', { withMap: true });
    await mapReady(page, 'cd120');
    await expect(page.locator('.legend')).toContainText('Total population, 2020 Census');
    await expect(page.locator('.legend')).toContainText('No count shown for these boundaries yet');
  });
});
