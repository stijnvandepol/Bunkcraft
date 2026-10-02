import { GAME_MODES, GAME_MODE_HINTS, GAME_MODE_NAMES, type GameMode } from '../player/GameMode';
import type { WorldMeta } from '../save/SaveSystem';
import { NAME_PATTERN, formatCode, normalizeCode } from '../net/protocol';
import { createRoom, forgetGame, lookupRoom, recentGames, serverInfo } from '../net/RoomApi';
import { button, h, menuScreen, screen } from './dom';
import type { ScreenStack } from './Screens';

export interface MenuActions {
  listWorlds(): Promise<WorldMeta[]>;
  playWorld(meta: WorldMeta): void;
  createWorld(name: string, seedText: string, mode: GameMode): void;
  deleteWorld(id: string): Promise<void>;
  openOptions(): void;
  /** Join a server (empty address = this page's server); with a code, that game; without, the main world. */
  joinServer(name: string, address: string, room?: string): void;
  logo(): HTMLCanvasElement;
  /** Fallback world icon (data URL) when a world has no screenshot yet. */
  defaultWorldIcon(): string;
}

export const VERSION = 'BunkCraft 1.0';

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: nothing to remember */ }
}

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
        button('Multiplayer', () => void this.showMultiplayer()),
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

  /**
   * Multiplayer hub: create a game and share its code, join with a code or invite link,
   * or rejoin a recent game. Falls back to a plain server address on static hosting.
   */
  async showMultiplayer(prefillCode = ''): Promise<void> {
    const info = await serverInfo();
    if (!info) return this.showDirectConnect();
    const name = h('input', { class: 'mc-input', value: load('bunkcraft.name', ''), maxLength: 16, placeholder: 'Your name (3–16 letters)' });
    const code = h('input', { class: 'mc-input', value: prefillCode, maxLength: 80, placeholder: 'Game code or invite link' });
    const error = h('div', { class: 'error' });
    const validName = (): string | null => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = 'Name must be 3–16 letters, digits or _';
        name.focus();
        return null;
      }
      store('bunkcraft.name', n);
      error.textContent = '';
      return n;
    };
    const joinCode = async (raw: string) => {
      const n = validName();
      if (!n) return;
      const c = normalizeCode(raw);
      if (!c) {
        error.textContent = 'That is not a game code (6 letters and digits, like K7Q-M2X)';
        return;
      }
      try {
        await lookupRoom(c);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        forgetGame(c);
        return;
      }
      this.actions.joinServer(n, '', c);
    };
    const join = () => void joinCode(code.value);
    for (const i of [name, code]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

    const recent = recentGames().map((g) => button(`${g.name}  (${formatCode(g.code)})`, () => void joinCode(g.code), { cls: 'w150' }));
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    const body = h('div', { style: column },
      h('div', { class: 'field-label', text: 'Player Name' }), name,
      info.rooms ? button('Create Game', () => { const n = validName(); if (n) this.showCreateGame(n); }, { cls: 'w150' }) : null,
      info.rooms ? h('div', { class: 'field-label', text: 'Join a Friend' }) : null,
      info.rooms ? code : null,
      info.rooms ? button('Join Game', join, { cls: 'w150' }) : null,
      recent.length ? h('div', { class: 'field-label', text: 'Recent Games' }) : null,
      ...recent,
      error,
    );
    const footer: HTMLElement[] = [];
    if (info.main) footer.push(button('Join Public Server', () => { const n = validName(); if (n) this.actions.joinServer(n, ''); }, { cls: 'w150' }));
    footer.push(button('Direct Connect...', () => this.showDirectConnect(), { cls: 'w150' }), button('Back', () => this.stack.pop(), { cls: 'w150' }));
    this.stack.push(menuScreen('Play Multiplayer', [body], footer, { list: true }));
    window.setTimeout(() => (name.value ? (prefillCode ? code : name) : name).focus(), 0);
    if (prefillCode && name.value) error.textContent = '';
  }

  /** Name, mode and seed for a new game; the server answers with its share code. */
  private showCreateGame(playerName: string): void {
    const name = h('input', { class: 'mc-input', value: `${playerName}'s Game`.slice(0, 32), maxLength: 32 });
    const seed = h('input', { class: 'mc-input', placeholder: 'Leave blank for a random seed', maxLength: 32 });
    const error = h('div', { class: 'error' });
    let mode: GameMode = 'survival';
    const modeHint = h('div', { class: 'hint', text: GAME_MODE_HINTS[mode] });
    const modeButton = button(`Game Mode: ${GAME_MODE_NAMES[mode]}`, () => {
      mode = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length];
      modeButton.textContent = `Game Mode: ${GAME_MODE_NAMES[mode]}`;
      modeHint.textContent = GAME_MODE_HINTS[mode];
    });
    let busy = false;
    const create = async () => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      try {
        const code = await createRoom(name.value.trim() || 'BunkCraft Game', mode, seed.value.trim());
        this.actions.joinServer(playerName, '', code);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        busy = false;
      }
    };
    for (const i of [name, seed]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void create(); });
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    this.stack.push(menuScreen('Create Game', [
      h('div', { style: column },
        h('div', { class: 'field-label', text: 'Game Name' }), name,
        modeButton, modeHint,
        h('div', { class: 'field-label', text: 'Seed for the World Generator' }), seed,
        h('div', { class: 'hint', text: 'You get a code and a link to share. Friends can join any time while the game exists.' }),
        error,
      ),
    ], [
      button('Create and Play', () => void create(), { cls: 'w150' }),
      button('Cancel', () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => name.select(), 0);
  }

  /** Join any BunkCraft server by address (the page's own server when left empty). */
  showDirectConnect(): void {
    const name = h('input', { class: 'mc-input', value: load('bunkcraft.name', ''), maxLength: 16, placeholder: 'Your name (3–16 letters)' });
    const address = h('input', { class: 'mc-input', value: load('bunkcraft.server', ''), maxLength: 120, placeholder: location.host });
    const error = h('div', { class: 'error' });
    const join = () => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = 'Name must be 3–16 letters, digits or _';
        return;
      }
      store('bunkcraft.name', n);
      store('bunkcraft.server', address.value.trim());
      this.actions.joinServer(n, address.value.trim());
    };
    for (const i of [name, address]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    this.stack.push(menuScreen('Direct Connect', [
      h('div', { style: column },
        h('div', { class: 'field-label', text: 'Player Name' }), name,
        h('div', { class: 'field-label', text: 'Server Address' }), address,
        h('div', { class: 'hint', text: 'Host name or ip:port of a BunkCraft server. Leave empty for the server this page came from.' }),
        error,
      ),
    ], [
      button('Join Server', join, { cls: 'w150' }),
      button('Cancel', () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => (name.value ? address : name).focus(), 0);
  }

  /** "Connection Lost" / failed to connect screen. */
  showDisconnected(reason: string): void {
    this.stack.clear();
    this.stack.push(menuScreen('Disconnected', [
      h('div', { class: 'hint', text: reason }),
    ], [button('Back to Title Screen', () => this.showTitle())]));
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
            h('div', { class: 'world-meta', text: `${GAME_MODE_NAMES[w.gameMode ?? 'creative']} Mode, Seed: ${w.seedText || w.seed}` }),
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
    let mode: GameMode = 'survival';
    const create = () => this.actions.createWorld(name.value.trim() || 'New World', seed.value.trim(), mode);
    for (const input of [name, seed]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    const modeHint = h('div', { class: 'hint', text: GAME_MODE_HINTS[mode] });
    const modeButton = button(`Game Mode: ${GAME_MODE_NAMES[mode]}`, () => {
      mode = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length];
      modeButton.textContent = `Game Mode: ${GAME_MODE_NAMES[mode]}`;
      modeHint.textContent = GAME_MODE_HINTS[mode];
    });
    const gameTab = h('div', { style: column },
      h('div', { class: 'field-label', text: 'World Name' }), name,
      modeButton,
      modeHint,
      button('Difficulty: Normal', () => undefined, { disabled: true }),
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

/** Death screen ("You died!" / Hardcore "Game over!"). */
export function deathScreen(opts: {
  hardcore: boolean; message: string; score: number;
  respawn(): void; spectate(): void; title(): void;
}): HTMLDivElement {
  return screen('death-screen',
    h('div', { class: 'death-title', text: opts.hardcore ? 'Game over!' : 'You died!' }),
    h('div', { class: 'death-message', text: opts.message }),
    h('div', { class: 'death-score' }, 'Score: ', h('b', { text: String(opts.score) })),
    h('div', { style: 'height: calc(var(--s) * 12)' }),
    opts.hardcore
      ? button('Spectate World', opts.spectate)
      : button('Respawn', opts.respawn),
    button('Title Screen', opts.title),
  );
}

/** "Game Menu" laid out like Minecraft's pause screen. */
export function pauseScreen(actions: { resume(): void; options(): void; quit(): void; multiplayer?: boolean; advancements?: () => void; invite?: () => void }): HTMLDivElement {
  const off = () => undefined;
  return screen('menu-bg pause',
    h('div', { class: 'screen-header', style: 'flex-basis: calc(var(--s) * 50)' }, h('h2', { class: 'screen-title', text: 'Game Menu' })),
    h('div', { class: 'title-buttons', style: 'top: calc(25% + var(--s) * 8)' },
      button('Back to Game', actions.resume),
      h('div', { class: 'row' }, button('Advancements', actions.advancements ?? off, { cls: 'half', disabled: !actions.advancements }), button('Statistics', off, { cls: 'half', disabled: true })),
      h('div', { class: 'row' }, button('Give Feedback', off, { cls: 'half', disabled: true }), button('Report Bugs', off, { cls: 'half', disabled: true })),
      h('div', { class: 'row' }, button('Options...', actions.options, { cls: 'half' }), actions.invite
        ? button('Invite Friends', actions.invite, { cls: 'half' })
        : button('Open to LAN', off, { cls: 'half', disabled: true })),
      button(actions.multiplayer ? 'Disconnect' : 'Save and Quit to Title', actions.quit),
    ),
  );
}

/** Share screen of a hosted game: the code, a link, and one-click copy. */
export function inviteScreen(code: string, link: string, text: string, done: () => void): HTMLDivElement {
  const linkInput = h('input', { class: 'mc-input', value: link, readOnly: true });
  linkInput.addEventListener('focus', () => linkInput.select());
  const copy = button('Copy Invite', () => {
    const ok = () => { copy.textContent = 'Copied!'; window.setTimeout(() => { copy.textContent = 'Copy Invite'; }, 1500); };
    navigator.clipboard?.writeText(text).then(ok, () => linkInput.select());
    if (!navigator.clipboard) linkInput.select();
  }, { cls: 'w150' });
  return menuScreen('Invite Friends', [
    h('div', { style: 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);' },
      h('div', { class: 'field-label', text: 'Game Code' }),
      h('div', { class: 'death-title', text: formatCode(code) }),
      h('div', { class: 'field-label', text: 'Invite Link' }), linkInput,
      h('div', { class: 'hint', text: 'Friends open the link, or type the code under Multiplayer.' }),
    ),
  ], [copy, button('Done', done, { cls: 'w150' })]);
}
