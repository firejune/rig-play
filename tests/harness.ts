import { type LiveTrack, openTrack, openTracks, physicsClockStep, type RawPose, regionPageUvs, underNoSkin } from 'rig-c/core';

import {
  type AdjustableBones,
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
import { frameOf, frameSource, type PosedClip, type PosedFrame, type PosedSlot } from '../src/posedFrame';
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
  meshSwitchProbe(): Promise<MeshSwitchProbeResult>;
  movingMeshClipProbe(): Promise<MovingMeshClipProbeResult>;
  heldMeshTranslateProbe(): Promise<HeldMeshTranslateProbeResult>;
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
  boneBoundsProbe(): Promise<BoneBoundsProbeResult>;
  adjustProbe(): Promise<AdjustProbeResult>;
  canvasScaledStageProbe(): Promise<CanvasScaledStageProbeResult>;
  regionLoadingProbe(): Promise<RegionLoadingProbeResult>;
  skinProbe(): Promise<SkinProbeResult>;
  tracksProbe(): Promise<TracksProbeResult>;
  slotFilterProbe(): Promise<SlotFilterProbeResult>;
  trackModeProbe(): Promise<TrackModeProbeResult>;
  alphaAdditiveProbe(): Promise<AlphaAdditiveProbeResult>;
  glFallbackProbe(loseContext: boolean): Promise<GlFallbackProbeResult>;
  playerBasicsProbe(): Promise<PlayerBasicsProbeResult>;
  physicsClockProbe(): Promise<PhysicsClockProbeResult>;
  environmentProbe(): Promise<EnvironmentProbeResult>;
  darkTintProbe(): Promise<DarkTintProbeResult>;
  darkDomPose(time: number): Promise<number>;
}

export interface EnvironmentProbeResult {
  /** No environment and no motion: the player against the core track given neither, every bone, per rig. */
  untouched: Array<{ rig: string; maxDiff: number }>;
  /** The cloth tip's world x at checkpoints (steps 60, 90, 120, 180, 240) for each schedule, in each mode. */
  tips: Record<string, { dom: number[]; canvas: number[] }>;
  /** The gust schedule through the player against the core track given the same calls, per step pattern. */
  throughCore: Array<{ name: string; maxDiff: number }>;
  /** `walk` (no physics) under every call against the same walk under none. */
  noPhysicsMaxDiff: number;
  /** What `environment()` returns: before play, after a half, after null. */
  beforePlay: number[];
  afterHalf: number[];
  afterNull: number[];
}

export interface PhysicsClockProbeResult {
  /** Per step pattern: the player's physics bone against the core's track with and without the render clock. */
  runs: Array<{
    name: string;
    frames: number;
    /** Largest difference of any reading between the player and the core track given `physicsClockStep`. */
    playerVsClock: number;
    /** The same against the core track on the frame clock (no `clock`). */
    playerVsFrameClock: number;
    /** Outlier frames (second difference > 8 × its ±12-frame median and > 1e-3) of each series. */
    playerOutliers: number[];
    frameClockOutliers: number[];
  }>;
}

export interface PlayerBasicsProbeResult {
  /** A plain `play('walk')`, stepped at 1/60 s for 3.3 s: still on the single track. */
  plainComposed: boolean;
  plainEvents: Array<{ name: string; time: number; int: number; float: number; string: string | null; track?: number; at: number }>;
  plainCompletes: Array<{ animation: string; track: number; at: number }>;
  /** `play('nudge', { loop: false })` stepped past its end. */
  heldEvents: Array<{ name: string; int: number; at: number }>;
  heldCompletes: Array<{ animation: string; at: number }>;
  heldTime: number;
  heldCurrent: string | null;
  heldAnimationTime: number | null;
  /** The held pose against the pose at the duration, bone by bone. */
  heldMaxDiff: number;
  /** `player.color`: the frame's tints against the uncoloured frame's, and the canvas mode's pixels. */
  tintSlots: number;
  tintMaxError: number;
  tintPixels: number;
  tintPixelMaxError: number;
  /** `timeScale` 2: time and pose after five 0.1 s frames, against a seek to 1.0. */
  doubleTime: number;
  doubleMaxDiff: number;
  /** A negative scale, a pause and a resume. */
  negativeTime: number;
  negativeMaxDiff: number;
  pausedTime: number;
  resumedTime: number;
  /** Queue: what track 0 plays at each checkpoint, and the events the queued entry fires. */
  queueAfterCycle: Array<{ at: number; animation: string | null }>;
  queueAfterCycleHits: number[];
  queueDelayed: Array<{ at: number; animation: string | null }>;
  queueClearDelayed: Array<{ at: number; animation: string | null }>;
}

export interface GlFallbackProbeResult {
  /** The renderer's backend as a player made it, with no option set. */
  meshBackend: string;
  /** What drew the first frame, and how much of the mesh canvases it covered. */
  firstActive: string;
  firstPixels: number;
  /** After the shared context is lost (when asked) and the rig steps on. */
  lost: boolean;
  afterActive: string;
  afterPixels: number;
  /** Meshes the frame after the loss re-rastered (the backend signature re-dirties them). */
  afterMeshesDrawn: number;
}

export interface DarkTintProbeResult {
  webglAvailable: boolean;
  /** Per time: the frame's dark colour on each slot, and the GL raster held to c·light + (1 − c)·dark. */
  times: Array<{
    time: number;
    swatchDark: number[] | null;
    sheetDark: number[] | null;
    /** Interior pixels compared, per slot, and the worst channel error in 8-bit levels. */
    swatchPixels: number;
    sheetPixels: number;
    swatchMaxError: number;
    sheetMaxError: number;
    /** How far the GL raster sits above the alpha-only fallback, at the ramp's dark end — the dark half's own signature. */
    swatchLift: number[];
    sheetLift: number[];
  }>;
  /** Pixels that differ by more than 8 levels between the GL rasters at t = 0 and t = 1. */
  glChangedBetweenTimes: number;
  /** The same count for the canvas2d fallback, which draws alpha only. */
  fallbackChangedBetweenTimes: number;
}

export interface AlphaAdditiveProbeResult {
  /** A base, a layer at alpha 0.6, re-weighted to 0.85, and an additive layer, against the probe's own `openTracks` driven by the same calls at the same step boundaries. */
  checkpoints: number;
  boneMismatches: string[];
  frameMismatches: number;
  /** The weighted layer's pose lies between the base alone and the layer at full weight; the additive one differs from the replacing one. */
  alphaBetween: boolean;
  additiveDiffers: boolean;
  /** `entry(1)` reports the weight and the flag. */
  entryAfterSet: unknown;
  entryAfterSetAlpha: unknown;
  entryAdditive: unknown;
  /** A layer at alpha 0 still fires its event, with its track. */
  hitTracksAtAlphaZero: number[];
  /** rig-c's refusals, in its words. */
  alphaOutOfRangeError: string;
  setAlphaEmptyError: string;
  /** setAlpha on a single-track player composes: the player moves onto the tracks. */
  setAlphaComposes: boolean;
}

export interface TrackModeProbeResult {
  /** Poses the core walked (adjust calls) across the first composing call: with `tracks: true`, and without. */
  posesOnComposeTracks: number;
  posesOnComposeDefault: number;
  stepsPlayedBefore: number;
  /** A player on the tracks from the start, plain play + seek, against the single-track walk: bones and vertices. */
  tracksSeekBoneMismatches: string[];
  tracksSeekFrameSame: boolean;
  /** Under `tracks: true`, seek and skin still work before any layering, and refuse after. */
  seekBeforeLayerOk: boolean;
  skinBeforeLayerEmblem: string | null;
  seekAfterLayerRefusal: string;
  /** Events and completes on the tracks from the start. */
  stepEventTracks: number[];
  completeTracks: number[];
}

export interface SlotFilterProbeResult {
  /** The filtered frame against the unfiltered frame with the other slots removed, as JSON. */
  filteredSlots: string[];
  filteredEqualsRemoved: boolean;
  unfilteredCount: number;
  /** Under `mask`'s clip: slots the clip covers with the clip slot kept, and with it filtered out. */
  coveredWithClipKept: number;
  coveredWithClipOut: number;
  clipKeptSameAsUnfiltered: boolean;
  /** `bounds()` under the filter equals the box of the filtered frame; it differs from the unfiltered box. */
  boundsMatchFiltered: boolean;
  boundsDiffer: boolean;
  /** Both modes draw the filtered set: `<img>`s in the DOM mode, draw calls in the canvas mode. */
  domImages: number;
  domImagesAfterLive: number;
  canvasDrew: boolean;
  /** An unknown slot name is refused by name; a predicate filter works. */
  unknownError: string;
  predicateSlots: string[];
  /** A second renderer over the same assets drawing this player's pose under its own filter. */
  secondRootImages: number;
  /** The whole rig is still posed: a bone the filtered-out slots hang on reads the same. */
  boneSameUnderFilter: boolean;
}

export interface TracksProbeResult {
  /** A plain `play` + `seek`: the single track, every bone bit-equal to the probe's own `openTrack` walk. */
  singleBoneMismatches: string[];
  /** The composition — base, a one-shot over it mixed in and queued out, the base cleared over a mix — against the probe's own `openTracks` driven by the same calls at the same steps: bones and frame geometry at every checkpoint. */
  checkpoints: number;
  composedBoneMismatches: string[];
  composedFrameMismatches: number;
  /** The composed pose differs from the base alone while the one-shot plays (the layer reached the pose). */
  layerVisible: boolean;
  /** Events and completes the player fired over the composition, with their tracks. */
  events: Array<{ name: string; track: number | undefined; at: number }>;
  completes: Array<{ animation: string; track: number; at: number }>;
  /** Track 1's entry after the queued empty has mixed out, and track 0's after the clear. */
  entry1AtEnd: unknown;
  entry0AtEnd: unknown;
  currentAtEnd: string | null;
  /** `seek` and `skin` after composing: refused by name. */
  seekRefusal: string;
  skinRefusal: string;
  /** A gallery rig whose animation keys an ik timeline: a plain play runs, composing is refused in the core's words. */
  constraintPlainPlays: boolean;
  constraintComposeRefusal: string;
  /** Before `play`: `queue` opens the tracks itself and `entry(0)` reads it. */
  queueFirstEntry: unknown;
}

export interface RegionLoadingProbeResult {
  /** `regions: 'none'`: no cut, no blob, the canvas mode draws, the DOM mode is refused by name. */
  none: {
    regionCount: number;
    createdUrls: number;
    pageCount: number;
    domRefusal: string;
    canvasElements: number;
    canvasDrew: boolean;
    switchRefusal: string;
    modeAfterSwitch: string;
    revokedOnDispose: number;
  };
  /** `regions: 'data'`: every cut is a `data:image/png` URL, nothing minted, nothing freed, the same pixels as the blob cut. */
  data: {
    regionCount: number;
    dataUrls: number;
    passThroughUrls: number;
    createdUrls: number;
    imageCount: number;
    pixelMismatches: number;
    comparedRegions: number;
    revokedOnDispose: number;
  };
}

export interface SkinProbeResult {
  skins: string[];
  /** What the emblem slot draws under no skin, after `player.skin = 'alt'`, and back. */
  emblemNoSkin: string | null;
  emblemAlt: string | null;
  emblemBack: string | null;
  /** The switch keeps the animation and the track time. */
  animationKept: boolean;
  timeBefore: number;
  timeAfter: number;
  /** The switched pose equals a player constructed with that skin and seeked to the same time: bones and every drawn vertex. */
  boneMismatches: string[];
  frameSame: boolean;
  /** The pose after the switch is what the next draw shows. */
  drawnAfterSwitch: string | null;
  /** An unknown skin: refused by name, player unchanged. */
  unknownError: string;
  skinAfterUnknown: string | undefined;
  emblemAfterUnknown: string | null;
  /** A skin set before `play`: the first pose of the track `play` then opens. */
  setupEmblemAlt: string | null;
}

/** One canvas-mode renderer's backing store and counters. */
export interface CanvasStageSnapshot {
  width: number;
  height: number;
  pixelRatio: number;
  reallocCount: number;
}

export interface CanvasScaledStageProbeResult {
  devicePixelRatio: number;
  zoom: number;
  /** The harness's own 100 px probe of the scaled root. */
  scaledMeasuredPx: number;
  scaledDefault: CanvasStageSnapshot;
  syncedRatio: number;
  syncedRatioAgain: number;
  /** Right after the sync, before the render that acts on it: the backing is untouched. */
  afterSync: CanvasStageSnapshot;
  scaledSynced: CanvasStageSnapshot;
  scaledSyncedAgain: CanvasStageSnapshot;
  /** Oracle: a fresh canvas renderer given the synced ratio before its first render. */
  freshScaled: CanvasStageSnapshot;
  residue: SyncResidue;
  hidden: { ratioBefore: number; returned: number; ratioAfter: number; measuredPx: number; after: CanvasStageSnapshot };
  unscaled: { ratioBefore: number; returned: number; ratioAfter: number; measuredPx: number; after: CanvasStageSnapshot };
  deadband: { ratioBefore: number; returned: number; ratioAfter: number; measuredPx: number; after: CanvasStageSnapshot };
}

export interface AdjustProbeResult {
  /** A player with an adjust writing `hip.scaleY = 1.3`, seeked to 0.7 s, against the probe's own track opened with the same function: bones and frame geometry. */
  adjustedBoneMismatches: string[];
  adjustedFrameSame: boolean;
  /** The adjusted pose differs from the unadjusted one (the hook reached the pose). */
  adjustedDiffersFromPlain: boolean;
  /** An adjust that writes nothing: every field of every bone and the frame equal to no adjust. */
  noopBoneMismatches: string[];
  noopFrameSame: boolean;
  /** The first pose after `play` is adjusted (reset: 'animation'). */
  firstPoseAdjusted: boolean;
  /** `seek` and a `mode` change keep the adjustment. */
  keptAcrossSeek: boolean;
  keptAcrossMode: boolean;
  /** Paused: setting `adjust` re-poses at once; a closure's state change shows after `repose()`, not before. */
  pausedSetSeen: boolean;
  closureBeforeRepose: number;
  closureAfterRepose: number;
  trackTimeAfterRepose: number;
  /** rig-c's refusals, in its words. */
  nanError: string;
  unknownBoneError: string;
  thrownError: string;
}

export interface BoneBoundsProbeResult {
  /** Bones in the document, and how many of them the player read with every field bit-equal to the probe's own pose. */
  boneCount: number;
  boneMismatches: string[];
  /** The player's reads before `play`: the setup pose. */
  setupBone: { x: number; y: number } | null;
  setupBounds: { x: number; y: number; width: number; height: number } | null;
  /** A frame with no clip: the player's bounds against the probe's own box over the frame's corners and vertices. */
  walkHasClip: boolean;
  walkBounds: { x: number; y: number; width: number; height: number } | null;
  walkExpected: { x: number; y: number; width: number; height: number } | null;
  /** The `mask` animation: a clip covers slots, so the bounds may only shrink against the unclipped box. */
  maskHasClip: boolean;
  maskBounds: { x: number; y: number; width: number; height: number } | null;
  maskUnclipped: { x: number; y: number; width: number; height: number } | null;
  /** The same reads after switching the player to the canvas mode, compared field by field. */
  canvasSame: boolean;
  unknownBoneError: string;
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

export interface MeshContractSnapshot {
  drawn: number;
  reused: number;
  realloc: number;
  activeBackend: 'canvas2d' | 'webgl';
  backing: Array<[number, number]>;
}

function meshContractSnapshot(renderer: DomRenderer, root: HTMLElement): MeshContractSnapshot {
  return {
    drawn: renderer.meshCount,
    reused: renderer.meshReuseCount,
    realloc: renderer.canvasReallocCount,
    activeBackend: renderer.meshBackendActive,
    backing: Array.from(root.querySelectorAll('canvas'), (canvas) => [canvas.width, canvas.height]),
  };
}

export interface MeshSwitchProbeResult {
  slots: string[];
  initial: MeshContractSnapshot;
  held: MeshContractSnapshot;
  switches: Array<{
    knob: 'meshBackend' | 'triangleExpand';
    value: string | number;
    changed: MeshContractSnapshot;
    held: MeshContractSnapshot[];
    sameCanvases: boolean;
  }>;
}

/** #113/13: a live knob invalidates the held raster once, without replacing its backing. */
async function meshSwitchProbe(): Promise<MeshSwitchProbeResult> {
  const assets = await loadRig('figure');
  const source = frameAt(assets, 'bare', 0);
  const frame = { order: source.order.filter((slot) => slot.kind === 'mesh') };
  const root = makeGlRoot();
  const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
  renderer.pixelRatio = 1;
  renderer.meshBackend = 'canvas2d';
  try {
    const draw = (): MeshContractSnapshot => {
      renderer.render(frame);
      return meshContractSnapshot(renderer, root);
    };
    const initial = draw();
    const canvases = Array.from(root.querySelectorAll('canvas'));
    const held = draw();
    const switches: MeshSwitchProbeResult['switches'] = [];
    const change = (knob: 'meshBackend' | 'triangleExpand', value: 'canvas2d' | 'webgl' | number): void => {
      if (knob === 'meshBackend') renderer.meshBackend = value as 'canvas2d' | 'webgl';
      else renderer.triangleExpand = value as number;
      const changed = draw();
      const held = [draw(), draw()];
      switches.push({ knob, value, changed, held, sameCanvases: canvases.every((canvas, i) => canvas === root.querySelectorAll('canvas')[i]) });
    };
    change('meshBackend', 'webgl');
    change('triangleExpand', 2);
    change('meshBackend', 'canvas2d');
    change('triangleExpand', 0.5);
    return { slots: frame.order.map((slot) => slot.slot), initial, held, switches };
  } finally {
    renderer.dispose();
    root.remove();
    assets.dispose();
  }
}

export interface MovingMeshClipProbeResult {
  slots: string[];
  sameMeshGeometry: boolean;
  polygonDeltas: number[];
  runs: Array<{
    backend: 'canvas2d' | 'webgl';
    path: 'root' | 'element';
    first: MeshContractSnapshot;
    moved: MeshContractSnapshot;
    held: MeshContractSnapshot;
    clipWrites: [number, number, number];
    pathsBefore: string[];
    pathsAfter: string[];
  }>;
}

/** #113/14: the two authored clip polygons differ by (7,7); neither mesh moves. */
async function movingMeshClipProbe(): Promise<MovingMeshClipProbeResult> {
  const assets = await loadRig('figure');
  try {
    const meshes = (animation: string): PosedFrame => ({
      order: frameAt(assets, animation, 0).order.filter((slot) => slot.kind === 'mesh'),
    });
    const before = meshes('tilted');
    const after = meshes('tilted_moved');
    const firstClip = before.order[0].clip;
    const nextClip = after.order[0].clip;
    if (!firstClip || !nextClip) throw new Error('figure tilted frames must carry their authored clips');
    const sameMeshGeometry = before.order.every((slot, i) => {
      const next = after.order[i];
      return slot.kind === 'mesh' && next.kind === 'mesh'
        && JSON.stringify(slot.vertices) === JSON.stringify(next.vertices)
        && slot.uvs === next.uvs && slot.triangles === next.triangles;
    });
    const runs: MovingMeshClipProbeResult['runs'] = [];
    for (const backend of ['canvas2d', 'webgl'] as const) {
      for (const path of ['root', 'element'] as const) {
        const root = makeGlRoot();
        const renderer = new DomRenderer(root, assets.regionImages, assets.pageImages);
        renderer.pixelRatio = 1;
        renderer.meshBackend = backend;
        try {
          // The existing undrawn trailing-slot control closes the root fast path,
          // leaving the same two real mesh slots on the per-element clip path.
          const draw = (frame: PosedFrame): MeshContractSnapshot => {
            renderer.render(path === 'element' ? withTrailing(frame) : frame);
            return meshContractSnapshot(renderer, root);
          };
          const paths = (): string[] => path === 'root'
            ? [root.style.clipPath]
            : Array.from(root.querySelectorAll('canvas'), (canvas) => canvas.style.clipPath);
          const first = draw(before);
          const firstWrites = renderer.clipWriteCount;
          const pathsBefore = paths();
          const moved = draw(after);
          const movedWrites = renderer.clipWriteCount;
          const pathsAfter = paths();
          const held = draw(after);
          runs.push({ backend, path, first, moved, held, clipWrites: [firstWrites, movedWrites, renderer.clipWriteCount], pathsBefore, pathsAfter });
        } finally {
          renderer.dispose();
          root.remove();
        }
      }
    }
    return {
      slots: before.order.map((slot) => slot.slot),
      sameMeshGeometry,
      polygonDeltas: nextClip.polygon.map((v, i) => v - firstClip.polygon[i]),
      runs,
    };
  } finally {
    assets.dispose();
  }
}

export interface HeldMeshTranslateProbeResult {
  runs: Array<{
    backend: 'canvas2d' | 'webgl';
    slots: string[];
    first: MeshContractSnapshot;
    moved: MeshContractSnapshot;
    held: MeshContractSnapshot;
    time: [number, number];
    vertexDeltas: number[];
    cssDelta: [number, number];
    screenDelta: [number, number];
    screenSizeUnchanged: boolean;
    sameCanvas: boolean;
    changedRasterChannels: number;
    centreAlpha: number;
  }>;
}

/** #113/18: move duo's held sheet through the core adjust hook, not an invented frame. */
async function heldMeshTranslateProbe(): Promise<HeldMeshTranslateProbeResult> {
  const assets = await loadRig('duo');
  const runs: HeldMeshTranslateProbeResult['runs'] = [];
  try {
    for (const backend of ['canvas2d', 'webgl'] as const) {
      const root = makeGlRoot();
      // Keep the sheet's four X coordinates away from Float32 rounding
      // boundaries: at authored x=90, the left edge's 26→33 crosses an
      // exponent boundary and the core's cos(90°) residue survives on only
      // one side. x=200 makes the raster-space translation exactly integral.
      // known: rig-c/play#130, Float32 off-integer offset. The diagnostic's
      // one redraw at x=90 is tracked for removal; its expected redraw count
      // is 0 after #130 is fixed, rather than a contract to preserve.
      const player = new RigPlayer(root, assets, {
        meshBackend: backend,
        adjust: (bones) => { bones.bone('sheet').x = 200; },
      });
      const renderer = player.renderer as DomRenderer;
      renderer.pixelRatio = 1;
      try {
        player.play('shift', { loop: false });
        player.pause();
        player.draw();
        const first = meshContractSnapshot(renderer, root);
        const canvas = root.querySelector('canvas');
        if (!canvas) throw new Error('duo sheet canvas missing');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('duo sheet has no 2d blit context');
        const original = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const beforeMatrix = new DOMMatrix(getComputedStyle(canvas).transform);
        const beforeBox = canvas.getBoundingClientRect();
        const timeBefore = player.time;
        const beforeMesh = player.posedFrame(['sheet']).order[0];
        if (beforeMesh.kind !== 'mesh') throw new Error('duo sheet is not a mesh');
        // A whole-pixel (+7,+5) bone adjustment from (200,100) preserves
        // shape and time; CSS's Y-down movement is -5.
        player.adjust = (bones) => {
          bones.bone('sheet').x = 207;
          bones.bone('sheet').y += 5;
        };
        const afterMesh = player.posedFrame(['sheet']).order[0];
        if (afterMesh.kind !== 'mesh') throw new Error('duo sheet is not a mesh after adjust');
        player.draw();
        const moved = meshContractSnapshot(renderer, root);
        const movedMatrix = new DOMMatrix(getComputedStyle(canvas).transform);
        const movedBox = canvas.getBoundingClientRect();
        const raster = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let changedRasterChannels = 0;
        for (let i = 0; i < original.length; i++) if (original[i] !== raster[i]) changedRasterChannels++;
        // The centre of the sheet is opaque ramp art, strictly inside both triangles.
        const centreAlpha = ctx.getImageData(65, 25, 1, 1).data[3];
        player.draw();
        runs.push({
          backend,
          slots: player.posedFrame(['sheet']).order.map((slot) => slot.slot),
          first,
          moved,
          held: meshContractSnapshot(renderer, root),
          time: [timeBefore, player.time],
          // The renderer reads every posed vertex through Float32 scratch;
          // the core's unrotated b=cos(90°) leaves a sub-ulp world offset.
          vertexDeltas: afterMesh.vertices.map((v, i) => Math.fround(v) - Math.fround(beforeMesh.vertices[i])),
          cssDelta: [movedMatrix.e - beforeMatrix.e, movedMatrix.f - beforeMatrix.f],
          screenDelta: [movedBox.x - beforeBox.x, movedBox.y - beforeBox.y],
          screenSizeUnchanged: movedBox.width === beforeBox.width && movedBox.height === beforeBox.height,
          sameCanvas: canvas === root.querySelector('canvas'),
          changedRasterChannels,
          centreAlpha,
        });
      } finally {
        player.dispose();
        root.remove();
      }
    }
    return { runs };
  } finally {
    assets.dispose();
  }
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
  // Chosen, not defaulted: the element mode's default is webgl since #109.
  rendererF.meshBackend = 'canvas2d';
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

/**
 * `RigPlayer.bone` and `RigPlayer.bounds` (#73): read off the pose the player
 * holds, held to the probe's own pose of the same walk (`poseAt`, the walk
 * `seek` takes) and to the probe's own box over the frame record.
 */
async function boneBoundsProbe(): Promise<BoneBoundsProbeResult> {
  const assets = await loadRig('figure');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const player = new RigPlayer(root, assets);

  const setupBone = (() => {
    const b = player.bone('hip');
    return { x: b.x, y: b.y };
  })();
  const setupBounds = player.bounds();

  const boxOf = (frame: PosedFrame) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of frame.order) {
      const pts = slot.kind === 'region' ? slot.corners : slot.vertices;
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
      }
    }
    return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };

  const time = 0.7;
  player.play('walk');
  player.seek(time);
  const own = poseAt(assets, 'walk', time);
  const boneMismatches: string[] = [];
  for (const bone of own.pose.bones) {
    const read = player.bone(bone.name);
    const pairs: Array<[string, number | boolean, number | boolean]> = [
      ['active', read.active, bone.active], ['x', read.x, bone.worldX], ['y', read.y, bone.worldY],
      ['a', read.a, bone.a], ['b', read.b, bone.b], ['c', read.c, bone.c], ['d', read.d, bone.d],
      ['rotationX', read.rotationX, bone.rotationX], ['rotationY', read.rotationY, bone.rotationY],
      ['scaleX', read.scaleX, bone.scaleX], ['scaleY', read.scaleY, bone.scaleY],
    ];
    for (const [field, got, want] of pairs) if (!Object.is(got, want)) boneMismatches.push(`${bone.name}.${field}: ${String(got)} != ${String(want)}`);
  }
  const walkHasClip = own.frame.order.some((slot) => slot.clip !== undefined);
  const walkBounds = player.bounds();
  const walkExpected = boxOf(own.frame);

  player.play('mask');
  player.seek(time);
  const mask = poseAt(assets, 'mask', time);
  const maskHasClip = mask.frame.order.some((slot) => slot.clip !== undefined);
  const maskBounds = player.bounds();
  const maskUnclipped = boxOf(mask.frame);

  const domReads = JSON.stringify([player.bone('hip'), player.bone('leg_f'), player.bounds()]);
  player.mode = 'canvas';
  const canvasSame = JSON.stringify([player.bone('hip'), player.bone('leg_f'), player.bounds()]) === domReads;

  let unknownBoneError = '';
  try {
    player.bone('no_such_bone');
  } catch (error) {
    unknownBoneError = error instanceof Error ? error.message : String(error);
  }
  player.dispose();
  assets.dispose();
  return {
    boneCount: own.pose.bones.length,
    boneMismatches,
    setupBone,
    setupBounds,
    walkHasClip,
    walkBounds,
    walkExpected,
    maskHasClip,
    maskBounds,
    maskUnclipped,
    canvasSame,
    unknownBoneError,
  };
}

/**
 * `RigPlayer.adjust` (#79): the core's bone-local hook passed through the
 * player — held to the probe's own `openTrack({ adjust })` walk at tolerance
 * 0, to a no-op hook changing nothing, and to the player's own rules for a
 * held pose (`repose`).
 */
async function adjustProbe(): Promise<AdjustProbeResult> {
  const assets = await loadRig('figure');
  const read = assets.document as ReadDocument;
  const view = underNoSkin(read.doc);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const time = 0.7;
  const step = 1 / 60;
  const walkTo = (track: LiveTrack): RawPose => {
    let pose = track.first;
    const steps = Math.floor(time / step);
    for (let i = 0; i < steps; i++) pose = track.step(step);
    const rest = time - track.trackTime;
    if (rest > 0) pose = track.step(rest);
    return pose;
  };
  const boneDiff = (player: RigPlayer, pose: RawPose): string[] => {
    const out: string[] = [];
    for (const bone of pose.bones) {
      const r = player.bone(bone.name);
      const pairs: Array<[string, number | boolean, number | boolean]> = [
        ['active', r.active, bone.active], ['x', r.x, bone.worldX], ['y', r.y, bone.worldY],
        ['a', r.a, bone.a], ['b', r.b, bone.b], ['c', r.c, bone.c], ['d', r.d, bone.d],
        ['rotationX', r.rotationX, bone.rotationX], ['rotationY', r.rotationY, bone.rotationY],
        ['scaleX', r.scaleX, bone.scaleX], ['scaleY', r.scaleY, bone.scaleY],
      ];
      for (const [f, got, want] of pairs) if (!Object.is(got, want)) out.push(`${bone.name}.${f}: ${String(got)} != ${String(want)}`);
    }
    return out;
  };
  const geometry = (frame: PosedFrame) => JSON.stringify(frame.order.map((s) => (s.kind === 'region' ? s.corners : s.vertices)));

  const scaleHip = (bones: { bone(name: string): { scaleY: number } }) => {
    bones.bone('hip').scaleY = 1.3;
  };

  // The adjusted walk against the probe's own.
  const player = new RigPlayer(root, assets, { adjust: scaleHip });
  player.play('walk');
  const firstAdjusted = player.bone('hip');
  const ownFirst = openTrack(view, 'walk', { loop: true, reset: 'animation', adjust: scaleHip }).first;
  const firstPoseAdjusted = Object.is(firstAdjusted.scaleY, ownFirst.bones.find((b) => b.name === 'hip')?.scaleY ?? NaN)
    && !Object.is(firstAdjusted.scaleY, openTrack(view, 'walk', { loop: true, reset: 'animation' }).first.bones.find((b) => b.name === 'hip')?.scaleY ?? NaN);
  player.seek(time);
  const own = walkTo(openTrack(view, 'walk', { loop: true, reset: 'animation', adjust: scaleHip }));
  const adjustedBoneMismatches = boneDiff(player, own);
  const adjustedFrameSame = geometry(player.posedFrame()) === geometry(frameOf(frameSource(view, read.parsed), own, player.color));
  const plain = poseAt(assets, 'walk', time);
  const adjustedDiffersFromPlain = geometry(player.posedFrame()) !== geometry(plain.frame);
  const keptAcrossSeek = adjustedBoneMismatches.length === 0; // seek reopened the track with the hook
  const domHip = player.bone('hip').scaleY;
  player.mode = 'canvas';
  const keptAcrossMode = Object.is(player.bone('hip').scaleY, domHip);
  player.dispose();

  // A hook that writes nothing.
  const noop = new RigPlayer(root, assets, { adjust: () => {} });
  noop.play('walk');
  noop.seek(time);
  const noopBoneMismatches = boneDiff(noop, plain.pose);
  const noopFrameSame = geometry(noop.posedFrame()) === geometry(plain.frame);
  noop.dispose();

  // Held pose: the setter re-poses; a closure's state needs repose().
  const held = new RigPlayer(root, assets);
  held.play('walk');
  held.seek(time);
  held.pause();
  held.frame(1); // paused: no step
  held.adjust = scaleHip;
  const pausedSetSeen = Object.is(held.bone('hip').scaleY, own.bones.find((b) => b.name === 'hip')?.scaleY ?? NaN);
  let mouth = 1.1;
  held.adjust = (bones) => {
    bones.bone('hip').scaleY = mouth;
  };
  mouth = 1.7;
  const closureBeforeRepose = held.bone('hip').scaleY;
  held.repose();
  const closureAfterRepose = held.bone('hip').scaleY;
  const trackTimeAfterRepose = held.time;
  held.dispose();

  // Refusals, in rig-c's words.
  const refusal = (fn: (bones: AdjustableBones) => void): string => {
    const p = new RigPlayer(root, assets);
    try {
      p.adjust = fn;
      p.play('walk');
      p.frame(step);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      p.dispose();
    }
  };
  const nanError = refusal((bones) => { bones.bone('hip').scaleY = NaN; });
  const unknownBoneError = refusal((bones) => { bones.bone('no_such_bone').x = 1; });
  const thrownError = refusal(() => { throw new Error('the caller\'s own failure'); });

  assets.dispose();
  return {
    adjustedBoneMismatches,
    adjustedFrameSame,
    adjustedDiffersFromPlain,
    noopBoneMismatches,
    noopFrameSame,
    firstPoseAdjusted,
    keptAcrossSeek,
    keptAcrossMode,
    pausedSetSeen,
    closureBeforeRepose,
    closureAfterRepose,
    trackTimeAfterRepose,
    nanError,
    unknownBoneError,
    thrownError,
  };
}

/**
 * `CanvasRenderer.syncPixelRatio()` against a CSS-scaled stage — the DOM
 * tier's probe above, on the one-canvas mode: the renderer that synced under
 * a `scale(z)` wrapper must hold exactly the backing store a renderer freshly
 * given that ratio allocates, with the same residue and the same three
 * controls (not laid out, unscaled, inside the deadband).
 */
async function canvasScaledStageProbe(): Promise<CanvasScaledStageProbeResult> {
  const assets = await loadRig(MESH_RIG);
  const frame = frameAt(assets, MESH_POSE.animation, MESH_POSE.time);
  const ZOOM = 0.25;
  const PROBE_PX = 100;
  const wrappers: HTMLElement[] = [];
  const renderers: CanvasRenderer[] = [];

  function open(transform: string, display = ''): { renderer: CanvasRenderer; root: HTMLElement } {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.transformOrigin = '0 0';
    if (transform) wrapper.style.transform = transform;
    if (display) wrapper.style.display = display;
    const root = document.createElement('div');
    root.style.position = 'relative';
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    wrappers.push(wrapper);
    const renderer = new CanvasRenderer(root, assets.pageImages);
    renderers.push(renderer);
    return { renderer, root };
  }
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
  function snapshot(renderer: CanvasRenderer, root: HTMLElement): CanvasStageSnapshot {
    const canvas = root.querySelector('canvas');
    return {
      width: canvas?.width ?? -1,
      height: canvas?.height ?? -1,
      pixelRatio: renderer.pixelRatio,
      reallocCount: renderer.canvasReallocCount,
    };
  }
  function held(renderer: CanvasRenderer, root: HTMLElement) {
    const ratioBefore = renderer.pixelRatio;
    const measuredPx = measurePx(root);
    const returned = renderer.syncPixelRatio();
    const ratioAfter = renderer.pixelRatio;
    renderer.render(frame);
    return { ratioBefore, returned, ratioAfter, measuredPx, after: snapshot(renderer, root) };
  }

  const live = open(`scale(${ZOOM})`);
  live.renderer.render(frame);
  const scaledDefault = snapshot(live.renderer, live.root);
  const scaledMeasuredPx = measurePx(live.root);
  const before = [...live.root.children];
  const syncedRatio = live.renderer.syncPixelRatio();
  const after = [...live.root.children];
  const residue: SyncResidue = {
    childCountBefore: before.length,
    childCountAfter: after.length,
    tagsBefore: before.map((el) => el.tagName.toLowerCase()),
    tagsAfter: after.map((el) => el.tagName.toLowerCase()),
    sameElements: before.length === after.length && before.every((el, index) => el === after[index]),
  };
  const afterSync = snapshot(live.renderer, live.root);
  live.renderer.render(frame);
  const scaledSynced = snapshot(live.renderer, live.root);
  const syncedRatioAgain = live.renderer.syncPixelRatio();
  live.renderer.render(frame);
  const scaledSyncedAgain = snapshot(live.renderer, live.root);

  const fresh = open(`scale(${ZOOM})`);
  fresh.renderer.pixelRatio = syncedRatio;
  fresh.renderer.render(frame);
  const freshScaled = snapshot(fresh.renderer, fresh.root);

  const hiddenStage = open(`scale(${ZOOM})`, 'none');
  hiddenStage.renderer.pixelRatio = 3;
  hiddenStage.renderer.render(frame);
  const hidden = held(hiddenStage.renderer, hiddenStage.root);

  const plain = open('');
  plain.renderer.render(frame);
  const unscaled = held(plain.renderer, plain.root);

  const near = open(`scale(${ZOOM})`);
  near.renderer.pixelRatio = syncedRatio * 1.0004;
  near.renderer.render(frame);
  const deadband = held(near.renderer, near.root);

  for (const renderer of renderers) renderer.dispose();
  for (const wrapper of wrappers) wrapper.remove();
  assets.dispose();
  return {
    devicePixelRatio: window.devicePixelRatio,
    zoom: ZOOM,
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

/**
 * `loadModel({ regions })` (#74, item 2): `'none'` for a canvas-only load and
 * `'data'` for `data:` URLs in place of `blob:`. The oracle for the `data:`
 * pixels is the default load's blob cut of the same rig, decoded and compared
 * byte for byte.
 */
async function regionLoadingProbe(): Promise<RegionLoadingProbeResult> {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();

  const noneLoad = await trackObjectUrls(() => loadModel({ modelUrl: LOADER_RIG, regions: 'none' }));
  const none = noneLoad.result;
  let domRefusal = '';
  try {
    new RigPlayer(root, none);
  } catch (error) {
    domRefusal = error instanceof Error ? error.message : String(error);
  }
  const canvasPlayer = new RigPlayer(root, none, { mode: 'canvas' });
  canvasPlayer.play(none.animations[0].name);
  canvasPlayer.seek(1.2);
  canvasPlayer.draw();
  const canvasElements = root.querySelectorAll('canvas').length;
  const canvasRenderer = canvasPlayer.renderer as CanvasRenderer;
  const canvasDrew = canvasRenderer.blits > 0 || canvasRenderer.drawCalls > 0;
  let switchRefusal = '';
  try {
    canvasPlayer.mode = 'dom';
  } catch (error) {
    switchRefusal = error instanceof Error ? error.message : String(error);
  }
  const modeAfterSwitch = canvasPlayer.mode;
  canvasPlayer.dispose();
  const noneRelease = await trackObjectUrls(async () => none.dispose());

  const blobAssets = await loadModel({ modelUrl: LOADER_RIG });
  const dataLoad = await trackObjectUrls(() => loadModel({ modelUrl: LOADER_RIG, regions: 'data' }));
  const data = dataLoad.result;
  let dataUrls = 0;
  let passThroughUrls = 0;
  for (const image of data.regionImages.values()) {
    if (image.url.startsWith('data:image/png')) dataUrls++;
    else passThroughUrls++;
  }
  root.replaceChildren();
  const domPlayer = new RigPlayer(root, data);
  domPlayer.play(data.animations[0].name);
  domPlayer.seek(1.2);
  domPlayer.draw();
  const imageCount = root.querySelectorAll('img').length;
  domPlayer.dispose();

  const decode = async (url: string): Promise<Uint8ClampedArray> => {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  let pixelMismatches = 0;
  let comparedRegions = 0;
  for (const [name, image] of data.regionImages) {
    const reference = blobAssets.regionImages.get(name);
    if (!reference) continue;
    const [a, b] = await Promise.all([decode(image.url), decode(reference.url)]);
    comparedRegions++;
    if (a.length !== b.length) {
      pixelMismatches++;
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        pixelMismatches++;
        break;
      }
    }
  }
  const dataRelease = await trackObjectUrls(async () => data.dispose());
  blobAssets.dispose();

  return {
    none: {
      regionCount: none.regionImages.size,
      createdUrls: noneLoad.created.length,
      pageCount: none.pageImages.size,
      domRefusal,
      canvasElements,
      canvasDrew,
      switchRefusal,
      modeAfterSwitch,
      revokedOnDispose: noneRelease.revoked.length,
    },
    data: {
      regionCount: data.regionImages.size,
      dataUrls,
      passThroughUrls,
      createdUrls: dataLoad.created.length,
      imageCount,
      pixelMismatches,
      comparedRegions,
      revokedOnDispose: dataRelease.revoked.length,
    },
  };
}

/**
 * `RigPlayer.skin` (#74, item 3): the skin changed on a live player. The
 * figure test rig's `alt` skin alone fills the `emblem` slot (with the visor
 * art), so a switch is visible as that slot drawing or not. The oracle for
 * the pose after the switch is a player constructed under that skin and
 * seeked to the same time.
 */
async function skinProbe(): Promise<SkinProbeResult> {
  const assets = await loadRig('figure');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const emblemOf = (player: RigPlayer): string | null => {
    const slot = player.posedFrame().order.find((s) => s.slot === 'emblem');
    return slot && slot.kind === 'region' ? slot.region : null;
  };
  const time = 0.7;

  // A skin set before `play` is the one the track `play` opens poses under.
  const setupPlayer = new RigPlayer(root, assets);
  setupPlayer.skin = 'alt';
  setupPlayer.play('walk');
  const setupEmblemAlt = emblemOf(setupPlayer);
  setupPlayer.dispose();

  const player = new RigPlayer(root, assets);
  player.play('walk');
  player.seek(time);
  const emblemNoSkin = emblemOf(player);
  const timeBefore = player.time;
  player.skin = 'alt';
  const emblemAlt = emblemOf(player);
  const timeAfter = player.time;
  const animationKept = player.current === 'walk';
  player.draw();
  const drawnAfterSwitch = emblemOf(player);

  const oracle = new RigPlayer(root, assets, { skin: 'alt' });
  oracle.play('walk');
  oracle.seek(time);
  const boneMismatches: string[] = [];
  for (const name of ['hip', 'head', 'leg_f', 'arm_f_lo']) {
    const a = player.bone(name);
    const b = oracle.bone(name);
    for (const f of ['x', 'y', 'a', 'b', 'c', 'd', 'scaleX', 'scaleY', 'active'] as const) {
      if (!Object.is(a[f], b[f])) boneMismatches.push(`${name}.${f}`);
    }
  }
  const geometry = (frame: PosedFrame) =>
    JSON.stringify(frame.order.map((s) => [s.slot, s.kind === 'region' ? s.region : s.page, s.kind === 'region' ? s.corners : s.vertices]));
  const frameSame = geometry(player.posedFrame()) === geometry(oracle.posedFrame());
  oracle.dispose();

  let unknownError = '';
  try {
    player.skin = 'no_such_skin';
  } catch (error) {
    unknownError = error instanceof Error ? error.message : String(error);
  }
  const skinAfterUnknown = player.skin;
  const emblemAfterUnknown = emblemOf(player);

  player.skin = undefined;
  const emblemBack = emblemOf(player);
  player.dispose();
  assets.dispose();
  return {
    skins: [...assets.skins],
    emblemNoSkin,
    emblemAlt,
    emblemBack,
    animationKept,
    timeBefore,
    timeAfter,
    boneMismatches,
    frameSame,
    drawnAfterSwitch,
    unknownError,
    skinAfterUnknown,
    emblemAfterUnknown,
    setupEmblemAlt,
  };
}

/**
 * `RigPlayer`'s tracks (#87): a plain `play` stays on the single live track
 * (held to `openTrack`), and the first composing call moves the player onto
 * `openTracks`, held to the probe's own tracks driven by the same calls at the
 * same step boundaries — rig-c holds that state to the Spine runtime; this
 * holds the player to rig-c. Events are read with the track the player
 * attributes them to, on the figure rig's `walk` (`step` at 0.4 and 1.2) and
 * `nudge` (`hit` at 0.5).
 */
async function tracksProbe(): Promise<TracksProbeResult> {
  const assets = await loadRig('figure');
  const read = assets.document as ReadDocument;
  const view = underNoSkin(read.doc);
  const source = frameSource(view, read.parsed);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const dt = 1 / 60;
  const boneDiff = (player: RigPlayer, pose: RawPose, label: string): string[] => {
    const out: string[] = [];
    for (const bone of pose.bones) {
      const r = player.bone(bone.name);
      const pairs: Array<[string, number | boolean, number | boolean]> = [
        ['active', r.active, bone.active], ['x', r.x, bone.worldX], ['y', r.y, bone.worldY],
        ['a', r.a, bone.a], ['b', r.b, bone.b], ['c', r.c, bone.c], ['d', r.d, bone.d],
        ['scaleX', r.scaleX, bone.scaleX], ['scaleY', r.scaleY, bone.scaleY],
      ];
      for (const [f, got, want] of pairs) if (!Object.is(got, want)) out.push(`${label} ${bone.name}.${f}`);
    }
    return out;
  };
  const geometry = (frame: PosedFrame) => JSON.stringify(frame.order.map((s) => [s.slot, s.kind === 'region' ? s.corners : s.vertices]));

  // A. The single track, unchanged.
  const single = new RigPlayer(root, assets);
  single.play('walk');
  single.seek(0.7);
  const singleBoneMismatches = boneDiff(single, poseAt(assets, 'walk', 0.7).pose, 'single');
  single.dispose();

  // B/C. The composition, mirrored on the probe's own tracks.
  const player = new RigPlayer(root, assets);
  const events: TracksProbeResult['events'] = [];
  const completes: TracksProbeResult['completes'] = [];
  player.on('event', (e) => events.push({ name: e.name, track: e.track, at: player.time }));
  player.on('complete', (c) => completes.push({ animation: c.animation, track: c.track, at: player.time }));
  const own = openTracks(view, { reset: 'animation' });
  let ownPose: RawPose;
  const composedBoneMismatches: string[] = [];
  let composedFrameMismatches = 0;
  let checkpoints = 0;
  const check = (label: string) => {
    checkpoints++;
    composedBoneMismatches.push(...boneDiff(player, ownPose, label));
    if (geometry(player.posedFrame()) !== geometry(frameOf(source, ownPose, player.color))) composedFrameMismatches++;
  };
  const stepBoth = (n: number) => {
    for (let i = 0; i < n; i++) {
      player.advance(dt);
      ownPose = own.step(dt);
    }
  };

  player.play('walk'); // single track for now
  own.setAnimation(0, 'walk', { loop: true, mixDuration: 0 });
  ownPose = own.start();
  stepBoth(18); // 0.3 s on the single track; the probe's tracks are the same walk
  // The first composing call: the player replays its single track onto the tracks (18 steps of dt), then layers.
  player.play('nudge', { track: 1, loop: false, mix: 0.1 });
  own.setAnimation(1, 'nudge', { loop: false, mixDuration: 0.1 });
  ownPose = own.step(0);
  check('layer-set');
  player.queueClear(1, { mix: 0.1 });
  own.addEmptyAnimation(1, 0.1, 0);
  ownPose = own.step(0);
  check('queue-empty');
  const baseAlone = geometry(frameAt(assets, 'walk', player.time));
  stepBoth(6);
  check('t+0.1');
  const layerVisible = geometry(player.posedFrame()) !== geometry(frameAt(assets, 'walk', player.time));
  stepBoth(24);
  check('t+0.5');
  stepBoth(30);
  check('t+1.0');
  stepBoth(20);
  check('t+1.33');
  const entry1AtEnd = player.entry(1);
  player.clear(0, { mix: 0.2 });
  own.setEmptyAnimation(0, 0.2);
  ownPose = own.step(0);
  check('clear-0');
  stepBoth(20);
  check('cleared');
  const entry0AtEnd = player.entry(0);
  const currentAtEnd = player.current;
  void baseAlone;

  let seekRefusal = '';
  try {
    player.seek(0.1);
  } catch (error) {
    seekRefusal = error instanceof Error ? error.message : String(error);
  }
  let skinRefusal = '';
  try {
    player.skin = 'alt';
  } catch (error) {
    skinRefusal = error instanceof Error ? error.message : String(error);
  }
  player.dispose();

  // D. A queue before any play opens the tracks itself.
  const q = new RigPlayer(root, assets);
  q.queue('walk', { loop: true });
  const queueFirstEntry = q.entry(0);
  q.dispose();
  assets.dispose();

  // E. An animation keying an ik timeline: the single track poses it, the tracks refuse it by name.
  const walkRig = await loadRig('walk');
  const w = new RigPlayer(root, walkRig);
  let constraintPlainPlays = false;
  let constraintComposeRefusal = '';
  try {
    w.play('walk');
    w.frame(dt);
    constraintPlainPlays = w.posedFrame().order.length > 0;
    w.play('walk', { track: 1 });
  } catch (error) {
    constraintComposeRefusal = error instanceof Error ? error.message : String(error);
  }
  w.dispose();
  walkRig.dispose();

  return {
    singleBoneMismatches,
    checkpoints,
    composedBoneMismatches,
    composedFrameMismatches,
    layerVisible,
    events,
    completes,
    entry1AtEnd,
    entry0AtEnd,
    currentAtEnd,
    seekRefusal,
    skinRefusal,
    constraintPlainPlays,
    constraintComposeRefusal,
    queueFirstEntry,
  };
}

/**
 * `RigPlayer.slots` (#88): a draw filter. The pose is the whole rig's and the
 * frame record is the unfiltered record with the other slots removed — a clip
 * slot left out no longer clips — in both modes, with `bounds()` reading the
 * drawn slots, and a second renderer drawing the player's pose under another
 * filter on another root.
 */
async function slotFilterProbe(): Promise<SlotFilterProbeResult> {
  const assets = await loadRig('figure');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const keep = ['hand_f', 'arm_f_lo', 'arm_f_up'];
  const strip = (frame: PosedFrame) => JSON.stringify(frame.order);

  const player = new RigPlayer(root, assets);
  player.play('walk');
  player.seek(0.7);
  const unfiltered = player.posedFrame();
  const boneBefore = JSON.stringify(player.bone('hand_f'));
  player.slots = keep;
  const filtered = player.posedFrame();
  const filteredSlots = filtered.order.map((s) => s.slot);
  const removed: PosedFrame = { order: unfiltered.order.filter((s) => keep.includes(s.slot)) };
  const filteredEqualsRemoved = strip(filtered) === strip(removed);
  const boneSameUnderFilter = JSON.stringify(player.bone('hand_f')) === boneBefore;

  // bounds under the filter
  const box = (frame: PosedFrame) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of frame.order) {
      const pts = slot.kind === 'region' ? slot.corners : slot.vertices;
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
      }
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };
  const b = player.bounds();
  const boundsMatchFiltered = JSON.stringify(b) === JSON.stringify(box(filtered));
  const boundsDiffer = JSON.stringify(b) !== JSON.stringify(box(unfiltered));

  // DOM mode draws the filtered set, live.
  // The DOM tier keeps a slot's element and hides it (`display: none`) when a
  // frame no longer carries the slot, so what is counted is the visible ones.
  const visibleImages = () => [...root.querySelectorAll('img')].filter((el) => el.style.display !== 'none').length;
  player.draw();
  const domImages = visibleImages();
  player.slots = ['hand_f'];
  player.draw();
  const domImagesAfterLive = visibleImages();

  // Canvas mode.
  player.slots = keep;
  player.mode = 'canvas'; // the switch draws the held pose at once
  const canvasRenderer = player.renderer as CanvasRenderer;
  const drewOnSwitch = canvasRenderer.drawCalls > 0 && canvasRenderer.blits === 1;
  player.draw(); // the same record again: reused, nothing drawn
  const canvasDrew = drewOnSwitch && canvasRenderer.framesReused === 1 && player.posedFrame().order.length === keep.length;
  player.mode = 'dom';

  // Clipping: the mask animation's clip slot covers the head; left out, it no longer clips.
  player.slots = null;
  player.play('mask');
  player.seek(0.7);
  const maskAll = player.posedFrame();
  const coveredSlots = maskAll.order.filter((s) => s.clip !== undefined).map((s) => s.slot);
  player.slots = [...coveredSlots, 'clip'];
  const withClip = player.posedFrame();
  const coveredWithClipKept = withClip.order.filter((s) => s.clip !== undefined).length;
  const clipKeptSameAsUnfiltered = JSON.stringify(withClip.order.map((s) => [s.slot, s.clip ?? null])) === JSON.stringify(maskAll.order.filter((s) => coveredSlots.includes(s.slot)).map((s) => [s.slot, s.clip ?? null]));
  player.slots = coveredSlots;
  const coveredWithClipOut = player.posedFrame().order.filter((s) => s.clip !== undefined).length;

  let unknownError = '';
  try {
    player.slots = ['no_such_slot'];
  } catch (error) {
    unknownError = error instanceof Error ? error.message : String(error);
  }
  player.slots = (slot) => slot.startsWith('leg');
  const predicateSlots = player.posedFrame().order.map((s) => s.slot);

  // A second renderer on another root, drawing this player's pose under its own filter.
  const other = document.createElement('div');
  document.body.appendChild(other);
  const second = new DomRenderer(other, assets.regionImages, assets.pageImages);
  second.render(player.posedFrame(['hand_f']));
  const secondRootImages = other.querySelectorAll('img').length;
  second.dispose();
  other.remove();

  player.dispose();
  assets.dispose();
  return {
    filteredSlots,
    filteredEqualsRemoved,
    unfilteredCount: unfiltered.order.length,
    coveredWithClipKept,
    coveredWithClipOut,
    clipKeptSameAsUnfiltered,
    boundsMatchFiltered,
    boundsDiffer,
    domImages,
    domImagesAfterLive,
    canvasDrew,
    unknownError,
    predicateSlots,
    secondRootImages,
    boneSameUnderFilter,
  };
}

/**
 * `RigPlayerOptions.tracks` (#93): the player on rig-c's live tracks from the
 * first play. What is measured is the replay — poses the core walked across
 * the first composing call, counted by an `adjust` hook that runs once per
 * pose — and that the tracks pose a plain play as the single track does.
 */
async function trackModeProbe(): Promise<TrackModeProbeResult> {
  const assets = await loadRig('figure');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const dt = 1 / 60;
  const stepsPlayedBefore = 45; // 0.75 s

  const posesAcrossCompose = (tracksOption: boolean): number => {
    let poses = 0;
    const p = new RigPlayer(root, assets, { tracks: tracksOption, adjust: () => { poses++; } });
    p.play('walk');
    for (let i = 0; i < stepsPlayedBefore; i++) p.advance(dt);
    const before = poses;
    p.play('nudge', { track: 1, loop: false, mix: 0.1 });
    const across = poses - before;
    p.dispose();
    return across;
  };
  const posesOnComposeTracks = posesAcrossCompose(true);
  const posesOnComposeDefault = posesAcrossCompose(false);

  const t = new RigPlayer(root, assets, { tracks: true });
  const stepEventTracks: number[] = [];
  const completeTracks: number[] = [];
  t.on('event', (e) => { if (e.name === 'step' && e.track !== undefined) stepEventTracks.push(e.track); });
  t.on('complete', (c) => completeTracks.push(c.track));
  t.play('walk');
  t.seek(0.7);
  const own = poseAt(assets, 'walk', 0.7);
  const tracksSeekBoneMismatches: string[] = [];
  for (const bone of own.pose.bones) {
    const r = t.bone(bone.name);
    for (const [f, got, want] of [['x', r.x, bone.worldX], ['y', r.y, bone.worldY], ['a', r.a, bone.a], ['b', r.b, bone.b], ['c', r.c, bone.c], ['d', r.d, bone.d]] as Array<[string, number, number]>) {
      if (!Object.is(got, want)) tracksSeekBoneMismatches.push(`${bone.name}.${f}`);
    }
  }
  const geometry = (frame: PosedFrame) => JSON.stringify(frame.order.map((s) => [s.slot, s.kind === 'region' ? s.corners : s.vertices]));
  const tracksSeekFrameSame = geometry(t.posedFrame()) === geometry(own.frame);
  let seekBeforeLayerOk = false;
  try {
    t.seek(0.2);
    seekBeforeLayerOk = Math.abs(t.time - 0.2) < 1e-9;
  } catch {
    seekBeforeLayerOk = false;
  }
  t.skin = 'alt';
  const skinBeforeLayerEmblem = t.posedFrame().order.find((s) => s.slot === 'emblem')?.slot ?? null;
  t.skin = undefined;
  // Events and a complete, stepping through 1.6 s of walk on the tracks.
  t.seek(0);
  for (let i = 0; i < 100; i++) t.advance(dt);
  t.play('nudge', { track: 1, loop: false, mix: 0.1 });
  let seekAfterLayerRefusal = '';
  try {
    t.seek(0.1);
  } catch (error) {
    seekAfterLayerRefusal = error instanceof Error ? error.message : String(error);
  }
  t.dispose();
  assets.dispose();
  return {
    posesOnComposeTracks,
    posesOnComposeDefault,
    stepsPlayedBefore,
    tracksSeekBoneMismatches,
    tracksSeekFrameSame,
    seekBeforeLayerOk,
    skinBeforeLayerEmblem,
    seekAfterLayerRefusal,
    stepEventTracks,
    completeTracks,
  };
}

/**
 * `alpha` and `additive` (#93, second part), rig-c 2.39.0's entry weight and
 * additive blending through the player: held to the probe's own `openTracks`
 * driven by the same calls at the same step boundaries — rig-c holds those to
 * the Spine runtime at tolerance 0 (CO52); this holds the player to rig-c.
 */
async function alphaAdditiveProbe(): Promise<AlphaAdditiveProbeResult> {
  const assets = await loadRig('figure');
  const read = assets.document as ReadDocument;
  const view = underNoSkin(read.doc);
  const source = frameSource(view, read.parsed);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  root.replaceChildren();
  const dt = 1 / 60;
  const geometry = (frame: PosedFrame) => JSON.stringify(frame.order.map((s) => [s.slot, s.kind === 'region' ? s.corners : s.vertices]));
  const hipX = (frame: PosedFrame) => {
    const slot = frame.order.find((s) => s.slot === 'badge');
    return slot && slot.kind === 'region' ? slot.corners[0] : NaN;
  };

  const player = new RigPlayer(root, assets, { tracks: true });
  const own = openTracks(view, { reset: 'animation' });
  let ownPose: RawPose;
  const boneMismatches: string[] = [];
  let frameMismatches = 0;
  let checkpoints = 0;
  const check = (label: string) => {
    checkpoints++;
    for (const bone of ownPose.bones) {
      const r = player.bone(bone.name);
      for (const [f, got, want] of [['x', r.x, bone.worldX], ['y', r.y, bone.worldY], ['a', r.a, bone.a], ['b', r.b, bone.b], ['c', r.c, bone.c], ['d', r.d, bone.d]] as Array<[string, number, number]>) {
        if (!Object.is(got, want)) boneMismatches.push(`${label} ${bone.name}.${f}`);
      }
    }
    if (geometry(player.posedFrame()) !== geometry(frameOf(source, ownPose, player.color))) frameMismatches++;
  };
  const stepBoth = (n: number) => {
    for (let i = 0; i < n; i++) {
      player.advance(dt);
      ownPose = own.step(dt);
    }
  };

  player.play('walk');
  own.setAnimation(0, 'walk', { loop: true, mixDuration: 0 });
  ownPose = own.start();
  stepBoth(12);
  check('base');

  // A replacing layer at full weight, then the same at 0.6, to bracket.
  const full = openTracks(view, { reset: 'animation' });
  full.setAnimation(0, 'walk', { loop: true, mixDuration: 0 });
  full.start();
  for (let i = 0; i < 12; i++) full.step(dt);
  full.setAnimation(1, 'nudge', { loop: true, mixDuration: 0 });
  for (let i = 0; i < 18; i++) full.step(dt);
  const fullPose = full.step(0);

  player.play('nudge', { track: 1, loop: true, alpha: 0.6 });
  own.setAnimation(1, 'nudge', { loop: true, mixDuration: 0, alpha: 0.6 });
  ownPose = own.step(0);
  check('alpha-0.6-set');
  const entryAfterSet = player.entry(1);
  stepBoth(18);
  check('alpha-0.6');
  const base = frameAt(assets, 'walk', player.time);
  const weighted = player.posedFrame();
  const fullFrame = frameOf(source, fullPose, player.color);
  const [b, w, f] = [hipX(base), hipX(weighted), hipX(fullFrame)];
  const alphaBetween = Number.isFinite(b) && Number.isFinite(w) && Number.isFinite(f) && b !== f && Math.min(b, f) <= w && w <= Math.max(b, f);

  player.setAlpha(1, 0.85);
  own.setAlpha(1, 0.85);
  ownPose = own.step(0);
  check('alpha-0.85-set');
  const entryAfterSetAlpha = player.entry(1);
  stepBoth(12);
  check('alpha-0.85');

  const replacingFrame = geometry(player.posedFrame());
  player.play('nudge', { track: 2, loop: true, additive: true });
  own.setAnimation(2, 'nudge', { loop: true, mixDuration: 0, additive: true });
  ownPose = own.step(0);
  check('additive-set');
  const entryAdditive = player.entry(2);
  stepBoth(12);
  check('additive');
  const additiveDiffers = geometry(player.posedFrame()) !== replacingFrame;

  let alphaOutOfRangeError = '';
  try {
    player.play('nudge', { track: 3, alpha: 1.5 });
  } catch (error) {
    alphaOutOfRangeError = error instanceof Error ? error.message : String(error);
  }
  player.dispose();

  // An event at alpha 0: nudge keys `hit` at 0.5 s.
  const z = new RigPlayer(root, assets, { tracks: true });
  const hitTracksAtAlphaZero: number[] = [];
  z.on('event', (e) => { if (e.name === 'hit' && e.track !== undefined) hitTracksAtAlphaZero.push(e.track); });
  z.play('walk');
  z.play('nudge', { track: 1, loop: false, alpha: 0 });
  for (let i = 0; i < 40; i++) z.advance(dt);
  let setAlphaEmptyError = '';
  try {
    z.setAlpha(5, 0.5);
  } catch (error) {
    setAlphaEmptyError = error instanceof Error ? error.message : String(error);
  }
  z.dispose();

  const s1 = new RigPlayer(root, assets);
  s1.play('walk');
  s1.advance(dt);
  s1.setAlpha(0, 0.5);
  const setAlphaComposes = s1.composed && (s1.entry(0)?.alpha ?? 0) === 0.5;
  s1.dispose();
  assets.dispose();

  return {
    checkpoints,
    boneMismatches,
    frameMismatches,
    alphaBetween,
    additiveDiffers,
    entryAfterSet,
    entryAfterSetAlpha,
    entryAdditive,
    hitTracksAtAlphaZero,
    alphaOutOfRangeError,
    setAlphaEmptyError,
    setAlphaComposes,
  };
}

/**
 * The element mode's default mesh backend is webgl (#109), and canvas2d its
 * fallback: with WebGL unavailable (the spec blocks the context before the page
 * loads) the first frame draws on canvas2d, and with the shared context lost
 * mid-play the next frame does. Either way the meshes still draw.
 */
async function glFallbackProbe(loseContext: boolean): Promise<GlFallbackProbeResult> {
  const assets = await loadRig('glow');
  const root = makeGlRoot();
  const player = new RigPlayer(root, assets);
  const renderer = player.renderer as DomRenderer;
  renderer.pixelRatio = 0.5;
  const meshBackend = renderer.meshBackend;
  player.play('burn');
  player.seek(0.2);
  player.draw();
  const firstActive = renderer.meshBackendActive;
  const firstPixels = meshPixels(root);
  let lost = false;
  if (loseContext) {
    const blitter = getMeshGlBlitter() as unknown as { gl: WebGLRenderingContext; canvas: HTMLCanvasElement } | null;
    if (blitter) {
      const event = new Promise<void>((resolve) => blitter.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }));
      blitter.gl.getExtension('WEBGL_lose_context')?.loseContext();
      await event;
      lost = getMeshGlBlitter() === null;
    }
  }
  player.frame(0.1);
  const afterActive = renderer.meshBackendActive;
  const afterPixels = meshPixels(root);
  const afterMeshesDrawn = renderer.meshCount;
  player.dispose();
  root.remove();
  assets.dispose();
  return { meshBackend, firstActive, firstPixels, lost, afterActive, afterPixels, afterMeshesDrawn };
}

/**
 * Two-colour (dark) tint in the canvas mode (#106). The `duo` test rig keys
 * only the dark half of each slot's tint, so its oracle is the formula and
 * the canvas mode's own alpha-only fallback: on an opaque grey ramp with a
 * white light half, the GL raster must read `c + (1 − c)·dark`, where `c` is
 * what the fallback draws at the same pixel. The fallback must not change
 * when only the dark colour does.
 */
async function darkTintProbe(): Promise<DarkTintProbeResult> {
  const assets = await loadRig('duo');
  const root = makeGlRoot();
  const player = new RigPlayer(root, assets, { mode: 'canvas' });
  const renderer = player.renderer as CanvasRenderer;
  renderer.pixelRatio = 1;
  player.play('shift', { loop: false });
  const read = (backend: 'webgl' | 'canvas2d'): Uint8ClampedArray => {
    renderer.backend = backend;
    player.draw();
    const ctx = renderer.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    return ctx.getImageData(0, 0, renderer.canvas.width, renderer.canvas.height).data;
  };
  const w = () => renderer.canvas.width;
  const h = () => renderer.canvas.height;
  const darkOf = (frame: PosedFrame, name: string): number[] | null => {
    const slot = frame.order.find((x) => x.slot === name);
    return slot?.dark ? [...slot.dark] : null;
  };

  const times: DarkTintProbeResult['times'] = [];
  const gl: Uint8ClampedArray[] = [];
  const fb: Uint8ClampedArray[] = [];
  for (const time of [0, 0.5, 1]) {
    player.seek(time);
    const frame = player.posedFrame();
    const g = read('webgl');
    const f = read('canvas2d');
    gl.push(g);
    fb.push(f);
    const width = w(), height = h();
    const darks: Record<string, number[] | null> = { swatch: darkOf(frame, 'swatch'), sheet: darkOf(frame, 'sheet') };
    const stats: Record<string, { pixels: number; maxError: number; lift: number[]; liftAt: number }> = {
      swatch: { pixels: 0, maxError: 0, lift: [0, 0, 0], liftAt: Infinity },
      sheet: { pixels: 0, maxError: 0, lift: [0, 0, 0], liftAt: Infinity },
    };
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let inside = true;
        for (let dy = -2; dy <= 2 && inside; dy++) {
          for (let dx = -2; dx <= 2 && inside; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height || f[(yy * width + xx) * 4 + 3] !== 255) inside = false;
          }
        }
        if (!inside) continue;
        const name = x < width / 2 ? 'swatch' : 'sheet';
        const dark = darks[name];
        if (!dark) continue;
        const st = stats[name];
        const i = (y * width + x) * 4;
        st.pixels++;
        for (let k = 0; k < 3; k++) {
          const c = f[i + k] / 255;
          const expected = (c + (1 - c) * dark[k]) * 255;
          st.maxError = Math.max(st.maxError, Math.abs(g[i + k] - expected));
        }
        // The darkest interior texel the slot shows: where the dark half is strongest.
        if (f[i] < st.liftAt) {
          st.liftAt = f[i];
          st.lift = [g[i] - f[i], g[i + 1] - f[i + 1], g[i + 2] - f[i + 2]];
        }
      }
    }
    times.push({
      time,
      swatchDark: darks.swatch,
      sheetDark: darks.sheet,
      swatchPixels: stats.swatch.pixels,
      sheetPixels: stats.sheet.pixels,
      swatchMaxError: stats.swatch.maxError,
      sheetMaxError: stats.sheet.maxError,
      swatchLift: stats.swatch.lift,
      sheetLift: stats.sheet.lift,
    });
  }
  const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    if (a.length !== b.length) return -1;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > 8) n++;
    }
    return n;
  };
  const webglAvailable = getMeshGlBlitter() !== null;
  const result: DarkTintProbeResult = {
    webglAvailable,
    times,
    glChangedBetweenTimes: changed(gl[0], gl[2]),
    fallbackChangedBetweenTimes: changed(fb[0], fb[2]),
  };
  player.dispose();
  root.remove();
  assets.dispose();
  return result;
}

let darkDomState: { player: RigPlayer; root: HTMLElement; assets: ModelAssets } | null = null;

/**
 * The DOM mode over the same rig, posed at `time` and left on the page for the
 * spec to capture: two poses that differ only in the dark colour must capture
 * the same, because the DOM mode does not draw it (README).
 */
async function darkDomPose(time: number): Promise<number> {
  if (darkDomState) {
    darkDomState.player.dispose();
    darkDomState.root.remove();
    darkDomState.assets.dispose();
    darkDomState = null;
  }
  const assets = await loadRig('duo');
  const root = makeGlRoot();
  root.style.left = '220px';
  root.style.top = '220px';
  const player = new RigPlayer(root, assets, { mode: 'dom' });
  player.play('shift', { loop: false });
  player.seek(time);
  player.draw();
  await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)));
  darkDomState = { player, root, assets };
  // Elements the DOM mode shows: the swatch's <img> and the sheet's canvas.
  return Array.from(root.children).filter((el) => (el as HTMLElement).style.display !== 'none').length;
}

/**
 * The first things a consumer meets (2026-10-13 audit, items 1–5): events and
 * completes on a plain `play`, `player.color` reaching the pixels, `timeScale`
 * other than 1 with `pause` / `resume`, `loop: false` holding at its end, and
 * `queue` / `queueClear` with their `delay`. Each reading is taken off the
 * player as a consumer would; the spec states what each must be.
 */
async function playerBasicsProbe(): Promise<PlayerBasicsProbeResult> {
  const assets = await loadRig('figure');
  const root = makeGlRoot();
  const step = 1 / 60;
  const run = (player: RigPlayer, seconds: number, each?: (at: number) => void): void => {
    const n = Math.round(seconds / step);
    for (let i = 0; i < n; i++) {
      player.advance(step);
      each?.(player.time);
    }
  };
  // Every number the bones' world transforms carry, for a numeric difference between two players' poses.
  const bones = (player: RigPlayer): number[] =>
    ['root', 'hip', 'torso', 'head', 'hand_f', 'hand_b', 'leg_f', 'leg_b'].flatMap((b) =>
      Object.values(player.bone(b) as unknown as Record<string, unknown>).filter((v): v is number => typeof v === 'number'));
  const diff = (a: number[], b: number[]): number =>
    a.length !== b.length ? Infinity : a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

  // 1. Events and completes on the single track.
  const plain = new RigPlayer(root, assets);
  const plainEvents: PlayerBasicsProbeResult['plainEvents'] = [];
  const plainCompletes: PlayerBasicsProbeResult['plainCompletes'] = [];
  plain.on('event', (e) => plainEvents.push({ ...e, at: plain.time }));
  plain.on('complete', (c) => plainCompletes.push({ ...c, at: plain.time }));
  plain.play('walk');
  run(plain, 3.3);
  const plainComposed = plain.composed;
  plain.dispose();

  // 4. loop: false holds at the end, and completes once.
  const held = new RigPlayer(root, assets);
  const heldEvents: PlayerBasicsProbeResult['heldEvents'] = [];
  const heldCompletes: PlayerBasicsProbeResult['heldCompletes'] = [];
  held.on('event', (e) => heldEvents.push({ name: e.name, int: e.int, at: held.time }));
  held.on('complete', (c) => heldCompletes.push({ animation: c.animation, at: held.time }));
  held.play('nudge', { loop: false });
  run(held, 1.5);
  const heldBones = bones(held);
  const end = new RigPlayer(root, assets);
  end.play('nudge', { loop: false });
  end.seek(1);
  const heldMaxDiff = diff(heldBones, bones(end));
  const heldResult = { heldTime: held.time, heldCurrent: held.current, heldAnimationTime: held.entry(0)?.animationTime ?? null };
  held.dispose();
  end.dispose();

  // 2. player.color: the frame's tints, then the canvas mode's pixels.
  const tinted = new RigPlayer(root, assets, { mode: 'canvas' });
  (tinted.renderer as CanvasRenderer).pixelRatio = 1;
  tinted.play('walk');
  tinted.seek(1.2);
  const before = tinted.posedFrame();
  tinted.draw();
  const read = (): Uint8ClampedArray => {
    const r = tinted.renderer as CanvasRenderer;
    const ctx = r.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    return ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
  };
  const plainPixels = read();
  const color: [number, number, number, number] = [0.5, 1, 0.25, 1];
  tinted.color = color;
  const after = tinted.posedFrame();
  tinted.draw();
  const tintedPixels = read();
  let tintSlots = 0;
  let tintMaxError = 0;
  for (let i = 0; i < before.order.length; i++) {
    tintSlots++;
    for (let k = 0; k < 4; k++) tintMaxError = Math.max(tintMaxError, Math.abs(after.order[i].tint[k] - before.order[i].tint[k] * color[k]));
  }
  let tintPixels = 0;
  let tintPixelMaxError = 0;
  if (plainPixels.length === tintedPixels.length) {
    for (let i = 0; i < plainPixels.length; i += 4) {
      if (plainPixels[i + 3] !== 255 || tintedPixels[i + 3] !== 255) continue;
      tintPixels++;
      for (let k = 0; k < 3; k++) tintPixelMaxError = Math.max(tintPixelMaxError, Math.abs(tintedPixels[i + k] - plainPixels[i + k] * color[k]));
    }
  } else {
    tintPixelMaxError = Infinity;
  }
  tinted.dispose();

  // 3. timeScale 2, a negative scale, pause and resume.
  const fast = new RigPlayer(root, assets);
  fast.play('walk');
  fast.timeScale = 2;
  for (let i = 0; i < 5; i++) fast.advance(0.1);
  const seeked = new RigPlayer(root, assets);
  seeked.play('walk');
  seeked.seek(1);
  const doubleTime = fast.time;
  const doubleMaxDiff = diff(bones(fast), bones(seeked));
  seeked.dispose();
  fast.timeScale = -1;
  const heldPose = bones(fast);
  fast.advance(0.1);
  const negativeTime = fast.time;
  const negativeMaxDiff = diff(bones(fast), heldPose);
  fast.timeScale = 1;
  fast.pause();
  fast.advance(0.1);
  const pausedTime = fast.time;
  fast.resume();
  fast.advance(0.1);
  const resumedTime = fast.time;
  fast.dispose();

  // 5. queue after the current cycle; queue with a delay; queueClear with a delay.
  const checkpoints = (player: RigPlayer, times: number[]): Array<{ at: number; animation: string | null }> => {
    const out: Array<{ at: number; animation: string | null }> = [];
    let t = 0;
    for (const at of times) {
      run(player, at - t);
      t = at;
      out.push({ at, animation: player.entry(0)?.animation ?? null });
    }
    return out;
  };
  const q1 = new RigPlayer(root, assets);
  const queueAfterCycleHits: number[] = [];
  q1.on('event', (e) => { if (e.name === 'hit') queueAfterCycleHits.push(q1.time); });
  q1.play('walk');
  q1.queue('nudge');
  const queueAfterCycle = checkpoints(q1, [1.5, 1.7, 2.3]);
  q1.dispose();
  const q2 = new RigPlayer(root, assets);
  q2.play('walk');
  q2.queue('nudge', { delay: 0.5 });
  const queueDelayed = checkpoints(q2, [0.4, 0.6]);
  q2.dispose();
  const q3 = new RigPlayer(root, assets);
  q3.play('nudge');
  q3.queueClear(0, { delay: 0.3 });
  const queueClearDelayed = checkpoints(q3, [0.2, 0.4]);
  q3.dispose();

  root.remove();
  assets.dispose();
  return {
    plainComposed,
    plainEvents,
    plainCompletes,
    heldEvents,
    heldCompletes,
    ...heldResult,
    heldMaxDiff,
    tintSlots,
    tintMaxError,
    tintPixels,
    tintPixelMaxError,
    doubleTime,
    doubleMaxDiff,
    negativeTime,
    negativeMaxDiff,
    pausedTime,
    resumedTime,
    queueAfterCycle,
    queueAfterCycleHits,
    queueDelayed,
    queueClearDelayed,
  };
}

/**
 * The player's physics clock (#103). The `look` gallery rig's whip is a
 * physics bone; stepped at a fixed 1/60 s its `tilt` animation ends frames on
 * a physics step's tie, which on the frame clock flips a spring between on
 * time and a step late (rig-c #1380). The player hands every track
 * `physicsClockStep`, so its whip must read the core track given that clock,
 * to the bit, and must not carry the frame clock's outlier frames.
 */
async function physicsClockProbe(): Promise<PhysicsClockProbeResult> {
  const assets = await loadRig('look');
  const read = assets.document as ReadDocument;
  const view = underNoSkin(read.doc);
  const root = makeGlRoot();
  const whip = 'ahoge_whip';
  const reading = (b: { worldX?: number; worldY?: number; x?: number; y?: number; a: number; c: number }): number[] =>
    [b.worldX ?? b.x ?? NaN, b.worldY ?? b.y ?? NaN, b.a, b.c];
  const core = (dts: number[], clock: boolean): number[][] => {
    const track = openTrack(view, 'tilt', { loop: true, reset: 'animation', ...(clock ? { clock: physicsClockStep } : {}) });
    return dts.map((dt) => {
      const bone = track.step(dt).bones.find((b) => b.name === whip);
      if (!bone) throw new Error(`no bone ${whip}`);
      return reading(bone);
    });
  };
  const outliers = (r: number[][]): number[] => {
    const hit = new Set<number>();
    for (let k = 0; k < r[0].length; k++) {
      const d2: number[] = [];
      for (let i = 1; i + 1 < r.length; i++) d2.push(Math.abs(r[i + 1][k] - 2 * r[i][k] + r[i - 1][k]));
      for (let i = 0; i < d2.length; i++) {
        const w = d2.slice(Math.max(0, i - 12), i + 13).sort((x, y) => x - y);
        if (d2[i] > 1e-3 && d2[i] > 8 * w[w.length >> 1]) hit.add(i + 2);
      }
    }
    return [...hit].sort((x, y) => x - y);
  };
  const diff = (a: number[][], b: number[][]): number => {
    let m = 0;
    for (let i = 0; i < a.length; i++) for (let k = 0; k < a[i].length; k++) m = Math.max(m, Math.abs(a[i][k] - b[i][k]));
    return m;
  };
  // A 60 Hz rAF clock with timestamps rounded to 0.1 ms and ±0.2 ms of jitter, seeded.
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const jittered: number[] = [];
  let last = 0;
  for (let i = 1; i <= 600; i++) {
    const t = Math.round((i * 1000 / 60 + (rnd() - 0.5) * 0.4) * 10) / 10;
    jittered.push((t - last) / 1000);
    last = t;
  }
  const patterns: Array<[string, number[]]> = [
    ['fixed 1/20', Array(200).fill(1 / 20)],
    ['fixed 1/60', Array(600).fill(1 / 60)],
    ['rAF 60 Hz, jittered', jittered],
  ];
  const runs: PhysicsClockProbeResult['runs'] = [];
  for (const [name, dts] of patterns) {
    const player = new RigPlayer(root, assets);
    player.play('tilt');
    const series = dts.map((dt) => {
      player.advance(dt);
      return reading(player.bone(whip) as unknown as { x: number; y: number; a: number; c: number });
    });
    player.dispose();
    const withClock = core(dts, true);
    const frameClock = core(dts, false);
    runs.push({
      name,
      frames: dts.length,
      playerVsClock: diff(series, withClock),
      playerVsFrameClock: diff(series, frameClock),
      playerOutliers: outliers(series),
      frameClockOutliers: outliers(frameClock),
    });
  }
  root.remove();
  assets.dispose();
  return { runs };
}

/**
 * The environment the page sets (#121): `environment({ wind, gravity })` and
 * `moved({ x, y, rotation })`, forwarded to the core's live tracks
 * (rig-c/core#1416). The `cloth` test rig is a three-link physics chain whose
 * links answer wind and gravity; `walk` has no physics.
 */
async function environmentProbe(): Promise<EnvironmentProbeResult> {
  const root = makeGlRoot();
  const allBones = (pose: RawPose): number[] => pose.bones.flatMap((b) => [b.worldX, b.worldY, b.a, b.b, b.c, b.d]);
  const playerBones = (player: RigPlayer, names: string[]): number[] =>
    names.flatMap((n) => { const b = player.bone(n) as unknown as { x: number; y: number; a: number; b: number; c: number; d: number }; return [b.x, b.y, b.a, b.b, b.c, b.d]; });
  const diff = (a: number[], b: number[]): number =>
    a.length !== b.length ? Infinity : a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

  // 1. Untouched: byte-identical to the core track given nothing.
  const untouched: EnvironmentProbeResult['untouched'] = [];
  for (const [rig, anim] of [['cloth', 'hang'], ['look', 'tilt'], ['walk', 'walk']] as const) {
    const assets = await loadRig(rig);
    const view = underNoSkin((assets.document as ReadDocument).doc);
    const names = (assets.document as ReadDocument).doc.bones.map((b: { name: string }) => b.name);
    const player = new RigPlayer(root, assets);
    player.play(anim);
    const track = openTrack(view, anim, { loop: true, reset: 'animation', clock: physicsClockStep });
    let maxDiff = 0;
    for (let i = 0; i < 600; i++) {
      player.advance(1 / 60);
      maxDiff = Math.max(maxDiff, diff(playerBones(player, names), allBones(track.step(1 / 60))));
    }
    untouched.push({ rig, maxDiff });
    player.dispose();
    assets.dispose();
  }

  // 2–3. Schedules on the cloth, in both modes: what each step does before it is taken.
  const cloth = await loadRig('cloth');
  type Live = { setEnvironment(e: { wind?: readonly [number, number]; gravity?: readonly [number, number] }): void; physicsTranslate(x: number, y: number): void; physicsRotate(x: number, y: number, d: number): void };
  type Schedule = (i: number, env: (e: { wind?: [number, number]; gravity?: [number, number] }) => void, move: (m: { x?: number; y?: number; rotation?: number }) => void) => void;
  const calmFirst = (i: number, env: Parameters<Schedule>[1]): void => { if (i === 0) env({ wind: [0, 0] }); };
  const schedules: Record<string, Schedule> = {
    calm: (i, env) => calmFirst(i, env),
    gustRight: (i, env) => { calmFirst(i, env); if (i === 60) env({ wind: [1, 0] }); if (i === 120) env({ wind: [0, 0] }); },
    gustLeft: (i, env) => { calmFirst(i, env); if (i === 60) env({ wind: [-1, 0] }); if (i === 120) env({ wind: [0, 0] }); },
    gustHeavy: (i, env) => { if (i === 0) env({ wind: [0, 0], gravity: [0, 3] }); if (i === 60) env({ wind: [1, 0] }); if (i === 120) env({ wind: [0, 0] }); },
    dragRight: (i, env, move) => { calmFirst(i, env); if (i >= 60 && i < 90) move({ x: 5 }); },
    turn: (i, env, move) => { calmFirst(i, env); if (i >= 60 && i < 90) move({ rotation: 3 }); },
  };
  const checkpoints = [59, 89, 119, 179, 239];
  const tipX = (player: RigPlayer): number => (player.bone('tip') as unknown as { x: number }).x;
  const tips: EnvironmentProbeResult['tips'] = {};
  for (const [name, schedule] of Object.entries(schedules)) {
    const byMode = { dom: [] as number[], canvas: [] as number[] };
    for (const mode of ['dom', 'canvas'] as const) {
      const player = new RigPlayer(root, cloth, { mode });
      player.play('hang');
      for (let i = 0; i < 240; i++) {
        schedule(i, (e) => player.environment(e), (m) => player.moved(m));
        player.advance(1 / 60);
        if (checkpoints.includes(i)) byMode[mode].push(tipX(player));
      }
      if (mode === 'canvas') player.draw();
      player.dispose();
    }
    tips[name] = byMode;
  }

  // 6. Through the core: the gust and drag schedules, with the same calls on a core track.
  const clothView = underNoSkin((cloth.document as ReadDocument).doc);
  const clothNames = (cloth.document as ReadDocument).doc.bones.map((b: { name: string }) => b.name);
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const jittered: number[] = [];
  let last = 0;
  for (let i = 1; i <= 240; i++) {
    const t = Math.round((i * 1000 / 60 + (rnd() - 0.5) * 0.4) * 10) / 10;
    jittered.push((t - last) / 1000);
    last = t;
  }
  const both: Schedule = (i, env, move) => { schedules.gustRight(i, env, move); schedules.dragRight(i, () => {}, move); };
  const throughCore: EnvironmentProbeResult['throughCore'] = [];
  for (const [name, dts] of [['fixed 1/20', Array(240).fill(1 / 20)], ['fixed 1/60', Array(240).fill(1 / 60)], ['rAF 60 Hz, jittered', jittered]] as Array<[string, number[]]>) {
    const player = new RigPlayer(root, cloth);
    player.play('hang');
    const track = openTrack(clothView, 'hang', { loop: true, reset: 'animation', clock: physicsClockStep }) as unknown as Live & { step(dt: number): RawPose };
    let maxDiff = 0;
    dts.forEach((dt, i) => {
      both(i, (e) => player.environment(e), (m) => player.moved(m));
      both(i, (e) => track.setEnvironment(e), (m) => { if (m.x || m.y) track.physicsTranslate(m.x ?? 0, m.y ?? 0); if (m.rotation) track.physicsRotate(0, 0, m.rotation); });
      player.advance(dt);
      maxDiff = Math.max(maxDiff, diff(playerBones(player, clothNames), allBones(track.step(dt))));
    });
    throughCore.push({ name, maxDiff });
    player.dispose();
  }

  // 4. No physics, no change.
  const walk = await loadRig('walk');
  const walkNames = (walk.document as ReadDocument).doc.bones.map((b: { name: string }) => b.name);
  const quiet = new RigPlayer(root, walk);
  const busy = new RigPlayer(root, walk);
  quiet.play('walk');
  busy.play('walk');
  let noPhysicsMaxDiff = 0;
  for (let i = 0; i < 240; i++) {
    busy.environment({ wind: [Math.sin(i), 2], gravity: [1, -1] });
    busy.moved({ x: 3, y: -2, rotation: 1 });
    quiet.advance(1 / 60);
    busy.advance(1 / 60);
    noPhysicsMaxDiff = Math.max(noPhysicsMaxDiff, diff(playerBones(quiet, walkNames), playerBones(busy, walkNames)));
  }
  quiet.dispose();
  busy.dispose();
  walk.dispose();

  // What environment() reports.
  const flat = (e: { wind: readonly number[]; gravity: readonly number[] }): number[] => [...e.wind, ...e.gravity];
  const fresh = new RigPlayer(root, cloth);
  const beforePlay = flat(fresh.environment({ wind: [0.5, 0] }));
  fresh.play('hang');
  const afterHalf = flat(fresh.environment({ gravity: [0, 2] }));
  const afterNull = flat(fresh.environment(null));
  fresh.dispose();

  cloth.dispose();
  root.remove();
  return { untouched, tips, throughCore, noPhysicsMaxDiff, beforePlay, afterHalf, afterNull };
}

window.rigPlayHarness = {
  environmentProbe,
  physicsClockProbe,
  playerBasicsProbe,
  darkTintProbe,
  darkDomPose,
  glFallbackProbe,
  alphaAdditiveProbe,
  trackModeProbe,
  slotFilterProbe,
  tracksProbe,
  regionLoadingProbe,
  skinProbe,
  canvasScaledStageProbe,
  adjustProbe,
  boneBoundsProbe,
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
  meshSwitchProbe,
  movingMeshClipProbe,
  heldMeshTranslateProbe,
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
