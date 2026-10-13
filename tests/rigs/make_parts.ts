/**
 * Paints every part PNG the test rigs under `tests/rigs/` need.
 *
 *     bun tests/rigs/make_parts.ts
 *
 * The PNGs are committed, so nobody needs to run this to build the rigs or run
 * the suite — it is here so the art is reproducible, the way each rigc gallery
 * rig's `make_parts.ts` is. It needs nothing but bun: the pixels are computed
 * here and written by rigc's own PNG writer (`rig-c/plate`, straight alpha,
 * filter 0 on every scanline, so the bytes are a function of this file).
 *
 * The rigs exist for what no rigc gallery rig carries and the renderer specs
 * need (CLAUDE.md, *Testing*, lists which spec reads which): a clipping
 * attachment, additive slots, a region turned on its page. The art is built
 * for the instruments that read it, not for looks:
 *
 * - **Hard stripes** on every opaque part.
 * - **Line art** — one-texel hairlines, high contrast — on three armour parts
 *   (`plate`, `greave`, `visor`) that only the figure's `detail` animation
 *   shows. They are what `tests/cut-rule.spec.ts` compares cut rules on: on
 *   smooth striped art the edge-rounded cut's half-pixel displacement is what
 *   a shift-tolerant compare sees (measured: edge 47 vs fractional 1), on line
 *   art it is the resample's blur (edge 679 vs fractional 1195 with every large
 *   part lined) — exported art is line art, which is the case that spec
 *   asserts. They are kept out of every other animation because the canvas
 *   mode samples a minified hairline differently from the browser's `<img>`
 *   downscale (6–10% of content between the two modes with every large part
 *   lined), which would swamp the parity suite's picture gate.
 * - **Odd sizes** on every figure part, so `--pack` puts regions at odd
 *   offsets and a half-resolution page cuts them at half-pixel edges — the
 *   case where the cut's edge rounding and a fractional resample differ at all
 *   (at even offsets a 0.5× page has no fractional edge, and the two rules
 *   draw the same bytes).
 * - **A soft halo** round every part, alpha falling from ~150 to 0 over a few
 *   pixels, so every alpha band the premultiplied-page specs report in
 *   (`tests/pma.spec.ts`: 255, 128–254, 32–127, 1–31) is populated, and an
 *   opaque interior large enough for their exact-at-255 claims.
 * - Supersampled edges (4 × 4 per pixel), so silhouettes are antialiased the
 *   way exported art is and the parity suite's residue lives where it lives on
 *   real art.
 *
 * Nothing here is random: every value is a closed-form function of the pixel
 * position, so a re-run writes the same bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from 'rig-c/plate';

type RGB = [number, number, number];

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Signed distance (px, negative inside) from a pixel centre to a part's outline. */
type Shape = (x: number, y: number) => number;

function roundedRect(w: number, h: number, inset: number, radius: number): Shape {
  const hw = w / 2 - inset;
  const hh = h / 2 - inset;
  return (x, y) => {
    const qx = Math.abs(x - w / 2) - (hw - radius);
    const qy = Math.abs(y - h / 2) - (hh - radius);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
  };
}

function ellipse(w: number, h: number, inset: number): Shape {
  const rx = w / 2 - inset;
  const ry = h / 2 - inset;
  return (x, y) => {
    const dx = (x - w / 2) / rx;
    const dy = (y - h / 2) / ry;
    // A distance scaled by the smaller radius — exact on a circle, close
    // enough on these mild ellipses for an antialiased edge and a halo.
    return (Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
  };
}

/** A teardrop pointing up: a circle at the bottom drawn out to a point at the top. */
function teardrop(w: number, h: number, inset: number): Shape {
  const r = w / 2 - inset;
  const cy = h - inset - r;
  const tip = inset;
  return (x, y) => {
    const dx = x - w / 2;
    const dy = y - cy;
    if (y >= cy) return Math.hypot(dx, dy) - r;
    // Between the tip and the circle's equator the half-width narrows linearly.
    const t = (cy - y) / (cy - tip);
    const half = r * (1 - t);
    return Math.max(Math.abs(dx) - half, tip - y);
  };
}

interface Look {
  base: RGB;
  /** Stripe brightness offset, ± on alternate stripes. 0 = no stripes. */
  stripe: number;
  /** Stripe period in px, along x + y. */
  period: number;
  /** Width of the dark rim inside the outline, px. */
  rim: number;
  /** Halo width outside the outline, px, and its peak alpha. */
  halo: number;
  haloAlpha: number;
  /** Top-to-bottom brightness ramp, added at the top and subtracted at the bottom. */
  ramp: number;
  /**
   * Hairlines: every `lines`-th texel column and row (offset per part) darkened
   * by `lineDark`. 0 = none. One texel wide and high-contrast, they are the
   * detail a resample treats differently from a 1:1 copy — what the cut-rule
   * comparison needs to see a page drawn at another resolution at all.
   */
  lines: number;
  lineDark: number;
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** One part: the shape, coloured by `look`, supersampled 4 × 4 per pixel. */
function paint(w: number, h: number, shape: Shape, look: Look): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const S = 4;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Straight-alpha accumulation: colour weighted by coverage, then divided.
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px + (sx + 0.5) / S;
          const y = py + (sy + 0.5) / S;
          const d = shape(x, y);
          let sampleA: number;
          let colour: RGB;
          if (d <= 0) {
            sampleA = 1;
            const shade = look.ramp * (1 - (2 * y) / h);
            const band = look.stripe && Math.floor((x + y) / (look.period / 2)) % 2 === 0 ? look.stripe : -look.stripe;
            const rim = -d < look.rim ? -60 : 0;
            const line =
              look.lines && (Math.floor(x) % look.lines === 0 || Math.floor(y) % (look.lines + 1) === 0)
                ? -look.lineDark
                : 0;
            colour = [
              look.base[0] + shade + band + rim + line,
              look.base[1] + shade + band + rim + line,
              look.base[2] + shade + band + rim + line,
            ];
          } else if (d < look.halo) {
            // Linear falloff: every alpha from haloAlpha down to 0 occurs.
            sampleA = (look.haloAlpha / 255) * (1 - d / look.halo);
            colour = [look.base[0] * 0.35, look.base[1] * 0.35, look.base[2] * 0.35];
          } else {
            continue;
          }
          a += sampleA;
          r += colour[0] * sampleA;
          g += colour[1] * sampleA;
          b += colour[2] * sampleA;
        }
      }
      const i = (py * w + px) * 4;
      if (a === 0) continue;
      out[i] = clamp(r / a);
      out[i + 1] = clamp(g / a);
      out[i + 2] = clamp(b / a);
      out[i + 3] = clamp((a / (S * S)) * 255);
    }
  }
  return out;
}

/** A soft radial glow: colour constant, alpha falling smoothly from the centre to 0 at the edge. */
function glow(w: number, h: number, colour: RGB, peak: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = (px + 0.5 - w / 2) / (w / 2);
      const dy = (py + 0.5 - h / 2) / (h / 2);
      const t = Math.max(0, 1 - Math.hypot(dx, dy));
      const i = (py * w + px) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = clamp(peak * t * t);
    }
  }
  return out;
}

function write(rig: string, file: string, w: number, h: number, rgba: Uint8Array): void {
  const dir = join(HERE, rig, rig === 'turned' || rig === 'named' ? 'art' : 'parts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), encodePng(w, h, rgba));
  console.log(`  ${rig}/${file} ${w}x${h}`);
}

function look(base: RGB, overrides: Partial<Look> = {}): Look {
  return { base, stripe: 22, period: 10, rim: 3, halo: 6, haloAlpha: 150, ramp: 30, lines: 0, lineDark: 0, ...overrides };
}

// --- figure: rigid parts, two meshes, clip hosts, and detail-only line art -----

console.log('figure:');
const figure: Array<[string, number, number, Shape, Look]> = [
  ['shadow.png', 221, 45, ellipse(221, 45, 4), look([30, 30, 40], { stripe: 0, rim: 0, halo: 4, haloAlpha: 120, ramp: 0 })],
  ['leg.png', 57, 205, roundedRect(57, 205, 6, 20), look([70, 96, 160], {})],
  ['arm_up.png', 45, 119, roundedRect(45, 119, 6, 16), look([200, 120, 70], {})],
  ['arm_lo.png', 41, 109, roundedRect(41, 109, 6, 14), look([220, 150, 90], {})],
  ['hand.png', 49, 49, ellipse(49, 49, 6), look([240, 200, 160], { stripe: 14, period: 8 })],
  ['torso.png', 157, 197, roundedRect(157, 197, 6, 34), look([200, 70, 80], {})],
  ['belt.png', 169, 33, roundedRect(169, 33, 6, 8), look([60, 50, 40], { period: 6 })],
  ['badge.png', 41, 41, ellipse(41, 41, 6), look([240, 210, 60], { stripe: 30, period: 6 })],
  ['head.png', 157, 157, ellipse(157, 157, 6), look([240, 200, 160], { stripe: 12, period: 14 })],
  ['eye.png', 31, 39, ellipse(31, 39, 6), look([40, 40, 60], { stripe: 18, period: 6, rim: 2 })],
  ['cape.png', 189, 269, roundedRect(189, 269, 6, 40), look([80, 60, 140], { period: 16 })],
  ['hair.png', 177, 97, roundedRect(177, 97, 6, 40), look([120, 70, 30], { period: 8 })],
  // Line art: shown only in the `detail` animation (the cut-rule stage's), so
  // the scenes the parity suite draws never carry one-texel lines.
  ['plate.png', 131, 151, roundedRect(131, 151, 6, 18), look([210, 210, 220], { lines: 5, lineDark: 170 })],
  ['greave.png', 53, 133, roundedRect(53, 133, 6, 14), look([200, 200, 210], { lines: 5, lineDark: 170 })],
  ['visor.png', 121, 49, roundedRect(121, 49, 6, 12), look([220, 220, 230], { lines: 5, lineDark: 170 })],
];
for (const [file, w, h, shape, l] of figure) write('figure', file, w, h, paint(w, h, shape, l));

// --- glow: additive light, two bending flame meshes, the canary ring plate ------

console.log('glow:');
write('glow', 'halo.png', 360, 360, glow(360, 360, [255, 170, 80], 200));
write('glow', 'body.png', 200, 260, paint(200, 260, roundedRect(200, 260, 6, 30), look([90, 110, 120])));
write('glow', 'flame.png', 132, 232, paint(132, 232, teardrop(132, 232, 6), look([250, 140, 40], { stripe: 26, period: 12, rim: 4 })));
write('glow', 'core.png', 84, 164, paint(84, 164, teardrop(84, 164, 6), look([255, 230, 140], { stripe: 18, period: 8, rim: 2 })));
write('glow', 'spark.png', 40, 40, glow(40, 40, [255, 240, 200], 255));
write('glow', 'plate.png', 360, 360, paint(360, 360, roundedRect(360, 360, 6, 24), look([120, 90, 150], { period: 14 })));

// --- turned: one 8 x 8 page painted texel by texel, for `--atlas-in` ----------
//
// Every texel a distinct colour, so a cut or a UV that is off by a texel, turned
// the wrong way or transposed reads a different colour. The page is laid out by
// hand in `turned/art/turned.atlas`: region `s` at (4, 4), 2 x 1, not turned;
// region `r` at (1, 2), 2 x 1 turned 90°, occupying 1 x 2 on the page.

console.log('turned:');
{
  const w = 8;
  const h = 8;
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      page[i] = 32 + x * 28;
      page[i + 1] = 32 + y * 28;
      page[i + 2] = 255 - (x + y) * 14;
      page[i + 3] = 255;
    }
  }
  write('turned', 'turned.png', w, h, page);
}

// --- duo: two-colour (dark) tint, on a region and on a mesh (#106) --------------
// One opaque grey ramp, black at the left edge to white at the right, the same in
// every row and channel: a texel's value is all a two-colour tint reads
// (c·light + (1 − c)·dark), so a ramp shows the dark half at full strength on
// the left and none on the right.

console.log('duo:');
{
  const w = 128;
  const h = 48;
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x * 255) / (w - 1));
      page[i] = v;
      page[i + 1] = v;
      page[i + 2] = v;
      page[i + 3] = 255;
    }
  }
  write('duo', 'ramp.png', w, h, page);
}

// --- named: one region on a page that is not named for it (rig-c #1404) -------
// The page is `sheet.png`; its one region, `swatch`, sits inside it with a margin,
// so the region is cut rather than passed through whole. A two-axis gradient
// (red across, green down, blue on a checker) makes a misplaced cut a different
// picture. `named/art/named.atlas` lays it out by hand.

console.log('named:');
{
  const w = 400;
  const h = 200;
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= 40 && x < 360 && y >= 20 && y < 180;
      page[i] = inside ? Math.round(((x - 40) * 255) / 319) : 0;
      page[i + 1] = inside ? Math.round(((y - 20) * 255) / 159) : 0;
      page[i + 2] = inside ? ((((x - 40) >> 5) + ((y - 20) >> 5)) % 2 ? 200 : 40) : 0;
      page[i + 3] = inside ? 255 : 0;
    }
  }
  write('named', 'sheet.png', w, h, page);
}

// --- cloth: a three-link physics chain hanging from an anchor (#121) ------------
// Each link is one rigid part on a physics bone that answers wind and gravity;
// the banner is a still mesh on the anchor, so the scene has a mesh to settle on.

console.log('cloth:');
write('cloth', 'link.png', 61, 169, paint(61, 169, roundedRect(61, 169, 6, 22), look([90, 160, 210], { period: 14 })));
write('cloth', 'banner.png', 321, 81, paint(321, 81, roundedRect(321, 81, 6, 18), look([210, 120, 80], { period: 16 })));
