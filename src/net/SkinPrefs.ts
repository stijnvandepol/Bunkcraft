import { isSkinHash } from '../skins/SkinFormat';

/**
 * What this player wants to see of other people's skins: everything (the setting "Show custom skins of others", default
 * on) minus the skins they hid one by one from the scoreboard or the player list. Hidden skins are remembered by hash in
 * this browser, so a hidden skin stays hidden in every game; a changed skin has a new hash and shows again.
 */
const KEY = 'bunkcraft.hiddenSkins';
const MAX_HIDDEN = 200;

function load(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter(isSkinHash).slice(0, MAX_HIDDEN) : []);
  } catch {
    return new Set();
  }
}

class SkinPrefs {
  /** Bumps on every change; RemotePlayers compares it to know when to re-resolve what each player wears. */
  version = 0;
  private show = true;
  private hidden: Set<string> | null = null;

  private get set(): Set<string> {
    return (this.hidden ??= load());
  }

  get showCustom(): boolean {
    return this.show;
  }

  setShowCustom(v: boolean): void {
    if (v === this.show) return;
    this.show = v;
    this.version++;
  }

  isHidden(hash: string): boolean {
    return this.set.has(hash);
  }

  /** Hide (true) or show again (false) one skin. */
  setHidden(hash: string, hidden: boolean): void {
    if (!isSkinHash(hash) || this.set.has(hash) === hidden) return;
    if (hidden) {
      this.set.add(hash);
      // The oldest entries make room: the list stays small.
      while (this.set.size > MAX_HIDDEN) this.set.delete(this.set.values().next().value!);
    } else this.set.delete(hash);
    try { localStorage.setItem(KEY, JSON.stringify([...this.set])); } catch { /* private mode: hidden for this visit only */ }
    this.version++;
  }

  /** Whether this skin is drawn at all. */
  visible(hash: string): boolean {
    return this.show && !this.set.has(hash);
  }
}

export const skinPrefs = new SkinPrefs();
