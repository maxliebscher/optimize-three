// Browser init script: keep self-contained so Playwright can serialize this function.
export function installMeasurement() {
  const iv = [], renderIv = [];
  let last = null, lastRender = null, started = performance.now();
  let renderFrames = 0, hookSeen = false, hookAtStart = false;
  let perfAtStart = null, perfOwner = null;
  const validCounter = n => Number.isSafeInteger(n) && n >= 0;
  function readPerf() {
    try { return { perf: window.__perf?.report?.() ?? null, perfError: null }; }
    catch (e) { return { perf: null, perfError: String(e?.message ?? e) }; }
  }
  const stats = values => {
    const s = [...values].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null;
    return { p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? null };
  };
  const tick = t => {
    if (last !== null) iv.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  window.__measure = {
    iv, longTasks: 0, longMs: 0,
    // Call once after the ENTIRE application frame, including all postprocessing passes.
    // Register during warmup by calling this after the first render, even in demand mode.
    recordRenderFrame() {
      hookSeen = true;
      renderFrames++;
      const now = performance.now();
      if (lastRender !== null) renderIv.push(now - lastRender);
      lastRender = now;
    },
    reset() {
      iv.length = 0; renderIv.length = 0; last = lastRender = null;
      renderFrames = 0; hookAtStart = hookSeen;
      this.longTasks = this.longMs = 0;
      perfOwner = window.__perf;
      perfAtStart = readPerf().perf;
      started = performance.now();
    },
    collect() {
      const ended = performance.now(), { perf, perfError } = readPerf();
      const elapsedMs = ended - started;
      let frames = null, renderSource = 'unmeasured', renderIntervalMs = null;
      if (elapsedMs > 0 && perfOwner === window.__perf &&
          validCounter(perfAtStart?.frames) && validCounter(perf?.frames) &&
          perf.frames >= perfAtStart.frames) {
        frames = perf.frames - perfAtStart.frames;
        renderSource = 'perf-kit-counter';
      } else if (elapsedMs > 0 && hookAtStart) {
        frames = renderFrames; renderSource = 'render-hook'; renderIntervalMs = stats(renderIv);
      }
      const raf = stats(iv);
      return {
        rafFps: iv.length ? 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length) : 0,
        rafP50: raf.p50 ?? 0, rafP95: raf.p95 ?? 0, rafMax: raf.max ?? 0,
        renderFps: frames === null ? null : frames * 1000 / elapsedMs,
        renderFrames: frames, renderSource, renderIntervalMs, measurementMs: elapsedMs,
        longTasks: this.longTasks, longTaskMs: Math.round(this.longMs),
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        perf, perfError,
      };
    },
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        // Queued warmup entries can be delivered after reset.
        if (e.startTime < started) continue;
        window.__measure.longTasks++;
        window.__measure.longMs += e.duration;
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* unsupported */ }
}
