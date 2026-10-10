import { defineConfig } from 'vite';

/**
 * Two build entries:
 *
 * - `index.html` — the demo (and the perf oracle; see README).
 * - `tests/harness.html` — a browser test harness that exposes the loading
 *   path (loadModel / unpackRegions / revokeRegions) and the renderer probes
 *   to Playwright, so tests can call the library directly instead of
 *   inferring it from the demo's stats line.
 * - `tests/spine-stage.html` — the spineboy stage: the demo's frame loop over
 *   spine-core skeletons, for the parity and invariant scenes no rigc gallery
 *   build carries (additive blend, clipping).
 *
 * None of them is what npm ships: the package is built by
 * `scripts/build-lib.mjs` (`bun run build:lib`) from `src/index.ts`.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        demo: 'index.html',
        harness: 'tests/harness.html',
        spineStage: 'tests/spine-stage.html',
      },
    },
  },
});
