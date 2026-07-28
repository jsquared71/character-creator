// Skin material.
//
// A MeshPhysicalMaterial extended through onBeforeCompile with two additions
// that separate "a person" from "a painted mannequin":
//
//   1. Pre-integrated subsurface scattering (Penner / d'Eon). Screen-space
//      derivatives of the object-space normal give a per-pixel curvature; that
//      curvature plus N·L indexes a small 2D LUT which is *baked* on the GPU by
//      numerically integrating the six-Gaussian skin diffusion profile around a
//      cylinder of the matching radius. Red scatters furthest, so the terminator
//      goes warm and the light bleeds through ears, nose knuckles and fingers.
//
//   2. A dual-lobe specular: one broad, soft, wet-looking lobe plus a tight
//      sharp one, weight-normalised so the pair can never put out more energy
//      than a single GGX lobe would. Skin is damp, not lacquered.
//
// Everything else (shadows, IBL, tone mapping, fog) is inherited from three's
// physical shader, which is exactly why this is not a raw ShaderMaterial.
//
// All four maps come from the Bakery and are cached by the parameters that
// actually change them, so re-selecting a race/tone you already visited is a
// map-pointer swap and a handful of uniform writes — no recompile, no re-bake.

import * as THREE from 'three';
import { RACES } from '../data/races.js';

// ---------------------------------------------------------------------------
// Per-race skin character. Values are art direction, not physics: how much the
// light bleeds, how coarse the pores are, how oily the T-zone reads.
// `sssTint` is a *multiplier* applied at the scattering terminator.
// ---------------------------------------------------------------------------
const RACE_SKIN = {
  Human:       { sss: 1.00, pore: 1.00, poreDepth: 1.00, rough: 0.50, oil: 1.00, mottle: 1.00, blush: 1.00, sssTint: [1.26, 0.70, 0.58] },
  Dwarf:       { sss: 0.88, pore: 0.86, poreDepth: 1.25, rough: 0.57, oil: 0.85, mottle: 1.30, blush: 1.35, sssTint: [1.30, 0.68, 0.55] },
  'Night Elf': { sss: 0.92, pore: 1.18, poreDepth: 0.72, rough: 0.44, oil: 1.05, mottle: 0.72, blush: 0.50, sssTint: [1.10, 0.66, 1.05] },
  Gnome:       { sss: 1.12, pore: 1.32, poreDepth: 0.80, rough: 0.47, oil: 1.10, mottle: 0.88, blush: 1.15, sssTint: [1.28, 0.70, 0.58] },
  Draenei:     { sss: 0.82, pore: 0.96, poreDepth: 0.95, rough: 0.43, oil: 1.00, mottle: 0.85, blush: 0.50, sssTint: [1.12, 0.64, 1.10] },
  Worgen:      { sss: 0.52, pore: 0.70, poreDepth: 1.38, rough: 0.66, oil: 0.55, mottle: 1.32, blush: 0.65, sssTint: [1.20, 0.74, 0.62] },
  Pandaren:    { sss: 0.68, pore: 0.74, poreDepth: 1.12, rough: 0.62, oil: 0.52, mottle: 1.05, blush: 0.60, sssTint: [1.18, 0.76, 0.66] },
  Orc:         { sss: 0.62, pore: 0.80, poreDepth: 1.45, rough: 0.61, oil: 0.75, mottle: 1.38, blush: 0.70, sssTint: [1.24, 0.78, 0.52] },
  Undead:      { sss: 0.32, pore: 0.92, poreDepth: 1.58, rough: 0.74, oil: 0.32, mottle: 1.55, blush: 0.22, sssTint: [1.02, 1.06, 0.82] },
  Tauren:      { sss: 0.54, pore: 0.70, poreDepth: 1.30, rough: 0.70, oil: 0.48, mottle: 1.18, blush: 0.58, sssTint: [1.22, 0.74, 0.60] },
  Troll:       { sss: 0.70, pore: 0.86, poreDepth: 1.32, rough: 0.55, oil: 0.95, mottle: 1.30, blush: 0.55, sssTint: [1.10, 0.80, 0.96] },
  'Blood Elf': { sss: 1.06, pore: 1.16, poreDepth: 0.70, rough: 0.44, oil: 1.10, mottle: 0.70, blush: 1.05, sssTint: [1.28, 0.70, 0.58] },
  Goblin:      { sss: 0.76, pore: 1.22, poreDepth: 1.20, rough: 0.57, oil: 1.15, mottle: 1.28, blush: 0.62, sssTint: [1.20, 0.86, 0.50] },
  Dracthyr:    { sss: 0.42, pore: 0.60, poreDepth: 1.10, rough: 0.48, oil: 0.80, mottle: 1.10, blush: 0.42, sssTint: [1.14, 0.78, 0.72] }
};

const DEFAULT_SKIN = RACE_SKIN.Human;
const DEFAULT_RACE = 'Human';
const DEFAULT_TONE = '#e1b899';

// Texture budgets. Normal carries the pore detail so it gets the most texels;
// the translucency mask is low frequency and cheap.
const ALBEDO_SIZE = 1024;
const NORMAL_SIZE = 2048;
const ROUGH_SIZE = 1024;
const THICK_SIZE = 512;

// Highest curvature the diffusion LUT resolves, in 1/mm (radius >= ~7mm).
const LUT_CURV_MAX = 0.14;
const LUT_W = 128;
const LUT_H = 64;

// Bounded albedo cache: albedo is the only map that varies with tone, so it is
// the only one that can multiply out. 32 keeps every race the user is likely to
// revisit resident while capping VRAM at a few hundred MB worst case.
const ALBEDO_CACHE_MAX = 32;

// Normal / roughness / thickness only vary with race and feature flags, but the
// normal map is 2048 square, so each resident race costs ~21 MB of it with mips.
// Eight covers "flip through the roster and come back" without unbounded VRAM.
const DETAIL_CACHE_MAX = 8;

// ---------------------------------------------------------------------------
// Bake shaders. `fragBody` is a statement list — the Bakery wraps it in main()
// and prepends the noise library, so no helper functions can be declared here.
//
// The bakes address regions of the UV atlas declared in character/body.js:
//
//   head   u 0.00..0.50  v 0.50..1.00   (local u 0.5 = face front, v 1 = crown)
//   torso  u 0.50..1.00  v 0.50..1.00
//   arms   v 0.25..0.50 (u < 0.5)   legs v 0.25..0.50 (u > 0.5)
//   hands / feet / ears / horns / tusks / tail   all in the v 0.125..0.25 row
//   detail strip                                v 0.00..0.125
//
// So "every extremity" is one horizontal band, and the T-zone is a vertical
// strip through the head island. If that atlas ever moves, the masks degrade to
// harmless low-contrast noise — the object-space face mask and the curvature
// term in the surface shader carry the same intent independently of UVs.
// ---------------------------------------------------------------------------

// Reusable snippet: remaps a global UV into head-island-local coordinates and
// reports whether we are inside it at all.
//
// The head island is a full 360-degree sweep, so local u is an *angular*
// fraction: one unit of u is a whole turn, u = 0.5 is dead ahead, and the flat
// facial plane only spans about +/- 40 degrees, i.e. u = 0.5 +/- 0.11. The
// first version faded faceFront out over 0.10..0.38, which is still half-on at
// the ears and only reaches zero 137 degrees off the midline — every "face"
// effect wrapped most of the way around the skull as a horizontal band. That
// band is what flattened the mid-face.
//
// Local v is latitude: uy = -cos(v * PI), v = 1 at the crown. Human landmarks:
//   chin 0.215   mouth 0.320   nose base 0.376   nose tip 0.411
//   eyes 0.515   brow 0.554    hairline 0.650    crown 1.000
const HEAD_LOCAL = /* glsl */ `
  float inHead = step(uv.x, 0.5) * step(0.5, uv.y);
  vec2 hp = vec2(uv.x * 2.0, (uv.y - 0.5) * 2.0);
  float hAx = abs(hp.x - 0.5);
  float faceFront = 1.0 - smoothstep(0.060, 0.155, hAx);
`;

// Reusable snippet: the atlas row that holds every extremity island.
const EXTREMITY_ROW = /* glsl */ `
  float extremityRow = smoothstep(0.118, 0.148, uv.y) * (1.0 - smoothstep(0.232, 0.262, uv.y));
`;

// Penner's pre-integrated diffusion ramp.
//
//   D(theta, r) = INT( max(cos(theta + x), 0) * R(2 r sin(x/2)) dx )
//               / INT( R(2 r sin(x/2)) dx )
//
// R is d'Eon's six-Gaussian skin profile (variances in mm^2). The common 1/2pi
// factor of every Gaussian cancels in the ratio, so only w * exp(...) / v is
// needed. The integration window narrows with radius, otherwise a nearly flat
// patch would sample a delta function with 64 taps and come back as noise.
const LUT_FRAG = /* glsl */ `
  float ndl = clamp(vUv.x * 2.0 - 1.0, -1.0, 1.0);
  float theta = acos(ndl);
  float curv = vUv.y * uCurvMax;
  float radius = 1.0 / max(curv, 0.002);

  float xLimit = min(3.14159265, 26.0 / radius);
  vec3 num = vec3(0.0);
  vec3 den = vec3(0.0);

  for (int i = 0; i < 64; i++) {
    float t = (float(i) + 0.5) / 64.0;
    float x = (t * 2.0 - 1.0) * xLimit;
    float dist = abs(2.0 * radius * sin(x * 0.5)) * uScatterScale;
    float r2 = dist * dist;

    vec3 w = vec3(0.233, 0.455, 0.649) * (exp(-r2 / 0.0128) / 0.0064)
           + vec3(0.100, 0.336, 0.344) * (exp(-r2 / 0.0968) / 0.0484)
           + vec3(0.118, 0.198, 0.000) * (exp(-r2 / 0.3740) / 0.1870)
           + vec3(0.113, 0.007, 0.007) * (exp(-r2 / 1.1340) / 0.5670)
           + vec3(0.358, 0.004, 0.000) * (exp(-r2 / 3.9800) / 1.9900)
           + vec3(0.078, 0.000, 0.000) * (exp(-r2 / 14.820) / 7.4100);

    num += max(cos(theta + x), 0.0) * w;
    den += w;
  }

  vec3 d = num / max(den, vec3(1e-8));
  gl_FragColor = vec4(clamp(d, 0.0, 1.0), 1.0);
`;

const ALBEDO_FRAG = /* glsl */ `
  vec2 uv = vUv;
  vec3 p = vec3(uv, uSeed);

  // Dermal unevenness. Skin varies mostly in *hue* and only slightly in value;
  // the first pass spent 0.23 of luminance on three noise bands whose middle
  // octave landed at roughly one cycle per cheek, which is the exact frequency
  // the eye reads as a blotch rather than as skin. Value variation is now a
  // fifth of that and the medium band has been pushed up to a frequency that
  // reads as texture, with the removed contrast moved into a warm/cool drift.
  float drift = fbm(p * 2.2, 4, 2.05, 0.55);
  float mott  = fbm(p * 17.0 + 11.3, 3, 2.30, 0.50);
  float grain = fbm(p * 62.0 + 3.1, 2, 2.40, 0.55);

  vec3 col = uTone * (1.0 + (drift * 0.048 + mott * 0.026 + grain * 0.018) * uMottle);
  // Perfusion drift: warmer where blood runs close, cooler over bone. Same
  // energy as a luminance wobble but it reads as living tissue, not paint.
  vec3 warmCool = mix(vec3(0.975, 1.005, 1.030), vec3(1.045, 0.988, 0.958),
                      drift * 0.5 + 0.5);
  col *= mix(vec3(1.0), warmCool, clamp(uMottle, 0.0, 1.4));

  // Capillary blush. Real blush is three soft spots — the apples of the cheeks,
  // the tip of the nose and the lips — not a band across the whole mid-face.
${EXTREMITY_ROW}
${HEAD_LOCAL}
  float cy = (hp.y - 0.452) / 0.070;
  float cx = (hAx - 0.082) / 0.050;
  float cheeks = exp(-cy * cy) * exp(-cx * cx);
  float ny = (hp.y - 0.402) / 0.042;
  float nx = (hp.x - 0.5) / 0.034;
  float noseTip = exp(-ny * ny) * exp(-nx * nx);
  float ly = (hp.y - 0.322) / 0.030;
  float lx = (hp.x - 0.5) / 0.055;
  float lips = exp(-ly * ly) * exp(-lx * lx);
  float faceBlush = inHead * faceFront * max(cheeks * 0.70, max(noseTip * 0.85, lips * 0.60));

  // Extremities redden too, but the hand island butts straight onto the arm
  // island in the atlas: pushing it to 0.85 put a hard colour step at the
  // wrist. Kept low enough that the seam reads as skin tone, not as a glove.
  float region = max(extremityRow * 0.58, faceBlush);

  float blushN = fbm(p * 5.6 + 21.7, 3, 2.10, 0.55) * 0.5 + 0.5;
  float blush = clamp(blushN * 0.14 + region, 0.0, 1.0) * uBlush;
  col = mix(col, col * uBlushTint, blush * 0.26);

  // Knuckles and ear rims also darken slightly, not just redden.
  col *= 1.0 - extremityRow * 0.03 * uBlush;

  // Pigment specks / freckles. Denser and far shallower: at 96 cells across the
  // atlas a speck was ~11 texels wide on the face and 20% dark, which at face
  // framing is a mole, not a freckle.
  vec3 fw = worley(vec3(uv, uSeed * 0.37), 168.0);
  float speck = smoothstep(0.30, 0.0, fw.x) * step(0.80, fw.z);
  col *= 1.0 - speck * 0.075 * uMottle;

  // Heavy brow => weathered hide: ridged shading, a touch desaturated. The
  // frequencies here matter more than the amplitude — at 6.5 cycles across the
  // atlas a "weathering" ridge was a cheek wide, so an Orc came out in camo
  // patches. Weathering belongs in the normal map; the albedo only tints it.
  if (uWeather > 0.001) {
    float weather = ridged(p * 22.0 + 7.7, 3, 2.20, 0.55);
    col = mix(col, col * (0.90 + 0.17 * weather), uWeather);
    col = mix(col, vec3(luminance(col)), uWeather * 0.14);
    float pit = worley(vec3(uv, uSeed + 5.0), 110.0).x;
    col *= 1.0 - smoothstep(0.38, 0.0, pit) * uWeather * 0.07;
  }

  // Scaled races: worley plates with darker seams and per-cell tonal variation.
  if (uScales > 0.001) {
    vec3 sc = worley(vec3(uv, uSeed * 0.71), uScaleFreq);
    float seam = smoothstep(0.0, 0.14, sc.y - sc.x);
    vec3 plate = uTone * (0.80 + 0.42 * sc.z);
    plate *= mix(0.55, 1.08, seam);
    plate *= 1.0 + fbm(vec3(uv * 60.0, uSeed), 3, 2.3, 0.5) * 0.10;
    col = mix(col, plate, uScales);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
`;

// Pore normal. Four taps of a height field, central differences, packed by the
// noise library's normalFromHeights (OpenGL green-up convention).
//
// Everything in here is deliberately *shallow*. The head island is a quarter of
// the sheet and the face is a fraction of that again, so a pore only gets a
// couple of texels, and at a couple of texels a deep dip is not a pore: the
// central difference tilts the normal 25-30 degrees and it renders as a black
// speck. The first pass ran 200 cells across a 1024 sheet (five texels a pore)
// at full depth, on top of an fbm micro-relief band of nearly the same
// amplitude an octave below — and that band, not the pores, is what produced
// the quilted, blotchy surface. Pore depth is now a third of the relief budget
// and the micro-relief is a tenth of what it was.
const NORMAL_FRAG = /* glsl */ `
  float h0 = 0.0, h1 = 0.0, h2 = 0.0, h3 = 0.0;

  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(-1.0, 0.0);
    if (i == 1) o = vec2(1.0, 0.0);
    else if (i == 2) o = vec2(0.0, -1.0);
    else if (i == 3) o = vec2(0.0, 1.0);

    vec2 uv = vUv + o * uTexel;
    vec3 p = vec3(uv, uSeed);

    // Pores: worley cell centres punched inward, but only ~2/3 of the cells,
    // so the field never reads as a regular grid.
    vec3 cw = worley(p, uPoreScale);
    float open = step(0.34, fract(cw.z * 7.31 + uSeed));
    float pore = (1.0 - smoothstep(0.0, 0.42, cw.x)) * open;
    float h = -pore * 0.70 * uPoreDepth;

    // Coarser cell borders - the shallow creases that divide skin into plates.
    // Raised from 0.26x to 0.55x of the pore frequency: at 0.26x these were
    // half-centimetre furrows on a face, which is a quilt, not skin.
    vec3 bw = worley(p + vec3(3.7, 1.9, 0.0), uPoreScale * 0.55);
    h -= (1.0 - smoothstep(0.0, 0.26, bw.y - bw.x)) * 0.110;

    // Micro relief, an octave above the pores so mips fold it away at distance.
    h += fbm(vec3(uv * uPoreScale * 1.15, uSeed * 1.7), 2, 2.4, 0.55) * 0.075;

    if (uWeather > 0.001) {
      h += (ridged(vec3(uv * 96.0, uSeed + 2.3), 3, 2.2, 0.50) - 0.62) * uWeather * 0.16;
    }
    if (uScales > 0.001) {
      vec3 sw = worley(p + vec3(9.1, 4.3, 0.0), uScaleFreq);
      // Scale plates are a genuine macro feature, so they keep a much larger
      // share of the relief budget than pores do - but the budget itself is
      // now a third of what it was, so these come down with it.
      float sh = -(1.0 - smoothstep(0.0, 0.34, sw.y - sw.x)) * 0.42
                 + (1.0 - sw.x) * 0.20 + sw.z * 0.09;
      h = mix(h, sh, uScales);
    }

    if (i == 0) h0 = h;
    else if (i == 1) h1 = h;
    else if (i == 2) h2 = h;
    else h3 = h;
  }

  gl_FragColor = vec4(normalFromHeights(h0, h1, h2, h3, uStrength), 1.0);
`;

const ROUGH_FRAG = /* glsl */ `
  vec2 uv = vUv;
  float broad = fbm(vec3(uv * 7.0, uSeed), 3, 2.10, 0.55) * 0.5 + 0.5;
  float fine  = fbm(vec3(uv * 44.0, uSeed + 4.0), 3, 2.40, 0.50) * 0.5 + 0.5;

  float r = uRoughBase;
  // Gloss variation is far more visible than albedo variation under a key
  // light, so the broad band gets less swing than the fine one, not more.
  r += (broad - 0.5) * 0.075 + (fine - 0.5) * 0.085;

  // Pore floors hold oil and read slightly rougher than the plateaus.
  vec3 cw = worley(vec3(uv, uSeed), uPoreScale);
  r += (1.0 - smoothstep(0.0, 0.45, cw.x)) * 0.05;

  // Sebaceous T-zone. It is a T: a bar across the forehead and a strip down the
  // bridge of the nose. The first version was a rectangle spanning local v
  // 0.34..0.82 and 0.15 of a turn either side of the midline - a slab covering
  // the whole mid-face from the mouth to the top of the skull. Under the key
  // light that is a single flat gloss plate, and it is the main reason the face
  // read as painted clay with the form washed out of it.
  // uHeadBand is the local-v span of the T: x at the nose base, y at the
  // hairline.
${HEAD_LOCAL}
  float tzFy = (hp.y - mix(uHeadBand.x, uHeadBand.y, 0.90)) / 0.055;
  float forehead = exp(-tzFy * tzFy) * (1.0 - smoothstep(0.045, 0.115, hAx));
  float tzNy = (hp.y - mix(uHeadBand.x, uHeadBand.y, 0.32)) / 0.075;
  float tzNx = hAx / 0.030;
  float bridge = exp(-tzNy * tzNy) * exp(-tzNx * tzNx);
  float tzCy = (hp.y - 0.245) / 0.045;
  float chin = exp(-tzCy * tzCy) * (1.0 - smoothstep(0.030, 0.075, hAx));
  float tz = inHead * faceFront * max(max(forehead, bridge), chin * 0.6);
  tz *= 0.55 + 0.45 * (fbm(vec3(uv * 40.0, uSeed + 8.0), 3, 2.2, 0.5) * 0.5 + 0.5);
  r -= tz * 0.11 * uOil;

  // Palms, soles and ear rims are drier and more matte than the rest.
${EXTREMITY_ROW}
  r += extremityRow * 0.05;

  if (uWeather > 0.001) {
    r += (ridged(vec3(uv * 34.0, uSeed + 2.0), 3, 2.2, 0.5) - 0.55) * uWeather * 0.11;
  }
  if (uScales > 0.001) {
    vec3 sc = worley(vec3(uv, uSeed * 0.71), uScaleFreq);
    float scaleR = uRoughBase * 0.70 + sc.z * 0.12 + smoothstep(0.0, 0.14, sc.y - sc.x) * -0.04;
    r = mix(r, scaleR, uScales * 0.85);
  }

  gl_FragColor = vec4(vec3(clamp(r, 0.10, 0.96)), 1.0);
`;

// Translucency mask: how much of the pre-integrated term is allowed through.
const THICK_FRAG = /* glsl */ `
  vec2 uv = vUv;
  float n = fbm(vec3(uv * 3.4, uSeed + 13.0), 4, 2.1, 0.55) * 0.5 + 0.5;
  float t = 0.44 + n * 0.14;

  // The extremity row is where light genuinely punches through: ear blades,
  // fingertips, the webbing between digits. Open it up — but not to 0.98. The
  // hand island butts onto the arm island in the atlas but not in space, so a
  // near-saturated step here shows up as a pale, washed-out glove ending at a
  // hard line across the wrist.
${EXTREMITY_ROW}
  t = mix(t, 0.86, extremityRow * 0.80);

  // Nose wings, ear roots and lips on the head island get most of the way there
  // too - but only those. The first version opened a band from local v 0.26 to
  // 0.62 across the full (over-wide) faceFront window, which is chin to eyes,
  // ear to ear. The pre-integrated ramp spreads a lit surface out rather than
  // brightening it, so a wide high-thickness patch reads as a *dark* warm band
  // across the mid-face - the second half of the flattening.
${HEAD_LOCAL}
  float thNy = (hp.y - 0.398) / 0.055;
  float thNx = hAx / 0.055;
  float noseT = exp(-thNy * thNy) * exp(-thNx * thNx);
  float thLy = (hp.y - 0.322) / 0.036;
  float thLx = hAx / 0.060;
  float lipT = exp(-thLy * thLy) * exp(-thLx * thLx);
  t = mix(t, 0.92, inHead * faceFront * max(noseT, lipT * 0.85));
  // Ear roots sit on the head island at roughly a quarter turn off the midline.
  float thEy = (hp.y - 0.470) / 0.090;
  float thEx = (hAx - 0.235) / 0.045;
  t = mix(t, 0.85, inHead * exp(-thEy * thEy) * exp(-thEx * thEx));

  // The crown of the skull is the thickest thing on the body.
  t *= 1.0 - inHead * smoothstep(0.80, 0.98, hp.y) * 0.35;

  // Veining: thin, high-contrast filaments where light punches through.
  float vein = ridged(vec3(uv * 16.0, uSeed + 21.0), 4, 2.3, 0.55);
  t += smoothstep(0.80, 0.97, vein) * 0.07;

  t *= mix(1.0, 0.50, uScales);
  t *= mix(1.0, 0.72, uWeather);
  gl_FragColor = vec4(vec3(clamp(t, 0.0, 1.0)), 1.0);
`;

// ---------------------------------------------------------------------------
// Surface shader injections.
// ---------------------------------------------------------------------------

const VERT_COMMON = /* glsl */ `
#include <common>
varying vec3 vSkNormal;
varying vec3 vSkPos;
varying vec2 vSkUv;
`;

// Object space, deliberately: the whole character group auto-rotates about Y,
// so a world-space "which way is the face pointing" test would swim.
const VERT_BODY = /* glsl */ `
#include <project_vertex>
	vSkPos = transformed;
	vSkNormal = normalize( objectNormal );
	vSkUv = uv;
`;

const FRAG_COMMON = /* glsl */ `
#include <common>
uniform sampler2D uSkSssLut;
uniform sampler2D uSkThickness;
uniform vec3 uSkSssTint;
uniform vec3 uSkExtremityTint;
uniform float uSkSssStrength;
uniform float uSkCurvGain;
uniform float uSkBodyHeight;
uniform float uSkExtremity;
uniform float uSkOil;
uniform float uSkSpecBroad;
uniform float uSkSpecTight;
uniform float uSkSpecRoughBroad;
uniform float uSkSpecRoughTight;
uniform float uSkTime;
varying vec3 vSkNormal;
varying vec3 vSkPos;
varying vec2 vSkUv;
float skCurvature;
float skSss;
`;

// Runs immediately before the PhysicalMaterial struct is assembled, so the
// roughness and albedo it writes are the ones the BRDF sees.
const FRAG_SURFACE = /* glsl */ `
	vec3 skN = normalize( vSkNormal );
	float skCurvRaw = length( fwidth( skN ) ) / max( length( fwidth( vSkPos ) ), 1e-4 );

	// Soft saturation instead of a clamp. The head grid now spends four to five
	// times as many rows on the facial band, so a lip groove or a nostril
	// undercut is a two-millimetre radius sitting next to a hundred-millimetre
	// cheek: through a hard clamp the face came back as a binary mask, 1 on
	// every crease and 0.1 everywhere else, and everything keyed off curvature
	// (gloss, warmth, scattering) inherited that mask as mottled patches at the
	// scale of the tessellation. x/(1+x) keeps the same ordering, never
	// saturates, and leaves broad form legible.
	float skC = max( skCurvRaw, 0.0 ) * uSkCurvGain;
	skCurvature = skC / ( 1.0 + skC );

	// Wide band on purpose: uSkBodyHeight is the race baseline, while the live
	// figure carries a +/-18% height slider and a per-race head scale on top.
	float skYn = clamp( vSkPos.y / max( uSkBodyHeight, 0.1 ), 0.0, 1.0 );
	float skHead = smoothstep( 0.68, 0.86, skYn );
	// The baked roughness map already places the T-zone from the UVs, where it
	// can actually be shaped like a T. This term only keeps the front of the
	// head marginally damper than the back, so it must stay small - at 0.17,
	// modulated by a saturating curvature, it was a second full-strength gloss
	// pass over the whole front hemisphere of the skull.
	float skFace = skHead * smoothstep( 0.02, 0.62, skN.z );

	// A whisper of moving sheen so the surface is never dead still.
	float skSweat = 1.0 + 0.025 * sin( uSkTime * 0.6 + vSkPos.y * 3.0 );
	roughnessFactor = clamp( roughnessFactor - skFace * 0.045 * uSkOil * skSweat
		+ ( 1.0 - skHead ) * 0.02, 0.055, 1.0 );

	// Cartilage and thin tissue run warmer even before any light hits them.
	// Retuned for the soft curvature response: only a genuinely tight radius
	// (an ear rim, a nose tip, a fingertip) gets there, not every crease.
	float skTip = smoothstep( 0.42, 0.92, skCurvature );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uSkExtremityTint,
		skTip * uSkExtremity );

	float skThick = texture2D( uSkThickness, vSkUv ).r;
	skSss = clamp( uSkSssStrength * skThick * ( 0.45 + 0.65 * skCurvature ), 0.0, 1.0 );

#include <lights_physical_fragment>
`;

// Replaces three's RE_Direct for this material only. Same signature, so
// lights_fragment_begin calls it unchanged.
const FRAG_LIGHTING = /* glsl */ `
#include <lights_physical_pars_fragment>

vec3 skGGXLobe( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 f0, const in float f90, const in float rough ) {
	float alpha = pow2( clamp( rough, 0.025, 1.0 ) );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	float Vis = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
	float D = D_GGX( alpha, dotNH );
	return F * ( Vis * D );
}

void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

	float dotNL = dot( geometryNormal, directLight.direction );
	vec3 irradiance = saturate( dotNL ) * directLight.color;

	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif

	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif

	// --- dual-lobe specular -------------------------------------------------
	// Broad lobe = the soft oily wash across the whole surface. Tight lobe =
	// the sharp glint off the T-zone and the lip line. Weights are renormalised
	// whenever they exceed one so the pair is never brighter than a single GGX.
	float rBroad = clamp( material.roughness * uSkSpecRoughBroad + 0.16, 0.08, 1.0 );
	float rTight = clamp( material.roughness * uSkSpecRoughTight, 0.035, 1.0 );
	float wSum = max( uSkSpecBroad + uSkSpecTight, 1.0 );
	float wBroad = uSkSpecBroad / wSum;
	float wTight = uSkSpecTight / wSum;

	vec3 spec = wBroad * skGGXLobe( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularF90, rBroad )
		+ wTight * skGGXLobe( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularF90, rTight );

	reflectedLight.directSpecular += irradiance * spec;

	// --- pre-integrated subsurface diffusion --------------------------------
	// The LUT already carries the cosine falloff, so it replaces N dot L outright
	// rather than multiplying it. directLight.color is post-shadow, so bleed
	// still respects the shadow map.
	vec2 lutUv = vec2( clamp( dotNL * 0.5 + 0.5, 0.004, 0.996 ), clamp( skCurvature, 0.004, 0.996 ) );
	vec3 diffusion = texture2D( uSkSssLut, lutUv ).rgb;

	float warmth = min( saturate( ( diffusion.r - diffusion.b ) * 2.0 ), 0.8 );
	vec3 sssIrradiance = directLight.color * diffusion * mix( vec3( 1.0 ), uSkSssTint, warmth );

	reflectedLight.directDiffuse += mix( irradiance, sssIrradiance, skSss ) * BRDF_Lambert( material.diffuseColor );

}

#undef RE_Direct
#define RE_Direct RE_Direct_Skin
`;

// ---------------------------------------------------------------------------

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Kept small: the seed rides in the z slot of the noise coordinate and gets
  // multiplied by the pattern frequency, so a huge value would eat mantissa.
  return ((h >>> 0) % 8000) / 1000;
}

function raceHeight(name) {
  const r = RACES.find((x) => x.name === name);
  return r ? r.build.height : 1.85;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param {{ bakery: object, renderer: object, envMap: object }} ctx
 * @param {{ tone?: string, race?: string, features?: object }} params
 * @returns {THREE.Material}
 */
export function createSkinMaterial(ctx, params = {}) {
  const bakery = ctx.bakery;

  // Uniform holders live here and are spliced into every compiled program, so
  // update() writes straight through them without touching material.version.
  const U = {
    uSkSssLut: { value: null },
    uSkThickness: { value: null },
    uSkSssTint: { value: new THREE.Color(1.26, 0.70, 0.58) },
    uSkExtremityTint: { value: new THREE.Color(1.14, 0.90, 0.86) },
    uSkSssStrength: { value: 0.85 },
    uSkCurvGain: { value: 0.014 },
    uSkBodyHeight: { value: 1.85 },
    uSkExtremity: { value: 0.55 },
    uSkOil: { value: 1.0 },
    uSkSpecBroad: { value: 0.62 },
    uSkSpecTight: { value: 0.38 },
    uSkSpecRoughBroad: { value: 1.0 },
    uSkSpecRoughTight: { value: 0.42 },
    uSkTime: { value: 0 }
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1.0, // the roughness map carries the absolute value
    metalness: 0.0,
    ior: 1.4, // skin -> F0 ~ 0.028, the reason it never reads as plastic
    specularIntensity: 1.0,
    envMap: ctx.envMap ?? null,
    envMapIntensity: 0.9,
    normalScale: new THREE.Vector2(0.8, 0.8),
    dithering: true
  });
  material.name = 'skin';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_COMMON)
      .replace('#include <project_vertex>', VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_COMMON)
      .replace('#include <lights_physical_pars_fragment>', FRAG_LIGHTING)
      .replace('#include <lights_physical_fragment>', FRAG_SURFACE);
  };

  // -------------------------------------------------------------------------
  // Bakes. Every key names exactly the inputs that change the output, so a
  // tone change re-bakes albedo only and a race revisit re-bakes nothing.
  // -------------------------------------------------------------------------

  const sssLut = bakery.bake('skin-sss-lut-v1', LUT_FRAG, {
    width: LUT_W,
    height: LUT_H,
    uniforms: { uCurvMax: LUT_CURV_MAX, uScatterScale: 1.0 },
    wrap: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false
  });
  U.uSkSssLut.value = sssLut;

  // Local memo in front of the Bakery. The Bakery caches too, but only after
  // the uniforms object has been built; going through this map means a warm
  // update() never constructs a THREE.Color or a uniform block at all.
  const memo = new Map();
  function memoBake(key, make) {
    let tex = memo.get(key);
    if (tex === undefined) {
      tex = make();
      memo.set(key, tex);
    }
    return tex;
  }

  // Local-v span of the head island's T-zone. Local v is latitude on the head
  // island, so 0.376 is the base of the nose and 0.655 is the hairline; the old
  // 0.34..0.82 ran from the mouth to the top of the skull.
  const T_ZONE_V = new THREE.Vector2(0.376, 0.655);
  // A warm, slightly saturated multiplier standing in for capillary blood.
  const BLUSH_TINT = new THREE.Color(1.22, 0.80, 0.72);

  function featureKey(scales, weather) {
    return `${scales.toFixed(2)}_${weather.toFixed(2)}`;
  }

  function bakeAlbedo(key, tone, tuning, scales, weather, seed) {
    return memoBake(key, () => bakery.bake(key, ALBEDO_FRAG, {
      width: ALBEDO_SIZE,
      height: ALBEDO_SIZE,
      colorSpace: THREE.SRGBColorSpace,
      uniforms: {
        uTone: new THREE.Color(tone), // hex string -> linear working space
        uBlushTint: BLUSH_TINT,
        uSeed: seed,
        uMottle: tuning.mottle,
        uBlush: tuning.blush,
        uWeather: weather,
        uScales: scales,
        uScaleFreq: 46.0 + weather * 8.0
      }
    }));
  }

  function bakeNormal(race, tuning, scales, weather, seed) {
    const key = `skin-normal-${race}-${featureKey(scales, weather)}`;
    return memoBake(key, () => bakery.bake(key, NORMAL_FRAG, {
      width: NORMAL_SIZE,
      height: NORMAL_SIZE,
      colorSpace: THREE.NoColorSpace,
      uniforms: {
        uTexel: 1.0 / NORMAL_SIZE,
        uSeed: seed,
        // ~620 cells across a 2048 sheet, i.e. three texels on a pore. The head
        // island is a quarter of the sheet's area and a face is a fraction of
        // that again, so at the previous 200 cells on a 1024 sheet a single
        // "pore" was five texels wide and, at the face framing, six or seven
        // screen pixels — a dimple, not a pore. Four times the texels and three
        // times the cell count puts a pore back at one or two pixels, which is
        // what makes it read as skin rather than as hammered clay.
        uPoreScale: 620.0 * tuning.pore,
        uPoreDepth: tuning.poreDepth,
        // Constant. `poreDepth` already scales the pore term inside the bake
        // and `normalScale` scales the whole map on the way out; multiplying
        // here as well cubed it, and a 1.45 Orc came out four times as pitted
        // as a 1.0 Human rather than half again.
        uStrength: 1.75,
        uWeather: weather,
        uScales: scales,
        uScaleFreq: 46.0 + weather * 8.0
      }
    }));
  }

  function bakeRough(race, tuning, scales, weather, seed) {
    const key = `skin-rough-${race}-${featureKey(scales, weather)}`;
    return memoBake(key, () => bakery.bake(key, ROUGH_FRAG, {
      width: ROUGH_SIZE,
      height: ROUGH_SIZE,
      colorSpace: THREE.NoColorSpace,
      uniforms: {
        uSeed: seed,
        uRoughBase: tuning.rough,
        uOil: tuning.oil,
        uPoreScale: 330.0 * tuning.pore,
        uHeadBand: T_ZONE_V,
        uWeather: weather,
        uScales: scales,
        uScaleFreq: 46.0 + weather * 8.0
      }
    }));
  }

  function bakeThickness(race, scales, weather, seed) {
    const key = `skin-thickness-${race}-${featureKey(scales, weather)}`;
    return memoBake(key, () => bakery.bake(key, THICK_FRAG, {
      width: THICK_SIZE,
      height: THICK_SIZE,
      colorSpace: THREE.NoColorSpace,
      uniforms: { uSeed: seed, uScales: scales, uWeather: weather }
    }));
  }

  // Bounded LRUs. Albedo multiplies out over tone as well as race, so it gets
  // the larger cap; the detail maps only vary with race and feature flags, but
  // the normal map is 2048 square (about 21 MB with mips) so a dozen resident
  // races is a quarter of a gigabyte. Cap it and let the rest re-bake — a
  // re-bake is a few milliseconds and only happens on a race change.
  function makeLru(limit, keysFor) {
    const order = [];
    return (key) => {
      const i = order.indexOf(key);
      if (i !== -1) order.splice(i, 1);
      order.push(key);
      while (order.length > limit) {
        const dead = order.shift();
        if (dead === key) continue;
        for (const bakeKey of keysFor(dead)) {
          memo.delete(bakeKey);
          bakery.invalidate(bakeKey);
        }
      }
    };
  }
  const touchAlbedo = makeLru(ALBEDO_CACHE_MAX, (k) => [k]);
  // One entry per race+feature combination, evicting all three of its detail
  // maps together — they are always used as a set, so dropping one of the three
  // would free a texture the material is still pointing at.
  const touchDetail = makeLru(DETAIL_CACHE_MAX, (k) => [
    `skin-normal-${k}`, `skin-rough-${k}`, `skin-thickness-${k}`
  ]);

  // -------------------------------------------------------------------------

  const current = { race: null, tone: null, scales: null, weather: null };

  function update(p = {}) {
    const race = typeof p.race === 'string' && RACE_SKIN[p.race] ? p.race : (current.race ?? DEFAULT_RACE);
    const tone = typeof p.tone === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.tone)
      ? p.tone.toLowerCase()
      : (current.tone ?? DEFAULT_TONE);

    const features = p.features ?? {};
    const scales = clamp01(Number(features.scales) || 0);
    // "High brow" only starts to weather the skin past a threshold, so a Human
    // (0.0) and a Night Elf (0.2) stay smooth while an Orc (0.85) is leathery.
    const brow = Number.isFinite(features.brow) ? features.brow : 0;
    const weather = clamp01((brow - 0.35) / 0.5);

    if (race === current.race && tone === current.tone
      && scales === current.scales && weather === current.weather) return;

    current.race = race;
    current.tone = tone;
    current.scales = scales;
    current.weather = weather;

    const tuning = RACE_SKIN[race] ?? DEFAULT_SKIN;
    const seed = hashSeed(race);

    const albedoKey = `skin-albedo-${race}-${tone}-${featureKey(scales, weather)}`;
    material.map = bakeAlbedo(albedoKey, tone, tuning, scales, weather, seed);
    touchAlbedo(albedoKey);

    // Touch before baking: the LRU must never evict the set we are about to
    // hand to the material.
    touchDetail(`${race}-${featureKey(scales, weather)}`);
    material.normalMap = bakeNormal(race, tuning, scales, weather, seed);
    material.roughnessMap = bakeRough(race, tuning, scales, weather, seed);
    U.uSkThickness.value = bakeThickness(race, scales, weather, seed);

    // Scalar/colour uniforms — pure writes, no allocation, no recompile.
    U.uSkSssStrength.value = 0.92 * tuning.sss * (1.0 - scales * 0.45);
    U.uSkSssTint.value.setRGB(tuning.sssTint[0], tuning.sssTint[1], tuning.sssTint[2]);
    U.uSkExtremity.value = 0.30 * tuning.blush * (1.0 - scales * 0.6);
    U.uSkExtremityTint.value.setRGB(
      1.0 + 0.18 * tuning.blush,
      1.0 - 0.11 * tuning.blush,
      1.0 - 0.15 * tuning.blush
    );
    U.uSkOil.value = tuning.oil;
    U.uSkBodyHeight.value = raceHeight(race);
    // Smaller races have tighter absolute curvature everywhere; pull the gain
    // back so a Gnome's whole head does not glow like a fingertip.
    U.uSkCurvGain.value = 0.014 * THREE.MathUtils.clamp(raceHeight(race) / 1.85, 0.55, 1.35);
    U.uSkSpecBroad.value = 0.58 + 0.10 * tuning.oil;
    U.uSkSpecTight.value = 0.30 + 0.14 * tuning.oil;
    U.uSkSpecRoughTight.value = 0.42 - 0.06 * tuning.oil;

    // Compressed, not proportional: the coarse-skinned races run poreDepth up
    // to 1.58, and at face framing the difference between "leathery" and
    // "sandpaper" is much smaller than that number suggests.
    const ns = 0.72 * (0.55 + 0.45 * tuning.poreDepth);
    material.normalScale.set(ns, ns);
  }

  // Seed with a full set of maps up front so the define set (USE_MAP,
  // USE_NORMALMAP, USE_ROUGHNESSMAP) is fixed at first compile and later
  // updates can never trigger a rebuild of the program.
  update({
    race: params.race ?? DEFAULT_RACE,
    tone: params.tone ?? DEFAULT_TONE,
    features: params.features ?? {}
  });

  material.userData.update = update;

  material.userData.tick = (t) => {
    U.uSkTime.value = t;
  };

  material.userData.setEnvMap = (envMap) => {
    material.envMap = envMap ?? null;
    material.needsUpdate = true;
  };

  return material;
}
