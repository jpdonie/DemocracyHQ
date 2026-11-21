import { describe, expect, it } from 'vitest';
import {
  csvCell, DISCLAIMER, GAP_NOTICE, PACK_FORMAT, packFileName, packForBill, packForCase, packForPlace, packToCsv, UNAVAILABLE_NOTICES, type SourcePack,
} from '../../src/lib/export';
import { DataError } from '../../src/lib/data';
import { GeoIndex } from '../../src/lib/geo';
import { buildPlacePack, type PlaceData } from '../../src/features/geography/placeData';
import { populationFor } from '../../src/lib/population';
import { VERIFICATION_LABELS } from '../../src/lib/verification';
import {
  makeBill, makeCase, makeEvent, makeFullBill, makeFullCase, makeGeoIndexFile, makeManifest, makePopulationFile, makeRedistricting,
  makeRelationship, makeSource, NOW, populationRow,
} from './fixtures';

const link = (hash: string) => `https://example.test/app/${hash}`;
const sources = [
  makeSource(),
  makeSource({ id: 'synthetic-legislature', name: 'Synthetic Legislature', url: 'https://example.test/leg' }),
  makeSource({ id: 'synthetic-census', name: 'Synthetic Census', url: 'https://example.test/census' }),
];
const base = { now: NOW, link, manifest: makeManifest(), sources };
const geo = new GeoIndex(makeGeoIndexFile());

/** A small RFC 4180 reader, used only to check that the CSV we write can be read back. */
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
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && body[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  return rows;
}

function placePack(key: string): SourcePack {
  const unit = geo.get(key)!;
  const cd119 = makePopulationFile({ '0601': populationRow(760000), '0602': populationRow(761000) });
  return packForPlace({
    ...base, unit, vintage: 'Synthetic vintage', geoSourceId: 'synthetic-census',
    cases: [{ record: makeCase(), relationship: makeRelationship(), via: 'statewide' }],
    bills: [makeBill()],
    events: [makeEvent()],
    population: populationFor(key, cd119, makeRedistricting()),
    billCoverageNote: 'Legislation is tracked for one state only.',
  });
}

describe('Legal Source Pack for a place', () => {
  const pack = placePack('cd120:0601');

  it('identifies itself, its subject and the data release it came from', () => {
    expect(pack.format).toBe(PACK_FORMAT);
    expect(pack.generatedAt).toBe(NOW);
    expect(pack.subject).toEqual({ type: 'place', id: 'cd120:0601', label: 'Congressional District 1, California', url: 'https://example.test/app/#/place/cd120:0601' });
    expect(pack.dataRelease).toEqual({ generatedAt: '2026-06-14T10:00:00Z', schemaVersion: 1 });
  });

  it('always carries the disclaimer and the data-gap notice, plus the coverage note', () => {
    expect(pack.notices).toEqual([DISCLAIMER, GAP_NOTICE, 'Legislation is tracked for one state only.']);
    expect(GAP_NOTICE).toMatch(/A data gap is not evidence of absence/);
    expect(DISCLAIMER).toMatch(/not legal advice/);
  });

  it('states the boundary vintage and GEOID of the place', () => {
    expect(pack.items[0]).toMatchObject({ section: 'subject', id: 'cd120:0601', detail: expect.stringContaining('Census GEOID 0601. Boundary vintage: Synthetic vintage.') });
  });

  it('names a territory a territory, not a state', () => {
    expect(placePack('state:78').items[0]!.detail).toBe('Territory. Census GEOID 78. Boundary vintage: Synthetic vintage.');
    expect(placePack('state:06').items[0]!.detail).toMatch(/^State\. /);
  });

  it('includes the population with its reference date, table and carry-over note', () => {
    const item = pack.items.find((i) => i.section === 'population')!;
    expect(item.date).toBe('2020-04-01');
    expect(item.dateMeaning).toBe('Census Day (reference date of the counts)');
    expect(item.detail).toContain('Total population (SYN_total): 760000.');
    // A race group is exported with the Bureau's full label, never as a bare "White alone".
    expect(item.detail).toMatch(/White alone, not Hispanic or Latino \(SYN_white\): \d+/);
    expect(item.detail).toContain('Synthetic.');
    expect(item.detail).toMatch(/Note: The Census Bureau reports no new boundaries/);
    expect(item.sourceName).toBe('Synthetic Census');
  });

  it('says "unavailable" with the reason when there is no compatible count', () => {
    const texas = placePack('cd120:4801').items.find((i) => i.section === 'population')!;
    expect(texas.verification).toBe('unavailable');
    expect(texas.verificationLabel).toBe('Unavailable');
    expect(texas.detail).toMatch(/^Unavailable\. The Census Bureau has not yet published/);
    expect(texas.date).toBeNull();
  });

  it('explains why each case is linked and how', () => {
    const caseItem = pack.items.find((i) => i.section === 'court_case')!;
    expect(caseItem.detail).toMatch(/^Linked to the whole state, not specifically to this unit\./);
    expect(caseItem.dateMeaning).toBe('Latest docket activity reported by the court');
    const why = pack.items.find((i) => i.section === 'link')!;
    expect(why.detail).toContain('Supporting text: “the State of Synthetic”');
    expect(why.sourceUrl).toBe('https://example.test/court/99-0001/petition.pdf');
  });

  it('gives every court, bill and text item a source link, a last-checked time and a verification state', () => {
    for (const item of pack.items.filter((i) => i.section === 'court_case' || i.section === 'legislation' || i.section === 'link')) {
      expect(item.sourceUrl, item.id).toMatch(/^https:\/\//);
      expect(item.lastCheckedAt, item.id).toBeTruthy();
      expect(item.verificationLabel, item.id).toBeTruthy();
    }
  });

  it('lists only the sources actually used, with licence and attribution', () => {
    expect(pack.sources.map((s) => s.id).sort()).toEqual(['synthetic-census', 'synthetic-court', 'synthetic-legislature']);
    expect(pack.sources.every((s) => s.license && s.attribution)).toBe(true);
  });

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(pack))).toEqual(pack);
  });
});

describe('Legal Source Pack for a case', () => {
  const pack = packForCase({ ...base, record: makeFullCase(), relationships: [makeRelationship()] });

  it('lists every docket entry with its own date', () => {
    const events = pack.items.filter((i) => i.section === 'event');
    expect(events.map((e) => e.date)).toEqual(['2026-01-05', '2026-02-01', '2026-03-01']);
    expect(events.every((e) => e.dateMeaning === 'Date of the docket entry')).toBe(true);
  });

  it('links an entry to its filed document when one is public, otherwise to the docket', () => {
    const events = pack.items.filter((i) => i.section === 'event');
    expect(events[0]!.sourceUrl).toBe('https://example.test/court/99-0001/petition.pdf');
    expect(events[1]!.sourceUrl).toBe('https://example.test/court/99-0001');
  });

  it('can be limited to major entries', () => {
    const major = packForCase({ ...base, record: makeFullCase(), relationships: [], majorOnly: true });
    expect(major.items.filter((i) => i.section === 'event')).toHaveLength(2);
  });

  it('says so when no ruling entry was identified, instead of implying the case is pending', () => {
    const pending = packForCase({ ...base, record: makeFullCase({ latestDispositiveEntry: null }), relationships: [] });
    expect(pending.items[0]!.detail).toBe('No ruling entry identified on the docket by DemocracyHQ’s rules.');
  });
});

describe('Legal Source Pack for a bill', () => {
  const pack = packForBill({ ...base, record: makeFullBill(), relationships: [], linkedCases: [makeCase()] });

  it('labels a date derived by rule as derived, not as verified against the source', () => {
    const urgent = packForBill({ ...base, record: makeFullBill({ effective: { date: '2026-05-01', basis: 'immediate_effect_flag', note: 'Flagged.' } }), relationships: [], linkedCases: [] });
    const effective = urgent.items.find((i) => i.id === 'ca-99999999-zz1:effective')!;
    expect(effective).toMatchObject({ date: '2026-05-01', verification: null, verificationLabel: 'Derived by rule from official data' });
  });

  it('quotes a condition found in the text next to the effective date', () => {
    const conditional = packForBill({
      ...base, relationships: [], linkedCases: [],
      record: makeFullBill({ conditions: [{ text: 'This act shall become operative only if a synthetic amendment is approved.', versionId: 'ZZV1', ruleId: 'ca-cond-1' }] }),
    });
    expect(conditional.items.find((i) => i.id === 'ca-99999999-zz1:effective')!.detail).toContain('“This act shall become operative only if a synthetic amendment is approved.” Whether this condition was met is not recorded in this dataset.');
  });

  it('gives every history row its own id, even when a date and sequence number repeat', () => {
    const record = makeFullBill();
    const twice = makeFullBill({ actions: [...record.actions, { ...record.actions[1]!, historyId: '103', text: 'Rescinded synthetic step.', status: 'Rescinded' }] });
    const ids = packForBill({ ...base, record: twice, relationships: [], linkedCases: [] }).items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ca-99999999-zz1:h103');
  });

  it('keeps legislative status, effective date and judicial enforceability as separate items', () => {
    expect(pack.items[0]!.detail).toMatch(/^Status as reported: Chaptered\./);
    const effective = pack.items.find((i) => i.id === 'ca-99999999-zz1:effective')!;
    expect(effective).toMatchObject({ title: 'Effective date', date: null, dateMeaning: null, verification: 'unavailable' });
    const courts = pack.items.find((i) => i.id === 'ca-99999999-zz1:courts')!;
    expect(courts.title).toBe('Judicial enforceability');
    expect(courts.detail).toMatch(/not evidence that none exists/);
  });

  it('does not present the chaptering date as the effective date', () => {
    const chaptered = pack.items.find((i) => i.title === 'Chaptered by the Secretary of State')!;
    expect(chaptered.date).toBe('2026-05-01');
    expect(pack.items.find((i) => i.id === 'ca-99999999-zz1:effective')!.date).toBeNull();
  });

  it('carries a condition in the bill text with the effective date, so the date never reads as unconditional', () => {
    const condition = makeRelationship({
      id: 'rel-synthetic-condition', source: { type: 'bill', id: 'ca-99999999-zz1' }, target: { type: 'bill', id: 'zz-2026-aca1' },
      relationshipType: 'operative_only_if', scope: { kind: 'statewide', note: 'Synthetic chapter operative only if the synthetic amendment is approved.' },
    });
    const conditional = packForBill({ ...base, record: makeFullBill(), relationships: [condition], linkedCases: [] });
    const detail = conditional.items.find((i) => i.id === 'ca-99999999-zz1:effective')!.detail!;
    expect(detail).toMatch(/Condition stated in the bill text: Synthetic chapter operative only if the synthetic amendment is approved\. The text reads: “the State of Synthetic” Whether this condition was met is not recorded in this dataset\.$/);
    expect(pack.items.find((i) => i.id === 'ca-99999999-zz1:effective')!.detail).not.toMatch(/Condition stated/);
  });

  it('says once that a condition is not recorded as met, and lists a condition quoted by a curated link once', () => {
    const quote = 'This chapter shall become operative only if a synthetic amendment is approved.';
    const condition = makeRelationship({
      id: 'rel-synthetic-condition', source: { type: 'bill', id: 'ca-99999999-zz1' }, target: { type: 'bill', id: 'zz-2026-aca1' },
      relationshipType: 'operative_only_if',
      scope: { kind: 'statewide', note: 'Synthetic chapter operative only if the synthetic amendment is approved. Whether these conditions were met is not recorded in this dataset.' },
      support: { url: 'https://example.test/leg/ab1', quote, sourceId: null },
    });
    const record = makeFullBill({
      effective: { date: '2026-05-01', basis: 'immediate_effect_flag', note: 'Flagged. The text also makes all or part of the measure conditional; the conditions are quoted on this page, and whether they were met is not recorded here.' },
      conditions: [{ text: quote, versionId: 'ZZV1', ruleId: 'ca-cond-1' }],
    });
    const detail = packForBill({ ...base, record, relationships: [condition], linkedCases: [] }).items.find((i) => i.id === 'ca-99999999-zz1:effective')!.detail!;
    expect(detail.match(/not recorded/g)).toHaveLength(1);
    expect(detail.split(quote)).toHaveLength(2);
    expect(detail).toBe(`Flagged. Condition stated in the bill text: Synthetic chapter operative only if the synthetic amendment is approved. The text reads: “${quote}” Whether this condition was met is not recorded in this dataset.`);
  });

  it('lists each text version with its hash, or says the text is not mirrored', () => {
    const versions = pack.items.filter((i) => i.section === 'text_version');
    expect(versions[0]!.detail).toBe(`Official subject line: not recorded. SHA-256 hash of the extracted text, not of the official file: ${'a'.repeat(64)}.`);
    expect(versions[1]!.detail).toMatch(/^Official subject line: not recorded\. Text not mirrored; see the official link\. Compared with the previous version: 1 paragraph\(s\) added or changed, 0 removed or replaced\.$/);
  });

  it('includes linked cases and their source', () => {
    expect(pack.items.some((i) => i.section === 'court_case' && i.id === 'synthetic-case-1')).toBe(true);
    expect(pack.sources.map((s) => s.id).sort()).toEqual(['synthetic-court', 'synthetic-legislature']);
  });
});

describe('CSV export', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hello", then\nleave')).toBe('"say ""hello"", then\nleave"');
    expect(csvCell(null)).toBe('""');
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    for (const dangerous of ['=HYPERLINK("https://example.test")', '+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(dangerous).startsWith(`"'`)).toBe(true);
    expect(csvCell('2026-01-05')).toBe('"2026-01-05"');
  });

  it('writes a header, one row per item, the notices, and reads back to the same values', () => {
    const pack = packForCase({
      ...base, relationships: [],
      record: makeFullCase({ caseName: 'Synthetic "Quoted", Inc. v. =Formula' }),
    });
    const csv = packToCsv(pack);
    expect(csv.startsWith('﻿')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
      'section', 'id', 'title', 'date', 'date_meaning', 'detail', 'source_name', 'source_url', 'last_checked_at', 'verification', 'democracyhq_url',
      'verification_method', 'verification_note', 'document_availability', 'document_availability_note', 'official_page_url_not_machine_checked',
    ]);
    expect(rows.slice(1, 1 + pack.items.length).map((r) => r[1])).toEqual(pack.items.map((i) => i.id));
    expect(rows[1]![2]).toBe('Synthetic "Quoted", Inc. v. =Formula, No. 99-0001 (U.S.)');
    expect(rows[1]![9]).toBe(VERIFICATION_LABELS.verified_primary);
    const tail = rows.slice(1 + pack.items.length).map((r) => r[0]);
    expect(tail).toContain(`Notice: ${GAP_NOTICE}`);
    expect(tail).toContain(`Notice: ${DISCLAIMER}`);
    expect(tail[tail.length - 1]).toBe(`Generated ${NOW} from https://example.test/app/#/litigation/synthetic-case-1`);
  });

  it('names files after the subject and the day', () => {
    expect(packFileName(placePack('cd120:0601'), 'csv')).toBe('democracyhq-source-pack-cd120-0601-2026-06-15.csv');
    expect(packFileName(placePack('cd120:0601'), 'json')).toMatch(/\.json$/);
  });
});

describe('a pack never leaves records out silently when a file could not be loaded', () => {
  it('a case pack says the links could not be loaded, and lists none', () => {
    const pack = packForCase({ ...base, record: makeFullCase(), relationships: null });
    expect(pack.notices).toContain(UNAVAILABLE_NOTICES.links);
    expect(pack.items.some((i) => i.section === 'link')).toBe(false);
    // With the links loaded there is no such notice.
    expect(packForCase({ ...base, record: makeFullCase(), relationships: [] }).notices).not.toContain(UNAVAILABLE_NOTICES.links);
  });

  it('a bill pack names a missing links file, or a missing case index when a case is linked', () => {
    expect(packForBill({ ...base, record: makeFullBill(), relationships: null, linkedCases: null }).notices).toContain(UNAVAILABLE_NOTICES.links);
    const caseLink = makeRelationship({ id: 'r-case', source: { type: 'case', id: 'synthetic-case-1' }, target: { type: 'bill', id: 'ca-99999999-zz1' }, relationshipType: 'case_challenges_bill' });
    const withoutIndex = packForBill({ ...base, record: makeFullBill(), relationships: [caseLink], linkedCases: null });
    expect(withoutIndex.notices).toContain(UNAVAILABLE_NOTICES.caseRecords);
    expect(withoutIndex.items.some((i) => i.id === 'r-case')).toBe(true);
    expect(packForBill({ ...base, record: makeFullBill(), relationships: [], linkedCases: null }).notices).not.toContain(UNAVAILABLE_NOTICES.caseRecords);
  });

  it('a place pack names each file that failed and keeps what did load', () => {
    const unit = geo.get('state:06')!;
    const pack = packForPlace({
      ...base, unit, vintage: 'v', geoSourceId: 'synthetic-census', cases: null, bills: [makeBill()], events: null,
      population: null, billCoverageNote: null, extraNotices: [UNAVAILABLE_NOTICES.population],
    });
    expect(pack.notices).toEqual(expect.arrayContaining([UNAVAILABLE_NOTICES.cases, UNAVAILABLE_NOTICES.events, UNAVAILABLE_NOTICES.population]));
    expect(pack.notices).not.toContain(UNAVAILABLE_NOTICES.bills);
    expect(pack.items.filter((i) => i.section === 'legislation')).toHaveLength(1);
  });

  it('a place pack names the file that failed when its cases could not be listed: the links or the case index', () => {
    const unit = geo.get('state:06')!;
    const data = (failedPath: string): PlaceData => ({
      unit, geo, vintage: 'v', geoSourceId: 'synthetic-census',
      population: { status: 'ready', data: { status: 'unavailable', reason: 'Not part of this test.' } },
      populationFile: null,
      cases: { status: 'error', error: new DataError('network', failedPath, `${failedPath} returned HTTP 503.`) },
      legislation: { status: 'ready', data: { bills: [makeBill()], covered: true } },
      events: { status: 'ready', data: [] },
      overlaps: null,
    });
    const links = buildPlacePack(data('relationships.json'), base)!;
    expect(links.notices).toContain(UNAVAILABLE_NOTICES.placeLinks);
    expect(links.notices).not.toContain(UNAVAILABLE_NOTICES.cases);
    expect(links.items.some((i) => i.section === 'court_case' || i.section === 'link')).toBe(false);
    const index = buildPlacePack(data('litigation/index.json'), base)!;
    expect(index.notices).toContain(UNAVAILABLE_NOTICES.cases);
    expect(index.notices).not.toContain(UNAVAILABLE_NOTICES.placeLinks);
  });

  it('a pack says when the list of sources could not be loaded, instead of an empty list of sources', () => {
    const casePack = packForCase({ ...base, sources: null, record: makeFullCase(), relationships: [] });
    expect(casePack.notices).toContain(UNAVAILABLE_NOTICES.sources);
    expect(casePack.sources).toEqual([]);
    // Each entry keeps its own source link; only the source's name, which comes from the list, is missing.
    expect(casePack.items[0]).toMatchObject({ sourceName: null, sourceUrl: makeFullCase().sourceUrl });
    expect(packToCsv(casePack)).toContain(`Notice: ${UNAVAILABLE_NOTICES.sources}`);
    expect(packForBill({ ...base, sources: null, record: makeFullBill(), relationships: [], linkedCases: [] }).notices).toContain(UNAVAILABLE_NOTICES.sources);
    const unit = geo.get('state:06')!;
    expect(packForPlace({
      ...base, sources: null, unit, vintage: 'v', geoSourceId: 'synthetic-census', cases: [], bills: [], events: [], population: null, billCoverageNote: null,
    }).notices).toContain(UNAVAILABLE_NOTICES.sources);
    // With the list loaded there is no such notice, and the sources are listed.
    const loaded = packForCase({ ...base, record: makeFullCase(), relationships: [] });
    expect(loaded.notices).not.toContain(UNAVAILABLE_NOTICES.sources);
    expect(loaded.sources.length).toBeGreaterThan(0);
  });
});
