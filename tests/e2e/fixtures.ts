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

/** Waits for the dev build's window.game hook and the home screen. */
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

/** Home → Build & Survival (beta): the door to the sandbox menus (Singleplayer, Multiplayer). */
export async function openSandbox(page: Page): Promise<void> {
  await page.locator('.home-build').click();
  await expect(page.getByRole('heading', { name: 'Build & Survival' })).toBeVisible();
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

/**
 * Opens the pause menu (Esc) on a page that is in the forced playing state. forcePlaying only fakes the lock flag:
 * Linux Chromium (CI) grants the real Pointer Lock after the click that started the game, and while it is held every
 * mouse event goes to the locked canvas, so no menu button can be clicked ("<div role=dialog> intercepts pointer
 * events"). macOS Chromium does not grant it, which hid this locally. Release the real lock like Esc does.
 */
export async function openPauseMenu(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(async () => {
    const g = (window as unknown as { game: { input: { locked: boolean }; state: string; showPauseMenu(): void } }).game;
    if (document.pointerLockElement) {
      const released = new Promise<void>((resolve) => document.addEventListener('pointerlockchange', () => resolve(), { once: true }));
      document.exitPointerLock();
      await released;
    }
    // The lock change pauses the game by itself when the real lock was held; without a real lock do what it does.
    if (!document.querySelector('.screen.pause')) { g.input.locked = false; g.state = 'paused'; g.showPauseMenu(); }
  });
  await page.waitForFunction(() => document.pointerLockElement === null);
}

/** Runs `ms` of game time with the window in front (a background window renders at 1-10 FPS). */
export async function play(page: Page, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.bringToFront();
    await page.waitForTimeout(Math.min(250, end - Date.now()));
  }
}

/** Home → Build & Survival → Singleplayer → Create New World; returns once the world is loaded and playing. */
export async function createWorld(page: Page, name: string, mode: 'Creative' | 'Survival' = 'Creative'): Promise<void> {
  await openSandbox(page);
  await clickButton(page, 'Singleplayer');
  await page.getByRole('button', { name: 'Create New World' }).first().click();
  await page.locator('input.mc-input:visible').first().fill(name);
  for (let i = 0; i < 4; i++) {
    if (await page.getByRole('button', { name: `Game Mode: ${mode}` }).count()) break;
    await page.getByRole('button', { name: /^Game Mode:/ }).click();
  }
  await page.getByRole('button', { name: 'Create New World' }).last().click();
  await waitForWorld(page);
  await forcePlaying(page);
}

/** Sends a chat line (commands included) the way the chat box does, and returns the chat lines it added. */
export async function command(page: Page, text: string): Promise<string> {
  return page.evaluate((t) => {
    const chat = (window as unknown as { game: { chat: { onSend: (s: string) => void; log: HTMLElement } } }).game.chat;
    const before = chat.log.children.length;
    chat.onSend(t);
    return [...chat.log.children].slice(before).map((e) => e.textContent).join('\n');
  }, text);
}

/**
 * Hides the 3D canvas (the moving panorama, different per GPU) so a menu screenshot compares the menu only.
 * Masking the canvas instead paints over the whole viewport: the canvas is full-screen behind the menu.
 */
export async function hidePanorama(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'canvas#game { visibility: hidden !important; } body { background: #1e1e1e !important; }' });
}
