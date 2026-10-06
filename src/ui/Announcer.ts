import { h } from './dom';

let region: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;

function ensure(): HTMLDivElement {
  if (!region) {
    region = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'sr-announcer' });
    document.body.append(region);
  }
  return region;
}

/**
 * Tell screen readers something happened ("Game paused", "You died"). The text lives in a visually
 * hidden polite live region; with `visible` it is also shown as a short on-screen note.
 */
let pending = 0;

export function announce(text: string, visible = false): void {
  const r = ensure();
  // Clearing first makes screen readers repeat identical messages.
  r.textContent = '';
  window.clearTimeout(pending);
  pending = window.setTimeout(() => { r.textContent = text; }, 30);
  if (!visible) return;
  if (!toastEl) {
    toastEl = h('div', { class: 'notice', 'aria-hidden': 'true' });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), 3000);
}

/** Empties the live region, so an old message ("You died. ...") does not linger next to the next screen. */
export function clearAnnouncement(): void {
  window.clearTimeout(pending);
  if (region) region.textContent = '';
}
