# CLAUDE.md

Guidance for AI-assisted sessions working on this repository.

## What this is

`@rig-c/play` (this repository, `rig-c/play`) renders rigs built by rigc as plain
DOM — rigid slots as `<img>` posed
by CSS `matrix()`, mesh slots on small per-part canvases (canvas2d or WebGL-blit
backend), interleaved in one stacking context. It loads the compiled model
document `rigc build` writes (`skeleton.model.json`, `rigc-compiled/3`), poses it
through `rig-c/core`, and draws each pose as a `PosedFrame`. Production since
v0.3.0; the model path since #60. Read README.md for architecture and measured
numbers. `rig-play` and `spine-html` are the same package under earlier names.

## Measurement rules (hard-won — do not relearn these)

- **Headless WebKit is a software rasterizer.** Never cite its timings as Safari
  performance evidence — measured up to 28× off real Safari, in both directions.
  Headless is for visual regression only.
- **The perf oracle is the demo stats line read on a real device** (it shows
  rAF-cadence fps; clicking it copies it). In-callback ms cannot see
  compositor/GPU cost: the Safari clip-AA incident reported 4 ms JS while the
  screen ran at 4 fps.
- Safari antialiases canvas2d **clip paths**, so the per-triangle clip mapping
  pays a per-triangle AA-mask tax in the GPU process. That is why the webgl mesh
  backend exists — switch backends rather than micro-optimizing the canvas2d
  triangle path for Safari.
- Never assert absolute milliseconds in tests; assert the deterministic counters
  (drawn / reused / realloc'd / clips applied / clips skipped / clip-path
  writes) instead.

## Architecture invariants

- **`rig-c/core` is the only math source; the renderer only draws.** Nothing
  in the repository imports a package of Esoteric Software's npm scope — no
  dependency of any kind, no lockfile entry, no file under `src/`, `tests/` or
  `bench/` (#63).
  The pose comes from `openTrack` (rig-c `src/core/track.ts`, the live track
  issue #1276 added: pose 0, then one pose per `step(dt)`), and the renderer is
  handed a **`PosedFrame`**, never a skeleton: per slot in draw order the kind,
  four world corners or world vertices + page UVs + triangles, the region or the
  page + `pma`, a tint, a blend, a clip polygon, a z. `DomRenderer.render(frame)`
  is the whole interface between posing and drawing, so another poser — or the
  one-canvas mode — feeds the same record.
- **The adapter is `src/posedFrame.ts` (`frameOf`), re-cut over `rig-c/core`
  alone from rigc's `src/render_core.ts`**, which is its specification and
  cannot be imported (it value-imports node-bound modules). The rules, each one
  rigc's: `order` is `pose.drawn` on active bones (`activeBones` of the view —
  `pose.drawn` lists inactive-bone slots too, the oracle's convention), `z` the
  slot's index in the full `pose.drawOrder`; a region's `corners` are its drawn
  vertices, already in the runtime's BL, UL, UR, BR order; a mesh's `uvs` are
  `meshPageUvs` over the region `drawnRegions` resolves (a sequence frame's own
  region, a linked mesh's own region over its source's UVs) and its
  `page`/`pma` that region's page; `tint` is the slot row's `[2..5]` times the
  attachment's `colour`, channel by channel, then times the player's own colour
  (a player knob, not a document value); `dark` the row's `[6]`; `blend` the
  row's `[8]`; `clip` is `clipCover`, the official draw loop's
  `clipStart`/`clipEnd` (a clip whose bone is active starts when none is in
  force, covers the slots after it, ends after its end slot; a second clip while
  one is in force is ignored; an end slot that is the clip's own or already
  passed never ends it). Each started clip is **one object shared by every slot
  it covers** — the renderer reads that identity — and a mesh's `uvs` and
  `triangles` are **kept per region and attachment** so the same mapping is the
  same array every frame (the renderer's dirty signature compares them by
  identity). The pose's numbers are passed through as computed: no rounding, no
  re-ordering. The renderer keeps reading vertices through its own Float32
  scratch, exactly as it always read them, so the raster, the dirty signature
  and the clip-path quantization saw no change of precision.
- **The player reads `rigc-compiled/*` and refuses everything else.**
  `loadModel` hands the document to rig-c's `readModel`, and a `spec` it does not
  read is refused with `readModel`'s own sentence plus "build it with `rigc
  build`"; a Spine export (`.json` not ending `.model.json`, `.skel`) is refused
  by name before anything is fetched, and so is a `rigc-compiled/1` document (no
  `pages`). Generation knowledge — which Spine versions an export comes from and
  what each runtime reads of it — is rigc's (`docs/GENERATIONS.md` there), not
  this package's: the seam over spine-core 4.0–4.3 and its four CI columns went
  with the package's own spine-core reads (#60, #63).
- **The poser is `rig-c`, pinned to an exact version, and a pose doubt is a
  rigc issue.** `devDependencies["rig-c"]` is a bare version (no range;
  `tests/package.spec.ts` asserts it), the build bundles that version's
  `./core` into `index.js`, and `scripts/fetch-assets.sh` builds every fixture
  with the same version's `rigc build` from the same tag. This repository holds
  no Spine runtime as an oracle: what the player poses is what rig-c's own CI
  holds to spine-core 4.3.13 at tolerance 0 (`core_gate`, `--raw`; rigc
  `docs/SECOND_ORACLE.md` §4–§5, and §7 on this player posing through
  `rig-c/core`). One crossing was measured here and needs no standing gate:
  moving the player onto `rig-c/core` changed no frame (#60: 14 builds, 28
  animations, 1,034 frames, 0 mismatches). So when a pose looks wrong, the
  move is a rigc issue with a public repro — the rig spec, the motion spec, the
  frame — answered by that gate, never a Spine runtime added back here.
- **Nothing the package ships names an Esoteric package, and the manifest
  declares none.** `tests/package.spec.ts` builds the library into a throwaway
  install and asserts that no emitted module or `.d.ts` names
  that npm scope (comments stripped) or defines a runtime class, that
  `peerDependencies` is absent, that no dependency field names an Esoteric
  package, and that `bun.lock` resolves none. The first is cheap and stays even
  though nothing could put one there now: it is the claim the package makes.
- Rigid-tier corner order is **BL, UL, UR, BR** — rig-c's `RawDrawn.vertices`
  of a region (`Quad.world` in rigc: bl, ul, ur, br), which its gate holds to
  spine-core's `computeWorldVertices` (whose own br/bl/ul/ur comments are
  stale). `tests/invariants.spec.ts` pins it on the model side: the `turned`
  test rig's two 2 × 1 regions at the identity, read off the pose and off the
  frame, against hand-written corners — to 5e-8, because the runtime spells an
  unrotated bone's `b` as cos 90° at its pi (−2.3e-8, rigc AUTHORING §3.1),
  which rig-c reproduces.
- **Both raster backends address texels as `uv * size`**, the continuous frame
  where the page spans `[0, size]` — `drawImage` under an affine and
  `texture2D()` read the same frame. `uv * (size - 1)` (a discrete
  pixel-index frame) is the bug fixed in #1; it was worth 15–250× in parity
  residue, depending on the scene. No half-texel term: the per-triangle affine
  maps corners, it does not sample.
- **The rigid cut reads the page in that same frame** — the region's bounds
  relative to the declared page size (the document page's `width`/`height`), times the
  image's natural size, rounded per *edge* so neighbouring cuts keep tiling
  exactly. That is what lets a page ship at a resolution its `size:` line does
  not mention (half-res builds, @2x): spine-core normalizes UVs against the
  declared size and a sampler does not care what resolution the texture has, so
  the mesh tier never noticed (rig-c's `meshPageUvs` normalizes the same way),
  and cutting in declared pixels was the rigid
  tier's private bug (#32). A cut bitmap is therefore the **native resolution**
  of its rect, never upscaled, while `RegionImage.width`/`height` are **atlas
  units whatever the bitmap's resolution** — they are the `<img>` layout box
  and the matrix denominator, so `renderRegion` needs to know nothing about the
  page. The page's declared size missing or zero still means "the image is its
  own declared size". `tests/regions.spec.ts` holds it, on artwork painted
  three times at 0.5×/1×/2× rather than resampled.
- **Which way a 90°-packed rect is turned back is derived from the runtime's
  UVs, never from the cut.** `TextureAtlas` takes `u`/`v` from the packed
  rect's top-left corner and, at `degrees === 90`, `u2`/`v2` from `x + height`
  / `y + width`; `RegionAttachment` then names the artwork's corners in the
  rigid tier's own order BL, UL, UR, BR as `(u2, v2), (u, v2), (u, v),
  (u2, v)`. So the artwork's **top-left corner is the packed rect's
  bottom-left**, the packer turned it counter-clockwise, and unpacking is a
  *clockwise* turn (`translate(cw, 0); rotate(+π/2)`). Turning it the other way
  is #49: the bitmap comes out 180° round, `renderRegion` pins its top-left to
  the attachment's UL corner either way, and every rotated rigid part is drawn
  inverted while its outline stays roughly in place — which shipped from the
  first commit to 0.7.0 because nothing was in a position to see it. The
  rotated fixtures either covered their page (pass-through, never cut) or were
  one flat colour, and the harness's own reference for a turned bitmap
  reimplemented the cut's transform: **a reference that shares the convention
  agrees with the code under test whichever way both are wrong**, which is the
  general rule here and not a fact about rotation. So a rotated expectation is
  written from the UVs and nothing else — `tests/regions.spec.ts` asserts a
  cut's pixels against the page texels rig-c's `regionPageUvs` names (held to
  spine-core's `sequence.getUVs` by rigc's gate), on a rotated region that does
  not cover its page, and `tests/invariants.spec.ts` pins those UVs against
  hand-written numbers on the `turned` test rig, a `rigc build --atlas-in` of a
  hand-packed page with one region turned 90° (rigc's own packer never turns
  one). The mesh tier never had the defect: it samples the page through those
  same UVs.
- **Alpha convention is per tier, keyed off the page's `pma`** (#37) — the
  document's `pages[].pma`, which a frame carries on each mesh (`PosedMesh.pma`)
  and `unpackRegions` reads off the page layout. The exporter premultiplies by
  default, so most atlases carry `pma: true` and the
  file's RGB is already multiplied by its alpha. GL then uploads it *without*
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (its blend already wants premultiplied
  source — lossless); the DOM and canvas2d tiers cannot take it at all, since
  an `<img>` and `drawImage` composite straight alpha by definition, so they
  read one weakly-cached un-premultiplied derivation per page image, shared by
  the region cuts and the canvas2d mesh raster (`straightAlphaSource` in
  DomTexture.ts). Deriving per consumer, or per frame, is the thing to not do.
  The whole-page pass-through never fires for a `pma` page — its URL holds
  premultiplied pixels and would go straight into an `<img>`. The caller's
  image is never mutated, and the derivation is weak, so it needs no free.
  The un-premultiply is 8-bit and starts from a canvas read that has already
  quantized the texel, so it carries a residue no rewrite of the arithmetic
  removes — and **how big that residue is belongs to the rasterizer, not to
  this package**: Linux WebKit reads a premultiplied page several times more
  coarsely than macOS does, and it does not even hold the same numbers in two
  kinds of canvas — the same decoded image read through a `willReadFrequently`
  context and through a plain one differed by one level on 561 channels on the
  CI runner, which the un-premultiply's `× 255/a` carries to 8 (identical on
  Chromium). So `tests/pma.spec.ts` asserts nothing absolute about it, and
  whatever it compares with the derived canvas is made on the library's kind of
  canvas (`libraryKindContext` in the harness), never the harness's usual one.
  It measures that platform's own storage in the same run as **controls** — the
  read side (texels drawn in and read back) and the write side (`putImageData`
  of the value class the un-premultiply produces, read back) — and bounds our
  numbers *relative to them*: the derivation may add `read control + 2` (0.5
  for `round(rgb * 255 / a)` arriving back through × a/255, plus 1 for the
  canvas's own premultiply), may drift no more than the write control at that
  alpha (arithmetic term zero), and a cut the same carried through the
  division's `× 255/a`. **Linux WebKit reddened this spec in CI three runs in a
  row with the repair working perfectly**: twice on an absolute ceiling
  calibrated on macOS — a per-texel precision number read off one platform is
  a platform's number, whatever it is derived from, and the first sweep had
  converted the numbers that had already failed rather than every number of
  that kind — and once on the relative bound that replaced them, because its
  control sat on the other kind of canvas. That platform exists on the CI
  runner only, so what settled it was a one-variable dispatch there, not a
  fourth argument. What is asserted exactly, because it holds anywhere: opaque
  texels are untouched (premultiplying by 255/255 is the identity), alpha is
  never divided, alpha 0 keeps no colour, the derived canvas reads back the
  same as a scratch canvas of its own kind given the same values, and the
  direction — a doubled premultiply can only darken, so the tiers count darker
  and lighter pixels separately, assert that the darker side does not outweigh
  the lighter one, and budget each as a ratio of drawn content, the way the
  parity suite budgets a diff.
- **The canvas2d path draws a per-triangle source sub-rect, never the whole
  page.** Linux WebKit garbles whole-page `drawImage` under steep per-triangle
  affines — measured (displaced texture on head/goggles/foot triangles while
  webgl stayed clean; hoverboard bad pixels 1042 → 2 with the source rect as
  the only variable), mechanism not identified. The rect is derived from the
  clip, not fixed: the expanded clip polygon is carried back through the
  inverse of the per-triangle affine, plus one texel of bilinear support,
  snapped outward to texel boundaries. A fixed pad is wrong because the
  expansion's reach in texture space is `triangleExpand` × the local
  texels-per-canvas-unit — up to 4× that at a sharp corner, since the
  expansion moves each *edge* along its normal (#104) — ~0.26 to 8.6 texels
  across the demo's own meshes (measured under the earlier centroid rule).
  The overdraw canary in `tests/parity.spec.ts` is what holds this.
- **Relative imports in `src/` carry `.js`** — `from './DomTexture.js'`, never
  `from './DomTexture'`. TypeScript resolves the `.js` specifier back to the
  `.ts` file under `moduleResolution: "bundler"`, and vite does the same, so
  nothing in development notices either way. The shipped JavaScript is one
  bundle now, so node's resolver never meets these specifiers in `index.js`;
  it still meets them in the **declarations**, which `tsc` emits one per module
  with the specifier unchanged, and a `nodenext` consumer rejects an
  extensionless one with TS2835 (#16 was the same defect in the `.js`). The
  guard is `tests/package.spec.ts`'s nodenext consumer typecheck.
- **The package is one self-contained bundle** (`scripts/build-lib.mjs`):
  vite library mode bundles `src/index.ts` with `rig-c` **not** external — its
  `./core` entry is TypeScript source in a devDependency, which no consumer has
  and no node loads from `node_modules` — and `tsc --emitDeclarationOnly`
  writes the types, with `stripInternal` dropping every `@internal` declaration
  (the adapter's and the loader's helpers, the only ones whose signatures name
  a rig-c type), so the shipped `.d.ts` name nothing a consumer lacks.
  `tests/package.spec.ts` installs the built package with nothing beside it,
  imports and typechecks it by name, and asserts the bundle imports nothing,
  reaches no `node:` module and contains `openTrack`. Measured: `index.js`
  290 KB unminified (the demo's minified chunk for the player and the core,
  139 KB / 46 KB gzip). Anything marked `@internal` must stay out of the public
  types' reach, or the consumer typecheck goes red on `rig-c/core`.
- **One shared WebGL context** at module level — browsers cap WebGL contexts at
  ~16; never create one per renderer/mesh. Because it outlives every renderer,
  its page textures are reference-counted per page (retained as a mesh job is
  queued, released by `dispose()`, deleted at the last release — #15), and the
  cache is keyed weakly by the page image so a forgotten `dispose()` never pins
  the caller's image. A context loss drops both the cache and the count: every
  handle is dead, and the next frames re-upload.
- The mesh dirty-signature cache must stay **Float64** — storing the compared
  f64 values in a Float32Array rounds some of them and leaves those meshes
  permanently re-rastering.
- Mesh canvas backing is **grow-only, quantized, with 25% slack** — writing
  `canvas.width` recreates the GPU surface, and doing that per frame stalled
  real Safari to ~3 fps — except on a `pixelRatio` change, which reallocates
  every canvas anyway and therefore re-sizes from the new need alone, so a
  lowered ratio actually shrinks.
- **`syncPixelRatio()` is caller-invoked only.** It is a forced layout (a hidden
  probe box appended to the root, measured, removed), and the renderer performs
  no layout read per frame — keep it that way. Automatic re-measurement would
  mean one per frame, which is why `pixelRatio: 'auto'` was dropped rather than
  built.
- Element-level features (z-index draw order, SVG-filter tint, mix-blend-mode,
  dirty-skip, backing policy, clipping) are backend-agnostic. Keep them out of
  the raster backends.
- **Clipping is an element-level CSS `clip-path`, written in each element's own
  local frame** — the world polygon through the inverse of the `<img>` matrix
  for rigid slots, minus the canvas translate for mesh slots (`transform-origin`
  is `0 0` on every slot element, which is what lets the matrix be inverted with
  no origin term). **Which slots a clip covers is the frame's**, decided by the
  adapter's `clipCover` on the official draw loops' semantics (above; spine-core
  4.3.13 `dist/SkeletonRendererCore.js`, and `dist/SkeletonRenderer.js` of the
  official WebGL runtime 4.3.13): the renderer applies what each slot
  carries. A clip that covers **every slot of the frame** — one clip object on
  all of them, not inverse — takes the **root fast path**: one `clip-path` on the
  root, whose inline value is borrowed and restored (the root is the caller's
  element) — never both root and per-element for one clip. (Until #60 the test
  was "started before anything was drawn and never ends"; a clip ending at the
  last slot now takes the root path too, which draws the same picture. Specs
  that measure the per-element path under a clip over every drawn element append
  a frame slot past the clip that draws nothing, `UNDRAWN_AFTER_CLIP` in the
  harness.) `clipCount` counts distinct clips applied, `clipSkipCount` distinct
  clips in the frame not applied (`clipping` off, polygon under three points); a
  clip the draw loop ignores never reaches the frame, and the clip probes count
  those off the pose (`clipsIgnored`: clips the pose shows that no frame slot
  carries). Writes are cached per element like `transform`, with
  coordinates quantized to 1/1000 of a local unit, so a static clip over a
  static pose costs zero writes per frame. An **inverse** clip keeps a region
  with a hole in it, which needs two rings — `polygon()` is one closed ring and
  silently turns a box plus a polygon into a self-intersecting one whose
  even-odd fill leaves a wedge along the seam, so inverse clips are a
  two-subpath `path(evenodd, …)` instead. Neither raster backend knows any of
  this exists, and **the mesh dirty signature must never start depending on the
  clip** — a mesh that held still has to keep reusing its raster under a moving
  clip. `tests/clipping.spec.ts` holds it, against a screen-space oracle that
  never touches the local-frame math.
- **A RegionImage map belongs to the caller, not to a renderer.** Its URLs may
  be blobs from `unpackRegions`, an atlas page passed through whole, or the
  caller's own part PNGs — and one map is normally shared by several renderers
  (the demo does it). So only `revokeRegions` frees anything, and only URLs
  this package minted (the `ownedUrls` ledger in DomTexture.ts). Never revoke
  from `dispose()`. The same boundary covers page images — they are the
  caller's (`ModelAssets.pageImages`), so nothing here drops a page to reclaim
  memory (the reason step 2 of #7 was declined); a page goes when the caller
  drops the assets and every player drawing from them.
- **`unpackRegions` starts the region cuts concurrently**, so a failure has to
  account for cuts still in flight: their blobs arrive *after* the error is
  known, and turning those into owned URLs nobody can revoke is a leak with no
  visual signature. The cleanup therefore waits for every started cut before
  revoking and throwing, and the map is built from the page layout once they
  settle — never from the arrivals — so layout order and last-duplicate-wins
  survive out-of-order delivery. How many cuts run at once is a private
  backing-pixel budget in DomTexture.ts (a measurement, not a knob: every
  started cut holds its canvas until its blob lands). `tests/regions.spec.ts`
  holds all of it by wrapping `toBlob` — overlap is a count, arrival order is
  chosen rather than raced, and nothing there is timed.
- **The low-level path stays usable without `loadModel`** (whose refusals
  are the first bullet above) — `unpackRegions` over a page layout and a page-image map, then
  `new DomRenderer(root, regions, pages)` with frames of the caller's — for
  images that do not come from a URL. The `./binary` entry and the Spine
  loaders (`loadAtlasAssets`, `loadSkeletonAssets`, `loadSkeletonJson`,
  `loadSkeletonBinary`) were deleted in #60: nothing is left for them to load.

## Testing

- **The full suite and the bench run in CI, not on a shared desktop.** A headed
  Chromium bench (`scripts/bench.mjs`, 64 meshed rigs) run beside the suite took
  the development Mac to a load average of 287 and WindowServer to 84% (measured
  2026-10-11). Locally: typecheck, the two builds, and single spec files headless
  one at a time; `bun run bench` only on a machine that is otherwise idle.
- `bun run test` — Playwright, chromium + webkit projects; the config builds and
  serves the demo itself (port 4321, and it reuses a server already on that port
  outside CI). So concurrent checkouts — worktrees, a second clone — must each
  export their own `TEST_PORT`, or the second run borrows the first one's server
  and tests the wrong tree without going red. `TEST_PORT` also turns reuse off,
  so a busy port fails loudly, and a malformed value is rejected rather than
  silently defaulted back to 4321.
- Parity strategy: **A/B within one run, no golden snapshot files** (goldens
  rot across platforms) — canvas2d against webgl for the DOM tier's two mesh
  backends, and the DOM tier against the canvas mode. Seam cracks get the
  deterministic `?expand=0` canary rather than a screenshot threshold — they
  score below any limit the statistical diff can carry — and the canvas2d
  source sub-rect its overdraw canary (expand 32 against 8 on the glow rig's
  `canary` ring: 7,723 against a fixed-pad mutant's 638, limit 2,500, macOS
  chromium; 4,795 and 1,350 before #104 moved edges instead of corners).
- **The picture gate is the two render modes drawing the same picture**
  (`tests/parity.spec.ts`, *dom / canvas parity*): every scene captured in the
  DOM mode (its default webgl mesh backend; canvas2d until #109, which the
  canvas2d / webgl cells still hold to it) and in the canvas mode, diffed
  shift-tolerantly at a channel tolerance of 24, bounded as ratios of drawn
  content. Bad pixels ≤ 1.5% on the test-rig scenes (macOS chromium floors:
  glow 0.007%, figure mask 0.524%, figure walk + tint 0.204%; canvas-mode
  mutants: tint dropped 77.0% / 8.4%, additive drawn as Normal 4.2%, clipping
  never applied 16.0%, first mesh not drawn 7.3–12.4%) and ≤ 2.5% on the
  gallery scenes (floors 0.585–0.952% chromium, up to 1.553% webkit); content
  mismatch ≤ 3% everywhere (floors ≤ 1.03%). What is forgiven is antialiasing
  and texture filtering on silhouettes; a missing part, a dropped tint, a blend
  or a clip not applied is not. WebKit's test-rig floors and every Linux floor
  are read in CI only. It is the repository's own gate and the only picture
  comparison it keeps: nothing here is compared with a Spine runtime (see the
  poser bullet above). What it cannot see is a defect both modes share — the
  shape #37 had — and for that class the premultiplied-page specs
  (`tests/pma.spec.ts`) are the instrument: an A/B of one artwork in two alpha
  encodings.
- Rendering is tested through the demo (`?rig=` names a gallery build or a
  test rig); the **loading path and the renderer probes go through
  `tests/harness.html`** (a build entry that exposes the library on
  `window.rigPlayHarness`; its loader probes run on the packed gallery build,
  whose regions are cut and mint blobs — a one-part-per-page build mints none).
  The probes draw frames the package's own adapter reads off a rigc build
  (`tests/rigFrames.ts`: `loadModel`, `rig-c/core`'s live track, `frameOf`), and
  may choose which slots of a frame to draw — never construct a pose.
  Blob-URL ownership has no visual signature, so its oracle is the browser: a
  revoked object URL stops resolving. Keep test hooks in the harness, out of
  the demo.
- What npm ships is tested by **`tests/package.spec.ts`, node-side, no
  browser**: it runs `scripts/build-lib.mjs` into a temp directory, assembles a
  throwaway `node_modules/@rig-c/play` there (real manifest, nothing else
  installed) and imports and typechecks the package *by package name* through
  node's own resolver — the only way to exercise the `exports` map, which a
  relative import of `dist/` would bypass entirely. It must **never** build into
  the repository's own `dist/`: during a run `vite preview` is serving the demo
  out of `dist/` and `build:lib` opens with `rm -rf dist`, so a lib build there
  would pull the ground out from under every other spec in the same run. It
  also pins the exact set of files that build emits (`index.js` + map, and a
  `.d.ts` + map per module), because an unreachable file has no other
  signature: `dist/main.*` shipped in 0.4.1 and 0.5.0 without any resolver,
  import walk or consumer ever noticing (#24).
- **The package has three registry names and one set of files** (#65, #98). It is
  published as `@rig-c/play`, the `name` in `package.json`, and every version is
  published again as `rig-play` and as `spine-html`, the names it shipped under
  before, so the links that point at those names keep resolving. An alias is never built or versioned
  on its own: `scripts/alias-tarball.mjs` packs the checkout the gated publish
  read, rewrites the one `"name"` line of the packed manifest, packs that again,
  and refuses to print a path unless the two tarballs hold the same paths and
  the same bytes but for that line. `tests/package.spec.ts` runs it over the
  temp build once for each alias (the script takes `--alias <name>`; the names
  are the spec's `ALIASES`) and diffs the two manifests itself, and holds the comparison to a
  planted difference, which it must name. Outside the changelog, the aliases are
  named by that script, `release.yml` (their publish and the confirmation),
  `tests/package.spec.ts`, NOTICE.md, the README and RELEASING.md.
- Keep `@playwright/test` pinned to a version whose browser revisions match the
  machine's `~/Library/Caches/ms-playwright` before bumping it.
- **CI runs the suite once**, one job named `test` (`.github/workflows/ci.yml`):
  there is no spine-core matrix, because there is no spine-core.
- **The fixtures are built, not fetched as binaries**: `scripts/fetch-assets.sh`
  builds rigc's gallery rigs from a pinned rigc tag, and this repository's test
  rigs from `tests/rigs/`, with the rig-c devDependency of the same version,
  into `public/rigs/<name>/` (and `<name>-packed/`, `--pack`), each with
  `skeleton.model.json` and its pages (and the Spine pair `rigc build` writes
  beside it, which nothing reads), stamped so a version change — or, for a test
  rig, a change to its sources — rebuilds it. The build needs bun (rig-c's CLI
  hands off to it) and network for the tag; without spine-core installed the
  CLI runs its runtime-free entry, whose gate is rigc's own validator.
- **The test rigs** (`tests/rigs/<name>/`: rig.json, motion.json and parts
  painted by `tests/rigs/make_parts.ts`, all committed) carry what no gallery
  rig does. `figure` — rigid parts on turned bones, two grid meshes, clipping
  attachments in rigc's format (a convex part mask in `mask`, a whole-skeleton
  window, a tilted quad and its moved twin, a covering control, an inverse clip,
  a nested second clip), odd part sizes and, in `detail` only, one-texel line
  art: the clipping specs, the cut-rule stage, the half-resolution page, the
  premultiplied twin (`--pack`, one shared page), the backing, scaled-stage and
  GL-texture probes, and the mask and tint parity scenes. `glow` — additive
  slots with slot colours over two weighted flame meshes, and in `canary` a
  slit-ring mesh whose hull sits inside opaque art: the additive parity scene,
  the frozen/running mesh invariants, and the seam and overdraw canaries.
  `turned` — two 2 × 1 regions on a hand-packed page, one turned 90°, built
  `--atlas-in`: the corner-order and region-UV invariants. `duo` — one opaque grey ramp
  on a region and on a mesh, each slot with a setup `dark` and an `rgb2` key
  that changes only the dark half: `tests/dark-tint.spec.ts`, which holds the
  canvas mode's GL path to `c·light + (1 − c)·dark` and the DOM mode and the
  canvas2d fallback to drawing no dark tint (#106). A premultiplied page
  reaches a rigc build only through `--atlas-in` (its packer writes
  `pma: false`), so `tests/pma.spec.ts` makes its premultiplied twin of the
  figure's page in the harness, as it always has. If a spec needs something
  rigc's format cannot express, that is a rigc issue — not a fixture made
  outside rigc.

## Workflow

- Conventional Commits, English subject and body. Commit each finished unit
  immediately. The subjects are load-bearing now: release-please reads them to
  pick the next version and to write CHANGELOG.md.
- Pushing to origin is fine (owner-confirmed), and **so is merging** (owner
  decision, 2026-09-18; until v0.4.1 the release was the owner's click, and
  v0.5.0 was the first cut made under this rule): a feature pull request once
  its checks are green, and the `release: vX.Y.Z` pull request `release.yml`
  keeps open after every push to `main`. Merging that one is the cut, and the
  call belongs to the session that landed the work. Make it from the tree, not
  from the generated diff: what `npm pack --dry-run` ships, whether the headline
  change is reachable by a consumer, whether the release reversed itself — get a
  green on the release commit first (RELEASING.md says how), and say in the
  release notes what was not measured. Read the checks, then merge as a separate
  command; never chain the two. After the cut, verify the published artifact,
  not the workflow's word: the registry version, the provenance attestation, and
  an import of the package by each of its two names from a clean directory. What
  stays the owner's: issues filed by outside contributors, and anything that
  leaves the repository (posts, contacts, spending). Never run `npm version` or
  `npm publish` by hand — the publish happens in CI over OIDC.

## Known backlog

- Linux WebKit is no longer a parity outlier — it was canvas2d drawing the
  whole atlas page per triangle, and the source sub-rect above retired both the
  residue and that platform's 26×-looser badRatio limit. What stays open is
  **why**: the mechanism inside that rasterizer is not identified, and it
  reproduces on the CI runner only. `PARITY_DUMP=1` is the instrument if it
  resurfaces.
