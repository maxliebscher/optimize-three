// quality.js — quality ladder + runtime governor.
//
// A *ladder* is an ordered list of levels, best first. Each level is a plain settings object your
// apply() function understands (pixel ratio, shadow map size, MSAA samples, AO taps, far detail…).
// The governor walks the ladder from measured frame times:
//
//   down: fast  — a window is "bad" when the rendered-frame p90 is over budget, or > 12 % of frames
//                 miss (interval > 1.5 × budget), or the GPU timer says p90 > 92 % of budget.
//                 2 bad windows in a row → one step down; a miss rate > 35 % → step down at once.
//   up:   slow  — needs N calm windows (no hitch, < 2 % misses) AND headroom. Headroom comes from
//                 the GPU timer (predicted cost of the next level < 80 % of budget). Without a
//                 timer it *probes*: waits 8 s, doubling to 120 s each time a probe fails.
//   ban:        — a level that fails within 40 s of being entered is banned for 240 s, doubling.
//                 This is what stops the classic 55↔60 fps quality ping-pong.
//
// Why rendered frames and not rAF: under a 60 fps cap the rAF interval is ~16.7 ms no matter how
// much headroom exists, so "fps > 58 → raise" can never tell you there is room. Use GPU ms.
//
// Rule of the ladder: it changes COST, never LOOK. Same lighting, exposure, content, UI and text
// size on every level. Order the rungs so the least visible savings come first.

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r2 = (v) => Math.round(v * 100) / 100;

export const GOVERNOR_DEFAULTS = Object.freeze({
  warmupS: 3,          // after markReady(): ignore shader compile / upload / GPU clock ramp
  windowS: 2,          // evaluation window
  minFrames: 20,       // per window
  badP90: 1.08,        // rendered-interval p90 > budget × this → bad
  missFactor: 1.5,     // interval > budget × this = a miss
  missBad: 0.12,       // miss rate → bad window
  missPanic: 0.35,     // miss rate → step down immediately
  gpuBad: 0.92,        // gpu p90 > budget × this → bad (if timer available)
  downAfter: 2,        // consecutive bad windows to step down
  upAfter: 4,          // consecutive calm windows before trying to step up
  upHeadroom: 0.8,     // predicted next-level gpu p90 must be < budget × this
  hitchFactor: 2.4,    // any interval > budget × this makes a window "not calm"
  probeS: 8, probeMaxS: 120,
  failWithinS: 40, banS: 240, banMaxS: 3600,
  cooldownS: 2.5,      // after any change: clear windows, wait
});

/**
 * @param {object} o
 * @param {object[]} o.levels   ladder, best first. Optional per-level fields used by the governor:
 *        cost (relative GPU cost, default from `dpr`² if present) and fps (frame cap for that level).
 * @param {(level:object, index:number, prev:object|null) => void} o.apply
 * @param {number} [o.start=0]
 * @param {number} [o.targetFps=60]   budget = 1000 / targetFps (a level's own fps overrides)
 * @param {string} [o.persistKey]     localStorage key; the settled level is remembered per GPU string
 * @param {string} [o.gpuKey]         usually detectGpu().renderer
 * @param {boolean} [o.locked]        start locked (URL override / user choice)
 */
export function createGovernor(o) {
  const levels = o.levels;
  if (!levels?.length) throw new Error('createGovernor: levels required');
  const R = { ...GOVERNOR_DEFAULTS, ...(o.rules || {}) };
  const costOf = (l) => l.cost ?? (l.dpr ? l.dpr * l.dpr : 1);

  let idx = clamp(o.start ?? 0);
  let locked = !!o.locked;
  let ready = false, readyAt = Infinity, t = 0, cool = 0, holdUntil = 0;
  let bad = 0, calm = 0, enteredAt = 0, lastDir = 0;
  const probeWait = levels.map(() => R.probeS);
  const ban = levels.map(() => ({ until: 0, n: 0 }));
  const log = [];
  let win = { t: 0, iv: [], gpu: [], cpu: [] };
  let lastGpu = null;

  // persisted settle point (per GPU string)
  const store = o.persistKey ? safeStore() : null;
  if (store && !locked) {
    try {
      const saved = JSON.parse(store.getItem(o.persistKey) || 'null');
      if (saved && saved.gpu === (o.gpuKey || '') && Number.isInteger(saved.index)) idx = clamp(saved.index);
    } catch { /* ignore */ }
  }

  function clamp(i) { return Math.max(0, Math.min(levels.length - 1, i)); }
  const budgetMs = () => 1000 / (levels[idx].fps || o.targetFps || 60);

  function set(i, why) {
    i = clamp(i);
    if (i === idx && why !== 'init') return false;
    const prev = why === 'init' ? null : levels[idx];
    const from = idx;
    idx = i;
    o.apply(levels[i], i, prev);
    lastDir = Math.sign(i - from);
    enteredAt = t; cool = R.cooldownS; bad = 0; calm = 0;
    win = { t: 0, iv: [], gpu: [], cpu: [] };
    log.push({ t: r2(t), from, to: i, why });
    if (log.length > 50) log.shift();
    if (store && !locked) { try { store.setItem(o.persistKey, JSON.stringify({ gpu: o.gpuKey || '', index: i })); } catch { /* ignore */ } }
    o.onChange?.(levels[i], i, why);
    return true;
  }

  function evaluate() {
    const B = budgetMs();
    const iv = win.iv;
    const p90 = pct(iv, 0.9), max = Math.max(0, ...iv);
    const miss = iv.filter((x) => x > B * R.missFactor).length / iv.length;
    const gp90 = win.gpu.length >= 5 ? pct(win.gpu, 0.9) : null;
    const isBad = p90 > B * R.badP90 || miss > R.missBad || (gp90 !== null && gp90 > B * R.gpuBad);
    const isCalm = !isBad && miss < 0.02 && max < B * R.hitchFactor;
    win = { t: 0, iv: [], gpu: [], cpu: [] };

    if (isBad) {
      calm = 0; bad++;
      const panic = miss > R.missPanic;
      const fresh = lastDir < 0 && t - enteredAt < R.failWithinS; // we just climbed here and it fails
      if ((bad >= R.downAfter || panic || fresh) && idx < levels.length - 1) {
        if (fresh) {
          const b = ban[idx]; b.n++;
          b.until = t + Math.min(R.banMaxS, R.banS * 2 ** (b.n - 1));
          probeWait[idx] = Math.min(R.probeMaxS, probeWait[idx] * 2);
        }
        set(idx + 1, `${panic ? 'panic' : 'slow'} p90 ${r2(p90)}ms miss ${Math.round(miss * 100)}%${gp90 !== null ? ` gpu ${r2(gp90)}ms` : ''}`);
      }
      return;
    }
    bad = 0;
    if (!isCalm) { calm = 0; return; }
    calm++;
    if (idx === 0 || calm < R.upAfter) return;
    const next = idx - 1;
    if (ban[next].until > t) return;
    if (gp90 !== null || lastGpu !== null) {
      const g = gp90 ?? lastGpu;
      const predicted = g * costOf(levels[next]) / costOf(levels[idx]);
      const nb = 1000 / (levels[next].fps || o.targetFps || 60);
      if (predicted < nb * R.upHeadroom) set(next, `headroom gpu ${r2(g)}→${r2(predicted)}ms`);
    } else if (calm * R.windowS >= probeWait[next]) {
      set(next, `probe after ${probeWait[next]}s`);
    }
  }

  const api = {
    /** Feed one RENDERED frame. interval = ms since previous rendered frame. */
    sample({ interval, cpuMs = 0, gpuMs = null, stall = false, dt = interval / 1000 }) {
      if (gpuMs != null) lastGpu = gpuMs;
      t += Math.min(dt, 0.25);
      if (locked || !ready || t < readyAt || t < holdUntil) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (stall || !interval) { win = { t: 0, iv: [], gpu: [], cpu: [] }; return; }
      if (cool > 0) { cool -= dt; return; }
      win.iv.push(interval); win.cpu.push(cpuMs); if (gpuMs != null) win.gpu.push(gpuMs);
      win.t += dt;
      if (win.t >= R.windowS && win.iv.length >= R.minFrames) evaluate();
    },
    /** Call when the first real frame is on screen (after warm-up). */
    markReady() { ready = true; readyAt = t + R.warmupS; },
    /** Pause judging for s seconds (camera cut, streaming burst, level load). */
    hold(s = 2) { holdUntil = Math.max(holdUntil, t + s); win = { t: 0, iv: [], gpu: [], cpu: [] }; },
    /** Apply the starting level. Call once after the renderer exists. */
    init() { set(idx, 'init'); return api; },
    set(i, why = 'manual') { return set(i, why); },
    lock(i) { locked = true; if (i != null) set(i, 'locked'); },
    unlock() { locked = false; bad = calm = 0; },
    get index() { return idx; },
    get level() { return levels[idx]; },
    get locked() { return locked; },
    get budgetMs() { return budgetMs(); },
    state() { return { index: idx, count: levels.length, level: levels[idx], locked, ready, budgetMs: r2(budgetMs()), lastGpuMs: lastGpu && r2(lastGpu), log: log.slice(-8) }; },
    log,
  };
  return api;
}

function safeStore() { try { const s = window.localStorage; s.getItem('x'); return s; } catch { return null; } }

/**
 * Build a sensible default ladder for a Three.js scene. Order (least visible saving first):
 *   1. pixel ratio down to 1.0 on HiDPI screens (barely visible at > 1.5 device DPR)
 *   2. shadow map size, AO/SSR/bloom quality, far detail, particle density
 *   3. MSAA 4 → 2 (keep some MSAA if you use alphaToCoverage foliage)
 *   4. pixel ratio below 1.0, floor `minDpr` (0.75 default; 0.85 if thin lines/text-like detail)
 *   5. optional: drop the frame cap to a stable 30 instead of a fluctuating 40–55
 * Extend each level with your own fields (aoSamples, farDistance, crowd…).
 */
export function defaultLadder({ deviceDpr = globalThis.devicePixelRatio || 1, maxDpr = 2, minDpr = 0.75, shadow = [4096, 2048, 1024], allow30 = true } = {}) {
  const top = Math.min(deviceDpr, maxDpr);
  const L = [];
  // Rough relative GPU cost, used only to predict whether stepping up fits the budget.
  // Fill-rate dominates (dpr²); MSAA and shadow-map size add a little. Override per level if you know better.
  const est = (l) => l.dpr * l.dpr * ({ 4: 1, 2: 0.9, 0: 0.8 }[l.msaa] ?? 1) * (l.shadow >= 4096 ? 1.1 : l.shadow >= 2048 ? 1 : 0.94) * (0.85 + 0.15 * (l.detail ?? 1));
  const push = (l) => { const x = { ...l, dpr: r2(l.dpr) }; x.cost = r2(est(x)); L.push(x); };
  if (top > 1.5) push({ name: 'ultra', dpr: top, shadow: shadow[0], msaa: 4, post: 'high', detail: 1 });
  if (top > 1.0) push({ name: 'high', dpr: Math.min(top, 1.5), shadow: shadow[0], msaa: 4, post: 'high', detail: 1 });
  push({ name: 'balanced', dpr: Math.min(top, 1), shadow: shadow[1], msaa: 4, post: 'medium', detail: 0.8 });
  push({ name: 'eco', dpr: Math.min(top, 1), shadow: shadow[2], msaa: 2, post: 'low', detail: 0.6 });
  push({ name: 'low', dpr: Math.min(top, Math.max(minDpr, 0.85)), shadow: shadow[2], msaa: 2, post: 'off', detail: 0.5 });
  if (minDpr < 0.85) push({ name: 'min', dpr: Math.min(top, minDpr), shadow: shadow[2], msaa: 0, post: 'off', detail: 0.4 });
  // Same per-frame cost as the rung above; only the budget doubles. A steady 30 beats a jittery 45.
  if (allow30) push({ ...L[L.length - 1], name: L[L.length - 1].name + '@30', fps: 30 });
  return L;
}

/** Map a detectGpu() tier to a starting index on a ladder built by defaultLadder(). */
export function startIndexForTier(levels, tier) {
  const want = { high: ['high', 'ultra', 'balanced'], mid: ['balanced', 'high', 'eco'], low: ['eco', 'low', 'balanced'] }[tier] || ['balanced'];
  for (const n of want) { const i = levels.findIndex((l) => l.name === n); if (i >= 0) return i; }
  return Math.floor(levels.length / 2);
}
