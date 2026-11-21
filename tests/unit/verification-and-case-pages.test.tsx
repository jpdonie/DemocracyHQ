// @vitest-environment jsdom
/**
 * Verification wording, case-page documents whose address answered "not found", the copy-link and watchlist status
 * messages, and the Connecticut population note. Synthetic records only (see fixtures.ts).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreProvider } from '../../src/lib/core';
import { clearDataCache } from '../../src/lib/data';
import { clearResolvedLoads } from '../../src/lib/useLoad';
import { clearWatchlist } from '../../src/lib/watchlist';
import { populationFor } from '../../src/lib/population';
import {
  LINK_CHECK_SCOPE, METHOD_LABELS, RECORD_CHECK_SCOPE, UNASSIGNED_STATUSES, VERIFICATION_LABELS, VERIFICATION_MEANINGS,
} from '../../src/lib/verification';
import { CopyLinkButton, WatchButton } from '../../src/components/ui';
import { CaseDetail } from '../../src/features/litigation/CaseDetail';
import {
  SYNTHETIC_HOST, makeBill, makeCase, makeEvent, makeFullCase, makeGeoIndexFile, makeManifest, makePopulationFile, makeRedistricting,
  makeRelationship, makeSource, populationRow,
} from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearDataCache();
  clearResolvedLoads();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verification labels say what was checked, and no more', () => {
  it('names the check, not a verification of everything shown with the record', () => {
    expect(VERIFICATION_LABELS.verified_primary).toBe('Checked against the official source');
    expect(METHOD_LABELS.automated_primary_retrieval).toBe('Retrieved automatically from the official source and parsed without error');
    expect(METHOD_LABELS.maintainer_curated).toBe('Written by a maintainer; the quoted passage was found in the cited document when it was last fetched');
    const meaning = VERIFICATION_MEANINGS.verified_primary;
    expect(meaning).toMatch(/parsed without error/);
    expect(meaning).toMatch(/entry labels, issue tags, the latest-ruling entry and derived dates\) and the link descriptions written by maintainers are not part of that check/);
    expect(meaning).toMatch(/does not mean a lawyer reviewed/);
    expect(meaning).not.toMatch(/schema validation/);
    expect(RECORD_CHECK_SCOPE).toMatch(/not part of it/);
    expect(LINK_CHECK_SCOPE).toMatch(/does not test the description/);
  });

  it('marks the states that nothing assigns yet', () => {
    expect([...UNASSIGNED_STATUSES].sort()).toEqual(['awaiting_review', 'disputed', 'outdated']);
  });
});

/** Answers each data file the case page and the core loader ask for. */
function serveCase(caseRecord: ReturnType<typeof makeFullCase>) {
  const files: Record<string, () => Response> = {
    'manifest.json': () => json(makeManifest()),
    'sources.json': () => json({ sources: [makeSource()] }),
    'geo/index.json': () => json(makeGeoIndexFile()),
    'litigation/index.json': () => json({ cases: [makeCase()] }),
    'legislation/index.json': () => json({ bills: [makeBill()], selection: { ruleId: 'sel', pattern: 'x', appliedTo: 'subject', totalBillsInSession: 10 } }),
    'events.json': () => json({ events: [makeEvent()] }),
    'redistricting.json': () => json(makeRedistricting()),
    'relationships.json': () => json({ relationships: [makeRelationship()] }),
    'litigation/cases/synthetic-case-1.json': () => json(caseRecord),
  };
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname.replace(/^.*?\/data\//, '');
    const answer = files[path];
    return answer ? answer() : json({}, 404);
  });
}

describe('a case page with a document whose address answered "not found"', () => {
  const deadUrl = `${SYNTHETIC_HOST}/court/99-0001/opinion.pdf`;
  const record = () => {
    const base = makeFullCase();
    return makeFullCase({
      documents: [
        ...base.documents,
        {
          id: 'synthetic-case-1:d2', caseId: 'synthetic-case-1', entryIndex: 2, title: 'Opinion (linked in docket entry)', filingDate: '2026-03-01',
          documentType: 'Opinion', url: deadUrl, availability: 'unavailable',
          accessNote: 'The Court\'s docket gives this address, which answered 404 (not found) when checked on 2026-06-14. The Court may have moved the file.',
          sameTextAs: [],
        },
      ],
      events: base.events.map((e) => (e.id === 'synthetic-case-1:e3' ? { ...e, documentIds: ['synthetic-case-1:d2'] } : e)),
    });
  };

  it('shows the label, the dated note and the address as text, never as a link', async () => {
    serveCase(record());
    render(<CoreProvider><CaseDetail id="synthetic-case-1" route={{ path: ['litigation', 'synthetic-case-1'], query: {} }} /></CoreProvider>);
    const docket = await screen.findByRole('region', { name: 'Docket entries' });
    const item = (await within(docket).findByText(deadUrl)).closest('li')!;
    expect(item.textContent).toContain('Opinion (linked in docket entry): shown without a link.');
    expect(item.textContent).toContain('which answered 404 (not found) when checked on Jun 14, 2026');
    expect(within(item).queryByRole('link')).toBeNull();
    expect([...docket.querySelectorAll('a')].map((a) => a.getAttribute('href'))).not.toContain(deadUrl);
    // A document that answers keeps its ordinary link.
    expect(within(docket).getByRole('link', { name: /Petition/ }).getAttribute('href')).toBe(`${SYNTHETIC_HOST}/court/99-0001/petition.pdf`);
  });

  it('puts what the check covers beside every badge', async () => {
    serveCase(record());
    render(<CoreProvider><CaseDetail id="synthetic-case-1" route={{ path: ['litigation', 'synthetic-case-1'], query: {} }} /></CoreProvider>);
    const source = await screen.findByRole('complementary', { name: 'Source and verification' });
    expect(source.textContent).toContain('Checked against the official source');
    expect(source.textContent).toContain(RECORD_CHECK_SCOPE);
    const links = await screen.findByRole('region', { name: 'Places and legislation linked to this case' });
    await within(links).findByRole('link', { name: 'California' });
    expect(links.textContent).toContain(LINK_CHECK_SCOPE);
  });
});

describe('the copy-link button', () => {
  const stubClipboard = (writeText: () => Promise<void>) => {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
  };

  it('keeps a failure, with the address in a read-only field, until the next action', async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.reject(new Error('not allowed')));
    render(<CopyLinkButton hash="#/litigation/synthetic-case-1" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); });
    const field = screen.getByRole('textbox', { name: 'Link to this page' }) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toMatch(/#\/litigation\/synthetic-case-1$/);
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole('status').textContent).toMatch(/could not be copied automatically/);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole('textbox', { name: 'Link to this page' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/could not be copied automatically/);
  });

  it('clears only the confirmation by itself', async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    render(<CopyLinkButton hash="#/litigation/synthetic-case-1" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); });
    expect(screen.getByRole('status').textContent).toBe('Link copied');
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => { vi.advanceTimersByTime(4_500); });
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('the watchlist button', () => {
  it('says so when the browser refuses to save the list', () => {
    clearWatchlist();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    render(<WatchButton item={{ type: 'case', id: 'synthetic-case-1', label: 'Synthetic v. Example' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(screen.getByRole('button', { name: 'Add to watchlist' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('status').textContent).toMatch(/^Could not add this to the watchlist: this browser did not let the site save it\./);
  });
});

describe('the population note for a county equivalent without a count', () => {
  const counties = makePopulationFile({ '06037': populationRow(1000) }, 'synthetic-county');

  it('explains Connecticut’s planning regions there, and does not mention the island areas', () => {
    const result = populationFor('county:09110', counties, makeRedistricting());
    expect(result.status === 'unavailable' && result.reason).toMatch(/Connecticut’s planning regions replaced its counties/);
    expect(result.status === 'unavailable' && result.reason).not.toMatch(/island areas/);
  });

  it('does not mention Connecticut for a county elsewhere', () => {
    const result = populationFor('county:48201', counties, makeRedistricting());
    expect(result.status === 'unavailable' && result.reason).toBe('No count is shown for this county equivalent under its current boundaries.');
  });
});
