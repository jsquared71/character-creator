// Shared GLSL noise library, injected into procedural texture shaders.
// Kept as a JS string so it can be composed without a build step.

export const NOISE_GLSL = /* glsl */ `
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Gradient (Perlin-style) noise.
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                     dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                     dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                     dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                     dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}

float fbm(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-4);
}

// Ridged fbm — good for scales, scars, wood-grain-like fibre.
float ridged(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * (1.0 - abs(gnoise(p)));
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-4);
}

// Worley / cellular. Returns x = F1, y = F2, z = cell id hash.
vec3 worley(vec3 p, float scale) {
  p *= scale;
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash3(i + g) * 0.5 + 0.5;
    float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; id = hash1((i + g).xy + (i + g).z); }
    else if (d < f2) { f2 = d; }
  }
  return vec3(f1, f2, id);
}

// Anisotropic fibre noise, stretched along 'dir' — hair strands, brushed metal.
float fibre(vec3 p, vec3 dir, float stretch, int octaves) {
  vec3 q = p - dir * dot(p, dir) * (1.0 - 1.0 / stretch);
  return fbm(q, octaves, 2.0, 0.5);
}

// Derives a tangent-space normal by sampling a height function's gradient.
// The caller supplies heights already sampled at +/- eps.
vec3 normalFromHeights(float hL, float hR, float hD, float hU, float strength) {
  vec3 n = normalize(vec3((hL - hR) * strength, (hD - hU) * strength, 1.0));
  return n * 0.5 + 0.5;
}

// NOTE: named noiseLuminance, not luminance. three r180's WebGLProgram
// unconditionally injects its own 'float luminance( const in vec3 rgb )' into
// every fragment prefix (getLuminanceFunction, three.module.js:6412 - it is
// not gated on tone mapping). Declaring 'luminance' here collides with it and
// the shader fails to compile, which for a bake means a silently blank
// texture. Bakery emits a '#define luminance noiseLuminance' so callers may
// still write 'luminance(...)' and get this one.
// NB: no backticks in here - this comment lives inside a template literal.
float noiseLuminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
