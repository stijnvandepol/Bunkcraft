import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests only cover DOM-free modules
// (world generation, meshing, physics, items) and need neither the worker setup nor
// the dev-server proxy. Browser end-to-end tests live in tests/e2e (Playwright, own config).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Generous: world generation, zip and real-server integration tests take a few seconds alone and longer on a busy box.
    testTimeout: 30_000,
    // beforeAll hooks start real server processes (tsx compile + world setup).
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is measured over all game and server code, so untested files show up as 0%.
      include: ['src/**/*.ts', 'server/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/main.ts'],
    },
  },
});
