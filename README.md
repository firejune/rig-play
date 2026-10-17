<p align="center">
  <img src="assets/banner.svg" alt="@rig-c/play - plays rigc's compiled model as DOM elements or one canvas" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rig-c/play"><img src="https://img.shields.io/npm/v/@rig-c/play.svg?style=flat-square&color=FF6B4A" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@rig-c/play"><img src="https://img.shields.io/npm/dm/@rig-c/play.svg?style=flat-square&color=EC4899" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-38BDF8.svg?style=flat-square" alt="license" /></a>
</p>

Plays the rigs [rigc](https://github.com/rig-c/core) builds — the compiled model
document `rigc build` writes, `skeleton.model.json` — as **plain DOM**: one
absolutely-positioned `<img>` per rigid slot, posed with a single CSS `matrix()` write
per frame, deforming meshes on small per-part canvases; or as **one canvas** per player.
`rig-play` and `spine-html` are the same package under the names it shipped as before.
The toolchain lives under one organisation: the compiler [rig-c/core](https://github.com/rig-c/core)
(npm `rig-c`), the part generator [rig-c/parts](https://github.com/rig-c/parts)
(npm `@rig-c/parts`), and this player, [rig-c/play](https://github.com/rig-c/play).

## Why

The package began in 0.x as `spine-html`, an experiment in drawing Spine skeletons
without a canvas. Every Spine web runtime rasterizes into one, yet the pose itself is
computed on the CPU, and for a **region attachment** (a rigid part) the bone transform is
a plain affine map that CSS `transform: matrix()` expresses *exactly* — so the rigid tier
could live in the DOM, composited by the browser, inspectable in devtools, styled with
CSS. The idea had been floated on the Spine forum three times since 2014 and never built;
the blockers named were meshes, clipping and DOM update overhead, and the 0.x line
answered each of them (per-part mesh canvases, element-level `clip-path`, dirty-skip).

At 1.0 it stopped being a Spine runtime. It plays the model document `rigc build` writes,
poses it through `rig-c/core` — rigc's own posing core, bundled into the package — and
links nothing from Esoteric Software; a Spine export is refused by name. It gained a
second render mode that draws the whole frame into one canvas. And it took the name
`rig-play`, which says what it is; after 1.8 it moved with the rest of the toolchain to
`@rig-c/play`. `rig-play` and `spine-html` keep being published with the same files, so
links to either earlier name keep working.

### Measured

**Standing comparison against `@esotericsoftware/spine-webgl 4.3.13` (`npm run bench`, #39)** —
measured on 2026-10-17 in **headed** Chromium `151.0.7922.34` on an Apple M4 GPU
(`ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)`, macOS `Darwin 25.6.0`,
10 cores, 32 GiB RAM, `1280×720` viewport, `devicePixelRatio: 1`, 100 warm-up frames +
600 measured frames per row, `loadPerCoreBefore: 0.33`, `loadPerCoreAfter: 0.33` under the
`1.0` load guard; each row is its own page load with only that runtime animating, and grid
scenes batch the official skeletons through one shared WebGL canvas while `small players`
mounts independent player instances):

| scene | runtime | rig | clipped to | fps | pose ms | render ms | drawn players | triangles | draw calls | origin Δpx | live contexts |
| --- | --- | --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 meshed rig animating | dom | `portrait-packed` `turn` | pane | 59.99 | 0.17 | 0.16 | —/1 | 48 | — | 0.007 | —/1 |
| 1 meshed rig animating | canvas | `portrait-packed` `turn` | pane | 59.99 | 0.23 | 0.18 | —/1 | 0 | 0 | 0.007 | —/1 |
| 1 meshed rig animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.05 | 0.13 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 4 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 60.01 | 0.46 | 0.48 | —/4 | 96 | — | 0.009 | —/1 |
| 4 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.60 | 0.49 | —/4 | 176 | 2 | 0.009 | —/1 |
| 4 meshed rigs animating | official | `portrait-packed` `turn` | pane | 59.99 | 0.13 | 0.17 | 4/4 | 352 | 1 | 0.000 | 1/1 |
| 16 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 60.00 | 0.66 | 0.74 | —/16 | 384 | — | 0.010 | —/1 |
| 16 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 59.87 | 0.84 | 0.50 | —/16 | 704 | 8 | 0.010 | —/1 |
| 16 meshed rigs animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.21 | 0.30 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 36 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 48.28 | 1.24 | 1.42 | —/36 | 1104 | — | 0.010 | —/1 |
| 36 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 60.11 | 1.15 | 0.85 | —/36 | 1760 | 20 | 0.010 | —/1 |
| 36 meshed rigs animating | official | `portrait-packed` `turn` | pane | 60.00 | 0.43 | 0.49 | 36/36 | 3168 | 1 | 0.000 | 1/1 |
| 64 meshed rigs animating | dom | `portrait-packed` `turn` | pane | 29.07 | 2.13 | 2.69 | —/64 | 1824 | — | 0.010 | —/1 |
| 64 meshed rigs animating | canvas | `portrait-packed` `turn` | pane | 53.99 | 1.62 | 1.17 | —/64 | 3168 | 36 | 0.010 | —/1 |
| 64 meshed rigs animating | official | `portrait-packed` `turn` | pane | 59.99 | 0.42 | 0.54 | 64/64 | 5632 | 1 | 0.000 | 1/1 |
| 1 meshed rig animating (canvas2d) | dom | `portrait-packed` `turn` | pane | 60.00 | 0.18 | 0.28 | —/1 | 48 | — | 0.007 | —/0 |
| 1 meshed rig animating (canvas2d) | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.20 | 0.18 | —/1 | 88 | 1 | 0.007 | —/1 |
| 1 meshed rig animating (canvas2d) | official | `portrait-packed` `turn` | pane | 59.99 | 0.06 | 0.14 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 16 meshed rigs animating (canvas2d) | dom | `portrait-packed` `turn` | pane | 59.89 | 0.65 | 0.99 | —/16 | 384 | — | 0.010 | —/0 |
| 16 meshed rigs animating (canvas2d) | canvas | `portrait-packed` `turn` | pane | 60.00 | 0.93 | 0.59 | —/16 | 792 | 9 | 0.010 | —/1 |
| 16 meshed rigs animating (canvas2d) | official | `portrait-packed` `turn` | pane | 60.00 | 0.18 | 0.31 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 1 held pose | dom | `portrait-packed` `turn` | pane | 60.11 | 0.00 | 0.15 | —/1 | 0 | — | 0.007 | —/1 |
| 1 held pose | canvas | `portrait-packed` `turn` | pane | 60.02 | 0.01 | 0.11 | —/1 | 0 | 0 | 0.007 | —/1 |
| 1 held pose | official | `portrait-packed` `turn` | pane | 60.00 | 0.00 | 0.13 | 1/1 | 88 | 1 | 0.000 | 1/1 |
| 16 held poses | dom | `portrait-packed` `turn` | pane | 60.09 | 0.00 | 0.43 | —/16 | 0 | — | 0.010 | —/1 |
| 16 held poses | canvas | `portrait-packed` `turn` | pane | 59.99 | 0.01 | 0.55 | —/16 | 0 | 0 | 0.010 | —/1 |
| 16 held poses | official | `portrait-packed` `turn` | pane | 60.08 | 0.00 | 0.35 | 16/16 | 1408 | 1 | 0.000 | 1/1 |
| 64 held poses | dom | `portrait-packed` `turn` | pane | 59.99 | 0.02 | 2.43 | —/64 | 0 | — | 0.010 | —/1 |
| 64 held poses | canvas | `portrait-packed` `turn` | pane | 60.10 | 0.02 | 2.56 | —/64 | 0 | 0 | 0.010 | —/1 |
| 64 held poses | official | `portrait-packed` `turn` | pane | 60.10 | 0.00 | 0.90 | 64/64 | 5632 | 1 | 0.000 | 1/1 |
| 1 rigid rig animating | dom | `walk-packed` `walk` | pane | 59.99 | 0.30 | 0.15 | —/1 | 0 | — | 0.007 | —/1 |
| 1 rigid rig animating | canvas | `walk-packed` `walk` | pane | 59.99 | 0.33 | 0.21 | —/1 | 30 | 1 | 0.007 | —/1 |
| 1 rigid rig animating | official | `walk-packed` `walk` | pane | 60.00 | 0.04 | 0.16 | 1/1 | 30 | 1 | 0.000 | 1/1 |
| 16 rigid rigs animating | dom | `walk-packed` `walk` | pane | 60.00 | 0.77 | 0.65 | —/16 | 0 | — | 0.010 | —/1 |
| 16 rigid rigs animating | canvas | `walk-packed` `walk` | pane | 60.00 | 0.62 | 0.47 | —/16 | 480 | 16 | 0.010 | —/1 |
| 16 rigid rigs animating | official | `walk-packed` `walk` | pane | 60.00 | 0.15 | 0.22 | 16/16 | 480 | 1 | 0.000 | 1/1 |
| 64 rigid rigs animating | dom | `walk-packed` `walk` | pane | 59.89 | 1.58 | 1.63 | —/64 | 0 | — | 0.010 | —/1 |
| 64 rigid rigs animating | canvas | `walk-packed` `walk` | pane | 42.00 | 1.50 | 1.21 | —/64 | 1920 | 64 | 0.010 | —/1 |
| 64 rigid rigs animating | official | `walk-packed` `walk` | pane | 60.00 | 0.14 | 0.13 | 64/64 | 1920 | 1 | 0.000 | 1/1 |
| 8 small players | dom | `walk-packed` `walk` | cell | 60.00 | 0.24 | 0.18 | —/8 | 0 | — | 0.012 | —/1 |
| 8 small players | canvas | `walk-packed` `walk` | cell | 60.00 | 0.33 | 0.30 | —/8 | 240 | 8 | 0.012 | —/1 |
| 8 small players | official | `walk-packed` `walk` | cell | 60.00 | 0.09 | 0.24 | 8/8 | 240 | 8 | 0.007 | 8/8 |
| 20 small players | dom | `walk-packed` `walk` | cell | 60.00 | 1.03 | 0.84 | —/20 | 0 | — | 0.015 | —/1 |
| 20 small players | canvas | `walk-packed` `walk` | cell | 59.99 | 0.69 | 0.54 | —/20 | 600 | 20 | 0.015 | —/1 |
| 20 small players | official | `walk-packed` `walk` | cell | 60.00 | 0.13 | 0.24 | 16/20 | 480 | 16 | 0.006 | 16/20 |

Where each side wins and loses on that table:

- **High-count meshed grids (`36` and `64 meshed rigs animating`) — `official` wins**: batching
  all 64 skeletons into one WebGL canvas holds `59.99 fps` (`5,632 triangles` in `1 draw call`),
  while `canvas` mode drops to `53.99 fps` (per-player `drawImage` blits from the shared WebGL
  context) and `dom` mode drops to `48.28 fps` at 36 rigs and `29.07 fps` at 64 rigs (per-part
  mesh canvas blits + DOM compositing). Up to 16 animating meshed rigs all three hold `60 fps`.
- **Held poses (`1`, `16`, `64 held poses`) — `dom` and `canvas` skip rasterization**: both
  modes reuse their rasters (`0 triangles`, `0 draw calls`), while `official` redraws
  `88` / `1,408` / `5,632 triangles` every frame.
- **Rigid-heavy grids (`64 rigid rigs animating`) — `dom` and batched `official` hold `60 fps`**:
  `dom` updates `<img>` CSS transforms (`0 triangles`, `59.89 fps`), whereas `canvas` pays 64
  per-player `drawImage` blits (`42.00 fps`).
- **Many independent players on one page (`20 small players`) — `dom` and `canvas` draw all 20;
  `official` loses 4 to the browser's 16-context WebGL cap**: both `@rig-c/play` modes share at
  most one WebGL context across the page, while mounting 20 independent `spine-webgl` players
  evicts 4 contexts (`16/20 drawn players`, `16/20 live contexts`).

**The element mode's mesh backend is `'webgl'` by default since 1.9 (#109)**, read off
macOS Safari on 2026-10-13 (1.8.2, gallery rig `look-packed`: 4 meshes, 464
triangles, `sweep`; the demo's stats line after a 30 s settle; the Mac was also
serving the builds, so absolute fps is low and only the comparison is the point —
readings verbatim on #25):

| macOS Safari | 1 rig | 10 rigs (4,640 triangles) |
| --- | --: | --: |
| canvas2d mesh backend | 21–26 fps | 2–3 fps |
| webgl mesh backend | 60 fps | 58 fps |

Nothing is claimed here for mobile browsers: no phone or tablet has been measured
on the 1.x line.

The numbers below are older: measured on the 0.x line, on the spineboy exports it then played (PoC, Apple silicon —
headless and on-device numbers are labeled, they do **not** substitute for each other).
The renderer tiers they describe carried over; they have not been re-measured since the
player moved to rigc's model (#60):

- Rigid only (spineboy-ess), headless Chromium: 10 skeletons / 180 slot images at
  **~0.03 ms skeleton math + ~0.22 ms DOM writes per frame** — about 1.5% of a
  60 fps frame budget. On-device Safari: 10 rigid skeletons hold **60 fps**.
- With meshes (spineboy-pro), headless Chromium: 1 skeleton = **~0.05 ms + ~0.5 ms
  render** (8 mesh canvases, 323 triangles); 10 running skeletons = **~3.5 ms/frame**
  total, smooth.
- Dirty-skip: 10 *static* skeletons (pose held) = **~0.4 ms/frame** headless and
  **~0.6 ms** on-device Safari — unchanged meshes reuse their raster, so idle or
  held parts cost nothing anywhere.
- Real Safari (on-device), canvas2d mesh backend: in-callback JS stays **~4–5
  ms/frame** for 10 running meshed skeletons — but the rAF rate tells the real
  story: **meshed ×1 = 37 fps, meshed ×10 = 3–4 fps** (rigid-only ×10 = 60 fps).
  The cost lives outside the frame callback, in the compositor/GPU process:
  Safari antialiases canvas2d **clip paths**, so every triangle pays for an AA
  mask. Chromium doesn't antialias clips and stays smooth. This is what the
  optional WebGL mesh backend (below) removes.
- Real Safari (on-device), **webgl mesh backend**: meshed ×1 holds **60 fps**
  (vs 37 on canvas2d), and the meshed ×10 stress scene jumps **3–4 → 45 fps** —
  80 mesh canvases / 3230 triangles redrawn every frame (0 reused, the worst
  case), in-callback JS ~5.8 ms at dpr=1. The per-triangle clip-AA tax is gone;
  the remaining gap to 60 is the blit/compositing cost of a 10-skeleton stress
  scene, not a per-triangle cost.
- Headless-WebKit numbers are a **software rasterizer** and measured up to 28×
  off real Safari in both directions — useful for visual regression only, never
  as Safari perf evidence.

## Status

**Production.** The questions this started as a PoC to answer — how far does the
DOM actually go, and how cheap is it — are answered with on-device numbers: the
practical scenario (a character or two, mostly holding pose, a few parts
deforming) holds **60 fps on every engine measured**, and the 10-skeleton
stress scene holds 45 fps on the weakest one (Safari, webgl backend). Ships
with a self-contained test suite (backend visual parity + invariants) and CI.

**Two render modes.** `mode: 'dom'` (the default, everything below) draws a rig
as elements. `mode: 'canvas'` draws the whole frame into **one `<canvas>`** per
player: every slot as textured triangles from its atlas page through the same
shared WebGL context the mesh tier's `webgl` backend uses, into one rect, then
one `drawImage` onto the player's canvas. Tint and dark (two-colour) tint are
vertex colours, blend modes are batch state, clips are cut on the CPU by
`rig-c/core`'s clipper — no `clip-path`, no SVG filter, no per-slot element.
`RigPlayer` swaps between the two in place (`player.mode = 'canvas'`). The
canvas mode is held against the DOM tier pixel for pixel on the parity suite's
frozen poses (bad pixels ≤ 1.6% of drawn content, measured, macOS Chromium and
WebKit); which mode is faster where is **not measured on a device yet**, so the
default stays `dom`.

- ✅ Region attachments (rigid parts): exact affine mapping, draw-order via `z-index`,
  attachment swaps, alpha
- ✅ Atlas unpacking at load time (90°-packed regions restored to the orientation
  the region's UVs name, held against hand-written UVs on a rigc build whose region
  is packed turned),
  so the rigid per-frame path never touches a canvas — a region that covers its whole
  page is passed through uncut, and `revokeRegions()` frees the rest when a skeleton
  is unloaded
- ✅ Mesh attachments (deform tier): small per-part canvases sized to the mesh's world
  bounds, interleaved with the rigid `<img>` slots in one stacking context — the DOM
  handles the bones, a rasterizer handles the warps
- ✅ Blend modes via `mix-blend-mode` (additive = `plus-lighter`)
- ✅ Crack-free mesh seams on the canvas2d backend: canvas2d antialiases each
  triangle's clip edge, so two triangles sharing an edge each leave it partly
  transparent and the background shows through as a hairline — plainest over a
  light background behind light art (#104). Each edge of a triangle's clip
  polygon is moved 0.5px outward along its own normal so neighbours overlap —
  the texture is continuous across shared edges, so the overlap is invisible
  (`?expand=0` shows the cracks for comparison)
- ✅ RGB tinting (skeleton × slot × attachment color) via an SVG `feColorMatrix`
  reference filter per element — an exact channel multiply that works identically on
  `<img>` and `<canvas>` without touching the raster (needs reference-filter support,
  Safari 15+; verified pixel-level on Chromium and WebKit). Dark/two-color tint is
  not expressible this way and stays out of scope
- ✅ DPR-aware mesh canvas backing store: `renderer.pixelRatio` (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in)
- ✅ Dirty-skip: a mesh whose canvas-space vertices match the last raster reuses it;
  whole-pixel translations allow at most half a Float32 ULP at the current world
  coordinate, strictly less than half a pixel. CSS still tracks the translation, while
  stationary axes stay exact and the comparison anchor changes only on a redraw.
  10 frozen spineboys: WebKit ~141 → ~0.5 ms/frame
- ✅ Clipping attachments as element-level CSS `clip-path`: spine-core's semantics
  (one active clip at a time, applied from the clip's slot through its end slot
  inclusive), with the polygon expressed in each element's own local frame — the
  inverse of the `<img>` matrix for rigid slots, the canvas translate for mesh
  slots. Covers **part masks** (a clip with a real end slot, like the figure test
  rig's `mask` animation) and **whole-skeleton clips** (an end slot that never
  arrives, which takes a fast path: one `clip-path` on the root instead of one per
  element). **Inverse clips** are supported too: the region they keep has a hole
  in it, so it needs two rings, and `polygon()` carries only one — a box and a
  polygon listed inside one `polygon()` become a single self-intersecting ring
  whose even-odd fill leaves a wedge along the seam between them (measured, on a
  corner of spineboy's boot). So an inverse clip is written as a two-subpath
  `path(evenodd, …)` whose outer ring is the element's own box. The whole feature
  is element-level, so both mesh backends see the same thing and neither raster
  path knows clipping exists; `renderer.clipping = false`
  restores the old counted-and-skipped behaviour. Concave polygons go to CSS as
  authored — the convex decomposition spine's CPU clipper performs exists to feed a
  triangle rasterizer and has no job here. Two things this does not do: Spine's
  clipper convexifies an *inverse* polygon (convex hull) where CSS clips it as
  authored, so the two agree exactly when that polygon is convex — which is the
  shape `inverse` is meant for; and the cost of many simultaneous `clip-path`s on
  real-device Safari is **not measured** (the headless numbers that exist are not
  Safari evidence — see Measured above)
- ✅ Safari mesh cost root-caused by on-device triangulation (two corrections deep):
  the early "~15× slower per-triangle path" was a **headless-WebKit artifact**
  (software rasterization), and the follow-up "on par with Chromium" held only for
  in-callback JS time. Real-Safari rAF rates — rigid ×10 = 60 fps, meshed ×1 =
  37 fps, meshed ×10 = 3–4 fps with JS flat at ~4–5 ms — put the real cost in the
  GPU process: Safari antialiases canvas2d **clip paths**, so the per-triangle clip
  mapping pays a per-triangle AA-mask tax (the same AA that caused the seam cracks)
- ✅ WebGL blit backend for the mesh tier, the default since 1.9 (#109;
  `renderer.meshBackend = 'canvas2d'` keeps the 2d raster). All dirty meshes are shelf-packed into
  **one shared offscreen WebGL context** (module-level — browsers cap contexts at
  ~16), drawn as textured triangles with premultiplied alpha, then rect-blitted
  onto the same per-part canvases with an unclipped `drawImage` — cheap on Safari.
  Everything element-level is unchanged: z-index interleave, tint filter,
  `mix-blend-mode`, dirty-skip, grow-only backing. GL rasterizes shared triangle
  edges seamlessly, so this path needs no crack overdraw. Falls back to canvas2d
  when WebGL is unavailable or the context is lost. Backend parity verified by
  headless Chromium+WebKit screenshot diffs (glow / clipping / tint scenes;
  sub-pixel edge differences only). On-device Safari, meshed ×10 with every mesh
  redrawn per frame: **3–4 fps (canvas2d) → 45 fps (webgl)**

## Install

```bash
npm i @rig-c/play
npm i -D rig-c    # the build tool: `rigc build` writes the model the player loads
```

The package plays rigs built by [rigc](https://github.com/rig-c/core):
`rigc build` writes a compiled model document, `skeleton.model.json` (spec
`rigc-compiled/3`), next to the Spine pair and the atlas pages. That document
is what the player loads, and it states everything posing and drawing need —
the skeleton, the animations, and where every region sits on its page — so the
`.atlas` and `skeleton.json` beside it are not fetched. Poses are computed by
`rig-c/core`, rigc's own posing core, which is bundled into this package: there
is nothing else to install.

```ts
import { loadModel, RigPlayer } from '@rig-c/play';

const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });

// A positioned element becomes the rig's world origin (Y-up: the rig grows
// upward from it). Layout and scaling are the caller's.
const player = new RigPlayer(rootElement, assets);
player.play('walk');                        // looping; { loop: false } holds at the end

function frame(delta: number) {
  player.frame(delta);                      // step the track by delta × timeScale, draw
}

// Unloading (a cutscene ends, a level swaps): elements first, bitmaps second.
// The unpacked regions are blob URLs — nothing else frees them.
player.dispose();
assets.dispose();
```

### A minimal page

Layout is the caller's, so the first page is the place to see it: the root
element is the rig's world origin, Y up, and scaling it is a CSS transform the
player cannot see. This one loads a build, fits its stage box to a container,
tells the renderer about the scale, and plays the first animation:

```html
<!doctype html>
<meta charset="utf-8">
<div id="stage" style="position: relative; width: 480px; height: 640px; overflow: hidden"></div>
<script type="module">
  import { loadModel, RigPlayer } from 'https://cdn.jsdelivr.net/npm/@rig-c/play@1/dist/index.js';

  const stage = document.getElementById('stage');
  const assets = await loadModel({ modelUrl: 'rigs/look/skeleton.model.json' });
  const root = stage.appendChild(document.createElement('div'));
  const player = new RigPlayer(root, assets);
  player.play(assets.animations[0].name);

  // Fit the rig's stage box (world units, Y up) to the container: scale it, and
  // put the origin where the box's left edge and top land.
  const box = assets.stage ?? player.bounds();
  const scale = Math.min(stage.clientWidth / box.width, stage.clientHeight / box.height);
  root.style.cssText = `position: absolute; transform-origin: 0 0; transform: scale(${scale});
    left: ${-box.x * scale}px; top: ${(box.y + box.height) * scale}px`;
  player.renderer.syncPixelRatio(); // raster at the size on screen, not the unscaled one

  let last = performance.now();
  requestAnimationFrame(function tick(now) {
    player.frame((now - last) / 1000);
    last = now;
    requestAnimationFrame(tick);
  });
</script>
```

`syncPixelRatio()` is what makes the scale cheap: without it the mesh canvases
raster at the device pixel ratio of the *unscaled* rig, `1 / scale` times more
pixels than the screen shows. Call it again after anything that changes the
scale. `tests/readme-page.spec.ts` runs this block as written, against the
package built from this tree.

### Wind, gravity and dragging the rig

A rig's physics links answer the world the page sets (#121). `environment()`
gives them spine-core's skeleton-level wind and gravity — x right, **y down**,
the runtime's axes; each constraint's authored `wind` / `gravity` is its
response, so a link stating `wind: 0` feels none — and `moved()` tells them the
page moved or turned the rig, in the skeleton's world (y up), so a dragged rig
trails its cloth. Both apply from the next step, at any time. Added to the
minimal page above:

```ts
// A wind slider, -1 (left) to 1 (right). The runtime starts at wind [1, 0], so set calm first.
const wind = stage.appendChild(Object.assign(document.createElement('input'),
  { type: 'range', min: '-1', max: '1', step: '0.01', value: '0' }));
player.environment({ wind: [0, 0] });
wind.addEventListener('input', () => player.environment({ wind: [Number(wind.value), 0] }));

// Drag the rig: move the root, and tell the physics how far, in world units with y up.
let held = null; // the pointer's position while a drag is held
stage.addEventListener('pointerdown', (e) => { if (e.target !== wind) held = { x: e.clientX, y: e.clientY }; });
addEventListener('pointerup', () => { held = null; });
stage.addEventListener('pointermove', (e) => {
  if (!held) return;
  const dx = e.clientX - held.x, dy = e.clientY - held.y;
  held = { x: e.clientX, y: e.clientY };
  root.style.left = `${parseFloat(root.style.left) + dx}px`;
  root.style.top = `${parseFloat(root.style.top) + dy}px`;
  player.moved({ x: dx / scale, y: -dy / scale });
});
```

The block is plain JavaScript, so it runs inside the page as written.
`environment(null)` returns to the runtime's start values, and `environment()`
reads what stands. The state is the player's, not a track's: every track and
layer answers the same world, and a `seek` replays under the environment as it
stands — no history is kept. A rig with no physics ignores both.
`tests/readme-page.spec.ts` runs this block in the minimal page.

The demo's `wind.html` is the same thing with controls: wind and gravity
sliders, a drag on the stage, and the rig named by `?model=` (the `cloth` test
rig by default; `bun run dev`, then `/wind.html?model=rigs/<name>/skeleton.model.json`).
`tests/wind-page.spec.ts` holds it.

The player owns one track: `play(name, { loop })` opens an animation at its first
pose, `frame(dt)` steps it (or `advance(dt)` then `draw()`, to time the two
apart), `pause()` / `resume()` hold and release it, `timeScale` scales every
step, and `seek(t)` moves it to a time. A seek is "reopen, then step to the
time" in `seekStep` increments (1/60 s by default) — never a jump, because a
physics rig has history and its pose at a time depends on the steps that
reached it. The physics integrates on rig-c's render clock (`physicsClockStep`:
each step and 2⁻³⁰ of it more), so stepping at a fixed rate — `frame(1/60)`, a
capture, a test — shows no single-frame spring jump where a frame ends on a
physics step; the animation, the events and `time` stay on the steps (#103). `on('event', …)` receives the event keys each step crosses, in the
runtime's order across a loop's wrap; `on('complete', …)` fires once a step
completes a cycle. `skin` (a constructor option) poses under a named skin;
without it the rig is posed the way a fresh Spine skeleton is, with no skin
set. `player.color` multiplies a whole-rig colour into every slot's tint.
`player.renderer` is the `DomRenderer` underneath, whose knobs and counters
are below.

**What it refuses, by name.** A Spine export (`.json`, `.skel`) is refused
before anything is fetched: this package reads compiled models and nothing
else. A document whose `spec` is not one `rig-c/core` reads is refused with the
core's own sentence plus "build it with `rigc build`", and so is a
`rigc-compiled/1` document, which predates the `pages` section.

`@rig-c/play` is a third-party renderer and is not affiliated with or endorsed by
Esoteric Software.

### Drawing your own frames

`RigPlayer` is the convenient path; the renderer underneath takes a plain
record, so anything that can produce one can draw through it:

```ts
import { DomRenderer, type PosedFrame } from '@rig-c/play';

const renderer = new DomRenderer(rootElement, assets.regionImages, assets.pageImages);
renderer.render(frame); // frame: PosedFrame
```

```ts
PosedFrame { order: PosedSlot[] }                     // the slots that draw, in draw order
PosedSlot = { slot; z; blend: 'Normal'|'Additive'|'Multiply'|'Screen';
              tint: [r, g, b, a]; dark?: [r, g, b];
              clip?: { polygon: number[]; inverse: boolean; convex: boolean } }   // world space, Y up
          & ( { kind: 'region'; region: string; corners: number[] /* BL, UL, UR, BR */;
                page: string; pma: boolean; uvs: number[] /* page UVs at the corners */ }
            | { kind: 'mesh'; page: string; pma: boolean; vertices: number[];
                uvs: number[]; triangles: number[]; sequence: number } )
```

`player.posedFrame()` returns the record the player would draw. Two things the
renderer reads off it by identity rather than by value: every slot a clip
covers carries the **same** `clip` object (one that covers every slot of the
frame takes the one-`clip-path`-on-the-root path), and a mesh's `uvs` and
`triangles` are the same arrays from frame to frame for the same texture
mapping (a new array re-rasters the mesh).

### Reading the pose

Two reads off the pose the player holds — the last `frame`/`advance`/`seek`,
or the setup pose before `play` — for framing a stage around a rig:

```ts
const head = player.bone('head');   // { x, y, a, b, c, d, rotationX, rotationY, scaleX, scaleY, active }
const box = player.bounds();        // { x, y, width, height } | null — world units, Y up
```

`bone` is the core's world transform for that bone (`rig-c/core`'s `RawBone`,
unchanged), and an unknown name is refused by name. `bounds` is the box of
every region's four corners and every mesh's vertices in the frame record the
renderer takes; a slot under a clip counts only inside the clip polygon's own
box, an inverse clip removes nothing, and bounding boxes, paths and points do
not draw and do not count. Both cost nothing until called and read the same
numbers in `dom` and `canvas` mode.

### Drawing some slots only

`slots` is a draw filter — an allow list of slot names or a predicate — settable up
front and on a live player. The pose is the whole rig's whatever the filter:
bones, constraints, physics, `bone()`, `adjust`, events and tracks see no filter;
only the draw does, in both modes, and `bounds()` reads the drawn slots. A
clipping slot the filter leaves out does not clip. An allow list naming a slot
the document does not have is refused by name.

```ts
const hand = new RigPlayer(frontRoot, assets, { slots: ['hand_f', 'arm_f_lo'] });
player.slots = (slot) => !slot.startsWith('weapon');
```

Two players over one `ModelAssets` share the load but each poses the rig. To
pose it once and draw it twice — a hand drawn again in front of another
character — give a second renderer this player's pose under another filter:

```ts
const front = new DomRenderer(frontRoot, assets.regionImages, assets.pageImages);
// each frame, after player.frame(dt):
front.render(player.posedFrame(['hand_f', 'arm_f_lo']));
```

### Attachment sets (`sets.json`)

A build from `@rig-c/parts` (or authored alongside a rig) may ship a `sets.json`
sidecar beside `skeleton.model.json` declaring named attachment sets — an
expression, a viseme, a side view — under spec `"rig-parts-sets/1"` or
`"spine-parts-sets/1"`:

```json
{
  "spec": "rig-parts-sets/1",
  "sets": {
    "smile": {
      "slots": { "face": "face_smile", "prop": "prop_star" },
      "hides": []
    },
    "wink": {
      "slots": { "face": "face_wink" },
      "hides": ["prop"]
    }
  }
}
```

`loadModel` probes `sets.json` in the model document's directory by default
(treating a 404 as "no sets"; pass `setsUrl: null` to skip the probe, or a URL
string to require one at another path) and validates every slot and attachment
name against the model document. `player.sets()` (and `assets.sets`) returns the
declared `readonly RigSet[]` (`{ name, slots, hides }`), and `player.setSet(name)`
switches the active set at runtime (#134):

```ts
player.sets();          // [{ name: 'smile', slots: { ... }, hides: [] }, ...]
player.setSet('smile'); // covered slots take the set's attachments; <slot>_still and hides are hidden
player.set;             // 'smile'
player.setSet(null);    // restore base / track attachments
```

The active set is applied immediately to the held pose (including the setup pose
before `play`) and after track evaluation on every subsequent `advance`, so a
track key on a covered slot is overridden while the set is active and restored
on the next frame when cleared with `setSet(null)`. Uncovered slots keep their
track attachments, mesh deforms and sequence frames untouched; when no set is
active (`null`), track evaluation runs with zero extra work and produces
byte-identical poses. An unknown set name throws by name; on a build without
`sets.json`, `sets()` is empty (`[]`) and `setSet` throws.

### Several tracks

A base on track 0, a layer over it, a one-shot played once and mixed back out —
rig-c's live tracks (`openTracks`), whose mixing is the Spine runtime's
`AnimationState` held at tolerance 0:

```ts
player.play('idle');                                        // track 0, as always
player.play('smile', { track: 1, loop: false, mix: 0.2 });  // held at its end, mixed in over 0.2 s
player.play('wave', { track: 2, loop: false, mix: 0.1 });   // a one-shot…
player.queueClear(2, { mix: 0.1 });                         // …mixed back out over its last 0.1 s
player.queue('idle_b', { track: 0, mix: 0.3 });             // after the current idle cycle completes
player.clear(1, { mix: 0.2 });                              // the layer gone, the base showing through
player.entry(2);                                            // { animation, loop, trackTime, animationTime, duration, alpha, additive } | null
player.play('blink', { track: 3, alpha: 0.6 });            // the same clip at a weight…
player.setAlpha(3, 0.85);                                   // …changed while it plays
player.play('breath', { track: 4, additive: true });        // adds to what the tracks below posed
```

**Weight and additive layers** (rig-c 2.39.0, the runtime's `TrackEntry.alpha` and
`additive`): `alpha` (0..1, default 1) multiplies every timeline the entry applies;
`setAlpha(track, alpha)` changes the current entry's weight from the next pose and
re-poses the held pose. It does not touch events — an entry fires at any alpha, 0
included, and one mixing out fires none — or attachments: the current entry keeps
its attachments at any alpha, one mixing out keeps none. `additive: true`, fixed
when the entry is set or queued, adds the entry's keyed bone and deform values to
what the tracks below posed instead of replacing them, so a layer keying the same
bone channels as an idle does not cover its motion; a rotation is added as it
stands, with no shortest-angle wrap, and an additive entry mixing out fades with its
alpha and is never held. Colour, attachment and event timelines apply as on a
replacing entry. A weight below 1 or an additive entry composes, as a mix does.

`play(name)` keeps meaning what it meant: a plain play on track 0 runs on rig-c's
single live track, which poses everything the core poses. The first call that
composes — a `mix`, a `track` above 0, a `queue`, a `clear` — moves the player onto
the tracks, carrying the single track over by **replay** (its animation set, pose 0
taken, stepped to its time in `seekStep` increments — one pose per step played, so
on a stage that idled a while that is one long frame; the core offers no hand-over
of a live track's state). To never pay it, stand the player on the tracks from the
start: `new RigPlayer(root, assets, { tracks: true })`. Pick the single track for a
rig whose animations key what the tracks do not mix (below); pick the tracks for
layering. Either way, after the first `mix`, `track` above 0, `queue` or `clear`,
`seek` and `skin` are refused by name, since the player cannot replay a composition
to a time — step it forward instead.
Every entry mixes from the setup pose each step, so `adjust` writes still last one
pose. **What the tracks do not mix**, in rig-c's words at `play`/`queue`: an
animation keying a constraint (ik, transform, path, physics, slider), a sequence,
the draw order, or a path's deform is refused when it is set on the tracks — it
plays on the single track only. `'event'` carries `track`; a one-shot that is
mixing out fires nothing. `'complete'` is per track, the player's rule: a looping
entry each cycle, a held one when it reaches its duration, and an entry that is
replaced — by `play`, or by the queued entry that starts at its completion less the
mix — completes no more than it fires.

### Adjusting bones

A per-pose write to bone locals — a breath's scale, a look's rotation, a mouth
driven while the body holds still:

```ts
const player = new RigPlayer(root, assets, {
  adjust: (bones) => { bones.bone('mouth').scaleY = 1 + openness; },
});
player.adjust = null;   // or set it later; setting it re-poses the held pose at once
```

The function runs once per pose, after the animation's timelines and before the
world transforms, constraints and physics — `rig-c/core`'s `openTrack({ adjust })`,
which rig-c holds to the Spine runtime at tolerance 0. **A write lasts one
pose.** The core poses every step from the setup pose, so a value you want held
is written again each pose and nothing compounds; a 0.8 caller that multiplied a
channel on a skeleton it kept between frames writes the value it wants, every
pose. It runs on every pose the animation is applied to, the first one after
`play` included, and `seek` and a `mode` change keep it.

A paused player and a zero step re-pose nothing, so a change the function would
make is not seen until the next step — unless you ask: setting `player.adjust`
re-poses the held pose at the same track time, and `player.repose()` does the
same for a function whose own state changed (the mouth above), without stepping,
firing events or drawing. A non-finite value, a bone the document does not have,
or an error the function throws refuses that step in the core's words, and the
track is reopened by the next `play` or `seek`.

### One load, several players

One `loadModel` backs any number of players: the regions are cut once, and
every player draws from the one `regionImages` map. A player owns none of it —
disposing a player leaves the bitmaps alive for the others — so there is exactly
one `assets.dispose()`, after the last player is gone:

```ts
const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const a = new RigPlayer(rootA, assets);
const b = new RigPlayer(rootB, assets, { skin: 'winter' });

a.dispose();
b.dispose();
assets.dispose();
```

A document is one rig. Two rigs whose builds share page images load as two
documents; the images are fetched by URL, so a page both name at the same URL
is loaded once by the browser — but each load cuts its own regions and owns its
own blob URLs.

### Loading it yourself

`loadModel` is a convenience over two calls the package exports: read the
document, load its pages, and cut the regions with `unpackRegions`, which takes
the document's `pages` section — `{ name, width, height, pma, regions: [{ name,
x, y, width, height, degrees }] }` per page — and a map of page images keyed by
those names. Use it when the page images do not come from a URL (`resolvePage`
on `loadModel` covers the ones that come from another URL), and pair it with
`revokeRegions` on unload.

A region the packer stored turned (`degrees: 90`) is cut upright again, and
which way round that is comes from the UVs a runtime assigns such a region,
not from the cut: its corners carry `(u2, v2), (u, v2), (u, v), (u2, v)` in the
order BL, UL, UR, BR, so the artwork's top-left corner sits at the packed rect's
bottom-left and unpacking it is a clockwise turn. Every release up to 0.7.0
turned it the other way and drew rotated rigid parts 180° round (#49).

`unpackRegions` mints one blob URL per region; `revokeRegions` is its
counterpart. It only frees URLs `unpackRegions` created, so a map you built
yourself and page images reused by the whole-page pass-through survive it — and
calling it twice is a no-op. Load once for the page's lifetime and you can
ignore it; load and unload repeatedly without it and you leak an atlas per
cycle.

### Loading for the canvas mode only, and `data:` regions

The region cut makes the rigid tier's bitmaps, which only the DOM mode draws.
`loadModel({ regions })` says what to do about it:

- `'blob'` (default) — `blob:` URLs the load owns; `assets.dispose()` frees them.
- `'data'` — `data:` URLs instead, for a content policy or a snapshot that does
  not carry `blob:`. The same PNG bytes, inline; nothing is minted, so there is
  nothing to free, and the base64 lives as long as the map does.
- `'none'` — no cut: the pages load, `assets.regionImages` is empty, and the
  load is for the canvas mode. A DOM-mode player opened on it — `new RigPlayer`
  without `mode: 'canvas'`, or `player.mode = 'dom'` — is refused by name, and
  a refused mode change leaves the player as it was.

`assets.regions` records the choice. `unpackRegions` takes the same thing as
`{ encoding: 'blob' | 'data' }`.

### Pages that ship at another resolution

A page image may ship at a resolution its document does not declare — a
half-resolution texture build, or an @2x variant, with the page's `width` and
`height` left as the build wrote them. Nothing here needs a flag for that. A
region's bounds are read **relative to the declared page size** and scaled onto
the image's natural size, which is how the page UVs the mesh tier samples with
are derived too (`u = x / page.width`), so both tiers land on the same pixels at
any resolution.

Each unpacked bitmap comes out at the **native resolution of the pixels it was
cut from** — half-resolution pages cost a quarter of the cut pixels, and
nothing is upscaled back — while `RegionImage.width`/`height` stay in **atlas
units**. Those two numbers are the `<img>` layout box and the denominator of
its CSS matrix, so the rig poses identically and the browser scales the
smaller bitmap into the same box, the way a GPU samples a smaller texture
through the same UVs. Ship one build and swap the images per device if you
like (`resolvePage`).

### Premultiplied pages (`pma`)

A page's `pma` flag in the document's `pages` section — the build copies it from
the atlas's `pma: true` line — says its RGB is already multiplied by its alpha,
and nothing is asked of you: each tier is handed the page in the convention it
actually consumes. The `webgl` mesh backend uploads the texels unconverted (its
blend already expects premultiplied source — lossless). The DOM and canvas2d
tiers cannot: an `<img>` and `drawImage` composite straight alpha by definition,
so they read a straight-alpha derivation of the page —
`rgb = round(rgb * 255 / a)`, computed once and shared by the region cuts and
the mesh raster. Without it every semi-transparent texel is multiplied by its
alpha a second time and draws darker than it was authored: soft edges, soft
shadows, glows.

What it costs: **one page-sized canvas per premultiplied page image**
(width × height × 4 bytes — 1 MiB for a 1024×256 page, 16 MiB for a 2048×2048
one), alive as long as the page image is and released with it; the cache is
weak, so there is nothing to free by hand. A page without the flag derives
nothing. The division is 8-bit and starts from a canvas read, which has itself
quantized a premultiplied texel, so a very transparent texel can land a few
levels off — exact at alpha 0 and 255, within one level of 255 above alpha 128,
and a little more below that, by an amount that belongs to the browser's canvas
rather than to this package. It is invisible wherever the texel is: a texel at
alpha 11 is ~4% opaque. The `webgl` backend, having no such step, is exact.

One consequence worth knowing if your build is one part per page: a whole-page
region on a premultiplied page is **cut** rather than handed through, because
the page's own URL holds premultiplied pixels (see below).

### What unloading frees

`revokeRegions()` — and `assets.dispose()`, which calls it — frees the blob URLs
`unpackRegions` minted, and nothing else (a `regions: 'data'` or `'none'` load
minted none, so it frees nothing). The page images are held by
`assets.pageImages` and by every player drawing from them, so a page is
released once you drop the assets and every player is disposed. With the
`webgl` mesh backend the shared blitter also uploads each page image on first
use, but that GL texture is not the module's forever: every renderer drawing
the page holds a reference to it, `player.dispose()` hands those back, and the
texture is deleted once the last renderer using that page is disposed — a later
frame that needs the page uploads it again. The cache is keyed weakly by the
page image, so a renderer dropped without `dispose()` costs GPU memory until
the context is lost, but never keeps the image itself alive.

A rig with meshes samples its page bitmaps every frame, so their decoded form
stays in use: a floor on the order of `page width × page height × 4` bytes per
page. A rigid-only rig draws nothing from the pages after `unpackRegions`, and
what a merely reachable, undrawn image costs is up to the browser, not
measurable from script.

Unload in this order:

1. `player.dispose()`, for every player using the assets.
2. `assets.dispose()` (or `revokeRegions(regionImages)`).
3. Drop your references to the assets.

### One part per page

`rigc build` writes one page per part by default — each part PNG is its own
page, its one region covering it — and `rigc build --pack` arranges the parts
onto shared pages instead. Both play here, unchanged:

- Regions that cover their whole page are handed straight through by
  `unpackRegions` instead of being cut and re-encoded — at any image resolution,
  since covering the page is a statement about the declared size. Load cost for
  this shape is just the image loads. The exception is a page marked `pma`: its
  URL holds premultiplied pixels, which an `<img>` would composite as straight
  alpha, so those regions are cut from the straight-alpha derivation like any
  other (and the blob is revoked by `revokeRegions` like any other).
- A packed build cuts every region from its page once, at load, and its meshes
  sample the shared page through page UVs.

### Runtime knobs and what they cost

- `player.mode` / `new RigPlayer(root, assets, { mode })` — `'dom'` (default)
  or `'canvas'`. Changing it disposes the current renderer (elements removed,
  GPU pages handed back) and creates the other over the same root and assets;
  `pixelRatio` and `clipping` carry over and the held pose is redrawn at once.
  `player.renderer` is then a `CanvasRenderer`, whose knobs are `pixelRatio`,
  `syncPixelRatio()`, `clipping`, `viewport` and `backend`. What each mode costs, as counters:
  - **dom** — one element per drawn slot, one style write per changed slot,
    and the mesh tier's rasters (the knobs below).
  - **canvas** — one canvas element per player and, per frame that changed,
    one pass over every slot: `drawCalls` (one per run of one page under one
    blend), `blendFlushes` (runs a blend change ended), `trianglesDrawn`,
    `blits` (one), or `framesReused` (one) when the record did not change and
    nothing is drawn. It never creates a WebGL context of its own, so any number
    of players stays under the browser's ~16-context cap (20 players, one
    context — `tests/canvas-mode.spec.ts`). The canvas covers a rect of the
    root's coordinates that grows (never shrinks) to what the frames draw —
    `canvasReallocCount` settles at zero — or a fixed `renderer.viewport` (world
    units, Y up) when you set one. Blends are composed inside that canvas, which
    starts transparent: an additive slot adds onto the slots under it and is
    then composited onto the page normally, where the DOM tier's
    `plus-lighter` adds onto the page itself. Where WebGL is unavailable or the
    context is lost, the frame is drawn with canvas2d on the same canvas so it
    never draws nothing — **alpha tint only, RGB and dark tint unsupported
    there** — and that fallback is **not the measured path** (`backendActive`
    says which ran).

- `renderer.pixelRatio` — mesh-canvas backing pixels per CSS pixel (defaults to
  `devicePixelRatio`; if you scale the root element, fold that scale in so the
  raster matches the screen: `devicePixelRatio * rootScale`). **Writing it
  reallocates every mesh canvas backing store on the next frame**, and each
  reallocation recreates a GPU surface — the cost that took real Safari to ~3 fps
  when it happened per frame. Each canvas is then sized from what the new ratio
  needs, in both directions: lowering the ratio gives the backing pixels back
  (the backing is grow-only *within* a ratio, not across a change of one). Set
  it when a layout settles, never per frame:
  debounce resize drags and quantize the value instead of tracking it
  continuously. `renderer.canvasReallocCount` is the check — it must fall back to
  zero within a second or two.
- `renderer.syncPixelRatio()` — measures the root's effective on-screen scale
  and sets `pixelRatio` to `devicePixelRatio × scale`, returning the ratio now
  in effect. It appends a hidden 100 px box to the root, reads its box once and
  removes it (the root itself is usually 0×0), so it is **one forced layout per
  call** — which is exactly why the renderer never calls it for you: there is no
  per-frame layout read anywhere in this library. Call it when a zoom or a
  layout *settles* (gesture end, debounced resize), not during the drag. A
  change under 0.1% is ignored, so layout jitter cannot churn GPU surfaces, and
  a root that is not laid out (a `display: none` ancestor) leaves the ratio
  alone. Under an ancestor rotation the measured box is inflated and the ratio
  errs high — oversampling costs pixels, undersampling costs picture.
- `renderer.meshBackingPixels` — allocated mesh-canvas backing pixels
  (Σ width × height), computed on demand. This is what `pixelRatio` moves
  quadratically, and the cheapest way to see an oversampling stage; the demo
  prints it in the stats line as `backing N Mpx`.
- `renderer.meshBackend` — `'webgl'` (default since 1.9) or `'canvas2d'`; same
  output, and on macOS Safari webgl holds 58–60 fps where canvas2d reads 2–26
  (see Measured above). Falls back to canvas2d automatically when WebGL is
  unavailable or the shared context is lost; `meshBackendActive` says which drew. Switching re-rasters every
  mesh once (no reallocation), so it is fine to expose as a user setting.
- `renderer.triangleExpand` — how far (canvas px) each triangle edge's clip is
  moved outward to close antialiased mesh seams (default 0.5). Also re-rasters every mesh once when changed.
- `renderer.meshSourceRect` — what a canvas2d mesh triangle is drawn from:
  `'page'` (the whole page) or `'triangle'` (a sub-rect covering its clip). Both
  draw the same picture; the default is `'triangle'` on Linux WebKit, which
  garbles whole-page draws, and `'page'` elsewhere, because macOS Safari ran the
  sub-rect 12–15% slower (#25). Also on `CanvasRenderer` for its canvas2d
  fallback. Re-rasters every mesh once when changed.
- `renderer.clipping` — apply the clips the frame carries (default `true`).
  Which slots a clip covers is decided where the frame is made — the player's
  adapter walks the draw order the way the runtime's draw loop does (one clip in
  force at a time, a second one met while one is in force ignored, the end slot
  inside its own clip). What the renderer writes is one CSS `clip-path` per
  element a clip covers, in that
  element's own local frame; nothing reaches the raster backends, and a clip is
  not part of the mesh dirty signature, so a mesh that held still keeps reusing
  its raster under a moving clip. **Writes happen on change only**: each
  clip-path is cached exactly as `transform` is, coordinates are quantized to
  1/1000 of a local unit so float jitter cannot defeat that cache, and a static
  polygon over a static pose therefore costs **zero style writes per frame after
  the first** — `renderer.clipWriteCount` is the check, alongside
  `clipCount` (clips applied) and `clipSkipCount` (clips in the frame not
  applied: switched off, or a degenerate polygon; a clip the runtime itself
  ignores never reaches the frame). **The whole-skeleton fast path**: when one
  clip covers every slot of the frame, one `clip-path` goes on the root instead
  of one per element. The root is *your* element, so its inline `clip-path` is **borrowed,
  not taken** — saved on the first write and put back verbatim when the clip
  stops covering the frame, when `clipping` goes `false`, and by `dispose()`.
  Per-element clip-paths and the root clip-path are never both in force for the
  same clip. Two things to know about that path: the polygon is written in the
  root's **border box** frame, which is where absolutely-positioned slot elements
  start too *unless the root has a CSS border* (a border would offset the
  whole-skeleton clip by its width — keep borders off the render root, which is
  the normal shape for a 0×0 origin element); and an inverse clip never takes it,
  because its CSS form needs an outer ring around a box and the root has none.
  One further consequence of that path: a `clip-path` other than `none` makes an
  element a stacking context (CSS Masking), so a whole-skeleton clip isolates
  `mix-blend-mode` slots from backdrops *outside* the root — which a root
  carrying a `transform` (the usual pan/zoom stage) already does. Per-element
  clips do not change blending, since a blended slot is its own stacking context
  either way. Setting `clipping = false` removes every clip-path this renderer
  wrote.

**A zoomable stage.** The mesh tier rasters at `world × pixelRatio` in the
root's own coordinates, and it cannot see a CSS transform above the root — so
the most natural pan/zoom stage, `transform: scale(zoom)` on an ancestor, makes
it oversample by `1/zoom²` in backing pixels until the zoom is folded in. The
picture stays correct throughout, which is what makes this easy to ship: only
the allocation and the frame rate move. Call `syncPixelRatio()` when the zoom
settles, or set `pixelRatio = devicePixelRatio * zoom` yourself. Measured
on-device (Chromium, dpr 2, stage under `scale(0.25)`, ~2.2 M CSS px on screen):

| scene | `pixelRatio` | `meshBackingPixels` | fps |
| --- | --- | --- | --- |
| 57 meshes | `devicePixelRatio` (2) | 139.1 Mpx | 14–21 |
| 57 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 61 |
| 92 meshes | `devicePixelRatio` (2) | 141.1 Mpx | 36–39 |
| 92 meshes | `dpr × zoom` (0.5) | 9.1 Mpx | 60–61 |

## Coming from 1.8: meshes draw through WebGL by default

From 1.9 the element mode rasterizes its meshes through the one shared WebGL
context unless told otherwise (`DomRenderer.meshBackend` defaults to `'webgl'`,
#109). The picture is the same within the parity suite's bounds, the API is
unchanged, and canvas2d is still drawn wherever WebGL is unavailable or the
context is lost. What a caller can notice:

- The page holds one more WebGL context (one for every mesh of every player, not
  one per player). A page already near the browser's cap of about 16 live
  contexts can lose its oldest one when this one is created.
- `meshBackendActive` reads `'webgl'` where it read `'canvas2d'`.
- Frame cost moves from the page to the GPU blit (see *Measured*).

To keep 1.8's raster, set it back, up front or on a live player:

```ts
const player = new RigPlayer(root, assets, { meshBackend: 'canvas2d' });
// or, on a renderer you hold:
renderer.meshBackend = 'canvas2d';
```

The canvas mode was already webgl by default and does not change.

## Coming from spine-html 0.8

This is not a drop-in upgrade. 0.8 drew a Spine export (`.json` or `.skel`, plus its
`.atlas`) that `@esotericsoftware/spine-core` parsed and posed: the caller built the
`Skeleton` and the `AnimationState`, advanced them each frame, and handed the skeleton to
`renderer.render(skeleton)`. 1.0 loads one file, the `skeleton.model.json` that
`rigc build` writes, poses it through `rig-c/core` (bundled into the package, with no peer
dependency), and `RigPlayer` owns the track, so the caller's frame is `player.frame(dt)`.
A Spine export is refused by name before anything is fetched: the data has to be a rigc
build, and this package declares no loader for anything else.

What did not move: a positioned root element is still the rig's origin (Y up) with its
layout and scaling left to the caller, the DOM tier keeps its knobs under a new class
name, and unloading is still elements first, bitmaps second.

### 0.8 → 1.0

| 0.8.0 (`spine-html`) | 1.x (`@rig-c/play`, formerly `rig-play`) | Note |
| --- | --- | --- |
| `npm i spine-html @esotericsoftware/spine-core` | `npm i @rig-c/play`, and `npm i -D rig-c` for the build tool | 0.8 declared spine-core as a peer dependency (`>=4.0.0 <4.4.0`). 1.0.0 declares no dependencies and no peer dependencies. |
| `loadSkeletonAssets(options)` | `loadModel(options)` | One URL instead of two. The `.atlas` and `skeleton.json` a build writes beside the document are not fetched. |
| `LoadSkeletonAssetsOptions.atlasUrl`, `skeletonUrl` | `LoadModelOptions.modelUrl` | |
| `resolvePage(pageName, atlasUrl)` | `resolvePage(pageName, modelUrl)` | The default now resolves a page name against the model URL's directory. |
| `crossOrigin`, `fetch` | `crossOrigin`, `fetch` | Unchanged. |
| `scale` (`LoadSkeletonAssetsOptions`, `LoadSkeletonJsonOptions`) | none | See below. |
| `SkeletonAssets` | `ModelAssets` | |
| `SkeletonAssets.data` | `ModelAssets.document`, `animations`, `skins`, `stage`, `spec` | `document` is opaque (`ModelDocument`); the player poses it. What a caller used to read off the skeleton data is stated as `animations` (name and duration), `skins` (names) and `stage` (the stage the build declared, or null). |
| `SkeletonAssets.atlas` | `ModelAssets.pageImages` | The page images, keyed by page name. There is no atlas object; where each region sits is in the document's `pages` section. |
| `SkeletonAssets.regionImages` | `ModelAssets.regionImages` | Same `Map<string, RegionImage>`. |
| `SkeletonAssets.dispose()`, `AtlasAssets.dispose()` | `ModelAssets.dispose()` | Same contract: frees the blob URLs the load minted, idempotent, called after the players are disposed. |
| `loadAtlasAssets` + `loadSkeletonJson` (one atlas, several skeletons) | none | One `loadModel` backs any number of `RigPlayer`s of the same rig. Two rigs are two loads, and each cuts its own regions. See below. |
| `loadSkeletonBinary` from `spine-html/binary` | none | 1.0.0 has one entry point. A `.skel` URL is refused by name. |
| `unpackRegions(atlas, pageImages)` | `unpackRegions(pages, pageImages)` | The first argument is the document's `pages` section (`readonly PageLayout[]`) instead of a `TextureAtlas`. |
| `revokeRegions(images)` | `revokeRegions(images)` | Unchanged. |
| `RegionImage` | `RegionImage` | Unchanged (`url`, `width`, `height`, in atlas units). |
| `DomTexture` | none | Not exported; there is no atlas page to attach a texture to. |
| `new Skeleton(assets.data)` and `new AnimationState(new AnimationStateData(assets.data))` | `new RigPlayer(root, assets, options?)` | The player holds the pose and the track. |
| `state.setAnimation(0, 'walk', true)` | `player.play('walk', { loop: true })` | `loop` defaults to true. `play` opens the animation at its first pose with the physics reset there. `player.current` names what is playing. |
| `skeleton.findSlot('x').attachment = null` to hide a slot, or a second skeleton with slots emptied | `RigPlayerOptions.slots`, `player.slots`, `player.posedFrame(slots)` | A draw filter since 1.6.0 — the pose is the whole rig's; a clipping slot left out does not clip. See *Drawing some slots only*. |
| `state.setAnimation(1, 'smile', false)` with a mix, `addAnimation`, `setEmptyAnimation`, `addEmptyAnimation`, `getCurrent(track)`, `entry.alpha`, `entry.additive` | `player.play(name, { track, loop, mix, alpha, additive })`, `player.queue(name, { track, loop, mix, delay, alpha, additive })`, `player.clear(track, { mix })`, `player.queueClear(track, { mix, delay })`, `player.setAlpha(track, alpha)`, `player.entry(track)` | Since 1.5.0, rig-c's live tracks: the runtime's mixing at tolerance 0. Constraint, sequence, draw-order and path-deform timelines are not mixed and are refused on the tracks. See *Several tracks*. |
| `state.update(delta)`, `state.apply(skeleton)`, `skeleton.update(delta)`, `skeleton.updateWorldTransform(Physics.update)`, `renderer.render(skeleton)` | `player.frame(dt)` | Or `player.advance(dt)` then `player.draw()`, to time the two apart. |
| time scale (the caller's own, on the spine-core side) | `player.timeScale` | Multiplies every step. 0 holds the pose without re-posing it; a negative value is not stepped. |
| holding a pose (the caller stopped advancing) | `player.pause()`, `player.resume()` | `frame` keeps drawing the held pose. |
| moving to a time (the caller's own, on the spine-core side) | `player.seek(time)`, `RigPlayerOptions.seekStep`, `player.time` | A seek reopens the animation and steps forward in `seekStep` increments (1/60 s by default). Events and completes crossed on the way are not fired. |
| events (the caller's own listener on the spine-core side) | `player.on('event', listener)`, `player.on('complete', listener)` | `'event'` hands a `RigEvent` (`name`, `time`, `int`, `float`, `string`, `track`); `'complete'` hands `{ animation, track }`. `on` returns a function that removes the listener. |
| skin (set by the caller on its `Skeleton`) | `RigPlayerOptions.skin`, `player.skin` | A constructor option, and settable on a live player since 1.4.0: the pose re-resolves under the new skin and the track keeps its animation, loop and time (reopened and stepped there, as `seek` does). The names are in `ModelAssets.skins`. Without it the rig is posed with no skin set. |
| `SpineHtmlRenderer` | `DomRenderer`, reached as `player.renderer` | In `mode: 'dom'`, the default. `mode: 'canvas'` is new and makes `player.renderer` a `CanvasRenderer`. |
| `new SpineHtmlRenderer(root, regionImages)` | `new DomRenderer(root, regionImages, pages?)` | Only for drawing your own frames; `RigPlayer` constructs its renderer. `pages` is the page-image map the mesh tier samples (`ModelAssets.pageImages`). A hand-built `regionImages` map is still accepted. |
| `renderer.render(skeleton)` | `renderer.render(frame)` | Takes a `PosedFrame`, not a skeleton. `player.posedFrame()` returns the one the player would draw. |
| `renderer.pixelRatio` | `player.renderer.pixelRatio` | On both renderers. Carried over when `player.mode` changes. |
| `renderer.syncPixelRatio()` | `player.renderer.syncPixelRatio()` | On both renderers, the same meaning and the same deadband (since 1.3.0; before it, DOM mode only). |
| `renderer.meshBackingPixels` | `DomRenderer.meshBackingPixels` | DOM mode only. |
| `renderer.meshBackend`, `meshBackendActive`, type `MeshBackend` | `DomRenderer.meshBackend`, `meshBackendActive`, type `MeshBackend` | Same values; the default is `'webgl'` since 1.9 (`'canvas2d'` before). Also settable up front as `RigPlayerOptions.meshBackend`. |
| `renderer.triangleExpand` | `DomRenderer.triangleExpand` | Same default (0.5). |
| `renderer.clipping` | `player.renderer.clipping` | On both renderers. Carried over when `player.mode` changes. |
| `clipCount`, `clipSkipCount`, `clipWriteCount` | same names on `DomRenderer` | `clipSkipCount` counts less than it did: a second clip met while one is in force, and a clip on an inactive bone, no longer reach the frame, so they are not counted. |
| `meshCount`, `meshReuseCount`, `canvasReallocCount`, `triangleCount` | same names on `DomRenderer` | |
| tint: skeleton × slot × attachment colour | `player.color` × slot × attachment | `player.color` is `[r, g, b, a]` and takes the place of the skeleton's colour. The product arrives as `tint` on each `PosedSlot`. |
| dark (two-colour) tint: unsupported | `DomRenderer`: unsupported. `CanvasRenderer`: drawn | Carried as `dark` on a `PosedSlot`. The canvas mode's canvas2d fallback draws alpha only. |
| `renderer.dispose()` | `player.dispose()` | Then `assets.dispose()`, as before. `DomRenderer.dispose()` and `CanvasRenderer.dispose()` exist for a renderer you constructed yourself. |
| `skeleton.findBone('head').worldX`, `.worldY`, `.a` … `.d` | `player.bone('head')` | `{ x, y, a, b, c, d, rotationX, rotationY, scaleX, scaleY, active }`, the core's world transform for the pose the player holds (the setup pose before `play`). An unknown name is refused by name. Since 1.1.0. |
| `bone.scaleY = …` on a `Skeleton` between `state.apply` and `updateWorldTransform` | `RigPlayerOptions.adjust`, `player.adjust`, `player.repose()` | A function called once per pose with the pose's bone locals (`bones.bone('mouth').scaleY = v`). A write lasts one pose: the core poses every step from the setup pose, so write the value you want, every pose — nothing compounds. See *Adjusting bones*. Since 1.2.0. |
| `skeleton.getBounds(offset, size)` | `player.bounds()` | `{ x, y, width, height }` or null, world units, Y up: the box of every drawn region's corners and mesh's vertices, a slot under a clip counted inside the clip's own box. `ModelAssets.stage` remains the declared framing, not this box. Since 1.1.0. |

### No counterpart in 1.0.0

Things a 0.8 caller could do because it held the spine-core objects, or through a 0.8
export, for which 1.0.0 declares nothing:

- **A Spine export as input.** `loadSkeletonJson`, `loadSkeletonBinary`, `loadAtlasAssets`,
  the `spine-html/binary` entry and `DomTexture` have no counterpart, and neither does
  choosing which spine-core generation reads the data. `loadModel` reads a compiled model
  document and nothing else.
- **Scaling the skeleton as it is read.** `LoadModelOptions` declares no `scale`. Scaling
  the root element is still the caller's.
- **One unpacked atlas shared by different skeletons.** A document is one rig, and each
  `loadModel` cuts its own regions and owns its own blob URLs. Sharing is per rig: one
  load, several players.
- **Changing one slot from code** (its attachment, its colour). `RigPlayer` declares only
  the whole-rig `color`. The frame record is a plain object, so a caller that draws its
  own frames through `DomRenderer.render` or `CanvasRenderer.render` decides what is in
  it.
- **Choosing how physics is stepped each frame.** 0.8's loop passed `Physics.update`
  itself; 1.0.0 declares no physics option. `play` and `seek` reset physics at the
  animation's first pose and every step advances it.
- **Track callbacks other than the two declared.** `on` accepts `'event'` and
  `'complete'`.

Knobs on `DomRenderer` that `CanvasRenderer` does not declare:

- `meshBackend` and `meshBackendActive`. The canvas mode has its own pair, `backend` and
  `backendActive` (type `CanvasBackend`, `'webgl'` by default).
- `triangleExpand`, `meshBackingPixels`, `clipWriteCount`, `meshCount`, `meshReuseCount`,
  `triangleCount`. The canvas mode's counters are `drawCalls`, `blendFlushes`,
  `trianglesDrawn`, `framesReused` and `blits`.

Both declare `pixelRatio`, `clipping`, `clipCount`, `clipSkipCount`, `canvasReallocCount`,
`render` and `dispose`. Only `pixelRatio` and `clipping` carry over when `player.mode`
changes.

### Before and after

0.8.0:

```ts
import { Skeleton, AnimationState, AnimationStateData, Physics } from '@esotericsoftware/spine-core';
import { loadSkeletonAssets, SpineHtmlRenderer } from 'spine-html';
const assets = await loadSkeletonAssets({ atlasUrl: '/hero/hero.atlas', skeletonUrl: '/hero/hero.json' });
const skeleton = new Skeleton(assets.data);
const state = new AnimationState(new AnimationStateData(assets.data));
state.setAnimation(0, 'walk', true);
const renderer = new SpineHtmlRenderer(rootElement, assets.regionImages);
function frame(delta: number) {
  state.update(delta);
  state.apply(skeleton);
  skeleton.update(delta);
  skeleton.updateWorldTransform(Physics.update);
  renderer.render(skeleton);
}
renderer.dispose(); assets.dispose(); // on unload
```

1.0.0:

```ts
import { loadModel, RigPlayer } from '@rig-c/play';
const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const player = new RigPlayer(rootElement, assets);
player.play('walk', { loop: true });
function frame(delta: number) {
  player.frame(delta);
}
player.dispose(); assets.dispose(); // on unload
```

## Demo (this repository)

```bash
bun install
bun run dev
```

The demo plays rigc's own gallery rigs (`walk`, `flex`, `squash`, `portrait`,
`nod`, `look`, `ride`), each built by `rigc build` from a pinned rigc tag into
`public/rigs/<name>/` on first `dev`/`build` — and each again with `--pack` into
`public/rigs/<name>-packed/`. The same step builds this repository's test rigs
(`tests/rigs/`: `figure`, `glow`, `turned`), which `?rig=` also reaches; nothing
is downloaded but the rigc tag's gallery sources. `bun run fetch-assets` runs it
manually, and it is idempotent.

Debug knobs (query string): `?rig=flex` `?anim=wave` `?count=10` pick the scene,
`?tint=ff8080` tints the whole rig, `?dpr=2` overrides the mesh-canvas backing
ratio, `?timescale=0` freezes the pose (every mesh should report "reused"),
`?expand=0` disables the crack-closing clip overdraw, `?backend=webgl` rasterizes
meshes through the shared WebGL blitter (also a live header select; the stats line
names the active backend), `?clipping=0` turns clips back off (they are then
counted and skipped), and `?time=1.2` seeks every instance to the same pose for
deterministic captures.

## Tests

```bash
bun run test   # builds + serves the demo, then runs chromium + webkit
```

Playwright drives rigc-built gallery and procedural test rigs through the
production `RigPlayer`; its pose comes from `rig-c/core`. CI runs the same
suite on Ubuntu with Chromium and WebKit. Internal parity captures the same
deterministic pose in two modes/backends within one engine. An independent
development oracle also reads the paired Spine export through the official
WebGL runtime. No snapshot goldens are committed. Residue limits are measured
per engine, case and renderer; an A/B design alone does not make a measured
budget portable to another platform. Pose discrepancies remain rigc issues;
the independent oracle checks the resulting raster.

**Internal picture parity** checks the two render modes drawing the same picture: every
scene captured in the DOM mode and in the canvas mode and diffed — bad pixels at
most 1.5% of drawn content on the test-rig scenes (measured floors 0.007–0.524%,
macOS Chromium; each scene's own feature dropped from the canvas mode — tint,
additive blend, clipping, a mesh — scores 4.2–77%) and 2.5% on the gallery
scenes (floors 0.585–1.553%, Chromium and WebKit). The DOM tier's two mesh
backends get the same A/B (`?backend=canvas2d` against `?backend=webgl`, at most
0.5%). Hairline seams are guarded by a deterministic canary (`?expand=0` must
change the canvas2d raster), the canvas2d source sub-rect by another (expand 32
against 8, forced to the sub-rect), the two source rects by an A/B that must
match exactly, and counter tests pin the dirty-skip / grow-only-backing /
clip-counter invariants plus the region corner order (BL, UL, UR, BR) and the
turned-region UVs, read off rig-c's pose against hand-written numbers.

Clipping gets its own oracle (`tests/clipping.spec.ts`), because a clip-path
that went through the wrong transform still parses and still counts as applied.
A clipped capture is compared against the **unclipped** capture of the same
slots masked in **screen space** by the world polygon — built once through the
stage transform, never through an element's local frame, so the check cannot
agree with the renderer by sharing its mistake. What it asserts is occupancy,
not pixel values: outside a 3 px band around the polygon's outline (where the
browser's clip-path antialiasing and the canvas `ctx.clip()` the oracle uses
legitimately differ), **no artwork may survive where the polygon excludes it
and none may go missing where it does not** — both counts absolute, no budget.
Pixel values are logged but not asserted, because a clipped element is drawn
through a mask and its silhouettes come out a shade different all over the
picture; a control capture, clipped by a polygon that removes nothing, pins
that down by coming back byte-identical to the unclipped one.

The loading path is not observable in a rendered frame, so it gets its own
page (`tests/harness.html`, a second build entry) that exposes the library to
the specs directly. Its oracle is the browser: a revoked object URL stops
resolving, so blob ownership — every unpacked URL freed, nothing the caller
owns touched, nothing stranded by a failed load — is asserted rather than
assumed.

### Independent official raster oracle

`tests/oracle.spec.ts` compares real DOM WebGL, DOM canvas2d and whole-canvas
output with `@esotericsoftware/spine-webgl` 4.3.13. The official reader parses
the same build's Spine JSON, atlas and original PNGs independently; it never
receives a `PosedFrame` or the player's alpha-corrected textures. JSON SHA-256
binds the export to the compiled model, and generation/page dimensions fail
closed. Both posers receive the same fixed-step history, crop, origin, scale
and DPR 1; world geometry must agree exactly before raster acceptance.

Captures include the actual images, element canvases, CSS transforms, tint
and clipping. Transparent RGB remains diagnostic, except for additional narrow
raw checks on the whole-canvas PMA case. Acceptance compares those
same captured bytes on black and white backgrounds with the shared pixel
differ, and separately constrains alpha coverage, sum, unequal-pixel count
and maximum. `tests/oracleLimits.ts` stores measured engine/case/mode floors:
zero stays exact; nonzero counts receive 10% plus two units, and nonzero byte
maxima one byte. macOS and Linux have separately measured tables; other
platforms are refused as uncalibrated. Tests never regenerate limits from the
image under test.

Cases cover geometry, tint, clipping, draw order with multiply/screen,
rotated/named regions, additive glow and an original-PMA twin. Named UV and
rotation coverage uses native scale: measured half-scale checker sampling
has additional residue, so arbitrary-scale pixel identity is not claimed.
The shared #37 negative control serves false PMA flags only in the player's
model response, leaving original files and the official reader unchanged.
Each renderer must first pass its healthy capture, then exceed the same
healthy black-composite budget with the altered response. This runs on both
CI browser projects. Original PMA PNG bytes are encoded before either reader
sees them.

The reference uses `antialias:false`, `preserveDrawingBuffer:true` and the
official `pmaAdditiveBatching:false` option to retain additive coverage in
transparent captures. Initialization finishes model/region extraction before
official page uploads, avoiding a measured concurrent WebKit initialization
artifact. Use the required nova-run guard and a unique `TEST_PORT` for a
focused `bun run test tests/oracle.spec.ts --workers=1`; full-suite acceptance
remains CI. Headless results are raster evidence, never device performance.

## Benchmark: DOM, canvas and official WebGL

```bash
bun run bench:dev     # the page, for a person to watch (and for Safari)
bun run bench         # drives it in a headed Chromium and writes a report
bun run bench --headless # counters only; all timing fields are null
```

`bench/` is a separate vite project — not part of the library, and not part of
what `bun run build` emits — that compares DOM, whole-canvas and the independent
official WebGL reader, each with its own stats line. The paired JSON hash must
match the model before an official comparison can publish readings.
Scenes by query string: `?scene=mesh` (`portrait-packed` turning its head, the
deform tier working every frame), `?scene=held` (the same pose frozen, where
unchanged meshes reuse their raster and an unchanged frame is reused),
`?scene=rigid` (`walk-packed`, region attachments only) and
`?scene=many&count=N` independent players; `?rig=` and `?model=` name another
build. All four take `&count=N` up to 64 (a page limit, so that a cell stays
something you can see), laid out on one grid whose per-rig scale shrinks with
the column count, so a step up in count adds rigs rather than cropping the ones
already there.

**The comparison uses the same framing.** All paths place rigs with one derivation and
clip each to the same rect — the pane for a grid, the rig's own cell for `many`
— with `overflow: hidden` on a box, the way a page embeds a player, and then
*check* it: each side reports `origin Δpx`, the largest gap between where the
grid puts a rig and where that side drew it, and the report table carries it per
row. (`contain: layout paint` is deliberately not used: paint containment clips
to the same edge `overflow: hidden` does, and what it adds past the clip — a
stacking context, a containing block, an independent formatting context —
changes how one side is composited and buys the comparison nothing.) Production
modes retain the package's shared WebGL context. Official grid scenes batch
all skeletons through one context; only `many` uses independent contexts.
Official surviving contexts and drawn players are counted separately from
requested players. Production survival counters are null where its public
API cannot measure them, rather than treating requested counts as survivors.

`scripts/bench.mjs` walks `bench/scenes.json`, opens each scene in a **headed**
Chromium (a hidden page throttles `requestAnimationFrame`, so a headless
reading would be the browser's power policy rather than either mode's cost),
runs a fixed number of frames per mode — one at a time, because rAF has a single
cadence per document — and writes JSON plus a markdown table with the
conditions attached: browser version, device pixel ratio, window size, GPU
string, and the load average before and after. A software or unidentified GPU
invalidates a headed timing report. Over a load threshold it stamps the
whole report `INVALID: load average too high` and exits non-zero, because a
benchmark on a busy machine measures the machine. `--corpus <dir>` points it at
local rigc builds that never enter this repository. `--headless` instead steps
fixed frames and records counters only: FPS, pose/render timing and GPU fields
are null, with “측정 불가: 헤드리스” in JSON and the table. The official
additive-batching and drawing-buffer settings are recorded as conditions.

> **Performance numbers pending.** Counter reports establish the instrument,
> not a performance comparison. A timing reading taken on
> a loaded machine, a CI runner or a headless browser would not be worth
> printing. The table will be taken the way every other number in this README
> was: the stats lines read on a real device, on a quiet machine, per scene
> and per engine — including Safari, which stays manual because no automation
> preserves what is being measured there. Until then the instrument exists and
> the measurement does not.

The server is part of the test: a run tests whatever is being served on its
port. Two checkouts of this repository on one machine (a worktree, a second
clone) default to the same port 4321 and reuse an existing server, so the
second run quietly tests the first one's build — green, and about the wrong
tree. Give each concurrent checkout its own port with `TEST_PORT`
(`TEST_PORT=4333 bun run test`); setting it also disables server reuse, so a
busy port fails the run instead of being borrowed. Unset, nothing changes:
port 4321, reuse unless `CI`.

Standing rule: **headless numbers are never Safari performance evidence** —
nothing in the suite asserts timing, and headless-WebKit fps/ms readings do
not transfer (software rasterizer, measured up to 28× off real Safari). The
perf oracle is the demo's stats line on a real device.

## How it works

1. `loadModel` reads the rig's compiled model document (`rig-c/core`'s `readModel`),
   and `RigPlayer` opens an animation on a live track (`openTrack`): bones,
   constraints, physics, deform and draw order are posed by the core — all
   CPU-side, renderer-agnostic — one `dt` at a time.
2. At load time each region of the document's `pages` section is cut into its own
   bitmap (rotation restored), one blob URL per region — except regions that already
   cover their whole page, which are used as they are.
3. Per frame, the pose becomes a `PosedFrame`: for each slot in draw order, a region's
   four world corners (order **BL, UL, UR, BR**) or a mesh's world vertices, page UVs
   and triangles, its tint, blend and clip. For a region: flip Y (the frame is Y-up),
   derive the affine from three corners, write one `matrix()` string. That's the
   whole rigid render path.

## License

@rig-c/play's own code is MIT (see [LICENSE](LICENSE)). That says nothing about Spine,
so here is what is true of this package and this repository, stated plainly:

1. The published package — `@rig-c/play`, and `rig-play` and `spine-html`, the same files — **links
   nothing from Esoteric Software**. Its one module bundles the renderer and
   `rig-c/core` (MIT), which poses rigc's model document; no part of the
   [Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) is in it or
   required beside it.
2. Development tooling pins `@esotericsoftware/spine-webgl` 4.3.13 and its matching
   spine-core dependency for the independent oracle and comparison/benchmark.
   The [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license)
   covers those runtimes, not this project's MIT license. They remain outside
   production source, the public API and the library package; package guards
   and the library-only pack allowlist hold that boundary.
3. `rigc build`, which this repository runs to make its fixtures, also writes Spine
   skeleton data (`skeleton.json` and `skeleton.atlas`) beside each model document.
   Development tooling reads this paired export independently. Generated fixtures
   remain gitignored and excluded from the library package. See [NOTICE.md](NOTICE.md).
4. A product that plays that Spine data with a Spine Runtime has integrated the Spine
   Runtimes, whose licence permits it **under Section 2 of the
   [Spine Editor License Agreement](https://esotericsoftware.com/spine-editor-license)**,
   or otherwise on the condition that **each user of the product obtains their own
   Spine Editor license** — the licence's own two routes, restated, not a term of
   this project.

> **What a consumer does with rigc's Spine-format output is governed by Esoteric
> Software's terms**, not by this package — @rig-c/play neither adds those terms nor
> removes them.

No example assets of Esoteric Software's are fetched or redistributed. See
[NOTICE.md](NOTICE.md) for the full notice.
