/**
 * Locator buttons for the places that do not fit in a view of the contiguous
 * states. Each shows the unit's real outline (drawn from the same Census
 * boundary file, in a local equal-rectangular projection) and moves the main
 * map there. They are navigation aids: nothing on the main map is relocated.
 */
import { useMemo } from 'react';
import type { Position } from 'geojson';
import type { UnitCollection } from '../lib/data';
import { CONTIGUOUS_BOUNDS, type Bbox, type GeoIndex } from '../lib/geo';

const SHAPES: Array<{ fips: string; label: string }> = [
  { fips: '02', label: 'Alaska' },
  { fips: '15', label: 'Hawaii' },
  { fips: '72', label: 'Puerto Rico' },
];
const OTHER: Array<{ fips: string; label: string }> = [
  { fips: '66', label: 'Guam' },
  { fips: '69', label: 'Northern Mariana Islands' },
  { fips: '60', label: 'American Samoa' },
  { fips: '78', label: 'U.S. Virgin Islands' },
];

const WIDTH = 54;
const HEIGHT = 34;

/** Outline path in a local projection: x scaled by cos(latitude) so shapes keep their proportions. */
export function outlinePath(rings: Position[][], width = WIDTH, height = HEIGHT): string {
  const points = rings.flat();
  if (points.length === 0) return '';
  const unwrap = (lng: number) => (lng > 0 ? lng - 360 : lng); // keep units that cross the antimeridian in one piece
  const lats = points.map((p) => p[1]!);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const project = (p: Position): [number, number] => [unwrap(p[0]!) * k, -p[1]!];
  const projected = rings.map((ring) => ring.map(project));
  const xs = projected.flat().map((p) => p[0]);
  const ys = projected.flat().map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const scale = Math.min((width - 4) / (Math.max(...xs) - minX || 1), (height - 4) / (Math.max(...ys) - minY || 1));
  const offsetX = (width - (Math.max(...xs) - minX) * scale) / 2;
  const offsetY = (height - (Math.max(...ys) - minY) * scale) / 2;
  return projected
    .map((ring) => {
      const out: string[] = [];
      let last = '';
      for (const [x, y] of ring) {
        const text = `${((x - minX) * scale + offsetX).toFixed(1)},${((y - minY) * scale + offsetY).toFixed(1)}`;
        if (text !== last) out.push(text);
        last = text;
      }
      return out.length > 2 ? `M${out.join('L')}Z` : '';
    })
    .join('');
}

function outerRings(collection: UnitCollection, fips: string): Position[][] {
  const feature = collection.features.find((f) => f.properties.GEOID === fips);
  if (!feature) return [];
  const geometry = feature.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.map((polygon) => polygon[0]!).filter((ring) => ring && ring.length > 8);
}

export function LocatorInsets({ geo, states, onGo }: { geo: GeoIndex; states: UnitCollection | null; onGo: (bbox: Bbox) => void }) {
  const paths = useMemo(() => {
    const map = new Map<string, string>();
    if (states) for (const { fips } of SHAPES) map.set(fips, outlinePath(outerRings(states, fips)));
    return map;
  }, [states]);
  const go = (fips: string) => {
    const unit = geo.state(fips);
    if (unit) onGo(unit.bbox);
  };
  return (
    <nav className="map-insets" aria-label="Jump the map to an area">
      <button type="button" className="inset inset-text" onClick={() => onGo(CONTIGUOUS_BOUNDS)}>
        <span>Contiguous states</span>
      </button>
      {SHAPES.map(({ fips, label }) => (
        <button type="button" className="inset" key={fips} onClick={() => go(fips)} title={`Move the map to ${label}`}>
          <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" focusable="false">
            <path d={paths.get(fips) ?? ''} />
          </svg>
          <span>{label}</span>
        </button>
      ))}
      <label className="inset-select">
        <span className="sr-only">Jump the map to an area</span>
        <select
          value=""
          onChange={(event) => {
            if (event.target.value === 'contiguous') onGo(CONTIGUOUS_BOUNDS);
            else if (event.target.value) go(event.target.value);
            event.target.value = '';
          }}
        >
          <option value="">Jump to</option>
          <option value="contiguous">Contiguous states</option>
          {[...SHAPES, ...OTHER].map(({ fips, label }) => <option key={fips} value={fips}>{label}</option>)}
        </select>
      </label>
    </nav>
  );
}
