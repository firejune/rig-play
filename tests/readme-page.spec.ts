import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The README's *A minimal page* (#118), run as written. The block is read out
 * of README.md, so the page a reader copies is the page under test. Two
 * requests are answered here instead of by the network: the page itself, at a
 * path on the test server (so `rigs/look/…` resolves to the fixture), and the
 * CDN import, with the package built from this tree by the same script the
 * publish runs (`scripts/build-lib.mjs`, into a temp directory — never `dist/`,
 * which the test server is serving).
 *
 * What it asserts, written before the first run:
 * - the page draws the rig, and everything it draws lies inside the container;
 * - the fit: the root's scale is the stage box fitted to the 480 × 640
 *   container, min(480 / width, 640 / height) of the fixture's `stage`, to 1e-9;
 * - the mesh canvases raster at the size on screen: backing pixels per
 *   on-screen pixel equal the device pixel ratio, which they would not
 *   (1 / scale times more) without `syncPixelRatio()`;
 * - the rig plays: an element's transform changes between two readings.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let libDir = '';
let page$html = '';

test.beforeAll(() => {
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### A minimal page'));
  const match = /```html\n([\s\S]*?)\n```/.exec(section);
  if (!match) throw new Error('README: no html block under "A minimal page"');
  page$html = match[1];
  libDir = mkdtempSync(resolve(tmpdir(), 'play-readme-'));
  const built = spawnSync(process.execPath, [resolve(repoRoot, 'scripts', 'build-lib.mjs'), libDir], { cwd: repoRoot, encoding: 'utf8' });
  expect(built.status, `scripts/build-lib.mjs failed:\n${built.stdout}${built.stderr}`).toBe(0);
});

test.afterAll(() => {
  if (libDir) rmSync(libDir, { recursive: true, force: true });
});

test('the README minimal page loads, fits, rasters at screen size and plays', async ({ page }) => {
  const cdn = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@rig-c\/play@1\/dist\/index\.js$/;
  expect(page$html).toMatch(/cdn\.jsdelivr\.net\/npm\/@rig-c\/play@1\/dist\/index\.js/);
  await page.route(cdn, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: readFileSync(resolve(libDir, 'index.js'), 'utf8') }));
  await page.route('**/readme-minimal.html', (route) => route.fulfill({ contentType: 'text/html', body: page$html }));
  await page.goto('/readme-minimal.html');

  const stage = page.locator('#stage');
  await expect(stage.locator('img, canvas').first()).toBeAttached();
  await page.waitForTimeout(500);

  const read = () =>
    page.evaluate(() => {
      const stageEl = document.getElementById('stage') as HTMLElement;
      const box = stageEl.getBoundingClientRect();
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      const ratios: number[] = [];
      for (const el of Array.from(stageEl.querySelectorAll<HTMLElement>('img, canvas'))) {
        if (el.style.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        left = Math.min(left, r.left); top = Math.min(top, r.top);
        right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
        if (el instanceof HTMLCanvasElement) ratios.push(el.width / r.width);
      }
      const transforms = Array.from(stageEl.querySelectorAll<HTMLElement>('img, canvas')).map((el) => el.style.transform).join('|');
      const rootEl = stageEl.firstElementChild as HTMLElement;
      const rootScale = Number(/scale\(([^)]+)\)/.exec(rootEl.style.transform)?.[1]);
      return { rootScale, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }, drawn: { left, top, right, bottom }, ratios, dpr: devicePixelRatio, transforms };
    });

  const first = await read();
  const { box, drawn } = first;
  // Inside the container (a pixel of antialiasing slack on each side).
  expect(drawn.left).toBeGreaterThanOrEqual(box.left - 1);
  expect(drawn.top).toBeGreaterThanOrEqual(box.top - 1);
  expect(drawn.right).toBeLessThanOrEqual(box.right + 1);
  expect(drawn.bottom).toBeLessThanOrEqual(box.bottom + 1);
  // Fitted: the stage box scaled to the container.
  const model = JSON.parse(readFileSync(resolve(repoRoot, 'public', 'rigs', 'look', 'skeleton.model.json'), 'utf8')) as { stage: { width: number; height: number } };
  const expected = Math.min(480 / model.stage.width, 640 / model.stage.height);
  expect(first.rootScale).toBeCloseTo(expected, 9);
  // Rastered at the size on screen.
  expect(first.ratios.length).toBeGreaterThan(0);
  for (const r of first.ratios) expect(Math.abs(r - first.dpr)).toBeLessThanOrEqual(0.05 * first.dpr);

  await page.waitForTimeout(400);
  const second = await read();
  expect(second.transforms).not.toBe(first.transforms);
});
