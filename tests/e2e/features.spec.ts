import { type Page } from '@playwright/test';
import { command, createWorld, expect, openSandbox, openTitle, play, test, waitForWorld, clickButton } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One creative world, a basic check of each big system: world generation v3, commands (XP, effects, game rules,
 * weather, difficulty, enchanting), block entities (furnace smelting, chest contents through a save), redstone,
 * random ticks, mobs (breeding), beds and the Dutch UI. Each step goes through the game's own code in the page.
 */
async function poll<T>(page: Page, fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await page.bringToFront();
    await page.waitForTimeout(250);
    v = await fn();
  }
  return v;
}

test('the main game systems work in a fresh creative world', async ({ page }) => {
  test.setTimeout(240_000);
  await openTitle(page);
  await createWorld(page, 'Systems');
  await play(page, 1000);

  // ---- world generation: current generator version and a real biome
  const gen = await page.evaluate(async () => {
    const g = (window as any).game;
    const { GEN_VERSION_CURRENT } = await import('/src/world/GenVersion.ts' as string);
    const { BIOME_NAMES } = await import('/src/world/TerrainGenerator.ts' as string);
    const p = g.player;
    const biome = g.world.biomeName(Math.floor(p.x), Math.floor(p.z));
    return { version: g.meta.genVersion, current: GEN_VERSION_CURRENT, biome: BIOME_NAMES[biome] ?? null, surface: g.world.surfaceY(Math.floor(p.x), Math.floor(p.z)) };
  });
  expect(gen.version).toBe(gen.current);
  expect(gen.biome).toBeTruthy();
  expect(gen.surface).toBeGreaterThan(0);

  // A stone platform high in the air, in full daylight, to build on.
  const base = await page.evaluate(async () => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const x0 = Math.floor(g.player.x), z0 = Math.floor(g.player.z), y = 110;
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) g.world.setBlock(x0 + x, y, z0 + z, BLOCK.STONE);
    g.player.setPosition(x0 + 0.5, y + 1, z0 + 0.5);
    g.player.flying = true;
    return { x: x0, y: y + 1, z: z0 };
  });

  // ---- commands: XP, effects, game rules, weather, difficulty, enchanting
  expect(await command(page, '/xp 5L')).not.toMatch(/Usage|Unknown/);
  expect(await page.evaluate(() => (window as any).game.stats.xp.level)).toBe(5);
  expect(await command(page, '/effect give speed 60 1')).not.toMatch(/Usage|Unknown/);
  expect(await page.evaluate(() => (window as any).game.stats.effects.has('speed'))).toBe(true);
  expect(await command(page, '/gamerule doDaylightCycle false')).not.toMatch(/Unknown/);
  expect(await command(page, '/weather rain')).toMatch(/rain/i);
  expect(await command(page, '/difficulty hard')).toMatch(/Hard/i);
  const enchanted = await page.evaluate(async () => {
    const g = (window as any).game;
    const { ITEM } = await import('/src/items/ItemRegistry.ts' as string);
    g.playerInventory.set(g.hotbar.selected, { id: ITEM.DIAMOND_SWORD, count: 1 });
    return null;
  });
  void enchanted;
  expect(await command(page, '/enchant sharpness 2')).toMatch(/Applied/);
  expect(await command(page, '/nonsense')).toMatch(/Unknown command/);

  // ---- block entities: a furnace smelts, a chest keeps its items through a save
  await page.evaluate(async (b) => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const { ITEM } = await import('/src/items/ItemRegistry.ts' as string);
    const { FURNACE_INPUT, FURNACE_FUEL } = await import('/src/world/BlockEntities.ts' as string);
    g.world.setBlock(b.x + 2, b.y, b.z, BLOCK.FURNACE);
    const f = g.world.blockEntities.ensure(b.x + 2, b.y, b.z);
    f.slots[FURNACE_INPUT] = { id: BLOCK.SAND, count: 2 };
    f.slots[FURNACE_FUEL] = { id: ITEM.COAL, count: 1 };
    f.changed();
    g.world.setBlock(b.x - 2, b.y, b.z, BLOCK.CHEST);
    const c = g.world.blockEntities.ensure(b.x - 2, b.y, b.z);
    c.slots[5] = { id: BLOCK.GLOWSTONE, count: 7 };
    c.changed();
  }, base);
  const smelted = await poll(page, () => page.evaluate(async (b) => {
    const g = (window as any).game;
    const { FURNACE_OUTPUT } = await import('/src/world/BlockEntities.ts' as string);
    return g.world.blockEntities.get(b.x + 2, b.y, b.z)?.slots[FURNACE_OUTPUT] ?? null;
  }, base), (s: any) => !!s && s.count > 0);
  expect(smelted?.count).toBeGreaterThan(0);

  // ---- redstone: a block of redstone lights the lamp next to it
  await page.evaluate(async (b) => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const { CUBE_ID } = await import('/src/world/BlockRegistry.ts' as string);
    g.world.setBlock(b.x, b.y, b.z + 3, BLOCK.REDSTONE_LAMP);
    g.world.setBlock(b.x + 1, b.y, b.z + 3, CUBE_ID.redstone_block);
  }, base);
  const lamp = await poll(page, () => page.evaluate(async (b) => {
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    return (window as any).game.world.getBlock(b.x, b.y, b.z + 3) === BLOCK.REDSTONE_LAMP_LIT;
  }, base), (v) => v, 10_000);
  expect(lamp).toBe(true);

  // ---- random ticks: the game rule reaches the ticker, and it keeps picking blocks and changing some (grass, leaves, crops)
  expect(await command(page, '/gamerule randomTickSpeed 64')).not.toMatch(/Unknown/);
  const ticks0 = await page.evaluate(() => { const t = (window as any).game.world.randomTicker; return { speed: t.speed, picks: t.stats.picks, ticks: t.stats.ticks }; });
  expect(ticks0.speed).toBe(64);
  await play(page, 3000);
  const ticks1 = await page.evaluate(() => { const t = (window as any).game.world.randomTicker; return { picks: t.stats.picks, ticks: t.stats.ticks, handled: t.stats.handled }; });
  expect(ticks1.ticks).toBeGreaterThan(ticks0.ticks);
  expect(ticks1.picks).toBeGreaterThan(0);
  await command(page, '/gamerule randomTickSpeed 3');

  // ---- mobs: two cows in love make a calf
  const calf = await page.evaluate(async (b) => {
    const g = (window as any).game;
    const a = g.entities.spawnMob('cow', b.x + 0.5, b.y, b.z - 2.5);
    const c = g.entities.spawnMob('cow', b.x + 1.5, b.y, b.z - 2.5);
    a.inLove = 600; c.inLove = 600;
    return g.entities.mobs.length;
  }, base);
  expect(calf).toBeGreaterThanOrEqual(2);
  const babies = await poll(page, () => page.evaluate(() => (window as any).game.entities.mobs.filter((m: any) => m.type.kind === 'cow' && m.baby).length), (n) => n > 0, 30_000);
  expect(babies).toBeGreaterThan(0);

  // ---- beds: using a bed sets the respawn point
  const bed = await page.evaluate(async (b) => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    g.world.setBlock(b.x, b.y, b.z - 4, BLOCK.BED);
    g.useBed(b.x, b.y, b.z - 4);
    return g.worldRules.bed;
  }, base);
  expect(bed).toMatchObject({ x: base.x, y: base.y, z: base.z - 4 });

  // ---- save: the chest contents come back after a reload
  await page.evaluate(() => (window as any).game.saveGame());
  await openTitle(page);
  await openSandbox(page);
  await clickButton(page, 'Singleplayer');
  await page.locator('.world-item', { hasText: 'Systems' }).click();
  await clickButton(page, 'Play Selected World');
  await waitForWorld(page);
  const chest = await poll(page, () => page.evaluate((b) => {
    const e = (window as any).game.world.blockEntities.get(b.x - 2, b.y, b.z);
    return e ? e.slots[5] : null;
  }, base), (v: any) => !!v);
  expect(chest).toMatchObject({ count: 7 });
  expect(await page.evaluate(() => (window as any).game.stats.xp.level)).toBe(5);

  // ---- i18n: Dutch menus
  await page.evaluate(() => (window as any).game.settings.set('language', 'nl'));
  await openTitle(page);
  await expect(page.locator('.bc-play')).toContainText('Spelen');
  await page.locator('.home-build').click();
  await expect(page.getByRole('button', { name: 'Alleen spelen' })).toBeVisible();
  await page.evaluate(() => (window as any).game.settings.set('language', 'en'));
});
