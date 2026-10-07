import { type GameType, type GameTypeDef, gameTypeDef } from '../modes/GameTypes';
import { type ClassSpec, DEFAULT_CLASS, LAST_CLASS_STORAGE_KEY, LOADOUT_PRESETS, loadSavedClass, saveClass, sameClass } from '../modes/Loadouts';
import { MAP_SETTINGS, type MapSetting, getMap } from '../modes/maps';
import { classUnlocked, unlockLevel } from '../modes/progression/Unlocks';
import { BOT_LEVELS, type BotLevel, REALMS_MODES, isArcade, lobbySizes } from '../modes/Realms';
import { OPTICS, PERKS, isPerk, weaponDef } from '../modes/Weapons';
import { NAME_PATTERN, formatCode, normalizeCode } from '../net/protocol';
import { currentProfile, currentRank, loadProfile, onProfile } from '../net/ProfileApi';
import { type ListedRoom, type RoomInfo, browseRooms, createRoom, inviteLink, inviteText, lookupRoom, quickPlay, realmsStats, serverInfo } from '../net/RoomApi';
import { button, h, menuScreen } from './dom';
import { HomeScreen } from './HomeScreen';
import { type I18nKey, t } from './i18n';
import { savePlayerName, savedPlayerName, validSavedName } from './playerName';
import { ProfileScreens } from './ProfileScreens';
import { realmsIcon } from './RealmsIcons';
import type { ScreenStack } from './Screens';
import './realms.css';

/**
 * The arena side of the menus (internally still "Realms": URLs, protocol and storage keys keep that name).
 * The home screen is the front door; this class owns its flows: quick play, the lobby browser, private matches,
 * joining by code, the player name, loadouts and the progression screens.
 */
export interface RealmsActions {
  /** Looks a game up and joins it (asks for the password first when it has one); errors go to `onError`. */
  joinCode(name: string, code: string, onError: (msg: string) => void): Promise<void>;
  /** Build & Survival (beta): the voxel sandbox menus. */
  openSurvival(): void;
  openOptions(): void;
  openLanguage(): void;
  /** Name of the arena map flying by behind the menu. */
  backgroundMap(): string;
  /** "BunkCraft 1.0 (abc1234)" for the footer. */
  version: string;
}

const COLUMN = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 4);';
/** The mode PLAY starts: the last one played or picked on the home screen. */
const MODE_KEY = 'bunkcraft.lastMode';

/** The mode's name in the current language. */
export function realmsModeName(mode: GameType): string {
  return t(`realms.mode.${mode}` as I18nKey);
}

function modeDesc(mode: GameType): string {
  return t(`realms.desc.${mode}` as I18nKey);
}

/** "4:05" */
function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where a listed lobby's match stands: "In progress, 4:05 left", "Warm-up", "Between matches". */
export function phaseText(room: Pick<ListedRoom, 'players' | 'phase' | 'timeLeft' | 'gameType'>): string {
  if (!room.players || !room.phase) return t('realms.phase.empty');
  if (room.phase === 'warmup') return t('realms.phase.warmup');
  if (room.phase === 'ended') return t('realms.phase.ended');
  const rounds = !!gameTypeDef(room.gameType ?? 'minecraft').rounds;
  return rounds || room.timeLeft === undefined ? t('realms.phase.round') : t('realms.phase.live', clock(room.timeLeft));
}

function mapLabel(setting: string | undefined, current?: string): string {
  if (current) return getMap(current).name;
  return !setting || setting === 'rotate' ? t('realms.rotation') : getMap(setting).name;
}

/** Label key of a game type's score or time option. */
function limitLabel(label: string | undefined, fallback: I18nKey): string {
  const keys: Record<string, I18nKey> = {
    'Score Limit': 'realms.limit.score', 'Rounds to Win': 'realms.limit.rounds', 'Captures to Win': 'realms.limit.captures',
    'Time Limit': 'realms.limit.time', 'Round Time': 'realms.limit.roundTime',
  };
  return t(keys[label ?? ''] ?? fallback);
}

function seconds(v: number): string {
  return v >= 120 && v % 60 === 0 ? t('realms.limit.min', v / 60) : t('realms.limit.sec', v);
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The remembered favourite mode (falls back to the first in the playlist). */
export function savedMode(): GameType {
  try {
    const m = storage()?.getItem(MODE_KEY) as GameType | null;
    return m && REALMS_MODES.includes(m) ? m : REALMS_MODES[0];
  } catch {
    return REALMS_MODES[0];
  }
}

function saveMode(mode: GameType): void {
  try { storage()?.setItem(MODE_KEY, mode); } catch { /* private mode: PLAY starts the default next time */ }
}

/**
 * An option button as a row: "Mode: Team Deathmatch" becomes the label on the left and the value on the right
 * (the accessible name stays the whole text).
 */
function setOption(btn: HTMLButtonElement, text: string): void {
  const i = text.indexOf(': ');
  btn.classList.add('bc-option');
  btn.setAttribute('aria-label', text);
  if (i < 0) { btn.textContent = text; return; }
  btn.replaceChildren(h('span', { class: 'opt-k', text: text.slice(0, i) }), h('span', { class: 'opt-v', text: text.slice(i + 2) }));
}

/** A menu screen in the shell look (docs/research/IDENTITY.md). */
function shellScreen(title: string, body: (Node | null)[], footer: (Node | null)[], opts: { list?: boolean; tallFooter?: boolean; cls?: string } = {}): HTMLDivElement {
  return menuScreen(title, body, footer, { ...opts, cls: `bc ${opts.cls ?? ''}` });
}

export class RealmsMenu {
  /** Lobby sizes this server allows (from /api/server, ROOM_MAX_PLAYERS). */
  private sizes: number[] = lobbySizes();
  /** Level bar, stats, challenges and armory. */
  readonly profiles: ProfileScreens;
  private profilesOn = false;
  /** Whether this server runs the arena (null until /api/server answered). */
  private online: boolean | null = null;
  private home: HomeScreen | null = null;

  constructor(private readonly stack: ScreenStack, private readonly actions: RealmsActions) {
    this.profiles = new ProfileScreens(stack);
  }

  /** The front door (the stack is expected to be empty). */
  showHome(message = ''): HomeScreen {
    const home = new HomeScreen({
      play: (mode) => void this.quickPlay(mode),
      selectMode: (mode) => saveMode(mode),
      lobbies: () => void this.showBrowse(),
      privateMatch: (mode) => this.showCreate(mode),
      joinCode: (raw) => this.joinTyped(raw),
      profile: () => (validSavedName() ? this.profiles.showProfile() : this.showName(() => this.refreshHome())),
      loadouts: () => this.showLoadouts(),
      armory: () => this.profiles.showArmory(),
      stats: () => this.profiles.showStats(),
      challenges: () => this.profiles.showChallenges(),
      settings: () => this.actions.openOptions(),
      language: () => this.actions.openLanguage(),
      survival: () => this.actions.openSurvival(),
    }, { mode: savedMode(), version: this.actions.version, mapName: this.actions.backgroundMap() });
    this.home = home;
    this.stack.push(home.el);
    if (message) home.setStatus(message);
    void this.connect(home);
    return home;
  }

  /** Server features, the profile and live player counts for the home screen. */
  private async connect(home: HomeScreen): Promise<void> {
    const info = await serverInfo();
    this.online = !!info?.rooms;
    if (!home.el.isConnected && this.home !== home) return;
    if (!info || !info.rooms) {
      home.setServer('offline');
      return;
    }
    this.sizes = lobbySizes(info.roomMaxPlayers);
    this.profilesOn = !!info.features?.profiles;
    home.setServer('online');
    const off = onProfile((p) => {
      if (this.home !== home) { off(); return; }
      home.setProfile(p, validSavedName(), this.profilesOn);
    });
    this.loadProfile();
    const refresh = async () => {
      if (this.home !== home || !home.el.isConnected) return;
      home.setStats(await realmsStats());
    };
    void refresh();
    const timer = window.setInterval(() => (this.home === home && home.el.isConnected ? void refresh() : window.clearInterval(timer)), 5000);
  }

  /** The profile of this browser (created on first use) once there is a name; joining waits for it. */
  private loadProfile(): void {
    const name = validSavedName();
    if (!name || !this.profilesOn) {
      this.home?.setProfile(currentProfile(), name, this.profilesOn);
      return;
    }
    this.profileReady = loadProfile(name).then(() => undefined);
  }

  /** After a name change: the profile card and progress follow the new name. */
  private refreshHome(): void {
    this.home?.setProfile(currentProfile(), validSavedName(), this.profilesOn);
    this.loadProfile();
  }

  /** Old entry point ("BunkCraft Realms" button, scripts): the home is the hub now. */
  async show(): Promise<void> {
    if (!this.home || !this.home.el.isConnected) this.showHome();
  }

  /** Opens an invite (?join=CODE) or a code typed elsewhere that belongs to an arena lobby. */
  openLobby(code: string, info?: RoomInfo): void {
    const go = () => {
      const name = validSavedName();
      if (!name) return;
      if (info?.gameType) saveMode(info.gameType);
      if (!this.home || !this.home.el.isConnected) {
        this.stack.clear();
        this.showHome();
      }
      this.say(info ? t('realms.invite', realmsModeName(info.gameType ?? 'tdm')) : '');
      void this.join(name, code, (m) => this.say(m, true));
    };
    if (validSavedName()) go();
    else this.showName(go);
  }

  private say(text: string, error = false): void {
    this.home?.setStatus(text, error);
  }

  private busy = false;
  /** The profile request of this visit: joining waits for it so the first match already counts. */
  private profileReady: Promise<void> = Promise.resolve();

  /** Joins a game once the profile is known (at most a few seconds), so the hello carries the profile token. */
  private async join(name: string, code: string, onError: (msg: string) => void): Promise<void> {
    await Promise.race([this.profileReady, new Promise<void>((r) => window.setTimeout(r, 3000))]);
    return this.actions.joinCode(name, code, onError);
  }

  /** A code or invite link typed on the home screen. */
  private joinTyped(raw: string): void {
    const c = normalizeCode(raw);
    if (!c) { this.say(t('realms.join.bad'), true); return; }
    const name = validSavedName();
    if (!name) { this.showName(() => { this.refreshHome(); this.joinTyped(raw); }); return; }
    this.say('');
    void this.join(name, c, (m) => this.say(m, true));
  }

  /** Server-side matchmaking: the fullest public lobby of the mode that is not about to end, or a new one. */
  private async quickPlay(mode: GameType): Promise<void> {
    const name = validSavedName();
    if (!name) { this.showName(() => { this.refreshHome(); void this.quickPlay(mode); }); return; }
    if (this.busy) return;
    this.busy = true;
    saveMode(mode);
    this.say(t('realms.searching', realmsModeName(mode)));
    try {
      const { code } = await quickPlay(mode);
      await this.join(name, code, (m) => this.say(m, true));
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy = false;
    }
  }

  /** Name entry, once: remembered in this browser and shared with the sandbox's Multiplayer. */
  showName(after: () => void): void {
    const input = h('input', { class: 'mc-input', value: savedPlayerName(), maxLength: 16, placeholder: t('realms.name.placeholder') });
    const error = h('div', { class: 'error' });
    const done = () => {
      const n = input.value.trim();
      if (!NAME_PATTERN.test(n)) {
        error.textContent = t('realms.name.invalid');
        input.focus();
        return;
      }
      savePlayerName(n);
      this.stack.pop();
      after();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    this.stack.push(shellScreen(t('realms.name.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.name.label') }), input,
        h('div', { class: 'hint', text: t('realms.name.hint') }),
        error,
      ),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      button(t('common.done'), done, { cls: 'w150 primary' }),
    ]));
    window.setTimeout(() => input.select(), 0);
  }

  /** Public arena lobbies: mode, map, players, phase and time left. */
  async showBrowse(): Promise<void> {
    const name = validSavedName();
    if (!name) { this.showName(() => { this.refreshHome(); void this.showBrowse(); }); return; }
    let filter: GameType | 'all' = 'all';
    let rooms: ListedRoom[] = [];
    let selected: string | null = null;
    const list = h('div', { class: 'world-list realms-list' });
    const error = h('div', { class: 'error' });
    const join = button(t('realms.browse.join'), () => { if (selected) void this.join(name, selected, (m) => { error.textContent = m; }); }, { cls: 'w150 primary' });
    const filterBtn = button('', () => {
      const all: (GameType | 'all')[] = ['all', ...REALMS_MODES];
      filter = all[(all.indexOf(filter) + 1) % all.length];
      render();
    }, { cls: 'w150' });
    const render = () => {
      filterBtn.textContent = t('realms.browse.filter', filter === 'all' ? t('realms.browse.all') : realmsModeName(filter));
      const shown = rooms.filter((r) => filter === 'all' || r.gameType === filter);
      if (!shown.some((r) => r.code === selected)) selected = shown[0]?.code ?? null;
      list.replaceChildren();
      if (shown.length === 0) list.append(h('div', { class: 'world-empty', text: t('realms.browse.empty') }));
      for (const r of shown) {
        const mode = r.gameType ?? 'tdm';
        const full = r.players >= r.maxPlayers;
        const item = h('div', { class: `world-item realms-item${r.code === selected ? ' selected' : ''}`, tabIndex: 0, role: 'button', 'data-code': r.code },
          h('div', { class: 'world-icon-wrap' }, h('img', { class: 'world-icon', src: realmsIcon(mode), alt: '', draggable: false })),
          h('div', { class: 'world-text' },
            h('div', { class: 'world-name', text: r.name }),
            h('div', { class: 'world-meta', text: `${realmsModeName(mode)} - ${mapLabel(r.map, r.currentMap)}` }),
            h('div', { class: `world-meta realms-stats${r.players > 0 ? ' busy' : ''}`, text: `${phaseText(r)}${r.locked ? ` - ${t('realms.locked')}` : ''}` }),
          ),
          h('div', { class: `realms-count${full ? ' full' : ''}`, text: `${r.players}/${r.maxPlayers}${r.bots ? ` +${r.bots} ${t('realms.bots')}` : ''}` }),
        );
        item.addEventListener('click', () => { selected = r.code; render(); });
        item.addEventListener('dblclick', () => void this.join(name, r.code, (m) => { error.textContent = m; }));
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter') void this.join(name, r.code, (m) => { error.textContent = m; }); });
        list.append(item);
      }
      join.disabled = !selected;
    };
    const load = async () => {
      error.textContent = '';
      try {
        rooms = await browseRooms('arcade');
      } catch (e) {
        rooms = [];
        error.textContent = e instanceof Error ? e.message : String(e);
      }
      render();
    };
    const el = shellScreen(t('realms.browse'), [list, error], [
      h('div', { class: 'row' },
        button(t('common.back'), () => this.stack.pop(), { cls: 'w72' }),
        button(t('realms.browse.refresh'), () => void load(), { cls: 'w72' }),
        filterBtn,
        join,
      ),
    ], { list: true, cls: 'realms-screen' });
    render();
    this.stack.push(el);
    await load();
  }

  /** Mode, map (only maps the mode can use), limits, size, bots and visibility; then the code to share. */
  showCreate(initial: GameType = 'tdm'): void {
    const name = validSavedName();
    if (!name) { this.showName(() => { this.refreshHome(); this.showCreate(initial); }); return; }
    let mode: GameType = initial;
    let def: GameTypeDef = gameTypeDef(mode);
    let map: MapSetting = 'rotate';
    let score = def.scoreLimit;
    let time = def.timeLimitSec;
    const sizes = this.sizes;
    let size = sizes.includes(8) ? 8 : sizes[sizes.length - 1];
    let listed = false;
    let bots = 0;
    let botLevel: BotLevel = 'normal';
    const error = h('div', { class: 'error' });
    const modeHint = h('div', { class: 'hint' });
    const mapHint = h('div', { class: 'hint' });
    const listedHint = h('div', { class: 'hint' });
    const modeBtn = button('', () => {
      mode = REALMS_MODES[(REALMS_MODES.indexOf(mode) + 1) % REALMS_MODES.length];
      def = gameTypeDef(mode);
      score = def.scoreLimit;
      time = def.timeLimitSec;
      render();
    });
    const maps = (): MapSetting[] => ['rotate', ...MAP_SETTINGS.filter((m) => m !== 'rotate' && getMap(m).supports(def.requires))];
    const next = <T>(list: T[], cur: T): T => list[(Math.max(0, list.indexOf(cur)) + 1) % list.length];
    const mapBtn = button('', () => { map = next(maps(), map); render(); });
    const scoreBtn = button('', () => { score = next(def.options?.score ?? [], score); render(); });
    const timeBtn = button('', () => { time = next(def.options?.time ?? [], time); render(); });
    const sizeBtn = button('', () => { size = next(sizes, size); render(); });
    const listedBtn = button('', () => { listed = !listed; render(); });
    const botChoices = () => Array.from({ length: size }, (_, i) => i);
    const botsBtn = button('', () => { bots = next(botChoices(), bots); render(); });
    const botLevelBtn = button('', () => { botLevel = next(BOT_LEVELS, botLevel); render(); });
    const botsHint = h('div', { class: 'hint' });
    const render = () => {
      setOption(modeBtn, t('realms.create.mode', realmsModeName(mode)));
      modeHint.textContent = modeDesc(mode);
      if (!maps().includes(map)) map = 'rotate';
      setOption(mapBtn, t('realms.create.map', map === 'rotate' ? t('realms.create.rotate') : getMap(map).name));
      mapHint.textContent = map === 'rotate' ? t('realms.create.rotateHint') : getMap(map).description;
      const scoreChoices = def.options?.score ?? [];
      scoreBtn.classList.toggle('hidden', scoreChoices.length === 0);
      setOption(scoreBtn, t('realms.limit.value', limitLabel(def.options?.scoreLabel, 'realms.limit.score'), score));
      setOption(timeBtn, t('realms.limit.value', limitLabel(def.options?.timeLabel, 'realms.limit.time'), seconds(time)));
      setOption(sizeBtn, t('realms.create.players', size));
      setOption(listedBtn, t('realms.create.listed', listed ? t('common.on') : t('common.off')));
      listedHint.textContent = listed ? t('realms.create.listedHint') : t('realms.create.privateHint');
      if (bots > size - 1) bots = size - 1;
      setOption(botsBtn, t('realms.create.bots', bots === 0 ? t('common.off') : bots));
      setOption(botLevelBtn, t('realms.create.botLevel', t(`realms.bot.${botLevel}`)));
      botLevelBtn.classList.toggle('hidden', bots === 0);
      botsHint.textContent = bots === 0 ? '' : t('realms.create.botsHint');
    };
    render();
    let busy = false;
    const create = async () => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      try {
        const code = await createRoom(t('realms.create.name', name), 'survival', '', {
          gameType: mode, scoreLimit: score, timeLimitSec: time, mapId: map, maxPlayers: size, listed,
          ...(bots > 0 ? { bots, botDifficulty: botLevel } : {}),
        });
        saveMode(mode);
        this.stack.pop();
        this.showCreated(name, code);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    };
    this.stack.push(shellScreen(t('realms.create.title'), [
      h('div', { class: 'bc-form' },
        h('div', { class: 'bc-form-col' }, modeBtn, modeHint, mapBtn, mapHint, listedBtn, listedHint),
        h('div', { class: 'bc-form-col' }, scoreBtn, timeBtn, sizeBtn, botsBtn, botLevelBtn, botsHint),
      ),
      error,
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      button(t('realms.create.button'), () => void create(), { cls: 'w150 primary' }),
    ]));
  }

  /** The new lobby's code and invite link; Play joins it. */
  private showCreated(name: string, code: string): void {
    const link = h('input', { class: 'mc-input', value: inviteLink(code), readOnly: true });
    link.addEventListener('focus', () => link.select());
    const error = h('div', { class: 'error' });
    const copy = button(t('realms.created.copy'), () => {
      const ok = () => { copy.textContent = t('common.copied'); window.setTimeout(() => { copy.textContent = t('realms.created.copy'); }, 1500); };
      navigator.clipboard?.writeText(inviteText(code)).then(ok, () => link.select());
      if (!navigator.clipboard) link.select();
    });
    this.stack.push(shellScreen(t('realms.created.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.created.code') }),
        h('div', { class: 'death-title realms-code', text: formatCode(code) }),
        h('div', { class: 'field-label', text: t('realms.created.link') }), link,
        copy,
        h('div', { class: 'hint', text: t('realms.created.hint') }),
        error,
      ),
    ], [
      button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
      button(t('realms.created.play'), () => void this.join(name, code, (m) => { error.textContent = m; }), { cls: 'w150 primary' }),
    ]));
  }

  /** Join a lobby (or any game) with a code or an invite link. */
  showJoinCode(prefill = ''): void {
    const name = validSavedName();
    if (!name) { this.showName(() => { this.refreshHome(); this.showJoinCode(prefill); }); return; }
    const input = h('input', { class: 'mc-input', value: prefill, maxLength: 80, placeholder: t('realms.join.placeholder') });
    const preview = h('div', { class: 'hint' });
    const error = h('div', { class: 'error' });
    let timer = 0;
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      preview.textContent = '';
      const c = normalizeCode(input.value);
      if (!c) return;
      timer = window.setTimeout(() => {
        lookupRoom(c).then((r) => {
          if (normalizeCode(input.value) !== c) return;
          preview.textContent = isArcade(r.gameType)
            ? `${r.name} - ${realmsModeName(r.gameType!)} - ${mapLabel(r.map)} - ${r.players}/${r.maxPlayers}`
            : `${r.name} - ${t('home.build')} - ${r.players}/${r.maxPlayers}`;
        }, () => undefined);
      }, 250);
    });
    const join = () => {
      const c = normalizeCode(input.value);
      if (!c) { error.textContent = t('realms.join.bad'); return; }
      error.textContent = '';
      void this.join(name, c, (m) => { error.textContent = m; });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    this.stack.push(shellScreen(t('realms.joinCode'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.join.label') }), input,
        preview,
        error,
      ),
    ], [
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
      button(t('realms.browse.join'), join, { cls: 'w150 primary' }),
    ]));
    window.setTimeout(() => input.focus(), 0);
  }

  /**
   * Loadouts: the class the next match starts with (the presets and the custom class built with Create-a-Class
   * in a match). Locked presets show their level; picking one is remembered in this browser like in the match.
   */
  showLoadouts(): void {
    const store = storage();
    const rank = currentRank();
    const custom = loadSavedClass(store);
    let equipped: ClassSpec | null = loadSavedClass(store, LAST_CLASS_STORAGE_KEY);
    const list = h('div', { class: 'loadout-list' });
    const gear = (c: ClassSpec) => {
      const optic = c.optic === 'iron' ? '' : ` (${OPTICS[c.optic].name})`;
      const perk = isPerk(c.perk) && c.perk !== 'none' ? ` · ${PERKS[c.perk].name}` : '';
      return `${weaponDef(c.primary)?.name ?? c.primary}${optic} + ${weaponDef(c.secondary)?.name ?? c.secondary}${perk}`;
    };
    // The level the whole class needs: its highest unlock (a weapon's own default sights are always open).
    const lockLevel = (c: ClassSpec) => Math.max(unlockLevel('primary', c.primary), unlockLevel('secondary', c.secondary),
      unlockLevel('perk', c.perk), weaponDef(c.primary)?.optics[0] === c.optic ? 1 : unlockLevel('optic', c.optic));
    const now = h('div', { class: 'prog-muted' });
    const render = () => {
      const entries: { key: string; name: string; desc: string; spec: ClassSpec | null }[] = [
        ...LOADOUT_PRESETS.map((p, i) => ({ key: String(i + 1), name: p.name, desc: t(`arc.class.${p.id}` as I18nKey), spec: p as ClassSpec })),
        { key: String(LOADOUT_PRESETS.length + 1), name: t('arc.custom'), desc: custom ? '' : t('loadouts.customEmpty'), spec: custom },
      ];
      now.textContent = t('loadouts.now', gear(equipped ?? DEFAULT_CLASS));
      list.replaceChildren(...entries.map((e) => {
        const open = !!e.spec && classUnlocked(e.spec, rank);
        const on = !!e.spec && !!equipped && sameClass(e.spec, equipped);
        const tag = !e.spec ? '' : on ? t('loadouts.equipped') : open ? t('loadouts.equip') : t('armory.locked', lockLevel(e.spec));
        const card = h('button', { class: `loadout-card${on ? ' selected' : ''}`, type: 'button', disabled: !open, 'aria-pressed': String(on) },
          h('span', { class: 'loadout-key', text: e.key }),
          h('span', { class: 'loadout-text' },
            h('span', { class: 'loadout-name', text: e.name }),
            e.spec ? h('span', { class: 'loadout-gear', text: gear(e.spec) }) : null,
            e.desc ? h('span', { class: 'loadout-desc', text: e.desc }) : null),
          h('span', { class: `loadout-tag${e.spec && !open ? ' locked' : ''}`, text: tag }));
        card.addEventListener('click', () => {
          if (!e.spec || !open) return;
          saveClass(store, e.spec, LAST_CLASS_STORAGE_KEY);
          equipped = e.spec;
          render();
          (list.querySelector('.loadout-card.selected') as HTMLElement | null)?.focus({ preventScroll: true });
        });
        return card;
      }));
    };
    render();
    this.stack.push(shellScreen(t('loadouts.title'), [
      h('div', { class: 'prog-panel' }, h('div', { class: 'prog-muted', text: t('loadouts.hint') }), now),
      list,
    ], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { list: true }));
  }

  /** Whether this server runs the arena (null while unknown). */
  get serverOnline(): boolean | null {
    return this.online;
  }
}
