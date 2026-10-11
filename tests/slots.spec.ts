import { expect, test } from '@playwright/test';

/**
 * RigPlayer.slots (#88): a draw filter over the whole rig's pose. The oracle
 * is the unfiltered frame record with the other slots removed — the same
 * record, so the same numbers — in both modes; a clipping slot the filter
 * leaves out no longer clips; `bounds()` reads the drawn slots; a second
 * renderer draws the player's pose under its own filter on another root.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('the filtered frame is the unfiltered one with the other slots removed, in both modes', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.slotFilterProbe());

  expect(r.filteredSlots.sort()).toEqual(['arm_f_lo', 'arm_f_up', 'hand_f']);
  expect(r.filteredEqualsRemoved).toBe(true);
  expect(r.unfilteredCount).toBeGreaterThan(3);
  expect(r.boneSameUnderFilter).toBe(true);

  expect(r.domImages).toBe(3);
  expect(r.domImagesAfterLive).toBe(1);
  expect(r.canvasDrew).toBe(true);

  expect(r.boundsMatchFiltered).toBe(true);
  expect(r.boundsDiffer).toBe(true);

  expect(r.unknownError).toContain('no_such_slot');
  expect(r.predicateSlots.sort()).toEqual(['leg_b', 'leg_f']);
  expect(r.secondRootImages).toBe(1);
});

test('a clipping slot the filter leaves out does not clip', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.slotFilterProbe());

  expect(r.coveredWithClipKept).toBeGreaterThan(0);
  expect(r.clipKeptSameAsUnfiltered).toBe(true);
  expect(r.coveredWithClipOut).toBe(0);
});
