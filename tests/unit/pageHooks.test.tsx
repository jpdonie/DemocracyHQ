// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testHooksEnabled } from '../../src/lib/testHooks';
import { focusHeadingWhenShown } from '../../src/lib/focus';
import { ReleaseNotice } from '../../src/components/ReleaseNotice';
import { makeManifest } from './fixtures';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('test hooks', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('exist in the dev server and the browser-test build only, never in a production build', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    expect(testHooksEnabled()).toBe(false);
    // The page address plays no part: a visitor cannot switch them on with ?e2e.
    window.history.replaceState(null, '', '/?e2e#/');
    expect(testHooksEnabled()).toBe(false);
    vi.stubEnv('MODE', 'e2e');
    expect(testHooksEnabled()).toBe(true);
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('DEV', true);
    expect(testHooksEnabled()).toBe(true);
  });
});

describe('focus after moving to another view', () => {
  const frame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));
  const panel = () => {
    const main = document.createElement('main');
    main.tabIndex = -1;
    document.body.append(main);
    return main;
  };
  const heading = (text: string) => {
    const h1 = document.createElement('h1');
    h1.tabIndex = -1;
    h1.textContent = text;
    return h1;
  };

  it('focuses a heading that is already there', async () => {
    const main = panel();
    main.append(heading('Directory'));
    focusHeadingWhenShown(main, document.activeElement);
    await frame();
    expect(document.activeElement?.textContent).toBe('Directory');
  });

  it('waits for a heading that appears only after the record loads, then focuses it once', async () => {
    const main = panel();
    main.append(Object.assign(document.createElement('p'), { textContent: 'Loading this case' }));
    focusHeadingWhenShown(main, document.activeElement);
    await frame();
    expect(document.activeElement).toBe(document.body);
    const h1 = heading('Case name');
    main.append(h1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(h1);

    // A later re-render that replaces the heading does not take focus again.
    const button = document.createElement('button');
    main.append(button);
    button.focus();
    h1.remove();
    main.append(heading('Case name'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(button);
  });

  it('leaves focus alone if the reader moved it while the record was loading', async () => {
    const main = panel();
    const search = document.createElement('input');
    document.body.prepend(search);
    focusHeadingWhenShown(main, document.activeElement);
    await frame();
    search.focus();
    main.append(heading('Bill'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(search);
  });

  it('leaves focus alone if the reader moved it after the move started but before the view was rendered', async () => {
    const main = panel();
    const link = document.createElement('a');
    link.href = '#/litigation/x';
    const search = document.createElement('input');
    document.body.prepend(link, search);
    // The link had focus when the move started (the router records it); the reader then went to the search box
    // before React rendered the new view and this ran.
    link.focus();
    const startedOn = document.activeElement;
    search.focus();
    focusHeadingWhenShown(main, startedOn);
    await frame();
    main.append(heading('Case'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(search);
  });

  it('still moves focus from the control that started the move', async () => {
    const main = panel();
    const link = document.createElement('a');
    link.href = '#/litigation/x';
    document.body.prepend(link);
    link.focus();
    focusHeadingWhenShown(main, link);
    await frame();
    main.append(heading('Case'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement?.textContent).toBe('Case');
  });

  it('stops waiting when the reader moves on', async () => {
    const main = panel();
    const stop = focusHeadingWhenShown(main, document.activeElement);
    await frame();
    stop();
    main.append(heading('Too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('notice of a newer data release', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('checks when the tab comes back into view, at most once per interval, and shows a quiet notice', async () => {
    let clock = 0;
    let newer: ReturnType<typeof makeManifest> | null = null;
    const check = vi.fn(async () => newer);
    render(<ReleaseNotice check={check} minIntervalMs={1000} now={() => clock} />);
    expect(screen.getByRole('status').textContent).toBe('');

    // Too soon after the page opened: no request.
    await act(async () => { setVisibility('hidden'); setVisibility('visible'); });
    expect(check).not.toHaveBeenCalled();

    clock = 2000;
    await act(async () => { setVisibility('visible'); });
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');

    clock = 4000;
    newer = { ...makeManifest(), contentHash: 'newer', generatedAt: '2026-06-20T08:00:00Z' };
    await act(async () => { setVisibility('visible'); });
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('The data was updated');
    expect(screen.getByRole('status').textContent).toContain('reload to see the latest release');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});
