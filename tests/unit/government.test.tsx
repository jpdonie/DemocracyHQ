// @vitest-environment jsdom
/**
 * Who holds office: the rules worked out a second time from the published parts, the words the site finds for a
 * government, the party map, and the block that shows the parts. Every figure and name here is invented.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlTally, WhoGoverns } from '../../src/components/WhoGoverns';
import {
  GovernmentIndex, controlOf, controlSummary, controlTally, leadBySeats, majorityMark, seatLine, seatSegments, whyUndetermined,
} from '../../src/lib/government';
import { PARTY_CLASSES, contrastRatio, partyControlTheme } from '../../src/lib/mapTheme';
import { mapQuery } from '../../src/lib/router';
import { GovernmentFileSchema, type ChamberSeats, type Government, type OfficeHolder, type PartySeats } from '../../src/types/schemas';
import { makeSource } from './fixtures';

afterEach(cleanup);

const T = '2026-06-01T10:00:00Z';
const NAMES: Record<string, string> = { R: 'Republican', D: 'Democratic', I: 'Independent', N: 'Nonpartisan' };

function party(group: PartySeats['group'], seats: number, name = NAMES[group] ?? 'Forward'): PartySeats {
  return { group, name, seats, labels: [{ label: name, seats }] };
}

function chamber(key: ChamberSeats['chamber'], name: string, seats: number | null, parties: PartySeats[], over: Partial<ChamberSeats> = {}): ChamberSeats {
  const members = parties.reduce((total, entry) => total + entry.seats, 0);
  const made: ChamberSeats = {
    chamber: key, name, members, seats, vacant: seats === null ? null : seats - members, parties, lead: null, leadBasis: 'seats', note: null,
    sourceId: 'openstates-people', sourceUrl: 'https://data.example.org/people/zz.csv', asOf: '2026-05-29', checkedAt: T, ruleId: 'party-seats-1',
  };
  return { ...made, lead: leadBySeats(made), ...over };
}

function governor(group: OfficeHolder['group'], partyName = NAMES[group] ?? 'Forward'): OfficeHolder {
  return { office: 'Governor', name: 'Synthetic Governor', party: partyName, group, termStarted: '2023-01-07', sourceId: 'nga-governors', sourceUrl: 'https://www.example.org/governors/zz/', checkedAt: T };
}

function state(id: string, name: string, executive: OfficeHolder | null, chambers: ChamberSeats[], over: Partial<Government> = {}): Government {
  const made: Government = { id, name, control: 'undetermined', executive, executiveNote: executive ? null : 'No governor was read for this state.', chambers, missingChambers: [], ruleId: 'party-trifecta-1', ...over };
  return { ...made, control: over.control ?? controlOf(made) };
}

const senate = (r: number, d: number, seats = 40, extra: PartySeats[] = []) => chamber('upper', 'Senate', seats, [party('R', r), party('D', d), ...extra].filter((entry) => entry.seats > 0));
const house = (r: number, d: number, seats = 100, extra: PartySeats[] = []) => chamber('lower', 'House', seats, [party('R', r), party('D', d), ...extra].filter((entry) => entry.seats > 0));

const RED = state('state:01', 'Alabama', governor('R'), [senate(27, 13), house(70, 30)]);
const BLUE = state('state:06', 'California', governor('D'), [senate(10, 30), house(38, 62)]);
const SPLIT = state('state:20', 'Kansas', governor('D'), [senate(31, 9), house(88, 12)]);
const NEBRASKA = state('state:31', 'Nebraska', governor('R'), [chamber('legislature', 'Nebraska Legislature', 49, [party('N', 49)])]);
const NATION: Government = {
  id: 'nation:US', name: 'United States', control: 'undetermined', executive: null,
  executiveNote: 'The Presidency is not part of this view yet: none of the sources read here names the President’s party.',
  chambers: [
    chamber('upper', 'Senate', 100, [party('R', 53), party('D', 45), party('I', 2)], { sourceId: 'senate-members', sourceUrl: 'https://www.example.gov/senators.xml' }),
    chamber('lower', 'House of Representatives', 435, [party('R', 218), party('D', 214), party('I', 1)], { lead: 'R', leadBasis: 'stated', sourceId: 'house-clerk-members', sourceUrl: 'https://clerk.example.gov/members.xml' }),
  ],
  missingChambers: [], ruleId: 'party-trifecta-1',
};

describe('the rules, worked out again from the published parts', () => {
  it('gives a chamber to a party only with more than half of all seats', () => {
    expect(leadBySeats(senate(21, 19))).toBe('R');
    expect(leadBySeats(senate(19, 21))).toBe('D');
    expect(leadBySeats(senate(20, 20))).toBeNull();
    expect(leadBySeats(senate(20, 19))).toBeNull(); // twenty of forty seats, with one vacant
    expect(leadBySeats(chamber('upper', 'Senate', null, [party('R', 41)]))).toBeNull();
    expect(majorityMark(senate(21, 19))).toBe(21);
    expect(majorityMark(house(51, 50, 101))).toBe(51);
  });

  it('gives a government to a party only with the executive and every chamber', () => {
    expect([RED, BLUE, SPLIT].map((record) => record.control)).toEqual(['R', 'D', 'divided']);
    expect(controlOf({ ...RED, chambers: [senate(27, 13), house(50, 50)] })).toBe('divided');
    expect(controlOf({ ...RED, executive: governor('I') })).toBe('divided');
  });

  it('does not determine a government with a part that is missing, mismatched or without party labels', () => {
    expect(controlOf(NEBRASKA)).toBe('undetermined');
    expect(controlOf({ ...RED, executive: null })).toBe('undetermined');
    expect(controlOf({ ...RED, chambers: [] })).toBe('undetermined');
    expect(controlOf({ ...RED, chambers: [senate(27, 13)], missingChambers: ['lower'] })).toBe('undetermined');
    expect(controlOf({ ...RED, chambers: [senate(27, 13), chamber('lower', 'House', null, [party('R', 101)])] })).toBe('undetermined');
  });

  it('counts the fifty states by what they are shown as', () => {
    expect(controlTally([RED, BLUE, SPLIT, NEBRASKA, RED])).toEqual({ R: 2, D: 1, divided: 1, undetermined: 1 });
  });
});

describe('the words for a government', () => {
  it('names the parts a party holds', () => {
    expect(controlSummary(RED)).toBe('Republican governor and legislature');
    expect(controlSummary(SPLIT)).toBe('Democratic governor; Republican Senate and House');
    expect(controlSummary(state('state:55', 'Wisconsin', governor('D'), [senate(22, 18), house(45, 55)]))).toBe('Democratic governor and House; Republican Senate');
    expect(controlSummary({ ...NATION, control: 'R', executive: { ...governor('R'), office: 'President' } })).toBe('Republican President, Senate and House of Representatives');
  });

  it('says where no party holds more than half, and keeps the label of a governor of another party', () => {
    const tied = state('state:27', 'Minnesota', governor('D'), [senate(20, 20), house(40, 60)]);
    expect(controlSummary(tied)).toBe('Democratic governor and House; no party holds more than half of the Senate');
    expect(controlSummary(state('state:02', 'Alaska', governor('I'), [senate(27, 13), house(70, 30)]))).toBe('Independent governor; Republican Senate and House');
  });

  it('gives each reason a government is not determined', () => {
    expect(whyUndetermined(NEBRASKA)).toBe('The members of the Nebraska Legislature are elected without party labels.');
    expect(whyUndetermined(NATION)).toContain('none of the sources read here names the President’s party');
    expect(whyUndetermined({ ...RED, control: 'undetermined', chambers: [senate(27, 13)], missingChambers: ['lower'] })).toBe('No source could be read for the lower chamber.');
    expect(whyUndetermined({ ...RED, chambers: [chamber('upper', 'Senate', null, [party('R', 41)])] })).toBe('The source lists more members of the Senate than it has seats, so no majority is worked out.');
  });

  it('draws Democratic seats from the left and Republican seats from the right, the others between', () => {
    const made = chamber('upper', 'Senate', 40, [party('R', 19), party('D', 17), party('I', 2), party('O', 1, 'Forward')]);
    expect(seatSegments(made).map((segment) => [segment.kind, segment.seats])).toEqual([['D', 17], ['other', 2], ['other', 1], ['vacant', 1], ['R', 19]]);
    expect(seatLine(made)).toBe('Republican 19, Democratic 17, Independent 2, Forward 1, vacant 1');
  });
});

describe('the party map', () => {
  const theme = partyControlTheme([NATION, RED, BLUE, SPLIT, NEBRASKA]);

  it('colours a state only by what its record says, and hatches the rest', () => {
    expect([...theme.classOf]).toEqual([['01', 0], ['06', 1], ['20', 2]]);
    expect(theme.classes.map((item) => item.token)).toEqual(['--party-r', '--party-d', '--party-split']);
    expect(theme.hatch).toEqual({ geoids: 'rest', label: 'Not determined, or not covered (the District of Columbia and the territories)' });
    expect(theme.layer).toBe('state');
  });

  it('says for each state which parts a party holds, or why none is shown', () => {
    expect(theme.detailOf?.get('20')).toBe('Democratic governor; Republican Senate and House');
    expect(theme.detailOf?.get('31')).toBe('Not determined. The members of the Nebraska Legislature are elected without party labels.');
    expect(theme.detailOf?.has('US')).toBe(false);
  });

  it('changes its identity when a state changes hands', () => {
    expect(partyControlTheme([RED, BLUE]).id).not.toBe(partyControlTheme([{ ...RED, control: 'divided' }, BLUE]).id);
  });

  it('uses three fills that can be told apart, each from the others and from the land', () => {
    // Read from the folder the tests are run in: under jsdom the address of this module is not a file address.
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    const color = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)![1]!;
    const [red, blue, split] = PARTY_CLASSES.map((item) => color(item.token));
    const land = color('--land');
    for (const fill of [red!, blue!]) {
      expect(contrastRatio(fill, land)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fill, split!)).toBeGreaterThanOrEqual(2.5);
    }
    // Red and blue differ in hue, not in lightness; each also names its party in words wherever it is used.
    expect(red).not.toBe(blue);
  });
});

describe('the address keeps the party shading from state to state', () => {
  it('carries the party shading and nothing else', () => {
    expect(mapQuery({ shade: 'party', tab: 'timeline', q: 'x' })).toEqual({ shade: 'party' });
    expect(mapQuery({ shade: 'population', layer: 'county' })).toEqual({});
    expect(mapQuery({})).toEqual({});
  });
});

describe('the published file', () => {
  it('is read through its schema, and found by the key of a map unit', () => {
    const file = GovernmentFileSchema.parse({ generatedAt: T, governments: [NATION, RED, BLUE] });
    const index = new GovernmentIndex(file);
    expect(index.nation?.name).toBe('United States');
    expect(index.get('state:06')?.control).toBe('D');
    expect(index.get('state:11')).toBeUndefined();
    expect(index.states.map((record) => record.id)).toEqual(['state:01', 'state:06']);
  });

  it('is refused without the list of missing chambers or with an unknown control', () => {
    const { missingChambers: _omitted, ...without } = RED;
    expect(GovernmentFileSchema.safeParse({ generatedAt: T, governments: [without] }).success).toBe(false);
    expect(GovernmentFileSchema.safeParse({ generatedAt: T, governments: [{ ...RED, control: 'lean R' }] }).success).toBe(false);
  });
});

describe('the block that shows who governs', () => {
  const sources = [makeSource({ id: 'nga-governors', authority: 'Synthetic Governors Association' }), makeSource({ id: 'openstates-people', authority: 'Synthetic Aggregator' })];

  it('names the party of every part in words, with the seats as figures', () => {
    render(<WhoGoverns record={SPLIT} sources={sources} />);
    expect(screen.getByText('Divided government')).toBeTruthy();
    expect(screen.getByText('Democratic governor; Republican Senate and House')).toBeTruthy();
    const parts = within(screen.getByRole('list', { name: 'The offices of Kansas by party' })).getAllByRole('listitem');
    expect(parts).toHaveLength(3);
    expect(parts[0]!.textContent).toContain('Governor');
    expect(parts[0]!.textContent).toContain('Democratic');
    expect(parts[0]!.textContent).toContain('Synthetic Governor');
    expect(parts[1]!.textContent).toContain('Republican majority');
    expect(within(parts[1]!).getByText('Republican 31')).toBeTruthy();
    expect(within(parts[1]!).getByText('Democratic 9')).toBeTruthy();
    expect(parts[1]!.textContent).toContain('40 seats; more than half is 21.');
  });

  it('keeps the bar out of the reading order: the same figures stand beside it as text', () => {
    const { container } = render(<WhoGoverns record={RED} sources={sources} />);
    const bars = container.querySelectorAll('.seatbar');
    expect(bars).toHaveLength(2);
    for (const bar of bars) expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Republican trifecta')).toBeTruthy();
  });

  it('says why a government is not determined, and shows the chambers all the same', () => {
    render(<WhoGoverns record={NATION} sources={[]} />);
    expect(screen.getAllByText('Not determined').length).toBeGreaterThanOrEqual(1);
    const parts = within(screen.getByRole('list', { name: 'The offices of United States by party' })).getAllByRole('listitem');
    expect(parts[0]!.textContent).toContain('President');
    expect(parts[0]!.textContent).toContain('Not read from a source.');
    expect(screen.getByText(/none of the sources read here names the President’s party/)).toBeTruthy();
    expect(parts[2]!.textContent).toContain('The majority is the one the Clerk of the House states in the list.');
    expect(within(parts[1]!).getByText('Independent 2')).toBeTruthy();
  });

  it('does not call a chamber without party labels tied', () => {
    render(<WhoGoverns record={NEBRASKA} sources={sources} />);
    expect(screen.getByText('No party labels')).toBeTruthy();
    expect(screen.getByText('Nonpartisan 49')).toBeTruthy();
    expect(screen.queryByText('No majority')).toBeNull();
    // Neither party has a figure there, so none is shown: "Republican 0" would read as a count of members.
    expect(screen.queryByText('Republican 0')).toBeNull();
    expect(screen.queryByText('Democratic 0')).toBeNull();
  });

  it('names the source and the day of every part', () => {
    render(<WhoGoverns record={RED} sources={sources} />);
    const more = screen.getByText('Sources, dates and rules').closest('details')!;
    const lines = within(more).getAllByRole('listitem').map((line) => line.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Governor: Synthetic Governors Association.*, read Jun 1, 2026\.$/);
    expect(lines[1]).toMatch(/^Senate and House: Synthetic Aggregator.*, list dated May 29, 2026, read Jun 1, 2026\.$/);
    expect(within(more).getByRole('link', { name: /Synthetic Aggregator/ }).getAttribute('href')).toBe('https://data.example.org/people/zz.csv');
    expect(more.textContent).toContain('They are not an election result');
    expect(within(more).getByRole('link', { name: /Rules party-group-1/ }).getAttribute('href')).toBe('#/sources?section=rules');
  });

  it('counts the states for the overview and offers the map', () => {
    const index = new GovernmentIndex({ generatedAt: T, governments: [NATION, RED, BLUE, SPLIT, NEBRASKA] });
    const { rerender } = render(<ControlTally index={index} shown={false} mapHash="#/?shade=party" />);
    expect(screen.getByText('Republican 1')).toBeTruthy();
    expect(screen.getByText('Democratic 1')).toBeTruthy();
    expect(screen.getByText('Divided 1')).toBeTruthy();
    expect(screen.getByText('Not determined 1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Colour the map by party control' }).getAttribute('href')).toBe('#/?shade=party');
    rerender(<ControlTally index={index} shown mapHash="#/" />);
    expect(screen.getByRole('link', { name: 'Back to the map of records' }).getAttribute('href')).toBe('#/');
  });
});
