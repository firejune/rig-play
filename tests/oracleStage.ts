import {
  AnimationState,
  AnimationStateData,
  Physics,
  Skeleton,
  type SkeletonData,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import { GLTexture, ManagedWebGLRenderingContext, SceneRenderer } from '@esotericsoftware/spine-webgl';

import { type DomRenderer, loadModel, type ModelAssets, type RegionImage, RigPlayer } from '../src/index';
import { advanceSkeleton } from './skeletonFrame';
import { DomTexture, loadSkeletonJson, SkeletonRenderer, unpackAtlas } from './spineDom';

/**
 * The pixel oracle's two stages: this package, and the official runtime.
 *
 * ## Why a second runtime is in the tree at all
 *
 * Every visual test here is an A/B between this package's own two mesh
 * backends. That catches one backend drifting from the other and cannot, by
 * construction, catch a defect they share. #37 was exactly that shape — `pma:
 * true` pages drawn one multiply too dark in *every* tier — and the suite
 * stayed green for months while a consumer found it. So the oracle compares
 * against something that is not us: `@esotericsoftware/spine-webgl`, drawing
 * the same export, in the same pose, at the same size, on the same page.
 *
 * It is a **devDependency and nothing else**: this file is the only one that
 * names it, it lives under `tests/`, and nothing in `src/` may reach it —
 * `tsconfig.build.json` compiles all of `src/` and `tests/package.spec.ts`
 * pins the emitted file set, so a reference import that drifted into the
 * library would ship to npm. The dependency runs the other way round on
 * purpose: the harness imports from `src/`, never the reverse.
 *
 * ## The mapping the comparison rests on
 *
 * The two renderers are only comparable if world space lands on the same
 * pixels, so the mapping is derived rather than eyeballed, once, here.
 *
 * The DOM side puts the skeleton root at (`originX`, `originY`) CSS px inside
 * the stage, `transform-origin: 0 0`, `transform: scale(S)`. Spine is Y-up, so
 * a world point (x, y) lands at
 *
 *     px = originX + S·x        py = originY − S·y
 *
 * The reference side draws through an orthographic camera into a canvas of the
 * same W × H. An ortho camera maps world x to NDC `(x − cx) / (vw/2)`, and the
 * viewport maps that to `px = W/2 + (x − cx)·W/vw`; the framebuffer's Y is up,
 * so the screenshot reads `py = H/2 − (y − cy)·H/vh`. Setting those two equal
 * to the DOM pair and solving gives the whole camera:
 *
 *     vw = W / S                cx = (W/2 − originX) / S
 *     vh = H / S                cy = (originY − H/2) / S
 *
 * with the canvas backing store at `W·dpr × H·dpr` and the GL viewport over
 * all of it, which cancels out of both ratios. Nothing here is fitted to a
 * picture — and `tests/oracle.spec.ts` proves the alignment the way this
 * repository proves everything else, by driving it: a deliberate one-world-unit
 * offset on the DOM side has to be *detected*.
 *
 * `scale` is 0.5 because spineboy's atlas was packed at half the skeleton's own
 * units (its pages carry `scale: 0.5`, which spine-core ignores — it is the
 * packer's note to itself), so half scale is where one texel is one CSS pixel
 * and neither side is asked to resample. That keeps the forgivable residue —
 * GL's linear filtering against the browser's image scaling — at its floor
 * instead of inflating it with a downscale neither runtime was asked for.
 *
 * ## Two kinds of cell
 *
 * - **spineboy** (`rig` absent): both sides draw the spineboy export posed by
 *   spine-core. The DOM side reads the posed skeleton into a frame
 *   (`tests/skeletonFrame.ts`) and draws it with the package's renderer. These
 *   are the renderer's cells: every tier, both alpha conventions, clipping,
 *   additive blend, slot colour — what no gallery build carries.
 * - **gallery** (`rig` set): the package end to end. The DOM side loads the
 *   build's `skeleton.model.json` with `loadModel` and plays it with
 *   `RigPlayer` — posed by `rig-c/core`, never by spine-core — and the
 *   reference draws the `skeleton.json` + `skeleton.atlas` the same build wrote
 *   beside it, posed by spine-core. Both take pose 0 and then the same `dt`
 *   steps (`GALLERY_DT`): rigc's render recipe on one side, `openTrack` on the
 *   other, which `tests/frames.spec.ts` holds equal at tolerance 0 — so what
 *   the diff sees is the drawing alone. The stage is sized from the build's
 *   own stage box at scale 1, where one texel of its one-part pages is one CSS
 *   pixel.
 *
 * ## What is deliberately shared, and what is not
 *
 * The pose is: both sides run the identical call sequence (`state.update`,
 * `apply`, `skeleton.update`, `updateWorldTransform(Physics.update)`) from the
 * same animation and track time on the same export, so bone transforms and
 * deform are bit-identical float work, not "close enough".
 *
 * The atlas is not, and cannot be: a page needs a `DomTexture` for this package
 * and a `GLTexture` for the reference, so each side parses its own
 * `TextureAtlas` over the same atlas text and the same page image. That is the
 * only divergence above the renderers themselves.
 */

/**
 * Stage geometry — see the mapping derivation above.
 *
 * Sized from the poses the oracle draws rather than guessed, with a 12 px
 * margin: measured against the origin, the union of every cell's slot boxes
 * runs x ∈ [−357.5, +377.0] and y ∈ [−515.9, +140.4] CSS px (`portal` reaches
 * furthest left and up, `shoot` furthest right — its crosshair sits well off
 * the body — and `hoverboard` furthest down). A pose that outgrew the stage
 * would be compared on a crop, which is why `tests/oracle.spec.ts` asserts
 * containment per capture instead of trusting these numbers to stay true.
 */
export const ORACLE_STAGE = {
  width: 760,
  height: 690,
  originX: 370,
  originY: 528,
  scale: 0.5,
  background: '#14161a',
} as const;

const ASSET_BASE = '/spineboy';

/** The gallery cells' step: pose 0, then whole steps of this to the cell's time. */
export const GALLERY_DT = 1 / 60;
/**
 * Gallery stage: scale 1 (one texel per CSS pixel on a one-part page) and a
 * margin round the build's stage box — the document's `stage`, which is the
 * setup pose's box: a rig's animations reach past it (`nod` hangs 25 units
 * below it, `ride`'s wheels 10 to its left), and the spec asserts the DOM side
 * stays inside the capture.
 */
const GALLERY_SCALE = 1;
const GALLERY_MARGIN = 48;

interface StageGeometry {
  width: number;
  height: number;
  originX: number;
  originY: number;
  scale: number;
}

export interface OracleStageOptions {
  /** Which runtime draws this capture. */
  side: 'dom' | 'reference';
  /**
   * A gallery build under `public/rigs/` — the package end to end (see *Two
   * kinds of cell*). Absent: the spineboy cells, where `page` and `skeleton`
   * pick the export.
   */
  rig?: string;
  /** `plain` is the shipped straight-alpha page; `pma` the exporter's premultiplied twin. */
  page: 'plain' | 'pma';
  skeleton: 'ess' | 'pro';
  animation: string;
  time: number;
  /** Mesh raster backend — the DOM side only; the reference has one path. */
  backend?: 'canvas2d' | 'webgl';
  /** Whole-skeleton tint, 6 hex digits. Multiplies both runtimes' vertex/filter colour. */
  tint?: string | null;
  /** Apply clipping attachments on the DOM side (the reference always clips). */
  clipping?: boolean;
  /**
   * World units added to the skeleton's X on **this** capture. The alignment
   * probe: offsetting one side and nothing else must move the picture.
   */
  offsetX?: number;
}

export interface OracleStageResult {
  /** Which runtime drew, echoed back so a spec cannot mis-attribute a capture. */
  side: 'dom' | 'reference';
  /** Read off the parsed atlas, so a cell cannot silently test the wrong page. */
  pagePma: boolean;
  pageSize: { width: number; height: number };
  /** DOM side: slot elements and the backend that actually rasterized. */
  imageCount: number;
  canvasCount: number;
  backendActive: string;
  meshesDrawn: number;
  /** Reference side: batcher draw calls — zero means nothing reached the GPU. */
  drawCalls: number;
  /** Which spine-webgl generation the reference is running on. */
  referenceShape: 'pre-4.3' | '4.3';
  /**
   * What posed the DOM side: spine-core (a spineboy cell, read into a frame by
   * the test suite) or `rig-c/core` (a gallery cell, through `RigPlayer`).
   * Reported so a log says which path a cell exercised.
   */
  poser: 'spine-core' | 'rig-c/core';
  /** The stage the capture covers, so a spec never hard-codes its size. */
  stage: { width: number; height: number };
  /**
   * How many of the atlas's regions the packer stored rotated (`rotate: 90`).
   *
   * Reported because the oracle found a disagreement that only such a region
   * produces, and a *feature* test is how this repository keys on an absent
   * capability rather than on a version: the spineboy atlas on the 4.3 branch
   * rotates nothing and the one on the 4.2 branch rotates ten, so a version key
   * would say "4.2" where the truth is "this packer rotated something".
   * `tests/oracle.spec.ts` carries what was measured.
   */
  rotatedRegions: number;
  /** Union of the drawn boxes in stage coordinates — the stage must contain it. */
  contentBox: { x: number; y: number; width: number; height: number };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = url;
  });
}

function atlasUrl(page: 'plain' | 'pma'): string {
  return page === 'pma' ? `${ASSET_BASE}/spineboy-pma.atlas` : `${ASSET_BASE}/spineboy.atlas`;
}

/**
 * The reference's generation seam — the whole of it.
 *
 * spine-webgl moved the alpha convention from the draw call onto the texture
 * between 4.2 and 4.3: 4.2 uploads the page as stored and is told
 * `drawSkeleton(skeleton, premultipliedAlpha)`, while 4.3 normalizes the upload
 * (`UNPACK_PREMULTIPLY_ALPHA_WEBGL = !pma`) and always blends premultiplied, so
 * its `drawSkeleton` has no such argument and `GLTexture` takes the flag
 * instead. Both are correct for both page conventions; only the call shape
 * differs.
 *
 * Which one is installed is read off the live object, the way
 * `src/coreCompat.ts` reads the core's shape: 4.2's `SkeletonRenderer` carries a
 * `premultipliedAlpha` field and 4.3's does not. Not a version string — a
 * vendored or bundled copy need not carry one — and not a try/catch.
 */
interface ReferenceCompat {
  readonly shape: 'pre-4.3' | '4.3';
  makeTexture(context: ManagedWebGLRenderingContext, image: HTMLImageElement, pma: boolean): GLTexture;
  drawSkeleton(renderer: SceneRenderer, skeleton: Skeleton, pma: boolean): void;
}

/** 4.2's shapes, structurally — these casts never leave this file. */
interface PrePoseGLTextureCtor {
  new (context: ManagedWebGLRenderingContext, image: HTMLImageElement): GLTexture;
}
interface PrePoseSceneRenderer {
  drawSkeleton(skeleton: Skeleton, premultipliedAlpha: boolean): void;
}

function referenceCompatFor(renderer: SceneRenderer): ReferenceCompat {
  const prePose = 'premultipliedAlpha' in renderer.skeletonRenderer;
  if (prePose) {
    return {
      shape: 'pre-4.3',
      makeTexture: (context, image) =>
        new (GLTexture as unknown as PrePoseGLTextureCtor)(context, image),
      drawSkeleton: (sceneRenderer, skeleton, pma) =>
        (sceneRenderer as unknown as PrePoseSceneRenderer).drawSkeleton(skeleton, pma),
    };
  }
  return {
    shape: '4.3',
    makeTexture: (context, image, pma) => new GLTexture(context, image, pma),
    drawSkeleton: (sceneRenderer, skeleton) => sceneRenderer.drawSkeleton(skeleton),
  };
}

let stageEl: HTMLDivElement | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let glContext: ManagedWebGLRenderingContext | null = null;
let sceneRenderer: SceneRenderer | null = null;
let compat: ReferenceCompat | null = null;
let domLive: { dispose(): void } | null = null;

function stageElement(geometry: StageGeometry): HTMLDivElement {
  const stage = stageEl ?? document.createElement('div');
  stage.id = 'oracle-stage';
  stage.style.cssText =
    'position: absolute; left: 0; top: 0; overflow: hidden;' +
    `width: ${geometry.width}px; height: ${geometry.height}px;` +
    `background: ${ORACLE_STAGE.background};`;
  if (!stageEl) document.body.append(stage);
  stageEl = stage;
  return stage;
}

/**
 * One WebGL context for the whole document, like the library's own blitter —
 * browsers cap contexts at ~16 and this page also runs the library's.
 *
 * `preserveDrawingBuffer` because the capture is a screenshot taken after the
 * draw has returned, not a readback inside it; `alpha: false` so the clear
 * colour *is* the backdrop and the two stages share one background rather than
 * compositing over different ones.
 */
function reference(): {
  canvas: HTMLCanvasElement;
  context: ManagedWebGLRenderingContext;
  renderer: SceneRenderer;
  compat: ReferenceCompat;
} {
  if (glCanvas && glContext && sceneRenderer && compat) {
    return { canvas: glCanvas, context: glContext, renderer: sceneRenderer, compat };
  }
  // Sized per capture (`sizeReference`): one context for every stage size.
  const canvas = document.createElement('canvas');
  canvas.id = 'oracle-reference';
  const context = new ManagedWebGLRenderingContext(canvas, {
    alpha: false,
    preserveDrawingBuffer: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!context.gl) throw new Error('the reference runtime could not get a WebGL context');
  const renderer = new SceneRenderer(canvas, context);
  glCanvas = canvas;
  glContext = context;
  sceneRenderer = renderer;
  compat = referenceCompatFor(renderer);
  return { canvas, context, renderer, compat };
}

/** The reference canvas at a stage's size — backing at `dpr`, the viewport over all of it. */
function sizeReference(canvas: HTMLCanvasElement, geometry: StageGeometry): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(geometry.width * dpr);
  const height = Math.round(geometry.height * dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.cssText =
    `position: absolute; left: 0; top: 0;` +
    `width: ${geometry.width}px; height: ${geometry.height}px;`;
}

/** Atlas, bitmaps and skeleton data for one (side, page, skeleton), built once. */
interface OracleScene {
  atlas: TextureAtlas;
  /** Null on a gallery cell's DOM side, which reads the model instead. */
  data: SkeletonData | null;
  /** DOM side only. */
  regionImages: Map<string, RegionImage>;
  pageImage: HTMLImageElement;
  /** A gallery cell's DOM side: the build as `loadModel` loaded it. */
  model: ModelAssets | null;
  geometry: StageGeometry;
}

const scenes = new Map<string, Promise<OracleScene>>();

/**
 * Kept for the document's lifetime, like the pma stage's: unpacking per capture
 * would hand every screenshot a blob the compositor has never rastered, and a
 * cold-against-warm raster reads as a difference between *captures* rather than
 * between runtimes.
 */
function scene(options: OracleStageOptions): Promise<OracleScene> {
  const key = options.rig
    ? `${options.side}@rig@${options.rig}`
    : `${options.side}@${options.page}@${options.skeleton}`;
  const cached = scenes.get(key);
  if (cached) return cached;
  const built = options.rig ? galleryScene(options.side, options.rig) : spineboyScene(options);
  scenes.set(key, built);
  return built;
}

/** A gallery build's stage at scale 1, its stage box inset by the margin. */
interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function galleryGeometry(box: StageBox): StageGeometry {
  return {
    width: Math.ceil(box.width * GALLERY_SCALE) + 2 * GALLERY_MARGIN,
    height: Math.ceil(box.height * GALLERY_SCALE) + 2 * GALLERY_MARGIN,
    originX: GALLERY_MARGIN - box.x * GALLERY_SCALE,
    originY: GALLERY_MARGIN + (box.y + box.height) * GALLERY_SCALE,
    scale: GALLERY_SCALE,
  };
}

async function galleryScene(side: 'dom' | 'reference', rig: string): Promise<OracleScene> {
  const base = `/rigs/${rig}`;
  const atlas = new TextureAtlas(await (await fetch(`${base}/skeleton.atlas`)).text());
  if (side === 'dom') {
    const model = await loadModel({ modelUrl: `${base}/skeleton.model.json` });
    if (!model.stage) throw new Error(`${rig}: the document states no stage box to size the capture from`);
    const pageImage = model.pageImages.values().next().value as HTMLImageElement;
    return { atlas, data: null, regionImages: model.regionImages, pageImage, model, geometry: galleryGeometry(model.stage) };
  }
  let pageImage: HTMLImageElement | null = null;
  for (const page of atlas.pages) {
    const image = await loadImage(`${base}/${page.name}`);
    pageImage ??= image;
    page.setTexture(reference().compat.makeTexture(reference().context, image, page.pma));
  }
  if (!pageImage) throw new Error('the atlas declared no pages');
  const data = await loadSkeletonJson(atlas, `${base}/skeleton.json`);
  // The same box the DOM side frames by: the document's stage, read as data —
  // the Spine header's own bounds differ from it on some builds, and two
  // cameras over two boxes would compare two crops.
  const box = (JSON.parse(await (await fetch(`${base}/skeleton.model.json`)).text()) as { stage: StageBox }).stage;
  return { atlas, data, regionImages: new Map(), pageImage, model: null, geometry: galleryGeometry(box) };
}

function spineboyScene(options: OracleStageOptions): Promise<OracleScene> {
  return (async (): Promise<OracleScene> => {
    const atlasText = await (await fetch(atlasUrl(options.page))).text();
    const atlas = new TextureAtlas(atlasText);
    const pageImages = new Map<string, HTMLImageElement>();
    let pageImage: HTMLImageElement | null = null;
    for (const page of atlas.pages) {
      const image = await loadImage(`${ASSET_BASE}/${page.name}`);
      pageImage = image;
      pageImages.set(page.name, image);
      if (options.side === 'dom') {
        page.setTexture(new DomTexture(image));
      } else {
        page.setTexture(reference().compat.makeTexture(reference().context, image, page.pma));
      }
    }
    if (!pageImage) throw new Error('the atlas declared no pages');
    const regionImages =
      options.side === 'dom'
        ? await unpackAtlas(atlas, pageImages)
        : new Map<string, RegionImage>();
    const data = await loadSkeletonJson(atlas, `${ASSET_BASE}/spineboy-${options.skeleton}.json`);
    return { atlas, data, regionImages, pageImage, model: null, geometry: ORACLE_STAGE };
  })();
}

function parseTint(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/**
 * Poses a skeleton. Both sides call this with identical arguments, so any
 * difference in the captures is the renderers' and never the pose's.
 *
 * The last line is the core's own generation seam, read the same way the
 * reference's is — see `src/coreOptional.ts`. Both sides of the oracle go
 * through it, so the two skeletons are posed by one call either way.
 */
function posed(data: SkeletonData, options: OracleStageOptions): Skeleton {
  const skeleton = new Skeleton(data);
  const tint = parseTint(options.tint);
  if (tint) skeleton.color.set(tint.r, tint.g, tint.b, 1);
  skeleton.x = options.offsetX ?? 0;
  const state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, options.animation, true);
  if (options.rig) {
    // A gallery cell: rigc's render recipe — pose 0 with the physics reset
    // there, then whole GALLERY_DT steps — which the DOM side's track takes too.
    skeleton.setupPose();
    state.apply(skeleton);
    skeleton.update(0);
    skeleton.updateWorldTransform(Physics.reset);
    for (let i = 0; i < galleryStepsOf(options.time); i++) {
      state.update(GALLERY_DT);
      state.apply(skeleton);
      skeleton.update(GALLERY_DT);
      skeleton.updateWorldTransform(Physics.update);
    }
    return skeleton;
  }
  state.update(options.time);
  state.apply(skeleton);
  advanceSkeleton(skeleton, options.time);
  return skeleton;
}

/** How many GALLERY_DT steps a gallery cell's time is. */
function galleryStepsOf(time: number): number {
  return Math.round(time / GALLERY_DT);
}

const round = (value: number): number => Math.round(value * 100) / 100;

async function drawDom(
  stage: HTMLDivElement,
  scene: OracleScene,
  options: OracleStageOptions,
): Promise<Pick<OracleStageResult, 'imageCount' | 'canvasCount' | 'backendActive' | 'meshesDrawn' | 'contentBox'>> {
  const geometry = scene.geometry;
  const root = document.createElement('div');
  // A gallery cell cannot move its skeleton in world space (the model has no
  // `skeleton.x`), so the alignment offset moves the root by the same amount
  // on screen: px = originX + S·(x + offset).
  const shift = scene.model ? (options.offsetX ?? 0) * geometry.scale : 0;
  root.style.cssText =
    `position: absolute; left: ${geometry.originX + shift}px; top: ${geometry.originY}px;` +
    `transform-origin: 0 0; transform: scale(${geometry.scale});`;
  stage.append(root);

  let renderer: DomRenderer;
  if (scene.model) {
    const player = new RigPlayer(root, scene.model, { meshBackend: options.backend ?? 'canvas2d' });
    renderer = player.renderer as DomRenderer;
    if (options.clipping !== undefined) renderer.clipping = options.clipping;
    renderer.pixelRatio = (window.devicePixelRatio || 1) * geometry.scale;
    const tint = parseTint(options.tint);
    if (tint) player.color = [tint.r, tint.g, tint.b, 1];
    player.play(options.animation, { loop: true });
    for (let i = 0; i < galleryStepsOf(options.time); i++) player.advance(GALLERY_DT);
    player.draw();
    domLive = player;
  } else {
    const skeleton = posed(scene.data as SkeletonData, options);
    const skeletonRenderer = new SkeletonRenderer(root, scene.regionImages);
    renderer = skeletonRenderer;
    renderer.meshBackend = options.backend ?? 'canvas2d';
    if (options.clipping !== undefined) renderer.clipping = options.clipping;
    // Raster at the resolution the stage shows at, exactly as the demo does.
    renderer.pixelRatio = (window.devicePixelRatio || 1) * geometry.scale;
    skeletonRenderer.renderSkeleton(skeleton);
    domLive = skeletonRenderer;
  }

  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  // A freshly decoded bitmap is not yet a settled raster (the cut-rule stage
  // measures chromium raising a scaled image's quality a frame or two in).
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

  return {
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

async function drawReference(
  stage: HTMLDivElement,
  scene: OracleScene,
  options: OracleStageOptions,
): Promise<Pick<OracleStageResult, 'drawCalls' | 'referenceShape' | 'contentBox'>> {
  const { canvas, context, renderer, compat: seam } = reference();
  const geometry = scene.geometry;
  sizeReference(canvas, geometry);
  stage.append(canvas);

  const gl = context.gl;
  gl.viewport(0, 0, canvas.width, canvas.height);
  const bg = parseTint(ORACLE_STAGE.background.slice(1));
  if (!bg) throw new Error('the stage background is not a 6-digit hex colour');
  gl.clearColor(bg.r, bg.g, bg.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const camera = renderer.camera;
  camera.viewportWidth = geometry.width / geometry.scale;
  camera.viewportHeight = geometry.height / geometry.scale;
  camera.position.x = (geometry.width / 2 - geometry.originX) / geometry.scale;
  camera.position.y = (geometry.originY - geometry.height / 2) / geometry.scale;
  camera.position.z = 0;

  const skeleton = posed(scene.data as SkeletonData, options);
  const pma = scene.atlas.pages[0]?.pma ?? false;
  renderer.begin();
  seam.drawSkeleton(renderer, skeleton, pma);
  renderer.end();
  const drawCalls = renderer.batcher.getDrawCalls();
  gl.finish();
  // The screenshot is taken by the compositor, so give it the frames the DOM
  // side also gets — same settling, same number of them.
  for (let frame = 0; frame < 8; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // The reference draws into one canvas, so its "boxes" are that canvas: the
  // spec's stage-containment guard is the DOM side's job, and this keeps the
  // two results one shape.
  return {
    drawCalls,
    referenceShape: seam.shape,
    contentBox: {
      x: 0,
      y: 0,
      width: geometry.width,
      height: geometry.height,
    },
  };
}

/**
 * Draws one capture of one runtime into `#oracle-stage`, and returns what the
 * spec needs to know the capture is not vacuous.
 */
export async function oracleStage(options: OracleStageOptions): Promise<OracleStageResult> {
  if (domLive) {
    domLive.dispose();
    domLive = null;
  }
  const built = await scene(options);
  const stage = stageElement(built.geometry);
  stage.replaceChildren();

  const base = {
    poser: (built.model ? 'rig-c/core' : 'spine-core') as OracleStageResult['poser'],
    side: options.side,
    pagePma: built.atlas.pages[0]?.pma ?? false,
    pageSize: { width: built.pageImage.naturalWidth, height: built.pageImage.naturalHeight },
    imageCount: 0,
    canvasCount: 0,
    backendActive: '',
    meshesDrawn: 0,
    drawCalls: 0,
    referenceShape: '4.3' as const,
    stage: { width: built.geometry.width, height: built.geometry.height },
    rotatedRegions: built.atlas.regions.filter((region) => region.degrees !== 0).length,
  };

  if (options.side === 'dom') {
    return { ...base, ...(await drawDom(stage, built, options)) };
  }
  return { ...base, ...(await drawReference(stage, built, options)) };
}
