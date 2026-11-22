#!/usr/bin/env node
/**
 * Draws the contour plate of the night side: src/assets/contours.svg.
 *
 * The site's inks come from the separations of a topographic quadrangle (tokens.css), and the dark ground of the map
 * stage and of each page's title block carries that sheet's last plate: contour lines. They are not a map of any
 * place and say nothing about the records. They are a seeded field: the same seed draws the same plate, so a build
 * never changes the picture, and a new seed is a new terrain.
 *
 * The field is a sum of a few octaves of smooth value noise, bent by a second field (a domain warp), so the lines run
 * like worn hills rather than like a pattern. Marching squares traces each level; the segments are joined into lines
 * and every fifth level is an index contour, drawn a little brighter, as a survey sheet draws it.
 *
 *   node scripts/contours.mjs [seed]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SEED = Number(process.argv[2] ?? 1965);
const W = 1600;
const H = 1000;
const COLS = 160;
const ROWS = 100;
const LEVELS = 22;

/** mulberry32: a small seeded generator, so the plate is the same on every machine. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on a lattice of random heights, eased between lattice points. */
function valueNoise(random, size = 64) {
  const lattice = Array.from({ length: size * size }, random);
  const at = (x, y) => lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = ease(x - x0);
    const fy = ease(y - y0);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

function fbm(noise, x, y, octaves = 5) {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * noise(x * frequency, y * frequency);
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return sum;
}

const random = generator(SEED);
const base = valueNoise(random);
const warpX = valueNoise(random);
const warpY = valueNoise(random);

/** The height of the terrain at a point of the plate, from 0 to 1 roughly. */
function height(px, py) {
  const x = px / 420;
  const y = py / 420;
  const wx = fbm(warpX, x * 0.7 + 3.1, y * 0.7 + 1.7, 3) * 2.2;
  const wy = fbm(warpY, x * 0.7 - 2.3, y * 0.7 + 4.9, 3) * 2.2;
  return fbm(base, x + wx, y + wy, 3);
}

const field = [];
let low = Infinity;
let high = -Infinity;
for (let r = 0; r <= ROWS; r += 1) {
  const row = [];
  for (let c = 0; c <= COLS; c += 1) {
    const v = height((c / COLS) * W, (r / ROWS) * H);
    low = Math.min(low, v);
    high = Math.max(high, v);
    row.push(v);
  }
  field.push(row);
}

/** Marching squares for one level: the segments where the field crosses it, as pairs of points. */
function segments(level) {
  const found = [];
  const point = (c1, r1, v1, c2, r2, v2) => {
    const t = (level - v1) / (v2 - v1);
    return [((c1 + (c2 - c1) * t) / COLS) * W, ((r1 + (r2 - r1) * t) / ROWS) * H];
  };
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const a = field[r][c];
      const b = field[r][c + 1];
      const d = field[r + 1][c];
      const e = field[r + 1][c + 1];
      const edges = [];
      if ((a < level) !== (b < level)) edges.push(point(c, r, a, c + 1, r, b));
      if ((b < level) !== (e < level)) edges.push(point(c + 1, r, b, c + 1, r + 1, e));
      if ((d < level) !== (e < level)) edges.push(point(c, r + 1, d, c + 1, r + 1, e));
      if ((a < level) !== (d < level)) edges.push(point(c, r, a, c, r + 1, d));
      if (edges.length === 2) found.push([edges[0], edges[1]]);
      else if (edges.length === 4) found.push([edges[0], edges[1]], [edges[2], edges[3]]);
    }
  }
  return found;
}

/** Joins segments that share an end into lines, so the plate is a few hundred paths rather than many thousand. */
function chains(parts) {
  const key = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;
  const ends = new Map();
  parts.forEach((segment, i) => {
    for (const end of segment) {
      const k = key(end);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const used = new Set();
  const lines = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (used.has(i)) continue;
    used.add(i);
    const line = [...parts[i]];
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) ?? []).find((j) => !used.has(j));
        if (next === undefined) break;
        used.add(next);
        const [p, q] = parts[next];
        const other = key(p) === key(tip) ? q : p;
        if (forward) line.push(other);
        else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A line as path data, its points rounded to the pixel. */
function pathOf(line) {
  const kept = line;
  return kept.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${Math.round(x)} ${Math.round(y)}`).join('').replace(/L(\d+) (\d+)(?=L|$)/g, ' $1 $2');
}

const minor = [];
const index = [];
for (let i = 1; i < LEVELS; i += 1) {
  const level = low + ((high - low) * i) / LEVELS;
  const lines = chains(segments(level)).filter((line) => line.length > 12);
  (i % 5 === 0 ? index : minor).push(...lines.map(pathOf));
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<!-- Drawn by scripts/contours.mjs, seed ${SEED}. Not a map of any place. -->
<g fill="none" stroke="#c9d6f0" stroke-linejoin="round" stroke-linecap="round">
<path stroke-opacity=".075" stroke-width="1" d="${minor.join('')}"/>
<path stroke-opacity=".14" stroke-width="1.4" d="${index.join('')}"/>
</g>
</svg>
`;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/assets/contours.svg');
writeFileSync(out, svg);
console.log(`Wrote ${out}: ${minor.length} contour lines and ${index.length} index contours, ${(svg.length / 1024).toFixed(0)} KB`);
