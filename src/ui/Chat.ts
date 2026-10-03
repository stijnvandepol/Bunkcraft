import type { Settings } from '../core/Settings';
import { ChatHistory, SERVER_COMMAND_USAGE, commonPrefix, parseChatColors, suggestCommands } from './chatLogic';
import { h } from './dom';

/** Minecraft: a message stays 10 s (200 ticks); the last second fades out. */
const VISIBLE_MS = 9_000;
const MAX_LINES = 100;

/**
 * Minecraft-style chat: messages appear bottom-left and fade after 10 s; T (or /) opens the input with the full
 * history visible. Up/Down walk through sent messages, Tab completes `/` commands. Text is always set via
 * textContent (colour codes become spans, never HTML).
 */
export class Chat {
  readonly el: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly suggestBox: HTMLDivElement;
  private readonly history = new ChatHistory();
  private open = false;
  private commands: Readonly<Record<string, string>> = SERVER_COMMAND_USAGE;
  private suggestions: string[] = [];
  private suggestIndex = -1;
  private showSuggestions = true;
  private colors = true;
  onSend: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.log = h('div', { class: 'chat-log' });
    this.suggestBox = h('div', { class: 'chat-suggest hidden' });
    this.input = h('input', { class: 'chat-input hidden', maxLength: 256, spellcheck: false, autocomplete: 'off' });
    this.el = h('div', { class: 'chat hidden' }, this.log, this.suggestBox, this.input);
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => this.refreshSuggestions());
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = this.input.value.trim();
      if (text) {
        this.history.push(text);
        this.onSend?.(text);
      }
      this.close();
    } else if (e.key === 'Escape') {
      this.close();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.input.value = e.key === 'ArrowUp' ? this.history.up(this.input.value) : this.history.down(this.input.value);
      this.refreshSuggestions();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.complete(e.shiftKey ? -1 : 1);
    }
  }

  /** Tab: fill in the common part of all candidates, then cycle through them. */
  private complete(dir: 1 | -1): void {
    const list = this.suggestions;
    if (list.length === 0) return;
    const value = this.input.value;
    const common = commonPrefix(list);
    if (this.suggestIndex === -1 && common.length > value.length) {
      this.input.value = list.length === 1 ? `${common} ` : common;
      this.refreshSuggestions();
      return;
    }
    this.suggestIndex = (this.suggestIndex + dir + list.length) % list.length;
    // Cycling must not recompute the candidates from the text it just inserted.
    this.input.value = list[this.suggestIndex];
    this.renderSuggestions();
  }

  private refreshSuggestions(): void {
    this.suggestIndex = -1;
    this.suggestions = this.showSuggestions ? suggestCommands(this.input.value, this.commands) : [];
    this.renderSuggestions();
  }

  private renderSuggestions(): void {
    this.suggestBox.classList.toggle('hidden', this.suggestions.length === 0);
    this.suggestBox.replaceChildren(...this.suggestions.map((s, i) => h('div', { class: i === this.suggestIndex ? 'sel' : '', text: s })));
  }

  /** Commands offered for completion: the server's list in multiplayer, the local ones in singleplayer. */
  setCommands(usage: Readonly<Record<string, string>>): void {
    this.commands = usage;
  }

  /** Chat Settings: opacity, text size, line spacing, width, colours and command suggestions. */
  applySettings(s: Pick<Settings, 'chatOpacity' | 'chatTextSize' | 'chatLineSpacing' | 'chatWidth' | 'chatColors' | 'chatSuggestions'>): void {
    const st = this.el.style;
    st.setProperty('--chat-opacity', String(s.chatOpacity / 100));
    st.setProperty('--chat-size', String(s.chatTextSize / 100));
    st.setProperty('--chat-gap', String(s.chatLineSpacing / 100));
    st.setProperty('--chat-width', String(s.chatWidth / 100));
    this.colors = s.chatColors;
    this.showSuggestions = s.chatSuggestions;
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  get isOpen(): boolean {
    return this.open;
  }

  add(text: string, system = false): void {
    const line = h('div', { class: `chat-line${system ? ' system' : ''}` });
    for (const seg of parseChatColors(text, this.colors)) {
      line.append(seg.color ? h('span', { text: seg.text, style: `color:${seg.color}` }) : document.createTextNode(seg.text));
    }
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
    this.history.reset();
    this.refreshSuggestions();
    // Focus after the key event that opened chat, so its character isn't typed.
    window.setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('open');
    this.input.classList.add('hidden');
    this.suggestions = [];
    this.renderSuggestions();
    this.input.blur();
    this.onClose?.();
  }

  clear(): void {
    this.log.replaceChildren();
  }
}
