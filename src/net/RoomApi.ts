import { type GameType, parseGameType } from '../modes/GameTypes';
import { type MapSetting } from '../modes/maps';
import { type MatchPhase, formatCode } from './protocol';
import { type ListingKind, type ModeStats, filterRooms } from '../modes/Realms';

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
  /** A password is needed to join (older servers: absent = open). */
  locked?: boolean;
}

/** One row of the public server list. */
export interface ListedRoom extends RoomInfo {
  code: string;
  /** Arcade lobbies with players (newer servers): match phase, seconds left in it, the map played right now. */
  phase?: MatchPhase;
  timeLeft?: number;
  currentMap?: string;
}

/** Match settings sent when creating an arcade game (ignored for Minecraft games). */
export interface RoomOptions {
  /** Optional room password (the server stores only a hash). */
  password?: string;
  /** Show the game in the public server list (default: private). */
  listed?: boolean;
  gameType: GameType;
  scoreLimit: number;
  timeLimitSec: number;
  /** Arcade games: a map id or "rotate" (older servers ignore it). */
  mapId?: MapSetting;
  /** Realms lobbies: how many players the game takes (the server clamps it; older servers ignore it). */
  maxPlayers?: number;
}

export interface ServerInfo {
  /** Players can create their own games on this server. */
  rooms: boolean;
  /** The always-on main world is open. */
  main: boolean;
  /** Largest lobby size this server allows (ROOM_MAX_PLAYERS); absent on older servers. */
  roomMaxPlayers?: number;
  /** Features of newer servers; absent on older ones. */
  features?: { passwords?: boolean; browse?: boolean; binary?: boolean; realms?: boolean; profiles?: boolean };
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
  const { code, ownerToken } = await request<{ code: string; ownerToken?: string }>('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name, gameMode, seed,
      gameType: options?.gameType ?? 'minecraft',
      scoreLimit: options?.scoreLimit ?? 0,
      timeLimitSec: options?.timeLimitSec ?? 0,
      ...(options?.mapId ? { mapId: options.mapId } : {}),
      ...(options?.maxPlayers ? { maxPlayers: options.maxPlayers } : {}),
      ...(options?.password ? { password: options.password } : {}),
      ...(options?.listed ? { listed: true } : {}),
    }),
  });
  // The server shows the owner token once; keeping it makes this browser the operator of the game.
  if (ownerToken) {
    saveOwnerToken(code, ownerToken);
    if (options?.password) setRoomPassword(code, options.password);
  }
  return code;
}

/**
 * The public server list; empty on servers that do not have it. `kind` keeps Minecraft games (Multiplayer) or
 * arcade lobbies (Realms); filtered here as well because older servers ignore the parameter.
 */
export async function browseRooms(kind?: ListingKind): Promise<ListedRoom[]> {
  const { rooms } = await request<{ rooms: ListedRoom[] }>(`/api/rooms?public=1${kind ? `&kind=${kind}` : ''}`);
  const list = (Array.isArray(rooms) ? rooms : []).map((r) => ({ ...r, gameType: parseGameType(r.gameType) }));
  return filterRooms(list, kind ?? null);
}

/** Realms quick play: the code of a lobby of this mode to join (an existing one, or a new one the server opened). */
export async function quickPlay(gameType: GameType): Promise<{ code: string; created: boolean }> {
  return request<{ code: string; created: boolean }>('/api/quickplay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameType }),
  });
}

/** Players and lobbies per Realms mode; empty when the server cannot tell. */
export async function realmsStats(): Promise<ModeStats[]> {
  try {
    const { modes } = await request<{ modes: ModeStats[] }>('/api/realms');
    return Array.isArray(modes) ? modes : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- secrets kept in this browser

const OWNER_PREFIX = 'bunkcraft.owner.';
const KEY_PREFIX = 'bunkcraft.key.';
/** Room passwords live in memory only (they are typed again after a reload). */
const passwords = new Map<string, string>();

export function saveOwnerToken(code: string, token: string): void {
  try {
    localStorage.setItem(OWNER_PREFIX + code, token);
  } catch {
    // Storage unavailable: this browser just will not be the operator next time.
  }
}

/** The token that makes this browser the owner (operator) of a game it created, if any. */
export function ownerToken(code: string): string | undefined {
  try {
    return localStorage.getItem(OWNER_PREFIX + code) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setRoomPassword(code: string, password: string): void {
  passwords.set(code, password);
}

/** The server refused the password (wrong or rate limited): the next join asks again instead of reusing it. */
export function forgetRoomPassword(code: string): void {
  passwords.delete(code);
}

export function roomPassword(code: string): string | undefined {
  return passwords.get(code);
}

/**
 * A random secret per server and game that binds your name to this browser (so nobody can log in as
 * you, or as an operator). Never leaves for another server because the key is stored per host and room.
 */
export function identityKey(host: string, room?: string): string {
  const id = `${KEY_PREFIX}${host}/${room ?? 'main'}`;
  try {
    const have = localStorage.getItem(id);
    if (have && have.length >= 16) return have;
    const key = randomKey();
    localStorage.setItem(id, key);
    return key;
  } catch {
    return randomKey();
  }
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
