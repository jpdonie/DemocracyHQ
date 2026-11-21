import { describe, expect, it } from 'vitest';
import { billsForPlace, casesForPlace, eventsForPlace, latestEvents, linkedStates, relationshipsForPlace, relationshipsForRecord, sameWords } from '../../src/lib/relations';
import { makeBill, makeCase, makeEvent, makeRelationship } from './fixtures';

const caseA = makeCase();
const caseB = makeCase({ id: 'synthetic-case-2', caseName: 'Synthetic Gamma v. Synthetic Delta', sourceLastActivity: '2026-05-01' });
const relationships = [
  makeRelationship(), // case 1 -> state:06, statewide
  makeRelationship({ id: 'rel-synthetic-2', source: { type: 'case', id: 'synthetic-case-2' }, target: { type: 'geography', id: 'cd120:0602' }, scope: { kind: 'congressional_district' } }),
  makeRelationship({ id: 'rel-synthetic-3', source: { type: 'bill', id: 'ca-99999999-zz1' }, target: { type: 'geography', id: 'state:06' } }),
  makeRelationship({ id: 'rel-synthetic-4', source: { type: 'case', id: 'synthetic-case-2' }, target: { type: 'bill', id: 'ca-99999999-zz1' } }),
  makeRelationship({ id: 'rel-synthetic-5', source: { type: 'case', id: 'synthetic-case-1' }, target: { type: 'geography', id: 'state:48' }, scope: { kind: 'multi_state' } }),
];

describe('links between records and places come only from published relationships', () => {
  it('a district sees its own links directly and statewide links as statewide', () => {
    const links = relationshipsForPlace('cd120:0602', relationships);
    expect(links.map((l) => [l.relationship.id, l.via])).toEqual([
      ['rel-synthetic-1', 'statewide'], ['rel-synthetic-2', 'direct'], ['rel-synthetic-3', 'statewide'],
    ]);
  });

  it('a different district of the same state does not inherit a district-specific link', () => {
    expect(relationshipsForPlace('cd120:0601', relationships).map((l) => l.relationship.id)).toEqual(['rel-synthetic-1', 'rel-synthetic-3']);
  });

  it('the same district number in the other Congress layer is a different place', () => {
    expect(relationshipsForPlace('cd119:0602', relationships).map((l) => l.via)).toEqual(['statewide', 'statewide']);
  });

  it('a state link that is not statewide in scope does not flow down to its counties', () => {
    expect(relationshipsForPlace('county:48201', relationships)).toEqual([]);
    expect(relationshipsForPlace('state:48', relationships).map((l) => l.via)).toEqual(['direct']);
  });

  it('a link to the state whose scope is one county is listed as inside the state, not as the whole state', () => {
    const located = makeRelationship({ id: 'rel-synthetic-6', relationshipType: 'located_in_state', target: { type: 'geography', id: 'state:48' }, scope: { kind: 'county', note: 'The county concerned is in this state.' } });
    expect(relationshipsForPlace('state:48', [located]).map((l) => l.via)).toEqual(['within']);
    expect(relationshipsForPlace('county:48167', [located])).toEqual([]);
    expect(relationshipsForPlace('county:48201', [located])).toEqual([]);
  });

  it('a state lists links to units inside it as "within"', () => {
    expect(relationshipsForPlace('state:06', relationships).map((l) => [l.relationship.id, l.via])).toEqual([
      ['rel-synthetic-1', 'direct'], ['rel-synthetic-2', 'within'], ['rel-synthetic-3', 'direct'],
    ]);
  });

  it('a state with no relationship has no linked case, whatever its courts or parties', () => {
    expect(casesForPlace('state:36', relationships, [caseA, caseB])).toEqual([]);
    expect(relationshipsForPlace('not-a-key', relationships)).toEqual([]);
  });

  it('lists each linked case once, direct links first', () => {
    const linked = casesForPlace('cd120:0602', relationships, [caseA, caseB]);
    expect(linked.map((l) => [l.record.id, l.via])).toEqual([['synthetic-case-2', 'direct'], ['synthetic-case-1', 'statewide']]);
    expect(linked[0]!.relationship.support.quote).toBeTruthy();
  });

  it('ignores a relationship whose case is not in the dataset', () => {
    expect(casesForPlace('state:06', relationships, [caseA]).map((l) => l.record.id)).toEqual(['synthetic-case-1']);
  });

  it('bills belong to their state', () => {
    const bills = [makeBill(), makeBill({ id: 'zz-2026-tx1', state: '48', stateAbbr: 'TX' })];
    expect(billsForPlace('county:06037', bills).map((b) => b.id)).toEqual(['ca-99999999-zz1']);
    expect(billsForPlace('cd120:4801', bills).map((b) => b.id)).toEqual(['zz-2026-tx1']);
    expect(billsForPlace('bogus', bills)).toEqual([]);
  });

  it('finds the relationships of a record in either direction', () => {
    expect(relationshipsForRecord('bill', 'ca-99999999-zz1', relationships).map((r) => r.id)).toEqual(['rel-synthetic-3', 'rel-synthetic-4']);
    expect(relationshipsForRecord('case', 'synthetic-case-2', relationships).map((r) => r.id)).toEqual(['rel-synthetic-2', 'rel-synthetic-4']);
  });

  it('counts distinct linked records per state', () => {
    const counts = linkedStates(relationships);
    expect(counts.get('06')).toBe(3);
    expect(counts.get('48')).toBe(1);
    expect(linkedStates(relationships, 'bill').get('06')).toBe(1);
    expect(linkedStates(relationships, 'case').has('36')).toBe(false);
  });
});

describe('"What changed here?" timeline', () => {
  const events = [
    makeEvent(),
    makeEvent({ id: 'ev-synthetic-2', date: '2026-05-01', category: 'legislation', entityType: 'bill', entityId: 'ca-99999999-zz1', geoKeys: ['state:06'] }),
    makeEvent({ id: 'ev-synthetic-3', date: '2026-04-01', geoKeys: ['cd120:0602'] }),
    makeEvent({ id: 'ev-synthetic-4', date: '2026-02-01', category: 'geography', geoKeys: ['state:48'] }),
  ];

  it('orders events newest first and labels how each reaches the place', () => {
    expect(eventsForPlace('cd120:0602', events).map((e) => [e.id, e.via])).toEqual([
      ['ev-synthetic-2', 'statewide'], ['ev-synthetic-3', 'direct'], ['ev-synthetic-1', 'statewide'],
    ]);
    expect(eventsForPlace('state:06', events).map((e) => [e.id, e.via])).toEqual([
      ['ev-synthetic-2', 'direct'], ['ev-synthetic-3', 'within'], ['ev-synthetic-1', 'direct'],
    ]);
  });

  it('filters by category and by inclusive dates', () => {
    expect(eventsForPlace('state:06', events, { categories: ['legislation'] }).map((e) => e.id)).toEqual(['ev-synthetic-2']);
    expect(eventsForPlace('state:06', events, { from: '2026-04-01', to: '2026-04-01' }).map((e) => e.id)).toEqual(['ev-synthetic-3']);
    expect(eventsForPlace('state:06', events, { categories: [] })).toEqual([]);
  });

  it('shows nothing for a place no event names', () => {
    expect(eventsForPlace('state:36', events)).toEqual([]);
    expect(eventsForPlace('county:48201', events).map((e) => e.id)).toEqual(['ev-synthetic-4']);
  });
});

describe('sameWords', () => {
  const quote = 'Section 14034 is added to the Elections Code, to read: […] This section shall take effect only if Senate Bill 1360 of the 2025–26 Regular Session does not take effect on or before January 1, 2027.';
  it('treats a found condition as already quoted when one part of a curated quotation says it, ignoring a leading subdivision letter', () => {
    expect(sameWords(quote, '(b) This section shall take effect only if Senate Bill 1360 of the 2025–26 Regular Session does not take effect on or before January 1, 2027.')).toBe(true);
  });
  it('keeps a different condition apart', () => {
    expect(sameWords(quote, 'This act shall become operative only if Senate Bill 42 is approved by the voters.')).toBe(false);
    expect(sameWords(quote, '')).toBe(false);
  });
});

describe('latest dated events', () => {
  const boundary = (fips: string) => makeEvent({
    id: `geo-synthetic-${fips}`, date: '2026-06-01', category: 'geography', eventType: 'boundary_files_updated', entityType: 'geography',
    entityId: `state:${fips}`, entityLabel: `Synthetic ${fips} districts`, description: 'Synthetic boundary file dated.', geoKeys: [`state:${fips}`],
  });
  const bill = (n: number) => makeEvent({ id: `bill-synthetic-${n}`, date: `2026-05-${String(10 + n).padStart(2, '0')}`, category: 'legislation', entityType: 'bill', entityId: `zz-${n}` });
  const court = (n: number) => makeEvent({ id: `case-synthetic-${n}`, date: `2026-04-${String(10 + n).padStart(2, '0')}` });
  const events = [...['06', '48', '12'].map(boundary), ...[1, 2, 3, 4].map(bill), ...[1, 2, 3, 4].map(court)];

  it('folds same-day boundary entries with the same text into one row', () => {
    const rows = latestEvents(events, 3);
    const boundaries = rows.filter((r) => r.category === 'geography');
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.group!.map((e) => e.entityId).sort()).toEqual(['state:06', 'state:12', 'state:48']);
  });

  it('keeps room for every kind of record, newest first', () => {
    const rows = latestEvents(events, 3);
    expect(rows.map((r) => r.category)).toEqual(['geography', 'legislation', 'legislation', 'legislation', 'litigation', 'litigation', 'litigation']);
    expect(rows.map((r) => r.id).slice(1, 4)).toEqual(['bill-synthetic-4', 'bill-synthetic-3', 'bill-synthetic-2']);
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort().reverse());
  });

  it('does not fold court or legislative entries, or boundary entries that differ', () => {
    const sameDay = [court(1), { ...court(1), id: 'case-synthetic-1b' }, boundary('06'), { ...boundary('48'), description: 'A different text.' }];
    const rows = latestEvents(sameDay, 5);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => !r.group)).toBe(true);
  });
});
