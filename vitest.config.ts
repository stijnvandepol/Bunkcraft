import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests only cover DOM-free modules
// (world generation, meshing, physics, items) and need neither the worker setup nor
// the dev-server proxy.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Generous: world generation and zip tests take a few seconds alone and several times that on a busy CI box or laptop.
    testTimeout: 30_000,
  },
});
