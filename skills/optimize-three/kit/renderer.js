// renderer.js — create the renderer with sane defaults, plus small helpers that are easy to get wrong.
//
// Backend policy (see references/renderer-and-backend.md):
//   - Default: WebGLRenderer. It is the most compatible option and, in our measurements on Intel
//     iGPUs, WebGPU gave ~30 vs ~28 fps — not worth a rewrite by itself.
//   - WebGPU when the project needs compute (GPGPU particles, simulation, culling), storage
//     buffers or TSL, and is written with node materials. Never make WebGPU the only way in.
//   - 'auto' only if every material works on both (built-in or TSL/node materials). ShaderMaterial,
//     RawShaderMaterial, onBeforeCompile and EffectComposer do NOT run on WebGPURenderer.

import * as THREE from 'three';

const isDevHost = () => typeof location !== 'undefined' && (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || /[?&]shaderlog\b/.test(location.search));

/**
 * @param {object} o
 * @param {HTMLCanvasElement} [o.canvas]
 * @param {'webgl'|'webgpu'|'auto'} [o.backend='webgl']
 * @param {boolean} [o.antialias]   default-framebuffer MSAA. Turn OFF if you render through a
 *        post-processing chain — then put MSAA on the scene render target instead (samples: 4).
 * @param {'high-performance'|'low-power'|'default'} [o.powerPreference='high-performance']
 *        Only a hint. Chrome/Windows ignores it on hybrid laptops; see gpu-hint.js. Use 'low-power'
 *        for small embedded widgets that mostly sleep.
 * @param {boolean} [o.trackTimestamp] WebGPU GPU timing (for gpu-timer.js)
 * @param {boolean} [o.checkShaderErrors] default: only on localhost / ?shaderlog. In production
 *        every check is a synchronous getProgramParameter round trip (measured 0.2–0.3 s each).
 * @returns {Promise<{renderer:any, backend:'webgl'|'webgpu'|'webgpu-on-webgl2', canvas:HTMLCanvasElement}>}
 */
export async function createRenderer(o = {}) {
  let canvas = o.canvas || document.createElement('canvas');
  const want = o.backend || 'webgl';
  const common = {
    canvas,
    antialias: o.antialias ?? false,
    powerPreference: o.powerPreference || 'high-performance',
    alpha: o.alpha ?? false,
    stencil: o.stencil ?? false,
    depth: true,
    premultipliedAlpha: o.premultipliedAlpha ?? true,
    // Needed only for canvas.toBlob screenshots outside the frame; costs a copy every frame.
    preserveDrawingBuffer: o.preserveDrawingBuffer ?? false,
    reversedDepthBuffer: o.reversedDepthBuffer ?? false,
    logarithmicDepthBuffer: o.logarithmicDepthBuffer ?? false,
  };

  if (want === 'webgpu' || want === 'auto') {
    const ok = await webgpuUsable();
    if (ok || want === 'webgpu') {
      try {
        const W = await import('three/webgpu');
        const r = new W.WebGPURenderer({ ...common, trackTimestamp: !!o.trackTimestamp, forceWebGL: !ok, ...(o.webgpu || {}) });
        await r.init();
        const backend = r.backend?.isWebGPUBackend ? 'webgpu' : 'webgpu-on-webgl2';
        r.setPixelRatio(Math.min(devicePixelRatio, o.maxDpr ?? 2));
        return { renderer: r, backend, canvas };
      } catch (err) {
        console.warn('[optimize-three] WebGPU init failed, falling back to WebGL:', err);
        // A canvas whose context type was claimed cannot be reused for WebGL.
        const fresh = canvas.cloneNode(false);
        canvas.replaceWith?.(fresh);
        canvas = fresh;
        common.canvas = canvas;
      }
    }
  }

  const r = new THREE.WebGLRenderer(common);
  r.debug.checkShaderErrors = o.checkShaderErrors ?? isDevHost();
  r.setPixelRatio(Math.min(devicePixelRatio, o.maxDpr ?? 2));
  return { renderer: r, backend: 'webgl', canvas };
}

/** True when a real (non-fallback) WebGPU adapter exists. */
export async function webgpuUsable() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!a && !(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
  } catch { return false; }
}

/**
 * Change a light's shadow map size correctly. Setting mapSize alone does nothing once the map
 * exists — the old render target must be disposed and nulled so three reallocates it.
 */
export function setShadowMapSize(light, size, renderer) {
  const s = light.shadow;
  if (!s || (s.mapSize.x === size && s.mapSize.y === size)) return false;
  s.map?.dispose?.();
  s.map = null;
  s.mapSize.set(size, size);
  if (renderer) renderer.shadowMap.needsUpdate = true;
  return true;
}

/**
 * Pixel ratio capped by a pixel budget instead of a constant: big windows get a lower ratio,
 * small ones can supersample. 1.8 MP ≈ 1080p, 2.4 MP for still frames, 1.0–1.5 MP for iGPU motion.
 */
export function budgetedPixelRatio(dpr, cssW, cssH, maxPixels = 2.4e6, floor = 0.5) {
  const px = Math.max(1, cssW * cssH);
  return Math.max(floor, Math.min(dpr, Math.sqrt(maxPixels / px)));
}

/**
 * Apply a pixel ratio to renderer + post chain + any render targets that follow the canvas size.
 * Only the WebGL drawing buffer changes; CSS/UI stay untouched (never scale text with quality).
 */
export function applyPixelRatio(renderer, dpr, { composer, width, height, targets = [] } = {}) {
  const el = renderer.domElement;
  const w = width ?? el.clientWidth, h = height ?? el.clientHeight;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer?.setPixelRatio?.(dpr);
  composer?.setSize?.(w, h);
  for (const t of targets) t.setSize(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
}

/** Resize handling that compares LOGICAL sizes (comparing drawing-buffer px to CSS px with DPR>1
 * makes you call setSize every frame — a real bug we shipped once). */
export function observeResize(renderer, camera, onResize) {
  const el = renderer.domElement;
  const target = el.parentElement || el;
  const v = new THREE.Vector2();
  const ro = new ResizeObserver(() => {
    const w = target.clientWidth, h = target.clientHeight;
    renderer.getSize(v);
    if (w === v.x && h === v.y) return;
    renderer.setSize(w, h, false);
    if (camera?.isPerspectiveCamera) { camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); }
    onResize?.(w, h);
  });
  ro.observe(target);
  return () => ro.disconnect();
}
