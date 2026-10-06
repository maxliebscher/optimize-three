// optimize-three kit — one call wires the loop, governor, GPU timer, shadow cache, HUD, GPU hint,
// context loss and page lifecycle. Every piece is also usable on its own (see the other files).
//
//   import { detectGpu, createRenderer, createPerfKit, defaultLadder, startIndexForTier,
//            setShadowMapSize, applyPixelRatio, warmup } from './kit/index.js';
//
//   const profile = detectGpu();
//   const { renderer } = await createRenderer({ canvas, backend: profile.overrides.backend || 'webgl' });
//   const levels = defaultLadder();
//   const kit = createPerfKit({
//     renderer, scene, camera, profile, levels,
//     start: startIndexForTier(levels, profile.tier),
//     apply: (l) => { applyPixelRatio(renderer, l.dpr); setShadowMapSize(sun, l.shadow, renderer); },
//     render: ({ dt }) => { controls.update(dt); renderer.render(scene, camera); },
//   });
//   await warmup({ renderer, scene, camera });   // behind the loading screen
//   kit.start(); kit.ready();                    // ready() = first real frame, governor starts judging

export * from './gpu-profile.js';
export * from './frame-loop.js';
export * from './quality.js';
export * from './gpu-timer.js';
export * from './shadow-cache.js';
export * from './perf-hud.js';
export * from './gpu-hint.js';
export * from './renderer.js';
export * from './warmup.js';
export * from './lifecycle.js';

import { detectGpu } from './gpu-profile.js';
import { createFrameLoop } from './frame-loop.js';
import { createGovernor } from './quality.js';
import { createGpuTimer } from './gpu-timer.js';
import { createShadowCache } from './shadow-cache.js';
import { createPerfHud } from './perf-hud.js';
import { createGpuHint } from './gpu-hint.js';
import { handleContextLoss, bindPageLifecycle } from './lifecycle.js';

/**
 * @param {object} o
 * @param {any} o.renderer
 * @param {THREE.Scene} o.scene
 * @param {THREE.Camera} o.camera
 * @param {(f:object) => (boolean|void)} o.render   draws the frame (call renderer.render / pipeline here)
 * @param {(dt:number) => void} [o.update]          fixed-step simulation (optional)
 * @param {object[]} o.levels                       quality ladder, best first
 * @param {(level:object, index:number, prev:object|null) => void} o.apply
 * @param {number} [o.start]                        starting level index
 * @param {'continuous'|'demand'} [o.mode]
 * @param {number} [o.fps=60]                       default cap (a level's fps overrides)
 * @param {boolean|'manual'} [o.shadows=true]       shadow cache; 'manual' = you call kit.shadows.update()
 * @param {object} [o.profile]                      detectGpu() result
 * @param {string} [o.persistKey='optimize-three.quality']
 * @param {boolean} [o.gpuHint=true]
 * @param {boolean} [o.expose=true]                 window.__perf for scripts/QA
 */
export function createPerfKit(o) {
  const { renderer, scene, camera } = o;
  const profile = o.profile || detectGpu();
  const ov = profile.overrides || {};
  const baseFps = ov.bench ? 0 : ov.fps ?? o.fps ?? 60;

  const timer = createGpuTimer(renderer, { every: ov.bench ? 1 : 2 });
  const shadows = o.shadows === false || !renderer.shadowMap?.enabled && o.shadows !== 'manual'
    ? null : createShadowCache({ renderer, scene, camera, roots: o.shadowRoots });

  let loop = null;
  const governor = createGovernor({
    levels: o.levels,
    start: o.start ?? 0,
    targetFps: baseFps || 60,
    persistKey: o.persistKey ?? 'optimize-three.quality',
    gpuKey: profile.renderer,
    locked: !!(ov.tier || ov.dpr || ov.bench || o.locked),
    rules: o.rules,
    apply(level, i, prev) {
      const l = ov.dpr ? { ...level, dpr: ov.dpr } : level;
      o.apply(l, i, prev);
      loop?.setFps(ov.fps != null || ov.bench ? baseFps : (level.fps || baseFps));
      shadows?.invalidate();
      loop?.invalidate();
    },
    onChange: o.onQualityChange,
  });

  const hud = createPerfHud({ renderer, profile, loop: () => loop, governor, timer, shadowCache: shadows, show: !!ov.perf || !!o.hud });
  const hint = o.gpuHint === false ? null : createGpuHint({ profile });

  loop = createFrameLoop({
    fps: baseFps,
    mode: o.mode || 'continuous',
    observe: o.observe ?? renderer.domElement,
    update: o.update,
    render(f) {
      timer.poll();
      hud.beginFrame();
      if (shadows && o.shadows !== 'manual') shadows.update();
      timer.begin();
      let again;
      try { again = o.render(f); } finally { timer.end(); }
      return again;
    },
    onFrame(s) {
      governor.sample({ interval: s.interval, cpuMs: s.cpuMs, gpuMs: timer.ms, stall: s.stall });
      hud.endFrame(s);
      hint?.sample(s.interval);
      o.onFrame?.(s);
    },
    onState: o.onState,
  });
  governor.init();
  if (ov.bench) loop.setFps(0);

  const unbindLoss = handleContextLoss(renderer, { loop, shadowCache: shadows, ...(o.contextLoss || {}) });
  const page = o.lifecycle === false ? null : bindPageLifecycle({ renderer, scene, loop, extraDispose: () => { unbindLoss(); hud.dispose(); timer.dispose(); } });

  const kit = {
    profile, loop, governor, timer, shadows, hud,
    start() { loop.start(); return kit; },
    /** first real frame is on screen (after warm-up/loading) → governor starts judging */
    ready() { governor.markReady(); return kit; },
    invalidate: () => loop.invalidate(),
    wake: (ms) => loop.wake(ms),
    report: () => ({ ...hud.report(), profile: { renderer: profile.renderer, gpuClass: profile.gpuClass, tier: profile.tier, why: profile.why } }),
    dispose: () => page?.dispose(),
  };
  if (o.expose !== false && typeof window !== 'undefined') window.__perf = kit;
  return kit;
}
