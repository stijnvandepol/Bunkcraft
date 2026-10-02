import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_MODEL } from './BlockRegistry';
import { BIOME } from './Biomes';
import { CHUNK_HEIGHT } from './constants';

/**
 * Weather state machine (DOM-free: the browser, the Node server and the tests share it).
 *
 * Follows Minecraft's cycle: two independent timers toggle the rain and thunder flags.
 * Rain stays on 12 000–24 000 ticks and off 12 000–180 000; thunder stays on 3 600–15 600
 * and off 12 000–180 000, but only has an effect while it rains. The visible levels fade
 * by 0.01 per tick (5 s). 20 ticks = 1 s.
 */
export const WEATHER_TPS = 20;
export const CLEAR_TICKS: [number, number] = [12000, 180000];
export const RAIN_TICKS: [number, number] = [12000, 24000];
export const THUNDER_TICKS: [number, number] = [3600, 15600];
const FADE_PER_TICK = 0.01;
/** Most ticks one advance() call simulates (a long frame stall must not run for minutes). */
const MAX_CATCH_UP = 100;

/** Average of one lightning strike per player per 30 s of thunderstorm. */
export const LIGHTNING_CHANCE_PER_TICK = 1 / 600;
export const LIGHTNING_MIN_DISTANCE = 12;
export const LIGHTNING_MAX_DISTANCE = 64;
export const LIGHTNING_DAMAGE = 5;
export const LIGHTNING_RANGE = 3;
export const LIGHTNING_FIRE_TICKS = 160;

export type WeatherKind = 'clear' | 'rain' | 'thunder';
export type RandomFn = () => number;

/** What is saved (world.json, singleplayer WorldMeta). Levels are derived from the flags on load. */
export interface WeatherState {
  raining: boolean;
  thundering: boolean;
  clearTime: number;
  rainTime: number;
  thunderTime: number;
}

/** What `/weather` and the `weather` message talk about. */
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'rain', 'thunder'];

export function parseWeatherKind(s: string | undefined): WeatherKind | null {
  const k = (s ?? '').toLowerCase();
  return k === 'clear' || k === 'rain' || k === 'thunder' ? k : null;
}

export const WEATHER_USAGE = 'Usage: /weather clear|rain|thunder [seconds]';

/** Parses the arguments of `/weather <kind> [seconds]`; the duration comes back in ticks. Null = bad usage. */
export function parseWeatherCommand(args: string[]): { kind: WeatherKind; ticks?: number } | null {
  const kind = parseWeatherKind(args[0]);
  if (!kind) return null;
  if (args.length < 2) return { kind };
  if (!/^\d{1,7}$/.test(args[1])) return null;
  const seconds = Number(args[1]);
  return seconds > 0 ? { kind, ticks: seconds * WEATHER_TPS } : null;
}

export class Weather {
  raining = false;
  thundering = false;
  /** Ticks of forced clear weather left (after `/weather clear`). */
  clearTime = 0;
  rainTime = 0;
  thunderTime = 0;
  /** 0..1, fades in and out. */
  rainLevel = 0;
  thunderLevel = 0;
  /** Bumped whenever a flag flips or a command changes the weather; the server broadcasts on change. */
  version = 0;
  /** Multiplayer clients follow the server: no timers, only fading. */
  remote = false;
  private acc = 0;

  constructor(private readonly rng: RandomFn = Math.random) {
    this.rainTime = this.randRange(CLEAR_TICKS);
    this.thunderTime = this.randRange(CLEAR_TICKS);
  }

  private randRange([lo, hi]: [number, number]): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  /** Rain strength 0..1 as the renderer sees it. */
  get rain(): number { return this.rainLevel; }
  /** Thunder only counts while it rains (Minecraft: thunderLevel × rainLevel). */
  get thunder(): number { return this.thunderLevel * this.rainLevel; }

  /** How many sky light levels the weather takes away (mob spawning treats this as extra darkness). */
  get skyDarkness(): number { return this.rainLevel * 3 + this.thunder * 2; }

  get kind(): WeatherKind {
    return this.raining && this.thundering ? 'thunder' : this.raining ? 'rain' : 'clear';
  }

  /** Ticks until the next change of the flags, for display and the `weather` message. */
  get ticksToChange(): number {
    return this.clearTime > 0 ? this.clearTime : Math.max(0, this.rainTime);
  }

  /** Runs the simulation for `dt` seconds (20 Hz internally); returns the number of ticks run. */
  advance(dt: number): number {
    this.acc += Math.max(0, dt) * WEATHER_TPS;
    let n = 0;
    while (this.acc >= 1 && n < MAX_CATCH_UP) {
      this.acc -= 1;
      this.tick();
      n++;
    }
    if (this.acc > MAX_CATCH_UP) this.acc = 0;
    return n;
  }

  /** One game tick. */
  tick(): void {
    if (!this.remote) this.advanceTimers();
    this.rainLevel = clamp01(this.rainLevel + (this.raining ? FADE_PER_TICK : -FADE_PER_TICK));
    this.thunderLevel = clamp01(this.thunderLevel + (this.thundering ? FADE_PER_TICK : -FADE_PER_TICK));
  }

  private advanceTimers(): void {
    if (this.clearTime > 0) {
      this.clearTime--;
      this.thunderTime = 0;
      this.rainTime = 0;
      if (this.thundering || this.raining) this.version++;
      this.thundering = false;
      this.raining = false;
      return;
    }
    if (this.thunderTime > 0) {
      if (--this.thunderTime === 0) { this.thundering = !this.thundering; this.version++; }
    } else this.thunderTime = this.randRange(this.thundering ? THUNDER_TICKS : CLEAR_TICKS);
    if (this.rainTime > 0) {
      if (--this.rainTime === 0) { this.raining = !this.raining; this.version++; }
    } else this.rainTime = this.randRange(this.raining ? RAIN_TICKS : CLEAR_TICKS);
  }

  /**
   * `/weather clear|rain|thunder [ticks]`. Without a duration a random one from Minecraft's
   * range is used. The level fades over the next 5 s; use `snap()` to skip the fade.
   */
  set(kind: WeatherKind, ticks?: number): void {
    const dur = ticks !== undefined && Number.isFinite(ticks) && ticks > 0 ? Math.floor(ticks) : undefined;
    this.version++;
    if (kind === 'clear') {
      this.clearTime = dur ?? this.randRange(CLEAR_TICKS);
      this.rainTime = 0;
      this.thunderTime = 0;
      this.raining = false;
      this.thundering = false;
      return;
    }
    this.clearTime = 0;
    this.raining = true;
    this.thundering = kind === 'thunder';
    if (kind === 'rain') {
      this.rainTime = dur ?? this.randRange(RAIN_TICKS);
      this.thunderTime = this.rainTime;
    } else {
      this.rainTime = dur ?? this.randRange(THUNDER_TICKS);
      this.thunderTime = this.rainTime;
    }
  }

  /** Jump the fade to the current flags (world load, join). */
  snap(): void {
    this.rainLevel = this.raining ? 1 : 0;
    this.thunderLevel = this.thundering ? 1 : 0;
  }

  /** Multiplayer client: follow the server's targets (0..1, values above 0.5 mean on). */
  applyRemote(rain: number, thunder: number, snap = false, ticksToChange?: number): void {
    this.remote = true;
    this.raining = rain > 0.5;
    this.thundering = thunder > 0.5;
    if (ticksToChange !== undefined) { this.rainTime = ticksToChange; this.thunderTime = ticksToChange; }
    this.version++;
    if (snap) this.snap();
  }

  serialize(): WeatherState {
    return {
      raining: this.raining, thundering: this.thundering,
      clearTime: this.clearTime, rainTime: this.rainTime, thunderTime: this.thunderTime,
    };
  }

  /** Accepts anything (old or hand-edited saves): invalid values fall back to a fresh clear cycle. */
  restore(s: Partial<WeatherState> | null | undefined): void {
    if (!s || typeof s !== 'object') return;
    const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
    this.raining = s.raining === true;
    this.thundering = s.thundering === true;
    this.clearTime = num(s.clearTime, 1e7);
    this.rainTime = num(s.rainTime, 1e7) || this.randRange(this.raining ? RAIN_TICKS : CLEAR_TICKS);
    this.thunderTime = num(s.thunderTime, 1e7) || this.randRange(this.thundering ? THUNDER_TICKS : CLEAR_TICKS);
    this.version++;
    this.snap();
  }

  /**
   * Thunderstorm lightning roll for one player and one tick. On a strike it returns true and
   * fills `out` with the horizontal offset in blocks. Cheap: no random numbers unless it storms.
   */
  rollLightning(out: { dx: number; dz: number }): boolean {
    if (this.thunder < 0.9 || this.rng() >= LIGHTNING_CHANCE_PER_TICK) return false;
    const a = this.rng() * Math.PI * 2;
    const r = LIGHTNING_MIN_DISTANCE + this.rng() * (LIGHTNING_MAX_DISTANCE - LIGHTNING_MIN_DISTANCE);
    out.dx = Math.cos(a) * r;
    out.dz = Math.sin(a) * r;
    return true;
  }

  /** Precipitation falling on a point, if any: the biome decides, the sky must be open above. */
  precipitationAt(world: WeatherWorld, x: number, y: number, z: number): Precip {
    if (this.rainLevel < 0.2) return Precip.NONE;
    if (!isExposed(world, x, y, z)) return Precip.NONE;
    return precipitationFor(world.biomeAt(x, z), y);
  }

  /** True when rain (not snow) is falling on this point right now. Farmland, fire and burning use this. */
  isRainingAt(world: WeatherWorld, x: number, y: number, z: number): boolean {
    return this.precipitationAt(world, x, y, z) === Precip.RAIN;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- precipitation rules

export const Precip = { NONE: 0, RAIN: 1, SNOW: 2 } as const;
export type Precip = typeof Precip[keyof typeof Precip];

/** The few block/biome queries the rules need; the client World and the server world both fit. */
export interface WeatherWorld {
  getBlock(x: number, y: number, z: number): number;
  biomeAt(x: number, z: number): number;
}

/** Above this height it snows in every biome that is not a desert; mountains already from SNOW_LINE_MOUNTAINS. */
export const SNOW_LINE = 106;
export const SNOW_LINE_MOUNTAINS = 94;

/** Precipitation by biome id (not listed = rain). Deserts get none, snowy biomes snow. */
const BIOME_PRECIP: Record<number, Precip> = {
  [BIOME.DESERT]: Precip.NONE,
  [BIOME.SNOWY]: Precip.SNOW,
};

export function precipitationFor(biome: number, y: number): Precip {
  const base = BIOME_PRECIP[biome] ?? Precip.RAIN;
  if (base === Precip.NONE) return Precip.NONE;
  if (base === Precip.SNOW) return Precip.SNOW;
  if (y >= (biome === BIOME.MOUNTAINS ? SNOW_LINE_MOUNTAINS : SNOW_LINE)) return Precip.SNOW;
  return Precip.RAIN;
}

/** Does this block stop rain? Everything solid or liquid does (leaves and glass too); plants, torches and air do not. */
export function blocksPrecipitation(id: number): boolean {
  if (id === BLOCK.AIR || id === BLOCK.UNLOADED) return false;
  const s = SHAPE[id];
  return s !== SHAPE_CROSS && s !== SHAPE_MODEL;
}

/** Sky open above (x, y, z)? Starts at the block above `y`. */
export function isExposed(world: WeatherWorld, x: number, y: number, z: number): boolean {
  const fx = Math.floor(x), fz = Math.floor(z);
  for (let yy = Math.floor(y) + 1; yy < CHUNK_HEIGHT; yy++) {
    if (blocksPrecipitation(world.getBlock(fx, yy, fz))) return false;
  }
  return true;
}
