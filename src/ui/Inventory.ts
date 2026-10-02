import { BLOCK, getBlockDef } from '../world/BlockRegistry';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';
import { HOTBAR_SIZE, type Hotbar } from './Hotbar';

const B = BLOCK;

/** Creative tabs, like Minecraft's (icon block + contents). */
const TABS: { name: string; icon: number; blocks: number[] }[] = [
  {
    name: 'Building Blocks', icon: B.BRICKS,
    blocks: [B.STONE, B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.BRICKS, B.SANDSTONE, B.OBSIDIAN,
      B.OAK_LOG, B.OAK_PLANKS, B.BIRCH_LOG, B.BIRCH_PLANKS, B.SPRUCE_LOG, B.SPRUCE_PLANKS],
  },
  {
    name: 'Colored Blocks', icon: B.BLUE_WOOL,
    blocks: [B.WHITE_WOOL, B.RED_WOOL, B.YELLOW_WOOL, B.GREEN_WOOL, B.BLUE_WOOL, B.GLASS],
  },
  {
    name: 'Natural Blocks', icon: B.GRASS,
    blocks: [B.GRASS, B.DIRT, B.SNOWY_GRASS, B.SNOW, B.SAND, B.GRAVEL, B.CLAY, B.COAL_ORE, B.IRON_ORE,
      B.GOLD_ORE, B.DIAMOND_ORE, B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.CACTUS, B.TALL_GRASS,
      B.DANDELION, B.POPPY, B.DEAD_BUSH],
  },
  { name: 'Functional Blocks', icon: B.BOOKSHELF, blocks: [B.GLOWSTONE, B.BOOKSHELF] },
];

const GRID_SLOTS = 9 * 5;

/**
 * Creative inventory in Minecraft's layout: tabs above a 195×136 panel with a 9×5 grid
 * and the hotbar row. Clicking a block puts it in the selected hotbar slot.
 */
export class Inventory {
  readonly el: HTMLDivElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly hotbarRow: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private tab = 0;
  onClose: (() => void) | null = null;

  constructor(private readonly icons: BlockIcons, private readonly hotbar: Hotbar) {
    this.tooltip = h('div', { class: 'mc-tooltip hidden' });
    this.tabsEl = h('div', { class: 'inv-tabs' });
    this.title = h('div', { class: 'inv-title' });
    this.grid = h('div', { class: 'inv-grid main' });
    this.hotbarRow = h('div', { class: 'inv-grid inv-hotbar' });
    const panel = h('div', { class: 'inv-panel' },
      this.title,
      h('div', { class: 'inv-body' }, this.grid, h('div', { class: 'inv-scroll' })),
      this.hotbarRow,
    );
    this.el = h('div', { class: 'screen inventory hidden' }, h('div', {}, this.tabsEl, panel), this.tooltip);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.onClose?.();
    });
    this.el.addEventListener('mousemove', (e) => {
      this.tooltip.style.left = `${e.clientX + 12}px`;
      this.tooltip.style.top = `${e.clientY - 24}px`;
    });
  }

  private slot(id: number, onClick: (() => void) | null, selected = false): HTMLDivElement {
    const def = id ? getBlockDef(id) : undefined;
    const el = h('div', { class: `inv-slot${selected ? ' selected' : ''}${id ? '' : ' empty'}` },
      id ? h('img', { src: this.icons.get(id), draggable: false, alt: '' }) : null);
    if (onClick) el.addEventListener('click', onClick);
    el.addEventListener('mouseenter', () => {
      if (!def) return;
      this.tooltip.textContent = def.displayName;
      this.tooltip.classList.remove('hidden');
    });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
    return el;
  }

  private render(): void {
    this.tabsEl.replaceChildren(...TABS.map((t, i) => {
      const tab = h('div', { class: `inv-tab${i === this.tab ? ' active' : ''}`, title: t.name },
        h('img', { src: this.icons.get(t.icon), alt: '', draggable: false }));
      tab.addEventListener('click', () => { this.tab = i; this.render(); });
      return tab;
    }));
    const t = TABS[this.tab];
    this.title.textContent = t.name;
    const cells: HTMLDivElement[] = [];
    for (let i = 0; i < GRID_SLOTS; i++) {
      const id = t.blocks[i] ?? 0;
      cells.push(this.slot(id, id ? () => { this.hotbar.setSlot(this.hotbar.selected, id); this.renderHotbarRow(); } : null));
    }
    this.grid.replaceChildren(...cells);
    this.renderHotbarRow();
  }

  private renderHotbarRow(): void {
    this.hotbarRow.replaceChildren();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.hotbarRow.append(this.slot(this.hotbar.slots[i], () => {
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
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }
}
