# Frame loop: cap, pacing, time, sleeping

## Fixed cap or dynamic?
| Situation | Choose |
|---|---|
| Anything shown to clients/the public | **cap 60** (120/144/240 Hz screens otherwise burn 2–4× GPU for nothing: fans, heat, battery) |
| Weak GPU can't hold 60 | **cap 30 evenly** (governor's last rung) — not "whatever it manages" |
| Competitive game, user opted in | uncapped / display rate, still with fixed-step sim |
| Benchmark / profiling | uncapped (`?fps=0` / `?bench`) — never ship it |
| WebXR session | device rate via `renderer.setAnimationLoop`, no cap |
| Idle viewer | 0 fps (demand mode) |

Activity-based caps work well for tools: e.g. iGPU idle-but-animating 18–24 fps, direct interaction
30–45, dGPU 60 everywhere; boost for ~900 ms after each input event. A paused world that kept
rendering at 126 fps saturated an Intel UHD until this was added.

## Even pacing
Skipping frames by elapsed time alone (`now - last >= 1000/30`) on a 60 Hz screen produces a mix of
16/33/50 ms frames when timing jitters. Estimate the vsync interval (25th percentile of recent rAF
intervals) and render every `n = round(capPeriod / vsync)` vsyncs:
```js
const n = Math.max(1, Math.round(1000 / capFps / vsync));
if (now - lastRender < (n - 0.5) * vsync) return; // skip this vsync
```
60 on 144 Hz → even 72; 30 on 60 Hz → exact every 2nd. Don't `setTimeout` before `requestAnimationFrame`
to "wait": it misses the next vsync and can halve the rate. Safari caps rAF near 60 even on ProMotion
unless the user changes a setting; iOS Low Power Mode is reported to throttle to ~30.

## Time
```js
// render dt: clamp. After a stall or tab switch, never jump.
const dt = Math.min((now - last) / 1000, 0.1);
// simulation: fixed step, bounded catch-up, drop the backlog (no spiral of death)
acc += Math.min(dt, 0.25);
let n = 0; while (acc >= STEP && n < 6) { step(STEP); acc -= STEP; n++; }
if (acc >= STEP) acc %= STEP;
render(alpha = acc / STEP);
```
- Clamp negative dt too (`Math.max(0, …)`): a `performance.now()` taken in an input handler can be
  later than the next rAF timestamp → NaN velocities.
- Use integer step counts for scripted sequences; float accumulation once produced 16 steps instead of 15.
- Write instance/tree buffers once per *displayed* frame, not per simulation step.
- Films/tours: state = pure function of film time; this makes capture deterministic and scrubbing free.
- `THREE.Clock` is deprecated (r183) → `THREE.Timer`, or just use rAF timestamps.

## Render on demand (viewers, configurators, tools)
- A `dirty` flag + `invalidate()` coalesces any number of change events into one frame.
- `render()` returns `true` while something still moves (damped controls, tweens) → loop continues;
  otherwise it sleeps (0 fps, 0 GPU).
- `wake(ms)` keeps it running through transitions; wake on pointer/wheel/key/resize (passive listeners).
- Two invalidation kinds help: **scene changed** (also invalidates shadow cache) vs **view only**
  (camera moved: shadows stay).
- Keep one list of "things that animate" (`needsMotion()`): forgetting one means a frozen animation.
- Test scripts must `invalidate()` and skip intros before screenshots.

## Sleeping when invisible
Suspend with independent *reasons* — `hidden` (visibilitychange), `offscreen` (IntersectionObserver
on the canvas), `iframe` (postMessage from host), `context` (lost), `manual` (user pause). Resume only
when all are gone, so a manual pause survives a tab switch. On resume: reset `last` (dt = 0 for the
first frame), clear the governor window, re-arm shadow cache. Also pause audio and clear held keys.
For embeds: host-side IntersectionObserver → `postMessage('pause'|'resume')`, child answers `ready`.

## React Three Fiber mapping
- `<Canvas frameloop="demand">` + `invalidate()` = demand mode; `frameloop="never"` + `advance()` =
  manual stepping.
- `dpr={[1, 1.5]}`, drei `<AdaptiveDpr pixelated />`, `<PerformanceMonitor onDecline/onIncline>` =
  a simple governor — add hysteresis (`flipflops`, bounds) and never let it change lighting.
- `useFrame((state, delta) => …)`: clamp delta yourself; avoid `setState` per frame (React re-render).
- Instancing: drei `<Instances>`/`<Merged>`; static: `matrixAutoUpdate={false}`.
- Cap: R3F renders at display rate; for a 60/30 cap use `frameloop="never"` and drive `advance()`
  from your own paced loop (kit `createFrameLoop` with `render: () => advance(performance.now())`).

## WebXR
`renderer.setAnimationLoop(cb)` is mandatory (the XR device supplies frames). No cap; lower
`renderer.xr.setFramebufferScaleFactor()` / foveation instead of DPR; disable the desktop governor or
feed it XR frame times.
