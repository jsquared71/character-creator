// GPU texture bakery.
//
// Every texture in this project is synthesised on the GPU at load time by
// rendering a fullscreen triangle with a fragment shader into a render target.
// Nothing is fetched from disk. Bakes are cached by key so switching race or
// class re-uses maps that did not change.
//
// Contract for shader authors:
//   - You write only a fragment shader body that assigns `gl_FragColor`.
//   - `vUv` (vec2) is available, 0..1 across the target.
//   - NOISE_GLSL is prepended, so gnoise/fbm/ridged/worley/fibre are in scope.
//   - Declare your own uniforms; pass matching values in `uniforms`.

import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Bakery {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.cache = new Map();
    this.bakeCount = 0;
    // A failed bake produces a blank texture rather than an exception, so the
    // only signal is three's compile diagnostic. Make sure nothing has turned
    // it off — the screenshot harness fails the run on any console error.
    renderer.debug.checkShaderErrors = true;
  }

  /**
   * @param {string} key       cache key; identical keys return the cached texture
   * @param {string} fragBody  GLSL statements assigning gl_FragColor
   * @param {object} opts      { width, height, uniforms, wrap, colorSpace, filter }
   * @returns {THREE.Texture}
   */
  bake(key, fragBody, opts = {}) {
    if (this.cache.has(key)) return this.cache.get(key);

    const {
      width = 1024,
      height = 1024,
      uniforms = {},
      wrap = THREE.RepeatWrapping,
      colorSpace = THREE.NoColorSpace,
      filter = THREE.LinearFilter,
      generateMipmaps = true
    } = opts;

    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: generateMipmaps ? THREE.LinearMipmapLinearFilter : filter,
      magFilter: filter,
      wrapS: wrap,
      wrapT: wrap,
      generateMipmaps,
      type: THREE.UnsignedByteType,
      colorSpace
    });

    const uniformDecls = Object.entries(uniforms)
      .map(([name, value]) => `uniform ${glslType(value)} ${name};`)
      .join('\n');

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        ${uniformDecls}
        // three injects its own float luminance(const in vec3) above this
        // point. Map bare calls onto ours so both can coexist; the definition
        // three emitted is already past, so it is untouched by this define.
        #define luminance noiseLuminance
        ${NOISE_GLSL}
        void main() {
        ${fragBody}
        }
      `,
      uniforms: Object.fromEntries(
        Object.entries(uniforms).map(([k, v]) => [k, { value: v }])
      ),
      depthTest: false,
      depthWrite: false
    });

    this.quad.material = material;

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);

    material.dispose();
    this.quad.material = null;

    const texture = target.texture;
    texture.wrapS = wrap;
    texture.wrapT = wrap;
    texture.needsUpdate = true;
    // Keep the target alive; disposing it would free the texture.
    texture.userData.renderTarget = target;

    this.cache.set(key, texture);
    this.bakeCount++;
    return texture;
  }

  /** Drop cached bakes whose key starts with `prefix`. */
  invalidate(prefix) {
    for (const [key, texture] of this.cache) {
      if (key.startsWith(prefix)) {
        texture.userData.renderTarget?.dispose();
        this.cache.delete(key);
      }
    }
  }

  dispose() {
    for (const texture of this.cache.values()) texture.userData.renderTarget?.dispose();
    this.cache.clear();
    this.quad.geometry.dispose();
  }
}

function glslType(value) {
  if (typeof value === 'number') return 'float';
  if (value?.isVector2) return 'vec2';
  if (value?.isVector3) return 'vec3';
  if (value?.isVector4) return 'vec4';
  if (value?.isColor) return 'vec3';
  if (value?.isMatrix3) return 'mat3';
  if (value?.isTexture) return 'sampler2D';
  throw new Error(`Bakery: unsupported uniform type for value ${value}`);
}
