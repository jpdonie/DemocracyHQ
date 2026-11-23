// @vitest-environment jsdom
/**
 * Federal district courts and state courts: the kind, system and level of a case's court, the filters of the list of
 * court cases, the map that follows them, and how a case read from CourtListener is worded in a row and on its page.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreProvider } from '../../src/lib/core';
import {
  caseCourtCitation, caseCourtFullName, caseCourtHash, caseCourtListName, casesByKind, courtKind, courtLevel, courtSystem, levelName, levelOfKind, recordBasis, stateCourtCases,
  systemOfKind,
} from '../../src/lib/courts';
import { isDecisionCaseId } from '../../src/lib/data';
import { caseStateCounts, caseStates, filterCases, knownCaseFilters } from '../../src/lib/filters';
import { caseStatesTheme } from '../../src/lib/mapTheme';
import { DecisionIndexSchema, LegalCaseSchema, LegalCaseSummarySchema } from '../../src/types/schemas';
import { CaseDetail } from '../../src/features/litigation/CaseDetail';
import { CaseRow, caseFiltersFromQuery } from '../../src/features/litigation/CaseDirectory';
import {
  makeAppealsCase, makeCase, makeCircuitIndexFile, makeCircuitsFile, makeDecisionCase, makeDecisionIndexFile, makeDistrictCase, makeFederalBillIndexFile, makeFullDecisionCase,
  makeDocketCase, makeDocketListing, makeFullDocketCase, makeGeoIndexFile, makeManifest, makeRedistricting, makeSource,
} from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const supreme = makeCase();
const appeal = makeAppealsCase();
const state = makeDecisionCase();
const district = makeDistrictCase();
const appellate = makeDecisionCase({
  id: 'cl-9000003', courtId: 'lactapp', docketNumber: '2026-CA-0003',
  court: { name: 'Louisiana Court of Appeal', courtType: 'state_appellate', stateFips: '22', citation: 'La. Ct. App.', ruleId: 'court-state-synthetic' },
  issueTags: [],
});
const all = [supreme, appeal, state, district, appellate];

describe('the kind of court a case is in', () => {
  it('is read from the id of the fourteen federal courts and from the record of every other court', () => {
    expect(all.map(courtKind)).toEqual(['federal_supreme', 'federal_appellate', 'state_supreme', 'federal_district', 'state_appellate']);
    expect(all.map(courtSystem)).toEqual(['federal', 'federal', 'state', 'federal', 'state']);
    expect(all.map(courtLevel)).toEqual(['supreme', 'appellate', 'supreme', 'trial', 'appellate']);
    expect(courtKind({ courtId: 'unknown', court: null })).toBeNull();
    expect([systemOfKind('federal_district'), levelOfKind('federal_district'), systemOfKind('state_trial'), levelOfKind('state_trial')]).toEqual(['federal', 'trial', 'state', 'trial']);
  });

  it('names a level by the courts of the system chosen', () => {
    expect([levelName('trial', 'federal'), levelName('trial', 'state'), levelName('trial')]).toEqual(['District courts', 'State trial courts', 'Trial courts']);
    expect([levelName('supreme', 'federal'), levelName('supreme', 'state'), levelName('appellate', 'federal')]).toEqual(['Supreme Court', 'State supreme courts', 'Courts of appeals']);
  });

  it('says how a case is known: a docket, the documents on GovInfo, or the decisions on CourtListener', () => {
    expect(all.map(recordBasis)).toEqual(['docket', 'govinfo', 'courtlistener', 'courtlistener', 'courtlistener']);
    expect([isDecisionCaseId('cl-9000001'), isDecisionCaseId('ca5-25-30725'), isDecisionCaseId('cl-'), isDecisionCaseId('cl-12x')]).toEqual([true, false, false, false]);
  });

  it('names the court of a case in full, in a list and in a citation', () => {
    expect(caseCourtFullName(district)).toBe('United States District Court for the Northern District of Texas');
    expect(caseCourtListName(district)).toBe('U.S. District Court, Northern District of Texas');
    expect(caseCourtListName(state)).toBe('Supreme Court of Louisiana');
    expect(caseCourtListName(supreme)).toBe('Supreme Court of the United States');
    expect(caseCourtListName(appeal)).toBe('Ninth Circuit');
    expect([caseCourtCitation(district), caseCourtCitation(state), caseCourtCitation(appeal)]).toEqual(['N.D. Tex.', 'La.', '9th Cir.']);
    // A court without a short form is cited by its name.
    expect(caseCourtCitation(makeDecisionCase({ court: { ...state.court!, citation: null } }))).toBe('Supreme Court of Louisiana');
    // The fourteen federal courts have a page; every other court leads to the list of its cases.
    expect([caseCourtHash(appeal), caseCourtHash(state)]).toEqual(['#/court/ca9', '#/litigation?court=la']);
  });

  it('counts the cases and the courts of each kind', () => {
    const counts = casesByKind([...all, makeDistrictCase({ id: 'cl-9000004' })]);
    expect(counts.get('federal_district')).toEqual({ cases: 2, courts: 1 });
    expect(counts.get('state_supreme')).toEqual({ cases: 1, courts: 1 });
    expect(stateCourtCases(counts)).toEqual({ cases: 2, courts: 2 });
    expect(counts.get('state_trial')).toBeUndefined();
  });
});

describe('the filters of the list of court cases', () => {
  it('narrows by court system and by level, alone and together', () => {
    const ids = (filters: Parameters<typeof filterCases>[1]) => filterCases(all, filters).map((c) => c.id).sort();
    expect(ids({ system: 'state' })).toEqual(['cl-9000001', 'cl-9000003']);
    expect(ids({ system: 'federal' })).toEqual(['ca9-99-00001', 'cl-9000002', 'synthetic-case-1']);
    expect(ids({ level: 'supreme' })).toEqual(['cl-9000001', 'synthetic-case-1']);
    expect(ids({ system: 'state', level: 'supreme' })).toEqual(['cl-9000001']);
    expect(ids({ system: 'federal', level: 'trial' })).toEqual(['cl-9000002']);
    expect(ids({ system: 'state', level: 'trial' })).toEqual([]);
  });

  it('combines the system, the issue and the state, as a reader does who picks state courts, mail voting and Louisiana', () => {
    const more = [...all, makeDecisionCase({ id: 'cl-9000005', courtId: 'tex', court: { name: 'Texas Supreme Court', courtType: 'state_supreme', stateFips: '48', citation: 'Tex.', ruleId: 'court-state-synthetic' } })];
    expect(filterCases(more, { system: 'state', tag: 'mail-voting' }).map((c) => c.id).sort()).toEqual(['cl-9000001', 'cl-9000005']);
    expect(filterCases(more, { system: 'state', tag: 'mail-voting', state: '22' }).map((c) => c.id)).toEqual(['cl-9000001']);
    expect(filterCases(more, { system: 'state', level: 'appellate', state: '22' }).map((c) => c.id)).toEqual(['cl-9000003']);
  });

  it('lists a case of a district court or a state court under the state its court sits in', () => {
    expect([caseStates(state), caseStates(district), caseStates(appeal)]).toEqual([['22'], ['48'], ['06']]);
    expect([...caseStateCounts(all)].sort()).toEqual([['06', 2], ['22', 2], ['48', 1]]);
    expect(filterCases(all, { court: 'la' }).map((c) => c.id)).toEqual(['cl-9000001']);
    expect(filterCases(all, { q: 'supreme court of louisiana' }).map((c) => c.id)).toEqual(['cl-9000001']);
  });

  it('reads the filters from the address and drops what the menus do not offer', () => {
    expect(caseFiltersFromQuery({ system: 'state', level: 'trial' })).toMatchObject({ system: 'state', level: 'trial' });
    expect(caseFiltersFromQuery({ system: 'county', level: 'highest' })).toMatchObject({ system: undefined, level: undefined });
    // A court that has a published case is a choice; one that has none is not, unless it is one of the fourteen.
    expect(knownCaseFilters({ court: 'la' }, all).court).toBe('la');
    expect(knownCaseFilters({ court: 'nowhere' }, all).court).toBeUndefined();
    expect(knownCaseFilters({ court: 'cafc' }, all).court).toBe('cafc');
    // "appeals", which older links use for the thirteen courts of appeals together, is the federal appellate level.
    expect(knownCaseFilters({ court: 'appeals' }, all)).toMatchObject({ system: 'federal', level: 'appellate', court: undefined });
    expect(filterCases(all, knownCaseFilters({ court: 'appeals' }, all)).map((c) => c.id)).toEqual(['ca9-99-00001']);
  });
});

describe('the map of the list of court cases', () => {
  it('shades the states that have a case, gives the count in the tooltip and says when the filters are applied', () => {
    const plain = caseStatesTheme(caseStateCounts(all));
    expect([...plain.classOf.keys()].sort()).toEqual(['06', '22', '48']);
    expect(plain.title).toBe('Court cases by state');
    expect(plain.detailOf?.get('22')).toBe('2 cases in this dataset');
    expect(plain.family).toBeUndefined();

    const filtered = caseStatesTheme(caseStateCounts(filterCases(all, { system: 'state', level: 'supreme' })), true);
    expect([...filtered.classOf.keys()]).toEqual(['22']);
    expect(filtered.title).toBe('Court cases that match the filters, by state');
    expect(filtered.detailOf?.get('22')).toBe('1 case matches the filters');
    expect(filtered.hatch?.label).toContain('Not evidence that none exists');
    // Two sets of filters give the same kind of colouring over other states, so the map does not fade between them.
    expect(filtered.family).toBe(caseStatesTheme(new Map([['48', 3]]), true).family);
    expect(filtered.id).not.toBe(caseStatesTheme(new Map([['48', 3]]), true).id);
  });
});

describe('the published form of a case read from CourtListener', () => {
  it('is accepted by the schemas of the index, of a list entry and of a record', () => {
    expect(LegalCaseSummarySchema.safeParse(state).success).toBe(true);
    expect(LegalCaseSchema.safeParse(makeFullDecisionCase()).success).toBe(true);
    expect(DecisionIndexSchema.safeParse(makeDecisionIndexFile()).success).toBe(true);
    // A kind of court the site does not know is refused, so it can never be listed under a wrong level.
    expect(LegalCaseSummarySchema.safeParse({ ...state, court: { ...state.court, courtType: 'tribal' } }).success).toBe(false);
  });
});

describe('a row of the list', () => {
  const row = (record: Parameters<typeof CaseRow>[0]['record']) => {
    const { container } = render(<ul><CaseRow record={record} labels={new Map([['mail-voting', 'Mail voting']])} /></ul>);
    return container.querySelector<HTMLElement>('li.row')!;
  };

  it('marks a state court case as such, names its court and says the decision was read from CourtListener', () => {
    const item = row(state);
    expect(item.querySelector('.sysmark')?.textContent).toBe('State');
    expect(item.textContent).toContain('No. 2026-C-00001, Supreme Court of Louisiana, published decision');
    // CourtListener gives a decision no docket text, so the line names the kind of document and quotes nothing.
    const line = item.querySelector('.row-line')!;
    expect(line.textContent).toBe('Mar 2, 2026 Opinion, published');
    expect(line.querySelector('q')).toBeNull();
    expect(item.querySelector('.row-foot')?.textContent).toBe('CourtListener’s copy, not the court’s, through Mar 2, 2026');
    expect(item.querySelector('.row-why')?.textContent).toContain('“absentee ballots” 9×');
  });

  it('marks a district court, a court of appeals and the Supreme Court as federal', () => {
    expect(row(district).querySelector('.sysmark')?.textContent).toBe('Federal');
    cleanup();
    const appealRow = row(appeal);
    expect(appealRow.querySelector('.sysmark')?.textContent).toBe('Federal');
    expect(appealRow.querySelector('.row-foot')?.textContent).toContain('Documents on GovInfo through');
    cleanup();
    const supremeRow = row(supreme);
    expect(supremeRow.querySelector('.sysmark')?.textContent).toBe('Federal');
    expect(supremeRow.querySelector('.row-foot')?.textContent).toContain('Docket activity through');
  });
});

describe('the page of a case read from CourtListener', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function serve() {
    const files: Record<string, unknown> = {
      'manifest.json': makeManifest(),
      'sources.json': { sources: [makeSource({ id: 'synthetic-courtlistener', name: 'Synthetic CourtListener' })] },
      'geo/index.json': makeGeoIndexFile(),
      'litigation/index.json': { cases: [makeCase()] },
      'circuits/index.json': makeCircuitIndexFile(),
      'decisions/index.json': makeDecisionIndexFile(),
      'legislation/index.json': { bills: [], selection: { ruleId: 'sel', pattern: 'x', appliedTo: 'subject', totalBillsInSession: 10 } },
      'congress/index.json': makeFederalBillIndexFile(),
      'geo/circuits.json': makeCircuitsFile(),
      'redistricting.json': makeRedistricting(),
      'relationships.json': { relationships: [] },
      'decisions/cases/cl-9000001.json': makeFullDecisionCase(),
    };
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname.replace(/^.*?\/data\//, '');
      asked.push(path);
      return path in files ? json(files[path]) : json({}, 404);
    });
    return asked;
  }

  it('is loaded from the folder of the decisions and says throughout that CourtListener is not the court', async () => {
    const asked = serve();
    render(<CoreProvider><CaseDetail id="cl-9000001" route={{ path: ['litigation', 'cl-9000001'], query: {} }} /></CoreProvider>);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Synthetic Voters v. Synthetic Parish Board of Election Supervisors' });
    expect(asked).toContain('decisions/cases/cl-9000001.json');
    const header = heading.closest('header')!;
    expect(header.querySelector('.lede')?.textContent).toBe('State No. 2026-C-00001, Supreme Court of Louisiana');
    expect(within(header).getByRole('link', { name: 'Supreme Court of Louisiana' }).getAttribute('href')).toBe('#/litigation?court=la');

    const holds = screen.getByRole('heading', { name: 'What CourtListener holds for this case' }).closest('section')!;
    expect(holds.textContent).toContain('The latest opinion of the court among them is dated Mar 2, 2026.');
    expect(holds.textContent).toContain('State supreme court: the highest court of a state, whatever its name, as CourtListener classes the court');
    expect(holds.textContent).toContain('Published, as CourtListener’s record of the decision says');
    expect(holds.textContent).toContain('This is not the court’s docket.');
    expect(within(holds).getAllByRole('link', { name: /Opinion of Mar 2, 2026 \(CourtListener’s copy of the file\)/ })[0]!.getAttribute('href')).toContain('storage.courtlistener.com');

    const why = screen.getByRole('heading', { name: 'Why this case is listed' }).closest('section')!;
    expect(why.textContent).toContain('Picked by a published rule (rule court-select-synthetic), not by a maintainer');
    expect(why.textContent).toContain('has 31 election words in 4,200 words (7.4 per 1,000) and 12 election phrases');

    const list = screen.getByRole('heading', { name: 'Decisions on CourtListener (1)' }).closest('section')!;
    expect(list.textContent).toContain('CourtListener gives a decision no docket text.');
    expect(list.querySelectorAll('li.entry')).toHaveLength(1);
    expect(list.querySelector('li.entry')?.textContent).toContain('Opinion, published');

    const source = screen.getByRole('complementary', { name: 'Source and verification' });
    expect(source.textContent).toContain('Imported from secondary source');
    expect(source.textContent).toContain('Latest decision CourtListener holds for the case');
    expect(source.textContent).not.toContain('Checked against the official source');
  });
});

describe('a voting case of a federal district court read from its docket in the RECAP Archive', () => {
  const docket = makeDocketCase();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('is known from a docket of the archive, which is neither the court’s docket nor a decision', () => {
    expect(recordBasis(docket)).toBe('recap');
    expect(recordBasis(district)).toBe('courtlistener');
    expect(LegalCaseSummarySchema.safeParse(docket).success).toBe(true);
    expect(LegalCaseSchema.safeParse(makeFullDocketCase()).success).toBe(true);
    expect(DecisionIndexSchema.safeParse({ ...makeDecisionIndexFile(), dockets: makeDocketListing() }).success).toBe(true);
    // A release made before dockets were read carries no such block, and is still accepted.
    expect(DecisionIndexSchema.safeParse(makeDecisionIndexFile()).success).toBe(true);
  });

  it('has a row that names the clerk’s nature of suit and no ruling', () => {
    const { container } = render(<ul><CaseRow record={docket} labels={new Map()} /></ul>);
    const item = container.querySelector<HTMLElement>('li.row')!;
    expect(item.querySelector('.sysmark')?.textContent).toBe('Federal');
    expect(item.querySelector('.row-why')?.textContent).toBe('Nature of suit in the court’s record: 441 Civil Rights: Voting');
    expect(item.querySelector('.row-line')?.textContent).toBe('2 docket entries in the RECAP Archive. No rule reads them for rulings yet: see the docket.');
    expect(item.querySelector('.row-foot')?.textContent).toBe('The docket as the RECAP Archive holds it, not the court’s own, through Mar 9, 2026');
  });

  it('has a page that lists the entries in the clerk’s words and says throughout that the archive is not the court', async () => {
    const files: Record<string, unknown> = {
      'manifest.json': makeManifest(),
      'sources.json': { sources: [makeSource({ id: 'synthetic-courtlistener', name: 'Synthetic CourtListener' })] },
      'geo/index.json': makeGeoIndexFile(),
      'litigation/index.json': { cases: [makeCase()] },
      'circuits/index.json': makeCircuitIndexFile(),
      'decisions/index.json': { ...makeDecisionIndexFile([makeDecisionCase(), docket]), dockets: makeDocketListing() },
      'legislation/index.json': { bills: [], selection: { ruleId: 'sel', pattern: 'x', appliedTo: 'subject', totalBillsInSession: 10 } },
      'congress/index.json': makeFederalBillIndexFile(),
      'geo/circuits.json': makeCircuitsFile(),
      'redistricting.json': makeRedistricting(),
      'relationships.json': { relationships: [] },
      'decisions/cases/cl-9000900.json': makeFullDocketCase(),
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname.replace(/^.*?\/data\//, '');
      return path in files ? json(files[path]) : json({}, 404);
    });
    render(<CoreProvider><CaseDetail id="cl-9000900" route={{ path: ['litigation', 'cl-9000900'], query: {} }} /></CoreProvider>);
    await screen.findByRole('heading', { level: 1, name: 'Synthetic Voters v. Synthetic Registrar' });

    const holds = screen.getByRole('heading', { name: 'What the RECAP Archive holds for this case' }).closest('section')!;
    expect(holds.textContent).toContain('The archive holds 2 entries of this docket, dated Mar 2, 2026 to Mar 9, 2026 and a copy of 1 filing.');
    expect(holds.textContent).toContain('this page names no ruling');
    expect(holds.textContent).toContain('441 Civil Rights: Voting, as the clerk of the court recorded it');
    expect(holds.textContent).toContain('This is not the court’s own docket.');
    expect(holds.textContent).toContain('last changed there on Mar 10, 2026');
    expect(screen.queryByRole('heading', { name: 'What CourtListener holds for this case' })).toBeNull();

    const why = screen.getByRole('heading', { name: 'Why this case is listed' }).closest('section')!;
    expect(why.textContent).toContain('Picked by a published rule (rule docket-select-1), not by a maintainer');
    expect(why.textContent).toContain('The court’s record gives the case the nature of suit 441 (Civil Rights: Voting).');
    expect(why.textContent).toContain('A voting case filed under another one is missed');
    expect(why.textContent).not.toContain('election words');

    const list = screen.getByRole('heading', { name: 'Docket entries in the RECAP Archive (2)' }).closest('section')!;
    const entries = list.querySelectorAll('li.entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toContain('1. COMPLAINT against Synthetic Registrar, filed by Synthetic Voters.');
    expect(within(list).getByRole('link', { name: /Document 1: Complaint \(the RECAP Archive’s copy\)/ }).getAttribute('href')).toContain('storage.courtlistener.com/recap/');
    expect(entries[1]!.querySelector('a')).toBeNull();
    expect(list.textContent).toContain('An entry without a link has no copy of its filing in the archive');

    const source = screen.getByRole('complementary', { name: 'Source and verification' });
    expect(source.textContent).toContain('Imported from secondary source');
    expect(source.textContent).toContain('Latest docket entry the RECAP Archive holds');
  });
});
