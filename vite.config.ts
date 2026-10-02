import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: {
    // During `npm run dev`, multiplayer traffic goes to the game server (`npm run server`).
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
});
