/**
 * On a phone the panel is a bottom sheet that often sits at half height, so new content can appear below the fold.
 * A view that changes what the reader is looking at (a tab, a jump to a section) raises the sheet and brings the
 * new content into view. On larger screens raising the sheet does nothing.
 */
import { createContext, useContext, type MouseEvent } from 'react';

export const RaiseSheetContext = createContext<() => void>(() => undefined);

export function useRaiseSheet(): () => void {
  return useContext(RaiseSheetContext);
}

/**
 * Scroll the panel to an element and move keyboard focus to it, or to `focus` when that is a finder, or nowhere when it
 * is false. `block: 'start'` puts the element at the top of the panel; 'nearest' scrolls only if it is out of view.
 * Runs after two frames so that a raised sheet and a newly rendered tab are laid out first.
 */
export function revealElement(
  find: () => HTMLElement | null | undefined,
  options: { focus?: boolean | (() => HTMLElement | null | undefined); block?: ScrollLogicalPosition } = {},
): void {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const element = find();
    if (!element) return;
    element.scrollIntoView({ block: options.block ?? 'start' });
    const target = options.focus === false ? null : typeof options.focus === 'function' ? options.focus() : element;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }));
}

/** A plain click: not one that opens the link in a new tab or window. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
