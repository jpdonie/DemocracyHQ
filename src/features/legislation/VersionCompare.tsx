/**
 * Version comparison and reading view for official bill text.
 * With `from` and `to` it shows what changed between two published versions;
 * with only `to` it shows that version's text.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegislativeInstrument, TextBlock, VersionText } from '../../types/schemas';
import { loadBill, loadVersionText } from '../../lib/data';
import { diffBlocks, isIdentical, markedText, segmentDiff, type DiffResult, type DiffRow } from '../../lib/diff';
import { formatDate, formatNumber, plural } from '../../lib/format';
import { buildHash, patchQuery, type Route } from '../../lib/router';
import { useLoad } from '../../lib/useLoad';
import { Async, BackLink, Ext, GapNotice, Loading, SelectField, TypeMark } from '../../components/ui';

const PAGE = 300;

function Block({ block, as = 'p', className }: { block: TextBlock; as?: 'p' | 'ins' | 'del'; className?: string }) {
  const [kind, text] = block;
  const kindClass = kind === 's' ? 'blk-section' : kind === 'h' ? 'blk-heading' : kind === 'a' ? 'blk-amend' : 'blk-para';
  const content = as === 'ins' ? <ins>{text}</ins> : as === 'del' ? <del>{text}</del> : text;
  return <p className={`blk ${kindClass} ${className ?? ''}`.trim()}>{content}</p>;
}

/**
 * One row of a comparison. In an edited paragraph the removed and added words are marked; no character is added
 * between them (a removal and the addition after it are set apart by a margin), so the paragraph read without its
 * added words is the earlier text, and read without its removed words the later text.
 */
export function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === 'equal') return <Block block={row.block} />;
  if (row.kind === 'insert') return <Block block={row.block} as="ins" className="blk-ins" />;
  if (row.kind === 'delete') return <Block block={row.block} as="del" className="blk-del" />;
  const [kind] = row.after;
  const kindClass = kind === 's' ? 'blk-section' : kind === 'h' ? 'blk-heading' : kind === 'a' ? 'blk-amend' : 'blk-para';
  return (
    <p className={`blk ${kindClass} blk-chg`}>
      {markedText(row.words).map((part, i) => (
        part.mark === 'ins' ? <ins key={i} className={part.adjoins ? 'adjoins' : undefined}>{part.text}</ins>
          : part.mark === 'del' ? <del key={i} className={part.adjoins ? 'adjoins' : undefined}>{part.text}</del>
            : <span key={i}>{part.text}</span>
      ))}
    </p>
  );
}

function DiffBody({ result, showUnchanged }: { result: DiffResult; showUnchanged: boolean }) {
  const segments = useMemo(() => segmentDiff(result.rows, 1), [result]);
  const [limit, setLimit] = useState(PAGE);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  // The button that reveals unchanged paragraphs goes away when pressed, so focus moves to the first paragraph it revealed.
  const [revealed, setRevealed] = useState<number | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setLimit(PAGE);
    setOpened(new Set());
    setRevealed(null);
  }, [result]);
  useEffect(() => {
    if (revealed === null) return;
    const first = container.current?.querySelector<HTMLElement>(`[data-segment="${revealed}"] > .blk`);
    if (first) {
      first.tabIndex = -1;
      first.focus();
    }
    setRevealed(null);
  }, [revealed]);
  let budget = limit;
  let truncated = false;
  const out: React.ReactNode[] = [];
  segments.forEach((segment, index) => {
    if (budget <= 0) {
      truncated = true;
      return;
    }
    if (segment.type === 'unchanged' && !showUnchanged && !opened.has(index)) {
      out.push(
        <p key={`u${index}`} className="diff-skip">
          <button type="button" className="btn btn-quiet" onClick={() => { setOpened(new Set([...opened, index])); setRevealed(index); }}>
            Show {plural(segment.rows.length, 'unchanged paragraph')}
          </button>
        </p>,
      );
      return;
    }
    const rows = segment.rows.slice(0, budget);
    if (rows.length < segment.rows.length) truncated = true;
    budget -= rows.length;
    out.push(<div key={`s${index}`} data-segment={index} className={segment.type === 'changes' ? 'diff-changes' : 'diff-same'}>{rows.map((row, i) => <DiffRowView key={i} row={row} />)}</div>);
  });
  return (
    <div className="diff reading" ref={container}>
      {out}
      {truncated ? (
        <p className="diff-more">
          <button type="button" className="btn" onClick={() => setLimit(limit + PAGE * 2)}>Show more of the text</button>
          <span className="quiet"> Long documents are shown in parts so the page stays responsive.</span>
        </p>
      ) : null}
    </div>
  );
}

function ReadBody({ text }: { text: VersionText }) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [text]);
  return (
    <div className="diff reading">
      {text.blocks.slice(0, limit).map((block, i) => <Block key={i} block={block} />)}
      {text.blocks.length > limit ? (
        <p className="diff-more">
          <button type="button" className="btn" onClick={() => setLimit(limit + PAGE * 2)}>Show more of the text</button>
          <span className="quiet"> {formatNumber(text.blocks.length - limit)} paragraphs remain.</span>
        </p>
      ) : null}
    </div>
  );
}

function Comparison({ before, after, showUnchanged }: { before: VersionText; after: VersionText; showUnchanged: boolean }) {
  const [result, setResult] = useState<DiffResult | null>(null);
  useEffect(() => {
    setResult(null);
    // Yield once so the "Comparing" message paints before a long comparison starts.
    const timer = window.setTimeout(() => setResult(diffBlocks(before.blocks, after.blocks)), 20);
    return () => window.clearTimeout(timer);
  }, [before, after]);
  if (!result) return <Loading what="the comparison" />;
  const { stats } = result;
  return (
    <>
      <div className="diff-summary" role="status">
        <p>
          <strong>{before.label} ({formatDate(before.versionDate)})</strong> compared with <strong>{after.label} ({formatDate(after.versionDate)})</strong>:{' '}
          {isIdentical(result)
            ? 'the mirrored text of the two versions is identical.'
            : `${plural(stats.inserted, 'paragraph')} added, ${plural(stats.deleted, 'paragraph')} removed, ${plural(stats.changed, 'paragraph')} edited, ${formatNumber(stats.unchanged)} unchanged.`}
        </p>
        {!result.aligned ? <p className="quiet">These versions were too different to align paragraph by paragraph in the time allowed, so the earlier text is shown as removed and the later text as added.</p> : null}
        {result.aligned && result.unpaired > 0 ? (
          <p className="quiet">
            The time allowed ran out before every edited paragraph could be compared word by word, so {plural(result.unpaired, 'edited paragraph')} {result.unpaired === 1 ? 'is' : 'are'} shown
            as the earlier paragraph removed and the later one added, and counted that way above.
          </p>
        ) : null}
        {before.subject !== after.subject ? (
          <p>The official subject line changed from <del>{before.subject ?? 'none'}</del> to <ins>{after.subject ?? 'none'}</ins></p>
        ) : null}
        {before.title !== after.title ? (
          <p>The official title changed from <del>{before.title ?? 'none'}</del> to <ins>{after.title ?? 'none'}</ins></p>
        ) : null}
        <p className="diff-key"><ins>Added text</ins> <del>Removed text</del></p>
      </div>
      {isIdentical(result) && !showUnchanged ? <p className="quiet">Nothing to highlight. Turn on &ldquo;Show unchanged text&rdquo; to read the full text.</p> : null}
      <DiffBody result={result} showUnchanged={showUnchanged} />
    </>
  );
}

/** Says which requested version ids this page cannot show, instead of silently showing another version. */
function MissingVersions({ bill, requested, mirrored, shown }: {
  bill: LegislativeInstrument; requested: Array<{ role: string; id: string }>; mirrored: LegislativeInstrument['versions']; shown: string;
}) {
  return (
    <div className="state state-empty notice-missing" role="note">
      <p><strong>{requested.length === 1 ? 'The link asks for a text version that is not available here.' : 'The link asks for text versions that are not available here.'}</strong></p>
      {requested.map(({ role, id }) => {
        const listed = bill.versions.find((v) => v.id === id);
        return (
          <p key={role}>
            {role}: <span className="geoid">{id}</span>.{' '}
            {listed ? `This is the “${listed.label}” version of ${formatDate(listed.versionDate)}, whose text is not mirrored; use its official link on the measure’s page.` : `No version of California ${bill.identifier} in this dataset has this id. Version ids can change when the data is refreshed.`}
          </p>
        );
      })}
      <p>Showing {shown} instead. Mirrored versions of this measure: {mirrored.map((v) => `${v.label} (${formatDate(v.versionDate)})`).join('; ')}.</p>
    </div>
  );
}

/**
 * True when the version chosen as the earlier one is in fact the later one: dated later, or, on the same day, listed
 * after it in the measure's history. The comparison would then read backwards in time.
 */
export function isReversed(versions: LegislativeInstrument['versions'], fromId: string, toId: string): boolean {
  const fromIndex = versions.findIndex((v) => v.id === fromId);
  const toIndex = versions.findIndex((v) => v.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
  const fromDate = versions[fromIndex]!.versionDate;
  const toDate = versions[toIndex]!.versionDate;
  if (fromDate !== toDate) return fromDate > toDate;
  return fromIndex > toIndex;
}

function CompareBody({ bill, route }: { bill: LegislativeInstrument; route: Route }) {
  const mirrored = bill.versions.filter((v) => v.textAvailability === 'mirrored' && v.textPath);
  const to = mirrored.find((v) => v.id === route.query.to) ?? mirrored[mirrored.length - 1];
  const from = mirrored.find((v) => v.id === route.query.from);
  const missing = ([['Earlier version', route.query.from], ['Later version', route.query.to]] as const)
    .filter(([, id]) => id && !mirrored.some((v) => v.id === id))
    .map(([role, id]) => ({ role, id: id! }));
  const showUnchanged = route.query.unchanged === '1';
  const toText = useLoad(to ? `text:${to.id}` : null, () => loadVersionText(to!.textPath!));
  const fromText = useLoad(from ? `text:${from.id}` : null, () => loadVersionText(from!.textPath!));

  if (!to) {
    return <GapNotice>No text version of this measure is mirrored. Use the official links on the measure&rsquo;s page.</GapNotice>;
  }
  const comparing = Boolean(from) && from!.id !== to.id;
  const reversed = comparing && isReversed(bill.versions, from!.id, to.id);
  const swap = () => {
    patchQuery(route, { from: to.id, to: from!.id }, { replace: false });
    // The notice and its button go away; focus moves to the first version menu, which now shows the earlier version.
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.compare-versions select')?.focus());
  };
  return (
    <>
      <header className="view-head">
        <TypeMark type="bill" />
        <h1 tabIndex={-1}>{comparing ? 'Compare text versions' : 'Read a text version'}: <span className="bill-id">California {bill.identifier}</span></h1>
        <p className="lede">{bill.subject}</p>
      </header>
      {missing.length > 0 ? (
        <MissingVersions bill={bill} requested={missing} mirrored={mirrored} shown={comparing ? `the comparison of ${from!.label} with ${to.label}` : `the text of the ${to.label} version`} />
      ) : null}
      <form className="filters filters-inline compare-versions" aria-label="Choose versions" onSubmit={(event) => event.preventDefault()}>
        <SelectField label="Earlier version" value={from?.id ?? ''} onChange={(value) => patchQuery(route, { from: value }, { replace: false })}>
          <option value="">None (just read the later version)</option>
          {mirrored.map((v) => <option key={v.id} value={v.id}>{v.label}, {formatDate(v.versionDate)}</option>)}
        </SelectField>
        <SelectField label="Later version" value={to.id} onChange={(value) => patchQuery(route, { to: value }, { replace: false })}>
          {mirrored.map((v) => <option key={v.id} value={v.id}>{v.label}, {formatDate(v.versionDate)}</option>)}
        </SelectField>
        {comparing ? (
          <label className="check">
            <input type="checkbox" checked={showUnchanged} onChange={(event) => patchQuery(route, { unchanged: event.target.checked ? '1' : '' })} />
            <span>Show unchanged text</span>
          </label>
        ) : null}
      </form>
      {reversed ? (
        <div className="state state-empty notice-reversed" role="note">
          <p>
            <strong>These versions are in reverse order.</strong> The version chosen as earlier ({from!.label}, {formatDate(from!.versionDate)}) is later than
            the version chosen as later ({to.label}, {formatDate(to.versionDate)}). Below, text marked as added was in fact removed over time, and text
            marked as removed was added.
          </p>
          <p><button type="button" className="btn" onClick={swap}>Swap the two versions</button></p>
        </div>
      ) : null}
      <p className="quiet source-inline">
        Text extracted from the Legislative Counsel&rsquo;s official bulk data. Tables and special formatting are flattened, and the official version controls:{' '}
        {from && comparing ? <><Ext href={from.officialUrl}>{from.label}</Ext>, </> : null}
        <Ext href={to.officialUrl}>{to.label}</Ext>. Text hash (SHA-256) of the later version: <span className="hash">{to.textHash?.slice(0, 16)}&hellip;</span>
      </p>
      {comparing ? (
        <Async of={fromText} what="the earlier version">
          {(before) => (
            <Async of={toText} what="the later version">
              {(after) => <Comparison before={before} after={after} showUnchanged={showUnchanged} />}
            </Async>
          )}
        </Async>
      ) : (
        <Async of={toText} what="the text">
          {(text) => <ReadBody text={text} />}
        </Async>
      )}
    </>
  );
}

export function VersionCompare({ id, route }: { id: string; route: Route }) {
  const record = useLoad(`bill:${id}`, () => loadBill(id));
  return (
    <article className="view view-wide">
      <BackLink to={buildHash(['laws', id])}>Back to the measure</BackLink>
      <Async of={record} what="this measure" heading="Text versions">
        {(bill) => <CompareBody bill={bill} route={route} />}
      </Async>
    </article>
  );
}
