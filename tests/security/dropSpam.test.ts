import { describe, expect, it } from 'vitest';
import { BLOCK } from '../../src/world/BlockRegistry';
import { ServerEntities, type EntityPlayer } from '../../server/ServerEntities';

function setup() {
  const host = { send: () => undefined, broadcast: () => undefined, broadcastBlock: () => undefined, broadcastBlocks: () => undefined, recordEdit: () => undefined };
  const ents = new ServerEntities(777, {}, 'survival', host, () => 0.25);
  const player: EntityPlayer = { id: 1, x: 0.5, y: 80, z: 0.5, flags: 0, held: 0, hasPos: true };
  return { ents, player };
}

describe('drop spam', () => {
  it('caps the number of dropped items a client can create', () => {
    const { ents, player } = setup();
    for (let i = 0; i < 5000; i++) ents.drop(player, { id: BLOCK.STONE, count: 1 }, 1, 81, 0.5, undefined, 0);
    expect(ents.manager.items.length).toBeLessThanOrEqual(400);
    expect(ents.manager.items.length).toBeGreaterThan(0);
  });

  it('ignores a malformed damage value', () => {
    const { ents, player } = setup();
    ents.drop(player, { id: BLOCK.STONE, count: 1, damage: Number.NaN }, 1, 81, 0.5, undefined, 0);
    ents.drop(player, { id: BLOCK.STONE, count: 1, damage: { evil: 1 } as unknown as number }, 1, 81, 0.5, undefined, 0);
    expect(ents.manager.items.every((i) => i.stack.damage === undefined)).toBe(true);
  });
});
