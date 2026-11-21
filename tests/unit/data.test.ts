import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkForNewRelease, clearDataCache, dataUrl, DataError, fetchJson, loadBill, loadBoundaries, loadCase, loadCaseIndex, loadManifest, loadVersionText, parseWith, releaseToken,
} from '../../src/lib/data';
import { ManifestSchema } from '../../src/types/schemas';
import { makeManifest } from './fixtures';

const respond = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  clearDataCache();
  vi.unstubAllGlobals();
});

describe('loading data files', () => {
  it('requests files relative to the site, so a sub-path deployment works', async () => {
    const calls: string[] = [];
    await fetchJson('manifest.json', (async (url: string) => { calls.push(url); return respond({}); }) as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\.?\/data\/manifest\.json$/);
  });

  it('reports a missing file, a server error, a network failure and broken JSON as different errors', async () => {
    const kind = async (impl: () => Promise<Response>) => fetchJson('x.json', impl as typeof fetch).then(() => 'ok', (e: DataError) => e.kind);
    expect(await kind(async () => respond({}, 404))).toBe('not_found');
    expect(await kind(async () => respond({}, 503))).toBe('network');
    expect(await kind(async () => { throw new TypeError('offline'); })).toBe('network');
    expect(await kind(async () => respond('<html>not json'))).toBe('invalid');
  });

  it('rejects a file that fails validation instead of showing part of it', () => {
    const broken = { ...makeManifest(), counts: { cases: 'many' } };
    expect(() => parseWith(ManifestSchema, 'manifest.json', broken)).toThrowError(/manifest\.json failed validation \(counts\.cases: .*\)\. It is not shown\./);
    try {
      parseWith(ManifestSchema, 'manifest.json', broken);
    } catch (error) {
      expect(error).toBeInstanceOf(DataError);
      expect((error as DataError).kind).toBe('invalid');
    }
    expect(parseWith(ManifestSchema, 'manifest.json', makeManifest()).counts.cases).toBe(1);
  });

  it('caches a successful load and retries after a failure', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1 ? respond({}, 503) : respond(makeManifest());
    });
    await expect(loadManifest()).rejects.toMatchObject({ kind: 'network' });
    expect((await loadManifest()).schemaVersion).toBe(1);
    await loadManifest();
    expect(calls).toBe(2);
  });

  it('refuses record identifiers and text paths that could reach outside the data folder', async () => {
    const fetchSpy = vi.fn(async () => respond({}));
    vi.stubGlobal('fetch', fetchSpy);
    for (const id of ['../manifest', 'a/b', 'a%2Fb', 'x.json', '']) {
      await expect(loadCase(id)).rejects.toMatchObject({ kind: 'not_found' });
      await expect(loadBill(id)).rejects.toMatchObject({ kind: 'not_found' });
    }
    for (const path of ['legislation/text/../../manifest.json', 'https://example.test/x.json', 'legislation/bills/x.json', '/etc/passwd']) {
      await expect(loadVersionText(path)).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('data releases', () => {
  const calls: Array<{ url: string; cache: RequestCache | undefined }> = [];
  const stubFetch = (manifest: () => Response | Promise<Response>, other: (url: string) => Response = () => respond({ cases: [] })) => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, cache: init?.cache });
      return url.endsWith('/manifest.json') ? manifest() : other(url);
    });
  };

  it('revalidates the manifest with the server and requests every other file for the release it names', async () => {
    stubFetch(() => respond({ ...makeManifest(), contentHash: 'abc123' }));
    await loadCaseIndex();
    expect(calls).toEqual([
      { url: expect.stringMatching(/^\.?\/data\/manifest\.json$/), cache: 'no-cache' },
      { url: expect.stringMatching(/^\.?\/data\/litigation\/index\.json\?v=abc123$/), cache: undefined },
    ]);
  });

  it('versions boundary files too', async () => {
    stubFetch(() => respond({ ...makeManifest(), contentHash: 'abc123' }), () => respond({ type: 'Topology', objects: {}, arcs: [] }));
    await expect(loadBoundaries('state', 'geo/states.topo.json', 'states')).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls.map((c) => c.url)[1]).toMatch(/\/data\/geo\/states\.topo\.json\?v=abc123$/);
  });

  it('falls back to the release time when the manifest has no content hash', async () => {
    expect(releaseToken({ contentHash: '', generatedAt: '2026-11-20T13:08:27Z' })).toBe('2026-11-20T13:08:27Z');
    expect(releaseToken({ contentHash: 'abc', generatedAt: '2026-11-20T13:08:27Z' })).toBe('abc');
    stubFetch(() => respond({ ...makeManifest(), contentHash: '' }));
    await loadCaseIndex();
    expect(calls[1]!.url).toMatch(new RegExp(`litigation/index\\.json\\?v=${encodeURIComponent(makeManifest().generatedAt)}$`));
  });

  it('still loads other files, without a release token, when the manifest cannot be loaded', async () => {
    stubFetch(() => respond({}, 503));
    await loadCaseIndex();
    expect(calls.map((c) => c.url)[1]).toMatch(/\/data\/litigation\/index\.json$/);
  });

  it('notices a newer release published after the page opened, and only then', async () => {
    let hash = 'first';
    stubFetch(() => respond({ ...makeManifest(), contentHash: hash }));
    await loadCaseIndex();
    expect(await checkForNewRelease()).toBeNull();
    hash = 'second';
    expect((await checkForNewRelease())?.contentHash).toBe('second');
    expect(calls.filter((c) => c.url.endsWith('/manifest.json')).every((c) => c.cache === 'no-cache')).toBe(true);
    // A failed check says nothing rather than claiming an update.
    stubFetch(() => respond({}, 503));
    expect(await checkForNewRelease()).toBeNull();
  });

  it('builds the address with and without a release', () => {
    expect(dataUrl('events.json')).toMatch(/\/data\/events\.json$/);
    expect(dataUrl('events.json', 'a b')).toMatch(/\/data\/events\.json\?v=a%20b$/);
  });
});
