import { type Page, test as base, expect } from '@playwright/test';

/** Console noise that is not a bug in the game (browser, GPU driver and dev-server chatter). */
const BENIGN = [
  /GPU stall due to ReadPixels/i,
  /GL_CLOSE_PATH_NV|GroupMarkerNotSet/i,
  /Automatic fallback to software WebGL/i,
  /favicon\.ico/i,
  /\[vite\]/i,
  /Download the React DevTools/i,
  /WebGL: too many errors/i,
  /Failed to load resource: the server responded with a status of 404/i, // probed room codes in negative tests
  /AudioContext was not allowed to start/i,
  /The AudioContext was not allowed/i,
  /pointer ?lock/i,
];

export interface GameFixtures {
  /** Console errors and uncaught exceptions seen on the page; the fixture fails the test if any remain. */
  consoleErrors: string[];
}

export const test = base.extend<GameFixtures>({
  consoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !BENIGN.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => { if (!BENIGN.some((r) => r.test(e.message))) errors.push(`pageerror: ${e.message}`); });
    await use(errors);
    expect(errors, 'console errors during the flow').toEqual([]);
  }, { auto: true }],
});
export { expect };

/** Waits for the dev build's window.game hook and the title screen. */
export async function openTitle(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => {
    const g = (window as unknown as { game?: { state?: string } }).game;
    return !!g && g.state === 'menu' && !!document.querySelector('button');
  }, undefined, { timeout: 60_000 });
}

export async function clickButton(page: Page, text: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: text }).first().click();
}

/** Waits until a world is loaded (world generation is asynchronous), keeping the window in front so it is not throttled. */
export async function waitForWorld(page: Page, timeout = 90_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    await page.bringToFront();
    const state = await page.evaluate(() => (window as unknown as { game: { state: string } }).game.state);
    if (state !== 'loading' && state !== 'menu') return;
    if (Date.now() > end) throw new Error(`world did not load, state ${state}`);
    await page.waitForTimeout(250);
  }
}

/** Pointer lock does not work in automated browsers: force the playing state the way CLAUDE.md describes. */
export async function forcePlaying(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as unknown as { game: { input: { locked: boolean }; state: string } }).game;
    g.input.locked = true;
    g.state = 'playing';
    document.querySelector('.click-to-play')?.remove();
  });
}

/** Runs `ms` of game time with the window in front (a background window renders at 1-10 FPS). */
export async function play(page: Page, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.bringToFront();
    await page.waitForTimeout(Math.min(250, end - Date.now()));
  }
}
