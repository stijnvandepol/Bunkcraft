"""
Screenshots of the arcade maps through the dev preview (needs a Vite dev server without HMR or
file watching, see CLAUDE.md: `server: { hmr: false, watch: null }` in a temporary config).

  python3 scripts/shots.py <map id> <outdir> [port] [view,view,...]
"""
import math
import sys
import time

from playwright.sync_api import sync_playwright

mapid, out = sys.argv[1], sys.argv[2]
port = sys.argv[3] if len(sys.argv) > 3 else '5199'
only = sys.argv[4].split(',') if len(sys.argv) > 4 else None
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
    'atomic': [
        ('top', *top(52)), ('red', *look((-33.5, E, -2.5), (0, F + 3, 0))), ('blue', *look((32.5, E, 1.5), (0, F + 3, 0))),
        ('street', *look((-3.5, E, 21), (-14, F + 4, -4))), ('mint', *look((-6, E, -6), (24, F + 4, 3))),
        ('window', *look((-15.5, F + 5, -7), (20, F + 2, 2))), ('bus', *look((-6, E, -11), (-9, F + 2, -17))),
        ('inside', *look((-24.5, F + 1, -1), (-16, F + 1.5, -5))), ('upstairs', *look((-24.5, F + 5, 1), (-15, F + 5.5, -6))),
        ('garage', *look((-25, F + 5, 11), (8, F + 3, -2))), ('pool', *look((-27, F + 4.5, 22), (-16, F + 1, 16))),
    ],
    'plaza': [
        ('top', *top(52)), ('red', *look((-31.5, E, -0.5), (0, F + 3, 0))), ('fountain', *look((-12, E, 3), (6, F + 3, -3))),
        ('tram', *look((-13, E, -15), (-2, F + 2, -21))), ('arcade', *look((-27, F + 1, 16), (-4, F + 2, 16))),
        ('balcony', *look((-14.5, F + 5, -11), (14, F + 2, 4))), ('lobby', *look((-17.5, F + 1, -9), (-25, F + 1.5, -7))),
        ('roofwalk', *look((-24, F + 5, 16), (6, F + 3, 0))), ('terrace', *look((-11, E, 12), (-20, F + 2, 6))),
    ],
    'site': [
        ('top', *top(50)), ('red', *look((-29.5, E, -0.5), (0, F + 3, 0))), ('shell', *look((-14, E, -3), (2, F + 4, 2))),
        ('slab', *look((-8, F + 5, -2), (8, F + 4, 3))), ('deck', *look((-8, F + 9, -8), (10, F + 2, 6))),
        ('dig', *look((-24, E, -15), (-6, F + 2, -18))), ('scaffold', *look((-12, F + 4, 19), (-22, F + 3, 15))),
        ('crane', *look((-26, F + 3, 14), (-4, F + 7, 8))),
    ],
    'carrier': [
        ('top', *top(50)), ('red', *look((-32.5, F + 1, -0.5), (0, F + 3, 0))), ('deck', *look((-26, E, 3), (6, F + 2, -3))),
        ('bridge', *look((-19, F + 5, -14), (8, F + 2, 4))), ('island', *look((-4, E, -9), (-20, F + 5, -16))),
        ('elevator', *look((-3, E, 9), (-16, F + 4, 15))), ('jets', *look((-28, E, -12), (-2, F + 2, -16))),
    ],
    'shanty': [
        ('top', *top(50)), ('red', *look((-29.5, E, -0.5), (0, F + 3, 0))), ('tower', *look((-14, E, -1), (2, F + 6, 1))),
        ('alley', *look((-24, E, -17), (-2, F + 3, -18))), ('market', *look((-24, E, 16), (-4, F + 2, 18))),
        ('bridge', *look((-21, F + 5, -12), (-8, F + 5, -10))), ('roofs', *look((-11, F + 5, -10), (8, F + 4, 6))),
        ('balcony', *look((-9, F + 5, 5), (10, F + 2, -2))),
    ],
    'mall': [
        ('top', *top(50)), ('red', *look((-29.5, F + 1, -0.5), (0, F + 3, 0))), ('atrium', *look((-14, F + 1, -6), (4, F + 4, 3))),
        ('mezzanine', *look((-20, F + 5, -16), (6, F + 3, 2))), ('corridor', *look((-22, F + 1, 12), (0, F + 2, 12))),
        ('arcade', *look((-13, F + 5, -17), (-22, F + 5.5, -20))), ('bowling', *look((-13, F + 5, 18), (-23, F + 5, 18))),
        ('store', *look((-26, F + 1, 2), (-30, F + 1.5, -6))),
    ],
    'scrap': [
        ('top', *top(48)), ('red', *look((-27.5, E, -0.5), (0, F + 3, 0))), ('gantry', *look((-14, E, 6), (2, F + 5, -1))),
        ('tyres', *look((-24, E, -13), (-12, F + 3, -17))), ('office', *look((-25, F + 5, -15), (4, F + 2, -10))),
        ('stacks', *look((-23, E, 13), (-4, F + 2, 17))), ('crusher', *look((-22, E, -2), (-12, F + 2, -5))),
    ],
    'villa': [
        ('top', *top(60)), ('red', *look((-40.5, E, -2.5), (0, F + 3, 0))), ('front', *look((-30, F + 7, 3), (-8, F + 3, 0))),
        ('pool', *look((-14, F + 6, -12), (-28, F + 1, -24))), ('court', *look((14, F + 6, 12), (28, F + 1, 24))), ('atrium', *look((-5.5, E, 3.5), (4, F + 2, -3))),
    ],
    'yacht': [
        ('top', *top(60)), ('red', *look((-41.5, E, 0.5), (0, F + 3, 0))), ('side', *look((-6, F + 6, -26), (2, F + 4, 0))),
        ('stern', *look((22, F + 6.6, 5), (32, F + 4, 0))), ('salon', *look((-10.5, F + 4, 2), (2, F + 5, -2))), ('lower', *look((-29.5, F + 1, -0.5), (0, F + 2.5, 0))),
    ],
    'town': [
        ('top', *top(62)), ('red', *look((-37.5, E, -0.5), (0, F + 3, 0))), ('gas', *look((-14, F + 3, -9), (0, F + 2, 0))),
        ('market', *look((-2, F + 3, -12), (-16, F + 2, -20))), ('tower', *look((-22.5, F + 7, -28.6), (-8, F + 1, -6))), ('alley', *look((-14, F + 1, 13), (-14, F + 2, 31))),
    ],
    'station': [
        ('top', *top(64)), ('red', *look((-39.5, E, -0.5), (0, F + 3, 0))), ('platform', *look((-10, F + 2, 14), (-6, F + 3, -20))),
        ('crossing', *look((-0.5, F + 1, 6), (0, F + 2, -20))), ('train', *look((-3.5, F + 2, -18), (-3.5, F + 3, -5))), ('hall', *look((-19, F + 1, -11), (-28, F + 5, 6))),
    ],
}

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal'])
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
        if only and name not in only:
            continue
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
