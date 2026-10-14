import { defineConfig } from 'vite';

/**
 * Three build entries:
 *
 * - `index.html` — the demo (and the perf oracle; see README). `?rig=` also
 *   reaches the repository's test rigs (tests/rigs/), which the parity and
 *   invariant scenes draw.
 * - `wind.html` — the wind page (#124): a rig named by `?model=` under wind
 *   and gravity sliders, dragged to move it.
 * - `tests/harness.html` — a browser test harness that exposes the loading
 *   path (loadModel / unpackRegions / revokeRegions) and the renderer probes
 *   to Playwright, so tests can call the library directly instead of
 *   inferring it from the demo's stats line.
 *
 * Neither is what npm ships: the package is built by `scripts/build-lib.mjs`
 * (`bun run build:lib`) from `src/index.ts`.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        demo: 'index.html',
        wind: 'wind.html',
        harness: 'tests/harness.html',
        oracle: 'tests/oracle.html',
      },
    },
  },
});
