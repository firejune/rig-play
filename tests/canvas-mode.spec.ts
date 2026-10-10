import { expect, test } from '@playwright/test';

/**
 * The canvas render mode (`RigPlayer` `mode: 'canvas'`, `CanvasRenderer`) —
 * what has no picture to diff: the context cap, the dirty-skip, the page
 * texture ledger and the in-place swap. The picture itself is held against the
 * DOM tier by the `dom / canvas` cells of `tests/parity.spec.ts`.
 *
 * Every number here is a counter; nothing is timed.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('20 canvas-mode players draw through the one shared WebGL context', async ({ page }, testInfo) => {
  // Past the browsers' ~16-context cap: a renderer that took a context of its
  // own would lose the oldest ones here.
  const probe = await page.evaluate(() => window.rigPlayHarness.canvasModeProbe(20));
  test.skip(!probe.webglAvailable, `${testInfo.project.name}: no shared WebGL context here`);
  console.log(
    `[canvas-mode] ${testInfo.project.name}: contexts ${probe.contextsBefore} → ${probe.contextsAfter}, ` +
      `webgl players ${probe.webglPlayers}/20, drawing ${probe.drawingPlayers}/20, blits ${probe.blits}, ` +
      `reused on the held redraw ${probe.reusedOnSecondDraw}/20, textures ${probe.baselineTextures} → ` +
      `${probe.texturesWhileDrawing} → ${probe.texturesAfterDispose}`,
  );
  // One context for the module, however many players: none created by them.
  expect(probe.contextsAfter).toBe(1);
  expect(probe.webglPlayers).toBe(20);
  expect(probe.drawingPlayers).toBe(20);
  expect(probe.blits).toBe(20);
  // Each player is one element: its canvas.
  expect(probe.elementsPerRoot).toEqual(new Array(20).fill(1));
  // A held pose draws nothing the second time.
  expect(probe.reusedOnSecondDraw).toBe(20);
  // A packed build draws one page: one upload shared by all twenty, given back
  // when the last of them is disposed.
  expect(probe.texturesWhileDrawing).toBe(probe.baselineTextures + 1);
  expect(probe.texturesAfterDispose).toBe(probe.baselineTextures);
  // The mode swaps in place: the DOM tier's elements, then one canvas again.
  expect(probe.swap[0].renderer).toBe('DomRenderer');
  expect(probe.swap[0].mode).toBe('dom');
  expect(probe.swap[0].images).toBeGreaterThan(5);
  expect(probe.swap[1]).toEqual({ mode: 'canvas', canvases: 1, images: 0, renderer: 'CanvasRenderer' });
});
