import { soundArrow, subtitleText } from '../core/Accessibility';
import { h } from './dom';

const MAX_LINES = 5;
const LIFETIME = 3.2;

interface Line {
  key: string;
  el: HTMLDivElement;
  left: number;
}

/**
 * Sound captions in the bottom right ("[Zombie groans] ←"). Repeated sounds refresh one line instead
 * of stacking; the arrow shows which side of the player the sound came from. Text lives in an
 * aria-live log so screen readers announce new captions as well.
 */
export class Subtitles {
  readonly el: HTMLDivElement;
  enabled = false;
  private readonly lines: Line[] = [];

  constructor() {
    this.el = h('div', { class: 'subtitles hidden', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Sound captions' });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  /**
   * @param dx,dz world offset from the listener to the sound (omit for non-positional sounds)
   * @param yaw   the listener's yaw
   */
  push(label: string, dx = 0, dz = 0, yaw = 0): void {
    if (!this.enabled) return;
    const text = subtitleText(label, soundArrow(dx, dz, yaw));
    const key = text;
    const existing = this.lines.find((l) => l.key === key);
    if (existing) {
      existing.left = LIFETIME;
      return;
    }
    const el = h('div', { class: 'subtitle', text });
    this.el.append(el);
    this.lines.push({ key, el, left: LIFETIME });
    while (this.lines.length > MAX_LINES) this.lines.shift()!.el.remove();
    this.el.classList.remove('hidden');
  }

  update(dt: number): void {
    if (this.lines.length === 0) return;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.left -= dt;
      if (l.left <= 0) {
        l.el.remove();
        this.lines.splice(i, 1);
      } else if (l.left < 0.5) l.el.style.opacity = String(l.left / 0.5);
      else if (l.el.style.opacity) l.el.style.opacity = '';
    }
    if (this.lines.length === 0) this.el.classList.add('hidden');
  }

  clear(): void {
    for (const l of this.lines) l.el.remove();
    this.lines.length = 0;
    this.el.classList.add('hidden');
  }
}
