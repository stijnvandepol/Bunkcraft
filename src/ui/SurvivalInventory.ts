import { ARMOR_SLOTS, HOTBAR_SLOTS, INVENTORY_SLOTS, PlayerInventory } from '../items/Inventory';
import { type ItemStack, cloneStack, getItemDef, itemName, maxDurability, sameItem } from '../items/ItemRegistry';
import { RECIPES, RECIPE_CATEGORIES, type Recipe, type Station, canCraft, craft, recipeCategory } from '../items/Recipes';
import { type ContainerClick, type ContainerKind, clickStacks, quickInsert, slotAccepts, slotTakeOnly } from '../items/ContainerOps';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';
import { glintOverlay, hasGlint, tooltipNodes } from './ItemTooltip';

export interface SurvivalInventoryActions {
  /** Throw a stack out of the inventory (clicked outside the panel / leftovers). */
  drop(stack: ItemStack): void;
  close(): void;
}

/** A chest, furnace or other container shown above the inventory. */
export interface ContainerView {
  title: string;
  /** Default 'chest' (a grid of 9 columns). A furnace shows input, fuel, output, flame and arrow. */
  kind?: ContainerKind;
  /** The slots; edited in place unless the view is `remote`. */
  readonly slots: ItemStack[];
  /** Called after every change (the world saves the container, a furnace wakes up). */
  onChange?(): void;
  /** Furnace screen: cooking progress and remaining flame, 0..1. */
  furnace?(): { progress: number; flame: number };
  /** The furnace output was taken (singleplayer: hand out the stored experience). */
  onTakeOutput?(): void;
  /** The screen was closed. */
  onClose?(): void;
  /**
   * Multiplayer: clicks on the container (and shift-clicks into it) go to the server, which answers with the new
   * contents and cursor (see ContainerController). `busy` is true while a click waits for its answer.
   */
  remote?: { click(c: ContainerClick, cursor: ItemStack): void; busy(): boolean };
  /** Station screens (enchanting table, anvil, grindstone): controls shown next to the slots. */
  extra?: HTMLElement;
  /** Extra class on the container block (station layouts). */
  className?: string;
  /** Index of a result slot: nothing can be put in; clicking it takes `takeOutput()` (which pays and uses up the inputs). */
  output?: number;
  takeOutput?(): ItemStack | null;
  /** Station slots that only take some items (lapis in the enchanting table). */
  accepts?(index: number, stack: ItemStack): boolean;
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
  private readonly furnaceEl: HTMLDivElement;
  private readonly boxExtra: HTMLDivElement;
  private readonly flameEl: HTMLDivElement;
  private readonly arrowEl: HTMLDivElement;
  private boxSig = '';
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
    this.flameEl = h('div', { class: 'furnace-flame' }, h('i', {}));
    this.arrowEl = h('div', { class: 'furnace-arrow' }, h('i', {}));
    this.furnaceEl = h('div', { class: 'furnace-ui hidden' });
    this.boxExtra = h('div', { class: 'inv-box-extra' });
    this.boxWrap = h('div', { class: 'inv-box hidden' }, this.boxTitle, h('div', { class: 'inv-box-row' }, this.boxGrid, this.boxExtra), this.furnaceEl);
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

  /** The stack on the mouse cursor (multiplayer clicks send it to the server). */
  get cursorStack(): ItemStack {
    return this.cursor;
  }

  /** The server decided what is on the cursor (answer to a container click). */
  setCursor(stack: ItemStack): void {
    this.cursor = stack.count > 0 ? cloneStack(stack) : { id: 0, count: 0 };
    this.renderCursor();
  }

  /** The open container view, if any. */
  get container(): ContainerView | null {
    return this.isOpen ? this.box : null;
  }

  /** Re-renders the container part when its contents changed (a furnace at work, another player in the same chest). */
  refreshBox(force = false): void {
    if (!this.isOpen || !this.box) return;
    const sig = JSON.stringify(this.box.slots);
    if (force || sig !== this.boxSig) this.renderSlots();
    this.renderFurnaceBars();
  }

  private renderFurnaceBars(): void {
    const f = this.box?.furnace?.();
    if (!f) return;
    (this.flameEl.firstChild as HTMLElement).style.height = `${Math.round(f.flame * 100)}%`;
    (this.arrowEl.firstChild as HTMLElement).style.width = `${Math.round(f.progress * 100)}%`;
  }

  open(stations: Set<Station>, box: ContainerView | null = null): void {
    this.stations = stations;
    this.box = box;
    const furnace = box?.kind === 'furnace';
    this.boxGrid.classList.toggle('hidden', furnace);
    this.furnaceEl.classList.toggle('hidden', !furnace);
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
    this.el.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.search.blur();
    const box = this.box;
    this.box = null;
    box?.onClose?.();
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

  /** Armor slots take only the matching piece; a furnace's fuel slot only fuel and its output nothing. */
  private accepts(ref: SlotRef, stack: ItemStack): boolean {
    if (ref.group === 'box' && this.isStation) return this.box!.output !== ref.index && (this.box!.accepts?.(ref.index, stack) ?? true);
    if (ref.group === 'box') return slotAccepts(this.box?.kind ?? 'chest', ref.index, stack);
    return ref.group !== 'armor' || getItemDef(stack.id)?.armor?.slot === ref.index;
  }

  /** An enchanting table, anvil or grindstone: its own slot rules and a result slot. */
  private get isStation(): boolean {
    return !!this.box && (this.box.output !== undefined || !!this.box.accepts);
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

  /** Shift click into a station: the first input slot that takes the item. */
  private addToStation(stack: ItemStack): number {
    const slots = this.box!.slots;
    const max = PlayerInventory.maxStack(stack.id);
    let left = stack.count;
    for (let i = 0; i < slots.length && left > 0; i++) {
      if (!this.accepts({ group: 'box', index: i }, stack)) continue;
      if (slots[i].id === 0) {
        const n = Math.min(left, max);
        slots[i] = { ...cloneStack(stack), count: n };
        left -= n;
      } else if (max > 1 && sameItem(slots[i], stack) && slots[i].count < max) {
        const n = Math.min(left, max - slots[i].count);
        slots[i].count += n;
        left -= n;
      }
    }
    this.box!.onChange?.();
    return left;
  }

  private takeOnly(ref: SlotRef): boolean {
    if (ref.group === 'box' && this.isStation) return false;
    return ref.group === 'box' && slotTakeOnly(this.box?.kind ?? 'chest', ref.index);
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
      if (ref.group === 'box' && this.box?.output === ref.index && this.box.takeOutput) {
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
    if (this.box?.kind === 'furnace') this.renderFurnace();
    else if (this.box) this.boxGrid.replaceChildren(...this.box.slots.map((_, k) => this.makeSlot({ group: 'box', index: k })));
    if (this.box) this.boxSig = JSON.stringify(this.box.slots);
    if (this.isOpen && !this.box) this.renderRecipes();
  }

  /** The furnace screen: input over flame over fuel on the left, the progress arrow, the output on the right. */
  private renderFurnace(): void {
    const slots = [0, 1, 2].map((k) => this.makeSlot({ group: 'box', index: k }, ['furnace-in', 'furnace-fuel', 'furnace-out'][k]));
    this.furnaceEl.replaceChildren(h('div', { class: 'furnace-left' }, slots[0], this.flameEl, slots[1]), this.arrowEl, slots[2]);
    this.renderFurnaceBars();
  }

  /** Click with the cursor (the same rules as the server: items/ContainerOps). */
  private click(ref: SlotRef, right: boolean): void {
    // Waiting for the server's answer to a container click: the cursor is in flight.
    if (this.box?.remote?.busy()) return;
    const remote = ref.group === 'box' ? this.box?.remote : undefined;
    if (remote) {
      if (!remote.busy()) remote.click({ slot: ref.index, button: right ? 1 : 0, shift: false }, this.cursor);
      return;
    }
    const before = this.get(ref);
    const out = clickStacks(before, this.cursor, right, this.cursor.count === 0 || this.accepts(ref, this.cursor), this.takeOnly(ref));
    if (!out) return;
    this.cursor = out.cursor;
    this.set(ref, out.slot);
    if (this.takeOnly(ref)) this.box?.onTakeOutput?.();
    this.renderCursor();
    this.renderSlots();
  }

  /** Shift click: armor is worn, a container's items go to the inventory and the other way round. */
  private quickMove(ref: SlotRef): void {
    const slot = this.get(ref);
    if (!slot.id) return;
    const remote = this.box?.remote;
    if (remote?.busy()) return;
    if (ref.group === 'armor') {
      this.set(ref, { id: 0, count: this.inv.add(slot) });
    } else if (ref.group === 'box') {
      if (remote) {
        if (!remote.busy()) remote.click({ slot: ref.index, button: 0, shift: true }, this.cursor);
        return;
      }
      const left = this.inv.add(slot);
      this.set(ref, left > 0 ? { ...cloneStack(slot), count: left } : { id: 0, count: 0 });
      if (this.takeOnly(ref) && left < slot.count) this.box?.onTakeOutput?.();
    } else if (this.box) {
      if (remote) {
        if (!remote.busy() && ref.index < INVENTORY_SLOTS) remote.click({ slot: -1, from: ref.index, button: 0, shift: true }, this.cursor);
        return;
      }
      const left = this.isStation ? this.addToStation(slot) : quickInsert(this.box.kind ?? 'chest', this.box.slots, slot);
      if (!this.isStation) this.box.onChange?.();
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

  private renderCursor(): void {
    const c = this.cursor;
    this.cursorEl.classList.toggle('hidden', c.count === 0);
    this.cursorEl.replaceChildren(...(c.count ? [
      h('img', { src: this.icons.get(c.id), alt: '' }),
      c.count > 1 ? h('span', { class: 'slot-count', text: String(c.count) }) : '',
    ] : []));
  }

  // ---------------------------------------------------------------- recipe book

  /** Smelting recipes are a reference only: smelting takes a real furnace (right click one). */
  private craftable(r: Recipe): boolean {
    return r.station !== 'furnace' && canCraft(this.inv, r, this.stations);
  }

  private recipeText(r: Recipe): string {
    if (r.station === 'furnace') return `${itemName(r.result.id)} ← ${itemName(r.ingredients[0].ids[0])} (smelt it in a furnace)`;
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
    let visible = RECIPES.filter((r) => r.station === 'hand' || r.station === 'furnace' || this.stations.has(r.station));
    if (this.category === 'craftable') visible = visible.filter((r) => this.craftable(r));
    else if (this.category !== 'all') visible = visible.filter((r) => recipeCategory(r) === this.category);
    if (q) visible = visible.filter((r) => itemName(r.result.id).toLowerCase().includes(q) || r.ingredients.some((ing) => ing.ids.some((i) => itemName(i).toLowerCase().includes(q))));
    // Craftable recipes first, like the recipe book's "craftable" filter.
    const ok = new Map(visible.map((r) => [r, this.craftable(r)] as const));
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
    if (r.station === 'furnace') return;
    const left = craft(this.inv, r, this.stations);
    if (left > 0) this.actions.drop({ id: r.result.id, count: left });
    this.renderSlots();
  }
}
