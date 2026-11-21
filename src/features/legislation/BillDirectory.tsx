import { useId, useMemo, useRef } from 'react';
import type { LegislativeInstrumentSummary } from '../../types/schemas';
import { billJurisdiction, billLabel, isFederalBill, shortSession, statusNoun } from '../../lib/bills';
import { passageDeadlineNote, pendingAfterDeadline } from '../../lib/caSession';
import { useCore, type BillCatalog } from '../../lib/core';
import { countBy, filterBills, knownBillFilters, type BillFilters } from '../../lib/filters';
import { formatDate, plural } from '../../lib/format';
import { useTagLabels } from '../../lib/labels';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, ClearFilters, Empty, GapNotice, MoreFilters, Segmented, SelectField, TagList, TextField, TypeMark } from '../../components/ui';

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

export function BillRow({ bill, labels }: { bill: LegislativeInstrumentSummary; labels: ReadonlyMap<string, string> }) {
  return (
    <li className="row">
      <a className="row-title" href={buildHash(['laws', bill.id])}>
        <span className="bill-id">{billLabel(bill)}</span> {bill.subject ?? bill.title ?? 'No subject recorded'}
      </a>
      <p className="row-meta">{bill.measureType}, {isFederalBill(bill) ? shortSession(bill.session) : `California, ${bill.session}`}</p>
      <p className="row-line">
        {statusNoun(bill)}: {statusLine(bill)}
        {latestTextLine(bill) ? <span className="quiet">. Latest text version: {latestTextLine(bill)}</span> : null}
      </p>
      <p className="row-foot">
        Last action {formatDate(bill.lastActionDate)}: {bill.lastActionText ?? 'not recorded'}
      </p>
      <TagList tags={bill.issueTags} labels={labels} hrefFor={(tag) => buildHash(['laws'], { tag })} />
    </li>
  );
}

export function BillDirectory({ route }: { route: Route }) {
  const core = useCore();
  return (
    <article className="view">
      <header className="view-head">
        <TypeMark type="bill" label="Legislation" />
        <h1 tabIndex={-1}>Election legislation</h1>
        <p className="lede">Election measures of Congress and of the California Legislature, each with its official history and every published text version, so you can see exactly what changed between versions.</p>
      </header>
      <Async of={core.bills} what="legislation">
        {(catalog) => <Directory catalog={catalog} route={route} />}
      </Async>
    </article>
  );
}

const LEGISLATURES = [{ value: '', label: 'All' }, { value: 'us', label: 'Congress' }, { value: 'ca', label: 'California' }];

function Directory({ catalog, route }: { catalog: BillCatalog; route: Route }) {
  const core = useCore();
  const labels = useTagLabels();
  const bills = catalog.bills;
  // Values that are not among the menu's choices are not applied, so the list and the menus agree.
  const filters = knownBillFilters(billFiltersFromQuery(route.query), bills);
  const set = (patch: Record<string, string>) => patchQuery(route, patch);
  // The menus offer what the chosen legislature's measures have. Congress and a state legislature use different words
  // for a measure's status and kind, so those two menus appear once a legislature is chosen.
  const pool = useMemo(() => (filters.jur ? bills.filter((b) => billJurisdiction(b) === filters.jur) : bills), [bills, filters.jur]);
  const federal = useMemo(() => bills.filter(isFederalBill), [bills]);
  const california = useMemo(() => bills.filter((b) => !isFederalBill(b)), [bills]);
  // Judged against the data release, never against the reader's clock.
  const asOf = dataOf(core.manifest)?.generatedAt ?? bills.reduce<string | null>((latest, b) => (!latest || b.lastCheckedAt > latest ? b.lastCheckedAt : latest), null);
  const pastDeadline = useMemo(() => pool.filter((b) => pendingAfterDeadline(b, asOf)).length, [pool, asOf]);
  const results = useMemo(() => filterBills(bills, filters), [bills, filters.q, filters.tag, filters.jur, filters.status, filters.type, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => countBy(pool, (b) => b.issueTags.map((t) => t.tag)), [pool]);
  const statusOptions = useMemo(() => countBy(pool, (b) => [currentStatus(b)]), [pool]);
  const typeOptions = useMemo(() => countBy(pool, (b) => [b.measureType]), [pool]);
  const active = Boolean(filters.q || filters.tag || filters.status || filters.type);
  const status = useRef<HTMLParagraphElement | null>(null);
  const setInGrid = [filters.tag, filters.status, filters.type].filter(Boolean).length;
  const statusId = useId();
  const deadlineId = useId();
  const deadlineHint = filters.jur === 'ca' && pastDeadline > 0 && asOf ? passageDeadlineNote(asOf) : null;
  const congress = [...new Set(federal.map((b) => shortSession(b.session)))].join(' and ');
  const sessions = [...new Set(california.map((b) => b.session))].join(' and ');
  const rule = (ruleId: string) => <A to={buildHash(['sources'], { section: 'coverage' })}>rule {ruleId}</A>;
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
  const clearTo = buildHash(['laws'], filters.jur ? { jur: filters.jur } : {});
  const noun = filters.jur === 'us' ? 'measure of Congress' : filters.jur === 'ca' ? 'California measure' : 'measure';
  const nounPlural = filters.jur === 'us' ? 'measures of Congress' : `${noun}s`;
  return (
    <>
      <Segmented
        label="Legislature"
        value={filters.jur ?? ''}
        options={LEGISLATURES}
        // A status or a kind of measure belongs to one legislature, so changing the legislature drops both.
        onChange={(jur) => set({ jur, status: '', type: '', tag: '' })}
      />
      <p className="coverage-note">
        {filters.jur === 'us' ? <>Covers {federalNote}. A measure whose titles do not say that it concerns elections is missed.</>
          : filters.jur === 'ca' ? <>Covers {californiaNote}. Other state legislatures are not covered yet.</>
          : <>Covers two legislatures: {federalNote}; and {californiaNote}. Other state legislatures are not covered yet.</>}
      </p>
      <form className="filters" role="search" aria-label="Filter legislation" onSubmit={(event) => event.preventDefault()}>
        <TextField label="Search measure number or subject" value={filters.q ?? ''} onChange={(q) => set({ q })} placeholder="e.g. H.R. 22, AB 604 or vote by mail" />
        <MoreFilters
          count={setInGrid}
          status={(
            <p className="filters-status" role="status" tabIndex={-1} ref={status}>
              {plural(results.length, noun, nounPlural)} {active ? `of ${pool.length} match these filters` : 'in this dataset'}
              {active ? <> <ClearFilters to={clearTo} focus={status} /></> : null}
            </p>
          )}
        >
          <div className="filters-grid">
            {tagOptions.length > 0 ? (
              <SelectField label="Issue" value={filters.tag ?? ''} onChange={(tag) => set({ tag })}>
                <option value="">All issues</option>
                {tagOptions.map((o) => <option key={o.value} value={o.value}>{labels.get(o.value) ?? o.value} ({o.count})</option>)}
              </SelectField>
            ) : null}
            {filters.jur ? (
              <>
                {/* Written out rather than through SelectField, so the select can point at the deadline note below. */}
                <div className="field">
                  <label htmlFor={statusId}>{filters.jur === 'us' ? 'Stage reached' : 'Status as reported'}</label>
                  <select id={statusId} value={filters.status ?? ''} onChange={(event) => set({ status: event.target.value })} aria-describedby={deadlineHint ? deadlineId : undefined}>
                    <option value="">{filters.jur === 'us' ? 'Any stage' : 'Any status'}</option>
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
          {!filters.jur ? <p className="hint">Choose a legislature above to filter by stage or status and by kind of measure: Congress and California use different terms for both.</p> : null}
          {filters.jur === 'us' ? (
            <p className="hint">
              The stage is how far a measure got among its recorded actions, worked out by a published rule ({rule('us-status-1')}). It is not an official status, and it does not say what is happening to the measure now.
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
          <GapNotice>Only the current Congress and California&rsquo;s current session are covered, and only the measures the selection rules matched.</GapNotice>
          <p><ClearFilters to={clearTo} focus={status} /></p>
        </Empty>
      ) : (
        <ul className="rows">{results.map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
      )}
    </>
  );
}
