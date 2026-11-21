import { useEffect, useMemo, type ReactNode } from 'react';
import type { CaseLink, CourtDocument, EntityRelationship, LegalCase, LegalEvent } from '../../types/schemas';
import { useCore } from '../../lib/core';
import { SCOTUS_ID, courtFullName, courtHash, courtShortName } from '../../lib/courts';
import { loadCase } from '../../lib/data';
import { entityNamer, packForCase } from '../../lib/export';
import { caseNameClass, formatDate, plural } from '../../lib/format';
import { isRecordStale } from '../../lib/freshness';
import { eventLabel, relationshipLabel, SCOPE_LABELS, useTagLabels } from '../../lib/labels';
import { relationshipsForRecord } from '../../lib/relations';
import { buildHash, patchQuery, shareUrl, type Route } from '../../lib/router';
import { isPlainClick, revealElement, useRaiseSheet } from '../../lib/sheet';
import { dataOf, mapLoadable, useLoad, type Loadable } from '../../lib/useLoad';
import { AboutBlock } from '../../components/About';
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
        <p className="entry-kind">{eventLabel(event.eventType, event.classificationRule)}</p>
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

/** Which issue tags the keyword rules gave the case, with the text each matched. */
function IssueTags({ record }: { record: LegalCase }) {
  const labels = useTagLabels();
  return (
    <Section title="Issue tags" note="Applied by keyword rules to the stated text. They describe subject matter only, never the merits.">
      {record.issueTags.length === 0 ? (
        <p className="quiet">{record.removedTags.length > 0 ? 'No tag is assigned.' : 'No rule matched. The case is listed without tags rather than with a guess.'}</p>
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
      {record.removedTags.length > 0 ? (
        <div className="removed-tags">
          <h3>Removed by a maintainer</h3>
          <p className="section-note">
            The rules count words, and a long opinion can reach a rule&rsquo;s count while it only cites decisions on another subject. A tag is removed only on a passage of the case&rsquo;s own document, which is checked on every data run (rule{' '}
            <A to={buildHash(['sources'], { section: 'rules' })}>{record.removedTags[0]!.removalRuleId}</A>).
          </p>
          <ul className="rows">
            {record.removedTags.map((tag) => (
              <li key={tag.tag} className="row">
                <p className="row-title">{labels.get(tag.tag) ?? tag.tag}</p>
                <p className="row-line">{tag.reason}</p>
                <p className="row-line">The document reads: <q>{tag.quote}</q> (<Ext href={tag.quoteUrl}>the document</Ext>)</p>
                <p className="row-meta">
                  Rule {tag.ruleId} had matched in the {tag.matchedField}{tag.matchCount ? `, ${plural(tag.matchCount, 'time')}` : ''}. The first match: &hellip;{tag.matchedText}&hellip;
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

/** The pairings of rule case-below-1 that this case is one side of, and whether the file that holds them failed to load. */
function useCaseLinks(caseId: string): { pairs: CaseLink[]; failed: boolean } {
  const core = useCore();
  return {
    pairs: (dataOf(core.caseLinks) ?? []).filter((link) => link.review.caseId === caseId || link.below.caseId === caseId),
    failed: core.caseLinks.status === 'error',
  };
}

/** What a page says in place of a pairing when the file of pairings failed to load: a missing row would read as "none". */
const PAIRING_NOT_LOADED = 'Could not be loaded: the file of links between records failed to load, so this page cannot say whether there is one.';

function CaseBody(props: { record: LegalCase; route: Route; links: Loadable<EntityRelationship[]> }) {
  return props.record.courtId === SCOTUS_ID ? <SupremeBody {...props} /> : <AppealBody {...props} />;
}

function SupremeBody({ record, route, links }: { record: LegalCase; route: Route; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  const { pairs: below, failed: pairsFailed } = useCaseLinks(record.id);
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
        <h1 tabIndex={-1} className={caseNameClass(record.caseName)}>{record.caseName}</h1>
        <p className="lede">No. {record.docketNumber}, Supreme Court of the United States</p>
        <AboutBlock about={record.about} type="case" />
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
        {below.length > 0 || pairsFailed || record.linkedNote || record.relatedDockets.length > 0 || record.sameLowerCourt.length > 0 ? (
          <Facts
            items={[
              ...(pairsFailed ? [['The case below, in this dataset', PAIRING_NOT_LOADED] as [string, ReactNode]] : []),
              ...(below.length ? [['The case below, in this dataset', (
                <span key="below">{below.map((link, i) => (
                  <span key={link.id}>
                    {i > 0 ? '; ' : ''}<a href={buildHash(['litigation', link.below.caseId])}><span className="case-name">{link.below.caseName}</span>, No. {link.below.docket}</a>
                  </span>
                ))}. Paired by rule <A to={buildHash(['sources'], { section: 'rules' })}>{below[0]!.ruleId}</A> from the lower court and case number on this docket.</span>
              )] as [string, ReactNode]] : []),
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

      <IssueTags record={record} />

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

/* ---------- a case of a court of appeals ---------- */

const GOVINFO_STANDARD_NOTE = 'Hosted by govinfo.gov; linked, not mirrored.';

/** A document of a court of appeals case as a link names it: "Opinion of Sep 9, 2026". */
function appealDocumentLabel(doc: CourtDocument): string {
  return `${doc.documentType} of ${formatDate(doc.filingDate)}`;
}

/** What the data says about a document's file beyond where it is hosted: a clerk's cover letter, or a file a program cannot read. */
function documentCaveat(doc: CourtDocument): string | null {
  const rest = (doc.accessNote ?? '').replace(GOVINFO_STANDARD_NOTE, '').trim();
  return rest || null;
}

function AppealDocumentLink({ doc }: { doc: CourtDocument }) {
  return doc.url
    ? <Ext href={doc.url}>{appealDocumentLabel(doc)} (PDF, govinfo.gov)</Ext>
    : <span>{appealDocumentLabel(doc)} (GovInfo gives no address for this document)</span>;
}

function AppealEntry({ event, documents }: { event: LegalEvent; documents: ReadonlyMap<string, CourtDocument> }) {
  const docs = event.documentIds.map((id) => documents.get(id)).filter((d): d is CourtDocument => Boolean(d));
  return (
    <li className={`entry${event.significance === 'major' ? ' entry-major' : ''}`}>
      <time dateTime={event.date}>{formatDate(event.date)}</time>
      <div>
        <p className="entry-text">{event.description}</p>
        <p className="entry-kind">{eventLabel(event.eventType, event.classificationRule)}</p>
        {docs.length > 0 ? (
          <ul className="entry-docs">
            {docs.map((doc) => (
              <li key={doc.id}>
                <AppealDocumentLink doc={doc} />
                {documentCaveat(doc) ? <p className="quiet">{documentCaveat(doc)}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/** The parties as the court's record lists them, by role in the order the record first gives each role. */
function Parties({ parties }: { parties: LegalCase['parties'] }) {
  const byRole = new Map<string, string[]>();
  for (const party of parties) {
    const role = party.role ?? 'Role not given in the record';
    byRole.set(role, [...(byRole.get(role) ?? []), party.name]);
  }
  const list = <Facts items={[...byRole].map(([role, names]) => [role, names.join('; ')])} />;
  return (
    <Section title={`Parties (${parties.length})`} note="As the court’s record on GovInfo lists them. The record does not say who filed what.">
      {parties.length > 12 ? (
        <details className="reading-details">
          <summary>Show the {parties.length} parties</summary>
          {list}
        </details>
      ) : list}
    </Section>
  );
}

/** Why the selection rule picked the case: one line for each test of the rule that it met, with what the rule counted. */
function WhyListed({ record, documents }: { record: LegalCase; documents: ReadonlyMap<string, CourtDocument> }) {
  const core = useCore();
  const selection = record.selection;
  if (!selection) return null;
  const partyMinimum = dataOf(core.appeals)?.selection.textTests.party?.wordMatches;
  const doc = selection.documentId ? documents.get(selection.documentId) : undefined;
  const counted = doc ? <AppealDocumentLink doc={doc} /> : 'One of its documents';
  const byText = selection.tests.some((test) => test === 'long' || test === 'dense');
  const words = selection.wordMatches ?? 0;
  return (
    <Section
      title="Why this case is listed"
      note={<>Cases of the courts of appeals are picked by a published rule (<A to={buildHash(['sources'], { section: 'coverage' })}>rule {selection.ruleId}</A>), not by a maintainer. The rule reads the court&rsquo;s record and counts words. It does not say what the case decides.</>}
    >
      <ul className="plain-list spaced">
        {selection.tests.includes('record') ? (
          <li>The court&rsquo;s record gives the case the nature of suit {[selection.natureOfSuitCode, selection.natureOfSuit ? `(${selection.natureOfSuit})` : null].filter(Boolean).join(' ')}.</li>
        ) : null}
        {byText && selection.wordCount ? (
          <li>
            {counted} has {plural(words, 'election word')} in {selection.wordCount.toLocaleString('en-US')} words{selection.density != null ? ` (${selection.density} per 1,000)` : ''} and {plural(selection.phraseMatches ?? 0, 'election phrase')}, which meets the rule&rsquo;s count for the text of a document.
            {selection.phrases.length > 0 ? ` Phrases counted most often: ${selection.phrases.map((phrase) => `“${phrase.term}” (${phrase.count})`).join(', ')}.` : ''}
          </li>
        ) : null}
        {selection.tests.includes('party') ? (
          <li>
            The case title or a party names an election authority, &ldquo;{selection.party}&rdquo;, and {doc ? <AppealDocumentLink doc={doc} /> : 'one of its documents'} has {plural(words, 'election word')}
            {partyMinimum ? ` (the rule asks for at least ${partyMinimum} where an election authority is named)` : ''}.
          </li>
        ) : null}
      </ul>
      <GapNotice>The rule can include a case that only discusses elections. A maintainer removes a case only where the opinion itself shows that no public election is at issue.</GapNotice>
    </Section>
  );
}

function AppealBody({ record, route, links }: { record: LegalCase; route: Route; links: Loadable<EntityRelationship[]> }) {
  const core = useCore();
  const { pairs: reviews, failed: pairsFailed } = useCaseLinks(record.id);
  const geo = dataOf(core.geo);
  const court = dataOf(core.courts)?.get(record.courtId);
  const sources = dataOf(core.sources) ?? [];
  const source = sources.find((s) => s.id === record.sourceId);
  const newestFirst = route.query.order === 'newest';
  const documents = useMemo(() => new Map(record.documents.map((d) => [d.id, d])), [record.documents]);
  const entries = useMemo(() => (newestFirst ? [...record.events].reverse() : record.events), [record.events, newestFirst]);
  const ruling = record.latestDispositiveEntry;
  // The entry the latest decision was read from, for the link to its document.
  const rulingEvent = ruling ? [...record.events].reverse().find((e) => e.date === ruling.date && e.description === ruling.text) : undefined;
  const rulingDocs = (rulingEvent?.documentIds ?? []).map((id) => documents.get(id)).filter((d): d is CourtDocument => Boolean(d));
  const section = route.query.section;
  useEffect(() => {
    if (section === 'docket') revealElement(() => document.getElementById('docket-h'));
  }, [section]);
  const stale = source ? isRecordStale(record.lastCheckedAt, source.staleAfterDays, core.now) : false;
  const originState = record.origin?.stateFips ? geo?.state(record.origin.stateFips) : undefined;
  const nature = [record.selection?.natureOfSuitCode, record.natureOfSuit].filter(Boolean).join(' ');
  const span = record.dateFirstEntry && record.sourceLastActivity && record.dateFirstEntry !== record.sourceLastActivity
    ? `, dated ${formatDate(record.dateFirstEntry)} to ${formatDate(record.sourceLastActivity)}`
    : record.sourceLastActivity ? `, dated ${formatDate(record.sourceLastActivity)}` : '';

  return (
    <>
      <header className="view-head">
        <TypeMark type="case" />
        <h1 tabIndex={-1} className={caseNameClass(record.caseName)}>{record.caseName}</h1>
        <p className="lede">No. {record.docketNumber}, <a href={courtHash(record.courtId)}>{courtFullName(court, record.courtId)}</a></p>
        <AboutBlock about={record.about} terms={(record.selection?.phrases ?? []).map((item) => item.term)} type="case" />
        <div className="btn-row">
          <WatchButton item={{ type: 'case', id: record.id, label: `${record.caseName}, No. ${record.docketNumber} (${courtShortName(court, record.courtId)})` }} />
          <CopyLinkButton hash={buildHash(['litigation', record.id], route.query)} />
        </div>
      </header>

      <Section
        title="What the court’s record shows"
        note="DemocracyHQ quotes the court’s own entry for each document that GovInfo holds for this case. It does not summarise a decision or say what became of it."
      >
        {ruling ? (
          <figure className="quote-block">
            <blockquote>{ruling.text}</blockquote>
            <figcaption>
              The court&rsquo;s entry of {formatDate(ruling.date)}, classified as &ldquo;{eventLabel(ruling.eventType, ruling.ruleId)}&rdquo; by rule <A to={buildHash(['sources'], { section: 'rules' })}>{ruling.ruleId}</A>.
              It is the latest opinion, decision or judgment among the documents GovInfo holds for this case.
              {rulingDocs.map((doc) => <span key={doc.id}> <AppealDocumentLink doc={doc} />.{documentCaveat(doc) ? ` ${documentCaveat(doc)}` : ''}</span>)}
            </figcaption>
          </figure>
        ) : (
          <p>No opinion, decision or judgment was identified among the documents GovInfo holds for this case. That does not mean the court has not decided it: read the documents below.</p>
        )}
        <Facts
          items={[
            ['Court', <a key="court" href={courtHash(record.courtId)}>{courtShortName(court, record.courtId)}</a>],
            ['Published or unpublished', record.publication ? `${record.publication}, as the court’s entry for the decision says` : 'The court’s entry does not say'],
            ['Nature of suit', nature ? `${nature}, as the court’s record gives it` : 'Not given in the court’s record'],
            ['Documents on GovInfo', `${record.documentCount}${span}`],
            ['Court below', record.origin ? (
              <span key="origin">
                {record.origin.court}. The opinion reads: <q>{record.origin.quote}</q> (<Ext href={record.origin.documentUrl}>the document</Ext>, read by rule <A to={buildHash(['sources'], { section: 'rules' })}>{record.origin.ruleId}</A>).
              </span>
            ) : 'Not read from the opinion. Only a line of the form “Appeal from the United States District Court for …” is read.'],
            ...(record.decidedWith.length > 0 ? [['Decided in the same opinion', (
              <span key="with">{record.decidedWith.map((other, i) => (
                <span key={other.caseId}>
                  {i > 0 ? '; ' : ''}<a href={buildHash(['litigation', other.caseId])}>No. {other.docket}</a>{other.caseName !== record.caseName ? <>, <span className="case-name">{other.caseName}</span></> : null}
                </span>
              ))}. Found by comparing the texts of the opinions (rule <A to={buildHash(['sources'], { section: 'rules' })}>same-opinion-1</A>).</span>
            )] as [string, ReactNode]] : []),
            ...(pairsFailed ? [['In the Supreme Court', PAIRING_NOT_LOADED] as [string, ReactNode]] : []),
            ...(reviews.length > 0 ? [['In the Supreme Court', (
              <span key="review">{reviews.map((link, i) => (
                <span key={link.id}>
                  {i > 0 ? '; ' : ''}<a href={buildHash(['litigation', link.review.caseId])}><span className="case-name">{link.review.caseName}</span>, No. {link.review.docket}</a>
                </span>
              ))}. <Ext href={reviews[0]!.sourceUrl}>The Court&rsquo;s docket</Ext> names this court and case number as the case below (rule <A to={buildHash(['sources'], { section: 'rules' })}>{reviews[0]!.ruleId}</A>).</span>
            )] as [string, ReactNode]] : []),
          ]}
        />
        <GapNotice>
          This is not the court&rsquo;s full docket. GovInfo holds the documents a court sends to the Government Publishing Office, mostly opinions.
          {reviews.length > 0 ? ' What happened to the case after its latest document is recorded here only as far as the linked Supreme Court docket shows it.'
            : pairsFailed ? ' Whether a Supreme Court docket in this dataset names this case could not be loaded. Whether a decision was later reheard or vacated is not recorded here.'
            : ' Whether a decision was later reheard, vacated or reviewed is not recorded here.'}
        </GapNotice>
      </Section>

      <WhyListed record={record} documents={documents} />

      {record.parties.length > 0 ? <Parties parties={record.parties} /> : null}

      <Section title="Places and legislation linked to this case" note="A link appears only where a court document supports it. The court’s location is never used to place a case.">
        <ScopeList links={links} record={record} />
        {record.origin && originState ? (
          <p className="quiet">
            The appeal began in a federal district court in <a href={buildHash(['place', originState.key])}>{originState.name}</a>, as the opinion names the court below. That says where the case began, not what it concerns.
          </p>
        ) : null}
      </Section>

      <IssueTags record={record} />

      <Section title={`Documents on GovInfo (${record.events.length})`} id="docket" note="Each entry is the court’s own text for a document, in the order of their dates.">
        {record.events.length > 1 ? (
          <div className="toolbar">
            <Segmented
              label="Order"
              value={newestFirst ? 'newest' : 'oldest'}
              options={[{ value: 'oldest', label: 'Oldest first' }, { value: 'newest', label: 'Newest first' }]}
              onChange={(value) => patchQuery(route, { order: value === 'newest' ? 'newest' : '' })}
            />
          </div>
        ) : null}
        <ol className="entries">
          {entries.map((event) => <AppealEntry key={event.id} event={event} documents={documents} />)}
        </ol>
        <p className="quiet">What kind of document an entry is, is decided by published rules, listed under <A to={buildHash(['sources'], { section: 'rules' })}>Data and methodology</A>.</p>
      </Section>

      <SourceLine
        sourceName={source?.name ?? 'GovInfo, United States Courts Opinions'}
        sourceUrl={record.sourceUrl}
        verification={record.verification}
        lastCheckedAt={record.lastCheckedAt}
        sourceActivity={{ label: 'Latest document GovInfo holds for the case', date: record.sourceLastActivity }}
        stale={stale}
        correctionSubject={`${record.caseName}, No. ${record.docketNumber} (${courtShortName(court, record.courtId)})`}
      />
      <ExportMenu
        printHash={buildHash(['pack', 'case', record.id])}
        build={() => (links.status === 'loading' || core.sources.status === 'loading' ? null : packForCase({
          record, relationships: dataOf(links), now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
          nameOf: entityNamer({ geo: dataOf(core.geo), bills: dataOf(core.bills)?.bills, cases: dataOf(core.cases) }),
        }))}
      />
    </>
  );
}
