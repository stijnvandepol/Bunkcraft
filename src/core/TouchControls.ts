import { h } from '../ui/dom';
import type { Hotbar } from '../ui/Hotbar';
import { TouchHud } from '../ui/TouchHud';
import type { Input } from './Input';
import {
  HOLD_MS, TAP_MAX_MOVE, clampToRadius, isHold, isTap, joystickVector, pushSprints, slotAtX, touchLookDelta,
  type JoystickVec, type Vec2,
} from './InputMath';
import { KB } from './Keybinds';
import type { Settings } from './Settings';

/** What the game tells the touch controls every frame. */
export interface TouchContext {
  /** In the world with input captured (not in a menu, inventory or chat). */
  playing: boolean;
  arcade: boolean;
  /** Multiplayer chat is available. */
  chat: boolean;
  /** An overlay without its own close control is open (inventory, loadout, chat): show a Close button. */
  overlay: boolean;
}

/** Frames a tap stays pressed so the game loop sees it. */
const TAP_FRAMES = 2;
/** Joystick dead zone as a fraction of the base radius. */
const STICK_DEAD_ZONE = 0.12;

/**
 * Touch controls: a floating left joystick (move; push all the way for sprint), a look area on the
 * rest of the screen (drag to look, tap to use, press and hold to break), action buttons, a hotbar
 * you can tap or swipe, and menu buttons. Everything is translated into the same virtual actions
 * a keyboard produces (Input.setAction, Input.axis*), so the game logic is shared.
 *
 * Only active in touch mode (Input.touchMode): on touch-only devices from the start, otherwise after
 * the first touch, or always with Touch Controls: ON.
 */
export class TouchControls {
  readonly hud = new TouchHud();
  private settings!: Settings;
  private visible = false;

  // joystick
  private joyId = -1;
  private joyX = 0;
  private joyY = 0;
  private joyRadius = 60;
  private readonly joy: JoystickVec = { x: 0, y: 0, mag: 0 };
  private readonly knob: Vec2 = { x: 0, y: 0 };

  // look finger
  private lookId = -1;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookStartX = 0;
  private lookStartY = 0;
  private lookStartT = 0;
  private lookMoved = 0;
  private lookHolding = false;
  private readonly look: Vec2 = { x: 0, y: 0 };

  // buttons
  private readonly buttonPointers = new Map<number, string>();
  private sprintOn = false;
  private adsOn = false;
  private readonly taps: { action: number; frames: number }[] = [];

  /** Called when the Pause button is pressed. */
  onPause: (() => void) | null = null;
  /** Called when touch mode starts or ends (the GUI scale differs on touch screens). */
  onModeChange: (() => void) | null = null;
  /** Called when the Close button of an overlay is pressed. */
  onClose: (() => void) | null = null;
  private readonly closeBtn: HTMLButtonElement;
  private closeShownAt = 0;
  private wasTouch = false;

  constructor(root: HTMLElement, private readonly input: Input, private readonly hotbar: Hotbar) {
    root.append(this.hud.el);
    this.closeBtn = h('button', { class: 'tc-close hidden', type: 'button', 'aria-label': 'Close', text: 'X' });
    // A finger that opened the overlay must not close it with its own trailing click.
    this.closeBtn.addEventListener('click', () => {
      if (performance.now() - this.closeShownAt > 400) this.onClose?.();
    });
    root.append(this.closeBtn);
    const surface = this.hud.surface;
    surface.addEventListener('pointerdown', (e) => this.surfaceDown(e));
    surface.addEventListener('pointermove', (e) => this.surfaceMove(e));
    surface.addEventListener('pointerup', (e) => this.surfaceUp(e));
    surface.addEventListener('pointercancel', (e) => this.surfaceUp(e));
    surface.addEventListener('lostpointercapture', (e) => this.surfaceUp(e));

    for (const list of this.hud.buttons.values()) {
      for (const b of list) {
        b.addEventListener('pointerdown', (e) => this.buttonDown(e, b));
        b.addEventListener('pointerup', (e) => this.buttonUp(e));
        b.addEventListener('pointercancel', (e) => this.buttonUp(e));
        b.addEventListener('lostpointercapture', (e) => this.buttonUp(e));
        b.addEventListener('contextmenu', (e) => e.preventDefault());
      }
    }

    const bar = this.hotbar.el.querySelector<HTMLElement>('.hotbar');
    if (bar) {
      const pick = (e: PointerEvent) => {
        const r = bar.getBoundingClientRect();
        this.hotbar.select(slotAtX(e.clientX, r.left, r.width, 9));
      };
      bar.addEventListener('pointerdown', (e) => {
        if (!this.input.touchMode || e.pointerType === 'mouse') return;
        bar.setPointerCapture(e.pointerId);
        pick(e);
        e.preventDefault();
      });
      bar.addEventListener('pointermove', (e) => {
        if (bar.hasPointerCapture(e.pointerId)) pick(e);
      });
    }

    // Browser gestures that would steal touches: pinch zoom (iOS), long-press menu, scrolling.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => {
      if (this.input.touchMode) e.preventDefault();
    });
    root.addEventListener('touchmove', (e) => {
      if (this.visible && e.cancelable) e.preventDefault();
    }, { passive: false });
    window.addEventListener('blur', () => this.releaseAll());
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.hud.applySettings(s.touchOpacity, s.touchButtonScale, s.touchLeftHanded);
  }

  // ---------------------------------------------------------------- surface (joystick + look)

  private onStickSide(x: number): boolean {
    const w = window.innerWidth;
    return this.settings.touchLeftHanded ? x > w * 0.58 : x < w * 0.42;
  }

  private surfaceDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.input.touchMode) return;
    e.preventDefault();
    this.hud.surface.setPointerCapture(e.pointerId);
    if (this.joyId < 0 && this.onStickSide(e.clientX)) {
      this.joyId = e.pointerId;
      this.joyX = e.clientX;
      this.joyY = e.clientY;
      this.joyRadius = Math.max(30, this.hud.stickRadius);
      this.hud.showStick(this.joyX, this.joyY, true);
      this.applyStick(0, 0);
    } else if (this.lookId < 0 && !this.onStickSide(e.clientX)) {
      this.lookId = e.pointerId;
      this.lookLastX = this.lookStartX = e.clientX;
      this.lookLastY = this.lookStartY = e.clientY;
      this.lookStartT = e.timeStamp;
      this.lookMoved = 0;
      this.lookHolding = false;
    }
  }

  private surfaceMove(e: PointerEvent): void {
    if (e.pointerId === this.joyId) {
      this.applyStick(e.clientX - this.joyX, e.clientY - this.joyY);
    } else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lookLastX;
      const dy = e.clientY - this.lookLastY;
      this.lookLastX = e.clientX;
      this.lookLastY = e.clientY;
      this.lookMoved = Math.max(this.lookMoved, Math.hypot(e.clientX - this.lookStartX, e.clientY - this.lookStartY));
      touchLookDelta(dx, dy, this.settings.touchSensitivity, this.look);
      // Feeds the same accumulator as the mouse, so sensitivity, invert and the arcade scale all apply.
      this.input.mouseDX += this.look.x;
      this.input.mouseDY += this.look.y;
    }
  }

  private surfaceUp(e: PointerEvent): void {
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.hud.showStick(0, 0, false);
      this.applyStick(0, 0);
      this.sprintOn = false;
      this.hud.setPressed('sprint', false);
      this.input.sprintAxis = false;
    } else if (e.pointerId === this.lookId) {
      const dur = e.timeStamp - this.lookStartT;
      if (this.lookHolding) this.input.setAction(KB.ATTACK, false);
      else if (this.settings.touchGestures && isTap(dur, this.lookMoved)) this.tap(KB.USE);
      this.lookId = -1;
      this.lookHolding = false;
    }
  }

  private applyStick(dx: number, dy: number): void {
    joystickVector(dx, dy, this.joyRadius, STICK_DEAD_ZONE, this.joy);
    clampToRadius(dx, dy, this.joyRadius, this.knob);
    this.hud.moveKnob(this.knob.x, this.knob.y);
    this.input.axisStrafe = this.joy.x;
    this.input.axisForward = this.joy.y;
    this.input.sprintAxis = this.sprintOn || (this.settings.touchSprintPush && pushSprints(this.joy));
  }

  // ---------------------------------------------------------------- buttons

  private tap(action: number): void {
    this.input.setAction(action, true);
    this.taps.push({ action, frames: TAP_FRAMES });
  }

  private buttonDown(e: PointerEvent, b: HTMLButtonElement): void {
    if (e.pointerType === 'mouse' && !this.input.touchMode) return;
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    const id = b.dataset.id ?? '';
    this.buttonPointers.set(e.pointerId, id);
    this.hud.setPressed(id, true);
    const input = this.input;
    switch (id) {
      case 'jump': input.setAction(KB.JUMP, true); break;
      case 'sneak': input.setAction(KB.SNEAK, true); break;
      case 'attack': input.setAction(KB.ATTACK, true); break;
      case 'use':
        if (this.hud.el.classList.contains('arcade')) {
          // Aim down sights is a toggle on touch: a thumb cannot hold two buttons and shoot.
          this.adsOn = !this.adsOn;
          input.setAction(KB.USE, this.adsOn);
        } else input.setAction(KB.USE, true);
        break;
      case 'sprint':
        this.sprintOn = !this.sprintOn;
        input.sprintAxis = this.sprintOn;
        break;
      case 'scoreboard': input.setAction(KB.SCOREBOARD, true); break;
      case 'inventory': this.tap(KB.INVENTORY); break;
      case 'chat': this.tap(KB.CHAT); break;
      case 'reload': this.tap(KB.RELOAD); break;
      case 'swap': this.tap(KB.QUICK_SWITCH); break;
      case 'loadout': this.tap(KB.LOADOUT); break;
      case 'pause': this.onPause?.(); break;
      case 'fullscreen': toggleFullscreen(); break;
    }
  }

  private buttonUp(e: PointerEvent): void {
    const id = this.buttonPointers.get(e.pointerId);
    if (id === undefined) return;
    this.buttonPointers.delete(e.pointerId);
    const input = this.input;
    switch (id) {
      case 'jump': input.setAction(KB.JUMP, false); break;
      case 'sneak': input.setAction(KB.SNEAK, false); break;
      case 'attack': input.setAction(KB.ATTACK, false); break;
      case 'use': if (!this.hud.el.classList.contains('arcade')) input.setAction(KB.USE, false); break;
      case 'scoreboard': input.setAction(KB.SCOREBOARD, false); break;
    }
    // Sprint and aim stay lit while toggled on.
    this.hud.setPressed(id, (id === 'sprint' && this.sprintOn) || (id === 'use' && this.adsOn));
  }

  // ---------------------------------------------------------------- frame

  /** Called once per frame before the game reads the input. */
  update(_dt: number, ctx: TouchContext): void {
    const touch = this.input.touchMode;
    if (touch !== this.wasTouch) {
      this.wasTouch = touch;
      document.body.classList.toggle('touch-ui', touch);
      this.onModeChange?.();
    }
    const showClose = touch && ctx.overlay;
    if (showClose && this.closeBtn.classList.contains('hidden')) this.closeShownAt = performance.now();
    this.closeBtn.classList.toggle('hidden', !showClose);
    const show = touch && ctx.playing;
    if (show !== this.visible) {
      this.visible = show;
      this.hud.setVisible(show);
      if (!show) this.releaseAll();
    }
    if (!show) return;
    this.hud.setArcade(ctx.arcade);
    this.hud.setChatAvailable(ctx.chat);
    if (!ctx.arcade && this.adsOn) this.adsOn = false;

    // Orientation hint in portrait.
    const portrait = window.innerHeight > window.innerWidth;
    this.hud.hint.classList.toggle('hidden', !portrait || this.hud.hint.classList.contains('dismissed'));

    for (let i = this.taps.length - 1; i >= 0; i--) {
      const t = this.taps[i];
      if (--t.frames <= 0) {
        this.input.setAction(t.action, false);
        this.taps.splice(i, 1);
      }
    }

    // Press and hold on the view breaks blocks / attacks.
    if (this.lookId >= 0 && !this.lookHolding && this.settings.touchGestures) {
      const dur = performance.now() - this.lookStartT;
      if (dur >= HOLD_MS && isHold(dur, this.lookMoved) && this.lookMoved <= TAP_MAX_MOVE) {
        this.lookHolding = true;
        this.input.setAction(KB.ATTACK, true);
      }
    }
  }

  /** Let go of everything (HUD hidden, window blurred, lock lost). */
  releaseAll(): void {
    this.joyId = this.lookId = -1;
    this.lookHolding = false;
    this.sprintOn = false;
    this.adsOn = false;
    this.buttonPointers.clear();
    this.taps.length = 0;
    this.hud.showStick(0, 0, false);
    for (const id of ['jump', 'sneak', 'attack', 'use', 'sprint']) this.hud.setPressed(id, false);
    for (const a of [KB.JUMP, KB.SNEAK, KB.ATTACK, KB.USE, KB.SCOREBOARD]) this.input.setAction(a, false);
    this.input.axisForward = this.input.axisStrafe = 0;
    this.input.sprintAxis = false;
  }
}

/** Fullscreen with a landscape lock where the browser allows it. */
export function toggleFullscreen(): void {
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || doc.webkitFullscreenElement) {
    void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    return;
  }
  const req = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
  void Promise.resolve(req).then(() => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    return o?.lock?.('landscape');
  }).catch(() => undefined);
}
