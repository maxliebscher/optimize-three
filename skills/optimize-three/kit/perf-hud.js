// perf-hud.js — the ?perf overlay + a JSON report for scripts.
//
// Shows what you need to make decisions, nothing else:
//   GPU name (!)  backend  display Hz  cap      → are you even measuring the right GPU?
//   rendered fps, interval p50/p95, misses      → what the user sees (not rAF rate)
//   CPU ms (frame callback), GPU ms (timer)     → which side is the bottleneck
//   draws / triangles / programs / textures     → per FRAME, summed over all passes
//   drawing buffer, DPR, quality level, log     → what the governor did and why
//
// renderer.info resets on every render() call by default, so with a post chain it reports the
// LAST pass (often "1 draw, 2 triangles"). The kit sets info.autoReset = false and resets once
// per frame in beginFrame(), so numbers are whole-frame totals.

import { shortGpuName } from './gpu-profile.js';

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));

export function createPerfHud({ renderer, profile, loop, governor, timer, shadowCache, backend = renderer?.isWebGPURenderer ? 'webgpu' : 'webgl', show = true, position = 'top-left' } = {}) {
  const N = 240;
  const iv = [], cpu = [], gpu = [], calls = [], tris = [];
  let raf0 = performance.now(), rafCount = 0, renderedCount = 0, lastShadowRenders = 0, shadowPerS = 0;
  let el = null, last = 0;
  const info = renderer.info;
  info.autoReset = false;
  const isGPU = !!renderer.isWebGPURenderer;
  const L = () => (typeof loop === 'function' ? loop() : loop); // may be passed lazily

  if (show && typeof document !== 'undefined') {
    el = document.createElement('pre');
    el.setAttribute('aria-hidden', 'true');
    const pos = position === 'top-right' ? 'right:8px;top:8px' : position === 'bottom-left' ? 'left:8px;bottom:8px' : 'left:8px;top:8px';
    el.style.cssText = `position:fixed;${pos};z-index:2147483000;margin:0;padding:8px 10px;background:rgba(8,10,12,.8);color:#e6efe6;`
      + 'font:12px/1.4 ui-monospace,Consolas,Menlo,monospace;border-radius:6px;pointer-events:none;white-space:pre;max-width:96vw';
    document.body.appendChild(el);
  }

  const push = (a, v) => { a.push(v); if (a.length > N) a.shift(); };

  function beginFrame() { info.reset(); }
  function endFrame({ interval, cpuMs, stall }) {
    renderedCount++;
    if (interval && !stall) push(iv, interval);
    push(cpu, cpuMs);
    if (timer?.ms != null) push(gpu, timer.ms);
    const r = info.render;
    push(calls, isGPU ? (r.drawCalls ?? r.calls) : r.calls);
    push(tris, r.triangles);
    const t = performance.now();
    if (t - last > 250) { last = t; draw(); }
  }
  function rafTick() { rafCount++; }

  function snapshot() {
    const now = performance.now(), secs = (now - raf0) / 1000;
    const fpsR = iv.length ? 1000 / (iv.reduce((s, x) => s + x, 0) / iv.length) : 0;
    const lp = L();
    const budget = governor?.budgetMs ?? (lp?.fps ? 1000 / lp.fps : 16.7);
    const sr = shadowCache?.renders ?? 0;
    if (secs > 1) { shadowPerS = (sr - lastShadowRenders) / secs; lastShadowRenders = sr; raf0 = now; rafCount = 0; }
    const c = renderer.domElement;
    return {
      gpu: profile?.renderer || '', gpuShort: shortGpuName(profile?.renderer), gpuClass: profile?.gpuClass, backend,
      displayHz: lp?.displayHz ? Math.round(lp.displayHz) : null, fpsCap: lp?.fps ?? null, loopState: lp?.state,
      fps: Math.round(fpsR * 10) / 10,
      intervalMs: { p50: pct(iv, 0.5), p95: pct(iv, 0.95), max: Math.max(0, ...iv) },
      missRate: iv.length ? iv.filter((x) => x > budget * 1.5).length / iv.length : 0,
      cpuMs: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95) },
      gpuMs: gpu.length ? { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95) } : null,
      drawCalls: calls.length ? calls[calls.length - 1] : 0, drawCallsP95: pct(calls, 0.95),
      triangles: tris.length ? tris[tris.length - 1] : 0,
      programs: info.programs?.length ?? info.memory?.programs ?? null,
      geometries: info.memory?.geometries ?? null, textures: info.memory?.textures ?? null,
      buffer: `${c.width}×${c.height}`, dpr: Math.round(renderer.getPixelRatio() * 100) / 100,
      shadowRendersPerS: Math.round(shadowPerS * 10) / 10,
      quality: governor?.state?.() ?? null,
      frames: renderedCount,
    };
  }

  function draw() {
    if (!el) return;
    const s = snapshot(), q = s.quality;
    const warn = /SwiftShader|llvmpipe|Basic Render/i.test(s.gpu) ? '  ⚠ SOFTWARE RENDERER — numbers are meaningless' : (s.gpuClass === 'integrated' ? '  (integrated)' : '');
    el.textContent =
      `${s.gpuShort}${warn}\n`
      + `${s.backend}  display ${s.displayHz ?? '?'} Hz  cap ${s.fpsCap || 'off'}  ${s.loopState}\n`
      + `fps ${r1(s.fps)}  frame p50 ${r1(s.intervalMs.p50)} p95 ${r1(s.intervalMs.p95)} max ${r1(s.intervalMs.max)} ms  miss ${Math.round(s.missRate * 100)}%\n`
      + `cpu ${r1(s.cpuMs.p50)} / ${r1(s.cpuMs.p95)} ms   gpu ${s.gpuMs ? `${r1(s.gpuMs.p50)} / ${r1(s.gpuMs.p95)} ms` : 'n/a'}\n`
      + `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k  prog ${s.programs ?? '–'}  geo ${s.geometries ?? '–'}  tex ${s.textures ?? '–'}  shadow ${s.shadowRendersPerS}/s\n`
      + `buffer ${s.buffer}  dpr ${s.dpr}` + (q ? `  level ${q.index + 1}/${q.count} ${q.level?.name ?? ''}${q.locked ? ' (locked)' : ''}` : '')
      + (q?.log?.length ? '\n' + q.log.slice(-3).map((l) => `  ${l.t}s ${l.from}→${l.to} ${l.why}`).join('\n') : '');
  }

  return {
    beginFrame, endFrame, rafTick, snapshot,
    report: () => ({ ...snapshot(), ua: navigator.userAgent, time: new Date().toISOString() }),
    dispose() { el?.remove(); el = null; info.autoReset = true; },
  };
}
