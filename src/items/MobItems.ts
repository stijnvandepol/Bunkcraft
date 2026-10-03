import type { ItemSpec } from './ItemContent';

/**
 * Items that come from mobs (eggs, milk, saddles, pearls, slime balls). Their own id range so the other content
 * tables can grow without clashing; APPEND-ONLY like every item table (ids are positions plus the base).
 */
export const MOB_ITEM_FIRST = 700;

export const MOB_ITEMS: ItemSpec[] = [
  { name: 'egg', display: 'Egg', sprite: 'mob:egg', maxStack: 16 },
  // Milk clears effects in Minecraft; here it is a drink of nothing until the effects module exists.
  { name: 'milk_bucket', display: 'Milk Bucket', sprite: 'mob:milk', maxStack: 1 },
  { name: 'saddle', display: 'Saddle', sprite: 'mob:saddle', maxStack: 1 },
  { name: 'ender_pearl', display: 'Ender Pearl', sprite: 'mob:pearl', maxStack: 16 },
  { name: 'slime_ball', display: 'Slimeball', sprite: 'mob:slime' },
];
