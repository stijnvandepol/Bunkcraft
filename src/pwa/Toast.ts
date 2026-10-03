import { h } from '../ui/dom';

let current: HTMLElement | null = null;
let timer = 0;

/** A short message at the bottom of the screen ("Screenshot saved"). Replaces the previous one. */
export function showToast(text: string, ms = 2500): void {
  current?.remove();
  window.clearTimeout(timer);
  current = h('div', { class: 'pwa-toast', role: 'status', text });
  document.body.append(current);
  timer = window.setTimeout(() => { current?.remove(); current = null; }, ms);
}
