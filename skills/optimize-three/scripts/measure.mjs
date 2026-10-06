#!/usr/bin/env node
// measure.mjs — measure a browser 3D page on REAL GPUs (discrete and/or integrated), reproducibly.
//
//   npm i -D playwright-core            (uses your installed Chrome; no browser download)
//   node measure.mjs http://localhost:5173/ --gpu=both --seconds=10
//
// Options
//   --gpu=dgpu|igpu|both     --force_high_performance_gpu / --force_low_power_gpu (default both)
//   --seconds=10             measurement window after warm-up
//   --warmup=6               seconds to ignore (shader compile, uploads, GPU clock ramp)
//   --size=1920x1080 --dsf=1 viewport + deviceScaleFactor
//   --headed                 visible window (most realistic; keep it in the foreground)
//   --params=perf            query string appended to the URL (default: perf)
//   --json=out.json          write results
//   --channel=chrome         chrome | msedge | chromium (default chrome)
//
// What it reports per GPU: actual GPU string (catches "measured the wrong GPU"), rendered fps and
// frame-interval p50/p95/max, miss rate, long tasks, page errors, and — if the page uses the
// optimize-three kit — window.__perf.report() (cpu/gpu ms, draws, triangles, DPR, quality level).
//
// Rules baked in (learned from wrong numbers):
//  - software rasterizer (SwiftShader/llvmpipe) → result marked INVALID
//  - background throttling flags are disabled, otherwise hidden/occluded windows read 1–2 fps
//  - each GPU gets a fresh browser; never compare runs from different processes' warm-ups
//  - numbers from an in-app/embedded browser pane, a hidden tab, or under HMR are not evidence

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : ['url', a]; }));
const url0 = args.url || 'http://localhost:5173/';
const gpus = (args.gpu || 'both') === 'both' ? ['dgpu', 'igpu'] : [args.gpu];
const seconds = +(args.seconds || 10), warm = +(args.warmup || 6);
const [W, H] = String(args.size || '1920x1080').split('x').map(Number);
const dsf = +(args.dsf || 1);
const params = args.params === undefined ? 'perf' : String(args.params);
const url = params ? url0 + (url0.includes('?') ? '&' : '?') + params : url0;

// Resolve playwright-core next to this script OR in the project you run it from (skill installs
// live in ~/.claude/skills, the dependency lives in your project).
let chromium;
for (const load of [
  () => import('playwright-core'),
  async () => { const { createRequire } = await import('node:module'); const { pathToFileURL } = await import('node:url');
    return import(pathToFileURL(createRequire(process.cwd() + '/').resolve('playwright-core')).href); },
]) { try { ({ chromium } = await load()); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright-core missing: run `npm i -D playwright-core` in your project'); process.exit(2); }

const BASE = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info'];
if (process.platform === 'win32') BASE.push('--use-angle=d3d11');

const results = [];
for (const gpu of gpus) {
  const flag = gpu === 'dgpu' ? '--force_high_performance_gpu' : '--force_low_power_gpu';
  const browser = await chromium.launch({ channel: args.channel || 'chrome', headless: !args.headed, args: [...BASE, flag] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('response', (res) => { if (res.status() >= 400 && !/favicon\.ico$/.test(res.url())) errors.push(`http ${res.status()}: ${res.url()}`); });
  await page.addInitScript(() => {
    // rAF interval recorder + long-task observer, installed before any app code
    const iv = []; let last = 0;
    const tick = (t) => { if (last) iv.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__measure = { iv, longTasks: 0, longMs: 0, reset() { iv.length = 0; this.longTasks = 0; this.longMs = 0; } };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__measure.longTasks++; window.__measure.longMs += e.duration; } }).observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(warm * 1000);
  const gpuString = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const e = gl?.getExtension('WEBGL_debug_renderer_info');
    const s = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return s || 'no WebGL2';
  });
  await page.evaluate(() => window.__measure.reset());
  await page.waitForTimeout(seconds * 1000);
  const r = await page.evaluate(() => {
    const iv = window.__measure.iv.slice();
    const s = [...iv].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
    const perf = window.__perf?.report?.() ?? null;
    return { rafFps: iv.length ? 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length) : 0, rafP50: q(0.5), rafP95: q(0.95), rafMax: s[s.length - 1] ?? 0,
      longTasks: window.__measure.longTasks, longTaskMs: Math.round(window.__measure.longMs), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, perf };
  });
  const software = /SwiftShader|llvmpipe|Basic Render|Software/i.test(gpuString);
  results.push({ gpu, gpuString, valid: !software, loadMs, ...r, errors: errors.slice(0, 10) });
  await browser.close();
}

const f1 = (v) => (v == null ? '–' : Number(v).toFixed(1));
console.log('\n' + ['gpu', 'renderer', 'fps*', 'p50', 'p95', 'max', 'cpu', 'gpu ms', 'draws', 'tris k', 'dpr', 'level', 'longtasks', 'errors'].join('\t'));
for (const r of results) {
  const p = r.perf;
  const fps = p ? p.fps : r.rafFps;
  console.log([r.gpu, (r.valid ? '' : 'INVALID ') + r.gpuString.replace(/^ANGLE \(|, D3D11\)$/g, '').slice(0, 48), f1(fps),
    f1(p ? p.intervalMs.p50 : r.rafP50), f1(p ? p.intervalMs.p95 : r.rafP95), f1(p ? p.intervalMs.max : r.rafMax),
    f1(p?.cpuMs?.p50), f1(p?.gpuMs?.p50), p?.drawCalls ?? '–', p ? Math.round(p.triangles / 1000) : '–', p?.dpr ?? '–',
    p?.quality ? `${p.quality.index + 1}/${p.quality.count} ${p.quality.level?.name ?? ''}` : '–', r.longTasks, r.errors.length].join('\t'));
}
console.log('* fps = rendered frames (kit) if window.__perf exists, else rAF rate. Capped pages read ~cap: use GPU ms for headroom.');
if (args.json) { (await import('node:fs')).writeFileSync(args.json, JSON.stringify({ url, size: `${W}x${H}@${dsf}`, seconds, warm, results }, null, 2)); console.log('wrote', args.json); }
if (results.some((r) => !r.valid || r.errors.length)) process.exitCode = 1;
