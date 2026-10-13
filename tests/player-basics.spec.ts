import { expect, test } from '@playwright/test';

/**
 * The player features a consumer meets first, which no test held until the
 * 2026-10-13 audit (items 1–5; items 6–18 are #113). One probe on the `figure`
 * test rig: `walk` lasts 1.6 s and fires `step` at 0.4 s (int 0, float 0.25,
 * string "left") and at 1.2 s (int 2, string "right"); `nudge` lasts 1 s and
 * fires `hit` (int 7) at 0.5 s. The player is stepped at 1/60 s, so a reading
 * taken "at" a time is within one step of it.
 *
 * What each test asserts was written here before its first run.
 */

const STEP = 1 / 60;
const near = (value: number, target: number): void => {
  expect(Math.abs(value - target)).toBeLessThanOrEqual(STEP + 1e-9);
};

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('a plain play fires every event with its payload, in order across the loop, and completes once per cycle', async ({ page }) => {
  // Asserts: the player stays on the single track; over 3.3 s exactly four
  // events, step / step / step / step, with key times 0.4, 1.2, 0.4, 1.2,
  // fired at 0.4, 1.2, 2.0 and 2.8 s, ints 0 2 0 2, float 0.25, strings
  // left right left right, track 0; exactly two completes, `walk` on track 0,
  // at 1.6 and 3.2 s.
  const r = await page.evaluate(() => window.rigPlayHarness.playerBasicsProbe());
  expect(r.plainComposed).toBe(false);
  expect(r.plainEvents.map((e) => e.name)).toEqual(['step', 'step', 'step', 'step']);
  expect(r.plainEvents.map((e) => e.time)).toEqual([0.4, 1.2, 0.4, 1.2].map((t) => expect.closeTo(t, 6)));
  [0.4, 1.2, 2.0, 2.8].forEach((t, i) => near(r.plainEvents[i].at, t));
  expect(r.plainEvents.map((e) => e.int)).toEqual([0, 2, 0, 2]);
  expect(r.plainEvents.map((e) => e.float)).toEqual([0.25, 0.25, 0.25, 0.25].map((f) => expect.closeTo(f, 6)));
  expect(r.plainEvents.map((e) => e.string)).toEqual(['left', 'right', 'left', 'right']);
  expect(r.plainEvents.map((e) => e.track)).toEqual([0, 0, 0, 0]);
  expect(r.plainCompletes.map((c) => [c.animation, c.track])).toEqual([['walk', 0], ['walk', 0]]);
  near(r.plainCompletes[0].at, 1.6);
  near(r.plainCompletes[1].at, 3.2);
});

test('loop: false holds the last pose, fires its event once, and completes once at its duration', async ({ page }) => {
  // Asserts: `nudge` played unlooped and stepped 1.5 s fires `hit` (int 7)
  // once at 0.5 s and completes once at 1.0 s; the player's time is 1.5 s
  // while the animation is applied at 1.0 s; `current` is still `nudge`; the
  // pose is the pose at 1.0 s to 1e-9.
  const r = await page.evaluate(() => window.rigPlayHarness.playerBasicsProbe());
  expect(r.heldEvents.map((e) => [e.name, e.int])).toEqual([['hit', 7]]);
  near(r.heldEvents[0].at, 0.5);
  expect(r.heldCompletes.map((c) => c.animation)).toEqual(['nudge']);
  near(r.heldCompletes[0].at, 1);
  expect(r.heldTime).toBeCloseTo(1.5, 6);
  expect(r.heldAnimationTime).toBeCloseTo(1, 9);
  expect(r.heldCurrent).toBe('nudge');
  expect(r.heldMaxDiff).toBeLessThanOrEqual(1e-9);
});

test('player.color multiplies into every tint and reaches the pixels', async ({ page }) => {
  // Asserts: with color (0.5, 1, 0.25, 1), every slot's frame tint is the
  // uncoloured tint times the colour, channel by channel, to 1e-12; and in the
  // canvas mode every pixel opaque in both renders (more than 1,000) reads the
  // uncoloured pixel times the colour within 3 levels.
  const r = await page.evaluate(() => window.rigPlayHarness.playerBasicsProbe());
  expect(r.tintSlots).toBeGreaterThan(5);
  expect(r.tintMaxError).toBeLessThanOrEqual(1e-12);
  expect(r.tintPixels).toBeGreaterThan(1000);
  expect(r.tintPixelMaxError).toBeLessThanOrEqual(3);
});

test('timeScale 2 doubles the step, a negative scale steps nothing, pause holds and resume steps again', async ({ page }) => {
  // Asserts: five 0.1 s frames at timeScale 2 put the time at 1.0 s and the
  // pose at a seek to 1.0 s (1e-9); at timeScale −1 a 0.1 s frame leaves the
  // time and the pose where they were; paused, a frame leaves the time; resumed,
  // a 0.1 s frame at timeScale 1 moves it 0.1 s.
  const r = await page.evaluate(() => window.rigPlayHarness.playerBasicsProbe());
  expect(r.doubleTime).toBeCloseTo(1, 9);
  expect(r.doubleMaxDiff).toBeLessThanOrEqual(1e-9);
  expect(r.negativeTime).toBe(r.doubleTime);
  expect(r.negativeMaxDiff).toBe(0);
  expect(r.pausedTime).toBe(r.doubleTime);
  expect(r.resumedTime).toBeCloseTo(r.doubleTime + 0.1, 9);
});

test('queue starts after the current cycle or after its delay, and queueClear empties the track after its delay', async ({ page }) => {
  // Asserts: `walk` with `nudge` queued plays walk at 1.5 s and nudge at 1.7
  // and 2.3 s, and nudge's `hit` fires once, at 1.6 + 0.5 = 2.1 s; `nudge`
  // queued with delay 0.5 has not started at 0.4 s and has at 0.6 s; a
  // `queueClear` with delay 0.3 leaves `nudge` at 0.2 s and nothing at 0.4 s.
  const r = await page.evaluate(() => window.rigPlayHarness.playerBasicsProbe());
  expect(r.queueAfterCycle.map((c) => c.animation)).toEqual(['walk', 'nudge', 'nudge']);
  expect(r.queueAfterCycleHits.length).toBe(1);
  near(r.queueAfterCycleHits[0], 2.1);
  expect(r.queueDelayed.map((c) => c.animation)).toEqual(['walk', 'nudge']);
  expect(r.queueClearDelayed.map((c) => c.animation)).toEqual(['nudge', null]);
});
