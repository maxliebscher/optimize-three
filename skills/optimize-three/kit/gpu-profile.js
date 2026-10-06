// gpu-profile.js — identify the GPU, classify it, pick a starting tier.
//
// The GPU string is a *starting guess*. The runtime governor (quality.js) corrects it from
// measured frame times. Never ship a tier decision that cannot be corrected at runtime.
//
// Facts this relies on (checked 2026-10):
//  - Chrome: WEBGL_debug_renderer_info returns the full ANGLE string incl. SKU.
//  - Firefox: returns a sanitized family bucket ("Intel(R) HD Graphics", "Radeon R9 200 Series", …).
//  - Safari: always "Apple GPU" (Mac and iOS alike) → use UA/pointer to separate.
//  - Intel Meteor/Lunar Lake iGPUs report "Intel(R) Arc(TM) Graphics" (no model number) — that is
//    NOT a discrete Arc card. Discrete Arc reports "Arc(TM) A770" / "B580" etc.
//  - AMD 680M/780M/890M iGPUs report a generic "AMD Radeon(TM) Graphics".
//  - Chrome on Windows ignores powerPreference for WebGPU and often for WebGL: a hybrid laptop
//    renders on the iGPU unless the *user* changes Windows Graphics settings or a Chrome flag.

const RX = {
  software: /SwiftShader|llvmpipe|softpipe|lavapipe|Microsoft Basic Render|Basic Render Driver|Software Adapter/i,
  intelDiscrete: /Arc(?:\(TM\))?\s*(?:Pro\s*)?[AB]\d{3}/i,
  intel: /Intel/i,
  amdIntegrated: /Radeon(?:\(TM\))?\s*Graphics|Radeon\s*Vega|Vega\s*\d+\s*Graphics|Radeon\s*\d{3}M\b|Radeon\(TM\)\s*\d{3}M/i,
  amdDiscrete: /Radeon\s*(?:\(TM\)\s*)?(?:RX|Pro|VII)|Radeon\s*R9|FirePro/i,
  nvidia: /NVIDIA|GeForce|RTX|GTX|Quadro|Tesla/i,
  appleSilicon: /Apple\s*M(\d)(?:\s*(Pro|Max|Ultra))?/i,
  appleGeneric: /Apple GPU/i,
  mobile: /Adreno|Mali|PowerVR|Immortalis|Xclipse|Apple A\d/i,
};

const TIERS = ['low', 'mid', 'high'];

function readWebGLRendererString() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { renderer: '', vendor: '', webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    const vendor = String((ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '');
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    // Release the probe context immediately: browsers cap live contexts (~16) and an iGPU
    // does not need a second context hanging around.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, vendor, webgl2 };
  } catch {
    return { renderer: '', vendor: '', webgl2: false };
  }
}

function isMobileDevice() {
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS reports as Mac; touch points give it away.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

/** Classify a GPU string. Pure function — unit-testable. */
export function classifyGpu(str, { mobile = false } = {}) {
  const s = String(str || '');
  if (!s) return { gpuClass: 'unknown', tier: mobile ? 'low' : 'mid', why: 'no GPU string' };
  if (RX.software.test(s)) return { gpuClass: 'software', tier: 'low', why: 'software rasterizer' };
  if (RX.mobile.test(s) || (mobile && RX.appleGeneric.test(s))) return { gpuClass: 'mobile', tier: 'low', why: 'mobile GPU' };
  if (RX.nvidia.test(s)) return { gpuClass: 'discrete', tier: 'high', why: 'NVIDIA' };
  if (RX.amdDiscrete.test(s)) return { gpuClass: 'discrete', tier: 'high', why: 'AMD discrete' };
  if (RX.intel.test(s) && RX.intelDiscrete.test(s)) return { gpuClass: 'discrete', tier: 'high', why: 'Intel Arc discrete' };
  if (RX.intel.test(s)) return { gpuClass: 'integrated', tier: 'low', why: 'Intel integrated' };
  if (RX.amdIntegrated.test(s)) return { gpuClass: 'integrated', tier: 'mid', why: 'AMD integrated (680M/780M class can be decent)' };
  const m = s.match(RX.appleSilicon);
  if (m) return { gpuClass: 'apple', tier: m[2] ? 'high' : 'mid', why: `Apple M${m[1]}${m[2] ? ' ' + m[2] : ''}` };
  if (RX.appleGeneric.test(s)) return { gpuClass: 'apple', tier: 'mid', why: 'Safari masks the GPU ("Apple GPU")' };
  return { gpuClass: 'unknown', tier: mobile ? 'low' : 'mid', why: 'unrecognized GPU string' };
}

/**
 * Read URL overrides. Convention used across all kit modules:
 *   ?q=low|mid|high|auto   fixed starting tier (anything but auto locks the governor)
 *   ?dpr=1.25              fixed pixel ratio (locks resolution scaling)
 *   ?fps=30|60|0           frame cap (0 = uncapped, for measuring only)
 *   ?perf                  perf HUD
 *   ?bench                 benchmark mode (uncapped, governor off, GPU timers on)
 *   ?backend=webgl|webgpu  renderer backend
 *   ?aa=0|1                MSAA off/on
 */
export function readOverrides(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  const num = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
  const tier = q.get('q') || q.get('quality');
  return {
    tier: TIERS.includes(tier) ? tier : null,
    dpr: num('dpr'),
    fps: num('fps') ?? num('cap'),
    perf: q.has('perf'),
    bench: q.has('bench'),
    backend: ['webgl', 'webgpu'].includes(q.get('backend')) ? q.get('backend') : null,
    aa: q.has('aa') ? q.get('aa') !== '0' : null,
    raw: q,
  };
}

/**
 * Synchronous GPU profile from WebGL. Call once at startup, before creating the renderer.
 * @returns {{renderer:string, vendor:string, gpuClass:string, tier:'low'|'mid'|'high', why:string,
 *   mobile:boolean, webgl2:boolean, webgpu:boolean, dpr:number, screenPx:number, cores:number,
 *   memoryGB:number|null, reducedMotion:boolean, overrides:object, source:string}}
 */
export function detectGpu({ search } = {}) {
  const { renderer, vendor, webgl2 } = readWebGLRendererString();
  const mobile = isMobileDevice();
  const c = classifyGpu(renderer, { mobile });
  const overrides = readOverrides(search);
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const screenPx = typeof screen !== 'undefined' ? screen.width * screen.height * dpr * dpr : 0;
  let tier = c.tier;
  let why = c.why;
  // Huge physical screens on a mid GPU: start one notch lower; the governor can raise later.
  if (tier === 'mid' && screenPx > 8.3e6 /* > 4K physical */) { tier = 'low'; why += ' + 4K+ screen'; }
  let source = 'gpu-string';
  if (overrides.tier) { tier = overrides.tier; source = 'url'; }
  return {
    renderer, vendor, ...c, tier, why,
    mobile, webgl2,
    webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
    dpr, screenPx,
    cores: navigator.hardwareConcurrency || 4,
    memoryGB: navigator.deviceMemory ?? null,
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    overrides, source,
  };
}

/**
 * Optional async enrichment from WebGPU adapter.info (vendor/architecture). Fields may be
 * empty for privacy reasons; never rely on them alone. Requires a secure context.
 */
export async function detectWebGPUAdapter() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const info = adapter.info || {};
    return {
      vendor: info.vendor || '', architecture: info.architecture || '',
      device: info.device || '', description: info.description || '',
      isFallbackAdapter: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
      features: [...adapter.features],
      limits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxBufferSize: adapter.limits.maxBufferSize },
    };
  } catch {
    return null;
  }
}

/** Short label for HUDs/logs: strips the ANGLE wrapper. Always show this in your perf HUD. */
export function shortGpuName(str) {
  const s = String(str || '').replace(/\((R|TM)\)/g, '');
  const m = s.match(/ANGLE \([^,]*,\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?\s*(?:Direct3D|OpenGL|Vulkan|,)/i);
  return (m ? m[1] : s).replace(/^ANGLE Metal Renderer:\s*/, '').replace(/\s+/g, ' ').trim() || 'unknown GPU';
}

export const GPU_REGEX = RX;
