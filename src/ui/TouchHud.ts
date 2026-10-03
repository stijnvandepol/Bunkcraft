import { h } from './dom';

export type TouchButtonId =
  | 'jump' | 'sneak' | 'attack' | 'use' | 'sprint' | 'inventory' | 'chat' | 'pause' | 'fullscreen'
  | 'reload' | 'swap' | 'scoreboard' | 'loadout';

interface ButtonDef {
  id: TouchButtonId;
  label: string;
  aria: string;
  cls: string;
  scope?: 'sandbox' | 'arcade';
}

/** Order matters for tab order and screen readers: movement, actions, then menus. */
const BUTTONS: readonly ButtonDef[] = [
  { id: 'sneak', label: 'SNEAK', aria: 'Sneak or descend (hold)', cls: 'tb-sneak', scope: 'sandbox' },
  { id: 'sprint', label: 'RUN', aria: 'Sprint (toggle)', cls: 'tb-sprint' },
  { id: 'jump', label: 'JUMP', aria: 'Jump (double tap to fly in creative)', cls: 'tb-jump' },
  { id: 'attack', label: 'HIT', aria: 'Attack or break block (hold)', cls: 'tb-attack', scope: 'sandbox' },
  { id: 'use', label: 'USE', aria: 'Use item or place block (hold)', cls: 'tb-use', scope: 'sandbox' },
  { id: 'attack', label: 'FIRE', aria: 'Fire weapon (hold)', cls: 'tb-attack', scope: 'arcade' },
  { id: 'use', label: 'AIM', aria: 'Aim down sights (toggle)', cls: 'tb-use', scope: 'arcade' },
  { id: 'reload', label: 'RELOAD', aria: 'Reload', cls: 'tb-small tb-reload', scope: 'arcade' },
  { id: 'swap', label: 'SWAP', aria: 'Switch weapon', cls: 'tb-small tb-swap', scope: 'arcade' },
  { id: 'scoreboard', label: 'TAB', aria: 'Scoreboard (hold)', cls: 'tb-small tb-score', scope: 'arcade' },
  { id: 'loadout', label: 'GUNS', aria: 'Loadout menu', cls: 'tb-small tb-loadout', scope: 'arcade' },
  { id: 'inventory', label: 'INV', aria: 'Inventory', cls: 'tb-small tb-inv', scope: 'sandbox' },
  { id: 'chat', label: 'CHAT', aria: 'Chat', cls: 'tb-small tb-chat' },
  { id: 'fullscreen', label: 'FS', aria: 'Toggle fullscreen', cls: 'tb-small tb-fs' },
  { id: 'pause', label: 'II', aria: 'Pause menu', cls: 'tb-small tb-pause' },
];

/**
 * DOM for the touch controls: a floating joystick, action buttons, the menu row and an orientation
 * hint. Purely visual and structural; all behaviour lives in core/TouchControls.ts. Every control is
 * a real <button> with an accessible name, so screen readers and switch devices can reach it.
 */
export class TouchHud {
  readonly el: HTMLDivElement;
  /** Full-screen layer that receives the look and joystick fingers. */
  readonly surface: HTMLDivElement;
  readonly base: HTMLDivElement;
  readonly knob: HTMLDivElement;
  readonly buttons = new Map<string, HTMLButtonElement[]>();
  readonly hint: HTMLDivElement;

  constructor() {
    this.surface = h('div', { class: 'tc-surface' });
    this.knob = h('div', { class: 'tc-knob' });
    this.base = h('div', { class: 'tc-base' }, this.knob);
    this.hint = h('div', { class: 'tc-hint hidden', role: 'status' },
      h('span', { text: 'Rotate your device for a wider view' }),
      h('button', { class: 'tc-hint-x', 'aria-label': 'Dismiss hint', text: 'OK', onclick: () => this.hint.classList.add('dismissed') }));
    const menuRow = h('div', { class: 'tc-menu-row' });
    this.el = h('div', { class: 'touch-hud hidden', role: 'group', 'aria-label': 'Touch controls' }, this.surface, this.base, menuRow, this.hint);
    for (const def of BUTTONS) {
      const b = h('button', { class: `tb ${def.cls}`, type: 'button', 'aria-label': def.aria, text: def.label });
      b.dataset.id = def.id;
      if (def.scope) b.dataset.scope = def.scope;
      const list = this.buttons.get(def.id) ?? [];
      list.push(b);
      this.buttons.set(def.id, list);
      (def.cls.includes('tb-small') ? menuRow : this.el).append(b);
    }
    // Fullscreen is not available everywhere (iPhone Safari): hide the button there.
    if (!document.documentElement.requestFullscreen && !(document.documentElement as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen) {
      this.buttons.get('fullscreen')?.forEach((b) => b.classList.add('hidden'));
    }
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  /** Arcade game types swap the sandbox buttons for fire, aim, reload and the scoreboard. */
  setArcade(on: boolean): void {
    this.el.classList.toggle('arcade', on);
    for (const list of this.buttons.values()) {
      for (const b of list) {
        const scope = b.dataset.scope;
        if (scope) b.classList.toggle('hidden', (scope === 'arcade') !== on);
      }
    }
  }

  /** Chat only exists in multiplayer sandbox worlds. */
  setChatAvailable(v: boolean): void {
    this.buttons.get('chat')?.forEach((b) => b.classList.toggle('hidden', !v));
  }

  applySettings(opacity: number, scale: number, leftHanded: boolean): void {
    this.el.style.setProperty('--tc-opacity', String(opacity / 100));
    this.el.style.setProperty('--tc-scale', String(scale / 100));
    this.el.classList.toggle('lefty', leftHanded);
  }

  setPressed(id: string, pressed: boolean): void {
    this.buttons.get(id)?.forEach((b) => b.classList.toggle('pressed', pressed));
  }

  /** Move the joystick base to a screen position and show it as active. */
  showStick(x: number, y: number, active: boolean): void {
    const st = this.base.style;
    if (active) {
      const r = this.base.offsetWidth / 2;
      st.left = `${x - r}px`;
      st.top = `${y - r}px`;
      st.right = st.bottom = 'auto';
    } else {
      st.left = st.top = st.right = st.bottom = '';
      this.knob.style.transform = '';
    }
    this.base.classList.toggle('active', active);
  }

  /** Radius of the joystick base in CSS pixels. */
  get stickRadius(): number {
    return this.base.offsetWidth / 2;
  }

  moveKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
