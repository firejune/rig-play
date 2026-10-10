import { expect, type Page, test } from '@playwright/test';

/**
 * Deterministic counters and math invariants.
 *
 * Policy: never assert absolute milliseconds — timing numbers are
 * machine/headless-dependent (headless WebKit is a software rasterizer).
 * These tests only read deterministic counters from the demo's #stats line,
 * over a rigc gallery build and over the repository's test rigs (tests/rigs/,
 * which carry the clipping attachment no gallery build has), every one posed
 * by rig-c/core through RigPlayer.
 *
 * The corner-order and region-UV invariants at the bottom read the model side
 * through `tests/harness.ts` and are reached through the browser.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
}

test('frozen gallery scene: every mesh reuses its raster, nothing reallocates', async ({ page }) => {
  await page.goto('/?rig=flex&anim=wave&count=10&dpr=1&timescale=0');
  const stats = page.locator('#stats');
  // 10 flex instances × 4 contour meshes: a held player draws the pose it
  // holds without re-posing it, so the dirty-skip path must carry all 40.
  await expect(stats).toContainText('mesh canvases 0 drawn (0 tris) / 40 reused');
  await expect(stats).not.toContainText("realloc'd");
});

test('running gallery scene: grow-only mesh backing reaches a realloc-free steady state', async ({
  page,
}) => {
  await page.goto('/?rig=flex&anim=wave&count=10&dpr=1');
  await realloclessTicks(page);
});

/**
 * Two fresh stats ticks (the line re-renders every 500ms) that carry no
 * realloc token. A per-frame realloc storm — the regression this guards,
 * canvas backing recreated every frame — would stamp the token into every
 * tick and time this out. Content-based waits, no sleeps.
 */
async function realloclessTicks(page: Page): Promise<void> {
  const stats = page.locator('#stats');
  await expect(stats).toContainText('mesh canvases');
  let prev = (await stats.textContent()) ?? '';
  for (let tick = 0; tick < 2; tick++) {
    await page.waitForFunction(
      (last) => {
        const text = document.getElementById('stats')?.textContent ?? '';
        return last !== text && text.includes('mesh canvases') && !text.includes("realloc'd");
      },
      prev,
      { timeout: 30_000 },
    );
    prev = (await stats.textContent()) ?? '';
  }
}

test('frozen test-rig scene: every mesh reuses its raster, nothing reallocates', async ({ page }) => {
  await page.goto('/?rig=glow&anim=burn&count=10&dpr=1&timescale=0');
  const stats = page.locator('#stats');
  // 10 glow instances × 2 weighted meshes bent by a three-bone chain: once the
  // pose is held, the dirty-skip path must carry all 20 of them.
  await expect(stats).toContainText('mesh canvases 0 drawn (0 tris) / 20 reused');
  await expect(stats).not.toContainText("realloc'd");
});

test('running test-rig scene: grow-only mesh backing reaches a realloc-free steady state', async ({
  page,
}) => {
  await page.goto('/?rig=glow&anim=burn&count=10&dpr=1');
  await realloclessTicks(page);
});

test('mask scene: the clipping attachment is applied, none skipped', async ({ page }) => {
  // The figure test rig's `mask` animation shows one clipping attachment, a
  // part mask over its back half and torso. It is applied (see
  // tests/clipping.spec.ts for what "applied" is worth in pixels); here it only
  // has to be *visible* in the stats line, on the applied side of it.
  await page.goto('/?rig=figure&anim=mask&count=1&dpr=1&time=1.2&timescale=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText('1 clips applied');
  await expect(stats).not.toContainText('clips skipped');
});

test('mask scene with ?clipping=0: the clip is counted as skipped', async ({ page }) => {
  // The pre-0.6 behaviour is still reachable, and still says so in the same
  // words the stats line always used.
  await page.goto('/?rig=figure&anim=mask&count=1&dpr=1&time=1.2&timescale=0&clipping=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText(/\d+ clips skipped/);
  await expect(stats).not.toContainText('clips applied');
});

/**
 * The corner order and the region-UV convention, pinned on the model side.
 *
 * The renderer reads corners off the frame, which the package's adapter takes
 * from rig-c's pose (`RawDrawn.vertices` of a region — `Quad.world` in rigc
 * states the order bl, ul, ur, br, and rig-c's own gate holds it to
 * spine-core's `computeWorldVertices` at tolerance 0). So this is the
 * convention at the near end of that chain: the `turned` test rig poses two
 * 2 × 1 regions on its root at the identity — `s` packed straight at (4, 4) of
 * an 8 × 8 page, `r` packed turned 90° at (1, 2), occupying 1 × 2 — and every
 * number below is written by hand from those sizes and that placement, never
 * from code. If a rig-c upgrade ever reordered the corners, every rigid slot
 * would render skewed; this goes red first, and the doubt is a rigc issue.
 */

/**
 * A 2×1 region under the identity: the four corners around its centre, in
 * BL, UL, UR, BR order (Y up). Packing is a fact about the page, not about the
 * pose, so both regions come out here.
 */
const CORNERS = [-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5];

/**
 * The corners as posed, against `CORNERS`, to 5e-8. Not exact, and not by
 * accident: the runtime spells an unrotated bone's `b` as cos 90° at its pi,
 * −2.3e-8 (rigc's AUTHORING §3.1, *bounding box*), and rig-c poses the root
 * exactly as the runtime does, so each x carries `b · y` — 1.2e-8 here. That
 * residue is three orders of magnitude under the smallest gap between any two
 * corners of `CORNERS` (1), so no reordering, transpose or mirror passes.
 */
function expectCorners(actual: number[]): void {
  expect(actual).toHaveLength(CORNERS.length);
  CORNERS.forEach((value, i) => expect(actual[i], `corner value ${i}`).toBeCloseTo(value, 7));
}

test('region corner order stays BL, UL, UR, BR', async ({ page }) => {
  // The renderer derives its CSS matrix from three of the four corners a
  // frame carries, assuming the order BL, UL, UR, BR.
  await openHarness(page);
  const probe = await page.evaluate(() => window.rigPlayHarness.regionGeometryProbe());

  // rig-c's pose, and the frame the adapter hands the renderer, both.
  expectCorners(probe.straight.drawn);
  expectCorners(probe.straight.corners);
  // The straight region's UVs, in that order: u = 4/8, v = 4/8,
  // u2 = (4 + 2)/8, v2 = (4 + 1)/8 → (u, v2)=BL, (u, v)=UL, (u2, v)=UR, (u2, v2)=BR.
  expect(probe.straight.uvs).toEqual([0.5, 0.625, 0.5, 0.5, 0.75, 0.5, 0.75, 0.625]);
});

test("a turned region's artwork top-left is the packed rect's bottom-left", async ({ page }) => {
  // The other half of the same read, and the source the rigid cut's rotation is
  // derived from (#49): the corner *order* is BL, UL, UR, BR (above), and these
  // are the UVs that order carries when the packer stored the region turned.
  // Written down here, by hand, because the cut must never derive its transform
  // from itself — a reference that shares the convention agrees with the code
  // under test whichever way both are wrong.
  //
  // u = 1/8, v = 2/8, and the rect is 1 × 2 on the page, so u2 = (1 + 1)/8,
  // v2 = (2 + 2)/8. BL (u2, v2), UL (u, v2), UR (u, v), BR (u2, v): the
  // artwork's top-left corner (UL) carries the packed rect's near u and its far
  // v — the rect's bottom-left — and the artwork's top edge, UL → UR, runs *up*
  // the rect's left edge. Unpacking such a rect is therefore a clockwise turn,
  // which is what `cutRegion` in src/DomTexture.ts does and writes out.
  await openHarness(page);
  const probe = await page.evaluate(() => window.rigPlayHarness.regionGeometryProbe());

  expect(probe.rotated.uvs).toEqual([0.25, 0.5, 0.125, 0.5, 0.125, 0.25, 0.25, 0.25]);
  // Packing is a fact about the page, not about the pose: the same corners
  // come out in world space either way, only the texels they carry move.
  expectCorners(probe.rotated.drawn);
  expectCorners(probe.rotated.corners);
});
