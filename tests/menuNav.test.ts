import { describe, expect, it } from 'vitest';
import { type Box, nextFocus } from '../src/ui/menuNav';

const box = (x: number, y: number, w = 100, h = 20): Box => ({ x, y, w, h });

describe('nextFocus', () => {
  // Two-column grid:  0 1 / 2 3 / 4 (wide, centred)
  const grid = [box(0, 0), box(110, 0), box(0, 24), box(110, 24), box(55, 48)];

  it('moves down and up within a column', () => {
    expect(nextFocus(grid, 0, 'down')).toBe(2);
    expect(nextFocus(grid, 3, 'up')).toBe(1);
    expect(nextFocus(grid, 2, 'down')).toBe(4);
  });

  it('moves left and right within a row and stops at the edges', () => {
    expect(nextFocus(grid, 0, 'right')).toBe(1);
    expect(nextFocus(grid, 1, 'left')).toBe(0);
    expect(nextFocus(grid, 0, 'left')).toBe(-1);
    expect(nextFocus(grid, 4, 'down')).toBe(-1);
    expect(nextFocus(grid, 0, 'up')).toBe(-1);
  });

  it('starts at the first or last control when nothing is focused', () => {
    expect(nextFocus(grid, -1, 'down')).toBe(0);
    expect(nextFocus(grid, -1, 'up')).toBe(4);
    expect(nextFocus([], 0, 'down')).toBe(-1);
  });

  it('handles a single column', () => {
    const col = [box(0, 0), box(0, 24), box(0, 48)];
    expect(nextFocus(col, 0, 'down')).toBe(1);
    expect(nextFocus(col, 1, 'down')).toBe(2);
    expect(nextFocus(col, 2, 'up')).toBe(1);
    expect(nextFocus(col, 1, 'right')).toBe(-1);
  });
});
