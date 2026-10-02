import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE, FlashLimiter, REDUCED_FLASH_MAX, SAFE_PALETTE, effectiveParticles, limitFlash, paletteFor,
  soundArrow, subtitleText,
} from '../src/core/Accessibility';

describe('flashes', () => {
  it('passes through when Reduce Flashes is off and caps when on', () => {
    expect(limitFlash(1, { reduceFlashes: false })).toBe(1);
    expect(limitFlash(1, { reduceFlashes: true })).toBe(REDUCED_FLASH_MAX);
    expect(limitFlash(0.1, { reduceFlashes: true })).toBe(0.1);
    expect(limitFlash(-3, { reduceFlashes: false })).toBe(0);
    expect(limitFlash(NaN, { reduceFlashes: false })).toBe(0);
  });
  it('allows at most three flashes per second when reducing', () => {
    const lim = new FlashLimiter();
    const on = { reduceFlashes: true };
    expect([0, 0.1, 0.2, 0.3].map((t) => lim.allow(t, on))).toEqual([true, true, true, false]);
    expect(lim.allow(1.05, on)).toBe(true);
    const off = { reduceFlashes: false };
    for (let i = 0; i < 10; i++) expect(lim.allow(5, off)).toBe(true);
  });
});

describe('soundArrow', () => {
  it('points to the side of the sound relative to where the player looks', () => {
    // yaw 0 looks along -z.
    expect(soundArrow(0, -10, 0)).toBe('↑');
    expect(soundArrow(0, 10, 0)).toBe('↓');
    expect(soundArrow(10, 0, 0)).toBe('→');
    expect(soundArrow(-10, 0, 0)).toBe('←');
    expect(soundArrow(10, -10, 0)).toBe('↗');
    expect(soundArrow(-10, 10, 0)).toBe('↙');
  });
  it('follows the yaw', () => {
    // Turned 90° left (yaw +π/2) the player faces -x: a sound at -x is ahead.
    expect(soundArrow(-10, 0, Math.PI / 2)).toBe('↑');
    expect(soundArrow(0, -10, Math.PI / 2)).toBe('→');
  });
  it('gives no arrow for nearby sounds', () => {
    expect(soundArrow(1, 1, 0)).toBe('');
  });
});

describe('subtitleText', () => {
  it('puts the arrow on the side the sound came from', () => {
    expect(subtitleText('Zombie groans', '←')).toBe('← [Zombie groans]');
    expect(subtitleText('Explosion', '→')).toBe('[Explosion] →');
    expect(subtitleText('Explosion', '')).toBe('[Explosion]');
    expect(subtitleText('Creeper hisses', '↑')).toBe('↑ [Creeper hisses]');
  });
});

describe('palettes and particles', () => {
  it('has a safe palette that differs from the default', () => {
    expect(paletteFor(true)).toBe(SAFE_PALETTE);
    expect(paletteFor(false)).toBe(DEFAULT_PALETTE);
    expect(SAFE_PALETTE.teamA).not.toBe(DEFAULT_PALETTE.teamA);
    expect(SAFE_PALETTE.teamA).not.toBe(SAFE_PALETTE.teamB);
  });
  it('limits particles with reduced motion', () => {
    expect(effectiveParticles({ particles: 'all', reducedMotion: true })).toBe('decreased');
    expect(effectiveParticles({ particles: 'minimal', reducedMotion: true })).toBe('minimal');
    expect(effectiveParticles({ particles: 'all', reducedMotion: false })).toBe('all');
  });
});
