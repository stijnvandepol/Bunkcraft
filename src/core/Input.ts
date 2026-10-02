/** Keys the game consumes; their browser default (scrolling, find, …) is suppressed. */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyE', 'KeyQ',
  'F1', 'F3', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

/**
 * Keyboard/mouse state with per-frame edge detection. Mouse movement is accumulated
 * between frames and consumed once per frame, so look input is never dropped.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  leftDown = false;
  rightDown = false;
  leftClicked = false;
  rightClicked = false;
  middleClicked = false;
  locked = false;
  /** Fires on every keydown (used for UI shortcuts like ESC, E, F3). */
  onKeyDown: ((code: string, e: KeyboardEvent) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code) && (this.locked || e.code === 'F3' || e.code === 'F1')) e.preventDefault();
      if (!e.repeat) {
        this.down.add(e.code);
        this.pressed.add(e.code);
      }
      this.onKeyDown?.(e.code, e);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.leftDown = this.rightDown = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.leftDown = true; this.leftClicked = true; }
      if (e.button === 2) { this.rightDown = true; this.rightClicked = true; }
      if (e.button === 1) { this.middleClicked = true; e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.down.clear();
        this.leftDown = this.rightDown = false;
      }
      this.onLockChange?.(this.locked);
    });
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  async requestLock(): Promise<void> {
    if (this.locked) return;
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
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.leftClicked = this.rightClicked = this.middleClicked = false;
  }
}
