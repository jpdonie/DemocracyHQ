// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataError } from '../../src/lib/data';
import { allOf, mapLoadable, useLoad, type Loadable } from '../../src/lib/useLoad';
import { Async } from '../../src/components/ui';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let unique = 0;
/** useLoad remembers every resolved key for the page's lifetime, so each test uses keys of its own. */
const key = (name: string) => `test-${name}-${(unique += 1)}`;

afterEach(cleanup);

describe('useLoad', () => {
  it('a change of key while the first request is in flight never shows the first key\'s result', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const keyA = key('a');
    const keyB = key('b');
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLoad(id, () => (id === keyA ? a.promise : b.promise)), { initialProps: { id: keyA } });
    expect(result.current).toEqual({ status: 'loading' });

    rerender({ id: keyB });
    expect(result.current).toEqual({ status: 'loading' });

    // The first request finishes late: it must not appear under the second key.
    await act(async () => { a.resolve('A'); await a.promise; });
    expect(result.current).toEqual({ status: 'loading' });

    await act(async () => { b.resolve('B'); await b.promise; });
    expect(result.current).toEqual({ status: 'ready', data: 'B' });

    // Going back to the first key shows its data (it did load), not the second key's.
    rerender({ id: keyA });
    expect(result.current).toEqual({ status: 'ready', data: 'A' });
  });

  it('a late failure of an abandoned request does not replace the current data with an error', async () => {
    const a = deferred<string>();
    const keyA = key('a');
    const keyB = key('b');
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLoad(id, () => (id === keyA ? a.promise : Promise.resolve('B'))), { initialProps: { id: keyA } });
    rerender({ id: keyB });
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual({ status: 'ready', data: 'B' });
    await act(async () => { a.reject(new DataError('network', 'a.json', 'a.json returned HTTP 503.')); await a.promise.catch(() => undefined); });
    expect(result.current).toEqual({ status: 'ready', data: 'B' });
  });

  it('reports an error, and a later visit tries again instead of remembering the failure', async () => {
    const id = key('retry');
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      if (attempts === 1) throw new DataError('network', 'x.json', 'x.json returned HTTP 503.');
      return 'loaded';
    };
    const first = renderHook(() => useLoad(id, load));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current.status).toBe('error');
    expect((first.result.current as { error: DataError }).error.kind).toBe('network');
    first.unmount();

    const second = renderHook(() => useLoad(id, load));
    expect(second.result.current).toEqual({ status: 'loading' });
    await act(async () => { await Promise.resolve(); });
    expect(second.result.current).toEqual({ status: 'ready', data: 'loaded' });
    expect(attempts).toBe(2);
  });

  it('wraps an error that is not a DataError, so every view can show it', async () => {
    const id = key('plain');
    const { result } = renderHook(() => useLoad(id, async () => { throw new Error('boom'); }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('error');
    expect((result.current as { error: DataError }).error).toBeInstanceOf(DataError);
  });

  it('a null key loads nothing and stays loading', () => {
    let calls = 0;
    const { result } = renderHook(() => useLoad(null, async () => { calls += 1; return 1; }));
    expect(result.current).toEqual({ status: 'loading' });
    expect(calls).toBe(0);
  });
});

describe('combining loadable files', () => {
  const error = new DataError('network', 'b.json', 'b.json returned HTTP 503.');
  const ready = <T,>(data: T): Loadable<T> => ({ status: 'ready', data });

  it('is ready only when every part is, and reports a failure even while another part is loading', () => {
    expect(allOf(ready(1), ready('x'))).toEqual({ status: 'ready', data: [1, 'x'] });
    expect(allOf(ready(1), { status: 'loading' })).toEqual({ status: 'loading' });
    expect(allOf({ status: 'loading' }, { status: 'error', error })).toEqual({ status: 'error', error });
  });

  it('maps ready data and passes loading and error through unchanged', () => {
    expect(mapLoadable(ready([1, 2]), (list) => list.length)).toEqual({ status: 'ready', data: 2 });
    expect(mapLoadable({ status: 'loading' } as Loadable<number[]>, (list) => list.length)).toEqual({ status: 'loading' });
    expect(mapLoadable({ status: 'error', error } as Loadable<number[]>, (list) => list.length)).toEqual({ status: 'error', error });
  });
});

describe('loading and error rendering', () => {
  it('shows "Loading", then an error note with the reason, and never the content', () => {
    const view = (of: Loadable<string[]>) => <Async of={of} what="the links">{(list) => <p>{list.length === 0 ? 'No links' : list.join(', ')}</p>}</Async>;
    const { rerender } = render(view({ status: 'loading' }));
    expect(screen.getByRole('status').textContent).toBe('Loading the links');
    expect(screen.queryByText('No links')).toBeNull();

    rerender(view({ status: 'error', error: new DataError('network', 'relationships.json', 'relationships.json returned HTTP 503.') }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not load the links.');
    expect(alert.textContent).toContain('relationships.json returned HTTP 503.');
    expect(screen.queryByText('No links')).toBeNull();

    rerender(view({ status: 'ready', data: [] }));
    expect(screen.getByText('No links')).toBeTruthy();
  });
});
