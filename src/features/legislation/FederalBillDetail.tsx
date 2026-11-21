/**
 * The page of a measure of Congress. It is read from the measure's bill status record on GovInfo: titles, sponsors,
 * committees, every recorded action, the roll-call votes the record links and the measures it names as related. The
 * stage is DemocracyHQ's own reading of the actions (rule us-status-1), never an official status.
 */
import type { EntityRelationship, LegislativeInstrument, RelatedMeasure } from '../../types/schemas';
import { FEDERAL_TEXT_SOURCE_ID, PASSED_IN_EACH_NOTE, PASSED_IN_EACH_STAGES, billLabel, isAdoptedMeasure } from '../../lib/bills';
import { useCore } from '../../lib/core';
import { entityNamer, packForBill } from '../../lib/export';
import { formatDate, plural } from '../../lib/format';
import { isRecordStale } from '../../lib/freshness';
import { eventLabel } from '../../lib/labels';
import { NATION_KEY } from '../../lib/geo';
import { buildHash, patchQuery, shareUrl, type Route } from '../../lib/router';
import { dataOf, type Loadable } from '../../lib/useLoad';
import { A, CopyLinkButton, ExportMenu, Ext, Facts, Section, Segmented, SourceLine, TypeMark, WatchButton } from '../../components/ui';
import { latestTextLine, statusLine } from './BillDirectory';
import { CourtsCell, LinkedMeasuresAndPlaces, ListedAndTags, TextVersions, linkedCasesOf } from './billParts';

/** What the enactment cell says in one line. A measure that is not a law at all (a simple or concurrent resolution) is named as such. */
function enactmentHeadline(bill: LegislativeInstrument): string {
  if (bill.chapteredDate) return bill.chapter?.citation ?? 'Became law';
  if (bill.vetoedDate) return 'Vetoed by the President';
  if (bill.effective.basis === 'not_applicable') return 'Not a law';
  return 'Not enacted';
}

function RelatedMeasures({ related }: { related: readonly RelatedMeasure[] }) {
  if (related.length === 0) return null;
  return (
    <Section
      title={`Related measures (${related.length})`}
      note="As the official record names them, with who identified the relation. A measure links to its page here when it is in this dataset; the others are not election measures by the selection rule, or belong to another Congress."
    >
      <ul className="rows">
        {related.map((measure, index) => (
          <li key={`${measure.identifier}:${index}`} className="row">
            <p className="row-title">
              {measure.id
                ? <a href={buildHash(['laws', measure.id])}><span className="bill-id">{measure.identifier}</span> {measure.title}</a>
                : <><span className="bill-id">{measure.identifier}</span> {measure.title}</>}
            </p>
            <p className="row-meta">
              {measure.relationship}, identified by {measure.identifiedBy === 'CRS' ? 'the Congressional Research Service' : measure.identifiedBy.replace(/\bCRS\b/, 'the Congressional Research Service')}
              {measure.id ? '' : '. Not in this dataset'}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function FederalBillBody({ bill, route, links }: { bill: LegislativeInstrument; route: Route; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  const sources = dataOf(core.sources) ?? [];
  const cases = dataOf(core.cases) ?? [];
  const source = sources.find((s) => s.id === bill.sourceId);
  const stale = source ? isRecordStale(bill.lastCheckedAt, source.staleAfterDays, core.now) : false;
  const showAll = route.query.history === 'all';
  const numbered = bill.actions.map((action, index) => ({ action, key: `row-${index}` }));
  const actions = showAll ? numbered : numbered.filter(({ action }) => action.significance === 'major');
  const majorCount = bill.actions.filter((a) => a.significance === 'major').length;
  const adopted = isAdoptedMeasure(bill);
  const stage = bill.legislativeStatus.currentStatus ?? '';
  const label = billLabel(bill);
  const sponsors = bill.sponsors.map((sponsor) => sponsor.name);
  const votes = bill.actions.reduce((count, action) => count + action.votes.length, 0);

  return (
    <>
      <header className="view-head">
        <TypeMark type="bill" />
        <h1 tabIndex={-1}><span className="bill-id">{label}</span></h1>
        <p className="lede">{bill.subject ?? bill.title ?? 'No title recorded'}</p>
        {bill.title && bill.title !== bill.subject ? <p className="quiet">Official title: {bill.title}</p> : null}
        <p className="quiet">
          {bill.measureType}, {bill.session}
          {sponsors.length > 0 ? `. Sponsor: ${sponsors.join('; ')}` : ''}
          {bill.cosponsorCount ? `, with ${plural(bill.cosponsorCount, 'cosponsor')}` : ''}
        </p>
        <div className="btn-row">
          <WatchButton item={{ type: 'bill', id: bill.id, label: `${label}: ${bill.subject ?? bill.title ?? ''}` }} />
          <CopyLinkButton hash={buildHash(['laws', bill.id], route.query)} />
        </div>
      </header>

      <Section title="Where this measure stands" note="Three different questions, answered separately. Passing a chamber, becoming law and being enforceable are not the same thing.">
        <div className="status-grid">
          <div className="status-cell">
            <h3>Stage reached</h3>
            <p className="status-value">{statusLine(bill)}</p>
            <p className="quiet">
              The furthest step among the actions in the official record, worked out by rule <A to={buildHash(['sources'], { section: 'rules' })}>us-status-1</A>. It is not an official status and does not say what is happening to the measure now.
              {latestTextLine(bill) ? ` Latest text version: ${latestTextLine(bill)}.` : ''} Latest action {formatDate(bill.lastActionDate)}: {bill.lastActionText ?? 'not recorded'}
            </p>
            {PASSED_IN_EACH_STAGES.has(stage) ? <p className="status-condition">{PASSED_IN_EACH_NOTE}</p> : null}
          </div>
          <div className="status-cell">
            <h3>{adopted ? 'Adoption' : 'Enactment'}</h3>
            {bill.chapteredDate || bill.approvedDate || bill.vetoedDate ? (
              <Facts tight items={[
                ...(bill.approvedDate ? [['Signed by the President', formatDate(bill.approvedDate)] as [string, string]] : []),
                ...(bill.chapteredDate ? [['Became law', `${formatDate(bill.chapteredDate)}${bill.chapter?.citation ? `, ${bill.chapter.citation}` : ''}`] as [string, string]] : []),
                ...(bill.vetoedDate ? [['Vetoed by the President', formatDate(bill.vetoedDate)] as [string, string]] : []),
              ]} />
            ) : (
              <p className="status-value">{enactmentHeadline(bill)}</p>
            )}
            <p className="quiet">{bill.effective.note}</p>
          </div>
          <div className="status-cell status-cell--wide">
            <CourtsCell bill={bill} links={links} />
          </div>
        </div>
      </Section>

      <Section title="Sponsor, committees and subjects" note="As the official record gives them.">
        <Facts items={[
          ['Sponsor', sponsors.length > 0 ? sponsors.join('; ') : 'Not recorded'],
          ['Cosponsors', bill.cosponsorCount != null ? bill.cosponsorCount.toLocaleString('en-US') : 'Not recorded'],
          ['Committees', bill.committees.length > 0 ? bill.committees.join('; ') : 'None recorded'],
          ['Policy area', bill.policyArea ? `${bill.policyArea} (assigned by the Congressional Research Service)` : 'None assigned yet'],
          ...(bill.legislativeSubjects.length > 0 ? [['Subject terms', bill.legislativeSubjects.join('; ')] as [string, string]] : []),
          ...(bill.shortTitles.filter((title) => title !== bill.subject).length > 0
            ? [['Other short titles', bill.shortTitles.filter((title) => title !== bill.subject).join('; ')] as [string, string]] : []),
          ['Applies to', <a key="nation" href={buildHash(['place', NATION_KEY])}>The whole country (the federal level)</a>],
        ]} />
      </Section>

      {bill.digest ? (
        <Section
          title="Summary by the Congressional Research Service"
          note={`Written by the Congressional Research Service${bill.digestVersion ? ` for the “${bill.digestVersion}” version` : ''}${bill.digestDate ? ` (${formatDate(bill.digestDate)})` : ''}. It is not part of the measure, it is not voted on, and it is not DemocracyHQ analysis. It describes that version only.`}
        >
          <details className="reading-details">
            <summary>Read the summary</summary>
            <div className="reading">{bill.digest.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div>
          </details>
        </Section>
      ) : null}

      <TextVersions bill={bill} />

      <RelatedMeasures related={bill.relatedMeasures} />

      <LinkedMeasuresAndPlaces bill={bill} links={links} />

      <Section
        title="Actions"
        id="history"
        note={`Every action the official record lists, in the order of their dates. The Library of Congress writes one standard line for each step a measure takes; only those lines are read as steps.${votes > 0 ? ' A recorded vote links to the chamber’s own page for it.' : ''}`}
      >
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
                <p className="entry-text">{action.text}</p>
                <p className="entry-kind">
                  {eventLabel(action.eventType, action.classificationRule)}{action.source ? <span className="quiet">. Recorded by: {action.source}</span> : null}
                </p>
                {action.votes.length > 0 ? (
                  <ul className="entry-docs">
                    {action.votes.map((vote) => (
                      <li key={vote.url}><Ext href={vote.url}>{vote.chamber} roll call {vote.rollNumber}{vote.session ? `, session ${vote.session}` : ''}</Ext></li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {actions.length === 0 ? <p className="quiet">No {showAll ? '' : 'key '}actions recorded.</p> : null}
      </Section>

      <ListedAndTags bill={bill} />

      <SourceLine
        sourceName={source?.name ?? 'GovInfo, Bill Status'}
        sourceUrl={bill.sourceRecordUrl ?? bill.officialUrl}
        verification={bill.verification}
        lastCheckedAt={bill.lastCheckedAt}
        sourceActivity={{ label: 'Latest action in the official record', date: bill.lastActionDate }}
        stale={stale}
        correctionSubject={`${label} (${bill.session})`}
      >
        <p className="quiet">
          Status record published {formatDate(bill.sourcePublishedAt)}. {plural(bill.versionCount, 'text version')}{sources.find((s) => s.id === FEDERAL_TEXT_SOURCE_ID) ? `, from ${sources.find((s) => s.id === FEDERAL_TEXT_SOURCE_ID)!.name}` : ''}.
          {' '}The measure&rsquo;s page on <Ext href={bill.officialUrl}>congress.gov</Ext> is built from its number and is not machine-checked.
        </p>
      </SourceLine>
      <ExportMenu
        printHash={buildHash(['pack', 'bill', bill.id])}
        // Not offered while the links, the case index or the source list are loading; a file that failed is named in the pack.
        build={() => (links.status === 'loading' || core.cases.status === 'loading' || core.sources.status === 'loading' ? null : packForBill({
          record: bill, relationships: dataOf(links), linkedCases: core.cases.status === 'ready' ? linkedCasesOf(dataOf(links) ?? [], cases) : null,
          now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
          nameOf: entityNamer({ geo: dataOf(core.geo), bills: dataOf(core.bills)?.bills, cases }),
        }))}
      />
    </>
  );
}
