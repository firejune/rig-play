# CLAUDE.md

Guidance for AI-assisted sessions working on this repository.

## What this is

spine-html renders rigs built by rigc as plain DOM — rigid slots as `<img>` posed
by CSS `matrix()`, mesh slots on small per-part canvases (canvas2d or WebGL-blit
backend), interleaved in one stacking context. It loads the compiled model
document `rigc build` writes (`skeleton.model.json`, `rigc-compiled/3`), poses it
through `rig-c/core`, and draws each pose as a `PosedFrame`. Production since
v0.3.0; the model path since #60. Read README.md for architecture and measured
numbers.

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
  under `src/` imports `@esotericsoftware/*` (`grep -rn "@esotericsoftware"
  src/` is empty, and `tests/package.spec.ts` holds the shipped bytes to it).
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
- **The frame gate holds the adapter to spine-core at tolerance 0**
  (`tests/frames.spec.ts`, node-side): each gallery build's Spine pair posed by
  spine-core 4.3 on rigc's render recipe and read by `tests/skeletonFrame.ts`,
  its model pair posed by `openTrack` and read by `frameOf`, compared field by
  field with `===` — draw order, z, every region's name, corners and page UVs,
  every mesh's page, `pma`, sequence, vertices, UVs and triangles, tint, dark,
  blend, clip polygon and clip grouping — every animation, `dt = 1/12`, through
  the loop's wrap, on one-page-per-part and `--pack` builds. Measured: 14
  builds, 28 animations, 1,034 frames, 19,504 slots, 1,279,976 numbers, 0
  mismatches. It is the instrument that sees a one-ulp defect: reading a
  mesh's art UVs through `Math.fround` first left every one-page-per-part build
  green and failed every packed one (a one-part page maps UVs by the identity),
  which is why both layouts are built. No gallery build clips, so the clip half
  is held by the gate's hand-made cover cases and by the renderer's clipping
  specs over spineboy — say so whenever a clip claim is made from the gate.
- **The test suite reads Spine exports through its own bridge,
  `tests/skeletonFrame.ts` (and `tests/spineDom.ts` for drawing).** The
  renderer specs, the spineboy stage (`tests/spine-stage.html`), the pixel
  oracle's spineboy cells and the benchmark pose spine-core skeletons and read
  them into the same `PosedFrame` the package's adapter writes — the official
  draw loop, read rather than drawn. That is where clipping, additive blend and
  premultiplied pages are exercised, because no rigc gallery build carries them.
  spine-core 4.3 only: the generation seam the package carried until #60
  (`coreCompat.ts`, four CI columns) went with the package's own spine-core
  reads.
- **An export under any runtime but its own generation's is never a supported
  combination, and a clean parse is not evidence that it is.** This is the
  reference side's concern now, and the reason it runs 4.3 over 4.3 exports
  only. Each generation's `SkeletonJson` simply stops looking for keys the
  format dropped: 4.2 reads a bone's `inherit` and never `transform` (what 4.0
  and 4.1 write), 4.1 and 4.2 read an animation's `attachments` and never
  `deform` (what 4.0 writes), 4.3 reads `constraints` and never
  `ik`/`transform`/`path`/`physics`, and a 3.8 export parses under 4.0 and then
  poses its bones at non-finite transforms. None of it throws. The check that
  settles it is a **diff of the keys each generation's reader consumes**
  against the keys the exports contain — not parsing, not counting, not
  rendering without an error.
- Rigid-tier corner order is **BL, UL, UR, BR** — spine-core's
  `computeWorldVertices` order (verified by execution on 4.0.31, 4.1.56, 4.2.98,
  4.2.120 and 4.3.13; the br/bl/ul/ur comments inside the upstream function are
  stale), which rig-c's pose keeps and the frame gate holds it to at tolerance
  0. `tests/invariants.spec.ts` pins spine-core's end of that chain
  (construction in `tests/harness.ts`).
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
- **Which way a 90°-packed rect is turned back is derived from spine-core's
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
  cut's pixels against the page texels those UVs name, on a rotated region that
  does not cover its page, and `tests/invariants.spec.ts` pins the UV
  convention itself against spine-core. rig-c's `regionPageUvs` states the same
  rule (held to `sequence.getUVs` there, and to spine-core here by the frame
  gate's region-UV comparison). The mesh tier never had the defect: it samples
  the page through those same UVs.
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
  texels-per-canvas-unit, ~0.26 to 8.6 texels across the demo's own meshes.
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
  4.3.13 `dist/SkeletonRendererCore.js`, and `dist/SkeletonRenderer.js` of
  `@esotericsoftware/spine-webgl` 4.3.13): the renderer applies what each slot
  carries. A clip that covers **every slot of the frame** — one clip object on
  all of them, not inverse — takes the **root fast path**: one `clip-path` on the
  root, whose inline value is borrowed and restored (the root is the caller's
  element) — never both root and per-element for one clip. (Until #60 the test
  was "started before anything was drawn and never ends"; a clip ending at the
  last slot now takes the root path too, which draws the same picture. Specs
  that measure the per-element path under a clip over every drawn element append
  a frame slot past the clip that draws nothing, `SkeletonRenderer.trailing`.)
  `clipCount` counts distinct clips applied, `clipSkipCount` distinct clips in
  the frame not applied (`clipping` off, polygon under three points); a clip the
  runtime ignores never reaches the frame, and the spineboy reader counts those
  itself (`clipsIgnored`). Writes are cached per element like `transform`, with
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
- **`loadModel` reads `rigc-compiled/*` and nothing else.** A Spine export
  (`.json` not ending `.model.json`, `.skel`) is refused by name before anything
  is fetched; a document whose `spec` `readModel` refuses is refused with
  `readModel`'s sentence plus "build it with `rigc build`", and so is a
  `rigc-compiled/1` document (no `pages`). The low-level path stays usable on
  its own — `unpackRegions` over a page layout and a page-image map, then
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
- Parity strategy: **A/B canvas2d-vs-webgl within one run, no golden snapshot
  files** (goldens rot across platforms). Seam cracks get the deterministic
  `?expand=0` canary rather than a screenshot threshold — they score below any
  limit the statistical diff can carry.
- **The one comparison that is not against ourselves is `tests/oracle.spec.ts`,
  against `@esotericsoftware/spine-webgl`.** Every other visual test A/Bs this
  package's own two backends, which catches one drifting from the other and
  cannot, by construction, catch a defect they *share* — #37 was that shape
  (`pma: true` pages one multiply too dark in every tier, green suite for
  months, found by a consumer). So the official runtime draws the same export
  in the same pose at the same size, and the two pictures are diffed: rigid
  tier, mesh tier on both backends, the exporter's own premultiplied page on
  all three, clipping, additive blend, per-slot rgba, whole-skeleton tint. The
  camera match is **derived, not fitted** (the ortho mapping is solved against
  the DOM stage's in `tests/oracleStage.ts`) and then **proved by driving it**:
  the alignment canary offsets one side by a single world unit and requires the
  diff to see it — on `rawBad`, never the shift-tolerant count, which forgives
  a one-pixel shift by design. What is forgiven is antialiasing and texture
  filtering and nothing else, so the stage sits at scale 0.5, where one atlas
  texel is one CSS pixel for this export and neither runtime resamples. Limits
  are **ratios of drawn content at the parity suite's channel tolerance, plus a
  darker-minus-lighter excess on the premultiplied cells** — never an absolute
  per-pixel precision number, for the reason the `pma` bullet above gives at
  length. They carry 2.0–2.4× over the measured floor, which is thinner than
  the parity suite's 10× because the defects are only ~2.3× above them; that
  gap is what there is, and Linux is unmeasured. `ORACLE_DUMP=1` is the
  instrument, exactly as `PARITY_DUMP=1` is for parity.
- **The Spine runtimes are devDependencies and must stay unreachable from
  `src/`.** spine-core and spine-webgl serve the reference side only (the
  oracle, the frame gate, the spineboy specs, the benchmark);
  `tests/package.spec.ts` asserts nothing shipped names `@esotericsoftware/`.
  For spine-webgl in particular: the
  reference code is `tests/oracleStage.ts` — the only file that names it — and
  the dependency runs one way: the harness imports from `src/`, never the
  reverse. One import written backwards would put a second full runtime into
  `dist/` with no other signature, since `tsconfig.build.json` compiles all of
  `src/` and the emitted file *set* would not change. `tests/package.spec.ts`
  asserts the shipped bytes never name it, and that it is in neither
  `dependencies` nor `peerDependencies`. A column of the CI matrix installs the
  **matching generation** of it alongside its core, in one `bun add --no-save`
  so the pinned pair cannot resolve apart and strand a nested second spine-core
  under spine-webgl (one column, 4.3, since #60). The reference's own seam is
  four lines, read off the live object: 4.3 takes the alpha convention on
  `GLTexture` and everything before it on `drawSkeleton`. That branch covers
  4.0 and 4.1 unchanged — `SceneRenderer`, `ManagedWebGLRenderingContext`,
  `GLTexture`, `camera`, `batcher.getDrawCalls()` and
  `skeletonRenderer.premultipliedAlpha` are the same there as on 4.2 (checked
  against 4.0.31 and 4.1.56), so the new columns needed nothing added to it.
- Rendering is tested through the demo (gallery builds, the model path) and
  `tests/spine-stage.html` (spineboy, the same frame loop over spine-core
  skeletons); the **loading path is tested through `tests/harness.html`** (a
  build entry that exposes the library on `window.rigPlayHarness`; its loader
  probes run on the packed gallery build, whose regions are cut and mint blobs —
  a one-part-per-page build mints none). Blob-URL ownership has no visual
  signature, so its oracle is the browser: a revoked object URL stops
  resolving. Keep test hooks in the harness, out of the demo.
- What npm ships is tested by **`tests/package.spec.ts`, node-side, no
  browser**: it runs `scripts/build-lib.mjs` into a temp directory, assembles a
  throwaway `node_modules/spine-html` there (real manifest, nothing else
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
- Keep `@playwright/test` pinned to a version whose browser revisions match the
  machine's `~/Library/Caches/ms-playwright` before bumping it.
- **CI runs the suite once, against spine-core 4.3** (`.github/workflows/ci.yml`
  keeps its matrix shape with one column until #63 removes it and the peer
  dependency). The four columns (4.3, 4.2, 4.1, 4.0) measured the generation
  seam #60 deleted; the reference side reads 4.3 exports — the gallery builds
  are Spine 4.3 data — so it runs the 4.3 runtime only. `SPINE_ASSETS_BRANCH`
  still belongs on the test run itself, not only on a `fetch-assets` before it:
  the run's own build hook fetches again.
- **The fixtures are built, not committed**: `scripts/fetch-assets.sh` fetches
  spineboy (the reference side) and builds rigc's gallery rigs from a pinned
  rigc tag with the rig-c devDependency of the same version into
  `public/rigs/<name>/` and `public/rigs/<name>-packed/` (`--pack`), each with
  `skeleton.model.json`, `skeleton.json`, `skeleton.atlas` and its pages side by
  side, stamped like spineboy so a version change rebuilds from clean. The
  build needs bun (rig-c's CLI hands off to it) and network for the tag.

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
  an import of both entry points by package name from a clean directory. What
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
