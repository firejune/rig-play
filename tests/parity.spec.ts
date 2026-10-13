import { writeFileSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

import { CHANNEL_TOLERANCE, diffInPage } from './pixelDiff';

/**
 * Backend A/B visual parity — the core rendering test.
 *
 * Strategy: NO golden snapshot files (they rot across platforms/GPUs).
 * Within one run and one engine, the same deterministic pose (?time seeks,
 * ?timescale=0 freezes) is screenshotted with both mesh raster backends and
 * the two buffers are diffed directly. Everything platform-specific (fonts,
 * GPU, AA flavor) cancels out; what remains is exactly the difference
 * between the canvas2d and webgl mesh rasterizers — missing parts, wrong
 * colors, seams.
 *
 * Expected residual: the backends legitimately differ by sub-pixel amounts
 * (canvas2d closes seams with a 0.5px clip overdraw, and the two rasterizers
 * antialias edges differently), which shows up as speckle on high-contrast
 * texture detail. The diff is therefore shift-tolerant — a pixel is only
 * "bad" with no in-tolerance match in the other image's 3×3 neighborhood —
 * and budgets are measured against drawn content, not the mostly-empty stage.
 *
 * Until 2026-08 the dominant residual was neither of those: the canvas2d path
 * addressed texels as `uv * (size - 1)` against GL's `uv * size`, a systematic
 * sub-texel offset over the whole page. Removing it (issue #1) dropped the
 * floor by 15–250× depending on the cell, and the limits with it — every
 * number on the constants below is post-fix.
 *
 * Hairline seam cracks (calibrated at 0.07–0.20% of content) no longer sit
 * below the noise floor, but they still sit below any limit this diff can
 * carry, so seams keep their own deterministic canary at the bottom of this
 * file instead of a screenshot threshold: with a frozen pose and one engine,
 * `?expand=0` must change the canvas2d raster — if the overdraw ever dies, the
 * two captures become bit-identical. (The GL path needs no overdraw:
 * adjacent triangles index the same vertex array entries, so shared edges
 * are watertight by construction.)
 *
 * ## PARITY_DUMP=1 — the counts made visible
 *
 * The counts below say how many pixels disagree; they never say WHERE. Bad
 * pixels on silhouettes, inside the additive glow, or spread over the fill
 * point at different causes, and the platform that had residue to explain
 * (linux WebKit) exists only on the CI runner. So the environment variable
 * `PARITY_DUMP=1` turns every parity cell into an instrument. It writes, into
 * the test's output directory (and attaches, so artifact uploads and reporters
 * both find them):
 *
 * - `a-canvas2d.png` / `b-webgl.png` — the two captures exactly as taken, not
 *   re-captured: the bytes that were diffed.
 * - `diff-mask.png` — same dimensions, a dimmed greyscale of capture A as the
 *   backdrop (so the silhouette is readable), every shift-tolerant bad pixel
 *   painted pure red, and every raw-bad pixel that the 3×3 match rescued
 *   painted yellow.
 * - `metrics.json` — the numbers of the log line, plus project, scene and
 *   platform.
 *
 * The mask is painted by the SAME pass that counts, so red === `bad` and
 * red + yellow === `rawBad` by construction; the dump branch asserts exactly
 * that, which is the instrument's self-check (a mask drawn from the wrong set
 * fails it). Greys can never collide with the two markers: the backdrop is
 * dimmed to ≤ 115 per channel and has r === g === b.
 *
 * Without `PARITY_DUMP=1` nothing above happens — no mask is computed in the
 * page, no file is written, and the assertions and log lines are the ones that
 * have always run. This switch is an instrument, not a threshold.
 *
 * It has already paid for itself: the mask read on the CI runner put linux
 * WebKit's long-standing residue on whole triangles of the head, goggles and
 * foot meshes rather than on edges, which is what identified the canvas2d
 * backend as the broken side and retired that platform's looser limit — see
 * BAD_RATIO_LIMIT.
 */

const POSE = 'time=1.2&timescale=0&count=1&dpr=1';

/** The demo — every scene is a rig built by `rigc build`, posed by rig-c/core through RigPlayer. */
const DEMO = '/';

/**
 * Scenes cover the element-level features both backends must agree on. The
 * test-rig scenes (tests/rigs/) carry what no gallery build does — additive
 * blend, clipping — and the whole-rig tint; the gallery scenes put contour,
 * grid and deform meshes under the same two backends, one part per page and
 * packed. Every scene goes through the model path: loadModel, RigPlayer, the
 * frame adapter.
 */
const SCENES = [
  // Additive slots (halo, flame, sparks) → mix-blend-mode: plus-lighter, over
  // two weighted meshes the flame chain bends triangle by triangle.
  { name: 'glow (additive glow)', kind: 'test', query: `rig=glow&anim=burn&${POSE}` },
  // A clipping attachment over the walking figure, applied as a per-element
  // clip-path. Clipping is element-level, so it must land identically on both
  // backends.
  { name: 'figure mask (clipping)', kind: 'test', query: `rig=figure&anim=mask&${POSE}` },
  // Whole-rig tint rides the feColorMatrix filter on <img> and <canvas>.
  { name: 'figure walk (tint filter)', kind: 'test', query: `rig=figure&anim=walk&tint=ff9060&${POSE}` },
  // Contour meshes waved by bones and rippled by a deform.
  { name: 'gallery flex (contour meshes)', kind: 'gallery', query: `rig=flex&anim=wave&${POSE}` },
  // The same rig packed: every mesh samples a shared page through page UVs.
  { name: 'gallery flex, packed (shared page)', kind: 'gallery', query: `rig=flex-packed&anim=wave&${POSE}` },
  // A deform-squashed mesh with slot rgba keys, under the player's tint.
  { name: 'gallery squash (deform + tint)', kind: 'gallery', query: `rig=squash&anim=bounce&tint=ff9060&${POSE}` },
  // Grid meshes keyed as a projection, and a depth-mapped face under sliders.
  { name: 'gallery portrait (deform projection)', kind: 'gallery', query: `rig=portrait&anim=turn&${POSE}` },
  { name: 'gallery look, packed (sliders, physics)', kind: 'gallery', query: `rig=look-packed&anim=turn&${POSE}` },
] as const;

/**
 * Bad (shift-tolerant, see below) pixels allowed, as a fraction of the union
 * of drawn-content pixels. Recalibrated 2026-08-22 after the texel-addressing
 * fix, on macOS (chromium 1234 / webkit 2336): honest backend noise now
 * measures 0.000–0.011% on chromium and 0.025–0.049% on webkit (it was
 * 0.29–1.30% before the fix), while a dropped tint still scores ~87% and a
 * blanked mesh its full area share.
 *
 * 0.005 keeps ~10× headroom over the worst floor. Ten, not the previous ~3×,
 * because the measured spread between raster flavors on one scene reaches
 * ~7.8× (pre-fix walk+tint: macOS WebKit 0.72% vs linux WebKit 5.59%) — a
 * limit under ~10× the floor would be one browser-raster change away from
 * red. Chromium's floor is platform-independent — ubuntu CI post-fix reads
 * 0.000% / 0.009% / 0.000%, matching macOS — so it keeps the strict limit
 * everywhere.
 *
 * Verified red, not just green: re-introducing the `- 1` texel offset takes
 * both hoverboard cells (1.25% / 1.29%) and webkit walk+tint (0.72%) past
 * this limit, so a relapse fails the suite.
 *
 * ## One limit, every project — there used to be two
 *
 * `BAD_RATIO_LIMIT_WEBKIT_LINUX = 0.13`, 26× looser, carried linux WebKit
 * alone, whose floors on ubuntu CI (run 32580117738, 2026-08-22,
 * post-texel-fix) read hoverboard 4.77%, walk+tint 4.32%, portal 0.53%
 * (contentMismatch ≤ 0.40%, seam canary rawBad=90). It was written up as a
 * noisier raster flavor, with additive blend and premultiplied alpha as the
 * unmeasured suspects.
 *
 * The evidence against that reading was already in the numbers: the texel fix
 * had halved this platform's raw diff (3422 → 1580 on hoverboard) while the
 * shift-tolerant count stood still (1049 → 1042), at maxDelta ~233. Pixels with
 * no in-tolerance match anywhere in the other backend's 3×3 are not sub-pixel
 * noise. PARITY_DUMP put them on the map: whole triangles of the head, goggles
 * and foot meshes, carrying displaced texture, while the webgl capture of the
 * same pose was clean. The canvas2d backend was the broken side, and the
 * platform limit had been absorbing a rendering bug for months.
 *
 * What triggers it is drawing the WHOLE atlas page under each triangle's steep
 * affine; drawing a source sub-rect instead — same mapping, same texture-space
 * position, see drawTriangle — takes those floors to hoverboard 2 bad pixels
 * (0.009%, maxDelta 233 → 30), portal 4, walk+tint 3, with every Chromium
 * capture byte-identical. [measured on the ubuntu CI runner through
 * PARITY_DUMP: run 35209262693 with a fixed 2-texel pad, run 35213286993 with
 * the derived pad that shipped — identical counts, and the whole suite green
 * there under this one limit; the mechanism inside that rasterizer is still
 * not identified.]
 *
 * ## The scenes those numbers were read on are gone
 *
 * Every figure above (hoverboard, portal, walk + tint) was measured on Spine's
 * own example export, drawn through a spine-core skeleton. Since #63 the
 * repository links no Spine runtime and fetches no example asset, and the
 * three scenes are the test rigs' (tests/rigs/): glow (additive), figure mask
 * (clipping), figure walk + tint. MEASURED, macOS chromium 1234, one run:
 * 0.007% / 0.000% / 0.000%, maxDelta 36 / 15 / 7 — the floor the limit was
 * calibrated against, with the same ~10× and more. WebKit is not measured
 * locally (CI runs it), and the `- 1` relapse was not re-run on these scenes.
 */
/*
 * ## The gallery scenes sit much closer to it — measured, not yet re-calibrated
 *
 * The gallery scenes (added with the model path, #60) run under this same
 * limit, and their floors are an order of magnitude above the test rigs': macOS
 * chromium / webkit, flex 0.191% / 0.313%, flex packed 0.197% / 0.320%, look
 * packed 0.290% / 0.485%, squash and portrait 0.000%. The contour meshes'
 * hard outlines are where the two rasterizers' edge antialiasing disagrees.
 * That leaves webkit's look-packed cell 1.03× under the limit, and Linux WebKit
 * is unmeasured. The limit was not moved to make room: if a gallery cell
 * reddens, dump it (PARITY_DUMP=1) and read the mask — residue on outlines is
 * AA and calls for a gallery limit calibrated with mutants the way this one
 * was; residue on whole triangles is a defect.
 */
const BAD_RATIO_LIMIT = 0.005;
/**
 * Allowed relative difference in drawn-content pixel counts — the
 * missing-part guard. Measured noise ≤ 0.22%, except linux WebKit at ≤ 0.40%;
 * blanking even the smallest mesh of the Spine example export these limits
 * were first read on moved it past ~1.6%, a dropped tint ~6%. On the test
 * rigs (macOS chromium) the noise reads 0.000–0.038%.
 */
const CONTENT_MISMATCH_LIMIT = 0.015;

/** See the header: an on-demand instrument, never a threshold. */
const DUMP = process.env.PARITY_DUMP === '1';

/**
 * What this suite asks of the shared differ (`tests/pixelDiff.ts`): the demo
 * stage paints a floor strip along its bottom edge, which is backdrop and not
 * artwork, so it must not be counted as content.
 */
const PARITY_DIFF = { floorStrip: true } as const;

async function captureStage(
  page: Page,
  stage: string,
  query: string,
  backend: 'canvas2d' | 'webgl',
): Promise<Buffer> {
  await page.goto(`${stage}?${query}&backend=${backend}`);
  const stats = page.locator('#stats');
  // A frozen scene has settled when every mesh reuses its raster: the pose
  // (including any physics) has stopped moving, so the screenshot is
  // deterministic. Content-based wait — no arbitrary sleeps.
  await expect(stats).toContainText(/mesh canvases 0 drawn \(0 tris\) \/ \d+ reused/);
  if (backend === 'webgl') {
    // Guard the guard: if WebGL were unavailable this test would diff
    // canvas2d against itself and pass vacuously.
    await expect(stats).toContainText('· webgl');
    await expect(stats).not.toContainText('unavailable');
  }
  return page.locator('#stage').screenshot();
}

for (const scene of SCENES) {
  test(`canvas2d / webgl parity: ${scene.name}`, async ({ page }, testInfo) => {
    const canvas2d = await captureStage(page, DEMO, scene.query, 'canvas2d');
    const webgl = await captureStage(page, DEMO, scene.query, 'webgl');
    const m = await diffInPage(page, canvas2d, webgl, { ...PARITY_DIFF, withMask: DUMP });

    const badRatio = m.bad / Math.max(1, m.contentUnion);
    const contentMismatch =
      Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);
    // Always in the run log (CI included): the drift of these numbers over
    // time is the early signal, not just the pass/fail line.
    console.log(
      `[parity] ${testInfo.project.name} ${scene.name}: ${m.width}x${m.height}, ` +
        `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
        `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(3)}% of content, ` +
        `ch>${CHANNEL_TOLERANCE}), maxDelta=${m.maxDelta}, ` +
        `contentMismatch=${(contentMismatch * 100).toFixed(3)}%`,
    );
    if (badRatio > BAD_RATIO_LIMIT || contentMismatch > CONTENT_MISMATCH_LIMIT) {
      // Keep the pair on failure, for eyeballing the regression.
      writeFileSync(testInfo.outputPath('canvas2d.png'), canvas2d);
      writeFileSync(testInfo.outputPath('webgl.png'), webgl);
    }

    if (DUMP) {
      const mask = m.mask;
      if (!mask) throw new Error('PARITY_DUMP is set but the diff returned no mask');
      const files = {
        'a-canvas2d.png': canvas2d,
        'b-webgl.png': webgl,
        'diff-mask.png': Buffer.from(mask.pngBase64, 'base64'),
        'metrics.json': Buffer.from(
          `${JSON.stringify(
            {
              project: testInfo.project.name,
              scene: scene.name,
              platform: process.platform,
              width: m.width,
              height: m.height,
              contentA: m.contentA,
              contentB: m.contentB,
              contentUnion: m.contentUnion,
              bad: m.bad,
              badAB: m.badAB,
              badBA: m.badBA,
              rawBad: m.rawBad,
              maxDelta: m.maxDelta,
              channelTolerance: CHANNEL_TOLERANCE,
              badRatio,
              badRatioLimit: BAD_RATIO_LIMIT,
              contentMismatch,
              contentMismatchLimit: CONTENT_MISMATCH_LIMIT,
              maskDirection: mask.direction,
              maskRed: mask.red,
              maskYellow: mask.yellow,
            },
            null,
            2,
          )}\n`,
        ),
      };
      for (const [name, body] of Object.entries(files)) {
        const path = testInfo.outputPath(name);
        writeFileSync(path, body);
        await testInfo.attach(name, {
          path,
          contentType: name.endsWith('.png') ? 'image/png' : 'application/json',
        });
      }
      // The instrument's self-check (dump runs only). The mask is painted by
      // the counting pass, so a mask that disagrees with the counts means the
      // picture is lying about which pixels the numbers are made of — the one
      // failure mode that would send the reader of these images after the
      // wrong cause.
      expect(mask.red).toBe(m.bad);
      expect(mask.red + mask.yellow).toBe(m.rawBad);
    }

    // The scene must actually draw something — a blank stage would "match".
    expect(m.contentUnion).toBeGreaterThan(5000);
    // Sub-pixel sampling differences are expected (and absorbed); missing
    // parts and wrong colors blow past these limits (calibrated: a dropped
    // tint scores ~87% bad, a blanked mesh shifts content by its area).
    expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  });
}

// --- dom vs canvas: the two render modes -----------------------------------

/*
 * The canvas render mode (`?mode=canvas`, `CanvasRenderer`) draws the same
 * frame as the DOM tier through a different machine: every slot as GL
 * triangles from its atlas page into one canvas, against `<img>` cuts under CSS
 * matrices, per-part canvases, `feColorMatrix` tints, `mix-blend-mode` and
 * `clip-path`. So these cells are a different comparison from the backend A/B
 * above: two different rasterizers of one picture, whose residue is
 * antialiasing and texture filtering and lives on silhouettes. They run on the
 * same frozen poses as the cells above, with the DOM side on its default
 * webgl mesh backend (canvas2d until #109; the canvas2d / webgl cells above
 * hold the other backend to it), and measure the same two ratios of drawn
 * content.
 *
 * They are the repository's picture gate: the two render modes draw the same
 * picture, within the bounds below. Nothing here is compared with a Spine
 * runtime — the pose both modes draw is rig-c's, held to spine-core at
 * tolerance 0 by rig-c's own gate, and a pose doubt is a rigc issue.
 */

/** Waits for a frozen scene to settle in either mode, then captures the stage. */
async function captureMode(page: Page, stage: string, query: string, mode: 'dom' | 'canvas'): Promise<Buffer> {
  if (mode === 'dom') return captureStage(page, stage, query, 'webgl');
  await page.goto(`${stage}?${query}&mode=canvas`);
  const stats = page.locator('#stats');
  // Settled when the record stopped changing: the frame is reused, not redrawn.
  await expect(stats).toContainText(/frames 0 drawn \/ \d+ reused/);
  // Guard the guard: a canvas cell that fell back to canvas2d would be
  // measuring the fallback, which is not the mode's path.
  await expect(stats).toContainText('· webgl');
  await expect(stats).not.toContainText('fallback');
  return page.locator('#stage').screenshot();
}

/**
 * Shift-tolerant bad pixels allowed between the two modes, as a fraction of
 * drawn content — one limit for the test-rig scenes and one for the gallery
 * scenes, because their floors sit a factor of ~2–3 apart (the contour meshes'
 * hard outlines are where two rasterizers' edge antialiasing disagrees, as the
 * backend cells above found too).
 *
 * MEASURED, macOS, chromium 1234 / webkit 2336, one run per cell:
 *
 * - gallery floor: flex 0.836% / 1.051%, flex packed 0.841% / 1.057%, squash
 *   0.762% / 0.209%, portrait 0.585% / 1.377%, look packed 0.952% / 1.553%;
 * - test-rig floor (chromium only — webkit is measured in CI): glow 0.007%,
 *   figure mask 0.524%, figure walk + tint 0.204%.
 *
 * Against those, mutants of the canvas mode (one source edit each, the run
 * repeated):
 *
 * - RGB tint dropped: figure walk + tint 77.0%, glow 8.4% (slot colours);
 *   gallery squash 64.7% / 66.5%;
 * - additive slots drawn as Normal: glow 4.2%;
 * - clipping never applied: figure mask 16.0%;
 * - the first mesh of each frame not drawn: glow 10.9%, figure mask 12.4%,
 *   figure walk + tint 7.3%; gallery look packed 8.8% / 9.4%, portrait
 *   6.5% / 7.3%, squash 4.3% / 3.7%, flex 2.17% / 2.32%.
 *
 * 0.015 on the test rigs is 2.9× over their worst chromium floor and 2.8×
 * under the quietest mutant of the feature each scene carries (additive on
 * glow).
 * 0.025 on the gallery is 1.6× over its worst floor and under every mutant but
 * the missing mesh on flex (2.2–2.3%), which portrait, look and squash catch.
 * (Until #63 the first limit was calibrated on the Spine example export —
 * floors 0.178–0.606%, the same 0.015.) That margin is what two rasterizers
 * leave; Linux is unmeasured.
 */
const MODE_BAD_RATIO_LIMIT_TEST_RIGS = 0.015;
const MODE_BAD_RATIO_LIMIT_GALLERY = 0.025;
/**
 * The missing-part guard between the modes. MEASURED floor 0.000–1.401% (the
 * top was chromium's walk + tint on the Spine example export; webkit read
 * 0.157% there); the test rigs read 0.030–1.029% (glow's additive halo) and
 * the gallery 0.000–0.507%. The clip mutant moves it to 23.9% and the missing
 * mesh to 10.8–11.3% on the figure scenes. 0.03 is 2.1× over the worst floor
 * ever read. A missing mesh does not reliably move it everywhere (glow:
 * 0.17%), which is the bad-ratio limit's job.
 */
const MODE_CONTENT_MISMATCH_LIMIT = 0.03;

for (const scene of SCENES) {
  test(`dom / canvas parity: ${scene.name}`, async ({ page }, testInfo) => {
    const dom = await captureMode(page, DEMO, scene.query, 'dom');
    const canvas = await captureMode(page, DEMO, scene.query, 'canvas');
    const m = await diffInPage(page, dom, canvas, { ...PARITY_DIFF, withMask: DUMP });
    const MODE_BAD_RATIO_LIMIT = scene.kind === 'gallery' ? MODE_BAD_RATIO_LIMIT_GALLERY : MODE_BAD_RATIO_LIMIT_TEST_RIGS;
    const badRatio = m.bad / Math.max(1, m.contentUnion);
    const contentMismatch = Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);
    console.log(
      `[parity] ${testInfo.project.name} dom/canvas ${scene.name}: ${m.width}x${m.height}, ` +
        `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
        `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(3)}% of content, ` +
        `ch>${CHANNEL_TOLERANCE}), maxDelta=${m.maxDelta}, ` +
        `contentMismatch=${(contentMismatch * 100).toFixed(3)}% ` +
        `(limits ${(MODE_BAD_RATIO_LIMIT * 100).toFixed(1)}% / ${(MODE_CONTENT_MISMATCH_LIMIT * 100).toFixed(1)}%)`,
    );
    if (DUMP || badRatio > MODE_BAD_RATIO_LIMIT || contentMismatch > MODE_CONTENT_MISMATCH_LIMIT) {
      writeFileSync(testInfo.outputPath('a-dom.png'), dom);
      writeFileSync(testInfo.outputPath('b-canvas.png'), canvas);
      if (m.mask) writeFileSync(testInfo.outputPath('diff-mask.png'), Buffer.from(m.mask.pngBase64, 'base64'));
    }
    expect(m.contentUnion).toBeGreaterThan(5000);
    expect(badRatio).toBeLessThanOrEqual(MODE_BAD_RATIO_LIMIT);
    expect(contentMismatch).toBeLessThanOrEqual(MODE_CONTENT_MISMATCH_LIMIT);
  });
}

test('seam canary: the canvas2d crack-closing overdraw is alive', async ({ page }) => {
  // Hairline cracks are below the A/B noise floor (see header), so the seam
  // guard is exact instead of statistical: same engine, same frozen pose,
  // canvas2d with and without the 0.5px clip expansion. The renders are
  // fully deterministic, so if the overdraw stopped doing anything the two
  // captures would be bit-identical (rawBad = 0). Today they differ on the
  // ~half-pixel silhouette ring plus any engine clip-AA seams.
  const query = `rig=glow&anim=canary&${POSE}`;
  const withExpand = await captureStage(page, DEMO, query, 'canvas2d');
  const withoutExpand = await captureStage(page, DEMO, `${query}&expand=0`, 'canvas2d');
  const m = await diffInPage(page, withExpand, withoutExpand, PARITY_DIFF);
  console.log(`[parity] ${test.info().project.name} seam canary: rawBad=${m.rawBad}`);
  expect(m.rawBad).toBeGreaterThanOrEqual(10);
});

test('overdraw canary: the canvas2d source sub-rect tracks the clip expansion', async ({ page }) => {
  // The canvas2d path draws each triangle from a source sub-rect of the atlas
  // page instead of the whole page (see drawTriangle). The rect is *derived*:
  // the clip polygon — the triangle expanded outward by triangleExpand canvas
  // px — is carried back into texture space through the inverse of the
  // per-triangle affine, and that bbox plus a texel of bilinear support is what
  // gets drawn. Replace the derivation with a fixed pad and the rect stops
  // following the expansion: the rim of the overdraw draws nothing, which is
  // how the seams the overdraw exists to close come back.
  //
  // At the shipped expansion that has no signature — 0.5 px reaches ~0.26
  // texels on a typical triangle (measured across the 424 triangles of a Spine
  // example export's meshes: ~0.26 median, 8.6 on the most foreshortened one),
  // so any plausible fixed pad still covers it. So this canary drives the knob
  // instead, the way the seam canary above does: same engine, same frozen pose,
  // canvas2d at expand=32 against canvas2d at expand=8. Both renders are
  // deterministic, so the count is exact, not statistical.
  //
  // The scene is the glow rig's `canary` animation, which shows `plate`: a
  // slit ring of 46 triangles whose hull sits well inside its opaque art, so a
  // band drawn past the hull reveals texels — on the ring's inner edge inside
  // the mesh canvas, where the canvas's own bounds do not cut it off. A rect
  // that follows the expansion keeps both bands whole, and the captures differ
  // by the band's whole area: rawBad 4795 (macOS chromium). A fixed 2-texel pad
  // truncates both bands at the same few texels, so the two captures collapse
  // toward each other: 1350. The limit sits between the two populations, 1.9×
  // under the real floor and 1.85× over the mutant. (Until #63 the scene was a
  // Spine example export, read at 2758 against 661–714, under a limit of 1500,
  // which on the ring would sit only 1.11× over the mutant — hence the move to
  // the geometric middle of the new populations.) WebKit is measured in CI
  // only.
  const query = `rig=glow&anim=canary&${POSE}`;
  const wide = await captureStage(page, DEMO, `${query}&expand=32`, 'canvas2d');
  const narrow = await captureStage(page, DEMO, `${query}&expand=8`, 'canvas2d');
  const m = await diffInPage(page, wide, narrow, PARITY_DIFF);
  console.log(`[parity] ${test.info().project.name} overdraw canary: rawBad=${m.rawBad}`);
  expect(m.rawBad).toBeGreaterThanOrEqual(2500);
});
