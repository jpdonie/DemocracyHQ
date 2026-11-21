import { describe, expect, it } from 'vitest';
import { caseStates, countBy, filterBills, filterCases, identifierParts, isoDateParam, knownBillFilters, knownCaseFilters, knownValue, normalizeText, positiveInt } from '../../src/lib/filters';
import { makeAppealsCase, makeBill, makeCase, makeFederalBill } from './fixtures';

const cases = [
  makeCase(),
  makeCase({
    id: 'synthetic-case-2', caseName: 'Synthetic Gámma v. Synthetic Delta', docketNumber: '99-0002', stateFips: ['48'],
    petitionerTitle: 'Synthetic Gámma, Petitioner', respondentTitle: 'Synthetic Delta',
    sourceLastActivity: '2026-04-15', dateDocketed: '2025-12-01', latestDispositiveEntry: null,
    issueTags: [{ tag: 'voter-id', ruleId: 'r', matchedField: 'f', matchedText: 't' }],
    lowerCourt: { name: 'Synthetic Court of Appeals', caseNumbers: ['25-9999'], decisionDate: null, rehearingDeniedDate: null },
  }),
  makeCase({ id: 'synthetic-case-3', caseName: 'In re Synthetic Epsilon', docketNumber: '99A003', stateFips: [], sourceLastActivity: null, dateDocketed: null, latestDispositiveEntry: null, issueTags: [] }),
];

describe('normalizeText', () => {
  it('lower-cases, strips accents and collapses whitespace', () => {
    expect(normalizeText('  Gámma   V.\nDELTA ')).toBe('gamma v. delta');
  });
});

describe('filterCases', () => {
  it('returns everything, newest activity first, when no filter is set', () => {
    expect(filterCases(cases, {}).map((c) => c.id)).toEqual(['synthetic-case-2', 'synthetic-case-1', 'synthetic-case-3']);
  });

  it('matches every word of the query across name, docket number and lower-court numbers', () => {
    expect(filterCases(cases, { q: 'gamma delta' }).map((c) => c.id)).toEqual(['synthetic-case-2']);
    expect(filterCases(cases, { q: '99-0001' }).map((c) => c.id)).toEqual(['synthetic-case-1']);
    expect(filterCases(cases, { q: '25-9999' }).map((c) => c.id)).toEqual(['synthetic-case-2']);
    expect(filterCases(cases, { q: 'alpha delta' })).toEqual([]);
  });

  it('reads the passage quoted on what a case is about, as the row shows it', () => {
    const quoted = [...cases, makeCase({ id: 'synthetic-case-4', caseName: 'Synthetic Zeta v. Synthetic Eta', docketNumber: '99-0004', about: {
      text: 'Whether a county may reject a mail-in ballot that arrives in an undated envelope.', source: 'question-presented', cut: false, ruleId: 'about-question-1' } })];
    expect(filterCases(quoted, { q: 'undated envelope' }).map((c) => c.id)).toEqual(['synthetic-case-4']);
    expect(filterCases(quoted, { q: 'zeta mail-in' }).map((c) => c.id)).toEqual(['synthetic-case-4']);
    expect(filterCases(quoted, { q: 'undated postcard' })).toEqual([]);
  });

  it('filters by issue tag and by linked state', () => {
    expect(filterCases(cases, { tag: 'voter-id' }).map((c) => c.id)).toEqual(['synthetic-case-2']);
    expect(filterCases(cases, { state: '06' }).map((c) => c.id)).toEqual(['synthetic-case-1']);
    expect(filterCases(cases, { state: '36' })).toEqual([]);
  });

  it('filters by the type of the latest ruling entry, with "none" for dockets that have none', () => {
    expect(filterCases(cases, { ruling: 'cert_denied' }).map((c) => c.id)).toEqual(['synthetic-case-1']);
    expect(filterCases(cases, { ruling: 'none' }).map((c) => c.id)).toEqual(['synthetic-case-2', 'synthetic-case-3']);
  });

  it('applies inclusive date limits and leaves out records with no activity date when a range is set', () => {
    expect(filterCases(cases, { from: '2026-03-01', to: '2026-03-01' }).map((c) => c.id)).toEqual(['synthetic-case-1']);
    expect(filterCases(cases, { from: '2026-03-02' }).map((c) => c.id)).toEqual(['synthetic-case-2']);
    expect(filterCases(cases, { to: '2026-12-31' }).map((c) => c.id)).not.toContain('synthetic-case-3');
  });

  it('sorts by name or by docketing date on request', () => {
    expect(filterCases(cases, { sort: 'name' }).map((c) => c.id)).toEqual(['synthetic-case-3', 'synthetic-case-1', 'synthetic-case-2']);
    // A case without a docketing date is ordered by the first entry the source holds (2026-01-05 here).
    expect(filterCases(cases, { sort: 'docketed' }).map((c) => c.id)).toEqual(['synthetic-case-1', 'synthetic-case-3', 'synthetic-case-2']);
  });

  it('filters by court: one court of appeals, all of them, or the Supreme Court', () => {
    const mixed = [...cases, makeAppealsCase(), makeAppealsCase({ id: 'ca5-99-00002', courtId: 'ca5', origin: null })];
    expect(filterCases(mixed, { court: 'ca9' }).map((c) => c.id)).toEqual(['ca9-99-00001']);
    expect(filterCases(mixed, { court: 'appeals' }).map((c) => c.id).sort()).toEqual(['ca5-99-00002', 'ca9-99-00001']);
    expect(filterCases(mixed, { court: 'scotus' })).toHaveLength(3);
    expect(filterCases(mixed, { court: 'cafc' })).toEqual([]);
  });

  it('lists an appeal under the state of the district court it came from', () => {
    const appeal = makeAppealsCase();
    expect(caseStates(appeal)).toEqual(['06']);
    expect(filterCases([appeal], { state: '06' })).toHaveLength(1);
    expect(filterCases([appeal], { state: '48' })).toEqual([]);
    expect(knownCaseFilters({ court: 'cafc' }, [appeal]).court).toBe('cafc');
    expect(knownCaseFilters({ court: 'ca99' }, [appeal]).court).toBeUndefined();
  });

  it('does not change the list it was given', () => {
    const before = cases.map((c) => c.id);
    filterCases(cases, { sort: 'name' });
    expect(cases.map((c) => c.id)).toEqual(before);
  });
});

const bills = [
  makeBill(),
  makeBill({ id: 'zz-2026-ab10', identifier: 'AB 10', subject: 'Voter registration: synthetic.', legislativeStatus: { measureState: 'Amended Assembly', currentStatus: 'In Committee Process' }, lastActionDate: '2026-06-01', introducedDate: '2026-02-01', issueTags: [], chapter: null }),
  makeBill({ id: 'zz-2026-sb2', identifier: 'SB 2', measureType: 'SB', subject: 'Recall elections: synthetic.', legislativeStatus: { measureState: 'Introduced', currentStatus: null }, lastActionDate: null, introducedDate: '2026-01-02', issueTags: [], chapter: null }),
];

describe('filterBills', () => {
  it('finds a bill by its number with or without the space', () => {
    expect(filterBills(bills, { q: 'ab10' }).map((b) => b.id)).toEqual(['zz-2026-ab10']);
    expect(filterBills(bills, { q: 'AB 10' }).map((b) => b.id)).toEqual(['zz-2026-ab10']);
  });

  it('reads the quoted summary and the title the selection rule matched, as the row shows them', () => {
    const veterans = makeFederalBill({
      id: 'us-119-s9002', identifier: 'S. 9002', subject: 'Synthetic Veterans Advisory Committee Act',
      selection: { ruleId: 'us-select-1', matchedText: 'Voter Eligibility', matchedField: 'Short Title(s) as Passed House', matchedTitle: 'Synthetic Voter Eligibility Act' },
      about: { text: 'This bill requires synthetic proof of citizenship when registering to vote.', source: 'crs-summary', cut: false, ruleId: 'about-crs-1' },
    });
    expect(filterBills([...bills, veterans], { q: 'proof of citizenship' }).map((b) => b.id)).toEqual(['us-119-s9002']);
    expect(filterBills([...bills, veterans], { q: 'voter eligibility' }).map((b) => b.id)).toEqual(['us-119-s9002']);
    expect(filterBills([...bills, veterans], { q: 'veterans citizenship' }).map((b) => b.id)).toEqual(['us-119-s9002']);
  });

  it('filters by the status exactly as the legislature reports it, including "Not recorded"', () => {
    expect(filterBills(bills, { status: 'Chaptered' }).map((b) => b.id)).toEqual(['ca-99999999-zz1']);
    expect(filterBills(bills, { status: 'Not recorded' }).map((b) => b.id)).toEqual(['zz-2026-sb2']);
  });

  it('filters on the measure\'s status, not on the state of its latest text version', () => {
    expect(filterBills(bills, { status: 'In Committee Process' }).map((b) => b.id)).toEqual(['zz-2026-ab10']);
    expect(filterBills(bills, { status: 'Amended Assembly' })).toEqual([]);
    expect(filterBills(bills, { status: 'Introduced' })).toEqual([]);
  });

  it('filters by measure type and tag', () => {
    expect(filterBills(bills, { type: 'SB' }).map((b) => b.id)).toEqual(['zz-2026-sb2']);
    expect(filterBills(bills, { tag: 'mail-voting' }).map((b) => b.id)).toEqual(['ca-99999999-zz1']);
  });

  it('orders bill numbers naturally (AB 1, AB 10, SB 2), not as text', () => {
    expect(filterBills(bills, { sort: 'number' }).map((b) => b.identifier)).toEqual(['AB 1', 'AB 10', 'SB 2']);
    expect(identifierParts('acr 12')).toEqual(['ACR', 12]);
    expect(identifierParts('Proposition')).toEqual(['Proposition', 0]);
  });

  it('puts bills with no recorded action date last when sorting by action', () => {
    expect(filterBills(bills, {}).map((b) => b.id)).toEqual(['zz-2026-ab10', 'ca-99999999-zz1', 'zz-2026-sb2']);
  });
});

describe('countBy', () => {
  it('counts each record once per distinct value and orders by count then name', () => {
    const counts = countBy(cases, (c) => c.issueTags.map((t) => t.tag).concat(c.issueTags.map((t) => t.tag)));
    expect(counts).toEqual([{ value: 'redistricting', count: 1 }, { value: 'voter-id', count: 1 }]);
  });
});

describe('query values typed or pasted into the address', () => {
  it('a count such as show= is a positive whole number, or the default', () => {
    expect(positiveInt('160', 60)).toBe(160);
    expect(positiveInt(undefined, 60)).toBe(60);
    for (const bad of ['-5', '0', '1.5', 'abc', '1e3', ' 7', '', '99999999']) expect(positiveInt(bad, 60), bad).toBe(60);
  });

  it('a date filter is a calendar date or nothing', () => {
    expect(isoDateParam('2026-01-31')).toBe('2026-01-31');
    for (const bad of ['2026-1-31', 'yesterday', '2026-01-31T00:00', '']) expect(isoDateParam(bad), bad).toBeUndefined();
  });

  it('a date filter is a date that exists, as a date field would accept it', () => {
    for (const good of ['2024-02-29', '2026-12-31', '0050-06-01', '9999-12-31']) expect(isoDateParam(good), good).toBe(good);
    for (const bad of ['2020-02-31', '2099-13-45', '2026-02-29', '2026-04-31', '2026-00-10', '2026-01-00', '0000-01-01']) {
      expect(isoDateParam(bad), bad).toBeUndefined();
    }
    expect(knownCaseFilters({ from: '2020-02-31', to: '2099-13-45' }, cases)).toMatchObject({ from: undefined, to: undefined });
  });

  it('a menu value that is not one of the choices is not applied', () => {
    expect(knownValue('a', ['a', 'b'])).toBe('a');
    expect(knownValue('c', ['a', 'b'])).toBeUndefined();
    expect(knownValue(undefined, ['a'])).toBeUndefined();
    // '__proto__' and similar strings are just unknown values.
    expect(knownValue('__proto__', ['a'])).toBeUndefined();
  });

  it('drops an unknown issue, state or ruling from the case filters, so the list is not emptied by a filter the menu cannot show', () => {
    const known = knownCaseFilters({ q: 'x', tag: 'foo', state: '99', ruling: 'made_up', from: 'soon', to: '2026-12-31', sort: 'name' }, cases);
    expect(known).toEqual({ q: 'x', tag: undefined, state: undefined, ruling: undefined, from: undefined, to: '2026-12-31', sort: 'name' });
    expect(filterCases(cases, knownCaseFilters({ tag: 'foo' }, cases))).toHaveLength(cases.length);
    // Known values pass through unchanged, including the "none identified" ruling choice.
    expect(knownCaseFilters({ tag: 'voter-id', state: '48', ruling: 'none' }, cases)).toMatchObject({ tag: 'voter-id', state: '48', ruling: 'none' });
    expect(knownCaseFilters({ ruling: 'cert_denied' }, cases).ruling).toBe('cert_denied');
  });

  it('drops an unknown issue, status or measure type from the bill filters', () => {
    const bills = [makeBill(), makeBill({ id: 'zz-2', measureType: 'SB', legislativeStatus: { measureState: null, currentStatus: null, currentHouse: null, currentLocation: null } })];
    expect(knownBillFilters({ tag: 'nope', status: 'Enacted', type: 'XYZ' }, bills)).toEqual({ tag: undefined, status: undefined, type: undefined });
    // A status and a type belong to one legislature; a link without one is read as the only legislature that uses them.
    expect(knownBillFilters({ tag: 'mail-voting', status: 'Not recorded', type: 'SB' }, bills)).toEqual({ jur: 'ca', tag: 'mail-voting', status: 'Not recorded', type: 'SB' });
  });

  it('keeps a status only within one legislature, and filters measures of Congress by "us"', () => {
    const both = [makeBill(), makeFederalBill()];
    expect(knownBillFilters({ jur: 'us', status: 'Passed the House' }, both)).toEqual({ jur: 'us', status: 'Passed the House', tag: undefined, type: undefined });
    expect(knownBillFilters({ jur: 'us', status: 'Chaptered' }, both).status).toBeUndefined();
    expect(knownBillFilters({ jur: 'tx' }, both).jur).toBeUndefined();
    expect(filterBills(both, { jur: 'us' }).map((b) => b.id)).toEqual(['us-119-hr9001']);
    expect(filterBills(both, { sort: 'number' }).map((b) => b.id)).toEqual(['us-119-hr9001', 'ca-99999999-zz1']);
  });
});
