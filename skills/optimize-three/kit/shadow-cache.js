// shadow-cache.js — redraw shadow maps only when something that casts shadows changed.
//
// Shadow maps do not depend on the camera (for a fixed-frustum directional/spot light). With
// renderer.shadowMap.autoUpdate = false they are drawn only when needsUpdate is set. This builds
// an exact numeric signature of everything that affects the map — light pose and frustum, map
// size, every casting mesh's matrixWorld / geometry + attribute version / draw range / material
// version / instance count + instanceMatrix version, LOD level visibility — and compares it with
// the previous frame. Typical result: hundreds of shadow draws per frame → 0 when idle.
//
// Rules:
//  - call check() AFTER all scene changes of the frame and set needsUpdate IMMEDIATELY before the
//    main render — not before helper renders (reflection, mask, thumbnail), or the map gets drawn
//    from that helper's partial scene. update() does exactly that for you if you call it last.
//  - invalidate() after any render outside the main loop (thumbnails), on context restore,
//    visibilitychange, resize, LoadingManager.onLoad.
//  - vertex-shader animation (wind sway) is invisible to the signature: keep it out of the
//    depth material, or mark that light as autoUpdate.
//  - camera-following shadow frusta (CSM, "shadow box follows camera") change every frame by
//    design — snap their center to texel-sized steps so the signature only changes per step.

/**
 * @param {object} o
 * @param {THREE.WebGLRenderer|THREE.WebGPURenderer} o.renderer
 * @param {THREE.Scene} o.scene
 * @param {THREE.Camera} o.camera  (only for LOD selection)
 * @param {THREE.Light[]} [o.lights]  shadow-casting lights; default: all found in scene
 * @param {() => THREE.Object3D[]} [o.roots]  subtrees whose casters can change; default: [scene]
 * @param {number} [o.safetyMs=10000]  periodic forced redraw (GPU process may drop map contents)
 */
export function createShadowCache({ renderer, scene, camera, lights, roots, safetyMs = 10000 }) {
  const sm = renderer.shadowMap;
  sm.autoUpdate = false;
  sm.needsUpdate = true;
  const R = roots || (() => [scene]);
  let prev = new Float64Array(0), cur = new Float64Array(4096), n = 0, forced = 2, renders = 0, lastForce = performance.now();
  let lods = collect(scene, (o) => o.isLOD);
  let lightList = lights || collect(scene, (o) => o.isLight && o.castShadow);
  const L = () => lightList;

  const put = (v) => { if (n >= cur.length) { const b = new Float64Array(cur.length * 2); b.set(cur); cur = b; } cur[n++] = v; };
  function visit(o, vis) {
    vis = vis && o.visible;
    if (!vis) { put(-o.id); return; }
    if ((o.isMesh || o.isPoints || o.isLine) && o.castShadow) {
      const e = o.matrixWorld.elements;
      for (let i = 0; i < 16; i++) put(e[i]);
      const g = o.geometry, pa = g.attributes.position, m = o.material;
      put(g.id); put(pa ? pa.version : 0); put(g.index ? g.index.version : 0); put(g.drawRange.start); put(g.drawRange.count);
      if (Array.isArray(m)) for (const x of m) { put(x.id); put(x.version); put(x.visible ? 1 : 0); }
      else if (m) { put(m.id); put(m.version); put(m.visible ? 1 : 0); }
      if (o.isInstancedMesh) { put(o.count); put(o.instanceMatrix.version); }
      // BatchedMesh keeps per-instance matrices in a private DataTexture; if that ever changes
      // shape, fall back to "always dirty" rather than serving stale shadows.
      if (o.isBatchedMesh) { const mt = o._matricesTexture; put(mt ? mt.version : Math.random()); put(o.instanceCount ?? o._instanceInfo?.length ?? 0); }
      if (o.isSkinnedMesh) put(Math.random()); // skinned casters change every frame
      if (o.morphTargetInfluences) for (const w of o.morphTargetInfluences) put(w);
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) visit(ch[i], vis);
  }

  return {
    get renders() { return renders; },
    /** force a redraw on the next update()/check() */
    invalidate() { forced = 2; },
    /** re-scan for LOD objects after adding/removing them */
    rescan() { lods = collect(scene, (o) => o.isLOD); if (!lights) lightList = collect(scene, (o) => o.isLight && o.castShadow); forced = 2; },
    /** true if the shadow maps must be redrawn this frame */
    check() {
      scene.updateMatrixWorld();
      for (const l of lods) l.update(camera);
      n = 0;
      for (const l of L()) {
        put(l.id); put(l.visible ? 1 : 0); put(l.castShadow ? 1 : 0);
        const e = l.matrixWorld.elements; for (let i = 0; i < 16; i++) put(e[i]);
        if (l.target) { const t = l.target.matrixWorld.elements; put(t[12]); put(t[13]); put(t[14]); }
        const s = l.shadow; if (s) {
          put(s.mapSize.x); put(s.mapSize.y); put(s.bias); put(s.normalBias); put(s.radius);
          const c = s.camera; put(c.left ?? c.fov ?? 0); put(c.right ?? 0); put(c.top ?? 0); put(c.bottom ?? 0); put(c.near); put(c.far);
        }
      }
      put(scene.children.length);
      for (const l of lods) for (const lv of l.levels) put(lv.object.visible ? 1 : 0);
      for (const r of R()) if (r) visit(r, true);
      const t = performance.now();
      if (safetyMs && t - lastForce > safetyMs) { forced = Math.max(forced, 1); lastForce = t; }
      let same = forced === 0 && n === prev.length;
      if (same) for (let i = 0; i < n; i++) if (cur[i] !== prev[i]) { same = false; break; }
      if (!same) { if (prev.length !== n) prev = new Float64Array(n); prev.set(cur.subarray(0, n)); renders++; }
      if (forced > 0) forced--;
      return !same;
    },
    /** check() and set needsUpdate. Call right before the MAIN render. */
    update() { const dirty = this.check(); if (dirty) sm.needsUpdate = true; return dirty; },
  };
}

function collect(root, pred) { const out = []; root.traverse((o) => { if (pred(o)) out.push(o); }); return out; }
