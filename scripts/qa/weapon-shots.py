"""
Arcade weapon screenshots in the dev preview (no server): hip and aimed views per optic, the scope
overlay (with breath held), every weapon model, and the Create-a-Class menu.
Output: docs/screenshots/arcade/<name>.png

  QA_SERVER_PORT=3488 npx vite --config scripts/qa/vite.qa.config.mjs --port 5488
  QA_VITE=http://localhost:5488 python3 scripts/qa/weapon-shots.py [map=classic]
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

os.environ.setdefault('QA_SHOTS', 'docs/screenshots/arcade')
q.SHOTS = os.environ['QA_SHOTS']
map_id = sys.argv[1] if len(sys.argv) > 1 else 'classic'


def equip(page, primary, optic='iron', secondary='pistol', perk='none'):
    page.evaluate(f"""() => game.arcade.chooseClass({{ primary: '{primary}', optic: '{optic}', secondary: '{secondary}', perk: '{perk}' }}, false)""")
    time.sleep(0.6)


def aim(page, on, hold_breath=False):
    if on:
        page.evaluate("() => game.input.down.add('Mouse2')")
    else:
        page.evaluate("() => game.input.down.delete('Mouse2')")
    if hold_breath:
        page.evaluate("() => game.input.down.add('ShiftLeft')")
    else:
        page.evaluate("() => game.input.down.delete('ShiftLeft')")
    time.sleep(0.9)


def look(page, yaw, pitch=0.0):
    page.evaluate(f'() => {{ game.player.yaw = {yaw}; game.player.pitch = {pitch}; }}')


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'tdm', map_id)
    time.sleep(4)
    q.force_playing(page)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    print('gpu', q.gpu(page))
    yaw = page.evaluate('() => game.player.yaw')

    for primary, optic in [('rifle', 'reddot'), ('rifle', 'holo'), ('smg', 'iron'), ('lmg', 'holo'), ('dmr', 'iron')]:
        equip(page, primary, optic)
        look(page, yaw)
        aim(page, False)
        q.shot(page, f'{primary}-{optic}-hip.png')
        aim(page, True)
        q.shot(page, f'{primary}-{optic}-ads.png')
        aim(page, False)

    for primary in ['sniper', 'semisniper', 'dmr']:
        equip(page, primary, 'scope')
        look(page, yaw)
        aim(page, True)
        time.sleep(0.6)
        q.shot(page, f'{primary}-scope.png')
        aim(page, True, hold_breath=True)
        time.sleep(1.2)
        q.shot(page, f'{primary}-scope-breath.png')
        aim(page, False)

    # Hip view of every weapon (secondaries through slot 2).
    for primary in ['shotgun', 'burst', 'semisniper', 'sniper']:
        equip(page, primary, 'scope' if 'sniper' in primary else 'iron', 'mpistol', 'suppressor' if primary == 'burst' else 'none')
        look(page, yaw)
        q.shot(page, f'model-{primary}.png')
    for slot, sec in [('Digit2', 'mpistol'), ('Digit2', 'revolver')]:
        equip(page, 'rifle', 'iron', sec)
        page.evaluate(f"() => game.input.pressed.add('{slot}')")
        time.sleep(0.8)
        q.shot(page, f'model-{sec}.png')
        page.evaluate("() => game.input.pressed.add('Digit1')")
        time.sleep(0.4)

    # Create-a-Class menu.
    page.evaluate('() => game.arcade.openLoadout()')
    time.sleep(0.6)
    q.shot(page, 'class-menu.png')
    page.evaluate('() => { game.arcade.closeLoadout(); game.stack.clear(); }')

    print('\n'.join(logs[:20]) or 'no console errors')
    b.close()
