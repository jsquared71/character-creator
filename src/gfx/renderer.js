import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA runs in the post chain instead
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 120);
  camera.position.set(1.9, 1.55, 3.4);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 1.2;
  controls.maxDistance = 8.0;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.update();

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    return { w, h };
  }
  resize();

  return { renderer, scene, camera, controls, resize };
}

/**
 * Frames the camera on a character of a given height so every race is
 * presented at the same compositional weight — a Gnome fills the frame the
 * way a Tauren does, which is what makes the screen read as a hero shot.
 */
export function frameCharacter(camera, controls, height, { instant = false } = {}) {
  const targetY = height * 0.52;
  // d = H / (2 tan(vfov/2)) fits height H exactly; 1.22 leaves headroom for
  // horns, ears and hair without letting a Gnome swim in empty frame.
  const dist = (height * 1.22) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  controls.target.set(0, targetY, 0);
  controls.minDistance = height * 0.55;
  controls.maxDistance = height * 3.2;

  if (instant) {
    const dir = new THREE.Vector3(0.48, 0.20, 0.85).normalize();
    camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, targetY, 0));
  } else {
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(dir.multiplyScalar(
      THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), dist * 0.6, dist * 1.6)
    )).add(controls.target);
  }
  controls.update();
}
