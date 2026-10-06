// Vite config for long-running QA tests: no HMR, no file watching (a reload mid-test breaks the run),
// with the /ws and /api proxies to a game server on QA_SERVER_PORT.
//   QA_SERVER_PORT=3417 npx vite --config scripts/qa/vite.qa.config.mjs --port 5417
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = process.env.QA_SERVER_PORT ?? '3417';

export default defineConfig({
  root,
  worker: { format: 'es' },
  server: {
    strictPort: true,
    hmr: false,
    watch: null,
    proxy: {
      '/ws': { target: `ws://localhost:${server}`, ws: true },
      '/api': { target: `http://localhost:${server}` },
    },
  },
});
