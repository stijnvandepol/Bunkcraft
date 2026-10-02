/**
 * Minecraft-style GUI scale: every UI size is a whole multiple of one "GUI pixel" so
 * pixel art and the pixel font stay crisp. "Auto" picks the largest whole scale at
 * which the screen still offers at least 320×240 GUI pixels.
 */
export function autoGuiScale(width: number, height: number): number {
  let s = 1;
  while (width / (s + 1) >= 320 && height / (s + 1) >= 240) s++;
  return s;
}

export function applyGuiScale(setting: number): number {
  const w = window.innerWidth, h = window.innerHeight;
  const max = autoGuiScale(w, h);
  const s = setting > 0 ? Math.min(setting, max) : max;
  document.documentElement.style.setProperty('--s', `${s}px`);
  return s;
}
