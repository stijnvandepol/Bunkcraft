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

/** Colour-blind-safe heart and hunger colours (see core/Accessibility.ts). */
const SAFE: Record<string, string> = { r: '#d6217f', R: '#ff6fb3', w: '#ffd6ea', b: '#e8c61c', B: '#fff07a' };
const NORMAL: Record<string, string> = { r: PALETTE.r, R: PALETTE.R, w: PALETTE.w, b: PALETTE.b, B: PALETTE.B };
let paletteVersion = 0;

/** Switch the hearts and hunger icons to the colour-blind-safe palette (and back). */
export function setSurvivalColorBlind(on: boolean): void {
  Object.assign(PALETTE, on ? SAFE : NORMAL);
  paletteVersion++;
}

export interface SurvivalValues {
  health: number;
  hunger: number;
  air: number;
  maxAir: number;
  /** Armor points 0..20 (the row above the hearts is hidden at 0). */
  armor?: number;
}

/**
 * Hearts, hunger and air bubbles above the hotbar (Minecraft layout: hearts left,
 * hunger right, bubbles above hunger). Redrawn only when a value changes.
 */
export class SurvivalHud {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private last = '';

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
    // Shaking hearts at low health need a redraw every few frames.
    const key = `${paletteVersion}|${v.health}|${v.hunger}|${Math.ceil(v.air / 30)}|${lowHealth ? Math.floor(time * 12) : 0}|${v.armor ?? 0}`;
    if (key === this.last) return;
    this.last = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 182, 20);
    for (let i = 0; i < 10; i++) {
      const jitter = lowHealth ? Math.round(Math.sin(time * 40 + i * 7) * 1) : 0;
      const fill = v.health - i * 2; // 2 = full, 1 = half, ≤0 = empty
      this.icon(HEART, i * 8, 10 + jitter, fill >= 2 ? 1 : fill === 1 ? 0.5 : 0, false);
      if (v.armor) {
        const a = v.armor - i * 2;
        this.icon(CHESTPLATE, i * 8, 0, a >= 2 ? 1 : a === 1 ? 0.5 : 0, false, ARMOR_PALETTE);
      }
      const food = v.hunger - i * 2;
      this.icon(DRUMSTICK, 182 - 9 - i * 8, 10, food >= 2 ? 1 : food === 1 ? 0.5 : 0, true);
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
