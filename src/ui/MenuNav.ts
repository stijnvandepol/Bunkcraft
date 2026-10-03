import { type NavDir, type NavRect, nextFocus } from '../core/InputMath';

const FOCUSABLE = 'button:not(:disabled), input[type="range"], input[type="text"], a[href], [role="button"][tabindex="0"]';

/**
 * Focus-ring navigation for the DOM menus, driven by a controller (d-pad / stick + A) or the arrow
 * keys. Moves real DOM focus between the visible controls of the top screen using the spatial
 * rule in InputMath.nextFocus; sliders are adjusted with left/right instead of moving. The ring
 * is the `.pad-focus` class (always visible, unlike :focus-visible after a mouse click).
 */
export class MenuNav {
  private current: HTMLElement | null = null;
  private lastRoot: HTMLElement | null = null;
  private keyHeldSince = 0;

  constructor(
    private readonly getRoot: () => HTMLElement | undefined,
    private readonly getRepeatDelay: () => number,
  ) {}

  /** Arrow keys move the ring too; held keys wait for the configured repeat delay first. */
  attachKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const dir = e.code === 'ArrowUp' ? 'up' : e.code === 'ArrowDown' ? 'down' : e.code === 'ArrowLeft' ? 'left' : e.code === 'ArrowRight' ? 'right' : null;
      if (!dir || !this.getRoot()) return;
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement && t.type === 'text') return;
      if (t instanceof HTMLInputElement && t.type === 'range' && (dir === 'left' || dir === 'right')) return; // native slider keys
      e.preventDefault();
      const now = performance.now();
      if (!e.repeat) this.keyHeldSince = now;
      else if (now - this.keyHeldSince < this.getRepeatDelay()) return;
      this.move(dir);
    });
  }

  private candidates(root: HTMLElement): HTMLElement[] {
    const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (root.matches(FOCUSABLE)) all.unshift(root);
    return all.filter((el) => el.offsetParent !== null && el.getClientRects().length > 0);
  }

  /** Drop the ring (screen changed, mouse used). */
  clear(): void {
    this.current?.classList.remove('pad-focus');
    this.current = null;
  }

  private focus(el: HTMLElement): void {
    this.current?.classList.remove('pad-focus');
    this.current = el;
    el.classList.add('pad-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  private resolve(): { root: HTMLElement; list: HTMLElement[]; idx: number } | null {
    const root = this.getRoot();
    if (!root) return null;
    if (root !== this.lastRoot) {
      this.clear();
      this.lastRoot = root;
    }
    const list = this.candidates(root);
    if (list.length === 0) return null;
    const idx = this.current ? list.indexOf(this.current) : -1;
    if (idx < 0) this.clear();
    return { root, list, idx };
  }

  move(dir: NavDir): void {
    const r = this.resolve();
    if (!r) return;
    if (r.idx < 0) {
      this.focus(r.list[0]);
      return;
    }
    const cur = r.list[r.idx];
    if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'left') cur.stepDown();
      else cur.stepUp();
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const rects: NavRect[] = r.list.map((el) => el.getBoundingClientRect());
    const next = nextFocus(rects, r.idx, dir);
    if (next >= 0) this.focus(r.list[next]);
  }

  /** A button: press the focused control (focus the first one when nothing is focused yet). */
  activate(): void {
    const r = this.resolve();
    if (!r) return;
    if (r.idx < 0) {
      this.focus(r.list[0]);
      // A screen with a single control ("Click to play") needs no separate focus step.
      if (r.list.length === 1) r.list[0].click();
      return;
    }
    r.list[r.idx].click();
  }
}
