/**
 * Cross-module navigation: which cases and bills does the record support
 * linking to a place? Links come only from `relationships.json`, where every
 * entry cites the passage that supports it. Nothing here infers a link from a
 * court's location or a party's name.
 */
import type { EntityRelationship, LegalCaseSummary, LegislativeInstrumentSummary, TimelineEvent, EventCategory } from '../types/schemas';
import { parseGeoKey } from './geo';

export interface LinkedRecord<T> {
  record: T;
  relationship: EntityRelationship;
  /** direct: linked to this exact unit. statewide: linked to the whole state that contains it. within: linked to a unit inside this state. */
  via: 'direct' | 'statewide' | 'within';
}

function keyState(key: string): string | null {
  const parsed = parseGeoKey(key);
  return parsed ? parsed.geoid.slice(0, 2) : null;
}

export function relationshipsForPlace(key: string, relationships: readonly EntityRelationship[]): Array<{ relationship: EntityRelationship; via: LinkedRecord<unknown>['via'] }> {
  const parsed = parseGeoKey(key);
  if (!parsed) return [];
  const stateFips = parsed.geoid.slice(0, 2);
  const out: Array<{ relationship: EntityRelationship; via: LinkedRecord<unknown>['via'] }> = [];
  for (const relationship of relationships) {
    if (relationship.target.type !== 'geography') continue;
    const target = relationship.target.id;
    const wholeState = relationship.scope.kind === 'statewide' || relationship.scope.kind === 'multi_state';
    // A link to the state whose scope is one county or district (for example "the county concerned is in Texas")
    // concerns a unit inside the state, not the state as a whole.
    if (target === key && parsed.layer === 'state' && !wholeState) out.push({ relationship, via: 'within' });
    else if (target === key) out.push({ relationship, via: 'direct' });
    else if (parsed.layer !== 'state' && target === `state:${stateFips}` && relationship.scope.kind === 'statewide') out.push({ relationship, via: 'statewide' });
    else if (parsed.layer === 'state' && target !== key && keyState(target) === stateFips) out.push({ relationship, via: 'within' });
  }
  return out;
}

export function casesForPlace(key: string, relationships: readonly EntityRelationship[], cases: readonly LegalCaseSummary[]): LinkedRecord<LegalCaseSummary>[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: LinkedRecord<LegalCaseSummary>[] = [];
  const order = { direct: 0, statewide: 1, within: 2 } as const;
  const links = relationshipsForPlace(key, relationships).filter((l) => l.relationship.source.type === 'case').sort((a, b) => order[a.via] - order[b.via]);
  for (const { relationship, via } of links) {
    const record = byId.get(relationship.source.id);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push({ record, relationship, via });
  }
  return out.sort((a, b) => order[a.via] - order[b.via] || (b.record.sourceLastActivity ?? '').localeCompare(a.record.sourceLastActivity ?? ''));
}

/** Bills are listed for the whole state. Some concern one county or district, but they are not linked to it here. */
export function billsForPlace(key: string, bills: readonly LegislativeInstrumentSummary[]): LegislativeInstrumentSummary[] {
  const stateFips = keyState(key);
  return stateFips ? bills.filter((b) => b.state === stateFips) : [];
}

export function relationshipsForRecord(type: 'case' | 'bill', id: string, relationships: readonly EntityRelationship[]): EntityRelationship[] {
  return relationships.filter((r) => (r.source.type === type && r.source.id === id) || (r.target.type === type && r.target.id === id));
}

/** Whether a sentence found by rule is already quoted by a curated link (any part of its quotation, ignoring a leading "(b)"). */
export function sameWords(quote: string, sentence: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/^\(?[a-z0-9]{1,4}\)\s*/i, '').replace(/[.\s]+$/, '').toLowerCase();
  const y = norm(sentence);
  if (!y) return false;
  return quote.split('[…]').map(norm).some((x) => x.length > 0 && (x === y || x.includes(y) || y.includes(x)));
}

export interface TimelineFilters { categories?: readonly EventCategory[]; from?: string; to?: string }

/** "What changed here?": dated events tied to a place, newest first. */
export function eventsForPlace(key: string, events: readonly TimelineEvent[], filters: TimelineFilters = {}): Array<TimelineEvent & { via: 'direct' | 'statewide' | 'within' }> {
  const parsed = parseGeoKey(key);
  if (!parsed) return [];
  const stateFips = parsed.geoid.slice(0, 2);
  const stateKey = `state:${stateFips}`;
  const out: Array<TimelineEvent & { via: 'direct' | 'statewide' | 'within' }> = [];
  for (const event of events) {
    if (filters.categories && !filters.categories.includes(event.category)) continue;
    if (filters.from && event.date < filters.from) continue;
    if (filters.to && event.date > filters.to) continue;
    let via: 'direct' | 'statewide' | 'within' | null = null;
    if (event.geoKeys.includes(key)) via = 'direct';
    else if (parsed.layer !== 'state' && event.geoKeys.includes(stateKey)) via = 'statewide';
    else if (parsed.layer === 'state' && event.geoKeys.some((k) => keyState(k) === stateFips)) via = 'within';
    if (via) out.push({ ...event, via });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** Count of linked records per state, for the map's "has linked records" layer. */
export function linkedStates(relationships: readonly EntityRelationship[], sourceType: 'case' | 'bill' | 'any' = 'any'): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const r of relationships) {
    if (r.target.type !== 'geography') continue;
    if (sourceType !== 'any' && r.source.type !== sourceType) continue;
    const stateFips = keyState(r.target.id);
    if (!stateFips) continue;
    const set = sets.get(stateFips) ?? new Set<string>();
    set.add(`${r.source.type}:${r.source.id}`);
    sets.set(stateFips, set);
  }
  return new Map([...sets.entries()].map(([k, v]) => [k, v.size]));
}

export type EventRow = TimelineEvent & {
  /** Entries folded into this row: boundary-file updates of the same date and text, one per state. */
  group?: TimelineEvent[];
};

/**
 * "Latest dated events" on the home page: the newest entries of each kind (court, legislature, boundaries), at most
 * `perCategory` rows each, newest first, so a busy kind cannot crowd out the others. The Census Bureau's boundary
 * entries come one per state with the same date and text; those are folded into one row.
 */
export function latestEvents(events: readonly TimelineEvent[], perCategory: number): EventRow[] {
  // A stable sort: entries of the same date keep the order of the published file.
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
  const rows: EventRow[] = [];
  const shown = new Map<EventCategory, number>();
  for (const event of sorted) {
    if (event.entityType === 'geography') {
      const same = rows.find((row) => row.entityType === 'geography' && row.date === event.date && row.eventType === event.eventType && row.description === event.description);
      if (same) {
        same.group = [...(same.group ?? [same]), event];
        continue;
      }
    }
    const count = shown.get(event.category) ?? 0;
    if (count >= perCategory) continue;
    shown.set(event.category, count + 1);
    rows.push({ ...event });
  }
  return rows;
}
