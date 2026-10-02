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
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /**
   * Fires on every keydown, and on mouse button presses while locked (used for UI
   * shortcuts like ESC, inventory, F3). Mouse buttons arrive as "Mouse<button>".
   */
  onKeyDown: ((code: string, e: KeyboardEvent | MouseEvent) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
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
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = MOUSE_CODES[e.button];
      if (!code) return;
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
      if (!this.locked) {
        this.down.clear();
      }
      this.onLockChange?.(this.locked);
    });
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
    const c = this.binds[action];
    return c !== '' && this.down.has(c);
  }

  /** Was the action's binding pressed this frame? */
  actionPressed(action: number): boolean {
    const c = this.binds[action];
    return c !== '' && this.pressed.has(c);
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

  /** Raw (unaccelerated) mouse input where supported; the Options > Mouse Settings toggle. */
  rawInput = true;

  async requestLock(): Promise<void> {
    if (this.locked) return;
    try {
      // Raw (unaccelerated) mouse input where supported: lower latency, 1:1 aim.
      await (this.canvas.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void>)({ unadjustedMovement: this.rawInput });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        // Browsers refuse re-locking for ~1s after ESC; the user can click again.
      }
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }
}
