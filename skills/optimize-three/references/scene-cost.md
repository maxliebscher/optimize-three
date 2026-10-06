# Scene cost: draw calls, CPU, assets, memory

## Draw calls (CPU-bound scenes)
Target ≤ 150–300 draws in the main pass, ≤ 60 in the shadow pass. Measured reductions:
1392 → 117 draws (1.42 M → 575 k tris) on a garden configurator; 440 → 15 draws on an aircraft.

| Technique | Use when | Notes |
|---|---|---|
| `InstancedMesh` | many copies of one geometry+material | per-instance colour via `setColorAt`; spread-out instances need `computeBoundingSphere()` or they get culled; `DynamicDrawUsage` + `addUpdateRange` for partial updates |
| auto-instancing buckets | user-placed objects | key = geometry id + material ids + castShadow/receiveShadow; batch from ≥ 8 copies; hide originals, keep invisible proxies for picking; exclude negative-scale (mirrored) objects |
| `BatchedMesh` | many different geometries sharing a material | keeps per-object matrices/visibility (`setMatrixAt`, `setVisibleAt`) so hierarchies stay animatable; can't flip winding for mirrored instances (bake the mirror); on WebGPU it saves state changes, not draws |
| `mergeGeometries` | static parts that never move independently | bake `matrixWorld` into geometry, `matrixAutoUpdate=false`; fold per-part params into vertex attributes so the image stays identical |
| shadow-only proxy | many small casters | merged mesh visible only during the shadow pass (patch `shadowMap.render` to toggle it), originals `castShadow=false` |
| render proxies on idle | articulated products | when a product is still ≥ 0.25 s collapse it to one mesh per material class; restore on interaction |
| texture atlas / array | many materials differing only by texture | one material, UV offset or `DataArrayTexture` layer per instance |

Material count is draw count. Dedupe materials/geometries on load: clones of the same GLB part should
share one geometry and one material (key by name + vertex/index count).

## Matrices and the scene graph
- Static objects: `matrixAutoUpdate = false; updateMatrix()` once.
- Large graphs: call `scene.updateMatrixWorld()` once per frame, then set
  `scene.matrixWorldAutoUpdate = false` around extra renders (reflection, shadow, main) so each
  `render()` doesn't traverse again. Invisible subtrees: `obj.matrixWorldAutoUpdate = obj.visible`
  (saved > 4000 node updates/frame in a crowd scene).
- No allocation in the frame: hoist `Vector3/Matrix4/Quaternion/Color/Box3/Raycaster` scratch objects.
- Throttle non-visual work: overlays/labels at 24 Hz, bounds summaries at 2 Hz, heatmaps on a timer,
  DOM updates only when text changed. Raycast against proxies or BVH (three-mesh-bvh), not merged
  meshes' giant bounds.

## Culling and LOD
- `frustumCulled = false` only for things that are always visible or whose bounds are wrong by design
  (GPU-displaced foliage, sky domes, camera-following particle volumes) — otherwise fix the bounds.
- Exact per-instance frustum culling: rebuild `InstancedMesh.count` only when the camera matrices change.
- LOD: generate simplified levels (meshoptimizer `simplify`/`simplifySloppy`, gltf-transform
  `simplify`, Blender Decimate) — e.g. LOD tris 3200/1000/300 for crowd figures. Cross-fade with a
  4×4 Bayer dither instead of popping.
- Distance: fog + far plane together; hide rings beyond the fog; shrink instances to zero over the last
  ~300 m instead of popping; stream around `cameraPos + velocity × ~7 s` so nothing loads in view.
- Impostors for horizons: camera-facing cards / a horizon cylinder / panorama shell (1–2 draws) instead
  of real distant geometry. Avoid bright billboard crowns — they read as clip-art.
- Occlusion queries (`ANY_SAMPLES_PASSED_CONSERVATIVE`) on proxy boxes to gate expensive effects
  (reflections) — results arrive 1–2 frames late, keep the effect on ~500 ms after the last hit. Saved
  539 draws and ~8 ms CPU in one scene.

## Assets
```bash
# geometry + textures in one go (defaults: meshopt, texture-compress auto, resize 2048, simplify, instance, prune…)
npx @gltf-transform/cli optimize in.glb out.glb --texture-compress ktx2   # KTX2 needs KTX-Software `ktx` ≥ 4.4 on PATH
npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp
npx @gltf-transform/cli inspect out.glb                                    # sizes, VRAM estimate
```
- Loader setup: `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` (must be set before loading meshopt
  files), `setDRACOLoader(draco)` (dispose the DRACOLoader after loading), `setKTX2Loader(ktx2.detectSupport(renderer))`.
- **File size ≠ GPU memory.** A 219 KB WebP 1024² is ~5.3 MB RGBA8 + mips on the GPU. KTX2
  (ETC1S for colour, UASTC for normals/data) stays compressed in VRAM and uploads without decode stalls.
- Texture size: ≤ 2048² for heroes, ≤ 1024² on low tiers, foliage atlases ~1536². Normal maps at half,
  roughness at quarter resolution of albedo is usually invisible.
- Pack channels: e.g. `R,G = normal.xy, B = roughness, A = height/AO` (NoColorSpace), albedo sRGB → one
  texture instead of three. Encode control maps with a stride (slot × 8) — canvas colour management can
  shift values by ±1.
- Atlases need gutters (32 px at 1024 tiles, wrapped) or mips bleed neighbours and reveal a grid.
- Quantize vertex attributes (normalized 8/16-bit colours, positions/UVs via meshopt quantization).
- First interactive ≈ 10–15 MB; lazy-load heavy GLBs (detail models only on high tier or on demand);
  never ship raw/production source data or `.blend` exports to visitors.
- Decode large images off the main thread (`createImageBitmap`; kit `loadBitmapTexture`), upload biggest
  first behind the loader, time-slice uploads in flight (≤ 6 ms/frame), stripe huge array textures
  (`texSubImage3D` in 128-row stripes, mips once at the end).
- Precompute what can be precomputed (masks, SDFs, history layers) offline — a canvas-composited mask
  once added 18 s to load.

## Streaming & workers
- Worker pool `min(4, hardwareConcurrency − 1)` for terrain/geometry generation, 2 jobs in flight each.
- Budget main-thread integration per frame (3–4 ms in flight, 10–12 ms while loading), resumable
  generators; cap fresh work per frame (e.g. ≤ 2 cells) to avoid 500 ms spikes on cell change.
- `requestIdleCallback` (with timeout) for warm-up composition and housekeeping.

## Memory hygiene
- Dispose on replace: geometry, material, textures (including uniforms), render targets,
  `PMREMGenerator` after use, loaders (`KTX2Loader.dispose()`, DRACO).
- Keep only the active variant's textures on the GPU when swapping (material configurators).
- Leak check: 20 open/close cycles → `info.memory` back to baseline.
- Instanced/batched buffers rotated in a ring of 3 when the GPU may still read them: on ANGLE/D3D11
  Intel, `bufferSubData` into an in-flight buffer forces a CPU–GPU sync (41 → 57 fps after rotating).
