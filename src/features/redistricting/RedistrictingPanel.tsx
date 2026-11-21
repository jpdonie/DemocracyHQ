import type { Layer, RedistrictingFile } from '../../types/schemas';
import { useCore } from '../../lib/core';
import { formatDate, formatDateTime } from '../../lib/format';
import { isLayer, type GeoIndex } from '../../lib/geo';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, Ext, Facts, GapNotice, Section, Segmented, TableScroll, TypeMark } from '../../components/ui';

export const LAYER_EXPLAINERS: Readonly<Record<Layer, { title: string; body: string }>> = {
  state: { title: 'States and equivalents', body: 'The 50 states, the District of Columbia, Puerto Rico and the island areas, as of January 1, 2025.' },
  county: { title: 'Counties and equivalents', body: 'Counties, parishes, boroughs, independent cities and Connecticut planning regions, as of January 1, 2025.' },
  cd119: { title: 'Districts of the 119th Congress', body: 'The districts in effect for the Congress that convened in January 2025.' },
  cd120: { title: 'Districts for the 2026 elections', body: 'The districts of the 120th Congress, as collected by the Census Bureau for the 2026 election cycle.' },
};

function StateTable({ geo, redistricting }: { geo: GeoIndex; redistricting: RedistrictingFile }) {
  const redrawn = new Set(redistricting.congress120.statesWithNewBoundaries);
  const states = [...geo.all('state')].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <TableScroll label="Congressional districts by state">
      <table className="table table-num">
        <caption>Congressional districts by state. Select a state to open its workspace.</caption>
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col" className="num">119th</th>
            <th scope="col" className="num">120th</th>
            <th scope="col">New boundaries for 2026, per Census Bureau</th>
          </tr>
        </thead>
        <tbody>
          {states.map((state) => (
            <tr key={state.key}>
              <th scope="row"><a href={buildHash(['place', state.key], { layer: 'cd120' })}>{state.name}</a></th>
              <td className="num">{redistricting.districtCounts.cd119[state.geoid] ?? 'n/a'}</td>
              <td className="num">{redistricting.districtCounts.cd120[state.geoid] ?? 'n/a'}</td>
              <td>{redrawn.has(state.geoid) ? <span className="flag-yes">Yes</span> : <span className="quiet">Not listed</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function RedistrictingPanel({ route, layer }: { route: Route; layer: Layer }) {
  const core = useCore();
  const geo = dataOf(core.geo);
  const info = geo?.layers[layer];
  const sources = dataOf(core.sources) ?? [];
  const source = sources.find((s) => s.id === info?.sourceId);
  const redistrictingData = dataOf(core.redistricting);
  const shade = route.query.shade === 'population' ? 'population' : route.query.shade === 'none' ? 'none' : 'default';
  return (
    <article className="view">
      <header className="view-head">
        <TypeMark type="place" label="Redistricting" />
        <h1 tabIndex={-1}>Districts and boundaries</h1>
        <p className="lede">Official boundaries with their vintage stated, joined to 2020 Census counts only where the counts were tabulated for the same lines.</p>
      </header>

      <Section title="Boundaries on the map">
        <Segmented<Layer>
          label="Show"
          value={layer}
          options={[
            { value: 'cd120', label: '2026 districts' },
            { value: 'cd119', label: '119th Congress' },
            { value: 'county', label: 'Counties' },
            { value: 'state', label: 'States' },
          ]}
          onChange={(value) => { if (isLayer(value)) patchQuery(route, { layer: value }, { replace: false }); }}
        />
        <Segmented
          label="Shade by"
          value={shade}
          options={[
            { value: 'default', label: layer === 'cd119' || layer === 'cd120' ? 'New boundaries' : 'Nothing' },
            { value: 'population', label: 'Population, 2020' },
            ...(layer === 'cd119' || layer === 'cd120' ? [{ value: 'none' as const, label: 'Nothing' }] : []),
          ]}
          onChange={(value) => patchQuery(route, { shade: value === 'default' ? '' : value }, { replace: false })}
        />
        {info ? (
          <>
            <h3>{LAYER_EXPLAINERS[layer].title}</h3>
            <p>{LAYER_EXPLAINERS[layer].body}</p>
            <Facts tight items={[
              ['Vintage', info.vintage],
              ['Units', String(info.featureCount)],
              ['Source file dated', `${formatDate(info.sourcePublishedAt)} (the server’s date for the current file)`],
              ['Source', source ? <Ext href={source.url}>{source.name}</Ext> : info.sourceId],
            ]} />
          </>
        ) : null}
        <p className="hint">Select any unit on the map to open its workspace, or use the table below.</p>
      </Section>

      <Section title="Which states have new congressional boundaries for 2026">
        <Async of={core.redistricting} what="the redistricting summary">
          {(redistricting) => (
            <>
              <figure className="quote-block">
                <blockquote>
                  <p>{redistricting.congress120.quote}.</p>
                  {redistricting.congress120.unchangedQuote ? <p>{redistricting.congress120.unchangedQuote}</p> : null}
                </blockquote>
                <figcaption>
                  U.S. Census Bureau, <Ext href={redistricting.congress120.sourceUrl}>120th Congressional District page</Ext>, read {formatDateTime(redistricting.congress120.checkedAt)}.
                </figcaption>
              </figure>
              {redistricting.congress120.note ? (
                <details className="reading-details">
                  <summary>The Census Bureau&rsquo;s note on Missouri</summary>
                  <div className="reading"><p>{redistricting.congress120.note}</p></div>
                </details>
              ) : null}
              <p className="quiet">This list is the Census Bureau&rsquo;s. DemocracyHQ does not decide which plan is in force; litigation may be pending in any state.</p>
              {geo ? <StateTable geo={geo} redistricting={redistricting} /> : null}
            </>
          )}
        </Async>
      </Section>

      <Section title="What the numbers can and cannot support">
        <ul className="plain-list spaced">
          <li>Population counts come from the 2020 Census. For 119th Congress districts they were retabulated by the Census Bureau for those exact lines.</li>
          <li>For the 2026 districts, counts are shown only in states the Bureau reports as unchanged{redistrictingData ? `, and only where the district's official land area agrees between the two boundary files` : ''}. In the {redistrictingData ? `${redistrictingData.congress120.statesWithNewBoundaries.length} ` : ''}redrawn states they are marked unavailable until the Bureau publishes them.</li>
          <li>Congressional districts are not nested within counties. County overlaps are listed from the Bureau&rsquo;s own county-within-district file, for the 119th Congress only.</li>
          <li>Boundaries are simplified for display at about 1:5,000,000. They are suitable for orientation, not for determining which side of a line an address falls on.</li>
        </ul>
        <GapNotice>State legislative districts and precincts are not loaded yet. Their absence here means nothing about any plan.</GapNotice>
        <p><A to={buildHash(['sources'], { section: 'geography' })}>How boundaries and counts are joined</A></p>
      </Section>
    </article>
  );
}
