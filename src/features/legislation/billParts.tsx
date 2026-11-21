/** The sections of a measure's page that a California bill and a measure of Congress share. */
import type { EntityRelationship, LegalCaseSummary, LegislativeInstrument, LegislativeInstrumentSummary } from '../../types/schemas';
import { billLabel, billLabelFromId, isFederalBill, isStateMeasure } from '../../lib/bills';
import { useCore } from '../../lib/core';
import { recordBasis } from '../../lib/courts';
import { formatDate, formatNumber } from '../../lib/format';
import { eventLabel, relationshipLabel, reverseRelationshipLabel, useTagLabels } from '../../lib/labels';
import { buildHash } from '../../lib/router';
import { allOf, type Loadable } from '../../lib/useLoad';
import { LINK_CHECK_SCOPE, METHOD_LABELS } from '../../lib/verification';
import { A, ErrorNote, Ext, GapNotice, Loading, Section, TableScroll, VerificationBadge } from '../../components/ui';

/** A quotation that ends a sentence already carries its full stop: "… becomes operative." takes no second one. */
export function endsSentence(quote: string): boolean {
  return /[.?!]["'”’)\]]*\s*$/.test(quote);
}

/** The links of a measure that lead to a court case. */
export function caseLinksOf(relationships: readonly EntityRelationship[]): EntityRelationship[] {
  return relationships.filter((r) => r.source.type === 'case' || r.target.type === 'case');
}

/** The cases those links lead to, as far as the case index holds them. */
export function linkedCasesOf(relationships: readonly EntityRelationship[], cases: readonly LegalCaseSummary[]): LegalCaseSummary[] {
  return caseLinksOf(relationships)
    .map((r) => cases.find((c) => c.id === (r.source.type === 'case' ? r.source.id : r.target.id)))
    .filter((c): c is LegalCaseSummary => Boolean(c));
}

/**
 * The "In the courts" cell: the cases linked to the measure, each with the court's latest ruling entry first, so a
 * request quoted below it never reads as pending when it was decided.
 */
export function CourtsCell({ bill, links }: { bill: LegislativeInstrument; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  // Until the links and the case index are loaded, the cell says so rather than "no link".
  const courts = allOf(links, core.cases);
  return (
    <>
      <h3>In the courts</h3>
      {courts.status === 'loading' ? <Loading what="linked court cases" />
      : courts.status === 'error' ? <ErrorNote error={courts.error} what="the links to court cases" />
      : linkedCasesOf(courts.data[0], courts.data[1]).length > 0 ? (
        <ul className="plain-list">
          {caseLinksOf(courts.data[0]).map((r) => {
            const c = courts.data[1].find((x) => x.id === (r.source.type === 'case' ? r.source.id : r.target.id));
            if (!c) return null;
            const ruling = c.latestDispositiveEntry;
            const basis = recordBasis(c);
            return (
              <li key={r.id}>
                <a className="case-name" href={buildHash(['litigation', c.id])}>{c.caseName}</a>, No. {c.docketNumber}
                {ruling ? (
                  <p className="row-line">
                    {basis === 'docket' ? 'Latest ruling entry on the docket' : basis === 'govinfo' ? 'Latest decision among the documents GovInfo holds' : 'Latest opinion of the court among the decisions CourtListener holds'}: <span className="row-date">{formatDate(ruling.date)}</span>{' '}
                    {basis === 'courtlistener' ? ruling.text : <>{eventLabel(ruling.eventType, ruling.ruleId)}: <q>{ruling.text}</q></>}
                  </p>
                ) : (
                  <p className="row-line quiet">
                    {basis === 'docket' ? 'No ruling entry identified on the docket by DemocracyHQ’s rules; see the docket.'
                      : basis === 'govinfo' ? 'No decision identified among the documents GovInfo holds for the case.'
                      : 'No opinion of the court among the documents CourtListener holds for the case.'}
                  </p>
                )}
                {r.scope.note ? <p className="link-scope">{r.scope.note}</p> : null}
                {r.support.quote ? <p className="link-support">From <Ext href={r.support.url}>{r.support.document ?? 'the cited court document'}</Ext>: <q>{r.support.quote}</q></p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="status-value">No linked case in this dataset</p>
      )}
      <p className="quiet">{bill.judicialNote}</p>
    </>
  );
}

/**
 * The text versions with what changed from one to the next. A California version carries the official subject line it
 * was published with; the versions of a measure of Congress carry none.
 */
export function TextVersions({ bill }: { bill: LegislativeInstrument }) {
  const federal = isFederalBill(bill);
  return (
    <Section
      title="Text versions"
      note={federal
        ? 'Each version is the text the Government Publishing Office publishes for the measure. Compare any two to see what was added and removed.'
        : 'Each version is the legislature’s own published text, with the official subject line it carried. Compare any two to see what was added and removed.'}
    >
      <TableScroll label="Text versions">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Version</th><th scope="col">Date</th><th scope="col" className="num">Words</th>
              <th scope="col">{federal ? 'Change from previous version' : 'Official subject and change from previous version'}</th>
            </tr>
          </thead>
          <tbody>
            {bill.versions.map((version, index) => {
              const previous = index > 0 ? bill.versions[index - 1] : undefined;
              return (
                <tr key={version.id}>
                  <td className="cell-links">
                    <span>
                      {version.textAvailability === 'mirrored'
                        ? <a href={buildHash(['laws', bill.id, 'compare'], { to: version.id })}>{version.label}</a>
                        : <>{version.label} <span className="quiet">(text not mirrored)</span></>}
                    </span>
                    <span><Ext href={version.officialUrl} className="quiet">Official version</Ext></span>
                  </td>
                  <td className="cell-date">{formatDate(version.versionDate)}</td>
                  <td className="num">{formatNumber(version.wordCount, 'n/a')}</td>
                  <td>
                    {federal ? null : <div className="version-subject">Official subject: {version.subject?.trim() || <span className="quiet">not recorded</span>}</div>}
                    <div>{previous && version.diff && version.textAvailability === 'mirrored' && previous.textAvailability === 'mirrored' ? (
                      version.diff.blocksAdded === 0 && version.diff.blocksRemoved === 0
                        ? <span className="quiet">Identical text</span>
                        : <a href={buildHash(['laws', bill.id, 'compare'], { from: previous.id, to: version.id })}>
                            Compare with {previous.label}: {formatNumber(version.diff.blocksAdded)} added or changed, {formatNumber(version.diff.blocksRemoved)} removed or replaced
                          </a>
                    ) : previous ? <span className="quiet">Comparison unavailable</span> : <span className="quiet">First version</span>}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      {bill.versions.length === 0 ? (
        <GapNotice>
          {federal
            ? 'The official record lists no text version with a published text for this measure yet.'
            : 'No text version was found in the official data for this measure.'}
        </GapNotice>
      ) : null}
    </Section>
  );
}

/** The curated links to other measures and to places, each with the passage that supports it. */
export function LinkedMeasuresAndPlaces({ bill, links }: { bill: LegislativeInstrument; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  if (links.status === 'loading') return <Section title="Linked measures and places"><Loading what="the links to other measures and places" /></Section>;
  if (links.status === 'error') return <Section title="Linked measures and places"><ErrorNote error={links.error} what="the links between records" /></Section>;
  const cases = caseLinksOf(links.data);
  const others = links.data.filter((r) => !cases.includes(r));
  if (others.length === 0) return null;
  const allBills = core.bills.status === 'ready' ? core.bills.data.bills : [];
  const geo = core.geo.status === 'ready' ? core.geo.data : undefined;
  return (
    <Section title="Linked measures and places" note="Each link cites the passage of the bill text that supports it.">
      <ul className="links">
        {others.map((r) => {
          const other = r.source.type === 'bill' && r.source.id === bill.id ? r.target : r.source;
          const otherBill = other.type === 'bill' ? allBills.find((b) => b.id === other.id) : undefined;
          const label = other.type === 'geography' ? geo?.get(other.id)?.name ?? other.id : otherBill ? billLabel(otherBill) : billLabelFromId(other.id) ?? other.id;
          const href = other.type === 'geography' ? buildHash(['place', other.id]) : buildHash(['laws', other.id]);
          const outgoing = r.source.id === bill.id;
          return (
            <li key={r.id} className="link-item">
              <p className="link-head">
                <span className="link-kind">{outgoing ? relationshipLabel(r.relationshipType) : reverseRelationshipLabel(r.relationshipType)}</span> <a href={href}>{label}</a>
              </p>
              {r.scope.note ? <p className="link-scope">{r.scope.note}</p> : null}
              {r.support.quote ? <p className="link-support">From <Ext href={r.support.url}>{r.support.document ?? 'the official bill text'}</Ext>: <q>{r.support.quote}</q></p> : null}
              <p className="link-foot">
                <VerificationBadge status={r.verification.status} />{' '}
                <span className="quiet">
                  {r.basis === 'curated' ? LINK_CHECK_SCOPE : `${METHOD_LABELS[r.verification.method] ?? r.verification.method}. The check does not test the description.`}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Why the selection rule picked the measure, and the issue tags the keyword rules gave it. `tests` says in words what
 * each test of the rule asks for: those of Congress's rule unless another legislature's are given.
 */
export function ListedAndTags({ bill, tests }: { bill: LegislativeInstrumentSummary; tests?: Readonly<Record<string, string>> }) {
  const core = useCore();
  const labels = useTagLabels();
  const selection = bill.selection;
  const allTests = tests ?? (core.bills.status === 'ready' ? core.bills.data.federal.tests : undefined);
  const test = selection?.test ? allTests?.[selection.test] : undefined;
  const rule = selection ? <A to={buildHash(['sources'], { section: 'coverage' })}>{selection.ruleId}</A> : null;
  return (
    <Section title="Why this measure is listed, and its tags">
      {selection && isFederalBill(bill) ? (
        <p>
          Included because one of its titles contains &ldquo;{selection.matchedText}&rdquo;
          {selection.matchedTitle ? <>: <q>{selection.matchedTitle}</q> ({selection.matchedField})</> : <> ({selection.matchedField})</>}.
          {' '}That meets {selection.test ? <>the test &ldquo;{selection.test}&rdquo; of </> : null}selection rule {rule}{test ? `: ${test}` : ''}.
          The rule reads titles and the policy area only, not the text of the measure.
        </p>
      ) : selection && isStateMeasure(bill) ? (
        <p>
          {selection.test === 'subject'
            ? <>Included because the legislature files it under &ldquo;{selection.matchedText}&rdquo;, as Open States records it.</>
            : <>Included because its title contains &ldquo;{selection.matchedText}&rdquo;.</>}
          {' '}That meets {selection.test ? <>the test &ldquo;{selection.test}&rdquo; of </> : null}selection rule {rule}{test ? `: ${test}` : ''}.
          {' '}The rule reads the title and the subjects only, not the text of the measure.
        </p>
      ) : selection ? (
        <p>Included because its {selection.matchedField} contains &ldquo;{selection.matchedText}&rdquo; (selection rule {rule}).</p>
      ) : null}
      {bill.issueTags.length > 0 ? (
        <TableScroll label="Issue tags">
          <table className="table">
            <thead><tr><th scope="col">Tag</th><th scope="col">Matched in</th><th scope="col">Matched text</th></tr></thead>
            <tbody>
              {bill.issueTags.map((tag) => (
                <tr key={tag.tag}>
                  <td><a className="tag" href={buildHash(['laws'], { tag: tag.tag })}>{labels.get(tag.tag) ?? tag.tag}</a><br /><span className="quiet">rule {tag.ruleId}</span></td>
                  <td>{tag.matchedField}</td>
                  <td>&hellip;{tag.matchedText}&hellip;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : <p className="quiet">No issue rule matched.</p>}
    </Section>
  );
}
