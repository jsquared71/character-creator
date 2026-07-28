import * as THREE from 'three';

/**
 * Hair as instanced strand cards.
 *
 * Every visible hair in the character is one instance of a single tapered
 * ribbon "card": a 4-ring, 4-sided flattened tube that narrows from root to
 * tip. A *strand* is a chain of those cards laid along a grown path, so the
 * strand as a whole follows a curve — outward off the scalp, then bending
 * under gravity, with per-strand noise, curl and clumping. Card `k` of a
 * strand is scaled by CARD_TIP^k, which is exactly the taper baked into the
 * card geometry, so consecutive cards join without a step and the chain reads
 * as one continuous, smoothly tapering lock of hair.
 *
 * Everything — scalp hair, mohawk crests, topknot plumes, twin tails, braids,
 * Tauren manes, Dwarf beards — lands in the *same* InstancedMesh, using the
 * material handed in by the caller. Per-instance `aStrandSeed` and
 * `aStrandTint` instanced attributes let that material break up tint and
 * shading per lock.
 *
 *   buildHairGeometry(race, features, joints, { styleIndex, material })
 *     -> THREE.InstancedMesh | null
 */

const MAX_INSTANCES = 900;

// Card geometry constants. CARD_TIP is load-bearing: it is both the taper of a
// single card and the per-card width ratio along a strand chain.
const CARD_RINGS = 4;
const CARD_TIP = 0.74;
const CARD_TWIST = 0.30;
const CARD_THICK = 0.20; // half-thickness relative to half-width

const UP_Y = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ *
 * deterministic noise
 * ------------------------------------------------------------------ */

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

// Cheap smooth 2D value noise, used for patchiness / clumping masks.
function patchNoise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const t = Math.sin(x * 4.1414 + y * 27.717) * 21367.1234;
  return 0.5 + 0.25 * Math.sin(s) + 0.25 * Math.sin(t);
}

/* ------------------------------------------------------------------ *
 * base card geometry — a tapered, gently twisted ribbon
 * ------------------------------------------------------------------ */

function createCardGeometry() {
  // Cross-section: a thin diamond in local XZ. Closed loop, so the card has
  // real (if slight) thickness and never reads as a zero-width sheet edge-on.
  const cross = [
    [0.5, 0],
    [0, CARD_THICK * 0.5],
    [-0.5, 0],
    [0, -CARD_THICK * 0.5]
  ];
  const sides = cross.length;
  const perRing = sides + 1; // duplicated seam vertex so U can reach 1
  const segs = CARD_RINGS - 1;

  const positions = new Float32Array(CARD_RINGS * perRing * 3);
  const uvs = new Float32Array(CARD_RINGS * perRing * 2);
  const indices = [];

  let p = 0;
  let q = 0;
  for (let i = 0; i < CARD_RINGS; i++) {
    const v = i / segs;
    // Slightly convex taper — fuller at the root, pinched at the tip.
    const w = Math.pow(CARD_TIP, v) * (1 - 0.10 * v * (1 - v) * 4 * -1);
    const ang = CARD_TWIST * v;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let j = 0; j < perRing; j++) {
      const c = cross[j % sides];
      const x = c[0] * w;
      const z = c[1] * w;
      positions[p++] = x * ca - z * sa;
      positions[p++] = v;
      positions[p++] = x * sa + z * ca;
      uvs[q++] = j / sides;
      uvs[q++] = v;
    }
  }

  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * perRing + j;
      const b = a + 1;
      const c = a + perRing;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ *
 * head frame
 * ------------------------------------------------------------------ */

function scalpFrame(joints) {
  const scalp = joints && (joints.scalp || joints.head);
  if (!scalp || !scalp.position) return null;

  const up = (scalp.up ? scalp.up.clone() : UP_Y.clone());
  if (up.lengthSq() < 1e-8) up.copy(UP_Y);
  up.normalize();

  const forward = scalp.forward ? scalp.forward.clone() : new THREE.Vector3(0, 0, 1);
  forward.addScaledVector(up, -forward.dot(up));
  if (forward.lengthSq() < 1e-8) {
    forward.set(0, 0, 1).addScaledVector(up, -up.z);
    if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0);
  }
  forward.normalize();

  const right = new THREE.Vector3().crossVectors(up, forward).normalize();

  let center = scalp.position.clone();
  let radius = scalp.radius > 0 ? scalp.radius : 0.11;

  // `scalp` may be handed to us as a *surface* anchor (the crown) rather than
  // the centre of the skull. If a head joint exists and the scalp anchor sits
  // roughly a head-radius away from it, trust the head for the dome and treat
  // scalp.radius as the size of the hair patch instead.
  const head = joints && joints.head;
  if (head && head.position && head.radius > 0) {
    const d = scalp.position.distanceTo(head.position);
    if (d > head.radius * 0.5) {
      center = head.position.clone();
      radius = head.radius;
    }
  }

  return { center, radius, up, forward, right, anchor: scalp.position.clone() };
}

// Point on the scalp dome. theta = angle from `up`, phi = azimuth from
// `forward`, positive toward `right`.
function domePoint(frame, theta, phi, out) {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  out.set(0, 0, 0);
  out.addScaledVector(frame.up, ct);
  out.addScaledVector(frame.forward, st * cp);
  out.addScaledVector(frame.right, st * sp);
  return out.normalize();
}

/* ------------------------------------------------------------------ *
 * style + race tables
 * ------------------------------------------------------------------ */

const STYLES = [
  {
    id: 'long', name: 'Long Flowing',
    strands: 120, length: 4.2, segs: 7, gravity: 0.62, stiff: 0.16, outward: 0.22,
    noise: 0.09, curl: 0.06, width: 0.32, thetaFront: 1.02, thetaBack: 2.10,
    cap: 1.0, flow: 0.38, part: 0.55, fringe: 0.42
  },
  {
    id: 'braid', name: 'Braided',
    strands: 84, length: 1.10, segs: 4, gravity: 0.34, stiff: 0.42, outward: 0.20,
    noise: 0.05, curl: 0.02, width: 0.30, thetaFront: 0.96, thetaBack: 1.92,
    cap: 1.0, flow: 0.88, part: 0.15, fringe: 0.55,
    gather: 'nape', braid: true
  },
  {
    id: 'topknot', name: 'Topknot',
    strands: 92, length: 1.00, segs: 4, gravity: 0.20, stiff: 0.50, outward: 0.16,
    noise: 0.05, curl: 0.02, width: 0.29, thetaFront: 0.92, thetaBack: 1.78,
    cap: 0.9, flow: 0.92, part: 0.10, fringe: 0.6,
    gather: 'crown', plume: true
  },
  {
    id: 'mohawk', name: 'Mohawk',
    strands: 34, length: 0.50, segs: 3, gravity: 0.42, stiff: 0.60, outward: 0.40,
    noise: 0.16, curl: 0.0, width: 0.20, thetaFront: 1.05, thetaBack: 1.85,
    cap: 0.35, flow: 0.5, part: 0.2, fringe: 0.8,
    shaved: true, crest: 1.0
  },
  {
    id: 'crop', name: 'Short Crop',
    strands: 180, length: 0.55, segs: 3, gravity: 0.40, stiff: 0.58, outward: 0.55,
    noise: 0.17, curl: 0.0, width: 0.24, thetaFront: 1.14, thetaBack: 2.00,
    cap: 1.15, flow: 0.45, part: 0.25, fringe: 0.85
  },
  {
    id: 'swept', name: 'Swept Back',
    strands: 138, length: 1.50, segs: 5, gravity: 0.30, stiff: 0.52, outward: 0.20,
    noise: 0.06, curl: 0.03, width: 0.28, thetaFront: 1.02, thetaBack: 2.05,
    cap: 1.0, flow: 1.0, part: 0.05, fringe: 0.7,
    sweep: 1.0
  },
  {
    id: 'twin', name: 'Twin Tails',
    strands: 104, length: 0.95, segs: 4, gravity: 0.28, stiff: 0.46, outward: 0.18,
    noise: 0.05, curl: 0.03, width: 0.29, thetaFront: 1.00, thetaBack: 1.92,
    cap: 1.0, flow: 0.8, part: 0.45, fringe: 0.5,
    gather: 'twin', tails: true
  },
  {
    id: 'wild', name: 'Wild / Matted',
    strands: 118, length: 2.0, segs: 5, gravity: 0.40, stiff: 0.34, outward: 0.62,
    noise: 0.30, curl: 0.16, width: 0.34, thetaFront: 1.12, thetaBack: 2.12,
    cap: 1.1, flow: 0.32, part: 0.35, fringe: 0.6,
    clump: 1.0
  }
];

const DEFAULT_PROFILE = {
  density: 1, length: 1, width: 1, gravity: 1, noise: 1, volume: 1,
  crest: 0, mane: 0, ruff: 0, sparse: 0, tie: 0, bald: -1
};

function raceProfile(name) {
  const p = Object.assign({}, DEFAULT_PROFILE);
  switch (name) {
    case 'Troll':
      // Trolls are all crest: even the "flowing" styles keep a spine of hair.
      p.crest = 0.95; p.density = 0.78; p.length = 1.20; p.width = 1.10;
      p.noise = 1.15; p.tie = 0.75; p.volume = 0.9;
      break;
    case 'Orc':
      p.crest = 0.70; p.density = 0.84; p.length = 0.92; p.width = 1.18;
      p.tie = 0.85; p.noise = 1.1;
      break;
    case 'Tauren':
      p.mane = 1.0; p.density = 0.80; p.width = 1.30; p.length = 0.88;
      p.noise = 1.1; p.volume = 1.05;
      break;
    case 'Undead':
      // Lank and sparse: heavy droop, thin cards, bald patches.
      p.sparse = 0.60; p.gravity = 1.45; p.volume = 0.42; p.width = 0.72;
      p.noise = 0.65; p.length = 1.08; p.density = 0.85;
      break;
    case 'Blood Elf':
      p.density = 1.24; p.length = 1.32; p.volume = 1.22; p.width = 0.94; p.gravity = 0.92;
      break;
    case 'Night Elf':
      p.density = 1.26; p.length = 1.38; p.volume = 1.28; p.width = 0.94; p.gravity = 0.90;
      break;
    case 'Dwarf':
      p.density = 1.05; p.width = 1.16; p.length = 0.86; p.volume = 1.1;
      break;
    case 'Worgen':
      p.ruff = 1.0; p.noise = 1.45; p.crest = 0.35; p.width = 1.14; p.length = 0.95; p.volume = 1.2;
      break;
    case 'Pandaren':
      p.density = 0.95; p.width = 1.22; p.tie = 0.65; p.length = 0.92; p.volume = 1.1;
      break;
    case 'Draenei':
      p.density = 1.06; p.length = 1.12; p.volume = 1.08;
      break;
    case 'Gnome':
      p.volume = 1.35; p.width = 1.22; p.density = 1.05; p.length = 0.82; p.noise = 1.1;
      break;
    case 'Goblin':
      p.noise = 1.30; p.crest = 0.40; p.width = 0.95; p.length = 0.88; p.volume = 1.15;
      break;
    case 'Dracthyr':
      // Barely-there hair over scales; one style is genuinely bald.
      p.density = 0.48; p.length = 0.70; p.width = 0.90; p.crest = 0.45; p.bald = 4;
      break;
    default:
      break;
  }
  return p;
}

// Facial hair plan per race + style. Amounts are 0..1 densities.
function facialPlan(name, style) {
  const s = style;
  switch (name) {
    case 'Dwarf':
      return {
        beard: 1.0, mustache: true, sideburns: true,
        braids: s === 1 ? 2 : s === 2 ? 2 : s === 7 ? 3 : s === 6 ? 2 : 0,
        length: s === 4 ? 0.95 : 1.35, forked: s === 5
      };
    case 'Orc':
      return {
        beard: s === 1 || s === 2 || s === 7 ? 0.85 : s === 5 ? 0.3 : 0,
        mustache: s === 7 || s === 2, braids: s === 1 ? 2 : 0, length: 1.1
      };
    case 'Troll':
      return { beard: s === 7 ? 0.5 : 0, braids: s === 1 ? 2 : 0, length: 1.05 };
    case 'Tauren':
      return { beard: 0.4, chinOnly: true, length: 1.0 };
    case 'Pandaren':
      return {
        beard: s === 2 || s === 5 || s === 7 ? 0.75 : 0.28,
        mustache: true, braids: s === 1 ? 1 : 0, length: 1.15
      };
    case 'Human':
      return {
        beard: s === 1 || s === 7 ? 0.8 : s === 5 ? 0.35 : 0,
        mustache: s === 1 || s === 7, length: 0.95
      };
    case 'Gnome':
      return { beard: s === 1 || s === 7 ? 0.75 : 0, mustache: s === 1, length: 1.15 };
    case 'Goblin':
      return { beard: s === 7 ? 0.45 : 0, length: 0.85 };
    case 'Draenei':
      return { tendrils: 4, length: 1.2 };
    case 'Worgen':
      return { ruff: 1.0, length: 1.0 };
    case 'Night Elf':
      return { beard: s === 7 ? 0.45 : 0, length: 1.0 };
    default:
      return {};
  }
}

/* ------------------------------------------------------------------ *
 * strand growth
 * ------------------------------------------------------------------ */

/**
 * Integrates one strand path. Direction turns a little each step under
 * gravity, drift, curl and per-strand noise, so the result is a curve rather
 * than a straight spike, and no two strands share a shape.
 */
function growStrand(rng, root, dir0, P) {
  const pts = [root.clone()];
  const dir = dir0.clone().normalize();
  const pos = root.clone();
  const step = P.length / P.segs;
  const tmp = new THREE.Vector3();
  const soft = 1 - clamp01(P.stiff);
  const phase = rng() * Math.PI * 2;

  for (let i = 0; i < P.segs; i++) {
    const t = i / P.segs;

    // Gravity droop ramps up along the strand — roots stay lifted, tips fall.
    dir.y -= P.gravity * (0.25 + t * 1.25) * soft;

    if (P.drift) dir.addScaledVector(P.drift, P.driftAmt * (1 - t * 0.55) * soft);

    // Gathering: pull toward a tie point for the first stretch only.
    if (P.gather) {
      const w = P.gatherAmt * Math.max(0, 1 - i / Math.max(1, P.gatherSegs));
      if (w > 0) {
        tmp.copy(P.gather).sub(pos);
        if (tmp.lengthSq() > 1e-8) dir.lerp(tmp.normalize(), clamp01(w));
      }
    }

    if (P.curl > 0 && P.curlAxis) {
      const swing = Math.sin(phase + i * P.curlFreq) * P.curl;
      dir.addScaledVector(P.curlAxis, swing);
    }

    dir.x += (rng() - 0.5) * P.noise;
    dir.y += (rng() - 0.5) * P.noise * 0.7;
    dir.z += (rng() - 0.5) * P.noise;

    if (dir.lengthSq() < 1e-8) dir.copy(UP_Y);
    dir.normalize();

    pos.addScaledVector(dir, step * (0.85 + rng() * 0.3));

    // Keep hair off the skull without flattening long hair against the chest.
    if (P.skullCenter && P.skullRadius > 0) {
      tmp.copy(pos).sub(P.skullCenter);
      const d = tmp.length();
      if (d < P.skullRadius && d > 1e-6 && tmp.dot(P.up) > -P.skullRadius * 0.45) {
        pos.copy(P.skullCenter).addScaledVector(tmp.divideScalar(d), P.skullRadius);
      }
    }

    pts.push(pos.clone());
  }
  return pts;
}

/**
 * Places a helical plait around a centreline — used for braids (three plaits
 * wound together) and for Dwarf beard braids.
 */
function braidPlait(center, n1, n2, radiusOf, phase, turns) {
  const pts = [];
  const n = center.length;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const a = phase + t * turns * Math.PI * 2;
    const r = radiusOf(t);
    const p = center[i].clone();
    p.addScaledVector(n1, Math.cos(a) * r);
    p.addScaledVector(n2, Math.sin(a) * r);
    pts.push(p);
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

export function buildHairGeometry(race, features, joints, opts) {
  const options = opts || {};
  const material = options.material;
  if (!material) return null;

  const frame = scalpFrame(joints);
  if (!frame) return null;

  const raceName = (race && race.name) || 'Human';
  const styleIndex = clamp(Math.round(options.styleIndex || 0), 0, STYLES.length - 1);
  const style = STYLES[styleIndex];
  const profile = raceProfile(raceName);
  const feat = features || (race && race.features) || {};

  // One style per race may genuinely be bald.
  if (profile.bald === styleIndex) return null;

  const rng = mulberry32(hashString(raceName + '|' + style.id) ^ 0x9e3779b9);

  const R = frame.radius;
  const up = frame.up;
  const fwd = frame.forward;
  const right = frame.right;
  const center = frame.center;

  const strands = [];
  const ctx = {
    rng, R, up, fwd, right, center, frame, style, profile, feat, raceName, strands
  };

  emitCapLayer(ctx);
  emitScalp(ctx);
  if (style.gather === 'nape' || style.braid) emitBraids(ctx);
  if (style.plume) emitTopknot(ctx);
  if (style.tails) emitTwinTails(ctx);
  if (style.crest > 0 || profile.crest > 0) emitCrest(ctx);
  if (profile.mane > 0) emitMane(ctx, joints);
  emitFacial(ctx, joints);

  if (!strands.length) return null;

  return assemble(strands, material, rng, raceName, style.id);
}

/* -------------------------- emitters ------------------------------ */

// Root acceptance: hairline in front, longer at the nape, optional shaved
// sides and race-driven bald patches.
function acceptRoot(ctx, theta, phi, jitter) {
  const { style, profile, feat } = ctx;
  const frontness = Math.cos(phi);
  const thetaMax = lerp(style.thetaBack, style.thetaFront, 0.5 + 0.5 * frontness) + jitter;
  if (theta > thetaMax) return false;

  // Shaved sides for the mohawk.
  if (style.shaved) {
    const lateral = Math.abs(Math.sin(phi)) * Math.sin(theta);
    if (lateral < 0.30) return false;
  }

  // Undead patchiness.
  if (profile.sparse > 0) {
    const n = patchNoise(theta * 3.1, phi * 2.4);
    if (n < profile.sparse * 0.72) return false;
  }

  // Don't grow hair straight through horns.
  if (feat.horns) {
    const hornPhi = 1.05;
    const dPhi = Math.min(Math.abs(phi - hornPhi), Math.abs(phi + hornPhi));
    if (theta > 0.55 && theta < 1.35 && dPhi < 0.45) return false;
  }
  // Nor through long ears.
  if (feat.ears === 'long' || feat.ears === 'long-droop' || feat.ears === 'side-long') {
    const dPhi = Math.min(Math.abs(Math.abs(phi) - Math.PI * 0.5), 10);
    if (theta > 1.35 && dPhi < 0.30) return false;
  }
  return true;
}

/**
 * Direction hair *lies* in at a given point on the scalp: a tangential field
 * on the dome, blended between "falls straight down" and "swept toward the
 * nape". Growing along this instead of along the surface normal is what stops
 * crown strands from rocketing vertically off the head.
 */
const _tDown = new THREE.Vector3();
const _tBack = new THREE.Vector3();
function flowDir(ctx, normal, sweep, out) {
  _tDown.copy(ctx.up).multiplyScalar(-1);
  _tDown.addScaledVector(normal, -_tDown.dot(normal));
  _tBack.copy(ctx.fwd).multiplyScalar(-1);
  _tBack.addScaledVector(normal, -_tBack.dot(normal));

  const dOk = _tDown.lengthSq() > 1e-6;
  const bOk = _tBack.lengthSq() > 1e-6;
  if (!dOk && !bOk) return out.copy(ctx.fwd).multiplyScalar(-1);
  if (!dOk) _tDown.copy(_tBack);
  if (!bOk) _tBack.copy(_tDown);
  _tDown.normalize();
  _tBack.normalize();

  out.copy(_tDown).multiplyScalar(1 - sweep).addScaledVector(_tBack, sweep);
  if (out.lengthSq() < 1e-8) out.copy(_tDown);
  return out.normalize();
}

function strandWidth(ctx, base) {
  return base * ctx.R * ctx.profile.width * ctx.style.width;
}

function pushStrand(ctx, points, o) {
  if (!points || points.length < 2) return;
  ctx.strands.push({
    points,
    width: o.width,
    tint: clamp01(o.tint),
    seed: o.seed,
    twist: o.twist || 0,
    face: o.face || null,
    priority: o.priority == null ? 1 : o.priority,
    rank: o.rank == null ? ctx.rng() : o.rank
  });
}

function tintFor(ctx) {
  const { rng, profile } = ctx;
  const spread = profile.sparse > 0 ? 0.52 : 0.30;
  let t = 0.5 + (rng() - 0.5) * spread;
  if (rng() < 0.08) t = rng() < 0.5 ? t * 0.45 : clamp01(t + 0.42); // streaks
  return clamp01(t);
}

/**
 * A short, wide inner layer hugging the skull. Hair cards alone leave gaps at
 * the parting; this fills them so the scalp never shows through.
 */
function emitCapLayer(ctx) {
  const { style, profile, rng, R, center } = ctx;
  if (!style.cap) return;
  const n = Math.round(34 * style.cap * clamp(profile.density, 0.5, 1.4));
  const dir = new THREE.Vector3();
  const root = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const theta = Math.acos(1 - u * 0.92) * 0.98;
    const phi = i * 2.399963 + rng() * 0.4;
    if (!acceptRoot(ctx, theta, phi, -0.16)) continue;
    domePoint(ctx.frame, theta, phi, dir);
    root.copy(center).addScaledVector(dir, R * 0.985);
    const P = {
      length: R * 0.50 * profile.length,
      segs: 2,
      gravity: 0.35 * profile.gravity,
      stiff: 0.7,
      noise: 0.05,
      curl: 0,
      skullCenter: center,
      skullRadius: R * 1.0,
      up: ctx.up
    };
    const d0 = flowDir(ctx, dir, clamp01((style.flow || 0.4) * 0.8 + 0.15), new THREE.Vector3());
    d0.addScaledVector(dir, 0.30);
    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 2.15),
      tint: clamp01(tintFor(ctx) * 0.75),
      seed: rng(),
      twist: (rng() - 0.5) * 0.5,
      face: dir.clone(),
      priority: 3
    });
  }
}

function emitScalp(ctx) {
  const { style, profile, rng, R, center, up, fwd, right } = ctx;
  const target = Math.round(style.strands * profile.density);
  if (target <= 0) return;

  const gather = gatherPoint(ctx);
  const clumpCount = style.clump ? Math.max(6, Math.round(target / 9)) : 0;
  const clumps = [];
  for (let i = 0; i < clumpCount; i++) {
    clumps.push(new THREE.Vector3(
      (rng() - 0.5) * 2, (rng() - 0.5) * 1.2, (rng() - 0.5) * 2
    ).normalize());
  }

  const dir = new THREE.Vector3();
  const root = new THREE.Vector3();
  let made = 0;
  const attempts = target * 3;
  for (let i = 0; i < attempts && made < target; i++) {
    const u = (i % target + 0.5) / target;
    const theta = Math.acos(1 - u * (1 - Math.cos(2.25))) + (rng() - 0.5) * 0.12;
    const phi = i * 2.399963 + rng() * 0.5;
    if (theta < 0 || !acceptRoot(ctx, theta, phi, (rng() - 0.5) * 0.22)) continue;
    made++;

    domePoint(ctx.frame, theta, phi, dir);
    root.copy(center).addScaledVector(dir, R * 0.99);

    const volume = profile.volume;
    const front = clamp01(0.5 + 0.5 * Math.cos(phi));

    // Grow along the scalp's flow field, lifted off the surface by `outward`.
    const d0 = flowDir(ctx, dir, clamp01(style.flow), new THREE.Vector3());
    d0.addScaledVector(dir, style.outward * (0.6 + 0.4 * volume) + 0.12);
    // Centre part: the fringe is pushed off the face to either side.
    const side = Math.sin(phi) >= 0 ? 1 : -1;
    d0.addScaledVector(right, side * style.part * front * (0.7 + rng() * 0.6));

    // Hair drapes: once clear of the skull it drifts back toward the body
    // axis instead of flaring outward forever.
    const inward = dir.clone().addScaledVector(up, -dir.dot(up));
    if (inward.lengthSq() > 1e-6) inward.normalize().multiplyScalar(-1);
    else inward.copy(fwd).multiplyScalar(-1);

    let driftVec;
    let driftAmt;
    if (style.sweep) {
      driftVec = fwd.clone().multiplyScalar(-1).addScaledVector(up, 0.10)
        .addScaledVector(inward, 0.35).normalize();
      driftAmt = 0.36 * style.sweep;
    } else {
      driftVec = inward.clone().multiplyScalar(0.8)
        .addScaledVector(fwd, -0.45).normalize();
      driftAmt = 0.16;
    }

    if (clumps.length) {
      const c = clumps[(i * 7 + made) % clumps.length];
      d0.addScaledVector(c, 0.45 * style.clump);
    }

    // Short at the fringe, long at the nape, so the silhouette isn't a
    // uniform curtain and the face stays visible.
    let len = style.length * R * profile.length * lerp(1.15, style.fringe, front);
    len *= 0.85 + rng() * 0.3;

    const P = {
      length: len,
      segs: style.segs,
      gravity: style.gravity * profile.gravity,
      stiff: style.stiff,
      noise: style.noise * profile.noise * 0.35,
      curl: style.curl,
      curlFreq: 1.1 + rng() * 0.8,
      curlAxis: right.clone().multiplyScalar(Math.sin(phi) >= 0 ? 1 : -1),
      drift: driftVec,
      driftAmt,
      gather,
      gatherAmt: gather ? 0.55 : 0,
      gatherSegs: Math.max(1, style.segs - 1),
      skullCenter: center,
      skullRadius: R * 1.02,
      up
    };

    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 0.9 + rng() * 0.5),
      tint: tintFor(ctx),
      seed: rng(),
      twist: (rng() - 0.5) * 0.8,
      face: dir.clone(),
      priority: 1
    });
  }
}

function gatherPoint(ctx) {
  const { style, R, center, up, fwd } = ctx;
  if (style.gather === 'nape') {
    return center.clone().addScaledVector(fwd, -R * 1.02).addScaledVector(up, -R * 0.30);
  }
  if (style.gather === 'crown') {
    return center.clone().addScaledVector(up, R * 1.16).addScaledVector(fwd, -R * 0.18);
  }
  if (style.gather === 'twin') {
    // Handled per-strand by side; use the mid point as a weak attractor.
    return center.clone().addScaledVector(up, R * 0.55).addScaledVector(fwd, -R * 0.55);
  }
  return null;
}

function emitTopknot(ctx) {
  const { rng, R, center, up, fwd, profile, style } = ctx;
  const tie = gatherPoint(ctx);
  if (!tie) return;
  const scale = 1 + profile.tie * 0.7;
  const n = Math.round(26 * (0.7 + profile.tie * 0.8));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.3;
    const r = R * 0.10 * Math.sqrt(rng());
    const root = tie.clone()
      .addScaledVector(ctx.right, Math.cos(a) * r)
      .addScaledVector(fwd, Math.sin(a) * r);
    const d0 = up.clone().multiplyScalar(1.0)
      .addScaledVector(ctx.right, Math.cos(a) * 0.32)
      .addScaledVector(fwd, Math.sin(a) * 0.32 - 0.38);
    const P = {
      length: R * 1.35 * scale * profile.length * (0.75 + rng() * 0.5),
      segs: 5,
      gravity: 0.62 * profile.gravity,
      stiff: 0.22,
      noise: 0.10 * profile.noise,
      curl: style.curl,
      curlFreq: 1.3,
      curlAxis: ctx.right.clone(),
      skullCenter: center,
      skullRadius: R * 1.03,
      up
    };
    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 1.05 + rng() * 0.5),
      tint: tintFor(ctx),
      seed: rng(),
      twist: (rng() - 0.5) * 1.0,
      face: null,
      priority: 3
    });
  }

  // The tie itself: a couple of wraps of tight cards.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const p0 = tie.clone()
      .addScaledVector(ctx.right, Math.cos(a) * R * 0.16)
      .addScaledVector(fwd, Math.sin(a) * R * 0.16)
      .addScaledVector(up, -R * 0.05);
    const a2 = a + 1.2;
    const p1 = tie.clone()
      .addScaledVector(ctx.right, Math.cos(a2) * R * 0.16)
      .addScaledVector(fwd, Math.sin(a2) * R * 0.16)
      .addScaledVector(up, R * 0.02);
    const mid = p0.clone().lerp(p1, 0.5).addScaledVector(up, R * 0.01);
    pushStrand(ctx, [p0, mid, p1], {
      width: strandWidth(ctx, 1.4),
      tint: clamp01(tintFor(ctx) * 0.6),
      seed: rng(),
      twist: 0,
      face: up.clone(),
      priority: 3
    });
  }
}

function emitTwinTails(ctx) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  for (let s = -1; s <= 1; s += 2) {
    const tie = center.clone()
      .addScaledVector(right, s * R * 0.98)
      .addScaledVector(fwd, -R * 0.35)
      .addScaledVector(up, R * 0.20);
    const n = 20;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.4;
      const r = R * 0.11 * Math.sqrt(rng());
      const root = tie.clone()
        .addScaledVector(up, Math.cos(a) * r)
        .addScaledVector(fwd, Math.sin(a) * r);
      const d0 = right.clone().multiplyScalar(s * 0.45)
        .addScaledVector(up, -0.35)
        .addScaledVector(fwd, -0.35);
      const P = {
        length: R * 2.6 * profile.length * (0.8 + rng() * 0.45),
        segs: 6,
        gravity: 0.55 * profile.gravity,
        stiff: 0.30,
        noise: 0.09 * profile.noise,
        curl: 0.07,
        curlFreq: 1.0 + rng() * 0.6,
        curlAxis: fwd.clone(),
        skullCenter: center,
        skullRadius: R * 1.03,
        up
      };
      const pts = growStrand(rng, root, d0, P);
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.0 + rng() * 0.45),
        tint: tintFor(ctx),
        seed: rng(),
        twist: (rng() - 0.5) * 0.9,
        face: null,
        priority: 3
      });
    }
    // Binding at the base of each tail.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const p0 = tie.clone()
        .addScaledVector(up, Math.cos(a) * R * 0.15)
        .addScaledVector(fwd, Math.sin(a) * R * 0.15);
      const p1 = tie.clone()
        .addScaledVector(up, Math.cos(a + 1.5) * R * 0.15)
        .addScaledVector(fwd, Math.sin(a + 1.5) * R * 0.15)
        .addScaledVector(right, s * R * 0.06);
      pushStrand(ctx, [p0, p1], {
        width: strandWidth(ctx, 1.3),
        tint: clamp01(tintFor(ctx) * 0.6),
        seed: rng(),
        priority: 3
      });
    }
  }
}

function emitBraids(ctx) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  const tie = gatherPoint(ctx);
  if (!tie) return;

  // Centreline of the rope: away from the nape, then down under gravity.
  const ropeLen = R * 3.4 * profile.length;
  const segs = 7;
  const centreline = [];
  const p = tie.clone();
  const dir = fwd.clone().multiplyScalar(-0.55).addScaledVector(up, -0.85).normalize();
  for (let i = 0; i <= segs; i++) {
    centreline.push(p.clone());
    dir.addScaledVector(up, -0.30);
    dir.addScaledVector(right, (rng() - 0.5) * 0.06);
    dir.normalize();
    p.addScaledVector(dir, ropeLen / segs);
  }

  const n1 = right.clone();
  const n2 = new THREE.Vector3().crossVectors(right, up).normalize();
  const ropeR = (t) => R * 0.17 * (1 - 0.62 * t);

  const plaits = 3;
  const perPlait = 3;
  for (let k = 0; k < plaits; k++) {
    for (let j = 0; j < perPlait; j++) {
      const phase = (k / plaits) * Math.PI * 2 + (j - 1) * 0.32;
      const pts = braidPlait(
        centreline, n1, n2,
        (t) => ropeR(t) * (0.75 + 0.25 * j / perPlait),
        phase, 1.35
      );
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.25),
        tint: tintFor(ctx),
        seed: rng(),
        twist: 0.4,
        face: null,
        priority: 3
      });
    }
  }

  // Loose flyaways off the braid so it isn't a clean rope.
  for (let i = 0; i < 12; i++) {
    const t = rng();
    const idx = Math.min(centreline.length - 2, Math.floor(t * (centreline.length - 1)));
    const root = centreline[idx].clone()
      .addScaledVector(n1, (rng() - 0.5) * R * 0.3)
      .addScaledVector(n2, (rng() - 0.5) * R * 0.3);
    const d0 = new THREE.Vector3(rng() - 0.5, -0.6, rng() - 0.5).normalize();
    const pts = growStrand(rng, root, d0, {
      length: R * 0.6, segs: 3, gravity: 0.5, stiff: 0.3,
      noise: 0.18, curl: 0, up
    });
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 0.55),
      tint: tintFor(ctx), seed: rng(), priority: 2
    });
  }

  // Bindings.
  for (let b = 0; b < 3; b++) {
    const t = b === 0 ? 0.02 : b === 1 ? 0.55 : 0.96;
    const idx = clamp(Math.round(t * (centreline.length - 1)), 0, centreline.length - 1);
    const c = centreline[idx];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const rr = ropeR(t) * 1.15;
      const p0 = c.clone().addScaledVector(n1, Math.cos(a) * rr).addScaledVector(n2, Math.sin(a) * rr);
      const p1 = c.clone()
        .addScaledVector(n1, Math.cos(a + 1.6) * rr)
        .addScaledVector(n2, Math.sin(a + 1.6) * rr);
      pushStrand(ctx, [p0, p1], {
        width: strandWidth(ctx, 1.1),
        tint: clamp01(tintFor(ctx) * 0.55),
        seed: rng(), priority: 3
      });
    }
  }
}

/**
 * Sagittal crest — a full mohawk for style 3, or a partial ridge for races
 * that keep one regardless (Troll, Orc, Worgen, Goblin, Dracthyr).
 */
function emitCrest(ctx) {
  const { rng, R, center, up, fwd, right, style, profile } = ctx;
  const strength = style.crest ? 1 : profile.crest;
  if (strength <= 0) return;
  const full = !!style.crest;
  const rows = full ? 26 : Math.round(14 * strength);
  const perRow = full ? 3 : 2;
  const height = R * (full ? 1.55 : 0.90) * (1 + profile.tie * 0.30) *
    (0.55 + 0.45 * profile.length);

  const dir = new THREE.Vector3();
  for (let i = 0; i < rows; i++) {
    const s = (i + 0.5) / rows;
    // Arc from the front hairline over the crown to the nape.
    const theta = lerp(-1.05, 1.65, s);
    const phi = theta < 0 ? 0 : Math.PI; // front half vs back half
    const th = Math.abs(theta);
    domePoint(ctx.frame, th, theta < 0 ? 0 : Math.PI, dir);
    void phi;
    const rootBase = center.clone().addScaledVector(dir, R * 0.99);

    // Classic mohawk profile: tallest just behind the crown.
    const tall = 0.42 + 0.85 * Math.sin(Math.PI * clamp01(s * 0.92 + 0.06));
    for (let j = 0; j < perRow; j++) {
      const off = (j - (perRow - 1) / 2) * R * 0.055;
      const root = rootBase.clone().addScaledVector(right, off + (rng() - 0.5) * R * 0.03);
      const d0 = up.clone().multiplyScalar(1.0)
        .addScaledVector(dir, 0.45)
        .addScaledVector(right, off * 2.5 / R)
        .addScaledVector(fwd, -0.12);
      const P = {
        length: height * tall * (0.85 + rng() * 0.3),
        segs: full ? 5 : 4,
        gravity: (full ? 0.16 : 0.28) * profile.gravity,
        stiff: 0.55,
        noise: 0.13 * profile.noise,
        curl: 0.04,
        curlFreq: 1.4,
        curlAxis: right.clone(),
        drift: fwd.clone().multiplyScalar(-1),
        driftAmt: 0.10,
        skullCenter: center,
        skullRadius: R * 1.02,
        up
      };
      const pts = growStrand(rng, root, d0, P);
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, (full ? 1.5 : 1.1) + rng() * 0.4),
        tint: tintFor(ctx),
        seed: rng(),
        twist: (rng() - 0.5) * 0.4,
        // The crest is a fin in the sagittal plane: cards face sideways.
        face: right.clone(),
        priority: full ? 3 : 2
      });
    }
  }
}

/** Tauren (and Worgen ruff) — a mane running from the nape down the neck. */
function emitMane(ctx, joints) {
  const { rng, R, center, up, fwd, right, profile, style } = ctx;
  const neck = joints && joints.neck;
  const neckPos = neck && neck.position
    ? neck.position.clone()
    : center.clone().addScaledVector(up, -R * 1.6);
  const neckR = (neck && neck.radius) || R * 0.7;

  const spine = (joints && joints.spine) || null;
  const rows = 9;
  const perRow = 4;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    let base;
    if (spine && spine.length > 1) {
      // Walk from the neck end of the spine downward.
      const f = (1 - t * 0.45) * (spine.length - 1);
      const i0 = clamp(Math.floor(f), 0, spine.length - 1);
      const i1 = clamp(i0 + 1, 0, spine.length - 1);
      base = spine[i0].clone().lerp(spine[i1], f - i0);
    } else {
      base = neckPos.clone().addScaledVector(up, -t * R * 1.4);
    }
    base.addScaledVector(fwd, -(neckR * (0.85 + 0.25 * t)));

    for (let j = 0; j < perRow; j++) {
      const u = (j / (perRow - 1)) * 2 - 1;
      const root = base.clone()
        .addScaledVector(right, u * neckR * 0.85 * (1 - 0.25 * t))
        .addScaledVector(fwd, -Math.cos(u * 1.2) * neckR * 0.12);
      const d0 = fwd.clone().multiplyScalar(-0.9)
        .addScaledVector(right, u * 0.5)
        .addScaledVector(up, 0.25 - t * 0.5);
      const P = {
        length: R * lerp(2.4, 1.1, t) * profile.length * (0.8 + rng() * 0.4),
        segs: 5,
        gravity: 0.48 * profile.gravity,
        stiff: 0.30,
        noise: 0.14 * profile.noise,
        curl: 0.05,
        curlFreq: 1.1,
        curlAxis: right.clone(),
        up
      };
      const pts = growStrand(rng, root, d0, P);
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.5 + rng() * 0.6),
        tint: clamp01(tintFor(ctx) * 0.9),
        seed: rng(),
        twist: (rng() - 0.5) * 0.6,
        priority: 3
      });
    }
  }
  void style;
}

/* ---------------------- facial hair ------------------------------- */

function emitFacial(ctx, joints) {
  const plan = facialPlan(ctx.raceName, STYLES.indexOf(ctx.style));
  if (!plan) return;
  if (plan.beard > 0) emitBeard(ctx, plan);
  if (plan.mustache) emitMustache(ctx, plan);
  if (plan.sideburns) emitSideburns(ctx, plan);
  if (plan.braids > 0) emitBeardBraids(ctx, plan);
  if (plan.tendrils > 0) emitTendrils(ctx, plan);
  if (plan.ruff > 0) emitRuff(ctx, plan, joints);
}

function jawPoint(ctx, theta, phi, out) {
  // Same dome parameterisation, squashed forward for a snout.
  const snout = clamp(ctx.feat.snout || 0, 0, 1);
  domePoint(ctx.frame, theta, phi, out);
  out.addScaledVector(ctx.fwd, snout * 0.35 * Math.max(0, Math.cos(phi)) * Math.sin(theta));
  return out.normalize();
}

function emitBeard(ctx, plan) {
  const { rng, R, center, up, fwd, right, profile, feat } = ctx;
  const density = plan.beard;
  const n = Math.round(50 * density * clamp(profile.density, 0.6, 1.3));
  const dir = new THREE.Vector3();
  const chinOnly = !!plan.chinOnly;

  for (let i = 0; i < n; i++) {
    const spreadPhi = chinOnly ? 0.55 : 1.15;
    const phi = (rng() - 0.5) * 2 * spreadPhi;
    const theta = chinOnly
      ? lerp(2.35, 2.85, rng())
      : lerp(1.85, 2.80, Math.pow(rng(), 0.75));
    // Skip the mouth.
    if (!chinOnly && theta < 2.05 && Math.abs(phi) < 0.32) continue;

    jawPoint(ctx, theta, phi, dir);
    const root = center.clone().addScaledVector(dir, R * 0.99);

    const front = clamp01(Math.cos(phi));
    const len = R * (chinOnly ? 0.85 : 1.65) * (plan.length || 1) *
      (0.55 + 0.65 * front) * (0.8 + rng() * 0.45);

    const d0 = dir.clone().multiplyScalar(0.5)
      .addScaledVector(up, -0.85)
      .addScaledVector(fwd, 0.18 * front);
    if (feat.tusks) d0.addScaledVector(right, (phi >= 0 ? 1 : -1) * 0.12);

    const P = {
      length: len,
      segs: len > R * 1.4 ? 5 : 3,
      gravity: 0.55 * profile.gravity,
      stiff: 0.34,
      noise: 0.12 * profile.noise,
      curl: 0.06,
      curlFreq: 1.2,
      curlAxis: right.clone(),
      skullCenter: center,
      skullRadius: R * 1.01,
      up
    };
    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 1.15 + rng() * 0.5),
      tint: tintFor(ctx),
      seed: rng(),
      twist: (rng() - 0.5) * 0.7,
      face: dir.clone(),
      priority: 3
    });
  }
}

function emitMustache(ctx, plan) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  const n = 14;
  const dir = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const s = i < n / 2 ? -1 : 1;
    const k = (i % (n / 2)) / (n / 2 - 1 || 1);
    const phi = s * lerp(0.10, 0.52, k);
    const theta = lerp(1.92, 2.05, rng());
    jawPoint(ctx, theta, phi, dir);
    const root = center.clone().addScaledVector(dir, R * 0.99);
    const d0 = dir.clone().multiplyScalar(0.6)
      .addScaledVector(right, s * (0.5 + k * 0.7))
      .addScaledVector(up, -0.35 - k * 0.3);
    const pts = growStrand(rng, root, d0, {
      length: R * 0.85 * (plan.length || 1) * (0.8 + rng() * 0.4),
      segs: 3,
      gravity: 0.42 * profile.gravity,
      stiff: 0.5,
      noise: 0.08,
      curl: 0,
      up
    });
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 1.0 + rng() * 0.3),
      tint: tintFor(ctx),
      seed: rng(),
      face: dir.clone(),
      priority: 3
    });
    void fwd;
  }
}

function emitSideburns(ctx, plan) {
  const { rng, R, center, up, right, profile } = ctx;
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 7; i++) {
      const theta = lerp(1.35, 2.0, i / 6) + (rng() - 0.5) * 0.1;
      const phi = s * (1.25 + (rng() - 0.5) * 0.22);
      const dir = new THREE.Vector3();
      domePoint(ctx.frame, theta, phi, dir);
      const root = center.clone().addScaledVector(dir, R * 0.99);
      const d0 = dir.clone().multiplyScalar(0.45).addScaledVector(up, -0.9);
      const pts = growStrand(rng, root, d0, {
        length: R * 1.0 * (plan.length || 1) * (0.7 + rng() * 0.5),
        segs: 3,
        gravity: 0.5 * profile.gravity,
        stiff: 0.42,
        noise: 0.1,
        curl: 0,
        skullCenter: center,
        skullRadius: R * 1.01,
        up
      });
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.2),
        tint: tintFor(ctx),
        seed: rng(),
        face: dir.clone(),
        priority: 3
      });
      void right;
    }
  }
}

function emitBeardBraids(ctx, plan) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  const count = plan.braids;
  for (let b = 0; b < count; b++) {
    const s = count === 1 ? 0 : (b % 2 === 0 ? -1 : 1) * (0.34 + 0.16 * Math.floor(b / 2));
    const dir = new THREE.Vector3();
    jawPoint(ctx, 2.55, s, dir);
    const anchor = center.clone().addScaledVector(dir, R * 1.0);

    const segs = 6;
    const centreline = [];
    const p = anchor.clone();
    const d = dir.clone().multiplyScalar(0.35).addScaledVector(up, -1).normalize();
    const len = R * 2.2 * (plan.length || 1) * profile.length;
    for (let i = 0; i <= segs; i++) {
      centreline.push(p.clone());
      d.addScaledVector(up, -0.35).addScaledVector(fwd, -0.04);
      d.normalize();
      p.addScaledVector(d, len / segs);
    }
    const n1 = right.clone();
    const n2 = new THREE.Vector3().crossVectors(right, up).normalize();
    for (let k = 0; k < 3; k++) {
      const pts = braidPlait(
        centreline, n1, n2,
        (t) => R * 0.085 * (1 - 0.55 * t),
        (k / 3) * Math.PI * 2, 1.5
      );
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 0.95),
        tint: tintFor(ctx),
        seed: rng(),
        priority: 3
      });
    }
    // Bead / clasp at the tip.
    const tip = centreline[centreline.length - 1];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const p0 = tip.clone().addScaledVector(n1, Math.cos(a) * R * 0.09)
        .addScaledVector(n2, Math.sin(a) * R * 0.09);
      const p1 = tip.clone().addScaledVector(n1, Math.cos(a + 2.1) * R * 0.09)
        .addScaledVector(n2, Math.sin(a + 2.1) * R * 0.09);
      pushStrand(ctx, [p0, p1], {
        width: strandWidth(ctx, 0.9),
        tint: clamp01(tintFor(ctx) * 0.5),
        seed: rng(),
        priority: 3
      });
    }
  }
}

/** Draenei facial tendrils — thick, smooth, hanging from the cheeks. */
function emitTendrils(ctx, plan) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  const per = Math.max(1, Math.round(plan.tendrils / 2));
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < per; i++) {
      const phi = s * lerp(0.55, 0.95, per === 1 ? 0.5 : i / (per - 1));
      const theta = lerp(1.95, 2.25, rng());
      const dir = new THREE.Vector3();
      jawPoint(ctx, theta, phi, dir);
      const root = center.clone().addScaledVector(dir, R * 0.99);
      const d0 = dir.clone().multiplyScalar(0.4).addScaledVector(up, -1.0)
        .addScaledVector(fwd, 0.15);
      const pts = growStrand(rng, root, d0, {
        length: R * 1.6 * (plan.length || 1) * profile.length * (0.85 + rng() * 0.3),
        segs: 5,
        gravity: 0.6 * profile.gravity,
        stiff: 0.55,
        noise: 0.04,
        curl: 0.05,
        curlFreq: 0.9,
        curlAxis: right.clone(),
        up
      });
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 2.2),
        tint: clamp01(tintFor(ctx) * 0.8),
        seed: rng(),
        twist: 0.3,
        priority: 3
      });
    }
  }
}

/** Worgen neck ruff — a collar of outward-flaring fur. */
function emitRuff(ctx, plan, joints) {
  const { rng, R, center, up, fwd, right, profile } = ctx;
  const neck = joints && joints.neck;
  const base = neck && neck.position
    ? neck.position.clone()
    : center.clone().addScaledVector(up, -R * 1.5);
  const neckR = (neck && neck.radius) || R * 0.7;
  const n = 30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.15;
    const radial = fwd.clone().multiplyScalar(Math.cos(a))
      .addScaledVector(right, Math.sin(a)).normalize();
    const root = base.clone().addScaledVector(radial, neckR * 0.95)
      .addScaledVector(up, (rng() - 0.5) * R * 0.3);
    const d0 = radial.clone().multiplyScalar(0.9).addScaledVector(up, 0.35);
    const pts = growStrand(rng, root, d0, {
      length: R * 1.3 * (plan.length || 1) * profile.length * (0.7 + rng() * 0.6),
      segs: 3,
      gravity: 0.35 * profile.gravity,
      stiff: 0.5,
      noise: 0.2 * profile.noise,
      curl: 0,
      up
    });
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 1.6 + rng() * 0.6),
      tint: tintFor(ctx),
      seed: rng(),
      twist: (rng() - 0.5) * 0.8,
      priority: 2
    });
  }
}

/* ------------------------------------------------------------------ *
 * assembly
 * ------------------------------------------------------------------ */

function assemble(strands, material, rng, raceName, styleId) {
  // Budget: keep high-priority strands (crest, braid, beard, mane), thin the
  // scalp field at random until we fit.
  const order = strands.slice().sort((a, b) => (b.priority - a.priority) || (a.rank - b.rank));
  const kept = [];
  let count = 0;
  for (const s of order) {
    const cards = s.points.length - 1;
    if (cards <= 0) continue;
    if (count + cards > MAX_INSTANCES) continue;
    kept.push(s);
    count += cards;
  }
  if (!count) return null;

  const geometry = createCardGeometry();
  const seeds = new Float32Array(count);
  const tints = new Float32Array(count);
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const m = new THREE.Matrix4();
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const hint = new THREE.Vector3();
  const fallback = new THREE.Vector3();

  let idx = 0;
  for (const s of kept) {
    const pts = s.points;
    // Reference point cards face away from: the strand's own start region.
    const originRef = s.face ? null : pts[0];
    let width = s.width;
    for (let k = 0; k < pts.length - 1; k++) {
      const p0 = pts[k];
      const p1 = pts[k + 1];
      tangent.copy(p1).sub(p0);
      const len = tangent.length();
      if (len < 1e-6) { width *= CARD_TIP; continue; }
      tangent.divideScalar(len);

      if (s.face) hint.copy(s.face);
      else hint.copy(p0).sub(originRef).normalize();
      if (hint.lengthSq() < 1e-8) hint.copy(UP_Y);

      // x = width axis, z = card facing axis (~hint), y = along the strand.
      xAxis.crossVectors(hint, tangent);
      if (xAxis.lengthSq() < 1e-8) {
        fallback.set(0, 1, 0);
        xAxis.crossVectors(fallback, tangent);
        if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
      }
      xAxis.normalize();
      zAxis.crossVectors(tangent, xAxis).normalize();

      // Progressive twist along the chain keeps the ribbon from reading flat.
      const ang = s.twist + k * 0.16;
      if (ang !== 0) {
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const nx = xAxis.x * c + zAxis.x * sn;
        const ny = xAxis.y * c + zAxis.y * sn;
        const nz = xAxis.z * c + zAxis.z * sn;
        zAxis.set(
          zAxis.x * c - xAxis.x * sn,
          zAxis.y * c - xAxis.y * sn,
          zAxis.z * c - xAxis.z * sn
        );
        xAxis.set(nx, ny, nz);
      }

      xAxis.multiplyScalar(width);
      zAxis.multiplyScalar(width);
      yAxis.copy(tangent).multiplyScalar(len);

      m.makeBasis(xAxis, yAxis, zAxis);
      m.setPosition(p0.x, p0.y, p0.z);
      mesh.setMatrixAt(idx, m);
      seeds[idx] = s.seed;
      tints[idx] = s.tint;
      idx++;

      width *= CARD_TIP;
    }
  }

  // Any degenerate cards we skipped leave trailing identity matrices; collapse
  // them so nothing renders at the origin.
  if (idx < count) {
    m.makeScale(0, 0, 0);
    for (let i = idx; i < count; i++) {
      mesh.setMatrixAt(i, m);
      seeds[i] = 0;
      tints[i] = 0.5;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aStrandSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aStrandTint', new THREE.InstancedBufferAttribute(tints, 1));

  mesh.name = 'hair-' + styleId;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  mesh.userData.hair = {
    race: raceName,
    style: styleId,
    strands: kept.length,
    instances: count,
    attributes: ['aStrandSeed', 'aStrandTint']
  };
  void rng;
  return mesh;
}

export const HAIR_STYLE_NAMES = STYLES.map((s) => s.name);

export default buildHairGeometry;
