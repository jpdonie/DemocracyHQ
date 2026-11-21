/**
 * Version comparison for official bill text.
 *
 * Both sides are text published by the legislature; the comparison only aligns
 * them. Blocks (sections, paragraphs) are aligned first, then words are
 * compared inside blocks that were edited. When two versions are too different
 * to align in reasonable time the result says so instead of guessing. One time
 * limit covers both steps: once it passes, the remaining edited paragraphs are
 * shown whole (removed and added) instead of word by word.
 */
import { diffArrays, diffWordsWithSpace } from 'diff';
import type { TextBlock } from '../types/schemas';

export interface WordPart { value: string; added?: boolean; removed?: boolean }

export type DiffRow =
  | { kind: 'equal'; block: TextBlock; oldIndex: number; newIndex: number }
  | { kind: 'insert'; block: TextBlock; newIndex: number }
  | { kind: 'delete'; block: TextBlock; oldIndex: number }
  | { kind: 'change'; before: TextBlock; after: TextBlock; words: WordPart[]; oldIndex: number; newIndex: number };

export interface DiffStats { inserted: number; deleted: number; changed: number; unchanged: number }

export interface DiffResult {
  rows: DiffRow[];
  stats: DiffStats;
  /** False when the versions could not be aligned within the time limit; rows then show a full replacement. */
  aligned: boolean;
  /**
   * Edited paragraphs that were not compared word by word because the time limit ran out first. Each is shown as the
   * whole earlier paragraph removed and the whole later one added, and counted as one removed and one added paragraph.
   */
  unpaired: number;
}

export interface DiffOptions {
  /** One time limit for the whole comparison: aligning paragraphs and then comparing words. Default 4 seconds. */
  timeoutMs?: number;
  /** Clock in milliseconds, injectable for tests. */
  now?: () => number;
}

const token = (block: TextBlock): string => `${block[0]}\u0000${block[1]}`;

type Tag = 'same' | 'removed' | 'added';
interface Piece { tag: Tag; value: string }

const tagOf = (part: WordPart): Tag => (part.added ? 'added' : part.removed ? 'removed' : 'same');
const isSpace = (value: string) => /^\s+$/.test(value);

/** The whitespace at the start of a string, and at its end. */
const leadingSpace = (value: string): string => /^\s*/.exec(value)![0];
const trailingSpace = (value: string): string => /\s*$/.exec(value)![0];

function commonPrefix(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return a.slice(0, n);
}

function commonSuffix(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return a.slice(a.length - n);
}

/**
 * Word-level changes as a reader expects them: where deleted and inserted words alternate with nothing but spaces
 * between them ("not ~~yet~~submitted ~~cast~~ it"), the run becomes one replacement, all of the removed words and
 * then all of the added words ("not ~~yet cast~~__submitted__ it"). Spaces that both texts have at the edges of a
 * change are kept outside it. No space is ever added: the removed and kept parts spell the earlier text exactly, and
 * the added and kept parts the later text. (The page separates a removal from the addition that follows it with a
 * margin, not with a character.)
 */
export function mergeWordRuns(parts: readonly WordPart[]): WordPart[] {
  const pieces: Piece[] = [];
  for (const part of parts) {
    const tag = tagOf(part);
    for (const value of part.value.split(/(\s+)/)) if (value) pieces.push({ tag, value });
  }
  const out: Piece[] = [];
  let i = 0;
  while (i < pieces.length) {
    const first = pieces[i]!;
    if (first.tag === 'same' || isSpace(first.value)) {
      out.push(first);
      i += 1;
      continue;
    }
    // A run: changed words and any spaces between them, up to the next unchanged word.
    let j = i;
    while (j < pieces.length && (pieces[j]!.tag !== 'same' || isSpace(pieces[j]!.value))) j += 1;
    const run = pieces.slice(i, j);
    i = j;
    let before = run.filter((p) => p.tag !== 'added').map((p) => p.value).join('');
    let after = run.filter((p) => p.tag !== 'removed').map((p) => p.value).join('');
    // Whitespace that both texts have at the start or the end of the run is unchanged text.
    const head = commonPrefix(leadingSpace(before), leadingSpace(after));
    before = before.slice(head.length);
    after = after.slice(head.length);
    const tail = commonSuffix(trailingSpace(before), trailingSpace(after));
    before = before.slice(0, before.length - tail.length);
    after = after.slice(0, after.length - tail.length);
    if (head) out.push({ tag: 'same', value: head });
    if (before) out.push({ tag: 'removed', value: before });
    if (after) out.push({ tag: 'added', value: after });
    if (tail) out.push({ tag: 'same', value: tail });
  }
  // Join neighbours with the same tag.
  const merged: WordPart[] = [];
  for (const piece of out) {
    const last = merged[merged.length - 1];
    if (last && tagOf(last) === piece.tag) last.value += piece.value;
    else merged.push(piece.tag === 'same' ? { value: piece.value } : { value: piece.value, [piece.tag]: true });
  }
  return merged;
}

/** One stretch of an edited paragraph as the page shows it: unchanged text, or text marked as removed or added. */
export interface MarkedText {
  text: string;
  mark: 'del' | 'ins' | null;
  /** True for a mark that directly follows another mark, with no text between them (the page sets them apart with a margin). */
  adjoins: boolean;
}

/**
 * How the parts of an edited paragraph are shown. Spaces at the edges of a removed or added run are shown outside the
 * mark (an underlined or struck-through space reads badly), but only where that cannot put a space between two
 * characters of the other version: read without the added text the paragraph still gives the earlier version, and read
 * without the removed text the later one, apart from runs of spaces.
 */
export function markedText(parts: readonly WordPart[]): MarkedText[] {
  // For each part, the character just before it and just after it in the other version's reading.
  const inEarlier = (p: WordPart) => !p.added;
  const inLater = (p: WordPart) => !p.removed;
  const edges = (keep: (p: WordPart) => boolean) => {
    const prev: string[] = [];
    const next: string[] = new Array<string>(parts.length).fill('');
    let last = '';
    parts.forEach((part) => {
      prev.push(last);
      if (keep(part) && part.value) last = part.value[part.value.length - 1]!;
    });
    let first = '';
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      next[i] = first;
      const part = parts[i]!;
      if (keep(part) && part.value) first = part.value[0]!;
    }
    return { prev, next };
  };
  const earlier = edges(inEarlier);
  const later = edges(inLater);
  const out: MarkedText[] = [];
  const push = (text: string, mark: MarkedText['mark']) => {
    if (!text) return;
    const previous = out[out.length - 1];
    out.push({ text, mark, adjoins: mark !== null && previous !== undefined && previous.mark !== null });
  };
  parts.forEach((part, i) => {
    if (!part.added && !part.removed) {
      push(part.value, null);
      return;
    }
    const mark = part.added ? 'ins' : 'del';
    const other = part.added ? earlier : later;
    const before = other.prev[i]!;
    const after = other.next[i]!;
    // Spaces moved out of the mark join a space (or an end of the paragraph) in the other version.
    const safe = !before || !after || /\s/.test(before) || /\s/.test(after);
    const lead = leadingSpace(part.value);
    const core = part.value.slice(lead.length);
    const trail = trailingSpace(core);
    const word = core.slice(0, core.length - trail.length);
    if (!safe) {
      push(part.value, mark);
    } else if (!word) {
      push(part.value, null);
    } else {
      push(lead, null);
      push(word, mark);
      push(trail, null);
    }
  });
  return out;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
}

/** Share of words two blocks have in common (Jaccard). Used to decide whether a removed and an added block are one edit. */
export function blockSimilarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const word of sa) if (sb.has(word)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

const PAIR_THRESHOLD = 0.5;

/** Word-level changes between two paragraphs, or null when they cannot be compared before the deadline. */
function wordsBefore(deadline: number, now: () => number, before: string, after: string): WordPart[] | null {
  const remaining = deadline - now();
  if (remaining <= 0) return null;
  const parts = diffWordsWithSpace(before, after, { timeout: remaining });
  return parts ? mergeWordRuns(parts) : null;
}

export function diffBlocks(before: readonly TextBlock[], after: readonly TextBlock[], options: DiffOptions = {}): DiffResult {
  const now = options.now ?? (() => Date.now());
  const limit = options.timeoutMs ?? 4000;
  // One deadline for the whole comparison. Once it passes, the remaining edited paragraphs are shown whole.
  const deadline = now() + limit;
  const stats: DiffStats = { inserted: 0, deleted: 0, changed: 0, unchanged: 0 };
  const rows: DiffRow[] = [];
  let unpaired = 0;
  const parts = diffArrays(before.map(token), after.map(token), { timeout: limit });
  if (!parts) {
    before.forEach((block, oldIndex) => rows.push({ kind: 'delete', block, oldIndex }));
    after.forEach((block, newIndex) => rows.push({ kind: 'insert', block, newIndex }));
    return { rows, stats: { inserted: after.length, deleted: before.length, changed: 0, unchanged: 0 }, aligned: false, unpaired: 0 };
  }
  let oldIndex = 0;
  let newIndex = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (!part.added && !part.removed) {
      for (let k = 0; k < part.value.length; k += 1) {
        rows.push({ kind: 'equal', block: after[newIndex]!, oldIndex, newIndex });
        oldIndex += 1;
        newIndex += 1;
        stats.unchanged += 1;
      }
      continue;
    }
    if (part.removed && next?.added) {
      // A removed run followed by an added run: pair blocks position by position when they are clearly the same passage
      // edited. The others are not one-for-one replacements, so they are shown as one run of removed paragraphs followed
      // by one run of added paragraphs, never interleaved (old, new, old, new), so each version reads in its own order.
      const removed = part.value.length;
      const added = next.value.length;
      const paired = Math.min(removed, added);
      let removedRun: DiffRow[] = [];
      let addedRun: DiffRow[] = [];
      const flush = () => {
        rows.push(...removedRun, ...addedRun);
        removedRun = [];
        addedRun = [];
      };
      for (let k = 0; k < Math.max(removed, added); k += 1) {
        const b = k < removed ? before[oldIndex + k]! : null;
        const a = k < added ? after[newIndex + k]! : null;
        const similar = k < paired && b![0] === a![0] && blockSimilarity(b![1], a![1]) >= PAIR_THRESHOLD;
        if (similar) {
          flush();
          const words = wordsBefore(deadline, now, b![1], a![1]);
          if (words) {
            rows.push({ kind: 'change', before: b!, after: a!, words, oldIndex: oldIndex + k, newIndex: newIndex + k });
            stats.changed += 1;
          } else {
            // The same passage edited, but out of time to compare its words: the two paragraphs stay together.
            unpaired += 1;
            rows.push({ kind: 'delete', block: b!, oldIndex: oldIndex + k }, { kind: 'insert', block: a!, newIndex: newIndex + k });
            stats.deleted += 1;
            stats.inserted += 1;
          }
          continue;
        }
        if (b) {
          removedRun.push({ kind: 'delete', block: b, oldIndex: oldIndex + k });
          stats.deleted += 1;
        }
        if (a) {
          addedRun.push({ kind: 'insert', block: a, newIndex: newIndex + k });
          stats.inserted += 1;
        }
      }
      flush();
      oldIndex += removed;
      newIndex += added;
      i += 1;
      continue;
    }
    if (part.removed) {
      for (let k = 0; k < part.value.length; k += 1) {
        rows.push({ kind: 'delete', block: before[oldIndex]!, oldIndex });
        oldIndex += 1;
        stats.deleted += 1;
      }
    } else {
      for (let k = 0; k < part.value.length; k += 1) {
        rows.push({ kind: 'insert', block: after[newIndex]!, newIndex });
        newIndex += 1;
        stats.inserted += 1;
      }
    }
  }
  return { rows, stats, aligned: true, unpaired };
}

export type DiffSegment = { type: 'changes'; rows: DiffRow[] } | { type: 'unchanged'; rows: DiffRow[] };

/** Group rows into runs of changes (with a little unchanged context) and collapsible unchanged runs. */
export function segmentDiff(rows: readonly DiffRow[], context = 1): DiffSegment[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === 'equal') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k += 1) keep[k] = true;
  });
  const segments: DiffSegment[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const type = keep[i] ? 'changes' : 'unchanged';
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.rows.push(rows[i]!);
    else segments.push({ type, rows: [rows[i]!] });
  }
  return segments;
}

export function isIdentical(result: DiffResult): boolean {
  return result.stats.inserted === 0 && result.stats.deleted === 0 && result.stats.changed === 0;
}
