import { describe, expect, it } from 'vitest';
import { latchPress } from '../src/core/InputMath';

/**
 * QA (docs/qa/SURVIVAL.md): a quick double tap of space in creative did not start flying at 120 FPS. The jump press
 * lives one frame, physics steps at 60 Hz, so a press on a frame without a physics step was dropped.
 * This replays Game.updatePlaying's frame/step loop.
 */
function stepsThatSawPress(frameMs: number, pressFrames: number[], latch: boolean): number {
  const STEP = 1000 / 60;
  let acc = 0;
  let jumpPressed = false;
  let seen = 0;
  for (let f = 0; f < 60; f++) {
    acc += frameMs;
    const pressed = pressFrames.includes(f);
    jumpPressed = latch ? latchPress(jumpPressed, true, pressed) : pressed;
    while (acc >= STEP) {
      if (jumpPressed) seen++;
      jumpPressed = false;
      acc -= STEP;
    }
  }
  return seen;
}

describe('jump press latch', () => {
  it('at 120 FPS the old per-frame assignment loses presses on frames without a physics step', () => {
    // Every other frame runs no step at 120 Hz (8.3 ms frames, 16.7 ms steps).
    const lost = [[0, 14], [1, 15]].map((f) => 2 - stepsThatSawPress(1000 / 120, f, false));
    expect(Math.max(...lost)).toBe(2);
  });
  it('the latched press reaches the next physics step, every time', () => {
    for (const frames of [[1, 15], [0, 14], [7, 9], [2, 12]]) expect(stepsThatSawPress(1000 / 120, frames, true)).toBe(2);
  });
  it('at 60 FPS nothing changes', () => {
    expect(stepsThatSawPress(1000 / 60, [1, 15], true)).toBe(2);
  });
  it('no press without control (menus, dead)', () => {
    expect(latchPress(true, false, true)).toBe(false);
  });
});
