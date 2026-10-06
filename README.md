# optimize-three

**An agent skill and drop-in kit that make browser 3D run well on the hardware people actually have.**
It covers three.js, React Three Fiber, WebGL2 and WebGPU.

Most web 3D showcases are built and judged on a fast desktop GPU. On an office laptop with an Intel
iGPU the same demo stutters at 12 fps, the fans spin up on a 144 Hz screen, and it freezes for a
second on the first click. The fixes are the same in almost every project: cap and pace the frame
rate, scale resolution with hysteresis, stop rendering when idle, cache shadows, warm up shaders, and
measure on the right GPU. People rarely do all of that.

This repository packages that work so that Claude Code (or any coding agent) does it routinely in
every project:

- **`SKILL.md`**: the workflow and non-negotiables. The agent loads it whenever it builds or touches a
  web 3D scene.
- **`references/`**: focused, numbers-first guides: measurement, adaptive quality, frame loop, GPU
  tiers, WebGL vs WebGPU, scene cost, lighting/shadows/post, stalls and warm-up, and a release
  checklist for showcases.
- **`kit/`**: dependency-free ES modules you can copy into a project:
  - GPU detection and classification, unit-tested with real renderer strings
  - quality ladder plus governor (falls fast, rises slowly, bans levels that fail)
  - frame loop with an even-paced frame cap and a render-on-demand mode
  - GPU timer, shadow-map cache, shader/texture warm-up
  - `?perf` HUD, context-loss and page-lifecycle handling, iGPU hint
- **`scripts/audit.mjs`**: a static scan that lists the usual gaps in an existing project in seconds.
- **`scripts/measure.mjs`**: measures a page on the **discrete and the integrated GPU** with installed
  Chrome. It reports the GPU string, rendered fps, p50/p95, CPU/GPU ms, draws and quality level.

Everything here was distilled from about 25 production showcases, configurators and a browser flight
game, each tuned on an RTX laptop *and* an Intel UHD iGPU. Every rule in it was learned from a
regression on real hardware.

## Install

### Claude Code (plugin)
```
/plugin marketplace add maxliebscher/optimize-three
/plugin install optimize-three@optimize-three
```

### Claude Code (manual)
Copy `skills/optimize-three/` to `~/.claude/skills/optimize-three/` (all projects) or to
`<project>/.claude/skills/optimize-three/` (one project).

### Other agents (Codex, Cursor, Copilot, …)
Point your agent instructions (`AGENTS.md`, rules file) at `skills/optimize-three/SKILL.md`, or copy
the folder into the repository and reference it there. The kit and scripts are plain JS and work
without any agent.

## Use

Ask for it explicitly, or let it trigger on its own:

> "Optimize this three.js scene for laptops." · "Add quality levels and adaptive resolution." ·
> "Why does it stutter on the first click?" · "Should we move to WebGPU?" · "Make this showcase release-ready."

Or run the tools yourself:

```bash
node skills/optimize-three/scripts/audit.mjs ../my-3d-project
npm i -D playwright-core
node skills/optimize-three/scripts/measure.mjs http://localhost:5173/ --gpu=both
```

Minimal kit wiring (see `skills/optimize-three/kit/README.md`):

```js
import { detectGpu, createRenderer, createPerfKit, defaultLadder, startIndexForTier,
         applyPixelRatio, setShadowMapSize, warmup } from './kit/index.js';

const profile = detectGpu();
const { renderer } = await createRenderer({ canvas });
const levels = defaultLadder();
const kit = createPerfKit({
  renderer, scene, camera, profile, levels, mode: 'demand',
  start: startIndexForTier(levels, profile.tier),
  apply: (l) => { applyPixelRatio(renderer, l.dpr); setShadowMapSize(sun, l.shadow, renderer); },
  render: ({ dt }) => { const moving = controls.update(dt); renderer.render(scene, camera); return moving; },
});
await warmup({ renderer, scene, camera });
kit.start(); kit.ready();
```

Open the page with `?perf` to see the GPU, fps, frame-time percentiles, CPU/GPU ms, draws and the
governor's decisions. `?q=low|mid|high`, `?dpr=`, `?fps=30` and `?bench` make any measurement
reproducible.

## Example

```bash
npm run serve        # http://localhost:5180/examples/basic/?perf
```
The example is 4000 instanced boxes plus animated casters, all at 15 draw calls. Measured with
`measure.mjs` at 1920×1080:

| GPU | level | fps (cap 60) | GPU ms |
|---|---|---|---|
| RTX 3080 Laptop | balanced | 60 | 2.6 |
| Intel UHD (0x9A60) | eco | 60 | 7.2 |

Under stress (`?n=60000`, 2560×1440 @1.5) the governor steps the UHD down three levels to a steady
30 fps at an even 33 ms cadence instead of a jittery 20–30.

Other URL switches: `?mode=demand` (0 frames while idle), `?fps=30`, `?q=low`.

## Tests
```bash
npm test
```
The tests cover GPU classification against real ANGLE/Firefox/Safari strings, governor stability (no
oscillation, bans, probing), even pacing on 60/144 Hz, demand-mode sleeping, suspend reasons,
fixed-step independence, and manual stepping.

## Facts and versions
The backend facts were checked in October 2026 against three r186. They cover:
- the `RenderPipeline` rename
- `PCFSoftShadowMap` removal
- `renderAsync` deprecation
- WebGPU support per browser
- Chrome ignoring `powerPreference` on Windows

If you find something outdated, open an issue with a link.

## License
MIT
