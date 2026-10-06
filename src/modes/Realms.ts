import { GAME_TYPES, type GameType, gameTypeDef } from './GameTypes';
import type { MatchPhase } from '../net/protocol';

/**
 * BunkCraft Realms: the arcade minigames hub (team deathmatch, free for all, ...). Multiplayer is the
 * Minecraft sandbox only; every arcade game type lives under Realms. Pure rules shared by the server
 * (matchmaking, listings) and the menu (filters), so both agree and both can be unit tested.
 */

/** Which half of the game a list belongs to: Multiplayer (Minecraft) or Realms (arcade). */
export type ListingKind = 'minecraft' | 'arcade';

/** The arcade game types in playlist order. */
export const REALMS_MODES: GameType[] = GAME_TYPES.filter((g) => g.arcade).map((g) => g.id);

export function isArcade(type: GameType | undefined): boolean {
  return gameTypeDef(type ?? 'minecraft').arcade;
}

export function parseListingKind(v: unknown): ListingKind | null {
  return v === 'minecraft' || v === 'arcade' ? v : null;
}

/** Keeps the rooms of one kind; rooms without a game type are Minecraft games (older servers). A null kind keeps all. */
export function filterRooms<T extends { gameType?: GameType }>(rooms: readonly T[], kind: ListingKind | null): T[] {
  if (!kind) return [...rooms];
  return rooms.filter((r) => isArcade(r.gameType) === (kind === 'arcade'));
}

/** A live match with less than this many seconds left is "about to end": quick play does not drop you into it. */
export const NEAR_END_SECONDS = 75;
/** ... and neither when the leader has this share of the score limit. */
export const NEAR_END_PROGRESS = 0.8;

/** What matchmaking knows about one lobby. */
export interface LobbyCandidate {
  code: string;
  gameType: GameType;
  players: number;
  maxPlayers: number;
  /** Listed in the public list and without a password. */
  open: boolean;
  /** Absent for a lobby that is not loaded (nobody in it): it waits in warm-up. */
  phase?: MatchPhase;
  /** Seconds left in the current phase. */
  timeLeft?: number;
  /** The leader's share of the score limit, 0..1. */
  progress?: number;
}

/** Whether a quick-play player may be put into this lobby of `mode`. */
export function joinable(c: LobbyCandidate, mode: GameType): boolean {
  if (c.gameType !== mode || !c.open || c.players >= c.maxPlayers) return false;
  if (c.phase === 'live' || c.phase === 'roundend') {
    // Round-based modes count rounds, not the clock of one round: only the progress decides there.
    const rounds = !!gameTypeDef(mode).rounds;
    if (!rounds && c.timeLeft !== undefined && c.timeLeft < NEAR_END_SECONDS) return false;
    if ((c.progress ?? 0) >= NEAR_END_PROGRESS) return false;
  }
  return true;
}

/**
 * Quick play: the fullest joinable public lobby of the mode (more players = a better game right away);
 * between equally full ones, a lobby still in warm-up or between matches (you play from the start), then the
 * code for a stable choice. Null = there is none, create a new lobby.
 */
export function pickLobby(candidates: readonly LobbyCandidate[], mode: GameType): LobbyCandidate | null {
  let best: LobbyCandidate | null = null;
  for (const c of candidates) {
    if (!joinable(c, mode)) continue;
    if (!best || better(c, best)) best = c;
  }
  return best;
}

function fresh(c: LobbyCandidate): number {
  return c.phase === undefined || c.phase === 'warmup' || c.phase === 'ended' ? 1 : 0;
}

function better(a: LobbyCandidate, b: LobbyCandidate): boolean {
  if (a.players !== b.players) return a.players > b.players;
  if (fresh(a) !== fresh(b)) return fresh(a) > fresh(b);
  return a.code < b.code;
}

/** Name of a lobby that quick play opens: "Team Deathmatch #K7Q". */
export function quickPlayName(mode: GameType, code: string): string {
  return `${gameTypeDef(mode).name} #${code.slice(0, 3)}`;
}

/** Players and public lobbies per mode, for the playlist cards. */
export interface ModeStats { gameType: GameType; players: number; lobbies: number }

/** Lobby sizes a private lobby may choose. */
export const LOBBY_SIZES = [2, 4, 6, 8, 10, 12, 16];
export const LOBBY_SIZE_RANGE = { min: 2, max: 16 };
