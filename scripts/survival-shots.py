"""
Screenshots of the survival rules (effect icons, attack cooldown, sleeping, difficulty and game rule screens) through the
dev build. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/survival-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5287'


def wait(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        page.bring_to_front()
        time.sleep(0.2)


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=60000)
    page.evaluate("window.game.createWorld('rules', '4242', 'survival', { difficulty: 'hard' })")
    seen_loading = False
    for _ in range(1500):
        page.bring_to_front()
        st = page.evaluate("window.game.state")
        seen_loading = seen_loading or st == 'loading'
        if seen_loading and st not in ('menu', 'loading'):
            break
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'; window.game.stack.clear()")
    wait(page, 2)

    # Effect icons (top right), absorption hearts, a sword in hand.
    page.evaluate("""async () => {
      const I = await import('/src/items/ItemRegistry.ts');
      const g = window.game, s = g.stats, fx = s.effects;
      g.cycle.time = 0.25;
      g.playerInventory.set(0, { id: I.itemId('diamond_sword'), count: 1 });
      g.playerInventory.set(1, { id: I.SHIELD, count: 1 });
      g.hotbar.select(0);
      fx.add('speed', 1, 20 * 90, s);
      fx.add('strength', 0, 20 * 45, s);
      fx.add('regeneration', 1, 20 * 8, s);
      fx.add('poison', 0, 20 * 20, s);
      fx.add('night_vision', 0, 20 * 300, s);
      fx.add('absorption', 0, 20 * 120, s);
      s.health = 15;
    }""")
    wait(page, 6)  # the advancement toasts cover the top right at first
    page.screenshot(path=f'{out}/effects.png')

    # Attack cooldown: swing, then capture while the bar fills.
    page.evaluate("window.game.interaction.cooldown.swing()")
    time.sleep(0.25)
    page.screenshot(path=f'{out}/cooldown.png')

    # Sleeping: a bed next to the player at night.
    print('bed', page.evaluate("""async () => {
      const R = await import('/src/world/BlockRegistry.ts');
      const g = window.game, p = g.player, w = g.world;
      g.stats.effects.clear(g.stats);
      const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
      for (let dx = -1; dx <= 3; dx++) for (let dz = -1; dz <= 2; dz++) { w.setBlock(x + dx, y - 1, z + dz, R.BLOCK.STONE); w.setBlock(x + dx, y, z + dz, 0); w.setBlock(x + dx, y + 1, z + dz, 0); }
      w.setBlock(x, y, z, R.BLOCK.BED, (14 << 3) | 0);
      w.setBlock(x, y, z + 1, R.BLOCK.BED, (14 << 3) | 0 | 4);
      g.cycle.time = 0.7; g.cycle.compute();
      for (const m of g.entities.mobs) if (m.type.hostile) m.removed = true;
      g.worldRules.useBed(x, y, z);
      return [x, y, z, g.worldRules.sleeping];
    }"""))
    wait(page, 3)
    page.screenshot(path=f'{out}/sleeping.png')
    wait(page, 3.5)
    print('after sleep', page.evaluate("[window.game.worldRules.sleeping, window.game.cycle.time]"))

    # Pause menu with the difficulty and game rules buttons.
    page.evaluate("window.game.pause()")
    wait(page, 0.8)
    page.screenshot(path=f'{out}/pause.png')
    page.evaluate("[...document.querySelectorAll('.mc-btn')].find((b) => b.textContent.startsWith('Game Rules')).click()")
    wait(page, 0.6)
    page.screenshot(path=f'{out}/gamerules.png')
    page.evaluate("window.game.stack.clear(); window.game.menu.showCreate()")
    wait(page, 0.6)
    page.screenshot(path=f'{out}/create-world.png')
    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
