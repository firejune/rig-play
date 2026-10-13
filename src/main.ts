import { CanvasRenderer } from './CanvasRenderer.js';
import { DomRenderer, type MeshBackend } from './DomRenderer.js';
import { loadModel, type ModelAssets } from './loadModel.js';
import { type RenderMode, RigPlayer } from './player.js';

/**
 * The demo, and the perf oracle (README): rigc's gallery rigs, built by
 * `rigc build` into `public/rigs/<name>/` (scripts/fetch-assets.sh), loaded
 * with `loadModel` and played by `RigPlayer`.
 */

const GALLERY = ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride'] as const;
/** Each gallery rig as the gallery ships it (one page per part) and built with `--pack`. */
const RIGS = GALLERY.flatMap((rig) => [rig, `${rig}-packed`]);
/**
 * The repository's test rigs (`tests/rigs/`, built beside the gallery): what
 * no gallery rig carries — a clipping attachment, additive slots, a region
 * turned on its page. Reachable by `?rig=` for the parity and invariant
 * scenes, and left out of the picker, which shows the gallery.
 */
const TEST_RIGS = ['figure', 'figure-packed', 'glow', 'glow-packed', 'turned', 'named'];
type RigName = string;
const STAGE_SCALE = 0.4;

// Debug knobs: ?rig=flex &anim=wave &count=10 pick the scene;
// ?expand=0 shows the mesh cracks; ?tint=ff8080 tints the whole rig;
// ?dpr=2 overrides the mesh-canvas backing ratio; ?timescale=0 freezes the
// animation (isolates the dirty-skip path: every mesh should report reused);
// ?backend=canvas2d rasterizes meshes on each part's own 2d canvas (webgl,
// the shared blitter, is the default);
// ?clipping=0 turns clips back off (counted, not applied);
// ?subrect=triangle|page picks what a canvas2d mesh triangle is drawn from;
// ?mode=canvas draws each rig into one canvas (CanvasRenderer) instead of DOM;
// ?time=1.2 seeks every instance to the same pose (deterministic screenshots).
const params = new URLSearchParams(location.search);

function parseTint(): [number, number, number, number] | null {
  const hex = params.get('tint');
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    1,
  ];
}

function rigUrl(name: RigName): string {
  return `/rigs/${name}/skeleton.model.json`;
}

function main(firstRig: RigName, firstAssets: ModelAssets): void {
  const stage = document.getElementById('stage') as HTMLDivElement;
  const rigSelect = document.getElementById('rig') as HTMLSelectElement;
  const animSelect = document.getElementById('anim') as HTMLSelectElement;
  const countInput = document.getElementById('count') as HTMLInputElement;
  const backendSelect = document.getElementById('backend') as HTMLSelectElement;
  const modeSelect = document.getElementById('mode') as HTMLSelectElement;
  const stats = document.getElementById('stats') as HTMLDivElement;
  backendSelect.value = params.get('backend') === 'canvas2d' ? 'canvas2d' : 'webgl';
  modeSelect.value = params.get('mode') === 'canvas' ? 'canvas' : 'dom';

  for (const name of RIGS) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    rigSelect.appendChild(option);
  }
  if (!RIGS.includes(firstRig)) {
    // A test rig named by ?rig= is shown as the current choice, not offered.
    const option = document.createElement('option');
    option.value = firstRig;
    option.textContent = firstRig;
    rigSelect.appendChild(option);
  }
  rigSelect.value = firstRig;

  let assets = firstAssets;
  let players: Array<{ player: RigPlayer; container: HTMLDivElement }> = [];
  const tint = parseTint();

  function fillAnimations(): void {
    animSelect.innerHTML = '';
    for (const anim of assets.animations) {
      const option = document.createElement('option');
      option.value = anim.name;
      option.textContent = anim.name;
      animSelect.appendChild(option);
    }
    animSelect.value = assets.animations[0]?.name ?? '';
  }

  function rebuild(count: number): void {
    for (const { player, container } of players) {
      player.dispose();
      container.remove();
    }
    players = [];
    // The rig's own framing, so the stage centres it whatever its size.
    const box = assets.stage ?? { x: 0, y: 0, width: 0, height: 0 };
    for (let i = 0; i < count; i++) {
      const container = document.createElement('div');
      container.className = 'skeleton-root';
      // Spread instances horizontally; each root is the rig's world origin,
      // shifted so the middle of its stage box sits on the spread point.
      const x = count === 1 ? 50 : 10 + (80 * i) / (count - 1);
      container.style.left = `${x}%`;
      container.style.transform =
        `scale(${STAGE_SCALE}) translate(${-(box.x + box.width / 2)}px, ${box.y}px)`;
      stage.appendChild(container);

      const player = new RigPlayer(container, assets, {
        meshBackend: backendSelect.value as MeshBackend,
        mode: modeSelect.value as RenderMode,
      });
      if (tint) player.color = tint;
      player.play(animSelect.value, { loop: true });
      // Desync cycles so N instances don't look like one stamped sprite —
      // unless ?time seeks them all to one pose (for deterministic captures).
      const timeParam = params.get('time');
      player.seek(timeParam !== null ? Number(timeParam) || 0 : (i * 0.37) % 2);
      const timescaleParam = params.get('timescale');
      if (timescaleParam !== null) player.timeScale = Number(timescaleParam) || 0;

      const renderer = player.renderer;
      const expandParam = params.get('expand');
      if (expandParam !== null && renderer instanceof DomRenderer) renderer.triangleExpand = Number(expandParam) || 0;
      const subrectParam = params.get('subrect');
      if ((subrectParam === 'triangle' || subrectParam === 'page') && (renderer instanceof DomRenderer || renderer instanceof CanvasRenderer)) {
        renderer.meshSourceRect = subrectParam;
      }
      const clippingParam = params.get('clipping');
      if (clippingParam !== null) renderer.clipping = clippingParam !== '0';
      // Mesh canvases raster at the effective on-screen resolution: device
      // pixels × the stage downscale (a plain devicePixelRatio would
      // oversample by 1/STAGE_SCALE).
      const dprParam = params.get('dpr');
      renderer.pixelRatio =
        dprParam !== null ? Number(dprParam) || 1 : (window.devicePixelRatio || 1) * STAGE_SCALE;
      players.push({ player, container });
    }
  }

  rigSelect.addEventListener('change', async () => {
    const name = rigSelect.value as RigName;
    const count = players.length || 1;
    const next = await loadModel({ modelUrl: rigUrl(name) });
    for (const { player, container } of players) {
      player.dispose();
      container.remove();
    }
    players = [];
    assets.dispose();
    assets = next;
    fillAnimations();
    rebuild(count);
  });
  animSelect.addEventListener('change', () => {
    for (const { player } of players) player.play(animSelect.value, { loop: true });
  });
  countInput.addEventListener('change', () => {
    const count = Math.min(50, Math.max(1, Number(countInput.value) || 1));
    countInput.value = String(count);
    rebuild(count);
  });
  backendSelect.addEventListener('change', () => {
    // Live switch: the backend signature re-dirties every mesh on its own.
    for (const { player } of players) {
      if (player.renderer instanceof DomRenderer) player.renderer.meshBackend = backendSelect.value as MeshBackend;
    }
  });
  modeSelect.addEventListener('change', () => {
    // Swapped in place: the player disposes one renderer and creates the other.
    for (const { player } of players) {
      player.mode = modeSelect.value as RenderMode;
      const renderer = player.renderer;
      if (renderer instanceof DomRenderer) renderer.meshBackend = backendSelect.value as MeshBackend;
    }
  });

  fillAnimations();
  const animParam = params.get('anim');
  if (animParam && assets.animations.some((a) => a.name === animParam)) {
    animSelect.value = animParam;
  }
  const initialCount = Math.min(50, Math.max(1, Number(params.get('count')) || 1));
  countInput.value = String(initialCount);
  rebuild(initialCount);

  // Click the stats line to copy it (hand-selecting it mid-animation is fiddly).
  stats.title = 'click to copy';
  stats.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stats.textContent ?? '');
      stats.style.color = '#ffd166';
      setTimeout(() => (stats.style.color = ''), 300);
    } catch {
      // Clipboard unavailable (non-secure context) — selecting stays possible.
    }
  });

  // --- frame loop with split timings (posing vs DOM writes) ---
  let last = performance.now();
  let poseMs = 0;
  let renderMs = 0;
  let frames = 0;
  let statsAt = last;

  function frame(now: number): void {
    const delta = Math.min((now - last) / 1000, 1 / 15);
    last = now;

    const t0 = performance.now();
    for (const { player } of players) player.advance(delta);
    const t1 = performance.now();
    for (const { player } of players) player.draw();
    const t2 = performance.now();

    poseMs += t1 - t0;
    renderMs += t2 - t1;
    frames++;

    if (now - statsAt >= 500 && frames > 0 && players[0]?.player.renderer instanceof CanvasRenderer) {
      const fps = (frames * 1000) / (now - statsAt);
      stats.textContent =
        `${players.length} rig(s) · ${fps.toFixed(0)} fps · ` +
        `pose ${(poseMs / frames).toFixed(2)}ms · ` +
        `render ${(renderMs / frames).toFixed(2)}ms / frame${canvasNote(players.map((p) => p.player.renderer))}`;
      poseMs = renderMs = 0;
      frames = 0;
      statsAt = now;
    } else if (now - statsAt >= 500 && frames > 0) {
      let meshes = 0;
      let reused = 0;
      let reallocs = 0;
      let triangles = 0;
      let clipsApplied = 0;
      let clipsSkipped = 0;
      let clipWrites = 0;
      let backing = 0;
      for (const { player } of players) {
        const r = player.renderer;
        if (!(r instanceof DomRenderer)) continue;
        meshes += r.meshCount;
        reused += r.meshReuseCount;
        reallocs += r.canvasReallocCount;
        triangles += r.triangleCount;
        clipsApplied += r.clipCount;
        clipsSkipped += r.clipSkipCount;
        clipWrites += r.clipWriteCount;
        backing += r.meshBackingPixels;
      }
      const reallocNote = reallocs ? ` / ${reallocs} realloc'd` : '';
      // Allocated mesh-canvas pixels: what an oversampling stage (a scaled
      // root whose scale is not folded into pixelRatio) shows first.
      const backingNote = backing ? ` · backing ${(backing / 1e6).toFixed(1)} Mpx` : '';
      const meshNote =
        meshes + reused
          ? ` · mesh canvases ${meshes} drawn (${triangles} tris) / ${reused} reused${reallocNote}${backingNote}`
          : '';
      const first = players[0]?.player.renderer as DomRenderer | undefined;
      // Surface the backend that actually ran, so a perf reading proves its path.
      const backendNote =
        first && first.meshBackend === 'webgl'
          ? first.meshBackendActive === 'webgl'
            ? ' · webgl'
            : ' · webgl unavailable → canvas2d'
          : first
            ? ` · canvas2d from ${first.meshSourceRect === 'page' ? 'page' : 'sub-rect'}`
            : '';
      const clipNote =
        (clipsApplied ? ` · ${clipsApplied} clips applied` : '') +
        (clipsSkipped ? ` · ${clipsSkipped} clips skipped` : '') +
        (clipWrites ? ` (${clipWrites} clip-path writes)` : '');
      // Real fps from rAF cadence: catches bottlenecks that live outside the
      // frame callback (compositing, page throttling) which the ms split
      // cannot see.
      const fps = (frames * 1000) / (now - statsAt);
      stats.textContent =
        `${players.length} rig(s) · ${fps.toFixed(0)} fps · ` +
        `pose ${(poseMs / frames).toFixed(2)}ms · ` +
        `render ${(renderMs / frames).toFixed(2)}ms / frame · dom${meshNote}${backendNote}${clipNote}`;
      poseMs = renderMs = 0;
      frames = 0;
      statsAt = now;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * The canvas mode's part of the stats line: the mode, its counters summed over
 * the players, and the backend that actually drew, so a reading names its path.
 */
function canvasNote(renderers: ReadonlyArray<unknown>): string {
  let drawn = 0;
  let reused = 0;
  let drawCalls = 0;
  let blendFlushes = 0;
  let triangles = 0;
  let blits = 0;
  let reallocs = 0;
  let clips = 0;
  let skipped = 0;
  let backend = '';
  for (const r of renderers) {
    if (!(r instanceof CanvasRenderer)) continue;
    reused += r.framesReused;
    drawn += 1 - r.framesReused;
    drawCalls += r.drawCalls;
    blendFlushes += r.blendFlushes;
    triangles += r.trianglesDrawn;
    blits += r.blits;
    reallocs += r.canvasReallocCount;
    clips += r.clipCount;
    skipped += r.clipSkipCount;
    backend ||= r.backendActive === 'webgl' ? 'webgl' : 'canvas2d fallback';
  }
  return (
    ` · canvas · frames ${drawn} drawn / ${reused} reused · ${drawCalls} draw calls · ` +
    `${blendFlushes} blend flushes · ${triangles} tris · ${blits} blits` +
    (reallocs ? ` / ${reallocs} realloc'd` : '') +
    ` · ${backend}` +
    (clips ? ` · ${clips} clips applied` : '') +
    (skipped ? ` · ${skipped} clips skipped` : '')
  );
}

const rigParam = params.get('rig');
const firstRig: RigName = [...RIGS, ...TEST_RIGS].includes(rigParam ?? '') ? (rigParam as RigName) : 'walk';
loadModel({ modelUrl: rigUrl(firstRig) })
  .then((assets) => main(firstRig, assets))
  .catch((err) => {
    const stats = document.getElementById('stats');
    if (stats) stats.textContent = `Load failed: ${err.message} — did you run bun run fetch-assets?`;
    console.error(err);
  });
