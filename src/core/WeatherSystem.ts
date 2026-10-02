import type { EntityManager } from '../entities/EntityManager';
import type { GameMode } from '../player/GameMode';
import { hasSurvivalRules } from '../player/GameMode';
import type { Player } from '../player/Player';
import type { PlayerStats } from '../player/PlayerStats';
import type { DayCycle } from '../rendering/DayCycle';
import type { WorldMeta } from '../save/SaveSystem';
import type { ServerMessage } from '../net/protocol';
import type { World } from '../world/World';
import {
  LIGHTNING_DAMAGE, LIGHTNING_FIRE_TICKS, LIGHTNING_RANGE, WEATHER_USAGE, Weather, type WeatherWorld, parseWeatherCommand,
} from '../world/Weather';
import type { Renderer } from './Renderer';
import type { AudioEngine } from './Audio';

/** The audio developer adds `setWeather(rain, thunder)` (rain loop, thunder volume); call it only if it exists. */
type WeatherAudio = { setWeather?: (rain: number, thunder: number) => void };

/** What the weather needs from the game; filled in by Game so this file stays out of its way. */
export interface WeatherHost {
  readonly cycle: DayCycle;
  readonly renderer: Renderer;
  readonly audio: AudioEngine;
  readonly player: Player;
  readonly stats: PlayerStats;
  world(): World | null;
  mode(): GameMode;
  entities(): EntityManager | null;
  /** Connected to a server: it owns the weather and the strikes. */
  multiplayer(): boolean;
  /** Arcade games always have clear weather. */
  arcade(): boolean;
  /** The player was hit by a bolt (camera shake / hurt side come from the stats). */
  onStruck?(): void;
}

/**
 * Weather on the client: simulates it in singleplayer, follows the server in multiplayer, and
 * turns it into sky, fog, rain, lightning, damage and sound. The state machine itself lives in
 * `world/Weather.ts`; this class is the glue.
 */
export class WeatherSystem {
  weather = new Weather();
  /** Hook for the future fire-spread developer: a bolt hit this block (only called in singleplayer / by the strike). */
  onLightningFire: ((x: number, y: number, z: number) => void) | null = null;
  private world: World | null = null;
  private readonly query: WeatherWorld = {
    getBlock: (x, y, z) => this.world!.getBlock(x, y, z),
    biomeAt: (x, z) => this.world!.biomeName(x, z),
  };
  private readonly roll = { dx: 0, dz: 0 };
  private lastRain = -1;
  private lastThunder = -1;

  constructor(private readonly host: WeatherHost) {}

  /** The world query used by `isRainingAt` & co. (valid while a world is loaded). */
  get worldQuery(): WeatherWorld | null {
    this.world = this.host.world();
    return this.world ? this.query : null;
  }

  // ---------------------------------------------------------------- state

  /** New session: singleplayer restores from the save, multiplayer waits for the server's messages. */
  start(meta: WorldMeta, multiplayer: boolean): void {
    this.weather = new Weather();
    this.host.cycle.day = Math.max(0, Math.floor(meta.day ?? 0)) || 0;
    if (multiplayer) {
      this.weather.applyRemote(0, 0, true);
    } else if (meta.worldType !== 'arena') {
      this.weather.restore(meta.weather);
    } else {
      this.weather.rainTime = this.weather.thunderTime = 0;
    }
    this.lastRain = this.lastThunder = -1;
    this.apply();
  }

  /** Back to the menu: the sky is clear there. */
  stop(): void {
    this.weather = new Weather();
    this.host.cycle.rain = this.host.cycle.thunder = 0;
    (this.host.audio as WeatherAudio).setWeather?.(0, 0);
  }

  save(meta: WorldMeta): void {
    meta.day = this.host.cycle.day;
    meta.weather = this.weather.serialize();
  }

  /** Per frame (while the game runs): fades the levels and updates the sky inputs. */
  update(dt: number): void {
    if (this.host.arcade()) {
      this.weather.rainLevel = this.weather.thunderLevel = 0;
    } else this.weather.advance(dt);
    this.apply();
  }

  /** Writes the levels into the day cycle and the audio engine. */
  apply(): void {
    const w = this.weather;
    const cycle = this.host.cycle;
    cycle.rain = w.rain;
    cycle.thunder = w.thunder;
    if (Math.abs(w.rain - this.lastRain) > 0.004 || Math.abs(w.thunder - this.lastThunder) > 0.004) {
      this.lastRain = w.rain;
      this.lastThunder = w.thunder;
      (this.host.audio as WeatherAudio).setWeather?.(w.rain, w.thunder);
    }
  }

  // ---------------------------------------------------------------- 20 Hz tick

  /** Game tick: rain puts out a burning player; in singleplayer lightning strikes near the player. */
  gameTick(): void {
    const world = this.worldQuery;
    if (!world || this.host.arcade()) return;
    const p = this.host.player, stats = this.host.stats;
    if (stats.burnTicks > 0 && this.weather.isRainingAt(world, p.x, p.y + 1.8, p.z)) stats.burnTicks = 0;
    if (this.host.multiplayer()) return;
    if (this.weather.rollLightning(this.roll)) {
      const x = Math.floor(p.x + this.roll.dx), z = Math.floor(p.z + this.roll.dz);
      const y = this.host.world()!.surfaceY(x, z);
      if (y >= 0) this.strike(x + 0.5, y + 1, z + 0.5);
    }
  }

  // ---------------------------------------------------------------- lightning

  /**
   * One strike: bolt, flash, delayed thunder and, within 3 blocks, 5 damage plus fire for the player and
   * (singleplayer only; the server handles mobs in multiplayer) the mobs.
   */
  strike(x: number, y: number, z: number): void {
    const h = this.host;
    h.renderer.lightning.strike(x, y, z);
    const dist = Math.hypot(x - h.player.x, y - h.player.y, z - h.player.z);
    // The sound arrives a moment after the light.
    const delay = Math.min(1800, dist * 8);
    const volume = Math.max(0.12, 1 - dist / 140);
    window.setTimeout(() => h.audio.playThunderRumble(volume), delay);

    const p = h.player;
    const range = LIGHTNING_RANGE;
    if (Math.hypot(p.x - x, p.z - z) <= range && p.y >= y - 2 && p.y <= y + 3 && hasSurvivalRules(h.mode())) {
      if (h.stats.damage(LIGHTNING_DAMAGE, 'lightning', h.mode())) {
        h.stats.burnTicks = LIGHTNING_FIRE_TICKS;
        h.onStruck?.();
      }
    }
    if (!h.multiplayer()) {
      for (const m of h.entities()?.mobs ?? []) {
        if (m.removed || m.dead) continue;
        if (Math.hypot(m.x - x, m.z - z) <= range && Math.abs(m.y - y) < 4) {
          m.hurt(LIGHTNING_DAMAGE, x, z, 0.3);
          m.burning = Math.max(m.burning, LIGHTNING_FIRE_TICKS);
        }
      }
    }
    this.onLightningFire?.(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  // ---------------------------------------------------------------- multiplayer and chat

  /** Handles the server's weather messages; returns true if it was one. */
  onServerMessage(msg: ServerMessage): boolean {
    if (msg.t === 'weather') {
      this.weather.applyRemote(msg.rain, msg.thunder, msg.snap === true, msg.ticksToChange);
      return true;
    }
    if (msg.t === 'bolt') {
      if ([msg.x, msg.y, msg.z].every(Number.isFinite)) this.strike(msg.x, msg.y, msg.z);
      return true;
    }
    return false;
  }

  /**
   * Singleplayer slash commands (the server handles them in multiplayer). Returns the lines to show,
   * or null if this is not a command it knows.
   */
  localCommand(text: string): string[] | null {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'help':
        return ['Commands: /weather clear|rain|thunder [seconds], /help'];
      case 'weather': {
        if (this.host.arcade()) return ['The weather is fixed in this game type'];
        const parsed = parseWeatherCommand(args);
        if (!parsed) return [WEATHER_USAGE];
        this.weather.set(parsed.kind, parsed.ticks);
        return [`Set the weather to ${parsed.kind}`];
      }
      default:
        return null;
    }
  }

  /** F3 line. */
  debugLine(): string {
    const w = this.weather;
    const secs = Math.round(w.ticksToChange / 20);
    return `Weather: ${w.kind} (rain ${w.rain.toFixed(2)}, thunder ${w.thunder.toFixed(2)})${w.remote ? '' : ` · change in ${secs} s`}`;
  }
}
