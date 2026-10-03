/**
 * Minecraft-style GUI scale: every UI size is a whole multiple of one "GUI pixel" so
 * pixel art and the pixel font stay crisp. "Auto" picks the largest whole scale at
 * which the screen still offers at least 320×240 GUI pixels.
 */
export function autoGuiScale(width: number, height: number, compact = false): number {
  // Touch screens are often short in landscape (844×390): menus scroll, so 150 GUI px of height is enough.
  const minHeight = compact ? 150 : 240;
  let s = 1;
  while (width / (s + 1) >= 320 && height / (s + 1) >= minHeight) s++;
  return s;
}

export function applyGuiScale(setting: number): number {
  const w = window.innerWidth, h = window.innerHeight;
  const compact = document.body.classList.contains('touch-ui');
  const max = autoGuiScale(w, h, compact);
  const s = setting > 0 ? Math.min(setting, max) : max;
  document.documentElement.style.setProperty('--s', `${s}px`);
  // Touch hotbar: slots at least ~36 px wide.
  document.documentElement.style.setProperty('--hb', String(compact ? Math.max(1, 1.8 / s) : 1));
  return s;
}
