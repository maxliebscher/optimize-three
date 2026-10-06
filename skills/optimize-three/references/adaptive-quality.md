# Quality ladders and the governor

## The contract
**Levels change render cost and sampling only.** Time of day, weather, lighting balance, exposure,
tone mapping, IBL policy, content, UI layout and text size are identical on every level. A level that
also changes the light (e.g. "PMREM only on high") turns the quality switch into a second light switch
and makes screenshots from different machines disagree. Assert it in a test if the project is large.

Corollary: don't toggle lights or `castShadow` per level (recompile hitch, see stalls-and-warmup.md);
change shadow-map *size*, shadow update rate, or swap to a baked contact shadow instead.

## Ladder design: least visible saving first
1. **DPR down to 1.0 on HiDPI screens.** On a 2× laptop, 2.0 → 1.5 → 1.25 → 1.0 is hard to see and
   cuts fill cost up to 4×. Pixel cost scales with DPR².
2. **Invisible or nearly invisible work**: shadow-map size (4096 → 2048 → 1024), shadow redraw rate,
   AO taps / half-res AO, bloom/DOF taps, reflection resolution, terrain rings hidden in fog,
   cloud/particle counts, crowd radius, anisotropy (16× cost ~7 ms on an Intel UHD at grazing angles → 4×).
3. **Post chain shape**: on iGPUs, rendering straight to the canvas with context MSAA instead of an
   FP16 render target + composer is often the single biggest win (the RT detour cost several times
   the scene itself). Make "direct" a rung.
4. **MSAA 4 → 2** (keep some MSAA if you use alpha-to-coverage foliage; A2C without MSAA becomes
   crawling 1-bit stairs that FXAA cannot fix).
5. **DPR below 1.0**, with a floor: 0.75 general, 0.85 when the scene has thin lines/cutouts.
   0.6 + FXAA looked soft enough that users noticed.
6. **Frame cap 60 → 30** as the last rung: same per-frame cost, double budget, even pacing.

Typical numeric ladders that worked:
```
dpr   shadow  msaa  post        detail   fps
1.75  4096    4     full        1.0      60   (dGPU, HiDPI)
1.25  2048    4     full        0.8      60
1.0   1024    2     direct/low  0.6      60   (iGPU start)
0.85  1024    0     direct      0.5      60
0.75  1024    0     direct      0.4      30
```
`kit/quality.js → defaultLadder()` builds this shape; extend each level with your own fields.

## Starting level
From the GPU class (gpu-tiering.md), the screen's physical pixels, and the persisted settle point from
the previous visit (keyed by GPU string — the kit stores it in localStorage). URL `?q=` / `?dpr=` lock it.

## Governor rules (kit defaults, each one learned)
- **Judge rendered frames**, never rAF. Evaluate in 2 s windows (min 20 frames).
- **Warm-up**: start judging ~3 s after the first real frame (`kit.ready()`).
- **Hold** during camera cuts, level loads and streaming bursts (`governor.hold(s)`): those are not
  steady load. Clear the window after stalls > 250 ms and while the tab is hidden.
- **Down fast**: window bad if rendered p90 > 1.08 × budget, or > 12 % misses, or GPU p90 > 0.92 ×
  budget. Two bad windows → one step down; > 35 % misses → immediately.
- **Up slow**: ≥ 4 calm windows (no hitch > 2.4 × budget, < 2 % misses) AND headroom:
  - with GPU timer: predicted next-level GPU p90 = `gpu × cost(next)/cost(cur)` < 0.8 × budget
    (`cost` ≈ DPR² × small MSAA/shadow factors);
  - without: probe after 8 s, doubling up to 120 s each time a probe fails.
- **Ban** a level that fails within 40 s of being entered: 240 s, doubling per repeat. This is what
  stops 55↔60 ping-pong.
- **Cooldown** 2.5 s after any change and clear the sample window.
- **Apply big changes in calm moments**: DPR and fps can change at once; geometry rings, LOD, crowd
  counts better wait for a camera cut, a fade, or ≥ 2 s without camera motion.
- **Manual choice locks** the governor (and shows "set by URL" when a URL param did it).
- **Benchmarks lock it** too, or you measure the governor, not the scene.

## 30 vs 60 at the 30 Hz edge
When a 60 Hz tier is cheaper on CPU at 30 fps (laptop CPUs clock down when idle half of each 33 ms
frame), CPU time measured at 30 underestimates 60-fps cost: scale it (~0.72) before predicting a
climb to 60 and treat the climb as a probation (one bad window → back down + ban).

## DPR strategies beyond fixed steps
- **Pixel budget instead of a constant**: `dpr = min(dpr, sqrt(budgetPx / (cssW × cssH)))` with
  ~1.8–2.4 MP for still images and ~1.0–1.5 MP for motion on iGPUs. Big windows get less DPR, small
  embeds can supersample (`kit/renderer.js → budgetedPixelRatio`).
- **Sharp when still, cheaper while moving**: lower DPR/reflection resolution and skip AO during camera
  motion, re-render one full-quality frame when the view settles (demand loop wake). Users judge
  quality on still frames.
- **Mixed resolution**: render the background (sky, terrain) into a low-res target with depth and
  upsample depth-aware; draw foreground (objects, UI-like detail) at full resolution on top. Upsample
  shader needs `depthTest:true, depthFunc:AlwaysDepth, depthWrite:true` (with depth test disabled,
  GL also skips depth writes and foreground draws through background).
- **GPU-ms driven continuous scale** (`ratio -= min(0.08, ratio × (1 − sqrt(budget/cost)))`, change at
  most every 2.5 s) works when a timer exists; keep discrete rungs as the fallback.

## Pitfalls seen in production
- Adapting on CPU submit time ("render ms + 4") instead of GPU or interval → wrong under ANGLE.
- Step-up condition that can never be met at a 60 Hz vsync (interval < 14 ms).
- Re-raising immediately after a drop → oscillation every few seconds. Use bans.
- Changing `shadow.mapSize` without disposing the old map → nothing happens.
- Quality change that reloads geometry synchronously → the hitch triggers another step down.
- Scaling CSS/UI with quality. Never: UI is CSS pixels; only the WebGL drawing buffer scales.
- Persisting a tier without the GPU key → a laptop docked to a desktop GPU stays on low forever.
