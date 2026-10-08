import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests only cover DOM-free modules
// (world generation, meshing, physics, items) and need neither the worker setup nor
// the dev-server proxy. Browser end-to-end tests live in tests/e2e (Playwright, own config).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Instrumented code is slower: wall-clock assertions read this (tests/helpers/timing.ts).
    env: { BUNK_COVERAGE: process.argv.some((a) => a.startsWith('--coverage')) ? '1' : '0' },
    // Generous: world generation, zip and real-server integration tests take a few seconds alone and longer on a busy box;
    // coverage instrumentation on a 2-core CI runner is several times slower still.
    testTimeout: process.argv.some((a) => a.startsWith('--coverage')) ? 90_000 : 30_000,
    // CI only: a test that times out on an overloaded runner gets two more tries. Locally a failure stays a failure,
    // and a real bug fails all three tries in CI as well.
    retry: process.env.CI ? 2 : 0,
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
