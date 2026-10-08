/**
 * Line icons of the menu shell (24×24, drawn in code, currentColor). Static strings only: safe for innerHTML.
 */
const PATHS = {
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/><circle cx="12" cy="12" r="6.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6"/><path d="M15.5 4.8a3.4 3.4 0 0 1 0 6.4M18 14.6c2 .7 3.2 2.6 3.5 5.4"/>',
  cube: '<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M4 7.4 12 12l8-4.6M12 12v9.2"/>',
  crate: '<path d="M3 7h18v13H3zM3 7l2.5-3.5h13L21 7M9 11h6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12.5 16V8M17 16v-3"/>',
  trophy: '<path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0zM7.5 6H4.5c0 3 1.4 4.6 3.4 4.9M16.5 6h3c0 3-1.4 4.6-3.4 4.9M12 13.5V17M8 20.5h8M9.5 17h5v3.5h-5z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.4 4-6.8 8-6.8s7.2 2.4 8 6.8"/>',
  crown: '<path d="M3.5 19h17M4.2 17 2.8 7.2l5.2 4.3L12 4.6l4 6.9 5.2-4.3L19.8 17z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
} as const;

export type ShellIcon = keyof typeof PATHS;

/** An icon as an inline SVG string (aria-hidden: the button next to it carries the label). */
export function iconSvg(name: ShellIcon): string {
  return `<svg class="bc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
}

/** An icon element. */
export function iconEl(name: ShellIcon): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'bc-icon-wrap';
  s.innerHTML = iconSvg(name);
  return s;
}
