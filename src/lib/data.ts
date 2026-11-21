/**
 * Data access. Everything the interface shows is read from versioned static
 * JSON under `data/`, produced by the pipeline. Each file is validated with zod
 * the first time it is loaded; a file that fails validation is reported as an
 * error state and is never rendered partially.
 */
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection, Geometry } from 'geojson';
import type { z } from 'zod';
import {
  BillIndexSchema, CaseIndexSchema, CIRCUIT_CASE_ID_PATTERN, CircuitIndexSchema, CircuitsFileSchema, ClassificationFileSchema, CountyCdSchema,
  CourtsFileSchema, EventsFileSchema, FederalBillIndexSchema, GeoIndexSchema, GovernmentFileSchema, LegalCaseSchema, LegislativeInstrumentSchema, ManifestSchema,
  PopulationFileSchema, RedistrictingFileSchema, RelationshipFileSchema, SourcesFileSchema, US_BILL_ID_PATTERN, VersionTextSchema,
  type Layer, type Manifest,
} from '../types/schemas';

export type DataErrorKind = 'network' | 'not_found' | 'invalid';

export class DataError extends Error {
  constructor(public kind: DataErrorKind, public path: string, message: string) {
    super(message);
    this.name = 'DataError';
  }
}

/**
 * Address of a data file. Every file except the manifest carries the release it belongs to (`?v=<contentHash>`),
 * so a browser or proxy cache can never mix a file from an older release into a newer one.
 */
export function dataUrl(path: string, release?: string | null): string {
  const url = `${import.meta.env.BASE_URL}data/${path}`;
  return release ? `${url}?v=${encodeURIComponent(release)}` : url;
}

const cache = new Map<string, Promise<unknown>>();

export interface FetchOptions {
  /** Release token added to the address (see `dataUrl`). */
  release?: string | null;
  /** Passed to fetch; the manifest uses 'no-cache' so that it is always revalidated with the server. */
  cache?: RequestCache;
}

export async function fetchJson(path: string, fetchImpl: typeof fetch = fetch, options: FetchOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(dataUrl(path, options.release), options.cache ? { cache: options.cache } : undefined);
  } catch (error) {
    throw new DataError('network', path, `Could not reach ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) throw new DataError('not_found', path, `${path} is not part of this data release.`);
  if (!response.ok) throw new DataError('network', path, `${path} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new DataError('invalid', path, `${path} is not valid JSON.`);
  }
}

export function parseWith<S extends z.ZodType>(schema: S, path: string, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown problem';
    throw new DataError('invalid', path, `${path} failed validation (${where}). It is not shown.`);
  }
  return result.data;
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const promise = load().catch((error: unknown) => {
    cache.delete(key); // allow a retry after a transient failure
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

/** The token that identifies a release: the manifest's hash of every published file, or its time when there is no hash. */
export function releaseToken(manifest: Pick<Manifest, 'contentHash' | 'generatedAt'>): string {
  return manifest.contentHash || manifest.generatedAt;
}

/** The manifest, always revalidated with the server rather than taken from the browser cache. */
export const loadManifest = () => cached('manifest.json', async () => parseWith(ManifestSchema, 'manifest.json', await fetchJson('manifest.json', fetch, { cache: 'no-cache' })));

let release: Promise<string | null> | null = null;

/**
 * The release every other file is requested for, read once per page from the manifest. If the manifest cannot be
 * loaded the files are still requested, without a release token, so one failed file does not take the others down.
 */
export function currentRelease(): Promise<string | null> {
  release ??= loadManifest().then(releaseToken, () => null);
  return release;
}

function loader<S extends z.ZodType>(path: string, schema: S): () => Promise<z.infer<S>> {
  return () => cached(path, async () => parseWith(schema, path, await fetchJson(path, fetch, { release: await currentRelease() })));
}

/**
 * Fetch the manifest again, past every cache, to see whether a newer release has been published since the page opened.
 * Resolves to the newer manifest, or null when the release is unchanged or the check fails.
 */
export async function checkForNewRelease(fetchImpl: typeof fetch = fetch): Promise<Manifest | null> {
  const loaded = await currentRelease();
  if (!loaded) return null;
  try {
    const latest = parseWith(ManifestSchema, 'manifest.json', await fetchJson('manifest.json', fetchImpl, { cache: 'no-cache' }));
    return releaseToken(latest) !== loaded ? latest : null;
  } catch {
    return null;
  }
}
export const loadSources = loader('sources.json', SourcesFileSchema);
export const loadGeoIndex = loader('geo/index.json', GeoIndexSchema);
export const loadCountyCd = loader('geo/county_cd119.json', CountyCdSchema);
export const loadRedistricting = loader('redistricting.json', RedistrictingFileSchema);
/** The Supreme Court dockets. */
export const loadCaseIndex = loader('litigation/index.json', CaseIndexSchema);
/** The court of appeals cases, with the selection rule and what was read for each court. */
export const loadCircuitIndex = loader('circuits/index.json', CircuitIndexSchema);
/** California's election measures. */
export const loadBillIndex = loader('legislation/index.json', BillIndexSchema);
/** The election measures of Congress. */
export const loadFederalBillIndex = loader('congress/index.json', FederalBillIndexSchema);
/** The thirteen courts of appeals, the states each regional circuit is made of and the statute that says so. */
export const loadCircuits = loader('geo/circuits.json', CircuitsFileSchema);
/** The links between records. Its path is also how a view tells a failed links file from a failed record index. */
export const RELATIONSHIPS_PATH = 'relationships.json';
export const loadRelationships = loader(RELATIONSHIPS_PATH, RelationshipFileSchema);
export const loadEvents = loader('events.json', EventsFileSchema);
export const loadClassification = loader('classification.json', ClassificationFileSchema);
export const loadCourts = loader('courts.json', CourtsFileSchema);
/** Who holds office: the executive and the chambers of the United States and of the fifty states (rules party-*). */
export const loadGovernment = loader('government.json', GovernmentFileSchema);

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Whether a case id is a court of appeals case (ca5-25-30725) rather than a Supreme Court docket. */
export function isAppealsCaseId(id: string): boolean {
  return CIRCUIT_CASE_ID_PATTERN.test(id);
}

/** Whether a bill id is a measure of Congress (us-119-hr22) rather than a state bill. */
export function isFederalBillId(id: string): boolean {
  return US_BILL_ID_PATTERN.test(id);
}

/** A case's own file. The id says which folder it is in: court of appeals cases are under circuits/, the others under litigation/. */
export function loadCase(id: string) {
  if (!SAFE_ID.test(id)) return Promise.reject(new DataError('not_found', id, 'That case identifier is not valid.'));
  return loader(`${isAppealsCaseId(id) ? 'circuits' : 'litigation'}/cases/${id}.json`, LegalCaseSchema)();
}

/** A measure's own file: measures of Congress are under congress/, state bills under legislation/. */
export function loadBill(id: string) {
  if (!SAFE_ID.test(id)) return Promise.reject(new DataError('not_found', id, 'That bill identifier is not valid.'));
  return loader(`${isFederalBillId(id) ? 'congress' : 'legislation'}/bills/${id}.json`, LegislativeInstrumentSchema)();
}

export function loadVersionText(textPath: string) {
  if (!/^(?:legislation|congress)\/text\/[A-Za-z0-9_-]+\.json$/.test(textPath)) {
    return Promise.reject(new DataError('not_found', textPath, 'That text version is not available.'));
  }
  return loader(textPath, VersionTextSchema)();
}

export type PopulationDataset = 'state' | 'county' | 'cd119';
export function loadPopulation(dataset: PopulationDataset) {
  return loader(`population/${dataset}.json`, PopulationFileSchema)();
}

export interface UnitProperties {
  GEOID: string;
  NAME?: string;
  NAMELSAD?: string;
  STUSPS?: string;
  STATEFP?: string;
  CDFP?: string;
}
export type UnitCollection = FeatureCollection<Geometry, UnitProperties>;

/** Boundary layers are TopoJSON on disk and are converted to GeoJSON once per session. */
export function loadBoundaries(layer: Layer, file: string, objectName: string): Promise<UnitCollection> {
  return cached(`topo:${layer}`, async () => {
    const raw = (await fetchJson(file, fetch, { release: await currentRelease() })) as Topology;
    const object = raw?.objects?.[objectName];
    if (raw?.type !== 'Topology' || !object) {
      throw new DataError('invalid', file, `${file} is not a valid boundary file. It is not shown.`);
    }
    const collection = feature(raw, object) as unknown as UnitCollection;
    if (collection.type !== 'FeatureCollection' || collection.features.length === 0) {
      throw new DataError('invalid', file, `${file} contains no boundaries. It is not shown.`);
    }
    return collection;
  });
}

/** Test hook. */
export function clearDataCache(): void {
  cache.clear();
  release = null;
}
