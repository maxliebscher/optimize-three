// warmup.js — compile every shader variant and upload every texture BEFORE the first real frame.
//
// First-use hitches are the #1 cause of "it stutters when I click something". Three compiles a
// program per (material × lights × shadow × fog × skinning/instancing × OUTPUT TARGET). The output
// target matters: rendering to the canvas gives a tone-mapped sRGB variant, rendering into a
// render target (post chain, reflection, mixed resolution) gives a linear variant. Warming only
// the screen variant caused 5–16 s freezes the first time post-processing engaged.
//
// What this does:
//   1. temporarily makes hidden objects visible (compile only traverses visible objects)
//   2. compiles for the canvas AND for each render target you pass (compileAsync uses
//      KHR_parallel_shader_compile where available → no main-thread block)
//   3. uploads all textures (renderer.initTexture) — biggest first
//   4. renders once into a tiny target with a forced shadow update, so geometry buffers and
//      shadow depth programs exist too
//   5. restores visibility
// Run it behind your loading screen. Keep the number of lights CONSTANT afterwards (light count is
// baked into programs): to "switch a lamp off" set intensity 0, don't remove it or toggle visible.

import * as THREE from 'three';

/**
 * @param {object} o
 * @param {any} o.renderer
 * @param {THREE.Scene} o.scene
 * @param {THREE.Camera} o.camera
 * @param {Array<THREE.RenderTarget|null>} [o.targets]  render targets your frame renders the scene into
 * @param {Array<() => (void|(() => void))>} [o.variants]  callbacks that switch to an alternative
 *        state (e.g. night lights on) and return an undo function; each state is compiled too
 * @param {number} [o.timeoutMs=8000]
 * @param {(p:number) => void} [o.onProgress]
 */
export async function warmup({ renderer, scene, camera, targets = [], variants = [], timeoutMs = 8000, onProgress } = {}) {
  const t0 = performance.now();
  // Reveal hidden meshes, but keep the effective LIGHT set unchanged: light count is part of every
  // program key, so warming with extra lights would compile variants the real frame never uses.
  const offLights = [];
  scene.traverse((o) => { if (o.isLight && !effectivelyVisible(o)) offLights.push([o, o.visible]); });
  const hidden = [];
  scene.traverse((o) => { if (!o.visible && !o.isLight) { hidden.push(o); o.visible = true; } });
  for (const [l] of offLights) l.visible = false;
  const prevTarget = renderer.getRenderTarget();
  const outs = [null, ...targets.filter(Boolean)];
  const states = [null, ...variants];
  let done = 0; const total = outs.length * states.length + 2;
  const tick = () => onProgress?.(++done / total);

  try {
    for (const v of states) {
      const undo = v ? v() : null;
      for (const rt of outs) {
        renderer.setRenderTarget(rt);
        await withTimeout(renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve(renderer.compile(scene, camera)), timeoutMs);
        tick();
      }
      if (typeof undo === 'function') undo();
    }

    // textures: biggest first, so the long uploads happen while the loader is still visible
    const tex = collectTextures(scene).sort((a, b) => texSize(b) - texSize(a));
    for (const t of tex) { try { renderer.initTexture?.(t); } catch { /* compressed/unsupported: ignore */ } }
    tick();

    // one real draw into a tiny target: uploads buffers, compiles shadow depth programs
    const tiny = renderer.isWebGPURenderer ? new THREE.RenderTarget(8, 8) : new THREE.WebGLRenderTarget(8, 8);
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(tiny);
    renderer.render(scene, camera);
    tiny.dispose();
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true; // the real frame redraws with real visibility
    tick();
  } finally {
    for (const o of hidden) o.visible = false;
    for (const [l, v] of offLights) l.visible = v;
    renderer.setRenderTarget(prevTarget);
  }
  return { ms: Math.round(performance.now() - t0), programs: renderer.info?.programs?.length ?? null };
}

export function collectTextures(root) {
  const set = new Set();
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) for (const k in m) { const v = m[k]; if (v && v.isTexture) set.add(v); }
    if (m_uniforms(o)) for (const u of Object.values(o.material.uniforms)) if (u?.value?.isTexture) set.add(u.value);
  });
  if (root.background?.isTexture) set.add(root.background);
  if (root.environment?.isTexture) set.add(root.environment);
  return [...set];
}
const effectivelyVisible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
const m_uniforms =(o) => o.material && !Array.isArray(o.material) && o.material.uniforms;
const texSize = (t) => { const i = t.image; return i ? (i.width || 0) * (i.height || 0) * (i.depth || 1) : 0; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * Decode large images off the main thread. A 4096² <img> texture costs 200–400 ms of main-thread
 * decode; createImageBitmap does it in the background. Match flip/premultiply/colorspace yourself.
 */
export async function loadBitmapTexture(url, { flipY = false, srgb = true } = {}) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: flipY ? 'flipY' : 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bmp);
  t.flipY = false; // ImageBitmap ignores flipY at upload; orientation was handled above
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
