/**
 * QA round 3: how far a player sees straight ahead from every spawn (eye height, along the spawn's yaw). A spawn
 * facing a wall at arm's length makes the first second of every life "where am I?".
 *
 *   npx tsx scripts/qa/spawn-facing.ts [minBlocks=6]
 */
import { getMap, MAP_IDS } from '../../src/modes/maps';
import { BLOCK } from '../../src/world/BlockRegistry';

const min = Number(process.argv[2] ?? 6);
let bad = 0;
for (const id of MAP_IDS) {
  const map = getMap(id);
  for (let variant = 0; variant < 2; variant++) {
    for (const [kind, list] of Object.entries(map.spawns)) {
      for (const s of list) {
        const dx = -Math.sin(s.yaw), dz = -Math.cos(s.yaw);
        const ey = s.y + 1.62;
        let d = 0;
        for (; d < 40; d += 0.25) {
          const b = map.blockAt(variant, Math.floor(s.x + dx * d), Math.floor(ey), Math.floor(s.z + dz * d));
          if (b !== BLOCK.AIR) break;
        }
        if (d < min) {
          bad++;
          console.log(`${id} v${variant} ${kind} (${s.x}, ${s.y}, ${s.z}) yaw ${(s.yaw * 180 / Math.PI).toFixed(0)}°: wall at ${d.toFixed(2)} blocks`);
        }
      }
    }
  }
}
console.log(`${bad} spawns look at a wall closer than ${min} blocks`);
