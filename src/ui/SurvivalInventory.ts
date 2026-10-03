import { ARMOR_SLOTS, HOTBAR_SLOTS, INVENTORY_SLOTS, PlayerInventory } from '../items/Inventory';
import { type ItemStack, cloneStack, getItemDef, itemName, maxDurability, sameItem } from '../items/ItemRegistry';
import { RECIPES, RECIPE_CATEGORIES, type Recipe, type Station, canCraft, craft, recipeCategory } from '../items/Recipes';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';

export interface SurvivalInventoryActions {
  /** Throw a stack out of the inventory (clicked outside the panel / leftovers). */
  drop(stack: ItemStack): void;
  close(): void;
}

/** A chest (or any container) shown above the inventory: its slots are edited in place. */
export interface ContainerView {
  title: string;
  slots: ItemStack[];
  /** Called after every change (the world saves the container). */
  onChange?(): void;
}

const STATION_NAMES: Record<Station, string> = { hand: '', table: 'Crafting Table', furnace: 'Furnace' };
const EMPTY: ItemStack = { id: 0, count: 0 };

/** Where a slot lives: the player's inventory, worn armor or an open container. */
interface SlotRef {
  group: 'inv' | 'armor' | 'box';
  index: number;
}

/**
 * Survival inventory in Minecraft's style: 27 storage slots + hotbar + 4 armor slots with cursor-stack clicking
 * (left = pick up / place / merge / swap, right = split / place one, shift = move to the other side) and a recipe
 * book next to it with categories, search and a "craftable" filter. With a container open (a chest) its slots
 * show above the inventory instead of the recipe book. Table and furnace recipes need that block within reach.
 */
export class SurvivalInventory {
  readonly el: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly armorCol: HTMLDivElement;
  private readonly hotbarRow: HTMLDivElement;
  private readonly boxGrid: HTMLDivElement;
  private readonly boxTitle: HTMLDivElement;
  private readonly boxWrap: HTMLDivElement;
  private readonly recipePane: HTMLDivElement;
  private readonly recipes: HTMLDivElement;
  private readonly recipeTitle: HTMLDivElement;
  private readonly recipeTabs: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly tooltip: HTMLDivElement;
  private readonly cursorEl: HTMLDivElement;
  private cursor: ItemStack = { id: 0, count: 0 };
  private stations = new Set<Station>();
  private box: ContainerView | null = null;
  private category: string = 'craftable';
  /** Slot under the mouse: the target of number keys (swap with the hotbar) and Q (drop). */
  private hovered: SlotRef | null = null;

  constructor(private readonly icons: BlockIcons, private readonly inv: PlayerInventory, private readonly actions: SurvivalInventoryActions) {
    this.tooltip = h('div', { class: 'mc-tooltip hidden' });
    this.cursorEl = h('div', { class: 'cursor-stack hidden' });
    this.main = h('div', { class: 'inv-grid' });
    this.armorCol = h('div', { class: 'inv-armor' });
    this.hotbarRow = h('div', { class: 'inv-grid inv-hotbar' });
    this.boxGrid = h('div', { class: 'inv-grid' });
    this.boxTitle = h('div', { class: 'inv-title' });
    this.boxWrap = h('div', { class: 'inv-box hidden' }, this.boxTitle, this.boxGrid);
    this.recipes = h('div', { class: 'recipe-list' });
    this.recipeTitle = h('div', { class: 'inv-subtitle' });
    this.recipeTabs = h('div', { class: 'recipe-tabs' });
    this.search = h('input', { class: 'inv-search recipe-search', type: 'text', placeholder: 'Search', maxLength: 40, spellcheck: false });
    for (const type of ['keydown', 'keyup'] as const) this.search.addEventListener(type, (e) => e.stopPropagation());
    this.search.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.actions.close(); });
    this.search.addEventListener('input', () => this.renderRecipes());
    this.recipePane = h('div', { class: 'recipe-pane' }, this.recipeTitle, this.search, this.recipeTabs, this.recipes);
    const panel = h('div', { class: 'inv-panel', style: 'width: auto' },
      h('div', { class: 'inv-columns' },
        h('div', {},
          this.boxWrap,
          h('div', { class: 'inv-title', text: 'Inventory' }),
          h('div', { class: 'inv-armor-row' }, this.armorCol, this.main),
          this.hotbarRow,
        ),
        this.recipePane,
      ),
    );
    this.el = h('div', { class: 'screen inventory hidden' }, panel, this.tooltip, this.cursorEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousedown', (e) => {
      if (e.target !== this.el) return;
      // Clicking outside the panel throws the cursor stack (or closes when empty).
      if (this.cursor.count > 0) {
        const n = e.button === 2 ? 1 : this.cursor.count;
        this.actions.drop({ ...cloneStack(this.cursor), count: n });
        this.cursor.count -= n;
        if (this.cursor.count === 0) this.cursor = { id: 0, count: 0 };
        this.renderCursor();
      } else {
        this.actions.close();
      }
    });
    // Tooltip and cursor stack follow the pointer with transforms only (no layout work per mouse move).
    this.el.addEventListener('mousemove', (e) => {
      this.tooltip.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY - 24}px, 0)`;
      this.cursorEl.style.transform = `translate3d(${e.clientX - 12}px, ${e.clientY - 12}px, 0)`;
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /**
   * Minecraft's inventory keys over the hovered slot: 1–9 swap it with that hotbar slot, Q drops one item
   * (Ctrl+Q the whole stack).
   */
  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen || !this.hovered || e.target === this.search || this.cursor.count > 0) return;
    const ref = this.hovered;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const hot: SlotRef = { group: 'inv', index: Number(digit[1]) - 1 };
      if (hot.group === ref.group && hot.index === ref.index) return;
      const a = cloneStack(this.get(ref)), b = cloneStack(this.get(hot));
      if ((b.count && !this.accepts(ref, b)) || (a.count && !this.accepts(hot, a))) return;
      this.set(ref, b);
      this.set(hot, a);
      this.renderSlots();
    } else if (e.code === 'KeyQ') {
      const s = this.get(ref);
      if (!s.count) return;
      const n = e.ctrlKey || e.metaKey ? s.count : 1;
      this.actions.drop({ ...cloneStack(s), count: n });
      this.set(ref, { ...cloneStack(s), count: s.count - n });
      this.renderSlots();
    }
  }

  /** Double click with a stack on the cursor: collect matching items from the inventory, up to a full stack. */
  private collect(): void {
    const cur = this.cursor;
    const max = PlayerInventory.maxStack(cur.id);
    for (let i = 0; i < INVENTORY_SLOTS && cur.count < max; i++) {
      const s = this.inv.get(i);
      if (!s.count || !sameItem(s, cur)) continue;
      const n = Math.min(s.count, max - cur.count);
      cur.count += n;
      this.inv.set(i, { ...cloneStack(s), count: s.count - n });
    }
    this.renderCursor();
    this.renderSlots();
  }

  /** Re-render after the inventory changed elsewhere (pickups while open). */
  refresh(): void {
    if (this.isOpen) this.renderSlots();
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(stations: Set<Station>, box: ContainerView | null = null): void {
    this.stations = stations;
    this.box = box;
    this.boxWrap.classList.toggle('hidden', !box);
    this.recipePane.classList.toggle('hidden', !!box);
    this.boxTitle.textContent = box?.title ?? '';
    this.el.classList.remove('hidden');
    this.renderSlots();
    if (!box) this.renderRecipes();
  }

  close(): void {
    this.flushCursor();
    this.el.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.search.blur();
    this.box = null;
  }

  /** Anything still on the cursor goes back into the inventory (or is dropped). */
  flushCursor(): void {
    if (this.cursor.count > 0) {
      const left = this.inv.add(this.cursor);
      if (left > 0) this.actions.drop({ ...cloneStack(this.cursor), count: left });
      this.cursor = { id: 0, count: 0 };
      this.renderCursor();
    }
  }

  // ---------------------------------------------------------------- slots

  private get(ref: SlotRef): ItemStack {
    if (ref.group === 'armor') return this.inv.armor[ref.index];
    if (ref.group === 'box') return this.box?.slots[ref.index] ?? EMPTY;
    return this.inv.get(ref.index);
  }

  private set(ref: SlotRef, stack: ItemStack): void {
    const s = stack.count > 0 && stack.id > 0 ? cloneStack(stack) : { id: 0, count: 0 };
    if (ref.group === 'armor') this.inv.setArmor(ref.index, s);
    else if (ref.group === 'box') {
      if (this.box) this.box.slots[ref.index] = s;
      this.box?.onChange?.();
    } else this.inv.set(ref.index, s);
  }

  /** Armor slots take only the matching piece. */
  private accepts(ref: SlotRef, stack: ItemStack): boolean {
    return ref.group !== 'armor' || getItemDef(stack.id)?.armor?.slot === ref.index;
  }

  private slotEl(stack: ItemStack, extraClass = ''): HTMLDivElement {
    const el = h('div', { class: `inv-slot ${extraClass}` },
      stack.id ? h('img', { src: this.icons.get(stack.id), draggable: false, alt: '' }) : null,
      stack.count > 1 ? h('span', { class: 'slot-count', text: String(stack.count) }) : null);
    const max = maxDurability(stack.id);
    if (max && stack.damage) {
      const wear = 1 - stack.damage / max;
      el.append(h('div', { class: 'slot-durability' }, h('i', { style: `width:${Math.round(wear * 100)}%;background:hsl(${Math.round(wear * 120)},100%,50%)` })));
    }
    return el;
  }

  /** Minecraft tooltip: the name in white, then grey lore lines (item data, durability). */
  private tooltipOn(el: HTMLElement, text: () => string, stack?: () => ItemStack): void {
    el.addEventListener('mouseenter', () => {
      const t = text();
      if (!t) return;
      const s = stack?.();
      const lines: string[] = [];
      if (s?.data) for (const [k, v] of Object.entries(s.data)) lines.push(`${k.replace(/_/g, ' ')}: ${v}`);
      const max = s ? maxDurability(s.id) : 0;
      if (s && max && s.damage) lines.push(`Durability: ${max - s.damage} / ${max}`);
      this.tooltip.replaceChildren(
        h('div', { class: 'tip-name', text: s?.count ? itemName(s.id) : t }),
        ...lines.map((l) => h('div', { class: 'tip-lore', text: l })),
      );
      this.tooltip.classList.remove('hidden');
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
  }

  private stackName(stack: ItemStack): string {
    const data = stack.data ? Object.entries(stack.data).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') : '';
    return itemName(stack.id) + (data ? ` (${data})` : '');
  }

  private makeSlot(ref: SlotRef, extra = ''): HTMLDivElement {
    const el = this.slotEl(this.get(ref), extra);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.shiftKey) this.quickMove(ref);
      else if (e.detail === 2 && e.button === 0 && this.cursor.count > 0 && ref.group !== 'armor') this.collect();
      else this.click(ref, e.button === 2);
    });
    el.addEventListener('mouseenter', () => { this.hovered = ref; });
    el.addEventListener('mouseleave', () => { if (this.hovered === ref) this.hovered = null; });
    this.tooltipOn(el, () => this.stackName(this.get(ref)) || (ref.group === 'armor' ? ['Helmet', 'Chestplate', 'Leggings', 'Boots'][ref.index] : ''), () => this.get(ref));
    return el;
  }

  private renderSlots(): void {
    this.armorCol.replaceChildren(...Array.from({ length: ARMOR_SLOTS }, (_, k) => this.makeSlot({ group: 'armor', index: k }, `armor-slot a${k}`)));
    this.main.replaceChildren(...Array.from({ length: INVENTORY_SLOTS - HOTBAR_SLOTS }, (_, k) => this.makeSlot({ group: 'inv', index: HOTBAR_SLOTS + k })));
    this.hotbarRow.replaceChildren(...Array.from({ length: HOTBAR_SLOTS }, (_, k) => this.makeSlot({ group: 'inv', index: k })));
    if (this.box) this.boxGrid.replaceChildren(...this.box.slots.map((_, k) => this.makeSlot({ group: 'box', index: k })));
    if (this.isOpen && !this.box) this.renderRecipes();
  }

  private click(ref: SlotRef, right: boolean): void {
    const slot = this.get(ref);
    const cur = this.cursor;
    const max = PlayerInventory.maxStack(slot.id || cur.id);
    if (cur.count > 0 && !this.accepts(ref, cur)) return;
    if (!right) {
      if (cur.count === 0) {
        this.cursor = cloneStack(slot);
        this.set(ref, { id: 0, count: 0 });
      } else if (slot.id === 0) {
        this.set(ref, cur);
        this.cursor = { id: 0, count: 0 };
      } else if (sameItem(slot, cur) && max > 1) {
        const n = Math.min(cur.count, max - slot.count);
        this.set(ref, { ...cloneStack(slot), count: slot.count + n });
        cur.count -= n;
        if (cur.count === 0) this.cursor = { id: 0, count: 0 };
      } else {
        this.set(ref, cur);
        this.cursor = cloneStack(slot);
      }
    } else if (cur.count === 0 && slot.count > 0) {
      // Right click on a stack: take half (rounded up).
      const half = Math.ceil(slot.count / 2);
      this.cursor = { ...cloneStack(slot), count: half };
      this.set(ref, { ...cloneStack(slot), count: slot.count - half });
    } else if (cur.count > 0 && (slot.id === 0 || (sameItem(slot, cur) && slot.count < max))) {
      // Right click with a stack: place one item.
      this.set(ref, { ...cloneStack(cur), count: slot.count + 1 });
      cur.count--;
      if (cur.count === 0) this.cursor = { id: 0, count: 0 };
    }
    this.renderCursor();
    this.renderSlots();
  }

  /** Shift click: armor is worn, a container's items go to the inventory and the other way round. */
  private quickMove(ref: SlotRef): void {
    const slot = this.get(ref);
    if (!slot.id) return;
    if (ref.group === 'armor') {
      this.set(ref, { id: 0, count: this.inv.add(slot) });
    } else if (ref.group === 'box') {
      const left = this.inv.add(slot);
      this.set(ref, left > 0 ? { ...cloneStack(slot), count: left } : { id: 0, count: 0 });
    } else if (this.box) {
      const left = this.addToBox(slot);
      this.set(ref, left > 0 ? { ...cloneStack(slot), count: left } : { id: 0, count: 0 });
    } else {
      const piece = getItemDef(slot.id)?.armor;
      if (piece && !this.inv.armor[piece.slot].id) {
        this.inv.setArmor(piece.slot, { ...cloneStack(slot), count: 1 });
        this.set(ref, { ...cloneStack(slot), count: slot.count - 1 });
      }
    }
    this.renderSlots();
  }

  private addToBox(stack: ItemStack): number {
    const slots = this.box!.slots;
    const max = PlayerInventory.maxStack(stack.id);
    let left = stack.count;
    for (let i = 0; i < slots.length && left > 0 && max > 1; i++) {
      if (sameItem(slots[i], stack) && slots[i].count < max) {
        const n = Math.min(left, max - slots[i].count);
        slots[i].count += n;
        left -= n;
      }
    }
    for (let i = 0; i < slots.length && left > 0; i++) {
      if (slots[i].id === 0) {
        const n = Math.min(left, max);
        slots[i] = { ...cloneStack(stack), count: n };
        left -= n;
      }
    }
    this.box!.onChange?.();
    return left;
  }

  private renderCursor(): void {
    const c = this.cursor;
    this.cursorEl.classList.toggle('hidden', c.count === 0);
    this.cursorEl.replaceChildren(...(c.count ? [
      h('img', { src: this.icons.get(c.id), alt: '' }),
      c.count > 1 ? h('span', { class: 'slot-count', text: String(c.count) }) : '',
    ] : []));
  }

  // ---------------------------------------------------------------- recipe book

  private recipeText(r: Recipe): string {
    return `${r.result.count > 1 ? `${r.result.count}× ` : ''}${itemName(r.result.id)} ← ${r.ingredients
      .map((ing) => `${ing.count} ${itemName(ing.ids[0])}${ing.ids.length > 1 ? ' (any)' : ''}`).join(' + ')}`;
  }

  private renderRecipes(): void {
    const near = [...this.stations].filter((s) => s !== 'hand').map((s) => STATION_NAMES[s]);
    this.recipeTitle.textContent = near.length ? `Crafting (${near.join(', ')})` : 'Crafting';
    const tabs = [{ id: 'craftable', name: 'Now' }, ...RECIPE_CATEGORIES];
    this.recipeTabs.replaceChildren(...tabs.map((t) => {
      const el = h('div', { class: `recipe-tab${t.id === this.category ? ' active' : ''}`, text: t.name });
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.category = t.id;
        this.renderRecipes();
      });
      return el;
    }));
    const q = this.search.value.trim().toLowerCase();
    let visible = RECIPES.filter((r) => r.station === 'hand' || this.stations.has(r.station));
    if (this.category === 'craftable') visible = visible.filter((r) => canCraft(this.inv, r, this.stations));
    else if (this.category !== 'all') visible = visible.filter((r) => recipeCategory(r) === this.category);
    if (q) visible = visible.filter((r) => itemName(r.result.id).toLowerCase().includes(q) || r.ingredients.some((ing) => ing.ids.some((i) => itemName(i).toLowerCase().includes(q))));
    // Craftable recipes first, like the recipe book's "craftable" filter.
    const ok = new Map(visible.map((r) => [r, canCraft(this.inv, r, this.stations)] as const));
    visible = [...visible].sort((a, b) => Number(ok.get(b)) - Number(ok.get(a)));
    // A long list is cut off (the search finds the rest) so opening the inventory stays fast.
    const shown = visible.slice(0, 160);
    this.recipes.replaceChildren(...shown.map((r) => {
      const el = this.slotEl(r.result, ok.get(r) ? '' : 'disabled');
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.craftRecipe(r);
      });
      this.tooltipOn(el, () => this.recipeText(r));
      return el;
    }));
    if (!shown.length) this.recipes.append(h('div', { class: 'recipe-empty', text: 'Nothing to craft here' }));
  }

  private craftRecipe(r: Recipe): void {
    const left = craft(this.inv, r, this.stations);
    if (left > 0) this.actions.drop({ id: r.result.id, count: left });
    this.renderSlots();
  }
}
