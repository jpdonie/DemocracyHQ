import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Social-card crawlers need an absolute image address, but the site is built to work
 * under any path, so the address is only known at deploy time. When `VITE_SITE_URL`
 * is set (the Pages workflow sets it), the card image and page address in
 * `index.html` are made absolute. Without it the relative address is left alone.
 */
function absoluteSocialCard(): Plugin {
  return {
    name: 'dhq-absolute-social-card',
    transformIndexHtml(html) {
      const site = (process.env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '');
      if (!/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(site)) return html;
      return html
        .replace('content="brand/social-card.png"', `content="${site}/brand/social-card.png"`)
        .replace('<meta property="og:type"', `<meta property="og:url" content="${site}/" />\n    <meta property="og:type"`);
    },
  };
}

/**
 * The Content-Security-Policy and referrer policy of the built site. GitHub Pages cannot send response headers, so they
 * are meta tags. Everything the site loads (scripts, styles, fonts, data, the map's worker) comes from its own address,
 * and images may also be data: URLs. (MapLibre turns its worker into a blob: URL only when the worker file is on another
 * origin; here it is served next to the page.) Nothing may be framed, posted or used as a base URL.
 * (frame-ancestors cannot be set from a meta tag.) The dev server is left without them: it injects inline scripts.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function securityPolicy(): Plugin {
  return {
    name: 'dhq-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      const tags = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />\n    <meta name="referrer" content="no-referrer" />`;
      // Right after the charset, before anything the page loads.
      if (!html.includes('<meta charset="utf-8" />')) throw new Error('index.html: the charset meta tag the security policy follows is missing');
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    ${tags}`);
    },
  };
}

// `base: './'` keeps every asset and data URL relative, so the same build works at
// a domain root, under a GitHub Pages project subpath (/<repo>/) and from a preview
// server. Routing uses the URL hash, so deep links never need server rewrites.
export default defineConfig({
  base: './',
  plugins: [react(), absoluteSocialCard(), securityPolicy()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
    // The minifier drops licence comments, so the notices of every bundled package are written to one file next to
    // index.html. Not the default .vite/license.md: the Pages upload leaves out hidden folders.
    license: { fileName: 'third-party-licenses.md' },
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (id.includes('node_modules/zod')) return 'zod';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    globals: false,
  },
});
