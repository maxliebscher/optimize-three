// lifecycle.js — context loss, disposal, page lifecycle. The unglamorous part that makes a demo
// survive a laptop going to sleep, a GPU driver reset, an iframe being unmounted or a bfcache trip.

/**
 * Dispose everything under root: unique geometries, materials, textures (incl. uniforms),
 * skeleton bone textures. Safe to call twice. Removes root from its parent unless keep=true.
 */
export function disposeObject(root, { keep = false } = {}) {
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      mats.add(m);
      for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture) texs.add(u.value);
    }
    if (o.skeleton?.boneTexture) texs.add(o.skeleton.boneTexture);
    if (o.isInstancedMesh || o.isBatchedMesh) o.dispose?.();
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  for (const t of texs) t.dispose();
  if (!keep) root.removeFromParent?.();
  return { geometries: geos.size, materials: mats.size, textures: texs.size };
}

/**
 * Handle GPU context loss for WebGL and WebGPU.
 *  - WebGL: preventDefault() on webglcontextlost is REQUIRED, or the browser never restores.
 *    Three re-uploads resources on restore; re-arm shadow caches and re-render.
 *  - WebGPU: renderer.onDeviceLost fires; resources cannot be restored → reload or rebuild.
 *  - reloadOnRestore: simplest robust policy for complex apps (custom RTs, baked data).
 */
export function handleContextLoss(renderer, { loop, shadowCache, onLost, onRestored, reloadOnRestore = false, reloadAfterMs = 0 } = {}) {
  const canvas = renderer.domElement;
  let timer = null;
  const lost = (e) => {
    e?.preventDefault?.();
    loop?.suspend('context');
    onLost?.(e);
    if (reloadAfterMs) timer = setTimeout(() => location.reload(), reloadAfterMs);
  };
  const restored = () => {
    clearTimeout(timer);
    if (reloadOnRestore) { location.reload(); return; }
    shadowCache?.invalidate();
    onRestored?.();
    loop?.resume('context');
  };
  if (renderer.isWebGPURenderer) {
    renderer.onDeviceLost = (info) => { lost(); console.warn('[optimize-three] WebGPU device lost', info); };
    return () => { renderer.onDeviceLost = null; };
  }
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return () => { canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored); clearTimeout(timer); };
}

/**
 * pagehide/pageshow: suspend for bfcache, dispose for real unload. Returns an unbind function.
 * Use the returned dispose() also when your component unmounts (SPA route change, iframe removal).
 */
export function bindPageLifecycle({ renderer, scene, loop, extraDispose } = {}) {
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    loop?.dispose?.();
    extraDispose?.();
    if (scene) disposeObject(scene, { keep: true });
    renderer?.dispose?.();
    renderer?.forceContextLoss?.(); // free the context slot right away (browsers cap live contexts)
  };
  const onHide = (e) => { if (e.persisted) loop?.suspend('bfcache'); else dispose(); };
  const onShow = (e) => { if (e.persisted) loop?.resume('bfcache'); };
  addEventListener('pagehide', onHide);
  addEventListener('pageshow', onShow);
  return { dispose, unbind: () => { removeEventListener('pagehide', onHide); removeEventListener('pageshow', onShow); } };
}

/**
 * Leak check for QA: run fn n times (open/close a view, switch a variant) and compare
 * renderer.info.memory before/after. Geometries/textures must return to the baseline.
 */
export async function leakCheck(renderer, fn, n = 20) {
  const m = renderer.info.memory;
  const before = { geometries: m.geometries, textures: m.textures, programs: renderer.info.programs?.length ?? 0 };
  for (let i = 0; i < n; i++) await fn(i);
  const after = { geometries: m.geometries, textures: m.textures, programs: renderer.info.programs?.length ?? 0 };
  return { before, after, leaked: after.geometries > before.geometries || after.textures > before.textures };
}
