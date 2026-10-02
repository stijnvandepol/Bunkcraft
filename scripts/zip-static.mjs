// Zips dist-static/ into bunkcraft-static.zip (index.html at the zip root, as itch.io expects).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = 'dist-static';
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[relative(root, full).split(sep).join('/')] = readFileSync(full);
  }
})(root);
writeFileSync('bunkcraft-static.zip', zipSync(files, { level: 9 }));
console.log(`bunkcraft-static.zip: ${Object.keys(files).length} files`);
