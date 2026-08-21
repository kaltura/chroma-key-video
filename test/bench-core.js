// Shared benchmark measurement suite. Runs in any browser — driven by the
// Playwright bench spec (test/bench.spec.js) in CI and by the self-service
// bench page (test/bench.html) on real devices. Keep this module free of
// Node/Playwright APIs: everything here executes in the page.
//
// All players run with maxPixelRatio: 1, so the render buffer is the source
// size (1280x720) on every device regardless of devicePixelRatio — numbers
// stay comparable across phones, laptops, and CI runners.
//
// Timings measure CPU-side submission plus a forced flush (getImageData on
// the display canvas), which is the real cost this library adds to a page.

import { ChromaKeyVideo, DEFAULTS } from '../src/chromakey.js';

const W = 1280, H = 720;
const FLEET_SIZE = 12;

// ── Sources ────────────────────────────────────────────────────────────────

// 1280x720 animated green-screen pattern via captureStream (offline default).
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

// 320x240 pattern for the concurrent fleet in synthetic mode (matches the
// e2e fixture pattern, so fleet numbers stay comparable across suites).
function makeSmallPattern() {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 240;
  const ctx = c.getContext('2d');
  const draw = () => {
    ctx.fillStyle = 'rgb(40,200,40)';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = 'rgb(200,40,40)';
    ctx.fillRect(120, 0, 80, 240);
  };
  draw();
  const stream = c.captureStream(30);
  const timer = setInterval(draw, 50);
  return { stream, timer };
}

// ── Player + timing helpers ───────────────────────────────────────────────

function makePlayer(stage, src, opts = {}, css = { w: W, h: H }) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    let source = src;
    if (!source) {
      const pattern = css.w < W ? makeSmallPattern() : makeBigPattern();
      source = pattern.stream;
      timer = pattern.timer;
    }
    const player = new ChromaKeyVideo(source, {
      maxPixelRatio: 1,
      videoAttributes: { ...DEFAULTS.videoAttributes, autoplay: true, loop: true },
      ...opts,
    });
    // 'important' so page stylesheets can't shrink the layout box — the
    // render buffer is sized from it, and comparable numbers need 1280x720.
    player.canvas.style.setProperty('width', css.w + 'px', 'important');
    player.canvas.style.setProperty('height', css.h + 'px', 'important');
    player.canvas.style.setProperty('flex', 'none', 'important');
    player.mount(stage);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error('bench player never started'));
    }, 15000);
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

// ── Device metadata (attached to every result) ────────────────────────────

export function deviceInfo() {
  const nav = navigator;
  const uad = nav.userAgentData;
  return {
    userAgent: nav.userAgent,
    platform: (uad && uad.platform) || nav.platform || '',
    hardwareConcurrency: nav.hardwareConcurrency || null,
    deviceMemory: nav.deviceMemory || null,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
  };
}

// ── The benchmark ──────────────────────────────────────────────────────────
//
// src: server-relative video URL, or null for the synthetic pattern.
// stage: element the players mount into (they render visibly while measured).
// onProgress: called with a short status string before each phase.
//
// Returns a flat results object; throws if a player fails to start.
export async function runBenchmark({ src = null, stage = document.body, onProgress = () => {} } = {}) {
  const results = { source: src || 'synthetic 1280x720 captureStream' };

  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  results.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl ? 'unavailable (no debug_renderer_info)' : 'no WebGL';

  // ── Primary backend: per-frame cost, autoTune, keying sanity ───────────
  onProgress('Starting 720p player…');
  const big = await makePlayer(stage, src);
  results.backend = big.player.backend;
  results.outputSize = `${big.player.canvas.width}x${big.player.canvas.height}`;

  onProgress('Timing key pass…');
  results.webglKeyMs = +(await timeRenderFrame(big.player, 120)).toFixed(3);

  onProgress('Timing key pass + edgeDissolve…');
  big.player.update({ edgeDissolve: true });
  results.webglDissolveMs = +(await timeRenderFrame(big.player, 120)).toFixed(3);
  big.player.update({ edgeDissolve: false });

  onProgress('Timing autoTune…');
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) big.player.autoTune({ apply: false });
  results.autoTuneMs = +((performance.now() - t0) / 20).toFixed(3);

  // Keying sanity: the bench is meaningless if the output isn't keyed.
  big.player.renderFrame();
  const bgPx = big.player.canvas.getContext('2d').getImageData(30, 30, 1, 1).data;
  results.backgroundAlpha = bgPx[3];

  onProgress('Sustained fps, 1 player (2s)…');
  big.player.play();
  await new Promise((res) => setTimeout(res, 300));
  const f0 = big.player.frameCount;
  const s0 = performance.now();
  await new Promise((res) => setTimeout(res, 2000));
  results.fps1 = +(((big.player.frameCount - f0) / (performance.now() - s0)) * 1000).toFixed(1);
  big.player.destroy();
  clearInterval(big.timer);

  // ── 12 concurrent players ────────────────────────────────────────────────
  // Synthetic: 320x240 pattern streams (the CI baseline). Real footage: 12
  // independent decodes of the clip — heavier and more realistic (decode
  // cost is part of what a page pays).
  onProgress(`Starting ${FLEET_SIZE} concurrent players…`);
  const fleet = [];
  for (let i = 0; i < FLEET_SIZE; i++) {
    fleet.push(await makePlayer(stage, src, {}, { w: 160, h: 120 }));
  }
  onProgress(`Sustained fps, ${FLEET_SIZE} players (2s)…`);
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
  onProgress('Measuring main-thread jank…');
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

  fleet.forEach((f) => { f.player.destroy(); clearInterval(f.timer); });

  // ── Canvas2D CPU path (GPU players destroyed, so the run is uncontended) ─
  onProgress('Timing Canvas2D CPU fallback…');
  const cpu = await makePlayer(stage, src, { forceCanvas2D: true });
  results.cpuBackend = cpu.player.backend;
  results.cpuBufferSize = `${cpu.player.canvas.width}x${cpu.player.canvas.height}`;
  results.cpuKeyMs = +(await timeRenderFrame(cpu.player, 30)).toFixed(2);
  cpu.player.destroy();
  clearInterval(cpu.timer);

  onProgress('Done.');
  return results;
}

// Human-readable rows for a results object — shared by the spec's console
// table and the bench page's results table.
export function resultRows(r) {
  return [
    ['Source', r.source],
    ['GPU renderer', r.renderer],
    ['Backend', r.backend],
    ['Output buffer', r.outputSize],
    ['Key pass', `${r.webglKeyMs} ms/frame`],
    ['Key pass + edgeDissolve', `${r.webglDissolveMs} ms/frame`],
    ['Canvas2D CPU fallback', `${r.cpuKeyMs} ms/frame`],
    ['autoTune()', `${r.autoTuneMs} ms/run`],
    ['Sustained fps, 1 x 720p', `${r.fps1} fps`],
    [`Sustained fps, ${FLEET_SIZE} players`, `${r.fpsEachOf12Min}-${r.fpsEachOf12Max} fps each`],
    ['Main-thread frames > 20ms', `${r.longFramesOf120}/120 (worst ${r.worstFrameMs} ms)`],
  ];
}
