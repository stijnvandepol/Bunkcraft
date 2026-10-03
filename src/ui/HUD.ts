import { h } from './dom';
import type { Hotbar } from './Hotbar';
import { SurvivalHud } from './SurvivalHud';

/** In-game overlay: crosshair, vignette, underwater tint, hurt flash, survival bars and hotbar. */
export class HUD {
  readonly el: HTMLDivElement;
  readonly survival = new SurvivalHud();
  private readonly water: HTMLDivElement;
  private readonly hurtFlash: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly attackXh: HTMLDivElement;
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
    // Attack indicator (Options > Video Settings): under the crosshair or next to the hotbar while the
    // attack cooldown recharges. The combat code reports the charge through setAttackCharge().
    this.attackXh = h('div', { class: 'attack-xh hidden' }, h('i'));
    this.attackFill = h('i');
    this.attackBar = h('div', { class: 'attack-hotbar hidden' }, this.attackFill);
    hotbar.el.append(this.attackBar);
    hotbar.hudSlot.append(this.survival.el);
    this.el = h('div', { class: 'hud hidden' },
      h('div', { class: 'vignette' }),
      this.water,
      this.hurtFlash,
      this.crosshair,
      this.attackXh,
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

  /** Attack cooldown 0..1 (1 = fully charged, indicator hidden). DOM is touched only when the shown step changes. */
  setAttackCharge(v: number): void {
    const q = v >= 1 || this.attackMode === 'off' ? 1 : Math.floor(v * 16) / 16;
    if (q === this.attackShown) return;
    this.attackShown = q;
    const show = q < 1;
    this.attackXh.classList.toggle('hidden', !show || this.attackMode !== 'crosshair');
    this.attackBar.classList.toggle('hidden', !show || this.attackMode !== 'hotbar');
    const pct = `${Math.round(q * 100)}%`;
    (this.attackXh.firstElementChild as HTMLElement).style.width = pct;
    this.attackFill.style.height = pct;
  }

  /** 0..1 red flash strength after taking damage. */
  setHurt(v: number): void {
    const q = Math.round(v * 20) / 20;
    if (q === this.hurt) return;
    this.hurt = q;
    this.hurtFlash.style.opacity = String(q);
  }
}
