// Single source of truth for the character. Everything that draws reads from
// here; nothing mutates it except `set()`. Listeners get the full state plus a
// set of changed keys, so consumers can skip expensive rebuilds.

import { RACES, getRace, GENDER_PROFILES } from './data/races.js';
import { CLASSES, getClass } from './data/classes.js';

const listeners = new Set();

export const state = {
  faction: 'All',
  race: 'Human',
  class: 'Warrior',
  gender: 'Male',

  // Normalised customisation, 0..1 unless noted.
  height: 0.5,
  bulk: 0.5,
  headSize: 0.5,
  shoulders: 0.5,
  faceIndex: 0,
  hairIndex: 0,

  skin: '#e1b899',
  hair: '#20150f',
  eyes: '#4a6d8c',

  horns: false,
  pauldrons: true,
  cape: true,

  // View
  autoRotate: true,
  quality: 'high' // 'high' | 'balanced' | 'performance'
};

/** Keys that require a full geometry rebuild rather than a material tweak. */
export const GEOMETRY_KEYS = new Set([
  'race', 'gender', 'height', 'bulk', 'headSize', 'shoulders',
  'faceIndex', 'hairIndex', 'horns', 'pauldrons', 'cape', 'class'
]);

export function set(patch) {
  const changed = new Set();
  for (const [key, value] of Object.entries(patch)) {
    if (state[key] !== value) {
      state[key] = value;
      changed.add(key);
    }
  }
  if (changed.size) emit(changed);
  return changed;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(changed) {
  for (const fn of listeners) fn(state, changed);
}

/** Force a notification without changing anything (used after init). */
export function refresh() {
  emit(new Set(Object.keys(state)));
}

/**
 * Resolves the raw state into everything the renderer needs, applying race
 * base build, gender modulation, and the user's slider offsets in that order.
 */
export function resolve() {
  const race = getRace(state.race);
  const klass = getClass(state.class);
  const gender = GENDER_PROFILES[state.gender] ?? GENDER_PROFILES['Non-binary'];

  // Sliders are +/- 18% around the race baseline — enough to feel expressive,
  // never enough to turn one race into another.
  const span = (v, amount) => 1 + (v - 0.5) * 2 * amount;

  const build = { ...race.build };
  build.height *= gender.height * span(state.height, 0.18);
  build.headScale *= gender.headScale * span(state.headSize, 0.18);
  build.shoulderW *= gender.shoulderW * span(state.shoulders, 0.20);
  build.chest *= gender.chest * span(state.bulk, 0.22);
  build.waist *= gender.waist * span(state.bulk, 0.26);
  build.hip *= gender.hip * span(state.bulk, 0.16);
  build.armThick *= span(state.bulk, 0.18);
  build.legThick *= span(state.bulk, 0.18);

  const features = { ...race.features, jaw: race.features.jaw * gender.jaw };
  if (state.horns) features.horns = true;

  return { race, klass, gender: state.gender, build, features, state };
}

export const allRaces = RACES;
export const allClasses = CLASSES;
