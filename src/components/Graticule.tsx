/**
 * Survey-sheet margin: longitude and latitude ticks along the top and left
 * edges of the map, updated as the view moves. Because the map never rotates
 * or tilts, a meridian is a vertical line and a parallel a horizontal one, so
 * each tick is exact for the whole edge.
 */
import { useEffect, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

interface Tick { position: number; label: string }

const STEPS = [30, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];

export function chooseStep(span: number, target = 6): number {
  for (const step of STEPS) if (span / step >= target) return step;
  return STEPS[STEPS.length - 1]!;
}

function trim(value: number): string {
  return String(Math.round(Math.abs(value) * 100) / 100);
}

export function formatLongitude(lng: number): string {
  let wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180) wrapped = 180;
  if (Math.abs(wrapped) < 1e-9) return '0°';
  if (Math.abs(wrapped - 180) < 1e-9) return '180°';
  return `${trim(wrapped)}°${wrapped < 0 ? 'W' : 'E'}`;
}

export function formatLatitude(lat: number): string {
  if (Math.abs(lat) < 1e-9) return '0°';
  return `${trim(lat)}°${lat < 0 ? 'S' : 'N'}`;
}

function compute(map: MapLibreMap): { width: number; height: number; meridians: Tick[]; parallels: Tick[] } {
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  const bounds = map.getBounds();
  const center = map.getCenter();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = Math.max(-85, bounds.getSouth());
  const north = Math.min(85, bounds.getNorth());
  const meridians: Tick[] = [];
  const parallels: Tick[] = [];
  const lngStep = chooseStep(east - west, Math.max(3, Math.round(width / 150)));
  for (let lng = Math.ceil(west / lngStep) * lngStep; lng <= east && meridians.length < 40; lng += lngStep) {
    const x = map.project([lng, center.lat]).x;
    if (x > 46 && x < width - 30) meridians.push({ position: x, label: formatLongitude(lng) });
  }
  const latStep = chooseStep(north - south, Math.max(3, Math.round(height / 130)));
  for (let lat = Math.ceil(south / latStep) * latStep; lat <= north && parallels.length < 40; lat += latStep) {
    const y = map.project([center.lng, lat]).y;
    if (y > 30 && y < height - 20) parallels.push({ position: y, label: formatLatitude(lat) });
  }
  return { width, height, meridians, parallels };
}

export function Graticule({ map }: { map: MapLibreMap }) {
  const [state, setState] = useState(() => compute(map));
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setState(compute(map));
      });
    };
    const moveSubscription = map.on('move', update);
    const resizeSubscription = map.on('resize', update);
    update();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      moveSubscription.unsubscribe();
      resizeSubscription.unsubscribe();
    };
  }, [map]);

  return (
    <svg className="graticule" width={state.width} height={state.height} aria-hidden="true" focusable="false">
      {state.meridians.map((tick) => (
        <g key={`m${tick.label}`} transform={`translate(${tick.position.toFixed(1)} 0)`}>
          <line y1="0" y2="7" />
          <text y="18" textAnchor="middle">{tick.label}</text>
        </g>
      ))}
      {state.parallels.map((tick) => (
        <g key={`p${tick.label}`} transform={`translate(0 ${tick.position.toFixed(1)})`}>
          <line x1="0" x2="7" />
          <text x="11" y="3.5">{tick.label}</text>
        </g>
      ))}
    </svg>
  );
}
