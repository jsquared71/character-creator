// src/ui/panels.js — the character-creation chrome.
//
// Everything visual in here is drawn at runtime: the gilt 9-slice frames, the
// parchment grain, the glyph divider rules, the slider gem, the race portraits
// and the class sigils. No image files, no webfonts, no network. Frames and
// tiles are faction-tinted from FACTIONS and retint live when the selection
// changes.
//
// State is touched *only* through the injected store.

import { FACTIONS } from '../data/races.js';

/* ------------------------------------------------------------------ *
 * colour helpers
 * ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function hex2rgb(h) {
  h = String(h || '#000').replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgb2hex(c) {
  return '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function mix(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2hex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
}

/** Positive t lightens toward white, negative darkens toward black. */
const sh = (c, t) => (t >= 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t));

function rgba(c, a) {
  const [r, g, b] = hex2rgb(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Relative luminance, used to keep class-coloured glyphs readable on stone. */
function lum(c) {
  const [r, g, b] = hex2rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Lift a colour until it reads clearly against the dark stone tiles. */
function legible(c) {
  let out = c;
  let guard = 0;
  while (lum(out) < 0.34 && guard++ < 12) out = sh(out, 0.12);
  return out;
}

/* ------------------------------------------------------------------ *
 * canvas helpers
 * ------------------------------------------------------------------ */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

function ell(g, cx, cy, rx, ry, rot = 0) {
  g.beginPath();
  g.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, Math.PI * 2);
}

const url = (c) => `url("${c.toDataURL('image/png')}")`;

/* ------------------------------------------------------------------ *
 * procedural frame art
 * ------------------------------------------------------------------ */

const GOLD_DEEP = '#231705';
const GOLD_LOW = '#7a5a1c';
const GOLD_MID = '#c8a94a';
const GOLD_HI = '#f8e9bd';

/**
 * Fills a mitred band segment with a moulding gradient so the border reads as
 * a genuinely raised, lit piece of metal rather than a coloured outline.
 * `k` biases overall brightness so the top catches light and the bottom falls
 * into shadow — the whole reason 9-slice gilt reads as 3D.
 */
function moulding(g, pts, gx0, gy0, gx1, gy1, k, tint) {
  const gr = g.createLinearGradient(gx0, gy0, gx1, gy1);
  const t = (c) => sh(mix(c, tint, 0.1), k);
  gr.addColorStop(0.0, sh(GOLD_DEEP, k * 0.4));
  gr.addColorStop(0.09, t(GOLD_HI));
  gr.addColorStop(0.24, t(GOLD_MID));
  gr.addColorStop(0.44, sh(t(GOLD_LOW), -0.08));
  gr.addColorStop(0.6, t(GOLD_MID));
  gr.addColorStop(0.78, t(sh(GOLD_HI, -0.06)));
  gr.addColorStop(0.92, sh(t(GOLD_LOW), -0.22));
  gr.addColorStop(1.0, sh(GOLD_DEEP, k * 0.3 - 0.1));
  g.fillStyle = gr;
  poly(g, pts);
  g.fill();
}

function boss(g, cx, cy, r, tint, glow) {
  const gr = g.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  gr.addColorStop(0, GOLD_HI);
  gr.addColorStop(0.45, GOLD_MID);
  gr.addColorStop(0.8, GOLD_LOW);
  gr.addColorStop(1, GOLD_DEEP);
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = gr;
  g.fill();
  g.lineWidth = Math.max(1, r * 0.16);
  g.strokeStyle = rgba('#000000', 0.65);
  g.stroke();

  // faceted gem centre in the faction colour
  const R = r * 0.44;
  poly(g, [[cx, cy - R], [cx + R, cy], [cx, cy + R], [cx - R, cy]]);
  const gg = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  gg.addColorStop(0, glow);
  gg.addColorStop(0.5, tint);
  gg.addColorStop(1, sh(tint, -0.45));
  g.fillStyle = gg;
  g.fill();
  g.lineWidth = Math.max(1, r * 0.1);
  g.strokeStyle = rgba(GOLD_HI, 0.7);
  g.stroke();
}

/**
 * A 9-slice gilt frame. Each edge is constant along its run so `border-image`
 * can stretch/repeat it without seams; corners carry bosses, edge midpoints
 * carry rivets which fall into a rhythm under `border-image-repeat: round`.
 */
function drawFrame(tint, glow, opt) {
  const S = opt.size;
  const B = opt.band;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const o = 1.5;
  const i0 = o + B;
  const i1 = S - o - B;

  // outer contact shadow so the frame separates from the 3D scene behind it
  g.save();
  roundRect(g, o, o, S - o * 2, S - o * 2, opt.radius);
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = B * 0.9;
  g.fillStyle = 'rgba(0,0,0,0.9)';
  g.fill();
  g.restore();

  const O = [[o, o], [S - o, o], [S - o, S - o], [o, S - o]];
  const I = [[i0, i0], [i1, i0], [i1, i1], [i0, i1]];

  moulding(g, [O[0], O[1], I[1], I[0]], 0, o, 0, i0, 0.12, tint);       // top
  moulding(g, [O[3], I[3], I[2], O[2]], 0, S - o, 0, i1, -0.3, tint);   // bottom
  moulding(g, [O[0], I[0], I[3], O[3]], o, 0, i0, 0, 0.0, tint);        // left
  moulding(g, [O[1], O[2], I[2], I[1]], S - o, 0, i1, 0, -0.18, tint);  // right

  // engraved inner channel, faction tinted
  const ch = Math.max(2, B * 0.24);
  g.save();
  g.beginPath();
  g.rect(i0 - ch, i0 - ch, i1 - i0 + ch * 2, i1 - i0 + ch * 2);
  g.rect(i0, i0, i1 - i0, i1 - i0);
  g.fillStyle = mix(tint, '#0a0a0e', 0.42);
  g.fill('evenodd');
  g.restore();

  g.lineWidth = 1;
  g.strokeStyle = rgba(GOLD_HI, 0.5);
  g.strokeRect(i0 - ch + 0.5, i0 - ch + 0.5, i1 - i0 + ch * 2 - 1, i1 - i0 + ch * 2 - 1);
  g.strokeStyle = rgba('#000000', 0.8);
  g.strokeRect(i0 + 0.5, i0 + 0.5, i1 - i0 - 1, i1 - i0 - 1);

  // hairline highlight along the top and left crest
  g.strokeStyle = rgba(GOLD_HI, 0.55);
  g.beginPath();
  g.moveTo(o + B * 0.28, o + B * 0.22);
  g.lineTo(S - o - B * 0.28, o + B * 0.22);
  g.moveTo(o + B * 0.22, o + B * 0.28);
  g.lineTo(o + B * 0.22, S - o - B * 0.28);
  g.stroke();

  // corner bosses
  const cq = o + B * 0.52;
  const br = B * 0.5;
  for (const [x, y] of [[cq, cq], [S - cq, cq], [cq, S - cq], [S - cq, S - cq]]) {
    boss(g, x, y, br, tint, glow);
  }

  // edge rivets at the centre of each repeated span
  if (opt.rivets) {
    const rr = B * 0.24;
    for (const [x, y] of [[S / 2, o + B * 0.5], [S / 2, S - o - B * 0.5], [o + B * 0.5, S / 2], [S - o - B * 0.5, S / 2]]) {
      const gr = g.createRadialGradient(x - rr * 0.4, y - rr * 0.4, 0, x, y, rr);
      gr.addColorStop(0, GOLD_HI);
      gr.addColorStop(0.6, GOLD_MID);
      gr.addColorStop(1, GOLD_LOW);
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = rgba('#000', 0.6);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  // punch the centre out so the panel's own fill shows through
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  g.fillRect(i0 + 1, i0 + 1, i1 - i0 - 2, i1 - i0 - 2);
  g.restore();

  return c;
}

/* ------------------------------------------------------------------ *
 * parchment / leather grain
 * ------------------------------------------------------------------ */

function hash2(i, j, s) {
  let n = (i * 73856093) ^ (j * 19349663) ^ (s * 83492791);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, L, s) {
  const fx = x * L;
  const fy = y * L;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const ia = ((i0 % L) + L) % L;
  const ib = (ia + 1) % L;
  const ja = ((j0 % L) + L) % L;
  const jb = (ja + 1) % L;
  const a = hash2(ia, ja, s);
  const b = hash2(ib, ja, s);
  const c = hash2(ia, jb, s);
  const d = hash2(ib, jb, s);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Seamless dark tooled-leather / parchment tile, faintly faction tinted. */
function drawGrain(tint) {
  const N = 128;
  const c = canvas(N, N);
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  const px = img.data;
  const base = hex2rgb(mix('#0d0f16', tint, 0.1));
  const warm = hex2rgb(mix('#2b2416', tint, 0.16));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const n =
        vnoise(u, v, 6, 11) * 0.52 +
        vnoise(u, v, 17, 23) * 0.3 +
        vnoise(u, v, 43, 37) * 0.18;
      const fib = vnoise(u * 0.35, v, 61, 71) * 0.16;
      const t = clamp(n * 0.9 + fib, 0, 1);
      const k = (y * N + x) * 4;
      px[k] = base[0] + (warm[0] - base[0]) * t;
      px[k + 1] = base[1] + (warm[1] - base[1]) * t;
      px[k + 2] = base[2] + (warm[2] - base[2]) * t;
      px[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ *
 * glyph divider rule
 * ------------------------------------------------------------------ */

function drawDivider(tint, glow) {
  const W = 800;
  const H = 44;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const cy = H / 2;

  const fade = g.createLinearGradient(0, 0, W, 0);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.12, rgba(GOLD_MID, 0.75));
  fade.addColorStop(0.5, rgba(GOLD_HI, 0.95));
  fade.addColorStop(0.88, rgba(GOLD_MID, 0.75));
  fade.addColorStop(1, 'rgba(0,0,0,0)');

  // double rule with a shadow line beneath, so it reads engraved
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, cy + 3);
  g.lineTo(W, cy + 3);
  g.stroke();

  g.strokeStyle = fade;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, cy);
  g.lineTo(W, cy);
  g.stroke();
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(W * 0.16, cy + 7);
  g.lineTo(W * 0.84, cy + 7);
  g.stroke();

  // central glyph: a faceted lozenge flanked by tapering wings
  const cx = W / 2;
  const R = 15;
  g.save();
  g.clearRect(cx - R * 2.6, 0, R * 5.2, H);
  const wing = (dir) => {
    poly(g, [
      [cx + dir * R * 1.2, cy],
      [cx + dir * R * 3.4, cy - 4],
      [cx + dir * R * 4.6, cy],
      [cx + dir * R * 3.4, cy + 4]
    ]);
    g.fillStyle = rgba(GOLD_MID, 0.85);
    g.fill();
  };
  wing(1);
  wing(-1);

  poly(g, [[cx, cy - R], [cx + R * 0.78, cy], [cx, cy + R], [cx - R * 0.78, cy]]);
  const gg = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  gg.addColorStop(0, GOLD_HI);
  gg.addColorStop(0.45, GOLD_MID);
  gg.addColorStop(1, GOLD_LOW);
  g.fillStyle = gg;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.stroke();

  poly(g, [[cx, cy - R * 0.46], [cx + R * 0.34, cy], [cx, cy + R * 0.46], [cx - R * 0.34, cy]]);
  g.fillStyle = glow;
  g.shadowColor = glow;
  g.shadowBlur = 8;
  g.fill();
  g.restore();

  return c;
}

/* ------------------------------------------------------------------ *
 * slider gem + swatch ring
 * ------------------------------------------------------------------ */

function drawGem(tint, glow) {
  const S = 44;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const cx = S / 2;
  const r = S / 2 - 3;

  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 5;
  g.fill();
  g.shadowBlur = 0;

  const gr = g.createLinearGradient(0, 2, 0, S - 2);
  gr.addColorStop(0, GOLD_HI);
  gr.addColorStop(0.4, GOLD_MID);
  gr.addColorStop(0.72, GOLD_LOW);
  gr.addColorStop(1, GOLD_DEEP);
  g.beginPath();
  g.arc(cx, cx, r - 1.5, 0, Math.PI * 2);
  g.fillStyle = gr;
  g.fill();

  const R = r * 0.5;
  poly(g, [[cx, cx - R], [cx + R, cx], [cx, cx + R], [cx - R, cx]]);
  const gg = g.createRadialGradient(cx - R * 0.3, cx - R * 0.3, 1, cx, cx, R);
  gg.addColorStop(0, sh(glow, 0.35));
  gg.addColorStop(0.6, tint);
  gg.addColorStop(1, sh(tint, -0.5));
  g.fillStyle = gg;
  g.fill();
  g.strokeStyle = rgba(GOLD_HI, 0.85);
  g.lineWidth = 1;
  g.stroke();

  g.beginPath();
  g.arc(cx - r * 0.28, cx - r * 0.34, r * 0.22, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,250,235,0.5)';
  g.fill();
  return c;
}

function drawRing() {
  const S = 56;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const cx = S / 2;

  g.beginPath();
  g.arc(cx, cx, cx - 1, 0, Math.PI * 2);
  g.lineWidth = 5;
  const gr = g.createLinearGradient(0, 0, 0, S);
  gr.addColorStop(0, GOLD_HI);
  gr.addColorStop(0.45, GOLD_MID);
  gr.addColorStop(1, GOLD_DEEP);
  g.strokeStyle = gr;
  g.stroke();

  g.beginPath();
  g.arc(cx, cx, cx - 3.5, 0, Math.PI * 2);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.stroke();

  // inner shading so the swatch colour looks like a domed cabochon
  const sgr = g.createRadialGradient(cx - S * 0.2, cx - S * 0.24, 1, cx, cx, cx);
  sgr.addColorStop(0, 'rgba(255,255,255,0.34)');
  sgr.addColorStop(0.45, 'rgba(255,255,255,0.04)');
  sgr.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.beginPath();
  g.arc(cx, cx, cx - 5, 0, Math.PI * 2);
  g.fillStyle = sgr;
  g.fill();
  return c;
}

/* ------------------------------------------------------------------ *
 * faction crest
 * ------------------------------------------------------------------ */

function drawCrest(cv, faction) {
  const F = FACTIONS[faction] || FACTIONS.Neutral;
  const S = cv.width;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const u = S / 100;
  const shield = () => {
    g.beginPath();
    g.moveTo(50 * u, 6 * u);
    g.lineTo(90 * u, 22 * u);
    g.quadraticCurveTo(90 * u, 70 * u, 50 * u, 95 * u);
    g.quadraticCurveTo(10 * u, 70 * u, 10 * u, 22 * u);
    g.closePath();
  };
  shield();
  g.fillStyle = 'rgba(0,0,0,0.85)';
  g.fill();

  g.save();
  shield();
  g.clip();
  const gr = g.createLinearGradient(0, 0, 0, S);
  gr.addColorStop(0, sh(F.primary, 0.24));
  gr.addColorStop(0.55, F.primary);
  gr.addColorStop(1, sh(F.primary, -0.55));
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let i = -6; i < 12; i++) {
    poly(g, [[i * 12 * u, 0], [(i * 12 + 6) * u, 0], [(i * 12 + 6 - 22) * u, S], [(i * 12 - 22) * u, S]]);
    g.fill();
  }
  g.restore();

  // charge: crossed bars for Alliance, tusked chevron for Horde, ring for Neutral
  g.strokeStyle = F.secondary;
  g.lineWidth = 5 * u;
  g.lineCap = 'round';
  g.beginPath();
  if (faction === 'Alliance') {
    g.moveTo(50 * u, 24 * u); g.lineTo(50 * u, 74 * u);
    g.moveTo(30 * u, 42 * u); g.lineTo(70 * u, 42 * u);
  } else if (faction === 'Horde') {
    g.moveTo(28 * u, 66 * u); g.quadraticCurveTo(50 * u, 24 * u, 72 * u, 66 * u);
    g.moveTo(38 * u, 40 * u); g.lineTo(30 * u, 30 * u);
    g.moveTo(62 * u, 40 * u); g.lineTo(70 * u, 30 * u);
  } else {
    g.arc(50 * u, 48 * u, 20 * u, 0, Math.PI * 2);
    g.moveTo(50 * u, 28 * u); g.lineTo(50 * u, 68 * u);
  }
  g.stroke();

  shield();
  g.lineWidth = 4 * u;
  const eg = g.createLinearGradient(0, 0, 0, S);
  eg.addColorStop(0, GOLD_HI);
  eg.addColorStop(0.5, GOLD_MID);
  eg.addColorStop(1, GOLD_LOW);
  g.strokeStyle = eg;
  g.stroke();
}

/* ------------------------------------------------------------------ *
 * race portraits
 * ------------------------------------------------------------------ */

function drawEars(g, kind, cx, cy, r, skin) {
  const dark = sh(skin, -0.4);
  const put = (dir, pts, fill) => {
    poly(g, pts.map(([x, y]) => [cx + dir * x, cy + y]));
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.stroke();
  };
  for (const dir of [-1, 1]) {
    switch (kind) {
      case 'long':
        put(dir, [[r * 0.78, -r * 0.1], [r * 1.95, -r * 0.95], [r * 1.6, -r * 0.05], [r * 0.8, r * 0.25]], skin);
        break;
      case 'wide':
        put(dir, [[r * 0.75, -r * 0.18], [r * 1.5, -r * 0.42], [r * 1.45, r * 0.3], [r * 0.78, r * 0.3]], skin);
        break;
      case 'pointed':
        put(dir, [[r * 0.74, -r * 0.14], [r * 1.28, -r * 0.62], [r * 1.06, r * 0.16], [r * 0.78, r * 0.26]], skin);
        break;
      case 'pointed-up':
        put(dir, [[r * 0.4, -r * 0.74], [r * 0.72, -r * 1.5], [r * 0.98, -r * 0.5]], skin);
        put(dir, [[r * 0.5, -r * 0.78], [r * 0.72, -r * 1.28], [r * 0.86, -r * 0.6]], dark);
        break;
      case 'round':
        g.beginPath();
        g.arc(cx + dir * r * 0.74, cy - r * 0.8, r * 0.34, 0, Math.PI * 2);
        g.fillStyle = dark;
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = 1;
        g.stroke();
        break;
      case 'side-long':
        ell(g, cx + dir * r * 1.22, cy + r * 0.05, r * 0.55, r * 0.26, dir * 0.25);
        g.fillStyle = skin;
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = 1;
        g.stroke();
        break;
      case 'long-droop':
        put(dir, [[r * 0.74, -r * 0.28], [r * 1.9, r * 0.55], [r * 1.5, r * 0.7], [r * 0.78, r * 0.18]], skin);
        break;
      case 'frill':
        for (let i = 0; i < 3; i++) {
          const a = -0.5 + i * 0.4;
          put(dir, [
            [r * 0.72, -r * 0.2 + i * r * 0.22],
            [r * (1.25 + i * 0.1), -r * 0.55 + Math.sin(a) * r * 0.5],
            [r * 0.8, r * 0.05 + i * r * 0.24]
          ], i % 2 ? dark : skin);
        }
        break;
      default:
        ell(g, cx + dir * r * 0.84, cy + r * 0.06, r * 0.2, r * 0.3);
        g.fillStyle = dark;
        g.fill();
    }
  }
}

/** Stylised bust built straight out of the race's build + feature record. */
function drawPortrait(cv, race) {
  const W = cv.width;
  const H = cv.height;
  const g = cv.getContext('2d');
  const b = race.build;
  const f = race.features;
  const F = FACTIONS[race.faction] || FACTIONS.Neutral;
  const skin = race.skinTones ? race.skinTones[1] || race.skin : race.skin;
  const eye = (race.eyeColors && race.eyeColors[0]) || '#ffd24a';
  const hair = (race.hairColors && race.hairColors[0]) || '#2b1c14';

  g.clearRect(0, 0, W, H);
  g.save();
  roundRect(g, 0, 0, W, H, W * 0.09);
  g.clip();

  // niche background
  const bg = g.createRadialGradient(W * 0.5, H * 0.36, W * 0.05, W * 0.5, H * 0.5, W * 0.78);
  bg.addColorStop(0, mix('#1b2130', F.primary, 0.34));
  bg.addColorStop(0.6, mix('#0a0d14', F.primary, 0.12));
  bg.addColorStop(1, '#05060a');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  const floor = g.createLinearGradient(0, H * 0.62, 0, H);
  floor.addColorStop(0, 'rgba(0,0,0,0)');
  floor.addColorStop(1, rgba(F.glow, 0.18));
  g.fillStyle = floor;
  g.fillRect(0, H * 0.62, W, H * 0.38);

  const cx = W * 0.5;
  const headR = H * 0.178 * clamp(b.headScale, 0.8, 1.6);
  const hunch = clamp(b.posture, -0.1, 0.4);
  const headCy = H * (0.40 + hunch * 0.16) + (b.neck < 0.6 ? H * 0.03 : 0);
  const neckLen = H * 0.075 * clamp(b.neck, 0.2, 1.3);
  const shoulderY = headCy + headR * 0.92 + neckLen;
  const halfW = W * 0.32 * clamp(b.shoulderW, 0.7, 1.6);
  const neckW = headR * (0.34 + 0.32 * clamp(b.neck < 0.7 ? 1.4 : 0.9, 0, 2)) * (b.chest > 1.2 ? 1.2 : 1);

  const line = (a) => {
    g.lineWidth = Math.max(1, W * 0.012);
    g.strokeStyle = `rgba(0,0,0,${a})`;
    g.stroke();
  };

  // torso / shoulders
  g.beginPath();
  g.moveTo(cx - halfW, H + 2);
  g.quadraticCurveTo(cx - halfW * 0.98, shoulderY + H * 0.03, cx - neckW, shoulderY - H * 0.01);
  g.lineTo(cx + neckW, shoulderY - H * 0.01);
  g.quadraticCurveTo(cx + halfW * 0.98, shoulderY + H * 0.03, cx + halfW, H + 2);
  g.closePath();
  const tg = g.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
  tg.addColorStop(0, sh(skin, -0.56));
  tg.addColorStop(0.35, sh(skin, -0.24));
  tg.addColorStop(0.72, sh(skin, -0.4));
  tg.addColorStop(1, sh(skin, -0.64));
  g.fillStyle = tg;
  g.fill();
  line(0.6);

  // neck
  g.beginPath();
  g.rect(cx - neckW, headCy, neckW * 2, shoulderY - headCy + 2);
  g.fillStyle = sh(skin, -0.36);
  g.fill();

  // horns behind the skull
  if (f.horns) {
    g.lineCap = 'round';
    g.lineWidth = headR * 0.26;
    for (const dir of [-1, 1]) {
      const hg = g.createLinearGradient(cx, headCy - headR, cx, headCy - headR * 2);
      hg.addColorStop(0, '#3a3128');
      hg.addColorStop(1, '#d8cdb4');
      g.strokeStyle = hg;
      g.beginPath();
      g.moveTo(cx + dir * headR * 0.6, headCy - headR * 0.5);
      g.quadraticCurveTo(cx + dir * headR * 1.7, headCy - headR * 1.15, cx + dir * headR * 1.35, headCy - headR * 1.75);
      g.stroke();
    }
    g.lineWidth = 1;
  }

  // jaw + muzzle mass, unioned with the cranium
  const jawR = headR * (0.62 + 0.16 * clamp(f.jaw, 0.7, 1.5));
  const snout = clamp(f.snout, 0, 1);
  g.beginPath();
  g.ellipse(cx, headCy + headR * 0.42, jawR, headR * (0.55 + snout * 0.2), 0, 0, Math.PI * 2);
  g.ellipse(cx, headCy, headR * 0.88, headR, 0, 0, Math.PI * 2);
  if (snout > 0.05) {
    g.ellipse(cx, headCy + headR * (0.5 + snout * 0.34), headR * (0.3 + snout * 0.4), headR * (0.22 + snout * 0.42), 0, 0, Math.PI * 2);
  }
  const hg = g.createRadialGradient(cx - headR * 0.4, headCy - headR * 0.5, headR * 0.1, cx, headCy, headR * 1.7);
  hg.addColorStop(0, sh(skin, 0.34));
  hg.addColorStop(0.42, sh(skin, 0.06));
  hg.addColorStop(1, sh(skin, -0.4));
  g.fillStyle = hg;
  g.fill();
  line(0.55);

  drawEars(g, f.ears, cx, headCy, headR, skin);

  // hair mass / mane
  g.beginPath();
  g.ellipse(cx, headCy - headR * 0.5, headR * 0.95, headR * 0.62, 0, Math.PI, Math.PI * 2);
  g.fillStyle = hair;
  g.fill();
  g.globalAlpha = 0.5;
  g.fillStyle = sh(hair, 0.2);
  g.beginPath();
  g.ellipse(cx - headR * 0.3, headCy - headR * 0.72, headR * 0.34, headR * 0.16, -0.3, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;

  // brow shelf
  if (f.brow > 0.05) {
    g.beginPath();
    g.ellipse(cx, headCy - headR * 0.12, headR * 0.8, headR * 0.24 * (0.6 + f.brow), 0, Math.PI, Math.PI * 2);
    g.fillStyle = rgba('#000000', 0.18 + f.brow * 0.3);
    g.fill();
  }

  // eyes
  for (const dir of [-1, 1]) {
    const ex = cx + dir * headR * 0.36;
    const ey = headCy + headR * 0.02;
    ell(g, ex, ey, headR * 0.19, headR * 0.12);
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fill();
    g.beginPath();
    g.arc(ex, ey, headR * 0.1, 0, Math.PI * 2);
    g.fillStyle = eye;
    g.shadowColor = eye;
    g.shadowBlur = headR * 0.55;
    g.fill();
    g.shadowBlur = 0;
  }

  // nostrils on muzzled races
  if (snout > 0.2) {
    for (const dir of [-1, 1]) {
      ell(g, cx + dir * headR * 0.16, headCy + headR * (0.62 + snout * 0.3), headR * 0.07, headR * 0.05);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fill();
    }
  }

  // tusks
  if (f.tusks) {
    for (const dir of [-1, 1]) {
      poly(g, [
        [cx + dir * headR * 0.3, headCy + headR * 0.74],
        [cx + dir * headR * 0.46, headCy + headR * 0.28],
        [cx + dir * headR * 0.52, headCy + headR * 0.8]
      ]);
      g.fillStyle = '#e8e0cc';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1;
      g.stroke();
    }
  }

  // scales
  if (f.scales > 0.1) {
    g.globalAlpha = 0.25 * f.scales + 0.1;
    g.fillStyle = sh(skin, 0.4);
    for (let i = 0; i < 26; i++) {
      const a = hash2(i, 3, 9) * Math.PI * 2;
      const rr = Math.sqrt(hash2(i, 7, 11)) * headR * 0.85;
      ell(g, cx + Math.cos(a) * rr, headCy + Math.sin(a) * rr * 0.9, headR * 0.07, headR * 0.045);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // rim light from the upper left, tying the tile to the 3D key light
  g.save();
  g.beginPath();
  g.ellipse(cx, headCy, headR * 0.88, headR, 0, 0, Math.PI * 2);
  const rim = g.createLinearGradient(cx - headR, headCy - headR, cx + headR * 0.4, headCy + headR);
  rim.addColorStop(0, 'rgba(255,244,222,0.55)');
  rim.addColorStop(0.4, 'rgba(255,244,222,0)');
  g.strokeStyle = rim;
  g.lineWidth = Math.max(1.2, W * 0.02);
  g.stroke();
  g.restore();

  // vignette
  const vg = g.createRadialGradient(W * 0.5, H * 0.45, W * 0.24, W * 0.5, H * 0.5, W * 0.74);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.48)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
  g.restore();
}

/* ------------------------------------------------------------------ *
 * class sigils
 * ------------------------------------------------------------------ */

function drawClassIcon(cv, klass) {
  const S = cv.width;
  const g = cv.getContext('2d');
  const u = S / 100;
  const col = legible(klass.color);
  g.clearRect(0, 0, S, S);

  g.save();
  roundRect(g, 0, 0, S, S, S * 0.14);
  g.clip();
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, mix('#191b23', klass.color, 0.14));
  bg.addColorStop(1, mix('#07080c', klass.color, 0.05));
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  const glow = g.createRadialGradient(S * 0.5, S * 0.52, S * 0.05, S * 0.5, S * 0.52, S * 0.6);
  glow.addColorStop(0, rgba(klass.color, 0.3));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, S, S);

  g.translate(0, 0);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = 7 * u;
  g.shadowColor = rgba(col, 0.9);
  g.shadowBlur = 6 * u;

  const P = (x, y) => [x * u, y * u];
  const stroke = (...pts) => {
    g.beginPath();
    g.moveTo(...P(pts[0], pts[1]));
    for (let i = 2; i < pts.length; i += 2) g.lineTo(...P(pts[i], pts[i + 1]));
    g.stroke();
  };
  const fillPoly = (pts) => {
    poly(g, pts.map(([x, y]) => P(x, y)));
    g.fill();
  };
  const arc = (x, y, r, a0, a1) => {
    g.beginPath();
    g.arc(x * u, y * u, r * u, a0, a1);
    g.stroke();
  };

  switch (klass.name) {
    case 'Warrior':
      g.lineWidth = 9 * u;
      stroke(22, 82, 74, 24);
      stroke(78, 82, 26, 24);
      g.lineWidth = 6 * u;
      stroke(58, 26, 82, 34);
      stroke(42, 26, 18, 34);
      break;
    case 'Paladin':
      fillPoly([[26, 16], [74, 16], [74, 42], [26, 42]]);
      g.lineWidth = 10 * u;
      stroke(50, 42, 50, 88);
      g.lineWidth = 6 * u;
      stroke(34, 60, 66, 60);
      break;
    case 'Hunter':
      g.lineWidth = 8 * u;
      arc(38, 50, 34, -Math.PI * 0.44, Math.PI * 0.44);
      g.lineWidth = 3 * u;
      stroke(53, 20, 53, 80);
      g.lineWidth = 7 * u;
      stroke(30, 50, 88, 50);
      fillPoly([[88, 50], [72, 42], [72, 58]]);
      break;
    case 'Rogue':
      g.lineWidth = 7 * u;
      stroke(30, 86, 40, 24);
      stroke(70, 86, 60, 24);
      fillPoly([[40, 24], [34, 12], [46, 16]]);
      fillPoly([[60, 24], [66, 12], [54, 16]]);
      g.lineWidth = 5 * u;
      stroke(20, 70, 44, 70);
      stroke(56, 70, 80, 70);
      break;
    case 'Priest':
      g.lineWidth = 6 * u;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        stroke(50 + Math.cos(a) * 26, 50 + Math.sin(a) * 26, 50 + Math.cos(a) * 42, 50 + Math.sin(a) * 42);
      }
      g.beginPath();
      g.arc(50 * u, 50 * u, 18 * u, 0, Math.PI * 2);
      g.fill();
      break;
    case 'Shaman':
      fillPoly([[56, 10], [30, 54], [46, 54], [40, 90], [70, 42], [52, 42]]);
      g.lineWidth = 5 * u;
      stroke(14, 30, 26, 30);
      stroke(74, 70, 86, 70);
      break;
    case 'Mage':
      g.lineWidth = 6 * u;
      fillPoly([[50, 8], [60, 40], [92, 50], [60, 60], [50, 92], [40, 60], [8, 50], [40, 40]]);
      g.lineWidth = 3 * u;
      g.beginPath();
      g.ellipse(50 * u, 50 * u, 42 * u, 18 * u, -0.5, 0, Math.PI * 2);
      g.stroke();
      break;
    case 'Warlock':
      g.lineWidth = 6 * u;
      arc(50, 54, 30, 0, Math.PI * 2);
      stroke(28, 34, 16, 12);
      stroke(72, 34, 84, 12);
      g.lineWidth = 5 * u;
      stroke(36, 44, 64, 44, 50, 74, 36, 44);
      break;
    case 'Monk':
      g.lineWidth = 7 * u;
      arc(50, 50, 34, 0, Math.PI * 2);
      g.lineWidth = 6 * u;
      g.beginPath();
      g.arc(50 * u, 33 * u, 17 * u, Math.PI * 1.5, Math.PI * 0.5);
      g.arc(50 * u, 67 * u, 17 * u, Math.PI * 1.5, Math.PI * 0.5, true);
      g.stroke();
      break;
    case 'Druid':
      g.lineWidth = 6 * u;
      g.beginPath();
      g.moveTo(50 * u, 92 * u);
      g.quadraticCurveTo(4 * u, 56 * u, 50 * u, 10 * u);
      g.quadraticCurveTo(96 * u, 56 * u, 50 * u, 92 * u);
      g.stroke();
      g.lineWidth = 5 * u;
      stroke(50, 88, 50, 22);
      stroke(50, 56, 28, 40);
      stroke(50, 46, 72, 32);
      break;
    case 'Demon Hunter':
      g.lineWidth = 8 * u;
      arc(30, 50, 26, -Math.PI * 0.55, Math.PI * 0.55);
      arc(70, 50, 26, Math.PI * 0.45, Math.PI * 1.55);
      g.lineWidth = 5 * u;
      stroke(44, 50, 56, 50);
      break;
    case 'Death Knight':
      g.lineWidth = 9 * u;
      stroke(50, 22, 50, 90);
      g.lineWidth = 7 * u;
      stroke(26, 36, 74, 36);
      g.beginPath();
      g.arc(50 * u, 22 * u, 14 * u, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.shadowBlur = 0;
      g.beginPath();
      g.arc(45 * u, 20 * u, 4 * u, 0, Math.PI * 2);
      g.arc(55 * u, 20 * u, 4 * u, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
      g.shadowBlur = 6 * u;
      break;
    case 'Evoker':
      g.lineWidth = 6 * u;
      g.beginPath();
      g.moveTo(14 * u, 78 * u);
      g.quadraticCurveTo(38 * u, 8 * u, 88 * u, 22 * u);
      g.stroke();
      g.lineWidth = 5 * u;
      stroke(28, 56, 44, 84);
      stroke(46, 36, 62, 74);
      stroke(66, 24, 82, 56);
      break;
    default:
      g.beginPath();
      g.arc(50 * u, 50 * u, 26 * u, 0, Math.PI * 2);
      g.stroke();
  }

  g.shadowBlur = 0;
  g.globalCompositeOperation = 'source-over';
  // inner bevel so the tile reads as set stone
  roundRect(g, 1.5, 1.5, S - 3, S - 3, S * 0.12);
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,240,210,0.16)';
  g.stroke();
  g.restore();
}

/* ------------------------------------------------------------------ *
 * dom helpers
 * ------------------------------------------------------------------ */

function el(tag, cls, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) {
    for (const k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
  }
  return n;
}

function section(title) {
  const s = el('section', 'panel');
  const h = el('h2', 'panel-title', { text: title });
  s.append(h, el('div', 'rule', { 'aria-hidden': 'true' }));
  return s;
}

/**
 * Roving-tabindex keyboard model for the grids and swatch rows: one tab stop
 * per group, arrows move (and select) within it.
 */
function wireRoving(container, colsFn) {
  container.addEventListener('keydown', (e) => {
    const items = Array.from(container.querySelectorAll('[data-rove]')).filter((n) => !n.hidden && !n.disabled);
    const i = items.indexOf(document.activeElement);
    if (i < 0 || !items.length) return;
    const cols = colsFn ? Math.max(1, colsFn()) : 1;
    let j;
    switch (e.key) {
      case 'ArrowRight': j = i + 1; break;
      case 'ArrowLeft': j = i - 1; break;
      case 'ArrowDown': j = cols > 1 ? i + cols : i + 1; break;
      case 'ArrowUp': j = cols > 1 ? i - cols : i - 1; break;
      case 'Home': j = 0; break;
      case 'End': j = items.length - 1; break;
      default: return;
    }
    e.preventDefault();
    const target = items[clamp(j, 0, items.length - 1)];
    target.focus();
    target.click();
  });
}

/* ------------------------------------------------------------------ *
 * buildUI
 * ------------------------------------------------------------------ */

export function buildUI({ store }) {
  const root = document.documentElement;
  const titlebar = document.getElementById('titlebar');
  const railL = document.getElementById('rail-left');
  const railR = document.getElementById('rail-right');
  const actionbar = document.getElementById('actionbar');
  if (!titlebar || !railL || !railR || !actionbar) return;

  // The rails themselves stay put (they carry the scrim); an inner box does the
  // scrolling so the scrim never slides away from the panel edges.
  const innerL = document.createElement('div');
  innerL.className = 'rail-inner';
  railL.append(innerL);
  const innerR = document.createElement('div');
  innerR.className = 'rail-inner';
  railR.append(innerR);

  const races = store.allRaces;
  const classes = store.allClasses;
  const FACTION_KEYS = ['All', 'Alliance', 'Horde', 'Neutral'];
  const GENDERS = ['Male', 'Female', 'Non-binary'];
  const QUALITY = [['high', 'High'], ['balanced', 'Balanced'], ['performance', 'Fast']];

  const raceByName = new Map(races.map((r) => [r.name, r]));
  const getRace = (n) => raceByName.get(n) || races[0];

  /* ---------- faction-tinted skin, cached per faction ---------- */

  const skinCache = new Map();
  function skinFor(faction) {
    if (skinCache.has(faction)) return skinCache.get(faction);
    const F = FACTIONS[faction] || FACTIONS.Neutral;
    const pack = {
      panel: url(drawFrame(F.primary, F.glow, { size: 160, band: 26, radius: 6, rivets: true })),
      button: url(drawFrame(F.primary, F.glow, { size: 96, band: 15, radius: 4, rivets: false })),
      grain: url(drawGrain(F.primary)),
      divider: url(drawDivider(F.primary, F.glow)),
      gem: url(drawGem(F.primary, F.glow)),
      ring: url(drawRing()),
      primary: F.primary,
      secondary: F.secondary,
      glow: F.glow
    };
    skinCache.set(faction, pack);
    return pack;
  }

  let activeFaction = null;
  function applySkin(faction) {
    if (faction === activeFaction) return;
    activeFaction = faction;
    const s = skinFor(faction);
    root.style.setProperty('--frame-panel', s.panel);
    root.style.setProperty('--frame-button', s.button);
    root.style.setProperty('--grain', s.grain);
    root.style.setProperty('--divider', s.divider);
    root.style.setProperty('--gem', s.gem);
    root.style.setProperty('--ring', s.ring);
    root.style.setProperty('--f-primary', s.primary);
    root.style.setProperty('--f-secondary', s.secondary);
    root.style.setProperty('--f-glow', s.glow);
    document.body.dataset.faction = faction;
  }
  applySkin(getRace(store.state.race).faction);

  /* ---------- titlebar ---------- */

  const bannerL = el('div', 'title-left');
  const crest = canvas(96, 96);
  crest.className = 'crest';
  crest.setAttribute('aria-hidden', 'true');
  const titles = el('div', 'title-text');
  const h1 = el('h1', 'title-main', { text: 'Character Creation' });
  const sub = el('p', 'title-sub');
  titles.append(h1, sub);
  bannerL.append(crest, titles);

  const factionGroup = el('div', 'seg seg-faction', { role: 'radiogroup', 'aria-label': 'Faction filter' });
  const factionBtns = FACTION_KEYS.map((k) => {
    const b = el('button', 'seg-btn', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1', 'data-faction': k
    });
    b.append(el('span', 'seg-dot f-' + k.toLowerCase(), { 'aria-hidden': 'true' }), el('span', null, { text: k }));
    b.addEventListener('click', () => setFaction(k));
    factionGroup.append(b);
    return b;
  });
  wireRoving(factionGroup);

  const titleRight = el('div', 'title-right');
  const qLabel = el('span', 'mini-label', { text: 'Quality' });
  const qualityGroup = el('div', 'seg seg-quality', { role: 'radiogroup', 'aria-label': 'Render quality' });
  const qualityBtns = QUALITY.map(([v, label]) => {
    const b = el('button', 'seg-btn', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1', 'data-q': v, text: label
    });
    b.addEventListener('click', () => store.set({ quality: v }));
    qualityGroup.append(b);
    return b;
  });
  wireRoving(qualityGroup);

  const spinBtn = el('button', 'chip', { type: 'button', role: 'switch', 'aria-checked': 'true' });
  spinBtn.append(el('span', 'chip-mark', { 'aria-hidden': 'true' }), el('span', null, { text: 'Auto-spin' }));
  spinBtn.addEventListener('click', () => store.set({ autoRotate: !store.state.autoRotate }));

  titleRight.append(qLabel, qualityGroup, spinBtn);
  titlebar.append(bannerL, factionGroup, titleRight);

  /* ---------- left rail: race + class ---------- */

  const selectPanel = el('section', 'panel');
  selectPanel.append(el('h2', 'panel-title', { text: 'Race' }), el('div', 'rule', { 'aria-hidden': 'true' }));
  const raceGrid = el('div', 'grid grid-race', { role: 'radiogroup', 'aria-label': 'Race' });
  const raceTiles = races.map((r) => {
    const b = el('button', 'tile tile-race', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1',
      'data-race': r.name, title: `${r.name} — ${r.faction}`
    });
    const art = canvas(128, 128);
    art.className = 'tile-art';
    art.setAttribute('aria-hidden', 'true');
    b.append(art, el('span', 'tile-name', { text: r.name }));
    b.addEventListener('click', () => selectRace(r.name));
    raceGrid.append(b);
    return { btn: b, art, race: r };
  });
  wireRoving(raceGrid, () => 4);
  selectPanel.append(raceGrid);
  selectPanel.append(
    el('h2', 'panel-title panel-title-2', { text: 'Class' }),
    el('div', 'rule', { 'aria-hidden': 'true' })
  );

  const classGrid = el('div', 'grid grid-class', { role: 'radiogroup', 'aria-label': 'Class' });
  const classTiles = classes.map((k) => {
    const b = el('button', 'tile tile-class', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1',
      'data-class': k.name, title: `${k.name} — ${k.role}`, 'aria-label': `${k.name}, ${k.role}`
    });
    b.style.setProperty('--class-color', legible(k.color));
    const art = canvas(112, 112);
    art.className = 'tile-art';
    art.setAttribute('aria-hidden', 'true');
    b.append(art);
    b.addEventListener('click', () => store.set({ class: k.name }));
    classGrid.append(b);
    return { btn: b, art, klass: k };
  });
  wireRoving(classGrid, () => 5);
  const classCaption = el('p', 'caption', { 'aria-live': 'polite' });
  selectPanel.append(classGrid, classCaption);

  innerL.append(selectPanel);

  /* ---------- right rail: appearance ---------- */

  const formPanel = section('Appearance');

  // gender
  const genderRow = el('div', 'ctl ctl-gender');
  genderRow.append(el('span', 'ctl-label', { text: 'Body Type' }));
  const genderGroup = el('div', 'seg seg-wide', { role: 'radiogroup', 'aria-label': 'Body type' });
  const genderBtns = GENDERS.map((gname) => {
    const b = el('button', 'seg-btn', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1',
      'data-gender': gname, text: gname === 'Non-binary' ? 'Neutral' : gname
    });
    b.setAttribute('aria-label', gname);
    b.addEventListener('click', () => store.set({ gender: gname }));
    genderGroup.append(b);
    return b;
  });
  wireRoving(genderGroup);
  genderRow.append(genderGroup);
  formPanel.append(genderRow);

  // sliders
  const SLIDERS = [
    ['height', 'Height'],
    ['bulk', 'Build'],
    ['headSize', 'Head'],
    ['shoulders', 'Shoulders']
  ];
  const sliders = SLIDERS.map(([key, label]) => {
    const row = el('div', 'ctl ctl-slider');
    const id = 'sl-' + key;
    const lab = el('label', 'ctl-label', { for: id, text: label });
    const out = el('output', 'ctl-value', { for: id });
    const input = el('input', 'range', {
      id, type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': label
    });
    input.addEventListener('input', () => store.set({ [key]: Number(input.value) }));
    row.append(lab, input, out);
    formPanel.append(row);
    return { key, input, out };
  });

  // steppers
  function stepper(key, label, count) {
    const row = el('div', 'ctl ctl-step', { role: 'group', 'aria-label': label });
    row.append(el('span', 'ctl-label', { text: label }));
    const box = el('div', 'stepper');
    const prev = el('button', 'step-btn', { type: 'button', 'aria-label': `Previous ${label.toLowerCase()}`, text: '‹' });
    const next = el('button', 'step-btn', { type: 'button', 'aria-label': `Next ${label.toLowerCase()}`, text: '›' });
    const val = el('span', 'step-val', { 'aria-live': 'polite' });
    const move = (d) => store.set({ [key]: (store.state[key] + d + count) % count });
    prev.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    box.append(prev, val, next);
    row.append(box);
    formPanel.append(row);
    return { key, val, count };
  }
  const steppers = [stepper('faceIndex', 'Face', 6), stepper('hairIndex', 'Hairstyle', 8)];

  formPanel.append(el('div', 'rule rule-soft', { 'aria-hidden': 'true' }));

  // colour swatch rows, rebuilt from the selected race's own palettes
  function swatchRow(key, label) {
    const row = el('div', 'ctl ctl-swatch');
    row.append(el('span', 'ctl-label', { text: label }));
    const group = el('div', 'swatches', { role: 'radiogroup', 'aria-label': label });
    wireRoving(group, () => 6);
    row.append(group);
    formPanel.append(row);
    return { key, group };
  }
  const swatchRows = [
    swatchRow('skin', 'Skin'),
    swatchRow('hair', 'Hair'),
    swatchRow('eyes', 'Eyes')
  ];

  function paletteFor(race, key) {
    if (key === 'skin') return race.skinTones || [race.skin];
    if (key === 'hair') return race.hairColors || ['#20150f'];
    return race.eyeColors || ['#4a6d8c'];
  }

  function renderSwatches(race) {
    for (const row of swatchRows) {
      row.group.textContent = '';
      for (const hex of paletteFor(race, row.key)) {
        const b = el('button', 'swatch', {
          type: 'button', role: 'radio', 'aria-checked': 'false', 'data-rove': '', tabindex: '-1',
          'data-color': hex, 'aria-label': `${row.key} ${hex}`, title: hex
        });
        b.style.setProperty('--swatch', hex);
        b.addEventListener('click', () => store.set({ [row.key]: hex }));
        row.group.append(b);
      }
    }
  }
  renderSwatches(getRace(store.state.race));

  formPanel.append(el('div', 'rule rule-soft', { 'aria-hidden': 'true' }));

  // toggles
  const TOGGLES = [['horns', 'Horns'], ['pauldrons', 'Pauldrons'], ['cape', 'Cape']];
  const toggleRow = el('div', 'ctl ctl-toggles');
  const toggles = TOGGLES.map(([key, label]) => {
    const b = el('button', 'toggle', { type: 'button', role: 'switch', 'aria-checked': 'false', 'data-key': key });
    b.append(el('span', 'toggle-box', { 'aria-hidden': 'true' }), el('span', 'toggle-label', { text: label }));
    b.addEventListener('click', () => store.set({ [key]: !store.state[key] }));
    toggleRow.append(b);
    return { key, btn: b };
  });
  formPanel.append(toggleRow);
  innerR.append(formPanel);

  /* ---------- action bar ---------- */

  const barInner = el('div', 'bar-inner');
  const randomBtn = el('button', 'btn btn-ghost', { type: 'button', text: 'Randomize' });
  randomBtn.addEventListener('click', randomize);

  const summary = el('div', 'summary', { 'aria-live': 'polite' });
  const sumName = el('span', 'sum-name');
  const sumMeta = el('span', 'sum-meta');
  summary.append(sumName, sumMeta);

  const enterBtn = el('button', 'btn btn-hero', { type: 'button' });
  enterBtn.append(el('span', 'btn-label', { text: 'Enter World' }));
  enterBtn.addEventListener('click', enterWorld);

  barInner.append(randomBtn, summary, enterBtn);
  actionbar.append(barInner);

  const flash = el('div', 'enter-flash', { 'aria-hidden': 'true' });
  document.getElementById('ui').append(flash);

  /* ---------- behaviour ---------- */

  function visibleRaces() {
    const f = store.state.faction;
    return races.filter((r) => f === 'All' || r.faction === f);
  }

  function setFaction(f) {
    const patch = { faction: f };
    const pool = races.filter((r) => f === 'All' || r.faction === f);
    if (pool.length && !pool.some((r) => r.name === store.state.race)) {
      Object.assign(patch, raceDefaults(pool[0]));
      patch.race = pool[0].name;
    }
    store.set(patch);
  }

  function raceDefaults(race) {
    return {
      skin: (race.skinTones && race.skinTones[1]) || race.skin,
      hair: (race.hairColors && race.hairColors[0]) || '#20150f',
      eyes: (race.eyeColors && race.eyeColors[0]) || '#4a6d8c',
      faceIndex: clamp(store.state.faceIndex, 0, (race.faces || 6) - 1),
      hairIndex: clamp(store.state.hairIndex, 0, (race.hairstyles || 8) - 1)
    };
  }

  // There is no per-race class restriction in the data, so every class stays
  // valid across races; the check is kept explicit so the rule is obvious.
  const classAllowed = (klass) => Boolean(klass);

  function selectRace(name) {
    if (name === store.state.race) return;
    const race = getRace(name);
    const patch = { race: name, ...raceDefaults(race) };
    const current = classes.find((c) => c.name === store.state.class);
    if (!current || !classAllowed(current, race)) {
      const keep = classes.find((c) => classAllowed(c, race));
      if (keep) patch.class = keep.name;
    }
    store.set(patch);
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function randomize() {
    const pool = visibleRaces();
    const race = pick(pool.length ? pool : races);
    const klass = pick(classes.filter((c) => classAllowed(c, race)));
    const r2 = () => Math.round((0.18 + Math.random() * 0.64) * 100) / 100;
    store.set({
      race: race.name,
      class: klass ? klass.name : store.state.class,
      gender: pick(GENDERS),
      height: r2(), bulk: r2(), headSize: r2(), shoulders: r2(),
      faceIndex: Math.floor(Math.random() * (race.faces || 6)),
      hairIndex: Math.floor(Math.random() * (race.hairstyles || 8)),
      skin: pick(paletteFor(race, 'skin')),
      hair: pick(paletteFor(race, 'hair')),
      eyes: pick(paletteFor(race, 'eyes')),
      horns: Math.random() < 0.3,
      pauldrons: Math.random() < 0.8,
      cape: Math.random() < 0.65
    });
  }

  let entering = false;
  function enterWorld() {
    if (entering) return;
    entering = true;
    document.body.classList.add('entering');
    const s = store.state;
    const detail = { race: s.race, class: s.class, gender: s.gender };
    window.dispatchEvent(new CustomEvent('enterworld', { detail }));
    setTimeout(() => {
      document.body.classList.remove('entering');
      entering = false;
    }, 1500);
  }

  /* ---------- sync ---------- */

  const fmtPct = (v) => `${Math.round(v * 100)}%`;

  function sync(s, changed) {
    const race = getRace(s.race);
    const klass = classes.find((c) => c.name === s.class) || classes[0];

    if (!changed || changed.has('race') || changed.has('faction')) {
      applySkin(race.faction);
      drawCrest(crest, race.faction);
      sub.textContent = `${race.faction} — ${race.name}`;
    }

    if (!changed || changed.has('faction')) {
      const f = s.faction;
      for (const b of factionBtns) {
        const on = b.dataset.faction === f;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      for (const t of raceTiles) {
        t.btn.hidden = !(f === 'All' || t.race.faction === f);
      }
    }

    if (!changed || changed.has('race')) {
      for (const t of raceTiles) {
        const on = t.race.name === s.race;
        t.btn.setAttribute('aria-checked', String(on));
        t.btn.classList.toggle('is-on', on);
        t.btn.tabIndex = on ? 0 : -1;
      }
      renderSwatches(race);
    }

    if (!changed || changed.has('class')) {
      for (const t of classTiles) {
        const on = t.klass.name === s.class;
        t.btn.setAttribute('aria-checked', String(on));
        t.btn.classList.toggle('is-on', on);
        t.btn.tabIndex = on ? 0 : -1;
      }
      classCaption.textContent = `${klass.name} · ${klass.role}`;
      classCaption.style.setProperty('--class-color', legible(klass.color));
    }

    if (!changed || changed.has('gender')) {
      for (const b of genderBtns) {
        const on = b.dataset.gender === s.gender;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }

    if (!changed || changed.has('quality')) {
      for (const b of qualityBtns) {
        const on = b.dataset.q === s.quality;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }

    if (!changed || changed.has('autoRotate')) {
      spinBtn.setAttribute('aria-checked', String(!!s.autoRotate));
      spinBtn.classList.toggle('is-on', !!s.autoRotate);
    }

    let resolved = null;
    for (const sl of sliders) {
      const v = Number(s[sl.key]);
      if (document.activeElement !== sl.input && sl.input.value !== String(v)) sl.input.value = String(v);
      sl.input.style.setProperty('--fill', `${clamp(v, 0, 1) * 100}%`);
      if (sl.key === 'height') {
        resolved = resolved || store.resolve();
        sl.out.textContent = `${resolved.build.height.toFixed(2)} m`;
      } else {
        sl.out.textContent = fmtPct(v);
      }
    }

    for (const st of steppers) {
      st.val.textContent = `${(s[st.key] % st.count) + 1} / ${st.count}`;
    }

    for (const row of swatchRows) {
      let any = false;
      for (const b of row.group.children) {
        const on = b.dataset.color === s[row.key];
        if (on) any = true;
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('is-on', on);
        b.tabIndex = on ? 0 : -1;
      }
      if (!any && row.group.firstElementChild) row.group.firstElementChild.tabIndex = 0;
    }

    for (const t of toggles) {
      const on = !!s[t.key];
      t.btn.setAttribute('aria-checked', String(on));
      t.btn.classList.toggle('is-on', on);
    }

    resolved = resolved || store.resolve();
    sumName.textContent = `${s.gender === 'Non-binary' ? '' : s.gender + ' '}${race.name}`;
    sumMeta.textContent = `${klass.name} · ${klass.role} · ${resolved.build.height.toFixed(2)} m · ${race.faction}`;
    summary.style.setProperty('--class-color', legible(klass.color));
    enterBtn.setAttribute('aria-label', `Enter world as ${race.name} ${klass.name}`);
  }

  store.subscribe(sync);
  sync(store.state, null);

  /* ---------- deferred art pass ---------- */
  // The DOM is up and correct before a single portrait is rasterised, so the
  // first frame of the 3D scene is never blocked by icon painting.

  const jobs = [];
  for (const t of raceTiles) jobs.push(() => drawPortrait(t.art, t.race));
  for (const t of classTiles) jobs.push(() => drawClassIcon(t.art, t.klass));

  let cursor = 0;
  function paintChunk() {
    const start = performance.now();
    while (cursor < jobs.length && performance.now() - start < 4) jobs[cursor++]();
    if (cursor < jobs.length) requestAnimationFrame(paintChunk);
    else document.body.classList.add('art-ready');
  }
  requestAnimationFrame(() => requestAnimationFrame(paintChunk));

  // Safety net: if the render loop never reaches its first frame, still reveal
  // the interface rather than leaving the user staring at the loading veil.
  setTimeout(() => document.body.classList.add('ready'), 6000);
}
