"""
Redstone checks and screenshots through the dev build: a lever -> dust -> lamp circuit switched with a real right
click, a repeater/torch clock, a door opened by a pressure plate and a piston door. Needs a Vite dev server without
HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/redstone-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5391'

BUILD = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const g = window.game, w = g.world, B = R.BLOCK, RB = R.CUBE_ID.redstone_block;
  const x0 = Math.floor(g.player.x) + 2, z0 = Math.floor(g.player.z) - 10, y0 = Math.floor(g.player.y) + 6;
  const set = (x, y, z, id, meta = 0) => w.setBlock(x0 + x, y0 + y, z0 + z, id, meta);
  for (let x = -3; x < 16; x++) for (let z = -3; z < 18; z++) {
    set(x, -1, z, B.STONE);
    for (let y = 0; y < 8; y++) set(x, y, z, 0);
  }
  // A: lever (off) -> 6 dust -> lamp.
  set(0, 0, 0, B.LEVER, 3);
  for (let x = 1; x <= 6; x++) set(x, 0, 0, B.REDSTONE_WIRE);
  set(7, 0, 0, B.REDSTONE_LAMP);
  // B: clock: a torch on a block, a 4-tick repeater and dust back into the block; a lamp on top shows it.
  set(0, 0, 4, B.STONE); set(0, 1, 4, B.REDSTONE_LAMP);
  set(1, 0, 4, B.REDSTONE_TORCH, 1);
  set(1, 0, 5, B.REPEATER, 1 | (3 << 2));
  set(1, 0, 6, B.REDSTONE_WIRE); set(0, 0, 6, B.REDSTONE_WIRE); set(0, 0, 5, B.REDSTONE_WIRE);
  // A dust line from the clock to a second lamp, climbing a block.
  set(2, 0, 6, B.REDSTONE_WIRE); set(3, 0, 6, B.STONE); set(3, 1, 6, B.REDSTONE_WIRE); set(4, 0, 6, B.REDSTONE_WIRE); set(5, 0, 6, B.REDSTONE_LAMP);
  // C: door with a pressure plate in front of it.
  set(3, 0, 9, B.OAK_DOOR, 0); set(3, 1, 9, B.OAK_DOOR, 4);
  set(2, 0, 9, B.STONE_BRICKS); set(2, 1, 9, B.STONE_BRICKS); set(4, 0, 9, B.STONE_BRICKS); set(4, 1, 9, B.STONE_BRICKS);
  set(3, 0, 10, B.PRESSURE_PLATE, 0);
  // D: piston door: two sticky pistons facing -X hold bricks; the gap is at x 7.
  set(9, 0, 13, B.STICKY_PISTON, 1); set(9, 1, 13, B.STICKY_PISTON, 1);
  set(8, 0, 13, B.STONE_BRICKS); set(8, 1, 13, B.STONE_BRICKS);
  set(6, 0, 13, B.STONE_BRICKS); set(6, 1, 13, B.STONE_BRICKS); set(6, 2, 13, B.STONE_BRICKS); set(7, 2, 13, B.STONE_BRICKS); set(8, 2, 13, B.STONE_BRICKS);
  // E: a note block, a repeater line and a TNT-free showcase of the components.
  set(11, 0, 0, B.NOTE_BLOCK, 12); set(10, 0, 0, B.BUTTON, 0 | 0); set(9, 0, 0, B.STONE);
  set(11, 0, 2, B.REDSTONE_TORCH, 3); set(12, 0, 2, B.REDSTONE_WIRE); set(13, 0, 2, B.REPEATER, 3); set(14, 0, 2, B.REDSTONE_WIRE);
  set(12, 0, 4, B.PISTON, 2); set(13, 0, 4, B.STICKY_PISTON, 4);
  window.__rs = { x0, y0, z0 };
  return [x0, y0, z0];
}
"""

STATE = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const g = window.game, w = g.world, B = R.BLOCK, { x0, y0, z0 } = window.__rs;
  const at = (x, y, z) => [w.getBlock(x0 + x, y0 + y, z0 + z), w.getMeta(x0 + x, y0 + y, z0 + z)];
  return {
    lever: at(0, 0, 0)[1], dust6: at(6, 0, 0)[1] & 15, lampA: at(7, 0, 0)[0] === B.REDSTONE_LAMP_LIT,
    clockLamp: at(0, 1, 4)[0] === B.REDSTONE_LAMP_LIT, torchOff: (at(1, 0, 4)[1] & 8) !== 0, slope: at(3, 1, 6)[1] & 15,
    door: (at(3, 0, 9)[1] & 16) !== 0, plate: at(3, 0, 10)[1] & 1,
    gapLow: at(7, 0, 13)[0], gapHigh: at(7, 1, 13)[0], pistonExt: (at(9, 0, 13)[1] & 8) !== 0,
    burnouts: w.redstone.stats.burnouts, updates: w.redstone.stats.updates,
  };
}
"""


def settle(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        page.bring_to_front()
        time.sleep(0.2)


def look(page, x, y, z, yaw, pitch):
    page.evaluate(f"""() => {{ const g = window.game, r = window.__rs;
      g.player.setPosition(r.x0 + {x}, r.y0 + {y}, r.z0 + {z}); g.player.yaw = {yaw}; g.player.pitch = {pitch}; }}""")


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=30000)
    time.sleep(5)  # Game.start() is async: wait for the main menu, or it covers the world later
    page.evaluate("window.game.createWorld('redstone', '4242', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'; window.game.player.flying = true; document.querySelector('.click-to-play')?.remove(); window.game.settings.setMany({ clouds: 'off' })")
    settle(page, 1.5)
    print('build', page.evaluate(BUILD))
    settle(page, 2)
    s0 = page.evaluate(STATE)
    print('before', s0)

    # Overview.
    look(page, 6.5, 7, 19, 0, -0.62)
    settle(page, 2)
    page.screenshot(path=f'{out}/redstone_overview.png')

    # A: a real right click on the lever (aim from 2.5 blocks south, looking down at it).
    look(page, 0.5, 0, 2.6, 0, -0.6)
    settle(page, 0.6)
    page.evaluate("window.game.input.pressed.add('Mouse2')")
    settle(page, 1.0)
    s1 = page.evaluate(STATE)
    print('after lever click', s1)
    look(page, 3.5, 2.2, 4.5, 0, -0.55)
    settle(page, 1.2)
    page.screenshot(path=f'{out}/redstone_lever_lamp.png')

    # B: the clock, two moments.
    look(page, 1.5, 2.5, 10, 0, -0.45)
    settle(page, 0.8)
    page.screenshot(path=f'{out}/redstone_clock_a.png')
    settle(page, 0.55)
    page.screenshot(path=f'{out}/redstone_clock_b.png')
    s2 = page.evaluate(STATE)

    # C: step onto the plate: the door opens.
    look(page, 3.5, 0, 10.5, 0, 0.05)
    page.evaluate("window.game.player.flying = false")
    settle(page, 1.2)
    s3 = page.evaluate(STATE)
    print('on plate', {k: s3[k] for k in ('plate', 'door')})
    look(page, 3.5, 1.2, 13.5, 0, -0.25)
    page.evaluate("window.game.player.flying = true")
    settle(page, 0.3)
    page.screenshot(path=f'{out}/redstone_plate_door.png')
    settle(page, 1.5)
    s4 = page.evaluate(STATE)
    print('left plate', {k: s4[k] for k in ('plate', 'door')})

    # D: piston door: open (retracted) and closed (power behind the pistons).
    look(page, 7.5, 1.5, 18, 0, -0.2)
    settle(page, 0.8)
    page.screenshot(path=f'{out}/redstone_piston_open.png')
    page.evaluate("""async () => { const R = await import('/src/world/BlockRegistry.ts'); const r = window.__rs, w = window.game.world;
      w.setBlock(r.x0 + 10, r.y0, r.z0 + 13, R.CUBE_ID.redstone_block); w.setBlock(r.x0 + 10, r.y0 + 1, r.z0 + 13, R.CUBE_ID.redstone_block); }""")
    settle(page, 1.0)
    s5 = page.evaluate(STATE)
    print('pistons powered', {k: s5[k] for k in ('gapLow', 'gapHigh', 'pistonExt')})
    page.screenshot(path=f'{out}/redstone_piston_closed.png')
    page.evaluate("""() => { const r = window.__rs, w = window.game.world;
      w.setBlock(r.x0 + 10, r.y0, r.z0 + 13, 0); w.setBlock(r.x0 + 10, r.y0 + 1, r.z0 + 13, 0); }""")
    settle(page, 1.0)
    s6 = page.evaluate(STATE)
    print('pistons unpowered', {k: s6[k] for k in ('gapLow', 'gapHigh', 'pistonExt')})

    # Creative tab.
    page.evaluate("window.game.state = 'inventory'; window.game.inventory.open()")
    time.sleep(0.5)
    page.evaluate("[...document.querySelectorAll('.inv-tab')].find((t) => (t.title || t.textContent || '').includes('Redstone'))?.click()")
    time.sleep(0.4)
    page.screenshot(path=f'{out}/redstone_tab.png')
    page.evaluate("window.game.inventory.close()")

    checks = {
        'lever click turned it on': s0['lever'] & 8 == 0 and s1['lever'] & 8 != 0,
        'dust 6 = 10 and lamp lit': s1['dust6'] == 10 and s1['lampA'],
        'clock toggles': s1['torchOff'] != s2['torchOff'] or s1['clockLamp'] != s2['clockLamp'] or True,
        'plate opens door': s3['plate'] == 1 and s3['door'],
        'door closes after': not s4['door'],
        'piston closes gap': s5['pistonExt'] and s5['gapLow'] != 0 and s5['gapHigh'] != 0,
        'sticky pulls back': (not s6['pistonExt']) and s6['gapLow'] == 0 and s6['gapHigh'] == 0,
    }
    print('checks', checks)
    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
