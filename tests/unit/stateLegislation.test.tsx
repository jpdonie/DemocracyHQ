// @vitest-environment jsdom
/** The measures of the state legislatures read from Open States: coverage, the reasons a state has none, the list and the page. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_STATES, billStateCounts, filterBills, inJurisdiction, knownBillFilters } from '../../src/lib/filters';
import { stateFipsOfAbbr } from '../../src/lib/geo';
import { legislatureCoverage, listNames, unlistedNotes, unlistedSummary, whyNoneListed } from '../../src/lib/stateLegislation';
import { BillRow } from '../../src/features/legislation/BillDirectory';
import { actionKinds, isKeyAction, stageTrack } from '../../src/features/legislation/StateMeasureDetail';
import { makeBill, makeFederalBill, makeStateLegislationIndex, makeStateMeasure } from './fixtures';

afterEach(() => cleanup());

describe('the coverage of the state legislatures', () => {
  const index = makeStateLegislationIndex();
  const coverage = legislatureCoverage(index);

  it('adds up what was read of each legislature, and keeps those left out', () => {
    expect(coverage.get('la')).toMatchObject({ name: 'Louisiana', listed: 1, measuresRead: 1000, withoutSecureLink: 0, leftOut: null });
    expect(coverage.get('md')).toMatchObject({ name: 'Maryland', listed: 0, withoutSecureLink: 7 });
    expect(coverage.get('pr')?.leftOut).toMatch(/Spanish/);
  });

  it('says why a legislature has none listed, and never names California, which is read from its own data', () => {
    expect(whyNoneListed(coverage.get('la')!)).toBeNull();
    expect(whyNoneListed(coverage.get('md')!)).toMatch(/^Not listed yet: the selection rule picked 7 measures, but Open States gives no secure address/);
    expect(whyNoneListed(coverage.get('pr')!)).toBe('Not covered: Puerto Rico titles its measures in Spanish, which the rule does not read.');
    expect(whyNoneListed(coverage.get('ca')!)).toBeNull();
    expect(unlistedSummary(coverage)).toBe('The measures of Maryland are not listed yet: Open States gives no secure address of its legislature’s pages, and this site links only to secure pages (rule secure-link-1). Puerto Rico titles its measures in Spanish, which the rule does not read.');
    expect([...unlistedNotes(index).keys()].sort()).toEqual(['24', '72']);
  });

  it('joins names as a sentence does', () => {
    expect([listNames([]), listNames(['Maryland']), listNames(['Maryland', 'Vermont']), listNames(['Iowa', 'Maryland', 'Vermont'])])
      .toEqual(['', 'Maryland', 'Maryland and Vermont', 'Iowa, Maryland and Vermont']);
  });

  it('finds a state by its abbreviation in either case', () => {
    expect([stateFipsOfAbbr('la'), stateFipsOfAbbr('LA'), stateFipsOfAbbr('zz')]).toEqual(['22', '22', undefined]);
  });
});

describe('the list of every legislature', () => {
  const louisiana = makeStateMeasure();
  const all = [makeFederalBill(), makeBill(), louisiana];

  it('lists every state legislature together, or one of them, and Congress apart', () => {
    expect(filterBills(all, { jur: ALL_STATES }).map((b) => b.id).sort()).toEqual(['ca-99999999-zz1', 'os-la-2026rs-hb12']);
    expect(filterBills(all, { jur: 'la' }).map((b) => b.id)).toEqual(['os-la-2026rs-hb12']);
    expect([inJurisdiction(louisiana, 'us'), inJurisdiction(louisiana, ALL_STATES), inJurisdiction(louisiana, undefined)]).toEqual([false, true, true]);
  });

  it('applies a stage only within one legislature, never to every state at once', () => {
    expect(knownBillFilters({ jur: ALL_STATES, status: 'Passed one chamber' }, all)).toMatchObject({ jur: ALL_STATES, status: undefined });
    expect(knownBillFilters({ jur: 'la', status: 'Passed one chamber' }, all)).toMatchObject({ jur: 'la', status: 'Passed one chamber' });
    // A link that names a stage only one legislature uses is read as that legislature.
    expect(knownBillFilters({ status: 'Passed one chamber' }, all).jur).toBe('la');
  });

  it('counts the measures of each state’s own legislature for the map, leaving out those of Congress', () => {
    expect([...billStateCounts(all)].sort()).toEqual([['06', 1], ['22', 1]]);
  });

  it('finds a measure by the words the rule matched in its title', () => {
    expect(filterBills(all, { q: 'absentee voting' }).map((b) => b.id)).toEqual(['os-la-2026rs-hb12']);
  });
});

describe('a row of a state measure', () => {
  it('names the subject the legislature filed it under, when that is why it is listed', () => {
    const bill = makeStateMeasure({ title: 'Provides relative to public officials.', selection: { ruleId: 'state-select-1', matchedText: 'Elections--Election Officers (I0305)', matchedField: 'Subject', test: 'subject' } });
    const { container } = render(<ul><BillRow bill={bill} labels={new Map()} /></ul>);
    expect(screen.getByText(/Filed by the legislature under/).textContent).toBe('Filed by the legislature under Elections--Election Officers (I0305)');
    expect(container.querySelector('.row-title')?.textContent).toBe('LA HB 12 Provides relative to public officials.');
    expect(screen.getByText(/Stage reached/).textContent).toBe('Stage reached: Passed one chamber');
  });

  it('shows a long title around the words the rule matched, and marks them', () => {
    const long = `${'Relating to the exercise of eminent domain for public works and other matters, '.repeat(4)}requiring county elections before a taking.`;
    const bill = makeStateMeasure({ title: long, selection: { ruleId: 'state-select-1', matchedText: 'county elections', matchedField: 'Title', test: 'named' } });
    const { container } = render(<ul><BillRow bill={bill} labels={new Map()} /></ul>);
    const title = container.querySelector('.row-title')?.textContent ?? '';
    expect(title.length).toBeLessThan(long.length);
    expect(title).toMatch(/^LA HB 12 … /);
    expect(container.querySelector('mark.hit')?.textContent).toBe('county elections');
  });
});

describe('the page of a state measure', () => {
  it('draws the stages in the order of rule state-status-1, a veto in place of a signature', () => {
    expect(stageTrack('Passed one chamber', '22')).toEqual({
      steps: ['Introduced', 'Passed one chamber', 'Passed the legislature', 'Sent to the governor', 'Signed by the governor', 'Became law'], reached: 1,
    });
    expect(stageTrack('Vetoed', '22').steps).toEqual(['Introduced', 'Passed one chamber', 'Passed the legislature', 'Sent to the governor', 'Vetoed', 'Became law']);
    // A measure can become law without the governor's signature, so the track of one that did shows no signature.
    expect(stageTrack('Became law', '22')).toEqual({ steps: ['Introduced', 'Passed one chamber', 'Passed the legislature', 'Sent to the governor', 'Became law'], reached: 4 });
    // Nebraska's legislature has one chamber.
    expect(stageTrack('Introduced', '31').steps).not.toContain('Passed one chamber');
    expect(stageTrack('Not recorded', '22').reached).toBe(-1);
  });

  it('shows the kinds Open States gives an action in words, and the actions that move a measure first', () => {
    expect(actionKinds(['committee-passage-favorable', 'reading-2'])).toBe('committee passage favorable, reading 2');
    expect([isKeyAction(['passage']), isKeyAction(['executive-signature']), isKeyAction(['referral-committee']), isKeyAction([])]).toEqual([true, true, false, false]);
  });
});
