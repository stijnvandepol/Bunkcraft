import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Files that are not worth precaching: runtime-cached on first use instead. */
const SKIP = [/^sw\.js$/, /^404\.html$/, /\.map$/, /\.(br|gz)$/, /^texturepacks\//, /\.DS_Store$/, /^robots\.txt$/];

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Small Workbox-free PWA build step: after the bundle is written, fills the placeholders
 * of `public/sw.js` with the list of built files (precache) and a version derived from
 * their content, so every deploy that changes a file gets a new cache and an update toast.
 */
export function pwa(): Plugin {
  let outDir = 'dist';
  return {
    name: 'bunkcraft-pwa',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      let sw: string;
      try { sw = readFileSync(swPath, 'utf8'); } catch { return; }
      const files = walk(outDir, outDir).filter((f) => !SKIP.some((re) => re.test(f))).sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      // "./" is the start page; index.html itself is covered by it.
      const urls = ['./', ...files.filter((f) => f !== 'index.html')];
      sw = sw.replace("'__PRECACHE__'", () => JSON.stringify(urls)).replace("'__VERSION__'", () => JSON.stringify(version));
      writeFileSync(swPath, sw);
    },
  };
}
