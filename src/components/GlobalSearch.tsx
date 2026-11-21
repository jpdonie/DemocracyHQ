/** Global search: a combobox over places, cases and bills. Results are deterministic prefix matches; close spellings are offered only when nothing matches. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCore } from '../lib/core';
import { NARROW_QUERY, useMediaQuery } from '../lib/media';
import { navigate } from '../lib/router';
import { buildSearchIndex, FUZZY_MAX_WORDS, searchWithSuggestions, type SearchEntry } from '../lib/search';
import { dataOf } from '../lib/useLoad';
import { Icon } from './ui';

/** How long typing must pause before the results for a long query are worked out again, so a paste is searched once. */
export const SEARCH_DELAY_MS = 120;
/** A query this short is searched at once, as it is typed: it costs a few milliseconds. */
export const IMMEDIATE_MAX_LENGTH = 40;

/** Whether a query is short enough to search on every key, without waiting for typing to pause. */
export function searchesAtOnce(query: string): boolean {
  return query.length <= IMMEDIATE_MAX_LENGTH && query.trim().split(/\s+/).length <= FUZZY_MAX_WORDS;
}

function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function GlobalSearch() {
  const core = useCore();
  const geo = dataOf(core.geo);
  const cases = dataOf(core.cases);
  const bills = dataOf(core.bills);
  const index = useMemo(() => buildSearchIndex(geo, cases ?? [], bills?.bills ?? []), [geo, cases, bills]);
  const [query, setQuery] = useState('');
  // A long query (a paste) is searched once typing pauses; until then the results stay those of the query searched last.
  const [settled, setSettled] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const atOnce = searchesAtOnce(query);
  useEffect(() => {
    if (query === settled) return undefined;
    // A short query is already searched (see `searched`); it is kept so that a paste after it shows these results meanwhile.
    if (atOnce) {
      setSettled(query);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(query), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, settled, atOnce]);
  // The query the results are for.
  const searched = atOnce ? query : settled;
  const { groups, approximate } = useMemo(() => searchWithSuggestions(index, searched), [index, searched]);
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // On a phone the box beside the More button has room for one word; the field's name still says what it searches.
  const narrow = useMediaQuery(NARROW_QUERY);

  useEffect(() => setActive(0), [searched]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = (entry: SearchEntry) => {
    setOpen(false);
    setQuery('');
    setSettled('');
    inputRef.current?.blur();
    navigate(entry.hash);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (event.key === 'Enter') {
      // Enter pressed before the results caught up with the typing: search the typed text now and take its first result.
      const entry = searched === query ? flat[active] : searchWithSuggestions(index, query).groups.flatMap((g) => g.entries)[0];
      if (open && entry) {
        event.preventDefault();
        go(entry);
      }
    } else if (event.key === 'Escape') {
      if (open) setOpen(false);
      else setQuery('');
    }
  };

  const showList = open && query.trim().length >= 2 && searched.trim().length >= 2;
  // Places, cases and bills come from three files. Results are shown from those that have loaded, and the list says
  // which are still loading or failed, so a missing result is never presented as "nothing matches".
  const parts = [['places', core.geo], ['court cases', core.cases], ['bills', core.bills]] as const;
  const loadingParts = parts.filter(([, part]) => part.status === 'loading').map(([name]) => name);
  const failedParts = parts.filter(([, part]) => part.status === 'error').map(([name]) => name);
  const complete = loadingParts.length === 0 && failedParts.length === 0;
  const ready = loadingParts.length < parts.length;
  return (
    <div className="search" ref={wrapRef}>
      <label className="sr-only" htmlFor={`${listId}-input`}>Search places, cases and bills</label>
      <Icon name="search" size={15} />
      <input
        id={`${listId}-input`}
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList && flat[active] ? `${listId}-opt-${active}` : undefined}
        placeholder={narrow ? 'Search' : 'Search a place, case or bill'}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <div id={`${listId}-list`} role="listbox" aria-label="Search results" className="search-results" hidden={!showList}>
        {showList && loadingParts.length > 0 ? <p className="search-empty">Still loading: {listOf(loadingParts)}. Results for them will appear when they are ready.</p> : null}
        {showList && failedParts.length > 0 ? (
          <p className="search-empty search-error">The index of {listOf(failedParts)} could not be loaded, so {failedParts.length === 1 ? 'it is' : 'they are'} not searched. Reload the page to try again.</p>
        ) : null}
        {showList && ready && flat.length === 0 ? (
          complete
            ? <p className="search-empty">Nothing in this dataset matches &ldquo;{searched.trim()}&rdquo;. Coverage is limited; a missing record may still exist.</p>
            : <p className="search-empty">Nothing in the records loaded so far matches &ldquo;{searched.trim()}&rdquo;.</p>
        ) : null}
        {showList && ready && approximate ? (
          <p className="search-empty search-suggest">Nothing in this dataset matches &ldquo;{searched.trim()}&rdquo; exactly. <strong>Did you mean:</strong></p>
        ) : null}
        {showList ? groups.map((group) => (
          <div key={group.kind} role="group" aria-label={approximate ? `Did you mean: ${group.title.toLowerCase()}` : group.title} className={`search-group search-${group.kind}`}>
            <p className="search-group-title" aria-hidden="true">{group.title}{group.total > group.entries.length ? `, first ${group.entries.length} of ${group.total}` : ''}</p>
            {group.entries.map((entry) => {
              const position = flat.indexOf(entry);
              return (
                <div
                  key={`${entry.kind}:${entry.id}`}
                  id={`${listId}-opt-${position}`}
                  role="option"
                  aria-selected={position === active}
                  className={`search-option${position === active ? ' is-active' : ''}`}
                  onPointerEnter={() => setActive(position)}
                  onClick={() => go(entry)}
                >
                  <span className={entry.kind === 'case' ? 'case-name' : undefined}>{entry.label}</span>
                  <span className="search-detail">{entry.detail}</span>
                </div>
              );
            })}
          </div>
        )) : null}
      </div>
      <span className="sr-only" role="status">
        {showList && ready ? (approximate ? `No exact match. ${flat.length} close spelling${flat.length === 1 ? '' : 's'} suggested` : `${flat.length} result${flat.length === 1 ? '' : 's'} shown`) : ''}
        {showList && failedParts.length > 0 ? `; ${listOf(failedParts)} could not be loaded` : ''}
      </span>
    </div>
  );
}
