import { useId, useMemo, useRef } from 'react';
import type { LegislativeInstrumentSummary, StateLegislationIndex } from '../../types/schemas';
import { PASSED_IN_EACH_LIST_NOTE, PASSED_IN_EACH_SHORT, PASSED_IN_EACH_STAGES, STATE_STAGES, billLabel, isFederalBill, isStateMeasure, shortSession, stateLabel, statusNoun } from '../../lib/bills';
import { passageDeadlineNote, pendingAfterDeadline } from '../../lib/caSession';
import { useCore, useStateLegislation, type BillCatalog } from '../../lib/core';
import { ALL_STATES, countBy, filterBills, inJurisdiction, knownBillFilters, positiveInt, type BillFilters } from '../../lib/filters';
import { STATE_NAME, stateFipsOfAbbr } from '../../lib/geo';
import { COMPACT_QUERY, useMediaQuery } from '../../lib/media';
import { legislatureCoverage, listNames, unlistedSummary, whyNoneListed } from '../../lib/stateLegislation';
import { formatDate, plural } from '../../lib/format';
import { useTagLabels } from '../../lib/labels';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { allOf, dataOf } from '../../lib/useLoad';
import { AboutLine, Highlight, holdsTerm } from '../../components/About';
import { A, Async, ClearFilters, Empty, GapNotice, MoreFilters, SelectField, TagList, TextField, TypeMark } from '../../components/ui';

export function billFiltersFromQuery(query: Route['query']): BillFilters {
  const sort = query.sort === 'number' || query.sort === 'introduced' ? query.sort : 'action';
  return { q: query.q, tag: query.tag, jur: query.jur, status: query.status, type: query.type, sort };
}

/**
 * The measure's status line: a state legislature's own status word (Chaptered, Vetoed, Died, In Committee Process, ...),
 * or for a measure of Congress the stage it reached (Introduced, Passed the House, Became law, ...).
 */
export function currentStatus(bill: LegislativeInstrumentSummary): string {
  return bill.legislativeStatus.currentStatus ?? 'Not recorded';
}

export function statusLine(bill: LegislativeInstrumentSummary): string {
  const state = bill.legislativeStatus.currentStatus ?? 'Status not recorded';
  return bill.chapter?.citation ? `${state} (${bill.chapter.citation})` : state;
}

/** The state of the latest text version (Introduced, Amended Senate, Enrolled, ...). It is not the measure's status. */
export function latestTextLine(bill: LegislativeInstrumentSummary): string | null {
  const text = bill.legislativeStatus.measureState;
  return text && text !== bill.legislativeStatus.currentStatus ? text : null;
}

/** The title a list shows a measure under. */
export function shownTitle(bill: LegislativeInstrumentSummary): string {
  return bill.subject ?? bill.title ?? 'No subject recorded';
}

/**
 * A long title shortened around the words that matter. It is cut at spaces, and an ellipsis stands wherever text is
 * left out. Nothing is reworded.
 */
export function excerptAround(text: string, term: string, max = 170): string {
  if (text.length <= max) return text;
  const trim = (value: string) => value.replace(/[ ,;:]+$/, '');
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0 || at + term.length <= max) return `${trim(text.slice(0, text.lastIndexOf(' ', max)))} …`;
  const from = Math.max(0, at - Math.floor((max - term.length) / 2));
  const start = from === 0 ? 0 : text.indexOf(' ', from) + 1;
  const to = Math.min(text.length, start + max);
  const end = to === text.length ? to : text.lastIndexOf(' ', to);
  return `${start > 0 ? '… ' : ''}${trim(text.slice(start, end))}${end < text.length ? ' …' : ''}`;
}

/**
 * The words the selection rule matched, to be marked in the quotation of a measure. The rule reads the titles of a
 * measure and nothing else, so the words are marked only where the quotation is a title (the official title of a
 * measure without a summary). A summary or a digest that happens to use the same words is a text the rule never read.
 */
export function termsInQuotation(bill: LegislativeInstrumentSummary): string[] {
  return bill.about?.source === 'official-title' && bill.selection?.matchedText ? [bill.selection.matchedText] : [];
}

/**
 * The title that put a measure in the dataset, when a row would not show it otherwise. A measure is listed under its
 * display title, and the selection rule may have matched another one: a bill named for veterans that carries the
 * "Safeguard American Voter Eligibility Act" as a short title of its amended text. Null when the row already shows the
 * matched words in a title: the one it is listed under, or the official title quoted below it. A summary that uses
 * the same words does not count, because the rule did not read the summary.
 */
export function matchedElsewhere(bill: LegislativeInstrumentSummary): { title: string; field: string; words: string } | null {
  const selection = bill.selection;
  if (!selection?.matchedTitle || !selection.matchedText) return null;
  const words = [selection.matchedText];
  if (holdsTerm(shownTitle(bill), words) || holdsTerm(bill.about?.text, termsInQuotation(bill))) return null;
  return { title: selection.matchedTitle, field: selection.matchedField, words: selection.matchedText };
}

/** How long a title a row shows of a state measure read from Open States, cut around the words the rule matched. */
const STATE_TITLE_LIMIT = 240;

export function BillRow({ bill, labels }: { bill: LegislativeInstrumentSummary; labels: ReadonlyMap<string, string> }) {
  const matched = bill.selection?.matchedText ? [bill.selection.matchedText] : [];
  const elsewhere = matchedElsewhere(bill);
  // A state legislature's title can run to a paragraph: the row shows the part around the words that put it on the list.
  const state = isStateMeasure(bill);
  const title = state ? excerptAround(shownTitle(bill), bill.selection?.test === 'subject' ? '' : bill.selection?.matchedText ?? '', STATE_TITLE_LIMIT) : shownTitle(bill);
  return (
    <li className="row">
      <a className="row-title" href={buildHash(['laws', bill.id])}>
        <span className="bill-id">{billLabel(bill)}</span> <Highlight text={title} terms={matched} />
      </a>
      <p className="row-meta">{bill.measureType}, {isFederalBill(bill) ? shortSession(bill.session) : `${stateLabel(bill)}, ${bill.session}`}</p>
      {elsewhere ? (
        <p className="row-why">
          Also titled <q><Highlight text={excerptAround(elsewhere.title, elsewhere.words)} terms={matched} /></q> <span className="quiet">({elsewhere.field})</span>
        </p>
      ) : null}
      {state && bill.selection?.test === 'subject' ? (
        <p className="row-why">Filed by the legislature under <span className="row-why-value">{bill.selection.matchedText}</span></p>
      ) : null}
      <AboutLine about={bill.about} terms={termsInQuotation(bill)} />
      <TagList tags={bill.issueTags} labels={labels} hrefFor={(tag) => buildHash(['laws'], { tag })} />
      <p className="row-line">
        {statusNoun(bill)}: {statusLine(bill)}
        {isFederalBill(bill) && PASSED_IN_EACH_STAGES.has(currentStatus(bill)) ? <span className="quiet"> ({PASSED_IN_EACH_SHORT})</span> : null}
        {latestTextLine(bill) ? <span className="quiet">. Latest text version: {latestTextLine(bill)}</span> : null}
      </p>
      <p className="row-foot">
        Last action {formatDate(bill.lastActionDate)}: {bill.lastActionText ?? 'not recorded'}
      </p>
    </li>
  );
}

export function BillDirectory({ route }: { route: Route }) {
  const core = useCore();
  // The list waits for both indexes: a list of "all measures" with the state legislatures silently missing would read as a finding.
  const states = useStateLegislation();
  return (
    <article className="view">
      <header className="view-head">
        <TypeMark type="bill" label="Legislation" />
        <h1 tabIndex={-1}>Election legislation</h1>
        <p className="lede">Election measures of Congress and of the state legislatures, each with the words that put it on the list, how far it got and a link to the legislature&rsquo;s own record. The measures of Congress and of California carry every published text version, so you can see what changed.</p>
      </header>
      <Async of={allOf(core.bills, states)} what="legislation">
        {([catalog, index]) => <Directory catalog={catalog} index={index} route={route} />}
      </Async>
    </article>
  );
}

/** How many rows the list shows before the reader asks for more. */
export const BILL_ROWS_SHOWN = 100;

const isOpenStatesLegislature = (jur: string | null | undefined): jur is string => Boolean(jur && jur !== 'us' && jur !== 'ca' && jur !== ALL_STATES);

function Directory({ catalog, index, route }: { catalog: BillCatalog; index: StateLegislationIndex; route: Route }) {
  const core = useCore();
  const labels = useTagLabels();
  const compact = useMediaQuery(COMPACT_QUERY);
  const bills = useMemo(() => [...catalog.bills, ...index.bills], [catalog, index]);
  // Values that are not among the menu's choices are not applied, so the list and the menus agree.
  const filters = knownBillFilters(billFiltersFromQuery(route.query), bills);
  // A change of a filter starts the list at its first rows again.
  const set = (patch: Record<string, string>) => patchQuery(route, { ...patch, show: '' });
  const limit = positiveInt(route.query.show, BILL_ROWS_SHOWN);
  const jur = filters.jur;
  const level = !jur ? '' : jur === 'us' ? 'us' : ALL_STATES;
  // One legislature: Congress, California or a legislature read from Open States.
  const single = jur && jur !== ALL_STATES ? jur : null;
  const coverage = useMemo(() => legislatureCoverage(index), [index]);
  const legislature = isOpenStatesLegislature(single) ? coverage.get(single) ?? null : null;
  // The menus offer what the chosen legislature's measures have. Congress and the state legislatures use different
  // words for a measure's status and kind, so those two menus appear once a single legislature is chosen.
  const pool = useMemo(() => (jur ? bills.filter((b) => inJurisdiction(b, jur)) : bills), [bills, jur]);
  const federal = useMemo(() => catalog.bills.filter(isFederalBill), [catalog]);
  const california = useMemo(() => catalog.bills.filter((b) => !isFederalBill(b)), [catalog]);
  // Judged against the data release, never against the reader's clock.
  const asOf = dataOf(core.manifest)?.generatedAt ?? bills.reduce<string | null>((latest, b) => (!latest || b.lastCheckedAt > latest ? b.lastCheckedAt : latest), null);
  const pastDeadline = useMemo(() => pool.filter((b) => pendingAfterDeadline(b, asOf)).length, [pool, asOf]);
  const results = useMemo(() => filterBills(bills, filters), [bills, filters.q, filters.tag, filters.jur, filters.status, filters.type, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => countBy(pool, (b) => b.issueTags.map((t) => t.tag)), [pool]);
  // A stage of rule state-status-1 is listed in the order of the rule, from the first to the furthest.
  const statusOptions = useMemo(() => {
    const options = countBy(pool, (b) => [currentStatus(b)]);
    if (!isOpenStatesLegislature(single)) return options;
    const rank = (value: string) => (STATE_STAGES.includes(value) ? STATE_STAGES.indexOf(value) : STATE_STAGES.length);
    return options.sort((a, b) => rank(a.value) - rank(b.value));
  }, [pool, single]);
  const typeOptions = useMemo(() => countBy(pool, (b) => [b.measureType]), [pool]);
  // Every state whose legislature is read or left out, with how many of its measures are listed: a state with none is
  // a choice too, and its list then says why it is empty.
  const stateOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bills) if (!isFederalBill(b)) counts.set(b.stateAbbr.toLowerCase(), (counts.get(b.stateAbbr.toLowerCase()) ?? 0) + 1);
    for (const key of coverage.keys()) if (!counts.has(key)) counts.set(key, 0);
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count, name: STATE_NAME[stateFipsOfAbbr(value) ?? ''] ?? value.toUpperCase() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bills, coverage]);
  const stateLegislatures = index.bills.length + california.length;
  const active = Boolean(filters.q || filters.tag || filters.status || filters.type);
  const status = useRef<HTMLParagraphElement | null>(null);
  // A state chosen implies the level of the state legislatures, so the two count as one filter.
  const setFirst = [filters.tag, level].filter(Boolean).length;
  const setInGrid = [filters.status, filters.type].filter(Boolean).length;
  const statusId = useId();
  const deadlineId = useId();
  const deadlineHint = jur === 'ca' && pastDeadline > 0 && asOf ? passageDeadlineNote(asOf) : null;
  const congress = [...new Set(federal.map((b) => shortSession(b.session)))].join(' and ');
  const sessions = [...new Set(california.map((b) => b.session))].join(' and ');
  const rule = (ruleId: string) => <A to={buildHash(['sources'], { section: 'coverage' })}>rule {ruleId}</A>;
  const read = [...coverage.values()].filter((l) => l.listed > 0);
  const withDc = read.some((l) => l.stateAbbr === 'DC');
  const federalNote = (
    <>
      {plural(federal.length, 'measure')} of the {congress}, chosen from the {catalog.federal.totalMeasuresRead.toLocaleString('en-US')} measures in the official bill status data by a published keyword rule applied to each measure&rsquo;s titles and policy area ({rule(catalog.federal.ruleId)})
    </>
  );
  const californiaNote = (
    <>
      {plural(california.length, 'measure')} of California&rsquo;s {sessions}, chosen from {catalog.california.totalBillsInSession.toLocaleString('en-US')} bills by a published keyword rule applied to each bill&rsquo;s official subject line ({rule(catalog.california.ruleId)})
    </>
  );
  const statesNote = (
    <>
      {plural(index.bills.length, 'measure')} of the legislatures of {read.length - (withDc ? 1 : 0)} other states{withDc ? ' and the District of Columbia' : ''}, from their sessions since {formatDate(index.selection.since)}, chosen from the {index.selection.totalMeasuresRead.toLocaleString('en-US')} measures Open States holds for those sessions by a published rule applied to each measure&rsquo;s title and the subjects the legislature files it under ({rule(index.selection.ruleId)})
    </>
  );
  const unlisted = unlistedSummary(coverage);
  const unlistedNote = unlisted ? <> {unlisted}</> : null;
  const openStatesNote = ' Open States collects these records from each legislature’s site; every measure links to the legislature’s own page.';
  const legislatureNote = legislature ? (
    legislature.listed > 0 ? (
      <>
        Covers {plural(legislature.listed, 'measure')} of the {legislature.name} legislature from {legislature.sessions.length === 1 ? 'its session' : 'its sessions'} {listNames(legislature.sessions.map((session) => session.name))}, chosen from the {legislature.measuresRead.toLocaleString('en-US')} measures Open States holds for {legislature.sessions.length === 1 ? 'that session' : 'those sessions'} by a published rule applied to each measure&rsquo;s title and the subjects the legislature files it under ({rule(index.selection.ruleId)}).{openStatesNote}
        {legislature.withoutSecureLink > 0 ? ` ${plural(legislature.withoutSecureLink, 'other measure')} the rule picked ${legislature.withoutSecureLink === 1 ? 'is' : 'are'} not listed, because Open States gives no secure address of the legislature’s page for ${legislature.withoutSecureLink === 1 ? 'it' : 'them'} (rule secure-link-1).` : ''}
      </>
    ) : <>{whyNoneListed(legislature)}</>
  ) : isOpenStatesLegislature(single) ? <>No session of this legislature was read.</> : null;
  const clearTo = buildHash(['laws'], jur ? { jur } : {});
  const stateName = legislature?.name ?? (single === 'ca' ? 'California' : null);
  const noun = jur === 'us' ? 'measure of Congress' : stateName ? `${stateName} measure` : jur === ALL_STATES ? 'state measure' : 'measure';
  const nounPlural = jur === 'us' ? 'measures of Congress' : `${noun}s`;
  return (
    <>
      <p className="coverage-note">
        {jur === 'us' ? <>Covers {federalNote}. A measure whose titles do not say that it concerns elections is missed.</>
          : jur === 'ca' ? <>Covers {californiaNote}.</>
          : legislatureNote ? legislatureNote
          : jur === ALL_STATES ? <>Covers {californiaNote}; and {statesNote}.{openStatesNote}{unlistedNote}</>
          : <>Covers {federalNote}; {californiaNote}; and {statesNote}.{openStatesNote}{unlistedNote}</>}
      </p>
      <form className="filters" role="search" aria-label="Filter legislation" onSubmit={(event) => event.preventDefault()}>
        <TextField label="Search measure number, title or summary" value={filters.q ?? ''} onChange={(q) => set({ q })} placeholder="e.g. H.R. 22, AB 604 or proof of citizenship" />
        <MoreFilters
          count={setInGrid}
          primaryCount={setFirst}
          primary={(
            <div className="filters-grid filters-first">
              {/* A status or a kind of measure belongs to one legislature, so a change of the legislature lets go of both. */}
              <SelectField label="Legislature" value={level} onChange={(value) => set({ jur: value, status: '', type: '' })}>
                <option value="">Congress and the states</option>
                <option value="us">Congress ({federal.length.toLocaleString('en-US')})</option>
                <option value={ALL_STATES}>State legislatures ({stateLegislatures.toLocaleString('en-US')})</option>
              </SelectField>
              <SelectField label="State" value={single && single !== 'us' ? single : ''} onChange={(value) => set({ jur: value || ALL_STATES, status: '', type: '' })}>
                <option value="">All states</option>
                {stateOptions.map((o) => <option key={o.value} value={o.value}>{o.name} ({o.count.toLocaleString('en-US')})</option>)}
              </SelectField>
              {tagOptions.length > 0 ? (
                <SelectField label="Issue" value={filters.tag ?? ''} onChange={(tag) => set({ tag })}>
                  <option value="">All issues</option>
                  {tagOptions.map((o) => <option key={o.value} value={o.value}>{labels.get(o.value) ?? o.value} ({o.count.toLocaleString('en-US')})</option>)}
                </SelectField>
              ) : null}
            </div>
          )}
          status={(
            <p className="filters-status" role="status" tabIndex={-1} ref={status}>
              {plural(results.length, noun, nounPlural)} {active ? `of ${pool.length.toLocaleString('en-US')} match these filters` : 'in this dataset'}
              {active ? <> <ClearFilters to={clearTo} focus={status} /></> : null}
            </p>
          )}
        >
          <div className="filters-grid">
            {single ? (
              <>
                {/* Written out rather than through SelectField, so the select can point at the deadline note below. */}
                <div className="field">
                  <label htmlFor={statusId}>{single === 'ca' ? 'Status as reported' : 'Stage reached'}</label>
                  <select id={statusId} value={filters.status ?? ''} onChange={(event) => set({ status: event.target.value })} aria-describedby={deadlineHint ? deadlineId : undefined}>
                    <option value="">{single === 'ca' ? 'Any status' : 'Any stage'}</option>
                    {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
                  </select>
                </div>
                <SelectField label="Measure type" value={filters.type ?? ''} onChange={(type) => set({ type })}>
                  <option value="">All types</option>
                  {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
                </SelectField>
              </>
            ) : null}
            <SelectField label="Sort by" value={filters.sort ?? 'action'} onChange={(sort) => set({ sort: sort === 'action' ? '' : sort })}>
              <option value="action">Latest action</option>
              <option value="introduced">Date introduced</option>
              <option value="number">Measure number</option>
            </SelectField>
          </div>
          {!single ? <p className="hint">Choose Congress or one state to filter by stage or status and by kind of measure: legislatures use different terms for both.</p> : null}
          {single === 'us' ? (
            <p className="hint">
              The stage is how far a measure got among its recorded actions, worked out by a published rule ({rule('us-status-1')}). It is not an official status, and it does not say what is happening to the measure now.
              {statusOptions.some((o) => PASSED_IN_EACH_STAGES.has(o.value)) ? ` ${PASSED_IN_EACH_LIST_NOTE}` : ''}
            </p>
          ) : null}
          {isOpenStatesLegislature(single) ? (
            <p className="hint">
              The stage is how far a measure got among the actions Open States records for it, worked out by a published rule ({rule(index.selection.statusRuleId)}). It is not an official status, and it does not say what is happening to the measure now.
            </p>
          ) : null}
          {/* Counted over the whole legislature, like the counts in the status menu, so it does not change with the filters. */}
          {deadlineHint ? (
            <p className="hint" id={deadlineId}>
              Status as reported: {plural(pastDeadline, 'Assembly or Senate bill', 'Assembly or Senate bills')} in this dataset still {pastDeadline === 1 ? 'shows' : 'show'} In Committee Process, Pending Referral or In Floor Process. {deadlineHint}
            </p>
          ) : null}
        </MoreFilters>
      </form>
      {results.length === 0 ? (
        <Empty title="No measure in this dataset matches these filters.">
          <GapNotice>Only the sessions read and only the measures the selection rules matched are covered. A measure that is missing here may well exist.</GapNotice>
          <p><ClearFilters to={clearTo} focus={status} /></p>
        </Empty>
      ) : (
        <>
          <ul className="rows">{results.slice(0, limit).map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
          {results.length > limit ? (
            <p className="rows-more">
              <button type="button" className="btn" onClick={() => patchQuery(route, { show: String(limit + BILL_ROWS_SHOWN) })}>Show {Math.min(BILL_ROWS_SHOWN, results.length - limit)} more</button>
              {' '}<span className="quiet">{limit.toLocaleString('en-US')} of {plural(results.length, 'measure')} shown</span>
            </p>
          ) : null}
        </>
      )}
      {jur !== 'us' ? (
        <p className="hint">
          {compact
            ? 'To list the measures of one state, choose it under “State”, or use “Show more map” and select it on the map.'
            : 'Select a state on the map to list the measures of its legislature, and select it again to list every state’s. The other filters stay as they are, and the map shades the states with a measure that matches them.'}
          {' '}The measures of Congress apply to the whole country and are listed under &ldquo;Congress&rdquo;.
        </p>
      ) : null}
    </>
  );
}
