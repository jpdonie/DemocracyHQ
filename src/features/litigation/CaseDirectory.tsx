import { Fragment, useMemo, useRef } from 'react';
import type { LegalCaseSummary } from '../../types/schemas';
import { useCore, type AppealsCoverage } from '../../lib/core';
import { ALL_APPEALS, FEDERAL_CIRCUIT_ID, SCOTUS_ID, casesByCourt, courtHash, courtShortName, fixedFullName, groupDecidedTogether, isAppealsCourtId, type CourtDirectory } from '../../lib/courts';
import { caseStates, countBy, filterCases, knownCaseFilters, type CaseFilters } from '../../lib/filters';
import { caseNameClass, formatDate, plural } from '../../lib/format';
import { eventLabel, useTagLabels } from '../../lib/labels';
import { COMPACT_QUERY, useMediaQuery } from '../../lib/media';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { dataOf } from '../../lib/useLoad';
import { AboutLine } from '../../components/About';
import { A, Async, ClearFilters, Empty, GapNotice, MoreFilters, SelectField, TagList, TextField, TypeMark } from '../../components/ui';

export function caseFiltersFromQuery(query: Route['query']): CaseFilters {
  const sort = query.sort === 'docketed' || query.sort === 'name' ? query.sort : 'activity';
  return { q: query.q, tag: query.tag, state: query.state, court: query.court, ruling: query.ruling, from: query.from, to: query.to, sort };
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

/** "Supreme Court of the United States" in full, a court of appeals by the name it goes by: "Fifth Circuit". */
export function rowCourtName(courtId: string): string {
  return courtId === SCOTUS_ID ? fixedFullName(SCOTUS_ID)! : courtShortName(undefined, courtId);
}

/**
 * One case in a list. A Supreme Court docket is the Court's own docket. A court of appeals case is known here from the
 * documents GovInfo holds for it, which is not the court's docket, so its row speaks of documents and not of docket
 * activity.
 */
/**
 * Why a court of appeals case is listed, as far as a row can say it: the nature of suit in the court's record and the
 * election phrases the selection rule found most often in the opinion, each with its count.
 */
export function WhyListed({ record }: { record: LegalCaseSummary }) {
  const terms = record.matchedTerms ?? [];
  if (!record.natureOfSuit && terms.length === 0) return null;
  return (
    <p className="row-why">
      {record.natureOfSuit ? <>Nature of suit in the court’s record: <span className="row-why-value">{record.natureOfSuit}</span></> : null}
      {record.natureOfSuit && terms.length > 0 ? '. ' : null}
      {terms.length > 0 ? (
        <>
          In the opinion:{' '}
          {terms.map((item, i) => (
            <Fragment key={item.term}>
              {i > 0 ? ', ' : ''}
              <span className="term">“{item.term}”</span> <span className="term-count">{item.count}×</span>
            </Fragment>
          ))}
        </>
      ) : null}
    </p>
  );
}

export function CaseRow({ record, labels, note }: { record: LegalCaseSummary; labels: ReadonlyMap<string, string>; note?: string }) {
  const ruling = record.latestDispositiveEntry;
  const appeal = record.courtId !== SCOTUS_ID;
  return (
    <li className="row">
      <a className={`row-title ${caseNameClass(record.caseName)}`} href={buildHash(['litigation', record.id])}>{record.caseName}</a>
      <p className="row-meta">
        No. {record.docketNumber}, {rowCourtName(record.courtId)}
        {record.publication ? <>, <span className="row-kind">{record.publication.toLowerCase()} decision</span></> : null}
      </p>
      <AboutLine about={record.about} terms={(record.matchedTerms ?? []).map((item) => item.term)} />
      {note ? <p className="row-note">{note}</p> : null}
      {record.decidedWith.length > 0 ? (
        <p className="row-note">
          One opinion decides this case together with{' '}
          {record.decidedWith.map((other, i) => (
            <Fragment key={other.caseId}>
              {i === 0 ? '' : i === record.decidedWith.length - 1 ? ' and ' : ', '}
              <a href={buildHash(['litigation', other.caseId])}>No. {other.docket}</a>
              {other.caseName !== record.caseName ? <> (<span className="case-name">{other.caseName}</span>)</> : null}
            </Fragment>
          ))}.
        </p>
      ) : null}
      <TagList tags={record.issueTags} labels={labels} hrefFor={(tag) => buildHash(['litigation'], { tag })} />
      {appeal ? <WhyListed record={record} /> : null}
      {ruling ? (
        <p className="row-line">
          <span className="row-date">{formatDate(ruling.date)}</span> {eventLabel(ruling.eventType, ruling.ruleId)}: <q>{rulingExcerpt(ruling.text)}</q>
        </p>
      ) : (
        <p className="row-line quiet">{appeal ? 'No decision identified among the documents GovInfo holds for this case.' : 'No ruling entry identified on the docket.'}</p>
      )}
      <p className="row-foot">
        {appeal
          ? <>Documents on GovInfo through {formatDate(record.sourceLastActivity, 'an unreported date')}{record.origin ? `. Court below: ${record.origin.court}` : ''}</>
          : <>Docket activity through {formatDate(record.sourceLastActivity, 'an unreported date')}</>}
      </p>
    </li>
  );
}

/**
 * The rows of a list of cases. Appeals that a court decided in one opinion are each a case of their own; in a list they
 * share a row, under the first of them, so the same opinion is not repeated (rule same-opinion-1).
 */
export function CaseRows({ cases, labels, noteOf }: { cases: readonly LegalCaseSummary[]; labels: ReadonlyMap<string, string>; noteOf?: (record: LegalCaseSummary) => string | undefined }) {
  return (
    <ul className="rows">
      {groupDecidedTogether(cases).map(({ record }) => <CaseRow key={record.id} record={record} labels={labels} note={noteOf?.(record)} />)}
    </ul>
  );
}

/** How many rows a list of cases takes once the cases decided in one opinion share a row. */
export function decisionRows(cases: readonly LegalCaseSummary[]): number {
  return groupDecidedTogether(cases).length;
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
        <p className="lede">Election cases in the Supreme Court and the federal courts of appeals, read from each court&rsquo;s official record and linked to the documents it publishes.</p>
      </header>
      <Async of={core.cases} what="court cases">
        {(cases) => (
          <Directory
            cases={cases} filters={filters} set={set} labels={labels}
            // The list does not wait for the files about the courts of appeals: until they load, the notes that need them are left out.
            appeals={dataOf(core.appeals)} courts={dataOf(core.courts)}
            geoName={(fips) => (geo ? geo.stateName(fips) : fips)}
            isState={geo ? (fips) => Boolean(geo.state(fips)) : undefined}
          />
        )}
      </Async>
    </article>
  );
}

/** The label of a ruling type in the menu. A type both kinds of court use ("decision") carries both of its labels. */
function rulingLabel(eventType: string, cases: readonly LegalCaseSummary[]): string {
  const labels = new Set<string>();
  for (const record of cases) {
    const entry = record.latestDispositiveEntry;
    if (entry?.eventType === eventType) labels.add(eventLabel(eventType, entry.ruleId));
  }
  return labels.size > 0 ? [...labels].join(' / ') : eventLabel(eventType);
}

/** Why a court's list is empty, for the two courts of appeals that have no case in the dataset. */
function emptyCourtNote(courtId: string, appeals: AppealsCoverage | null): string | null {
  if (!appeals) return null;
  const read = appeals.coverage[courtId];
  if (!read || read.selected > 0) return null;
  const name = courtShortName(undefined, courtId);
  const read_ = `For the ${name}, ${plural(read.cases, 'case')} with a document issued since ${formatDate(appeals.selection.since)} were read.`;
  if (read.excluded === 0) return `${read_} The selection rule picked none of them.`;
  const them = read.excluded === 1 ? 'it' : 'them';
  return `${read_} The selection rule picked ${plural(read.excluded, 'case')}, and a maintainer removed ${them}: the court's page gives the reason and the passage of the opinion.`;
}

function Directory({ cases, filters: requested, set, labels, appeals, courts, geoName, isState }: {
  cases: LegalCaseSummary[]; filters: CaseFilters; set: (patch: Record<string, string>) => void;
  labels: ReadonlyMap<string, string>; appeals: AppealsCoverage | null; courts: CourtDirectory | null;
  geoName: (fips: string) => string; isState?: (fips: string) => boolean;
}) {
  // A value in the address that is not one of the menu's choices (a mistyped or outdated link) is not applied,
  // so the list and the menus always show the same filters. A state from the map's index is a choice even when no case
  // is listed under it (selecting it on the map gives an empty list), and the state menu then shows it with a count of 0.
  const filters = knownCaseFilters(requested, cases, isState);
  const active = Boolean(filters.q || filters.tag || filters.state || filters.court || filters.ruling || filters.from || filters.to);
  const results = useMemo(() => filterCases(cases, filters), [cases, filters.q, filters.tag, filters.state, filters.court, filters.ruling, filters.from, filters.to, filters.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagOptions = useMemo(() => countBy(cases, (c) => c.issueTags.map((t) => t.tag)), [cases]);
  const stateOptions = useMemo(() => {
    const options = countBy(cases, caseStates);
    if (filters.state && !options.some((o) => o.value === filters.state)) options.push({ value: filters.state, count: 0 });
    return options.sort((a, b) => geoName(a.value).localeCompare(geoName(b.value)));
  }, [cases, geoName, filters.state]);
  const rulingOptions = useMemo(() => countBy(cases, (c) => [c.latestDispositiveEntry?.eventType ?? 'none']), [cases]);
  const perCourt = useMemo(() => casesByCourt(cases), [cases]);
  const supreme = perCourt.get(SCOTUS_ID) ?? 0;
  const inAppeals = cases.length - supreme;
  // The thirteen courts of appeals in the statute's order once the list of courts has loaded; until then, those that have cases.
  const appealsCourts = courts ? courts.appeals.map((court) => court.id) : [...perCourt.keys()].filter(isAppealsCourtId).sort();
  const status = useRef<HTMLParagraphElement | null>(null);
  // On a phone the directory opens over the map, so the hint names the filter first.
  const compact = useMediaQuery(COMPACT_QUERY);
  const setInGrid = [filters.tag, filters.state, filters.court, filters.ruling, filters.from, filters.to].filter(Boolean).length;
  const rows = decisionRows(results);
  const emptyCourt = results.length === 0 && filters.court && isAppealsCourtId(filters.court) ? emptyCourtNote(filters.court, appeals) : null;
  return (
    <>
      <p className="coverage-note">
        Covers {plural(supreme, 'docket')} of the Supreme Court of the United States, chosen by maintainers, and {plural(inAppeals, 'case')} of the federal courts of appeals
        {appeals ? <>, selected by a published rule from the {appeals.selection.totalCasesRead.toLocaleString('en-US')} cases with a document issued since {formatDate(appeals.selection.since)} that GovInfo lists (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {appeals.selection.ruleId}</A>)</> : null}.
        It is not a complete list of election cases. Federal district courts and state courts are not covered. <A to={buildHash(['courts'])}>The courts and what was read for each</A>
      </p>
      <form className="filters" role="search" aria-label="Filter court cases" onSubmit={(event) => event.preventDefault()}>
        <TextField label="Search case name, docket number or quoted passage" value={filters.q ?? ''} onChange={(q) => set({ q })} placeholder="e.g. Callais, 24-109 or mail-in ballots" />
        <MoreFilters
          count={setInGrid}
          status={(
            <p className="filters-status" role="status" tabIndex={-1} ref={status}>
              {plural(results.length, 'case')} {active ? `of ${cases.length} match these filters` : 'in this dataset'}
              {rows < results.length ? <span className="quiet">, in {plural(rows, 'row')}: appeals decided in one opinion share a row</span> : null}
              {active ? <> <ClearFilters to={buildHash(['litigation'])} focus={status} /></> : null}
            </p>
          )}
        >
          <div className="filters-grid">
            <SelectField label="Court" value={filters.court ?? ''} onChange={(court) => set({ court })}>
              <option value="">All courts</option>
              <option value={SCOTUS_ID}>Supreme Court ({supreme})</option>
              <option value={ALL_APPEALS}>All courts of appeals ({inAppeals})</option>
              {appealsCourts.map((id) => <option key={id} value={id}>{courtShortName(courts?.get(id), id)} ({perCourt.get(id) ?? 0})</option>)}
            </SelectField>
            <SelectField label="Issue" value={filters.tag ?? ''} onChange={(tag) => set({ tag })}>
              <option value="">All issues</option>
              {tagOptions.map((o) => <option key={o.value} value={o.value}>{labels.get(o.value) ?? o.value} ({o.count})</option>)}
            </SelectField>
            <SelectField label="State" value={filters.state ?? ''} onChange={(state) => set({ state })}>
              <option value="">All states</option>
              {stateOptions.map((o) => <option key={o.value} value={o.value}>{geoName(o.value)} ({o.count})</option>)}
            </SelectField>
            <SelectField label="Latest ruling" value={filters.ruling ?? ''} onChange={(ruling) => set({ ruling })}>
              <option value="">Any</option>
              {rulingOptions.map((o) => <option key={o.value} value={o.value}>{o.value === 'none' ? 'None identified' : rulingLabel(o.value, cases)} ({o.count})</option>)}
            </SelectField>
            <SelectField label="Sort by" value={filters.sort ?? 'activity'} onChange={(sort) => set({ sort: sort === 'activity' ? '' : sort })}>
              <option value="activity">Latest activity</option>
              <option value="docketed">Date docketed or first document</option>
              <option value="name">Case name</option>
            </SelectField>
            <TextField type="date" label="Latest activity from" value={filters.from ?? ''} onChange={(from) => set({ from })} />
            <TextField type="date" label="Latest activity to" value={filters.to ?? ''} onChange={(to) => set({ to })} />
          </div>
        </MoreFilters>
      </form>
      {results.length === 0 ? (
        <Empty title="No case in this dataset matches these filters.">
          {emptyCourt ? <p>{emptyCourt} <A to={courtHash(filters.court!)}>What was read for this court</A></p> : null}
          <GapNotice>DemocracyHQ holds a hand-picked set of Supreme Court dockets and the court of appeals cases a keyword rule finds. A case that is missing here may well exist.</GapNotice>
          <p><ClearFilters to={buildHash(['litigation'])} focus={status} /></p>
        </Empty>
      ) : (
        <CaseRows cases={results} labels={labels} />
      )}
      <p className="hint">
        {compact
          ? 'To list the cases of one state, choose it under “State” in More filters, or use “Show more map” and select it on the map.'
          : 'Select a state on the map to list the cases of that state.'}
        {' '}A state&rsquo;s list holds the Supreme Court dockets whose record supports a link to the state and the appeals that began in a federal district court there. Where an appeal began does not say what it concerns.
        {filters.court === FEDERAL_CIRCUIT_ID ? ' The Federal Circuit takes cases by subject from every district, so it has no area on the map.' : ''}
      </p>
    </>
  );
}
