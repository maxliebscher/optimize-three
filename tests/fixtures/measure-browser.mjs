// Deterministic Playwright boundary for CLI/JSON regressions, not a hardware benchmark.
import vm from 'node:vm';
import { createFrameLoop } from '../../skills/optimize-three/kit/frame-loop.js';
import { createPerfHud } from '../../skills/optimize-three/kit/perf-hud.js';
export const chromium = {
  async launch() {
    let now = 0, q = [], id = 0;
    const raf = f => { q.push({ id: ++id, f }); return id; };
    const window = {};
    const gpu = { getExtension: () => null, getParameter: () => 'Fixture Hardware GPU' };
    const context = vm.createContext({ window, performance: { now: () => now }, requestAnimationFrame: raf,
      document: { createElement: () => ({ getContext: () => gpu }) } });
    const page = {
      on() {},
      async addInitScript(fn) { vm.runInContext(`(${fn.toString()})()`, context); },
      async evaluate(fn) { return vm.runInContext(`(${fn.toString()})()`, context); },
      async goto(url) {
        const source = new URL(url).searchParams.get('source'), mode = new URL(url).pathname.slice(1);
        const hud = source === 'kit' ? createPerfHud({ show: false, timer: { ms: 7 }, renderer: {
          info: { reset() {}, render: { calls: 2, triangles: 100 } },
          domElement: { width: 800, height: 600 }, getPixelRatio: () => 1,
        } }) : null;
        if (hud) window.__perf = hud;
        const loop = createFrameLoop({ mode: mode === '30fps' ? 'continuous' : 'demand', fps: 30,
          autoVisibility: false, raf, caf: n => { q = q.filter(x => x.id !== n); }, clock: () => now,
          render: () => { if (source === 'hook') window.__measure.recordRenderFrame(); },
          onFrame: s => hud?.endFrame(s) });
        loop.start();
        this.loop = loop; this.mode = mode;
      },
      async waitForTimeout(ms) {
        const end = now + ms;
        while (now + 1000 / 60 <= end + 1e-6) {
          now += 1000 / 60;
          if (this.mode === 'demand' && now > 1000 && Math.round(now) % 500 === 0) this.loop.invalidate();
          const batch = q; q = []; batch.forEach(x => x.f(now));
        }
        now = end;
      },
    };
    return { newContext: async () => ({ newPage: async () => page }), close: async () => {} };
  },
};
