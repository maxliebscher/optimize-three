# Release checklist for public demos, showcases and portfolio pieces

The typical posted showcase looks great in the video and runs at 12 fps on the viewer's laptop. Ship
the version that also works for them.

## Must
- [ ] Measured on a discrete GPU **and** an integrated GPU (or stated which one was unavailable) — GPU
      string, resolution, DPR, fps, p95 in the README/notes.
- [ ] Frame cap (60) with even pacing; weak tier falls back to a stable 30.
- [ ] DPR capped (≤ 2) or pixel-budgeted; adaptive resolution with hysteresis.
- [ ] Pauses on hidden tab / off-screen; demand rendering if anything can be idle.
- [ ] dt clamped / fixed-step: same speed on 60/120/144 Hz.
- [ ] Shaders + textures warmed behind a loader with real progress; no hitch on first interaction,
      first quality change, first effect toggle.
- [ ] First rendered frame is already good-looking (no pop-in of materials, no black flash).
- [ ] Shadows static unless something moves; no light toggles at runtime.
- [ ] Draws/triangles/texture memory within budget (SKILL.md table) at the starting tier.
- [ ] Assets compressed (meshopt/Draco, KTX2/WebP), first interactive ≤ ~15 MB, heavy parts lazy.
- [ ] Context loss handled; no console errors; no 404s; everything disposed on unmount.
- [ ] `?perf` HUD and `?q= ?dpr= ?fps=` overrides work (lets others report useful numbers).
- [ ] `prefers-reduced-motion` respected (no autoplay camera flights, shorter transitions).
- [ ] Works without WebGPU (fallback to WebGL2 or WebGL-only build).

## Should
- [ ] Persisted settle level per GPU; quality selector in settings (Auto + manual levels; manual locks).
- [ ] iGPU hint on Windows hybrid laptops when measured slow.
- [ ] Mobile portrait check (touch controls, lower start tier, safe areas); 1366×768 and 200 % zoom
      keep UI usable (UI is CSS, not scaled with quality).
- [ ] Deterministic capture path (`step()`/manual loop) for the video, so the film and the live demo
      are the same code.
- [ ] Static export with relative paths; no dev-only endpoints, no source/production data in the bundle.
- [ ] 20× replay/variant switch without growth in geometries/textures/programs.

## Video vs live
The video can be captured at 4K with everything on (render offline with a virtual clock — see
measurement.md). The live link must start at the measured tier for the viewer's GPU. Don't post a
video of settings the live demo can't sustain without saying so.
