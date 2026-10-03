import { readdirSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { type Plugin, defineConfig } from 'vite';

/**
 * Production extras:
 *  - precompressed `.br` / `.gz` copies of every text asset, served by `server/index.ts`
 *    (no compression work per request, and brotli level 11 is ~20 % smaller than on-the-fly gzip)
 *  - preload hints so the chunk worker and the pixel font download in parallel with the main
 *    bundle instead of after it has run
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
            tags.push({ tag: 'link', attrs: { rel: 'modulepreload', as: 'worker', href: `/${file}` }, injectTo: 'head' as const });
          }
        }
        tags.push({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/otf', href: '/fonts/bunkcraft-pixel.otf', crossorigin: '' },
          injectTo: 'head' as const,
        });
        // The default texture pack: the title screen waits for these ~56 small images, so start them
        // with the HTML instead of after the bundle has run (one round trip saved per connection batch).
        for (const png of readdirSync('public/texturepacks/pixel-perfection').filter((f) => f.endsWith('.png'))) {
          tags.push({ tag: 'link', attrs: { rel: 'preload', as: 'image', href: `/texturepacks/pixel-perfection/${png}` }, injectTo: 'head' as const });
        }
        return tags;
      },
    },
    generateBundle(_options, bundle) {
      for (const [file, item] of Object.entries(bundle)) {
        if (!/\.(js|css|html|svg|json)$/.test(file)) continue;
        const source = item.type === 'chunk' ? item.code : item.source;
        const data = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
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
  worker: { format: 'es' },
  plugins: [productionAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
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
