import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { GameType } from '../../src/modes/GameTypes';
import type { MapSetting } from '../../src/modes/maps';
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol';
import { GameServer } from '../../server/GameServer';
import type { BotSettings } from '../../server/bots/BotManager';

/**
 * Arcade lobbies with bots on a simulated clock: `Date.now` is replaced by a counter the caller advances,
 * and the server's tick is called by hand, so minutes of play take seconds and are reproducible enough to test.
 * Used by the bot integration tests and scripts/bench-bots.ts.
 */
export class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  keep = true;
  send(data: string | ArrayBuffer) {
    if (this.keep && typeof data === 'string') this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.readyState = 3; this.emit('close'); }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

export interface SimClock { ms: number }

export interface LobbyOptions {
  gameType: GameType;
  map: MapSetting;
  bots?: BotSettings;
  scoreLimit?: number;
  timeLimitSec?: number;
  maxPlayers?: number;
  seed?: string;
  tickHz?: number;
}

export class SimLobby {
  readonly server: GameServer;
  readonly dir: string;
  readonly humans: FakeSocket[] = [];

  constructor(readonly clock: SimClock, o: LobbyOptions) {
    this.dir = mkdtempSync(join(tmpdir(), 'bunk-bots-'));
    this.server = new GameServer({
      dataDir: this.dir, worldName: 'Bots', seed: o.seed ?? '7', gameMode: 'survival', motd: '', maxPlayers: o.maxPlayers ?? 12, quiet: true,
      gameType: o.gameType, scoreLimit: o.scoreLimit, timeLimitSec: o.timeLimitSec, mapId: o.map, bots: o.bots, arcadeTickHz: o.tickHz ?? 30,
    });
    // The real interval timer would tick on the wall clock; the simulation ticks by hand.
    (this.server as unknown as { timers: NodeJS.Timeout[] }).timers.forEach(clearInterval);
  }

  /** A person who connects and stands at the spawn (reports its position once a second; the bots get a target). */
  join(name: string): FakeSocket {
    const ws = new FakeSocket();
    this.server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
    this.humans.push(ws);
    return ws;
  }

  /** A person leaves on purpose (quit to title): their seat is free at once. */
  leave(ws: FakeSocket): void {
    ws.say({ t: 'bye' });
    ws.close();
    this.humans.splice(this.humans.indexOf(ws), 1);
  }

  /** A person's connection drops (network, reload): their seat is kept for a rejoin. */
  drop(ws: FakeSocket): void {
    ws.close();
    this.humans.splice(this.humans.indexOf(ws), 1);
  }

  tick(): void {
    (this.server as unknown as { tick(): void }).tick();
  }

  /** Advances the clock by `seconds` in ticks of 1/tickHz, with the idle people re-reporting their spawn position. */
  run(seconds: number, hz = 30, onTick?: () => boolean | void): void {
    const steps = Math.round(seconds * hz);
    const dt = 1000 / hz;
    for (let i = 0; i < steps; i++) {
      this.clock.ms += dt;
      if (i % hz === 0) this.idleHumans();
      this.tick();
      if (onTick?.()) return;
    }
  }

  private idleHumans(): void {
    for (const ws of this.humans) {
      const sp = ws.sent.filter((m) => m.t === 'spawn' || m.t === 'teleport').pop() as { x: number; y: number; z: number } | undefined;
      if (sp) ws.say({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
      if (ws.sent.length > 2000) ws.sent.splice(0, ws.sent.length - 500);
    }
  }

  get match() {
    return (this.server as unknown as { match: import('../../server/Match').Match }).match;
  }

  get bots() {
    return (this.server as unknown as { bots: import('../../server/bots/BotManager').BotManager }).bots;
  }

  dispose(): void {
    this.server.shutdown();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
