#!/usr/bin/env node
/**
 * Exports frames of the "Isoline Assembly" generative study as static brand assets.
 *
 * The process itself lives in design/identity/isoline-assembly.html, between the
 * `<motif-core>` markers. This script runs that exact code in Node, so the mark,
 * the social card and the interactive piece are frames of one algorithm.
 *
 *   node design/export-motif.mjs            # writes the SVG assets and brandPaths.ts
 *   node design/export-motif.mjs --png      # also rasterises the PNGs (needs Playwright)
 *
 * Outputs
 *   src/components/brandPaths.ts            paths of the three-bench mark
 *   public/brand/mark.svg                   favicon
 *   public/brand/motif.svg                  the settled study, no frame, for page headers
 *   public/brand/social-card.png            1200 x 630 link preview            (--png)
 *   design/identity/renders/*.png           stills of the study                (--png)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(join(here, 'identity', 'isoline-assembly.html'), 'utf8');
const coreMatch = html.match(/\/\/ <motif-core>([\s\S]*?)\/\/ <\/motif-core>/);
if (!coreMatch) throw new Error('motif-core markers not found in isoline-assembly.html');
const core = new Function(`${coreMatch[1]}
  return { createAssembly, settle, ringRuns, ringHachures, ringSeats, fanBounds, runToPath, inkOf, isIndexLine };`)();

export const MARK_SEED = 1848;
export const STUDY_SEED = 1848;
const INK = { ground: '#85551b', planted: '#0c6557', revised: '#6a2c6e', navy: '#17233b', sheet: '#f1f4ef' };
const INKS = [INK.ground, INK.planted, INK.revised];
const STUDY = { rings: 24, span: 252, disturbance: 0.6, grain: 1.6, tension: 0.5, absence: 0.14, samples: 220 };

function fit(state, x, y, w, h) {
  const box = core.fanBounds(state);
  const scale = Math.min(w / (box.maxX - box.minX), h / (box.maxY - box.minY));
  const ox = x + w / 2 - ((box.minX + box.maxX) / 2) * scale;
  const oy = y + h / 2 - ((box.minY + box.maxY) / 2) * scale;
  return { scale, tx: (pt) => [ox + pt[0] * scale, oy + pt[1] * scale] };
}

/** The settled study as SVG elements inside the given box. */
function studyMarkup(seed, box, options = {}) {
  const state = core.settle(core.createAssembly({ seed, ...STUDY, ...(options.params ?? {}) }));
  const { scale, tx } = fit(state, box.x, box.y, box.w, box.h);
  const pitch = state.spacing * scale;
  const inks = options.inks ?? INKS;
  const parts = [];
  for (const ring of state.rings) {
    const ink = inks[core.inkOf(state, ring.index)];
    const hach = core.ringHachures(state, ring).map((h) => {
      const a = tx([h[0], h[1]]), b = tx([h[2], h[3]]);
      return `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
    }).join('');
    if (hach) parts.push(`<path d="${hach}" stroke="${ink}" stroke-opacity="0.59" stroke-width="${Math.max(0.9, pitch * 0.055).toFixed(2)}" fill="none"/>`);
  }
  for (const ring of state.rings) {
    const ink = inks[core.inkOf(state, ring.index)];
    const width = core.isIndexLine(ring.index) ? Math.max(2.2, pitch * 0.13) : Math.max(1.05, pitch * 0.062);
    const d = core.ringRuns(state, ring).map((run) => core.runToPath(run, tx, 1)).join('');
    if (d) parts.push(`<path d="${d}" stroke="${ink}" stroke-width="${width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
  }
  if (options.seats !== 0) {
    for (const ring of state.rings) {
      const ink = inks[core.inkOf(state, ring.index)];
      const radius = Math.max(2.2, pitch * 0.17);
      for (const seat of core.ringSeats(state, ring, options.seats ?? 0.45)) {
        const q = tx(seat);
        parts.push(`<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${radius.toFixed(2)}" fill="${ink}"/>`);
      }
    }
  }
  return parts.join('\n');
}

function neatline(w, h, outer, inner, ink, divisions = 24) {
  const parts = [
    `<rect x="${outer}" y="${outer}" width="${w - outer * 2}" height="${h - outer * 2}" fill="none" stroke="${ink}" stroke-width="1"/>`,
    `<rect x="${inner}" y="${inner}" width="${w - inner * 2}" height="${h - inner * 2}" fill="none" stroke="${ink}" stroke-width="2.4"/>`,
  ];
  let ticks = '';
  const across = Math.round(divisions * ((w - inner * 2) / (h - inner * 2)));
  for (let k = 1; k < across; k++) {
    const t = inner + ((w - inner * 2) * k) / across;
    const len = k % 6 === 0 ? inner - outer : (inner - outer) * 0.5;
    ticks += `M${t.toFixed(1)} ${inner}v${-len}M${t.toFixed(1)} ${h - inner}v${len}`;
  }
  for (let k = 1; k < divisions; k++) {
    const t = inner + ((h - inner * 2) * k) / divisions;
    const len = k % 6 === 0 ? inner - outer : (inner - outer) * 0.5;
    ticks += `M${inner} ${t.toFixed(1)}h${-len}M${w - inner} ${t.toFixed(1)}h${len}`;
  }
  parts.push(`<path d="${ticks}" stroke="${ink}" stroke-width="1" fill="none"/>`);
  return parts.join('\n');
}

/* ---------- the mark: three benches of the same process ---------- */
function markPaths() {
  const state = core.settle(core.createAssembly({ seed: MARK_SEED, rings: 3, inner: 0.4, span: 188, disturbance: 0.42, grain: 1.2, tension: 0.7, absence: 0, samples: 12 }));
  const runs = state.rings.map((ring) => core.ringRuns(state, ring));
  // Fit the drawn points themselves into the frame of the 64-unit mark.
  const pts = runs.flat(2);
  const minX = Math.min(...pts.map((q) => q[0])), maxX = Math.max(...pts.map((q) => q[0]));
  const minY = Math.min(...pts.map((q) => q[1])), maxY = Math.max(...pts.map((q) => q[1]));
  const box = { x: 12, y: 16, w: 40, h: 33 };
  const scale = Math.min(box.w / (maxX - minX), box.h / (maxY - minY));
  const ox = box.x + box.w / 2 - ((minX + maxX) / 2) * scale;
  const oy = box.y + box.h / 2 - ((minY + maxY) / 2) * scale;
  const tx = (pt) => [ox + pt[0] * scale, oy + pt[1] * scale];
  return runs.map((ringRuns) => ringRuns.map((run) => core.runToPath(run, tx, 1)).join(''));
}

const paths = markPaths();
writeFileSync(join(root, 'src', 'components', 'brandPaths.ts'),
  `// Generated by \`node design/export-motif.mjs\` from design/identity/isoline-assembly.html (seed ${MARK_SEED}). Do not edit by hand.\n`
  + `export const MARK_PATHS: string[] = [\n${paths.map((d) => `  '${d}',`).join('\n')}\n];\n`);

mkdirSync(join(root, 'public', 'brand'), { recursive: true });
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="10" fill="${INK.navy}"/>
<g transform="translate(5.1 5.1) scale(0.84)" fill="none" stroke="${INK.sheet}" stroke-linecap="round">
<rect x="2" y="2" width="60" height="60" rx="3" stroke-width="3"/>
${paths.map((d, i) => `<path d="${d}" stroke-width="${i === 0 ? 3 : 2.2}"/>`).join('\n')}
</g>
</svg>
`;
writeFileSync(join(root, 'public', 'brand', 'mark.svg'), markSvg);

const motifSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 640">
${studyMarkup(STUDY_SEED, { x: 10, y: 10, w: 880, h: 620 }, { params: { samples: 110 } })}
</svg>
`;
writeFileSync(join(root, 'public', 'brand', 'motif.svg'), motifSvg);

/* ---------- rasterised outputs ---------- */
function fontFace(family, file, weight, style = 'normal', extra = '') {
  const path = join(root, 'node_modules', '@fontsource-variable', file);
  if (!existsSync(path)) return '';
  const data = readFileSync(path).toString('base64');
  return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:${weight};font-style:${style};${extra}}`;
}

function socialCardHtml() {
  const w = 1200, h = 630;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace('Archivo', 'archivo/files/archivo-latin-wdth-normal.woff2', '100 900', 'normal', 'font-stretch:62% 125%;')}
${fontFace('Newsreader', 'newsreader/files/newsreader-latin-wght-normal.woff2', '200 800')}
html,body{margin:0;background:${INK.sheet};}
.card{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:${INK.sheet};color:${INK.navy};}
svg{position:absolute;inset:0;}
.text{position:absolute;left:84px;top:104px;width:520px;}
.name{font:700 58px/1 'Archivo',sans-serif;font-stretch:108%;letter-spacing:-0.01em;}
.line{margin-top:26px;font:400 37px/1.22 'Newsreader',serif;}
.foot{position:absolute;left:84px;bottom:84px;width:500px;font:500 21px/1.35 'Archivo',sans-serif;color:#44506a;}
</style></head><body><div class="card">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${neatline(w, h, 28, 40, INK.navy, 12)}
${studyMarkup(STUDY_SEED, { x: 610, y: 70, w: 520, h: 490 })}
</svg>
<div class="text"><div class="name">DemocracyHQ</div><div class="line">Explore the laws, litigation, and geography shaping American elections.</div></div>
<div class="foot">Free and open source. Every record links to its primary source.</div>
</div></body></html>`;
}

function studyHtml(seed) {
  const size = 1200;
  return `<!doctype html><html><body style="margin:0;background:${INK.sheet}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<rect width="${size}" height="${size}" fill="${INK.sheet}"/>
${neatline(size, size, 54, 70, INK.navy)}
${studyMarkup(seed, { x: 150, y: 150, w: 900, h: 900 })}
</svg></body></html>`;
}

if (process.argv.includes('--png')) {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    console.error('Playwright is not installed here, so the PNG files were not written. The SVG assets are up to date.');
    process.exit(0);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(socialCardHtml());
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.card').screenshot({ path: join(root, 'public', 'brand', 'social-card.png') });
  await page.setViewportSize({ width: 1200, height: 1200 });
  mkdirSync(join(here, 'identity', 'renders'), { recursive: true });
  for (const seed of [STUDY_SEED, 42, 311]) {
    await page.setContent(studyHtml(seed));
    await page.screenshot({ path: join(here, 'identity', 'renders', `isoline-assembly-seed-${seed}.png`) });
  }
  await page.setViewportSize({ width: 256, height: 256 });
  await page.setContent(`<body style="margin:0">${markSvg.replace('<svg ', '<svg width="256" height="256" ')}</body>`);
  await page.screenshot({ path: join(here, 'identity', 'renders', 'mark-256.png') });
  await browser.close();
  console.log('PNG files written.');
}
console.log(`Mark paths (${paths.length}) written from seed ${MARK_SEED}.`);
