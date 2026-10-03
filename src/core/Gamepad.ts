import type { MenuNav } from '../ui/MenuNav';
import type { Input } from './Input';
import {
  PAD, TRIGGER_THRESHOLD, padBindingsFor, padLookDelta, pushSprints, repeatStep, stickAxes, stickVector,
  type NavDir, type PadBinding, type Vec2,
} from './InputMath';
import type { Settings } from './Settings';

/** What the game tells the controller every frame. */
export interface PadContext {
  state: string;
  /** In the world with input captured. */
  playing: boolean;
  arcade: boolean;
}

export interface PadHooks {
  /** Start button in the world (pause) or in a screen (resume). */
  start(): void;
  /** B / Back in menus and overlays. */
  back(): void;
  /** Controller plugged in or out. */
  onConnection(name: string, connected: boolean): void;
}

const STICK_ACTIVITY = 0.45;
/** How often to look for a controller that never fired a connect event (seconds). */
const SCAN_INTERVAL = 1;
/** Menu navigation repeat interval once a direction is held (ms). */
const MENU_REPEAT_RATE = 110;

interface PadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
}

/**
 * Gamepad API support (standard mapping). In the world, sticks move and look with dead zone and
 * response curve, and buttons become the same virtual actions as keys (see PAD_BINDINGS). In
 * menus the d-pad and left stick move a focus ring and A presses. Hot-plug aware; rumble where the
 * browser exposes `vibrationActuator`.
 */
export class GamepadController {
  private pad: PadLike | null = null;
  private padIndex = -1;
  private scanTimer = 0;
  private readonly prev: boolean[] = new Array(20).fill(false);
  private readonly stick: Vec2 = { x: 0, y: 0 };
  private readonly look: Vec2 = { x: 0, y: 0 };
  private readonly lookDelta: Vec2 = { x: 0, y: 0 };
  private bindings: PadBinding[] = padBindingsFor(false);
  private bindingsArcade = false;
  /** Menu navigation: how long each direction has been held (ms, -1 = not held). */
  private readonly held: Record<NavDir, number> = { up: -1, down: -1, left: -1, right: -1 };
  private readonly heldPrev: Record<NavDir, number> = { up: -1, down: -1, left: -1, right: -1 };
  /** The pad had no stick/button input yet this session (activity detection for padMode). */
  private wasPlaying = false;

  constructor(
    private readonly input: Input,
    private settings: Settings,
    private readonly nav: MenuNav,
    private readonly hooks: PadHooks,
  ) {
    window.addEventListener('gamepadconnected', (e) => this.connect(e.gamepad as PadLike));
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.padIndex) this.disconnect();
    });
  }

  applySettings(s: Settings): void {
    this.settings = s;
  }

  get connected(): boolean {
    return this.pad !== null;
  }

  get name(): string {
    return this.pad?.id ?? '';
  }

  private connect(pad: PadLike): void {
    if (this.pad) return;
    this.pad = pad;
    this.padIndex = pad.index;
    this.prev.fill(false);
    this.hooks.onConnection(cleanName(pad.id), true);
  }

  private disconnect(): void {
    const name = this.pad ? cleanName(this.pad.id) : '';
    this.pad = null;
    this.padIndex = -1;
    this.input.axisForward = this.input.axisStrafe = 0;
    this.input.sprintAxis = false;
    for (const b of padBindingsFor(false).concat(padBindingsFor(true))) this.input.setAction(b.action, false);
    this.hooks.onConnection(name, false);
  }

  private poll(): PadLike | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const list = navigator.getGamepads() as readonly (PadLike | null)[];
    if (this.pad) {
      const fresh = list[this.padIndex];
      if (!fresh || !fresh.connected) {
        this.disconnect();
        return null;
      }
      this.pad = fresh;
      return fresh;
    }
    return null;
  }

  /** Called every frame before the game reads input. */
  update(dt: number, ctx: PadContext): void {
    if (!this.settings.padEnabled) return;
    if (!this.pad) {
      // Some browsers only announce a controller after the first button press; others never fire the event.
      this.scanTimer -= dt;
      if (this.scanTimer > 0 || typeof navigator.getGamepads !== 'function') return;
      this.scanTimer = SCAN_INTERVAL;
      for (const p of navigator.getGamepads() as readonly (PadLike | null)[]) {
        if (p && p.connected && p.buttons.length >= 12) {
          this.connect(p);
          break;
        }
      }
      if (!this.pad) return;
    }
    const pad = this.poll();
    if (!pad) return;

    const s = this.settings;
    const axes = stickAxes(s.padLayout === 'southpaw');
    const ax = (i: number) => pad.axes[i] ?? 0;
    const down = (i: number) => {
      const b = pad.buttons[i];
      return b ? (i === PAD.LT || i === PAD.RT ? b.value > TRIGGER_THRESHOLD || b.pressed : b.pressed) : false;
    };

    // Any real input makes the pad the active device: no Pointer Lock needed.
    const rawMag = Math.hypot(ax(axes.move[0]), ax(axes.move[1]));
    const rawLook = Math.hypot(ax(axes.look[0]), ax(axes.look[1]));
    let active = rawMag > STICK_ACTIVITY || rawLook > STICK_ACTIVITY;
    for (let i = 0; i < 16 && !active; i++) active = down(i);
    if (active && !this.input.touchMode && !this.input.padMode) this.input.padMode = true;

    if (ctx.playing) {
      this.updatePlaying(dt, ctx, pad, axes, rawMag, ax, down);
      this.wasPlaying = true;
    } else {
      if (this.wasPlaying) this.releaseGameplay();
      this.wasPlaying = false;
      this.updateMenus(dt, ctx, down, ax, axes.move);
    }
    for (let i = 0; i < 16; i++) this.prev[i] = down(i);
  }

  private updatePlaying(
    dt: number, ctx: PadContext, _pad: PadLike, axes: ReturnType<typeof stickAxes>, rawMag: number,
    ax: (i: number) => number, down: (i: number) => boolean,
  ): void {
    const s = this.settings;
    const input = this.input;
    const dz = s.padDeadZone / 100;

    stickVector(ax(axes.move[0]), ax(axes.move[1]), dz, s.stickCurve, this.stick);
    input.axisStrafe = this.stick.x;
    input.axisForward = -this.stick.y;
    const fwd = rawMag > 0 ? -ax(axes.move[1]) / rawMag : 0;
    input.sprintAxis = pushSprints({ y: fwd, mag: rawMag }, 0.92);

    stickVector(ax(axes.look[0]), ax(axes.look[1]), dz, s.stickCurve, this.look);
    padLookDelta(this.look, dt, s.padSensitivity, s.padInvertY, this.lookDelta);
    input.mouseDX += this.lookDelta.x;
    input.mouseDY += this.lookDelta.y;

    if (this.bindingsArcade !== ctx.arcade) {
      this.bindingsArcade = ctx.arcade;
      // Release what the old layout held before switching.
      this.releaseGameplay();
      this.bindings = padBindingsFor(ctx.arcade);
    }
    for (const b of this.bindings) {
      const d = down(b.button);
      if (d !== this.prev[b.button]) input.setAction(b.action, d);
    }
    // Hotbar / weapon cycling.
    const edge = (i: number) => down(i) && !this.prev[i];
    if (edge(PAD.RB) || edge(PAD.RIGHT)) input.wheel += 1;
    if (edge(PAD.LB) || edge(PAD.LEFT)) input.wheel -= 1;
    if (edge(PAD.START)) this.hooks.start();
  }

  private releaseGameplay(): void {
    const input = this.input;
    for (const b of padBindingsFor(false).concat(padBindingsFor(true))) input.setAction(b.action, false);
    input.axisForward = input.axisStrafe = 0;
    input.sprintAxis = false;
  }

  private updateMenus(
    dt: number, ctx: PadContext, down: (i: number) => boolean, ax: (i: number) => number, moveAxes: [number, number],
  ): void {
    const edge = (i: number) => down(i) && !this.prev[i];
    if (edge(PAD.START)) this.hooks.start();
    if (edge(PAD.B)) this.hooks.back();
    // Inventories and chat are not driven by the focus ring: they close with B/Start (above).
    if (ctx.state === 'inventory' || ctx.state === 'chat' || ctx.state === 'loading') return;

    const x = ax(moveAxes[0]), y = ax(moveAxes[1]);
    const want: Record<NavDir, boolean> = {
      up: down(PAD.UP) || y < -0.6,
      down: down(PAD.DOWN) || y > 0.6,
      left: down(PAD.LEFT) || x < -0.6,
      right: down(PAD.RIGHT) || x > 0.6,
    };
    const dtMs = dt * 1000;
    const delay = this.settings.menuRepeatDelay;
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      this.heldPrev[dir] = this.held[dir];
      this.held[dir] = want[dir] ? Math.max(0, this.held[dir] + (this.held[dir] < 0 ? 0 : dtMs)) : -1;
      if (repeatStep(this.held[dir], this.heldPrev[dir], delay, MENU_REPEAT_RATE)) this.nav.move(dir);
    }
    if (edge(PAD.A)) this.nav.activate();
  }

  /** Short vibration (damage, explosions, hit markers). `strong` and `weak` are 0..1. */
  rumble(strong: number, weak: number, ms: number): void {
    if (!this.pad || !this.settings.padRumble || !this.settings.padEnabled) return;
    const act = this.pad.vibrationActuator;
    if (!act?.playEffect) return;
    try {
      void act.playEffect('dual-rumble', {
        startDelay: 0, duration: Math.max(10, Math.round(ms)),
        strongMagnitude: Math.min(1, Math.max(0, strong)), weakMagnitude: Math.min(1, Math.max(0, weak)),
      }).catch(() => undefined);
    } catch {
      // Unsupported effect type.
    }
  }
}

/** "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)" → "Xbox 360 Controller". */
export function cleanName(id: string): string {
  const name = id.replace(/\s*\(.*\)\s*$/, '').trim();
  return name || 'Controller';
}
