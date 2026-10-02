import { KB, KEYBINDS } from './Keybinds';

const MOUSE_CODES = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];

/** Fixed keys whose browser default (help, find, focus change) is suppressed in game. */
const FIXED_KEYS = new Set(['F1', 'F3', 'Tab']);

/**
 * Keyboard/mouse state with per-frame edge detection. Mouse movement is accumulated
 * between frames and consumed once per frame, so look input is never dropped.
 *
 * Keys are tracked by `KeyboardEvent.code`, mouse buttons as "Mouse<button>" (only while
 * the pointer is locked), so every action can be bound to either (see Keybinds.ts).
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Bound code per action, in KB order ('' = Not Bound). Replaced via setBindings. */
  private binds: string[] = KEYBINDS.map((k) => k.defaultCode);
  /** Every bound code: their browser defaults are suppressed while playing. */
  private boundCodes = new Set<string>(this.binds);
  /** Actions held by a virtual device (touch buttons, gamepad), indexed like KB. */
  private readonly virtDown: boolean[] = KEYBINDS.map(() => false);
  private readonly virtPressed: boolean[] = KEYBINDS.map(() => false);
  /** Toggle instead of hold (sneak, sprint, attack, use options) and the toggled state. */
  private readonly toggled: boolean[] = KEYBINDS.map(() => false);
  private readonly latched: boolean[] = KEYBINDS.map(() => false);
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** Analog movement from a stick or touch joystick, -1..1 (added to the key-based axes). */
  axisForward = 0;
  axisStrafe = 0;
  locked = false;
  /**
   * Touch screens: no Pointer Lock exists, so "locked" is a virtual state (the game still sees the
   * same lock/unlock events). Forced on with the Touch Controls option, otherwise set by the first touch.
   */
  touchMode = false;
  /** A gamepad is the active device: also locks virtually, until the mouse is used again. */
  padMode = false;
  /** Timestamp of the last touch event: emulated mouse events right after it are ignored. */
  private lastTouch = -1e9;
  /**
   * Fires on every keydown, and on mouse button presses while locked (used for UI
   * shortcuts like ESC, inventory, F3). Mouse buttons arrive as "Mouse<button>".
   */
  onKeyDown: ((code: string, e: KeyboardEvent | MouseEvent) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Fires on virtual action presses (touch/gamepad buttons) so UI shortcuts work without a bound key. */
  onAction: ((action: number) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.softLock && this.locked) this.exitLock();
      if (!e.repeat) this.flipLatches(e.code);
      if (e.code === 'F1' || e.code === 'F3' || (this.locked && (this.boundCodes.has(e.code) || FIXED_KEYS.has(e.code)))) e.preventDefault();
      if (!e.repeat) {
        this.down.add(e.code);
        this.pressed.add(e.code);
      }
      this.onKeyDown?.(e.code, e);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
    });
    // Which kind of device is in use decides between Pointer Lock and the virtual lock.
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        this.lastTouch = performance.now();
        if (e.pointerType === 'touch') this.touchMode = true;
      } else if (e.isTrusted && performance.now() - this.lastTouch > 700) {
        this.padMode = false;
        if (!this.forceTouch) this.touchMode = false;
      }
    }, true);
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked || performance.now() - this.lastTouch < 700) return;
      const code = MOUSE_CODES[e.button];
      if (!code) return;
      this.flipLatches(code);
      // Middle-click autoscroll, side-button navigation.
      if (e.button !== 0) e.preventDefault();
      this.down.add(code);
      this.pressed.add(code);
      this.onKeyDown?.(code, e);
    });
    window.addEventListener('mouseup', (e) => {
      const code = MOUSE_CODES[e.button];
      if (!code) return;
      if (this.locked && e.button > 2) e.preventDefault();
      this.down.delete(code);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
  }

  /** Forced touch mode (Touch Controls: ON). */
  forceTouch = false;

  /** Lock without Pointer Lock (touch screens, gamepad). */
  get softLock(): boolean {
    return this.touchMode || this.padMode;
  }

  /** Use a toggle instead of hold for an action ("Toggle Sprint" and friends). */
  setToggle(action: number, on: boolean): void {
    this.toggled[action] = on;
    if (!on) this.latched[action] = false;
  }

  /** Switch a toggled action off (e.g. sprint when the player stops walking). */
  releaseLatch(action: number): void {
    this.latched[action] = false;
  }

  private flipLatches(code: string): void {
    if (!this.locked) return;
    for (let a = 0; a < this.toggled.length; a++) {
      if (this.toggled[a] && this.binds[a] === code && code !== '') this.latched[a] = !this.latched[a];
    }
  }

  /** Forget every held key, button and toggle (the lock was lost). */
  releaseAll(): void {
    this.down.clear();
    this.virtDown.fill(false);
    this.latched.fill(false);
    this.axisForward = this.axisStrafe = 0;
  }

  /**
   * A virtual device (touch button, gamepad) presses or releases an action. Behaves like the bound
   * key, including toggle options, but works even when the action is Not Bound.
   */
  setAction(action: number, down: boolean): void {
    if (this.virtDown[action] === down) return;
    this.virtDown[action] = down;
    if (!down) return;
    this.virtPressed[action] = true;
    if (this.toggled[action] && this.locked) this.latched[action] = !this.latched[action];
    this.onAction?.(action);
  }

  /** Does this key event belong to the action: its bound key, or a virtual press of it? */
  matches(code: string, action: number): boolean {
    return code === this.binds[action] && code !== '';
  }

  private setSoftLocked(on: boolean): void {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) this.releaseAll();
    this.onLockChange?.(on);
  }

  /** Use new bindings (array in KB order, '' = Not Bound). Called when settings change. */
  setBindings(codes: readonly string[]): void {
    this.binds = codes.slice();
    this.boundCodes = new Set(codes.filter((c) => c !== ''));
  }

  /** The code bound to an action ('' when Not Bound). */
  bound(action: number): string {
    return this.binds[action];
  }

  /** Is the action's binding held? */
  actionDown(action: number): boolean {
    if (this.toggled[action]) return this.latched[action];
    const c = this.binds[action];
    return this.virtDown[action] || (c !== '' && this.down.has(c));
  }

  /** Was the action's binding pressed this frame? */
  actionPressed(action: number): boolean {
    const c = this.binds[action];
    return this.virtPressed[action] || (c !== '' && this.pressed.has(c));
  }

  /** Attack/Destroy held (Left Button by default). */
  get leftDown(): boolean { return this.actionDown(KB.ATTACK); }
  /** Attack/Destroy pressed this frame. */
  get leftClicked(): boolean { return this.actionPressed(KB.ATTACK); }
  /** Use Item/Place Block held (Right Button by default). */
  get rightDown(): boolean { return this.actionDown(KB.USE); }
  /** Use Item/Place Block pressed this frame. */
  get rightClicked(): boolean { return this.actionPressed(KB.USE); }
  /** Pick Block pressed this frame (Middle Button by default). */
  get middleClicked(): boolean { return this.actionPressed(KB.PICK); }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  async requestLock(): Promise<void> {
    if (this.locked) return;
    if (this.softLock) {
      this.setSoftLocked(true);
      return;
    }
    try {
      // Raw (unaccelerated) mouse input where supported: lower latency, 1:1 aim.
      await (this.canvas.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void>)({ unadjustedMovement: true });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        // Browsers refuse re-locking for ~1s after ESC; the user can click again.
      }
    }
  }

  exitLock(): void {
    if (this.locked && document.pointerLockElement !== this.canvas) this.setSoftLocked(false);
    else if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.virtPressed.fill(false);
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }
}
