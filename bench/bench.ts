import { CanvasRenderer } from '../src/CanvasRenderer';
import { DomRenderer, type MeshBackend } from '../src/DomRenderer';
import { loadModel, type ModelAssets } from '../src/loadModel';
import { glContextCount } from '../src/MeshGlBlitter';
import { type RenderMode, RigPlayer } from '../src/player';

/**
 * The side-by-side benchmark page — an instrument for a person, not a test.
 *
 * ## What it is for
 *
 * The suite's picture gate (`tests/parity.spec.ts`, *dom / canvas*) answers
 * "do the two render modes draw the same picture". This answers the other
 * half: what each one costs, on the same rigs, in the same grid. It is a
 * *page* rather than a spec because the answer cannot be taken in CI —
 * headless numbers are not evidence here (headless WebKit is a software
 * rasterizer, measured up to 28× off real Safari) and nothing in this
 * repository asserts a millisecond. The perf oracle is a stats line read on a
 * real device, and this page is a stats line for each mode, side by side, on
 * one.
 *
 * `scripts/bench.mjs` drives it in a *headed* browser and writes the numbers
 * out with the conditions attached; Safari stays manual, which is what the
 * clickable stats line is for.
 *
 * ## Why the fps reading is per mode and not per pane
 *
 * `requestAnimationFrame` has one cadence per document, so two panes animating
 * in one page report *the same* fps — the page's, not either mode's. A
 * side-by-side of that number would be a comparison of nothing. So
 * `?runtime=dom` (the DOM tier: `<img>` and per-part canvases) and
 * `?runtime=canvas` (the canvas render mode: one canvas per rig through the
 * shared WebGL context) each give the whole frame budget to one side, which is
 * what the script drives, and `?runtime=both` (the default) animates both for
 * eyeballing and says so on every stats line, so a reading copied out of that
 * mode cannot be mistaken for a measurement.
 *
 * ## Fairness: the two sides draw the same picture
 *
 * Both panes place rigs with one derivation, `layoutFor()`, and both clip each
 * rig to the same rect — the whole pane for a grid of rigs, the rig's own cell
 * for `many` — with `overflow: hidden` on a box, which is how a page embeds a
 * player. (Deliberately not `contain: layout paint`: paint containment clips
 * to the same edge `overflow: hidden` does and adds a stacking context and a
 * containing block, structural changes that would be tuning a side rather
 * than embedding it.) The placement is *checked* rather than assumed: each
 * side reports `originDelta`, the largest gap in CSS px between where the grid
 * puts a rig's origin and where that side's root actually sits. It is a
 * counter, not a picture, so it survives being read on any machine.
 *
 * ## Scenes
 *
 * Every scene is a rigc gallery build (`public/rigs/<name>/`, built by
 * `scripts/fetch-assets.sh`), loaded once with `loadModel` and played by one
 * `RigPlayer` per rig:
 *
 * - `mesh` — `portrait-packed` turning its head: two grid meshes keyed as a
 *   projection, the deform tier working every frame.
 * - `held` — the same rig with the pose frozen: the DOM tier's dirty-skip home
 *   ground (an unchanged mesh reuses its raster) and the canvas mode's
 *   frame reuse.
 * - `rigid` — `walk-packed`: region attachments only, pure `<img>` and CSS
 *   matrices on the DOM side.
 * - `many` — `?count=N` independent small players. Browsers cap WebGL contexts
 *   at ~16; both modes share the package's single module-level context
 *   however many players there are, and the canvas side's stats line says how
 *   many contexts the page holds.
 *
 * `mesh`, `held` and `rigid` take a count too, and that is where a crossover
 * can be looked for: on a fast desktop GPU a single rig sits at the display's
 * refresh rate on both sides, which says nothing. `bench/scenes.json` steps
 * them. `?rig=` names another build under `/rigs/`, and `?model=` any model
 * document URL the server holds — which is how `scripts/bench.mjs --corpus
 * <dir>` runs rigc builds of real-world rigs that never enter this repository.
 */

const params = new URLSearchParams(location.search);

type SceneName = 'mesh' | 'held' | 'rigid' | 'many';
type RuntimeMode = 'both' | 'dom' | 'canvas';

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
  /** What each rig is clipped to, on both sides. */
  clip: 'pane' | 'cell';
}

const SCENE_NAMES: SceneName[] = ['mesh', 'held', 'rigid', 'many'];

/**
 * The cap on `count`. 64 rigs is 8 columns of 8 on this page's grid, which at
 * a 1280-wide window leaves each cell about 80 CSS px across — small enough
 * that the next step would be measuring thumbnails. It is a page limit, not a
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
    Math.max(1, Number(params.get('count')) || (name === 'many' ? 8 : 1)),
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
  return raw === 'dom' || raw === 'canvas' ? raw : 'both';
})();
const backend: MeshBackend = params.get('backend') === 'canvas2d' ? 'canvas2d' : 'webgl';
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
 * Where the N rigs go — **one derivation, read by both sides**. A rig's stage
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
  stats(fps: number, updateMs: number, renderMs: number, frames: number): string;
  /** Recomputed on resize. */
  layout(): void;
  /** Largest gap, in CSS px, between the grid's origin for a rig and this side's. */
  originDelta(): number;
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
    const player = new RigPlayer(root, assets, { mode, meshBackend: backend });
    player.play(scene.animation, { loop: true });
    // Desync so N players are not one stamped sprite — except a held pose,
    // which wants every instance on the same frozen frame.
    player.seek(scene.timeScale === 0 ? 1.2 : (i * 0.37) % 2);
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
      const t0 = performance.now();
      for (const player of players) player.advance(delta);
      const updateMs = performance.now() - t0;
      for (const player of players) player.draw();
      return updateMs;
    },
    stats(fps, updateMs, renderMs, frames): string {
      const head =
        `${scene.count}/${scene.count} × ${fps.toFixed(0)} fps · mode ${mode} · ` +
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
  };
}

/**
 * The stats each side publishes, also on `window.rigPlayBench` so
 * `scripts/bench.mjs` can read them without scraping the DOM.
 */
export interface BenchReading {
  scene: SceneName;
  runtime: RuntimeMode;
  /** The model document the scene played. */
  model: string;
  animation: string;
  count: number;
  backend: MeshBackend;
  devicePixelRatio: number;
  /** What a rig is clipped to on both sides. */
  clipTarget: 'pane' | 'cell';
  /** The grid both sides place rigs on, and the per-rig stage scale. */
  columns: number;
  rows: number;
  cellScale: number;
  /**
   * Largest gap in CSS px between where the grid puts a rig's origin and where
   * a side drew it. Both sides near zero is what makes the comparison a
   * comparison; it is a counter rather than a timing, so it reads the same on
   * any machine. Null for a side that is not running.
   */
  domOriginDeltaPx: number | null;
  canvasOriginDeltaPx: number | null;
  /** Frames the loop has completed since the page loaded. */
  frames: number;
  domStats: string;
  canvasStats: string;
  /** rAF-cadence fps over the last window, per side that ran. */
  domFps: number | null;
  canvasFps: number | null;
  /** WebGL contexts the page's package holds — one, however many players. */
  glContexts: number;
}

declare global {
  interface Window {
    rigPlayBench: {
      reading(): BenchReading;
      /** Resolves once `frames` frames have run since the call. */
      run(frames: number): Promise<BenchReading>;
    };
  }
}

async function main(): Promise<void> {
  const domStage = document.getElementById('dom-stage') as HTMLDivElement;
  const canvasStage = document.getElementById('canvas-stage') as HTMLDivElement;
  const domStatsEl = document.getElementById('dom-stats') as HTMLDivElement;
  const canvasStatsEl = document.getElementById('canvas-stats') as HTMLDivElement;
  const domTitle = document.getElementById('dom-title') as HTMLHeadingElement;
  const canvasTitle = document.getElementById('canvas-title') as HTMLHeadingElement;
  const sceneEl = document.getElementById('scene') as HTMLDivElement;

  const runDom = runtime !== 'canvas';
  const runCanvas = runtime !== 'dom';
  // One load backs both sides: the region bitmaps and page images are the
  // caller's, shared by every player of either mode.
  const assets = await loadModel({ modelUrl });
  const dom = runDom ? playerSide(domStage, assets, 'dom') : null;
  const canvas = runCanvas ? playerSide(canvasStage, assets, 'canvas') : null;

  const modeNote =
    runtime === 'both'
      ? 'both animating — one rAF cadence for the page, so these fps are the PAGE’s, not either mode’s'
      : `only ${runtime} is animating — this side has the frame budget to itself`;
  const grid = layoutFor(domStage.clientWidth || 1, domStage.clientHeight || 1, assets.stage);
  sceneEl.textContent =
    `scene=${sceneName} model=${modelUrl} anim=${scene.animation} count=${scene.count} ` +
    `(${grid.columns}×${grid.rows}, scale ${grid.scale.toFixed(3)}, clipped to ${grid.clipTarget}) ` +
    `backend=${backend} runtime=${runtime} dpr=${pixelRatio().toFixed(2)} · ${modeNote}`;
  if (!runDom) domTitle.innerHTML = 'DOM mode <span class="idle">— idle</span>';
  if (!runCanvas) canvasTitle.innerHTML = 'canvas mode <span class="idle">— idle</span>';

  for (const el of [domStatsEl, canvasStatsEl]) {
    el.title = 'click to copy';
    el.addEventListener('click', () => {
      void navigator.clipboard?.writeText(el.textContent ?? '');
    });
  }

  window.addEventListener('resize', () => {
    dom?.layout();
    canvas?.layout();
  });

  let last = performance.now();
  let statsAt = last;
  let frames = 0;
  let totalFrames = 0;
  let domUpdateMs = 0;
  let domRenderMs = 0;
  let canvasUpdateMs = 0;
  let canvasRenderMs = 0;
  let domFps: number | null = null;
  let canvasFps: number | null = null;
  let domStats = runDom ? '—' : 'idle';
  let canvasStats = runCanvas ? '—' : 'idle';
  const waiters: Array<{ until: number; resolve: (reading: BenchReading) => void }> = [];

  const reading = (): BenchReading => {
    const current = layoutFor(domStage.clientWidth || 1, domStage.clientHeight || 1, assets.stage);
    return {
      scene: sceneName,
      runtime,
      model: modelUrl,
      animation: scene.animation,
      count: scene.count,
      backend,
      devicePixelRatio: pixelRatio(),
      clipTarget: current.clipTarget,
      columns: current.columns,
      rows: current.rows,
      cellScale: current.scale,
      domOriginDeltaPx: dom ? Math.round(dom.originDelta() * 1000) / 1000 : null,
      canvasOriginDeltaPx: canvas ? Math.round(canvas.originDelta() * 1000) / 1000 : null,
      frames: totalFrames,
      domStats,
      canvasStats,
      domFps,
      canvasFps,
      glContexts: glContextCount(),
    };
  };

  function frame(now: number): void {
    const delta = Math.min((now - last) / 1000, 1 / 15);
    last = now;

    if (dom) {
      const t0 = performance.now();
      const updateMs = dom.frame(delta);
      domUpdateMs += updateMs;
      domRenderMs += performance.now() - t0 - updateMs;
    }
    if (canvas) {
      const t0 = performance.now();
      const updateMs = canvas.frame(delta);
      canvasUpdateMs += updateMs;
      canvasRenderMs += performance.now() - t0 - updateMs;
    }
    frames++;
    totalFrames++;

    if (now - statsAt >= 500 && frames > 0) {
      const fps = (frames * 1000) / (now - statsAt);
      if (dom) {
        domFps = fps;
        domStats = dom.stats(fps, domUpdateMs, domRenderMs, frames);
        domStatsEl.textContent = domStats;
      }
      if (canvas) {
        canvasFps = fps;
        canvasStats = canvas.stats(fps, canvasUpdateMs, canvasRenderMs, frames);
        canvasStatsEl.textContent = canvasStats;
      }
      domUpdateMs = domRenderMs = canvasUpdateMs = canvasRenderMs = 0;
      frames = 0;
      statsAt = now;
    }

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (totalFrames >= waiters[i].until) {
        waiters[i].resolve(reading());
        waiters.splice(i, 1);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.rigPlayBench = {
    reading,
    run: (count: number) =>
      new Promise<BenchReading>((resolve) => {
        waiters.push({ until: totalFrames + count, resolve });
      }),
  };
}

main().catch((error: unknown) => {
  const sceneEl = document.getElementById('scene');
  if (sceneEl) {
    sceneEl.textContent = `failed: ${String(error)} — did you run bun run fetch-assets?`;
  }
  console.error(error);
});
