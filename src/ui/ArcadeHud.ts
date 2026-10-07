import { TEAM_COLORS, type Team } from '../modes/GameTypes';
import { type KillFeedEntry, damageAngle, formatClock, kdRatio, sortRoster } from '../modes/ArcadeLogic';
import { type ClassSpec, LOADOUT_PRESETS, presetFor, sameClass, validateClass } from '../modes/Loadouts';
import {
  OPTICS, type OpticId, PERKS, PERK_IDS, type PerkId, PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, SECONDARY_WEAPONS, type WeaponDef,
  fireMode, opticAllowed, opticZoom, weaponDef,
} from '../modes/Weapons';
import type { MatchPhase, RosterEntry } from '../net/protocol';
import { h } from './dom';
import { t } from './i18n';
import type { Rank } from '../modes/progression/Levels';
import { classUnlocked, isUnlocked, unlockLevel } from '../modes/progression/Unlocks';
import { rankBadge } from './RankBadge';

const MAX_DAMAGE_MARKERS = 6;
const DAMAGE_LIFETIME = 1.6;
/** Health below this flashes red. */
const LOW_HEALTH = 30;

export interface ScoreboardContext {
  selfId: number;
  teams: boolean;
  scores: { red: number; blue: number };
  /** Header of the mode's objective column ("Caps", "Level"); absent = no column. */
  scoreColumn?: string;
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

/** Perk name for labels: perk names are product names, "No Perk" is a label. */
function perkName(p: PerkId): string {
  return p === 'none' ? t('arc.noPerk') : PERKS[p].name;
}

/** Scoreboard header of the mode's objective column (the data value stays English). */
function scoreColumnLabel(col: string): string {
  return col === 'Level' ? t('arc.board.level') : col === 'Caps' ? t('arc.board.caps') : col;
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
  private readonly deathWatch: HTMLDivElement;
  private lastWatch = '';
  private readonly end: HTMLDivElement;
  private readonly endTitle: HTMLDivElement;
  private readonly endBoard: HTMLDivElement;
  private readonly endCount: HTMLDivElement;
  private readonly presetCards = new Map<string, HTMLDivElement>();
  private readonly customCard: HTMLDivElement;
  private readonly customDesc: HTMLDivElement;
  /** Create-a-Class editor buttons per field and value. */
  private readonly pick = { primary: new Map<string, HTMLElement>(), optic: new Map<string, HTMLElement>(), secondary: new Map<string, HTMLElement>(), perk: new Map<string, HTMLElement>() };
  private readonly statsEl: HTMLDivElement;
  private readonly loadoutNote: HTMLDivElement;
  private custom: ClassSpec = validateClass(null);
  private readonly scopeBreath: HTMLDivElement;
  private readonly scopeBreathFill: HTMLDivElement;
  private readonly scopeHint: HTMLDivElement;
  private lastBreath = -1;
  private readonly medal: HTMLDivElement;
  private medalUntil = 0;

  private lastHealth = -1;
  private lastGap = -1;
  private crosshairVisible = true;
  private scopeOn = false;
  private lastRespawnPending = '';
  private lastRespawnClass: ClassSpec | null = null;
  private lastMag = -1;
  private lastAmmoDef: WeaponDef | null = null;
  private lastReloadPct = -1;
  private lastSlots = '';
  private lastProtect = -1;
  private lastBanner = '';
  private lastCount = -1;
  private lastEndCount = -1;

  /** A class was chosen: a preset card, or the custom class (any change in the editor; save it). */
  onClass: ((c: ClassSpec, custom: boolean) => void) | null = null;
  onLoadoutClose: (() => void) | null = null;

  constructor() {
    // -- health
    this.healthNum = h('span', { class: 'arc-health-num', text: String(PLAYER_MAX_HEALTH) });
    this.healthFill = h('div', { class: 'arc-health-fill' });
    this.healthBox = h('div', { class: 'arc-health' },
      h('div', { class: 'arc-health-row' }, h('span', { class: 'arc-health-label', text: t('arc.health') }), this.healthNum),
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
    this.scopeBreathFill = h('div', { class: 'arc-breath-fill' });
    this.scopeBreath = h('div', { class: 'arc-breath' }, this.scopeBreathFill);
    this.scopeHint = h('div', { class: 'arc-scope-hint', text: t('arc.scope.steady') });
    // Scope: black surround, the lens edge, a duplex reticle with mil-dots and a centre gap, the breath meter.
    const dots = h('div', { class: 'arc-scope-dots' });
    for (let i = -4; i <= 4; i++) if (i !== 0) dots.append(h('b', { style: `--i:${i}` }), h('b', { class: 'dv', style: `--i:${i}` }));
    this.scope = h('div', { class: 'arc-scope hidden' },
      h('div', { class: 'arc-scope-lens' }, h('i', { class: 'h' }), h('i', { class: 'v' }), h('i', { class: 'hl' }), h('i', { class: 'hr' }), h('i', { class: 'vb' }), dots),
      this.scopeBreath, this.scopeHint);
    this.medal = h('div', { class: 'arc-medal hidden' });
    this.board = h('div', { class: 'arc-board hidden' });

    // -- death
    this.deathTitle = h('div', { class: 'arc-death-title' });
    this.deathDetail = h('div', { class: 'arc-death-detail' });
    this.deathCount = h('div', { class: 'arc-death-count' });
    this.deathLoadout = h('div', { class: 'arc-death-loadout' });
    this.deathWatch = h('div', { class: 'arc-death-watch hidden' });
    this.death = h('div', { class: 'arc-death hidden' }, this.deathTitle, this.deathDetail, this.deathCount, this.deathWatch, this.deathLoadout);

    // -- match end
    this.endTitle = h('div', { class: 'arc-end-title' });
    this.endBoard = h('div', { class: 'arc-end-board' });
    this.endCount = h('div', { class: 'arc-end-count' });
    this.end = h('div', { class: 'arc-end hidden' }, this.endTitle, this.endBoard, this.endCount);

    this.el = h('div', { class: 'arc-hud hidden' },
      this.scope, this.crosshair, this.hit, this.damageLayer, this.protect, this.medal,
      this.top, this.banner, this.feed, this.healthBox, ammo,
      this.board, this.death, this.end,
    );

    // -- Create-a-Class menu (clickable): quick-pick presets, the custom class and its editor.
    this.loadoutNote = h('div', { class: 'arc-loadout-note' });
    const presets = h('div', { class: 'arc-loadout-cards presets' });
    LOADOUT_PRESETS.forEach((pr, i) => {
      const card = h('div', { class: 'arc-chip', title: `${classLine(pr)} · ${perkName(pr.perk)}: ${t(`arc.class.${pr.id}`, pr.description)}` },
        h('b', { text: String(i + 1) }), ` ${pr.name}`);
      card.addEventListener('click', () => { if (classUnlocked(pr, this.rank)) this.onClass?.(pr, false); });
      this.presetCards.set(pr.id, card);
      presets.append(card);
    });
    this.customDesc = h('div', { class: 'arc-class-line' });
    this.customCard = h('div', { class: 'arc-chip custom' }, h('b', { text: String(LOADOUT_PRESETS.length + 1) }), ` ${t('arc.custom')}`);
    this.customCard.addEventListener('click', () => this.onClass?.(this.custom, true));
    presets.append(this.customCard);

    const column = (title: string, field: keyof typeof this.pick, items: { id: string; label: string; tag?: string; desc?: string }[]) => {
      const col = h('div', { class: 'arc-cac-col' }, h('div', { class: 'arc-cac-head', text: title }));
      for (const it of items) {
        const b = h('div', { class: 'arc-cac-item', title: it.desc ?? '', 'data-tag': it.tag ?? '' }, h('span', { text: it.label }), h('em', { text: it.tag ?? '' }));
        b.addEventListener('click', () => this.editCustom(field, it.id));
        this.pick[field].set(it.id, b);
        col.append(b);
      }
      return col;
    };
    const wItem = (id: string) => {
      const w = weaponDef(id)!;
      return { id, label: w.name, tag: fireMode(w).toUpperCase(), desc: t(`arc.role.${id}`, w.role) };
    };
    this.statsEl = h('div', { class: 'arc-cac-stats' });
    const editor = h('div', { class: 'arc-cac' },
      column(t('arc.cac.primary'), 'primary', PRIMARY_WEAPONS.map(wItem)),
      column(t('arc.cac.optic'), 'optic', (Object.keys(OPTICS) as OpticId[]).map((o) => ({ id: o, label: OPTICS[o].name, desc: t(`arc.optic.${o}`, OPTICS[o].desc) }))),
      column(t('arc.cac.secondary'), 'secondary', SECONDARY_WEAPONS.map(wItem)),
      column(t('arc.cac.perk'), 'perk', PERK_IDS.map((p) => ({ id: p, label: perkName(p), desc: t(`arc.perk.${p}`, PERKS[p].desc) }))),
      this.statsEl,
    );
    this.loadoutEl = h('div', { class: 'arc-loadout hidden' },
      h('div', { class: 'arc-loadout-panel' },
        h('div', { class: 'arc-loadout-title', text: t('arc.cac.title') }),
        presets,
        this.customDesc,
        editor,
        h('div', { class: 'arc-card-desc', text: t('arc.cac.note') }),
        this.loadoutNote,
        h('button', { class: 'mc-btn w150', text: t('common.done'), onclick: () => this.onLoadoutClose?.() }),
      ),
    );
    this.renderCustom();
  }

  /** The custom class (from storage); the editor shows it. */
  setCustomClass(c: ClassSpec): void {
    this.custom = validateClass(c);
    this.renderCustom();
  }

  /**
   * Realms unlocks: items above the player's level are shown greyed out with the level they need and cannot be
   * picked; presets that use one are greyed out too. (The server enforces the same table.)
   */
  setRank(rank: Rank): void {
    this.rank = rank;
    for (const field of ['primary', 'secondary', 'optic', 'perk'] as const) {
      for (const [id, el] of this.pick[field]) {
        const open = isUnlocked(field, id, rank);
        el.classList.toggle('locked', !open);
        const em = el.querySelector('em');
        if (em) em.textContent = open ? el.dataset.tag ?? '' : t('arc.cac.locked', unlockLevel(field, id));
      }
    }
    for (const pr of LOADOUT_PRESETS) this.presetCards.get(pr.id)?.classList.toggle('locked', !classUnlocked(pr, rank));
  }

  private rank: Rank = { level: 1, prestige: 0 };
  /** Realms rank per player name, from the roster (kill feed icons). */
  private readonly ranks = new Map<string, number>();

  /** Rank icons for the kill feed follow the roster. */
  setRanks(roster: readonly RosterEntry[]): void {
    this.ranks.clear();
    for (const p of roster) if (p.rk) this.ranks.set(p.name, p.rk);
  }

  private editCustom(field: keyof typeof this.pick, id: string): void {
    if (!isUnlocked(field, id, this.rank)) return;
    const next = { ...this.custom, [field]: id };
    // A new primary keeps the optic only when it fits; else the weapon's default.
    if (field === 'primary' && !opticAllowed(weaponDef(id)!, next.optic)) next.optic = weaponDef(id)!.optics[0];
    if (field === 'optic' && !opticAllowed(weaponDef(next.primary)!, id)) return;
    this.custom = validateClass(next);
    this.renderCustom();
    this.onClass?.(this.custom, true);
  }

  private renderCustom(): void {
    const c = this.custom;
    const w = weaponDef(c.primary)!;
    for (const [id, el] of this.pick.primary) el.classList.toggle('selected', id === c.primary);
    for (const [id, el] of this.pick.secondary) el.classList.toggle('selected', id === c.secondary);
    for (const [id, el] of this.pick.perk) el.classList.toggle('selected', id === c.perk);
    for (const [id, el] of this.pick.optic) {
      el.classList.toggle('selected', id === c.optic);
      el.classList.toggle('disabled', !opticAllowed(w, id));
    }
    this.statsEl.replaceChildren(
      h('div', { class: 'arc-card-name', text: w.name }),
      ...statRows(w, c.optic, c.perk),
      h('div', { class: 'arc-card-desc role', text: t(`arc.role.${w.id}`, w.role) }),
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
    if (visible !== this.crosshairVisible) {
      this.crosshairVisible = visible;
      this.crosshair.classList.toggle('hidden', !visible);
    }
    const g = Math.round(gap * 2) / 2;
    if (g === this.lastGap) return;
    this.lastGap = g;
    this.crosshair.style.setProperty('--g', `${g}px`);
  }

  /** Scope overlay; `breath` 0..1 is the breath left for steadying (-1 hides the meter), `holding` while Shift steadies, `spent` while out of breath. */
  setScope(on: boolean, breath = -1, holding = false, spent = false): void {
    if (on !== this.scopeOn) {
      this.scopeOn = on;
      this.scope.classList.toggle('hidden', !on);
    }
    if (!on) return;
    const q = breath < 0 ? -1 : Math.round(breath * 50);
    const key = q * 4 + (holding ? 1 : 0) + (spent ? 2 : 0);
    if (key === this.lastBreath) return;
    this.lastBreath = key;
    this.scopeBreath.classList.toggle('hidden', q < 0);
    this.scopeHint.classList.toggle('hidden', q < 0 || holding);
    this.scopeHint.textContent = spent ? t('arc.scope.breath') : t('arc.scope.steady');
    this.scopeBreath.classList.toggle('spent', spent);
    if (q >= 0) this.scopeBreathFill.style.width = `${q * 2}%`;
  }

  /** Big medal text under the crosshair (multi-kill, killstreak) for a moment. */
  showMedal(text: string, color: string, now: number): void {
    this.medal.textContent = text;
    this.medal.style.color = color;
    this.medal.classList.remove('hidden', 'pop');
    void this.medal.offsetWidth; // restart the animation
    this.medal.classList.add('pop');
    this.medalUntil = now + 2.2;
  }

  /** Spawn protection: seconds left (0 hides it). */
  setProtection(left: number): void {
    const q = left <= 0 ? 0 : Math.ceil(left * 10);
    if (q === this.lastProtect) return;
    this.lastProtect = q;
    this.protect.classList.toggle('hidden', q === 0);
    if (q > 0) this.protect.textContent = t('arc.protection', (q / 10).toFixed(1));
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
    if (this.medalUntil > 0 && now >= this.medalUntil) {
      this.medalUntil = 0;
      this.medal.classList.add('hidden');
    }
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
      h('span', { style: `color:${teamColor(e.killerTeam)}` }, rankBadge(this.ranks.get(e.killer)), e.killer),
      h('span', { class: 'arc-feed-weapon', text: weaponTag(e.weapon) }),
      e.head ? h('span', { class: 'arc-feed-head', text: 'HS' }) : null,
      h('span', { style: `color:${teamColor(e.victimTeam)}` }, rankBadge(this.ranks.get(e.victim)), e.victim),
    )));
  }

  /** Timer, team scores (or your own score in free for all) and the phase line. Call when something changed. */
  setMatch(
    phase: MatchPhase, timeLeft: number,
    ctx: ScoreboardContext & { scoreLimit: number; selfKills: number; leader: string; text?: string; selfScore?: string },
  ): void {
    this.clock.textContent = phase === 'warmup' ? t('arc.warmup') : phase === 'intermission' || phase === 'countdown' ? t('arc.nextRound') : formatClock(timeLeft);
    this.rightScore.classList.toggle('hidden', !ctx.teams);
    if (ctx.teams) {
      this.leftScore.textContent = String(ctx.scores.red);
      this.leftScore.style.background = TEAM_COLORS.red;
      this.rightScore.textContent = String(ctx.scores.blue);
      this.rightScore.style.background = TEAM_COLORS.blue;
      this.subline.textContent = ctx.text || t('arc.firstTo', ctx.scoreLimit);
    } else {
      this.leftScore.textContent = ctx.selfScore ?? `${ctx.selfKills}/${ctx.scoreLimit}`;
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
    // The objective panels (gun game ladder) step aside while the scoreboard is up.
    this.el.classList.toggle('board-open', visible);
    if (visible) renderBoard(this.board, roster, ctx);
  }

  // ---------------------------------------------------------------- death, end, loadout

  /** Shows the elimination screen; `killer` is empty when unknown. Null hides it. */
  setDeath(info: { killer: string; weapon: string; head: boolean; killerTeam: Team | '' } | null): void {
    this.death.classList.toggle('hidden', info === null);
    if (info === null) this.setSpectating('', false);
    this.lastCount = -1;
    this.lastRespawnPending = '\0';
    if (!info) return;
    this.deathTitle.textContent = info.killer ? t('arc.death.by', info.killer) : t('arc.death.title');
    this.deathTitle.style.color = info.killerTeam ? TEAM_COLORS[info.killerTeam] : '#fff';
    this.deathDetail.textContent = info.killer ? `${weaponTag(info.weapon)}${info.head ? `  -  ${t('arc.headshot')}` : ''}` : '';
  }

  /**
   * Spectating after death: who the camera follows ('' = nobody, the death screen is shown in full)
   * and whether the mouse buttons cycle between several players. Only writes the DOM when something changed.
   */
  setSpectating(name: string, cycle: boolean): void {
    const key = name ? `${name}|${cycle}` : '';
    if (key === this.lastWatch) return;
    this.lastWatch = key;
    this.death.classList.toggle('watching', name !== '');
    this.deathWatch.classList.toggle('hidden', name === '');
    this.deathWatch.replaceChildren(h('div', { class: 'arc-watch-name', text: t('arc.spectating', name) }), h('div', { class: 'arc-death-hint', text: cycle ? t('arc.spectateHint') : '' }));
  }

  /**
   * Respawn countdown in whole seconds (negative = no respawn before the next round) and the class
   * choices (hidden when the mode chooses the weapons). `next` is the class of the next life.
   */
  setRespawn(seconds: number, next: ClassSpec | null, choice = true): void {
    const n = seconds < 0 ? -1 : Math.max(0, Math.ceil(seconds));
    // Per frame while dead: nothing to do (and nothing to allocate) unless the second or the class object changed.
    if (n === this.lastCount && next === this.lastRespawnClass && this.lastRespawnPending !== '\0') return;
    this.lastRespawnClass = next;
    const custom = !!next && sameClass(next, this.custom) && !presetFor(next);
    const key = next ? `${next.primary}|${next.optic}|${next.secondary}|${next.perk}|${custom}` : '';
    if (n === this.lastCount && key === this.lastRespawnPending) return;
    this.lastCount = n;
    this.lastRespawnPending = key;
    this.deathCount.textContent = n < 0 ? t('arc.death.round') : t('arc.death.respawn', n);
    if (!choice || !next) {
      this.deathLoadout.replaceChildren();
      return;
    }
    const cur = presetFor(next);
    const keys = LOADOUT_PRESETS.length + 1;
    this.deathLoadout.replaceChildren(h('div', { class: 'arc-death-hint', text: t('arc.death.nextClass', keys) }),
      h('div', { class: 'arc-death-weapons' },
        ...LOADOUT_PRESETS.map((pr, i) => h('span', { class: pr === cur ? 'sel' : '', text: `${i + 1} ${pr.name}` })),
        h('span', { class: custom ? 'sel' : '', text: `${keys} ${t('arc.custom')}` })),
      h('div', { class: 'arc-death-hint', text: `${classLine(next)} · ${perkName(next.perk)}` }));
  }

  setMatchEnd(info: { title: string; color: string; roster: readonly RosterEntry[]; ctx: ScoreboardContext } | null): void {
    this.end.classList.toggle('hidden', info === null);
    // A full-screen result: the score bar, kill feed and panels under it showed through its title and the map vote.
    this.el.classList.toggle('end-open', info !== null);
    this.lastEndCount = -1;
    if (!info) return;
    this.setProtection(0); // nothing of the round shows through the end screen
    this.medal.classList.add('hidden');
    this.endTitle.textContent = info.title;
    this.endTitle.style.color = info.color;
    renderBoard(this.endBoard, info.roster, info.ctx);
  }

  setNextMatch(seconds: number): void {
    const n = Math.max(0, Math.ceil(seconds));
    if (n === this.lastEndCount) return;
    this.lastEndCount = n;
    this.endCount.textContent = t('lobby.nextMatch', n);
  }

  /** Opens Create-a-Class with `selected` (the class of the next life) highlighted. */
  showLoadout(selected: ClassSpec, nextLife: boolean): void {
    this.loadoutEl.classList.remove('hidden');
    // A full-screen menu: the match HUD under it (score bar, banners, lobby panel, markers) would show through the title.
    this.el.classList.add('class-open');
    this.markClass(selected);
    this.loadoutNote.textContent = nextLife ? t('arc.cac.applyNow') : t('arc.cac.applyRespawn');
  }

  /** Highlights the chosen class: its preset card, or the custom card. */
  markClass(selected: ClassSpec): void {
    const cur = presetFor(selected);
    for (const [id, card] of this.presetCards) card.classList.toggle('selected', id === cur?.id);
    this.customCard.classList.toggle('selected', !cur && sameClass(selected, this.custom));
    const label = cur ? cur.name : sameClass(selected, this.custom) ? t('arc.custom') : t('arc.class');
    this.customDesc.textContent = `${label}: ${classLine(selected)} · ${perkName(selected.perk)}`;
  }

  hideLoadout(): void {
    this.loadoutEl.classList.add('hidden');
    this.el.classList.remove('class-open');
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
    this.crosshairVisible = true;
    this.scopeOn = false;
    this.lastMag = -1;
    this.lastAmmoDef = null;
    this.lastRespawnPending = '';
    this.lastSlots = '';
  }
}

/** "Assault Rifle (Red Dot) + Pistol". */
function classLine(c: ClassSpec): string {
  const optic = c.optic === 'iron' ? '' : ` (${OPTICS[c.optic].name})`;
  return `${weaponDef(c.primary)!.name}${optic} + ${weaponDef(c.secondary)!.name}`;
}

function statRows(def: WeaponDef, optic: OpticId = 'iron', perk: PerkId = 'none'): HTMLElement[] {
  const bar = (label: string, frac: number, value: string) => h('div', { class: 'arc-stat' },
    h('span', { text: `${label}  ${value}` }), h('div', { class: 'arc-stat-bar' }, h('i', { style: `width:${Math.round(Math.min(1, Math.max(0.05, frac)) * 100)}%` })));
  const mag = perk === 'extmag' ? Math.round(def.magazine * 1.4) : def.magazine;
  return [
    bar(t('arc.stat.damage'), (def.damage * def.pellets * 0.6) / 100, String(def.damage * def.pellets)),
    bar(t('arc.stat.fireRate'), def.rpm / 1000, `${def.rpm}`),
    bar(t('arc.stat.range'), def.range / 100, `${Math.round(def.range * (perk === 'suppressor' ? 0.8 : 1))}`),
    bar(t('arc.stat.magazine'), mag / 75, String(mag)),
    bar(t('arc.stat.mobility'), (def.moveSpeed - 0.8) / 0.3, `${Math.round(def.moveSpeed * 100)}%`),
    bar(t('arc.stat.aimSpeed'), (0.5 - def.adsTime) / 0.4, `${def.adsTime.toFixed(2)}s`),
    h('div', { class: 'arc-card-desc', text: `${fireMode(def).toUpperCase()} · zoom ${(1 / opticZoom(def, optic)).toFixed(1)}x` }),
  ];
}

/** Scoreboard table: rank, name (team colour), kills, deaths, K/D and ping; yours is highlighted. */
function renderBoard(host: HTMLElement, roster: readonly RosterEntry[], ctx: ScoreboardContext): void {
  const rows: HTMLElement[] = [];
  const cols = ctx.scoreColumn ? ' pts' : '';
  const header = h('div', { class: `arc-row head${cols}` },
    h('span', { class: 'rank', text: '#' }), h('span', { class: 'name', text: t('arc.board.player') }),
    ctx.scoreColumn ? h('span', { text: scoreColumnLabel(ctx.scoreColumn) }) : null,
    h('span', { text: t('arc.board.kills') }), h('span', { text: t('arc.board.deaths') }), h('span', { text: 'K/D' }), h('span', { text: 'Ping' }));
  rows.push(header);
  sortRoster(roster).forEach((p, i) => {
    rows.push(h('div', { class: `arc-row${cols}${p.id === ctx.selfId ? ' self' : ''}` },
      h('span', { class: 'rank', text: String(i + 1) }),
      h('span', { class: 'name', style: `color:${teamColor(p.team)}` }, rankBadge(p.rk), p.name),
      ctx.scoreColumn ? h('span', { text: String(ctx.scoreColumn === 'Level' ? (p.pts ?? 0) + 1 : p.pts ?? 0) }) : null,
      h('span', { text: String(p.kills) }), h('span', { text: String(p.deaths) }),
      h('span', { text: kdRatio(p.kills, p.deaths) }), h('span', { text: p.ping > 0 ? String(Math.round(p.ping)) : '-' })));
  });
  const children: HTMLElement[] = [];
  if (ctx.teams) {
    children.push(h('div', { class: 'arc-board-scores' },
      h('span', { style: `color:${TEAM_COLORS.red}`, text: `${t('arc.board.red')} ${ctx.scores.red}` }),
      h('span', { class: 'sep', text: ' - ' }),
      h('span', { style: `color:${TEAM_COLORS.blue}`, text: `${ctx.scores.blue} ${t('arc.board.blue')}` })));
  }
  children.push(...rows);
  host.replaceChildren(...children);
}
