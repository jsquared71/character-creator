// Parametric body loft.
//
// Everything below is generated from `build` + `features` (see the header of
// `src/data/races.js`, which is the spec). There are no capsules, no boxes and
// no per-race special cases keyed off a name: the silhouette differences come
// entirely out of the numbers.
//
// The pipeline is:
//
//   1. integrate a spine curve whose tangent angle ramps with `posture`, so the
//      hunch accumulates up the back instead of being a single rigid tilt;
//   2. loft rings of vertices along that spine and along every limb curve,
//      using per-region radius profiles scaled by the build multipliers;
//   3. build the head as a sculpted skull — see `headSurface`, which carves an
//      orbit, brow, nose, mouth, cheekbone and chin as localised forms on a
//      flattened facial plane — on a grid whose rows and columns are packed
//      onto the face, then bolt ears, tusks and horns onto it in head-local
//      space before transforming the whole assembly onto the neck;
//   4. merge every part into ONE indexed BufferGeometry, weld it, run a light
//      weighted Laplacian pass so shoulders/hips/knees read as joints rather
//      than as intersecting tubes, then compute smooth normals;
//   5. normalise so the feet sit on y = 0 and the total height is exactly
//      `build.height`, and push the same transform through the joint frames.
//
// Budget: ~25-27k triangles depending on race (limit is 40k); about 18k of that
// is the head, which is where every close-up is decided.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* -------------------------------------------------------------------------- */
/* math helpers                                                               */
/* -------------------------------------------------------------------------- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sat = (v) => clamp(v, 0, 1);

function smoothstep(e0, e1, x) {
  const t = sat((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Unit-height gaussian, `s` is the standard deviation. */
const gauss = (x, s) => Math.exp(-(x * x) / (2 * s * s));

/** Anisotropic 2D gaussian — the workhorse for localised facial features. */
const blob2 = (dx, dy, sx, sy) => Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));

/** Flat-topped bump: ~1 for |x| < r, then a fast shoulder. `p` sets the edge. */
const superG = (x, r, p) => Math.exp(-Math.pow(Math.abs(x) / r, p));

/** 1 inside [lo, hi], falling off over `soft` on either side. */
const plateau = (x, lo, hi, soft) =>
  smoothstep(lo - soft, lo + soft, x) * smoothstep(hi + soft, hi - soft, x);

/** Wrap an angle into (-PI, PI]. */
function wrapPi(a) {
  let t = a % (Math.PI * 2);
  if (t > Math.PI) t -= Math.PI * 2;
  if (t <= -Math.PI) t += Math.PI * 2;
  return t;
}

/**
 * Smoothstep-interpolated keyframe curve. `keys` is [[t, value], ...] sorted by
 * t; used for every radius profile so limbs taper organically instead of
 * stepping between segments.
 */
function profile(keys, t) {
  const n = keys.length;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return lerp(v0, v1, smoothstep(t0, t1, t));
    }
  }
  return keys[n - 1][1];
}

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Sample a centripetal Catmull-Rom through `pts`; key i lands at t = i/(n-1). */
function samplePath(pts, count) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone()), false, 'centripetal', 0.5);
  const out = [];
  for (let i = 0; i < count; i++) out.push(curve.getPoint(i / (count - 1)));
  return out;
}

/**
 * Parallel-transported frames along a polyline. The triple (x, z, t) keeps a
 * fixed handedness for every path, which is what lets one winding order work
 * for every lofted part in the model.
 */
function makeFrames(path, upHint) {
  const n = path.length;
  const up = upHint || V3(0, 0, 1);
  const tans = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.copy(tans[i - 1] || V3(0, 1, 0));
    tans.push(t.normalize());
  }
  const x = new THREE.Vector3().crossVectors(tans[0], up);
  if (x.lengthSq() < 1e-10) x.crossVectors(tans[0], V3(1, 0, 0));
  x.normalize();
  const q = new THREE.Quaternion();
  const frames = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      q.setFromUnitVectors(tans[i - 1], tans[i]);
      x.applyQuaternion(q);
      x.addScaledVector(tans[i], -x.dot(tans[i]));
      if (x.lengthSq() < 1e-10) x.crossVectors(tans[i], up);
      x.normalize();
    }
    const z = new THREE.Vector3().crossVectors(x, tans[i]).normalize();
    frames.push({ p: path[i].clone(), x: x.clone(), z, t: tans[i].clone() });
  }
  return frames;
}

/* -------------------------------------------------------------------------- */
/* mesh accumulation                                                          */
/* -------------------------------------------------------------------------- */

// UV atlas. Every part unwraps into 0..1 locally and is then packed into its
// own rectangle, so no island ever crosses another and — critically — the head
// island is contiguous, keeping the seam behind the skull instead of over the
// face.
const UV = {
  head:   [0.00, 0.50, 0.50, 0.50],
  torso:  [0.50, 0.50, 0.50, 0.50],
  arm:    [[0.00, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]],
  leg:    [[0.50, 0.25, 0.25, 0.25], [0.75, 0.25, 0.25, 0.25]],
  hand:   [[0.00, 0.125, 0.125, 0.125], [0.125, 0.125, 0.125, 0.125]],
  foot:   [[0.25, 0.125, 0.125, 0.125], [0.375, 0.125, 0.125, 0.125]],
  ear:    [0.50, 0.125, 0.125, 0.125],
  horn:   [0.625, 0.125, 0.125, 0.125],
  tusk:   [0.75, 0.125, 0.125, 0.125],
  tail:   [0.875, 0.125, 0.125, 0.125],
  detail: [0.00, 0.00, 1.00, 0.125]
};

/**
 * A single UV island's worth of geometry. `w` is the per-vertex Laplacian
 * weight (0 = never move me — faces and fingertips; 1 = relax me hard — the
 * inside of an elbow).
 */
class MeshBuilder {
  constructor(rect) {
    this.rect = rect || [0, 0, 1, 1];
    this.pos = [];
    this.uv = [];
    this.wt = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(p, u, v, w = 0.25) {
    this.pos.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    this.wt.push(w);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Transform every accumulated vertex (used to seat the head assembly). */
  applyMatrix(m) {
    const p = V3();
    for (let i = 0; i < this.pos.length; i += 3) {
      p.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]).applyMatrix4(m);
      this.pos[i] = p.x;
      this.pos[i + 1] = p.y;
      this.pos[i + 2] = p.z;
    }
  }

  toGeometry() {
    const [rx, ry, rw, rh] = this.rect;
    const uv = new Float32Array(this.uv.length);
    for (let i = 0; i < this.uv.length; i += 2) {
      uv[i] = rx + sat(this.uv[i]) * rw;
      uv[i + 1] = ry + sat(this.uv[i + 1]) * rh;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aSmooth', new THREE.Float32BufferAttribute(this.wt, 1));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    return g;
  }
}

/* -------------------------------------------------------------------------- */
/* the loft primitive                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sweep a closed cross-section along `path`.
 *
 * `rings[i]` describes ring i:
 *   r       radius along the frame's x axis
 *   aspect  z radius as a multiple of r (1 = circular)
 *   front   extra scale on the +z (forward) half — chests, muzzles
 *   back    extra scale on the -z half — glutes, calves
 *   n       superellipse exponent (2 = ellipse, >2 = boxier)
 *   w       Laplacian weight for this ring
 *
 * Ring vertex 0 sits at the BACK (theta = PI), so the UV seam always runs down
 * the spine / the back of the skull, never across a face.
 */
function loftTube(mb, opts) {
  const {
    path,
    rings,
    radial = 16,
    upHint = null,
    capStart = 'none',
    capEnd = 'none',
    deform = null,
    vRange = [0, 1]
  } = opts;

  const frames = opts.frames || makeFrames(path, upHint || V3(0, 0, 1));
  const n = path.length;

  // v runs with arc length so texel density stays even along a tapering limb.
  const acc = [0];
  for (let i = 1; i < n; i++) acc.push(acc[i - 1] + path[i].distanceTo(path[i - 1]));
  const total = acc[n - 1] || 1;

  const grid = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const R = rings[i];
    const rx = R.r;
    const rz = R.r * (R.aspect === undefined ? 1 : R.aspect);
    const expo = R.n || 2;
    const fF = R.front === undefined ? 1 : R.front;
    const bF = R.back === undefined ? 1 : R.back;
    const v = lerp(vRange[0], vRange[1], acc[i] / total);
    const row = [];
    for (let j = 0; j <= radial; j++) {
      const jj = j === radial ? 0 : j; // exact duplicate keeps the weld watertight
      const th = Math.PI + (Math.PI * 2 * jj) / radial;
      const s = Math.sin(th);
      const c = Math.cos(th);
      const sx = expo === 2 ? s : Math.sign(s) * Math.pow(Math.abs(s), 2 / expo);
      const sz = expo === 2 ? c : Math.sign(c) * Math.pow(Math.abs(c), 2 / expo);
      const zr = rz * (c >= 0 ? fF : bF);
      const p = f.p.clone().addScaledVector(f.x, rx * sx).addScaledVector(f.z, zr * sz);
      if (deform) deform(p, i, jj, th, f, R);
      row.push(mb.vert(p, j / radial, v, R.w === undefined ? 0.25 : R.w));
    }
    grid.push(row);
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      mb.quad(grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]);
    }
  }

  if (capEnd !== 'none') {
    const f = frames[n - 1];
    const R = rings[n - 1];
    const c = f.p.clone();
    if (capEnd === 'round') c.addScaledVector(f.t, R.r * 0.85);
    const ci = mb.vert(c, 0.5, vRange[1], R.w === undefined ? 0.25 : R.w);
    for (let j = 0; j < radial; j++) mb.tri(ci, grid[n - 1][j], grid[n - 1][j + 1]);
  }
  if (capStart !== 'none') {
    const f = frames[0];
    const R = rings[0];
    const c = f.p.clone();
    if (capStart === 'round') c.addScaledVector(f.t, -R.r * 0.85);
    const ci = mb.vert(c, 0.5, vRange[0], R.w === undefined ? 0.25 : R.w);
    for (let j = 0; j < radial; j++) mb.tri(ci, grid[0][j + 1], grid[0][j]);
  }

  return { frames, grid };
}

/**
 * Convenience wrapper: loft a tapered tube through a few control points using a
 * radius profile. Used by every limb, ear, horn, tusk, tail and digit.
 */
function tube(mb, keys, radiusProfile, opts = {}) {
  const segs = opts.segments || 12;
  const path = samplePath(keys, segs);
  const aspect = opts.aspect || null;
  const weight = opts.weight || null;
  const rings = path.map((_, i) => {
    const t = i / (segs - 1);
    return {
      r: profile(radiusProfile, t),
      aspect: aspect ? profile(aspect, t) : 1,
      n: opts.n || 2,
      front: opts.front ? profile(opts.front, t) : 1,
      back: opts.back ? profile(opts.back, t) : 1,
      w: weight ? profile(weight, t) : (opts.w === undefined ? 0.3 : opts.w)
    };
  });
  return loftTube(mb, {
    path,
    rings,
    radial: opts.radial || 14,
    upHint: opts.upHint,
    capStart: opts.capStart || 'none',
    capEnd: opts.capEnd || 'round',
    deform: opts.deform
  });
}

/** A small four-sided plate — dorsal scutes for scaled races. */
function addScute(mb, base, dir, sideAxis, size, w = 0.0) {
  const d = dir.clone().normalize();
  const a = sideAxis.clone().addScaledVector(d, -sideAxis.dot(d)).normalize();
  const b = new THREE.Vector3().crossVectors(d, a).normalize();
  const tip = base.clone().addScaledVector(d, size * 1.9);
  const c0 = base.clone().addScaledVector(a, size).addScaledVector(b, size * 0.55);
  const c1 = base.clone().addScaledVector(a, -size).addScaledVector(b, size * 0.55);
  const c2 = base.clone().addScaledVector(a, -size).addScaledVector(b, -size * 0.55);
  const c3 = base.clone().addScaledVector(a, size).addScaledVector(b, -size * 0.55);
  const t = mb.vert(tip, 0.5, 1, w);
  const i0 = mb.vert(c0, 0, 0, w);
  const i1 = mb.vert(c1, 0.33, 0, w);
  const i2 = mb.vert(c2, 0.66, 0, w);
  const i3 = mb.vert(c3, 1, 0, w);
  mb.tri(t, i0, i1);
  mb.tri(t, i1, i2);
  mb.tri(t, i2, i3);
  mb.tri(t, i3, i0);
  mb.quad(i0, i3, i2, i1);
}

/* -------------------------------------------------------------------------- */
/* head                                                                       */
/* -------------------------------------------------------------------------- */

// Six face variants. These are multipliers/offsets on top of the race's own
// brow/jaw/snout so a "heavy" Blood Elf still reads as a Blood Elf.
//
// Every axis here has to survive a close-up, so the variants differ in feature
// *shape* (nose length/width/hook, lip fullness, eye size and tilt) and not
// only in the width of the skull.
const FACE_VARIANTS = [
  // 0 balanced / heroic
  { skullH: 1.00, jaw: 1.00, cheek: 1.00, hollow: 0.30, chin: 1.00, brow: 1.00, cranium: 1.00,
    eyeY: 0.045, eyeSpread: 1.00, eyeSize: 1.00, eyeTilt: 0.00,
    nose: 1.00, noseLen: 1.00, noseW: 1.00, noseHook: 0.00,
    mouthW: 1.00, lip: 1.00, mouthY: 0.000 },
  // 1 narrow, fine-boned, big-eyed
  { skullH: 1.10, jaw: 0.82, cheek: 0.66, hollow: 0.55, chin: 1.22, brow: 0.70, cranium: 0.90,
    eyeY: 0.070, eyeSpread: 0.92, eyeSize: 1.14, eyeTilt: 0.10,
    nose: 0.76, noseLen: 0.88, noseW: 0.74, noseHook: -0.14,
    mouthW: 0.86, lip: 1.10, mouthY: 0.022 },
  // 2 heavy, square, brutal
  { skullH: 0.92, jaw: 1.28, cheek: 1.28, hollow: 0.05, chin: 0.80, brow: 1.70, cranium: 1.10,
    eyeY: 0.020, eyeSpread: 1.10, eyeSize: 0.80, eyeTilt: -0.08,
    nose: 1.32, noseLen: 1.04, noseW: 1.34, noseHook: 0.16,
    mouthW: 1.16, lip: 0.82, mouthY: -0.022 },
  // 3 gaunt, hollow-cheeked, hawkish
  { skullH: 1.06, jaw: 0.88, cheek: 1.50, hollow: 1.25, chin: 1.12, brow: 1.25, cranium: 0.88,
    eyeY: 0.060, eyeSpread: 0.95, eyeSize: 0.86, eyeTilt: 0.03,
    nose: 1.12, noseLen: 1.26, noseW: 0.80, noseHook: 0.32,
    mouthW: 0.90, lip: 0.66, mouthY: 0.012 },
  // 4 round, soft, wide
  { skullH: 0.88, jaw: 1.08, cheek: 0.38, hollow: 0.00, chin: 0.70, brow: 0.52, cranium: 1.18,
    eyeY: 0.030, eyeSpread: 1.05, eyeSize: 1.18, eyeTilt: 0.07,
    nose: 0.82, noseLen: 0.80, noseW: 1.20, noseHook: -0.20,
    mouthW: 1.08, lip: 1.34, mouthY: -0.030 },
  // 5 angular, sharp, severe
  { skullH: 1.03, jaw: 1.16, cheek: 1.42, hollow: 0.75, chin: 1.34, brow: 1.32, cranium: 0.94,
    eyeY: 0.050, eyeSpread: 1.07, eyeSize: 0.86, eyeTilt: -0.11,
    nose: 1.18, noseLen: 1.16, noseW: 0.90, noseHook: 0.06,
    mouthW: 1.12, lip: 0.74, mouthY: 0.018 }
];

/**
 * The facial layout.
 *
 * Two different units are in play and mixing them up is the single easiest way
 * to produce a face that is subtly wrong everywhere:
 *
 *   - VERTICAL positions (`eyeY`, `mouthY`, ...) are in `uy`, the parametric
 *     height on the base ellipsoid, so they follow `skullH` — a longer skull
 *     stretches the whole face with it.
 *   - SIZES (every sigma, every lateral offset, every amplitude) are in head
 *     radii R, and `headSurface` converts them. `ux` is *not* the same physical
 *     length as `uy`: one ux is `rx` and one uy is `ry`, which differ by 40%.
 */
function headParams(F, faceIndex, headR, gaunt) {
  const fv = FACE_VARIANTS[faceIndex];
  const snout = sat(F.snout);
  // How much of a flat humanoid face survives, and how much muzzle replaces it.
  // The two crossfade, so an Orc (0.25) keeps a full nose and mouth pushed
  // slightly forward while a Tauren (1.0) gets a real bovine muzzle.
  const muzzle = smoothstep(0.30, 0.78, snout);
  const flat = 1 - muzzle;
  // Broad bovine muzzle vs. narrow canine one vs. tapered draconic one.
  const snoutWidth = F.scales > 0.5 ? 0.74 : F.horns && snout > 0.6 ? 1.02 : 0.64;

  // Landmark heights, in `uy`. These are the classical head proportions for a
  // 230 mm skull mapped onto `ry = 1.05 R`: brow 103 mm below the crown, eye
  // 117, nose tip 156, subnasale 169, stomion 188, pogonion 218.
  const eyeY = fv.eyeY - 0.10 * muzzle;
  const noseRootY = eyeY + 0.020;
  const noseTipY = eyeY - 0.320 * fv.noseLen;
  const noseBaseY = noseTipY - 0.105;
  const snoutY = -0.14 - 0.12 * snout;
  const humanMouthY = noseBaseY - 0.155 + fv.mouthY;

  return {
    R: headR,
    // A skull is much taller and deeper than it is wide. The old 0.92/1.14/1.00
    // ellipsoid was within 25% of a sphere on every axis, which is most of why
    // the head read as an egg before a single feature was carved into it.
    rx: headR * 0.700,
    ry: headR * 1.020 * fv.skullH,
    rz: headR * 0.880,

    jaw: F.jaw * fv.jaw,
    // Everyone gets a real supraorbital ridge: `F.brow` is 0 for Human, and a
    // literal zero-amplitude brow ridge is a forehead, not a face.
    brow: F.brow * fv.brow + 0.30,
    cheek: fv.cheek,
    hollow: fv.hollow + gaunt * 0.9,
    chin: fv.chin,
    cranium: fv.cranium,

    eyeY,
    browY: eyeY + 0.125,
    eyeX: (0.315 + 0.075 * snout) * fv.eyeSpread,   // R units, from the midline
    eyeTilt: fv.eyeTilt,
    eyeSize: fv.eyeSize,
    eyeR: headR * 0.122 * fv.eyeSize,
    eyeSink: headR * 0.055 * fv.eyeSize,

    flat,
    muzzle,
    nose: fv.nose,
    noseW: fv.noseW,
    noseHook: fv.noseHook,
    noseRootY,
    noseTipY,
    noseBaseY,

    mouthY: lerp(humanMouthY, snoutY - 0.17, muzzle),
    mouthW: fv.mouthW * lerp(1, 1.75, muzzle),
    lip: fv.lip,
    chinY: lerp(humanMouthY - 0.245, snoutY - 0.42, muzzle),

    snout,
    snoutLen: headR * 1.05 * snout,
    snoutY,
    snoutSpread: 0.28 + 0.12 * snout,
    snoutWidth,
    snoutDrop: -0.10 * snout
  };
}

/**
 * The head surface, evaluated analytically so ears, tusks, horns and the eye
 * frames can all be anchored to the real deformed skin rather than to a sphere.
 *
 * Local space: origin at the head centre, +Y up, +Z forward. theta = 0 faces
 * forward, phi = 0 is the crown.
 *
 * The important idea: features are placed in `(ux, uy)` — the orthographic
 * projection of the unit sphere onto the face plane — and not in `(theta, phi)`
 * with a `pow(front, k)` falloff. `front = sin(phi) cos(theta)` is a
 * hemisphere-wide window: `pow(front, 3)` is still 0.35 at 45 degrees off the
 * midline, so a "nose" written that way is just a forward inflation of the
 * entire face. A gaussian in `(ux, uy)` is a *spot* two centimetres across, and
 * spots are what a face is made of. Every one of them has to be gated by
 * `faceM`, because `(ux, uy)` is symmetric front-to-back.
 */
function headSurface(P, theta, phi) {
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const th = wrapPi(theta);

  const ux = sp * Math.sin(th); // lateral,  -1 .. 1
  const uy = cp;                // vertical, +1 at the crown
  const uz = sp * Math.cos(th); // depth,    +1 straight ahead

  const R = P.R;
  let x = P.rx * ux;
  let y = P.ry * uy;
  let z = P.rz * uz;

  const sgn = ux < 0 ? -1 : 1;
  const back = Math.max(0, -uz);
  const faceM = smoothstep(-0.08, 0.40, uz);

  // Feature geometry is quoted in head radii; these put the parameter
  // coordinates into the same unit so a "10 mm" sigma is 10 mm in both axes.
  // One ux is `rx` and one uy is `ry`, and those differ by 40% — writing
  // lateral sigmas as though they were vertical ones is how the first pass
  // ended up with a nose half the width of a real one.
  const ax = Math.abs(ux) * (P.rx / R);   // lateral distance from the midline, in R
  const kY = P.ry / R;                    // one uy, in R
  const dY = (a, b) => (a - b) * kY;      // vertical distance, in R

  /* ---- gross skull shape --------------------------------------------------*/
  // The cranium is a rounded box, not the top of an ellipsoid. A skull holds
  // most of its width up to two thirds of its height and only then domes over;
  // letting sin(phi) do the work gives the pointed egg this module started as.
  const boxy = Math.pow(Math.max(sp, 0.24), -0.42);
  const dome = smoothstep(0.02, 0.55, uy);
  x *= lerp(1, boxy, dome);
  z *= lerp(1, boxy, dome * 0.75);

  x *= 1 + 0.07 * P.cranium * gauss(uy - 0.34, 0.32);               // parietal
  z *= 1 + 0.12 * P.cranium * back * smoothstep(-0.30, 0.65, uy);   // occiput
  x *= 1 - 0.065 * gauss(uy - 0.30, 0.14) * faceM;                  // temples
  z *= 1 - 0.055 * faceM * smoothstep(0.10, 0.72, uy);              // flat forehead

  // The front of a skull is a flat plane running from the brow to the chin.
  // `sin(phi)` has already fallen 40% by the time it reaches the chin, so
  // leaving the facial plane on the ellipsoid drags the whole lower face
  // backwards and flattens every feature carved into it into one smooth ramp —
  // which is what a "featureless egg" actually is.
  // The plate narrows as it descends — the dental arch curves back, so a
  // uniform-width plane turns the mouth into a muzzle.
  const planeR = lerp(0.30, 0.56, smoothstep(-0.78, 0.18, uy));
  const planeW = faceM * gauss(ax, planeR) * plateau(uy, -0.86, 0.45, 0.25);
  z *= lerp(1, Math.min(Math.pow(Math.max(sp, 0.30), -0.42), 1.38), planeW);

  // Mandible. It has to stay at least as wide as the throat under it or the
  // head reads as a light bulb sitting on a neck.
  x *= 1 + 0.10 * P.jaw * gauss(uy - (P.chinY + 0.34), 0.20);
  // Two-stage taper: the mandible body keeps most of its width, and only the
  // chin narrows. A single ramp from the nose down gives a cone, which reads as
  // a pointed alien jaw however wide the cheekbones are.
  const jawT = smoothstep(-0.34, -0.62, uy);
  const chinT = smoothstep(-0.62, -0.95, uy);
  x *= lerp(1, 0.86, jawT) * lerp(1, 0.55, chinT);
  z *= lerp(1, 0.74, chinT * back);

  /* ---- eye sockets --------------------------------------------------------*/
  // A bony orbit with two lid crescents around the aperture. The lids sit
  // forward of the eyeball's silhouette, so they occlude it: that, and not the
  // depth of the pit, is what stops the eye reading as a bead stuck on.
  const es = P.eyeSize;
  const eDx = ax - P.eyeX;
  const eDy = dY(uy, P.eyeY) - P.eyeTilt * eDx;
  const orbit = blob2(eDx, eDy, 0.190 * es, 0.150 * es) * faceM;
  z -= R * 0.095 * orbit;
  z += R * 0.048 * blob2(eDx, eDy - 0.100 * es, 0.170 * es, 0.052 * es) * faceM; // upper lid
  z += R * 0.036 * blob2(eDx, eDy + 0.095 * es, 0.160 * es, 0.046 * es) * faceM; // lower lid

  /* ---- brow ---------------------------------------------------------------*/
  const browArc = dY(uy, P.browY) + 0.10 * Math.pow(sat(ax / 0.62), 2);
  const browBar = gauss(browArc, 0.080) * superG(ax, 0.52, 6) * faceM;
  z += R * (0.058 + 0.120 * P.brow) * browBar;
  // Nasion. The root of the nose sits a good centimetre BEHIND the brow; without
  // that notch the forehead, the bridge and the tip are one continuous slope and
  // the nose stops existing in profile.
  z -= R * 0.075 * blob2(ax, dY(uy, P.eyeY) - 0.045, 0.075, 0.080) * faceM;

  /* ---- cheekbone, hollow, jaw angle --------------------------------------*/
  const zyg = blob2(ax - 0.58, dY(uy, P.eyeY) + 0.20, 0.185, 0.145) * faceM;
  x += R * 0.115 * P.cheek * zyg * sgn;
  z += R * 0.085 * P.cheek * zyg;
  const holl = blob2(ax - 0.52, dY(uy, P.eyeY) + 0.50, 0.170, 0.150) * faceM;
  x -= R * 0.085 * P.hollow * holl * sgn;
  z -= R * 0.045 * P.hollow * holl;
  const gonial = blob2(ax - 0.56, dY(uy, P.chinY) - 0.34, 0.200, 0.160) * smoothstep(-0.55, 0.25, uz);
  x += R * 0.130 * Math.max(0, P.jaw - 0.40) * gonial * sgn;

  /* ---- nose ---------------------------------------------------------------*/
  if (P.flat > 0.01) {
    const f = P.flat * P.nose;
    const t = sat((P.noseRootY - uy) / Math.max(1e-3, P.noseRootY - P.noseTipY));
    const along =
      smoothstep(P.noseRootY + 0.10, P.noseRootY - 0.03, uy) *
      smoothstep(P.noseBaseY - 0.075, P.noseBaseY + 0.010, uy);
    const wid = lerp(0.055, 0.115 * P.noseW, smoothstep(0.10, 0.95, t));
    const h = lerp(0.010, 0.225, Math.pow(t, 0.8)) * (1 + 0.30 * P.noseHook * Math.sin(Math.PI * t));
    z += R * h * f * gauss(ax, wid) * along * faceM;

    // Wings.
    z += R * 0.125 * P.noseW * f *
      blob2(ax - 0.205 * P.noseW, dY(uy, P.noseBaseY) - 0.020, 0.085, 0.055) * faceM;

    // The nostril undercut. Without a surface that falls away beneath the tip
    // there is no shadow, and a nose with no shadow is invisible past arm's
    // length no matter how far it sticks out.
    const nos = blob2(ax - 0.115 * P.noseW, dY(uy, P.noseBaseY) + 0.030, 0.055, 0.035) * faceM;
    z -= R * 0.130 * f * nos;
    y -= R * 0.028 * f * nos;

    // Philtrum.
    z -= R * 0.042 * P.flat * blob2(ax, dY(uy, P.noseBaseY) + 0.080, 0.038, 0.055) * faceM;

    // Nasolabial fold, from the wing of the nose down to the corner of the mouth.
    const nlT = sat((P.noseBaseY - uy) / Math.max(1e-3, P.noseBaseY - (P.mouthY - 0.03)));
    const nl =
      gauss(ax - lerp(0.195, 0.310, nlT), 0.050) *
      plateau(uy, P.mouthY - 0.045, P.noseBaseY + 0.010, 0.055) * faceM;
    z -= R * 0.034 * (0.45 + 0.55 * sat(P.hollow)) * P.flat * nl;
  }

  /* ---- muzzle -------------------------------------------------------------*/
  if (P.snout > 0.01) {
    const band = gauss(uy - P.snoutY, P.snoutSpread);
    const w = band * Math.pow(Math.max(0, uz), 1.15);
    z += P.snoutLen * w;
    y += P.snoutDrop * w * P.ry;
    x *= 1 - (1 - P.snoutWidth) * band * (0.35 + 0.65 * Math.max(0, uz));
    x *= 1 + 0.14 * P.snoutWidth * band * Math.pow(Math.max(0, uz), 4.0); // squared-off tip

    // Rhinarium: a raised leather pad with two nostril pits, at the tip.
    const padY = P.snoutY + 0.20;
    z += R * 0.165 * P.muzzle * blob2(ax, dY(uy, padY), 0.200, 0.120) * faceM;
    z -= R * 0.130 * P.muzzle * blob2(ax - 0.120, dY(uy, padY) + 0.065, 0.055, 0.040) * faceM;
  }

  /* ---- mouth --------------------------------------------------------------*/
  // There was no mouth at all before this. A closed mouth is two lip volumes
  // and, above all, the groove between them: it is four millimetres wide and it
  // is the difference between a head and a face.
  {
    const mw = 0.185 * P.mouthW;
    const across = superG(ax, mw, 4) * faceM;
    const bow = dY(uy, P.mouthY) + 0.015 * Math.pow(sat(ax / mw), 2);
    z += R * 0.072 * P.lip * gauss(bow - 0.058, 0.045) * across;   // upper lip
    z += R * 0.080 * P.lip * gauss(bow + 0.065, 0.050) * across;   // lower lip
    const line = gauss(bow, 0.026 + 0.014 * P.muzzle) * across;
    z -= R * (0.100 + 0.055 * P.muzzle) * line;
    y -= R * 0.012 * line;
    z -= R * 0.032 * blob2(ax - mw * 0.94, bow, 0.050, 0.036) * faceM;  // corners
    z -= R * 0.070 * gauss(bow + 0.160, 0.050) * across;                // mentolabial
  }

  /* ---- chin ---------------------------------------------------------------*/
  const chinB = blob2(ax, dY(uy, P.chinY), 0.215, 0.125) * faceM;
  z += R * 0.185 * P.chin * chinB;
  y -= R * 0.022 * P.chin * chinB;
  // Submental shelf: the underside of the chin has to fall away or the jaw and
  // the throat merge into one column.
  z -= R * 0.045 * blob2(ax, dY(uy, P.chinY) + 0.165, 0.230, 0.095) * faceM;

  /* ---- neck stump ---------------------------------------------------------*/
  // The bottom of the skull is not a pole, it is a stump that plugs the neck.
  // The neck is BEHIND the jaw, so the axis it collapses along is tilted back:
  // driving it off `uy` alone (as the first version did) swallows the chin, the
  // mouth and the whole lower third of the face.
  const sv = uy * 0.90 + uz * 0.44;
  const stump = smoothstep(-0.70, -0.99, sv);
  x *= lerp(1, 0.34, stump);
  z = lerp(z, -P.rz * 0.10, stump);
  y = lerp(y, -P.ry * 0.86, stump * 0.85);

  return V3(x, y, z);
}

/**
 * `n + 1` monotone parameter samples in [0, 1] whose spacing is inversely
 * proportional to `density`. The head grid spends four to five times as many
 * rows and columns on the face as on the back of the skull, because a lip
 * groove and a nostril undercut are 3-5 mm features on a 24 cm head and a
 * uniform grid fine enough to resolve them costs three times the triangles.
 */
function densitySamples(n, density) {
  const M = 512;
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) cum[i + 1] = cum[i] + Math.max(1e-3, density((i + 0.5) / M));
  const total = cum[M];
  const out = new Float64Array(n + 1);
  let i = 0;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (i < M - 1 && cum[i + 1] < target) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    out[k] = clamp((i + (target - cum[i]) / seg) / M, 0, 1);
  }
  out[0] = 0;
  out[n] = 1;
  return out;
}

function buildHead(mb, P) {
  const LAT = 104;
  const LON = 88;

  const tV = densitySamples(LAT, (t) => {
    const uy = Math.cos(t * Math.PI);
    return 1 + 4.6 * gauss(uy + 0.26, 0.38) + 1.0 * gauss(uy - 0.45, 0.22);
  });
  const sU = densitySamples(LON, (s) => 1 + 4.2 * gauss(s - 0.5, 0.155));
  // Force exact left/right symmetry. `src/materials/skin.js` keys its facial
  // masks off local u = 0.5 being dead on the face front, and the warp must not
  // drift it.
  for (let j = 0; j <= LON >> 1; j++) {
    const m = 0.5 * (sU[j] + (1 - sU[LON - j]));
    sU[j] = m;
    sU[LON - j] = 1 - m;
  }

  const grid = [];
  for (let i = 0; i <= LAT; i++) {
    const phi = tV[i] * Math.PI;
    const uy = Math.cos(phi);
    const row = [];
    for (let j = 0; j <= LON; j++) {
      const jj = j === LON ? 0 : j;
      const theta = Math.PI + Math.PI * 2 * sU[jj];
      const p = headSurface(P, theta, phi);
      const uz = Math.sin(phi) * Math.cos(wrapPi(theta));
      // The whole front of the skull is frozen. The relax pass exists for the
      // ear / horn / tusk junctions; three umbrella iterations at 0.55 would
      // take a 4 mm lip groove straight back out again.
      const w =
        0.26 *
        smoothstep(0.10, -0.35, uz) *
        smoothstep(0.99, 0.45, uy) *
        smoothstep(-0.999, -0.90, uy);
      row.push(mb.vert(p, sU[j], 1 - tV[i], w));
    }
    grid.push(row);
  }
  for (let i = 0; i < LAT; i++) {
    for (let j = 0; j < LON; j++) {
      const a = grid[i][j];
      const b = grid[i][j + 1];
      const c = grid[i + 1][j + 1];
      const d = grid[i + 1][j];
      if (i !== 0) mb.tri(a, c, b);
      if (i !== LAT - 1) mb.tri(a, d, c);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* ears, tusks, horns                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Ears are lofted blades: a flattened cross-section swept along a curve, with a
 * width profile that gives each kind its outline. All in head-local space.
 */
function buildEars(mb, kind, P, headR) {
  const R = headR;
  for (const side of [-1, 1]) {
    const root = headSurface(P, side * 1.55, Math.acos(0.06));
    root.x *= 0.96;
    let keys;
    let rad;
    let asp;
    let radial = 10;
    let cap = 'round';

    switch (kind) {
      case 'long': // Night Elf / Blood Elf / Draenei — long swept blade
        keys = [
          root,
          root.clone().add(V3(side * 0.34 * R, 0.30 * R, -0.30 * R)),
          root.clone().add(V3(side * 0.60 * R, 0.72 * R, -0.78 * R)),
          root.clone().add(V3(side * 0.74 * R, 1.05 * R, -1.35 * R))
        ];
        rad = [[0, R * 0.20], [0.25, R * 0.17], [0.7, R * 0.10], [1, R * 0.012]];
        asp = [[0, 0.55], [0.4, 0.42], [1, 0.30]];
        break;
      case 'wide': // Gnome — broad paddle sticking straight out
        keys = [
          root,
          root.clone().add(V3(side * 0.22 * R, 0.10 * R, -0.02 * R)),
          root.clone().add(V3(side * 0.46 * R, 0.20 * R, -0.10 * R)),
          root.clone().add(V3(side * 0.58 * R, 0.24 * R, -0.24 * R))
        ];
        rad = [[0, R * 0.24], [0.35, R * 0.34], [0.75, R * 0.32], [1, R * 0.10]];
        asp = [[0, 0.5], [0.4, 0.28], [1, 0.22]];
        radial = 12;
        break;
      case 'pointed': // Orc / Undead — mid-length, swept up and back
        keys = [
          root,
          root.clone().add(V3(side * 0.24 * R, 0.20 * R, -0.16 * R)),
          root.clone().add(V3(side * 0.44 * R, 0.46 * R, -0.44 * R))
        ];
        rad = [[0, R * 0.20], [0.4, R * 0.15], [1, R * 0.015]];
        asp = [[0, 0.5], [1, 0.32]];
        break;
      case 'pointed-up': // Worgen — lupine triangle on top of the skull
        {
          const top = headSurface(P, side * 0.85, Math.acos(0.62));
          keys = [
            top,
            top.clone().add(V3(side * 0.10 * R, 0.30 * R, -0.04 * R)),
            top.clone().add(V3(side * 0.16 * R, 0.66 * R, -0.10 * R))
          ];
          rad = [[0, R * 0.26], [0.5, R * 0.17], [1, R * 0.015]];
          asp = [[0, 0.55], [1, 0.35]];
        }
        break;
      case 'round': // Pandaren — round disc set high on the skull
        {
          const top = headSurface(P, side * 1.25, Math.acos(0.55));
          keys = [
            top,
            top.clone().add(V3(side * 0.10 * R, 0.14 * R, -0.02 * R)),
            top.clone().add(V3(side * 0.20 * R, 0.30 * R, -0.05 * R))
          ];
          rad = [[0, R * 0.20], [0.45, R * 0.30], [0.85, R * 0.28], [1, R * 0.12]];
          asp = [[0, 0.6], [0.4, 0.34], [1, 0.30]];
          radial = 12;
        }
        break;
      case 'side-long': // Tauren — bovine ears straight out, drooping slightly
        keys = [
          root,
          root.clone().add(V3(side * 0.36 * R, -0.02 * R, -0.10 * R)),
          root.clone().add(V3(side * 0.72 * R, -0.14 * R, -0.22 * R)),
          root.clone().add(V3(side * 0.98 * R, -0.30 * R, -0.32 * R))
        ];
        rad = [[0, R * 0.18], [0.3, R * 0.24], [0.75, R * 0.19], [1, R * 0.03]];
        asp = [[0, 0.6], [0.5, 0.40], [1, 0.34]];
        break;
      case 'long-droop': // Troll / Goblin — long, out then hanging down
        keys = [
          root,
          root.clone().add(V3(side * 0.34 * R, 0.08 * R, -0.22 * R)),
          root.clone().add(V3(side * 0.62 * R, -0.22 * R, -0.46 * R)),
          root.clone().add(V3(side * 0.70 * R, -0.72 * R, -0.60 * R))
        ];
        rad = [[0, R * 0.20], [0.3, R * 0.19], [0.7, R * 0.12], [1, R * 0.015]];
        asp = [[0, 0.5], [1, 0.30]];
        break;
      case 'frill': // Dracthyr — swept membrane fin off the temple
        {
          const t0 = headSurface(P, side * 1.35, Math.acos(0.30));
          keys = [
            t0,
            t0.clone().add(V3(side * 0.22 * R, 0.26 * R, -0.36 * R)),
            t0.clone().add(V3(side * 0.36 * R, 0.44 * R, -0.86 * R)),
            t0.clone().add(V3(side * 0.42 * R, 0.50 * R, -1.24 * R))
          ];
          rad = [[0, R * 0.16], [0.3, R * 0.34], [0.72, R * 0.30], [1, R * 0.05]];
          asp = [[0, 0.35], [1, 0.16]];
          radial = 10;
          cap = 'flat';
        }
        break;
      case 'human':
      default:
        // A tall thin shell tucked against the skull. Swept laterally, the loft
        // frame puts `r` front-to-back and `r * aspect` vertical, so the aspect
        // has to be > 1 to get an ear that is taller than it is deep.
        keys = [
          root.clone().add(V3(0, 0.02 * R, -0.02 * R)),
          root.clone().add(V3(side * 0.09 * R, 0.00 * R, -0.06 * R)),
          root.clone().add(V3(side * 0.15 * R, -0.05 * R, -0.12 * R))
        ];
        rad = [[0, R * 0.11], [0.4, R * 0.14], [0.78, R * 0.13], [1, R * 0.05]];
        asp = [[0, 1.55], [0.45, 2.05], [1, 1.70]];
        radial = 12;
        break;
    }

    tube(mb, keys, rad, {
      aspect: asp,
      radial,
      segments: 9,
      capStart: 'none',
      capEnd: cap,
      upHint: V3(0, 1, 0),
      w: 0.12
    });
  }
}

/**
 * Lower-jaw tusks (orcish/trollish) or downward fangs when there is a muzzle.
 * They are anchored on the corners of the mouth the head actually has, and kept
 * short — a tusk that reaches the brow hides the whole face in a close-up.
 */
function buildTusks(mb, P, headR, down) {
  const R = headR;
  const uy = clamp(P.mouthY + (down ? 0.04 : -0.03), -0.90, 0.90);
  const phi = Math.acos(uy);
  const sp = Math.max(0.25, Math.sin(phi));
  const theta = Math.asin(clamp((0.205 * P.mouthW * R) / P.rx / sp, -0.95, 0.95));
  for (const side of [-1, 1]) {
    const root = headSurface(P, side * theta, phi);
    root.multiplyScalar(0.95);
    const len = R * (down ? 0.30 : 0.34);
    const keys = down
      ? [
          root,
          root.clone().add(V3(side * 0.02 * R, -len * 0.55, 0.02 * R)),
          root.clone().add(V3(side * 0.06 * R, -len, -0.03 * R))
        ]
      : [
          root,
          root.clone().add(V3(side * 0.035 * R, len * 0.52, 0.025 * R)),
          root.clone().add(V3(side * 0.095 * R, len, -0.045 * R))
        ];
    tube(mb, keys, [[0, R * 0.080], [0.45, R * 0.058], [1, R * 0.010]], {
      radial: 8,
      segments: 8,
      capEnd: 'round',
      upHint: V3(0, 0, 1),
      w: 0.05
    });
  }
}

/**
 * Horn styles are picked from features, not race names:
 *  - side-long ears  -> bovine sweep (out, then up)
 *  - heavy scales    -> backswept draconic crest
 *  - otherwise       -> generic swept-back pair
 */
function buildHorns(mb, P, headR, style) {
  const R = headR;
  for (const side of [-1, 1]) {
    let keys;
    let rad;
    if (style === 'bovine') {
      const root = headSurface(P, side * 1.45, Math.acos(0.44));
      keys = [
        root,
        root.clone().add(V3(side * 0.42 * R, 0.06 * R, -0.08 * R)),
        root.clone().add(V3(side * 0.78 * R, 0.34 * R, 0.02 * R)),
        root.clone().add(V3(side * 0.90 * R, 0.62 * R, 0.20 * R))
      ];
      rad = [[0, R * 0.20], [0.35, R * 0.15], [0.75, R * 0.09], [1, R * 0.015]];
    } else if (style === 'crest') {
      const root = headSurface(P, side * 0.95, Math.acos(0.70));
      keys = [
        root,
        root.clone().add(V3(side * 0.10 * R, 0.16 * R, -0.34 * R)),
        root.clone().add(V3(side * 0.18 * R, 0.20 * R, -0.78 * R)),
        root.clone().add(V3(side * 0.22 * R, 0.10 * R, -1.10 * R))
      ];
      rad = [[0, R * 0.15], [0.4, R * 0.11], [1, R * 0.012]];
    } else {
      const root = headSurface(P, side * 1.20, Math.acos(0.58));
      keys = [
        root,
        root.clone().add(V3(side * 0.26 * R, 0.26 * R, -0.24 * R)),
        root.clone().add(V3(side * 0.44 * R, 0.44 * R, -0.66 * R)),
        root.clone().add(V3(side * 0.52 * R, 0.46 * R, -1.02 * R))
      ];
      rad = [[0, R * 0.17], [0.4, R * 0.12], [1, R * 0.014]];
    }
    tube(mb, keys, rad, {
      radial: 10,
      segments: 10,
      capEnd: 'round',
      upHint: V3(0, 1, 0),
      w: 0.05
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Laplacian relaxation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Weighted umbrella smoothing. Vertices are grouped by quantised position so
 * UV seams (which duplicate positions) move as one and the mesh stays
 * watertight; the per-vertex `aSmooth` weight keeps faces and fingertips crisp
 * while letting shoulders, hips and knees relax into each other.
 */
function laplacianSmooth(geometry, iterations, strength) {
  const pos = geometry.attributes.position;
  const wAttr = geometry.attributes.aSmooth;
  const index = geometry.index.array;
  const count = pos.count;

  const q = 4096;
  const map = new Map();
  const group = new Int32Array(count);
  const members = [];
  for (let i = 0; i < count; i++) {
    const key =
      Math.round(pos.getX(i) * q) + ',' + Math.round(pos.getY(i) * q) + ',' + Math.round(pos.getZ(i) * q);
    let g = map.get(key);
    if (g === undefined) {
      g = members.length;
      map.set(key, g);
      members.push([]);
    }
    group[i] = g;
    members[g].push(i);
  }

  const gn = members.length;
  const adj = new Array(gn);
  for (let i = 0; i < gn; i++) adj[i] = new Set();
  for (let f = 0; f < index.length; f += 3) {
    const a = group[index[f]];
    const b = group[index[f + 1]];
    const c = group[index[f + 2]];
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }

  const gx = new Float32Array(gn);
  const gy = new Float32Array(gn);
  const gz = new Float32Array(gn);
  const gw = new Float32Array(gn);
  for (let g = 0; g < gn; g++) {
    const i = members[g][0];
    gx[g] = pos.getX(i);
    gy[g] = pos.getY(i);
    gz[g] = pos.getZ(i);
    let w = 0;
    for (const m of members[g]) w = Math.max(w, wAttr.getX(m));
    gw[g] = w;
  }

  const nx = new Float32Array(gn);
  const ny = new Float32Array(gn);
  const nz = new Float32Array(gn);
  for (let it = 0; it < iterations; it++) {
    for (let g = 0; g < gn; g++) {
      const nb = adj[g];
      if (!nb.size || gw[g] <= 0.001) {
        nx[g] = gx[g]; ny[g] = gy[g]; nz[g] = gz[g];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (const k of nb) { ax += gx[k]; ay += gy[k]; az += gz[k]; }
      const inv = 1 / nb.size;
      const t = strength * gw[g];
      nx[g] = lerp(gx[g], ax * inv, t);
      ny[g] = lerp(gy[g], ay * inv, t);
      nz[g] = lerp(gz[g], az * inv, t);
    }
    gx.set(nx); gy.set(ny); gz.set(nz);
  }

  for (let g = 0; g < gn; g++) {
    for (const i of members[g]) pos.setXYZ(i, gx[g], gy[g], gz[g]);
  }
  pos.needsUpdate = true;
}

/**
 * Weld coincident vertices (same position AND same UV, so deliberate texture
 * seams survive) and rewrite the index.
 *
 * This is `BufferGeometryUtils.mergeVertices` in spirit, but that one hashes
 * once per *index entry* — 36k times for this mesh — which costs more than the
 * rest of the build put together. The loft already emits shared ring vertices,
 * so this pass only has to sweep the real vertex list.
 */
function weldVertices(geometry, tolerance = 1e-5) {
  const names = Object.keys(geometry.attributes);
  const attrs = names.map((n) => geometry.attributes[n]);
  const count = geometry.attributes.position.count;
  const mul = 1 / tolerance;
  const map = new Map();
  const remap = new Uint32Array(count);
  const keep = [];

  for (let i = 0; i < count; i++) {
    let key = '';
    for (let a = 0; a < attrs.length; a++) {
      const at = attrs[a];
      const s = at.itemSize;
      const arr = at.array;
      const o = i * s;
      for (let k = 0; k < s; k++) key += (((arr[o + k] * mul) | 0) + ',');
    }
    const hit = map.get(key);
    if (hit === undefined) {
      map.set(key, keep.length);
      remap[i] = keep.length;
      keep.push(i);
    } else {
      remap[i] = hit;
    }
  }

  const src = geometry.index.array;
  const idx = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) idx[i] = remap[src[i]];

  const out = new THREE.BufferGeometry();
  for (let a = 0; a < attrs.length; a++) {
    const at = attrs[a];
    const s = at.itemSize;
    const arr = at.array;
    const dst = new Float32Array(keep.length * s);
    for (let v = 0; v < keep.length; v++) {
      const o = keep[v] * s;
      const d = v * s;
      for (let k = 0; k < s; k++) dst[d + k] = arr[o + k];
    }
    out.setAttribute(names[a], new THREE.BufferAttribute(dst, s));
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Any vertex whose incident triangles are all degenerate (the pinched poles of
 * the skull, which sit buried inside the neck) comes out of
 * computeVertexNormals with a zero normal, which would be a NaN in the shader.
 * Fall back to the radial direction there.
 */
function sanitizeNormals(geometry) {
  const nrm = geometry.attributes.normal;
  const pos = geometry.attributes.position;
  geometry.computeBoundingSphere();
  const c = geometry.boundingSphere.center;
  const v = V3();
  for (let i = 0; i < nrm.count; i++) {
    const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (l > 1e-6) continue;
    v.set(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z);
    if (v.lengthSq() < 1e-12) v.set(0, 1, 0);
    v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  nrm.needsUpdate = true;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_BUILD = {
  height: 1.85, headScale: 1, shoulderW: 1, chest: 1, waist: 0.9, hip: 0.95,
  armLength: 0.44, legLength: 0.5, armThick: 1, legThick: 1, posture: 0.02,
  digitigrade: false, neck: 1
};

const DEFAULT_FEATURES = {
  ears: 'human', brow: 0, jaw: 1, snout: 0, tusks: false, horns: false, tail: false, scales: 0
};

/**
 * @param {object} build     race build block (see src/data/races.js)
 * @param {object} features  race feature block
 * @param {object} opts      { faceIndex: 0..5 }
 * @returns {{ geometry: THREE.BufferGeometry, joints: object }}
 */
export function buildBodyGeometry(build, features, opts = {}) {
  const B = Object.assign({}, DEFAULT_BUILD, build || {});
  const F = Object.assign({}, DEFAULT_FEATURES, features || {});
  const faceIndex = clamp(Math.round(opts.faceIndex || 0), 0, FACE_VARIANTS.length - 1);

  const H = B.height;
  const unit = H * 0.098;                       // torso radius unit
  const headR = (H / 16) * B.headScale;         // canonical-8-heads radius
  const hipY = H * B.legLength;                 // hip joint height
  const gaunt = sat((0.92 - B.armThick) / 0.28); // Undead-ness: knobby, hollow

  // --- torso / neck skeleton -------------------------------------------------
  const neckLen = Math.max(headR * 0.16, headR * 0.95 * B.neck);
  const headCentreYNom = H - headR * 1.02;
  const torsoLen = Math.max(H * 0.16, headCentreYNom - headR * 0.68 - neckLen - hipY);

  // Tangent angle away from vertical, integrated up the spine. The hunch is
  // amplified over the raw posture value because a 200px silhouette needs the
  // curve to be unmistakable; the lumbar term keeps a natural S at the bottom.
  const spineAngle = (t) =>
    B.posture * 1.75 * Math.pow(smoothstep(0.10, 1.0, t), 1.25) -
    0.16 * Math.sin(Math.PI * sat(t / 0.62)) +
    0.09 * smoothstep(0.45, 0.98, t);

  const SPINE_SEGS = 24;
  const spinePts = [];
  const spineAng = [];
  {
    const ds = torsoLen / SPINE_SEGS;
    const p = V3(0, hipY, 0);
    for (let i = 0; i <= SPINE_SEGS; i++) {
      const t = i / SPINE_SEGS;
      const a = spineAngle(t);
      spinePts.push(p.clone());
      spineAng.push(a);
      p.y += Math.cos(a) * ds;
      p.z += Math.sin(a) * ds;
    }
  }
  // Shift the whole column back so a heavy hunch does not read as falling over.
  const leanZ = spinePts[SPINE_SEGS].z;
  const pelvisZ = -leanZ * 0.34;
  for (const p of spinePts) p.z += pelvisZ;

  // Neck continues the curve but straightens toward vertical.
  const NECK_SEGS = 5;
  const neckPts = [];
  {
    const topA = spineAng[SPINE_SEGS];
    const p = spinePts[SPINE_SEGS].clone();
    const ds = neckLen / NECK_SEGS;
    for (let i = 1; i <= NECK_SEGS; i++) {
      const a = topA * lerp(1, 0.45, i / NECK_SEGS);
      p.y += Math.cos(a) * ds;
      p.z += Math.sin(a) * ds;
      neckPts.push(p.clone());
    }
  }

  // --- torso radii -----------------------------------------------------------
  const hipR = unit * B.hip;
  const waistR = unit * B.waist;
  const chestR = unit * B.chest;
  const shoulderHalf = unit * B.shoulderW * 1.28;
  const neckR = headR * (0.74 - 0.22 * clamp(B.neck, 0, 1.4)) * (0.86 + 0.16 * B.chest);
  const barrel = 0.72 + 0.16 * sat(B.chest - 1.0);       // deep chests get deeper
  const chestFront = 1.0 + 0.10 * sat(B.chest - 0.95);

  const rProfile = [
    [0.00, hipR * 0.80], [0.07, hipR * 1.02], [0.16, hipR * 0.98],
    [0.30, waistR * 0.94], [0.42, waistR * 1.02],
    [0.62, chestR * 1.02], [0.76, chestR * 1.06],
    [0.88, shoulderHalf * 0.66], [1.00, shoulderHalf * 0.50]
  ];
  const aProfile = [
    [0.00, 0.86], [0.16, 0.82], [0.34, 0.74], [0.62, barrel], [0.80, barrel * 1.02], [1.00, 0.80]
  ];
  const frontProfile = [[0.0, 1.0], [0.3, 0.98], [0.62, chestFront], [0.82, chestFront * 0.98], [1.0, 1.0]];
  const backProfile = [[0.0, 1.12], [0.14, 1.14], [0.34, 1.0], [0.68, 1.04], [1.0, 1.0]];
  const wProfile = [[0.0, 0.55], [0.12, 0.35], [0.3, 0.3], [0.62, 0.3], [0.86, 0.7], [1.0, 0.8]];

  const torsoMB = new MeshBuilder(UV.torso);
  const torsoPath = spinePts.concat(neckPts);
  const torsoRings = torsoPath.map((_, i) => {
    if (i <= SPINE_SEGS) {
      const t = i / SPINE_SEGS;
      return {
        r: profile(rProfile, t),
        aspect: profile(aProfile, t),
        front: profile(frontProfile, t),
        back: profile(backProfile, t),
        n: lerp(2.35, 2.05, gaunt),
        w: profile(wProfile, t)
      };
    }
    // Neck: shrink hard out of the trapezius into the throat column.
    const k = (i - SPINE_SEGS) / NECK_SEGS;
    return {
      r: lerp(shoulderHalf * 0.50, neckR, smoothstep(0, 0.55, k)),
      aspect: lerp(0.80, 0.95, k),
      front: 1,
      back: lerp(1.06, 1.0, k),
      n: 2.1,
      w: 0.8
    };
  });

  // A trapezius hump over the shoulder blades. Nearly invisible on upright
  // races, unmistakable on the hunched ones — it is the cue that separates a
  // leaning figure from a genuinely hunched one in a 200px silhouette.
  const humpAmt = unit * (0.10 + 1.35 * Math.max(0, B.posture)) * (0.6 + 0.4 * B.chest);
  loftTube(torsoMB, {
    path: torsoPath,
    rings: torsoRings,
    radial: 36,
    upHint: V3(0, 0, 1),
    capStart: 'round',
    capEnd: 'flat',
    deform: (p, i, j, th, f) => {
      const t = i / SPINE_SEGS;
      const w = gauss(t - 0.92, 0.13) * Math.max(0, -Math.cos(th));
      if (w > 0.001) {
        p.addScaledVector(f.z, -humpAmt * w);
        p.y += humpAmt * 0.45 * w;
      }
    }
  });

  const frames = makeFrames(torsoPath, V3(0, 0, 1));
  const frameAt = (t) => frames[clamp(Math.round(t * SPINE_SEGS), 0, SPINE_SEGS)];

  // --- arms ------------------------------------------------------------------
  const armLen = H * B.armLength;
  const armBase = unit * 0.38 * B.armThick;
  const shoulderF = frameAt(0.90);
  const armRings = [
    [0.00, armBase * 1.22], [0.10, armBase * 1.10], [0.22, armBase * 0.95],
    [0.42, armBase * (0.70 + 0.10 * gaunt)], [0.52, armBase * 0.80],
    [0.72, armBase * 0.62], [1.00, armBase * 0.46]
  ];
  const armWeights = [[0, 0.85], [0.18, 0.35], [0.40, 0.75], [0.6, 0.3], [1, 0.4]];

  const joints = { shoulders: [], hands: [], feet: [], eyes: [] };
  const armParts = [];
  const splay = 0.13 + 0.09 * B.chest;

  for (const side of [-1, 1]) {
    const shoulder = shoulderF.p
      .clone()
      .addScaledVector(shoulderF.x, side * (shoulderHalf - armBase * 0.85))
      .addScaledVector(shoulderF.z, headR * 0.06)
      .add(V3(0, armBase * 0.20, 0));

    const upperLen = armLen * 0.40;
    const foreLen = armLen * 0.36;
    const handLen = armLen * 0.24;

    const d1 = V3(side * splay, -1, 0.06 + B.posture * 0.95).normalize();
    const elbow = shoulder.clone().addScaledVector(d1, upperLen);
    const d2 = V3(side * (splay * 0.35), -1, -0.10 + B.posture * 0.55).normalize();
    const wrist = elbow.clone().addScaledVector(d2, foreLen);

    const mb = new MeshBuilder(UV.arm[side > 0 ? 0 : 1]);
    tube(mb, [shoulder, elbow, wrist], armRings, {
      aspect: [[0, 0.92], [0.45, 0.86], [1, 0.78]],
      weight: armWeights,
      radial: 20,
      segments: 19,
      capStart: 'none',
      capEnd: 'none',
      upHint: V3(0, 0, 1)
    });
    armParts.push(mb);

    // Hand: a mitten flattened across the palm, with a thumb stub.
    const hmb = new MeshBuilder(UV.hand[side > 0 ? 0 : 1]);
    const hd = d2.clone().add(V3(0, 0, B.posture * 0.4)).normalize();
    const thick = armBase * 0.42;
    const hKeys = [
      wrist.clone().addScaledVector(hd, -handLen * 0.12),
      wrist.clone().addScaledVector(hd, handLen * 0.35),
      wrist.clone().addScaledVector(hd, handLen * 0.72),
      wrist.clone().addScaledVector(hd, handLen).add(V3(0, 0, handLen * 0.10))
    ];
    tube(hmb, hKeys, [[0, thick * 1.05], [0.25, thick * 1.15], [0.7, thick * 1.10], [1, thick * 0.45]], {
      aspect: [[0, 1.5], [0.3, 2.1], [1, 1.9]],
      radial: 12,
      segments: 9,
      capStart: 'round',
      capEnd: 'round',
      upHint: V3(0, 0, 1),
      w: 0.15
    });
    const thumbRoot = hKeys[1].clone().addScaledVector(V3(0, 0, 1), thick * 1.6);
    tube(
      hmb,
      [
        thumbRoot,
        thumbRoot.clone().addScaledVector(hd, handLen * 0.18).add(V3(side * thick * 0.3, 0, thick * 0.8)),
        thumbRoot.clone().addScaledVector(hd, handLen * 0.34).add(V3(side * thick * 0.4, 0, thick * 1.1))
      ],
      [[0, thick * 0.55], [1, thick * 0.30]],
      { radial: 8, segments: 6, capEnd: 'round', upHint: V3(0, 1, 0), w: 0.1 }
    );
    armParts.push(hmb);

    joints.shoulders.push({ position: shoulder.clone(), radius: armBase * 1.22, side });
    joints.hands.push({
      position: wrist.clone().addScaledVector(hd, handLen * 0.5),
      radius: thick * 1.7,
      side
    });
  }

  // --- legs ------------------------------------------------------------------
  const legBase = unit * 0.42 * B.legThick;
  const pelvisF = frames[0];
  const hipHalf = hipR * 0.56;
  const legParts = [];

  // Feet style follows the feature set, never the race name:
  //   heavy scales -> talons, tusks -> paws, otherwise cloven hooves.
  const footStyle = !B.digitigrade ? 'foot' : F.scales > 0.5 ? 'claw' : F.tusks ? 'paw' : 'hoof';

  for (const side of [-1, 1]) {
    const hip = V3(side * hipHalf, hipY, pelvisZ + hipR * 0.02);
    const mb = new MeshBuilder(UV.leg[side > 0 ? 0 : 1]);
    let keys;
    let rad;
    let wts;
    let ankle;

    if (B.digitigrade) {
      // Reverse-jointed: knee forward and high, hock raised behind, then a long
      // pastern dropping forward onto the toes.
      const knee = V3(side * hipHalf * 0.98, hipY * 0.58, pelvisZ + hipY * 0.13);
      const hock = V3(side * hipHalf * 0.92, hipY * 0.30, pelvisZ - hipY * 0.15);
      const pastern = V3(side * hipHalf * 0.90, hipY * 0.11, pelvisZ + hipY * 0.03);
      keys = [hip, knee, hock, pastern];
      rad = [
        [0.00, legBase * 1.42], [0.14, legBase * 1.34], [0.33, legBase * 0.86],
        [0.46, legBase * 0.92], [0.66, legBase * (0.44 + 0.06 * gaunt)],
        [0.85, legBase * 0.34], [1.00, legBase * 0.30]
      ];
      wts = [[0, 0.8], [0.15, 0.3], [0.33, 0.85], [0.5, 0.35], [0.66, 0.8], [1, 0.4]];
      ankle = pastern;
    } else {
      const knee = V3(side * hipHalf * 0.94, hipY * 0.50, pelvisZ + hipY * 0.035);
      const ank = V3(side * hipHalf * 0.86, H * 0.052, pelvisZ - hipY * 0.02);
      keys = [hip, knee, ank];
      rad = [
        [0.00, legBase * 1.38], [0.12, legBase * 1.26], [0.34, legBase * 1.02],
        [0.50, legBase * (0.74 + 0.10 * gaunt)], [0.62, legBase * 0.88],
        [0.86, legBase * 0.42], [1.00, legBase * 0.36]
      ];
      wts = [[0, 0.8], [0.2, 0.3], [0.5, 0.85], [0.7, 0.35], [1, 0.4]];
      ankle = ank;
    }

    tube(mb, keys, rad, {
      aspect: [[0, 0.90], [0.5, 0.88], [1, 0.86]],
      back: [[0, 1.06], [0.55, 1.14], [0.8, 1.0], [1, 1.0]],
      weight: wts,
      radial: 22,
      segments: 21,
      capStart: 'none',
      capEnd: 'none',
      upHint: V3(0, 0, 1)
    });
    legParts.push(mb);

    // ---- foot ---------------------------------------------------------------
    const fmb = new MeshBuilder(UV.foot[side > 0 ? 0 : 1]);
    const footW = legBase * (footStyle === 'hoof' ? 0.62 : 0.80);
    let contactZ = ankle.z;

    if (footStyle === 'hoof') {
      // Short flared column with a flat sole and a cleft down the front. The
      // path is dead vertical so the sole lands flat on y = 0.
      const hz = ankle.z + ankle.y * 0.16;
      const top = V3(ankle.x, ankle.y * 0.98, hz);
      const bottom = V3(ankle.x, 0, hz);
      const path = samplePath([top, bottom], 7);
      const rings = path.map((_, i) => {
        const t = i / 6;
        return { r: lerp(footW * 0.80, footW * 1.25, t), aspect: lerp(1.0, 1.15, t), n: 2.2, w: 0.15 };
      });
      loftTube(fmb, {
        path,
        rings,
        radial: 14,
        upHint: V3(0, 0, 1),
        capStart: 'none',
        capEnd: 'flat',
        deform: (p, i, j, th) => {
          // cleft: pinch the two front quadrants apart slightly
          const cleft = gauss(wrapPi(th), 0.28) * (i / 6);
          p.z -= footW * 0.22 * cleft;
        }
      });
      contactZ = bottom.z;
    } else {
      // Plantigrade sole (or a digitigrade paw, which is the same shape but
      // shorter and set forward under the pastern).
      const paw = footStyle !== 'foot';
      const len = H * (paw ? 0.085 : 0.135) * (0.85 + 0.3 * B.legThick);
      const heel = ankle.z - len * (paw ? 0.22 : 0.30);
      const toe = ankle.z + len * (paw ? 0.78 : 0.70);
      const N = 9;
      const path = [];
      const rings = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const r = footW * profile([[0, 0.72], [0.18, 1.0], [0.62, 1.06], [0.86, 0.94], [1, 0.42]], t);
        const asp = profile([[0, 1.35], [0.25, 0.95], [0.7, 0.62], [1, 0.45]], t);
        rings.push({ r, aspect: asp, n: 2.4, w: 0.12 });
        path.push(V3(ankle.x, r * asp, lerp(heel, toe, t)));
      }
      loftTube(fmb, {
        path,
        rings,
        radial: 14,
        upHint: V3(0, 1, 0),
        capStart: 'round',
        capEnd: paw ? 'flat' : 'round'
      });

      if (paw) {
        // Three digits, pointed for scaled races.
        const claw = footStyle === 'claw';
        for (let d = -1; d <= 1; d++) {
          const base = V3(ankle.x + d * footW * 0.62, footW * 0.42, toe - footW * 0.1);
          const tip = base.clone().add(V3(d * footW * 0.16, -footW * 0.12, footW * (claw ? 1.5 : 1.0)));
          tube(fmb, [base, base.clone().lerp(tip, 0.55), tip], [[0, footW * 0.34], [1, footW * (claw ? 0.05 : 0.20)]], {
            radial: 8,
            segments: 6,
            capEnd: 'round',
            upHint: V3(0, 1, 0),
            w: 0.1
          });
        }
        contactZ = (heel + toe) * 0.5;
      } else {
        contactZ = lerp(heel, toe, 0.45);
      }
    }
    legParts.push(fmb);
    joints.feet.push({ position: V3(ankle.x, 0, contactZ), radius: footW, side });
  }

  // --- head assembly (built in head-local space, then seated) -----------------
  const P = headParams(F, faceIndex, headR, gaunt);
  const neckEnd = torsoPath[torsoPath.length - 1];
  const topAngle = spineAng[SPINE_SEGS] * 0.45;
  const headDir = V3(0, Math.cos(topAngle), Math.sin(topAngle));
  // Seat the skull so its neck stump sinks into the throat column — but not so
  // deep that the jaw and chin are buried in the front of the neck.
  const headCentre = neckEnd.clone().addScaledVector(headDir, P.ry * 0.58 + neckR * 0.14);
  const headQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(topAngle * 0.9, 0, 0));
  const headM = new THREE.Matrix4().compose(headCentre, headQuat, V3(1, 1, 1));

  const headMB = new MeshBuilder(UV.head);
  buildHead(headMB, P);
  const headExtras = [headMB];

  const earMB = new MeshBuilder(UV.ear);
  buildEars(earMB, F.ears, P, headR);
  headExtras.push(earMB);

  if (F.tusks) {
    const tuskMB = new MeshBuilder(UV.tusk);
    buildTusks(tuskMB, P, headR, P.snout > 0.55); // long muzzle -> downward fangs
    headExtras.push(tuskMB);
  }
  if (F.horns) {
    const hornMB = new MeshBuilder(UV.horn);
    const style = F.ears === 'side-long' ? 'bovine' : F.scales > 0.5 ? 'crest' : 'swept';
    buildHorns(hornMB, P, headR, style);
    headExtras.push(hornMB);
  }

  // Eye frames, scalp and head axes are computed on the analytic surface before
  // the assembly is transformed, so they land exactly in their sockets.
  const eyePhi = Math.acos(clamp(P.eyeY, -0.95, 0.95));
  const eyeUx = (P.eyeX * headR) / P.rx;
  const eyeTheta = Math.asin(clamp(eyeUx / Math.max(1e-3, Math.sin(eyePhi)), -0.999, 0.999));
  const eyeLocals = [];
  for (const side of [-1, 1]) {
    const s = headSurface(P, side * eyeTheta, eyePhi); // the floor of the orbit
    const dir = V3(s.x / P.rx, 0.12, s.z / P.rz).normalize().lerp(V3(0, 0, 1), 0.50).normalize();
    // Set back behind the aperture so the lid crescents overhang the ball and
    // only the cap between them shows. The old code pushed it INTO a 5 mm
    // dimple, which is why the eyes read as beads sitting on the skin.
    eyeLocals.push({ p: s.clone().addScaledVector(dir, -P.eyeSink), dir, side });
  }
  const scalpLocal = headSurface(P, 0, 0.30);

  for (const mb of headExtras) mb.applyMatrix(headM);

  const headUp = V3(0, 1, 0).applyQuaternion(headQuat);
  const headFwd = V3(0, 0, 1).applyQuaternion(headQuat);
  for (const e of eyeLocals) {
    joints.eyes.push({
      position: e.p.applyMatrix4(headM),
      radius: P.eyeR,
      forward: e.dir.applyQuaternion(headQuat).normalize(),
      side: e.side
    });
  }

  // --- tail ------------------------------------------------------------------
  const tailParts = [];
  if (F.tail) {
    const tmb = new MeshBuilder(UV.tail);
    const root = pelvisF.p
      .clone()
      .addScaledVector(pelvisF.z, -hipR * 0.92)
      .add(V3(0, hipR * 0.55, 0));
    let len;
    let rad;
    let keys;
    const dragon = F.scales > 0.5;
    const stub = F.ears === 'round';
    const cow = F.ears === 'side-long';
    const bushy = F.ears === 'pointed-up';

    if (stub) {
      len = H * 0.05;
      keys = [root, root.clone().add(V3(0, -len * 0.4, -len)), root.clone().add(V3(0, -len * 1.1, -len * 1.1))];
      rad = [[0, hipR * 0.30], [1, hipR * 0.22]];
    } else if (cow) {
      len = H * 0.34;
      keys = [
        root,
        root.clone().add(V3(0, -len * 0.30, -len * 0.28)),
        root.clone().add(V3(0, -len * 0.72, -len * 0.30)),
        root.clone().add(V3(0, -len * 1.02, -len * 0.18))
      ];
      rad = [[0, hipR * 0.26], [0.6, hipR * 0.11], [0.86, hipR * 0.09], [0.93, hipR * 0.30], [1, hipR * 0.06]];
    } else if (bushy) {
      len = H * 0.27;
      keys = [
        root,
        root.clone().add(V3(0, -len * 0.10, -len * 0.42)),
        root.clone().add(V3(0, -len * 0.34, -len * 0.80)),
        root.clone().add(V3(0, -len * 0.72, -len * 0.98))
      ];
      rad = [[0, hipR * 0.30], [0.35, hipR * 0.44], [0.72, hipR * 0.38], [1, hipR * 0.09]];
    } else if (dragon) {
      len = H * 0.52;
      keys = [
        root,
        root.clone().add(V3(0, -len * 0.14, -len * 0.36)),
        root.clone().add(V3(0, -len * 0.42, -len * 0.72)),
        root.clone().add(V3(0, -len * 0.80, -len * 0.92))
      ];
      rad = [[0, hipR * 0.62], [0.3, hipR * 0.46], [0.7, hipR * 0.24], [1, hipR * 0.04]];
    } else {
      len = H * 0.40;
      keys = [
        root,
        root.clone().add(V3(0, -len * 0.16, -len * 0.34)),
        root.clone().add(V3(0, -len * 0.52, -len * 0.62)),
        root.clone().add(V3(0, -len * 0.92, -len * 0.60))
      ];
      rad = [[0, hipR * 0.42], [0.4, hipR * 0.26], [1, hipR * 0.05]];
    }

    const res = tube(tmb, keys, rad, {
      aspect: [[0, 0.92], [1, 0.9]],
      radial: 12,
      segments: 14,
      capEnd: 'round',
      upHint: V3(1, 0, 0),
      w: 0.25
    });
    if (dragon) {
      // Ridge scutes down the top of the tail.
      for (let i = 1; i < res.frames.length - 3; i += 2) {
        const f = res.frames[i];
        const up = new THREE.Vector3().crossVectors(f.t, f.x).normalize().negate();
        const r = hipR * lerp(0.55, 0.12, i / res.frames.length);
        addScute(tmb, f.p.clone().addScaledVector(up, r * 0.75), up, f.x, r * 0.34);
      }
    }
    tailParts.push(tmb);
  }

  // --- dorsal scutes for scaled races ---------------------------------------
  const detailParts = [];
  if (F.scales > 0.35) {
    const dmb = new MeshBuilder(UV.detail);
    for (let i = 3; i <= SPINE_SEGS - 1; i += 3) {
      const f = frames[i];
      const t = i / SPINE_SEGS;
      const back = f.z.clone().negate();
      const r = profile(rProfile, t) * profile(aProfile, t) * profile(backProfile, t);
      const size = unit * 0.13 * F.scales * lerp(0.7, 1.15, Math.sin(t * Math.PI));
      addScute(dmb, f.p.clone().addScaledVector(back, r * 0.92), back, f.x, size);
    }
    detailParts.push(dmb);
  }

  // --- merge, weld, relax ----------------------------------------------------
  const geoms = [torsoMB, ...armParts, ...legParts, ...headExtras, ...tailParts, ...detailParts].map((m) =>
    m.toGeometry()
  );
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  const geometry = weldVertices(merged, 1e-5);
  merged.dispose();

  laplacianSmooth(geometry, 3, 0.55);
  geometry.deleteAttribute('aSmooth');
  geometry.computeVertexNormals();
  sanitizeNormals(geometry);

  // --- exact height normalisation -------------------------------------------
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const minY = bb.min.y;
  const span = Math.max(1e-4, bb.max.y - bb.min.y);
  const scale = H / span;
  geometry.translate(0, -minY, 0);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const fix = (p) => p.setY(p.y - minY).multiplyScalar(scale);

  // --- joints ----------------------------------------------------------------
  const spineJoint = [];
  for (let i = 0; i <= SPINE_SEGS; i += 2) spineJoint.push(fix(spinePts[i].clone()));
  spineJoint.push(fix(spinePts[SPINE_SEGS].clone()));

  const neckMid = spinePts[SPINE_SEGS].clone().lerp(neckEnd, 0.5);

  const out = {
    head: {
      position: fix(headCentre.clone()),
      radius: headR * scale,
      up: headUp.clone(),
      forward: headFwd.clone()
    },
    neck: { position: fix(neckMid), radius: neckR * scale },
    shoulders: joints.shoulders.map((s) => ({
      position: fix(s.position),
      radius: s.radius * scale,
      side: s.side
    })),
    hands: joints.hands.map((h) => ({ position: fix(h.position), radius: h.radius * scale, side: h.side })),
    hips: { position: fix(V3(0, hipY, pelvisZ)), radius: hipR * scale },
    // Ground contact is reported dead on y = 0 so boots and greaves can sit on
    // the floor plane without a per-race fudge.
    feet: joints.feet.map((f) => {
      const position = fix(f.position);
      position.y = 0;
      return { position, radius: f.radius * scale, side: f.side };
    }),
    eyes: joints.eyes.map((e) => ({
      position: fix(e.position),
      radius: e.radius * scale,
      forward: e.forward.clone().normalize(),
      side: e.side
    })),
    scalp: {
      position: fix(scalpLocal.clone().applyMatrix4(headM)),
      radius: headR * 0.94 * scale,
      up: headUp.clone(),
      forward: headFwd.clone()
    },
    spine: spineJoint
  };

  geometry.userData.triangles = geometry.index.count / 3;
  return { geometry, joints: out };
}
