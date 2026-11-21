/**
 * Population lookups. The rule enforced here: a count is only ever shown for
 * the geography vintage it was tabulated for. Where the Census Bureau has not
 * published counts for a boundary set, the result is "unavailable" with the
 * reason, never a zero and never an estimate.
 */
import type { PopulationFile, RedistrictingFile } from '../types/schemas';
import type { PopulationDataset } from './data';
import { ISLAND_AREAS, isCensusLayer, parseGeoKey, stateKind } from './geo';

export type PopulationResult =
  | { status: 'available'; values: Record<string, number>; dataset: PopulationFile['dataset']; variables: PopulationFile['variables']; carriedFrom?: string; note?: string }
  | { status: 'unavailable'; reason: string };

/** Said for the United States as a whole and for a judicial circuit, which the loaded Census files do not tabulate. */
export const NO_COUNTS_FOR_UNIT =
  'The Census counts in DemocracyHQ are tabulated for states, counties and congressional districts, not for this unit. DemocracyHQ does not add them up.';

/** Which dataset holds counts for a unit key, if any. There is none for the United States as a whole or for a judicial circuit. */
export function datasetFor(key: string): PopulationDataset | null {
  const parsed = parseGeoKey(key);
  if (!parsed || !isCensusLayer(parsed.layer)) return null;
  if (parsed.layer === 'state') return 'state';
  if (parsed.layer === 'county') return 'county';
  return 'cd119';
}

function rowToValues(file: PopulationFile, geoid: string): Record<string, number> | null {
  const row = file.rows[geoid];
  if (!row || row.length !== file.variables.length) return null;
  const values: Record<string, number> = {};
  file.variables.forEach((variable, i) => {
    values[variable.key] = row[i]!;
  });
  return values;
}

export function populationFor(key: string, file: PopulationFile, redistricting: RedistrictingFile | null): PopulationResult {
  const parsed = parseGeoKey(key);
  if (!parsed) return { status: 'unavailable', reason: 'Unknown geographic unit.' };
  if (!isCensusLayer(parsed.layer)) {
    return { status: 'unavailable', reason: NO_COUNTS_FOR_UNIT };
  }
  const stateFips = parsed.geoid.slice(0, 2);
  if (ISLAND_AREAS.has(stateFips)) {
    return { status: 'unavailable', reason: 'The 2020 Census of the Island Areas is published separately and is not loaded in DemocracyHQ.' };
  }
  if (parsed.layer === 'cd120') {
    if (!redistricting) {
      return { status: 'unavailable', reason: 'The list of states with new district boundaries could not be loaded, so no counts are shown for 120th Congress districts.' };
    }
    if (redistricting.congress120.statesWithNewBoundaries.includes(stateFips)) {
      return {
        status: 'unavailable',
        reason: 'The Census Bureau has not yet published 2020 Census counts for this state’s new 120th Congress districts. Counts for the 119th Congress districts describe different areas and are not shown here.',
      };
    }
    // The District of Columbia and Puerto Rico have districts too; they are not states.
    const kind = stateKind(stateFips).toLowerCase();
    if (redistricting.areaCheck?.mismatches.includes(parsed.geoid)) {
      return {
        status: 'unavailable',
        reason: `The Census Bureau reports no new boundaries for this ${kind}, but this district’s official land area differs between the 119th and 120th Congress boundary files. The counts are withheld until a maintainer has reviewed the difference.`,
      };
    }
    const values = rowToValues(file, parsed.geoid);
    if (!values) return { status: 'unavailable', reason: 'No published count was found for this district.' };
    return {
      status: 'available', values, dataset: file.dataset, variables: file.variables, carriedFrom: `cd119:${parsed.geoid}`,
      note: redistricting.congress120.unchangedQuote
        ? `The Census Bureau states: “${redistricting.congress120.unchangedQuote}” This ${kind} is not among those it lists as redrawn, and the district’s official land area agrees between the two boundary files, so the counts tabulated for the 119th Congress district with the same number are shown.`
        : `The Census Bureau reports no new boundaries for this ${kind} for the 2026 cycle, so the counts tabulated for the 119th Congress district with the same number are shown.`,
    };
  }
  const values = rowToValues(file, parsed.geoid);
  if (!values) {
    // Island areas were answered above. A county equivalent without a row is, in practice, one of Connecticut's
    // planning regions; any other gets the general sentence only.
    const reason = parsed.layer === 'county'
      ? `No count is shown for this county equivalent under its current boundaries.${stateFips === '09' ? ' Connecticut’s planning regions replaced its counties after the 2020 Census, which tabulated the former counties; DemocracyHQ does not add town counts up to planning regions.' : ''}`
      : 'No published count was found for this unit.';
    return { status: 'unavailable', reason };
  }
  return { status: 'available', values, dataset: file.dataset, variables: file.variables };
}

export const GROUP_KEYS = ['hispanic', 'white', 'black', 'asian', 'aian', 'nhpi', 'other', 'multi'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export const GROUP_LABELS: Readonly<Record<GroupKey, string>> = {
  hispanic: 'Hispanic or Latino (any race)',
  white: 'White alone',
  black: 'Black or African American alone',
  asian: 'Asian alone',
  aian: 'American Indian and Alaska Native alone',
  nhpi: 'Native Hawaiian and Other Pacific Islander alone',
  other: 'Some other race alone',
  multi: 'Two or more races',
};

export interface GroupRow { key: GroupKey; label: string; total: number; share: number | null; vap: number; vapShare: number | null }

/** Group counts with shares of total and of voting-age population. Race groups are "not Hispanic or Latino". */
export function groupBreakdown(values: Record<string, number>): GroupRow[] {
  const total = values.total ?? 0;
  const vapTotal = values.vap_total ?? 0;
  return GROUP_KEYS.map((key) => {
    const count = values[key] ?? 0;
    const vap = values[`vap_${key}`] ?? 0;
    return { key, label: GROUP_LABELS[key], total: count, share: total > 0 ? count / total : null, vap, vapShare: vapTotal > 0 ? vap / vapTotal : null };
  });
}

/** Do the mutually exclusive groups add up to the published total? Used as a display-time integrity check. */
export function groupsSumToTotal(values: Record<string, number>): boolean {
  const sum = GROUP_KEYS.reduce((acc, key) => acc + (values[key] ?? 0), 0);
  return sum === (values.total ?? -1);
}

export interface Deviation { ideal: number; persons: number; fraction: number; districts: number }

/**
 * Deviation of one district from the ideal (equal) district population of its
 * state, computed only from the published counts for the same district plan.
 */
export function districtDeviation(geoid: string, file: PopulationFile): Deviation | null {
  const stateFips = geoid.slice(0, 2);
  const totalIndex = file.variables.findIndex((v) => v.key === 'total');
  if (totalIndex < 0) return null;
  const siblings = Object.entries(file.rows).filter(([id]) => id.startsWith(stateFips) && id.length === 4);
  const own = file.rows[geoid]?.[totalIndex];
  if (own === undefined || siblings.length < 2) return null;
  const stateTotal = siblings.reduce((acc, [, row]) => acc + (row[totalIndex] ?? 0), 0);
  const ideal = stateTotal / siblings.length;
  if (ideal <= 0) return null;
  return { ideal, persons: own - ideal, fraction: (own - ideal) / ideal, districts: siblings.length };
}
