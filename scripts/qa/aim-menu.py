"""
Screenshots of the aim settings screens (Options > Controls > Mouse Settings and Crosshair) in the dev preview.

  QA_VITE=http://localhost:5731 python3 scripts/qa/aim-menu.py <out-dir> [prefix=aim]
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

q.SHOTS = sys.argv[1] if len(sys.argv) > 1 else 'docs/screenshots/arcade'
prefix = sys.argv[2] if len(sys.argv) > 2 else 'aim'


def click(page, label):
    # The main menu stays underneath the options screens: click the last visible button with that label.
    page.evaluate(
        "(l) => { const b = [...document.querySelectorAll('button')].filter((e) => e.textContent === l && e.offsetParent !== null).pop(); b.click(); }",
        label,
    )
    time.sleep(0.4)


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    page.evaluate('() => { game.input.locked = false; game.openOptions(); }')
    time.sleep(0.5)
    click(page, 'Controls...')
    click(page, 'Mouse Settings...')
    q.shot(page, f'{prefix}-menu-mouse.png')
    click(page, 'Done')
    click(page, 'Crosshair...')
    q.shot(page, f'{prefix}-menu-crosshair.png')
    print('\n'.join(logs[:20]) or 'no console errors')
    b.close()
