import { getBlockDef } from '../../world/BlockRegistry';

/** What a bullet impact sounds like, from the block it hit (data only, testable). */
export type ImpactMaterial = 'stone' | 'wood' | 'metal' | 'glass' | 'soil' | 'wool' | 'leaves';

const cache = new Map<number, ImpactMaterial>();

/** The impact material of a block id (unknown or −1: stone). */
export function impactMaterial(id: number): ImpactMaterial {
  if (id < 0) return 'stone';
  let m = cache.get(id);
  if (m) return m;
  const def = getBlockDef(id);
  const name = def?.name ?? '';
  const sound = def?.sound ?? 'stone';
  if (name.includes('glass')) m = 'glass';
  else if (name.endsWith('leaves')) m = 'leaves';
  else if (sound === 'metal' || name.includes('iron') || name.includes('anvil') || name.includes('gold_block')) m = 'metal';
  else if (sound === 'wood' || name.includes('plank') || name.includes('log') || name.includes('fence') || name.includes('door') || name === 'bookshelf' || name === 'chest' || name === 'crafting_table') m = 'wood';
  else if (sound === 'wool' || name.includes('wool') || name.includes('carpet')) m = 'wool';
  else if (sound === 'grass' || sound === 'gravel' || sound === 'sand' || sound === 'snow' || name === 'dirt' || name === 'clay') m = 'soil';
  else m = 'stone';
  cache.set(id, m);
  return m;
}
