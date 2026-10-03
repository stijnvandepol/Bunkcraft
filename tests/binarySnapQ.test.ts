import { describe, expect, it } from 'vitest';
import { BIN_SNAP_Q, SNAP_ENTRY_BYTES, SNAP_Q_ENTRY_BYTES, decodeBinary, encodeSnap, encodeSnapQ } from '../src/net/binary';
import { SNAP_FLAG_STALE, type SnapshotEntry } from '../src/net/protocol';
import { arcadeInterpDelay } from '../src/modes/ArcadeLogic';

describe('quantised arcade snapshots (binary version 2)', () => {
  const players: SnapshotEntry[] = [
    [1, 12.345, 65.5, -40.123, 1.2, -0.4, 4, 0],
    [700, -63.99, 70.01, 63.99, -3.1, 1.5, 4 | SNAP_FLAG_STALE, 0],
  ];

  it('round-trips positions to 1/64 block, angles to 0.0001 rad, flags exactly', () => {
    const buf = encodeSnapQ(players, 0, 64, 0);
    expect(new DataView(buf).getUint8(0)).toBe(BIN_SNAP_Q);
    expect(buf.byteLength).toBe(9 + 2 * SNAP_Q_ENTRY_BYTES);
    const m = decodeBinary(buf);
    expect(m?.t).toBe('snap');
    const got = (m as { players: SnapshotEntry[] }).players;
    for (let i = 0; i < players.length; i++) {
      const [id, x, y, z, yaw, pitch, flags] = players[i];
      expect(got[i][0]).toBe(id);
      expect(Math.abs(got[i][1] - x)).toBeLessThanOrEqual(1 / 64);
      expect(Math.abs(got[i][2] - y)).toBeLessThanOrEqual(1 / 64);
      expect(Math.abs(got[i][3] - z)).toBeLessThanOrEqual(1 / 64);
      expect(Math.abs(Math.atan2(Math.sin(got[i][4] - yaw), Math.cos(got[i][4] - yaw)))).toBeLessThan(2e-4);
      expect(Math.abs(got[i][5] - pitch)).toBeLessThan(2e-4);
      expect(got[i][6]).toBe(flags);
    }
  });

  it('is 13 instead of 21 bytes per player and rejects truncated frames', () => {
    expect(SNAP_Q_ENTRY_BYTES).toBe(13);
    expect(SNAP_ENTRY_BYTES).toBe(21);
    expect(encodeSnapQ(players, 0, 64, 0).byteLength).toBeLessThan(encodeSnap(players).byteLength);
    expect(decodeBinary(encodeSnapQ(players, 0, 64, 0).slice(0, 20))).toBeNull();
  });

  it('interpolation delay is two ticks', () => {
    expect(arcadeInterpDelay(20)).toBeCloseTo(0.1);
    expect(arcadeInterpDelay(30)).toBeCloseTo(2 / 30);
  });
});
