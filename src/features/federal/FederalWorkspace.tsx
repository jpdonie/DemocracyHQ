/**
 * The federal level: the United States as one unit, the place the measures of Congress and the federal courts belong
 * to. It is a place like the others on the map, with the same tabs, but what it holds applies to every state.
 */
import { useMemo } from 'react';
import type { EventCategory, LegislativeInstrumentSummary } from '../../types/schemas';
import { PASSED_IN_EACH_LIST_NOTE, PASSED_IN_EACH_STAGES, shortSession, stageRank } from '../../lib/bills';
import { useCore, useGovernment, type BillCatalog } from '../../lib/core';
import { SCOTUS_ID, casesByCourt } from '../../lib/courts';
import { countBy } from '../../lib/filters';
import { plural } from '../../lib/format';
import { NATION_KEY } from '../../lib/geo';
import { GOVERNMENT_SOURCE_IDS } from '../../lib/government';
import { useTagLabels } from '../../lib/labels';
import { NO_COUNTS_FOR_UNIT } from '../../lib/population';
import { buildHash, mapQuery, patchQuery, type Route } from '../../lib/router';
import { allOf, dataOf } from '../../lib/useLoad';
import { A, Async, BackLink, CopyLinkButton, Empty, ErrorHeading, ErrorNote, GapNotice, Loading, Section, TableScroll, TabPanel, Tabs, TypeMark, WatchButton } from '../../components/ui';
import { WhoGoverns } from '../../components/WhoGoverns';
import { AppealsCourtRows, SupremeCourtRow } from '../courts/CourtsOverview';
import { SourcesTab, TimelineTab, useWorkspaceTabs } from '../geography/PlaceWorkspace';
import { usePlaceData, type PlaceData, type PlaceEvent } from '../geography/placeData';
import { BillRow, currentStatus } from '../legislation/BillDirectory';

const TAB_IDS = ['overview', 'legislation', 'courts', 'timeline', 'sources'] as const;
/** The country has no boundary entries of its own: those are recorded for the states. */
const KINDS: readonly EventCategory[] = ['litigation', 'legislation'];
const TIMELINE_NOTE = 'Key entries only, newest first: the actions of Congress and the Supreme Court docket entries that the published rules mark as key, and each changed text version of a measure. See each measure or docket for its full history. Decisions of the courts of appeals are listed on the page of each court.';

const federalHash = (query: Record<string, string> = {}) => buildHash(['laws'], { jur: 'us', ...query });

function byLatestAction(a: LegislativeInstrumentSummary, b: LegislativeInstrumentSummary): number {
  return (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? '') || a.id.localeCompare(b.id);
}

/** How far the measures got: one row for each stage reached, from the furthest back to "Introduced". */
function Stages({ bills }: { bills: readonly LegislativeInstrumentSummary[] }) {
  const stages = countBy(bills, (b) => [currentStatus(b)]).sort((a, b) => stageRank(b.value) - stageRank(a.value));
  return (
    <TableScroll label="Measures by stage reached">
      <table className="table table-num">
        <caption>How far the measures got. Each stage lists the measures whose furthest recorded step it is.</caption>
        <thead><tr><th scope="col">Stage reached</th><th scope="col" className="num">Measures</th></tr></thead>
        <tbody>
          {stages.map((stage) => (
            <tr key={stage.value}>
              <th scope="row"><a href={federalHash({ status: stage.value })}>{stage.value}</a></th>
              <td className="num">{stage.count.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function Overview({ data, route }: { data: PlaceData; route: Route }) {
  const core = useCore();
  const labels = useTagLabels();
  const tabHash = (tab: string) => buildHash(route.path, { ...route.query, tab });
  const government = useGovernment();
  return (
    <>
      <Section title="Who governs">
        <Async of={government} what="who holds office">
          {(index) => (index.nation
            ? <WhoGoverns record={index.nation} sources={dataOf(core.sources) ?? []} />
            : <GapNotice>This data release does not say who holds the Presidency and the chambers of Congress.</GapNotice>)}
        </Async>
      </Section>
      <Section title="Congress">
        <Async of={allOf(data.legislation, core.bills)} what="the measures of Congress">
          {([legislation, catalog]) => <Congress bills={legislation.bills} catalog={catalog} labels={labels} tabHash={tabHash} />}
        </Async>
      </Section>
      <Section title="Federal courts">
        <Async of={core.cases} what="the court cases">
          {(cases) => {
            const counts = casesByCourt(cases);
            const supreme = counts.get(SCOTUS_ID) ?? 0;
            const courts = [...counts.keys()].filter((id) => id !== SCOTUS_ID).length;
            return (
              <ul className="plain-list">
                <li><a href={buildHash(['court', SCOTUS_ID])}>Supreme Court</a>: {plural(supreme, 'docket')} in election-law matters, chosen by maintainers</li>
                <li><a href={tabHash('courts')}>Courts of appeals</a>: {plural(cases.length - supreme, 'election case')} from {plural(courts, 'court')}, selected by a published rule</li>
              </ul>
            );
          }}
        </Async>
        <GapNotice>Federal district courts and state courts are not covered.</GapNotice>
      </Section>
      <Section title="Dated events">
        <Async of={data.events} what="the dated events">
          {(events) => <p><a href={tabHash('timeline')}>{plural(events.length, 'dated event')}</a> on the federal timeline: actions of Congress and entries of the Supreme Court&rsquo;s dockets.</p>}
        </Async>
      </Section>
      <Section title="On the map">
        <p className="quiet">The outline of the country is from the {data.vintage}, U.S. Census Bureau.</p>
        <p className="quiet">No population figure is shown for the country as a whole. {NO_COUNTS_FOR_UNIT} Select a state on the map for its 2020 Census counts.</p>
      </Section>
    </>
  );
}

function Congress({ bills, catalog, labels, tabHash }: {
  bills: readonly LegislativeInstrumentSummary[]; catalog: BillCatalog; labels: ReadonlyMap<string, string>; tabHash: (tab: string) => string;
}) {
  const congress = [...new Set(bills.map((b) => shortSession(b.session)))].join(' and ');
  // The measures that left the stage every measure starts at, furthest first.
  const advanced = useMemo(
    () => bills.filter((b) => stageRank(currentStatus(b)) > 0).sort((a, b) => stageRank(currentStatus(b)) - stageRank(currentStatus(a)) || byLatestAction(a, b)),
    [bills],
  );
  if (bills.length === 0) {
    return <Empty title="No measure of Congress is in this dataset."><GapNotice /></Empty>;
  }
  return (
    <>
      <p>
        <a href={tabHash('legislation')}>{plural(bills.length, 'election measure')}</a> of the {congress}, selected by a published rule from the {catalog.federal.totalMeasuresRead.toLocaleString('en-US')} measures in the official bill status data
        (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {catalog.federal.ruleId}</A>). Congress legislates for the whole country, so its measures are listed here and under no single state.
        {' '}{bills.filter((b) => currentStatus(b) === 'Introduced').length.toLocaleString('en-US')} of them have reached no step beyond their introduction.
      </p>
      <Stages bills={bills} />
      <p className="quiet">
        The stage is the furthest step among a measure&rsquo;s recorded actions, worked out by a published rule (us-status-1). It is not an official status and does not say what is happening to the measure now.
        {bills.some((b) => PASSED_IN_EACH_STAGES.has(currentStatus(b))) ? ` ${PASSED_IN_EACH_LIST_NOTE}` : ''}
      </p>
      {advanced.length > 0 ? (
        <>
          <h3>Measures that got past introduction ({advanced.length})</h3>
          <ul className="rows">{advanced.slice(0, 8).map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
          {advanced.length > 8 ? <p><a href={tabHash('legislation')}>All {advanced.length}, with the other measures</a></p> : null}
        </>
      ) : null}
    </>
  );
}

function LegislationTab({ bills }: { bills: readonly LegislativeInstrumentSummary[] }) {
  const labels = useTagLabels();
  const sorted = useMemo(() => [...bills].sort((a, b) => stageRank(currentStatus(b)) - stageRank(currentStatus(a)) || byLatestAction(a, b)), [bills]);
  if (bills.length === 0) {
    return <Empty title="No measure of Congress is in this dataset."><GapNotice /></Empty>;
  }
  const shown = sorted.slice(0, 25);
  return (
    <Section title="Election measures in Congress" note="The measures that got furthest come first, then the others by their latest action. The full list can be searched, filtered by stage and kind of measure, and sorted.">
      <p><A to={federalHash()}>Search and filter all {bills.length} measures of Congress</A></p>
      <ul className="rows">{shown.map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
      {bills.length > shown.length ? <p><A to={federalHash()}>See all {bills.length} measures of Congress</A></p> : null}
    </Section>
  );
}

function CourtsTab() {
  const core = useCore();
  return (
    <Async of={allOf(core.courts, core.geo, core.cases)} what="the list of courts">
      {([courts, geo, cases]) => {
        const counts = casesByCourt(cases);
        return (
          <>
            <Section title="Supreme Court">
              <SupremeCourtRow count={counts.get(SCOTUS_ID) ?? 0} />
            </Section>
            <Section title="Courts of appeals" note="Twelve sit over a circuit of states and territories. The Federal Circuit takes cases by subject from the whole country.">
              <AppealsCourtRows courts={courts} geo={geo} counts={counts} appeals={dataOf(core.appeals)} />
              <p><A to={buildHash(['courts'])}>The circuits on the map, and how they are drawn</A></p>
            </Section>
            <GapNotice>Federal district courts and state courts are not covered.</GapNotice>
          </>
        );
      }}
    </Async>
  );
}

export function FederalWorkspace({ route }: { route: Route }) {
  const state = usePlaceData(NATION_KEY);
  const tab = (TAB_IDS as readonly string[]).includes(route.query.tab ?? '') ? route.query.tab! : 'overview';
  const { tablistRef, openPack } = useWorkspaceTabs(route, tab);
  if (state.status === 'loading') return <article className="view"><Loading what="the federal level" /></article>;
  if (state.status === 'error') return <article className="view"><ErrorHeading error={state.error} noun="Place" /><ErrorNote error={state.error} what="the place index" /></article>;
  if (state.status === 'missing') {
    return (
      <article className="view">
        <header className="view-head"><h1 tabIndex={-1}>Federal level not found</h1></header>
        <Empty title="This data release does not hold the United States as a unit.">
          <p><A to={buildHash([])}>Back to the map</A></p>
        </Empty>
      </article>
    );
  }
  const data = state.data;
  const { unit } = data;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'legislation', label: data.legislation.status === 'ready' ? `Legislation (${data.legislation.data.bills.length})` : 'Legislation' },
    { id: 'courts', label: 'Courts' },
    { id: 'timeline', label: data.events.status === 'ready' ? `Timeline (${data.events.data.length})` : 'Timeline' },
    { id: 'sources', label: 'Sources' },
  ];
  return (
    <article className="view">
      <BackLink to={buildHash([], mapQuery(route.query))}>Overview</BackLink>
      <header className="view-head">
        <TypeMark type="place" label="Federal level" />
        <h1 tabIndex={-1}>{unit.name}</h1>
        <p className="lede">Congress and the federal courts: the records that concern the whole country and belong to no single state.</p>
        <div className="btn-row">
          <WatchButton item={{ type: 'place', id: unit.key, label: `${unit.name} (federal level)` }} />
          <CopyLinkButton hash={buildHash(['place', unit.key], route.query)} />
          <a className="btn" href={buildHash(['place', unit.key], { ...route.query, tab: 'sources' })} onClick={openPack}>Export source pack</a>
        </div>
      </header>
      <Tabs ref={tablistRef} tabs={tabs} active={tab} label="Sections for the federal level" idBase="place" onChange={(id) => patchQuery(route, { tab: id === 'overview' ? '' : id }, { replace: false })} />
      <TabPanel idBase="place" id={tab}>
        {tab === 'overview' ? <Overview data={data} route={route} /> : null}
        {tab === 'legislation' ? <Async of={data.legislation} what="the measures of Congress">{(legislation) => <LegislationTab bills={legislation.bills} />}</Async> : null}
        {tab === 'courts' ? <CourtsTab /> : null}
        {tab === 'timeline' ? (
          <Async of={data.events} what="the timeline">
            {(events: PlaceEvent[]) => <TimelineTab data={data} events={events} route={route} kinds={KINDS} note={TIMELINE_NOTE} title="What changed at the federal level?" />}
          </Async>
        ) : null}
        {tab === 'sources' ? <SourcesTab data={data} also={['scotus-docket', 'govinfo-bills', ...GOVERNMENT_SOURCE_IDS.federal]} /> : null}
      </TabPanel>
    </article>
  );
}
