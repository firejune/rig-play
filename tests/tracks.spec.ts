import { expect, test } from '@playwright/test';

/**
 * RigPlayer's tracks (#87): a plain `play` stays on rig-c's single live track
 * — every 1.x player's path, held to `openTrack` — and the first composing
 * call (a mix, another track, a queue, a clear) moves the player onto rig-c's
 * live tracks, held to the probe's own `openTracks` driven by the same calls
 * at the same step boundaries, bone by bone and vertex by vertex. rig-c holds
 * that state to the Spine runtime at tolerance 0; this holds the player to
 * rig-c. Events carry the track the player attributes them to; completes are
 * the player's own rule per track.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('a base, a one-shot layered over it and a clear pose as rig-c\'s tracks do; a plain play is unchanged', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.tracksProbe());

  expect(r.singleBoneMismatches).toEqual([]);
  expect(r.checkpoints).toBe(8);
  expect(r.composedBoneMismatches).toEqual([]);
  expect(r.composedFrameMismatches).toBe(0);
  expect(r.layerVisible).toBe(true);

  // Track 1's queued empty mixed out and ended; track 0 cleared over a mix.
  expect(r.entry1AtEnd).toBeNull();
  expect(r.currentAtEnd).toBeNull();

  expect(r.seekRefusal).toContain('single animation on track 0');
  expect(r.skinRefusal).toContain('before composing');
  expect(r.queueFirstEntry).toMatchObject({ animation: 'walk', loop: true });

  // The runtime does not mix a constraint timeline: the single track plays it, the tracks refuse it by name.
  expect(r.constraintPlainPlays).toBe(true);
  expect(r.constraintComposeRefusal).toContain('do not mix');
});

test('events carry their track; a one-shot mixing out fires nothing; completes are per track', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.tracksProbe());

  // walk keys `step` at 0.4 and 1.2 (track 0); nudge keys `hit` at 0.5, started at 0.3 (track 1).
  const steps = r.events.filter((e) => e.name === 'step');
  const hits = r.events.filter((e) => e.name === 'hit');
  expect(steps.length).toBeGreaterThanOrEqual(2);
  for (const e of steps) expect(e.track).toBe(0);
  expect(hits).toHaveLength(1);
  expect(hits[0].track).toBe(1);
  // Fired on the step that reaches nudge's 0.5 s — at 0.8 s of player time, or one dt later when the sum of sixtieths lands a hair short of it.
  expect(hits[0].at).toBeGreaterThanOrEqual(0.8 - 1e-9);
  expect(hits[0].at).toBeLessThanOrEqual(0.8 + 1 / 60 + 1e-9);
  for (const e of r.events) expect(e.track).not.toBeUndefined();

  // walk (1.6 s, looping) completed once at 1.6 on track 0; nudge was replaced by its queued empty at 1.2 (1.3 − 0.1) and so never completed.
  expect(r.completes).toEqual([expect.objectContaining({ animation: 'walk', track: 0 })]);
  expect(r.completes[0].at).toBeGreaterThanOrEqual(1.6 - 1e-9);
  expect(r.completes[0].at).toBeLessThanOrEqual(1.6 + 1 / 60 + 1e-9);
});

test('tracks: true stands the player on the tracks from the start — no replay, the same pose, seek and skin until layering', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.trackModeProbe());

  // The first composing call costs one pose on the tracks (the step(0) that re-poses);
  // on the default path it is the replay: pose 0 of the new tracks, one pose per step
  // played, and that same step(0).
  expect(r.posesOnComposeTracks).toBe(1);
  expect(r.posesOnComposeDefault).toBe(r.stepsPlayedBefore + 2);

  expect(r.tracksSeekBoneMismatches).toEqual([]);
  expect(r.tracksSeekFrameSame).toBe(true);
  expect(r.seekBeforeLayerOk).toBe(true);
  expect(r.skinBeforeLayerEmblem).toBe('emblem');
  expect(r.seekAfterLayerRefusal).toContain('single animation on track 0');

  expect(r.stepEventTracks.length).toBeGreaterThanOrEqual(2);
  for (const track of r.stepEventTracks) expect(track).toBe(0);
  expect(r.completeTracks).toEqual([0]);
});
