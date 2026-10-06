// frame-loop.js — one loop that does the boring things right.
//
//  * Frame cap with EVEN pacing: renders every n-th vsync (n = round(capPeriod / vsync)), so a
//    30 fps cap on a 60 Hz screen is 33/33/33 ms, never a 16/33/16/50 mix. A 60 cap on a 144 Hz
//    screen becomes an even 72. Always stays on rAF (a setTimeout before rAF misses vsyncs and
//    can halve the frame rate).
//  * Frame-rate independent time: render dt clamped (default 0.1 s), optional fixed-step
//    simulation with an accumulator, max sub-steps and dropped backlog (no spiral of death).
//  * Two modes: 'continuous' (games, films) and 'demand' (configurators, viewers): sleeps when
//    nothing changes, wakes on invalidate()/wake(ms) or when render() returns true.
//  * Suspends on hidden tab, off-screen canvas (IntersectionObserver), manual pause or context
//    loss — each as a separate *reason*, so a manual pause is never undone by a tab switch.
//    Resume never produces a time jump.
//  * Manual stepping for deterministic capture/tests: setManual(true) + step(ms).

const now0 = () => performance.now();

/**
 * @param {object} o
 * @param {(f:{now:number, dt:number, alpha:number, interval:number, frame:number, stall:boolean}) => (boolean|void)} o.render
 *        Draw one frame. In 'demand' mode return true to keep animating.
 * @param {(dt:number) => void} [o.update]  fixed-step simulation (called 0..maxSubSteps times per frame)
 * @param {number} [o.fps=60]   frame cap; 0 = uncapped (measuring only)
 * @param {'continuous'|'demand'} [o.mode='continuous']
 * @param {Element} [o.observe] element whose visibility in the viewport gates rendering
 * @param {(s:{now:number, interval:number, cpuMs:number, stall:boolean}) => void} [o.onFrame]  stats per rendered frame
 * @param {(state:'running'|'idle'|'suspended', reasons:string[]) => void} [o.onState]
 */
export function createFrameLoop(o) {
  const {
    render, update = null, mode = 'continuous', observe = null,
    simStep = 1 / 60, maxSubSteps = 6, maxFrameDt = 0.1, maxCatchUp = 0.25, stallMs = 250,
    autoVisibility = true, onFrame = null, onState = null,
    raf = (f) => requestAnimationFrame(f), caf = (id) => cancelAnimationFrame(id), clock = now0,
  } = o;

  let fps = o.fps ?? 60;
  let handle = null, lastRaf = -1, lastRender = null, acc = 0, frameNo = 0;
  let dirty = mode === 'continuous', wakeUntil = 0, wantMore = false, manual = false, inFrame = false;
  let state = 'idle';
  const reasons = new Set();

  // vsync estimate: 25th percentile of recent rAF intervals (robust against dropped frames)
  const rafIv = new Float32Array(60); let rafN = 0, rafI = 0, vsync = 0;
  function noteRaf(iv) {
    if (iv <= 0 || iv > 100) return;
    rafIv[rafI] = iv; rafI = (rafI + 1) % rafIv.length; rafN = Math.min(rafN + 1, rafIv.length);
    if (rafN >= 10 && (frameNo % 30 === 0 || !vsync)) {
      const s = Array.from(rafIv.subarray(0, rafN)).sort((a, b) => a - b);
      vsync = Math.max(4, s[Math.floor(s.length * 0.25)]);
    }
  }

  function setState(s) { if (s !== state) { state = s; onState?.(s, [...reasons]); } }

  function needsFrame() {
    if (mode === 'continuous') return true;
    return dirty || wantMore || clock() < wakeUntil;
  }

  function schedule() {
    if (manual || reasons.size || handle !== null || inFrame) return;
    if (!needsFrame()) { setState('idle'); lastRaf = -1; return; }
    handle = raf(tick);
  }

  function dueNow(t) {
    if (!fps || lastRender === null) return true;
    const period = 1000 / fps;
    if (vsync) {
      const n = Math.max(1, Math.round(period / vsync));
      return t - lastRender >= (n - 0.5) * vsync;
    }
    return t - lastRender >= period - 1.5;
  }

  function tick(t) {
    handle = null;
    if (reasons.size) return;
    if (lastRaf >= 0) noteRaf(t - lastRaf);
    lastRaf = t;
    if (!dueNow(t)) { schedule(); return; }
    runFrame(t);
    schedule();
  }

  function runFrame(t) {
    const interval = lastRender === null ? 0 : t - lastRender;
    const stall = interval > stallMs;
    // After idle/resume the first frame gets dt = 0 instead of the whole sleep time.
    const rawDt = lastRender === null || stall ? 0 : interval / 1000;
    lastRender = t;
    frameNo++;
    setState('running');
    const c0 = clock();
    inFrame = true;
    let again = false;
    try {
      let alpha = 1;
      if (update) {
        acc += Math.min(rawDt, maxCatchUp);
        let n = 0;
        while (acc + 1e-9 >= simStep && n < maxSubSteps) { update(simStep); acc -= simStep; n++; }
        if (acc >= simStep) acc %= simStep; // drop backlog instead of catching up forever
        alpha = acc / simStep;
      }
      dirty = false;
      again = render({ now: t, dt: Math.min(rawDt, maxFrameDt), alpha, interval, frame: frameNo, stall }) === true;
    } finally {
      inFrame = false;
    }
    wantMore = again;
    onFrame?.({ now: t, interval, cpuMs: clock() - c0, stall });
  }

  // ---- suspend reasons ----
  function suspend(reason = 'manual') {
    reasons.add(reason);
    if (handle !== null) { caf(handle); handle = null; }
    setState('suspended');
  }
  function resume(reason = 'manual') {
    if (!reasons.delete(reason)) return;
    if (reasons.size) return;
    lastRender = null; lastRaf = -1; acc = 0; // no time jump, no catch-up
    dirty = true;
    schedule();
  }

  let io = null;
  const onVis = () => (document.hidden ? suspend('hidden') : resume('hidden'));
  if (autoVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
    if (document.hidden) reasons.add('hidden');
  }
  if (observe && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((e) => (e[e.length - 1].isIntersecting ? resume('offscreen') : suspend('offscreen')));
    io.observe(observe);
  }

  const api = {
    /** Request a frame (demand mode). Cheap to call many times per event. */
    invalidate() { dirty = true; schedule(); },
    /** Keep rendering for ms (transitions, damped controls settling). */
    wake(ms = 700) { wakeUntil = Math.max(wakeUntil, clock() + ms); schedule(); },
    start() { reasons.delete('stopped'); dirty = true; schedule(); return api; },
    stop() { suspend('stopped'); },
    suspend, resume,
    setFps(v) { fps = v; },
    get fps() { return fps; },
    get vsyncMs() { return vsync; },
    get displayHz() { return vsync ? 1000 / vsync : 0; },
    get state() { return state; },
    get reasons() { return [...reasons]; },
    get frame() { return frameNo; },
    /** Deterministic capture/tests: stop rAF and drive frames yourself. */
    setManual(on) { manual = !!on; if (manual && handle !== null) { caf(handle); handle = null; } if (!manual) { lastRender = null; schedule(); } },
    /** Advance exactly ms of virtual time and render one frame (use with setManual(true)). */
    step(ms = 1000 / 60) {
      const t = lastRender === null ? clock() : lastRender + ms;
      if (lastRender === null) { lastRender = t - ms; }
      runFrame(t);
    },
    dispose() {
      suspend('disposed');
      if (autoVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
    },
  };
  return api;
}

/**
 * Bind common input events to a demand loop so it wakes on interaction.
 * Listeners are passive. Returns an unbind function.
 */
export function wakeOnInput(loop, target, ms = 900) {
  const on = () => loop.wake(ms);
  const evs = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'];
  for (const e of evs) target.addEventListener(e, on, { passive: true });
  addEventListener('resize', on, { passive: true });
  return () => { for (const e of evs) target.removeEventListener(e, on); removeEventListener('resize', on); };
}
