import { axeViolations, BILL, CASE, expect, heading, open, test } from './fixtures';

/**
 * Automated checks find only part of what WCAG asks for. These tests are a
 * floor, not a conformance claim; see docs/KNOWN_LIMITATIONS.md.
 */
test.describe('Accessibility: automated WCAG 2.2 A and AA rules', () => {
  const views: Array<[string, string | RegExp]> = [
    ['#/', /^Election litigation, voting laws/],
    ['#/litigation', 'Election litigation'],
    [`#/litigation/${CASE.id}`, CASE.name],
    ['#/laws', 'Election legislation'],
    [`#/laws/${BILL.id}`, BILL.heading],
    [`#/laws/${BILL.id}/compare?from=${BILL.from}&to=${BILL.to}`, /^Compare text versions/],
    [`#/laws/${BILL.id}/compare?from=X&to=Y`, /^Read a text version/],
    ['#/redistricting?shade=population', 'Districts and boundaries'],
    ['#/place/state:06', 'California'],
    // The party map and the block of who governs: red and blue, each with its party in words.
    ['#/?shade=party', /^Election litigation, voting laws/],
    ['#/place/state:20?shade=party', 'Kansas'],
    ['#/place/nation:US', 'United States'],
    ['#/place/state:06?tab=timeline', 'California'],
    ['#/place/cd120:0612', 'California Congressional District 12'],
    ['#/sources', 'Data sources and methodology'],
    ['#/about', 'About DemocracyHQ'],
    ['#/watchlist', 'Your watchlist'],
    [`#/pack/bill/${BILL.id}`, /AB 604/],
    [`#/pack/case/${CASE.id}`, /^Louisiana v\. Phillip Callais/],
  ];
  for (const [hash, title] of views) {
    test(`no violations on ${hash}`, async ({ page }) => {
      await open(page, hash);
      await expect(heading(page)).toHaveText(title);
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('a pressed watchlist button keeps its contrast under the mouse', async ({ page }) => {
    await open(page, '#/place/county:06037');
    await page.getByRole('button', { name: 'Add to watchlist' }).click();
    const pressed = page.getByRole('button', { name: 'Remove from watchlist' });
    await pressed.hover();
    // In the title block a pressed button is light with dark text, and stays so under the pointer.
    await expect(pressed).toHaveCSS('color', 'rgb(10, 18, 34)');
    await expect(pressed).toHaveCSS('background-color', 'rgb(214, 222, 238)');
    await page.waitForLoadState('networkidle');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('no violations with the search results open', async ({ page }) => {
    await open(page, '#/');
    await page.getByRole('combobox', { name: 'Search places, courts, cases and bills' }).fill('california');
    await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('no violations with close spellings suggested', async ({ page }) => {
    await open(page, '#/');
    await page.getByRole('combobox', { name: 'Search places, courts, cases and bills' }).fill('louisianna');
    await expect(page.getByText('Did you mean:')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe('Keyboard', () => {
  test('the first stop is a skip link that moves focus into the content', async ({ page }) => {
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    // A fresh load starts at the top of the document.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    const inPanel = await page.evaluate(() => Boolean(document.activeElement?.closest('#panel')));
    expect(inPanel).toBe(true);
  });

  test('the skip link\'s address is the current view, so it also works opened in a new tab or copied', async ({ page, context }) => {
    await open(page, '#/place/state:06?tab=timeline');
    await expect(heading(page)).toHaveText('California');
    const href = await page.getByRole('link', { name: 'Skip to content' }).getAttribute('href');
    expect(href).toBe('#/place/state:06?tab=timeline');
    const other = await context.newPage();
    await other.goto(href!);
    await expect(heading(other)).toHaveText('California');
    await expect(other.getByRole('tab', { name: /^Timeline/ })).toHaveAttribute('aria-selected', 'true');
    await other.close();
  });

  test('moving to a new view puts focus on its heading', async ({ page }) => {
    await open(page, '#/laws');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Litigation' }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(heading(page)).toBeFocused();
  });

  test('place tabs follow the arrow keys', async ({ page }) => {
    await open(page, '#/place/state:06');
    const tabs = page.getByRole('tablist', { name: 'Sections for this place' });
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: /^Litigation/ })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: /^Litigation/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName(/^Litigation/);
    await page.keyboard.press('End');
    await expect(tabs.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('search works from the keyboard alone', async ({ page }) => {
    await open(page, '#/sources');
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await page.keyboard.press('/');
    const search = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    await expect(search).toBeFocused();
    await page.keyboard.type('callais');
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    // The first result is a case named Callais: the Supreme Court's docket or the court of appeals case below it.
    await expect(page).toHaveURL(/#\/litigation\/[a-z0-9-]+$/);
    await expect(heading(page)).toContainText('Callais');

    await search.focus();
    await page.keyboard.type('texas');
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(search).toHaveAttribute('aria-expanded', 'false');
  });

  test('a place can be reached without touching the map', async ({ page }) => {
    await open(page, '#/');
    // Through the list in the panel.
    await page.getByRole('region', { name: 'Start with a place' }).getByRole('link', { name: 'Texas' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/place\/state:48$/);
    await expect(heading(page)).toHaveText('Texas');
    // The map itself is announced with instructions and an alternative.
    await expect(page.getByRole('region', { name: /^Map of the United States\. Use arrow keys to pan/ })).toBeVisible();
  });

  test('every interactive control shows a visible focus ring', async ({ page }) => {
    await open(page, '#/litigation');
    await expect(heading(page)).toHaveText('Election litigation');
    const missing: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const ring = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== 'none';
        return { ring, label: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"` };
      });
      if (info && !info.ring) missing.push(info.label);
    }
    expect(missing).toEqual([]);
  });

  test('respects a reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    const longest = await page.evaluate(() => {
      let max = 0;
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        for (const value of [...style.transitionDuration.split(','), ...style.animationDuration.split(',')]) {
          const seconds = value.trim().endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value);
          if (seconds > max) max = seconds;
        }
      }
      return max;
    });
    expect(longest).toBeLessThanOrEqual(0.01);
  });
});
