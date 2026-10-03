import { describe, expect, it } from 'vitest';
import { DAY_LENGTH, DayCycle, MOON_PHASE_NAMES, moonPhaseOf } from '../src/rendering/DayCycle';

describe('moon phases', () => {
  it('cycles through 8 phases, full moon every 8th day', () => {
    expect(moonPhaseOf(0)).toBe(0);
    expect(moonPhaseOf(4)).toBe(4);
    expect(moonPhaseOf(8)).toBe(0);
    expect(moonPhaseOf(17)).toBe(1);
    expect(moonPhaseOf(-1)).toBe(7);
    expect(MOON_PHASE_NAMES[0]).toBe('Full Moon');
    expect(MOON_PHASE_NAMES[4]).toBe('New Moon');
    expect(MOON_PHASE_NAMES.length).toBe(8);
  });

  it('counts a day whenever the clock wraps past sunrise', () => {
    const c = new DayCycle();
    c.time = 0.99;
    c.update(0.02 * DAY_LENGTH);
    expect(c.day).toBe(1);
    expect(c.time).toBeCloseTo(0.01, 5);
    expect(c.moonPhase).toBe(1);
    c.update(DAY_LENGTH * 7);
    expect(c.day).toBe(8);
    expect(c.moonPhase).toBe(0);
  });
});

describe('overcast sky', () => {
  it('is darker and greyer in rain, and loses stars and sunset glow', () => {
    const clear = new DayCycle();
    clear.time = 0.2;
    clear.compute();
    const rain = new DayCycle();
    rain.time = 0.2;
    rain.rain = 1;
    rain.compute();
    expect(rain.daylight).toBeLessThan(clear.daylight * 0.75);
    expect(rain.zenith.b - rain.zenith.r).toBeLessThan((clear.zenith.b - clear.zenith.r) * 0.1);

    const dusk = new DayCycle();
    dusk.time = 0.5;
    dusk.compute();
    const duskRain = new DayCycle();
    duskRain.time = 0.5;
    duskRain.rain = 1;
    duskRain.compute();
    expect(dusk.sunsetAmount).toBeGreaterThan(0.5);
    expect(duskRain.sunsetAmount).toBe(0);

    const night = new DayCycle();
    night.time = 0.75;
    night.rain = 1;
    night.compute();
    expect(night.starAmount).toBe(0);
  });

  it('thunder darkens more than rain alone', () => {
    const a = new DayCycle(), b = new DayCycle();
    a.time = b.time = 0.2;
    a.rain = b.rain = 1;
    b.thunder = 1;
    a.compute();
    b.compute();
    expect(b.daylight).toBeLessThan(a.daylight);
    expect(b.zenith.g).toBeLessThan(a.zenith.g);
  });
});
