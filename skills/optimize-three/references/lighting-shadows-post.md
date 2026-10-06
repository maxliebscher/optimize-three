# Lighting, shadows, post-processing (GPU-bound scenes)

## Shadows
- **Cache them.** `renderer.shadowMap.autoUpdate = false`; set `needsUpdate = true` only when a caster
  or the light changed. An exact signature (light pose/frustum/map size + every caster's matrixWorld,
  geometry/attribute/material version, instance count/instanceMatrix version, LOD level) tells you when
  (`kit/shadow-cache.js`). Result: 756 shadow draws every frame → 0 idle; 96 → 36 draws in another app.
- Set `needsUpdate` **right before the main render**, after helper renders (reflection, mask,
  thumbnails) — otherwise the map is drawn from the helper's partial scene. Invalidate after any render
  outside the loop, on context restore, visibility change, resize, `LoadingManager.onLoad`, time-of-day.
  A periodic forced redraw (~10 s) guards against map contents silently lost.
- Camera moves never require shadow redraws for a fixed light frustum. Sun animation: redraw only
  when the sun moved > ~1.25°.
- Fit the frustum to what matters (contact mode: tight around the subject; widen with camera height).
  Snap a camera-following frustum to texel steps so it doesn't swim (and so the cache only invalidates
  per step).
- Size by tier: 4096/2048/1024. Changing size: `shadow.map?.dispose(); shadow.map = null; mapSize.set()`.
- Cheaper alternatives: update every other frame on iGPU (immediately on camera jumps), VSM to close
  seam dropouts, baked contact shadow quads (a canvas texture on multiplicative overlays ~1.5 mm above
  the surface: ~4 draws instead of GTAO), a decoupled low-poly shadow *receiver* sampled from the same
  heightfield (−61 % terrain triangles).
- `castShadow = false` on additive cones, fog volumes, distant forests, previews. Vertex-shader wind
  sway belongs in the colour pass only — depth materials don't know it, so shadows stay static.
- `PCFSoftShadowMap` is removed in r186 → `PCFShadowMap` (soft now) + `shadow.radius`, or `VSMShadowMap`.

## Lights
- Light count and types are compiled into every program. **Keep them constant**: a lamp "off" is
  intensity 0; extra lights are reserved at intensity 0 from the start. Toggling `visible`/`castShadow`
  at runtime = recompile = visible hitch on iGPUs.
- Few dynamic lights; bake the rest. One ambient "owner" (hemisphere/IBL), one shadowed key light.
- Fixed exposure. Auto-exposure on top of ACES/AgX "pumps".

## Baked lighting (largest quality-per-cost win for static architecture/interiors)
- Bake **light only** (Cycles `DIFFUSE` with `DIRECT`+`INDIRECT`, no colour) → materials stay swappable.
- Denoise with OIDN, not Gaussian (smears contact shadows). 2048² maps, ~1024 samples for hero rooms.
- UVs: smart project + pack with small margins; raise texel density on fine detail; never bake
  geometry finer than ~2 cm (use flat plates + shader profiles); inner faces must not be coplanar
  with the shell; in tightly packed atlases a bake margin can bleed foreign islands — test 0.
- Runtime: `lightMap` on `uv1`/channel 1, `flipY=false`, `LinearFilter`, no mipmaps for HDR maps,
  `lightMapIntensity` calibrated (Math.PI for three's convention) — verify with a known-albedo patch.
  Turn off diffuse environment light on baked surfaces; the environment adds gloss only.
  Day/night: blend two maps in a patched `lights_fragment_maps` with a `customProgramCacheKey`.
- Cheapest viewer path: `MeshBasicMaterial` + lightMap.
- Cloned lightmapped materials: watch draw order (`renderOrder`) — a change cost 14 % on an iGPU.

## Environment / IBL
- `PMREMGenerator.fromScene(RoomEnvironment)` or a small custom studio scene; dispose the generator.
  An equirect `DataTexture` assigned to `material.envMap` is ignored — use PMREM/cube.
- Box-projected env from a `CubeCamera` (256, HalfFloat → PMREM), regenerated debounced (~180 ms) on
  change only.
- Low tier: drop PMREM only if the *look* stays (compensate with a hemisphere fill) — otherwise keep it;
  it's cheap at runtime.

## Post-processing on weak GPUs
- On iGPUs the render-target detour (FP16 target + MSAA resolve + composer passes) can cost more than
  the scene. Make **"direct to canvas with context MSAA"** a tier (`antialias: true`, no composer).
- If you need post: MSAA only on the scene target (`samples: 4`), all later passes single-sample;
  HalfFloat only where HDR is needed (UnsignedByte on Intel iGPU tiers). Measured: removing redundant
  MSAA and the half-float target on an Intel UHD took a tier from 15.9 to 41.3 fps.
- Prefer **one fullscreen composite** shader (edge AA + small-tap AO + cheap bloom + grade + dither)
  over a chain of passes; bypass entirely when all effects are neutral. Unroll small tap loops (dynamic
  indexing triggered ANGLE gradient warnings).
- AO: half-res with bilateral upsample, 4–8 taps on iGPU (vs 12–16 high), applied to indirect light
  only. Or bake contact AO.
- 4× MSAA on a HalfFloat target costs ~30 % even on an RTX — top tier only.
- Banding: add sub-LSB triangular dither (`(a − b) × 0.45/255`) in the final pass.
- Custom shaders must end with `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`,
  and take linear colours — or they glow/darken next to built-in materials.
- Avoid CSS `backdrop-filter` over the canvas (GPU cost, flicker, Skia compile hitches).

## Anti-aliasing
| Method | Cost | Notes |
|---|---|---|
| context MSAA (`antialias:true`) | bandwidth ∝ samples × pixels | wasted if you render into a post chain |
| RT MSAA (`samples: 4/2`) | same, on the scene target | needed for alpha-to-coverage |
| FXAA / edge-adaptive | 1 pass, cheap | apply to 3D only so UI/captions stay sharp; can't fix sub-pixel cutouts |
| SMAA | 3 passes | only when no MSAA |
| TAA / temporal | history buffers, ghosting | only with motion vectors and care |
Alpha-to-coverage foliage needs MSAA; without it use alphaTest. A2C caused checkerboards on some leaf
cards — test per asset. Lambert + A2C cards ≈ half the cost of MeshStandard on iGPU.

## Reflections, refraction, transmission
- `MeshPhysicalMaterial.transmission` renders the opaque scene again into a transmission target —
  often half the scene pass. Remove where it doesn't show; otherwise lower
  `renderer.transmissionResolutionScale` (0.35 moving / 0.7 still).
- Planar reflections: resolution scale by tier (0.5/0.35/0), clamp 64–1024 px, skip when the camera
  is under water/behind/covered, gate with occlusion queries.
- **Render-target program trap**: rendering the scene into a plain RT makes three choose different
  programs (linear, no tone mapping) → every material switches programs twice per frame (16 ms CPU
  measured). Either warm those variants or make the RT produce the canvas variant
  (`rt.texture.colorSpace = SRGBColorSpace`) and decode in the consumer shader.

## Volumetrics, raymarching, particles
- Raymarch at half resolution into an RT, composite with depth; bounding-volume per instance so only
  covered pixels march; empty-space skipping; step count by distance LOD (40/30/22) × tier.
- In loops on ANGLE/D3D11: no `continue`, no implicit-LOD `texture()` (use `textureLod(…, 0.)`),
  branch-free octave weights — implicit-LOD fetches in divergent loops produced 2 s frames or silently
  failed.
- Move low-frequency per-pixel work into world-space textures updated rarely (cloud shadows splatted
  into an R8 texture with max-blending; fbm light patches re-rendered every 3 km of travel): 2.5–3 ms
  → < 0.5 ms on an iGPU.
- Bake view-independent far-terrain albedo per chunk into textures and swap to a cheap twin shader
  (slice the cheap shader from the full source at markers so they never drift).
- GPU particles: animate in the vertex shader from a seed + time, vary density with
  `setDrawRange(0, n × intensity)` — no CPU uploads. Rain/snow volumes follow the camera.
- Texture-unit limit is 16 samplers in many shaders — atlas new inputs.
