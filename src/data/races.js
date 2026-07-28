// Race definitions.
//
// `build` drives the parametric body loft in character/body.js. Every value is
// a multiplier or absolute proportion, tuned so each race reads as itself from
// a pure black silhouette — a Tauren must never be a scaled-up Gnome.
//
//   height        overall stature in metres
//   headScale     head radius relative to the 8-head canonical figure
//   shoulderW     shoulder half-width multiplier
//   chest/waist/hip   torso ring radii multipliers
//   armLength / legLength   limb proportion of total height
//   armThick / legThick     limb radius multipliers
//   posture       forward hunch in radians at the upper spine
//   digitigrade   knee/ankle arrangement (true = reverse-jointed, hooves/paws)
//   neck          neck length multiplier (0 reads as "no neck", e.g. Tauren)

export const RACES = [
  {
    name: 'Human', faction: 'Alliance', skin: '#e1b899',
    skinTones: ['#f0d0b4', '#e1b899', '#c99a72', '#a9764f', '#7d5334', '#5a3a24'],
    hairColors: ['#20150f', '#4a2c17', '#8a5a2b', '#c8a15a', '#d9d3c8', '#6e2b1e'],
    eyeColors: ['#4a6d8c', '#5c8c4a', '#7d5a34', '#4a4a52'],
    build: { height: 1.85, headScale: 1.0, shoulderW: 1.0, chest: 1.0, waist: 0.88, hip: 0.95,
             armLength: 0.44, legLength: 0.50, armThick: 1.0, legThick: 1.0, posture: 0.02,
             digitigrade: false, neck: 1.0 },
    features: { ears: 'human', brow: 0.0, jaw: 1.0, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Dwarf', faction: 'Alliance', skin: '#d3a47d',
    skinTones: ['#f0cfae', '#d3a47d', '#bd8a63', '#9c6c47', '#7a5236', '#e8bfa0'],
    hairColors: ['#8a3c1e', '#c05a24', '#4a2c17', '#d9d3c8', '#8a8f95', '#2b1c14'],
    eyeColors: ['#4a6d8c', '#5c8c4a', '#7d5a34', '#8c6a3a'],
    build: { height: 1.32, headScale: 1.22, shoulderW: 1.24, chest: 1.28, waist: 1.24, hip: 1.12,
             armLength: 0.40, legLength: 0.40, armThick: 1.35, legThick: 1.30, posture: 0.05,
             digitigrade: false, neck: 0.55 },
    features: { ears: 'human', brow: 0.6, jaw: 1.3, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Night Elf', faction: 'Alliance', skin: '#8b79c7',
    skinTones: ['#b9a8e0', '#8b79c7', '#6f5ea8', '#9c86b8', '#5d4d8a', '#cbbde8'],
    hairColors: ['#2b2f5c', '#5a4a8a', '#d9d3c8', '#7fd0c0', '#3a6a5a', '#1a1a2e'],
    eyeColors: ['#e8c060', '#c0e860', '#8fd8ff', '#ffffff'],
    build: { height: 2.05, headScale: 0.92, shoulderW: 1.02, chest: 0.94, waist: 0.80, hip: 0.90,
             armLength: 0.46, legLength: 0.54, armThick: 0.88, legThick: 0.92, posture: -0.03,
             digitigrade: false, neck: 1.25 },
    features: { ears: 'long', brow: 0.2, jaw: 0.85, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Gnome', faction: 'Alliance', skin: '#d4b4a2',
    skinTones: ['#f2d8c8', '#d4b4a2', '#c09a84', '#a87c66', '#e8c4b0', '#8e6350'],
    hairColors: ['#e05a9c', '#4ac0d0', '#c8a15a', '#8a3c1e', '#6a4ac0', '#3a3a44'],
    eyeColors: ['#4a6d8c', '#5c8c4a', '#a05ac0', '#d0a040'],
    build: { height: 0.95, headScale: 1.55, shoulderW: 0.82, chest: 0.90, waist: 0.92, hip: 0.94,
             armLength: 0.38, legLength: 0.38, armThick: 1.05, legThick: 1.05, posture: 0.04,
             digitigrade: false, neck: 0.60 },
    features: { ears: 'wide', brow: 0.1, jaw: 0.8, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Draenei', faction: 'Alliance', skin: '#7f8de3',
    skinTones: ['#a8b4f0', '#7f8de3', '#6272c8', '#9a86d8', '#4e5ea8', '#c0c8f5'],
    hairColors: ['#2b2f5c', '#d9d3c8', '#5a4a8a', '#8a5a2b', '#3a6a8a', '#1a1a2e'],
    eyeColors: ['#8fd8ff', '#ffffff', '#c0e0ff', '#a0c0e8'],
    build: { height: 2.10, headScale: 0.96, shoulderW: 1.14, chest: 1.08, waist: 0.86, hip: 0.98,
             armLength: 0.45, legLength: 0.52, armThick: 1.05, legThick: 1.18, posture: 0.0,
             digitigrade: true, neck: 1.05 },
    features: { ears: 'long', brow: 0.4, jaw: 1.05, snout: 0.15, tusks: false, horns: true, tail: true, scales: 0.15 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Worgen', faction: 'Alliance', skin: '#8b7c77',
    skinTones: ['#b0a49c', '#8b7c77', '#6a5c57', '#4a423e', '#d0c4bc', '#2e2826'],
    hairColors: ['#4a3a2e', '#2b1c14', '#8a7a6a', '#d9d3c8', '#6a4a2e', '#1a1410'],
    eyeColors: ['#e8c060', '#c04a2a', '#8fd8ff', '#5c8c4a'],
    build: { height: 2.15, headScale: 0.98, shoulderW: 1.30, chest: 1.22, waist: 0.84, hip: 0.92,
             armLength: 0.50, legLength: 0.48, armThick: 1.18, legThick: 1.10, posture: 0.22,
             digitigrade: true, neck: 0.70 },
    features: { ears: 'pointed-up', brow: 0.5, jaw: 1.2, snout: 0.85, tusks: true, horns: false, tail: true, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Pandaren', faction: 'Neutral', skin: '#f4ead9',
    skinTones: ['#f8f2e4', '#f4ead9', '#e0d4bc', '#c8b89c', '#a89880', '#5a5048'],
    hairColors: ['#2b1c14', '#4a3a2e', '#8a7a6a', '#d9d3c8', '#6a4a2e', '#c8a15a'],
    eyeColors: ['#4a3a2e', '#5c8c4a', '#7d5a34', '#2b1c14'],
    build: { height: 1.95, headScale: 1.18, shoulderW: 1.22, chest: 1.34, waist: 1.30, hip: 1.18,
             armLength: 0.43, legLength: 0.44, armThick: 1.32, legThick: 1.30, posture: 0.08,
             digitigrade: false, neck: 0.50 },
    features: { ears: 'round', brow: 0.3, jaw: 1.15, snout: 0.45, tusks: false, horns: false, tail: true, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Orc', faction: 'Horde', skin: '#87a45d',
    skinTones: ['#a8c078', '#87a45d', '#6e8a48', '#5a7038', '#98b06a', '#4a5c30'],
    hairColors: ['#1a1410', '#2b1c14', '#4a3a2e', '#6a5a4a', '#8a7a6a', '#c8a15a'],
    eyeColors: ['#e8c060', '#c04a2a', '#8a5a2b', '#5c8c4a'],
    build: { height: 2.05, headScale: 1.05, shoulderW: 1.42, chest: 1.30, waist: 1.00, hip: 1.02,
             armLength: 0.50, legLength: 0.44, armThick: 1.40, legThick: 1.28, posture: 0.26,
             digitigrade: false, neck: 0.45 },
    features: { ears: 'pointed', brow: 0.85, jaw: 1.45, snout: 0.25, tusks: true, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Undead', faction: 'Horde', skin: '#998d83',
    skinTones: ['#b8b0a4', '#998d83', '#7a7268', '#8a9a8a', '#6a7a6e', '#c4bcae'],
    hairColors: ['#2b1c14', '#4a3a2e', '#8a8f95', '#d9d3c8', '#3a5a4a', '#6a2a2a'],
    eyeColors: ['#ffd24a', '#c8f04a', '#8fd8ff', '#ff6a4a'],
    build: { height: 1.80, headScale: 1.02, shoulderW: 0.92, chest: 0.82, waist: 0.74, hip: 0.84,
             armLength: 0.46, legLength: 0.50, armThick: 0.76, legThick: 0.80, posture: 0.30,
             digitigrade: false, neck: 1.10 },
    features: { ears: 'pointed', brow: 0.4, jaw: 1.1, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Tauren', faction: 'Horde', skin: '#7f5f49',
    skinTones: ['#a8846a', '#7f5f49', '#5e4432', '#3a2a20', '#c8a888', '#241a14'],
    hairColors: ['#2b1c14', '#4a3a2e', '#8a7a6a', '#d9d3c8', '#6a4a2e', '#1a1410'],
    eyeColors: ['#4a3a2e', '#e8c060', '#c04a2a', '#2b1c14'],
    build: { height: 2.45, headScale: 1.10, shoulderW: 1.55, chest: 1.48, waist: 1.18, hip: 1.10,
             armLength: 0.48, legLength: 0.46, armThick: 1.50, legThick: 1.45, posture: 0.24,
             digitigrade: true, neck: 0.30 },
    features: { ears: 'side-long', brow: 0.5, jaw: 1.2, snout: 1.0, tusks: false, horns: true, tail: true, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Troll', faction: 'Horde', skin: '#6489a4',
    skinTones: ['#8ab0c8', '#6489a4', '#4e6e88', '#7a9a6a', '#5a7a5a', '#3a5468'],
    hairColors: ['#e05a4a', '#4ac0a0', '#c8a15a', '#6a4ac0', '#2b1c14', '#d9d3c8'],
    eyeColors: ['#e8c060', '#c04a2a', '#8fd8ff', '#c8f04a'],
    build: { height: 2.30, headScale: 0.94, shoulderW: 1.34, chest: 1.06, waist: 0.82, hip: 0.90,
             armLength: 0.56, legLength: 0.50, armThick: 1.02, legThick: 0.98, posture: 0.34,
             digitigrade: true, neck: 0.80 },
    features: { ears: 'long-droop', brow: 0.7, jaw: 1.3, snout: 0.35, tusks: true, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Blood Elf', faction: 'Horde', skin: '#e9c3ae',
    skinTones: ['#f6ddcc', '#e9c3ae', '#d4a88e', '#b8886c', '#96684e', '#f0d0bc'],
    hairColors: ['#1a1a2e', '#d9c88a', '#c04a4a', '#e0d0c0', '#5a2a4a', '#8a5a2b'],
    eyeColors: ['#8fe860', '#c8f04a', '#4ad0ff', '#e8c060'],
    build: { height: 1.90, headScale: 0.94, shoulderW: 0.98, chest: 0.92, waist: 0.78, hip: 0.88,
             armLength: 0.45, legLength: 0.53, armThick: 0.86, legThick: 0.90, posture: -0.04,
             digitigrade: false, neck: 1.20 },
    features: { ears: 'long', brow: 0.15, jaw: 0.82, snout: 0.0, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Goblin', faction: 'Horde', skin: '#9ecc58',
    skinTones: ['#b8e070', '#9ecc58', '#82ac44', '#688a34', '#c8e88a', '#4e6a28'],
    hairColors: ['#2b1c14', '#c04a2a', '#4a3a2e', '#d9d3c8', '#6a4ac0', '#c8a15a'],
    eyeColors: ['#e8c060', '#c04a2a', '#4a6d8c', '#c8f04a'],
    build: { height: 1.05, headScale: 1.48, shoulderW: 0.86, chest: 0.84, waist: 0.86, hip: 0.90,
             armLength: 0.42, legLength: 0.40, armThick: 0.90, legThick: 0.92, posture: 0.18,
             digitigrade: false, neck: 0.70 },
    features: { ears: 'long-droop', brow: 0.6, jaw: 1.1, snout: 0.3, tusks: false, horns: false, tail: false, scales: 0.0 },
    faces: 6, hairstyles: 8
  },
  {
    name: 'Dracthyr', faction: 'Neutral', skin: '#7384a5',
    skinTones: ['#94a8c8', '#7384a5', '#5a6a88', '#8a6a6a', '#6a8a6a', '#a89a7a'],
    hairColors: ['#2b2f5c', '#8a5a2b', '#d9d3c8', '#4a6a8a', '#6a2a4a', '#1a1a2e'],
    eyeColors: ['#4ad0ff', '#e8c060', '#c04a4a', '#8fe860'],
    build: { height: 2.20, headScale: 1.02, shoulderW: 1.36, chest: 1.16, waist: 0.88, hip: 0.96,
             armLength: 0.47, legLength: 0.50, armThick: 1.12, legThick: 1.16, posture: 0.16,
             digitigrade: true, neck: 1.15 },
    features: { ears: 'frill', brow: 0.55, jaw: 1.25, snout: 0.9, tusks: false, horns: true, tail: true, scales: 1.0 },
    faces: 6, hairstyles: 8
  }
];

export const FACTIONS = {
  Alliance: { primary: '#3a6ea8', secondary: '#c8a94a', glow: '#6fa8e0', name: 'Alliance' },
  Horde:    { primary: '#a33232', secondary: '#c8a94a', glow: '#e06a4a', name: 'Horde' },
  Neutral:  { primary: '#6a7a5a', secondary: '#c8a94a', glow: '#c8b878', name: 'Neutral' }
};

// Gender profiles modulate the build rather than replacing it, so a female
// Tauren still reads as Tauren first.
export const GENDER_PROFILES = {
  Male:         { shoulderW: 1.07, chest: 1.05, waist: 1.04, hip: 0.95, headScale: 0.98, height: 1.02, jaw: 1.08 },
  Female:       { shoulderW: 0.92, chest: 0.96, waist: 0.90, hip: 1.08, headScale: 1.02, height: 0.97, jaw: 0.92 },
  'Non-binary': { shoulderW: 1.00, chest: 1.00, waist: 1.00, hip: 1.00, headScale: 1.00, height: 1.00, jaw: 1.00 }
};

export const getRace = (name) => RACES.find((r) => r.name === name) ?? RACES[0];
