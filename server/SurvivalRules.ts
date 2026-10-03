import type { Mob } from '../src/entities/Mob';
import type { ServerMessage } from '../src/net/protocol';
import { type Difficulty, DEFAULT_DIFFICULTY, parseDifficulty } from '../src/world/Difficulty';
import { GameRules } from '../src/world/GameRules';
import { MORNING, MSG, SLEEP_TICKS, bedCells, canSleepNow, monstersNearby, sleepSkipsNight } from '../src/world/Sleep';

/** How far (blocks) a player may be from the bed they click, and may move away while asleep. */
const BED_REACH = 6;
const SLEEP_LEAVE_DISTANCE = 3;

/** What the survival rules need from the game server; GameServer implements it. */
export interface SurvivalHost {
  send(id: number, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  mobs(): Iterable<Mob>;
  /** 0 night … 1 day. */
  dayFactor(): number;
  thundering(): boolean;
  /** Morning: time to sunrise, weather clear. */
  skipNight(time: number): void;
  /** Stores the player's bed in their record (null = forget it). */
  setBed(name: string, bed: { x: number; y: number; z: number } | null): void;
}

export interface SleeperView { id: number; name: string; x: number; y: number; z: number; hasPos: boolean }

/** The parts of world.json these rules own. */
export interface SurvivalData { difficulty?: Difficulty; rules?: Record<string, boolean | number> }

/**
 * Difficulty, game rules and sleeping for one Minecraft-type game on the server. Sleeping follows the
 * `playersSleepingPercentage` rule (default 100 %: everyone must be in bed); a sleeper has to lie 100 ticks.
 */
export class ServerSurvival {
  readonly rules = new GameRules();
  difficulty: Difficulty = DEFAULT_DIFFICULTY;
  private readonly sleepers = new Map<number, { x: number; y: number; z: number; ticks: number }>();

  constructor(private readonly host: SurvivalHost) {}

  load(data: SurvivalData): void {
    this.difficulty = parseDifficulty(data.difficulty) ?? DEFAULT_DIFFICULTY;
    this.rules.load(data.rules);
  }

  save(data: SurvivalData): void {
    if (this.difficulty !== DEFAULT_DIFFICULTY) data.difficulty = this.difficulty; else delete data.difficulty;
    const r = this.rules.serialize();
    if (r) data.rules = r; else delete data.rules;
  }

  /** Optional welcome fields. */
  welcome(): { difficulty: Difficulty; rules: Record<string, boolean | number> } {
    return { difficulty: this.difficulty, rules: this.rules.serialize() ?? {} };
  }

  /** Tells every client the current difficulty and rules. */
  announce(): void {
    this.host.broadcast({ t: 'rules', difficulty: this.difficulty, rules: this.rules.serialize() ?? {} });
  }

  get sleeping(): number {
    return this.sleepers.size;
  }

  isSleeping(id: number): boolean {
    return this.sleepers.has(id);
  }

  /** Right click on a bed: always sets the respawn point; sleeps when it is night and no monsters are close. */
  bed(p: SleeperView, x: number, y: number, z: number, total: number): void {
    if (![x, y, z].every(Number.isInteger) || !p.hasPos) return;
    if (Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z) > BED_REACH) return;
    if (!bedCells((a, b, c) => this.host.getBlock(a, b, c), (a, b, c) => this.host.getMeta(a, b, c), x, y, z)) return;
    const reply = (text: string): void => this.host.send(p.id, { t: 'chat', from: '', text, system: true });
    this.host.setBed(p.name, { x, y, z });
    this.host.send(p.id, { t: 'spawnpoint', bed: { x, y, z } });
    reply(MSG.respawnSet);
    if (!canSleepNow(this.host.dayFactor(), this.host.thundering())) return reply(MSG.notNight);
    if (monstersNearby(this.host.mobs(), x + 0.5, y, z + 0.5)) return reply(MSG.monsters);
    this.sleepers.set(p.id, { x: x + 0.5, y, z: z + 0.5, ticks: 0 });
    this.host.send(p.id, { t: 'sleep', state: 'start', sleeping: this.sleepers.size, total });
    this.host.broadcast({ t: 'chat', from: '', text: `${p.name} is sleeping (${this.sleepers.size}/${total})`, system: true });
  }

  wake(id: number): void {
    if (!this.sleepers.delete(id)) return;
    this.host.send(id, { t: 'sleep', state: 'wake' });
  }

  /** A player left the game. */
  forget(id: number): void {
    this.sleepers.delete(id);
  }

  /** One server tick: count sleep time, wake who walked away, skip the night once enough players slept long enough. */
  tick(players: SleeperView[]): void {
    if (this.sleepers.size === 0) return;
    const online = new Map(players.map((p) => [p.id, p]));
    for (const [id, s] of this.sleepers) {
      const p = online.get(id);
      if (!p) { this.sleepers.delete(id); continue; }
      if (p.hasPos && Math.hypot(p.x - s.x, p.z - s.z) > SLEEP_LEAVE_DISTANCE) { this.wake(id); continue; }
      s.ticks++;
    }
    let rested = 0;
    for (const s of this.sleepers.values()) if (s.ticks >= SLEEP_TICKS) rested++;
    if (!sleepSkipsNight(rested, players.length, this.rules.get('playersSleepingPercentage'))) return;
    this.host.skipNight(MORNING);
    for (const id of [...this.sleepers.keys()]) this.wake(id);
  }
}
