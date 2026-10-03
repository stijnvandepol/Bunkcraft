/**
 * Optional "Lock Esc in fullscreen" (Chromium only): with the Keyboard Lock API the page itself
 * receives Escape in fullscreen, so Esc pauses the game instead of dropping out of fullscreen.
 * Holding Esc for a second still leaves fullscreen. Off by default; stored in localStorage.
 */

const KEY = 'bunkcraft.lockEsc';

interface KeyboardLockApi { lock(codes?: string[]): Promise<void>; unlock(): void }

function api(): KeyboardLockApi | null {
  const k = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
  return k && typeof k.lock === 'function' ? k : null;
}

export function keyboardLockSupported(): boolean {
  return api() !== null;
}

export function keyboardLockEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** True while Escape is being delivered to the page as a key press. */
let active = false;
export function keyboardLockActive(): boolean {
  return active;
}

function sync(): void {
  const k = api();
  if (!k) return;
  if (document.fullscreenElement && keyboardLockEnabled()) {
    k.lock(['Escape']).then(() => { active = true; }, () => { active = false; });
  } else {
    k.unlock();
    active = false;
  }
}

export function setKeyboardLockEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode: lasts for this session only */ }
  sync();
}

/** Call once at startup. */
export function initKeyboardLock(): void {
  document.addEventListener('fullscreenchange', sync);
}
