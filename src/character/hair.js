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
 * material handed in by the caller. Per-instance `aStrandSeed`, `aStrandTint`
 * and `aStrandSpan` instanced attributes let that material break up tint and
 * shading per lock, and tell it where each card sits inside its strand.
 *
 * Two things this file has to get right, both of which are invisible in
 * isolation and catastrophic in the render (see the long comments at
 * `scalpFrame` and `createCardGeometry`):
 *
 *   1. The head is a triaxial dome, not a sphere of `head.radius`. Roots
 *      placed on a sphere sink into the skin over the crown and the hair
 *      disappears there.
 *   2. The card's UV convention is a contract with materials/hair.js: U across
 *      the ribbon face, V tiling from card to card along a chain.
 *
 *   buildHairGeometry(race, features, joints, { styleIndex, material })
 *     -> THREE.InstancedMesh | null
 */

const MAX_INSTANCES = 900;

// Card geometry constants. CARD_TIP is load-bearing: it is both the taper of a
// single card and the per-card width ratio along a strand chain.
const CARD_RINGS = 4;
const CARD_TIP = 0.74;
// Twist baked into one card. `assemble` advances the instance twist by exactly
// this much per card in a chain, so card k's tip cross-section and card k+1's
// root cross-section are the same rotation and the lock does not kink at every
// join. Changing one without the other puts a visible facet at every seam.
const CARD_TWIST = 0.10;
const CARD_THICK = 0.22; // half-thickness relative to half-width
// Widest a card is allowed to be relative to its own length. See `assemble`.
const MAX_CARD_ASPECT = 0.95;

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
  //
  // The third column is U. It is NOT the perimeter arc-length: the card texture
  // baked by materials/hair.js paints its strands across U in 0..1 and feathers
  // *both* U borders, so U has to run across the ribbon's face. Wrapping U once
  // around the closed loop instead (0, .25, .5, .75, 1) squeezes half the
  // strands onto the front face and half onto the back, and lands both feathered
  // borders on the same physical edge — leaving the opposite edge a hard cut.
  // Mirroring U over the loop gives each face the full strand set with a soft
  // edge on both sides, and front/back agree on where each strand is.
  const cross = [
    [0.5, 0, 0],
    [0, CARD_THICK * 0.5, 0.5],
    [-0.5, 0, 1],
    [0, -CARD_THICK * 0.5, 0.5]
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
    // The pow() term is the chain-matching taper; the bulge term is 0 at
    // both ends so consecutive cards still meet exactly.
    const w = Math.pow(CARD_TIP, v) * (1 + 0.28 * v * (1 - v));
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
      uvs[q++] = c[2];
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
  let fitted = false;

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
      fitted = true;
    }
  }

  // THE SKULL IS NOT A SPHERE, AND THIS IS THE WHOLE BALLGAME.
  //
  // `head.radius` is one scale factor; the body loft builds the cranium as a
  // deformed ellipsoid roughly (0.95, 1.14, 1.00) x that radius, with a heavier
  // occiput behind. Rooting hair on a sphere of head.radius sinks the entire
  // crown ~13% of a head radius *inside the skin*: every card up there is
  // swallowed by the head mesh, the crown renders bald, and the only hair you
  // can see is the low-latitude strands where the sphere pokes back out through
  // the narrower temples — i.e. hard fragments erupting from the sides of an
  // otherwise bare skull. Even a 2% under-estimate here costs whole patches,
  // because a card lying flat on the scalp only clears the skin by a fraction
  // of its own width.
  //
  // So: model the dome triaxially, and err *outwards*. A root floating 3 mm
  // proud of the skin is invisible; a root 3 mm under it is gone. The one axis
  // that can be measured rather than assumed is the polar one —
  // `joints.scalp.position` is a real point ON the surface near the crown — so
  // fit that and keep conservative constants for the rest.
  const ax = radius * 0.99;   // ear to ear
  const azF = radius * 1.03;  // brow
  const azB = radius * 1.14;  // occiput
  let ay = radius * 1.15;     // crown, replaced by the fit below
  if (fitted) {
    const d = scalp.position.clone().sub(center);
    const along = d.dot(up);
    d.addScaledVector(up, -along);
    const lateral = d.length();
    // Anchor must actually be up on the dome for the fit to be meaningful.
    if (along > radius * 0.35) {
      let re = ax;
      if (lateral > 1e-9) {
        const xh = d.dot(right) / lateral;
        const zh = d.dot(forward) / lateral;
        const az = lerp(azF, azB, clamp01(0.5 - 0.5 * zh));
        re = 1 / Math.sqrt((xh * xh) / (ax * ax) + (zh * zh) / (az * az));
      }
      const k = clamp(lateral / re, 0, 0.92);
      ay = clamp(along / Math.sqrt(1 - k * k), radius * 0.9, radius * 1.9);
    }
  }

  return {
    center, radius, up, forward, right,
    ax, ay, azF, azB,
    anchor: scalp.position.clone()
  };
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

// Scratch for the dome maths; every helper below runs in the build loop.
const _dx = { x: 0, y: 0, z: 0, ax: 1, ay: 1, az: 1 };
function domeAxes(frame, dir) {
  _dx.x = dir.dot(frame.right);
  _dx.y = dir.dot(frame.up);
  _dx.z = dir.dot(frame.forward);
  _dx.ax = frame.ax;
  _dx.ay = frame.ay;
  _dx.az = lerp(frame.azF, frame.azB, clamp01(0.5 - 0.5 * _dx.z));
  return _dx;
}

/** Distance from the head centre to the skull surface along a unit direction. */
function domeRadius(frame, dir) {
  const A = domeAxes(frame, dir);
  const q = (A.x * A.x) / (A.ax * A.ax) +
    (A.y * A.y) / (A.ay * A.ay) +
    (A.z * A.z) / (A.az * A.az);
  return q > 1e-12 ? 1 / Math.sqrt(q) : frame.radius;
}

/** Root a strand on the skull surface along `dir`, at `k` x the surface depth. */
function rootAt(ctx, dir, k, out) {
  const r = domeRadius(ctx.frame, dir) * k;
  return (out || new THREE.Vector3()).copy(ctx.center).addScaledVector(dir, r);
}

/**
 * Outward surface normal of the skull at the point `dir` picks out. On anything
 * but a sphere this is NOT the radius direction, and cards laid flat against
 * the radius instead of the normal tip into the skin near the temples.
 */
function domeNormal(frame, dir, out) {
  const A = domeAxes(frame, dir);
  out.set(0, 0, 0)
    .addScaledVector(frame.right, A.x / (A.ax * A.ax))
    .addScaledVector(frame.up, A.y / (A.ay * A.ay))
    .addScaledVector(frame.forward, A.z / (A.az * A.az));
  if (out.lengthSq() < 1e-12) out.copy(dir);
  return out.normalize();
}

/** The skull volume a growing strand is not allowed to sink into. */
function skullOf(ctx, inflate) {
  return { frame: ctx.frame, center: ctx.center, up: ctx.up, k: inflate == null ? 1 : inflate };
}

/* ------------------------------------------------------------------ *
 * style + race tables
 * ------------------------------------------------------------------ */

// FEWER, WIDER CARDS. `width` is up by roughly half and `strands` down by
// roughly a third against round 2, at close to the same instance count.
//
// The card map paints its fibres across the ribbon's face, so how many hairs
// you can actually see is set by how many *pixels* wide the card is, not by how
// many cards there are. At round 2's 0.32 R the mass card was ~40 px across at
// face framing carrying 13 painted fibres — 3 px per fibre including its gap,
// which no mip chain can hold on to. The card filled in solid and every one of
// them read as a flat dark shard. Wider cards with fewer, finer hairs on them
// is the trade that makes the fibres survive; materials/hair.js dropped its
// fibre counts to match, and 16% of each card's width is now bare border, which
// the extra width pays for.
const STYLES = [
  {
    id: 'long', name: 'Long Flowing',
    strands: 80, length: 3.3, segs: 6, gravity: 0.62, stiff: 0.16, outward: 0.16,
    noise: 0.09, curl: 0.06, width: 0.50, thetaFront: 1.02, thetaBack: 2.10,
    cap: 1.0, flow: 0.38, part: 0.42, fringe: 0.34
  },
  {
    id: 'braid', name: 'Braided',
    strands: 58, length: 1.10, segs: 4, gravity: 0.34, stiff: 0.42, outward: 0.15,
    noise: 0.05, curl: 0.02, width: 0.46, thetaFront: 0.96, thetaBack: 1.92,
    cap: 1.0, flow: 0.88, part: 0.15, fringe: 0.55,
    gather: 'nape', braid: true
  },
  {
    id: 'topknot', name: 'Topknot',
    strands: 60, length: 1.00, segs: 4, gravity: 0.20, stiff: 0.50, outward: 0.12,
    noise: 0.05, curl: 0.02, width: 0.46, thetaFront: 0.92, thetaBack: 1.78,
    cap: 0.9, flow: 0.92, part: 0.10, fringe: 0.6,
    gather: 'crown', plume: true
  },
  {
    id: 'mohawk', name: 'Mohawk',
    strands: 28, length: 0.50, segs: 3, gravity: 0.42, stiff: 0.60, outward: 0.32,
    noise: 0.16, curl: 0.0, width: 0.32, thetaFront: 1.05, thetaBack: 1.85,
    cap: 0.35, flow: 0.5, part: 0.2, fringe: 0.8,
    shaved: true, crest: 1.0
  },
  {
    id: 'crop', name: 'Short Crop',
    strands: 112, length: 0.62, segs: 3, gravity: 0.40, stiff: 0.58, outward: 0.38,
    noise: 0.17, curl: 0.0, width: 0.40, thetaFront: 1.14, thetaBack: 2.00,
    cap: 1.15, flow: 0.45, part: 0.25, fringe: 0.85
  },
  {
    id: 'swept', name: 'Swept Back',
    strands: 86, length: 1.50, segs: 5, gravity: 0.30, stiff: 0.52, outward: 0.15,
    noise: 0.06, curl: 0.03, width: 0.46, thetaFront: 1.02, thetaBack: 2.05,
    cap: 1.0, flow: 1.0, part: 0.05, fringe: 0.7,
    sweep: 1.0
  },
  {
    id: 'twin', name: 'Twin Tails',
    strands: 66, length: 0.95, segs: 4, gravity: 0.28, stiff: 0.46, outward: 0.14,
    noise: 0.05, curl: 0.03, width: 0.46, thetaFront: 1.00, thetaBack: 1.92,
    cap: 1.0, flow: 0.8, part: 0.35, fringe: 0.5,
    gather: 'twin', tails: true
  },
  {
    id: 'wild', name: 'Wild / Matted',
    strands: 74, length: 2.0, segs: 5, gravity: 0.40, stiff: 0.34, outward: 0.48,
    noise: 0.30, curl: 0.16, width: 0.52, thetaFront: 1.12, thetaBack: 2.12,
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
    // The skull is the fitted triaxial dome, not a sphere — see scalpFrame().
    if (P.skull) {
      tmp.copy(pos).sub(P.skull.center);
      const d = tmp.length();
      if (d > 1e-6) {
        tmp.divideScalar(d);
        if (tmp.dot(P.skull.up) > -0.45) {
          const rr = domeRadius(P.skull.frame, tmp) * P.skull.k;
          if (d < rr) pos.copy(P.skull.center).addScaledVector(tmp, rr);
        }
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
  emitFlyaway(ctx);
  if (style.gather === 'nape' || style.braid) emitBraids(ctx);
  if (style.plume) emitTopknot(ctx);
  if (style.tails) emitTwinTails(ctx);
  if (style.crest > 0 || profile.crest > 0) emitCrest(ctx);
  if (profile.mane > 0) emitMane(ctx, joints);
  emitFacial(ctx, joints);

  if (!strands.length) return null;

  return assemble(strands, material, raceName, style.id);
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
    axis: o.axis || null,
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
  const { style, profile, rng, R } = ctx;
  if (!style.cap) return;
  // CROSSED PASSES. A card lying flat on the scalp is a plate whose
  // normal is the scalp normal, so it hides scalp well when you look straight
  // at it and hides almost nothing when you look along it. Every cap card
  // following the same flow field means they all foreshorten *together* — at
  // the crown, seen from the front, the whole layer collapses to a set of thin
  // lines and the skin comes through between them. Fanning the passes across
  // the flow guarantees that from any angle one pass is still presenting area.
  const n = Math.round(30 * style.cap * clamp(profile.density, 0.5, 1.4));
  const fan = [0, 1.20, -1.20];
  const dir = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const root = new THREE.Vector3();
  const flow = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let pass = 0; pass < fan.length; pass++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const theta = Math.acos(1 - u * 0.98) * (0.97 + pass * 0.035);
      const phi = i * 2.399963 + pass * 1.17 + rng() * 0.35;
      if (!acceptRoot(ctx, theta, phi, -0.10)) continue;
      domePoint(ctx.frame, theta, phi, dir);
      domeNormal(ctx.frame, dir, nrm);
      // Sit the cap a hair proud of the skin: buried roots are invisible roots.
      rootAt(ctx, dir, 1.006 + pass * 0.008, root);
      const P = {
        length: R * (0.78 - pass * 0.06) * profile.length,
        segs: 1,
        gravity: (pass === 0 ? 0.32 : 0.18) * profile.gravity,
        stiff: 0.74,
        noise: 0.05,
        curl: 0,
        skull: skullOf(ctx, 1.005 + pass * 0.008),
        up: ctx.up
      };
      flowDir(ctx, nrm, clamp01((style.flow || 0.4) * 0.8 + 0.15), flow);
      const a = fan[pass] + (rng() - 0.5) * 0.35;
      side.crossVectors(nrm, flow);
      const d0 = flow.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      // Barely lifted. At 0.24 these plates stood proud of the crown and their
      // corners were a large part of what spiked the silhouette; the cap's job
      // is to fill the parting from underneath, not to contribute an outline.
      d0.addScaledVector(nrm, 0.09);
      const pts = growStrand(rng, root, d0, P);
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.10 - pass * 0.06),
        // Deliberately at the dark end of the range. This is the layer the
        // outer hair is meant to be sitting in front of, and the material reads
        // aStrandTint as a straight value multiplier, so a dark cap is what
        // gives the mass somewhere to be deep.
        tint: clamp01(tintFor(ctx) * (0.34 + pass * 0.05)),
        seed: rng(),
        twist: (rng() - 0.5) * 0.35,
        face: nrm.clone(),
        priority: 4 - pass * 0.25
      });
    }
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
  const nrm = new THREE.Vector3();
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
    domeNormal(ctx.frame, dir, nrm);
    rootAt(ctx, dir, 1.005, root);

    const volume = profile.volume;
    const front = clamp01(0.5 + 0.5 * Math.cos(phi));

    // Grow along the scalp's flow field, lifted off the surface by `outward`.
    // The fringe gets less lift than the rest: a strand that leaves the
    // hairline pointing away from the skull is a plank standing off the
    // forehead, and a dozen of them is the row of planks the fringe read as.
    const d0 = flowDir(ctx, nrm, clamp01(style.flow), new THREE.Vector3());
    d0.addScaledVector(nrm, (style.outward * (0.6 + 0.4 * volume) + 0.08) * (1 - 0.55 * front));
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
      // Only a gentle pull toward the body. Hair has nothing to collide with
      // below the skull, so a strong inward drift walks long locks straight
      // into the torso mesh, where they cost instances and render nothing.
      driftVec = inward.clone().multiplyScalar(0.28)
        .addScaledVector(fwd, -0.30).normalize();
      driftAmt = 0.12;
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
      // A short strand cut into as many cards as a long one gives cards that
      // are wider than they are tall, i.e. lozenges. Keep the fringe on fewer,
      // longer links; `assemble` also caps the aspect as a backstop.
      segs: Math.max(2, Math.round(style.segs * lerp(1.0, 0.62, front))),
      gravity: style.gravity * profile.gravity * (1 + 0.45 * front),
      stiff: style.stiff,
      noise: style.noise * profile.noise * 0.35 * (1 + 0.9 * front),
      curl: style.curl + 0.05 * front,
      curlFreq: 1.1 + rng() * 0.8,
      curlAxis: right.clone().multiplyScalar(Math.sin(phi) >= 0 ? 1 : -1),
      drift: driftVec,
      driftAmt,
      gather,
      gatherAmt: gather ? 0.55 : 0,
      gatherSegs: Math.max(1, style.segs - 1),
      skull: skullOf(ctx, 1.01),
      up
    };

    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      // Narrower over the forehead, where the mass has to break into separate
      // hanging locks rather than tile the brow with slabs.
      width: strandWidth(ctx, (0.85 + rng() * 0.45) * lerp(1.0, 0.66, front)),
      // The mid layer, sitting between the dark cap and the light flyaways.
      tint: clamp01(0.30 + tintFor(ctx) * 0.62),
      seed: rng(),
      twist: (rng() - 0.5) * 0.5,
      face: nrm.clone(),
      axis: { origin: center, up },
      priority: 1
    });
  }
}

/**
 * Outer wisp layer — short, thin, numerous cards lying over the top of the
 * mass.
 *
 * Two jobs, both about the silhouette. The mass is built from a few dozen wide
 * locks, and a few dozen wide locks end in a few dozen wide points: the outline
 * comes out as a row of triangles, which reads as broken geometry rather than
 * as hair. These are narrow enough to read as single hairs at the edge and
 * dense enough to fill in between the locks' outlines.
 *
 * They are also the layer that catches the rim. They carry the top of the tint
 * range, so the material's value ramp lands its lightest hair here, on the
 * outside of the mass where light actually reaches — which is the difference
 * between a lit head of hair and a flat dark helmet.
 */
function emitFlyaway(ctx) {
  const { style, profile, rng, R } = ctx;
  const n = Math.round(58 * clamp(profile.density, 0.5, 1.35) * (style.shaved ? 0.45 : 1));
  if (n <= 0) return;

  const dir = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const root = new THREE.Vector3();
  const flow = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const theta = Math.acos(1 - u * (1 - Math.cos(2.05))) + (rng() - 0.5) * 0.20;
    const phi = i * 2.399963 + rng() * 0.7;
    if (theta < 0 || !acceptRoot(ctx, theta, phi, (rng() - 0.5) * 0.2)) continue;

    domePoint(ctx.frame, theta, phi, dir);
    domeNormal(ctx.frame, dir, nrm);
    // Rooted out at the surface of the mass, not on the scalp.
    rootAt(ctx, dir, 1.03 + rng() * 0.07, root);

    const front = clamp01(0.5 + 0.5 * Math.cos(phi));
    flowDir(ctx, nrm, clamp01(style.flow), flow);
    side.crossVectors(nrm, flow);
    const a = (rng() - 0.5) * 0.9;
    const d0 = flow.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
    d0.addScaledVector(nrm, 0.16 + rng() * 0.14);

    const pts = growStrand(rng, root, d0, {
      length: R * lerp(0.95, 0.55, front) * profile.length * (0.6 + rng() * 0.8),
      segs: 2,
      gravity: (0.5 + 0.3 * front) * profile.gravity,
      stiff: 0.34,
      noise: 0.12 * profile.noise,
      curl: 0.05,
      curlFreq: 1.5,
      curlAxis: ctx.right.clone(),
      skull: skullOf(ctx, 1.02),
      up: ctx.up
    });
    pushStrand(ctx, pts, {
      // Thin: these are meant to read as a handful of hairs, not as a lock.
      width: strandWidth(ctx, 0.34 + rng() * 0.22),
      tint: clamp01(0.66 + rng() * 0.34),
      seed: rng(),
      twist: (rng() - 0.5) * 0.9,
      face: nrm.clone(),
      axis: { origin: ctx.center, up: ctx.up },
      // Above the scalp field, below the sculpted features: if anything has to
      // be dropped for budget it should be a lock, not the whole outer layer.
      priority: 1.5
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
      skull: skullOf(ctx, 1.02),
      up
    };
    const pts = growStrand(rng, root, d0, P);
    pushStrand(ctx, pts, {
      width: strandWidth(ctx, 1.05 + rng() * 0.5),
      tint: tintFor(ctx),
      seed: rng(),
      twist: (rng() - 0.5) * 1.0,
      // Cards face outward from the knot's axis.
      face: ctx.right.clone().multiplyScalar(Math.cos(a))
        .addScaledVector(fwd, Math.sin(a)),
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
        skull: skullOf(ctx, 1.02),
        up
      };
      const pts = growStrand(rng, root, d0, P);
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.0 + rng() * 0.45),
        tint: tintFor(ctx),
        seed: rng(),
        twist: (rng() - 0.5) * 0.9,
        face: up.clone().multiplyScalar(Math.cos(a))
          .addScaledVector(fwd, Math.sin(a)),
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
        // Radial from the rope axis at the plait's midpoint.
        face: n1.clone().multiplyScalar(Math.cos(phase + 0.675 * Math.PI * 2))
          .addScaledVector(n2, Math.sin(phase + 0.675 * Math.PI * 2)),
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
    // Signed arc: negative sweeps down the forehead, positive down the nape.
    const theta = lerp(-1.05, 1.65, s);
    domePoint(ctx.frame, Math.abs(theta), theta < 0 ? 0 : Math.PI, dir);
    const rootBase = rootAt(ctx, dir, 1.0);

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
        skull: skullOf(ctx, 1.01),
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
  const { rng, R, center, up, fwd, right, profile } = ctx;
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
        // Mane cards lie across the back of the neck.
        face: fwd.clone().multiplyScalar(-1).addScaledVector(right, u * 0.8),
        priority: 3
      });
    }
  }
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
    const root = rootAt(ctx, dir, 1.0);

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
      skull: skullOf(ctx, 1.005),
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
  const { rng, R, center, up, right, profile } = ctx;
  const n = 14;
  const dir = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const s = i < n / 2 ? -1 : 1;
    const k = (i % (n / 2)) / (n / 2 - 1 || 1);
    const phi = s * lerp(0.10, 0.52, k);
    const theta = lerp(1.92, 2.05, rng());
    jawPoint(ctx, theta, phi, dir);
    const root = rootAt(ctx, dir, 1.0);
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
  }
}

function emitSideburns(ctx, plan) {
  const { rng, R, center, up, profile } = ctx;
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 7; i++) {
      const theta = lerp(1.35, 2.0, i / 6) + (rng() - 0.5) * 0.1;
      const phi = s * (1.25 + (rng() - 0.5) * 0.22);
      const dir = new THREE.Vector3();
      domePoint(ctx.frame, theta, phi, dir);
      const root = rootAt(ctx, dir, 1.0);
      const d0 = dir.clone().multiplyScalar(0.45).addScaledVector(up, -0.9);
      const pts = growStrand(rng, root, d0, {
        length: R * 1.0 * (plan.length || 1) * (0.7 + rng() * 0.5),
        segs: 3,
        gravity: 0.5 * profile.gravity,
        stiff: 0.42,
        noise: 0.1,
        curl: 0,
        skull: skullOf(ctx, 1.005),
        up
      });
      pushStrand(ctx, pts, {
        width: strandWidth(ctx, 1.2),
        tint: tintFor(ctx),
        seed: rng(),
        face: dir.clone(),
        priority: 3
      });
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
    const anchor = rootAt(ctx, dir, 1.0);

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
      const root = rootAt(ctx, dir, 1.0);
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

function assemble(strands, material, raceName, styleId) {
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
  // Where this card sits inside its whole strand, as a 0..1 span. The material
  // shades root-to-tip (dark dense root, pale frayed tip) and it has to do that
  // over the *strand*, not over every card: driving it from the card's own
  // uv.y instead restarts the gradient at every join and chops one lock into a
  // row of separately-rooted, separately-tipped fragments.
  const spans = new Float32Array(count * 2);
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const m = new THREE.Matrix4();
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const hint = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const fallback = new THREE.Vector3();

  let idx = 0;
  for (const s of kept) {
    const pts = s.points;
    const nCards = pts.length - 1;
    // Reference point cards face away from: the strand's own start region.
    const originRef = s.face ? null : pts[0];
    // Arc length, so the span of each card matches its share of the lock.
    let total = 0;
    const cum = [0];
    for (let k = 0; k < nCards; k++) {
      total += pts[k].distanceTo(pts[k + 1]);
      cum.push(total);
    }
    if (total < 1e-9) total = 1;

    let width = s.width;
    for (let k = 0; k < nCards; k++) {
      const p0 = pts[k];
      const p1 = pts[k + 1];
      tangent.copy(p1).sub(p0);
      const len = tangent.length();
      if (len < 1e-6) { width *= CARD_TIP; continue; }
      tangent.divideScalar(len);

      if (s.face) hint.copy(s.face);
      else hint.copy(p0).sub(originRef).normalize();

      // The root normal is only the right facing at the root. Once a lock has
      // fallen clear of the skull, keep the ribbon turned away from the body
      // axis instead of frozen in the direction it started in — otherwise long
      // hair rolls edge-on to the camera partway down and reads as a hard line.
      if (s.axis && nCards > 1) {
        radial.copy(p0).sub(s.axis.origin);
        radial.addScaledVector(s.axis.up, -radial.dot(s.axis.up));
        if (radial.lengthSq() > 1e-8) {
          radial.normalize();
          hint.lerp(radial, 0.85 * (k / nCards));
        }
      }
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
      // The step is exactly CARD_TWIST so each card picks up the rotation the
      // previous card's tip ended on and the chain stays a smooth ribbon.
      const ang = s.twist + k * CARD_TWIST;
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

      // NO LOZENGES. A card wider than it is long is not a piece of hair, it is
      // a shard: the taper makes it a triangle, and the eye reads the triangle
      // long before it reads the hairs painted on it. It happens wherever a
      // short strand is cut into the same number of links as a long one — the
      // fringe most of all, which is why the fringe read as a row of stiff
      // planks. Cap the width against this card's own length so the ribbon
      // stays a ribbon everywhere, whatever the style table asks for.
      const drawW = Math.min(width, len * MAX_CARD_ASPECT);
      xAxis.multiplyScalar(drawW);
      zAxis.multiplyScalar(drawW);
      yAxis.copy(tangent).multiplyScalar(len);

      m.makeBasis(xAxis, yAxis, zAxis);
      m.setPosition(p0.x, p0.y, p0.z);
      mesh.setMatrixAt(idx, m);
      seeds[idx] = s.seed;
      tints[idx] = s.tint;
      spans[idx * 2] = cum[k] / total;
      spans[idx * 2 + 1] = cum[k + 1] / total;
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
      spans[i * 2] = 0;
      spans[i * 2 + 1] = 1;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aStrandSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aStrandTint', new THREE.InstancedBufferAttribute(tints, 1));
  geometry.setAttribute('aStrandSpan', new THREE.InstancedBufferAttribute(spans, 2));

  mesh.name = 'hair-' + styleId;
  mesh.castShadow = true;
  // Hair receiving its own shadow is most of what "depth into the mass" is: the
  // key is the rig's only caster, so with this off every layer of the hair was
  // lit as if it were the outermost one and the whole mass flattened to a
  // single value no matter how much per-strand variation was in the material.
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  mesh.userData.hair = {
    race: raceName,
    style: styleId,
    strands: kept.length,
    instances: count,
    attributes: ['aStrandSeed', 'aStrandTint', 'aStrandSpan']
  };
  return mesh;
}

export const HAIR_STYLE_NAMES = STYLES.map((s) => s.name);

export default buildHairGeometry;
