import type { AdvancementDef } from '../player/Advancements';
import type { BlockIcons } from './BlockIcons';
import { h } from './dom';

const SHOW_MS = 5000;
const SLIDE_MS = 400;
const MAX_VISIBLE = 3;

/** Top-right "Advancement Made!" toasts that slide in, stay five seconds and stack. */
export class AdvancementToasts {
  readonly el = h('div', { class: 'toasts' });
  private readonly queue: AdvancementDef[] = [];
  private shown = 0;

  constructor(private readonly icons: BlockIcons) {}

  push(def: AdvancementDef): void {
    this.queue.push(def);
    this.pump();
  }

  private pump(): void {
    while (this.shown < MAX_VISIBLE && this.queue.length) this.show(this.queue.shift()!);
  }

  private show(def: AdvancementDef): void {
    this.shown++;
    const heading = def.frame === 'challenge' ? 'Challenge Complete!' : def.frame === 'goal' ? 'Goal Reached!' : 'Advancement Made!';
    const toast = h('div', { class: `toast ${def.frame}` },
      h('div', { class: 'toast-icon' }, h('img', { src: this.icons.get(def.icon), alt: '', draggable: false })),
      h('div', { class: 'toast-text' },
        h('div', { class: 'toast-head', text: heading }),
        h('div', { class: 'toast-title', text: def.title })),
    );
    this.el.append(toast);
    // Two frames so the transition starts from the off-screen position.
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('in')));
    setTimeout(() => {
      toast.classList.remove('in');
      setTimeout(() => {
        toast.remove();
        this.shown--;
        this.pump();
      }, SLIDE_MS);
    }, SHOW_MS);
  }
}
