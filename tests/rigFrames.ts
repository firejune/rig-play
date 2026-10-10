import { openTrack, type RawPose, underNoSkin } from 'rig-c/core';

import { loadModel, type LoadModelOptions, type ModelAssets } from '../src/loadModel';
import type { ReadDocument } from '../src/loadModel';
import { type FrameSource, frameOf, frameSource, type PosedFrame } from '../src/posedFrame';

/**
 * Frames of the repository's rigs for the renderer probes.
 *
 * The renderer is handed a `PosedFrame` and nothing else, so a probe that
 * tests the renderer needs frames — and these are the package's own: a rig
 * built by `rigc build` (`public/rigs/<name>/`, scripts/fetch-assets.sh),
 * loaded by `loadModel`, posed by `rig-c/core`'s live track and read by the
 * package's adapter (`frameOf`), exactly as `RigPlayer` does. The only thing
 * this adds is the pose itself, which a player keeps private and a probe
 * sometimes needs (which clips the pose shows, a region's drawn vertices).
 */

export function rigUrl(name: string): string {
  return `/rigs/${name}/skeleton.model.json`;
}

/** `loadModel` over one of the built rigs. */
export function loadRig(name: string, options: Omit<LoadModelOptions, 'modelUrl'> = {}): Promise<ModelAssets> {
  return loadModel({ modelUrl: rigUrl(name), ...options });
}

/**
 * One frame source per loaded document, as a player keeps one: a mesh's `uvs`
 * and `triangles` are then the same arrays in every frame of that document,
 * which is what the renderer's dirty signature compares by identity.
 */
const sources = new WeakMap<object, FrameSource>();

function sourceOf(assets: ModelAssets): FrameSource {
  const read = assets.document as ReadDocument;
  let source = sources.get(read);
  if (!source) {
    source = frameSource(underNoSkin(read.doc), read.parsed);
    sources.set(read, source);
  }
  return source;
}

export interface PosedMoment {
  pose: RawPose;
  frame: PosedFrame;
}

/**
 * The pose of `animation` at `time`, and its frame — the walk `RigPlayer.seek`
 * takes (reopen, then step forward in `step` increments, the last one
 * shorter), so a probe's frame is the frame a player seeked to the same time
 * draws.
 */
export function poseAt(
  assets: ModelAssets,
  animation: string,
  time: number,
  options: { step?: number; color?: [number, number, number, number] } = {},
): PosedMoment {
  const source = sourceOf(assets);
  const step = options.step ?? 1 / 60;
  const track = openTrack(source.doc, animation, { loop: true, reset: 'animation' });
  let pose = track.first;
  const steps = Math.floor(time / step);
  for (let i = 0; i < steps; i++) pose = track.step(step);
  const rest = time - track.trackTime;
  if (rest > 0) pose = track.step(rest);
  return { pose, frame: frameOf(source, pose, options.color) };
}

/** `poseAt`'s frame alone. */
export function frameAt(assets: ModelAssets, animation: string, time: number): PosedFrame {
  return poseAt(assets, animation, time).frame;
}

/** The frame's rigid slots only — the rigid tier with nothing else in the picture. */
export function rigidOnly(frame: PosedFrame): PosedFrame {
  return { order: frame.order.filter((slot) => slot.kind === 'region') };
}

/**
 * The frame scaled about the world origin by `s`: every corner and vertex, and
 * nothing else. A smaller pose at the same ratio — every mesh's bbox shrinks —
 * which is what the grow-only control needs. The `uvs` and `triangles` arrays
 * are kept, so only the geometry differs. Clips are left as they are: the
 * frames this is used on carry none.
 */
export function scaledFrame(frame: PosedFrame, s: number): PosedFrame {
  const scale = (xy: number[]): number[] => xy.map((v) => v * s);
  return {
    order: frame.order.map((slot) =>
      slot.kind === 'region' ? { ...slot, corners: scale(slot.corners) } : { ...slot, vertices: scale(slot.vertices) },
    ),
  };
}
