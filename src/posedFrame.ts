import {
  activeBones,
  type CompiledDocument,
  CoreInputError,
  type CoreSlotRow,
  type DrawnRegion,
  documentPageLookup,
  drawnRegions,
  meshPageUvs,
  type ModelPage,
  type RawDrawn,
  type RawPose,
  readUvSequences,
  regionPageUvs,
  type UvSource,
} from 'rig-c/core';

/**
 * The record the DOM tier draws: one posed moment of a rig, every slot the
 * renderer shows, in draw order.
 *
 * The renderer never needed a skeleton. Per slot it needs the kind, four world
 * corners or world vertices with page UVs and triangles, the bitmap or the
 * page image with its alpha convention, a tint, a blend mode, a clip polygon
 * and a stacking position — and every one of those is a field of a pose that
 * `rig-c/core` computes from the compiled model document, plus that document's
 * `pages` section. This module is the adapter from one to the other
 * (`frameOf`), and these types are the whole of what crosses it.
 *
 * Coordinates are world space, Y up, exactly as the poser computed them; the
 * renderer does the Y flip. Nothing here is rounded or re-ordered.
 */
export interface PosedFrame {
  /** Every slot that draws, in draw order. */
  order: PosedSlot[];
}

/** The four blend modes, spelled as the runtime's enum names them. */
export type BlendMode = 'Normal' | 'Additive' | 'Multiply' | 'Screen';

/**
 * A clip polygon in world space and whether it keeps what is outside it.
 *
 * One object per clip in force: every slot a clip covers carries the *same*
 * object, which is how the renderer tells a clip that covers the whole frame
 * (one `clip-path` on the root) from one that covers a range of it.
 */
export interface PosedClip {
  /** Flat x, y pairs, world space. */
  polygon: number[];
  inverse: boolean;
  /**
   * The clipping attachment's `convex` flag: a polygon that is not convex is
   * clipped against its hull rather than decomposed. The DOM tier's CSS
   * `clip-path` takes the polygon as authored and does not read it; the canvas
   * mode's triangle cut does (`clipThrough` in `rig-c/core`).
   */
  convex: boolean;
}

interface PosedSlotCommon {
  /** The slot's name — the renderer keys its element on it. */
  slot: string;
  /** The slot's index in the full draw order (hidden slots included): its z-index. */
  z: number;
  blend: BlendMode;
  /** Slot colour × attachment colour × the player's own colour, r g b a in [0, 1]. */
  tint: [number, number, number, number];
  /** The slot's dark (two-colour) tint, where it carries one. The DOM tier cannot draw it. */
  dark?: [number, number, number];
  /** The clip in force over this slot, where one is. */
  clip?: PosedClip;
}

/** A rigid slot: an unpacked region bitmap posed by its four world corners. */
export interface PosedRegion extends PosedSlotCommon {
  kind: 'region';
  /** The region drawn — the key into the region bitmap map (a sequence frame's own name). */
  region: string;
  /** Four world corners, bottom-left, upper-left, upper-right, bottom-right: x0 y0 … x3 y3. */
  corners: number[];
  /**
   * The page the region sits on — the key into the page image map. The DOM tier
   * draws the region's own bitmap and never reads it; the canvas mode samples
   * the page through `uvs`.
   */
  page: string;
  /** Whether the page's texels are premultiplied by their alpha. */
  pma: boolean;
  /**
   * The region's page UVs at its four corners, in the corners' order (u, v
   * pairs, the page spanning [0, 1]) — the runtime's region UVs, a 90°-packed
   * region's turn included. The same array object from frame to frame for the
   * same region.
   */
  uvs: number[];
}

/** A deform slot: world vertices over page UVs, rastered from the page image. */
export interface PosedMesh extends PosedSlotCommon {
  kind: 'mesh';
  /** The page drawn — the key into the page image map. */
  page: string;
  /** Whether the page's texels are premultiplied by their alpha. */
  pma: boolean;
  /** World vertices, flat x, y pairs. */
  vertices: number[];
  /**
   * Page UVs, flat u, v pairs, the page spanning [0, 1]. The same array object
   * from frame to frame for the same region and attachment, so the renderer
   * can tell a mesh whose texture did not change by identity.
   */
  uvs: number[];
  /** Triangle indices into `vertices`, three per triangle. Stable by identity like `uvs`. */
  triangles: number[];
  /** The sequence frame drawn (0 for an attachment with no series). */
  sequence: number;
}

export type PosedSlot = PosedRegion | PosedMesh;

/**
 * What a document's frames read besides the pose, built once per document
 * view (`frameSource`): where every region sits on its page, each record's
 * sequence, which bones are active, and the per-region arrays the frames
 * share.
 *
 * @internal Not part of the package API: it holds `rig-c/core` objects, and
 * the package's types name none of them.
 */
export interface FrameSource {
  doc: CompiledDocument;
  uv: UvSource;
  pages: ReadonlyMap<string, ModelPage>;
  active: ReadonlySet<string>;
  boneOf: ReadonlyMap<string, string>;
  /** Page UVs kept per placement and attachment UV array, so a mesh's `uvs` is one object for its lifetime. */
  uvs: WeakMap<object, Map<readonly number[], number[]>>;
  /** Region page UVs kept per placement, so a region's `uvs` is one object for its lifetime. */
  regionUvs: WeakMap<object, number[]>;
  /** Triangle lists kept per slot and attachment, compared index for index before reuse. */
  triangles: Map<string, number[][]>;
}

/**
 * Builds the frame source for one view of a document — the view the track was
 * opened on (`underSkin` / `underNoSkin`), since which bones are active is a
 * fact of the skin. `text` is the document's own text: the sequences' `start`
 * and `digits` are not kept by `readModel`, and `readUvSequences` reads them
 * off the parsed JSON.
 *
 * @internal
 */
export function frameSource(doc: CompiledDocument, parsed: unknown): FrameSource {
  if (doc.pages === null) {
    throw new CoreInputError(
      `a ${doc.spec} document does not state where each region sits on its page; build it with \`rigc build\``,
    );
  }
  const pages = new Map(doc.pages.map((page) => [page.name, page]));
  return {
    doc,
    uv: { lookup: documentPageLookup(doc.pages), sequences: readUvSequences(parsed) },
    pages,
    active: activeBones(doc),
    boneOf: new Map(doc.slots.map((slot) => [slot.name, slot.bone])),
    uvs: new WeakMap(),
    regionUvs: new WeakMap(),
    triangles: new Map(),
  };
}

/** A slot row's colour channel. The core writes `null` only for a value that is not finite. */
function channel(value: number | null, slot: string): number {
  if (value === null) throw new CoreInputError(`slot "${slot}": the pose computed a colour channel that is not finite`);
  return value;
}

/** The page UVs a drawn mesh samples — `meshPageUvs`, kept per placement and UV array. */
function meshUvs(source: FrameSource, found: DrawnRegion): number[] {
  const art = found.art as readonly number[];
  let byArt = source.uvs.get(found.found);
  if (byArt === undefined) {
    byArt = new Map();
    source.uvs.set(found.found, byArt);
  }
  let kept = byArt.get(art);
  if (kept === undefined) {
    kept = meshPageUvs(found.found.region, found.found.page, art);
    byArt.set(art, kept);
  }
  return kept;
}

/** The page UVs a drawn region samples — `regionPageUvs`, kept per placement. */
function regionUvs(source: FrameSource, found: DrawnRegion): number[] {
  let kept = source.regionUvs.get(found.found);
  if (kept === undefined) {
    kept = regionPageUvs(found.found.region, found.found.page);
    source.regionUvs.set(found.found, kept);
  }
  return kept;
}

/** A triangle list equal, index for index, to `drawn.triangles`, kept for reuse by identity. */
function trianglesOf(source: FrameSource, drawn: RawDrawn): number[] {
  const key = `${drawn.slot}\u0000${drawn.attachment}`;
  let lists = source.triangles.get(key);
  if (lists === undefined) {
    lists = [];
    source.triangles.set(key, lists);
  }
  const wanted = drawn.triangles;
  let kept = lists.find((list) => list.length === wanted.length && list.every((v, i) => v === wanted[i]));
  if (kept === undefined) {
    kept = [...wanted];
    lists.push(kept);
  }
  return kept;
}

/**
 * The clip over each slot of the draw order, where one covers it — the official
 * draw loops' `clipStart`/`clipEnd`, restated over a pose (rigc's
 * `clipCover` in `src/render_core.ts` is the specification this follows):
 *
 * - walking the draw order, a slot showing a clipping attachment first ends the
 *   clip in force if it is that clip's end slot, then starts its own when its
 *   bone is active and no clip is in force — a second clip met while one is in
 *   force is ignored, not nested;
 * - every other slot is covered by the clip in force, and ends it after being
 *   covered if it is the end slot (the end slot is inside its own clip);
 * - a clip whose end slot is its own slot, or one already passed, never ends.
 *
 * Each started clip is one `PosedClip` object, shared by every slot it covers.
 *
 * @internal Exported for the frame gate's synthetic cover cases.
 */
export function clipCover(pose: Pick<RawPose, 'clips' | 'shown' | 'drawOrder'>, active: ReadonlySet<string>): Map<string, PosedClip> {
  const polygons = new Map(pose.clips.map((c) => [c[0], { end: c[2], polygon: c[3] }]));
  const shownOf = new Map(pose.shown.map((s) => [s.slot, s]));
  const cover = new Map<string, PosedClip>();
  let current: { end: string | null; clip: PosedClip } | null = null;
  for (const slot of pose.drawOrder) {
    const shown = shownOf.get(slot);
    const g = shown?.geometry;
    const clip = g?.kind === 'clipping' ? polygons.get(slot) : undefined;
    if (shown !== undefined && g?.kind === 'clipping' && clip !== undefined) {
      if (current !== null && current.end === slot) current = null;
      if (active.has(shown.bone) && current === null) {
        current = { end: clip.end, clip: { polygon: clip.polygon, inverse: g.inverse, convex: g.convex } };
      }
      continue;
    }
    if (current !== null) cover.set(slot, current.clip);
    if (current !== null && current.end === slot) current = null;
  }
  return cover;
}

/**
 * One pose as a frame.
 *
 * - `order` is the pose's draw order narrowed to the attachments it draws
 *   (`pose.drawn`, regions and meshes) on active bones; `z` is the slot's index
 *   in the full draw order.
 * - A region's `corners` are its drawn vertices, which the core writes in the
 *   runtime's corner order: bottom-left, upper-left, upper-right, bottom-right.
 * - A region's `uvs` are `regionPageUvs` over the region `drawnRegions`
 *   resolves for it, and its `page`/`pma` that region's page.
 * - A mesh's `uvs` are `meshPageUvs` over the region `drawnRegions` resolves
 *   for it (a sequence frame's own region, a linked mesh's own region over its
 *   source's UVs) and its `page`/`pma` that region's page.
 * - `tint` is the slot row's colour times the attachment's colour, channel by
 *   channel, then times `color` — the player's own whole-rig colour, which is
 *   not a document value.
 * - `blend` is the slot row's mode; `dark` its dark colour where it has one.
 * - `clip` is `clipCover` above.
 *
 * @internal
 */
export function frameOf(
  source: FrameSource,
  pose: RawPose,
  color: readonly [number, number, number, number] = [1, 1, 1, 1],
): PosedFrame {
  const { drawn: regions, why } = drawnRegions(source.doc, pose.shown, pose.drawOrder, source.uv);
  if (regions === null) throw new CoreInputError(`the page UVs are not posed: ${why}`);
  const regionOf = new Map(regions.map((r) => [r.slot, r]));
  const rows = new Map<string, CoreSlotRow>(pose.slots.map((row) => [row[0], row]));
  const z = new Map(pose.drawOrder.map((slot, index) => [slot, index]));
  const cover = clipCover(pose, source.active);
  const [sr, sg, sb, sa] = color;
  const order: PosedSlot[] = [];
  for (const d of pose.drawn) {
    const bone = source.boneOf.get(d.slot);
    if (bone === undefined || !source.active.has(bone)) continue;
    const found = regionOf.get(d.slot);
    if (found === undefined) throw new CoreInputError(`slot "${d.slot}" drew "${d.attachment}", and no atlas region was resolved for it`);
    const row = rows.get(d.slot);
    if (row === undefined) throw new CoreInputError(`slot "${d.slot}" drew and has no slot row`);
    const tint: [number, number, number, number] = [
      channel(row[2], d.slot) * d.colour[0] * sr,
      channel(row[3], d.slot) * d.colour[1] * sg,
      channel(row[4], d.slot) * d.colour[2] * sb,
      channel(row[5], d.slot) * d.colour[3] * sa,
    ];
    const darkRow = row[6];
    const common = {
      slot: d.slot,
      z: z.get(d.slot) as number,
      blend: (row[8] ?? 'Normal') as BlendMode,
      tint,
      ...(darkRow === null ? {} : { dark: [channel(darkRow[0], d.slot), channel(darkRow[1], d.slot), channel(darkRow[2], d.slot)] as [number, number, number] }),
      ...(cover.has(d.slot) ? { clip: cover.get(d.slot) as PosedClip } : {}),
    };
    const page = source.pages.get(found.found.page.name);
    if (d.kind === 'region') {
      order.push({
        ...common,
        kind: 'region',
        region: found.region,
        corners: d.vertices,
        page: found.found.page.name,
        pma: page?.pma === true,
        uvs: regionUvs(source, found),
      });
    } else {
      order.push({
        ...common,
        kind: 'mesh',
        page: found.found.page.name,
        pma: page?.pma === true,
        vertices: d.vertices,
        uvs: meshUvs(source, found),
        triangles: trianglesOf(source, d),
        sequence: d.sequenceIndex,
      });
    }
  }
  return { order };
}
