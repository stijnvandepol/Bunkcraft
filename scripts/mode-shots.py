"""
Screenshots of the objective modes through the dev build and the arcade preview (window.game.arcadePreview):
hardpoint and domination zones, capture the flag (flags, carrier, HUD), elimination (round pips, intermission
banner, round end), the gun game ladder and the match end screen. Needs a Vite dev server without HMR or file
watching on the given port (see CLAUDE.md).

  python3 scripts/mode-shots.py <outdir> [port]
"""
import math
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


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    # The game is usable once it reached the title menu (start() finishes asynchronously).
    page.wait_for_function("!!(window.game && window.game.arcadePreview) && window.game.state === 'menu'", timeout=60000)
    time.sleep(1)

    # Hardpoint on Old Quarter: the live hill with its ring and marker, the score bar.
    start(page, 'hardpoint', 'quarter')
    page.evaluate("window.game.previewServer.demo()")
    z = page.evaluate("(async () => (await import('/src/modes/maps/index.ts')).getMap('quarter').zones[0])()")
    look_at(page, z['x'], z['y'], z['z'], 12, 5)
    settle(page, 8)
    page.screenshot(path=f'{out}/hardpoint.png')
    # The same hill seen from far away, through the buildings.
    page.evaluate("window.game.player.setPosition(-34, 66, -26); window.game.player.yaw = Math.atan2(-34, -26) ; window.game.player.pitch = 0")
    settle(page, 6)
    page.screenshot(path=f'{out}/hardpoint-through-walls.png')

    # Domination on Harbor Yard: three points with owners, one contested, one being captured.
    start(page, 'domination', 'dockyard')
    page.evaluate("window.game.previewServer.demo()")
    page.evaluate("window.game.player.setPosition(0.5, 65, -14); window.game.player.yaw = Math.PI; window.game.player.pitch = -0.05")
    settle(page, 8)
    page.screenshot(path=f'{out}/domination.png')

    # Capture the flag on Bunker Flag: our flag carried by a bot, theirs dropped, flag status lines.
    start(page, 'ctf', 'bunker')
    page.evaluate("window.game.previewServer.demo()")
    f = page.evaluate("(async () => (await import('/src/modes/maps/index.ts')).getMap('bunker').flags.find((f) => f.team === 'blue'))()")
    page.evaluate(f"window.game.player.setPosition({f['x'] - 14}, 70, {f['z'] + 9}); window.game.player.flying = true; window.game.player.yaw = Math.atan2(-14, 9) ; window.game.player.pitch = -0.3")
    settle(page, 8)
    page.screenshot(path=f'{out}/ctf.png')
    page.evaluate("window.game.previewServer.event('flag-captured', 'red', 1, 'You'); window.game.previewServer.setScores(2, 2)")
    settle(page, 3)
    page.screenshot(path=f'{out}/ctf-capture.png')

    # Team elimination: round pips and survivors, the intermission banner, then a round end.
    start(page, 'elimination', 'quarter')
    page.evaluate("window.game.previewServer.demo(); window.game.previewServer.setPhase('intermission', 4, 'Round 4 · first to 4')")
    settle(page, 4)
    page.screenshot(path=f'{out}/elimination-intermission.png')
    page.evaluate("window.game.previewServer.setPhase('live', 71, 'Round 4 · first to 4'); window.game.previewServer.killSelf(10)")
    settle(page, 6)
    page.screenshot(path=f'{out}/elimination-spectate.png')
    page.evaluate("window.game.previewServer.event('round-win', 'red'); window.game.previewServer.setPhase('roundend', 4, 'Round 4 · first to 4')")
    settle(page, 2)
    page.screenshot(path=f'{out}/elimination-roundend.png')
    page.evaluate("window.game.previewServer.fillScores(); window.game.previewServer.endMatch('red')")
    settle(page, 3)
    page.screenshot(path=f'{out}/elimination-matchend.png')

    # Gun game: the ladder widget, then the scoreboard with levels.
    start(page, 'gungame', 'classic')
    page.evaluate("window.game.previewServer.demo()")
    settle(page, 5)
    page.screenshot(path=f'{out}/gungame-ladder.png')
    page.evaluate("window.game.input.down.add(window.game.input.bound(24))")
    settle(page, 3)
    page.screenshot(path=f'{out}/gungame-scoreboard.png')

    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
