/**
 * chroma-key-video — real-time green/blue-screen keying for HTML video.
 *
 * Turns any flat green-screen (or blue-screen) video into per-pixel
 * transparent output on a <canvas>, in real time, in the browser.
 *
 * Design highlights:
 *
 * - **Dominant-channel keying, not fixed-color distance.** Each pixel is
 *   classified by how much its key channel dominates the other two, so no
 *   exact reference color is needed and the key survives codec color drift.
 * - **Continuous key ramp + despill.** Edge pixels get anti-aliased partial
 *   alpha with their key-color cast fully removed (no green halo), and
 *   near-key pixels (hair, shoulders under green bounce light) get their
 *   cast reduced without being keyed.
 * - **One shared WebGL context for all instances.** Browsers limit live
 *   WebGL contexts (~8-16). All instances render through a single hidden GL
 *   canvas and blit to their own cheap 2D display canvas, so any number of
 *   players can run concurrently on one page.
 * - **Canvas2D fallback with identical math.** When WebGL is unavailable
 *   (headless, locked-down WebViews, context loss) the same per-pixel
 *   formulas run on the CPU at a capped resolution.
 * - **Optional edge dissolve** (blur + bottom vignette + top/bottom alpha
 *   fades) that makes a keyed presenter read as "a character in the page"
 *   instead of a video rectangle.
 *
 * Usage:
 *
 *   import { ChromaKeyVideo } from './chromakey.js';
 *   const player = new ChromaKeyVideo('avatar.mp4', { edgeDissolve: true });
 *   player.mount(document.querySelector('#stage'));
 *   player.play();
 *
 * Or as a custom element:
 *
 *   import { defineChromaKeyVideoElement } from './chromakey.js';
 *   defineChromaKeyVideoElement();
 *   // <chroma-key-video src="avatar.mp4" autoplay loop muted></chroma-key-video>
 *
 * Zero dependencies. ES module. No build step required.
 */

'use strict';

/* ════════════════════════════════════════════════════════════════════════
 * Defaults & option handling
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Default options. All are live-updatable via {@link ChromaKeyVideo#update}
 * except `channel`, `forceCanvas2D`, `videoAttributes` and `autoTune`.
 *
 * Keying thresholds operate on the 0-255 RGB scale.
 */
export const DEFAULTS = Object.freeze({
  /** Key channel: 'green' for green screens, 'blue' for blue screens. */
  channel: 'green',
  /** Floor (0-255) the key channel must exceed to be considered background. */
  minKey: 36,
  /** Ratio the key channel must beat each other channel by (key > other*bias). */
  bias: 0.96,
  /** Width of the continuous alpha ramp near the key threshold. Higher = softer edges. */
  softness: 28,
  /** Spill suppression strength (0-1+). Removes key-color cast from edge pixels. */
  spill: 0.45,
  /**
   * Derive minKey/bias/softness from the footage itself: `true` tunes once
   * on the first frame, `'adaptive'` keeps re-tuning during playback (see
   * {@link autoTunePlugin}). `false` uses the configured values as-is.
   */
  autoTune: false,

  /** Enable the blur + vignette + fade pipeline that dissolves frame edges. */
  edgeDissolve: false,
  /** Fraction of frame height faded to transparent at the top (edgeDissolve only). */
  fadeTop: 0.05,
  /** Fraction of frame height faded to transparent at the bottom (edgeDissolve only). */
  fadeBottom: 0.18,
  /** How strongly the blurred copy mixes in near the bottom (0-1, edgeDissolve only). */
  blurStrength: 0.85,
  /** How much color desaturates toward luma near the bottom (0-1, edgeDissolve only). */
  desaturate: 0.35,
  /** Apply a redundant CSS mask-image fade on the canvas (edgeDissolve only). */
  cssFade: true,

  /** Cap on devicePixelRatio when sizing the render buffer. */
  maxPixelRatio: 2,
  /** Force the Canvas2D (CPU) backend. Mainly for testing the fallback. */
  forceCanvas2D: false,
  /** Pixel budget for the CPU fallback; frames are processed downscaled to fit. */
  maxCPUPixels: 512 * 512,

  /**
   * Milliseconds of no decoded-frame progress (while playing) before firing
   * `'stalled'` — catches a track that goes silent while readyState/paused/
   * ended still look healthy (e.g. a WebRTC failure). `<= 0` disables it.
   */
  stallTimeout: 4000,

  /** Attributes applied to the <video> element created when `source` is a URL. */
  videoAttributes: Object.freeze({
    muted: true,
    loop: false,
    autoplay: false,
    playsInline: true,
    crossOrigin: 'anonymous',
  }),
});

/** Options that select shader variants / backends / plugins and can't change after construction. */
const IMMUTABLE_OPTIONS = ['channel', 'forceCanvas2D', 'videoAttributes', 'autoTune'];

/** Watchdog polling cadence for stall detection (see `_checkStall`). Fixed; `stallTimeout` is the tunable. */
const STALL_CHECK_INTERVAL_MS = 500;

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

/** GLSL-compatible smoothstep, used by the CPU fallback fade ramps. */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ════════════════════════════════════════════════════════════════════════
 * Shaders
 *
 * The keying math is the contract of this library. The GLSL below and the
 * CPU loop in `renderCanvas2D` implement the SAME formulas — change one,
 * change both (the e2e suite compares their outputs pixel-for-pixel).
 * ════════════════════════════════════════════════════════════════════════ */

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Key pass. `KEY`/`OA`/`OB` are swizzle letters injected per channel
 * ('g','r','b' for green screens; 'b','r','g' for blue screens), giving one
 * compiled program per channel with zero per-pixel branching on the choice.
 *
 * Two code paths per pixel:
 *  - Background (`keyed`): continuous alpha ramp — anti-aliased edges with
 *    no extra blur-the-matte pass. Keyed pixels are also fully despilled
 *    (key channel clamped to the max of the other two): a partially keyed
 *    edge pixel that kept its key color would composite as a green halo
 *    around hair and shoulders.
 *  - Spill: pixels that did NOT key but still carry a key-color cast get the
 *    cast subtracted. The removal fraction starts at the `spill` option for
 *    faint casts and ramps up to a full clamp as dominance grows: mixed
 *    hair/screen pixels too dark to pass the keying gate carry a strong
 *    cast, and a constant fraction would leave them visibly green.
 *
 * Output is premultiplied alpha (required for correct GL compositing and
 * for the downstream blur pass to weigh transparent pixels correctly).
 */
function keyFragmentSource(KEY, OA, OB) {
  return `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform float u_minKey;
uniform float u_bias;
uniform float u_softness;
uniform float u_spill;
void main() {
  vec4 texel = texture2D(u_source, v_uv);
  float key = texel.${KEY} * 255.0;
  float oA  = texel.${OA} * 255.0;
  float oB  = texel.${OB} * 255.0;

  float maxC = max(key, max(oA, oB));
  float minC = min(key, min(oA, oB));
  float sat  = maxC == 0.0 ? 0.0 : (maxC - minC) / maxC;
  float dom  = key - max(oA, oB);

  vec3 color  = texel.rgb;
  float alpha = texel.a;

  if (key >= maxC && key > u_minKey
      && key > oA * u_bias && key > oB * u_bias
      && sat > 0.08 && dom > 2.0) {
    float keyed = clamp((dom - 2.0) / max(8.0, u_softness * 0.55)
                        + (sat - 0.08) * 1.8, 0.0, 1.0);
    alpha *= 1.0 - keyed;
    color.${KEY} = max(oA, oB) / 255.0;
  } else if (dom > 4.0 && key > 40.0) {
    float despill = min(max(1.0, u_spill), u_spill * (1.0 + dom / 32.0));
    color.${KEY} = max(0.0, key - dom * despill) / 255.0;
  }

  gl_FragColor = vec4(color * alpha, alpha);
}`;
}

/** Horizontal half of a separable 9-tap Gaussian over the keyed layer. */
const BLUR_H_FRAGMENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform float u_texel;
void main() {
  vec4 sum = texture2D(u_source, v_uv) * 0.227027;
  sum += (texture2D(u_source, v_uv + vec2(u_texel * 1.0, 0.0))
        + texture2D(u_source, v_uv - vec2(u_texel * 1.0, 0.0))) * 0.194595;
  sum += (texture2D(u_source, v_uv + vec2(u_texel * 2.0, 0.0))
        + texture2D(u_source, v_uv - vec2(u_texel * 2.0, 0.0))) * 0.121622;
  sum += (texture2D(u_source, v_uv + vec2(u_texel * 3.0, 0.0))
        + texture2D(u_source, v_uv - vec2(u_texel * 3.0, 0.0))) * 0.054054;
  sum += (texture2D(u_source, v_uv + vec2(u_texel * 4.0, 0.0))
        + texture2D(u_source, v_uv - vec2(u_texel * 4.0, 0.0))) * 0.016216;
  gl_FragColor = sum;
}`;

/**
 * Composite pass. Finishes the Gaussian (vertical taps inline — saves a
 * full pass and a third framebuffer), then blends sharp vs. blurred keyed
 * layers by a bottom-anchored smoothstep vignette, desaturates toward luma
 * near the bottom, and applies explicit top/bottom alpha fade ramps.
 * This dissolve is what removes the "floating video rectangle" look.
 * v_uv.y runs 0 (bottom) to 1 (top).
 */
const COMPOSITE_FRAGMENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_sharp;
uniform sampler2D u_blur;
uniform float u_texel;
uniform float u_fadeTop;
uniform float u_fadeBottom;
uniform float u_blurStrength;
uniform float u_desat;
void main() {
  vec4 sharp = texture2D(u_sharp, v_uv);

  vec4 soft = texture2D(u_blur, v_uv) * 0.227027;
  soft += (texture2D(u_blur, v_uv + vec2(0.0, u_texel * 1.0))
         + texture2D(u_blur, v_uv - vec2(0.0, u_texel * 1.0))) * 0.194595;
  soft += (texture2D(u_blur, v_uv + vec2(0.0, u_texel * 2.0))
         + texture2D(u_blur, v_uv - vec2(0.0, u_texel * 2.0))) * 0.121622;
  soft += (texture2D(u_blur, v_uv + vec2(0.0, u_texel * 3.0))
         + texture2D(u_blur, v_uv - vec2(0.0, u_texel * 3.0))) * 0.054054;
  soft += (texture2D(u_blur, v_uv + vec2(0.0, u_texel * 4.0))
         + texture2D(u_blur, v_uv - vec2(0.0, u_texel * 4.0))) * 0.016216;

  float v = v_uv.y;
  float zone = max(u_fadeBottom * 1.6, 0.0001);
  float w = 1.0 - smoothstep(0.0, zone, v);

  vec4 col = mix(sharp, soft, w * u_blurStrength);
  float luma = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
  col.rgb = mix(col.rgb, vec3(luma), w * u_desat);

  float fade = 1.0;
  if (u_fadeBottom > 0.0) fade *= smoothstep(0.0, u_fadeBottom, v);
  if (u_fadeTop > 0.0) fade *= 1.0 - smoothstep(1.0 - u_fadeTop, 1.0, v);

  gl_FragColor = col * fade;
}`;

/** Swizzle letters per key channel: [key, otherA, otherB]. */
const CHANNEL_SWIZZLE = {
  green: ['g', 'r', 'b'],
  blue: ['b', 'r', 'g'],
};

/** RGBA byte offsets per key channel: [key, otherA, otherB] (CPU fallback). */
const CHANNEL_OFFSETS = {
  green: [1, 0, 2],
  blue: [2, 0, 1],
};

/* ════════════════════════════════════════════════════════════════════════
 * Auto-tune parameter derivation
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Estimate keying parameters from one downscaled frame.
 *
 * Pixels pass a LOOSE background gate, independent of the current options
 * (key is the max channel, sat > 0.06, dom > 4, key > 30). Percentiles over
 * the candidates then set the thresholds with safety margin:
 *
 * - `minKey`: 30% of the 5th-percentile candidate key value — comfortably
 *   below the dimmest backdrop pixel and the dark blends at hair and
 *   shoulder edges, above typical foreground key levels.
 * - `bias`: 70% of the 10th-percentile key/other ratio, capped at 0.98 so
 *   near-neutral edge blends still enter the key ramp instead of surviving
 *   as a fringe.
 * - `softness`: scaled dominance spread — noisy or unevenly lit backdrops
 *   get a wider alpha ramp; the floor keeps real-footage edges soft.
 *
 * `spill` is aesthetic and left untouched.
 *
 * @returns {{ok: true, params: {minKey: number, bias: number, softness: number},
 *   backgroundFraction: number} | {ok: false, reason: 'no-background',
 *   backgroundFraction: number}}
 */
function deriveKeyParams(image, channel) {
  const d = image.data;
  const [ki, ai, bi] = CHANNEL_OFFSETS[channel];
  const keys = [];
  const doms = [];
  const ratios = [];

  for (let i = 0; i < d.length; i += 4) {
    const key = d[i + ki];
    const oA = d[i + ai];
    const oB = d[i + bi];
    const other = Math.max(oA, oB);
    if (key < other || key <= 30) continue;
    const sat = (key - Math.min(key, oA, oB)) / key;
    const dom = key - other;
    if (sat <= 0.06 || dom <= 4) continue;
    keys.push(key);
    doms.push(dom);
    ratios.push(key / Math.max(other, 1));
  }

  const backgroundFraction = keys.length / (d.length / 4);
  if (backgroundFraction < 0.02) {
    return { ok: false, reason: 'no-background', backgroundFraction };
  }

  const pct = (arr, q) => arr[Math.floor(q * (arr.length - 1))];
  keys.sort((x, y) => x - y);
  doms.sort((x, y) => x - y);
  ratios.sort((x, y) => x - y);

  return {
    ok: true,
    backgroundFraction,
    params: {
      minKey: clamp(Math.round(pct(keys, 0.05) * 0.3), 16, 110),
      bias: clamp(Math.round(pct(ratios, 0.10) * 70) / 100, 0.8, 0.98),
      softness: clamp(Math.round((pct(doms, 0.50) - pct(doms, 0.05)) * 1.6), 24, 110),
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Shared WebGL engine
 *
 * One hidden WebGL canvas + one set of compiled programs serves every
 * ChromaKeyVideo instance on the page. Each instance keeps only its own
 * textures/framebuffers inside the shared context and blits the finished
 * frame onto its own 2D display canvas. The shared canvas grows to the
 * largest instance size (high-water mark) and instances render into a
 * sub-viewport, so resizes are rare.
 *
 * The engine is created lazily on first WebGL render and disposed (context
 * released) when the last instance is destroyed.
 * ════════════════════════════════════════════════════════════════════════ */

let sharedEngine = null;

class GLEngine {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: 'low-power',
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('webgl-unavailable');

    /** Instances currently registered with the engine. */
    this.clients = new Set();
    /** Bumped on context restore; stale per-instance resources detect it and rebuild. */
    this.generation = 0;
    this.contextLost = false;
    this._disposed = false;

    this._onLost = (e) => {
      e.preventDefault(); // allow the browser to restore the context
      this.contextLost = true;
    };
    this._onRestored = () => {
      this.contextLost = false;
      this.generation++;
      this._setupContext();
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored);

    this._setupContext();
  }

  /** Compile programs and static state. Runs at creation and after context restore. */
  _setupContext() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // Fullscreen quad (triangle strip).
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    /** Per-channel program sets: channel -> { key, blurH, composite }. */
    this.programs = new Map();
    for (const [channel, [KEY, OA, OB]] of Object.entries(CHANNEL_SWIZZLE)) {
      this.programs.set(channel, {
        key: this._buildProgram(keyFragmentSource(KEY, OA, OB),
          ['u_source', 'u_minKey', 'u_bias', 'u_softness', 'u_spill']),
        blurH: this._buildProgram(BLUR_H_FRAGMENT, ['u_source', 'u_texel']),
        composite: this._buildProgram(COMPOSITE_FRAGMENT,
          ['u_sharp', 'u_blur', 'u_texel', 'u_fadeTop', 'u_fadeBottom', 'u_blurStrength', 'u_desat']),
      });
    }
  }

  _buildProgram(fragmentSource, uniformNames) {
    const gl = this.gl;
    const compile = (type, src) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(`chroma-key-video shader compile failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`chroma-key-video program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    const uniforms = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms, aPos: gl.getAttribLocation(program, 'a_pos') };
  }

  register(client) { this.clients.add(client); }

  unregister(client) {
    this.clients.delete(client);
    if (this.clients.size === 0) this._dispose();
  }

  _dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    if (sharedEngine === this) sharedEngine = null;
  }

  /** Grow the shared drawing buffer to at least w×h (high-water mark). */
  ensureSize(w, h) {
    if (this.canvas.width < w) this.canvas.width = w;
    if (this.canvas.height < h) this.canvas.height = h;
  }

  /** Allocate (or reallocate) one instance's GPU resources for a w×h frame. */
  createResources(w, h) {
    const gl = this.gl;
    const makeTarget = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const a = makeTarget();
    const b = makeTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { generation: this.generation, w, h, srcTex, texA: a.tex, fboA: a.fbo, texB: b.tex, fboB: b.fbo };
  }

  freeResources(res) {
    if (!res || this._disposed || this.gl.isContextLost()) return;
    const gl = this.gl;
    gl.deleteTexture(res.srcTex);
    gl.deleteTexture(res.texA);
    gl.deleteTexture(res.texB);
    gl.deleteFramebuffer(res.fboA);
    gl.deleteFramebuffer(res.fboB);
  }

  _drawQuad(built) {
    const gl = this.gl;
    gl.useProgram(built.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(built.aPos);
    gl.vertexAttribPointer(built.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Render one instance's current video frame through the pipeline into the
   * shared drawing buffer, then blit it onto the instance's display canvas.
   * Synchronous; the drawing buffer is read back (drawImage) in the same
   * task, so preserveDrawingBuffer can stay false.
   */
  render(client) {
    const gl = this.gl;
    const { video, options: o } = client;
    const w = client._renderWidth;
    const h = client._renderHeight;

    this.ensureSize(w, h);

    let res = client._glResources;
    if (!res || res.generation !== this.generation || res.w !== w || res.h !== h) {
      this.freeResources(res);
      res = client._glResources = this.createResources(w, h);
    }

    const programs = this.programs.get(o.channel);

    // Upload the current video frame. FLIP_Y makes texture v=1 the image
    // top, which every pass and the final blit assume.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.viewport(0, 0, w, h);

    const keyPass = (targetFbo) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      const p = programs.key;
      gl.useProgram(p.program);
      gl.uniform1i(p.uniforms.u_source, 0);
      gl.uniform1f(p.uniforms.u_minKey, o.minKey);
      gl.uniform1f(p.uniforms.u_bias, o.bias);
      gl.uniform1f(p.uniforms.u_softness, o.softness);
      gl.uniform1f(p.uniforms.u_spill, o.spill);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, res.srcTex);
      this._drawQuad(p);
    };

    if (o.edgeDissolve) {
      keyPass(res.fboA);

      // Horizontal blur: texA -> texB.
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.fboB);
      const pb = programs.blurH;
      gl.useProgram(pb.program);
      gl.uniform1i(pb.uniforms.u_source, 0);
      gl.uniform1f(pb.uniforms.u_texel, 1 / w);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, res.texA);
      this._drawQuad(pb);

      // Composite (finishes vertical blur inline): texA + texB -> screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      const pc = programs.composite;
      gl.useProgram(pc.program);
      gl.uniform1i(pc.uniforms.u_sharp, 0);
      gl.uniform1i(pc.uniforms.u_blur, 1);
      gl.uniform1f(pc.uniforms.u_texel, 1 / h);
      gl.uniform1f(pc.uniforms.u_fadeTop, o.fadeTop);
      gl.uniform1f(pc.uniforms.u_fadeBottom, o.fadeBottom);
      gl.uniform1f(pc.uniforms.u_blurStrength, o.blurStrength);
      gl.uniform1f(pc.uniforms.u_desat, o.desaturate);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, res.texA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, res.texB);
      this._drawQuad(pc);
    } else {
      // Fast path: key straight to the drawing buffer, one pass total.
      keyPass(null);
    }

    // Blit onto the instance's 2D display canvas. GL row 0 is the bottom of
    // the drawing buffer, so our w×h viewport sits at the bottom-left —
    // in drawImage's top-left coordinates that's y = bufferHeight - h.
    const ctx = client._displayCtx;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
  }
}

function getSharedEngine() {
  if (!sharedEngine) sharedEngine = new GLEngine();
  return sharedEngine;
}

/**
 * Syncs `target.style.aspectRatio` to `video`'s native size, unless the
 * caller has since set their own value. `state` (the owning instance) holds
 * the last value this function itself wrote, so a real resolution change
 * (WebRTC renegotiation, adaptive bitrate) re-applies on every call — while
 * an explicit user override, which never matches the last-applied value, is
 * left untouched. See issue #2.
 */
function syncAspectRatio(target, video, state) {
  if (!video.videoWidth || !video.videoHeight) return;
  const current = target.style.aspectRatio;
  if (current && current !== state._lastAppliedAspect) return;
  const next = `${video.videoWidth} / ${video.videoHeight}`;
  if (next === current) return;
  target.style.aspectRatio = next;
  state._lastAppliedAspect = next;
}

/* ════════════════════════════════════════════════════════════════════════
 * ChromaKeyVideo — the public player class
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Keys a video onto a transparent canvas in real time.
 *
 * Emits (as an EventTarget):
 * - `'backend'` — detail: `'webgl' | 'canvas2d'`, fired when the render
 *   backend is decided (first frame) or changes (context loss).
 * - `'started'` — fired once, after the first frame has been rendered.
 * - `'error'`  — detail: the underlying error (e.g. video load failure).
 * - `'autotune'` — detail: the result object of every {@link autoTune} run.
 * - `'pluginerror'` — detail: `{ plugin, error }`, fired when a plugin hook
 *   throws (the plugin is detached; the player keeps running).
 * - `'stalled'` — detail: `{ elapsedMs }`. Fired once when no new decoded
 *   frame has arrived for `options.stallTimeout` ms while playing (see
 *   issue #3). The canvas keeps showing the last good frame; the page
 *   decides what to do (spinner, reconnect, etc).
 * - `'recovered'` — detail: `{ elapsedMs }`. Fired once frame delivery
 *   resumes after a `'stalled'` event.
 */
export class ChromaKeyVideo extends EventTarget {
  /**
   * @param {HTMLVideoElement|MediaStream|string} source — an existing video
   *   element, a MediaStream (e.g. webcam/captureStream), or a video URL.
   *   URL/stream sources get a library-created video element (see
   *   `options.videoAttributes`). Cross-origin URLs must be served with
   *   CORS headers — the frame is read into a canvas.
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(source, options = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
    if (!CHANNEL_SWIZZLE[this.options.channel]) {
      throw new Error(`chroma-key-video: unknown channel "${this.options.channel}" (use "green" or "blue")`);
    }

    this._destroyed = false;
    this._ownsVideo = false;
    this._backend = null;          // 'webgl' | 'canvas2d', decided on first frame
    this._glResources = null;      // lives inside the shared engine's context
    this._workCanvas = null;       // CPU fallback scratch canvas
    this._rvfcHandle = 0;
    this._rafHandle = 0;
    this._started = false;
    /** Number of frames rendered so far. Useful for tests and diagnostics. */
    this.frameCount = 0;

    /** Attached plugins: name -> { plugin, ctx, timers, listeners }. */
    this._plugins = new Map();
    this._sampleCanvas = null;     // sampleFrame()/autoTune() scratch canvas

    this.video = this._resolveSource(source);

    /** The transparent output canvas. Style and place it like an <img>. */
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    this._displayCtx = this.canvas.getContext('2d');
    this._renderWidth = 2;
    this._renderHeight = 2;

    this._applyCssFade();

    // Track the canvas's CSS layout box; the render buffer follows it
    // (times devicePixelRatio), never the video's native resolution.
    this._resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this._onResize())
      : null;
    if (this._resizeObserver) this._resizeObserver.observe(this.canvas);

    this._lastAppliedAspect = '';

    this._onVideoEvent = (e) => {
      if (e.type === 'loadedmetadata' || e.type === 'resize') this._applyAspect();
      // Paint paused/seeked frames too — rVFC only fires during playback.
      if (e.type === 'loadeddata' || e.type === 'seeked') this.renderFrame();
      if (e.type === 'error') {
        this.dispatchEvent(new CustomEvent('error', { detail: this.video.error }));
      }
    };
    for (const type of ['loadedmetadata', 'resize', 'loadeddata', 'seeked', 'error']) {
      this.video.addEventListener(type, this._onVideoEvent);
    }
    if (this.video.readyState >= 1) this._applyAspect();
    if (this.video.readyState >= 2) this.renderFrame();

    this._startLoop();

    this._lastFrameQualityCount = -1;
    this._stallStartedAt = 0;
    this._isStalled = false;
    this._stallWatchdog = setInterval(() => this._checkStall(), STALL_CHECK_INTERVAL_MS);

    if (this.options.autoTune) {
      this.use(autoTunePlugin({ adaptive: this.options.autoTune === 'adaptive' }));
    }
  }

  /** True when WebGL is available in this browser/environment. */
  static isWebGLAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl', { alpha: true });
    } catch {
      return false;
    }
  }

  /** The active render backend: 'webgl', 'canvas2d', or null before the first frame. */
  get backend() { return this._backend; }

  get isDestroyed() { return this._destroyed; }

  /** Append the output canvas to a parent element. Returns `this` for chaining. */
  mount(parent) {
    parent.appendChild(this.canvas);
    this._onResize();
    return this;
  }

  /**
   * Update keying/pipeline options live. Takes effect on the next rendered
   * frame (immediately if the video is paused). `channel`, `forceCanvas2D`,
   * `videoAttributes` and `autoTune` are fixed at construction.
   */
  update(partial) {
    for (const key of IMMUTABLE_OPTIONS) {
      if (key in partial && partial[key] !== this.options[key]) {
        throw new Error(`chroma-key-video: option "${key}" can only be set at construction`);
      }
    }
    Object.assign(this.options, partial);
    this._applyCssFade();
    this.renderFrame();
    return this;
  }

  /** Start playback. Returns the video's play() promise. */
  play() { return this.video.play(); }

  /** Pause playback. The last rendered frame stays on the canvas. */
  pause() { this.video.pause(); }

  /**
   * Render the current video frame once, immediately. The playback loop
   * calls this automatically; call it yourself after seeking while paused
   * or after changing the canvas layout outside of ResizeObserver's reach.
   */
  renderFrame() {
    if (this._destroyed || this.video.readyState < 2 || !this.video.videoWidth) return;
    this._updateRenderSize();

    if (!this.options.forceCanvas2D && this._tryRenderWebGL()) {
      this._setBackend('webgl');
    } else {
      this._renderCanvas2D();
      this._setBackend('canvas2d');
    }

    this.frameCount++;
    if (!this._started) {
      this._started = true;
      this.dispatchEvent(new CustomEvent('started'));
    }

    if (this._plugins.size) {
      const info = {
        frameCount: this.frameCount,
        backend: this._backend,
        width: this._renderWidth,
        height: this._renderHeight,
      };
      for (const entry of this._plugins.values()) {
        if (entry.plugin.frame) this._runHook(entry, entry.plugin.frame, info);
      }
    }
  }

  /**
   * Attach a plugin: `{name, attach?(ctx), frame?(ctx, info), detach?(ctx)}`.
   *
   * Plugins see the player only through a context facade (options copy,
   * `update`, `autoTune`, `sampleFrame`, managed timers/listeners, events)
   * — never the render internals, so a plugin can't corrupt the pipeline.
   * Every hook runs in a try/catch: a throwing plugin is detached and
   * disabled while the player keeps rendering, and a `'pluginerror'` event
   * reports it (`detail: {plugin, error}`).
   *
   * The `frame` hook receives `{frameCount, backend, width, height}` after
   * each rendered frame. With no plugins attached the render loop pays
   * nothing for the plugin system.
   *
   * @returns {this}
   */
  use(plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
      throw new Error('chroma-key-video: a plugin needs a string "name"');
    }
    if (this._destroyed) {
      throw new Error('chroma-key-video: player is destroyed');
    }
    if (this._plugins.has(plugin.name)) {
      throw new Error(`chroma-key-video: plugin "${plugin.name}" is already attached`);
    }
    const entry = { plugin, timers: new Set(), listeners: [] };
    entry.ctx = this._createPluginContext(entry);
    this._plugins.set(plugin.name, entry);
    if (plugin.attach) this._runHook(entry, plugin.attach);
    return this;
  }

  /**
   * Detach a plugin by name: its `detach` hook runs, and all timers and
   * listeners it created through the context are cleaned up.
   *
   * @returns {boolean} false when no plugin with that name is attached.
   */
  unuse(name) {
    const entry = this._plugins.get(name);
    if (!entry) return false;
    this._removePlugin(entry);
    return true;
  }

  /**
   * Read one downscaled RGBA frame of the source video. Plugin/diagnostic
   * API — also feeds {@link autoTune}. Uses a small dedicated 2D canvas so
   * the GL pipeline is never stalled by a pixel readback.
   *
   * @param {{maxPixels?: number}} [opts] — pixel budget for the sample
   *   (default 128×72 ≈ 9k pixels). The sample keeps the video's aspect
   *   ratio within the budget.
   * @returns {ImageData|null} null before the first decodable frame, or
   *   when the video is cross-origin without CORS (tainted canvas).
   */
  sampleFrame({ maxPixels = 128 * 72 } = {}) {
    const video = this.video;
    if (this._destroyed || video.readyState < 2 || !video.videoWidth) return null;
    const scale = Math.min(1, Math.sqrt(maxPixels / (video.videoWidth * video.videoHeight)));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!this._sampleCanvas) {
      this._sampleCanvas = document.createElement('canvas');
      this._sampleCtx = this._sampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this._sampleCanvas.width !== w || this._sampleCanvas.height !== h) {
      this._sampleCanvas.width = w;
      this._sampleCanvas.height = h;
    }
    this._sampleCtx.drawImage(video, 0, 0, w, h);
    try {
      return this._sampleCtx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
  }

  /**
   * Measure the current frame and fit `minKey`/`bias`/`softness` to the
   * footage (`spill` stays as configured). Synchronous and cheap (~1ms):
   * samples a ~9k-pixel downscale and derives thresholds from candidate
   * percentiles — see the module-level derivation notes.
   *
   * Fires an `'autotune'` event with the result as `detail`, then returns
   * it: `{ok: true, params, backgroundFraction, applied}` on success, or
   * `{ok: false, reason: 'not-ready' | 'unreadable' | 'no-background'}`.
   *
   * @param {{apply?: boolean, smoothing?: number, maxPixels?: number}} [opts]
   *   - `apply`: write the derived params via `update()` (default true).
   *   - `smoothing`: 0-1 blend toward the current values (0 jumps straight
   *     to the measurement; the adaptive plugin passes 0.5 for stability).
   *   - `maxPixels`: sample budget, see {@link sampleFrame}.
   */
  autoTune({ apply = true, smoothing = 0, maxPixels = 128 * 72 } = {}) {
    const image = this.sampleFrame({ maxPixels });
    let result;
    if (!image) {
      result = { ok: false, reason: this.video.readyState < 2 || !this.video.videoWidth ? 'not-ready' : 'unreadable' };
    } else {
      result = deriveKeyParams(image, this.options.channel);
    }

    if (result.ok && apply) {
      const o = this.options;
      const p = { ...result.params };
      if (smoothing > 0) {
        p.minKey = Math.round(o.minKey * smoothing + p.minKey * (1 - smoothing));
        p.bias = Math.round((o.bias * smoothing + p.bias * (1 - smoothing)) * 100) / 100;
        p.softness = Math.round(o.softness * smoothing + p.softness * (1 - smoothing));
      }
      // Skip no-op updates so the adaptive plugin idles once converged.
      const changed = Math.abs(p.minKey - o.minKey) >= 2
        || Math.abs(p.bias - o.bias) >= 0.01
        || Math.abs(p.softness - o.softness) >= 2;
      if (changed) this.update(p);
      result = { ...result, params: p, applied: changed };
    }

    this.dispatchEvent(new CustomEvent('autotune', { detail: result }));
    return result;
  }

  /**
   * Stop rendering and release all resources (GPU textures, observers,
   * video listeners). A library-created video element is also stopped and
   * released. The engine's shared WebGL context is released when the last
   * instance on the page is destroyed.
   *
   * @param {{removeCanvas?: boolean}} [opts] — also detach the output
   *   canvas from the DOM (default true).
   */
  destroy({ removeCanvas = true } = {}) {
    if (this._destroyed) return;
    this._destroyed = true;

    for (const entry of [...this._plugins.values()]) this._removePlugin(entry);

    if (this._rvfcHandle && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._rvfcHandle);
    }
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    if (this._stallWatchdog) clearInterval(this._stallWatchdog);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    for (const type of ['loadedmetadata', 'resize', 'loadeddata', 'seeked', 'error']) {
      this.video.removeEventListener(type, this._onVideoEvent);
    }

    if (sharedEngine) {
      sharedEngine.freeResources(this._glResources);
      sharedEngine.unregister(this);
    }
    this._glResources = null;
    this._workCanvas = null;

    if (this._ownsVideo) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.srcObject = null;
      this.video.load();
    }
    if (removeCanvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  /** Build the isolation facade one plugin sees. */
  _createPluginContext(entry) {
    const self = this;
    return Object.freeze({
      /** The source <video> (read playback state; controlling playback is fine). */
      get video() { return self.video; },
      /** The output canvas (read/measure; the render pipeline owns its pixels). */
      get canvas() { return self.canvas; },
      get backend() { return self._backend; },
      get isDestroyed() { return self._destroyed; },
      /** Copy of the current options — change them via update(). */
      getOptions: () => ({ ...self.options }),
      update: (partial) => { self.update(partial); },
      autoTune: (opts) => self.autoTune(opts),
      sampleFrame: (opts) => self.sampleFrame(opts),
      requestRender: () => { self.renderFrame(); },
      /** Managed interval, auto-cleared on detach/destroy. Returns a cancel fn. */
      every(ms, fn) {
        const id = setInterval(() => {
          if (self._destroyed) { clearInterval(id); return; }
          try { fn(); } catch (err) { self._removePlugin(entry, err); }
        }, ms);
        entry.timers.add(id);
        return () => { clearInterval(id); entry.timers.delete(id); };
      },
      /** Managed player-event listener, auto-removed on detach/destroy. Returns an off fn. */
      on(type, fn, opts) {
        self.addEventListener(type, fn, opts);
        entry.listeners.push([type, fn]);
        return () => self.removeEventListener(type, fn);
      },
      /** Dispatch a CustomEvent on the player (namespace your own event types). */
      emit(type, detail) {
        self.dispatchEvent(new CustomEvent(type, { detail }));
      },
    });
  }

  /** Run a plugin hook; a throw disables the plugin instead of breaking the player. */
  _runHook(entry, hook, info) {
    try {
      hook.call(entry.plugin, entry.ctx, info);
    } catch (err) {
      this._removePlugin(entry, err);
    }
  }

  /** Detach a plugin: clear its timers/listeners, run detach, report a hook error if any. */
  _removePlugin(entry, error) {
    this._plugins.delete(entry.plugin.name);
    for (const id of entry.timers) clearInterval(id);
    entry.timers.clear();
    for (const [type, fn] of entry.listeners) this.removeEventListener(type, fn);
    entry.listeners.length = 0;
    if (entry.plugin.detach) {
      try { entry.plugin.detach(entry.ctx); } catch { /* already detaching */ }
    }
    if (error) {
      this.dispatchEvent(new CustomEvent('pluginerror', {
        detail: { plugin: entry.plugin.name, error },
      }));
    }
  }

  _resolveSource(source) {
    if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
      return source;
    }
    const video = document.createElement('video');
    this._ownsVideo = true;
    const attrs = this.options.videoAttributes;
    video.muted = attrs.muted;
    video.loop = attrs.loop;
    video.autoplay = attrs.autoplay;
    video.playsInline = attrs.playsInline;
    if (attrs.crossOrigin) video.crossOrigin = attrs.crossOrigin;
    if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
      video.srcObject = source;
      if (attrs.autoplay) video.play().catch(() => {});
    } else if (typeof source === 'string') {
      video.src = source;
    } else {
      throw new Error('chroma-key-video: source must be a video element, MediaStream, or URL string');
    }
    return video;
  }

  /** Syncs the canvas's aspect ratio to the video's native size. See {@link syncAspectRatio}. */
  _applyAspect() {
    syncAspectRatio(this.canvas, this.video, this);
  }

  /**
   * Watchdog tick: fires `'stalled'`/`'recovered'` off decoded-frame progress
   * (see `options.stallTimeout`). Uses `getVideoPlaybackQuality()` rather
   * than `currentTime` — for a live MediaStream, `currentTime` keeps
   * advancing on the stream's own clock even when no new frame is decoded,
   * so it would miss exactly the stall this exists to catch. See issue #3.
   */
  _checkStall() {
    const timeout = this.options.stallTimeout;
    if (!timeout || timeout <= 0) return;
    if (typeof this.video.getVideoPlaybackQuality !== 'function') return;
    if (this.video.paused || this.video.ended) {
      this._stallStartedAt = 0;
      return;
    }

    const count = this.video.getVideoPlaybackQuality().totalVideoFrames;
    if (count !== this._lastFrameQualityCount) {
      this._lastFrameQualityCount = count;
      this._stallStartedAt = 0;
      if (this._isStalled) {
        this._isStalled = false;
        this.dispatchEvent(new CustomEvent('recovered', { detail: { elapsedMs: this._stalledElapsedMs } }));
      }
      return;
    }

    if (!this._stallStartedAt) {
      this._stallStartedAt = Date.now();
      return;
    }
    const elapsedMs = Date.now() - this._stallStartedAt;
    if (elapsedMs >= timeout && !this._isStalled) {
      this._isStalled = true;
      this._stalledElapsedMs = elapsedMs;
      this.dispatchEvent(new CustomEvent('stalled', { detail: { elapsedMs } }));
    }
  }

  /** Redundant DOM-level bottom fade (defense in depth alongside the shader fade). */
  _applyCssFade() {
    const wanted = this.options.edgeDissolve && this.options.cssFade && this.options.fadeBottom > 0;
    const value = wanted
      ? 'linear-gradient(0deg, transparent 0, rgba(0,0,0,.5) 2%, #000 5%, #000)'
      : '';
    this.canvas.style.maskImage = value;
    this.canvas.style.webkitMaskImage = value;
    if (wanted) {
      this.canvas.style.maskRepeat = 'no-repeat';
      this.canvas.style.maskSize = '100% 100%';
    }
  }

  /**
   * Size the render buffer from the canvas's CSS layout box × capped
   * devicePixelRatio (falling back to the video's native size before the
   * canvas has a layout). Scaling is the only geometry in the pipeline —
   * the shaders stretch the full frame across the full canvas.
   */
  _updateRenderSize() {
    let w = 0;
    let h = 0;
    if (this.canvas.isConnected) {
      const rect = this.canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
    }
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.options.maxPixelRatio);
    w = Math.round(w * dpr);
    h = Math.round(h * dpr);
    if (!w || !h) {
      w = this.video.videoWidth;
      h = this.video.videoHeight;
    }
    const maxDim = sharedEngine ? sharedEngine.maxTextureSize : 4096;
    w = clamp(w, 1, maxDim);
    h = clamp(h, 1, maxDim);
    if (w !== this._renderWidth || h !== this._renderHeight) {
      this._renderWidth = w;
      this._renderHeight = h;
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _setBackend(name) {
    if (this._backend !== name) {
      this._backend = name;
      this.dispatchEvent(new CustomEvent('backend', { detail: name }));
    }
  }

  /** @returns {boolean} true when the frame was rendered on the GPU. */
  _tryRenderWebGL() {
    let engine;
    try {
      engine = getSharedEngine();
    } catch {
      return false; // WebGL unavailable — caller falls back to Canvas2D
    }
    if (engine.contextLost) return false; // temporary — CPU renders until restore
    engine.register(this);
    try {
      engine.render(this);
      return true;
    } catch (err) {
      if (engine.gl.isContextLost()) return false;
      throw err;
    }
  }

  /**
   * CPU fallback. Line-for-line the same classification math as the key
   * shader, over ImageData bytes. Differences by construction:
   * - output stays straight (un-premultiplied) alpha — that is what
   *   putImageData expects; the canvas premultiplies internally.
   * - processing runs at a capped resolution (`maxCPUPixels`) and is
   *   scaled up on the final draw, keeping the per-frame loop affordable.
   * - edgeDissolve degrades gracefully: fade ramps apply (per row), the
   *   Gaussian/vignette blend does not.
   */
  _renderCanvas2D() {
    const o = this.options;
    const outW = this._renderWidth;
    const outH = this._renderHeight;

    const scale = Math.min(1, Math.sqrt(o.maxCPUPixels / (outW * outH)));
    const w = Math.max(1, Math.round(outW * scale));
    const h = Math.max(1, Math.round(outH * scale));

    if (!this._workCanvas) {
      this._workCanvas = document.createElement('canvas');
      this._workCtx = this._workCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this._workCanvas.width !== w || this._workCanvas.height !== h) {
      this._workCanvas.width = w;
      this._workCanvas.height = h;
    }

    this._workCtx.drawImage(this.video, 0, 0, w, h);
    let image;
    try {
      image = this._workCtx.getImageData(0, 0, w, h);
    } catch (err) {
      // Tainted canvas (cross-origin video without CORS) — surface it.
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      return;
    }
    const d = image.data;
    const [ki, ai, bi] = CHANNEL_OFFSETS[o.channel];
    const minKey = o.minKey;
    const bias = o.bias;
    const softDenominator = Math.max(8, o.softness * 0.55);
    const spill = o.spill;
    const fades = o.edgeDissolve ? this._rowFades(h) : null;

    for (let y = 0; y < h; y++) {
      const rowFade = fades ? fades[y] : 1;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const key = d[i + ki];
        const oA = d[i + ai];
        const oB = d[i + bi];

        const maxC = Math.max(key, oA, oB);
        const minC = Math.min(key, oA, oB);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        const dom = key - Math.max(oA, oB);

        if (key >= maxC && key > minKey
            && key > oA * bias && key > oB * bias
            && sat > 0.08 && dom > 2) {
          const keyed = clamp((dom - 2) / softDenominator + (sat - 0.08) * 1.8, 0, 1);
          d[i + 3] = d[i + 3] * (1 - keyed);
          d[i + ki] = Math.max(oA, oB);
        } else if (dom > 4 && key > 40) {
          const despill = Math.min(Math.max(1, spill), spill * (1 + dom / 32));
          d[i + ki] = Math.max(0, key - dom * despill);
        }
        if (rowFade !== 1) d[i + 3] *= rowFade;
      }
    }

    this._workCtx.putImageData(image, 0, 0);
    const ctx = this._displayCtx;
    ctx.clearRect(0, 0, outW, outH);
    ctx.drawImage(this._workCanvas, 0, 0, w, h, 0, 0, outW, outH);
  }

  /** Per-row fade multipliers matching the composite shader's ramps (row 0 = top). */
  _rowFades(h) {
    const { fadeTop, fadeBottom } = this.options;
    const fades = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      const v = 1 - (y + 0.5) / h; // 0 = bottom, 1 = top, like v_uv.y
      let fade = 1;
      if (fadeBottom > 0) fade *= smoothstep(0, fadeBottom, v);
      if (fadeTop > 0) fade *= 1 - smoothstep(1 - fadeTop, 1, v);
      fades[y] = fade;
    }
    return fades;
  }

  /**
   * Frame-driven render loop. Prefers requestVideoFrameCallback (fires
   * exactly once per presented frame, stays idle while paused/hidden);
   * falls back to requestAnimationFrame gated on playback state.
   */
  _startLoop() {
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        if (this._destroyed) return;
        this.renderFrame();
        this._rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
      };
      this._rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
    } else {
      const tick = () => {
        if (this._destroyed) return;
        if (!this.video.paused && !this.video.ended) this.renderFrame();
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }
  }

  _onResize() {
    if (this._destroyed) return;
    // Re-render immediately so a paused frame doesn't stay at a stale size.
    this.renderFrame();
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Built-in plugins
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Plugin that fits `minKey`/`bias`/`softness` to the footage. This is what
 * the `autoTune` constructor option attaches; use it directly for control
 * over the interval, smoothing, and sample budget.
 *
 * Tunes once as soon as a frame is available. With `adaptive: true` it keeps
 * re-tuning every `interval` ms while the video plays, blending each result
 * into the current options by `smoothing` so lighting changes are followed
 * without visible parameter jumps.
 *
 * @param {object} [options]
 * @param {boolean} [options.adaptive=false] — keep re-tuning during playback.
 * @param {number} [options.interval=1500] — ms between adaptive runs.
 * @param {number} [options.smoothing=0.5] — EMA weight of the previous values
 *   for adaptive runs (0 = jump straight to each new result).
 * @param {number} [options.maxPixels=9216] — analysis budget per run.
 * @returns a plugin for {@link ChromaKeyVideo#use}
 */
export function autoTunePlugin({
  adaptive = false,
  interval = 1500,
  smoothing = 0.5,
  maxPixels = 128 * 72,
} = {}) {
  return {
    name: 'autoTune',
    attach(ctx) {
      if (ctx.video.readyState >= 2) {
        ctx.autoTune({ maxPixels });
      } else {
        ctx.on('started', () => ctx.autoTune({ maxPixels }), { once: true });
      }
      if (adaptive) {
        ctx.every(interval, () => {
          if (!ctx.video.paused && !ctx.video.ended) {
            ctx.autoTune({ maxPixels, smoothing });
          }
        });
      }
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * <chroma-key-video> custom element
 *
 * A closed-shadow-DOM wrapper around ChromaKeyVideo: style-isolated from
 * the host page, but rendered unboxed (no iframe frame). Attributes map to
 * constructor options; numeric attributes update live.
 * ════════════════════════════════════════════════════════════════════════ */

/** attribute name -> [option key, parser] */
const ELEMENT_OPTION_ATTRIBUTES = {
  'channel': ['channel', String],
  'min-key': ['minKey', Number],
  'bias': ['bias', Number],
  'softness': ['softness', Number],
  'spill': ['spill', Number],
  'edge-dissolve': ['edgeDissolve', (v) => v !== null && v !== 'false'],
  'auto-tune': ['autoTune', (v) => (v === 'adaptive' ? 'adaptive' : true)],
  'fade-top': ['fadeTop', Number],
  'fade-bottom': ['fadeBottom', Number],
  'max-pixel-ratio': ['maxPixelRatio', Number],
  'stall-timeout': ['stallTimeout', Number],
};

/**
 * Register the `<chroma-key-video>` custom element.
 *
 * Source: either a slotted `<video>` child (any source the video element
 * itself supports — file, MediaStream via `srcObject`, WebRTC, hls.js/
 * dash.js-attached, etc.) or the `src` attribute (a plain URL). A slotted
 * video takes precedence over `src` when both are present. Swapping the
 * slotted `<video>` at runtime rebuilds the player; the slotted element is
 * caller-owned throughout, so `destroy()`/disconnection never pauses or
 * clears it (see issue #6).
 *
 * Other supported attributes: `autoplay`, `loop`, `muted`, `channel`,
 * `min-key`, `bias`, `softness`, `spill`, `edge-dissolve`,
 * `auto-tune` (empty = once, `"adaptive"` = continuous), `fade-top`,
 * `fade-bottom`, `max-pixel-ratio`, `stall-timeout`. `autoplay`/`loop`/
 * `muted`/`crossorigin` only affect a video the element creates itself
 * (from `src`) — a slotted `<video>` is caller-owned and caller-configured,
 * so these attributes have no effect on it.
 *
 * The underlying player is exposed as the element's `.player` property for
 * full programmatic control (events, `update()`, the video element, etc.).
 *
 * @param {string} [tagName='chroma-key-video']
 */
export function defineChromaKeyVideoElement(tagName = 'chroma-key-video') {
  if (customElements.get(tagName)) return;

  class ChromaKeyVideoElement extends HTMLElement {
    static observedAttributes = ['src', ...Object.keys(ELEMENT_OPTION_ATTRIBUTES)];

    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{display:inline-block;line-height:0}canvas{display:block;width:100%;height:100%}::slotted(*){display:none}';
      this._root.appendChild(style);
      this._slot = document.createElement('slot');
      this._slot.addEventListener('slotchange', () => this._handleSlotChange());
      this._root.appendChild(this._slot);
      this._activeVideoSource = null;
      this._player = null;
    }

    /** The underlying ChromaKeyVideo instance (null before connection). */
    get player() { return this._player; }

    connectedCallback() { this._build(); }

    disconnectedCallback() { this._teardown(); }

    /** First slotted light-DOM <video> child, or null. */
    _getSlottedVideo() {
      for (const child of this.children) {
        if (child instanceof HTMLVideoElement) return child;
      }
      return null;
    }

    _handleSlotChange() {
      if (!this.isConnected) return;
      const newVideo = this._getSlottedVideo();
      if (newVideo === this._activeVideoSource) return;
      this._teardown();
      this._build();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this.isConnected || oldValue === newValue) return;
      if (name === 'src') {
        // A slotted video (if present) always wins over src (see _build()),
        // so a src change is a no-op while one is active — rebuilding here
        // would destroy and recreate the player against the same source.
        if (this._getSlottedVideo()) return;
        this._teardown();
        this._build();
        return;
      }
      const mapping = ELEMENT_OPTION_ATTRIBUTES[name];
      if (mapping && this._player) {
        const [key, parse] = mapping;
        // Construction-only options rebuild the player.
        if (key === 'channel' || key === 'autoTune') {
          this._teardown();
          this._build();
        } else {
          this._player.update({ [key]: parse(newValue) });
        }
      }
    }

    _collectOptions() {
      const options = {
        videoAttributes: {
          ...DEFAULTS.videoAttributes,
          muted: this.hasAttribute('muted') || this.hasAttribute('autoplay'),
          loop: this.hasAttribute('loop'),
          autoplay: this.hasAttribute('autoplay'),
        },
      };
      for (const [attr, [key, parse]] of Object.entries(ELEMENT_OPTION_ATTRIBUTES)) {
        if (this.hasAttribute(attr)) options[key] = parse(this.getAttribute(attr));
      }
      return options;
    }

    _build() {
      const slottedVideo = this._getSlottedVideo();
      const source = slottedVideo || this.getAttribute('src');
      if (!source) return;
      this._activeVideoSource = slottedVideo;
      this._player = new ChromaKeyVideo(source, this._collectOptions());
      this._root.appendChild(this._player.canvas);
      this._lastAppliedAspect = '';
      this._syncAspect = () => syncAspectRatio(this, this._player.video, this);
      this._player.video.addEventListener('loadedmetadata', this._syncAspect);
      this._player.video.addEventListener('resize', this._syncAspect);
    }

    _teardown() {
      if (this._player) {
        this._player.video.removeEventListener('loadedmetadata', this._syncAspect);
        this._player.video.removeEventListener('resize', this._syncAspect);
        this._syncAspect = null;
        this._player.destroy();
        this._player = null;
      }
      this._activeVideoSource = null;
    }
  }

  customElements.define(tagName, ChromaKeyVideoElement);
}
