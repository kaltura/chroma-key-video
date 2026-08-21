// Performance benchmark for chroma-key-video. The measurement suite lives in
// test/bench-core.js (shared with the self-service page test/bench.html);
// this spec drives it headlessly and enforces regression gates.
//
// Runs on the synthetic 1280x720 green-screen source by default (no network
// needed), or on a real clip when BENCH_SRC is set to a server-relative video
// URL (npm run bench:footage benches the wind-blown-hair stress clip).
//
// Engines: --project=bench (Chromium/SwiftShader), bench-firefox,
// bench-webkit. Results land in bench-results[-{engine}][-footage].json —
// no suffix for the Chromium baseline.
//
// Assertions are loose sanity ceilings sized for software rendering on CI —
// they catch order-of-magnitude regressions, not run-to-run noise.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const SRC = process.env.BENCH_SRC || null;

// Sized against GitHub's 2-core hosted runner under SwiftShader (measured:
// key 61ms, dissolve 153ms, cpu 5ms, autoTune 3ms, fps1 9.5, fps12 11 each)
// with ~3x headroom so only genuine regressions trip.
const CEILINGS = {
  webglKeyMs: 200,
  webglDissolveMs: 450,
  cpuKeyMs: 150,
  autoTuneMs: 60,
  fps1: 3, // floor
  fpsEachOf12: 3, // floor
};

test('benchmark: render cost, autoTune, sustained fps, concurrency', async ({ page }, testInfo) => {
  await page.goto('/test/bench.html');
  await page.waitForFunction(() => window.benchReady === true);

  const r = await page.evaluate(async (src) => {
    const mod = await import('./bench-core.js');
    const results = await mod.runBenchmark({
      src,
      stage: document.getElementById('stage'),
    });
    return { ...results, device: mod.deviceInfo(), rows: mod.resultRows(results) };
  }, SRC);

  const engine = testInfo.project.name === 'bench' ? '' : testInfo.project.name.replace('bench', '');
  const outFile = `bench-results${engine}${SRC ? '-footage' : ''}.json`;
  const { rows, ...results } = r;
  results.timestamp = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');

  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  const md = `### chroma-key-video benchmark (${testInfo.project.name})\n\n| Measurement | Result |\n|---|---|\n${table}\n`;
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  // Regression gates: generous ceilings that only trip on real regressions.
  expect(r.backend).toBe('webgl');
  expect(r.cpuBackend).toBe('canvas2d');
  expect(r.backgroundAlpha, 'bench output must actually be keyed').toBeLessThanOrEqual(2);
  expect(r.webglKeyMs).toBeLessThan(CEILINGS.webglKeyMs);
  expect(r.webglDissolveMs).toBeLessThan(CEILINGS.webglDissolveMs);
  expect(r.cpuKeyMs).toBeLessThan(CEILINGS.cpuKeyMs);
  expect(r.autoTuneMs).toBeLessThan(CEILINGS.autoTuneMs);
  expect(r.fps1).toBeGreaterThan(CEILINGS.fps1);
  expect(r.fpsEachOf12Min).toBeGreaterThan(CEILINGS.fpsEachOf12);
});
