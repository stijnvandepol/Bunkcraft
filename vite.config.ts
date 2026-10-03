import { readdirSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { type Plugin, defineConfig } from 'vite';
import { pwa } from './scripts/vite-pwa';

// `npm run build:static` (BUNK_STATIC=1): relative base so the folder works on any host or sub-path (itch.io).
const STATIC = process.env.BUNK_STATIC === '1';
const BASE = STATIC ? './' : '/';

/**
 * Production extras:
 *  - precompressed `.br` / `.gz` copies of every text asset, served by `server/index.ts`
 *    (no compression work per request, and brotli level 11 is ~20 % smaller than on-the-fly gzip)
 *  - preload hints so the chunk worker, the pixel font and the default texture pack download in
 *    parallel with the main bundle instead of after it has run
 */
function productionAssets(): Plugin {
  return {
    name: 'bunkcraft-production-assets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const tags = [];
        for (const file of Object.keys(ctx.bundle ?? {})) {
          if (/chunkWorker.*\.js$/.test(file)) {
            tags.push({ tag: 'link', attrs: { rel: 'modulepreload', as: 'worker', href: `${BASE}${file}` }, injectTo: 'head' as const });
          }
        }
        tags.push({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/otf', href: `${BASE}fonts/bunkcraft-pixel.otf`, crossorigin: '' },
          injectTo: 'head' as const,
        });
        // The default texture pack: the title screen waits for these ~56 small images, so start them
        // with the HTML instead of after the bundle has run (one round trip saved per connection batch).
        for (const png of readdirSync('public/texturepacks/pixel-perfection').filter((f) => f.endsWith('.png'))) {
          tags.push({ tag: 'link', attrs: { rel: 'preload', as: 'image', href: `${BASE}texturepacks/pixel-perfection/${png}` }, injectTo: 'head' as const });
        }
        return tags;
      },
    },
    generateBundle(_options, bundle) {
      // Static hosts (itch.io) do their own compression; only the Node server uses these copies.
      if (STATIC) return;
      for (const [file, item] of Object.entries(bundle)) {
        if (!/\.(js|css|html|svg|json)$/.test(file)) continue;
        const source = item.type === 'chunk' ? item.code : item.source;
        const data = Buffer.from(source);
        if (data.length < 1024) continue;
        this.emitFile({ type: 'asset', fileName: `${file}.gz`, source: gzipSync(data, { level: 9 }) });
        this.emitFile({
          type: 'asset', fileName: `${file}.br`,
          source: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
        });
      }
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [pwa(), productionAssets()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    ...(STATIC ? { outDir: 'dist-static' } : {}),
    rollupOptions: {
      output: {
        // three.js changes far less often than the game: its own long-term cached file.
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: {
    // During `npm run dev`, multiplayer traffic goes to the game server (`npm run server`).
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
    },
  },
});
