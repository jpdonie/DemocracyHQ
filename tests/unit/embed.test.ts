/**
 * The site inside another page: when the embedded form is asked for, where its link out leads, and the markup of
 * the frame.
 */
import { describe, expect, it } from 'vitest';
import { embedCode, embedUrl, fullSiteUrl, isEmbedded } from '../../src/lib/embed';

describe('the embedded form', () => {
  it('is asked for by "embed" before the #, and by nothing else', () => {
    expect(isEmbedded('?embed=1')).toBe(true);
    expect(isEmbedded('?embed')).toBe(true);
    expect(isEmbedded('?e2e&embed=1')).toBe(true);
    expect(isEmbedded('')).toBe(false);
    expect(isEmbedded('?embed=0')).toBe(false);
    expect(isEmbedded('?embed=false')).toBe(false);
    expect(isEmbedded('?embedded=1')).toBe(false);
  });

  it('leads out to the same view on the full site, without "embed"', () => {
    const at = { origin: 'https://example.test', pathname: '/site/', search: '?embed=1' };
    expect(fullSiteUrl('#/place/state:22?shade=party', at)).toBe('https://example.test/site/#/place/state:22?shade=party');
    expect(fullSiteUrl('#/', { ...at, search: '?embed=1&x=2' })).toBe('https://example.test/site/?x=2#/');
    expect(fullSiteUrl('#/litigation', { ...at, search: '' })).toBe('https://example.test/site/#/litigation');
  });

  it('writes the markup of a frame, with a title that cannot leave its attribute', () => {
    const at = { origin: 'https://example.test', pathname: '/' };
    expect(embedUrl('#/litigation', at)).toBe('https://example.test/?embed=1#/litigation');
    const code = embedCode('#/', 'A "quoted" <name> & more', at);
    expect(code.startsWith('<iframe src="https://example.test/?embed=1#/" ')).toBe(true);
    expect(code).toContain('title="A &quot;quoted&quot; &lt;name> &amp; more"');
    expect(code.endsWith('></iframe>')).toBe(true);
  });
});
