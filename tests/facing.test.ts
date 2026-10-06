import { describe, expect, it } from 'vitest';
import { facingFromCameraYaw } from '../src/core/Facing';

// QA (docs/qa/SURVIVAL.md): F3 said "south (Towards positive Z)" while the crosshair targeted a block at −Z.
describe('F3 facing', () => {
  it('yaw 0 looks down −Z: north', () => expect(facingFromCameraYaw(0)).toBe('north'));
  it('yaw −π/2 looks down +X: east', () => expect(facingFromCameraYaw(-Math.PI / 2)).toBe('east'));
  it('yaw π looks down +Z: south', () => expect(facingFromCameraYaw(Math.PI)).toBe('south'));
  it('yaw π/2 looks down −X: west', () => expect(facingFromCameraYaw(Math.PI / 2)).toBe('west'));
  it('wraps around', () => expect(facingFromCameraYaw(4 * Math.PI)).toBe('north'));
});
