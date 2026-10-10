// Builds the npm package into one directory: `node scripts/build-lib.mjs <outDir>`.
//
// Two steps, because the package has to be self-contained and typed:
//
// 1. **The module** — vite in library mode bundles `src/index.ts` into one
//    `index.js` (+ map). `rig-c` is deliberately NOT external: its `./core`
//    entry points at TypeScript sources, which no consumer's node or bundler
//    is promised to read, and the package must import with nothing but itself
//    installed. So the core's closure (pure modules, no `node:` import — rig-c
//    holds that by name) is compiled into the bundle. Nothing else is
//    imported at all.
// 2. **The types** — `tsc -p tsconfig.build.json --emitDeclarationOnly`, one
//    `.d.ts` (+ map) per source module. `stripInternal` drops every
//    declaration marked `@internal` — the adapter's and the loader's helpers,
//    the only ones that name a rig-c type — so the shipped types name nothing a
//    consumer does not have.
//
// `tests/package.spec.ts` runs this into a temp directory and pins what it
// emits; `bun run build:lib` runs it into `dist/`.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv[2];
if (!outArg) {
  console.error('usage: node scripts/build-lib.mjs <outDir>');
  process.exit(2);
}
const outDir = resolve(process.cwd(), outArg);

await build({
  root,
  configFile: false,
  // The demo's public/ holds the fetched fixtures; none of it is the package.
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: resolve(root, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: { exports: 'named' },
    },
  },
});

const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const types = spawnSync(
  process.execPath,
  [tsc, '-p', resolve(root, 'tsconfig.build.json'), '--outDir', outDir],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(types.stdout);
process.stderr.write(types.stderr);
process.exit(types.status ?? 1);
