import { enchantLabel } from '../items/EnchantRules';
import {
  type TableOffer, TOO_EXPENSIVE, anvilCombine, applyOffer, canPayOffer, glyphText, grindstoneResult, tableAccepts, tableOffers,
} from '../items/Enchanting';
import { customName } from '../items/EnchantRules';
import { ITEM, ITEM_ID, type ItemStack, cloneStack, maxDurability } from '../items/ItemRegistry';
import { mulberry32 } from '../world/Noise';
import { h } from './dom';
import type { ContainerView } from './SurvivalInventory';

/**
 * The screens of the enchanting table, anvil and grindstone, as container views for the survival inventory (their input
 * slots sit above the player's inventory, the station's own controls next to them). The rules live in items/Enchanting;
 * this file only wires slots, buttons and costs.
 */
export interface StationContext {
  level(): number;
  creative(): boolean;
  /** Pays levels (false when the player has too few); creative pays nothing. */
  spendLevels(n: number): boolean;
  enchantSeed(): number;
  /** The player enchanted something: pick a new seed. */
  nextSeed(): void;
  /** Bookshelves around the enchanting table (0..15). */
  bookshelves: number;
  /** Experience from the grindstone (spawned as orbs at the block). */
  giveXp(points: number): void;
  /** Gives a stack back to the player (closing the screen with items in it). */
  give(stack: ItemStack): void;
  /** Sounds: enchanting, the anvil hammer, the grindstone. */
  sound(kind: 'enchant' | 'anvil' | 'grindstone'): void;
  /** The anvil was used (it may get damaged). */
  anvilUsed?(): void;
}

const EMPTY = (): ItemStack => ({ id: 0, count: 0 });

function giveBack(ctx: StationContext, slots: ItemStack[], inputs: number[]): void {
  for (const i of inputs) {
    if (slots[i].id && slots[i].count > 0) ctx.give(cloneStack(slots[i]));
    slots[i] = EMPTY();
  }
}

// ---------------------------------------------------------------- glyphs ("standard galactic alphabet")

/** A 6×7 pixel glyph per letter, made from a fixed seed so every letter always looks the same. */
const GLYPHS: number[][] = Array.from({ length: 26 }, (_, k) => {
  const r = mulberry32(0x5eed + k * 977);
  const px: number[] = [];
  // A vertical or horizontal stroke plus a few hooks: reads like runes rather than noise.
  const stem = Math.floor(r() * 5);
  for (let y = 0; y < 7; y++) px.push(y * 6 + stem);
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(r() * 6), y = Math.floor(r() * 7);
    const len = 1 + Math.floor(r() * 3);
    for (let j = 0; j < len; j++) px.push(y * 6 + Math.min(5, x + j));
  }
  return px;
});

/** Draws glyph text (letters a..z and spaces) into a canvas, 7 GUI pixels per letter. */
export function drawGlyphs(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string): void {
  ctx.fillStyle = colour;
  let cx = x;
  for (const ch of text) {
    const k = ch.charCodeAt(0) - 97;
    if (k >= 0 && k < 26) for (const p of GLYPHS[k]) ctx.fillRect(cx + (p % 6), y + Math.floor(p / 6), 1, 1);
    cx += ch === ' ' ? 4 : 7;
  }
}

// ---------------------------------------------------------------- enchanting table

const LAPIS = (): number => ITEM_ID.lapis_lazuli;

export function enchantingView(ctx: StationContext): ContainerView {
  const slots: ItemStack[] = [EMPTY(), EMPTY()];
  const offersEl = h('div', { class: 'ench-offers' });
  const info = h('div', { class: 'station-note' });
  const extra = h('div', { class: 'ench-panel' }, offersEl, info);
  let offers: TableOffer[] = [];

  const render = (): void => {
    const item = slots[0];
    offers = item.id ? tableOffers(ctx.enchantSeed(), item, ctx.bookshelves) : [];
    const lapis = slots[1].id === LAPIS() ? slots[1].count : 0;
    const level = ctx.level();
    const creative = ctx.creative();
    offersEl.replaceChildren(...[0, 1, 2].map((slot) => {
      const o = offers[slot];
      const active = !!o && o.cost > 0 && o.list.length > 0;
      const affordable = active && canPayOffer(o, level, lapis, creative);
      const row = h('div', { class: `ench-offer${active ? '' : ' empty'}${affordable ? ' ok' : ''}` });
      if (active) {
        const glyphs = h('canvas', { class: 'ench-glyphs', width: 90, height: 9 });
        const g = glyphs.getContext('2d')!;
        drawGlyphs(g, glyphText(o.glyphSeed, 12), 1, 1, affordable ? '#685e4a' : '#342f25');
        row.append(
          h('span', { class: 'ench-lapis', text: String(o.price) }),
          glyphs,
          h('span', { class: 'ench-cost', text: String(o.cost) }),
        );
        const clue = o.clue ? `${enchantLabel(o.clue.key, o.clue.level)} . . . ?` : '';
        const need = [clue, `${o.price} Lapis Lazuli`, `${o.price} Enchantment Level${o.price > 1 ? 's' : ''}`];
        if (!creative && level < o.cost) need.push(`Level Requirement: ${o.cost}`);
        row.title = need.filter(Boolean).join('\n');
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!affordable) return;
          if (!ctx.spendLevels(o.price)) return;
          slots[0] = applyOffer(slots[0], o);
          if (!creative) {
            slots[1].count -= o.price;
            if (slots[1].count <= 0) slots[1] = EMPTY();
          }
          ctx.nextSeed();
          ctx.sound('enchant');
          view.onChange?.();
          view.requestRender?.();
        });
      }
      return row;
    }));
    info.textContent = item.id && !tableAccepts(item) ? 'This item cannot be enchanted' : `Bookshelves: ${ctx.bookshelves}`;
  };

  const view: ContainerView = {
    title: 'Enchant',
    slots,
    extra,
    className: 'station station-enchant',
    accepts: (i, s) => (i === 1 ? s.id === LAPIS() : true),
    onChange: render,
    onClose: () => giveBack(ctx, slots, [0, 1]),
  };
  render();
  return view;
}

// ---------------------------------------------------------------- anvil

export function anvilView(ctx: StationContext): ContainerView {
  const slots: ItemStack[] = [EMPTY(), EMPTY(), EMPTY()];
  const name = h('input', { class: 'inv-search anvil-name', type: 'text', maxLength: 24, spellcheck: false, placeholder: '' });
  const cost = h('div', { class: 'anvil-cost' });
  const extra = h('div', { class: 'anvil-panel' }, name, cost);
  let lastLeft = '';
  let outcome: ReturnType<typeof anvilCombine> = { kind: 'none' };
  for (const type of ['keydown', 'keyup'] as const) name.addEventListener(type, (e) => e.stopPropagation());

  const compute = (): void => {
    const left = slots[0];
    // A new item in the left slot puts its name in the text box (like Minecraft).
    const key = left.id ? `${left.id}:${customName(left.data)}` : '';
    if (key !== lastLeft) {
      lastLeft = key;
      name.value = left.id ? customName(left.data) : '';
      name.disabled = !left.id;
    }
    const wanted = left.id ? name.value : null;
    const renaming = wanted !== null && wanted.trim() !== customName(left.data) ? wanted : null;
    outcome = left.id ? anvilCombine(left, slots[1], renaming, ctx.creative()) : { kind: 'none' };
    slots[2] = outcome.kind === 'ok' ? cloneStack(outcome.value.result) : EMPTY();
    const level = ctx.level();
    if (outcome.kind === 'expensive') {
      cost.textContent = 'Too Expensive!';
      cost.className = 'anvil-cost bad';
    } else if (outcome.kind === 'ok' && !ctx.creative()) {
      const c = outcome.value.cost;
      cost.textContent = `Enchantment Cost: ${c}`;
      cost.className = `anvil-cost${level >= c ? '' : ' bad'}`;
    } else {
      cost.textContent = '';
      cost.className = 'anvil-cost';
    }
  };
  name.addEventListener('input', () => {
    compute();
    view.requestRender?.();
  });

  const view: ContainerView = {
    title: 'Repair & Name',
    slots,
    extra,
    output: 2,
    className: 'station station-anvil',
    onChange: compute,
    takeOutput: () => {
      if (outcome.kind !== 'ok') return null;
      const { result, cost: c, materialUsed } = outcome.value;
      if (!ctx.creative() && ctx.level() < c) return null;
      if (!ctx.spendLevels(c)) return null;
      slots[0] = EMPTY();
      if (materialUsed > 0) {
        slots[1].count -= materialUsed;
        if (slots[1].count <= 0) slots[1] = EMPTY();
      } else slots[1] = EMPTY();
      ctx.sound('anvil');
      ctx.anvilUsed?.();
      compute();
      return result;
    },
    onClose: () => giveBack(ctx, slots, [0, 1]),
  };
  compute();
  return view;
}

/** Highest cost the anvil accepts in survival (shown in docs and tests). */
export const ANVIL_LIMIT = TOO_EXPENSIVE;

// ---------------------------------------------------------------- grindstone

export function grindstoneView(ctx: StationContext): ContainerView {
  const slots: ItemStack[] = [EMPTY(), EMPTY(), EMPTY()];
  const note = h('div', { class: 'station-note', text: 'Removes enchantments and gives back some experience' });
  const accepts = (_i: number, s: ItemStack): boolean => maxDurability(s.id) > 0 || s.id === ITEM.ENCHANTED_BOOK;
  const compute = (): void => {
    const r = grindstoneResult(slots[0], slots[1]);
    slots[2] = r ? cloneStack(r.result) : EMPTY();
  };
  const view: ContainerView = {
    title: 'Repair & Disenchant',
    slots,
    extra: h('div', { class: 'grind-panel' }, note),
    output: 2,
    className: 'station station-grindstone',
    accepts,
    onChange: compute,
    takeOutput: () => {
      const r = grindstoneResult(slots[0], slots[1]);
      if (!r) return null;
      slots[0] = EMPTY();
      slots[1] = EMPTY();
      if (r.xp > 0) ctx.giveXp(r.xp);
      ctx.sound('grindstone');
      compute();
      return r.result;
    },
    onClose: () => giveBack(ctx, slots, [0, 1]),
  };
  compute();
  return view;
}
