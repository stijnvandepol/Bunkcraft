/**
 * Status effects (DOM-free). Amplifier 0 is level I; durations are in game ticks (20 per second).
 * Ticking rules follow the Minecraft Wiki ("Effect"):
 *   Regeneration heals 1 every `50 >> amp` ticks, Poison hurts 1 every `25 >> amp` ticks (never below half a heart),
 *   Wither hurts 1 every `40 >> amp` ticks, Hunger adds 0.005 × level exhaustion per tick, Saturation restores `level`
 *   hunger and saturation per tick, Instant Health heals `4 << amp`, Instant Damage deals `6 << amp`,
 *   Absorption gives `4 × level` extra health until it ends.
 * The effects live with the player (PlayerStats); they are client-authoritative like health and hunger.
 */
export const EFFECT_IDS = [
  'speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'weakness', 'instant_health', 'instant_damage', 'jump_boost',
  'regeneration', 'resistance', 'fire_resistance', 'water_breathing', 'invisibility', 'night_vision', 'hunger', 'poison',
  'wither', 'absorption', 'saturation', 'levitation',
] as const;
export type EffectId = typeof EFFECT_IDS[number];

export interface EffectDef {
  name: string;
  harmful: boolean;
  /** Potion colour (0xRRGGBB), also the base colour of the HUD icon. */
  color: number;
  instant?: boolean;
}

export const EFFECT_DEFS: Record<EffectId, EffectDef> = {
  speed: { name: 'Speed', harmful: false, color: 0x7cafc6 },
  slowness: { name: 'Slowness', harmful: true, color: 0x5a6c81 },
  haste: { name: 'Haste', harmful: false, color: 0xd9c043 },
  mining_fatigue: { name: 'Mining Fatigue', harmful: true, color: 0x4a4217 },
  strength: { name: 'Strength', harmful: false, color: 0x932423 },
  weakness: { name: 'Weakness', harmful: true, color: 0x484d48 },
  instant_health: { name: 'Instant Health', harmful: false, color: 0xf82423, instant: true },
  instant_damage: { name: 'Instant Damage', harmful: true, color: 0xa9656a, instant: true },
  jump_boost: { name: 'Jump Boost', harmful: false, color: 0x22ff4c },
  regeneration: { name: 'Regeneration', harmful: false, color: 0xcd5cab },
  resistance: { name: 'Resistance', harmful: false, color: 0x99453a },
  fire_resistance: { name: 'Fire Resistance', harmful: false, color: 0xe49a3a },
  water_breathing: { name: 'Water Breathing', harmful: false, color: 0x2e5299 },
  invisibility: { name: 'Invisibility', harmful: false, color: 0x7f8392 },
  night_vision: { name: 'Night Vision', harmful: false, color: 0x1f1fa1 },
  hunger: { name: 'Hunger', harmful: true, color: 0x587653 },
  poison: { name: 'Poison', harmful: true, color: 0x87a363 },
  wither: { name: 'Wither', harmful: true, color: 0x352a27 },
  absorption: { name: 'Absorption', harmful: false, color: 0x2552a5 },
  saturation: { name: 'Saturation', harmful: false, color: 0xf82421 },
  levitation: { name: 'Levitation', harmful: true, color: 0xceffff },
};

export function isEffectId(s: string): s is EffectId {
  return (EFFECT_IDS as readonly string[]).includes(s);
}

/** "mining_fatigue", "Mining Fatigue" and "miningfatigue" all find Mining Fatigue; `minecraft:` is ignored. */
export function findEffect(raw: string): EffectId | null {
  const k = raw.toLowerCase().replace(/^minecraft:/, '').replace(/[\s_-]+/g, '');
  return EFFECT_IDS.find((id) => id.replace(/_/g, '') === k) ?? null;
}

/** Roman numeral for the HUD and chat (level 1 shows nothing in Minecraft's HUD, but chat names it). */
export function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of t) while (n >= v) { out += s; n -= v; }
  return out;
}

/** "1:30", the way Minecraft shows a timer. */
export function formatDuration(ticks: number): string {
  if (ticks >= 20 * 3600) return '**:**';
  const s = Math.ceil(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface ActiveEffect {
  id: EffectId;
  amp: number;
  /** Ticks left. */
  duration: number;
}

/** What effects act on; PlayerStats implements it. */
export interface EffectHost {
  health: number;
  maxHealth: number;
  /** Extra health from Absorption (set by the effect itself). */
  absorption: number;
  heal(amount: number): void;
  /** Damage over time or instant damage; true when it hurt. `canKill` false stops at half a heart. */
  effectDamage(amount: number, kind: 'poison' | 'wither' | 'magic', canKill: boolean): void;
  addExhaustion(v: number): void;
  eat(hunger: number, saturation: number): void;
}

/** Maximum duration the commands accept: 1 000 000 s is more than enough, and keeps the numbers sane. */
export const MAX_EFFECT_TICKS = 20 * 1_000_000;

const MINING_FATIGUE = [0.3, 0.09, 0.0027, 0.00081];

export class EffectSet {
  private readonly active = new Map<EffectId, ActiveEffect>();
  /** Bumped on every change, so the HUD redraws only when needed. */
  version = 0;

  get size(): number {
    return this.active.size;
  }

  /** In HUD order (beneficial first, then by name), stable. */
  list(): ActiveEffect[] {
    return [...this.active.values()].sort((a, b) => EFFECT_IDS.indexOf(a.id) - EFFECT_IDS.indexOf(b.id));
  }

  has(id: EffectId): boolean {
    return this.active.has(id);
  }

  /** Level (amplifier + 1), 0 when the effect is not active. */
  level(id: EffectId): number {
    const e = this.active.get(id);
    return e ? e.amp + 1 : 0;
  }

  get(id: EffectId): ActiveEffect | undefined {
    return this.active.get(id);
  }

  /**
   * Gives an effect. A stronger effect replaces a weaker one, an equal one is refreshed when it lasts longer, and a
   * weaker or shorter one is ignored (Minecraft keeps the stronger). Instant effects act at once through `host`.
   * Returns true when something changed.
   */
  add(id: EffectId, amp: number, duration: number, host?: EffectHost): boolean {
    amp = Math.max(0, Math.min(255, Math.floor(amp)));
    const def = EFFECT_DEFS[id];
    if (def.instant) {
      if (!host) return false;
      if (id === 'instant_health') host.heal(4 * 2 ** Math.min(amp, 10));
      else host.effectDamage(6 * 2 ** Math.min(amp, 10), 'magic', true);
      return true;
    }
    duration = Math.max(1, Math.min(MAX_EFFECT_TICKS, Math.floor(duration)));
    const cur = this.active.get(id);
    if (cur && (cur.amp > amp || (cur.amp === amp && cur.duration >= duration))) return false;
    this.active.set(id, { id, amp, duration });
    if (id === 'absorption' && host) host.absorption = Math.max(host.absorption, 4 * (amp + 1));
    this.version++;
    return true;
  }

  remove(id: EffectId, host?: EffectHost): boolean {
    if (!this.active.delete(id)) return false;
    if (id === 'absorption' && host) host.absorption = 0;
    this.version++;
    return true;
  }

  clear(host?: EffectHost): void {
    if (this.active.size === 0) return;
    if (host && this.active.has('absorption')) host.absorption = 0;
    this.active.clear();
    this.version++;
  }

  /** One game tick: applies the periodic effects, counts down and ends the ones that ran out. */
  tick(host: EffectHost): void {
    if (this.active.size === 0) return;
    for (const e of [...this.active.values()]) {
      const lvl = e.amp + 1;
      switch (e.id) {
        case 'regeneration': {
          const every = Math.max(1, 50 >> e.amp);
          if (e.duration % every === 0 && host.health < host.maxHealth) host.heal(1);
          break;
        }
        case 'poison': {
          const every = Math.max(1, 25 >> e.amp);
          if (e.duration % every === 0) host.effectDamage(1, 'poison', false);
          break;
        }
        case 'wither': {
          const every = Math.max(1, 40 >> e.amp);
          if (e.duration % every === 0) host.effectDamage(1, 'wither', true);
          break;
        }
        case 'hunger': host.addExhaustion(0.005 * lvl); break;
        case 'saturation': host.eat(lvl, lvl); break;
        default: break;
      }
      if (--e.duration <= 0) {
        this.active.delete(e.id);
        if (e.id === 'absorption') host.absorption = 0;
        this.version++;
      }
    }
  }

  // ---------------------------------------------------------------- queries for movement, mining, combat

  /** Walking speed factor: Speed +20 % per level, Slowness −15 % per level (never below 0). */
  speedMultiplier(): number {
    return Math.max(0, (1 + 0.2 * this.level('speed')) * (1 - 0.15 * this.level('slowness')));
  }

  /** Mining speed factor: Haste +20 % per level, Mining Fatigue ×0.3, 0.09, 0.0027, 0.00081. */
  miningMultiplier(): number {
    let m = 1 + 0.2 * this.level('haste');
    const f = this.level('mining_fatigue');
    if (f > 0) m *= MINING_FATIGUE[Math.min(f, 4) - 1];
    return m;
  }

  /** Extra melee damage: Strength +3 per level, Weakness −4 per level. */
  attackBonus(): number {
    return 3 * this.level('strength') - 4 * this.level('weakness');
  }

  /** Damage taken is reduced by 20 % per Resistance level, up to full immunity at level 5. */
  resistanceFactor(): number {
    return Math.max(0, 1 - 0.2 * this.level('resistance'));
  }

  /** Jump Boost levels (also take that many blocks off a fall). */
  jumpBoost(): number {
    return this.level('jump_boost');
  }

  get fireImmune(): boolean { return this.active.has('fire_resistance'); }
  get waterBreathing(): boolean { return this.active.has('water_breathing'); }
  get nightVision(): boolean { return this.active.has('night_vision'); }
  get invisible(): boolean { return this.active.has('invisibility'); }

  // ---------------------------------------------------------------- saving

  /** [index in EFFECT_IDS, amplifier, ticks left] per effect; undefined when there are none. */
  serialize(): number[][] | undefined {
    if (this.active.size === 0) return undefined;
    return this.list().map((e) => [EFFECT_IDS.indexOf(e.id), e.amp, e.duration]);
  }

  /** Loads saved effects; bad entries are skipped. */
  load(data: unknown, host?: EffectHost): void {
    this.clear(host);
    if (!Array.isArray(data)) return;
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [i, amp, dur] = row as number[];
      const id = EFFECT_IDS[i];
      if (id && Number.isFinite(amp) && Number.isFinite(dur) && dur > 0) this.add(id, amp, dur, host);
    }
  }
}

/** Effects some foods give (golden apple: Regeneration II for 5 s and Absorption I for 2 minutes), by item name. */
export const FOOD_EFFECTS: Record<string, { id: EffectId; amp: number; ticks: number }[]> = {
  golden_apple: [
    { id: 'regeneration', amp: 1, ticks: 100 },
    { id: 'absorption', amp: 0, ticks: 2400 },
  ],
};
