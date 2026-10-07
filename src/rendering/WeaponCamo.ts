import { camoDef } from '../modes/progression/Camos';
import type { Box } from './WeaponModels';

/**
 * Procedural camos for the voxel weapon models (Realms weapon levels, see modes/progression/Camos.ts). The
 * painted parts of a weapon (body, stock, handguard; not the black grip and magazine, the steel, lenses and
 * iron sights) are cut into small cells and every cell gets a colour from the camo's palette by a stable
 * hash, so a camo always looks the same on the same weapon. Built once per weapon + camo with the geometry.
 */
const KEEP = new Set(['#17181a', '#4a8fd6', '#8f969e']); // black, lens, steel

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The boxes of a weapon painted with a camo; unknown camos and "none" return the input. */
export function camoBoxes(boxes: readonly Box[], camo: string): Box[] {
  const def = camoDef(camo);
  if (!def || def.pattern === 'none' || def.palette.length === 0) return boxes.slice();
  const pal = def.palette;
  const cell = def.pattern === 'digital' ? 0.022 : def.pattern === 'stripe' ? 0.03 : 0.045;
  const out: Box[] = [];
  boxes.forEach((b, bi) => {
    if (KEEP.has(b[6]) || b[7] === 'iron') { out.push(b); return; }
    const [x0, y0, z0, x1, y1, z1] = b;
    const nz = Math.max(1, Math.round((z1 - z0) / cell));
    const ny = def.pattern === 'stripe' || def.pattern === 'solid' ? 1 : Math.max(1, Math.round((y1 - y0) / cell));
    for (let iz = 0; iz < nz; iz++) {
      const za = z0 + ((z1 - z0) * iz) / nz, zb = z0 + ((z1 - z0) * (iz + 1)) / nz;
      for (let iy = 0; iy < ny; iy++) {
        const ya = y0 + ((y1 - y0) * iy) / ny, yb = y0 + ((y1 - y0) * (iy + 1)) / ny;
        // World-space cell coordinates so neighbouring boxes continue the same pattern.
        const cz = Math.floor(((za + zb) / 2) / cell), cy = Math.floor(((ya + yb) / 2) / cell);
        const r = hash3(cz, cy, def.pattern === 'blotch' ? 0 : bi);
        let color: string;
        switch (def.pattern) {
          case 'stripe': color = mod(cz + (r < 0.25 ? 1 : 0), 3) === 0 ? pal[1] : pal[mod(cz >> 2, 2) === 0 || pal.length < 3 ? 0 : 2]; break;
          case 'solid': color = pal[bi % 2 === 0 ? 0 : 1]; break;
          case 'sparkle': color = r > 0.85 ? pal[2] : r > 0.6 ? pal[3 % pal.length] : bi % 2 === 0 ? pal[0] : pal[1]; break;
          case 'blotch': {
            // Blotches: neighbouring cells tend to share a colour (smoothed hash).
            const s = (r + hash3(cz + 1, cy, 0) + hash3(cz, cy + 1, 0)) / 3;
            color = pal[Math.min(pal.length - 1, Math.floor(s * pal.length * 1.15))];
            break;
          }
          default: color = pal[Math.floor(r * pal.length)];
        }
        out.push([x0, ya, za, x1, yb, zb, color]);
      }
    }
  });
  return out;
}
