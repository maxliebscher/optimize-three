import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installMeasurement } from '../skills/optimize-three/scripts/measurement.mjs';
import { createPerfHud } from '../skills/optimize-three/kit/perf-hud.js';
import { createFrameLoop } from '../skills/optimize-three/kit/frame-loop.js';

function browser() {
  let now = 0, queue = [], id = 0;
  const window = {};
  const raf = f => { queue.push({ f, id: ++id }); return id; };
  const caf = n => { queue = queue.filter(x => x.id !== n); };
  vm.runInNewContext(`(${installMeasurement.toString()})()`, {
    window, performance: { now: () => now }, requestAnimationFrame: raf,
  });
  return { window, raf, caf, clock: () => now,
    run(ticks) { for (let i = 0; i < ticks; i++) { now += 1000 / 60; const q = queue; queue = []; q.forEach(x => x.f(now)); } } };
}
for (const integration of ['none', 'kit', 'hook']) {
  for (const mode of ['static', 'demand', '30fps']) {
    test(`${integration}: ${mode} measures renders independently of 60 Hz rAF`, () => {
      const b = browser(); let frames = 0;
      const hud = integration === 'kit' ? createPerfHud({ show: false, timer: { ms: 7 }, renderer: {
        info: { reset() {}, render: { calls: 1, triangles: 12 } },
        domElement: { width: 800, height: 600 }, getPixelRatio: () => 1,
      } }) : null;
      if (hud) b.window.__perf = hud;
      const loop = createFrameLoop({ mode: mode === '30fps' ? 'continuous' : 'demand', fps: 30,
        autoVisibility: false, raf: b.raf, caf: b.caf, clock: b.clock,
        render() { frames++; if (integration === 'hook') b.window.__measure.recordRenderFrame(); },
        onFrame(s) { hud?.endFrame(s); } });
      loop.start(); b.run(60); // warmup including the initial demand frame
      b.window.__measure.reset(); const start = frames;
      for (let i = 0; i < 120; i++) {
        if (mode === 'demand' && [10, 40, 90].includes(i)) loop.invalidate();
        b.run(1);
      }
      const r = b.window.__measure.collect();
      assert.ok(Math.abs(r.rafFps - 60) < 0.01);
      if (integration === 'none') {
        assert.equal(r.renderFps, null); assert.equal(r.renderFrames, null);
        assert.equal(r.renderSource, 'unmeasured');
      } else {
        assert.equal(r.renderFrames, frames - start);
        assert.ok(Math.abs(r.renderFps - (frames - start) / 2) < 0.01);
        if (mode === 'static') assert.equal(r.renderFps, 0);
        if (mode === 'demand') assert.ok(Math.abs(r.renderFps - 1.5) < 1e-9);
        if (mode === '30fps') assert.ok(Math.abs(r.renderFps - 30) < 1);
      }
      if (integration === 'kit') assert.equal(r.perf.gpuMs.p50, 7);
    });
  }
}
test('reset excludes the warmup boundary interval and old long tasks', () => {
  const b = browser(); b.run(60); b.window.__measure.longTasks = 5;
  b.window.__measure.reset(); b.run(1);
  assert.equal(b.window.__measure.collect().rafMax, 0);
  assert.equal(b.window.__measure.collect().longTasks, 0);
});
test('legacy report FPS is retained but never substituted for measured throughput', () => {
  const b = browser(); b.window.__perf = { report: () => ({ fps: 60 }) };
  b.window.__measure.reset(); b.run(60);
  const r = b.window.__measure.collect(); assert.equal(r.renderFps, null); assert.equal(r.perf.fps, 60);
});
test('reset or replacement of kit counter is unmeasured', () => {
  for (const replace of [false, true]) {
    const b = browser(); let frames = 100;
    b.window.__perf = { report: () => ({ frames }) }; b.window.__measure.reset(); b.run(60);
    if (replace) b.window.__perf = { report: () => ({ frames: 101 }) }; else frames = 0;
    assert.equal(b.window.__measure.collect().renderFps, null);
  }
});
test('throwing report does not discard rAF measurements', () => {
  const b = browser(); b.window.__perf = { report() { throw Error('broken report'); } };
  b.window.__measure.reset(); b.run(60);
  const r = b.window.__measure.collect(); assert.equal(r.renderFps, null);
  assert.ok(r.rafFps > 59); assert.match(r.perfError, /broken report/);
});
test('hook registered only after reset cannot prove the entire window was counted', () => {
  const b = browser(); b.window.__measure.reset(); b.run(30);
  b.window.__measure.recordRenderFrame(); b.run(30);
  assert.equal(b.window.__measure.collect().renderFps, null);
  b.window.__measure.reset(); b.run(60);
  assert.equal(b.window.__measure.collect().renderFps, 0);
});
test('hook intervals describe completed frames, not observer ticks', () => {
  const b = browser(); b.window.__measure.recordRenderFrame(); b.window.__measure.reset();
  b.run(10); b.window.__measure.recordRenderFrame();
  b.run(30); b.window.__measure.recordRenderFrame();
  const r = b.window.__measure.collect();
  assert.ok(Math.abs(r.renderIntervalMs.p50 - 500) < 1e-9);
  assert.ok(Math.abs(r.rafP50 - 1000 / 60) < 1e-9);
});
