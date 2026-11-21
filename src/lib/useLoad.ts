import { useEffect, useState } from 'react';
import { DataError } from './data';

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: DataError };

const resolved = new Map<string, unknown>();

function toDataError(error: unknown, key: string): DataError {
  return error instanceof DataError ? error : new DataError('invalid', key, error instanceof Error ? error.message : String(error));
}

/**
 * Load a data file and expose loading / ready / error explicitly, so every view
 * has to decide what to show in each state. `key` identifies the request; when
 * it changes the hook reports "loading" again until the new data arrives.
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Loadable<T> {
  const [state, setState] = useState<{ key: string | null; value: Loadable<T> }>(() => ({
    key,
    value: key !== null && resolved.has(key) ? { status: 'ready', data: resolved.get(key) as T } : { status: 'loading' },
  }));

  useEffect(() => {
    if (key === null) return undefined;
    if (resolved.has(key)) {
      setState({ key, value: { status: 'ready', data: resolved.get(key) as T } });
      return undefined;
    }
    let cancelled = false;
    setState({ key, value: { status: 'loading' } });
    load().then(
      (data) => {
        resolved.set(key, data);
        if (!cancelled) setState({ key, value: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, value: { status: 'error', error: toDataError(error, key) } });
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is intentionally not a dependency: `key` fully identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (state.key !== key) {
    return key !== null && resolved.has(key) ? { status: 'ready', data: resolved.get(key) as T } : { status: 'loading' };
  }
  return state.value;
}

/** Test hook: forget every resolved key, as on a fresh page. */
export function clearResolvedLoads(): void {
  resolved.clear();
}

export function dataOf<T>(loadable: Loadable<T>): T | null {
  return loadable.status === 'ready' ? loadable.data : null;
}

/** The same state with the data transformed when it is ready. */
export function mapLoadable<T, U>(loadable: Loadable<T>, transform: (data: T) => U): Loadable<U> {
  return loadable.status === 'ready' ? { status: 'ready', data: transform(loadable.data) } : loadable;
}

type ReadyAll<T extends readonly Loadable<unknown>[]> = { [K in keyof T]: T[K] extends Loadable<infer V> ? V : never };

/**
 * Several files needed together: an error as soon as any of them failed (it will not become ready), otherwise loading
 * until all are ready.
 */
export function allOf<T extends readonly Loadable<unknown>[]>(...loadables: T): Loadable<ReadyAll<T>> {
  for (const loadable of loadables) if (loadable.status === 'error') return loadable;
  if (loadables.some((loadable) => loadable.status === 'loading')) return { status: 'loading' };
  return { status: 'ready', data: loadables.map((loadable) => (loadable as { data: unknown }).data) as ReadyAll<T> };
}
