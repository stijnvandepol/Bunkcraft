/**
 * Finds screenshot viewpoints in generated terrain (cave entrance in a hillside, ravine from above and
 * from inside, big cavern with lava, underground lake, ore veins in a cave wall) and prints them as JSON
 * camera poses { x, y, z, yaw, pitch }, for scripts/shots-caves.py.
 *
 *   npx tsx scripts/gen-spots.ts [seed=12345] [--gen=2] [--grid=20]
 *   npx tsx scripts/gen-spots.ts [seed=12345] --biomes [--radius=2500]   (generator 3: one ground and one aerial
 *       view per biome, keys `<Biome>` and `<Biome>_above`, for scripts/shots-biomes.py)
 */
import { BLOCK } from '../src/world/BlockRegistry';
import { BIOME, BIOME_NAMES } from '../src/world/Biomes';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, blockIndex } from '../src/world/constants';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const seed = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 12345);
const GEN = Number(arg('gen', '2'));
const GRID = Number(arg('grid', '20'));
const gen = new TerrainGenerator(seed, GEN);

if (process.argv.includes('--biomes')) {
  // Biome finder: the sample point closest to the origin whose surroundings (±24 blocks) are all that biome.
  const g3 = new TerrainGenerator(seed, Math.max(3, GEN));
  const radius = Number(arg('radius', '2500'));
  const biomeOf = (x: number, z: number) => g3.biomeAt(x, z, Math.floor(g3.heightAt(x, z)));
  const found = new Map<number, [number, number]>();
  for (let r = 0; r < radius; r += 32) {
    for (let a = 0; a < Math.max(1, Math.floor(r / 32) * 6); a++) {
      const ang = a / Math.max(1, Math.floor(r / 32) * 6) * Math.PI * 2;
      const x = Math.round(Math.cos(ang) * r), z = Math.round(Math.sin(ang) * r);
      const b = biomeOf(x, z);
      if (found.has(b)) continue;
      const small = b === BIOME.RIVER || b === BIOME.FROZEN_RIVER || b === BIOME.BEACH || b === BIOME.SNOWY_BEACH || b === BIOME.STONY_SHORE;
      const d = small ? 0 : 24;
      if (d && ![[d, 0], [-d, 0], [0, d], [0, -d]].every(([dx, dz]) => biomeOf(x + dx, z + dz) === b)) continue;
      found.set(b, [x, z]);
    }
  }
  const poses: Record<string, unknown> = { seed, gen: 3 };
  for (const [b, [x, z]] of found) {
    const name = BIOME_NAMES[b].replace(/ /g, '');
    const h = Math.max(SEA_LEVEL, Math.floor(g3.heightAt(x, z)));
    // Keep the camera above the ground along its line of sight (a hill between camera and target).
    const clear = (dx: number, dz: number) => {
      let m = h;
      for (let t = 0; t <= 1; t += 0.1) m = Math.max(m, Math.floor(g3.heightAt(x + dx * t, z + dz * t)));
      return m;
    };
    const ground = clear(-14, 14);
    poses[name] = look([x + 0.5 - 14, ground + 4, z + 0.5 + 14], [x + 0.5 + 10, Math.max(h, ground - 4) + 2, z + 0.5 - 10]);
    poses[`${name}_above`] = look([x + 0.5 - 40, clear(-40, 40) + 40, z + 0.5 + 40], [x + 0.5, h, z + 0.5]);
  }
  console.log(JSON.stringify(poses, null, 1));
  process.exit(0);
}

const chunks = new Map<string, Uint8Array>();
for (let cz = -GRID / 2; cz < GRID / 2; cz++) {
  for (let cx = -GRID / 2; cx < GRID / 2; cx++) {
    const b = new Uint8Array(CHUNK_VOLUME);
    gen.generate(cx, cz, b);
    chunks.set(`${cx},${cz}`, b);
  }
}
const get = (x: number, y: number, z: number): number => {
  if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
  const c = chunks.get(`${x >> 4},${z >> 4}`);
  return c ? c[blockIndex(x & 15, y, z & 15)] : -1;
};
const air = (x: number, y: number, z: number) => get(x, y, z) === BLOCK.AIR;

/** Camera at `from` looking at `to`. Yaw 0 looks toward −z, like the game's player. */
function look(from: number[], to: number[]) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { x: from[0], y: from[1], z: from[2], yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

const out: Record<string, unknown> = { seed, gen: GEN };
const all: [number, number][] = [];
for (const key of chunks.keys()) { const [cx, cz] = key.split(',').map(Number); all.push([cx, cz]); }
all.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));

// Surface openings per column: surface block gone and >= 3 air below.
interface Col { x: number; z: number; h: number; run: number }
const cols: Col[] = [];
for (const [cx, cz] of all) {
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const wx = cx * 16 + x, wz = cz * 16 + z;
      const h = Math.floor(gen.heightAt(wx, wz));
      if (h < SEA_LEVEL + 2 || h > 100 || !air(wx, h, wz)) continue;
      let run = 0;
      while (h - run > 0 && air(wx, h - run, wz)) run++;
      if (run >= 3) cols.push({ x: wx, z: wz, h, run });
    }
  }
}
const colSet = new Map(cols.map((c) => [`${c.x},${c.z}`, c]));
// Group into connected openings.
const seen = new Set<string>();
const groups: Col[][] = [];
for (const c of cols) {
  if (seen.has(`${c.x},${c.z}`)) continue;
  const g: Col[] = [], st = [c];
  seen.add(`${c.x},${c.z}`);
  while (st.length) {
    const p = st.pop()!;
    g.push(p);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${p.x + dx},${p.z + dz}`;
      const n = colSet.get(k);
      if (n && !seen.has(k)) { seen.add(k); st.push(n); }
    }
  }
  groups.push(g);
}
const centre = (g: Col[]) => ({
  x: Math.round(g.reduce((s, c) => s + c.x, 0) / g.length), z: Math.round(g.reduce((s, c) => s + c.z, 0) / g.length),
  h: Math.round(g.reduce((s, c) => s + c.h, 0) / g.length), deep: Math.max(...g.map((c) => c.run)),
});

/** True when the straight line between two points only passes through air (nothing in the way of the camera). */
function clearLine(a: number[], b: number[]): boolean {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 2);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.floor(a[0] + (b[0] - a[0]) * t), y = Math.floor(a[1] + (b[1] - a[1]) * t), z = Math.floor(a[2] + (b[2] - a[2]) * t);
    if (!air(x, y, z) && get(x, y, z) !== BLOCK.TALL_GRASS) return false;
  }
  return true;
}

// Hillside entrance: a medium opening whose surroundings are lower on one side, viewed from the open side.
{
  let best: { score: number; pose: unknown } | null = null;
  for (const g of groups) {
    if (g.length < 6 || g.length > 60) continue;
    const c = centre(g);
    for (let a = 0; a < 16; a++) {
      for (const dist of [10, 14, 18]) {
        const ang = (a / 16) * Math.PI * 2;
        const cx = Math.round(c.x + Math.cos(ang) * dist), cz = Math.round(c.z + Math.sin(ang) * dist);
        const ch = Math.floor(gen.heightAt(cx, cz));
        if (ch < SEA_LEVEL || ch > c.h + 1) continue;
        const from = [cx + 0.5, ch + 3.2, cz + 0.5], to = [c.x + 0.5, c.h - 0.5, c.z + 0.5];
        if (!clearLine(from, to)) continue;
        const score = g.length + c.deep * 0.5 + (c.h - ch) * 2 - Math.hypot(c.x, c.z) * 0.01;
        if (!best || score > best.score) best = { score, pose: look(from, to) };
      }
    }
  }
  out.entrance = best?.pose ?? null;
}

// Ravine: the opening with the biggest footprint and depth; one view from above, one from inside at the floor.
{
  const big = groups.filter((g) => g.length >= 60 && Math.max(...g.map((c) => c.run)) >= 25)
    .sort((a, b) => b.length - a.length);
  const g = big[0];
  if (g) {
    const c = centre(g);
    out.ravineAbove = look([c.x + 0.5, c.h + 30, c.z + 0.5 + 18], [c.x + 0.5, c.h - 10, c.z + 0.5]);
    // Inside: a column in the opening with the deepest run, camera at its floor looking along the ravine.
    const deepest = g.reduce((m, x) => (x.run > m.run ? x : m));
    let bestDir = 0, bestLen = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      let len = 0;
      while (len < 40 && air(Math.round(deepest.x + Math.cos(ang) * len), deepest.h - deepest.run + 3, Math.round(deepest.z + Math.sin(ang) * len))) len++;
      if (len > bestLen) { bestLen = len; bestDir = ang; }
    }
    const fy = deepest.h - deepest.run + 3;
    out.ravineInside = look([deepest.x + 0.5, fy, deepest.z + 0.5], [deepest.x + 0.5 + Math.cos(bestDir) * 30, fy + 3, deepest.z + 0.5 + Math.sin(bestDir) * 30]);
    out.ravineSize = { columns: g.length, depth: deepest.run };
  } else out.ravineAbove = null;
}

// Interior features: scan every chunk.
let bestLava = { score: 0, pose: null as unknown };
let bestLake = { score: 0, pose: null as unknown };
let bestOre = { score: 0, pose: null as unknown };
for (const [cx, cz] of all) {
  const b = chunks.get(`${cx},${cz}`)!;
  for (let z = 2; z < 14; z += 2) {
    for (let x = 2; x < 14; x += 2) {
      const wx = cx * 16 + x, wz = cz * 16 + z;
      // Lava cavern: lava at y<=10 below a tall air column.
      if (b[blockIndex(x, 10, z)] === BLOCK.LAVA && air(wx, 11, wz)) {
        let h = 0;
        while (air(wx, 11 + h, wz) && h < 40) h++;
        let lava = 0;
        for (let dz = -6; dz <= 6; dz += 2) for (let dx = -6; dx <= 6; dx += 2) if (get(wx + dx, 10, wz + dz) === BLOCK.LAVA && air(wx + dx, 12, wz + dz)) lava++;
        const score = h * 2 + lava * 3;
        if (h >= 8 && score > bestLava.score) {
          bestLava = { score, pose: look([wx + 0.5 + 8, 11 + Math.min(h - 2, 7), wz + 0.5 + 8], [wx + 0.5, 10, wz + 0.5]) };
        }
      }
      // Underground lake: water at y 18..48 below air, in a roomy cave.
      for (let y = 18; y <= 48; y++) {
        if (b[blockIndex(x, y, z)] === BLOCK.WATER && air(wx, y + 1, wz)) {
          let h = 0, w = 0;
          while (air(wx, y + 1 + h, wz) && h < 20) h++;
          for (let dz = -6; dz <= 6; dz += 2) for (let dx = -6; dx <= 6; dx += 2) if (get(wx + dx, y, wz + dz) === BLOCK.WATER && air(wx + dx, y + 1, wz + dz)) w++;
          const score = h * 2 + w * 3;
          if (h >= 6 && w >= 10 && score > bestLake.score) {
            bestLake = { score, pose: look([wx + 0.5 + 7, y + 3.5, wz + 0.5 + 7], [wx + 0.5, y, wz + 0.5]) };
          }
          break;
        }
      }
      // Exposed ore in a cave wall: an ore block with air next to it and open space to look from.
      for (let y = 8; y < 60; y++) {
        const o = b[blockIndex(x, y, z)];
        if (o < BLOCK.COAL_ORE || o > BLOCK.DIAMOND_ORE) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let len = 0;
          while (len < 6 && air(wx + dx * (len + 1), y, wz + dz * (len + 1)) && air(wx + dx * (len + 1), y + 1, wz + dz * (len + 1))) len++;
          if (len < 5) continue;
          let near = 0;
          for (let oy = -2; oy <= 2; oy++) for (let oz = -2; oz <= 2; oz++) for (let ox = -2; ox <= 2; ox++) {
            const n = get(wx + ox, y + oy, wz + oz);
            if (n >= BLOCK.COAL_ORE && n <= BLOCK.DIAMOND_ORE) near++;
          }
          const score = near * 2 + (o === BLOCK.DIAMOND_ORE ? 30 : o === BLOCK.GOLD_ORE ? 20 : o === BLOCK.IRON_ORE ? 8 : 0);
          if (score > bestOre.score) bestOre = { score, pose: look([wx + 0.5 + dx * 5, y + 1.6, wz + 0.5 + dz * 5], [wx + 0.5, y + 0.5, wz + 0.5]) };
        }
      }
    }
  }
}
out.cavernLava = bestLava.pose;
out.lake = bestLake.pose;
out.ore = bestOre.pose;
console.log(JSON.stringify(out, null, 1));
