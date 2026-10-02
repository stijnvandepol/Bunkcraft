import { describe, expect, it } from 'vitest';
import { formatCode, normalizeCode } from '../src/net/protocol';
import { RateLimiter } from '../server/Rooms';

describe('game codes', () => {
  it('accepts codes in any case, with dashes, spaces or a BUNK prefix', () => {
    expect(normalizeCode('k7qm2x')).toBe('K7QM2X');
    expect(normalizeCode(' K7Q-M2X ')).toBe('K7QM2X');
    expect(normalizeCode('bunk-k7qm2x')).toBe('K7QM2X');
  });

  it('extracts the code from an invite link', () => {
    expect(normalizeCode('https://play.example.com/?join=K7QM2X')).toBe('K7QM2X');
    expect(normalizeCode('Join my game: https://x.nl/?join=k7q-m2x&a=1')).toBe('K7QM2X');
  });

  it('rejects malformed codes and look-alike characters', () => {
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('hello')).toBeNull();
    expect(normalizeCode('K7QM2')).toBeNull();
    expect(normalizeCode('K7QM2XY')).toBeNull();
    expect(normalizeCode('K7QM20')).toBeNull(); // 0, O, 1, I and L are never used
    expect(normalizeCode('../etc/passwd')).toBeNull();
  });

  it('formats a code for reading aloud', () => {
    expect(formatCode('K7QM2X')).toBe('K7Q-M2X');
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per key, then blocks', () => {
    const limit = new RateLimiter(3, 60_000);
    expect([1, 2, 3, 4].map(() => limit.take('a'))).toEqual([true, true, true, false]);
    expect(limit.take('b')).toBe(true); // other clients are unaffected
  });
});
