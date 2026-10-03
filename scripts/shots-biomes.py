"""
Screenshots of the biomes of generator version 3, from the ground and from above, at the viewpoints that
`scripts/gen-spots.ts --biomes` finds. Needs a Vite dev server without HMR or file watching (see CLAUDE.md).

  npx tsx scripts/gen-spots.ts 12345 --biomes > biomes.json
  python3 scripts/shots-biomes.py biomes.json <outdir> [port] [seed] [Biome,Biome,...]
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

spots_file, out = sys.argv[1], sys.argv[2]
port = sys.argv[3] if len(sys.argv) > 3 else '5189'
seed = sys.argv[4] if len(sys.argv) > 4 else '12345'
only = sys.argv[5].split(',') if len(sys.argv) > 5 and sys.argv[5] else None
shadows = sys.argv[6] if len(sys.argv) > 6 else 'low'
spots = json.load(open(spots_file))
VIEWS = [(k, v) for k, v in spots.items() if isinstance(v, dict) and (only is None or k.replace('_above', '') in only)]

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=60000)
    time.sleep(4)
    page.evaluate(f"window.game.createWorld('biomes', '{seed}', 'creative')")
    for _ in range(240):
        page.bring_to_front()
        if page.evaluate("window.game.state") not in ('loading', 'menu'):
            break
        time.sleep(0.5)
    page.evaluate("""() => {
        const g = window.game;
        g.input.locked = true; g.state = 'playing';
        g.player.canFly = true; g.player.flying = true;
        g.settings.setMany({ clouds: 'off', renderDistance: 8, brightness: 100, shadows: '""" + shadows + """' });
        g.world.time = 0.25;
        document.querySelector('.click-to-play')?.remove();
    }""")
    for name, v in VIEWS:
        page.evaluate(f"""() => {{
            const g = window.game;
            g.player.setPosition({v['x']}, {v['y']} - 1.62, {v['z']});
            g.player.yaw = {v['yaw']}; g.player.pitch = {v['pitch']};
            g.player.vx = g.player.vy = g.player.vz = 0;
            g.input.locked = true; g.state = 'playing';
            document.querySelector('.click-to-play')?.remove();
        }}""")
        for _ in range(30):
            page.bring_to_front()
            time.sleep(0.5)
        page.screenshot(path=f'{out}/{name}.png')
        print('shot', name, flush=True)
    print('\n'.join(logs[:10]))
    browser.close()
