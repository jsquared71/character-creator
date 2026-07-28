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
const NORMAL_SIZE = 1024;
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
const HEAD_LOCAL = /* glsl */ `
  float inHead = step(uv.x, 0.5) * step(0.5, uv.y);
  vec2 hp = vec2(uv.x * 2.0, (uv.y - 0.5) * 2.0);
  float faceFront = 1.0 - smoothstep(0.10, 0.38, abs(hp.x - 0.5));
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

  // Three octave bands of dermal unevenness: broad tonal drift, medium
  // mottling, then a fine grain that survives into the face close-up.
  float drift = fbm(p * 2.4, 5, 2.05, 0.55);
  float mott  = fbm(p * 9.0 + 11.3, 4, 2.30, 0.50);
  float grain = fbm(p * 38.0 + 3.1, 3, 2.40, 0.55);

  vec3 col = uTone * (1.0 + (drift * 0.115 + mott * 0.075 + grain * 0.038) * uMottle);

  // Capillary blush. Broken-up patches everywhere, then hard reddening on the
  // extremity row (hands, feet, ear blades, tusks, tail) and across the nose,
  // cheeks and lips of the head island.
${EXTREMITY_ROW}
${HEAD_LOCAL}
  float midFace = smoothstep(0.24, 0.36, hp.y) * (1.0 - smoothstep(0.50, 0.66, hp.y));
  float region = max(extremityRow, inHead * faceFront * midFace * 0.9);

  float blushN = fbm(p * 4.1 + 21.7, 4, 2.10, 0.55) * 0.5 + 0.5;
  float blush = clamp(blushN * 0.35 + region * 0.85, 0.0, 1.0) * uBlush;
  col = mix(col, col * uBlushTint, blush * 0.34);

  // Knuckles and ear rims also darken slightly, not just redden.
  col *= 1.0 - extremityRow * 0.06 * uBlush;

  // Pigment specks / freckles: only a fraction of the cells fire.
  vec3 fw = worley(vec3(uv, uSeed * 0.37), 96.0);
  float speck = smoothstep(0.34, 0.0, fw.x) * step(0.74, fw.z);
  col *= 1.0 - speck * 0.20 * uMottle;

  // Heavy brow => weathered hide: coarse ridged shading, a touch desaturated.
  if (uWeather > 0.001) {
    float weather = ridged(p * 6.5 + 7.7, 4, 2.20, 0.55);
    col = mix(col, col * (0.76 + 0.40 * weather), uWeather);
    col = mix(col, vec3(luminance(col)), uWeather * 0.16);
    float pit = worley(vec3(uv, uSeed + 5.0), 34.0).x;
    col *= 1.0 - smoothstep(0.45, 0.0, pit) * uWeather * 0.14;
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
    float pore = (1.0 - smoothstep(0.0, 0.62, cw.x)) * open;
    float h = -pore * uPoreDepth;

    // Coarser cell borders - the shallow creases that divide skin into plates.
    vec3 bw = worley(p + vec3(3.7, 1.9, 0.0), uPoreScale * 0.26);
    h -= (1.0 - smoothstep(0.0, 0.30, bw.y - bw.x)) * 0.38;

    // Micro relief, an octave above the pores so mips fold it away at distance.
    h += fbm(vec3(uv * uPoreScale * 0.9, uSeed * 1.7), 3, 2.4, 0.55) * 0.55;

    if (uWeather > 0.001) {
      h += (ridged(vec3(uv * 30.0, uSeed + 2.3), 3, 2.2, 0.50) - 0.62) * uWeather * 0.95;
    }
    if (uScales > 0.001) {
      vec3 sw = worley(p + vec3(9.1, 4.3, 0.0), uScaleFreq);
      float sh = -(1.0 - smoothstep(0.0, 0.34, sw.y - sw.x)) * 1.15
                 + (1.0 - sw.x) * 0.55 + sw.z * 0.25;
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
  float broad = fbm(vec3(uv * 5.5, uSeed), 4, 2.10, 0.55) * 0.5 + 0.5;
  float fine  = fbm(vec3(uv * 24.0, uSeed + 4.0), 3, 2.40, 0.50) * 0.5 + 0.5;

  float r = uRoughBase;
  r += (broad - 0.5) * 0.22 + (fine - 0.5) * 0.10;

  // Pore floors hold oil and read slightly rougher than the plateaus.
  vec3 cw = worley(vec3(uv, uSeed), uPoreScale);
  r += (1.0 - smoothstep(0.0, 0.55, cw.x)) * 0.07;

  // Sebaceous T-zone: the vertical strip up the front of the head island from
  // the nose bridge to the hairline. uHeadBand carries that local-v span.
${HEAD_LOCAL}
  float band = smoothstep(uHeadBand.x, uHeadBand.x + 0.10, hp.y)
             * (1.0 - smoothstep(uHeadBand.y - 0.10, uHeadBand.y, hp.y));
  float centre = 1.0 - smoothstep(0.0, 0.15, abs(hp.x - 0.5));
  float tz = inHead * faceFront * band * (0.55 + 0.45 * centre);
  tz *= 0.6 + 0.4 * (fbm(vec3(uv * 26.0, uSeed + 8.0), 3, 2.2, 0.5) * 0.5 + 0.5);
  r -= tz * 0.20 * uOil;

  // Palms, soles and ear rims are drier and more matte than the rest.
${EXTREMITY_ROW}
  r += extremityRow * 0.06;

  if (uWeather > 0.001) {
    r += (ridged(vec3(uv * 8.0, uSeed + 2.0), 3, 2.2, 0.5) - 0.55) * uWeather * 0.22;
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
  float t = 0.42 + n * 0.36;

  // The extremity row is where light genuinely punches through: ear blades,
  // fingertips, the webbing between digits. Open it right up.
${EXTREMITY_ROW}
  t = mix(t, 0.98, extremityRow * 0.85);

  // Nose wings and lips on the head island get most of the way there too.
${HEAD_LOCAL}
  float nose = smoothstep(0.26, 0.38, hp.y) * (1.0 - smoothstep(0.46, 0.62, hp.y));
  t = mix(t, 0.88, inHead * faceFront * nose * 0.7);

  // The crown of the skull is the thickest thing on the body.
  t *= 1.0 - inHead * smoothstep(0.80, 0.98, hp.y) * 0.35;

  // Veining: thin, high-contrast filaments where light punches through.
  float vein = ridged(vec3(uv * 7.0, uSeed + 21.0), 4, 2.3, 0.55);
  t += smoothstep(0.72, 0.95, vein) * 0.16;

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
	skCurvature = clamp( skCurvRaw * uSkCurvGain, 0.0, 1.0 );

	// Wide band on purpose: uSkBodyHeight is the race baseline, while the live
	// figure carries a +/-18% height slider and a per-race head scale on top.
	float skYn = clamp( vSkPos.y / max( uSkBodyHeight, 0.1 ), 0.0, 1.0 );
	float skHead = smoothstep( 0.68, 0.86, skYn );
	float skFace = skHead * smoothstep( 0.02, 0.62, skN.z );
	float skTZone = skFace * ( 0.50 + 0.50 * skCurvature );

	// A whisper of moving sheen so the surface is never dead still.
	float skSweat = 1.0 + 0.025 * sin( uSkTime * 0.6 + vSkPos.y * 3.0 );
	roughnessFactor = clamp( roughnessFactor - skTZone * 0.17 * uSkOil * skSweat
		+ ( 1.0 - skHead ) * 0.02, 0.055, 1.0 );

	// Cartilage and thin tissue run warmer even before any light hits them.
	float skTip = smoothstep( 0.22, 0.85, skCurvature );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uSkExtremityTint,
		skTip * uSkExtremity );

	float skThick = texture2D( uSkThickness, vSkUv ).r;
	skSss = clamp( uSkSssStrength * skThick * ( 0.30 + 0.85 * skCurvature ), 0.0, 1.0 );

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

  // Local-v span of the head island's T-zone: nose bridge up to the hairline.
  const T_ZONE_V = new THREE.Vector2(0.34, 0.82);
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
        // ~200 cells across the sheet: a few texels per pore, which reads as
        // skin at the face framing and mips cleanly to smooth at full body.
        uPoreScale: 200.0 * tuning.pore,
        uPoreDepth: tuning.poreDepth,
        uStrength: 1.2 * tuning.poreDepth,
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
        uPoreScale: 200.0 * tuning.pore,
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

  // Albedo is the only map that multiplies with tone, so it is the only one
  // that can grow without bound. Evict the least recently used beyond the cap;
  // everything recently visited stays resident and re-selects instantly.
  const albedoLru = [];
  function touchAlbedo(key) {
    const i = albedoLru.indexOf(key);
    if (i !== -1) albedoLru.splice(i, 1);
    albedoLru.push(key);
    while (albedoLru.length > ALBEDO_CACHE_MAX) {
      const dead = albedoLru.shift();
      if (dead !== key) {
        memo.delete(dead);
        bakery.invalidate(dead);
      }
    }
  }

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

    material.normalMap = bakeNormal(race, tuning, scales, weather, seed);
    material.roughnessMap = bakeRough(race, tuning, scales, weather, seed);
    U.uSkThickness.value = bakeThickness(race, scales, weather, seed);

    // Scalar/colour uniforms — pure writes, no allocation, no recompile.
    U.uSkSssStrength.value = 0.92 * tuning.sss * (1.0 - scales * 0.45);
    U.uSkSssTint.value.setRGB(tuning.sssTint[0], tuning.sssTint[1], tuning.sssTint[2]);
    U.uSkExtremity.value = 0.62 * tuning.blush * (1.0 - scales * 0.6);
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

    material.normalScale.set(0.75 * tuning.poreDepth, 0.75 * tuning.poreDepth);
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
