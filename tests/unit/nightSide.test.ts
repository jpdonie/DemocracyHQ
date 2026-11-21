/**
 * The night side: the top bar, the map stage and the title block of a page carry their own values of the colour
 * tokens (tokens.css). The automated accessibility checks in the browser cannot decide the contrast of text that
 * stands on a painted band or over the map, so the pairs are measured here, from the tokens themselves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/lib/mapTheme';

// Read from the folder the tests are run in: under jsdom the address of this module is not a file address.
const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
const start = css.indexOf('@media screen {');
const day = css.slice(0, start);
const night = css.slice(start);

/** The value of a token in a part of the file, with a reference to another token followed once. */
function token(part: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6}|var\\((--[a-z0-9-]+)\\))`, 'i').exec(part);
  if (!match) throw new Error(`no colour token ${name}`);
  return match[2] ? token(day, match[2]) : match[1]!;
}

const GROUNDS = ['--sheet', '--surface', '--sunk'];
const TEXT = ['--ink', '--ink-2', '--ink-3', '--geo', '--law', '--case', '--data', '--stale', '--error'];

describe('the night side', () => {
  it('is found in the tokens', () => {
    expect(start).toBeGreaterThan(0);
    expect(token(night, '--sheet')).toBe(token(day, '--night-2'));
  });

  it('keeps every text colour at 4.5 to 1 or more on each of its grounds', () => {
    for (const ground of GROUNDS) {
      for (const text of TEXT) {
        expect(contrastRatio(token(night, text), token(night, ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the text of a pressed button and of the tooltip readable on the light ink', () => {
    for (const ground of ['--ink', '--ink-hover']) {
      for (const text of ['--on-ink', '--on-ink-2']) {
        expect(contrastRatio(token(night, text), token(night, ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('draws rules of controls and the focus ring at 3 to 1 or more', () => {
    for (const ground of GROUNDS) {
      expect(contrastRatio(token(night, '--focus'), token(night, ground)), `--focus on ${ground}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(token(night, '--rule-strong'), token(night, ground)), `--rule-strong on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the white of the top bar readable on its ground', () => {
    expect(contrastRatio('#ffffff', token(day, '--night'))).toBeGreaterThanOrEqual(7);
  });
});
