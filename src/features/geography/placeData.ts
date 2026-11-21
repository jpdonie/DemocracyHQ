/** Everything known about one place, gathered once and shared by the workspace, the export and the print summary. */
import { useMemo } from 'react';
import type { LegalCaseSummary, LegislativeInstrumentSummary, Manifest, SourceRecord, TimelineEvent } from '../../types/schemas';
import { useCore, useEvents } from '../../lib/core';
import { loadCountyCd, loadPopulation, RELATIONSHIPS_PATH, type DataError } from '../../lib/data';
import { entityNamer, packForPlace, UNAVAILABLE_NOTICES, type SourcePack } from '../../lib/export';
import { datasetFor, populationFor, type PopulationResult } from '../../lib/population';
import { billsForPlace, casesForPlace, eventsForPlace, type LinkedRecord } from '../../lib/relations';
import { allOf, dataOf, mapLoadable, useLoad, type Loadable } from '../../lib/useLoad';
import type { GeoIndex, GeoUnit } from '../../lib/geo';
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
  const legislation = useMemo<Loadable<PlaceLegislation>>(
    () => (unit ? mapLoadable(core.bills, (index) => ({ bills: billsForPlace(unit.key, index.bills), covered: index.bills.some((b) => b.state === unit.stateFips) })) : { status: 'loading' }),
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
    if (populationFile.status === 'ready') {
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
      cases, legislation, events, overlaps,
    };
    return { status: 'ready', data };
  }, [core.geo, unit, geo, populationFile, pairs, redistricting, cases, legislation, events]);
}

/** The note a pack carries for a place whose state's legislation is not covered. */
export function billCoverageNote(data: PlaceData): string | null {
  const legislation = dataOf(data.legislation);
  return legislation && !legislation.covered ? `Legislation for ${data.geo.stateName(data.unit.stateFips)} is not covered by DemocracyHQ; no bills are listed.` : null;
}

/**
 * The place's source pack, or null while a file it lists is still loading. A file that failed is named in the pack's
 * notices, so the pack never leaves records out silently. `sources` is null when sources.json could not be loaded.
 */
export function buildPlacePack(data: PlaceData, base: { manifest: Manifest | null; sources: readonly SourceRecord[] | null; now: string; link: (hash: string) => string }): SourcePack | null {
  if ([data.cases, data.legislation, data.events, data.population].some((part) => part.status === 'loading')) return null;
  return packForPlace({
    ...base,
    unit: data.unit, vintage: data.vintage, geoSourceId: data.geoSourceId,
    nameOf: entityNamer({ geo: data.geo, bills: dataOf(data.legislation)?.bills ?? null }),
    cases: dataOf(data.cases), bills: dataOf(data.legislation)?.bills ?? null, events: dataOf(data.events),
    // The cases come from two files; the notice names the one that failed.
    casesNotice: data.cases.status === 'error' && data.cases.error.path === RELATIONSHIPS_PATH ? UNAVAILABLE_NOTICES.placeLinks : undefined,
    population: dataOf(data.population),
    billCoverageNote: billCoverageNote(data),
    extraNotices: data.population.status === 'error' ? [UNAVAILABLE_NOTICES.population] : [],
  });
}

/** A short qualifier for a county-district part that is water only or very small, from the Bureau's own areas. */
export function partNote(land: number | undefined, water: number | undefined): string | null {
  if (land === undefined) return null;
  if (land === 0) return water ? 'water only' : 'no land area recorded';
  if (land < 1_000_000) return `land part under 1 km² (${Math.round(land).toLocaleString('en-US')} m²)`;
  return null;
}
