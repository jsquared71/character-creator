// Parse every source module the way the browser will — as an ES module.
//
// `node --check foo.js` parses as CommonJS and will happily accept a file the
// browser rejects. The bug that motivated this: a comment containing backticks
// placed inside a GLSL template literal silently terminated the literal, and
// only the module-mode parse caught it.
//
//   node tools/check.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = globSync('src/**/*.js', { cwd: new URL('..', import.meta.url).pathname })
  .map((f) => join(new URL('..', import.meta.url).pathname, f))
  .sort();

const dir = mkdtempSync(join(tmpdir(), 'esmcheck-'));
const failures = [];

for (const file of files) {
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, readFileSync(file));
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (err) {
    const detail = (err.stderr?.toString() ?? '').split('\n').slice(0, 6).join('\n');
    failures.push({ file, detail });
  }
}

rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  for (const { file, detail } of failures) {
    console.error(`\nESM PARSE FAIL: ${file}\n${detail}`);
  }
  console.error(`\n${failures.length} of ${files.length} modules failed.`);
  process.exit(1);
}

console.log(`All ${files.length} modules parse as ES modules.`);
