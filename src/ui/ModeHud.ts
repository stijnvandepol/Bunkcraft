import * as THREE from 'three';
import { type GameTypeDef, TEAM_COLORS, type Team } from '../modes/GameTypes';
import {
  type FlagState, type ModeState, type ZoneState,
} from '../net/protocol';
import {
  flagAction, flagLine, otherTeam, placeMarker, zoneColor, zoneLetter, zoneRing, zoneStatus,
} from '../modes/ModeView';
import { weaponDef } from '../modes/Weapons';
import { h } from './dom';

const MAX_MARKERS = 6;
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
}

const tmp = new THREE.Vector3();
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

  constructor(private readonly def: GameTypeDef) {
    this.markerLayer = h('div', { class: 'mode-markers' });
    for (let i = 0; i < MAX_MARKERS; i++) {
      const icon = h('div', { class: 'mm-icon' });
      const caption = h('div', { class: 'mm-caption' });
      const dist = h('div', { class: 'mm-dist' });
      const el = h('div', { class: 'mode-marker hidden' }, icon, caption, dist);
      this.markerLayer.append(el);
      this.markers.push({ el, icon, caption, dist, px: -1, py: -1, shown: false, key: '', meters: -1, x: 0, y: 0, z: 0, active: false, carrier: 0 });
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
      h('div', { class: 'mode-ladder-level', text: `LEVEL ${Math.min(level + 1, ladder.length)} / ${ladder.length}` }),
      h('div', { class: 'mode-ladder-weapon', text: name(cur) }),
      h('div', { class: 'mode-ladder-next', text: next ? `Next: ${name(next)}` : 'Last weapon: get a kill to win' }),
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
      placeMarker(tmp.x, tmp.y, behind, width, height, 40, placed, Math.min(height * 0.3, 150));
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
        if (show) this.setZoneMarker(this.markers[i], z, i, st, self.team);
      });
      this.panel.replaceChildren(...(st.variant === 'hardpoint' ? [h('div', { class: 'mode-line', text: st.gap ? `Next hill in ${Math.ceil(st.rotateIn)}` : `Hill moves in ${Math.ceil(st.rotateIn)}` })] : []));
    } else if (st.kind === 'ctf') {
      st.flags.forEach((f, i) => this.setFlagMarker(this.markers[i], f, self));
      this.panel.replaceChildren(...st.flags.map((f) => h('div', { class: 'mode-line', style: `color:${TEAM_COLORS[f.team]}`, text: flagLine(f, nameOf) })));
    } else if (st.kind === 'rounds') {
      const pips = (team: Team) => {
        const row = h('div', { class: 'mode-pips' });
        for (let i = 0; i < st.need; i++) row.append(h('i', { style: i < st.wins[team] ? `background:${TEAM_COLORS[team]}` : '' }));
        return row;
      };
      const mine = self.team || 'red';
      this.panel.replaceChildren(h('div', { class: 'mode-rounds' },
        pips('red'),
        h('div', { class: 'mode-alive', text: `${st.alive[mine]} v ${st.alive[otherTeam(mine)]}` }),
        pips('blue'),
      ));
    }
  }

  /** Index of the hill after the last live one (hardpoint pause). */
  private nextHill(zones: readonly ZoneState[]): number {
    let last = -1;
    zones.forEach((z, i) => { if (z.active) last = i; });
    return last >= 0 ? last : (this.lastActive + 1) % Math.max(1, zones.length);
  }

  private lastActive = 0;

  private setZoneMarker(m: Marker, z: ZoneState, i: number, st: Extract<ModeState, { kind: 'zones' }>, self: Team | ''): void {
    if (z.active) this.lastActive = i;
    m.active = true;
    m.x = z.x; m.y = z.y + 2.2; m.z = z.z;
    m.key = `zone:${i}`;
    const ring = zoneRing(z, st.variant);
    const color = zoneColor(z);
    m.icon.textContent = st.variant === 'hardpoint' ? '' : zoneLetter(i);
    m.icon.className = `mm-icon zone${z.contested ? ' contested' : ''}${!z.active ? ' dim' : ''}`;
    m.icon.style.borderColor = color;
    m.icon.style.background = `conic-gradient(${ring.color} ${Math.round(ring.fill * 360)}deg, rgba(0,0,0,0.55) 0deg)`;
    m.caption.textContent = z.active ? zoneStatus(z, self, st.variant) : `NEXT: ${z.name}`;
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
    m.caption.textContent = flagAction(f, self.team, self.id);
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
