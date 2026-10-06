---
name: optimize-three
description: Make browser 3D (three.js, React Three Fiber, raw WebGL2/WebGPU) run smoothly on real hardware, including office laptops with Intel/AMD integrated GPUs. Use whenever you create, review, port or polish a web 3D scene, showcase, configurator, game, data viz or product viewer, and whenever the user mentions fps, stutter, lag, jank, iGPU, laptop, mobile, quality levels/tiers, adaptive or dynamic resolution, DPR, frame cap, 30/60 fps, WebGPU vs WebGL, shadows, draw calls, loading hitches, shader compile stalls, GPU memory, or "make it run everywhere". Ships a drop-in kit (GPU detection, quality ladder and governor, even-paced frame loop, render-on-demand, shadow cache, warm-up, perf HUD, context-loss handling) plus a static audit and a real-GPU measurement script.
---

# optimize-three

Most web 3D demos are built and judged on one fast desktop GPU and then stutter on the laptops and
phones of the people who actually open them. This skill makes performance work *routine* instead of
a rescue mission. Every rule here was paid for with a real regression on real hardware.

## Non-negotiables

1. **Measure on the GPU you claim.** Log the renderer string (`UNMASKED_RENDERER_WEBGL`). Hybrid laptops
   run the browser on the iGPU by default; an embedded/hidden browser pane throttles rAF to ~1 fps;
   SwiftShader numbers are meaningless. No fps claim without GPU name + method.
2. **Time is frame-rate independent.** Clamp render dt (≤ 0.1 s), simulate in fixed steps with a
   bounded accumulator, never animate "per frame". Same film at 30, 60 and 144 Hz.
3. **Cap the frame rate with even pacing** (default 60; 30 is legitimate on weak GPUs). A steady 30
   beats a jittery 40–55. Pace in whole vsyncs, stay on rAF (setTimeout-before-rAF halves the rate).
4. **Don't render what nobody sees.** Pause on hidden tab, off-screen canvas, iframe hidden. Viewers
   and configurators render on demand and sleep at 0 fps when nothing changes.
5. **Quality tiers change cost, never look.** Same lighting, exposure, content, UI and text size on
   every level. Lower pixels and invisible work first (shadow-map size, distant detail, AO taps).
6. **Detect, then correct.** The GPU string is a starting guess; a governor with hysteresis
   (fast down, slow up, bans for failing levels) fixes it from measured frames.
7. **Warm up everything before the first frame**: every material × light-state × output target
   (canvas *and* each render target), plus texture uploads. Keep the light count constant.
8. **Static stays static**: shadow maps only re-render when a caster/light changes; static meshes
   don't update matrices; nothing allocates per frame.
9. **WebGL2 is the default, WebGPU is a measured decision**, never the only way in.
10. **Robust by default**: context loss handled, everything disposed, `?perf` HUD available,
    URL overrides for tier/dpr/fps/backend so anyone can reproduce a measurement.

## Workflow

### 0. Classify the project (decides loop mode and budgets)
| Kind | Loop | Default cap | Notes |
|---|---|---|---|
| Configurator, product viewer, architecture, data viz | `demand` | 60 | 0 fps idle; wake on input/transition |
| Film/tour, scroll story, showcase with autoplay | `continuous` while playing, `demand` when paused | 60 (30 on weak tiers) | deterministic time for capture |
| Game, simulation | `continuous` + fixed-step sim | 60 (tier may set 30) | input latency matters, keep CPU low |
| Embedded widget/iframe | `demand` | 30–60 | `powerPreference:'low-power'` acceptable, pause off-screen |
| WebXR | `renderer.setAnimationLoop` | device rate | no cap; resolution scale is the lever |

### 1. Audit (2 minutes)
```bash
node <skill>/scripts/audit.mjs <project-dir>
```
Static scan for uncapped DPR, missing visibility/cap/dt clamp, every-frame shadows, missing warm-up,
`preserveDrawingBuffer`, transmission, light toggles, WebGPU incompatibilities, huge GLBs/textures,
deprecated APIs (PCFSoftShadowMap, renderAsync, PostProcessing → RenderPipeline). Read the hits, then
read the render loop and renderer setup yourself.

### 2. Baseline on real GPUs
```bash
npm i -D playwright-core        # once, in the project
node <skill>/scripts/measure.mjs http://localhost:5173/ --gpu=both --seconds=10
```
Reports GPU string, rendered fps, frame p50/p95/max, CPU/GPU ms, draws, triangles, DPR, level.
If the machine has only one GPU, say so and don't claim iGPU results. See `references/measurement.md`.

### 3. Install the baseline kit (always — this is the "eh sinnvoll" part)
Copy `kit/` into the project (it is dependency-free ES modules, `three` as peer) or port the pieces
you need. Minimal wiring:

```js
import { detectGpu, createRenderer, createPerfKit, defaultLadder, startIndexForTier,
         applyPixelRatio, setShadowMapSize, observeResize, warmup } from './kit/index.js';

const profile = detectGpu();                                   // GPU string, class, tier, URL overrides
const { renderer } = await createRenderer({ canvas, backend: profile.overrides.backend || 'webgl' });
const levels = defaultLadder({ maxDpr: 2 });                   // extend levels with your own fields
const kit = createPerfKit({
  renderer, scene, camera, profile, levels, mode: 'demand',    // or 'continuous'
  start: startIndexForTier(levels, profile.tier),
  apply: (l) => { applyPixelRatio(renderer, l.dpr); setShadowMapSize(sun, l.shadow, renderer); /* your fields */ },
  render: ({ dt }) => { const moving = controls.update(dt); renderer.render(scene, camera); return moving; },
});
observeResize(renderer, camera, () => kit.invalidate());
await warmup({ renderer, scene, camera, targets: [composerTarget] });  // behind the loader
kit.start(); /* after the first real frame: */ kit.ready();
```
This gives you: even-paced cap, dt clamp, fixed-step option, demand mode, pause on hidden/off-screen,
governor + persisted settle point per GPU, GPU timer, shadow cache, `?perf` HUD, `window.__perf.report()`,
iGPU hint on Windows, context-loss + pagehide handling. Module docs: `kit/README.md`.

Framework users: R3F → `frameloop="demand"` + `invalidate()`, drei `<PerformanceMonitor>`/`<AdaptiveDpr>`
are the same ideas; still apply rules 1–10 and the ladder design (`references/frame-loop.md`).

### 4. Design the ladder for THIS scene
Decide what each rung changes, cheapest-to-see first. Read `references/adaptive-quality.md`.
Typical order: DPR→1.0 on HiDPI · shadow-map size · AO/bloom/DOF taps · far detail & crowd density ·
MSAA 4→2 · DPR below 1 (floor 0.75–0.85) · stable 30 fps. Never: text size, UI, lighting mood, content.

### 5. Remove cost where the measurement points
- **GPU-bound** (GPU ms ≈ frame): pixels (DPR, post passes, overdraw, transmission), shadows,
  shader cost → `references/lighting-shadows-post.md`.
- **CPU-bound** (CPU ms ≈ frame, GPU idle): draw calls, matrix updates, per-frame allocation,
  raycasts, JS work → `references/scene-cost.md`.
- **Hitches** (p95/max spikes, long tasks): compiles, uploads, sync GL calls, GC →
  `references/stalls-and-warmup.md`.
- **Load time / memory**: gltf-transform, KTX2, meshopt, lazy loading → `references/scene-cost.md`.

### 6. Backend & device questions
WebGPU vs WebGL, migration pitfalls (r181–r186), hybrid-laptop GPU selection, context loss →
`references/renderer-and-backend.md`. GPU strings and starting tiers → `references/gpu-tiering.md`.

### 7. Verify and report honestly
Re-run `measure.mjs --gpu=both`, toggle every variant/quality/replay ≥ 20× (leaks: `leakCheck`),
check console clean, check the idle frame count in demand mode is 0. Report as:

```
GPU (exact string) · backend · resolution × DPR · level · fps (rendered) · frame p95 · CPU/GPU ms · draws · tris
before → after, per GPU. What was not measured and why.
```
A successful build is not a performance result. "Runs at 60 fps" without a GPU name is not a result.

## Budgets (starting points, desktop/laptop, 1080p)
| Metric | Target | Notes |
|---|---|---|
| Frame @60 | GPU ≤ 12.5 ms, CPU ≤ 8 ms | headroom for the browser/compositor |
| Frame @30 (iGPU tier) | GPU ≤ 25 ms | cap evenly, don't hover at 40 |
| Draw calls | ≤ 150–300 main, ≤ 60 shadow | instancing / BatchedMesh / merge |
| Visible triangles | 0.5–2 M | iGPU lower end |
| Shadow map redraws | 0 when idle | shadow cache |
| Shader programs | constant after warm-up | 0 compiles during interaction |
| First interactive transfer | ≈ 10–15 MB | lazy-load the rest |
| Textures | ≤ 2048² (≤ 1024² low tier), KTX2 where many | GPU memory = w×h×4×1.33 for RGBA8 |
| Pixel budget | ≈ 1.8–2.4 MP still, 1.0–1.5 MP iGPU motion | via DPR, not CSS size |

## Reference index
| File | Read when |
|---|---|
| `references/measurement.md` | before any number; HUD; GPU timers; headless/real-GPU rules; deterministic capture |
| `references/adaptive-quality.md` | designing tiers, governor tuning, oscillation, DPR strategy |
| `references/frame-loop.md` | cap vs uncapped, pacing, fixed step, demand rendering, visibility, R3F/XR |
| `references/gpu-tiering.md` | GPU strings, starting tiers, URL overrides, iGPU hint |
| `references/renderer-and-backend.md` | WebGL vs WebGPU, three.js version migrations, context loss, hybrid GPUs |
| `references/scene-cost.md` | draw calls, instancing, LOD/impostors, assets, textures, streaming, GC |
| `references/lighting-shadows-post.md` | shadows, baked light, IBL, post on iGPU, AA, reflections, transmission |
| `references/stalls-and-warmup.md` | first-use hitches, compile variants, uploads, sync calls |
| `references/showcase-checklist.md` | before publishing a demo/showcase/portfolio piece |
