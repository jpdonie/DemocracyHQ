import type { EntityRelationship, LegislativeInstrument } from '../../types/schemas';
import { billHeading, isFederalBill } from '../../lib/bills';
import { useCore } from '../../lib/core';
import { loadBill } from '../../lib/data';
import { EARLIER_SUBJECT_EXPLAINER, earlierSubject, earlierSubjectNote } from '../../lib/billHistory';
import { passageDeadlineNote, pendingAfterDeadline } from '../../lib/caSession';
import { BALLOT_RESULTS_NOTE, entityNamer, expiryScope, metCaveat, packForBill, turnsOnBallot, withoutMetCaveat } from '../../lib/export';
import { formatDate, plural } from '../../lib/format';
import { isRecordStale } from '../../lib/freshness';
import { eventLabel } from '../../lib/labels';
import { relationshipsForRecord, sameWords } from '../../lib/relations';
import { buildHash, patchQuery, shareUrl, type Route } from '../../lib/router';
import { dataOf, mapLoadable, useLoad, type Loadable } from '../../lib/useLoad';
import { AboutBlock } from '../../components/About';
import { A, Async, BackLink, CopyLinkButton, ExportMenu, Facts, Loading, Section, Segmented, SourceLine, TypeMark, WatchButton } from '../../components/ui';
import { latestTextLine, statusLine } from './BillDirectory';
import { CourtsCell, LinkedMeasuresAndPlaces, ListedAndTags, TextVersions, endsSentence, linkedCasesOf } from './billParts';
import { FederalBillBody } from './FederalBillDetail';

const BASIS_LABELS: Readonly<Record<string, string>> = {
  not_verified: 'Not verified',
  immediate_effect_flag: 'Derived by rule from the immediate-effect flag in the official bill data',
  stated_in_text: 'Stated in the bill text',
};

/**
 * Every headline the effective-date cell can show besides a date, with what each means. The Sources page lists exactly
 * these. None of them depends on today's date: the site does not know a legislature's calendar rules, so it never says
 * whether a measure can still be enacted ("yet"), only what the official record showed at the last check.
 */
export const EFFECTIVE_HEADLINES = {
  notApplicable: { text: 'Not applicable', when: 'a resolution, which has no effective date' },
  notEnacted: { text: 'None: not enacted', when: 'a bill that died or failed' },
  vetoed: { text: 'None: vetoed, not enacted as of the last check', when: 'a vetoed bill, which is not enacted unless the Legislature overrides the veto' },
  notEnactedAsOf: { text: 'None: not enacted as of the last check', when: 'any other bill that the official history did not show as approved or chaptered at the last check' },
  notAdopted: { text: 'None: not adopted', when: 'a constitutional amendment, or another measure that is adopted rather than enacted, that died or failed' },
  notAdoptedAsOf: { text: 'None: not adopted as of the last check', when: 'any other such measure that the official history did not show as adopted and filed at the last check' },
  notVerified: { text: 'Not verified', when: 'anything else, including a chaptered statute without the immediate-effect flag' },
} as const;

const FINAL_STATUSES: ReadonlySet<string> = new Set(['Died', 'Failed', 'Vetoed']);

/** A vetoed bill: the official status says so, or the history records a veto. */
function isVetoed(bill: Pick<LegislativeInstrument, 'legislativeStatus' | 'vetoedDate'>): boolean {
  return bill.legislativeStatus.currentStatus === 'Vetoed' || Boolean(bill.vetoedDate);
}

/** The headline of the effective-date cell. Only a date the data supports is ever shown as a date. */
export function effectiveHeadline(bill: LegislativeInstrument): string {
  if (bill.effective.date) return formatDate(bill.effective.date);
  switch (bill.effective.basis) {
    case 'not_applicable': return EFFECTIVE_HEADLINES.notApplicable.text;
    case 'not_enacted': {
      const final = FINAL_STATUSES.has(bill.legislativeStatus.currentStatus ?? '') || Boolean(bill.vetoedDate);
      // A constitutional amendment is adopted by the Legislature and filed, not enacted.
      if (isAdoptedMeasure(bill)) return final ? EFFECTIVE_HEADLINES.notAdopted.text : EFFECTIVE_HEADLINES.notAdoptedAsOf.text;
      // The Legislature can override a veto (Cal. Const. art. IV, § 10(a)), so a veto is not called final.
      if (isVetoed(bill)) return EFFECTIVE_HEADLINES.vetoed.text;
      return final ? EFFECTIVE_HEADLINES.notEnacted.text : EFFECTIVE_HEADLINES.notEnactedAsOf.text;
    }
    default: return EFFECTIVE_HEADLINES.notVerified.text;
  }
}

/** The Sources page's account of the effective-date cell, built from the same list the cell draws on. */
export function effectiveHeadlineGuide(): string {
  const quoted = (key: keyof typeof EFFECTIVE_HEADLINES) => `“${EFFECTIVE_HEADLINES[key].text}” for ${EFFECTIVE_HEADLINES[key].when}`;
  return `Otherwise the cell shows ${quoted('notApplicable')}; ${quoted('notEnacted')}; ${quoted('vetoed')}; ${quoted('notEnactedAsOf')}; ${quoted('notAdopted')}; ${quoted('notAdoptedAsOf')}; and ${quoted('notVerified')}.`;
}

/** Resolutions and constitutional amendments are adopted and filed, not enacted. */
function isAdoptedMeasure(bill: LegislativeInstrument): boolean {
  return bill.chapter?.type === 'CHR' || /Resolution|Constitutional Amendment/.test(bill.measureType);
}

export function BillDetail({ id, route }: { id: string; route: Route }) {
  const core = useCore();
  const record = useLoad(`bill:${id}`, () => loadBill(id));
  return (
    <article className="view">
      <BackLink to={buildHash(['laws'])}>All tracked legislation</BackLink>
      <Async of={record} what="this measure" heading="Measure">
        {(data) => {
          const links = mapLoadable(core.relationships, (all) => relationshipsForRecord('bill', data.id, all));
          return isFederalBill(data) ? <FederalBillBody bill={data} route={route} links={links} /> : <BillBody bill={data} route={route} links={links} />;
        }}
      </Async>
    </article>
  );
}

function BillBody({ bill, route, links }: { bill: LegislativeInstrument; route: Route; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  const sources = dataOf(core.sources) ?? [];
  const relationships = dataOf(links) ?? [];
  const cases = dataOf(core.cases) ?? [];
  const allBills = dataOf(core.bills)?.bills ?? [];
  const geo = dataOf(core.geo);
  const source = sources.find((s) => s.id === bill.sourceId);
  const stale = source ? isRecordStale(bill.lastCheckedAt, source.staleAfterDays, core.now) : false;
  const showAll = route.query.history === 'all';
  // Rows are keyed by their place in the full history: a date and sequence number can repeat.
  const numbered = bill.actions.map((action, index) => ({ action, key: action.historyId ?? `row-${index}` }));
  const actions = showAll ? numbered : numbered.filter(({ action }) => action.significance === 'major');
  const majorCount = bill.actions.filter((a) => a.significance === 'major').length;
  const linkedCases = linkedCasesOf(relationships, cases);
  const enacted = Boolean(bill.chapteredDate || bill.approvedDate);
  const adopted = isAdoptedMeasure(bill);
  // A statute can be in effect while a part of it waits on another measure. Surface that next to the date.
  const conditions = relationships.filter((r) => /^operative_only_if/.test(r.relationshipType) && r.source.type === 'bill' && r.source.id === bill.id && r.target.type === 'bill');
  // Conditions found in the text by rule ca-cond-1 that no curated link already explains.
  const textConditions = bill.conditions.filter((c) => !conditions.some((r) => r.support.quote && sameWords(r.support.quote, c.text)));
  const conditional = conditions.length > 0 || textConditions.length > 0;
  const digestVersion = [...bill.versions].reverse().find((v) => v.textAvailability === 'mirrored');
  // Whether the passage deadline has passed is judged against the data release, never against the reader's clock.
  const asOf = dataOf(core.manifest)?.generatedAt ?? bill.lastCheckedAt;
  const pastDeadline = pendingAfterDeadline(bill, asOf);
  const ballot = turnsOnBallot(bill, [...conditions.flatMap((r) => [r.scope.note, r.support.quote]), ...bill.conditions.map((c) => c.text)]);
  const effectiveWide = conditional || bill.expiryClauses.length > 0;
  const versionLabel = (id: string) => bill.versions.find((v) => v.id === id)?.label ?? id;
  // The subject line in force when each action was taken, where it named a different subject from today's.
  const earlier = new Map(bill.actions.map((action, index) => [action.historyId ?? `row-${index}`, earlierSubject(bill, action)]));
  // The explainer is shown only when a listed action carries the note, not when only a hidden one does.
  const anyEarlier = actions.some(({ key }) => Boolean(earlier.get(key)));

  return (
    <>
      <header className="view-head">
        <TypeMark type="bill" />
        <h1 tabIndex={-1}><span className="bill-id">{billHeading(bill)}</span></h1>
        <p className="lede">{bill.subject ?? 'No subject recorded'}</p>
        <p className="quiet">{bill.measureType}, {bill.session}{bill.leadAuthors ? `. ${bill.leadAuthors}` : ''}</p>
        <AboutBlock about={bill.about} terms={bill.selection?.matchedText ? [bill.selection.matchedText] : []} type="bill" />
        <div className="btn-row">
          <WatchButton item={{ type: 'bill', id: bill.id, label: `${bill.stateAbbr} ${bill.identifier}: ${bill.subject ?? ''}` }} />
          <CopyLinkButton hash={buildHash(['laws', bill.id], route.query)} />
        </div>
      </header>

      <Section title="Where this measure stands" note="Four different questions, answered separately. Passing the legislature, taking effect and being enforceable are not the same thing.">
        <div className="status-grid">
          <div className="status-cell">
            <h3>Legislative status</h3>
            <p className="status-value">{statusLine(bill)}</p>
            <p className="quiet">
              The status word the official bill data gives.{latestTextLine(bill) ? ` Latest text version: ${latestTextLine(bill)}.` : ''} Last action {formatDate(bill.lastActionDate)}: {bill.lastActionText ?? 'not recorded'}
            </p>
            {pastDeadline ? <p className="status-condition">{passageDeadlineNote(asOf)}</p> : null}
          </div>
          <div className="status-cell">
            <h3>{adopted ? 'Adoption' : 'Enactment'}</h3>
            {enacted || bill.vetoedDate ? (
              <Facts tight items={[
                ...(bill.approvedDate ? [['Approved by the Governor', formatDate(bill.approvedDate)] as [string, string]] : []),
                ...(bill.chapteredDate ? [[adopted ? 'Adopted and filed with the Secretary of State' : 'Chaptered', `${formatDate(bill.chapteredDate)}${bill.chapter?.citation ? `, ${bill.chapter.citation}` : ''}`] as [string, string]] : []),
                ...(bill.vetoedDate ? [['Vetoed', formatDate(bill.vetoedDate)] as [string, string]] : []),
              ]} />
            ) : (
              <p className="status-value">{adopted ? 'Not adopted' : 'Not enacted'}{bill.legislativeStatus.currentStatus ? ` (status: ${bill.legislativeStatus.currentStatus})` : ''}</p>
            )}
            {!enacted && !bill.vetoedDate ? <p className="quiet">The official history shows no {adopted ? 'adoption and filing' : 'approval, chaptering or veto'} as of the last check.</p> : null}
          </div>
          <div className={effectiveWide ? 'status-cell status-cell--wide' : 'status-cell'}>
            <h3>Effective date</h3>
            <p className="status-value">{effectiveHeadline(bill)}{conditional ? ', subject to a condition in the text' : ''}</p>
            {/* The notes in the data each say that whether a condition was met is not recorded; the cell says it once, after the conditions. */}
            {conditions.map((r) => {
              const other = allBills.find((b) => b.id === r.target.id);
              return (
                <p key={r.id} className="status-condition">
                  <strong>Condition stated in the bill text.</strong> {r.scope.note ? withoutMetCaveat(r.scope.note) : 'Part of this measure is operative only if another measure takes effect.'}{' '}
                  {r.support.quote ? <>The text reads: <q>{r.support.quote}</q>{endsSentence(r.support.quote) ? ' ' : '. '}</> : null}
                  {bill.effective.date ? 'The date above is not the date those provisions begin to apply. ' : ''}See{' '}
                  <a href={buildHash(['laws', r.target.id])}>{other ? `${other.stateAbbr} ${other.identifier}` : r.target.id}</a>.
                </p>
              );
            })}
            {textConditions.map((c) => (
              <p key={c.text} className="status-condition">
                <strong>Condition found in the text</strong> (rule <A to={buildHash(['sources'], { section: 'rules' })}>{c.ruleId}</A>, version {bill.versions.find((v) => v.id === c.versionId)?.label ?? c.versionId}): <q>{c.text}</q>{endsSentence(c.text) ? '' : '.'}
              </p>
            ))}
            {conditional ? <p className="status-met">{metCaveat(conditions.length + textConditions.length)}</p> : null}
            {/* Said next to "not recorded" when there is a condition, otherwise after the note that explains the vote. */}
            {ballot && conditional ? <p className="status-met">{BALLOT_RESULTS_NOTE}</p> : null}
            {bill.expiryClauses.map((c) => (
              <p key={`${c.versionId}:${c.text}`} className="status-condition">
                <strong>Expiry stated in the text{c.date ? `: ${formatDate(c.date)}` : ''}.</strong> Found by rule <A to={buildHash(['sources'], { section: 'rules' })}>{c.ruleId}</A> in version {versionLabel(c.versionId)}: <q>{c.text}</q>{endsSentence(c.text) ? ' ' : '. '}{expiryScope(enacted, adopted)}
              </p>
            ))}
            {links.status === 'loading' ? <Loading what="conditions recorded as links to other measures" /> : null}
            {links.status === 'error' ? <p className="quiet">The links between records could not be loaded, so a condition recorded as a link to another measure is not shown here.</p> : null}
            <p className="quiet">{bill.effective.date ? `Basis: ${BASIS_LABELS[bill.effective.basis] ?? bill.effective.basis}. ` : ''}{conditional ? withoutMetCaveat(bill.effective.note) : bill.effective.note}</p>
            {ballot && !conditional ? <p className="status-met">{BALLOT_RESULTS_NOTE}</p> : null}
          </div>
          <div className={effectiveWide ? 'status-cell status-cell--wide' : 'status-cell'}>
            <CourtsCell bill={bill} links={links} />
          </div>
        </div>
      </Section>

      <TextVersions bill={bill} />

      {bill.digest ? (
        <Section title="Legislative Counsel’s digest" note={`Prepared by the Legislative Counsel${digestVersion ? ` for the “${digestVersion.label}” version of ${formatDate(digestVersion.versionDate)}` : ''}. It is not part of the law, it is not voted on, and it is not DemocracyHQ analysis. Its account of existing law is as of that version.`}>
          <details className="reading-details">
            <summary>Read the digest</summary>
            <div className="reading">{bill.digest.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div>
          </details>
        </Section>
      ) : null}

      {bill.affectedStatutes.length > 0 ? (
        <Section
          title="Code sections named in the latest version’s amending clauses"
          // A veto can still be overridden (Cal. Const. art. IV, § 10(a)), so, as in the effective-date cell, it is not called final.
          note={`Taken from the amending clauses of the bill text.${enacted ? '' : ` Proposed changes; this measure ${FINAL_STATUSES.has(bill.legislativeStatus.currentStatus ?? '') && !isVetoed(bill) ? 'was not' : 'has not been'} ${adopted ? 'adopted' : 'enacted'}.`}`}
        >
          <ul className="plain-list">
            {bill.affectedStatutes.slice(0, 40).map((s, i) => <li key={i}>{s.text}</li>)}
          </ul>
          {bill.affectedStatutes.length > 40 ? <p className="quiet">And {bill.affectedStatutes.length - 40} more; see the bill text.</p> : null}
        </Section>
      ) : null}

      <LinkedMeasuresAndPlaces bill={bill} links={links} />

      <Section title="Legislative history" id="history" note={anyEarlier ? EARLIER_SUBJECT_EXPLAINER : undefined}>
        <div className="toolbar">
          <Segmented
            label="Show"
            value={showAll ? 'all' : 'major'}
            options={[{ value: 'major', label: `Key actions (${majorCount})` }, { value: 'all', label: `All actions (${bill.actions.length})` }]}
            onChange={(value) => patchQuery(route, { history: value === 'all' ? 'all' : '' })}
          />
        </div>
        <ol className="entries">
          {actions.map(({ action, key }) => (
            <li key={key} className={`entry${action.significance === 'major' ? ' entry-major' : ''}`}>
              <time dateTime={action.date}>{formatDate(action.date)}</time>
              <div>
                <p className="entry-text">{action.text}{action.status ? <strong className="entry-status"> ({action.status.toLowerCase()} in the official record)</strong> : null}</p>
                <p className="entry-kind">{eventLabel(action.eventType, action.classificationRule)}{action.location ? <span className="quiet">. Location after this action: {action.location}</span> : null}</p>
                {earlier.get(key) ? <p className="entry-subject row-line">{earlierSubjectNote(earlier.get(key)!)}</p> : null}
              </div>
            </li>
          ))}
        </ol>
        {actions.length === 0 ? <p className="quiet">No {showAll ? '' : 'key '}actions recorded.</p> : null}
      </Section>

      <ListedAndTags bill={bill} />

      <SourceLine
        sourceName={source?.name ?? 'California Legislative Information'}
        sourceUrl={bill.officialUrl}
        verification={bill.verification}
        lastCheckedAt={bill.lastCheckedAt}
        sourceActivity={{ label: 'Latest action reported by the Legislature', date: bill.lastActionDate }}
        stale={stale}
        correctionSubject={`${bill.stateAbbr} ${bill.identifier} (${bill.session})`}
      >
        <p className="quiet">Official data file published {formatDate(bill.sourcePublishedAt)}. {plural(bill.versionCount, 'text version')}. Links to leginfo.legislature.ca.gov are built from the bill identifier and are not machine-checked, because that site blocks automated requests.</p>
      </SourceLine>
      <ExportMenu
        printHash={buildHash(['pack', 'bill', bill.id])}
        // Not offered while the links, the case index or the source list are loading; a file that failed is named in the pack.
        build={() => (links.status === 'loading' || core.cases.status === 'loading' || core.sources.status === 'loading' ? null : packForBill({
          record: bill, relationships: dataOf(links), linkedCases: core.cases.status === 'ready' ? linkedCases : null,
          now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
          nameOf: entityNamer({ geo, bills: allBills, cases }),
        }))}
      />
    </>
  );
}
