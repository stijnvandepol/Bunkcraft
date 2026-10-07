import type { EntityManager } from '../entities/EntityManager';
import type { NetClient } from '../net/NetClient';
import type { ServerMessage } from '../net/protocol';
import { EFFECT_DEFS, MAX_EFFECT_TICKS, findEffect } from '../player/Effects';
import type { GameMode } from '../player/GameMode';
import type { Player } from '../player/Player';
import type { PlayerStats } from '../player/PlayerStats';
import type { DayCycle } from '../rendering/DayCycle';
import type { WorldMeta } from '../save/SaveSystem';
import { h } from '../ui/dom';
import { DEFAULT_DIFFICULTY, DIFFICULTIES, DIFFICULTY_NAMES, type Difficulty, hostilesAllowed, parseDifficulty } from '../world/Difficulty';
import { GameRules, runGameRuleCommand } from '../world/GameRules';
import { MORNING, MSG, SLEEP_TICKS, bedCells, bedRespawnPoint, canSleepNow, monstersNearby } from '../world/Sleep';
import type { Weather } from '../world/Weather';
import type { World } from '../world/World';
import type { Input } from './Input';
import { KB } from './Keybinds';

/** What the world rules need from the game; filled in by Game so this file stays out of its way. */
export interface WorldRulesHost {
  readonly stats: PlayerStats;
  readonly player: Player;
  readonly cycle: DayCycle;
  readonly input: Input;
  /** Where the sleep overlay goes (the HUD root). */
  readonly overlayParent: HTMLElement;
  world(): World | null;
  entities(): EntityManager | null;
  meta(): WorldMeta | null;
  net(): NetClient | null;
  mode(): GameMode;
  weather(): Weather;
  chat(line: string): void;
}

export type Bed = { x: number; y: number; z: number; point?: boolean };

/**
 * Difficulty, game rules, respawn point and sleeping on the client. Singleplayer owns them (saved in WorldMeta); on a
 * server they come from the welcome and `rules` messages and the server decides about sleeping.
 */
export class WorldRules {
  readonly rules = new GameRules();
  difficulty: Difficulty = DEFAULT_DIFFICULTY;
  /** Respawn point (a bed block, or a /spawnpoint position when `point`). */
  bed: Bed | null = null;

  // ---- sleeping
  sleeping = false;
  private sleepTicks = 0;
  private bedPos: { x: number; y: number; z: number } | null = null;
  /** 0..1 darkness of the sleep overlay. */
  private fade = 0;
  /** Darkness last written to the overlay (fade × 1000, rounded); −1 = not written since it was hidden. */
  private shownFade = -1;
  private readonly overlay: HTMLDivElement;
  /** A respawn at the bed waits for the chunks before it checks the bed. */
  pendingBed: Bed | null = null;

  constructor(private readonly host: WorldRulesHost) {
    this.overlay = h('div', { class: 'sleep-overlay hidden' }, h('div', { class: 'sleep-hint', text: 'Sneak or jump to leave the bed' }));
    host.overlayParent.append(this.overlay);
  }

  // ---------------------------------------------------------------- load, save, apply

  /** Singleplayer world or server welcome. Hardcore is always Hard. */
  load(meta: WorldMeta, fromServer?: { difficulty?: Difficulty; rules?: Record<string, boolean | number>; bed?: Bed }): void {
    const src = fromServer ?? { difficulty: meta.difficulty, rules: meta.rules, bed: meta.bed };
    this.difficulty = parseDifficulty(src.difficulty) ?? DEFAULT_DIFFICULTY;
    if (meta.gameMode === 'hardcore') this.difficulty = 'hard';
    this.rules.load(src.rules);
    this.bed = src.bed ?? null;
    this.stopSleeping(false);
    this.pendingBed = null;
    this.apply();
  }

  save(meta: WorldMeta): void {
    meta.difficulty = this.difficulty;
    meta.rules = this.rules.serialize();
    meta.bed = this.bed ?? undefined;
  }

  /** Pushes the rules into the stats and (singleplayer) the mob spawning. */
  apply(): void {
    const { stats } = this.host;
    stats.difficulty = this.difficulty;
    stats.rules = this.rules;
    const entities = this.host.entities();
    if (entities && !this.host.net()) {
      entities.peaceful = !hostilesAllowed(this.difficulty);
      entities.spawningEnabled = this.rules.get('doMobSpawning');
    }
    this.host.weather().timersFrozen = !this.rules.get('doWeatherCycle');
    const ticker = this.host.world()?.randomTicker;
    if (ticker && !this.host.net()) ticker.speed = this.rules.get('randomTickSpeed');
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = this.host.mode() === 'hardcore' ? 'hard' : d;
    this.apply();
  }

  get daylightCycle(): boolean {
    return this.rules.get('doDaylightCycle');
  }

  // ---------------------------------------------------------------- server messages

  /** Returns true when the message was for us. */
  onServerMessage(msg: ServerMessage): boolean {
    switch (msg.t) {
      case 'rules':
        this.difficulty = parseDifficulty(msg.difficulty) ?? DEFAULT_DIFFICULTY;
        this.rules.load(msg.rules);
        this.apply();
        return true;
      case 'effect': {
        const fx = this.host.stats.effects;
        if (msg.action === 'clear') {
          const id = msg.effect ? findEffect(msg.effect) : null;
          if (id) fx.remove(id, this.host.stats); else fx.clear(this.host.stats);
        } else {
          const id = findEffect(msg.effect ?? '');
          if (id) fx.add(id, Number(msg.amp) || 0, Math.min(MAX_EFFECT_TICKS, Number(msg.ticks) || 600), this.host.stats);
        }
        return true;
      }
      case 'spawnpoint':
        this.bed = msg.bed;
        return true;
      case 'sleep':
        if (msg.state === 'start' && this.bedPos) this.startSleeping(this.bedPos.x, this.bedPos.y, this.bedPos.z);
        else if (msg.state === 'wake') this.stopSleeping(true);
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- beds and sleeping

  /** Right click on a bed. */
  useBed(x: number, y: number, z: number): void {
    const net = this.host.net();
    this.bedPos = { x, y, z };
    if (net) {
      net.send({ t: 'bed', x, y, z });
      return;
    }
    this.bed = { x, y, z };
    this.host.chat(MSG.respawnSet);
    const w = this.host.weather();
    if (!canSleepNow(this.host.cycle.dayFactor, w.raining && w.thundering)) return this.host.chat(MSG.notNight);
    if (monstersNearby(this.host.entities()?.mobs ?? [], x + 0.5, y, z + 0.5)) return this.host.chat(MSG.monsters);
    this.startSleeping(x, y, z);
  }

  private startSleeping(x: number, y: number, z: number): void {
    const world = this.host.world();
    if (!world) return;
    const cells = bedCells((a, b, c) => world.getBlock(a, b, c), (a, b, c) => world.getMeta(a, b, c), x, y, z);
    const head = cells?.head ?? { x, z };
    this.sleeping = true;
    this.sleepTicks = 0;
    this.bedPos = { x, y, z };
    // Lying on the bed: the eye ends up just above the pillow.
    const p = this.host.player;
    p.setPosition(head.x + 0.5, y + 0.56 - 1.3, head.z + 0.5);
    p.flying = false;
    this.overlay.classList.remove('hidden');
    this.overlay.classList.add('on');
  }

  /** Gets up: next to the bed (or where the player was). */
  stopSleeping(placeNextToBed: boolean): void {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.overlay.classList.remove('on');
    const world = this.host.world(), b = this.bedPos;
    if (placeNextToBed && world && b) {
      const spot = bedRespawnPoint((a, c, d) => world.getBlock(a, c, d), (a, c, d) => world.getMeta(a, c, d), b.x, b.y, b.z);
      if (spot) this.host.player.setPosition(spot.x, spot.y, spot.z);
      else this.host.player.setPosition(b.x + 0.5, b.y + 0.6, b.z + 0.5);
    }
    this.host.net()?.send({ t: 'wake' });
  }

  /** Game tick while sleeping: singleplayer skips the night after 100 ticks; sneaking or jumping leaves the bed. */
  gameTick(): void {
    if (!this.sleeping) return;
    const input = this.host.input;
    if (input.actionDown(KB.SNEAK) || input.actionDown(KB.JUMP) || this.host.stats.dead) {
      this.stopSleeping(true);
      return;
    }
    this.sleepTicks++;
    if (!this.host.net() && this.sleepTicks >= SLEEP_TICKS) {
      const cycle = this.host.cycle;
      if (cycle.time > MORNING) cycle.day++;
      cycle.time = MORNING;
      cycle.compute();
      const w = this.host.weather();
      if (w.raining || w.thundering) w.set('clear');
      this.stopSleeping(true);
    }
  }

  /** Per frame: the overlay darkens while asleep and lifts afterwards. */
  update(dt: number): void {
    // Awake with the overlay gone (nearly every frame): no DOM writes, no strings. The overlay's class list used to be
    // written every frame, a mutation and style invalidation per frame in every game.
    if (!this.sleeping && this.fade === 0) return;
    const target = this.sleeping ? Math.min(1, this.sleepTicks / SLEEP_TICKS) * 0.92 + 0.08 : 0;
    this.fade += (target - this.fade) * Math.min(1, dt * (this.sleeping ? 3 : 2.5));
    if (!this.sleeping && this.fade < 0.01) {
      this.fade = 0;
      this.shownFade = -1;
      this.overlay.classList.add('hidden');
      return;
    }
    const q = Math.round(this.fade * 1000);
    if (q !== this.shownFade) {
      this.shownFade = q;
      this.overlay.style.background = `rgba(0, 0, 0, ${(q / 1000).toFixed(3)})`;
      this.overlay.style.opacity = '1';
    }
    if (this.sleeping) {
      // Stay in bed (no physics while asleep).
      const p = this.host.player;
      p.vx = p.vy = p.vz = 0;
    }
  }

  /** Where a respawn goes: the bed (checked once the chunks are there), a /spawnpoint, or the world spawn. */
  respawnTarget(worldSpawn: { x: number; y: number; z: number }): { x: number; y: number; z: number; checkBed: boolean } {
    const b = this.bed;
    if (!b) return { ...worldSpawn, checkBed: false };
    if (b.point) return { x: b.x, y: b.y, z: b.z, checkBed: false };
    return { x: b.x + 0.5, y: b.y + 1, z: b.z + 0.5, checkBed: true };
  }

  /**
   * After the chunks around the bed loaded: the spot next to the bed, or null when the bed is gone or blocked (the
   * message is shown and the bed forgotten, like Minecraft).
   */
  resolveBedRespawn(): { x: number; y: number; z: number } | null {
    const b = this.pendingBed, world = this.host.world();
    this.pendingBed = null;
    if (!b || !world) return null;
    const spot = bedRespawnPoint((x, y, z) => world.getBlock(x, y, z), (x, y, z) => world.getMeta(x, y, z), b.x, b.y, b.z);
    if (spot) return spot;
    this.host.chat(MSG.bedMissing);
    this.bed = null;
    return null;
  }

  // ---------------------------------------------------------------- singleplayer commands

  /** /gamerule, /difficulty, /effect and /spawnpoint in singleplayer; null when the command is not ours. */
  localCommand(text: string): string[] | null {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    switch ((cmd ?? '').toLowerCase()) {
      case 'gamerule': {
        const r = runGameRuleCommand(this.rules, args);
        if (r.changed) this.apply();
        return [r.reply];
      }
      case 'difficulty': {
        if (args.length === 0) return [`The difficulty is ${DIFFICULTY_NAMES[this.difficulty]}`];
        const d = parseDifficulty(args[0]);
        if (!d) return [`Usage: /difficulty ${DIFFICULTIES.join('|')}`];
        if (this.host.mode() === 'hardcore' && d !== 'hard') return ['Hardcore is locked at Hard.'];
        this.setDifficulty(d);
        return [`Set the difficulty to ${DIFFICULTY_NAMES[d]}`];
      }
      case 'spawnpoint': {
        const p = this.host.player;
        this.bed = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100, point: true };
        return ['Set your spawn point to where you stand'];
      }
      case 'effect': return this.effectCommand(args);
      default: return null;
    }
  }

  /** `/effect give [name] <effect> [seconds] [level]` and `/effect clear [name] [effect]`; the name is optional here. */
  private effectCommand(args: string[]): string[] {
    const usage = 'Usage: /effect give <effect> [seconds] [level] | /effect clear [effect]';
    const stats = this.host.stats;
    const action = (args[0] ?? '').toLowerCase();
    let rest = args.slice(1);
    // A player name (or @s / @p) before the effect is accepted and ignored: singleplayer has one player.
    if (rest.length > 0 && !findEffect(rest[0]) && (rest[0].startsWith('@') || rest.length > 1)) rest = rest.slice(1);
    if (action === 'clear') {
      if (rest[0]) {
        const id = findEffect(rest[0]);
        if (!id) return [`Unknown effect "${rest[0].slice(0, 24)}"`];
        stats.effects.remove(id, stats);
        return [`Removed ${EFFECT_DEFS[id].name}`];
      }
      stats.effects.clear(stats);
      return ['Removed every effect'];
    }
    if (action !== 'give') return [usage];
    const id = findEffect(rest[0] ?? '');
    if (!id) return [rest[0] ? `Unknown effect "${rest[0].slice(0, 24)}"` : usage];
    const seconds = rest[1] === undefined ? 30 : Number(rest[1]);
    const level = rest[2] === undefined ? 1 : Number(rest[2]);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds * 20 > MAX_EFFECT_TICKS) return ['Seconds must be a whole number from 1 to 1000000'];
    if (!Number.isInteger(level) || level < 1 || level > 256) return ['Level must be a whole number from 1 to 256'];
    stats.effects.add(id, level - 1, seconds * 20, stats);
    return [`Gave ${EFFECT_DEFS[id].name} ${level} for ${seconds} s`];
  }
}
