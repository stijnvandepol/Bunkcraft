/**
 * Helpers for QA round 3: drive the PRODUCTION build like a human player. Only real input (clicks, keys,
 * mouse buttons) and what the page shows (DOM text, screenshots); no `window.game` (production has none).
 *
 *   QA_URL=http://localhost:3471 npx tsx scripts/qa/<script>.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type BrowserContext, type Page, chromium, webkit } from '@playwright/test';

export const URL = process.env.QA_URL ?? 'http://localhost:3471';
export const SHOTS = process.env.QA_SHOTS ?? 'docs/qa/shots/arcade';
mkdirSync(SHOTS, { recursive: true });

export type Engine = 'chromium' | 'webkit';

export async function launch(engine: Engine, headless = process.env.QA_HEADED !== '1'): Promise<Browser> {
  if (engine === 'webkit') return webkit.launch({ headless });
  return chromium.launch({ headless, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
}

export interface Player {
  name: string;
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  logs: string[];
}

/**
 * Headless browsers have no Pointer Lock. This shim emulates it the way Chrome and Safari behave for a real
 * player, so the game's own lock code runs unchanged: a request needs a user gesture, Esc is eaten by the
 * browser and releases the lock (the page sees no keydown), re-locking within ~1 s after Esc is refused,
 * losing focus (tab switch, window blur) releases it. The game's code is not touched.
 */
const POINTER_LOCK_SHIM = `(() => {
  let el = null;
  let exitedAt = -1e9;
  const fire = (type) => document.dispatchEvent(new Event(type));
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => el });
  Element.prototype.requestPointerLock = function () {
    const ua = navigator.userActivation;
    if ((ua && !ua.isActive) || performance.now() - exitedAt < 1000) {
      setTimeout(() => fire('pointerlockerror'), 0);
      return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'SecurityError'));
    }
    el = this;
    // Like Chrome: the change event fires, then the promise resolves.
    return new Promise((resolve) => setTimeout(() => { fire('pointerlockchange'); resolve(); }, 0));
  };
  const release = (byUser) => {
    if (!el) return;
    el = null;
    if (byUser) exitedAt = performance.now();
    setTimeout(() => fire('pointerlockchange'), 0);
  };
  Document.prototype.exitPointerLock = function () { release(false); };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && el) { e.stopImmediatePropagation(); e.preventDefault(); release(true); }
  }, true);
  window.addEventListener('blur', () => release(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(true); });
})();`;

const BENIGN =[/favicon/i, /AudioContext/i, /pointer ?lock/i, /GPU stall/i, /GroupMarkerNotSet/i, /404/];

export async function newPlayer(browser: Browser, name: string, opts: { storageState?: string; viewport?: { width: number; height: number } } = {}): Promise<Player> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 720 }, storageState: opts.storageState });
  if (process.env.QA_REAL_LOCK !== '1') await ctx.addInitScript({ content: POINTER_LOCK_SHIM });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !BENIGN.some((r) => r.test(text))) errors.push(`console: ${text}`);
    else logs.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { name, ctx, page, errors, logs };
}

export async function shot(p: Player | Page, file: string): Promise<string> {
  const page = 'page' in p ? p.page : p;
  const path = join(SHOTS, file.endsWith('.jpg') || file.endsWith('.png') ? file : `${file}.jpg`);
  await page.screenshot({ path, type: path.endsWith('.png') ? 'png' : 'jpeg', quality: path.endsWith('.png') ? undefined : 70 });
  return path;
}

/** Keeps the page in front while waiting (background windows are throttled). */
export async function wait(p: Player, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await p.page.bringToFront();
    await p.page.waitForTimeout(Math.min(200, Math.max(1, end - Date.now())));
  }
}

export async function until(p: Player, what: string, fn: () => Promise<boolean>, timeout = 30_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    await p.page.bringToFront();
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`${p.name}: timed out waiting for ${what}`);
    await p.page.waitForTimeout(200);
  }
}

export async function visible(p: Player, selector: string): Promise<boolean> {
  return p.page.locator(selector).first().isVisible().catch(() => false);
}

export async function text(p: Player, selector: string): Promise<string> {
  const l = p.page.locator(selector).first();
  if (!(await l.count())) return '';
  return (await l.innerText().catch(() => '')).trim();
}

export async function clickButton(p: Player, name: string | RegExp): Promise<void> {
  await p.page.getByRole('button', { name }).first().click();
}

export async function openTitle(p: Player, path = '/'): Promise<void> {
  await p.page.goto(URL + path);
  await until(p, 'title screen', async () => (await p.page.getByRole('button', { name: /BunkCraft Realms/ }).count()) > 0, 60_000);
}

/** Title → BunkCraft Realms → name (when asked) → the playlist. */
export async function openRealms(p: Player): Promise<void> {
  await clickButton(p, /BunkCraft Realms/);
  await until(p, 'realms or name', async () => (await visible(p, '.realms-screen')) || (await p.page.locator('input.mc-input:visible').count()) > 0);
  if (!(await visible(p, '.realms-screen'))) {
    await p.page.locator('input.mc-input:visible').first().fill(p.name);
    await p.page.keyboard.press('Enter');
  }
  await until(p, 'realms playlist', () => visible(p, '.realms-item'));
}

/** Is the player in a match (HUD up, the menu gone)? */
export async function inMatch(p: Player): Promise<boolean> {
  return p.page.evaluate(() => {
    const hud = document.querySelector('.arc-hud') as HTMLElement | null;
    return !!hud && hud.isConnected && getComputedStyle(hud).display !== 'none';
  });
}

export async function quickPlay(p: Player, mode: string): Promise<void> {
  await p.page.locator(`.realms-item[data-mode="${mode}"]`).click();
  await clickButton(p, /^(Quick Play|Snel spelen)$/);
  await until(p, 'in match', async () => (await inMatch(p)) || (await visible(p, '.click-to-play')), 90_000);
}

/** Clicks into the game (click-to-play overlay or canvas) and waits for pointer lock. */
export async function lock(p: Player): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (await p.page.evaluate(() => !!document.pointerLockElement)) return true;
    const ctp = p.page.locator('.click-to-play');
    if (await ctp.isVisible().catch(() => false)) await ctp.click({ position: { x: 640, y: 360 } }).catch(() => undefined);
    else await p.page.mouse.click(640, 360);
    await wait(p, 400);
  }
  return p.page.evaluate(() => !!document.pointerLockElement);
}

export async function key(p: Player, code: string, holdMs = 60): Promise<void> {
  await p.page.keyboard.down(code);
  await wait(p, holdMs);
  await p.page.keyboard.up(code);
}

export function report(results: { ok: boolean; name: string; detail?: string }[]): void {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  - ${r.detail}` : ''}`);
}
