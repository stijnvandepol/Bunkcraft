import * as THREE from 'three';
import { type GameTypeDef, TEAM_COLORS, type Team } from '../modes/GameTypes';
import {
  type FlagState, type ModeState, type SiteState, type TagState, type ZoneState,
} from '../net/protocol';
import {
  CONTESTED_COLOR, bombRoleLine, flagAction, flagLine, infectedLine, nearestTags, otherTeam, placeMarker, siteAction, tagAction,
  zoneColor, zoneLetter, zoneRing, zoneStatus,
} from '../modes/ModeView';
import { weaponDef } from '../modes/Weapons';
import { h } from './dom';
import { t } from './i18n';

const MAX_MARKERS = 6;
/** Kill confirmed: markers for this many of the nearest tags. */
const TAG_MARKERS = 4;
const TOAST_SECONDS = 2.6;

interface Marker {
  el: HTMLDivElement;
  icon: HTMLDivElement;
  caption: HTMLDivElement;
  dist: HTMLDivElement;
  /** Last written values, so the DOM is only touched on change. */
  px: number; py: number; shown: boolean; key: string; meters: number;
  /** World position of the thing it marks. */
  x: number; y: number; z: number;
  active: boolean;
  /** Player id when it marks a carried flag (follows the carrier), else 0. */
  carrier: number;
  /** Half the marker's width in px (measured once after its caption changes; -1 = measure again). */
  halfW: number;
}

const tmp = new THREE.Vector3();

function setCaption(m: Marker, text: string): void {
  if (m.caption.textContent === text) return;
  m.caption.textContent = text;
  m.halfW = -1;
}
const placed = { x: 0, y: 0, edge: false };

/**
 * HUD widgets of the objective modes, driven by the server's `mode` state: zone and flag markers
 * in world space (projected every frame, stuck to the screen edge when off-screen, visible through
 * walls), a score bar towards the limit, the flag status lines, round pips with the survivors, the
 * gun game ladder and short event toasts. Mounted inside the arcade HUD layer.
 */
export class ModeHud {
  readonly el: HTMLDivElement;
  private readonly markerLayer: HTMLDivElement;
  private readonly markers: Marker[] = [];
  private readonly bar: HTMLDivElement;
  private readonly barRed: HTMLDivElement;
  private readonly barBlue: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastUntil = 0;
  private state: ModeState | null = null;
  private dirty = true;
  private lastBar = '';
  private ladderKey = '';
  /** Camera position of the last frame (kill confirmed picks the nearest tags with it). */
  private readonly eye = new THREE.Vector3();
  private readonly nearTags: TagState[] = [];

  constructor(private readonly def: GameTypeDef) {
    this.markerLayer = h('div', { class: 'mode-markers' });
    for (let i = 0; i < MAX_MARKERS; i++) {
      const icon = h('div', { class: 'mm-icon' });
      const caption = h('div', { class: 'mm-caption' });
      const dist = h('div', { class: 'mm-dist' });
      const el = h('div', { class: 'mode-marker hidden' }, icon, caption, dist);
      this.markerLayer.append(el);
      this.markers.push({ el, icon, caption, dist, px: -1, py: -1, shown: false, key: '', meters: -1, x: 0, y: 0, z: 0, active: false, carrier: 0, halfW: -1 });
    }
    this.barRed = h('div', { class: 'mode-bar-fill red' });
    this.barBlue = h('div', { class: 'mode-bar-fill blue' });
    this.bar = h('div', { class: 'mode-bar hidden' }, h('div', { class: 'mode-bar-half' }, this.barRed), h('div', { class: 'mode-bar-half' }, this.barBlue));
    this.panel = h('div', { class: 'mode-panel' });
    this.toastEl = h('div', { class: 'mode-toast hidden' });
    this.el = h('div', { class: 'mode-hud' }, this.markerLayer, this.bar, this.panel, this.toastEl);
    this.bar.classList.toggle('hidden', !(def.hud ?? []).some((w) => w === 'zones' || w === 'flags'));
  }

  setState(state: ModeState | null): void {
    this.state = state;
    this.dirty = true;
  }

  get current(): ModeState | null {
    return this.state;
  }

  /** Team scores against the limit (zones, flags). */
  setScores(red: number, blue: number, limit: number): void {
    const key = `${red}|${blue}|${limit}`;
    if (key === this.lastBar || limit <= 0) return;
    this.lastBar = key;
    this.barRed.style.width = `${Math.min(100, (red / limit) * 100)}%`;
    this.barBlue.style.width = `${Math.min(100, (blue / limit) * 100)}%`;
  }

  /** Gun game: your level (0-based) on the ladder. */
  setLadder(level: number, ladder: readonly string[], leader: string): void {
    const key = `${level}|${leader}`;
    if (key === this.ladderKey) return;
    this.ladderKey = key;
    const cur = ladder[Math.min(level, ladder.length - 1)], next = ladder[level + 1];
    const name = (id: string | undefined) => (id ? weaponDef(id)?.name ?? id : '');
    const steps = h('div', { class: 'mode-ladder-steps' });
    for (let i = 0; i < ladder.length; i++) steps.append(h('i', { class: i < level ? 'done' : i === level ? 'now' : '' }));
    this.panel.replaceChildren(h('div', { class: 'mode-ladder' },
      h('div', { class: 'mode-ladder-level', text: t('mode.ladder.level', Math.min(level + 1, ladder.length), ladder.length) }),
      h('div', { class: 'mode-ladder-weapon', text: name(cur) }),
      h('div', { class: 'mode-ladder-next', text: next ? t('mode.ladder.next', name(next)) : t('mode.ladder.last') }),
      steps,
      leader ? h('div', { class: 'mode-ladder-next', text: leader }) : null,
    ));
  }

  toast(text: string, color: string, now: number): void {
    if (!text) return;
    this.toastEl.textContent = text;
    this.toastEl.style.color = color;
    this.toastEl.classList.remove('hidden');
    this.toastUntil = now + TOAST_SECONDS;
  }

  /**
   * Per frame: projects the markers and refreshes the panels when the state changed. `selfPos` is the
   * camera position (for distances); `carrierPos` resolves a flag carrier's current position.
   */
  frame(
    now: number, camera: THREE.PerspectiveCamera, width: number, height: number, self: { team: Team | ''; id: number },
    nameOf: (id: number) => string, carrierPos: (id: number, out: THREE.Vector3) => boolean,
  ): void {
    if (this.toastUntil > 0 && now >= this.toastUntil) {
      this.toastUntil = 0;
      this.toastEl.classList.add('hidden');
    }
    const st = this.state;
    this.eye.copy(camera.position);
    if (this.dirty) {
      this.dirty = false;
      this.refresh(st, self, nameOf);
    }
    for (const m of this.markers) {
      if (!m.active) {
        if (m.shown) { m.shown = false; m.el.classList.add('hidden'); }
        continue;
      }
      // A carried flag follows its carrier between server updates.
      if (m.carrier !== 0 && carrierPos(m.carrier, tmp)) { m.x = tmp.x; m.y = tmp.y + 2.4; m.z = tmp.z; }
      tmp.set(m.x, m.y, m.z).project(camera);
      const behind = tmp.z > 1;
      // Edge markers keep clear of the score bar on top and of the health/ammo panels at the bottom
      // (an objective under your feet would otherwise sit on top of the ammo counter).
      // The side margin covers half the caption, so a wide one ("CONTESTED", "KILL CARRIER") is not cut off at the edge.
      // (Measured while visible: a hidden marker has no width.)
      if (m.halfW < 0 && m.shown) m.halfW = m.el.offsetWidth / 2;
      placeMarker(tmp.x, tmp.y, behind, width, height, Math.max(40, m.halfW + 6), placed, Math.min(height * 0.3, 150), Math.min(height * 0.32, 230));
      const px = Math.round(placed.x), py = Math.round(placed.y);
      if (px !== m.px || py !== m.py) {
        m.px = px; m.py = py;
        m.el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
      }
      const meters = Math.round(camera.position.distanceTo(tmp.set(m.x, m.y, m.z)));
      if (meters !== m.meters) {
        m.meters = meters;
        m.dist.textContent = `${meters}m`;
      }
      if (!m.shown) { m.shown = true; m.el.classList.remove('hidden'); }
    }
  }

  /** Rebuilds marker contents and the panel from a new state. */
  private refresh(st: ModeState | null, self: { team: Team | ''; id: number }, nameOf: (id: number) => string): void {
    for (const m of this.markers) { m.active = false; m.carrier = 0; }
    if (!st) return;
    if (st.kind === 'zones') {
      st.zones.forEach((z, i) => {
        if (i >= MAX_MARKERS) return;
        // Hardpoint shows the live hill (or, during the pause, where the next one will be).
        const show = st.variant === 'domination' || z.active || (st.gap && i === this.nextHill(st.zones));
        if (show) this.setZoneMarker(this.markers[i], z, i, st, self);
      });
      this.panel.replaceChildren(...(st.variant !== 'domination' ? [h('div', { class: 'mode-line', text: t(st.gap ? 'mode.hill.next' : 'mode.hill.moves', Math.ceil(st.rotateIn)) })] : []));
    } else if (st.kind === 'ctf') {
      st.flags.forEach((f, i) => this.setFlagMarker(this.markers[i], f, self));
      this.panel.replaceChildren(...st.flags.map((f) => h('div', { class: 'mode-line', style: `color:${TEAM_COLORS[f.team]}`, text: flagLine(f, nameOf) })));
    } else if (st.kind === 'rounds') {
      this.panel.replaceChildren(this.roundsRow(st, self.team));
    } else if (st.kind === 'bomb') {
      const bomb = st.sites.find((x) => x.planted);
      st.sites.forEach((x, i) => { if (i < MAX_MARKERS) this.setSiteMarker(this.markers[i], x, st.attackers, self.team, !!bomb); });
      const lines: HTMLElement[] = [this.roundsRow(st, self.team)];
      const role = bombRoleLine(st.attackers, self.team);
      if (role) lines.push(h('div', { class: 'mode-line', style: `color:${self.team === st.attackers ? '#ff9f2a' : '#7fc8ff'}`, text: role }));
      if (bomb) lines.push(h('div', { class: 'mode-line mode-alert', text: t('mode.bomb.fuse', bomb.name, Math.ceil(st.fuseIn)) }));
      else if (st.swapIn > 0) lines.push(h('div', { class: 'mode-line mode-sub', text: st.swapIn === 1 ? t('mode.bomb.swapLast') : t('mode.bomb.swapIn', st.swapIn) }));
      this.panel.replaceChildren(...lines);
    } else if (st.kind === 'tags') {
      nearestTags(st.tags, this.eye.x, this.eye.z, TAG_MARKERS, this.nearTags);
      this.nearTags.forEach((tag, i) => this.setTagMarker(this.markers[i], tag, self.team));
      this.panel.replaceChildren(...(st.tags.length ? [h('div', { class: 'mode-line mode-sub', text: t('mode.tag.count', st.tags.length) })] : []));
    } else if (st.kind === 'infected') {
      const color = self.team === 'red' ? TEAM_COLORS.red : st.last === self.id ? '#ffd23f' : '#7fc8ff';
      this.panel.replaceChildren(
        h('div', { class: 'mode-line mode-big', style: `color:${color}`, text: infectedLine(st, self.team, self.id) }),
        h('div', { class: 'mode-line', text: t('mode.inf.count', st.survivors, st.infected) }),
      );
    } else if (st.kind === 'roulette') {
      const name = weaponDef(st.weapon)?.name ?? st.weapon;
      this.panel.replaceChildren(h('div', { class: 'mode-ladder' },
        h('div', { class: 'mode-ladder-level', text: t('mode.roulette.title') }),
        h('div', { class: 'mode-ladder-weapon', text: name }),
        h('div', { class: 'mode-ladder-next', text: t('mode.roulette.next', Math.ceil(st.switchIn)) }),
      ));
    }
  }

  /** Round pips per team with the survivors in between (elimination, search and destroy). */
  private roundsRow(st: { need: number; wins: { red: number; blue: number }; alive: { red: number; blue: number } }, self: Team | ''): HTMLElement {
    const pips = (team: Team) => {
      const row = h('div', { class: 'mode-pips' });
      for (let i = 0; i < st.need; i++) row.append(h('i', { style: i < st.wins[team] ? `background:${TEAM_COLORS[team]}` : '' }));
      return row;
    };
    const mine = self || 'red';
    return h('div', { class: 'mode-rounds' },
      pips('red'),
      h('div', { class: 'mode-alive', text: `${st.alive[mine]} v ${st.alive[otherTeam(mine)]}` }),
      pips('blue'),
    );
  }

  private setSiteMarker(m: Marker, x: SiteState, attackers: Team, self: Team | '', planted: boolean): void {
    // Once the bomb is down only its site matters.
    if (planted && !x.planted) return;
    m.active = true;
    m.x = x.x; m.y = x.y + 2.2; m.z = x.z;
    m.key = `site:${x.name}`;
    const color = x.planted ? TEAM_COLORS.red : x.progress > 0 ? CONTESTED_COLOR : '#ffffff';
    m.icon.textContent = x.name;
    m.icon.className = `mm-icon zone${x.planted ? ' contested' : ''}`;
    m.icon.style.borderColor = color;
    m.icon.style.background = `conic-gradient(${color} ${Math.round(x.progress * 360)}deg, rgba(0,0,0,0.55) 0deg)`;
    setCaption(m, siteAction(x, attackers, self, planted));
    m.caption.style.color = color;
  }

  private setTagMarker(m: Marker, tag: TagState, self: Team | ''): void {
    m.active = true;
    m.x = tag.x; m.y = tag.y + 1.2; m.z = tag.z;
    m.key = `tag:${tag.id}`;
    const color = TEAM_COLORS[tag.team];
    m.icon.textContent = '';
    m.icon.className = 'mm-icon tag';
    m.icon.style.borderColor = color;
    m.icon.style.background = color;
    setCaption(m, tagAction(tag, self));
    m.caption.style.color = tag.team === self ? '#7fc8ff' : '#ffd23f';
  }

  /** Index of the hill after the last live one (hardpoint pause). */
  private nextHill(zones: readonly ZoneState[]): number {
    let last = -1;
    zones.forEach((z, i) => { if (z.active) last = i; });
    return last >= 0 ? last : (this.lastActive + 1) % Math.max(1, zones.length);
  }

  private lastActive = 0;

  private setZoneMarker(m: Marker, z: ZoneState, i: number, st: Extract<ModeState, { kind: 'zones' }>, self: { team: Team | ''; id: number }): void {
    if (z.active) this.lastActive = i;
    m.active = true;
    m.x = z.x; m.y = z.y + 2.2; m.z = z.z;
    m.key = `zone:${i}`;
    const ring = zoneRing(z, st.variant, self.id);
    const color = zoneColor(z, self.id);
    m.icon.textContent = st.variant === 'domination' ? zoneLetter(i) : '';
    m.icon.className = `mm-icon zone${z.contested ? ' contested' : ''}${!z.active ? ' dim' : ''}`;
    m.icon.style.borderColor = color;
    m.icon.style.background = `conic-gradient(${ring.color} ${Math.round(ring.fill * 360)}deg, rgba(0,0,0,0.55) 0deg)`;
    setCaption(m, z.active ? zoneStatus(z, self.team, st.variant, self.id) : t('mode.zone.next', z.name));
    m.caption.style.color = color;
  }

  private setFlagMarker(m: Marker, f: FlagState, self: { team: Team | ''; id: number }): void {
    // Your own carried flag needs no marker on yourself.
    if (f.status === 'carried' && f.carrier === self.id) return;
    m.active = true;
    m.x = f.x; m.y = f.y + 2.4; m.z = f.z;
    m.key = `flag:${f.team}`;
    m.carrier = f.status === 'carried' ? f.carrier : 0;
    m.icon.textContent = '';
    m.icon.className = `mm-icon flag ${f.status}`;
    m.icon.style.borderColor = TEAM_COLORS[f.team];
    m.icon.style.background = TEAM_COLORS[f.team];
    setCaption(m, flagAction(f, self.team, self.id));
    m.caption.style.color = TEAM_COLORS[f.team];
  }

  reset(): void {
    this.state = null;
    this.dirty = true;
    this.toastUntil = 0;
    this.toastEl.classList.add('hidden');
    this.panel.replaceChildren();
    this.ladderKey = '';
    this.lastBar = '';
    for (const m of this.markers) { m.active = false; m.shown = false; m.el.classList.add('hidden'); }
  }

  get definition(): GameTypeDef {
    return this.def;
  }
}
