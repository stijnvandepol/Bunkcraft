import { ARMOR_SLOTS, HOTBAR_SLOTS, INVENTORY_SLOTS, PlayerInventory } from '../items/Inventory';
import { type ItemStack, cloneStack, getItemDef, itemName, maxDurability, sameItem } from '../items/ItemRegistry';
import { RECIPES, RECIPE_CATEGORIES, type Recipe, type Station, canCraft, craft, recipeCategory } from '../items/Recipes';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';
import { glintOverlay, hasGlint, tooltipNodes } from './ItemTooltip';

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
  /** Station screens (enchanting table, anvil, grindstone): controls shown next to the slots. */
  extra?: HTMLElement;
  /** Extra class on the container block (station layouts). */
  className?: string;
  /** Index of a result slot: nothing can be put in; clicking it takes `takeOutput()` (which pays and uses up the inputs). */
  output?: number;
  takeOutput?(): ItemStack | null;
  /** Slots that only take some items (lapis in the enchanting table). */
  accepts?(index: number, stack: ItemStack): boolean;
  /** The screen closes: station inputs go back to the player. */
  onClose?(): void;
  /** Set by the inventory while open: redraws the slots after the station changed them itself. */
  requestRender?: () => void;
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
  private readonly boxExtra: HTMLDivElement;
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

  constructor(private readonly icons: BlockIcons, private readonly inv: PlayerInventory, private readonly actions: SurvivalInventoryActions) {
    this.tooltip = h('div', { class: 'mc-tooltip hidden' });
    this.cursorEl = h('div', { class: 'cursor-stack hidden' });
    this.main = h('div', { class: 'inv-grid' });
    this.armorCol = h('div', { class: 'inv-armor' });
    this.hotbarRow = h('div', { class: 'inv-grid inv-hotbar' });
    this.boxGrid = h('div', { class: 'inv-grid' });
    this.boxTitle = h('div', { class: 'inv-title' });
    this.boxExtra = h('div', { class: 'inv-box-extra' });
    this.boxWrap = h('div', { class: 'inv-box hidden' }, this.boxTitle, h('div', { class: 'inv-box-row' }, this.boxGrid, this.boxExtra));
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

  open(stations: Set<Station>, box: ContainerView | null = null): void {
    this.stations = stations;
    this.box = box;
    this.boxWrap.classList.toggle('hidden', !box);
    this.recipePane.classList.toggle('hidden', !!box);
    this.boxTitle.textContent = box?.title ?? '';
    this.boxWrap.className = `inv-box${box ? '' : ' hidden'}${box?.className ? ` ${box.className}` : ''}`;
    this.boxExtra.replaceChildren(...(box?.extra ? [box.extra] : []));
    if (box) box.requestRender = () => { if (this.box === box) this.renderSlots(); };
    this.el.classList.remove('hidden');
    this.renderSlots();
    if (!box) this.renderRecipes();
  }

  close(): void {
    this.flushCursor();
    const box = this.box;
    this.box = null;
    box?.onClose?.();
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

  /** Armor slots take only the matching piece; a station's slots decide for themselves; result slots take nothing. */
  private accepts(ref: SlotRef, stack: ItemStack): boolean {
    if (ref.group === 'box') {
      if (this.box?.output === ref.index) return false;
      return this.box?.accepts ? this.box.accepts(ref.index, stack) : true;
    }
    return ref.group !== 'armor' || getItemDef(stack.id)?.armor?.slot === ref.index;
  }

  /** Clicking a station's result slot: pick the result up (or add it to an equal stack on the cursor). */
  private takeOutput(toInventory: boolean): void {
    const box = this.box;
    if (!box?.takeOutput) return;
    const preview = box.slots[box.output!];
    if (!preview?.id) return;
    const cur = this.cursor;
    if (!toInventory && cur.count > 0 && (!sameItem(cur, preview) || cur.count + preview.count > PlayerInventory.maxStack(cur.id))) return;
    const out = box.takeOutput();
    if (!out) return;
    if (toInventory) {
      const left = this.inv.add(out);
      if (left > 0) this.actions.drop({ ...cloneStack(out), count: left });
    } else if (cur.count > 0) cur.count += out.count;
    else this.cursor = cloneStack(out);
  }

  private slotEl(stack: ItemStack, extraClass = ''): HTMLDivElement {
    const icon = stack.id ? this.icons.get(stack.id) : '';
    const el = h('div', { class: `inv-slot ${extraClass}` },
      stack.id ? h('img', { src: icon, draggable: false, alt: '' }) : null,
      hasGlint(stack) ? glintOverlay(icon) : null,
      stack.count > 1 ? h('span', { class: 'slot-count', text: String(stack.count) }) : null);
    const max = maxDurability(stack.id);
    if (max && stack.damage) {
      const wear = 1 - stack.damage / max;
      el.append(h('div', { class: 'slot-durability' }, h('i', { style: `width:${Math.round(wear * 100)}%;background:hsl(${Math.round(wear * 120)},100%,50%)` })));
    }
    return el;
  }

  private tooltipOn(el: HTMLElement, text: () => string | HTMLElement[]): void {
    el.addEventListener('mouseenter', () => {
      const t = text();
      if (!t || t.length === 0) return;
      if (typeof t === 'string') this.tooltip.textContent = t;
      else this.tooltip.replaceChildren(...t);
      this.tooltip.classList.remove('hidden');
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
  }

  private makeSlot(ref: SlotRef, extra = ''): HTMLDivElement {
    const el = this.slotEl(this.get(ref), extra);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (ref.group === 'box' && this.box?.output === ref.index) {
        this.takeOutput(e.shiftKey);
        this.renderCursor();
        this.renderSlots();
        return;
      }
      if (e.shiftKey) this.quickMove(ref);
      else this.click(ref, e.button === 2);
    });
    this.tooltipOn(el, () => {
      const nodes = tooltipNodes(this.get(ref));
      return nodes.length ? nodes : ref.group === 'armor' ? ['Helmet', 'Chestplate', 'Leggings', 'Boots'][ref.index] : '';
    });
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
    const ok = (i: number): boolean => this.accepts({ group: 'box', index: i }, stack);
    for (let i = 0; i < slots.length && left > 0 && max > 1; i++) {
      if (ok(i) && sameItem(slots[i], stack) && slots[i].count < max) {
        const n = Math.min(left, max - slots[i].count);
        slots[i].count += n;
        left -= n;
      }
    }
    for (let i = 0; i < slots.length && left > 0; i++) {
      if (slots[i].id === 0 && ok(i)) {
        const n = Math.min(left, this.box!.accepts ? Math.min(max, 64) : max);
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
