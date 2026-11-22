import { isFederalBill, shortSession } from '../../lib/bills';
import { useCore, useEvents, useGovernment } from '../../lib/core';
import { casesByKind, stateCourtCases } from '../../lib/courts';
import { formatDate, plural } from '../../lib/format';
import { NATION_KEY } from '../../lib/geo';
import { latestEvents, linkedStates } from '../../lib/relations';
import { buildHash, useRoute } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, GapNotice, Method, Section } from '../../components/ui';
import { ControlTally } from '../../components/WhoGoverns';
import { TimelineList } from './Timeline';

export function HomePanel() {
  const core = useCore();
  const route = useRoute();
  const events = useEvents();
  const government = useGovernment();
  // The map is coloured by party while the address says so; the layer in the address must be the states.
  const partyShown = route.query.shade === 'party' && (!route.query.layer || route.query.layer === 'state');
  const geo = dataOf(core.geo);
  const cases = dataOf(core.cases);
  const bills = dataOf(core.bills);
  const relationships = dataOf(core.relationships);
  const manifest = dataOf(core.manifest);
  // Every state that a maintainer-curated link ties a case or bill to, in alphabetical order. Links are chosen by
  // maintainers, so a count of them would rank states by curation, not by anything about the states.
  const withLinks = relationships && geo
    ? [...linkedStates(relationships).keys()].map((fips) => ({ fips, name: geo.stateName(fips) })).sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
    : [];
  const federal = bills?.bills.filter(isFederalBill) ?? [];
  const california = bills?.bills.filter((b) => !isFederalBill(b)) ?? [];
  const congress = [...new Set(federal.map((b) => shortSession(b.session)))].join(' and ');
  // Counted from the release's manifest, so the overview does not load the index of the other state legislatures.
  const stateMeasures = manifest?.counts.stateLegislationBills ?? 0;
  const byKind = cases ? casesByKind(cases) : null;
  const supreme = byKind?.get('federal_supreme')?.cases ?? 0;
  const appeals = byKind?.get('federal_appellate') ?? { cases: 0, courts: 0 };
  const district = byKind?.get('federal_district') ?? { cases: 0, courts: 0 };
  const stateCourts = byKind ? stateCourtCases(byKind) : { cases: 0, courts: 0 };
  const totalMeasures = bills ? federal.length + california.length + stateMeasures : null;
  const totalCases = byKind ? [...byKind.values()].reduce((sum, kind) => sum + kind.cases, 0) : null;
  const figure = (value: number | null | undefined) => (value === null || value === undefined ? '…' : value.toLocaleString('en-US'));
  return (
    <article className="view view-home">
      <header className="view-head">
        <h1 tabIndex={-1} className="display">Election law, state by state, from the record</h1>
        <p className="lede">Cases in federal and state courts, the election measures of Congress and the legislatures, and who governs each state. Every entry links to its source.</p>
      </header>

      <Section title="In this release">
        <div className="stats">
          <a className="stat stat-bill" href={buildHash(['laws'])}>
            <span className="stat-figure">{figure(totalMeasures)}</span>
            <span className="stat-label">election measures</span>
          </a>
          <a className="stat stat-case" href={buildHash(['litigation'])}>
            <span className="stat-figure">{figure(totalCases)}</span>
            <span className="stat-label">court cases</span>
          </a>
          <a className="stat stat-place" href={buildHash(['redistricting'])}>
            <span className="stat-figure">{figure(geo?.size)}</span>
            <span className="stat-label">district and county boundaries</span>
          </a>
        </div>
        <GapNotice>
          Coverage is uneven while the method is proven.{' '}
          <A to={buildHash(['sources'], { section: 'coverage' })}>What is and is not covered</A>
        </GapNotice>
        <Method summary="What each figure holds">
          <ul className="modules">
            <li className="module module-bill">
              <a href={buildHash(['laws'])}>Election legislation</a>
              <p>
                {bills
                  ? `${plural(federal.length, 'election measure')} of the ${congress || 'current Congress'} and ${plural(california.length, 'measure')} of California’s current session, each with its official history and text versions you can compare${stateMeasures ? `; and ${plural(stateMeasures, 'measure')} of the other state legislatures, read from Open States, each with its history and a link to the legislature’s page` : ''}.`
                  : 'Election measures of Congress and of the state legislatures, each with its official history.'}
              </p>
            </li>
            <li className="module module-case">
              <a href={buildHash(['litigation'])}>Election litigation</a>
              <p>
                {cases
                  ? `${plural(supreme, 'Supreme Court docket')} with every entry and linked filings; ${plural(appeals.cases, 'election case')} from ${plural(appeals.courts, 'federal court of appeals', 'federal courts of appeals')}, each from the documents GovInfo holds for it; and ${plural(district.cases, 'case')} of federal district courts and ${plural(stateCourts.cases, 'case')} of state courts, each from the decisions CourtListener holds for it.`
                  : 'Supreme Court dockets with every entry and linked filings, and election cases from the federal courts of appeals, the federal district courts and the courts of the states.'}
              </p>
            </li>
            <li className="module module-place">
              <a href={buildHash(['redistricting'])}>Redistricting</a>
              <p>{geo ? `State, county and congressional district boundaries for two Congresses (${geo.size.toLocaleString('en-US')} units), with 2020 Census counts where the vintages match.` : 'Official boundaries with 2020 Census counts where the vintages match.'}</p>
            </li>
          </ul>
          <p>
            Congress and California come from official records, the other state legislatures as far as Open States, a collection that is not a legislature, holds their measures; the Supreme Court and the federal courts of appeals from official records; federal district courts and state courts only as far as CourtListener, a collection that is not a court, holds their decisions.
          </p>
        </Method>
      </Section>

      <Section title="Who governs">
        <Async of={government} what="who holds office">
          {(index) => <ControlTally index={index} shown={partyShown} mapHash={buildHash([], partyShown ? {} : { shade: 'party' })} nationHash={buildHash(['place', NATION_KEY], partyShown ? { shade: 'party' } : {})} />}
        </Async>
      </Section>

      <Section title="Start with a place">
        <p className="section-lead">
          Pick a state on the map or search above. The <a href={buildHash(['place', NATION_KEY])}>federal level</a> gathers Congress and the federal courts, and <a href={buildHash(['courts'])}>the courts</a> show which court of appeals hears each state.
        </p>
        {/* One sentence, so the links sit in running text with the line spacing of the words around them. */}
        {withLinks.length > 0 ? (
          <p className="state-links">
            <span className="state-links-head">Curated links to a case or bill</span>{' '}
            {withLinks.map(({ fips, name }, i) => (
              <span key={fips}>
                {i === 0 ? '' : i === withLinks.length - 1 ? ' and ' : ', '}
                <a href={buildHash(['place', `state:${fips}`])}>{name}</a>
              </span>
            ))}.
          </p>
        ) : null}
      </Section>

      <Section title="Latest dated events" note="The newest key entries from the courts, the legislatures and the Census files.">
        <Async of={events} what="recent events">
          {(all) => <TimelineList events={latestEvents(all.filter((e) => e.eventType !== 'text_version_changed'), 3)} subjectOf={(id) => bills?.bills.find((b) => b.id === id)?.subject} />}
        </Async>
      </Section>

      <footer className="view-foot">
        <p>DemocracyHQ is a research and educational tool. It is not legal advice and not an official government source. Confirm anything important against the linked primary source.</p>
        <p>
          <A to={buildHash(['sources'])}>Data and methodology</A>
          <A to={buildHash(['about'])}>About and corrections</A>
          <A to={buildHash(['watchlist'])}>Watchlist</A>
        </p>
        {manifest ? <p className="quiet">Data release of {formatDate(manifest.generatedAt)}.</p> : null}
      </footer>
    </article>
  );
}
