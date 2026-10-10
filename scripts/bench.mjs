#!/usr/bin/env node
/**
 * Drives bench/index.html and writes down what it read, with the conditions
 * attached.
 *
 * ## What this is not
 *
 * It is not a test and it must never become one. Nothing in this repository
 * asserts a millisecond, and no number this produces belongs in a committed
 * file until it was taken on a quiet machine — the standing rule is that the
 * perf oracle is a stats line read on a real device, and headless numbers are
 * not evidence (headless WebKit is a software rasterizer, measured up to 28×
 * off real Safari). This script only makes the reading repeatable and the
 * conditions impossible to lose. What it compares is this package's two
 * render modes — the DOM tier and the canvas mode — on the same rigs.
 *
 * ## Why it opens a visible window
 *
 * A hidden or headless page is throttled: `requestAnimationFrame` drops to a
 * crawl or stops, and the fps this measures is then the browser's power policy
 * rather than either mode's cost. So Chromium is launched **headed**, and
 * the run says so in every output it writes. Safari is not driven at all — it
 * has no automation that preserves the thing being measured, so it stays a
 * person, a device and the page's clickable stats line.
 *
 * ## What each row says it compared
 *
 * Two modes are only comparable if they drew the same picture, so every row
 * carries what both were clipped to (the pane for a grid of rigs, each rig's
 * cell for `many` — the same rect on both sides) and `origin Δpx`, the largest
 * gap between where the page's grid put a rig and where that side drew it — a
 * counter rather than a timing, so it means the same thing on any machine, and
 * anything but ~0 says the row is comparing two placements rather than two
 * modes. `bench/bench.ts` carries the reasoning.
 *
 * ## The INVALID stamp
 *
 * A benchmark on a loaded machine measures the load. Every run records the
 * 1-minute load average before and after, and if either crosses the threshold
 * the whole report is stamped INVALID, loudly, in the JSON and at the top of
 * the markdown. That stamp is not advisory — a stamped report is a report of
 * nothing, and the numbers are left in only so it is obvious what was thrown
 * away.
 *
 * Usage:
 *   node scripts/bench.mjs [--frames N] [--out DIR] [--port N]
 *                          [--scenes FILE] [--corpus DIR] [--max-load N]
 *                          [--runtimes dom,canvas]
 *
 *   --runtimes     which page loads each scene gets, comma-separated: `dom`
 *                  (this package's DOM tier) and `canvas` (its canvas render
 *                  mode). Both by default.
 *
 *   --corpus DIR   a directory holding its own scenes.json plus the rigc
 *                  builds it names, for real-world rigs that never enter this
 *                  repository. The page is served from there instead.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, type as osType, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    frames: 600,
    out: join(REPO, 'bench-results'),
    port: 4399,
    scenes: join(REPO, 'bench', 'scenes.json'),
    corpus: null,
    // Per core, so the threshold means the same thing on a laptop and a
    // workstation. 1.0 is "the machine already has a full core of work per
    // core"; a benchmark under that is measuring the queue.
    maxLoad: 1.0,
    runtimes: ['dom', 'canvas'],
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--frames': args.frames = Number(value()); break;
      case '--out': args.out = resolve(value()); break;
      case '--port': args.port = Number(value()); break;
      case '--scenes': args.scenes = resolve(value()); break;
      case '--corpus': args.corpus = resolve(value()); break;
      case '--max-load': args.maxLoad = Number(value()); break;
      case '--runtimes': {
        args.runtimes = value().split(',').map((r) => r.trim()).filter(Boolean);
        const unknown = args.runtimes.filter((r) => !['dom', 'canvas'].includes(r));
        if (unknown.length || !args.runtimes.length) throw new Error(`--runtimes takes dom, canvas; got ${unknown.join(', ') || 'nothing'}`);
        break;
      }
      case '--help':
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.corpus) args.scenes = join(args.corpus, 'scenes.json');
  return args;
}

/** Load average per core — see maxLoad above. */
function normalizedLoad() {
  const cores = Math.max(1, cpus().length);
  const [one] = loadavg();
  return { raw: one, perCore: one / cores, cores };
}

function startServer(port, corpus) {
  const config = join(REPO, 'bench', 'vite.config.ts');
  // A corpus directory serves its own rigs in place of public/; the page still
  // comes from bench/ and is told which rig to load by query string.
  const argv = ['vite', '--config', config, '--port', String(port), '--strictPort'];
  const child = spawn('bunx', argv, {
    cwd: REPO,
    env: { ...process.env, BENCH_CORPUS: corpus ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return {
    child,
    ready: new Promise((resolveReady, rejectReady) => {
      const deadline = setTimeout(
        () => rejectReady(new Error(`the bench server never came up:\n${log}`)),
        60_000,
      );
      const poll = setInterval(async () => {
        try {
          const response = await fetch(`http://localhost:${port}/`);
          if (response.ok) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolveReady();
          }
        } catch {
          // not up yet
        }
      }, 250);
      child.on('exit', (code) => {
        clearInterval(poll);
        clearTimeout(deadline);
        rejectReady(new Error(`the bench server exited with ${code}:\n${log}`));
      });
    }),
  };
}

function queryString(query, runtime) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  params.set('runtime', runtime);
  return params.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.scenes, 'utf8'));
  const scenes = manifest.scenes ?? [];
  if (!scenes.length) throw new Error(`${args.scenes} lists no scenes`);

  const { chromium } = await import('@playwright/test');
  const loadBefore = normalizedLoad();

  const server = startServer(args.port, args.corpus);
  let browser;
  const rows = [];
  let conditions;
  try {
    await server.ready;
    // Headed, and not negotiable — see the header.
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Conditions are read from the browser that will do the measuring, not
    // assumed: a report whose GPU line came from somewhere else is a report
    // about a machine nobody ran.
    await page.goto(`http://localhost:${args.port}/?scene=mesh&runtime=dom`);
    const environment = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      let renderer = null;
      let vendor = null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
          vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
        }
      }
      return {
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        gpuRenderer: renderer,
        gpuVendor: vendor,
      };
    });

    conditions = {
      takenAt: new Date().toISOString(),
      browser: `chromium ${browser.version()}`,
      headed: true,
      os: `${osType()} ${release()}`,
      cores: loadBefore.cores,
      totalMemoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      framesPerReading: args.frames,
      ...environment,
    };

    for (const scene of scenes) {
      for (const runtime of args.runtimes) {
        const url = `http://localhost:${args.port}/?${queryString(scene.query, runtime)}`;
        await page.goto(url);
        await page.waitForFunction(() => Boolean(window.rigPlayBench), null, { timeout: 60_000 });
        // Warm-up frames first: the first raster of a scene is not its steady
        // state (fresh bitmaps, shader compiles, grow-only backing still
        // growing), and a reading that includes them is a reading of the
        // warm-up.
        await page.evaluate((n) => window.rigPlayBench.run(n), Math.ceil(args.frames / 6));
        const reading = await page.evaluate((n) => window.rigPlayBench.run(n), args.frames);
        rows.push({ scene: scene.name, why: scene.why ?? null, runtime, url, reading });
      }
    }
  } finally {
    await browser?.close();
    server.child.kill();
  }

  const loadAfter = normalizedLoad();
  const invalid =
    loadBefore.perCore > args.maxLoad || loadAfter.perCore > args.maxLoad
      ? `INVALID: load average too high — ${loadBefore.perCore.toFixed(2)} before and ` +
        `${loadAfter.perCore.toFixed(2)} after, per core, over a ${args.maxLoad.toFixed(2)} ` +
        `threshold. These numbers measure the machine's queue, not either mode.`
      : null;

  const report = {
    invalid,
    conditions: {
      ...conditions,
      loadAverageBefore: Math.round(loadBefore.raw * 100) / 100,
      loadAverageAfter: Math.round(loadAfter.raw * 100) / 100,
      loadPerCoreBefore: Math.round(loadBefore.perCore * 100) / 100,
      loadPerCoreAfter: Math.round(loadAfter.perCore * 100) / 100,
      maxLoadPerCore: args.maxLoad,
      corpus: args.corpus,
    },
    rows,
  };

  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(args.out, `bench-${stamp}.json`);
  const mdPath = join(args.out, `bench-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, markdown(report));

  if (invalid) console.error(`\n${invalid}\n`);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
  // A stamped run is a failed measurement, and the exit code should say so:
  // a caller scripting this must not collect numbers it was told to discard.
  process.exitCode = invalid ? 1 : 0;
}

function markdown(report) {
  const { conditions, rows, invalid } = report;
  const lines = [];
  if (invalid) {
    lines.push(`> **${invalid}**`, '');
  }
  lines.push('# DOM mode vs canvas mode', '');
  lines.push('## Conditions', '');
  lines.push('| | |', '| --- | --- |');
  for (const [key, value] of Object.entries(conditions)) {
    lines.push(`| ${key} | ${value === null ? '—' : String(value)} |`);
  }
  lines.push('');
  lines.push(
    'Safari is not in this table and cannot be: it has no automation that',
    'preserves what is being measured. Read the page\'s stats line on the',
    'device instead — clicking it copies it.',
    '',
  );
  lines.push('## Readings', '');
  lines.push(
    '| scene | mode | rig | clipped to | fps | stats line | origin Δpx | GL contexts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of rows) {
    const r = row.reading;
    const dom = row.runtime === 'dom';
    const fps = dom ? r.domFps : r.canvasFps;
    const stats = dom ? r.domStats : r.canvasStats;
    const delta = dom ? r.domOriginDeltaPx : r.canvasOriginDeltaPx;
    lines.push(
      `| ${row.scene} | ${row.runtime} | ${r.model} ${r.animation} | ${r.clipTarget} | ` +
        `${fps === null ? '—' : fps.toFixed(1)} | ${stats} | ` +
        `${delta === null || delta === undefined ? '—' : delta} | ${r.glContexts} |`,
    );
  }
  lines.push('');
  lines.push(
    'Each row is its own page load with only that mode animating, because',
    'requestAnimationFrame has one cadence per document — two panes running',
    'together report the page\'s fps, not either mode\'s.',
    '',
    'Both modes place rigs on one grid and clip each to the same rect, so the',
    'two draw the same visible area; `origin Δpx` is how far either side landed',
    'from that grid.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
