// Cinematic three-point rig + procedural IBL for the hero-select screen.
//
// The look: a warm key high and camera-left (the only shadow caster), a hard
// cool rim low and behind that peels the silhouette off the backdrop, and a
// dim warm-neutral bounce from below-front so the shadow side still reads.
// A subtle class-coloured practical sits behind the hip on the rim side.
//
// The image-based lighting is baked, not loaded: an equirectangular
// "ruined stone hall at dusk" is rendered by the Bakery in an RGBM-ish
// encoding, expanded to a half-float HDR buffer, then run through
// PMREMGenerator. That gives real >1.0 radiance in the key region so metal
// picks up a hot specular lobe instead of a flat grey sheen.
//
// Owns: nothing but itself. Adds one group to the scene.

import * as THREE from 'three';

// --- rig geometry (metres, Y-up, feet at y=0, character faces +Z) -----------
// Camera lives around (+x, +z), so camera-left is roughly -x/+z.
const KEY_POS = new THREE.Vector3(-2.60, 3.55, 2.05);
const RIM_POS = new THREE.Vector3(2.95, 1.05, -2.30);
const FILL_POS = new THREE.Vector3(1.85, 0.50, 2.40);
const ACCENT_POS = new THREE.Vector3(-1.05, 0.78, -1.15);
const AIM = new THREE.Vector3(0, 1.15, 0); // chest height of an average subject

// Shadow camera is fitted to a ~3 m tall subject standing at the origin.
const SUBJECT_HEIGHT = 3.0;

const FADE_SECONDS = 0.20;

// Faction moods. Colours are authored in sRGB; THREE.Color converts them into
// the renderer's working space for us.
const MOODS = {
  Alliance: {
    key: '#ffe2c2', keyI: 3.20,
    rim: '#6fa8e0', rimI: 4.10,
    fill: '#8ea6c6', fillI: 0.62,
    accent: '#3a6ea8', accentI: 3.20
  },
  Horde: {
    key: '#ffc794', keyI: 3.55,
    rim: '#e0704a', rimI: 3.80,
    fill: '#c2967f', fillI: 0.58,
    accent: '#a33232', accentI: 3.60
  },
  Neutral: {
    key: '#ffe8c0', keyI: 3.30,
    rim: '#9fb2da', rimI: 3.60,
    fill: '#b3a888', fillI: 0.60,
    accent: '#c8b878', accentI: 3.00
  }
};

const QUALITY = {
  high:        { shadowMap: 2048, accent: 1.0, shadows: true },
  balanced:    { shadowMap: 1024, accent: 0.55, shadows: true },
  performance: { shadowMap: 512,  accent: 0.0, shadows: true }
};

const IBL_WIDTH = 1024;
const IBL_HEIGHT = 512;
const IBL_RANGE = 32.0; // RGBM multiplier: peak radiance the encoding can hold

// Equirectangular environment. Matches three's own equirectUv():
//   u = atan2(z, x) / 2pi + 0.5,  v = asin(y) / pi + 0.5
const IBL_FRAG = /* glsl */ `
  float a = (vUv.x - 0.5) * 6.28318530718;
  float t = (vUv.y - 0.5) * 3.14159265359;
  float ct = cos(t);
  vec3 dir = vec3(cos(a) * ct, sin(t), sin(a) * ct);

  // ---- dusk sky, seen through the broken roof and the arcade openings ----
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 zenith = vec3(0.016, 0.026, 0.055);
  vec3 skyHorizon = vec3(0.130, 0.098, 0.078);
  vec3 sky = mix(skyHorizon, zenith, pow(up, 0.50));

  float cloud = fbm(dir * 2.3 + vec3(0.0, 0.7, 11.3), 5, 2.15, 0.52) * 0.5 + 0.5;
  float streak = fbm(dir * vec3(4.5, 9.0, 4.5) + 3.7, 4, 2.0, 0.5) * 0.5 + 0.5;
  sky *= 0.62 + 0.85 * mix(cloud, streak, 0.35);

  // warm dusk band low in the sky, biased toward the key azimuth
  float keyAz = max(dot(normalize(vec3(uKeyDir.x, 0.0, uKeyDir.z)), normalize(vec3(dir.x, 0.0, dir.z) + 1e-5)), 0.0);
  sky += vec3(0.10, 0.055, 0.028) * pow(keyAz, 2.2) * (1.0 - smoothstep(0.0, 0.45, dir.y));

  // ---- stone: walls, piers, floor ----
  vec3 w = worley(dir * vec3(2.6, 3.4, 2.6), 4.0);
  float mortar = smoothstep(0.015, 0.13, w.y - w.x);
  float block = 0.70 + 0.55 * fract(w.z * 7.31);
  float grain = fbm(dir * 14.0, 4, 2.0, 0.55) * 0.5 + 0.5;
  vec3 stone = vec3(0.052, 0.049, 0.056) * block * (0.45 + 0.55 * mortar) * (0.65 + 0.7 * grain);

  float damp = fbm(dir * 3.1 + 21.0, 3, 2.0, 0.5) * 0.5 + 0.5;
  stone *= 0.55 + 0.75 * damp;

  vec3 floorCol = vec3(0.030, 0.028, 0.033) * (0.45 + 0.85 * (fbm(dir * 7.0 + 31.0, 4, 2.0, 0.5) * 0.5 + 0.5));

  float belowMix = 1.0 - smoothstep(-0.22, 0.03, dir.y);
  vec3 interior = mix(stone, floorCol, belowMix);

  // ---- openings: an arcade of four arches, plus a torn-open ceiling ----
  float piers = smoothstep(0.30, 0.78, sin(a * 4.0 + 0.6));
  float archBand = smoothstep(-0.03, 0.09, dir.y) * (1.0 - smoothstep(0.20, 0.44, dir.y));
  float ragged = 0.55 + 0.45 * (fbm(dir * 5.0 + 7.0, 3, 2.0, 0.5) * 0.5 + 0.5);
  float opening = piers * archBand * ragged;

  float ceiling = smoothstep(0.46, 0.86, dir.y)
                * (0.35 + 0.65 * smoothstep(-0.15, 0.30, fbm(dir * 1.9, 4, 2.0, 0.5)));

  float skyMask = clamp(opening * 0.95 + ceiling, 0.0, 1.0);
  vec3 base = mix(interior, sky, skyMask);

  // ---- ambient-occlusion-ish darkening low down, so the floor does not
  // ---- wash the underside of the character with free light
  float down = clamp(-dir.y, 0.0, 1.0);
  base *= 1.0 - 0.80 * smoothstep(0.0, 0.62, down);
  base *= 1.0 - 0.28 * (1.0 - smoothstep(-0.30, 0.05, dir.y)) * (1.0 - skyMask);

  // ---- the bright key region: a shuttered window blazing with low sun ----
  float kd = max(dot(dir, uKeyDir), 0.0);
  float slats = 0.55 + 0.45 * smoothstep(0.25, 0.75, sin(dir.y * 62.0));
  float core = pow(kd, 900.0) * 26.0 * slats;
  float halo = pow(kd, 60.0) * 4.2 + pow(kd, 12.0) * 0.85 + pow(kd, 4.0) * 0.16;
  base += vec3(1.00, 0.79, 0.53) * (core + halo);

  // ---- cool sky spill behind, the rim's counterpart in the IBL ----
  float rd = max(dot(dir, uRimDir), 0.0);
  base += vec3(0.32, 0.50, 0.95) * (pow(rd, 26.0) * 1.05 + pow(rd, 5.0) * 0.16);

  // ---- a couple of dim practicals along the walls for lateral variation ----
  float braz = pow(max(dot(normalize(vec3(dir.x, dir.y + 0.06, dir.z)), normalize(vec3(0.82, 0.05, -0.57))), 0.0), 70.0);
  braz += pow(max(dot(normalize(vec3(dir.x, dir.y + 0.06, dir.z)), normalize(vec3(-0.75, 0.02, -0.66))), 0.0), 70.0);
  base += vec3(0.85, 0.42, 0.16) * braz * 0.9;

  base = max(base, vec3(0.0));

  // RGBM-ish encode so an 8-bit target can carry the key's overbright values.
  float peak = max(max(base.r, base.g), base.b);
  float m = clamp(peak / uRange, 1.0 / 255.0, 1.0);
  m = ceil(m * 255.0) / 255.0;
  gl_FragColor = vec4(base / (m * uRange), m);
`;

const DECODE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DECODE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform float uRange;
void main() {
  vec4 s = texture2D(tMap, vUv);
  gl_FragColor = vec4(s.rgb * s.a * uRange, 1.0);
}
`;

/**
 * @param {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer, bakery: import('./bakery.js').Bakery }} deps
 * @returns {{ group: THREE.Group, envMap: THREE.Texture|null,
 *             setMood: (faction: any, klass: any) => void,
 *             setQuality: (q: string) => void,
 *             tick: (t: number, dt: number) => void,
 *             dispose: () => void }}
 */
export function createLighting({ scene, renderer, bakery }) {
  const group = new THREE.Group();
  group.name = 'lighting-rig';

  // --------------------------------------------------------------- targets --
  const target = new THREE.Object3D();
  target.name = 'lighting-aim';
  target.position.copy(AIM);
  group.add(target);

  // ------------------------------------------------------------------- key --
  const key = new THREE.DirectionalLight(0xffe8c0, 3.3);
  key.name = 'key';
  key.position.copy(KEY_POS);
  key.target = target;
  key.castShadow = true;

  // Fit the shadow frustum to a ~3 m subject; anything looser just wastes
  // texels. The key sits ~36 deg above the horizon, so in the shadow camera's
  // own frame the subject fills the upper half while its cast on the floor
  // trails off below — hence the asymmetric top/bottom. ~1.8 mm per texel
  // horizontally at 2048.
  const dist = KEY_POS.distanceTo(AIM);
  const sc = key.shadow.camera;
  sc.left = -SUBJECT_HEIGHT * 0.60;
  sc.right = SUBJECT_HEIGHT * 0.60;
  sc.top = SUBJECT_HEIGHT * 0.63;
  sc.bottom = -SUBJECT_HEIGHT * 0.93;
  sc.near = Math.max(0.1, dist - SUBJECT_HEIGHT);
  sc.far = dist + SUBJECT_HEIGHT * 1.6;
  sc.updateProjectionMatrix();

  key.shadow.mapSize.set(2048, 2048);
  // ~1.7 mm per texel at 2048: a small constant bias kills acne, and the
  // normal bias does the rest without lifting contact shadows off the feet.
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.014;
  key.shadow.radius = 2.2; // used by PCF; harmless under PCFSoft
  key.shadow.blurSamples = 12;
  group.add(key);

  // ------------------------------------------------------------------- rim --
  // Low, behind, and on the opposite side from the key. This is the light
  // that gives the character its edge — deliberately brighter than the key's
  // diffuse contribution at grazing angles.
  const rim = new THREE.DirectionalLight(0x9fb2da, 2.9);
  rim.name = 'rim';
  rim.position.copy(RIM_POS);
  rim.target = target;
  rim.castShadow = false;
  group.add(rim);

  // ------------------------------------------------------------------ fill --
  const fill = new THREE.DirectionalLight(0xb3a888, 0.6);
  fill.name = 'fill';
  fill.position.copy(FILL_POS);
  fill.target = target;
  fill.castShadow = false;
  group.add(fill);

  // ---------------------------------------------------------------- accent --
  // Class-coloured practical sitting low and behind, reading as a brazier or
  // a rune on the floor. Disabled on the lower quality tiers.
  const accent = new THREE.PointLight(0xc8b878, 3.0, 5.5, 2.0);
  accent.name = 'accent';
  accent.position.copy(ACCENT_POS);
  accent.castShadow = false;
  group.add(accent);

  scene.add(group);

  // --------------------------------------------------------------- IBL bake --
  const envMap = buildEnvironment(renderer, bakery);

  // ------------------------------------------------------------------- mood --
  const cur = newMoodState();
  const from = newMoodState();
  const to = newMoodState();
  applyMoodSpec(to, MOODS.Neutral);
  copyMood(cur, to);
  copyMood(from, to);
  let fade = 1; // 0..1 progress of the current transition

  let quality = QUALITY.high;
  let accentScale = 1.0;

  function setMood(faction, klass) {
    const name = typeof faction === 'string' ? faction : faction?.name;
    const spec = MOODS[name] ?? MOODS.Neutral;
    applyMoodSpec(to, spec);

    // Push the class colour into the accent (and a whisper of it into the rim)
    // without letting it overpower the faction identity.
    const klassHex = klass?.color;
    if (klassHex) {
      const kc = tmpColorA.set(klassHex);
      to.accent.lerp(kc, 0.62);
      to.rim.lerp(kc, 0.10);
    }

    copyMood(from, cur); // continue from wherever the last transition got to
    fade = 0;
  }

  function setQuality(q) {
    quality = QUALITY[q] ?? QUALITY.high;
    accentScale = quality.accent;

    const size = quality.shadowMap;
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      // Force three to reallocate the shadow map at the new resolution.
      key.shadow.map?.dispose();
      key.shadow.map = null;
      key.shadow.needsUpdate = true;
    }
    key.castShadow = quality.shadows;
    accent.visible = accentScale > 0;
  }

  function tick(t, dt) {
    if (fade < 1) {
      fade = Math.min(1, fade + (dt > 0 ? dt : 0) / FADE_SECONDS);
      const e = fade * fade * (3 - 2 * fade); // smoothstep, no snap at either end
      lerpMood(cur, from, to, e);
    }

    key.color.copy(cur.key);
    key.intensity = cur.keyI;

    // A breath of movement so the rig never feels like a still frame.
    const shimmer = 1 + 0.022 * Math.sin(t * 0.53) + 0.012 * Math.sin(t * 1.27 + 1.1);
    rim.color.copy(cur.rim);
    rim.intensity = cur.rimI * shimmer;

    fill.color.copy(cur.fill);
    fill.intensity = cur.fillI;

    if (accent.visible) {
      const flicker = 1
        + 0.075 * Math.sin(t * 5.7)
        + 0.045 * Math.sin(t * 11.3 + 2.1)
        + 0.030 * Math.sin(t * 2.3 + 0.7);
      accent.color.copy(cur.accent);
      accent.intensity = cur.accentI * accentScale * flicker;
    }
  }

  function dispose() {
    key.shadow.map?.dispose();
    envMap?.userData?.pmremTarget?.dispose();
    scene.remove(group);
  }

  return { group, envMap, setMood, setQuality, tick, dispose };
}

// ---------------------------------------------------------------------------
// IBL
// ---------------------------------------------------------------------------

function buildEnvironment(renderer, bakery) {
  let equirect = null;
  let hdrTarget = null;

  try {
    const packed = bakery.bake(
      'ibl-stonehall-dusk-v2',
      IBL_FRAG,
      {
        width: IBL_WIDTH,
        height: IBL_HEIGHT,
        uniforms: {
          uKeyDir: KEY_POS.clone().sub(AIM).normalize(),
          uRimDir: RIM_POS.clone().sub(AIM).normalize(),
          uRange: IBL_RANGE
        },
        wrap: THREE.RepeatWrapping,
        colorSpace: THREE.NoColorSpace, // the bake is encoded data, not colour
        filter: THREE.NearestFilter,    // decoded 1:1, so no RGBM interpolation
        generateMipmaps: false
      }
    );

    hdrTarget = decodeToHalfFloat(renderer, packed);
    equirect = hdrTarget ? hdrTarget.texture : packed;
  } catch (err) {
    console.warn('[lighting] environment bake failed, falling back', err);
    equirect = null;
  }

  if (!equirect) return null;

  equirect.mapping = THREE.EquirectangularReflectionMapping;

  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(equirect);
    pmrem.dispose();
    hdrTarget?.dispose(); // the PMREM cube is self-contained from here
    rt.texture.userData.pmremTarget = rt;
    return rt.texture;
  } catch (err) {
    console.warn('[lighting] PMREM generation failed', err);
    return null;
  }
}

/**
 * Expands the RGBM-packed 8-bit bake into a linear half-float equirect map so
 * the key region can carry radiance well above 1.0 into the PMREM.
 */
function decodeToHalfFloat(renderer, packed) {
  const target = new THREE.WebGLRenderTarget(IBL_WIDTH, IBL_HEIGHT, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace
  });

  const material = new THREE.ShaderMaterial({
    vertexShader: DECODE_VERT,
    fragmentShader: DECODE_FRAG,
    uniforms: {
      tMap: { value: packed },
      uRange: { value: IBL_RANGE }
    },
    depthTest: false,
    depthWrite: false
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } catch (err) {
    console.warn('[lighting] HDR decode pass failed', err);
    target.dispose();
    return null;
  } finally {
    renderer.setRenderTarget(prevTarget);
    quad.geometry.dispose();
    material.dispose();
  }

  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  target.texture.needsUpdate = true;
  return target;
}

// ---------------------------------------------------------------------------
// mood helpers
// ---------------------------------------------------------------------------

const tmpColorA = new THREE.Color();

function newMoodState() {
  return {
    key: new THREE.Color(), keyI: 0,
    rim: new THREE.Color(), rimI: 0,
    fill: new THREE.Color(), fillI: 0,
    accent: new THREE.Color(), accentI: 0
  };
}

function applyMoodSpec(dst, spec) {
  dst.key.set(spec.key); dst.keyI = spec.keyI;
  dst.rim.set(spec.rim); dst.rimI = spec.rimI;
  dst.fill.set(spec.fill); dst.fillI = spec.fillI;
  dst.accent.set(spec.accent); dst.accentI = spec.accentI;
}

function copyMood(dst, src) {
  dst.key.copy(src.key); dst.keyI = src.keyI;
  dst.rim.copy(src.rim); dst.rimI = src.rimI;
  dst.fill.copy(src.fill); dst.fillI = src.fillI;
  dst.accent.copy(src.accent); dst.accentI = src.accentI;
}

function lerpMood(dst, a, b, e) {
  dst.key.copy(a.key).lerp(b.key, e);
  dst.rim.copy(a.rim).lerp(b.rim, e);
  dst.fill.copy(a.fill).lerp(b.fill, e);
  dst.accent.copy(a.accent).lerp(b.accent, e);
  dst.keyI = a.keyI + (b.keyI - a.keyI) * e;
  dst.rimI = a.rimI + (b.rimI - a.rimI) * e;
  dst.fillI = a.fillI + (b.fillI - a.fillI) * e;
  dst.accentI = a.accentI + (b.accentI - a.accentI) * e;
}
