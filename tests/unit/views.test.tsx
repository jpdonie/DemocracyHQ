// @vitest-environment jsdom
/**
 * Component tests of the record views with the data layer stubbed at fetch: a file that is loading or failed must be
 * shown as such, never as "no link exists".
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreProvider } from '../../src/lib/core';
import { clearDataCache } from '../../src/lib/data';
import { clearResolvedLoads } from '../../src/lib/useLoad';
import { CaseDetail } from '../../src/features/litigation/CaseDetail';
import { BillDetail } from '../../src/features/legislation/BillDetail';
import { makeBill, makeCase, makeEvent, makeFullBill, makeFullCase, makeGeoIndexFile, makeManifest, makeRedistricting, makeRelationship, makeSource } from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Answer = Response | Promise<Response>;

/** Answers each data file; `relationships` decides how relationships.json is answered. */
function serve(relationships: () => Answer) {
  const files: Record<string, () => Answer> = {
    'manifest.json': () => json(makeManifest()),
    'sources.json': () => json({ sources: [makeSource()] }),
    'geo/index.json': () => json(makeGeoIndexFile()),
    'litigation/index.json': () => json({ cases: [makeCase()] }),
    'legislation/index.json': () => json({ bills: [makeBill()], selection: { ruleId: 'sel', pattern: 'x', appliedTo: 'subject', totalBillsInSession: 10 } }),
    'events.json': () => json({ events: [makeEvent()] }),
    'redistricting.json': () => json(makeRedistricting()),
    'litigation/cases/synthetic-case-1.json': () => json(makeFullCase()),
    'legislation/bills/ca-99999999-zz1.json': () => json(makeFullBill()),
    'relationships.json': relationships,
  };
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname.replace(/^.*?\/data\//, '');
    const answer = files[path];
    return answer ? answer() : json({}, 404);
  });
}

const caseView = () => render(<CoreProvider><CaseDetail id="synthetic-case-1" route={{ path: ['litigation', 'synthetic-case-1'], query: {} }} /></CoreProvider>);
const billView = () => render(<CoreProvider><BillDetail id="ca-99999999-zz1" route={{ path: ['laws', 'ca-99999999-zz1'], query: {} }} /></CoreProvider>);

beforeEach(() => {
  clearDataCache();
  clearResolvedLoads();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a case page while the links between records are loading or failed', () => {
  it('says the links could not be loaded instead of "no place or bill has been linked"', async () => {
    serve(() => json({}, 503));
    caseView();
    const section = await screen.findByRole('region', { name: 'Places and legislation linked to this case' });
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('Could not load the links between records.');
    expect(alert.textContent).toContain('relationships.json returned HTTP 503.');
    expect(section.textContent).not.toMatch(/No place or bill has been linked/);
  });

  it('shows "Loading" until the links arrive, then the links', async () => {
    let release!: () => void;
    serve(() => new Promise<Response>((resolve) => { release = () => resolve(json({ relationships: [makeRelationship()] })); }));
    caseView();
    const section = await screen.findByRole('region', { name: 'Places and legislation linked to this case' });
    expect(within(section).getByRole('status').textContent).toBe('Loading the links to places and legislation');
    expect(section.textContent).not.toMatch(/No place or bill has been linked/);
    await act(async () => { release(); });
    expect(await within(section).findByRole('link', { name: 'California' })).toBeTruthy();
  });

  it('says that no link exists only once the links have loaded', async () => {
    serve(() => json({ relationships: [] }));
    caseView();
    const section = await screen.findByRole('region', { name: 'Places and legislation linked to this case' });
    expect(await within(section).findByText(/No place or bill has been linked to this case yet/)).toBeTruthy();
  });
});

describe('a bill page while the links between records are loading or failed', () => {
  const courtsCell = async () => (await screen.findByRole('heading', { name: 'In the courts', level: 3 })).parentElement!;

  it('the "In the courts" cell says the links could not be loaded, not "No linked case"', async () => {
    serve(() => json({}, 503));
    billView();
    const cell = await courtsCell();
    expect((await within(cell).findByRole('alert')).textContent).toContain('Could not load the links to court cases.');
    expect(cell.textContent).not.toContain('No linked case in this dataset');
    const links = screen.getByRole('region', { name: 'Linked measures and places' });
    expect(within(links).getByRole('alert').textContent).toContain('Could not load the links between records.');
  });

  it('the "In the courts" cell shows "Loading" until the links arrive', async () => {
    let release!: () => void;
    serve(() => new Promise<Response>((resolve) => { release = () => resolve(json({ relationships: [] })); }));
    billView();
    const cell = await courtsCell();
    expect(within(cell).getByRole('status').textContent).toBe('Loading linked court cases');
    expect(cell.textContent).not.toContain('No linked case in this dataset');
    await act(async () => { release(); });
    expect(await within(cell).findByText('No linked case in this dataset')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Linked measures and places' })).toBeNull();
  });
});
