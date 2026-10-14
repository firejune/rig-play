import { expect, test, type Page } from '@playwright/test';

/** #113 items 10,15,16. Expectations come from the authored flat-colour rig. */
const ORDER = ['base_mul', 'ink_mul', 'base_screen', 'ink_screen'];
const BLENDS = ['Normal', 'Multiply', 'Normal', 'Screen'];
const MIXED = [[128, 0, 192, 255], [255, 64, 255, 255]];

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.rigPlayHarness.drawContractDispose());
});

/** Read the browser's DOM composite, independently of the renderer's canvas. */
async function domSamples(page: Page): Promise<number[][]> {
  const png = await page.locator('#draw-contract-stage').screenshot({ omitBackground: true });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no screenshot read context');
    ctx.drawImage(image, 0, 0);
    return [48, 144].map((x) => Array.from(ctx.getImageData(x, 48, 1, 1).data));
  }, png.toString('base64'));
}

test('item 10: real Multiply and Screen slots reach their CSS blends and exact opaque pixels', async ({ page }) => {
  // Base [128,64,192], ink [255,0,255]. Multiply is c·b and Screen is
  // c+b−c·b; 0/255 ink channels make both exact, with no rounding budget.
  const r = await page.evaluate(() => window.rigPlayHarness.drawContractStage({ action: 'start' }));
  expect(r.order).toEqual(ORDER);
  expect(r.blends).toEqual(BLENDS);
  expect(r.elements.map((e) => e.blend)).toEqual(['normal', 'multiply', 'normal', 'screen']);
  expect(await domSamples(page)).toEqual(MIXED);
});

for (const backend of ['canvas2d', 'webgl'] as const) {
  test(`item 10: ${backend} composes the same Multiply and Screen formula`, async ({ page }) => {
    const r = await page.evaluate((backend) => window.rigPlayHarness.drawContractStage({ action: 'start', mode: 'canvas', backend }), backend);
    expect(r.backend).toBe(backend);
    expect(r.order).toEqual(ORDER);
    expect(r.blends).toEqual(BLENDS);
    expect(r.samples).toEqual(MIXED);
  });
}

test('item 15: keyed draw order changes z-index and overlap, and a live skin changes the same visible img src', async ({ page }) => {
  const first = await page.evaluate(() => window.rigPlayHarness.drawContractStage({ action: 'start' }));
  expect(first.elements.map((e) => [e.slot, e.z, e.region, e.srcMatches, e.visible])).toEqual([
    ['base_mul', '1', 'base', true, true], ['ink_mul', '2', 'ink', true, true],
    ['base_screen', '3', 'base', true, true], ['ink_screen', '4', 'ink', true, true],
  ]);
  const alt = await page.evaluate(() => window.rigPlayHarness.drawContractStage({ action: 'alt' }));
  expect(alt.sameImage).toBe(true);
  expect(alt.changedSrc).toBe(true);
  expect(alt.elements.map((e) => [e.region, e.srcMatches, e.visible])).toEqual([
    ['base', true, true], ['alt', true, true], ['base', true, true], ['ink', true, true],
  ]);
  expect(await domSamples(page)).toEqual([[0, 64, 0, 255], MIXED[1]]);
  const restored = await page.evaluate(() => window.rigPlayHarness.drawContractStage({ action: 'default' }));
  expect(restored.sameImage).toBe(true);
  expect(restored.changedSrc).toBe(false);
  expect(restored.elements.map((e) => e.srcMatches)).toEqual([true, true, true, true]);
  expect(await domSamples(page)).toEqual(MIXED);

  const changed = await page.evaluate(() => window.rigPlayHarness.drawContractStage({ action: 'reorder' }));
  expect(changed.order).toEqual(['ink_mul', 'base_mul', 'base_screen', 'ink_screen']);
  expect(changed.elements.map((e) => [e.slot, e.z])).toEqual([
    ['ink_mul', '1'], ['base_mul', '2'], ['base_screen', '3'], ['ink_screen', '4'],
  ]);
  // The opaque base is now in front of the left ink; the right pair stays.
  expect(await domSamples(page)).toEqual([[128, 64, 192, 255], MIXED[1]]);
});

test('item 16: bounds equals the smaller clip box, inverse leaves bounds unchanged, and undrawn attachments stay excluded', async ({ page }) => {
  const r = await page.evaluate(() => window.rigPlayHarness.drawBoundsProbe());
  console.log(`[draw-bounds] ${test.info().project.name}: ${JSON.stringify({ changed: r.inverseChangedPixels, ...r.inverseDiff })}`);
  // Raw equality to the polygon's independent min/max box. The authored
  // values carry the core's cos90 residue (<3e-6 here), pinned within 5e-6.
  expect(r.window).toEqual(r.windowClipBox);
  expect(r.window).toEqual({ x: expect.closeTo(-70, 5), y: expect.closeTo(-10, 5), width: expect.closeTo(40, 5), height: expect.closeTo(20, 5) });
  expect(r.bare).toEqual({ x: expect.closeTo(-80, 5), y: expect.closeTo(-32, 5), width: expect.closeTo(160, 5), height: expect.closeTo(64, 5) });
  expect(r.inverse).toEqual(r.bare);
  // Bounds is the contract here. Whole-raster identity was rejected: cutting
  // quads into triangles changes AA/quantization even when the clip is far away.
  expect(r.bareSlots).toEqual(ORDER);
  // The far bone and its region exist in the compiled rig; turning on that
  // attachment is a positive control showing how much its exclusion matters.
  expect(r.hiddenSlots).toEqual([...ORDER, 'hidden']);
  expect(r.hiddenOn).toEqual({ x: expect.closeTo(-80, 5), y: expect.closeTo(-32, 5), width: expect.closeTo(1112, 5), height: expect.closeTo(64, 5) });
  expect(r.empty).toBeNull();
});
