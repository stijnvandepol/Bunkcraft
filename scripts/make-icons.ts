/**
 * Draws the favicon, the PWA icons, the apple-touch-icon and the social preview image from the brand module
 * (src/ui/Brand.ts: the emblem and the wordmark, all our own art) and writes them to public/. The SVGs are
 * rasterised by Playwright's Chromium, so this needs `npx playwright install chromium` once.
 *
 *   npx tsx scripts/make-icons.ts
 *
 * The outputs are committed, so a normal build does not need to run this.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { MAPS } from '../src/modes/maps';
import { REALMS_MODES } from '../src/modes/Realms';
import { BRAND, TAGLINE, emblemShapes, emblemSvg } from '../src/ui/Brand';

/** A square icon: the emblem on ink. `scale` = share of the canvas the emblem takes; `round` = rounded tile. */
function iconSvg(size: number, scale: number, round: boolean): string {
  const s = 64 / scale;
  const o = (s - 64) / 2;
  const bg = round
    ? `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" rx="${s * 0.22}" fill="${BRAND.ink1}"/>`
    : `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="${BRAND.ink1}"/>`;
  const glow = `<radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="${BRAND.ink2}"/><stop offset="1" stop-color="${BRAND.ink1}" stop-opacity="0"/></radialGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-o} ${-o} ${s} ${s}" width="${size}" height="${size}"><defs>${glow}</defs>${bg}`
    + `<rect x="${-o}" y="${-o}" width="${s}" height="${s}" fill="url(#g)"/>${emblemShapes()}</svg>`;
}

/** A font file as a data URL, so the page rendered by Playwright does not depend on the installed fonts. */
function fontDataUrl(file: string): string {
  return `data:font/woff2;base64,${readFileSync(`public/fonts/${file}`).toString('base64')}`;
}

/**
 * The 1200×630 social preview in the Bunkhosting style: charcoal with the dot grid and the blue and cyan glows,
 * emblem and wordmark (Manrope) on the left, the tagline and what the game is under it, "by Bunk Hosting" in the corner.
 */
function socialHtml(): string {
  // A loose field of isometric cubes in the background (deterministic).
  let cubes = '';
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = 560 + rnd() * 700, y = -40 + rnd() * 700, k = 0.35 + rnd() * 0.9;
    cubes += `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) scale(${k.toFixed(2)})" opacity="${(0.05 + rnd() * 0.09).toFixed(2)}">`
      + `<path d="M32 5 L55.4 18.5 L32 32 L8.6 18.5Z" fill="#fff"/><path d="M8.6 18.5 L32 32 L32 59 L8.6 45.5Z" fill="#a3a7b9"/><path d="M55.4 18.5 L55.4 45.5 L32 59 L32 32Z" fill="#5a6070"/></g>`;
  }
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'Manrope'; src: url(${fontDataUrl('manrope-var-latin.woff2')}) format('woff2'); font-weight: 200 800; }
    @font-face { font-family: 'Inter'; src: url(${fontDataUrl('inter-var-latin.woff2')}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: ${BRAND.ink1}; }
    body { position: relative; font-family: 'Inter', sans-serif; color: ${BRAND.text}; }
    .bg { position: absolute; inset: 0; background:
      radial-gradient(rgba(0,219,231,.12) 1.5px, transparent 0) 0 0 / 40px 40px,
      radial-gradient(60% 70% at 95% 0%, rgba(0,106,242,.28), rgba(0,106,242,0) 70%),
      radial-gradient(60% 70% at 0% 100%, rgba(0,219,231,.2), rgba(0,219,231,0) 70%); }
    .cubes { position: absolute; inset: 0; }
    .lock { position: absolute; left: 90px; top: 150px; display: flex; align-items: center; gap: 38px; }
    .emblem { width: 170px; height: 170px; filter: drop-shadow(0 0 30px rgba(0,219,231,.3)); }
    .text { display: flex; flex-direction: column; gap: 22px; }
    .word { font: 800 118px/1 'Manrope', sans-serif; letter-spacing: -0.05em; text-transform: uppercase; white-space: nowrap; }
    .word span { background: linear-gradient(90deg, ${BRAND.blue}, ${BRAND.accent}); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .tag { font-weight: 700; font-size: 24px; letter-spacing: 0.3em; text-transform: uppercase; color: ${BRAND.dim}; padding-left: 4px; }
    .what { position: absolute; left: 94px; top: 420px; display: flex; gap: 14px; align-items: center; }
    .pill { padding: 12px 22px; font-weight: 700; font-size: 26px; background: ${BRAND.ink3}; border: 1px solid rgba(66,70,86,.9); border-radius: 4px; }
    .pill b { color: ${BRAND.accent}; font-weight: 800; }
    .cta { position: absolute; left: 94px; top: 500px; padding: 18px 34px; font: 800 28px 'Manrope', sans-serif; color: #fff; border-radius: 4px; background: linear-gradient(90deg, ${BRAND.blue}, ${BRAND.accentDark}); box-shadow: 0 10px 15px -3px rgba(0,106,242,.3); }
    .by { position: absolute; right: 60px; bottom: 44px; font: 800 24px 'Manrope', sans-serif; letter-spacing: -0.03em; text-transform: uppercase; color: ${BRAND.dim}; }
    .by b { color: ${BRAND.text}; }
  </style></head><body>
    <div class="bg"></div>
    <svg class="cubes" width="1200" height="630" viewBox="0 0 1200 630">${cubes}</svg>
    <div class="lock"><div class="emblem">${emblemSvg({ size: 170 })}</div>
      <div class="text"><div class="word">BUNK<span>CRAFT</span></div><div class="tag">${TAGLINE.en}</div></div></div>
    <div class="what"><div class="pill"><b>${REALMS_MODES.length}</b> modes</div><div class="pill"><b>${MAPS.length}</b> maps</div><div class="pill">Free in your browser</div></div>
    <div class="cta">Play now</div>
    <div class="by">A game by <b>Bunk Hosting</b></div>
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
