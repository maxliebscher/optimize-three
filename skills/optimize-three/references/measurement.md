# Measuring browser 3D correctly

Wrong numbers have cost more time than slow code. Most "it runs at 60" claims were measured on the
wrong GPU, in a throttled tab, or with a counter that cannot see headroom.

## Know what you measured
- **Log the GPU string** in the HUD and in every report: `UNMASKED_RENDERER_WEBGL`
  (kit: `detectGpu().renderer`, `shortGpuName()`). A whole optimization round was once measured on an
  Intel UHD while everyone believed it was the RTX — the in-app browser had picked the iGPU.
- **Hybrid laptops**: Chrome on Windows usually renders on the iGPU. `powerPreference` is a hint that
  Chrome on Windows ignores for WebGPU and often for WebGL. To test both GPUs deliberately, launch
  Chrome with `--force_high_performance_gpu` or `--force_low_power_gpu` (measure.mjs does this).
- **Software rendering** (SwiftShader, llvmpipe, "Microsoft Basic Render Driver") → numbers invalid.
- **Throttled contexts are invalid**: hidden tabs, occluded windows, embedded/IDE browser panes
  (rAF at ~1–2 fps), a page under HMR reloads, a laptop on battery saver, other tabs using the GPU.
  Pass `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`.
- **Warm up first**: ignore the first 6–10 s (shader compile, uploads, GPU clock ramp-up). Laptops
  must be on mains power. Alternate A/B runs in the same session; never compare across sessions.
- **Fresh profile ≠ real user**: a fresh browser context can read ~half the fps of a warm one on
  iGPUs (shader cache empty). Report which one you measured.

## Script FPS sources and measurement windows

`measure.mjs` always labels observer rAF cadence as `raf Hz` / `rafFps`; it is not render FPS.
At reset (after warmup), it snapshots `window.__perf.report().frames`; at collection it takes a
second snapshot. Top-level `renderFrames` is the counter delta, and `renderFps` divides that delta
by `measurementMs / 1000`. Zero new frames means 0 FPS. Idle gaps are included in throughput.

Without the kit, call `window.__measure?.recordRenderFrame()` once after the entire application
frame (all passes; await async rendering first). Call it at least once during warmup so idle can
be distinguished from missing instrumentation. The source is `render-hook`; kit counters take
precedence (`perf-kit-counter`). Hook intervals are measured within the window; fewer than two
frames gives null percentiles. Kit counters do not expose window-specific intervals, so
`renderIntervalMs` is null for that source.

If neither source is verifiable, `renderFps` and `renderFrames` are null, `renderSource` is
`unmeasured`, and the table prints `–`. A legacy report with only `fps` is not a window counter.
Counter replacement/decrease invalidates that source. Counters must be cumulative and monotonic
for the entire run; undetected resets that recover above the baseline cannot be distinguished.
Reports that throw are recorded in `perfError` and page errors without losing the rAF results.

All existing JSON fields remain, including the unmodified nested `perf` report and GPU data.
The nested report's FPS, intervals, CPU/GPU percentiles and miss rate are rolling application
samples (up to 240 frames), not necessarily restricted to the script's measurement window.
They may remain stale during idle; do not use them as throughput for the window.

Automatic drawcall interception is not a reliable frame counter: one frame may contain many
passes, multiple renderers or only an offscreen render. Workers and iframes require aggregation
into the main page's counter/hook. Explicit counters count completed application frames, not
GPU completion, display presentation, or unique visual changes. The observer's continuous rAF
also changes idle scheduling and adds overhead; this is not an energy/idle-power benchmark.

## What to read
| Signal | Meaning |
|---|---|
| rendered fps & interval p50/p95/max | what the user sees (not rAF rate — rAF keeps ticking when you skip frames) |
| miss rate (interval > 1.5 × budget) | judder, more telling than average fps |
| CPU ms (frame callback) | main-thread cost: draw submission, JS, matrix updates |
| GPU ms (timer query) | real GPU cost; the only way to see headroom under a cap |
| draws / triangles per frame | summed over all passes (see `info` pitfall below) |
| programs | must stay constant after warm-up; growth = compile hitches |
| long tasks | > 50 ms main-thread blocks: compiles, uploads, decode, GC |

**Under a frame cap, fps cannot show headroom.** At a 60 cap the interval is 16.7 ms whether the GPU
needs 4 or 15 ms. A governor that waits for "fps > 58 to raise quality" never raises (and one that
waits for "interval < 14 ms" on a 60 Hz screen never fires — a real shipped bug). Use GPU ms; without a
timer, probe upward with back-off (kit governor does both).

**CPU ≈ frame and GPU low → CPU-bound** (draw calls, JS). **GPU ≈ frame → GPU-bound** (pixels, shaders,
shadows). On ANGLE/D3D11 the submit can overlap the GPU, so a 19–22 ms "CPU step" at 60 fps is not
necessarily overload — look at intervals, not just step time.

## GPU timers
- WebGL2: `EXT_disjoint_timer_query_webgl2`. Only one query active at a time (no nesting → push/pop
  stack for per-pass timing), results arrive frames later (poll `QUERY_RESULT_AVAILABLE`, never wait),
  discard when `GPU_DISJOINT_EXT` is set, cap pending queries, give up if the driver never answers.
  Available in Chrome desktop; usually not in Firefox/Safari → always handle `null`.
- WebGPURenderer: `new WebGPURenderer({ trackTimestamp: true })`, then
  `await renderer.resolveTimestampsAsync('render')` and read `renderer.info.render.timestamp`.
- **`gl.finish()` is not a timer** under ANGLE/D3D11 (does not reliably block). Sub-ms results from
  it mean "uncritical", nothing more.
- Per-pass split: wrap `renderer.shadowMap.render` and each post pass `render()` with timer push/pop
  and `renderer.info` deltas to get "shadow / scene / bloom / output" ms and draws.

## renderer.info pitfalls
- `info.autoReset = true` (default) resets on every `render()` → with a post chain you read the last
  pass (classic "1 draw call, 2 triangles"). Set `autoReset = false`, call `info.reset()` once per
  frame (kit HUD does this).
- WebGPURenderer: per-frame draws are `info.render.drawCalls`; memory has many `*Size` fields.
- With frame pacing, rAF count ≠ rendered frames; derive rendered fps from `info.render.frame` deltas
  or the loop's own counter.

## The ?perf HUD (kit/perf-hud.js)
Shows GPU name (with a SOFTWARE warning), backend, display Hz, cap, loop state, rendered fps, interval
p50/p95/max, miss %, CPU/GPU ms, draws, triangles, programs, geometries, textures, shadow redraws/s,
drawing buffer, DPR, quality level and the governor's last decisions with reasons.
`window.__perf.report()` returns the same as JSON for scripts.

## Benchmark mode
`?bench`: frame cap off, governor locked, GPU timer every frame. Script fixed camera segments
(close-up, overview, heaviest view, effect on/off), skip the first ~0.35 s of each segment, report
median and p95 per segment plus GPU name as JSON. Use repeatable camera views (`?view=name`) for
before/after screenshots and numbers.

## A/B switches
Give every expensive feature a URL switch (`?nopost`, `?noshadow`, `?ao=0`, `?nobatch`, `?mixres=0`).
Measuring the cost of one feature in isolation beats guessing — several "only 1–3 ms" additions
once summed to 18 fps.

## Deterministic capture (films, visual QA, screenshots)
- App side: all motion is a pure function of accumulated time; expose `step(dt)` / `renderFrame(dt)`
  (kit: `loop.setManual(true); loop.step(1000/60)`), skip intros when a capture flag is set.
- Harness side: inject a virtual clock before app scripts (`addInitScript`): patch
  `performance.now`, `Date.now`, `requestAnimationFrame`, timers and Web Animations, advance in fixed
  steps, drain microtasks, then screenshot (CDP `Page.captureScreenshot`) → ffmpeg.
- Capture at higher resolution by overriding `setPixelRatio` in the served response only, never on disk.
- A capture is only as deterministic as its slowest async path: wait for `ready` (assets, warm-up,
  first real frame differs from clear colour — `readPixels`), fail on any `pageerror`.
- With render-on-demand, scripts must `invalidate()` before a screenshot or they capture a stale frame.
- `preserveDrawingBuffer:true` is not needed for screenshots taken right after `render()` in the same
  task; keep it off in production (it costs a copy every frame).

## Stability and leaks
Toggle every variant, quality level, camera mode and replay ≥ 20×: no growth in
`info.memory.geometries/textures`, no growth in `info.programs` after the first round, no console
errors. Kit: `leakCheck(renderer, fn, 20)`. A leak found this way: axis ticks recreated on every visit
(+6 geometries per visit).

## Headless numbers
Headless Chrome with `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` uses the real GPU on
Windows, but has no real vsync (rAF can run at 200+ Hz). Good for relative A/B and GPU ms; for
user-perceived pacing use `--headed` in the foreground. Raycast-based QA must call
`scene.updateMatrixWorld(true)` / render once first — fresh meshes sit at identity until rendered.
