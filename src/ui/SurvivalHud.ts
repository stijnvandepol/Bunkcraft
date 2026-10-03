import { h } from './dom';

// 9×9 icon bitmaps: '.' transparent, 'o' outline, others are palette keys.
const HEART = [
  '.oo...oo.',
  'orrooRrro',
  'orwrrrrro',
  'orrrrrrro',
  '.orrrrro.',
  '..orrro..',
  '...oro...',
  '....o....',
  '.........',
];
const DRUMSTICK = [
  '......oo.',
  '.....owwo',
  '....owwo.',
  '..ooowo..',
  '.obbbbo..',
  'obBbbbo..',
  'obbbbo...',
  'obbbo....',
  '.ooo.....',
];
const BUBBLE = [
  '..ooooo..',
  '.oaaaaao.',
  'oaWWaaaao',
  'oaWaaaaao',
  'oaaaaaaao',
  'oaaaaaaao',
  '.oaaaaao.',
  '..ooooo..',
  '.........',
];

const CHESTPLATE = [
  '.oo...oo.',
  'owgoooddo',
  'owwgggddo',
  '.owgggdo.',
  '.owgggdo.',
  '.owgggdo.',
  '.odgggdo.',
  '..ooooo..',
  '.........',
];

const PALETTE: Record<string, string> = {
  o: '#1a0f0f', r: '#d8221d', R: '#f15b52', w: '#ffd2cf',
  b: '#a8642e', B: '#d18a49', W: '#ffffff', a: '#7ec8ff', g: '#c4c8cc', d: '#8a8f94',
};
const EMPTY: Record<string, string> = { r: '#3a2424', R: '#3a2424', w: '#3a2424', b: '#3a2b1e', B: '#3a2b1e', g: '#3a3d40', d: '#2c2e30' };
// The armor icon's highlight is white where the hearts' is pink.
const ARMOR_PALETTE: Record<string, string> = { ...PALETTE, w: '#ffffff' };
// Heart variants, like Minecraft's status-effect hearts.
const POISON_PALETTE: Record<string, string> = { ...PALETTE, r: '#8c9a1c', R: '#b8c63a', w: '#e2ee9c' };
const WITHER_PALETTE: Record<string, string> = { ...PALETTE, r: '#2a2a2a', R: '#4c4c4c', w: '#8a8a8a' };
const ABSORB_PALETTE: Record<string, string> = { ...PALETTE, r: '#d4af0f', R: '#f2d44a', w: '#fff3b0' };
/** Damage flash: the heart outlines blink white. */
const FLASH_PALETTE: Record<string, string> = { ...PALETTE, o: '#ffffff' };
/** Hardcore hearts: Minecraft's version has a darker "eye" pair on the heart. */
const HARDCORE_HEART = [
  '.oo...oo.',
  'orrooRrro',
  'orwrrrrro',
  'orrorroro',
  '.orrrrro.',
  '..orrro..',
  '...oro...',
  '....o....',
  '.........',
];

export interface SurvivalValues {
  health: number;
  hunger: number;
  air: number;
  maxAir: number;
  /** Armor points 0..20 (the row above the hearts is hidden at 0). */
  armor?: number;
  /** Hardcore world: hearts with the hardcore pattern. */
  hardcore?: boolean;
  /** Poisoned / withered: green or black hearts. */
  poison?: boolean;
  wither?: boolean;
  /** Absorption health (golden hearts after the red ones), in half hearts. */
  absorption?: number;
  /** Ticks left of the hurt animation (PlayerStats.hurtTime): the outlines blink white. */
  hurtTime?: number;
  /** Saturation 0: the hunger bar jitters like Minecraft's. */
  saturation?: number;
}

/**
 * Hearts, hunger and air bubbles above the hotbar (Minecraft layout: hearts left,
 * hunger right, bubbles above hunger). Redrawn only when a value changes.
 */
export class SurvivalHud {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private last = '';
  private lastHealth = -1;
  /** Regeneration wave: a heart jumps up one after the other when health goes up. */
  private regenStart = -10;

  constructor() {
    this.el = h('canvas', { class: 'survival-hud', width: 182, height: 20 });
    this.ctx = this.el.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  update(v: SurvivalValues, time: number): void {
    const lowHealth = v.health <= 4;
    if (this.lastHealth >= 0 && v.health > this.lastHealth) this.regenStart = time;
    this.lastHealth = v.health;
    const regenAge = time - this.regenStart;
    const regen = regenAge >= 0 && regenAge < 0.6;
    const flash = (v.hurtTime ?? 0) > 0 && Math.floor((v.hurtTime ?? 0) / 3) % 2 === 0;
    const starving = v.saturation === 0 && v.hunger < 20;
    const animate = lowHealth || regen || starving;
    // Shaking hearts at low health (and the regen wave, hunger jitter) need a redraw every few frames.
    const key = `${v.health}|${v.hunger}|${Math.ceil(v.air / 30)}|${animate ? Math.floor(time * 12) : 0}|${v.armor ?? 0}|${v.absorption ?? 0}|${flash}|${v.poison}|${v.wither}|${v.hardcore}`;
    if (key === this.last) return;
    this.last = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 182, 20);
    const palette = flash ? FLASH_PALETTE : v.wither ? WITHER_PALETTE : v.poison ? POISON_PALETTE : PALETTE;
    const heart = v.hardcore ? HARDCORE_HEART : HEART;
    const absorb = v.absorption ?? 0;
    for (let i = 0; i < 10; i++) {
      let jitter = lowHealth ? Math.round(Math.sin(time * 40 + i * 7) * 1) : 0;
      if (regen && Math.floor(regenAge * 20) === i) jitter -= 2;
      const fill = v.health - i * 2; // 2 = full, 1 = half, ≤0 = empty
      this.icon(heart, i * 8, 10 + jitter, fill >= 2 ? 1 : fill === 1 ? 0.5 : 0, false, palette);
      // Absorption hearts take the empty containers after the red ones (Minecraft stacks them in a second row).
      const a = absorb - Math.max(0, i * 2 - Math.ceil(v.health / 2) * 2);
      if (absorb > 0 && fill <= 0 && a > 0) this.icon(heart, i * 8, 10 + jitter, a >= 2 ? 1 : 0.5, false, ABSORB_PALETTE);
      if (v.armor) {
        const a = v.armor - i * 2;
        this.icon(CHESTPLATE, i * 8, 0, a >= 2 ? 1 : a === 1 ? 0.5 : 0, false, ARMOR_PALETTE);
      }
      const food = v.hunger - i * 2;
      const shake = starving ? Math.round(Math.sin(time * 37 + i * 5) * 1) : 0;
      this.icon(DRUMSTICK, 182 - 9 - i * 8, 10 + shake, food >= 2 ? 1 : food === 1 ? 0.5 : 0, true);
    }
    if (v.air < v.maxAir) {
      const bubbles = Math.ceil((Math.max(0, v.air) * 10) / v.maxAir);
      for (let i = 0; i < bubbles; i++) this.icon(BUBBLE, 182 - 9 - i * 8, 0, 1, true);
    }
  }

  /** Draws a 9×9 icon; `fill` 1 full, 0.5 half (left half, or right half when mirrored), 0 empty. */
  private icon(rows: string[], x: number, y: number, fill: number, mirrored: boolean, palette: Record<string, string> = PALETTE): void {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const k = rows[r][c];
        if (k === '.') continue;
        const filled = fill >= 1 || (fill > 0 && (mirrored ? c >= 4 : c <= 4));
        this.ctx.fillStyle = k === 'o' ? palette.o : filled ? palette[k] : EMPTY[k] ?? palette[k];
        this.ctx.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
}
