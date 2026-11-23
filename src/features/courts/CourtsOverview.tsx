/**
 * The federal courts DemocracyHQ covers: the Supreme Court and the thirteen courts of appeals, with the states each
 * regional circuit is made up of and what was read for each court.
 */
import { Fragment } from 'react';
import type { Court } from '../../types/schemas';
import { useCore, type AppealsCoverage, type DecisionsCoverage } from '../../lib/core';
import { FEDERAL_CIRCUIT_ID, SCOTUS_ID, casesByCourt, casesByKind, courtHash, courtShortName, levelName, levelOfKind, systemOfKind, type CourtDirectory, type CourtKind } from '../../lib/courts';
import { formatDate, plural } from '../../lib/format';
import type { GeoIndex } from '../../lib/geo';
import { buildHash } from '../../lib/router';
import { allOf, dataOf } from '../../lib/useLoad';
import { A, Async, BackLink, Ext, Method, Section, TypeMark, DocketGap } from '../../components/ui';

/** Sections of title 28 in the edition of the United States Code that GovInfo publishes, for the links in the last section. */
const USC_28 = 'https://www.govinfo.gov/content/pkg/USCODE-2024-title28/html/USCODE-2024-title28';
const USC_28_1291 = `${USC_28}-partIV-chap83-sec1291.htm`;
const USC_28_1253 = `${USC_28}-partIV-chap81-sec1253.htm`;
const USC_28_2284 = `${USC_28}-partVI-chap155-sec2284.htm`;

/** "Louisiana, Mississippi and Texas", each name a link to the place's page. */
export function StateLinks({ states, geo }: { states: readonly string[]; geo: GeoIndex }) {
  const named = states.map((fips) => ({ fips, name: geo.stateName(fips) })).sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  return (
    <>
      {named.map(({ fips, name }, i) => (
        <Fragment key={fips}>
          {i === 0 ? '' : i === named.length - 1 ? ' and ' : ', '}
          <a href={buildHash(['place', `state:${fips}`])}>{name}</a>
        </Fragment>
      ))}
    </>
  );
}

/** The states and territories of a circuit as plain text, in alphabetical order. */
export function stateNames(court: Court, geo: GeoIndex): string {
  return court.states.map((fips) => geo.stateName(fips)).sort((a, b) => a.localeCompare(b, 'en-US')).join(', ');
}

/**
 * How many of a court's cases are published and how many were read to find them. The second number is absent until the
 * coverage file has loaded.
 */
export function courtCounts(courtId: string, published: number, appeals: AppealsCoverage | null): string {
  const read = appeals?.coverage[courtId];
  if (!read) return `${plural(published, 'case')} in this dataset`;
  return `${plural(published, 'case')} in this dataset, found among ${read.cases.toLocaleString('en-US')} read`;
}

/** The courts of appeals as a list: each with its states and its counts. */
export function AppealsCourtRows({ courts, geo, counts, appeals }: {
  courts: CourtDirectory; geo: GeoIndex; counts: ReadonlyMap<string, number>; appeals: AppealsCoverage | null;
}) {
  return (
    <ul className="rows">
      {courts.appeals.map((court) => (
        <li key={court.id} className="row">
          <a className="row-title" href={courtHash(court.id)}>{courtShortName(court, court.id)}</a>
          <p className="row-meta">
            {court.id === FEDERAL_CIRCUIT_ID ? 'No region of its own: it takes cases by subject from every federal judicial district' : stateNames(court, geo)}
          </p>
          <p className="row-line">{courtCounts(court.id, counts.get(court.id) ?? 0, appeals)}</p>
        </li>
      ))}
    </ul>
  );
}

/** The Supreme Court's entry in a list of courts. */
export function SupremeCourtRow({ count }: { count: number }) {
  return (
    <ul className="rows">
      <li className="row">
        <a className="row-title" href={courtHash(SCOTUS_ID)}>Supreme Court of the United States</a>
        <p className="row-meta">The whole country</p>
        <p className="row-line">{plural(count, 'docket')} in this dataset, chosen by maintainers</p>
      </li>
    </ul>
  );
}

/** What the outlines of the circuits rest on: the statute, the edition read and the day it was last compared. */
export function CircuitBasis({ courts }: { courts: CourtDirectory }) {
  const { statute } = courts;
  return (
    <p>
      The states and territories of each circuit are the ones the statute lists:{' '}
      {statute.sections.map((section, i) => (
        <Fragment key={section.citation}>{i === 0 ? '' : ' and '}<Ext href={section.url}>{section.citation}</Ext></Fragment>
      ))}
      , read in the {statute.edition} (current through {formatDate(statute.currentThrough)}) and last compared with the map on {formatDate(statute.checkedAt)}.
      The outlines are the Census Bureau&rsquo;s state boundaries merged by DemocracyHQ. They are not an official map.
    </p>
  );
}

export function CourtsOverview() {
  const core = useCore();
  const appeals = dataOf(core.appeals);
  return (
    <article className="view">
      <BackLink to={buildHash([])}>Overview</BackLink>
      <header className="view-head">
        <TypeMark type="court" label="Courts" />
        <h1 tabIndex={-1}>Courts</h1>
        <p className="lede">
          The Supreme Court, the thirteen federal courts of appeals, and the district and state courts whose decisions are read.
        </p>
        <Method summary="How the circuits are drawn">
          <p>Each court has a page of its own. Twelve courts of appeals sit over a circuit, a group of states and territories set by statute. The Federal Circuit takes cases by subject from the whole country.</p>
        </Method>
      </header>
      <Async of={allOf(core.courts, core.geo, core.cases)} what="the list of courts">
        {([courts, geo, cases]) => {
          const counts = casesByCourt(cases);
          const withCases = courts.appeals.filter((court) => (counts.get(court.id) ?? 0) > 0).length;
          const inAppeals = casesByKind(cases).get('federal_appellate')?.cases ?? 0;
          return (
            <>
              <Section title="Supreme Court">
                <SupremeCourtRow count={counts.get(SCOTUS_ID) ?? 0} />
              </Section>
              <Section
                title="Courts of appeals"
                note={`${plural(inAppeals, 'election case')} in ${withCases} of the ${courts.appeals.length} courts. Select a circuit on the map or a court below.`}
              >
                <AppealsCourtRows courts={courts} geo={geo} counts={counts} appeals={appeals} />
                {appeals ? (
                  <p className="quiet">
                    Read: every case GovInfo lists for the court with a document issued since {formatDate(appeals.selection.since)}, {appeals.selection.totalCasesRead.toLocaleString('en-US')} cases
                    and {appeals.selection.totalDocumentsRead.toLocaleString('en-US')} documents in all. A published rule picks the election cases among them
                    (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {appeals.selection.ruleId}</A>). The rule counts words, so it can miss an election case and can include a case that only discusses elections.
                  </p>
                ) : null}
              </Section>
              <OtherCourts kinds={casesByKind(cases)} decisions={dataOf(core.decisions)} />
              <Section title="How the circuits are drawn">
                <CircuitBasis courts={courts} />
                {courts.withoutCircuit.length > 0 ? (
                  <p>
                    <StateLinks states={courts.withoutCircuit} geo={geo} /> {courts.withoutCircuit.length === 1 ? 'is' : 'are'} in no circuit: the statute does not name {courts.withoutCircuit.length === 1 ? 'it' : 'them'}.
                  </p>
                ) : null}
                {courts.notOnTheMap.length > 0 ? (
                  <p>
                    The statute also names the {courts.notOnTheMap.join(' and the ')}, which the map does not draw: the Census Bureau&rsquo;s boundary files hold no unit for {courts.notOnTheMap.length === 1 ? 'it' : 'them'}.
                  </p>
                ) : null}
              </Section>
              <Section title="What these courts are to each other">
                <p>
                  A court of appeals hears appeals from the federal district courts of its circuit (<Ext href={USC_28_1291}>28 U.S.C. § 1291</Ext>), and the Supreme Court can review what a court of appeals decides.
                  Some election cases never pass through a court of appeals: a constitutional challenge to the apportionment of congressional districts or of a statewide legislative body is heard by a district court of three judges
                  (<Ext href={USC_28_2284}>28 U.S.C. § 2284</Ext>), and an appeal from such a court goes directly to the Supreme Court (<Ext href={USC_28_1253}>28 U.S.C. § 1253</Ext>).
                </p>
                <DocketGap dockets={dataOf(core.decisions)?.dockets} />
              </Section>
            </>
          );
        }}
      </Async>
    </article>
  );
}

const OTHER_KINDS: readonly CourtKind[] = ['federal_district', 'state_supreme', 'state_appellate', 'state_trial'];

/**
 * The federal district courts and the state courts: several hundred courts, which have no page of their own here.
 * The section counts their cases by kind of court and leads to the list of court cases, where each court can be chosen.
 */
export function OtherCourts({ kinds, decisions }: { kinds: ReadonlyMap<CourtKind, { cases: number; courts: number }>; decisions: DecisionsCoverage | null }) {
  return (
    <Section
      title="District courts and state courts"
      note="Read from CourtListener, the collection of court decisions of the Free Law Project. It is not a court, and it does not hold every decision."
    >
      <ul className="rows">
        {OTHER_KINDS.map((kind) => {
          const count = kinds.get(kind) ?? { cases: 0, courts: 0 };
          const system = systemOfKind(kind);
          const level = levelOfKind(kind);
          return (
            <li key={kind} className="row">
              <a className="row-title" href={buildHash(['litigation'], { system, level })}>{kind === 'federal_district' ? 'Federal district courts' : levelName(level, system)}</a>
              <p className="row-meta">{count.cases > 0 ? `${plural(count.cases, 'election case')} from ${plural(count.courts, 'court')}` : 'No case in this dataset. Not evidence that none exists.'}</p>
            </li>
          );
        })}
      </ul>
      {decisions ? (
        <p className="quiet">
          Read: {decisions.selection.totalCasesRead.toLocaleString('en-US')} cases with a decision since {formatDate(decisions.selection.since)} that CourtListener returns for a list of election terms.
          A published rule picks the election cases among them by counting words in each decision (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {decisions.selection.ruleId}</A>), so it can miss an election case and can include a case that only discusses elections.
          A state&rsquo;s highest court is counted with the state supreme courts whatever its name.
        </p>
      ) : null}
    </Section>
  );
}
