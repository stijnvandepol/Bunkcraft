import { GAME_MODES, GAME_MODE_HINTS, GAME_MODE_NAMES, type GameMode } from '../player/GameMode';
import type { WorldMeta } from '../save/SaveSystem';
import { ArchiveError } from '../save/WorldArchive';
import type { WorldTransfer } from '../save/WorldTransfer';
import { type ShareParams } from '../save/share';
import { NAME_PATTERN, formatCode, normalizeCode } from '../net/protocol';
import { type RoomInfo, browseRooms, createRoom, forgetGame, lookupRoom, ownerToken, recentGames, roomPassword, serverInfo, setRoomPassword } from '../net/RoomApi';
import { gameTypeDef } from '../modes/GameTypes';
import { getMap } from '../modes/maps';
import { isArcade } from '../modes/Realms';
import { RealmsMenu } from './RealmsMenu';
import { savePlayerName, savedPlayerName } from './playerName';
import { installButton } from '../pwa/Pwa';
import { button, dirtBackground, h, menuScreen, screen } from './dom';
import { cheatsAllowed } from '../save/SaveSystem';
import { TIP_COUNT, modeHint, modeName, t, tip } from './i18n';
import { difficultyButton, gameRulesScreen } from './GameRulesScreen';
import { DEFAULT_DIFFICULTY, type Difficulty } from '../world/Difficulty';
import { GameRules } from '../world/GameRules';
import { pickFile } from './download';
import { announce } from './Announcer';
import type { ScreenStack } from './Screens';

export interface MenuActions {
  listWorlds(): Promise<WorldMeta[]>;
  playWorld(meta: WorldMeta): void;
  createWorld(name: string, seedText: string, mode: GameMode, extra?: { difficulty: Difficulty; rules?: Record<string, boolean | number>; cheats?: boolean }): void;
  deleteWorld(id: string): Promise<void>;
  /** Persists changed world metadata (rename, game mode). */
  saveWorld(meta: WorldMeta): Promise<void>;
  /** `.bunkworld` export/import and backups. */
  transfer: WorldTransfer;
  openOptions(): void;
  /** Join a server (empty address = this page's server); with a code, that game; without, the main world. */
  joinServer(name: string, address: string, room?: string): void;
  logo(): HTMLCanvasElement;
  /** Fallback world icon (data URL) when a world has no screenshot yet. */
  defaultWorldIcon(): string;
  /** Key names for the {inventory}, {chat}, {command}, {sprint}, {drop} placeholders in loading tips. */
  tipKeys?(): Record<string, string>;
  /** Opens the Language screen on the title screen (the Options button next to it opens the rest). */
  openLanguage?(): void;
}

export const VERSION = 'BunkCraft 1.0';

/** `npm run build:static`: hosted without a game server (itch.io, GitHub Pages ...). */
const STATIC_BUILD = import.meta.env.VITE_STATIC === '1';

/** "Team Deathmatch · first to 30 · 10 min · 3/12 players", shown before joining. */
export function describeRoom(info: RoomInfo): string {
  const def = gameTypeDef(info.gameType ?? 'minecraft');
  const parts = [def.name];
  if (def.arcade) {
    if (info.scoreLimit && def.options?.score.length !== 0) parts.push(`first to ${info.scoreLimit}${def.scoreUnit && def.scoreUnit !== 'kills' ? ` ${def.scoreUnit}` : ''}`);
    if (info.timeLimitSec) parts.push(`${Math.round(info.timeLimitSec / 60)} min`);
    if (info.map) parts.push(info.map === 'rotate' ? 'Map: Rotate' : `Map: ${getMap(info.map).name}`);
  } else if (info.gameMode) {
    parts.push(info.gameMode[0].toUpperCase() + info.gameMode.slice(1));
  }
  parts.push(`${info.players}/${info.maxPlayers} players`);
  if (info.locked) parts.push('Password');
  return parts.join(' · ');
}

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: nothing to remember */ }
}

/** Minecraft's date splashes (Christmas, New Year, Halloween) win over the random ones on those days. */
export function dateSplash(now: Date): string | null {
  const m = now.getMonth() + 1, d = now.getDate();
  if (m === 12 && d >= 24 && d <= 26) return 'Merry X-mas!';
  if (m === 1 && d === 1) return 'Happy new year!';
  if (m === 10 && d === 31) return 'OOoooOOOoooo! Spooky!';
  return null;
}

/** "yyyy/MM/dd HH:mm" like the Minecraft world list. */
export function formatWorldDate(ts: number): string {
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SPLASHES = [
  'Now in your browser!', 'Greedy meshed!', 'Made of typed arrays!', '60 frames per second!',
  'Web Workers inside!', 'Procedurally generated!', 'Pixel perfect!', 'Ambient occlusion!',
  '100% blocks!', 'Seeded!', 'Punch a tree!', 'Biome tinted!', 'Also try the original!',
  'Now with shadows!', 'Bunk approved!', 'WebGL2!',
  'Headshot!', 'Team Deathmatch!',
];

const COLUMN = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';

/** Title screen, world selection and world creation, laid out like Minecraft 1.21. */
export class MainMenu {
  /** BunkCraft Realms: the arcade minigames hub (Multiplayer is the Minecraft sandbox only). */
  readonly realms: RealmsMenu;

  constructor(private readonly stack: ScreenStack, private readonly actions: MenuActions) {
    this.realms = new RealmsMenu(stack, { joinCode: (name, code, onError) => this.joinByCode(name, code, onError, undefined, false) });
  }

  /** The Realms playlist (also where a player returns to after leaving a Realms match). */
  showRealms(): Promise<void> {
    return this.realms.show();
  }

  /** An invite link (?join=CODE): a Realms lobby opens in Realms, anything else in Multiplayer with the code filled in. */
  async openInvite(code: string): Promise<void> {
    let info: RoomInfo | null = null;
    try {
      info = await lookupRoom(code);
    } catch {
      // Unknown or unreachable: Multiplayer shows the error when joining.
    }
    if (info && isArcade(info.gameType)) this.realms.openLobby(code, info);
    else await this.showMultiplayer(code);
  }

  showTitle(): void {
    this.stack.clear();
    const splashText = dateSplash(new Date()) ?? SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    const splash = h('div', { class: 'splash', text: splashText });
    // Long splashes shrink, like Minecraft's 1.8 × 100 / (width + 32) rule.
    splash.style.setProperty('--splash-scale', String(Math.min(1.8, (1.8 * 100) / (splashText.length * 6 + 32))));
    const logo = this.actions.logo();
    logo.classList.add('logo');

    this.stack.push(screen('title-screen',
      h('div', { class: 'logo-wrap' }, logo, h('div', { class: 'edition', text: t('title.edition') })),
      splash,
      h('div', { class: 'title-buttons' },
        button(t('title.singleplayer'), () => void this.showWorlds()),
        button(t('title.multiplayer'), () => void this.showMultiplayer()),
        button(t('title.realms'), () => void this.realms.show()),
        h('div', { class: 'gap' }),
        h('div', { class: 'row' },
          this.actions.openLanguage ? this.iconButton('icon-lang', t('title.language'), () => this.actions.openLanguage!()) : null,
          button(t('title.options'), () => this.actions.openOptions(), { cls: 'half' }),
          button(t('title.quit'), () => this.quit(), { cls: 'half' }),
        ),
      ),
      installButton('pwa-install-title'),
      h('div', { class: 'footer-left', text: VERSION }),
      h('div', { class: 'footer-right', text: t('title.disclaimer') }),
    ));
  }

  /** Small square icon button (Language), drawn from CSS so it stays crisp at every GUI scale. */
  private iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = button('', onClick, { cls: `icon ${icon}` });
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

  /**
   * Multiplayer hub: create a game and share its code, join with a code or invite link,
   * or rejoin a recent game. Falls back to a plain server address on static hosting.
   */
  async showMultiplayer(prefillCode = ''): Promise<void> {
    const info = await serverInfo();
    if (!info) return this.showDirectConnect();
    const name = h('input', { class: 'mc-input', value: savedPlayerName(), maxLength: 16, placeholder: 'Your name (3–16 letters)' });
    const code = h('input', { class: 'mc-input', value: prefillCode, maxLength: 80, placeholder: 'Game code or invite link' });
    const error = h('div', { class: 'error' });
    const roomInfo = h('div', { class: 'hint' });
    const validName = (): string | null => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = 'Name must be 3–16 letters, digits or _';
        name.focus();
        return null;
      }
      savePlayerName(n);
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
      await this.joinByCode(n, c, (msg) => { error.textContent = msg; }, (text) => { roomInfo.textContent = text; });
    };
    const join = () => void joinCode(code.value);
    for (const i of [name, code]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    // Show what kind of game a valid code or link points to before joining it.
    let lookupTimer = 0;
    const previewCode = () => {
      window.clearTimeout(lookupTimer);
      roomInfo.textContent = '';
      const c = normalizeCode(code.value);
      if (!c) return;
      lookupTimer = window.setTimeout(() => {
        lookupRoom(c).then((r) => { if (normalizeCode(code.value) === c) roomInfo.textContent = describeRoom(r); }, () => undefined);
      }, 250);
    };
    code.addEventListener('input', previewCode);

    // Realms lobbies are rejoined from Realms; Multiplayer lists the Minecraft games.
    const recent = recentGames().filter((g) => !isArcade(g.gameType)).map((g) =>
      button(`${g.name}  (${formatCode(g.code)})`, () => void joinCode(g.code), { cls: 'w150' }));
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    const body = h('div', { style: column },
      h('div', { class: 'field-label', text: 'Player Name' }), name,
      info.rooms ? button('Create Game', () => { const n = validName(); if (n) this.showCreateGame(n); }, { cls: 'w150' }) : null,
      info.rooms ? h('div', { class: 'field-label', text: 'Join a Friend' }) : null,
      info.rooms ? code : null,
      info.rooms ? roomInfo : null,
      info.rooms ? button('Join Game', join, { cls: 'w150' }) : null,
      info.rooms && info.features?.browse ? button('Browse Games', () => { const n = validName(); if (n) void this.showBrowse(n); }, { cls: 'w150' }) : null,
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
    if (prefillCode) previewCode();
  }

  /**
   * Looks a game up and joins it; asks for the password first when the game has one. A Realms lobby reached from
   * Multiplayer (`viaMultiplayer`) is handed to the Realms flow, which joins it from there.
   */
  private async joinByCode(
    playerName: string, code: string, onError: (msg: string) => void, onInfo: (text: string) => void = () => undefined, viaMultiplayer = true,
  ): Promise<void> {
    let info: RoomInfo;
    try {
      info = await lookupRoom(code);
      onInfo(describeRoom(info));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      forgetGame(code);
      return;
    }
    if (viaMultiplayer && isArcade(info.gameType)) {
      this.realms.openLobby(code, info);
      return;
    }
    // The creator is let in with the owner token, and a password typed earlier this session is remembered.
    if (info.locked && !roomPassword(code) && !ownerToken(code)) {
      this.askPassword(playerName, code, info);
      return;
    }
    this.actions.joinServer(playerName, '', code);
  }

  /** Password prompt for a locked game. The password goes to the server in `hello` and is kept in memory only. */
  private askPassword(playerName: string, code: string, info: RoomInfo): void {
    const password = h('input', { class: 'mc-input', type: 'password', maxLength: 64, placeholder: 'Password', autocomplete: 'off' });
    const join = () => {
      if (!password.value) { password.focus(); return; }
      setRoomPassword(code, password.value);
      this.actions.joinServer(playerName, '', code);
    };
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    this.stack.push(menuScreen('Password Required', [
      h('div', { style: COLUMN },
        h('div', { class: 'hint', text: `${info.name} is protected with a password.` }),
        password,
      ),
    ], [button('Join Game', join, { cls: 'w150' }), button('Cancel', () => this.stack.pop(), { cls: 'w150' })]));
    window.setTimeout(() => password.focus(), 0);
  }

  /** The public server list: games whose owners chose to show them. */
  private async showBrowse(playerName: string): Promise<void> {
    const error = h('div', { class: 'error' });
    const list = h('div', { style: COLUMN }, h('div', { class: 'hint', text: 'Loading...' }));
    const render = async () => {
      list.replaceChildren();
      error.textContent = '';
      try {
        const rooms = await browseRooms('minecraft');
        if (rooms.length === 0) list.append(h('div', { class: 'hint', text: 'No public games right now. Create one and tick "Show in Server List".' }));
        for (const r of rooms) {
          list.append(
            button(r.name, () => void this.joinByCode(playerName, r.code, (m) => { error.textContent = m; }), { cls: 'w150' }),
            h('div', { class: 'hint', text: describeRoom(r) }),
          );
        }
      } catch (e) {
        list.replaceChildren();
        error.textContent = e instanceof Error ? e.message : String(e);
      }
    };
    this.stack.push(menuScreen('Browse Games', [h('div', { style: COLUMN }, list, error)], [
      button('Refresh', () => void render(), { cls: 'w150' }),
      button('Back', () => this.stack.pop(), { cls: 'w150' }),
    ], { list: true }));
    await render();
  }

  /** Name, game mode, seed and visibility for a new Minecraft game; the server answers with its share code. Arcade lobbies are made under Realms. */
  private showCreateGame(playerName: string): void {
    const name = h('input', { class: 'mc-input', value: `${playerName}'s Game`.slice(0, 32), maxLength: 32 });
    const seed = h('input', { class: 'mc-input', placeholder: 'Leave blank for a random seed', maxLength: 32 });
    const password = h('input', { class: 'mc-input', type: 'password', maxLength: 64, placeholder: 'Optional password', autocomplete: 'off' });
    let listed = false;
    const listedHint = h('div', { class: 'hint', text: 'Private: only people with the code or link can find this game.' });
    const listedButton = button('Show in Server List: No', () => {
      listed = !listed;
      listedButton.textContent = `Show in Server List: ${listed ? 'Yes' : 'No'}`;
      listedHint.textContent = listed ? 'Anyone can see this game under Browse Games and join it.' : 'Private: only people with the code or link can find this game.';
    });
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
        const code = await createRoom(name.value.trim() || 'BunkCraft Game', mode, seed.value.trim(), {
          gameType: 'minecraft', scoreLimit: 0, timeLimitSec: 0, password: password.value || undefined, listed,
        });
        this.actions.joinServer(playerName, '', code);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        busy = false;
      }
    };
    for (const i of [name, seed, password]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void create(); });
    this.stack.push(menuScreen('Create Game', [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: 'Game Name' }), name,
        modeButton, modeHint,
        h('div', { class: 'field-label', text: 'Seed for the World Generator' }), seed,
        h('div', { class: 'field-label', text: 'Password' }), password,
        listedButton, listedHint,
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
    const name = h('input', { class: 'mc-input', value: savedPlayerName(), maxLength: 16, placeholder: 'Your name (3–16 letters)' });
    const address = h('input', { class: 'mc-input', value: load('bunkcraft.server', ''), maxLength: 120, placeholder: STATIC_BUILD ? 'play.example.com' : location.host });
    const error = h('div', { class: 'error' });
    const join = () => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = 'Name must be 3–16 letters, digits or _';
        return;
      }
      if (STATIC_BUILD && !address.value.trim()) {
        error.textContent = 'Enter the address of a BunkCraft server';
        return;
      }
      savePlayerName(n);
      store('bunkcraft.server', address.value.trim());
      this.actions.joinServer(n, address.value.trim());
    };
    for (const i of [name, address]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    this.stack.push(menuScreen('Direct Connect', [
      h('div', { style: column },
        h('div', { class: 'field-label', text: 'Player Name' }), name,
        h('div', { class: 'field-label', text: 'Server Address' }), address,
        h('div', { class: 'hint', text: STATIC_BUILD ? 'Host name or ip:port of a BunkCraft server. This copy of the game has no server of its own.' : 'Host name or ip:port of a BunkCraft server. Leave empty for the server this page came from.' }),
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
    // Replaces whatever the live region still held (an old death message read out next to the reconnect notice).
    announce(reason);
    this.stack.push(menuScreen(t('disconnected.title'), [
      h('div', { class: 'hint', text: reason }),
    ], [button(t('disconnected.back'), () => this.showTitle())]));
  }

  /** A browser tab cannot close itself unless script-opened; leave fullscreen and say so. */
  private quit(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    window.close();
    this.stack.push(menuScreen(t('quit.title'), [
      h('div', { class: 'hint', text: t('quit.text') }),
    ], [button(t('quit.back'), () => this.stack.pop())]));
  }

  async showWorlds(): Promise<void> {
    const worlds = await this.actions.listWorlds();
    worlds.sort((a, b) => b.lastPlayed - a.lastPlayed);
    let selected: WorldMeta | null = worlds[0] ?? null;
    let filter = '';
    const list = h('div', { class: 'world-list' });
    const search = h('input', { class: 'mc-input', placeholder: t('worlds.search'), maxLength: 32 });
    const play = button(t('worlds.play'), () => selected && this.actions.playWorld(selected), { cls: 'w150' });
    const del = button(t('worlds.delete'), () => selected && this.confirmDelete(selected), { cls: 'w72' });
    let status = '';
    let statusError = false;
    const edit = button(t('worlds.edit'), () => selected && this.showEdit(selected), { cls: 'w72' });
    const recreate = button(t('worlds.recreate'), () => selected && this.showCreate({ name: selected.name, seed: selected.seedText, mode: selected.gameMode }), { cls: 'w72' });
    const exportBtn = button(t('worlds.export'), () => {
      if (!selected) return;
      this.actions.transfer.exportWorld(selected).then(() => say(t('worlds.exported', selected?.name ?? '')), (e) => say(describeError(e), true));
    }, { cls: 'w72' });
    const importBtn = button(t('worlds.import'), () => void (async () => {
      const file = await pickFile('.bunkworld,.zip,application/zip');
      if (!file) return;
      try {
        const imported = await this.actions.transfer.importFile(file);
        worlds.splice(0, worlds.length, ...(await this.actions.listWorlds()));
        selected = worlds.find((w) => w.id === imported[0]?.id) ?? selected;
        say(imported.length === 1 ? t('worlds.imported', imported[0].name) : t('worlds.importedMany', imported.length));
      } catch (e) {
        say(describeError(e), true);
      }
    })(), { cls: 'w72' });
    const backupBtn = button(t('worlds.backupAll'), () => {
      this.actions.transfer.backupAll().then((n) => say(t('worlds.backupDone', n)), (e) => say(describeError(e), true));
    }, { cls: 'w72' });
    const say = (text: string, isError = false) => { status = text; statusError = isError; render(); };

    const render = () => {
      const shown = worlds.filter((w) => w.name.toLowerCase().includes(filter));
      list.replaceChildren();
      if (status) list.append(h('div', { class: statusError ? 'error' : 'hint', text: status }));
      if (shown.length === 0) list.append(h('div', { class: 'world-empty', text: worlds.length ? t('worlds.notFound') : t('worlds.empty') }));
      for (const w of shown) {
        const mode = w.gameMode ?? 'creative';
        const details = [t('worlds.mode', modeName(mode))];
        if (cheatsAllowed(w)) details.push(t('worlds.cheats'));
        details.push(t('worlds.version', VERSION.replace(/^BunkCraft /, '')));
        const item = h('div', { class: `world-item${w === selected ? ' selected' : ''}`, tabIndex: 0 },
          h('div', { class: 'world-icon-wrap' }, h('img', { class: 'world-icon', src: w.icon ?? this.actions.defaultWorldIcon(), alt: '', draggable: false })),
          h('div', { class: 'world-text' },
            h('div', { class: 'world-name', text: w.name }),
            h('div', { class: 'world-meta', text: `${w.id} (${formatWorldDate(w.lastPlayed)})` }),
            h('div', { class: 'world-meta', text: details.join(', ') }),
          ),
        );
        item.addEventListener('click', () => { selected = w; render(); });
        item.addEventListener('dblclick', () => this.actions.playWorld(w));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.actions.playWorld(w);
          else if (e.key === ' ') { e.preventDefault(); selected = w; render(); }
        });
        list.append(item);
      }
      play.disabled = del.disabled = edit.disabled = recreate.disabled = exportBtn.disabled = !selected;
      backupBtn.disabled = worlds.length === 0;
    };
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); render(); });
    render();

    const el = menuScreen(t('worlds.title'), [list], [
      h('div', { class: 'row' }, play, button(t('worlds.create'), () => this.showCreate(), { cls: 'w150' })),
      h('div', { class: 'row' },
        edit,
        del,
        recreate,
        button(t('common.back'), () => this.stack.pop(), { cls: 'w72' }),
      ),
      h('div', { class: 'row' }, exportBtn, importBtn, backupBtn),
    ], { list: true, tallFooter: true, cls: 'worlds-screen' });
    // Search box sits in the header under the title, like Minecraft.
    const header = el.querySelector<HTMLElement>('.screen-header')!;
    header.style.flexDirection = 'column';
    header.style.gap = 'calc(var(--s) * 4)';
    header.style.flexBasis = 'calc(var(--s) * 48)';
    header.append(search);
    this.stack.push(el);
  }

  private confirmDelete(world: WorldMeta): void {
    this.stack.push(menuScreen(t('worlds.deleteTitle'), [
      h('div', { class: 'hint', text: t('worlds.deleteText', world.name) }),
    ], [
      button(t('common.delete'), async () => {
        await this.actions.deleteWorld(world.id);
        this.stack.pop();
        this.stack.pop();
        void this.showWorlds();
      }, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }

  /** Rename a world, change its game mode and cheats, or download a backup (the world itself is untouched). */
  private showEdit(world: WorldMeta): void {
    const name = h('input', { class: 'mc-input', value: world.name, maxLength: 32 });
    let mode: GameMode = world.gameMode ?? 'creative';
    let cheats = cheatsAllowed(world);
    const modeHint$ = h('div', { class: 'hint', text: modeHint(mode, GAME_MODE_HINTS[mode]) });
    const modeButton = button(t('create.mode', modeName(mode)), () => {
      mode = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length];
      modeButton.textContent = t('create.mode', modeName(mode));
      modeHint$.textContent = modeHint(mode, GAME_MODE_HINTS[mode]);
    });
    const cheatText = () => t('edit.cheats', cheats ? t('common.on') : t('common.off'));
    const cheatButton = button(cheatText(), () => { cheats = !cheats; cheatButton.textContent = cheatText(); });
    const info = h('div', { class: 'hint' });
    const backup = button(t('edit.backup'), () => {
      this.actions.transfer.exportWorld(world).then(() => { info.textContent = t('edit.backupDone'); }, (e) => { info.textContent = describeError(e); });
    });
    const save = async () => {
      world.name = name.value.trim() || world.name;
      world.gameMode = mode;
      world.cheats = cheats;
      await this.actions.saveWorld(world);
      this.stack.pop();
      this.stack.pop();
      void this.showWorlds();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    this.stack.push(menuScreen(t('edit.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('edit.name') }), name,
        modeButton, modeHint$,
        cheatButton,
        backup,
        info,
        h('div', { class: 'hint', text: t('worlds.seed', world.seedText || world.seed) }),
      ),
    ], [
      button(t('common.save'), () => void save(), { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => name.select(), 0);
  }

  showCreate(prefill: ShareParams = {}): void {
    const name = h('input', { class: 'mc-input', value: prefill.name ?? 'New World', maxLength: 32 });
    const seed = h('input', { class: 'mc-input', placeholder: t('create.seed.placeholder'), maxLength: 32, value: prefill.seed ?? '' });
    let mode: GameMode = prefill.mode ?? 'survival';
    // Like Minecraft, cheats default on in Creative and off elsewhere until the player picks.
    let cheats: boolean | null = null;
    const cheatsOn = () => cheats ?? mode === 'creative';
    let difficulty: Difficulty = DEFAULT_DIFFICULTY;
    const rules = new GameRules();
    const create = () => this.actions.createWorld(name.value.trim() || 'New World', seed.value.trim(), mode,
      { difficulty: mode === 'hardcore' ? 'hard' : difficulty, rules: rules.serialize(), cheats: cheatsOn() });
    for (const input of [name, seed]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

    const modeHint$ = h('div', { class: 'hint', text: modeHint(mode, GAME_MODE_HINTS[mode]) });
    const cheatText = () => t('create.cheats', cheatsOn() ? t('common.on') : t('common.off'));
    const cheatButton = button(cheatText(), () => { cheats = !cheatsOn(); cheatButton.textContent = cheatText(); });
    const modeButton = button(t('create.mode', modeName(mode)), () => {
      mode = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length];
      modeButton.textContent = t('create.mode', modeName(mode));
      modeHint$.textContent = modeHint(mode, GAME_MODE_HINTS[mode]);
      cheatButton.textContent = cheatText();
      (diffButton as HTMLButtonElement & { refresh?: () => void }).refresh?.();
    });
    const diffButton = difficultyButton(() => difficulty, (d) => { difficulty = d; }, () => mode === 'hardcore');
    const gameTab = h('div', { style: COLUMN },
      h('div', { class: 'field-label', text: t('create.name') }), name,
      modeButton,
      modeHint$,
      diffButton,
    );
    // Placeholders for what the generator does not support yet (structures, bonus chest) stay visibly disabled.
    const worldTab = h('div', { class: 'hidden', style: COLUMN },
      button(t('create.worldType'), () => undefined, { disabled: true }),
      h('div', { class: 'field-label', text: t('create.seed') }), seed,
      prefill.seed ? h('div', { class: 'hint', text: t('worlds.seed', prefill.seed) }) : null,
      button(t('create.structures'), () => undefined, { disabled: true }),
      button(t('create.bonusChest'), () => undefined, { disabled: true }),
    );
    const moreTab = h('div', { class: 'hidden', style: COLUMN },
      cheatButton,
      h('div', { class: 'hint', text: t('create.cheats.hint') }),
      button(t('create.gameRules'), () => this.stack.push(gameRulesScreen(rules, () => this.stack.pop()))),
    );
    const tabs = [[t('create.tab.game'), gameTab], [t('create.tab.world'), worldTab], [t('create.tab.more'), moreTab]] as const;
    const tabButtons: HTMLButtonElement[] = [];
    tabs.forEach(([label, panel], i) => {
      const tb = h('button', { class: `tab${i === 0 ? ' active' : ''}`, text: label });
      tb.addEventListener('click', () => {
        tabs.forEach(([, p]) => p.classList.add('hidden'));
        tabButtons.forEach((b) => b.classList.remove('active'));
        panel.classList.remove('hidden');
        tb.classList.add('active');
      });
      tabButtons.push(tb);
    });

    this.stack.push(menuScreen(t('create.title'), [
      h('div', { class: 'tabs' }, ...tabButtons),
      gameTab, worldTab, moreTab,
    ], [
      button(t('create.button'), create, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => name.select(), 0);
  }

  /** Loading screen: dirt background, a progress bar with percentage and rotating tips about the real controls. */
  showLoading(title: string): (status: string, progress: number) => void {
    this.stack.clear();
    dirtBackground();
    const status = h('div', { class: 'hint', text: t('loading.preparing') });
    const bar = h('div', { class: 'progress-fill' });
    const tipEl = h('div', { class: 'loading-tip' });
    let n = Math.floor(Math.random() * TIP_COUNT);
    const showTip = () => { tipEl.textContent = t('loading.tip', tip(n++, this.actions.tipKeys?.() ?? {})); };
    showTip();
    const el = screen('loading', h('div', { text: title }), status, h('div', { class: 'progress' }, bar), tipEl);
    const timer = window.setInterval(() => (el.isConnected ? showTip() : window.clearInterval(timer)), 5000);
    this.stack.push(el);
    return (text, p) => {
      const pct = Math.round(Math.min(1, p) * 100);
      status.textContent = `${text} ${pct}%`;
      bar.style.width = `${pct}%`;
    };
  }
}

/** Death screen ("You died!" / Hardcore "Game over!"). */
export function deathScreen(opts: {
  hardcore: boolean; message: string; score: number;
  respawn(): void; spectate(): void; title(): void;
}): HTMLDivElement {
  return screen('death-screen',
    h('div', { class: 'death-title', text: opts.hardcore ? t('death.hardcore') : t('death.title') }),
    h('div', { class: 'death-message', text: opts.message }),
    h('div', { class: 'death-score' }, `${t('death.score')}: `, h('b', { text: String(opts.score) })),
    h('div', { style: 'height: calc(var(--s) * 12)' }),
    opts.hardcore
      ? button(t('death.spectate'), opts.spectate)
      : button(t('death.respawn'), opts.respawn),
    button(t('death.titleScreen'), opts.title),
  );
}

/** "Game Menu" laid out like Minecraft's pause screen. */
export function pauseScreen(actions: {
  resume(): void; options(): void; quit(): void; multiplayer?: boolean; advancements?: () => void; statistics?: () => void; invite?: () => void; seed?: string;
  /** The world's difficulty (read-only on a server and in Hardcore) and the Game Rules screen (singleplayer). */
  difficulty?: { get(): Difficulty; set(d: Difficulty): void; locked: boolean };
  gameRules?: () => void;
}): HTMLDivElement {
  const off = () => undefined;
  const copySeed = button(t('pause.copySeed'), () => {
    const ok = () => { copySeed.textContent = t('common.copied'); window.setTimeout(() => { copySeed.textContent = t('pause.copySeed'); }, 1500); };
    navigator.clipboard?.writeText(actions.seed ?? '').then(ok, () => { copySeed.textContent = actions.seed ?? ''; });
  }, { cls: 'half', disabled: !actions.seed });
  return screen('menu-bg pause',
    h('div', { class: 'screen-header', style: 'flex-basis: calc(var(--s) * 50)' }, h('h2', { class: 'screen-title', text: t('pause.title') })),
    h('div', { class: 'title-buttons', style: 'top: calc(25% + var(--s) * 8)' },
      button(t('pause.back'), actions.resume),
      h('div', { class: 'row' }, button(t('pause.advancements'), actions.advancements ?? off, { cls: 'half', disabled: !actions.advancements }), button(t('pause.statistics'), actions.statistics ?? off, { cls: 'half', disabled: !actions.statistics })),
      h('div', { class: 'row' }, copySeed, button(t('pause.reportBugs'), off, { cls: 'half', disabled: true })),
      h('div', { class: 'row' }, button(t('pause.options'), actions.options, { cls: 'half' }), actions.invite
        ? button(t('pause.invite'), actions.invite, { cls: 'half' })
        : button(t('pause.lan'), off, { cls: 'half', disabled: true })),
      actions.difficulty ? h('div', { class: 'row' },
        Object.assign(difficultyButton(actions.difficulty.get, actions.difficulty.set, () => actions.difficulty!.locked), { className: 'mc-btn half' }),
        button(t('create.gameRules'), actions.gameRules ?? off, { cls: 'half', disabled: !actions.gameRules })) : null,
      button(actions.multiplayer ? t('pause.disconnect') : t('pause.saveQuit'), actions.quit),
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

function describeError(e: unknown): string {
  return e instanceof ArchiveError ? e.message : 'Something went wrong. The file could not be processed.';
}
