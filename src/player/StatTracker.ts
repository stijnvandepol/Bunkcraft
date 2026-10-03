/**
 * Lightweight per-world statistics for the Statistics screen: counters that grow while playing and are saved
 * with the world (`WorldMeta.statistics`). Distances are kept in centimetres so they stay integers.
 */
export const STAT_KEYS = ['mined', 'placed', 'killed', 'deaths', 'walkedCm', 'jumps', 'playMs'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export type StatValues = Record<StatKey, number>;

export class StatTracker {
  private readonly values: StatValues = { mined: 0, placed: 0, killed: 0, deaths: 0, walkedCm: 0, jumps: 0, playMs: 0 };

  add(key: StatKey, n = 1): void {
    if (n > 0 && Number.isFinite(n)) this.values[key] += n;
  }

  get(key: StatKey): number {
    return this.values[key];
  }

  /** Metres walked, from a horizontal step in blocks; teleports and respawns (big jumps) are ignored. */
  addWalk(blocks: number): void {
    if (blocks > 0 && blocks < 5) this.values.walkedCm += Math.round(blocks * 100);
  }

  /** Loads saved values; unknown keys and invalid numbers are ignored (the save is untrusted). */
  load(raw: unknown): void {
    for (const k of STAT_KEYS) this.values[k] = 0;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const r = raw as Record<string, unknown>;
    for (const k of STAT_KEYS) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) this.values[k] = Math.floor(v);
    }
  }

  /** Only the counters that are not zero, to keep the save small. */
  serialize(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of STAT_KEYS) if (this.values[k] >= 1) out[k] = Math.floor(this.values[k]);
    return out;
  }
}

/** "1 h 5 min", "12 min 3 s", "45 s" (Minecraft's time played style). */
export function formatPlayTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** Metres below 1 km, else kilometres with two decimals: "812 m", "1.25 km". */
export function formatDistance(cm: number): string {
  const m = cm / 100;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
