import { MeshAttachment, RegionAttachment } from '@esotericsoftware/spine-webgl';
import { loadModel, RigPlayer, DomRenderer, CanvasRenderer, type ModelAssets } from '../src/index';
import { OfficialOracle, type OfficialInstance, type OracleViewport } from './officialOracle';

export interface OracleScene {
  rig: string;
  animation: string;
  time: number;
  loop?: boolean;
  skin?: string;
  color?: [number, number, number, number];
  viewport?: OracleViewport;
}
export type OracleMode = 'dom-webgl' | 'dom-canvas2d' | 'canvas';
export interface OracleCapture {
  generation: string;
  pairHashMatches: boolean;
  pagesPma: boolean[];
  mode: OracleMode;
  backend: string;
  width: number;
  height: number;
  slotNames: string[];
  maxGeometryDelta: number;
  referenceConfig: { antialias: false; preserveDrawingBuffer: true; pmaAdditiveBatching: false };
  official: { drawCalls: number; triangles: number; skeletons: number };
}

const VIEWPORT: OracleViewport = { width: 400, height: 440, originX: 180, originY: 420, scale: 0.5, pixelRatio: 1 };
let live: { official: OfficialOracle; player: RigPlayer; assets: ModelAssets } | null = null;

function geometry(instance: OfficialInstance): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const slot of instance.skeleton.drawOrder.appliedPose) {
    if (!slot.bone.active) continue;
    const pose = slot.appliedPose;
    const attachment = pose.attachment;
    if (attachment instanceof RegionAttachment) {
      const vertices = new Array<number>(8);
      attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2);
      out.set(slot.data.name, vertices);
    } else if (attachment instanceof MeshAttachment) {
      const vertices = new Array<number>(attachment.worldVerticesLength);
      attachment.computeWorldVertices(instance.skeleton, slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
      out.set(slot.data.name, vertices);
    }
  }
  return out;
}

function stage(id: string, left: number, viewport: OracleViewport): HTMLDivElement {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = `position:absolute;left:${left}px;top:0;width:${viewport.width}px;height:${viewport.height}px;overflow:hidden;background:transparent;isolation:isolate;`;
  document.body.append(el);
  return el;
}

async function capture(scene: OracleScene, mode: OracleMode): Promise<OracleCapture> {
  if (live) {
    live.player.dispose(); live.assets.dispose(); live.official.dispose(); live = null;
  }
  if (window.devicePixelRatio !== 1) throw new Error(`oracle protocol DPR=1, found ${window.devicePixelRatio}`);
  const viewport = scene.viewport ?? VIEWPORT;
  const reference = stage('oracle-reference', 0, viewport);
  const actual = stage('oracle-actual', viewport.width + 20, viewport);
  const canvas = document.createElement('canvas');
  reference.append(canvas);
  const official = new OfficialOracle(canvas, viewport);
  const prefix = `/rigs/${scene.rig}/`;
  const assets = await loadModel({ modelUrl: `${prefix}skeleton.model.json` });
  const spine = await official.load({ jsonUrl: `${prefix}skeleton.json`, atlasUrl: `${prefix}skeleton.atlas` });
  const rawModel = await (await fetch(`${prefix}skeleton.model.json`)).json() as { spec?: string; spine?: { sha256?: string } };
  if (rawModel.spec !== 'rigc-compiled/3' || rawModel.spine?.sha256 !== spine.jsonSha256)
    throw new Error(`oracle model/Spine pair does not match: ${scene.rig}`);
  // Region URLs are cut assets, not yet decoded <img>s. Freeze only after
  // every real sprite bitmap is decoded, before a mesh's first GL upload.
  const decodedRegions = await Promise.all(Array.from(assets.regionImages.values(), async ({ url }) => {
    const image = new Image(); image.src = url; await image.decode(); return image;
  }));
  if (decodedRegions.length !== assets.regionImages.size) throw new Error('oracle region initialization incomplete');
  const root = document.createElement('div');
  root.style.cssText = `position:absolute;left:${viewport.originX}px;top:${viewport.originY}px;transform-origin:0 0;transform:scale(${viewport.scale});`;
  actual.append(root);
  const player = new RigPlayer(root, assets, { mode: mode === 'canvas' ? 'canvas' : 'dom', meshBackend: mode === 'dom-canvas2d' ? 'canvas2d' : 'webgl', ...(scene.skin ? { skin: scene.skin } : {}) });
  player.renderer.pixelRatio = viewport.scale * (viewport.pixelRatio ?? 1);
  if (scene.color) player.color = scene.color;
  const loop = scene.loop ?? true;
  player.play(scene.animation, { loop });
  const instance = official.createInstance(spine, { animation: scene.animation, loop, skin: scene.skin, color: scene.color });
  // One declared history drives both independent readers, including the
  // player's physicsClockStep on the official side. No seek shortcut.
  const step = 1 / 60;
  let at = 0;
  const n = Math.floor(scene.time / step);
  for (let i = 0; i < n; i++) { player.advance(step); instance.advance(step); at += step; }
  if (scene.time > at) { const dt = scene.time - at; player.advance(dt); instance.advance(dt); }
  player.pause();
  player.draw();
  const stats = official.draw([{ instance }]);
  await Promise.all(Array.from(root.querySelectorAll('img'), (image) => image.decode()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  // Real DOM screenshot, including element canvases, CSS transform/clip/tint;
  // nothing reconstructs the package's output with the reference renderer.
  const own = player.posedFrame();
  const ref = geometry(instance);
  let maxGeometryDelta = 0;
  for (const slot of own.order) {
    const values = slot.kind === 'mesh' ? slot.vertices : slot.corners;
    const expected = ref.get(slot.slot);
    if (!expected || values.length !== expected.length) throw new Error(`oracle geometry slot mismatch: ${slot.slot}`);
    for (let i = 0; i < values.length; i++) maxGeometryDelta = Math.max(maxGeometryDelta, Math.abs(values[i] - expected[i]));
  }
  if (ref.size !== own.order.length) throw new Error('oracle draw-slot set differs between readers');
  live = { official, player, assets };
  return {
    generation: spine.generation, pairHashMatches: true, pagesPma: spine.pages.map((page) => page.pma), mode,
    backend: player.renderer instanceof DomRenderer ? player.renderer.meshBackendActive : (player.renderer as CanvasRenderer).backendActive,
    width: viewport.width, height: viewport.height, slotNames: own.order.map((slot) => slot.slot), maxGeometryDelta, official: stats,
    referenceConfig: { antialias: false, preserveDrawingBuffer: true, pmaAdditiveBatching: false },
  };
}

async function repaint(): Promise<void> {
  live?.player.draw();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
declare global { interface Window { officialOracleHarness: { capture: typeof capture; repaint: typeof repaint } } }
window.officialOracleHarness = { capture, repaint };
