import { type CompiledDocument, type LiveTrack, openTrack, type RawPose, underNoSkin, underSkin } from 'rig-c/core';
import { DomRenderer, type MeshBackend } from './DomRenderer.js';
import type { ModelAssets, ReadDocument } from './loadModel.js';
import { type FrameSource, frameOf, frameSource, type PosedFrame } from './posedFrame.js';

/**
 * Plays a rig built by `rigc build` on a DOM root.
 *
 * The player owns the track and the renderer: `play` opens an animation on a
 * live track (`openTrack` from `rig-c/core`), each `frame(dt)` steps it by
 * `dt × timeScale`, turns the pose into a `PosedFrame` and hands that to its
 * `DomRenderer`. Everything the pose holds is computed by the core from the
 * compiled model document; this class schedules and draws.
 */

export interface RigPlayerOptions {
  /**
   * The skin to pose under. Absent is the runtime's "no skin set" — a fresh
   * skeleton whose `setSkin` was never called (`underNoSkin`): no skin's bones
   * or constraints applied, every slot resolved through the default skin.
   */
  skin?: string;
  /** The mesh tier's rasterizer (see `DomRenderer.meshBackend`). */
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
export class RigPlayer {
  /** The renderer this player draws through — its knobs and counters are the caller's to read and set. */
  readonly renderer: DomRenderer;
  /** Multiplies every step. 0 holds the pose (nothing is re-posed); negative is refused by the track. */
  timeScale = 1;
  /** The player's whole-rig colour, r g b a — multiplied into every slot's tint. Not a document value. */
  color: [number, number, number, number] = [1, 1, 1, 1];

  private readonly view: CompiledDocument;
  private readonly source: FrameSource;
  private readonly seekStep: number;
  private track: LiveTrack | null = null;
  private animation: string | null = null;
  private loop = true;
  private paused = false;
  private pose: RawPose | null = null;
  private readonly listeners = {
    event: new Set<Listener<RigEvent>>(),
    complete: new Set<Listener<{ animation: string }>>(),
  };

  constructor(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions = {}) {
    const read = assets.document as ReadDocument;
    this.view = options.skin === undefined ? underNoSkin(read.doc) : underSkin(read.doc, options.skin);
    this.source = frameSource(this.view, read.parsed);
    this.seekStep = options.seekStep ?? 1 / 60;
    if (!(this.seekStep > 0)) throw new Error(`seekStep must be a positive number of seconds, got ${String(options.seekStep)}`);
    this.renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
    if (options.meshBackend) this.renderer.meshBackend = options.meshBackend;
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
    this.track = openTrack(this.view, this.animation as string, { loop: this.loop, reset: 'animation' });
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
