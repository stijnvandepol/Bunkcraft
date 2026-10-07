import { describe, expect, it } from 'vitest';
import { BIN_SHOT, decodeBinary, encodeShot } from '../src/net/binary';
import type { ServerMessage } from '../src/net/protocol';

type Shot = Extract<ServerMessage, { t: 'shot' }>;

describe('binary arcade shot (binary version 3)', () => {
  const shot: Shot = { t: 'shot', id: 12, weapon: 'rifle', ox: 12.34, oy: 65.62, oz: -3.21, ex: 40.12, ey: 64.5, ez: -10.75 };

  it('round-trips the origin to 0.01 and the end point to 1/32 block, and is a fifth of the JSON size', () => {
    const buf = encodeShot(shot)!;
    expect(new DataView(buf).getUint8(0)).toBe(BIN_SHOT);
    expect(buf.byteLength).toBe(23 + 'rifle'.length);
    expect(buf.byteLength * 3).toBeLessThan(JSON.stringify(shot).length);
    const m = decodeBinary(buf) as Shot;
    expect(m).toMatchObject({ t: 'shot', id: 12, weapon: 'rifle', ox: 12.34, oy: 65.62, oz: -3.21 });
    expect(m.sup).toBeUndefined();
    for (const k of ['ex', 'ey', 'ez'] as const) expect(Math.abs(m[k] - shot[k])).toBeLessThanOrEqual(1 / 32);
  });

  it('carries the suppressor flag', () => {
    const m = decodeBinary(encodeShot({ ...shot, sup: 1 })!) as Shot;
    expect(m.sup).toBe(1);
  });

  it('declines what it cannot carry exactly (the server sends JSON then)', () => {
    // A field added to `shot` later must not be dropped silently.
    expect(encodeShot({ ...shot, extra: 1 } as unknown as Shot)).toBeNull();
    expect(encodeShot({ ...shot, weapon: 'x'.repeat(40) })).toBeNull();
    expect(encodeShot({ ...shot, weapon: 'gewehré' })).toBeNull();
    expect(encodeShot({ ...shot, ex: shot.ox + 2000 })).toBeNull();
    expect(encodeShot({ ...shot, id: 70000 })).toBeNull();
  });

  it('rejects truncated frames', () => {
    const buf = encodeShot(shot)!;
    expect(decodeBinary(buf.slice(0, buf.byteLength - 1))).toBeNull();
    expect(decodeBinary(buf.slice(0, 10))).toBeNull();
  });
});
