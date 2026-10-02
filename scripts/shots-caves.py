"""
Screenshots of caves, ravines, lava caverns, underground lakes and ore veins in a singleplayer world, from
the viewpoints that scripts/gen-spots.ts finds. Needs a Vite dev server without HMR or file watching
(see CLAUDE.md: `server: { hmr: false, watch: null }` in a temporary config).

  npx tsx scripts/gen-spots.ts 12345 > spots.json
  python3 scripts/shots-caves.py spots.json <outdir> [port] [seed]
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

spots_file, out = sys.argv[1], sys.argv[2]
port = sys.argv[3] if len(sys.argv) > 3 else '5188'
seed = sys.argv[4] if len(sys.argv) > 4 else '12345'
spots = json.load(open(spots_file))
VIEWS = [(k, spots[k]) for k in ('entrance', 'ravineAbove', 'ravineInside', 'cavernLava', 'lake', 'ore') if spots.get(k)]

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=30000)
    time.sleep(4)  # Game.start() is async: wait for the main menu
    page.evaluate(f"window.game.createWorld('caves', '{seed}', 'creative')")
    for _ in range(240):
        page.bring_to_front()
        if page.evaluate("window.game.state") not in ('loading', 'menu'):
            break
        time.sleep(0.5)
    page.evaluate("""() => {
        const g = window.game;
        g.input.locked = true; g.state = 'playing';
        g.player.canFly = true; g.player.flying = true;
        g.settings.setMany({ clouds: 'off', renderDistance: 10, brightness: 100 });
        document.querySelector('.click-to-play')?.remove();
    }""")
    for name, v in VIEWS:
        page.evaluate(f"""() => {{
            const g = window.game;
            g.player.setPosition({v['x']}, {v['y']}, {v['z']});
            g.player.yaw = {v['yaw']}; g.player.pitch = {v['pitch']};
            g.player.vx = g.player.vy = g.player.vz = 0;
            g.input.locked = true; g.state = 'playing';
            document.querySelector('.click-to-play')?.remove();
            // Caves are pitch dark: a glowstone above the camera lights the view (interior shots only).
            if ({'true' if name in ('ravineInside', 'cavernLava', 'lake', 'ore') else 'false'}) {{
                g.world.setBlock(Math.floor({v['x']}), Math.floor({v['y']}) + 1, Math.floor({v['z']}), 28);
            }}
        }}""")
        for _ in range(16):
            page.bring_to_front()
            time.sleep(0.5)
        page.screenshot(path=f'{out}/{name}.png')
        print('shot', name)
    # F3 chunk stats at the last view.
    page.keyboard.press('F3')
    for _ in range(4):
        page.bring_to_front()
        time.sleep(0.5)
    page.screenshot(path=f'{out}/f3.png')
    print('state', page.evaluate("window.game.state"))
    print('\n'.join(logs[:10]))
    browser.close()
