import { useMemo, useRef } from 'react';
import type { LegalCaseSummary } from '../../types/schemas';
import { useCore } from '../../lib/core';
import { countBy, filterCases, knownCaseFilters, type CaseFilters } from '../../lib/filters';
import { formatDate, plural } from '../../lib/format';
import { eventLabel, useTagLabels } from '../../lib/labels';
import { COMPACT_QUERY, useMediaQuery } from '../../lib/media';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { Async, ClearFilters, Empty, GapNotice, MoreFilters, SelectField, TagList, TextField, TypeMark } from '../../components/ui';

export function caseFiltersFromQuery(query: Route['query']): CaseFilters {
  const sort = query.sort === 'docketed' || query.sort === 'name' ? query.sort : 'activity';
  return { q: query.q, tag: query.tag, state: query.state, ruling: query.ruling, from: query.from, to: query.to, sort };
}

/** Words that state what a ruling does: the operative part of an order or judgment. */
const OPERATIVE = /\b(granted|denied|dismissed|affirmed|reversed|vacated|remanded|stayed)\b/i;

/**
 * A ruling's docket text, shortened for a list row so that its operative words stay visible. Text that fits is shown
 * whole. When the first operative word ("granted", "denied", "REVERSED" ...) falls within the first `max` characters, the
 * text is cut at the end; otherwise the sentence that holds it is shown, with the omitted text before and after marked
 * by an ellipsis. Nothing is reworded: every word shown is the docket's own.
 */
export function rulingExcerpt(text: string, max = 190): string {
  if (text.length <= max) return text;
  const cut = (value: string) => `${value.slice(0, max).trimEnd()}…`;
  const match = OPERATIVE.exec(text);
  if (!match || match.index + match[0].length <= max) return cut(text);
  // The sentence around the operative word: from just after the previous full stop to the next one.
  const before = text.slice(0, match.index);
  const start = Math.max(before.lastIndexOf('. ') + 2, 0);
  const stop = text.indexOf('. ', match.index);
  const end = stop < 0 ? text.length : stop + 1;
  let sentence = text.slice(start, end).trim();
  let lead = start > 0 ? '… ' : '';
  // A very long sentence keeps its end, where the operative words are, up to a word boundary.
  const room = max + 60;
  if (sentence.length > room) {
    const keepFrom = sentence.length - room;
    const space = sentence.indexOf(' ', keepFrom);
    sentence = sentence.slice(space < 0 ? keepFrom : space + 1);
    lead = '… ';
  }
  return `${lead}${sentence}${end < text.length ? ' …' : ''}`;
}

export function CaseRow({ record, labels, note }: { record: LegalCaseSummary; labels: ReadonlyMap<string, string>; note?: string }) {
  const ruling = record.latestDispositiveEntry;
  return (
    <li className="row">
      <a className="row-title case-name" href={buildHash(['litigation', record.id])}>{record.caseName}</a>
      <p className="row-meta">No. {record.docketNumber}, Supreme Court of the United States</p>
      {note ? <p className="row-note">{note}</p> : null}
      {ruling ? (
        <p className="row-line">
          <span className="row-date">{formatDate(ruling.date)}</span> {eventLabel(ruling.eventType)}: <q>{rulingExcerpt(ruling.text)}</q>
        </p>
      ) : (
        <p className="row-line quiet">No ruling entry identified on the docket.</p>
      )}
      <p className="row-foot">Docket activity through {formatDate(record.sourceLastActivity, 'an unreported date')}</p>
      <TagList tags={record.issueTags} labels={labels} hrefFor={(tag) => buildHash(['litigation'], { tag })} />
    </li>
  );
}

export function CaseDirectory({ route }: { route: Route }) {
  const core = useCore();
  const labels = useTagLabels();
  const filters = caseFiltersFromQuery(route.query);
  const set = (patch: Record<string, string>) => patchQuery(route, patch);
  const geo = dataOf(core.geo);

  return (
    <article className="view">
      <header className="view-head">
        <TypeMark type="case" label="Litigation" />
        <h1 tabIndex={-1}>Election litigation</h1>
        <p className="lede">Supreme Court dockets in election-law matters, read from the Court&rsquo;s own docket pages and linked to the filings the Court publishes.</p>
      </header>
      <Async of={core.cases} what="court cases">
        {(cases) => (
          <Directory
            cases={cases} filters={filters} set={set} labels={labels}
            geoName={(fips) => (geo ? geo.stateName(fips) : fips)}
            isState={geo ? (fips) => Boolean(geo.state(fips)) : undefined}
          />
        )}
      </Async>
    </article>
  );
}

function Directory({ cases, filters: requested, set, labels, geoName, isState }: {
  cases: LegalCaseSummary[]; filters: CaseFilters; set: (patch: Record<string, string>) => void;
  labels: ReadonlyMap<string, string>; geoName: (fips: string) => string; isState?: (fips: string) => boolean;
}) {
  // A value in the address that is not one of the menu's choices (a mistyped or outdated link) is not applied,
  // so the list and the menus always show the same filters. A state from the map's index is a choice even when no case
  // links to it (selecting it on the map gives an empty list), and the state menu then shows it with a count of 0.
  const filters = knownCaseFilters(requested, cases, isState);
  const active = Boolean(filters.q || filters.tag || filters.state || filters.ruling || filters.from || filters.to);
  const results = useMemo(() => filterCases(cases, filters), [cases, filters.q, filters.tag, filters.state, filters.ruling, filters.from, filters.to, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => countBy(cases, (c) => c.issueTags.map((t) => t.tag)), [cases]);
  const stateOptions = useMemo(() => {
    const options = countBy(cases, (c) => c.stateFips);
    if (filters.state && !options.some((o) => o.value === filters.state)) options.push({ value: filters.state, count: 0 });
    return options.sort((a, b) => geoName(a.value).localeCompare(geoName(b.value)));
  }, [cases, geoName, filters.state]);
  const rulingOptions = useMemo(() => countBy(cases, (c) => [c.latestDispositiveEntry?.eventType ?? 'none']), [cases]);
  const status = useRef<HTMLParagraphElement | null>(null);
  // On a phone the directory opens over the map, so the hint names the filter first.
  const compact = useMediaQuery(COMPACT_QUERY);
  const setInGrid = [filters.tag, filters.state, filters.ruling, filters.from, filters.to].filter(Boolean).length;
  return (
    <>
      <p className="coverage-note">
        Covers {plural(cases.length, 'docket')} of the Supreme Court of the United States chosen by maintainers. It is not a complete list of the Court&rsquo;s election cases, and lower federal courts and state courts are not covered yet.
      </p>
      <form className="filters" role="search" aria-label="Filter court cases" onSubmit={(event) => event.preventDefault()}>
        <TextField label="Search case name or docket number" value={filters.q ?? ''} onChange={(q) => set({ q })} placeholder="e.g. Callais or 24-109" />
        <MoreFilters
          count={setInGrid}
          status={(
            <p className="filters-status" role="status" tabIndex={-1} ref={status}>
              {plural(results.length, 'docket')} {active ? `of ${cases.length} match these filters` : 'in this dataset'}
              {active ? <> <ClearFilters to={buildHash(['litigation'])} focus={status} /></> : null}
            </p>
          )}
        >
          <div className="filters-grid">
            <SelectField label="Issue" value={filters.tag ?? ''} onChange={(tag) => set({ tag })}>
              <option value="">All issues</option>
              {tagOptions.map((o) => <option key={o.value} value={o.value}>{labels.get(o.value) ?? o.value} ({o.count})</option>)}
            </SelectField>
            <SelectField label="State the record links to" value={filters.state ?? ''} onChange={(state) => set({ state })}>
              <option value="">All states</option>
              {stateOptions.map((o) => <option key={o.value} value={o.value}>{geoName(o.value)} ({o.count})</option>)}
            </SelectField>
            <SelectField label="Latest ruling entry" value={filters.ruling ?? ''} onChange={(ruling) => set({ ruling })}>
              <option value="">Any</option>
              {rulingOptions.map((o) => <option key={o.value} value={o.value}>{o.value === 'none' ? 'None identified' : eventLabel(o.value)} ({o.count})</option>)}
            </SelectField>
            <SelectField label="Sort by" value={filters.sort ?? 'activity'} onChange={(sort) => set({ sort: sort === 'activity' ? '' : sort })}>
              <option value="activity">Latest docket activity</option>
              <option value="docketed">Date docketed</option>
              <option value="name">Case name</option>
            </SelectField>
            <TextField type="date" label="Docket activity from" value={filters.from ?? ''} onChange={(from) => set({ from })} />
            <TextField type="date" label="Docket activity to" value={filters.to ?? ''} onChange={(to) => set({ to })} />
          </div>
        </MoreFilters>
      </form>
      {results.length === 0 ? (
        <Empty title="No case in this dataset matches these filters.">
          <GapNotice>DemocracyHQ tracks a small, hand-picked set of Supreme Court dockets. A case that is missing here may well exist.</GapNotice>
          <p><ClearFilters to={buildHash(['litigation'])} focus={status} /></p>
        </Empty>
      ) : (
        <ul className="rows">
          {results.map((record) => <CaseRow key={record.id} record={record} labels={labels} />)}
        </ul>
      )}
      <p className="hint">
        {compact
          ? 'To list only the cases whose record supports a link to a state, choose the state under “State the record links to” in More filters, or use “Show more map” and select it on the map.'
          : 'Select a state on the map to filter this list to cases whose record supports a link to that state.'}
      </p>
    </>
  );
}
