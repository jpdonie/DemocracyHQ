/**
 * Local watchlist. Stored only in this browser's localStorage: it does not
 * sync between devices and nothing is sent to a server. There are no alerts.
 */
import { useSyncExternalStore } from 'react';

export interface WatchItem {
  type: 'case' | 'bill' | 'place' | 'court';
  id: string;
  label: string;
  addedAt: string;
}

const STORAGE_KEY = 'dhq.watchlist.v1';
const EVENT = 'dhq:watchlist';

function isItem(value: unknown): value is WatchItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.type === 'case' || v.type === 'bill' || v.type === 'place' || v.type === 'court') && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.addedAt === 'string';
}

export function parseWatchlist(raw: string | null): WatchItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, 500) : [];
  } catch {
    return [];
  }
}

let cacheRaw: string | null | undefined;
let cacheItems: WatchItem[] = [];

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage can be blocked; the watchlist is then simply unavailable
  }
}

export function readWatchlist(): WatchItem[] {
  const raw = storage()?.getItem(STORAGE_KEY) ?? null;
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheItems = parseWatchlist(raw);
  }
  return cacheItems;
}

function write(items: WatchItem[]): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(EVENT));
  return true;
}

export function isWatched(items: readonly WatchItem[], type: WatchItem['type'], id: string): boolean {
  return items.some((item) => item.type === type && item.id === id);
}

export function toggleWatch(item: Omit<WatchItem, 'addedAt'>, nowIso: string = new Date().toISOString()): boolean {
  const items = readWatchlist();
  if (isWatched(items, item.type, item.id)) return write(items.filter((i) => !(i.type === item.type && i.id === item.id)));
  return write([{ ...item, addedAt: nowIso }, ...items]);
}

export function clearWatchlist(): boolean {
  return write([]);
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function useWatchlist(): WatchItem[] {
  return useSyncExternalStore(subscribe, readWatchlist, () => []);
}

export function storageAvailable(): boolean {
  return storage() !== null;
}
