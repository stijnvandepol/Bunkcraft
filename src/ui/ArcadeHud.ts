import { TEAM_COLORS, type Team } from '../modes/GameTypes';
import { type KillFeedEntry, damageAngle, formatClock, kdRatio, sortRoster } from '../modes/ArcadeLogic';
import { PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, type WeaponDef, weaponDef } from '../modes/Weapons';
import type { MatchPhase, RosterEntry } from '../net/protocol';
import { h } from './dom';

const MAX_DAMAGE_MARKERS = 6;
const DAMAGE_LIFETIME = 1.6;
/** Health below this flashes red. */
const LOW_HEALTH = 30;

export interface ScoreboardContext {
  selfId: number;
  teams: boolean;
  scores: { red: number; blue: number };
}

interface DamageMarker {
  el: HTMLDivElement;
  born: number;
  dx: number;
  dz: number;
  /** Last written rotation in whole degrees (skips style writes when unchanged). */
  deg: number;
  fade: number;
}

function teamColor(team: Team | ''): string {
  return team ? TEAM_COLORS[team] : '#ffffff';
}

/** Short weapon label for the kill feed ("RIFLE", "SNIPER"). */
function weaponTag(id: string): string {
  const def = weaponDef(id);
  return (def ? def.name.replace('Assault ', '').replace(' Rifle', '') : id).toUpperCase();
}

/**
 * Arcade HUD: health, ammo, crosshair with hit markers and damage indicators, kill feed, match
 * timer and scores, scoreboard, banners and the death, match end and loadout screens. All DOM is
 * created once; per-frame methods only write to the DOM when a displayed value actually changes.
 */
export class ArcadeHud {
  readonly el: HTMLDivElement;
  /** The loadout menu is clickable: it lives apart from the (click-through) HUD layer. */
  readonly loadoutEl: HTMLDivElement;

  private readonly healthNum: HTMLSpanElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthBox: HTMLDivElement;
  private readonly weaponName: HTMLDivElement;
  private readonly ammoMag: HTMLSpanElement;
  private readonly ammoSep: HTMLSpanElement;
  private readonly reloadBar: HTMLDivElement;
  private readonly reloadFill: HTMLDivElement;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly crosshair: HTMLDivElement;
  private readonly hit: HTMLDivElement;
  private readonly damageLayer: HTMLDivElement;
  private readonly markers: DamageMarker[] = [];
  private readonly feed: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly leftScore: HTMLDivElement;
  private readonly rightScore: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly subline: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly protect: HTMLDivElement;
  private readonly scope: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly death: HTMLDivElement;
  private readonly deathTitle: HTMLDivElement;
  private readonly deathDetail: HTMLDivElement;
  private readonly deathCount: HTMLDivElement;
  private readonly deathLoadout: HTMLDivElement;
  private readonly end: HTMLDivElement;
  private readonly endTitle: HTMLDivElement;
  private readonly endBoard: HTMLDivElement;
  private readonly endCount: HTMLDivElement;
  private readonly loadoutCards = new Map<string, HTMLDivElement>();
  private readonly loadoutNote: HTMLDivElement;

  private lastHealth = -1;
  private lastGap = -1;
  private lastRespawnPending = '';
  private lastMag = -1;
  private lastAmmoDef: WeaponDef | null = null;
  private lastReloadPct = -1;
  private lastSlots = '';
  private lastProtect = -1;
  private lastBanner = '';
  private lastCount = -1;
  private lastEndCount = -1;

  /** Called when a primary weapon is chosen in the loadout menu. */
  onLoadout: ((primary: string) => void) | null = null;
  onLoadoutClose: (() => void) | null = null;

  constructor() {
    // -- health
    this.healthNum = h('span', { class: 'arc-health-num', text: String(PLAYER_MAX_HEALTH) });
    this.healthFill = h('div', { class: 'arc-health-fill' });
    this.healthBox = h('div', { class: 'arc-health' },
      h('div', { class: 'arc-health-row' }, h('span', { class: 'arc-health-label', text: 'HEALTH' }), this.healthNum),
      h('div', { class: 'arc-health-bar' }, this.healthFill),
    );

    // -- ammo and weapon slots
    this.weaponName = h('div', { class: 'arc-weapon-name' });
    this.ammoMag = h('span', { class: 'arc-ammo-mag' });
    this.ammoSep = h('span', { class: 'arc-ammo-reserve', text: ' / ∞' });
    this.reloadFill = h('div', { class: 'arc-reload-fill' });
    this.reloadBar = h('div', { class: 'arc-reload hidden' }, this.reloadFill);
    const slots = h('div', { class: 'arc-slots' });
    for (let i = 0; i < 3; i++) {
      const slot = h('div', { class: 'arc-slot' });
      this.slotEls.push(slot);
      slots.append(slot);
    }
    const ammo = h('div', { class: 'arc-ammo' },
      slots,
      this.weaponName,
      h('div', { class: 'arc-ammo-row' }, this.ammoMag, this.ammoSep),
      this.reloadBar,
    );

    // -- crosshair, hit marker, damage indicators
    this.crosshair = h('div', { class: 'arc-xh' }, h('i', { class: 't' }), h('i', { class: 'b' }), h('i', { class: 'l' }), h('i', { class: 'r' }), h('i', { class: 'dot' }));
    this.hit = h('div', { class: 'arc-hit' }, h('i'), h('i'), h('i'), h('i'));
    this.damageLayer = h('div', { class: 'arc-damage' });
    for (let i = 0; i < MAX_DAMAGE_MARKERS; i++) {
      const el = h('div', { class: 'arc-dmg hidden' });
      this.markers.push({ el, born: -10, dx: 0, dz: 0, deg: NaN, fade: -1 });
      this.damageLayer.append(el);
    }

    // -- kill feed, timer and scores
    this.feed = h('div', { class: 'arc-feed' });
    this.leftScore = h('div', { class: 'arc-score' });
    this.rightScore = h('div', { class: 'arc-score' });
    this.clock = h('div', { class: 'arc-clock', text: '0:00' });
    this.subline = h('div', { class: 'arc-subline' });
    this.top = h('div', { class: 'arc-top' },
      h('div', { class: 'arc-top-row' }, this.leftScore, this.clock, this.rightScore),
      this.subline,
    );
    this.banner = h('div', { class: 'arc-banner hidden' });
    this.protect = h('div', { class: 'arc-protect hidden' });
    this.scope = h('div', { class: 'arc-scope hidden' }, h('i', { class: 'h' }), h('i', { class: 'v' }));
    this.board = h('div', { class: 'arc-board hidden' });

    // -- death
    this.deathTitle = h('div', { class: 'arc-death-title' });
    this.deathDetail = h('div', { class: 'arc-death-detail' });
    this.deathCount = h('div', { class: 'arc-death-count' });
    this.deathLoadout = h('div', { class: 'arc-death-loadout' });
    this.death = h('div', { class: 'arc-death hidden' }, this.deathTitle, this.deathDetail, this.deathCount, this.deathLoadout);

    // -- match end
    this.endTitle = h('div', { class: 'arc-end-title' });
    this.endBoard = h('div', { class: 'arc-end-board' });
    this.endCount = h('div', { class: 'arc-end-count' });
    this.end = h('div', { class: 'arc-end hidden' }, this.endTitle, this.endBoard, this.endCount);

    this.el = h('div', { class: 'arc-hud hidden' },
      this.scope, this.crosshair, this.hit, this.damageLayer, this.protect,
      this.top, this.banner, this.feed, this.healthBox, ammo,
      this.board, this.death, this.end,
    );

    // -- loadout menu (clickable)
    this.loadoutNote = h('div', { class: 'arc-loadout-note' });
    const cards = h('div', { class: 'arc-loadout-cards' });
    for (const id of PRIMARY_WEAPONS) {
      const def = weaponDef(id)!;
      const card = h('div', { class: 'arc-card' },
        h('div', { class: 'arc-card-name', text: def.name }),
        ...statRows(def),
      );
      card.addEventListener('click', () => this.onLoadout?.(id));
      this.loadoutCards.set(id, card);
      cards.append(card);
    }
    this.loadoutEl = h('div', { class: 'arc-loadout hidden' },
      h('div', { class: 'arc-loadout-panel' },
        h('div', { class: 'arc-loadout-title', text: 'Loadout' }),
        cards,
        this.loadoutNote,
        h('button', { class: 'mc-btn w150', text: 'Done', onclick: () => this.onLoadoutClose?.() }),
      ),
    );
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  // ---------------------------------------------------------------- self

  setHealth(hp: number): void {
    const v = Math.max(0, Math.min(PLAYER_MAX_HEALTH, Math.round(hp)));
    if (v === this.lastHealth) return;
    this.lastHealth = v;
    this.healthNum.textContent = String(v);
    this.healthFill.style.width = `${(v / PLAYER_MAX_HEALTH) * 100}%`;
    this.healthBox.classList.toggle('low', v > 0 && v < LOW_HEALTH);
  }

  /** The three weapons (primary, secondary, melee) and which one is in hand. */
  setSlots(names: readonly string[], selected: number, keys: readonly string[]): void {
    const sig = `${names.join('|')}#${selected}#${keys.join('|')}`;
    if (sig === this.lastSlots) return;
    this.lastSlots = sig;
    for (let i = 0; i < 3; i++) {
      const el = this.slotEls[i];
      el.replaceChildren(h('b', { text: keys[i] ?? '' }), ` ${names[i] ?? ''}`);
      el.classList.toggle('selected', i === selected);
    }
  }

  setWeapon(def: WeaponDef): void {
    this.weaponName.textContent = def.name;
  }

  /** Magazine counter; melee weapons have none. `reload` is 0..1 progress, or −1 when not reloading. */
  setAmmo(def: WeaponDef, mag: number, reload: number): void {
    if (mag !== this.lastMag || def !== this.lastAmmoDef) {
      this.lastMag = mag;
      this.lastAmmoDef = def;
      const melee = def.magazine === 0;
      this.ammoMag.textContent = melee ? '' : String(mag);
      this.ammoSep.classList.toggle('hidden', melee);
      this.ammoMag.classList.toggle('empty', !melee && mag === 0);
    }
    const pct = reload < 0 ? -1 : Math.round(reload * 50) * 2;
    if (pct === this.lastReloadPct) return;
    this.lastReloadPct = pct;
    this.reloadBar.classList.toggle('hidden', pct < 0);
    if (pct >= 0) this.reloadFill.style.width = `${pct}%`;
  }

  /** Crosshair gap (pixels from the centre to the inner end of each line); hidden while scoped. */
  setCrosshair(gap: number, visible: boolean): void {
    this.crosshair.classList.toggle('hidden', !visible);
    const g = Math.round(gap * 2) / 2;
    if (g === this.lastGap) return;
    this.lastGap = g;
    this.crosshair.style.setProperty('--g', `${g}px`);
  }

  setScope(on: boolean): void {
    this.scope.classList.toggle('hidden', !on);
  }

  /** Spawn protection: seconds left (0 hides it). */
  setProtection(left: number): void {
    const q = left <= 0 ? 0 : Math.ceil(left * 10);
    if (q === this.lastProtect) return;
    this.lastProtect = q;
    this.protect.classList.toggle('hidden', q === 0);
    if (q > 0) this.protect.textContent = `SPAWN PROTECTION ${(q / 10).toFixed(1)}`;
  }

  // ---------------------------------------------------------------- feedback

  /** White tick, gold for a headshot, red for a kill. */
  showHit(kind: 'hit' | 'head' | 'kill'): void {
    const el = this.hit;
    el.classList.remove('show', 'hit', 'head', 'kill');
    void el.offsetWidth; // restart the animation
    el.classList.add('show', kind);
  }

  /** Red wedge around the crosshair towards the shooter; (dx, dz) points from you to them. */
  addDamage(dx: number, dz: number, now: number): void {
    // Reuse the oldest marker.
    let m = this.markers[0];
    for (const c of this.markers) if (c.born < m.born) m = c;
    m.born = now;
    m.dx = dx;
    m.dz = dz;
    m.deg = NaN;
    m.fade = -1;
    m.el.classList.remove('hidden');
  }

  /** Per frame: turns the damage wedges with the view and fades them. */
  frame(now: number, yaw: number): void {
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const age = now - m.born;
      if (age > DAMAGE_LIFETIME) {
        if (!Number.isNaN(m.deg)) {
          m.deg = NaN;
          m.el.classList.add('hidden');
        }
        continue;
      }
      const deg = Math.round((damageAngle(m.dx, m.dz, yaw) * 180) / Math.PI);
      if (deg !== m.deg) {
        m.deg = deg;
        m.el.style.transform = `rotate(${deg}deg) translateY(calc(var(--s) * -44))`;
      }
      const fade = Math.round(Math.max(0, 1 - age / DAMAGE_LIFETIME) * 10);
      if (fade !== m.fade) {
        m.fade = fade;
        m.el.style.opacity = String(fade / 10);
      }
    }
  }

  // ---------------------------------------------------------------- feed, match, scoreboard

  setKillFeed(entries: readonly KillFeedEntry[], selfName: string): void {
    this.feed.replaceChildren(...entries.map((e) => h('div', { class: `arc-feed-row${e.killer === selfName || e.victim === selfName ? ' self' : ''}` },
      h('span', { style: `color:${teamColor(e.killerTeam)}`, text: e.killer }),
      h('span', { class: 'arc-feed-weapon', text: weaponTag(e.weapon) }),
      e.head ? h('span', { class: 'arc-feed-head', text: 'HS' }) : null,
      h('span', { style: `color:${teamColor(e.victimTeam)}`, text: e.victim }),
    )));
  }

  /** Timer, team scores (or your own score in free for all) and the phase line. Call when something changed. */
  setMatch(phase: MatchPhase, timeLeft: number, ctx: ScoreboardContext & { scoreLimit: number; selfKills: number; leader: string }): void {
    this.clock.textContent = phase === 'warmup' ? 'WARM-UP' : formatClock(timeLeft);
    this.rightScore.classList.toggle('hidden', !ctx.teams);
    if (ctx.teams) {
      this.leftScore.textContent = String(ctx.scores.red);
      this.leftScore.style.background = TEAM_COLORS.red;
      this.rightScore.textContent = String(ctx.scores.blue);
      this.rightScore.style.background = TEAM_COLORS.blue;
      this.subline.textContent = `First to ${ctx.scoreLimit}`;
    } else {
      this.leftScore.textContent = `${ctx.selfKills}/${ctx.scoreLimit}`;
      this.leftScore.style.background = '#3a3a3a';
      this.rightScore.textContent = '';
      this.subline.textContent = ctx.leader;
    }
  }

  /** Centre banner under the timer; empty text hides it. */
  setBanner(text: string): void {
    if (text === this.lastBanner) return;
    this.lastBanner = text;
    this.banner.textContent = text;
    this.banner.classList.toggle('hidden', text === '');
  }

  setScoreboard(visible: boolean, roster: readonly RosterEntry[], ctx: ScoreboardContext): void {
    this.board.classList.toggle('hidden', !visible);
    if (visible) renderBoard(this.board, roster, ctx);
  }

  // ---------------------------------------------------------------- death, end, loadout

  /** Shows the elimination screen; `killer` is empty when unknown. Null hides it. */
  setDeath(info: { killer: string; weapon: string; head: boolean; killerTeam: Team | '' } | null): void {
    this.death.classList.toggle('hidden', info === null);
    this.lastCount = -1;
    this.lastRespawnPending = '\0';
    if (!info) return;
    this.deathTitle.textContent = info.killer ? `You were eliminated by ${info.killer}` : 'You were eliminated';
    this.deathTitle.style.color = info.killerTeam ? TEAM_COLORS[info.killerTeam] : '#fff';
    this.deathDetail.textContent = info.killer ? `${weaponTag(info.weapon)}${info.head ? '  -  HEADSHOT' : ''}` : '';
  }

  /** Respawn countdown in whole seconds; also lists the loadout choices. */
  setRespawn(seconds: number, primary: string, pending: string): void {
    const n = Math.max(0, Math.ceil(seconds));
    if (n === this.lastCount && pending === this.lastRespawnPending) return;
    this.lastCount = n;
    this.lastRespawnPending = pending;
    this.deathCount.textContent = `Respawning in ${n}`;
    this.deathLoadout.replaceChildren(h('div', { class: 'arc-death-hint', text: 'Next weapon (keys 1-4, or B for the loadout menu)' }),
      h('div', { class: 'arc-death-weapons' }, ...PRIMARY_WEAPONS.map((id, i) =>
        h('span', { class: id === (pending || primary) ? 'sel' : '', text: `${i + 1} ${weaponDef(id)!.name}` }))));
  }

  setMatchEnd(info: { title: string; color: string; roster: readonly RosterEntry[]; ctx: ScoreboardContext } | null): void {
    this.end.classList.toggle('hidden', info === null);
    this.lastEndCount = -1;
    if (!info) return;
    this.endTitle.textContent = info.title;
    this.endTitle.style.color = info.color;
    renderBoard(this.endBoard, info.roster, info.ctx);
  }

  setNextMatch(seconds: number): void {
    const n = Math.max(0, Math.ceil(seconds));
    if (n === this.lastEndCount) return;
    this.lastEndCount = n;
    this.endCount.textContent = `Next match in ${n}`;
  }

  showLoadout(selected: string, nextLife: boolean): void {
    this.loadoutEl.classList.remove('hidden');
    this.markLoadout(selected);
    this.loadoutNote.textContent = nextLife ? 'Applies from your next life' : 'Applies when you respawn';
  }

  markLoadout(selected: string): void {
    for (const [id, card] of this.loadoutCards) card.classList.toggle('selected', id === selected);
  }

  hideLoadout(): void {
    this.loadoutEl.classList.add('hidden');
  }

  get loadoutOpen(): boolean {
    return !this.loadoutEl.classList.contains('hidden');
  }

  /** Clears everything transient (new game, leaving). */
  reset(): void {
    this.setDeath(null);
    this.setMatchEnd(null);
    this.setScope(false);
    this.setBanner('');
    this.hideLoadout();
    this.feed.replaceChildren();
    for (const m of this.markers) {
      m.born = -10;
      m.deg = NaN;
      m.el.classList.add('hidden');
    }
    this.lastHealth = this.lastGap = this.lastProtect = -1;
    this.lastMag = -1;
    this.lastAmmoDef = null;
    this.lastRespawnPending = '';
    this.lastSlots = '';
  }
}

function statRows(def: WeaponDef): HTMLElement[] {
  const bar = (label: string, frac: number) => h('div', { class: 'arc-stat' },
    h('span', { text: label }), h('div', { class: 'arc-stat-bar' }, h('i', { style: `width:${Math.round(Math.min(1, Math.max(0.05, frac)) * 100)}%` })));
  return [
    bar('Damage', (def.damage * def.pellets * 0.6) / 100),
    bar('Fire rate', def.rpm / 900),
    bar('Range', def.range / 120),
    bar('Magazine', def.magazine / 30),
    h('div', { class: 'arc-card-desc', text: def.auto ? 'Automatic' : 'Semi-automatic' }),
  ];
}

/** Scoreboard table: rank, name (team colour), kills, deaths, K/D and ping; yours is highlighted. */
function renderBoard(host: HTMLElement, roster: readonly RosterEntry[], ctx: ScoreboardContext): void {
  const rows: HTMLElement[] = [];
  const header = h('div', { class: 'arc-row head' },
    h('span', { class: 'rank', text: '#' }), h('span', { class: 'name', text: 'Player' }),
    h('span', { text: 'Kills' }), h('span', { text: 'Deaths' }), h('span', { text: 'K/D' }), h('span', { text: 'Ping' }));
  rows.push(header);
  sortRoster(roster).forEach((p, i) => {
    rows.push(h('div', { class: `arc-row${p.id === ctx.selfId ? ' self' : ''}` },
      h('span', { class: 'rank', text: String(i + 1) }),
      h('span', { class: 'name', style: `color:${teamColor(p.team)}`, text: p.name }),
      h('span', { text: String(p.kills) }), h('span', { text: String(p.deaths) }),
      h('span', { text: kdRatio(p.kills, p.deaths) }), h('span', { text: p.ping > 0 ? String(Math.round(p.ping)) : '-' })));
  });
  const children: HTMLElement[] = [];
  if (ctx.teams) {
    children.push(h('div', { class: 'arc-board-scores' },
      h('span', { style: `color:${TEAM_COLORS.red}`, text: `RED ${ctx.scores.red}` }),
      h('span', { class: 'sep', text: ' - ' }),
      h('span', { style: `color:${TEAM_COLORS.blue}`, text: `${ctx.scores.blue} BLUE` })));
  }
  children.push(...rows);
  host.replaceChildren(...children);
}
