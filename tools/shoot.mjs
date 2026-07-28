// Critic harness: boots the app in headless Chromium, captures the fixed
// camera set, and reports console/WebGL errors and sustained frame time.
//
//   node tools/shoot.mjs [--out shots] [--race Human] [--class Warrior]
//                        [--views hero,profile,face,detail,full] [--silhouette]
//
// Exits non-zero if the page threw, so the loop can fail fast on a shader
// compile error instead of scoring a black screenshot.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8817;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);

const outDir = join(ROOT, args.out || 'shots');
const views = (args.views || 'hero,profile,face,detail,full').split(',');
mkdirSync(outDir, { recursive: true });

const server = await serve();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--disable-lcd-text']
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t);
  else if (m.type() === 'warning' && /shader|gl_|webgl|three/i.test(t)) warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });

const ready = await page.waitForFunction(
  () => window.__creator && document.body.classList.contains('ready'),
  null, { timeout: 45000 }
).then(() => true).catch(() => false);

const report = { ready, errors, warnings, shots: [], perf: null };

if (ready) {
  if (args.race || args.class) {
    await page.evaluate(([race, klass]) => {
      const patch = {};
      if (race) patch.race = race;
      if (klass) patch.class = klass;
      window.__creator.store.set(patch);
    }, [args.race || null, args.class || null]);
    await page.waitForTimeout(900);
  }

  // Let bakes settle and the auto-rotate reach a consistent angle.
  await page.evaluate(() => { window.__creator.store.set({ autoRotate: false }); });
  await page.evaluate(() => { window.__creator.character.group.rotation.y = 0; });
  await page.waitForTimeout(500);

  for (const view of views) {
    await page.evaluate((v) => window.__creator.setView(v), view);
    await page.waitForTimeout(320);
    const file = join(outDir, `${view}.png`);
    await page.screenshot({ path: file });
    report.shots.push(file);
  }

  if (args.silhouette) {
    // Pure black cutout at 200px for the silhouette-readability axis.
    await page.evaluate(() => {
      const c = window.__creator;
      c.setView('full');
      c.scene.traverse((o) => {
        if (o.isMesh || o.isInstancedMesh) {
          o.userData._mat = o.material;
          o.material = new (o.material.constructor)({ color: 0x000000 });
          if (o.material.emissive) o.material.emissive.set(0x000000);
          o.material.map = null; o.material.envMap = null;
        }
      });
      c.scene.background = new (window.THREE?.Color ?? Object)(0xffffff);
      c.renderer.setClearColor(0xffffff, 1);
    });
    await page.waitForTimeout(250);
    const file = join(outDir, 'silhouette.png');
    await page.screenshot({ path: file, clip: { x: 560, y: 0, width: 480, height: 900 } });
    report.shots.push(file);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__creator, null, { timeout: 30000 }).catch(() => {});
  }

  // Sustained frame time over a 4s orbit.
  //
  // NOTE: headless here is SwiftShader (software raster), so wall-clock frame
  // time is NOT representative of the integrated-GPU target in the rubric.
  // Draw calls and triangle count are the hardware-independent proxies — those
  // are what the perf axis should actually be judged on in this environment.
  report.perf = await page.evaluate(async () => {
    const c = window.__creator;
    c.perf.reset();
    c.store.set({ autoRotate: true });
    await new Promise((r) => setTimeout(r, 4000));
    const info = c.renderer.info;
    return {
      avgMs: +c.perf.avgMs.toFixed(2),
      p95Ms: +c.perf.p95Ms.toFixed(2),
      fps: +c.perf.fps.toFixed(1),
      softwareRaster: true,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? null,
      geometries: info.memory.geometries,
      textures: info.memory.textures
    };
  });
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  ready,
  errorCount: errors.length,
  errors: errors.slice(0, 25),
  warnings: warnings.slice(0, 10),
  perf: report.perf,
  shots: report.shots
}, null, 2));

await browser.close();
server.close();
process.exit(ready && errors.length === 0 ? 0 : 1);
