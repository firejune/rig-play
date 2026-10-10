import {
  BlendMode,
  ClippingAttachment,
  MeshAttachment,
  Physics,
  RegionAttachment,
  type Skeleton,
  type Slot,
  type TextureAtlasRegion,
} from '@esotericsoftware/spine-core';

import type { BlendMode as FrameBlend, PosedClip, PosedFrame, PosedSlot } from '../src/posedFrame';

/**
 * The test suite's bridge from a spine-core `Skeleton` to the frame record the
 * DOM tier draws.
 *
 * The package itself reads no Spine runtime: it poses a compiled model through
 * `rig-c/core` and hands `DomRenderer` a `PosedFrame`. Most of the renderer's
 * specs, though, are about the renderer — the cut, the clip-path frame, the
 * backing policy, the GL page ledger — and were written against spine-core
 * skeletons over hand-made atlases and the spineboy export, which is where the
 * clipping, additive-blend and premultiplied-page cases live (no rigc gallery
 * build carries one). This module reads such a skeleton the way the official
 * draw loop does and writes the same record the package's adapter writes, so
 * those specs keep drawing the same numbers through the same renderer.
 *
 * It reads only: drawing a skeleton is `SkeletonRenderer` in `tests/spineDom.ts`,
 * and this module imports no DOM code, so the node-side frame gate can load it.
 *
 * It is also the spine-core side of the frame gate (`tests/frames.spec.ts`):
 * a gallery build's Spine pair read through here is compared, at tolerance 0,
 * with its model pair posed by `rig-c/core` and read through `frameOf`.
 *
 * spine-core 4.3 only: the generation seam the package used to carry is gone
 * with the package's own spine-core reads.
 */

/** Advances the skeleton's physics clock by `delta` and poses its world transforms (4.3's frame recipe). */
export function advanceSkeleton(skeleton: Skeleton, delta = 0): void {
  skeleton.update(delta);
  skeleton.updateWorldTransform(Physics.update);
}

const BLEND: Record<BlendMode, FrameBlend> = {
  [BlendMode.Normal]: 'Normal',
  [BlendMode.Additive]: 'Additive',
  [BlendMode.Multiply]: 'Multiply',
  [BlendMode.Screen]: 'Screen',
};

/** One mesh attachment's arrays, copied once so a frame hands the same objects every time (`PosedMesh.uvs`). */
const meshArrays = new WeakMap<object, Map<number, { uvs: number[]; triangles: number[] }>>();

function arraysOf(attachment: MeshAttachment, index: number): { uvs: number[]; triangles: number[] } {
  let byIndex = meshArrays.get(attachment);
  if (!byIndex) {
    byIndex = new Map();
    meshArrays.set(attachment, byIndex);
  }
  let kept = byIndex.get(index);
  if (!kept) {
    kept = { uvs: Array.from(attachment.sequence.getUVs(index)), triangles: Array.from(attachment.triangles) };
    byIndex.set(index, kept);
  }
  return kept;
}

/** One region attachment's sequence UVs, copied once so a frame hands the same object every time (`PosedRegion.uvs`). */
const regionArrays = new WeakMap<object, Map<number, number[]>>();

function regionUvsOf(attachment: RegionAttachment, index: number): number[] {
  let byIndex = regionArrays.get(attachment);
  if (!byIndex) {
    byIndex = new Map();
    regionArrays.set(attachment, byIndex);
  }
  let kept = byIndex.get(index);
  if (!kept) {
    kept = Array.from(attachment.sequence.getUVs(index));
    byIndex.set(index, kept);
  }
  return kept;
}

/** What `frameOfSkeleton` read besides the frame. */
export interface SkeletonFrame {
  frame: PosedFrame;
  /** Every page image a region or mesh of the frame draws from, by page name. */
  pages: Map<string, HTMLImageElement>;
  /** Clipping attachments the draw loop met and did not start: another clip in force, or an inactive bone. */
  clipsIgnored: number;
}

/**
 * Reads a posed spine-core 4.3 skeleton as a frame — the official draw loop
 * (`SkeletonRendererCore`), read rather than drawn:
 *
 * - the applied draw order; a slot on an inactive bone ends any clip it is the
 *   end slot of and draws nothing;
 * - a clipping attachment first ends the clip in force if its slot is that
 *   clip's end slot, then starts its own when no clip is in force, and draws
 *   nothing; every other slot is covered by the clip in force and ends it if it
 *   is the end slot;
 * - a region's four corners from `computeWorldVertices` with the sequence's
 *   offsets and its page UVs from the sequence, a mesh's world vertices and the sequence's UVs for the resolved
 *   frame, the page off the region's page;
 * - tint = skeleton colour × slot colour × attachment colour, the blend the
 *   slot data's.
 *
 * Vertices are written into plain arrays, so they are the doubles spine-core
 * computes.
 */
export function frameOfSkeleton(skeleton: Skeleton): SkeletonFrame {
  const drawOrder = skeleton.drawOrder.appliedPose;
  const order: PosedSlot[] = [];
  const pages = new Map<string, HTMLImageElement>();
  const sc = skeleton.color;
  let clipsIgnored = 0;
  let clip: { end: unknown; posed: PosedClip } | null = null;
  const clipEnd = (slot: Slot): void => {
    if (clip && clip.end === slot.data) clip = null;
  };
  for (let i = 0; i < drawOrder.length; i++) {
    const slot = drawOrder[i];
    const pose = slot.appliedPose;
    const attachment = pose.attachment;
    if (attachment instanceof ClippingAttachment) {
      clipEnd(slot);
      if (slot.bone.active && !clip) {
        const polygon: number[] = new Array(attachment.worldVerticesLength).fill(0);
        attachment.computeWorldVertices(skeleton, slot, 0, attachment.worldVerticesLength, polygon, 0, 2);
        clip = { end: attachment.endSlot, posed: { polygon, inverse: attachment.inverse, convex: attachment.convex } };
      } else {
        clipsIgnored++;
      }
      continue;
    }
    if (!slot.bone.active) {
      clipEnd(slot);
      continue;
    }
    const pc = pose.color;
    const common = {
      slot: slot.data.name,
      z: i,
      blend: BLEND[slot.data.blendMode],
      ...(clip ? { clip: (clip as { posed: PosedClip }).posed } : {}),
    };
    if (attachment instanceof RegionAttachment) {
      const index = attachment.sequence.resolveIndex(pose);
      const region = attachment.sequence.regions[index] as TextureAtlasRegion | null;
      const image = region?.page.texture?.getImage() as HTMLImageElement | undefined;
      if (region) {
        if (image) pages.set(region.page.name, image);
        const corners: number[] = new Array(8).fill(0);
        attachment.computeWorldVertices(slot, attachment.getOffsets(pose), corners, 0, 2);
        const c = attachment.color;
        order.push({
          ...common,
          tint: [sc.r * pc.r * c.r, sc.g * pc.g * c.g, sc.b * pc.b * c.b, sc.a * pc.a * c.a],
          kind: 'region',
          region: region.name,
          corners,
          page: region.page.name,
          pma: region.page.pma,
          uvs: regionUvsOf(attachment, index),
        });
      }
    } else if (attachment instanceof MeshAttachment) {
      const index = attachment.sequence.resolveIndex(pose);
      const region = attachment.sequence.regions[index] as TextureAtlasRegion | null;
      const image = region?.page.texture?.getImage() as HTMLImageElement | undefined;
      if (region) {
        if (image) pages.set(region.page.name, image);
        const vertices: number[] = new Array(attachment.worldVerticesLength).fill(0);
        attachment.computeWorldVertices(skeleton, slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
        const c = attachment.color;
        const { uvs, triangles } = arraysOf(attachment, index);
        order.push({
          ...common,
          tint: [sc.r * pc.r * c.r, sc.g * pc.g * c.g, sc.b * pc.b * c.b, sc.a * pc.a * c.a],
          kind: 'mesh',
          page: region.page.name,
          pma: region.page.pma,
          vertices,
          uvs,
          triangles,
          sequence: index,
        });
      }
    }
    clipEnd(slot);
  }
  return { frame: { order }, pages, clipsIgnored };
}

