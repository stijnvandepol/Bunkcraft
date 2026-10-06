"""
QA repro: the match ends while you are dead (the final kill of the match killed you). Takes a
screenshot of the end screen: docs/qa/shots/arcade/repro-death-then-end.png, and prints whether the
death screen is still shown under it.

  python3 scripts/qa/repro-death-end.py [mode=tdm] [map=atomic]
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else 'tdm'
map_id = sys.argv[2] if len(sys.argv) > 2 else 'atomic'
with sync_playwright() as pw:
    b = q.launch(pw)
    page = q.open_game(b)
    q.start_preview(page, mode, map_id)
    time.sleep(5)
    page.evaluate('() => game.previewServer.killSelf(0, false)')
    time.sleep(0.5)
    page.evaluate("() => game.previewServer.endMatch('blue')")
    time.sleep(0.8)
    q.shot(page, f'repro-death-then-end-{mode}.png')
    vis = page.evaluate("""() => [...document.querySelectorAll('div')].filter((d) => /eliminated by/i.test(d.textContent) && d.children.length < 3 && d.offsetParent !== null).map((d) => d.textContent.slice(0, 60))""")
    print('death screen still visible under the end screen:', bool(vis), vis[:2])
    b.close()
