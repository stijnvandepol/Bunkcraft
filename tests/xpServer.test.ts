import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEntities } from '../server/ServerEntities';
import { EntityManager } from '../src/entities/EntityManager';
import { XpOrb, awardXp, mergeOrbs, ORB_LIFETIME } from '../src/entities/XpOrb';
import { ITEM, encodeData } from '../src/items/ItemRegistry';
import { type ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { KEY_A, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';
import { PlayerStats } from '../src/player/PlayerStats';

/** A flat test world: stone below y 64, air above. */
const flat = { getBlock: (_x: number, y: number) => (y < 64 ? BLOCK.STONE : BLOCK.AIR), getLight: () => 0xf0 };

describe('experience orbs (entities)', () => {
  it('merge when they lie close together and keep the total', () => {
    const orbs = [new XpOrb(3), new XpOrb(7), new XpOrb(1), new XpOrb(17)];
    orbs[0].setPosition(0, 64, 0);
    orbs[1].setPosition(0.3, 64, 0.2);
    orbs[2].setPosition(0.1, 64.4, 0);
    orbs[3].setPosition(5, 64, 5);
    expect(mergeOrbs(orbs)).toBe(2);
    expect(orbs[0].value).toBe(11);
    expect(orbs[3].removed).toBe(false);
    expect(orbs.filter((o) => !o.removed).reduce((a, o) => a + o.value, 0)).toBe(28);
  });

  it('fly to the player within 8 blocks and are collected; far ones stay', () => {
    const e = new EntityManager(flat, 1);
    e.hostileSpawning = false;
    e.passiveSpawning = false;
    let got = 0;
    e.xpPickup = (v) => { got += v; };
    awardXp(e, 4, 64.2, 0, 10);
    awardXp(e, 40, 64.2, 0, 5);
    const target = { x: 0, y: 64, z: 0, attackable: false };
    const events = { attack() {}, explode() {}, shoot() {}, arrowHit() {}, arrowImpact() {}, tntExplode() {}, killed() {}, playerArrowHit() {}, sound() {} };
    for (let i = 0; i < 200; i++) e.tick(target, 0, events, null, true);
    expect(got).toBe(10);
    expect(e.orbs.length).toBeGreaterThan(0);
    expect(e.orbs.every((o) => o.x > 30)).toBe(true);
  });

  it('despawn after five minutes', () => {
    const e = new EntityManager(flat, 1);
    e.hostileSpawning = false;
    e.passiveSpawning = false;
    e.spawnXp(100, 64.2, 100, 3);
    const target = { x: 0, y: 64, z: 0, attackable: false };
    const events = { attack() {}, explode() {}, shoot() {}, arrowHit() {}, arrowImpact() {}, tntExplode() {}, killed() {}, playerArrowHit() {}, sound() {} };
    for (let i = 0; i < ORB_LIFETIME + 5; i++) e.tick(target, 0, events, null, true);
    expect(e.orbs.length).toBe(0);
  });

  it('a mob the player killed drops experience', () => {
    const e = new EntityManager(flat, 1);
    e.hostileSpawning = false;
    e.passiveSpawning = false;
    const zombie = e.spawnMob('zombie', 20, 64, 20);
    zombie.hurt(100, 0, 0, 0, true);
    const target = { x: 0, y: 64, z: 0, attackable: false, collects: false };
    const events = { attack() {}, explode() {}, shoot() {}, arrowHit() {}, arrowImpact() {}, tntExplode() {}, killed() {}, playerArrowHit() {}, sound() {} };
    for (let i = 0; i < 3; i++) e.tick(target, 0, events, null, true);
    expect(e.orbs.reduce((a, o) => a + o.value, 0)).toBe(5);
  });
});

describe('experience in the saved stats', () => {
  it('stores the point total and the enchanting seed after the old five numbers', () => {
    const s = new PlayerStats();
    s.xp.add(500);
    s.enchantSeed = 1234;
    const saved = s.serialize();
    expect(saved.length).toBe(7);
    const t = new PlayerStats();
    t.load(saved);
    expect(t.xp.total).toBe(500);
    expect(t.enchantSeed).toBe(1234);
    // Old saves (5 numbers) start at zero.
    t.load([20, 20, 5, 0, 300]);
    expect(t.xp.total).toBe(0);
  });
});

describe('server: experience orbs over the network', () => {
  let t: TestServer;
  beforeAll(async () => { t = await startTestServer(); });
  afterAll(async () => { await t.stop(); cleanup(t.dir); });

  it('sends orbs, hands one to the player who asks and keeps the XP in the player record', async () => {
    const { code } = await createRoom(t.base, { gameMode: 'survival' });
    const { client, welcome } = await joinGame(t, code, 'Miner', { key: KEY_A });
    const sp = welcome.spawn;
    for (let i = 0; i < 3; i++) client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: ITEM.DIAMOND_SWORD });
    const room = t.server.rooms!.get(code)!;
    const entities = (room.server as unknown as { entities: ServerEntities }).entities;
    // Wait until the server knows where the player is, then drop 7 points right next to them.
    await new Promise((r) => setTimeout(r, 300));
    entities.manager.spawnXp(sp.x, sp.y + 0.3, sp.z, 7);
    const orbs = await client.waitFor('orbs', (m) => m.o.length > 0);
    const [id, value] = orbs.o[0];
    expect(value).toBe(7);
    client.send({ t: 'take', id });
    const gain = await client.waitFor('xpgain');
    expect(gain).toEqual({ t: 'xpgain', id, value: 7 });
    // Asking again gives nothing.
    client.send({ t: 'take', id });
    await new Promise((r) => setTimeout(r, 300));
    expect(client.messages.filter((m) => m.t === 'xpgain').length).toBe(1);
    // The client saves its stats with the experience; the record keeps them for the next join.
    client.send({ t: 'state', inventory: [], stats: [20, 20, 5, 0, 300, 7, 99] });
    await new Promise((r) => setTimeout(r, 200));
    client.close();
    await new Promise((r) => setTimeout(r, 300));
    const again = await joinGame(t, code, 'Miner', { key: KEY_A });
    expect(again.welcome.player?.stats?.[5]).toBe(7);
    again.client.close();
  });

  it('takes enchantments with an attack and clamps them', async () => {
    const { code } = await createRoom(t.base, { gameMode: 'survival' });
    const { client, welcome } = await joinGame(t, code, 'Fighter', { key: KEY_A });
    const sp = welcome.spawn;
    for (let i = 0; i < 3; i++) client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: ITEM.DIAMOND_SWORD });
    // Taking the sword restarts the attack cooldown (the server notices it on a tick): wait for a full charge, also on a loaded machine.
    await new Promise((r) => setTimeout(r, 1500));
    const entities = (t.server.rooms!.get(code)!.server as unknown as { entities: ServerEntities }).entities;
    const pig = entities.manager.spawnMob('pig', sp.x + 1.5, sp.y, sp.z);
    pig.persistent = true;
    const before = pig.health;
    // Sharpness 99 is clamped to V (+3), fire aspect sets it alight.
    client.send({ t: 'attack', id: pig.netId, e: encodeData({ sharpness: 99, fire_aspect: 2 }) });
    await new Promise((r) => setTimeout(r, 300));
    expect(before - pig.health).toBeGreaterThanOrEqual(7 + 3 - 0.001);
    expect(pig.igniteTicks + pig.health).toBeGreaterThan(0);
    client.close();
    const msg: ServerMessage | undefined = client.messages.find((m) => m.t === 'kick');
    expect(msg).toBeUndefined();
  });
});
