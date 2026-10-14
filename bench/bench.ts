import { CanvasRenderer } from '../src/CanvasRenderer';
import { DomRenderer, type MeshBackend } from '../src/DomRenderer';
import { loadModel, type ModelAssets } from '../src/loadModel';
import { glContextCount } from '../src/MeshGlBlitter';
import { type RenderMode, RigPlayer } from '../src/player';
import { OfficialOracle, type OfficialInstance, type OracleViewport } from '../tests/officialOracle';

/**
 * Development comparison page: DOM, canvas mode and official spine-webgl.
 * All use one layout/crop derivation and the same pose history. Grids share
 * one official context; only `many` creates independent contexts per player.
 * Concurrent display has one document rAF cadence, so it is not independent
 * performance evidence. The CLI loads one runtime per row for device readings.
 * `measurement=counters` runs no automatic animation clock and exposes no
 * timings: runCounters steps deterministic frames and reports counters only.
 * Assets are loaded/decoded by this package before official GL uploads.
 * Nothing in this page or its official adapter enters the published library.
 */

const params = new URLSearchParams(location.search);

type SceneName = 'mesh' | 'held' | 'rigid' | 'many';
type RuntimeMode = 'both' | 'all' | 'dom' | 'canvas' | 'official';
type SideName = 'dom' | 'canvas' | 'official';
const countersOnly = params.get('measurement') === 'counters';
const UNAVAILABLE = '측정 불가: 헤드리스';
const preserveDrawingBuffer = countersOnly || params.get('capture') === '1';

interface SceneSpec {
  /** A build under `/rigs/`. */
  rig: string;
  animation: string;
  timeScale: number;
  /** Players per side. */
  count: number;
  /**
   * Stage scale for **one rig filling the pane**. A grid divides it by the
   * column count (`layoutFor`), so a rig keeps the same size relative to its
   * cell however dense the grid gets and a count sweep varies the number of
   * rigs rather than how much of each one is cropped away.
   */
  scale: number;
  /** What each rig is clipped to, in all panes. */
  clip: 'pane' | 'cell';
}

const SCENE_NAMES: SceneName[] = ['mesh', 'held', 'rigid', 'many'];

/**
 * The cap on `count`. 64 rigs is 8 columns of 8 on this page's grid. A denser grid
 * would measure still smaller thumbnails rather than another rendering regime. It is a page limit, not a
 * library one.
 */
const MAX_COUNT = 64;

/** Where a rig's stage box bottom sits inside its cell, as a fraction of the cell's height. */
const FLOOR = 0.96;

function readScene(): { name: SceneName; spec: SceneSpec } {
  const raw = params.get('scene');
  const name: SceneName = SCENE_NAMES.includes(raw as SceneName) ? (raw as SceneName) : 'mesh';
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Math.floor(Number(params.get('count')) || (name === 'many' ? 8 : 1))),
  );
  const specs: Record<SceneName, SceneSpec> = {
    mesh: { rig: 'portrait-packed', animation: 'turn', timeScale: 1, count, scale: 0.5, clip: 'pane' },
    held: { rig: 'portrait-packed', animation: 'turn', timeScale: 0, count, scale: 0.5, clip: 'pane' },
    rigid: { rig: 'walk-packed', animation: 'walk', timeScale: 1, count, scale: 0.5, clip: 'pane' },
    many: { rig: 'walk-packed', animation: 'walk', timeScale: 1, count, scale: 0.5, clip: 'cell' },
  };
  const spec = { ...specs[name] };
  // Another build, another animation; the scene still decides count, scale,
  // the clip and whether the pose is held.
  const rig = params.get('rig');
  if (rig) spec.rig = rig;
  const animation = params.get('anim');
  if (animation) spec.animation = animation;
  const scaleParam = params.get('scale');
  if (scaleParam) spec.scale = Number(scaleParam) || spec.scale;
  // `?timescale=0` freezes any scene without inventing a scene.
  const timeScaleParam = params.get('timescale');
  if (timeScaleParam !== null) spec.timeScale = Number(timeScaleParam) || 0;
  return { name, spec };
}

const { name: sceneName, spec: scene } = readScene();
const modelUrl = params.get('model') ?? `/rigs/${scene.rig}/skeleton.model.json`;
const runtime: RuntimeMode = ((): RuntimeMode => {
  const raw = params.get('runtime');
  return raw === 'dom' || raw === 'canvas' || raw === 'official' || raw === 'both' ? raw : 'all';
})();
const backend: MeshBackend = params.get('backend') === 'canvas2d' ? 'canvas2d' : 'webgl';
const skin = params.get('skin') ?? undefined;
const dprOverride = params.get('dpr') !== null ? Number(params.get('dpr')) || 1 : null;
const pixelRatio = (): number => dprOverride ?? window.devicePixelRatio ?? 1;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Cell extends Rect {
  /** Where this rig's root (its world origin) sits, in stage px. */
  originX: number;
  originY: number;
}

interface Layout {
  columns: number;
  rows: number;
  /** Stage scale per rig — the scene's one-per-pane scale over the columns. */
  scale: number;
  cells: Cell[];
  /** The rect a rig is clipped to: the pane, or its cell. */
  clipOf(index: number): Rect;
  clipTarget: 'pane' | 'cell';
}

/**
 * Where the N rigs go — **one derivation, read by all sides**. A rig's stage
 * box (the document's own framing) is centred across its cell with its bottom
 * at `FLOOR`, so the origin follows from the box, whatever the rig.
 */
function layoutFor(width: number, height: number, stage: ModelAssets['stage']): Layout {
  const n = scene.count;
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  const scale = scene.scale / columns;
  const box = stage ?? { x: 0, y: 0, width: 0, height: 0 };
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const left = (i % columns) * cellW;
    const top = Math.floor(i / columns) * cellH;
    cells.push({
      left,
      top,
      width: cellW,
      height: cellH,
      // World Y is up and CSS Y is down: the box's bottom edge (world y) sits
      // on the floor, and its horizontal middle on the cell's.
      originX: left + cellW / 2 - (box.x + box.width / 2) * scale,
      originY: top + cellH * FLOOR + box.y * scale,
    });
  }
  const pane: Rect = { left: 0, top: 0, width, height };
  return {
    columns,
    rows,
    scale,
    cells,
    clipOf: (index) => (scene.clip === 'pane' ? pane : cells[index]),
    clipTarget: scene.clip,
  };
}

interface Side {
  /** Runs one frame; returns the ms spent posing (the rest is draw). */
  frame(delta: number): number;
  /** The stats string for this side, given the fps the loop measured. */
  stats(fps: number | null, updateMs: number | null, renderMs: number | null, frames: number): string;
  counters(): SideCounters;
  /** Recomputed on resize. */
  layout(): void;
  /** Largest gap, in CSS px, between the grid's origin for a rig and this side's. */
  originDelta(): number;
  dispose(): void;
}

export interface SideCounters {
  players: number;
  drawnPlayers: number | null;
  meshesDrawn: number | null;
  reused: number;
  drawCalls: number | null;
  triangles: number;
  blits: number | null;
  reallocs: number;
  backingPixels: number;
  contexts: number;
  liveContexts: number | null;
}

function playerSide(stageEl: HTMLDivElement, assets: ModelAssets, mode: RenderMode): Side {
  const players: RigPlayer[] = [];
  const roots: HTMLDivElement[] = [];
  /**
   * The clip boxes — one over the pane for a grid scene, one per cell for
   * `many`. The box *is* the embedding: a page puts a player in a box.
   */
  const clipBoxes: HTMLDivElement[] = [];
  const boxOfPlayer: number[] = [];
  for (let i = 0; i < scene.count; i++) {
    const boxIndex = scene.clip === 'pane' ? 0 : i;
    if (!clipBoxes[boxIndex]) {
      const box = document.createElement('div');
      box.className = 'cell-clip';
      stageEl.append(box);
      clipBoxes[boxIndex] = box;
    }
    const root = document.createElement('div');
    root.className = 'skeleton-root';
    clipBoxes[boxIndex].append(root);
    const player = new RigPlayer(root, assets, { mode, meshBackend: backend, skin });
    player.play(scene.animation, { loop: true });
    // Desync so N players are not one stamped sprite — except a held pose,
    // which wants every instance on the same frozen frame.
    player.seek(initialTime(i));
    player.timeScale = scene.timeScale;
    players.push(player);
    roots.push(root);
    boxOfPlayer.push(boxIndex);
  }

  let originDelta = 0;
  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    const grid = layoutFor(box.width, box.height, assets.stage);
    for (let i = 0; i < roots.length; i++) {
      const cell = grid.cells[i];
      const clipRect = grid.clipOf(i);
      const clipBox = clipBoxes[boxOfPlayer[i]];
      clipBox.style.left = `${clipRect.left}px`;
      clipBox.style.top = `${clipRect.top}px`;
      clipBox.style.width = `${clipRect.width}px`;
      clipBox.style.height = `${clipRect.height}px`;
      roots[i].style.left = `${cell.originX - clipRect.left}px`;
      roots[i].style.top = `${cell.originY - clipRect.top}px`;
      roots[i].style.transform = `scale(${grid.scale})`;
      // Raster at the resolution the stage shows at — a plain devicePixelRatio
      // would oversample by 1/scale², which is its own (documented) trap.
      players[i].renderer.pixelRatio = pixelRatio() * grid.scale;
    }
    // Read back where the roots actually landed. A root is absolutely
    // positioned and zero-sized, so its box sits exactly on its origin — and
    // `transform-origin: 0 0` leaves that point where it is under the scale.
    // One forced layout per resize, never per frame.
    originDelta = 0;
    for (let i = 0; i < roots.length; i++) {
      const rect = roots[i].getBoundingClientRect();
      const cell = grid.cells[i];
      originDelta = Math.max(
        originDelta,
        Math.hypot(rect.left - box.left - cell.originX, rect.top - box.top - cell.originY),
      );
    }
  };
  layout();

  return {
    frame(delta: number): number {
      const t0 = countersOnly ? 0 : performance.now();
      for (const player of players) player.advance(delta);
      const updateMs = countersOnly ? 0 : performance.now() - t0;
      for (const player of players) player.draw();
      return updateMs;
    },
    stats(fps, updateMs, renderMs, frames): string {
      const head = fps === null || updateMs === null || renderMs === null
        ? `${scene.count} requested players · mode ${mode} · ${UNAVAILABLE}`
        : `${scene.count} requested players × ${fps.toFixed(0)} fps · mode ${mode} · ` +
          `pose ${(updateMs / frames).toFixed(2)}ms · render ${(renderMs / frames).toFixed(2)}ms/frame`;
      if (mode === 'canvas') {
        let drawn = 0;
        let reused = 0;
        let drawCalls = 0;
        let blendFlushes = 0;
        let triangles = 0;
        let blits = 0;
        let reallocs = 0;
        for (const player of players) {
          const renderer = player.renderer as CanvasRenderer;
          reused += renderer.framesReused;
          drawn += 1 - renderer.framesReused;
          drawCalls += renderer.drawCalls;
          blendFlushes += renderer.blendFlushes;
          triangles += renderer.trianglesDrawn;
          blits += renderer.blits;
          reallocs += renderer.canvasReallocCount;
        }
        const first = players[0]?.renderer as CanvasRenderer | undefined;
        return (
          `${head} · frames ${drawn} drawn / ${reused} reused · ${drawCalls} draw calls · ` +
          `${blendFlushes} blend flushes · ${triangles} tris · ${blits} blits` +
          (reallocs ? ` / ${reallocs} realloc'd` : '') +
          ` · ${first?.backendActive === 'webgl' ? 'webgl' : 'canvas2d fallback'} · ` +
          `${glContextCount()} GL context(s) · clipped to ${scene.clip}`
        );
      }
      let meshes = 0;
      let reused = 0;
      let triangles = 0;
      let backing = 0;
      let reallocs = 0;
      for (const player of players) {
        const renderer = player.renderer as DomRenderer;
        meshes += renderer.meshCount;
        reused += renderer.meshReuseCount;
        triangles += renderer.triangleCount;
        backing += renderer.meshBackingPixels;
        reallocs += renderer.canvasReallocCount;
      }
      const meshNote =
        meshes + reused
          ? ` · mesh ${meshes} drawn (${triangles} tris) / ${reused} reused` +
            (reallocs ? ` / ${reallocs} realloc'd` : '') +
            ` · backing ${(backing / 1e6).toFixed(1)} Mpx`
          : '';
      const active = (players[0]?.renderer as DomRenderer | undefined)?.meshBackendActive ?? backend;
      return `${head}${meshNote} · ${active} · clipped to ${scene.clip}`;
    },
    layout,
    originDelta: () => originDelta,
    counters: (): SideCounters => {
      let drawn = 0, reused = 0, triangles = 0, calls = 0, blits = 0, reallocs = 0, backing = 0;
      for (const player of players) {
        const r = player.renderer;
        if (r instanceof CanvasRenderer) {
          drawn += 1 - r.framesReused; reused += r.framesReused;
          triangles += r.trianglesDrawn; calls += r.drawCalls; blits += r.blits;
          reallocs += r.canvasReallocCount; backing += r.canvas.width * r.canvas.height;
        } else {
          drawn += r.meshCount; reused += r.meshReuseCount; triangles += r.triangleCount;
          reallocs += r.canvasReallocCount; backing += r.meshBackingPixels;
        }
      }
      // The package exposes context creation and draw/reuse counters, but no
      // public shared-context survival query. Do not infer alive from backend
      // selection or equate requested players with visible survivors.
      return { players: players.length, drawnPlayers: null, meshesDrawn: mode === 'dom' ? drawn : null,
        reused, drawCalls: mode === 'canvas' ? calls : null, triangles, blits: mode === 'canvas' ? blits : null,
        reallocs, backingPixels: backing, contexts: glContextCount(), liveContexts: null };
    },
    dispose: (): void => {
      for (const player of players) player.dispose();
      for (const box of clipBoxes) box.remove();
    },
  };
}

function initialTime(index: number): number {
  const raw = params.get('time');
  if (raw !== null) {
    const time = Number(raw);
    if (!Number.isFinite(time) || time < 0) throw new Error(`time must be finite and at least 0, got ${raw}`);
    return time;
  }
  return scene.timeScale === 0 ? 1.2 : (index * 0.37) % 2;
}

function officialPair(): { jsonUrl: string; atlasUrl: string } {
  const model = new URL(modelUrl, location.href);
  const named = model.pathname.endsWith('.model.json');
  const json = params.get('json');
  const atlas = params.get('atlas');
  if ((!json || !atlas) && !named) throw new Error(`official comparison needs ?json= and ?atlas= beside model ${modelUrl}`);
  const sibling = (suffix: string): string => {
    const url = new URL(model.href);
    url.pathname = url.pathname.replace(/\.model\.json$/, suffix);
    return url.href;
  };
  return { jsonUrl: json ? new URL(json, location.href).href : sibling('.json'),
    atlasUrl: atlas ? new URL(atlas, location.href).href : sibling('.atlas') };
}

async function expectedPairHash(): Promise<string> {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`official comparison model ${modelUrl}: HTTP ${response.status}`);
  const model = await response.json() as { spec?: string; spine?: { sha256?: string } };
  const hash = model.spine?.sha256;
  if (model.spec !== 'rigc-compiled/3' || !hash || !/^[0-9a-f]{64}$/.test(hash))
    throw new Error(`official comparison model ${modelUrl} has no paired Spine SHA-256; rebuild with rigc build`);
  return hash;
}

async function decodeRegions(assets: ModelAssets): Promise<void> {
  await Promise.all([...assets.regionImages.values()].map(async (region) => {
    const image = new Image();
    image.src = region.url;
    await image.decode();
  }));
}

/** Official grids share one renderer; independent-player scenes own one per cell. */
async function officialSide(stageEl: HTMLDivElement, assets: ModelAssets, expectedHash: string): Promise<Side> {
  const oracles: OfficialOracle[] = [];
  const instances: OfficialInstance[] = [];
  const canvases: HTMLCanvasElement[] = [];
  let grid = layoutFor(stageEl.clientWidth, stageEl.clientHeight, assets.stage);
  let originDelta = 0;
  let calls = 0, triangles = 0, drawnPlayers = 0;
  const viewport = (index: number): OracleViewport => {
    const clip = grid.clipOf(index);
    const cell = grid.cells[index];
    return { width: clip.width, height: clip.height, scale: grid.scale, pixelRatio: pixelRatio(),
      originX: scene.clip === 'pane' ? 0 : cell.originX - clip.left,
      originY: scene.clip === 'pane' ? 0 : cell.originY - clip.top };
  };
  try {
    const pair = officialPair();
    for (let i = 0; i < (scene.clip === 'pane' ? 1 : scene.count); i++) {
      const canvas = document.createElement('canvas');
      const clip = grid.clipOf(i);
      canvas.style.left = `${clip.left}px`;
      canvas.style.top = `${clip.top}px`;
      stageEl.append(canvas);
      canvases.push(canvas);
      const oracle = new OfficialOracle(canvas, viewport(i), { preserveDrawingBuffer });
      oracles.push(oracle);
      // Own load/decode was completed before entering this function. These
      // images are independently decoded by the official atlas reader.
      const loaded = await oracle.load(pair);
      if (loaded.jsonSha256 !== expectedHash) throw new Error(
        `official comparison pair mismatch: ${pair.jsonUrl} SHA-256 ${loaded.jsonSha256}, model ${modelUrl} requires ${expectedHash}`);
      const count = scene.clip === 'pane' ? scene.count : 1;
      for (let j = 0; j < count; j++) {
        const index = instances.length;
        const instance = oracle.createInstance(loaded, { animation: scene.animation, loop: true, skin });
        const time = initialTime(index);
        const steps = Math.floor(time / (1 / 60));
        let played = 0;
        for (let k = 0; k < steps; k++) { instance.advance(1 / 60); played += 1 / 60; }
        const rest = time - played;
        if (rest > 0) instance.advance(rest);
        instances.push(instance);
      }
    }
  } catch (error) {
    for (const oracle of oracles) oracle.dispose();
    for (const canvas of canvases) canvas.remove();
    throw error;
  }
  const layout = (): void => {
    const box = stageEl.getBoundingClientRect();
    grid = layoutFor(box.width, box.height, assets.stage);
    originDelta = 0;
    for (let i = 0; i < oracles.length; i++) {
      const clip = grid.clipOf(i);
      canvases[i].style.left = `${clip.left}px`;
      canvases[i].style.top = `${clip.top}px`;
      oracles[i].setViewport(viewport(i));
      const rect = canvases[i].getBoundingClientRect();
      originDelta = Math.max(originDelta, Math.hypot(rect.left - box.left - clip.left, rect.top - box.top - clip.top));
    }
  };
  layout();
  return {
    frame(delta: number): number {
      const t0 = countersOnly ? 0 : performance.now();
      const dt = Math.max(0, delta * scene.timeScale);
      if (dt > 0) for (const instance of instances) instance.advance(dt);
      const updateMs = countersOnly ? 0 : performance.now() - t0;
      calls = triangles = drawnPlayers = 0;
      for (let i = 0; i < oracles.length; i++) {
        const oracle = oracles[i];
        if (oracle.context.gl.isContextLost()) continue;
        const entries = scene.clip === 'pane'
          ? instances.map((instance, j) => ({ instance, offsetX: grid.cells[j].originX / grid.scale, offsetY: -grid.cells[j].originY / grid.scale }))
          : [{ instance: instances[i] }];
        const stats = oracle.draw(entries);
        calls += stats.drawCalls; triangles += stats.triangles;
        if (!oracle.context.gl.isContextLost()) drawnPlayers += entries.length;
      }
      return updateMs;
    },
    stats(fps, updateMs, renderMs, frames): string {
      const clock = fps === null || updateMs === null || renderMs === null ? UNAVAILABLE
        : `${fps.toFixed(0)} fps · pose ${(updateMs / frames).toFixed(2)}ms · render ${(renderMs / frames).toFixed(2)}ms/frame`;
      const live = oracles.filter((o) => !o.context.gl.isContextLost()).length;
      return `${drawnPlayers}/${scene.count} · official spine-webgl · ${clock} · ${calls} draw calls · ${triangles} tris · ${live}/${oracles.length} live GL contexts · clipped to ${scene.clip}`;
    },
    counters: (): SideCounters => ({ players: scene.count, drawnPlayers, meshesDrawn: null, reused: 0,
      drawCalls: calls, triangles, blits: null, reallocs: 0,
      backingPixels: canvases.reduce((n, c) => n + c.width * c.height, 0), contexts: oracles.length,
      liveContexts: oracles.filter((o) => !o.context.gl.isContextLost()).length }),
    layout, originDelta: () => originDelta,
    dispose: (): void => { for (const oracle of oracles) oracle.dispose(); for (const canvas of canvases) canvas.remove(); },
  };
}

/**
 * The stats each side publishes, also on `window.rigPlayBench` so
 * `scripts/bench.mjs` can read them without scraping the DOM.
 */
export interface SideReading {
  fps: number | null;
  poseMs: number | null;
  renderMs: number | null;
  stats: string;
  originDeltaPx: number;
  counters: SideCounters;
}

export interface BenchReading {
  scene: SceneName;
  runtime: RuntimeMode;
  model: string;
  pair: { jsonUrl: string; atlasUrl: string } | null;
  pairedJsonSha256: string | null;
  animation: string;
  skin: string | null;
  count: number;
  backend: MeshBackend;
  devicePixelRatio: number;
  clipTarget: 'pane' | 'cell';
  columns: number;
  rows: number;
  cellScale: number;
  measurement: 'counters' | 'device';
  unavailableReason: string | null;
  preserveDrawingBuffer: boolean;
  pmaAdditiveBatching: false;
  frames: number;
  sides: Record<SideName, SideReading | null>;
  // Existing report fields stay readable by callers of the original page.
  domOriginDeltaPx: number | null;
  canvasOriginDeltaPx: number | null;
  domStats: string;
  canvasStats: string;
  domFps: number | null;
  canvasFps: number | null;
  glContexts: number;
}

declare global {
  interface Window {
    rigPlayBench: {
      reading(): BenchReading;
      run(frames: number): Promise<BenchReading>;
      runCounters(frames: number, step?: number): BenchReading;
      dispose(): void;
    };
  }
}

async function main(): Promise<void> {
  const stages = Object.fromEntries(['dom', 'canvas', 'official'].map((name) =>
    [name, document.getElementById(`${name}-stage`) as HTMLDivElement])) as Record<SideName, HTMLDivElement>;
  const statsEls = Object.fromEntries(['dom', 'canvas', 'official'].map((name) =>
    [name, document.getElementById(`${name}-stats`) as HTMLDivElement])) as Record<SideName, HTMLDivElement>;
  const names: SideName[] = ['dom', 'canvas', 'official'];
  const enabled = (name: SideName): boolean => runtime === 'all' || runtime === name || (runtime === 'both' && name !== 'official');
  const pairedHash = enabled('official') ? await expectedPairHash() : null;
  const assets = await loadModel({ modelUrl });
  // Serialize own PNG extraction+decode before official GL texture upload.
  // Concurrent extraction/upload was measured blank on WebKit (#39).
  const sides: Record<SideName, Side | null> = { dom: null, canvas: null, official: null };
  try {
    await decodeRegions(assets);
    if (enabled('dom')) sides.dom = playerSide(stages.dom, assets, 'dom');
    if (enabled('canvas')) sides.canvas = playerSide(stages.canvas, assets, 'canvas');
    if (enabled('official')) sides.official = await officialSide(stages.official, assets, pairedHash as string);
  } catch (error) {
    for (const side of Object.values(sides)) side?.dispose();
    assets.dispose();
    throw error;
  }
  const grid = layoutFor(stages.dom.clientWidth, stages.dom.clientHeight, assets.stage);
  const note = countersOnly ? UNAVAILABLE : runtime === 'both' || runtime === 'all'
    ? 'simultaneous display: one PAGE rAF cadence; these are not independent runtime fps'
    : `only ${runtime} is animating`;
  const sceneEl = document.getElementById('scene');
  if (sceneEl) sceneEl.textContent =
    `scene=${sceneName} model=${modelUrl} anim=${scene.animation} count=${scene.count} ` +
    `(${grid.columns}×${grid.rows}, scale ${grid.scale.toFixed(3)}, clipped to ${grid.clipTarget}) ` +
    `backend=${backend} runtime=${runtime} dpr=${pixelRatio()} · ${note}`;
  for (const name of names) {
    if (!sides[name]) {
      const title = document.getElementById(`${name}-title`);
      if (title) title.append(' — idle');
    }
    statsEls[name].title = 'click to copy';
    statsEls[name].addEventListener('click', () => { void navigator.clipboard?.writeText(statsEls[name].textContent ?? ''); });
  }
  let totalFrames = 0;
  let animationFrame = 0;
  let disposed = false;
  let resizeObserver: ResizeObserver | undefined;
  const elapsed: Record<SideName, { pose: number; render: number; fps: number | null; frames: number }> = {
    dom: { pose: 0, render: 0, fps: null, frames: 0 },
    canvas: { pose: 0, render: 0, fps: null, frames: 0 },
    official: { pose: 0, render: 0, fps: null, frames: 0 },
  };
  const readings: Record<SideName, SideReading | null> = { dom: null, canvas: null, official: null };
  const publish = (): void => {
    for (const name of names) {
      const side = sides[name];
      if (!side) continue;
      const e = elapsed[name];
      const fps = countersOnly ? null : e.fps;
      const poseMs = countersOnly || e.frames === 0 ? null : e.pose / e.frames;
      const renderMs = countersOnly || e.frames === 0 ? null : e.render / e.frames;
      const stats = side.stats(fps, countersOnly ? null : e.pose, countersOnly ? null : e.render, Math.max(1, e.frames));
      readings[name] = { fps, poseMs, renderMs, stats, originDeltaPx: side.originDelta(), counters: side.counters() };
      statsEls[name].textContent = stats;
    }
  };
  const tick = (delta: number): void => {
    for (const name of names) {
      const side = sides[name];
      if (!side) continue;
      const before = countersOnly ? 0 : performance.now();
      const pose = side.frame(delta);
      if (!countersOnly) { elapsed[name].pose += pose; elapsed[name].render += performance.now() - before - pose; elapsed[name].frames++; }
    }
    totalFrames++;
  };
  const reading = (): BenchReading => {
    const current = layoutFor(stages.dom.clientWidth, stages.dom.clientHeight, assets.stage);
    return { scene: sceneName, runtime, model: modelUrl, pair: sides.official ? officialPair() : null,
      pairedJsonSha256: pairedHash, animation: scene.animation, skin: skin ?? null, count: scene.count, backend, devicePixelRatio: pixelRatio(),
      clipTarget: current.clipTarget, columns: current.columns, rows: current.rows, cellScale: current.scale,
      measurement: countersOnly ? 'counters' : 'device', unavailableReason: countersOnly ? UNAVAILABLE : null,
      preserveDrawingBuffer, pmaAdditiveBatching: false, frames: totalFrames,
      sides: { ...readings }, domOriginDeltaPx: readings.dom?.originDeltaPx ?? null,
      canvasOriginDeltaPx: readings.canvas?.originDeltaPx ?? null,
      domStats: readings.dom?.stats ?? 'idle', canvasStats: readings.canvas?.stats ?? 'idle',
      domFps: readings.dom?.fps ?? null, canvasFps: readings.canvas?.fps ?? null, glContexts: glContextCount() };
  };
  const waiters: Array<{ until: number; resolve: (reading: BenchReading) => void }> = [];
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver?.disconnect();
    for (const side of Object.values(sides)) side?.dispose();
    assets.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  // Header text/stats can change the available stage after initialization.
  // Observe its actual dimensions, and do nothing when dimensions agree so
  // layout/readback/draw does not create a ResizeObserver feedback loop.
  let dimensions = '';
  const relayout = (): void => {
    if (disposed) return;
    const current = names.map((name) => {
      const rect = stages[name].getBoundingClientRect();
      return `${rect.width},${rect.height}`;
    }).join(';') + `;${pixelRatio()}`;
    if (current === dimensions) return;
    dimensions = current;
    for (const side of Object.values(sides)) side?.layout();
    for (const side of Object.values(sides)) side?.frame(0);
    publish();
  };
  // Fixed header geometry plus observation keeps all three panes matched.
  publish();
  relayout();
  resizeObserver = new ResizeObserver(relayout);
  for (const stage of Object.values(stages)) resizeObserver.observe(stage);
  window.addEventListener('resize', relayout);
  const runCounters = (count: number, step = 1 / 60): BenchReading => {
    if (!countersOnly) throw new Error('runCounters requires measurement=counters');
    if (disposed) throw new Error('benchmark page was disposed');
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(step) || step < 0) throw new Error('counter frames must be a positive integer and step finite at or above 0');
    for (let i = 0; i < count; i++) tick(step);
    publish();
    return reading();
  };
  window.rigPlayBench = {
    reading, runCounters, dispose,
    run: (count) => countersOnly ? Promise.resolve(runCounters(count)) : new Promise((resolve) => {
      if (!Number.isInteger(count) || count < 1) throw new Error('frames must be a positive integer');
      waiters.push({ until: totalFrames + count, resolve });
    }),
  };
  if (!countersOnly) {
    let last = performance.now();
    let statsAt = last;
    let windowFrames = 0;
    const frame = (now: number): void => {
      if (disposed) return;
      const delta = Math.min((now - last) / 1000, 1 / 15);
      last = now;
      tick(delta);
      windowFrames++;
      if (now - statsAt >= 500) {
        for (const name of names) if (sides[name]) elapsed[name].fps = windowFrames * 1000 / (now - statsAt);
        publish();
        for (const name of names) { elapsed[name].pose = elapsed[name].render = elapsed[name].frames = 0; }
        statsAt = now;
        windowFrames = 0;
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (totalFrames >= waiters[i].until) { waiters[i].resolve(reading()); waiters.splice(i, 1); }
      }
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
  }
}

main().catch((error: unknown) => {
  const sceneEl = document.getElementById('scene');
  if (sceneEl) {
    sceneEl.textContent = `failed: ${String(error)} — did you run bun run fetch-assets?`;
  }
  console.error(error);
});
