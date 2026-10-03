/**
 * Keyboard navigation for the menu screens: arrow keys move the focus to the nearest control in that direction
 * (so the two-column Options grids work), Tab and Enter are native, Esc is handled by the game. Minecraft draws the
 * focused control with a white border, which the `:focus-visible` styles in styles.css do.
 */

export interface Box { x: number; y: number; w: number; h: number }
export type Dir = 'up' | 'down' | 'left' | 'right';

/** Index of the box to focus when moving `dir` from box `from`, or -1 when nothing lies that way. */
export function nextFocus(boxes: readonly Box[], from: number, dir: Dir): number {
  if (boxes.length === 0) return -1;
  if (from < 0 || from >= boxes.length) return dir === 'up' || dir === 'left' ? boxes.length - 1 : 0;
  const a = boxes[from];
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    if (i === from) continue;
    const b = boxes[i];
    const dx = b.x + b.w / 2 - ax, dy = b.y + b.h / 2 - ay;
    // Must lie in the direction of travel (rows and columns are told apart by half a control).
    const vertical = dir === 'up' || dir === 'down';
    const along = vertical ? (dir === 'down' ? dy : -dy) : dir === 'right' ? dx : -dx;
    const across = Math.abs(vertical ? dx : dy);
    const minAlong = (vertical ? a.h : a.w) / 2;
    if (along < minAlong * 0.5) continue;
    // Prefer the same column/row, then the nearest one.
    const score = along + across * 3;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]';

function visibleControls(root: HTMLElement): HTMLElement[] {
  const top = [...root.children].filter((c) => !c.classList.contains('hidden')).pop();
  if (!top) return [];
  return [...top.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/** Installs the arrow key handler for the screens container; returns an uninstall function. */
export function installMenuNav(root: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    const dir: Dir | null = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : null;
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement) {
      // Text boxes keep Left/Right for the caret; sliders keep them for their value. Up/Down always navigate.
      if ((dir === 'left' || dir === 'right') && target.type !== 'button') return;
    }
    const controls = visibleControls(root);
    if (controls.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const from = active ? controls.indexOf(active) : -1;
    const to = nextFocus(controls.map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }), from, dir);
    if (to < 0) return;
    e.preventDefault();
    controls[to].focus();
    controls[to].scrollIntoView({ block: 'nearest' });
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
