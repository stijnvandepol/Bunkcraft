import { describe, expect, it } from 'vitest';
import { ITEM } from '../src/items/ItemRegistry';
import type { ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { type EntityPlayer, ServerEntities, dayFactorAt } from '../server/ServerEntities';
import { ServerWorld } from '../server/ServerWorld';

function setup(mode: 'survival' | 'creative' = 'survival', time = 0.25) {
  const sent: { to: number; msg: ServerMessage }[] = [];
  const edits: Record<string, number> = {};
  const host = {
    send: (to: number, msg: ServerMessage) => sent.push({ to, msg }),
    broadcast: (msg: ServerMessage) => sent.push({ to: -1, msg }),
    broadcastBlock: () => undefined,
    broadcastBlocks: () => undefined,
    recordEdit: (x: number, y: number, z: number, id: number) => { edits[`${x},${y},${z}`] = id; },
  };
  const ents = new ServerEntities(777, edits, mode, host, () => time);
  const player: EntityPlayer = { id: 1, x: 0.5, y: 80, z: 0.5, flags: 0, held: 0, hasPos: true };
  return { ents, player, sent, edits };
}

describe('ServerWorld', () => {
  it('loads chunks near the players and unloads them when they leave', () => {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.loadedChunks).toBe(81); // radius 4
    expect(w.getBlock(0, 0, 0)).not.toBe(BLOCK.UNLOADED);
    for (let i = 0; i < 80; i++) w.update([{ x: 1000, z: 1000 }]);
    expect(w.getBlock(0, 70, 0)).toBe(BLOCK.UNLOADED);
  });

  it('applies saved edits when a chunk generates and reports new ones', () => {
    const seen: string[] = [];
    const w = new ServerWorld(1, { '3,100,3': BLOCK.GLASS });
    w.onEdit = (x, y, z, id) => seen.push(`${x},${y},${z}=${id}`);
    for (let i = 0; i < 10; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.getBlock(3, 100, 3)).toBe(BLOCK.GLASS);
    w.setBlock(4, 100, 4, BLOCK.STONE);
    expect(w.getBlock(4, 100, 4)).toBe(BLOCK.STONE);
    expect(seen).toContain('4,100,4=1');
  });

  it('has sky light in the open and none under a roof; torches light their surroundings', () => {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 10; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.getSkyLight(0, 120, 0)).toBe(15);
    w.setBlock(0, 110, 0, BLOCK.STONE);
    expect(w.getSkyLight(0, 109, 0)).toBe(0);
    w.setBlock(0, 109, 0, BLOCK.TORCH);
    expect(w.getLight(0, 109, 0) & 15).toBe(14);
    expect(w.getLight(3, 109, 0) & 15).toBe(11);
  });

  it('explosions leave bedrock, obsidian and liquids alone and report what they removed', () => {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 10; i++) w.update([{ x: 0, z: 0 }]);
    for (let y = 100; y < 106; y++) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.setBlock(x, y, z, BLOCK.STONE);
    w.setBlock(0, 103, 0, BLOCK.OBSIDIAN);
    const positions: number[] = [];
    const destroyed = w.explode(0.5, 103, 0.5, 3, positions);
    expect(destroyed.length).toBeGreaterThan(20);
    expect(positions.length).toBe(destroyed.length * 3);
    expect(w.getBlock(0, 103, 0)).toBe(BLOCK.OBSIDIAN);
  });
});

describe('ServerEntities', () => {
  it('day factor follows the sun like the client', () => {
    expect(dayFactorAt(0.25)).toBeCloseTo(1, 1);
    expect(dayFactorAt(0.75)).toBeCloseTo(0, 1);
  });

  it('spawns passive mobs around a player and sends them as snapshots', () => {
    const { ents, player, sent } = setup();
    for (let i = 0; i < 400; i++) ents.tick([player]);
    expect(ents.mobCount).toBeGreaterThan(0);
    const snap = sent.filter((s) => s.msg.t === 'ent');
    expect(snap.length).toBeGreaterThan(0);
  });

  it('ignores attacks that are out of reach and hits mobs that are close', () => {
    const { ents, player } = setup();
    for (let i = 0; i < 300; i++) ents.tick([player]);
    const mob = ents.manager.mobs.find((m) => !m.type.hostile)!;
    expect(mob).toBeDefined();
    const hp = mob.health;
    player.x = mob.x + 50;
    ents.attack(player, mob.netId);
    expect(mob.health).toBe(hp);
    player.x = mob.x + 1; player.y = mob.y; player.z = mob.z;
    ents.attack(player, mob.netId);
    expect(mob.health).toBe(hp - 1); // bare hand
  });

  it('lightning hurts and ignites mobs within 3 blocks, not further away', () => {
    const { ents, player } = setup();
    for (let i = 0; i < 300; i++) ents.tick([player]);
    const mobs = ents.manager.mobs.filter((m) => !m.type.hostile);
    expect(mobs.length).toBeGreaterThan(1);
    const [near, far] = mobs;
    const hpNear = near.health, hpFar = far.health;
    // Make sure the second mob is far from the strike.
    far.x = near.x + 30;
    ents.lightning(near.x + 1, near.y, near.z);
    expect(near.health).toBe(hpNear - 5);
    expect(near.burning).toBeGreaterThanOrEqual(160);
    expect(far.health).toBe(hpFar);
    expect(far.burning).toBe(0);
  });

  it('only shoots with a bow in hand and only ignites with flint and steel', () => {
    const { ents, player } = setup();
    ents.shoot(player, 0.5, 81.6, 0.5, 0, 0, 1, 1);
    expect(ents.manager.arrows.length).toBe(0);
    player.held = ITEM.BOW;
    ents.shoot(player, 0.5, 81.6, 0.5, 0, 0, 1, 1);
    expect(ents.manager.arrows.length).toBe(1);
    ents.shoot(player, 0.5, 81.6, 0.5, 0, 0, 1, 5); // impossible power
    expect(ents.manager.arrows.length).toBe(1);
    ents.world.update([{ x: 0, z: 0 }]);
    ents.world.setBlock(1, 80, 0, BLOCK.TNT);
    ents.ignite(player, 1, 80, 0);
    expect(ents.manager.tnt.length).toBe(0);
    player.held = ITEM.FLINT_AND_STEEL;
    ents.ignite(player, 1, 80, 0);
    expect(ents.manager.tnt.length).toBe(1);
  });

  it('hands a dropped item to the first player who is close enough', () => {
    const { ents, player, sent } = setup();
    ents.drop(player, { id: BLOCK.STONE, count: 3 }, 1, 81, 0.5, undefined, 0);
    const it = ents.manager.items[0];
    expect(it).toBeDefined();
    it.pickupDelay = 0;
    ents.take({ ...player, x: 40 }, it.netId);
    expect(sent.some((s) => s.msg.t === 'taken')).toBe(false);
    ents.take(player, it.netId);
    const got = sent.find((s) => s.msg.t === 'taken');
    expect(got?.msg).toMatchObject({ t: 'taken', itemId: BLOCK.STONE, count: 3 });
    ents.take(player, it.netId); // already gone
    expect(sent.filter((s) => s.msg.t === 'taken').length).toBe(1);
  });

  it('rejects dropping invalid or huge stacks', () => {
    const { ents, player } = setup();
    ents.drop(player, { id: 9999, count: 1 }, 1, 81, 0.5, undefined, 0);
    ents.drop(player, { id: BLOCK.STONE, count: 500 }, 1, 81, 0.5, undefined, 0);
    ents.drop(player, { id: BLOCK.STONE, count: 1 }, 500, 81, 0.5, undefined, 0);
    expect(ents.manager.items.length).toBe(0);
  });
});
