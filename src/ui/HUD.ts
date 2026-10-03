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
  private readonly attackBar: HTMLDivElement;
  private readonly attackFill: HTMLElement;
  private underwater = false;
  private hurt = -1;
  private attackMode: 'crosshair' | 'hotbar' | 'off' = 'crosshair';
  private attackShown = -1;

  constructor(private readonly hotbar: Hotbar) {
    this.water = h('div', { class: 'underwater' });
    this.hurtFlash = h('div', { class: 'hurt-flash' });
    this.crosshair = h('div', { class: 'crosshair' });
    // Attack Indicator "Hotbar" (Options > Video Settings): a recharging square next to the hotbar. The
    // "Crosshair" variant is the cooldown bar of EffectsHud.
    this.attackFill = h('i');
    this.attackBar = h('div', { class: 'attack-hotbar hidden' }, this.attackFill);
    hotbar.el.append(this.attackBar);
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

  setAttackIndicator(mode: 'crosshair' | 'hotbar' | 'off'): void {
    this.attackMode = mode;
    this.attackShown = -1;
    this.setAttackCharge(1);
  }

  /** Attack cooldown 0..1 for the Hotbar indicator (1 = charged, hidden). DOM is touched only when the shown step changes. */
  setAttackCharge(v: number): void {
    const q = v >= 1 || this.attackMode !== 'hotbar' ? 1 : Math.floor(v * 16) / 16;
    if (q === this.attackShown) return;
    this.attackShown = q;
    this.attackBar.classList.toggle('hidden', q >= 1);
    this.attackFill.style.height = `${Math.round(q * 100)}%`;
  }

  /** 0..1 red flash strength after taking damage. */
  setHurt(v: number): void {
    const q = Math.round(v * 20) / 20;
    if (q === this.hurt) return;
    this.hurt = q;
    this.hurtFlash.style.opacity = String(q);
  }
}
