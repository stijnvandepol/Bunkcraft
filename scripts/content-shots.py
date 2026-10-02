"""
Screenshots of the content (creative tabs, a build with the new blocks, armor HUD, survival inventory, chest) through
the dev build. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/content-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5199'

SHOWCASE = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const I = await import('/src/items/ItemRegistry.ts');
  const C = await import('/src/world/Content.ts');
  const g = window.game, w = g.world, B = R.BLOCK, CU = R.CUBE_ID;
  const x0 = Math.floor(g.player.x) + 2, z0 = Math.floor(g.player.z) - 14, y0 = Math.floor(g.player.y);
  const set = (x, y, z, id, meta = 0) => w.setBlock(x0 + x, y0 + y, z0 + z, id, meta);
  for (let x = -1; x < 22; x++) for (let z = -1; z < 18; z++) {
    set(x, -1, z, B.STONE);
    for (let y = 0; y < 9; y++) set(x, y, z, 0);
  }
  // Colour rows.
  for (let i = 0; i < 16; i++) {
    set(i, 0, 0, B.WOOL, i); set(i, 0, 1, B.CONCRETE, i); set(i, 0, 2, B.STAINED_TERRACOTTA, i);
    set(i, 0, 3, B.GLAZED_TERRACOTTA, i); set(i, 0, 4, B.STAINED_GLASS, i); set(i, 0, 5, B.CARPET, i);
    set(i, 1, 4, B.STAINED_GLASS_PANE, i);
  }
  // Materials.
  const names = ['granite','diorite','andesite','polished_granite','tuff','calcite','deepslate','cobbled_deepslate','deepslate_bricks','red_sandstone','mud_bricks','copper_block','lapis_block','emerald_block','hay_block','pumpkin','jack_o_lantern','melon','packed_ice','sea_lantern','bone_block'];
  names.forEach((n, i) => set(i, 0, 7, CU[n]));
  ['jungle','acacia','dark_oak','mangrove','cherry'].forEach((n, i) => { set(i * 2, 0, 9, CU[n + '_log']); set(i * 2, 1, 9, CU[n + '_log']); set(i * 2 + 1, 0, 9, CU[n + '_planks']); set(i * 2 + 1, 1, 9, CU['stripped_' + n + '_log']); set(i * 2, 2, 9, CU[n + '_leaves']); });
  // Walls, fences, gates, panes, trapdoors.
  for (let i = 0; i < 8; i++) { set(i, 0, 11, B.FENCE, i); set(i, 0, 12, B.TRAPDOOR, i << 4); }
  set(8, 0, 11, B.FENCE_GATE, 0 | (3 << 3)); set(9, 0, 11, B.FENCE, 3); set(10, 0, 11, B.FENCE_GATE, (4 << 3) | 4);
  for (let i = 0; i < 6; i++) { set(12 + i, 0, 11, B.WALL, i); set(12 + i, 1, 11, B.WALL, i); }
  for (let i = 0; i < 6; i++) { set(12 + i, 0, 13, B.GLASS_PANE); set(12 + i, 1, 13, B.GLASS_PANE); set(12 + i, 0, 14, B.IRON_BARS); }
  // Slabs, stairs, door, ladder, bed, chest, lantern, plants.
  for (let i = 0; i < 12; i++) { set(i, 0, 15, B.SLAB_X, i << 2); set(i, 0, 16, B.STAIRS_X, (i << 3) | 0); }
  set(14, 0, 16, B.DOOR, (3 << 5) | 0); set(14, 1, 16, B.DOOR, (3 << 5) | 4);
  set(16, 0, 16, B.LADDER, 0); set(16, 1, 16, B.LADDER, 0); set(16, 2, 16, B.STONE);
  set(18, 0, 15, B.BED, (14 << 3) | 1); set(18, 0, 16, B.BED, (14 << 3) | 1 | 4);
  set(20, 0, 15, B.CHEST, 1); set(20, 0, 13, B.LANTERN);
  for (let i = 0; i < 7; i++) set(i, 0, 17, B.SAPLING, i);
  ['blue_orchid','allium','azure_bluet','red_tulip','orange_tulip','oxeye_daisy','cornflower','lily_of_the_valley','fern','sugar_cane','red_mushroom'].forEach((n, i) => set(8 + i, 0, 17, CU[n]));
  g.player.setPosition(x0 + 10.5, y0 + 4, z0 + 26);
  g.player.yaw = 0; g.player.pitch = -0.38;
  g.player.flying = true;
  return [x0, y0, z0];
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=30000)
    page.evaluate("window.game.createWorld('shots', '4242', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    time.sleep(1.5)

    # A build with the new blocks.
    print('showcase', page.evaluate(SHOWCASE))
    for _ in range(20):
        page.bring_to_front()
        time.sleep(0.4)
    page.screenshot(path=f'{out}/build.png')
    page.evaluate("window.game.player.setPosition(window.game.player.x - 6, window.game.player.y - 2.5, window.game.player.z - 5); window.game.player.pitch = -0.1")
    for _ in range(8):
        page.bring_to_front()
        time.sleep(0.3)
    page.screenshot(path=f'{out}/build2.png')

    # Creative tabs.
    page.evaluate("window.game.state = 'inventory'; window.game.inventory.open()")
    time.sleep(0.5)
    n_tabs = page.evaluate("document.querySelectorAll('.inv-tab').length")
    print('tabs', n_tabs)
    for i in range(n_tabs):
        page.evaluate(f"document.querySelectorAll('.inv-tab')[{i}].click()")
        time.sleep(0.25)
        page.screenshot(path=f'{out}/tab{i}.png')
    # Search.
    page.evaluate("document.querySelectorAll('.inv-tab')[5].click()")
    page.fill('.inv-search', 'slab')
    time.sleep(0.3)
    page.screenshot(path=f'{out}/search.png')
    page.evaluate("window.game.inventory.close()")

    # Survival: armor, hearts, recipes and a chest.
    page.evaluate("""async () => {
      const I = await import('/src/items/ItemRegistry.ts');
      const g = window.game;
      g.setMode('survival');
      const inv = g.playerInventory;
      inv.clear();
      const id = I.itemId;
      inv.add({ id: id('oak_planks'), count: 24 }); inv.add({ id: id('cobblestone'), count: 40 }); inv.add({ id: id('iron_ingot'), count: 12 });
      inv.add({ id: id('stick'), count: 20 }); inv.add({ id: id('diamond'), count: 6 }); inv.add({ id: id('wheat'), count: 9 });
      inv.add({ id: id('crafting_table'), count: 1 }); inv.add({ id: id('apple'), count: 3 }); inv.add({ id: id('coal'), count: 9 });
      inv.setArmor(0, { id: id('iron_helmet'), count: 1, damage: 20 }); inv.setArmor(1, { id: id('diamond_chestplate'), count: 1 });
      inv.setArmor(2, { id: id('golden_leggings'), count: 1 }); inv.setArmor(3, { id: id('leather_boots'), count: 1 });
      g.stats.health = 13; g.stats.hunger = 14;
    }""")
    time.sleep(0.5)
    page.evaluate("window.game.state = 'playing'")
    time.sleep(0.6)
    page.screenshot(path=f'{out}/armor_hud.png')
    page.evaluate("window.game.state = 'inventory'; window.game.survivalInventory.open(new Set(['table', 'furnace']))")
    time.sleep(0.5)
    page.screenshot(path=f'{out}/survival.png')
    page.evaluate("window.game.survivalInventory.close()")
    page.evaluate("""() => {
      const g = window.game;
      const slots = g.world.containers.slotsAt(1, 80, 1);
      slots[0] = { id: 264, count: 3 }; slots[1] = { id: 5, count: 20 }; slots[2] = { id: 270, count: 1, damage: 5, data: { efficiency: 2 } };
      g.survivalInventory.open(new Set(), { title: 'Chest', slots });
    }""")
    time.sleep(0.5)
    page.screenshot(path=f'{out}/chest.png')
    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
