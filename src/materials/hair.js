// Hair material — Kajiya-Kay anisotropic strand shading on top of
// MeshPhysicalMaterial.
//
// The geometry side (character/hair.js) builds an InstancedMesh of tapered
// ribbon cards laid over the scalp. One card is not one hair: the baked
// strand card texture puts several fine tapered strands across the quad, so a
// few hundred instances read as a full head of hair.
//
// Shading:
//   - Two shifted Kajiya-Kay specular lobes along the strand tangent. The
//     primary lobe is near-white and tight, the secondary is tinted with the
//     hair colour, broader, and broken up by the baked anisotropic fibre
//     noise so the highlight never resolves into a clean plastic band.
//   - The strand tangent is the card's local V direction, recovered per-pixel
//     from screen-space derivatives of view position against the card UV, with
//     the instance's local +Y axis as a degenerate-case fallback.
//   - No depth-sorted alpha is available, so the cutout is a hashed/dithered
//     alpha test (alphaTest > 0, transparent false, alphaToCoverage on so it
//     upgrades to real coverage AA wherever the target is multisampled).
//   - Root-to-tip: darker and rougher at the root, lighter and shinier at the
//     tip; per-instance aStrandSeed / aStrandTint vary tint and roughness so
//     the hair mass has internal depth.
//
// Everything the shader samples comes from the Bakery. Nothing is fetched.

import * as THREE from 'three';

const DEFAULT_COLOR = '#3a2a1e';
const DEFAULT_RACE = 'Human';

// Per-race strand character. `strands` is how many hairs the card texture
// draws across one quad; `wave` how much they wander; `stretch` how elongated
// the fibre noise is along the strand; `shine` scales both specular lobes.
const PROFILES = {
  Human:       { strands: 9,  thick: 1.00, wave: 0.030, detail: 26, stretch: 9.0,  shine: 1.00, spread: 0.55, rootRough: 0.80, tipRough: 0.33, exp1: 90,  exp2: 26, shiftNoise: 0.055, rootDark: 0.60 },
  Dwarf:       { strands: 7,  thick: 1.30, wave: 0.055, detail: 18, stretch: 6.5,  shine: 0.80, spread: 0.62, rootRough: 0.88, tipRough: 0.45, exp1: 55,  exp2: 18, shiftNoise: 0.080, rootDark: 0.62 },
  'Night Elf': { strands: 12, thick: 0.80, wave: 0.020, detail: 34, stretch: 14.0, shine: 1.35, spread: 0.48, rootRough: 0.70, tipRough: 0.22, exp1: 140, exp2: 34, shiftNoise: 0.035, rootDark: 0.52 },
  Gnome:       { strands: 10, thick: 0.95, wave: 0.065, detail: 24, stretch: 7.5,  shine: 1.15, spread: 0.70, rootRough: 0.76, tipRough: 0.28, exp1: 100, exp2: 24, shiftNoise: 0.070, rootDark: 0.55 },
  Draenei:     { strands: 11, thick: 0.90, wave: 0.028, detail: 30, stretch: 12.0, shine: 1.25, spread: 0.50, rootRough: 0.72, tipRough: 0.24, exp1: 120, exp2: 30, shiftNoise: 0.040, rootDark: 0.54 },
  Worgen:      { strands: 14, thick: 0.75, wave: 0.045, detail: 16, stretch: 5.0,  shine: 0.55, spread: 0.80, rootRough: 0.92, tipRough: 0.58, exp1: 40,  exp2: 14, shiftNoise: 0.110, rootDark: 0.68 },
  Pandaren:    { strands: 14, thick: 0.85, wave: 0.038, detail: 14, stretch: 4.5,  shine: 0.50, spread: 0.78, rootRough: 0.94, tipRough: 0.62, exp1: 34,  exp2: 12, shiftNoise: 0.120, rootDark: 0.66 },
  Orc:         { strands: 8,  thick: 1.20, wave: 0.042, detail: 20, stretch: 7.0,  shine: 0.72, spread: 0.60, rootRough: 0.88, tipRough: 0.44, exp1: 52,  exp2: 17, shiftNoise: 0.085, rootDark: 0.66 },
  Undead:      { strands: 6,  thick: 1.10, wave: 0.075, detail: 12, stretch: 5.5,  shine: 0.38, spread: 0.85, rootRough: 0.96, tipRough: 0.70, exp1: 26,  exp2: 10, shiftNoise: 0.140, rootDark: 0.74 },
  Tauren:      { strands: 10, thick: 1.35, wave: 0.035, detail: 17, stretch: 6.0,  shine: 0.68, spread: 0.66, rootRough: 0.90, tipRough: 0.46, exp1: 46,  exp2: 16, shiftNoise: 0.090, rootDark: 0.64 },
  Troll:       { strands: 7,  thick: 1.15, wave: 0.085, detail: 15, stretch: 5.5,  shine: 0.62, spread: 0.72, rootRough: 0.92, tipRough: 0.50, exp1: 42,  exp2: 15, shiftNoise: 0.105, rootDark: 0.66 },
  'Blood Elf': { strands: 12, thick: 0.82, wave: 0.022, detail: 32, stretch: 13.0, shine: 1.40, spread: 0.46, rootRough: 0.68, tipRough: 0.20, exp1: 145, exp2: 36, shiftNoise: 0.032, rootDark: 0.50 },
  Goblin:      { strands: 8,  thick: 0.95, wave: 0.070, detail: 20, stretch: 6.5,  shine: 0.85, spread: 0.75, rootRough: 0.86, tipRough: 0.40, exp1: 60,  exp2: 20, shiftNoise: 0.095, rootDark: 0.60 },
  Dracthyr:    { strands: 11, thick: 0.88, wave: 0.026, detail: 28, stretch: 11.0, shine: 1.20, spread: 0.52, rootRough: 0.74, tipRough: 0.26, exp1: 110, exp2: 28, shiftNoise: 0.045, rootDark: 0.56 }
};

const DEFAULT_PROFILE = PROFILES.Human;

function profileFor(race) {
  return PROFILES[race] || DEFAULT_PROFILE;
}

// Stable 0..1 hash of a string, used to give each race/colour pair its own
// strand layout without needing a random seed that would change per session.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---------------------------------------------------------------------------
// Baked maps
// ---------------------------------------------------------------------------

// Several fine tapered strands across one card, soft at the ends.
//   r = strand core mask (used to keep the specular on the hair, not the gap)
//   g = alpha            (alphaMap samples .g — also drives the shadow cutout)
//   b = per-strand id    (breaks the strands apart in tint)
//   a = alpha
const CARD_FRAG = /* glsl */ `
  float u = vUv.x;
  float v = clamp(vUv.y, 0.0, 1.0);

  float alpha = 0.0;
  float core = 0.0;
  float sid = 0.0;

  int count = int(uCount);
  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    float fi = float(i);

    float r1 = hash1(vec2(fi * 1.73 + uSeed * 37.0, 3.11));
    float r2 = hash1(vec2(fi * 0.91 + uSeed * 19.0, 11.71));
    float r3 = hash1(vec2(fi * 2.37 + uSeed * 53.0, 27.31));

    // Strand centre: evenly slotted, jittered, then wandering along its length.
    float slot = (fi + 0.5) / uCount;
    float wander = sin(v * (2.0 + r2 * 5.0) + r3 * 6.2831853) * uWave * (0.15 + 0.85 * v);
    float cx = slot + (r1 - 0.5) * (0.85 / uCount) + wander;

    // Each strand ends at its own height and tapers to nothing there, so the
    // card end is a spray of points rather than a chopped-off band.
    float len = mix(0.62, 1.0, r2);
    float along = clamp(v / len, 0.0, 1.0);
    // Stays close to full gauge for most of its length, then runs out quickly:
    // a strand that thins linearly from the root reads as a wire, not hair.
    float taper = pow(1.0 - along, 0.30);
    float w = (0.5 / uCount) * mix(0.45, 1.15, r3) * uThick * taper;

    float d = abs(u - cx);
    float a = w > 1e-5 ? 1.0 - smoothstep(w * 0.60, w, d) : 0.0;

    // Fine break-up along the strand so it is not a clean airbrushed line.
    float grain = fbm(vec3(v * uDetail, fi * 7.0 + uSeed * 13.0, uSeed * 3.0), 3, 2.0, 0.5);
    a *= clamp(0.86 + 0.28 * (grain * 0.5 + 0.5), 0.0, 1.15);

    a = clamp(a, 0.0, 1.0);
    float c = w > 1e-5 ? clamp(1.0 - smoothstep(0.0, w * 0.5, d), 0.0, 1.0) : 0.0;

    if (a > alpha) sid = r1;
    alpha = max(alpha, a);
    core = max(core, c);
  }

  // Soft card borders in U only — the root edge stays dense so the hair meets
  // the scalp without a gap.
  alpha *= smoothstep(0.0, 0.03, u) * (1.0 - smoothstep(0.97, 1.0, u));
  alpha = clamp(alpha, 0.0, 1.0);

  gl_FragColor = vec4(core, alpha, sid, alpha);
`;

// Anisotropic fibre noise stretched along the strand (V) direction.
//   r = fine fibre       -> tint + roughness jitter
//   g = highlight shift  -> breaks the specular band into shards
//   b = coarse blotches  -> strand-mass colour variation
//   a = very fine fibre  -> alpha break-up
const FIBRE_FRAG = /* glsl */ `
  vec3 dir = vec3(0.0, 1.0, 0.0);
  vec3 p = vec3(vUv.x * uScale, vUv.y * uScale, uSeed * 21.0);

  float fine = fibre(p * 3.0, dir, uStretch, 4);
  float mid = fibre(p, dir, uStretch * 0.65, 3);
  float band = ridged(vec3(vUv.x * uScale * 0.7, vUv.y * uScale * 0.09, uSeed * 5.0), 3, 2.2, 0.5);
  float coarse = fbm(vec3(vUv.x * 2.2, vUv.y * 1.4, uSeed * 7.0), 3, 2.0, 0.55);
  float micro = fibre(p * 8.0, dir, uStretch * 1.7, 3);

  // fbm returns roughly +/-0.35, so each channel is gained up before it is
  // centred — otherwise every map sits in a narrow band around 0.5 and drives
  // no visible variation at all.
  float r = clamp(fine * 1.30 + 0.5, 0.0, 1.0);
  float g = clamp(mix(mid * 1.40 + 0.5, (band - 0.55) * 2.2 + 0.5, 0.45), 0.0, 1.0);
  float b = clamp(coarse * 1.70 + 0.5, 0.0, 1.0);
  float a = clamp(micro * 1.15 + 0.5, 0.0, 1.0);

  gl_FragColor = vec4(r, g, b, a);
`;

// ---------------------------------------------------------------------------
// Injected GLSL
// ---------------------------------------------------------------------------

const VERT_PARS = /* glsl */ `
attribute float aStrandSeed;
attribute float aStrandTint;
varying float vHairSeed;
varying float vHairTint;
varying vec2 vHairUv;
varying vec3 vHairAxis;
`;

const VERT_BODY = /* glsl */ `
  vHairUv = uv;
  vHairSeed = aStrandSeed;
  vHairTint = aStrandTint;

  // Fallback strand axis: the card's local +Y, i.e. the direction the ribbon
  // is lofted along, pushed through the instance transform into view space.
  vec3 hairAxisLocal = vec3(0.0, 1.0, 0.0);
  #ifdef USE_INSTANCING
    hairAxisLocal = (instanceMatrix * vec4(hairAxisLocal, 0.0)).xyz;
  #endif
  vHairAxis = (modelViewMatrix * vec4(hairAxisLocal, 0.0)).xyz;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uHairFibre;
uniform vec3 uHairTintLo;
uniform vec3 uHairTintHi;
uniform vec3 uHairRootColor;
uniform vec3 uHairSpecPrimary;
uniform vec3 uHairSpecSecondary;
uniform vec4 uHairSpecA;   // x intensity, y exponent, z shift, w shift-noise
uniform vec4 uHairSpecB;   // x intensity, y exponent, z shift, w diffuse wrap
uniform vec4 uHairShape;   // x root darkening, y tint spread, z root rough, w tip rough
uniform vec2 uHairEdge;    // x tip softness, y dither amount
uniform vec2 uHairMisc;    // x fibre scale, y flip V
uniform float uHairTime;

varying float vHairSeed;
varying float vHairTint;
varying vec2 vHairUv;
varying vec3 vHairAxis;

// Written in main() before the lighting loop, read inside RE_Direct_Hair.
vec3 gHairTangent;
float gHairShift;
float gHairSpecMask;
float gHairBreak;

float hairHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Direction of increasing V on the card, in view space. Solved from the
// screen-space derivatives of view position against the card UV, so it holds
// for tapered ribbons and any card orientation the geometry author picks.
vec3 hairStrandTangent() {
  vec3 vpos = -vViewPosition;
  vec3 dpx = dFdx(vpos);
  vec3 dpy = dFdy(vpos);
  vec2 dux = dFdx(vHairUv);
  vec2 duy = dFdy(vHairUv);

  float det = dux.x * duy.y - duy.x * dux.y;
  vec3 dpdv = -duy.x * dpx + dux.x * dpy;
  dpdv *= (det < 0.0) ? -1.0 : 1.0;

  float len2 = dot(dpdv, dpdv);
  if (len2 > 1e-12) return dpdv * inversesqrt(len2);

  vec3 fallback = vHairAxis;
  float flen2 = dot(fallback, fallback);
  if (flen2 > 1e-12) return fallback * inversesqrt(flen2);
  return vec3(0.0, 1.0, 0.0);
}
`;

const FRAG_KAJIYA = /* glsl */ `
// Kajiya-Kay: the highlight is a ring around the strand tangent rather than a
// point around the normal. Shifting the tangent toward the normal slides the
// band along the strand, which is what separates the two lobes.
float hairKKLobe(vec3 T, vec3 N, vec3 L, vec3 V, float shift, float exponent) {
  vec3 Ts = normalize(T + shift * N);
  float dotTL = dot(Ts, L);
  float dotTV = dot(Ts, V);
  float sinTL = sqrt(max(1.0 - dotTL * dotTL, 0.0));
  float sinTV = sqrt(max(1.0 - dotTV * dotTV, 0.0));
  return pow(saturate(dotTL * dotTV + sinTL * sinTV), exponent);
}

void RE_Direct_Hair( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

  vec3 T = gHairTangent;
  vec3 N = geometryNormal;
  vec3 L = directLight.direction;
  vec3 V = geometryViewDir;

  // Cards are near-flat, so a hard N.L cutoff strobes as they turn. Wrap it.
  float wrapNL = saturate(dot(N, L) * 0.5 + 0.5);
  float atten = wrapNL * wrapNL;

  float s1 = hairKKLobe(T, N, L, V, uHairSpecA.z + gHairShift, uHairSpecA.y);
  float s2 = hairKKLobe(T, N, L, V, uHairSpecB.z + gHairShift * 1.8, uHairSpecB.y);

  // The tinted secondary lobe is the one that reads as "hair" — break it up
  // hardest so it never forms a clean band.
  s2 *= mix(0.30, 1.15, gHairBreak);

  vec3 spec = uHairSpecPrimary * (s1 * uHairSpecA.x) + uHairSpecSecondary * (s2 * uHairSpecB.x);
  reflectedLight.directSpecular += directLight.color * spec * atten * gHairSpecMask;

  // A little forward scatter through the hair mass so back-lit strands are
  // not pure silhouette.
  float wrapDiffuse = saturate((dot(N, L) + 0.4) / 1.4) - saturate(dot(N, L));
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * (wrapDiffuse * uHairSpecB.w);
}

#undef RE_Direct
#define RE_Direct RE_Direct_Hair
`;

const FRAG_COLOR = /* glsl */ `
  float hairT = clamp(mix(vHairUv.y, 1.0 - vHairUv.y, uHairMisc.y), 0.0, 1.0);
  float hairStrand = clamp(vHairTint, 0.0, 1.0);
  float hairSeed = vHairSeed;

  vec2 hairFibreUv = vec2(
    vHairUv.x * 0.35 + fract(hairSeed * 0.6180339887) * 4.0,
    hairT * uHairMisc.x + fract(hairSeed * 0.3819660113) * 4.0 + uHairTime * 0.004
  );
  vec4 hairNoise = texture2D(uHairFibre, hairFibreUv);
  float hairFine = hairNoise.r;
  float hairBand = hairNoise.g;
  float hairCoarse = hairNoise.b;
  float hairMicro = hairNoise.a;

  // Per-strand tint: the instance attribute picks the family, the baked noise
  // scatters it so no two cards land on the same value.
  float hairMix = clamp(
    0.5 + (hairStrand - 0.5) * uHairShape.y * 1.1
        + (hairCoarse - 0.5) * 0.45
        + (hairFine - 0.5) * 0.28,
    0.0, 1.0);
  vec3 hairAlbedo = mix(uHairTintLo, uHairTintHi, hairMix);

  // Root-to-tip: dark and dense at the scalp, lifting toward the ends.
  float hairRoot = 1.0 - smoothstep(0.0, 0.55, hairT);
  hairAlbedo = mix(hairAlbedo, uHairRootColor, hairRoot * uHairShape.x);
  hairAlbedo *= mix(1.0, 1.14, smoothstep(0.40, 1.0, hairT));

  diffuseColor.rgb = hairAlbedo;
`;

const FRAG_ROUGH = /* glsl */ `
  roughnessFactor = clamp(
    mix(uHairShape.z, uHairShape.w, smoothstep(0.05, 0.85, hairT))
      + (hairFine - 0.5) * 0.14
      + (hairStrand - 0.5) * 0.12,
    0.05, 1.0);
`;

const FRAG_ALPHA = /* glsl */ `
  // No depth sorting is available for these cards, so the cutout is hashed:
  // a stable per-pixel hash jitters the threshold band, which lets overlapping
  // strands interleave instead of z-fighting into flat plates. With a
  // multisampled target alphaToCoverage turns the same band into real coverage.
  diffuseColor.a *= mix(0.88, 1.12, hairMicro);
  diffuseColor.a *= 1.0 - smoothstep(1.0 - uHairEdge.x, 1.0, hairT);

  float hairDither = hairHash21(gl_FragCoord.xy) * 0.5
                   + hairHash21(gl_FragCoord.yx * 1.37 + vec2(fract(hairSeed * 71.3))) * 0.5;
  diffuseColor.a = clamp(diffuseColor.a + (hairDither - 0.5) * uHairEdge.y, 0.0, 1.0);
`;

const FRAG_PRELIGHT = /* glsl */ `
  gHairTangent = hairStrandTangent();
  gHairBreak = hairBand;
  gHairShift = (hairBand - 0.5) * uHairSpecA.w
             + (hairFine - 0.5) * uHairSpecA.w * 0.5
             + sin(uHairTime * 0.25 + hairSeed * 6.2831853) * 0.008;
  // Roots sit in shadow under the mass and take almost no highlight.
  gHairSpecMask = mix(0.18, 1.0, smoothstep(0.05, 0.65, hairT))
                * mix(0.70, 1.30, hairStrand)
                * mix(0.85, 1.15, hairFine);
`;

// ---------------------------------------------------------------------------

/**
 * @param {{ bakery: any, renderer: any, envMap: any }} ctx
 * @param {{ color?: string, race?: string }} params
 * @returns {THREE.Material}
 */
export function createHairMaterial(ctx, params = {}) {
  const bakery = ctx && ctx.bakery ? ctx.bakery : null;
  const renderer = ctx && ctx.renderer ? ctx.renderer : null;

  const uniforms = {
    uHairFibre: { value: null },
    uHairTintLo: { value: new THREE.Color(0x2a1d13) },
    uHairTintHi: { value: new THREE.Color(0x5c422c) },
    uHairRootColor: { value: new THREE.Color(0x140d08) },
    uHairSpecPrimary: { value: new THREE.Color(0xffffff) },
    uHairSpecSecondary: { value: new THREE.Color(0x8a5a2b) },
    uHairSpecA: { value: new THREE.Vector4(0.34, 90.0, -0.045, 0.055) },
    uHairSpecB: { value: new THREE.Vector4(0.22, 26.0, 0.065, 0.16) },
    uHairShape: { value: new THREE.Vector4(0.6, 0.55, 0.8, 0.33) },
    uHairEdge: { value: new THREE.Vector2(0.10, 0.28) },
    uHairMisc: { value: new THREE.Vector2(0.85, 0.0) },
    uHairTime: { value: 0 }
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setStyle(DEFAULT_COLOR, THREE.SRGBColorSpace),
    roughness: 0.62,
    metalness: 0.0,
    // The stock GGX lobe is damped right down; the Kajiya-Kay lobes carry the
    // specular. Leaving it at full strength reads as wet plastic.
    specularIntensity: 0.22,
    envMap: (ctx && ctx.envMap) || null,
    envMapIntensity: 0.55,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    alphaTest: 0.32,
    alphaToCoverage: true,
    dithering: true,
    flatShading: false
  });
  material.name = 'hair';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', () => `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', () => `#include <begin_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', () => `#include <common>\n${FRAG_PARS}`)
      .replace(
        '#include <lights_physical_pars_fragment>',
        () => `#include <lights_physical_pars_fragment>\n${FRAG_KAJIYA}`
      )
      .replace('#include <color_fragment>', () => `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <alphatest_fragment>', () => `${FRAG_ALPHA}\n#include <alphatest_fragment>`)
      .replace(
        '#include <roughnessmap_fragment>',
        () => `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`
      )
      .replace(
        '#include <lights_physical_fragment>',
        () => `#include <lights_physical_fragment>\n${FRAG_PRELIGHT}`
      );
  };

  // Without this the program cache could hand this material a program compiled
  // for a plain MeshPhysicalMaterial with identical parameters.
  material.customProgramCacheKey = () => 'hair-kajiya-kay-v1';

  const state = { color: null, race: null, cardKey: null, fibreKey: null };

  const tmpBase = new THREE.Color();
  const tmpHSL = { h: 0, s: 0, l: 0 };
  const maxAniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;

  function bakeCard(race, colorHex) {
    if (!bakery) return null;
    const p = profileFor(race);
    const key = `hair-card-${race}-${colorHex}`;
    if (key === state.cardKey && material.alphaMap) return material.alphaMap;
    const seed = hashSeed(`${race}|${colorHex}`);
    const tex = bakery.bake(key, CARD_FRAG, {
      width: 256,
      height: 512,
      wrap: THREE.ClampToEdgeWrapping,
      colorSpace: THREE.NoColorSpace,
      uniforms: {
        uCount: p.strands,
        uThick: p.thick,
        uWave: p.wave,
        uDetail: p.detail,
        uSeed: seed
      }
    });
    tex.anisotropy = Math.min(8, maxAniso || 1);
    state.cardKey = key;
    return tex;
  }

  function bakeFibre(race, colorHex) {
    if (!bakery) return null;
    const p = profileFor(race);
    const key = `hair-fibre-${race}-${colorHex}`;
    if (key === state.fibreKey && uniforms.uHairFibre.value) return uniforms.uHairFibre.value;
    const seed = hashSeed(`${colorHex}|${race}`);
    const tex = bakery.bake(key, FIBRE_FRAG, {
      // Wide and short: the shader compresses U (across the strands, where the
      // detail is) and stretches V, and every cached bake holds its render
      // target for the session, so the maps stay small.
      width: 512,
      height: 256,
      // Mirrored so the per-strand offset never exposes a hard wrap seam.
      wrap: THREE.MirroredRepeatWrapping,
      colorSpace: THREE.NoColorSpace,
      uniforms: {
        uScale: 24.0,
        uStretch: p.stretch,
        uSeed: seed
      }
    });
    tex.anisotropy = Math.min(4, maxAniso || 1);
    state.fibreKey = key;
    return tex;
  }

  function applyColor(colorHex, p) {
    tmpBase.setStyle(colorHex, THREE.SRGBColorSpace);
    tmpBase.getHSL(tmpHSL, THREE.SRGBColorSpace);
    const h = tmpHSL.h;
    const s = tmpHSL.s;
    const l = tmpHSL.l;

    // Pale hair has nowhere to go lighter, so the spread leans dark instead.
    const pale = clamp01((l - 0.55) / 0.35);
    const spread = 0.30 * p.spread;

    material.color.copy(tmpBase);

    uniforms.uHairTintLo.value.setHSL(
      clamp01(h - 0.008),
      clamp01(s * 1.10),
      clamp01(l * (0.52 - spread * 0.25)),
      THREE.SRGBColorSpace
    );
    uniforms.uHairTintHi.value.setHSL(
      clamp01(h + 0.010),
      clamp01(s * (0.80 - pale * 0.2)),
      clamp01(l * (1.0 + spread) + 0.05 * (1.0 - pale)),
      THREE.SRGBColorSpace
    );
    uniforms.uHairRootColor.value.setHSL(
      clamp01(h - 0.004),
      clamp01(s * 1.15),
      clamp01(l * 0.30),
      THREE.SRGBColorSpace
    );

    // Primary lobe: near white, only faintly carrying the hair hue.
    uniforms.uHairSpecPrimary.value.setHSL(
      h,
      clamp01(s * 0.16),
      clamp01(0.62 + l * 0.30),
      THREE.SRGBColorSpace
    );
    // Secondary lobe: saturated hair colour, this is what sells it as hair.
    uniforms.uHairSpecSecondary.value.setHSL(
      clamp01(h + 0.012),
      clamp01(s * 1.30 + 0.10),
      clamp01(l * 1.25 + 0.10),
      THREE.SRGBColorSpace
    );
  }

  function applyProfile(p, l) {
    // Dark hair needs a stronger highlight to read at all; white hair needs
    // less or it blows out.
    const shine = p.shine * (1.25 - 0.45 * clamp01(l));

    uniforms.uHairSpecA.value.set(0.36 * shine, p.exp1, -0.045, p.shiftNoise);
    uniforms.uHairSpecB.value.set(0.24 * shine, p.exp2, 0.070, 0.18);
    uniforms.uHairShape.value.set(p.rootDark, p.spread, p.rootRough, p.tipRough);
    uniforms.uHairEdge.value.set(0.12, 0.24);
    uniforms.uHairMisc.value.set(0.85, 0.0);
    material.roughness = (p.rootRough + p.tipRough) * 0.5;
  }

  function update(next = {}) {
    const colorHex = typeof next.color === 'string' && next.color ? next.color : state.color || DEFAULT_COLOR;
    const race = typeof next.race === 'string' && next.race ? next.race : state.race || DEFAULT_RACE;
    if (colorHex === state.color && race === state.race) return;

    state.color = colorHex;
    state.race = race;

    const p = profileFor(race);

    applyColor(colorHex, p);
    tmpBase.getHSL(tmpHSL, THREE.SRGBColorSpace);
    applyProfile(p, tmpHSL.l);

    const fibre = bakeFibre(race, colorHex);
    if (fibre) uniforms.uHairFibre.value = fibre;

    const card = bakeCard(race, colorHex);
    if (card && material.alphaMap !== card) {
      const hadMap = material.alphaMap !== null;
      material.alphaMap = card;
      // Going null -> texture changes the defines; after that it is a plain
      // texture swap and the cached program is reused.
      if (!hadMap) material.needsUpdate = true;
    }
  }

  material.userData.update = update;

  material.userData.tick = (t) => {
    uniforms.uHairTime.value = t;
  };

  material.userData.setEnvMap = (envMap) => {
    const had = material.envMap !== null;
    material.envMap = envMap || null;
    if (had !== (material.envMap !== null)) material.needsUpdate = true;
  };

  // Bake once up front so the first real update() is a pure uniform/texture
  // swap rather than a shader recompile.
  update({ color: params.color || DEFAULT_COLOR, race: params.race || DEFAULT_RACE });

  return material;
}
