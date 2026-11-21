import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSITIONING } from '../../src/config';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const HEADLINE = 'Election litigation, voting laws and district boundaries, linked to their sources';

describe('the one-line description is the same everywhere', () => {
  it('matches the home page headline in the About page, index.html and package.json', () => {
    expect(read('src/features/geography/HomePanel.tsx')).toContain(`>${HEADLINE}</h1>`);
    expect(POSITIONING).toBe(`${HEADLINE}.`);
    const html = read('index.html');
    expect(html).toMatch(new RegExp(`<meta name="description" content="${HEADLINE}\\.`));
    expect(html).toMatch(new RegExp(`<meta property="og:description" content="${HEADLINE}\\.`));
    expect(html).toContain(`<p>${HEADLINE}.</p>`);
    expect(JSON.parse(read('package.json')).description).toMatch(new RegExp(`^${HEADLINE}\\.`));
  });

  it('no longer uses the earlier tagline', () => {
    for (const text of [read('index.html'), read('package.json'), POSITIONING]) expect(text).not.toMatch(/Explore the laws, litigation, and geography/);
  });
});
