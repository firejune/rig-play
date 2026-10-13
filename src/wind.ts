// The wind page (#124): a rig named by ?model= (the cloth test rig by default),
// a wind slider and a gravity slider forwarded to player.environment(), and a
// drag on the stage forwarded to player.moved(). Layout is the page's: the
// rig's stage box (or its bounds) is fitted to the stage element.
import { loadModel } from './loadModel.js';
import { RigPlayer } from './player.js';

const params = new URLSearchParams(location.search);
const modelUrl = params.get('model') ?? 'rigs/cloth/skeleton.model.json';
const stage = document.getElementById('stage') as HTMLDivElement;
const wind = document.getElementById('wind') as HTMLInputElement;
const gravity = document.getElementById('gravity') as HTMLInputElement;
const readout = document.getElementById('readout') as HTMLSpanElement;

async function main(): Promise<void> {
  const assets = await loadModel({ modelUrl });
  const root = stage.appendChild(document.createElement('div'));
  root.id = 'rig-root';
  const player = new RigPlayer(root, assets);
  player.play(params.get('anim') ?? assets.animations[0].name);

  const box = assets.stage ?? player.bounds() ?? { x: -100, y: 0, width: 200, height: 200 };
  const scale = 0.9 * Math.min(stage.clientWidth / box.width, stage.clientHeight / box.height);
  const left0 = (stage.clientWidth - box.width * scale) / 2 - box.x * scale;
  const top0 = (stage.clientHeight - box.height * scale) / 2 + (box.y + box.height) * scale;
  root.style.cssText = `position: absolute; transform-origin: 0 0; transform: scale(${scale}); left: ${left0}px; top: ${top0}px`;
  player.renderer.syncPixelRatio();

  // The runtime starts at wind [1, 0]; the page starts calm, at the sliders.
  const apply = (): void => {
    const e = player.environment({ wind: [Number(wind.value), 0], gravity: [0, Number(gravity.value)] });
    readout.textContent = `wind [${e.wind.join(', ')}] · gravity [${e.gravity.join(', ')}]`;
  };
  apply();
  wind.addEventListener('input', apply);
  gravity.addEventListener('input', apply);

  let held: { x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    held = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointerup', () => { held = null; });
  stage.addEventListener('pointercancel', () => { held = null; });
  stage.addEventListener('pointermove', (e) => {
    if (!held) return;
    const dx = e.clientX - held.x;
    const dy = e.clientY - held.y;
    held = { x: e.clientX, y: e.clientY };
    root.style.left = `${parseFloat(root.style.left) + dx}px`;
    root.style.top = `${parseFloat(root.style.top) + dy}px`;
    player.moved({ x: dx / scale, y: -dy / scale });
  });

  let last = performance.now();
  requestAnimationFrame(function tick(now) {
    player.frame(Math.min((now - last) / 1000, 1 / 15));
    last = now;
    requestAnimationFrame(tick);
  });
}

main().catch((err: Error) => {
  readout.textContent = `Load failed: ${err.message}`;
  console.error(err);
});
