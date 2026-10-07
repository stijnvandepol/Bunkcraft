import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end suite (npm run test:e2e). Playwright starts and stops both servers itself:
 * the real game server (temporary DATA_DIR, no room creation limit) and Vite in dev mode
 * (window.game debug hook) with HMR and file watching off.
 */
const GAME_PORT = Number(process.env.E2E_GAME_PORT ?? 3197);
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5197);
const DATA_DIR = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'bunk-e2e-'));
const isMac = process.platform === 'darwin';
const CI = !!process.env.CI;
const BASELINES = join(import.meta.dirname, 'baselines');
/** On CI, a browser/OS pair without committed baselines skips the pixel comparison instead of failing on its first run. */
const noBaselines = (project: string) => CI && !existsSync(join(BASELINES, `${project}-${process.platform}`));

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: '../../test-results/e2e',
  // Screenshot baselines are committed per browser and OS (fonts render differently): tests/e2e/baselines/<project>-<platform>/.
  // A missing baseline is written by the first run on that platform.
  snapshotPathTemplate: '{testDir}/baselines/{projectName}-{platform}/{arg}{ext}',
  updateSnapshots: 'missing',
  timeout: 120_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.03, threshold: 0.25, animations: 'disabled' } },
  fullyParallel: false,
  // One game server for all tests, and WebGL in software is heavy: one worker keeps timings sane.
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      ignoreSnapshots: noBaselines('chromium'),
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        // macOS: real GPU through Metal (SwiftShader is ~4x slower). Linux CI: SwiftShader (software WebGL2).
        launchOptions: { args: isMac ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
      },
    },
    {
      // Safari engine: only the smoke and singleplayer flows (multiplayer runs on Chromium).
      name: 'webkit',
      ignoreSnapshots: noBaselines('webkit'),
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } },
      grep: /@webkit/,
    },
  ],
  webServer: [
    {
      command: 'node_modules/.bin/tsx server/index.ts',
      cwd: '../..',
      url: `http://127.0.0.1:${GAME_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(GAME_PORT), DATA_DIR, ROOM_CREATE_LIMIT: '1000', MAX_CONN_PER_IP: '1000', BACKUP_KEEP: '0',
        STATIC_DIR: 'tests/e2e', LOG_LEVEL: 'warn',
        // Quick play lobbies stay human-only: the flows count players and wait in the warm-up (server bots are tested apart).
        QUICKPLAY_BOTS: '0',
      },
    },
    {
      command: `node_modules/.bin/vite --config tests/e2e/vite.e2e.config.ts --host 127.0.0.1`,
      cwd: '../..',
      url: `http://127.0.0.1:${VITE_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { E2E_GAME_PORT: String(GAME_PORT), E2E_VITE_PORT: String(VITE_PORT) },
    },
  ],
});
