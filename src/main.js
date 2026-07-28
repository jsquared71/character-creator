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
  camera, controls, renderer, scene, character, perf, store,
  setView(name) {
    const h = character.height;
    const views = {
      hero:    { pos: [0.48, 0.20, 0.85], target: [0, h * 0.56, 0], dist: h * 1.55 },
      profile: { pos: [1.0, 0.10, 0.02], target: [0, h * 0.56, 0], dist: h * 1.5 },
      face:    { pos: [0.25, 0.06, 0.9], target: [0, h * 0.88, 0], dist: h * 0.42 },
      detail:  { pos: [0.6, 0.05, 0.7], target: [0, h * 0.72, 0], dist: h * 0.30 },
      full:    { pos: [0.35, 0.12, 0.92], target: [0, h * 0.52, 0], dist: h * 1.9 }
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
