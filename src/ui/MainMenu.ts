import type { WorldMeta } from '../save/SaveSystem';
import { button, h, menuScreen, screen } from './dom';
import type { ScreenStack } from './Screens';

export interface MenuActions {
  listWorlds(): Promise<WorldMeta[]>;
  playWorld(meta: WorldMeta): void;
  createWorld(name: string, seedText: string): void;
  deleteWorld(id: string): Promise<void>;
  openOptions(): void;
  logo(): HTMLCanvasElement;
  /** Fallback world icon (data URL) when a world has no screenshot yet. */
  defaultWorldIcon(): string;
}

export const VERSION = 'BunkCraft 1.0';

const SPLASHES = [
  'Now in your browser!', 'Greedy meshed!', 'Made of typed arrays!', '60 frames per second!',
  'Web Workers inside!', 'Procedurally generated!', 'Pixel perfect!', 'Ambient occlusion!',
  '100% blocks!', 'Seeded!', 'Punch a tree!', 'Biome tinted!', 'Also try the original!',
  'Now with shadows!', 'Bunk approved!', 'WebGL2!',
];

/** Title screen, world selection and world creation, laid out like Minecraft 1.21. */
export class MainMenu {
  constructor(private readonly stack: ScreenStack, private readonly actions: MenuActions) {}

  showTitle(): void {
    this.stack.clear();
    const splashText = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    const splash = h('div', { class: 'splash', text: splashText });
    // Long splashes shrink, like Minecraft's 1.8 × 100 / (width + 32) rule.
    splash.style.setProperty('--splash-scale', String(Math.min(1.8, (1.8 * 100) / (splashText.length * 6 + 32))));
    const logo = this.actions.logo();
    logo.classList.add('logo');

    this.stack.push(screen('title-screen',
      h('div', { class: 'logo-wrap' }, logo, h('div', { class: 'edition', text: 'Browser Edition' })),
      splash,
      h('div', { class: 'title-buttons' },
        button('Singleplayer', () => void this.showWorlds()),
        button('Multiplayer', () => undefined, { disabled: true }),
        button('BunkCraft Realms', () => undefined, { disabled: true }),
        h('div', { class: 'gap' }),
        h('div', { class: 'row' },
          button('Options...', () => this.actions.openOptions(), { cls: 'half' }),
          button('Quit Game', () => this.quit(), { cls: 'half' }),
        ),
      ),
      h('div', { class: 'footer-left', text: VERSION }),
      h('div', { class: 'footer-right', text: 'Not affiliated with Mojang' }),
    ));
  }

  /** A browser tab cannot close itself unless script-opened; leave fullscreen and say so. */
  private quit(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    window.close();
    this.stack.push(menuScreen('Quit Game', [
      h('div', { class: 'hint', text: 'Thanks for playing! You can now close this browser tab.' }),
    ], [button('Back to Title', () => this.stack.pop())]));
  }

  async showWorlds(): Promise<void> {
    const worlds = await this.actions.listWorlds();
    let selected: WorldMeta | null = worlds[0] ?? null;
    let filter = '';
    const list = h('div', { class: 'world-list' });
    const search = h('input', { class: 'mc-input', placeholder: 'Search...', maxLength: 32 });
    const play = button('Play Selected World', () => selected && this.actions.playWorld(selected), { cls: 'w150' });
    const del = button('Delete', () => selected && this.confirmDelete(selected), { cls: 'w72' });

    const render = () => {
      const shown = worlds.filter((w) => w.name.toLowerCase().includes(filter));
      list.replaceChildren();
      if (shown.length === 0) list.append(h('div', { class: 'world-empty', text: worlds.length ? 'No worlds found' : 'No worlds yet — create one!' }));
      for (const w of shown) {
        const item = h('div', { class: `world-item${w === selected ? ' selected' : ''}` },
          h('img', { class: 'world-icon', src: w.icon ?? this.actions.defaultWorldIcon(), alt: '', draggable: false }),
          h('div', { class: 'world-text' },
            h('div', { class: 'world-name', text: w.name }),
            h('div', { class: 'world-meta', text: `${w.id} (${new Date(w.lastPlayed).toLocaleString()})` }),
            h('div', { class: 'world-meta', text: `Creative Mode, Seed: ${w.seedText || w.seed}` }),
          ),
        );
        item.addEventListener('click', () => { selected = w; render(); });
        item.addEventListener('dblclick', () => this.actions.playWorld(w));
        list.append(item);
      }
      play.disabled = del.disabled = !selected;
    };
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); render(); });
    render();

    const el = menuScreen('Select World', [list], [
      h('div', { class: 'row' }, play, button('Create New World', () => this.showCreate(), { cls: 'w150' })),
      h('div', { class: 'row' },
        button('Edit', () => undefined, { cls: 'w72', disabled: true }),
        del,
        button('Re-Create', () => undefined, { cls: 'w72', disabled: true }),
        button('Back', () => this.stack.pop(), { cls: 'w72' }),
      ),
    ], { list: true, tallFooter: true });
    // Search box sits in the header under the title, like Minecraft.
    const header = el.querySelector<HTMLElement>('.screen-header')!;
    header.style.flexDirection = 'column';
    header.style.gap = 'calc(var(--s) * 4)';
    header.style.flexBasis = 'calc(var(--s) * 48)';
    header.append(search);
    this.stack.push(el);
  }

  private confirmDelete(world: WorldMeta): void {
    this.stack.push(menuScreen('Are you sure you want to delete this world?', [
      h('div', { class: 'hint', text: `'${world.name}' will be lost forever! (A long time!)` }),
    ], [
      button('Delete', async () => {
        await this.actions.deleteWorld(world.id);
        this.stack.pop();
        this.stack.pop();
        void this.showWorlds();
      }, { cls: 'w150' }),
      button('Cancel', () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }

  showCreate(): void {
    const name = h('input', { class: 'mc-input', value: 'New World', maxLength: 32 });
    const seed = h('input', { class: 'mc-input', placeholder: 'Leave blank for a random seed', maxLength: 32 });
    const create = () => this.actions.createWorld(name.value.trim() || 'New World', seed.value.trim());
    for (const input of [name, seed]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    const gameTab = h('div', { style: column },
      h('div', { class: 'field-label', text: 'World Name' }), name,
      button('Game Mode: Creative', () => undefined, { disabled: true }),
      button('Difficulty: Peaceful', () => undefined, { disabled: true }),
    );
    const worldTab = h('div', { class: 'hidden', style: column },
      button('World Type: Default', () => undefined, { disabled: true }),
      h('div', { class: 'field-label', text: 'Seed for the World Generator' }), seed,
    );
    const tabs = [['Game', gameTab], ['World', worldTab]] as const;
    const tabButtons: HTMLButtonElement[] = [];
    tabs.forEach(([label, panel], i) => {
      const t = h('button', { class: `tab${i === 0 ? ' active' : ''}`, text: label });
      t.addEventListener('click', () => {
        tabs.forEach(([, p]) => p.classList.add('hidden'));
        tabButtons.forEach((b) => b.classList.remove('active'));
        panel.classList.remove('hidden');
        t.classList.add('active');
      });
      tabButtons.push(t);
    });

    this.stack.push(menuScreen('Create New World', [
      h('div', { class: 'tabs' }, ...tabButtons),
      gameTab, worldTab,
    ], [
      button('Create New World', create, { cls: 'w150' }),
      button('Cancel', () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => name.select(), 0);
  }

  /** Loading screen with a progress bar; returns an updater. */
  showLoading(title: string): (status: string, progress: number) => void {
    this.stack.clear();
    const status = h('div', { class: 'hint', text: 'Preparing...' });
    const bar = h('div', { class: 'progress-fill' });
    this.stack.push(screen('loading', h('div', { text: title }), status, h('div', { class: 'progress' }, bar)));
    return (text, p) => {
      status.textContent = text;
      bar.style.width = `${Math.round(Math.min(1, p) * 100)}%`;
    };
  }
}

/** "Game Menu" laid out like Minecraft's pause screen. */
export function pauseScreen(actions: { resume(): void; options(): void; quit(): void }): HTMLDivElement {
  const off = () => undefined;
  return screen('menu-bg pause',
    h('div', { class: 'screen-header', style: 'flex-basis: calc(var(--s) * 50)' }, h('h2', { class: 'screen-title', text: 'Game Menu' })),
    h('div', { class: 'title-buttons', style: 'top: calc(25% + var(--s) * 8)' },
      button('Back to Game', actions.resume),
      h('div', { class: 'row' }, button('Advancements', off, { cls: 'half', disabled: true }), button('Statistics', off, { cls: 'half', disabled: true })),
      h('div', { class: 'row' }, button('Give Feedback', off, { cls: 'half', disabled: true }), button('Report Bugs', off, { cls: 'half', disabled: true })),
      h('div', { class: 'row' }, button('Options...', actions.options, { cls: 'half' }), button('Open to LAN', off, { cls: 'half', disabled: true })),
      button('Save and Quit to Title', actions.quit),
    ),
  );
}
