/**
 * Fixes after the independent check of the final review round (group UX): the very short screen layout (Back and
 * Forward, the map and the mouse wheel, the section links, the focused heading), change marks for assistive technology,
 * and the overview footer's link targets.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, heading, mapReady, open, test } from './fixtures';

/** A 1366 x 768 laptop screen at 400% zoom. */
const TINY = { width: 342, height: 164 };

const pageTop = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** Whether the focused element is at least partly on screen. */
const focusOnScreen = (page: Page) => page.evaluate(() => {
  const box = document.activeElement!.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight;
});

test.describe('Back and Forward on a very short screen (DB5)', () => {
  test('Forward returns to the record as it was left, and Back to the list as it was left', async ({ page }) => {
    await page.setViewportSize(TINY);
    await open(page, '#/laws');
    const link = page.locator('main .rows li .row-title').nth(20);
    await link.scrollIntoViewIfNeeded();
    const listTop = await pageTop(page);
    expect(listTop).toBeGreaterThan(1000);
    const href = await link.getAttribute('href');
    await link.click();
    await expect(heading(page)).toBeFocused();
    expect(await focusOnScreen(page)).toBe(true);
    const recordTop = await pageTop(page);
    expect(recordTop).toBeLessThan(listTop);

    await page.goBack();
    await expect.poll(() => pageTop(page)).toBe(listTop);
    await expect(page.locator(`main a[href="${href}"]`).first()).toBeFocused();
    expect(await focusOnScreen(page)).toBe(true);

    await page.goForward();
    await expect(heading(page)).toBeFocused();
    await expect.poll(() => pageTop(page)).toBe(recordTop);
    expect(await focusOnScreen(page)).toBe(true);

    await page.goBack();
    await expect.poll(() => pageTop(page)).toBe(listTop);
    await expect(page.locator(`main a[href="${href}"]`).first()).toBeFocused();
  });

  test('Forward to a view left at its top puts the page at the top', async ({ page }) => {
    await page.setViewportSize(TINY);
    await open(page, '#/about');
    await expect(heading(page)).toBeVisible();
    const link = page.locator('main a[href$="#/sources"]').last();
    await link.scrollIntoViewIfNeeded();
    const aboutTop = await pageTop(page);
    expect(aboutTop).toBeGreaterThan(500);
    await link.click();
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await expect(heading(page)).toBeFocused();
    const sourcesTop = await pageTop(page);
    await page.goBack();
    await expect.poll(() => pageTop(page)).toBe(aboutTop);
    await page.goForward();
    await expect(heading(page)).toHaveText('Data sources and methodology');
    await expect.poll(() => pageTop(page)).toBe(sourcesTop);
    expect(await focusOnScreen(page)).toBe(true);
  });
});

test.describe('The very short screen layout (DB2)', () => {
  test('the section links follow the top bar, before the content', async ({ page }) => {
    await page.setViewportSize(TINY);
    await open(page, '#/laws');
    await expect(heading(page)).toBeVisible();
    const order = await page.evaluate(() => {
      const top = document.querySelector('.topnav')!.getBoundingClientRect();
      const tabs = document.querySelector('.tabbar')!;
      const main = document.querySelector('main')!;
      return {
        gap: Math.round(tabs.getBoundingClientRect().top - top.bottom),
        tabsBeforeMain: Boolean(tabs.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING),
        position: getComputedStyle(tabs).position,
      };
    });
    expect(order).toEqual({ gap: 0, tabsBeforeMain: true, position: 'static' });
    // At the usual phone size the tab bar stays at the foot of the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('.tabbar')!.getBoundingClientRect().bottom))).toBe(844);
  });

  test('the mouse wheel over the map scrolls the page there, and still zooms the map on a regular screen', async ({ page }) => {
    for (const size of [TINY, { width: 1366, height: 768 }]) {
      await page.setViewportSize(size);
      await open(page, '#/place/state:22', { withMap: true });
      await mapReady(page, 'state');
      await page.waitForTimeout(800);
      const box = (await page.locator('.mapstage').boundingBox())!;
      const y = Math.min(box.y + box.height / 2, size.height - 10);
      const zoom = () => page.evaluate(() => (window as unknown as { __dhqMap: { getZoom(): number } }).__dhqMap.getZoom());
      const before = await zoom();
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(700);
      if (size === TINY) {
        expect(await pageTop(page)).toBeGreaterThan(0);
        expect(await zoom()).toBeCloseTo(before, 5);
      } else {
        expect(await pageTop(page)).toBe(0);
        expect(await zoom()).toBeLessThan(before);
      }
    }
  });
});

test.describe('Change marks read by assistive technology (DB3)', () => {
  test('a removal and the addition after it are announced apart, and the page text stays exact', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab789/compare?from=20250AB78998AMD&to=20250AB78997AMD');
    const row = page.locator('.blk-chg', { hasText: '1385' }).first();
    await expect(row).toBeVisible();
    const tree = await row.ariaSnapshot();
    expect(tree).toContain('deletion: "[start of removed text] 1385 [end of removed text]"');
    expect(tree).toContain('insertion: "[start of added text] 89517 [end of added text]"');
    expect(await row.textContent()).toBe('Section 138589517.015 of the Health and SafetyGovernment Code is amended to read:');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
  });
});

test.describe('The overview footer (WCAG 2.2, 2.5.8)', () => {
  test('its links are targets of at least 24 px on narrow and very short screens', async ({ page }) => {
    for (const size of [{ width: 342, height: 700 }, { width: 320, height: 568 }, TINY]) {
      await page.setViewportSize(size);
      await open(page, '#/');
      await expect(heading(page)).toBeVisible();
      const footer = page.locator('main footer.view-foot');
      await footer.scrollIntoViewIfNeeded();
      const heights = await footer.locator('a').evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height));
      expect(heights.length).toBeGreaterThan(0);
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(24);
      // Only the footer: elsewhere a target that the scroll position has put partly under a bar would be reported too.
      const results = await new AxeBuilder({ page }).include('main footer.view-foot').withRules(['target-size']).analyze();
      expect(results.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))), `${size.width} x ${size.height}`).toEqual([]);
    }
  });
});
