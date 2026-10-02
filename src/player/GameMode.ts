export type GameMode = 'survival' | 'creative' | 'spectator' | 'hardcore';

export const GAME_MODES: GameMode[] = ['survival', 'creative', 'hardcore', 'spectator'];

export const GAME_MODE_NAMES: Record<GameMode, string> = {
  survival: 'Survival',
  creative: 'Creative',
  hardcore: 'Hardcore',
  spectator: 'Spectator',
};

export const GAME_MODE_HINTS: Record<GameMode, string> = {
  survival: 'Search for resources, craft, gain levels, health and hunger',
  creative: 'Unlimited resources, free flying and destroy blocks instantly',
  hardcore: 'Same as Survival Mode, locked at hardest difficulty, and one life only',
  spectator: 'You can look but don\'t touch',
};

/** Health, hunger, drops and timed mining apply. */
export function hasSurvivalRules(mode: GameMode): boolean {
  return mode === 'survival' || mode === 'hardcore';
}

export function canFly(mode: GameMode): boolean {
  return mode === 'creative' || mode === 'spectator';
}
