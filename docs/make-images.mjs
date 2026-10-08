// Regenerates the README images from real runs. Needs: `npm run serve` (port 5180) + playwright-core.
//   node docs/make-images.mjs [hero] [gpus] [governor] [pacing] [audit] [compare]
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createFrameLoop } from '../skills/optimize-three/kit/frame-loop.js';

const BASE = 'http://localhost:5180/examples';
const only = process.argv.slice(2);
const want = (k) => !only.length || only.includes(k);
const ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const C = { bg: '#0d1117', panel: '#161b22', grid: '#30363d', text: '#e6edf3', dim: '#8b949e', amber: '#ffb347', blue: '#58a6ff', red: '#ff7b72', green: '#56d364' };
const FONT = "font-family='ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif'";
const MONO = "font-family='ui-monospace,SFMono-Regular,Consolas,Menlo,monospace'";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function browser(gpu) {
  return chromium.launch({ channel: 'chrome', headless: !process.env.HEADED, args: [...ARGS, gpu === 'igpu' ? '--force_low_power_gpu' : '--force_high_performance_gpu'] });
}

// ---------- hero: the example with the HUD, discrete GPU ----------
if (want('hero')) {
  const b = await browser('dgpu');
  const p = await b.newPage({ viewport: { width: 1600, height: 820 }, deviceScaleFactor: 1.5 });
  await p.goto(`${BASE}/basic/?perf`);
  await p.waitForTimeout(9000);
  await p.evaluate(() => { document.getElementById('help')?.remove(); });
  await p.screenshot({ path: 'docs/hero.png' });
  await b.close();
  console.log('hero.png');
}

// ---------- gpus: HUD crops from both GPUs side by side ----------
if (want('gpus')) {
  const shots = {};
  for (const gpu of ['dgpu', 'igpu']) {
    const b = await browser(gpu);
    const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    await p.goto(`${BASE}/basic/?perf`);
    await p.waitForTimeout(14000);
    const box = await p.locator('pre').first().boundingBox();
    shots[gpu] = (await p.screenshot({ clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width + 8), height: Math.ceil(box.y + box.height + 8) } })).toString('base64');
    await b.close();
  }
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1360, height: 50 }, deviceScaleFactor: 2 });
  await p.setContent(`<body style="margin:0;background:${C.bg};font:15px system-ui,sans-serif;color:${C.text}">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
    ${['dgpu', 'igpu'].map((g) => `<figure style="margin:0"><figcaption style="margin:0 0 8px;color:${C.dim}">${g === 'dgpu' ? 'Discrete GPU · starts high' : 'Integrated GPU · starts lower, climbs when measured headroom allows'}</figcaption>
      <img src="data:image/png;base64,${shots[g]}" style="width:640px;border-radius:8px;border:1px solid ${C.grid}"></figure>`).join('')}
    </div></body>`);
  await p.waitForTimeout(200); const h = await p.evaluate(() => document.body.firstElementChild.getBoundingClientRect().height);
  await p.setViewportSize({ width: 1360, height: Math.ceil(h) });
  await p.screenshot({ path: 'docs/gpus.png' });
  await b.close();
  console.log('gpus.png');
}

// ---------- governor: iGPU under stress, timeline ----------
if (want('governor')) {
  const b = await browser('igpu');
  const p = await b.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1.5 });
  await p.goto(`${BASE}/basic/?perf&n=60000`);
  await p.waitForFunction(() => window.__perf, null, { timeout: 60000 });
  // start on 'high' (as if the GPU string had guessed wrong) but keep the governor free
  await p.evaluate(() => { const g = __perf.governor; g.set(0, 'start high'); });
  await p.waitForTimeout(600);
  const series = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 36000) {
    await p.waitForTimeout(250);
    const s = await p.evaluate(() => { const s = __perf.hud.snapshot(); return { frames: s.frames, fps: s.fps, p95: s.intervalMs.p95, gpu: s.gpuMs?.p50 ?? null, level: s.quality.level.name, dpr: s.dpr, ready: s.quality.ready }; });
    series.push({ t: (Date.now() - t0) / 1000, ...s });
  }
  const log = await p.evaluate(() => __perf.governor.log);
  await b.close();
  writeFileSync('docs/governor-data.json', JSON.stringify({ series, log }, null, 1));
  writeFileSync('docs/governor.svg', governorSvg(series));
  console.log('governor.svg');
}

function governorSvg(series) {
  const W = 960, H = 380, L = 64, R = 24, T = 64, B = 56, pw = W - L - R, ph = H - T - B;
  const tMax = series.at(-1).t, yMax = 100;
  for (let i = 1; i < series.length; i++) { const a = series[i - 1], b = series[i]; const df = b.frames - a.frames; b.ft = df > 0 ? ((b.t - a.t) * 1000) / df : null; }
  const x = (t) => L + (t / tMax) * pw, y = (ms) => T + ph - (Math.min(ms, yMax) / yMax) * ph;
  const pts = series.filter((s) => s.ft);
  const line = pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.ft).toFixed(1)}`).join('');
  const gline = pts.filter((s) => s.gpu).map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.gpu).toFixed(1)}`).join('');
  // level bands
  const bands = []; let cur = null;
  for (const s of pts) { if (!cur || cur.level !== s.level) { if (cur) cur.t1 = s.t; cur = { level: s.level, t0: s.t, t1: tMax }; bands.push(cur); } }
  const shades = ['#1f6feb22', '#8957e522', '#d2992222', '#f8514922', '#3fb95022', '#58a6ff22', '#db61a222'];
  const gridY = [16.7, 33.3, 66.7, 100].map((v) => `<line x1='${L}' x2='${W - R}' y1='${y(v)}' y2='${y(v)}' stroke='${C.grid}' stroke-dasharray='4 4'/><text x='${L - 8}' y='${y(v) + 4}' fill='${C.dim}' font-size='12' text-anchor='end' ${MONO}>${v} ms</text>`).join('');
  const lab = (v) => (v === 16.7 ? '60 fps' : v === 33.3 ? '30 fps' : '');
  const gridLab = [16.7, 33.3].map((v) => `<text x='${W - R - 4}' y='${y(v) - 6}' fill='${C.dim}' font-size='12' text-anchor='end' ${FONT}>${lab(v)} budget</text>`).join('');
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}'>
<rect width='${W}' height='${H}' rx='12' fill='${C.bg}'/>
<text x='${L}' y='30' fill='${C.text}' font-size='18' font-weight='600' ${FONT}>Governor on an Intel UHD under deliberate overload</text>
<text x='${L}' y='50' fill='${C.dim}' font-size='13' ${FONT}>60 000 boxes · 2560×1440 @1.5 · started on "high" · rendered frame time, 250 ms buckets (amber) and GPU ms (blue), measured live</text>
${bands.map((b, i) => `<rect x='${x(b.t0)}' y='${T}' width='${Math.max(0, x(b.t1) - x(b.t0))}' height='${ph}' fill='${shades[i % shades.length]}'/><text x='${x(b.t0) + 6}' y='${T + 16}' fill='${C.text}' font-size='12' ${MONO}>${esc(b.level)}</text>`).join('')}
${gridY}${gridLab}
<path d='${gline}' fill='none' stroke='${C.blue}' stroke-width='2' opacity='.9'/>
<path d='${line}' fill='none' stroke='${C.amber}' stroke-width='2.5'/>
<line x1='${L}' x2='${W - R}' y1='${T + ph}' y2='${T + ph}' stroke='${C.grid}'/>
${[0, 10, 20, 30].filter((t) => t <= tMax).map((t) => `<text x='${x(t)}' y='${T + ph + 20}' fill='${C.dim}' font-size='12' text-anchor='middle' ${MONO}>${t}s</text>`).join('')}
<text x='${L}' y='${H - 12}' fill='${C.dim}' font-size='12' ${FONT}>Steps down fast; where even the cheapest 60 fps rung still misses frames, it settles on an evenly paced 30. Only cost changes, never the look.</text>
</svg>`;
}

// ---------- pacing: naive time-based cap vs vsync-aligned pacing (simulated 60 Hz with jitter) ----------
if (want('pacing')) {
  const N = 90, hz = 60, period = 1000 / hz;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stamps = []; let t = 0; for (let i = 0; i < N * 2.2 + 20; i++) { t += period; stamps.push(t + (rnd() - 0.5) * 3.2); }
  // naive: render when now - last >= 1000/30
  const naive = []; let last = -1e9;
  for (const s of stamps) if (s - last >= 1000 / 30) { if (last > 0) naive.push(s - last); last = s; }
  // kit loop on the same stamps
  const kit = []; let q = [];
  const loop = createFrameLoop({ fps: 30, autoVisibility: false, raf: (f) => { q.push(f); return q.length; }, caf: () => {}, clock: () => 0, render: () => {}, onFrame: (f) => f.interval && kit.push(f.interval) });
  loop.start(); for (const s of stamps) { const b = q; q = []; for (const f of b) f(s); }
  writeFileSync('docs/pacing.svg', pacingSvg(naive.slice(5, 5 + 40), kit.slice(5, 5 + 40)));
  console.log('pacing.svg');
}

function pacingSvg(a, b) {
  const W = 960, H = 300, L = 150, R = 24, row = 96, T = 70;
  const bar = (arr, y0, color) => { let x = L; return arr.map((v) => { const w = (v / 1000) * 2000; const r = `<rect x='${x.toFixed(1)}' y='${y0}' width='${(w - 2).toFixed(1)}' height='34' rx='3' fill='${v > 40 ? C.red : color}'/>`; x += w; return x < W - R ? r : ''; }).join(''); };
  const stat = (arr) => { const s = [...arr].sort((x, y) => x - y); return `${s[0].toFixed(0)}–${s.at(-1).toFixed(0)} ms`; };
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}'>
<rect width='${W}' height='${H}' rx='12' fill='${C.bg}'/>
<text x='24' y='32' fill='${C.text}' font-size='18' font-weight='600' ${FONT}>A 30 fps cap on a 60 Hz screen: each block is one frame</text>
<text x='24' y='52' fill='${C.dim}' font-size='13' ${FONT}>Same jittery vsync timestamps (±1.6 ms). Red = a 50 ms frame, which you see as a stutter.</text>
<text x='24' y='${T + 22}' fill='${C.text}' font-size='14' ${FONT}>naive cap</text><text x='24' y='${T + 40}' fill='${C.dim}' font-size='12' ${MONO}>${stat(a)}</text>
<text x='24' y='${T + row + 22}' fill='${C.text}' font-size='14' ${FONT}>optimize-three</text><text x='24' y='${T + row + 40}' fill='${C.dim}' font-size='12' ${MONO}>${stat(b)}</text>
${bar(a, T + 6, C.amber)}${bar(b, T + row + 6, C.green)}
<text x='24' y='${H - 18}' fill='${C.dim}' font-size='12' ${MONO}>if (now - last &gt;= 1000/30)   vs   render every round(33.3 / vsync) vsyncs, tolerance ½ vsync</text>
</svg>`;
}

// ---------- audit: terminal render of the naive example audit ----------
if (want('audit')) {
  const out = execFileSync(process.execPath, ['skills/optimize-three/scripts/audit.mjs', 'examples/naive'], { encoding: 'utf8' });
  const lines = out.split('\n').filter((l) => !/^\s+index\.html/.test(l)).slice(0, 16);
  const color = (l) => (l.startsWith('✖') ? C.red : l.startsWith('▲') ? C.amber : l.startsWith('•') ? C.dim : C.text);
  const W = 1100, lh = 22, H = 60 + lines.length * lh + 20;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}'>
<rect width='${W}' height='${H}' rx='12' fill='${C.bg}'/>
<circle cx='24' cy='22' r='6' fill='#ff5f56'/><circle cx='44' cy='22' r='6' fill='#ffbd2e'/><circle cx='64' cy='22' r='6' fill='#27c93f'/>
<text x='90' y='27' fill='${C.dim}' font-size='13' ${MONO}>$ node scripts/audit.mjs examples/naive</text>
${lines.map((l, i) => `<text x='24' y='${62 + i * lh}' fill='${color(l)}' font-size='13.5' ${MONO} xml:space='preserve'>${esc(l.length > 128 ? l.slice(0, 125) + '…' : l)}</text>`).join('\n')}
</svg>`;
  writeFileSync('docs/audit.svg', svg);
  console.log('audit.svg');
}

// ---------- compare: naive vs kit, both GPUs (from measure.mjs JSON) ----------
if (want('compare')) {
  const n = JSON.parse(readFileSync('docs/measure-naive.json', 'utf8')).results;
  const k = JSON.parse(readFileSync('docs/measure-basic.json', 'utf8')).results;
  const name = (r) => (r.gpu === 'dgpu' ? 'RTX 3080 Laptop' : 'Intel UHD (iGPU)');
  const rows = n.map((r, i) => ({ gpu: name(r), naive: r.rafFps, naiveP95: r.rafP95, kit: k[i].perf.fps, kitP95: k[i].perf.intervalMs.p95, gpuMs: k[i].perf.gpuMs?.p50, draws: k[i].perf.drawCalls }));
  const W = 960, H = 330, L = 200, R = 120, max = 70, pw = W - L - R;
  const xv = (v) => (Math.min(v, max) / max) * pw;
  let y = 96;
  const body = rows.map((r) => {
    const s = `<text x='24' y='${y + 30}' fill='${C.text}' font-size='15' font-weight='600' ${FONT}>${r.gpu}</text>
<rect x='${L}' y='${y}' width='${xv(r.naive)}' height='24' rx='4' fill='${C.red}'/><text x='${L + xv(r.naive) + 8}' y='${y + 17}' fill='${C.text}' font-size='13' ${MONO}>${r.naive.toFixed(0)} fps · p95 ${r.naiveP95.toFixed(0)} ms</text>
<rect x='${L}' y='${y + 30}' width='${xv(r.kit)}' height='24' rx='4' fill='${C.green}'/><text x='${L + xv(r.kit) + 8}' y='${y + 47}' fill='${C.text}' font-size='13' ${MONO}>${r.kit.toFixed(0)} fps · p95 ${r.kitP95.toFixed(0)} ms</text>`;
    y += 92; return s;
  }).join('');
  const cap = L + xv(60);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}'>
<rect width='${W}' height='${H}' rx='12' fill='${C.bg}'/>
<text x='24' y='34' fill='${C.text}' font-size='18' font-weight='600' ${FONT}>Same scene, written naively vs with optimize-three</text>
<text x='24' y='56' fill='${C.dim}' font-size='13' ${FONT}>4000 boxes + 6 animated shadow casters · 1920×1080 @1.5 (typical 150 % laptop scaling) · measure.mjs, real GPUs</text>
<rect x='${W - 300}' y='70' width='12' height='12' rx='2' fill='${C.red}'/><text x='${W - 282}' y='80' fill='${C.dim}' font-size='12' ${FONT}>naive (one mesh per box, uncapped)</text>
<rect x='${W - 300}' y='88' width='12' height='12' rx='2' fill='${C.green}'/><text x='${W - 282}' y='98' fill='${C.dim}' font-size='12' ${FONT}>kit (instanced, capped 60, governed)</text>
<line x1='${cap}' x2='${cap}' y1='92' y2='${H - 40}' stroke='${C.grid}' stroke-dasharray='4 4'/><text x='${cap}' y='${H - 24}' fill='${C.dim}' font-size='12' text-anchor='middle' ${MONO}>60 fps cap</text>
${body}
</svg>`;
  writeFileSync('docs/compare.svg', svg);
  console.log('compare.svg', rows);
}
