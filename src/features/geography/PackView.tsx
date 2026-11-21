/** Print-friendly summary of a Legal Source Pack. Uses the same builder as the JSON and CSV downloads. */
import type { ReactNode } from 'react';
import { useCore } from '../../lib/core';
import { loadBill, loadCase } from '../../lib/data';
import { entityNamer, packForBill, packForCase, UNAVAILABLE_NOTICES, type PackItem, type SourcePack } from '../../lib/export';
import { formatDate, formatDateTime, plural } from '../../lib/format';
import { relationshipsForRecord } from '../../lib/relations';
import { buildHash, shareUrl } from '../../lib/router';
import { dataOf, useLoad } from '../../lib/useLoad';
import { A, Async, BackLink, Empty, ErrorHeading, ErrorNote, Loading } from '../../components/ui';
import { buildPlacePack, usePlaceData } from './placeData';

const SECTION_TITLES: Readonly<Record<PackItem['section'], string>> = {
  subject: 'Subject',
  population: 'Population',
  court_case: 'Court cases',
  court_document: 'Court documents',
  legislation: 'Legislation',
  text_version: 'Text versions',
  link: 'Links between records and their support',
  event: 'Dated events',
};
const ORDER: PackItem['section'][] = ['subject', 'population', 'court_document', 'court_case', 'legislation', 'text_version', 'link', 'event'];

/**
 * A hash is one 64-character word, and an address has no break point of its own: each goes in a span that may break
 * anywhere, so it never pushes the page sideways on a phone. An address in a detail is text, never a link.
 */
function DetailText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https:\/\/[^\s()"“”]*[^\s()"“”.,;:]|\b[0-9a-f]{32,}\b)/).map((part, i) => (
        i % 2 === 1 ? <span key={i} className={part.startsWith('https://') ? 'pack-url' : 'hash'}>{part}</span> : part
      ))}
    </>
  );
}

/** Longer texts (questions presented, population tables) are shortened on paper. */
const PRINT_LIMIT = 900;

/** Cut at a word boundary and say so, so a shortened text is never read as the whole of it. */
function Detail({ text }: { text: string }) {
  if (text.length <= PRINT_LIMIT) return <p className="pack-detail"><DetailText text={text} /></p>;
  const cut = text.slice(0, PRINT_LIMIT);
  const end = cut.lastIndexOf(' ');
  const kept = (end > PRINT_LIMIT / 2 ? cut.slice(0, end) : cut).replace(/[\s,;:]+$/, '');
  return (
    <p className="pack-detail">
      <DetailText text={`${kept} […]`} /> <span className="pack-shortened">[Shortened in this summary. The JSON and CSV downloads carry the full text.]</span>
    </p>
  );
}

function PackDocument({ pack, backHash, sectionNotes = {} }: { pack: SourcePack; backHash: string; sectionNotes?: Partial<Record<PackItem['section'], ReactNode>> }) {
  return (
    <article className="view view-wide view-doc pack">
      <div className="no-print">
        <BackLink to={backHash}>Back</BackLink>
        <p><button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button></p>
      </div>
      <header className="view-head">
        <p className="pack-kicker">DemocracyHQ legal source pack</p>
        <h1 tabIndex={-1}>{pack.subject.label}</h1>
        <p className="quiet">Generated {formatDateTime(pack.generatedAt)} from <span className="pack-link">{pack.subject.url}</span>{pack.dataRelease ? `. Data release of ${formatDate(pack.dataRelease.generatedAt)}.` : '.'}</p>
        {pack.notices.map((notice, i) => <p key={i} className="pack-notice">{notice}</p>)}
      </header>
      {ORDER.map((section) => {
        const items = pack.items.filter((item) => item.section === section);
        if (items.length === 0) return null;
        return (
          <section key={section} className="section">
            <h2>{SECTION_TITLES[section]} ({items.length})</h2>
            {sectionNotes[section] ? <p className="pack-section-note">{sectionNotes[section]}</p> : null}
            <ol className="pack-items">
              {items.map((item) => (
                <li key={`${item.section}:${item.id}`}>
                  <p className="pack-title">{item.title}</p>
                  {item.date ? <p>{formatDate(item.date)} <span className="quiet">({item.dateMeaning})</span></p> : null}
                  {item.detail ? <Detail text={item.detail} /> : null}
                  {item.documentAvailability === 'unavailable' && item.documentAvailabilityNote ? (
                    <p className="pack-detail">Document unavailable: <DetailText text={item.documentAvailabilityNote} /></p>
                  ) : null}
                  <p className="quiet">
                    {item.sourceUrl ? <>Source{item.pageUrl ? ' checked' : ''}: {item.sourceName ? `${item.sourceName}, ` : ''}<span className="pack-url">{item.sourceUrl}</span>. </> : null}
                    {item.pageUrl ? <>Page on the Legislature&rsquo;s site, built from the bill identifier and not machine-checked: <span className="pack-url">{item.pageUrl}</span>. </> : null}
                    {item.lastCheckedAt ? <>Last checked {formatDateTime(item.lastCheckedAt)}. </> : null}
                    {item.verificationLabel ? <>{item.verificationLabel}{item.verificationMethod ? ` (${item.verificationMethod})` : ''}. </> : null}
                    {item.verificationNote ? <>{item.verificationNote}</> : null}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      <section className="section">
        <h2>Sources and reuse terms</h2>
        {pack.sources.length > 0 ? (
          <ul className="pack-items">
            {pack.sources.map((source) => (
              <li key={source.id}>
                <p className="pack-title">{source.name}</p>
                <p className="quiet"><span className="pack-url">{source.url}</span>. {source.license} Last successful check {formatDateTime(source.lastSuccessfulCheck)}.</p>
              </li>
            ))}
          </ul>
        ) : (
          // An empty heading would read as "no sources". Say why there is no list.
          <p className="pack-section-note">
            {pack.notices.includes(UNAVAILABLE_NOTICES.sources)
              ? UNAVAILABLE_NOTICES.sources
              : 'No entry in the list of sources (sources.json) matches these records. Each entry above carries its own source link where the record has one.'}
          </p>
        )}
      </section>
    </article>
  );
}

function PlacePack({ placeKey }: { placeKey: string }) {
  const core = useCore();
  const state = usePlaceData(placeKey);
  const waiting = <article className="view view-wide"><Loading what="the source pack" /></article>;
  if (state.status === 'loading') return waiting;
  if (state.status === 'error') return <article className="view view-wide"><ErrorHeading error={state.error} noun="Source pack" /><ErrorNote error={state.error} what="the place index" /></article>;
  if (state.status === 'missing') return <NotFound />;
  if (core.sources.status === 'loading') return waiting;
  // Waits for every file the pack lists; one that failed is named in the pack's notices.
  const pack = buildPlacePack(state.data, { now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources) });
  if (!pack) return waiting;
  return <PackDocument pack={pack} backHash={buildHash(['place', placeKey], { tab: 'sources' })} />;
}

/** The print view waits for the files the pack draws on; one that failed is named in the pack's notices, never left out silently. */
function CasePack({ id }: { id: string }) {
  const core = useCore();
  const record = useLoad(`case:${id}`, () => loadCase(id));
  if (core.relationships.status === 'loading' || core.sources.status === 'loading') return <Loading what="the source pack" />;
  const relationships = core.relationships.status === 'ready' ? relationshipsForRecord('case', id, core.relationships.data) : null;
  return (
    <Async of={record} what="the source pack" heading="Source pack">
      {(data) => {
        const key = data.events.filter((e) => e.significance === 'major').length;
        return (
          <PackDocument
            backHash={buildHash(['litigation', id])}
            pack={packForCase({
              record: data, relationships, majorOnly: true, now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
              nameOf: entityNamer({ geo: dataOf(core.geo), bills: dataOf(core.bills)?.bills, cases: dataOf(core.cases) }),
            })}
            sectionNotes={key < data.events.length ? {
              event: <>Key entries only: {key} of {plural(data.events.length, 'docket entry', 'docket entries')}, selected by the published rules listed under <A to={buildHash(['sources'], { section: 'rules' })}>Data and methodology</A>. The JSON and CSV downloads on the case page contain all entries.</>,
            } : {}}
          />
        );
      }}
    </Async>
  );
}

function BillPack({ id }: { id: string }) {
  const core = useCore();
  const record = useLoad(`bill:${id}`, () => loadBill(id));
  if (core.relationships.status === 'loading' || core.cases.status === 'loading' || core.sources.status === 'loading') return <Loading what="the source pack" />;
  const relationships = core.relationships.status === 'ready' ? relationshipsForRecord('bill', id, core.relationships.data) : null;
  const cases = dataOf(core.cases);
  return (
    <Async of={record} what="the source pack" heading="Source pack">
      {(data) => {
        const linkedCases = cases && relationships
          ? relationships.map((r) => cases.find((c) => c.id === (r.source.type === 'case' ? r.source.id : r.target.type === 'case' ? r.target.id : ''))).filter((c): c is NonNullable<typeof c> => Boolean(c))
          : null;
        return (
          <PackDocument
            backHash={buildHash(['laws', id])}
            pack={packForBill({
              record: data, relationships, linkedCases, now: new Date().toISOString(), link: shareUrl, manifest: dataOf(core.manifest), sources: dataOf(core.sources),
              nameOf: entityNamer({ geo: dataOf(core.geo), bills: dataOf(core.bills)?.bills, cases }),
            })}
          />
        );
      }}
    </Async>
  );
}

function NotFound() {
  return (
    <article className="view view-wide">
      <header className="view-head"><h1 tabIndex={-1}>Source pack not found</h1></header>
      <Empty title="That source pack does not exist.">
        <p><A to={buildHash([])}>Back to the map</A></p>
      </Empty>
    </article>
  );
}

export function PackView({ kind, id }: { kind: string | undefined; id: string | undefined }) {
  if (!id) return <NotFound />;
  if (kind === 'place') return <PlacePack placeKey={id} />;
  if (kind === 'case') return <article className="view-wrap"><CasePack id={id} /></article>;
  if (kind === 'bill') return <article className="view-wrap"><BillPack id={id} /></article>;
  return <NotFound />;
}
