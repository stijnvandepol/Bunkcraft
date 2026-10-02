import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests only cover DOM-free modules
// (world generation, meshing, physics, items) and need neither the worker setup nor
// the dev-server proxy.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Map generation and the WebSocket integration tests are slow on a busy machine.
    testTimeout: 30_000,
  },
});
