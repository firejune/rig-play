import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Physics,
  RegionAttachment,
  Skeleton,
  SkeletonJson,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import { drawnRegions, openTrack, regionPageUvs, type RawPose, readModel, underNoSkin } from 'rig-c/core';

import { clipCover, frameOf, frameSource } from '../src/posedFrame';
import type { PosedFrame, PosedSlot } from '../src/posedFrame';
import { frameOfSkeleton } from './skeletonFrame';

/**
 * The frame gate's two walks, bundled for node by `tests/frames.spec.ts`
 * (rig-c's `./core` is TypeScript source, which node does not load from
 * `node_modules`; the spec builds this module with vite into a temp directory
 * and imports the bundle).
 *
 * One gallery build, one animation, both pairs of files the build wrote:
 *
 * - **the Spine pair** (`skeleton.json` + `skeleton.atlas`) posed by
 *   spine-core 4.3 on rigc's own render recipe — `setAnimation(0, name, true)`,
 *   `setupPose()`, pose 0 `apply` / `update(0)` /
 *   `updateWorldTransform(Physics.reset)`, then per step `update(dt)`,
 *   `apply`, `Skeleton.update(dt)`, `updateWorldTransform(Physics.update)` —
 *   and read into a frame by `tests/skeletonFrame.ts`;
 * - **the model pair** (`skeleton.model.json` + its `pages`) posed by
 *   `rig-c/core`'s `openTrack` (looping, reset at the animation) and read into
 *   a frame by the package's own adapter, `frameOf`.
 *
 * Then every field of every slot of every frame is compared with `===`: no
 * tolerance, no rounding. (`===` and not `Object.is` for one reason, counted
 * separately so it is visible: the core writes a computed −0 as 0 — rig-c's
 * `rawNumber` — and spine-core does not, and the two are the same number to
 * every reader of the frame.)
 */

export interface GateFiles {
  model: string;
  skeleton: string;
  atlas: string;
}

export interface GateRow {
  animation: string;
  duration: number;
  frames: number;
  slots: number;
  regions: number;
  meshes: number;
  /** Numbers compared: corners, vertices, UVs, tints, clip polygons, region page UVs. */
  values: number;
  /** Comparisons that held only because `===` reads −0 and 0 as one number. */
  signedZeros: number;
  clipped: number;
  mismatches: string[];
}

class Compare {
  values = 0;
  signedZeros = 0;
  readonly mismatches: string[] = [];

  constructor(private readonly where: () => string) {}

  fail(what: string): void {
    if (this.mismatches.length < 12) this.mismatches.push(`${this.where()}: ${what}`);
  }

  same(a: unknown, b: unknown, what: string): void {
    if (a !== b) this.fail(`${what}: spine ${JSON.stringify(a)} ≠ model ${JSON.stringify(b)}`);
  }

  numbers(a: ArrayLike<number>, b: ArrayLike<number>, what: string): void {
    if (a.length !== b.length) {
      this.fail(`${what}: ${a.length} values on the spine side, ${b.length} on the model side`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      this.values++;
      if (a[i] !== b[i]) {
        this.fail(`${what}[${i}]: spine ${a[i]} ≠ model ${b[i]} (Δ ${a[i] - b[i]})`);
        return;
      } else if (!Object.is(a[i], b[i])) {
        this.signedZeros++;
      }
    }
  }
}

function compareSlot(c: Compare, a: PosedSlot, b: PosedSlot): void {
  c.same(a.slot, b.slot, 'slot');
  c.same(a.z, b.z, 'z');
  c.same(a.kind, b.kind, 'kind');
  c.same(a.blend, b.blend, 'blend');
  c.numbers(a.tint, b.tint, 'tint');
  c.same(a.dark === undefined, b.dark === undefined, 'has dark');
  if (a.dark && b.dark) c.numbers(a.dark, b.dark, 'dark');
  c.same(a.clip === undefined, b.clip === undefined, 'clipped');
  if (a.clip && b.clip) {
    c.same(a.clip.inverse, b.clip.inverse, 'clip inverse');
    c.same(a.clip.convex, b.clip.convex, 'clip convex');
    c.numbers(a.clip.polygon, b.clip.polygon, 'clip polygon');
  }
  if (a.kind === 'region' && b.kind === 'region') {
    c.same(a.region, b.region, 'region');
    c.numbers(a.corners, b.corners, 'corners');
    c.same(a.page, b.page, 'page');
    c.same(a.pma, b.pma, 'pma');
    c.numbers(a.uvs, b.uvs, 'region uvs');
  } else if (a.kind === 'mesh' && b.kind === 'mesh') {
    c.same(a.page, b.page, 'page');
    c.same(a.pma, b.pma, 'pma');
    c.same(a.sequence, b.sequence, 'sequence');
    c.numbers(a.vertices, b.vertices, 'vertices');
    c.numbers(a.uvs, b.uvs, 'uvs');
    c.numbers(a.triangles, b.triangles, 'triangles');
  }
}

function compareFrames(c: Compare, a: PosedFrame, b: PosedFrame): void {
  const an = a.order.map((s) => s.slot).join(',');
  const bn = b.order.map((s) => s.slot).join(',');
  if (an !== bn) {
    c.fail(`draw order: spine [${an}] ≠ model [${bn}]`);
    return;
  }
  for (let i = 0; i < a.order.length; i++) compareSlot(c, a.order[i], b.order[i]);
  // Clip identity: the slots one clip covers share one object on both sides.
  const groups = (f: PosedFrame) => f.order.map((s) => (s.clip ? f.order.findIndex((t) => t.clip === s.clip) : -1)).join(',');
  c.same(groups(a), groups(b), 'clip grouping');
}

/** The region page UVs the rigid tier's cut stands for: spine-core's sequence UVs against rig-c's `regionPageUvs`. */
function compareRegionUvs(c: Compare, skeleton: Skeleton, pose: RawPose, source: ReturnType<typeof frameSource>): void {
  const { drawn } = drawnRegions(source.doc, pose.shown, pose.drawOrder, source.uv);
  const bySlot = new Map((drawn ?? []).map((d) => [d.slot, d]));
  for (const slot of skeleton.drawOrder.appliedPose) {
    const attachment = slot.appliedPose.attachment;
    if (!(attachment instanceof RegionAttachment) || !slot.bone.active) continue;
    const found = bySlot.get(slot.data.name);
    if (!found || found.art !== null) {
      c.fail(`slot "${slot.data.name}": no region resolved on the model side`);
      continue;
    }
    const index = attachment.sequence.resolveIndex(slot.appliedPose);
    c.numbers(attachment.sequence.getUVs(index), regionPageUvs(found.found.region, found.found.page), `region uvs "${slot.data.name}"`);
  }
}

export function gateAnimations(files: GateFiles): string[] {
  return readModel(files.model).animations.map((a) => a.name);
}

/**
 * One animation of one build, walked `dt` at a time on both sides for
 * `steps` steps after pose 0.
 */
export function gateAnimation(files: GateFiles, animation: string, dt: number, steps: (duration: number) => number): GateRow {
  // --- the model pair
  const doc = underNoSkin(readModel(files.model));
  const source = frameSource(doc, JSON.parse(files.model));
  const track = openTrack(doc, animation, { loop: true, reset: 'animation' });

  // --- the Spine pair
  const atlas = new TextureAtlas(files.atlas);
  const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(files.skeleton);
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, animation, true);
  skeleton.setupPose();

  let frame = 0;
  const c = new Compare(() => `${animation} frame ${frame}`);
  const row: GateRow = {
    animation,
    duration: track.duration,
    frames: 0,
    slots: 0,
    regions: 0,
    meshes: 0,
    values: 0,
    signedZeros: 0,
    clipped: 0,
    mismatches: c.mismatches,
  };
  const total = steps(track.duration);
  for (frame = 0; frame <= total; frame++) {
    let pose: RawPose;
    if (frame === 0) {
      pose = track.first;
      state.apply(skeleton);
      skeleton.update(0);
      skeleton.updateWorldTransform(Physics.reset);
    } else {
      pose = track.step(dt);
      state.update(dt);
      state.apply(skeleton);
      skeleton.update(dt);
      skeleton.updateWorldTransform(Physics.update);
    }
    const spine = frameOfSkeleton(skeleton).frame;
    const model = frameOf(source, pose);
    compareFrames(c, spine, model);
    compareRegionUvs(c, skeleton, pose, source);
    row.frames++;
    row.slots += spine.order.length;
    for (const s of spine.order) {
      if (s.kind === 'region') row.regions++;
      else row.meshes++;
      if (s.clip) row.clipped++;
    }
  }
  row.values = c.values;
  row.signedZeros = c.signedZeros;
  return row;
}

/**
 * The adapter's clip cover on hand-made poses — the one part of the frame no
 * gallery build exercises (none of them clips). Each case is a draw order of
 * slots, some showing a clipping attachment; the answer is which slots each
 * clip covers, as indices of the clip's own slot.
 */
export function coverCases(): Record<string, Record<string, string>> {
  type Step = string | { clip: string; end: string | null; inverse?: boolean; inactive?: boolean };
  const run = (steps: Step[]): Record<string, string> => {
    const drawOrder = steps.map((s) => (typeof s === 'string' ? s : s.clip));
    const clips: RawPose['clips'] = [];
    const shown: RawPose['shown'] = [];
    const active = new Set<string>();
    for (const s of steps) {
      if (typeof s === 'string') {
        active.add(`${s}-bone`);
        shown.push({ slot: s, bone: `${s}-bone`, name: s, placeholder: s, skin: 'default', geometry: { kind: 'region' } } as unknown as RawPose['shown'][number]);
      } else {
        if (!s.inactive) active.add(`${s.clip}-bone`);
        clips.push([s.clip, s.clip, s.end, [0, 0, 1, 0, 0, 1]]);
        shown.push({ slot: s.clip, bone: `${s.clip}-bone`, name: s.clip, placeholder: s.clip, skin: 'default', geometry: { kind: 'clipping', inverse: s.inverse === true, convex: true } } as unknown as RawPose['shown'][number]);
      }
    }
    const cover = clipCover({ clips, shown, drawOrder }, active);
    const owner = new Map(clips.map((c) => [c[3], c[0]]));
    const out: Record<string, string> = {};
    for (const [slot, clip] of cover) out[slot] = owner.get(clip.polygon) ?? '?';
    return out;
  };
  return {
    // A range: the slots after the clip through its end slot, inclusive.
    range: run(['a', { clip: 'c', end: 'e' }, 'b', 'e', 'f']),
    // A second clip met while one is in force is ignored, not nested.
    nested: run([{ clip: 'c1', end: null }, 'a', { clip: 'c2', end: 'b' }, 'b', 'd']),
    // An end slot that is the clip's own slot never ends it.
    ownSlot: run(['a', { clip: 'c', end: 'c' }, 'b', 'd']),
    // An end slot already passed never ends it either.
    passedEnd: run(['a', { clip: 'c', end: 'a' }, 'b', 'd']),
    // A clip on an inactive bone starts nothing.
    inactive: run([{ clip: 'c', end: null, inactive: true }, 'a', 'b']),
    // A clip slot that is the end slot of the clip in force ends it before starting its own.
    chained: run([{ clip: 'c1', end: 'c2' }, 'a', { clip: 'c2', end: null }, 'b']),
    // The polygon object is shared: a later clip starts once the first one ended.
    sequential: run([{ clip: 'c1', end: 'a' }, 'a', { clip: 'c2', end: 'b' }, 'b', 'd']),
  };
}
