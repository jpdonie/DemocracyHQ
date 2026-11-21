import { useEffect, useMemo, type ReactNode } from 'react';
import type { CourtDocument, EntityRelationship, LegalCase, LegalEvent } from '../../types/schemas';
import { useCore } from '../../lib/core';
import { loadCase } from '../../lib/data';
import { entityNamer, packForCase } from '../../lib/export';
import { formatDate, plural } from '../../lib/format';
import { isRecordStale } from '../../lib/freshness';
import { eventLabel, relationshipLabel, SCOPE_LABELS, useTagLabels } from '../../lib/labels';
import { relationshipsForRecord } from '../../lib/relations';
import { buildHash, patchQuery, shareUrl, type Route } from '../../lib/router';
import { isPlainClick, revealElement, useRaiseSheet } from '../../lib/sheet';
import { dataOf, mapLoadable, useLoad, type Loadable } from '../../lib/useLoad';
import {
  A, Async, BackLink, CopyLinkButton, ErrorNote, ExportMenu, Ext, Facts, GapNotice, LinkVerification, Loading, Section, Segmented, SourceLine, TableScroll, TypeMark, WatchButton,
} from '../../components/ui';

const ROUTINE_DOCUMENTS = new Set(['Proof of Service', 'Certificate of Word Count']);

/** "Opinion (linked in docket entry)", not "Opinion: Opinion (linked in docket entry)". */
function documentLabel(doc: CourtDocument): string {
  if (doc.documentType === 'Main Document' || doc.title.toLowerCase().startsWith(doc.documentType.toLowerCase())) return doc.title;
  return `${doc.documentType}: ${doc.title}`;
}

/** The file a link points to, and the page when the link names one: "25a1197_097c.pdf, page 4". */
function fileOf(url: string): string {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname);
    const page = /(?:^|&)page=(\d+)/.exec(parsed.hash.slice(1))?.[1];
    return page ? `${file}, page ${page}` : file;
  } catch {
    return url;
  }
}

/**
 * The documents an entry links to, each named so that two links never share a name but lead to different places
 * (WCAG 2.4.4): a repeated label gets the file name and page. A document linked twice at the same address is listed once.
 */
function entryDocumentLinks(docs: readonly CourtDocument[]): Array<{ doc: CourtDocument; label: string }> {
  const seen = new Set<string>();
  const unique = docs.filter((doc) => {
    if (!doc.url) return true;
    if (seen.has(doc.url)) return false;
    seen.add(doc.url);
    return true;
  });
  const labels = unique.map(documentLabel);
  return unique.map((doc, i) => {
    const repeated = labels.filter((label) => label === labels[i]).length > 1;
    return { doc, label: repeated && doc.url ? `${labels[i]}, ${fileOf(doc.url)}` : labels[i]! };
  });
}

/**
 * A document whose address answered "not found" when the pipeline checked it is not offered as a link. Its label, the
 * dated note and the address the Court's docket gives are shown as text, so the address can still be copied.
 */
function UnavailableDocument({ doc, label }: { doc: CourtDocument; label: string }) {
  const note = doc.accessNote
    ? doc.accessNote.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) => formatDate(date))
    : 'The address the Court’s docket gives did not lead to the document when DemocracyHQ last checked it.';
  return (
    <>
      {label}: <span className="quiet">shown without a link. {note}</span>{' '}
      <span className="hash doc-address">{doc.url}</span>
    </>
  );
}

function DocketEntry({ event, documents }: { event: LegalEvent; documents: ReadonlyMap<string, CourtDocument> }) {
  const docs = event.documentIds.map((id) => documents.get(id)).filter((d): d is CourtDocument => Boolean(d));
  const main = entryDocumentLinks(docs.filter((d) => !ROUTINE_DOCUMENTS.has(d.documentType)));
  const routine = docs.filter((d) => ROUTINE_DOCUMENTS.has(d.documentType)).length;
  return (
    <li className={`entry${event.significance === 'major' ? ' entry-major' : ''}`}>
      <time dateTime={event.date}>{formatDate(event.date)}</time>
      <div>
        <p className="entry-text">{event.description}</p>
        <p className="entry-kind">{eventLabel(event.eventType)}</p>
        {main.length > 0 ? (
          <ul className="entry-docs">
            {main.map(({ doc, label }) => (
              <li key={doc.id}>
                {doc.url && doc.availability === 'unavailable' ? <UnavailableDocument doc={doc} label={label} />
                  : doc.url ? <Ext href={doc.url}>{label}</Ext>
                  : <span>{label} (not publicly linked)</span>}
              </li>
            ))}
          </ul>
        ) : null}
        {routine > 0 ? <p className="quiet">{plural(routine, 'service or word-count certificate')} also filed; see the Court&rsquo;s docket.</p> : null}
      </div>
    </li>
  );
}

/** Docket numbers in a line of text, linked when the docket is in this dataset. */
function DocketRefs({ text }: { text: string }) {
  const core = useCore();
  const known = new Map((dataOf(core.cases) ?? []).map((c) => [c.docketNumber.toUpperCase(), c.id]));
  const parts = text.split(/(\b\d{2}[-A]\d{1,5}\b)/);
  return (
    <span>
      {parts.map((part, i) => {
        const id = known.get(part.toUpperCase());
        return id ? <a key={i} href={buildHash(['litigation', id])}>{part}</a> : <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function ScopeList({ links, record }: { links: Loadable<EntityRelationship[]>; record: LegalCase }) {
  const core = useCore();
  const geo = dataOf(core.geo);
  const bills = dataOf(core.bills)?.bills ?? [];
  // While the links are loading, or if they failed, nothing may be said about whether any exist.
  if (links.status === 'loading') return <Loading what="the links to places and legislation" />;
  if (links.status === 'error') return <ErrorNote error={links.error} what="the links between records" />;
  const relationships = links.data;
  if (relationships.length === 0) {
    return <GapNotice>No place or bill has been linked to this case yet. That says nothing about where the case applies.</GapNotice>;
  }
  return (
    <ul className="links">
      {relationships.map((r) => {
        const other = r.source.type === 'case' && r.source.id === record.id ? r.target : r.source;
        const bill = other.type === 'bill' ? bills.find((b) => b.id === other.id) : undefined;
        const label = other.type === 'geography' ? geo?.get(other.id)?.name ?? other.id : bill ? `${bill.stateAbbr} ${bill.identifier}` : other.id;
        const href = other.type === 'geography' ? buildHash(['place', other.id]) : other.type === 'bill' ? buildHash(['laws', other.id]) : buildHash(['litigation', other.id]);
        return (
          <li key={r.id} className="link-item">
            <p className="link-head">
              <span className="link-kind">{relationshipLabel(r.relationshipType)}</span> <a href={href}>{label}</a>
            </p>
            <p className="link-scope">Scope: {SCOPE_LABELS[r.scope.kind] ?? r.scope.kind}. {r.scope.note}</p>
            {r.support.quote ? (
              <p className="link-support">
                From <Ext href={r.support.url}>{r.support.document ?? 'the cited court document'}</Ext>: <q>{r.support.quote}</q>
              </p>
            ) : null}
            <LinkVerification verification={r.verification} />
          </li>
        );
      })}
    </ul>
  );
}

export function CaseDetail({ id, route }: { id: string; route: Route }) {
  const core = useCore();
  const record = useLoad(`case:${id}`, () => loadCase(id));
  return (
    <article className="view">
      <BackLink to={buildHash(['litigation'])}>All court cases</BackLink>
      <Async of={record} what="this case" heading="Court case">
        {(data) => <CaseBody record={data} route={route} links={mapLoadable(core.relationships, (all) => relationshipsForRecord('case', data.id, all))} />}
      </Async>
    </article>
  );
}

function CaseBody({ record, route, links }: { record: LegalCase; route: Route; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  const labels = useTagLabels();
  const sources = dataOf(core.sources) ?? [];
  const source = sources.find((s) => s.id === record.sourceId);
  const showAll = route.query.entries === 'all';
  const newestFirst = route.query.order === 'newest';
  const documents = useMemo(() => new Map(record.documents.map((d) => [d.id, d])), [record.documents]);
  const entries = useMemo(() => {
    const list = showAll ? [...record.events] : record.events.filter((e) => e.significance === 'major');
    return newestFirst ? list.reverse() : list;
  }, [record.events, showAll, newestFirst]);
  const majorCount = record.events.filter((e) => e.significance === 'major').length;
  const ruling = record.latestDispositiveEntry;
  // Key entries after the ruling: orders (on an application or motion, on rehearing, or interim), and the issuing of the
  // judgment, which is not an order and is named separately.
  const later = ruling ? record.events.filter((e) => e.date > ruling.date && e.significance === 'major') : [];
  const laterOrders = later.filter((e) => /ruling|order/.test(e.eventType)).length;
  const judgmentIssued = later.find((e) => e.eventType === 'judgment_issued');
  const raiseSheet = useRaiseSheet();
  // The docket entries are a section of this page. A bare "#docket" link would be read as a route by the hash router,
  // so the link carries the route with section=docket and, when followed here, scrolls to the section and focuses it.
  const toDocket = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    raiseSheet();
    revealElement(() => document.getElementById('docket-h'));
  };
  const docketLink = <a href={buildHash(route.path, { ...route.query, section: 'docket' })} onClick={toDocket}>docket entries</a>;
  const section = route.query.section;
  useEffect(() => {
    if (section === 'docket') revealElement(() => document.getElementById('docket-h'));
  }, [section]);
  const stale = source ? isRecordStale(record.lastCheckedAt, source.staleAfterDays, core.now) : false;

  return (
    <>
      <header className="view-head">
        <TypeMark type="case" />
        <h1 tabIndex={-1} className="case-name">{record.caseName}</h1>
        <p className="lede">No. {record.docketNumber}, Supreme Court of the United States</p>
        <div className="btn-row">
          <WatchButton item={{ type: 'case', id: record.id, label: `${record.caseName}, No. ${record.docketNumber}` }} />
          <CopyLinkButton hash={buildHash(['litigation', record.id], route.query)} />
        </div>
      </header>

      <Section title="What the docket shows" note="DemocracyHQ quotes the Court’s docket entries. It does not summarise a ruling or decide what a case’s overall status is.">
        {ruling ? (
          <figure className="quote-block">
            <blockquote>{ruling.text}</blockquote>
            <figcaption>
              Docket entry of {formatDate(ruling.date)}, classified as &ldquo;{eventLabel(ruling.eventType)}&rdquo; by rule <A to={buildHash(['sources'], { section: 'rules' })}>{ruling.ruleId}</A>.
              It is the latest entry that rules on the case itself (an opinion, a summary disposition, a denial of review or a dismissal) or, where there is none, the latest ruling on an application. An order on whether the Court will hear the case is never chosen.
              {laterOrders > 0 ? <> {plural(laterOrders, 'later order')} {laterOrders === 1 ? 'appears' : 'appear'} in the {docketLink}{judgmentIssued ? `, and the judgment was issued on ${formatDate(judgmentIssued.date)}` : ''}.</>
                : judgmentIssued ? <> The judgment was issued on {formatDate(judgmentIssued.date)}; see the {docketLink}.</>
                : <> Later orders, if any, appear in the {docketLink}.</>}
            </figcaption>
          </figure>
        ) : (
          <p>No docket entry was automatically identified as a ruling by DemocracyHQ&rsquo;s published rules. That does not mean there is none: read the entries below or the Court&rsquo;s docket.</p>
        )}
        <Facts
          items={[
            ['Docketed', formatDate(record.dateDocketed)],
            ['Latest docket activity', formatDate(record.sourceLastActivity, 'Not reported by the source')],
            ['Entries on the docket', `${record.entryCount} (${record.documentCount} linked documents)`],
            ['Lower court', record.lowerCourt.name
              ? `${record.lowerCourt.name}${record.lowerCourt.caseNumbers.length ? `, No. ${record.lowerCourt.caseNumbers.join(', ')}` : ''}${record.lowerCourt.decisionDate ? `, decided ${formatDate(record.lowerCourt.decisionDate)}` : ', no decision date on the docket'}`
              : 'Not recorded on the docket'],
          ]}
        />
        {record.linkedNote || record.relatedDockets.length > 0 || record.sameLowerCourt.length > 0 ? (
          <Facts
            items={[
              ...(record.linkedNote ? [['Linked dockets', <DocketRefs key="linked" text={record.linkedNote} />] as [string, ReactNode]] : []),
              ...(record.relatedDockets.length ? [['Consolidated or related', <DocketRefs key="related" text={record.relatedDockets.map((d) => `${d.docket ?? ''}${d.type ? ` (${d.type})` : ''}`).join(', ')} />] as [string, ReactNode]] : []),
              ...(record.sameLowerCourt.length ? [['From the same lower-court case', (
                <span key="same">{record.sameLowerCourt.map((d, i) => (
                  <span key={d.caseId}>{i > 0 ? '; ' : ''}<a href={buildHash(['litigation', d.caseId ?? ''])}>No. {d.docket}</a>{d.caseName ? `, ${d.caseName}` : ''}</span>
                ))}</span>
              )] as [string, ReactNode]] : []),
            ]}
          />
        ) : null}
      </Section>

      {record.questionsPresented ? (
        <Section title="Questions presented" note="Text of the Court’s questions-presented document, extracted from the PDF. The document reproduces the questions as framed by the party that sought review; lines in capitals are the Court’s own additions. Line breaks may differ from the original.">
          {record.questionsPresented.text ? (
            <details className="reading-details">
              <summary>Read the questions presented</summary>
              <div className="reading">{record.questionsPresented.text.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div>
            </details>
          ) : null}
          <p><Ext href={record.questionsPresented.url}>Questions presented (PDF, supremecourt.gov)</Ext></p>
        </Section>
      ) : null}

      <Section title="Places and legislation linked to this case" note="A link appears only where a court document supports it. The court’s location is never used to place a case.">
        <ScopeList links={links} record={record} />
      </Section>

      <Section title="Issue tags" note="Applied by keyword rules to the stated text. They describe subject matter only, never the merits.">
        {record.issueTags.length === 0 ? (
          <p className="quiet">No rule matched. The case is listed without tags rather than with a guess.</p>
        ) : (
          <TableScroll label="Issue tags">
            <table className="table">
              <thead><tr><th scope="col">Tag</th><th scope="col">Matched in</th><th scope="col">Matched text</th></tr></thead>
              <tbody>
                {record.issueTags.map((tag) => (
                  <tr key={tag.tag}>
                    <td><a className="tag" href={buildHash(['litigation'], { tag: tag.tag })}>{labels.get(tag.tag) ?? tag.tag}</a><br /><span className="quiet">rule {tag.ruleId}</span></td>
                    <td>{tag.matchedField}{tag.matchCount ? ` (${tag.matchCount} matches; first shown)` : ''}</td>
                    <td>&hellip;{tag.matchedText}&hellip;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="Docket entries" id="docket">
        <div className="toolbar">
          <Segmented
            label="Show"
            value={showAll ? 'all' : 'major'}
            options={[{ value: 'major', label: `Key entries (${majorCount})` }, { value: 'all', label: `All entries (${record.events.length})` }]}
            onChange={(value) => patchQuery(route, { entries: value === 'all' ? 'all' : '' })}
          />
          <Segmented
            label="Order"
            value={newestFirst ? 'newest' : 'oldest'}
            options={[{ value: 'oldest', label: 'Oldest first' }, { value: 'newest', label: 'Newest first' }]}
            onChange={(value) => patchQuery(route, { order: value === 'newest' ? 'newest' : '' })}
          />
        </div>
        {entries.length === 0 ? <p className="quiet">No key entries were identified. Show all entries to read the docket.</p> : (
          <ol className="entries">
            {entries.map((event) => <DocketEntry key={event.id} event={event} documents={documents} />)}
          </ol>
        )}
        <p className="quiet">Which entries count as key is decided by published rules, listed under <A to={buildHash(['sources'], { section: 'rules' })}>Data and methodology</A>.</p>
      </Section>

      <SourceLine
        sourceName={source?.name ?? 'Supreme Court of the United States docket'}
        sourceUrl={record.sourceUrl}
        verification={record.verification}
        lastCheckedAt={record.lastCheckedAt}
        sourceActivity={{ label: 'Latest activity reported by the Court', date: record.sourceLastActivity }}
        stale={stale}
        correctionSubject={`${record.caseName}, No. ${record.docketNumber}`}
      />
      <ExportMenu
        printHash={buildHash(['pack', 'case', record.id])}
        // While the links or the source list are loading the pack is not offered; a file that failed is named in the pack
        // instead of being left out.
        build={() => (links.status === 'loading' || core.sources.status === 'loading' ? null : packForCase({
          record, relationships: dataOf(links), now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
          nameOf: entityNamer({ geo: dataOf(core.geo), bills: dataOf(core.bills)?.bills, cases: dataOf(core.cases) }),
        }))}
      />
    </>
  );
}
