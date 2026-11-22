/**
 * What the map's fill encodes. A theme assigns some units to labelled classes
 * and can mark others as "no data" (hatched). Units in neither set are drawn as
 * plain land, and `plain` says what that means when it means something.
 * Absence of data is always a hatch, never the lightest colour, so it cannot be
 * mistaken for a low value or a verified zero.
 */
import type { Government, GovernmentControl, Layer, PopulationFile, RedistrictingFile } from '../types/schemas';
import { courtGeoKey } from './courts';
import type { GeoIndex } from './geo';
import { ISLAND_AREAS, isDistrictLayer, parseGeoKey } from './geo';
import { formatNumber, plural } from './format';
import { controlSummary, whyUndetermined } from './government';

export interface ThemeClass { token: string; label: string }

export interface MapTheme {
  id: string;
  /** The layer whose features the theme applies to. */
  layer: Layer;
  title: string;
  classes: ThemeClass[];
  /** GEOID -> index into `classes`. */
  classOf: Map<string, number>;
  /** GEOIDs with no data, or "rest" for every unit not in `classOf`. */
  hatch: { geoids: Set<string> | 'rest'; label: string } | null;
  /** What a unit in neither set (drawn as plain land) means, for the legend and the tooltip. Null when there are none. */
  plain: string | null;
  /** Shown under the legend: what the encoding does and does not mean. */
  note: string | null;
  sourceId: string | null;
  /**
   * What the tooltip says for single units, where a unit has more to say than the label of its class: which parts of
   * a state's government a party holds, or why none is shown. GEOID -> text.
   */
  detailOf?: ReadonlyMap<string, string>;
  /**
   * Themes of one family are the same colouring over another set of units, as when a filter of a list changes. The
   * map then redraws without the fade it gives a new colouring, so that it does not flicker while a reader types.
   */
  family?: string;
}

export function linkedRecordsTheme(counts: ReadonlyMap<string, number>, what: 'cases' | 'records'): MapTheme {
  const classOf = new Map<string, number>();
  for (const [stateFips, count] of counts) if (count > 0) classOf.set(stateFips, 0);
  return {
    id: `linked:${what}:${[...classOf.keys()].sort().join(',')}`,
    layer: 'state',
    title: what === 'cases' ? 'Court cases linked to a state' : 'Records linked to a state',
    classes: [{ token: what === 'cases' ? '--case-tint' : '--data-tint', label: what === 'cases' ? 'At least one linked case' : 'At least one linked record' }],
    classOf,
    hatch: { geoids: 'rest', label: 'None in this dataset. Not evidence that none exists.' },
    plain: null,
    note: 'Shading shows where this dataset has records, not how much litigation or legislation exists.',
    sourceId: null,
  };
}

/**
 * The litigation list's map: the states its cases are listed under. A Supreme Court docket is listed under the states
 * its record links it to, an appeal under the state of the district court it came from, and a case of a district court
 * or a state court under the state that court sits in, so the map and the list's state filter always agree. With
 * `filtered`, the counts are those of the cases the list's other filters keep, and the legend says so. The shading
 * marks that a case is listed; how many are is in the tooltip of the state, never in the depth of a colour.
 */
export function caseStatesTheme(counts: ReadonlyMap<string, number>, filtered = false): MapTheme {
  const classOf = new Map<string, number>();
  const detailOf = new Map<string, string>();
  for (const [stateFips, count] of counts) {
    if (count <= 0) continue;
    classOf.set(stateFips, 0);
    detailOf.set(stateFips, filtered ? `${plural(count, 'case')} ${count === 1 ? 'matches' : 'match'} the filters` : `${plural(count, 'case')} in this dataset`);
  }
  return {
    id: `case-states:${filtered ? 'filtered' : 'all'}:${[...classOf.keys()].sort().join(',')}`,
    layer: 'state',
    title: filtered ? 'Court cases that match the filters, by state' : 'Court cases by state',
    classes: [{ token: '--case-tint', label: filtered ? 'At least one case matches the filters' : 'At least one case' }],
    classOf,
    hatch: { geoids: 'rest', label: filtered ? 'None matches the filters. Not evidence that none exists.' : 'None in this dataset. Not evidence that none exists.' },
    plain: null,
    note: 'A state is shaded when the record links a Supreme Court docket to it, when an appeal in this dataset came from a federal district court there, or when a case of a federal district court or of a state court that sits there is in this dataset. Where a case began or is heard does not say what it concerns. The shading shows that a case is listed, not how many are.',
    sourceId: null,
    detailOf,
    family: filtered ? 'case-states:filtered' : undefined,
  };
}

/**
 * The circuits layer: which regional circuits have cases in this dataset. `casesOfCourt` is keyed by court id ("ca5").
 * With twelve units the shading marks presence only; the counts are in the panel.
 */
export function circuitTheme(casesOfCourt: ReadonlyMap<string, number>): MapTheme {
  const classOf = new Map<string, number>();
  for (const [courtId, count] of casesOfCourt) {
    const parsed = parseGeoKey(courtGeoKey(courtId) ?? '');
    if (parsed && count > 0) classOf.set(parsed.geoid, 0);
  }
  return {
    id: `circuits:${[...classOf.keys()].sort().join(',')}`,
    layer: 'circuit',
    title: 'Election cases in the courts of appeals',
    classes: [{ token: '--case-tint', label: 'At least one case of the circuit’s court' }],
    classOf,
    hatch: { geoids: 'rest', label: 'None in this dataset. Not evidence that none exists.' },
    plain: null,
    note: 'A circuit is the group of states and territories whose federal district courts one court of appeals hears appeals from (28 U.S.C. § 41). The outlines are the Census Bureau’s state boundaries, merged by DemocracyHQ. They are not an official map of the courts.',
    sourceId: 'govinfo-uscourts',
  };
}

/**
 * The legislation list's map: the states whose own legislature has a measure in this dataset. With `filtered`, the
 * counts are those of the measures the list's other filters keep, and the legend says so. As on the litigation map, the
 * shading marks that a measure is listed; how many are is in the tooltip of the state, never in the depth of a colour:
 * how many a rule picks depends on how many bills a legislature files, how often it meets and how it titles and files
 * them. `unlisted` gives, by state, why a legislature has none listed (see `whyNoneListed`). The measures of Congress
 * apply to the whole country and are not drawn as shading.
 */
export function legislationTheme(counts: ReadonlyMap<string, number>, filtered = false, unlisted: ReadonlyMap<string, string> = new Map()): MapTheme {
  const classOf = new Map<string, number>();
  const detailOf = new Map<string, string>();
  for (const [stateFips, count] of counts) {
    if (count <= 0) continue;
    classOf.set(stateFips, 0);
    detailOf.set(stateFips, filtered ? `${plural(count, 'measure')} of the state’s legislature ${count === 1 ? 'matches' : 'match'} the filters` : `${plural(count, 'election measure')} of the state’s legislature in this dataset`);
  }
  for (const [stateFips, why] of unlisted) if (!classOf.has(stateFips)) detailOf.set(stateFips, why);
  return {
    id: `legislation:${filtered ? 'filtered' : 'all'}:${[...classOf.keys()].sort().join(',')}`,
    layer: 'state',
    title: filtered ? 'State legislation that matches the filters' : 'State legislation by state',
    classes: [{ token: '--law-tint', label: filtered ? 'At least one measure matches the filters' : 'At least one election measure' }],
    classOf,
    hatch: { geoids: 'rest', label: filtered ? 'None matches the filters. Not evidence that none exists.' : 'None in this dataset. Not evidence that none exists.' },
    plain: null,
    note: 'The shading shows that a measure is listed, not how many are: how many a rule picks depends on how many bills a legislature files, how often it meets and how it titles them. The measures of Congress apply to the whole country and are not drawn as shading.',
    sourceId: null,
    detailOf,
    family: filtered ? 'legislation:filtered' : undefined,
  };
}

/** The classes of the party map, in the order of its legend. Red and blue are used for this view and nowhere else. */
export const PARTY_CLASSES: ReadonlyArray<{ control: GovernmentControl; token: string; label: string }> = [
  { control: 'R', token: '--party-r', label: 'Republican governor and legislature' },
  { control: 'D', token: '--party-d', label: 'Democratic governor and legislature' },
  { control: 'divided', token: '--party-split', label: 'Divided between the parties' },
];

/**
 * The states by the party that holds their government (rule party-trifecta-1). A state is red or blue only when its
 * governor and every chamber of its legislature are that party's. A state that is not determined, and every unit no
 * record is published for, is hatched: no colour there is not a finding.
 */
export function partyControlTheme(states: readonly Government[]): MapTheme {
  const classOf = new Map<string, number>();
  const detailOf = new Map<string, string>();
  for (const record of states) {
    if (!record.id.startsWith('state:')) continue;
    const fips = record.id.slice(6);
    const index = PARTY_CLASSES.findIndex((item) => item.control === record.control);
    if (index >= 0) classOf.set(fips, index);
    detailOf.set(fips, record.control === 'undetermined' ? `Not determined. ${whyUndetermined(record)}` : controlSummary(record));
  }
  return {
    id: `party:${states.map((record) => `${record.id.slice(6)}${record.control[0]}`).join('')}`,
    layer: 'state',
    title: 'Party control of the state governments',
    classes: PARTY_CLASSES.map(({ token, label }) => ({ token, label })),
    classOf,
    hatch: { geoids: 'rest', label: 'Not determined, or not covered (the District of Columbia and the territories)' },
    plain: null,
    note: 'A state is red or blue when its governor is of that party and the members counted with that party hold more than half of the seats of every chamber, vacant seats included (rules party-seats-1 and party-trifecta-1). Seats show who was elected under which label, not who runs a chamber. The figures are the members each source lists on the day given on the state’s page. They are not an election result.',
    sourceId: 'openstates-people',
    detailOf,
  };
}

export function redrawnTheme(layer: 'cd119' | 'cd120', geo: GeoIndex, redistricting: RedistrictingFile): MapTheme {
  const { statesWithNewBoundaries, unchangedQuote } = redistricting.congress120;
  const classOf = new Map<string, number>();
  for (const stateFips of statesWithNewBoundaries) {
    for (const unit of geo.inState(layer, stateFips)) classOf.set(unit.geoid, 0);
  }
  // The Bureau's sentence on unchanged boundaries names "all other states, the District of Columbia, and Puerto Rico".
  // An island area it does not name is not covered by that statement, so it is hatched rather than shown as unchanged.
  const unstated = new Set<string>();
  if (unchangedQuote) {
    for (const stateFips of ISLAND_AREAS) {
      if (unchangedQuote.includes(geo.stateName(stateFips))) continue;
      for (const unit of geo.inState(layer, stateFips)) if (!classOf.has(unit.geoid)) unstated.add(unit.geoid);
    }
  }
  return {
    id: `redrawn:${layer}:${statesWithNewBoundaries.join(',')}:${unchangedQuote ? 'quoted' : 'unquoted'}`,
    layer,
    title: layer === 'cd120' ? 'Districts for the 2026 elections' : 'Districts of the 119th Congress',
    classes: [{
      token: '--geo-tint',
      label: layer === 'cd120' ? 'State delineated new boundaries for the 2026 cycle' : 'State replaced these boundaries for the 2026 cycle',
    }],
    classOf,
    hatch: unstated.size > 0 ? { geoids: unstated, label: 'Not covered by the Census Bureau’s statement on unchanged boundaries' } : null,
    plain: unchangedQuote ? 'Census Bureau reports no change from the 2024 cycle' : 'Not listed by the Census Bureau as having new boundaries',
    note: unchangedQuote
      ? `Which states have new boundaries is taken from the Census Bureau’s 120th Congress page, which also states: “${unchangedQuote}”`
      : 'Which states have new boundaries is taken from the Census Bureau’s 120th Congress page.',
    sourceId: 'census-cd120-page',
  };
}

/** Round to two significant digits so class limits are readable; the rounded values are the actual limits used. */
export function roundBreak(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / magnitude) * magnitude;
}

export function quantileBreaks(values: readonly number[], classes: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks: number[] = [];
  for (let i = 1; i < classes; i += 1) {
    const value = roundBreak(sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / classes))] ?? 0);
    if (breaks.length === 0 || value > breaks[breaks.length - 1]!) breaks.push(value);
  }
  return breaks;
}

export function classIndex(value: number, breaks: readonly number[]): number {
  let index = 0;
  while (index < breaks.length && value >= breaks[index]!) index += 1;
  return index;
}

const RAMP = ['--ramp-1', '--ramp-2', '--ramp-3', '--ramp-4', '--ramp-5'];

export function populationTheme(layer: Layer, geo: GeoIndex, file: PopulationFile, redistricting: RedistrictingFile | null): MapTheme {
  const totalIndex = file.variables.findIndex((v) => v.key === 'total');
  const redrawn = new Set(layer === 'cd120' ? redistricting?.congress120.statesWithNewBoundaries ?? [] : []);
  // Districts whose land area differs between the two boundary files have their counts withheld (see populationFor).
  const withheld = new Set(layer === 'cd120' ? redistricting?.areaCheck?.mismatches ?? [] : []);
  const values = new Map<string, number>();
  const missing = new Set<string>();
  for (const unit of geo.all(layer)) {
    const row = file.rows[unit.geoid];
    const usable = row && totalIndex >= 0 && !ISLAND_AREAS.has(unit.stateFips) && !redrawn.has(unit.stateFips) && !withheld.has(unit.geoid) && !(layer === 'cd120' && !redistricting);
    if (usable) values.set(unit.geoid, row[totalIndex]!);
    else missing.add(unit.geoid);
  }
  const breaks = quantileBreaks([...values.values()], RAMP.length);
  const classOf = new Map<string, number>();
  for (const [geoid, value] of values) classOf.set(geoid, classIndex(value, breaks));
  const classes: ThemeClass[] = [];
  for (let i = 0; i <= breaks.length; i += 1) {
    const low = i === 0 ? null : breaks[i - 1]!;
    const high = i === breaks.length ? null : breaks[i]!;
    const label = low === null ? `Under ${formatNumber(high)}` : high === null ? `${formatNumber(low)} or more` : `${formatNumber(low)} to under ${formatNumber(high)}`;
    classes.push({ token: RAMP[Math.round((i * (RAMP.length - 1)) / Math.max(1, breaks.length))]!, label });
  }
  const carried = layer === 'cd120';
  return {
    id: `population:${layer}:${file.dataset.id}:${values.size}`,
    layer,
    title: 'Total population, 2020 Census',
    classes,
    classOf,
    hatch: missing.size > 0
      ? { geoids: missing, label: carried ? 'No count shown for these boundaries yet' : layer === 'county' ? 'No count shown (island areas not loaded; Connecticut regions not tabulated)' : 'No count shown (island areas not loaded)' }
      : null,
    plain: null,
    note: isDistrictLayer(layer)
      ? carried
        ? 'Counts tabulated for 119th Congress districts, shown only where the Census Bureau reports unchanged boundaries. Districts within a state are drawn to near-equal populations, so the shading mainly shows differences between states. Equal-size classes (quintiles).'
        : 'Counts tabulated by the Census Bureau for 119th Congress districts. Districts within a state are drawn to near-equal populations, so the shading mainly shows differences between states. Equal-size classes (quintiles).'
      : 'Equal-size classes (quintiles) of the units shown.',
    sourceId: file.dataset.sourceId,
  };
}

/* ---------- line contrast ---------- */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #rrggbb colour (WCAG 2). */
export function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return 0;
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map((h) => channel(parseInt(h, 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Non-text contrast a unit boundary needs against the fill on either side of it (WCAG 2.2, 1.4.11). */
export const LINE_CONTRAST = 3;

/**
 * Whether boundary lines in this colour would fade into one of the fill colours. Lines that would are drawn in ink over
 * a land-coloured casing instead: ink stands out on the light fills and the casing on the dark ones.
 */
export function linesFadeInto(lineColor: string, fillColors: readonly string[]): boolean {
  return fillColors.some((fill) => contrastRatio(lineColor, fill) < LINE_CONTRAST);
}
