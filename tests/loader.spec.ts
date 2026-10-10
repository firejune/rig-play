import { expect, test } from '@playwright/test';

/**
 * loadModel — the loader of a `rigc build` output.
 *
 * Driven through the harness page against the packed gallery build
 * (`public/rigs/flex-packed/`), whose regions share a page, so every region is
 * cut and mints a blob URL — the ownership this file is about. (A one-part-
 * per-page build passes every page through and mints nothing.) It covers the
 * wiring: fetching the document, resolving page names against its directory,
 * loading the pages, unpacking the regions, drawing a frame from them, and
 * freeing them again — and the refusals: a Spine export by name, a document of
 * a spec the core does not read, a document or a page that never arrives.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
});

test('loads a model build and draws a frame from it', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.loaderProbe());

  expect(probe.spec).toBe('rigc-compiled/3');
  expect(probe.animations).toEqual(['wave', 'gust']);
  expect(probe.pageCount).toBeGreaterThan(0);
  expect(probe.regionCount).toBeGreaterThan(0);
  // Page images resolved against the document URL's directory (the default),
  // proven by the frame actually drawing: rigid slots as <img>, the deform
  // slots as per-part <canvas>.
  expect(probe.imageCount).toBeGreaterThan(0);
  expect(probe.canvasCount).toBeGreaterThan(0);
  expect(probe.rootChildrenAfterDispose).toBe(0);

  // dispose() frees exactly what the load minted — called twice, so a
  // non-idempotent implementation would show duplicates here.
  expect(probe.createdUrls.length).toBe(probe.regionCount);
  expect([...probe.revokedUrls].sort()).toEqual([...probe.createdUrls].sort());
  for (const url of probe.createdUrls) expect(probe.aliveAfter[url]).toBe(false);
});

test('a Spine export is refused by name, before anything is fetched', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.loaderFailureProbe());
  for (const refused of [probe.spineJson, probe.spineSkel]) {
    expect(refused.message).toContain('is a Spine export');
    expect(refused.message).toContain('rigc build');
    expect(refused.fetched).toEqual([]);
    expect(refused.createdUrls).toEqual([]);
  }
});

test('a document of a spec the core does not read is refused with its sentence', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.loaderFailureProbe());
  // readModel's own sentence, passed through, and what to do about it.
  expect(probe.foreignSpec.message).toContain('spec is "rigc-compiled/9", not "rigc-compiled/3"');
  expect(probe.foreignSpec.message).toContain('build it with `rigc build`');
  expect(probe.foreignSpec.createdUrls).toEqual([]);
});

test('a document or a page that never arrives leaves no blob URL behind', async ({ page }) => {
  const probe = await page.evaluate(() => window.rigPlayHarness.loaderFailureProbe());
  expect(probe.http.message).toContain('404');
  expect(probe.http.createdUrls).toEqual([]);
  // The document was read; a page failed before anything was cut.
  expect(probe.missingPage.message).toContain('Failed to load page image');
  expect(probe.missingPage.fetched.length).toBe(1);
  expect(probe.missingPage.createdUrls).toEqual([]);
  // A failure *during* the cuts is unpackRegions' own cleanup, held with the
  // cuts in flight by tests/regions.spec.ts.
});

test('one load, two players: regions are cut once and shared', async ({ page }) => {
  const shared = await page.evaluate(() => window.rigPlayHarness.sharedAssetsProbe());

  // Minted once, by the load; building and drawing players mints nothing.
  expect(shared.createdUrls.length).toBe(shared.regionCount);
  expect(shared.playerCreatedUrls).toEqual([]);
  expect(shared.firstElementCount).toBeGreaterThan(0);
  expect(shared.secondElementCount).toBe(shared.firstElementCount);
  expect(shared.secondCanvasCount).toBeGreaterThan(0);

  // A player owns none of the assets: disposing one leaves every bitmap alive
  // and the other player drawing.
  for (const url of shared.createdUrls) expect(shared.aliveAfterFirstDispose[url]).toBe(true);
  expect(shared.secondElementsAfterFirstDispose).toBe(shared.secondElementCount);

  // One dispose() for the assets, called twice: no duplicates, every URL dead.
  expect([...shared.revokedUrls].sort()).toEqual([...shared.createdUrls].sort());
  for (const url of shared.createdUrls) expect(shared.aliveAfter[url]).toBe(false);
});
