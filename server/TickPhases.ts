/** Milliseconds per phase of one entity tick (slow-tick log, /metrics, benchmarks). */
export interface TickPhases {
  /** Chunk streaming around the players (`ServerWorld.update`). */
  world: number;
  /** Liquids, redstone, random ticks, block updates and furnaces. */
  blocks: number;
  /** Natural mob spawning. */
  spawn: number;
  /** Mob AI, path finding and physics. */
  mobs: number;
  /** Items, arrows, orbs and TNT. */
  other: number;
  /** Building and sending the entity snapshots. */
  snapshots: number;
}

export const TICK_PHASES: readonly (keyof TickPhases)[] = ['world', 'blocks', 'spawn', 'mobs', 'other', 'snapshots'];
