import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';

const races = [
  { name: 'Human', faction: 'Alliance', skin: '#e1b899' },
  { name: 'Dwarf', faction: 'Alliance', skin: '#d3a47d' },
  { name: 'Night Elf', faction: 'Alliance', skin: '#8b79c7' },
  { name: 'Gnome', faction: 'Alliance', skin: '#d4b4a2' },
  { name: 'Draenei', faction: 'Alliance', skin: '#7f8de3' },
  { name: 'Worgen', faction: 'Alliance', skin: '#8b7c77' },
  { name: 'Pandaren', faction: 'Neutral', skin: '#f4ead9' },
  { name: 'Orc', faction: 'Horde', skin: '#87a45d' },
  { name: 'Undead', faction: 'Horde', skin: '#998d83' },
  { name: 'Tauren', faction: 'Horde', skin: '#7f5f49' },
  { name: 'Troll', faction: 'Horde', skin: '#6489a4' },
  { name: 'Blood Elf', faction: 'Horde', skin: '#e9c3ae' },
  { name: 'Goblin', faction: 'Horde', skin: '#9ecc58' },
  { name: 'Dracthyr', faction: 'Neutral', skin: '#7384a5' }
];

const wowClasses = [
  { name: 'Warrior', color: '#c79c6e', role: 'Tank / Damage' },
  { name: 'Paladin', color: '#f58cba', role: 'Tank / Healer / Damage' },
  { name: 'Hunter', color: '#abd473', role: 'Damage' },
  { name: 'Rogue', color: '#fff569', role: 'Damage' },
  { name: 'Priest', color: '#ffffff', role: 'Healer / Damage' },
  { name: 'Shaman', color: '#0070de', role: 'Healer / Damage' },
  { name: 'Mage', color: '#69ccf0', role: 'Damage' },
  { name: 'Warlock', color: '#9482c9', role: 'Damage' },
  { name: 'Monk', color: '#00ff96', role: 'Tank / Healer / Damage' },
  { name: 'Druid', color: '#ff7d0a', role: 'Tank / Healer / Damage' },
  { name: 'Demon Hunter', color: '#a330c9', role: 'Tank / Damage' },
  { name: 'Death Knight', color: '#c41e3a', role: 'Tank / Damage' },
  { name: 'Evoker', color: '#33937f', role: 'Healer / Damage' }
];

const $ = (id) => document.getElementById(id);

const ui = {
  faction: $('factionFilter'),
  race: $('raceSelect'),
  clazz: $('classSelect'),
  gender: $('genderSelect'),
  height: $('heightRange'),
  bulk: $('bulkRange'),
  head: $('headRange'),
  horns: $('hornsToggle'),
  pauldrons: $('pauldronsToggle'),
  skin: $('skinColor'),
  hair: $('hairColor'),
  eyes: $('eyeColor'),
  randomize: $('randomizeBtn'),
  summary: $('summary')
};

const canvas = $('viewer');
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0f1d, 8, 22);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(2.8, 2.1, 4.7);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.2, 0);
controls.enablePan = false;
controls.minDistance = 2.5;
controls.maxDistance = 9;
controls.update();

scene.add(new THREE.AmbientLight(0x9bb6ff, 0.55));
const keyLight = new THREE.DirectionalLight(0xf7f0d8, 1.25);
keyLight.position.set(5, 9, 7);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x4da8ff, 0.8);
rimLight.position.set(-4, 2, -4);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4, 48),
  new THREE.MeshStandardMaterial({ color: 0x1e2742, roughness: 0.9, metalness: 0.1 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.01;
scene.add(floor);

const group = new THREE.Group();
scene.add(group);

const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#c89c7a', roughness: 0.8, metalness: 0.08 });
const accentMaterial = new THREE.MeshStandardMaterial({ color: '#20150f', roughness: 0.6, metalness: 0.2 });
const glowMaterial = new THREE.MeshStandardMaterial({ color: '#48d0ff', emissive: '#48d0ff', emissiveIntensity: 0.7 });
const armorMaterial = new THREE.MeshStandardMaterial({ color: '#9ca8ca', roughness: 0.35, metalness: 0.75 });

const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 1.15, 8, 16), bodyMaterial);
torso.position.y = 1.2;

const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 24), bodyMaterial);
head.position.y = 2.2;

const hair = new THREE.Mesh(new THREE.SphereGeometry(0.37, 24, 24, 0, Math.PI * 2, 0, Math.PI / 1.8), accentMaterial);
hair.position.y = 2.33;

const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 14), glowMaterial);
const eyeR = eyeL.clone();
eyeL.position.set(-0.12, 2.22, 0.31);
eyeR.position.set(0.12, 2.22, 0.31);

const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.45, 10), accentMaterial);
const hornR = hornL.clone();
hornL.position.set(-0.17, 2.58, 0);
hornR.position.set(0.17, 2.58, 0);
hornL.rotation.z = 0.35;
hornR.rotation.z = -0.35;

const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 14), armorMaterial);
const shoulderR = shoulderL.clone();
shoulderL.position.set(-0.66, 1.9, 0);
shoulderR.position.set(0.66, 1.9, 0);

const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.72, 8, 12), bodyMaterial);
const legR = legL.clone();
legL.position.set(-0.2, 0.38, 0);
legR.position.set(0.2, 0.38, 0);

[torso, head, hair, eyeL, eyeR, hornL, hornR, shoulderL, shoulderR, legL, legR].forEach((mesh) => group.add(mesh));

function populateRaceOptions() {
  const faction = ui.faction.value;
  const filtered = races.filter((race) => faction === 'All' || race.faction === faction);
  ui.race.innerHTML = '';
  filtered.forEach((race) => {
    const option = document.createElement('option');
    option.value = race.name;
    option.textContent = `${race.name} (${race.faction})`;
    ui.race.append(option);
  });
  const current = filtered[0];
  if (current) ui.skin.value = current.skin;
}

function populateClassOptions() {
  ui.clazz.innerHTML = '';
  wowClasses.forEach((clazz) => {
    const option = document.createElement('option');
    option.value = clazz.name;
    option.textContent = clazz.name;
    ui.clazz.append(option);
  });
}

function updateModel() {
  const classData = wowClasses.find((c) => c.name === ui.clazz.value) ?? wowClasses[0];
  const gender = ui.gender.value;

  bodyMaterial.color.set(ui.skin.value);
  accentMaterial.color.set(ui.hair.value);
  glowMaterial.color.set(ui.eyes.value);
  glowMaterial.emissive.set(ui.eyes.value);
  armorMaterial.color.set(classData.color);

  const baseBulk = Number(ui.bulk.value);
  const baseHeight = Number(ui.height.value);
  const baseHead = Number(ui.head.value);
  const genderProfiles = {
    Male: { bulk: 1.08, height: 1.03, head: 0.98, shoulders: 1.08 },
    Female: { bulk: 0.92, height: 0.98, head: 1.04, shoulders: 0.92 },
    'Non-binary': { bulk: 1, height: 1, head: 1, shoulders: 1 }
  };
  const profile = genderProfiles[gender] ?? genderProfiles['Non-binary'];

  group.scale.set(baseBulk * profile.bulk, baseHeight * profile.height, baseBulk * profile.bulk);
  shoulderL.scale.setScalar(profile.shoulders);
  shoulderR.scale.setScalar(profile.shoulders);
  head.scale.setScalar(baseHead * profile.head);
  hair.scale.setScalar(baseHead * profile.head);

  hornL.visible = ui.horns.checked;
  hornR.visible = ui.horns.checked;
  shoulderL.visible = ui.pauldrons.checked;
  shoulderR.visible = ui.pauldrons.checked;

  const selectedRace = races.find((race) => race.name === ui.race.value);
  ui.summary.innerHTML = `
    <h2>${ui.gender.value} ${ui.race.value} ${ui.clazz.value}</h2>
    <p><strong>Faction:</strong> ${selectedRace?.faction ?? 'Unknown'}</p>
    <p><strong>Class role:</strong> ${classData.role}</p>
    <p><strong>Gender profile:</strong> ${gender}</p>
    <p><strong>Silhouette:</strong> ${Number(ui.height.value).toFixed(2)}h / ${Number(ui.bulk.value).toFixed(2)}w</p>
    <p><strong>Features:</strong> ${ui.horns.checked ? 'Horns enabled' : 'No horns'} · ${ui.pauldrons.checked ? 'Armored shoulders' : 'No pauldrons'}</p>
  `;
}

function randomizeCharacter() {
  const raceOptions = Array.from(ui.race.options);
  const classOptions = Array.from(ui.clazz.options);
  if (!raceOptions.length || !classOptions.length) return;

  ui.race.value = raceOptions[Math.floor(Math.random() * raceOptions.length)].value;
  ui.clazz.value = classOptions[Math.floor(Math.random() * classOptions.length)].value;
  ui.gender.value = ['Male', 'Female', 'Non-binary'][Math.floor(Math.random() * 3)];
  ui.height.value = (0.8 + Math.random() * 0.6).toFixed(2);
  ui.bulk.value = (0.7 + Math.random() * 0.9).toFixed(2);
  ui.head.value = (0.7 + Math.random() * 0.7).toFixed(2);
  ui.horns.checked = Math.random() > 0.55;
  ui.pauldrons.checked = Math.random() > 0.3;

  const randomColor = () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
  ui.skin.value = randomColor();
  ui.hair.value = randomColor();
  ui.eyes.value = randomColor();

  updateModel();
}

function handleResize() {
  const { clientWidth, clientHeight } = canvas;
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight, false);
}

[
  ui.race,
  ui.clazz,
  ui.gender,
  ui.height,
  ui.bulk,
  ui.head,
  ui.horns,
  ui.pauldrons,
  ui.skin,
  ui.hair,
  ui.eyes
].forEach((input) => input.addEventListener('input', updateModel));

ui.faction.addEventListener('change', () => {
  populateRaceOptions();
  updateModel();
});
ui.randomize.addEventListener('click', randomizeCharacter);
window.addEventListener('resize', handleResize);

populateRaceOptions();
populateClassOptions();
updateModel();
handleResize();

renderer.setAnimationLoop((time) => {
  const t = time * 0.001;
  group.rotation.y = Math.sin(t * 0.4) * 0.2;
  hair.position.y = 2.33 + Math.sin(t * 2.1) * 0.01;
  renderer.render(scene, camera);
});
