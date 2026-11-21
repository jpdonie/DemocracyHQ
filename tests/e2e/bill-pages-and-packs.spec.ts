/**
 * Bill pages, the legislation directory and source packs after the final review (W1, W2/DL1, W6, W22, DL2, DL3/DN4,
 * DL4, DL5, DL14, DB11). These run against the real published dataset.
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { BILL, dataFile, expect, heading, open, test } from './fixtures';

async function downloadJson(page: Page): Promise<{ items: Array<Record<string, string | null>> }> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
  return JSON.parse(await readFile((await file.path())!, 'utf8'));
}

test.describe('Bill page', () => {
  test('a vote taken before a gut-and-amend names the subject the measure had then (DL2)', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const versions = page.getByRole('region', { name: 'Text versions' });
    await expect(versions.getByRole('row').nth(1)).toContainText('Official subject: Voter registration: residency confirmation.');
    await expect(versions.getByRole('row').last()).toContainText('Official subject: Redistricting');

    const history = page.getByRole('region', { name: 'Legislative history' });
    const vote = history.locator('ol.entries > li').filter({ hasText: 'Ayes 75. Noes 1.' });
    await expect(vote).toContainText('Taken when the measure’s subject was: Voter registration: residency confirmation.');
    // The actions dated the day the redistricting text was published are not marked: the record does not say which text they concerned.
    await expect(history.locator('ol.entries > li').filter({ hasText: 'Urgency clause adopted. Passed.' })).not.toContainText('Taken when');
  });

  test('AB 1664 is not shown as voted on another subject: its votes were on the elections text (DL2)', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab1664');
    await expect(heading(page)).toHaveText('California AB 1664');
    const history = page.getByRole('region', { name: 'Legislative history' });
    await expect(history.locator('ol.entries > li').first()).toBeVisible();
    await expect(history).not.toContainText('Taken when');
    // No key action is marked, so the explainer is not shown either.
    await expect(history).not.toContainText('An action taken while the official subject line named a different subject');
    // The full history marks the routine "From printer" action, taken while it was a Vehicles bill, and explains it.
    await open(page, '#/laws/ca-20252026-ab1664?history=all');
    await expect(history.locator('ol.entries > li').filter({ hasText: 'From printer' }).first()).toContainText('Taken when the measure’s subject was:');
    await expect(history).toContainText('An action taken while the official subject line named a different subject');
  });

  test('an expiry clause is quoted beside the effective date, scoped to the provision it names (DL9, C3)', async ({ page }) => {
    // The published release has no expiry clauses until the pipeline is re-run; these records are answered with one.
    const clause = 'This section shall remain in effect only until January 1, 2027, and as of that date is repealed.';
    for (const id of ['ca-20252026-sb280', 'ca-20252026-ab1040']) {
      await page.route(dataFile(`legislation/bills/${id}.json`), async (route) => {
        const response = await route.fetch();
        const body = await response.json() as { versions: Array<{ id: string }>; expiryClauses?: unknown[] };
        body.expiryClauses = [{ text: clause, versionId: body.versions[body.versions.length - 1]!.id, ruleId: 'ca-sunset-1', date: '2027-01-01' }];
        await route.fulfill({ response, json: body });
      });
    }
    const effective = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'Effective date' }) });
    await open(page, '#/laws/ca-20252026-sb280');
    await expect(effective).toContainText('Expiry stated in the text: Jan 1, 2027.');
    await expect(effective).toContainText(`Found by rule ca-sunset-1 in version Chaptered: ${clause}`);
    await expect(effective.locator('q').filter({ hasText: clause })).toHaveCount(1);
    await expect(effective).toContainText('It applies to the provision that sentence names, which may be only part of the measure.');
    // A bill that died repeals nothing: the clause would apply only if it were enacted.
    await open(page, '#/laws/ca-20252026-ab1040');
    await expect(heading(page)).toHaveText('California AB 1040');
    await expect(effective).toContainText(`Found by rule ca-sunset-1 in version Introduced: ${clause}`);
    await expect(effective.locator('q').filter({ hasText: clause })).toHaveCount(1);
    await expect(effective).toContainText('It applies to the provision that sentence names, and would apply only if this measure were enacted.');
  });

  test('"In the courts" shows the Court’s latest ruling entry before the applicants’ request (DL3, DN4)', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    const courts = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'In the courts' }) });
    const tangipa = courts.locator('li').filter({ hasText: '25A839' });
    await expect(tangipa).toContainText('Latest ruling entry on the docket: Feb 4, 2026');
    await expect(tangipa).toContainText('is denied.');
  });

  test('a curated link’s badge has its caveat beside it (W1)', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    const links = page.getByRole('region', { name: 'Linked measures and places' });
    await expect(links.locator('.link-foot').first()).toContainText('the check does not test the description');
  });

  test('a condition decided by the voters says that ballot results are not tracked (DL5)', async ({ page }) => {
    for (const id of [BILL.id, 'ca-20252026-aca8']) {
      await open(page, `#/laws/${id}`);
      const effective = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'Effective date' }) });
      await expect(effective).toContainText('DemocracyHQ does not track ballot or election results. Check the official results: the California Secretary of State’s Statement of Vote.');
    }
  });

  test('a vetoed bill is not called finally not enacted (W22), and its code sections are called proposed (W6)', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-ab1116');
    const standing = page.getByRole('region', { name: 'Where this measure stands' });
    await expect(standing).toContainText('None: vetoed, not enacted as of the last check');
    const sections = page.getByRole('region', { name: 'Code sections named in the latest version’s amending clauses' });
    // A veto can still be overridden, so, as in the effective-date cell, it is not called final.
    if (await sections.count()) await expect(sections).toContainText('Proposed changes; this measure has not been enacted.');
    await expect(page.getByRole('heading', { name: 'Code sections the latest version changes' })).toHaveCount(0);
  });

  test('a bill still in committee after the deadline says when the last day to pass bills was (DL4)', async ({ page }) => {
    await open(page, '#/laws/ca-20252026-sb46');
    const status = page.locator('.status-cell').filter({ has: page.getByRole('heading', { name: 'Legislative status' }) });
    await expect(status).toContainText('In Committee Process');
    await expect(status).toContainText('The last day for each house to pass bills in the 2025–26 session was August 31, 2026 (California Constitution, article IV, section 10(c)');
    // A constitutional amendment is not subject to that deadline.
    await open(page, '#/laws/ca-20252026-aca15');
    await expect(page.getByRole('region', { name: 'Where this measure stands' })).not.toContainText('The last day for each house to pass bills');
  });
});

test.describe('Legislation directory', () => {
  test('the status filter says that pending bills are past the deadline (DL4)', async ({ page }) => {
    await open(page, '#/laws?jur=ca');
    await expect(heading(page)).toHaveText('Election legislation');
    const hint = page.locator('form.filters .hint');
    await expect(hint).toContainText(/\d+ Assembly or Senate bills? in this dataset still shows? In Committee Process, Pending Referral or In Floor Process\. The last day for each house/);
    const text = await hint.textContent();
    // The status menu points at the note, which counts the whole dataset, as the menu's own counts do.
    const select = page.getByLabel('Status as reported');
    await expect(select).toHaveAttribute('aria-describedby', (await hint.getAttribute('id'))!);
    await open(page, '#/laws?jur=ca&status=Chaptered');
    await expect(page.locator('form.filters .filters-status')).toContainText('match these filters');
    await expect(hint).toHaveText(text!);
  });
});

test.describe('Source packs', () => {
  test('a bill pack names the bulk archive as the checked source and the leginfo page as not machine-checked (DL14)', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    const pack = await downloadJson(page);
    const subject = pack.items[0]!;
    expect(subject.sourceUrl).toBe('https://downloads.leginfo.legislature.ca.gov/');
    expect(subject.pageUrl).toMatch(/^https:\/\/leginfo\.legislature\.ca\.gov\//);
    expect(pack.items.filter((i) => i.sourceUrl?.includes('leginfo.legislature.ca.gov/faces'))).toEqual([]);
    const version = pack.items.find((i) => i.section === 'text_version' && i.detail?.includes('SHA-256'))!;
    expect(version.detail).toContain('SHA-256 hash of the extracted text, not of the official file');
    const vote = pack.items.find((i) => i.detail?.includes('Ayes 75. Noes 1.'))!;
    expect(vote.detail).toContain('Taken when the measure’s subject was: Voter registration: residency confirmation.');
    const links = pack.items.filter((i) => i.section === 'link');
    expect(links.length).toBeGreaterThan(0);
    for (const row of links) {
      expect(row.verificationMethod).toBeTruthy();
      expect(row.verificationNote).toContain('does not check the description');
      expect(row.title).not.toMatch(/state:\d|ca-\d{8}-/);
    }
  });

  test('a case pack never gives a dead opinion address as a source (W2, DL1), and files the questions presented separately (DB11)', async ({ page }) => {
    await open(page, '#/pack/case/scotus-16-1161');
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Court documents \(1\)$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Court cases/ })).toHaveCount(0);
    const entry = page.locator('.pack-items li').filter({ hasText: 'Docket entry, decision' }).filter({ hasText: 'Judgment VACATED' });
    await expect(entry).toContainText('Document unavailable');
    await expect(entry).toContainText('answered 404 (not found)');
    await expect(entry.locator('.pack-url').filter({ hasText: /docket/ })).toBeVisible();

    await open(page, '#/litigation/scotus-16-1161');
    const pack = await downloadJson(page);
    expect(pack.items.some((i) => i.sourceUrl?.includes('16-1161_dc8f.pdf'))).toBe(false);
    const dead = pack.items.find((i) => i.documentAvailability === 'unavailable')!;
    expect(dead.sourceUrl).toMatch(/docket/);
    expect(dead.documentAvailabilityNote).toContain('16-1161_dc8f.pdf');
  });

  test('a case pack downloaded from the case page names the linked place, not its key (DB11)', async ({ page }) => {
    await open(page, '#/litigation/scotus-24-109');
    const pack = await downloadJson(page);
    const titles = pack.items.map((i) => i.title ?? '');
    expect(titles.some((t) => t.includes('Louisiana'))).toBe(true);
    expect(titles.some((t) => /\bstate:\d{2}\b/.test(t))).toBe(false);
  });
});

test.describe('Place timeline', () => {
  test('a vote taken before a gut-and-amend names the subject the measure had then (DL2)', async ({ page }) => {
    await open(page, '#/place/state:06?tab=timeline&from=2025-04-01&to=2025-04-01');
    const vote = page.locator('.timeline-item').filter({ hasText: 'AB 604' }).filter({ hasText: 'Ayes 75. Noes 1.' });
    await expect(vote).toContainText('Taken when the measure’s subject was: Voter registration: residency confirmation.');
  });
});
