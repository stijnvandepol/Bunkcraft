import type { ArrowEntry, ItemEntry, MobEntry, ServerMessage, SnapshotEntry, TntEntry } from './protocol';

/**
 * Compact binary frames for the two high-frequency messages: `snap` (20 Hz, all players) and `ent`
 * (10 Hz, mobs/items/arrows/TNT around you). Everything else stays JSON.
 *
 * Negotiated per connection: the client sets `bin: true` in `hello`, the server answers with
 * `binary: true` in `welcome` and from then on sends those two messages as binary WebSocket frames.
 * A client always accepts both forms, so mixed old/new clients work on the same server.
 *
 * Layout (little endian, no padding, no dependencies):
 *   frame      u8 kind (1 snap, 2 ent), then the body
 *   snap body  u16 n, n × { u16 id, f32 x, f32 y, f32 z, u16 yaw, u16 pitch, u8 flags, u16 held }   (21 bytes)
 *   ent body   u16 nm, u16 ni, u16 na, u16 nb, then
 *     mob   { u32 id, u8 kind, f32 x, f32 y, f32 z, u16 yaw, u16 headYaw, u16 headPitch, u8 flags, u8 hurt, u8 fuse, u8 death }  (27 bytes)
 *     item  { u32 id, u16 itemId, u16 count, f32 x, f32 y, f32 z }                                                                (20 bytes)
 *     arrow { u32 id, f32 x, f32 y, f32 z, u16 yaw, u16 pitch, u8 inGround }                                                      (21 bytes)
 *     tnt   { u32 id, f32 x, f32 y, f32 z, u16 fuse }                                                                             (18 bytes)
 * Angles are stored as a fraction of a full turn in 16 bits (0.0001 rad resolution) and decoded to (-π, π].
 */
export const BIN_SNAP = 1;
export const BIN_ENT = 2;

const TAU = Math.PI * 2;
const encAngle = (a: number): number => {
  const t = ((a % TAU) + TAU) % TAU;
  return Math.round((t / TAU) * 65536) & 0xffff;
};
const decAngle = (v: number): number => {
  const a = (v / 65536) * TAU;
  return a > Math.PI ? a - TAU : a;
};
const u8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const u16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));

export const SNAP_ENTRY_BYTES = 21;
export const MOB_BYTES = 27;
export const ITEM_BYTES = 20;
export const ARROW_BYTES = 21;
export const TNT_BYTES = 18;

export function encodeSnap(players: SnapshotEntry[]): ArrayBuffer {
  const buf = new ArrayBuffer(3 + players.length * SNAP_ENTRY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, BIN_SNAP);
  v.setUint16(1, players.length, true);
  let o = 3;
  for (const p of players) {
    v.setUint16(o, p[0], true);
    v.setFloat32(o + 2, p[1], true);
    v.setFloat32(o + 6, p[2], true);
    v.setFloat32(o + 10, p[3], true);
    v.setUint16(o + 14, encAngle(p[4]), true);
    v.setUint16(o + 16, encAngle(p[5]), true);
    v.setUint8(o + 18, u8(p[6]));
    v.setUint16(o + 19, u16(p[7]), true);
    o += SNAP_ENTRY_BYTES;
  }
  return buf;
}

export function encodeEnt(m: MobEntry[], i: ItemEntry[], a: ArrowEntry[], b: TntEntry[]): ArrayBuffer {
  const buf = new ArrayBuffer(9 + m.length * MOB_BYTES + i.length * ITEM_BYTES + a.length * ARROW_BYTES + b.length * TNT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, BIN_ENT);
  v.setUint16(1, m.length, true);
  v.setUint16(3, i.length, true);
  v.setUint16(5, a.length, true);
  v.setUint16(7, b.length, true);
  let o = 9;
  for (const e of m) {
    v.setUint32(o, e[0], true);
    v.setUint8(o + 4, u8(e[1]));
    v.setFloat32(o + 5, e[2], true);
    v.setFloat32(o + 9, e[3], true);
    v.setFloat32(o + 13, e[4], true);
    v.setUint16(o + 17, encAngle(e[5]), true);
    v.setUint16(o + 19, encAngle(e[6]), true);
    v.setUint16(o + 21, encAngle(e[7]), true);
    v.setUint8(o + 23, u8(e[8]));
    v.setUint8(o + 24, u8(e[9]));
    v.setUint8(o + 25, u8(e[10]));
    v.setUint8(o + 26, u8(e[11]));
    o += MOB_BYTES;
  }
  for (const e of i) {
    v.setUint32(o, e[0], true);
    v.setUint16(o + 4, u16(e[1]), true);
    v.setUint16(o + 6, u16(e[2]), true);
    v.setFloat32(o + 8, e[3], true);
    v.setFloat32(o + 12, e[4], true);
    v.setFloat32(o + 16, e[5], true);
    o += ITEM_BYTES;
  }
  for (const e of a) {
    v.setUint32(o, e[0], true);
    v.setFloat32(o + 4, e[1], true);
    v.setFloat32(o + 8, e[2], true);
    v.setFloat32(o + 12, e[3], true);
    v.setUint16(o + 16, encAngle(e[4]), true);
    v.setUint16(o + 18, encAngle(e[5]), true);
    v.setUint8(o + 20, u8(e[6]));
    o += ARROW_BYTES;
  }
  for (const e of b) {
    v.setUint32(o, e[0], true);
    v.setFloat32(o + 4, e[1], true);
    v.setFloat32(o + 8, e[2], true);
    v.setFloat32(o + 12, e[3], true);
    v.setUint16(o + 16, u16(e[4]), true);
    o += TNT_BYTES;
  }
  return buf;
}

/** Encodes a snap or ent message; null for any other message (send those as JSON). */
export function encodeBinary(msg: ServerMessage): ArrayBuffer | null {
  if (msg.t === 'snap') return encodeSnap(msg.players);
  if (msg.t === 'ent') return encodeEnt(msg.m, msg.i, msg.a, msg.b);
  return null;
}

/** Decodes a binary frame; null when it is malformed or of an unknown kind. */
export function decodeBinary(buf: ArrayBuffer): ServerMessage | null {
  if (buf.byteLength < 3) return null;
  const v = new DataView(buf);
  const kind = v.getUint8(0);
  if (kind === BIN_SNAP) {
    const n = v.getUint16(1, true);
    if (buf.byteLength !== 3 + n * SNAP_ENTRY_BYTES) return null;
    const players: SnapshotEntry[] = [];
    let o = 3;
    for (let k = 0; k < n; k++, o += SNAP_ENTRY_BYTES) {
      players.push([
        v.getUint16(o, true), v.getFloat32(o + 2, true), v.getFloat32(o + 6, true), v.getFloat32(o + 10, true),
        decAngle(v.getUint16(o + 14, true)), decAngle(v.getUint16(o + 16, true)), v.getUint8(o + 18), v.getUint16(o + 19, true),
      ]);
    }
    return { t: 'snap', players };
  }
  if (kind === BIN_ENT) {
    if (buf.byteLength < 9) return null;
    const nm = v.getUint16(1, true), ni = v.getUint16(3, true), na = v.getUint16(5, true), nb = v.getUint16(7, true);
    if (buf.byteLength !== 9 + nm * MOB_BYTES + ni * ITEM_BYTES + na * ARROW_BYTES + nb * TNT_BYTES) return null;
    const m: MobEntry[] = [], i: ItemEntry[] = [], a: ArrowEntry[] = [], b: TntEntry[] = [];
    let o = 9;
    for (let k = 0; k < nm; k++, o += MOB_BYTES) {
      m.push([
        v.getUint32(o, true), v.getUint8(o + 4), v.getFloat32(o + 5, true), v.getFloat32(o + 9, true), v.getFloat32(o + 13, true),
        decAngle(v.getUint16(o + 17, true)), decAngle(v.getUint16(o + 19, true)), decAngle(v.getUint16(o + 21, true)),
        v.getUint8(o + 23), v.getUint8(o + 24), v.getUint8(o + 25), v.getUint8(o + 26),
      ]);
    }
    for (let k = 0; k < ni; k++, o += ITEM_BYTES) {
      i.push([v.getUint32(o, true), v.getUint16(o + 4, true), v.getUint16(o + 6, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true), v.getFloat32(o + 16, true)]);
    }
    for (let k = 0; k < na; k++, o += ARROW_BYTES) {
      a.push([v.getUint32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true),
        decAngle(v.getUint16(o + 16, true)), decAngle(v.getUint16(o + 18, true)), v.getUint8(o + 20)]);
    }
    for (let k = 0; k < nb; k++, o += TNT_BYTES) {
      b.push([v.getUint32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true), v.getUint16(o + 16, true)]);
    }
    return { t: 'ent', m, i, a, b };
  }
  return null;
}
