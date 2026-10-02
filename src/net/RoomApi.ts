import { formatCode } from './protocol';

export interface RoomInfo {
  code: string;
  name: string;
  gameMode: string;
  players: number;
  maxPlayers: number;
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
    return await request<ServerInfo>('/api/server');
  } catch {
    return null;
  }
}

export async function createRoom(name: string, gameMode: string, seed: string): Promise<string> {
  const { code } = await request<{ code: string }>('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, gameMode, seed }),
  });
  return code;
}

export function lookupRoom(code: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/api/rooms/${encodeURIComponent(code)}`);
}

/** Link that opens the game and goes straight to joining this room. */
export function inviteLink(code: string): string {
  return `${location.origin}/?join=${code}`;
}

export function inviteText(code: string): string {
  return `Join my BunkCraft game: ${inviteLink(code)} (code ${formatCode(code)})`;
}

/** Games this browser joined or created, most recent first (for one-click rejoining). */
export interface RecentGame { code: string; name: string }

const RECENT_KEY = 'bunkcraft.games';

export function recentGames(): RecentGame[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentGame[];
    return Array.isArray(list) ? list.filter((g) => typeof g?.code === 'string' && typeof g?.name === 'string').slice(0, 5) : [];
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
