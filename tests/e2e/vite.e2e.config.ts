import { mergeConfig } from 'vite';
import base from '../../vite.config';

/**
 * Vite for the end-to-end suite: no HMR and no file watching (a merge or another worktree must not reload the page
 * mid-test), its own port, and the multiplayer proxy pointing at the e2e game server.
 */
const GAME_PORT = Number(process.env.E2E_GAME_PORT ?? 3197);
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5197);

export default mergeConfig(base, {
  server: {
    port: VITE_PORT,
    strictPort: true,
    hmr: false,
    watch: null,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${GAME_PORT}`, ws: true },
      '/api': { target: `http://127.0.0.1:${GAME_PORT}` },
      '/skins': { target: `http://127.0.0.1:${GAME_PORT}` },
    },
  },
});
