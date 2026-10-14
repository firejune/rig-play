#!/usr/bin/env node
/**
 * Writes JSON and a markdown table for DOM, canvas and official spine-webgl.
 *
 * Device readings use a visible headed Chromium on a quiet real GPU. A hidden
 * or headless rAF cadence and in-callback time are not performance evidence.
 * --headless instead runs deterministic counters; every timing is null and
 * every output labels it "측정 불가: 헤드리스". Safari remains a device reading.
 * Grid official draws share one context; `many` retains independent contexts.
 * Every row records the same crop/layout and actual live/drawn player counts.
 * Optional corpus files stay outside the repository and require matched
 * .model.json / .json / .atlas pairs, or explicit query json/atlas URLs.
 *
 * Usage:
 *   node scripts/bench.mjs [--frames N] [--out DIR] [--port N]
 *                          [--scenes FILE] [--corpus DIR] [--max-load N]
 *                          [--runtimes dom,canvas,official] [--headless]
 *
 * --headless: no device timings or GPU claim; counters at fixed 1/60 seconds.
 * --corpus DIR: scenes.json plus the paired rig builds under that directory.
 * Headed readings crossing the load guard are INVALID and exit 1.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, type as osType, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export function parseArgs(argv) {
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
    runtimes: ['dom', 'canvas', 'official'],
    headless: false,
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
        const unknown = args.runtimes.filter((r) => !['dom', 'canvas', 'official'].includes(r));
        if (unknown.length || !args.runtimes.length) throw new Error(`--runtimes takes dom, canvas, official; got ${unknown.join(', ') || 'nothing'}`);
        break;
      }
      case '--headless': args.headless = true; break;
      case '--help':
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.corpus) args.scenes = join(args.corpus, 'scenes.json');
  if (!Number.isInteger(args.frames) || args.frames < 1) throw new Error('--frames must be a positive integer');
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error('--port must be an integer between 1024 and 65535');
  if (!Number.isFinite(args.maxLoad) || args.maxLoad < 0) throw new Error('--max-load must be finite and at least 0');
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
    detached: process.platform !== 'win32',
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return {
    child,
    stop() {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      } catch { /* already stopped */ }
    },
    ready: new Promise((resolveReady, rejectReady) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        rejectReady(new Error(`the bench server never came up:\n${log}`));
      }, 60_000);
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
      child.once('error', (error) => {
        clearInterval(poll);
        clearTimeout(deadline);
        rejectReady(error);
      });
      child.on('exit', (code) => {
        clearInterval(poll);
        clearTimeout(deadline);
        rejectReady(new Error(`the bench server exited with ${code}:\n${log}`));
      });
    }),
  };
}

function queryString(query, runtime, headless) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  params.set('runtime', runtime);
  if (headless) params.set('measurement', 'counters');
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
  const stopServer = () => server.stop();
  const terminate = () => process.exit(130);
  process.once('exit', stopServer);
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  let browser;
  const rows = [];
  let conditions;
  try {
    await server.ready;
    browser = await chromium.launch({ headless: args.headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Conditions are read from the browser that will do the measuring, not
    // assumed: a report whose GPU line came from somewhere else is a report
    // about a machine nobody ran.
    await page.goto(`http://localhost:${args.port}/?${queryString({ scene: 'mesh' }, 'dom', args.headless)}`);
    const environment = await page.evaluate((headless) => {
      let renderer = null;
      let vendor = null;
      if (!headless) {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
            vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
          }
          gl.getExtension('WEBGL_lose_context')?.loseContext();
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
    }, args.headless);

    const rendererKind = args.headless ? 'unmeasured' : !environment.gpuRenderer ? 'unknown'
      : /swiftshader|llvmpipe|softpipe|software|lavapipe/i.test(environment.gpuRenderer) ? 'software' : 'hardware reported; physical device not independently verified';
    conditions = {
      takenAt: new Date().toISOString(),
      browser: `chromium ${browser.version()}`,
      headed: !args.headless,
      measurement: args.headless ? 'counters' : 'headed observation',
      rendererKind,
      devicePerformanceValidity: args.headless ? 'unavailable: headless' : rendererKind === 'software' || rendererKind === 'unknown'
        ? `unavailable: ${rendererKind} renderer` : 'requires physical-device confirmation',
      unavailableReason: args.headless ? '측정 불가: 헤드리스' : null,
      fixedCounterStep: args.headless ? 1 / 60 : null,
      officialRuntime: '@esotericsoftware/spine-webgl 4.3.13',
      officialAntialias: false,
      officialPmaAdditiveBatching: false,
      officialPreserveDrawingBuffer: 'recorded per reading',
      os: `${osType()} ${release()}`,
      cores: loadBefore.cores,
      totalMemoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      framesPerReading: args.frames,
      ...environment,
    };

    for (const scene of scenes) {
      for (const runtime of args.runtimes) {
        const url = `http://localhost:${args.port}/?${queryString(scene.query, runtime, args.headless)}`;
        await page.goto(url);
        await page.waitForFunction(() => Boolean(window.rigPlayBench) || document.getElementById('scene')?.textContent?.startsWith('failed:'), null, { timeout: 60_000 });
        const failure = await page.locator('#scene').textContent();
        if (failure?.startsWith('failed:')) throw new Error(failure);
        // Warm-up frames first: the first raster of a scene is not its steady
        // state (fresh bitmaps, shader compiles, grow-only backing still
        // growing), and a reading that includes them is a reading of the
        // warm-up.
        await page.evaluate(({ n, headless }) => headless ? window.rigPlayBench.runCounters(n) : window.rigPlayBench.run(n), { n: Math.ceil(args.frames / 6), headless: args.headless });
        const reading = await page.evaluate(({ n, headless }) => headless ? window.rigPlayBench.runCounters(n) : window.rigPlayBench.run(n), { n: args.frames, headless: args.headless });
        if (args.headless && (reading.measurement !== 'counters' || Object.values(reading.sides).some((s) => s && [s.fps, s.poseMs, s.renderMs].some((v) => v !== null)))) throw new Error('headless page exposed timing values');
        rows.push({ scene: scene.name, why: scene.why ?? null, runtime, url, reading });
      }
    }
  } finally {
    try { await browser?.close(); } finally {
      server.stop();
      process.removeListener('exit', stopServer);
      process.removeListener('SIGINT', terminate);
      process.removeListener('SIGTERM', terminate);
    }
  }

  const loadAfter = normalizedLoad();
  const invalidRenderer = !args.headless && ['software', 'unknown'].includes(conditions.rendererKind)
    ? `INVALID: ${conditions.rendererKind} renderer; no physical GPU performance claim.` : null;
  const invalid = invalidRenderer ?? (!args.headless &&
    (loadBefore.perCore > args.maxLoad || loadAfter.perCore > args.maxLoad)
      ? `INVALID: load average too high — ${loadBefore.perCore.toFixed(2)} before and ` +
        `${loadAfter.perCore.toFixed(2)} after, per core, over a ${args.maxLoad.toFixed(2)} ` +
        `threshold. These numbers measure the machine's queue, not either mode.`
      : null);

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

export function markdown(report) {
  const { conditions, rows, invalid } = report;
  const lines = [];
  if (invalid) {
    lines.push(`> **${invalid}**`, '');
  }
  lines.push('# DOM · canvas · official spine-webgl', '');
  if (conditions.unavailableReason) lines.push(`> **${conditions.unavailableReason}** — counters only; no performance measurement.`, '');
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
    '| scene | runtime | rig | clipped to | fps | pose ms | render ms | drawn players | triangles | draw calls | origin Δpx | live contexts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of rows) {
    const r = row.reading;
    const side = r.sides[row.runtime];
    if (!side) throw new Error(`report has no ${row.runtime} reading`);
    const unavailable = conditions.unavailableReason ?? '—';
    const number = (value) => value === null ? unavailable : value.toFixed(2);
    const c = side.counters;
    lines.push(
      `| ${row.scene} | ${row.runtime} | ${r.model} ${r.animation} | ${r.clipTarget} | ` +
        `${number(side.fps)} | ${number(side.poseMs)} | ${number(side.renderMs)} | ` +
        `${c.drawnPlayers ?? '—'}/${c.players} | ${c.triangles} | ${c.drawCalls ?? '—'} | ${side.originDeltaPx.toFixed(3)} | ${c.liveContexts ?? '—'}/${c.contexts} |`,
    );
  }
  lines.push('');
  lines.push(
    'Each row is its own page load with only that mode animating, because',
    'requestAnimationFrame has one cadence per document — two panes running',
    'together report the page\'s fps, not either mode\'s.',
    '',
    'All runtimes place rigs on one grid and clip each to the same rect, so they',
    'draw the same visible area; `origin Δpx` is how far a side landed',
    'from that grid.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
