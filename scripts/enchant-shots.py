"""
Screenshots of experience and enchanting: XP bar and orbs, the enchanting table with offers, an enchanted sword (glint in the
hand, hotbar and tooltip), the anvil and the grindstone, and the three blocks in the world. Needs a Vite dev server without
HMR or file watching (see CLAUDE.md), e.g. `npx vite --config vite.shots.config.ts`.

  python3 scripts/enchant-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5199'


def settle(page, n=8, dt=0.25):
    for _ in range(n):
        page.bring_to_front()
        time.sleep(dt)


BUILD = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const g = window.game, w = g.world, B = R.BLOCK;
  const x0 = Math.floor(g.player.x), z0 = Math.floor(g.player.z) - 8, y0 = Math.floor(g.player.y);
  const set = (x, y, z, id, meta = 0) => w.setBlock(x0 + x, y0 + y, z0 + z, id, meta);
  for (let x = -6; x <= 8; x++) for (let z = -4; z <= 6; z++) {
    set(x, -1, z, B.OAK_PLANKS);
    for (let y = 0; y < 6; y++) set(x, y, z, 0);
  }
  // Enchanting table with a full ring of bookshelves (two high, one gap for the player).
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
    if (dz === 2 && dx === 0) continue;
    set(dx, 0, dz, B.BOOKSHELF); set(dx, 1, dz, B.BOOKSHELF);
  }
  set(0, 0, 0, B.ENCHANTING_TABLE);
  set(5, 0, 1, B.ANVIL, 0); set(6, 0, 3, B.ANVIL, 3 | (1 << 2)); set(4, 0, 3, B.ANVIL, (2 << 2));
  set(-4, 0, 2, B.GRINDSTONE, 0); set(-4, 0, 4, B.GRINDSTONE, 3);
  set(2, 0, 5, B.TORCH); set(-2, 0, 5, B.TORCH);
  g.player.setPosition(x0 + 0.5, y0 + 2.2, z0 + 9.5);
  g.player.yaw = 0; g.player.pitch = -0.35; g.player.flying = true;
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
    page.evaluate("window.game.createWorld('enchant', '4242', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    settle(page, 6)
    origin = page.evaluate(BUILD)
    print('build', origin)
    settle(page, 14)
    page.screenshot(path=f'{out}/enchant-blocks.png')

    # Survival with levels, an enchanted sword in hand and orbs in front of the player.
    page.evaluate("""async () => {
      const I = await import('/src/items/ItemRegistry.ts');
      const g = window.game;
      g.setMode('survival');
      g.player.flying = false;
      const inv = g.playerInventory;
      inv.clear();
      const id = I.itemId;
      inv.set(0, { id: id('diamond_sword'), count: 1, data: { sharpness: 5, looting: 3, unbreaking: 3, fire_aspect: 2 } });
      inv.set(1, { id: id('iron_pickaxe'), count: 1, damage: 120, data: { efficiency: 4, fortune: 2 } });
      inv.set(2, { id: I.ITEM.ENCHANTED_BOOK, count: 1, data: { mending: 1 } });
      inv.set(3, { id: id('lapis_lazuli'), count: 32 });
      inv.set(4, { id: id('bow'), count: 1, data: { power: 4, infinity: 1 } });
      inv.set(5, { id: id('book'), count: 3 });
      inv.set(6, { id: id('iron_ingot'), count: 5 });
      inv.set(7, { id: id('diamond_pickaxe'), count: 1 });
      inv.setArmor(3, { id: id('diamond_boots'), count: 1, data: { feather_falling: 4, depth_strider: 3 } });
      g.hotbar.select(0);
      g.stats.xp.set(1000);
      const p = g.player;
      // Just outside the 8 block pull so they stay put for the picture.
      g.entities.spawnXp(p.x + 0.6, p.y + 0.4, p.z - 8.6, 3);
      g.entities.spawnXp(p.x - 1.2, p.y + 0.4, p.z - 9.2, 17);
      g.entities.spawnXp(p.x + 2.0, p.y + 0.4, p.z - 9.6, 73);
      g.entities.spawnXp(p.x - 2.6, p.y + 0.4, p.z - 9.0, 1);
      g.entities.spawnXp(p.x + 0.2, p.y + 0.4, p.z - 10.5, 600);
    }""")
    # Keep the orbs where they are for the shot: nobody collects them, and the player looks down at them.
    page.evaluate("window.game.player.pitch = -0.25")
    settle(page, 6)
    page.evaluate("for (const o of window.game.entities.orbs) { o.vx = o.vz = 0; }")
    settle(page, 3)
    page.screenshot(path=f'{out}/xp-bar-orbs.png')
    print('level', page.evaluate("window.game.stats.xp.level"), 'orbs', page.evaluate("window.game.entities.orbs.length"))

    # The enchanting table with an item and lapis.
    page.evaluate("""() => {
      const g = window.game;
      const [x, y, z] = %s;
      g.progression.open('enchant', x, y, z);
      const box = g.survivalInventory.box;
      box.slots[0] = { id: g.playerInventory.get(7).id, count: 1 };
      g.playerInventory.set(7, { id: 0, count: 0 });
      box.slots[1] = { ...g.playerInventory.get(3), count: 12 };
      box.onChange();
      g.survivalInventory.refresh();
    }""" % str(origin))
    page.evaluate("window.game.input.locked = false")
    time.sleep(0.6)
    page.screenshot(path=f'{out}/enchanting-table.png')
    print('offers', page.evaluate("document.querySelectorAll('.ench-offer.ok').length"))
    page.click('.ench-offer.ok >> nth=-1')
    time.sleep(0.4)
    page.hover('.inv-box .inv-slot >> nth=0')
    time.sleep(0.3)
    page.screenshot(path=f'{out}/enchanting-applied.png')
    page.evaluate("window.game.survivalInventory.close(); window.game.state = 'playing'")

    # Tooltip of the enchanted sword in the survival inventory.
    page.evaluate("window.game.state = 'inventory'; window.game.survivalInventory.open(new Set())")
    time.sleep(0.4)
    page.hover('.inv-hotbar .inv-slot >> nth=0')
    time.sleep(0.4)
    page.screenshot(path=f'{out}/sword-tooltip.png')
    page.evaluate("window.game.survivalInventory.close()")

    # The anvil: a worn enchanted pickaxe and a Mending book, renamed.
    page.evaluate("""() => {
      const g = window.game;
      const [x, y, z] = %s;
      g.state = 'playing';
      g.progression.open('anvil', x + 5, y, z + 1);
      const box = g.survivalInventory.box;
      box.slots[0] = { ...g.playerInventory.get(1) }; g.playerInventory.set(1, { id: 0, count: 0 });
      box.slots[1] = { ...g.playerInventory.get(2) }; g.playerInventory.set(2, { id: 0, count: 0 });
      box.onChange();
      g.survivalInventory.refresh();
    }""" % str(origin))
    page.fill('.anvil-name', 'Old Faithful')
    time.sleep(0.4)
    page.hover('.inv-box .inv-slot >> nth=2')
    time.sleep(0.3)
    page.screenshot(path=f'{out}/anvil.png')
    page.evaluate("window.game.survivalInventory.close()")

    # The grindstone with the enchanted bow.
    page.evaluate("""() => {
      const g = window.game;
      const [x, y, z] = %s;
      g.state = 'playing';
      g.progression.open('grindstone', x - 4, y, z + 2);
      const box = g.survivalInventory.box;
      box.slots[0] = { ...g.playerInventory.get(4) }; g.playerInventory.set(4, { id: 0, count: 0 });
      box.onChange();
      g.survivalInventory.refresh();
    }""" % str(origin))
    time.sleep(0.4)
    page.screenshot(path=f'{out}/grindstone.png')
    page.evaluate("window.game.survivalInventory.close()")

    # The glint on the held sword (hand and hotbar).
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'; window.game.hotbar.select(1); window.game.hotbar.select(0); window.game.player.pitch = -0.1")
    settle(page, 6)
    page.screenshot(path=f'{out}/sword-glint.png')
    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
