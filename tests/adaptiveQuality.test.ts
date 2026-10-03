import { describe, expect, it } from 'vitest';
import { DynamicResolution } from '../src/core/AdaptiveQuality';

/** Runs the governor at a constant frame rate; returns the second at which it first reported a change (-1 = never). */
function run(d: DynamicResolution, fps: number, seconds: number, base = 0.5): number {
  const dt = 1 / fps;
  for (let t = 0; t < seconds * fps; t++) {
    if (d.update(dt, base)) return Math.ceil((t + 1) / fps);
  }
  return -1;
}

describe('render distance governor', () => {
  it('drops the render distance when the frame rate stays low at the minimum resolution', () => {
    const d = new DynamicResolution();
    d.maxDistanceDrop = 4;
    expect(run(d, 30, 2.5)).toBe(-1);
    expect(d.distanceDrop).toBe(0);
    expect(run(d, 30, 2)).toBe(1); // third slow second
    expect(d.distanceDrop).toBe(1);
  });

  it('never drops past the allowed maximum', () => {
    const d = new DynamicResolution();
    d.maxDistanceDrop = 2;
    run(d, 20, 60);
    run(d, 20, 60);
    run(d, 20, 60);
    expect(d.distanceDrop).toBe(2);
  });

  it('lowers the resolution first, the distance only after it hit the minimum', () => {
    const d = new DynamicResolution();
    d.maxDistanceDrop = 4;
    run(d, 30, 4, 1); // base ratio 1: there is room to lower the scale
    expect(d.scale).toBeLessThan(1);
    expect(d.distanceDrop).toBe(0);
  });

  it('gives the distance back after a stretch of smooth frames', () => {
    const d = new DynamicResolution();
    d.maxDistanceDrop = 4;
    run(d, 30, 10);
    expect(d.distanceDrop).toBe(1);
    const at = run(d, 60, 60);
    expect(at).toBeGreaterThanOrEqual(12);
    expect(d.distanceDrop).toBe(0);
  });

  it('clamps the drop when the user lowers the setting', () => {
    const d = new DynamicResolution();
    d.maxDistanceDrop = 4;
    run(d, 30, 10);
    run(d, 30, 10);
    d.maxDistanceDrop = 0;
    run(d, 60, 5);
    expect(d.distanceDrop).toBe(0);
  });
});
