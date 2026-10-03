import { describe, expect, it } from 'vitest';
import { StatTracker, formatDistance, formatPlayTime } from '../src/player/StatTracker';

describe('StatTracker', () => {
  it('counts and ignores invalid increments', () => {
    const s = new StatTracker();
    s.add('mined');
    s.add('mined', 4);
    s.add('mined', -3);
    s.add('mined', Number.NaN);
    expect(s.get('mined')).toBe(5);
  });

  it('adds walking in centimetres and ignores teleports', () => {
    const s = new StatTracker();
    s.addWalk(0.25);
    s.addWalk(120);
    s.addWalk(-1);
    expect(s.get('walkedCm')).toBe(25);
  });

  it('round-trips through serialize/load and only saves non-zero counters', () => {
    const s = new StatTracker();
    s.add('deaths', 2);
    s.add('playMs', 61_000);
    const saved = s.serialize();
    expect(saved).toEqual({ deaths: 2, playMs: 61_000 });
    const t = new StatTracker();
    t.load(JSON.parse(JSON.stringify(saved)));
    expect(t.get('deaths')).toBe(2);
    expect(t.get('mined')).toBe(0);
  });

  it('survives garbage in a save', () => {
    const s = new StatTracker();
    s.add('jumps', 9);
    s.load({ jumps: -5, mined: 'lots', deaths: 1.7, evil: 99, killed: Infinity });
    expect(s.serialize()).toEqual({ deaths: 1 });
    s.load(null);
    expect(s.serialize()).toEqual({});
    s.load([1, 2]);
    expect(s.serialize()).toEqual({});
  });
});

describe('formatting', () => {
  it('formats play time', () => {
    expect(formatPlayTime(45_000)).toBe('45 s');
    expect(formatPlayTime(12 * 60_000 + 3000)).toBe('12 min 3 s');
    expect(formatPlayTime(3600_000 + 5 * 60_000)).toBe('1 h 5 min');
  });

  it('formats distance', () => {
    expect(formatDistance(81_200)).toBe('812 m');
    expect(formatDistance(125_000)).toBe('1.25 km');
  });
});
