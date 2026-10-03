import { describe, expect, it } from 'vitest';
import { PHYSICS, blockReach } from '../src/player/Physics';
import { type MoveInput, Player } from '../src/player/Player';
import { BLOCK } from '../src/world/BlockRegistry';
import { TestWorld } from './helpers';

/** Regression tests for the gameplay numbers checked against Minecraft Java 1.21 (docs/qa/BALANCE.md). */

const floor = new TestWorld().fill(-20, 63, -3, 30, 63, 3, BLOCK.STONE);

function move(over: Partial<MoveInput>): MoveInput {
  return { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false, ...over };
}

/** Ground speed in blocks/s after the player has settled (1 s of walking, then 1 s measured). */
function groundSpeed(input: MoveInput): number {
  const p = new Player();
  p.canFly = false;
  p.setPosition(-15.5, 64, 0.5);
  p.yaw = -Math.PI / 2; // facing +X
  for (let i = 0; i < 60; i++) p.step(input, floor.get);
  const x0 = p.x;
  for (let i = 0; i < 60; i++) p.step(input, floor.get);
  return p.x - x0;
}

describe('balance: player', () => {
  it('reaches blocks 4.5 away in survival and 5 in creative (block_interaction_range)', () => {
    expect(blockReach(false)).toBe(4.5);
    expect(blockReach(true)).toBe(5);
    expect(PHYSICS.REACH).toBe(4.5);
  });

  it('walks 4.317, sprints 5.612 and sneaks 1.295 blocks/s', () => {
    expect(groundSpeed(move({ forward: 1 }))).toBeCloseTo(4.317, 1);
    expect(groundSpeed(move({ forward: 1, sprint: true }))).toBeCloseTo(5.612, 1);
    expect(groundSpeed(move({ forward: 1, descend: true }))).toBeCloseTo(1.295, 1);
  });

  it('cannot sprint while sneaking', () => {
    expect(groundSpeed(move({ forward: 1, descend: true, sprint: true }))).toBeCloseTo(1.295, 1);
  });

  it('jumps about 1.25 blocks high (jump_strength 0.42, gravity 0.08)', () => {
    const p = new Player();
    p.canFly = false;
    p.setPosition(0.5, 64, 0.5);
    p.step(move({}), floor.get);
    let top = p.y;
    p.step(move({ jump: true }), floor.get);
    for (let i = 0; i < 60; i++) {
      p.step(move({}), floor.get);
      top = Math.max(top, p.y);
    }
    expect(top - 64).toBeGreaterThan(1.2);
    expect(top - 64).toBeLessThan(1.3);
  });
});
