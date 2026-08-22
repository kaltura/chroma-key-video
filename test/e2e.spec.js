// End-to-end suite for chroma-key-video. Renders synthetic green/blue-screen
// test patterns (canvas.captureStream) through the library in a real browser
// and samples the output canvas pixel-by-pixel.
//
// Pattern map (see fixture.html drawPattern):
//   background        key color            -> expect alpha 0
//   x 120-200 stripe  rgb(200,40,40)       -> expect opaque red, full height
//   top-left  0-40    rgb(200,40,40)       -> y-flip canary (red stays top-left)
//   btm-right 40sq    rgb(40,40,200)       -> y-flip canary (blue stays bottom-right)
//   ramp patch        rgb(171,180,158)     -> keyedAmount ~0.53 -> alpha ~120
//   spill patch       rgb(235,250,232)     -> not keyed (sat .072), green reduced by dom*spill

import { test, expect } from '@playwright/test';

const SAMPLES = {
  background: [0.06, 0.6],
  stripe: [0.5, 0.5],
  topLeftMarker: [0.06, 0.06],
  bottomRightMarker: [0.94, 0.94],
  ramp: [0.22, 0.5],
  spill: [0.78, 0.5],
};

async function openFixture(page) {
  await page.goto('/test/fixture.html');
  await page.waitForFunction(() => window.fixtureReady === true);
}

function create(page, options = {}, pattern = {}) {
  return page.evaluate(
    ([o, p]) => window.createPlayer(o, p),
    [options, pattern],
  );
}

function sample(page, id, point) {
  return page.evaluate(
    ([pid, [x, y]]) => window.sample(pid, x, y),
    [id, point],
  );
}

function backend(page, id) {
  return page.evaluate((pid) => window.players[pid].player.backend, id);
}

// Resolves with the detail of the next `type` event on player `id`, or
// rejects if it doesn't fire within `timeoutMs`.
function waitForEvent(page, id, type, timeoutMs = 5000) {
  return page.evaluate(([pid, t, ms]) => new Promise((resolve, reject) => {
    const { player } = window.players[pid];
    const timer = setTimeout(() => reject(new Error(`"${t}" never fired`)), ms);
    player.addEventListener(t, (e) => { clearTimeout(timer); resolve(e.detail); }, { once: true });
  }), [id, type, timeoutMs]);
}

// Resolves with whether `type` fired on player `id` within `waitMs`.
function didFire(page, id, type, waitMs) {
  return page.evaluate(([pid, t, ms]) => new Promise((resolve) => {
    const { player } = window.players[pid];
    let seen = false;
    player.addEventListener(t, () => { seen = true; }, { once: true });
    setTimeout(() => resolve(seen), ms);
  }), [id, type, waitMs]);
}

test.describe('chroma-key-video', () => {
  test.beforeEach(async ({ page }) => {
    await openFixture(page);
  });

  test('WebGL backend keys green to transparent and keeps foreground', async ({ page }) => {
    const id = await create(page);
    expect(await backend(page, id)).toBe('webgl');

    const bg = await sample(page, id, SAMPLES.background);
    expect(bg[3]).toBeLessThanOrEqual(2);

    const fg = await sample(page, id, SAMPLES.stripe);
    expect(fg[3]).toBe(255);
    expect(fg[0]).toBeGreaterThan(180);
    expect(fg[1]).toBeLessThan(70);
    expect(fg[2]).toBeLessThan(70);
  });

  test('output orientation is upright (corner markers stay in their corners)', async ({ page }) => {
    const id = await create(page);

    const tl = await sample(page, id, SAMPLES.topLeftMarker);
    expect(tl[0]).toBeGreaterThan(180); // red marker top-left
    expect(tl[2]).toBeLessThan(70);

    const br = await sample(page, id, SAMPLES.bottomRightMarker);
    expect(br[2]).toBeGreaterThan(180); // blue marker bottom-right
    expect(br[0]).toBeLessThan(70);
  });

  test('near-key pixels get a continuous partial-alpha ramp', async ({ page }) => {
    const id = await create(page);
    // rgb(171,180,158): keyedAmount ~= (9-2)/15.4 + (0.1222-0.08)*1.8 ~= 0.53 -> alpha ~120
    const ramp = await sample(page, id, SAMPLES.ramp);
    expect(ramp[3]).toBeGreaterThan(60);
    expect(ramp[3]).toBeLessThan(180);
  });

  test('spill suppression reduces green on non-keyed near-key pixels', async ({ page }) => {
    // rgb(235,250,232): fails the key gate (sat 0.072), dom 15 -> spill branch.
    const noSpill = await create(page, { spill: 0 });
    const fullSpill = await create(page, { spill: 1.0 });

    const a = await sample(page, noSpill, SAMPLES.spill);
    const b = await sample(page, fullSpill, SAMPLES.spill);

    expect(a[3]).toBe(255);
    expect(b[3]).toBe(255);
    // spill=1.0 subtracts dom (~15) from green; allow codec/precision slack.
    expect(a[1] - b[1]).toBeGreaterThan(8);
    // Red and blue stay untouched.
    expect(Math.abs(a[0] - b[0])).toBeLessThanOrEqual(4);
    expect(Math.abs(a[2] - b[2])).toBeLessThanOrEqual(4);
  });

  test('update() changes keying parameters live', async ({ page }) => {
    const id = await create(page, { spill: 1.0 });
    const before = await sample(page, id, SAMPLES.spill);

    await page.evaluate((pid) => window.players[pid].player.update({ spill: 0 }), id);
    await page.waitForTimeout(150); // a few frames at the new setting
    const after = await sample(page, id, SAMPLES.spill);

    expect(after[1] - before[1]).toBeGreaterThan(8);
  });

  test('Canvas2D fallback produces the same output as WebGL', async ({ page }) => {
    const gl = await create(page);
    const cpu = await create(page, { forceCanvas2D: true });
    expect(await backend(page, cpu)).toBe('canvas2d');

    for (const [name, point] of Object.entries(SAMPLES)) {
      const a = await sample(page, gl, point);
      const b = await sample(page, cpu, point);
      for (let c = 0; c < 4; c++) {
        expect(Math.abs(a[c] - b[c]), `${name} channel ${c}: webgl=${a} canvas2d=${b}`)
          .toBeLessThanOrEqual(8);
      }
    }
  });

  test('12 concurrent instances all render on the shared WebGL context', async ({ page }) => {
    const ids = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await create(page, {}, { cssWidth: 160, cssHeight: 120 }));
    }
    for (const id of ids) {
      expect(await backend(page, id)).toBe('webgl');
      const bg = await sample(page, id, SAMPLES.background);
      expect(bg[3], `instance ${id} background`).toBeLessThanOrEqual(2);
      const fg = await sample(page, id, SAMPLES.stripe);
      expect(fg[3], `instance ${id} foreground`).toBe(255);
      expect(fg[0], `instance ${id} foreground red`).toBeGreaterThan(180);
    }
  });

  test('edgeDissolve fades the top and bottom of the frame', async ({ page }) => {
    const id = await create(page, { edgeDissolve: true, fadeTop: 0.05, fadeBottom: 0.18 });

    const center = await sample(page, id, [0.5, 0.5]);
    const top = await sample(page, id, [0.5, 0.015]);
    const bottom = await sample(page, id, [0.5, 0.97]);

    expect(center[3]).toBeGreaterThan(240);
    expect(top[3]).toBeLessThan(center[3] * 0.6);
    expect(bottom[3]).toBeLessThan(center[3] * 0.6);
  });

  test('destroy() stops rendering and releases the instance', async ({ page }) => {
    const id = await create(page);

    const stopped = await page.evaluate(async (pid) => {
      const { player } = window.players[pid];
      player.destroy();
      const countAtDestroy = player.frameCount;
      await new Promise((r) => setTimeout(r, 300));
      return {
        isDestroyed: player.isDestroyed,
        framesAfterDestroy: player.frameCount - countAtDestroy,
        canvasDetached: !player.canvas.isConnected,
      };
    }, id);

    expect(stopped.isDestroyed).toBe(true);
    expect(stopped.framesAfterDestroy).toBe(0);
    expect(stopped.canvasDetached).toBe(true);

    // A fresh instance still works after the engine may have been released.
    const id2 = await create(page);
    const fg = await sample(page, id2, SAMPLES.stripe);
    expect(fg[3]).toBe(255);
  });

  test('blue-screen keying via channel: "blue"', async ({ page }) => {
    const id = await create(page, { channel: 'blue' }, { channel: 'blue' });

    const bg = await sample(page, id, SAMPLES.background);
    expect(bg[3]).toBeLessThanOrEqual(2);

    const fg = await sample(page, id, SAMPLES.stripe);
    expect(fg[3]).toBe(255);
    expect(fg[0]).toBeGreaterThan(180);
  });

  test('URL source: encoded video keys correctly', async ({ page }) => {
    const id = await page.evaluate(async () => {
      const url = await window.makePatternVideoURL();
      return window.createPlayerFromURL(url);
    });

    // VP8 encoding shifts colors; assert only the key outcomes.
    const bg = await sample(page, id, SAMPLES.background);
    expect(bg[3]).toBeLessThanOrEqual(30);

    const fg = await sample(page, id, SAMPLES.stripe);
    expect(fg[3]).toBeGreaterThan(220);
    expect(fg[0]).toBeGreaterThan(150);
  });

  test('custom element renders through a closed shadow root', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.CKV.defineChromaKeyVideoElement();
      const url = await window.makePatternVideoURL();
      const el = document.createElement('chroma-key-video');
      el.setAttribute('src', url);
      el.setAttribute('autoplay', '');
      el.setAttribute('loop', '');
      el.setAttribute('muted', '');
      el.style.width = '320px';
      document.body.appendChild(el);

      const player = el.player;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('element player never started')), 10000);
        player.addEventListener('started', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      await new Promise((r) => setTimeout(r, 300));

      const c = player.canvas;
      const ctx = c.getContext('2d');
      const px = (xf, yf) => Array.from(ctx.getImageData(
        Math.round(xf * (c.width - 1)), Math.round(yf * (c.height - 1)), 1, 1).data);
      return {
        shadowClosed: el.shadowRoot === null,
        bg: px(0.06, 0.6),
        fg: px(0.5, 0.5),
      };
    });

    expect(result.shadowClosed).toBe(true);
    expect(result.bg[3]).toBeLessThanOrEqual(30);
    expect(result.fg[3]).toBeGreaterThan(220);
    expect(result.fg[0]).toBeGreaterThan(150);
  });

  test('plugin API: lifecycle hooks, managed timers, error isolation', async ({ page }) => {
    const id = await create(page);

    const result = await page.evaluate(async (pid) => {
      const { player } = window.players[pid];
      const calls = { attach: 0, frames: 0, ticks: 0, detach: 0, lastInfo: null };
      const errors = [];
      player.addEventListener('pluginerror', (e) => errors.push(e.detail.plugin));

      player.use({
        name: 'probe',
        attach(ctx) { calls.attach++; ctx.every(50, () => calls.ticks++); },
        frame(ctx, info) { calls.frames++; calls.lastInfo = info; },
        detach() { calls.detach++; },
      });
      // A plugin whose frame hook throws must be detached without affecting
      // the player or the probe plugin.
      player.use({ name: 'bomb', frame() { throw new Error('boom'); } });

      await new Promise((r) => setTimeout(r, 400));
      const framesWithBoth = calls.frames;
      const ticksSoFar = calls.ticks;

      const unusedProbe = player.unuse('probe');
      const unusedBomb = player.unuse('bomb'); // already auto-removed
      await new Promise((r) => setTimeout(r, 200));

      return {
        ...calls,
        framesWithBoth,
        ticksSoFar,
        framesAfterDetach: calls.frames - framesWithBoth,
        ticksAfterDetach: calls.ticks - ticksSoFar,
        unusedProbe,
        unusedBomb,
        errors,
        playerFrames: player.frameCount,
      };
    }, id);

    expect(result.attach).toBe(1);
    expect(result.detach).toBe(1);
    expect(result.framesWithBoth).toBeGreaterThan(3);
    expect(result.ticksSoFar).toBeGreaterThan(2);
    expect(result.framesAfterDetach).toBe(0);
    expect(result.ticksAfterDetach).toBe(0);
    expect(result.unusedProbe).toBe(true);
    expect(result.unusedBomb).toBe(false);
    expect(result.errors).toEqual(['bomb']);
    expect(result.playerFrames).toBeGreaterThan(10); // bomb never broke the loop
    expect(result.lastInfo.backend).toBe('webgl');
    expect(result.lastInfo.width).toBeGreaterThan(0);
  });

  test('autoTune() derives keying params from the footage', async ({ page }) => {
    // minKey 240 defeats keying: the background renders opaque.
    const id = await create(page, { minKey: 240 });
    const before = await sample(page, id, SAMPLES.background);
    expect(before[3]).toBe(255);

    const result = await page.evaluate((pid) => window.players[pid].player.autoTune(), id);
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.backgroundFraction).toBeGreaterThan(0.3);
    expect(result.params.minKey).toBeGreaterThanOrEqual(16);
    expect(result.params.minKey).toBeLessThan(150);

    await page.waitForTimeout(150);
    const bg = await sample(page, id, SAMPLES.background);
    expect(bg[3]).toBeLessThanOrEqual(2);
    const fg = await sample(page, id, SAMPLES.stripe);
    expect(fg[3]).toBe(255);
  });

  test('autoTune option tunes on the first frame; adaptive re-tunes and converges', async ({ page }) => {
    // autoTune: true overrides the hopeless manual minKey automatically.
    const once = await create(page, { minKey: 240, autoTune: true });
    const bg = await sample(page, once, SAMPLES.background);
    expect(bg[3]).toBeLessThanOrEqual(2);
    const fg = await sample(page, once, SAMPLES.stripe);
    expect(fg[3]).toBe(255);
    const tunedMinKey = await page.evaluate(
      (pid) => window.players[pid].player.options.minKey, once);
    expect(tunedMinKey).toBeLessThan(150);

    // Adaptive: repeated runs on a static pattern converge to applied: false.
    const adaptive = await create(page, { minKey: 240 });
    const events = await page.evaluate(async (pid) => {
      const { player } = window.players[pid];
      const seen = [];
      player.addEventListener('autotune', (e) => seen.push(e.detail));
      player.use(window.CKV.autoTunePlugin({ adaptive: true, interval: 150 }));
      await new Promise((r) => setTimeout(r, 650));
      player.unuse('autoTune');
      return seen;
    }, adaptive);

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.ok)).toBe(true);
    expect(events[0].applied).toBe(true);
    expect(events[events.length - 1].applied).toBe(false);
    const bg2 = await sample(page, adaptive, SAMPLES.background);
    expect(bg2[3]).toBeLessThanOrEqual(2);
  });

  test('canvas aspect-ratio updates when the video\'s native resolution changes (issue #2)', async ({ page }) => {
    const id = await create(page, {}, { srcWidth: 320, srcHeight: 240 });
    const initial = await page.evaluate(
      (pid) => window.players[pid].player.canvas.style.aspectRatio, id);
    expect(initial).toBe('320 / 240');

    await page.evaluate((pid) => window.resizeSource(pid, 640, 480), id);
    await page.waitForFunction(
      (pid) => window.players[pid].player.canvas.style.aspectRatio === '640 / 480',
      id, { timeout: 5000 },
    );
  });

  test('a user-set aspect-ratio is never clobbered by a later resolution change (issue #2)', async ({ page }) => {
    const id = await create(page, {}, { srcWidth: 320, srcHeight: 240 });
    await page.evaluate((pid) => {
      window.players[pid].player.canvas.style.aspectRatio = '1 / 1';
    }, id);

    await page.evaluate((pid) => window.resizeSource(pid, 640, 480), id);
    // Give the native 'resize' event a few frames to have fired, then assert
    // the user's explicit override survived it untouched.
    await page.waitForTimeout(500);
    const aspect = await page.evaluate(
      (pid) => window.players[pid].player.canvas.style.aspectRatio, id);
    expect(aspect).toBe('1 / 1');
  });

  test('two concurrent instances at different native resolutions track aspect independently (issue #2)', async ({ page }) => {
    const a = await create(page, {}, { srcWidth: 320, srcHeight: 240 });
    const b = await create(page, {}, { srcWidth: 480, srcHeight: 270 });

    expect(await page.evaluate((pid) => window.players[pid].player.canvas.style.aspectRatio, a))
      .toBe('320 / 240');
    expect(await page.evaluate((pid) => window.players[pid].player.canvas.style.aspectRatio, b))
      .toBe('480 / 270');

    await page.evaluate((pid) => window.resizeSource(pid, 640, 480), a);
    await page.waitForFunction(
      (pid) => window.players[pid].player.canvas.style.aspectRatio === '640 / 480',
      a, { timeout: 5000 },
    );

    // Instance b must be untouched by a's resize — no shared/module-level state.
    expect(await page.evaluate((pid) => window.players[pid].player.canvas.style.aspectRatio, b))
      .toBe('480 / 270');
  });

  test('custom element: a pre-set host aspect-ratio is never clobbered (issue #2)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.CKV.defineChromaKeyVideoElement();
      const url = await window.makePatternVideoURL();
      const el = document.createElement('chroma-key-video');
      el.setAttribute('src', url);
      el.setAttribute('autoplay', '');
      el.setAttribute('loop', '');
      el.setAttribute('muted', '');
      el.style.width = '320px';
      el.style.aspectRatio = '1 / 1'; // set before connecting
      document.body.appendChild(el);

      const player = el.player;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('element player never started')), 10000);
        player.addEventListener('started', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      await new Promise((r) => setTimeout(r, 300));
      return el.style.aspectRatio;
    });

    expect(result).toBe('1 / 1');
  });

  test('custom element: auto-tune attribute overrides bad manual params', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.CKV.defineChromaKeyVideoElement();
      const url = await window.makePatternVideoURL();
      const el = document.createElement('chroma-key-video');
      el.setAttribute('src', url);
      el.setAttribute('autoplay', '');
      el.setAttribute('loop', '');
      el.setAttribute('muted', '');
      el.setAttribute('min-key', '240');
      el.setAttribute('auto-tune', '');
      el.style.width = '320px';
      document.body.appendChild(el);

      const player = el.player;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('element player never started')), 10000);
        player.addEventListener('started', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      await new Promise((r) => setTimeout(r, 300));

      const c = player.canvas;
      const ctx = c.getContext('2d');
      const px = (xf, yf) => Array.from(ctx.getImageData(
        Math.round(xf * (c.width - 1)), Math.round(yf * (c.height - 1)), 1, 1).data);
      return { minKey: player.options.minKey, bg: px(0.06, 0.6), fg: px(0.5, 0.5) };
    });

    expect(result.minKey).toBeLessThan(150);
    expect(result.bg[3]).toBeLessThanOrEqual(30);
    expect(result.fg[3]).toBeGreaterThan(220);
  });

  test('fires "stalled" when frame delivery stops, then "recovered" once it resumes (issue #3)', async ({ page }) => {
    const id = await create(page, { stallTimeout: 700 }, { fps: 0 });

    const healthBefore = await page.evaluate((pid) => {
      const v = window.players[pid].player.video;
      return { paused: v.paused, ended: v.ended };
    }, id);
    expect(healthBefore.paused).toBe(false);
    expect(healthBefore.ended).toBe(false);

    const stalledPromise = waitForEvent(page, id, 'stalled', 5000);
    await page.evaluate((pid) => window.stopSource(pid), id);
    const stalledDetail = await stalledPromise;
    expect(stalledDetail.elapsedMs).toBeGreaterThanOrEqual(700);

    // readyState/paused/ended still look healthy — that's the whole point:
    // the video element gives no other signal that frames stopped arriving.
    const healthDuringStall = await page.evaluate((pid) => {
      const v = window.players[pid].player.video;
      return { paused: v.paused, ended: v.ended };
    }, id);
    expect(healthDuringStall.paused).toBe(false);
    expect(healthDuringStall.ended).toBe(false);

    const recoveredPromise = waitForEvent(page, id, 'recovered', 5000);
    await page.evaluate((pid) => window.resumeSource(pid), id);
    await recoveredPromise;
  });

  test('does not fire "stalled" during uninterrupted playback (issue #3)', async ({ page }) => {
    const id = await create(page, { stallTimeout: 300 }, { fps: 0 });
    expect(await didFire(page, id, 'stalled', 1500)).toBe(false);
  });

  test('does not fire "stalled" while intentionally paused (issue #3)', async ({ page }) => {
    const id = await create(page, { stallTimeout: 300 }, { fps: 0 });
    await page.evaluate((pid) => {
      window.players[pid].player.pause();
      window.stopSource(pid);
    }, id);
    expect(await didFire(page, id, 'stalled', 1500)).toBe(false);
  });

  test('stallTimeout <= 0 disables stall detection (issue #3)', async ({ page }) => {
    const id = await create(page, { stallTimeout: 0 }, { fps: 0 });
    await page.evaluate((pid) => window.stopSource(pid), id);
    expect(await didFire(page, id, 'stalled', 1500)).toBe(false);
  });

  test('stalling one instance does not affect another (issue #3)', async ({ page }) => {
    const a = await create(page, { stallTimeout: 700 }, { fps: 0 });
    const b = await create(page, { stallTimeout: 700 }, { fps: 0 });

    const stalledA = waitForEvent(page, a, 'stalled', 5000);
    await page.evaluate((pid) => window.stopSource(pid), a);
    await stalledA;

    expect(await didFire(page, b, 'stalled', 500)).toBe(false);
  });
});
