/** Floating map controls: which boundaries are shown, and the legend with vintage and freshness. */
import type { Layer, SourceRecord } from '../types/schemas';
import { formatDate } from '../lib/format';
import { sourceFreshness } from '../lib/freshness';
import type { GeoIndex } from '../lib/geo';
import { isDistrictLayer } from '../lib/geo';
import type { MapTheme } from '../lib/mapTheme';
import { buildHash } from '../lib/router';
import { Icon } from './ui';

export function LayerControl({ layer, onChange }: { layer: Layer; onChange: (layer: Layer) => void }) {
  const group = isDistrictLayer(layer) ? 'district' : layer;
  return (
    <div className="layer-control">
      <fieldset>
        <legend>Boundaries</legend>
        <div className="seg">
          {([['state', 'States'], ['county', 'Counties'], ['district', 'Districts']] as const).map(([value, label]) => (
            <label key={value} className={group === value ? 'is-on' : undefined}>
              <input type="radio" name="map-layer" checked={group === value} onChange={() => onChange(value === 'district' ? 'cd120' : value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {isDistrictLayer(layer) ? (
        <fieldset>
          <legend>District plan</legend>
          <div className="seg">
            <label className={layer === 'cd120' ? 'is-on' : undefined}>
              <input type="radio" name="map-vintage" checked={layer === 'cd120'} onChange={() => onChange('cd120')} />
              <span>2026 elections</span>
            </label>
            <label className={layer === 'cd119' ? 'is-on' : undefined}>
              <input type="radio" name="map-vintage" checked={layer === 'cd119'} onChange={() => onChange('cd119')} />
              <span>119th Congress</span>
            </label>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

export function Legend({ theme, layer, geo, sources, now, boundaryError, startOpen }: {
  theme: MapTheme | null; layer: Layer; geo: GeoIndex; sources: readonly SourceRecord[]; now: string; boundaryError: string | null; startOpen: boolean;
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
          <p className="legend-note">No shading. Select a unit to open its records.</p>
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
