/** Data sources and methodology: where every record comes from, how it is processed, and what it cannot tell you. */
import { useEffect } from 'react';
import { VERIFICATION_STATUSES, type VerificationStatus } from '../../types/schemas';
import { isFederalBill, shortSession } from '../../lib/bills';
import { useCore, type AppealsCoverage, type BillCatalog } from '../../lib/core';
import { SCOTUS_ID, courtHash, courtShortName, type CourtDirectory } from '../../lib/courts';
import { loadClassification } from '../../lib/data';
import { formatDate, formatDateTime, formatNumber, plural } from '../../lib/format';
import { sourceFreshness } from '../../lib/freshness';
import { eventLabel } from '../../lib/labels';
import { buildHash, type Route } from '../../lib/router';
import { dataOf, useLoad } from '../../lib/useLoad';
import { UNASSIGNED_STATUSES, VERIFICATION_MEANINGS } from '../../lib/verification';
import { correctionUrl, REPO_URL } from '../../config';
import { A, Async, Ext, GapNotice, Section, TableScroll, TypeMark, VerificationBadge } from '../../components/ui';
import { EFFECTIVE_HEADLINES, effectiveHeadlineGuide } from '../legislation/BillDetail';

/** What a docket-entry rule's "rules on" value means. A value not listed here is shown as published. */
const RULES_ON_LABELS: Readonly<Record<string, string>> = {
  case: 'The case itself',
  application: 'An application',
  review: 'Whether the Court will hear the case',
};

/**
 * Whether a verification state is in use, said next to its meaning: a state nothing assigns yet is marked as defined but
 * not yet used, and one that no record in this release carries says so. `carried` is null until the records have loaded.
 */
function statusUsage(status: VerificationStatus, carried: ReadonlySet<string> | null): string | null {
  if (UNASSIGNED_STATUSES.has(status) && !carried?.has(status)) {
    return `Defined but not yet used: nothing in DemocracyHQ assigns this state, and no record carries it.${status === 'disputed' ? ' Reporting a correction does not change a record’s badge.' : ''}`;
  }
  const parts: string[] = [];
  if (carried && !carried.has(status)) parts.push('No record in this release carries this state.');
  else if (carried && carried.size === 1) parts.push('Every record in this release carries this state.');
  if (status === 'unavailable') parts.push('The site shows it for figures the dataset does not have, such as a population count that was not tabulated for a unit.');
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A published pattern, set so that it can break anywhere and never widens the page. */
function Pattern({ children }: { children: string }) {
  return <span className="hash rule-pattern">{children}</span>;
}

/** The label of an event type in a rule table. A rule that stands for several types names them in words of its own. */
function ruleEventLabel(eventType: string, ruleId: string): string {
  return /[ ,]/.test(eventType) ? eventType.replace(/_/g, ' ') : eventLabel(eventType, ruleId);
}

/** How the measures of Congress were selected: the three tests with their patterns and how many measures each selected. */
function FederalSelection({ catalog }: { catalog: BillCatalog }) {
  const selection = catalog.federal;
  const federal = catalog.bills.filter(isFederalBill);
  const congress = [...new Set(federal.map((b) => shortSession(b.session)))].join(' and ') || `${selection.congress}th Congress`;
  const patterns: Readonly<Record<string, string>> = { named: selection.pattern, general: selection.generalPattern, other: selection.otherPattern };
  return (
    <>
      <p>
        <strong>Congress.</strong> Every measure of the {congress} in the official bill status data is read, {formatNumber(selection.totalMeasuresRead)} in this release, and {formatNumber(federal.length)} are included (rule {selection.ruleId}).
        The rule is applied to {selection.appliedTo}. A measure is included when it meets one of three tests, tried in this order:
      </p>
      <TableScroll label="Tests of the selection rule for the measures of Congress">
        <table className="table">
          <thead><tr><th scope="col">Test</th><th scope="col">A measure meets it when</th><th scope="col" className="num">Measures</th><th scope="col">Pattern (case-insensitive regular expression)</th></tr></thead>
          <tbody>
            {Object.entries(selection.tests).map(([name, words]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{words}</td>
                <td className="num">{formatNumber(selection.selectedByTest[name] ?? 0)}</td>
                <td className="rule-pattern">{patterns[name] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <p>
        Before a title is read, these phrases are removed from it: <Pattern>{selection.exclusionPattern}</Pattern> They cover the procedure of the two chambers and voting outside public elections.
        A measure in the policy area {selection.excludedAreas.join(' or ')} is not included, because its titles speak of elections in other countries.
        The rule reads titles only, so a measure whose titles do not say that it concerns elections is missed, and a measure that touches elections only in passing can be included.
      </p>
      <p>
        Each measure is read from its bill status record, which the Government Publishing Office publishes from the records of the Library of Congress, and its text versions from the official bill texts. The record gives no status of its own: the stage shown for a measure is the furthest step among its recorded actions (rule us-status-1), not an official status.
        Each measure links to its page on congress.gov; that page is not machine-checked.
      </p>
    </>
  );
}

/** How the court of appeals cases were selected, what was read for each court, and what a maintainer removed. */
function AppealsSelection({ appeals, courts, published }: { appeals: AppealsCoverage; courts: CourtDirectory | null; published: number | null }) {
  const selection = appeals.selection;
  // The statute's order once the list of courts has loaded, otherwise the order of the record.
  const ids = courts ? courts.appeals.map((court) => court.id).filter((id) => appeals.coverage[id]) : Object.keys(appeals.coverage);
  const total = { cases: 0, documents: 0, coverLetters: 0, unreadableDocuments: 0, selected: 0, excluded: 0 };
  for (const id of ids) {
    const read = appeals.coverage[id]!;
    total.cases += read.cases; total.documents += read.documents; total.coverLetters += read.coverLetters;
    total.unreadableDocuments += read.unreadableDocuments; total.selected += read.selected; total.excluded += read.excluded;
  }
  const tests = Object.entries(selection.textTests);
  const threshold = (values: Readonly<Record<string, number>>) => [
    values.wordMatches !== undefined ? `at least ${values.wordMatches} election words` : null,
    values.phraseMatches !== undefined ? `at least ${values.phraseMatches} election phrases` : null,
    values.density !== undefined ? `at least ${values.density} election words in every 1,000 words` : null,
  ].filter(Boolean).join(', ');
  return (
    <>
      <p>
        {published !== null ? `${formatNumber(published)} cases` : 'Cases'} of the thirteen federal courts of appeals. The rule (rule {selection.ruleId}) is applied to {selection.appliedTo}.
        In this release that is {formatNumber(selection.totalCasesRead)} cases and {formatNumber(selection.totalDocumentsRead)} documents, read on {formatDateTime(appeals.scannedAt)} from GovInfo, which the Government Publishing Office fills with what each court sends it.
        A case is included when the court&rsquo;s own record gives it the nature of suit {selection.votingNatureOfSuit} (Civil Rights: Voting), or when one of its documents meets a text test:
      </p>
      <ul className="plain-list spaced">
        {tests.map(([name, values]) => (
          <li key={name}>
            <strong>{name}:</strong> {name === 'party' ? 'a party or the case title names an election authority, and the document has ' : ''}{threshold(values)}.
          </li>
        ))}
      </ul>
      <p>
        Election words: <Pattern>{selection.wordPattern}</Pattern> Election phrases: <Pattern>{selection.phrasePattern}</Pattern> Election authorities: <Pattern>{selection.authorityPattern}</Pattern>
      </p>
      <p>
        The text tests are not applied where the record gives the case a nature of suit of another field of law ({[...new Set(Object.values(selection.otherFieldCodes))].join(', ').toLowerCase()}).
        A document with at least {selection.laborMinMatches} labor-law terms, and {selection.laborRatio} times as many of them as election phrases, is not read as an election document, because union representation elections are not public elections: <Pattern>{selection.laborPattern}</Pattern>
        A clerk&rsquo;s cover letter is not counted (rule {selection.coverLetterRuleId}).
        The rule counts words: it can miss an election case, and it can include a case that only discusses elections.
      </p>
      {/* Two tables of five and four columns: one of eight does not fit a phone without a sideways scroller. */}
      <TableScroll label="What was read for each court of appeals">
        <table className="table table-num table-dense">
          <caption>What was read for each court.</caption>
          <thead>
            <tr>
              <th scope="col">Court</th><th scope="col" className="num">Cases read</th><th scope="col" className="num">Documents</th><th scope="col" className="num">Cover letters</th>
              <th scope="col" className="num">Unreadable</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const read = appeals.coverage[id]!;
              return (
                <tr key={id}>
                  <th scope="row"><a href={courtHash(id)}>{courtShortName(courts?.get(id), id)}</a></th>
                  <td className="num">{formatNumber(read.cases)}</td><td className="num">{formatNumber(read.documents)}</td><td className="num">{formatNumber(read.coverLetters)}</td>
                  <td className="num">{formatNumber(read.unreadableDocuments)}</td>
                </tr>
              );
            })}
            <tr>
              <th scope="row">All thirteen</th>
              <td className="num">{formatNumber(total.cases)}</td><td className="num">{formatNumber(total.documents)}</td><td className="num">{formatNumber(total.coverLetters)}</td>
              <td className="num">{formatNumber(total.unreadableDocuments)}</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
      <TableScroll label="What the rule found for each court of appeals">
        <table className="table table-num table-dense">
          <caption>What came of it: the cases the rule picked, those a maintainer removed, and those in the dataset.</caption>
          <thead>
            <tr><th scope="col">Court</th><th scope="col" className="num">Picked by the rule</th><th scope="col" className="num">Removed</th><th scope="col" className="num">In the dataset</th></tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const read = appeals.coverage[id]!;
              return (
                <tr key={id}>
                  <th scope="row"><a href={courtHash(id)}>{courtShortName(courts?.get(id), id)}</a></th>
                  <td className="num">{formatNumber(read.selected + read.excluded)}</td><td className="num">{formatNumber(read.excluded)}</td><td className="num">{formatNumber(read.selected)}</td>
                </tr>
              );
            })}
            <tr>
              <th scope="row">All thirteen</th>
              <td className="num">{formatNumber(total.selected + total.excluded)}</td><td className="num">{formatNumber(total.excluded)}</td><td className="num">{formatNumber(total.selected)}</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
      <p>
        A cover letter is the clerk&rsquo;s letter telling counsel that an opinion was issued. Where a court sends GovInfo that letter in place of the opinion, the text of the decision cannot be read here, and a case is found only through the nature of suit in the court&rsquo;s record.
        That is so for almost every document of the Eighth Circuit, whose election cases are therefore more likely to be missing than those of other courts.
        A case is known here from the documents GovInfo holds for it. That is not the court&rsquo;s docket: briefs, most orders and whatever happened to a decision later (rehearing, vacatur, review by the Supreme Court) are not recorded unless GovInfo holds a document for it.
      </p>
      {appeals.exclusions.length > 0 ? (
        <>
          <h4>Cases the rule picked that a maintainer removed</h4>
          <p className="quiet">
            A case may be removed only where the opinion itself shows that no public election is at issue (rule {selection.exclusionRuleId}). Each entry quotes the passage; the pipeline looks for it in the document on every run, and the case stays out only while it is found. A case is never removed because of who its parties are or how it was decided.
          </p>
          <TableScroll label="Court of appeals cases removed by a maintainer">
            <table className="table">
              <thead><tr><th scope="col">Case</th><th scope="col">Court</th><th scope="col">Why it was removed</th><th scope="col">Passage of the opinion</th></tr></thead>
              <tbody>
                {appeals.exclusions.map((item) => (
                  <tr key={item.caseId}>
                    <td><span className="case-name">{item.caseName}</span>, No. {item.docketNumber} <Ext href={item.sourceUrl}>GovInfo</Ext></td>
                    <td>{courtShortName(courts?.get(item.courtId), item.courtId)}</td>
                    <td>{item.reason}</td>
                    <td className="rule-text"><q>{item.quote}</q> <Ext href={item.documentUrl}>Document</Ext></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      ) : null}
    </>
  );
}

const TYPE_LABEL: Readonly<Record<string, string>> = {
  official_bulk: 'Official bulk data',
  official_api: 'Official API',
  official_web: 'Official web page',
  secondary_api: 'Secondary aggregator API',
  secondary_bulk: 'Secondary aggregator, bulk files',
  secondary_web: 'Secondary source, web pages',
  curated: 'Curated by maintainers',
};

export function SourcesPage({ route }: { route: Route }) {
  const core = useCore();
  const classification = useLoad('classification', loadClassification);
  const manifest = dataOf(core.manifest);
  const bills = dataOf(core.bills);
  const cases = dataOf(core.cases);
  const courts = dataOf(core.courts);
  const supremeCount = cases ? cases.filter((record) => record.courtId === SCOTUS_ID).length : null;
  const relationships = dataOf(core.relationships);
  const areaCheck = dataOf(core.redistricting)?.areaCheck;
  // The states the records of this release carry: court cases, bills and the links between records.
  const carried = cases && bills && relationships
    ? new Set<string>([...cases, ...bills.bills, ...relationships].map((record) => record.verification.status))
    : null;
  const section = route.query.section;
  useEffect(() => {
    if (!section) return;
    const element = document.getElementById(section);
    if (element) element.scrollIntoView({ block: 'start' });
  }, [section, core.sources.status, classification.status]);
  const issue = correctionUrl('Data sources and methodology', typeof window === 'undefined' ? '' : window.location.href);

  return (
    <article className="view view-wide view-doc">
      <header className="view-head">
        <TypeMark type="data" label="Data and methodology" />
        <h1 tabIndex={-1}>Data sources and methodology</h1>
        <p className="lede">Where each record comes from, how it is processed, how fresh it is, and what it cannot tell you.</p>
        <GapNotice>DemocracyHQ covers the Supreme Court, the thirteen federal courts of appeals, Congress and one state legislature today. Anything not listed below is simply not in the dataset.</GapNotice>
        <nav aria-label="On this page" className="toc">
          <a href={buildHash(['sources'], { section: 'sources' })}>Sources and freshness</a>
          <a href={buildHash(['sources'], { section: 'coverage' })}>Coverage and selection</a>
          <a href={buildHash(['sources'], { section: 'verification' })}>Verification states</a>
          <a href={buildHash(['sources'], { section: 'dates' })}>Dates</a>
          <a href={buildHash(['sources'], { section: 'rules' })}>Classification rules</a>
          <a href={buildHash(['sources'], { section: 'geography' })}>Geography</a>
          <a href={buildHash(['sources'], { section: 'pipeline' })}>Processing</a>
          <a href={buildHash(['sources'], { section: 'corrections' })}>Corrections</a>
        </nav>
      </header>

      <Section title="Sources and freshness" id="sources" note={manifest ? `Data release generated ${formatDateTime(manifest.generatedAt)}. Staleness is calculated in your browser from each source’s last successful check.` : undefined}>
        <Async of={core.sources} what="the source list">
          {(sources) => (
            <div className="source-cards">
              {sources.map((source) => {
                const freshness = sourceFreshness(source, core.now);
                return (
                  <section key={source.id} className={`source-card fresh-${freshness.state}`} aria-labelledby={`src-${source.id}`}>
                    <h3 id={`src-${source.id}`}>{source.name}</h3>
                    <p className={`fresh-line fresh-${freshness.state}`}>{freshness.label}</p>
                    <dl className="facts facts-tight">
                      <div><dt>Publisher</dt><dd>{source.authority}</dd></div>
                      <div><dt>Kind</dt><dd>{TYPE_LABEL[source.sourceType] ?? source.sourceType}</dd></div>
                      <div><dt>Link</dt><dd><Ext href={source.url}>{source.url.replace(/^https:\/\//, '').slice(0, 60)}</Ext></dd></div>
                      <div><dt>Last successful check</dt><dd>{formatDateTime(source.lastSuccessfulCheck)}</dd></div>
                      <div><dt>Last attempt</dt><dd>{formatDateTime(source.lastAttempt)}</dd></div>
                      <div><dt>Published by source</dt><dd>{formatDate(source.sourcePublishedAt, 'Not reported')}</dd></div>
                      <div><dt>Records</dt><dd>{formatNumber(source.recordCount, 'None loaded')}</dd></div>
                      <div><dt>Covers</dt><dd>{source.geographicCoverage}; {source.temporalCoverage}</dd></div>
                      <div><dt>Refreshed</dt><dd>{source.updateCadence}; shown as stale after {source.staleAfterDays} days</dd></div>
                      <div><dt>Licence and reuse</dt><dd>{source.license}</dd></div>
                      <div><dt>Attribution</dt><dd>{source.attribution}</dd></div>
                      {source.credentialEnv ? <div><dt>Credential</dt><dd>Needs <span className="hash">{source.credentialEnv}</span> set as a repository secret. Without it this source stays inactive and nothing from it is shown.</dd></div> : null}
                      {source.statusDetail ? <div><dt>Status detail</dt><dd>{source.statusDetail}</dd></div> : null}
                    </dl>
                    {source.knownLimitations.length > 0 ? (
                      <>
                        <h4>Known limitations</h4>
                        <ul className="plain-list spaced">{source.knownLimitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul>
                      </>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </Async>
      </Section>

      <Section title="Coverage and selection" id="coverage">
        <h3>Supreme Court</h3>
        <p>
          {supremeCount !== null ? `${supremeCount} dockets` : 'Dockets'} of the Supreme Court of the United States, listed by maintainers in a seed file in the repository (<span className="hash">pipeline/seeds/cases.json</span>) and then read from the Court&rsquo;s public docket page for each case, one page at a time and no faster than the Court&rsquo;s robots.txt asks. Selection is editorial: the list favours recent and frequently cited election-law matters and is not a sample of anything.
        </p>
        <h3>Federal courts of appeals</h3>
        <Async of={core.appeals} what="the record of what was read for the courts of appeals">
          {(appeals) => <AppealsSelection appeals={appeals} courts={courts} published={cases && supremeCount !== null ? cases.length - supremeCount : null} />}
        </Async>
        <h3>Courts that are not covered</h3>
        <p>
          Federal district courts and state courts are not covered. A CourtListener adapter exists for lower-court dockets and stays inactive until an API token is provided.
        </p>
        <h3>Legislation</h3>
        <Async of={core.bills} what="the legislation indexes">
          {(catalog) => (
            <>
              <FederalSelection catalog={catalog} />
              <p>
                <strong>California.</strong> From {formatNumber(catalog.california.totalBillsInSession)} measures in the session, a measure is included when the {catalog.california.appliedTo} matches this pattern (rule {catalog.california.ruleId}): <Pattern>{catalog.california.pattern}</Pattern>
                {catalog.california.exclusionPattern ? <> Before the pattern is applied, these subjects are removed: <Pattern>{catalog.california.exclusionPattern}</Pattern>. They cover tax &ldquo;elections&rdquo; and the Political Reform Act&rsquo;s lobbying and ethics provisions.</> : null} Only the regular session is included.
                A keyword rule on subject lines can still include a measure that touches elections only in passing, and miss one whose subject line avoids these words.
              </p>
            </>
          )}
        </Async>
        <p>The legislatures of the other states are not covered.</p>
        <h3>Links between records</h3>
        <p>
          A case or bill is linked to a place, or to another record, only by an entry in the repository&rsquo;s seed files. Each entry quotes a passage of a named official document: the questions presented, an opinion, a filing on the docket, or the bill text. On every run that fetches the cited document, the pipeline checks that the passage is in it, ignoring only white space, hyphens and dashes, letter case and the style of quotation marks, and reading compatibility characters such as ligatures as their plain letters; parts separated by &ldquo;[&hellip;]&rdquo; must appear in order. If the document cannot be fetched in a run, a link already published stays with the date of its last successful check, and a new link is not published. A passage that ties a case or bill to a place must also name the place. A link that fails either check is not published and goes to the review queue. The check shows that the document says those words. It does not check the maintainer&rsquo;s description of the link, which is shown as theirs. A court&rsquo;s location or a party&rsquo;s name is never used to place a case.
        </p>
        <p>
          Two kinds of record are tied to a place without a seed entry, by what they are. A measure of Congress applies nationwide, so it is listed for the United States and for no state. A court of appeals case is listed for its court&rsquo;s circuit, and for the state of the district court it came from where the opinion names that court (rule origin-court-1). That says where a case began, not what it concerns, and each list that uses it says so.
        </p>
        {manifest ? <p>Review queue in this release: {manifest.reviewQueue.items} item(s){manifest.reviewQueue.items > 0 ? ` (${Object.entries(manifest.reviewQueue.byKind).map(([k, n]) => `${k.replace(/_/g, ' ')}: ${n}`).join(', ')})` : ''}.</p> : null}
      </Section>

      <Section title="Verification states" id="verification" note="Every record carries one of these states. There are no confidence scores. Reporting a correction does not change a record’s badge.">
        <dl className="definitions">
          {VERIFICATION_STATUSES.map((status) => {
            const usage = statusUsage(status, carried);
            return (
              <div key={status}>
                <dt><VerificationBadge status={status} /></dt>
                <dd>{VERIFICATION_MEANINGS[status]}{usage ? <> <em className="status-usage">{usage}</em></> : null}</dd>
              </div>
            );
          })}
        </dl>
      </Section>

      <Section title="Dates" id="dates" note="Four different dates are stored and labelled separately. None is substituted for another.">
        <dl className="definitions">
          <div><dt>Event date</dt><dd>When something happened in a court or legislature, as the source records it: a docket entry date, an action date, a version date.</dd></div>
          <div><dt>Published by source</dt><dd>When the source says it produced the file or last changed the record.</dd></div>
          <div><dt>First observed</dt><dd>When DemocracyHQ first retrieved the record.</dd></div>
          <div><dt>Last checked</dt><dd>When DemocracyHQ last retrieved the record successfully. A failed refresh leaves this date unchanged, so the record ages into &ldquo;stale&rdquo; rather than pretending to be current.</dd></div>
        </dl>
        <p>Legislative status, enactment, effective date and judicial enforceability of a bill are separate fields. For a California measure, status is the legislature&rsquo;s own status word (Chaptered, Vetoed, Died, In Committee Process). The record of a measure of Congress has no status word, so its page shows the stage the measure reached, worked out by rule from its recorded actions, with the record&rsquo;s own latest action beside it. The state of the latest text version is shown as well. The effective-date cell shows a date only when the data supports one: for a statute the official data flags as taking immediate effect, labelled as derived by rule. Effective or operative dates written into the bill text are not extracted, so &ldquo;{EFFECTIVE_HEADLINES.notVerified.text}&rdquo; does not mean the text states no date. {effectiveHeadlineGuide()} Sentences in which a measure makes itself conditional are found by rule and quoted; whether a condition was met is not recorded. Sentences saying that a provision remains in effect only until a date and is then repealed are also found by rule and quoted next to the effective date. Such a sentence applies to the provision it names, which may be only part of the measure.</p>
      </Section>

      <Section title="Classification rules" id="rules" note="Tags and event types come from the keyword rules below, applied to the text named in each record. They are published so anyone can check a classification or propose a better rule.">
        <Async of={classification} what="the classification rules">
          {(rules) => (
            <>
              <h3>Issue tags</h3>
              <p className="quiet">{rules.note}</p>
              <TableScroll label="Issue tag rules">
                <table className="table">
                  <thead><tr><th scope="col">Tag</th><th scope="col">Rule</th><th scope="col">Pattern (case-insensitive regular expression)</th></tr></thead>
                  <tbody>{rules.issueRules.map((rule) => <tr key={rule.ruleId}><td>{rule.label}</td><td>{rule.ruleId}</td><td className="rule-pattern">{rule.pattern}</td></tr>)}</tbody>
                </table>
              </TableScroll>
              <h3>Supreme Court docket entries</h3>
              <p className="quiet">Rules are tried in order; the first match wins. &ldquo;Rules on&rdquo; says what an entry decides: the case itself (an opinion, a summary disposition, a denial of review or a dismissal), an application within it (a request addressed to a Justice, such as for a stay or an injunction), or whether the Court will hear the case (a grant of review, the noting of probable jurisdiction, or the postponement of that question). An entry with no value there rules on none of these. The ruling entry shown on a case page is the latest entry that rules on the case itself or, where there is none, the latest ruling on an application; an order on whether the Court will hear the case is never chosen. DemocracyHQ never derives an overall case status.</p>
              <TableScroll label="Supreme Court docket entry rules">
                <table className="table">
                  <thead><tr><th scope="col">Rule</th><th scope="col">Entry type</th><th scope="col">Key entry</th><th scope="col">Rules on</th><th scope="col">Pattern</th></tr></thead>
                  <tbody>{rules.docketEntryRules.map((rule) => <tr key={rule.ruleId}><td>{rule.ruleId}</td><td>{eventLabel(rule.eventType)}</td><td>{rule.significance === 'major' ? 'Yes' : 'No'}</td><td>{rule.rulesOn ? RULES_ON_LABELS[rule.rulesOn] ?? rule.rulesOn : ''}</td><td className="rule-pattern">{rule.pattern}</td></tr>)}</tbody>
                </table>
              </TableScroll>
              {rules.circuitDocumentRules.length > 0 ? (
                <>
                  <h3>Court of appeals documents</h3>
                  <p className="quiet">Applied to the court&rsquo;s own entry for each document GovInfo holds for a case. Rules are tried in order; the first match wins. The decision shown for a case is its latest key entry.</p>
                  <TableScroll label="Court of appeals document rules">
                    <table className="table">
                      <thead><tr><th scope="col">Rule</th><th scope="col">Entry type</th><th scope="col">Shown as</th><th scope="col">Key entry</th><th scope="col">Pattern</th></tr></thead>
                      <tbody>{rules.circuitDocumentRules.map((rule) => <tr key={rule.ruleId}><td>{rule.ruleId}</td><td>{ruleEventLabel(rule.eventType, rule.ruleId)}</td><td>{rule.documentType}</td><td>{rule.significance === 'major' ? 'Yes' : 'No'}</td><td className="rule-pattern">{rule.pattern}</td></tr>)}</tbody>
                    </table>
                  </TableScroll>
                </>
              ) : null}
              {rules.federalActionRules.length > 0 ? (
                <>
                  <h3>Actions of Congress</h3>
                  <p className="quiet">The record of a measure lists its actions, each with the body that recorded it and an action code. A type is read only from a line the Library of Congress recorded, when the line&rsquo;s code is one of the rule&rsquo;s codes and its text matches the pattern. Rules are tried in order; the first match wins. Every other line keeps the kind the record gives it and is not a key action.</p>
                  <TableScroll label="Rules for the actions of Congress">
                    <table className="table">
                      <thead><tr><th scope="col">Rule</th><th scope="col">Action type</th><th scope="col">Key action</th><th scope="col">Action codes</th><th scope="col">Pattern</th></tr></thead>
                      <tbody>{rules.federalActionRules.map((rule) => <tr key={rule.ruleId}><td>{rule.ruleId}</td><td>{ruleEventLabel(rule.eventType, rule.ruleId)}</td><td>{rule.significance === 'major' ? 'Yes' : 'No'}</td><td>{rule.actionCodes.join(', ')}</td><td className="rule-pattern">{rule.pattern}</td></tr>)}</tbody>
                    </table>
                  </TableScroll>
                </>
              ) : null}
              <h3>California legislative actions</h3>
              <TableScroll label="California legislative action rules">
                <table className="table">
                  <thead><tr><th scope="col">Rule</th><th scope="col">Action type</th><th scope="col">Key action</th><th scope="col">Pattern</th></tr></thead>
                  <tbody>{rules.legislativeActionRules.map((rule) => <tr key={rule.ruleId}><td>{rule.ruleId}</td><td>{eventLabel(rule.eventType, rule.ruleId)}</td><td>{rule.significance === 'major' ? 'Yes' : 'No'}</td><td className="rule-pattern">{rule.pattern}</td></tr>)}</tbody>
                </table>
              </TableScroll>
              {rules.otherRules.length > 0 ? (
                <>
                  <h3>Selection, curation and comparison rules</h3>
                  <p className="quiet">These rules are not keyword patterns. They say how records were chosen, how a link between two records was checked, and when a text version counts as changed.</p>
                  <TableScroll label="Selection, curation and comparison rules">
                    <table className="table">
                      <thead><tr><th scope="col">Rule</th><th scope="col">Applies to</th><th scope="col">What it does</th></tr></thead>
                      <tbody>{rules.otherRules.map((rule) => <tr key={rule.ruleId}><td>{rule.ruleId}</td><td>{rule.appliesTo}</td><td className="rule-text">{rule.description}</td></tr>)}</tbody>
                    </table>
                  </TableScroll>
                </>
              ) : null}
            </>
          )}
        </Async>
      </Section>

      <Section title="Geography" id="geography">
        <ul className="plain-list spaced">
          <li><strong>Identifiers.</strong> Every unit is identified by its Census GEOID together with its layer, for example <span className="hash">cd120:0612</span>. Joins use GEOIDs only, never names.</li>
          <li><strong>Vintages.</strong> States, counties and 119th Congress districts come from the 2025 Cartographic Boundary Files (1:5,000,000). 120th Congress districts come from the 2026 TIGER/Line files, which include water; DemocracyHQ clips them to the Bureau&rsquo;s own shoreline file. Every layer is simplified further for display (Visvalingam simplification that keeps every unit, then a clean-up of gaps and overlaps), so lines shown are approximate and are not the legal boundary. Identifiers, names and official land areas come from the files unchanged.</li>
          <li><strong>Counts.</strong> State and county counts are from the 2020 Census redistricting file (P.L. 94-171). District counts are from the Bureau&rsquo;s retabulation of the 2020 Census for 119th Congress districts. A count is shown for a unit only when it was tabulated for that unit&rsquo;s boundaries.</li>
          <li><strong>2026 districts.</strong> In states the Bureau reports as unchanged, a 2026 district shows the count of the identically numbered 119th Congress district, with a note. As a safeguard the pipeline compares the official land area of each such district across the two boundary files; a district whose area differs by more than the tolerance has its count withheld and is queued for review.{areaCheck ? ` In this release ${formatNumber(areaCheck.compared)} districts were compared, the largest difference was ${(areaCheck.largestRelativeDifference * 100).toFixed(3)}% against a tolerance of ${(areaCheck.tolerance * 100).toFixed(1)}%, and ${plural(areaCheck.mismatches.length, 'district')} failed the check.` : ''} In the redrawn states the count is marked unavailable.</li>
          <li><strong>The country and the circuits.</strong> The United States as one unit and the twelve regional judicial circuits are not Census units and have no GEOID. Their outlines are the Bureau&rsquo;s state boundaries merged by DemocracyHQ, not an official map. Which states and territories a circuit is made up of is read from 28 U.S.C. § 41 and 48 U.S.C. § 1821(a) on every run of the boundary stage, and the circuits are published only if the statute&rsquo;s entries agree with the table the map is drawn from (rule circuit-composition-1). No population is shown for either: the loaded counts are tabulated for states, counties and districts and are not added up.</li>
          <li><strong>Counties and districts.</strong> Districts are not nested within counties. Overlaps come from the Bureau&rsquo;s county-within-district boundary file; no areal interpolation is performed and no population is apportioned across split units.</li>
          <li><strong>Map projection.</strong> Web Mercator with every unit in its true position. Alaska, Hawaii and the island areas are reached with labelled locator buttons instead of being moved or rescaled. Mercator exaggerates area at high latitudes, so compare sizes with care.</li>
          <li><strong>Map shading.</strong> Shading shows either a published count or where this dataset has records. It never shows a count of lawsuits or bills as an intensity. Units without data are hatched, not left pale.</li>
        </ul>
      </Section>

      <Section title="Processing" id="pipeline">
        <p>A Python pipeline runs on a schedule in GitHub Actions. For each source it retrieves with retries and rate limits, parses into typed records, validates them, compares them with the published release, checks that every link between records resolves and that each quoted passage is in its document, and only then publishes. Two hand-run tools, not part of the scheduled run, can sample-check external addresses and compare published dockets with the Court&rsquo;s pages; the validation report says when they last ran. A source that fails keeps its last verified data and is reported above as failed or stale. A record that comes back smaller than the published one (a truncated docket, for example) is held back and queued for review rather than overwriting good data.</p>
        <p>The browser re-validates every file against the same schema before showing it. A file that fails validation is withheld with an error message instead of being displayed partially.</p>
        {REPO_URL ? <p><Ext href={`${REPO_URL}/tree/main/docs`}>Architecture, data sources and validation reports in the repository</Ext></p> : <p className="quiet">The repository&rsquo;s docs folder holds the architecture notes, the full source register and the latest data validation report.</p>}
      </Section>

      <Section title="Corrections" id="corrections">
        <p>If a record is wrong, out of date or missing its best source, please say so. Include the page link and a primary source that shows the correct information.</p>
        {issue ? <p><Ext href={issue}>Open a correction on GitHub</Ext></p> : <p>Corrections are handled through the project&rsquo;s GitHub issue tracker. This build was not configured with a repository address, so see <A to={buildHash(['about'], { section: 'corrections' })}>About</A> for how to report one.</p>}
      </Section>
    </article>
  );
}
