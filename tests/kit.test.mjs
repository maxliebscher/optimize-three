// node --test tests/   (no dependencies; kit modules that import 'three' are not loaded here)
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGpu, shortGpuName, readOverrides } from '../skills/optimize-three/kit/gpu-profile.js';
import { createGovernor, defaultLadder, startIndexForTier } from '../skills/optimize-three/kit/quality.js';
import { createFrameLoop } from '../skills/optimize-three/kit/frame-loop.js';

test('classifyGpu: real-world renderer strings', () => {
  const c = (s, o) => classifyGpu(s, o);
  assert.equal(c('ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)').gpuClass, 'integrated');
  assert.equal(c('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)').tier, 'low');
  assert.equal(c('ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)').gpuClass, 'integrated', 'Meteor Lake iGPU is not a discrete Arc');
  assert.equal(c('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)').gpuClass, 'discrete');
  assert.equal(c('ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)').tier, 'high');
  assert.equal(c('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU (0x0000249C) Direct3D11 vs_5_0 ps_5_0, D3D11)').tier, 'high');
  assert.equal(c('ANGLE (AMD, AMD Radeon(TM) Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)').gpuClass, 'integrated');
  assert.equal(c('ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)').gpuClass, 'discrete');
  assert.equal(c('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)').tier, 'mid');
  assert.equal(c('ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)').tier, 'high');
  assert.equal(c('Apple GPU').gpuClass, 'apple');
  assert.equal(c('Apple GPU', { mobile: true }).gpuClass, 'mobile');
  assert.equal(c('Adreno (TM) 740').gpuClass, 'mobile');
  assert.equal(c('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)').gpuClass, 'software');
  assert.equal(c('llvmpipe (LLVM 15.0.7, 256 bits)').tier, 'low');
  assert.equal(c('Intel(R) HD Graphics').gpuClass, 'integrated', 'Firefox sanitized bucket');
  assert.equal(c('').tier, 'mid');
});

test('shortGpuName strips the ANGLE wrapper', () => {
  assert.equal(shortGpuName('ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Intel UHD Graphics');
  assert.equal(shortGpuName('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), 'Apple M2');
  assert.equal(shortGpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU (0x0000249C) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 3080 Laptop GPU');
});

test('readOverrides', () => {
  const o = readOverrides('?q=low&dpr=1.25&fps=30&perf&backend=webgpu&aa=0');
  assert.deepEqual([o.tier, o.dpr, o.fps, o.perf, o.backend, o.aa], ['low', 1.25, 30, true, 'webgpu', false]);
  assert.equal(readOverrides('?q=banana').tier, null);
});

test('defaultLadder: ordered, floors respected, @30 rung keeps per-frame cost', () => {
  const L = defaultLadder({ deviceDpr: 2, maxDpr: 2, minDpr: 0.75 });
  assert.deepEqual(L.map((l) => l.name), ['ultra', 'high', 'balanced', 'eco', 'low', 'min', 'min@30']);
  for (let i = 1; i < L.length - 1; i++) assert.ok(L[i].cost <= L[i - 1].cost, `cost decreases at ${L[i].name}`);
  assert.equal(L.at(-1).fps, 30);
  assert.equal(L.at(-1).cost, L.at(-2).cost);
  assert.equal(Math.min(...L.map((l) => l.dpr)), 0.75);
  const L1 = defaultLadder({ deviceDpr: 1 });
  assert.equal(L1[0].name, 'balanced');
  assert.equal(startIndexForTier(L, 'high'), 1);
  assert.equal(startIndexForTier(L, 'low'), 3);
});

// Drive the governor with synthetic frames: gpu cost scales with the level's cost.
function sim(gov, levels, { baseGpuMs, seconds, cpuMs = 2 }) {
  for (let t = 0; t < seconds * 60; t++) {
    const l = levels[gov.index];
    const budget = 1000 / (l.fps || 60);
    const gpu = baseGpuMs * l.cost;
    const frame = Math.max(gpu, cpuMs);
    // frames that don't fit the budget take the next vsync multiple
    const interval = Math.ceil(frame / 16.667 - 1e-9) * 16.667;
    gov.sample({ interval: Math.max(interval, budget), cpuMs, gpuMs: gpu });
  }
}

test('governor steps down under load, settles, and does not oscillate', () => {
  const levels = defaultLadder({ deviceDpr: 2 });
  const applied = [];
  const gov = createGovernor({ levels, start: 1, apply: (l, i) => applied.push(i) }).init();
  gov.markReady();
  sim(gov, levels, { baseGpuMs: 26, seconds: 60 });
  const settled = gov.index;
  assert.ok(settled > 1, 'stepped down');
  const changesBefore = gov.log.length;
  sim(gov, levels, { baseGpuMs: 26, seconds: 600 });
  assert.ok(gov.log.length - changesBefore <= 2, `stable after settling (changes: ${gov.log.slice(changesBefore).map((e) => e.why).join(' | ')})`);
});

test('governor climbs back when load drops (GPU-timer headroom)', () => {
  const levels = defaultLadder({ deviceDpr: 2 });
  const gov = createGovernor({ levels, start: 4, apply() {} }).init();
  gov.markReady();
  sim(gov, levels, { baseGpuMs: 4, seconds: 120 });
  // 'high' (dpr 1.5) predicts ~10 ms → fits; 'ultra' (dpr 2) predicts ~18 ms → must NOT be tried
  assert.equal(gov.index, 1, `climbed to ${gov.index}`);
});

test('governor without GPU timer probes upward and bans a failing level', () => {
  const levels = defaultLadder({ deviceDpr: 2 });
  const gov = createGovernor({ levels, start: 3, apply() {} }).init();
  gov.markReady();
  // level 2 (balanced) is just too expensive; 3 is fine. No gpuMs → probing.
  for (let t = 0; t < 600 * 60; t++) {
    const interval = gov.index <= 2 ? 25 : 16.667;
    gov.sample({ interval });
  }
  const ups = gov.log.filter((e) => e.why.startsWith('probe')).length;
  assert.ok(ups >= 1 && ups <= 5, `probes limited by back-off/ban (${ups})`);
  assert.equal(gov.index, 3);
});

test('locked governor never changes level', () => {
  const levels = defaultLadder({ deviceDpr: 1 });
  const gov = createGovernor({ levels, start: 0, locked: true, apply() {} }).init();
  gov.markReady();
  sim(gov, levels, { baseGpuMs: 40, seconds: 60 });
  assert.equal(gov.index, 0);
});

// Fake rAF clock for the loop
function fakeRaf(hz = 60) {
  let t = 0, q = [], id = 0;
  return {
    raf: (f) => { q.push({ f, id: ++id }); return id; },
    caf: (i) => { q = q.filter((x) => x.id !== i); },
    clock: () => t,
    run(ms) { const end = t + ms; while (t < end) { t += 1000 / hz; const b = q; q = []; for (const x of b) x.f(t); } },
  };
}

test('frame loop: 30 fps cap on 144 Hz is evenly paced', () => {
  const R = fakeRaf(144), iv = [];
  const loop = createFrameLoop({ fps: 30, autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, render: () => {}, onFrame: (s) => s.interval && iv.push(s.interval) });
  loop.start(); R.run(3000);
  const tail = iv.slice(20);
  const min = Math.min(...tail), max = Math.max(...tail);
  assert.ok(max - min < 0.5, `even pacing (${min.toFixed(2)}..${max.toFixed(2)})`);
  assert.ok(Math.abs(1000 / (tail.reduce((a, b) => a + b) / tail.length) - 28.8) < 1, 'every 5th vsync = 28.8 fps on 144 Hz');
});

test('frame loop: 60 cap on 60 Hz renders every vsync; uncapped follows display', () => {
  const R = fakeRaf(60); let n = 0;
  const loop = createFrameLoop({ fps: 60, autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, render: () => { n++; } });
  loop.start(); R.run(1000);
  assert.ok(n >= 58, `${n} frames`);
});

test('frame loop: demand mode sleeps, wakes, keeps going while render returns true', () => {
  const R = fakeRaf(60); let n = 0, moving = 0;
  const loop = createFrameLoop({ mode: 'demand', autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, render: () => { n++; return moving-- > 0; } });
  loop.start(); R.run(500);
  assert.equal(n, 1, 'one frame, then idle');
  assert.equal(loop.state, 'idle');
  for (let i = 0; i < 10; i++) loop.invalidate();
  R.run(500);
  assert.equal(n, 2, 'invalidations coalesce');
  moving = 10; loop.invalidate(); R.run(1000);
  assert.equal(n, 2 + 11);
});

test('frame loop: suspend reasons are independent, resume has no time jump', () => {
  const R = fakeRaf(60); const dts = [];
  const loop = createFrameLoop({ autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, render: (f) => { dts.push(f.dt); } });
  loop.start(); R.run(200);
  loop.suspend('manual'); loop.suspend('hidden');
  R.run(5000);
  const before = dts.length;
  loop.resume('hidden'); R.run(200);
  assert.equal(dts.length, before, 'manual pause survives tab becoming visible');
  loop.resume('manual'); R.run(100);
  assert.equal(dts[before], 0, 'first frame after resume has dt = 0');
  assert.ok(Math.max(...dts) <= 0.1, 'dt clamped');
});

test('frame loop: fixed-step simulation is frame-rate independent', () => {
  for (const hz of [30, 60, 144]) {
    const R = fakeRaf(hz); let simT = 0;
    const loop = createFrameLoop({ fps: 0, autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, update: (dt) => { simT += dt; }, render: () => {} });
    loop.start(); R.run(2000);
    assert.ok(Math.abs(simT - 2) < 0.05, `${hz} Hz → sim time ${simT.toFixed(3)}`);
  }
});

test('frame loop: manual stepping for deterministic capture', () => {
  const R = fakeRaf(60); const ts = [];
  const loop = createFrameLoop({ autoVisibility: false, raf: R.raf, caf: R.caf, clock: R.clock, render: (f) => { ts.push(f.dt); } });
  loop.setManual(true);
  for (let i = 0; i < 5; i++) loop.step(1000 / 30);
  assert.deepEqual(ts.map((d) => Math.round(d * 1000)), [33, 33, 33, 33, 33]);
});
