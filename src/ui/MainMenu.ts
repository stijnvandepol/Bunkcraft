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
import { RealmsMenu, realmsModeName } from './RealmsMenu';
import { savePlayerName, savedPlayerName } from './playerName';
import { installButton } from '../pwa/Pwa';
import { button, dirtBackground, h, menuScreen, screen } from './dom';
import { emblemSvg, svgDataUrl } from './Brand';
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
  /** Join a server (empty address = this page's server); with a code, that game; without, the main world. `arena`: an arena lobby (shell loading screen). */
  joinServer(name: string, address: string, room?: string, arena?: boolean): void;
  /** Fallback world icon (data URL) when a world has no screenshot yet. */
  defaultWorldIcon(): string;
  /** Key names for the {inventory}, {chat}, {command}, {sprint}, {drop} placeholders in loading tips. */
  tipKeys?(): Record<string, string>;
  /** Opens the Language screen from the home screen. */
  openLanguage?(): void;
  /** Name of the arena map flying by behind the menu. */
  backgroundMap?(): string;
}

declare const __APP_VERSION__: string;
/** "BunkCraft 1.1.42": MAJOR.MINOR from package.json plus the CI build number (vite.config.ts). */
export const VERSION = `BunkCraft ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`;
/** The commit this build came from (the Docker image sets VITE_GIT_SHA), so the title screen shows what is live. */
const BUILD_SHA = String(import.meta.env.VITE_GIT_SHA ?? '').slice(0, 7);

/** `npm run build:static`: hosted without a game server (itch.io, GitHub Pages ...). */
const STATIC_BUILD = import.meta.env.VITE_STATIC === '1';

/** "Team Deathmatch · first to 30 · 10 min · 3/12 players", shown before joining. */
export function describeRoom(info: RoomInfo): string {
  const def = gameTypeDef(info.gameType ?? 'minecraft');
  const parts = [def.arcade ? realmsModeName(def.id) : t('home.build')];
  if (def.arcade) {
    if (info.scoreLimit && def.options?.score.length !== 0) {
      const unit = def.scoreUnit && def.scoreUnit !== 'kills' ? t(`mp.unit.${def.scoreUnit}`, def.scoreUnit) : '';
      parts.push(unit ? t('mp.room.firstToUnit', info.scoreLimit, unit) : t('mp.room.firstTo', info.scoreLimit));
    }
    if (info.timeLimitSec) parts.push(t('mp.room.min', Math.round(info.timeLimitSec / 60)));
    if (info.map) parts.push(t('mp.room.map', info.map === 'rotate' ? t('mp.room.rotate') : getMap(info.map).name));
  } else if (info.gameMode && info.gameMode in GAME_MODE_NAMES) {
    parts.push(modeName(info.gameMode as GameMode));
  }
  parts.push(t('mp.room.players', info.players, info.maxPlayers));
  if (info.locked) parts.push(t('mp.password'));
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

const COLUMN = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';

/**
 * The menus: the home screen (the arena shooter, see RealmsMenu/HomeScreen) is the front door; Build & Survival
 * (beta) leads to the sandbox menus (world selection, world creation, Multiplayer), which keep their Minecraft-style
 * layout for now.
 */
export class MainMenu {
  /** The arena menus (internally still "Realms"): home, lobbies, private matches, codes, loadouts, progression. */
  readonly realms: RealmsMenu;

  constructor(private readonly stack: ScreenStack, private readonly actions: MenuActions) {
    this.realms = new RealmsMenu(stack, {
      joinCode: (name, code, onError) => this.joinByCode(name, code, onError, undefined, false),
      openSurvival: () => this.showBuild(),
      openOptions: () => actions.openOptions(),
      openLanguage: () => (actions.openLanguage ? actions.openLanguage() : actions.openOptions()),
      backgroundMap: () => actions.backgroundMap?.() ?? '',
      version: BUILD_SHA ? `${VERSION} (${BUILD_SHA})` : VERSION,
    });
  }

  /** Where a player lands after an arena match: the home screen is the hub. */
  showRealms(): Promise<void> {
    this.showTitle();
    return Promise.resolve();
  }

  /** A party invite link (?party=CODE): join that party from the home screen. */
  openPartyInvite(code: string): void {
    this.realms.openPartyInvite(code);
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

  /** The front door: the home screen of the arena shooter. */
  showTitle(): void {
    this.stack.clear();
    const home = this.realms.showHome();
    const install = installButton('pwa-install-title');
    if (install) home.el.append(install);
  }

  /**
   * Build & Survival (beta): the voxel sandbox BunkCraft started as. Singleplayer worlds and Multiplayer games
   * (codes, browser, direct connect) live behind this door.
   */
  showBuild(): void {
    this.stack.push(menuScreen(t('build.title'), [
      h('div', { class: 'build-panel' },
        h('div', { class: 'hint', text: t('build.text') }),
        button(t('title.singleplayer'), () => void this.showWorlds(), { cls: 'primary' }),
        button(t('title.multiplayer'), () => void this.showMultiplayer()),
      ),
    ], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { cls: 'bc build-screen' }));
  }

  /**
   * Multiplayer hub: create a game and share its code, join with a code or invite link,
   * or rejoin a recent game. Falls back to a plain server address on static hosting.
   */
  async showMultiplayer(prefillCode = ''): Promise<void> {
    const info = await serverInfo();
    if (!info) return this.showDirectConnect();
    const name = h('input', { class: 'mc-input', value: savedPlayerName(), maxLength: 16, placeholder: t('mp.name.placeholder') });
    const code = h('input', { class: 'mc-input', value: prefillCode, maxLength: 80, placeholder: t('mp.code.placeholder') });
    const error = h('div', { class: 'error' });
    const roomInfo = h('div', { class: 'hint' });
    const validName = (): string | null => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = t('mp.name.invalid');
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
        error.textContent = t('mp.code.invalid');
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
      h('div', { class: 'field-label', text: t('mp.name') }), name,
      info.rooms ? button(t('mp.create'), () => { const n = validName(); if (n) this.showCreateGame(n); }, { cls: 'w150' }) : null,
      info.rooms ? h('div', { class: 'field-label', text: t('mp.joinFriend') }) : null,
      info.rooms ? code : null,
      info.rooms ? roomInfo : null,
      info.rooms ? button(t('mp.join'), join, { cls: 'w150' }) : null,
      info.rooms && info.features?.browse ? button(t('mp.browse'), () => { const n = validName(); if (n) void this.showBrowse(n); }, { cls: 'w150' }) : null,
      recent.length ? h('div', { class: 'field-label', text: t('mp.recent') }) : null,
      ...recent,
      error,
    );
    const footer: HTMLElement[] = [];
    if (info.main) footer.push(button(t('mp.public'), () => { const n = validName(); if (n) this.actions.joinServer(n, ''); }, { cls: 'w150' }));
    footer.push(button(t('mp.direct'), () => this.showDirectConnect(), { cls: 'w150' }), button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }));
    this.stack.push(menuScreen(t('mp.title'), [body], footer, { list: true }));
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
    this.actions.joinServer(playerName, '', code, isArcade(info.gameType));
  }

  /** Password prompt for a locked game. The password goes to the server in `hello` and is kept in memory only. */
  private askPassword(playerName: string, code: string, info: RoomInfo): void {
    const password = h('input', { class: 'mc-input', type: 'password', maxLength: 64, placeholder: t('mp.password'), autocomplete: 'off' });
    const join = () => {
      if (!password.value) { password.focus(); return; }
      setRoomPassword(code, password.value);
      this.actions.joinServer(playerName, '', code);
    };
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    this.stack.push(menuScreen(t('mp.password.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'hint', text: t('mp.password.text', info.name) }),
        password,
      ),
    ], [button(t('mp.join'), join, { cls: 'w150' }), button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' })]));
    window.setTimeout(() => password.focus(), 0);
  }

  /** The public server list: games whose owners chose to show them. */
  private async showBrowse(playerName: string): Promise<void> {
    const error = h('div', { class: 'error' });
    const list = h('div', { style: COLUMN }, h('div', { class: 'hint', text: t('common.loading') }));
    const render = async () => {
      list.replaceChildren();
      error.textContent = '';
      try {
        const rooms = await browseRooms('minecraft');
        if (rooms.length === 0) list.append(h('div', { class: 'hint', text: t('mp.browse.empty') }));
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
    this.stack.push(menuScreen(t('mp.browse'), [h('div', { style: COLUMN }, list, error)], [
      button(t('mp.refresh'), () => void render(), { cls: 'w150' }),
      button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
    ], { list: true }));
    await render();
  }

  /** Name, game mode, seed and visibility for a new Minecraft game; the server answers with its share code. Arcade lobbies are made under Realms. */
  private showCreateGame(playerName: string): void {
    const name = h('input', { class: 'mc-input', value: t('mp.create.defaultName', playerName).slice(0, 32), maxLength: 32 });
    const seed = h('input', { class: 'mc-input', placeholder: t('create.seed.placeholder'), maxLength: 32 });
    const password = h('input', { class: 'mc-input', type: 'password', maxLength: 64, placeholder: t('mp.password.optional'), autocomplete: 'off' });
    let listed = false;
    const listedText = () => t('mp.listed', listed ? t('mp.yes') : t('mp.no'));
    const listedHintText = () => (listed ? t('mp.listed.public') : t('mp.listed.private'));
    const listedHint = h('div', { class: 'hint', text: listedHintText() });
    const listedButton = button(listedText(), () => {
      listed = !listed;
      listedButton.textContent = listedText();
      listedHint.textContent = listedHintText();
    });
    const error = h('div', { class: 'error' });
    let mode: GameMode = 'survival';
    const modeHint$ = h('div', { class: 'hint', text: modeHint(mode, GAME_MODE_HINTS[mode]) });
    const modeButton = button(t('create.mode', modeName(mode)), () => {
      mode = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length];
      modeButton.textContent = t('create.mode', modeName(mode));
      modeHint$.textContent = modeHint(mode, GAME_MODE_HINTS[mode]);
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
    this.stack.push(menuScreen(t('mp.create'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('mp.create.name') }), name,
        modeButton, modeHint$,
        h('div', { class: 'field-label', text: t('create.seed') }), seed,
        h('div', { class: 'field-label', text: t('mp.password') }), password,
        listedButton, listedHint,
        h('div', { class: 'hint', text: t('mp.create.share') }),
        error,
      ),
    ], [
      button(t('mp.create.go'), () => void create(), { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => name.select(), 0);
  }

  /** Join any BunkCraft server by address (the page's own server when left empty). */
  showDirectConnect(): void {
    const name = h('input', { class: 'mc-input', value: savedPlayerName(), maxLength: 16, placeholder: t('mp.name.placeholder') });
    const address = h('input', { class: 'mc-input', value: load('bunkcraft.server', ''), maxLength: 120, placeholder: STATIC_BUILD ? 'play.example.com' : location.host });
    const error = h('div', { class: 'error' });
    const join = () => {
      const n = name.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = t('mp.name.invalid');
        return;
      }
      if (STATIC_BUILD && !address.value.trim()) {
        error.textContent = t('mp.direct.needAddress');
        return;
      }
      savePlayerName(n);
      store('bunkcraft.server', address.value.trim());
      this.actions.joinServer(n, address.value.trim());
    };
    for (const i of [name, address]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    const column = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';
    this.stack.push(menuScreen(t('mp.direct.title'), [
      h('div', { style: column },
        h('div', { class: 'field-label', text: t('mp.name') }), name,
        h('div', { class: 'field-label', text: t('mp.direct.address') }), address,
        h('div', { class: 'hint', text: STATIC_BUILD ? t('mp.direct.hintStatic') : t('mp.direct.hint') }),
        error,
      ),
    ], [
      button(t('mp.direct.join'), join, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
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

  /** "Reconnecting..." while the game tries to get the player back in; `update` shows the attempt, `cancel` goes to the title screen. */
  showReconnecting(reason: string, cancel: () => void): { update(text: string): void } {
    this.stack.clear();
    announce(`${t('reconnect.title')} ${reason}`);
    const status = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite', text: '' });
    this.stack.push(menuScreen(t('reconnect.title'), [
      h('div', { class: 'hint', text: reason }),
      h('div', { class: 'hint', text: t('reconnect.hint') }),
      status,
    ], [button(t('reconnect.cancel'), cancel)]));
    return { update: (text) => { status.textContent = text; } };
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

  /**
   * Loading screen: a progress bar with percentage and rotating tips about the real controls. The sandbox gets the
   * dirt background; an arena match (`arena`) the shell's ink with the emblem.
   */
  showLoading(title: string, arena = false): (status: string, progress: number) => void {
    this.stack.clear();
    if (arena) {
      const status = h('div', { class: 'hint', text: t('loading.preparing') });
      const bar = h('div', { class: 'progress-fill' });
      this.stack.push(screen('loading bc',
        h('img', { class: 'loading-emblem', src: svgDataUrl(emblemSvg()), alt: '' }),
        h('div', { class: 'loading-title', text: title }), status, h('div', { class: 'progress' }, bar)));
      return (text, p) => {
        const pct = Math.round(Math.min(1, p) * 100);
        status.textContent = `${text} ${pct}%`;
        bar.style.width = `${pct}%`;
      };
    }
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
export function inviteScreen(code: string, link: string, text: string, done: () => void, shell = false): HTMLDivElement {
  const linkInput = h('input', { class: 'mc-input', value: link, readOnly: true });
  linkInput.addEventListener('focus', () => linkInput.select());
  const copy = button(t('invite.copy'), () => {
    const ok = () => { copy.textContent = t('common.copied'); window.setTimeout(() => { copy.textContent = t('invite.copy'); }, 1500); };
    navigator.clipboard?.writeText(text).then(ok, () => linkInput.select());
    if (!navigator.clipboard) linkInput.select();
  }, { cls: 'w150' });
  return menuScreen(t('invite.title'), [
    h('div', { style: 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);' },
      h('div', { class: 'field-label', text: t('invite.code') }),
      h('div', { class: `death-title${shell ? ' realms-code' : ''}`, text: formatCode(code) }),
      h('div', { class: 'field-label', text: t('invite.link') }), linkInput,
      h('div', { class: 'hint', text: t('invite.hint') }),
    ),
  ], [copy, button(t('common.done'), done, { cls: `w150${shell ? ' primary' : ''}` })], { cls: shell ? 'bc' : '' });
}

function describeError(e: unknown): string {
  return e instanceof ArchiveError ? e.message : 'Something went wrong. The file could not be processed.';
}
