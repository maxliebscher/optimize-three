// Opt-in real-browser regressions: MEASURE_BROWSER_TESTS=1 npm test
// Uses installed playwright-core and Chromium, no external page or GPU benchmark needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMeasurement } from '../skills/optimize-three/scripts/measurement.mjs';

const enabled = process.env.MEASURE_BROWSER_TESTS === '1';
test('browser: static, demand and capped app callbacks are not observer rAF', { skip: !enabled }, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    for (const source of ['none', 'kit', 'hook']) {
      for (const mode of ['static', 'demand', '30fps']) {
        const page = await browser.newPage();
        await page.addInitScript(installMeasurement);
        await page.goto('data:text/html,<canvas></canvas>');
        await page.evaluate(({ source, mode }) => {
          const ctx = document.querySelector('canvas').getContext('2d');
          let frames = 0, last = null;
          function render() {
            ctx.fillRect(0, 0, 10, 10); frames++;
            if (source === 'hook') window.__measure.recordRenderFrame();
          }
          if (source === 'kit') window.__perf = { report: () => ({ frames, fps: 60, gpuMs: { p50: 7 } }) };
          window.render = render;
          render();
          if (mode === '30fps') {
            const tick = t => { if (last === null || t - last >= 33.0) { render(); last = t; } requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
          }
        }, { source, mode });
        await page.waitForTimeout(250);
        await page.evaluate(() => window.__measure.reset());
        if (mode === 'demand') await page.evaluate(() => { setTimeout(window.render, 100); setTimeout(window.render, 400); });
        await page.waitForTimeout(1100);
        const r = await page.evaluate(() => window.__measure.collect());
        assert.ok(r.rafFps > 35, `${source}/${mode}: observer ticking`);
        if (source === 'none') assert.equal(r.renderFps, null);
        else if (mode === 'static') assert.equal(r.renderFps, 0);
        else if (mode === 'demand') assert.equal(r.renderFrames, 2);
        else assert.ok(r.renderFps > 20 && r.renderFps < 35, `${source}/${mode}: ${r.renderFps}`);
        if (source === 'kit') assert.equal(r.perf.gpuMs.p50, 7);
        await page.close();
      }
    }
  } finally { await browser.close(); }
});
