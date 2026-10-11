import { type CompiledDocument, type LiveTrack, type LocalAdjust as CoreLocalAdjust, openTrack, poseRawSetup, type RawPose, underNoSkin, underSkin } from 'rig-c/core';
import { CanvasRenderer } from './CanvasRenderer.js';
import { DomRenderer, type MeshBackend } from './DomRenderer.js';
import type { ModelAssets, ReadDocument } from './loadModel.js';
import { type FrameSource, frameOf, frameSource, type PosedFrame } from './posedFrame.js';

/**
 * Plays a rig built by `rigc build` on a DOM root.
 *
 * The player owns the track and the renderer: `play` opens an animation on a
 * live track (`openTrack` from `rig-c/core`), each `frame(dt)` steps it by
 * `dt × timeScale`, turns the pose into a `PosedFrame` and hands that to its
 * renderer — a `DomRenderer` (`mode: 'dom'`, the default) or a
 * `CanvasRenderer` (`mode: 'canvas'`). Everything the pose holds is computed by
 * the core from the compiled model document; this class schedules and draws.
 */

/**
 * How a player draws: `'dom'` — elements, the rigid tier as `<img>` and the
 * mesh tier on per-part canvases (`DomRenderer`); `'canvas'` — the whole frame
 * into one `<canvas>` through the shared WebGL context (`CanvasRenderer`).
 */
export type RenderMode = 'dom' | 'canvas';

export interface RigPlayerOptions {
  /**
   * The skin to pose under. Absent is the runtime's "no skin set" — a fresh
   * skeleton whose `setSkin` was never called (`underNoSkin`): no skin's bones
   * or constraints applied, every slot resolved through the default skin.
   */
  skin?: string;
  /** The per-pose adjustment of bone locals (`player.adjust`), set from the first pose. */
  adjust?: BoneAdjust | null;
  /** How the player draws (see `RenderMode`). Default `'dom'`. Can be changed later through `mode`. */
  mode?: RenderMode;
  /** The mesh tier's rasterizer (see `DomRenderer.meshBackend`) — the DOM mode only. */
  meshBackend?: MeshBackend;
  /**
   * The step `seek` walks the track forward with, in seconds. A seek is
   * "reopen, then step to the time", never a jump: a physics rig has history,
   * and the pose at a time depends on the steps taken to reach it.
   */
  seekStep?: number;
}

/** What `on('event', …)` hands a listener: one event key the step crossed. */
export interface RigEvent {
  name: string;
  /** The key's time in the animation. */
  time: number;
  int: number;
  float: number;
  string: string | null;
}

type Listener<T> = (payload: T) => void;

/**
 * One rig on one root.
 *
 * ```ts
 * const player = new RigPlayer(root, assets);
 * player.play('walk');
 * requestAnimationFrame(function tick(now) { player.frame(dt); requestAnimationFrame(tick); });
 * ```
 */
/**
 * One bone's local values at a pose, read and written in place: the seven
 * channels the runtime's bone has, in its units (degrees, world-unit
 * translation, scale factors, shear in degrees). What `BoneAdjust` receives
 * through `AdjustableBones.bone`.
 */
export interface BoneLocals {
  rotation: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

/** The bones of one pose, by name, as a `BoneAdjust` sees them. */
export interface AdjustableBones {
  /** The document's bones, in its order. */
  readonly names: readonly string[];
  /** One bone's locals, read and written in place; a name the document has no bone for is refused by name. */
  bone(name: string): BoneLocals;
}

/**
 * A caller's adjustment of a pose's bone locals — a breath's scale, a look's
 * rotation, a mouth's `scaleY` — called once per pose after the animation's
 * timelines and before the world transforms, constraints and physics (the
 * core's `openTrack({ adjust })`, held to the Spine runtime at tolerance 0
 * by rig-c). **A write lasts one pose**: the core poses every step from the
 * setup pose, so a value the caller wants held is written again each pose,
 * and nothing compounds. A non-finite value, an unknown bone, or an error the
 * function throws refuses that step in the core's words.
 */
export type BoneAdjust = (bones: AdjustableBones) => void;

/**
 * Where a bone is in the pose the player holds — world units, Y up, the
 * numbers `rig-c/core` posed (`RawBone`): the world matrix `a b c d`, the
 * world position, the world rotation of each axis in degrees and the world
 * scale of each, and whether the bone is active under the player's skin.
 */
export interface BoneWorld {
  name: string;
  active: boolean;
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d: number;
  rotationX: number;
  rotationY: number;
  scaleX: number;
  scaleY: number;
}

/** A box in world units, Y up: `y` is the bottom edge. */
export interface PoseBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class RigPlayer {
  /**
   * The renderer this player draws through — its knobs and counters are the
   * caller's to read and set. A `DomRenderer` in the DOM mode, a
   * `CanvasRenderer` in the canvas mode; a new object after `mode` changes.
   */
  get renderer(): DomRenderer | CanvasRenderer {
    return this.active;
  }
  /** Multiplies every step. 0 holds the pose (nothing is re-posed); negative is refused by the track. */
  timeScale = 1;
  /** The player's whole-rig colour, r g b a — multiplied into every slot's tint. Not a document value. */
  color: [number, number, number, number] = [1, 1, 1, 1];

  private active: DomRenderer | CanvasRenderer;
  private readonly root: HTMLElement;
  private readonly assets: ModelAssets;
  private readonly meshBackend: MeshBackend | undefined;
  private view: CompiledDocument;
  private source: FrameSource;
  private readonly read: ReadDocument;
  private skinName: string | undefined;
  private readonly seekStep: number;
  private track: LiveTrack | null = null;
  private animation: string | null = null;
  private loop = true;
  private paused = false;
  private pose: RawPose | null = null;
  private setup: RawPose | null = null;
  private adjustFn: BoneAdjust | null = null;
  /** Handed to every track the player opens; reads the current `adjust` so setting it later needs no reopen. */
  private readonly adjustHook: CoreLocalAdjust = (locals) => {
    if (this.adjustFn !== null) this.adjustFn(locals);
  };
  private readonly listeners = {
    event: new Set<Listener<RigEvent>>(),
    complete: new Set<Listener<{ animation: string }>>(),
  };

  constructor(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions = {}) {
    const read = assets.document as ReadDocument;
    this.read = read;
    this.skinName = options.skin;
    this.view = options.skin === undefined ? underNoSkin(read.doc) : underSkin(read.doc, options.skin);
    this.source = frameSource(this.view, read.parsed);
    this.seekStep = options.seekStep ?? 1 / 60;
    if (!(this.seekStep > 0)) throw new Error(`seekStep must be a positive number of seconds, got ${String(options.seekStep)}`);
    this.root = root;
    this.assets = assets;
    this.meshBackend = options.meshBackend;
    this.adjustFn = options.adjust ?? null;
    this.active = this.create(options.mode ?? 'dom');
  }

  /**
   * How the player draws. Setting it swaps the renderer without reloading
   * anything: the old one is disposed (its elements removed, its GPU pages
   * handed back), the new one is created over the same root and the same
   * assets, `pixelRatio` and `clipping` carry over, and the pose the player
   * holds is drawn again at once.
   */
  get mode(): RenderMode {
    return this.active instanceof CanvasRenderer ? 'canvas' : 'dom';
  }

  set mode(mode: RenderMode) {
    if (mode !== 'dom' && mode !== 'canvas') throw new Error(`mode must be 'dom' or 'canvas', got ${String(mode)}`);
    if (mode === this.mode) return;
    const old = this.active;
    const next = this.create(mode);
    next.pixelRatio = old.pixelRatio;
    next.clipping = old.clipping;
    old.dispose();
    this.active = next;
    this.draw();
  }

  private create(mode: RenderMode): DomRenderer | CanvasRenderer {
    if (mode === 'canvas') {
      const renderer = new CanvasRenderer(this.root, this.assets.pageImages);
      // The rig's own framing, so the canvas starts at the size the setup pose
      // needs rather than growing into it frame by frame.
      if (this.assets.stage) renderer.reserve(this.assets.stage);
      return renderer;
    }
    if (mode !== 'dom') throw new Error(`mode must be 'dom' or 'canvas', got ${String(mode)}`);
    if (this.assets.regions === 'none') {
      throw new Error(
        "these assets were loaded with regions: 'none' (no region bitmaps, for the canvas mode only); the DOM mode needs a load with regions 'blob' or 'data'",
      );
    }
    const renderer = new DomRenderer(this.root, this.assets.regionImages, this.assets.pageImages);
    if (this.meshBackend) renderer.meshBackend = this.meshBackend;
    return renderer;
  }

  /** The animation the track is playing, or null before `play`. */
  get current(): string | null {
    return this.animation;
  }

  /** The track time — the running sum of the steps since `play` (or the last `seek`). */
  get time(): number {
    return this.track?.trackTime ?? 0;
  }

  /**
   * Opens `name` on the track at its first pose, the physics reset there. The
   * pose is drawn on the next `frame`.
   */
  play(name: string, options: { loop?: boolean } = {}): void {
    this.loop = options.loop ?? true;
    this.animation = name;
    this.paused = false;
    this.open();
  }

  /** Stops stepping; `frame` keeps drawing the pose it holds. */
  pause(): void {
    this.paused = true;
  }

  /** Resumes stepping after `pause`. */
  resume(): void {
    this.paused = false;
  }

  /**
   * Moves the track to `time`: the animation is reopened and stepped forward
   * in `seekStep` increments (the last one shorter) until the track time
   * reaches `time`. Events and completes crossed on the way are not fired.
   */
  seek(time: number): void {
    if (this.animation === null) throw new Error('seek before play: no animation is open');
    if (!(time >= 0) || !Number.isFinite(time)) throw new Error(`seek time must be a finite time at or above 0, got ${String(time)}`);
    this.open();
    this.stepTo(time);
  }

  /** Steps the freshly opened track forward to `time` in `seekStep` increments, the last one shorter. */
  private stepTo(time: number): void {
    const track = this.track as LiveTrack;
    const steps = Math.floor(time / this.seekStep);
    for (let i = 0; i < steps; i++) this.pose = track.step(this.seekStep);
    const rest = time - track.trackTime;
    if (rest > 0) this.pose = track.step(rest);
  }

  /** Adds a listener; returns a function that removes it. */
  on(type: 'event', listener: Listener<RigEvent>): () => void;
  on(type: 'complete', listener: Listener<{ animation: string }>): () => void;
  on(type: 'event' | 'complete', listener: Listener<never>): () => void {
    const set = this.listeners[type] as Set<Listener<never>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Advances the track by `dt × timeScale` seconds and draws the pose —
   * `advance(dt)` then `draw()`.
   */
  frame(dt: number): void {
    this.advance(dt);
    this.draw();
  }

  /**
   * Steps the track by `dt × timeScale` seconds and fires the step's listeners,
   * without drawing. A paused player, or a step of zero, keeps the pose it
   * holds without re-posing it, so a held rig costs the renderer's dirty
   * checks and nothing else.
   */
  advance(dt: number): void {
    const track = this.track;
    if (track === null || this.pose === null) return;
    const step = dt * this.timeScale;
    if (this.paused || !(step > 0)) return;
    const before = track.trackTime;
    this.pose = track.step(step);
    this.dispatch(this.pose, before, track);
  }

  /** Draws the pose the player holds. */
  draw(): void {
    if (this.pose === null) return;
    this.renderer.render(this.posedFrame());
  }

  /**
   * The skin the rig is posed under — `RigPlayerOptions.skin`, or undefined
   * for no skin set. Setting it re-resolves the pose under the new skin
   * (which attachment each slot shows, which bones and constraints are
   * active) and keeps the animation, its loop and its track time: the track
   * is reopened under the new skin and stepped to the same time the way
   * `seek` does, so a physics rig's history restarts there and nothing is
   * fired on the way. The pose is drawn on the next `draw`/`frame`. An
   * unknown skin is refused by name, and the player is left as it was.
   */
  get skin(): string | undefined {
    return this.skinName;
  }

  set skin(name: string | undefined) {
    if (name === this.skinName) return;
    const view = name === undefined ? underNoSkin(this.read.doc) : underSkin(this.read.doc, name);
    this.view = view;
    this.source = frameSource(view, this.read.parsed);
    this.skinName = name;
    this.setup = null;
    if (this.animation !== null && this.track !== null) {
      const time = this.track.trackTime;
      this.open();
      this.stepTo(time);
    }
  }

  /**
   * The per-pose adjustment of bone locals (`BoneAdjust`), or null for none.
   * It is applied by every track the player opens — `play`, the reopen inside
   * `seek` — and by the pose drawn again after `mode` changes, on every pose
   * the animation is applied to, the first one included. Setting it re-poses
   * the pose the player holds at once (`repose`), so a held or paused player
   * shows the change on its next `draw` without a step.
   */
  get adjust(): BoneAdjust | null {
    return this.adjustFn;
  }

  set adjust(fn: BoneAdjust | null) {
    if (fn !== null && typeof fn !== 'function') throw new Error(`adjust must be a function or null, got ${typeof fn}`);
    this.adjustFn = fn;
    this.repose();
  }

  /**
   * Poses the held pose again at the same track time, through the current
   * `adjust`, without stepping, firing or drawing. A paused player and a zero
   * step re-pose nothing, so a caller whose adjustment reads its own state
   * (a mouth driven while the body is held) calls this when that state
   * changed, then `draw`. Nothing before `play`.
   */
  repose(): void {
    if (this.track === null || this.pose === null) return;
    this.pose = this.track.step(0);
  }

  /**
   * Where `name` is in the pose the player holds — the pose of the last
   * `advance`/`frame`/`seek`, or the setup pose before `play`. Read off the
   * core's pose, so it is the same in `dom` and `canvas` mode and costs nothing
   * until called. An unknown bone is refused by name.
   */
  bone(name: string): BoneWorld {
    const pose = this.posed();
    for (const bone of pose.bones) {
      if (bone.name !== name) continue;
      return {
        name,
        active: bone.active,
        x: bone.worldX,
        y: bone.worldY,
        a: bone.a,
        b: bone.b,
        c: bone.c,
        d: bone.d,
        rotationX: bone.rotationX,
        rotationY: bone.rotationY,
        scaleX: bone.scaleX,
        scaleY: bone.scaleY,
      };
    }
    throw new Error(`no bone named ${JSON.stringify(name)} in this document (bones: ${pose.bones.map((b) => b.name).join(', ')})`);
  }

  /**
   * The box of what the pose the player holds draws, in world units, Y up:
   * every region's four corners and every mesh's vertices, in the same frame
   * record the renderer takes (`posedFrame`). A slot under a clip counts only
   * inside the clip polygon's own box (an inverse clip removes nothing from
   * the count); bounding boxes, paths and points are not drawn and do not
   * count. `null` when nothing draws. The same numbers in `dom` and `canvas`
   * mode; nothing is computed until called.
   */
  bounds(): PoseBounds | null {
    const frame = this.pose === null ? frameOf(this.source, this.posed(), this.color) : this.posedFrame();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of frame.order) {
      const points = slot.kind === 'region' ? slot.corners : slot.vertices;
      let lo = -Infinity, lb = -Infinity, hi = Infinity, hb = Infinity;
      if (slot.clip && !slot.clip.inverse) {
        const c = slot.clip.polygon;
        lo = Infinity; lb = Infinity; hi = -Infinity; hb = -Infinity;
        for (let i = 0; i < c.length; i += 2) {
          if (c[i] < lo) lo = c[i];
          if (c[i] > hi) hi = c[i];
          if (c[i + 1] < lb) lb = c[i + 1];
          if (c[i + 1] > hb) hb = c[i + 1];
        }
      }
      for (let i = 0; i < points.length; i += 2) {
        const x = Math.min(Math.max(points[i], lo), hi);
        const y = Math.min(Math.max(points[i + 1], lb), hb);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** The pose the reads above see: the track's, or the setup pose before `play` (posed once). */
  private posed(): RawPose {
    if (this.pose !== null) return this.pose;
    if (this.setup === null) this.setup = poseRawSetup(this.view);
    return this.setup;
  }

  /** The pose the player holds, as the frame record the renderer draws. */
  posedFrame(): PosedFrame {
    if (this.pose === null) return { order: [] };
    return frameOf(this.source, this.pose, this.color);
  }

  /** Removes the renderer's elements and hands its GPU pages back. The assets stay the caller's. */
  dispose(): void {
    this.renderer.dispose();
    this.track = null;
    this.pose = null;
  }

  private open(): void {
    this.track = openTrack(this.view, this.animation as string, { loop: this.loop, reset: 'animation', adjust: this.adjustHook });
    this.pose = this.track.first;
  }

  /**
   * The step's events, then its complete. The core fires the keys
   * (`pose.events`, in the runtime's order across a wrap) and leaves
   * `complete` to the player, which derives it from the track time and the
   * duration: on a looping track, once on a step whose whole cycles rose past
   * 0 (rig-c `src/core/track.ts`, *Across the wrap*); on a held one, on the
   * step that reaches the duration. The runtime queues a looping complete
   * between the keys before the wrap and the keys after it; this player
   * dispatches it after all of the step's keys.
   */
  private dispatch(pose: RawPose, before: number, track: LiveTrack): void {
    if (this.listeners.event.size > 0) {
      for (const [name, time, int, float, string] of pose.events) {
        const event: RigEvent = { name, time, int, float, string };
        for (const listener of this.listeners.event) listener(event);
      }
    }
    if (this.listeners.complete.size > 0) {
      const d = track.duration;
      const after = track.trackTime;
      const cycles = d > 0 ? Math.floor(after / d) : Infinity;
      const was = d > 0 ? Math.floor(before / d) : -Infinity;
      if (this.loop ? cycles > 0 && cycles > was : before < d && after >= d) {
        const payload = { animation: this.animation as string };
        for (const listener of this.listeners.complete) listener(payload);
      }
    }
  }
}
