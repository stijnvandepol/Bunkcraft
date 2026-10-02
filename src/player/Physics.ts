/** Movement constants, tuned to feel close to Minecraft (blocks / second). */
export const PHYSICS = {
  STEP: 1 / 60,
  GRAVITY: 30,
  TERMINAL_VELOCITY: 60,
  JUMP_VELOCITY: 8.9,
  WALK_SPEED: 4.32,
  SPRINT_SPEED: 5.61,
  FLY_SPEED: 10.9,
  FLY_SPRINT_SPEED: 21.6,
  FLY_VERTICAL: 7.5,
  SWIM_SPEED: 2.4,
  WATER_GRAVITY: 7,
  WATER_SINK: 2.2,
  SWIM_UP: 4.2,
  GROUND_ACCEL: 18,
  AIR_ACCEL: 4.5,
  FLY_ACCEL: 9,
  WIDTH: 0.6,
  HEIGHT: 1.8,
  EYE_HEIGHT: 1.62,
  REACH: 5,
} as const;

/** Frame-rate independent exponential approach towards `target`. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}
