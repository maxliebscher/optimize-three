# GPU identification and starting tiers

## Reading the GPU
```js
const gl = document.createElement('canvas').getContext('webgl2');
const ext = gl?.getExtension('WEBGL_debug_renderer_info');
const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
gl?.getExtension('WEBGL_lose_context')?.loseContext(); // free the probe context immediately
```
| Browser | What you get |
|---|---|
| Chrome/Edge | full ANGLE string incl. model: `ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Firefox | sanitized family bucket via `gl.RENDERER` (extension deprecated); hidden with resistFingerprinting |
| Safari (macOS + iOS) | always `Apple GPU` → separate phone/tablet via UA / `maxTouchPoints` |
| WebGPU | `adapter.info.{vendor, architecture, device, description}` — any field may be empty (privacy); HTTPS only |

## Classification that holds up
| Pattern | Class | Start tier |
|---|---|---|
| SwiftShader, llvmpipe, Basic Render Driver | software | low + warning (numbers meaningless) |
| Adreno, Mali, PowerVR, Immortalis, Xclipse, `Apple GPU` on touch devices | mobile | low |
| NVIDIA / GeForce / RTX / GTX / Quadro | discrete | high |
| AMD `Radeon RX`, `Radeon Pro`, R9 | discrete | high |
| Intel `Arc(TM) A770` / `B580` (model number!) | discrete | high |
| Intel UHD / Iris / HD Graphics, **`Intel(R) Arc(TM) Graphics` without model** (Meteor/Lunar Lake iGPU) | integrated | low |
| AMD `Radeon(TM) Graphics`, `Vega 8 Graphics`, `780M` | integrated | mid (680M/780M class is decent) |
| Apple M1/M2/M3/M4 | apple | mid; Pro/Max/Ultra → high |
| unknown / empty | unknown | mid (desktop), low (mobile) |

Pitfalls: a plain `/Intel/` regex sends discrete Arc cards to low; a plain `/Arc/` whitelist sends
Meteor Lake iGPUs to high. Hybrid strings don't exist — ANGLE reports the adapter actually in use.
`kit/gpu-profile.js → classifyGpu()` encodes the table and is unit-tested with real strings.

Additional signals: physical screen pixels (4K+ on a mid GPU → start one lower), `pointer: coarse`,
`navigator.deviceMemory` (Chromium only), `hardwareConcurrency` (worker pool size).

**The string is a guess.** Always pair it with the runtime governor. `@pmndrs/detect-gpu` (benchmark
database) exists, but its data source stopped updating in Dec 2025 and it fetches data from a CDN by
default — fine as an extra signal, not as the only one.

## URL overrides (use the same names everywhere)
| Param | Effect |
|---|---|
| `?q=low\|mid\|high\|auto` | fixed starting tier; anything but `auto` locks the governor |
| `?dpr=1.25` | fixed pixel ratio |
| `?fps=30\|60\|0` | frame cap (0 = uncapped, measuring only) |
| `?aa=0\|1` | MSAA off/on (context MSAA needs a reload) |
| `?backend=webgl\|webgpu` | renderer backend |
| `?perf` / `?bench` | HUD / benchmark mode |
| per-feature: `?noshadow ?nopost ?ao=0 ?nobatch` | isolate a feature's cost |
URL params win over stored settings and lock the matching UI control ("set by the address").

## Persisting
Store the settled level keyed by the GPU string (`{gpu, index}`); next visit starts there. Never key
by nothing: the same laptop docked/undocked or switching GPU must not inherit a wrong tier.
Store AA choice too — it decides the context type and needs a reload to change.

## "Use the fast GPU" hint (Windows hybrid laptops)
A page cannot select the GPU. Show a one-time, dismissible hint only when: Windows, integrated GPU,
and *measured* struggle (e.g. > 35 % of 300 frames slower than 40 ms, after 12 s, tab visible).
Text: Windows Settings → System → Display → Graphics → choose the browser → "High performance",
restart the browser. `?nogpuhint` disables it; a settings panel can re-show it. (`kit/gpu-hint.js`)
For your own testing: `chrome --force_high_performance_gpu` (or `chrome://flags/#force-high-performance-gpu`).
