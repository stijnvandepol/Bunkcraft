import { type GameType, parseGameType } from '../modes/GameTypes';
import { type MapSetting } from '../modes/maps';
import { formatCode } from './protocol';

export interface RoomInfo {
  code: string;
  name: string;
  gameMode: string;
  players: number;
  maxPlayers: number;
  /** Absent on servers from before the arcade game types: those are always Minecraft games. */
  gameType?: GameType;
  scoreLimit?: number;
  timeLimitSec?: number;
  /** Arcade games: a map id or "rotate"; absent on older servers. */
  map?: string;
}

/** Match settings sent when creating an arcade game (ignored for Minecraft games). */
export interface RoomOptions {
  gameType: GameType;
  scoreLimit: number;
  timeLimitSec: number;
  /** Arcade games: a map id or "rotate" (older servers ignore it). */
  mapId?: MapSetting;
}

export interface ServerInfo {
  /** Players can create their own games on this server. */
  rooms: boolean;
  /** The always-on main world is open. */
  main: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Could not reach the server');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Server error (${res.status})`);
  return body;
}

/** What the server this page came from supports; null when there is no game server (static hosting). */
export async function serverInfo(): Promise<ServerInfo | null> {
  try {
    const info = await request<ServerInfo>('/api/server');
    // Static hosts may answer every path with a page: only a real BunkCraft server reports its features.
    return typeof info.rooms === 'boolean' && typeof info.main === 'boolean' ? info : null;
  } catch {
    return null;
  }
}

export async function createRoom(name: string, gameMode: string, seed: string, options?: RoomOptions): Promise<string> {
  const { code } = await request<{ code: string }>('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name, gameMode, seed,
      gameType: options?.gameType ?? 'minecraft',
      scoreLimit: options?.scoreLimit ?? 0,
      timeLimitSec: options?.timeLimitSec ?? 0,
      ...(options?.mapId ? { mapId: options.mapId } : {}),
    }),
  });
  return code;
}

export async function lookupRoom(code: string): Promise<RoomInfo> {
  const info = await request<RoomInfo>(`/api/rooms/${encodeURIComponent(code)}`);
  return { ...info, gameType: parseGameType(info.gameType) };
}

/** Link that opens the game and goes straight to joining this room. */
export function inviteLink(code: string): string {
  return `${location.origin}/?join=${code}`;
}

export function inviteText(code: string): string {
  return `Join my BunkCraft game: ${inviteLink(code)} (code ${formatCode(code)})`;
}

/** Games this browser joined or created, most recent first (for one-click rejoining). */
export interface RecentGame { code: string; name: string; gameType?: GameType }

const RECENT_KEY = 'bunkcraft.games';

export function recentGames(): RecentGame[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentGame[];
    return Array.isArray(list) ? list.filter((g) => typeof g?.code === 'string' && typeof g?.name === 'string')
      .map((g) => ({ ...g, gameType: parseGameType(g.gameType) })).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberGame(game: RecentGame): void {
  try {
    const list = [game, ...recentGames().filter((g) => g.code !== game.code)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: rejoin by code instead.
  }
}

export function forgetGame(code: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentGames().filter((g) => g.code !== code)));
  } catch {
    // Nothing to forget.
  }
}
