import { expect, test } from '@playwright/test';
import type { MeshContractSnapshot } from './harness';

/** #113/13,14,18: deterministic mesh invalidation, independent of raster backend. */
function counters(snapshot: MeshContractSnapshot, drawn: number, reused: number, realloc = 0): void {
  expect({ drawn: snapshot.drawn, reused: snapshot.reused, realloc: snapshot.realloc })
    .toEqual({ drawn, reused, realloc });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('live meshBackend and triangleExpand changes raster every mesh once without reallocating', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.meshSwitchProbe());
  // figure/rig.json authors precisely these two meshes; no count read from the renderer.
  expect(result.slots).toEqual(['cape', 'hair']);
  counters(result.initial, 2, 0, 2);
  counters(result.held, 0, 2);
  expect(result.switches.map(({ knob, value }) => [knob, value])).toEqual([
    ['meshBackend', 'webgl'], ['triangleExpand', 2],
    ['meshBackend', 'canvas2d'], ['triangleExpand', 0.5],
  ]);
  for (const [i, switched] of result.switches.entries()) {
    expect(switched.changed.activeBackend).toBe(i < 2 ? 'webgl' : 'canvas2d');
    counters(switched.changed, 2, 0);
    expect(switched.sameCanvases).toBe(true);
    expect(switched.changed.backing).toEqual(result.initial.backing);
    expect(switched.held).toHaveLength(2);
    for (const held of switched.held) {
      counters(held, 0, 2);
      expect(held.backing).toEqual(result.initial.backing);
    }
  }
});

test('a moving clip updates CSS while both still meshes reuse their raster', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.movingMeshClipProbe());
  expect(result.slots).toEqual(['cape', 'hair']);
  expect(result.sameMeshGeometry).toBe(true);
  // figure's authored tilted_moved quad is translated (+7,+7), all four corners.
  expect(result.polygonDeltas).toHaveLength(8);
  // rig-c's unrotated b=cos(90°) contributes ~1.6e-7 to a (+7,+7) translation.
  for (const delta of result.polygonDeltas) expect(delta).toBeCloseTo(7, 6);
  expect(result.runs.map(({ backend, path }) => [backend, path])).toEqual([
    ['canvas2d', 'root'], ['canvas2d', 'element'], ['webgl', 'root'], ['webgl', 'element'],
  ]);
  for (const run of result.runs) {
    expect(run.first.activeBackend).toBe(run.backend);
    counters(run.first, 2, 0, 2);
    counters(run.moved, 0, 2);
    counters(run.held, 0, 2);
    expect(run.moved.backing).toEqual(run.first.backing);
    const writes = run.path === 'root' ? 1 : 2;
    expect(run.clipWrites).toEqual([writes, writes, 0]);
    expect(run.pathsBefore).toHaveLength(writes);
    expect(run.pathsAfter).toHaveLength(writes);
    for (let i = 0; i < writes; i++) {
      expect(run.pathsBefore[i]).not.toBe('');
      expect(run.pathsAfter[i]).not.toBe('');
      expect(run.pathsAfter[i]).not.toBe(run.pathsBefore[i]);
    }
  }
});

test('dirty-skip CSS translate tracks a held mesh moved by whole pixels', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.heldMeshTranslateProbe());
  expect(result.runs.map(({ backend }) => backend)).toEqual(['canvas2d', 'webgl']);
  for (const run of result.runs) {
    // duo authors a single four-vertex sheet; the hook moves it (+7,+5)
    // without advancing shift. CSS and the laid-out canvas must follow (+7,-5).
    expect(run.slots).toEqual(['sheet']);
    expect(run.time).toEqual([0, 0]);
    expect(run.vertexDeltas).toEqual([7, 5, 7, 5, 7, 5, 7, 5]);
    expect(run.cssDelta).toEqual([7, -5]);
    expect(run.screenDelta).toEqual([7, -5]);
    expect(run.screenSizeUnchanged).toBe(true);
    expect(run.sameCanvas).toBe(true);
    expect(run.first.activeBackend).toBe(run.backend);
    counters(run.first, 1, 0, 1);
    counters(run.moved, 0, 1);
    counters(run.held, 0, 1);
    expect(run.moved.backing).toEqual(run.first.backing);
    expect(run.changedRasterChannels).toBe(0);
    expect(run.centreAlpha).toBe(255);
  }
});
