import { defineConfig } from 'vite';
import { pwa } from './scripts/vite-pwa';

// `npm run build:static` (BUNK_STATIC=1): relative base so the folder works on any host or sub-path (itch.io).
const STATIC = process.env.BUNK_STATIC === '1';

export default defineConfig({
  base: STATIC ? './' : '/',
  plugins: [pwa()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200, ...(STATIC ? { outDir: 'dist-static' } : {}) },
  server: {
    // During `npm run dev`, multiplayer traffic goes to the game server (`npm run server`).
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
    },
  },
});
