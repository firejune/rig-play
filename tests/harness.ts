import { type RawPose, regionPageUvs } from 'rig-c/core';

import {
  loadModel,
  type ModelAssets,
  type PageLayout,
  type RegionImage,
  revokeRegions,
  RigPlayer,
  unpackRegions,
} from '../src/index';
import { CanvasRenderer } from '../src/CanvasRenderer';
import { DomRenderer } from '../src/DomRenderer';
import type { ReadDocument } from '../src/loadModel';
import { getMeshGlBlitter, glContextCount } from '../src/MeshGlBlitter';
import { straightAlphaDerivations, straightAlphaSource } from '../src/DomTexture';
import type { PosedClip, PosedFrame, PosedSlot } from '../src/posedFrame';
import { layoutRegions, parseAtlas, withPma } from './atlasLayout';
import { frameAt, loadRig, poseAt, rigidOnly, scaledFrame } from './rigFrames';

/**
 * Browser-side test harness (see harness.html).
 *
 * The specs drive the library through `window.rigPlayHarness` instead of
 * reading the demo's stats line, because the loading path — blob URL
 * ownership above all — is not observable from a rendered frame. Each probe
 * returns a plain JSON-serializable result; the assertions live in the specs.
 */

/** One atlas page, two regions, neither covering the page. */
const CUT_ATLAS = `part.png
size: 64, 32
half-left
bounds: 0, 0, 32, 32
half-right
bounds: 32, 0, 32, 32
`;

/**
 * Whole-page regions (the one-part-per-page shape) plus the two cases that
 * must still be cut: a sub-rect, and a rotated region covering its page.
 */
const WHOLE_PAGE_ATLAS = `part.png
size: 64, 32
whole
bounds: 0, 0, 64, 32
sub
bounds: 0, 0, 32, 32

rot.png
size: 32, 64
whole-rotated
bounds: 0, 0, 64, 32
rotate: true
`;

/** Second page has no image, so unpackRegions throws after minting the first. */
const MISSING_PAGE_ATLAS = `part.png
size: 64, 32
half-left
bounds: 0, 0, 32, 32

missing.png
size: 64, 32
orphan
bounds: 0, 0, 32, 32
`;

export interface RegionEntry {
  name: string;
  url: string;
  width: number;
  height: number;
}

export interface UnpackProbeResult {
  /** Page image URL, created by the harness — i.e. caller-owned. */
  pageUrl: string;
  /** Object URLs created while unpackRegions ran. */
  createdUrls: string[];
  /** Object URLs revoked by revokeRegions(), which is called twice. */
  revokedUrls: string[];
  regions: RegionEntry[];
  /** Whether each URL still resolves, sampled before/after revokeRegions(). */
  aliveBefore: Record<string, boolean>;
  aliveAfter: Record<string, boolean>;
}

export interface PassThroughProbeResult {
  /** Page image URLs by page name, all caller-owned. */
  pageUrls: Record<string, string>;
  createdUrls: string[];
  regions: RegionEntry[];
  aliveAfter: Record<string, boolean>;
}

export interface UnpackFailureProbeResult {
  /** Message of the error unpackRegions threw ('' if it did not throw). */
  message: string;
  createdUrls: string[];
  revokedUrls: string[];
  aliveAfter: Record<string, boolean>;
}

export interface LoaderProbeResult {
  spec: string;
  animations: string[];
  pageCount: number;
  regionCount: number;
  /** Region URLs the loader minted, and what its dispose() revoked. */
  createdUrls: string[];
  revokedUrls: string[];
  /** Elements the renderer put in the root for one rendered frame. */
  imageCount: number;
  canvasCount: number;
  /** Root children left after player.dispose(). */
  rootChildrenAfterDispose: number;
  aliveAfter: Record<string, boolean>;
}

export interface LoaderFailure {
  message: string;
  createdUrls: string[];
  revokedUrls: string[];
  /** Every URL the load asked its fetch for, in order. */
  fetched: string[];
}

export interface LoaderFailureProbeResult {
  spineJson: LoaderFailure;
  spineSkel: LoaderFailure;
  foreignSpec: LoaderFailure;
  http: LoaderFailure;
  missingPage: LoaderFailure;
}

export interface SharedAssetsProbeResult {
  /** Object URLs minted while the one load ran. */
  createdUrls: string[];
  /** Object URLs minted while two players were built and drawn from it: players own no bitmaps. */
  playerCreatedUrls: string[];
  regionCount: number;
  /** <img>/<canvas> each player put in its own root for one frame. */
  firstElementCount: number;
  secondElementCount: number;
  secondCanvasCount: number;
  /** Sampled after the first player was disposed: the assets are the caller's. */
  aliveAfterFirstDispose: Record<string, boolean>;
  /** The survivor's elements after the first player went. */
  secondElementsAfterFirstDispose: number;
  /** Object URLs revoked by assets.dispose(), which is called twice. */
  revokedUrls: string[];
  aliveAfter: Record<string, boolean>;
}

/** Mesh-canvas backing sizes and counters read right after one render(). */
export interface BackingSnapshot {
  /** Backing store of each mesh canvas, in root child (draw) order. */
  backing: Array<{ width: number; height: number }>;
  /** CSS size written alongside it, same order. */
  css: Array<{ width: string; height: string }>;
  /** canvasReallocCount / meshCount of the render that produced this. */
  reallocCount: number;
  meshDrawnCount: number;
}

export interface BackingProbeResult {
  meshCanvasCount: number;
  /** Live renderer: ratio 2, then 0.5 written on it, then the same pose again. */
  liveHigh: BackingSnapshot;
  liveShrunk: BackingSnapshot;
  liveShrunkAgain: BackingSnapshot;
  /** Fresh renderer given 0.5 before its first render — the oracle. */
  freshLow: BackingSnapshot;
  /** Other direction: a live 0.5 → 2 switch, against a fresh renderer at 2. */
  liveGrown: BackingSnapshot;
  freshHigh: BackingSnapshot;
  /** Grow-only control: ratio held, every mesh bbox shrunk instead. */
  holdBefore: BackingSnapshot;
  holdAfter: BackingSnapshot;
}

/**
 * Where a rigid slot's four corners and page UVs come from, read off the model
 * side: the `turned` test rig (tests/rigs/turned) poses two 2 × 1 regions on
 * its root at the identity, one packed straight and one turned 90° on its
 * hand-packed page, built by `rigc build --atlas-in`. That is the convention
 * the renderer builds its CSS matrix from (three of the four corners, in
 * order) and the rigid cut turns a packed rect back against.
 *
 * Read twice for each region: `drawn` is rig-c's own `RawDrawn.vertices` off
 * the pose (`Quad.world` in rigc states the order bl, ul, ur, br), and `frame`
 * is what the package's adapter hands the renderer — its `corners` and `uvs`.
 * The expectations are written by hand in `tests/invariants.spec.ts`, from the
 * region sizes and the page placement in the rig's atlas, never from code.
 */
export interface RegionGeometryProbeResult {
  /** The region packed straight: `s`, at (4, 4) on an 8 × 8 page. */
  straight: { drawn: number[]; corners: number[]; uvs: number[] };
  /** The region packed turned: `r`, at (1, 2), occupying 1 × 2 on the page. */
  rotated: { drawn: number[]; corners: number[]; uvs: number[] };
}

export interface RigPlayHarness {
  unpackProbe(): Promise<UnpackProbeResult>;
  regionGeometryProbe(): Promise<RegionGeometryProbeResult>;
  passThroughProbe(): Promise<PassThroughProbeResult>;
  rotatedCutProbe(): Promise<RotatedCutProbeResult>;
  unpackFailureProbe(): Promise<UnpackFailureProbeResult>;
  loaderProbe(): Promise<LoaderProbeResult>;
  loaderFailureProbe(): Promise<LoaderFailureProbeResult>;
  glTextureProbe(): Promise<GlTextureProbeResult>;
  backingProbe(): Promise<BackingProbeResult>;
  scaledStageProbe(): Promise<ScaledStageProbeResult>;
  sharedAssetsProbe(): Promise<SharedAssetsProbeResult>;
  cutConcurrencyProbe(): Promise<CutConcurrencyProbeResult>;
  cutOrderProbe(): Promise<CutOrderProbeResult>;
  cutFlightFailureProbe(): Promise<CutFlightFailureProbeResult>;
  scaledPageProbe(): Promise<ScaledPageProbeResult>;
  halfResRenderProbe(): Promise<HalfResRenderProbeResult>;
  clipPartMaskProbe(): Promise<ClipPartMaskProbeResult>;
  clipRigidProbe(): Promise<ClipRigidProbeResult>;
  clipRootProbe(): Promise<ClipRootProbeResult>;
  clipCountersProbe(): Promise<ClipCountersProbeResult>;
  clipInverseProbe(): Promise<ClipInverseProbeResult>;
  cutRuleStage(options: CutRuleStageOptions): Promise<CutRuleStageResult>;
  pmaFixtureProbe(): Promise<PmaFixtureProbeResult>;
  pmaCutProbe(): Promise<PmaCutProbeResult>;
  pmaDerivationProbe(): Promise<PmaDerivationProbeResult>;
  pmaStage(options: PmaStageOptions): Promise<PmaStageResult>;
  canvasModeProbe(count: number): Promise<CanvasModeProbeResult>;
}

export interface CanvasModeProbeResult {
  webglAvailable: boolean;
  /** WebGL contexts the package had created before and after drawing `count` canvas-mode players. */
  contextsBefore: number;
  contextsAfter: number;
  /** Players whose canvas renderer drew through the shared context. */
  webglPlayers: number;
  /** Players whose visible canvas holds any non-transparent pixel. */
  drawingPlayers: number;
  /** Elements in each root: one canvas in the canvas mode. */
  elementsPerRoot: number[];
  blits: number;
  /** The second draw of a held pose: every player reuses its frame. */
  reusedOnSecondDraw: number;
  /** Live page textures while drawing and after every player is disposed. */
  texturesWhileDrawing: number;
  texturesAfterDispose: number;
  baselineTextures: number;
  /** One player swapped dom → canvas → dom in place: element kinds after each step. */
  swap: Array<{ mode: string; canvases: number; images: number; renderer: string }>;
}

declare global {
  interface Window {
    rigPlayHarness: RigPlayHarness;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

/**
 * Paints a synthetic atlas page and hands back a *caller-owned* blob URL for
 * it — the control case for "revokeRegions must not touch what it did not
 * create".
 */
async function makePageImage(
  width: number,
  height: number,
): Promise<{ image: HTMLImageElement; url: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = '#3aa0ff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff5a3a';
  ctx.fillRect(0, 0, width / 2, height / 2);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  return { image: await loadImage(url), url };
}

/** Records every object URL created/revoked while `fn` runs. */
async function trackObjectUrls<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; created: string[]; revoked: string[] }> {
  const created: string[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (object: Blob | MediaSource): string => {
    const url = realCreate.call(URL, object);
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
    realRevoke.call(URL, url);
  };
  try {
    return { result: await fn(), created, revoked };
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
}

/** A revoked blob URL stops resolving — that is the leak/no-leak oracle. */
async function alive(urls: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const url of urls) {
    try {
      const response = await fetch(url);
      result[url] = response.ok;
    } catch {
      result[url] = false;
    }
  }
  return result;
}

function entries(images: Map<string, RegionImage>): RegionEntry[] {
  return [...images].map(([name, image]) => ({
    name,
    url: image.url,
    width: image.width,
    height: image.height,
  }));
}

async function unpackProbe(): Promise<UnpackProbeResult> {
  const page = await makePageImage(64, 32);
  const layout = parseAtlas(CUT_ATLAS);
  const pageImages = new Map([['part.png', page.image]]);

  const unpacked = await trackObjectUrls(() => unpackRegions(layout, pageImages));
  const regions = entries(unpacked.result);
  const urls = [page.url, ...regions.map((region) => region.url)];
  const aliveBefore = await alive(urls);

  // Twice: revoking is documented as idempotent, and a double free would
  // show up as a duplicate in revokedUrls.
  const revoke = await trackObjectUrls(async () => {
    revokeRegions(unpacked.result);
    revokeRegions(unpacked.result);
  });

  return {
    pageUrl: page.url,
    createdUrls: unpacked.created,
    revokedUrls: revoke.revoked,
    regions,
    aliveBefore,
    aliveAfter: await alive(urls),
  };
}

async function passThroughProbe(): Promise<PassThroughProbeResult> {
  const part = await makePageImage(64, 32);
  const rot = await makePageImage(32, 64);
  const layout = parseAtlas(WHOLE_PAGE_ATLAS);
  const pageImages = new Map([
    ['part.png', part.image],
    ['rot.png', rot.image],
  ]);

  const unpacked = await trackObjectUrls(() => unpackRegions(layout, pageImages));
  const regions = entries(unpacked.result);
  revokeRegions(unpacked.result);

  return {
    pageUrls: { 'part.png': part.url, 'rot.png': rot.url },
    createdUrls: unpacked.created,
    regions,
    aliveAfter: await alive([part.url, rot.url, ...regions.map((region) => region.url)]),
  };
}

async function unpackFailureProbe(): Promise<UnpackFailureProbeResult> {
  const page = await makePageImage(64, 32);
  const layout = parseAtlas(MISSING_PAGE_ATLAS);
  const pageImages = new Map([['part.png', page.image]]);

  const attempt = await trackObjectUrls(async () => {
    try {
      await unpackRegions(layout, pageImages);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  return {
    message: attempt.result,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
    aliveAfter: await alive(attempt.created),
  };
}

/**
 * Orientation of a 90°-packed cut (#49).
 *
 * The packer stores such a region turned counter-clockwise, and the runtime's
 * UVs are what say so: `u`/`v` come from the packed rect's top-left corner and,
 * at `degrees === 90`, `u2`/`v2` from `x + height` / `y + width` — the rect's
 * far edges — and the artwork's corners, in the rigid tier's order BL, UL, UR,
 * BR, carry (u2, v2), (u, v2), (u, v), (u2, v). So the artwork's top-left
 * corner is the packed rect's bottom-left. Every release up to 0.7.0 turned the
 * rect the same way the packer had, and the bitmap came out 180° round.
 *
 * Nothing in this probe rotates anything, which is the point: the rotated
 * fixtures that existed before it could not see that, because the only
 * reference they had for a turned bitmap reimplemented the cut's own transform
 * — and a reference that shares the convention agrees with the code under test
 * whichever way both are wrong. Here the page is painted as exact bytes, cut by
 * the shipped `unpackRegions`, and handed back whole beside the region's corner
 * UVs as `rig-c/core` computes them (`regionPageUvs` — the UVs the package's
 * adapter hands the canvas mode, which rigc holds to spine-core's
 * `sequence.getUVs` in its own gate); which page texel each UV names is derived
 * in the spec, from the UVs. `tests/invariants.spec.ts` pins those UVs against
 * a hand-written expectation.
 *
 * Two fixtures, because "covers its page" and "is cut" are different questions:
 * a rotated region that covers its page must still be cut (the pass-through
 * would hand back artwork lying on its side), and one that does not cover it is
 * the cut path proper.
 */

/** A glyph packed rotated on a page it does not cover. */
const ROTATED_CUT_ATLAS = `glyph.png
size: 32, 24
glyph
bounds: 4, 2, 12, 20
rotate: true
`;

/** The same glyph packed rotated onto a page that is exactly its rect. */
const ROTATED_WHOLE_ATLAS = `turned.png
size: 20, 12
turned
bounds: 0, 0, 12, 20
rotate: true
`;

/** Quadrants of the packed rect, clockwise from the rect's own top-left. */
const ROTATED_CUT_QUADRANTS = ['#e02020', '#20c040', '#2050e0', '#e0c020'] as const;
/** Outside the packed rect — a cut that read the wrong rect carries it. */
const ROTATED_CUT_SURROUND = '#101820';

export interface PixelGrid {
  width: number;
  height: number;
  /** '#rrggbbaa' per pixel, row-major. */
  pixels: string[];
}

export interface RotatedCutSample {
  /** The region as the atlas states it: packed bounds and rotation, and its corner UVs. */
  region: {
    name: string;
    x: number;
    y: number;
    /** Artwork size; the rect it occupies on the page is height × width. */
    width: number;
    height: number;
    degrees: number;
    /** `regionPageUvs`: u, v pairs at the corners BL, UL, UR, BR. */
    uvs: number[];
  };
  page: PixelGrid;
  cut: PixelGrid;
  /** False when unpackRegions handed the page URL back instead of cutting. */
  minted: boolean;
}

export interface RotatedCutProbeResult {
  /** Rotated, and smaller than its page. */
  sub: RotatedCutSample;
  /** Rotated, and exactly its page. */
  whole: RotatedCutSample;
}

/**
 * RGBA bytes for a page carrying one packed rect in four corner colours.
 *
 * The rect is written in *page* coordinates — where the packer put it — and
 * nothing here knows which of its corners the artwork's top-left is. Four
 * distinct quadrants make every one of the eight orientations of the bitmap a
 * different picture, so no flip and no quarter-turn can pass the assertion.
 */
function packedGlyphPage(
  pageWidth: number,
  pageHeight: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8ClampedArray {
  const rgba = (hex: string): [number, number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
  const surround = rgba(ROTATED_CUT_SURROUND);
  const quadrants = ROTATED_CUT_QUADRANTS.map(rgba);
  const pixels = new Uint8ClampedArray(pageWidth * pageHeight * 4);
  for (let y = 0; y < pageHeight; y++) {
    for (let x = 0; x < pageWidth; x++) {
      const inside =
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      let colour = surround;
      if (inside) {
        const right = x - rect.x >= rect.width / 2;
        const bottom = y - rect.y >= rect.height / 2;
        colour = quadrants[bottom ? (right ? 2 : 3) : right ? 1 : 0];
      }
      pixels.set(colour, (y * pageWidth + x) * 4);
    }
  }
  return pixels;
}

/** A bitmap's pixels as '#rrggbbaa', row-major — the spec does the deriving. */
function pixelGrid(image: HTMLImageElement): PixelGrid {
  const { data, width, height } = readImagePixels(image);
  const pixels: string[] = [];
  for (let at = 0; at < data.length; at += 4) {
    let hex = '#';
    for (let channel = 0; channel < 4; channel++) {
      hex += data[at + channel].toString(16).padStart(2, '0');
    }
    pixels.push(hex);
  }
  return { width, height, pixels };
}

/** One rotated region cut by the shipped path, with the page it came from. */
async function rotatedCutSample(
  atlasText: string,
  pageName: string,
  pageWidth: number,
  pageHeight: number,
  /** The rect on the page, as the packer wrote it: the artwork's transpose. */
  rect: { x: number; y: number; width: number; height: number },
): Promise<RotatedCutSample> {
  const pageUrl = pngUrl(packedGlyphPage(pageWidth, pageHeight, rect), pageWidth, pageHeight);
  const image = await loadImage(pageUrl);
  const layout = parseAtlas(atlasText);

  const images = await unpackRegions(layout, new Map([[pageName, image]]));
  const page = layout[0];
  const region = page.regions[0];
  const cut = images.get(region.name);
  if (!cut) throw new Error(`region ${region.name} missing from the unpack`);
  const uvs = regionPageUvs(
    { ...region, offsetX: 0, offsetY: 0, originalWidth: region.width, originalHeight: region.height },
    page,
  );
  const sample: RotatedCutSample = {
    region: {
      name: region.name,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      degrees: region.degrees,
      uvs,
    },
    page: pixelGrid(image),
    cut: pixelGrid(await loadImage(cut.url)),
    minted: cut.url !== pageUrl,
  };
  revokeRegions(images);
  URL.revokeObjectURL(pageUrl);
  return sample;
}

async function rotatedCutProbe(): Promise<RotatedCutProbeResult> {
  return {
    sub: await rotatedCutSample(ROTATED_CUT_ATLAS, 'glyph.png', 32, 24, {
      x: 4,
      y: 2,
      width: 20,
      height: 12,
    }),
    whole: await rotatedCutSample(ROTATED_WHOLE_ATLAS, 'turned.png', 20, 12, {
      x: 0,
      y: 0,
      width: 20,
      height: 12,
    }),
  };
}

/**
 * End-to-end: the loader against a real `rigc build` output — the packed
 * build, so every region is cut from a shared page and mints a blob URL.
 */
const LOADER_RIG = '/rigs/flex-packed/skeleton.model.json';

async function loaderProbe(): Promise<LoaderProbeResult> {
  const load = await trackObjectUrls(() => loadModel({ modelUrl: LOADER_RIG }));
  const assets = load.result;

  // One rendered frame proves the pieces are wired to each other, not just
  // present: page images on the mesh tier and region bitmaps on the rigid one.
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const player = new RigPlayer(root, assets);
  player.play(assets.animations[0].name);
  player.seek(1.2);
  player.draw();
  const imageCount = root.querySelectorAll('img').length;
  const canvasCount = root.querySelectorAll('canvas').length;
  player.dispose();

  // Twice: dispose() is documented as idempotent.
  const release = await trackObjectUrls(async () => {
    assets.dispose();
    assets.dispose();
  });

  return {
    spec: assets.spec,
    animations: assets.animations.map((animation) => animation.name),
    pageCount: assets.pageImages.size,
    regionCount: assets.regionImages.size,
    createdUrls: load.created,
    revokedUrls: release.revoked,
    imageCount,
    canvasCount,
    rootChildrenAfterDispose: root.childElementCount,
    aliveAfter: await alive(load.created),
  };
}

/** Runs a load that must fail, and reports what it left behind and what it fetched. */
async function failedLoad(
  options: Parameters<typeof loadModel>[0],
): Promise<LoaderFailure> {
  const fetched: string[] = [];
  const inner = options.fetch ?? fetch;
  const counting: typeof globalThis.fetch = (input, init) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return inner(input, init);
  };
  const attempt = await trackObjectUrls(async () => {
    try {
      await loadModel({ ...options, fetch: counting });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  return {
    message: attempt.result,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
    fetched,
  };
}

/**
 * The ways a load is refused, and what each leaves behind: a Spine export
 * (refused by name before anything is fetched), a document of a spec the core
 * does not read, a document that never arrives, and a page image that never
 * arrives — the last after the document was read and before anything was cut.
 */
async function loaderFailureProbe(): Promise<LoaderFailureProbeResult> {
  const answer = (body: string, status = 200): typeof globalThis.fetch => () =>
    Promise.resolve(new Response(body, { status }));
  const spineJson = await failedLoad({ modelUrl: '/rigs/flex/skeleton.json' });
  // Refused by its name before any fetch, so no such file has to exist.
  const spineSkel = await failedLoad({ modelUrl: '/rigs/flex/skeleton.skel' });
  const foreignSpec = await failedLoad({
    modelUrl: '/rigs/flex/skeleton.model.json',
    fetch: answer(JSON.stringify({ spec: 'rigc-compiled/9' })),
  });
  const http = await failedLoad({
    modelUrl: '/rigs/flex/skeleton.model.json',
    fetch: answer('', 404),
  });
  const missingPage = await failedLoad({
    modelUrl: LOADER_RIG,
    resolvePage: (name, modelUrl) =>
      new URL(`missing-${name}`, new URL(modelUrl, document.baseURI)).href,
  });
  return { spineJson, spineSkel, foreignSpec, http, missingPage };
}

/**
 * Mesh-canvas backing sizing across a pixelRatio change.
 *
 * Not observable from a rendered frame either: the picture stays correct
 * whatever the backing size is (the CSS size mirrors it, so the mapping stays
 * 1:1) — only the allocated pixels differ. The oracle is A/B inside one run:
 * a renderer whose ratio changed on the fly must end up with exactly the
 * backing a renderer freshly given that ratio allocates, canvas by canvas. It
 * is an equality, so it needs no threshold and no platform-dependent number.
 *
 * The pose is the mesh probes' deterministic one (`MESH_RIG`, walk, t = 1.2),
 * and the counters are read right after the render they describe — render()
 * resets them on entry.
 */
async function backingProbe(): Promise<BackingProbeResult> {
  const assets = await loadRig(MESH_RIG);
  const frame = frameAt(assets, MESH_POSE.animation, MESH_POSE.time);

  const roots: HTMLElement[] = [];
  const renderers: DomRenderer[] = [];

  /** A renderer with its own root element, ratio set before the first render. */
  function open(ratio: number): { renderer: DomRenderer; root: HTMLElement } {
    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    document.body.appendChild(root);
    const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
    renderer.pixelRatio = ratio;
    roots.push(root);
    renderers.push(renderer);
    return { renderer, root };
  }

  function snapshot(renderer: DomRenderer, root: HTMLElement): BackingSnapshot {
    const canvases = [...root.querySelectorAll('canvas')];
    return {
      backing: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
      css: canvases.map((canvas) => ({ width: canvas.style.width, height: canvas.style.height })),
      reallocCount: renderer.canvasReallocCount,
      meshDrawnCount: renderer.meshCount,
    };
  }

  // A ratio drop on a live renderer, then the same pose once more (the switch
  // must settle: no second reallocation).
  const live = open(2);
  live.renderer.render(frame);
  const liveHigh = snapshot(live.renderer, live.root);
  live.renderer.pixelRatio = 0.5;
  live.renderer.render(frame);
  const liveShrunk = snapshot(live.renderer, live.root);
  live.renderer.render(frame);
  const liveShrunkAgain = snapshot(live.renderer, live.root);

  // The oracle: a renderer that never saw the high ratio.
  const fresh = open(0.5);
  fresh.renderer.render(frame);
  const freshLow = snapshot(fresh.renderer, fresh.root);

  // The other direction, against its own fresh oracle.
  const grown = open(0.5);
  grown.renderer.render(frame);
  grown.renderer.pixelRatio = 2;
  grown.renderer.render(frame);
  const liveGrown = snapshot(grown.renderer, grown.root);
  const freshTwo = open(2);
  freshTwo.renderer.render(frame);
  const freshHigh = snapshot(freshTwo.renderer, freshTwo.root);

  // Grow-only control: the ratio never moves and every mesh bbox shrinks (the
  // same frame at half scale), so the backing must not follow it down.
  const hold = open(1);
  hold.renderer.render(frame);
  const holdBefore = snapshot(hold.renderer, hold.root);
  hold.renderer.render(scaledFrame(frame, 0.5));
  const holdAfter = snapshot(hold.renderer, hold.root);

  const meshCanvasCount = live.root.querySelectorAll('canvas').length;
  for (const renderer of renderers) renderer.dispose();
  for (const root of roots) root.remove();
  assets.dispose();

  return {
    meshCanvasCount,
    liveHigh,
    liveShrunk,
    liveShrunkAgain,
    freshLow,
    liveGrown,
    freshHigh,
    holdBefore,
    holdAfter,
  };
}

/**
 * One load, two players: the regions are cut once, both players draw from the
 * one map, and disposing a player disposes nothing of the assets — the shape
 * a page showing one rig several times has.
 */
async function sharedAssetsProbe(): Promise<SharedAssetsProbeResult> {
  const load = await trackObjectUrls(() => loadModel({ modelUrl: LOADER_RIG }));
  const assets = load.result;

  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  // The second root belongs to this probe; every other probe must still see
  // the page it knows.
  const secondRoot = document.createElement('div');
  secondRoot.style.cssText = 'position: absolute; left: 0; top: 0';
  document.body.append(secondRoot);

  const built = await trackObjectUrls(async () => {
    const first = new RigPlayer(root, assets);
    const second = new RigPlayer(secondRoot, assets, { skin: assets.skins[0] });
    for (const player of [first, second]) {
      player.play(assets.animations[0].name);
      player.seek(0.5);
      player.draw();
    }
    return { first, second };
  });
  const { first, second } = built.result;
  const firstElementCount = root.querySelectorAll('img, canvas').length;
  const secondElementCount = secondRoot.querySelectorAll('img, canvas').length;
  const secondCanvasCount = secondRoot.querySelectorAll('canvas').length;

  first.dispose();
  const aliveAfterFirstDispose = await alive(load.created);
  second.frame(1 / 60);
  const secondElementsAfterFirstDispose = secondRoot.querySelectorAll('img, canvas').length;
  second.dispose();
  secondRoot.remove();

  // Twice: dispose() is documented as idempotent.
  const release = await trackObjectUrls(async () => {
    assets.dispose();
    assets.dispose();
  });

  return {
    createdUrls: load.created,
    playerCreatedUrls: built.created,
    regionCount: assets.regionImages.size,
    firstElementCount,
    secondElementCount,
    secondCanvasCount,
    aliveAfterFirstDispose,
    secondElementsAfterFirstDispose,
    revokedUrls: release.revoked,
    aliveAfter: await alive(load.created),
  };
}

export interface ScaledStageSnapshot {
  /** Backing store of each mesh canvas, in root child (draw) order. */
  backing: Array<{ width: number; height: number }>;
  /** Σ width × height read back from the DOM. */
  domBackingPixels: number;
  /** What renderer.meshBackingPixels reported at the same moment. */
  reportedBackingPixels: number;
  reallocCount: number;
  meshDrawnCount: number;
  pixelRatio: number;
}

/** What one syncPixelRatio() call did to the root's children. */
export interface SyncResidue {
  childCountBefore: number;
  childCountAfter: number;
  /** Slot element tags in root child order, before and after. */
  tagsBefore: string[];
  tagsAfter: string[];
  /** Element-by-element identity (===), in order — a left-behind probe breaks it. */
  sameElements: boolean;
}

/** A syncPixelRatio() call that must change nothing, plus the render after it. */
export interface HeldRatioCase {
  ratioBefore: number;
  returned: number;
  ratioAfter: number;
  /** The harness's own 100 px probe of that root, in CSS px (0 = not laid out). */
  measuredPx: number;
  after: ScaledStageSnapshot;
}

export interface ScaledStageProbeResult {
  devicePixelRatio: number;
  zoom: number;
  meshCanvasCount: number;
  /** The harness's own probe of the scaled root: 100 px × zoom. */
  scaledMeasuredPx: number;
  /** Default ratio under the scaled wrapper — the oversampling state. */
  scaledDefault: ScaledStageSnapshot;
  syncedRatio: number;
  syncedRatioAgain: number;
  /** Right after the sync, before the render that acts on it. */
  afterSync: ScaledStageSnapshot;
  /** The render after the sync, and the render after the second sync. */
  scaledSynced: ScaledStageSnapshot;
  scaledSyncedAgain: ScaledStageSnapshot;
  /** Oracle: a fresh renderer given the synced ratio before its first render. */
  freshScaled: ScaledStageSnapshot;
  residue: SyncResidue;
  /** display:none wrapper: nothing to measure, so nothing may move. */
  hidden: HeldRatioCase;
  /** Negative control: an unscaled root must come back to devicePixelRatio. */
  unscaled: HeldRatioCase;
  /** A ratio a hair off the measured one — inside the deadband, so it holds. */
  deadband: HeldRatioCase;
}

/**
 * syncPixelRatio() against a CSS-scaled stage.
 *
 * Invisible in a rendered frame, like the backing probe above and for the same
 * reason: the picture is correct at any ratio — only the allocated pixels
 * differ. So the oracle is A/B inside one run again. A renderer that synced its
 * ratio under a `scale(z)` wrapper must hold exactly the backing a renderer
 * freshly given that ratio allocates, canvas by canvas; an equality, no
 * threshold, nothing platform-dependent. The residue and the not-laid-out and
 * unscaled controls are what stop that equality from passing vacuously.
 *
 * Pose: the mesh probes' deterministic one (`MESH_RIG`, walk, t = 1.2).
 */
async function scaledStageProbe(): Promise<ScaledStageProbeResult> {
  const assets = await loadRig(MESH_RIG);
  const frame = frameAt(assets, MESH_POSE.animation, MESH_POSE.time);

  const ZOOM = 0.25;
  const PROBE_PX = 100;
  const wrappers: HTMLElement[] = [];
  const renderers: DomRenderer[] = [];

  /**
   * A renderer on its own root, inside a wrapper carrying the CSS transform —
   * the shape a pan/zoom stage has: the renderer is handed the inner element
   * and never sees the scale.
   */
  function open(transform: string, display = ''): { renderer: DomRenderer; root: HTMLElement } {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.transformOrigin = '0 0';
    wrapper.style.transform = transform;
    wrapper.style.display = display;
    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
    wrappers.push(wrapper);
    renderers.push(renderer);
    return { renderer, root };
  }

  /**
   * The harness's own copy of the measurement, independent of the renderer's:
   * it says what the root's on-screen scale really is, which is what keeps the
   * scaled and not-laid-out cases from passing for the wrong reason.
   */
  function measurePx(root: HTMLElement): number {
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = '0';
    box.style.top = '0';
    box.style.width = `${PROBE_PX}px`;
    box.style.height = `${PROBE_PX}px`;
    box.style.visibility = 'hidden';
    root.appendChild(box);
    const rect = box.getBoundingClientRect();
    box.remove();
    return Math.max(rect.width, rect.height);
  }

  function snapshot(renderer: DomRenderer, root: HTMLElement): ScaledStageSnapshot {
    const canvases = [...root.querySelectorAll('canvas')];
    const backing = canvases.map((canvas) => ({ width: canvas.width, height: canvas.height }));
    return {
      backing,
      domBackingPixels: backing.reduce((sum, size) => sum + size.width * size.height, 0),
      reportedBackingPixels: renderer.meshBackingPixels,
      reallocCount: renderer.canvasReallocCount,
      meshDrawnCount: renderer.meshCount,
      pixelRatio: renderer.pixelRatio,
    };
  }

  /** Sync a ratio that must not move, then render once more. */
  function held(renderer: DomRenderer, root: HTMLElement): HeldRatioCase {
    const ratioBefore = renderer.pixelRatio;
    const measuredPx = measurePx(root);
    const returned = renderer.syncPixelRatio();
    const ratioAfter = renderer.pixelRatio;
    renderer.render(frame);
    return { ratioBefore, returned, ratioAfter, measuredPx, after: snapshot(renderer, root) };
  }

  // The stage: a renderer that knows nothing about the wrapper's scale, so its
  // first frame rasters at devicePixelRatio and oversamples by 1/ZOOM.
  const live = open(`scale(${ZOOM})`);
  live.renderer.render(frame);
  const scaledDefault = snapshot(live.renderer, live.root);
  const scaledMeasuredPx = measurePx(live.root);

  // Residue: the slot elements must be the same elements, in the same order,
  // on both sides of the call.
  const before = [...live.root.children];
  const syncedRatio = live.renderer.syncPixelRatio();
  const after = [...live.root.children];
  const residue: SyncResidue = {
    childCountBefore: before.length,
    childCountAfter: after.length,
    tagsBefore: before.map((el) => el.tagName.toLowerCase()),
    tagsAfter: after.map((el) => el.tagName.toLowerCase()),
    sameElements:
      before.length === after.length && before.every((el, index) => el === after[index]),
  };
  const afterSync = snapshot(live.renderer, live.root);

  live.renderer.render(frame);
  const scaledSynced = snapshot(live.renderer, live.root);
  const syncedRatioAgain = live.renderer.syncPixelRatio();
  live.renderer.render(frame);
  const scaledSyncedAgain = snapshot(live.renderer, live.root);

  // The oracle: same scale, same pose, that ratio from the start.
  const fresh = open(`scale(${ZOOM})`);
  fresh.renderer.pixelRatio = syncedRatio;
  fresh.renderer.render(frame);
  const freshScaled = snapshot(fresh.renderer, fresh.root);

  // Not laid out: the marker ratio is one nothing could measure, so a sync that
  // "measured" anything at all would overwrite it.
  const hiddenStage = open(`scale(${ZOOM})`, 'none');
  hiddenStage.renderer.pixelRatio = 3;
  hiddenStage.renderer.render(frame);
  const hidden = held(hiddenStage.renderer, hiddenStage.root);

  // Negative control: no transform above the root at all.
  const plain = open('');
  plain.renderer.render(frame);
  const unscaled = held(plain.renderer, plain.root);

  // Deadband: 0.04% off the measured ratio — a real difference, too small to
  // be worth recreating every GPU surface for.
  const near = open(`scale(${ZOOM})`);
  near.renderer.pixelRatio = syncedRatio * 1.0004;
  near.renderer.render(frame);
  const deadband = held(near.renderer, near.root);

  const meshCanvasCount = live.root.querySelectorAll('canvas').length;
  for (const renderer of renderers) renderer.dispose();
  for (const wrapper of wrappers) wrapper.remove();
  assets.dispose();

  return {
    devicePixelRatio: window.devicePixelRatio,
    zoom: ZOOM,
    meshCanvasCount,
    scaledMeasuredPx,
    scaledDefault,
    syncedRatio,
    syncedRatioAgain,
    afterSync,
    scaledSynced,
    scaledSyncedAgain,
    freshScaled,
    residue,
    hidden,
    unscaled,
    deadband,
  };
}

// --- webgl page-texture lifetime -------------------------------------------

/**
 * The shared GL blitter outlives every renderer, so its page textures are the
 * one thing a consumer cannot free by dropping objects. They are
 * reference-counted per page instead, and this probe drives the lifetime from
 * the outside: load, render, dispose, and read the blitter's live-texture
 * count at each step. The count is the oracle because GPU memory is not
 * observable from script — see tests/gl-textures.spec.ts for the assertions.
 */

/**
 * The mesh probes' rig and pose: the figure test rig built `--pack`, so its
 * two meshes draw from one page (one GL texture), posed mid-walk.
 */
const MESH_RIG = 'figure-packed';
const MESH_POSE = { animation: 'walk', time: 1.2 } as const;

export interface GlCycleSample {
  before: number;
  afterRender: number;
  afterRendererDispose: number;
  afterAssetsDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlSharingSample {
  afterBothRendered: number;
  /** Read before the survivor redraws: the page must still be uploaded. */
  afterFirstDispose: number;
  afterSecondRender: number;
  afterSecondDispose: number;
  pixelsBeforeFirstDispose: number;
  pixelsAfterFirstDispose: number;
  /** Meshes the survivor re-rasterized — 0 would mean the redraw was skipped. */
  meshesRedrawn: number;
}

export interface GlIdempotenceSample {
  afterBothRendered: number;
  afterFirstDispose: number;
  afterFirstDisposedTwice: number;
  afterSecondDispose: number;
  loneAfterRender: number;
  loneAfterDisposedTwice: number;
}

export interface GlCanvas2dSample {
  before: number;
  afterRender: number;
  afterDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlReuseSample {
  beforeNewRenderer: number;
  afterNewRendererRender: number;
  afterDispose: number;
  backendActive: string;
  meshPixels: number;
}

export interface GlTextureProbeResult {
  /** False when this engine has no WebGL at all — the spec then skips loudly. */
  webglAvailable: boolean;
  /** Live page textures before the probe ran (0 on a fresh page). */
  baseline: number;
  cycles: GlCycleSample[];
  sharing: GlSharingSample | null;
  idempotence: GlIdempotenceSample | null;
  canvas2dOnly: GlCanvas2dSample | null;
  reuse: GlReuseSample | null;
  /** Live page textures once every renderer above is disposed. */
  final: number;
}

/** Live GL page textures, or -1 if the shared context died mid-probe. */
function liveGlTextures(): number {
  return getMeshGlBlitter()?.liveTextureCount ?? -1;
}

/** One deterministic pose of the mesh rig. */
function posedFrame(assets: ModelAssets): PosedFrame {
  return frameAt(assets, MESH_POSE.animation, MESH_POSE.time);
}

/** A root per renderer: several are alive at once here, unlike #root. */
function makeGlRoot(): HTMLElement {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  return root;
}

/**
 * Non-transparent pixels across a root's mesh canvases. "The renderer still
 * draws" has no counter, so this is its oracle: a released-too-early page
 * texture would blank (or change) the raster.
 */
function meshPixels(root: HTMLElement): number {
  let count = 0;
  for (const canvas of root.querySelectorAll('canvas')) {
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
  }
  return count;
}

async function glTextureProbe(): Promise<GlTextureProbeResult> {
  if (!getMeshGlBlitter()) {
    return {
      webglAvailable: false,
      baseline: 0,
      cycles: [],
      sharing: null,
      idempotence: null,
      canvas2dOnly: null,
      reuse: null,
      final: 0,
    };
  }
  const baseline = liveGlTextures();

  // Load → render → dispose, three times, each with its own page image: on a
  // blitter that never releases, the count climbs by one per cycle.
  const cycles: GlCycleSample[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = liveGlTextures();
    const assets = await loadRig(MESH_RIG);
    const root = makeGlRoot();
    const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
    renderer.meshBackend = 'webgl';
    renderer.render(posedFrame(assets));
    const afterRender = liveGlTextures();
    const backendActive = renderer.meshBackendActive;
    const pixels = meshPixels(root);
    renderer.dispose();
    const afterRendererDispose = liveGlTextures();
    assets.dispose();
    const afterAssetsDispose = liveGlTextures();
    root.remove();
    cycles.push({
      before,
      afterRender,
      afterRendererDispose,
      afterAssetsDispose,
      backendActive,
      meshPixels: pixels,
    });
  }

  // One load for everything below: sharing, idempotence and re-use all turn
  // on several renderers meeting on the same page image.
  const assets = await loadRig(MESH_RIG);

  // Sharing: disposing one user must not take the page from the other.
  const rootA = makeGlRoot();
  const rootB = makeGlRoot();
  const rendererA = new DomRenderer(rootA, assets.regionImages, assets.pageImages);
  const rendererB = new DomRenderer(rootB, assets.regionImages, assets.pageImages);
  rendererA.meshBackend = 'webgl';
  rendererB.meshBackend = 'webgl';
  const frameB = posedFrame(assets);
  rendererA.render(posedFrame(assets));
  rendererB.render(frameB);
  const sharingAfterBoth = liveGlTextures();
  const pixelsBeforeFirstDispose = meshPixels(rootB);
  rendererA.dispose();
  const sharingAfterFirstDispose = liveGlTextures();
  // Re-dirty every mesh first: reusing last frame's raster would prove
  // nothing about the texture still being there.
  rendererB.triangleExpand = 0;
  rendererB.render(frameB);
  const meshesRedrawn = rendererB.meshCount;
  const pixelsAfterFirstDispose = meshPixels(rootB);
  const sharingAfterSecondRender = liveGlTextures();
  rendererB.dispose();
  const sharingAfterSecondDispose = liveGlTextures();
  rootA.remove();
  rootB.remove();

  // Idempotence, with a second user present so a double release is visible:
  // without one, the second decrement would find nothing to delete anyway.
  const rootC = makeGlRoot();
  const rootD = makeGlRoot();
  const rendererC = new DomRenderer(rootC, assets.regionImages, assets.pageImages);
  const rendererD = new DomRenderer(rootD, assets.regionImages, assets.pageImages);
  rendererC.meshBackend = 'webgl';
  rendererD.meshBackend = 'webgl';
  rendererC.render(posedFrame(assets));
  rendererD.render(posedFrame(assets));
  const idemAfterBoth = liveGlTextures();
  rendererC.dispose();
  const idemAfterFirstDispose = liveGlTextures();
  rendererC.dispose();
  const idemAfterFirstDisposedTwice = liveGlTextures();
  rendererD.dispose();
  const idemAfterSecondDispose = liveGlTextures();
  rootC.remove();
  rootD.remove();

  const rootE = makeGlRoot();
  const rendererE = new DomRenderer(rootE, assets.regionImages, assets.pageImages);
  rendererE.meshBackend = 'webgl';
  rendererE.render(posedFrame(assets));
  const loneAfterRender = liveGlTextures();
  rendererE.dispose();
  rendererE.dispose();
  const loneAfterDisposedTwice = liveGlTextures();
  rootE.remove();

  // A renderer that never leaves canvas2d retains and releases nothing.
  const canvas2dBefore = liveGlTextures();
  const rootF = makeGlRoot();
  const rendererF = new DomRenderer(rootF, assets.regionImages, assets.pageImages);
  rendererF.render(posedFrame(assets));
  const canvas2dAfterRender = liveGlTextures();
  const canvas2dBackend = rendererF.meshBackendActive;
  const canvas2dPixels = meshPixels(rootF);
  rendererF.dispose();
  const canvas2dAfterDispose = liveGlTextures();
  rootF.remove();

  // Re-use after release: the page image is still alive, so a new renderer
  // must simply upload it again and draw.
  const reuseBefore = liveGlTextures();
  const rootG = makeGlRoot();
  const rendererG = new DomRenderer(rootG, assets.regionImages, assets.pageImages);
  rendererG.meshBackend = 'webgl';
  rendererG.render(posedFrame(assets));
  const reuseAfterRender = liveGlTextures();
  const reuseBackend = rendererG.meshBackendActive;
  const reusePixels = meshPixels(rootG);
  rendererG.dispose();
  const reuseAfterDispose = liveGlTextures();
  rootG.remove();

  assets.dispose();

  return {
    webglAvailable: true,
    baseline,
    cycles,
    sharing: {
      afterBothRendered: sharingAfterBoth,
      afterFirstDispose: sharingAfterFirstDispose,
      afterSecondRender: sharingAfterSecondRender,
      afterSecondDispose: sharingAfterSecondDispose,
      pixelsBeforeFirstDispose,
      pixelsAfterFirstDispose,
      meshesRedrawn,
    },
    idempotence: {
      afterBothRendered: idemAfterBoth,
      afterFirstDispose: idemAfterFirstDispose,
      afterFirstDisposedTwice: idemAfterFirstDisposedTwice,
      afterSecondDispose: idemAfterSecondDispose,
      loneAfterRender,
      loneAfterDisposedTwice,
    },
    canvas2dOnly: {
      before: canvas2dBefore,
      afterRender: canvas2dAfterRender,
      afterDispose: canvas2dAfterDispose,
      backendActive: canvas2dBackend,
      meshPixels: canvas2dPixels,
    },
    reuse: {
      beforeNewRenderer: reuseBefore,
      afterNewRendererRender: reuseAfterRender,
      afterDispose: reuseAfterDispose,
      backendActive: reuseBackend,
      meshPixels: reusePixels,
    },
    final: liveGlTextures(),
  };
}

// --- concurrent region cuts -------------------------------------------------

/**
 * unpackRegions starts the region cuts together and awaits them together, so
 * the properties that used to fall out of a serial loop — atlas order,
 * last-duplicate-wins, nothing stranded by a failure — now have to be held
 * deliberately. None of that is visible in a rendered frame either, and none of
 * it can be timed: the oracle is `HTMLCanvasElement.prototype.toBlob` itself,
 * wrapped so the probes can count how many encodes overlap and choose the order
 * the callbacks come back in.
 */

/** Six small regions, none covering its page, so every one of them is cut. */
const CONCURRENT_ATLAS = `part.png
size: 64, 32
a
bounds: 0, 0, 16, 16
b
bounds: 16, 0, 16, 16
c
bounds: 32, 0, 16, 16
d
bounds: 48, 0, 16, 16
e
bounds: 0, 16, 16, 16
f
bounds: 16, 16, 16, 16
`;

/**
 * Six 1024×1024 cuts off one 2048×1024 page — 6.29 Mpx of canvas backing if
 * they all ran at once, which is what makes the backing budget observable.
 * They overlap in the page on purpose; only the cut sizes matter here.
 */
const BUDGET_ATLAS = `wide.png
size: 2048, 1024
w0
bounds: 0, 0, 1024, 1024
w1
bounds: 1, 0, 1024, 1024
w2
bounds: 2, 0, 1024, 1024
w3
bounds: 3, 0, 1024, 1024
w4
bounds: 4, 0, 1024, 1024
w5
bounds: 5, 0, 1024, 1024
`;

/** Six cuts of six different sizes: a blob landing in the wrong slot shows. */
const ORDERED_ATLAS = `part.png
size: 64, 32
r0
bounds: 0, 0, 10, 4
r1
bounds: 0, 5, 11, 5
r2
bounds: 0, 11, 12, 6
r3
bounds: 0, 18, 13, 7
r4
bounds: 20, 0, 14, 8
r5
bounds: 20, 9, 15, 9
`;

/** The same name twice, at different sizes, so the winner is identifiable. */
const DUPLICATE_ATLAS = `part.png
size: 64, 32
dup
bounds: 0, 0, 20, 20
solo
bounds: 24, 0, 12, 12
dup
bounds: 40, 0, 8, 8
`;

/** Four cuts; the first one is the one the trap answers with null. */
const IN_FLIGHT_FAIL_ATLAS = `part.png
size: 64, 32
boom
bounds: 0, 0, 16, 16
held-a
bounds: 16, 0, 16, 16
held-b
bounds: 32, 0, 16, 16
held-c
bounds: 48, 0, 16, 16
`;

/** What one instrumented run saw at HTMLCanvasElement.prototype.toBlob. */
export interface CutTrapReport {
  /** toBlob calls started. */
  callCount: number;
  /** Backing pixels of each canvas at call time, in call order. */
  callPixels: number[];
  /** Highest (started − delivered) reached: 1 means the cuts ran in series. */
  peakInFlight: number;
  /** Highest Σ backing pixels held by those simultaneously in-flight cuts. */
  peakInFlightPixels: number;
  /** Call indices in the order their callbacks were finally delivered. */
  deliveryOrder: number[];
  /** True when a hold-and-reverse trap gave up waiting for every call. */
  deadlineHit: boolean;
}

/** How a trap hands the encoded blobs back to unpackRegions. */
type CutDelivery =
  /** Straight through — the trap only counts. */
  | { kind: 'immediate' }
  /** Hold every blob until `expected` have arrived, then deliver them backwards. */
  | { kind: 'reverse'; expected: number; deadlineMs: number }
  /** Answer call `nullAt` with null at once, hold the rest until release(). */
  | { kind: 'failOne'; nullAt: number };

interface CutTrap {
  /** The counters as they stand right now. */
  snapshot(): CutTrapReport;
  /** Cuts started whose callback has not been delivered yet. */
  inFlight(): number;
  /** Resolves once the nulled callback has been delivered ('failOne'). */
  nulled: Promise<void>;
  /** Delivers everything still held ('failOne'). */
  release(): void;
  restore(): void;
}

function installCutTrap(delivery: CutDelivery): CutTrap {
  const real = HTMLCanvasElement.prototype.toBlob;
  const callPixels: number[] = [];
  const deliveryOrder: number[] = [];
  const held: Array<{ index: number; run: () => void }> = [];
  let inFlight = 0;
  let inFlightPixels = 0;
  let peakInFlight = 0;
  let peakInFlightPixels = 0;
  let deadlineHit = false;
  let released = false;
  let timer = 0;
  let resolveNulled = (): void => {};
  const nulled = new Promise<void>((resolve) => {
    resolveNulled = resolve;
  });

  const send = (index: number, run: () => void): void => {
    deliveryOrder.push(index);
    inFlight--;
    inFlightPixels -= callPixels[index] ?? 0;
    run();
  };

  const flush = (reverse: boolean): void => {
    const batch = held.splice(0, held.length);
    if (reverse) batch.reverse();
    for (const entry of batch) send(entry.index, entry.run);
  };

  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ): void {
    const index = callPixels.length;
    const pixels = this.width * this.height;
    callPixels.push(pixels);
    inFlight++;
    inFlightPixels += pixels;
    peakInFlight = Math.max(peakInFlight, inFlight);
    peakInFlightPixels = Math.max(peakInFlightPixels, inFlightPixels);

    real.call(
      this,
      (blob) => {
        if (delivery.kind === 'immediate') {
          send(index, () => callback(blob));
          return;
        }
        if (delivery.kind === 'failOne') {
          if (index === delivery.nullAt) {
            send(index, () => callback(null));
            resolveNulled();
            return;
          }
          // Past release() the encodes that had not called back yet are the
          // latest arrivals of all, so they go straight through — holding them
          // would only mean nothing ever delivers them.
          if (released) send(index, () => callback(blob));
          else held.push({ index, run: () => callback(blob) });
          return;
        }
        held.push({ index, run: () => callback(blob) });
        clearTimeout(timer);
        if (held.length >= delivery.expected) {
          flush(true);
          return;
        }
        // A serial implementation never gets `expected` encodes in flight, so
        // the trap must not be able to deadlock it: it delivers what it has.
        timer = window.setTimeout(() => {
          deadlineHit = true;
          flush(true);
        }, delivery.deadlineMs);
      },
      type,
      quality as never,
    );
  } as typeof HTMLCanvasElement.prototype.toBlob;

  return {
    snapshot: () => ({
      callCount: callPixels.length,
      callPixels: [...callPixels],
      peakInFlight,
      peakInFlightPixels,
      deliveryOrder: [...deliveryOrder],
      deadlineHit,
    }),
    inFlight: () => inFlight,
    nulled,
    release: () => {
      released = true;
      flush(false);
    },
    restore: () => {
      clearTimeout(timer);
      HTMLCanvasElement.prototype.toBlob = real;
    },
  };
}

/** Reads an atlas text into a page layout and paints one image per page. */
async function paintAtlas(
  text: string,
  sizes: Record<string, { width: number; height: number }>,
): Promise<{
  layout: PageLayout[];
  pageImages: Map<string, HTMLImageElement>;
  pageUrls: string[];
}> {
  const layout = parseAtlas(text);
  const pageImages = new Map<string, HTMLImageElement>();
  const pageUrls: string[] = [];
  for (const page of layout) {
    const size = sizes[page.name] ?? { width: page.width, height: page.height };
    const painted = await makePageImage(size.width, size.height);
    pageImages.set(page.name, painted.image);
    pageUrls.push(painted.url);
  }
  return { layout, pageImages, pageUrls };
}

export interface CutConcurrencySample {
  regionCount: number;
  cuts: CutTrapReport;
  /** Σ backing pixels of every cut, i.e. the peak an unbounded run would hit. */
  totalCutPixels: number;
}

export interface CutConcurrencyProbeResult {
  /** Six 16×16 cuts: far under the backing budget, so all of them overlap. */
  small: CutConcurrencySample;
  /** Six 1024×1024 cuts: more backing than the budget allows in flight. */
  budgeted: CutConcurrencySample;
  /** A real packed build, through loadModel: the figure test rig's one shared page. */
  packed: CutConcurrencySample;
}

/**
 * How many region cuts have a PNG encode in flight at once, and how much canvas
 * backing they hold while they do.
 *
 * The count is the whole defect: awaited one at a time it is 1, and a load then
 * costs the sum of every encode — minutes in a throttled background tab, where
 * one 8×8 toBlob was measured taking 7.5 s to call back. The pixels are the
 * price of fixing it, since every started cut keeps its canvas alive until its
 * blob arrives; they are what the backing budget in DomTexture.ts bounds.
 */
async function cutConcurrencyProbe(): Promise<CutConcurrencyProbeResult> {
  async function measure(
    text: string,
    sizes: Record<string, { width: number; height: number }>,
  ): Promise<CutConcurrencySample> {
    const painted = await paintAtlas(text, sizes);
    const trap = installCutTrap({ kind: 'immediate' });
    let images: Map<string, RegionImage>;
    try {
      images = await unpackRegions(painted.layout, painted.pageImages);
    } finally {
      trap.restore();
    }
    revokeRegions(images);
    for (const url of painted.pageUrls) URL.revokeObjectURL(url);
    const cuts = trap.snapshot();
    return {
      regionCount: layoutRegions(painted.layout).length,
      cuts,
      totalCutPixels: cuts.callPixels.reduce((sum, pixels) => sum + pixels, 0),
    };
  }

  const small = await measure(CONCURRENT_ATLAS, {});
  const budgeted = await measure(BUDGET_ATLAS, {});

  // The real thing: a rigc `--pack` build, one shared page, every region cut.
  const trap = installCutTrap({ kind: 'immediate' });
  let assets: ModelAssets;
  try {
    assets = await loadRig(RIGID_RIG);
  } finally {
    trap.restore();
  }
  const packedCuts = trap.snapshot();
  const packed: CutConcurrencySample = {
    regionCount: layoutRegions(pageLayoutOf(assets)).length,
    cuts: packedCuts,
    totalCutPixels: packedCuts.callPixels.reduce((sum, pixels) => sum + pixels, 0),
  };
  assets.dispose();

  return { small, budgeted, packed };
}

export interface CutOrderProbeResult {
  /** Region names in atlas order, and the map's key order beside them. */
  atlasNames: string[];
  mapNames: string[];
  regions: RegionEntry[];
  order: CutTrapReport;
  /** Duplicate-name run, same reversed delivery. */
  dupAtlasNames: string[];
  dupMapNames: string[];
  dupRegions: RegionEntry[];
  dupOrder: CutTrapReport;
  dupCreatedUrls: string[];
  /** Liveness of every URL the duplicate run minted, before anything revoked. */
  dupAliveAfterUnpack: Record<string, boolean>;
}

/**
 * Atlas order and last-duplicate-wins, with the blobs deliberately delivered
 * backwards.
 *
 * Concurrent encodes come back in whatever order the browser finishes them, so
 * "the map is in atlas order" stops being something the loop gives away for
 * free. Hoping for out-of-order delivery would make this a lottery, so the trap
 * forces it: it holds every blob until all of them have arrived, then hands
 * them back last-first.
 */
async function cutOrderProbe(): Promise<CutOrderProbeResult> {
  async function run(
    text: string,
    expected: number,
  ): Promise<{
    atlasNames: string[];
    regions: RegionEntry[];
    report: CutTrapReport;
    created: string[];
    images: Map<string, RegionImage>;
    pageUrls: string[];
  }> {
    const painted = await paintAtlas(text, {});
    const trap = installCutTrap({ kind: 'reverse', expected, deadlineMs: 750 });
    let unpacked: { result: Map<string, RegionImage>; created: string[]; revoked: string[] };
    try {
      unpacked = await trackObjectUrls(() => unpackRegions(painted.layout, painted.pageImages));
    } finally {
      trap.restore();
    }
    return {
      atlasNames: layoutRegions(painted.layout).map((region) => region.name),
      regions: entries(unpacked.result),
      report: trap.snapshot(),
      created: unpacked.created,
      images: unpacked.result,
      pageUrls: painted.pageUrls,
    };
  }

  const ordered = await run(ORDERED_ATLAS, 6);
  revokeRegions(ordered.images);
  for (const url of ordered.pageUrls) URL.revokeObjectURL(url);

  const dup = await run(DUPLICATE_ATLAS, 3);
  // Sampled before anything is revoked: the shadowed URL must already be dead,
  // freed by unpackRegions when the later region of the same name took over.
  const dupAliveAfterUnpack = await alive(dup.created);
  revokeRegions(dup.images);
  for (const url of dup.pageUrls) URL.revokeObjectURL(url);

  return {
    atlasNames: ordered.atlasNames,
    mapNames: ordered.regions.map((region) => region.name),
    regions: ordered.regions,
    order: ordered.report,
    dupAtlasNames: dup.atlasNames,
    dupMapNames: dup.regions.map((region) => region.name),
    dupRegions: dup.regions,
    dupOrder: dup.report,
    dupCreatedUrls: dup.created,
    dupAliveAfterUnpack,
  };
}

export interface CutFlightFailureProbeResult {
  /** Message unpackRegions rejected with ('' if it resolved). */
  message: string;
  /** Cuts started but not yet delivered when the failing one came back null. */
  inFlightAtFailure: number;
  /** Cuts whose blob was still held when the failure had already been seen. */
  createdUrls: string[];
  revokedUrls: string[];
  /** Sampled after every held callback was delivered and the call settled. */
  aliveAfter: Record<string, boolean>;
  /** unhandledrejection events seen for the whole attempt. */
  unhandledRejections: number;
  cuts: CutTrapReport;
}

/**
 * A cut that fails while the others are still encoding.
 *
 * This is the failure the serial loop could not have: its blobs arrive after
 * the error is already known, and a load that walked away from them would mint
 * owned blob URLs with nothing left to revoke them. The trap answers the first
 * region with null (what a browser does when it cannot encode) and holds the
 * other three until the probe releases them, so the late arrivals are forced
 * rather than raced. Liveness is sampled only after they have landed.
 */
async function cutFlightFailureProbe(): Promise<CutFlightFailureProbeResult> {
  const painted = await paintAtlas(IN_FLIGHT_FAIL_ATLAS, {});

  let unhandledRejections = 0;
  const onUnhandled = (): void => {
    unhandledRejections++;
  };
  window.addEventListener('unhandledrejection', onUnhandled);

  const trap = installCutTrap({ kind: 'failOne', nullAt: 0 });
  let inFlightAtFailure = 0;
  let attempt: { result: string; created: string[]; revoked: string[] };
  try {
    attempt = await trackObjectUrls(async () => {
      const settled = unpackRegions(painted.layout, painted.pageImages).then(
        () => '',
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      await trap.nulled;
      inFlightAtFailure = trap.inFlight();
      // One macrotask for the failure path to get as far as it can, which is
      // as far as the cuts it still has to wait for.
      await new Promise((resolve) => setTimeout(resolve, 0));
      trap.release();
      return await settled;
    });
  } finally {
    trap.restore();
  }

  // An unhandled rejection is reported a task later than the rejection itself.
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.removeEventListener('unhandledrejection', onUnhandled);

  const aliveAfter = await alive(attempt.created);
  for (const url of painted.pageUrls) URL.revokeObjectURL(url);

  return {
    message: attempt.result,
    inFlightAtFailure,
    createdUrls: attempt.created,
    revokedUrls: attempt.revoked,
    aliveAfter,
    unhandledRejections,
    cuts: trap.snapshot(),
  };
}

/**
 * Pages that ship at a resolution their atlas does not declare.
 *
 * Half-resolution texture builds and @2x variants leave the `size:` line
 * alone, so the declared page size and the image's pixel size disagree. The
 * mesh tier never noticed — spine-core's UVs are normalized against the
 * declared size and both raster backends address texels as `uv * size` off the
 * actual image — while the rigid cut used to take the region's bounds as image
 * pixels, so every rigid part of such a skeleton came out of the wrong
 * rectangle. Pixels are the oracle here: each region is a distinct flat
 * colour, so a cut from the wrong rect mixes colours and a rotation read the
 * wrong way is the wrong aspect or transparent.
 */

/**
 * Four regions tiling one page (one of them packed rotated), one whole-page
 * page for the pass-through, and one page whose interior boundary lands
 * mid-pixel at half resolution.
 */
const SCALED_PAGE_ATLAS = `art.png
size: 64, 32
tl
bounds: 0, 0, 32, 16
tr
bounds: 32, 0, 32, 16
rot
bounds: 0, 16, 16, 32
rotate: true
br
bounds: 32, 16, 32, 16

whole.png
size: 24, 16
whole
bounds: 0, 0, 24, 16

odd.png
size: 64, 32
odd-left
bounds: 0, 0, 31, 32
odd-right
bounds: 31, 0, 33, 32
`;

/** One flat colour per region of SCALED_PAGE_ATLAS. */
const SCALED_PAGE_COLORS: Record<string, string> = {
  tl: '#ff0000',
  tr: '#00ff00',
  rot: '#0000ff',
  br: '#ffff00',
  whole: '#ff00ff',
  'odd-left': '#00ffff',
  'odd-right': '#ffffff',
};

export interface ScaledCutEntry {
  name: string;
  /** RegionImage.width/height: atlas units, whatever the page ships at. */
  width: number;
  height: number;
  /** Natural size of the bitmap behind RegionImage.url. */
  pixelWidth: number;
  pixelHeight: number;
  /** '#rrggbbaa' of the bitmap's first pixel. */
  color: string;
  /** Whether every other pixel of it matches that one. */
  uniform: boolean;
  /** True when the URL is the page image's own — the whole-page pass-through. */
  passedThrough: boolean;
}

export interface ScaledPageSample {
  /** Pixel size each page image was actually painted at, by page name. */
  pageSizes: Record<string, { width: number; height: number }>;
  /** URLs unpackRegions minted for this resolution. */
  mintedCount: number;
  regions: ScaledCutEntry[];
}

export interface ScaledPageProbeResult {
  /** The declared page sizes, straight off the parsed atlas. */
  declared: Record<string, { width: number; height: number }>;
  half: ScaledPageSample;
  natural: ScaledPageSample;
  double: ScaledPageSample;
}

/**
 * Paints one page of SCALED_PAGE_ATLAS at `scale` × its declared size.
 *
 * Each region's *packed* rect is filled with its own colour, snapped to whole
 * pixels the way a packer exporting at this scale would have to. Every
 * resolution is painted from the region table, never resampled from another
 * one, so a bitmap that came out of the wrong rectangle cannot be excused as a
 * filtering artefact.
 *
 */
async function paintScaledPage(
  page: { width: number; height: number },
  regions: ReadonlyArray<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    degrees: number;
  }>,
  scale: number,
): Promise<{ image: HTMLImageElement; url: string; width: number; height: number }> {
  const width = Math.round(page.width * scale);
  const height = Math.round(page.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  for (const region of regions) {
    const rotated = region.degrees === 90;
    const packedW = rotated ? region.height : region.width;
    const packedH = rotated ? region.width : region.height;
    const x0 = Math.round(region.x * scale);
    const y0 = Math.round(region.y * scale);
    ctx.fillStyle = SCALED_PAGE_COLORS[region.name] ?? '#000000';
    ctx.fillRect(
      x0,
      y0,
      Math.round((region.x + packedW) * scale) - x0,
      Math.round((region.y + packedH) * scale) - y0,
    );
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const url = URL.createObjectURL(blob);
  return { image: await loadImage(url), url, width, height };
}

/** Reads a bitmap back: its natural size, its first pixel, and whether it is flat. */
async function readBitmap(
  url: string,
): Promise<{ width: number; height: number; color: string; uniform: boolean }> {
  const image = await loadImage(url);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const hex = (offset: number): string =>
    [...data.slice(offset, offset + 4)]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('');
  let uniform = true;
  for (let offset = 4; offset < data.length; offset += 4) {
    if (
      data[offset] !== data[0] ||
      data[offset + 1] !== data[1] ||
      data[offset + 2] !== data[2] ||
      data[offset + 3] !== data[3]
    ) {
      uniform = false;
      break;
    }
  }
  return { width, height, color: `#${hex(0)}`, uniform };
}

async function scaledPageProbe(): Promise<ScaledPageProbeResult> {
  async function measure(scale: number): Promise<ScaledPageSample> {
    const layout = parseAtlas(SCALED_PAGE_ATLAS);
    const pageImages = new Map<string, HTMLImageElement>();
    const pageUrls: string[] = [];
    const pageSizes: Record<string, { width: number; height: number }> = {};
    for (const page of layout) {
      const painted = await paintScaledPage(page, page.regions, scale);
      pageImages.set(page.name, painted.image);
      pageUrls.push(painted.url);
      pageSizes[page.name] = { width: painted.width, height: painted.height };
    }

    const unpacked = await trackObjectUrls(() => unpackRegions(layout, pageImages));
    const pageUrlSet = new Set(pageUrls);
    const regions: ScaledCutEntry[] = [];
    for (const [name, region] of unpacked.result) {
      const bitmap = await readBitmap(region.url);
      regions.push({
        name,
        width: region.width,
        height: region.height,
        pixelWidth: bitmap.width,
        pixelHeight: bitmap.height,
        color: bitmap.color,
        uniform: bitmap.uniform,
        passedThrough: pageUrlSet.has(region.url),
      });
    }

    revokeRegions(unpacked.result);
    for (const url of pageUrls) URL.revokeObjectURL(url);
    return { pageSizes, mintedCount: unpacked.created.length, regions };
  }

  const declared: Record<string, { width: number; height: number }> = {};
  for (const page of parseAtlas(SCALED_PAGE_ATLAS)) {
    declared[page.name] = { width: page.width, height: page.height };
  }

  return {
    declared,
    half: await measure(0.5),
    natural: await measure(1),
    double: await measure(2),
  };
}

export interface RigidBox {
  /** The <img> width/height content attributes — its layout box. */
  attrWidth: number;
  attrHeight: number;
  /** The bitmap actually behind it. */
  naturalWidth: number;
  naturalHeight: number;
  /** Its on-screen box, in the root's own coordinates. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface HalfResRenderProbeResult {
  /** Declared page size, and the pixel size each run's page image shipped at. */
  declared: { width: number; height: number };
  fullPage: { width: number; height: number };
  halfPage: { width: number; height: number };
  full: RigidBox[];
  half: RigidBox[];
}

/**
 * The rigid tier through the public render path, against a page image shipped
 * at half the declared size.
 *
 * A packed rigc build (`RIGID_RIG`), its page repainted at 0.5× — the shape a
 * project ships when it exports textures at half resolution and leaves the
 * page's declared size untouched.
 * `renderRegion` writes `RegionImage.width/height` onto the <img> and divides
 * the world corners by them, so as long as those stay in atlas units the
 * layout box and the CSS matrix cannot move; only the bitmap inside them gets
 * smaller. That is the claim this measures, rather than assuming it.
 */
async function halfResRenderProbe(): Promise<HalfResRenderProbeResult> {
  const source = await rigidPageSource();
  const fullPage = source.page;
  const halfCanvas = document.createElement('canvas');
  halfCanvas.width = Math.round(fullPage.naturalWidth / 2);
  halfCanvas.height = Math.round(fullPage.naturalHeight / 2);
  const halfCtx = halfCanvas.getContext('2d');
  if (!halfCtx) throw new Error('2d context unavailable');
  halfCtx.drawImage(fullPage, 0, 0, halfCanvas.width, halfCanvas.height);
  const halfBlob = await new Promise<Blob>((resolve, reject) => {
    halfCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const halfPageUrl = URL.createObjectURL(halfBlob);

  const root = document.createElement('div');
  root.style.cssText = 'position: absolute; left: 0; top: 0';
  document.body.append(root);

  async function run(resolvePage?: () => string): Promise<RigidBox[]> {
    const assets = await loadRig(RIGID_RIG, resolvePage ? { resolvePage } : {});
    const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
    renderer.render(rigidOnly(frameAt(assets, RIGID_POSE.animation, RIGID_POSE.time)));

    const images = [...root.querySelectorAll('img')];
    // naturalWidth is 0 until the blob decodes, and it is half of the point.
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
    const rootBox = root.getBoundingClientRect();
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    const boxes = images.map((image) => {
      const box = image.getBoundingClientRect();
      return {
        attrWidth: image.width,
        attrHeight: image.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        rect: {
          x: round(box.x - rootBox.x),
          y: round(box.y - rootBox.y),
          width: round(box.width),
          height: round(box.height),
        },
      };
    });

    renderer.dispose();
    root.replaceChildren();
    assets.dispose();
    return boxes;
  }

  const full = await run();
  const half = await run(() => halfPageUrl);
  root.remove();
  URL.revokeObjectURL(halfPageUrl);

  const atlasPage = source.layout[0];

  return {
    declared: { width: atlasPage?.width ?? 0, height: atlasPage?.height ?? 0 },
    fullPage: { width: fullPage.naturalWidth, height: fullPage.naturalHeight },
    halfPage: { width: halfCanvas.width, height: halfCanvas.height },
    full,
    half,
  };
}

// --- how a cut locates its pixels on a rescaled page (#35) -----------------

/**
 * A capturable stage for comparing cut rules against the 1:1 page.
 *
 * When a page ships at a resolution its atlas does not declare, a region's
 * rect on the image is fractional. `planCut` rounds each *edge* of it to a
 * whole image pixel: every cut stays a lossless 1:1 copy and neighbours keep
 * tiling exactly, at the price of up to half an image pixel of placement (and
 * the matching slight stretch, since the bitmap is laid into an atlas-unit
 * box). The other rule available is the one normalized UVs describe — sample
 * the fractional rect with interpolation: exact placement, paid for with a
 * resample of the whole bitmap.
 *
 * Which one lands closer to the truth is a measurement, and this is the
 * instrument: the same frozen rigid-only pose, in the same stage, drawn from
 * the page at 1:1 (the reference) and from a rescaled page under each rule, so
 * the only variable is where the cut read its pixels. The DOM geometry is
 * identical across all of them — `renderRegion` reads atlas units and nothing
 * about the bitmap — so what a diff of two captures sees is texture placement
 * and nothing else.
 *
 * `shifted` is the control: the shipped rule with every rect displaced one
 * whole image pixel. It has to score clearly worse than both real rules, or
 * the instrument cannot see placement at all and no verdict from it means
 * anything.
 *
 * The specs screenshot `#cut-rule-stage` between calls, so each call opens by
 * tearing down what the previous one left there.
 */

/** The shipped rule, the alternative, and the deliberately wrong control. */
export type CutRule = 'edge' | 'fractional' | 'shifted';

export interface CutRuleStageOptions {
  /** Page image resolution, as a multiple of the declared size. 1 = as shipped. */
  pageScale: number;
  rule: CutRule;
  /** Frozen pose: an animation of the rigid rig (`RIGID_RIG`, its rigid slots only), seeked to `time`. */
  animation: string;
  time: number;
}

export interface CutRuleStageResult {
  /** The atlas `size:` line, which no page scale changes. */
  declaredPage: { width: number; height: number };
  /** What the page image this run cut from actually measures. */
  pageSize: { width: number; height: number };
  /** Slots drawn, and Σ of the natural pixels behind them. */
  imageCount: number;
  bitmapPixels: number;
  /** Union of the slot boxes, in stage coordinates — the stage must contain it. */
  contentBox: { x: number; y: number; width: number; height: number };
}

/** Stage geometry. The pose is drawn at half scale, so a 0.5× page maps ~1:1. */
const CUT_RULE_STAGE = {
  width: 400,
  height: 440,
  /** Skeleton origin (the feet) inside the stage. */
  originX: 180,
  originY: 420,
  scale: 0.5,
  background: '#14161a',
};

/**
 * The rig the page-reading probes draw — the cut rules, the half-resolution
 * page and the premultiplied twin: the figure test rig built `--pack`, so
 * every region is cut from one shared page, with its meshes on the same page.
 * Its rigid slots alone are the rigid-tier cells; the whole frame is the mesh
 * cells.
 */
const RIGID_RIG = 'figure-packed';
const RIGID_POSE = { animation: 'walk', time: 1.2 } as const;

/** A loaded document's `pages` section — the layout `unpackRegions` cuts from. */
function pageLayoutOf(assets: ModelAssets): PageLayout[] {
  const pages = (assets.document as ReadDocument).doc.pages;
  if (!pages) throw new Error('the document states no pages');
  return pages.map((page) => ({ ...page, regions: page.regions }));
}

interface RigidPageSource {
  assets: ModelAssets;
  layout: PageLayout[];
  /** The one page's name, and its image as the build wrote it. */
  pageName: string;
  page: HTMLImageElement;
}

/** Loaded once: the rigid rig, its page layout and its page image as it ships. */
let rigidSource: Promise<RigidPageSource> | null = null;

function rigidPageSource(): Promise<RigidPageSource> {
  if (!rigidSource) {
    rigidSource = (async () => {
      const assets = await loadRig(RIGID_RIG);
      const layout = pageLayoutOf(assets);
      if (layout.length !== 1) throw new Error(`${RIGID_RIG} has ${layout.length} pages, the probes need one`);
      const pageName = layout[0].name;
      const page = assets.pageImages.get(pageName);
      if (!page) throw new Error(`no image for page ${pageName}`);
      return { assets, layout, pageName, page };
    })();
  }
  return rigidSource;
}

/**
 * Page images by scale, minted once per document.
 *
 * Every rule at a given scale therefore cuts from the *same bytes* — a
 * repainted page would put a second variable in the comparison — and the
 * rescale itself is the one a project's texture build does: a high-quality
 * draw of the whole page into a canvas of the target size.
 */
const cutRulePages = new Map<number, Promise<HTMLImageElement>>();

/** What the stage is holding, to be torn down before the next render. */
let cutRuleLive: { renderer: DomRenderer; release: () => void } | null = null;
let cutRuleStageEl: HTMLDivElement | null = null;

function cutRulePageImage(scale: number): Promise<HTMLImageElement> {
  const cached = cutRulePages.get(scale);
  if (cached) return cached;
  const built = (async () => {
    const { page } = await rigidPageSource();
    if (scale === 1) return page;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(page.naturalWidth * scale);
    canvas.height = Math.round(page.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(page, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    // Kept for the document's lifetime on purpose: the image is the cache.
    return await loadImage(URL.createObjectURL(blob));
  })();
  cutRulePages.set(scale, built);
  return built;
}

/**
 * One region's bitmap under a rule that is not the shipped one.
 *
 * Both variants start from the same fractional rect the shipped rule rounds —
 * the region's bounds relative to the declared page size, times the image's
 * natural size. `fractional` hands that rect to `drawImage` as it is and lets
 * the rasterizer interpolate; `shifted` rounds it exactly as `planCut` does and
 * then displaces the read by one whole image pixel (clamped to stay on the
 * image, so it is a displacement and never a transparent margin).
 *
 * Canvas sizes stay at the rect's native resolution either way, and the
 * rotation restore is the shipped one.
 */
async function cutRuleRegion(
  region: PageLayout['regions'][number],
  page: PageLayout,
  image: HTMLImageElement,
  rule: 'fractional' | 'shifted',
): Promise<string> {
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  const pageW = page.width > 0 ? page.width : iw;
  const pageH = page.height > 0 ? page.height : ih;
  const rotated = region.degrees === 90;
  const packedW = rotated ? region.height : region.width;
  const packedH = rotated ? region.width : region.height;
  const scaleX = iw / pageW;
  const scaleY = ih / pageH;

  const fx = region.x * scaleX;
  const fy = region.y * scaleY;
  const fw = packedW * scaleX;
  const fh = packedH * scaleY;

  let sx = fx;
  let sy = fy;
  let sw = fw;
  let sh = fh;
  let dw = Math.max(1, Math.round(fw));
  let dh = Math.max(1, Math.round(fh));
  if (rule === 'shifted') {
    const x0 = Math.round(fx);
    const y0 = Math.round(fy);
    sw = Math.max(1, Math.round(fx + fw) - x0);
    sh = Math.max(1, Math.round(fy + fh) - y0);
    dw = sw;
    dh = sh;
    sx = Math.min(x0 + 1, Math.max(0, iw - sw));
    sy = Math.min(y0 + 1, Math.max(0, ih - sh));
  }

  const canvas = document.createElement('canvas');
  canvas.width = rotated ? dh : dw;
  canvas.height = rotated ? dw : dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (rotated) {
    // The shipped restore, so the only variable between the rules is the
    // rounding: clockwise, because the runtime's UVs put the artwork's top-left
    // at the packed rect's bottom-left (the derivation is in cutRegion). This
    // read `translate(0, canvas.height); rotate(−π/2)` until #49, matching the
    // cut it is measured against — which is why a rule comparison could not
    // see that both were turning the rect the wrong way. (rigc's packer never
    // turns a region, so on the rig this draws the branch is not taken.)
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  return URL.createObjectURL(blob);
}

/** Every region of `layout` under `rule`, plus the way to free what it minted. */
async function cutRuleRegions(
  layout: PageLayout[],
  pageImages: Map<string, HTMLImageElement>,
  rule: CutRule,
): Promise<{ images: Map<string, RegionImage>; release: () => void }> {
  if (rule === 'edge') {
    const images = await unpackRegions(layout, pageImages);
    return { images, release: () => revokeRegions(images) };
  }
  const urls: string[] = [];
  const images = new Map<string, RegionImage>();
  const cuts = await Promise.all(
    layout.flatMap((page) =>
      page.regions.map(async (region) => {
        const image = pageImages.get(page.name);
        if (!image) throw new Error(`Missing page image: ${page.name}`);
        return { region, url: await cutRuleRegion(region, page, image, rule) };
      }),
    ),
  );
  for (const cut of cuts) {
    urls.push(cut.url);
    images.set(cut.region.name, {
      url: cut.url,
      width: cut.region.width,
      height: cut.region.height,
    });
  }
  return {
    images,
    release: () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

function cutRuleStageElement(): HTMLDivElement {
  if (cutRuleStageEl) return cutRuleStageEl;
  const stage = document.createElement('div');
  stage.id = 'cut-rule-stage';
  stage.style.cssText =
    `position: absolute; left: 0; top: 0; overflow: hidden;` +
    `width: ${CUT_RULE_STAGE.width}px; height: ${CUT_RULE_STAGE.height}px;` +
    `background: ${CUT_RULE_STAGE.background};`;
  document.body.append(stage);
  cutRuleStageEl = stage;
  return stage;
}

async function cutRuleStage(options: CutRuleStageOptions): Promise<CutRuleStageResult> {
  // The screenshot of the previous render happens between two calls, so this
  // is the only place its renderer and bitmaps can be let go of.
  if (cutRuleLive) {
    cutRuleLive.renderer.dispose();
    cutRuleLive.release();
    cutRuleLive = null;
  }

  const source = await rigidPageSource();
  const image = await cutRulePageImage(options.pageScale);
  const pageImages = new Map([[source.pageName, image]]);
  const cut = await cutRuleRegions(source.layout, pageImages, options.rule);

  const stage = cutRuleStageElement();
  stage.replaceChildren();
  const root = document.createElement('div');
  root.style.cssText =
    `position: absolute; left: ${CUT_RULE_STAGE.originX}px; top: ${CUT_RULE_STAGE.originY}px;` +
    `transform-origin: 0 0; transform: scale(${CUT_RULE_STAGE.scale});`;
  stage.append(root);

  const renderer = new DomRenderer(root, cut.images, pageImages);
  renderer.render(rigidOnly(frameAt(source.assets, options.animation, options.time)));
  cutRuleLive = { renderer, release: cut.release };

  const images = [...root.querySelectorAll('img')];
  // The bitmap is the whole point, and naturalWidth is 0 until it decodes.
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  // …and a decoded bitmap is not yet a settled raster. Chromium paints the
  // first frame of a freshly decoded image scaled down by more than ~2 with a
  // cheaper filter and re-rasters it a frame or two later (measured: the first
  // capture of a 1.5× page differed from the second and third by 23,612
  // pixels, while the second and third were bit-identical). Whether a capture
  // lands before or after that re-raster is a race, and a race in the
  // instrument reads as a difference between rules. Several frames of settling
  // is what closes it.
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  const stageBox = stage.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let bitmapPixels = 0;
  for (const img of images) {
    const box = img.getBoundingClientRect();
    minX = Math.min(minX, box.left - stageBox.left);
    minY = Math.min(minY, box.top - stageBox.top);
    maxX = Math.max(maxX, box.right - stageBox.left);
    maxY = Math.max(maxY, box.bottom - stageBox.top);
    bitmapPixels += img.naturalWidth * img.naturalHeight;
  }
  const round = (value: number): number => Math.round(value * 100) / 100;

  const declaredPage = source.layout[0];
  return {
    declaredPage: { width: declaredPage?.width ?? 0, height: declaredPage?.height ?? 0 },
    pageSize: { width: image.naturalWidth, height: image.naturalHeight },
    imageCount: images.length,
    bitmapPixels,
    contentBox: {
      x: round(minX),
      y: round(minY),
      width: round(maxX - minX),
      height: round(maxY - minY),
    },
  };
}

/* --- clipping attachments -------------------------------------------------
 *
 * Clipping has no counter that can prove it is CORRECT — a clip-path that is
 * off by a transform still produces a string and still counts as applied. So
 * the oracle for these probes is pixels, and the specs build it without
 * touching the renderer's local-frame math: the clipped capture must equal the
 * UNCLIPPED capture of the same slots, masked in screen space by the world
 * polygon these probes hand back.
 *
 * Each pixel probe therefore leaves two capture boxes in the DOM for the spec
 * to screenshot — same size, same origin, same scale — differing in nothing
 * but `renderer.clipping`.
 */

/** Root scale, capture box and root origin shared by every clipping capture. */
const CLIP_SCALE = 0.4;
const CLIP_BOX = { width: 420, height: 340, originX: 210, originY: 320 };
/**
 * Capture boxes are left TRANSPARENT and screenshotted with `omitBackground`,
 * so "is there artwork at this pixel" is a question about alpha rather than
 * about how close a color is to a backdrop. Dark artwork against an opaque
 * dark box would make those two different questions.
 */
const CLIP_BG = 'transparent';

export interface ClipCapture {
  /** DOM id of the element the spec screenshots. */
  id: string;
  width: number;
  height: number;
  /** Root origin inside the capture box, in capture pixels. */
  originX: number;
  originY: number;
  /** Scale from root (CSS world) units to capture pixels. */
  scale: number;
  /** Always 'transparent': the boxes are captured with `omitBackground`. */
  background: string;
}

export interface ClipElementReport {
  slot: string;
  tag: 'img' | 'canvas';
  visible: boolean;
  /** Inline clip-path, '' when the element carries none. */
  clipPath: string;
  /** Whether the clip's slot range covers this slot. */
  inRange: boolean;
}

export interface ClipCounters {
  clipCount: number;
  clipSkipCount: number;
  clipWriteCount: number;
}

export interface ClipPartMaskProbeResult {
  startSlot: string;
  endSlot: string | null;
  inRangeSlots: string[];
  outOfRangeSlots: string[];
  /** The clip polygon in the root's CSS frame (Y negated), flat x,y. */
  polygon: number[];
  counters: ClipCounters;
  /** The full render — nothing hidden — one entry per slot element. */
  elements: ClipElementReport[];
  /** Must stay '': a part mask is not the whole-skeleton fast path. */
  rootClipPath: string;
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipRigidProbeResult {
  /**
   * The control capture: the same pose, clipped by a polygon so large it
   * removes NOTHING. Geometrically it is the unclipped picture; what it has
   * that `unclipped` lacks is a `clip-path` on every element. So whatever it
   * and `unclipped` disagree about is the cost of the clip-path's presence in
   * the rasterizer — not of where the clip was put. Without this, that floor
   * cannot be told apart from a clip landing in the wrong place.
   */
  control: ClipCapture;
  /** Slots carrying a clip-path, and drawn slots carrying none. */
  clippedSlots: string[];
  unclippedSlots: string[];
  /** Drawn rigid elements whose matrix is neither axis-aligned nor unit. */
  rotatedOrScaled: number;
  /** Must stay '': the end slot lies ahead, so the fast path is closed. */
  rootClipPath: string;
  counters: ClipCounters;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipRootStyleContract {
  /** What the caller had on the root before the renderer ever ran. */
  before: string;
  /** While the whole-skeleton clip is in force. */
  duringClip: string;
  /** After the clip stops covering the frame. */
  afterClipEnds: string;
  /** While a second whole-skeleton clip is in force again. */
  duringSecondClip: string;
  afterDispose: string;
}

export interface ClipRootProbeResult {
  /** The root's clip-path under the fast path — a polygon(). */
  rootClipPath: string;
  /** Must be 0: the fast path writes the root INSTEAD of the elements. */
  elementsWithClipPath: number;
  drawnElements: number;
  counters: ClipCounters;
  styleContract: ClipRootStyleContract;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

export interface ClipCounterStep {
  clipWriteCount: number;
  clipCount: number;
  clipSkipCount: number;
  /** Clipping attachments the pose shows and the frame does not carry (read off the pose and the frame, not the renderer). */
  clipsIgnored: number;
  elementsWithClipPath: number;
  /** Slots whose clip-path string changed during this step. */
  changedSlots: string[];
}

export interface ClipCountersProbeResult {
  /** Drawn elements the clip covers — the ceiling for a per-element sweep. */
  inRangeElements: number;
  /** The slot the single-bone nudge is expected to move, and nothing else. */
  movedSlot: string;
  firstRender: ClipCounterStep;
  /** Same pose, same polygon: the write cache must carry all of it. */
  secondRender: ClipCounterStep;
  /** Polygon moved: every covered element's local polygon changed. */
  polygonMoved: ClipCounterStep;
  /** One bone nudged: only that element's local polygon changed. */
  oneSlotMoved: ClipCounterStep;
  /** clipping = false: every clip-path removed, the clip counted as skipped. */
  disabled: ClipCounterStep;
  /** clipping = true again: re-applied without any other change. */
  reEnabled: ClipCounterStep;
  /** A second clipping attachment met while the first is active. */
  nested: ClipCounterStep;
}

export interface ClipInverseProbeResult {
  /** The frame's clip is inverse — the attachment's flag arrived through the adapter. */
  inverse: boolean;
  /** The even-odd string the renderer wrote for a drawn element. */
  sampleClipPath: string;
  elementsWithClipPath: number;
  /** Must stay '': an inverse clip never takes the root fast path. */
  rootClipPath: string;
  counters: ClipCounters;
  polygon: number[];
  clipped: ClipCapture;
  unclipped: ClipCapture;
}

/**
 * The clip probes draw the figure test rig (tests/rigs/figure), one animation
 * per case. Its clips are authored in rigc's own format — clipping
 * attachments in slot `clip` (and `clip_inner`) on the root bone, so each
 * polygon's world coordinates are the ones written in its rig.json — and
 * every case but `mask` is the setup pose, so the frames of two cases differ
 * in exactly what the cases differ in: the polygon (`tilted` / `tilted_moved`),
 * one leaf bone (`nudge`, which moves `badge` and nothing else), a second clip
 * (`nested`). What the renderer is handed is what the package's adapter reads
 * off the pose: which slots a clip covers, and one shared `PosedClip` per
 * clip. Nothing here constructs a clip; the probes only choose which slots of
 * a frame to draw.
 */
const CLIP_RIG = 'figure';
/** Any time does for the setup-pose cases; `mask` walks, and is frozen at the walk's own t. */
const CLIP_TIME = 0.5;
const MASK_POSE = { animation: 'mask', time: 1.2 } as const;
/** The leaf bone `nudge` moves: one drawn slot on it, no children. */
const NUDGED_SLOT = 'badge';

/** A capture box with a renderer root at a known origin and scale inside it. */
function openClipCapture(id: string, top: number): {
  root: HTMLElement;
  capture: ClipCapture;
} {
  const container = document.createElement('div');
  container.id = id;
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.top = `${top}px`;
  container.style.width = `${CLIP_BOX.width}px`;
  container.style.height = `${CLIP_BOX.height}px`;
  container.style.overflow = 'hidden';
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = `${CLIP_BOX.originX}px`;
  root.style.top = `${CLIP_BOX.originY}px`;
  root.style.transformOrigin = '0 0';
  root.style.transform = `scale(${CLIP_SCALE})`;
  container.appendChild(root);
  document.body.appendChild(container);
  return {
    root,
    capture: { id, ...CLIP_BOX, scale: CLIP_SCALE, background: CLIP_BG },
  };
}

/**
 * A frame slot after every clip's range that draws nothing — its region has no
 * bitmap, so the renderer hides it. Appended by the probes that measure the
 * per-element path under a clip covering every drawn element: the renderer
 * takes the whole-skeleton root path only for a clip that covers every slot
 * of the frame, and this keeps such a clip on the per-element path.
 */
const UNDRAWN_AFTER_CLIP: PosedSlot = {
  slot: '__after-clip',
  z: 100000,
  blend: 'Normal',
  tint: [1, 1, 1, 1],
  kind: 'region',
  region: '__no-such-region',
  corners: [0, 0, 0, 1, 1, 1, 1, 0],
  page: '__no-such-page',
  pma: false,
  uvs: [0, 1, 0, 0, 1, 0, 1, 1],
};

function withTrailing(frame: PosedFrame): PosedFrame {
  return { order: [...frame.order, UNDRAWN_AFTER_CLIP] };
}

function clipRenderer(root: HTMLElement, assets: ModelAssets): DomRenderer {
  const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
  // The root is scaled, so fold that in rather than rastering meshes at 1:1.
  renderer.pixelRatio = CLIP_SCALE;
  return renderer;
}

function clipCounters(renderer: DomRenderer): ClipCounters {
  return {
    clipCount: renderer.clipCount,
    clipSkipCount: renderer.clipSkipCount,
    clipWriteCount: renderer.clipWriteCount,
  };
}

/** The slot elements of one root, identified by the z-index the renderer wrote. */
function clipElements(
  root: HTMLElement,
  drawOrder: readonly string[],
  startIndex: number,
  endIndex: number,
): ClipElementReport[] {
  const out: ClipElementReport[] = [];
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLCanvasElement)) continue;
    const z = Number(el.style.zIndex);
    const slot = Number.isInteger(z) ? drawOrder[z] : undefined;
    out.push({
      slot: slot ?? `z:${el.style.zIndex}`,
      tag: el instanceof HTMLImageElement ? 'img' : 'canvas',
      visible: el.style.display !== 'none',
      clipPath: el.style.clipPath,
      inRange: z > startIndex && z <= endIndex,
    });
  }
  return out;
}

/**
 * The clip in force in a case's frame, and where it starts and ends in the
 * pose's draw order. The start is the clipping slot the pose shows first; the
 * end is the slot its attachment names, or the last slot when it names its own
 * slot (a clip that never ends). The clip object is the frame's — the one the
 * renderer sees — so a polygon read from it is the polygon that was drawn.
 */
function clipRange(pose: RawPose, frame: PosedFrame): {
  startIndex: number;
  endIndex: number;
  startSlot: string;
  endSlot: string | null;
  clip: PosedClip;
} {
  const first = pose.clips[0];
  if (!first) throw new Error('the pose shows no clipping attachment');
  const [startSlot, , endSlot] = first;
  const startIndex = pose.drawOrder.indexOf(startSlot);
  const ahead = endSlot === null ? -1 : pose.drawOrder.indexOf(endSlot);
  const endIndex = ahead > startIndex ? ahead : pose.drawOrder.length - 1;
  const clip = frame.order.find((slot) => slot.clip)?.clip;
  if (!clip) throw new Error('no slot of the frame carries the clip');
  return { startIndex, endIndex, startSlot, endSlot, clip };
}

/** The clip polygon in the root's CSS frame — the spec's oracle input. Spine is Y-up, CSS Y-down. */
function cssPolygon(clip: PosedClip): number[] {
  const out: number[] = [];
  for (let v = 0; v < clip.polygon.length; v += 2) out.push(clip.polygon[v], -clip.polygon[v + 1]);
  return out;
}

/**
 * Clipping attachments the pose shows that no slot of the frame carries — the
 * ones the draw loop met while another clip was in force and ignored. Counted
 * where the frame is read, off the pose and the frame the adapter made of it.
 */
function clipsIgnored(pose: RawPose, frame: PosedFrame): number {
  const carried = new Set(frame.order.map((slot) => slot.clip).filter((clip) => clip !== undefined));
  return pose.clips.length - carried.size;
}

/**
 * The rig's own part mask: in `mask`, slot `clip` shows a convex polygon that
 * ends at `head`, so it covers the figure's back half and torso and leaves
 * what is drawn after the head alone.
 *
 * The two captures draw only the slots IN that range, so the only difference
 * between them is the clip itself — which is what lets the spec mask one and
 * compare it to the other.
 */
async function clipPartMaskProbe(): Promise<ClipPartMaskProbeResult> {
  const assets = await loadRig(CLIP_RIG);
  const { pose, frame } = poseAt(assets, MASK_POSE.animation, MASK_POSE.time);
  const range = clipRange(pose, frame);
  const { startIndex, endIndex } = range;

  const inRangeSlots: string[] = [];
  const outOfRangeSlots: string[] = [];
  pose.drawOrder.forEach((slot, i) => {
    if (i === startIndex) return;
    (i > startIndex && i <= endIndex ? inRangeSlots : outOfRangeSlots).push(slot);
  });

  // Full render first — the DOM report needs the out-of-range slots present.
  const full = openClipCapture('clip-part-full', CLIP_BOX.height * 2);
  const fullRenderer = clipRenderer(full.root, assets);
  fullRenderer.render(frame);
  const elements = clipElements(full.root, pose.drawOrder, startIndex, endIndex);
  const rootClipPath = full.root.style.clipPath;

  // Now only the slots in the clip's range, so the captures differ in nothing
  // but the clip.
  const inRange: PosedFrame = { order: frame.order.filter((slot) => slot.z > startIndex && slot.z <= endIndex) };

  const clipped = openClipCapture('clip-part-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(inRange);

  const unclipped = openClipCapture('clip-part-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(inRange);

  return {
    startSlot: range.startSlot,
    endSlot: range.endSlot,
    inRangeSlots,
    outOfRangeSlots,
    polygon: cssPolygon(range.clip),
    counters: clipCounters(clippedRenderer),
    elements,
    rootClipPath,
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * The rigid tier under a tilted clip: the figure's rigid slots only, so every
 * element here is an `<img>` posed by a full matrix — the figure's bones are
 * turned at rest — and every clip-path has to come back through that matrix's
 * inverse.
 *
 * `tilted` starts in the first slot and ends at the LAST one, so it covers
 * every drawn element (which is what makes the whole capture maskable), and a
 * frame slot past its range that draws nothing (`UNDRAWN_AFTER_CLIP`) keeps the
 * root fast path shut — the renderer takes it only for a clip over every slot.
 */
async function clipRigidProbe(): Promise<ClipRigidProbeResult> {
  const assets = await loadRig(CLIP_RIG);

  // The control first: `cover`, a quad far larger than the figure over the
  // same range, so every element carries a clip-path and none loses a pixel.
  const control = openClipCapture('clip-rigid-c', CLIP_BOX.height * 2);
  const controlRenderer = clipRenderer(control.root, assets);
  controlRenderer.render(withTrailing(rigidOnly(frameAt(assets, 'cover', CLIP_TIME))));

  const { pose, frame } = poseAt(assets, 'tilted', CLIP_TIME);
  const range = clipRange(pose, frame);
  const rigid = rigidOnly(frame);

  const clipped = openClipCapture('clip-rigid-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(withTrailing(rigid));

  const unclipped = openClipCapture('clip-rigid-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(rigid);

  const reports = clipElements(clipped.root, pose.drawOrder, 0, pose.drawOrder.length - 1);
  let rotatedOrScaled = 0;
  for (const el of Array.from(clipped.root.children)) {
    if (!(el instanceof HTMLImageElement) || el.style.display === 'none') continue;
    const m = /matrix\(([^)]+)\)/.exec(el.style.transform);
    if (!m) continue;
    const [a, b, c, d] = m[1].split(',').map(Number);
    // Anything but the identity 2×2 means the inverse below is doing work.
    if (Math.abs(a - 1) > 1e-6 || Math.abs(d - 1) > 1e-6 || b !== 0 || c !== 0) {
      rotatedOrScaled++;
    }
  }

  return {
    control: control.capture,
    clippedSlots: reports.filter((r) => r.clipPath !== '').map((r) => r.slot),
    unclippedSlots: reports.filter((r) => r.visible && r.clipPath === '').map((r) => r.slot),
    rotatedOrScaled,
    rootClipPath: clipped.root.style.clipPath,
    counters: clipCounters(clippedRenderer),
    polygon: cssPolygon(range.clip),
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * The whole-skeleton shape: `window`, an axis-aligned rectangle in the first
 * slot whose end slot is its OWN slot. The official draw loops never offer
 * the starting slot to clipEnd (they `continue` past it), so that clip never
 * ends and covers every element — which is the case the root fast path
 * exists for.
 *
 * The style contract gets its own throwaway root: the root is the caller's
 * element, so the inline clip-path found there has to come back.
 */
async function clipRootProbe(): Promise<ClipRootProbeResult> {
  const assets = await loadRig(CLIP_RIG);
  const { pose, frame } = poseAt(assets, 'window', CLIP_TIME);
  const range = clipRange(pose, frame);
  const windowed = rigidOnly(frame);
  // The same pose with no clip shown — the frame after the clip ends.
  const bare = rigidOnly(frameAt(assets, 'bare', CLIP_TIME));

  const clipped = openClipCapture('clip-root-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(windowed);

  const unclipped = openClipCapture('clip-root-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(windowed);

  const reports = clipElements(clipped.root, pose.drawOrder, 0, pose.drawOrder.length);
  const counters = clipCounters(clippedRenderer);

  // The borrowed-style contract, on a root that already carries one.
  const contract = openClipCapture('clip-root-style', CLIP_BOX.height * 2);
  contract.root.style.clipPath = 'inset(0px)';
  // Read it back rather than trusting the literal: what has to come back is
  // whatever the engine serialized, which is what the renderer saved.
  const before = contract.root.style.clipPath;
  const contractRenderer = clipRenderer(contract.root, assets);
  contractRenderer.render(windowed);
  const duringClip = contract.root.style.clipPath;
  contractRenderer.render(bare);
  const afterClipEnds = contract.root.style.clipPath;
  contractRenderer.render(windowed);
  const duringSecondClip = contract.root.style.clipPath;
  contractRenderer.dispose();
  const afterDispose = contract.root.style.clipPath;

  return {
    rootClipPath: clipped.root.style.clipPath,
    elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
    drawnElements: reports.filter((r) => r.visible).length,
    counters,
    styleContract: { before, duringClip, afterClipEnds, duringSecondClip, afterDispose },
    polygon: cssPolygon(range.clip),
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

/**
 * Writes-on-change, the disable switch, and the nested-clip rule — all on one
 * renderer, because each step's meaning is "what changed since the last one".
 * No pixels here: every number below is a deterministic counter. The steps
 * are frames of the cases in order: `tilted` twice, `tilted_moved` (the
 * polygon moved), `nudge` (that polygon, and one leaf bone moved), the same
 * frame with clipping off and on again, and `nested`.
 */
async function clipCountersProbe(): Promise<ClipCountersProbeResult> {
  const assets = await loadRig(CLIP_RIG);
  const moment = (animation: string): { pose: RawPose; frame: PosedFrame } => {
    const { pose, frame } = poseAt(assets, animation, CLIP_TIME);
    return { pose, frame: rigidOnly(frame) };
  };
  const tilted = moment('tilted');
  const drawOrder = tilted.pose.drawOrder;

  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  document.body.appendChild(root);
  const renderer = clipRenderer(root, assets);

  let previous = new Map<string, string>();
  function step(at: { pose: RawPose; frame: PosedFrame }): ClipCounterStep {
    renderer.render(withTrailing(at.frame));
    const reports = clipElements(root, drawOrder, 0, drawOrder.length - 1);
    const now = new Map(reports.map((r) => [r.slot, r.clipPath]));
    const changedSlots: string[] = [];
    for (const [slot, value] of now) {
      if (previous.get(slot) !== value) changedSlots.push(slot);
    }
    previous = now;
    return {
      clipWriteCount: renderer.clipWriteCount,
      clipCount: renderer.clipCount,
      clipSkipCount: renderer.clipSkipCount,
      clipsIgnored: clipsIgnored(at.pose, at.frame),
      elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
      changedSlots,
    };
  }

  const firstRender = step(tilted);
  const inRangeElements = firstRender.elementsWithClipPath;
  const secondRender = step(tilted);

  // The polygon itself moved: every covered element's local polygon changes.
  const polygonMoved = step(moment('tilted_moved'));

  // One leaf bone moved under the moved polygon: exactly the one slot on that
  // bone moves, and the bone has no child for anything else to follow it.
  const nudged = moment('nudge');
  const oneSlotMoved = step(nudged);

  renderer.clipping = false;
  const disabled = step(nudged);
  renderer.clipping = true;
  const reEnabled = step(nudged);

  // A second clipping attachment while the first is still in force: the draw
  // loop's clipStart ignores it, so the frame never carries it — the slots
  // after it stay under the first clip, and it is counted where the frame is
  // read.
  const nested = step(moment('nested'));

  renderer.dispose();
  root.remove();

  return {
    inRangeElements,
    movedSlot: NUDGED_SLOT,
    firstRender,
    secondRender,
    polygonMoved,
    oneSlotMoved,
    disabled,
    reEnabled,
    nested,
  };
}

/**
 * An inverse clip: everything OUTSIDE the polygon stays visible. CSS says that
 * with an even-odd polygon whose outer ring is the element's own box, so the
 * shape is expressible per element — and never on the root, which is a 0×0
 * origin element with no box to ring. `inverse` ends at its own slot, so it
 * covers every element.
 */
async function clipInverseProbe(): Promise<ClipInverseProbeResult> {
  const assets = await loadRig(CLIP_RIG);
  const { pose, frame } = poseAt(assets, 'inverse', CLIP_TIME);
  const range = clipRange(pose, frame);
  const rigid = rigidOnly(frame);

  const clipped = openClipCapture('clip-inverse-a', 0);
  const clippedRenderer = clipRenderer(clipped.root, assets);
  clippedRenderer.render(rigid);

  const unclipped = openClipCapture('clip-inverse-b', CLIP_BOX.height);
  const unclippedRenderer = clipRenderer(unclipped.root, assets);
  unclippedRenderer.clipping = false;
  unclippedRenderer.render(rigid);

  const reports = clipElements(clipped.root, pose.drawOrder, 0, pose.drawOrder.length);
  const sample = reports.find((r) => r.visible && r.clipPath !== '');

  return {
    inverse: range.clip.inverse,
    sampleClipPath: sample ? sample.clipPath : '',
    elementsWithClipPath: reports.filter((r) => r.clipPath !== '').length,
    rootClipPath: clipped.root.style.clipPath,
    counters: clipCounters(clippedRenderer),
    polygon: cssPolygon(range.clip),
    clipped: clipped.capture,
    unclipped: unclipped.capture,
  };
}

// --- premultiplied atlas pages (`pma: true`, #37) ---------------------------

/**
 * Fixtures for premultiplied pages, built here rather than committed.
 *
 * The repository's own atlas has no `pma:` line, so nothing in the suite ever
 * drew such a page. What follows makes one out of the page that ships: the same
 * artwork with `rgb = round(rgb * a / 255)` written into it, under the same
 * atlas text plus `pma: true`. Rendered correctly, the two must produce the
 * same picture — which is the whole test.
 *
 * The twin is encoded here, byte by byte, instead of through `canvas.toBlob`.
 * A 2D canvas stores premultiplied colour, so writing values into one and
 * encoding them back out quantizes them at low alpha (measured: up to ~12 of
 * 255 around alpha 11, on both engines) — the fixture would then carry an error
 * of the same order as the thing being measured. Reading the *source* page
 * through a canvas is safe by contrast: the premultiplied product survives that
 * round trip exactly, and the premultiplied product is all the twin holds.
 */

/** CRC-32 table (PNG chunk checksums). */
const PNG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = PNG_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngAdler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * RGBA8 PNG bytes holding exactly `pixels` — no filtering (filter byte 0 per
 * row) and stored deflate blocks, so the file says what was handed in and the
 * encoder needs neither a dependency nor `CompressionStream`.
 */
function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blocks; block++) {
    const start = block * 65535;
    const length = Math.min(65535, raw.length - start);
    zlib[at++] = block === blocks - 1 ? 1 : 0;
    zlib[at++] = length & 0xff;
    zlib[at++] = (length >> 8) & 0xff;
    zlib[at++] = ~length & 0xff;
    zlib[at++] = (~length >> 8) & 0xff;
    zlib.set(raw.subarray(start, start + length), at);
    at += length;
  }
  new DataView(zlib.buffer).setUint32(at, pngAdler32(raw));
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** A blob URL for those pixels as a PNG. The caller owns it. */
function pngUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
  const png = encodePng(pixels, width, height);
  // The array is freshly allocated, so its buffer is exactly its bytes.
  return URL.createObjectURL(new Blob([png.buffer as ArrayBuffer], { type: 'image/png' }));
}

/** An image's pixels as a canvas reads them back (straight alpha). */
function readImagePixels(image: HTMLImageElement): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(image, 0, 0);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** `rgb = round(rgb * a / 255)` — the exporter's premultiply, on a copy. */
function premultiplied(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    out[i] = Math.round((pixels[i] * a) / 255);
    out[i + 1] = Math.round((pixels[i + 1] * a) / 255);
    out[i + 2] = Math.round((pixels[i + 2] * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

/** A frame whose every slot declares its page premultiplied — what a `pma: true` document makes. */
function withPmaSlots(frame: PosedFrame): PosedFrame {
  return { order: frame.order.map((slot) => ({ ...slot, pma: true })) };
}

/**
 * The premultiplied twin of a page image, as a blob URL the caller owns.
 *
 * The source is read through a canvas, which quantizes straight colour at low
 * alpha — but not the premultiplied *product*, which is all that is written
 * here, so the twin holds exactly `round(rgb * a / 255)` of the original file.
 */
function premultipliedTwin(page: HTMLImageElement): {
  url: string;
  width: number;
  height: number;
} {
  const { data, width, height } = readImagePixels(page);
  return { url: pngUrl(premultiplied(data), width, height), width, height };
}

/** Twin page images by page scale, minted once per document (like cutRulePages). */
const pmaTwins = new Map<number, Promise<{ image: HTMLImageElement; url: string }>>();

function pmaTwinPage(scale: number): Promise<{ image: HTMLImageElement; url: string }> {
  const cached = pmaTwins.get(scale);
  if (cached) return cached;
  const built = (async () => {
    const straight = await cutRulePageImage(scale);
    const twin = premultipliedTwin(straight);
    return { image: await loadImage(twin.url), url: twin.url };
  })();
  pmaTwins.set(scale, built);
  return built;
}

/**
 * What this browser's own 2D canvas does to a known premultiplied texel set
 * that is merely drawn and read back — no un-premultiply by us.
 *
 * This is the control, and it is measured in the same run, on the same
 * platform, from the same fixture as everything it is compared against. It is
 * reported and never bounded: the canvas's 8-bit premultiplied storage is the
 * platform's behaviour, not this package's, and it differs by rasterizer
 * (Linux WebKit round-trips several times more coarsely than macOS). An
 * absolute ceiling here was a macOS number in disguise, and CI on another
 * rasterizer is what proved it.
 */
export interface PmaControlBand {
  label: string;
  pixels: number;
  /** Worst |read-back − written| in the band, in the premultiplied domain. */
  maxError: number;
  meanError: number;
}

export interface PmaBand {
  label: string;
  pixels: number;
  maxError: number;
  meanError: number;
  /**
   * Texels whose error exceeds the control's error *for that same texel* plus
   * the stated rounding term — must be 0. Relative, so it carries over to any
   * rasterizer: it says what this package adds, not what the platform costs.
   */
  overBound: number;
  /**
   * Worst (error − bound) in the band. Negative is headroom, so this is what
   * says whether the bound is doing any work.
   */
  worstExcess: number;
  /**
   * Texels whose bound came out at 255 or more — where no 8-bit error could
   * exceed it, so the assertion says nothing about them. Reported rather than
   * hidden: it is the honest measure of where a bound stops biting.
   */
  vacuous: number;
}

/** Alpha bands every pma measurement is reported in. */
const PMA_BANDS = [
  { label: 'a = 255 (opaque)', min: 255, max: 255 },
  { label: 'a 128–254', min: 128, max: 254 },
  { label: 'a 32–127', min: 32, max: 127 },
  { label: 'a 1–31', min: 1, max: 31 },
] as const;

/** Index of the band `a` falls in, or -1 (only alpha 0, which has no colour). */
function pmaBandOf(a: number): number {
  for (let b = 0; b < PMA_BANDS.length; b++) {
    if (a >= PMA_BANDS[b].min && a <= PMA_BANDS[b].max) return b;
  }
  return -1;
}

function newPmaBands(): PmaBand[] {
  return PMA_BANDS.map((band) => ({
    label: band.label,
    pixels: 0,
    maxError: 0,
    meanError: 0,
    overBound: 0,
    // Nothing measured yet, so any excess is worse than this.
    worstExcess: Number.NEGATIVE_INFINITY,
    vacuous: 0,
  }));
}

function finishPmaBands(bands: PmaBand[], sums: number[]): void {
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b];
    band.meanError = band.pixels ? Math.round((sums[b] / band.pixels) * 1000) / 1000 : 0;
    // An empty band has no headroom to report, and -Infinity does not survive
    // the trip out of the page (JSON turns it into null).
    band.worstExcess = Number.isFinite(band.worstExcess)
      ? Math.round(band.worstExcess * 1000) / 1000
      : 0;
  }
}

/**
 * How far this package's own arithmetic may move a texel *on top of* the
 * control, in the premultiplied domain — the "plus rounding" term, stated
 * exactly:
 *
 * - **0.5** from `round(rgb * 255 / a)`. The rounded straight value is put back
 *   and multiplied by a/255 again to reach the screen, so half a straight step
 *   arrives as `0.5 × a/255` ≤ 0.5 of 255, for any alpha.
 * - **1** from the canvas's own 8-bit premultiply when `putImageData` stores
 *   that value: its conversion need not agree with `round(v * a / 255)` to the
 *   unit (measured: chromium differs by exactly one step on 1,674 of ~370k
 *   channels, macOS webkit on none).
 *
 * Integers, so 2. Nothing platform-shaped is in it: the platform's cost is the
 * control this is added to.
 */
const DERIVATION_SLACK = 2;

/**
 * A 2D context created the way `unpremultiply` in DomTexture.ts creates the
 * derivation's: **no context attributes**.
 *
 * The attribute is part of the storage. Everything else in this harness reads
 * through `willReadFrequently: true`, and on Linux WebKit the two kinds of
 * surface do not hold the same numbers: the same decoded image read back
 * through one and through the other differed on 561 channels, by one level
 * each, which the un-premultiply's `× 255/a` then carried to 8 (CI run
 * 35365862520; on Chromium the two reads were identical). Anything that claims
 * "same storage as the derived canvas" — the read its intended values start
 * from, the scratch canvas it is compared with, the write-then-read control
 * that bounds it — therefore has to come from here. With all three on this
 * kind, that run measured the derived canvas equal to the scratch one on every
 * channel; with any of them on the other kind, it did not.
 */
function libraryKindContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

/**
 * The **write-then-read** control: what this browser's 2D canvas does to a
 * straight-alpha value that is written with `putImageData` and read back again.
 *
 * The other control measures the read side (an image drawn in and read out);
 * this is the same premultiplied storage from the other direction, and it is
 * the one the derived canvas lives on. It is a property of the rasterizer, and
 * of the kind of surface: every engine measured so far round-trips these values
 * to within a step. (The 8 that Linux WebKit reported in CI run 35362070508 and
 * that retired the absolute bound which used to stand here was *not* this — it
 * was a one-level disagreement between two kinds of canvas, amplified by
 * `× 255/a`; see `libraryKindContext`.)
 *
 * The texel set is the **value class the derivation can produce**, not an
 * arbitrary ramp: an un-premultiplied `round(k * 255 / a)` for every alpha and a
 * dense sweep of k. A generic straight ramp would report a far larger round trip
 * (a value that is not the un-premultiply of anything has no reason to survive)
 * and would bound nothing useful. Since `x -> round(x * a / 255)` sweeps every
 * k from 0 to a, the class is covered exactly, so the maximum below is over a
 * superset of what the derivation writes. Returned per alpha, so the comparison
 * is per texel rather than per band.
 *
 * Measured on a canvas of the page's own dimensions **and of the library's own
 * kind** (`libraryKindContext`): browsers may pick a different raster path by
 * surface size or by context attributes, and a control taken on a different
 * surface would be measuring a different thing from the one it bounds.
 */
function putGetControl(width: number, height: number): {
  perAlpha: Uint16Array;
  bands: PmaControlBand[];
} {
  const size = 256;
  const ctx = libraryKindContext(width, height);
  const written = ctx.createImageData(width, height);
  const data = written.data;
  // Alpha down the rows, the value sweep across the columns; both wrap, so any
  // page size ≥ 256×256 covers every (alpha, value) pair of the class.
  for (let y = 0; y < height; y++) {
    const a = y % size;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // k sweeps the premultiplied values available at this alpha; v is what an
      // un-premultiply of one of them produces, which is what we ever write.
      const k = Math.round(((x % size) * a) / 255);
      const v = a === 0 ? 0 : Math.min(255, Math.round((k * 255) / a));
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = a;
    }
  }
  ctx.putImageData(written, 0, 0);
  const back = ctx.getImageData(0, 0, width, height).data;

  const perAlpha = new Uint16Array(size);
  const bands: PmaControlBand[] = PMA_BANDS.map((band) => ({
    label: band.label,
    pixels: 0,
    maxError: 0,
    meanError: 0,
  }));
  const sums = new Array<number>(PMA_BANDS.length).fill(0);
  for (let y = 0; y < height; y++) {
    const a = y % size;
    if (a === 0) continue;
    const b = pmaBandOf(a);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const error = Math.abs(back[i] - data[i]);
      if (error > perAlpha[a]) perAlpha[a] = error;
      if (b === -1) continue;
      bands[b].pixels++;
      sums[b] += error;
      if (error > bands[b].maxError) bands[b].maxError = error;
    }
  }
  for (let b = 0; b < bands.length; b++) {
    bands[b].meanError = bands[b].pixels
      ? Math.round((sums[b] / bands[b].pixels) * 1000) / 1000
      : 0;
  }
  return { perAlpha, bands };
}

export interface PmaFixtureProbeResult {
  pageSize: { width: number; height: number };
  /** Bytes of the hand-encoded twin, and whether it decoded at all. */
  pngBytes: number;
  decodedSize: { width: number; height: number };
  /** Fully opaque texels, where a canvas read is lossless: must match exactly. */
  opaquePixels: number;
  opaqueMismatches: number;
  /**
   * The control: |read-back − written| over the twin, per alpha band. This *is*
   * the un-premultiply's precision floor — the derivation starts from this read
   * and cannot undo it — so it is what everything below is measured against.
   */
  control: PmaControlBand[];
  /** Derived texels at alpha 0 that are not (0,0,0,0). Must be 0, anywhere. */
  zeroAlphaNonBlack: number;
  /** The write-then-read control, per band — see putGetControl. */
  putGet: PmaControlBand[];
  /**
   * Channels where the derived canvas reads back differently from a scratch
   * canvas this test filled with the values the derivation was *supposed* to
   * write. Exact equality, no tolerance: both went through the same storage on
   * the same platform, so any difference is the library writing something else.
   * Must be 0 anywhere.
   */
  derivedMismatches: number;
  /**
   * |derived read-back − the intended value|, per band, bounded per texel by
   * the write-then-read control at that alpha. This is the platform's storage
   * showing through, not the derivation drifting.
   */
  derivedDrift: PmaBand[];
  /** Worst of that drift over every band — reported, not bounded. */
  derivedMaxDrift: number;
  /**
   * The derivation composited over black — the premultiplied product the screen
   * actually gets — against what the page holds. This is the end-to-end
   * fidelity of the un-premultiply, bounded per texel by the control plus
   * DERIVATION_SLACK. A second premultiply would show here as a large,
   * one-directional error at mid alpha, far outside that.
   */
  compositeMaxError: number;
  composite: PmaBand[];
  /** Samples behind compositeMaxError, for reading a failure. */
  compositeWorst: string[];
}

/**
 * The fixture, measured rather than assumed: the twin decodes, holds what was
 * written where a canvas can see it, and the derivation neither re-premultiplies
 * nor drifts from what it started with.
 */
async function pmaFixtureProbe(): Promise<PmaFixtureProbeResult> {
  const straight = await cutRulePageImage(1);
  const source = readImagePixels(straight);
  const written = premultiplied(source.data);
  const png = encodePng(written, source.width, source.height);
  const url = URL.createObjectURL(new Blob([png.buffer as ArrayBuffer], { type: 'image/png' }));
  const twin = await loadImage(url);
  const readBack = readImagePixels(twin).data;

  // The control, per texel: what this canvas did to the premultiplied values on
  // the way in and out again, before any arithmetic of ours.
  const control: PmaControlBand[] = PMA_BANDS.map((band) => ({
    label: band.label,
    pixels: 0,
    maxError: 0,
    meanError: 0,
  }));
  const controlSums = new Array<number>(PMA_BANDS.length).fill(0);
  const controlError = new Uint8Array(written.length / 4);
  let opaquePixels = 0;
  let opaqueMismatches = 0;
  for (let i = 0; i < written.length; i += 4) {
    const a = written[i + 3];
    if (a === 0) continue;
    const error = Math.max(
      Math.abs(readBack[i] - written[i]),
      Math.abs(readBack[i + 1] - written[i + 1]),
      Math.abs(readBack[i + 2] - written[i + 2]),
    );
    controlError[i / 4] = error;
    if (a === 255) {
      opaquePixels++;
      if (error !== 0) opaqueMismatches++;
    }
    const b = pmaBandOf(a);
    if (b === -1) continue;
    control[b].pixels++;
    controlSums[b] += error;
    if (error > control[b].maxError) control[b].maxError = error;
  }
  for (let b = 0; b < control.length; b++) {
    control[b].meanError = control[b].pixels
      ? Math.round((controlSums[b] / control[b].pixels) * 1000) / 1000
      : 0;
  }

  // The library's own derivation, read back and composited.
  const derived = straightAlphaSource(twin, true) as HTMLCanvasElement;
  // The context the library already made: attributes passed to a second
  // getContext call are ignored, so none are passed.
  const derivedCtx = derived.getContext('2d');
  if (!derivedCtx) throw new Error('2d context unavailable');
  const derivedPixels = derivedCtx.getImageData(0, 0, derived.width, derived.height).data;
  const over = document.createElement('canvas');
  over.width = derived.width;
  over.height = derived.height;
  const overCtx = over.getContext('2d', { willReadFrequently: true });
  if (!overCtx) throw new Error('2d context unavailable');
  overCtx.fillStyle = '#000000';
  overCtx.fillRect(0, 0, over.width, over.height);
  overCtx.drawImage(derived, 0, 0);
  const composited = overCtx.getImageData(0, 0, over.width, over.height).data;

  // What the derivation was supposed to write, computed here from the same read
  // it started from — and then put through a scratch canvas of our own, so the
  // library's canvas can be compared against an identical round trip rather
  // than against the arithmetic it is allowed to be quantized away from.
  //
  // "The same read" and "an identical round trip" both mean the library's kind
  // of canvas, not this harness's usual one — see `libraryKindContext`.
  const libraryReadCtx = libraryKindContext(source.width, source.height);
  libraryReadCtx.drawImage(twin, 0, 0);
  const libraryRead = libraryReadCtx.getImageData(0, 0, source.width, source.height).data;
  const intended = new Uint8ClampedArray(libraryRead.length);
  for (let i = 0; i < libraryRead.length; i += 4) {
    const a = libraryRead[i + 3];
    intended[i + 3] = a;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      intended[i + c] = Math.min(255, Math.round((libraryRead[i + c] * 255) / a));
    }
  }
  const scratchCtx = libraryKindContext(source.width, source.height);
  scratchCtx.putImageData(new ImageData(intended, source.width, source.height), 0, 0);
  const scratchBack = scratchCtx.getImageData(0, 0, source.width, source.height).data;

  const putGet = putGetControl(source.width, source.height);
  const driftBands: PmaBand[] = newPmaBands();
  const driftSums = new Array<number>(PMA_BANDS.length).fill(0);
  let derivedMismatches = 0;
  let derivedMaxDrift = 0;
  let compositeMaxError = 0;
  let zeroAlphaNonBlack = 0;
  const compositeBands: PmaBand[] = newPmaBands();
  const compositeSums = new Array<number>(PMA_BANDS.length).fill(0);
  const worst: string[] = [];
  for (let i = 0; i < readBack.length; i += 4) {
    const a = readBack[i + 3];
    if (a === 0) {
      // Nothing to divide by, so the derivation zeroes it; there is no colour
      // to recover from a fully transparent texel on any platform.
      if (derivedPixels[i] || derivedPixels[i + 1] || derivedPixels[i + 2] || derivedPixels[i + 3]) {
        zeroAlphaNonBlack++;
      }
      continue;
    }
    let pixelError = 0;
    let pixelDrift = 0;
    for (let c = 0; c < 3; c++) {
      // The library's canvas against ours, both of one kind and both holding
      // the same intended values: equal, or the library wrote something it did
      // not compute.
      if (derivedPixels[i + c] !== scratchBack[i + c]) derivedMismatches++;
      const drift = Math.abs(derivedPixels[i + c] - intended[i + c]);
      if (drift > pixelDrift) pixelDrift = drift;
      if (drift > derivedMaxDrift) derivedMaxDrift = drift;
      // Composited over opaque black, the premultiplied product is what lands —
      // and it is measured against what the page actually holds, not against
      // the quantized read the derivation had to start from. (The two differ:
      // a texel whose read overshoots its alpha clamps back onto the true
      // value, so the end-to-end error can be smaller than the read's.)
      const error = Math.abs(composited[i + c] - written[i + c]);
      if (error > pixelError) pixelError = error;
    }
    if (pixelError > compositeMaxError) {
      compositeMaxError = pixelError;
      if (worst.length < 8) {
        worst.push(
          `a=${a} page=${written[i]} read=${readBack[i]} ` +
            `derived=${derivedPixels[i]} composite=${composited[i]}`,
        );
      }
    }
    // Relative to this platform's own round trip on this very texel: whatever
    // the canvas already cost (controlError), the derivation may add only
    // DERIVATION_SLACK on top of it.
    const bound = controlError[i / 4] + DERIVATION_SLACK;
    const b = pmaBandOf(a);
    if (b === -1) continue;
    const band = compositeBands[b];
    if (bound >= 255) band.vacuous++;
    band.pixels++;
    compositeSums[b] += pixelError;
    if (pixelError > band.maxError) band.maxError = pixelError;
    if (pixelError > bound) band.overBound++;
    if (pixelError - bound > band.worstExcess) band.worstExcess = pixelError - bound;

    // The drift, against the write-then-read control at this alpha. The
    // arithmetic term is **zero**: the derivation writes a value of exactly the
    // class the control was measured on, and nothing happens to it afterwards
    // but the storage the control just measured.
    // Banded and bounded by the alpha of the read the intended values came
    // from, which is the one the derivation divided by.
    const driftAlpha = libraryRead[i + 3];
    const driftBand = pmaBandOf(driftAlpha);
    if (driftBand === -1) continue;
    const driftBound = putGet.perAlpha[driftAlpha];
    const drift = driftBands[driftBand];
    if (driftBound >= 255) drift.vacuous++;
    drift.pixels++;
    driftSums[b] += pixelDrift;
    if (pixelDrift > drift.maxError) drift.maxError = pixelDrift;
    if (pixelDrift > driftBound) drift.overBound++;
    if (pixelDrift - driftBound > drift.worstExcess) drift.worstExcess = pixelDrift - driftBound;
  }
  finishPmaBands(compositeBands, compositeSums);
  finishPmaBands(driftBands, driftSums);

  URL.revokeObjectURL(url);
  return {
    pageSize: { width: source.width, height: source.height },
    pngBytes: png.length,
    decodedSize: { width: twin.naturalWidth, height: twin.naturalHeight },
    opaquePixels,
    opaqueMismatches,
    control,
    zeroAlphaNonBlack,
    putGet: putGet.bands,
    derivedMismatches,
    derivedDrift: driftBands,
    derivedMaxDrift,
    compositeMaxError,
    composite: compositeBands,
    compositeWorst: worst,
  };
}

/**
 * A whole-page region (the pass-through candidate) and a sub-rect that must be
 * cut. The sub-rect spans the page's full height on purpose: alpha runs top to
 * bottom, so its cut carries every alpha from 0 to 255 and no band of the
 * comparison is empty.
 */
const PMA_RAMP_ATLAS = `ramp.png
size: 64, 32
whole
bounds: 0, 0, 64, 32
sub
bounds: 8, 0, 32, 32
`;

/** Colour across, alpha down — every alpha from 0 to 255 appears. */
function alphaRamp(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const a = Math.round((255 * y) / (height - 1));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = Math.round((255 * x) / (width - 1));
      pixels[i + 1] = 255 - Math.round((255 * x) / (width - 1));
      pixels[i + 2] = 128;
      pixels[i + 3] = a;
    }
  }
  return pixels;
}

export interface PmaCutSample {
  /** Whether the whole-page region reused the page URL instead of cutting. */
  wholePassedThrough: boolean;
  /** Blob URLs unpackRegions minted, and whether revokeRegions freed them. */
  mintedCount: number;
  wholeAliveBefore: boolean;
  wholeAliveAfter: boolean;
  pageAliveAfter: boolean;
}

export interface PmaCutProbeResult {
  straight: PmaCutSample;
  pma: PmaCutSample;
  /**
   * The control, over the same texels: what this canvas does to the
   * premultiplied page when it is merely drawn and read back. In the
   * premultiplied domain, like the fixture's.
   */
  control: PmaControlBand[];
  /**
   * |straight cut − pma cut| over the `sub` region, by alpha band, bounded per
   * texel by the control carried through the division (see cutBound).
   */
  bands: PmaBand[];
  /** Alpha is never divided, so it must come through untouched. */
  maxAlphaError: number;
}

/**
 * What the cut of a premultiplied texel may differ from the straight page's cut
 * by, given what this platform's canvas already did to that texel.
 *
 * Both cuts are read in the **straight** domain, and the un-premultiply is a
 * multiply by `255 / a` — so it multiplies the control's error by exactly that.
 * Everything inside the parenthesis is premultiplied-domain rounding:
 *
 * - `controlError` — this platform's round trip, measured in-run.
 * - **1** — the reference side: the exporter's `round(rgb * a / 255)` against
 *   the canvas's own premultiply of the straight page, which need not agree to
 *   the unit.
 * - **DERIVATION_SLACK** (2) — this package's side, as derived above.
 *
 * The trailing **+1** is the last conversion, which lands the straight value in
 * 8 bits when the cut is encoded and read.
 */
function cutBound(controlError: number, a: number): number {
  return (controlError + 1 + DERIVATION_SLACK) * (255 / a) + 1;
}

/**
 * The rigid tier's pixels, on a page built here so the straight values are
 * known exactly: the same artwork straight and premultiplied, cut both ways,
 * compared texel by texel — plus what the whole-page pass-through does with a
 * premultiplied page (it must not fire: that URL holds premultiplied pixels).
 */
async function pmaCutProbe(): Promise<PmaCutProbeResult> {
  const width = 64;
  const height = 32;
  const straightPixels = alphaRamp(width, height);
  const sources = {
    straight: pngUrl(straightPixels, width, height),
    pma: pngUrl(premultiplied(straightPixels), width, height),
  };

  async function run(variant: 'straight' | 'pma'): Promise<{
    sample: PmaCutSample;
    sub: Uint8ClampedArray;
  }> {
    const pageUrl = sources[variant];
    const image = await loadImage(pageUrl);
    const ramp = parseAtlas(PMA_RAMP_ATLAS);
    const layout = variant === 'pma' ? withPma(ramp) : ramp;
    const pageImages = new Map([['ramp.png', image]]);

    const unpacked = await trackObjectUrls(() => unpackRegions(layout, pageImages));
    const whole = unpacked.result.get('whole');
    const sub = unpacked.result.get('sub');
    if (!whole || !sub) throw new Error('regions missing from the unpack');
    const subPixels = readImagePixels(await loadImage(sub.url)).data;
    const wholeAliveBefore = (await alive([whole.url]))[whole.url] ?? false;
    revokeRegions(unpacked.result);
    const after = await alive([whole.url, pageUrl]);

    return {
      sample: {
        wholePassedThrough: whole.url === pageUrl,
        mintedCount: unpacked.created.length,
        wholeAliveBefore,
        wholeAliveAfter: after[whole.url] ?? false,
        pageAliveAfter: after[pageUrl] ?? false,
      },
      sub: subPixels,
    };
  }

  const straight = await run('straight');
  const pma = await run('pma');

  // The control, on the very texels the cuts are compared over: the
  // premultiplied page drawn into a canvas and read back, nothing else. The
  // `sub` region is unrotated at x = 8 on a 1:1 page, so cut texel (x, y) is
  // page texel (x + 8, y).
  const pmaPageRead = readImagePixels(await loadImage(sources.pma)).data;
  const pmaPageWritten = premultiplied(straightPixels);
  const subX = 8;
  const subW = 32;
  const controlError = new Uint8Array((straight.sub.length / 4) | 0);
  const control: PmaControlBand[] = PMA_BANDS.map((band) => ({
    label: band.label,
    pixels: 0,
    maxError: 0,
    meanError: 0,
  }));
  const controlSums = new Array<number>(PMA_BANDS.length).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < subW; x++) {
      const page = (y * width + (x + subX)) * 4;
      const a = pmaPageWritten[page + 3];
      const error = Math.max(
        Math.abs(pmaPageRead[page] - pmaPageWritten[page]),
        Math.abs(pmaPageRead[page + 1] - pmaPageWritten[page + 1]),
        Math.abs(pmaPageRead[page + 2] - pmaPageWritten[page + 2]),
      );
      controlError[y * subW + x] = error;
      if (a === 0) continue;
      const b = pmaBandOf(a);
      if (b === -1) continue;
      control[b].pixels++;
      controlSums[b] += error;
      if (error > control[b].maxError) control[b].maxError = error;
    }
  }
  for (let b = 0; b < control.length; b++) {
    control[b].meanError = control[b].pixels
      ? Math.round((controlSums[b] / control[b].pixels) * 1000) / 1000
      : 0;
  }

  const measured: PmaBand[] = newPmaBands();
  const sums = new Array<number>(PMA_BANDS.length).fill(0);
  let maxAlphaError = 0;
  for (let i = 0; i < straight.sub.length; i += 4) {
    const a = straight.sub[i + 3];
    maxAlphaError = Math.max(maxAlphaError, Math.abs(pma.sub[i + 3] - a));
    if (a === 0) continue;
    const error = Math.max(
      Math.abs(pma.sub[i] - straight.sub[i]),
      Math.abs(pma.sub[i + 1] - straight.sub[i + 1]),
      Math.abs(pma.sub[i + 2] - straight.sub[i + 2]),
    );
    const bound = cutBound(controlError[i / 4], a);
    const b = pmaBandOf(a);
    if (b === -1) continue;
    const band = measured[b];
    // The division multiplies the control by 255/a, so below roughly alpha 10
    // the bound leaves the 8-bit range and stops constraining anything. That is
    // a property of the quantity, not a threshold to pick: what holds those
    // texels is the *composited* measurement in pmaFixtureProbe, which is
    // bounded at control + DERIVATION_SLACK at every alpha.
    if (bound >= 255) band.vacuous++;
    band.pixels++;
    sums[b] += error;
    if (error > band.maxError) band.maxError = error;
    if (error > bound) band.overBound++;
    if (error - bound > band.worstExcess) band.worstExcess = error - bound;
  }
  finishPmaBands(measured, sums);

  for (const url of Object.values(sources)) URL.revokeObjectURL(url);
  return {
    straight: straight.sample,
    pma: pma.sample,
    control,
    bands: measured,
    maxAlphaError,
  };
}

export interface PmaDerivationProbeResult {
  /** Derivations a straight-alpha load and two renderers cause: must be 0. */
  straightDerivations: number;
  /** The same over a premultiplied page: must be 1, shared by all three. */
  pmaDerivations: number;
  /** Both backends must have actually run, or the count proves less. */
  backendsActive: string[];
  meshesDrawn: number[];
}

/**
 * One derivation per page image, whoever asks for it.
 *
 * `unpackRegions` and every renderer on both backends go over the same
 * premultiplied page; the counter must move by exactly one. Each run uses its
 * own freshly loaded page element, so the weak cache starts empty however many
 * probes ran before this one.
 */
async function pmaDerivationProbe(): Promise<PmaDerivationProbeResult> {
  const source = await rigidPageSource();
  const twin = await pmaTwinPage(1);
  const root = document.createElement('div');
  root.style.cssText = 'position: absolute; left: 0; top: 0; visibility: hidden';
  document.body.append(root);
  const backendsActive: string[] = [];
  const meshesDrawn: number[] = [];

  async function run(variant: 'straight' | 'pma'): Promise<number> {
    // A fresh element: the cache is keyed by the image, so a page another probe
    // already derived would make this count nothing.
    const image = await loadImage(variant === 'pma' ? twin.url : source.page.src);
    const layout = variant === 'pma' ? withPma(source.layout) : source.layout;
    const pageImages = new Map([[source.pageName, image]]);
    const posed = frameAt(source.assets, RIGID_POSE.animation, RIGID_POSE.time);
    const frame = variant === 'pma' ? withPmaSlots(posed) : posed;

    const before = straightAlphaDerivations();
    const regionImages = await unpackRegions(layout, pageImages);

    const renderers = (['canvas2d', 'webgl'] as const).map((backend) => {
      const renderer = new DomRenderer(root, regionImages, pageImages);
      renderer.meshBackend = backend;
      renderer.render(frame);
      if (variant === 'pma') {
        backendsActive.push(renderer.meshBackendActive);
        meshesDrawn.push(renderer.meshCount);
      }
      return renderer;
    });
    const derivations = straightAlphaDerivations() - before;

    for (const renderer of renderers) renderer.dispose();
    root.replaceChildren();
    revokeRegions(regionImages);
    return derivations;
  }

  const straightDerivations = await run('straight');
  const pmaDerivations = await run('pma');
  root.remove();
  return { straightDerivations, pmaDerivations, backendsActive, meshesDrawn };
}

/**
 * A capturable stage for the same pose drawn from a straight page and from its
 * premultiplied twin.
 *
 * Same geometry, same skeleton, same backend: the only variable is which alpha
 * convention the page's texels are in and whether the atlas says so. Correctly
 * handled, the two captures are the same picture — every difference left is the
 * 8-bit un-premultiply at low alpha (see pmaFixtureProbe for its ceiling).
 *
 * `skeleton: 'ess'` draws the rig's rigid slots only, so it exercises the rigid
 * tier (cuts in <img>); `'pro'` is the whole frame, meshes included, on
 * whichever backend is asked for. The specs screenshot `#pma-stage` between
 * calls, so each call opens by tearing down what the previous one left.
 */
export interface PmaStageOptions {
  /** Which page: the one that ships, or its premultiplied twin + `pma: true`. */
  page: 'straight' | 'pma';
  /** 'ess' = the rigid slots only, 'pro' = the whole frame, mesh tier included. */
  skeleton: 'ess' | 'pro';
  backend: 'canvas2d' | 'webgl';
  animation: string;
  time: number;
  /** Page image resolution, as a multiple of the declared size. 1 = as shipped. */
  pageScale: number;
}

export interface PmaStageResult {
  /** What the page layout declares — the flag has to have arrived. */
  pagePma: boolean;
  pageSize: { width: number; height: number };
  /** Rigid slots and mesh canvases in the root. */
  imageCount: number;
  canvasCount: number;
  /** The backend that actually rasterized, and how many meshes it drew. */
  backendActive: string;
  meshesDrawn: number;
  /** Union of the slot boxes, in stage coordinates — the stage must contain it. */
  contentBox: { x: number; y: number; width: number; height: number };
}

const PMA_STAGE = {
  width: 400,
  height: 440,
  originX: 180,
  originY: 420,
  scale: 0.5,
  background: '#14161a',
};

let pmaStageEl: HTMLDivElement | null = null;
let pmaLive: DomRenderer | null = null;

/** Page layout, page image and region bitmaps for one page variant. */
interface PmaScene {
  layout: PageLayout[];
  image: HTMLImageElement;
  pageImages: Map<string, HTMLImageElement>;
  regionImages: Map<string, RegionImage>;
}

/**
 * Scenes by page variant, scale and skeleton, built once per document.
 *
 * Above all the bitmaps: unpacking per call would hand every capture a blob the
 * compositor has never rastered, and chromium raises the raster quality of a
 * scaled image a frame or two after its first paint (the cut-rule stage
 * measures that at 23,612 pixels). Cold-against-warm is then a difference
 * between *captures*, not between pages. Kept for the document's lifetime on
 * purpose: the bitmaps are the cache.
 */
const pmaScenes = new Map<string, Promise<PmaScene>>();

function pmaScene(options: PmaStageOptions): Promise<PmaScene> {
  const key = `${options.page}@${options.pageScale}`;
  const cached = pmaScenes.get(key);
  if (cached) return cached;
  const built = (async (): Promise<PmaScene> => {
    const source = await rigidPageSource();
    const image =
      options.page === 'pma'
        ? (await pmaTwinPage(options.pageScale)).image
        : await cutRulePageImage(options.pageScale);
    const layout = options.page === 'pma' ? withPma(source.layout) : source.layout;
    const pageImages = new Map([[source.pageName, image]]);
    const regionImages = await unpackRegions(layout, pageImages);
    return { layout, image, pageImages, regionImages };
  })();
  pmaScenes.set(key, built);
  return built;
}

function pmaStageElement(): HTMLDivElement {
  if (pmaStageEl) return pmaStageEl;
  const stage = document.createElement('div');
  stage.id = 'pma-stage';
  stage.style.cssText =
    `position: absolute; left: 0; top: 0; overflow: hidden;` +
    `width: ${PMA_STAGE.width}px; height: ${PMA_STAGE.height}px;` +
    `background: ${PMA_STAGE.background};`;
  document.body.append(stage);
  pmaStageEl = stage;
  return stage;
}

async function pmaStage(options: PmaStageOptions): Promise<PmaStageResult> {
  if (pmaLive) {
    pmaLive.dispose();
    pmaLive = null;
  }

  const source = await rigidPageSource();
  const { layout, image, pageImages, regionImages } = await pmaScene(options);
  const posed = frameAt(source.assets, options.animation, options.time);
  const whole = options.page === 'pma' ? withPmaSlots(posed) : posed;
  const frame = options.skeleton === 'ess' ? rigidOnly(whole) : whole;

  const stage = pmaStageElement();
  stage.replaceChildren();
  const root = document.createElement('div');
  root.style.cssText =
    `position: absolute; left: ${PMA_STAGE.originX}px; top: ${PMA_STAGE.originY}px;` +
    `transform-origin: 0 0; transform: scale(${PMA_STAGE.scale});`;
  stage.append(root);

  const renderer = new DomRenderer(root, regionImages, pageImages);
  renderer.meshBackend = options.backend;
  // The stage is drawn at half scale, so raster at the resolution it shows at.
  renderer.pixelRatio = (window.devicePixelRatio || 1) * PMA_STAGE.scale;
  renderer.render(frame);
  pmaLive = renderer;

  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  // Same settling as the cut-rule stage: a freshly decoded bitmap is not yet a
  // settled raster, and a capture mid-escalation reads as a difference.
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  const stageBox = stage.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of root.children) {
    const box = el.getBoundingClientRect();
    minX = Math.min(minX, box.left - stageBox.left);
    minY = Math.min(minY, box.top - stageBox.top);
    maxX = Math.max(maxX, box.right - stageBox.left);
    maxY = Math.max(maxY, box.bottom - stageBox.top);
  }
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    pagePma: layout[0]?.pma ?? false,
    pageSize: { width: image.naturalWidth, height: image.naturalHeight },
    imageCount: images.length,
    canvasCount: root.querySelectorAll('canvas').length,
    backendActive: renderer.meshBackendActive,
    meshesDrawn: renderer.meshCount,
    contentBox: {
      x: round(minX),
      y: round(minY),
      width: round(maxX - minX),
      height: round(maxY - minY),
    },
  };
}

/**
 * The corner order and the region UVs, off the model side (see
 * `RegionGeometryProbeResult`): the `turned` rig's `hold` pose, its two
 * regions on the root at the identity.
 */
async function regionGeometryProbe(): Promise<RegionGeometryProbeResult> {
  const assets = await loadRig('turned');
  try {
    const { pose, frame } = poseAt(assets, 'hold', 0);
    const read = (slot: string): { drawn: number[]; corners: number[]; uvs: number[] } => {
      const drawn = pose.drawn.find((d) => d.slot === slot);
      const posed = frame.order.find((s) => s.slot === slot);
      if (!drawn || drawn.kind !== 'region' || !posed || posed.kind !== 'region') {
        throw new Error(`slot ${slot} did not draw a region`);
      }
      return { drawn: [...drawn.vertices], corners: [...posed.corners], uvs: [...posed.uvs] };
    };
    return { straight: read('s'), rotated: read('r') };
  } finally {
    assets.dispose();
  }
}

/**
 * The canvas render mode at the context cap: `count` players on one page, each
 * a `RigPlayer` in `mode: 'canvas'`, drawn once and then once more on a held
 * pose. Every one must draw through the package's single shared context —
 * `glContextCount()` is the accounting — and hand its page textures back.
 */
async function canvasModeProbe(count: number): Promise<CanvasModeProbeResult> {
  const blitter = getMeshGlBlitter();
  const baselineTextures = liveGlTextures();
  const contextsBefore = glContextCount();
  const assets = await loadModel({ modelUrl: '/rigs/walk-packed/skeleton.model.json' });
  const players: RigPlayer[] = [];
  const roots: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const root = makeGlRoot();
    root.style.left = `${100 + (i % 10) * 60}px`;
    root.style.top = `${200 + Math.floor(i / 10) * 200}px`;
    root.style.transform = 'scale(0.25)';
    root.style.transformOrigin = '0 0';
    const player = new RigPlayer(root, assets, { mode: 'canvas' });
    player.renderer.pixelRatio = 0.25;
    player.play(assets.animations[0].name);
    player.seek(0.3 + i * 0.01);
    player.draw();
    players.push(player);
    roots.push(root);
  }
  let webglPlayers = 0;
  let drawingPlayers = 0;
  let blits = 0;
  for (const player of players) {
    const r = player.renderer as CanvasRenderer;
    if (r.backendActive === 'webgl') webglPlayers++;
    blits += r.blits;
    const ctx = r.canvas.getContext('2d');
    if (ctx && r.canvas.width > 0 && r.canvas.height > 0) {
      const { data } = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height);
      for (let k = 3; k < data.length; k += 4) {
        if (data[k] !== 0) {
          drawingPlayers++;
          break;
        }
      }
    }
  }
  let reusedOnSecondDraw = 0;
  for (const player of players) {
    player.draw();
    reusedOnSecondDraw += (player.renderer as CanvasRenderer).framesReused;
  }
  const contextsAfter = glContextCount();
  const elementsPerRoot = roots.map((root) => root.children.length);
  const texturesWhileDrawing = liveGlTextures();

  // The swap: one player, its renderer replaced twice over the same root.
  const swap: CanvasModeProbeResult['swap'] = [];
  const first = players[0];
  const read = (): void => {
    swap.push({
      mode: first.mode,
      canvases: roots[0].querySelectorAll('canvas').length,
      images: roots[0].querySelectorAll('img').length,
      renderer: first.renderer instanceof CanvasRenderer ? 'CanvasRenderer' : 'DomRenderer',
    });
  };
  first.mode = 'dom';
  read();
  first.mode = 'canvas';
  read();

  for (const player of players) player.dispose();
  for (const root of roots) root.remove();
  assets.dispose();
  return {
    webglAvailable: blitter !== null,
    contextsBefore,
    contextsAfter,
    webglPlayers,
    drawingPlayers,
    elementsPerRoot,
    blits,
    reusedOnSecondDraw,
    texturesWhileDrawing,
    texturesAfterDispose: liveGlTextures(),
    baselineTextures,
    swap,
  };
}

window.rigPlayHarness = {
  canvasModeProbe,
  unpackProbe,
  regionGeometryProbe,
  passThroughProbe,
  rotatedCutProbe,
  unpackFailureProbe,
  loaderProbe,
  loaderFailureProbe,
  glTextureProbe,
  backingProbe,
  scaledStageProbe,
  sharedAssetsProbe,
  cutConcurrencyProbe,
  cutOrderProbe,
  cutFlightFailureProbe,
  scaledPageProbe,
  halfResRenderProbe,
  clipPartMaskProbe,
  clipRigidProbe,
  clipRootProbe,
  clipCountersProbe,
  clipInverseProbe,
  cutRuleStage,
  pmaFixtureProbe,
  pmaCutProbe,
  pmaDerivationProbe,
  pmaStage,
};
