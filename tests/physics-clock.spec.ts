import { expect, test } from '@playwright/test';

/**
 * The player's physics clock (#103, rig-c #1396). Every track the player opens
 * is given `physicsClockStep`, rig-c's render clock: each step moves the
 * physics 2⁻³⁰ of itself further than the animation, so a frame that ends on a
 * physics step's tie resolves the way exact arithmetic does instead of
 * flipping a spring between on time and a step late. The fixture is the `look`
 * gallery rig's `tilt`, whose whip is a physics bone.
 *
 * What it asserts, written before the first run:
 * - at a fixed 1/20 s, a fixed 1/60 s and a jittered 60 Hz rAF clock, the
 *   player's whip reads the core track given `physicsClockStep`, to 1e-12;
 * - at a fixed 1/60 s the frame clock has outlier frames 8, 15, 16 and 17 (the
 *   tie frames measured on 2.49.0), the player has none of them, and the two
 *   series differ.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('the player steps physics on the render clock: no spring jump at a fixed rate', async ({ page }) => {
  const { runs } = await page.evaluate(() => window.rigPlayHarness.physicsClockProbe());
  expect(runs.map((r) => r.name)).toEqual(['fixed 1/20', 'fixed 1/60', 'rAF 60 Hz, jittered']);
  for (const r of runs) {
    expect(r.frames).toBeGreaterThan(100);
    expect(r.playerVsClock).toBeLessThanOrEqual(1e-12);
  }
  const fixed60 = runs[1];
  for (const frame of [8, 15, 16, 17]) {
    expect(fixed60.frameClockOutliers).toContain(frame);
    expect(fixed60.playerOutliers).not.toContain(frame);
  }
  expect(fixed60.playerVsFrameClock).toBeGreaterThan(1e-4);
});
