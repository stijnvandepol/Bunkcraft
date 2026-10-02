"""
Screenshots of the arcade maps through the dev preview (needs a Vite dev server without HMR or
file watching, see CLAUDE.md: `server: { hmr: false, watch: null }` in a temporary config).

  python3 scripts/shots.py <map id> <outdir> [port]
"""
import math
import sys
import time

from playwright.sync_api import sync_playwright

mapid, out = sys.argv[1], sys.argv[2]
port = sys.argv[3] if len(sys.argv) > 3 else '5199'
F = 64  # arena floor y


def look(frm, to):
    """Camera pose (x, y, z, yaw, pitch) at frm looking at to (both x, y, z)."""
    dx, dy, dz = to[0] - frm[0], to[1] - frm[1], to[2] - frm[2]
    return (*frm, math.atan2(-dx, -dz), math.atan2(dy, math.hypot(dx, dz)))


def top(h):
    return (0, F + h, 0.01, 0.0, -1.5707)


E = F + 2.6  # eye height above a floor-level spawn
VIEWS = {
    'classic': [('top', *top(80)), ('red', *look((-41.5, E, 6.5), (0, F + 3, 0)))],
    'suburb': [
        ('top', *top(42)), ('red', *look((-27.5, E, 3.5), (0, F + 3, 0))), ('blue', *look((28.5, E, -3.5), (0, F + 3, 0))),
        ('street', *look((0, E, 12), (-14, F + 3, 2))), ('roof', *look((-20, F + 6.6, 4), (10, F + 3, 0))),
        ('garage', *look((-19, E, 15.5), (-17, F + 2, 15.5))), ('house', *look((-21.5, E, 5), (-15.5, F + 2, 3))),
    ],
    'quarter': [
        ('top', *top(62)), ('red', *look((-33.5, E, 3.5), (0, F + 3, 0))), ('blue', *look((34.5, E, -3.5), (0, F + 3, 0))),
        ('courtyard', *look((0.5, E, 0.5), (-14, F + 4, 14))), ('alley', *look((-13, E, 5), (-13, F + 3, 28))),
        ('balcony', *look((-13, F + 5.6, 24), (-13, F + 3, 5))), ('roof', *look((-20, F + 8, 5), (0, F + 3, 0))),
    ],
    'dockyard': [
        ('top', *top(62)), ('red', *look((-39.5, E, 3.5), (0, F + 3, 0))), ('blue', *look((40.5, E, -3.5), (0, F + 3, 0))),
        ('yard', *look((-30, E, 15), (0, F + 3, 5))), ('crane', *look((-16, F + 6.6, 17), (0, F + 3, 0))),
        ('ship', *look((-30, F + 6.6, 27), (-10, F + 3, 5))), ('warehouse', *look((-0.5, E, 6), (-12, F + 2, 6))),
    ],
    'desert': [
        ('top', *top(70)), ('red', *look((-43.5, E, 3.5), (0, F + 3, 0))), ('blue', *look((44.5, E, -3.5), (0, F + 3, 0))),
        ('lane', *look((-40, E, 14), (40, F + 3, 14))), ('tower', *look((-42, F + 8.6, 23), (0, F + 3, 14))),
        ('market', *look((0.5, E, 10), (-14, F + 3, 4))), ('roof', *look((-23, F + 6.6, 5), (-45, F + 3, 14))),
    ],
}

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.arcadePreview)', timeout=30000)
    time.sleep(5)  # Game.start() is async: wait for the main menu
    page.evaluate(f"window.game.arcadePreview('tdm', 'You', '{mapid}')")
    for _ in range(240):
        page.bring_to_front()
        if page.evaluate("window.game.state") != 'loading':
            break
        time.sleep(0.5)
    page.evaluate("""() => {
        const g = window.game;
        g.input.locked = true; g.state = 'playing';
        g.previewServer.botsAggressive = false;
        g.player.canFly = true; g.player.flying = true;
        g.settings.setMany({ clouds: 'off' });
        document.querySelector('.click-to-play')?.remove();
    }""")
    for name, x, y, z, yaw, pitch in VIEWS[mapid]:
        page.evaluate(f"""() => {{
            const g = window.game;
            g.player.setPosition({x}, {y}, {z});
            g.player.yaw = {yaw}; g.player.pitch = {pitch};
            g.player.vx = g.player.vy = g.player.vz = 0;
            document.querySelector('.click-to-play')?.remove();
        }}""")
        for _ in range(10):
            page.bring_to_front()
            time.sleep(0.5)
        page.screenshot(path=f'{out}/{mapid}-{name}.png')
        print('shot', name)
    print('state', page.evaluate("window.game.state"))
    print('\n'.join(logs[:10]))
    browser.close()
