"""
Screenshots of the newer arcade modes through the dev build and the arcade preview (window.game.arcadePreview):
kill confirmed (tags and markers), search and destroy (plant progress, the planted bomb), infected (survivor
and infected view), sharpshooter (the shared weapon panel), king of the hill (the hill you hold) and the Realms
hub with every mode card. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/mode-shots-extra.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5291'


def settle(page, n=10, dt=0.3):
    for _ in range(n):
        page.bring_to_front()
        time.sleep(dt)


def start(page, mode, map_id):
    page.evaluate(f"window.game.arcadePreview('{mode}', 'You', '{map_id}')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    page.evaluate("window.game.previewServer.botsAggressive = false")
    settle(page, 12)


def look_at(page, x, y, z, back=9.0, height=4.0):
    """Stand `back` blocks from (x, z) towards the map centre side and face the point."""
    page.evaluate(f"""() => {{
      const g = window.game, p = g.player;
      const tx = {x}, ty = {y}, tz = {z};
      const ang = Math.atan2(tx === 0 ? 1 : -tx, -tz || 1);
      const px = tx + Math.sin(ang) * {back}, pz = tz + Math.cos(ang) * {back};
      p.setPosition(px, ty + {height}, pz);
      p.flying = true;
      p.yaw = Math.atan2(px - tx, pz - tz);
      p.pitch = -Math.atan2({height} - 0.5, {back});
    }}""")


def site(page, map_id, i):
    return page.evaluate(f"(async () => (await import('/src/modes/maps/index.ts')).getMap('{map_id}').sites[{i}])()")


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function("!!(window.game && window.game.arcadePreview) && window.game.state === 'menu'", timeout=60000)
    time.sleep(1)

    # The home screen (the arena hub): every mode card with its icon.
    page.evaluate("localStorage.setItem('bunkcraft.name', 'Stijn'); window.game.menu.showTitle()")
    settle(page, 8)
    page.screenshot(path=f'{out}/realms-hub.png')
    # The new modes sit at the end of the playlist.
    page.mouse.move(640, 350)
    for _ in range(12):
        page.mouse.wheel(0, 400)
    settle(page, 3)
    page.screenshot(path=f'{out}/realms-hub-new.png')
    page.keyboard.press('Escape')
    settle(page, 3)

    # Kill confirmed on Old Quarter: three tags in front of you (two to confirm, one to deny), markers, the count.
    start(page, 'killconfirmed', 'quarter')
    page.evaluate("""() => {
      const s = window.game.previewServer, p = window.game.player;
      s.demo();
      s.modeState({ kind: 'tags', tags: [
        { id: 1, x: p.x + 2, y: p.y, z: p.z - 6, team: 'blue' },
        { id: 2, x: p.x - 3, y: p.y, z: p.z - 9, team: 'blue' },
        { id: 3, x: p.x + 4, y: p.y, z: p.z - 12, team: 'red' },
      ] });
      p.yaw = 0; p.pitch = -0.25;
    }""")
    settle(page, 6)
    page.evaluate("window.game.previewServer.event('tag-confirmed', 'red', 1, 'You')")
    settle(page, 2)
    page.screenshot(path=f'{out}/killconfirmed.png')

    # Search and destroy on Old Quarter: you attack, site A is being planted; then the bomb is down.
    start(page, 'snd', 'quarter')
    page.evaluate("window.game.previewServer.demo(); window.game.previewServer.setPhase('live', 74, 'Round 5 · first to 4')")
    a = site(page, 'quarter', 0)
    look_at(page, a['x'], a['y'], a['z'], 10, 4)
    settle(page, 8)
    page.screenshot(path=f'{out}/snd-plant.png')
    page.evaluate("window.game.previewServer.plantBomb(21); window.game.previewServer.event('bomb-planted', 'red', 1, 'A')")
    # Standing on the site's edge (sites may be indoors), looking down at the bomb in its ring.
    page.evaluate(f"""() => {{ const p = window.game.player; p.flying = false; p.setPosition({a['x']}, {a['y']}, {a['z']} + 2.8); p.yaw = 0; p.pitch = -0.55; }}""")
    settle(page, 3)
    page.screenshot(path=f'{out}/snd-planted.png')

    # Infected on Old Quarter: the survivor view, then you turn (knife, red).
    start(page, 'infected', 'quarter')
    page.evaluate("window.game.previewServer.demo(); window.game.previewServer.setPhase('live', 154, '4 survivors left')")
    settle(page, 6)
    page.screenshot(path=f'{out}/infected-survivor.png')
    page.evaluate("window.game.previewServer.infectSelf(); window.game.previewServer.event('outbreak', 'red', 1, 'You')")
    settle(page, 4)
    page.screenshot(path=f'{out}/infected-infected.png')

    # Sharpshooter on Old Quarter: everybody has the sniper, the next swap counts down; the rotation banner.
    start(page, 'sharpshooter', 'quarter')
    page.evaluate("window.game.previewServer.demo(); window.game.previewServer.setPhase('live', 412, 'First to 30'); window.game.previewServer.event('weapon-rotate', '', 0, 'sniper')")
    settle(page, 4)
    page.screenshot(path=f'{out}/sharpshooter.png')

    # King of the hill on Old Quarter: you hold the hill alone (gold ring and marker, your points).
    start(page, 'koth', 'quarter')
    page.evaluate("window.game.previewServer.demo(); window.game.previewServer.setPhase('live', 388, 'Hill: Courtyard · first to 60')")
    z = page.evaluate("(async () => (await import('/src/modes/maps/index.ts')).getMap('quarter').zones[0])()")
    look_at(page, z['x'], z['y'], z['z'], 12, 5)
    settle(page, 8)
    page.screenshot(path=f'{out}/koth.png')

    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
