// @vitest-environment jsdom
/**
 * Version comparison against the real mirrored bill text in public/data: for every two consecutive mirrored versions of
 * every measure, the comparison as the page renders it must read, without its added text, as the earlier version, and
 * without its removed text, as the later version (apart from runs of whitespace). No space may appear that is in
 * neither text, and nothing may be lost or repeated.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { diffBlocks } from '../../src/lib/diff';
import { DiffRowView } from '../../src/features/legislation/VersionCompare';
import type { TextBlock } from '../../src/types/schemas';

const DATA = join(__dirname, '../../public/data');

interface VersionRef { id: string; versionDate: string; textAvailability: string; textPath?: string | null }

function consecutivePairs(): Array<{ bill: string; from: string; to: string; before: TextBlock[]; after: TextBlock[] }> {
  const pairs: Array<{ bill: string; from: string; to: string; before: TextBlock[]; after: TextBlock[] }> = [];
  const billDir = join(DATA, 'legislation/bills');
  for (const file of readdirSync(billDir).filter((name) => name.endsWith('.json')).sort()) {
    const bill = JSON.parse(readFileSync(join(billDir, file), 'utf8')) as { id: string; versions: VersionRef[] };
    const mirrored = bill.versions.filter((v) => v.textAvailability === 'mirrored' && v.textPath);
    const texts = mirrored.map((v) => (JSON.parse(readFileSync(join(DATA, v.textPath!), 'utf8')) as { blocks: TextBlock[] }).blocks);
    for (let i = 1; i < mirrored.length; i += 1) pairs.push({ bill: bill.id, from: mirrored[i - 1]!.id, to: mirrored[i]!.id, before: texts[i - 1]!, after: texts[i]! });
  }
  return pairs;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The rendered rows' text with the given marks taken out, one line per paragraph. */
function readingWithout(container: HTMLElement, mark: 'ins' | 'del'): string {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(mark).forEach((element) => element.remove());
  return collapse([...copy.querySelectorAll('p')].map((p) => p.textContent ?? '').join(' '));
}

describe('version comparison of the mirrored bill text', () => {
  const pairs = consecutivePairs();

  it('has real version pairs to check', () => {
    expect(pairs.length).toBeGreaterThan(100);
  });

  it('reads as the earlier version without its additions and as the later version without its removals, for every consecutive pair', () => {
    const failures: string[] = [];
    const interleaved: string[] = [];
    for (const pair of pairs) {
      // A generous time limit, so the result does not depend on the speed of the machine running the test.
      const result = diffBlocks(pair.before, pair.after, { timeoutMs: 60_000 });
      const name = `${pair.bill} ${pair.from} -> ${pair.to}`;
      expect(result.unpaired, name).toBe(0);
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(<>{result.rows.map((row, i) => <DiffRowView key={i} row={row} />)}</>);
      const earlier = collapse(pair.before.map((b) => b[1]).join(' '));
      const later = collapse(pair.after.map((b) => b[1]).join(' '));
      if (readingWithout(container, 'ins') !== earlier) failures.push(`${name}: the earlier text differs`);
      if (readingWithout(container, 'del') !== later) failures.push(`${name}: the later text differs`);
      // Removed and added paragraphs that are not one edited passage come as a run of removals, then a run of additions:
      // an added paragraph is never followed directly by a removed one.
      const kinds = result.rows.map((row) => row.kind);
      if (kinds.some((kind, i) => kind === 'insert' && kinds[i + 1] === 'delete')) interleaved.push(name);
    }
    expect(failures).toEqual([]);
    expect(interleaved).toEqual([]);
  }, 600_000);
});
