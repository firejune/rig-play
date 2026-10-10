import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The benchmark page is its own vite project, not a third entry in the root
 * config: `vite.config.ts` at the root builds what gets deployed — the demo,
 * plus the test harness — and a page nobody deploys should cost the deploy
 * nothing, so `bun run build` emits exactly what it emits without it.
 *
 * Run it with `bun run bench:dev`, or let `scripts/bench.mjs` start it.
 */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  // The rigc builds live in the repository's own public/rigs/ (built by
  // scripts/fetch-assets.sh), shared with the demo rather than copied.
  // `BENCH_CORPUS` swaps that directory for a local one holding rigc builds of
  // real-world rigs (`scripts/bench.mjs --corpus`), which is the whole of the
  // corpus mechanism: the page takes a model URL by query and needs to know
  // nothing else.
  publicDir: process.env.BENCH_CORPUS || fileURLToPath(new URL('../public', import.meta.url)),
  server: {
    fs: {
      // The page imports the library from ../src, which is outside this root.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist-bench', import.meta.url)),
    emptyOutDir: true,
  },
});
