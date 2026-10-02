import { getItemDef, itemId } from '../items/ItemRegistry';
import type { BlockIcons } from './BlockIcons';
import { type CreativeTab, allCreativeItems, buildCreativeTabs } from './CreativeTabs';
import { h } from './dom';
import { HOTBAR_SIZE, type Hotbar } from './Hotbar';

const COLUMNS = 9;
const ROWS = 5;
const GRID_SLOTS = COLUMNS * ROWS;

/**
 * Creative inventory in Minecraft 1.21's layout: tabs above and below a 195×136 panel with a scrollable 9×5 grid
 * (mouse wheel or scrollbar), a search tab and the hotbar row. Clicking an item puts it in the selected hotbar
 * slot (shift-click: a full stack).
 */
export class Inventory {
  readonly el: HTMLDivElement;
  private readonly topTabs: HTMLDivElement;
  private readonly bottomTabs: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly grid: HTMLDivElement;
  private readonly scrollbar: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly hotbarRow: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private readonly tabs: CreativeTab[];
  private everything: number[] | null = null;
  private tab = 0;
  private scrollRow = 0;
  private items: number[] = [];
  onClose: (() => void) | null = null;
  /** The "Survival Inventory" tab: switches to the survival screen (armor, crafting). */
  onSurvival: (() => void) | null = null;

  constructor(private readonly icons: BlockIcons, private readonly hotbar: Hotbar) {
    this.tabs = buildCreativeTabs();
    this.tooltip = h('div', { class: 'mc-tooltip hidden' });
    this.topTabs = h('div', { class: 'inv-tabs' });
    this.bottomTabs = h('div', { class: 'inv-tabs bottom' });
    this.title = h('div', { class: 'inv-title' });
    this.search = h('input', { class: 'inv-search hidden', type: 'text', placeholder: 'Search Items', maxLength: 40, spellcheck: false });
    this.grid = h('div', { class: 'inv-grid main' });
    this.thumb = h('div', { class: 'inv-thumb' });
    this.scrollbar = h('div', { class: 'inv-scroll' }, this.thumb);
    this.hotbarRow = h('div', { class: 'inv-grid inv-hotbar' });
    const panel = h('div', { class: 'inv-panel' },
      this.title,
      this.search,
      h('div', { class: 'inv-body' }, this.grid, this.scrollbar),
      this.hotbarRow,
    );
    this.el = h('div', { class: 'screen inventory hidden' }, h('div', {}, this.topTabs, panel, this.bottomTabs), this.tooltip);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.onClose?.();
    });
    this.el.addEventListener('mousemove', (e) => {
      this.tooltip.style.left = `${e.clientX + 12}px`;
      this.tooltip.style.top = `${e.clientY - 24}px`;
    });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scrollTo(this.scrollRow + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
    this.scrollbar.addEventListener('mousedown', (e) => this.dragScroll(e));
    // Typing must not reach the game's shortcuts (E closes the inventory, digits pick hotbar slots).
    for (const type of ['keydown', 'keyup'] as const) this.search.addEventListener(type, (e) => e.stopPropagation());
    this.search.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.onClose?.(); });
    this.search.addEventListener('input', () => { this.scrollRow = 0; this.refreshItems(); this.renderGrid(); });
  }

  private get isSearch(): boolean {
    return this.tab >= this.tabs.length;
  }

  private maxRow(): number {
    return Math.max(0, Math.ceil(this.items.length / COLUMNS) - ROWS);
  }

  private scrollTo(row: number): void {
    const r = Math.max(0, Math.min(this.maxRow(), row));
    if (r === this.scrollRow) return;
    this.scrollRow = r;
    this.renderGrid();
  }

  private dragScroll(e: MouseEvent): void {
    e.preventDefault();
    const bar = this.scrollbar.getBoundingClientRect();
    const move = (ev: MouseEvent): void => {
      const f = Math.max(0, Math.min(1, (ev.clientY - bar.top) / bar.height));
      this.scrollTo(Math.round(f * this.maxRow()));
    };
    move(e);
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private refreshItems(): void {
    if (!this.isSearch) {
      this.items = this.tabs[this.tab].items;
      return;
    }
    this.everything ??= allCreativeItems(this.tabs).filter((id) => getItemDef(id));
    const q = this.search.value.trim().toLowerCase();
    this.items = q ? this.everything.filter((id) => getItemDef(id)!.displayName.toLowerCase().includes(q)) : this.everything;
  }

  private slot(id: number, onClick: ((shift: boolean) => void) | null, selected = false): HTMLDivElement {
    const def = id ? getItemDef(id) : undefined;
    const el = h('div', { class: `inv-slot${selected ? ' selected' : ''}${id ? '' : ' empty'}` },
      id ? h('img', { src: this.icons.get(id), draggable: false, alt: '' }) : null);
    if (onClick) el.addEventListener('click', (e) => onClick(e.shiftKey));
    el.addEventListener('mouseenter', () => {
      if (!def) return;
      this.tooltip.textContent = def.displayName;
      this.tooltip.classList.remove('hidden');
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
    return el;
  }

  private tabEl(name: string, icon: number | null, index: number, bottom: boolean): HTMLDivElement {
    const tab = h('div', { class: `inv-tab${index === this.tab ? ' active' : ''}${bottom ? ' bottom' : ''}`, title: name },
      icon ? h('img', { src: this.icons.get(icon), alt: '', draggable: false }) : h('span', { class: 'inv-tab-glyph', text: '?' }));
    tab.addEventListener('click', () => {
      this.tab = index;
      this.scrollRow = 0;
      this.render();
      if (this.isSearch) this.search.focus();
    });
    return tab;
  }

  private render(): void {
    const searchIndex = this.tabs.length;
    this.topTabs.replaceChildren(
      ...this.tabs.map((t, i) => (t.bottom ? null : this.tabEl(t.name, t.icon, i, false))).filter((e): e is HTMLDivElement => !!e),
      this.tabEl('Search Items', null, searchIndex, false),
    );
    const survival = h('div', { class: 'inv-tab bottom', title: 'Survival Inventory' },
      h('img', { src: this.icons.get(itemId('iron_chestplate')), alt: '', draggable: false }));
    survival.addEventListener('click', () => this.onSurvival?.());
    this.bottomTabs.replaceChildren(...this.tabs.map((t, i) => (t.bottom ? this.tabEl(t.name, t.icon, i, true) : null)).filter((e): e is HTMLDivElement => !!e), survival);
    this.title.textContent = this.isSearch ? '' : this.tabs[this.tab].name;
    this.title.classList.toggle('hidden', this.isSearch);
    this.search.classList.toggle('hidden', !this.isSearch);
    this.refreshItems();
    this.renderGrid();
    this.renderHotbarRow();
  }

  private renderGrid(): void {
    const cells: HTMLDivElement[] = [];
    const first = this.scrollRow * COLUMNS;
    for (let i = 0; i < GRID_SLOTS; i++) {
      const id = this.items[first + i] ?? 0;
      cells.push(this.slot(id, id ? (shift) => {
        const max = shift ? 64 : 1;
        this.hotbar.inventory.set(this.hotbar.selected, { id, count: max });
        this.hotbar.showName();
        this.renderHotbarRow();
      } : null));
    }
    this.grid.replaceChildren(...cells);
    const max = this.maxRow();
    // Scrollbar thumb: 15 px tall in the 90 px track, like Minecraft's.
    this.thumb.style.top = `calc(var(--s) * ${max ? (this.scrollRow / max) * 73 : 0})`;
    this.thumb.classList.toggle('disabled', max === 0);
  }

  private renderHotbarRow(): void {
    this.hotbarRow.replaceChildren();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.hotbarRow.append(this.slot(this.hotbar.inventory.get(i).id, () => {
        this.hotbar.select(i);
        this.renderHotbarRow();
      }, i === this.hotbar.selected));
    }
  }

  open(): void {
    this.render();
    this.el.classList.remove('hidden');
  }

  close(): void {
    this.el.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.search.blur();
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }
}
