import { describe, expect, it } from 'vitest';
import { PHYSICS, blockReach } from '../src/player/Physics';

/** Regression tests for the gameplay numbers checked against Minecraft Java 1.21 (docs/qa/BALANCE.md). */
describe('balance: player', () => {
  it('reaches blocks 4.5 away in survival and 5 in creative (block_interaction_range)', () => {
    expect(blockReach(false)).toBe(4.5);
    expect(blockReach(true)).toBe(5);
    expect(PHYSICS.REACH).toBe(4.5);
  });
});
