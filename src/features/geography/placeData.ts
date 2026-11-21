/** Everything known about one place, gathered once and shared by the workspace, the export and the print summary. */
import { useMemo } from 'react';
import type { Court, LegalCaseSummary, LegislativeInstrumentSummary, Manifest, SourceRecord, TimelineEvent } from '../../types/schemas';
import { useCore, useEvents } from '../../lib/core';
import { SCOTUS_ID } from '../../lib/courts';
import { loadCountyCd, loadPopulation, RELATIONSHIPS_PATH, type DataError } from '../../lib/data';
import { entityNamer, packForPlace, UNAVAILABLE_NOTICES, type SourcePack } from '../../lib/export';
import { NO_COUNTS_FOR_UNIT, datasetFor, populationFor, type PopulationResult } from '../../lib/population';
import { billsForPlace, casesForPlace, eventsForPlace, type LinkedRecord } from '../../lib/relations';
import { allOf, dataOf, mapLoadable, useLoad, type Loadable } from '../../lib/useLoad';
import { NATION_KEY, type GeoIndex, type GeoUnit } from '../../lib/geo';
import type { PopulationFile } from '../../types/schemas';

export type PlaceEvent = TimelineEvent & { via: 'direct' | 'statewide' | 'within' };

export interface PlaceLegislation {
  bills: LegislativeInstrumentSummary[];
  /** True when legislation for this unit's state is tracked at all. */
  covered: boolean;
}

/**
 * Each part is loaded on its own, so a tab waits only for the files it uses (cases and links for litigation, the bill
 * index for legislation, the timeline for events) and a file that failed shows as an error, not as "loading" forever.
 */
export interface PlaceData {
  unit: GeoUnit;
  geo: GeoIndex;
  vintage: string;
  geoSourceId: string;
  population: Loadable<PopulationResult>;
  populationFile: PopulationFile | null;
  cases: Loadable<LinkedRecord<LegalCaseSummary>[]>;
  /**
   * For a state or territory: the court of appeals cases that began in a federal district court there, as each opinion
   * names the court below (rule origin-court-1). Where a case began is not what it concerns, and the views say so.
   * Empty for every other kind of unit.
   */
  appealsFrom: Loadable<LegalCaseSummary[]>;
  /** For a unit inside a state or territory: the court of appeals of its circuit, or null where the statute places it in none. */
  appealsCourt: Loadable<Court | null>;
  legislation: Loadable<PlaceLegislation>;
  events: Loadable<PlaceEvent[]>;
  /** County <-> 119th Congress district pairs, for units where that applies. */
  overlaps: Loadable<Array<GeoUnit & { partNote?: string | null }>> | null;
}

export type PlaceState =
  | { status: 'loading' }
  | { status: 'error'; error: DataError }
  | { status: 'missing' }
  | { status: 'ready'; data: PlaceData };

export function usePlaceData(key: string): PlaceState {
  const core = useCore();
  const geo = dataOf(core.geo);
  const unit = geo?.get(key);
  const dataset = unit ? datasetFor(unit.key) : null;
  const populationFile = useLoad(dataset ? `population:${dataset}` : null, () => loadPopulation(dataset!));
  const needsPairs = unit?.layer === 'county' || unit?.layer === 'cd119';
  const pairs = useLoad(needsPairs ? 'county-cd119' : null, loadCountyCd);
  const redistricting = core.redistricting;
  const allEvents = useEvents();

  const cases = useMemo(
    () => (unit ? mapLoadable(allOf(core.cases, core.relationships), ([all, links]) => casesForPlace(unit.key, links, all)) : { status: 'loading' as const }),
    [unit, core.cases, core.relationships],
  );
  const appealsFrom = useMemo<Loadable<LegalCaseSummary[]>>(
    () => (unit ? mapLoadable(core.cases, (all) => (unit.layer === 'state'
      ? all.filter((c) => c.courtId !== SCOTUS_ID && c.origin?.stateFips === unit.stateFips).sort((a, b) => (b.sourceLastActivity ?? '').localeCompare(a.sourceLastActivity ?? '') || a.id.localeCompare(b.id))
      : [])) : { status: 'loading' }),
    [unit, core.cases],
  );
  const appealsCourt = useMemo<Loadable<Court | null>>(
    () => (unit ? mapLoadable(core.courts, (courts) => (unit.stateFips ? courts.forState(unit.stateFips) ?? null : null)) : { status: 'loading' }),
    [unit, core.courts],
  );
  const legislation = useMemo<Loadable<PlaceLegislation>>(
    () => (unit ? mapLoadable(core.bills, (index) => {
      // Legislation is covered for a place when the dataset holds measures of its legislature at all.
      const bills = billsForPlace(unit.key, index.bills);
      return { bills, covered: bills.length > 0 };
    }) : { status: 'loading' }),
    [unit, core.bills],
  );
  const events = useMemo<Loadable<PlaceEvent[]>>(
    () => (unit ? mapLoadable(allEvents, (all) => eventsForPlace(unit.key, all)) : { status: 'loading' }),
    [unit, allEvents],
  );

  return useMemo<PlaceState>(() => {
    if (core.geo.status === 'error') return { status: 'error', error: core.geo.error };
    if (core.geo.status !== 'ready') return { status: 'loading' };
    if (!unit || !geo) return { status: 'missing' };
    const info = geo.layers[unit.layer];
    let population: Loadable<PopulationResult>;
    // No file holds counts for the country as a whole or for a circuit, so there is nothing to wait for.
    if (!dataset) population = { status: 'ready', data: { status: 'unavailable', reason: NO_COUNTS_FOR_UNIT } };
    else if (populationFile.status === 'ready') {
      if (unit.layer === 'cd120' && redistricting.status === 'loading') population = { status: 'loading' };
      else population = { status: 'ready', data: populationFor(unit.key, populationFile.data, dataOf(redistricting)) };
    } else population = populationFile;

    let overlaps: PlaceData['overlaps'] = null;
    if (unit.layer === 'county' || unit.layer === 'cd119') {
      if (pairs.status === 'ready') {
        const matched = pairs.data.pairs
          .filter(([county, district]) => (unit.layer === 'county' ? county === unit.geoid : district === unit.geoid))
          .map(([county, district, land, water]) => {
            const other = geo.get(unit.layer === 'county' ? `cd119:${district}` : `county:${county}`);
            return other ? { ...other, partNote: partNote(land, water) } : null;
          })
          .filter((u): u is GeoUnit & { partNote: string | null } => Boolean(u))
          .sort((a, b) => a.geoid.localeCompare(b.geoid));
        overlaps = { status: 'ready', data: matched };
      } else overlaps = pairs;
    }
    const data: PlaceData = {
      unit, geo, vintage: info.vintage, geoSourceId: info.sourceId, population,
      populationFile: populationFile.status === 'ready' ? populationFile.data : null,
      cases, appealsFrom, appealsCourt, legislation, events, overlaps,
    };
    return { status: 'ready', data };
  }, [core.geo, unit, geo, dataset, populationFile, pairs, redistricting, cases, appealsFrom, appealsCourt, legislation, events]);
}

/** The note a pack carries for a place whose state's legislation is not covered. */
export function billCoverageNote(data: PlaceData): string | null {
  const legislation = dataOf(data.legislation);
  if (!legislation || legislation.covered) return null;
  if (!data.unit.stateFips) return 'No legislation is listed for this unit.';
  return `Legislation for ${data.geo.stateName(data.unit.stateFips)} is not covered by DemocracyHQ; no bills are listed. The measures of Congress apply nationwide and are listed for the United States.`;
}

/** Said in the pack of the United States, which lists the measures of Congress and the dated events but no court cases. */
export const NATION_CASES_NOTICE =
  'Court cases are not listed in this pack. The cases of the Supreme Court and of the courts of appeals are listed on the pages of those courts, and each case has a source pack of its own.';

/**
 * The place's source pack, or null while a file it lists is still loading. A file that failed is named in the pack's
 * notices, so the pack never leaves records out silently. `sources` is null when sources.json could not be loaded.
 */
export function buildPlacePack(data: PlaceData, base: { manifest: Manifest | null; sources: readonly SourceRecord[] | null; now: string; link: (hash: string) => string }): SourcePack | null {
  if ([data.cases, data.appealsFrom, data.legislation, data.events, data.population].some((part) => part.status === 'loading')) return null;
  const nation = data.unit.key === NATION_KEY;
  return packForPlace({
    ...base,
    unit: data.unit, vintage: data.vintage, geoSourceId: data.geoSourceId,
    nameOf: entityNamer({ geo: data.geo, bills: dataOf(data.legislation)?.bills ?? null }),
    cases: dataOf(data.cases), appealsFrom: dataOf(data.appealsFrom), bills: dataOf(data.legislation)?.bills ?? null, events: dataOf(data.events),
    // The cases come from two files; the notice names the one that failed.
    casesNotice: data.cases.status === 'error' && data.cases.error.path === RELATIONSHIPS_PATH ? UNAVAILABLE_NOTICES.placeLinks : undefined,
    // The country has no count here to report as missing: the counts are published for the units below it.
    population: nation ? null : dataOf(data.population),
    billCoverageNote: billCoverageNote(data),
    extraNotices: [...(nation ? [NATION_CASES_NOTICE] : []), ...(data.population.status === 'error' ? [UNAVAILABLE_NOTICES.population] : [])],
  });
}

/** A short qualifier for a county-district part that is water only or very small, from the Bureau's own areas. */
export function partNote(land: number | undefined, water: number | undefined): string | null {
  if (land === undefined) return null;
  if (land === 0) return water ? 'water only' : 'no land area recorded';
  if (land < 1_000_000) return `land part under 1 km² (${Math.round(land).toLocaleString('en-US')} m²)`;
  return null;
}
