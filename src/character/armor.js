import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural armor sets.
 *
 * `buildArmorSet(klass, race, joints, build, opts)` returns a single merged
 * THREE.Object3D containing one Mesh that uses `opts.material`. Everything is
 * driven by `klass.armor` (tier / pauldron / pauldronScale / skirt / cape /
 * trim / emissive) and fitted to the `joints` frame reported by body.js, so a
 * Tauren's plate is physically larger than a Gnome's rather than a scaled copy.
 *
 * Every vertex carries an `aTrimMask` float (0..1) marking gilt / edge / rune
 * regions so materials/armor.js can push metal + emissive there.
 */

const TAU = Math.PI * 2;
const TRI_BUDGET = 25000;
const ATTRS = ['position', 'normal', 'uv', 'aTrimMask'];

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const V2 = (x = 0, y = 0) => new THREE.Vector2(x, y);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const gauss = (x, s) => Math.exp(-(x * x) / (2 * s * s));

/** Deterministic per-class noise so a rebuild of the same character matches. */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Piecewise smoothstep through [t, value] control points. */
function profile(t, ctrl) {
  const n = ctrl.length;
  if (t <= ctrl[0][0]) return ctrl[0][1];
  if (t >= ctrl[n - 1][0]) return ctrl[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= ctrl[i][0]) {
      const a = ctrl[i - 1], b = ctrl[i];
      return lerp(a[1], b[1], smooth((t - a[0]) / Math.max(1e-6, b[0] - a[0])));
    }
  }
  return ctrl[n - 1][1];
}

// ---------------------------------------------------------------------------
// geometry plumbing
// ---------------------------------------------------------------------------

function rawGeo(pos, uv, tm, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aTrimMask', new THREE.Float32BufferAttribute(tm, 1));
  g.setIndex(idx);
  return g;
}

function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

function flipWinding(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    g.index.needsUpdate = true;
  } else {
    for (const name of Object.keys(g.attributes)) {
      const at = g.attributes[name], is = at.itemSize, arr = at.array;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < is; k++) {
          const p = (i + 1) * is + k, q = (i + 2) * is + k;
          const t = arr[p]; arr[p] = arr[q]; arr[q] = t;
        }
      }
      at.needsUpdate = true;
    }
  }
  return g;
}

/** Bring any geometry into the merge-compatible shape: pos/normal/uv/aTrimMask, indexed, no groups. */
function conform(g, trim = 0) {
  g.clearGroups();
  g.morphAttributes = {};
  for (const name of Object.keys(g.attributes)) {
    if (!ATTRS.includes(name)) g.deleteAttribute(name);
  }
  const count = g.attributes.position.count;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  if (!g.attributes.aTrimMask) {
    const arr = new Float32Array(count);
    if (trim) arr.fill(clamp01(trim));
    g.setAttribute('aTrimMask', new THREE.Float32BufferAttribute(arr, 1));
  }
  if (!g.index) {
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  // mergeAttributes() demands identical typed arrays; force Float32 everywhere.
  for (const name of ATTRS) {
    const at = g.attributes[name];
    if (at && !(at.array instanceof Float32Array)) {
      g.setAttribute(name, new THREE.Float32BufferAttribute(Float32Array.from(at.array), at.itemSize));
    }
  }
  return g;
}

/**
 * Angle-limited vertex normals — the middle ground between `facet()` and a
 * plain `computeVertexNormals()`.
 *
 * A face only contributes to a corner it shares with faces lying within
 * `angleDeg` of itself, so a lofted shell shades as one continuous curved
 * surface while genuine bevels (a plate rim, the flat face of a tasset strip)
 * keep their hard edge. Positions are welded on a 0.1 mm lattice first, so a
 * `closedU` seam column or a sweep's wrap-around joins up automatically.
 *
 * This is the fix for the horizontal banding on the torso: the chest is a loft
 * whose radius profile rises and falls several times between hip and collar, so
 * with one normal per facet each ring of quads tilted alternately up and down
 * and swung between the warm key and the cool rim — regular light/dark stripes
 * that read as a paper bag rather than a breastplate.
 */
function creaseNormals(g, angleDeg = 55) {
  const src = g.index ? g.toNonIndexed() : g;
  const pos = src.attributes.position.array;
  const faces = Math.floor(pos.length / 9);
  const fx = new Float32Array(faces), fy = new Float32Array(faces), fz = new Float32Array(faces);
  const wgt = new Float32Array(faces);           // 2x triangle area
  for (let f = 0; f < faces; f++) {
    const o = f * 9;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const L = Math.hypot(nx, ny, nz);
    wgt[f] = L;
    if (L > 1e-14) { fx[f] = nx / L; fy[f] = ny / L; fz[f] = nz / L; } else { fy[f] = 1; }
  }
  const Q = 10000;
  const keys = new Array(faces * 3);
  const buckets = new Map();
  for (let f = 0; f < faces; f++) {
    for (let c = 0; c < 3; c++) {
      const o = f * 9 + c * 3;
      const k = `${Math.round(pos[o] * Q)},${Math.round(pos[o + 1] * Q)},${Math.round(pos[o + 2] * Q)}`;
      keys[f * 3 + c] = k;
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(f);
    }
  }
  const cosLim = Math.cos(clamp(angleDeg, 0, 180) * Math.PI / 180);
  const out = new Float32Array(pos.length);
  for (let f = 0; f < faces; f++) {
    for (let c = 0; c < 3; c++) {
      const b = buckets.get(keys[f * 3 + c]);
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < b.length; i++) {
        const h = b[i];
        if (fx[f] * fx[h] + fy[f] * fy[h] + fz[f] * fz[h] < cosLim) continue;
        sx += fx[h] * wgt[h]; sy += fy[h] * wgt[h]; sz += fz[h] * wgt[h];
      }
      let L = Math.hypot(sx, sy, sz);
      if (L < 1e-12) { sx = fx[f]; sy = fy[f]; sz = fz[f]; L = 1; }
      const o = f * 9 + c * 3;
      out[o] = sx / L; out[o + 1] = sy / L; out[o + 2] = sz / L;
    }
  }
  src.setAttribute('normal', new THREE.Float32BufferAttribute(out, 3));
  const idx = new Uint32Array(pos.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  src.setIndex(new THREE.BufferAttribute(idx, 1));
  return src;
}

/** Non-indexed rebuild so shading reads faceted (used for plate / crystal bits). */
function facet(g) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  const count = f.attributes.position.count;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  f.setIndex(new THREE.BufferAttribute(idx, 1));
  return f;
}

/**
 * Gives an open sheet real thickness by pushing a flipped copy along -normal.
 * Avoids the coplanar z-fighting a plain back-face duplicate would cause.
 */
function shell(g, thickness) {
  const back = g.clone();
  const p = back.attributes.position.array;
  const n = back.attributes.normal.array;
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= n[i] * thickness;
    p[i + 1] -= n[i + 1] * thickness;
    p[i + 2] -= n[i + 2] * thickness;
    n[i] = -n[i]; n[i + 1] = -n[i + 1]; n[i + 2] = -n[i + 2];
  }
  flipWinding(back);
  const merged = mergeGeometries([conform(g), conform(back)], false);
  return merged || g;
}

/**
 * Parametric grid surface. Convention (matches a cylinder built as
 * `x*cos(2*PI*u) + y*sin(2*PI*u)` rising along v): default winding faces out.
 */
function surface(uSteps, vSteps, fn, opts = {}) {
  const { closedU = false, trim = null, flip = false, flat = false, crease = 0 } = opts;
  const cols = uSteps + 1, rows = vSteps + 1;
  const pos = [], uv = [], tm = [], idx = [];
  const p = V3();
  for (let j = 0; j < rows; j++) {
    const v = j / vSteps;
    for (let i = 0; i < cols; i++) {
      const u = i / uSteps;
      p.set(0, 0, 0);
      fn(u, v, p);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v);
      tm.push(trim ? clamp01(trim(u, v)) : 0);
    }
  }
  for (let j = 0; j < vSteps; j++) {
    for (let i = 0; i < uSteps; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = rawGeo(pos, uv, tm, idx);
  g.computeVertexNormals();
  if (closedU) {
    const n = g.attributes.normal.array;
    for (let j = 0; j < rows; j++) {
      const a = (j * cols) * 3, b = (j * cols + uSteps) * 3;
      for (let k = 0; k < 3; k++) {
        const m = (n[a + k] + n[b + k]) * 0.5;
        n[a + k] = m; n[b + k] = m;
      }
    }
  }
  if (flat) return facet(g);
  return crease > 0 ? creaseNormals(g, crease) : g;
}

const polyArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
};

/**
 * Parallel-transport frames along a polyline. `xHint` seeds the section's local
 * +x so asymmetric cross-sections keep a predictable orientation.
 * Guarantees cross(x, y) === tangent.
 */
function framesAlong(points, xHint = V3(1, 0, 0)) {
  const n = points.length;
  const out = [];
  let x = xHint.clone().normalize();
  if (!Number.isFinite(x.lengthSq()) || x.lengthSq() < 0.5) x.set(1, 0, 0);
  // Seed sanity: if the hint is nearly parallel to the first tangent the
  // projected residual is a few percent of a unit vector pointing in an
  // essentially arbitrary direction, and the swept section lands almost
  // edge-on — the sliver that shows up as a blown-out needle on the Rogue's
  // chest harness. Swap to a seed that is genuinely transverse instead.
  if (n > 1) {
    const t0 = points[Math.min(n - 1, 1)].clone().sub(points[0]);
    if (t0.lengthSq() > 1e-12) {
      t0.normalize();
      if (Math.abs(x.dot(t0)) > 0.9) {
        x = Math.abs(t0.y) < 0.9 ? V3(0, 1, 0).cross(t0) : V3(1, 0, 0).cross(t0);
        x.normalize();
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    t.normalize();
    x.addScaledVector(t, -x.dot(t));
    if (x.lengthSq() < 1e-10) {
      x = Math.abs(t.y) < 0.9 ? V3(0, 1, 0).cross(t) : V3(1, 0, 0).cross(t);
    }
    x.normalize();
    const y = t.clone().cross(x).normalize();
    out.push({ p: points[i].clone(), x: x.clone(), y, t });
  }
  return out;
}

/** Sweeps a closed 2D section along a frame list. Winding is derived, not guessed. */
function sweep(frames, section, opts = {}) {
  const {
    closed = false, capStart = false, capEnd = false,
    trim = null, scale = null, offset = null, flat = false, crease = 0
  } = opts;
  const n = frames.length, m = section.length;
  const pos = [], uv = [], tm = [], idx = [];
  const scaled = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const t = n > 1 ? i / (n - 1) : 0;
    const s = scale ? scale(t, i) : null;
    const sx = s ? s[0] : 1, sy = s ? s[1] : 1;
    const o = offset ? offset(t, i) : null;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0;
    const ring = [];
    for (let k = 0; k < m; k++) {
      const a = section[k].x * sx + ox, b = section[k].y * sy + oy;
      const px = f.p.x + f.x.x * a + f.y.x * b;
      const py = f.p.y + f.x.y * a + f.y.y * b;
      const pz = f.p.z + f.x.z * a + f.y.z * b;
      pos.push(px, py, pz);
      uv.push(k / m, t);
      tm.push(trim ? clamp01(trim(k / m, t)) : 0);
      ring.push(px, py, pz);
    }
    scaled.push(ring);
  }
  const travel = n > 1 ? frames[1].p.clone().sub(frames[0].p) : frames[0].t.clone();
  const hand = frames[0].x.clone().cross(frames[0].y).dot(travel);
  const pos_ = polyArea(section) * (hand === 0 ? 1 : hand) > 0;
  const segs = closed ? n : n - 1;
  for (let j = 0; j < segs; j++) {
    const j2 = (j + 1) % n;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a = j * m + k, b = j * m + k2, c = j2 * m + k, d = j2 * m + k2;
      if (pos_) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ringIdx, atEnd) => {
    const ring = scaled[ringIdx];
    const base = pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < m; k++) { cx += ring[k * 3]; cy += ring[k * 3 + 1]; cz += ring[k * 3 + 2]; }
    cx /= m; cy /= m; cz /= m;
    const tv = trim ? clamp01(trim(0.5, atEnd ? 1 : 0)) : 0;
    pos.push(cx, cy, cz); uv.push(0.5, 0.5); tm.push(tv);
    for (let k = 0; k < m; k++) {
      pos.push(ring[k * 3], ring[k * 3 + 1], ring[k * 3 + 2]);
      uv.push(0.5 + Math.cos(TAU * k / m) * 0.5, 0.5 + Math.sin(TAU * k / m) * 0.5);
      tm.push(tv);
    }
    const fwd = pos_ === atEnd;
    for (let k = 0; k < m; k++) {
      const a = base + 1 + k, b = base + 1 + ((k + 1) % m);
      if (fwd) idx.push(base, a, b); else idx.push(base, b, a);
    }
  };
  if (capStart && !closed) cap(0, false);
  if (capEnd && !closed) cap(n - 1, true);
  const g = rawGeo(pos, uv, tm, idx);
  g.computeVertexNormals();
  if (flat) return facet(g);
  return crease > 0 ? creaseNormals(g, crease) : g;
}

const ellipse = (n, rx, ry, phase = 0) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + TAU * i / n;
    out.push(V2(Math.cos(a) * rx, Math.sin(a) * ry));
  }
  return out;
};

const roundRect = (w, h, bev = 0) => {
  const x = w * 0.5, y = h * 0.5;
  const b = Math.min(bev, x * 0.85, y * 0.85);
  return [
    V2(x - b, -y), V2(x, -y + b), V2(x, y - b), V2(x - b, y),
    V2(-x + b, y), V2(-x, y - b), V2(-x, -y + b), V2(-x + b, -y)
  ];
};

/** Blade / horn cross-section: wide on x, razor thin on y with sharp tips. */
const lens = (len, thick) => {
  const out = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    const s = Math.sin(a);
    out.push(V2(Math.cos(a) * len * 0.5, s * thick * 0.5 * (0.35 + 0.65 * Math.abs(s))));
  }
  return out;
};

/** Accumulates geometry, applies placement matrices, merges once. */
class Part {
  constructor(name) { this.name = name; this.geos = []; this.tris = 0; }
  add(geo, matrix = null, trim = 0) {
    if (!geo) return this;
    if (matrix) {
      geo.applyMatrix4(matrix);
      if (matrix.determinant() < 0) flipWinding(geo);
    }
    conform(geo, trim);
    this.tris += triCount(geo);
    this.geos.push(geo);
    return this;
  }
  merge() {
    if (this.geos.length === 0) return null;
    if (this.geos.length === 1) return this.geos[0];
    return mergeGeometries(this.geos, false);
  }
}

const mat = () => new THREE.Matrix4();
const place = (x, y, z) => mat().makeTranslation(x, y, z);
function trs(pos, euler, scl) {
  const m = mat();
  m.compose(
    pos || V3(),
    new THREE.Quaternion().setFromEuler(euler || new THREE.Euler()),
    scl || V3(1, 1, 1)
  );
  return m;
}

// ---------------------------------------------------------------------------
// fitting: turn joints + build into the numbers every piece needs
// ---------------------------------------------------------------------------

function metrics(joints, build, race) {
  const b = build || {};
  const H = b.height || 1.85;
  const u = H / 1.85;                       // absolute-thickness unit
  const j = joints || {};

  const hipsPos = j.hips?.position ? V3().copy(j.hips.position) : V3(0, H * 0.52, 0);
  const hipR = j.hips?.radius || H * 0.085 * (b.hip || 1);
  const neckPos = j.neck?.position ? V3().copy(j.neck.position) : V3(0, H * 0.83, 0);
  const neckR = j.neck?.radius || H * 0.045;

  let spine = Array.isArray(j.spine) && j.spine.length >= 2
    ? j.spine.map((p) => V3().copy(p)).filter((p, i, arr) => i === 0 || p.distanceToSquared(arr[i - 1]) > 1e-10)
    : null;
  if (spine && spine.length < 2) spine = null;
  if (!spine) {
    spine = [];
    for (let i = 0; i <= 4; i++) spine.push(hipsPos.clone().lerp(neckPos, i / 4));
  }
  if (spine[0].y > spine[spine.length - 1].y) spine.reverse();
  const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.4);

  const shoulders = (j.shoulders && j.shoulders.length ? j.shoulders : [
    { position: V3(H * 0.11 * (b.shoulderW || 1), neckPos.y - H * 0.02, 0), radius: H * 0.05, side: 1 },
    { position: V3(-H * 0.11 * (b.shoulderW || 1), neckPos.y - H * 0.02, 0), radius: H * 0.05, side: -1 }
  ]).map((s) => ({
    p: V3().copy(s.position),
    r: s.radius || H * 0.05,
    side: s.side || (s.position.x >= 0 ? 1 : -1)
  }));

  const hands = (j.hands && j.hands.length ? j.hands : shoulders.map((s) => ({
    position: V3(s.p.x * 1.05, s.p.y - H * (b.armLength || 0.44), s.p.z),
    radius: H * 0.028,
    side: s.side
  }))).map((h) => ({
    p: V3().copy(h.position),
    r: h.radius || H * 0.028,
    side: h.side || (h.position.x >= 0 ? 1 : -1)
  }));

  const feet = (j.feet && j.feet.length ? j.feet : [
    { position: V3(hipR * 0.55, 0, 0), side: 1 },
    { position: V3(-hipR * 0.55, 0, 0), side: -1 }
  ]).map((f) => ({
    p: V3().copy(f.position),
    r: f.radius || 0,
    side: f.side || (f.position.x >= 0 ? 1 : -1)
  }));

  const shoulderX = shoulders.reduce((a, s) => a + Math.abs(s.p.x), 0) / shoulders.length;
  const shoulderR = shoulders.reduce((a, s) => a + s.r, 0) / shoulders.length;
  const shoulderY = shoulders.reduce((a, s) => a + s.p.y, 0) / shoulders.length;

  // Torso section, rebuilt from the same multipliers races.js documents as
  // "torso ring radii" so the shell sits ON the body instead of inside it.
  // `unit` is recovered from the reported hip joint, so it follows any scaling
  // the body applied to hit its exact height.
  const hipMul = b.hip || 1, waistMul = b.waist || 0.9, chestMul = b.chest || 1, shwMul = b.shoulderW || 1;
  const unit = (j.hips?.radius && hipMul > 0.05) ? hipR / hipMul : H * 0.098;
  const hipR0 = unit * hipMul, waistR0 = unit * waistMul, chestR0 = unit * chestMul;
  const shoulderHalf = unit * shwMul * 1.28;
  const barrel = 0.72 + 0.16 * clamp01(chestMul - 1);
  const R_CTRL = [
    [0.00, hipR0 * 0.80], [0.07, hipR0 * 1.02], [0.16, hipR0 * 0.98],
    [0.30, waistR0 * 0.94], [0.42, waistR0 * 1.02],
    [0.62, chestR0 * 1.02], [0.76, chestR0 * 1.06],
    [0.88, shoulderHalf * 0.66], [1.00, shoulderHalf * 0.50]
  ];
  const A_CTRL = [[0.00, 0.86], [0.16, 0.82], [0.34, 0.74], [0.62, barrel], [0.80, barrel * 1.02], [1.00, 0.80]];
  const B_CTRL = [[0.00, 1.11], [0.14, 1.13], [0.34, 1.00], [0.68, 1.03], [1.00, 1.00]];
  const torsoR = (t) => profile(clamp01(t), R_CTRL);
  const torsoAspect = (t) => profile(clamp01(t), A_CTRL);
  const torsoBack = (t) => profile(clamp01(t), B_CTRL);
  // trapezius hump the body lofts onto hunched races
  const humpAmt = unit * (0.10 + 1.35 * Math.max(0, b.posture || 0)) * (0.6 + 0.4 * chestMul);
  const hump = (t, back) => humpAmt * gauss(t - 0.92, 0.13) * Math.max(0, back);

  const chestW = torsoR(0.72);

  const frameAt = (t) => {
    const tt = clamp01(t);
    const p = curve.getPointAt(tt);
    const up = curve.getTangentAt(tt).normalize();
    const right = up.clone().cross(V3(0, 0, 1));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const fwd = right.clone().cross(up).normalize();
    return { p, right, fwd, up };
  };

  // t along the spine curve for a given world height
  const tAtY = (y) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) * 0.5;
      if (curve.getPointAt(mid).y < y) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  };

  return {
    H, u, curve, frameAt, tAtY,
    hipsPos, hipR, neckPos, neckR,
    shoulders, hands, feet,
    shoulderX, shoulderR, shoulderY,
    torsoR, torsoAspect, torsoBack, hump,
    chestW,
    posture: b.posture || 0,
    legThick: b.legThick || 1,
    armThick: b.armThick || 1,
    digitigrade: !!b.digitigrade,
    race: race?.name || 'Human'
  };
}

const TIER_SHAPE = {
  plate:   { offset: 0.026, bulge: 0.20, collar: 1.00, hem: 0.16, segs: 28, rows: 18, crease: 64 },
  mail:    { offset: 0.020, bulge: 0.10, collar: 0.55, hem: 0.10, segs: 28, rows: 18, crease: 72 },
  leather: { offset: 0.015, bulge: 0.06, collar: 0.35, hem: 0.06, segs: 26, rows: 16, crease: 72 },
  cloth:   { offset: 0.022, bulge: 0.02, collar: 0.70, hem: 0.02, segs: 28, rows: 18, crease: 78 }
};

// ---------------------------------------------------------------------------
// trim mask
// ---------------------------------------------------------------------------

/*
 * `aTrimMask` is a POINT SAMPLE, taken at the vertices of a coarse grid: the
 * chest is 28 columns around by 18 rows up, a swept strap is 8 samples around
 * its section. Anything finer than roughly two grid cells therefore does not
 * survive sampling — it aliases.
 *
 * The old generators ignored that. `riveted` was |sin(u*16*PI)|^22, i.e. 16
 * lobes read at 23 columns; 8u mod 11 walks the residues, so exactly four
 * columns landed within a hair of a lobe peak and every one of them evaluated
 * to 0.718 while their neighbours evaluated to 0. Those four columns were not
 * rivets, they were the alias, and because they were *constant down every row*
 * they painted four full-height stripes of inlay whose interpolation smeared
 * across a whole quad. `stitched` (26 lobes, ^30) and `leather` (20 lobes, ^26)
 * were worse still.
 *
 * Fine repeated detail — rivet heads, stitch dashes, studs — belongs in the
 * material's UV-space bakes, which run at 512x512 and already carry it. What
 * this attribute can honestly describe is BROAD regions, so that is all it does
 * now: hems, cuffs, a collar band, a waist line and at most SEAMS panel
 * divisions. Every feature below is at least two grid cells wide in u and in v,
 * and the seam positions are k/SEAMS, which lands on a vertex column for every
 * `segs` in TIER_SHAPE (they are all multiples of SEAMS).
 */
const TRIM_SEAMS = 4;

/** Fade in from an edge at v = 0, `w` wide. */
const edgeTo = (v, w) => 1 - smooth(clamp01(v / w));
/** Smooth band of half-width `w` centred on `c` in a non-wrapping coordinate. */
const bandV = (v, c, w) => 1 - smooth(clamp01(Math.abs(v - c) / w));
/** Same, but in the wrapped `u` coordinate. */
const bandU = (u, c, w) => {
  const d = Math.abs((((u - c) % 1) + 1.5) % 1 - 0.5);
  return 1 - smooth(clamp01(d / w));
};
/** `n` evenly spaced vertical seams, one of them on the centre front (u = 0). */
const seamsU = (u, n, w) => {
  const d = Math.abs((((u * n) % 1) + 1.5) % 1 - 0.5) / n;
  return 1 - smooth(clamp01(d / w));
};

/**
 * Trim mask generators keyed by klass.armor.trim. u = around (0 = front), v = up.
 * Broad regions only — see the note above.
 */
function trimFor(style) {
  const SW = 0.055;                 // seam half-width: ~1.5 cells at segs 28
  switch (style) {
    case 'gilt':
      return (u, v) => Math.max(
        edgeTo(v, 0.10), edgeTo(1 - v, 0.09),
        bandU(u, 0.5, 0.055) * 0.95,
        bandV(v, 0.55, 0.055) * 0.85
      );
    case 'riveted':
      return (u, v) => Math.max(
        edgeTo(v, 0.10), edgeTo(1 - v, 0.11),
        bandV(v, 0.62, 0.070) * 0.95,
        seamsU(u, TRIM_SEAMS, SW) * bandV(v, 0.5, 0.62) * 0.9
      );
    case 'runic':
      return (u, v) => Math.max(
        edgeTo(v, 0.08) * 0.85, edgeTo(1 - v, 0.09) * 0.85,
        bandU(u, 0.5, 0.06),
        seamsU(u, TRIM_SEAMS, 0.05) * gauss(v - 0.5, 0.24) * 1.15
      );
    case 'embroidered':
      return (u, v) => Math.max(
        edgeTo(v, 0.13), edgeTo(1 - v, 0.10),
        bandU(u, 0.5, 0.07) * 0.95,
        seamsU(u, TRIM_SEAMS, 0.05) * bandV(v, 0.28, 0.10) * 0.9
      );
    case 'bone':
      return (u, v) => Math.max(
        edgeTo(v, 0.07) * 0.95,
        seamsU(u, TRIM_SEAMS, 0.05) * bandV(v, 0.72, 0.13)
      );
    case 'leather':
      return (u, v) => Math.max(
        edgeTo(v, 0.08) * 0.85, edgeTo(1 - v, 0.07) * 0.7,
        seamsU(u, TRIM_SEAMS, 0.045) * bandV(v, 0.5, 0.55) * 0.8
      );
    case 'stitched':
    default:
      return (u, v) => Math.max(
        edgeTo(v, 0.07) * 0.75, edgeTo(1 - v, 0.07) * 0.75,
        seamsU(u, TRIM_SEAMS, 0.04) * bandV(v, 0.5, 0.5) * 0.7
      );
  }
}

// ---------------------------------------------------------------------------
// torso: chest piece + collar
// ---------------------------------------------------------------------------

function buildChest(ctx) {
  const { M, A } = ctx;
  const T = TIER_SHAPE[A.tier] || TIER_SHAPE.plate;
  const part = new Part('chest');
  const u = M.u;
  const off = T.offset * u;

  const vLow = M.tAtY(M.hipsPos.y + M.hipR * 0.15);
  const vHigh = 1.0;
  const isCloth = A.tier === 'cloth';
  const isMail = A.tier === 'mail';

  // Density is set by what the trim mask and the shading have to resolve, not
  // by the silhouette: 28x18 is still only ~1000 triangles out of a 25k budget,
  // and it gives the creased normals enough rings that the pectoral and spine
  // swells read as curvature rather than as a fold.
  const segs = T.segs;
  const rows = T.rows;
  const rowFrames = [];
  for (let j = 0; j <= rows; j++) rowFrames.push(M.frameAt(lerp(vLow, vHigh, j / rows)));

  const trimFn = trimFor(A.trim);
  const bulge = T.bulge;

  const shellGeo = surface(segs, rows, (uu, vv, out) => {
    const f = rowFrames[Math.round(vv * rows)];
    const ts = lerp(vLow, vHigh, vv);              // parameter along the body's spine
    const th = TAU * uu + Math.PI * 0.5;
    const ct = Math.cos(th), st = Math.sin(th);
    // the body lofts a superellipse (n ~ 2.2), so an ellipse here would sink
    // into it at the diagonals
    const cs = Math.sign(ct) * Math.pow(Math.abs(ct), 0.90);
    const ss = Math.sign(st) * Math.pow(Math.abs(st), 0.90);
    const front = Math.max(0, st);
    const back = Math.max(0, -st);
    let w = M.torsoR(ts) * 1.015 + off;
    let d = M.torsoR(ts) * M.torsoAspect(ts) * lerp(1, M.torsoBack(ts), back) * 1.015 + off * 0.55;
    // pectoral / back plates
    const pec = bulge * gauss(ts - 0.70, 0.12) * (gauss(ct - 0.42, 0.30) + gauss(ct + 0.42, 0.30));
    const spineRidge = bulge * 0.45 * back * back * gauss(ts - 0.60, 0.24);
    const k = 1 + pec * front + spineRidge;
    // cloth robes flare at the hem instead of tapering
    const flare = isCloth ? 1 + 0.28 * Math.pow(1 - vv, 2.2) : 1;
    w *= k * flare;
    d *= k * flare;
    const humpZ = M.hump(ts, back);
    out.set(
      f.p.x + f.right.x * w * cs + f.fwd.x * (d * ss - humpZ),
      f.p.y + f.right.y * w * cs + f.fwd.y * (d * ss - humpZ) + humpZ * 0.45,
      f.p.z + f.right.z * w * cs + f.fwd.z * (d * ss - humpZ)
    );
  }, { closedU: true, crease: T.crease, trim: (uu, vv) => trimFn(uu, vv) });
  part.add(shellGeo);

  // collar / gorget
  if (T.collar > 0.2) {
    const top = M.frameAt(0.995);
    // base hugs the trapezius ring, then tapers in to the neck and flares
    const crBase = Math.max(M.neckR * 1.30, M.torsoR(1.0) * 0.86) + off;
    const crTop = M.neckR * (isCloth ? 1.60 : 1.24) + off;
    const ch = M.neckR * (isCloth ? 2.30 : 1.35) * T.collar;
    const frames = [];
    const rowsC = 5;
    for (let i = 0; i <= rowsC; i++) {
      const t = i / rowsC;
      frames.push({
        p: top.p.clone().addScaledVector(top.up, ch * t - ch * 0.10),
        x: top.right.clone(), y: top.fwd.clone(), t: top.up.clone()
      });
    }
    const aspTop = M.torsoAspect(1.0) * 1.12;
    const collar = surface(16, rowsC, (uu, vv, out) => {
      const f = frames[Math.round(vv * rowsC)];
      const th = TAU * uu + Math.PI * 0.5;
      const flareC = 1 + (isCloth ? 0.55 : 0.20) * Math.pow(vv, 2.2);
      const dip = 1 - 0.32 * Math.max(0, Math.sin(th)) * vv;   // open at the throat
      const r = lerp(crBase, crTop, smooth(vv)) * flareC * dip;
      out.set(
        f.p.x + f.x.x * r * Math.cos(th) + f.y.x * r * aspTop * Math.sin(th),
        f.p.y + f.x.y * r * Math.cos(th) + f.y.y * r * aspTop * Math.sin(th),
        f.p.z + f.x.z * r * Math.cos(th) + f.y.z * r * aspTop * Math.sin(th)
      );
    }, { closedU: true, crease: Math.min(T.crease, 52), trim: (uu, vv) => Math.max(0.25, smooth(vv * 1.4)) });
    part.add(collar);
  }

  // leather / mail get a crossed harness; plate gets a sternum boss
  if (A.tier === 'leather' || isMail) {
    for (const s of [1, -1]) {
      const pts = [];
      let hint = null;
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const ts = lerp(0.86, 0.22, t);
        const f = M.frameAt(ts);
        const th = Math.PI * 0.5 + s * lerp(0.15, 0.95, t);
        const w = M.torsoR(ts) + off * 2.4;
        const d = M.torsoR(ts) * M.torsoAspect(ts) + off * 2.0;
        pts.push(V3(
          f.p.x + f.right.x * w * Math.cos(th) + f.fwd.x * d * Math.sin(th),
          f.p.y + f.right.y * w * Math.cos(th) + f.fwd.y * d * Math.sin(th),
          f.p.z + f.right.z * w * Math.cos(th) + f.fwd.z * d * Math.sin(th)
        ));
        // The strap's WIDE axis has to lie along the chest, not stick out of
        // it. Seeding the transport with (0,1,0) — which is all but parallel to
        // a strap running down the torso — left the seed direction to fall out
        // of floating-point noise, and the 5.5 cm band came out standing on
        // edge: a one-pixel sliver that the anisotropic glint lit up as a
        // glowing needle across the Rogue's chest. Seed it with the surface
        // tangent instead.
        if (i === 0) {
          hint = f.right.clone().multiplyScalar(-Math.sin(th))
            .addScaledVector(f.fwd, Math.cos(th)).normalize();
        }
      }
      const strap = sweep(framesAlong(pts, hint || V3(1, 0, 0)), roundRect(0.055 * u, 0.014 * u, 0.005 * u), {
        capStart: true, capEnd: true, trim: () => 0.35, scale: (t) => [lerp(1, 0.8, t), 1],
        crease: 34
      });
      part.add(strap);
    }
  } else if (A.tier === 'plate') {
    const f = M.frameAt(0.70);
    const boss = new THREE.SphereGeometry(M.chestW * 0.22, 10, 7, 0, TAU, 0, Math.PI * 0.55);
    const p = f.p.clone().addScaledVector(f.fwd, M.torsoR(0.70) * M.torsoAspect(0.70) * 1.03 + off);
    const m = trs(p, new THREE.Euler(Math.PI * 0.5, 0, 0), V3(1, 1, 0.55));
    part.add(facet(boss), m, 1.0);
  }

  return part;
}

// ---------------------------------------------------------------------------
// belt
// ---------------------------------------------------------------------------

function buildBelt(ctx) {
  const { M, A } = ctx;
  const part = new Part('belt');
  const u = M.u;
  const T = TIER_SHAPE[A.tier] || TIER_SHAPE.plate;
  const t = M.tAtY(M.hipsPos.y + M.hipR * 0.20);
  const f = M.frameAt(t);
  const rw = M.torsoR(t) * 1.03 + T.offset * u * 1.25;
  const rd = M.torsoR(t) * M.torsoAspect(t) * 1.03 + T.offset * u * 1.10;
  const h = M.hipR * (A.tier === 'plate' ? 0.52 : 0.38);
  const thick = 0.020 * u;

  const n = 20;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const th = TAU * i / n + Math.PI * 0.5;
    const dir = f.right.clone().multiplyScalar(Math.cos(th)).addScaledVector(f.fwd, Math.sin(th));
    frames.push({
      p: f.p.clone().addScaledVector(f.right, rw * Math.cos(th)).addScaledVector(f.fwd, rd * Math.sin(th)),
      x: dir.normalize(),
      y: f.up.clone(),
      t: f.up.clone()
    });
  }
  const belt = sweep(frames, roundRect(thick * 2, h, thick * 0.6), {
    closed: true,
    trim: (s, tt) => 0.25 + 0.55 * Math.pow(Math.abs(Math.sin(tt * n * Math.PI)), 18)
  });
  part.add(belt);

  // buckle at the front
  const buckleP = f.p.clone().addScaledVector(f.fwd, rd + thick * 0.8);
  // A buckle is jewellery on a belt, not a second belt: the prong used to be
  // 1.35 * 1.5 * the band height — an 18 cm mirror-metal slab standing on end,
  // which the bloom pass duly clipped to a white bar down the character's front.
  const bw = M.hipR * 0.55, bh = h * 1.15;
  if (A.tier === 'plate' || A.tier === 'mail') {
    const g = new THREE.CylinderGeometry(bw * 0.55, bw * 0.55, thick * 1.6, 8, 1);
    part.add(facet(g), trs(buckleP, new THREE.Euler(Math.PI * 0.5, 0, 0), V3(1, 1, 1)), 1.0);
    const g2 = new THREE.BoxGeometry(bw * 0.16, bh, thick * 1.8);
    part.add(g2, place(buckleP.x, buckleP.y, buckleP.z), 1.0);
  } else {
    const g = new THREE.BoxGeometry(bw, bh, thick * 1.4);
    part.add(g, place(buckleP.x, buckleP.y, buckleP.z), 1.0);
  }
  return part;
}

// ---------------------------------------------------------------------------
// skirts
// ---------------------------------------------------------------------------

function buildSkirt(ctx) {
  const { M, A } = ctx;
  switch (A.skirt) {
    case 'tasset': return skirtTasset(ctx);
    case 'tabard': return skirtTabard(ctx);
    case 'belted': return skirtBelted(ctx);
    case 'robe': return skirtRobe(ctx);
    case 'sash': return skirtSash(ctx);
    default: return M ? null : null;
  }
}

function hipFrame(M) {
  const t = M.tAtY(M.hipsPos.y + M.hipR * 0.05);
  const f = M.frameAt(t);
  f.t = t;
  f.rw = M.torsoR(t);
  f.rd = M.torsoR(t) * M.torsoAspect(t);
  return f;
}

/** Warrior / Death Knight: hanging plate strips that splay outward as they fall. */
function skirtTasset(ctx) {
  const { M, A, rand } = ctx;
  const part = new Part('tasset');
  const u = M.u;
  const f = hipFrame(M);
  // The skirt used to read as a barrel because three things stacked up: a 3 cm
  // stand-off at the belt, ten strips cut 18% wider than the circumference they
  // hang from, and a splay that pushed the hem 5 cm further out again — so the
  // hem ended up 8 cm proud of a thigh that is itself only 6 cm across. The
  // stand-off, the overlap and the splay are all pulled back, and the strips
  // now taper as they fall.
  const rw = f.rw * 1.03 + 0.017 * u;
  const rd = f.rd * 1.03 + 0.015 * u;
  const drop = M.H * (A.pauldron === 'skulled' ? 0.20 : 0.175);
  const count = 10;

  for (let i = 0; i < count; i++) {
    const th = TAU * (i + 0.5) / count + Math.PI * 0.5;
    const ct = Math.cos(th), st = Math.sin(th);
    // `dir` is built as right*ct + fwd*st, so |ct| ~ 1 is the OUTSIDE of the
    // hip, not the inner thigh the old guard's comment claimed. Skipping those
    // two strips left the hips bare on exactly the silhouette the hero view
    // reads, so the ring is closed now; stride clearance comes from the taper
    // and the shorter drop instead.
    const dir = f.right.clone().multiplyScalar(ct).addScaledVector(f.fwd, st).normalize();
    const top = f.p.clone().addScaledVector(f.right, rw * ct).addScaledVector(f.fwd, rd * st);
    const len = drop * (0.82 + 0.30 * Math.max(0, st) + 0.10 * rand());
    const pts = [];
    const segs = 5;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      pts.push(top.clone()
        .addScaledVector(f.up, -len * t)
        .addScaledVector(dir, len * 0.09 * t * t + 0.004 * u));
    }
    const w = (TAU * rw / count) * 1.14;
    const strip = sweep(framesAlong(pts, dir), roundRect(w, 0.024 * u, 0.008 * u), {
      capStart: true, capEnd: true,
      scale: (t) => [lerp(1, 0.84, t * t), 1],
      // hanger band at the top, edge band at the hem; the rivets themselves are
      // real geometry below and micro-relief in the material's bake
      trim: (s, t) => Math.max(1 - smooth(t / 0.16), (1 - smooth((1 - t) / 0.12)) * 0.85),
      crease: 34
    });
    part.add(strip);
    // rivet at the hanger
    const rivet = new THREE.SphereGeometry(0.012 * u, 6, 4);
    part.add(rivet, place(pts[0].x + dir.x * 0.012 * u, pts[0].y - 0.012 * u, pts[0].z + dir.z * 0.012 * u), 1.0);
  }

  // second overlapping tier for the Death Knight's heavier plate
  if (A.pauldron === 'skulled') {
    const cape2 = surface(20, 3, (uu, vv, out) => {
      const th = TAU * uu + Math.PI * 0.5;
      const r = rw * (1.02 + 0.10 * vv);
      const d = rd * (1.02 + 0.10 * vv);
      out.set(
        f.p.x + f.right.x * r * Math.cos(th) + f.fwd.x * d * Math.sin(th),
        f.p.y - drop * 0.30 * vv + 0.02 * u,
        f.p.z + f.right.z * r * Math.cos(th) + f.fwd.z * d * Math.sin(th)
      );
    }, { closedU: true, crease: 42, trim: (uu, vv) => (vv > 0.8 ? 1 : 0.15) });
    part.add(shell(cape2, 0.012 * u));
  }
  return part;
}

/** Paladin / Evoker: front and back panel hanging from the belt. */
function skirtTabard(ctx) {
  const { M, A } = ctx;
  const part = new Part('tabard');
  const u = M.u;
  const f = hipFrame(M);
  const trimFn = trimFor(A.trim);
  const top = M.hipsPos.y + M.hipR * 0.55;
  const len = M.H * 0.30;
  const halfW = f.rw * 0.80;

  for (const s of [1, -1]) {
    const panel = surface(7, 10, (uu, vv, out) => {
      const x = (uu - 0.5) * 2 * halfW * (1 + 0.12 * smooth(vv) - 0.22 * vv * vv);
      const y = top - len * vv - Math.abs(uu - 0.5) * len * 0.10;
      const bow = (1 - Math.abs(uu - 0.5) * 2) * 0.35;
      const fold = Math.sin(uu * Math.PI * 3) * 0.012 * u * smooth(vv);
      const z = s * (f.rd * (1.10 + bow * 0.22) + fold + 0.045 * u * smooth(vv * 1.2));
      out.set(f.p.x + x, y, f.p.z + z * 1.0);
    }, {
      flip: s < 0,
      trim: (uu, vv) => Math.max(
        1 - smooth(Math.min(uu, 1 - uu) / 0.10),
        1 - smooth((1 - vv) / 0.07),
        trimFn(uu, vv) * 0.6
      )
    });
    part.add(shell(panel, 0.007 * u));
  }
  return part;
}

/** Hunter / Shaman / Druid: leather straps, thigh wraps and pouches. */
function skirtBelted(ctx) {
  const { M, A, rand } = ctx;
  const part = new Part('belted');
  const u = M.u;
  const f = hipFrame(M);
  const rw = f.rw * 1.03 + 0.016 * u;
  const rd = f.rd * 1.03 + 0.014 * u;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const th = Math.PI * 0.5 + (i / (n - 1) - 0.5) * 2.4 + (rand() - 0.5) * 0.12;
    const ct = Math.cos(th), st = Math.sin(th);
    const dir = f.right.clone().multiplyScalar(ct).addScaledVector(f.fwd, st).normalize();
    const top = f.p.clone().addScaledVector(f.right, rw * ct).addScaledVector(f.fwd, rd * st);
    const len = M.H * (0.13 + 0.06 * rand());
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push(top.clone()
        .addScaledVector(f.up, -len * t)
        .addScaledVector(dir, 0.006 * u + 0.02 * u * t * t)
        .addScaledVector(f.right, Math.sin(t * 2.2) * 0.010 * u * (i % 2 ? 1 : -1)));
    }
    const strap = sweep(framesAlong(pts, dir), roundRect(0.055 * u * (0.8 + rand() * 0.5), 0.012 * u, 0.004 * u), {
      capStart: true, capEnd: true,
      scale: (t) => [lerp(1, 0.7, t), 1],
      trim: (s, t) => Math.max(0.2, 1 - smooth(t / 0.12))
    });
    part.add(strap);
  }
  // pouches / totem bag on the hip
  for (const s of [1, -1]) {
    const p = f.p.clone()
      .addScaledVector(f.right, rw * 0.92 * s)
      .addScaledVector(f.fwd, rd * 0.35)
      .addScaledVector(f.up, -M.hipR * 0.55);
    const box = new THREE.BoxGeometry(M.hipR * 0.42, M.hipR * 0.55, M.hipR * 0.30);
    part.add(box, trs(p, new THREE.Euler(0.12 * s, 0.3 * s, 0.1 * s), V3(1, 1, 1)), 0.15);
    const lid = new THREE.BoxGeometry(M.hipR * 0.46, M.hipR * 0.14, M.hipR * 0.34);
    part.add(lid, trs(p.clone().addScaledVector(f.up, M.hipR * 0.26), new THREE.Euler(0.12 * s, 0.3 * s, 0.1 * s), V3(1, 1, 1)), 0.9);
  }
  if (A.pauldron === 'antlered' || A.pauldron === 'totemic') {
    // hanging bone/feather charms
    for (let i = 0; i < 4; i++) {
      const th = Math.PI * 0.5 + (rand() - 0.5) * 2.0;
      const p = f.p.clone()
        .addScaledVector(f.right, rw * Math.cos(th))
        .addScaledVector(f.fwd, rd * Math.sin(th))
        .addScaledVector(f.up, -M.hipR * (0.9 + rand() * 0.8));
      const bone = new THREE.CylinderGeometry(0.008 * u, 0.006 * u, M.hipR * 0.5, 5, 1);
      part.add(bone, trs(p, new THREE.Euler((rand() - 0.5) * 0.5, 0, (rand() - 0.5) * 0.5), V3(1, 1, 1)), 0.85);
    }
  }
  return part;
}

/** Priest / Mage / Warlock: full lower-body cone with real folds. */
function skirtRobe(ctx) {
  const { M, A } = ctx;
  const part = new Part('robe');
  const u = M.u;
  const f = hipFrame(M);
  const topY = M.hipsPos.y + M.hipR * 0.35;
  const hemY = Math.max(0.045 * M.H, 0.02);
  const folds = 9;
  const trimFn = trimFor(A.trim);
  const slit = A.pauldron === 'horned' ? 0.55 : 0.0;   // warlock robe splits at the front

  const asp = lerp(f.rd / Math.max(1e-6, f.rw), 1.0, 0.45);
  const rTop = f.rw * 1.04 + 0.022 * u;
  const rHem = M.torsoR(0.07) * (2.05 + (M.digitigrade ? 0.15 : 0));

  const robe = surface(28, 12, (uu, vv, out) => {
    const th = TAU * uu + Math.PI * 0.5;
    const y = lerp(topY, hemY, Math.pow(vv, 0.94));
    let r = lerp(rTop, rHem, Math.pow(vv, 1.65));
    const fold = 1 + 0.075 * Math.sin(uu * TAU * folds) * smooth(vv * 1.3) +
                 0.035 * Math.sin(uu * TAU * folds * 2 + 1.1) * vv;
    r *= fold;
    // front slit pulls the hem back
    const front = Math.max(0, Math.sin(th));
    const cut = slit * Math.pow(front, 6) * vv;
    out.set(
      f.p.x + f.right.x * r * Math.cos(th) + f.fwd.x * r * asp * Math.sin(th) * (1 - cut * 0.5),
      y + cut * M.H * 0.16,
      f.p.z + f.right.z * r * Math.cos(th) + f.fwd.z * r * asp * Math.sin(th) * (1 - cut * 0.5)
    );
  }, {
    closedU: true,
    trim: (uu, vv) => Math.max(
      1 - smooth((1 - vv) / 0.055),
      trimFn(uu, 1 - vv) * 0.55,
      Math.pow(Math.abs(Math.sin(uu * TAU * folds * 0.5)), 18) * 0.5 * vv
    )
  });
  part.add(shell(robe, 0.010 * u));
  return part;
}

/** Monk: wide waist wrap with two long tails. */
function skirtSash(ctx) {
  const { M, A } = ctx;
  const part = new Part('sash');
  const u = M.u;
  const f = hipFrame(M);
  const rw = f.rw * 1.04 + 0.014 * u;
  const rd = f.rd * 1.04 + 0.012 * u;
  const h = M.hipR * 0.9;
  const trimFn = trimFor(A.trim);

  const band = surface(24, 5, (uu, vv, out) => {
    const th = TAU * uu + Math.PI * 0.5;
    const wobble = 1 + 0.05 * Math.sin(uu * TAU * 4 + vv * 2.0);
    const r = rw * wobble * (1 + 0.06 * Math.sin(vv * Math.PI));
    out.set(
      f.p.x + f.right.x * r * Math.cos(th) + f.fwd.x * rd * wobble * Math.sin(th),
      f.p.y + h * (0.55 - vv) - Math.sin(uu * TAU * 3) * 0.012 * u,
      f.p.z + f.right.z * r * Math.cos(th) + f.fwd.z * rd * wobble * Math.sin(th)
    );
  }, { closedU: true, trim: (uu, vv) => Math.max(trimFn(uu, vv) * 0.7, 1 - smooth(Math.abs(vv - 0.5) / 0.5)) * 0.8 });
  part.add(band);

  // knot
  const knotP = f.p.clone().addScaledVector(f.fwd, rd * 1.02).addScaledVector(f.right, -f.rw * 0.42);
  const knot = new THREE.SphereGeometry(M.hipR * 0.22, 8, 6);
  part.add(knot, trs(knotP, new THREE.Euler(0, 0, 0.5), V3(1.3, 0.85, 0.8)), 0.5);

  // two hanging tails
  for (const s of [0, 1]) {
    const off = s ? -0.10 : 0.10;
    const len = M.H * (s ? 0.26 : 0.32);
    const tail = surface(4, 9, (uu, vv, out) => {
      const w = M.hipR * 0.42 * (1 - 0.35 * vv);
      const swayX = Math.sin(vv * 2.4 + s) * 0.045 * u;
      const swayZ = Math.sin(vv * 3.1 + s * 2) * 0.030 * u;
      out.set(
        knotP.x + (uu - 0.5) * 2 * w + swayX + off * M.hipR,
        knotP.y - len * vv,
        knotP.z + swayZ + Math.sin(uu * Math.PI) * 0.012 * u
      );
    }, { trim: (uu, vv) => Math.max(1 - smooth(Math.min(uu, 1 - uu) / 0.14), 1 - smooth((1 - vv) / 0.10)) * 0.9 });
    part.add(shell(tail, 0.006 * u));
  }
  return part;
}

// ---------------------------------------------------------------------------
// bracers
// ---------------------------------------------------------------------------

function buildBracers(ctx) {
  const { M, A } = ctx;
  const part = new Part('bracers');
  const u = M.u;
  const T = TIER_SHAPE[A.tier] || TIER_SHAPE.plate;

  for (const h of M.hands) {
    const sh = M.shoulders.find((s) => s.side === h.side) || M.shoulders[0];
    // The shoulder JOINT sits inside the deltoid, so a straight line from it to
    // the hand runs a good 3 cm inboard of the limb the body actually lofted,
    // and the old bracer had to be inflated to a 16 cm-wide tube just to
    // swallow that error. Start the arm axis at the outside of the deltoid
    // instead and the sleeve can hug the forearm.
    const root = sh.p.clone().addScaledVector(V3(h.side, 0, 0), sh.r * 0.55);
    const dir = h.p.clone().sub(root);
    const armLen = dir.length() || M.H * 0.4;
    dir.normalize();
    const wrist = h.p.clone().addScaledVector(dir, -h.r * 1.15);
    const elbow = root.clone().addScaledVector(dir, armLen * 0.52);
    const pts = [];
    const segs = 5;
    for (let i = 0; i <= segs; i++) pts.push(elbow.clone().lerp(wrist, i / segs));
    // `h.r` is the HAND radius, which is noticeably fatter than the wrist it
    // hangs off; taking it as the cuff radius is what made the vambraces read
    // as drainpipes. Both radii are now fractions of it that land a centimetre
    // clear of the lofted forearm.
    const rWrist = h.r * 0.82 + T.offset * u * 0.22;
    const rElbow = h.r * 1.06 * lerp(1, M.armThick, 0.4) + T.offset * u * 0.30;

    const flareTop = A.tier === 'plate' ? 1.18 : A.tier === 'cloth' ? 1.28 : 1.08;
    const bracer = sweep(framesAlong(pts, V3(h.side, 0, 0)), ellipse(12, 1, 0.90), {
      capStart: false, capEnd: false,
      scale: (t) => {
        const r = lerp(rElbow * flareTop, rWrist, smooth(Math.pow(t, 0.8)));
        return [r, r];
      },
      // Banded cuffs at both ends. The generic trim function's `u` means
      // "around the piece"; here `s` runs around a 12-sided section, which is
      // not the same coordinate, so feeding it in only invents stripes.
      trim: (s, t) => Math.max(1 - smooth(t / 0.12), 1 - smooth((1 - t) / 0.10)),
      crease: T.crease
    });
    part.add(bracer);

    if (A.tier === 'leather' || A.tier === 'mail') {
      // wrap bands
      for (let k = 0; k < 3; k++) {
        const t = 0.18 + k * 0.30;
        const c = elbow.clone().lerp(wrist, t);
        const r = lerp(rElbow, rWrist, t) * 1.10;
        const ring = new THREE.TorusGeometry(r, 0.010 * u, 4, 10);
        const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), dir);
        const m = mat().compose(c, q, V3(1, 1, 1));
        part.add(ring, m, 0.75);
      }
    } else if (A.tier === 'plate') {
      // Elbow cop. Same rule as the poleyn: the dome's rim has to sit *inside*
      // the vambrace and its crown *outside*, or the silhouette is a flat slab
      // cantilevered off the arm. Its axis (local +y) is the outboard
      // direction, so that is the axis that has to be the long one.
      const cop = new THREE.SphereGeometry(rElbow * 0.98, 8, 6, 0, TAU, 0, Math.PI * 0.54);
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(h.side, 0.15, -0.1).normalize());
      const m = mat().compose(elbow.clone().addScaledVector(dir, rElbow * 0.20), q, V3(0.95, 1.42, 1.05));
      part.add(facet(cop), m, 0.35);
    }
  }
  return part;
}

// ---------------------------------------------------------------------------
// boots
// ---------------------------------------------------------------------------

function buildBoots(ctx) {
  const { M, A } = ctx;
  const part = new Part('boots');
  const u = M.u;
  const T = TIER_SHAPE[A.tier] || TIER_SHAPE.plate;
  const hoof = M.digitigrade && (M.race === 'Tauren' || M.race === 'Draenei');

  for (const f of M.feet) {
    const soleY = Math.max(0, f.p.y - 0.01 * u);
    const footLen = M.H * 0.135 * (0.85 + 0.20 * M.legThick);
    // half-width of the boot; every radius below is a true radius. body.js
    // reports a foot radius — prefer it, since it already knows about hooves.
    const legR = f.r > 0 ? f.r : M.H * 0.033 * lerp(1, M.legThick, 0.6);
    const footW = legR * 1.08 + T.offset * u * 0.28;
    // Ankle and calf are NOT the foot. The greave used to be `footW * 1.34`,
    // i.e. a 20 cm-wide tube wrapped around a 7 cm shin, which is why the boots
    // read as two blobs stuck on the ends of the legs. A foot is roughly twice
    // as wide as the ankle it stands on and half again as wide as the calf, so
    // the shaft radii below are fractions of the reported foot half-width and
    // the greave sits ~1.5 cm proud of the leg instead of 5 cm.
    const ankleR = legR * (hoof ? 1.06 : 0.66);
    const calfR = legR * (hoof ? 1.18 : 0.95);
    const ankleH = M.H * 0.042 * (hoof ? 1.15 : 1.0);
    const shaftTop = soleY + M.H * (A.tier === 'cloth' ? 0.075 : hoof ? 0.10 : 0.16) * (0.85 + 0.3 * M.legThick);

    if (!hoof) {
      // foot: swept from heel to toe with a flat sole
      const z0 = f.p.z - footLen * 0.36, z1 = f.p.z + footLen * 0.64;
      const fr = [];
      const steps = 6;
      for (let i = 0; i <= steps; i++) fr.push(V3(f.p.x, soleY, lerp(z0, z1, i / steps)));
      const foot = sweep(framesAlong(fr, V3(1, 0, 0)), roundRect(1, 1, 0.28), {
        capStart: true, capEnd: true,
        scale: (t) => {
          // section is a unit rounded rect (half-extent 0.5), so pass full sizes
          const w = 2 * footW * profile(t, [[0, 0.72], [0.30, 1.0], [0.72, 1.0], [1, 0.62]]);
          const hgt = ankleH * profile(t, [[0, 1.25], [0.35, 0.95], [0.75, 0.72], [1, 0.48]]);
          return [w, hgt];
        },
        offset: (t) => [0, ankleH * profile(t, [[0, 1.25], [0.35, 0.95], [0.75, 0.72], [1, 0.48]]) * 0.5],
        // toe cap only — the sabaton's own edges are real geometry, not mask
        trim: (s, t) => (1 - smooth((1 - t) / 0.14)) * (A.tier === 'plate' ? 0.95 : 0.4),
        // low crease angle: the sole and the two side panels have to stay flat
        // and meet at a hard edge, or a rounded-rect sweep shades as a lozenge
        crease: 34
      });
      part.add(foot);
    }

    // shaft
    const pts = [];
    const sSteps = 5;
    const ankleY = soleY + ankleH * (hoof ? 0.5 : 0.9);
    for (let i = 0; i <= sSteps; i++) {
      const t = i / sSteps;
      pts.push(V3(f.p.x, lerp(ankleY, shaftTop, t), f.p.z + (hoof ? 0.01 * u : -footLen * 0.06 * t)));
    }
    const rBase = ankleR;
    const rTop = calfR * (A.tier === 'plate' ? 1.22 : A.tier === 'cloth' ? 1.38 : 1.10);
    const shaft = sweep(framesAlong(pts, V3(1, 0, 0)), ellipse(14, 1, 1.06), {
      capStart: false, capEnd: false,
      scale: (t) => {
        const r = lerp(rBase, rTop, smooth(Math.pow(t, 0.75)));
        return [r, r];
      },
      trim: (s, t) => Math.max(1 - smooth((1 - t) / 0.14), (1 - smooth(t / 0.10)) * 0.7),
      crease: T.crease
    });
    part.add(shaft);

    if (A.tier === 'plate') {
      // poleyn capping the greave. Rim tucked inside the shaft, crown standing
      // proud of it — a dome wider than the tube it sits on reads as a paddle
      // bolted to the side of the leg, not as a knee cop.
      const cop = new THREE.SphereGeometry(rTop * 0.88, 8, 6, 0, TAU, 0, Math.PI * 0.58);
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3(0, 0.35, 1).normalize());
      const cy = Math.max(shaftTop - rTop * 0.20, soleY + rTop * 1.05);
      part.add(facet(cop), mat().compose(V3(f.p.x, cy, f.p.z + rTop * 0.22), q, V3(1, 1.15, 0.9)), 0.5);
    } else if (A.tier === 'leather' || A.tier === 'mail') {
      for (let k = 0; k < 2; k++) {
        const y = lerp(ankleY, shaftTop, 0.35 + k * 0.42);
        const r = lerp(rBase, rTop, 0.35 + k * 0.42) * 1.1;
        const ring = new THREE.TorusGeometry(r, 0.011 * u, 4, 10);
        part.add(ring, trs(V3(f.p.x, y, f.p.z), new THREE.Euler(Math.PI * 0.5, 0, 0), V3(1, 1, 1)), 0.8);
      }
    }
  }
  return part;
}

// ---------------------------------------------------------------------------
// cape
// ---------------------------------------------------------------------------

function buildCape(ctx) {
  const { M, A } = ctx;
  const part = new Part('cape');
  const u = M.u;
  const trimFn = trimFor(A.trim);
  const top = M.frameAt(0.94);
  const anchorY = Math.min(M.shoulderY - M.shoulderR * 0.25, top.p.y);
  const backZ = top.p.z - (M.torsoR(0.92) * M.torsoAspect(0.92) * M.torsoBack(0.92) + M.hump(0.92, 1)) - 0.022 * u;

  const tattered = A.tier === 'cloth';
  const short = A.tier === 'leather';
  const len = M.H * (short ? 0.42 : tattered ? 0.62 : 0.66);
  const spanTop = M.shoulderX * (short ? 0.95 : 1.48);
  const wrap = 0.85;   // radians of curl around the back

  const capeGeo = surface(16, 18, (uu, vv, out) => {
    // jagged / tattered hem shortens the fall per column
    const jag = tattered
      ? 1 - 0.28 * Math.pow(0.5 + 0.5 * Math.sin(uu * TAU * 3.5 + 1.7), 2)
      : short ? 1 - 0.06 * Math.pow(Math.abs(uu - 0.5) * 2, 2) : 1 - 0.10 * Math.pow(Math.abs(uu * 2 - 1), 3);
    const vv2 = vv * jag;
    // width: narrow at the neck, widest at mid-fall, tapering to the hem
    const halfW = spanTop * profile(vv, [[0, 0.62], [0.18, 0.86], [0.55, 1.06], [1, 0.90]]);
    const a = (uu - 0.5) * 2 * wrap;
    const x = Math.sin(a) / Math.sin(wrap) * halfW;
    // curl around the back near the shoulders, drifting away lower down
    const curl = (Math.cos(a) - Math.cos(wrap)) / (1 - Math.cos(wrap));
    const away = 0.075 * u + M.H * 0.055 * Math.pow(smooth(vv), 1.6);
    const folds = Math.sin(uu * TAU * 3.0 + vv * 1.2) * 0.020 * u * smooth(vv * 1.6);
    const y = anchorY - len * vv2 + Math.abs(x) * 0.06 * (1 - vv);
    const z = backZ - curl * M.chestW * 0.50 * (1 - 0.55 * smooth(vv)) - away * (0.4 + 0.6 * vv) + folds;
    out.set(top.p.x + x, y, z);
  }, {
    flip: true,
    trim: (uu, vv) => Math.max(
      1 - smooth(Math.min(uu, 1 - uu) / 0.075),
      1 - smooth((1 - vv) / 0.055),
      trimFn(uu, vv) * 0.5
    )
  });
  part.add(shell(capeGeo, 0.006 * u));

  // clasp: a bar across the shoulders with two bosses
  const barPts = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    barPts.push(V3(
      top.p.x + lerp(-1, 1, t) * spanTop * 0.66,
      anchorY + M.shoulderR * 0.10 - Math.pow(Math.abs(t - 0.5) * 2, 2) * M.shoulderR * 0.18,
      backZ + M.chestW * 0.30 * (1 - Math.pow(Math.abs(t - 0.5) * 2, 2))
    ));
  }
  const bar = sweep(framesAlong(barPts, V3(0, 1, 0)), roundRect(0.030 * u, 0.016 * u, 0.006 * u), {
    capStart: true, capEnd: true, trim: () => 1.0
  });
  part.add(bar);
  for (const s of [1, -1]) {
    const boss = new THREE.SphereGeometry(M.shoulderR * 0.30, 8, 6);
    part.add(boss, trs(
      V3(top.p.x + s * spanTop * 0.66, anchorY + M.shoulderR * 0.10, backZ + M.chestW * 0.10),
      new THREE.Euler(0, 0, 0), V3(1, 1, 0.6)
    ), 1.0);
  }
  return part;
}

// ---------------------------------------------------------------------------
// pauldrons — thirteen distinct constructions
// ---------------------------------------------------------------------------

/**
 * Every builder works in canonical right-shoulder space:
 *   origin = shoulder joint, +X outboard, +Y up, +Z forward.
 * `S` is the working size (already folded through pauldronScale).
 */

function dome(S, opts = {}) {
  const {
    rx = 1, ry = 1, rz = 1, uSteps = 14, vSteps = 6,
    cut = 0.62, flat = false, trim = null, squash = 0
  } = opts;
  return surface(uSteps, vSteps, (uu, vv, out) => {
    const phi = lerp(Math.PI * cut, 0, vv);
    const th = TAU * uu + Math.PI * 0.5;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const flatten = 1 - squash * Math.pow(sp, 2);
    out.set(S * rx * sp * Math.cos(th), S * ry * cp * flatten, S * rz * sp * Math.sin(th));
  }, { closedU: true, flat, trim });
}

function baseCap(part, S, tier, trimFn, flat) {
  const g = dome(S, {
    rx: 1.0, ry: 0.86, rz: 1.12, cut: 0.60, flat,
    uSteps: 14, vSteps: 5,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.10))
  });
  part.add(g, trs(V3(S * 0.32, S * 0.10, 0), new THREE.Euler(0, 0, -0.55), V3(1, 1, 1)));
  void tier;
}

function pyramidSpike(len, base, sides = 4) {
  const g = new THREE.ConeGeometry(base, len, sides, 1, false);
  g.translate(0, len * 0.5, 0);
  return facet(g);
}

/** Warrior: angular plate + protruding spikes. */
function pauldronSpiked(part, S, ctx, trimFn) {
  const plate = dome(S, {
    rx: 1.05, ry: 0.95, rz: 1.18, cut: 0.58, flat: true, uSteps: 8, vSteps: 4,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.14))
  });
  part.add(plate, trs(V3(S * 0.34, S * 0.06, 0), new THREE.Euler(0, 0, -0.52), V3(1, 1, 1)));
  // rim band
  const rim = new THREE.TorusGeometry(S * 0.99, S * 0.075, 4, 9);
  part.add(rim, trs(V3(S * 0.30, S * 0.02, 0), new THREE.Euler(Math.PI * 0.5, 0, -0.52), V3(1, 1, 1.10)), 1.0);
  // spikes
  const spikes = [
    { p: V3(S * 0.72, S * 0.72, S * 0.10), e: new THREE.Euler(-0.15, 0, -0.55), s: 1.0 },
    { p: V3(S * 0.95, S * 0.36, S * 0.52), e: new THREE.Euler(0.55, 0, -0.95), s: 0.78 },
    { p: V3(S * 0.95, S * 0.36, -S * 0.52), e: new THREE.Euler(-0.55, 0, -0.95), s: 0.78 },
    { p: V3(S * 1.02, S * 0.02, 0), e: new THREE.Euler(0, 0, -1.35), s: 0.62 }
  ];
  for (const sp of spikes) {
    part.add(pyramidSpike(S * 1.05 * sp.s, S * 0.20 * sp.s, 4), trs(sp.p, sp.e, V3(1, 1, 1)), 0.55);
  }
}

/** Paladin: broad upswept wing plates. */
function pauldronWinged(part, S, ctx, trimFn) {
  baseCap(part, S * 0.86, ctx.tier, trimFn, true);
  for (let w = 0; w < 2; w++) {
    const back = w === 1;
    const geo = surface(6, 8, (uu, vv, out) => {
      // uu across the wing chord, vv along the span (root -> tip)
      const span = S * (2.05 - w * 0.45);
      const chord = S * (0.86 - 0.55 * Math.pow(vv, 1.4)) * (1 - w * 0.18);
      const rise = Math.pow(vv, 1.35);
      const x = S * 0.28 + span * 0.52 * vv;
      const y = S * 0.16 + span * 0.72 * rise;
      const z = (uu - 0.5) * chord - (back ? S * 0.42 : -S * 0.10) - vv * S * 0.30;
      const sweepBack = -vv * S * 0.28;
      const camber = Math.sin(uu * Math.PI) * S * 0.11 * (1 - vv * 0.5);
      out.set(x + camber, y, z + sweepBack);
    }, {
      trim: (uu, vv) => Math.max(
        1 - smooth(Math.min(uu, 1 - uu) / 0.16),
        1 - smooth((1 - vv) / 0.16),
        trimFn(uu, vv) * 0.7
      )
    });
    part.add(shell(geo, S * 0.055));
  }
}

/** Hunter: rounded cap under a ruff of fur clumps. */
function pauldronFur(part, S, ctx, trimFn) {
  const cap = dome(S * 0.92, {
    rx: 1.0, ry: 0.95, rz: 1.10, cut: 0.55, uSteps: 12, vSteps: 5,
    trim: (uu, vv) => trimFn(uu, vv) * 0.6
  });
  part.add(cap, trs(V3(S * 0.30, S * 0.14, 0), new THREE.Euler(0, 0, -0.48), V3(1, 1, 1)));
  const rand = ctx.rand;
  const rings = [
    { n: 14, r: 1.02, y: 0.06, tilt: 1.15, len: 0.60 },
    { n: 11, r: 0.88, y: 0.34, tilt: 0.75, len: 0.50 },
    { n: 8, r: 0.62, y: 0.60, tilt: 0.35, len: 0.40 }
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.n; i++) {
      const a = TAU * (i + rand() * 0.4) / ring.n;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = S * 0.30 + S * ring.r * 0.55 * Math.abs(ca) * 0.4 + S * 0.55 * ring.r * 0.6;
      const p = V3(px, S * (ring.y + 0.10), S * ring.r * 1.05 * sa);
      p.x = S * (0.26 + ring.r * 0.55 * Math.max(0, ca) * 0.6 + 0.30);
      const len = S * ring.len * (0.75 + rand() * 0.6);
      const tuft = new THREE.ConeGeometry(S * 0.17 * (0.7 + rand() * 0.6), len, 5, 2, true);
      tuft.translate(0, len * 0.45, 0);
      const e = new THREE.Euler(
        (rand() - 0.5) * 0.5 - sa * 0.5,
        a,
        -ring.tilt - (rand() - 0.5) * 0.35
      );
      part.add(facet(tuft), trs(p, e, V3(1, 1, 1)), 0.12);
    }
  }
}

/** Rogue: minimal cap hugging the deltoid. */
function pauldronLow(part, S, ctx, trimFn) {
  const cap = dome(S * 0.86, {
    rx: 1.0, ry: 0.60, rz: 1.15, cut: 0.50, uSteps: 12, vSteps: 4, squash: 0.20,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.12))
  });
  part.add(cap, trs(V3(S * 0.18, S * 0.10, 0), new THREE.Euler(0, 0, -0.30), V3(1, 1, 1)));
  // stitched edge strap + buckle
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const a = lerp(-1.15, 1.15, i / 8);
    pts.push(V3(S * (0.20 + 0.62 * Math.cos(a) * 0.35), S * (0.06 - 0.10 * Math.abs(a) * 0.3), S * 0.92 * Math.sin(a)));
  }
  const strap = sweep(framesAlong(pts, V3(0, 1, 0)), roundRect(S * 0.20, S * 0.07, S * 0.02), {
    capStart: true, capEnd: true, trim: () => 0.7
  });
  part.add(strap);
  const buckle = new THREE.BoxGeometry(S * 0.12, S * 0.16, S * 0.16);
  part.add(buckle, place(S * 0.52, S * 0.02, S * 0.30), 1.0);
}

/** Priest: soft cloth cap falling into a draped panel. */
function pauldronDraped(part, S, ctx, trimFn) {
  const cap = dome(S * 0.90, {
    rx: 1.0, ry: 0.78, rz: 1.12, cut: 0.52, uSteps: 12, vSteps: 5,
    trim: (uu, vv) => trimFn(uu, vv) * 0.8
  });
  part.add(cap, trs(V3(S * 0.24, S * 0.14, 0), new THREE.Euler(0, 0, -0.42), V3(1, 1, 1)));
  const drape = surface(9, 9, (uu, vv, out) => {
    const a = lerp(-1.5, 1.5, uu);                       // front .. back around the arm
    const r = S * (0.95 + 0.20 * vv);
    const fall = S * 1.95 * Math.pow(vv, 1.05);
    const wave = Math.sin(uu * TAU * 2.0 + vv * 1.4) * S * 0.10 * smooth(vv);
    const hemDip = Math.pow(Math.sin(uu * Math.PI), 0.6);
    out.set(
      S * 0.26 + r * 0.82 * Math.cos(a * 0.55) + wave * 0.4,
      S * 0.08 - fall * (0.75 + 0.35 * hemDip),
      r * Math.sin(a) + wave
    );
  }, {
    flip: true,
    trim: (uu, vv) => Math.max(
      1 - smooth((1 - vv) / 0.10),
      1 - smooth(Math.min(uu, 1 - uu) / 0.10),
      trimFn(uu, vv) * 0.6
    )
  });
  part.add(shell(drape, S * 0.035));
}

/** Shaman: stacked carved rings with hanging fetishes. */
function pauldronTotemic(part, S, ctx, trimFn) {
  const rand = ctx.rand;
  const tiers = [
    { r: 1.00, h: 0.34, y: 0.00, n: 9 },
    { r: 0.80, h: 0.30, y: 0.40, n: 8 },
    { r: 0.58, h: 0.26, y: 0.74, n: 7 }
  ];
  for (const t of tiers) {
    const g = surface(t.n, 3, (uu, vv, out) => {
      const th = TAU * uu + Math.PI * 0.5;
      const carve = 1 + 0.12 * Math.cos(uu * TAU * t.n) * (1 - Math.abs(vv - 0.5) * 1.2);
      const r = S * t.r * carve * (1 - 0.10 * Math.abs(vv - 0.5));
      out.set(
        S * 0.28 + r * 0.42 * Math.cos(th) * 0.55,
        S * (t.y + t.h * (vv - 0.5)) + S * 0.10,
        r * Math.sin(th) * 1.0
      );
    }, {
      closedU: true, flat: true,
      trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(Math.abs(vv - 0.5) / 0.22) * 0.6)
    });
    // widen along X so the rings read as stacked discs around the arm
    part.add(g, trs(V3(0, 0, 0), new THREE.Euler(0, 0, -0.30), V3(1.7, 1, 1)));
  }
  // carved crown pin
  part.add(pyramidSpike(S * 0.60, S * 0.16, 6), trs(V3(S * 0.22, S * 1.00, 0), new THREE.Euler(0, 0, -0.28), V3(1, 1, 1)), 0.9);
  // hanging fetishes: cord + bone/feather
  for (let i = 0; i < 4; i++) {
    const a = lerp(-1.1, 1.1, i / 3) + (rand() - 0.5) * 0.2;
    const anchor = V3(S * 0.34, -S * 0.14, S * 0.95 * Math.sin(a));
    anchor.x += S * 0.25 * Math.cos(a);
    const drop = S * (0.75 + rand() * 0.55);
    const pts = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      pts.push(anchor.clone().add(V3(Math.sin(t * 2.0) * S * 0.05, -drop * t, Math.sin(t * 1.4 + i) * S * 0.06)));
    }
    part.add(sweep(framesAlong(pts, V3(1, 0, 0)), ellipse(4, S * 0.030, S * 0.030), { trim: () => 0.2 }));
    const end = pts[pts.length - 1];
    if (i % 2 === 0) {
      const bone = new THREE.CylinderGeometry(S * 0.055, S * 0.045, S * 0.42, 5, 1);
      part.add(facet(bone), trs(end.clone().add(V3(0, -S * 0.20, 0)), new THREE.Euler(0, 0, (rand() - 0.5) * 0.4), V3(1, 1, 1)), 0.9);
    } else {
      const feather = surface(2, 4, (uu, vv, out) => {
        out.set(
          (uu - 0.5) * S * 0.20 * Math.sin(vv * Math.PI),
          -S * 0.48 * vv,
          (uu - 0.5) * S * 0.05
        );
      }, { flip: true, trim: () => 0.85 });
      part.add(shell(feather, S * 0.012), trs(end, new THREE.Euler((rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3), V3(1, 1, 1)));
    }
  }
}

/** Mage: detached geometric shards hovering off the shoulder. */
function pauldronFloating(part, S, ctx, trimFn) {
  const rand = ctx.rand;
  // thin cloth shoulder beneath the shards
  const cap = dome(S * 0.72, {
    rx: 1.0, ry: 0.62, rz: 1.10, cut: 0.48, uSteps: 10, vSteps: 3,
    trim: (uu, vv) => trimFn(uu, vv) * 0.7
  });
  part.add(cap, trs(V3(S * 0.16, S * 0.08, 0), new THREE.Euler(0, 0, -0.30), V3(1, 1, 1)));

  const shards = 5;
  for (let i = 0; i < shards; i++) {
    const t = i / (shards - 1);
    const a = lerp(-0.75, 0.85, t) + (rand() - 0.5) * 0.15;
    const rad = S * (0.95 + 0.55 * Math.sin(t * Math.PI));
    const p = V3(
      S * 0.42 + rad * 0.55 * Math.cos(a * 0.6),
      S * (0.45 + 1.25 * t) + Math.sin(i * 2.1) * S * 0.12,
      rad * 0.80 * Math.sin(a)
    );
    const g = new THREE.OctahedronGeometry(S * (0.46 - 0.13 * t), 0);
    const e = new THREE.Euler(rand() * TAU, rand() * TAU, rand() * TAU);
    part.add(facet(g), trs(p, e, V3(0.40, 1.75 - 0.40 * t, 0.40)), 1.0);
  }
  // small rune ring orbiting the lowest shard
  const ring = new THREE.TorusGeometry(S * 0.42, S * 0.038, 4, 10);
  part.add(facet(ring), trs(V3(S * 0.50, S * 0.42, S * 0.30), new THREE.Euler(0.9, 0.4, -0.5), V3(1, 1, 1)), 1.0);
}

/** Warlock: curved backswept horns off a low mantle. */
function pauldronHorned(part, S, ctx, trimFn) {
  const cap = dome(S * 0.88, {
    rx: 1.0, ry: 0.74, rz: 1.14, cut: 0.54, uSteps: 12, vSteps: 4,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.12))
  });
  part.add(cap, trs(V3(S * 0.26, S * 0.10, 0), new THREE.Euler(0, 0, -0.44), V3(1, 1, 1)));
  const horns = [
    { root: V3(S * 0.55, S * 0.45, S * 0.30), len: 2.10, curl: 1.35, thick: 0.20 },
    { root: V3(S * 0.62, S * 0.20, -S * 0.34), len: 1.55, curl: 1.05, thick: 0.15 }
  ];
  for (const h of horns) {
    const pts = [];
    const steps = 7;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = h.curl * Math.pow(t, 1.25);
      pts.push(V3(
        h.root.x + S * h.len * 0.30 * Math.sin(ang * 0.7) + S * h.len * 0.16 * t,
        h.root.y + S * h.len * 0.62 * Math.sin(ang * 0.85 + 0.15) / Math.max(0.4, ang * 0.85 + 0.15) * t * 1.4,
        h.root.z - S * h.len * 0.66 * Math.pow(t, 1.5)
      ));
    }
    const horn = sweep(framesAlong(pts, V3(1, 0, 0)), ellipse(6, 1, 0.86), {
      capStart: true, capEnd: true,
      scale: (t) => {
        const r = S * h.thick * (1 - 0.86 * Math.pow(t, 0.9));
        return [r, r];
      },
      trim: (s, t) => Math.max(t * t * 0.9, Math.pow(Math.abs(Math.sin(t * 9 * Math.PI)), 12) * 0.8),
      flat: true
    });
    part.add(horn);
  }
}

/** Monk: overlapping cloth wrap bands. */
function pauldronWrapped(part, S, ctx, trimFn) {
  const bands = [
    { y: -0.10, r: 1.00, w: 0.34, tilt: -0.10, phase: 0.0 },
    { y: 0.26, r: 0.94, w: 0.30, tilt: 0.16, phase: 0.8 },
    { y: 0.58, r: 0.80, w: 0.26, tilt: 0.34, phase: 1.6 },
    { y: 0.84, r: 0.60, w: 0.22, tilt: 0.52, phase: 2.4 }
  ];
  for (const b of bands) {
    const g = surface(12, 3, (uu, vv, out) => {
      const th = TAU * uu + Math.PI * 0.5;
      const slack = 1 + 0.10 * Math.sin(uu * TAU * 2 + b.phase) * (1 - Math.abs(vv - 0.5));
      const r = S * b.r * slack;
      out.set(
        S * 0.26 + r * 0.30 * Math.cos(th) + S * b.w * 0.9 * (vv - 0.5) * 1.4,
        S * b.y + S * b.w * (vv - 0.5) * Math.cos(b.tilt) * 0.6,
        r * Math.sin(th) * 1.0
      );
    }, {
      closedU: true,
      trim: (uu, vv) => Math.max(
        1 - smooth(Math.abs(vv - 0.5) / 0.16) * 0.8,
        trimFn(uu, vv) * 0.8
      )
    });
    part.add(g, trs(V3(0, 0, 0), new THREE.Euler(0, 0, -0.34), V3(1.5, 1, 1)));
  }
  // loose wrap tail
  const tail = surface(3, 6, (uu, vv, out) => {
    out.set(
      S * (0.55 + 0.30 * vv) + (uu - 0.5) * S * 0.30,
      S * (0.05 - 1.15 * vv) + Math.sin(vv * 3.0) * S * 0.08,
      S * (0.80 + 0.25 * Math.sin(vv * 2.6)) + (uu - 0.5) * S * 0.10
    );
  }, { flip: true, trim: (uu, vv) => Math.max(1 - smooth((1 - vv) / 0.16), 1 - smooth(Math.min(uu, 1 - uu) / 0.18)) * 0.85 });
  part.add(shell(tail, S * 0.022));
}

/** Druid: branching antlers rooted in a leather cap. */
function pauldronAntlered(part, S, ctx, trimFn) {
  const cap = dome(S * 0.82, {
    rx: 1.0, ry: 0.70, rz: 1.10, cut: 0.52, uSteps: 11, vSteps: 4,
    trim: (uu, vv) => trimFn(uu, vv) * 0.7
  });
  part.add(cap, trs(V3(S * 0.24, S * 0.10, 0), new THREE.Euler(0, 0, -0.40), V3(1, 1, 1)));

  const rand = ctx.rand;
  const branch = (root, dir, len, rad, depth) => {
    const pts = [];
    const steps = 5;
    const bend = V3((rand() - 0.5) * 0.5, 0.55 + rand() * 0.4, (rand() - 0.5) * 0.6).normalize();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push(root.clone()
        .addScaledVector(dir, len * t)
        .addScaledVector(bend, len * 0.28 * t * t));
    }
    part.add(sweep(framesAlong(pts, V3(1, 0, 0)), ellipse(5, 1, 0.9), {
      capStart: true, capEnd: true,
      scale: (t) => { const r = rad * (1 - 0.78 * t); return [r, r]; },
      trim: (s, t) => Math.max(0.15, t * 0.8),
      flat: true
    }));
    if (depth <= 0) return;
    const forks = depth === 2 ? 2 : 1;
    for (let k = 0; k < forks; k++) {
      const at = 0.45 + 0.25 * k + rand() * 0.12;
      const idx = Math.min(pts.length - 2, Math.floor(at * steps));
      const nd = dir.clone()
        .addScaledVector(V3(0, 1, 0), 0.55 + rand() * 0.4)
        .addScaledVector(V3(0, 0, k ? 1 : -1), 0.55 + rand() * 0.5)
        .addScaledVector(V3(1, 0, 0), (rand() - 0.3) * 0.4)
        .normalize();
      branch(pts[idx], nd, len * (0.52 + rand() * 0.16), rad * 0.62, depth - 1);
    }
  };

  branch(V3(S * 0.52, S * 0.42, S * 0.24), V3(0.42, 0.86, 0.28).normalize(), S * 1.55, S * 0.15, 2);
  branch(V3(S * 0.58, S * 0.20, -S * 0.30), V3(0.55, 0.70, -0.45).normalize(), S * 1.15, S * 0.12, 1);
  void trimFn;
}

/** Demon Hunter: fanned razor blades. */
function pauldronBladed(part, S, ctx, trimFn) {
  // small mount
  const mount = dome(S * 0.58, {
    rx: 1.0, ry: 0.55, rz: 1.05, cut: 0.46, uSteps: 9, vSteps: 3, flat: true,
    trim: (uu, vv) => trimFn(uu, vv) * 0.6
  });
  part.add(mount, trs(V3(S * 0.16, S * 0.06, 0), new THREE.Euler(0, 0, -0.28), V3(1, 1, 1)));

  const blades = 3;
  for (let i = 0; i < blades; i++) {
    const t = i / (blades - 1);
    const rootA = lerp(-0.35, 0.75, t);
    const root = V3(S * 0.38 + S * 0.10 * Math.cos(rootA), S * (0.10 + 0.30 * t), S * 0.55 * Math.sin(rootA));
    const len = S * (2.05 - 0.42 * t);
    const pts = [];
    const steps = 7;
    for (let k = 0; k <= steps; k++) {
      const tt = k / steps;
      const curl = Math.pow(tt, 1.4);
      pts.push(V3(
        root.x + len * 0.34 * tt + S * 0.10 * Math.sin(curl * 2),
        root.y + len * (0.62 * tt - 0.20 * curl * curl),
        root.z - len * (0.55 * curl) - S * 0.12 * tt
      ));
    }
    const blade = sweep(framesAlong(pts, V3(0, 1, 0)), lens(1, 1), {
      capStart: true, capEnd: true,
      scale: (tt) => [S * (0.62 - 0.50 * tt * tt), S * (0.115 - 0.095 * tt)],
      trim: (s, tt) => {
        const edge = Math.abs(Math.sin(s * Math.PI));
        return clamp01(0.25 + 0.75 * Math.pow(edge, 3) + 0.5 * Math.pow(tt, 3));
      },
      flat: true
    });
    part.add(blade);
  }
}

/** Death Knight: massive layered plate with a skull boss. */
function pauldronSkulled(part, S, ctx, trimFn) {
  // two stacked plate tiers
  const lower = dome(S * 1.12, {
    rx: 1.02, ry: 0.72, rz: 1.22, cut: 0.60, flat: true, uSteps: 10, vSteps: 3,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.16))
  });
  part.add(lower, trs(V3(S * 0.34, -S * 0.14, 0), new THREE.Euler(0, 0, -0.58), V3(1, 1, 1)));
  const upper = dome(S * 0.92, {
    rx: 1.0, ry: 0.88, rz: 1.14, cut: 0.56, flat: true, uSteps: 10, vSteps: 4,
    trim: (uu, vv) => Math.max(trimFn(uu, vv), 1 - smooth(vv / 0.16))
  });
  part.add(upper, trs(V3(S * 0.40, S * 0.30, 0), new THREE.Euler(0, 0, -0.52), V3(1, 1, 1)));

  // skull boss on the outer face
  const O = V3(S * 0.92, S * 0.52, 0);
  const k = S * 0.44;
  const cran = new THREE.SphereGeometry(k, 10, 8);
  part.add(cran, trs(O.clone(), new THREE.Euler(0, 0, -0.25), V3(1.0, 1.05, 1.15)), 0.95);
  const brow = new THREE.BoxGeometry(k * 1.55, k * 0.42, k * 1.75);
  part.add(brow, trs(O.clone().add(V3(k * 0.30, k * 0.18, 0)), new THREE.Euler(0, 0, -0.30), V3(1, 1, 1)), 1.0);
  const muzzle = new THREE.CylinderGeometry(k * 0.62, k * 0.86, k * 1.05, 6, 1);
  part.add(facet(muzzle), trs(
    O.clone().add(V3(k * 0.72, -k * 0.42, 0)),
    new THREE.Euler(0, 0, Math.PI * 0.5 - 0.35), V3(1, 1, 0.85)
  ), 0.9);
  for (const s of [1, -1]) {
    const socket = new THREE.SphereGeometry(k * 0.30, 7, 5);
    part.add(socket, trs(O.clone().add(V3(k * 0.62, -k * 0.02, s * k * 0.42)), new THREE.Euler(0, 0, 0), V3(0.7, 1, 1)), 1.0);
    // small crown horn
    const hp = O.clone().add(V3(-k * 0.05, k * 0.72, s * k * 0.62));
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      pts.push(hp.clone().add(V3(-S * 0.10 * t, S * 0.62 * t, s * S * 0.26 * t * t)));
    }
    part.add(sweep(framesAlong(pts, V3(1, 0, 0)), ellipse(5, 1, 1), {
      capStart: true, capEnd: true,
      scale: (t) => { const r = S * 0.11 * (1 - 0.82 * t); return [r, r]; },
      trim: (a, t) => 0.4 + 0.6 * t, flat: true
    }));
  }
  // jaw teeth
  for (let i = 0; i < 4; i++) {
    const z = lerp(-k * 0.42, k * 0.42, i / 3);
    const tooth = pyramidSpike(k * 0.34, k * 0.11, 4);
    part.add(tooth, trs(O.clone().add(V3(k * 1.05, -k * 0.62, z)), new THREE.Euler(0, 0, Math.PI * 0.72), V3(1, 1, 1)), 1.0);
  }
  // rim spikes on the lower tier
  for (let i = 0; i < 3; i++) {
    const a = lerp(-0.9, 0.9, i / 2);
    part.add(pyramidSpike(S * 0.72, S * 0.16, 4), trs(
      V3(S * (0.70 + 0.25 * Math.cos(a)), -S * 0.30, S * 1.10 * Math.sin(a)),
      new THREE.Euler(-Math.sin(a) * 0.6, 0, -1.15),
      V3(1, 1, 1)
    ), 0.5);
  }
}

/** Evoker: overlapping dragon scales over a mail cap. */
function pauldronScaled(part, S, ctx, trimFn) {
  const cap = dome(S * 0.88, {
    rx: 1.0, ry: 0.82, rz: 1.12, cut: 0.56, uSteps: 12, vSteps: 4,
    trim: (uu, vv) => trimFn(uu, vv) * 0.6
  });
  part.add(cap, trs(V3(S * 0.28, S * 0.10, 0), new THREE.Euler(0, 0, -0.46), V3(1, 1, 1)));

  const rows = 4;
  for (let r = 0; r < rows; r++) {
    const vRow = 0.16 + r * 0.24;
    const cols = 7 - r;
    for (let c = 0; c < cols; c++) {
      const uCol = (c + 0.5 + (r % 2) * 0.5) / cols;
      const a = lerp(-1.25, 1.25, uCol);
      const phi = lerp(Math.PI * 0.52, Math.PI * 0.10, vRow);
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const base = V3(
        S * 0.28 + S * 0.94 * sp * Math.cos(a) * 0.45,
        S * (0.10 + 0.92 * cp * 0.95),
        S * 1.02 * sp * Math.sin(a)
      );
      const nrm = V3(base.x - S * 0.28, base.y - S * 0.10, base.z).normalize();
      const size = S * (0.44 - 0.07 * r);
      const scale = surface(3, 2, (uu, vv, out) => {
        const w = size * 0.62 * Math.sin(lerp(0.35, Math.PI * 0.92, 1 - vv * 0.85));
        const lift = Math.sin(vv * Math.PI * 0.8) * size * 0.22;
        out.set(
          (uu - 0.5) * 2 * w,
          -size * (vv - 0.35),
          lift
        );
      }, { flip: true, trim: (uu, vv) => Math.max(1 - smooth((1 - vv) / 0.35), 1 - smooth(Math.min(uu, 1 - uu) / 0.2)) * 0.9 });
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), nrm);
      const tilt = new THREE.Quaternion().setFromAxisAngle(V3(1, 0, 0), -0.35);
      q.multiply(tilt);
      part.add(shell(scale, size * 0.10), mat().compose(base, q, V3(1, 1, 1)));
    }
  }
}

const PAULDRONS = {
  spiked: pauldronSpiked,
  winged: pauldronWinged,
  fur: pauldronFur,
  low: pauldronLow,
  draped: pauldronDraped,
  totemic: pauldronTotemic,
  floating: pauldronFloating,
  horned: pauldronHorned,
  wrapped: pauldronWrapped,
  antlered: pauldronAntlered,
  bladed: pauldronBladed,
  skulled: pauldronSkulled,
  scaled: pauldronScaled
};

function buildPauldrons(ctx) {
  const { M, A } = ctx;
  const builder = PAULDRONS[A.pauldron] || PAULDRONS.spiked;
  const trimFn = trimFor(A.trim);
  const out = new Part('pauldrons');

  // canonical size: derived from the actual shoulder joint so races scale
  const S = M.shoulderR * 1.20 * (A.pauldronScale || 1);
  const canon = new Part('pauldron-canonical');
  builder(canon, S, { ...ctx, tier: A.tier }, trimFn);
  const geo = canon.merge();
  if (!geo) return null;

  const lean = clamp(M.posture * 0.45, -0.25, 0.30);
  for (const sh of M.shoulders) {
    const side = sh.side >= 0 ? 1 : -1;
    const g = geo.clone();
    const m = mat().makeTranslation(sh.p.x, sh.p.y, sh.p.z);
    m.multiply(mat().makeRotationX(lean));
    m.multiply(mat().makeRotationZ(-0.18 * side));
    m.multiply(mat().makeScale(side, 1, 1));
    out.add(g, m);
  }
  geo.dispose();
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const DEFAULT_ARMOR = {
  tier: 'plate', pauldron: 'spiked', pauldronScale: 1.2,
  skirt: 'tasset', cape: false, trim: 'riveted', emissive: 0.2
};

export function buildArmorSet(klass, race, joints, build, opts = {}) {
  const material = opts.material;
  if (!material) return null;

  const A = { ...DEFAULT_ARMOR, ...(klass && klass.armor ? klass.armor : {}) };
  const M = metrics(joints, build, race);
  const ctx = {
    A, M, build, race, klass,
    tier: A.tier,
    rand: rng(hashStr(`${klass?.name || 'Warrior'}|${race?.name || 'Human'}`))
  };

  const parts = [];
  const push = (fn) => {
    let p = null;
    try { p = fn(ctx); } catch (err) {
      console.warn('[armor] part failed:', err);
      return;
    }
    if (!p) return;
    const g = p.merge ? p.merge() : p;
    if (g) parts.push(g);
  };

  push(buildChest);
  push(buildBelt);
  push(buildSkirt);
  push(buildBracers);
  push(buildBoots);
  // klass.armor.cape decides whether the set has a cloak at all; the UI toggle
  // can only take it away, otherwise every class would read the same.
  if (A.cape && opts.cape !== false) push(buildCape);
  if (opts.pauldrons !== false) push(buildPauldrons);

  if (!parts.length) return null;

  let merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) {
    // merge failed (shouldn't happen — conform() normalises everything); fall
    // back to the largest single piece rather than dropping the armor.
    merged = parts[0];
  } else if (parts.length > 1) {
    for (const p of parts) p.dispose();
  }
  merged.computeBoundingSphere();
  merged.computeBoundingBox();

  const tris = triCount(merged);
  if (tris > TRI_BUDGET) {
    console.warn(`[armor] ${klass?.name}: ${Math.round(tris)} triangles exceeds the ${TRI_BUDGET} budget`);
  }

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = `armor-${(klass?.name || 'set').toLowerCase().replace(/\s+/g, '-')}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.triangles = tris;
  mesh.userData.armor = A;

  const group = new THREE.Group();
  group.name = 'armor';
  group.add(mesh);
  group.userData.triangles = tris;
  return group;
}

export default buildArmorSet;
