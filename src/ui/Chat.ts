import { h } from './dom';

const VISIBLE_MS = 10_000;
const MAX_LINES = 100;

/**
 * Minecraft-style chat: messages appear bottom-left and fade after 10 s; T (or /)
 * opens the input with the full history visible. Text is always set via textContent.
 */
export class Chat {
  readonly el: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private open = false;
  onSend: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.log = h('div', { class: 'chat-log' });
    this.input = h('input', { class: 'chat-input hidden', maxLength: 256, spellcheck: false, autocomplete: 'off' });
    this.el = h('div', { class: 'chat hidden' }, this.log, this.input);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.onSend?.(text);
        this.close();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  get isOpen(): boolean {
    return this.open;
  }

  add(text: string, system = false): void {
    const line = h('div', { class: `chat-line${system ? ' system' : ''}`, text });
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
    window.setTimeout(() => line.classList.add('faded'), VISIBLE_MS);
    this.log.scrollTop = this.log.scrollHeight;
  }

  openInput(prefix = ''): void {
    this.open = true;
    this.el.classList.add('open');
    this.input.classList.remove('hidden');
    this.input.value = prefix;
    // Focus after the key event that opened chat, so its character isn't typed.
    window.setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('open');
    this.input.classList.add('hidden');
    this.input.blur();
    this.onClose?.();
  }

  clear(): void {
    this.log.replaceChildren();
  }
}
