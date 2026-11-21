/**
 * Geographic research workspace: everything DemocracyHQ can tie to one state,
 * county or congressional district, with the vintage of every figure stated.
 */
import { useEffect, useMemo, useRef } from 'react';
import { EVENT_CATEGORIES, type EventCategory, type LegalCaseSummary } from '../../types/schemas';
import { billJurisdiction, isFederalBill } from '../../lib/bills';
import { useCore } from '../../lib/core';
import { courtHash, courtShortName } from '../../lib/courts';
import { isoDateParam, positiveInt } from '../../lib/filters';
import { formatDate, formatNumber, formatPercent, formatSignedPercent, plural } from '../../lib/format';
import { sourceFreshness } from '../../lib/freshness';
import { NATION_KEY, isCensusLayer, isDistrictLayer, STATE_ABBR, stateKind, unitNoun, type GeoUnit } from '../../lib/geo';
import { districtDeviation, groupBreakdown, groupsSumToTotal, type PopulationResult } from '../../lib/population';
import { buildHash, patchQuery, shareUrl, type Route } from '../../lib/router';
import { COMPACT_QUERY, useMediaQuery } from '../../lib/media';
import { isPlainClick, revealElement, useRaiseSheet } from '../../lib/sheet';
import { allOf, dataOf } from '../../lib/useLoad';
import { useTagLabels } from '../../lib/labels';
import { A, Async, BackLink, CopyLinkButton, Empty, ErrorHeading, ErrorNote, ExportMenu, Ext, Facts, GapNotice, Loading, Section, Segmented, TableScroll, TabPanel, Tabs, TextField, TypeMark, VerificationBadge, WatchButton } from '../../components/ui';
import { CaseRow, CaseRows } from '../litigation/CaseDirectory';
import { BillRow } from '../legislation/BillDirectory';
import { TimelineList } from './Timeline';
import { buildPlacePack, usePlaceData, type PlaceData, type PlaceEvent, type PlaceLegislation } from './placeData';
import type { LinkedRecord } from '../../lib/relations';

const CATEGORY_NAMES: Readonly<Record<EventCategory, string>> = { litigation: 'Court', legislation: 'Legislature', geography: 'Boundaries' };

function PopulationCard({ result, unit, data }: { result: PopulationResult; unit: GeoUnit; data: PlaceData }) {
  if (result.status === 'unavailable') {
    return (
      <div className="unavailable">
        <p><VerificationBadge status="unavailable" /></p>
        <p>{result.reason}</p>
      </div>
    );
  }
  const { values, dataset } = result;
  const rows = groupBreakdown(values);
  const deviation = isDistrictLayer(unit.layer) && data.populationFile ? districtDeviation(unit.geoid, data.populationFile) : null;
  return (
    <>
      <Facts items={[
        ['Total population', formatNumber(values.total)],
        ['Population 18 and over', `${formatNumber(values.vap_total)}${values.total ? ` (${formatPercent((values.vap_total ?? 0) / values.total)} of total)` : ''}`],
        ...(deviation ? [[
          'Difference from the state’s average district (2020 Census counts)',
          `${formatSignedPercent(deviation.fraction)} (${deviation.persons >= 0 ? '+' : '−'}${plural(Math.abs(Math.round(deviation.persons)), 'person')} against an average of ${formatNumber(Math.round(deviation.ideal))} across ${deviation.districts} districts)`,
        ] as [string, string]] : []),
      ]} />
      {deviation ? (
        <p className="quiet">
          Computed from the published Census counts. Some states draw districts to equal populations on an adjusted base (for example, with incarcerated people counted at their home address), so this difference is not the plan&rsquo;s legal deviation.
        </p>
      ) : null}
      {result.note ? <p className="vintage-note">{result.note}</p> : null}
      <TableScroll label="Race and Hispanic origin">
        <table className="table table-num">
          <caption>Race and Hispanic origin. Race groups exclude people of Hispanic or Latino origin, who are counted once in the first row.</caption>
          <thead><tr><th scope="col">Group</th><th scope="col" className="num">Total</th><th scope="col" className="num">Share</th><th scope="col" className="num">18 and over</th><th scope="col" className="num">Share of 18+</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td className="num">{formatNumber(row.total)}</td>
                <td className="num">{formatPercent(row.share)}</td>
                <td className="num">{formatNumber(row.vap)}</td>
                <td className="num">{formatPercent(row.vapShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {!groupsSumToTotal(values) ? <p className="state state-error" role="alert">The group counts do not add up to the published total. Treat these figures with caution and report the problem.</p> : null}
      <p className="quiet">
        {dataset.title}, tables {dataset.tables}. {dataset.geographyNote} Counts are as of Census Day, April 1, 2020; they are not current estimates. Source file dated {formatDate(dataset.sourcePublishedAt)} (the server&rsquo;s date for it).
      </p>
    </>
  );
}

function UnitLinks({ units, label }: { units: ReadonlyArray<GeoUnit & { partNote?: string | null }>; label: string }) {
  if (units.length === 0) return null;
  return (
    <details className="unit-list">
      <summary>{label}</summary>
      <ul>
        {units.map((unit) => <li key={unit.key}><a href={buildHash(['place', unit.key])}>{unit.name}</a>{unit.partNote ? <span className="quiet"> ({unit.partNote})</span> : null}</li>)}
      </ul>
    </details>
  );
}

function RelatedGeography({ data }: { data: PlaceData }) {
  const { unit, geo } = data;
  const core = useCore();
  const redistricting = dataOf(core.redistricting);
  const state = geo.state(unit.stateFips);
  const redrawn = redistricting ? redistricting.congress120.statesWithNewBoundaries.includes(unit.stateFips) : null;
  const kind = stateKind(unit.stateFips).toLowerCase();
  const redrawnText = redrawn === null ? `Whether this ${kind} has new boundaries for 2026 could not be loaded.`
    : redrawn ? `The Census Bureau lists ${state?.name ?? `this ${kind}`} among the states that delineated new congressional boundaries for the 2026 election cycle.`
    : `The Census Bureau does not list ${state?.name ?? `this ${kind}`} among those with new congressional boundaries for the 2026 election cycle.`;
  if (unit.layer === 'state') {
    const cd120 = geo.inState('cd120', unit.geoid);
    const cd119 = geo.inState('cd119', unit.geoid);
    const counties = geo.inState('county', unit.geoid);
    return (
      <>
        <CircuitOfState data={data} />
        <p>{redrawnText}</p>
        <UnitLinks units={cd120} label={`${plural(cd120.length, 'congressional district')} for the 2026 elections (120th Congress)`} />
        <UnitLinks units={cd119} label={`${plural(cd119.length, 'congressional district')} of the 119th Congress`} />
        <UnitLinks units={counties} label={`${plural(counties.length, 'county', 'counties')} and equivalents, 2025 boundaries`} />
      </>
    );
  }
  const sameNumber = isDistrictLayer(unit.layer) ? geo.get(`${unit.layer === 'cd119' ? 'cd120' : 'cd119'}:${unit.geoid}`) : undefined;
  return (
    <>
      {state ? <p>In <a href={buildHash(['place', state.key])}>{state.name}</a>.</p> : null}
      {isDistrictLayer(unit.layer) ? (
        <>
          <p>{redrawnText}</p>
          {sameNumber ? (
            <p>
              <a href={buildHash(['place', sameNumber.key])}>The district with the same number {unit.layer === 'cd119' ? 'for the 2026 elections (120th Congress)' : 'in the 119th Congress'}</a>.
              {redrawn ? ' The same number can describe a different area under the two plans.' : ''}
            </p>
          ) : <p className="quiet">No district with this number exists in the other Congress&rsquo;s plan.</p>}
        </>
      ) : null}
      {data.overlaps ? (
        <Async of={data.overlaps} what="overlapping units">
          {(units) => (
            <>
              <UnitLinks
                units={units}
                label={unit.layer === 'county'
                  ? `${plural(units.length, '119th Congress district')} include part of this county`
                  : `${plural(units.length, 'county', 'counties')} have territory in this district`}
              />
              <p className="quiet">Congressional districts are not nested within counties: a county can be split among districts and a district can cross county lines. From the Census Bureau&rsquo;s county-within-district boundary file for the 119th Congress.</p>
            </>
          )}
        </Async>
      ) : null}
      {unit.layer === 'cd120' ? <p className="quiet">The Census Bureau has not yet published a county-by-district file for the 120th Congress, so overlapping counties are not listed.</p> : null}
      {unit.layer === 'county' ? <p className="quiet">Overlaps with 120th Congress districts are not available yet for the same reason.</p> : null}
    </>
  );
}

/**
 * The judicial circuit a state or territory is in, in the statute's own words. The statute's table (28 U.S.C. § 41)
 * places every state, the District of Columbia and four of the five territories in a circuit; the one it leaves out is
 * said to be in none.
 */
function CircuitOfState({ data }: { data: PlaceData }) {
  const core = useCore();
  const { unit } = data;
  const name = data.geo.stateName(unit.stateFips);
  return (
    <Async of={data.appealsCourt} what="the judicial circuit">
      {(court) => {
        const statute = dataOf(core.courts)?.statute;
        if (!court) {
          return (
            <p>
              {name} is in no federal judicial circuit: the statute that lists the circuits
              {statute?.sections[0] ? <> (<Ext href={statute.sections[0].url}>{statute.sections[0].citation}</Ext>)</> : null} does not name it.
              {' '}<A to={buildHash(['courts'])}>The federal courts</A>
            </p>
          );
        }
        // The statute names a territory without its style ("Northern Mariana Islands", "Virgin Islands"). Only a provision
        // that names the place is quoted.
        const shortName = name.replace(/^(?:Commonwealth|Territory) of (?:the )?/, '').replace(/^United States /, '');
        const names = (quote: string) => quote.includes(name) || quote.includes(shortName);
        const basis = court.basis;
        const entry = basis && names(basis.quote) ? basis : basis?.also?.find((also) => names(also.quote)) ?? null;
        return (
          <p>
            {name} is in the <a href={courtHash(court.id)}>{courtShortName(court, court.id)}</a>: appeals from the federal district courts in {name} go to the {court.name}.
            {entry ? <> The statute reads: <q>{entry.quote}</q> (<Ext href={entry.url}>{entry.citation}</Ext>)</> : null}
          </p>
        );
      }}
    </Async>
  );
}

/** ": 2 for this unit, 5 for the whole state": how many records name the unit and how many are inherited. `kind` is "state", "territory" or "federal district". */
function viaBreakdown(items: ReadonlyArray<{ via: 'direct' | 'statewide' | 'within' }>, isState: boolean, kind: string): string {
  if (items.length === 0) return '';
  const direct = items.filter((i) => i.via === 'direct').length;
  const other = items.length - direct;
  if (other === 0) return '';
  return isState
    ? `: ${direct} for the ${kind} as a whole, ${other} for a county or district inside it`
    : `: ${direct} for this unit, ${other} for the whole ${kind}`;
}

function Overview({ data, route }: { data: PlaceData; route: Route }) {
  const tabHash = (tab: string) => buildHash(route.path, { ...route.query, tab });
  const isState = data.unit.layer === 'state';
  const kind = stateKind(data.unit.stateFips).toLowerCase();
  return (
    <>
      <Section title="Records tied to this place">
        {/* Each count waits only for the files it is made from; one that failed says so instead of showing a number. */}
        <ul className="plain-list">
          <li>
            <Async of={data.cases} what="the linked court cases">
              {(cases) => <><a href={tabHash('litigation')}>{plural(cases.length, 'court case')}</a> linked by the record{viaBreakdown(cases, isState, kind)}</>}
            </Async>
          </li>
          {isState ? (
            <li>
              <Async of={data.appealsFrom} what="the court of appeals cases">
                {(appeals) => <><a href={tabHash('litigation')}>{plural(appeals.length, 'court of appeals case')}</a> that began in a federal district court here</>}
              </Async>
            </li>
          ) : null}
          <li>
            <Async of={data.legislation} what="the tracked legislation">
              {(legislation) => <><a href={tabHash('legislation')}>{legislation.covered ? plural(legislation.bills.length, 'tracked measure') : `Legislation not covered for this ${kind} yet`}</a>{legislation.covered ? ` (listed for the whole ${kind})` : ''}</>}
            </Async>
          </li>
          <li>
            <Async of={data.events} what="the dated events">
              {(events) => <><a href={tabHash('timeline')}>{plural(events.length, 'dated event')}</a> on the timeline{viaBreakdown(events, isState, kind)}</>}
            </Async>
          </li>
        </ul>
        <FederalPointer />
        <GapNotice>These counts describe this dataset, not the amount of litigation or legislation that exists.</GapNotice>
      </Section>
      <Section title="Related geography">
        <RelatedGeography data={data} />
        <p className="quiet">The outline on the map is from the {data.vintage}, U.S. Census Bureau.</p>
      </Section>
      <Section title="Population, 2020 Census">
        <Async of={data.population} what="population counts">
          {(result) => <PopulationCard result={result} unit={data.unit} data={data} />}
        </Async>
      </Section>
    </>
  );
}

/** Federal law applies in every state, so each place points to the page of the country, where the measures of Congress are listed. */
function FederalPointer() {
  const core = useCore();
  const federal = dataOf(core.bills)?.bills.filter(isFederalBill).length;
  return (
    <p className="quiet">
      The measures of Congress are listed once, for the United States, and are not repeated for each state.{' '}
      <A to={buildHash(['place', NATION_KEY])}>{federal ? `Federal level: ${plural(federal, 'election measure')} of Congress` : 'Federal level'}</A>
    </p>
  );
}

function LitigationTab({ data, cases, appeals }: { data: PlaceData; cases: LinkedRecord<LegalCaseSummary>[]; appeals: LegalCaseSummary[] }) {
  const labels = useTagLabels();
  const { unit } = data;
  const kind = stateKind(unit.stateFips).toLowerCase();
  const stateName = data.geo.stateName(unit.stateFips);
  const court = dataOf(data.appealsCourt);
  const groups: Array<{ via: 'direct' | 'statewide' | 'within'; title: string }> = [
    { via: 'direct', title: unit.layer === 'state' ? `Linked to the whole ${kind}` : 'Linked to this exact unit' },
    { via: 'statewide', title: kind === 'state' ? `Statewide records for ${stateName}` : `Records for the whole of ${stateName}` },
    { via: 'within', title: `Linked to a district or county inside this ${kind}` },
  ];
  if (cases.length === 0 && appeals.length === 0) {
    return (
      <Empty title="No court case in this dataset is linked to this place.">
        <GapNotice>
          DemocracyHQ holds a hand-picked set of Supreme Court dockets and the court of appeals cases a keyword rule finds. It links a case to a place only where a court document supports it.
          Cases concerning this place may exist, in these courts and in courts that are not covered.
        </GapNotice>
        <p>
          <A to={buildHash(['litigation'])}>Browse all cases</A>
          {court ? <> <A to={courtHash(court.id)}>Cases of the {courtShortName(court, court.id)}</A></> : null}
        </p>
      </Empty>
    );
  }
  return (
    <>
      {groups.map(({ via, title }) => {
        const items = cases.filter((c) => c.via === via);
        if (items.length === 0) return null;
        return (
          <Section key={via} title={title} note={via === 'statewide' ? `These concern the ${kind} as a whole. Nothing in the record ties them specifically to this unit.` : undefined}>
            <ul className="rows">
              {items.map(({ record, relationship }) => <CaseRow key={record.id} record={record} labels={labels} note={relationship.scope.note ?? undefined} />)}
            </ul>
          </Section>
        );
      })}
      {appeals.length > 0 ? (
        <Section
          title={`Appeals that began in a federal district court in ${stateName}`}
          note={`Listed by the court below that each opinion names. That says where a case began, not what it concerns: a case from ${stateName} can concern another state, or federal law alone. The published rule that reads the line misses opinions that name the court below in another form.`}
        >
          <CaseRows cases={appeals} labels={labels} />
          {court ? <p><A to={courtHash(court.id)}>All cases of the {courtShortName(court, court.id)} in this dataset</A></p> : null}
        </Section>
      ) : null}
      <GapNotice>A Supreme Court docket appears here only where a maintainer has linked it with supporting text, and an appeal only where its opinion names a district court in this {kind}.</GapNotice>
    </>
  );
}

function LegislationTab({ data, legislation }: { data: PlaceData; legislation: PlaceLegislation }) {
  const labels = useTagLabels();
  const stateName = data.geo.stateName(data.unit.stateFips);
  if (!legislation.covered) {
    return (
      <Empty title={`Legislation for ${stateName} is not covered yet.`}>
        <GapNotice>DemocracyHQ tracks the election measures of Congress and of the California Legislature. The election legislation of {stateName} is not tracked here.</GapNotice>
        <FederalPointer />
      </Empty>
    );
  }
  const shown = legislation.bills.slice(0, 25);
  return (
    <Section title={`Election measures in ${stateName}`} note={data.unit.layer === 'state' ? 'Bills are listed for the whole state. Some concern a single county or district but are not linked to it here.' : 'Bills are listed for the whole state this unit belongs to. Some concern a single county or district but are not linked to it here.'}>
      <ul className="rows">{shown.map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
      {legislation.bills.length > shown.length ? <p><A to={buildHash(['laws'], { jur: billJurisdiction(legislation.bills[0]!) })}>See all {legislation.bills.length} tracked measures</A></p> : null}
      <FederalPointer />
    </Section>
  );
}

const PLACE_TIMELINE_NOTE = 'Key entries only, newest first: the docket entries and legislative actions that the published rules mark as key, each changed text version of a bill, and Census boundary-file dates. See each case or bill for its full docket or history. Court and legislative entries carry the date of the event itself; a boundary entry carries the date of the Census file it comes from.';

/**
 * The dated events of a place, with their filters. `kinds` are the kinds of event the place can have (the country has
 * no boundary entries of its own) and `note` says what the entries are.
 */
export function TimelineTab({ data, events, route, kinds = EVENT_CATEGORIES, note = PLACE_TIMELINE_NOTE, title = 'What changed here?' }: {
  data: PlaceData; events: PlaceEvent[]; route: Route; kinds?: readonly EventCategory[]; note?: string; title?: string;
}) {
  const selected = (route.query.cat ?? '').split(',').filter((c): c is EventCategory => (kinds as readonly string[]).includes(c));
  const categories = selected.length > 0 ? selected : [...kinds];
  const from = isoDateParam(route.query.from) ?? '';
  const to = isoDateParam(route.query.to) ?? '';
  // Only a unit inside a state inherits the state's records, so only there can they be left out.
  const subState = isCensusLayer(data.unit.layer) && data.unit.layer !== 'state';
  const directOnly = subState && route.query.scope === 'direct';
  const filtered = useMemo(
    () => events.filter((e) => categories.includes(e.category) && (!from || e.date >= from) && (!to || e.date <= to) && (!directOnly || e.via === 'direct')),
    [events, categories.join(','), from, to, directOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const limit = positiveInt(route.query.show, 60);
  const toggle = (category: EventCategory) => {
    const next = categories.includes(category) ? categories.filter((c) => c !== category) : [...categories, category];
    patchQuery(route, { cat: next.length === kinds.length || next.length === 0 ? '' : next.join(','), show: '' });
  };
  return (
    <Section title={title} note={note}>
      <form className="filters" aria-label="Filter the timeline" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="checks">
          <legend>Kind of event</legend>
          {kinds.map((category) => (
            <label key={category} className="check">
              <input type="checkbox" checked={categories.includes(category)} onChange={() => toggle(category)} />
              <span className={`cat-label cat-${category}`}>{CATEGORY_NAMES[category]}</span>
            </label>
          ))}
        </fieldset>
        {subState ? (
          <Segmented
            label="Include"
            value={directOnly ? 'direct' : 'all'}
            options={[{ value: 'all', label: 'Statewide records too' }, { value: 'direct', label: 'Only records naming this place' }]}
            onChange={(value) => patchQuery(route, { scope: value === 'direct' ? 'direct' : '', show: '' })}
          />
        ) : null}
        <div className="filters-grid">
          <TextField type="date" label="From" value={from} onChange={(value) => patchQuery(route, { from: value, show: '' })} />
          <TextField type="date" label="To" value={to} onChange={(value) => patchQuery(route, { to: value, show: '' })} />
        </div>
        <p className="filters-status" role="status">{plural(filtered.length, 'event')} {filtered.length !== events.length ? `of ${events.length}` : ''}</p>
      </form>
      {filtered.length === 0 ? (
        <Empty title="No dated event in this dataset matches.">
          <GapNotice>An empty timeline means DemocracyHQ has no record for this place and period, not that nothing happened.</GapNotice>
        </Empty>
      ) : (
        <>
          <TimelineList events={filtered} limit={limit} subjectOf={(id) => dataOf(data.legislation)?.bills.find((b) => b.id === id)?.subject} />
          {filtered.length > limit ? <p><button type="button" className="btn" onClick={() => patchQuery(route, { show: String(limit + 100) })}>Show {Math.min(100, filtered.length - limit)} more events</button></p> : null}
        </>
      )}
    </Section>
  );
}

export function SourcesTab({ data, also = [] }: { data: PlaceData; also?: readonly string[] }) {
  const core = useCore();
  const population = dataOf(data.population);
  const ids = new Set<string>([data.geoSourceId, ...also]);
  if (population?.status === 'available') ids.add(population.dataset.sourceId);
  for (const linked of dataOf(data.cases) ?? []) ids.add(linked.record.sourceId);
  for (const record of dataOf(data.appealsFrom) ?? []) ids.add(record.sourceId);
  // The circuit a state is in is read from the United States Code.
  const statuteSource = dataOf(core.courts)?.statute.sourceId;
  if (data.unit.layer === 'state' && statuteSource) ids.add(statuteSource);
  for (const bill of dataOf(data.legislation)?.bills ?? []) ids.add(bill.sourceId);
  if (dataOf(data.events)?.some((e) => e.category === 'geography')) ids.add('census-cd120-page');
  return (
    <>
      <Section title="Sources behind this page">
        {/* While the source list loads, or if it failed, the page says so rather than showing an empty list. */}
        <Async of={core.sources} what="the list of sources">
          {(sources) => (
            <ul className="rows">
              {sources.filter((s) => ids.has(s.id)).map((source) => {
                const freshness = sourceFreshness(source, core.now);
                return (
                  <li key={source.id} className="row">
                    <p className="row-title"><Ext href={source.url}>{source.name}</Ext></p>
                    <p className="row-meta">{source.authority}</p>
                    <p className={`row-line fresh-${freshness.state}`}>{freshness.label}</p>
                    <p className="row-foot">{source.license}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </Async>
        <p><A to={buildHash(['sources'])}>All sources, methods and limitations</A></p>
      </Section>
      <ExportMenu
        printHash={buildHash(['pack', 'place', data.unit.key])}
        // Not offered while the source list loads; if it failed, the pack says so.
        build={() => (core.sources.status === 'loading' ? null : buildPlacePack(data, { now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources) }))}
      />
    </>
  );
}

const TAB_IDS = ['overview', 'litigation', 'legislation', 'timeline', 'sources'] as const;

/**
 * The behaviour of a workspace's tabs, shared by the page of a place and the page of the country. A new tab replaces the
 * content under the tab row, so it is brought into view (on a phone the half-height sheet would leave it below the
 * fold) and, unless the reader is moving through the tabs themselves, focus moves to the new content. `openPack` is for
 * the header's link to the source pack, which lives on the Sources tab.
 */
export function useWorkspaceTabs(route: Route, tab: string) {
  const raiseSheet = useRaiseSheet();
  const compact = useMediaQuery(COMPACT_QUERY);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const shownTab = useRef(tab);
  const goingToPack = useRef(false);
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    const toPack = goingToPack.current;
    goingToPack.current = false;
    const fromTabs = Boolean(document.activeElement?.closest('[role="tablist"]'));
    raiseSheet();
    if (toPack) revealElement(() => document.getElementById('source-pack-h'));
    else revealElement(() => tablistRef.current, { block: compact ? 'start' : 'nearest', focus: fromTabs ? false : () => document.getElementById(`place-panel-${tab}`) });
  }, [tab, raiseSheet, compact]);
  const openPack = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    raiseSheet();
    if (tab === 'sources') {
      revealElement(() => document.getElementById('source-pack-h'));
      return;
    }
    goingToPack.current = true;
    patchQuery(route, { tab: 'sources' }, { replace: false });
  };
  return { tablistRef, openPack };
}

export function PlaceWorkspace({ placeKey, route }: { placeKey: string; route: Route }) {
  const state = usePlaceData(placeKey);
  const tab = (TAB_IDS as readonly string[]).includes(route.query.tab ?? '') ? route.query.tab! : 'overview';
  const { tablistRef, openPack } = useWorkspaceTabs(route, tab);
  if (state.status === 'loading') return <article className="view"><Loading what="this place" /></article>;
  if (state.status === 'error') return <article className="view"><ErrorHeading error={state.error} noun="Place" /><ErrorNote error={state.error} what="the place index" /></article>;
  if (state.status === 'missing') {
    return (
      <article className="view">
        <header className="view-head"><h1 tabIndex={-1}>Place not found</h1></header>
        <Empty title={`No geographic unit has the key “${placeKey}”.`}>
          <p>Keys look like state:06, county:06037 or cd120:0612. Use the search box or select a place on the map.</p>
          <p><A to={buildHash([])}>Back to the map</A></p>
        </Empty>
      </article>
    );
  }
  const data = state.data;
  const { unit } = data;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'litigation', label: data.cases.status === 'ready' && data.appealsFrom.status === 'ready' ? `Litigation (${data.cases.data.length + data.appealsFrom.data.length})` : 'Litigation' },
    { id: 'legislation', label: data.legislation.status === 'ready' && data.legislation.data.covered ? `Legislation (${data.legislation.data.bills.length})` : 'Legislation' },
    { id: 'timeline', label: data.events.status === 'ready' ? `Timeline (${data.events.data.length})` : 'Timeline' },
    { id: 'sources', label: 'Sources' },
  ];
  const abbr = STATE_ABBR[unit.stateFips];
  return (
    <article className="view">
      {unit.layer !== 'state' ? <BackLink to={buildHash(['place', `state:${unit.stateFips}`])}>{data.geo.stateName(unit.stateFips)}</BackLink> : <BackLink to={buildHash([])}>Overview</BackLink>}
      <header className="view-head">
        <TypeMark type="place" />
        <h1 tabIndex={-1}>{unit.name}</h1>
        <p className="lede">{unitNoun(unit)}{abbr && unit.layer === 'state' ? ` (${abbr})` : ''}. Census GEOID <span className="geoid">{unit.geoid}</span>.</p>
        <div className="btn-row">
          <WatchButton item={{ type: 'place', id: unit.key, label: unit.name }} />
          <CopyLinkButton hash={buildHash(['place', unit.key], route.query)} />
          {/* The export lives with the sources it lists; this makes it reachable from every tab. */}
          <a className="btn" href={buildHash(['place', unit.key], { ...route.query, tab: 'sources' })} onClick={openPack}>Export source pack</a>
        </div>
      </header>
      <Tabs ref={tablistRef} tabs={tabs} active={tab} label="Sections for this place" idBase="place" onChange={(id) => patchQuery(route, { tab: id === 'overview' ? '' : id }, { replace: false })} />
      <TabPanel idBase="place" id={tab}>
        {tab === 'overview' ? <Overview data={data} route={route} /> : null}
        {/* Each tab waits only for the files it uses, and shows an error if one of them failed. */}
        {tab === 'litigation' ? <Async of={allOf(data.cases, data.appealsFrom)} what="court cases">{([cases, appeals]) => <LitigationTab data={data} cases={cases} appeals={appeals} />}</Async> : null}
        {tab === 'legislation' ? <Async of={data.legislation} what="legislation">{(legislation) => <LegislationTab data={data} legislation={legislation} />}</Async> : null}
        {tab === 'timeline' ? <Async of={data.events} what="the timeline">{(events) => <TimelineTab data={data} events={events} route={route} />}</Async> : null}
        {tab === 'sources' ? <SourcesTab data={data} /> : null}
      </TabPanel>
    </article>
  );
}
