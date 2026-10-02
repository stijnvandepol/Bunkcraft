import { GAME_MODES, type GameMode } from '../player/GameMode';

/** Values a "new world" screen can be prefilled with (share links, Re-Create). */
export interface ShareParams {
  name?: string;
  seed?: string;
  mode?: GameMode;
}

/** Reads `?seed=…&mode=…` from a URL query; null when the link carries nothing for Create World. */
export function parseShareParams(search: string): ShareParams | null {
  const q = new URLSearchParams(search);
  const seed = q.get('seed')?.trim().slice(0, 32);
  const mode = q.get('mode')?.toLowerCase();
  const out: ShareParams = {};
  if (seed) out.seed = seed;
  if (mode && (GAME_MODES as string[]).includes(mode)) out.mode = mode as GameMode;
  return out.seed || out.mode ? out : null;
}

/** A link that opens Create World with this seed (and mode) filled in. */
export function shareLink(base: string, seed: string, mode?: GameMode): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('seed', seed);
  if (mode) url.searchParams.set('mode', mode);
  return url.toString();
}
