/**
 * Draws the favicon, the PWA icons, the apple-touch-icon and the social preview image from the brand module
 * (src/ui/Brand.ts: the emblem and the wordmark, all our own art) and writes them to public/. The SVGs are
 * rasterised by Playwright's Chromium, so this needs `npx playwright install chromium` once.
 *
 *   npx tsx scripts/make-icons.ts
 *
 * The outputs are committed, so a normal build does not need to run this.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { MAPS } from '../src/modes/maps';
import { REALMS_MODES } from '../src/modes/Realms';
import { BRAND, TAGLINE, emblemShapes, emblemSvg, wordmarkSvg } from '../src/ui/Brand';

/** A square icon: the emblem on ink. `scale` = share of the canvas the emblem takes; `round` = rounded tile. */
function iconSvg(size: number, scale: number, round: boolean): string {
  const s = 64 / scale;
  const o = (s - 64) / 2;
  const bg = round
    ? `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" rx="${s * 0.22}" fill="${BRAND.ink1}"/>`
    : `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="${BRAND.ink1}"/>`;
  const glow = `<radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="${BRAND.ink3}"/><stop offset="1" stop-color="${BRAND.ink1}" stop-opacity="0"/></radialGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-o} ${-o} ${s} ${s}" width="${size}" height="${size}"><defs>${glow}</defs>${bg}`
    + `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="url(#g)"/>${emblemShapes()}</svg>`;
}

/** The 1200×630 social preview: emblem, wordmark, tagline and what the game is, over an ink field with voxels. */
function socialHtml(): string {
  const wm = wordmarkSvg({ cell: 15 });
  // A loose field of isometric cubes in the background (deterministic).
  let cubes = '';
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = 560 + rnd() * 700, y = -40 + rnd() * 700, k = 0.35 + rnd() * 0.9;
    cubes += `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) scale(${k.toFixed(2)})" opacity="${(0.05 + rnd() * 0.09).toFixed(2)}">`
      + `<path d="M32 5 L55.4 18.5 L32 32 L8.6 18.5Z" fill="#fff"/><path d="M8.6 18.5 L32 32 L32 59 L8.6 45.5Z" fill="#9aa6b5"/><path d="M55.4 18.5 L55.4 45.5 L32 59 L32 32Z" fill="#5a6474"/></g>`;
  }
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: ${BRAND.ink0}; }
    body { position: relative; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: ${BRAND.text}; }
    .bg { position: absolute; inset: 0; background: radial-gradient(80% 90% at 75% 40%, ${BRAND.ink3}, ${BRAND.ink0} 70%); }
    .band { position: absolute; left: -100px; right: -100px; bottom: 92px; height: 14px; background: repeating-linear-gradient(115deg, ${BRAND.volt} 0 18px, transparent 18px 34px); opacity: 0.85; transform: rotate(-4deg); }
    .cubes { position: absolute; inset: 0; }
    .lock { position: absolute; left: 90px; top: 150px; display: flex; align-items: center; gap: 38px; }
    .emblem { width: 190px; height: 190px; filter: drop-shadow(0 10px 30px rgba(0,0,0,.55)); }
    .text { display: flex; flex-direction: column; gap: 18px; }
    .tag { font-weight: 800; font-size: 26px; letter-spacing: 0.32em; text-transform: uppercase; color: ${BRAND.dim}; padding-left: 4px; }
    .what { position: absolute; left: 94px; top: 420px; font-weight: 800; font-size: 30px; letter-spacing: 0.04em; }
    .what b { color: ${BRAND.volt}; font-weight: 900; }
  </style></head><body>
    <div class="bg"></div>
    <svg class="cubes" width="1200" height="630" viewBox="0 0 1200 630">${cubes}</svg>
    <div class="band"></div>
    <div class="lock"><div class="emblem">${emblemSvg({ size: 190 })}</div>
      <div class="text">${wm.svg}<div class="tag">${TAGLINE.en}</div></div></div>
    <div class="what"><b>${REALMS_MODES.length}</b> modes &nbsp;·&nbsp; <b>${MAPS.length}</b> maps &nbsp;·&nbsp; free in your browser</div>
  </body></html>`;
}

async function main(): Promise<void> {
  mkdirSync('public/icons', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const png = async (svg: string, size: number, path: string, transparent = false) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    writeFileSync(path, await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } }));
  };
  await png(iconSvg(192, 0.8, true), 192, 'public/icons/icon-192.png', true);
  await png(iconSvg(512, 0.8, true), 512, 'public/icons/icon-512.png', true);
  // Maskable: full-bleed ink, the emblem inside the 80% safe zone.
  await png(iconSvg(192, 0.56, false), 192, 'public/icons/icon-maskable-192.png');
  await png(iconSvg(512, 0.56, false), 512, 'public/icons/icon-maskable-512.png');
  // iOS rounds the corners itself and shows transparency as black.
  await png(iconSvg(180, 0.74, false), 180, 'public/icons/apple-touch-icon.png');
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(socialHtml());
  writeFileSync('public/icons/social-preview.png', await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }));
  await browser.close();
  writeFileSync('public/favicon.svg', `${emblemSvg({ bg: true, pad: 3 })}\n`);
  console.log('Icons written to public/icons and public/favicon.svg');
}

void main();
