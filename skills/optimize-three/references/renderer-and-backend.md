# Renderer, backend and robustness

Facts checked 2026-10 against three r186 (npm 0.186.1). Re-check when the project uses a newer release.

## WebGL2 or WebGPU?
**Default: `WebGLRenderer`.** Choose `WebGPURenderer` when at least one is true AND you measured a gain:
- the project needs compute: GPGPU particles/simulation, GPU culling, terrain/brush/field compute;
- it is written in TSL / node materials from the start;
- the bottleneck is CPU-side draw submission that WebGPU's bind model reduces (measure — not automatic).

Observed: on an Intel iGPU a production scene ran ~30 fps WebGPU vs ~28 fps WebGL2 — not worth a port
by itself. For simple, low-draw-count scenes WebGL2 can match or beat WebGPU.

Porting cost: `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, `EffectComposer` and
pmndrs/postprocessing **do not run** on `WebGPURenderer` → TSL/NodeMaterial and `RenderPipeline`.
Recommended order for big apps: renderer facade (init/resize/screenshot/shadows/dispose) → upgrade three
→ inventory custom shaders → parallel WebGPU test with WebGL fallback → adopt only with visual parity
and a measured gain in the real stress scenes.

**Never make WebGPU the only way in.**

## WebGPURenderer essentials (r181–r186)
```js
import * as THREE from 'three/webgpu';            // TSL from 'three/tsl'
const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' });
await renderer.init();                              // or setAnimationLoop (calls init itself)
const real = renderer.backend.isWebGPUBackend;      // false → it is running the WebGL2 fallback
await renderer.compileAsync(scene, camera);         // pipeline creation causes first-use hitches
renderer.render(scene, camera);                     // renderAsync() deprecated since r181
```
- No WebGPU → automatic `WebGLBackend` fallback ("running under WebGL2 backend"). `forceWebGL: true`
  forces it. `renderer.isWebGPURenderer` is true on both — check `backend.isWebGPUBackend` and log it.
- Before init, require a real adapter: `adapter && !adapter.info.isFallbackAdapter`.
- If init fails, the canvas is claimed — create a fresh one (`canvas.cloneNode()`) for WebGL.
- `PostProcessing` → **`RenderPipeline`** (r183, old name deprecated). `PCFSoftShadowMap` deprecated
  r183, **removed r186** (falls back to `PCFShadowMap`, which is now soft; use `shadow.radius` or VSM).
  `Clock` → `Timer` (r183). WebGPU shadows changed in r183: re-tune bias.
- `outputBufferType` defaults to `HalfFloatType`; `UnsignedByteType` saves bandwidth/memory on low tiers.
- `BatchedMesh` on the WebGPU backend still issues one `drawIndexed` per sub-draw (no multi-draw in core
  WebGPU) — it saves state changes, not draw calls. On WebGL2 it uses `WEBGL_multi_draw`.
- Device loss: `renderer.onDeviceLost = (info) => …` → resources cannot be restored → rebuild or reload.
- Compute/storage textures/indirect are limited or missing on the WebGL2 fallback — feature-detect.

Support (late 2026): Chrome/Edge desktop since 113; Chrome Android 121+ (Android 12+, most GPUs);
Chrome Linux partly; Firefox Windows 141+, Apple-Silicon macOS ~145–147, others Nightly; Safari 26 on
macOS/iOS/iPadOS/visionOS 26. Older iOS/macOS → WebGL2 fallback.

## WebGLRenderer setup that is right by default
```js
const renderer = new THREE.WebGLRenderer({
  antialias: !usesPostChain,          // with a post chain put MSAA on the scene RT (samples: 4) instead
  powerPreference: 'high-performance',// hint only; 'low-power' for small mostly-sleeping embeds
  stencil: false,                     // unless you use it
  alpha: false,                       // opaque canvas is cheaper to composite
  preserveDrawingBuffer: false,       // true costs a copy every frame
});
renderer.debug.checkShaderErrors = isDev;   // each check is a sync round trip (0.2–0.3 s measured)
renderer.setPixelRatio(Math.min(devicePixelRatio, maxDpr)); // never raw devicePixelRatio
renderer.outputColorSpace = THREE.SRGBColorSpace;           // default; custom shaders must include colorspace_fragment
```
- Depth precision: prefer `reversedDepthBuffer: true` (needs `EXT_clip_control`, check
  `renderer.capabilities.reversedDepthBuffer`) over `logarithmicDepthBuffer` (writes gl_FragDepth →
  disables early-z). Also: push the near plane out, keep far reasonable; big worlds → floating origin.
- Resize by comparing **logical** size (`renderer.getSize()` vs `clientWidth/Height`), never drawing-buffer
  px vs CSS px (with DPR > 1 that triggers `setSize` every frame — a shipped bug).
- Several renderers on one page (main + previews) each hold a context; browsers cap live contexts
  (~16) and each costs memory. Render previews on demand, share one renderer with scissor/viewport
  where possible, dispose + `forceContextLoss()` when done.
- Query extensions and `getMaxAnisotropy()` once at startup; they are synchronous.

## Hybrid laptops and GPU selection
The page cannot choose. `powerPreference:'high-performance'` is ignored by Chrome on Windows for
WebGPU and frequently for WebGL — the browser process uses the adapter Windows assigned to it.
User fixes: Windows Graphics settings → browser → High performance, or
`chrome://flags/#force-high-performance-gpu`. Kiosk/demo launchers can start Chrome with
`--force_high_performance_gpu --use-angle=d3d11` (see `templates/start-chrome-dgpu.cmd`).
Detect and tell the user (gpu-hint), and always design the iGPU path to be good.

## Context loss
- WebGL: `canvas.addEventListener('webglcontextlost', e => e.preventDefault())` — without
  `preventDefault()` the context is never restored. Suspend the loop; on `webglcontextrestored` three
  re-uploads; re-arm shadow caches, regenerate PMREM/env, re-render. For complex apps (custom RTs,
  baked data, many caches) reloading the page after restore is the robust choice.
- Headless/fresh Chromium sometimes loses the first context: QA reloads up to 3× and requires a
  `readPixels` result different from the clear colour before declaring `ready`.
- Fallback when the renderer can't be created: catch the constructor, show a poster image + text view.
- `kit/lifecycle.js → handleContextLoss()` covers both backends.

## Lifecycle
- `pagehide` with `persisted` → suspend (bfcache); without → dispose everything.
- SPA unmount / iframe removal → same dispose path: cancel the frame, remove listeners, dispose
  geometries/materials/textures/render targets/renderer. `kit/lifecycle.js → bindPageLifecycle()`.
- Host API for embeds: `suspend/resume/dispose/snapshot` on a global, plus postMessage pause/resume.
