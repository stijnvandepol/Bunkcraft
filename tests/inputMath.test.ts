import { describe, expect, it } from 'vitest';
import {
  PAD_BINDINGS, PAD, clampToRadius, isHold, isTap, joystickVector, needsAutoJump, nextFocus, padBindingsFor,
  padLookDelta, pushSprints, repeatStep, responseCurve, slotAtX, stickAxes, stickVector, touchLookDelta,
  type JoystickVec, type NavRect, type Vec2,
} from '../src/core/InputMath';
import { KB, KEYBINDS } from '../src/core/Keybinds';

const out = (): Vec2 => ({ x: 0, y: 0 });
const joy = (): JoystickVec => ({ x: 0, y: 0, mag: 0 });

describe('responseCurve', () => {
  it('is the identity at curve 0 and keeps the endpoints', () => {
    for (const v of [0, 0.25, 0.5, 1]) expect(responseCurve(v, 0)).toBeCloseTo(v);
    expect(responseCurve(1, 100)).toBeCloseTo(1);
    expect(responseCurve(0, 100)).toBe(0);
  });
  it('flattens the middle for a strong curve and is monotonic', () => {
    expect(responseCurve(0.5, 100)).toBeLessThan(0.5);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = responseCurve(i / 20, 60);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('keeps the sign and clamps garbage', () => {
    expect(responseCurve(-0.5, 50)).toBeLessThan(0);
    expect(responseCurve(5, 50)).toBe(1);
    expect(responseCurve(0.5, 9999)).toBeCloseTo(0.5 ** 3);
  });
});

describe('stickVector', () => {
  it('is exactly zero inside the dead zone', () => {
    expect(stickVector(0.1, 0.1, 0.2, 0, out())).toEqual({ x: 0, y: 0 });
    expect(stickVector(0.2, 0, 0.2, 0, out())).toEqual({ x: 0, y: 0 });
  });
  it('ramps from 0 at the dead zone edge to 1 at full deflection', () => {
    expect(stickVector(1, 0, 0.2, 0, out()).x).toBeCloseTo(1);
    expect(stickVector(0.6, 0, 0.2, 0, out()).x).toBeCloseTo(0.5);
    const tiny = stickVector(0.2001, 0, 0.2, 0, out()).x;
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(0.01);
  });
  it('preserves direction and never exceeds 1 on the diagonal', () => {
    const v = stickVector(1, 1, 0.15, 30, out());
    expect(v.x).toBeCloseTo(v.y);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1.0001);
    const n = stickVector(-0.8, 0.6, 0.1, 0, out());
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0);
  });
  it('survives NaN input', () => {
    expect(stickVector(NaN, 0, 0.1, 0, out())).toEqual({ x: 0, y: 0 });
  });
});

describe('look deltas', () => {
  it('scales with sensitivity and time, and inverts Y', () => {
    const a = padLookDelta({ x: 1, y: 1 }, 0.01, 100, false, out());
    const b = padLookDelta({ x: 1, y: 1 }, 0.01, 200, false, out());
    expect(b.x).toBeCloseTo(a.x * 2);
    expect(padLookDelta({ x: 1, y: 1 }, 0.01, 100, true, out()).y).toBeCloseTo(-a.y);
    expect(padLookDelta({ x: 0, y: 0 }, 0.01, 100, false, out())).toEqual({ x: 0, y: 0 });
  });
  it('maps a touch drag proportionally', () => {
    const a = touchLookDelta(100, -50, 100, out());
    expect(a.x).toBeGreaterThan(0);
    expect(a.y).toBeLessThan(0);
    expect(touchLookDelta(100, 0, 200, out()).x).toBeCloseTo(a.x * 2);
  });
});

describe('joystickVector', () => {
  it('maps up on screen to forward and right to strafe right', () => {
    const up = joystickVector(0, -60, 60, 0.1, joy());
    expect(up.y).toBeCloseTo(1);
    expect(up.x).toBeCloseTo(0);
    const right = joystickVector(60, 0, 60, 0.1, joy());
    expect(right.x).toBeCloseTo(1);
    const down = joystickVector(0, 30, 60, 0, joy());
    expect(down.y).toBeCloseTo(-0.5);
  });
  it('clamps beyond the radius and honours the dead zone', () => {
    expect(joystickVector(0, -500, 60, 0.1, joy()).mag).toBeCloseTo(1);
    expect(joystickVector(2, 2, 60, 0.15, joy())).toEqual({ x: 0, y: 0, mag: 0 });
  });
  it('sprints only when pushed fully forward', () => {
    expect(pushSprints(joystickVector(0, -60, 60, 0.1, joy()))).toBe(true);
    expect(pushSprints(joystickVector(0, -40, 60, 0.1, joy()))).toBe(false);
    expect(pushSprints(joystickVector(60, 0, 60, 0.1, joy()))).toBe(false);
    expect(pushSprints(joystickVector(0, 60, 60, 0.1, joy()))).toBe(false);
  });
  it('limits the knob to the base radius', () => {
    const k = clampToRadius(300, 400, 50, out());
    expect(Math.hypot(k.x, k.y)).toBeCloseTo(50);
    expect(clampToRadius(10, 10, 50, out())).toEqual({ x: 10, y: 10 });
  });
});

describe('hotbar swipe and gestures', () => {
  it('finds the slot under a finger and clamps at the edges', () => {
    expect(slotAtX(100, 100, 180, 9)).toBe(0);
    expect(slotAtX(100 + 179, 100, 180, 9)).toBe(8);
    expect(slotAtX(-50, 100, 180, 9)).toBe(0);
    expect(slotAtX(900, 100, 180, 9)).toBe(8);
    expect(slotAtX(100 + 90, 100, 180, 9)).toBe(4);
    expect(slotAtX(5, 0, 0, 9)).toBe(0);
  });
  it('classifies taps and holds', () => {
    expect(isTap(120, 3)).toBe(true);
    expect(isTap(120, 40)).toBe(false);
    expect(isTap(600, 3)).toBe(false);
    expect(isHold(600, 3)).toBe(true);
    expect(isHold(600, 80)).toBe(false);
    expect(isHold(100, 0)).toBe(false);
  });
});

describe('needsAutoJump', () => {
  const world = (blocks: string[]) => {
    const set = new Set(blocks);
    return (x: number, y: number, z: number) => set.has(`${x},${y},${z}`);
  };
  it('jumps a one block step', () => {
    expect(needsAutoJump(world(['1,0,0']), 0.5, 0, 0.5, 1, 0)).toBe(true);
  });
  it('does not jump a wall two blocks high or open ground', () => {
    expect(needsAutoJump(world(['1,0,0', '1,1,0']), 0.5, 0, 0.5, 1, 0)).toBe(false);
    expect(needsAutoJump(world([]), 0.5, 0, 0.5, 1, 0)).toBe(false);
  });
  it('does not jump under a low ceiling or while standing still', () => {
    expect(needsAutoJump(world(['1,0,0', '0,2,0']), 0.5, 0, 0.5, 1, 0)).toBe(false);
    expect(needsAutoJump(world(['1,0,0']), 0.5, 0, 0.5, 0, 0)).toBe(false);
  });
});

describe('gamepad bindings', () => {
  it('only references real actions and buttons', () => {
    for (const b of PAD_BINDINGS) {
      expect(b.action).toBeGreaterThanOrEqual(0);
      expect(b.action).toBeLessThan(KEYBINDS.length);
      expect(b.button).toBeGreaterThanOrEqual(0);
      expect(b.button).toBeLessThan(17);
    }
  });
  it('never binds one button twice in the same game kind', () => {
    for (const arcade of [false, true]) {
      const buttons = padBindingsFor(arcade).map((b) => b.button);
      expect(new Set(buttons).size).toBe(buttons.length);
    }
  });
  it('only uses actions that exist in that game kind', () => {
    for (const b of padBindingsFor(true)) expect(KEYBINDS[b.action].scope).not.toBe('sandbox');
    for (const b of padBindingsFor(false)) expect(KEYBINDS[b.action].scope).not.toBe('arcade');
  });
  it('has the documented core layout', () => {
    const sb = padBindingsFor(false);
    const find = (button: number) => sb.find((b) => b.button === button)?.action;
    expect(find(PAD.A)).toBe(KB.JUMP);
    expect(find(PAD.RT)).toBe(KB.ATTACK);
    expect(find(PAD.LT)).toBe(KB.USE);
    expect(find(PAD.X)).toBe(KB.INVENTORY);
    expect(padBindingsFor(true).find((b) => b.button === PAD.X)?.action).toBe(KB.RELOAD);
  });
  it('swaps the sticks for southpaw', () => {
    expect(stickAxes(false).move).toEqual([0, 1]);
    expect(stickAxes(true).move).toEqual([2, 3]);
    expect(stickAxes(true).look).toEqual([0, 1]);
  });
});

describe('menu navigation', () => {
  const rect = (l: number, t: number, w = 100, h = 20): NavRect => ({ left: l, top: t, right: l + w, bottom: t + h });
  // Two columns, three rows: 0 1 / 2 3 / 4 5
  const grid = [rect(0, 0), rect(110, 0), rect(0, 30), rect(110, 30), rect(0, 60), rect(110, 60)];
  it('moves through a grid', () => {
    expect(nextFocus(grid, 0, 'right')).toBe(1);
    expect(nextFocus(grid, 0, 'down')).toBe(2);
    expect(nextFocus(grid, 3, 'down')).toBe(5);
    expect(nextFocus(grid, 3, 'left')).toBe(2);
    expect(nextFocus(grid, 5, 'up')).toBe(3);
  });
  it('returns -1 at the edge and handles empty lists and no focus', () => {
    expect(nextFocus(grid, 0, 'up')).toBe(-1);
    expect(nextFocus(grid, 1, 'right')).toBe(-1);
    expect(nextFocus([], 0, 'down')).toBe(-1);
    expect(nextFocus(grid, -1, 'down')).toBe(0);
  });
  it('prefers the aligned button over a closer misaligned one', () => {
    const col = [rect(0, 0), rect(0, 40), rect(150, 25)];
    expect(nextFocus(col, 0, 'down')).toBe(1);
  });
  it('repeats held directions after a delay', () => {
    expect(repeatStep(0, -1, 400, 100)).toBe(true);
    expect(repeatStep(16, 0, 400, 100)).toBe(false);
    expect(repeatStep(405, 390, 400, 100)).toBe(true);
    expect(repeatStep(450, 405, 400, 100)).toBe(false);
    expect(repeatStep(510, 490, 400, 100)).toBe(true);
    expect(repeatStep(-1, 200, 400, 100)).toBe(false);
  });
});
