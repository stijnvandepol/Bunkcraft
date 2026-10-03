// QA runs: the normal Vite config without HMR or file watching, so worktree changes never reload the page mid-test.
//   QA_PORT=5231 npx vite --config scripts/qa/vite.qa.config.ts
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, defineConfig({
  server: { hmr: false, watch: null, port: Number(process.env.QA_PORT ?? 5231), strictPort: true },
}));
