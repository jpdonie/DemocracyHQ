import type { EventCategory, TimelineEvent } from '../../types/schemas';
import { formatDate } from '../../lib/format';
import { eventLabel } from '../../lib/labels';
import type { EventRow } from '../../lib/relations';
import { buildHash } from '../../lib/router';
import { Ext } from '../../components/ui';
import { differentSubject, earlierSubjectNote } from '../../lib/billHistory';

const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = { litigation: 'Court', legislation: 'Legislature', geography: 'Boundaries' };
const VIA_NOTE = { direct: null, statewide: 'Statewide record', within: 'Concerns a unit inside this state' } as const;

export function entityHash(event: Pick<TimelineEvent, 'entityType' | 'entityId'>): string {
  if (event.entityType === 'case') return buildHash(['litigation', event.entityId]);
  if (event.entityType === 'bill') return buildHash(['laws', event.entityId]);
  return buildHash(['place', event.entityId]);
}

/** The words every label in a group ends with ("congressional districts"), so a folded row can name each place once. */
function sharedEnding(labels: readonly string[]): string {
  const words = labels.map((label) => label.split(' '));
  let n = 0;
  while (words.every((w) => w.length > n + 1 && w[w.length - 1 - n] === words[0]![words[0]!.length - 1 - n])) n += 1;
  return words[0]!.slice(words[0]!.length - n).join(' ');
}

/** A row that stands for the same entry for several places: "Congressional districts (9): Alabama, California, …". */
function GroupEntity({ group }: { group: readonly TimelineEvent[] }) {
  const sorted = [...group].sort((a, b) => a.entityLabel.localeCompare(b.entityLabel));
  const ending = sharedEnding(sorted.map((e) => e.entityLabel));
  const name = (e: TimelineEvent) => (ending ? e.entityLabel.slice(0, -ending.length - 1) : e.entityLabel);
  return (
    <p className="timeline-entity">
      {ending ? `${ending.charAt(0).toUpperCase()}${ending.slice(1)} (${group.length}): ` : `${group.length} places: `}
      {sorted.map((e, i) => <span key={e.id}>{i > 0 ? (ending ? ', ' : '; ') : null}<a href={entityHash(e)}>{name(e)}</a></span>)}
    </p>
  );
}

/**
 * `subjectOf` gives a bill's current official subject line. With it, a bill action taken while the bill carried another
 * subject (before a "gut and amend") says so, as on the bill page.
 */
export function TimelineList({ events, limit, subjectOf }: {
  events: ReadonlyArray<EventRow & { via?: 'direct' | 'statewide' | 'within' }>;
  limit?: number;
  subjectOf?: (billId: string) => string | null | undefined;
}) {
  const shown = limit ? events.slice(0, limit) : events;
  let lastYear = '';
  return (
    <ol className="timeline">
      {shown.map((event) => {
        const year = event.date.slice(0, 4);
        const heading = year !== lastYear ? <li className="timeline-year" key={`y${year}`}><h3>{year}</h3></li> : null;
        lastYear = year;
        const via = event.via ? VIA_NOTE[event.via] : null;
        return [
          heading,
          <li key={event.id} className={`timeline-item cat-${event.category}`}>
            <time dateTime={event.date}>{formatDate(event.date)}</time>
            <div>
              <p className="timeline-head">
                <span className="timeline-cat">{CATEGORY_LABEL[event.category]}</span> {eventLabel(event.eventType)}
              </p>
              {event.group && event.group.length > 1 ? <GroupEntity group={event.group} /> : (
                <p className="timeline-entity"><a className={event.entityType === 'case' ? 'case-name' : undefined} href={entityHash(event)}>{event.entityLabel}</a></p>
              )}
              <p className="timeline-text">{event.group && event.group.length > 1 ? `The same entry for each: ${event.description}` : event.description}</p>
              {(() => {
                const earlier = event.entityType === 'bill' && subjectOf ? differentSubject(event.subjectInForce, subjectOf(event.entityId)) : null;
                return earlier ? <p className="timeline-subject">{earlierSubjectNote(earlier)}</p> : null;
              })()}
              <p className="timeline-foot">
                {via ? <span className="quiet">{via}. </span> : null}
                {/^https:\/\//.test(event.sourceUrl) ? <Ext href={event.sourceUrl}>Source</Ext> : null}
              </p>
            </div>
          </li>,
        ];
      })}
    </ol>
  );
}
