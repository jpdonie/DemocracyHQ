/**
 * The map. Boundaries are drawn from DemocracyHQ's own Census-derived files:
 * there is no third-party basemap, tile service or tracking request.
 *
 * Projection: Web Mercator, every unit at its true position. Alaska, Hawaii
 * and the island areas are not moved or rescaled on the main map; the labelled
 * locator buttons fly the view to them instead.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { safePadding, type MapPadding } from '../lib/mapPadding';
import { Map as MapLibreMap, setWorkerUrl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Geometry, Point, Position } from 'geojson';
import { LAYERS, type Layer } from '../types/schemas';
import { loadBoundaries, type UnitCollection, type UnitProperties } from '../lib/data';
import { CONTIGUOUS_BOUNDS, geoKey, shortLabel, type Bbox, type GeoIndex } from '../lib/geo';
import { contrastRatio, linesFadeInto, type MapTheme } from '../lib/mapTheme';
import { TINY_COMPACT_QUERY, useMediaQuery } from '../lib/media';
import { testHooksEnabled } from '../lib/testHooks';
import { Graticule } from './Graticule';
import { LocatorInsets } from './LocatorInsets';

setWorkerUrl(workerUrl);


export interface MapViewProps {
  geo: GeoIndex;
  /** The layer that responds to hover and click, carries labels and the theme. */
  activeLayer: Layer;
  selectedKey: string | null;
  theme: MapTheme | null;
  /** When this string changes the view fits `fitBbox` (or the contiguous states when null). */
  fitKey: string;
  fitBbox: Bbox | null;
  padding: MapPadding;
  onSelect: (key: string) => void;
  onBoundaryError: (layer: Layer, message: string) => void;
  /** Called when a layer's boundaries have loaded, so an earlier error for that layer can be cleared. */
  onBoundaryLoaded?: (layer: Layer) => void;
  children?: ReactNode;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const NONE: FilterSpecification = ['==', ['get', 'GEOID'], '__none__'];
const FONT = ['Noto Sans Medium'];

/** A colour token as the map stage defines it: the stage is the night side of the site and has its own values (tokens.css). */
function token(name: string): string {
  const scope = document.querySelector('.mapstage') ?? document.documentElement;
  return getComputedStyle(scope).getPropertyValue(name).trim() || '#000000';
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Area-weighted centroid of the largest outer ring: a stable, cheap label anchor. */
export function labelPoint(geometry: Geometry): Position | null {
  const polygons: Position[][][] = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  let best: { area: number; point: Position } | null = null;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!ring || ring.length < 4) continue;
    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, y0] = ring[i] as [number, number];
      const [x1, y1] = ring[i + 1] as [number, number];
      const cross = x0 * y1 - x1 * y0;
      twiceArea += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    const area = Math.abs(twiceArea / 2);
    if (area === 0) continue;
    const point: Position = [cx / (3 * twiceArea), cy / (3 * twiceArea)];
    if (!best || area > best.area) best = { area, point };
  }
  return best ? best.point : null;
}

/** The centroid and the area (in square degrees) of every outer ring of a geometry. */
function ringCentroids(geometry: Geometry): Array<{ area: number; point: Position }> {
  const polygons: Position[][][] = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const rings: Array<{ area: number; point: Position }> = [];
  for (const polygon of polygons) {
    const point = labelPoint({ type: 'Polygon', coordinates: polygon });
    const ring = polygon[0];
    if (!point || !ring) continue;
    let twiceArea = 0;
    for (let i = 0; i < ring.length - 1; i += 1) twiceArea += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    rings.push({ area: Math.abs(twiceArea / 2), point });
  }
  return rings;
}

const inside = (point: Position, [west, south, east, north]: Bbox, margin = 0) =>
  point[0]! >= west - margin && point[0]! <= east + margin && point[1]! >= south - margin && point[1]! <= north + margin;

/**
 * Where a circuit's number is written. A circuit is made of states that need not touch: the Ninth has Alaska, Hawaii
 * and two territories in the Pacific besides its states on the mainland. The number is written once on the largest
 * part among the contiguous states, and once on each state or territory of the circuit that lies far from them, so
 * that a reader who has flown to Alaska or Puerto Rico still sees which circuit it is in.
 */
function circuitLabelPoints(geometry: Geometry, geo: GeoIndex): Position[] {
  const rings = ringCentroids(geometry).sort((a, b) => b.area - a.area);
  const points: Position[] = [];
  const main = rings.find((ring) => inside(ring.point, CONTIGUOUS_BOUNDS));
  if (main) points.push(main.point);
  for (const state of geo.all('state')) {
    if (inside([state.bbox[0], state.bbox[1]], CONTIGUOUS_BOUNDS, 1) && inside([state.bbox[2], state.bbox[3]], CONTIGUOUS_BOUNDS, 1)) continue;
    const part = rings.find((ring) => inside(ring.point, state.bbox));
    if (part && part !== main) points.push(part.point);
  }
  if (points.length === 0 && rings[0]) points.push(rings[0].point);
  return points;
}

/** Fills on which the light label would not be read: the name is written in the dark ink there. */
const LABEL_CONTRAST = 3;

/**
 * The units of a theme whose fill is too light for the stage's light label. A unit without a fill lies on the dark
 * land and keeps the light label.
 */
function lightFilled(theme: MapTheme | null, layer: Layer, label: string): ReadonlySet<string> {
  const units = new Set<string>();
  if (!theme || theme.layer !== layer) return units;
  const light = theme.classes.map((item) => contrastRatio(label, token(item.token)) < LABEL_CONTRAST);
  for (const [geoid, index] of theme.classOf) if (light[index]) units.add(geoid);
  return units;
}

function labelCollection(collection: UnitCollection, layer: Layer, geo: GeoIndex, onLight: ReadonlySet<string> = new Set()): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  // The country as a whole carries no label: it is never the layer the reader picks units from.
  if (layer === 'nation') return { type: 'FeatureCollection', features };
  for (const feature of collection.features) {
    const unit = geo.get(geoKey(layer, feature.properties.GEOID));
    if (!unit) continue;
    const point = labelPoint(feature.geometry);
    const points = layer === 'circuit' ? circuitLabelPoints(feature.geometry, geo) : point ? [point] : [];
    for (const coordinates of points) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { label: shortLabel(unit), GEOID: unit.geoid, tone: onLight.has(unit.geoid) ? 'dark' : 'light' } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function hatchImage(color: string): ImageData | null {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.strokeStyle = color;
  context.lineWidth = 1.6;
  context.globalAlpha = 0.5;
  for (const offset of [-size, 0, size]) {
    context.beginPath();
    context.moveTo(offset, size);
    context.lineTo(offset + size, 0);
    context.stroke();
  }
  return context.getImageData(0, 0, size, size);
}

function fillExpression(theme: MapTheme | null, layer: Layer): ExpressionSpecification | string {
  const transparent = 'rgba(0,0,0,0)';
  if (!theme || theme.layer !== layer || theme.classOf.size === 0) return transparent;
  const groups = theme.classes.map(() => [] as string[]);
  for (const [geoid, index] of theme.classOf) groups[index]?.push(geoid);
  const expression: unknown[] = ['match', ['get', 'GEOID']];
  groups.forEach((ids, index) => {
    if (ids.length > 0) expression.push(ids, token(theme.classes[index]!.token));
  });
  expression.push(transparent);
  return expression.length > 3 ? (expression as ExpressionSpecification) : transparent;
}

function hatchFilter(theme: MapTheme | null, layer: Layer): FilterSpecification {
  if (!theme || theme.layer !== layer || !theme.hatch) return NONE;
  if (theme.hatch.geoids === 'rest') {
    const known = [...theme.classOf.keys()];
    return known.length > 0 ? ['!', ['in', ['get', 'GEOID'], ['literal', known]]] : ['has', 'GEOID'];
  }
  return ['in', ['get', 'GEOID'], ['literal', [...theme.hatch.geoids]]];
}

/** The twelve circuits are few and large, so their numbers show at every zoom. The country as a whole has no label. */
const LABEL_MIN_ZOOM: Record<Layer, number> = { nation: 24, circuit: 1.2, state: 2.6, county: 6.6, cd119: 4.8, cd120: 4.8 };

/** Boundary lines that can sit on a theme's fill, with the ink each is drawn in when there is no fill. */
/** The unit under the pointer: an outline and a wash of light over its fill. */
function setHover(map: MapLibreMap, layer: Layer, filter: FilterSpecification): void {
  map.setFilter(`${layer}-hover`, filter);
  if (map.getLayer(`${layer}-hover-fill`)) map.setFilter(`${layer}-hover-fill`, filter);
}

const UNIT_LINES: ReadonlyArray<{ id: string; casing: string; layer: Layer | 'any'; ink: string }> = [
  { id: 'county-line', casing: 'county-casing', layer: 'county', ink: '--ink-3' },
  { id: 'cd119-line', casing: 'cd119-casing', layer: 'cd119', ink: '--geo' },
  { id: 'cd120-line', casing: 'cd120-casing', layer: 'cd120', ink: '--geo' },
  // State lines are drawn over every layer, so they meet whichever layer is shaded.
  { id: 'state-line', casing: 'state-casing', layer: 'any', ink: '--ink' },
  // Circuit lines are drawn over the state lines: a circuit's edge is a state line drawn heavier.
  { id: 'circuit-line', casing: 'circuit-casing', layer: 'circuit', ink: '--ink' },
];

export function MapView(props: MapViewProps) {
  const { geo, activeLayer, selectedKey, theme, fitKey, fitBbox, padding, onSelect, onBoundaryError, onBoundaryLoaded } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const collections = useRef(new Map<Layer, UnitCollection>());
  const requested = useRef(new Set<Layer>());
  const latest = useRef({ activeLayer, onSelect, onBoundaryError, onBoundaryLoaded, geo, theme, padding });
  latest.current = { activeLayer, onSelect, onBoundaryError, onBoundaryLoaded, geo, theme, padding };
  /** The bounds last fitted by the app, the request they were fitted for, and whether the reader has moved the map since. */
  const lastFit = useRef<Bbox>(CONTIGUOUS_BOUNDS);
  const lastFitKey = useRef<string | null>(null);
  const userMoved = useRef(false);
  /** The colouring last drawn, so that a new one is faded in and the same one, drawn again, is not. */
  const lastShading = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [loadedLayers, setLoadedLayers] = useState<readonly Layer[]>([]);
  const [states, setStates] = useState<UnitCollection | null>(null);
  const [zoomedIn, setZoomedIn] = useState(false);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: {
          version: 8,
          glyphs: `${new URL(`${import.meta.env.BASE_URL}fonts/`, window.location.href).href}{fontstack}/{range}.pbf`,
          sources: {},
          // The water is the ground of the stage itself, painted in CSS; the map lays nothing over it.
          layers: [{ id: 'water', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } }],
        },
        bounds: CONTIGUOUS_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        minZoom: 1.2,
        maxZoom: 12,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        rollEnabled: false,
        attributionControl: false,
        maplibreLogo: false,
        renderWorldCopies: true,
      });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    const canvas = map.getCanvas();
    canvas.setAttribute('aria-label', 'Map of the United States. Use arrow keys to pan and plus or minus to zoom. Every place on the map can also be reached with the search box and the lists in the panel.');

    map.on('load', () => {
      const ink = token('--ink');
      const land = token('--land');
      const hatch = hatchImage(token('--ink-3'));
      if (hatch) map.addImage('hatch', hatch, { pixelRatio: 2 });
      for (const layer of LAYERS) map.addSource(`src-${layer}`, { type: 'geojson', data: EMPTY, promoteId: 'GEOID' });
      map.addSource('src-labels', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'land', type: 'fill', source: 'src-state', paint: { 'fill-color': land } });
      for (const layer of LAYERS) {
        map.addLayer({ id: `${layer}-fill`, type: 'fill', source: `src-${layer}`, layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-outline-color': 'rgba(0,0,0,0)' } });
        map.addLayer({ id: `${layer}-hatch`, type: 'fill', source: `src-${layer}`, filter: NONE, layout: { visibility: 'none' }, paint: { 'fill-pattern': 'hatch' } });
        map.addLayer({ id: `${layer}-hover-fill`, type: 'fill', source: `src-${layer}`, filter: NONE, paint: { 'fill-color': ink, 'fill-opacity': 0.16 } });
      }
      map.addLayer({ id: 'county-context', type: 'line', source: 'src-county', minzoom: 5.6, layout: { visibility: 'none' }, paint: { 'line-color': token('--rule-strong'), 'line-width': 0.5 } });
      // Each boundary line has a land-coloured casing under it, shown only where the line would fade into a fill.
      map.addLayer({ id: 'county-casing', type: 'line', source: 'src-county', layout: { visibility: 'none' }, paint: { 'line-color': land, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.75, 7, 2.2] } });
      map.addLayer({ id: 'county-line', type: 'line', source: 'src-county', layout: { visibility: 'none' }, paint: { 'line-color': token('--ink-3'), 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.25, 7, 0.8] } });
      for (const layer of ['cd119', 'cd120'] as const) {
        map.addLayer({ id: `${layer}-casing`, type: 'line', source: `src-${layer}`, layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': land, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 8, 3.4] } });
        map.addLayer({ id: `${layer}-line`, type: 'line', source: `src-${layer}`, layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': token('--geo'), 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.4] } });
      }
      map.addLayer({ id: 'state-casing', type: 'line', source: 'src-state', layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': land, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 6, 2.6, 10, 3.4] } });
      map.addLayer({ id: 'state-line', type: 'line', source: 'src-state', layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 1.2, 10, 1.8] } });
      map.addLayer({ id: 'circuit-casing', type: 'line', source: 'src-circuit', layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': land, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 4.6, 10, 5.6] } });
      map.addLayer({ id: 'circuit-line', type: 'line', source: 'src-circuit', layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 6, 2.4, 10, 3.2] } });
      for (const layer of LAYERS) {
        map.addLayer({ id: `${layer}-hover`, type: 'line', source: `src-${layer}`, filter: NONE, layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': 2 } });
        map.addLayer({ id: `${layer}-selected-halo`, type: 'line', source: `src-${layer}`, filter: NONE, layout: { 'line-join': 'round' }, paint: { 'line-color': land, 'line-width': 6 } });
        map.addLayer({ id: `${layer}-selected`, type: 'line', source: `src-${layer}`, filter: NONE, layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': 3 } });
      }
      map.addLayer({
        id: 'labels', type: 'symbol', source: 'src-labels',
        layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10.5, 8, 13], 'text-padding': 3, 'text-max-width': 7 },
        // A name is light with a dark edge on the dark land and on a saturated fill, and dark with a light edge on a pale fill.
        paint: {
          'text-color': ['case', ['==', ['get', 'tone'], 'dark'], token('--water'), ink],
          'text-halo-color': ['case', ['==', ['get', 'tone'], 'dark'], 'rgba(255,255,255,0.6)', land],
          'text-halo-width': ['case', ['==', ['get', 'tone'], 'dark'], 1, 1.4],
        },
      });

      for (const layer of LAYERS) {
        map.on('mousemove', `${layer}-fill`, (event: MapLayerMouseEvent) => {
          if (latest.current.activeLayer !== layer) return;
          const feature = event.features?.[0];
          const geoid = (feature?.properties as UnitProperties | undefined)?.GEOID;
          const tooltip = tooltipRef.current;
          if (!geoid || !tooltip) return;
          setHover(map, layer, ['==', ['get', 'GEOID'], geoid]);
          map.getCanvas().style.cursor = 'pointer';
          const unit = latest.current.geo.get(geoKey(layer, geoid));
          const current = latest.current.theme;
          let detail = '';
          if (current && current.layer === layer) {
            const index = current.classOf.get(geoid);
            const own = current.detailOf?.get(geoid);
            if (own) detail = own;
            else if (index !== undefined) detail = current.classes[index]?.label ?? '';
            else if (current.hatch && (current.hatch.geoids === 'rest' || current.hatch.geoids.has(geoid))) detail = current.hatch.label;
            else if (current.plain) detail = current.plain;
          }
          tooltip.replaceChildren();
          const name = document.createElement('strong');
          name.textContent = unit?.name ?? geoid;
          tooltip.append(name);
          if (detail) {
            const line = document.createElement('span');
            line.textContent = detail;
            tooltip.append(line);
          }
          tooltip.hidden = false;
          const flip = event.point.x > map.getContainer().clientWidth - 260;
          tooltip.style.transform = `translate(${Math.round(event.point.x + (flip ? -14 : 14))}px, ${Math.round(event.point.y + 14)}px)${flip ? ' translateX(-100%)' : ''}`;
        });
        map.on('mouseleave', `${layer}-fill`, () => {
          setHover(map, layer, NONE);
          map.getCanvas().style.cursor = '';
          if (tooltipRef.current) tooltipRef.current.hidden = true;
        });
        map.on('click', `${layer}-fill`, (event: MapLayerMouseEvent) => {
          if (latest.current.activeLayer !== layer) return;
          const geoid = (event.features?.[0]?.properties as UnitProperties | undefined)?.GEOID;
          if (geoid) latest.current.onSelect(geoKey(layer, geoid));
        });
      }
      map.on('zoomend', () => setZoomedIn(map.getZoom() >= 5.4));
      setReady(true);
    });

    map.on('movestart', (event) => {
      if ((event as { originalEvent?: unknown }).originalEvent) userMoved.current = true;
      // Whatever moves the map (keys, a drag, a fit), the unit under the pointer changes: drop the stale tooltip and hover line.
      if (tooltipRef.current) tooltipRef.current.hidden = true;
      for (const layer of LAYERS) if (map.getLayer(`${layer}-hover`)) setHover(map, layer, NONE);
    });
    // When the stage changes size (window resize, or the phone layout's sheet moving),
    // keep the fitted area in view unless the reader has taken over the camera.
    const observer = new ResizeObserver(() => {
      map.resize();
      if (userMoved.current || container.clientWidth < 40 || container.clientHeight < 40) return;
      const [w, s, e, n] = lastFit.current;
      map.fitBounds([[w, s], [e, n]], { padding: safePadding(latest.current.padding, container), maxZoom: 9.5, duration: 0 });
    });
    observer.observe(container);
    if (testHooksEnabled()) {
      (window as unknown as { __dhqMap?: MapLibreMap }).__dhqMap = map;
    }
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // On a very short screen the page scrolls as one document and the map fills most of a screen, so the mouse wheel
  // scrolls the page there instead of zooming the map. The zoom buttons, the keyboard, a double click and a pinch still zoom.
  const pageScrolls = useMediaQuery(TINY_COMPACT_QUERY);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (pageScrolls) map.scrollZoom.disable();
    else map.scrollZoom.enable();
  }, [pageScrolls, ready]);

  // Which boundary layers are needed right now.
  const selectedLayer = selectedKey ? (selectedKey.split(':')[0] as Layer) : null;
  const needed = useMemo(() => {
    const set = new Set<Layer>(['state', activeLayer]);
    if (selectedLayer && (LAYERS as readonly string[]).includes(selectedLayer)) set.add(selectedLayer);
    if (zoomedIn) set.add('county');
    return [...set].sort();
  }, [activeLayer, selectedLayer, zoomedIn]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const layer of needed) {
      if (requested.current.has(layer)) continue;
      requested.current.add(layer);
      const info = geo.layers[layer];
      loadBoundaries(layer, info.file, info.object).then(
        (collection) => {
          if (mapRef.current !== map) return;
          collections.current.set(layer, collection);
          (map.getSource(`src-${layer}`) as GeoJSONSource | undefined)?.setData(collection);
          if (layer === 'state') setStates(collection);
          setLoadedLayers((previous) => (previous.includes(layer) ? previous : [...previous, layer]));
          latest.current.onBoundaryLoaded?.(layer);
        },
        (error: unknown) => {
          requested.current.delete(layer);
          latest.current.onBoundaryError(layer, error instanceof Error ? error.message : String(error));
        },
      );
    }
  }, [needed, ready, geo]);

  // Layer visibility, theme and labels.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const layer of LAYERS) {
      const active = layer === activeLayer;
      map.setLayoutProperty(`${layer}-fill`, 'visibility', active ? 'visible' : 'none');
      map.setPaintProperty(`${layer}-fill`, 'fill-color', fillExpression(active ? theme : null, layer));
      const filter = hatchFilter(active ? theme : null, layer);
      map.setFilter(`${layer}-hatch`, filter);
      map.setLayoutProperty(`${layer}-hatch`, 'visibility', active && filter !== NONE ? 'visible' : 'none');
      if (!active) setHover(map, layer, NONE);
    }
    map.setLayoutProperty('county-line', 'visibility', activeLayer === 'county' ? 'visible' : 'none');
    map.setLayoutProperty('county-context', 'visibility', activeLayer === 'state' ? 'visible' : 'none');
    map.setLayoutProperty('cd119-line', 'visibility', activeLayer === 'cd119' ? 'visible' : 'none');
    map.setLayoutProperty('cd120-line', 'visibility', activeLayer === 'cd120' ? 'visible' : 'none');
    map.setLayoutProperty('circuit-line', 'visibility', activeLayer === 'circuit' ? 'visible' : 'none');
    // Under the circuits the state lines step back, so the heavier circuit lines read as the grouping of the states.
    map.setPaintProperty('state-line', 'line-opacity', activeLayer === 'circuit' ? 0.4 : 1);
    // Lines that would fade into the active fill (brown district lines on the darkest population class, for one)
    // are drawn in ink over a land casing, so every boundary stays visible on every class.
    const fills = theme && theme.layer === activeLayer && theme.classOf.size > 0 ? theme.classes.map((c) => token(c.token)) : [];
    for (const line of UNIT_LINES) {
      const visible = line.layer === 'any' || line.layer === activeLayer;
      const cased = visible && linesFadeInto(token(line.ink), fills);
      map.setPaintProperty(line.id, 'line-color', token(cased ? '--ink' : line.ink));
      map.setLayoutProperty(line.casing, 'visibility', cased ? 'visible' : 'none');
    }
    // A new colouring comes up out of the dark; the same colouring drawn again (more data arrived) does not flicker.
    const shading = `${activeLayer}|${theme && theme.layer === activeLayer ? theme.id : ''}`;
    if (shading !== lastShading.current) {
      const first = lastShading.current === null;
      lastShading.current = shading;
      if (!first && !prefersReducedMotion()) {
        const fill = `${activeLayer}-fill`;
        map.setPaintProperty(fill, 'fill-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty(fill, 'fill-opacity', 0);
        window.setTimeout(() => {
          if (mapRef.current !== map || !map.getLayer(fill)) return;
          map.setPaintProperty(fill, 'fill-opacity-transition', { duration: 420, delay: 0 });
          map.setPaintProperty(fill, 'fill-opacity', 1);
        }, 40);
      }
    }
    const collection = collections.current.get(activeLayer);
    (map.getSource('src-labels') as GeoJSONSource | undefined)?.setData(collection ? labelCollection(collection, activeLayer, geo, lightFilled(theme, activeLayer, token('--ink'))) : EMPTY);
    map.setLayerZoomRange('labels', LABEL_MIN_ZOOM[activeLayer], 24);
    if (tooltipRef.current) tooltipRef.current.hidden = true;
  }, [activeLayer, theme, ready, loadedLayers, geo]);

  // Selection outline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const [layerName, geoid] = selectedKey ? selectedKey.split(':') : [null, null];
    for (const layer of LAYERS) {
      const filter: FilterSpecification = layer === layerName && geoid ? ['==', ['get', 'GEOID'], geoid] : NONE;
      map.setFilter(`${layer}-selected`, filter);
      map.setFilter(`${layer}-selected-halo`, filter);
    }
  }, [selectedKey, ready]);

  // Fit to the requested bounds.
  const paddingKey = `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // The same request with other padding (a control grew or shrank): the area in view stays the one last fitted,
    // which may be one a locator button flew to, and a reader who has moved the map keeps the camera.
    const samePlace = lastFitKey.current === fitKey;
    if (samePlace && userMoved.current) return;
    lastFitKey.current = fitKey;
    const bbox = samePlace ? lastFit.current : fitBbox ?? CONTIGUOUS_BOUNDS;
    lastFit.current = bbox;
    userMoved.current = false;
    const [w, s, e, n] = bbox;
    map.fitBounds([[w, s], [e, n]], { padding: safePadding(padding, map.getContainer()), maxZoom: 9.5, duration: prefersReducedMotion() ? 0 : 650 });
    // `padding` is represented by paddingKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready, paddingKey]);

  const flyTo = (bbox: Bbox) => {
    const map = mapRef.current;
    if (!map) return;
    lastFit.current = bbox;
    userMoved.current = false;
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: safePadding(padding, map.getContainer()), maxZoom: 9.5, duration: prefersReducedMotion() ? 0 : 650 });
  };
  const zoomBy = (delta: 1 | -1) => {
    userMoved.current = true;
    if (delta > 0) mapRef.current?.zoomIn();
    else mapRef.current?.zoomOut();
  };

  if (failed) {
    return (
      <div className="map-fallback" role="status">
        <h2>The interactive map could not start</h2>
        <p>This browser did not provide WebGL, which the map needs. Nothing is lost: every state, county and district is reachable through the search box, and all records are listed in the panel.</p>
        <p className="quiet">Technical detail: {failed}</p>
      </div>
    );
  }

  return (
    <>
      <div ref={containerRef} className="map-canvas" data-ready={ready ? 'true' : 'false'} data-layers={loadedLayers.join(' ')} />
      {mapRef.current && ready ? <Graticule map={mapRef.current} /> : null}
      {!ready ? <p className="map-loading" role="status">Loading the map</p> : null}
      <div ref={tooltipRef} className="map-tooltip" hidden aria-hidden="true" />
      <div className="map-zoom" role="group" aria-label="Map zoom">
        <button type="button" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(-1)} aria-label="Zoom out">&minus;</button>
      </div>
      <LocatorInsets geo={geo} states={states} onGo={flyTo} />
      {props.children}
    </>
  );
}

export { safePadding, type MapPadding };
