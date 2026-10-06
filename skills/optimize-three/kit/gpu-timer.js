// gpu-timer.js — non-blocking GPU frame time.
//
// WebGL2: EXT_disjoint_timer_query_webgl2. Rules learned the hard way:
//   - only ONE query may be active at a time (no nesting) → one query per frame, or a push/pop stack
//   - never wait for a result: poll QUERY_RESULT_AVAILABLE on later frames
//   - discard results when GPU_DISJOINT_EXT is set (clock change, context switch)
//   - cap pending queries; if the driver never answers, give up (some return nothing)
//   - availability: Chrome desktop usually yes; Firefox/Safari usually no → design for null
// WebGPURenderer: create it with { trackTimestamp: true }; this wrapper resolves timestamps
// asynchronously and reads renderer.info.render.timestamp.
//
// gl.finish() is NOT a timer under ANGLE/D3D11 — it does not reliably block. Don't use it.

/**
 * @param {object} renderer  THREE.WebGLRenderer or THREE.WebGPURenderer
 * @param {{every?:number, maxPending?:number}} [o]  measure every n-th frame (default 2)
 */
export function createGpuTimer(renderer, { every = 2, maxPending = 4 } = {}) {
  if (renderer?.isWebGPURenderer) return createWebGPUTimer(renderer, { every });
  const gl = renderer?.getContext?.();
  const ext = gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  let frame = 0, active = null, last = null, ema = null, dead = !ext, givenUp = 0;
  const pending = [], pool = [];

  return {
    get available() { return !dead; },
    /** last measured GPU ms (or null) */
    get ms() { return last; },
    get emaMs() { return ema; },
    begin() {
      frame++;
      if (dead || active || frame % every || pending.length >= maxPending) return;
      const q = pool.pop() || gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      active = q;
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active); active = null;
    },
    /** call once per frame (e.g. before begin); returns newest ms or null */
    poll() {
      if (dead) return null;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      let got = null;
      while (pending.length) {
        const q = pending[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        pending.shift(); pool.push(q);
        if (!disjoint) got = ns / 1e6;
      }
      if (got !== null) { last = got; ema = ema === null ? got : ema + (got - ema) * 0.15; givenUp = 0; }
      else if (pending.length >= maxPending && ++givenUp > 600) dead = true; // driver never answers
      return got;
    },
    dispose() { for (const q of [...pending, ...pool]) gl?.deleteQuery(q); pending.length = pool.length = 0; dead = true; },
  };
}

function createWebGPUTimer(renderer, { every }) {
  // Requires: new WebGPURenderer({ trackTimestamp: true }) and a backend with 'timestamp-query'.
  let frame = 0, last = null, ema = null, busy = false;
  const ok = () => !!renderer.backend?.trackTimestamp || renderer.trackTimestamp === true;
  return {
    get available() { return ok(); },
    get ms() { return last; },
    get emaMs() { return ema; },
    begin() { frame++; },
    end() {
      if (!ok() || busy || frame % every) return;
      busy = true;
      Promise.resolve(renderer.resolveTimestampsAsync?.('render'))
        .then(() => {
          const v = renderer.info?.render?.timestamp;
          if (Number.isFinite(v) && v > 0) { last = v; ema = ema === null ? v : ema + (v - ema) * 0.15; }
        })
        .catch(() => {})
        .finally(() => { busy = false; });
    },
    poll() { return last; },
    dispose() {},
  };
}
