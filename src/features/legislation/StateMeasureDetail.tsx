/**
 * The page of a measure of a state legislature read from Open States. Open States collects the record from the
 * legislature's own site: the title, the subjects the legislature files the measure under, the sponsors, every recorded
 * action and the links to the published texts. The texts are not mirrored here. The stage is DemocracyHQ's own reading
 * of the recorded actions (rule state-status-1), never an official status.
 */
import type { StateLegislationIndex, StateMeasure } from '../../types/schemas';
import { STATE_STAGES, billHeading, billLabel } from '../../lib/bills';
import { useCore, useStateLegislation } from '../../lib/core';
import { DataError, loadStateMeasures } from '../../lib/data';
import { formatDate, plural } from '../../lib/format';
import { isRecordStale } from '../../lib/freshness';
import { STATE_NAME, stateFipsOfAbbr } from '../../lib/geo';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf, useLoad, type Loadable } from '../../lib/useLoad';
import { AboutBlock, Highlight } from '../../components/About';
import { A, Async, BackLink, CopyLinkButton, Ext, Section, Segmented, SourceLine, TypeMark, WatchButton } from '../../components/ui';
import { ListedAndTags } from './billParts';

/** The legislatures of one chamber, where one passage is the passage of the legislature (os_bulk.UNICAMERAL). */
const UNICAMERAL: ReadonlySet<string> = new Set(['31', '11']);

/**
 * The steps of the stage track, in the order of rule state-status-1. A vetoed measure has "Vetoed" where the others have
 * "Signed by the governor"; a measure that became law has neither, because a measure can become law without the
 * governor's signature; a legislature of one chamber has no "Passed one chamber". The track shows where the furthest
 * stage stands in that order: the stages before it are not each recorded.
 */
export function stageTrack(stage: string, state: string): { steps: string[]; reached: number } {
  const left = new Set(stage === 'Vetoed' ? ['Signed by the governor'] : stage === 'Became law' ? ['Vetoed', 'Signed by the governor'] : ['Vetoed']);
  if (UNICAMERAL.has(state)) left.add('Passed one chamber');
  const steps = STATE_STAGES.filter((s) => !left.has(s));
  return { steps, reached: steps.indexOf(stage) };
}

/** The kinds of action Open States gives, as words: "committee-passage-favorable" reads "committee passage favorable". */
export function actionKinds(classification: readonly string[]): string {
  return classification.map((kind) => kind.replace(/-/g, ' ')).join(', ');
}

/** Actions that move a measure from one stage to another, or end it: shown first, the rest on request. */
const KEY_ACTIONS = /^(?:filing|introduction|passage|failure|withdrawal|executive-|veto-override|became-law|committee-passage|committee-failure)/;

export function isKeyAction(classification: readonly string[]): boolean {
  return classification.some((kind) => KEY_ACTIONS.test(kind));
}

export function StateMeasureDetail({ id, route }: { id: string; route: Route }) {
  const abbr = id.slice(3, 5);
  const name = STATE_NAME[stateFipsOfAbbr(abbr) ?? ''] ?? abbr.toUpperCase();
  // The records of a state's measures come in one file, which serves every page of that state.
  const file = useLoad(`state-measures:${abbr}`, () => loadStateMeasures(abbr));
  const index = useStateLegislation();
  const record: Loadable<StateMeasure> = file.status !== 'ready' ? file : (() => {
    const found = file.data.bills.find((bill) => bill.id === id);
    return found
      ? { status: 'ready', data: found }
      : { status: 'error', error: new DataError('not_found', id, 'No measure of that legislature in this dataset has this id. Ids can change when a session is renamed.') };
  })();
  return (
    <article className="view">
      <BackLink to={buildHash(['laws'], { jur: abbr })}>Election legislation of {name}</BackLink>
      <Async of={record} what="this measure" heading="Measure">
        {(bill) => <StateMeasureBody bill={bill} route={route} index={dataOf(index)} />}
      </Async>
    </article>
  );
}

function StateMeasureBody({ bill, route, index }: { bill: StateMeasure; route: Route; index: StateLegislationIndex | null }) {
  const core = useCore();
  const sources = dataOf(core.sources) ?? [];
  const source = sources.find((s) => s.id === bill.sourceId);
  const stale = source ? isRecordStale(bill.lastCheckedAt, source.staleAfterDays, core.now) : false;
  const label = billLabel(bill);
  const selection = bill.selection;
  // The words the rule matched are marked in the title only when the title is what the rule matched.
  const terms = selection.test === 'subject' ? [] : [selection.matchedText];
  const primary = bill.sponsors.filter((s) => s.primary).map((s) => s.name);
  const stage = bill.legislativeStatus.currentStatus ?? 'Not recorded';
  const track = stageTrack(stage, bill.state);
  const showAll = route.query.history === 'all';
  const numbered = bill.actions.map((action, at) => ({ action, key: `row-${at}` }));
  const keyCount = bill.actions.filter((a) => isKeyAction(a.classification)).length;
  const actions = showAll ? numbered : numbered.filter(({ action }) => isKeyAction(action.classification));
  const rule = (ruleId: string) => <A to={buildHash(['sources'], { section: 'coverage' })}>rule {ruleId}</A>;
  const statusRule = index?.selection.statusRuleId ?? 'state-status-1';

  return (
    <>
      <header className="view-head">
        <TypeMark type="bill" />
        <h1 tabIndex={-1}><span className="bill-id">{billHeading(bill)}</span></h1>
        <p className="lede"><Highlight text={bill.title ?? 'No title recorded'} terms={terms} /></p>
        <p className="quiet">
          {bill.measureType}, {bill.session}
          {primary.length > 0 ? `. ${primary.length === 1 ? 'Sponsor' : 'Sponsors'}: ${primary.join('; ')}` : ''}
          {bill.sponsors.length > primary.length ? `, with ${plural(bill.sponsors.length - primary.length, 'other sponsor')}` : ''}
        </p>
        <p className="why-listed">
          <span className="why-listed-head">Why it is listed</span>{' '}
          {selection.test === 'subject'
            ? <>The legislature files it under <span className="term">{selection.matchedText}</span>.</>
            : <>Its title names <mark className="hit">{selection.matchedText}</mark>.</>}
          {' '}<span className="quiet">({rule(selection.ruleId)})</span>
        </p>
        <AboutBlock about={bill.about} type="bill" />
        <div className="btn-row">
          <WatchButton item={{ type: 'bill', id: bill.id, label: `${label}: ${bill.title ?? ''}` }} />
          <CopyLinkButton hash={buildHash(['laws', bill.id], route.query)} />
        </div>
      </header>

      <Section title="Where this measure stands">
        <div className="status-grid">
          <div className="status-cell status-cell--wide">
            <h3>Stage reached</h3>
            <p className="status-value">{stage}</p>
            {track.reached >= 0 ? (
              <ol className="stage-track" aria-label={`Stages in the order of ${statusRule}`}>
                {track.steps.map((step, at) => (
                  <li key={step} className={at < track.reached ? 'is-before' : at === track.reached ? 'is-reached' : undefined} aria-current={at === track.reached ? 'step' : undefined}>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="quiet">
              Worked out from the recorded actions by {rule(statusRule)}. Not an official status.
            </p>
          </div>
          <div className="status-cell">
            <h3>Latest action</h3>
            <p className="status-value">{formatDate(bill.lastActionDate)}</p>
            <p className="quiet">{bill.lastActionText ?? 'Not recorded'}</p>
          </div>
          <div className="status-cell">
            <h3>The legislature&rsquo;s record</h3>
            <ul className="plain-list">
              {bill.sources.map((url) => <li key={url}><Ext href={url}>{new URL(url).hostname}</Ext></li>)}
            </ul>
            <p className="quiet">The legislature&rsquo;s own pages: the record that counts.</p>
          </div>
        </div>
      </Section>

      <Section
        title={`Text versions (${bill.versions.length})`}
        note="As the legislature publishes them. Not mirrored here, so not compared."
      >
        {bill.versions.length > 0 ? (
          <ul className="rows">
            {bill.versions.map((version, at) => (
              <li key={`${version.note}:${at}`} className="row">
                <p className="row-title">{version.note}{version.date ? <span className="quiet">, {formatDate(version.date)}</span> : null}</p>
                <p className="row-line">
                  {version.links.map((link, i) => (
                    <span key={link.url}>{i > 0 ? ' · ' : ''}<Ext href={link.url}>{link.mediaType === 'application/pdf' ? 'PDF' : link.mediaType === 'text/html' ? 'Web page' : link.mediaType ?? 'Text'}</Ext></span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="quiet">Open States names no published text of this measure.</p>}
      </Section>

      <Section title="Legislative history" id="history" note="The actions as Open States records them from the legislature.">
        <div className="toolbar">
          <Segmented
            label="Show"
            value={showAll ? 'all' : 'key'}
            options={[{ value: 'key', label: `Key actions (${keyCount})` }, { value: 'all', label: `All actions (${bill.actions.length})` }]}
            onChange={(value) => patchQuery(route, { history: value === 'all' ? 'all' : '' })}
          />
        </div>
        <ol className="entries">
          {actions.map(({ action, key }) => (
            <li key={key} className={`entry${isKeyAction(action.classification) ? ' entry-major' : ''}`}>
              <time dateTime={action.date}>{formatDate(action.date)}</time>
              <div>
                <p className="entry-text">{action.text}</p>
                {action.classification.length > 0 ? <p className="entry-kind">{actionKinds(action.classification)}</p> : null}
              </div>
            </li>
          ))}
        </ol>
        {actions.length === 0 ? <p className="quiet">No {showAll ? '' : 'key '}actions recorded.</p> : null}
      </Section>

      {bill.sponsors.length > 0 ? (
        <Section title={`Sponsors (${bill.sponsors.length})`} note="As Open States names them from the legislature’s record.">
          <ul className="plain-list">
            {bill.sponsors.map((sponsor, at) => (
              <li key={`${sponsor.name}:${at}`}>{sponsor.name}{sponsor.classification ? <span className="quiet"> ({sponsor.classification})</span> : null}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <ListedAndTags bill={bill} tests={index?.selection.tests} />

      {bill.subjects.length > 0 ? (
        <Section title="Subjects the legislature files it under" note="As Open States records them.">
          <ul className="plain-list">{bill.subjects.map((subject) => <li key={subject}>{subject}</li>)}</ul>
        </Section>
      ) : null}

      <SourceLine
        sourceName={source?.name ?? 'Open States'}
        sourceUrl={bill.officialUrl}
        verification={bill.verification}
        lastCheckedAt={bill.lastCheckedAt}
        sourceActivity={{ label: 'Latest action Open States records', date: bill.lastActionDate }}
        stale={stale}
        correctionSubject={`${label} (${bill.session})`}
      >
        <p className="quiet">
          Read from the bulk data of Open States{index ? `, scanned ${formatDate(index.scannedAt.slice(0, 10))}` : ''}. Open States collects it from the legislature&rsquo;s site; compare it with the legislature&rsquo;s own page, linked above. {plural(bill.versionCount, 'text version')}.
        </p>
      </SourceLine>
    </>
  );
}
