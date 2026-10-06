// gpu-hint.js — tell the user how to switch to the fast GPU, but only when it actually matters.
//
// A web page cannot choose the GPU. powerPreference is a hint that Chrome on Windows ignores on
// hybrid laptops: the browser runs on the iGPU unless the USER sets Windows Settings → System →
// Display → Graphics → (browser) → "High performance", or enables chrome://flags/#force-high-performance-gpu.
// Many "my showcase runs at 12 fps" reports are exactly this.
//
// Shown once (remembered), only on Windows, only for an integrated GPU, and only after measuring
// that it really struggles (default: > 35 % of 300 frames slower than 40 ms, after 12 s).
// ?nogpuhint disables it.

const KEY = 'optimize-three.gpu-hint.v1';

const TEXT = {
  en: {
    title: 'Running on the power-saving graphics chip',
    body: 'This computer seems to have a faster graphics card that the browser is not using. Windows: Settings → System → Display → Graphics → choose your browser → "High performance", then restart the browser.',
    ok: 'Got it',
  },
  de: {
    title: 'Läuft auf dem Stromspar-Grafikchip',
    body: 'Dieser Rechner hat vermutlich eine schnellere Grafikkarte, die der Browser nicht nutzt. Windows: Einstellungen → System → Anzeige → Grafik → Browser wählen → „Hohe Leistung“, danach den Browser neu starten.',
    ok: 'Verstanden',
  },
};

export function createGpuHint({ profile, lang = (navigator.language || 'en').slice(0, 2), afterS = 12, frames = 300, slowMs = 40, slowShare = 0.35, force = false } = {}) {
  const win = /Windows/i.test(navigator.userAgentData?.platform || navigator.userAgent || '');
  let seen = false;
  try { seen = !!localStorage.getItem(KEY); } catch { /* ignore */ }
  const disabled = /[?&]nogpuhint\b/.test(location.search);
  const eligible = force || (win && profile?.gpuClass === 'integrated' && !seen && !disabled);
  const t0 = performance.now();
  let n = 0, slow = 0, shown = false;

  function show() {
    if (shown) return; shown = true;
    const t = TEXT[lang] || TEXT.en;
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;max-width:380px;z-index:2147483000;padding:16px 18px;border-radius:10px;'
      + 'background:#14181d;color:#eef2f5;font:16px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
    box.innerHTML = `<strong style="display:block;font-size:18px;margin-bottom:6px"></strong><span></span>`
      + `<button style="display:block;margin-top:12px;min-height:44px;padding:0 18px;border:0;border-radius:8px;background:#3d7eff;color:#fff;font:inherit;cursor:pointer"></button>`;
    box.querySelector('strong').textContent = t.title;
    box.querySelector('span').textContent = t.body;
    const b = box.querySelector('button'); b.textContent = t.ok;
    b.onclick = () => { box.remove(); try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
    document.body.appendChild(box);
  }

  return {
    eligible,
    /** feed rendered-frame intervals (ms) */
    sample(interval) {
      if (!eligible || shown || document.hidden || performance.now() - t0 < afterS * 1000) return;
      n++; if (interval > slowMs) slow++;
      if (n >= frames) { if (slow / n > slowShare) show(); else { n = 0; slow = 0; } }
    },
    show,
  };
}
