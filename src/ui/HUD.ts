import { h } from './dom';
import type { Hotbar } from './Hotbar';

/** In-game overlay: crosshair, vignette, underwater tint and the hotbar. */
export class HUD {
  readonly el: HTMLDivElement;
  private readonly water: HTMLDivElement;
  private underwater = false;

  constructor(hotbar: Hotbar) {
    this.water = h('div', { class: 'underwater' });
    this.el = h('div', { class: 'hud hidden' },
      h('div', { class: 'vignette' }),
      this.water,
      h('div', { class: 'crosshair' }),
      hotbar.el,
    );
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  setUnderwater(v: boolean): void {
    if (v === this.underwater) return;
    this.underwater = v;
    this.water.classList.toggle('on', v);
  }
}
