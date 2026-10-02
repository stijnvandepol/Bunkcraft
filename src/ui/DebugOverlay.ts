import { h } from './dom';

/**
 * F3 debug screen. Values are collected every frame by the game, but the DOM is only
 * rewritten 4× per second to keep layout work off the frame budget.
 */
export class DebugOverlay {
  readonly el: HTMLDivElement;
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private visible = false;
  private acc = 0;
  private frames = 0;
  private frameTimeSum = 0;
  private worstFrame = 0;
  fps = 0;
  frameMs = 0;
  worstMs = 0;

  constructor() {
    this.left = h('div', { class: 'debug-col' });
    this.right = h('div', { class: 'debug-col right' });
    this.el = h('div', { class: 'debug hidden' }, this.left, this.right);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Returns true when the text should be refreshed this frame. */
  tick(dt: number, cpuMs: number): boolean {
    this.frames++;
    this.frameTimeSum += cpuMs;
    this.worstFrame = Math.max(this.worstFrame, dt * 1000);
    this.acc += dt;
    if (this.acc < 0.25) return false;
    this.fps = Math.round(this.frames / this.acc);
    this.frameMs = this.frameTimeSum / this.frames;
    this.worstMs = this.worstFrame;
    this.acc = 0;
    this.frames = 0;
    this.frameTimeSum = 0;
    this.worstFrame = 0;
    return this.visible;
  }

  set(left: string[], right: string[]): void {
    this.left.replaceChildren(...left.map((l) => (l ? h('span', { text: l }) : h('br'))));
    this.right.replaceChildren(...right.map((l) => (l ? h('span', { text: l }) : h('br'))));
  }
}
