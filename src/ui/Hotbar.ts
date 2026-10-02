import { getBlockDef } from '../world/BlockRegistry';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';

export const HOTBAR_SIZE = 9;

/**
 * 9-slot hotbar. DOM is touched only when the selection or contents change,
 * never per frame.
 */
export class Hotbar {
  readonly el: HTMLDivElement;
  readonly slots: number[];
  selected = 0;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly iconEls: HTMLImageElement[] = [];
  private readonly nameEl: HTMLDivElement;
  private nameTimer = 0;
  onChange: (() => void) | null = null;

  constructor(private readonly icons: BlockIcons, slots: number[]) {
    this.slots = slots.slice(0, HOTBAR_SIZE);
    this.nameEl = h('div', { class: 'item-name' });
    const bar = h('div', { class: 'hotbar' });
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const icon = h('img', { class: 'slot-icon', draggable: false, alt: '' });
      const slot = h('div', { class: 'hotbar-slot' }, icon);
      this.slotEls.push(slot);
      this.iconEls.push(icon);
      bar.append(slot);
    }
    this.el = h('div', { class: 'hotbar-wrap' }, this.nameEl, bar);
    this.refresh();
  }

  get selectedBlock(): number {
    return this.slots[this.selected];
  }

  select(i: number): void {
    const n = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (n === this.selected) return;
    this.slotEls[this.selected].classList.remove('selected');
    this.selected = n;
    this.slotEls[n].classList.add('selected');
    this.showName();
    this.onChange?.();
  }

  setSlot(i: number, id: number): void {
    this.slots[i] = id;
    this.refresh();
    this.showName();
    this.onChange?.();
  }

  refresh(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const id = this.slots[i];
      this.iconEls[i].src = id ? this.icons.get(id) : '';
      this.iconEls[i].style.visibility = id ? 'visible' : 'hidden';
      this.slotEls[i].classList.toggle('selected', i === this.selected);
    }
  }

  private showName(): void {
    const def = getBlockDef(this.selectedBlock);
    this.nameEl.textContent = def ? def.displayName : '';
    this.nameEl.classList.remove('fade');
    this.nameEl.classList.add('show');
    window.clearTimeout(this.nameTimer);
    this.nameTimer = window.setTimeout(() => this.nameEl.classList.add('fade'), 1500);
  }
}
