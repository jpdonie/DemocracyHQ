/**
 * The page of one court: the Supreme Court, or one of the thirteen courts of appeals with the circuit it sits over,
 * its cases in the dataset, what was read to find them and what a maintainer removed.
 */
import type { CircuitExclusion, Court, LegalCaseSummary } from '../../types/schemas';
import { useCore, type AppealsCoverage } from '../../lib/core';
import { FEDERAL_CIRCUIT_ID, SCOTUS_ID, courtFullName, courtHash, courtShortName, type CourtDirectory } from '../../lib/courts';
import { caseNameClass, formatDate, formatDateTime } from '../../lib/format';
import { sourceFreshness } from '../../lib/freshness';
import type { GeoIndex } from '../../lib/geo';
import { useTagLabels } from '../../lib/labels';
import { buildHash } from '../../lib/router';
import { allOf, dataOf } from '../../lib/useLoad';
import { A, Async, BackLink, CopyLinkButton, Empty, Ext, Facts, GapNotice, Section, TypeMark, WatchButton } from '../../components/ui';
import { CaseRows, decisionRows } from '../litigation/CaseDirectory';
import { CircuitBasis, StateLinks } from './CourtsOverview';

function byLatestActivity(a: LegalCaseSummary, b: LegalCaseSummary): number {
  return (b.sourceLastActivity ?? '').localeCompare(a.sourceLastActivity ?? '') || a.id.localeCompare(b.id);
}

/** The sources a court's page rests on, each with its freshness. */
function CourtSources({ ids }: { ids: readonly string[] }) {
  const core = useCore();
  return (
    <Async of={core.sources} what="the list of sources">
      {(sources) => (
        <ul className="rows">
          {sources.filter((source) => ids.includes(source.id)).map((source) => {
            const freshness = sourceFreshness(source, core.now);
            return (
              <li key={source.id} className="row">
                <p className="row-title"><Ext href={source.url}>{source.name}</Ext></p>
                <p className="row-meta">{source.authority}</p>
                <p className={`row-line fresh-${freshness.state}`}>{freshness.label}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Async>
  );
}

function CaseList({ courtId, cases, empty }: { courtId: string; cases: readonly LegalCaseSummary[]; empty: React.ReactNode }) {
  const labels = useTagLabels();
  if (cases.length === 0) return <>{empty}</>;
  return (
    <>
      <CaseRows cases={cases} labels={labels} />
      <p><A to={buildHash(['litigation'], { court: courtId })}>Search and filter these cases</A></p>
    </>
  );
}

function SupremeCourt({ cases }: { cases: readonly LegalCaseSummary[] }) {
  const mine = cases.filter((record) => record.courtId === SCOTUS_ID).sort(byLatestActivity);
  return (
    <>
      <Section
        title={`Dockets in this dataset (${mine.length})`}
        note="Chosen by maintainers, newest activity first. Each docket is read from the Court’s own docket page with every entry and the filings the Court links. It is not a complete list of the Court’s election cases."
      >
        <CaseList courtId={SCOTUS_ID} cases={mine} empty={<Empty title="No Supreme Court docket is in this dataset." />} />
      </Section>
      <Section title="On the map">
        <p>The Supreme Court sits over the whole country, so the map outlines the United States. A state is shaded where a passage of a court document supports linking one of these dockets to it.</p>
        <GapNotice>A state without shading has no linked docket in this dataset. It may still have cases before the Court.</GapNotice>
      </Section>
      <Section title="Sources">
        <CourtSources ids={['scotus-docket']} />
        <p><A to={buildHash(['sources'], { section: 'coverage' })}>How the dockets are chosen and checked</A></p>
      </Section>
    </>
  );
}

/** The statute's entry for a circuit, quoted, with the second provision where a territory is named elsewhere. */
function StatuteEntry({ court, courts }: { court: Court; courts: CourtDirectory }) {
  const basis = court.basis;
  if (!basis) return null;
  return (
    <>
      <figure className="quote-block">
        <blockquote>{basis.quote}</blockquote>
        <figcaption>
          The statute&rsquo;s entry for the {court.id === FEDERAL_CIRCUIT_ID ? 'Federal Circuit' : 'circuit'}, <Ext href={basis.url}>{basis.citation}</Ext>, {courts.statute.edition}.
        </figcaption>
      </figure>
      {(basis.also ?? []).map((also) => (
        <figure key={also.citation} className="quote-block">
          <blockquote>{also.quote}</blockquote>
          <figcaption><Ext href={also.url}>{also.citation}</Ext>, {courts.statute.edition}.</figcaption>
        </figure>
      ))}
    </>
  );
}

function Circuit({ court, courts, geo }: { court: Court; courts: CourtDirectory; geo: GeoIndex }) {
  if (court.id === FEDERAL_CIRCUIT_ID) {
    return (
      <Section title="No circuit on the map">
        <p>The Federal Circuit has no region. It takes cases by their subject, from every federal judicial district, so the map shows no area for it.</p>
        <StatuteEntry court={court} courts={courts} />
      </Section>
    );
  }
  // A place the statute's entry names that the map does not draw.
  const notDrawn = courts.notOnTheMap.filter((name) => court.basis?.quote.includes(name));
  return (
    <Section title="The circuit">
      <p>
        The {courtShortName(court, court.id)} is made up of <StateLinks states={court.states} geo={geo} />. Its court of appeals hears appeals from the federal district courts there.
      </p>
      <StatuteEntry court={court} courts={courts} />
      {notDrawn.length > 0 ? (
        <p className="quiet">The entry also names the {notDrawn.join(' and the ')}, which the map does not draw: the Census Bureau&rsquo;s boundary files hold no unit for {notDrawn.length === 1 ? 'it' : 'them'}.</p>
      ) : null}
      <CircuitBasis courts={courts} />
    </Section>
  );
}

/** What was read for a court of appeals, and what came of it, in the numbers the scan recorded. */
function WhatWasRead({ court, appeals }: { court: Court; appeals: AppealsCoverage }) {
  const read = appeals.coverage[court.id];
  if (!read) {
    return (
      <Section title="What was read for this court">
        <p>The record of what was read does not name this court.</p>
      </Section>
    );
  }
  const picked = read.selected + read.excluded;
  const name = courtShortName(court, court.id);
  return (
    <Section title="What was read for this court">
      <Facts items={[
        [`Cases with a document issued since ${formatDate(appeals.selection.since)}`, read.cases.toLocaleString('en-US')],
        ['Documents read', read.documents.toLocaleString('en-US')],
        ...(read.coverLetters > 0 ? [['Of those, a clerk’s cover letter in place of the decision', read.coverLetters.toLocaleString('en-US')] as [string, string]] : []),
        ...(read.unreadableDocuments > 0 ? [['Documents that could not be read', read.unreadableDocuments.toLocaleString('en-US')] as [string, string]] : []),
        ['Cases the selection rule picked', picked.toLocaleString('en-US')],
        ...(read.excluded > 0 ? [['Removed by a maintainer, listed below', read.excluded.toLocaleString('en-US')] as [string, string]] : []),
        ['Cases in this dataset', read.selected.toLocaleString('en-US')],
      ]} />
      <p className="quiet">
        Read on {formatDateTime(appeals.scannedAt)} from GovInfo, which the Government Publishing Office fills with what each court sends it. A case is picked when the court&rsquo;s record gives it the nature of suit {appeals.selection.votingNatureOfSuit} (Civil Rights: Voting) or when the text of one of its documents meets a published word count
        (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {appeals.selection.ruleId}</A>).
      </p>
      {read.coverLetters > 0 ? (
        <p className="vintage-note">
          For {read.coverLetters.toLocaleString('en-US')} of the {read.documents.toLocaleString('en-US')} documents, GovInfo holds the clerk&rsquo;s letter telling counsel that an opinion was issued, not the opinion itself
          (rule {appeals.selection.coverLetterRuleId}). The selection rule does not count such a letter, so a case with no other document is found only when the court&rsquo;s record gives it the voting nature of suit.
          Election cases of the {name} are therefore more likely to be missing here than those of other courts.
        </p>
      ) : null}
      <GapNotice>
        {read.selected === 0
          ? `No case of the ${name} was selected. That is a statement about this rule and these documents, not about the court’s docket.`
          : 'The rule counts words. It can miss an election case, and it can include a case that only discusses elections.'}
      </GapNotice>
    </Section>
  );
}

function Exclusions({ items }: { items: readonly CircuitExclusion[] }) {
  if (items.length === 0) return null;
  return (
    <Section
      title={items.length === 1 ? 'One case the rule picked was removed' : `${items.length} cases the rule picked were removed`}
      note="A maintainer may remove a case only where the opinion itself shows that no public election is at issue. The passage is checked in the document on every run, and the case stays out only while it is found there."
    >
      <ul className="rows">
        {items.map((item) => (
          <li key={item.caseId} className="row">
            <p className={`row-title ${caseNameClass(item.caseName)}`}>{item.caseName}</p>
            <p className="row-meta">No. {item.docketNumber}</p>
            <p className="row-line">{item.reason}</p>
            <p className="row-line">The opinion reads: <q>{item.quote}</q></p>
            <p className="row-foot">
              <Ext href={item.documentUrl}>The document</Ext> <Ext href={item.sourceUrl}>The case on GovInfo</Ext> Passage last found on {formatDate(item.checkedAt)}.
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AppealsCourt({ court, courts, geo, cases, appeals }: {
  court: Court; courts: CourtDirectory; geo: GeoIndex; cases: readonly LegalCaseSummary[]; appeals: AppealsCoverage | null;
}) {
  const core = useCore();
  const mine = cases.filter((record) => record.courtId === court.id).sort(byLatestActivity);
  const name = courtShortName(court, court.id);
  const opinions = decisionRows(mine);
  return (
    <>
      <Section
        title={`Cases in this dataset (${mine.length})`}
        note={mine.length > 0
          ? `Election cases with a document issued since ${appeals ? formatDate(appeals.selection.since) : 'the start of 2025'}, newest first${opinions < mine.length ? `. Appeals decided in one opinion share a row, so the ${mine.length} cases take ${opinions} rows` : ''}. Each is known here from the documents GovInfo holds for it, which is not the court’s full docket.`
          : undefined}
      >
        <CaseList
          courtId={court.id}
          cases={mine}
          empty={(
            <Empty title={`No case of the ${name} is in this dataset.`}>
              <p>The selection rule found no election case among the cases read for this court. See what was read, below.</p>
            </Empty>
          )}
        />
      </Section>
      <Circuit court={court} courts={courts} geo={geo} />
      {/* What was read comes from a file of its own: while it loads, or if it failed, the rest of the page stands. */}
      <Async of={core.appeals} what="the record of what was read">
        {(coverage) => (
          <>
            <WhatWasRead court={court} appeals={coverage} />
            <Exclusions items={coverage.exclusions.filter((item) => item.courtId === court.id)} />
          </>
        )}
      </Async>
      <Section title="Sources">
        <CourtSources ids={['govinfo-uscourts', courts.statute.sourceId]} />
        {court.website ? (
          <p className="quiet">
            The court&rsquo;s own site is <Ext href={court.website}>{new URL(court.website).hostname}</Ext>. DemocracyHQ does not read it, and the link is not machine-checked.
          </p>
        ) : null}
        <p><A to={buildHash(['sources'], { section: 'coverage' })}>How the cases are selected and what the rule can miss</A></p>
      </Section>
    </>
  );
}

export function CourtPage({ id }: { id: string }) {
  const core = useCore();
  const courts = dataOf(core.courts);
  const geo = dataOf(core.geo);
  const court = courts?.get(id);
  const supreme = id === SCOTUS_ID;
  const short = courtShortName(court, id);
  return (
    <article className="view">
      <BackLink to={buildHash(['courts'])}>Federal courts</BackLink>
      <header className="view-head">
        <TypeMark type="court" />
        <h1 tabIndex={-1}>{courtFullName(court, id)}</h1>
        <p className="lede">
          {supreme ? 'The highest federal court. Its dockets here concern election law, voting rights and redistricting.'
            : id === FEDERAL_CIRCUIT_ID ? 'One of the thirteen federal courts of appeals, and the only one without a region: it takes cases by subject from the whole country.'
            : court && geo ? <>One of the thirteen federal courts of appeals. Its circuit is {court.states.map((fips) => geo.stateName(fips)).sort((a, b) => a.localeCompare(b, 'en-US')).join(', ')}.</>
            : 'One of the thirteen federal courts of appeals.'}
        </p>
        <div className="btn-row">
          <WatchButton item={{ type: 'court', id, label: supreme ? 'Supreme Court of the United States' : short }} />
          <CopyLinkButton hash={courtHash(id)} />
        </div>
      </header>
      {supreme ? (
        <Async of={core.cases} what="the Supreme Court dockets">{(cases) => <SupremeCourt cases={cases} />}</Async>
      ) : (
        <Async of={allOf(core.courts, core.geo, core.cases)} what="this court">
          {([directory, index, cases]) => {
            const record = directory.get(id);
            if (!record) {
              return (
                <Empty title="The list of courts does not name this court.">
                  <p><A to={buildHash(['courts'])}>The federal courts</A></p>
                </Empty>
              );
            }
            return <AppealsCourt court={record} courts={directory} geo={index} cases={cases} appeals={dataOf(core.appeals)} />;
          }}
        </Async>
      )}
    </article>
  );
}
