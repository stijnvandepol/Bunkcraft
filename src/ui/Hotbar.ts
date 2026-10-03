import { HOTBAR_SLOTS, type PlayerInventory } from '../items/Inventory';
import { type ItemStack, maxDurability } from '../items/ItemRegistry';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';
import { hasGlint, stackTitle } from './ItemTooltip';

export const HOTBAR_SIZE = HOTBAR_SLOTS;

/**
 * 9-slot hotbar showing slots 0–8 of the player inventory, with stack counts and tool
 * durability bars (survival). The DOM is only touched when something changes.
 */
export class Hotbar {
  readonly el: HTMLDivElement;
  selected = 0;
  /** Counts are hidden in creative (infinite blocks). */
  showCounts = true;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly iconEls: HTMLImageElement[] = [];
  private readonly countEls: HTMLSpanElement[] = [];
  private readonly duraEls: HTMLDivElement[] = [];
  private readonly glintEls: HTMLDivElement[] = [];
  private readonly glintSrc: string[] = [];
  private readonly nameEl: HTMLDivElement;
  readonly hudSlot: HTMLDivElement;
  private nameTimer = 0;
  onChange: (() => void) | null = null;

  constructor(private readonly icons: BlockIcons, readonly inventory: PlayerInventory) {
    this.nameEl = h('div', { class: 'item-name' });
    this.hudSlot = h('div');
    const bar = h('div', { class: 'hotbar' });
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const icon = h('img', { class: 'slot-icon', draggable: false, alt: '' });
      const count = h('span', { class: 'slot-count' });
      const dura = h('div', { class: 'slot-durability hidden' }, h('i'));
      const glint = h('div', { class: 'glint hidden' });
      const slot = h('div', { class: 'hotbar-slot' }, icon, glint, count, dura);
      this.glintEls.push(glint);
      this.glintSrc.push('');
      this.slotEls.push(slot);
      this.iconEls.push(icon);
      this.countEls.push(count);
      this.duraEls.push(dura);
      bar.append(slot);
    }
    this.el = h('div', { class: 'hotbar-wrap' }, this.nameEl, this.hudSlot, bar);
    this.refresh();
  }

  get selectedStack(): ItemStack {
    return this.inventory.get(this.selected);
  }

  /** Item id in the selected slot (0 = empty hand). */
  get selectedBlock(): number {
    return this.selectedStack.id;
  }

  select(i: number): void {
    const n = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (n === this.selected) return;
    this.selected = n;
    this.refresh();
    this.showName();
    this.onChange?.();
  }

  /** Creative: put an item in a hotbar slot. */
  setSlot(i: number, id: number): void {
    this.inventory.set(i, { id, count: id ? 1 : 0 });
    this.showName();
  }

  refresh(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.inventory.get(i);
      this.iconEls[i].src = s.id ? this.icons.get(s.id) : '';
      this.iconEls[i].style.visibility = s.id ? 'visible' : 'hidden';
      // Enchanted items shimmer (the overlay is masked by the icon, see ItemTooltip.glintOverlay).
      const glint = hasGlint(s);
      this.glintEls[i].classList.toggle('hidden', !glint);
      if (glint && this.glintSrc[i] !== this.iconEls[i].src) {
        this.glintSrc[i] = this.iconEls[i].src;
        this.glintEls[i].style.setProperty('-webkit-mask-image', `url("${this.glintSrc[i]}")`);
        this.glintEls[i].style.setProperty('mask-image', `url("${this.glintSrc[i]}")`);
      }
      this.countEls[i].textContent = this.showCounts && s.count > 1 ? String(s.count) : '';
      const max = maxDurability(s.id);
      const wear = max && s.damage ? 1 - s.damage / max : 1;
      this.duraEls[i].classList.toggle('hidden', !max || wear >= 1 || !this.showCounts);
      if (max) {
        const bar = this.duraEls[i].firstElementChild as HTMLElement;
        bar.style.width = `${Math.round(wear * 100)}%`;
        bar.style.background = `hsl(${Math.round(wear * 120)}, 100%, 50%)`;
      }
      this.slotEls[i].classList.toggle('selected', i === this.selected);
    }
  }

  showName(): void {
    const id = this.selectedBlock;
    this.nameEl.textContent = id ? stackTitle(this.selectedStack) : '';
    this.nameEl.classList.toggle('enchanted', hasGlint(this.selectedStack));
    this.nameEl.classList.remove('fade');
    this.nameEl.classList.add('show');
    window.clearTimeout(this.nameTimer);
    this.nameTimer = window.setTimeout(() => this.nameEl.classList.add('fade'), 1500);
  }
}
