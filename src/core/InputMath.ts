import { KB } from './Keybinds';

/**
 * Pure input maths shared by the gamepad, the touch controls and the menus. Nothing here touches
 * the DOM, so it is unit tested (tests/inputMath.test.ts).
 */

export interface Vec2 { x: number; y: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Response curve for a 0..1 stick magnitude. `curve` 0 is linear, 100 is a strong exponential
 * (fine aim near the centre, full speed at the edge). Monotonic and maps 0 → 0 and 1 → 1.
 */
export function responseCurve(v: number, curve: number): number {
  const m = clamp(Math.abs(v), 0, 1);
  const out = Math.pow(m, 1 + clamp(curve, 0, 100) / 50);
  return v < 0 ? -out : out;
}

/**
 * Radial dead zone + response curve for one analog stick. Inside the dead zone the result is
 * exactly (0, 0); outside it the magnitude is rescaled so the output ramps smoothly from 0 at the
 * dead-zone edge to 1 at full deflection, then shaped by the curve. The direction is preserved.
 * Writes into `out` to avoid per-frame allocations.
 */
export function stickVector(x: number, y: number, deadZone: number, curve: number, out: Vec2): Vec2 {
  const mag = Math.hypot(x, y);
  const dz = clamp(deadZone, 0, 0.95);
  if (!(mag > dz) || !Number.isFinite(mag)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = responseCurve((Math.min(mag, 1) - dz) / (1 - dz), curve);
  out.x = (x / mag) * scaled;
  out.y = (y / mag) * scaled;
  return out;
}

/** Look speed of a fully deflected stick, in "mouse pixels" per second at 100% sensitivity. */
export const PAD_LOOK_SPEED = 1100;
/** Touch drag: mouse pixels per finger pixel at 100% touch sensitivity. */
export const TOUCH_LOOK_SCALE = 1.6;

/** Mouse-pixel delta for this frame from a (dead-zoned, curved) look stick. */
export function padLookDelta(stick: Vec2, dt: number, sensitivity: number, invertY: boolean, out: Vec2): Vec2 {
  const k = PAD_LOOK_SPEED * (sensitivity / 100) * dt;
  out.x = stick.x * k;
  out.y = stick.y * k * (invertY ? -1 : 1);
  return out;
}

/** Mouse-pixel delta for a finger drag of (dx, dy) screen pixels. */
export function touchLookDelta(dx: number, dy: number, sensitivity: number, out: Vec2): Vec2 {
  const k = TOUCH_LOOK_SCALE * (sensitivity / 100);
  out.x = dx * k;
  out.y = dy * k;
  return out;
}

export interface JoystickVec { x: number; y: number; mag: number }

/**
 * Virtual joystick: finger offset from the stick centre (screen pixels, y down) → movement vector.
 * `x` is strafe (right positive), `y` is forward (up on screen positive), `mag` is 0..1. The finger
 * is clamped to `radius`; inside the dead zone the vector is zero.
 */
export function joystickVector(dx: number, dy: number, radius: number, deadZone: number, out: JoystickVec): JoystickVec {
  const r = Math.max(1, radius);
  const dist = Math.hypot(dx, dy);
  const norm = Math.min(dist / r, 1);
  if (!(norm > deadZone) || dist === 0) {
    out.x = out.y = out.mag = 0;
    return out;
  }
  const mag = (norm - deadZone) / (1 - deadZone);
  out.x = (dx / dist) * mag;
  out.y = (-dy / dist) * mag;
  out.mag = mag;
  return out;
}

/** Pushing the joystick (or stick) all the way forward sprints. */
export function pushSprints(v: { y: number; mag: number }, threshold = 0.93): boolean {
  return v.mag >= threshold && v.y > 0.55;
}

/** Position of the joystick knob, limited to the base radius. Returns the offset from the centre. */
export function clampToRadius(dx: number, dy: number, radius: number, out: Vec2): Vec2 {
  const d = Math.hypot(dx, dy);
  if (d <= radius || d === 0) {
    out.x = dx;
    out.y = dy;
  } else {
    out.x = (dx / d) * radius;
    out.y = (dy / d) * radius;
  }
  return out;
}

/** Which of `count` equally wide slots (hotbar) is under screen x? Clamped, so swipes past the edge stick to the end slot. */
export function slotAtX(x: number, left: number, width: number, count: number): number {
  if (width <= 0) return 0;
  return clamp(Math.floor(((x - left) / width) * count), 0, count - 1);
}

/** Tap vs hold vs drag classification of a finger on the look area. */
export const TAP_MAX_MS = 220;
export const TAP_MAX_MOVE = 14;
export const HOLD_MS = 380;

export function isTap(durationMs: number, moved: number): boolean {
  return durationMs <= TAP_MAX_MS && moved <= TAP_MAX_MOVE;
}

export function isHold(durationMs: number, moved: number): boolean {
  return durationMs >= HOLD_MS && moved <= TAP_MAX_MOVE;
}

/**
 * Auto-jump: walking into a one-block step. True when the block at the feet one step ahead is solid
 * while the two blocks above it (and the headroom above the player) are free.
 */
export function needsAutoJump(
  solid: (x: number, y: number, z: number) => boolean,
  x: number, y: number, z: number, dirX: number, dirZ: number,
): boolean {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return false;
  const ax = Math.floor(x + (dirX / len) * 0.7);
  const az = Math.floor(z + (dirZ / len) * 0.7);
  const by = Math.floor(y + 0.01);
  if (!solid(ax, by, az)) return false;
  if (solid(ax, by + 1, az) || solid(ax, by + 2, az)) return false;
  return !solid(Math.floor(x), by + 2, Math.floor(z));
}

// ------------------------------------------------------------------ gamepad bindings

/** Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping) button indices. */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

export interface PadBinding {
  readonly button: number;
  readonly action: number;
  readonly scope?: 'sandbox' | 'arcade';
}

/**
 * Gamepad button → game action (indices of the keybinding table, so "attack", "jump" ... follow
 * the same code paths as the keyboard, including toggle/hold options). Triggers count as pressed
 * above {@link TRIGGER_THRESHOLD}. LB/RB/d-pad left-right (hotbar and weapon cycling), pause (Start)
 * and menu navigation are handled separately in Gamepad.ts.
 */
export const PAD_BINDINGS: readonly PadBinding[] = [
  { button: PAD.A, action: KB.JUMP },
  { button: PAD.B, action: KB.SNEAK },
  { button: PAD.RT, action: KB.ATTACK },
  { button: PAD.LT, action: KB.USE },
  { button: PAD.L3, action: KB.SPRINT },
  { button: PAD.X, action: KB.INVENTORY, scope: 'sandbox' },
  { button: PAD.Y, action: KB.PICK, scope: 'sandbox' },
  { button: PAD.DOWN, action: KB.DROP, scope: 'sandbox' },
  { button: PAD.BACK, action: KB.CHAT, scope: 'sandbox' },
  { button: PAD.X, action: KB.RELOAD, scope: 'arcade' },
  { button: PAD.Y, action: KB.QUICK_SWITCH, scope: 'arcade' },
  { button: PAD.BACK, action: KB.SCOREBOARD, scope: 'arcade' },
  { button: PAD.UP, action: KB.LOADOUT, scope: 'arcade' },
];

export const TRIGGER_THRESHOLD = 0.35;

/** Bindings that apply to one game kind. */
export function padBindingsFor(arcade: boolean): PadBinding[] {
  return PAD_BINDINGS.filter((b) => !b.scope || b.scope === (arcade ? 'arcade' : 'sandbox'));
}

/** Standard-mapping axes: left stick 0/1, right stick 2/3. Southpaw swaps the sticks. */
export function stickAxes(southpaw: boolean): { move: [number, number]; look: [number, number] } {
  return southpaw ? { move: [2, 3], look: [0, 1] } : { move: [0, 1], look: [2, 3] };
}

// ------------------------------------------------------------------ menu navigation

export interface NavRect { left: number; top: number; right: number; bottom: number }
export type NavDir = 'up' | 'down' | 'left' | 'right';

/**
 * Spatial focus navigation for controllers: the index of the best rectangle to move to from
 * `current` in direction `dir`, or -1 when nothing lies that way. Candidates must lie in the
 * direction's half-plane; the score prefers close ones that are well aligned on the other axis.
 */
export function nextFocus(rects: readonly NavRect[], current: number, dir: NavDir): number {
  if (rects.length === 0) return -1;
  if (current < 0 || current >= rects.length) return 0;
  const c = rects[current];
  const cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2;
  const horizontal = dir === 'left' || dir === 'right';
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === current) continue;
    const r = rects[i];
    const rx = (r.left + r.right) / 2, ry = (r.top + r.bottom) / 2;
    const along = dir === 'right' ? rx - cx : dir === 'left' ? cx - rx : dir === 'down' ? ry - cy : cy - ry;
    if (along <= 1) continue;
    const across = Math.abs(horizontal ? ry - cy : rx - cx);
    // Weight misalignment more than distance so "down" stays in its column.
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Held-direction repeat for menus. `heldMs` is how long the direction has been held (-1 = not held),
 * `prevHeldMs` the value one frame ago. True on the initial press, then after `delayMs`, then every `rateMs`.
 */
export function repeatStep(heldMs: number, prevHeldMs: number, delayMs: number, rateMs: number): boolean {
  if (heldMs < 0) return false;
  if (prevHeldMs < 0) return true;
  if (heldMs < delayMs) return false;
  const n = Math.floor((heldMs - delayMs) / rateMs);
  const pn = prevHeldMs < delayMs ? -1 : Math.floor((prevHeldMs - delayMs) / rateMs);
  return n > pn;
}
