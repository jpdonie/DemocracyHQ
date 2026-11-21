import { describe, expect, it } from 'vitest';
import { diffWordsWithSpace } from 'diff';
import { blockSimilarity, diffBlocks, isIdentical, mergeWordRuns, segmentDiff, type WordPart } from '../../src/lib/diff';
import type { TextBlock } from '../../src/types/schemas';

// Synthetic statute text, invented for these tests.
const before: TextBlock[] = [
  ['s', 'SECTION 1.'],
  ['p', 'A ballot returned by mail shall be counted if it is received no later than three days after election day.'],
  ['p', 'The elections official shall publish the count.'],
  ['s', 'SEC. 2.'],
  ['p', 'This section is repealed.'],
];
const after: TextBlock[] = [
  ['s', 'SECTION 1.'],
  ['p', 'A ballot returned by mail shall be counted if it is received no later than seven days after election day.'],
  ['p', 'The elections official shall publish the count.'],
  ['p', 'A new paragraph about signature verification is added here.'],
];

describe('diffBlocks', () => {
  it('reports identical versions as identical', () => {
    const result = diffBlocks(before, before);
    expect(isIdentical(result)).toBe(true);
    expect(result.stats).toEqual({ inserted: 0, deleted: 0, changed: 0, unchanged: before.length });
    expect(result.aligned).toBe(true);
  });

  it('pairs an edited paragraph and marks only the words that changed', () => {
    const result = diffBlocks(before, after);
    const change = result.rows.find((r) => r.kind === 'change');
    expect(change?.kind).toBe('change');
    if (change?.kind !== 'change') return;
    expect(change.words.filter((w) => w.removed).map((w) => w.value.trim())).toEqual(['three']);
    expect(change.words.filter((w) => w.added).map((w) => w.value.trim())).toEqual(['seven']);
    // Reassembling the unchanged and added words gives back the new official text exactly.
    expect(change.words.filter((w) => !w.removed).map((w) => w.value).join('')).toBe(after[1]![1]);
    expect(change.words.filter((w) => !w.added).map((w) => w.value).join('')).toBe(before[1]![1]);
  });

  it('counts insertions, deletions and changes separately', () => {
    const { stats, rows } = diffBlocks(before, after);
    expect(stats.changed).toBe(1);
    expect(stats.unchanged).toBe(2);
    expect(stats.inserted + stats.deleted).toBe(3);
    expect(rows.filter((r) => r.kind === 'insert').length).toBe(stats.inserted);
    expect(rows.filter((r) => r.kind === 'delete').length).toBe(stats.deleted);
  });

  it('never invents text: every block shown comes from one of the two versions', () => {
    const texts = new Set([...before, ...after].map((b) => b[1]));
    for (const row of diffBlocks(before, after).rows) {
      if (row.kind === 'change') {
        expect(texts.has(row.before[1])).toBe(true);
        expect(texts.has(row.after[1])).toBe(true);
      } else {
        expect(texts.has(row.block[1])).toBe(true);
      }
    }
  });

  it('keeps every block of both versions exactly once', () => {
    const { rows } = diffBlocks(before, after);
    const oldSeen = rows.flatMap((r) => ('oldIndex' in r ? [r.oldIndex] : []));
    const newSeen = rows.flatMap((r) => ('newIndex' in r ? [r.newIndex] : []));
    expect([...oldSeen].sort((a, b) => a - b)).toEqual(before.map((_, i) => i));
    expect([...newSeen].sort((a, b) => a - b)).toEqual(after.map((_, i) => i));
  });

  it('does not pair unrelated paragraphs as one edit', () => {
    const result = diffBlocks([['p', 'Polling places open at seven in the morning.']], [['p', 'Campaign finance reports are filed quarterly.']]);
    expect(result.stats).toEqual({ inserted: 1, deleted: 1, changed: 0, unchanged: 0 });
  });

  it('does not pair a heading with a paragraph even if the words match', () => {
    const result = diffBlocks([['s', 'Elections official duties']], [['p', 'Elections official duties']]);
    expect(result.stats.changed).toBe(0);
  });

  it('carries one time limit across the word comparisons and shows the rest whole once it passes', () => {
    // Four edited paragraphs; the clock moves 10 ms each time it is read, and the limit is 25 ms.
    const olds: TextBlock[] = [1, 2, 3, 4].map((n) => ['p', `Paragraph ${n}: a ballot is counted if it arrives within three days.`]);
    const news: TextBlock[] = [1, 2, 3, 4].map((n) => ['p', `Paragraph ${n}: a ballot is counted if it arrives within seven days.`]);
    let clock = 0;
    const result = diffBlocks(olds, news, { timeoutMs: 25, now: () => (clock += 10) });
    expect(result.aligned).toBe(true);
    // Read at the start (10, deadline 35), then before each pair: 20 and 30 are in time, 40 and 50 are not.
    expect(result.stats).toEqual({ inserted: 2, deleted: 2, changed: 2, unchanged: 0 });
    expect(result.unpaired).toBe(2);
    expect(result.rows.map((r) => r.kind)).toEqual(['change', 'change', 'delete', 'insert', 'delete', 'insert']);
    // The paragraphs shown whole are the official text, complete.
    const whole = result.rows.filter((r) => r.kind === 'insert' || r.kind === 'delete').map((r) => ('block' in r ? r.block[1] : ''));
    expect(whole).toEqual([olds[2]![1], news[2]![1], olds[3]![1], news[3]![1]]);
  });

  it('with no time left, compares no words but still keeps every paragraph', () => {
    let clock = 0;
    const result = diffBlocks(before, after, { timeoutMs: 1, now: () => (clock += 5) });
    expect(result.unpaired).toBe(1);
    expect(result.stats.changed).toBe(0);
    expect(result.rows.some((r) => r.kind === 'change')).toBe(false);
    expect(result.stats.unchanged).toBe(2);
  });

  it('with the default clock and limit, an ordinary comparison is complete', () => {
    expect(diffBlocks(before, after).unpaired).toBe(0);
  });

  it('handles an empty side', () => {
    expect(diffBlocks([], after).stats).toEqual({ inserted: after.length, deleted: 0, changed: 0, unchanged: 0 });
    expect(diffBlocks(before, []).stats).toEqual({ inserted: 0, deleted: before.length, changed: 0, unchanged: 0 });
    expect(isIdentical(diffBlocks([], []))).toBe(true);
  });
});

describe('blockSimilarity', () => {
  it('is 1 for the same words, 0 for no shared words, and ignores case and punctuation', () => {
    expect(blockSimilarity('The Count.', 'the count')).toBe(1);
    expect(blockSimilarity('alpha beta', 'gamma delta')).toBe(0);
    expect(blockSimilarity('', '')).toBe(1);
    expect(blockSimilarity('a b c d', 'a b')).toBe(0.5);
  });
});

describe('segmentDiff', () => {
  it('keeps one line of context around changes and folds the rest', () => {
    const long: TextBlock[] = Array.from({ length: 10 }, (_, i) => ['p', `Paragraph number ${i} stays the same.`] as TextBlock);
    const edited = long.map((b, i) => (i === 5 ? (['p', 'Paragraph number 5 stays almost the same.'] as TextBlock) : b));
    const segments = segmentDiff(diffBlocks(long, edited).rows);
    expect(segments.map((s) => s.type)).toEqual(['unchanged', 'changes', 'unchanged']);
    expect(segments.map((s) => s.rows.length)).toEqual([4, 3, 3]);
    expect(segments[1]!.rows.reduce((n, s) => n + (s.kind === 'equal' ? 0 : 1), 0)).toBeGreaterThan(0);
  });

  it('returns a single unchanged segment for identical versions', () => {
    const segments = segmentDiff(diffBlocks(before, before).rows);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.type).toBe('unchanged');
  });
});

describe('mergeWordRuns', () => {
  const earlier = (parts: WordPart[]) => parts.filter((p) => !p.added).map((p) => p.value).join('');
  const later = (parts: WordPart[]) => parts.filter((p) => !p.removed).map((p) => p.value).join('');
  /** The text as a reader sees it, with removals in [-…-] and additions in {+…+}; spaces at the edge of a change are shown outside it. */
  const shown = (parts: WordPart[]) => parts.map((p) => {
    if (!p.added && !p.removed) return p.value;
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(p.value)!;
    return `${lead}${p.added ? `{+${core}+}` : `[-${core}-]`}${trail}`;
  }).join('');
  const merge = (a: string, b: string) => mergeWordRuns(diffWordsWithSpace(a, b));
  // Synthetic sentences, invented for these tests.
  const pairs: Array<[string, string]> = [
    ['voters who have not yet cast it may', 'voters who have not submitted it may'],
    ['no later than three days after election day.', 'no later than seven days after election day.'],
    ['the quick brown fox jumps', 'the slow red fox leaps high'],
    ['Section 5.', 'Section 6.'],
    ['A ballot is counted.', 'Each mail ballot is counted promptly.'],
    ['Yet cast it', 'Submitted it'],
    ['', 'Added text'],
    ['Removed text', ''],
  ];

  it('makes one replacement of alternating deletions and insertions, without adding a space between them', () => {
    expect(shown(merge(...pairs[0]!))).toBe('voters who have not [-yet cast-]{+submitted+} it may');
    expect(shown(merge(...pairs[1]!))).toBe('no later than [-three-]{+seven+} days after election day.');
    expect(shown(merge(...pairs[2]!))).toBe('the [-quick brown-]{+slow red+} fox [-jumps-]{+leaps high+}');
    expect(shown(merge(...pairs[3]!))).toBe('Section [-5-]{+6+}.');
  });

  it('never adds a space that is in neither text (a section number stays whole)', () => {
    // The page sets a removal apart from the addition after it with a margin; the text itself gains nothing.
    const parts = merge('Section 1385.01 of the', 'Section 89517.5 of the');
    expect(shown(parts)).toBe('Section [-1385-]{+89517+}.[-01-]{+5+} of the');
    expect(earlier(parts)).toBe('Section 1385.01 of the');
    expect(later(parts)).toBe('Section 89517.5 of the');
  });

  it('still spells both official texts exactly', () => {
    for (const [a, b] of pairs) {
      const parts = merge(a, b);
      expect(earlier(parts)).toBe(a);
      expect(later(parts)).toBe(b);
    }
  });

  it('leaves a pure insertion or deletion alone', () => {
    expect(shown(merge('A ballot is counted.', 'A mail ballot is counted.'))).toBe('A {+mail+} ballot is counted.');
    expect(shown(merge('A mail ballot is counted.', 'A ballot is counted.'))).toBe('A [-mail-] ballot is counted.');
  });

  it('is used for edited paragraphs', () => {
    const result = diffBlocks([['p', 'Ballots that voters have not yet cast it may return.']], [['p', 'Ballots that voters have not submitted it may return.']]);
    const change = result.rows[0]!;
    expect(change.kind).toBe('change');
    if (change.kind !== 'change') return;
    expect(change.words.filter((w) => w.removed).map((w) => w.value.trim())).toEqual(['yet cast']);
    expect(change.words.filter((w) => w.added).map((w) => w.value.trim())).toEqual(['submitted']);
  });
});
