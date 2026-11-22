/**
 * Who governs a state or the United States: the executive and each chamber of the legislature, in the colour of the
 * party that holds it (rules party-*).
 *
 * Red and blue stand for the two parties here and nowhere else on the site. Colour is never the only sign: every
 * part names its party in words, and a part without a party says why. The figures are the members a source lists on
 * the day shown; nothing here is an election result.
 */
import type { ChamberSeats, Government, OfficeHolder, SourceRecord } from '../types/schemas';
import { formatDate, plural } from '../lib/format';
import { NATION_KEY } from '../lib/geo';
import {
  CONTROL_NAMES, PARTY_NAMES, controlSummary, controlTally, electedWithoutParties, majorityMark, seatSegments, seatsOf, whyUndetermined,
  type GovernmentIndex,
} from '../lib/government';
import { buildHash } from '../lib/router';
import { A, Ext } from './ui';

/** The side a part is shown on: one of the two parties, or none. */
type Side = 'R' | 'D' | 'none';

function sideOf(group: string | null | undefined): Side {
  return group === 'R' || group === 'D' ? group : 'none';
}

function Chip({ side }: { side: Side | 'split' | 'unknown' }) {
  return <span className={`gov-chip gov-chip-${side}`} aria-hidden="true" />;
}

function ExecutivePart({ record }: { record: Government }) {
  const office = record.id === NATION_KEY ? 'President' : 'Governor';
  const holder: OfficeHolder | null = record.executive;
  if (!holder) {
    return (
      <li className="gov-part gov-part-unknown">
        <div className="gov-part-head">
          <span className="gov-office">{office}</span>
          <span className="gov-party"><Chip side="unknown" />Not determined</span>
        </div>
        {/* Why not is said once, in the line above the parts. */}
        <p className="gov-note">Not read from a source.</p>
      </li>
    );
  }
  const side = sideOf(holder.group);
  return (
    <li className={`gov-part gov-part-${side}`}>
      <div className="gov-part-head">
        <span className="gov-office">{holder.office}</span>
        <span className="gov-party"><Chip side={side} />{side === 'none' ? holder.party : PARTY_NAMES[side]}</span>
      </div>
      <p className="gov-holder">
        {holder.name}
        {holder.termStarted ? <span className="gov-since">current term since {formatDate(holder.termStarted)}</span> : null}
      </p>
    </li>
  );
}

/** Whether any member of the chamber is counted with one of the two parties. */
function hasPartySeats(chamber: ChamberSeats): boolean {
  return seatsOf(chamber, 'D') + seatsOf(chamber, 'R') > 0;
}

/** What a chamber's bar says in words, for the part's heading. */
function chamberVerdict(chamber: ChamberSeats): string {
  if (chamber.lead) return `${PARTY_NAMES[chamber.lead]} majority`;
  if (chamber.seats === null) return 'Not worked out';
  if (electedWithoutParties(chamber)) return 'No party labels';
  return 'No majority';
}

/**
 * The seats of a chamber as one bar: Democratic seats from the left, Republican seats from the right, the others and
 * the vacant seats between them, and a mark at the middle. The side that reaches past the mark holds more than half.
 * The bar is drawn for the eye; the same figures stand beside and below it as text.
 */
function SeatBar({ chamber }: { chamber: ChamberSeats }) {
  const segments = seatSegments(chamber);
  const total = chamber.seats ?? chamber.members;
  // A chamber elected without party labels has no figure for either party: the bar stands alone.
  if (!hasPartySeats(chamber)) {
    return (
      <div className="seatbar seatbar-plain" aria-hidden="true">
        <span className="seatbar-track">
          {segments.map((segment, index) => <span key={`${segment.kind}-${index}`} className={`seat seat-${segment.kind}`} style={{ flexGrow: segment.seats, flexBasis: 0 }} />)}
        </span>
      </div>
    );
  }
  return (
    <div className="seatbar" aria-hidden="true">
      <span className="seatbar-count seatbar-count-D">{seatsOf(chamber, 'D')}</span>
      <span className="seatbar-track">
        {segments.map((segment, index) => (
          <span key={`${segment.kind}-${index}`} className={`seat seat-${segment.kind}`} style={{ flexGrow: segment.seats, flexBasis: 0 }} title={`${segment.label}: ${segment.seats}`} />
        ))}
        {total > 0 ? <span className="seatbar-mark" /> : null}
      </span>
      <span className="seatbar-count seatbar-count-R">{seatsOf(chamber, 'R')}</span>
    </div>
  );
}

function ChamberPart({ chamber }: { chamber: ChamberSeats }) {
  const side: Side = chamber.lead ?? 'none';
  const mark = majorityMark(chamber);
  const others = chamber.parties.filter((entry) => entry.group !== 'R' && entry.group !== 'D');
  return (
    <li className={`gov-part gov-part-${side}`}>
      <div className="gov-part-head">
        <span className="gov-office">{chamber.name}</span>
        <span className="gov-party"><Chip side={side} />{chamberVerdict(chamber)}</span>
      </div>
      <SeatBar chamber={chamber} />
      <p className="gov-seats">
        {hasPartySeats(chamber) ? <><span>Democratic {seatsOf(chamber, 'D')}</span><span>Republican {seatsOf(chamber, 'R')}</span></> : null}
        {others.map((entry) => <span key={entry.name}>{entry.name} {entry.seats}</span>)}
        {chamber.vacant ? <span>Vacant {chamber.vacant}</span> : null}
      </p>
      <p className="gov-note">
        {chamber.seats !== null
          ? `${plural(chamber.seats, 'seat')}; more than half is ${mark}.`
          : `The source lists ${plural(chamber.members, 'member')}, more than the chamber has seats, so no majority is worked out.`}
        {chamber.leadBasis === 'stated' ? ' The majority is the one the Clerk of the House states in the list.' : ''}
        {chamber.note ? ` ${chamber.note}` : ''}
      </p>
    </li>
  );
}

function sourceLabel(sources: readonly SourceRecord[], id: string): string {
  return sources.find((source) => source.id === id)?.authority ?? id;
}

function SourcesOf({ record, sources }: { record: Government; sources: readonly SourceRecord[] }) {
  // One line for each source: the chambers of a state come from one file and are named together.
  const lines = new Map<string, { parts: string[]; url: string; id: string; asOf: string | null; checkedAt: string }>();
  if (record.executive) {
    const { office, sourceUrl, sourceId, checkedAt } = record.executive;
    lines.set(sourceUrl, { parts: [office], url: sourceUrl, id: sourceId, asOf: null, checkedAt });
  }
  for (const chamber of record.chambers) {
    const line = lines.get(chamber.sourceUrl);
    if (line) line.parts.push(chamber.name);
    else lines.set(chamber.sourceUrl, { parts: [chamber.name], url: chamber.sourceUrl, id: chamber.sourceId, asOf: chamber.asOf, checkedAt: chamber.checkedAt });
  }
  return (
    <details className="method gov-more">
      <summary>Sources, dates and rules</summary>
      <ul className="gov-sources">
        {[...lines.values()].map((line) => (
          <li key={line.url}>
            <strong>{line.parts.join(' and ')}:</strong> <Ext href={line.url}>{sourceLabel(sources, line.id)}</Ext>
            {line.asOf ? `, list dated ${formatDate(line.asOf)}` : ''}, read {formatDate(line.checkedAt)}.
          </li>
        ))}
      </ul>
      <p>
        Members are counted by the party label the source gives each of them. A chamber is shown in a party&rsquo;s colour when that party&rsquo;s members hold more than half of its seats, vacant seats included,
        and a government when its {record.id === NATION_KEY ? 'President' : 'governor'} and every chamber are that party&rsquo;s.
        Seats show who was elected under which label, not who runs a chamber: where members of both parties form the governing coalition, the colour still follows the seats.
        These are the members listed on the days given. They are not an election result, and members-elect are not counted before they take office.
      </p>
      <p><A to={buildHash(['sources'], { section: 'rules' })}>Rules party-group-1, party-seats-1 and party-trifecta-1</A></p>
    </details>
  );
}

/** The headline of the block: which party holds the government, in words, with its colour beside it. */
function Verdict({ record }: { record: Government }) {
  const chip = record.control === 'divided' ? 'split' : record.control === 'undetermined' ? 'unknown' : record.control;
  return (
    <p className={`gov-verdict gov-verdict-${chip}`}>
      <Chip side={chip} />
      <span>
        <strong>{record.control === 'undetermined' ? 'Not determined' : record.control === 'divided' ? 'Divided government' : `${CONTROL_NAMES[record.control]} trifecta`}</strong>
        <span className="gov-verdict-detail">{record.control === 'undetermined' ? whyUndetermined(record) : controlSummary(record)}</span>
      </span>
    </p>
  );
}

export function WhoGoverns({ record, sources }: { record: Government; sources: readonly SourceRecord[] }) {
  return (
    <div className="gov">
      <Verdict record={record} />
      <ol className="gov-parts" aria-label={`The offices of ${record.name} by party`}>
        <ExecutivePart record={record} />
        {record.chambers.map((chamber) => <ChamberPart key={chamber.chamber} chamber={chamber} />)}
      </ol>
      <SourcesOf record={record} sources={sources} />
    </div>
  );
}

/**
 * Who governs, at a glance: how many of the fifty states each party holds and how many are divided, and under them
 * the two chambers of Congress. Every bar has the same order: Democratic from the left, Republican from the right.
 */
export function ControlTally({ index, mapHash, shown, nationHash }: { index: GovernmentIndex; mapHash: string; shown: boolean; nationHash?: string }) {
  const tally = controlTally(index.states);
  const congress = index.nation?.chambers ?? [];
  const parts: Array<{ key: 'R' | 'D' | 'split' | 'unknown'; count: number; label: string }> = [
    { key: 'D', count: tally.D, label: 'Democratic' },
    { key: 'split', count: tally.divided, label: 'Divided' },
    { key: 'unknown', count: tally.undetermined, label: 'Not determined' },
    { key: 'R', count: tally.R, label: 'Republican' },
  ];
  return (
    <div className="gov gov-tally">
      <ol className="gov-board" aria-label="Who governs, by party">
        <li className="gov-row">
          <div className="gov-part-head">
            <span className="gov-office">State governments</span>
            <span className="gov-party">{plural(index.states.length, 'state')}</span>
          </div>
          <div className="seatbar seatbar-tall" aria-hidden="true">
            <span className="seatbar-count seatbar-count-D">{tally.D}</span>
            <span className="seatbar-track">
              {parts.filter((part) => part.count > 0).map((part) => <span key={part.key} className={`seat seat-${part.key}`} style={{ flexGrow: part.count, flexBasis: 0 }} />)}
            </span>
            <span className="seatbar-count seatbar-count-R">{tally.R}</span>
          </div>
          <p className="gov-seats">
            {parts.filter((part) => part.count > 0).map((part) => <span key={part.key}><Chip side={part.key} />{part.label} {part.count}</span>)}
          </p>
        </li>
        {congress.map((chamber) => (
          <li className="gov-row" key={chamber.chamber}>
            <div className="gov-part-head">
              <span className="gov-office">U.S. {chamber.name}</span>
              <span className="gov-party"><Chip side={chamber.lead ?? 'none'} />{chamberVerdict(chamber)}</span>
            </div>
            <SeatBar chamber={chamber} />
            <p className="gov-seats">
              <span>Democratic {seatsOf(chamber, 'D')}</span>
              <span>Republican {seatsOf(chamber, 'R')}</span>
              {chamber.parties.filter((entry) => entry.group !== 'R' && entry.group !== 'D').map((entry) => <span key={entry.name}>{entry.name} {entry.seats}</span>)}
              {chamber.vacant ? <span>Vacant {chamber.vacant}</span> : null}
            </p>
          </li>
        ))}
      </ol>
      <details className="method gov-note">
        <summary>How it is counted</summary>
        <p>
          A state government is counted for a party when the governor and every chamber of the legislature are that party&rsquo;s, and as divided otherwise.
          {congress.length > 0 ? ' For Congress the bars show the seats held under each party’s label.' : ''}
          {' '}Counted from the members each source lists today; not an election result.
        </p>
      </details>
      <p className="gov-links">
        {shown ? <A to={mapHash}>Back to the map of records</A> : <A to={mapHash}>Colour the map by party control</A>}
        {nationHash && congress.length > 0 ? <A to={nationHash}>Congress in detail</A> : null}
      </p>
    </div>
  );
}
