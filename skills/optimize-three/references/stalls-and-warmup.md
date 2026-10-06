# Stalls, hitches and warm-up

Average fps can be fine while the experience feels broken: a 300 ms freeze on the first click is what
users remember. Watch p95/max interval and long tasks, not averages.

## Shader programs
A program exists per material × defines × lights × shadows × fog × skinning/instancing/morph ×
**output target** (canvas = tone-mapped sRGB variant; render target = linear variant). Every first use
compiles + links synchronously unless warmed.

Warm-up recipe (kit `warmup()`):
1. Make hidden meshes visible temporarily (compile only walks visible objects) — but keep the
   effective *light* set unchanged, or you compile variants nobody uses.
2. `renderer.setRenderTarget(null)` → `await renderer.compileAsync(scene, camera)`;
   then the same for **each render target** the frame uses (post chain, reflection, mixed-res, 1×1
   dummy with the same format is enough). Missing this caused 5–16 s freezes when post first engaged.
3. Alternative states (night lights on, x-ray mode, variants): switch, compile, switch back.
4. `renderer.initTexture(t)` for all textures, biggest first.
5. One real render into a tiny target with `shadowMap.needsUpdate = true` (buffers + depth programs).
6. Only then hide the loader and call `kit.ready()`.

`compileAsync` uses `KHR_parallel_shader_compile` where available, so it doesn't block. Measured link
times on a laptop RTX: a big terrain shader family 2–9 s, a toon material ~0.2 s — do it behind the loader.

For WebGPU, `compileAsync` creates pipelines; after rendering warm-up graphs, `await
device.queue.onSubmittedWorkDone()` before measuring.

### Things that silently create new programs at runtime
- Toggling light `visible`, adding/removing lights, toggling `castShadow` → keep lights constant,
  intensity 0 when "off". If light count can grow, pre-allocate reserve lights at intensity 0
  (e.g. 8 invisible reserve point lights) so the count stays fixed.
- Changing `material.defines`, `vertexColors`, `flatShading`, `side`, `transparent`, `alphaTest` from
  0 to > 0, adding a map that was null → `material.needsUpdate` → new program. Create all variants up
  front and swap materials instead.
- `onBeforeCompile` without `customProgramCacheKey` → collisions or recompiles.
- Fog on/off, tone mapping change, output colour space change, shadow type change.
- Monitor: `renderer.info.programs.length` must not grow during interaction (HUD shows it).

### Guard for unavoidable late programs
Skip a draw whose program isn't linked yet for that frame, compile it, poll `COMPLETION_STATUS_KHR`
with a small per-frame budget (~6 ms), draw once ready. Better a missing object for 3 frames than a
2-second freeze. (Implemented in production by patching `renderBufferDirect`; only worth it for
huge, procedurally varying shader sets.)

## Synchronous GL calls
- `renderer.debug.checkShaderErrors = true` (default!) calls `getProgramParameter`/`getShaderInfoLog`
  synchronously after each link: 0.2–0.3 s round trips measured. Disable in production.
- `getParameter`, `getExtension`, `getMaxAnisotropy`, `readPixels`, `getError` in the frame → stall.
  Query once at startup. One texture upload waited 100–270 ms behind such a query.
- `readPixels` for picking → use GPU picking into a 1×1 RT with async readback (PBO/`getBufferSubData`
  on a later frame) or CPU raycasting with a BVH.

## Uploads and decode
- `<img>` decode of a 4096² texture costs 200–400 ms on the main thread → `createImageBitmap` off-thread
  (match flipY/premultiply/colorspace).
- Uploads in flight: time-slice (≤ 6 ms/frame), largest first while loading (≤ 40 ms/frame).
- Big `DataArrayTexture`/3D textures: upload in stripes via `texSubImage3D`, generate mips once.
- KTX2 avoids decode and uploads compressed (4–8× less bandwidth).
- Geometry: avoid recreating `BufferGeometry` per change; update ranges (`addUpdateRange`) and reuse.

## GC and allocation
- No `new Vector3()` / arrays / closures per frame in hot paths; reuse scratch objects.
- Avoid `JSON.stringify` signatures per frame for big scenes (fine for small pose objects); numeric
  signatures into a reused `Float64Array` are cheaper.
- Watch `performance.memory` drops in the HUD (Chromium) to find GC spikes.

## DOM / CSS
- `backdrop-filter` UI over the canvas: GPU cost + a 100 ms Skia shader compile on first show (pre-
  composite with a near-invisible twin, or avoid it).
- Layout thrash from reading `getBoundingClientRect` and writing styles in the same frame for many
  labels → batch reads, then writes; update labels at 24 Hz.
- Large DOM overlays re-rendered each frame → only when text changes.
