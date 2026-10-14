import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { diffInPage } from './pixelDiff';
import { oraclePixels } from './oraclePixels';
import { ORACLE_FLOORS, byteBudget, countBudget } from './oracleLimits';
import type { OracleScene } from './oracle';

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

for (const { name, scene, slot } of SCENES) {
  test(`official raster: ${name}`, async ({ page }, testInfo) => {
    await page.goto('/tests/oracle.html');
    await page.waitForFunction(() => Boolean(window.officialOracleHarness));
    for (const mode of ['dom-webgl', 'dom-canvas2d', 'canvas'] as const) {
      await page.goto('/tests/oracle.html');
      await page.waitForFunction(() => Boolean(window.officialOracleHarness));
      const capture = await page.evaluate(({ scene, mode }) => window.officialOracleHarness.capture(scene, mode), { scene, mode });
      expect(capture.generation).toBe('4.3.13');
      expect(capture.pairHashMatches).toBe(true);
      expect(capture.maxGeometryDelta).toBe(0);
      expect(capture.pagesPma.every(pma => pma === (name === 'figure PMA'))).toBe(true);
      expect(capture.width).toBe(scene.viewport?.width ?? 400);
      expect(capture.height).toBe(scene.viewport?.height ?? 440);
      expect(capture.backend).toBe(mode === 'dom-canvas2d' ? 'canvas2d' : 'webgl');
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
        writeFileSync(testInfo.outputPath(`${mode}-${row.background}-reference.png`), a);
        writeFileSync(testInfo.outputPath(`${mode}-${row.background}-actual.png`), b);
        if (metric.mask) writeFileSync(testInfo.outputPath(`${mode}-${row.background}-mask.png`), Buffer.from(metric.mask.pngBase64, 'base64'));
      }
      console.log(`[official-alpha] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify({ alpha, composites: compositeMetrics })}`);
      console.log(`[official-channels] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify(channels)}`);
      console.log(`[official] ${testInfo.project.name} ${name} ${mode} ${JSON.stringify({ capture, metrics: { ...metrics, mask: undefined } })}`);
      writeFileSync(testInfo.outputPath(`${mode}-reference.png`), reference);
      writeFileSync(testInfo.outputPath(`${mode}-actual.png`), actual);
      writeFileSync(testInfo.outputPath(`${mode}-metrics.json`), JSON.stringify({ capture, metrics: { ...metrics, mask: undefined }, channels, alpha, composites: compositeMetrics }, null, 2));
      if (metrics.mask) writeFileSync(testInfo.outputPath(`${mode}-mask.png`), Buffer.from(metrics.mask.pngBase64, 'base64'));
      // Both pictures must carry the authored geometry and some artwork.
      expect(capture.slotNames).toContain(slot);
      expect(metrics.contentA).toBeGreaterThan(0);
      expect(metrics.contentB).toBeGreaterThan(0);
      expect(alpha.countA).toBeGreaterThan(0);
      expect(alpha.countB).toBeGreaterThan(0);
      const engine = testInfo.project.name;
      if (engine !== 'chromium' && engine !== 'webkit') throw new Error(`uncalibrated official oracle engine: ${engine}`);
      const floor = ORACLE_FLOORS[engine][name][mode];
      for (const [i, side] of ['black', 'white'].entries()) {
        const observed = compositeMetrics[i].metrics;
        const base = floor[side as 'black' | 'white'];
        expect.soft(observed.rawBad, `${side} raw residue`).toBeLessThanOrEqual(countBudget(base[0]));
        expect.soft(observed.bad, `${side} shift residue`).toBeLessThanOrEqual(countBudget(base[1]));
        expect.soft(observed.maxDelta, `${side} maximum channel residue`).toBeLessThanOrEqual(byteBudget(base[2]));
        expect.soft(observed.darker, `${side} darkening`).toBeLessThanOrEqual(countBudget(base[3]));
      }
      expect.soft(Math.abs(alpha.countA - alpha.countB), 'alpha coverage').toBeLessThanOrEqual(countBudget(floor.alpha[0]));
      expect.soft(Math.abs(alpha.sumA - alpha.sumB), 'integrated alpha').toBeLessThanOrEqual(countBudget(floor.alpha[1]));
      expect.soft(alpha.rawBad, 'unequal alpha pixels').toBeLessThanOrEqual(countBudget(floor.alpha[2]));
      expect.soft(alpha.maxDelta, 'maximum alpha residue').toBeLessThanOrEqual(byteBudget(floor.alpha[3]));
      if (name.startsWith('draw ')) {
        expect(capture.slotNames).toEqual(name === 'draw initial'
          ? ['base_mul', 'ink_mul', 'base_screen', 'ink_screen']
          : ['ink_mul', 'base_mul', 'base_screen', 'ink_screen']);
        // Two separated authored 64x64 opaque squares, with overlapping ink.
        expect(alpha.countA).toBe(2 * 64 * 64);
        expect(alpha.countB).toBe(2 * 64 * 64);
      }
      if (name === 'figure PMA' && mode === 'canvas') {
        // Healthy measurements: Chromium's unpremultiplied low-alpha edge
        // channels reach 26 (two pixels above 24); WebKit reaches one byte.
        // Keep the measured engines separate, rather than hiding the PMA
        // correction behind the substantially larger DOM sampling residue.
        if (testInfo.project.name === 'chromium') {
          const edge = channels.find(row => row.tolerance === 24)!.metrics;
          expect.soft(edge.bad).toBe(0);
          expect.soft(edge.rawBad).toBeLessThanOrEqual(2);
          expect.soft(metrics.maxDelta).toBeLessThanOrEqual(26);
        } else {
          expect.soft(metrics.rawBad).toBeLessThanOrEqual(6);
          expect.soft(metrics.maxDelta).toBeLessThanOrEqual(1);
        }
      }
    }
  });
}
