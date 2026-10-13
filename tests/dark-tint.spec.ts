import { expect, test } from '@playwright/test';

/**
 * Two-colour (dark) tint (#106). The canvas mode's GL path draws it, the DOM
 * mode and the canvas mode's canvas2d fallback do not (README, *Coming from
 * spine-html 0.8*), and until this spec nothing held either half.
 *
 * The `duo` test rig keys only the dark half of each slot's tint, over an
 * opaque grey ramp with a white light half. So the oracle is the formula,
 * `c·light + (1 − c)·dark`, with `c` read off the fallback's raster at the same
 * pixel. Two poses that differ only in the dark colour must draw the same in
 * the DOM mode and in the fallback.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

const close = (a: number[] | null, b: number[]): void => {
  expect(a).not.toBeNull();
  for (let k = 0; k < 3; k++) expect((a as number[])[k]).toBeCloseTo(b[k], 6);
};

test('canvas mode: the GL path draws c·light + (1 − c)·dark, keyed over time', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.darkTintProbe());
  test.skip(!r.webglAvailable, 'no WebGL: the canvas mode draws through its canvas2d fallback');

  const [t0, mid, t1] = r.times;
  close(t0.swatchDark, [1, 0, 0]);
  close(t0.sheetDark, [0, 0, 1]);
  close(mid.swatchDark, [0.5, 0.5, 0]);
  close(mid.sheetDark, [0, 0.5, 1]);
  close(t1.swatchDark, [0, 1, 0]);
  close(t1.sheetDark, [0, 1, 1]);

  for (const t of r.times) {
    expect(t.swatchPixels).toBeGreaterThan(500);
    expect(t.sheetPixels).toBeGreaterThan(500);
    expect(t.swatchMaxError).toBeLessThanOrEqual(4);
    expect(t.sheetMaxError).toBeLessThanOrEqual(4);
  }
  // At the ramp's dark end the dark half is at full strength: red alone lifts at t = 0 on the swatch.
  expect(t0.swatchLift[0]).toBeGreaterThan(200);
  expect(Math.abs(t0.swatchLift[1])).toBeLessThanOrEqual(4);
  expect(Math.abs(t0.swatchLift[2])).toBeLessThanOrEqual(4);
  expect(t0.sheetLift[2]).toBeGreaterThan(200);
  expect(Math.abs(t0.sheetLift[0])).toBeLessThanOrEqual(4);

  expect(r.glChangedBetweenTimes).toBeGreaterThan(1000);
});

test('canvas mode fallback: canvas2d draws no dark tint', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.darkTintProbe());
  expect(r.fallbackChangedBetweenTimes).toBe(0);
});

test('DOM mode: two poses that differ only in the dark colour draw the same', async ({ page }) => {
  expect(await page.evaluate(() => window.rigPlayHarness.darkDomPose(0))).toBe(2);
  const first = await page.screenshot({ clip: { x: 0, y: 0, width: 440, height: 440 } });
  expect(await page.evaluate(() => window.rigPlayHarness.darkDomPose(1))).toBe(2);
  const second = await page.screenshot({ clip: { x: 0, y: 0, width: 440, height: 440 } });
  expect(Buffer.compare(first, second)).toBe(0);
});
