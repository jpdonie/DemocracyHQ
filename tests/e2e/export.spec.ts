import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { BILL, CASE, expect, heading, open, test } from './fixtures';

async function download(page: Page, button: string): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, 'utf8') };
}

/** A small RFC 4180 reader, enough to check the export round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r') { /* handled with \n */ } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test.describe('Legal source pack', () => {
  test('downloads a case as JSON with source links, dates and verification states', async ({ page }) => {
    await open(page, `#/litigation/${CASE.id}`);
    await expect(heading(page)).toHaveText(CASE.name);
    const { name, text } = await download(page, 'Download JSON');
    expect(name).toMatch(/^democracyhq-source-pack-scotus-24-109-\d{4}-\d{2}-\d{2}\.json$/);

    const pack = JSON.parse(text);
    expect(pack.format).toBe('democracyhq-legal-source-pack');
    expect(pack.subject).toMatchObject({ type: 'case', id: CASE.id });
    expect(pack.subject.url).toContain(`#/litigation/${CASE.id}`);
    expect(pack.notices.join(' ')).toContain('A data gap is not evidence of absence');
    expect(pack.notices.join(' ')).toContain('not legal advice');
    expect(pack.items.length).toBeGreaterThan(20);
    expect(pack.sources.map((s: { id: string }) => s.id)).toContain('scotus-docket');

    for (const item of pack.items as Array<Record<string, string | null>>) {
      // Every dated entry says what its date means, and every source link is an https link.
      if (item.date) expect(item.dateMeaning, `date meaning for ${item.id}`).toBeTruthy();
      if (item.sourceUrl) expect(item.sourceUrl).toMatch(/^https:\/\//);
    }
    const entries = pack.items.filter((i: { section: string }) => i.section === 'event');
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.every((i: { sourceUrl: string | null }) => i.sourceUrl?.includes('supremecourt.gov'))).toBe(true);
    await expect(page.locator('.export [role=status]')).toContainText(`Downloaded ${name}`);
  });

  test('downloads a bill as CSV that reads back row for row', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await expect(heading(page)).toHaveText(BILL.heading);
    const json = JSON.parse((await download(page, 'Download JSON')).text);
    const { name, text } = await download(page, 'Download CSV');
    expect(name).toMatch(/\.csv$/);

    const rows = parseCsv(text);
    expect(rows[0]).toEqual([
      'section', 'id', 'title', 'date', 'date_meaning', 'detail', 'source_name', 'source_url', 'last_checked_at', 'verification', 'democracyhq_url',
      'verification_method', 'verification_note', 'document_availability', 'document_availability_note', 'official_page_url_not_machine_checked',
    ]);
    const data = rows.slice(1).filter((r) => r.length === rows[0]!.length);
    expect(data.length).toBe(json.items.length);
    // The effective-date row carries the condition from the bill text, not a bare date.
    const effective = data.find((r) => r[1] === `${BILL.id}:effective`)!;
    expect(effective[5]).toContain('Condition stated in the bill text');
    // Legislative status, effective date and judicial enforceability are separate rows.
    expect(data.some((r) => r[2] === 'Judicial enforceability')).toBe(true);
    expect(text).toContain('A data gap is not evidence of absence');
  });

  test('exports a place with its population observation and vintage', async ({ page }) => {
    await open(page, '#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    await page.getByRole('link', { name: 'Export source pack' }).click();
    await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    const pack = JSON.parse((await download(page, 'Download JSON')).text);
    expect(pack.subject).toMatchObject({ type: 'place', id: 'state:06' });
    const population = pack.items.filter((i: { section: string }) => i.section === 'population');
    expect(population.length).toBeGreaterThan(0);
    expect(JSON.stringify(population)).toContain('39538223');
    expect(JSON.stringify(population)).toMatch(/2020 Census/);
  });

  test('opens a print-friendly summary that hides the map and navigation on paper', async ({ page }) => {
    await open(page, `#/laws/${BILL.id}`);
    await page.getByRole('link', { name: 'Open print summary' }).click();
    await expect(page).toHaveURL(new RegExp(`#/pack/bill/${BILL.id}$`));
    await expect(heading(page)).toContainText('CA AB 604');
    await expect(page.getByText('DemocracyHQ legal source pack')).toBeVisible();
    await expect(page.getByText('It is not legal advice')).toBeVisible();
    await expect(page.getByText('Coverage is incomplete. A data gap is not evidence of absence.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('banner')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
    await expect(heading(page)).toBeVisible();
    // Source addresses are printed in full, since a link cannot be followed on paper.
    await expect(page.locator('.pack-url').first()).toContainText('https://');
  });
});
