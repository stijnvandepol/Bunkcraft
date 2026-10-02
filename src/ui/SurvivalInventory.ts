import { HOTBAR_SLOTS, INVENTORY_SLOTS, PlayerInventory } from '../items/Inventory';
import { type ItemStack, getItemDef, itemName } from '../items/ItemRegistry';
import { RECIPES, type Recipe, type Station, canCraft, craft } from '../items/Recipes';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';

export interface SurvivalInventoryActions {
  /** Throw a stack out of the inventory (clicked outside the panel / leftovers). */
  drop(stack: ItemStack): void;
  close(): void;
}

const STATION_NAMES: Record<Station, string> = { hand: '', table: 'Crafting Table', furnace: 'Furnace' };

/**
 * Survival inventory in Minecraft's style: 27 storage slots + hotbar with cursor-stack
 * clicking (left = pick up / place / merge / swap, right = split / place one) and a
 * recipe book next to it. Table and furnace recipes need that block within reach.
 */
export class SurvivalInventory {
  readonly el: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly hotbarRow: HTMLDivElement;
  private readonly recipes: HTMLDivElement;
  private readonly recipeTitle: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private readonly cursorEl: HTMLDivElement;
  private cursor: ItemStack = { id: 0, count: 0 };
  private stations = new Set<Station>();

  constructor(private readonly icons: BlockIcons, private readonly inv: PlayerInventory, private readonly actions: SurvivalInventoryActions) {
    this.tooltip = h('div', { class: 'mc-tooltip hidden' });
    this.cursorEl = h('div', { class: 'cursor-stack hidden' });
    this.main = h('div', { class: 'inv-grid' });
    this.hotbarRow = h('div', { class: 'inv-grid inv-hotbar' });
    this.recipes = h('div', { class: 'recipe-list' });
    this.recipeTitle = h('div', { class: 'inv-subtitle' });
    const panel = h('div', { class: 'inv-panel', style: 'width: auto' },
      h('div', { class: 'inv-columns' },
        h('div', {},
          h('div', { class: 'inv-title', text: 'Inventory' }),
          this.main,
          this.hotbarRow,
        ),
        h('div', {}, this.recipeTitle, this.recipes),
      ),
    );
    this.el = h('div', { class: 'screen inventory hidden' }, panel, this.tooltip, this.cursorEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousedown', (e) => {
      if (e.target !== this.el) return;
      // Clicking outside the panel throws the cursor stack (or closes when empty).
      if (this.cursor.count > 0) {
        const n = e.button === 2 ? 1 : this.cursor.count;
        this.actions.drop({ ...this.cursor, count: n });
        this.cursor.count -= n;
        if (this.cursor.count === 0) this.cursor = { id: 0, count: 0 };
        this.renderCursor();
      } else {
        this.actions.close();
      }
    });
    this.el.addEventListener('mousemove', (e) => {
      this.tooltip.style.left = `${e.clientX + 12}px`;
      this.tooltip.style.top = `${e.clientY - 24}px`;
      this.cursorEl.style.left = `${e.clientX - 12}px`;
      this.cursorEl.style.top = `${e.clientY - 12}px`;
    });
  }

  /** Re-render after the inventory changed elsewhere (pickups while open). */
  refresh(): void {
    if (this.isOpen) this.renderSlots();
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(stations: Set<Station>): void {
    this.stations = stations;
    this.el.classList.remove('hidden');
    this.renderSlots();
    this.renderRecipes();
  }

  close(): void {
    // Anything still on the cursor goes back into the inventory (or is dropped).
    if (this.cursor.count > 0) {
      const left = this.inv.add(this.cursor);
      if (left > 0) this.actions.drop({ ...this.cursor, count: left });
      this.cursor = { id: 0, count: 0 };
      this.renderCursor();
    }
    this.el.classList.add('hidden');
    this.tooltip.classList.add('hidden');
  }

  private slotEl(stack: ItemStack, extraClass = ''): HTMLDivElement {
    const el = h('div', { class: `inv-slot ${extraClass}` },
      stack.id ? h('img', { src: this.icons.get(stack.id), draggable: false, alt: '' }) : null,
      stack.count > 1 ? h('span', { class: 'slot-count', text: String(stack.count) }) : null);
    const tool = getItemDef(stack.id)?.tool;
    if (tool && stack.damage) {
      const wear = 1 - stack.damage / tool.durability;
      el.append(h('div', { class: 'slot-durability' }, h('i', { style: `width:${Math.round(wear * 100)}%;background:hsl(${Math.round(wear * 120)},100%,50%)` })));
    }
    return el;
  }

  private tooltipOn(el: HTMLElement, text: () => string): void {
    el.addEventListener('mouseenter', () => {
      const t = text();
      if (!t) return;
      this.tooltip.textContent = t;
      this.tooltip.classList.remove('hidden');
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
  }

  private renderSlots(): void {
    const make = (i: number) => {
      const el = this.slotEl(this.inv.get(i));
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.clickSlot(i, e.button === 2);
      });
      this.tooltipOn(el, () => itemName(this.inv.get(i).id));
      return el;
    };
    this.main.replaceChildren(...Array.from({ length: INVENTORY_SLOTS - HOTBAR_SLOTS }, (_, k) => make(HOTBAR_SLOTS + k)));
    this.hotbarRow.replaceChildren(...Array.from({ length: HOTBAR_SLOTS }, (_, k) => make(k)));
    if (this.isOpen) this.renderRecipes();
  }

  private clickSlot(i: number, right: boolean): void {
    const slot = this.inv.get(i);
    const cur = this.cursor;
    const max = PlayerInventory.maxStack(slot.id || cur.id);
    if (!right) {
      if (cur.count === 0) {
        this.cursor = { ...slot };
        this.inv.set(i, { id: 0, count: 0 });
      } else if (slot.id === 0) {
        this.inv.set(i, cur);
        this.cursor = { id: 0, count: 0 };
      } else if (slot.id === cur.id && max > 1) {
        const n = Math.min(cur.count, max - slot.count);
        this.inv.set(i, { ...slot, count: slot.count + n });
        cur.count -= n;
        if (cur.count === 0) this.cursor = { id: 0, count: 0 };
      } else {
        this.inv.set(i, cur);
        this.cursor = { ...slot };
      }
    } else if (cur.count === 0 && slot.count > 0) {
      // Right click on a stack: take half (rounded up).
      const half = Math.ceil(slot.count / 2);
      this.cursor = { ...slot, count: half };
      this.inv.set(i, { ...slot, count: slot.count - half });
    } else if (cur.count > 0 && (slot.id === 0 || (slot.id === cur.id && slot.count < max))) {
      // Right click with a stack: place one item.
      this.inv.set(i, { id: cur.id, count: slot.count + 1, damage: cur.damage });
      cur.count--;
      if (cur.count === 0) this.cursor = { id: 0, count: 0 };
    }
    this.renderCursor();
    this.renderSlots();
  }

  private renderCursor(): void {
    const c = this.cursor;
    this.cursorEl.classList.toggle('hidden', c.count === 0);
    this.cursorEl.replaceChildren(...(c.count ? [
      h('img', { src: this.icons.get(c.id), alt: '' }),
      c.count > 1 ? h('span', { class: 'slot-count', text: String(c.count) }) : '',
    ] : []));
  }

  private renderRecipes(): void {
    const near = [...this.stations].filter((s) => s !== 'hand').map((s) => STATION_NAMES[s]);
    this.recipeTitle.textContent = near.length ? `Crafting (${near.join(', ')})` : 'Crafting';
    const visible = RECIPES.filter((r) => r.station === 'hand' || this.stations.has(r.station));
    // Craftable recipes first, like the recipe book's "craftable" filter.
    visible.sort((a, b) => Number(canCraft(this.inv, b, this.stations)) - Number(canCraft(this.inv, a, this.stations)));
    this.recipes.replaceChildren(...visible.map((r) => {
      const ok = canCraft(this.inv, r, this.stations);
      const el = this.slotEl(r.result, ok ? '' : 'disabled');
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.craftRecipe(r);
      });
      this.tooltipOn(el, () => `${r.result.count > 1 ? `${r.result.count}× ` : ''}${itemName(r.result.id)} ← ${r.ingredients
        .map((ing) => `${ing.count} ${itemName(ing.ids[0])}${ing.ids.length > 1 ? ' (any)' : ''}`).join(' + ')}`);
      return el;
    }));
  }

  private craftRecipe(r: Recipe): void {
    const left = craft(this.inv, r, this.stations);
    if (left > 0) this.actions.drop({ id: r.result.id, count: left });
    this.renderSlots();
  }
}
