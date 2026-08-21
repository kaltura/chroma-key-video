// Real-footage quality tests.
//
// The synthetic e2e patterns validate the keying math pixel-exactly; these
// clips validate it against reality: presenters over a flat green screen
// (720p h264, 4 s each, committed under test/assets/ so CI runs offline).
// Real footage carries codec noise, uneven lighting, hair detail, and soft
// shadows, so assertions here are statistical — population fractions and
// sampled regions — not exact pixel values.
//
// greenscreen-hair.mp4 (Pixabay, Content License) is the stress case:
// long wind-blown hair with loose flying strands and green bounce light
// on the skin — the classic hard keying scenario.
//
// Each clip runs through both backends: seek to a fixed frame, auto-tune,
// render once, then analyze the full output canvas.

import { test, expect } from '@playwright/test';

const CLIPS = ['greenscreen-talk.mp4', 'greenscreen-calm.mp4', 'greenscreen-hair.mp4'];
const SEEK_TIME = 2.0;

// Fractional sample points chosen from the footage: in all three clips the
// presenter sits center-frame (head around y 0.2-0.5, torso filling
// bottom-center); the margins and corners are pure green screen in every
// frame, verified per-clip at the seek frame.
const BACKGROUND_POINTS = [
  [0.03, 0.05], [0.97, 0.05],   // top corners
  [0.03, 0.50], [0.97, 0.50],   // mid-height margins
  [0.06, 0.95], [0.94, 0.95],   // bottom corners
];
const SUBJECT_POINTS = [
  [0.50, 0.30],                 // face
  [0.50, 0.85],                 // sweater
];

async function openFixture(page) {
  await page.goto('/test/fixture.html');
  await page.waitForFunction(() => window.fixtureReady === true);
}

// Create a player for the clip, seek to a fixed time (deterministic frame),
// auto-tune, render, and return whole-frame + sampled metrics.
async function analyzeClip(page, clip, options) {
  return page.evaluate(async ({ clip, options, seekTime, bgPoints, fgPoints }) => {
    const id = await window.createPlayerFromURL('/test/assets/' + clip, options);
    const { player } = window.players[id];
    player.pause();
    await new Promise((res) => {
      player.video.addEventListener('seeked', res, { once: true });
      player.video.currentTime = seekTime;
    });
    const tune = player.autoTune();
    player.renderFrame();
    await new Promise((res) => setTimeout(res, 100));

    const c = player.canvas;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const total = data.length / 4;
    let transparent = 0, opaque = 0, visible = 0, greenCast = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 8) transparent++;
      if (a > 247) opaque++;
      if (a > 32) {
        visible++;
        const dom = data[i + 1] - Math.max(data[i], data[i + 2]);
        if (dom > 15) greenCast++;
      }
    }
    const at = (fx, fy) => {
      const x = Math.min(c.width - 1, Math.round(fx * c.width));
      const y = Math.min(c.height - 1, Math.round(fy * c.height));
      const o = (y * c.width + x) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    };
    const result = {
      backend: player.backend,
      tune,
      transparentFraction: transparent / total,
      opaqueFraction: opaque / total,
      greenCastFraction: visible ? greenCast / visible : 0,
      background: bgPoints.map(([x, y]) => at(x, y)),
      subject: fgPoints.map(([x, y]) => at(x, y)),
    };
    window.destroyPlayer(id);
    return result;
  }, { clip, options, seekTime: SEEK_TIME, bgPoints: BACKGROUND_POINTS, fgPoints: SUBJECT_POINTS });
}

function assertQuality(m, backendName) {
  expect(m.backend).toBe(backendName);

  // Auto-tune found the screen and derived sane parameters.
  expect(m.tune.ok).toBe(true);
  expect(m.tune.applied).toBe(true);
  expect(m.tune.backgroundFraction).toBeGreaterThan(0.2);
  expect(m.tune.params.minKey).toBeGreaterThanOrEqual(16);
  expect(m.tune.params.minKey).toBeLessThan(150);
  expect(m.tune.params.bias).toBeGreaterThanOrEqual(0.8);
  expect(m.tune.params.bias).toBeLessThanOrEqual(0.98);
  expect(m.tune.params.softness).toBeGreaterThanOrEqual(24);
  expect(m.tune.params.softness).toBeLessThanOrEqual(110);

  // The screen keys out and the presenter stays solid.
  expect(m.transparentFraction).toBeGreaterThan(0.45);
  expect(m.opaqueFraction).toBeGreaterThan(0.15);
  for (const [, , , a] of m.background) expect(a).toBeLessThanOrEqual(8);
  for (const [, , , a] of m.subject) expect(a).toBeGreaterThanOrEqual(250);

  // Spill suppression: almost no visible pixel keeps a strong green cast
  // (measured ~0.04% on this footage; threshold leaves ~10x margin).
  expect(m.greenCastFraction).toBeLessThan(0.005);
}

for (const clip of CLIPS) {
  test(`real footage ${clip} — WebGL keys clean after auto-tune`, async ({ page }) => {
    await openFixture(page);
    assertQuality(await analyzeClip(page, clip, {}), 'webgl');
  });

  test(`real footage ${clip} — Canvas2D keys clean after auto-tune`, async ({ page }) => {
    await openFixture(page);
    assertQuality(await analyzeClip(page, clip, { forceCanvas2D: true }), 'canvas2d');
  });
}
