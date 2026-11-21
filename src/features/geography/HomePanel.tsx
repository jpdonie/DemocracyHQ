import { useCore, useEvents } from '../../lib/core';
import { formatDate, plural } from '../../lib/format';
import { latestEvents, linkedStates } from '../../lib/relations';
import { buildHash } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, GapNotice, Section } from '../../components/ui';
import { TimelineList } from './Timeline';

export function HomePanel() {
  const core = useCore();
  const events = useEvents();
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
  return (
    <article className="view view-home">
      <header className="view-head">
        <h1 tabIndex={-1} className="display">Election litigation, voting laws and district boundaries, linked to their sources</h1>
        <p className="lede">This release covers selected U.S. Supreme Court dockets, California election measures from the current session, and Census Bureau boundaries for states, counties and congressional districts.</p>
      </header>

      <Section title="Start with a place">
        <p>Select a state on the map, or search for a state, county, district, case or bill. Each place opens a workspace with its population counts, linked cases, legislation and a dated timeline.</p>
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
          <li className="module module-case">
            <a href={buildHash(['litigation'])}>Election litigation</a>
            <p>{cases ? `${plural(cases.length, 'Supreme Court docket')} with every entry, linked filings and, where the docket links them, the questions presented.` : 'Supreme Court dockets with every entry and linked filings.'}</p>
          </li>
          <li className="module module-bill">
            <a href={buildHash(['laws'])}>California election legislation</a>
            <p>{bills ? `${plural(bills.bills.length, 'California election measure')} from the current session, each with its official history and text versions you can compare.` : 'California election measures with official history and comparable text versions.'}</p>
          </li>
          <li className="module module-place">
            <a href={buildHash(['redistricting'])}>Redistricting</a>
            <p>{geo ? `State, county and congressional district boundaries for two Congresses (${geo.size.toLocaleString('en-US')} units), with 2020 Census counts where the vintages match.` : 'Official boundaries with 2020 Census counts where the vintages match.'}</p>
          </li>
        </ul>
        <GapNotice>Coverage is narrow on purpose while the method is proven: one court, one state legislature. <A to={buildHash(['sources'], { section: 'coverage' })}>See exactly what is and is not covered.</A></GapNotice>
      </Section>

      <Section title="Latest dated events" note="The latest key entries of each kind in the dataset: up to three each from court dockets, legislative histories and Census boundary files, newest first. Court and legislative entries carry the date of the event itself; a boundary entry carries the date of the Census file it comes from, and boundary entries of the same date are shown as one row.">
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
