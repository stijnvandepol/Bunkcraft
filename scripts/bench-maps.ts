/**
 * Chunk generation time per arcade map (the workers do this for every chunk on every client).
 *
 *   npx tsx scripts/bench-maps.ts
 */
import { ArenaGenerator } from '../src/modes/arena';
import { MAPS } from '../src/modes/maps';
import { CHUNK_VOLUME } from '../src/world/constants';

const blocks = new Uint8Array(CHUNK_VOLUME);
for (const map of MAPS) {
  const gen = new ArenaGenerator(1, map.id);
  gen.generate(0, 0, blocks); // builds the layout
  const t0 = performance.now();
  let chunks = 0;
  for (let cz = -4; cz < 4; cz++) for (let cx = -4; cx < 4; cx++) { gen.generate(cx, cz, blocks); chunks++; }
  const ms = performance.now() - t0;
  console.log(`${map.id.padEnd(9)} ${chunks} chunks in ${ms.toFixed(1)} ms (${(ms / chunks).toFixed(2)} ms per chunk)`);
}
