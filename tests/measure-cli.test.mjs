import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the Playwright transport is replaced. The production CLI and injected recorder run unchanged.
test('CLI keeps GPU/JSON fields and separately labels render fps and observer rAF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-test-'));
  try {
    for (const source of ['none', 'kit', 'hook']) for (const mode of ['static', 'demand', '30fps']) {
      const json = join(dir, 'result.json');
      const stdout = execFileSync(process.execPath, [
        '--no-warnings', '--loader', new URL('./fixtures/measure-loader.mjs', import.meta.url).pathname,
        new URL('../skills/optimize-three/scripts/measure.mjs', import.meta.url).pathname,
        `http://fixture/${mode}?source=${source}`, '--gpu=both', '--warmup=1', '--seconds=2', `--json=${json}`,
      ], { encoding: 'utf8' });
      assert.match(stdout, /render fps\tsource\traf Hz/);
      assert.doesNotMatch(stdout, /fps\*/);
      const data = JSON.parse(readFileSync(json, 'utf8'));
      assert.equal(data.results.length, 2);
      assert.equal(data.seconds, 2); assert.equal(data.warm, 1);
      for (const r of data.results) {
        assert.ok(['dgpu', 'igpu'].includes(r.gpu));
        assert.equal(r.gpuString, 'Fixture Hardware GPU'); assert.equal(r.valid, true);
        for (const key of ['loadMs', 'rafFps', 'rafP50', 'rafP95', 'rafMax', 'longTasks', 'longTaskMs', 'heapMB', 'perf', 'errors']) {
          assert.ok(key in r, `retained ${key}`);
        }
        assert.ok(Math.abs(r.rafFps - 60) < 0.01);
        assert.equal(r.measurementMs, 2000);
        if (source === 'none') assert.equal(r.renderFps, null);
        else if (mode === 'static') assert.equal(r.renderFps, 0);
        else if (mode === 'demand') assert.ok(r.renderFps > 0 && r.renderFps < 5);
        else assert.ok(Math.abs(r.renderFps - 30) < 1);
        if (source === 'kit') assert.equal(r.perf.gpuMs.p50, 7);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
