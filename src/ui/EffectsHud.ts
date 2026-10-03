import { EFFECT_DEFS, EFFECT_IDS, type EffectId, type EffectSet, formatDuration, roman } from '../player/Effects';
import { h } from './dom';
import './survivalRules.css';

/**
 * Status effect icons with timers (top right, like Minecraft), the attack cooldown bar under the crosshair and the row of
 * golden Absorption hearts. All icons are drawn procedurally: a tinted tile with a small glyph per kind of effect.
 */

// 9×9 glyphs: 'o' outline, 'x' main colour (white), 'k' dark. Shared between effects of the same kind.
const GLYPHS: Record<string, string[]> = {
  arrowUp: ['....x....', '...xxx...', '..xxxxx..', '.xxxxxxx.', '...xxx...', '...xxx...', '...xxx...', '.........', '.........'],
  arrowDown: ['.........', '...xxx...', '...xxx...', '...xxx...', '.xxxxxxx.', '..xxxxx..', '...xxx...', '....x....', '.........'],
  pick: ['..xxxxx..', '.xx.x.xx.', 'xx..x..xx', '....x....', '....x....', '....x....', '....x....', '.........', '.........'],
  fist: ['.xx.xx...', 'xxxxxxx..', 'xxxxxxxx.', 'xxxxxxxx.', '.xxxxxx..', '..xxxx...', '.........', '.........', '.........'],
  heart: ['.xx...xx.', 'xxxx.xxxx', 'xxxxxxxxx', 'xxxxxxxxx', '.xxxxxxx.', '..xxxxx..', '...xxx...', '....x....', '.........'],
  skull: ['..xxxxx..', '.xxxxxxx.', 'xx.xxx.xx', 'xx.xxx.xx', 'xxxxxxxxx', '.xxxxxxx.', '..x.x.x..', '..x.x.x..', '.........'],
  boot: ['..xxx....', '..xxx....', '..xxx....', '..xxx....', '..xxxxxx.', '.xxxxxxxx', 'xxxxxxxxx', '.........', '.........'],
  shield: ['xxxxxxxxx', 'xxxxxxxxx', 'xxxxxxxxx', 'xxxxxxxxx', '.xxxxxxx.', '..xxxxx..', '...xxx...', '....x....', '.........'],
  flame: ['....x....', '...xx....', '..xxx.x..', '..xxxxx..', '.xxxxxxx.', '.xxxxxxx.', '.xxxxxxx.', '..xxxxx..', '.........'],
  bubble: ['..xxxxx..', '.x.....x.', 'x.xx....x', 'x.x.....x', 'x.......x', 'x.......x', '.x.....x.', '..xxxxx..', '.........'],
  eye: ['.........', '..xxxxx..', '.xxkkkxx.', 'xxxkkkxxx', '.xxkkkxx.', '..xxxxx..', '.........', '.........', '.........'],
  food: ['......xx.', '.....xxxx', '....xxxx.', '..xxxxx..', '.xxxxx...', 'xxxxx....', 'xxxx.....', 'xxx......', '.........'],
  feather: ['......xxx', '....xxxxx', '...xxxxx.', '..xxxxx..', '.xxxxx...', 'xxxxx....', 'xxx......', 'x........', '.........'],
};

const GLYPH_OF: Record<EffectId, string> = {
  speed: 'arrowUp', slowness: 'arrowDown', haste: 'pick', mining_fatigue: 'pick', strength: 'fist', weakness: 'fist',
  instant_health: 'heart', instant_damage: 'skull', jump_boost: 'boot', regeneration: 'heart', resistance: 'shield',
  fire_resistance: 'flame', water_breathing: 'bubble', invisibility: 'eye', night_vision: 'eye', hunger: 'food',
  poison: 'skull', wither: 'skull', absorption: 'heart', saturation: 'food', levitation: 'feather',
};

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
function shade(c: number, k: number): string {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k)), g = Math.min(255, Math.round(((c >> 8) & 255) * k)), b = Math.min(255, Math.round((c & 255) * k));
  return `rgb(${r},${g},${b})`;
}

/** Draws the 18×18 icon of an effect onto a canvas. */
export function drawEffectIcon(canvas: HTMLCanvasElement, id: EffectId): void {
  const ctx = canvas.getContext('2d')!;
  const def = EFFECT_DEFS[id];
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 18, 18);
  // Tile: dark rim, tinted body with a light top edge.
  ctx.fillStyle = shade(def.color, 0.35);
  ctx.fillRect(0, 0, 18, 18);
  ctx.fillStyle = hex(def.color);
  ctx.fillRect(1, 1, 16, 16);
  ctx.fillStyle = shade(def.color, 1.35);
  ctx.fillRect(1, 1, 16, 1);
  ctx.fillRect(1, 1, 1, 16);
  ctx.fillStyle = shade(def.color, 0.7);
  ctx.fillRect(1, 16, 16, 1);
  ctx.fillRect(16, 1, 1, 16);
  // Glyph in white with a dark shadow, 9×9 at 1:1 placed in the middle (the tile is 16 px).
  const rows = GLYPHS[GLYPH_OF[id]];
  for (const [dx, dy, color] of [[1, 1, 'rgba(0,0,0,0.55)'], [0, 0, '#fff']] as [number, number, string][]) {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const k = rows[r][c];
      if (k === '.') continue;
      ctx.fillStyle = k === 'k' ? (dx ? 'rgba(0,0,0,0)' : '#202030') : color;
      ctx.fillRect(5 + c + dx, 4 + r + dy, 1, 1);
    }
  }
  // Harmful effects get a red corner, so they read at a glance.
  if (def.harmful) {
    ctx.fillStyle = '#e03030';
    ctx.fillRect(14, 2, 2, 2);
  }
}

interface Entry { el: HTMLDivElement; level: HTMLSpanElement; time: HTMLSpanElement; icon: HTMLCanvasElement }

const HEART_GOLD = [
  '.oo...oo.', 'oyyooYyyo', 'oywyyyyyo', 'oyyyyyyyo', '.oyyyyyo.', '..oyyyo..', '...oyo...', '....o....',
];

export class EffectsHud {
  /** Top right column of effect icons. */
  readonly el: HTMLDivElement;
  /** Cooldown bar under the crosshair. */
  readonly cooldown: HTMLDivElement;
  private readonly cooldownFill: HTMLElement;
  /** Row of golden hearts above the health hearts. */
  readonly absorption: HTMLCanvasElement;
  private readonly entries = new Map<EffectId, Entry>();
  private version = -1;
  private lastSecond = -1;
  private lastCooldown = -1;
  private lastAbsorption = -1;

  constructor() {
    this.el = h('div', { class: 'effects-hud' });
    this.cooldownFill = h('i');
    this.cooldown = h('div', { class: 'attack-indicator hidden' }, this.cooldownFill);
    this.absorption = h('canvas', { class: 'absorption-hud hidden', width: 82, height: 9 });
  }

  /** Redraws the icon column when the set changed or a timer ticked over to the next second. */
  updateEffects(set: EffectSet, time: number): void {
    const list = set.list();
    const seconds = Math.floor(time);
    // Icons blink for the last 10 seconds, so those need frequent updates.
    const blinking = list.some((e) => e.duration <= 200);
    if (set.version === this.version && seconds === this.lastSecond && !blinking) return;
    this.version = set.version;
    this.lastSecond = seconds;
    const present = new Set<EffectId>();
    for (const e of list) {
      present.add(e.id);
      let en = this.entries.get(e.id);
      if (!en) {
        const icon = h('canvas', { class: 'effect-icon', width: 18, height: 18 });
        drawEffectIcon(icon, e.id);
        const level = h('span', { class: 'effect-level' });
        const timeEl = h('span', { class: 'effect-time' });
        const el = h('div', { class: 'effect-tile', title: EFFECT_DEFS[e.id].name }, icon, level, timeEl);
        en = { el, level, time: timeEl, icon };
        this.entries.set(e.id, en);
      }
      en.level.textContent = e.amp > 0 ? roman(e.amp + 1) : '';
      en.time.textContent = formatDuration(e.duration);
      // Last 10 seconds: the icon pulses.
      en.el.style.opacity = e.duration <= 200 ? String(0.55 + 0.45 * Math.abs(Math.sin(time * 4))) : '1';
      en.el.classList.toggle('harmful', EFFECT_DEFS[e.id].harmful);
    }
    // Keep the column in effect order; drop what ended.
    for (const [id, en] of this.entries) {
      if (!present.has(id)) { en.el.remove(); this.entries.delete(id); }
    }
    for (const id of EFFECT_IDS) {
      const en = this.entries.get(id);
      if (en && !en.el.isConnected) this.el.append(en.el);
    }
    this.el.classList.toggle('empty', list.length === 0);
  }

  /** Attack cooldown 0..1 under the crosshair; hidden when charged (like Minecraft). */
  updateCooldown(charge: number, visible: boolean): void {
    const q = Math.round(charge * 32) / 32;
    const show = visible && q < 1;
    const key = show ? q : -1;
    if (key === this.lastCooldown) return;
    this.lastCooldown = key;
    this.cooldown.classList.toggle('hidden', !show);
    this.cooldownFill.style.width = `${q * 100}%`;
  }

  /** Golden hearts for the Absorption effect (2 health each), at most 10. */
  updateAbsorption(amount: number): void {
    const q = Math.ceil(amount);
    if (q === this.lastAbsorption) return;
    this.lastAbsorption = q;
    this.absorption.classList.toggle('hidden', q <= 0);
    const ctx = this.absorption.getContext('2d')!;
    ctx.clearRect(0, 0, 82, 9);
    const palette: Record<string, string> = { o: '#3a2a00', y: '#e8b800', Y: '#fff08a', w: '#fff6c8' };
    const hearts = Math.min(10, Math.ceil(q / 2));
    for (let i = 0; i < hearts; i++) {
      const half = i === hearts - 1 && q % 2 === 1;
      for (let r = 0; r < HEART_GOLD.length; r++) for (let c = 0; c < 9; c++) {
        const k = HEART_GOLD[r][c];
        if (k === '.') continue;
        if (half && c > 4 && k !== 'o') continue;
        ctx.fillStyle = palette[k];
        ctx.fillRect(i * 8 + c, r, 1, 1);
      }
    }
  }
}
