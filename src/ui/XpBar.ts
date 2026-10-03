import { h } from './dom';

/**
 * The experience bar above the hotbar (182×5 GUI pixels, Minecraft's layout) with the level number in green on top.
 * Redrawn only when the filled width or the level changes.
 */
export class XpBar {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly levelEl: HTMLDivElement;
  private lastFill = -1;
  private lastLevel = -1;

  constructor() {
    this.canvas = h('canvas', { class: 'xp-bar', width: 182, height: 5 });
    this.ctx = this.canvas.getContext('2d')!;
    this.levelEl = h('div', { class: 'xp-level' });
    this.el = h('div', { class: 'xp-wrap' }, this.canvas, this.levelEl);
    this.draw(0);
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  /** @param progress 0..1 of the current level */
  update(level: number, progress: number): void {
    const fill = Math.max(0, Math.min(182, Math.floor(progress * 183)));
    if (fill !== this.lastFill) this.draw(fill);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.levelEl.textContent = level > 0 ? String(level) : '';
    }
  }

  private draw(fill: number): void {
    this.lastFill = fill;
    const c = this.ctx;
    c.clearRect(0, 0, 182, 5);
    // Empty bar: dark outline, dark green inside, with notches every 182/18 pixels like the vanilla sprite.
    c.fillStyle = '#000000';
    c.fillRect(0, 0, 182, 5);
    c.fillStyle = '#1e3a12';
    c.fillRect(1, 1, 180, 3);
    if (fill > 0) {
      c.fillStyle = '#80ff20';
      c.fillRect(1, 1, Math.min(180, fill), 3);
      c.fillStyle = '#b8ff70';
      c.fillRect(1, 1, Math.min(180, fill), 1);
      c.fillStyle = '#4cb81a';
      c.fillRect(1, 3, Math.min(180, fill), 1);
    }
    c.fillStyle = '#000000';
    for (let k = 1; k < 18; k++) c.fillRect(Math.round((k * 182) / 18), 1, 1, 3);
  }
}
