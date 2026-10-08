/**
 * Reticles of the magnified optics (the scope overlay), drawn as SVG so every line stays crisp at any screen size. Pure string
 * building plus the ranging math, no DOM: the HUD puts the markup in place, the unit tests check the geometry
 * (tests/aimFeel.test.ts).
 *
 * Lens units: the SVG's view box is -1000..1000 on both axes, 1000 = the lens radius. The centre (0, 0) is the exact aim point
 * (the screen centre, where the bullets go); the reticle never moves off it.
 *
 * - Sniper scope: duplex (heavy outer posts, fine inner lines) with mil-dots, a clear centre with a lit red dot.
 * - Combat scope: a lit red chevron whose tip is the aim point, fine lines with mil ticks, and range stadia under the centre
 *   in bullet-drop style. Bullets fly straight (hitscan), so the stadia are not hold-overs: each bar is as wide as a player
 *   (HITBOX.width) at the distance written next to it. Fit a target's shoulders to a bar to read its range.
 */
import { HITBOX } from '../modes/Weapons';

export type ScopeKind = 'scope' | 'combat';

/** Lens radius as a share of the screen height, per kind (the CSS `--r` matches). */
export const LENS_RADIUS: Record<ScopeKind, number> = { scope: 0.42, combat: 0.47 };

/** Distances (blocks) of the combat scope's range stadia, top to bottom. */
export const STADIA_RANGES = [25, 50, 75, 100] as const;

export interface StadiaMark {
  dist: number;
  /** Half width of the bar and its distance below the centre, in lens units (1 = lens radius). */
  half: number;
  y: number;
}

/**
 * Screen distance from the centre of a direction `angle` radians off the view axis, in lens units, for a vertical field of view
 * `fovDeg` and a lens of `lensRadius` × screen height.
 */
export function angleToLens(angle: number, fovDeg: number, lensRadius: number): number {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return Math.tan(angle) / half / (2 * lensRadius);
}

/** The combat scope's stadia for a field of view: bar half widths that match a player's width at each range. */
export function rangeStadia(fovDeg: number, lensRadius = LENS_RADIUS.combat): StadiaMark[] {
  return STADIA_RANGES.map((dist, i) => ({
    dist,
    half: angleToLens(Math.atan(HITBOX.width / 2 / dist), fovDeg, lensRadius),
    y: 0.15 + i * 0.085,
  }));
}

/** Magnification of a zoomed view compared with the hip view (tangent ratio of the half angles), e.g. 4.5 for "4.5x". */
export function magnification(baseFovDeg: number, zoom: number): number {
  const half = (baseFovDeg * Math.PI) / 360;
  return Math.tan(half) / Math.tan(half * Math.max(0.01, Math.min(1, zoom)));
}

const n = (v: number): string => String(Math.round(v * 10) / 10);
const line = (x1: number, y1: number, x2: number, y2: number, w: number, color = '#060606'): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="${w}" vector-effect="non-scaling-stroke"/>`;

/** Mil-dot spacing of the sniper scope (lens units) and the gap left clear around the centre. */
export const MIL_STEP = 100;
export const CLEAR_CENTRE = 22;

function sniperSvg(): string {
  const parts: string[] = [];
  // Heavy outer posts (left, right, bottom; a thinner one on top) lead the eye to the centre from the lens edge.
  parts.push(`<rect x="-1000" y="-9" width="440" height="18" fill="#060606"/>`, `<rect x="560" y="-9" width="440" height="18" fill="#060606"/>`);
  parts.push(`<rect x="-9" y="560" width="18" height="440" fill="#060606"/>`, `<rect x="-5" y="-1000" width="10" height="440" fill="#060606"/>`);
  // Fine inner lines, clear in the middle.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) parts.push(line(dx * CLEAR_CENTRE, dy * CLEAR_CENTRE, dx * 560, dy * 560, 1.2));
  // Mil-dots (oval along the line, like the real ones) and half-mil hashes.
  for (let i = 1; i <= 5; i++) {
    const d = i * MIL_STEP;
    for (const s of [-1, 1]) {
      parts.push(`<ellipse cx="${s * d}" cy="0" rx="9" ry="6" fill="#060606"/>`, `<ellipse cx="0" cy="${s * d}" rx="6" ry="9" fill="#060606"/>`);
      if (i < 5) {
        const hd = d + MIL_STEP / 2;
        parts.push(line(s * hd, -10, s * hd, 10, 1), line(-10, s * hd, 10, s * hd, 1));
      }
    }
  }
  // The lit centre: a small red dot in the clear middle, the aim point.
  parts.push(`<circle cx="0" cy="0" r="12" fill="rgba(255,60,40,0.35)"/>`, `<circle cx="0" cy="0" r="5.5" fill="#ff3b26"/>`);
  return parts.join('');
}

function combatSvg(fovDeg: number): string {
  const parts: string[] = [];
  // Fine horizontal line with mil ticks (a long one every fifth), broken around the chevron.
  parts.push(line(-930, 0, -90, 0, 1.2), line(90, 0, 930, 0, 1.2));
  for (let i = 2; i <= 18; i++) {
    const x = i * 50;
    const long = i % 5 === 0;
    for (const s of [-1, 1]) parts.push(line(s * x, 0, s * x, long ? -34 : -16, long ? 1.4 : 1));
  }
  // Vertical post from below the stadia to the lens edge, and a thin line up to the stadia.
  parts.push(line(0, 110, 0, 930, 1.2), `<rect x="-7" y="560" width="14" height="440" fill="#060606"/>`);
  // Range stadia: bars the width of a player at their distance, with the distance next to them.
  for (const m of rangeStadia(fovDeg)) {
    const y = m.y * 1000, half = Math.max(6, m.half * 1000);
    parts.push(line(-half, y, half, y, 2.2, '#0a0a0a'));
    parts.push(`<text x="${n(half + 18)}" y="${n(y + 12)}" class="st">${m.dist}</text>`);
  }
  // The lit chevron: its tip is the aim point.
  parts.push(
    `<path d="M0 0 L-46 78 L-30 78 L0 26 L30 78 L46 78 Z" fill="#ff4a2e" stroke="rgba(255,90,60,0.55)" stroke-width="3" vector-effect="non-scaling-stroke"/>`,
    `<circle cx="0" cy="0" r="3.2" fill="#ffd0c4"/>`,
  );
  return parts.join('');
}

/** The reticle markup (an `<svg>` element) for an optic at a field of view (only the combat scope's stadia depend on it). */
export function scopeReticleSvg(kind: ScopeKind, fovDeg: number): string {
  const body = kind === 'combat' ? combatSvg(fovDeg) : sniperSvg();
  return `<svg viewBox="-1000 -1000 2000 2000" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision">${body}</svg>`;
}
