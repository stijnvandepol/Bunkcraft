// QA-only Vite config: no HMR/watch (Vite would otherwise reload pages mid-test) and a proxy to a QA game server.
//   QA_SERVER_PORT=3471 npx vite --config scripts/qa/vite.qa.config.ts --port 5191 --strictPort
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const port = process.env.QA_SERVER_PORT ?? '3471';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  worker: { format: 'es' },
  server: {
    hmr: false,
    watch: null,
    proxy: {
      '/ws': { target: `ws://localhost:${port}`, ws: true },
      '/api': { target: `http://localhost:${port}` },
    },
  },
});
