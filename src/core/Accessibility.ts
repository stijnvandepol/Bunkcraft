import type { Settings } from './Settings';

/**
 * Accessibility helpers: photosensitivity limits, subtitle direction arrows, colour-blind palettes
 * and the document classes the stylesheet keys off. Pure functions are unit tested
 * (tests/accessibility.test.ts).
 */

// ------------------------------------------------------------------ flashes

/** Peak alpha of a full-screen flash when "Reduce Flashes" is on (WCAG: no large flashes above ~25%). */
export const REDUCED_FLASH_MAX = 0.25;
/** At most this many flashes per second with "Reduce Flashes" on (WCAG 2.3.1: three per second). */
export const MAX_FLASHES_PER_SECOND = 3;

/**
 * Cap the intensity (0..1) of a full-screen flash such as lightning or an explosion. Weather and
 * effect code calls this with the intensity it wants and draws the result:
 * `overlay.style.opacity = String(limitFlash(1, settings))`.
 */
export function limitFlash(intensity: number, s: Pick<Settings, 'reduceFlashes'>): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  return s.reduceFlashes ? Math.min(v, REDUCED_FLASH_MAX) : v;
}

/**
 * Rate limiter for flashes: `allow(now)` is false when another flash would exceed
 * {@link MAX_FLASHES_PER_SECOND} in the last second. Always allows when Reduce Flashes is off.
 */
export class FlashLimiter {
  private readonly times: number[] = [];

  allow(nowSec: number, s: Pick<Settings, 'reduceFlashes'>): boolean {
    if (!s.reduceFlashes) return true;
    while (this.times.length > 0 && nowSec - this.times[0] >= 1) this.times.shift();
    if (this.times.length >= MAX_FLASHES_PER_SECOND) return false;
    this.times.push(nowSec);
    return true;
  }
}

// ------------------------------------------------------------------ subtitles

/** Sounds closer than this (blocks) get no direction arrow. */
export const SUBTITLE_NEAR = 2.5;

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/**
 * Direction arrow for a sound at world offset (dx, dz) from the listener who looks along `yaw`
 * (the player's yaw: forward is (−sin yaw, −cos yaw)). '' when the sound is right at the listener.
 */
export function soundArrow(dx: number, dz: number, yaw: number): string {
  if (Math.hypot(dx, dz) < SUBTITLE_NEAR) return '';
  const forward = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  const angle = Math.atan2(right, forward); // 0 = ahead, positive = to the right
  const sector = Math.round(angle / (Math.PI / 4));
  return ARROWS[((sector % 8) + 8) % 8];
}

/** The text of one subtitle line: "[Zombie groans]", with the arrow on the side it came from. */
export function subtitleText(label: string, arrow: string): string {
  const text = `[${label}]`;
  if (arrow === '←' || arrow === '↖' || arrow === '↙') return `${arrow} ${text}`;
  if (arrow === '→' || arrow === '↗' || arrow === '↘') return `${text} ${arrow}`;
  return arrow ? `${arrow} ${text}` : text;
}

// ------------------------------------------------------------------ colour-blind palettes

export interface Palette {
  /** Team colours (red/blue by default). */
  teamA: string;
  teamB: string;
  health: string;
  healthHi: string;
  hunger: string;
  hungerHi: string;
}

/** Original colours. */
export const DEFAULT_PALETTE: Palette = {
  teamA: '#e0463c', teamB: '#3c7ae0',
  health: '#d8221d', healthHi: '#f15b52', hunger: '#a8642e', hungerHi: '#d18a49',
};

/**
 * Safe for protan/deutan/tritan vision (Okabe–Ito based): teams blue vs orange, health in a bright
 * magenta-pink that stays distinct from the brown/yellow hunger bar by lightness as well as hue.
 */
export const SAFE_PALETTE: Palette = {
  teamA: '#ff9a1f', teamB: '#3d8bff',
  health: '#d6217f', healthHi: '#ff6fb3', hunger: '#e8c61c', hungerHi: '#fff07a',
};

export function paletteFor(colorBlindSafe: boolean): Palette {
  return colorBlindSafe ? SAFE_PALETTE : DEFAULT_PALETTE;
}

/** Team shape marker so teams never rely on colour alone (scoreboards, kill feed). */
export const TEAM_MARKS: Record<'red' | 'blue', string> = { red: '▲', blue: '●' };

// ------------------------------------------------------------------ document state

/** Mirror the accessibility settings onto <html>/<body> as classes and CSS variables. */
export function applyAccessibilityDocument(s: Settings, doc: Document = document): void {
  const b = doc.body;
  b.classList.toggle('reduced-motion', s.reducedMotion);
  b.classList.toggle('high-contrast', s.highContrast);
  b.classList.toggle('cb-safe', s.colorBlindSafe);
  b.classList.toggle('big-text', s.textScale > 100);
  doc.documentElement.style.setProperty('--ts', String(s.textScale / 100));
}

/** Effective particle level: reduced motion forces at most "decreased". */
export function effectiveParticles(s: Pick<Settings, 'particles' | 'reducedMotion'>): Settings['particles'] {
  return s.reducedMotion && s.particles === 'all' ? 'decreased' : s.particles;
}
