# chroma-key-video

Real-time green/blue-screen keying for HTML video, in the browser. Point it at any flat green-screen video (file URL, `<video>` element, or `MediaStream`) and get a per-pixel transparent canvas you can composite over anything on the page.

- **Zero dependencies.** One ES module file, no build step. Works with any framework or none.
- **Unlimited concurrent players.** All instances share one WebGL context (browsers cap live contexts at ~8-16), each blitting to its own lightweight 2D canvas.
- **Robust keying.** Dominant-channel classification with a continuous alpha ramp and spill suppression — no exact key color needed, survives codec color drift, removes green fringe from hair and edges.
- **Works everywhere.** WebGL with an automatic Canvas2D (CPU) fallback running the identical math, plus WebGL context-loss recovery.
- **Optional edge dissolve.** Blur + bottom vignette + top/bottom alpha fades that make a keyed presenter read as part of the page instead of a video rectangle.

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
| `.destroy({removeCanvas})` | Stop and release everything. Last instance releases the shared GL context. |
| `ChromaKeyVideo.isWebGLAvailable()` | Static capability check. |

### Events (`EventTarget`)

| Event | `detail` | When |
|---|---|---|
| `backend` | `'webgl'` \| `'canvas2d'` | Backend decided or changed (e.g. context loss). |
| `started` | — | First frame rendered. |
| `error` | underlying error | Video load failure, tainted canvas (missing CORS), etc. |

### `<chroma-key-video>` element

`defineChromaKeyVideoElement(tagName?)` registers the element. Attributes: `src`, `autoplay`, `loop`, `muted`, `channel`, `min-key`, `bias`, `softness`, `spill`, `edge-dissolve`, `fade-top`, `fade-bottom`, `max-pixel-ratio`. Numeric attributes update live. The underlying player is exposed as `element.player`.

## How the keying works

Each pixel is classified by how much the key channel dominates the other two, not by distance from a fixed key color:

```
sat = (maxChannel - minChannel) / maxChannel
dom = key - max(otherA, otherB)

keyed when: key is the max channel, key > minKey, key > otherA*bias,
            key > otherB*bias, sat > 0.08, dom > 2

alpha = 1 - clamp((dom - 2) / max(8, softness*0.55) + (sat - 0.08)*1.8, 0, 1)
```

Pixels that fail the gate but still carry a key cast (`dom > 8`, `key > 70`) get `dom * spill` subtracted from the key channel — that removes the green fringe on hair and shoulders without keying them.

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

## Testing

```bash
npm install
npx playwright test
```

The e2e suite (Playwright, headless Chromium with SwiftShader) generates synthetic green/blue-screen test patterns via `canvas.captureStream()`, renders them through the library, and asserts output pixels: transparency, ramp alpha, spill values, WebGL↔Canvas2D parity, 12 concurrent instances, edge fades, orientation, destroy semantics, the custom element, and the encoded-URL source path.

## Demo

```bash
npm run serve
# open http://localhost:4173/demo/
```

The demo includes an animated synthetic green-screen presenter, live tuning sliders, an edge-dissolve toggle, and a URL input for your own footage.

## License

MIT
