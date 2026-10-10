import { expect, type Page, test } from '@playwright/test';

/**
 * Deterministic counters and math invariants.
 *
 * Policy: never assert absolute milliseconds — timing numbers are
 * machine/headless-dependent (headless WebKit is a software rasterizer).
 * These tests only read deterministic counters from a #stats line: the demo's
 * (a rigc gallery build, posed by rig-c/core through RigPlayer) and the
 * spineboy stage's (`tests/spine-stage.html`, the same frame loop over
 * spine-core skeletons, which carries the clipping attachment no gallery build
 * has).
 *
 * The two spine-core invariants at the bottom construct spine-core objects,
 * which happens in `tests/harness.ts` and is reached through the browser.
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

test('frozen spineboy scene: every mesh reuses its raster, nothing reallocates', async ({ page }) => {
  await page.goto('/tests/spine-stage.html?skel=pro&anim=idle&count=10&dpr=1&timescale=0');
  const stats = page.locator('#stats');
  // 10 spineboy-pro instances × 8 mesh canvases: once the (physics-settled)
  // pose is static, the dirty-skip path must carry all 80 of them.
  await expect(stats).toContainText('mesh canvases 0 drawn (0 tris) / 80 reused');
  await expect(stats).not.toContainText("realloc'd");
});

test('running spineboy scene: grow-only mesh backing reaches a realloc-free steady state', async ({
  page,
}) => {
  await page.goto('/tests/spine-stage.html?skel=pro&anim=walk&count=10&dpr=1');
  await realloclessTicks(page);
});

test('portal scene: the clipping attachment is applied, none skipped', async ({ page }) => {
  // spineboy-pro's portal animation carries one clipping attachment, a part
  // mask over the character. It is applied now (see tests/clipping.spec.ts for
  // what "applied" is worth in pixels); here it only has to be *visible* in
  // the stats line, on the applied side of it.
  await page.goto('/tests/spine-stage.html?skel=pro&anim=portal&count=1&dpr=1&time=1.2&timescale=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText('1 clips applied');
  await expect(stats).not.toContainText('clips skipped');
});

test('portal scene with ?clipping=0: the clip is counted as skipped', async ({ page }) => {
  // The pre-0.6 behaviour is still reachable, and still says so in the same
  // words the stats line always used.
  await page.goto('/tests/spine-stage.html?skel=pro&anim=portal&count=1&dpr=1&time=1.2&timescale=0&clipping=0');
  const stats = page.locator('#stats');
  await expect(stats).toContainText(/\d+ clips skipped/);
  await expect(stats).not.toContainText('clips applied');
});

/**
 * The corner order and the rotated-region UV convention, pinned against
 * spine-core 4.3 itself. The renderer reads corners off the frame, which the
 * package's adapter takes from rig-c/core's pose — and `tests/frames.spec.ts`
 * holds those, at tolerance 0, to the corners spine-core computes. So this is
 * the convention at the far end of that chain: if spine-core ever reordered
 * its corners, the gate would follow it and this would say why.
 *
 * The construction lives in `tests/harness.ts`; what is below is the
 * expectation, which is the part that must not move.
 */

/**
 * A 2×1 region under identity transforms: the four corners around the centre,
 * in BL, UL, UR, BR order (Spine is Y-up).
 */
const CORNERS = [-1, -0.5, -1, 0.5, 1, 0.5, 1, -0.5];
/** The UV order that agrees with it: (u,v2)=BL, (u,v)=UL, (u2,v)=UR, (u2,v2)=BR. */
const UVS = [0, 1, 0, 0, 1, 0, 1, 1];

test('spine-core region corner order stays BL, UL, UR, BR', async ({ page }) => {
  // The renderer derives its CSS matrix from three of the four corners a
  // frame carries, assuming the order BL, UL, UR, BR — which is what
  // computeWorldVertices on 4.0.31, 4.1.56, 4.2.98, 4.2.120 and 4.3.13
  // actually produces, and what rig-c/core's pose holds to it (the
  // br/bl/ul/ur comments inside computeWorldVertices are stale; upstream
  // believes the order is BR, BL, UL, UR). If a spine-core upgrade ever
  // reorders the corners, every rigid slot would render skewed — this test
  // must go red first.
  await openHarness(page);
  const probe = await page.evaluate(() => window.rigPlayHarness.regionGeometryProbe());
  console.log(
    `[region-geometry] poseCore=${probe.poseCore} regionTakesSlot=${probe.regionTakesSlot} ` +
      `inverseClipping=${probe.inverseClipping}`,
  );

  expect(probe.straight.offset).toEqual(CORNERS);
  expect(probe.straight.uvs).toEqual(UVS);
  // And an identity bone pose preserves that order through
  // computeWorldVertices.
  expect(probe.straight.world).toEqual(CORNERS);
});

test("spine-core puts a rotated region's artwork top-left at the packed rect's bottom-left", async ({
  page,
}) => {
  // The other half of the same read, and the source the rigid cut's rotation is
  // derived from (#49): the corner *order* is BL, UL, UR, BR (above), and these
  // are the UVs that order carries when the packer stored the region turned.
  // Written down here, against whichever core is installed, because the cut
  // must never derive its transform from itself — a reference that shares the
  // convention agrees with the code under test whichever way both are wrong.
  //
  // BL (u2, v2), UL (u, v2), UR (u, v), BR (u2, v). So the artwork's top-left
  // corner (UL) carries the packed rect's near u and its far v — the rect's
  // bottom-left — and the artwork's top edge, UL → UR, runs *up* the rect's
  // left edge. Unpacking such a rect is therefore a clockwise turn, which is
  // what `cutRegion` in src/DomTexture.ts does and writes out.
  const ROTATED_UVS = [0.5, 0.875, 0.125, 0.875, 0.125, 0.25, 0.5, 0.25];

  await openHarness(page);
  const probe = await page.evaluate(() => window.rigPlayHarness.regionGeometryProbe());

  expect(probe.rotated.uvs).toEqual(ROTATED_UVS);
  // Packing is a fact about the page, not about the pose: the same corners
  // come out in world space either way, only the texels they carry move.
  expect(probe.rotated.offset).toEqual(CORNERS);
});
