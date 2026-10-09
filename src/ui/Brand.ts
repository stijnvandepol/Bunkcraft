/**
 * BunkCraft's visual identity as data: the colour tokens (Bunkhosting's palette, taken from bunkhosting.nl) and the
 * emblem (a voxel cube inside a reticle), drawn in code as SVG so the menu, the favicon, the PWA icons and the
 * social preview share one source. The wordmark is real text (Manrope, see shell.css) in the app and in the social
 * preview. No DOM here: scripts/make-icons.ts imports it under Node.
 * See docs/research/IDENTITY.md ("Bunkhosting-stijl") for the reasoning. The CSS tokens in shell.css (:root) mirror
 * these values; change both together.
 */

export const BRAND = {
  /** Surfaces, from deepest to raised (Bunkhosting: surface-container-lowest, surface, container, container-high). */
  ink0: '#0c0e12',
  ink1: '#111318',
  ink2: '#1e2024',
  ink3: '#282a2e',
  /** Text (on-surface) and secondary text (on-surface-variant, a little dimmer for 7:1 on ink1). */
  text: '#e2e2e8',
  dim: '#a3a7b9',
  /** Primary accent (Bunkhosting's tertiary cyan): PLAY, XP, focus, live counts. */
  accent: '#00dbe7',
  accentMid: '#00a9b3',
  accentDark: '#007e85',
  /** Brand blue (primary-container): the start of the button and wordmark gradients. */
  blue: '#006af2',
  /** Light blue (primary): info text, codes. */
  info: '#b0c6ff',
  danger: '#ffb4ab',
} as const;

export const TAGLINE = { en: 'Voxel arena shooter', nl: 'Voxel-arenashooter' } as const;

/** Where "by Bunkhosting" points. */
export const BUNKHOSTING_URL = 'https://bunkhosting.nl';

/**
 * The emblem in a 64×64 box: an isometric cube (three cyan shades) with a reticle centred on its front corner.
 * `bg` draws a rounded ink tile behind it (icons); without it the emblem is transparent (logo lock-up).
 */
export function emblemSvg(opts: { bg?: boolean; size?: number; pad?: number } = {}): string {
  const pad = opts.pad ?? 0;
  const v = 64 + pad * 2;
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const tile = opts.bg ? `<rect x="${-pad}" y="${-pad}" width="${v}" height="${v}" rx="${v * 0.19}" fill="${BRAND.ink1}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${v} ${v}"${size}>${tile}${emblemShapes()}</svg>`;
}

/** The emblem's shapes in 64×64 user units (for embedding in a bigger SVG). */
export function emblemShapes(): string {
  const c = BRAND;
  // Hexagon of the cube: top (32,5), right (55.4,18.5) / (55.4,45.5), bottom (32,59), left (8.6,45.5) / (8.6,18.5).
  return `<path d="M32 5 L55.4 18.5 L32 32 L8.6 18.5Z" fill="${c.accent}"/>`
    + `<path d="M8.6 18.5 L32 32 L32 59 L8.6 45.5Z" fill="${c.accentMid}"/>`
    + `<path d="M55.4 18.5 L55.4 45.5 L32 59 L32 32Z" fill="${c.accentDark}"/>`
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

/** An SVG string as a data URL (for <img src>, CSS backgrounds and the favicon link). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
