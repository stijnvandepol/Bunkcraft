import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, NAME_PATTERN, NET_MOB_KINDS, PROTOCOL_VERSION, formatCode, normalizeCode, sanitizeChat } from '../src/net/protocol';
import { MOB_TYPES } from '../src/entities/MobTypes';

const codeArb = fc.array(fc.constantFrom(...CODE_ALPHABET.split('')), { minLength: CODE_LENGTH, maxLength: CODE_LENGTH }).map((a) => a.join(''));

describe('normalizeCode', () => {
  it('accepts the plain code, lower case, dashes, spaces and the bunk- prefix', () => {
    expect(normalizeCode('K7QM2X')).toBe('K7QM2X');
    expect(normalizeCode(' k7q-m2x ')).toBe('K7QM2X');
    expect(normalizeCode('bunk-k7qm2x')).toBe('K7QM2X');
    expect(normalizeCode('BUNK K7Q M2X')).toBe('K7QM2X');
  });

  it('extracts the code from an invite link, with other query parameters and a hash', () => {
    expect(normalizeCode('https://play.example.com/?join=K7QM2X')).toBe('K7QM2X');
    expect(normalizeCode('https://x.test/?a=1&join=k7q-m2x&b=2#frag')).toBe('K7QM2X');
    expect(normalizeCode('http://localhost:5173/?JOIN=K7QM2X')).toBe('K7QM2X');
  });

  it('rejects wrong lengths and characters outside the alphabet (0, O, 1, I, L)', () => {
    for (const bad of ['', 'K7QM2', 'K7QM2XX', 'K7QM20', 'K7QMOX', 'K7QM1X', 'K7QMIX', 'K7QMLX', '??????', 'https://x.test/?join=']) {
      expect(normalizeCode(bad), bad).toBeNull();
    }
  });

  it('round trips every valid code through formatCode, in any case and with decoration', () => {
    fc.assert(fc.property(codeArb, (code) => {
      expect(normalizeCode(code)).toBe(code);
      expect(normalizeCode(formatCode(code))).toBe(code);
      expect(normalizeCode(code.toLowerCase())).toBe(code);
      expect(normalizeCode(`https://example.com/?join=${code}`)).toBe(code);
      expect(normalizeCode(`  bunk-${formatCode(code).toLowerCase()}  `)).toBe(code);
    }), { numRuns: 500 });
  });

  it('never throws and only ever returns a well-formed code', () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (raw) => {
      const r = normalizeCode(raw);
      if (r !== null) expect(r).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
    }), { numRuns: 2000 });
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (raw) => { normalizeCode(raw); }), { numRuns: 500 });
  });

  it('has an alphabet without look-alike characters', () => {
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

describe('formatCode', () => {
  it('splits a code in two readable halves', () => {
    expect(formatCode('K7QM2X')).toBe('K7Q-M2X');
  });
});

describe('NAME_PATTERN', () => {
  it('allows 3-16 letters, digits and underscores only', () => {
    for (const ok of ['abc', 'Player_1', 'x'.repeat(16), '___', '123']) expect(NAME_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', 'ab', 'x'.repeat(17), 'a b', 'a-b', 'é', '<b>', 'a\nb', 'abc\n']) expect(NAME_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('sanitizeChat', () => {
  it('strips control characters, trims and caps at 256 characters', () => {
    expect(sanitizeChat('  hi\u0000 there\u007f\n ')).toBe('hi there');
    expect(sanitizeChat('x'.repeat(1000))).toHaveLength(256);
    expect(sanitizeChat('\u0001\u0002')).toBe('');
  });

  it('is idempotent and its output never contains control characters', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (s) => {
      const once = sanitizeChat(s);
      expect(sanitizeChat(once)).toBe(once);
      expect(once).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(once.length).toBeLessThanOrEqual(256);
    }), { numRuns: 1000 });
  });
});

describe('protocol constants', () => {
  it('lists the mob kinds in snapshot order and every one has a model type', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(new Set(NET_MOB_KINDS).size).toBe(NET_MOB_KINDS.length);
    for (const k of NET_MOB_KINDS) expect(MOB_TYPES[k], k).toBeDefined();
  });
});
