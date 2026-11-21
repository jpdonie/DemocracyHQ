/**
 * Geographic units and their stable keys.
 *
 * A unit key is "<layer>:<GEOID>", e.g. "state:06", "county:06037",
 * "cd119:0612", "cd120:0612". GEOIDs are the Census Bureau identifiers and are
 * the only join keys used anywhere in the application. Congressional districts
 * carry their Congress in the layer name because a district number means a
 * different area under different plans.
 */
import type { GeoIndexFile, Layer, LayerInfo } from '../types/schemas';
import { LAYERS } from '../types/schemas';

/** USPS abbreviations by state FIPS code (checked against the Census boundary file by `npm run data:validate`). */
export const STATE_ABBR: Readonly<Record<string, string>> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

/** Island areas without 2020 P.L. 94-171 counts in this dataset. */
export const ISLAND_AREAS: ReadonlySet<string> = new Set(['60', '66', '69', '78']);

export type Bbox = [west: number, south: number, east: number, north: number];

export interface GeoUnit {
  key: string;
  layer: Layer;
  geoid: string;
  name: string;
  stateFips: string;
  bbox: Bbox;
}

export function isLayer(value: string | undefined): value is Layer {
  return (LAYERS as readonly string[]).includes(value ?? '');
}

export function parseGeoKey(key: string): { layer: Layer; geoid: string } | null {
  const match = /^(state|county|cd119|cd120):([0-9A-Z]{2,5})$/.exec(key);
  if (!match || !isLayer(match[1])) return null;
  return { layer: match[1], geoid: match[2]! };
}

export function geoKey(layer: Layer, geoid: string): string {
  return `${layer}:${geoid}`;
}

export const LAYER_NOUN: Readonly<Record<Layer, string>> = {
  state: 'State',
  county: 'County',
  cd119: 'Congressional district, 119th Congress',
  cd120: 'Congressional district, 120th Congress',
};

/** FIPS codes of the five territories in the state-level boundary file (American Samoa, Guam, Northern Mariana Islands, Puerto Rico, U.S. Virgin Islands). */
const TERRITORIES: ReadonlySet<string> = new Set(['60', '66', '69', '72', '78']);
const DISTRICT_OF_COLUMBIA = '11';

export type StateKind = 'State' | 'Federal district' | 'Territory' | 'State or equivalent';

/**
 * What a state-level unit is. The boundary file's "state" layer also holds the District of Columbia
 * and the territories, which are not states; calling them states would be wrong and is not neutral.
 */
export function stateKind(stateFips: string): StateKind {
  if (stateFips === DISTRICT_OF_COLUMBIA) return 'Federal district';
  if (TERRITORIES.has(stateFips)) return 'Territory';
  return STATE_ABBR[stateFips] ? 'State' : 'State or equivalent';
}

/** The noun for a unit's kind: "Territory" for Puerto Rico, "County" for a county, and so on. */
export function unitNoun(unit: Pick<GeoUnit, 'layer' | 'stateFips'>): string {
  return unit.layer === 'state' ? stateKind(unit.stateFips) : LAYER_NOUN[unit.layer];
}

export const LAYER_SHORT: Readonly<Record<Layer, string>> = {
  state: 'States',
  county: 'Counties',
  cd119: 'Districts, 119th Congress',
  cd120: 'Districts, 120th Congress',
};

export function isDistrictLayer(layer: Layer): layer is 'cd119' | 'cd120' {
  return layer === 'cd119' || layer === 'cd120';
}

/** Short map label: "CA", "Kern", "12", "AL" (at large). */
export function shortLabel(unit: GeoUnit): string {
  if (unit.layer === 'state') return STATE_ABBR[unit.stateFips] ?? unit.name;
  if (unit.layer === 'county') return unit.name.split(',')[0]!.replace(/ (County|Parish|Borough|Census Area|Municipality|Municipio|Planning Region|city)$/i, '');
  const code = unit.geoid.slice(2);
  if (code === '00' || code === '98') return 'At large';
  return String(Number(code));
}

export class GeoIndex {
  readonly layers: Readonly<Record<Layer, LayerInfo>>;
  private readonly units = new Map<string, GeoUnit>();
  private readonly byLayerState = new Map<string, GeoUnit[]>();
  private readonly byLayer = new Map<Layer, GeoUnit[]>();

  constructor(file: GeoIndexFile) {
    this.layers = file.layers as Record<Layer, LayerInfo>;
    for (const [key, name, stateFips, w, s, e, n] of file.rows) {
      const parsed = parseGeoKey(key);
      if (!parsed) continue;
      const unit: GeoUnit = { key, layer: parsed.layer, geoid: parsed.geoid, name, stateFips, bbox: [w, s, e, n] };
      this.units.set(key, unit);
      const groupKey = `${parsed.layer}:${stateFips}`;
      const group = this.byLayerState.get(groupKey);
      if (group) group.push(unit);
      else this.byLayerState.set(groupKey, [unit]);
      const all = this.byLayer.get(parsed.layer);
      if (all) all.push(unit);
      else this.byLayer.set(parsed.layer, [unit]);
    }
  }

  get(key: string): GeoUnit | undefined {
    return this.units.get(key);
  }

  all(layer: Layer): readonly GeoUnit[] {
    return this.byLayer.get(layer) ?? [];
  }

  inState(layer: Layer, stateFips: string): readonly GeoUnit[] {
    return this.byLayerState.get(`${layer}:${stateFips}`) ?? [];
  }

  state(stateFips: string): GeoUnit | undefined {
    return this.units.get(`state:${stateFips}`);
  }

  stateName(stateFips: string): string {
    return this.state(stateFips)?.name ?? `State ${stateFips}`;
  }

  get size(): number {
    return this.units.size;
  }
}

/** Bounds of the 48 contiguous states and DC, used as the default view. */
export const CONTIGUOUS_BOUNDS: Bbox = [-125.2, 24.2, -66.6, 49.6];

export function unionBbox(boxes: readonly Bbox[]): Bbox | null {
  if (boxes.length === 0) return null;
  let [w, s, e, n] = boxes[0]!;
  for (const box of boxes.slice(1)) {
    w = Math.min(w, box[0]);
    s = Math.min(s, box[1]);
    e = Math.max(e, box[2]);
    n = Math.max(n, box[3]);
  }
  return [w, s, e, n];
}
