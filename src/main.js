import * as THREE from 'three';
import { createStage, frameCharacter } from './gfx/renderer.js';
import { Bakery } from './gfx/bakery.js';
import { createLighting } from './gfx/lighting.js';
import { createPostChain } from './gfx/post.js';
import { createBackdrop } from './gfx/backdrop.js';
import { Character } from './character/character.js';
import { buildUI } from './ui/panels.js';
import { PerfMonitor } from './perf/monitor.js';
import * as store from './state.js';

const canvas = document.getElementById('viewer');
const { renderer, scene, camera, controls, resize } = createStage(canvas);

const bakery = new Bakery(renderer);
const ctx = { bakery, renderer, envMap: null };

const lighting = createLighting({ scene, renderer, bakery });
ctx.envMap = lighting.envMap;
scene.environment = lighting.envMap;

const backdrop = createBackdrop({ scene, bakery });
const character = new Character(ctx);
character.setEnvMap(lighting.envMap);
scene.add(character.group);

const post = createPostChain({ renderer, scene, camera, bakery });
const perf = new PerfMonitor();

let needsRebuild = true;
let needsMaterialUpdate = true;

store.subscribe((s, changed) => {
  for (const key of changed) {
    if (store.GEOMETRY_KEYS.has(key)) needsRebuild = true;
  }
  needsMaterialUpdate = true;

  if (changed.has('faction') || changed.has('race') || changed.has('class')) {
    const resolved = store.resolve();
    lighting.setMood(resolved.race.faction, resolved.klass);
    backdrop.setFaction(resolved.race.faction);
  }
  if (changed.has('quality')) {
    post.setQuality(s.quality);
    lighting.setQuality(s.quality);
  }
});

buildUI({ store });

function applyPending() {
  if (!needsRebuild && !needsMaterialUpdate) return;
  const resolved = store.resolve();
  if (needsRebuild) {
    character.rebuild(resolved);
    frameCharacter(camera, controls, character.height, { instant: firstFrame });
    needsRebuild = false;
    needsMaterialUpdate = false;
  } else if (needsMaterialUpdate) {
    character.updateMaterials(resolved);
    needsMaterialUpdate = false;
  }
}

let firstFrame = true;
const clock = new THREE.Clock();

function onResize() {
  const { w, h } = resize();
  post.resize(w, h);
}
window.addEventListener('resize', onResize);

renderer.setAnimationLoop(() => {
  perf.begin();
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  applyPending();

  if (store.state.autoRotate && !controls.userIsInteracting) {
    character.group.rotation.y += dt * 0.18;
  }
  controls.update();
  character.tick(t, dt);
  lighting.tick(t, dt);
  backdrop.tick(t, dt);

  post.render(dt);
  perf.end();

  if (firstFrame) {
    firstFrame = false;
    document.body.classList.add('ready');
    onResize();
  }
});

// Pause the auto-spin while the user is driving the camera.
controls.userIsInteracting = false;
controls.addEventListener('start', () => { controls.userIsInteracting = true; });
controls.addEventListener('end', () => { controls.userIsInteracting = false; });

store.refresh();
onResize();

// Exposed for the critic harness: deterministic camera placement + readiness.
window.__creator = {
  camera, controls, renderer, scene, character, perf, store, bakery,
  // Screenshot harnesses must not capture mid-bake: switching class or race
  // kicks off fresh texture bakes, and a frame taken before they land is a
  // black viewport. Poll this until it stops moving.
  get bakeCount() { return bakery.bakeCount; },
  setView(name) {
    const h = character.height;
    // Distances are derived from the vertical FOV so the whole figure fits:
    // fitting height H at vfov f needs d = H / (2 tan(f/2)). At 32deg that is
    // H / 0.5735, i.e. ~1.74 H, so a full-body view needs >= 2.0 H once
    // headroom and horns are allowed for. The earlier 1.55 H cropped the head.
    const fit = (frac, margin) => (h * frac * margin) / (2 * Math.tan(
      THREE.MathUtils.degToRad(camera.fov) / 2
    ));
    const views = {
      hero:    { pos: [0.48, 0.20, 0.85], target: [0, h * 0.52, 0], dist: fit(1.0, 1.22) },
      profile: { pos: [1.0, 0.10, 0.02],  target: [0, h * 0.52, 0], dist: fit(1.0, 1.22) },
      face:    { pos: [0.25, 0.06, 0.9],  target: [0, h * 0.90, 0], dist: fit(0.22, 1.15) },
      detail:  { pos: [0.6, 0.05, 0.7],   target: [0, h * 0.74, 0], dist: fit(0.34, 1.15) },
      full:    { pos: [0.35, 0.12, 0.92], target: [0, h * 0.50, 0], dist: fit(1.0, 1.45) }
    };
    const v = views[name] ?? views.hero;
    controls.target.set(...v.target);
    const dir = new THREE.Vector3(...v.pos).normalize().multiplyScalar(v.dist);
    camera.position.copy(dir).add(controls.target);
    controls.update();
    post.render(0);
  },
  get fps() { return perf.fps; }
};
