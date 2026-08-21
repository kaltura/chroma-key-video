// Performance benchmark for chroma-key-video. Runs in the same harness as the
// e2e suite (headless Chromium, SwiftShader) so results are comparable across
// commits on the same machine/CI runner.
//
// Measures, on a synthetic 1280x720 green-screen source (no network needed)
// — or on a real clip when BENCH_SRC is set to a server-relative video URL
// (npm run bench:footage benches the wind-blown-hair stress clip; results
// land in bench-results-footage.json, keeping the synthetic baseline file):
//   - per-frame render cost: WebGL key pass, WebGL + edgeDissolve, Canvas2D CPU
//   - autoTune() cost per run
//   - sustained fps for 1 x 720p player and 12 concurrent players
//   - main-thread long frames (>20ms rAF gaps) while all 12 render
//
// Timings measure CPU-side submission plus a forced flush (getImageData on the
// display canvas), which is the real cost this library adds to a page.
// Assertions are loose sanity ceilings sized for SwiftShader — they catch
// order-of-magnitude regressions, not run-to-run noise. Absolute numbers live
// in bench-results.json (and the GitHub Actions job summary when available).

import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const SRC = process.env.BENCH_SRC || null;

const CEILINGS = {
  webglKeyMs: 50,
  webglDissolveMs: 80,
  cpuKeyMs: 150,
  autoTuneMs: 60,
  fps1: 10, // floor
  fpsEachOf12: 5, // floor
};

test('benchmark: render cost, autoTune, sustained fps, concurrency', async ({ page }) => {
  await page.goto('/test/fixture.html');
  await page.waitForFunction(() => window.fixtureReady === true);

  const r = await page.evaluate(async (src) => {
    const results = {};
    results.source = src || 'synthetic 1280x720 captureStream';

    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    results.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unavailable';

    // ── 1280x720 animated green-screen pattern via captureStream ──────────
    const W = 1280, H = 720;
    function makeBigPattern() {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      let t = 0;
      const draw = () => {
        t += 0.05;
        ctx.fillStyle = 'rgb(40,200,40)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgb(200,40,40)';
        ctx.fillRect(W / 2 + Math.sin(t) * 200 - 100, 100, 200, H - 200);
        ctx.fillStyle = 'rgb(171,180,158)';
        ctx.fillRect(100, 300, 200, 120);
        ctx.fillStyle = 'rgb(235,250,232)';
        ctx.fillRect(900, 300, 200, 120);
      };
      draw();
      const stream = c.captureStream(30);
      const timer = setInterval(draw, 33);
      return { stream, timer };
    }

    function makePlayer(opts = {}, css = { w: W, h: H }) {
      return new Promise((resolve, reject) => {
        let timer = 0;
        let source = src;
        if (!source) ({ stream: source, timer } = makeBigPattern());
        const player = new window.CKV.ChromaKeyVideo(source, {
          maxPixelRatio: 1,
          videoAttributes: { ...window.CKV.DEFAULTS.videoAttributes, autoplay: true, loop: true },
          ...opts,
        });
        player.canvas.style.width = css.w + 'px';
        player.canvas.style.height = css.h + 'px';
        player.mount(document.getElementById('stage'));
        const timeout = setTimeout(() => reject(new Error('bench player never started')), 15000);
        player.addEventListener('started', () => {
          setTimeout(() => { clearTimeout(timeout); resolve({ player, timer }); }, 200);
        }, { once: true });
        player.addEventListener('error', (e) => reject(e.detail));
        player.play().catch(() => {});
      });
    }

    async function timeRenderFrame(player, iters) {
      player.pause();
      await new Promise((res) => setTimeout(res, 100));
      for (let i = 0; i < 5; i++) player.renderFrame();
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) player.renderFrame();
      player.canvas.getContext('2d').getImageData(0, 0, 1, 1); // force flush
      return (performance.now() - t0) / iters;
    }

    // ── WebGL path ─────────────────────────────────────────────────────────
    const big = await makePlayer();
    results.backend = big.player.backend;
    results.outputSize = `${big.player.canvas.width}x${big.player.canvas.height}`;
    results.webglKeyMs = +(await timeRenderFrame(big.player, 120)).toFixed(3);

    big.player.update({ edgeDissolve: true });
    results.webglDissolveMs = +(await timeRenderFrame(big.player, 120)).toFixed(3);
    big.player.update({ edgeDissolve: false });

    // ── autoTune cost ──────────────────────────────────────────────────────
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) big.player.autoTune({ apply: false });
    results.autoTuneMs = +((performance.now() - t0) / 20).toFixed(3);

    // Keying sanity: the bench is meaningless if the output isn't keyed.
    big.player.renderFrame();
    const bgPx = big.player.canvas.getContext('2d').getImageData(30, 30, 1, 1).data;
    results.backgroundAlpha = bgPx[3];

    // ── Sustained fps, 1 x 720p player ─────────────────────────────────────
    big.player.play();
    await new Promise((res) => setTimeout(res, 300));
    const f0 = big.player.frameCount;
    const s0 = performance.now();
    await new Promise((res) => setTimeout(res, 2000));
    results.fps1 = +(((big.player.frameCount - f0) / (performance.now() - s0)) * 1000).toFixed(1);
    big.player.destroy();
    clearInterval(big.timer);

    // ── 12 concurrent players ──────────────────────────────────────────────
    // Synthetic run: fixture-scale 320x240 pattern streams (the baseline).
    // BENCH_SRC run: 12 independent decodes of the real clip — a heavier,
    // more realistic load (decode cost is part of what a page pays).
    const fleet = [];
    for (let i = 0; i < 12; i++) {
      if (src) {
        fleet.push(await makePlayer({}, { w: 160, h: 120 }));
      } else {
        const id = await window.createPlayer({}, { cssWidth: 160, cssHeight: 120 });
        fleet.push(window.players[id]);
        fleet[i].fixtureId = id;
      }
    }
    await new Promise((res) => setTimeout(res, 500));
    const before = fleet.map((f) => f.player.frameCount);
    const c0 = performance.now();
    await new Promise((res) => setTimeout(res, 2000));
    const elapsed = performance.now() - c0;
    const fpsAll = fleet.map((f, i) =>
      +(((f.player.frameCount - before[i]) / elapsed) * 1000).toFixed(1));
    results.fpsEachOf12Min = Math.min(...fpsAll);
    results.fpsEachOf12Max = Math.max(...fpsAll);

    // Main-thread jank while all 12 render.
    let longFrames = 0, frames = 0, worst = 0, prev = performance.now();
    await new Promise((done) => {
      function tick(now) {
        const dt = now - prev; prev = now; frames++;
        if (dt > 20) longFrames++;
        if (dt > worst) worst = dt;
        if (frames < 120) requestAnimationFrame(tick); else done();
      }
      requestAnimationFrame(tick);
    });
    results.longFramesOf120 = longFrames;
    results.worstFrameMs = +worst.toFixed(1);

    fleet.forEach((f) => {
      if (f.fixtureId) window.destroyPlayer(f.fixtureId);
      else { f.player.destroy(); clearInterval(f.timer); }
    });
    return results;
  }, SRC);

  const rows = [
    ['Source', r.source],
    ['GPU renderer', r.renderer],
    ['Output buffer', r.outputSize],
    ['WebGL key pass', `${r.webglKeyMs} ms/frame`],
    ['WebGL + edgeDissolve', `${r.webglDissolveMs} ms/frame`],
    ['autoTune()', `${r.autoTuneMs} ms/run`],
    ['Sustained fps, 1 x 720p', `${r.fps1} fps`],
    ['Sustained fps, 12 players', `${r.fpsEachOf12Min}-${r.fpsEachOf12Max} fps each`],
    ['Main-thread frames > 20ms', `${r.longFramesOf120}/120 (worst ${r.worstFrameMs} ms)`],
  ];

  // ── Canvas2D CPU path (separate evaluate keeps the GL run uncontended) ──
  const cpu = await page.evaluate(async (src) => {
    const W = 1280, H = 720;
    let source = src, timer = 0;
    if (!source) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(40,200,40)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgb(200,40,40)'; ctx.fillRect(540, 100, 200, 520);
      source = c.captureStream(30);
      timer = setInterval(() => ctx.fillRect(540, 100, 200, 520), 50);
    }

    const player = await new Promise((resolve, reject) => {
      const p = new window.CKV.ChromaKeyVideo(source, {
        forceCanvas2D: true,
        maxPixelRatio: 1,
        videoAttributes: { ...window.CKV.DEFAULTS.videoAttributes, autoplay: true, loop: true },
      });
      p.canvas.style.width = W + 'px';
      p.canvas.style.height = H + 'px';
      p.mount(document.getElementById('stage'));
      const t = setTimeout(() => reject(new Error('cpu bench player never started')), 15000);
      p.addEventListener('started', () => setTimeout(() => { clearTimeout(t); resolve(p); }, 200), { once: true });
      p.addEventListener('error', (e) => reject(e.detail));
      p.play().catch(() => {});
    });

    player.pause();
    await new Promise((res) => setTimeout(res, 100));
    for (let i = 0; i < 3; i++) player.renderFrame();
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) player.renderFrame();
    const ms = (performance.now() - t0) / 30;
    const bufferSize = `${player.canvas.width}x${player.canvas.height}`;
    const backend = player.backend;
    player.destroy();
    clearInterval(timer);
    return { cpuKeyMs: +ms.toFixed(2), backend, bufferSize };
  }, SRC);

  rows.splice(5, 0, ['Canvas2D CPU fallback', `${cpu.cpuKeyMs} ms/frame`]);
  const results = { ...r, ...cpu, timestamp: new Date().toISOString() };
  const outFile = SRC ? 'bench-results-footage.json' : 'bench-results.json';
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');

  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  const md = `### chroma-key-video benchmark\n\n| Measurement | Result |\n|---|---|\n${table}\n`;
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  // Regression gates: generous ceilings that only trip on real regressions.
  expect(r.backend).toBe('webgl');
  expect(cpu.backend).toBe('canvas2d');
  expect(r.backgroundAlpha, 'bench output must actually be keyed').toBeLessThanOrEqual(2);
  expect(r.webglKeyMs).toBeLessThan(CEILINGS.webglKeyMs);
  expect(r.webglDissolveMs).toBeLessThan(CEILINGS.webglDissolveMs);
  expect(cpu.cpuKeyMs).toBeLessThan(CEILINGS.cpuKeyMs);
  expect(r.autoTuneMs).toBeLessThan(CEILINGS.autoTuneMs);
  expect(r.fps1).toBeGreaterThan(CEILINGS.fps1);
  expect(r.fpsEachOf12Min).toBeGreaterThan(CEILINGS.fpsEachOf12);
});
