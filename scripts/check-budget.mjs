// Fail the build when dist/ exceeds the bundle budget:
// JS + CSS, gzipped, in vite's units (1 kB = 1000 bytes).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 190;
const dir = 'dist/assets';
const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
let total = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
  total += gz;
  console.log(`${(gz / 1000).toFixed(2).padStart(8)} kB  ${f}`);
}
console.log(`${(total / 1000).toFixed(2).padStart(8)} kB  total (budget ${BUDGET_KB} kB)`);
if (total > BUDGET_KB * 1000) {
  console.error(`Over budget by ${((total - BUDGET_KB * 1000) / 1000).toFixed(2)} kB.`);
  process.exit(1);
}
