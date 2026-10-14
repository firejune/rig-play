import { expect, test } from '@playwright/test';

/** #113 items 6–9. Expected values are written before the first run. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('item 6: pixelRatio and clipping survive both directions of a live mode switch', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.canvasContractProbe());
  expect(r.swaps).toEqual([
    { mode: 'dom', ratio: 0.25, clipping: false, applied: 0, skipped: 1 },
    { mode: 'canvas', ratio: 0.25, clipping: false, applied: 0, skipped: 1 },
    { mode: 'dom', ratio: 0.25, clipping: false, applied: 0, skipped: 1 },
    { mode: 'canvas', ratio: 0.5, clipping: true, applied: 1, skipped: 0 },
    { mode: 'dom', ratio: 0.5, clipping: true, applied: 1, skipped: 0 },
  ]);
});

test('item 7: viewport pins the rounded world box and reserve grows ahead without shrinking', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.canvasContractProbe());
  // Fractional bounds round outward independently: [-11,32] × [-52,-20].
  expect(r.viewport).toEqual([
    { width: 86, height: 64, cssWidth: '43px', cssHeight: '32px', transform: 'translate(-11px, -52px)', realloc: 1 },
    { width: 86, height: 64, cssWidth: '43px', cssHeight: '32px', transform: 'translate(-11px, -52px)', realloc: 0 },
    { width: 800, height: 400, cssWidth: '400px', cssHeight: '200px', transform: 'translate(-200px, -200px)', realloc: 1 },
  ]);
  // Initial automatic slack is 16 on each side; an outgrown right edge gets
  // one quarter of the old 432-unit width, 108. The other edges stay put.
  expect(r.reserved).toEqual([
    { width: 432, height: 232, cssWidth: '432px', cssHeight: '232px', transform: 'translate(-216px, -216px)', realloc: 1 },
    { width: 432, height: 232, cssWidth: '432px', cssHeight: '232px', transform: 'translate(-216px, -216px)', realloc: 0 },
    { width: 574, height: 232, cssWidth: '574px', cssHeight: '232px', transform: 'translate(-216px, -216px)', realloc: 1 },
  ]);
});

test('item 8: canvas clipping counts one shared clip on drawn and reused frames, and off draws unclipped', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.canvasContractProbe());
  expect(r.clips.map(({ applied, skipped, reused }) => ({ applied, skipped, reused }))).toEqual([
    { applied: 1, skipped: 0, reused: 0 },
    { applied: 1, skipped: 0, reused: 1 },
    { applied: 0, skipped: 1, reused: 0 },
    { applied: 0, skipped: 1, reused: 1 },
    { applied: 1, skipped: 0, reused: 0 },
  ]);
  expect(r.clips.map((s) => s.changedPixels === 0)).toEqual([true, true, false, false, true]);
  expect(r.clips[2].changedPixels).toBe(r.clips[3].changedPixels);
});

test('item 9: forced canvas2d draws a region and a mesh and ignores their RGB tint', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.canvasContractProbe());
  expect(r.fallback.backend).toBe('canvas2d');
  expect(r.fallback.draws).toBe(2);
  expect(r.fallback.triangles).toBe(4);
  expect(r.fallback.frameTints).toEqual([[0.25, 0.5, 0.75, 1], [0.25, 0.5, 0.75, 1]]);
  expect(r.fallback.samples).toEqual([[129, 129, 129, 255], [129, 129, 129, 255]]);
  expect(r.fallback.changedPixels).toBe(0);
});
