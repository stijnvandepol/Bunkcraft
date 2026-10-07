import { type Rank, levelFromXp } from '../modes/progression/Levels';
import { type ProfileData, type ProgressReport, rankOf, sanitizeProfile } from '../modes/progression/Profile';

/**
 * The browser side of Realms profiles. The server issues a signed token once (POST /api/profile) and this
 * browser keeps it in localStorage per server host, like the owner tokens of games; it goes along in the
 * Authorization header and in the WebSocket hello. The client never changes XP: it only shows what the
 * server reports and asks it for the profile again after a match.
 */
const TOKEN_PREFIX = 'bunkcraft.profile.';

let current: ProfileData | null = null;
const listeners = new Set<(p: ProfileData | null) => void>();

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function host(): string {
  return typeof location !== 'undefined' ? location.host : 'local';
}

/** This browser's profile token for the server it talks to, if it has one. */
export function profileToken(server = host()): string | undefined {
  try {
    return storage()?.getItem(TOKEN_PREFIX + server) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  try { storage()?.setItem(TOKEN_PREFIX + host(), token); } catch { /* private mode: a new profile next time */ }
}

export function currentProfile(): ProfileData | null {
  return current;
}

/** Rank of the loaded profile (level 1 when there is none: guests see the starting kit). */
export function currentRank(): Rank {
  return current ? rankOf(current) : { level: 1, prestige: 0 };
}

/** Called with the profile whenever it changes (and once right away). Returns the unsubscribe function. */
export function onProfile(fn: (p: ProfileData | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

function set(p: ProfileData | null): ProfileData | null {
  current = p;
  for (const fn of listeners) fn(p);
  return p;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = profileToken();
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

/**
 * The profile of this browser on this server, created on first use. Null when the server has no profiles
 * (older or static servers) or cannot be reached; the menus then simply show no level.
 */
export async function loadProfile(name: string): Promise<ProfileData | null> {
  try {
    const { status, data } = await call('POST', '/api/profile', { name });
    if (status === 201 && typeof data.token === 'string') saveToken(data.token);
    if (status !== 200 && status !== 201) return set(current);
    return set(sanitizeProfile(data.profile));
  } catch {
    return set(current);
  }
}

/** Fetches the profile again (after a match). */
export async function refreshProfile(): Promise<ProfileData | null> {
  if (!profileToken()) return current;
  try {
    const { status, data } = await call('GET', '/api/profile');
    return status === 200 ? set(sanitizeProfile(data.profile)) : current;
  } catch {
    return current;
  }
}

/** Title, calling card or camos (the server checks the unlocks). Returns whether everything was accepted. */
export async function equip(change: { title?: string; card?: string; camos?: Record<string, string> }): Promise<boolean> {
  try {
    const { status, data } = await call('POST', '/api/profile/equip', change);
    if (data.profile) set(sanitizeProfile(data.profile));
    return status === 200;
  } catch {
    return false;
  }
}

export async function prestige(): Promise<boolean> {
  try {
    const { status, data } = await call('POST', '/api/profile/prestige', {});
    if (data.profile) set(sanitizeProfile(data.profile));
    return status === 200;
  } catch {
    return false;
  }
}

/** A match report arrived: show the new level at once, then load the full profile from the server. */
export function applyReport(r: ProgressReport): void {
  if (current) {
    current.xp = r.after.xp;
    current.prestige = r.after.prestige;
    set(current);
  }
  void refreshProfile();
}

/** Level, XP into it and the size of the level, for bars. */
export function levelProgress(p: Pick<ProfileData, 'xp'>): { level: number; into: number; need: number } {
  return levelFromXp(p.xp);
}
