import { clickButton, createWorld, expect, openSandbox, openTitle, play, test, waitForWorld } from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('singleplayer: create a world, walk, break and place, craft, save and reload @webkit', async ({ page }) => {
  await openTitle(page);
  await createWorld(page, 'E2E World');
  await play(page, 1000);
  // A flat two-layer stone floor high up: walking and building do not depend on the random terrain (trees, sand).
  await page.evaluate(async () => {
    const g = (window as any).game;
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const x0 = Math.floor(g.player.x), z0 = Math.floor(g.player.z);
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (const y of [106, 107, 108, 109, 110]) g.world.setBlock(x0 + x, y, z0 + z, BLOCK.STONE);
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 111; y < 115; y++) g.world.setBlock(x0 + x, y, z0 + z, 0);
    g.player.setPosition(x0 + 0.5, 111, z0 + 0.5);
    g.player.flying = false;
    g.player.yaw = 0;
  });
  await play(page, 800);

  // Walk forward for a moment: the player moves.
  const start = await page.evaluate(() => { const p = (window as any).game.player; return { x: p.x, z: p.z }; });
  await page.evaluate(() => (window as any).game.input.down.add('KeyW'));
  await play(page, 1500);
  await page.evaluate(() => (window as any).game.input.down.delete('KeyW'));
  const moved = await page.evaluate((s) => { const p = (window as any).game.player; return Math.hypot(p.x - s.x, p.z - s.z); }, start);
  expect(moved).toBeGreaterThan(1);

  // Fly up a little (so a hole does not swallow us) and look straight down; break the block underneath with the attack button.
  await page.evaluate(() => { const g = (window as any).game; const p = g.player; p.setPosition(Math.floor(p.x) + 0.5, 112.5, Math.floor(p.z) + 0.5); p.flying = true; p.pitch = -Math.PI / 2 + 0.01; });
  await play(page, 400);
  // The block the crosshair is on, as the game's own interaction ray sees it.
  const target = await page.evaluate(() => {
    const r = (window as any).game.interaction.ray;
    return { hit: r.hit as boolean, x: r.x as number, y: r.y as number, z: r.z as number, id: r.id as number };
  });
  expect(target.hit).toBe(true);
  expect(target.id).toBeGreaterThan(0);
  // Hold the attack button until the block is gone (creative breaks at once, then repeats while held).
  await page.evaluate(() => { const i = (window as any).game.input; i.down.add('Mouse0'); i.pressed.add('Mouse0'); });
  // Release the button in the same step that sees the block gone: on a slow CI frame rate a held button breaks more.
  await expect.poll(async () => page.evaluate((t) => {
    const g = (window as any).game;
    const id = g.world.getBlock(t.x, t.y, t.z);
    if (id === 0) g.input.down.delete('Mouse0');
    return id;
  }, target), { timeout: 15_000, intervals: [50] }).toBe(0);
  await play(page, 300);

  // Place the selected hotbar block on top of whatever the crosshair now points at (looking down: the face above).
  await page.evaluate(() => { const g = (window as any).game; g.hotbar.selected = 2; g.hotbar.refresh?.(); });
  const placed = await page.evaluate(() => (window as any).game.playerInventory.get(2).id as number);
  expect(placed).toBeGreaterThan(0);
  const below = await page.evaluate(() => { const r = (window as any).game.interaction.ray; return { hit: r.hit as boolean, x: r.x as number, y: r.y as number, z: r.z as number }; });
  expect(below.hit).toBe(true);
  const spot = { x: below.x, y: below.y + 1, z: below.z };
  // A click is one frame long; re-click until it lands (a throttled or paused frame may swallow one).
  await expect.poll(async () => {
    await page.bringToFront();
    return page.evaluate((t) => {
      const g = (window as any).game;
      const id = g.world.getBlock(t.x, t.y, t.z);
      if (id === 0) { g.state = 'playing'; g.input.locked = true; g.input.pressed.add('Mouse2'); }
      return id;
    }, spot);
  }, { timeout: 15_000, intervals: [300] }).toBe(placed);

  // Craft planks from a log with the game's own recipe code and inventory.
  const crafted = await page.evaluate(async () => {
    const g = (window as any).game;
    const { RECIPES, craft } = await import('/src/items/Recipes.ts' as string);
    const { BLOCK } = await import('/src/world/BlockRegistry.ts' as string);
    const inv = g.playerInventory;
    inv.clear();
    inv.add({ id: BLOCK.OAK_LOG, count: 2 });
    const r = RECIPES.find((x: any) => x.result.id === BLOCK.OAK_PLANKS && x.station === 'hand');
    const left = craft(inv, r, new Set(['hand']));
    return { left, planks: inv.count(BLOCK.OAK_PLANKS), logs: inv.count(BLOCK.OAK_LOG) };
  });
  expect(crafted).toEqual({ left: 0, planks: 4, logs: 1 });

  // Break a second block so the save holds both an edit to air and one to stone.
  const second = { x: spot.x + 2, y: spot.y - 1, z: spot.z };
  await page.evaluate((s) => (window as any).game.world.setBlock(s.x, s.y, s.z, 0), second);
  await page.evaluate(() => (window as any).game.saveGame());

  // Reload the page: the world list has it, and the edits come back.
  await openTitle(page);
  await openSandbox(page);
  await clickButton(page, 'Singleplayer');
  await page.locator('.world-item', { hasText: 'E2E World' }).click();
  await clickButton(page, 'Play Selected World');
  await waitForWorld(page);
  const after = await page.evaluate(({ t, s }) => {
    const g = (window as any).game;
    return { hole: g.world.getBlock(t.x, t.y, t.z), second: g.world.getBlock(s.x, s.y, s.z), planks: g.playerInventory.count(5) };
  }, { t: spot, s: second });
  expect(after.hole).toBe(placed);
  expect(after.second).toBe(0);
});

test('settings survive a reload @webkit', async ({ page }) => {
  await openTitle(page);
  // The options screen writes through SettingsStore.set, exactly like this.
  await page.evaluate(() => { const st = (window as any).game.settings; st.set('fov', 95); st.set('renderDistance', 5); st.set('viewBobbing', false); });
  await openTitle(page);
  const v = await page.evaluate(() => { const s = (window as any).game.settings.values; return { fov: s.fov, rd: s.renderDistance, bob: s.viewBobbing }; });
  expect(v).toEqual({ fov: 95, rd: 5, bob: false });

  // Corrupt storage does not break the game: defaults come back.
  await page.evaluate(() => localStorage.setItem('bunkcraft.settings', '{not json'));
  await openTitle(page);
  expect(await page.evaluate(() => (window as any).game.settings.values.fov)).toBe(70);

  await clickButton(page, 'Settings');
  await expect(page.getByText(/FOV/i).first()).toBeVisible();
});

