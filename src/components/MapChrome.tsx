/** Floating map controls: what the map shows (a level of government or the federal courts), and the legend with vintage and freshness. */
import { useEffect, useId, useRef } from 'react';
import type { Court, Layer, SourceRecord } from '../types/schemas';
import { FEDERAL_CIRCUIT_ID, courtShortName } from '../lib/courts';
import { formatDate } from '../lib/format';
import { sourceFreshness } from '../lib/freshness';
import type { GeoIndex } from '../lib/geo';
import type { MapTheme } from '../lib/mapTheme';
import { buildHash } from '../lib/router';
import { Icon } from './ui';

/**
 * What the reader has the map show. Four are levels of government: the country as a whole, where the measures of
 * Congress belong, and the three kinds of boundary below it. Two are the federal courts: the Supreme Court, whose
 * decisions bind the whole country, and the judicial circuits of the courts of appeals.
 */
export type MapChoice = 'federal' | 'state' | 'county' | 'district' | 'supreme' | 'circuit';
export type DistrictPlan = 'cd119' | 'cd120';

const LEVELS: ReadonlyArray<readonly [MapChoice, string]> = [['federal', 'Federal'], ['state', 'States'], ['county', 'Counties'], ['district', 'Districts']];
const COURTS: ReadonlyArray<readonly [MapChoice, string]> = [['supreme', 'Supreme Court'], ['circuit', 'Circuits']];
const PLANS: ReadonlyArray<readonly [DistrictPlan, string]> = [['cd120', '2026 elections'], ['cd119', '119th Congress']];

export interface LayerControlProps {
  choice: MapChoice;
  /** The district plan drawn when the choice is "district". */
  plan: DistrictPlan;
  /** The court of appeals whose page is open, or "" while all circuits are shown. */
  circuit: string;
  /** The thirteen courts of appeals, for the circuit menu. Empty until the list of courts has loaded. */
  courts: readonly Court[];
  /** A phone-sized screen: the choices fold into menus, so the control does not cover the small map. */
  compact: boolean;
  onChoice: (choice: MapChoice) => void;
  onPlan: (plan: DistrictPlan) => void;
  /** A court id, or "" for all circuits. */
  onCircuit: (courtId: string) => void;
  /** Told where the control ends, in CSS pixels from the top of the map, whenever its size changes, so the map can keep the area under it clear. */
  onExtent?: (bottom: number) => void;
}

/** The menu names the court that is open even before the list of courts has loaded: its name is fixed by its id. */
function circuitOptions(courts: readonly Court[], open: string) {
  return (
    <>
      <option value="">All circuits</option>
      {open && !courts.some((court) => court.id === open) ? <option value={open}>{courtShortName(undefined, open)}</option> : null}
      {courts.map((court) => (
        <option key={court.id} value={court.id}>
          {courtShortName(court, court.id)}{court.id === FEDERAL_CIRCUIT_ID ? ' (no area on the map)' : ''}
        </option>
      ))}
    </>
  );
}

export function LayerControl({ choice, plan, circuit, courts, compact, onChoice, onPlan, onCircuit, onExtent }: LayerControlProps) {
  const choiceId = useId();
  const planId = useId();
  const circuitId = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const report = useRef(onExtent);
  report.current = onExtent;
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => report.current?.(Math.round(element.offsetTop + element.offsetHeight)));
    observer.observe(element);
    return () => observer.disconnect();
    // The element changes with the layout (menus on a phone, buttons elsewhere).
  }, [compact]);

  if (compact) {
    return (
      <div className="layer-control layer-control-compact" ref={box}>
        <label className="sr-only" htmlFor={choiceId}>Map shows</label>
        <select id={choiceId} value={choice} onChange={(event) => onChoice(event.target.value as MapChoice)}>
          <optgroup label="Level">{LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>
          <optgroup label="Courts">{COURTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>
        </select>
        {choice === 'district' ? (
          <>
            <label className="sr-only" htmlFor={planId}>District plan</label>
            <select id={planId} value={plan} onChange={(event) => onPlan(event.target.value as DistrictPlan)}>
              {PLANS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </>
        ) : null}
        {choice === 'circuit' ? (
          <>
            <label className="sr-only" htmlFor={circuitId}>Circuit</label>
            <select id={circuitId} value={circuit} onChange={(event) => onCircuit(event.target.value)}>{circuitOptions(courts, circuit)}</select>
          </>
        ) : null}
      </div>
    );
  }

  // The six choices are one set of radio buttons in two labelled groups. Pressing the choice that is already on
  // still leads to its own page, for a reader who is on a record of that level (a bill of Congress, a case of a circuit).
  const radios = (items: ReadonlyArray<readonly [MapChoice, string]>) => items.map(([value, label]) => (
    <label key={value} className={choice === value ? 'is-on' : undefined}>
      <input type="radio" name="map-choice" checked={choice === value} onChange={() => onChoice(value)} onClick={() => { if (choice === value) onChoice(value); }} />
      <span>{label}</span>
    </label>
  ));
  return (
    <div className="layer-control" ref={box}>
      <div className="layer-groups">
        <fieldset>
          <legend>Level</legend>
          <div className="seg">{radios(LEVELS)}</div>
        </fieldset>
        <fieldset>
          <legend>Courts</legend>
          <div className="seg">{radios(COURTS)}</div>
        </fieldset>
      </div>
      {choice === 'district' ? (
        <fieldset>
          <legend>District plan</legend>
          <div className="seg">
            {PLANS.map(([value, label]) => (
              <label key={value} className={plan === value ? 'is-on' : undefined}>
                <input type="radio" name="map-vintage" checked={plan === value} onChange={() => onPlan(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {choice === 'circuit' ? (
        <div className="layer-sub">
          <label htmlFor={circuitId}>Circuit</label>
          <select id={circuitId} value={circuit} onChange={(event) => onCircuit(event.target.value)}>{circuitOptions(courts, circuit)}</select>
        </div>
      ) : null}
    </div>
  );
}

export function Legend({ theme, layer, geo, sources, now, boundaryError, startOpen, emptyNote }: {
  theme: MapTheme | null; layer: Layer; geo: GeoIndex; sources: readonly SourceRecord[]; now: string; boundaryError: string | null; startOpen: boolean;
  /** What to say when nothing is shaded, where the view has more to say than the general sentence. */
  emptyNote?: string | null;
}) {
  const info = geo.layers[layer];
  const source = sources.find((s) => s.id === info.sourceId);
  const freshness = source ? sourceFreshness(source, now) : null;
  const applies = theme && theme.layer === layer;
  return (
    <details className="legend" open={startOpen || undefined}>
      <summary className={applies ? 'has-key' : undefined}>
        Legend<span className="legend-summary-rest"> and data currency</span>
        {/* A closed legend still shows the colours in use, so a shaded map is never shown without a hint of its key. */}
        {applies ? (
          <span className="legend-key" aria-hidden="true">
            <span className="legend-key-ramp">{theme.classes.map((item, i) => <span key={i} className="swatch" style={{ background: `var(${item.token})` }} />)}</span>
            {theme.plain ? <span className="swatch swatch-plain" /> : null}
            {theme.hatch ? <span className="swatch swatch-hatch" /> : null}
          </span>
        ) : null}
      </summary>
      <div className="legend-body">
        {applies ? (
          <>
            <p className="legend-title">{theme.title}</p>
            <ul className="legend-classes">
              {theme.classes.map((item, i) => (
                <li key={i}><span className="swatch" style={{ background: `var(${item.token})` }} />{item.label}</li>
              ))}
              {theme.plain ? <li className="legend-plain"><span className="swatch swatch-plain" />{theme.plain}</li> : null}
              {theme.hatch ? <li className="legend-hatch"><span className="swatch swatch-hatch" />{theme.hatch.label}</li> : null}
            </ul>
          </>
        ) : (
          <p className="legend-note">{emptyNote ?? 'No shading. Select a unit to open its records.'}</p>
        )}
        {boundaryError ? <p className="legend-error" role="alert"><Icon name="warn" />These boundaries could not be loaded. {boundaryError}</p> : null}
        {freshness ? (
          <p className={`legend-fresh fresh-${freshness.state}`}>
            {freshness.state !== 'fresh' ? <Icon name="warn" /> : null}
            Boundary data: {freshness.label.charAt(0).toLowerCase() + freshness.label.slice(1)}. <a href={buildHash(['sources'], { section: 'sources' })}>All sources</a>
          </p>
        ) : null}
        <details className="legend-more">
          <summary>Boundary vintage and notes</summary>
          <p className="legend-vintage">
            <span className={`line-sample line-${layer}`} />
            {info.label}. {info.vintage}, U.S. Census Bureau. Source file dated {formatDate(info.sourcePublishedAt)} (the server&rsquo;s date for the current file).
          </p>
          {applies && theme.note ? <p className="legend-note">{theme.note}</p> : null}
        </details>
      </div>
    </details>
  );
}
