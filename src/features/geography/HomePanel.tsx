import { isFederalBill, shortSession } from '../../lib/bills';
import { useCore, useEvents, useGovernment } from '../../lib/core';
import { casesByKind, stateCourtCases } from '../../lib/courts';
import { formatDate, plural } from '../../lib/format';
import { NATION_KEY } from '../../lib/geo';
import { latestEvents, linkedStates } from '../../lib/relations';
import { buildHash, useRoute } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, GapNotice, Section } from '../../components/ui';
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
  return (
    <article className="view view-home">
      <header className="view-head">
        <h1 tabIndex={-1} className="display">Election litigation, voting laws and district boundaries, linked to their sources</h1>
        <p className="lede">Election measures of Congress and of the state legislatures, election cases in federal and state courts, and Census Bureau boundaries for states, counties and congressional districts.</p>
      </header>

      <Section title="Who governs">
        <Async of={government} what="who holds office">
          {(index) => <ControlTally index={index} shown={partyShown} mapHash={buildHash([], partyShown ? {} : { shade: 'party' })} nationHash={buildHash(['place', NATION_KEY], partyShown ? { shade: 'party' } : {})} />}
        </Async>
      </Section>

      <Section title="Start with a place">
        <p>Select a state on the map, or search for a place, court, case or bill. A state opens with the cases linked to it, its legislation, a dated timeline and its 2020 Census counts.</p>
        <p>
          Two views reach past a single state. The <a href={buildHash(['place', NATION_KEY])}>federal level</a> gathers Congress and the federal courts.{' '}
          <a href={buildHash(['courts'])}>The courts</a> show which court of appeals takes the appeals from each state.
        </p>
        {/* One sentence, so the links sit in running text with the line spacing of the words around them. */}
        {withLinks.length > 0 ? (
          <p className="state-links">
            States with at least one curated link to a court case or bill in this dataset, in alphabetical order:{' '}
            {withLinks.map(({ fips, name }, i) => (
              <span key={fips}>
                {i === 0 ? '' : i === withLinks.length - 1 ? ' and ' : ', '}
                <a href={buildHash(['place', `state:${fips}`])}>{name}</a>
              </span>
            ))}.
          </p>
        ) : null}
      </Section>


      <Section title="What is in this release">
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
          <li className="module module-case">
            <a href={buildHash(['courts'])}>Courts</a>
            <p>The Supreme Court and the thirteen federal courts of appeals, with the states and territories of each circuit as the statute lists them, and what was read for the district courts and the state courts.</p>
          </li>
          <li className="module module-place">
            <a href={buildHash(['redistricting'])}>Redistricting</a>
            <p>{geo ? `State, county and congressional district boundaries for two Congresses (${geo.size.toLocaleString('en-US')} units), with 2020 Census counts where the vintages match.` : 'Official boundaries with 2020 Census counts where the vintages match.'}</p>
          </li>
        </ul>
        <GapNotice>
          Coverage is uneven on purpose while the method is proven: Congress and California from official records, the other state legislatures as far as Open States, a collection that is not a legislature, holds their measures; the Supreme Court and the federal courts of appeals from official records; federal district courts and state courts only as far as CourtListener, a collection that is not a court, holds their decisions.{' '}
          <A to={buildHash(['sources'], { section: 'coverage' })}>See exactly what is and is not covered.</A>
        </GapNotice>
      </Section>

      <Section title="Latest dated events" note="Up to three key entries each from the courts’ records, the legislative histories and the Census boundary files, newest first. A boundary entry carries the date of its Census file, and entries of the same date share a row.">
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
