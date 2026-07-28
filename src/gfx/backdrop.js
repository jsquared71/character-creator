// The stage the character stands on.
//
// Design rule for everything in this file: it must *support* the character and
// never compete with it. That means dark values, low local contrast, no sharp
// detail anywhere except the ground immediately under the feet, and a strong
// radial falloff so the silhouette always separates from what is behind it.
//
// Four layers, near to far:
//
//   1. ground     worn-stone disc, receives shadow, fades to nothing at the rim
//   2. contact    a multiply-blended pool of darkness that glues the feet down
//   3. inlay      faction-tinted glyph ring + counter-rotating rune ring
//   4. motes      instanced drifting particulate, for cheap parallax depth
//   5. sky        inverted sphere, baked atmospheric gradient + pillar hints
//
// Every texture comes from the Bakery. No external assets, nothing fetched.

import * as THREE from 'three';
import { FACTIONS } from '../data/races.js';

const TAU = 6.283185307179586;

// ---------------------------------------------------------------------------
// Spine workaround — see the note in the final report.
//
// three's standard fragment prefix unconditionally emits
//     float luminance( const in vec3 rgb ) { ... }
// (WebGLProgram, getLuminanceFunction) and NOISE_GLSL in src/gfx/glsl/noise.js
// declares `float luminance(vec3)` a second time, so *every* Bakery shader
// fails to link with "'luminance' : function already has a body". I own neither
// bakery.js nor noise.js, so I cannot fix it at the source.
//
// The only text the Bakery lets an author emit *ahead* of NOISE_GLSL is the
// uniform declaration block, which it builds by interpolating the keys of the
// `uniforms` object. Smuggling a #define through that channel renames the noise
// library's copy and leaves three's own alone. It costs one dead uniform and is
// inert if the spine is ever fixed — an unused macro expands to nothing.
const LUMA_FIX_KEY =
  'bakeryPad0;\n#define luminance noiseLuminance\nuniform float bakeryPad1';

function bake(bakery, key, body, opts = {}) {
  return bakery.bake(key, body, {
    ...opts,
    uniforms: { [LUMA_FIX_KEY]: 0.0, ...(opts.uniforms || {}) }
  });
}

// ---------------------------------------------------------------------------
// Shared GLSL: the ground height field.
//
// Baked into the albedo, the roughness and (four times, for the gradient) the
// normal map, so all three agree about where the stones and grooves are. The
// suffix keeps locals unique when the same field is evaluated several times in
// one shader.
// ---------------------------------------------------------------------------
function groundField(uvExpr, s, cheap = false) {
  const grainOct = cheap ? 3 : 4;
  const pitOct = cheap ? 2 : 3;
  return /* glsl */ `
  vec2 q${s} = ${uvExpr};
  vec2 c${s} = q${s} - 0.5;
  float r${s} = length(c${s}) * 2.0;
  float a${s} = atan(c${s}.y, c${s}.x);
  vec3 w${s} = worley(vec3(q${s} * 9.0, 0.0), 1.0);
  float seam${s} = w${s}.y - w${s}.x;
  // 1.0 on a flagstone face, 0.0 down in the mortar joint.
  float joint${s} = smoothstep(0.008, 0.070, seam${s});
  // Two concentric engraved rings + spokes between them: reads as a dais kerb
  // rather than a random tile field, and it is perfectly seam-free in polar.
  float ring${s} = max(
    1.0 - smoothstep(0.0, 0.013, abs(r${s} - 0.235)),
    1.0 - smoothstep(0.0, 0.009, abs(r${s} - 0.318)));
  float spoke${s} = (1.0 - smoothstep(0.0, 0.022, abs(sin(a${s} * 6.0))))
    * smoothstep(0.230, 0.245, r${s}) * (1.0 - smoothstep(0.310, 0.325, r${s}));
  float cut${s} = max(ring${s}, spoke${s});
  float grain${s} = fbm(vec3(q${s} * 34.0, 5.0), ${grainOct}, 2.2, 0.5);
  float pit${s} = smoothstep(0.55, 0.95, ridged(vec3(q${s} * 17.0, 11.0), ${pitOct}, 2.3, 0.55));
  float h${s} = joint${s} * 0.55 - cut${s} * 0.34 + grain${s} * 0.10 - pit${s} * 0.18;
  `;
}

// ---------------------------------------------------------------------------
// Bakes
// ---------------------------------------------------------------------------

function bakeGroundAlbedo(bakery) {
  return bake(bakery,
    'backdrop-ground-albedo-v1',
    /* glsl */ `
    ${groundField('vUv', '')}

    // Per-stone tonal variation, keyed off the worley cell id.
    float cellTone = fract(w.z * 7.31);
    vec3 stone = uStone * (0.80 + 0.40 * cellTone);
    stone *= 0.86 + 0.28 * grain;
    stone = mix(stone * 0.30, stone, joint);          // recessed mortar is darker
    stone = mix(stone, stone * 0.55, cut);            // engraved kerb likewise
    stone *= 1.0 - pit * 0.35;

    // Broad grime / damp patches. Big and soft so it never reads as texture noise.
    float grime = fbm(vec3(vUv * 3.0, 19.0), 5, 2.1, 0.55) * 0.5 + 0.5;
    stone *= mix(0.68, 1.12, grime);
    float dust = smoothstep(0.35, 0.9, fbm(vec3(vUv * 6.5, 41.0), 4, 2.0, 0.5) * 0.5 + 0.5);
    stone = mix(stone, stone * uDust, dust * 0.5);

    // Radial falloff to nothing. The bounds wobble with an angularly-continuous
    // fbm so the rim is never a perfect circle (no floating-platform edge).
    float wob = fbm(vec3(cos(a) * 2.0, sin(a) * 2.0, 3.0), 3, 2.0, 0.5) * 0.07;
    float fall = 1.0 - smoothstep(0.20 + wob, 0.94 + wob, r);
    fall = pow(clamp(fall, 0.0, 1.0), 1.5);
    stone *= fall;

    float alpha = smoothstep(0.0, 0.30, fall);
    gl_FragColor = vec4(stone, alpha);
    `,
    {
      width: 2048,
      height: 2048,
      wrap: THREE.ClampToEdgeWrapping,
      colorSpace: THREE.SRGBColorSpace,
      uniforms: {
        uStone: new THREE.Color(0.150, 0.147, 0.143),
        uDust: new THREE.Color(1.10, 1.02, 0.88)
      }
    }
  );
}

function bakeGroundRough(bakery) {
  return bake(bakery,
    'backdrop-ground-rough-v1',
    /* glsl */ `
    ${groundField('vUv', '', true)}
    float rough = mix(0.98, 0.62, joint);   // polished-ish faces, rough joints
    rough -= grain * 0.07;
    rough += pit * 0.12;
    rough = mix(rough, 0.99, cut);
    // Kill all specular response toward the rim so the fade never catches a
    // highlight and re-draws the edge we just spent a falloff hiding.
    rough = mix(rough, 1.0, smoothstep(0.38, 0.92, r));
    gl_FragColor = vec4(vec3(clamp(rough, 0.0, 1.0)), 1.0);
    `,
    { width: 512, height: 512, wrap: THREE.ClampToEdgeWrapping }
  );
}

function bakeGroundNormal(bakery) {
  const e = (1.6 / 1024).toFixed(6);
  return bake(bakery,
    'backdrop-ground-normal-v1',
    /* glsl */ `
    vec2 ex = vec2(${e}, 0.0);
    vec2 ey = vec2(0.0, ${e});
    ${groundField('vUv - ex', 'L', true)}
    ${groundField('vUv + ex', 'R', true)}
    ${groundField('vUv - ey', 'D', true)}
    ${groundField('vUv + ey', 'U', true)}
    vec3 n = normalFromHeights(hL, hR, hD, hU, 2.4);
    float rc = length(vUv - 0.5) * 2.0;
    // Flatten toward the rim, in step with the albedo fade.
    n = mix(n, vec3(0.5, 0.5, 1.0), smoothstep(0.35, 0.90, rc));
    gl_FragColor = vec4(n, 1.0);
    `,
    { width: 1024, height: 1024, wrap: THREE.ClampToEdgeWrapping }
  );
}

// A pool of darkness under the feet, multiplied over the ground. Real shadows
// do the directional work; this only supplies the ambient-occlusion contact
// that keeps the character from hovering.
function bakeContact(bakery) {
  return bake(bakery,
    'backdrop-contact-v1',
    /* glsl */ `
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float a = atan(c.y, c.x);
    float wob = fbm(vec3(cos(a) * 3.0, sin(a) * 3.0, 8.0), 3, 2.0, 0.5) * 0.10;
    float m = mix(0.44, 1.0, smoothstep(0.02, 0.62 + wob, r));
    m = mix(m, 1.0, smoothstep(0.78, 1.0, r));        // exact no-op at the border
    gl_FragColor = vec4(vec3(clamp(m, 0.0, 1.0)), 1.0);
    `,
    {
      width: 256,
      height: 256,
      wrap: THREE.ClampToEdgeWrapping,
      colorSpace: THREE.SRGBColorSpace
    }
  );
}

// Hero-select glyph ring. White mask; the faction tint is applied by the
// material so it can cross-fade without a re-bake.
function bakeGlyphRing(bakery) {
  return bake(bakery,
    'backdrop-inlay-glyph-v1',
    /* glsl */ `
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float a = atan(c.y, c.x);
    float seg = a / ${TAU.toFixed(9)} + 0.5;

    float ringA = 1.0 - smoothstep(0.0, 0.016, abs(r - 0.860));
    float ringB = 1.0 - smoothstep(0.0, 0.009, abs(r - 0.790));
    float ringC = 1.0 - smoothstep(0.0, 0.007, abs(r - 0.405));
    float ringD = 1.0 - smoothstep(0.0, 0.005, abs(r - 0.360));

    // Dashes riding between the two outer rings. Cell edges land in the gaps,
    // so the wrap at a = +/-pi is invisible.
    float n = 32.0;
    float idx = floor(seg * n);
    float fr = fract(seg * n);
    float present = step(0.34, hash1(vec2(idx, 4.0)));
    float band = smoothstep(0.793, 0.803, r) * (1.0 - smoothstep(0.850, 0.860, r));
    float dash = present * (1.0 - smoothstep(0.18, 0.33, abs(fr - 0.5))) * band;

    // Long tick marks crossing the outer ring at the cardinal-ish points.
    float tn = 8.0;
    float tidx = floor(seg * tn);
    float tfr = fract(seg * tn);
    float tick = step(0.30, hash1(vec2(tidx, 17.0)))
      * (1.0 - smoothstep(0.030, 0.055, abs(tfr - 0.5)))
      * smoothstep(0.815, 0.835, r) * (1.0 - smoothstep(0.900, 0.930, r));

    // Faint annular pool. Hollow in the middle so the feet stay unlit.
    float pool = smoothstep(0.02, 0.42, r) * (1.0 - smoothstep(0.44, 0.86, r)) * 0.075;

    float g = ringA * 0.95 + ringB * 0.50 + ringC * 0.32 + ringD * 0.18
            + dash * 0.85 + tick * 0.70 + pool;

    // Worn, uneven emission — a cast inlay, not a decal.
    g *= 0.70 + 0.30 * (fbm(vec3(cos(a) * 4.0, sin(a) * 4.0, r * 6.0), 4, 2.1, 0.55) * 0.5 + 0.5);
    g *= 1.0 - smoothstep(0.90, 1.0, r);

    gl_FragColor = vec4(vec3(1.0), clamp(g, 0.0, 1.0));
    `,
    { width: 1024, height: 1024, wrap: THREE.ClampToEdgeWrapping }
  );
}

// Outer rune band, counter-rotating against the glyph ring.
function bakeRuneRing(bakery) {
  return bake(bakery,
    'backdrop-inlay-runes-v1',
    /* glsl */ `
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float a = atan(c.y, c.x);
    float seg = a / ${TAU.toFixed(9)} + 0.5;

    float n = 20.0;
    float idx = floor(seg * n);
    float fr = fract(seg * n);
    float rnd = hash1(vec2(idx, 23.0));
    float rnd2 = hash1(vec2(idx, 61.0));

    float band = smoothstep(0.735, 0.755, r) * (1.0 - smoothstep(0.855, 0.880, r));
    float local = (r - 0.745) / 0.115;

    // Blocky rune glyphs: a couple of strokes per cell, present at random.
    float strokeV = 1.0 - smoothstep(0.030, 0.060, abs(fr - 0.30 - rnd * 0.16));
    float strokeH = (1.0 - smoothstep(0.06, 0.13, abs(local - 0.25 - rnd2 * 0.45)))
      * (1.0 - smoothstep(0.14, 0.26, abs(fr - 0.5)));
    float glyph = max(strokeV * step(0.42, rnd2), strokeH * step(0.30, rnd));
    glyph *= band;

    float hairline = 1.0 - smoothstep(0.0, 0.0045, abs(r - 0.905));

    float g = glyph * 0.55 + hairline * 0.40;
    g *= 0.65 + 0.35 * (fbm(vec3(cos(a) * 5.0, sin(a) * 5.0, 2.0), 3, 2.0, 0.5) * 0.5 + 0.5);
    g *= 1.0 - smoothstep(0.93, 1.0, r);

    gl_FragColor = vec4(vec3(1.0), clamp(g, 0.0, 1.0));
    `,
    { width: 1024, height: 1024, wrap: THREE.ClampToEdgeWrapping }
  );
}

// Equirect-ish backdrop. RGB is the neutral gradient, ALPHA is the mask of
// where the faction colour is allowed to tint — so a faction change is a
// uniform push, never a re-bake.
function bakeSky(bakery) {
  return bake(bakery,
    'backdrop-sky-v1',
    /* glsl */ `
    float u = vUv.x;
    float v = vUv.y;
    // Angularly continuous coords: every noise lookup below wraps seamlessly.
    float th = u * ${TAU.toFixed(9)};
    vec2 dir = vec2(cos(th), sin(th));

    // Base vertical gradient. Darkest right at the horizon, behind the
    // character's mid-body, so the silhouette always separates there.
    float above = smoothstep(0.50, 1.0, v);
    vec3 col = mix(uHorizon, uZenith, pow(above, 1.35));
    // Below the horizon falls away fast; the ground disc's own fade meets it.
    col *= 1.0 - smoothstep(0.50, 0.30, v) * 0.92;

    // Soft vault mottling, very low amplitude.
    float mottle = fbm(vec3(dir * 2.4, v * 3.0), 4, 2.1, 0.55);
    col *= 1.0 + mottle * 0.22;

    // Subtle vertical banding — drapes / flutes, blurred to nothing.
    float bandN = fbm(vec3(dir * 11.0, 0.5), 3, 2.0, 0.5);
    float bandFade = smoothstep(0.34, 0.62, v) * (1.0 - smoothstep(0.70, 0.95, v));
    col *= 1.0 + bandN * 0.30 * bandFade;

    // Pillar silhouettes. 18 around, integer count so the seam is clean, wide
    // smoothsteps so they stay defocused.
    float pn = 18.0;
    float pid = floor(u * pn);
    float pf = fract(u * pn);
    float pw = 0.13 + hash1(vec2(pid, 3.0)) * 0.11;
    float ptop = 0.585 + hash1(vec2(pid, 9.0)) * 0.075;
    float shape = 1.0 - smoothstep(pw, pw + 0.085, abs(pf - 0.5));
    float vert = (1.0 - smoothstep(ptop, ptop + 0.075, v)) * smoothstep(0.330, 0.430, v);
    float pillar = shape * vert;
    // Capital: a slightly wider block where the pillar tops out.
    float cap = (1.0 - smoothstep(pw + 0.05, pw + 0.13, abs(pf - 0.5)))
      * (1.0 - smoothstep(0.020, 0.045, abs(v - ptop)));
    pillar = clamp(pillar + cap * 0.8, 0.0, 1.0);
    col *= 1.0 - pillar * 0.62;

    // A cornice line above the colonnade, and a faint floor line below it.
    float cornice = (1.0 - smoothstep(0.006, 0.020, abs(v - 0.672))) * 0.35;
    col *= 1.0 - cornice;

    // Two broad, opposed light pools. These are what make it read as a place
    // with a source rather than a painted dome. Angular falloff is written with
    // cos() so it stays periodic across the sphere's UV seam.
    float dv1 = (v - 0.635) * 8.0;
    float dv2 = (v - 0.610) * 9.0;
    float pool = 0.0;
    pool += exp((cos(th - 1.5707963) - 1.0) * 5.0) * exp(-dv1 * dv1);
    pool += exp((cos(th + 1.9000000) - 1.0) * 6.5) * exp(-dv2 * dv2) * 0.7;
    pool *= 1.0 - pillar * 0.5;
    col += uZenith * pool * 1.5;

    // Ground haze band hugging the horizon.
    float haze = exp(-abs(v - 0.500) * 26.0);
    col += uHorizon * haze * 0.55;

    // Where the faction colour is allowed in: the pools, the haze, the upper
    // vault. Never the pillars, never the floor.
    float tint = clamp(pool * 1.1 + haze * 0.45 + above * 0.30 + bandN * 0.05 * bandFade, 0.0, 1.0);
    tint *= 1.0 - pillar * 0.75;

    gl_FragColor = vec4(max(col, vec3(0.0)), tint);
    `,
    {
      width: 2048,
      height: 1024,
      wrap: THREE.RepeatWrapping,
      colorSpace: THREE.SRGBColorSpace,
      uniforms: {
        uZenith: new THREE.Color(0.0210, 0.0225, 0.0270),
        uHorizon: new THREE.Color(0.0075, 0.0072, 0.0080)
      }
    }
  );
}

function bakeMote(bakery) {
  return bake(bakery,
    'backdrop-mote-v1',
    /* glsl */ `
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float core = exp(-r * r * 9.0);
    float halo = exp(-r * r * 2.4) * 0.30;
    float a = clamp((core + halo) * (1.0 - smoothstep(0.75, 1.0, r)), 0.0, 1.0);
    gl_FragColor = vec4(vec3(1.0), a);
    `,
    {
      width: 64,
      height: 64,
      wrap: THREE.ClampToEdgeWrapping,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false
    }
  );
}

// ---------------------------------------------------------------------------

const GROUND_RADIUS = 6.0;
const MOTE_COUNT = 280;
const MOTE_RADIUS = 3.1;
const MOTE_FLOOR = 0.04;
const MOTE_CEIL = 3.6;

export function createBackdrop({ scene, bakery }) {
  const group = new THREE.Group();
  group.name = 'backdrop';
  scene.add(group);

  // --- ground ---------------------------------------------------------------
  const groundGeo = new THREE.CircleGeometry(GROUND_RADIUS, 128);
  groundGeo.rotateX(-Math.PI / 2);

  const groundMat = new THREE.MeshStandardMaterial({
    map: bakeGroundAlbedo(bakery),
    normalMap: bakeGroundNormal(bakery),
    roughnessMap: bakeGroundRough(bakery),
    normalScale: new THREE.Vector2(0.65, 0.65),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.45,
    transparent: true,      // the alpha in the albedo dissolves the rim
    depthWrite: true,
    side: THREE.FrontSide
  });

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  ground.renderOrder = 0;
  ground.name = 'backdrop-ground';
  group.add(ground);

  // --- contact darkening ----------------------------------------------------
  const contactGeo = new THREE.CircleGeometry(1.25, 48);
  contactGeo.rotateX(-Math.PI / 2);
  const contactMat = new THREE.MeshBasicMaterial({
    map: bakeContact(bakery),
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,   // three only wires up MultiplyBlending in this mode
    transparent: true,
    depthWrite: false,
    toneMapped: false,      // must multiply the linear buffer, not a tonemapped 1.0
    fog: false
  });
  const contact = new THREE.Mesh(contactGeo, contactMat);
  contact.position.y = 0.0015;
  contact.renderOrder = 1;
  contact.name = 'backdrop-contact';
  group.add(contact);

  // --- inlay ----------------------------------------------------------------
  const glyphGeo = new THREE.CircleGeometry(1.15, 96);
  glyphGeo.rotateX(-Math.PI / 2);
  const glyphMat = new THREE.MeshBasicMaterial({
    map: bakeGlyphRing(bakery),
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });
  const glyph = new THREE.Mesh(glyphGeo, glyphMat);
  glyph.position.y = 0.004;
  glyph.renderOrder = 2;
  glyph.name = 'backdrop-inlay-glyph';
  group.add(glyph);

  const runeGeo = new THREE.CircleGeometry(1.62, 96);
  runeGeo.rotateX(-Math.PI / 2);
  const runeMat = new THREE.MeshBasicMaterial({
    map: bakeRuneRing(bakery),
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });
  const runes = new THREE.Mesh(runeGeo, runeMat);
  runes.position.y = 0.003;
  runes.renderOrder = 2;
  runes.name = 'backdrop-inlay-runes';
  group.add(runes);

  // --- distant backdrop -----------------------------------------------------
  const uFaction = { value: new THREE.Color(0, 0, 0) };
  const uFactionStrength = { value: 0.0 };
  const uBase = { value: new THREE.Color(1, 1, 1) };

  const skyMat = new THREE.MeshBasicMaterial({
    map: bakeSky(bakery),
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  skyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uFaction = uFaction;
    shader.uniforms.uFactionStrength = uFactionStrength;
    shader.uniforms.uBase = uBase;
    shader.fragmentShader =
      'uniform vec3 uFaction;\nuniform vec3 uBase;\nuniform float uFactionStrength;\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec4 skyTexel = texture2D( map, vMapUv );
        // The faction tint *modulates* the baked gradient instead of being added
        // to it. uFaction is luminance-normalised, so a retint shifts hue without
        // ever lifting the backdrop out of its value range — which is the whole
        // reason the character stays readable against it.
        diffuseColor.rgb *= skyTexel.rgb * mix( uBase, uFaction, skyTexel.a * uFactionStrength );
        diffuseColor.a = 1.0;
        `
      );
  };
  skyMat.customProgramCacheKey = () => 'backdrop-sky';

  const sky = new THREE.Mesh(new THREE.SphereGeometry(32, 64, 40), skyMat);
  sky.name = 'backdrop-sky';
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  group.add(sky);

  // --- drifting particulate -------------------------------------------------
  const moteGeo = new THREE.PlaneGeometry(1, 1);
  const moteMat = new THREE.MeshBasicMaterial({
    map: bakeMote(bakery),
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });
  const motes = new THREE.InstancedMesh(moteGeo, moteMat, MOTE_COUNT);
  motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  motes.frustumCulled = false;
  motes.renderOrder = 4;
  motes.name = 'backdrop-motes';
  group.add(motes);

  // Deterministic seeding — the dust looks the same every load.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const mote = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    const ang = rand() * TAU;
    // sqrt for uniform area density, biased slightly outward from the feet.
    const rad = MOTE_RADIUS * Math.sqrt(0.06 + rand() * 0.94);
    mote.push({
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      y: MOTE_FLOOR + rand() * (MOTE_CEIL - MOTE_FLOOR),
      rise: 0.018 + rand() * 0.055,
      sway: 0.05 + rand() * 0.16,
      f1: 0.10 + rand() * 0.22,
      f2: 0.07 + rand() * 0.18,
      phase: rand() * TAU,
      size: 0.007 + rand() * 0.014,
      twinkle: 0.5 + rand() * 1.4
    });
  }

  // The motes billboard toward whatever camera last drew them; one frame of
  // latency is invisible and it saves threading a camera through the contract.
  const camQuat = new THREE.Quaternion();
  motes.onBeforeRender = (_r, _s, camera) => {
    if (camera && camera.isCamera) camQuat.copy(camera.quaternion);
  };

  // --- faction state --------------------------------------------------------
  const curGlow = new THREE.Color();
  const tgtGlow = new THREE.Color();
  const curTrim = new THREE.Color();
  const tgtTrim = new THREE.Color();
  const curSky = new THREE.Color();
  const tgtSky = new THREE.Color();
  const tmpColor = new THREE.Color();

  let primed = false;

  function factionOf(f) {
    return FACTIONS[f] || FACTIONS.Neutral;
  }

  // Rescale a colour to unit luminance and pull it partway back to white, so it
  // can be used as a multiplicative tint: hue moves, value does not.
  function toTint(hex, saturation, out) {
    out.set(hex);
    const lum = Math.max(0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b, 1e-4);
    out.multiplyScalar(1 / lum);
    out.r = 1 + (out.r - 1) * saturation;
    out.g = 1 + (out.g - 1) * saturation;
    out.b = 1 + (out.b - 1) * saturation;
    return out;
  }

  function setFaction(f) {
    const spec = factionOf(f);
    tgtGlow.set(spec.glow);
    toTint(spec.primary, 0.5, tgtSky);
    // Gilt trim on the rune band, pulled a little toward the faction glow so it
    // still belongs to the palette.
    tgtTrim.set(spec.secondary).lerp(tgtGlow, 0.35);
    if (!primed) {
      primed = true;
      curGlow.copy(tgtGlow);
      curSky.copy(tgtSky);
      curTrim.copy(tgtTrim);
    }
  }
  setFaction('Neutral');
  primed = false;   // the first real setFaction from the store still snaps

  // Intensities. Deliberately small: this is a whisper of colour, not a light.
  const GLYPH_LEVEL = 0.30;
  const RUNE_LEVEL = 0.16;
  const MOTE_LEVEL = 0.16;
  const SKY_TINT = 0.85;

  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  function tick(t, dt) {
    const d = Math.min(Math.max(dt || 0, 0), 0.1);

    // Exponential smoothing — faction changes ease in over roughly a second.
    const k = 1 - Math.exp(-d * 2.2);
    curGlow.lerp(tgtGlow, k);
    curSky.lerp(tgtSky, k);
    curTrim.lerp(tgtTrim, k);

    // Inlay: slow breathing, and the two rings drift in opposite directions.
    const breath = 0.86 + 0.14 * Math.sin(t * 0.55);
    const breath2 = 0.88 + 0.12 * Math.sin(t * 0.37 + 1.9);
    glyphMat.color.copy(curGlow).multiplyScalar(GLYPH_LEVEL * breath);
    runeMat.color.copy(curTrim).multiplyScalar(RUNE_LEVEL * breath2);
    glyph.rotation.y += d * 0.020;
    runes.rotation.y -= d * 0.011;

    // Sky tint.
    uFaction.value.copy(curSky);
    uFactionStrength.value = SKY_TINT;

    // Motes take a hint of the faction colour but stay mostly neutral warm.
    tmpColor.setRGB(0.55, 0.53, 0.50).lerp(curGlow, 0.45);
    moteMat.color.copy(tmpColor).multiplyScalar(MOTE_LEVEL);

    const span = MOTE_CEIL - MOTE_FLOOR;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const m = mote[i];
      m.y += m.rise * d;
      if (m.y > MOTE_CEIL) {
        m.y -= span;
        // Nudge it sideways on respawn so columns never form.
        const ang = m.phase + m.y * 3.1;
        m.x += Math.cos(ang) * 0.22;
        m.z += Math.sin(ang) * 0.22;
        const rr = Math.hypot(m.x, m.z);
        if (rr > MOTE_RADIUS) {
          m.x *= MOTE_RADIUS / rr;
          m.z *= MOTE_RADIUS / rr;
        }
      }

      const swayX = Math.sin(t * m.f1 + m.phase) * m.sway;
      const swayZ = Math.cos(t * m.f2 + m.phase * 1.7) * m.sway * 0.7;
      pos.set(m.x + swayX, m.y, m.z + swayZ);

      // Fade in off the floor and out at the ceiling by shrinking to nothing —
      // cheaper than per-instance colour and it never pops.
      const h = (m.y - MOTE_FLOOR) / span;
      const fade = Math.min(h / 0.18, 1) * Math.min((1 - h) / 0.30, 1);
      const flicker = 0.75 + 0.25 * Math.sin(t * m.twinkle + m.phase);
      const s = m.size * Math.max(fade, 0) * flicker;
      scl.set(s, s, s);

      mat4.compose(pos, camQuat, scl);
      motes.setMatrixAt(i, mat4);
    }
    motes.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    scene.remove(group);
    groundGeo.dispose();
    contactGeo.dispose();
    glyphGeo.dispose();
    runeGeo.dispose();
    moteGeo.dispose();
    sky.geometry.dispose();
    groundMat.dispose();
    contactMat.dispose();
    glyphMat.dispose();
    runeMat.dispose();
    skyMat.dispose();
    moteMat.dispose();
    motes.dispose();
  }

  return { setFaction, tick, group, ground, dispose };
}
