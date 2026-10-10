import { expect, test } from '@playwright/test';

/**
 * RigPlayer.adjust (#79): rig-c's bone-local hook (`openTrack({ adjust })`,
 * rig-c 2.36.0) passed through the player. The oracle is the probe's own
 * track opened with the same function, at tolerance 0 — rig-c holds that hook
 * to the Spine runtime; this holds the player to rig-c. The player's own
 * rules (the first pose adjusted, kept across seek and mode, a held pose
 * re-posed by the setter and by `repose()`, refusals in the core's words)
 * are asserted beside it.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('adjust reaches every pose the way rig-c poses it, and a held pose re-poses on demand', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.adjustProbe());

  // The adjusted walk is rig-c's adjusted walk, bit for bit — and not the plain one.
  expect(probe.adjustedBoneMismatches).toEqual([]);
  expect(probe.adjustedFrameSame).toBe(true);
  expect(probe.adjustedDiffersFromPlain).toBe(true);
  expect(probe.firstPoseAdjusted).toBe(true);
  expect(probe.keptAcrossSeek).toBe(true);
  expect(probe.keptAcrossMode).toBe(true);

  // A hook that writes nothing changes nothing.
  expect(probe.noopBoneMismatches).toEqual([]);
  expect(probe.noopFrameSame).toBe(true);

  // Paused: the setter re-poses at once; a closure's state shows after repose(), not before.
  expect(probe.pausedSetSeen).toBe(true);
  expect(probe.closureBeforeRepose).not.toBe(probe.closureAfterRepose);
  expect(probe.closureAfterRepose / probe.closureBeforeRepose).toBeCloseTo(1.7 / 1.1, 6);
  expect(probe.trackTimeAfterRepose).toBeCloseTo(0.7, 12);

  // Refusals arrive in rig-c's words.
  expect(probe.nanError).toContain('not a finite number');
  expect(probe.unknownBoneError).toContain('not one of this document\'s bones');
  expect(probe.thrownError).toContain("the caller's own failure");
});
