import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchReading } from '../bench/bench';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server: ChildProcess;
let base = '';

test.beforeAll(async ({}, worker) => {
  const port = Number(process.env.BENCH_TEST_PORT ?? 4540) + worker.parallelIndex;
  base = `http://localhost:${port}`;
  server = spawn('bunx', ['vite', '--config', 'bench/vite.config.ts', '--port', String(port), '--strictPort'], { cwd: root, detached: true, stdio: 'pipe' });
  let output = '';
  server.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
  server.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`bench server exited: ${output}`);
    try { if ((await fetch(base)).ok) return; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`bench server did not start: ${output}`);
});

test.afterAll(() => {
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } }
});

const query = 'rig=draw&anim=reorder&skin=base&time=0&timescale=0&count=2&scale=1&dpr=1&runtime=all&measurement=counters';

test('comparison grid uses one official context and renders the authored blend samples in all three panes', async ({ page }) => {
  await page.goto(`${base}/?scene=held&${query}`);
  await page.waitForFunction(() => Boolean(window.rigPlayBench));
  const r = await page.evaluate(() => window.rigPlayBench.runCounters(3, 1 / 60));
  expect(r.frames).toBe(3);
  expect(r.measurement).toBe('counters');
  expect(r.unavailableReason).toBe('측정 불가: 헤드리스');
  expect(r.sides.official?.counters).toMatchObject({ players: 2, drawnPlayers: 2, contexts: 1, liveContexts: 1 });
  for (const name of ['dom', 'canvas', 'official'] as const) {
    expect(r.sides[name]).not.toBeNull();
    expect([r.sides[name]?.fps, r.sides[name]?.poseMs, r.sides[name]?.renderMs]).toEqual([null, null, null]);
    expect(r.sides[name]?.stats).not.toMatch(/\d(?:\.\d+)?\s*(?:fps|ms)/);
    // CSS layout quantizes each coordinate to a subpixel grid; allow one
    // 1/64 px step on each axis in this Euclidean readback, never whole pixels.
    expect(r.sides[name]?.originDeltaPx).toBeLessThanOrEqual(Math.SQRT2 / 64);
    const png = await page.locator(`#${name}-stage`).screenshot();
    const samples = await page.evaluate(async ({ data, scale, columns, rows }) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
      const ctx = c.getContext('2d'); if (!ctx) throw new Error('no screenshot context'); ctx.drawImage(image, 0, 0);
      // Authored draw rig stage is(-96,-48,192,96). Origins are at the
      // horizontal cell centre and floor minus48*scale; samples are ±48.
      const y = Math.round(c.height / rows * 0.96 - 48 * scale);
      return [0, 1].flatMap((i) => [-48, 48].map((x) => Array.from(ctx.getImageData(Math.round(c.width / columns * (i + 0.5) + x * scale), y, 1, 1).data)));
    }, { data: png.toString('base64'), scale: r.cellScale, columns: r.columns, rows: r.rows });
    expect(samples).toEqual([[128, 0, 192, 255], [255, 64, 255, 255], [128, 0, 192, 255], [255, 64, 255, 255]]);
  }
});

test('independent many players retain two official contexts and report actual survivors', async ({ page }) => {
  await page.goto(`${base}/?scene=many&${query}`);
  await page.waitForFunction(() => Boolean(window.rigPlayBench));
  const r = await page.evaluate(() => window.rigPlayBench.runCounters(2, 1 / 60));
  expect(r.clipTarget).toBe('cell');
  expect(r.sides.official?.counters).toMatchObject({ players: 2, drawnPlayers: 2, contexts: 2, liveContexts: 2 });
});

test('official comparison refuses an unrelated paired export before publishing readings', async ({ page }) => {
  await page.goto(`${base}/?scene=held&${query}&json=/rigs/duo/skeleton.json&atlas=/rigs/duo/skeleton.atlas`);
  await expect(page.locator('#scene')).toContainText('official comparison pair mismatch:');
  expect(await page.evaluate(() => Boolean(window.rigPlayBench))).toBe(false);
});

test('a local corpus manifest produces all runtime rows with null headless timing and an explicit unavailable table', async ({}, info) => {
  test.setTimeout(60_000);
  let child: ChildProcess | undefined;
  const work = mkdtempSync(join(tmpdir(), 'play-bench-contract-'));
  const port = Number(process.env.BENCH_TEST_PORT ?? 4540) + 100 + info.parallelIndex;
  const fixture = resolve(root, 'public/rigs/draw');
  try {
    // Serve a real local corpus pair, not the checkout's public directory.
    const { cpSync } = await import('node:fs');
    cpSync(fixture, join(work, 'draw'), { recursive: true });
    writeFileSync(join(work, 'scenes.json'), JSON.stringify({ scenes: [{ name: 'paired local draw', query: { scene: 'held', model: '/draw/skeleton.model.json', anim: 'reorder', skin: 'base', count: 1, time: 0, timescale: 0 } }] }));
    const output = join(work, 'output');
    child = spawn('node', ['scripts/bench.mjs', '--headless', '--frames', '2', '--corpus', work, '--port', String(port), '--out', output], { cwd: root, stdio: 'pipe', detached: true });
    let log = '';
    child.stdout?.on('data', (data: Buffer) => { log += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { log += data.toString(); });
    const running = child;
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (running.pid) { try { process.kill(-running.pid, 'SIGTERM'); } catch { /* already stopped */ } }
        reject(new Error(`benchmark CLI timed out: ${log}`));
      }, 45_000);
      running.once('error', (error) => { clearTimeout(deadline); reject(error); });
      running.once('exit', (code) => { clearTimeout(deadline); resolve(code); });
    });
    expect(code, log).toBe(0);
    const jsonFile = readdirSync(output).find((f) => f.endsWith('.json'));
    const mdFile = readdirSync(output).find((f) => f.endsWith('.md'));
    if (!jsonFile || !mdFile) throw new Error(`report missing: ${log}`);
    const report = JSON.parse(readFileSync(join(output, jsonFile), 'utf8')) as { conditions: { headed: boolean; gpuRenderer: string | null; gpuVendor: string | null; measurement: string; unavailableReason: string }; rows: Array<{ runtime: 'dom' | 'canvas' | 'official'; reading: BenchReading }> };
    expect(report.conditions).toMatchObject({ headed: false, gpuRenderer: null, gpuVendor: null, measurement: 'counters', unavailableReason: '측정 불가: 헤드리스' });
    expect(report.rows.map((r) => r.runtime)).toEqual(['dom', 'canvas', 'official']);
    for (const row of report.rows) {
      const side = row.reading.sides[row.runtime];
      expect([side?.fps, side?.poseMs, side?.renderMs]).toEqual([null, null, null]);
      expect(side?.counters.players).toBe(1);
      expect(side?.counters.drawnPlayers).toBe(row.runtime === 'official' ? 1 : null);
      expect(side?.counters.liveContexts).toBe(row.runtime === 'official' ? 1 : null);
    }
    const table = readFileSync(join(output, mdFile), 'utf8');
    expect(table).toContain('측정 불가: 헤드리스');
    expect(table).toContain('| official |');
    await info.attach('headless-report.json', { body: readFileSync(join(output, jsonFile)), contentType: 'application/json' });
    await info.attach('headless-report.md', { body: table, contentType: 'text/markdown' });
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ } }
    rmSync(work, { recursive: true, force: true });
  }
});
