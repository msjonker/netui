// Fail the build when the initial load exceeds the bundle budget:
// JS + CSS, gzipped, in vite's units (1 kB = 1000 bytes).
// The initial load is what dist/index.html references: the entry script, its
// stylesheet and a modulepreload for every chunk the entry imports statically.
// Lazy chunks (screens loaded with import()) are reported, not counted.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 190;
const dir = 'dist/assets';
const html = readFileSync('dist/index.html', 'utf8');
const initial = new Set([...html.matchAll(/(?:src|href)="\.?\/?assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]));
const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
if (![...initial].some((f) => f.endsWith('.js'))) {
  console.error('No entry script found in dist/index.html.');
  process.exit(1);
}

let total = 0;
let lazy = 0;
for (const f of files.sort((a, b) => Number(initial.has(b)) - Number(initial.has(a)))) {
  const gz = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
  if (initial.has(f)) total += gz;
  else lazy += gz;
  console.log(`${(gz / 1000).toFixed(2).padStart(8)} kB  ${f}${initial.has(f) ? '' : '  (lazy)'}`);
}
console.log(`${(total / 1000).toFixed(2).padStart(8)} kB  initial load (budget ${BUDGET_KB} kB)`);
if (lazy) console.log(`${(lazy / 1000).toFixed(2).padStart(8)} kB  lazy, loaded on demand`);
if (total > BUDGET_KB * 1000) {
  console.error(`Over budget by ${((total - BUDGET_KB * 1000) / 1000).toFixed(2)} kB.`);
  process.exit(1);
}
