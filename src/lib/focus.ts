import { TINY_COMPACT_QUERY } from './media';
import { findPlaceLink, type ViewPlace } from './scrollMemory';

/** Whether the page, not the panel, scrolls (the very short screen layout in app.css). */
function pageScrolls(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(TINY_COMPACT_QUERY).matches;
}

/**
 * After a move to another view, put keyboard focus on the view's heading. A record view shows its heading only once
 * its file has loaded, so this waits for the heading to appear, then focuses it once. It does nothing if the reader
 * has meanwhile put focus somewhere else (for example in the search box), and stops at the next move. Returns the
 * clean-up function.
 *
 * `startedOn` is the element that had focus when the move started (the router records it, see `moveStartedOn`). It has
 * to be recorded then, not here: this runs after React has rendered the new view, and by then the reader may already
 * have moved focus.
 */
export function focusHeadingWhenShown(panel: HTMLElement, startedOn: Element | null): () => void {
  let observer: MutationObserver | null = null;
  const tryFocus = (): boolean => {
    const heading = panel.querySelector<HTMLElement>('h1[tabindex="-1"]');
    if (!heading) return false;
    const active = document.activeElement;
    // Focus that was left on the page, on the panel, on the control that started the move, or on nothing, may move.
    const untouched = !active || active === document.body || active === panel || active === startedOn || !active.isConnected;
    if (untouched) {
      heading.focus({ preventScroll: true });
      // On a very short screen the page scrolls as one document, so the heading may start below the screen: bring it up.
      if (pageScrolls() && typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
    }
    return true;
  };
  const frame = window.requestAnimationFrame(() => {
    if (tryFocus()) return;
    observer = new MutationObserver(() => {
      if (tryFocus()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(panel, { childList: true, subtree: true });
  });
  return () => {
    window.cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}

/**
 * After Back or Forward to a view seen before: once the view is drawn (and tall enough), scroll the panel back to where
 * the reader was and put focus on the link they followed from it, or on the heading if that link is not there any
 * more. Like `focusHeadingWhenShown`, it leaves focus alone if the reader has meanwhile put it somewhere else. It stops
 * waiting after `waitMs` and then restores as far as the view allows. Returns the clean-up function.
 */
export function restorePlaceWhenShown(panel: HTMLElement, place: ViewPlace, startedOn: Element | null, waitMs = 3000): () => void {
  let observer: MutationObserver | null = null;
  let finished = false;
  const tryRestore = (force: boolean): boolean => {
    const heading = panel.querySelector<HTMLElement>('h1[tabindex="-1"]');
    if (!heading && !force) return false;
    const page = document.scrollingElement ?? document.documentElement;
    const tallEnough = panel.scrollHeight - panel.clientHeight >= place.top - 1 && page.scrollHeight - window.innerHeight >= place.windowTop - 1;
    if (!tallEnough && !force) return false;
    finished = true;
    panel.scrollTop = place.top;
    // Always, also to the top: the page may still be where the view just left had it.
    window.scrollTo({ top: place.windowTop });
    const active = document.activeElement;
    const untouched = !active || active === document.body || active === panel || active === startedOn || !active.isConnected;
    if (untouched) (findPlaceLink(panel, place.link) ?? heading)?.focus({ preventScroll: true });
    return true;
  };
  const frame = window.requestAnimationFrame(() => {
    if (tryRestore(false)) return;
    observer = new MutationObserver(() => {
      if (tryRestore(false)) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(panel, { childList: true, subtree: true });
  });
  const timer = window.setTimeout(() => {
    if (finished) return;
    observer?.disconnect();
    observer = null;
    tryRestore(true);
  }, waitMs);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    observer?.disconnect();
  };
}
