/**
 * Legal Source Pack: a portable list of the records behind a place, case or
 * bill, each with its source link, the dates involved and its verification
 * state. Built entirely from data already on the page; nothing is fetched or
 * generated at export time.
 */
import type {
  CourtDocument, EntityRef, EntityRelationship, ExpiryClause, LegalCase, LegalCaseSummary, LegislativeInstrument, LegislativeInstrumentSummary, Manifest,
  SourceRecord, TimelineEvent, Verification, VerificationStatus,
} from '../types/schemas';
import { differentSubject, earlierSubject, earlierSubjectNote } from './billHistory';
import { FEDERAL_TEXT_SOURCE_ID, billLabel, billLabelFromId, isAdoptedMeasure, isFederalBill, statusNoun } from './bills';
import { passageDeadlineNote, pendingAfterDeadline } from './caSession';
import { SCOTUS_ID, caseCourtCitation, recordBasis } from './courts';
import type { GeoIndex, GeoUnit } from './geo';
import { isCensusLayer, stateKind, unitNoun } from './geo';
import { relationshipLabel, reverseRelationshipLabel } from './labels';
import type { LinkedRecord } from './relations';
import { sameWords } from './relations';
import type { PopulationResult } from './population';
import { GROUP_KEYS, GROUP_LABELS } from './population';
import { METHOD_LABELS, VERIFICATION_LABELS } from './verification';

export const PACK_FORMAT = 'democracyhq-legal-source-pack';
export const PACK_VERSION = 1;

export const DISCLAIMER =
  'DemocracyHQ is a research and educational tool. It is not legal advice and it is not an official government source. ' +
  'Always confirm against the linked primary source before relying on a record.';
export const GAP_NOTICE = 'Coverage is incomplete. A data gap is not evidence of absence.';

/** Said in a pack when a file it draws on could not be loaded, so a missing section is never read as "none". */
export const UNAVAILABLE_NOTICES = {
  links: 'The links between records (relationships.json) could not be loaded, so this pack lists no links to places, cases or other measures. That says nothing about whether such links exist.',
  cases: 'The court case indexes (litigation/index.json and circuits/index.json) could not be loaded, so this pack lists no court cases. That says nothing about whether any are linked.',
  bills: 'The legislation indexes (legislation/index.json, congress/index.json and, for a place in a state, state-legislation/index.json) could not be loaded, so this pack lists no legislation. That says nothing about whether any exists.',
  events: 'The timeline (events.json) could not be loaded, so this pack lists no dated events. That says nothing about whether any exist.',
  caseRecords: 'The court case indexes (litigation/index.json and circuits/index.json) could not be loaded, so linked court cases appear only as links, without their case records.',
  /** For a place: a case is linked to a place only through a link. Appeals that began in the state come from the case index and are still listed. */
  placeLinks: 'The links between records (relationships.json) could not be loaded, so this pack lists no court cases linked to this place. Appeals listed because they began in a federal district court here do not depend on that file. That says nothing about whether any case is linked.',
  population: 'The population counts could not be loaded, so this pack lists none.',
  sources: 'The list of sources (sources.json) could not be loaded, so this pack does not name the sources or give their reuse terms. Each entry still carries its own source link where the record has one.',
} as const;

/** A sentence in a note that says whether a condition was met is not recorded ("… whether they were met is not recorded here."). */
const MET_NOT_RECORDED = /\bwhether\b[^.]*\b(?:was|were)\s+met\b[^.]*\bnot recorded\b|\bnot record whether\b/i;

/**
 * The bill notes and the curated condition notes each repeat that whether a condition was met is not recorded.
 * Where conditions are listed, the page and the pack drop those sentences and say it once with `metCaveat`.
 */
export function withoutMetCaveat(text: string): string {
  return text.split(/(?<=\.)\s+/).filter((sentence) => !MET_NOT_RECORDED.test(sentence)).join(' ');
}

export function metCaveat(conditions: number): string {
  return conditions === 1 ? 'Whether this condition was met is not recorded in this dataset.' : 'Whether these conditions were met is not recorded in this dataset.';
}

/** Said wherever whether a measure takes effect turns on a vote of the people, which this dataset does not record. */
export const BALLOT_RESULTS_NOTE =
  'DemocracyHQ does not track ballot or election results. Check the official results: the California Secretary of State’s Statement of Vote.';

/**
 * Whether a measure's taking effect turns on a ballot outcome: a constitutional amendment the Legislature adopted and
 * filed (it takes effect only if the voters approve it), or a condition whose text or note mentions the voters or a ballot.
 */
export function turnsOnBallot(bill: Pick<LegislativeInstrument, 'measureType' | 'chapteredDate'>, conditionTexts: readonly (string | null | undefined)[]): boolean {
  if (/Constitutional Amendment/.test(bill.measureType) && bill.chapteredDate) return true;
  return conditionTexts.some((text) => Boolean(text) && /\bvoters?\b|\bballots?\b|\belectorate\b/i.test(text!));
}

/**
 * What an expiry clause applies to. The clause repeals the provision its sentence names, which may be only part of the
 * measure, and a measure that was not enacted (or adopted) repeals nothing.
 */
export function expiryScope(inForce: boolean, adopted = false): string {
  return inForce
    ? 'It applies to the provision that sentence names, which may be only part of the measure.'
    : `It applies to the provision that sentence names, and would apply only if this measure were ${adopted ? 'adopted' : 'enacted'}.`;
}

/** The pack's account of one expiry clause, quoted with its rule and version. */
function expiryText(clause: ExpiryClause, versionLabel: string, inForce: boolean, adopted: boolean): string {
  return ` Expiry stated in the text${clause.date ? ` (${clause.date})` : ''}, found by rule ${clause.ruleId} in version ${versionLabel}: “${clause.text}” ${expiryScope(inForce, adopted)}`;
}

export type PackSection = 'subject' | 'court_case' | 'court_document' | 'legislation' | 'text_version' | 'population' | 'event' | 'link';

export interface PackItem {
  section: PackSection;
  id: string;
  title: string;
  /** The date the thing happened, as stated by the source. */
  date: string | null;
  /** What `date` means, e.g. "Latest docket activity reported by the court". */
  dateMeaning: string | null;
  detail: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  lastCheckedAt: string | null;
  verification: VerificationStatus | null;
  verificationLabel: string | null;
  appUrl: string | null;
  /** How the record was checked, in words (METHOD_LABELS). */
  verificationMethod: string | null;
  /** The record's own caveat about that check, for example that a link's check does not test its description. */
  verificationNote: string | null;
  /** For a court docket entry with a filed document: whether that document's link works (public_link, restricted or unavailable). */
  documentAvailability: CourtDocument['availability'] | null;
  /** Why a document is unavailable, with the address the court gives as text: it is never exported as a working link. */
  documentAvailabilityNote: string | null;
  /**
   * A page on the legislature's own site: for California built from the bill identifier, for Congress the page on
   * congress.gov. It is not machine-checked; the record was checked against the official data named in sourceName and
   * sourceUrl.
   */
  pageUrl: string | null;
}

export interface SourcePack {
  format: typeof PACK_FORMAT;
  formatVersion: typeof PACK_VERSION;
  generatedAt: string;
  subject: { type: 'place' | 'case' | 'bill'; id: string; label: string; url: string };
  dataRelease: { generatedAt: string; schemaVersion: number } | null;
  notices: string[];
  items: PackItem[];
  sources: Array<{ id: string; name: string; url: string; license: string; attribution: string; lastSuccessfulCheck: string | null }>;
}

interface BaseInput {
  now: string;
  /** Maps a hash route to an absolute URL. */
  link: (hash: string) => string;
  manifest: Manifest | null;
  /** The source list, or null when sources.json could not be loaded (the pack then says so). */
  sources: readonly SourceRecord[] | null;
  /**
   * The name of a place, case or bill a link points to (see `entityNamer`). Without it a bill is named from its id and
   * a place or case by its key.
   */
  nameOf?: (ref: EntityRef) => string | null | undefined;
}

function item(partial: Partial<PackItem> & Pick<PackItem, 'section' | 'id' | 'title'>): PackItem {
  const verification = partial.verification ?? null;
  return {
    date: null, dateMeaning: null, detail: null, sourceName: null, sourceUrl: null, lastCheckedAt: null, appUrl: null,
    verificationMethod: null, verificationNote: null, documentAvailability: null, documentAvailabilityNote: null, pageUrl: null,
    ...partial,
    verification,
    verificationLabel: partial.verificationLabel ?? (verification ? VERIFICATION_LABELS[verification] : null),
  };
}

/** The verification fields of a record or link: its state, how it was checked, and its own caveat. */
function checked(v: Verification, method: string = v.method): Pick<PackItem, 'verification' | 'verificationMethod' | 'verificationNote'> {
  return { verification: v.status, verificationMethod: METHOD_LABELS[method] ?? method, verificationNote: v.note ?? null };
}

function sourceName(sources: readonly SourceRecord[] | null, id: string | null | undefined): string | null {
  return sources?.find((s) => s.id === id)?.name ?? null;
}

/** Pages on leginfo.legislature.ca.gov are built from identifiers and never fetched: the site blocks automated requests. */
const CA_PAGE = /^https:\/\/leginfo\.legislature\.ca\.gov\//;
/** Pages on congress.gov are linked at the address the status record gives, or built from the measure's number, and are not fetched. */
const CONGRESS_PAGE = /^https:\/\/www\.congress\.gov\//;
/** A page of a legislature's own site that the pipeline does not fetch. The record behind it is checked in the official data. */
const UNCHECKED_PAGE = { test: (url: string) => CA_PAGE.test(url) || CONGRESS_PAGE.test(url) };

/** The official bulk archive that California records are read from. */
const CA_BULK_ARCHIVE = /^https:\/\/downloads\.leginfo\.legislature\.ca\.gov\//;
/** The bill status data that the records of the measures of Congress are read from. */
const US_STATUS_DATA = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\//;

/**
 * Where a legislative record was checked. A California record is read from the official bulk archive, and a measure of
 * Congress from the bill status data on GovInfo, so the pack names that data as the source and gives the record's page
 * on the legislature's own site separately, as not machine-checked. `recordUrl` is the record's own file in that data,
 * when the record gives it. When the record names no source, the data is found in the source list; when the source
 * list could not be loaded either, the page itself is the only address the pack has, and it is still marked as not
 * machine-checked in pageUrl.
 */
function legislatureSource(base: BaseInput, sourceId: string | null | undefined, url: string, recordUrl?: string | null): Pick<PackItem, 'sourceName' | 'sourceUrl' | 'pageUrl'> {
  const named = base.sources?.find((s) => s.id === sourceId);
  if (!UNCHECKED_PAGE.test(url)) return { sourceName: named?.name ?? null, sourceUrl: url, pageUrl: null };
  const data = CA_PAGE.test(url) ? CA_BULK_ARCHIVE : US_STATUS_DATA;
  const source = named ?? base.sources?.find((s) => data.test(s.url));
  return { sourceName: source?.name ?? null, sourceUrl: recordUrl ?? source?.url ?? url, pageUrl: url };
}

/** Names places, cases and bills from the files the page has loaded, for link titles in a pack. */
export function entityNamer(files: {
  geo?: Pick<GeoIndex, 'get'> | null;
  bills?: readonly LegislativeInstrumentSummary[] | null;
  cases?: readonly LegalCaseSummary[] | null;
}): (ref: EntityRef) => string | null {
  return (ref) => {
    if (ref.type === 'geography') return files.geo?.get(ref.id)?.name ?? null;
    if (ref.type === 'bill') {
      const bill = files.bills?.find((b) => b.id === ref.id);
      return bill ? billLabel(bill) : null;
    }
    const found = files.cases?.find((c) => c.id === ref.id);
    // A docket number of any court but the Supreme Court is only unique within its court, so the court is named with it.
    return found ? `${found.caseName}, No. ${found.docketNumber}${found.courtId === SCOTUS_ID ? '' : ` (${caseCourtCitation(found)})`}` : null;
  };
}

function refName(ref: EntityRef, base: BaseInput): string {
  return base.nameOf?.(ref) ?? (ref.type === 'bill' ? billLabelFromId(ref.id) : null) ?? `${ref.type === 'geography' ? 'place' : ref.type} ${ref.id}`;
}

/** "Concerns a congressional district plan of Louisiana", read from the end of the link the pack is about. */
function linkTitle(r: EntityRelationship, self: EntityRef, base: BaseInput): string {
  const outgoing = r.source.type === self.type && r.source.id === self.id;
  const other = outgoing ? r.target : r.source;
  const label = outgoing ? relationshipLabel(r.relationshipType) : reverseRelationshipLabel(r.relationshipType);
  return `${label} ${refName(other, base)}`;
}

function packSources(sources: readonly SourceRecord[] | null, ids: Iterable<string | null | undefined>): SourcePack['sources'] {
  const wanted = new Set([...ids].filter((id): id is string => Boolean(id)));
  return (sources ?? [])
    .filter((s) => wanted.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, url: s.url, license: s.license, attribution: s.attribution, lastSuccessfulCheck: s.lastSuccessfulCheck ?? null }));
}

/**
 * A case as a pack lists it. For a Supreme Court docket the record is the Court's docket. For a court of appeals case
 * it is the documents GovInfo holds for the case, which is not the court's full docket. For a case of a district court
 * or a state court it is the decisions CourtListener holds, which is not a court's record at all. The wording keeps
 * the three apart.
 */
function caseItem(c: LegalCaseSummary, base: BaseInput, detailPrefix = ''): PackItem {
  const basis = recordBasis(c);
  const appeal = basis === 'govinfo';
  const entry = c.latestDispositiveEntry;
  let ruling: string;
  if (basis === 'courtlistener') {
    ruling = entry
      ? `Latest opinion of the court among the decisions CourtListener holds for the case (${entry.date}): ${entry.text}.`
      : 'No opinion of the court among the documents CourtListener holds for the case.';
    ruling += ` Read from CourtListener’s copy, not from the court${c.court ? ` (${c.court.name})` : ''}. CourtListener does not hold every decision, and whether this one was later reheard, vacated, appealed or reviewed is not recorded.`;
  } else if (appeal) {
    ruling = entry
      ? `Latest decision among the documents GovInfo holds for the case (${entry.date}): ${entry.text}`
      : 'No decision identified among the documents GovInfo holds for the case by DemocracyHQ’s rules.';
    if (c.publication) ruling += ` The court’s entry marks it as ${c.publication.toLowerCase()}.`;
    if (c.origin) ruling += ` Where the case came from, in the opinion’s words: “${c.origin.quote}” That says where the case began, not what it concerns.`;
    if (c.decidedWith.length > 0) ruling += ` Decided in the same opinion as ${c.decidedWith.map((other) => `No. ${other.docket}`).join(', ')} (rule same-opinion-1).`;
    ruling += ' Whether the decision was later reheard, vacated or reviewed is not recorded.';
  } else {
    ruling = entry ? `Latest ruling entry on the docket (${entry.date}): ${entry.text}` : 'No ruling entry identified on the docket by DemocracyHQ’s rules.';
  }
  return item({
    section: 'court_case', id: c.id, title: `${c.caseName}, No. ${c.docketNumber} (${caseCourtCitation(c)})`,
    date: c.sourceLastActivity ?? null,
    dateMeaning: basis === 'courtlistener' ? 'Date of the latest decision CourtListener holds for the case' : appeal ? 'Date of the latest document GovInfo holds for the case' : 'Latest docket activity reported by the court',
    detail: `${detailPrefix}${ruling}`, sourceName: sourceName(base.sources, c.sourceId), sourceUrl: c.sourceUrl,
    lastCheckedAt: c.lastCheckedAt, ...checked(c.verification), appUrl: base.link(`#/litigation/${c.id}`),
  });
}

function billItem(b: LegislativeInstrumentSummary, base: BaseInput, recordUrl?: string | null): PackItem {
  const federal = isFederalBill(b);
  const status = b.legislativeStatus.currentStatus ?? 'not recorded';
  const textState = b.legislativeStatus.measureState && b.legislativeStatus.measureState !== status ? ` Latest text version: ${b.legislativeStatus.measureState}.` : '';
  // A bill still in committee or on the floor after the last day to pass bills is not a live bill in the usual sense.
  const asOf = base.manifest?.generatedAt ?? b.lastCheckedAt;
  const deadline = pendingAfterDeadline(b, asOf) ? ` ${passageDeadlineNote(asOf)}` : '';
  // Congress's record has no status of its own: the stage is the furthest step among the recorded actions.
  const statusLine = federal ? `${statusNoun(b)} (worked out by rule us-status-1, not an official status): ${status}.` : `${statusNoun(b)}: ${status}.`;
  return item({
    section: 'legislation', id: b.id, title: `${billLabel(b)} (${b.session}): ${b.subject ?? b.title ?? 'no subject recorded'}`,
    date: b.lastActionDate ?? null, dateMeaning: federal ? 'Latest action in the official record of the measure' : 'Latest legislative action reported by the legislature',
    detail: `${statusLine}${b.chapter?.citation ? ` ${b.chapter.citation}.` : ''}${textState} Last action: ${b.lastActionText ?? 'not recorded'}${deadline}`,
    ...legislatureSource(base, b.sourceId, b.officialUrl, recordUrl), lastCheckedAt: b.lastCheckedAt,
    ...checked(b.verification), appUrl: base.link(`#/laws/${b.id}`),
  });
}

/**
 * A timeline event. For a bill's action, `bill` is the bill's index entry: it gives the source the action was read from
 * and the current subject line, so that an action taken under another subject says so, as on the bill page.
 */
function eventItem(e: TimelineEvent, base: BaseInput, bill?: LegislativeInstrumentSummary | null): PackItem {
  const earlier = bill ? differentSubject(e.subjectInForce, bill.subject) : null;
  return item({
    section: 'event', id: e.id, title: e.entityLabel, date: e.date, dateMeaning: `Event date (${e.category}, ${e.eventType.replace(/_/g, ' ')})`,
    detail: `${e.description}${earlier ? ` ${earlierSubjectNote(earlier)}` : ''}`, ...legislatureSource(base, bill?.sourceId, e.sourceUrl),
    appUrl: e.entityType === 'case' ? base.link(`#/litigation/${e.entityId}`) : e.entityType === 'bill' ? base.link(`#/laws/${e.entityId}`) : base.link(`#/place/${e.entityId}`),
  });
}

/**
 * A link and the passage that supports it. The method and the link's own note travel with it: a curated link's check
 * finds the quoted passage in the cited document and does not test the maintainer's description.
 */
function relationshipItem(r: EntityRelationship, label: string, base: BaseInput, textSourceId?: string | null): PackItem {
  // Releases made before "maintainer_curated" existed give a curated link the method "rule_derived"; its label would
  // contradict the link's own note that a maintainer wrote it.
  const method = r.basis === 'curated' && r.verification.method === 'rule_derived' ? 'maintainer_curated' : r.verification.method;
  return item({
    section: 'link', id: r.id, title: label,
    detail: `${r.scope.note ? `${r.scope.note} ` : ''}Supporting text${r.support.document ? ` (${r.support.document})` : ''}: “${r.support.quote ?? ''}”`,
    // A passage of bill text is checked in the text mirrored from the bulk data, so the bill's source is named for it.
    ...(UNCHECKED_PAGE.test(r.support.url)
      ? legislatureSource(base, r.support.sourceId ?? textSourceId, r.support.url)
      : { sourceName: sourceName(base.sources, r.support.sourceId), sourceUrl: r.support.url, pageUrl: null }),
    lastCheckedAt: r.verification.checkedAt, ...checked(r.verification, method),
  });
}

function finish(subject: SourcePack['subject'], items: PackItem[], base: BaseInput, sourceIds: Iterable<string | null | undefined>, extraNotices: string[] = []): SourcePack {
  return {
    format: PACK_FORMAT, formatVersion: PACK_VERSION, generatedAt: base.now, subject,
    dataRelease: base.manifest ? { generatedAt: base.manifest.generatedAt, schemaVersion: base.manifest.schemaVersion } : null,
    notices: [DISCLAIMER, GAP_NOTICE, ...extraNotices, ...(base.sources ? [] : [UNAVAILABLE_NOTICES.sources])],
    items, sources: packSources(base.sources, sourceIds),
  };
}

export interface PlacePackInput extends BaseInput {
  unit: GeoUnit;
  vintage: string;
  geoSourceId: string;
  /** Null when the files they come from could not be loaded; the pack then says so. */
  cases: readonly LinkedRecord<LegalCaseSummary>[] | null;
  /**
   * For a state or territory: the court of appeals cases that began in a federal district court there (rule
   * origin-court-1). They are listed with the opinion's own words for the court below, and with the caveat that where a
   * case began is not what it concerns. Null when the case indexes could not be loaded.
   */
  appealsFrom?: readonly LegalCaseSummary[] | null;
  /**
   * What the pack says when `cases` is null. The cases need two files, the case index and the links; the notice names
   * the one that failed (the case index notice when not given).
   */
  casesNotice?: string;
  bills: readonly LegislativeInstrumentSummary[] | null;
  events: readonly TimelineEvent[] | null;
  population: PopulationResult | null;
  billCoverageNote: string | null;
  /** Further notices, such as a file that could not be loaded. */
  extraNotices?: readonly string[];
}

export function packForPlace(input: PlacePackInput): SourcePack {
  const { unit } = input;
  const items: PackItem[] = [
    item({
      section: 'subject', id: unit.key, title: unit.name,
      // The United States and the circuits are not Census units: they have no GEOID, and their outline is made from the states'.
      detail: isCensusLayer(unit.layer) ? `${unitNoun(unit)}. Census GEOID ${unit.geoid}. Boundary vintage: ${input.vintage}.` : `${unitNoun(unit)}. Outline on the map: ${input.vintage}.`,
      sourceName: sourceName(input.sources, input.geoSourceId), sourceUrl: input.sources?.find((s) => s.id === input.geoSourceId)?.url ?? null,
      lastCheckedAt: input.sources?.find((s) => s.id === input.geoSourceId)?.lastSuccessfulCheck ?? null,
      verification: 'verified_primary', appUrl: input.link(`#/place/${unit.key}`),
    }),
  ];
  const sourceIds: Array<string | null | undefined> = [input.geoSourceId];
  if (input.population?.status === 'available') {
    const p = input.population;
    // Exported counts carry the Bureau's own variable labels and codes, so a race group is never cited without "not Hispanic or Latino".
    const labelled = (key: string) => {
      const variable = p.variables.find((v) => v.key === key);
      return `${variable?.label ?? GROUP_LABELS[key as keyof typeof GROUP_LABELS] ?? key}${variable ? ` (${variable.code})` : ''}: ${p.values[key] ?? 'n/a'}`;
    };
    const groups = GROUP_KEYS.map((key) => labelled(key)).join('; ');
    const adultGroups = GROUP_KEYS.map((key) => labelled(`vap_${key}`)).join('; ');
    items.push(item({
      section: 'population', id: `${unit.key}:population`, title: `${p.dataset.title} (tables ${p.dataset.tables})`,
      date: `${p.dataset.censusYear}-04-01`, dateMeaning: 'Census Day (reference date of the counts)',
      detail: `${labelled('total')}. ${labelled('vap_total')}. ${groups}. ${adultGroups}. ${p.dataset.methodology}${p.note ? ` Note: ${p.note}` : ''}`,
      sourceName: sourceName(input.sources, p.dataset.sourceId), sourceUrl: input.sources?.find((s) => s.id === p.dataset.sourceId)?.url ?? null,
      lastCheckedAt: input.sources?.find((s) => s.id === p.dataset.sourceId)?.lastSuccessfulCheck ?? null, verification: 'verified_primary',
    }));
    sourceIds.push(p.dataset.sourceId);
  } else if (input.population) {
    items.push(item({ section: 'population', id: `${unit.key}:population`, title: 'Population counts', detail: `Unavailable. ${input.population.reason}`, verification: 'unavailable' }));
  }
  const kind = stateKind(unit.stateFips).toLowerCase();
  const unavailable: string[] = [];
  if (!input.cases) unavailable.push(input.casesNotice ?? UNAVAILABLE_NOTICES.cases);
  if (!input.bills) unavailable.push(UNAVAILABLE_NOTICES.bills);
  if (!input.events) unavailable.push(UNAVAILABLE_NOTICES.events);
  // The place itself is always named, even without a name resolver.
  const named: BaseInput = { ...input, nameOf: (ref) => input.nameOf?.(ref) ?? (ref.type === 'geography' && ref.id === unit.key ? unit.name : null) };
  for (const linked of input.cases ?? []) {
    const prefix = linked.via === 'statewide' ? `Linked to the whole ${kind}, not specifically to this unit. ` : linked.via === 'within' ? `Linked to a unit inside this ${kind}. ` : '';
    items.push(caseItem(linked.record, input, prefix));
    const r = linked.relationship;
    const other = r.source.type === 'case' && r.source.id === linked.record.id ? r.target : r.source;
    items.push(relationshipItem(r, `Why ${linked.record.caseName} is linked to ${refName(other, named)}`, input));
    sourceIds.push(linked.record.sourceId);
  }
  for (const record of input.appealsFrom ?? []) {
    items.push(caseItem(record, input, `Listed here because the appeal began in a federal district court in ${unit.name}, as the opinion names the court below (rule origin-court-1). `));
    sourceIds.push(record.sourceId);
  }
  for (const bill of input.bills ?? []) {
    items.push(billItem(bill, input));
    sourceIds.push(bill.sourceId);
  }
  const billsById = new Map((input.bills ?? []).map((b) => [b.id, b]));
  for (const event of input.events ?? []) items.push(eventItem(event, input, event.entityType === 'bill' ? billsById.get(event.entityId) : null));
  return finish(
    { type: 'place', id: unit.key, label: unit.name, url: input.link(`#/place/${unit.key}`) }, items, input, sourceIds,
    [...(input.billCoverageNote ? [input.billCoverageNote] : []), ...unavailable, ...(input.extraNotices ?? [])],
  );
}

export interface CasePackInput extends BaseInput {
  record: LegalCase;
  /** The case's links, or null when relationships.json could not be loaded (the pack then says so). */
  relationships: readonly EntityRelationship[] | null;
  majorOnly?: boolean;
}

/**
 * The document a docket entry links to in a pack. A document the court's link no longer serves (availability
 * "unavailable") is never given as the entry's source: the entry then points to the docket page, and the address the
 * docket gives is carried as text, with the note saying when it answered "not found".
 */
function entryDocument(docs: readonly (CourtDocument | undefined)[]): Pick<PackItem, 'documentAvailability' | 'documentAvailabilityNote'> & { url: string | null } {
  const linked = docs.filter((d): d is CourtDocument => Boolean(d?.url));
  const working = linked.find((d) => d.availability !== 'unavailable');
  const dead = linked.filter((d) => d.availability === 'unavailable');
  const note = dead.length > 0
    ? dead.map((d) => `${d.title}: ${d.url}. ${d.accessNote ?? 'The court’s docket gives this address, which is marked unavailable in the data; no note was recorded.'}`).join(' ')
    : null;
  if (working) return { url: working.url ?? null, documentAvailability: working.availability, documentAvailabilityNote: note };
  return { url: null, documentAvailability: dead.length > 0 ? 'unavailable' : null, documentAvailabilityNote: note };
}

/**
 * Why a case that a selection rule picked is in the dataset, in one sentence: the tests of the rule it met and what
 * the rule counted in the document it rests on.
 */
export function selectionSentence(selection: NonNullable<LegalCase['selection']>): string {
  const parts: string[] = [];
  if (selection.tests.includes('record')) {
    parts.push(`the court’s record gives it the nature of suit ${[selection.natureOfSuitCode, selection.natureOfSuit].filter(Boolean).join(' ') || 'of a voting case'}`);
  }
  const text = selection.tests.filter((test) => test !== 'record');
  if (text.length > 0) {
    const counted = selection.wordCount
      ? `${selection.wordMatches ?? 0} election words and ${selection.phraseMatches ?? 0} election phrases in ${selection.wordCount} words`
      : 'election words and phrases';
    parts.push(`one of its documents meets the text ${text.length === 1 ? 'test' : 'tests'} ${text.map((test) => `“${test}”`).join(' and ')} (${counted}${selection.party ? `; election authority named: ${selection.party}` : ''})`);
  }
  return `Listed by rule ${selection.ruleId}: ${parts.join(', and ')}. The rule counts words; it does not say what the case decides.`;
}

export function packForCase(input: CasePackInput): SourcePack {
  const c = input.record;
  const basis = recordBasis(c);
  const appeal = basis === 'govinfo';
  const holder = basis === 'courtlistener' ? 'CourtListener' : 'GovInfo';
  const self: EntityRef = { type: 'case', id: c.id };
  const subject = caseItem(c, input);
  const items: PackItem[] = [{ ...subject, section: 'subject', detail: `${subject.detail ?? ''}${c.selection ? ` ${selectionSentence(c.selection)}` : ''}` }];
  if (c.questionsPresented) {
    items.push(item({
      section: 'court_document', id: `${c.id}:qp`, title: 'Questions presented (document published by the Court)',
      sourceUrl: c.questionsPresented.url, detail: c.questionsPresented.text ?? null, lastCheckedAt: c.lastCheckedAt, ...checked(c.verification),
    }));
  }
  for (const r of input.relationships ?? []) items.push(relationshipItem(r, linkTitle(r, self, input), input));
  const documents = new Map(c.documents.map((d) => [d.id, d]));
  for (const e of c.events) {
    if (input.majorOnly && e.significance !== 'major') continue;
    const doc = entryDocument(e.documentIds.map((id) => documents.get(id)));
    // For a court of appeals case an entry is one document GovInfo holds, with the court's own entry text for it.
    const cover = appeal ? e.documentIds.map((id) => documents.get(id)?.accessNote).find((note) => note && /letter/i.test(note)) : null;
    items.push(item({
      section: 'event', id: e.id, title: `${basis === 'docket' ? 'Docket entry' : `Document on ${holder}`}, ${e.eventType.replace(/_/g, ' ')}`, date: e.date,
      dateMeaning: basis === 'docket' ? 'Date of the docket entry' : `Date of the document as ${holder} gives it`,
      detail: cover ? `${e.description} ${cover}` : e.description, sourceUrl: doc.url ?? e.evidence.url, lastCheckedAt: c.lastCheckedAt, ...checked(c.verification),
      documentAvailability: doc.documentAvailability, documentAvailabilityNote: doc.documentAvailabilityNote,
    }));
  }
  return finish(
    { type: 'case', id: c.id, label: `${c.caseName}, No. ${c.docketNumber}${basis === 'docket' ? '' : ` (${caseCourtCitation(c)})`}`, url: input.link(`#/litigation/${c.id}`) }, items, input, [c.sourceId],
    [
      ...(appeal ? ['The dated entries are the documents GovInfo holds for this case, not the court’s full docket. Filings, orders and later history that GovInfo does not hold are not listed.'] : []),
      ...(basis === 'courtlistener' ? ['The dated entries are the decisions CourtListener holds for this case. CourtListener is a collection of the Free Law Project, not a court: the entries are not the court’s docket, and filings, orders and later history are not listed.'] : []),
      ...(input.relationships ? [] : [UNAVAILABLE_NOTICES.links]),
    ],
  );
}

export interface BillPackInput extends BaseInput {
  record: LegislativeInstrument;
  /** The bill's links, or null when relationships.json could not be loaded (the pack then says so). */
  relationships: readonly EntityRelationship[] | null;
  /** The linked cases, or null when the case index could not be loaded. */
  linkedCases: readonly LegalCaseSummary[] | null;
}

export function packForBill(input: BillPackInput): SourcePack {
  const b = input.record;
  const federal = isFederalBill(b);
  const self: EntityRef = { type: 'bill', id: b.id };
  // Every row taken from the bill's record was checked against the official data, not against the page on the legislature's site.
  const fromRecord = (url: string, sourceId: string = b.sourceId) => ({ ...legislatureSource(input, sourceId, url, b.sourceRecordUrl), lastCheckedAt: b.lastCheckedAt, ...checked(b.verification) });
  const items: PackItem[] = [{ ...billItem(b, input, b.sourceRecordUrl), section: 'subject' }];
  const dated: Array<[string | null | undefined, string]> = federal
    ? [[b.introducedDate, 'Introduced'], [b.approvedDate, 'Signed by the President'], [b.chapteredDate, `Became law${b.chapter?.citation ? ` (${b.chapter.citation})` : ''}`], [b.vetoedDate, 'Vetoed by the President']]
    : [[b.introducedDate, 'Introduced'], [b.approvedDate, 'Approved by the Governor'], [b.chapteredDate, 'Chaptered by the Secretary of State'], [b.vetoedDate, 'Vetoed']];
  for (const [date, label] of dated) {
    if (date) items.push(item({ section: 'event', id: `${b.id}:${label}`, title: label, date, dateMeaning: 'Date of the legislative action', ...fromRecord(b.officialUrl) }));
  }
  // A condition in the text travels with the date, so an exported row never reads as an unconditional effective date.
  // As on the page, a condition found by rule that a curated link already quotes is listed once, and "not recorded" is said once.
  const links = input.relationships ?? [];
  const curatedLinks = links.filter((r) => /^operative_only_if/.test(r.relationshipType) && r.source.type === 'bill' && r.source.id === b.id);
  const curated = curatedLinks.map((r) => ` Condition stated in the bill text: ${withoutMetCaveat(r.scope.note ?? `Operative only if ${r.target.id} takes effect.`)}${r.support.quote ? ` The text reads: “${r.support.quote}”` : ''}`);
  const found = b.conditions
    .filter((c) => !curatedLinks.some((r) => r.support.quote && sameWords(r.support.quote, c.text)))
    .map((c) => ` Condition found in the text (rule ${c.ruleId}, version ${c.versionId}): “${c.text}”`);
  const conditions = [...curated, ...found];
  const inForce = Boolean(b.chapteredDate || b.approvedDate);
  const adopted = b.chapter?.type === 'CHR' || isAdoptedMeasure(b);
  const versionLabel = (id: string) => b.versions.find((v) => v.id === id)?.label ?? id;
  const expiries = b.expiryClauses.map((c) => expiryText(c, versionLabel(c.versionId), inForce, adopted)).join('');
  // The note names California's official results; nothing in Congress turns on a ballot measure.
  const ballot = !federal && turnsOnBallot(b, [...curatedLinks.flatMap((r) => [r.scope.note, r.support.quote]), ...b.conditions.map((c) => c.text)]) ? ` ${BALLOT_RESULTS_NOTE}` : '';
  const derived = b.effective.basis === 'immediate_effect_flag';
  items.push(item({
    section: 'legislation', id: `${b.id}:effective`, title: 'Effective date', date: b.effective.date ?? null,
    dateMeaning: b.effective.date ? `Effective date (basis: ${b.effective.basis.replace(/_/g, ' ')})` : null,
    detail: `${conditions.length > 0 ? `${withoutMetCaveat(b.effective.note)}${conditions.join('')} ${metCaveat(conditions.length)}` : b.effective.note}${expiries}${ballot}`,
    ...legislatureSource(input, b.sourceId, b.officialUrl, b.sourceRecordUrl),
    // A date derived by rule is not a date the source states, so it does not carry the record's verification label.
    verification: derived ? null : b.effective.basis === 'not_verified' ? 'unavailable' : null,
    verificationLabel: derived ? 'Derived by rule from official data' : b.effective.basis === 'not_verified' ? null : 'Not applicable',
  }));
  items.push(item({ section: 'legislation', id: `${b.id}:courts`, title: 'Judicial enforceability', detail: b.judicialNote }));
  for (const v of b.versions) {
    // A text of Congress is read from the XML file GovInfo publishes for the version; a California text from a member of the bulk archive.
    const from = v.sourceMember ? (federal ? `Text extracted from the XML file GovInfo publishes for this version (${v.sourceMember}). ` : `Text extracted from ${v.sourceMember} in the official bulk archive. `) : '';
    const sourceHash = v.sourceHash ? ` SHA-256 hash of ${federal ? 'that file as retrieved' : `${v.sourceMember ?? 'the official file'} as read from the archive`}: ${v.sourceHash}.` : '';
    const text = v.textAvailability === 'mirrored'
      ? `${from}SHA-256 hash of the extracted text, not of the official file: ${v.textHash}.${sourceHash}`
      : 'Text not mirrored; see the official link.';
    // Only a California version carries a subject line of its own.
    const subjectLine = federal ? '' : `Official subject line: ${v.subject?.trim() || 'not recorded'}${v.subject && /[.?!]$/.test(v.subject.trim()) ? '' : '.'} `;
    items.push(item({
      section: 'text_version', id: v.id, title: `Text version: ${v.label}`, date: v.versionDate, dateMeaning: 'Date of the text version',
      detail: `${subjectLine}${text}${v.diff ? ` Compared with the previous version: ${v.diff.blocksAdded} paragraph(s) added or changed, ${v.diff.blocksRemoved} removed or replaced.` : ''}`,
      ...fromRecord(v.officialUrl, federal ? FEDERAL_TEXT_SOURCE_ID : b.sourceId),
    }));
  }
  for (const c of input.linkedCases ?? []) items.push(caseItem(c, input));
  for (const r of links) items.push(relationshipItem(r, linkTitle(r, self, input), input, b.sourceId));
  // Measures the official record of a measure of Congress names as related. The record states the relation; nothing is inferred.
  b.relatedMeasures.forEach((related, index) => {
    items.push(item({
      section: 'link', id: `${b.id}:related${index}`, title: `${related.relationship}: ${related.identifier}`,
      detail: `${related.title ? `${related.title} ` : ''}Named as related in the official record of ${b.identifier} (identified by: ${related.identifiedBy}).${related.id ? '' : ' That measure is not in this dataset.'}`,
      ...(related.officialUrl ? legislatureSource(input, b.sourceId, related.officialUrl, b.sourceRecordUrl) : { sourceName: sourceName(input.sources, b.sourceId), sourceUrl: b.sourceRecordUrl ?? null, pageUrl: null }),
      lastCheckedAt: b.lastCheckedAt, ...checked(b.verification), appUrl: related.id ? input.link(`#/laws/${related.id}`) : null,
    }));
  });
  b.actions.forEach((a, index) => {
    const subject = earlierSubject(b, a);
    const votes = a.votes.map((vote) => ` Recorded vote (${vote.chamber}, roll no. ${vote.rollNumber}): ${vote.url}`).join('');
    items.push(item({
      section: 'event', id: `${b.id}:h${a.historyId ?? index}`, title: `Legislative history: ${a.eventType.replace(/_/g, ' ')}`, date: a.date, dateMeaning: 'Date of the legislative action',
      detail: `${a.text}${a.status ? ` (${a.status.toLowerCase()} in the official record)` : ''}${a.location ? ` Location after this action: ${a.location}.` : ''}${a.source ? ` Recorded by: ${a.source}.` : ''}${votes}${subject ? ` ${earlierSubjectNote(subject)}` : ''}`,
      ...fromRecord(b.officialUrl),
    }));
  });
  const unavailable: string[] = [];
  if (!input.relationships) unavailable.push(UNAVAILABLE_NOTICES.links);
  // Without the case index a linked case is still listed through its link, but not as a case record.
  else if (!input.linkedCases && links.some((r) => r.source.type === 'case' || r.target.type === 'case')) unavailable.push(UNAVAILABLE_NOTICES.caseRecords);
  return finish(
    { type: 'bill', id: b.id, label: `${billLabel(b)} (${b.session})`, url: input.link(`#/laws/${b.id}`) }, items, input,
    [b.sourceId, ...(federal && b.versions.length > 0 ? [FEDERAL_TEXT_SOURCE_ID] : []), ...(input.linkedCases ?? []).map((c) => c.sourceId)], unavailable,
  );
}

/** The first eleven columns keep their places from earlier packs; the columns added later follow them. */
const CSV_COLUMNS: Array<[keyof PackItem, string]> = [
  ['section', 'section'], ['id', 'id'], ['title', 'title'], ['date', 'date'], ['dateMeaning', 'date_meaning'], ['detail', 'detail'],
  ['sourceName', 'source_name'], ['sourceUrl', 'source_url'], ['lastCheckedAt', 'last_checked_at'], ['verificationLabel', 'verification'], ['appUrl', 'democracyhq_url'],
  ['verificationMethod', 'verification_method'], ['verificationNote', 'verification_note'],
  ['documentAvailability', 'document_availability'], ['documentAvailabilityNote', 'document_availability_note'],
  ['pageUrl', 'official_page_url_not_machine_checked'],
];

/** Quote a CSV cell. Cells that a spreadsheet would run as a formula are prefixed so they stay text. */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function packToCsv(pack: SourcePack): string {
  const lines = [CSV_COLUMNS.map(([, header]) => header).join(',')];
  for (const row of pack.items) lines.push(CSV_COLUMNS.map(([key]) => csvCell(row[key] as string | null)).join(','));
  lines.push('');
  for (const notice of pack.notices) lines.push(csvCell(`Notice: ${notice}`));
  lines.push(csvCell(`Generated ${pack.generatedAt} from ${pack.subject.url}`));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function packFileName(pack: SourcePack, extension: 'json' | 'csv'): string {
  const slug = pack.subject.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `democracyhq-source-pack-${slug}-${pack.generatedAt.slice(0, 10)}.${extension}`;
}

export function downloadText(fileName: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
