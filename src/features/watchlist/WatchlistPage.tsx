import { useEffect, useRef, useState } from 'react';
import { formatDateTime, plural } from '../../lib/format';
import { buildHash } from '../../lib/router';
import { clearWatchlist, storageAvailable, toggleWatch, useWatchlist, type WatchItem } from '../../lib/watchlist';
import { A, Empty, Section, TypeMark } from '../../components/ui';

function itemHash(item: WatchItem): string {
  if (item.type === 'case') return buildHash(['litigation', item.id]);
  if (item.type === 'bill') return buildHash(['laws', item.id]);
  return buildHash(['place', item.id]);
}

const KIND: Readonly<Record<WatchItem['type'], 'case' | 'bill' | 'place'>> = { case: 'case', bill: 'bill', place: 'place' };

/**
 * Where keyboard focus goes after an item is removed (its Remove button goes with it): the Remove button of the item
 * that took its place, or of the new last item, or the page heading once the list is empty.
 */
export function focusAfterRemoval(list: HTMLElement | null, index: number): void {
  const buttons = list ? [...list.querySelectorAll<HTMLButtonElement>('button[data-remove]')] : [];
  const next = buttons[Math.min(index, buttons.length - 1)];
  if (next) next.focus();
  else document.querySelector<HTMLElement>('main h1[tabindex="-1"]')?.focus();
}

/**
 * Whether this copy of the site is served from a github.io address. Every site published there by the same account or
 * organisation shares one browser origin, so each can read and change what the others keep in the browser.
 */
export function onSharedGithubOrigin(hostname: string): boolean {
  return /(^|\.)github\.io$/i.test(hostname);
}

export function WatchlistPage() {
  const items = useWatchlist();
  const list = useRef<HTMLUListElement | null>(null);
  // The position of an item just removed, so focus can move once the list has re-rendered without it.
  const [removedAt, setRemovedAt] = useState<number | null>(null);
  useEffect(() => {
    if (removedAt === null) return;
    focusAfterRemoval(list.current, removedAt);
    setRemovedAt(null);
  }, [removedAt, items]);
  const shared = typeof window !== 'undefined' && onSharedGithubOrigin(window.location.hostname);
  return (
    <article className="view view-wide view-doc">
      <header className="view-head">
        <TypeMark type="data" label="Watchlist" />
        <h1 tabIndex={-1}>Your watchlist</h1>
        <p className="lede">A list of places, cases and measures you want to come back to.</p>
        <p className="coverage-note">
          This list is saved only in this browser on this device. It does not sync anywhere, it is not sent to any server, and it does not send alerts. Clearing your browser data removes it.
          {shared ? ' This copy of the site is served from a github.io address: other sites served from the same github.io address can read and change the list.' : null}
        </p>
      </header>
      {!storageAvailable() ? (
        <Empty title="This browser is blocking local storage, so a watchlist cannot be kept here.">
          <p>You can still bookmark any page: every view has its own link.</p>
        </Empty>
      ) : items.length === 0 ? (
        <Empty title="Nothing on your watchlist yet.">
          <p>Open a place, a case or a measure and choose &ldquo;Add to watchlist&rdquo;.</p>
          <p><A to={buildHash(['litigation'])}>Browse court cases</A> or <A to={buildHash(['laws'])}>browse legislation</A>.</p>
        </Empty>
      ) : (
        <Section title={plural(items.length, 'saved item')}>
          <ul className="rows" ref={list}>
            {items.map((item, index) => (
              <li key={`${item.type}:${item.id}`} className="row row-split">
                <div>
                  <TypeMark type={KIND[item.type]} />
                  <p className="row-title"><a className={item.type === 'case' ? 'case-name' : undefined} href={itemHash(item)}>{item.label}</a></p>
                  <p className="row-foot">Added {formatDateTime(item.addedAt)}</p>
                </div>
                <button type="button" className="btn btn-quiet" data-remove="" onClick={() => { if (toggleWatch(item)) setRemovedAt(index); }}>Remove<span className="sr-only"> {item.label}</span></button>
              </li>
            ))}
          </ul>
          <p><button type="button" className="btn" onClick={() => { if (window.confirm('Remove every item from the watchlist on this device?') && clearWatchlist()) setRemovedAt(0); }}>Clear the watchlist</button></p>
        </Section>
      )}
    </article>
  );
}
