import { describe, expect, it } from 'vitest';
import { EntityManager } from '../src/entities/EntityManager';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { NetEntities } from '../src/net/NetEntities';
import { NET_MOB_KINDS, type ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';

type Ent = Extract<ServerMessage, { t: 'ent' }>;

function setup(): { em: EntityManager; net: NetEntities } {
  const world = { getBlock: () => BLOCK.AIR, getLight: () => 0xf0 };
  const em = new EntityManager(world, 1);
  return { em, net: new NetEntities(em) };
}

const none: Ent = { t: 'ent', m: [], i: [], a: [], b: [] };
// Mob entry: [id, kind, x, y, z, yaw, headYaw, headPitch, flags, hurtTime, fuse, deathTime]
const mob = (id: number, x: number, flags = 1, kind = 0): Ent['m'][number] => [id, kind, x, 70, 0, 0, 0.1, 0.2, flags, 0, 0, 0];

describe('NetEntities', () => {
  it('creates remote mobs from a snapshot with the right type and state, and removes the ones that vanish', () => {
    const { em, net } = setup();
    net.apply({ ...none, m: [mob(1, 5, 1 | 2, NET_MOB_KINDS.indexOf('zombie')), mob(2, 9, 4)] }, 0);
    expect(em.mobs).toHaveLength(2);
    const [z, dead] = em.mobs;
    expect(z.type).toBe(MOB_TYPES.zombie);
    expect(z.remote).toBe(true);
    expect(z.netId).toBe(1);
    expect(z.onGround).toBe(true);
    expect(z.burning).toBe(20);
    expect(z.health).toBe(MOB_TYPES.zombie.health);
    expect(dead.dead).toBe(true);
    net.apply({ ...none, m: [mob(1, 5)] }, 0.1);
    expect(dead.removed).toBe(true);
    expect(z.removed).toBe(false);
  });

  it('ignores unknown mob kinds instead of throwing', () => {
    const { em, net } = setup();
    expect(() => net.apply({ ...none, m: [mob(1, 0, 1, 99)] }, 0)).not.toThrow();
    expect(em.mobs).toHaveLength(0);
  });

  it('interpolates between two snapshots 150 ms in the past and blends yaw along the short way', () => {
    const { em, net } = setup();
    const a = mob(1, 0);
    const b = mob(1, 10);
    a[5] = Math.PI - 0.1; b[5] = -Math.PI + 0.1;
    net.apply({ ...none, m: [a] }, 1.0);
    net.apply({ ...none, m: [b] }, 1.1);
    net.update(1.15 + 0.05, 0.016); // render time 1.05: halfway
    const m = em.mobs[0];
    expect(m.x).toBeCloseTo(5, 5);
    expect(Math.abs(Math.cos(m.yaw) + 1)).toBeLessThan(1e-6); // halfway between ±π-ish is π, not 0
    net.update(5, 0.016); // far in the future: holds the newest
    expect(m.x).toBe(10);
  });

  it('mirrors items, arrows and TNT, updates counts, and removes them when they disappear', () => {
    const { em, net } = setup();
    net.apply({ ...none, i: [[1, BLOCK.DIRT, 3, 1, 70, 1]], a: [[2, 0, 70, 0, 1, 0.5, 0]], b: [[3, 2, 70, 2, 40]] }, 0);
    expect(em.items).toHaveLength(1);
    expect(em.arrows).toHaveLength(1);
    expect(em.tnt).toHaveLength(1);
    expect(em.items[0].stack).toMatchObject({ id: BLOCK.DIRT, count: 3 });
    expect(em.tnt[0].fuse).toBe(40);
    net.apply({ ...none, i: [[1, BLOCK.DIRT, 5, 1, 70, 1]], a: [[2, 0, 70, 0, 1, 0.5, 1]], b: [[3, 2, 70, 2, 10]] }, 0.1);
    expect(em.items[0].stack.count).toBe(5);
    expect(em.arrows[0].inGround).toBe(true);
    expect(em.tnt[0].fuse).toBe(10);
    net.apply(none, 0.2);
    expect([em.items[0], em.arrows[0], em.tnt[0]].every((e) => e.removed)).toBe(true);
  });

  it('throttles pickup requests per item and drops an item once the server hands it over', () => {
    const { em, net } = setup();
    net.apply({ ...none, i: [[7, BLOCK.DIRT, 1, 0, 70, 0]] }, 0);
    const item = em.items[0];
    expect(net.shouldTake(item, 10)).toBe(true);
    expect(net.shouldTake(item, 10.1)).toBe(false);
    expect(net.shouldTake(item, 10.4)).toBe(true);
    net.taken(7);
    expect(item.removed).toBe(true);
    expect(net.shouldTake(item, 20)).toBe(false);
    net.taken(7); // unknown now: no throw
  });

  it('clear removes every mirror', () => {
    const { em, net } = setup();
    net.apply({ ...none, m: [mob(1, 0)], i: [[1, BLOCK.DIRT, 1, 0, 70, 0]] }, 0);
    net.clear();
    expect(em.mobs.every((m) => m.removed)).toBe(true);
    expect(em.items.every((i) => i.removed)).toBe(true);
  });

  it('survives random snapshot sequences (never throws, tracks exactly the listed entities)', () => {
    const { em, net } = setup();
    let t = 0;
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 200; n++) {
      const ids = Array.from({ length: Math.floor(rnd() * 6) }, () => 1 + Math.floor(rnd() * 8));
      const unique = [...new Set(ids)];
      net.apply({ ...none, m: unique.map((id) => mob(id, rnd() * 50, 1, Math.floor(rnd() * NET_MOB_KINDS.length))) }, t);
      net.update(t + 0.1, 0.016);
      t += 0.1;
      const live = em.mobs.filter((m) => !m.removed).map((m) => m.netId).sort((a, b) => a - b);
      expect(live).toEqual(unique.sort((a, b) => a - b));
      for (let i = em.mobs.length - 1; i >= 0; i--) if (em.mobs[i].removed) em.mobs.splice(i, 1);
    }
  });
});
