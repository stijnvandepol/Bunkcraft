import * as THREE from 'three';

/** At most this many opponents are marked by one radar sweep. */
const MAX_PINGS = 16;
const tmp = new THREE.Vector3();

/**
 * Killstreak radar sweep (server message `radar`): a red diamond over every opponent's last known position,
 * fading out over the sweep's lifetime. A fixed pool of elements, positioned per frame without allocation.
 */
export class RadarPings {
  readonly el: HTMLDivElement;
  private readonly dots: HTMLDivElement[] = [];
  private readonly xs = new Float64Array(MAX_PINGS);
  private readonly zs = new Float64Array(MAX_PINGS);
  private count = 0;
  private until = 0;
  private sec = 1;
  private shown = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'arc-radar';
    this.el.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    for (let i = 0; i < MAX_PINGS; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;left:0;top:0;width:calc(var(--s,2px)*6);height:calc(var(--s,2px)*6);'
        + 'margin:calc(var(--s,2px)*-3) 0 0 calc(var(--s,2px)*-3);background:#ff3b3b;border:calc(var(--s,2px)*0.5) solid #fff;'
        + 'transform-origin:50% 50%;box-shadow:0 0 calc(var(--s,2px)*3) #ff3b3b;display:none';
      this.dots.push(d);
      this.el.append(d);
    }
  }

  /** A sweep: flat x, z pairs at feet height `y` (the arena floor), shown for `sec` seconds from `now`. */
  show(pts: readonly number[], y: number, sec: number, now: number): void {
    this.count = Math.min(MAX_PINGS, pts.length >> 1);
    for (let i = 0; i < this.count; i++) { this.xs[i] = pts[i * 2]; this.zs[i] = pts[i * 2 + 1]; }
    this.until = now + sec;
    this.sec = sec;
    this.y = y;
  }

  private y = 0;

  /** Per frame: project the pings (hidden behind the camera or after the sweep). */
  frame(now: number, camera: THREE.Camera, width: number, height: number): void {
    const left = this.until - now;
    const n = left > 0 ? this.count : 0;
    const alpha = left > 0 ? Math.min(1, left / (this.sec * 0.4)) : 0;
    for (let i = 0; i < MAX_PINGS; i++) {
      const d = this.dots[i];
      if (i >= n) {
        if (i < this.shown) d.style.display = 'none';
        continue;
      }
      tmp.set(this.xs[i], this.y + 1, this.zs[i]).project(camera);
      if (tmp.z > 1) { d.style.display = 'none'; continue; }
      const x = Math.max(8, Math.min(width - 8, ((tmp.x + 1) / 2) * width)), yy = Math.max(8, Math.min(height - 8, ((1 - tmp.y) / 2) * height));
      d.style.display = 'block';
      d.style.opacity = String(Math.round(alpha * 100) / 100);
      d.style.transform = `translate(${Math.round(x)}px, ${Math.round(yy)}px) rotate(45deg)`;
    }
    this.shown = n;
  }
}
