/**
 * Multiplayer QA, protocol level, for the Minecraft (sandbox) game type. Starts its own throwaway server,
 * then plays it with WebSocket bots the way friends would: rooms, passwords, commands and moderation,
 * building together, drops and pickups, the survival inventory guard, mobs at night, TNT, inventory
 * persistence and a server restart.
 *
 *   npx tsx scripts/qa/mp-sandbox.ts [section ...]      sections: rooms mod edits drops guard mobs tnt persist restart pwlimit
 *   QA_PORT=3472 QA_DIR=/tmp/x npx tsx scripts/qa/mp-sandbox.ts guard
 *
 * Exit code = number of FAILed checks. Findings print as PASS / FAIL / INFO lines; the results also land in
 * $QA_DIR/sandbox-results.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ITEM, VARIANT_ITEM_BASE, getItemDef, itemFromState, itemId } from '../../src/items/ItemRegistry';
import { BLOCK, CUBE_ID, VARIANT_MASK, getBlockDef } from '../../src/world/BlockRegistry';
import { isValidMeta } from '../../src/world/BlockShapes';
import { NET_MOB_KINDS } from '../../src/net/protocol';
import { Bot, type ManagedServer, check, createRoom, info, metrics, results, sleep, startServer, summary, tryJoin } from './lib';

const PORT = Number(process.env.QA_PORT ?? 3472);
const DIR = process.env.QA_DIR ?? join(tmpdir(), `bunkqa-sandbox-${Date.now()}`);
let srv: ManagedServer;
const base = () => srv.base;

/** A fresh survival room with its owner and a friend standing at spawn. */
async function room(name: string, extra: Record<string, unknown> = {}, friends = 1, bin = false) {
  const r = await createRoom(base(), { name, gameMode: 'survival', seed: 'qa-sandbox', ...extra });
  const owner = new Bot('Owner' + name.replace(/\W/g, '').slice(0, 8));
  await owner.connect(base(), r.code, { owner: r.ownerToken, bin, password: extra.password as string | undefined });
  const others: Bot[] = [];
  for (let i = 0; i < friends; i++) {
    const b = new Bot(`Friend${i}${name.replace(/\W/g, '').slice(0, 6)}`);
    await b.connect(base(), r.code, { bin, password: extra.password as string | undefined });
    others.push(b);
  }
  const s = owner.welcome.spawn;
  for (const b of [owner, ...others]) b.pos(s.x, s.y, s.z);
  await sleep(150);
  return { code: r.code, token: r.ownerToken, owner, friends: others, spawn: s };
}

// ---------------------------------------------------------------- rooms, passwords, server list

async function rooms(): Promise<void> {
  const r = await createRoom(base(), { name: 'QA Locked', gameMode: 'survival', password: 'hunter2', listed: true });
  check('rooms: POST /api/rooms with password answers 201 + owner token', r.status === 201 && !!r.ownerToken && /^[A-Z2-9]{6}$/.test(r.code));
  const infoJ = (await (await fetch(`${base()}/api/rooms/${r.code}`)).json()) as Record<string, unknown>;
  check('rooms: lookup says locked, never the password', infoJ.locked === true && !JSON.stringify(infoJ).includes('hunter2'));
  const list = (await (await fetch(`${base()}/api/rooms?public=1`)).json()) as { rooms: { code: string; locked: boolean }[] };
  check('rooms: listed game shows up in Browse Games', list.rooms.some((x) => x.code === r.code && x.locked));
  const priv = await createRoom(base(), { name: 'QA Private', gameMode: 'survival' });
  await sleep(5200); // the list is cached for five seconds
  const list2 = (await (await fetch(`${base()}/api/rooms?public=1`)).json()) as { rooms: { code: string }[] };
  check('rooms: private game is not in Browse Games', !list2.rooms.some((x) => x.code === priv.code));

  const noPw = await tryJoin(new Bot('NoPassword'), base(), r.code);
  check('password: join without password is refused (code password)', !noPw.ok && noPw.kick.code === 'password', !noPw.ok ? noPw.kick.reason : '');
  const wrong = await tryJoin(new Bot('WrongPass'), base(), r.code, { password: 'nope' });
  check('password: wrong password is refused', !wrong.ok && /Wrong password/.test(wrong.kick.reason));
  const good = new Bot('RightPass');
  const ok = await tryJoin(good, base(), r.code, { password: 'hunter2' });
  check('password: right password gets in', ok.ok);
  const own = new Bot('LockOwner');
  const owned = await tryJoin(own, base(), r.code, { owner: r.ownerToken });
  check('password: owner token gets in without password and is op', owned.ok && own.welcome.op === true);
  const lookup = (await (await fetch(`${base()}/api/rooms/${r.code}`)).json()) as { players: number };
  check('rooms: player count in lookup follows joins', lookup.players === 2, `players=${lookup.players}`);
  good.close(); own.close();

  const missing = await fetch(`${base()}/api/rooms/ZZZZZZ`);
  check('rooms: unknown code answers 404 with a readable error', missing.status === 404);
  const bad = await tryJoin(new Bot('Ghost'), base(), 'ZZZZZZ');
  check('rooms: websocket to an unknown room is refused', !bad.ok, !bad.ok ? bad.kick.reason : '');
}

// ---------------------------------------------------------------- commands and moderation

async function mod(): Promise<void> {
  const { code, token, owner, friends: [friend, third] } = await room('Mod', {}, 2);
  let t = performance.now();
  owner.chat('/help');
  friend.chat('/help');
  await sleep(400);
  const oh = owner.sys(t).find((s) => s.startsWith('Commands:')) ?? '';
  const fh = friend.sys(t).find((s) => s.startsWith('Commands:')) ?? '';
  check('/help: owner sees moderation commands', /\/kick/.test(oh) && /\/op/.test(oh), oh);
  check('/help: friend only sees public commands', !/\/kick/.test(fh) && /\/list/.test(fh), fh);

  t = performance.now();
  friend.chat('/time set night');
  await sleep(1100);
  check('/time: friend without op is refused', friend.sys(t).some((s) => /permission/.test(s)));
  t = performance.now();
  owner.chat('/time set night');
  const tm = await friend.waitFor('time', (m) => Math.abs(m.time - 0.55) < 0.01, 2000, t);
  check('/time set night reaches every player', !!tm, tm ? `time=${tm.time}` : 'no time message');
  await sleep(1100);
  t = performance.now();
  owner.chat('/weather rain');
  const w = await friend.waitFor('weather', (m) => m.rain === 1, 2000, t);
  check('/weather rain reaches every player (docs call it a stub)', !!w, w ? JSON.stringify(w) : owner.sys(t).join(' | '));

  await sleep(1100);
  t = performance.now();
  owner.chat(`/op ${friend.name}`);
  await sleep(300);
  check('/op: friend is told', friend.sys(t).some((s) => /now an operator/.test(s)));
  t = performance.now();
  friend.chat('/time set day');
  const tm2 = await third.waitFor('time', (m) => Math.abs(m.time - 0.04) < 0.01, 2000, t);
  check('/op: friend can now use /time', !!tm2);
  await sleep(1100);
  t = performance.now();
  friend.chat(`/kick ${owner.name}`);
  await sleep(300);
  check('op cannot kick the owner', friend.sys(t).some((s) => /owner/.test(s)), friend.sys(t).join(' | '));
  owner.chat(`/deop ${friend.name}`);
  await sleep(1100);

  // Kick: the player gets a reason and can come back.
  t = performance.now();
  owner.chat(`/kick ${third.name} spamming`);
  const k = await third.waitFor('kick', () => true, 2000, t);
  check('/kick: player receives kick with reason', !!k && /spamming/.test(k.reason), k?.reason);
  check('/kick: everyone sees who was kicked', friend.sys(t).some((s) => /was kicked/.test(s)));
  const back = new Bot(third.name, third.key);
  check('/kick: kicked player can rejoin', (await tryJoin(back, base(), code)).ok);
  await sleep(1100);

  // Ban: by name and (because the player was online) by address. All bots share 127.0.0.1.
  t = performance.now();
  owner.chat(`/ban ${back.name} griefing`);
  const bk = await back.waitFor('kick', () => true, 2000, t);
  check('/ban: player is kicked with the reason', !!bk && /griefing/.test(bk.reason), bk?.reason);
  const again = await tryJoin(new Bot(back.name, back.key), base(), code);
  check('/ban: banned name cannot rejoin (code banned)', !again.ok && again.kick.code === 'banned');
  const sameIp = await tryJoin(new Bot('Householdmate'), base(), code);
  check('/ban: someone else on the same IP is also refused (documented; affects a household)', !sameIp.ok && sameIp.kick.code === 'banned',
    !sameIp.ok ? sameIp.kick.reason : 'was let in');
  const ownerAgain = new Bot(owner.name, owner.key);
  check('/ban: the owner (same IP) is never locked out', (await tryJoin(ownerAgain, base(), code, { owner: token })).ok);
  // That re-login replaced the original owner session ("logged in from another location").
  const replaced = await owner.waitFor('kick', (m) => /another location/.test(m.reason), 1500);
  check('second login with the same name replaces the first session', !!replaced);
  await sleep(1100);
  t = performance.now();
  ownerAgain.chat(`/unban ${back.name}`);
  await sleep(400);
  check('/unban: confirms', ownerAgain.sys(t).some((s) => /Unbanned/.test(s)));
  const unb = new Bot(back.name, back.key);
  check('/unban: player can join again', (await tryJoin(unb, base(), code)).ok);

  // Identity: the same name from another browser (another key) is refused.
  const imp = await tryJoin(new Bot(friend.name), base(), code);
  check('identity: name claimed by another browser is refused', !imp.ok && imp.kick.code === 'identity');

  // Whitelist.
  await sleep(1100);
  ownerAgain.chat('/whitelist on');
  await sleep(300);
  const wl = await tryJoin(new Bot('Stranger1'), base(), code);
  check('/whitelist on: unlisted newcomer is refused', !wl.ok && wl.kick.code === 'whitelist');
  await sleep(1100);
  ownerAgain.chat('/whitelist off');
  await sleep(300);

  // /give is creative only, /gamemode and /tp.
  await sleep(1100);
  t = performance.now();
  ownerAgain.chat(`/give ${friend.name} diamond 5`);
  await sleep(300);
  check('/give refused in survival', ownerAgain.sys(t).some((s) => /creative/.test(s)));
  await sleep(1100);
  t = performance.now();
  ownerAgain.chat('/gamemode creative');
  const gm = await friend.waitFor('gamemode', (m) => m.mode === 'creative', 2000, t);
  check('/gamemode creative reaches every player', !!gm);
  await sleep(1100);
  ownerAgain.chat('/gamemode survival');
  await sleep(1100);
  friend.pos(friend.x + 3, friend.y, friend.z);
  await sleep(100);
  t = performance.now();
  ownerAgain.chat(`/tp ${friend.name}`);
  const tp = await ownerAgain.waitFor('teleport', () => true, 2000, t);
  check('/tp <name> moves the op to the player', !!tp && Math.abs(tp.x - friend.x) < 0.01, tp ? JSON.stringify(tp) : '');
  await sleep(1100);
  t = performance.now();
  friend.chat('/spawn');
  const sp = await friend.waitFor('teleport', () => true, 2000, t);
  check('/spawn works for everyone', !!sp);
  t = performance.now();
  await sleep(1100);
  friend.chat('/nonsense');
  await sleep(300);
  check('unknown command gets a helpful reply', friend.sys(t).some((s) => /Unknown command/.test(s)));
  for (const b of [ownerAgain, friend, unb]) b.close();
}

// ---------------------------------------------------------------- building together

async function edits(): Promise<void> {
  const { owner, friends: [friend], spawn, code } = await room('Edits');
  const x = Math.floor(spawn.x) + 2, y = Math.floor(spawn.y) + 1, z = Math.floor(spawn.z);
  let t = performance.now();
  owner.block(x, y, z, BLOCK.COBBLESTONE);
  const seen = await friend.waitFor('block', (m) => m.x === x && m.y === y && m.z === z && m.id === BLOCK.COBBLESTONE, 2000, t);
  check('edits: placed block reaches the other player', !!seen, seen ? `${Math.round(seen.at - t)} ms` : '');
  check('edits: the placer gets no echo of its own edit', !owner.of('block', t).some((m) => m.x === x && m.y === y && m.z === z));
  t = performance.now();
  const s1 = owner.block(x + 30, y, z, BLOCK.STONE);
  const s2 = owner.block(x, 0, z, 0);
  const s3 = owner.block(x, y + 1, z, BLOCK.BEDROCK);
  await sleep(400);
  const rej = owner.of('reject', t).map((r) => r.seq);
  check('edits: out-of-reach, y=0 and bedrock edits are rejected (client rolls back)', [s1, s2, s3].every((s) => rej.includes(s)), `rejected seqs ${rej.join(',')}`);
  check('edits: rejected edits never reach others', !friend.of('block', t).some((m) => m.x === x + 30 || m.y === 0));

  // Burst: a fast builder (creative fly-building) — 60 edits at once.
  await sleep(2100);
  t = performance.now();
  const seqs: number[] = [];
  for (let i = 0; i < 60; i++) seqs.push(owner.block(x - 2 + (i % 5), y + 2 + Math.floor(i / 25), z - 2 + (Math.floor(i / 5) % 5), BLOCK.STONE));
  await sleep(600);
  const burstRej = owner.of('reject', t).length;
  info('edits: rate limit on a 60-edit burst', `${burstRej} of 60 rejected (bucket 20/s, burst 40)`);

  // Conflict: both players change the same block at the same moment.
  await sleep(2500);
  const cx = x - 1, cy = y, cz = z + 2;
  t = performance.now();
  owner.block(cx, cy, cz, BLOCK.STONE);
  friend.block(cx, cy, cz, BLOCK.GLASS);
  await sleep(600);
  // What each client ends up showing = its own edit, overwritten by any broadcast that arrived after it.
  const ownerView = owner.of('block', t).filter((m) => m.x === cx && m.y === cy && m.z === cz).at(-1)?.id ?? BLOCK.STONE;
  const friendView = friend.of('block', t).filter((m) => m.x === cx && m.y === cy && m.z === cz).at(-1)?.id ?? (BLOCK.GLASS);
  const late = new Bot('LateJoiner');
  await late.connect(base(), code);
  const e = late.welcome.edits;
  let serverView = -1;
  for (let i = 0; i + 4 < e.length; i += 5) if (e[i] === cx && e[i + 1] === cy && e[i + 2] === cz) serverView = e[i + 3];
  check('edits: simultaneous edits of one block end the same for everyone',
    ownerView === friendView && friendView === serverView, `owner sees ${ownerView}, friend sees ${friendView}, server/late joiner ${serverView}`);
  for (const b of [owner, friend, late]) b.close();
}

// ---------------------------------------------------------------- drops and pickups

async function drops(): Promise<void> {
  const { owner, friends: [friend], spawn } = await room('Drops');
  const x = Math.floor(spawn.x) + 2, y = Math.floor(spawn.y) + 1, z = Math.floor(spawn.z);
  owner.block(x, y - 1, z, BLOCK.STONE); // a table so the drop does not roll into the ravine next to spawn
  owner.block(x, y, z, BLOCK.STONE);
  await sleep(200);
  let t = performance.now();
  owner.block(x, y, z, 0);
  owner.send({ t: 'drop', id: BLOCK.COBBLESTONE, count: 1, x: x + 0.5, y: y + 0.25, z: z + 0.5, delay: 10 });
  const ent = await friend.waitFor('ent', (m) => m.i.some((i) => i[1] === BLOCK.COBBLESTONE), 2000, t);
  check('drops: a broken block\'s drop is visible to the other player', !!ent);
  if (!ent) return;
  const item = ent.i.find((i) => i[1] === BLOCK.COBBLESTONE)!;
  await sleep(800); // pickup delay 10 ticks, and let it settle
  const last = friend.of('ent').at(-1)!.i.find((i) => i[0] === item[0]) ?? item;
  // Both walk onto it; the friend is a few ms faster.
  friend.pos(last[3], last[4], last[5]);
  owner.pos(last[3], last[4], last[5]);
  await sleep(100);
  t = performance.now();
  friend.send({ t: 'take', id: item[0] });
  owner.send({ t: 'take', id: item[0] });
  await sleep(500);
  const ft = friend.of('taken', t), ot = owner.of('taken', t);
  check('drops: exactly one player gets the item (first asker)', ft.length + ot.length === 1, `friend ${ft.length}, breaker ${ot.length}`);
  info('drops: who gets a drop', 'whoever sends `take` first; the client auto-requests within 1 block, so the breaker has no priority (Minecraft: anyone nearby)');
  await sleep(300);
  check('drops: picked-up item disappears for both', !friend.of('ent').at(-1)?.i.some((i) => i[0] === item[0]) && !owner.of('ent').at(-1)?.i.some((i) => i[0] === item[0]));
  // The friend now really has it: the inventory guard must accept the state.
  t = performance.now();
  friend.send({ t: 'state', inventory: [[BLOCK.COBBLESTONE, 1, 0]], stats: [20, 20, 5, 300] });
  await sleep(500);
  check('drops: inventory with the picked-up item is accepted', friend.of('state', t).length === 0);
  // Q-drop and re-pickup by someone else.
  t = performance.now();
  friend.send({ t: 'drop', id: BLOCK.COBBLESTONE, count: 1, x: friend.x, y: friend.y + 1.3, z: friend.z, yaw: 0, delay: 40 });
  const qd = await owner.waitFor('ent', (m) => m.i.some((i) => i[1] === BLOCK.COBBLESTONE), 2000, t);
  check('drops: Q-drop of a held item is visible to others', !!qd);
  t = performance.now();
  friend.send({ t: 'drop', id: BLOCK.COBBLESTONE, count: 1, x: friend.x, y: friend.y + 1.3, z: friend.z, yaw: 0, delay: 40 });
  await sleep(500);
  const dup = owner.of('ent').at(-1)?.i.filter((i) => i[1] === BLOCK.COBBLESTONE).length ?? 0;
  check('drops: dropping the same stack twice does not duplicate it', dup <= 1, `${dup} cobblestone entities`);
  owner.close(); friend.close();
}

// ---------------------------------------------------------------- inventory guard (survival)

/** Places a block (no inventory needed by the server), breaks it and drops `count` of `item` like the client would. */
async function breakAndDrop(b: Bot, other: Bot, x: number, y: number, z: number, block: number, meta: number, item: number, count: number): Promise<boolean> {
  b.block(x, y, z, block, meta);
  await sleep(60);
  const t = performance.now();
  b.block(x, y, z, 0);
  b.send({ t: 'drop', id: item, count, x: x + 0.5, y: y + 0.25, z: z + 0.5, delay: 10 });
  const seen = await other.waitFor('ent', (m) => m.i.some((i) => i[1] === item && i[2] === count), 700, t);
  // Clean up: let the bot take it so the next round starts with an empty floor.
  if (seen) {
    const it = seen.i.find((i) => i[1] === item && i[2] === count)!;
    await sleep(600);
    b.pos(it[3], it[4], it[5]);
    b.send({ t: 'take', id: it[0] });
    await sleep(150);
  }
  return !!seen;
}

function variantBlock(): { id: number; meta: number; item: number; name: string } {
  for (const name of ['wool', 'concrete', 'terracotta']) {
    const id = CUBE_ID[name] ?? (name === 'wool' ? BLOCK.WOOL : 0);
    if (!id || !VARIANT_MASK[id]) continue;
    for (let m = 1; m < 16; m++) if ((m & VARIANT_MASK[id]) && isValidMeta(id, m)) return { id, meta: m, item: itemFromState(id, m), name: getBlockDef(id)!.name };
  }
  for (let id = 1; id < 256; id++) {
    if (!VARIANT_MASK[id]) continue;
    for (let m = 1; m < 16; m++) if ((m & VARIANT_MASK[id]) && isValidMeta(id, m)) return { id, meta: m, item: itemFromState(id, m), name: getBlockDef(id)!.name };
  }
  throw new Error('no variant block');
}

async function guard(): Promise<void> {
  const { owner, friends: [friend], spawn } = await room('Guard');
  const x = Math.floor(spawn.x) + 2, y = Math.floor(spawn.y) + 2, z = Math.floor(spawn.z);
  owner.pos(spawn.x, spawn.y, spawn.z);
  owner.block(x, y - 1, z, BLOCK.STONE); // table for the drops

  // 1. Random-count ore drops: the server credits its OWN random roll, the client drops ITS roll.
  const lapis = CUBE_ID.lapis_ore, lapisItem = itemId('lapis_lazuli');
  let low = 0;
  for (let i = 0; i < 4; i++) if (await breakAndDrop(owner, friend, x, y, z, lapis, 0, lapisItem, 4)) low++;
  check('guard: control — lapis drop of 4 (the minimum roll) is accepted', low === 4, `${low}/4`);
  const tally: Record<number, string> = {};
  let lost = 0, tries = 0;
  for (const c of [5, 6, 7, 8, 9, 9, 9, 9]) {
    const ok = await breakAndDrop(owner, friend, x, y, z, lapis, 0, lapisItem, c);
    tries++;
    if (!ok) lost++;
    tally[c] = (tally[c] ?? '') + (ok ? '✓' : '✗');
    await sleep(120);
  }
  check('guard: lapis ore drops of 5–9 (legal client rolls) are accepted', lost === 0,
    `${tries - lost}/${tries} accepted; per count ${JSON.stringify(tally)} — the server credits its own independent roll`);

  // 2. Leaves → sapling (5 %): the server only credits a sapling when its own roll also hit.
  let saplingOk = 0;
  const sapling = itemFromState(BLOCK.SAPLING, 0);
  for (let i = 0; i < 6; i++) if (await breakAndDrop(owner, friend, x, y, z, BLOCK.OAK_LEAVES, 0, sapling, 1)) saplingOk++;
  check('guard: sapling dropped from broken oak leaves is accepted', saplingOk === 6, `${saplingOk}/6 accepted`);

  // 3. Coloured blocks: the credit is for the block id without its colour (meta).
  const v = variantBlock();
  const vOk = await breakAndDrop(owner, friend, x, y, z, v.id, v.meta, v.item, 1);
  check(`guard: drop of a coloured block (${v.name} meta ${v.meta}, item ${v.item}) is accepted`, vOk, `variant base ${VARIANT_ITEM_BASE}`);

  // 4. Creating items from nothing: place a block the player does not have, break it, pick up the drop.
  await sleep(500);
  let t = performance.now();
  const before = owner.of('taken').length;
  const got = await breakAndDrop(owner, friend, x, y, z, BLOCK.DIAMOND_ORE, 0, ITEM.DIAMOND, 1);
  await sleep(300);
  const tookDiamond = owner.of('taken').slice(before).some((m) => m.itemId === ITEM.DIAMOND);
  t = performance.now();
  owner.send({ t: 'state', inventory: [[ITEM.DIAMOND, 1, 0]], stats: [20, 20, 5, 300] });
  await sleep(500);
  const corrected = owner.of('state', t).length > 0;
  check('guard: placing a block you do not own (diamond ore) and mining it does NOT create a diamond',
    !(got && tookDiamond && !corrected), `drop spawned=${got}, taken=${tookDiamond}, inventory corrected=${corrected}`);

  // 5. Items that change without a pickup or recipe: buckets, stew bowls; plus armor and tool wear.
  await bucketAndStew(owner);
  owner.close(); friend.close();
}

/** Uses /gamemode to give the owner a baseline (creative → survival trusts the next state), then mimics real actions. */
async function bucketAndStew(owner: Bot): Promise<void> {
  const stats = [20, 20, 5, 300];
  const sequence = async (label: string, start: number[][], after: number[][]) => {
    owner.chat('/gamemode creative');
    await sleep(1100);
    owner.send({ t: 'state', inventory: start, stats });
    await sleep(300);
    owner.chat('/gamemode survival');
    await sleep(1100);
    let t = performance.now();
    owner.send({ t: 'state', inventory: start, stats }); // becomes the trusted baseline
    await sleep(400);
    const base = owner.of('state', t).length === 0;
    t = performance.now();
    owner.send({ t: 'state', inventory: after, stats });
    const corr = await owner.waitFor('state', () => true, 1200, t);
    check(`guard: ${label} is accepted`, base && !corr, corr ? `server corrected: "${corr.reason}" → ${JSON.stringify(corr.inventory)}` : '');
    await sleep(2100);
  };
  await sequence('scooping water (bucket → water bucket)', [[ITEM.BUCKET, 1, 0]], [[ITEM.WATER_BUCKET, 1, 0]]);
  await sequence('pouring water (water bucket → bucket)', [[ITEM.WATER_BUCKET, 1, 0]], [[ITEM.BUCKET, 1, 0]]);
  await sequence('eating mushroom stew (stew → bowl)', [[itemId('mushroom_stew'), 1, 0]], [[itemId('bowl'), 1, 0]]);
  await sequence('wearing armor (slot 0 → armor slot 37)', [[itemId('iron_chestplate'), 1, 0]],
    [...Array.from({ length: 36 }, () => [0, 0]), [0, 0], [itemId('iron_chestplate'), 1, 0], [0, 0], [0, 0]]);
  await sequence('tool wear (pickaxe damage 0 → 5)', [[ITEM.DIAMOND_PICKAXE, 1, 0]], [[ITEM.DIAMOND_PICKAXE, 1, 5]]);
}

// ---------------------------------------------------------------- mobs at night

async function mobs(): Promise<void> {
  const { owner, friends: [friend], spawn } = await room('Mobs');
  for (const b of [owner, friend]) { b.held = ITEM.DIAMOND_SWORD; b.autoPos(100); }
  friend.x += 1.5;
  owner.chat('/time set midnight');
  console.log('      (waiting 40 s for night spawns)');
  const t0 = performance.now();
  await sleep(40_000);
  const oe = owner.of('ent', t0), fe = friend.of('ent', t0);
  info('mobs: entity snapshot rate', `owner ${(oe.length / 40).toFixed(1)}/s, friend ${(fe.length / 40).toFixed(1)}/s (expected 10)`);
  const lastO = oe.at(-1), lastF = fe.at(-1);
  if (!lastO || !lastF) { check('mobs: both players receive mob snapshots', false); return; }
  const kinds = (m: typeof lastO.m) => m.reduce<Record<string, number>>((a, e) => { const k = NET_MOB_KINDS[e[1]]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  info('mobs: what the owner sees at midnight', JSON.stringify(kinds(lastO.m)));
  // Same mobs: compare ids within 40 blocks of both (both stand 1.5 blocks apart; send radius is 64).
  const near = (m: typeof lastO.m) => new Set(m.filter((e) => Math.hypot(e[2] - spawn.x, e[4] - spawn.z) < 40).map((e) => e[0]));
  const so = near(lastO.m), sf = near(lastF.m);
  const inter = [...so].filter((i) => sf.has(i)).length;
  check('mobs: both players see the same mobs', so.size > 0 && inter >= Math.min(so.size, sf.size) - 1, `owner ${so.size}, friend ${sf.size}, shared ${inter}`);
  const posDiff = lastO.m.filter((e) => sf.has(e[0])).map((e) => {
    const f = lastF.m.find((x) => x[0] === e[0])!;
    return Math.hypot(e[2] - f[2], e[3] - f[3], e[4] - f[4]);
  });
  info('mobs: position difference of the same mob between the two players', `max ${Math.max(0, ...posDiff).toFixed(2)} blocks (snapshots ${Math.abs(lastO.at - lastF.at).toFixed(0)} ms apart)`);
  const hurts = [...owner.of('hurt', t0), ...friend.of('hurt', t0)];
  info('mobs: damage messages to players in 40 s', `${hurts.length} (${[...new Set(hurts.map((h) => h.by))].join(', ')})`);
  check('mobs: hostile mobs attack players and the server tells them (hurt)', hurts.length > 0);

  // Fight: both players hit the nearest hostile until it dies.
  const hostile = new Set(['zombie', 'skeleton', 'spider', 'creeper']);
  const cur = owner.of('ent').at(-1)!;
  const target = cur.m.filter((e) => hostile.has(NET_MOB_KINDS[e[1]]) && !(e[8] & 4))
    .sort((a, b) => Math.hypot(a[2] - owner.x, a[4] - owner.z) - Math.hypot(b[2] - owner.x, b[4] - owner.z))[0];
  if (!target) { info('mobs: fight', 'no hostile near'); }
  else {
    const id = target[0];
    const t1 = performance.now();
    let dead = false, hurtSeenBy = new Set<string>();
    for (let i = 0; i < 40 && !dead; i++) {
      const m = owner.of('ent').at(-1)!.m.find((e) => e[0] === id);
      if (!m) break;
      // Stand right next to it (both players), then swing.
      for (const b of [owner, friend]) { b.x = m[2] + (b === owner ? 1 : -1); b.y = m[3]; b.z = m[4]; b.pos(); }
      await sleep(60);
      (i % 2 ? friend : owner).send({ t: 'attack', id });
      await sleep(320);
      for (const [b, n] of [[owner, 'owner'], [friend, 'friend']] as const) if (b.of('ent').at(-1)?.m.find((e) => e[0] === id)?.[9]) hurtSeenBy.add(n);
      const now = owner.of('ent').at(-1)!.m.find((e) => e[0] === id);
      dead = !now || !!(now[8] & 4);
    }
    const sounds = [...owner.of('msound', t1), ...friend.of('msound', t1)].filter((s) => s.event === 'hurt' || s.event === 'death');
    check(`mobs: two players can kill a ${NET_MOB_KINDS[target[1]]} together`, dead, `hurt flash seen by ${[...hurtSeenBy].join('+') || 'nobody'}, ${sounds.length} hurt/death sounds`);
    check('mobs: both players see the hurt flash', hurtSeenBy.size === 2);
    await sleep(1500);
    const drop = owner.of('ent').at(-1)?.i ?? [];
    info('mobs: loot after the kill', drop.length ? drop.map((i) => `${getItemDef(i[1])?.name}×${i[2]}`).join(', ') : 'no item entities nearby');
  }
  owner.stopAuto(); friend.stopAuto();
  owner.close(); friend.close();
}

// ---------------------------------------------------------------- TNT

async function tnt(): Promise<void> {
  const { owner, friends: [friend], spawn, code } = await room('Tnt');
  const x = Math.floor(spawn.x) + 3, y = Math.floor(spawn.y) - 1, z = Math.floor(spawn.z);
  // A stone floor: primed TNT falls, and next to this spawn is a ravine (TNT in water breaks nothing).
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) owner.block(x + dx, y - 1, z + dz, BLOCK.STONE);
  await sleep(2100);
  owner.block(x, y, z, BLOCK.TNT);
  for (let dx = -1; dx <= 1; dx++) owner.block(x + dx, y + 1, z + 1, BLOCK.STONE);
  await sleep(300);
  owner.held = ITEM.FLINT_AND_STEEL;
  owner.pos();
  await sleep(100);
  const t = performance.now();
  owner.send({ t: 'ignite', x, y, z });
  const lit = await friend.waitFor('ent', (m) => m.b.length > 0, 2000, t);
  check('tnt: lit TNT entity is visible to the other player', !!lit);
  const gone = await friend.waitFor('block', (m) => m.x === x && m.y === y && m.z === z && m.id === 0, 1000, t);
  check('tnt: the TNT block turns into air for the other player', !!gone);
  const boomO = await owner.waitFor('boom', () => true, 6000, t);
  const boomF = await friend.waitFor('boom', () => true, 1000, t);
  check('tnt: both players get the explosion', !!boomO && !!boomF, boomO ? `fuse ${(boomO.at - t).toFixed(0)} ms, ${boomO.blocks.length / 3} blocks` : '');
  await sleep(500);
  const late = new Bot('AfterBoom');
  await late.connect(base(), code);
  const removed = new Set<string>();
  const e = late.welcome.edits;
  for (let i = 0; i + 4 < e.length; i += 5) if (e[i + 3] === 0) removed.add(`${e[i]},${e[i + 1]},${e[i + 2]}`);
  const destroyed = boomO?.blocks ?? [];
  let persisted = 0;
  for (let i = 0; i + 2 < destroyed.length; i += 3) if (removed.has(`${destroyed[i]},${destroyed[i + 1]},${destroyed[i + 2]}`)) persisted++;
  check('tnt: the crater is stored (a late joiner sees it)', destroyed.length > 0 && persisted === destroyed.length / 3, `${persisted}/${destroyed.length / 3}`);
  const hurts = [...owner.of('hurt', t)];
  info('tnt: player damage', `client computes its own explosion damage from 'boom' (server sent ${hurts.length} hurt messages)`);
  owner.close(); friend.close(); late.close();
}

// ---------------------------------------------------------------- persistence

async function persist(): Promise<void> {
  // Creative game: inventory with armor rows and item data round-trips through a reconnect.
  const r = await createRoom(base(), { name: 'Persist', gameMode: 'creative', seed: 'qa' });
  const a = new Bot('Keeper');
  await a.connect(base(), r.code, { owner: r.ownerToken });
  a.pos(a.x + 1, a.y, a.z);
  const inv: number[][] = Array.from({ length: 40 }, () => [0, 0, 0]);
  inv[0] = [ITEM.DIAMOND_SWORD, 1, 12];
  inv[1] = [BLOCK.COBBLESTONE, 64, 0];
  inv[37] = [itemId('iron_chestplate'), 1, 3];
  inv[36] = [itemId('iron_helmet'), 1, 0];
  a.send({ t: 'state', inventory: inv, stats: [17, 15, 2.5, 300] });
  await sleep(400);
  a.close();
  await sleep(400);
  const b = new Bot('Keeper', a.key);
  await b.connect(base(), r.code, { owner: r.ownerToken });
  const rec = b.welcome.player;
  check('persist: position comes back after a reconnect', !!rec && Math.abs(rec.x - a.x) < 0.01, rec ? `${rec.x.toFixed(2)},${rec.z.toFixed(2)}` : 'no record');
  const back = rec?.inventory ?? [];
  const same = [0, 1, 36, 37].every((i) => JSON.stringify(back[i]?.slice(0, 3)) === JSON.stringify(inv[i]));
  check('persist: inventory incl. armor and tool damage comes back', same, JSON.stringify([0, 1, 36, 37].map((i) => back[i])));
  check('persist: health/hunger come back', JSON.stringify(rec?.stats) === JSON.stringify([17, 15, 2.5, 300]), JSON.stringify(rec?.stats));
  b.close();

  // Survival: a legitimately picked-up item survives a reconnect and is not "corrected" afterwards.
  const g = await room('PersistSurv');
  const p = g.owner;
  const x = Math.floor(g.spawn.x) + 2, y = Math.floor(g.spawn.y) + 1, z = Math.floor(g.spawn.z);
  p.block(x, y - 1, z, BLOCK.STONE);
  p.block(x, y, z, BLOCK.STONE);
  await sleep(100);
  await breakAndDrop(p, g.friends[0], x, y, z, BLOCK.STONE, 0, BLOCK.COBBLESTONE, 1);
  await sleep(200);
  p.send({ t: 'state', inventory: [[BLOCK.COBBLESTONE, 1, 0]], stats: [20, 20, 5, 300] });
  await sleep(400);
  p.close();
  await sleep(300);
  const p2 = new Bot(p.name, p.key);
  await p2.connect(base(), g.code, { owner: g.token });
  check('persist: survival inventory comes back after reconnect', JSON.stringify(p2.welcome.player?.inventory?.[0]?.slice(0, 2)) === JSON.stringify([BLOCK.COBBLESTONE, 1]));
  p2.pos();
  const t = performance.now();
  p2.send({ t: 'state', inventory: [[BLOCK.COBBLESTONE, 1, 0]], stats: [20, 20, 5, 300] });
  await sleep(500);
  check('persist: unchanged inventory after reconnect is not corrected', p2.of('state', t).length === 0);
  // Death: everything is dropped, the respawned (empty) inventory is accepted.
  const t2 = performance.now();
  p2.send({ t: 'drop', id: BLOCK.COBBLESTONE, count: 1, x: p2.x, y: p2.y + 1, z: p2.z, delay: 40 });
  await sleep(200);
  p2.send({ t: 'state', inventory: [], stats: [20, 20, 5, 300] });
  await sleep(500);
  const deathDrop = await g.friends[0].waitFor('ent', (m) => m.i.some((i) => i[1] === BLOCK.COBBLESTONE), 1000, t2);
  check('persist: death drops appear for others and the empty inventory is accepted', !!deathDrop && p2.of('state', t2).length === 0);
  p2.close(); g.friends[0].close();
}

// ---------------------------------------------------------------- restart

async function restart(): Promise<void> {
  const g = await room('Restart');
  const [friend] = g.friends;
  const x = Math.floor(g.spawn.x) + 2, y = Math.floor(g.spawn.y) + 1, z = Math.floor(g.spawn.z);
  g.owner.block(x, y, z, BLOCK.GLASS);
  g.owner.chat(`/op ${friend.name}`);
  friend.pos(g.spawn.x + 4, g.spawn.y, g.spawn.z + 4);
  await sleep(500);
  const t = performance.now();
  const code = await srv.stop('SIGTERM');
  const kick = await friend.waitFor('kick', () => true, 100, t);
  check('restart: players get "Server restarting" with a reconnect hint', !!kick && !!kick.reconnect, kick ? JSON.stringify(kick) : 'no kick message');
  check('restart: socket closes with 1012 (service restart)', friend.closeCode === 1012, `close code ${friend.closeCode}, exit ${code}`);
  srv = await startServer(PORT, DIR);
  const f2 = new Bot(friend.name, friend.key);
  await f2.connect(base(), g.code);
  const e = f2.welcome.edits;
  let found = false;
  for (let i = 0; i + 4 < e.length; i += 5) if (e[i] === x && e[i + 1] === y && e[i + 2] === z) found = true;
  check('restart: the build is still there', found);
  check('restart: the player comes back at his last position', !!f2.welcome.player && Math.abs(f2.welcome.player.x - (g.spawn.x + 4)) < 0.01);
  check('restart: op rights survive the restart', f2.welcome.op === true);
  f2.close();
}

// ---------------------------------------------------------------- password brute-force limit (pollutes 127.0.0.1 for 10 min: run last)

async function pwlimit(): Promise<void> {
  const r = await createRoom(base(), { name: 'Brute', gameMode: 'survival', password: 'correct-horse' });
  for (let i = 0; i < 5; i++) await tryJoin(new Bot(`Brute${i}`), base(), r.code, { password: `wrong${i}` });
  const res = await tryJoin(new Bot('BruteOk'), base(), r.code, { password: 'correct-horse' });
  check('password: after 5 wrong tries even the right password is refused for a while', !res.ok && /Too many/.test(res.kick.reason), !res.ok ? res.kick.reason : 'let in');
  const other = await createRoom(base(), { name: 'Other', gameMode: 'survival', password: 'x' });
  const res2 = await tryJoin(new Bot('Innocent'), base(), other.code, { password: 'x' });
  info('password: the limit is per address over ALL games', res2.ok ? 'another game still works' : `another game with the right password is also refused: "${res2.kick.reason}" (a friend typo-ing 5× locks the whole household out of every locked game for 10 min)`);
}

const SECTIONS: Record<string, () => Promise<void>> = { rooms, mod, edits, drops, guard, mobs, tnt, persist, restart, pwlimit };

async function main(): Promise<void> {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SECTIONS);
  srv = await startServer(PORT, DIR);
  console.log(`server ${base()} data ${DIR}`);
  for (const name of want) {
    console.log(`\n== ${name}`);
    try {
      await SECTIONS[name]();
    } catch (e) {
      check(`${name}: section crashed`, false, String((e as Error).stack ?? e));
    }
  }
  const m = await metrics(base()).catch((): Record<string, number> => ({}));
  info('server metrics at the end', `inventory rejects ${m.bunkcraft_inventory_rejects_total ?? '?'}, logins failed ${m.bunkcraft_logins_failed_total ?? '?'}`);
  const log = readFileSync(srv.logFile, 'utf8');
  const errors = log.split('\n').filter((l) => / ERROR /.test(l));
  check('server log has no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  writeFileSync(join(DIR, 'sandbox-results.json'), JSON.stringify(results, null, 1));
  await srv.stop('SIGTERM');
  process.exit(summary());
}

void main();
