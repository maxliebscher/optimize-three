# optimize-three kit

Dependency-free ES modules (`three` as a peer import where needed). Copy the folder into your project
or import single files. Every module works on its own; `index.js → createPerfKit()` wires them.

| File | Exports | Imports three? |
|---|---|---|
| `gpu-profile.js` | `detectGpu()`, `classifyGpu(str)`, `readOverrides()`, `detectWebGPUAdapter()`, `shortGpuName()` | no |
| `frame-loop.js` | `createFrameLoop(o)`, `wakeOnInput(loop, el)` | no |
| `quality.js` | `createGovernor(o)`, `defaultLadder(o)`, `startIndexForTier(levels, tier)`, `GOVERNOR_DEFAULTS` | no |
| `gpu-timer.js` | `createGpuTimer(renderer)` (WebGL2 timer query / WebGPU timestamps) | no |
| `shadow-cache.js` | `createShadowCache({renderer, scene, camera})` | no |
| `perf-hud.js` | `createPerfHud(o)` (`?perf` overlay + `report()`) | no |
| `gpu-hint.js` | `createGpuHint({profile})` (Windows iGPU hint) | no |
| `renderer.js` | `createRenderer(o)`, `webgpuUsable()`, `setShadowMapSize()`, `budgetedPixelRatio()`, `applyPixelRatio()`, `observeResize()` | yes (`three`, lazy `three/webgpu`) |
| `warmup.js` | `warmup(o)`, `collectTextures()`, `loadBitmapTexture()` | yes |
| `lifecycle.js` | `disposeObject()`, `handleContextLoss()`, `bindPageLifecycle()`, `leakCheck()` | no |
| `index.js` | all of the above + `createPerfKit(o)` | via renderer/warmup |

Import maps: map `three`, and `three/webgpu` if you use `backend: 'webgpu'|'auto'`.

## createPerfKit(o)
| Option | Default | |
|---|---|---|
| `renderer, scene, camera` | — | required |
| `render(f)` | — | draw one frame; `f = {now, dt, alpha, interval, frame, stall}`; return `true` to keep animating in demand mode |
| `update(dt)` | — | optional fixed-step simulation (1/60) |
| `levels`, `apply(level, i, prev)` | — | quality ladder (best first) and how to apply a level |
| `start` | 0 | starting level index (`startIndexForTier(levels, profile.tier)`) |
| `mode` | `'continuous'` | or `'demand'` |
| `fps` | 60 | default cap; a level's `fps` overrides; `?fps=` overrides all |
| `shadows` | `true` | shadow cache (needs `renderer.shadowMap.enabled` before creating the kit); `'manual'` = call `kit.shadows.update()` yourself right before the main render |
| `profile` | `detectGpu()` | |
| `persistKey` | `'optimize-three.quality'` | settled level per GPU string in localStorage |
| `gpuHint` | `true` | Windows iGPU hint when measured slow |
| `observe` | canvas | element for IntersectionObserver pausing |
| `rules` | `GOVERNOR_DEFAULTS` | governor tuning |
| `onQualityChange, onFrame, onState` | — | hooks |
| `expose` | `true` | `window.__perf` |

Returns `{ profile, loop, governor, timer, shadows, hud, start(), ready(), invalidate(), wake(ms), report(), dispose() }`.
Call `ready()` after the first real frame (post warm-up) — the governor ignores everything before it
plus `warmupS` (3 s).

## Loop API
`invalidate()`, `wake(ms)`, `start()`, `stop()`, `suspend(reason)`, `resume(reason)`, `setFps(n)`,
`setManual(bool)`, `step(ms)`, `dispose()`; getters `fps`, `vsyncMs`, `displayHz`, `state`
(`running|idle|suspended`), `reasons`, `frame`.

## Governor API
`sample({interval, cpuMs, gpuMs, stall})`, `markReady()`, `hold(s)`, `init()`, `set(i)`, `lock(i)`,
`unlock()`, `state()`, `log`; getters `index`, `level`, `locked`, `budgetMs`.

## URL overrides
`?q=low|mid|high` `?dpr=` `?fps=` `?perf` `?bench` `?backend=webgl|webgpu` `?aa=0|1` `?nogpuhint`

## Tests
`node --test tests/*.test.mjs` from the repository root (GPU classification with real strings,
governor stability, pacing on 60/144 Hz, demand mode, suspend reasons, fixed-step independence,
manual stepping).
