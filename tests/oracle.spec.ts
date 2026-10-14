import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { diffInPage } from './pixelDiff';
import { oraclePixels } from './oraclePixels';
import { oracleCalibration, byteBudget, countBudget } from './oracleLimits';
import type { OracleMode, OracleScene } from './oracle';

// Fixed #39 representatives, with independently read paired exports.
const SCENES: Array<{ name: string; scene: OracleScene; slot: string }> = [
  { name: 'figure geometry', scene: { rig: 'figure', animation: 'bare', time: 0 }, slot: 'hair' },
  { name: 'figure tinted walk', scene: { rig: 'figure-packed', animation: 'walk', time: 1.2, color: [1, 0.56, 0.38, 1] }, slot: 'hair' },
  { name: 'figure PMA', scene: { rig: 'figure-pma', animation: 'walk', time: 1.2 }, slot: 'hair' },
  { name: 'figure clip', scene: { rig: 'figure-packed', animation: 'mask', time: 0.6 }, slot: 'hair' },
  { name: 'draw initial', scene: { rig: 'draw', animation: 'reorder', time: 0.25, loop: false, skin: 'base', viewport: { width: 240, height: 120, originX: 120, originY: 60, scale: 1 } }, slot: 'ink_mul' },
  { name: 'draw reordered', scene: { rig: 'draw', animation: 'reorder', time: 0.75, loop: false, skin: 'base', viewport: { width: 240, height: 120, originX: 120, originY: 60, scale: 1 } }, slot: 'ink_mul' },
  { name: 'turned region', scene: { rig: 'turned', animation: 'hold', time: 0, viewport: { width: 80, height: 80, originX: 40, originY: 40, scale: 8 } }, slot: 's' },
  { name: 'named region mesh', scene: { rig: 'named', animation: 'tilt', time: 1.2, viewport: { width: 800, height: 300, originX: 400, originY: 270, scale: 1 } }, slot: 'swatch' },
  { name: 'additive glow', scene: { rig: 'glow-packed', animation: 'burn', time: 1.2 }, slot: 'halo' },
];

const MODES = ['dom-webgl', 'dom-canvas2d', 'canvas'] as const;

/** Same real capture and differ for healthy and adversarial inputs. */
async function measure(page: Page, testInfo: TestInfo, name: string, scene: OracleScene,
  mode: OracleMode, prefix: string = mode) {
  await page.goto('/tests/oracle.html');
  await page.waitForFunction(() => Boolean(window.officialOracleHarness));
  const capture = await page.evaluate(({ scene, mode }) => window.officialOracleHarness.capture(scene, mode), { scene, mode });
  const reference = await page.locator('#oracle-reference').screenshot({ omitBackground: true });
  let actual = await page.locator('#oracle-actual').screenshot({ omitBackground: true });
  let stable = 0;
  let attempts = 0;
  while (stable < 2 && attempts < 12) {
    await page.evaluate(() => window.officialOracleHarness.repaint());
    const next = await page.locator('#oracle-actual').screenshot({ omitBackground: true });
    stable = next.equals(actual) ? stable + 1 : 0;
    actual = next;
    attempts++;
  }
  expect(stable).toBe(2);
  const metrics = await diffInPage(page, reference, actual, { tolerance: 0, directional: 0, withMask: true });
  const channels = [];
  for (const tolerance of [8, 16, 24]) channels.push({ tolerance, metrics: await diffInPage(page, reference, actual, { tolerance, directional: tolerance }) });
  const { alpha, composites } = await oraclePixels(page, reference, actual);
  const compositeMetrics = [];
  for (const row of composites) {
    const a = Buffer.from(row.reference, 'base64'), b = Buffer.from(row.actual, 'base64');
    const metric = await diffInPage(page, a, b, { tolerance: 24, directional: 24, withMask: true });
    compositeMetrics.push({ background: row.background, metrics: { ...metric, mask: undefined } });
    writeFileSync(testInfo.outputPath(`${prefix}-${row.background}-reference.png`), a);
    writeFileSync(testInfo.outputPath(`${prefix}-${row.background}-actual.png`), b);
    if (metric.mask) writeFileSync(testInfo.outputPath(`${prefix}-${row.background}-mask.png`), Buffer.from(metric.mask.pngBase64, 'base64'));
  }
  console.log(`[official-alpha] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify({ alpha, composites: compositeMetrics })}`);
  console.log(`[official-channels] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify(channels)}`);
  console.log(`[official] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify({ capture, metrics: { ...metrics, mask: undefined } })}`);
  const result = { platform: process.platform, capture, metrics: { ...metrics, mask: undefined }, channels, alpha, composites: compositeMetrics };
  writeFileSync(testInfo.outputPath(`${prefix}-reference.png`), reference);
  writeFileSync(testInfo.outputPath(`${prefix}-actual.png`), actual);
  writeFileSync(testInfo.outputPath(`${prefix}-metrics.json`), JSON.stringify(result, null, 2));
  if (metrics.mask) writeFileSync(testInfo.outputPath(`${prefix}-mask.png`), Buffer.from(metrics.mask.pngBase64, 'base64'));
  return result;
}
type Measurement = Awaited<ReturnType<typeof measure>>;

function assertCapture(result: Measurement, scene: OracleScene, slot: string) {
  const { capture, metrics, alpha } = result;
  expect(capture.generation).toBe('4.3.13');
  expect(capture.pairHashMatches).toBe(true);
  expect(capture.maxGeometryDelta).toBe(0);
  expect(capture.pagesPma.every(pma => pma === (scene.rig === 'figure-pma'))).toBe(true);
  expect(capture.width).toBe(scene.viewport?.width ?? 400);
  expect(capture.height).toBe(scene.viewport?.height ?? 440);
  expect(capture.backend).toBe(capture.mode === 'dom-canvas2d' ? 'canvas2d' : 'webgl');
  // Both independent pictures must carry authored geometry and artwork.
  expect(capture.slotNames).toContain(slot);
  expect(metrics.contentA).toBeGreaterThan(0);
  expect(metrics.contentB).toBeGreaterThan(0);
  expect(alpha.countA).toBeGreaterThan(0);
  expect(alpha.countB).toBeGreaterThan(0);
}

function assertHealthy(result: Measurement, name: string, calibration: ReturnType<typeof oracleCalibration>, soft = true) {
  const { capture, metrics, channels, alpha, composites } = result;
  const floor = calibration.floors[name][capture.mode];
  const check = soft ? expect.soft : expect;
  for (const [i, side] of ['black', 'white'].entries()) {
    const observed = composites[i].metrics;
    const base = floor[side as 'black' | 'white'];
    check(observed.rawBad, `${side} raw residue`).toBeLessThanOrEqual(countBudget(base[0]));
    check(observed.bad, `${side} shift residue`).toBeLessThanOrEqual(countBudget(base[1]));
    check(observed.maxDelta, `${side} maximum channel residue`).toBeLessThanOrEqual(byteBudget(base[2]));
    check(observed.darker, `${side} darkening`).toBeLessThanOrEqual(countBudget(base[3]));
  }
  check(Math.abs(alpha.countA - alpha.countB), 'alpha coverage').toBeLessThanOrEqual(countBudget(floor.alpha[0]));
  check(Math.abs(alpha.sumA - alpha.sumB), 'integrated alpha').toBeLessThanOrEqual(countBudget(floor.alpha[1]));
  check(alpha.rawBad, 'unequal alpha pixels').toBeLessThanOrEqual(countBudget(floor.alpha[2]));
  check(alpha.maxDelta, 'maximum alpha residue').toBeLessThanOrEqual(byteBudget(floor.alpha[3]));
  if (name.startsWith('draw ')) {
    expect(capture.slotNames).toEqual(name === 'draw initial'
      ? ['base_mul', 'ink_mul', 'base_screen', 'ink_screen']
      : ['ink_mul', 'base_mul', 'base_screen', 'ink_screen']);
    // Two separated authored 64x64 opaque squares, with overlapping ink.
    expect(alpha.countA).toBe(2 * 64 * 64);
    expect(alpha.countB).toBe(2 * 64 * 64);
  }
  if (name === 'figure PMA' && capture.mode === 'canvas') {
    const raw = calibration.pmaRaw;
    const measured = raw.tolerance === 0 ? metrics : channels.find(row => row.tolerance === raw.tolerance)!.metrics;
    if (raw.bad !== undefined) check(measured.bad).toBe(raw.bad);
    check(measured.rawBad).toBeLessThanOrEqual(raw.rawBad);
    check(metrics.maxDelta).toBeLessThanOrEqual(raw.maxDelta);
  }
}

for (const { name, scene, slot } of SCENES) {
  test(`official raster: ${name}`, async ({ page }, testInfo) => {
    const calibration = oracleCalibration(process.platform, testInfo.project.name);
    for (const mode of MODES) {
      const result = await measure(page, testInfo, name, scene, mode);
      assertCapture(result, scene, slot);
      assertHealthy(result, name, calibration);
    }
  });
}

test('official oracle rejects shared PMA misinterpretation in every renderer', async ({ page }, testInfo) => {
  const calibration = oracleCalibration(process.platform, testInfo.project.name);
  const fixture = SCENES.find(row => row.name === 'figure PMA')!;
  const modelUrl = '**/rigs/figure-pma/skeleton.model.json';
  for (const mode of MODES) {
    const healthy = await measure(page, testInfo, fixture.name, fixture.scene, mode, `healthy-${mode}`);
    assertCapture(healthy, fixture.scene, fixture.slot);
    expect(healthy.capture.pagesPma).toEqual([true]);
    // The negative cannot certify itself on a broken positive capture.
    assertHealthy(healthy, fixture.name, calibration, false);
    let receipt: { originalPagesPma: boolean[]; servedPagesPma: boolean[] } | undefined;
    const misreadPma = async (route: Route) => {
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`PMA adversary source HTTP ${response.status()}`);
      const model = await response.json() as { spec?: string; pages?: Array<{ pma?: boolean }> };
      if (model.spec !== 'rigc-compiled/3' || model.pages?.length !== 1 || model.pages[0].pma !== true)
        throw new Error('PMA adversary requires the original one-page PMA compiled fixture');
      const originalPagesPma = model.pages.map(page => page.pma === true);
      // Only play's response changes. Original JSON/atlas/PNG and the
      // official reader remain untouched; no pose is forged.
      for (const ownPage of model.pages) ownPage.pma = false;
      receipt = { originalPagesPma, servedPagesPma: model.pages.map(page => page.pma === true) };
      await route.fulfill({ response, json: model });
    };
    await page.route(modelUrl, misreadPma);
    try {
      const mutant = await measure(page, testInfo, 'shared PMA misinterpretation', fixture.scene, mode, `shared-pma-${mode}`);
      assertCapture(mutant, fixture.scene, fixture.slot);
      expect(mutant.capture.pagesPma).toEqual([true]);
      expect(receipt).toEqual({ originalPagesPma: [true], servedPagesPma: [false] });
      const healthyBlackBudget = countBudget(calibration.floors[fixture.name][mode].black[0]);
      const mutantBlackRaw = mutant.composites[0].metrics.rawBad;
      writeFileSync(testInfo.outputPath(`${mode}-adversary.json`), JSON.stringify({
        platform: process.platform, engine: testInfo.project.name, mode, receipt,
        healthyBlackRaw: healthy.composites[0].metrics.rawBad, healthyBlackBudget, mutantBlackRaw,
        referenceGeneration: mutant.capture.generation, pairHashMatches: mutant.capture.pairHashMatches,
        officialPagesPma: mutant.capture.pagesPma, maxGeometryDelta: mutant.capture.maxGeometryDelta,
      }, null, 2));
      expect.soft(mutantBlackRaw, `${mode} must reject shared #37 PMA darkening`).toBeGreaterThan(healthyBlackBudget);
    } finally {
      await page.unroute(modelUrl, misreadPma);
    }
  }
});
