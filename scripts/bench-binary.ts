/**
 * JSON versus the binary frames for the two high-frequency messages (snap 20 Hz, ent 10 Hz).
 *
 *   npx tsx scripts/bench-binary.ts
 *
 * Prints size per message, bandwidth per client at the real send rates, and CPU per message for
 * encoding on the server and decoding on the client (same data both ways).
 */
import { deflateRawSync } from 'node:zlib';
import { decodeBinary, encodeEnt, encodeSnap } from '../src/net/binary';
import type { ArrowEntry, ItemEntry, MobEntry, ServerMessage, SnapshotEntry, TntEntry } from '../src/net/protocol';

type Snap = Extract<ServerMessage, { t: 'snap' }>;
type Ent = Extract<ServerMessage, { t: 'ent' }>;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function snap(players: number): Snap {
  const list: SnapshotEntry[] = [];
  for (let i = 0; i < players; i++) {
    list.push([i + 1, r3(rnd() * 400 - 200), r3(60 + rnd() * 20), r3(rnd() * 400 - 200), r3(rnd() * 6.28 - 3.14), r3(rnd() - 0.5), Math.floor(rnd() * 8), Math.floor(rnd() * 400)]);
  }
  return { t: 'snap', players: list };
}

function ent(mobs: number, items: number, arrows: number, tnt: number): Ent {
  const m: MobEntry[] = [], i: ItemEntry[] = [], a: ArrowEntry[] = [], b: TntEntry[] = [];
  for (let k = 0; k < mobs; k++) m.push([1000 + k, k % 8, r2(rnd() * 100), r2(64 + rnd() * 10), r2(rnd() * 100), r2(rnd() * 6 - 3), r2(rnd() * 6 - 3), r2(rnd() - 0.5), 1, 0, 0, 0]);
  for (let k = 0; k < items; k++) i.push([5000 + k, 4 + (k % 40), 1 + (k % 5), r2(rnd() * 100), r2(64 + rnd() * 10), r2(rnd() * 100)]);
  for (let k = 0; k < arrows; k++) a.push([7000 + k, r2(rnd() * 100), r2(64 + rnd() * 10), r2(rnd() * 100), r2(rnd() * 6 - 3), r2(rnd() - 0.5), 0]);
  for (let k = 0; k < tnt; k++) b.push([8000 + k, r2(rnd() * 100), r2(64 + rnd() * 10), r2(rnd() * 100), 40]);
  return { t: 'ent', m, i, a, b };
}

function time(fn: () => void, n = 20000): number {
  for (let k = 0; k < 2000; k++) fn(); // warm up
  const t0 = performance.now();
  for (let k = 0; k < n; k++) fn();
  return ((performance.now() - t0) / n) * 1000; // microseconds
}

function report(name: string, msg: Snap | Ent, hz: number, clients: number): void {
  const json = JSON.stringify(msg);
  const bin = msg.t === 'snap' ? encodeSnap(msg.players) : encodeEnt(msg.m, msg.i, msg.a, msg.b);
  const gz = deflateRawSync(json).length;
  const jb = Buffer.byteLength(json);
  const saving = 1 - bin.byteLength / jb;
  const encJson = time(() => { JSON.stringify(msg); });
  const encBin = time(() => { if (msg.t === 'snap') encodeSnap(msg.players); else encodeEnt(msg.m, msg.i, msg.a, msg.b); });
  const decJson = time(() => { JSON.parse(json); });
  const decBin = time(() => { decodeBinary(bin); });
  console.log(`${name}`);
  console.log(`  size       json ${jb} B   binary ${bin.byteLength} B   (-${(saving * 100).toFixed(0)} %)   [deflate of json: ${gz} B]`);
  console.log(`  per client json ${(jb * hz / 1024).toFixed(1)} KiB/s   binary ${(bin.byteLength * hz / 1024).toFixed(1)} KiB/s   (at ${hz} Hz)`);
  console.log(`  server out ${clients} clients: json ${(jb * hz * clients / 1024).toFixed(0)} KiB/s   binary ${(bin.byteLength * hz * clients / 1024).toFixed(0)} KiB/s`);
  console.log(`  encode     json ${encJson.toFixed(2)} us   binary ${encBin.toFixed(2)} us`);
  console.log(`  decode     json ${decJson.toFixed(2)} us   binary ${decBin.toFixed(2)} us`);
}

const players = 16;
report(`snap, ${players} players, 20 Hz`, snap(players), 20, players);
report(`ent, quiet area (6 mobs, 2 items), 10 Hz`, ent(6, 2, 0, 0), 10, players);
report(`ent, busy area (24 mobs, 12 items, 4 arrows, 3 tnt), 10 Hz`, ent(24, 12, 4, 3), 10, players);
