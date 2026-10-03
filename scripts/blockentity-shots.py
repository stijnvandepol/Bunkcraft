"""
Screenshots of the block entities (lit furnace block, furnace screen mid-smelt, chest and double chest screens) through
the dev build. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/blockentity-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5199'

SETUP = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const I = await import('/src/items/ItemRegistry.ts');
  const g = window.game, w = g.world, B = R.BLOCK;
  const x0 = Math.floor(g.player.x), z0 = Math.floor(g.player.z) - 5, y0 = Math.floor(g.player.y);
  for (let x = -4; x <= 4; x++) for (let z = -3; z <= 6; z++) {
    w.setBlock(x0 + x, y0 - 1, z0 + z, B.STONE_BRICKS);
    for (let y = 0; y < 5; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0);
  }
  // Two furnaces with their front to the player (placed looking north = state 0), the left one burning; a double chest.
  w.setBlock(x0 - 2, y0, z0, B.FURNACE, 0);
  w.setBlock(x0 - 1, y0, z0, B.FURNACE, 0);
  w.setBlock(x0 + 1, y0, z0, B.CHEST, 0);
  w.setBlock(x0 + 2, y0, z0, B.CHEST, 0);
  w.setBlock(x0 + 1, y0, z0, B.CHEST, 4);
  w.setBlock(x0 + 2, y0, z0, B.CHEST, 8);
  w.setBlock(x0 + 3, y0, z0 + 2, B.CHEST, 0);
  const f = w.blockEntities.containerAt(x0 - 2, y0, z0).entity;
  f.slots[0] = { id: I.itemId('raw_iron'), count: 12 };
  f.slots[1] = { id: I.ITEM.COAL, count: 7 };
  f.slots[2] = { id: I.itemId('iron_ingot'), count: 3 };
  f.changed();
  for (let t = 0; t < 110; t++) w.blockEntities.tick();
  const big = w.blockEntities.containerAt(x0 + 2, y0, z0).entity;
  const fill = [I.itemId('iron_ingot'), I.ITEM.DIAMOND, B.OAK_LOG, B.COBBLESTONE, I.ITEM.BREAD ?? I.itemId('bread'), I.ITEM.BONE, B.TORCH, I.ITEM.IRON_PICKAXE, I.ITEM.COAL];
  for (let i = 0; i < 54; i += 3) big.slots[i] = { id: fill[i % fill.length], count: I.getItemDef(fill[i % fill.length]).maxStack > 1 ? 1 + (i * 7) % 64 : 1 };
  big.changed();
  const small = w.blockEntities.containerAt(x0 + 3, y0, z0 + 2).entity;
  small.slots[0] = { id: I.ITEM.DIAMOND, count: 5 };
  small.slots[4] = { id: I.ITEM.IRON_PICKAXE, count: 1, damage: 80 };
  small.slots[13] = { id: B.OAK_PLANKS, count: 32 };
  small.changed();
  const inv = g.playerInventory;
  inv.set(0, { id: I.ITEM.COAL, count: 20 });
  inv.set(1, { id: B.COBBLESTONE, count: 64 });
  inv.set(2, { id: I.itemId('raw_iron'), count: 9 });
  inv.set(9, { id: B.OAK_LOG, count: 16 });
  g.player.setPosition(x0 + 0.5, y0, z0 + 4.5);
  g.player.yaw = 0; g.player.pitch = -0.25;
  g.player.flying = true;
  g.cycle.time = 0.78;
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
    page.evaluate("window.game.createWorld('blockentities', '4242', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    time.sleep(1.5)
    x0, y0, z0 = page.evaluate(SETUP)
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'; window.game.stack.clear()")
    for _ in range(15):
        page.bring_to_front()
        time.sleep(0.4)
    page.screenshot(path=f'{out}/furnace-lit-block.png')

    def screen(x, y, z, name):
        page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
        page.evaluate(f"window.game.containers.open({x}, {y}, {z})")
        for _ in range(5):
            page.bring_to_front()
            time.sleep(0.3)
        page.screenshot(path=f'{out}/{name}.png')
        page.evaluate("window.game.survivalInventory.close(); window.game.state = 'playing'")

    screen(x0 - 2, y0, z0, 'furnace-ui')
    screen(x0 + 3, y0, z0 + 2, 'chest-ui')
    screen(x0 + 1, y0, z0, 'double-chest-ui')
    print('\n'.join(logs[:20]))
    browser.close()
