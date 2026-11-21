/**
 * Hooks for the browser tests, such as the map object on `window.__dhqMap`. They exist only in the dev server and in the
 * browser-test build (`vite build --mode e2e`, see playwright.config.ts), never in the production build, whatever the
 * address of the page. The values are fixed at build time, so a production bundle does not contain the hooks at all.
 */
export function testHooksEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === 'e2e';
}
