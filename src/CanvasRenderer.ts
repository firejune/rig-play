import { syncedPixelRatio } from './pixelRatio.js';
import { clipThrough, REGION_TRIANGLES } from 'rig-c/core';
import { drawTexturedTriangle } from './DomRenderer.js';
import { type PageSource, straightAlphaSource } from './DomTexture.js';
import { type FrameRun, getMeshGlBlitter } from './MeshGlBlitter.js';
import type { BlendMode, PosedClip, PosedFrame, PosedSlot } from './posedFrame.js';

/** What actually drew the last frame of a `CanvasRenderer`. */
export type CanvasBackend = 'webgl' | 'canvas2d';

/** A rectangle of world space, Y up: `x`, `y` is its bottom-left corner. */
export interface CanvasViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BLEND_CODE: Record<BlendMode, number> = { Normal: 0, Additive: 1, Multiply: 2, Screen: 3 };
const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  Normal: 'source-over',
  Additive: 'lighter',
  Multiply: 'multiply',
  Screen: 'screen',
};
/** Root units added round the drawn bounds when the automatic viewport grows. */
const GROW_PAD = 16;

/**
 * Renders a posed frame (`PosedFrame`) into **one `<canvas>`** — the canvas
 * render mode, beside the DOM tier (`DomRenderer`) and with the same
 * `render(frame)` interface.
 *
 * Every slot is drawn as textured triangles straight from its atlas page — a
 * region as two triangles over its four corners and its page UVs, a mesh as its
 * own triangles — through the **shared module-level WebGL context** of the mesh
 * blitter (`MeshGlBlitter.ts`), into one rect of its offscreen buffer, and the
 * rect is copied onto this renderer's visible canvas with one `drawImage`. No
 * context is created per renderer, so any number of players draw under the
 * browser's ~16-context cap, and the page textures are shared and
 * reference-counted with every other renderer on the page.
 *
 * - **Tint** (slot × attachment × the player's colour) is a vertex colour,
 *   premultiplied by its alpha; the **dark** (two-colour) tint is a second
 *   vertex colour, carried only when some slot of the frame has one.
 * - **Blend** is batch state: a run of triangles ends wherever the page or the
 *   blend mode changes (`drawCalls`, and `blendFlushes` for the blend changes).
 *   The blends are composed inside this canvas's own rect, which starts
 *   transparent — an additive or multiply slot meets the slots under it, not
 *   the page behind the canvas.
 * - **Clipping** is the core's cut: every triangle a clip covers goes through
 *   `clipThrough` from `rig-c/core` (convex polygons by the runtime's measured
 *   rule, concave ones into convex pieces, inverse clips as the hull's
 *   outside). No stencil, no `clip-path`.
 * - **Projection**: the canvas covers a rect of the root's own coordinates
 *   (world x, world −y — the DOM tier's frame), so a world point lands at
 *   `((x − left) · pixelRatio, (−y − top) · pixelRatio)` device px. That rect
 *   is the caller's `viewport` when set, and otherwise grows to cover what the
 *   frames draw (grow-only, so steady animation reallocates nothing).
 * - **Dirty-skip**: a frame whose record equals the last one drawn — vertex
 *   arrays, tints, order, clips, pages — draws nothing (`framesReused`).
 *
 * When WebGL is unavailable or the shared context is lost, the frame is drawn
 * on the same visible canvas with canvas2d: regions by `drawImage` under their
 * affine, meshes and clipped pieces by the DOM tier's per-triangle mapping.
 * That fallback multiplies **alpha only** — RGB and dark tints are not drawn
 * there (`ctx.filter` is not available on Safari) — and it is a safety net,
 * not the measured path.
 */
export class CanvasRenderer {
  /**
   * Backing-store pixels per root CSS pixel; defaults to the device pixel
   * ratio. A root under a CSS-scaled ancestor rasters at the wrong resolution
   * until the scale is folded in — `syncPixelRatio()` measures it, as for the
   * DOM tier. The next `render` sizes the backing store to the new ratio.
   */
  pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  /** Apply the clips the frame carries (default). False draws every slot unclipped and counts the clips in `clipSkipCount`. */
  clipping = true;
  /**
   * The world rect the canvas covers. Null (default) sizes it from the frames
   * themselves: it grows to cover everything drawn and never shrinks. Set it to
   * pin the canvas to a stage box; what falls outside is not drawn.
   */
  viewport: CanvasViewport | null = null;
  /** The backend to draw with: 'webgl' (default) through the shared context, or 'canvas2d' to force the fallback. */
  backend: CanvasBackend = 'webgl';
  /** What drew the last frame (or would have, had it not been reused). */
  backendActive: CanvasBackend = 'webgl';
  /** The visible canvas — the renderer's one element in the root. */
  readonly canvas: HTMLCanvasElement;

  /** Draw calls issued last frame — one per run of one page under one blend. */
  drawCalls = 0;
  /** Of those runs, how many began because the blend mode changed. */
  blendFlushes = 0;
  /** Triangles drawn last frame, clipped pieces counted as cut. */
  trianglesDrawn = 0;
  /** 1 when the last render() found the record unchanged and drew nothing, else 0. */
  framesReused = 0;
  /** Blits onto the visible canvas last frame (0 or 1). */
  blits = 0;
  /** Visible-canvas backing reallocations last frame; settles at zero. */
  canvasReallocCount = 0;
  /** Distinct clips applied last frame. */
  clipCount = 0;
  /** Clips in the frame not applied last frame: `clipping` off, fewer than three points, or a polygon the core refuses to cut. */
  clipSkipCount = 0;

  private readonly ctx: CanvasRenderingContext2D | null;
  /** The rect in root units the canvas covers: left, top, right, bottom (Y down). Empty until the first frame. */
  private left = 0;
  private top = 0;
  private right = 0;
  private bottom = 0;
  private hasRect = false;
  private backingW = 0;
  private backingH = 0;
  private backingRatio = -1;
  private data = new Float32Array(4096);
  private readonly runs: FrameRun[] = [];
  /** Pages retained from the shared blitter, one retain each, released by dispose(). */
  private readonly glPages = new Set<HTMLImageElement>();
  /** The dirty signature of the last frame drawn: its numbers, and the objects it compares by identity. */
  private sig = new Float64Array(256);
  private sigLength = -1;
  private sigRefs: unknown[] = [];
  private nextSig = new Float64Array(256);
  private nextRefs: unknown[] = [];

  /**
   * @param root Positioned element that becomes the skeleton origin, exactly as
   *   for `DomRenderer`: the canvas is appended to it and placed in its own
   *   coordinates; layout and scaling of the root belong to the caller.
   * @param pages Page images keyed by page name — `PosedRegion.page` and
   *   `PosedMesh.page`. Read on every draw.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly pages: ReadonlyMap<string, HTMLImageElement>,
  ) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.transformOrigin = '0 0';
    canvas.style.pointerEvents = 'none';
    canvas.style.userSelect = 'none';
    canvas.width = 0;
    canvas.height = 0;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    root.appendChild(canvas);
  }

  /** Grows the automatic viewport to cover `box` (world units, Y up) ahead of the frames reaching it. */
  /**
   * Measures the root's effective on-screen scale and sets `pixelRatio` to
   * `devicePixelRatio × scale`, returning the ratio now in effect — the same
   * call, the same meaning and the same deadband as `DomRenderer`'s, so code
   * written against `player.renderer` survives a `mode` change. One forced
   * layout per call (a hidden box appended to the root, read, removed), which
   * is why the renderer never calls it for you. The backing store follows on
   * the next `render`; a root that is not laid out leaves the ratio alone.
   */
  syncPixelRatio(): number {
    this.pixelRatio = syncedPixelRatio(this.root, this.pixelRatio);
    return this.pixelRatio;
  }

  reserve(box: CanvasViewport): void {
    this.growTo(box.x, -(box.y + box.height), box.x + box.width, -box.y);
  }

  /** Draws one frame. */
  render(frame: PosedFrame): void {
    this.drawCalls = 0;
    this.blendFlushes = 0;
    this.trianglesDrawn = 0;
    this.framesReused = 0;
    this.blits = 0;
    this.canvasReallocCount = 0;
    this.clipCount = 0;
    this.clipSkipCount = 0;
    const blitter = this.backend === 'webgl' ? getMeshGlBlitter() : null;
    this.backendActive = blitter ? 'webgl' : 'canvas2d';
    const order = frame.order;

    // The rect: the caller's, or the grow-only cover of what this frame draws.
    const view = this.viewport;
    if (view) {
      this.setRect(Math.floor(view.x), Math.floor(-(view.y + view.height)), Math.ceil(view.x + view.width), Math.ceil(-view.y));
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < order.length; i++) {
        const slot = order[i];
        const v = slot.kind === 'region' ? slot.corners : slot.vertices;
        for (let k = 0; k + 1 < v.length; k += 2) {
          const x = v[k];
          const y = -v[k + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (minX <= maxX && minY <= maxY) this.growTo(minX, minY, maxX, maxY);
    }
    this.sizeBacking();

    if (!this.signatureChanged(order)) {
      this.framesReused = 1;
      this.countClips(order);
      return;
    }
    if (this.backingW === 0 || this.backingH === 0) return;

    if (blitter) {
      this.buildVertices(order);
      if (blitter.flushFrame({ canvas: this.canvas, width: this.backingW, height: this.backingH, data: this.data, stride: this.stride, runs: this.runs })) {
        this.blits = 1;
        return;
      }
      // Lost mid-frame: draw this frame on the fallback; the next render() re-selects.
      this.backendActive = 'canvas2d';
      this.sigLength = -1;
    }
    this.draw2d(order);
  }

  /** Removes the canvas from the root and hands the pages it uploaded back to the shared blitter. Idempotent. */
  dispose(): void {
    this.canvas.remove();
    if (this.glPages.size) {
      const blitter = getMeshGlBlitter();
      if (blitter) for (const page of this.glPages) blitter.release(page);
      this.glPages.clear();
    }
    this.sigLength = -1;
  }

  // --- the rect -------------------------------------------------------------

  private growTo(minX: number, minY: number, maxX: number, maxY: number): void {
    if (this.hasRect && minX >= this.left && minY >= this.top && maxX <= this.right && maxY <= this.bottom) return;
    if (!this.hasRect) {
      this.setRect(Math.floor(minX) - GROW_PAD, Math.floor(minY) - GROW_PAD, Math.ceil(maxX) + GROW_PAD, Math.ceil(maxY) + GROW_PAD);
      return;
    }
    // Grow with slack on the side that was outgrown, so a pose sampled sparsely
    // does not reallocate on every new extreme it finds.
    const slackX = Math.max(GROW_PAD, Math.round((this.right - this.left) / 4));
    const slackY = Math.max(GROW_PAD, Math.round((this.bottom - this.top) / 4));
    this.setRect(
      minX < this.left ? Math.floor(minX) - slackX : this.left,
      minY < this.top ? Math.floor(minY) - slackY : this.top,
      maxX > this.right ? Math.ceil(maxX) + slackX : this.right,
      maxY > this.bottom ? Math.ceil(maxY) + slackY : this.bottom,
    );
  }

  private setRect(left: number, top: number, right: number, bottom: number): void {
    if (this.hasRect && left === this.left && top === this.top && right === this.right && bottom === this.bottom) return;
    this.left = left;
    this.top = top;
    this.right = Math.max(left, right);
    this.bottom = Math.max(top, bottom);
    this.hasRect = true;
    this.canvas.style.transform = `translate(${left}px,${top}px)`;
  }

  /** The backing store at `rect × pixelRatio`; reallocated only when that changes. */
  private sizeBacking(): void {
    const ratio = this.pixelRatio;
    const w = this.hasRect ? Math.max(0, Math.ceil((this.right - this.left) * ratio)) : 0;
    const h = this.hasRect ? Math.max(0, Math.ceil((this.bottom - this.top) * ratio)) : 0;
    if (w === this.backingW && h === this.backingH && ratio === this.backingRatio) return;
    this.backingW = w;
    this.backingH = h;
    this.backingRatio = ratio;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w / ratio}px`;
    this.canvas.style.height = `${h / ratio}px`;
    this.canvasReallocCount++;
    this.sigLength = -1;
  }

  // --- dirty-skip -----------------------------------------------------------

  /** Writes this frame's signature and compares it with the last one drawn; keeps it when it differs. */
  private signatureChanged(order: PosedSlot[]): boolean {
    let n = 0;
    const refs = this.nextRefs;
    refs.length = 0;
    let sig = this.nextSig;
    const need = (k: number): void => {
      if (n + k > sig.length) {
        const grown = new Float64Array(Math.max(sig.length * 2, n + k));
        grown.set(sig.subarray(0, n));
        sig = grown;
        this.nextSig = grown;
      }
    };
    need(8);
    sig[n++] = this.left;
    sig[n++] = this.top;
    sig[n++] = this.backingW;
    sig[n++] = this.backingH;
    sig[n++] = this.backingRatio;
    sig[n++] = this.backendActive === 'webgl' ? 1 : 0;
    sig[n++] = this.clipping ? 1 : 0;
    sig[n++] = order.length;
    let lastClip: PosedClip | undefined;
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      const v = slot.kind === 'region' ? slot.corners : slot.vertices;
      const clip = slot.clip;
      need(10 + v.length + (clip && clip !== lastClip ? clip.polygon.length + 3 : 1));
      sig[n++] = slot.kind === 'region' ? 0 : 1;
      sig[n++] = BLEND_CODE[slot.blend];
      const t = slot.tint;
      sig[n++] = t[0];
      sig[n++] = t[1];
      sig[n++] = t[2];
      sig[n++] = t[3];
      const d = slot.dark;
      sig[n++] = d ? d[0] : -1;
      sig[n++] = d ? d[1] : -1;
      sig[n++] = d ? d[2] : -1;
      sig[n++] = v.length;
      for (let k = 0; k < v.length; k++) sig[n++] = v[k];
      if (!clip) {
        sig[n++] = 0;
      } else if (clip === lastClip) {
        sig[n++] = 1;
      } else {
        sig[n++] = 2;
        sig[n++] = (clip.inverse ? 1 : 0) + (clip.convex ? 2 : 0);
        sig[n++] = clip.polygon.length;
        for (let k = 0; k < clip.polygon.length; k++) sig[n++] = clip.polygon[k];
        lastClip = clip;
      }
      refs.push(this.pages.get(slot.page), slot.uvs);
      if (slot.kind === 'mesh') refs.push(slot.triangles);
    }
    let same = n === this.sigLength && refs.length === this.sigRefs.length;
    for (let k = 0; same && k < n; k++) same = sig[k] === this.sig[k];
    for (let k = 0; same && k < refs.length; k++) same = refs[k] === this.sigRefs[k];
    if (same) return false;
    // Swap: the new signature becomes the kept one.
    this.nextSig = this.sig;
    this.sig = sig;
    this.sigLength = n;
    this.nextRefs = this.sigRefs;
    this.sigRefs = refs;
    return true;
  }

  /** The clip counters for a reused frame — what drawing it would have counted. */
  private countClips(order: PosedSlot[]): void {
    const seen = new Set<PosedClip>();
    for (const slot of order) {
      const clip = slot.clip;
      if (!clip || seen.has(clip)) continue;
      seen.add(clip);
      if (this.clipping && clip.polygon.length >= 6) this.clipCount++;
      else this.clipSkipCount++;
    }
  }

  // --- geometry ---------------------------------------------------------------

  private stride: 8 | 11 = 8;

  /**
   * The slot's triangles in world space with their page UVs — cut by the clip
   * over it when one applies — or null when the slot draws nothing.
   */
  private piecesOf(
    slot: PosedSlot,
    clips: Map<PosedClip, boolean>,
  ): { vertices: ArrayLike<number>; uvs: ArrayLike<number>; triangles: ArrayLike<number> } | null {
    const vertices = slot.kind === 'region' ? slot.corners : slot.vertices;
    const triangles = slot.kind === 'region' ? REGION_TRIANGLES : slot.triangles;
    const clip = slot.clip;
    if (!clip) return { vertices, uvs: slot.uvs, triangles };
    let applies = clips.get(clip);
    if (applies === undefined) {
      applies = this.clipping && clip.polygon.length >= 6;
      clips.set(clip, applies);
      if (applies) this.clipCount++;
      else this.clipSkipCount++;
    }
    if (!applies) return { vertices, uvs: slot.uvs, triangles };
    const cut = clipThrough({ polygon: clip.polygon, inverse: clip.inverse, convex: clip.convex }, vertices, triangles, slot.uvs);
    if (cut === null) {
      // A polygon the core does not draw (self-crossing, collinear): counted
      // once as skipped, and the slot drawn unclipped as for a skipped clip.
      clips.set(clip, false);
      this.clipCount--;
      this.clipSkipCount++;
      return { vertices, uvs: slot.uvs, triangles };
    }
    return cut.clipped ? cut : { vertices, uvs: slot.uvs, triangles };
  }

  /** Fills `data` and `runs` for the GL path. */
  private buildVertices(order: PosedSlot[]): void {
    let dark = false;
    for (let i = 0; i < order.length && !dark; i++) dark = order[i].dark !== undefined;
    const stride: 8 | 11 = dark ? 11 : 8;
    this.stride = stride;
    const runs = this.runs;
    runs.length = 0;
    const clips = new Map<PosedClip, boolean>();
    const ratio = this.backingRatio;
    const left = this.left;
    const top = this.top;
    const blitter = getMeshGlBlitter();
    let vertex = 0;
    let run: FrameRun | null = null;
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      const page = this.pages.get(slot.page);
      if (!page) continue;
      const piece = this.piecesOf(slot, clips);
      if (!piece) continue;
      const { vertices, uvs, triangles } = piece;
      const count = triangles.length;
      if (count === 0) continue;
      if (!this.glPages.has(page) && blitter) {
        this.glPages.add(page);
        blitter.retain(page);
      }
      if (!run || run.page !== page || run.blend !== slot.blend) {
        if (run && run.blend !== slot.blend) this.blendFlushes++;
        run = { page, pma: slot.pma, blend: slot.blend, first: vertex, count: 0 };
        runs.push(run);
      }
      const need = (vertex + count) * stride;
      if (this.data.length < need) {
        const grown = new Float32Array(1 << Math.ceil(Math.log2(need)));
        grown.set(this.data.subarray(0, vertex * stride));
        this.data = grown;
      }
      const data = this.data;
      const [r, g, b, a] = slot.tint;
      const d = slot.dark;
      let f = vertex * stride;
      for (let t = 0; t < count; t++) {
        const vi = triangles[t] * 2;
        data[f++] = (vertices[vi] - left) * ratio;
        data[f++] = (-vertices[vi + 1] - top) * ratio;
        data[f++] = uvs[vi];
        data[f++] = uvs[vi + 1];
        data[f++] = r * a;
        data[f++] = g * a;
        data[f++] = b * a;
        data[f++] = a;
        if (stride === 11) {
          data[f++] = d ? d[0] * a : 0;
          data[f++] = d ? d[1] * a : 0;
          data[f++] = d ? d[2] * a : 0;
        }
      }
      vertex += count;
      run.count += count;
      this.trianglesDrawn += count / 3;
    }
    this.drawCalls = runs.length;
  }

  // --- the canvas2d fallback -----------------------------------------------

  private draw2d(order: PosedSlot[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const clips = new Map<PosedClip, boolean>();
    const ratio = this.backingRatio;
    const left = this.left;
    const top = this.top;
    const X = (x: number): number => (x - left) * ratio;
    const Y = (y: number): number => (-y - top) * ratio;
    let blend: BlendMode | null = null;
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      const image = this.pages.get(slot.page);
      if (!image) continue;
      const piece = this.piecesOf(slot, clips);
      if (!piece) continue;
      const source: PageSource = straightAlphaSource(image, slot.pma);
      const uw = source.width;
      const uh = source.height;
      if (slot.blend !== blend) {
        if (blend !== null) this.blendFlushes++;
        blend = slot.blend;
        ctx.globalCompositeOperation = COMPOSITE[blend];
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, slot.tint[3]));
      this.drawCalls++;
      const { vertices, uvs, triangles } = piece;
      if (slot.kind === 'region' && vertices === slot.corners) {
        // A whole quad: its page sub-rect under the affine that sends the UL,
        // UR and BL texel corners to their device corners (BL, UL, UR, BR).
        const c = vertices;
        const sx0 = uvs[2] * uw, sy0 = uvs[3] * uh; // UL
        const sx1 = uvs[4] * uw, sy1 = uvs[5] * uh; // UR
        const sx2 = uvs[0] * uw, sy2 = uvs[1] * uh; // BL
        const m = affine(sx0, sy0, sx1, sy1, sx2, sy2, X(c[2]), Y(c[3]), X(c[4]), Y(c[5]), X(c[0]), Y(c[1]));
        if (m) {
          const minU = Math.min(uvs[0], uvs[2], uvs[4], uvs[6]) * uw;
          const minV = Math.min(uvs[1], uvs[3], uvs[5], uvs[7]) * uh;
          const maxU = Math.max(uvs[0], uvs[2], uvs[4], uvs[6]) * uw;
          const maxV = Math.max(uvs[1], uvs[3], uvs[5], uvs[7]) * uh;
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          if (maxU > minU && maxV > minV) ctx.drawImage(source, minU, minV, maxU - minU, maxV - minV, minU, minV, maxU - minU, maxV - minV);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        this.trianglesDrawn += 2;
        continue;
      }
      for (let t = 0; t + 2 < triangles.length; t += 3) {
        const i0 = triangles[t] * 2;
        const i1 = triangles[t + 1] * 2;
        const i2 = triangles[t + 2] * 2;
        drawTexturedTriangle(
          ctx, source, 0.5,
          X(vertices[i0]), Y(vertices[i0 + 1]), uvs[i0] * uw, uvs[i0 + 1] * uh,
          X(vertices[i1]), Y(vertices[i1 + 1]), uvs[i1] * uw, uvs[i1 + 1] * uh,
          X(vertices[i2]), Y(vertices[i2 + 1]), uvs[i2] * uw, uvs[i2 + 1] * uh,
        );
      }
      this.trianglesDrawn += triangles.length / 3;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

/** The affine sending three source points to three destination points, as canvas `setTransform` arguments; null when degenerate. */
function affine(
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
): [number, number, number, number, number, number] | null {
  const eu1 = u1 - u0, ev1 = v1 - v0, eu2 = u2 - u0, ev2 = v2 - v0;
  const det = eu1 * ev2 - eu2 * ev1;
  if (det === 0) return null;
  const inv = 1 / det;
  const ex1 = x1 - x0, ey1 = y1 - y0, ex2 = x2 - x0, ey2 = y2 - y0;
  const a = (ev2 * ex1 - ev1 * ex2) * inv;
  const b = (ev2 * ey1 - ev1 * ey2) * inv;
  const c = (eu1 * ex2 - eu2 * ex1) * inv;
  const d = (eu1 * ey2 - eu2 * ey1) * inv;
  return [a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0];
}
