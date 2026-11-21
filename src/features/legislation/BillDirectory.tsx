import { useId, useMemo, useRef } from 'react';
import type { BillIndex, LegislativeInstrumentSummary } from '../../types/schemas';
import { passageDeadlineNote, pendingAfterDeadline } from '../../lib/caSession';
import { useCore } from '../../lib/core';
import { countBy, filterBills, knownBillFilters, type BillFilters } from '../../lib/filters';
import { formatDate, plural } from '../../lib/format';
import { useTagLabels } from '../../lib/labels';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { A, Async, ClearFilters, Empty, GapNotice, MoreFilters, SelectField, TagList, TextField, TypeMark } from '../../components/ui';

export function billFiltersFromQuery(query: Route['query']): BillFilters {
  const sort = query.sort === 'number' || query.sort === 'introduced' ? query.sort : 'action';
  return { q: query.q, tag: query.tag, status: query.status, type: query.type, sort };
}

/** The legislature's own status word for the measure (Chaptered, Vetoed, Died, In Committee Process, ...). */
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
        <span className="bill-id">{bill.stateAbbr} {bill.identifier}</span> {bill.subject ?? bill.title ?? 'No subject recorded'}
      </a>
      <p className="row-meta">{bill.measureType}, {bill.session}</p>
      <p className="row-line">
        Status as reported: {statusLine(bill)}
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
        <h1 tabIndex={-1}>California election legislation</h1>
        <p className="lede">Election bills with their official history and every published text version, so you can see exactly what changed between versions.</p>
      </header>
      <Async of={core.bills} what="legislation">
        {(index) => <Directory index={index} route={route} />}
      </Async>
    </article>
  );
}

function Directory({ index, route }: { index: BillIndex; route: Route }) {
  const core = useCore();
  const labels = useTagLabels();
  const bills = index.bills;
  // Judged against the data release, never against the reader's clock.
  const asOf = dataOf(core.manifest)?.generatedAt ?? bills.reduce<string | null>((latest, b) => (!latest || b.lastCheckedAt > latest ? b.lastCheckedAt : latest), null);
  const pastDeadline = useMemo(() => bills.filter((b) => pendingAfterDeadline(b, asOf)).length, [bills, asOf]);
  // Values that are not among the menu's choices are not applied, so the list and the menus agree.
  const filters = knownBillFilters(billFiltersFromQuery(route.query), bills);
  const set = (patch: Record<string, string>) => patchQuery(route, patch);
  const results = useMemo(() => filterBills(bills, filters), [bills, filters.q, filters.tag, filters.status, filters.type, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => countBy(bills, (b) => b.issueTags.map((t) => t.tag)), [bills]);
  const statusOptions = useMemo(() => countBy(bills, (b) => [currentStatus(b)]), [bills]);
  const typeOptions = useMemo(() => countBy(bills, (b) => [b.measureType]), [bills]);
  const active = Boolean(filters.q || filters.tag || filters.status || filters.type);
  const status = useRef<HTMLParagraphElement | null>(null);
  const setInGrid = [filters.tag, filters.status, filters.type].filter(Boolean).length;
  const sessions = [...new Set(bills.map((b) => b.session))];
  const statusId = useId();
  const deadlineId = useId();
  const deadlineHint = pastDeadline > 0 && asOf ? passageDeadlineNote(asOf) : null;
  return (
    <>
      <p className="coverage-note">
        Covers California only: {plural(bills.length, 'measure')} from the {sessions.join(' and ')}, chosen from {index.selection.totalBillsInSession.toLocaleString('en-US')} bills by a published keyword rule applied to each bill&rsquo;s official subject line (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {index.selection.ruleId}</A>). Other states are not covered yet.
      </p>
      <form className="filters" role="search" aria-label="Filter legislation" onSubmit={(event) => event.preventDefault()}>
        <TextField label="Search bill number or subject" value={filters.q ?? ''} onChange={(q) => set({ q })} placeholder="e.g. AB 604 or vote by mail" />
        <MoreFilters
          count={setInGrid}
          status={(
            <p className="filters-status" role="status" tabIndex={-1} ref={status}>
              {plural(results.length, 'measure')} {active ? `of ${bills.length} match these filters` : 'in this dataset'}
              {active ? <> <ClearFilters to={buildHash(['laws'])} focus={status} /></> : null}
            </p>
          )}
        >
          <div className="filters-grid">
            <SelectField label="Issue" value={filters.tag ?? ''} onChange={(tag) => set({ tag })}>
              <option value="">All issues</option>
              {tagOptions.map((o) => <option key={o.value} value={o.value}>{labels.get(o.value) ?? o.value} ({o.count})</option>)}
            </SelectField>
            {/* Written out rather than through SelectField, so the select can point at the deadline note below. */}
            <div className="field">
              <label htmlFor={statusId}>Status as reported</label>
              <select id={statusId} value={filters.status ?? ''} onChange={(event) => set({ status: event.target.value })} aria-describedby={deadlineHint ? deadlineId : undefined}>
                <option value="">Any status</option>
                {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
              </select>
            </div>
            <SelectField label="Measure type" value={filters.type ?? ''} onChange={(type) => set({ type })}>
              <option value="">All types</option>
              {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
            </SelectField>
            <SelectField label="Sort by" value={filters.sort ?? 'action'} onChange={(sort) => set({ sort: sort === 'action' ? '' : sort })}>
              <option value="action">Latest action</option>
              <option value="introduced">Date introduced</option>
              <option value="number">Bill number</option>
            </SelectField>
          </div>
          {/* Counted over the whole dataset, like the counts in the status menu, so it does not change with the filters. */}
          {deadlineHint ? (
            <p className="hint" id={deadlineId}>
              Status as reported: {plural(pastDeadline, 'Assembly or Senate bill', 'Assembly or Senate bills')} in this dataset still {pastDeadline === 1 ? 'shows' : 'show'} In Committee Process, Pending Referral or In Floor Process. {deadlineHint}
            </p>
          ) : null}
        </MoreFilters>
      </form>
      {results.length === 0 ? (
        <Empty title="No measure in this dataset matches these filters.">
          <GapNotice>Only California&rsquo;s current session is tracked, and only bills the selection rule matched.</GapNotice>
          <p><ClearFilters to={buildHash(['laws'])} focus={status} /></p>
        </Empty>
      ) : (
        <ul className="rows">{results.map((bill) => <BillRow key={bill.id} bill={bill} labels={labels} />)}</ul>
      )}
    </>
  );
}
