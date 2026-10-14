import type { WebSocket } from 'ws';
import type { MatchOutcome, MatchTally, ProgressReport } from '../src/modes/progression/Profile';
import type { GameServer } from './GameServer';

/**
 * What one game needs from the profile store. The control plane hands it the real ProfileService; a match runner
 * (ROLE=match, server/match/) hands it a facade that asks the control plane, so XP stays authoritative there.
 * `award` may answer later: the runner's grant is an HTTP call.
 */
export interface ProfileBackend {
  verify(token: unknown): string | null;
  reservedProfile(name: string): string | null;
  get(id: string): object | null;
  rank(id: string | undefined): number;
  seen(id: string, name: string): void;
  award(id: string, tally: MatchTally, outcome: MatchOutcome): ProgressReport | null | Promise<ProgressReport | null>;
}

/** What one game needs from the skin store (see ProfileBackend). */
export interface SkinBackend {
  effective(profileId: string | undefined): string;
  report(hash: string, reporter: string, wearer: string): boolean;
}

export type RejoinStatus = ReturnType<GameServer['rejoinStatus']>;

/**
 * One loaded game as Rooms, the HTTP API and the admin tools see it: a GameServer in this process, or a RemoteRoom
 * (server/match/RemoteRoom.ts) whose match runs in its own container. Everything here is synchronous except the
 * rejoin check, so matchmaking stays a plain function; a remote room answers from its last heartbeat.
 */
export interface RoomServer {
  readonly playerCount: number;
  readonly reservedSeats: number;
  readonly botCount: number;
  readonly playersInPlay: number;
  readonly listed: boolean;
  readonly locked: boolean;
  readonly maxPlayers: number;
  info(): ReturnType<GameServer['info']>;
  lobbyStatus(): ReturnType<GameServer['lobbyStatus']>;
  teamLoad(): ReturnType<GameServer['teamLoad']>;
  rejoinStatus(proof: { token?: unknown; profile?: unknown }): RejoinStatus | Promise<RejoinStatus>;
  reserve(key: string, party: string, size: number, ttlMs: number): ReturnType<GameServer['reserve']>;
  release(key: string): void;
  playerList(): ReturnType<GameServer['playerList']>;
  kickPlayer(name: string, reason: string): boolean;
  refreshSkins(profileId?: string): void;
  announce(text: string): void;
  save(): void;
  /** Saves, settles XP and disconnects everybody: the game is over (admin close, idle unload). */
  shutdown(reconnectMs?: number, reason?: string): void;
  /**
   * This process stops but the game may go on elsewhere (a match container outlives a control plane update):
   * disconnect the players here with a reconnect hint. Absent = shutdown.
   */
  detach?(reconnectMs?: number): void;
  accept(ws: WebSocket, meta?: { ip?: string }): void;
}
