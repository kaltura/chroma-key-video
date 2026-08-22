# chroma-key-video

[![CI](https://github.com/kaltura/chroma-key-video/actions/workflows/ci.yml/badge.svg)](https://github.com/kaltura/chroma-key-video/actions/workflows/ci.yml)
[![Bundle size](https://img.shields.io/badge/minified-24KB-blue)](scripts/check-size.mjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Real-time green/blue-screen keying for HTML video, in the browser. Point it at any flat green-screen video — a file URL, a `<video>` element, or a `MediaStream`. Get back a per-pixel transparent canvas. Composite it over anything on the page.

- **Zero dependencies.** One ES module file, no build step. Works with any framework or none.
- **Unlimited concurrent players.** All instances share one WebGL context (browsers cap live contexts at ~8-16), each blitting to its own lightweight 2D canvas.
- **Robust keying.** Dominant-channel classification with a continuous alpha ramp and spill suppression — no exact key color needed, survives codec color drift, removes green fringe from hair and edges.
- **Works everywhere.** WebGL with an automatic Canvas2D (CPU) fallback running the identical math, plus WebGL context-loss recovery.
- **Optional edge dissolve.** Blur + bottom vignette + top/bottom alpha fades that make a keyed presenter read as part of the page instead of a video rectangle.
- **Auto-tune.** Derives `minKey`/`bias`/`softness` from the footage itself — once on the first frame or continuously as lighting changes — via a tiny sandboxed plugin system you can extend.

## Install

Straight from jsDelivr, no install or build step — it mirrors this repo directly:

```html
<script type="module">
  import { ChromaKeyVideo } from 'https://cdn.jsdelivr.net/gh/kaltura/chroma-key-video/src/chromakey.js';
</script>
```

Pin a version for production (`@v1.2.0` instead of unpinned) so a new release can't change behavior under you.

## Quick start

```html
<script type="module">
  import { ChromaKeyVideo } from './src/chromakey.js';

  const player = new ChromaKeyVideo('avatar-greenscreen.mp4', {
    videoAttributes: { muted: true, loop: true, autoplay: true, playsInline: true, crossOrigin: 'anonymous' },
  });
  player.mount(document.querySelector('#stage'));
  player.play();
</script>
```

Or as a custom element (style-isolated via closed shadow DOM):

```html
<script type="module">
  import { defineChromaKeyVideoElement } from './src/chromakey.js';
  defineChromaKeyVideoElement();
</script>

<chroma-key-video src="avatar-greenscreen.mp4" autoplay loop muted edge-dissolve></chroma-key-video>
```

The output canvas behaves like an `<img>`. Give it a CSS size, or let it default to the video's aspect ratio, and position it anywhere. The render buffer follows the canvas's layout box × `devicePixelRatio`, capped by `maxPixelRatio`.

## API

### `new ChromaKeyVideo(source, options?)`

| `source` | Behavior |
|---|---|
| `string` URL | Library creates a `<video>` (configured by `options.videoAttributes`). Cross-origin URLs need CORS headers — frames are read into a canvas. |
| `HTMLVideoElement` | Used as-is; you keep control of playback and lifecycle. |
| `MediaStream` | Webcam, `canvas.captureStream()`, WebRTC — attached via `srcObject`. |

### Options (defaults shown)

| Option | Default | Live? | Description |
|---|---|---|---|
| `channel` | `'green'` | no | Key channel: `'green'` or `'blue'`. |
| `minKey` | `36` | yes | Floor (0-255) the key channel must exceed to key. |
| `bias` | `0.96` | yes | Ratio the key channel must beat each other channel by. |
| `softness` | `28` | yes | Width of the partial-alpha edge ramp. Higher = softer. |
| `spill` | `0.45` | yes | Base strength of key-color cast removal on non-keyed edge pixels; ramps to full removal for strong casts. |
| `autoTune` | `false` | no | Fit `minKey`/`bias`/`softness` to the footage: `true` (once, on the first frame) or `'adaptive'` (continuous). |
| `edgeDissolve` | `false` | yes | Enable blur + vignette + fade edge treatment. |
| `fadeTop` | `0.05` | yes | Top alpha fade, as a fraction of height (edgeDissolve only). |
| `fadeBottom` | `0.18` | yes | Bottom alpha fade fraction (edgeDissolve only). |
| `blurStrength` | `0.85` | yes | Blurred-copy mix near the bottom (edgeDissolve only). |
| `desaturate` | `0.35` | yes | Desaturation toward luma near the bottom (edgeDissolve only). |
| `cssFade` | `true` | yes | Redundant CSS `mask-image` bottom fade on the canvas (edgeDissolve only). |
| `maxPixelRatio` | `2` | yes | Cap on devicePixelRatio for the render buffer. |
| `forceCanvas2D` | `false` | no | Force the CPU backend (testing / diagnostics). |
| `maxCPUPixels` | `262144` | yes | Pixel budget for the CPU fallback (frames downscale to fit). |
| `videoAttributes` | see source | no | Attributes for a library-created `<video>` (URL/stream sources). |

### Members

| Member | Description |
|---|---|
| `.canvas` | The transparent output `<canvas>`. Style/place it yourself or use `mount()`. |
| `.video` | The underlying `<video>` element. |
| `.backend` | `'webgl'` \| `'canvas2d'` \| `null` (before first frame). |
| `.frameCount` | Frames rendered so far. |
| `.isDestroyed` | `true` after `destroy()`. |
| `.mount(parent)` | Append the canvas to `parent`. Returns `this`. |
| `.update(partial)` | Change options live; applies next frame (immediately when paused). |
| `.play()` / `.pause()` | Control the underlying video. |
| `.renderFrame()` | Render the current frame once (e.g. after seeking while paused). |
| `.autoTune(opts?)` | Analyze the current frame and fit `minKey`/`bias`/`softness`. Returns `{ok, params, backgroundFraction, applied}`. |
| `.sampleFrame(opts?)` | Downscaled `ImageData` of the current source frame (or `null`). |
| `.use(plugin)` | Attach a plugin (see Plugins). Returns `this`. |
| `.unuse(name)` | Detach a plugin by name. Returns `true` if it was attached. |
| `.destroy({removeCanvas})` | Stop and release everything (plugins detach first). Last instance releases the shared GL context. |
| `ChromaKeyVideo.isWebGLAvailable()` | Static capability check. |

### Events (`EventTarget`)

| Event | `detail` | When |
|---|---|---|
| `backend` | `'webgl'` \| `'canvas2d'` | Backend decided or changed (e.g. context loss). |
| `started` | — | First frame rendered. |
| `error` | underlying error | Video load failure, tainted canvas (missing CORS), etc. |
| `autotune` | the `autoTune()` result object | Every auto-tune run (manual, option, or plugin). |
| `pluginerror` | `{plugin, error}` | A plugin hook threw; the plugin was detached, the player keeps running. |

### `<chroma-key-video>` element

`defineChromaKeyVideoElement(tagName?)` registers the element.

- **Source:** either a slotted `<video>` child or the `src` attribute. A slotted `<video>` takes precedence over `src` when both are present, and can be any source the video element itself supports — file, `MediaStream`, WebRTC, hls.js/dash.js-attached, etc.:
  ```html
  <chroma-key-video auto-tune><video id="my-live-video"></video></chroma-key-video>
  ```
  The slotted video is caller-owned: `autoplay`/`loop`/`muted`/`crossorigin` have no effect on it (configure it directly), and it's never paused or cleared by `destroy()`/disconnection. Swapping the slotted `<video>` at runtime rebuilds the player against the new source.
- **Attributes:** `src`, `autoplay`, `loop`, `muted`, `channel`, `min-key`, `bias`, `softness`, `spill`, `edge-dissolve`, `auto-tune` (empty = once, `"adaptive"` = continuous), `fade-top`, `fade-bottom`, `max-pixel-ratio`.
- Numeric attributes update live.
- The underlying player is exposed as `element.player`.

## Auto-tune

`minKey`, `bias`, and `softness` depend on the footage: how saturated the screen is, how evenly it's lit, how much the codec drifted the color. Auto-tune measures that instead of guessing.

- Downsamples the current frame (~9K pixels, ~3 ms per run including the GPU readback).
- Finds the key-dominant background population.
- Derives the three parameters from its percentiles.

`spill` is left alone — it's a taste setting.

Three ways to use it:

```js
// 1. One-shot, whenever you like:
player.autoTune();                       // → {ok, params, backgroundFraction, applied}

// 2. At construction — tune once on the first frame:
new ChromaKeyVideo(src, { autoTune: true });

// 3. Continuous — re-tune as the video plays (lighting changes, scene cuts):
new ChromaKeyVideo(src, { autoTune: 'adaptive' });
// or with control over cadence and smoothing:
import { autoTunePlugin } from './src/chromakey.js';
player.use(autoTunePlugin({ adaptive: true, interval: 1500, smoothing: 0.5 }));
```

Adaptive runs blend into the current values using an exponential moving average (`smoothing` = weight of the old value). They skip the update entirely when the change is below visibility thresholds. A static scene converges, then costs only the analysis — no re-renders.

Every run fires an `autotune` event with the result. `{ok: false, reason}` reports one of:

- `'not-ready'`
- `'unreadable'` — tainted canvas
- `'no-background'` — under 2% of pixels look like a key screen; current settings are left untouched

## Plugins

The plugin system exists so optional behavior (like auto-tune) stays out of the render path until you ask for it — and so your extensions can't break the player.

```js
player.use({
  name: 'fps-probe',
  attach(ctx)        { ctx.every(1000, () => console.log(ctx.getOptions())); },
  frame(ctx, info)   { /* runs after each rendered frame: {frameCount, backend, width, height} */ },
  detach(ctx)        { /* cleanup beyond timers/listeners, which are automatic */ },
});
player.unuse('fps-probe');
```

Plugins never touch the player instance. They get a frozen `ctx` facade:

| `ctx` member | Description |
|---|---|
| `video`, `canvas`, `backend`, `isDestroyed` | Read-only accessors to the live values. |
| `getOptions()` | Copy of the current options. |
| `update(partial)`, `autoTune(opts)`, `sampleFrame(opts)`, `requestRender()` | The player's public surface. |
| `every(ms, fn)` | Managed interval — auto-cleared on detach/destroy. Returns a cancel function. |
| `on(type, fn, opts)` | Managed player-event listener — auto-removed on detach/destroy. Returns an off function. |
| `emit(type, detail)` | Dispatch a CustomEvent on the player (namespace your own event types). |

Isolation and cost:

- A throw in any hook detaches that plugin, fires `pluginerror`, and leaves the player and other plugins running.
- Timers and listeners a plugin registered through `ctx` are cleaned up automatically on detach and on `destroy()`.
- With no plugins attached the per-frame overhead is a single `Map.size` check — zero allocation, zero calls.
- Plugins are plain functions running with the page's privileges: only attach code you trust, same as any script you include.

## How the keying works

Each pixel is classified by how much the key channel dominates the other two, not by distance from a fixed key color:

```
sat = (maxChannel - minChannel) / maxChannel
dom = key - max(otherA, otherB)

keyed when: key is the max channel, key > minKey, key > otherA*bias,
            key > otherB*bias, sat > 0.08, dom > 2

alpha = 1 - clamp((dom - 2) / max(8, softness*0.55) + (sat - 0.08)*1.8, 0, 1)
```

Keyed pixels are fully despilled: the key channel is clamped to the max of the other two. Partially keyed edge pixels then composite without a green halo.

Pixels that fail the keying gate but still carry a key cast (`dom > 4`, `key > 40`) get partial spill removal instead:

- `dom * min(max(1, spill), spill * (1 + dom/32))` is subtracted from the key channel.
- Faint casts are reduced by the `spill` fraction — a taste setting.
- The removal fraction ramps up to a full clamp as the cast grows.

This ramp is for mixed hair/screen pixels — strands thin enough that a pixel is part hair, part screen. They're too dark to pass the keying gate but still carry a strong cast; a constant removal fraction would leave them visibly green.

The trade-off is standard for keyers: a genuinely green foreground object gets desaturated toward its other channels.

With `edgeDissolve`, the keyed layer also runs through:

- A separable 9-tap Gaussian blur, mixed in by a bottom-anchored vignette with desaturation toward luma.
- Explicit top/bottom alpha fade ramps.
- A redundant CSS mask fade.

## Architecture

```
video frame ──▶ shared WebGL engine (one hidden context for the whole page)
                 ├─ key pass (per-channel compiled program)
                 ├─ [edgeDissolve] horizontal blur ─▶ composite (vertical blur
                 │    inline + vignette + desaturate + fades)
                 └─ blit ──▶ per-instance 2D display canvas (the .canvas you see)

WebGL unavailable / context lost ──▶ Canvas2D fallback (identical per-pixel math,
                                     capped resolution, no blur/vignette)
```

- Render loop uses `requestVideoFrameCallback` (once per presented frame, idle while paused/hidden) with a `requestAnimationFrame` fallback.
- Paused/seeked frames render via `loadeddata`/`seeked` listeners; `ResizeObserver` re-renders on layout changes.
- On `webglcontextlost` the CPU fallback takes over; on restore, programs recompile and instances return to the GPU automatically.

## Browser support

Everything evergreen: Chrome/Edge, Firefox, Safari 15.4+ (including iOS). The library needs `<canvas>` and uses WebGL 1 when present. Devices without WebGL fall back to the CPU path automatically.

## Testing & CI

```bash
npm install
npm test              # e2e + real-footage suite (22 tests)
npm run bench         # performance benchmark (Chromium) -> bench-results.json
npm run bench:all     # benchmark on Chromium + Firefox + WebKit
npm run check         # syntax check + bundle size budget gate
```

**E2E suite** (Playwright, headless Chromium with SwiftShader). Generates synthetic green/blue-screen test patterns via `canvas.captureStream()` and renders them through the library. Asserts on output pixels:

- Transparency, ramp alpha, spill values.
- WebGL↔Canvas2D parity, 12 concurrent instances, edge fades, orientation, destroy semantics.
- The custom element and the encoded-URL source path.
- Plugin lifecycle and error isolation.
- One-shot and adaptive auto-tune, including convergence and the `auto-tune` element attribute.

**Real-footage suite** (`test/footage.spec.js`). Runs three short 720p h264 clips of presenters over a green screen, committed in `test/assets/` so CI stays offline:

- Two studio talking-head clips, plus a stress clip with long wind-blown hair — loose flying strands and green bounce light on the skin, the classic hard keying case. Sourced from Pixabay under the Pixabay Content License.
- Both backends are exercised.
- Real footage carries codec noise, uneven lighting, hair detail, and soft shadows the synthetic patterns can't, so assertions are statistical: after seeking to a fixed frame and auto-tuning, background margins are fully transparent, the face and body are fully opaque, transparent/opaque population fractions are in range, and the fraction of visible pixels keeping a strong green cast stays under a per-clip ceiling — 0.5% for the studio clips, 0.05% for the hair stress clip.

**Benchmark** (`test/bench.spec.js`, measurement logic in `test/bench-core.js`). Runs on a synthetic 720p source by default, so it stays offline.

- Measures per-frame render cost (WebGL key pass, edgeDissolve, Canvas2D fallback), `autoTune()` cost, sustained fps for 1×720p and 12 concurrent players, and main-thread jank.
- `BENCH_SRC=test/assets/greenscreen-hair.mp4 npm run bench` runs it on real footage instead.
- Fails only on order-of-magnitude regressions — ceilings are sized for SwiftShader.
- Absolute numbers land in `bench-results{-firefox,-webkit}{-footage}.json` and, on GitHub Actions, the job summary.
- `npm run bench:all` runs the same suite on Chromium, Firefox, and WebKit — one Playwright project per engine.

**Size gate** (`scripts/check-size.mjs`). Minifies the whole library with esbuild and enforces budgets: 24 KB minified, 8 KB gzip. Raising a budget is a deliberate edit in the same commit as the feature that needs it.

`.github/workflows/ci.yml` runs all of the above on every push and PR: syntax check → size gate → e2e tests → benchmark (results uploaded as an artifact).

## Benchmark your device

Open **[the bench page](https://kaltura.github.io/chroma-key-video/test/bench.html)** on any device — phone, tablet, laptop. Hit *Run benchmark*.

- Runs the exact same measurement suite as CI: synthetic pattern and/or the real hair footage.
- Takes ~30 seconds per source.

Then hit **Share results**. This opens a prefilled GitHub issue with your numbers as JSON.

- A bot validates the submission and adds your device to **[DEVICES.md](DEVICES.md)**, the community leaderboard.
- The issue closes automatically.
- No account data beyond what your browser exposes — user agent, GPU renderer string, core count — is collected.

### Observed numbers

All rows below key a 1280x720 buffer.

- "Key ms" / "+Dissolve ms" / "CPU ms" are per-frame render cost.
- "fps x12" is the per-player range with 12 concurrent instances running at once.

**Across engines**, same machine (M3 Pro, macOS), synthetic source, `npm run bench:all`:

| Engine | GPU / backend | Key ms | +Dissolve ms | CPU ms | autoTune ms | fps x1 | fps x12 | Jank /120 |
|---|---|---|---|---|---|---|---|---|
| Firefox | Apple M1, or similar (real GPU) | 4.56 | 4.48 | 8.27 | 0.40 | 17.4 | 17.5 each | 1 |
| WebKit | Apple GPU (real GPU) | 3.14 | 3.37 | 2.00 | 0.95 | 27.5 | 18.5-19 each | 1 |
| Chromium (headless) | ANGLE/SwiftShader (software) | 13.6 | 32.0 | 2.21 | 0.86 | 30.4 | 20 each | 0 |

Headless Chromium has no real GPU attached — it falls back to the SwiftShader software rasterizer. That's why its key/dissolve costs run higher than Firefox and WebKit's real-GPU numbers above. On real hardware, Chromium is otherwise the fastest engine (see the next table).

**Across environments**, real hair-footage clip vs. the synthetic source, showing why CI's regression ceilings are set generously:

| Environment | GPU | Key ms | +Dissolve ms | CPU ms | autoTune ms | fps x1 | fps x12 | Jank /120 |
|---|---|---|---|---|---|---|---|---|
| Real Chrome, real GPU (M3 Pro, footage) | ANGLE Metal, Apple M3 Pro | 1.04 | 1.59 | 5.89 | 4.05 | 24 | 24-24.5 | 0 (worst 18.6ms) |
| Headless Chromium, SwiftShader (M3 Pro, footage) | ANGLE/SwiftShader (software) | 10.96 | 29.66 | 3.91 | 6.67 | 24 | 17.5-24.5 | 73 (worst 51.6ms) |
| GitHub Actions hosted runner, SwiftShader (2-core, synthetic) | ANGLE/SwiftShader (software) | 61.06 | 153.48 | 5.05 | 3.20 | 9.5 | 11 each | 120 (worst 100.1ms) |

A real device with real GPU access renders 10-50x faster than the weakest CI runner. That's why `test/bench.spec.js`'s gates are sized off the hosted-runner numbers, not the local ones. They only need to catch genuine regressions, not runner-to-runner variance.

More devices, browsers, and real footage vs. synthetic comparisons accumulate in **[DEVICES.md](DEVICES.md)** as people run the [bench page](https://kaltura.github.io/chroma-key-video/test/bench.html) and share results.

## Demo

Live at **[kaltura.github.io/chroma-key-video/demo](https://kaltura.github.io/chroma-key-video/demo/)**, or locally:

```bash
npm run serve
# open http://localhost:4173/demo/
```

The demo includes:

- An animated synthetic green-screen presenter.
- Live tuning sliders and an edge-dissolve toggle.
- An Auto-tune button with an adaptive checkbox — the sliders follow the derived values.
- A URL input for your own footage.

## License

MIT
