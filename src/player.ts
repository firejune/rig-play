import { type CompiledDocument, eventsFired, type LiveTrack, type LiveTracks, type LocalAdjust as CoreLocalAdjust, openTrack, openTracks, poseRawSetup, type RawPose, type TrackEntryView, underNoSkin, underSkin } from 'rig-c/core';
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
  /** Which slots this player draws (`player.slots`); every slot when absent. */
  slots?: SlotFilter | null;
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
  /**
   * Stand the player on rig-c's live tracks from the first `play`, so the
   * first composing call — a mix, another track, a queue, a clear — never
   * replays. Without it a plain `play` runs on the single live track, and the
   * first composing call carries it over by replaying the time played in
   * `seekStep` increments (there is no hand-over of a live track's physics
   * state in the core), which on a stage that idled a while is one long
   * frame. Pick the single track for a rig whose animations key what the
   * tracks do not mix (constraints, sequences, the draw order, a path's
   * deform); pick the tracks for layering.
   */
  tracks?: boolean;
}

/** What `on('event', …)` hands a listener: one event key the step crossed. */
export interface RigEvent {
  name: string;
  /** The key's time in the animation. */
  time: number;
  int: number;
  float: number;
  string: string | null;
  /**
   * The track whose current entry fired it. The core's pose lists a step's
   * events in track order without naming the track, so the player attributes
   * them by counting what each track's current entry fires over the step;
   * when that count does not match the pose (an entry replaced inside the
   * step), the step's events carry no track rather than a guessed one.
   */
  track?: number;
}

/** What `on('complete', …)` hands a listener: the entry that completed, and its track. */
export interface RigComplete {
  animation: string;
  track: number;
}

/** How `play` starts an entry, and `queue` queues one. */
export interface PlayOptions {
  /** Loop; true by default. */
  loop?: boolean;
  /** The track; 0 by default. A base on 0, a layer over it on 1, a one-shot on 2. */
  track?: number;
  /** Seconds the entry this one replaces mixes out over; 0 (the default) cuts. */
  mix?: number;
  /**
   * The entry's weight, from 0 to 1 (1 by default), multiplied into every
   * timeline it applies — the same clip at 0.6 and at 0.85. Change it while
   * the entry plays with `setAlpha`. It does not touch events (fired at any
   * alpha, 0 included) or attachments (kept at any alpha).
   */
  alpha?: number;
  /**
   * The entry adds its keyed bone and deform values to what the tracks below
   * posed, rather than replacing them — a layer keying the same bone channels
   * as the base without covering its motion (false by default). Fixed when the
   * entry is set or queued. A rotation is added as it stands, with no
   * shortest-angle wrap; mixing out, an additive entry fades with its alpha
   * and is never held.
   */
  additive?: boolean;
}

export interface QueueOptions extends PlayOptions {
  /**
   * At or below 0 (the default 0): the entry starts when the one before it
   * completes, less this entry's `mix` — a one-shot then mixes into the next
   * over its last `mix` seconds. Above 0: that many seconds after the entry
   * before it starts.
   */
  delay?: number;
}

/** A track's current entry as the player reads it (`entry(track)`). */
export interface TrackEntry {
  /** What it plays; null for the empty animation a `clear` left. */
  animation: string | null;
  loop: boolean;
  /** The entry's own track time, from its start. */
  trackTime: number;
  /** The animation time it applies at now: the track time wrapped, or held at the duration. */
  animationTime: number;
  duration: number;
  /** The entry's weight as it stands (`PlayOptions.alpha`, `setAlpha`). */
  alpha: number;
  /** Whether the entry adds (`PlayOptions.additive`). */
  additive: boolean;
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

/**
 * Which slots a player draws: an allow list of slot names, or a predicate
 * over the name. The pose is the whole rig's whatever the filter — bones,
 * constraints, physics, `bone()` and `adjust` are untouched — and only the
 * draw is filtered. A clipping slot the filter leaves out does not clip.
 */
export type SlotFilter = readonly string[] | ((slot: string) => boolean);

/** A box in world units, Y up: `y` is the bottom edge. */
export interface PoseBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An allow list as a predicate. */
function predicateOf(names: readonly string[]): (slot: string) => boolean {
  const allowed = new Set(names);
  return (slot) => allowed.has(slot);
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
  /**
   * The single live track (`openTrack`): what a plain `play` on track 0 runs
   * on, as every 1.x player did — one animation, every construct the core
   * poses, `seek` and a skin change by reopening. Null once the player is
   * composed.
   */
  private track: LiveTrack | null = null;
  /**
   * The live tracks (`openTracks`): opened by the first composing call — a
   * `play` with a mix or on another track, a `queue`, a `clear` — from the
   * single track's animation stepped to its time. The mixing is the Spine
   * runtime's, which does not mix a constraint, sequence, draw-order or
   * path-deform timeline, so such an animation is refused here and plays on
   * the single track only.
   */
  private tracks: LiveTracks | null = null;
  /** Track 0's animation and loop as `play` last set them — what `seek` and a skin change reopen. */
  private animation: string | null = null;
  private loop = true;
  /** One past the highest track touched — how many `current(track)` reads a step takes. */
  private trackCount = 0;
  /** `RigPlayerOptions.tracks`: every play opens the live tracks, never the single track. */
  private readonly trackMode: boolean;
  /** Set once anything beyond a plain play on track 0 happened: a mix, another track, a queue, a clear. `seek` and `skin` then cannot replay and refuse. */
  private beyondBase = false;
  private paused = false;
  private pose: RawPose | null = null;
  private setup: RawPose | null = null;
  private adjustFn: BoneAdjust | null = null;
  private slotFilter: SlotFilter | null = null;
  /** `slotFilter` as a predicate; every slot when null. */
  private draws: (slot: string) => boolean = () => true;
  /** Handed to every track the player opens; reads the current `adjust` so setting it later needs no reopen. */
  private readonly adjustHook: CoreLocalAdjust = (locals) => {
    if (this.adjustFn !== null) this.adjustFn(locals);
  };
  private readonly listeners = {
    event: new Set<Listener<RigEvent>>(),
    complete: new Set<Listener<RigComplete>>(),
  };

  constructor(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions = {}) {
    const read = assets.document as ReadDocument;
    this.read = read;
    this.skinName = options.skin;
    this.view = options.skin === undefined ? underNoSkin(read.doc) : underSkin(read.doc, options.skin);
    this.source = frameSource(this.view, read.parsed);
    this.seekStep = options.seekStep ?? 1 / 60;
    this.trackMode = options.tracks === true;
    if (!(this.seekStep > 0)) throw new Error(`seekStep must be a positive number of seconds, got ${String(options.seekStep)}`);
    this.root = root;
    this.assets = assets;
    this.meshBackend = options.meshBackend;
    this.adjustFn = options.adjust ?? null;
    if (options.slots !== undefined && options.slots !== null) this.slots = options.slots;
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

  /** What track 0 plays, or null before `play` and after a `clear` of track 0 has mixed out. */
  get current(): string | null {
    return this.tracks !== null ? (this.tracks.current(0)?.animation ?? null) : this.animation;
  }

  /** The player's time — the running sum of the steps since `play` (or the last `seek`). */
  get time(): number {
    return this.tracks?.trackTime ?? this.track?.trackTime ?? 0;
  }

  /**
   * Plays `name` on a track — track 0 by default, which is what `play(name)`
   * has always meant: the first `play` opens the tracks at their first pose
   * with the physics reset there, and the pose is drawn on the next `frame`.
   * Later calls replace what the track plays: the entry it replaces mixes out
   * over `mix` seconds (0 cuts), and every entry queued on that track is
   * dropped. The pose the player holds is re-posed at once, so a held player
   * shows the change on its next `draw`. The mixing is the Spine runtime's,
   * which rig-c holds at tolerance 0; an animation keying what the tracks do
   * not mix — a constraint, a sequence, the draw order, a path's deform — is
   * refused here, by name, in the core's words.
   */
  play(name: string, options: PlayOptions = {}): void {
    const track = options.track ?? 0;
    const loop = options.loop ?? true;
    const mix = options.mix ?? 0;
    const alpha = options.alpha ?? 1;
    const additive = options.additive ?? false;
    this.paused = false;
    const plain = track === 0 && mix === 0 && alpha === 1 && !additive;
    if (!plain) this.beyondBase = true;
    if (this.tracks === null && plain && !this.trackMode) {
      // A plain play on track 0: the single live track, reopened at the
      // animation's first pose with the physics reset there.
      this.animation = name;
      this.loop = loop;
      this.track = openTrack(this.view, name, { loop, reset: 'animation', adjust: this.adjustHook });
      this.pose = this.track.first;
      return;
    }
    const tracks = this.compose();
    tracks.setAnimation(track, name, { loop, mixDuration: mix, alpha, additive });
    this.trackCount = Math.max(this.trackCount, track + 1);
    if (track === 0) {
      this.animation = name;
      this.loop = loop;
    }
    this.pose = tracks.step(0);
  }

  /**
   * Queues `name` after the last entry on `track` (`QueueOptions`): with
   * `delay` at or below 0 it starts when that entry completes less its own
   * `mix`, so a one-shot hands over to it across a mix; on an empty track it
   * is set. Before any `play`, the tracks are opened for it.
   */
  queue(name: string, options: QueueOptions = {}): void {
    const track = options.track ?? 0;
    this.beyondBase = true;
    const tracks = this.compose();
    tracks.addAnimation(track, name, { loop: options.loop ?? true, mixDuration: options.mix ?? 0, delay: options.delay ?? 0, alpha: options.alpha ?? 1, additive: options.additive ?? false });
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.pose = tracks.step(0);
  }

  /**
   * Mixes `track` out to nothing over `mix` seconds — the layer or one-shot
   * gone and the tracks below showing through. Track 0 cleared shows the
   * setup pose. The pose the player holds is re-posed at once.
   */
  clear(track = 0, options: { mix?: number } = {}): void {
    this.beyondBase = true;
    const tracks = this.compose();
    tracks.setEmptyAnimation(track, options.mix ?? 0);
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.pose = tracks.step(0);
  }

  /**
   * Queues a mix out to nothing after the last entry on `track`, over `mix`
   * seconds; with `delay` 0 (the default) the mix ends as that entry
   * completes, so a one-shot queued this way plays once and fades out over
   * its last `mix` seconds.
   */
  queueClear(track = 0, options: { mix?: number; delay?: number } = {}): void {
    this.beyondBase = true;
    const tracks = this.compose();
    tracks.addEmptyAnimation(track, options.mix ?? 0, options.delay ?? 0);
    this.trackCount = Math.max(this.trackCount, track + 1);
    this.pose = tracks.step(0);
  }

  /**
   * Sets the weight of `track`'s current entry, from 0 to 1, from the next pose
   * on — the pose the player holds is re-posed at once, so a held player shows
   * it on its next `draw`. An entry it is mixing from keeps its own weight. A
   * track playing nothing, or a weight outside 0..1, is refused in the core's
   * words. On the single track this composes: the player moves onto the tracks.
   */
  setAlpha(track: number, alpha: number): void {
    this.beyondBase = true;
    const tracks = this.compose();
    tracks.setAlpha(track, alpha);
    this.pose = tracks.step(0);
  }

  /** `track`'s current entry, or null where it plays nothing (and before `play`). */
  entry(track = 0): TrackEntry | null {
    if (this.tracks !== null) {
      const view = this.tracks.current(track);
      return view === null
        ? null
        : { animation: view.animation, loop: view.loop, trackTime: view.trackTime, animationTime: view.animationTime, duration: view.duration, alpha: view.alpha, additive: view.additive };
    }
    const single = this.track;
    if (track !== 0 || single === null) return null;
    return { animation: this.animation, loop: this.loop, trackTime: single.trackTime, animationTime: single.animationTime, duration: single.duration, alpha: 1, additive: false };
  }

  /** Whether the player is composed: on the live tracks rather than the single track. */
  get composed(): boolean {
    return this.tracks !== null;
  }

  /**
   * The live tracks, opened by the first composing call (or by the first
   * `play` under `tracks: true`). A single track in play is carried over by
   * replay: track 0 set to its animation, pose 0 taken by `start()` (the
   * player's — nothing steps before it) and the tracks stepped to the single
   * track's time in `seekStep` increments, so a physics rig's history
   * restarts there and nothing is fired on the way. The core offers no
   * hand-over of a live track's state, so that replay costs one pose per
   * `seekStep` of time played — which `tracks: true` avoids entirely.
   */
  private compose(): LiveTracks {
    if (this.tracks !== null) return this.tracks;
    const tracks = openTracks(this.view, { reset: 'animation', adjust: this.adjustHook });
    const single = this.track;
    const time = single?.trackTime ?? 0;
    if (single !== null && this.animation !== null) {
      tracks.setAnimation(0, this.animation, { loop: this.loop, mixDuration: 0 });
      this.trackCount = 1;
    }
    this.tracks = tracks;
    this.track = null;
    this.pose = tracks.start();
    if (time > 0) this.stepTo(time);
    return tracks;
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
   * Moves a single animation on track 0 to `time`: the tracks are reopened
   * with that animation and stepped forward in `seekStep` increments (the
   * last one shorter) until the time is reached. Events and completes crossed
   * on the way are not fired. It has a meaning for one animation on one
   * track only — the player cannot replay when a mix, a second track or a
   * queue was asked for — so after any of those it refuses by name; step the
   * player forward instead.
   */
  seek(time: number): void {
    if (this.animation === null) throw new Error('seek before play: no animation is open');
    if (!(time >= 0) || !Number.isFinite(time)) throw new Error(`seek time must be a finite time at or above 0, got ${String(time)}`);
    if (this.beyondBase) throw new Error('seek is defined for a single animation on track 0; after a mix, another track, a queue or a clear the player cannot replay to a time — step it forward with frame/advance instead');
    this.reopen();
    this.stepTo(time);
  }

  /** Whatever is open, opened again with track 0's animation as `play` last set it, at pose 0: the single track, or the tracks under `tracks: true`. */
  private reopen(): void {
    if (this.tracks !== null) {
      const tracks = openTracks(this.view, { reset: 'animation', adjust: this.adjustHook });
      tracks.setAnimation(0, this.animation as string, { loop: this.loop, mixDuration: 0 });
      this.trackCount = 1;
      this.tracks = tracks;
      this.pose = tracks.start();
      return;
    }
    this.track = openTrack(this.view, this.animation as string, { loop: this.loop, reset: 'animation', adjust: this.adjustHook });
    this.pose = this.track.first;
  }

  /** Steps whatever is open forward to `time` in `seekStep` increments, the last one shorter. */
  private stepTo(time: number): void {
    const stepper = this.tracks ?? (this.track as LiveTrack);
    const steps = Math.floor(time / this.seekStep);
    for (let i = 0; i < steps; i++) this.pose = stepper.step(this.seekStep);
    const rest = time - stepper.trackTime;
    if (rest > 0) this.pose = stepper.step(rest);
  }

  /** Adds a listener; returns a function that removes it. */
  on(type: 'event', listener: Listener<RigEvent>): () => void;
  on(type: 'complete', listener: Listener<RigComplete>): () => void;
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
    if (this.pose === null) return;
    const step = dt * this.timeScale;
    if (this.paused || !(step > 0)) return;
    const tracks = this.tracks;
    if (tracks !== null) {
      const before: Array<TrackEntryView | null> = [];
      for (let t = 0; t < this.trackCount; t++) before.push(tracks.current(t));
      this.pose = tracks.step(step);
      this.dispatch(this.pose, before, tracks);
      return;
    }
    const track = this.track;
    if (track === null) return;
    const before = track.trackTime;
    this.pose = track.step(step);
    this.dispatchSingle(this.pose, before, track);
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
    if (this.beyondBase) throw new Error('skin cannot change after a mix, another track, a queue or a clear: the player cannot replay those to the current time — set it before composing, or play again');
    const view = name === undefined ? underNoSkin(this.read.doc) : underSkin(this.read.doc, name);
    this.view = view;
    this.source = frameSource(view, this.read.parsed);
    this.skinName = name;
    this.setup = null;
    if (this.animation !== null && (this.track !== null || this.tracks !== null)) {
      const time = this.time;
      this.reopen();
      this.stepTo(time);
    }
  }

  /**
   * Which slots this player draws (`SlotFilter`), or null for every slot.
   * Settable on a live player: the next `draw` shows it, and `bounds()` reads
   * the drawn slots. An allow list naming a slot the document does not have
   * is refused by name. The pose is the whole rig's: `bone()`, `adjust`, the
   * events and the tracks see no filter.
   */
  get slots(): SlotFilter | null {
    return this.slotFilter;
  }

  set slots(filter: SlotFilter | null) {
    if (filter === null) {
      this.slotFilter = null;
      this.draws = () => true;
      return;
    }
    if (typeof filter === 'function') {
      this.slotFilter = filter;
      this.draws = filter;
      return;
    }
    if (!Array.isArray(filter)) throw new Error(`slots must be an array of slot names, a function, or null, got ${typeof filter}`);
    const known = new Set(this.read.doc.slots.map((slot) => slot.name));
    const unknown = filter.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`no slot named ${unknown.map((n) => JSON.stringify(n)).join(', ')} in this document (slots: ${[...known].join(', ')})`);
    }
    const allowed = new Set(filter);
    this.slotFilter = [...filter];
    this.draws = (slot) => allowed.has(slot);
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
    const stepper = this.tracks ?? this.track;
    if (stepper === null || this.pose === null) return;
    this.pose = stepper.step(0);
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
    const frame = this.pose === null ? frameOf(this.source, this.posed(), this.color, this.draws) : this.posedFrame();
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

  /**
   * The pose the player holds, as the frame record the renderer draws — under
   * this player's `slots` filter, or under `slots` given here instead (a
   * second renderer over the same assets drawing this player's pose on
   * another root: `other.render(player.posedFrame(['hand_f']))`, the one rig
   * posed once).
   */
  posedFrame(slots?: SlotFilter | null): PosedFrame {
    if (this.pose === null) return { order: [] };
    const draws = slots === undefined ? this.draws : slots === null ? () => true : typeof slots === 'function' ? slots : predicateOf(slots);
    return frameOf(this.source, this.pose, this.color, draws);
  }

  /** Removes the renderer's elements and hands its GPU pages back. The assets stay the caller's. */
  dispose(): void {
    this.renderer.dispose();
    this.tracks = null;
    this.track = null;
    this.pose = null;
  }

  /** The single track's step: its events (track 0) and its complete, as every 1.x player fired them. */
  private dispatchSingle(pose: RawPose, before: number, track: LiveTrack): void {
    if (this.listeners.event.size > 0) {
      for (const [name, time, int, float, string] of pose.events) {
        const event: RigEvent = { name, time, int, float, string, track: 0 };
        for (const listener of this.listeners.event) listener(event);
      }
    }
    if (this.listeners.complete.size > 0) {
      const d = track.duration;
      const after = track.trackTime;
      const cycles = d > 0 ? Math.floor(after / d) : Infinity;
      const was = d > 0 ? Math.floor(before / d) : -Infinity;
      if (this.loop ? cycles > 0 && cycles > was : before < d && after >= d) {
        const payload: RigComplete = { animation: this.animation as string, track: 0 };
        for (const listener of this.listeners.complete) listener(payload);
      }
    }
  }

  /**
   * The step's events, then its completes, each with its track. The core
   * fires a track's keys from its current entry (`pose.events`, in track
   * order and in the runtime's order across a wrap) — an entry mixing out
   * fires none — and leaves `complete` to the player, which derives it per
   * track from that track's current entry: on a looping entry, once on a step
   * whose whole cycles rose; on a held one, on the step that reaches its
   * duration. An entry replaced inside the step — by `play`, or by a queued
   * entry starting at its completion less the mix — is no longer current and
   * completes no more than it fires, which is the runtime's rule too.
   */
  private dispatch(pose: RawPose, before: ReadonlyArray<TrackEntryView | null>, tracks: LiveTracks): void {
    const after: Array<TrackEntryView | null> = [];
    for (let t = 0; t < this.trackCount; t++) after.push(tracks.current(t));
    const same = (b: TrackEntryView | null, a: TrackEntryView | null): boolean =>
      b !== null && a !== null && b.animation === a.animation && b.loop === a.loop && a.trackTime >= b.trackTime;

    if (this.listeners.event.size > 0 && pose.events.length > 0) {
      // Attribute by count: what each track's current entry fired over the step.
      const counts: number[] = [];
      let total = 0;
      for (let t = 0; t < this.trackCount; t++) {
        const a = after[t];
        const b = before[t];
        let n = 0;
        if (a !== null && a.animation !== null) {
          const keys = this.view.animations.find((anim) => anim.name === a.animation)?.timelines.events ?? [];
          if (keys.length > 0) {
            const last = same(b, a) ? (b as TrackEntryView).animationTime : -1;
            n = eventsFired(keys, last, a.animationTime, undefined, a.animationTime < last).length;
          }
        }
        counts.push(n);
        total += n;
      }
      const attributed = total === pose.events.length;
      let track = 0;
      let left = counts[0] ?? 0;
      for (const [name, time, int, float, string] of pose.events) {
        if (attributed) {
          while (left === 0 && track < counts.length - 1) {
            track++;
            left = counts[track];
          }
          left--;
        }
        const event: RigEvent = attributed ? { name, time, int, float, string, track } : { name, time, int, float, string };
        for (const listener of this.listeners.event) listener(event);
      }
    }
    if (this.listeners.complete.size > 0) {
      for (let t = 0; t < this.trackCount; t++) {
        const a = after[t];
        const b = before[t];
        if (!same(b, a) || a === null || a.animation === null) continue;
        const d = a.duration;
        const cycles = d > 0 ? Math.floor(a.trackTime / d) : Infinity;
        const was = d > 0 ? Math.floor((b as TrackEntryView).trackTime / d) : -Infinity;
        const fired = a.loop ? cycles > 0 && cycles > was : (b as TrackEntryView).trackTime < d && a.trackTime >= d;
        if (!fired) continue;
        const payload: RigComplete = { animation: a.animation, track: t };
        for (const listener of this.listeners.complete) listener(payload);
      }
    }
  }
}
