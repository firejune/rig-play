import { expect, test } from '@playwright/test';

/**
 * The element mode draws meshes through the shared WebGL context by default
 * (#109), and canvas2d is its fallback: with WebGL unavailable, and with the
 * context lost mid-play. `meshBackendActive` says which drew, and the meshes
 * still draw either way. The oracle for "still draws" is the mesh canvases'
 * non-transparent pixels, which have no counter.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('a player draws its meshes through webgl by default', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.glFallbackProbe(false));
  expect(r.meshBackend).toBe('webgl');
  expect(r.firstActive).toBe('webgl');
  expect(r.firstPixels).toBeGreaterThan(1000);
  expect(r.afterActive).toBe('webgl');
});

test('WebGL unavailable: the default falls back to canvas2d and still draws', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const r = await page.evaluate(() => window.rigPlayHarness.glFallbackProbe(false));
  await context.close();
  expect(r.meshBackend).toBe('webgl');
  expect(r.firstActive).toBe('canvas2d');
  expect(r.firstPixels).toBeGreaterThan(1000);
  expect(r.afterActive).toBe('canvas2d');
});

test('context lost mid-play: the next frame draws on canvas2d, every mesh re-rastered', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.glFallbackProbe(true));
  test.skip(r.firstActive !== 'webgl', 'no WebGL to lose');
  expect(r.lost).toBe(true);
  expect(r.afterActive).toBe('canvas2d');
  expect(r.afterMeshesDrawn).toBeGreaterThan(0);
  expect(r.afterPixels).toBeGreaterThan(1000);
});
