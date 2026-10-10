import { type PageSource, type RegionImage, straightAlphaSource } from './DomTexture.js';
import { getMeshGlBlitter, type MeshBlitJob } from './MeshGlBlitter.js';
import type { BlendMode, PosedClip, PosedFrame, PosedMesh, PosedRegion, PosedSlot } from './posedFrame.js';

/** Rasterizer used for the mesh (deform) tier. */
export type MeshBackend = 'canvas2d' | 'webgl';

const regionVertices = new Float32Array(8);
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Unique tint-filter ids across renderer instances (ids are document-global). */
let tintFilterSeq = 0;
/** Edge length of the throwaway box syncPixelRatio() measures the root with. */
const SCALE_PROBE_PX = 100;
/**
 * Relative change below which syncPixelRatio() leaves `pixelRatio` alone.
 * Layout reads are quantized (1/64 px in Blink), so a 100 px probe carries
 * ~0.016% of measurement noise — 6× under this band, which in turn is 10×
 * under the smallest zoom step a UI realistically takes (1%). Inside the band
 * the sampling error is worth ~0.2% of backing pixels; outside it, a rewrite
 * of `pixelRatio` recreates every mesh canvas's GPU surface.
 */
const PIXEL_RATIO_DEADBAND = 1e-3;

/** Push a point away from (cx, cy) by `amount` pixels. */
function expandPoint(x: number, y: number, cx: number, cy: number, amount: number): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return [x, y];
  const s = amount / len;
  return [x + dx * s, y + dy * s];
}

/**
 * Formats one clip-path coordinate, rounded to 1/1000 of the element's local
 * unit so that a pose which recomputes to a bit-different float does not
 * defeat the write cache.
 *
 * Why 1/1000: the local unit is an atlas unit for a rigid `<img>` (the matrix
 * denominator) and a CSS pixel for a mesh canvas, so the worst error this can
 * add on screen is half a quantum times the element's local-to-screen scale.
 * At a 50× upscale — far past anything a skeleton is posed at — that is
 * 0.025 px, an order of magnitude under one device pixel at dpr 3, while
 * still sitting three orders of magnitude above the f32 recomputation jitter
 * of coordinates that run 10²–10³ units. Shortest-round-trip number
 * formatting then keeps every coordinate at three decimals or fewer.
 */
function clipCoord(v: number): string {
  return `${clipNum(v)}px`;
}

/**
 * The same quantized number without a unit, for `path()` data — SVG path
 * coordinates are user units and a `px` suffix there is a parse error.
 */
function clipNum(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Bound past which a local coordinate is treated as degenerate rather than
 * written. Two reasons, and the second is the hard one: a near-singular
 * element matrix sends the inverse — and with it these coordinates — toward
 * infinity, and JavaScript switches to exponential notation at 1e21, which is
 * not valid CSS. The browser would then drop the whole declaration and the
 * element would render UNCLIPPED, which is the one failure mode a clip must
 * never have. A billion local units is already far outside anything a
 * skeleton poses, so nothing expressible is lost by stopping here.
 */
const CLIP_COORD_LIMIT = 1e9;

type SlotKind = 'image' | 'canvas';

interface SlotView {
  kind: SlotKind;
  el: HTMLImageElement | HTMLCanvasElement;
  /** Region name currently shown (image kind), to skip src rewrites. */
  regionName: string;
  visible: boolean;
  zIndex: number;
  opacity: number;
  blendMode: BlendMode;
  /** Last transform string written, to skip no-op style writes. */
  transform: string;
  /** Last clip-path string written ('' = none), to skip no-op style writes. */
  clipPath: string;
  /** Current RGB tint; (1,1,1) means untinted (no filter applied). */
  tintR: number;
  tintG: number;
  tintB: number;
  /** Lazily created SVG reference filter for non-white tints. */
  tintId: string;
  tintMatrix: SVGFEColorMatrixElement | null;
  /** Canvas kind: allocated backing-store size (grow-only, quantized). */
  canvasW: number;
  canvasH: number;
  /** Canvas kind: pixelRatio the backing/CSS sizing was computed with. */
  meshRatio: number;
  /**
   * Canvas kind: shape signature of the last raster, for dirty-skipping. The
   * UV and triangle arrays are compared by identity: the frame hands the same
   * objects for the same region and attachment (see PosedMesh), so a new array
   * is a new texture mapping and an old one is not.
   */
  meshUvs: ArrayLike<number> | null;
  meshTriangles: ArrayLike<number> | null;
  meshPage: HTMLImageElement | null;
  meshSequenceIndex: number;
  meshExpand: number;
  meshVertexCount: number;
  /** Backend that produced the last raster — a backend switch re-dirties. */
  meshBackendDrawn: MeshBackend | '';
  /**
   * Canvas-space (bbox-relative) vertices of the last raster. Float64: the
   * compared values are f64 (f32 world vertex minus integer bbox origin);
   * storing them as f32 would round some of them and leave those meshes
   * permanently "dirty".
   */
  meshVertices: Float64Array;
  /** The render() call that last drew this view — a view not drawn by the current one is hidden. */
  drawnIn: number;
}

const BLEND_CSS: Record<BlendMode, string> = {
  Normal: '',
  Additive: 'plus-lighter',
  Multiply: 'multiply',
  Screen: 'screen',
};

/**
 * Renders a posed frame (`PosedFrame`) as DOM, split by slot kind:
 *
 * - Region slots (rigid parts) become one absolutely-positioned <img>
 *   posed with a single CSS matrix() write per frame — exact, since bone
 *   transforms are affine.
 * - Mesh slots (deform parts) each get a small per-part <canvas> sized
 *   to the mesh's world bounding box, redrawn per frame — either with the
 *   standard per-triangle clip+transform+drawImage mapping (default), or via
 *   a shared offscreen WebGL canvas that rect-blits into the same per-part
 *   canvases (meshBackend = 'webgl'). Frames where the canvas-space vertices
 *   are unchanged reuse the previous raster on both backends.
 *
 * Both element kinds share one stacking context, so draw order interleaves
 * freely via z-index (rear hair canvas < torso img < front hair canvas).
 * The RGB tint the frame carries (slot × attachment × the player's colour) is
 * applied per element with an SVG feColorMatrix reference filter — exact
 * channel multiply, works the same on <img> and <canvas>. Dark (two-color)
 * tint is not expressible that way and is unsupported. A clip the frame
 * carries becomes a CSS clip-path per element, in that element's own local
 * frame (see `clipping`) — which slots a clip covers is decided by the poser's
 * adapter (`frameOf`), not here.
 *
 * Coordinate mapping: the frame is world space, Y-up; CSS is Y-down — world Y
 * is negated. The poser computes everything (bones, constraints, physics,
 * deformed vertices) on the CPU; this class only draws.
 */
export class DomRenderer {
  /**
   * Apply the clips the frame carries (default). Each element drawn inside a
   * clip gets a CSS `clip-path` in its own local frame — an element-level
   * feature, so both mesh backends see exactly the same thing and neither
   * raster path knows clipping exists.
   *
   * Which slots a clip covers is the frame's, decided by the adapter on the
   * runtime's semantics (`clipCover` in posedFrame.ts: one clip in force at a
   * time, a second one met while one is in force ignored, a clip covering the
   * slots after its own through its end slot inclusive, an end slot that is
   * the clip's own slot — or one already passed — never ending it). A clip
   * that covers every slot of the frame is the whole-skeleton clip, and it
   * takes a fast path: one `clip-path` on the root instead of one per element.
   * The root is the caller's element, so its inline `clip-path` is borrowed —
   * saved on the first write and restored when the clip stops covering the
   * frame, when `clipping` goes false, and by `dispose()`.
   *
   * False restores the pre-0.6 behaviour: clips are counted in clipSkipCount
   * and nothing is clipped, with any clip-path this renderer wrote removed.
   */
  clipping = true;
  /** Clips applied last frame — distinct clip polygons over the drawn slots. */
  clipCount = 0;
  /**
   * Clips in the frame NOT applied last frame: `clipping` is false, or the
   * polygon has fewer than three points. A clip the runtime itself ignores (a
   * second one met while one is in force, one on an inactive bone) never
   * reaches the frame, so it is not counted here.
   */
  clipSkipCount = 0;
  /**
   * `clip-path` style writes performed last frame, across slot elements and
   * the root, clears included. A static polygon over static elements settles
   * at zero: every clip-path is cached per element exactly as `transform` is.
   */
  clipWriteCount = 0;
  /** Mesh canvases rasterized last frame. */
  meshCount = 0;
  /** Mesh canvases that reused their previous raster last frame. */
  meshReuseCount = 0;
  /**
   * Mesh canvas backing stores (re)allocated last frame. Should drop to zero
   * once an animation reaches its steady state; a persistent nonzero value
   * means GPU surfaces are being recreated per frame (a Safari killer).
   */
  canvasReallocCount = 0;
  /** Triangles rasterized last frame. */
  triangleCount = 0;
  /**
   * How far (px) each triangle's clip polygon is expanded from its centroid.
   * Closes antialiased-clip cracks between adjacent triangles (Safari);
   * set to 0 to see them.
   */
  triangleExpand = 0.5;
  /**
   * Mesh-canvas backing-store pixels per CSS pixel. Defaults to the device
   * pixel ratio. If the caller scales the root element, fold that scale in
   * (e.g. devicePixelRatio * rootScale) so the raster matches the on-screen
   * resolution instead of over- or under-sampling — syncPixelRatio() measures
   * that scale and folds it in for you.
   */
  pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  /**
   * Rasterizer for the mesh (deform) tier. 'canvas2d' (default) maps each
   * triangle with clip+transform+drawImage directly on the per-part canvas.
   * 'webgl' rasterizes every dirty mesh into one shared offscreen WebGL
   * canvas and rect-blits each mesh back onto its per-part canvas — the DOM
   * structure and all element-level behavior (z-index interleave, tint
   * filter, mix-blend-mode, dirty-skip) are identical, only the raster step
   * changes. Motivation: Safari antialiases canvas2d clip paths, so the
   * per-triangle clip mapping pays a per-triangle AA-mask cost in the GPU
   * process that rAF-limits heavy scenes; GL rasterizes shared edges
   * seamlessly (no clip, no crack overdraw) and the blit is an unclipped
   * rect copy. Falls back to 'canvas2d' when WebGL is unavailable or the
   * shared context is lost — see meshBackendActive.
   */
  meshBackend: MeshBackend = 'canvas2d';
  /** Backend that actually rasterized the mesh tier during the last render(). */
  meshBackendActive: MeshBackend = 'canvas2d';

  private readonly views = new Map<string, SlotView>();
  /** Counts render() calls: the stamp a view drawn this frame carries (`SlotView.drawnIn`). */
  private frameNumber = 0;
  private readonly pendingJobs: MeshBlitJob[] = [];
  private readonly pendingViews: SlotView[] = [];
  /**
   * Atlas page images this renderer has retained from the shared blitter,
   * one retain each. Allocated on the first webgl mesh job, so a renderer
   * that never leaves canvas2d holds nothing and gives nothing back.
   */
  private glPages: Set<HTMLImageElement> | null = null;
  /**
   * World vertices copied out of the frame. Float32, as the rigid and mesh
   * paths have always read them: the raster, the dirty signature and the
   * clip-path quantization below are calibrated on single-precision
   * coordinates, and the frame's doubles are rounded here once rather than
   * changing what those paths see.
   */
  private scratchVertices = new Float32Array(256);
  private tintDefs: SVGSVGElement | null = null;
  /** The clip whose polygon is loaded in `clipPolygon`, if any. */
  private clipActive: PosedClip | null = null;
  /** The clips counted so far this frame, applied or skipped — one count each. */
  private readonly clipsSeen = new Set<PosedClip>();
  private clipInverse = false;
  /** True while the active clip is served by one clip-path on the root. */
  private clipOnRoot = false;
  /** The active clip polygon in CSS space (Y already negated), flat x,y. */
  private clipPolygon = new Float64Array(0);
  private clipPolygonLength = 0;
  /**
   * The root's inline `clip-path` before this renderer borrowed it; null means
   * not borrowed. The root belongs to the caller, so the fast path gives back
   * exactly the string it found.
   */
  private rootClipSaved: string | null = null;
  /** Last clip-path string written to the root, to skip no-op style writes. */
  private rootClipWritten = '';

  /**
   * @param root Positioned element (e.g. position:absolute) that becomes the
   *   skeleton origin. The renderer only appends slot elements to it — layout
   *   and scaling of the root belong to the caller.
   * @param regionImages Unpacked per-region bitmaps (for the rigid tier),
   *   keyed by region name — `PosedRegion.region`.
   * @param pages Page images (for the mesh tier), keyed by page name —
   *   `PosedMesh.page`. Read on every mesh draw, so a caller may fill it after
   *   construction.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly regionImages: ReadonlyMap<string, RegionImage>,
    private readonly pages: ReadonlyMap<string, HTMLImageElement> = new Map(),
  ) {}

  /**
   * Backing-store pixels currently allocated across the mesh canvases
   * (Σ width × height). Computed on demand from the views — nothing is
   * tracked per frame — so reading it is cheap but not free; the demo reads it
   * with the other counters, twice a second.
   *
   * This is the quantity `pixelRatio` moves quadratically, and the one that
   * makes an oversampling stage visible before the frame rate does: a root
   * scaled down by CSS without that scale folded into `pixelRatio` holds
   * 1/scale² of the backing it needs. Hidden slots are included — their
   * canvases keep their allocation.
   */
  get meshBackingPixels(): number {
    let total = 0;
    for (const view of this.views.values()) {
      if (view.kind === 'canvas') total += view.canvasW * view.canvasH;
    }
    return total;
  }

  /**
   * Re-derives `pixelRatio` from the root's effective on-screen scale, so the
   * mesh tier rasters at the resolution the screen actually shows.
   *
   * Mesh canvases are sized in the root's own coordinates, and a CSS transform
   * anywhere above the root — the natural way to build a pan/zoom stage is
   * `transform: scale(zoom)` on an ancestor — rescales them on screen without
   * the renderer seeing it. At zoom z the raster is then oversampled by 1/z per
   * axis, 1/z² in backing pixels: GPU memory and fill rate, not correctness.
   * This folds the measured scale in, `devicePixelRatio × scale`.
   *
   * One layout read per call. The root itself is usually 0×0 (slot elements are
   * absolutely positioned and posed by transforms), so there is no box to
   * measure: a hidden 100×100 px child is appended, measured once with
   * getBoundingClientRect(), and removed again — nothing of it is left behind.
   * It cannot disturb the slot elements either: they interleave by z-index,
   * which applyCommon() writes explicitly on every visible one, so DOM order is
   * not what orders them; and the probe is `visibility: hidden` and gone before
   * anything can paint.
   *
   * The scale is the larger axis of the measured box. An ancestor rotation
   * inflates that axis-aligned box, so the ratio errs high — the safe side:
   * oversampling costs pixels, undersampling costs picture.
   *
   * A move smaller than 0.1% (see PIXEL_RATIO_DEADBAND) changes nothing, and a
   * root that is not laid out (a `display: none` ancestor — the probe measures
   * 0) changes nothing either. Both matter because writing `pixelRatio`
   * reallocates every mesh canvas on the next frame.
   *
   * The renderer never calls this itself. It is a forced synchronous layout,
   * which has no business in a render path — and there is no per-frame layout
   * read anywhere in this class. Call it when a zoom or a layout settles: after
   * a wheel/pinch gesture ends, on a debounced resize, not during the drag.
   *
   * @returns the pixel ratio now in effect (the current one if nothing moved).
   */
  syncPixelRatio(): number {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.left = '0';
    probe.style.top = '0';
    probe.style.width = `${SCALE_PROBE_PX}px`;
    probe.style.height = `${SCALE_PROBE_PX}px`;
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    this.root.appendChild(probe);
    let width = 0;
    let height = 0;
    try {
      const rect = probe.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    } finally {
      probe.remove();
    }

    const scale = Math.max(width, height) / SCALE_PROBE_PX;
    // Not laid out (display:none ancestor, detached root): no measurement, so
    // no decision — keep whatever the caller has.
    if (!(scale > 0)) return this.pixelRatio;

    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const next = dpr * scale;
    const current = this.pixelRatio;
    if (current > 0 && Math.abs(next - current) < current * PIXEL_RATIO_DEADBAND) return current;
    this.pixelRatio = next;
    return next;
  }

  /**
   * Draws one frame. Slots the frame does not carry — no attachment, a
   * clipping attachment, an inactive bone, a kind the DOM tier does not draw —
   * are hidden, their elements kept for when they draw again.
   */
  render(frame: PosedFrame): void {
    this.clipCount = 0;
    this.clipSkipCount = 0;
    this.clipWriteCount = 0;
    this.meshCount = 0;
    this.meshReuseCount = 0;
    this.canvasReallocCount = 0;
    this.triangleCount = 0;
    this.clipActive = null;
    this.clipInverse = false;
    this.clipOnRoot = false;
    this.clipsSeen.clear();
    const stamp = ++this.frameNumber;
    const blitter = this.meshBackend === 'webgl' ? getMeshGlBlitter() : null;
    this.meshBackendActive = blitter ? 'webgl' : 'canvas2d';
    const order = frame.order;

    // Whole-skeleton fast path: one clip covers every slot of the frame, so
    // every element is inside it — one clip-path on the root beats one per
    // element. The frame shares one clip object across the slots it covers,
    // so "every slot" is an identity test. An inverse clip is excluded: its
    // CSS form needs an outer ring around the element's own box, and the root
    // is an origin element with no box to use.
    const first = order.length > 0 ? order[0].clip : undefined;
    if (first && !first.inverse && this.clipping && first.polygon.length >= 6) {
      let whole = true;
      for (let i = 1, n = order.length; i < n && whole; i++) whole = order[i].clip === first;
      if (whole) {
        this.useClip(first);
        this.clipOnRoot = true;
        this.writeRootClip(this.rootClipPath());
      }
    }

    for (let i = 0, n = order.length; i < n; i++) {
      const slot = order[i];
      if (!this.clipOnRoot) this.useClip(slot.clip);
      const drawn = slot.kind === 'region' ? this.renderRegion(slot) : this.renderMesh(slot);
      if (drawn) drawn.drawnIn = stamp;
    }
    for (const view of this.views.values()) if (view.drawnIn !== stamp) this.hide(view);
    // Only a clip that covered the whole frame keeps the root's style; every
    // other frame hands the caller's inline value back.
    if (!this.clipOnRoot) this.releaseRootClip();

    if (this.pendingJobs.length) {
      if (!blitter || !blitter.flush(this.pendingJobs)) {
        // Context lost mid-frame: rasterize this batch on the 2d path so the
        // frame stays complete; the next render() re-selects the backend.
        for (let i = 0; i < this.pendingJobs.length; i++) {
          const job = this.pendingJobs[i];
          this.pendingViews[i].meshBackendDrawn = 'canvas2d';
          this.rasterizeMesh2d(
            job.canvas,
            // The 2d path wants straight alpha where the upload wanted it
            // premultiplied; the derivation is cached, so this costs a lookup.
            straightAlphaSource(job.page, job.pma),
            job.vertices,
            job.uvs,
            job.triangles,
            job.ratio,
          );
        }
      }
      this.pendingJobs.length = 0;
      this.pendingViews.length = 0;
    }
  }

  /**
   * Removes every element this renderer added to the root (slot elements and
   * the tint filter defs), restores the root's own inline `clip-path` if the
   * whole-skeleton clip path borrowed it, and hands the atlas pages it
   * uploaded back to the shared GL blitter — the one resource here that outlives the instance, so
   * the one that has to be given back explicitly (GPU memory, and no garbage
   * collector feels pressure from it). The pages are reference-counted there:
   * a page another live renderer still draws stays uploaded, and the texture
   * is deleted only when the last user of it is disposed.
   *
   * The region bitmaps are deliberately untouched: the map is the caller's,
   * and one map is normally shared by many renderers (disposing one instance
   * must not blind the others). Free the unpacked blob URLs with
   * revokeRegions() once no renderer needs them.
   *
   * Idempotent: the retained-page ledger is cleared here, so a second call
   * releases nothing a second time.
   */
  dispose(): void {
    // The root is the caller's element and outlives this renderer, so the
    // borrowed inline clip-path goes back before the slot elements go.
    this.releaseRootClip();
    for (const view of this.views.values()) view.el.remove();
    this.views.clear();
    this.tintDefs?.remove();
    this.tintDefs = null;
    if (this.glPages) {
      const blitter = getMeshGlBlitter();
      if (blitter) for (const page of this.glPages) blitter.release(page);
      this.glPages = null;
    }
  }

  // --- rigid tier -----------------------------------------------------------

  private renderRegion(slot: PosedRegion): SlotView | null {
    const regionImage = this.regionImages.get(slot.region);
    if (!regionImage) return null;

    const view = this.view(slot.slot, 'image');
    const img = view.el as HTMLImageElement;
    if (view.regionName !== slot.region) {
      view.regionName = slot.region;
      img.src = regionImage.url;
      img.width = regionImage.width;
      img.height = regionImage.height;
    }

    const corners = slot.corners;
    for (let v = 0; v < 8; v++) regionVertices[v] = corners[v];
    // Corner order is BL, UL, UR, BR — the runtime's, which the poser keeps:
    // the region's UVs run (u,v2), (u,v), (u2,v), (u2,v2) in that order.
    // (The br/bl/ul/ur comments inside spine-core's computeWorldVertices are
    // stale.) Flip Y for CSS (the frame is Y-up).
    const blx = regionVertices[0], bly = -regionVertices[1];
    const ulx = regionVertices[2], uly = -regionVertices[3];
    const urx = regionVertices[4], ury = -regionVertices[5];

    const w = regionImage.width;
    const h = regionImage.height;
    const a = (urx - ulx) / w;
    const b = (ury - uly) / w;
    const c = (blx - ulx) / h;
    const d = (bly - uly) / h;
    this.setTransform(view, `matrix(${a},${b},${c},${d},${ulx},${uly})`);
    // Rigid elements carry a full affine, so the clip polygon rides its
    // inverse into the local (atlas-unit) frame the <img> box spans.
    this.applyClip(view, a, b, c, d, ulx, uly, w, h);

    this.applyCommon(view, slot);
    return view;
  }

  // --- deform tier ----------------------------------------------------------

  private renderMesh(slot: PosedMesh): SlotView | null {
    const sequenceIndex = slot.sequence;
    const page = this.pages.get(slot.page);
    if (!page) return null;
    // Which alpha convention the page's texels are in. The two backends consume
    // opposite ones — GL wants them premultiplied, `drawImage` wants them
    // straight — so this decides what each is handed, never what it does.
    const pma = slot.pma;

    const source = slot.vertices;
    const count = source.length;
    if (this.scratchVertices.length < count) this.scratchVertices = new Float32Array(count);
    const vertices = this.scratchVertices;
    for (let v = 0; v < count; v++) vertices[v] = source[v];

    // World bounds (in CSS coords: Y negated).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = 0; v < count; v += 2) {
      const x = vertices[v];
      const y = -vertices[v + 1];
      vertices[v + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 1;
    minX = Math.floor(minX) - pad;
    minY = Math.floor(minY) - pad;
    const w = Math.ceil(maxX) + pad - minX;
    const h = Math.ceil(maxY) + pad - minY;
    if (w <= 0 || h <= 0) return null;

    const view = this.view(slot.slot, 'canvas');
    const canvas = view.el as HTMLCanvasElement;
    const ratio = this.pixelRatio;
    const uvs = slot.uvs;
    const triangles = slot.triangles;
    let dirty =
      view.meshUvs !== uvs ||
      view.meshTriangles !== triangles ||
      view.meshPage !== page ||
      view.meshSequenceIndex !== sequenceIndex ||
      view.meshExpand !== this.triangleExpand ||
      view.meshVertexCount !== count ||
      view.meshBackendDrawn !== this.meshBackendActive;
    // The backing store only grows, in 32-device-px steps. Setting
    // canvas.width recreates the GPU surface, and a deforming mesh changes
    // its bbox every frame — reallocating every mesh canvas per frame
    // stalled real Safari to ~3 fps while the JS split showed ~4 ms (the
    // cost lives in the compositor, invisible to in-callback timing). With
    // grow-only quantized backing, steady-state animation reallocates
    // nothing. A pixelRatio change is the one exception to grow-only: it
    // reallocates every mesh canvas anyway, so the new size comes from the
    // new need alone. Keeping the old size as a floor there would make a
    // ratio *drop* pay the reallocation and keep every oversized pixel — the
    // backing would never come back down to what that ratio needs. The CSS
    // size mirrors the whole backing so the pixel mapping stays 1:1; the mesh
    // draws into the top-left w×h logical region and the rest stays
    // transparent.
    const needW = Math.max(1, Math.round(w * ratio));
    const needH = Math.max(1, Math.round(h * ratio));
    const ratioChanged = view.meshRatio !== ratio;
    if (needW > view.canvasW || needH > view.canvasH || ratioChanged) {
      // 25% slack: at low fps the animation is sampled sparsely, so new bbox
      // maxima keep being discovered for many seconds — allocate ahead of the
      // curve instead of chasing it.
      const step = 32;
      const floorW = ratioChanged ? 0 : view.canvasW;
      const floorH = ratioChanged ? 0 : view.canvasH;
      view.canvasW = Math.ceil(Math.max(needW * 1.25, floorW) / step) * step;
      view.canvasH = Math.ceil(Math.max(needH * 1.25, floorH) / step) * step;
      view.meshRatio = ratio;
      canvas.width = view.canvasW;
      canvas.height = view.canvasH;
      canvas.style.width = `${view.canvasW / ratio}px`;
      canvas.style.height = `${view.canvasH / ratio}px`;
      this.canvasReallocCount++;
      dirty = true;
    }

    // Canvas-space vertices: identical values mean last frame's raster is
    // still exact (static pose, or the part moved by whole pixels), so the
    // per-triangle redraw can be skipped — the CSS translate below keeps
    // tracking the part. This is the main WebKit cost lever: idle skeletons
    // stop paying the raster entirely.
    if (view.meshVertices.length < count) {
      view.meshVertices = new Float64Array(count);
      dirty = true;
    }
    const rel = view.meshVertices;
    for (let v = 0; v < count; v += 2) {
      const x = vertices[v] - minX;
      const y = vertices[v + 1] - minY;
      if (rel[v] !== x || rel[v + 1] !== y) dirty = true;
      rel[v] = x;
      rel[v + 1] = y;
    }

    this.setTransform(view, `translate(${minX}px,${minY}px)`);
    // A mesh canvas is posed by a translate only, so its local frame is the
    // CSS-space polygon minus that translate. The clip never reaches the
    // raster: it is not part of the dirty signature, and a mesh whose vertices
    // held still still reuses its raster under a moving clip.
    this.applyClip(view, 1, 0, 0, 1, minX, minY, view.canvasW / ratio, view.canvasH / ratio);

    if (!dirty) {
      this.meshReuseCount++;
    } else {
      view.meshUvs = uvs;
      view.meshTriangles = triangles;
      view.meshPage = page;
      view.meshSequenceIndex = sequenceIndex;
      view.meshExpand = this.triangleExpand;
      view.meshVertexCount = count;
      view.meshBackendDrawn = this.meshBackendActive;

      if (this.meshBackendActive === 'webgl') {
        // Queued, not drawn: render() flushes the whole batch through the
        // shared GL context once the slot loop is done. `rel` is this view's
        // own signature array — nothing mutates it before the flush.
        this.pendingJobs.push({
          canvas,
          page,
          pma,
          vertices: rel,
          uvs,
          triangles,
          ratio,
          width: Math.min(view.canvasW, Math.ceil(w * ratio)),
          height: Math.min(view.canvasH, Math.ceil(h * ratio)),
        });
        this.pendingViews.push(view);
        this.retainPage(page);
      } else {
        this.rasterizeMesh2d(canvas, straightAlphaSource(page, pma), rel, uvs, triangles, ratio);
      }
      this.meshCount++;
      this.triangleCount += triangles.length / 3;
    }

    this.applyCommon(view, slot);
    return view;
  }

  /**
   * Declares this renderer a user of `page` with the shared blitter, once per
   * page — the counterpart of the release in dispose(). The set is this
   * renderer's own ledger, so sharing one page across renderers works by
   * counting rather than by guessing. On the render path this costs one
   * Set.has per queued mesh job and allocates nothing after the first page.
   */
  private retainPage(page: HTMLImageElement): void {
    const pages = (this.glPages ??= new Set<HTMLImageElement>());
    if (pages.has(page)) return;
    // Null only if the context died between the backend pick and here; the
    // flush then fails too and the batch falls back to canvas2d.
    const blitter = getMeshGlBlitter();
    if (!blitter) return;
    pages.add(page);
    blitter.retain(page);
  }

  /** The canvas2d raster path: clear the backing, map each triangle. */
  private rasterizeMesh2d(
    canvas: HTMLCanvasElement,
    page: PageSource,
    vertices: Float64Array,
    uvs: ArrayLike<number>,
    triangles: ArrayLike<number>,
    ratio: number,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Clear the full backing: the previous frame's bbox (and so its drawn
    // region) may have been larger than today's.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Texel addressing, shared with the GL blitter: a normalized UV maps to
    // `uv * size` in the continuous texture frame where the page spans
    // [0, size] and texel i covers [i, i+1). drawImage-under-a-transform and
    // texture2D() both read that frame, so both backends land on the same
    // source pixels. (No half-texel term: the affine below *maps* corners, it
    // does not sample — see drawTriangle.) `page` is the page image, or its
    // straight-alpha derivation on a premultiplied one; the derivation is the
    // image's own natural size, so the frame is the same either way.
    const uw = page.width;
    const uh = page.height;
    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = triangles[t] * 2;
      const i1 = triangles[t + 1] * 2;
      const i2 = triangles[t + 2] * 2;
      this.drawTriangle(
        ctx, page,
        vertices[i0], vertices[i0 + 1], uvs[i0] * uw, uvs[i0 + 1] * uh,
        vertices[i1], vertices[i1 + 1], uvs[i1] * uw, uvs[i1 + 1] * uh,
        vertices[i2], vertices[i2 + 1], uvs[i2] * uw, uvs[i2 + 1] * uh,
      );
    }
  }

  /**
   * Standard canvas triangle texture mapping (same math as the official
   * spine-canvas renderer): derive the affine that sends the triangle's
   * texture-space corners to its screen-space corners, clip, draw the page —
   * but only the part of the page this triangle can show (see below).
   *
   * The clip polygon is expanded outward from the centroid by a fraction of
   * a pixel. Browsers that antialias clip paths (Safari) otherwise leave
   * hairline cracks between adjacent triangles; the expanded clips overlap
   * into the neighbouring triangle, and since the texture is continuous
   * across the shared edge the overlap draws the same pixels — cracks close
   * with no visible cost. The texture-mapping affine itself stays exact.
   *
   * ## Why a source sub-rect instead of the whole page
   *
   * The draw is a 9-argument `drawImage` whose source rect covers exactly what
   * the clip can reveal, placed at the same texture-space position, so the
   * mapping is identical to drawing the whole page — the same affine, the same
   * texels, only fewer of them offered to the rasterizer.
   *
   * That is not an optimization. Linux WebKit — the software rasterizer, the
   * only engine this has been observed on; Chromium and macOS WebKit never show
   * it — garbles individual triangles when the whole page is drawn under a
   * steep per-triangle affine: read off the parity dump, head/goggles/foot
   * triangles land with displaced texture while the webgl capture of the same
   * pose stays clean. Switching this one call to a source sub-rect — the only
   * variable changed — took that platform's bad-pixel counts from 1042 to 2
   * (hoverboard), 231 to 4 (portal) and 803 to 3 (walk + tint), and left every
   * Chromium capture byte-identical. [measured on the ubuntu CI runner through
   * PARITY_DUMP: first with a fixed 2-texel pad (run 35209262693), then with
   * the derived rect below — the same counts (run 35213286993).] WHY that
   * rasterizer garbles the whole-page form is not identified; steep affines
   * making whole-page coordinates large is a suspicion, not a measurement. The
   * sub-rect sidesteps it. (Moving `clip()` before `transform()` was tried as a
   * separate one-variable experiment: every number came back identical, so the
   * clip path is not the cause.)
   *
   * ## How the sub-rect is derived
   *
   * It must provably cover everything the clip can reveal, which is the
   * *expanded* polygon, not the triangle. So each clip corner's canvas-space
   * displacement is pushed back through the inverse of the 2×2 affine into
   * texture space, the bounding box is taken over the displaced corners, one
   * texel of bilinear support is added, and the result is floor/ceil'd to texel
   * boundaries (so the sub-rect itself resamples nothing) and clamped to the
   * page. A fixed pad would not do: the texture-space reach of the expansion is
   * `triangleExpand` times the local texels-per-canvas-unit, which on the
   * demo's own meshes ranges from ~0.26 texels on a typical triangle to ~8.6 on
   * a foreshortened one. Under-padding lets the rim of the overdraw sample
   * nothing, which brings back the very seams the overdraw exists to close.
   *
   * No half-texel offset is applied to the incoming u/v: the `(i + 0.5) / size`
   * texel-centre convention belongs to *sampling* (landing inside the intended
   * texel instead of on a filter boundary). This solves for the affine that
   * sends three source corners to three destination corners; the rasterizer
   * then samples continuously along that map. Biasing all three corners by
   * half a texel would translate the texture against the geometry — the very
   * class of offset the `uv * size` addressing removes.
   */
  private drawTriangle(
    ctx: CanvasRenderingContext2D, img: PageSource,
    x0: number, y0: number, u0: number, v0: number,
    x1: number, y1: number, u1: number, v1: number,
    x2: number, y2: number, u2: number, v2: number,
  ): void {
    drawTexturedTriangle(ctx, img, this.triangleExpand, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2);
  }

  // --- clipping tier ---------------------------------------------------------

  /**
   * Makes `clip` the clip in force for the slot about to be drawn, loading its
   * polygon when it is not the one already loaded. Each clip object is counted
   * once per frame — in clipCount when applied, in clipSkipCount when
   * `clipping` is off or the polygon has fewer than three points (no clip is
   * in force then, so the slot draws unclipped, as the runtime would).
   *
   * The polygon is the poser's world-space one, and the only things done to it
   * here are the single-precision read the vertex paths share and the Y
   * negation the rest of the renderer already applies. It is NOT convexified
   * or triangulated the way the CPU clipper does — CSS `polygon()` takes a
   * concave polygon directly, so the decomposition that exists to feed a
   * triangle rasterizer has no job here.
   */
  private useClip(clip: PosedClip | undefined): void {
    if (!clip) {
      this.clipActive = null;
      return;
    }
    if (clip === this.clipActive) return;
    const count = clip.polygon.length;
    const counted = this.clipsSeen.has(clip);
    if (!this.clipping || count < 6) {
      if (!counted) {
        this.clipsSeen.add(clip);
        this.clipSkipCount++;
      }
      this.clipActive = null;
      return;
    }
    if (!counted) {
      this.clipsSeen.add(clip);
      this.clipCount++;
    }
    const polygon = clip.polygon;
    if (this.scratchVertices.length < count) this.scratchVertices = new Float32Array(count);
    const world = this.scratchVertices;
    for (let v = 0; v < count; v++) world[v] = polygon[v];
    if (this.clipPolygon.length < count) this.clipPolygon = new Float64Array(count);
    const poly = this.clipPolygon;
    for (let v = 0; v < count; v += 2) {
      poly[v] = world[v];
      poly[v + 1] = -world[v + 1]; // The frame is Y-up, CSS is Y-down.
    }
    this.clipPolygonLength = count;
    this.clipActive = clip;
    this.clipInverse = clip.inverse;
  }

  /**
   * Writes (or clears) this element's clip-path. `a…f` is the element's own
   * CSS transform, and the world polygon is carried through its INVERSE:
   * clip-path is resolved in the element's local frame and then transformed
   * along with the element, so the polygon has to arrive there already.
   *
   * `transform-origin` is `0 0` on every slot element (see view()), so the
   * matrix maps local (0,0) to (e,f) with no origin term to undo, and
   * `left/top: 0` puts the border box — clip-path's reference box — on that
   * same local origin.
   */
  private applyClip(
    view: SlotView,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    boxW: number,
    boxH: number,
  ): void {
    if (!this.clipActive || this.clipOnRoot) {
      this.setClipPath(view, '');
      return;
    }
    const det = a * d - b * c;
    // Singular: the element is collapsed onto a line or a point and draws
    // nothing, so there is no clip to express and no style write to pay for.
    if (det === 0) return;
    const inv = 1 / det;
    const poly = this.clipPolygon;
    const n = this.clipPolygonLength;
    // An inverse clip shows what is OUTSIDE the polygon. That shape has a hole
    // in it, so it needs TWO rings — an outer one and the polygon — and
    // `polygon()` cannot carry two: it is one closed ring, and listing a box
    // and a polygon inside it just makes one self-intersecting ring whose
    // even-odd fill leaves a wedge of the seam between them (measured, on a
    // corner of spineboy's boot). `path()` takes subpaths, so an inverse clip
    // is written as two of them with the even-odd rule. The outer ring is the
    // element's own box: the element paints nothing outside it anyway, so
    // box-minus-polygon is exactly the visible part of the inverse region.
    const inverse = this.clipInverse;
    let s = inverse
      ? `path(evenodd,'M0 0H${clipNum(boxW)}V${clipNum(boxH)}H0Z`
      : 'polygon(';
    for (let v = 0; v < n; v += 2) {
      const dx = poly[v] - e;
      const dy = poly[v + 1] - f;
      const lx = (d * dx - c * dy) * inv;
      const ly = (a * dy - b * dx) * inv;
      // Near-singular matrices blow the inverse up; see CLIP_COORD_LIMIT for
      // why an unwritable coordinate must not become a written-and-ignored one.
      if (!(Math.abs(lx) <= CLIP_COORD_LIMIT) || !(Math.abs(ly) <= CLIP_COORD_LIMIT)) return;
      if (inverse) {
        s += `${v > 0 ? 'L' : 'M'}${clipNum(lx)} ${clipNum(ly)}`;
      } else {
        s += `${v > 0 ? ',' : ''}${clipCoord(lx)} ${clipCoord(ly)}`;
      }
    }
    this.setClipPath(view, inverse ? `${s}Z')` : `${s})`);
  }

  private setClipPath(view: SlotView, clipPath: string): void {
    if (view.clipPath === clipPath) return;
    view.clipPath = clipPath;
    view.el.style.clipPath = clipPath;
    this.clipWriteCount++;
  }

  /** The active polygon in the root's own frame — no element transform. */
  private rootClipPath(): string {
    const poly = this.clipPolygon;
    let s = 'polygon(';
    for (let v = 0, n = this.clipPolygonLength; v < n; v += 2) {
      if (v > 0) s += ',';
      s += `${clipCoord(poly[v])} ${clipCoord(poly[v + 1])}`;
    }
    return `${s})`;
  }

  private writeRootClip(clipPath: string): void {
    // Borrow the caller's inline value once, so releaseRootClip gives back
    // exactly what was there. Reading `.style` is CSSOM, not a layout read.
    if (this.rootClipSaved === null) this.rootClipSaved = this.root.style.clipPath;
    if (this.rootClipWritten === clipPath) return;
    this.rootClipWritten = clipPath;
    this.root.style.clipPath = clipPath;
    this.clipWriteCount++;
  }

  private releaseRootClip(): void {
    if (this.rootClipSaved === null) return;
    this.root.style.clipPath = this.rootClipSaved;
    this.rootClipSaved = null;
    this.rootClipWritten = '';
    this.clipWriteCount++;
  }

  // --- shared plumbing -------------------------------------------------------

  private setTransform(view: SlotView, transform: string): void {
    if (view.transform !== transform) {
      view.transform = transform;
      view.el.style.transform = transform;
    }
  }

  private applyCommon(view: SlotView, slot: PosedSlot): void {
    const zIndex = slot.z;
    const tint = slot.tint;
    if (view.zIndex !== zIndex) {
      view.zIndex = zIndex;
      view.el.style.zIndex = String(zIndex);
    }
    const alpha = tint[3];
    if (view.opacity !== alpha) {
      view.opacity = alpha;
      view.el.style.opacity = alpha === 1 ? '' : String(alpha);
    }
    // RGB tint (uniform per slot) rides an feColorMatrix reference filter:
    // scaling the channels is an exact multiply, applies to <img> and
    // <canvas> alike, and never touches the raster. Needs reference-filter
    // support (Safari 15+).
    const r = tint[0];
    const g = tint[1];
    const b = tint[2];
    if (view.tintR !== r || view.tintG !== g || view.tintB !== b) {
      view.tintR = r;
      view.tintG = g;
      view.tintB = b;
      if (r === 1 && g === 1 && b === 1) {
        view.el.style.filter = '';
      } else {
        this.tintMatrixFor(view).setAttribute(
          'values',
          `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`,
        );
        view.el.style.filter = `url(#${view.tintId})`;
      }
    }
    const blendMode = slot.blend;
    if (view.blendMode !== blendMode) {
      view.blendMode = blendMode;
      view.el.style.mixBlendMode = BLEND_CSS[blendMode];
    }
    if (!view.visible) {
      view.visible = true;
      view.el.style.display = '';
    }
  }

  private tintMatrixFor(view: SlotView): SVGFEColorMatrixElement {
    if (view.tintMatrix) return view.tintMatrix;
    if (!this.tintDefs) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      this.root.appendChild(svg);
      this.tintDefs = svg;
    }
    const filter = document.createElementNS(SVG_NS, 'filter');
    view.tintId = `spine-html-tint-${tintFilterSeq++}`;
    filter.setAttribute('id', view.tintId);
    // Filter math must happen in sRGB to match Spine's color multiply
    // (SVG filters default to linearRGB).
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
    matrix.setAttribute('in', 'SourceGraphic');
    matrix.setAttribute('type', 'matrix');
    filter.appendChild(matrix);
    this.tintDefs.appendChild(filter);
    view.tintMatrix = matrix;
    return matrix;
  }

  private view(slot: string, kind: SlotKind): SlotView {
    let view = this.views.get(slot);
    if (view && view.kind !== kind) {
      view.el.remove();
      view.tintMatrix?.parentElement?.remove();
      view = undefined;
    }
    if (!view) {
      const el = kind === 'image' ? document.createElement('img') : document.createElement('canvas');
      if (el instanceof HTMLImageElement) el.draggable = false;
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '0';
      el.style.transformOrigin = '0 0';
      el.style.pointerEvents = 'none';
      el.style.userSelect = 'none';
      el.style.display = 'none';
      view = {
        kind,
        el,
        regionName: '',
        visible: false,
        zIndex: -1,
        opacity: 1,
        blendMode: 'Normal',
        transform: '',
        clipPath: '',
        tintR: 1,
        tintG: 1,
        tintB: 1,
        tintId: '',
        tintMatrix: null,
        canvasW: 0,
        canvasH: 0,
        meshRatio: -1,
        meshUvs: null,
        meshTriangles: null,
        meshPage: null,
        meshSequenceIndex: -1,
        meshExpand: -1,
        meshVertexCount: -1,
        meshBackendDrawn: '',
        meshVertices: new Float64Array(0),
        drawnIn: 0,
      };
      this.views.set(slot, view);
      this.root.appendChild(el);
    }
    return view;
  }

  private hide(view: SlotView): void {
    if (view.visible) {
      view.visible = false;
      view.el.style.display = 'none';
    }
    // A hidden element keeps no clip-path: one left behind would sit there
    // stale until the slot draws again, and "nothing is clipped" has to be
    // true of the DOM, not only of what gets painted. Cached like every other
    // write, so the sweep costs one write per element, once.
    this.setClipPath(view, '');
  }
}

/**
 * The body of `DomRenderer.drawTriangle` (see it for the mapping, the clip
 * overdraw and the source sub-rect), as a function so the canvas render mode's
 * 2d fallback draws its triangles through the same code.
 *
 * @internal Not part of the package API.
 */
export function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D, img: PageSource, expand: number,
  x0: number, y0: number, u0: number, v0: number,
  x1: number, y1: number, u1: number, v1: number,
  x2: number, y2: number, u2: number, v2: number,
): void {
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  const [px0, py0] = expandPoint(x0, y0, cx, cy, expand);
  const [px1, py1] = expandPoint(x1, y1, cx, cy, expand);
  const [px2, py2] = expandPoint(x2, y2, cx, cy, expand);
  ctx.beginPath();
  ctx.moveTo(px0, py0);
  ctx.lineTo(px1, py1);
  ctx.lineTo(px2, py2);
  ctx.closePath();

  // Edge vectors, in canvas space and in texture space.
  const ex1 = x1 - x0, ey1 = y1 - y0;
  const ex2 = x2 - x0, ey2 = y2 - y0;
  const eu1 = u1 - u0, ev1 = v1 - v0;
  const eu2 = u2 - u0, ev2 = v2 - v0;

  let det = eu1 * ev2 - eu2 * ev1;
  if (det === 0) return;
  det = 1 / det;

  const a = (ev2 * ex1 - ev1 * ex2) * det;
  const b = (ev2 * ey1 - ev1 * ey2) * det;
  const c = (eu1 * ex2 - eu2 * ex1) * det;
  const d = (eu1 * ey2 - eu2 * ey1) * det;
  const e = x0 - a * u0 - c * v0;
  const f = y0 - b * u0 - d * v0;

  // Texture-space bounds of the clip polygon. The triangle's own corners
  // first, then the three expansion offsets carried back through the inverse
  // of [[a, c], [b, d]] — the clip reaches exactly that far and no further.
  let minU = Math.min(u0, u1, u2);
  let maxU = Math.max(u0, u1, u2);
  let minV = Math.min(v0, v1, v2);
  let maxV = Math.max(v0, v1, v2);
  const detM = a * d - b * c;
  if (detM !== 0) {
    const im = 1 / detM;
    const ia = d * im, ic = -c * im, ib = -b * im, id = a * im;
    let gx = px0 - x0, gy = py0 - y0;
    let tu = u0 + ia * gx + ic * gy, tv = v0 + ib * gx + id * gy;
    minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
    minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
    gx = px1 - x1; gy = py1 - y1;
    tu = u1 + ia * gx + ic * gy; tv = v1 + ib * gx + id * gy;
    minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
    minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
    gx = px2 - x2; gy = py2 - y2;
    tu = u2 + ia * gx + ic * gy; tv = v2 + ib * gx + id * gy;
    minU = Math.min(minU, tu); maxU = Math.max(maxU, tu);
    minV = Math.min(minV, tv); maxV = Math.max(maxV, tv);
  }
  // One texel of bilinear support on every side, snapped outward to texel
  // boundaries, clamped to the page. Source rect and destination rect are the
  // same rect in texture space, so the affine below maps it exactly as it
  // mapped the whole page.
  const sx = Math.max(0, Math.floor(minU - 1));
  const sy = Math.max(0, Math.floor(minV - 1));
  const sw = Math.min(img.width, Math.ceil(maxU + 1)) - sx;
  const sh = Math.min(img.height, Math.ceil(maxV + 1)) - sy;
  if (!(sw > 0) || !(sh > 0)) return;

  ctx.save();
  ctx.transform(a, b, c, d, e, f);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}
