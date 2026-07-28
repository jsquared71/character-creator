import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ---------------------------------------------------------------------------
 * TONE MAPPING: applied EXACTLY ONCE, by OutputPass. Do not "fix" this.
 *
 * `renderer.js` sets `renderer.toneMapping = ACESFilmicToneMapping`. That looks
 * like it would collide with `OutputPass`, which tone maps as well — but it
 * does not, and the reason is worth writing down because it decides the whole
 * pass order below.
 *
 * In the vendored three r180 (`vendor/three/three.module.js`, WebGLRenderer /
 * WebGLPrograms), the per-material tone mapping define is chosen like this:
 *
 *     let toneMapping = NoToneMapping;
 *     if ( material.toneMapped ) {
 *         if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {
 *             toneMapping = renderer.toneMapping;
 *         }
 *     }
 *
 * i.e. scene materials only tone map when drawing straight to the default
 * framebuffer. `RenderPass` draws into an `EffectComposer` render target, so
 * the scene lands in that buffer *linear and HDR* — untone-mapped, unencoded
 * (the composer's targets are HalfFloat / NoColorSpace). Exactly what we want:
 * AO and bloom are physically meaningful only on linear HDR data, and bloom's
 * luminance threshold is only a sane knob if values above 1.0 still exist.
 *
 * `OutputPass` then reads `renderer.toneMapping` / `renderer.outputColorSpace`
 * at render time (see its `render()`) and does ACES + sRGB encode itself, in a
 * RawShaderMaterial. So: one tone map, at the end of the HDR section.
 *
 * The corollary — and this is why the chain is not in the naive order — is
 * that `OutputPass` must sit *before* the passes that want display-referred
 * sRGB input. Its own doc comment says so: "If a pass requires sRGB input
 * (e.g. like FXAA), the pass must follow OutputPass in the pass chain."
 *
 *   RenderPass -> GTAO -> UnrealBloom      (linear HDR — correct for AO/bloom)
 *   -> OutputPass                          (ACES + sRGB, once)
 *   -> SMAA                                (needs sRGB luma for edge detection)
 *   -> look pass: vignette + CA + grain    (display space, and after AA)
 *
 * Two deliberate deviations from a literal "SMAA then OutputPass" reading:
 *
 *  1. SMAA after OutputPass. SMAA thresholds luma to find edges. Fed linear
 *     HDR it either misses everything in the shadows or treats every specular
 *     pixel as an edge. Fed sRGB it behaves the way it was designed to.
 *  2. The grain/vignette/CA pass last, after SMAA. Grain is a fixed ±N/255
 *     offset — that is only a meaningful, uniform amount in display space; in
 *     linear HDR the same number is invisible on a highlight and catastrophic
 *     in a shadow. And animated grain placed *before* SMAA makes SMAA chase
 *     the noise, so its edge blends flicker frame to frame. Grain belongs on
 *     top, the way film stock does.
 *
 * Because the renderer must keep tone mapping enabled for `OutputPass` to pick
 * it up, this module does not clear `renderer.toneMapping`; it only re-asserts
 * ACES if something upstream disabled it (see `createPostChain`).
 * ------------------------------------------------------------------------ */

/**
 * Vignette + radial chromatic aberration + animated filmic grain.
 *
 * Runs in display-referred sRGB (post `OutputPass`). All three effects are
 * tuned for "you notice it when it is switched off", not for "look at my
 * post stack".
 */
const FilmicLookShader = {
  name: 'FilmicLookShader',

  uniforms: {
    tDiffuse: { value: null },
    /** Framebuffer size in *device* pixels, so 1px means 1px on the panel. */
    resolution: { value: new THREE.Vector2(1, 1) },
    /** Seconds, advanced by render(dt). Reseeds the grain lattice each frame. */
    time: { value: 0 },
    /** Peak grain deviation in display units. 0.02 ~= 5/255. */
    grainAmount: { value: 0.02 },
    /** How hard grain is suppressed in the deep blacks and the highlights. */
    grainResponse: { value: 0.75 },
    /** Fraction of the grain that is chroma rather than luma. */
    grainChroma: { value: 0.2 },
    /** Half of the R/B separation, in pixels, at the extreme corner. */
    caAmount: { value: 0.5 },
    /** Peak corner darkening, 0..1. */
    vignetteAmount: { value: 0.28 },
    /** Normalised radius (1.0 = corner) where the vignette starts. */
    vignetteInner: { value: 0.35 }
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  resolution;
    uniform float time;
    uniform float grainAmount;
    uniform float grainResponse;
    uniform float grainChroma;
    uniform float caAmount;
    uniform float vignetteAmount;
    uniform float vignetteInner;

    varying vec2 vUv;

    // Cheap, well-distributed 2D hash. Two of these summed give a triangular
    // PDF, which is what makes the grain read as film rather than as salt.
    float hash21( vec2 p ) {
      p = fract( p * vec2( 443.8975, 397.2973 ) );
      p += dot( p, p.yx + 19.19 );
      return fract( ( p.x + p.y ) * p.x );
    }

    void main() {
      vec2 texel = 1.0 / max( resolution, vec2( 1.0 ) );

      // Aspect-corrected radial coordinate, normalised so the corner is 1.0.
      vec2  centred = vUv - 0.5;
      float aspect  = resolution.x / max( resolution.y, 1.0 );
      vec2  radial  = vec2( centred.x * aspect, centred.y );
      float rNorm   = length( radial ) / length( vec2( 0.5 * aspect, 0.5 ) );

      // --- chromatic aberration -------------------------------------------
      // Purely radial and quadratic, so the centre of frame (the face, in a
      // hero shot) is untouched and only the corners fringe. caAmount is the
      // half-separation, so R->B is ~1px apart at the extreme corner.
      float len  = length( centred );
      vec2  dirN = centred / max( len, 1e-5 );
      vec2  off  = dirN * ( caAmount * rNorm * rNorm ) * texel;

      vec4  mid  = texture2D( tDiffuse, vUv );
      vec3  color;
      color.r = texture2D( tDiffuse, clamp( vUv + off, vec2( 0.0 ), vec2( 1.0 ) ) ).r;
      color.g = mid.g;
      color.b = texture2D( tDiffuse, clamp( vUv - off, vec2( 0.0 ), vec2( 1.0 ) ) ).b;

      // --- vignette ---------------------------------------------------------
      float vig = smoothstep( vignetteInner, 1.35, rNorm );
      color *= 1.0 - vignetteAmount * vig;

      // --- filmic grain -----------------------------------------------------
      // Locked to device pixels (gl_FragCoord), so grain stays the same
      // physical size regardless of window size or DPR, and reseeded every
      // frame from `time` via two irrational strides so it never cycles.
      vec2  fc = gl_FragCoord.xy;
      float t1 = fract( time * 0.6180339887 );
      float t2 = fract( time * 0.3819660113 + 0.5 );

      float n = hash21( fc      + vec2( t1 * 311.7, t2 * 197.3 ) )
              + hash21( fc.yx   + vec2( t2 * 419.1, t1 * 271.9 ) )
              - 1.0;                                   // triangular, [-1,1]
      float nc = hash21( fc * 1.37 + vec2( t2 * 133.7, t1 * 57.3 ) ) - 0.5;

      // Film grain lives in the mid-tones: 4l(1-l) peaks at 0.5 and dies at
      // both ends, so clipped whites and crushed blacks stay clean.
      float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
      float response = mix( 1.0, 4.0 * l * ( 1.0 - l ), grainResponse );

      vec3 grain = vec3( n ) + vec3( nc, -nc, nc * 0.5 ) * grainChroma;
      color += grain * grainAmount * response;

      gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), mid.a );
    }
  `
};

/**
 * Builds the post-processing chain for the character viewer.
 *
 * @param {Object} deps
 * @param {THREE.WebGLRenderer} deps.renderer
 * @param {THREE.Scene} deps.scene
 * @param {THREE.Camera} deps.camera
 * @param {Object} [deps.bakery] Unused — the grain is analytic so it needs no
 *   baked texture, which keeps it resolution-independent and DPR-correct.
 * @returns {{ composer: EffectComposer, render: (dt:number)=>void,
 *             resize: (w:number,h:number)=>void, setQuality: (q:string)=>void,
 *             dispose: ()=>void, passes: Object }}
 */
export function createPostChain({ renderer, scene, camera, bakery }) {
  // See the note at the top of the file. OutputPass reads renderer.toneMapping
  // at render time; if it is NoToneMapping the whole chain ships untone-mapped
  // linear light to the screen and every highlight clips to white. Scene
  // materials do NOT double-apply it because they render into a composer
  // target, not the default framebuffer.
  if (renderer.toneMapping === THREE.NoToneMapping) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  const composer = new EffectComposer(renderer);

  const initialSize = renderer.getSize(new THREE.Vector2());
  const pixelRatio0 = renderer.getPixelRatio();
  let cssWidth = Math.max(1, initialSize.x);
  let cssHeight = Math.max(1, initialSize.y);
  let lastPixelRatio = pixelRatio0;
  let quality = 'high';
  let grainTime = 0;

  const fullW0 = Math.max(1, Math.round(cssWidth * pixelRatio0));
  const fullH0 = Math.max(1, Math.round(cssHeight * pixelRatio0));

  // 1 ------------------------------------------------------------- scene ---
  const renderPass = new RenderPass(scene, camera);

  // 2 ---------------------------------------------------------------- AO ---
  // GTAO rather than SSAO: it is horizon-based, so it produces contact
  // darkening in creases (nostrils, under the chin, armour seams, the gap
  // under a pauldron) instead of the grey wash SSAO puts on curved surfaces.
  //
  // Tuning for a character close-up. The failure mode is a dark halo, so:
  //  - radius 0.085 m. The scene is in metres and the head is ~0.24 m across,
  //    so this is genuinely contact-scale occlusion. Big radii are what turn
  //    a silhouette into a halo.
  //  - thickness 0.3 keeps a foreground limb from occluding the torso behind
  //    it across a depth gap, which is the other halo source.
  //  - scale 1.0 (it is an exponent on the raw AO), with strength carried by
  //    blendIntensity 0.5 — i.e. the AO term is lerped halfway to white before
  //    it multiplies the beauty pass. Deliberately under-cooked.
  const aoPass = new GTAOPass(scene, camera, fullW0, fullH0);
  aoPass.output = GTAOPass.OUTPUT.Default;
  aoPass.blendIntensity = 0.5;
  aoPass.updateGtaoMaterial({
    radius: 0.085,
    distanceExponent: 1.6,
    thickness: 0.3,
    distanceFallOff: 1.0,
    scale: 1.0,
    samples: 16,
    screenSpaceRadius: false
  });
  // Denoise tight: a wide Poisson radius smears AO off the silhouette and back
  // onto the backdrop, which is precisely the halo we are avoiding.
  aoPass.updatePdMaterial({
    lumaPhi: 8.0,
    depthPhi: 2.0,
    normalPhi: 4.0,
    radius: 3.0,
    radiusExponent: 1.6,
    rings: 2,
    samples: 12
  });
  // Restrict AO to the volume the character actually occupies (plus the patch
  // of ground it stands on). Outside the box the GTAO shader fades AO to 1.0,
  // so the distant backdrop cannot pick up an occlusion rim from the
  // character. Generous enough for a 2.45 m Tauren with pauldrons and a cape.
  aoPass.setSceneClipBox(new THREE.Box3(
    new THREE.Vector3(-2.0, -0.05, -2.0),
    new THREE.Vector3(2.0, 3.4, 2.0)
  ));

  // 3 ------------------------------------------------------------- bloom ---
  // Threshold bloom on linear HDR. threshold 0.95 means "brighter than diffuse
  // white" — emissive runes, eye glow, the hot core of a key specular — and
  // nothing else. radius 0.2 keeps the mip blend tight so the glow hugs its
  // source instead of hazing the whole frame; strength 0.42 compensates for
  // how few pixels now qualify.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(fullW0, fullH0),
    0.42,  // strength
    0.2,   // radius
    0.95   // threshold (linear luminance)
  );

  // 4 ------------------------------------------- tone map + sRGB (ONCE) ----
  const outputPass = new OutputPass();

  // 5 ---------------------------------------------------------------- AA ---
  const smaaPass = new SMAAPass();

  // 6 -------------------------------------------------------------- look ---
  const lookPass = new ShaderPass(FilmicLookShader);
  const lookUniforms = lookPass.uniforms;

  composer.addPass(renderPass);
  composer.addPass(aoPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  composer.addPass(smaaPass);
  composer.addPass(lookPass);

  /**
   * Re-applies the quality-scaled sizes to every size-dependent pass.
   *
   * Must run *after* any `composer.setSize()`, because EffectComposer calls
   * `setSize(fullWidth, fullHeight)` on every pass indiscriminately and would
   * otherwise silently promote the half-res passes back to full res.
   */
  function applySizes() {
    const pr = renderer.getPixelRatio();
    const fullW = Math.max(1, Math.round(cssWidth * pr));
    const fullH = Math.max(1, Math.round(cssHeight * pr));

    const aoScale = quality === 'balanced' ? 0.5 : 1.0;
    const bloomScale = quality === 'performance' ? 0.5 : 1.0;

    if (aoPass.enabled) {
      aoPass.setSize(
        Math.max(1, Math.round(fullW * aoScale)),
        Math.max(1, Math.round(fullH * aoScale))
      );
    }
    bloomPass.setSize(
      Math.max(1, Math.round(fullW * bloomScale)),
      Math.max(1, Math.round(fullH * bloomScale))
    );
    smaaPass.setSize(fullW, fullH);
    lookUniforms.resolution.value.set(fullW, fullH);
  }

  applySizes();

  /**
   * @param {number} w CSS pixels
   * @param {number} h CSS pixels
   */
  function resize(w, h) {
    cssWidth = Math.max(1, Math.round(w) || 1);
    cssHeight = Math.max(1, Math.round(h) || 1);

    // The composer captures the pixel ratio at construction; keep it in sync
    // with the renderer so buffers stay at native device resolution.
    const pr = renderer.getPixelRatio();
    if (pr !== lastPixelRatio) {
      lastPixelRatio = pr;
      composer.setPixelRatio(pr);
    }

    // setSize() takes CSS pixels and multiplies by the composer's pixel ratio.
    composer.setSize(cssWidth, cssHeight);
    applySizes();
  }

  /**
   * @param {'high'|'balanced'|'performance'} q
   */
  function setQuality(q) {
    const next = (q === 'balanced' || q === 'performance') ? q : 'high';
    if (next === quality) return;
    quality = next;

    // 'performance' drops AO entirely; EffectComposer skips disabled passes,
    // which also skips the normal/depth G-buffer prepass it needs.
    aoPass.enabled = quality !== 'performance';

    if (aoPass.enabled) {
      // Fewer directions at half res — the denoise hides the loss.
      aoPass.updateGtaoMaterial({ samples: quality === 'high' ? 16 : 8 });
      aoPass.updatePdMaterial({ samples: quality === 'high' ? 12 : 8 });
    }

    applySizes();
  }

  /**
   * Draws the frame. Allocation-free: every value touched here already exists.
   *
   * @param {number} dt Seconds since the last frame.
   */
  function render(dt) {
    const step = dt > 0 ? dt : 0;

    grainTime += step;
    // Wrap well before float32 precision starts eating the fractional part,
    // otherwise the grain freezes after a long session.
    if (grainTime > 3600) grainTime -= 3600;
    lookUniforms.time.value = grainTime;

    composer.render(step);
  }

  function dispose() {
    composer.dispose();
    renderPass.dispose();
    aoPass.dispose();
    bloomPass.dispose();
    outputPass.dispose();
    smaaPass.dispose();
    lookPass.dispose();
  }

  return {
    composer,
    render,
    resize,
    setQuality,
    dispose,
    // Exposed for tuning/debug (e.g. aoPass.output = GTAOPass.OUTPUT.Denoise).
    passes: { renderPass, aoPass, bloomPass, outputPass, smaaPass, lookPass }
  };
}
