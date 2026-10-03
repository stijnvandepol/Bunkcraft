/** World difficulty (DOM-free: shared by the client, the Node server and the tests). */
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = ['peaceful', 'easy', 'normal', 'hard'];

export const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard',
};

export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

export function parseDifficulty(s: unknown): Difficulty | null {
  if (typeof s === 'number') return DIFFICULTIES[s] ?? null;
  const k = String(s ?? '').toLowerCase().trim();
  if (/^[0-3]$/.test(k)) return DIFFICULTIES[Number(k)];
  if (k === 'p') return 'peaceful';
  if (k === 'e') return 'easy';
  if (k === 'n') return 'normal';
  if (k === 'h') return 'hard';
  return (DIFFICULTIES as readonly string[]).includes(k) ? (k as Difficulty) : null;
}

/** Next difficulty in the cycle button (Peaceful, Easy, Normal, Hard, back to Peaceful). */
export function nextDifficulty(d: Difficulty): Difficulty {
  return DIFFICULTIES[(DIFFICULTIES.indexOf(d) + 1) % DIFFICULTIES.length];
}

/** Hostile mobs exist (spawn and stay) only above Peaceful. */
export function hostilesAllowed(d: Difficulty): boolean {
  return d !== 'peaceful';
}

/**
 * Damage dealt by a mob after the difficulty (Minecraft Wiki, Difficulty): Peaceful 0, Easy min(D/2 + 1, D),
 * Normal D, Hard 1.5 D.
 */
export function scaleMobDamage(d: Difficulty, damage: number): number {
  switch (d) {
    case 'peaceful': return 0;
    case 'easy': return Math.min(damage / 2 + 1, damage);
    case 'hard': return damage * 1.5;
    default: return damage;
  }
}

/** Starvation stops at 10 health on Easy, at half a heart on Normal and kills on Hard (and Hardcore). */
export function starvationFloor(d: Difficulty, hardcore: boolean): number {
  if (hardcore || d === 'hard') return 0;
  return d === 'easy' ? 10 : 1;
}
