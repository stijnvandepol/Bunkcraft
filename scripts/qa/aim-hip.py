"""
Hip-fire crosshair and aim transition check in the dev preview (no server): the crosshair styles and colours at rest and
while running or jumping (it opens with the spread), its fade while the sights come up, and the sights while firing.

  QA_SERVER_PORT=3799 npx vite --config scripts/qa/vite.qa.config.mjs --port 5731
  QA_VITE=http://localhost:5731 python3 scripts/qa/aim-hip.py <out-dir> [prefix=aim]

Output: <out-dir>/<prefix>-hip-*.png (centre crops are the interesting part) and the crosshair gap in pixels per state.
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else 'docs/screenshots/arcade'
prefix = sys.argv[2] if len(sys.argv) > 2 else 'aim'
q.SHOTS = out_dir


def equip(page, wid, optic='iron', slot=0):
    pri, sec = (wid, 'pistol') if slot == 0 else ('rifle', wid)
    page.evaluate(f"() => {{ game.arcade.applyGear('{pri}', '{sec}', '{optic}', 'none'); game.arcade.equipSlot({slot}, false); }}")
    time.sleep(0.7)


def gap(page):
    return page.evaluate("() => game.arcade.hud.crosshair.style.getPropertyValue('--g') + ' / opacity ' + (game.arcade.hud.crosshair.style.opacity || '1')")


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'tdm', 'classic')
    time.sleep(3)
    q.force_playing(page)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    yaw = page.evaluate('() => game.player.yaw')
    page.evaluate(f'() => {{ game.player.yaw = {yaw}; game.player.pitch = 0; }}')
    equip(page, 'smg')

    def set_style(style, color='white', size=100, dyn=True):
        page.evaluate(f"() => {{ const s = game.settings; s.set('crosshairStyle', '{style}'); s.set('crosshairColor', '{color}'); s.set('crosshairSize', {size}); s.set('crosshairDynamic', {str(dyn).lower()}); }}")
        time.sleep(0.4)

    for style, color in [('cross', 'white'), ('dot', 'green'), ('circle', 'cyan')]:
        set_style(style, color)
        q.shot(page, f'{prefix}-hip-{style}-still.png')
        print(style, 'still', gap(page))
        page.evaluate("() => game.input.down.add('KeyW')")
        time.sleep(0.7)
        q.shot(page, f'{prefix}-hip-{style}-run.png')
        print(style, 'running', gap(page))
        page.evaluate("() => game.input.down.delete('KeyW')")
        page.evaluate(f'() => {{ game.player.yaw = {yaw}; game.player.pitch = 0; }}')
        time.sleep(0.5)

    # Size and colour variants.
    set_style('cross', 'yellow', 160)
    q.shot(page, f'{prefix}-hip-cross-big-yellow.png')
    set_style('circle', 'pink', 60, False)
    q.shot(page, f'{prefix}-hip-circle-small-static.png')
    set_style('cross', 'white', 100)

    # Opening up: sample the crosshair fade while the sights come up and go down.
    equip(page, 'rifle', 'reddot')
    page.evaluate("() => game.input.down.add('Mouse2')")
    rows = []
    for _ in range(8):
        time.sleep(0.04)
        rows.append(page.evaluate("() => [game.arcade.ads.toFixed(2), game.arcade.adsEased.toFixed(2), game.arcade.hud.crosshair.style.opacity || '1']"))
    print('ads in  (linear, eased, crosshair opacity):', rows)
    time.sleep(0.6)
    page.evaluate("() => game.input.down.delete('Mouse2')")
    rows = []
    for _ in range(6):
        time.sleep(0.04)
        rows.append(page.evaluate("() => [game.arcade.ads.toFixed(2), game.arcade.adsEased.toFixed(2), game.arcade.hud.crosshair.style.opacity || '1']"))
    print('ads out (linear, eased, crosshair opacity):', rows)

    # Firing while aimed: the sight must stay on the centre while the weapon kicks.
    for wid, optic in [('rifle', 'reddot'), ('rifle', 'iron'), ('dmr', 'holo'), ('lmg', 'iron')]:
        equip(page, wid, optic)
        page.evaluate(f'() => {{ game.player.yaw = {yaw}; game.player.pitch = 0; }}')
        page.evaluate("() => game.input.down.add('Mouse2')")
        time.sleep(1.0)
        page.evaluate("() => { game.arcade.ammo.forEach((a) => { a.mag = 60; }); game.input.down.add('Mouse0'); }")
        time.sleep(0.35)
        q.shot(page, f'{prefix}-hip-fire-{wid}-{optic}.png')
        page.evaluate("() => { game.input.down.delete('Mouse0'); game.input.down.delete('Mouse2'); }")
        time.sleep(0.8)

    print('\n'.join(logs[:20]) or 'no console errors')
    b.close()
