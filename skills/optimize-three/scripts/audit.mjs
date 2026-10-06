#!/usr/bin/env node
// audit.mjs — static scan of a browser-3D project for the usual performance/robustness gaps.
// No dependencies. Heuristic: it points you at places to look, it does not prove anything.
//
//   node audit.mjs [projectDir] [--json] [--include=src,app] [--max-files=4000]
//
// Exit code is always 0 (it's a checklist, not a gate). Pair with measure.mjs for numbers.

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const root = argv.find((a) => !a.startsWith('--')) || process.cwd();
const MAX = +(flags['max-files'] || 4000);
const SKIP = /^(node_modules|\.git|dist|build|out|\.next|\.vite|coverage|vendor|third[-_]?party|\.cache|videos?|qa-output|playwright-report)$/i;
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.html']);
const ASSET = new Set(['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ktx2', '.hdr', '.exr', '.bin', '.drc']);

const code = [], assets = [];
let scanned = 0;
(function walk(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (scanned > MAX) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.test(e.name) && !e.name.startsWith('.')) walk(p); continue; }
    const x = extname(e.name).toLowerCase();
    if (CODE.has(x) && !/\.min\.|\.d\.ts$|three\.(module|core|webgpu)/.test(e.name)) {
      const st = statSync(p);
      if (st.size < 3e6) { code.push({ p, s: readFileSync(p, 'utf8') }); scanned++; }
    } else if (ASSET.has(x)) assets.push({ p, size: statSync(p).size, x });
  }
})(root);

// Strip comments so advice in comments ("PCFSoftShadowMap is removed") does not trigger findings.
// Approximate: /* */ blocks and // comments that start a line or follow whitespace (keeps URLs).
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[\s;{}])\/\/[^\n]*/g, '$1');
for (const f of code) f.s = strip(f.s);
const all = code.map((f) => f.s).join('\n');
const has = (re) => re.test(all);
const where = (re, n = 3) => {
  const out = [];
  for (const f of code) {
    const lines = f.s.split('\n');
    for (let i = 0; i < lines.length && out.length < n; i++) if (re.test(lines[i])) out.push(`${relative(root, f.p)}:${i + 1}`);
    if (out.length >= n) break;
  }
  return out;
};

// three version
let threeVer = null;
try { const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); threeVer = (pj.dependencies?.three || pj.devDependencies?.three || '').replace(/^[^\d]*/, '') || null; } catch { /* none */ }
if (!threeVer) {
  let d = root;
  for (let i = 0; i < 4 && !threeVer; i++) { d = join(d, '..'); try { const pj = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); threeVer = (pj.dependencies?.three || pj.devDependencies?.three || '').replace(/^[^\d]*/, '') || null; } catch { /* none */ } }
}
if (!threeVer) { const m = all.match(/REVISION\s*=\s*['"](\d+)/) || all.match(/three@0\.(\d+)/); if (m) threeVer = '0.' + m[1]; }
if (!threeVer) {
  // vendored copy in a skipped folder?
  for (const cand of ['vendor/three.module.js', 'vendor/three.core.js', 'lib/three.module.js', 'node_modules/three/package.json']) {
    try { const s = readFileSync(join(root, cand), 'utf8'); const m = s.match(/REVISION\s*=\s*['"](\d+)/) || s.match(/"version":\s*"([\d.]+)"/); if (m) { threeVer = m[1].includes('.') ? m[1] : '0.' + m[1]; break; } } catch { /* none */ }
  }
}
const rev = threeVer ? +(threeVer.split('.')[1] || threeVer) : null;

const usesThree = has(/from\s+['"]three['"/]|THREE\.|WebGLRenderer|WebGPURenderer/);
const webgpu = has(/WebGPURenderer|three\/webgpu/);
const composer = has(/EffectComposer|RenderPipeline|PostProcessing\(|new\s+\w*Composer/);

// Projects using the optimize-three kit get these from it (createPerfKit wires them).
const usesKit = has(/createPerfKit|createFrameLoop|createGovernor|optimize-three\/kit|from\s+['"][^'"]*kit\/index\.js/);
const KIT = new Set(['no-visibility', 'dt-unclamped', 'no-fps-cap', 'no-offscreen-pause', 'no-demand', 'power-pref', 'dpr-none', 'dpr-cap',
  'shadow-every-frame', 'no-context-loss', 'no-dispose', 'no-gpu-id', 'no-adaptive', 'no-hud', 'shader-errors', 'webgpu-only', 'shadow-resize']);
if (usesKit && has(/\bwarmup\(/)) KIT.add('no-warmup');
const F = []; // findings: [severity, id, message, locations]
const add = (sev, id, msg, loc = []) => { if (!(usesKit && KIT.has(id))) F.push({ sev, id, msg, loc }); };

if (!usesThree) add('info', 'no-three', 'No three.js usage detected — most checks below assume three.js.');

// --- resolution
if (has(/setPixelRatio\(\s*(window\.)?devicePixelRatio\s*\)/)) add('high', 'dpr-uncapped', 'setPixelRatio(devicePixelRatio) without a cap: a 3× phone or 2× 4K laptop renders 4–9× the pixels. Cap (≤ 1.5–2) or use a pixel budget.', where(/setPixelRatio\(\s*(window\.)?devicePixelRatio\s*\)/));
if (!has(/setPixelRatio/)) add('med', 'dpr-none', 'No setPixelRatio call — check how the drawing buffer is sized (HiDPI screens).');
if (!has(/devicePixelRatio[^;\n]*(Math\.min|<|clamp)|Math\.min\([^)]*devicePixelRatio/)) add('low', 'dpr-cap', 'No visible DPR cap expression found.');

// --- loop & time
const loopRe = /requestAnimationFrame|setAnimationLoop/;
if (!has(loopRe)) add('info', 'loop-none', 'No render loop found (static render?).');
else {
  if (!has(/visibilitychange|document\.hidden/)) add('high', 'no-visibility', 'No visibilitychange handling: hidden tabs keep rendering (on some browsers) and the first frame back jumps by the whole hidden time.', where(loopRe));
  if (!has(/Math\.min\([^)]*(dt|delta|elapsed)|(dt|delta)\s*=\s*Math\.min|clamp\([^)]*(dt|delta)/i)) add('med', 'dt-unclamped', 'No delta-time clamp found: after a stall the simulation jumps. Clamp dt (0.05–0.1 s) or use a fixed-step accumulator.');
  if (!has(/1000\s*\/\s*[\w.]*(fps|Fps|FPS|cap|Cap|hz|Hz|rate)\b|1000\s*\/\s*\d+\b|frameInterval|fpsCap|maxFps|MAX_FPS|FRAME_MS|minFrameMs/)) add('med', 'no-fps-cap', 'No frame cap found: on 120/144/240 Hz displays the GPU renders 2–4× more than needed (heat, fan noise, battery). Cap at 60 (or 30 on weak GPUs) with even pacing.');
  if (!has(/IntersectionObserver/)) add('low', 'no-offscreen-pause', 'No IntersectionObserver: an embedded canvas scrolled out of view keeps rendering.');
  if (!has(/needsRender|invalidate\(|renderRequested|dirty|wakeUntil|requestRender/)) add('low', 'no-demand', 'No render-on-demand pattern found. Viewers/configurators should sleep when nothing changes.');
  if (has(/setTimeout\([^)]*requestAnimationFrame|setTimeout\(\s*\(\)\s*=>\s*requestAnimationFrame/)) add('med', 'timeout-raf', 'setTimeout before requestAnimationFrame: can miss vsync and halve the frame rate. Stay on rAF and skip frames instead.', where(/setTimeout\([^)]*requestAnimationFrame|setTimeout\(\s*\(\)\s*=>\s*requestAnimationFrame/));
}

// --- renderer options
if (has(/powerPreference\s*:\s*['"]low-power/)) add('info', 'low-power', 'powerPreference low-power: fine for small sleeping widgets/splash canvases, wrong for the main showcase renderer.', where(/powerPreference\s*:\s*['"]low-power/));
else if (usesThree && !has(/powerPreference/)) add('low', 'power-pref', "No powerPreference: three defaults to 'default'. Use 'high-performance' (still only a hint on hybrid laptops).");
if (has(/preserveDrawingBuffer\s*:\s*true/)) add('med', 'preserve-db', 'preserveDrawingBuffer: true costs a copy every frame. Capture screenshots right after render() in the same task instead.', where(/preserveDrawingBuffer\s*:\s*true/));
if (composer && has(/antialias\s*:\s*true/)) add('med', 'msaa-wasted', 'antialias:true with a post-processing chain: the canvas MSAA is wasted (the scene is drawn into a render target). Put samples on the scene target instead and turn canvas AA off.', where(/antialias\s*:\s*true/));
if (has(/logarithmicDepthBuffer\s*:\s*true/)) add('low', 'logdepth', 'logarithmicDepthBuffer disables early-z (fragment depth write). Prefer reversedDepthBuffer where supported (r17x+).', where(/logarithmicDepthBuffer\s*:\s*true/));

// --- shadows & lights
if (has(/castShadow\s*=\s*true/)) {
  if (!has(/shadowMap\.autoUpdate\s*=\s*false|autoUpdate\s*=\s*false/)) add('med', 'shadow-every-frame', 'Shadow maps re-render every frame. For static or rarely changing casters: renderer.shadowMap.autoUpdate = false + needsUpdate on change (kit/shadow-cache.js).');
  if (has(/PCFSoftShadowMap/) && (rev == null || rev >= 183)) add('low', 'pcfsoft', 'PCFSoftShadowMap is deprecated (r183) / removed (r186) and falls back to PCFShadowMap. Use PCFShadowMap + shadow.radius, or VSM.', where(/PCFSoftShadowMap/));
  if (has(/mapSize\.(set|width|height)/) && !has(/shadow\.map\??\.dispose|map\.dispose\(\)[^\n]*\n?[^\n]*map\s*=\s*null|shadow\.map\s*=\s*null/)) add('low', 'shadow-resize', 'Changing shadow.mapSize at runtime needs shadow.map.dispose(); shadow.map = null; to take effect.', where(/mapSize\.(set|width|height)/));
}
if (has(/\.castShadow\s*=\s*!|castShadow\s*=\s*(on|enabled|q\.|quality|level)/) || has(/light\w*\.visible\s*=/i)) add('med', 'light-toggle', 'Lights/castShadow toggled at runtime: light count is baked into every program → recompile hitch. Keep lights constant, set intensity 0 instead.', where(/\.castShadow\s*=\s*!|light\w*\.visible\s*=/i));

// --- materials / passes
if (has(/transmission\s*[:=]\s*(?!0\b)[\d.]/)) add('med', 'transmission', 'MeshPhysicalMaterial.transmission re-renders the opaque scene into a transmission target (often ~half the frame). Use only where it shows; lower renderer.transmissionResolutionScale.', where(/transmission\s*[:=]\s*(?!0\b)[\d.]/));
if (has(/new\s+(THREE\.)?CubeCamera|new\s+Reflector|new\s+(THREE\.)?Refractor/) && !has(/reflect\w*\.(visible|enabled)\s*=|occlusion|ANY_SAMPLES_PASSED/)) add('low', 'reflections', 'Real-time reflections (CubeCamera/Reflector): make sure they update only when visible/changed and at reduced resolution.', where(/CubeCamera|Reflector|Refractor/));
if (has(/onBeforeCompile/) && !has(/customProgramCacheKey/)) add('med', 'cache-key', 'onBeforeCompile without customProgramCacheKey: different patches can share/clobber programs or recompile.', where(/onBeforeCompile/));
if (has(/ShaderMaterial/) && !has(/colorspace_fragment|colorspace_pars|linearToOutputTexel|sRGBTransferOETF/)) add('low', 'colorspace', 'Custom ShaderMaterial without #include <colorspace_fragment> / tonemapping_fragment: colours drift from built-in materials.', where(/ShaderMaterial/));
if (webgpu && has(/ShaderMaterial|onBeforeCompile|EffectComposer/)) add('high', 'webgpu-incompatible', 'WebGPURenderer with ShaderMaterial / onBeforeCompile / EffectComposer: these do not run on WebGPURenderer. Port to TSL / RenderPipeline or stay on WebGLRenderer.');
if (webgpu && !has(/isWebGPUBackend|forceWebGL|navigator\.gpu|WebGLRenderer/)) add('med', 'webgpu-only', 'WebGPU path without visible backend check/fallback. Never make WebGPU the only way in; log which backend actually runs.');
if (webgpu && has(/renderAsync\(/) && (rev == null || rev >= 181)) add('low', 'render-async', 'renderAsync() is deprecated since r181: await renderer.init() once, then render().', where(/renderAsync\(/));
if (webgpu && has(/new\s+(THREE\.)?PostProcessing\(/) && (rev == null || rev >= 183)) add('low', 'postprocessing-renamed', 'PostProcessing was renamed RenderPipeline in r183.', where(/new\s+(THREE\.)?PostProcessing\(/));
if (has(/new\s+(THREE\.)?Clock\(/) && (rev == null || rev >= 183)) add('info', 'clock', 'THREE.Clock is deprecated (r183) in favour of THREE.Timer.', where(/new\s+(THREE\.)?Clock\(/));

// --- warm-up / stalls
if (usesThree && !has(/\.compile(Async)?\(/)) add('med', 'no-warmup', 'No renderer.compile/compileAsync: shaders compile on first use → hitches when objects/effects first appear. Warm up behind the loader, for the canvas AND each render target.');
if (composer && has(/\.compile(Async)?\(/) && !has(/setRenderTarget\([^)]*\)[\s\S]{0,200}compile/)) add('low', 'warmup-rt', 'Warm-up seems to compile only the screen variant. Render-target (linear) variants differ — compile those too.');
if (has(/checkShaderErrors\s*=\s*true/) || (usesThree && !has(/checkShaderErrors/))) add('low', 'shader-errors', 'renderer.debug.checkShaderErrors is true by default: synchronous program checks (measured 0.2–0.3 s each). Disable in production.');

// --- draw calls / memory
const meshNews = (all.match(/new\s+(THREE\.)?Mesh\(/g) || []).length;
const inst = has(/InstancedMesh|BatchedMesh|mergeGeometries|mergeBufferGeometries/);
if (meshNews > 25 && !inst) add('med', 'no-instancing', `${meshNews} "new Mesh(" sites and no InstancedMesh/BatchedMesh/mergeGeometries: repeated objects should be instanced, static ones merged (target ≤ 150–300 draws).`);
if (has(/InstancedMesh/) && !has(/computeBoundingSphere|frustumCulled\s*=\s*false/)) add('low', 'instanced-bounds', 'InstancedMesh with spread-out instances needs computeBoundingSphere() (or frustumCulled=false), or it pops out of view.');
if (!has(/\.dispose\(\)/)) add('med', 'no-dispose', 'No dispose() calls: geometry/material/texture/render-target memory is never freed when content changes.');
if (!has(/webglcontextlost|onDeviceLost|device\.lost/)) add('med', 'no-context-loss', 'No context-loss handling (webglcontextlost + preventDefault / WebGPU device.lost). Sleep, driver resets and GPU switches will leave a dead canvas.');
const perFrameAlloc = code.flatMap((f) => {
  const out = []; const re = /(function\s+(animate|render|tick|loop|update|frame)\b|(animate|render|tick|loop|frame)\s*[=:]\s*(\([^)]*\)|\w+)\s*=>)[\s\S]{0,1500}?new\s+(THREE\.)?(Vector[234]|Matrix4|Quaternion|Color|Euler|Box3|Raycaster)\(/g;
  let m; while ((m = re.exec(f.s)) && out.length < 3) out.push(`${relative(root, f.p)}:${f.s.slice(0, m.index).split('\n').length}`);
  return out;
}).slice(0, 4);
if (perFrameAlloc.length) add('low', 'per-frame-alloc', 'Possible allocations inside the frame function (new Vector3/Matrix4/… per frame → GC hitches). Hoist scratch objects.', perFrameAlloc);

// --- measurement & UX
if (!has(/renderer\.info|__perf|stats\.js|Stats\(|\?perf|has\(['"]perf/)) add('low', 'no-hud', 'No perf readout (?perf HUD / renderer.info): nobody can tell which GPU ran or why it is slow.');
if (!has(/UNMASKED_RENDERER|WEBGL_debug_renderer_info|adapter\.info|detectGpu|detect-gpu/)) add('med', 'no-gpu-id', 'GPU is never identified/logged: you can neither pick a starting tier nor notice that you measured the iGPU.');
const tierTable = has(/(tiers?|qualit(y|ies)|presets?|levels?|QLEVELS|LV)\s*[=:]\s*[\[{]/i);
const adaptive = has(/adaptive|governor|dynamicRes|renderScale|resolutionScale|dprScale|drs\.|applyQuality|setQuality|quality\.tick|qualityTick/i);
if (!tierTable || !adaptive) add('med', 'no-adaptive', 'No visible quality tiers / adaptive resolution. Weak GPUs need a ladder (DPR → shadows → effects → detail) and a governor with hysteresis.');
if (!has(/prefers-reduced-motion/)) add('low', 'reduced-motion', 'No prefers-reduced-motion handling (autoplay camera flights, idle sway).');

// --- assets
const MB = 1048576;
for (const a of assets) {
  if ((a.x === '.glb' || a.x === '.gltf') && a.size > 8 * MB) add('med', 'big-glb', `${relative(root, a.p)} is ${(a.size / MB).toFixed(1)} MB. gltf-transform optimize (meshopt + KTX2/WebP, resize ≤ 2048) or split/lazy-load.`);
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(a.x)) {
    const d = imageSize(a.p);
    if (d && Math.max(d.w, d.h) > 4096) add('med', 'huge-texture', `${relative(root, a.p)} is ${d.w}×${d.h}: ${((d.w * d.h * 4 * 1.33) / MB).toFixed(0)} MB of GPU memory as RGBA8 with mips (file size is irrelevant on the GPU).`);
  }
}
const glbs = assets.filter((a) => a.x === '.glb');
if (glbs.length && !has(/MeshoptDecoder|setMeshoptDecoder|DRACOLoader|setDRACOLoader/)) add('low', 'no-geo-compression', 'GLBs loaded without meshopt/Draco decoder: geometry is uncompressed (or the loader will fail on compressed files).');
if (glbs.length && !has(/KTX2Loader/) && assets.filter((a) => /\.(png|jpe?g)$/.test(a.p)).length > 10) add('info', 'no-ktx2', 'Many PNG/JPG textures and no KTX2: GPU memory = full RGBA8. KTX2 (ETC1S/UASTC) cuts VRAM 4–8× and upload stalls.');

function imageSize(p) {
  try {
    const fd = openSync(p, 'r'); const b = Buffer.alloc(64 * 1024); const n = readSync(fd, b, 0, b.length, 0); closeSync(fd);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < n - 9) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + b.readUInt16BE(i + 2); } }
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const f = b.toString('ascii', 12, 16);
      if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (f === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    }
  } catch { /* unreadable */ }
  return null;
}

// --- report
const order = { high: 0, med: 1, low: 2, info: 3 };
F.sort((a, b) => order[a.sev] - order[b.sev]);
if (flags.json) { console.log(JSON.stringify({ root, three: threeVer, files: code.length, assets: assets.length, findings: F }, null, 2)); process.exit(0); }
const icon = { high: '✖', med: '▲', low: '•', info: 'i' };
console.log(`optimize-three audit · ${basename(root)} · three ${threeVer ?? '?'}${webgpu ? ' · WebGPU' : ''}${composer ? ' · post chain' : ''} · ${code.length} code files · ${assets.length} assets`);
console.log(`${F.filter((f) => f.sev === 'high').length} high · ${F.filter((f) => f.sev === 'med').length} medium · ${F.filter((f) => f.sev === 'low').length} low\n`);
for (const f of F) {
  console.log(`${icon[f.sev]} [${f.sev}] ${f.id}: ${f.msg}`);
  for (const l of f.loc) console.log(`    ${l}`);
}
if (!F.length) console.log('No findings. Now measure on real hardware: scripts/measure.mjs --gpu=both');
