import { expect, test } from '@playwright/test';

/**
 * RigPlayer's reads of the pose it holds (#73): a bone's world transform by
 * name, and the box of what the pose draws. Both are read off the core's pose
 * — the one the player steps — so the oracle is the probe's own pose of the
 * same walk (tests/rigFrames.ts `poseAt`) at tolerance 0, and the probe's own
 * box over the frame record; and both read the same in either render mode.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('bone() is the core pose, bit for bit, and bounds() is the box of the frame', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.boneBoundsProbe());

  expect(probe.boneCount).toBeGreaterThan(1);
  expect(probe.boneMismatches).toEqual([]);

  // Before play: the setup pose, not a refusal.
  expect(probe.setupBone).not.toBeNull();
  expect(probe.setupBounds).not.toBeNull();

  // A frame no clip covers: exactly the box of its corners and vertices.
  expect(probe.walkHasClip).toBe(false);
  expect(probe.walkBounds).toEqual(probe.walkExpected);

  // Under a clip the box may only shrink, and never past the clip's own.
  expect(probe.maskHasClip).toBe(true);
  const b = probe.maskBounds as NonNullable<typeof probe.maskBounds>;
  const u = probe.maskUnclipped as NonNullable<typeof probe.maskUnclipped>;
  expect(b.x).toBeGreaterThanOrEqual(u.x);
  expect(b.y).toBeGreaterThanOrEqual(u.y);
  expect(b.x + b.width).toBeLessThanOrEqual(u.x + u.width);
  expect(b.y + b.height).toBeLessThanOrEqual(u.y + u.height);

  expect(probe.canvasSame).toBe(true);
  expect(probe.unknownBoneError).toContain('no_such_bone');
});

test('skin can change on a live player: the pose re-resolves, the track keeps its animation and time', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.skinProbe());

  expect(probe.skins).toEqual(['default', 'alt']);
  // Only the alt skin fills the emblem slot (with the visor art).
  expect(probe.emblemNoSkin).toBeNull();
  expect(probe.emblemAlt).toBe('visor');
  expect(probe.drawnAfterSwitch).toBe('visor');
  expect(probe.emblemBack).toBeNull();
  expect(probe.setupEmblemAlt).toBe('visor');

  expect(probe.animationKept).toBe(true);
  expect(probe.timeAfter).toBeCloseTo(probe.timeBefore, 12);
  // Equal to a player built under that skin and seeked to the same time.
  expect(probe.boneMismatches).toEqual([]);
  expect(probe.frameSame).toBe(true);

  expect(probe.unknownError).toContain('no_such_skin');
  expect(probe.skinAfterUnknown).toBe('alt');
  expect(probe.emblemAfterUnknown).toBe('visor');
});
