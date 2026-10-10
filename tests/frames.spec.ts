import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The frame gate — the frame the renderer draws is the frame spine-core's
 * skeleton holds, at tolerance 0. Node-side, no browser.
 *
 * The package no longer reads a Spine runtime: it poses a rig's compiled model
 * document through `rig-c/core` and turns each pose into a `PosedFrame`
 * (`src/posedFrame.ts`). That adapter cannot be reviewed by looking at
 * pictures — a frame off by one corner of one region in one pose renders
 * "close enough" — so every gallery build is posed twice, from the two pairs
 * of files `rigc build` writes side by side, and the two frames are compared
 * field by field with `===` (see `tests/frameGate.ts` for both walks):
 *
 * - draw order and z, every region's name and four corners, every mesh's page,
 *   alpha convention, sequence frame, world vertices, page UVs and triangles,
 *   every slot's tint, dark colour, blend and clip polygon, which slots share
 *   a clip — and every region's page UVs, which the frame does not carry (the
 *   rigid tier draws a cut bitmap) but the cut stands for.
 *
 * `dt = 1/12`, every animation of every build, from pose 0 through enough
 * steps to cross the loop once and run half a cycle past it, so the wrap — the
 * one place a looping track's time is not a running sum — is inside the walk.
 * Each build is gated twice: as the gallery ships it, one page per part, where
 * every page UV is a whole page's, and packed (`<name>-packed`), where none is.
 *
 * What no gallery build reaches, it says: none clips, so the clip half of the
 * frame is held by the synthetic cover cases at the bottom (the adapter's walk
 * on hand-made poses) and by the renderer's own clipping specs over spineboy.
 *
 * The bundle: rig-c's `./core` entry is TypeScript source in `node_modules`,
 * which node refuses to strip, so `beforeAll` builds `tests/frameGate.ts` —
 * the adapter, the core, the spine-core reader — with vite into a scratch
 * directory under `node_modules/.cache` (spine-core left external, so it is the
 * installed one, resolved from there) and imports that.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RIGS = ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride'];
const BUILDS = RIGS.flatMap((rig) => [rig, `${rig}-packed`]);
const DT = 1 / 12;
/** Pose 0, then through the loop once and half a cycle past it (at least 12 steps). */
const steps = (duration: number): number => Math.max(12, Math.ceil((1.5 * duration) / DT));

type Gate = typeof import('./frameGate');
let gate: Gate;
let outDir = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Inside the repository's own node_modules, so the bundle's one external —
  // the installed spine-core — resolves from where it lands.
  const cache = resolve(repoRoot, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  outDir = mkdtempSync(resolve(cache, 'frame-gate-'));
  const { build } = await import('vite');
  await build({
    root: repoRoot,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      lib: { entry: resolve(repoRoot, 'tests/frameGate.ts'), formats: ['es'], fileName: () => 'gate.js' },
      rollupOptions: { external: [/^@esotericsoftware\//] },
    },
  });
  gate = (await import(pathToFileURL(resolve(outDir, 'gate.js')).href)) as Gate;
});

test.afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function filesOf(build: string) {
  const dir = resolve(repoRoot, 'public', 'rigs', build);
  return {
    model: readFileSync(resolve(dir, 'skeleton.model.json'), 'utf8'),
    skeleton: readFileSync(resolve(dir, 'skeleton.json'), 'utf8'),
    atlas: readFileSync(resolve(dir, 'skeleton.atlas'), 'utf8'),
  };
}

test('the fixtures are the gallery builds this gate names', () => {
  // A missing build would gate nothing and say nothing.
  for (const build of BUILDS) {
    expect(existsSync(resolve(repoRoot, 'public', 'rigs', build, 'skeleton.model.json')), build).toBe(true);
  }
});

test('every gallery frame posed by rig-c/core is spine-core\'s frame, at tolerance 0', () => {
  test.setTimeout(300_000);
  const table: string[] = [];
  const totals = { builds: 0, animations: 0, frames: 0, slots: 0, regions: 0, meshes: 0, values: 0, signedZeros: 0, clipped: 0 };
  const failures: string[] = [];
  for (const build of BUILDS) {
    const files = filesOf(build);
    totals.builds++;
    for (const animation of gate.gateAnimations(files)) {
      const row = gate.gateAnimation(files, animation, DT, steps);
      totals.animations++;
      totals.frames += row.frames;
      totals.slots += row.slots;
      totals.regions += row.regions;
      totals.meshes += row.meshes;
      totals.values += row.values;
      totals.signedZeros += row.signedZeros;
      totals.clipped += row.clipped;
      table.push(
        `| ${build} | ${animation} | ${row.duration.toFixed(4)} | ${row.frames} | ${row.slots} | ${row.regions} | ${row.meshes} | ${row.values} | ${row.signedZeros} | ${row.mismatches.length} |`,
      );
      for (const m of row.mismatches) failures.push(`${build}: ${m}`);
    }
  }
  console.log(
    [
      `[frames] tolerance 0, dt=1/12:`,
      '| build | animation | duration s | frames | slots | regions | meshes | numbers compared | ±0 | mismatches |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...table,
      `| **${totals.builds} builds** | **${totals.animations}** | | **${totals.frames}** | **${totals.slots}** | **${totals.regions}** | **${totals.meshes}** | **${totals.values}** | **${totals.signedZeros}** | **${failures.length}** |`,
      `clipped slots: ${totals.clipped}`,
    ].join('\n'),
  );
  // Not vacuous: both tiers, every build, every animation.
  expect(totals.animations).toBeGreaterThanOrEqual(BUILDS.length);
  expect(totals.regions).toBeGreaterThan(0);
  expect(totals.meshes).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test('the clip cover follows the draw loop\'s clipStart / clipEnd on hand-made poses', () => {
  const cases = gate.coverCases();
  expect(cases.range).toEqual({ b: 'c', e: 'c' });
  expect(cases.nested).toEqual({ a: 'c1', b: 'c1', d: 'c1' });
  expect(cases.ownSlot).toEqual({ b: 'c', d: 'c' });
  expect(cases.passedEnd).toEqual({ b: 'c', d: 'c' });
  expect(cases.inactive).toEqual({});
  expect(cases.chained).toEqual({ a: 'c1', b: 'c2' });
  expect(cases.sequential).toEqual({ a: 'c1', b: 'c2' });
});
