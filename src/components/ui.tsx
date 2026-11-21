/** Shared interface pieces. Every record view is assembled from these so provenance looks the same everywhere. */
import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import type { IssueTag, Verification, VerificationStatus } from '../types/schemas';
import type { DataError } from '../lib/data';
import type { Loadable } from '../lib/useLoad';
import { formatDate, formatDateTime } from '../lib/format';
import { COMPACT_QUERY, useMediaQuery } from '../lib/media';
import { LINK_CHECK_SCOPE, METHOD_LABELS, RECORD_CHECK_SCOPE, VERIFICATION_LABELS } from '../lib/verification';
import { buildHash, navigate, shareUrl } from '../lib/router';
import { toggleWatch, isWatched, useWatchlist, storageAvailable, type WatchItem } from '../lib/watchlist';
import { downloadText, packFileName, packToCsv, type SourcePack } from '../lib/export';
import { correctionUrl } from '../config';

/* ---------- icons (decorative; always paired with text) ---------- */

const ICONS: Record<string, string> = {
  verified_primary: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm3.2 4.9-3.7 4.3a.75.75 0 0 1-1.1.04L4.7 9a.75.75 0 1 1 1.06-1.06l1.13 1.13 3.17-3.68a.75.75 0 0 1 1.14.98Z',
  imported_secondary: 'M5.3 2.2a.75.75 0 0 1 0 1.06L3.8 4.75h8.45a.75.75 0 0 1 0 1.5H3.8l1.5 1.5A.75.75 0 0 1 4.24 8.8L1.47 6.03a.75.75 0 0 1 0-1.06L4.24 2.2a.75.75 0 0 1 1.06 0Zm5.4 5a.75.75 0 0 1 1.06 0l2.77 2.77a.75.75 0 0 1 0 1.06l-2.77 2.77a.75.75 0 1 1-1.06-1.06l1.5-1.49H3.75a.75.75 0 0 1 0-1.5h8.45l-1.5-1.5a.75.75 0 0 1 0-1.05Z',
  awaiting_review: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8.75 4.5v3.2l2.1 1.4a.75.75 0 1 1-.83 1.25L7.58 8.72a.75.75 0 0 1-.33-.62V4.5a.75.75 0 0 1 1.5 0Z',
  disputed: 'M3.5 1.75a.75.75 0 0 0-1.5 0v12.5a.75.75 0 0 0 1.5 0V10h3.1l.6 1.2c.13.26.39.42.67.42h4.38c.41 0 .75-.34.75-.75V4.12a.75.75 0 0 0-.75-.75H9.1l-.6-1.2a.75.75 0 0 0-.67-.42H3.5Z',
  outdated: 'M2 3.25A1.25 1.25 0 0 1 3.25 2h9.5A1.25 1.25 0 0 1 14 3.25v1.5c0 .5-.3.94-.72 1.14v6.36c0 .97-.78 1.75-1.75 1.75H4.47c-.97 0-1.75-.78-1.75-1.75V5.89A1.25 1.25 0 0 1 2 4.75v-1.5Zm4.5 4.5a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z',
  unavailable: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5 7.25h6a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Z',
  external: 'M9.25 2a.75.75 0 0 0 0 1.5h2.19L7.22 7.72a.75.75 0 1 0 1.06 1.06l4.22-4.22v2.19a.75.75 0 0 0 1.5 0v-4A.75.75 0 0 0 13.25 2h-4ZM3.75 4A1.75 1.75 0 0 0 2 5.75v6.5c0 .97.78 1.75 1.75 1.75h6.5A1.75 1.75 0 0 0 12 12.25V9.5a.75.75 0 0 0-1.5 0v2.75c0 .14-.11.25-.25.25h-6.5a.25.25 0 0 1-.25-.25v-6.5c0-.14.11-.25.25-.25H6.5a.75.75 0 0 0 0-1.5H3.75Z',
  star: 'M8 1.6c.3 0 .57.17.7.44l1.6 3.3 3.6.5c.64.1.9.88.43 1.33l-2.6 2.56.62 3.62c.1.63-.56 1.12-1.13.82L8 12.46l-3.22 1.71c-.57.3-1.24-.19-1.13-.82l.62-3.62-2.6-2.56a.78.78 0 0 1 .43-1.33l3.6-.5 1.6-3.3c.13-.27.4-.44.7-.44Z',
  link: 'M9.1 3.4a2.5 2.5 0 0 1 3.5 3.5l-1.7 1.7a2.5 2.5 0 0 1-3.5 0 .75.75 0 0 1 1.06-1.06 1 1 0 0 0 1.4 0l1.7-1.7a1 1 0 0 0-1.4-1.4l-.5.5A.75.75 0 0 1 8.6 3.9l.5-.5ZM5.1 7.4a2.5 2.5 0 0 1 3.5 0 .75.75 0 0 1-1.06 1.06 1 1 0 0 0-1.4 0l-1.7 1.7a1 1 0 0 0 1.4 1.4l.5-.5a.75.75 0 0 1 1.06 1.06l-.5.5a2.5 2.5 0 0 1-3.5-3.5l1.7-1.7Z',
  download: 'M8.75 2a.75.75 0 0 0-1.5 0v6.19L5.03 5.97a.75.75 0 0 0-1.06 1.06l3.5 3.5c.3.3.77.3 1.06 0l3.5-3.5a.75.75 0 1 0-1.06-1.06L8.75 8.19V2ZM2.75 12.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z',
  search: 'M7 2a5 5 0 1 0 3.1 8.93l2.99 2.98a.75.75 0 1 0 1.06-1.06l-2.98-2.99A5 5 0 0 0 7 2ZM3.5 7a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z',
  back: 'M9.78 3.22a.75.75 0 0 1 0 1.06L6.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z',
  up: 'M3.22 9.78a.75.75 0 0 0 1.06 0L8 6.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L8.53 4.47a.75.75 0 0 0-1.06 0L3.22 8.72a.75.75 0 0 0 0 1.06Z',
  down: 'M3.22 6.22a.75.75 0 0 1 1.06 0L8 9.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 0-1.06Z',
  warn: 'M8.87 1.9a1 1 0 0 0-1.74 0L1.4 12a1 1 0 0 0 .87 1.5h11.46a1 1 0 0 0 .87-1.5L8.87 1.9ZM8 5.5c.41 0 .75.34.75.75v2.5a.75.75 0 0 1-1.5 0v-2.5c0-.41.34-.75.75-.75Zm0 6.25a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z',
};

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICONS[name] ?? ''} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

/* ---------- links ---------- */

export function A({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return <a href={to} className={className} aria-current={current ? 'page' : undefined}>{children}</a>;
}

/** Link to an outside source. Opens in the same tab so Back returns to the record. */
export function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={`ext ${className ?? ''}`.trim()} rel="noopener noreferrer external">
      {children}
      <Icon name="external" size={12} />
      <span className="sr-only"> (external site)</span>
    </a>
  );
}

/* ---------- states ---------- */

export function Loading({ what }: { what: string }) {
  return <p className="state state-loading" role="status">Loading {what}</p>;
}

export function ErrorNote({ error, what }: { error: DataError; what: string }) {
  const hint =
    error.kind === 'network' ? 'Check the connection and reload the page.'
    : error.kind === 'not_found' ? 'It may have been removed or the link may be mistyped.'
    : 'The file did not pass validation, so it is withheld rather than shown partly.';
  return (
    <div className="state state-error" role="alert">
      <p><strong>Could not load {what}.</strong> {hint}</p>
      <p className="quiet">{error.message}</p>
    </div>
  );
}

/**
 * The heading of a view whose record could not be loaded ("Court case not found", "Court case could not be loaded"),
 * so the view still has a heading and keyboard focus a place to land after a move.
 */
export function ErrorHeading({ error, noun }: { error: DataError; noun: string }) {
  return (
    <header className="view-head">
      <h1 tabIndex={-1}>{error.kind === 'not_found' ? `${noun} not found` : `${noun} could not be loaded`}</h1>
    </header>
  );
}

/**
 * Loading, error or the data. `heading` is for a view's own record: on an error the view then gets a heading
 * (see ErrorHeading) above the error note.
 */
export function Async<T>({ of, what, heading, children }: { of: Loadable<T>; what: string; heading?: string; children: (data: T) => ReactNode }) {
  if (of.status === 'loading') return <Loading what={what} />;
  if (of.status === 'error') {
    return heading ? <><ErrorHeading error={of.error} noun={heading} /><ErrorNote error={of.error} what={what} /></> : <ErrorNote error={of.error} what={what} />;
  }
  return <>{children(of.data)}</>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p><strong>{title}</strong></p>
      {children}
    </div>
  );
}

/** The standing reminder that missing data is a gap in this dataset, not a finding. */
export function GapNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="gap-notice">
      <strong>A data gap is not evidence of absence.</strong>{children ? <> {children}</> : null}
    </p>
  );
}

/* ---------- provenance ---------- */

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <Icon name={status} />
      {VERIFICATION_LABELS[status]}
    </span>
  );
}

/**
 * The badge of a link between records, with what its check covers: the quoted passage, not the maintainer's
 * description of the link.
 */
export function LinkVerification({ verification }: { verification: Verification }) {
  return (
    <p className="link-foot">
      <VerificationBadge status={verification.status} />{' '}
      <span className="quiet">{LINK_CHECK_SCOPE}</span>
    </p>
  );
}

export interface SourceLineProps {
  sourceName: string;
  sourceUrl: string;
  verification: Verification;
  lastCheckedAt: string;
  /** Latest activity the source itself reports for this record, if it reports one. */
  sourceActivity?: { label: string; date: string | null | undefined };
  stale?: boolean;
  correctionSubject: string;
  children?: ReactNode;
}

export function SourceLine(props: SourceLineProps) {
  const issue = correctionUrl(props.correctionSubject, typeof window === 'undefined' ? '' : window.location.href);
  return (
    <aside className="source-line" aria-label="Source and verification">
      <p className="source-line-head">
        <VerificationBadge status={props.verification.status} />
        {props.stale ? <span className="badge badge-stale"><Icon name="warn" />Stale</span> : null}
      </p>
      {props.verification.status === 'verified_primary' ? <p className="quiet">{RECORD_CHECK_SCOPE}</p> : null}
      <dl className="facts facts-tight">
        <div><dt>Source</dt><dd><Ext href={props.sourceUrl}>{props.sourceName}</Ext></dd></div>
        {props.sourceActivity ? <div><dt>{props.sourceActivity.label}</dt><dd>{formatDate(props.sourceActivity.date, 'Not reported by the source')}</dd></div> : null}
        <div><dt>Last checked by DemocracyHQ</dt><dd>{formatDateTime(props.lastCheckedAt)}</dd></div>
        <div><dt>How it was checked</dt><dd>{METHOD_LABELS[props.verification.method] ?? props.verification.method}{props.verification.note ? `. ${props.verification.note}` : ''}</dd></div>
      </dl>
      {props.children}
      <p className="source-line-foot">
        <A to={buildHash(['sources'], { section: 'verification' })}>What the verification states mean</A>
        {issue ? <Ext href={issue}>Report a correction</Ext> : <A to={buildHash(['about'], { section: 'corrections' })}>Report a correction</A>}
      </p>
    </aside>
  );
}

const TYPE_LABELS = { case: 'Court case', bill: 'Legislation', place: 'Place', data: 'Data' } as const;

export function TypeMark({ type, label }: { type: keyof typeof TYPE_LABELS; label?: string }) {
  return <span className={`type-mark type-${type}`}>{label ?? TYPE_LABELS[type]}</span>;
}

export function TagList({ tags, labels, hrefFor }: { tags: readonly IssueTag[]; labels: ReadonlyMap<string, string>; hrefFor?: (tag: string) => string }) {
  if (tags.length === 0) return null;
  return (
    <ul className="tags" aria-label="Issue tags">
      {tags.map((tag) => {
        const label = labels.get(tag.tag) ?? tag.tag.replace(/-/g, ' ');
        return <li key={tag.tag}>{hrefFor ? <a className="tag" href={hrefFor(tag.tag)}>{label}</a> : <span className="tag">{label}</span>}</li>;
      })}
    </ul>
  );
}

/* ---------- layout ---------- */

export function Section({ title, children, id, note }: { title: string; children: ReactNode; id?: string; note?: ReactNode }) {
  const generated = useId();
  const headingId = id ? `${id}-h` : generated;
  return (
    <section className="section" id={id} aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {note ? <p className="section-note">{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * A table that may be wider than a narrow screen, or than the panel at a large text size. Only the table scrolls
 * sideways, not the panel around it. While it does scroll it is a named region that takes keyboard focus,
 * so it can be scrolled without a pointer.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const check = () => setScrolls(box.scrollWidth > box.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    check();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="table-scroll" ref={ref} role={scrolls ? 'region' : undefined} aria-label={scrolls ? label : undefined} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </div>
  );
}

export function Facts({ items, tight }: { items: Array<[label: string, value: ReactNode]>; tight?: boolean }) {
  return (
    <dl className={`facts${tight ? ' facts-tight' : ''}`}>
      {items.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <a className="back-link" href={to}><Icon name="back" />{children}</a>;
}

/* ---------- controls ---------- */

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend>{label}</legend>
      <div className="segmented-options">
        {options.map((option) => (
          <label key={option.value} className={option.value === value ? 'is-on' : undefined}>
            <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </div>
  );
}

export function TextField({ label, value, onChange, type = 'search', placeholder }: { label: string; value: string; onChange: (value: string) => void; type?: 'search' | 'date'; placeholder?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} autoComplete="off" spellCheck={false} />
    </div>
  );
}

/**
 * On a phone the less-used filters fold away, so the search box, the result count and the list stay near the top.
 * The result count (`status`) comes before the folded filters there, so opening them never pushes it off the screen;
 * on a larger screen it follows the filters, just above the list.
 */
export function MoreFilters({ count, status, children }: { count: number; status: ReactNode; children: ReactNode }) {
  const compact = useMediaQuery(COMPACT_QUERY);
  if (!compact) return <>{children}{status}</>;
  return (
    <>
      {status}
      <details className="filters-more">
        <summary>{count > 0 ? `More filters (${count} set)` : 'More filters'}</summary>
        {children}
      </details>
    </>
  );
}

/** Clears a directory's filters and puts focus on the result count, so keyboard focus is not lost with the button. */
export function ClearFilters({ to, focus }: { to: string; focus: RefObject<HTMLElement | null> }) {
  return (
    <button type="button" className="btn btn-quiet btn-clear" onClick={() => { navigate(to); window.requestAnimationFrame(() => focus.current?.focus()); }}>
      Clear filters
    </button>
  );
}

export function WatchButton({ item }: { item: Omit<WatchItem, 'addedAt'> }) {
  const items = useWatchlist();
  const watched = isWatched(items, item.type, item.id);
  // A write the browser refuses (its storage is full, for example) leaves the list as it was; the status says so
  // until the next press.
  const [failed, setFailed] = useState<'add' | 'remove' | null>(null);
  useEffect(() => setFailed(null), [item.type, item.id]);
  if (!storageAvailable()) return null;
  const toggle = () => setFailed(toggleWatch(item) ? null : watched ? 'remove' : 'add');
  return (
    <>
      <button type="button" className="btn" aria-pressed={watched} onClick={toggle}>
        <Icon name="star" />{watched ? 'Remove from watchlist' : 'Add to watchlist'}
      </button>
      {watched ? <a className="btn btn-quiet" href={buildHash(['watchlist'])}>View watchlist</a> : null}
      <span className="btn-status" role="status">
        {failed ? `Could not ${failed === 'add' ? 'add this to' : 'remove this from'} the watchlist: this browser did not let the site save it. Its storage may be full.` : ''}
      </span>
    </>
  );
}

export function CopyLinkButton({ hash }: { hash: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const field = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  const url = shareUrl(hash);
  // A message belongs to the address it was about: another page or view clears it.
  useEffect(() => {
    window.clearTimeout(timer.current);
    setState('idle');
  }, [url]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // When the browser refuses the clipboard, the address is offered in a read-only field, selected, ready to copy by hand.
  useEffect(() => {
    if (state !== 'failed') return;
    field.current?.focus();
    field.current?.select();
  }, [state]);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      // Only the confirmation clears itself. A failure stays, with the address, until the next action.
      timer.current = window.setTimeout(() => setState('idle'), 4000);
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <button type="button" className="btn" onClick={copy}><Icon name="link" />Copy link</button>
      <span className="btn-status" role="status">
        {state === 'copied' ? 'Link copied' : state === 'failed' ? 'The link could not be copied automatically. It is in the field below, ready to copy.' : ''}
      </span>
      {state === 'failed' ? (
        <div className="field copy-fallback" style={{ flexBasis: '100%' }}>
          <label htmlFor={fieldId}>Link to this page</label>
          <input id={fieldId} ref={field} type="text" readOnly value={url} onFocus={(event) => event.currentTarget.select()} autoComplete="off" spellCheck={false} />
        </div>
      ) : null}
    </>
  );
}

/** Legal Source Pack: JSON, CSV and a print-friendly summary of the same records. */
export function ExportMenu({ build, printHash }: { build: () => SourcePack | null; printHash: string }) {
  const [status, setStatus] = useState('');
  const run = (kind: 'json' | 'csv') => {
    const pack = build();
    if (!pack) {
      setStatus('The source pack is not ready yet. Try again when the page has finished loading.');
      return;
    }
    if (kind === 'json') downloadText(packFileName(pack, 'json'), 'application/json', `${JSON.stringify(pack, null, 2)}\n`);
    else downloadText(packFileName(pack, 'csv'), 'text/csv;charset=utf-8', packToCsv(pack));
    setStatus(`Downloaded ${packFileName(pack, kind)} with ${pack.items.length} entries`);
  };
  return (
    <div className="export" id="source-pack">
      <h3 id="source-pack-h" tabIndex={-1}>Legal source pack</h3>
      <p className="quiet">The records on this page with their source links, dates and verification states.</p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => run('json')}><Icon name="download" />Download JSON</button>
        <button type="button" className="btn" onClick={() => run('csv')}><Icon name="download" />Download CSV</button>
        <a className="btn" href={printHash}>Open print summary</a>
      </div>
      <p className="btn-status" role="status">{status}</p>
    </div>
  );
}

/* ---------- tabs ---------- */

export interface TabDef { id: string; label: string }

/** ARIA tabs with arrow-key movement. The active tab is controlled by the caller (it lives in the URL). */
export function Tabs({ tabs, active, onChange, label, idBase, ref }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string; idBase: string; ref?: Ref<HTMLDivElement> }) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const tab = tabs[next]!;
    onChange(tab.id);
    window.requestAnimationFrame(() => document.getElementById(`${idBase}-tab-${tab.id}`)?.focus());
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idBase}-tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`${idBase}-panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, id, children }: { idBase: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className="tabpanel">
      {children}
    </div>
  );
}
