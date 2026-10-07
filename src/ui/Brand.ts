/**
 * BunkCraft's visual identity as data: the colour tokens, the emblem (a voxel cube inside a reticle) and the
 * wordmark (heavy slanted block letters), all drawn in code as SVG so the menu, the favicon, the PWA icons and
 * the social preview share one source. No DOM here: scripts/make-icons.ts imports it under Node.
 * See docs/research/IDENTITY.md for the reasoning.
 */

export const BRAND = {
  /** Background ink, from deepest to raised. */
  ink0: '#07090d',
  ink1: '#0e1218',
  ink2: '#161c25',
  ink3: '#232b37',
  text: '#eef2f6',
  dim: '#9aa6b5',
  /** Primary accent ("volt"): PLAY, XP, focus, live counts. */
  volt: '#d4ff3a',
  voltMid: '#a8d61c',
  voltDark: '#6f9410',
  /** Secondary accent: codes, info. */
  cyan: '#4ad8ff',
  danger: '#ff5a5f',
} as const;

export const TAGLINE = { en: 'Voxel arena shooter', nl: 'Voxel-arenashooter' } as const;

/**
 * The emblem in a 64×64 box: an isometric cube (three volt shades) with a reticle centred on its front corner.
 * `bg` draws a rounded ink tile behind it (icons); without it the emblem is transparent (logo lock-up).
 */
export function emblemSvg(opts: { bg?: boolean; size?: number; pad?: number } = {}): string {
  const pad = opts.pad ?? 0;
  const v = 64 + pad * 2;
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const tile = opts.bg ? `<rect x="${-pad}" y="${-pad}" width="${v}" height="${v}" rx="${v * 0.22}" fill="${BRAND.ink1}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${v} ${v}"${size}>${tile}${emblemShapes()}</svg>`;
}

/** The emblem's shapes in 64×64 user units (for embedding in a bigger SVG). */
export function emblemShapes(): string {
  const c = BRAND;
  // Hexagon of the cube: top (32,5), right (55.4,18.5) / (55.4,45.5), bottom (32,59), left (8.6,45.5) / (8.6,18.5).
  return `<path d="M32 5 L55.4 18.5 L32 32 L8.6 18.5Z" fill="${c.volt}"/>`
    + `<path d="M8.6 18.5 L32 32 L32 59 L8.6 45.5Z" fill="${c.voltMid}"/>`
    + `<path d="M55.4 18.5 L55.4 45.5 L32 59 L32 32Z" fill="${c.voltDark}"/>`
    + reticle();
}

/** Ring segments and ticks of the reticle (ink on the cube). */
function reticle(): string {
  const ink = BRAND.ink0;
  const r = 11, cx = 32, cy = 32, gap = 0.42; // gap in radians on each side of the four axes
  const arcs: string[] = [];
  for (let q = 0; q < 4; q++) {
    const a0 = q * (Math.PI / 2) + gap, a1 = (q + 1) * (Math.PI / 2) - gap;
    const p = (a: number) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
    arcs.push(`M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}`);
  }
  const ticks = [
    `M${cx} ${cy - 16.5} V${cy - 6.5}`, `M${cx} ${cy + 6.5} V${cy + 16.5}`,
    `M${cx - 16.5} ${cy} H${cx - 6.5}`, `M${cx + 6.5} ${cy} H${cx + 16.5}`,
  ];
  return `<path d="${arcs.join(' ')}" fill="none" stroke="${ink}" stroke-width="3.6"/>`
    + `<path d="${ticks.join(' ')}" fill="none" stroke="${ink}" stroke-width="3.2"/>`
    + `<rect x="${cx - 2}" y="${cy - 2}" width="4" height="4" fill="${ink}"/>`;
}

/**
 * Wordmark glyphs: stroke paths in a 4×5 box (path centred on the stroke), squared letters with 45° chamfers,
 * drawn with a heavy stroke. `w` is the advance width.
 */
const GLYPHS: Record<string, { w: number; d: string }> = {
  B: { w: 4, d: 'M0.55 0.55H2.75L3.45 1.25V1.85L2.85 2.5L3.45 3.15V3.75L2.75 4.45H0.55Z M0.55 2.5H2.85' },
  U: { w: 4, d: 'M0.55 0V3.75L1.25 4.45H2.75L3.45 3.75V0' },
  N: { w: 4, d: 'M0.55 5V0.55H1.25L2.75 4.45H3.45V0' },
  K: { w: 4, d: 'M0.55 0V5 M3.6 0.15L1.25 2.5L3.6 4.85 M0.55 2.5H1.4' },
  C: { w: 4, d: 'M3.6 0.55H1.25L0.55 1.25V3.75L1.25 4.45H3.6' },
  R: { w: 4, d: 'M0.55 5V0.55H2.75L3.45 1.25V1.85L2.75 2.55H0.55 M2.2 2.55L3.45 3.8V5' },
  A: { w: 4, d: 'M0.55 5V1.25L1.25 0.55H2.75L3.45 1.25V5 M0.55 2.85H3.45' },
  F: { w: 3.7, d: 'M3.6 0.55H0.55V5 M0.55 2.55H2.9' },
  T: { w: 4, d: 'M0 0.55H4 M2 0.55V5' },
};
/** Stroke width of the letters, in the same units as the 5-unit letter height. */
const STROKE = 1.1;
/** Forward slant (x shift per unit of height). */
const SLANT = 0.2;

/**
 * The wordmark: BUNK in light text and CRAFT in volt, heavy squared letters slanted forward. `cell` is the size of
 * one unit (the letters are 5 units tall). `mono` draws everything in one colour.
 */
export function wordmarkSvg(opts: { cell?: number; mono?: string; shadow?: boolean } = {}): { svg: string; width: number; height: number } {
  const cell = opts.cell ?? 10;
  const { shapes, width } = wordmarkShapes(opts.mono, opts.shadow ?? true);
  const vw = width + 0.4, vh = 5.4;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw.toFixed(2)} ${vh}" width="${(vw * cell).toFixed(1)}" height="${(vh * cell).toFixed(1)}">${shapes}</svg>`,
    width: vw * cell,
    height: vh * cell,
  };
}

/** The wordmark's shapes in units (5 tall, `width` wide including the slant), for embedding in a bigger SVG. */
export function wordmarkShapes(mono?: string, shadow = true): { shapes: string; width: number } {
  const word = 'BUNKCRAFT';
  const parts: { x: number; d: string; color: string }[] = [];
  let x = 0;
  for (let i = 0; i < word.length; i++) {
    const g = GLYPHS[word[i]];
    parts.push({ x, d: g.d, color: mono ?? (i < 4 ? BRAND.text : BRAND.volt) });
    x += g.w + (i === 3 ? 1.5 : 0.75); // a wider gap between BUNK and CRAFT
  }
  const advance = x - 0.75;
  // Skew around the baseline (y = 5): the top leans right by 5 × SLANT.
  const skew = (dx: number, dy: number) => `matrix(1 0 ${-SLANT} 1 ${(5 * SLANT + dx).toFixed(2)} ${dy})`;
  // The letters are clipped to their 5-unit box so stems end flat at the top and bottom.
  const glyphs = (color?: string) => parts.map((p) =>
    `<path transform="translate(${p.x.toFixed(2)} 0)" d="${p.d}" fill="none" stroke="${color ?? p.color}" stroke-width="${STROKE}" stroke-linejoin="miter" stroke-miterlimit="3" clip-path="url(#bc-box)"/>`).join('');
  const clip = `<defs><clipPath id="bc-box" clipPathUnits="userSpaceOnUse"><rect x="-1" y="0" width="7" height="5"/></clipPath></defs>`;
  const shade = shadow ? `<g transform="${skew(0.18, 0.28)}" opacity="0.6">${glyphs(BRAND.ink0)}</g>` : '';
  return { shapes: `${clip}${shade}<g transform="${skew(0, 0)}">${glyphs()}</g>`, width: advance + 5 * SLANT };
}

/** An SVG string as a data URL (for <img src>, CSS backgrounds and the favicon link). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
