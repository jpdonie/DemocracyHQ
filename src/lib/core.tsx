import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type {
  BillIndex, EntityRelationship, LegalCaseSummary, Manifest, RedistrictingFile, SourceRecord, TimelineEvent,
} from '../types/schemas';
import { loadBillIndex, loadCaseIndex, loadEvents, loadGeoIndex, loadManifest, loadRedistricting, loadRelationships, loadSources } from './data';
import { GeoIndex } from './geo';
import { useLoad, type Loadable } from './useLoad';

export interface Core {
  /** Time the page was opened, used for freshness. */
  now: string;
  manifest: Loadable<Manifest>;
  sources: Loadable<SourceRecord[]>;
  geo: Loadable<GeoIndex>;
  cases: Loadable<LegalCaseSummary[]>;
  bills: Loadable<BillIndex>;
  relationships: Loadable<EntityRelationship[]>;
  redistricting: Loadable<RedistrictingFile>;
}

const CoreContext = createContext<Core | null>(null);

const startedAt = new Date().toISOString();

export function CoreProvider({ children }: { children: ReactNode }) {
  const manifest = useLoad('manifest', loadManifest);
  const sources = useLoad('sources', async () => (await loadSources()).sources);
  const geo = useLoad('geo', async () => new GeoIndex(await loadGeoIndex()));
  const cases = useLoad('cases', async () => (await loadCaseIndex()).cases);
  const bills = useLoad('bills', loadBillIndex);
  const relationships = useLoad('relationships', async () => (await loadRelationships()).relationships);
  const redistricting = useLoad('redistricting', loadRedistricting);
  const value = useMemo<Core>(
    () => ({ now: startedAt, manifest, sources, geo, cases, bills, relationships, redistricting }),
    [manifest, sources, geo, cases, bills, relationships, redistricting],
  );
  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

export function useCore(): Core {
  const core = useContext(CoreContext);
  if (!core) throw new Error('useCore must be used inside CoreProvider');
  return core;
}

const loadEventList = async () => (await loadEvents()).events;

/**
 * The dated events (events.json, about half a megabyte) are requested only by the views that show them, the home
 * page and a place, not on every first paint.
 */
export function useEvents(): Loadable<TimelineEvent[]> {
  return useLoad('events', loadEventList);
}
