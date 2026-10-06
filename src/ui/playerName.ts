import { NAME_PATTERN } from '../net/protocol';

/** The player name for Multiplayer and Realms, typed once and remembered in this browser. */
const KEY = 'bunkcraft.name';

export function savedPlayerName(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** A valid saved name, or null when the player still has to choose one. */
export function validSavedName(): string | null {
  const n = savedPlayerName().trim();
  return NAME_PATTERN.test(n) ? n : null;
}

export function savePlayerName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Private mode: the name is asked again next time.
  }
}
