// Armor material — one MeshPhysicalMaterial serving all four armor tiers.
//
// The look is a standard physical BRDF with three things layered on through
// `onBeforeCompile`, so shadows, IBL, tone mapping and fog keep working:
//
//   1. Curvature-driven edge wear. Screen-space derivatives of the geometric
//      normal, measured against the view-space position, give a real per-pixel
//      surface curvature in 1/metres (~1/r on a cylinder of radius r, ~0 on a
//      flat panel, large and positive on a convex bevel, negative in a crease).
//      Convex edges lose their paint and patina and expose brighter, smoother,
//      more metallic base material; cavities collect grime. This is the single
//      thing that stops plate reading as moulded plastic.
//   2. An anisotropic, class-tinted highlight aligned to a brushed direction
//      sampled from a baked flow map. The flow map also feeds three's own
//      anisotropic GGX, so the base specular lobe genuinely stretches, and a
//      Kajiya-Kay tinted streak rides on top of it.
//   3. A fresnel rim in `klass.color`, scaled by `klass.armor.emissive`, with
//      a slow breathing pulse on the high-emissive classes.
//
// Plus trim/gilt driven by an optional `aTrimMask` vertex attribute.
//
// All texture data comes from the Bakery: albedo (sRGB), a tangent-space
// normal map, a packed AO/roughness/metalness map (r/g/b — exactly the
// channels three's aoMap / roughnessMap / metalnessMap sample, so one texture
// serves all three slots), and a flow map (rg = brushed direction,
// b = anisotropy strength, a = wear breakup noise).
//
// `update()` swaps cached baked textures and writes uniforms. Everything that
// affects the program cache key — which map slots are non-null, anisotropy and
// sheen being non-zero, the envMap — is fixed at construction, so switching
// class or tier never recompiles a shader.
//
// NOTE on Bakery usage: `fragBody` is spliced inside `void main() { ... }`, so
// none of the baked GLSL below may declare functions. Each tier therefore
// contributes plain statement blocks that read `auv` and write `ah` / `aAlb` /
// `aRough` / `aMetal` / `aAo` / `aDir` / `aAniso`, and the normal bake simply
// repeats the height block four times inside its own braces.

import * as THREE from 'three';
import { TIER_PROPS } from '../data/classes.js';

const TIERS = ['plate', 'mail', 'leather', 'cloth'];

const DEFAULT_KLASS = {
  name: 'Warrior',
  color: '#c79c6e',
  armor: { tier: 'plate', trim: 'riveted', emissive: 0.15 }
};

// Armor tiles across UV islands, so mid-res maps carrying a lot of
// high-frequency structure read better than one huge soft map.
const TEX = 512;
const FLOW_TEX = 256;

// Per-tier art direction. Colours are LINEAR: the bakery renders into an
// SRGB8_ALPHA8 target, so the hardware performs the linear->sRGB encode on
// write and decodes on sample. THREE.Color already stores linear values.
const TIER_ART = {
  plate: {
    base: 0x9aa2ab,
    dark: 0x1d2126,
    bare: 0xb9c0c8,          // exposed, polished steel on the edges
    trimBake: 0xc8ccd4,
    bareRough: 0.13,
    bareMetal: 1.0,
    tintAmt: 0.42,
    normalScale: 1.05,
    aniso: 0.85,
    anisoExp: 46.0,
    anisoGain: 1.1,
    edgeLo: 6.0,             // 1/m — curvature where wear starts (r ~ 17cm)
    edgeHi: 26.0,            // 1/m — curvature where wear is total (r ~ 4cm)
    aoIntensity: 0.9,
    threads: 0.0
  },
  mail: {
    base: 0x767d86,
    dark: 0x15181c,
    bare: 0xc2c9d1,
    trimBake: 0xb9beca,
    bareRough: 0.18,
    bareMetal: 1.0,
    tintAmt: 0.32,
    normalScale: 1.35,
    aniso: 0.6,
    anisoExp: 30.0,
    anisoGain: 0.9,
    edgeLo: 7.0,
    edgeHi: 30.0,
    aoIntensity: 1.0,
    threads: 0.0
  },
  leather: {
    base: 0x4a2f1e,
    dark: 0x140c07,
    bare: 0x8d6746,          // rubbed-through, lighter hide
    trimBake: 0xbb9463,      // waxed thread
    bareRough: 0.42,
    bareMetal: 0.06,
    tintAmt: 0.34,
    normalScale: 1.15,
    aniso: 0.25,
    anisoExp: 16.0,
    anisoGain: 0.45,
    edgeLo: 8.0,
    edgeHi: 34.0,
    aoIntensity: 0.85,
    threads: 0.0
  },
  cloth: {
    base: 0x6c675d,
    dark: 0x17150f,
    bare: 0xa9a293,          // sun-bleached, frayed fibre
    trimBake: 0xd8b262,      // gold embroidery thread
    bareRough: 0.72,
    bareMetal: 0.0,
    tintAmt: 0.74,
    normalScale: 0.85,
    aniso: 0.35,
    anisoExp: 12.0,
    anisoGain: 0.35,
    edgeLo: 9.0,
    edgeHi: 38.0,
    aoIntensity: 0.7,
    threads: 104.0
  }
};

// Trim response per `klass.armor.trim`. Gold is the default read: where the
// mask is high we shift albedo toward the trim colour, raise metalness, drop
// roughness and add emissive.
const TRIM_ART = {
  gilt:        { color: 0xffc44a, metal: 1.0,  rough: 0.11, emissive: 0.30, tinted: 0.0 },
  riveted:     { color: 0xc8ccd4, metal: 1.0,  rough: 0.19, emissive: 0.08, tinted: 0.0 },
  runic:       { color: 0xb9a8f0, metal: 0.35, rough: 0.30, emissive: 0.55, tinted: 0.85 },
  embroidered: { color: 0xe0bc72, metal: 0.28, rough: 0.38, emissive: 0.26, tinted: 0.35 },
  bone:        { color: 0xe6dcc2, metal: 0.05, rough: 0.52, emissive: 0.10, tinted: 0.0 },
  stitched:    { color: 0xc79a63, metal: 0.10, rough: 0.55, emissive: 0.06, tinted: 0.25 },
  leather:     { color: 0x8a5a33, metal: 0.10, rough: 0.62, emissive: 0.05, tinted: 0.2 }
};
for (const k of Object.keys(TRIM_ART)) TRIM_ART[k].key = k;

const DEFAULT_TRIM = TRIM_ART.gilt;

// Trims that print a woven pattern into the cloth bake.
const EMBROIDERED_TRIMS = new Set(['embroidered', 'runic']);

// ---------------------------------------------------------------------------
// Baked GLSL — statement blocks only (see the note at the top of the file)
// ---------------------------------------------------------------------------

// Height field. Reads `auv`, writes `ah`.
const H_GLSL = {
  // Hammered dents from low-frequency worley, scratches from stretched fibre
  // noise, corrosion pitting.
  plate: /* glsl */ `
    vec3 p = vec3(auv, uSeed);

    // Planishing: the shallow bowls a hammer leaves in a sheet. Kept low in
    // amplitude — dents belong in the normal map, not in the albedo.
    vec3 w = worley(p, 9.0);
    float dent = 1.0 - smoothstep(0.02, 0.70, w.x);
    ah = -0.30 * dent;

    // Broad roll of the sheet itself.
    ah += 0.26 * fbm(p * 5.0, 4, 2.0, 0.5);

    // Scratches: fibre noise stretched hard along two shear directions.
    float s1 = fibre(p * 24.0, normalize(vec3(0.94, 0.30, 0.16)), 18.0, 4);
    float s2 = fibre(p * 39.0 + 11.7, normalize(vec3(0.28, 0.95, 0.11)), 24.0, 3);
    float scratch = (1.0 - smoothstep(0.015, 0.055, abs(s1))) * 0.8
                  + (1.0 - smoothstep(0.010, 0.040, abs(s2))) * 0.5;
    ah -= 0.16 * clamp(scratch, 0.0, 1.0);

    // Pitting — corrosion pinpricks, and only in some cells. These are the
    // only features deep enough to darken the albedo.
    vec3 pit = worley(p + 3.1, 64.0);
    float pits = 1.0 - smoothstep(0.0, 0.30, pit.x);
    pits *= step(0.62, hash1(floor(p.xy * 64.0) + 17.0));
    ah -= 0.62 * pits;
  `,

  // Two worley ring lattices, half a cell apart, alternating which sits proud
  // so the links read as interlocking.
  mail: /* glsl */ `
    float s = max(uScale, 4.0);
    vec3 p = vec3(auv, uSeed);

    vec3 wa = worley(p, s);
    vec3 wb = worley(p + vec3(0.5 / s, 0.5 / s, 0.0), s);
    float ringA = 1.0 - smoothstep(0.0, 0.20, abs(wa.x - 0.34));
    float ringB = 1.0 - smoothstep(0.0, 0.20, abs(wb.x - 0.34));

    float over = mod(floor(auv.x * s) + floor(auv.y * s), 2.0);
    float ring = max(ringA * mix(0.70, 1.0, over), ringB * mix(1.0, 0.70, over));

    ah = ring * 1.6 - 0.8;

    // Padded gambeson backing showing through the weave.
    float backing = -0.85 + 0.22 * fbm(p * 62.0, 3, 2.2, 0.5);
    ah = mix(backing, ah, smoothstep(0.04, 0.34, max(ringA, ringB)));

    // Fine pitting on the ring faces.
    ah -= 0.14 * (1.0 - smoothstep(0.0, 0.36, worley(p + 2.0, s * 3.0).x)) * ring;
  `,

  // fbm grain, worley pores and creases, plus dashed stitch seams.
  leather: /* glsl */ `
    vec3 p = vec3(auv, uSeed);

    // Grain: two octaves of scale — a coarse tooth and a fine one.
    float grain = fbm(p * 40.0, 5, 2.15, 0.55);
    float fine = fbm(p * 130.0, 3, 2.0, 0.5);

    // Pore cells, small and shallow — this is hide, not reptile scale.
    vec3 w = worley(p, 46.0);
    float pores = 1.0 - smoothstep(0.0, 0.22, w.x);
    float creases = 1.0 - smoothstep(0.0, 0.06, w.y - w.x);

    // A sparse layer of broad wrinkles where the hide has flexed.
    vec3 w2 = worley(p + 5.0, 5.0);
    float wrinkle = 1.0 - smoothstep(0.0, 0.11, w2.y - w2.x);

    ah = grain * 0.42 + fine * 0.22 - creases * 0.20 - pores * 0.12 - wrinkle * 0.24;
    ah += 0.16 * (ridged(p * 6.0, 3, 2.0, 0.5) - 0.5);   // broad folds

    // Stitch seams: three dashed rows plus one dashed column.
    float stitch = 0.0;
    for (int i = 0; i < 3; i++) {
      float row = 0.16 + float(i) * 0.34;
      float dv = abs(fract(auv.y - row + 0.5) - 0.5);
      float line = 1.0 - smoothstep(0.005, 0.014, dv);
      float dash = 1.0 - smoothstep(0.20, 0.40, abs(fract(auv.x * 44.0) - 0.5));
      stitch = max(stitch, line * dash);
    }
    float du = abs(fract(auv.x + 0.5) - 0.5);
    float vline = 1.0 - smoothstep(0.005, 0.014, du);
    float vdash = 1.0 - smoothstep(0.20, 0.40, abs(fract(auv.y * 44.0) - 0.5));
    stitch = clamp(max(stitch, vline * vdash), 0.0, 1.0);

    ah += 0.85 * stitch;                                  // raised thread
  `,

  // Crossed fibre() noise over an over/under weave lattice, plus embroidery.
  cloth: /* glsl */ `
    float n = max(uThreads, 8.0);
    vec2 c = auv * n;
    vec2 f = fract(c);
    float over = mod(floor(c.x) + floor(c.y), 2.0);
    float weave = mix(sin(f.y * 3.141592653589793), sin(f.x * 3.141592653589793), over);

    vec3 p = vec3(auv, uSeed);
    // Each thread gets its own twist, stretched along its own axis.
    float fWarp = fibre(p * 190.0, vec3(0.0, 1.0, 0.0), 26.0, 3);
    float fWeft = fibre(p * 190.0 + 4.7, vec3(1.0, 0.0, 0.0), 26.0, 3);
    float fib = mix(fWeft, fWarp, over);

    ah = (weave - 0.5) * 1.15 + fib * 0.55;
    ah += 0.28 * fbm(p * 7.0, 4, 2.0, 0.5);               // slack and drape

    // Embroidery / runework, only for the embroidered and runic trims.
    vec2 q = fract(auv * 7.0) - 0.5;
    float r = length(q);
    float ang = atan(q.y, q.x);
    float ring  = 1.0 - smoothstep(0.012, 0.032, abs(r - 0.31));
    float ring2 = 1.0 - smoothstep(0.010, 0.028, abs(r - 0.175));
    float ticks = step(0.60, abs(sin(ang * 6.0)))
                * (1.0 - smoothstep(0.17, 0.30, r)) * step(0.09, r);
    float knot = 1.0 - smoothstep(0.020, 0.050,
                   abs(ridged(vec3(auv * 9.0, 2.5), 3, 2.0, 0.5) - 0.62));
    float emb = clamp(max(max(ring, ring2), max(ticks, knot * 0.85)), 0.0, 1.0);
    ah += uEmbroider * 0.55 * emb;
  `
};

// Surface response. Reads `auv` and `ah`, writes `aAlb`, `aRough`, `aMetal`, `aAo`.
const S_GLSL = {
  plate: /* glsl */ `
    vec3 p = vec3(auv, uSeed);
    float grime = 0.5 + 0.5 * fbm(p * 9.0, 4, 2.0, 0.55);

    // Enamelled panels take the class tint; the rest stays bare steel.
    float paint = smoothstep(0.36, 0.60, 0.5 + 0.5 * fbm(p * 3.0 + 5.0, 3, 2.0, 0.5));
    vec3 steel = uBase * (0.80 + 0.36 * grime);
    aAlb = mix(steel, mix(steel, uTint, uTintAmt), paint);

    // Only the deep pits and corrosion go dark — dents read through the
    // normal map, so they must not print themselves into the albedo.
    aAlb = mix(uDark, aAlb, smoothstep(-0.95, -0.22, ah));

    aMetal = uMetal * (1.0 - 0.40 * paint);
    aRough = uRough + 0.20 * (1.0 - smoothstep(-0.70, -0.05, ah)) + 0.10 * grime + 0.16 * paint;
    aAo = 0.40 + 0.60 * smoothstep(-1.0, -0.05, ah);
  `,

  mail: /* glsl */ `
    float s = max(uScale, 4.0);
    vec3 p = vec3(auv, uSeed);
    float ring = smoothstep(-0.55, 0.20, ah);
    float grime = 0.5 + 0.5 * fbm(p * 14.0, 4, 2.0, 0.55);

    // Cell id gives each link its own slight temper colour.
    float id = worley(p, s).z;
    vec3 steel = uBase * (0.78 + 0.40 * grime) * (0.90 + 0.20 * id);
    vec3 cloth = mix(uDark * (0.7 + 0.6 * grime), uTint * 0.35, uTintAmt * 0.5);

    aAlb = mix(cloth, mix(steel, uTint, uTintAmt * 0.45), ring);
    aMetal = mix(0.04, uMetal, ring);
    aRough = mix(0.88, uRough + 0.16 * grime, ring);
    aAo = 0.10 + 0.90 * smoothstep(-1.0, 0.05, ah);
  `,

  leather: /* glsl */ `
    vec3 p = vec3(auv, uSeed);
    float grime = 0.5 + 0.5 * fbm(p * 11.0, 4, 2.0, 0.55);

    float stitch = 0.0;
    for (int i = 0; i < 3; i++) {
      float row = 0.16 + float(i) * 0.34;
      float dv = abs(fract(auv.y - row + 0.5) - 0.5);
      float line = 1.0 - smoothstep(0.005, 0.014, dv);
      float dash = 1.0 - smoothstep(0.20, 0.40, abs(fract(auv.x * 44.0) - 0.5));
      stitch = max(stitch, line * dash);
    }
    float du = abs(fract(auv.x + 0.5) - 0.5);
    float vline = 1.0 - smoothstep(0.005, 0.014, du);
    float vdash = 1.0 - smoothstep(0.20, 0.40, abs(fract(auv.y * 44.0) - 0.5));
    stitch = clamp(max(stitch, vline * vdash), 0.0, 1.0);

    // Tint leather by multiplying rather than mixing, so a loud class colour
    // (Rogue's yellow) dyes the hide instead of replacing it.
    vec3 hide = uBase * (0.72 + 0.52 * grime);
    hide = mix(hide, hide * (uTint * 2.1 + 0.10), uTintAmt);
    hide = mix(uDark, hide, smoothstep(-0.85, -0.10, ah));

    // Waxed thread reads lighter and much rougher than the hide.
    aAlb = mix(hide, uTrim * (0.8 + 0.3 * grime), stitch);
    aMetal = mix(uMetal, 0.03, stitch);
    aRough = mix(uRough + 0.18 * (1.0 - grime), 0.72, stitch);
    aAo = 0.42 + 0.58 * smoothstep(-0.9, -0.05, ah);
  `,

  cloth: /* glsl */ `
    float n = max(uThreads, 8.0);
    vec2 c = auv * n;
    vec2 f = fract(c);
    float over = mod(floor(c.x) + floor(c.y), 2.0);
    float weave = mix(sin(f.y * 3.141592653589793), sin(f.x * 3.141592653589793), over);

    vec3 p = vec3(auv, uSeed);
    float grime = 0.5 + 0.5 * fbm(p * 8.0, 4, 2.0, 0.55);

    vec2 q = fract(auv * 7.0) - 0.5;
    float r = length(q);
    float ang = atan(q.y, q.x);
    float ring  = 1.0 - smoothstep(0.012, 0.032, abs(r - 0.31));
    float ring2 = 1.0 - smoothstep(0.010, 0.028, abs(r - 0.175));
    float ticks = step(0.60, abs(sin(ang * 6.0)))
                * (1.0 - smoothstep(0.17, 0.30, r)) * step(0.09, r);
    float knot = 1.0 - smoothstep(0.020, 0.050,
                   abs(ridged(vec3(auv * 9.0, 2.5), 3, 2.0, 0.5) - 0.62));
    float emb = uEmbroider * clamp(max(max(ring, ring2), max(ticks, knot * 0.85)), 0.0, 1.0);

    vec3 dyed = mix(uBase * (0.70 + 0.55 * grime), uTint, uTintAmt);
    // Warp and weft catch light differently — a faint shot-silk two-tone.
    dyed *= mix(0.92, 1.08, over);
    dyed = mix(uDark, dyed, smoothstep(-0.95, 0.05, ah));

    aAlb = mix(dyed, uTrim * (0.85 + 0.3 * grime), emb);
    aMetal = mix(uMetal, 0.22, emb);
    aRough = mix(uRough - 0.10 * weave + 0.10 * grime, 0.34, emb);
    aAo = 0.28 + 0.72 * smoothstep(-1.0, 0.10, ah);
  `
};

// Brushed direction + anisotropy strength. Reads `auv`, writes `aDir`, `aAniso`.
const F_GLSL = {
  plate: /* glsl */ `
    float a = 0.30 + 1.10 * fbm(vec3(auv * 2.2, uSeed), 3, 2.0, 0.5);
    aDir = vec2(cos(a), sin(a));
    aAniso = 0.72 + 0.28 * clamp(0.5 + 0.75 * fbm(vec3(auv * 8.5, uSeed + 4.0), 3, 2.0, 0.5), 0.0, 1.0);
  `,
  mail: /* glsl */ `
    // Follow the tangent of the ring this texel sits on.
    float s = max(uScale, 4.0);
    vec2 cc = (floor(auv * s) + 0.5) / s;
    vec2 d = auv - cc;
    float a = atan(d.y, d.x) + 1.5707963267948966;
    aDir = vec2(cos(a), sin(a));
    aAniso = 0.55;
  `,
  leather: /* glsl */ `
    float a = 1.2 * fbm(vec3(auv * 3.4, uSeed + 2.0), 3, 2.0, 0.5);
    aDir = vec2(cos(a), sin(a));
    aAniso = 0.30;
  `,
  cloth: /* glsl */ `
    float n = max(uThreads, 8.0);
    float over = mod(floor(auv.x * n) + floor(auv.y * n), 2.0);
    aDir = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), over);
    aAniso = 0.42;
  `
};

// Wear breakup noise, baked into the flow map's alpha channel.
const BREAKUP_EXPR = /* glsl */
  `clamp(0.5 + 0.75 * fbm(vec3(vUv * 5.0, uSeed + 9.13), 4, 2.0, 0.55), 0.0, 1.0)`;

function fragAlbedo(tier) {
  return /* glsl */ `
    vec2 auv = vUv;
    float ah = 0.0;
    { ${H_GLSL[tier]} }
    vec3 aAlb = vec3(0.0); float aRough = 0.5; float aMetal = 0.0; float aAo = 1.0;
    { ${S_GLSL[tier]} }
    gl_FragColor = vec4(clamp(aAlb, 0.0, 1.0), 1.0);
  `;
}

function fragNormal(tier) {
  const h = H_GLSL[tier];
  return /* glsl */ `
    float e = uTexel;
    float hL = 0.0; float hR = 0.0; float hD = 0.0; float hU = 0.0;
    { vec2 auv = vUv - vec2(e, 0.0); float ah = 0.0; ${h} hL = ah; }
    { vec2 auv = vUv + vec2(e, 0.0); float ah = 0.0; ${h} hR = ah; }
    { vec2 auv = vUv - vec2(0.0, e); float ah = 0.0; ${h} hD = ah; }
    { vec2 auv = vUv + vec2(0.0, e); float ah = 0.0; ${h} hU = ah; }
    gl_FragColor = vec4(normalFromHeights(hL, hR, hD, hU, uNormalStrength), 1.0);
  `;
}

// r = ambient occlusion, g = roughness, b = metalness — the exact channels
// three's aoMap / roughnessMap / metalnessMap read, so one map feeds three
// material slots. Absolute values: material.roughness/metalness stay at 1.
function fragOrm(tier) {
  return /* glsl */ `
    vec2 auv = vUv;
    float ah = 0.0;
    { ${H_GLSL[tier]} }
    vec3 aAlb = vec3(0.0); float aRough = 0.5; float aMetal = 0.0; float aAo = 1.0;
    { ${S_GLSL[tier]} }
    gl_FragColor = vec4(clamp(aAo, 0.0, 1.0), clamp(aRough, 0.04, 1.0), clamp(aMetal, 0.0, 1.0), 1.0);
  `;
}

// rg = brushed direction (unit vector, encoded), b = anisotropy strength,
// a = wear breakup noise. rg/b is exactly what three's anisotropyMap expects.
function fragFlow(tier) {
  return /* glsl */ `
    vec2 auv = vUv;
    vec2 aDir = vec2(1.0, 0.0); float aAniso = 0.0;
    { ${F_GLSL[tier]} }
    vec2 d = normalize(aDir + vec2(1e-5, 1e-5));
    gl_FragColor = vec4(d * 0.5 + 0.5, clamp(aAniso, 0.0, 1.0), ${BREAKUP_EXPR});
  `;
}

// ---------------------------------------------------------------------------
// Runtime shader injections
// ---------------------------------------------------------------------------

const VERT_PARS = /* glsl */ `
// Supplied by character/armor.js. If a geometry does not carry it, WebGL falls
// back to the generic vertex attribute, which material.defaultAttributeValues
// pins to 0 — a missing attribute yields "no trim", never a crash and never a
// failed compile.
attribute float aTrimMask;
varying float vArmorTrim;
varying vec2 vArmorUv;
`;

const VERT_BODY = /* glsl */ `
vArmorTrim = clamp(aTrimMask, 0.0, 1.0);
vArmorUv = uv;
`;

const FRAG_PARS = /* glsl */ `
varying float vArmorTrim;
varying vec2 vArmorUv;

uniform sampler2D uArmorFlowMap;
uniform vec3 uArmorTint;
uniform vec3 uArmorBare;
uniform vec3 uArmorTrimColor;
uniform vec3 uArmorKeyDir;
uniform float uArmorWear;
uniform float uArmorEdgeLo;
uniform float uArmorEdgeHi;
uniform float uArmorBareRough;
uniform float uArmorBareMetal;
uniform float uArmorTrimMetal;
uniform float uArmorTrimRough;
uniform float uArmorTrimEmissive;
uniform float uArmorRim;
uniform float uArmorRimPow;
uniform float uArmorPulse;
uniform float uArmorPulseAmt;
uniform float uArmorAnisoGain;
uniform float uArmorAnisoExp;
uniform float uArmorFlowScale;

vec3 armorSafeNormalize(vec3 v) {
  float l = length(v);
  return (l > 1e-5) ? v / l : vec3(0.0, 0.0, 1.0);
}
`;

// Injected after <emissivemap_fragment>: diffuseColor, roughnessFactor,
// metalnessFactor, normal, nonPerturbedNormal, vViewPosition and
// totalEmissiveRadiance are all live, and <lights_physical_fragment> (which
// consumes them) has not run yet.
const FRAG_SURFACE = /* glsl */ `
// ---- armor: curvature, wear, trim, rim -----------------------------------
vec4 armorFlowTexel = texture2D(uArmorFlowMap, vArmorUv * uArmorFlowScale);
float armorBreak = armorFlowTexel.a;

// Per-pixel curvature in 1/metres. Dividing by the squared view-space position
// derivative cancels the screen-size/perspective term, so this is a genuine
// surface curvature rather than a view-dependent edge detect.
vec3 armorViewP = -vViewPosition;
vec3 armorDpx = dFdx(armorViewP);
vec3 armorDpy = dFdy(armorViewP);
vec3 armorDnx = dFdx(nonPerturbedNormal);
vec3 armorDny = dFdy(nonPerturbedNormal);
float armorCurv = dot(armorDnx, armorDpx) / max(dot(armorDpx, armorDpx), 1e-9)
                + dot(armorDny, armorDpy) / max(dot(armorDpy, armorDpy), 1e-9);

float armorConvex = smoothstep(uArmorEdgeLo, uArmorEdgeHi, armorCurv);
float armorCavity = smoothstep(uArmorEdgeLo, uArmorEdgeHi, -armorCurv);

// Trim first — gilt does not rub through the way the field of the plate does.
float armorTrim = smoothstep(0.22, 0.72, vArmorTrim);

// Paint and patina come off the convex edges and expose brighter, smoother,
// more metallic base material. Broken up with baked noise so it never reads as
// a clean vector outline.
float armorWear = armorConvex * (0.45 + 1.05 * armorBreak) * uArmorWear;
armorWear = clamp(armorWear * (1.0 - 0.65 * armorTrim), 0.0, 1.0);

diffuseColor.rgb = mix(diffuseColor.rgb, uArmorBare, armorWear);
roughnessFactor = mix(roughnessFactor, uArmorBareRough, armorWear);
metalnessFactor = mix(metalnessFactor, uArmorBareMetal, armorWear);

// Cavities collect grime and go matte.
float armorGrime = armorCavity * (0.35 + 0.65 * (1.0 - armorBreak));
diffuseColor.rgb *= mix(1.0, 0.62, armorGrime * 0.75);
roughnessFactor = min(1.0, roughnessFactor + 0.22 * armorGrime);

// Trim / gilt: shift toward gold, raise metalness, drop roughness, add glow.
diffuseColor.rgb = mix(diffuseColor.rgb, uArmorTrimColor * (0.82 + 0.34 * armorBreak), armorTrim);
metalnessFactor = mix(metalnessFactor, uArmorTrimMetal, armorTrim);
roughnessFactor = mix(roughnessFactor, uArmorTrimRough, armorTrim);

// Slow breathing pulse — only meaningful on the high-emissive classes.
float armorPulse = 1.0 + uArmorPulseAmt * (uArmorPulse * 2.0 - 1.0) * 0.42;

totalEmissiveRadiance += uArmorTrimColor * (uArmorTrimEmissive * armorTrim * armorPulse);

// Class-coloured fresnel rim. Weighted toward the geometric normal so the rim
// stays a clean silhouette band instead of fizzing on normal-map detail.
vec3 armorV = armorSafeNormalize(vViewPosition);
vec3 armorRimN = armorSafeNormalize(mix(normal, nonPerturbedNormal, 0.65));
float armorFres = pow(1.0 - clamp(dot(armorRimN, armorV), 0.0, 1.0), uArmorRimPow);
totalEmissiveRadiance += uArmorTint * (uArmorRim * armorFres * armorPulse);

// Strength of the tinted anisotropic streak added at the outgoing-light stage:
// metal only, sharper as the surface polishes up, damped on the trim.
float armorAnisoAmt = armorFlowTexel.b * uArmorAnisoGain * metalnessFactor
                    * (0.30 + 0.70 * (1.0 - roughnessFactor))
                    * (1.0 - 0.5 * armorTrim);
`;

// Injected at the outgoing-light line, where material.anisotropyT — the
// view-space brush tangent three built from our flow map — is available.
const FRAG_OUTGOING_FIND =
  'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;';

const FRAG_OUTGOING = /* glsl */ `
vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
{
  // Kajiya-Kay anisotropic highlight, tinted by the class colour, riding on
  // top of three's own anisotropic lobe: brushed metal gets a stretched,
  // coloured glint rather than a round white dot.
  #if defined( USE_ANISOTROPY )
    vec3 armorT = armorSafeNormalize(material.anisotropyT);
  #elif defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP )
    vec3 armorT = armorSafeNormalize(tbn[0]);
  #else
    vec3 armorT = armorSafeNormalize(cross(normal, vec3(0.0, 1.0, 0.0)));
  #endif

  vec3 armorVdir = armorSafeNormalize(vViewPosition);
  vec3 armorL = armorSafeNormalize((viewMatrix * vec4(uArmorKeyDir, 0.0)).xyz);
  vec3 armorHalf = armorSafeNormalize(armorL + armorVdir);

  float armorTH = dot(armorT, armorHalf);
  float armorSinTH = sqrt(max(0.0, 1.0 - armorTH * armorTH));
  float armorNdL = clamp(dot(normal, armorL), 0.0, 1.0);
  float armorStreak = pow(armorSinTH, uArmorAnisoExp) * armorNdL;

  vec3 armorGlint = mix(uArmorTint, vec3(1.0), 0.45) * (diffuseColor.rgb * 2.5 + 0.25);
  outgoingLight += armorGlint * (armorStreak * armorAnisoAmt);
}
`;

// ---------------------------------------------------------------------------

function patch(src, find, replacement, label) {
  if (src.indexOf(find) === -1) {
    console.warn(`[armor material] shader chunk "${label}" not found; injection skipped`);
    return src;
  }
  // Function replacement so '$' sequences in the GLSL are never interpreted.
  return src.replace(find, () => replacement);
}

function normHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : fallback;
}

/**
 * Armor material — one material, four tiers.
 *
 * @param {{ bakery: object, renderer: object, envMap: (object|null) }} ctx
 * @param {{ klass?: object, tier?: string, tint?: string }} [params]
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createArmorMaterial(ctx, params = {}) {
  const bakery = ctx.bakery;

  // Uniforms we own. update() writes straight into these.
  const U = {
    uArmorFlowMap: { value: null },
    uArmorTint: { value: new THREE.Color(DEFAULT_KLASS.color) },
    uArmorBare: { value: new THREE.Color(TIER_ART.plate.bare) },
    uArmorTrimColor: { value: new THREE.Color(DEFAULT_TRIM.color) },
    uArmorKeyDir: { value: new THREE.Vector3(-0.45, 0.78, 0.44).normalize() },
    uArmorWear: { value: TIER_PROPS.plate.wear },
    uArmorEdgeLo: { value: TIER_ART.plate.edgeLo },
    uArmorEdgeHi: { value: TIER_ART.plate.edgeHi },
    uArmorBareRough: { value: TIER_ART.plate.bareRough },
    uArmorBareMetal: { value: TIER_ART.plate.bareMetal },
    uArmorTrimMetal: { value: DEFAULT_TRIM.metal },
    uArmorTrimRough: { value: DEFAULT_TRIM.rough },
    uArmorTrimEmissive: { value: DEFAULT_TRIM.emissive },
    uArmorRim: { value: 0.15 },
    uArmorRimPow: { value: 3.2 },
    uArmorPulse: { value: 0.5 },
    uArmorPulseAmt: { value: 0.0 },
    uArmorAnisoGain: { value: TIER_ART.plate.anisoGain },
    uArmorAnisoExp: { value: TIER_ART.plate.anisoExp },
    uArmorFlowScale: { value: 1.0 }
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // The packed ORM map carries absolute values, so these stay at 1 and act
    // as pure pass-throughs. Keeping them constant also keeps the shader's
    // roughnessFactor / metalnessFactor meaningful before our wear pass.
    metalness: 1.0,
    roughness: 1.0,
    emissive: 0x000000,
    envMapIntensity: 1.0,
    side: THREE.FrontSide,
    // Both of these are non-zero from the very first program and never return
    // to zero, so USE_ANISOTROPY / USE_SHEEN are baked into the single program
    // and update() can never trigger a recompile.
    anisotropy: 0.55,
    anisotropyRotation: 0.0,
    sheen: 0.02,
    sheenRoughness: 0.75
  });
  material.name = 'ArmorMaterial';

  // A geometry without `aTrimMask` resolves the attribute to 0, not garbage.
  material.defaultAttributeValues = { aTrimMask: [0] };

  if (ctx.envMap) material.envMap = ctx.envMap;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);

    let v = shader.vertexShader;
    v = patch(v, '#include <common>', `#include <common>\n${VERT_PARS}`, 'vertex common');
    v = patch(v, '#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`, 'begin_vertex');
    shader.vertexShader = v;

    let f = shader.fragmentShader;
    f = patch(f, '#include <common>', `#include <common>\n${FRAG_PARS}`, 'fragment common');
    f = patch(
      f,
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n${FRAG_SURFACE}`,
      'emissivemap_fragment'
    );
    f = patch(f, FRAG_OUTGOING_FIND, FRAG_OUTGOING, 'outgoingLight');
    shader.fragmentShader = f;
  };

  // One program for every armor material, regardless of class or tier.
  material.customProgramCacheKey = () => 'armor-material-v1';

  // --- baking -------------------------------------------------------------

  // Reused so a cache-hit update() does no allocation worth speaking of.
  const bakeColors = {
    uBase: new THREE.Color(),
    uDark: new THREE.Color(),
    uTint: new THREE.Color(),
    uTrim: new THREE.Color()
  };

  function bakeUniforms(tier, tintHex, trim) {
    const art = TIER_ART[tier];
    const props = TIER_PROPS[tier];
    bakeColors.uBase.set(art.base);
    bakeColors.uDark.set(art.dark);
    bakeColors.uTint.set(tintHex);
    bakeColors.uTrim.set(art.trimBake);
    return {
      uBase: bakeColors.uBase,
      uDark: bakeColors.uDark,
      uTint: bakeColors.uTint,
      uTrim: bakeColors.uTrim,
      uTintAmt: art.tintAmt,
      uScale: props.scaleSize,
      uRough: props.roughness,
      uMetal: props.metalness,
      uSeed: 11.37 + TIERS.indexOf(tier) * 3.7,
      uEmbroider: EMBROIDERED_TRIMS.has(trim.key) ? 1.0 : 0.0,
      uThreads: art.threads,
      uTexel: 1.0 / TEX,
      uNormalStrength: art.normalScale * 2.4
    };
  }

  // Cache keys carry every parameter that changes a texel: the tier, the tint
  // and (for the cloth embroidery) the trim style.
  function bakeSet(tier, tintHex, trim) {
    const stamp = `${tier}-${tintHex.slice(1)}-${trim.key}`;
    const u = bakeUniforms(tier, tintHex, trim);

    return {
      albedo: bakery.bake(`armor-albedo-${stamp}`, fragAlbedo(tier), {
        width: TEX, height: TEX, uniforms: u, colorSpace: THREE.SRGBColorSpace
      }),
      normal: bakery.bake(`armor-normal-${stamp}`, fragNormal(tier), {
        width: TEX, height: TEX, uniforms: u
      }),
      orm: bakery.bake(`armor-orm-${stamp}`, fragOrm(tier), {
        width: TEX, height: TEX, uniforms: u
      }),
      flow: bakery.bake(`armor-flow-${stamp}`, fragFlow(tier), {
        width: FLOW_TEX, height: FLOW_TEX, uniforms: u
      })
    };
  }

  const setCache = new Map();
  function getSet(tier, tintHex, trim) {
    const key = `${tier}|${tintHex}|${trim.key}`;
    let set = setCache.get(key);
    if (set === undefined) {
      set = bakeSet(tier, tintHex, trim);
      setCache.set(key, set);
    }
    return set;
  }

  // --- update -------------------------------------------------------------

  const state = { tier: null, tint: null, trimKey: null };

  function update(next) {
    const p = next ?? {};
    const klass = p.klass ?? DEFAULT_KLASS;
    const armor = klass.armor ?? DEFAULT_KLASS.armor;

    const tier = TIER_PROPS[p.tier]
      ? p.tier
      : (TIER_PROPS[armor.tier] ? armor.tier : 'plate');
    const tintHex = normHex(p.tint ?? klass.color, DEFAULT_KLASS.color);
    const trim = TRIM_ART[armor.trim] ?? DEFAULT_TRIM;

    const props = TIER_PROPS[tier];
    const art = TIER_ART[tier];

    // Swap textures only when the baked identity actually changed. Bakes are
    // cached, so a revisited class is a Map lookup.
    if (state.tier !== tier || state.tint !== tintHex || state.trimKey !== trim.key) {
      const set = getSet(tier, tintHex, trim);
      material.map = set.albedo;
      material.normalMap = set.normal;
      material.aoMap = set.orm;
      material.roughnessMap = set.orm;
      material.metalnessMap = set.orm;
      material.anisotropyMap = set.flow;
      U.uArmorFlowMap.value = set.flow;
      state.tier = tier;
      state.tint = tintHex;
      state.trimKey = trim.key;
    }

    // Scalar material properties — plain uniform writes, no define changes.
    material.normalScale.set(art.normalScale, art.normalScale);
    material.aoMapIntensity = art.aoIntensity;
    material.anisotropy = art.aniso;
    material.envMapIntensity = 1.0 + 0.25 * props.metalness;
    material.sheen = 0.02 + props.clothMix * 0.20;
    material.sheenColor.set(tintHex);

    // Our own uniforms.
    U.uArmorTint.value.set(tintHex);
    U.uArmorBare.value.set(art.bare);
    U.uArmorTrimColor.value.set(trim.color);
    if (trim.tinted > 0) U.uArmorTrimColor.value.lerp(U.uArmorTint.value, trim.tinted);

    U.uArmorWear.value = props.wear;
    U.uArmorEdgeLo.value = art.edgeLo;
    U.uArmorEdgeHi.value = art.edgeHi;
    U.uArmorBareRough.value = art.bareRough;
    U.uArmorBareMetal.value = art.bareMetal;
    // Trim on a soft tier is metallic thread, not a chrome inlay: pull its
    // metalness down and its roughness up in proportion to the tier's cloth
    // content, or gilt reads as a plastic sticker on a robe.
    U.uArmorTrimMetal.value = trim.metal * (1.0 - 0.72 * props.clothMix);
    U.uArmorTrimRough.value = trim.rough + (0.46 - trim.rough) * props.clothMix * 0.85;
    U.uArmorAnisoGain.value = art.anisoGain;
    U.uArmorAnisoExp.value = art.anisoExp;
    U.uArmorFlowScale.value = 1.0;

    const emissive = typeof armor.emissive === 'number' ? armor.emissive : 0.2;
    U.uArmorTrimEmissive.value = trim.emissive * (0.28 + 0.8 * emissive);

    // Class-coloured rim, scaled by the class's own emissive budget. Brighter
    // classes also get a slightly wider band.
    U.uArmorRim.value = emissive * 0.85;
    U.uArmorRimPow.value = 3.6 - emissive * 1.1;

    // Only the genuinely glowing classes breathe — Death Knight, Demon Hunter,
    // Warlock and Mage, with a whisper of it on Evoker. Subtle, not a strobe.
    U.uArmorPulseAmt.value = THREE.MathUtils.smoothstep(emissive, 0.45, 0.70);
  }

  function tick(t) {
    if (U.uArmorPulseAmt.value <= 0.001) return;
    U.uArmorPulse.value = 0.5 + 0.5 * Math.sin(t * 1.05);
  }

  function setEnvMap(envMap) {
    ctx.envMap = envMap;
    material.envMap = envMap ?? null;
  }

  material.userData.update = update;
  material.userData.tick = tick;
  material.userData.setEnvMap = setEnvMap;
  material.userData.uniforms = U;

  update(params);

  return material;
}
