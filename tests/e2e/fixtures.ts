/**
 * Shared set-up for the browser tests.
 *
 * These tests run against the real published dataset in public/data, not
 * against synthetic fixtures: they check that the built site works end to end.
 * Assertions therefore name a few long-lived records (a decided Supreme Court
 * case, a chaptered California bill, 2020 Census counts). If one of those is
 * ever removed from the dataset, the matching test should be pointed at another
 * record rather than loosened.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';

export const SITE_PREFIX = '/democracyhq-preview/';

/** Long-lived records the tests open. */
export const CASE = { id: 'scotus-24-109', name: 'Louisiana v. Phillip Callais, et al.', docket: '24-109' };
export const BILL = { id: 'ca-20252026-ab604', heading: 'California AB 604', from: '20250AB60499INT', to: '20250AB60498AMD' };

type Layer = 'state' | 'county' | 'cd119' | 'cd120';

export const test = base.extend<{ problems: string[] }>({
  /**
   * Every test fails if the page logs an error, a request fails, a response is
   * an HTTP error, or anything is requested from outside the site's sub-path
   * (which would break on GitHub Pages, and would mean a third-party request).
   */
  problems: [async ({ page, baseURL }, use) => {
    const problems: string[] = [];
    const origin = new URL(baseURL!).origin;
    page.on('console', (message) => { if (message.type() === 'error') problems.push(`console error: ${message.text()}`); });
    page.on('pageerror', (error) => problems.push(`uncaught error: ${error.message}`));
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? '';
      if (!reason.includes('ERR_ABORTED')) problems.push(`request failed: ${request.url()} ${reason}`);
    });
    page.on('response', (response) => { if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return;
      if (url.origin !== origin || !url.pathname.startsWith(SITE_PREFIX)) problems.push(`request outside the site sub-path: ${request.url()}`);
    });
    await use(problems);
    expect(problems, 'page errors, failed requests, or requests outside the site sub-path').toEqual([]);
  }, { auto: true }],
});

export { expect };

/**
 * Open a route. `withMap` marks tests that use the map object (window.__dhqMap). The browser-test build exposes it on
 * every page (see playwright.config.ts); the ?e2e in the address only labels such runs and switches nothing on.
 */
export async function open(page: Page, hash: string, options: { withMap?: boolean } = {}) {
  await page.goto(`${options.withMap ? '?e2e' : ''}${hash}`);
}

/**
 * Answer one data file with an error or after a delay. Data files are requested with the release in the query
 * (`?v=<contentHash>`), so the pattern matches the file with any query string.
 */
export function dataFile(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/data/${escaped}(\\?.*)?$`);
}

/**
 * Remove the problems a test caused on purpose (an error status it answered for `path`, and the browser's console
 * message about it), so the fixture still fails on anything else.
 */
export function expectOnly(problems: string[], path: string, status: number) {
  // The browser's message ends with the status text, e.g. "(Service Unavailable)" or "(Not Found)", or "()" without one.
  const consoleMessage = new RegExp(`^console error: Failed to load resource: the server responded with a status of ${status} \\([A-Za-z ]*\\)$`);
  const expected = (problem: string) => (problem.startsWith(`HTTP ${status}: `) && dataFile(path).test(problem.slice(`HTTP ${status}: `.length)))
    || consoleMessage.test(problem);
  const rest = problems.filter((problem) => !expected(problem));
  problems.splice(0, problems.length, ...rest);
}

/** Wait until the map has drawn the given boundary layer. */
export async function mapReady(page: Page, layer: Layer) {
  await page.waitForFunction((name) => {
    const map = (window as unknown as { __dhqMap?: { loaded(): boolean; isMoving(): boolean; getLayer(id: string): unknown; queryRenderedFeatures(options: { layers: string[] }): unknown[] } }).__dhqMap;
    return Boolean(map && map.loaded() && !map.isMoving() && map.getLayer(`${name}-fill`) && map.queryRenderedFeatures({ layers: [`${name}-fill`] }).length > 0);
  }, layer, { timeout: 30_000 });
}

/** Click the map at a longitude and latitude with a real pointer event. */
export async function clickMap(page: Page, lngLat: [number, number]) {
  const point = await page.evaluate(([lng, lat]) => {
    const map = (window as unknown as { __dhqMap: { project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement } }).__dhqMap;
    const projected = map.project([lng!, lat!]);
    const box = map.getCanvas().getBoundingClientRect();
    const x = box.left + projected.x;
    const y = box.top + projected.y;
    return { x, y, onCanvas: document.elementFromPoint(x, y) === map.getCanvas() };
  }, lngLat);
  expect(point.onCanvas, 'the clicked point is on the visible map, not under a control or the panel').toBe(true);
  await page.mouse.click(point.x, point.y);
}

/** Run axe with the WCAG 2.2 A and AA rule sets and return the violations in a readable shape. */
export async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(' ')} :: ${node.failureSummary?.split('\n').slice(0, 3).join(' | ')}`),
  }));
}

export const heading = (page: Page) => page.locator('main h1').first();

/**
 * Words that the layout splits across two lines inside the matched elements ("presente / d").
 * Only runs of letters are checked, so a break at a hyphen or a slash is not counted; hashes,
 * identifiers and addresses (.hash, .geoid, .ext, .pack-url) may break anywhere and are skipped.
 */
export async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('.hash, .geoid, .ext, .pack-url, .sr-only')) continue;
        for (const match of (node.textContent ?? '').matchAll(/\p{L}{2,}/gu)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
          if (lines.size > 1) out.push(match[0]);
        }
      }
    }
    return out;
  }, selector);
}

/**
 * Pixels by which the page, or the scrolling panel, is wider than the screen. The page is measured against the
 * emulated screen width, because a phone browser widens its layout viewport to fit content that overflows.
 * `tables` is the most that any table in a sideways scroller (.table-scroll) is wider than its scroller.
 */
export async function sidewaysOverflow(page: Page) {
  const screenWidth = page.viewportSize()!.width;
  return page.evaluate((width) => {
    const panel = document.querySelector<HTMLElement>('.panel');
    return {
      document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth) - width,
      panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
      tables: Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.table-scroll')].map((box) => box.scrollWidth - box.clientWidth)),
    };
  }, screenWidth);
}
