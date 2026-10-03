import { h } from './dom';
import { EffectsHud } from './EffectsHud';
import type { Hotbar } from './Hotbar';
import { SurvivalHud } from './SurvivalHud';

/** In-game overlay: crosshair, vignette, underwater tint, hurt flash, survival bars and hotbar. */
export class HUD {
  readonly el: HTMLDivElement;
  readonly survival = new SurvivalHud();
  /** Status effect icons, attack cooldown bar and absorption hearts. */
  readonly effects = new EffectsHud();
  private readonly water: HTMLDivElement;
  private readonly hurtFlash: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private underwater = false;
  private hurt = -1;

  constructor(private readonly hotbar: Hotbar) {
    this.water = h('div', { class: 'underwater' });
    this.hurtFlash = h('div', { class: 'hurt-flash' });
    this.crosshair = h('div', { class: 'crosshair' });
    hotbar.hudSlot.append(this.effects.absorption, this.survival.el);
    this.el = h('div', { class: 'hud hidden' },
      h('div', { class: 'vignette' }),
      this.water,
      this.hurtFlash,
      this.crosshair,
      this.effects.cooldown,
      this.effects.el,
      hotbar.el,
    );
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  /** Spectators see neither hotbar nor survival bars; creative has no bars. */
  setMode(showHotbar: boolean, showSurvival: boolean): void {
    this.hotbar.el.classList.toggle('hidden', !showHotbar);
    this.survival.setVisible(showSurvival);
  }

  /** Arcade game types replace the crosshair and hotbar with their own HUD. */
  setArcade(on: boolean): void {
    this.el.classList.toggle('arcade', on);
  }

  setUnderwater(v: boolean): void {
    if (v === this.underwater) return;
    this.underwater = v;
    this.water.classList.toggle('on', v);
  }

  /** 0..1 red flash strength after taking damage. */
  setHurt(v: number): void {
    const q = Math.round(v * 20) / 20;
    if (q === this.hurt) return;
    this.hurt = q;
    this.hurtFlash.style.opacity = String(q);
  }
}
