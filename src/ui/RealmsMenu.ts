import { type GameType, type GameTypeDef, gameTypeDef } from '../modes/GameTypes';
import { MAP_SETTINGS, type MapSetting, getMap } from '../modes/maps';
import { type ModeStats, REALMS_MODES, isArcade, lobbySizes } from '../modes/Realms';
import { NAME_PATTERN, formatCode, normalizeCode } from '../net/protocol';
import { type ListedRoom, type RoomInfo, browseRooms, createRoom, inviteLink, inviteText, lookupRoom, quickPlay, realmsStats, serverInfo } from '../net/RoomApi';
import { button, h, menuScreen } from './dom';
import { type I18nKey, t } from './i18n';
import { savePlayerName, savedPlayerName, validSavedName } from './playerName';
import { realmsIcon } from './RealmsIcons';
import type { ScreenStack } from './Screens';
import './realms.css';

export interface RealmsActions {
  /** Looks a game up and joins it (asks for the password first when it has one); errors go to `onError`. */
  joinCode(name: string, code: string, onError: (msg: string) => void): Promise<void>;
}

/** How often the playlist refreshes its player counts. */
const STATS_REFRESH_MS = 10_000;

const COLUMN = 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);';

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

/**
 * BunkCraft Realms: the arcade minigames hub. A playlist of the modes with Quick Play (server-side
 * matchmaking), the public lobby browser, private lobbies with a code, and joining by code. Laid out like
 * Minecraft's world and server lists.
 */
export class RealmsMenu {
  /** Lobby sizes this server allows (from /api/server, ROOM_MAX_PLAYERS). */
  private sizes: number[] = lobbySizes();

  constructor(private readonly stack: ScreenStack, private readonly actions: RealmsActions) {}

  /** The playlist. Asks for a player name first when none is saved. */
  async show(): Promise<void> {
    const info = await serverInfo();
    this.sizes = lobbySizes(info?.roomMaxPlayers);
    if (!info || !info.rooms) {
      this.stack.push(menuScreen(t('title.realms'), [h('div', { class: 'hint', text: t('realms.offline') })], [
        button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
      ]));
      return;
    }
    if (!validSavedName()) {
      this.showName(() => void this.showHub());
      return;
    }
    this.showHub();
  }

  /** Opens Realms for an invite (?join=CODE) or a code typed under Multiplayer that belongs to a Realms lobby. */
  openLobby(code: string, info?: RoomInfo): void {
    const go = () => {
      const name = validSavedName();
      if (!name) return;
      this.showHub(info ? t('realms.invite', realmsModeName(info.gameType ?? 'tdm')) : '');
      void this.actions.joinCode(name, code, (m) => this.say(m, true));
    };
    if (validSavedName()) go();
    else this.showName(go);
  }

  private status: HTMLElement | null = null;

  private say(text: string, error = false): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.className = error ? 'error realms-status' : 'hint realms-status';
  }

  private showHub(message = ''): void {
    const name = validSavedName() ?? '';
    let selected: GameType = REALMS_MODES[0];
    let stats: ModeStats[] = [];
    const list = h('div', { class: 'world-list realms-list' });
    const status = h('div', { class: 'hint realms-status', text: message || t('realms.hint') });
    this.status = status;
    const rows = new Map<GameType, { item: HTMLElement; stats: HTMLElement }>();
    for (const mode of REALMS_MODES) {
      const statsEl = h('div', { class: 'world-meta realms-stats' });
      const icon = h('div', { class: 'world-icon-wrap' }, h('img', { class: 'world-icon', src: realmsIcon(mode), alt: '', draggable: false }));
      const item = h('div', { class: 'world-item realms-item', tabIndex: 0, 'data-mode': mode },
        icon,
        h('div', { class: 'world-text' },
          h('div', { class: 'world-name', text: realmsModeName(mode) }),
          h('div', { class: 'world-meta', text: modeDesc(mode) }),
          statsEl,
        ),
      );
      const select = () => { selected = mode; for (const [m, r] of rows) r.item.classList.toggle('selected', m === mode); };
      item.addEventListener('click', select);
      icon.addEventListener('click', (e) => { e.stopPropagation(); select(); void this.quickPlay(mode); });
      item.addEventListener('dblclick', () => void this.quickPlay(mode));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.quickPlay(mode);
        else if (e.key === ' ') { e.preventDefault(); select(); }
      });
      rows.set(mode, { item, stats: statsEl });
      list.append(item);
    }
    rows.get(selected)!.item.classList.add('selected');
    const renderStats = () => {
      for (const [mode, r] of rows) {
        const s = stats.find((x) => x.gameType === mode);
        const players = s?.players ?? 0;
        r.stats.textContent = players === 0 ? t('realms.statsNone')
          : s!.lobbies === 1 ? t('realms.statsOne', players) : t('realms.stats', players, Math.max(1, s!.lobbies));
        r.stats.classList.toggle('busy', players > 0);
      }
    };
    renderStats();

    const nameLine = h('div', { class: 'realms-name' },
      h('span', { class: 'hint', text: t('realms.playingAs', name) }),
      button(t('realms.changeName'), () => this.showName(() => { this.stack.pop(); this.showHub(); }), { cls: 'realms-small' }),
    );
    const el = menuScreen(t('title.realms'), [list, status], [
      h('div', { class: 'row' },
        button(t('realms.quickPlay'), () => void this.quickPlay(selected), { cls: 'w150' }),
        button(t('realms.browse'), () => void this.showBrowse(), { cls: 'w150' }),
      ),
      h('div', { class: 'row' },
        button(t('realms.private'), () => this.showCreate(selected), { cls: 'half' }),
        button(t('realms.joinCode'), () => this.showJoinCode(), { cls: 'half' }),
        button(t('common.back'), () => this.stack.pop(), { cls: 'half' }),
      ),
    ], { list: true, tallFooter: true, cls: 'realms-screen' });
    const header = el.querySelector<HTMLElement>('.screen-header')!;
    header.classList.add('realms-header');
    header.append(nameLine);
    this.stack.push(el);

    // Live player counts while the playlist is open and in view (not under another screen, not in a hidden tab).
    const refresh = async () => {
      if (!el.isConnected) return;
      stats = await realmsStats();
      renderStats();
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!el.isConnected) window.clearInterval(timer);
      else if (!document.hidden && this.stack.top === el) void refresh();
    }, STATS_REFRESH_MS);
  }

  private busy = false;

  /** Server-side matchmaking: the fullest public lobby of the mode that is not about to end, or a new one. */
  private async quickPlay(mode: GameType): Promise<void> {
    const name = validSavedName();
    if (!name) { this.showName(() => void this.quickPlay(mode)); return; }
    if (this.busy) return;
    this.busy = true;
    this.say(t('realms.searching', realmsModeName(mode)));
    try {
      const { code } = await quickPlay(mode);
      await this.actions.joinCode(name, code, (m) => this.say(m, true));
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy = false;
    }
  }

  /** Name entry, once: remembered in this browser and shared with Multiplayer. */
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
    this.stack.push(menuScreen(t('realms.name.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.name.label') }), input,
        h('div', { class: 'hint', text: t('realms.name.hint') }),
        error,
      ),
    ], [
      button(t('common.done'), done, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => input.select(), 0);
  }

  /** Public arcade lobbies: mode, map, players, phase and time left. */
  async showBrowse(): Promise<void> {
    const name = validSavedName();
    if (!name) { this.showName(() => void this.showBrowse()); return; }
    let filter: GameType | 'all' = 'all';
    let rooms: ListedRoom[] = [];
    let selected: string | null = null;
    const list = h('div', { class: 'world-list realms-list' });
    const error = h('div', { class: 'error' });
    const join = button(t('realms.browse.join'), () => { if (selected) void this.actions.joinCode(name, selected, (m) => { error.textContent = m; }); }, { cls: 'w150' });
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
        const item = h('div', { class: `world-item realms-item${r.code === selected ? ' selected' : ''}`, tabIndex: 0, 'data-code': r.code },
          h('div', { class: 'world-icon-wrap' }, h('img', { class: 'world-icon', src: realmsIcon(mode), alt: '', draggable: false })),
          h('div', { class: 'world-text' },
            h('div', { class: 'world-name', text: r.name }),
            h('div', { class: 'world-meta', text: `${realmsModeName(mode)} - ${mapLabel(r.map, r.currentMap)}` }),
            h('div', { class: `world-meta realms-stats${r.players > 0 ? ' busy' : ''}`, text: `${phaseText(r)}${r.locked ? ` - ${t('realms.locked')}` : ''}` }),
          ),
          h('div', { class: `realms-count${full ? ' full' : ''}`, text: `${r.players}/${r.maxPlayers}` }),
        );
        item.addEventListener('click', () => { selected = r.code; render(); });
        item.addEventListener('dblclick', () => void this.actions.joinCode(name, r.code, (m) => { error.textContent = m; }));
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter') void this.actions.joinCode(name, r.code, (m) => { error.textContent = m; }); });
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
    const el = menuScreen(t('realms.browse'), [list, error], [
      h('div', { class: 'row' }, join, filterBtn),
      h('div', { class: 'row' },
        button(t('realms.browse.refresh'), () => void load(), { cls: 'w150' }),
        button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
      ),
    ], { list: true, tallFooter: true, cls: 'realms-screen' });
    render();
    this.stack.push(el);
    await load();
  }

  /** Mode, map (only maps the mode can use), limits, size and visibility; then the code to share. */
  showCreate(initial: GameType = 'tdm'): void {
    const name = validSavedName();
    if (!name) { this.showName(() => this.showCreate(initial)); return; }
    let mode: GameType = initial;
    let def: GameTypeDef = gameTypeDef(mode);
    let map: MapSetting = 'rotate';
    let score = def.scoreLimit;
    let time = def.timeLimitSec;
    const sizes = this.sizes;
    let size = sizes.includes(8) ? 8 : sizes[sizes.length - 1];
    let listed = false;
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
    const render = () => {
      modeBtn.textContent = t('realms.create.mode', realmsModeName(mode));
      modeHint.textContent = modeDesc(mode);
      if (!maps().includes(map)) map = 'rotate';
      mapBtn.textContent = t('realms.create.map', map === 'rotate' ? t('realms.create.rotate') : getMap(map).name);
      mapHint.textContent = map === 'rotate' ? t('realms.create.rotateHint') : getMap(map).description;
      const scoreChoices = def.options?.score ?? [];
      scoreBtn.classList.toggle('hidden', scoreChoices.length === 0);
      scoreBtn.textContent = t('realms.limit.value', limitLabel(def.options?.scoreLabel, 'realms.limit.score'), score);
      timeBtn.textContent = t('realms.limit.value', limitLabel(def.options?.timeLabel, 'realms.limit.time'), seconds(time));
      sizeBtn.textContent = t('realms.create.players', size);
      listedBtn.textContent = t('realms.create.listed', listed ? t('common.on') : t('common.off'));
      listedHint.textContent = listed ? t('realms.create.listedHint') : t('realms.create.privateHint');
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
        });
        this.stack.pop();
        this.showCreated(name, code);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    };
    this.stack.push(menuScreen(t('realms.create.title'), [
      h('div', { style: COLUMN },
        modeBtn, modeHint,
        mapBtn, mapHint,
        scoreBtn, timeBtn, sizeBtn,
        listedBtn, listedHint,
        error,
      ),
    ], [
      button(t('realms.create.button'), () => void create(), { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
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
    this.stack.push(menuScreen(t('realms.created.title'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.created.code') }),
        h('div', { class: 'death-title realms-code', text: formatCode(code) }),
        h('div', { class: 'field-label', text: t('realms.created.link') }), link,
        copy,
        h('div', { class: 'hint', text: t('realms.created.hint') }),
        error,
      ),
    ], [
      button(t('realms.created.play'), () => void this.actions.joinCode(name, code, (m) => { error.textContent = m; }), { cls: 'w150' }),
      button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }

  /** Join a lobby (or any game) with a code or an invite link. */
  showJoinCode(prefill = ''): void {
    const name = validSavedName();
    if (!name) { this.showName(() => this.showJoinCode(prefill)); return; }
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
            : `${r.name} - Minecraft - ${r.players}/${r.maxPlayers}`;
        }, () => undefined);
      }, 250);
    });
    const join = () => {
      const c = normalizeCode(input.value);
      if (!c) { error.textContent = t('realms.join.bad'); return; }
      error.textContent = '';
      void this.actions.joinCode(name, c, (m) => { error.textContent = m; });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    this.stack.push(menuScreen(t('realms.joinCode'), [
      h('div', { style: COLUMN },
        h('div', { class: 'field-label', text: t('realms.join.label') }), input,
        preview,
        error,
      ),
    ], [
      button(t('realms.browse.join'), join, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
    window.setTimeout(() => input.focus(), 0);
  }
}
