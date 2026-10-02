/**
 * Global voice limit. Every sound source (oscillator or noise burst) asks for a slot; when all slots are
 * taken, the quietest/oldest voice of the lowest priority is stopped, or the newcomer is dropped when it
 * would be the least important itself. Pure logic: time is injected, stopping is a callback.
 */

export const Priority = {
  Ambient: 0,
  Normal: 1,
  Player: 2,
  Ui: 3,
} as const;

interface Voice {
  /** Time (s) when the voice ends by itself. */
  end: number;
  score: number;
  start: number;
  stop: (() => void) | null;
  active: boolean;
}

/** A newcomer must beat the weakest running voice by this much to steal its slot (stops equal sounds from thrashing). */
const STEAL_MARGIN = 0.05;

export class VoiceLimiter {
  private readonly pool: Voice[] = [];
  /** Voices refused (newcomer least important) and stolen (running voice stopped), for the debug report. */
  dropped = 0;
  stolen = 0;

  constructor(readonly max: number) {
    for (let i = 0; i < max; i++) this.pool.push({ end: 0, score: 0, start: 0, stop: null, active: false });
  }

  /** Score: priority dominates; volume breaks ties (a quiet footstep goes before a loud explosion). */
  static score(priority: number, volume: number): number {
    return priority * 10 + Math.min(1.5, Math.max(0, volume));
  }

  activeCount(now: number): number {
    let n = 0;
    for (const v of this.pool) if (v.active && v.end > now) n++;
    return n;
  }

  /** Would a voice with this priority and volume get a slot right now? (No state change: lets callers skip building nodes.) */
  canAccept(now: number, priority: number, volume: number): boolean {
    const score = VoiceLimiter.score(priority, volume);
    let worst = Infinity;
    for (const v of this.pool) {
      if (!v.active || v.end <= now) return true;
      if (v.score < worst) worst = v.score;
    }
    return score > worst + STEAL_MARGIN;
  }

  /**
   * Request a slot. Returns true when the voice may start. `stop` is called if the voice is later stolen
   * (it may be null for voices that cannot be stopped).
   */
  request(now: number, priority: number, volume: number, end: number, stop: (() => void) | null): boolean {
    let free: Voice | null = null;
    let worst: Voice | null = null;
    for (const v of this.pool) {
      if (v.active && v.end <= now) v.active = false;
      if (!v.active) {
        if (!free) free = v;
        continue;
      }
      if (!worst || v.score < worst.score || (v.score === worst.score && v.start < worst.start)) worst = v;
    }
    const score = VoiceLimiter.score(priority, volume);
    if (!free) {
      if (!worst || score <= worst.score + STEAL_MARGIN) {
        this.dropped++;
        return false;
      }
      worst.stop?.();
      this.stolen++;
      free = worst;
    }
    free.active = true;
    free.end = end;
    free.start = now;
    free.score = score;
    free.stop = stop;
    return true;
  }
}
