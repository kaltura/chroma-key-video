# chroma-key-video

Real-time green/blue-screen keying for HTML video, in the browser. Point it at any flat green-screen video (file URL, `<video>` element, or `MediaStream`) and get a per-pixel transparent canvas you can composite over anything on the page.

- **Zero dependencies.** One ES module file, no build step. Works with any framework or none.
- **Unlimited concurrent players.** All instances share one WebGL context (browsers cap live contexts at ~8-16), each blitting to its own lightweight 2D canvas.
- **Robust keying.** Dominant-channel classification with a continuous alpha ramp and spill suppression — no exact key color needed, survives codec color drift, removes green fringe from hair and edges.
- **Works everywhere.** WebGL with an automatic Canvas2D (CPU) fallback running the identical math, plus WebGL context-loss recovery.
- **Optional edge dissolve.** Blur + bottom vignette + top/bottom alpha fades that make a keyed presenter read as part of the page instead of a video rectangle.
- **Auto-tune.** Derives `minKey`/`bias`/`softness` from the footage itself — once on the first frame or continuously as lighting changes — via a tiny sandboxed plugin system you can extend.

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

The output canvas behaves like an `<img>`: give it a CSS size (or let it default to the video's aspect ratio) and position it anywhere. The render buffer follows the canvas's layout box × `devicePixelRatio`, capped by `maxPixelRatio`.

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
| `spill` | `0.45` | yes | Strength of key-color cast removal on non-keyed edge pixels. |
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

`defineChromaKeyVideoElement(tagName?)` registers the element. Attributes: `src`, `autoplay`, `loop`, `muted`, `channel`, `min-key`, `bias`, `softness`, `spill`, `edge-dissolve`, `auto-tune` (empty = once, `"adaptive"` = continuous), `fade-top`, `fade-bottom`, `max-pixel-ratio`. Numeric attributes update live. The underlying player is exposed as `element.player`.

## Auto-tune

`minKey`, `bias`, and `softness` depend on the footage — how saturated the screen is, how evenly it's lit, how much the codec drifted the color. Auto-tune measures that instead of guessing: it downsamples the current frame (~9K pixels, ~3 ms per run including the GPU readback), finds the key-dominant background population, and derives the three parameters from its percentiles. `spill` is left alone — it's a taste setting.

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

Adaptive runs blend into the current values (exponential moving average, `smoothing` = weight of the old value) and skip the update entirely when the change is below visibility thresholds — a static scene converges and then costs only the analysis, no re-renders. Every run fires an `autotune` event with the result; `{ok: false, reason}` reports `'not-ready'`, `'unreadable'` (tainted canvas), or `'no-background'` (under 2% of pixels look like a key screen — the current settings are left untouched).

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

Keyed pixels are also fully despilled — the key channel is clamped to the max of the other two — so partially keyed edge pixels composite without a green halo. Pixels that fail the gate but still carry a key cast (`dom > 4`, `key > 40`) get `dom * spill` subtracted from the key channel, which removes the residual cast on hair and shoulders without keying them.

With `edgeDissolve`, the keyed layer additionally runs through a separable 9-tap Gaussian blur mixed in by a bottom-anchored vignette (with desaturation toward luma), plus explicit top/bottom alpha fade ramps and a redundant CSS mask fade.

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

Everything evergreen: Chrome/Edge, Firefox, Safari 15.4+ (including iOS). The library needs `<canvas>`, and uses WebGL 1 when present. Devices without WebGL fall back to the CPU path automatically.

## Testing & CI

```bash
npm install
npm test              # e2e suite (16 tests)
npm run bench         # performance benchmark -> bench-results.json
npm run check         # syntax check + bundle size budget gate
```

The e2e suite (Playwright, headless Chromium with SwiftShader) generates synthetic green/blue-screen test patterns via `canvas.captureStream()`, renders them through the library, and asserts output pixels: transparency, ramp alpha, spill values, WebGL↔Canvas2D parity, 12 concurrent instances, edge fades, orientation, destroy semantics, the custom element, the encoded-URL source path, plugin lifecycle and error isolation, one-shot and adaptive auto-tune (including convergence), and the `auto-tune` element attribute.

The benchmark (`test/bench.spec.js`) measures per-frame render cost (WebGL key pass, edgeDissolve, Canvas2D fallback), `autoTune()` cost, sustained fps for 1×720p and 12 concurrent players, and main-thread jank — on a synthetic 720p source, so it runs offline. It fails only on order-of-magnitude regressions (ceilings sized for SwiftShader); absolute numbers land in `bench-results.json` and, on GitHub Actions, the job summary.

The size gate (`scripts/check-size.mjs`) minifies the whole library with esbuild and enforces budgets (24 KB minified, 8 KB gzip). Raising a budget is a deliberate edit in the same commit as the feature that needs it.

`.github/workflows/ci.yml` runs all of the above on every push and PR: syntax check → size gate → e2e tests → benchmark (results uploaded as an artifact).

## Demo

```bash
npm run serve
# open http://localhost:4173/demo/
```

The demo includes an animated synthetic green-screen presenter, live tuning sliders, an edge-dissolve toggle, an Auto-tune button with an adaptive checkbox (the sliders follow the derived values), and a URL input for your own footage.

## License

MIT
