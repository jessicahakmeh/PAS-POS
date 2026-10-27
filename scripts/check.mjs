// Static check: every front-end module parses, and every named import from a local module is actually exported.
// Usage: node scripts/check.mjs
import { readdirSync, readFileSync, statSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!['node_modules', 'scripts', '.git'].includes(f)) walk(p); } else if (f.endsWith('.js')) files.push(p); } };
walk(root);

const tmp = mkdtempSync(join(tmpdir(), 'pas-check-'));
let problems = 0;
const exportsOf = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) m[1].split(',').forEach(x => names.add(x.trim().split(/\s+as\s+/).pop()));
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
};
for (const f of files) {
  const rel = relative(root, f);
  const copy = join(tmp, rel.replace(/[\\/]/g, '_').replace(/\.js$/, '.mjs'));
  copyFileSync(f, copy);
  const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  if (r.status) { problems++; console.log(`SYNTAX ${rel}\n${r.stderr}`); }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    const target = resolve(dirname(f), m[2]);
    let tsrc; try { tsrc = readFileSync(target, 'utf8'); } catch { problems++; console.log(`MISSING FILE ${rel} -> ${m[2]}`); continue; }
    const ex = exportsOf(tsrc);
    for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) if (!ex.has(n)) { problems++; console.log(`MISSING EXPORT ${rel}: '${n}' is not exported by ${m[2]}`); }
  }
}
console.log(problems ? `${problems} problem(s)` : `OK: ${files.length} modules parse and all local imports resolve`);
process.exit(problems ? 1 : 0);
