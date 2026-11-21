/**
 * Navigation, layout, accessibility, version comparison, search and security headers (final review round, group UX).
 */
import type { Page } from '@playwright/test';
import { axeViolations, CASE, clickMap, expect, heading, mapReady, open, test } from './fixtures';

/** Tab through the page and return the focus stops that are entirely hidden (off screen, or covered at every sampled point). */
async function hiddenFocusStops(page: Page, presses: number): Promise<string[]> {
  const hidden: string[] = [];
  await page.locator('body').focus();
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const box = element.getBoundingClientRect();
      const name = `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40)}"`;
      const left = Math.max(0, box.left);
      const top = Math.max(0, box.top);
      const right = Math.min(window.innerWidth, box.right);
      const bottom = Math.min(window.innerHeight, box.bottom);
      if (right <= left || bottom <= top) return { name, hidden: true };
      for (let fx = 0.1; fx < 1; fx += 0.2) {
        for (let fy = 0.1; fy < 1; fy += 0.2) {
          const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
          if (hit && (hit === element || element.contains(hit) || hit.contains(element) || hit.closest('label')?.contains(element))) return { name, hidden: false };
        }
      }
      return { name, hidden: true };
    });
    if (stop?.hidden) hidden.push(stop.name);
  }
  return hidden;
}

test.describe('Litigation map and list (DB1)', () => {
  test('selecting a state with no linked case empties the list and names the state in the menu', async ({ page }) => {
    // The Supreme Court's dockets of this dataset name no case of Wyoming; the courts of Wyoming may have some.
    await open(page, '#/litigation?court=scotus', { withMap: true });
    await mapReady(page, 'state');
    await clickMap(page, [-107.5, 43]);
    await expect(page).toHaveURL(/state=56/);
    await expect(page).toHaveURL(/court=scotus/);
    await expect(page.getByText('No case in this dataset matches these filters.')).toBeVisible();
    await expect(page.getByText('A data gap is not evidence of absence.').first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^0 cases of \d+ match these filters/ })).toBeVisible();
    await expect(page.getByLabel('State', { exact: true })).toHaveValue('56');
    await expect(page.getByLabel('State', { exact: true }).locator('option:checked')).toHaveText(/^Wyoming \(\d+\)$/);
  });

  test('a link with a code that is not a state still shows the whole list', async ({ page }) => {
    await open(page, '#/litigation?state=99');
    await expect(page.getByRole('status').filter({ hasText: /cases in this dataset/ })).toBeVisible();
    await expect(page.getByLabel('State', { exact: true })).toHaveValue('');
  });
});

test.describe('Very short screens (DB2, WCAG 2.2 2.4.11)', () => {
  for (const size of [{ width: 342, height: 164 }, { width: 342, height: 192 }, { width: 320, height: 256 }]) {
    test(`no control that takes focus is hidden behind the bars at ${size.width} x ${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      for (const hash of [`#/litigation/${CASE.id}`, '#/']) {
        await open(page, hash);
        await expect(heading(page)).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await hiddenFocusStops(page, 35), `fully hidden focus stops on ${hash}`).toEqual([]);
      }
    });
  }

  test('a normal phone and a laptop keep the fixed app frame', async ({ page }) => {
    for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await open(page, `#/litigation/${CASE.id}`);
      await expect(heading(page)).toHaveText(CASE.name);
      const frame = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight, panel: getComputedStyle(document.querySelector('.panel')!).overflowY }));
      expect(frame.scroll).toBe(frame.inner);
      expect(frame.panel).toBe('auto');
    }
  });
});

test.describe('Back and Forward (DB5)', () => {
  test('going back to a directory returns to the same place, with focus on the link that was followed', async ({ page }) => {
    for (const [hash, nth] of [['#/laws', 60], ['#/litigation', 12]] as const) {
      await open(page, hash);
      const link = page.locator('main .rows li .row-title').nth(nth);
      await link.scrollIntoViewIfNeeded();
      const top = await page.locator('main.panel').evaluate((panel) => panel.scrollTop);
      expect(top).toBeGreaterThan(500);
      const href = await link.getAttribute('href');
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      await expect(heading(page)).toBeFocused();
      await page.goBack();
      await expect.poll(() => page.locator('main.panel').evaluate((panel) => panel.scrollTop)).toBe(top);
      await expect(page.locator(`main a[href="${href}"]`).first()).toBeFocused();
      await page.goForward();
      await expect.poll(() => page.locator('main.panel').evaluate((panel) => panel.scrollTop)).toBe(0);
    }
  });

  test('following a link still opens the next view at its top', async ({ page }) => {
    await open(page, '#/laws');
    const link = page.locator('main .rows li .row-title').nth(40);
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect(heading(page)).toBeFocused();
    expect(await page.locator('main.panel').evaluate((panel) => panel.scrollTop)).toBe(0);
  });
});

test.describe('Controls that remove themselves (DB6)', () => {
  test('showing unchanged paragraphs moves focus to the first one shown', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab604/compare?from=20250AB60498AMD&to=20250AB60496CHP');
    const show = page.getByRole('button', { name: /^Show [\d,]+ unchanged paragraphs?$/ }).first();
    await show.focus();
    await page.keyboard.press('Enter');
    const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, cls: document.activeElement?.className ?? '', inSame: Boolean(document.activeElement?.closest('.diff-same')) }));
    expect(focused.tag).toBe('P');
    expect(focused.cls).toContain('blk');
    expect(focused.inSame).toBe(true);
  });

  test('removing a watchlist item moves focus to the next Remove button, then to the heading', async ({ page }) => {
    await page.addInitScript(() => {
      if (window.localStorage.getItem('dhq.watchlist.v1')) return;
      window.localStorage.setItem('dhq.watchlist.v1', JSON.stringify([
        { type: 'case', id: 'scotus-24-109', label: 'Louisiana v. Callais', addedAt: '2026-11-01T00:00:00.000Z' },
        { type: 'place', id: 'state:22', label: 'Louisiana', addedAt: '2026-11-01T00:00:00.000Z' },
      ]));
    });
    await open(page, '#/watchlist');
    await expect(heading(page)).toHaveText('Your watchlist');
    await page.getByRole('button', { name: 'Remove Louisiana v. Callais' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove Louisiana', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toBeFocused();
    await expect(page.getByText('Nothing on your watchlist yet.')).toBeVisible();
  });
});

test.describe('Version comparison (DB3, DB9)', () => {
  test('a section number stays whole: the text without additions is the earlier version, without removals the later one', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab789/compare?from=20250AB78998AMD&to=20250AB78997AMD&unchanged=1');
    await expect(page.locator('.diff-summary')).toBeVisible();
    const texts = await page.evaluate(async () => {
      const read = (mark: string) => {
        const copy = document.querySelector('.diff')!.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(mark).forEach((e) => e.remove());
        copy.querySelectorAll('.diff-more').forEach((e) => e.remove());
        return [...copy.querySelectorAll('p.blk')].map((p) => p.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
      };
      const base = document.baseURI;
      const load = async (id: string) => ((await (await fetch(new URL(`data/legislation/text/${id}.json`, base))).json()) as { blocks: Array<[string, string]> }).blocks;
      const [before, after] = await Promise.all([load('20250AB78998AMD'), load('20250AB78997AMD')]);
      const join = (blocks: Array<[string, string]>) => blocks.map((b) => b[1]).join(' ').replace(/\s+/g, ' ').trim();
      return { earlier: read('ins'), later: read('del'), before: join(before), after: join(after), more: Boolean(document.querySelector('.diff-more')) };
    });
    if (!texts.more) {
      expect(texts.earlier).toBe(texts.before);
      expect(texts.later).toBe(texts.after);
    } else {
      expect(texts.before.startsWith(texts.earlier.slice(0, 2000))).toBe(true);
    }
    expect(texts.earlier).toContain('Section 1385.01');
    expect(texts.earlier).not.toContain('Section 1385 .01');
  });

  test('versions chosen in reverse order are flagged, and one press puts them in order', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab604/compare?from=20250AB60496CHP&to=20250AB60499INT');
    const notice = page.getByRole('note').filter({ hasText: 'These versions are in reverse order.' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Swap the two versions' }).click();
    await expect(page).toHaveURL(/from=20250AB60499INT/);
    await expect(page).toHaveURL(/to=20250AB60496CHP/);
    await expect(page.getByText('These versions are in reverse order.')).toHaveCount(0);
    await expect(page.getByLabel('Earlier version')).toBeFocused();
    // In order, no notice.
    await open(page, '#/laws/ca-20252026-ab604/compare?from=20250AB60499INT&to=20250AB60496CHP');
    await expect(page.locator('.diff-summary')).toBeVisible();
    await expect(page.getByText('These versions are in reverse order.')).toHaveCount(0);
  });
});

test.describe('Global search (DB10)', () => {
  test('pasting a long text does not hold up the page', async ({ page }) => {
    await open(page, '#/');
    await expect(heading(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    const words = 'the qualified elector shall present identification documents before receiving provisional ballots'.split(' ');
    const text = Array.from({ length: 1500 }, (_, i) => `${words[i % words.length]}${i % 7 === 0 ? 'x' : ''}`).join(' ');
    const box = page.getByRole('combobox', { name: 'Search places, courts, cases and bills' });
    const longest = await page.evaluate(async () => {
      // The longest stretch the main thread is busy, sampled with animation frames over the next second.
      (window as unknown as { __gap: Promise<number> }).__gap = new Promise((resolve) => {
        let last = performance.now();
        let worst = 0;
        const end = last + 1500;
        const tick = (now: number) => {
          worst = Math.max(worst, now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else resolve(worst);
        };
        requestAnimationFrame(tick);
      });
      return 0;
    });
    expect(longest).toBe(0);
    await box.fill(text);
    const worst = await page.evaluate(() => (window as unknown as { __gap: Promise<number> }).__gap);
    // Before the bound, 1,500 pasted words held the page for several seconds.
    expect(worst).toBeLessThan(500);
    await expect(page.getByText(/Nothing in this dataset matches/)).toBeVisible();
  });
});

test.describe('Titles and the case list (DB12, DL7)', () => {
  test('a source pack’s document title names its subject', async ({ page }) => {
    await open(page, `#/pack/case/${CASE.id}`);
    await expect(heading(page)).toBeVisible();
    await expect(page).toHaveTitle(`Legal source pack: ${CASE.name} (No. ${CASE.docket}) | DemocracyHQ`);
    await open(page, '#/pack/place/state:22');
    await expect(page).toHaveTitle('Legal source pack: Louisiana | DemocracyHQ');
  });

  test('a long ruling in the case list shows its operative words', async ({ page }) => {
    await open(page, '#/litigation?court=scotus');
    const row = page.locator('main .rows li').filter({ has: page.locator('.row-meta', { hasText: 'No. 25A1197,' }) });
    await expect(row.locator('.row-line q')).toContainText('is granted.');
  });
});

test.describe('Disclaimer and About on every view (W9)', () => {
  test('a record page carries the footer, and the desktop top bar links to About', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const footer = page.locator('main footer.site-foot');
    await expect(footer).toContainText('Research and educational tool. Not legal advice and not an official source. A data gap is not evidence of absence.');
    await footer.getByRole('link', { name: 'About and corrections' }).click();
    await expect(heading(page)).toHaveText('About DemocracyHQ');
    await expect(page.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'About', exact: true })).toHaveAttribute('aria-current', 'page');
    for (const hash of ['#/laws/ca-20252026-ab604', '#/sources', '#/watchlist', '#/place/state:22', '#/litigation', '#/laws/ca-20252026-ab604/compare']) {
      await open(page, hash);
      await expect(heading(page)).toBeVisible();
      await expect(page.locator('main footer.site-foot'), hash).toBeVisible();
    }
  });

  test('the footer passes axe and fits a phone screen', async ({ page }) => {
    for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      for (const hash of [`#/litigation/${CASE.id}`, '#/about']) {
        await open(page, hash);
        await expect(heading(page)).toBeVisible();
        const footer = page.locator('main footer.site-foot');
        await footer.scrollIntoViewIfNeeded();
        await expect(footer).toBeVisible();
        const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, foot: document.querySelector('.site-foot')!.getBoundingClientRect().right }));
        expect(fit.scroll).toBeLessThanOrEqual(fit.inner);
        expect(fit.foot).toBeLessThanOrEqual(fit.inner);
        expect(await axeViolations(page), `${hash} at ${size.width} px`).toEqual([]);
      }
    }
  });

  test('the top bar does not overflow at the narrowest desktop width', async ({ page }) => {
    for (const width of [900, 1024, 1150, 1151, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await open(page, '#/');
      await expect(heading(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width} px`).toBe(width);
    }
  });
});

test.describe('Content-Security-Policy (DS6)', () => {
  test('the built page ships a strict policy and a no-referrer policy, and no route breaks it', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    await open(page, '#/');
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe');
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    for (const hash of ['#/', `#/litigation/${CASE.id}`, '#/laws/ca-20252026-ab604', '#/place/state:22', '#/sources', `#/pack/case/${CASE.id}`, '#/redistricting', '#/watchlist', '#/about']) {
      await open(page, `${hash}`);
      await expect(heading(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), hash).toEqual([]);
    }
  });

  test('the map draws under the policy', async ({ page }) => {
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
  });
});

test.describe('Boundary errors (DB8)', () => {
  test('an error for a layer goes once the layer has loaded', async ({ page }) => {
    let fail = true;
    await page.route(/\/geo\/counties\.topo\.json(\?.*)?$/, (route) => (fail ? route.abort('aborted') : route.continue()));
    await open(page, '#/', { withMap: true });
    await mapReady(page, 'state');
    await page.getByRole('radio', { name: 'Counties' }).click();
    await expect(page.locator('.legend-error')).toContainText('These boundaries could not be loaded.');
    fail = false;
    await page.getByRole('radio', { name: 'States' }).click();
    await page.getByRole('radio', { name: 'Counties' }).click();
    await mapReady(page, 'county');
    await expect(page.locator('.legend-error')).toHaveCount(0);
  });
});
