"""
Screenshots of the content (creative tabs, a build with the new blocks, armor HUD, chest) through the dev
build. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/content-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5199'

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=30000)
    page.evaluate("window.game.createWorld('shots', '4242', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") == 'playing' or page.evaluate("window.game.state") == 'paused':
            break
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    time.sleep(1)
    page.evaluate("window.game.state = 'inventory'; window.game.inventory.open()")
    time.sleep(0.5)
    n_tabs = page.evaluate("document.querySelectorAll('.inv-tab').length")
    print('tabs', n_tabs)
    for i in range(n_tabs):
        page.evaluate(f"document.querySelectorAll('.inv-tab')[{i}].click()")
        time.sleep(0.3)
        page.screenshot(path=f'{out}/tab{i}.png')
        # Also the scrolled-down view of long tabs.
        page.evaluate("document.querySelector('.inventory').dispatchEvent(new WheelEvent('wheel', {deltaY: 100}))")
        for _ in range(8):
            page.evaluate("document.querySelector('.inventory').dispatchEvent(new WheelEvent('wheel', {deltaY: 100}))")
        time.sleep(0.2)
        page.screenshot(path=f'{out}/tab{i}_scrolled.png')
    print('errors:', [l for l in logs if 'DevTools' not in l][:10])
    browser.close()
