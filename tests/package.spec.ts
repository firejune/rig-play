import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * What npm ships, checked the way a consumer meets it — node-side, no browser.
 *
 * The package is DOM-only at *run* time, but an *import* must succeed outside
 * a browser: anything that leaves spine-html external and hands it to Node (a
 * server-side render pass importing a module that imports it, a test runner in
 * a node environment, a plain script) resolves it with Node's ESM resolver,
 * which — unlike every bundler — requires an explicit file extension on a
 * relative specifier. That is issue #16: `dist/*.js` carried extensionless
 * specifiers and `import('spine-html')` died with ERR_MODULE_NOT_FOUND, while
 * the demo, the harness and every browser build resolved it fine.
 *
 * ⚠️ This spec must NEVER build into the repository's own `dist/`. During a
 * Playwright run `vite preview` is serving the demo out of `dist/`, and
 * `build:lib` starts with `rm -rf dist` — a lib build here would pull the
 * ground out from under every other spec in the same run. So the library is
 * built to a temp directory instead, and assembled there into a throwaway
 * installed-package layout (`node_modules/spine-html`, alone), which is
 * also the only way to exercise the `exports` map: resolution by *package
 * name* is the thing under test, and a relative import of `../dist/index.js`
 * would not touch `exports` at all.
 *
 * ## Self-contained, by construction and by test
 *
 * The package poses through `rig-c/core`, whose entry is TypeScript source — a
 * devDependency that no consumer has installed and no node would load from
 * `node_modules` if they had. So the build (`scripts/build-lib.mjs`) bundles
 * that closure into one `index.js`, and the sandbox below installs the built
 * package and **nothing else**: no rig-c, no spine-core. Every assertion that
 * imports or typechecks the package by name is therefore also the assertion
 * that it needs nothing beside it.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** The throwaway consumer directory; `node_modules/spine-html` lives under it. */
let sandbox = '';
/** The built package's `dist` inside that sandbox. */
let pkgDist = '';
/**
 * `process.execPath` is the node that runs the Playwright worker — real node
 * even when the suite was launched through `bunx`, which only resolves the
 * CLI. It matters: bun's resolver accepts extensionless specifiers, so
 * spawning bun here would make every assertion below vacuous.
 */
function node(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

/**
 * Same, but concurrent — the two typecheck passes below are the slow part of
 * this file and they do not touch each other, so they run side by side.
 */
function nodeAsync(args: string[], cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, args, { cwd });
    let output = '';
    const collect = (chunk: unknown) => {
      output += String(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (status) => settle({ status, output }));
  });
}

/** Writes a probe module into the sandbox and runs it there. */
function probe(name: string, source: string) {
  const file = resolve(sandbox, name);
  writeFileSync(file, source);
  return node([file], sandbox);
}

/** The two resolution modes a consumer can meet the shipped types through. */
const MODULE_MODES = {
  bundler: 'ESNext',
  nodenext: 'NodeNext',
} as const;
type ModuleMode = keyof typeof MODULE_MODES;

/** Writes `<name>.ts` plus a tsconfig for it in the sandbox and returns the path of the tsconfig. */
function writeConsumer(name: string, source: string, mode: ModuleMode): string {
  writeFileSync(resolve(sandbox, `${name}.ts`), source);
  const config = resolve(sandbox, `tsconfig.${name}.${mode}.json`);
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: MODULE_MODES[mode],
          moduleResolution: mode,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          // Deliberately NOT skipped. Measured: with skipLibCheck on, a
          // fully extensionless dist/ typechecks clean under nodenext too —
          // the TS2835s are raised inside the shipped .d.ts, and that is
          // precisely the file skipLibCheck stops reading. Turning it on
          // here would cost ~3× less time and catch nothing.
          skipLibCheck: false,
        },
        files: [`${name}.ts`],
      },
      null,
      2,
    ),
  );
  return config;
}

test.beforeAll(() => {
  sandbox = mkdtempSync(resolve(tmpdir(), 'spine-html-pkg-'));
  const pkgRoot = resolve(sandbox, 'node_modules', 'spine-html');
  pkgDist = resolve(pkgRoot, 'dist');
  mkdirSync(pkgRoot, { recursive: true });

  // One build, shared by every assertion in this file — the same script
  // `bun run build:lib` runs, into the sandbox instead of `dist/`.
  const built = node([resolve(repoRoot, 'scripts', 'build-lib.mjs'), pkgDist], repoRoot);
  expect(built.status, `scripts/build-lib.mjs failed:\n${built.stdout}${built.stderr}`).toBe(0);

  // The repository's real manifest, so the `exports` map under test is the
  // shipped one rather than a copy that can drift from it.
  cpSync(resolve(repoRoot, 'package.json'), resolve(pkgRoot, 'package.json'));

  // Makes the sandbox an ESM package of its own, so nothing above the temp
  // directory can decide how these probes are parsed.
  writeFileSync(
    resolve(sandbox, 'package.json'),
    `${JSON.stringify({ name: 'spine-html-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  // Nothing but the package is installed: the claim every import below rests on.
  expect(readdirSync(resolve(sandbox, 'node_modules'))).toEqual(['spine-html']);
});

test.afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('the package entry resolves by name in node and exposes its public API', () => {
  const run = probe(
    'probe-index.mjs',
    "const m = await import('spine-html');\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n",
  );
  expect(run.status, `import('spine-html') failed:\n${run.stderr}`).toBe(0);
  // Exhaustive on purpose: what the root entry exports is the package's API.
  expect(JSON.parse(run.stdout)).toEqual([
    'DomRenderer',
    'RigPlayer',
    'loadModel',
    'revokeRegions',
    'unpackRegions',
  ]);
});

test('the binary subpath is gone: the package reads compiled models, not Spine exports', () => {
  const run = probe(
    'probe-binary.mjs',
    "try {\n  await import('spine-html/binary');\n  console.log(JSON.stringify({ code: 'RESOLVED' }));\n} catch (error) {\n  console.log(JSON.stringify({ code: error.code }));\n}\n",
  );
  expect(run.status, `probe crashed:\n${run.stderr}`).toBe(0);
  expect(JSON.parse(run.stdout).code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('an unlisted subpath is refused by the exports map', () => {
  // The control for the two tests above: it is the `exports` map they are
  // going through, not a bare directory walk that would resolve anything.
  const run = probe(
    'probe-subpath.mjs',
    "try {\n  await import('spine-html/dist/index.js');\n  console.log(JSON.stringify({ code: 'RESOLVED' }));\n} catch (error) {\n  console.log(JSON.stringify({ code: error.code }));\n}\n",
  );
  expect(run.status, `probe crashed:\n${run.stderr}`).toBe(0);
  expect(JSON.parse(run.stdout).code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
});

/**
 * What the library build is supposed to emit — the whole of `dist/`, which is
 * the whole of what `files` ships apart from NOTICE.md: one bundled module
 * (with its map), and one declaration file (with its map) per source module.
 */
const EMITTED_BUNDLE = ['index.js', 'index.js.map'];
const DECLARED_MODULES = ['DomRenderer', 'DomTexture', 'MeshGlBlitter', 'index', 'loadModel', 'player', 'posedFrame'];

test('the library build emits those modules and nothing else', () => {
  /**
   * Issue #24: `tsconfig.build.json` compiles `src/**` and the demo's entry
   * point lives there too, so `dist/main.js` (11 kB) + `.d.ts` + both maps
   * rode into the published 0.4.1 and 0.5.0 tarballs. Nothing could reach
   * them — `main` is not a key in the `exports` map and no shipped module
   * imports it — which is exactly why every other assertion in this file
   * stayed green over two releases while 11 kB of the 76 kB of JavaScript in
   * the tarball was dead weight, and the one file in `dist/` whose top level
   * touched the DOM. Unreachable is not a signature, so the guard has to be
   * the emitted list itself, not anything a resolver or an import walk sees.
   *
   * Recursive, so a stray that lands in a subdirectory is caught too — `dist/`
   * being flat is part of what ships.
   */
  const emitted = readdirSync(pkgDist, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .sort();

  // The defect itself, named first, so its return reds out on the assertion
  // that explains it rather than on the set comparison below.
  expect(emitted.filter((file) => /(^|\/)main\./.test(file))).toEqual([]);

  // The payload, as an explicit set: the next file to wander in fails here
  // instead of shipping unnoticed for two more releases. One module — the
  // bundle — and types plus their maps for every source module, which also
  // pins `declaration` / `declarationMap` / `sourcemap` staying on.
  expect(emitted.filter((file) => file.endsWith('.js'))).toEqual(['index.js']);
  expect(emitted).toEqual(
    [...EMITTED_BUNDLE, ...DECLARED_MODULES.flatMap((name) => [`${name}.d.ts`, `${name}.d.ts.map`])].sort(),
  );
});

test('nothing the package ships names a Spine runtime', () => {
  /**
   * The package reads no Spine runtime: it poses through `rig-c/core`. But
   * `@esotericsoftware/spine-core` and `spine-webgl` are both still installed
   * here — the oracle, the frame gate and the renderer specs read Spine
   * exports — and either would ride into the bundle on one import written in
   * `src/` by mistake, with no other signature: vite would inline it into
   * `index.js` and the emitted file set would not change. So the assertion is
   * on the shipped bytes, every module and every `.d.ts`, comments stripped.
   *
   * `@esotericsoftware/spine-webgl` is a **development** dependency: the pixel
   * oracle draws the same skeleton with it and diffs the two pictures
   * (tests/oracle.spec.ts), and the benchmark page puts them side by side. A
   * consumer must never carry it — it is a second full runtime, under the Spine
   * Runtimes License, and it is not in `dependencies` or `peerDependencies`.
   *
   * What makes that worth a machine rather than a review note is where the
   * reference code sits: `tests/` imports from `src/`, and one import written
   * the other way round would put a whole runtime into `dist/` with no other
   * signature — `tsconfig.build.json` compiles all of `src/`, and the emitted
   * file set above would not change, because the specifier would ride inside a
   * file that is already on the list. So the assertion is on the shipped bytes
   * themselves, every emitted module and every emitted `.d.ts`, comments
   * stripped so a mention in prose is not a false red.
   */
  const emitted = readdirSync(pkgDist, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));
  const naming = emitted.filter((file) =>
    /@esotericsoftware\//.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))),
  );
  expect(naming).toEqual([]);
  // A class the runtime defines and nothing here does, in case a bundler ever
  // inlined the code without its package name.
  const runtimeCode = emitted.filter((file) =>
    /\bSkeletonJson\b|\bAnimationStateData\b/.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))),
  );
  expect(runtimeCode).toEqual([]);

  // Control: it is installed and resolvable here, so the assertion above means
  // "kept out of the package", not "absent from the machine".
  expect(existsSync(resolve(repoRoot, 'node_modules', '@esotericsoftware', 'spine-webgl'))).toBe(
    true,
  );
  expect(existsSync(resolve(repoRoot, 'node_modules', '@esotericsoftware', 'spine-core'))).toBe(true);

  // And it is declared in neither of the two fields a consumer installs from.
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@esotericsoftware/spine-webgl');
  expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain(
    '@esotericsoftware/spine-webgl',
  );
  expect(Object.keys(manifest.devDependencies ?? {})).toContain('@esotericsoftware/spine-webgl');
});

/** Strips `//` and `/* *\/` comments without eating string or template contents. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Module specifiers of every static import / re-export in `code`. */
function specifiers(code: string): string[] {
  const pattern =
    /(?:\bimport\b|\bexport\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  return [...code.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

interface GraphNode {
  file: string;
  /** Comment-stripped source: what the bundler sees, not what a grep sees. */
  code: string;
  relative: { spec: string; target: string | null }[];
}

/**
 * Transitive relative-import graph of `entry`, resolved the way node's ESM
 * resolver does it: a relative specifier is a path, taken literally, with no
 * extension guessing. So an extensionless specifier shows up here as
 * unresolved — the same fact node reports as ERR_MODULE_NOT_FOUND.
 */
function walkGraph(entry: string): Map<string, GraphNode> {
  const seen = new Map<string, GraphNode>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    const graphNode: GraphNode = { file, code, relative: [] };
    for (const spec of specifiers(code)) {
      if (!spec.startsWith('.')) continue;
      const path = resolve(dirname(file), spec);
      const target = existsSync(path) ? path : null;
      graphNode.relative.push({ spec, target });
      if (target) queue.push(target);
    }
    seen.set(file, graphNode);
  }
  return seen;
}

test('the bundle imports nothing: rig-c/core is inside it, and no node built-in is reached', () => {
  // rig-c's `./core` entry is TypeScript source in a devDependency — a
  // consumer has neither. So the bundle must carry the core's closure rather
  // than import it, and must import nothing else either: a bare specifier left
  // in `index.js` is a package the consumer was never told to install.
  const graph = walkGraph(resolve(pkgDist, 'index.js'));
  const name = (file: string) => relative(pkgDist, file);
  expect([...graph.keys()].map(name)).toEqual(['index.js']);
  const code = (graph.values().next().value as GraphNode).code;
  expect(specifiers(code)).toEqual([]);
  expect(/\bimport\s*\(/.test(code)).toBe(false);
  // rig-c states its core links no `node:` module; a browser bundle is held to it.
  expect(code).not.toMatch(/['"]node:/);
  // And the core really is inside: `openTrack` is what the player steps.
  expect(code).toContain('function openTrack');
  // The shipped types name nothing a consumer does not have — the adapter's
  // rig-c types are `@internal` and stripped (tsconfig.build.json).
  const declarations = readdirSync(pkgDist).filter((file) => file.endsWith('.d.ts'));
  const namingRigc = declarations.filter((file) => /rig-c/.test(stripComments(readFileSync(resolve(pkgDist, file), 'utf8'))));
  expect(namingRigc).toEqual([]);
});

/**
 * The consumer both typecheck modes compile: every name the `exports` map
 * offers, reached by package name through the shipped `.d.ts`.
 */
const CONSUMER_SOURCE = [
  "import { DomRenderer, loadModel, revokeRegions, RigPlayer, unpackRegions } from 'spine-html';",
  "import type { ModelAssets, PosedFrame, PosedSlot, RigPlayerOptions } from 'spine-html';",
  'export const surface = [DomRenderer, RigPlayer, loadModel, unpackRegions, revokeRegions];',
  'export function draw(renderer: DomRenderer, frame: PosedFrame): PosedSlot[] { renderer.render(frame); return frame.order; }',
  'export function play(root: HTMLElement, assets: ModelAssets, options: RigPlayerOptions): RigPlayer { const p = new RigPlayer(root, assets, options); p.play(assets.animations[0].name, { loop: true }); return p; }',
  '',
].join('\n');

test('the emitted types resolve under bundler', async () => {
  const result = await nodeAsync(
    [tscBin, '--noEmit', '-p', writeConsumer('consumer', CONSUMER_SOURCE, 'bundler')],
    sandbox,
  );
  expect(result.status, `tsc under moduleResolution=bundler failed:\n${result.output}`).toBe(0);
});

test('the emitted types resolve under nodenext', async () => {
  // The .js in the source specifiers has to survive into the .d.ts too: a
  // node16/nodenext consumer resolves `./DomTexture.js` to `./DomTexture.d.ts`
  // and rejects the extensionless form with TS2835.
  const result = await nodeAsync(
    [tscBin, '--noEmit', '-p', writeConsumer('consumer', CONSUMER_SOURCE, 'nodenext')],
    sandbox,
  );
  expect(result.status, `tsc under moduleResolution=nodenext failed:\n${result.output}`).toBe(0);
});
