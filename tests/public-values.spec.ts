import { expect, test } from '@playwright/test';
import { diffInPage, CHANNEL_TOLERANCE } from './pixelDiff';

/** Consumer contracts absent from the first player audit: #113 items 11, 12, 17. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('seek crosses events and completes silently, then advances only from its new time', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.seekContractProbe());
  expect(result.cases.map((c) => c.tracks)).toEqual([false, true]);
  for (const c of result.cases) {
    expect(c.beforePlay).toBe('seek before play: no animation is open');
    // 3.3 s crosses four step keys and two cycles. Seeking back to 0.2 must
    // still leave both listeners empty; a lower bound on the later list would
    // quietly admit every callback fired during this replay.
    expect(c.crossedEvents).toEqual([]);
    expect(c.crossedCompletes).toEqual([]);
    expect(c.seeks.map((s) => s.requested)).toEqual([3.3, 0.2, 1.5]);
    for (const s of c.seeks) expect(s.actual).toBe(s.requested);
    expect(c.afterSeekEvents).toEqual([{ name: 'step', time: Math.fround(0.4), int: 0, track: 0 }]);
    expect(c.afterSeekCompletes).toEqual([{ animation: 'walk', track: 0 }]);
  }
});

test('seekStep chooses the replay increments and refuses zero, negative and NaN', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.seekContractProbe());
  // An adjust hook is called once for the reopened pose and once per step.
  // 0.625 = 37/60 + remainder, 2*0.25 + remainder, or 5*0.125.
  expect(result.schedules.map((s) => [s.tracks, s.step, s.poses])).toEqual([
    [false, null, 39], [false, 0.25, 4], [false, 0.125, 6],
    [true, null, 39], [true, 0.25, 4], [true, 0.125, 6],
  ]);
  for (const s of result.schedules) {
    expect(s.time).toBe(0.625);
    expect(s.frameSame).toBe(true);
  }
  expect(result.invalidSteps).toEqual(['0', '-0.1', 'NaN'].map((value) => ({
    value, message: `seekStep must be a positive number of seconds, got ${value}`,
  })));
});

test('on returns idempotent removers that remove only their event or complete listener', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.listenerRemovalProbe());
  expect(result.cases.map((c) => c.tracks)).toEqual([false, true]);
  for (const c of result.cases) {
    expect(c.before).toEqual({ removedEvents: ['hit'], keptEvents: ['hit'], removedCompletes: ['nudge'], keptCompletes: ['nudge'] });
    expect(c.after).toEqual({ removedEvents: ['hit'], keptEvents: ['hit', 'hit'], removedCompletes: ['nudge'], keptCompletes: ['nudge', 'nudge'] });
  }
});

test('assets expose the chosen region encoding, stated stage and every animation duration; page crossOrigin precedes src', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.publicValuesProbe());
  expect(result.loads.map((l) => [l.requested, l.regions])).toEqual([
    ['default', 'blob'], ['blob', 'blob'], ['data', 'data'], ['none', 'none'],
  ]);
  // These are the source rig/motion's values, rather than a second projection
  // of assets.document that could agree with an incorrect public projection.
  const animations = [
    ['walk', 1.6], ['mask', 1.6], ['detail', 1.6], ['bare', 1], ['tilted', 1],
    ['tilted_moved', 1], ['nudge', 1], ['cover', 1], ['window', 1], ['inverse', 1], ['nested', 1],
  ] as const;
  const origins = [null, 'anonymous', 'use-credentials', 'anonymous'];
  for (const [i, load] of result.loads.entries()) {
    expect(load.stage).toEqual({ x: -260, y: 0, width: 520, height: 620 });
    // rig-c/core reads key times as float32 and the duration as their maximum
    // (animation.ts readAnimationTimelines), so even 1.6 has one exact value.
    expect(load.animations).toEqual(animations.map(([name, duration]) => ({ name, duration: Math.fround(duration) })));
    // A packed rig has exactly one page. The setter observation also catches
    // assigning crossOrigin after src, which a final property read cannot.
    expect(load.imageOrigins).toEqual([origins[i]]);
    expect(load.originsAtSrc).toEqual([origins[i]]);
  }
});

test('entry reports its own track time, wrapped animation time and held duration in both track modes', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.publicValuesProbe());
  expect(result.entries.map((e) => e.tracks)).toEqual([false, true]);
  for (const e of result.entries) {
    expect(e.before).toBeNull();
    expect(e.otherTrack).toBeNull();
    expect(e.loop).toEqual({ animation: 'walk', loop: true, trackTime: 1.75, animationTime: 1.75 % Math.fround(1.6), duration: Math.fround(1.6), alpha: 1, additive: false });
    expect(e.held).toEqual({ animation: 'nudge', loop: false, trackTime: 1.25, animationTime: 1, duration: 1, alpha: 1, additive: false });
  }
});

test('CanvasRenderer counts each blend change and triangle exactly, resets on reuse, and counts an authored mesh', async ({ page }) => {
  const result = await page.evaluate(() => window.rigPlayHarness.canvasCountersProbe());
  expect(result.topology.map((s) => [s.slot, s.blend])).toEqual([
    ['halo', 'Additive'], ['body', 'Normal'], ['flame', 'Additive'],
    ['core', 'Normal'], ['spark_a', 'Additive'], ['spark_b', 'Additive'],
  ]);
  // The two generated mesh counts are derived from the real frame. The
  // authored control below has 46 explicit triangles and two rigid quads.
  expect(result.topology.filter((s) => !['flame', 'core'].includes(s.slot)).map((s) => s.triangles)).toEqual([2, 2, 2, 2]);
  expect(result.expectedTriangles).toBe(result.topology.reduce((sum, s) => sum + s.triangles, 0));
  expect(result.cases.map((c) => c.backend)).toEqual(['webgl', 'canvas2d']);
  for (const c of result.cases) {
    expect(c.active).toBe(c.backend);
    expect(c.first).toEqual({ blends: 4, triangles: result.expectedTriangles });
    expect(c.held).toEqual({ blends: 0, triangles: 0, reused: 1 });
    expect(c.changed).toEqual(c.first);
    expect(c.authored).toEqual({ blends: 1, triangles: 50 });
  }
});

for (const backend of ['webgl', 'canvas2d'] as const) {
  test(`canvas mode draws the premultiplied twin as the straight artwork: ${backend}`, async ({ page }) => {
    const capture = async (variant: 'straight' | 'pma'): Promise<Buffer> => {
      const info = await page.evaluate(({ variant, backend }) => window.rigPlayHarness.canvasPmaStage(variant, backend), { variant, backend });
      expect(info.backend).toBe(backend);
      expect(info.pagePma).toBe(variant === 'pma');
      expect(info.allSlotsPma).toBe(variant === 'pma');
      expect([info.regions, info.meshes]).toEqual([15, 2]);
      expect(info.triangles).toBe(info.expectedTriangles);
      if (backend === 'canvas2d') {
        expect(info.sourceAudit?.sources).toBe(1);
        expect(info.sourceAudit?.mismatches).toBe(0);
        expect(info.sourceAudit?.alphaMismatches).toBe(0);
        if (variant === 'pma') expect(info.sourceAudit?.correctedTexels).toBeGreaterThan(0);
        else expect(info.sourceAudit?.correctedTexels).toBe(0);
      } else expect(info.sourceAudit).toBeNull();
      const stage = page.locator('#public-pma-stage');
      let previous = await stage.screenshot();
      for (let i = 0; i < 12; i++) {
        const next = await stage.screenshot();
        if (next.equals(previous)) return next;
        previous = next;
      }
      throw new Error('the canvas PMA stage raster never settled');
    };
    const straight = await capture('straight');
    const pma = await capture('pma');
    const diff = await diffInPage(page, straight, pma, { directional: CHANNEL_TOLERANCE });
    console.log(`[canvas-pma] ${backend}: content=${diff.contentUnion}, bad=${diff.bad}, darker=${diff.darker}, lighter=${diff.lighter}, max=${diff.maxDelta}`);
    // The same independent artwork A/B and limits as pma.spec.ts: these are
    // that suite's declared parity budget, never a new platform calibration.
    expect(diff.contentUnion).toBeGreaterThan(5000);
    expect(diff.bad / diff.contentUnion).toBeLessThanOrEqual(0.005);
    expect(diff.darker / diff.contentUnion).toBeLessThanOrEqual(0.002);
    expect(diff.lighter / diff.contentUnion).toBeLessThanOrEqual(0.002);
    expect(diff.darker).toBeLessThanOrEqual(diff.lighter + Math.ceil(0.002 * diff.contentUnion));
  });
}
