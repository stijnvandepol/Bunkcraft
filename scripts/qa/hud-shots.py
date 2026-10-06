"""
QA: HUD screenshots per arcade mode in the dev preview (no server): playing with a filled kill feed
and a damage indicator, the Tab scoreboard, the death screen and the match end screen.
Output: docs/qa/shots/arcade/hud-<mode>-<state>.png

  python3 scripts/qa/hud-shots.py [map=atomic] [mode,mode ...]
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

map_id = sys.argv[1] if len(sys.argv) > 1 else 'atomic'
modes = sys.argv[2].split(',') if len(sys.argv) > 2 else ['tdm', 'ffa', 'gungame', 'elimination', 'hardpoint', 'domination', 'ctf']

with sync_playwright() as pw:
    b = q.launch(pw)
    for mode in modes:
        logs = []
        page = q.open_game(b, logs=logs)
        q.start_preview(page, mode, map_id)
        time.sleep(5)  # warm-up of the preview
        q.force_playing(page)
        page.evaluate("""() => { const s = game.previewServer; s.fillScores?.(); s.botKill?.(); s.botKill?.(); s.killBot?.(1); s.damage?.(25, 2); }""")
        time.sleep(0.4)
        q.shot(page, f'hud-{mode}-play.png')
        page.evaluate("() => game.input.down.add('Tab')")
        time.sleep(0.4)
        q.shot(page, f'hud-{mode}-board.png')
        page.evaluate("() => game.input.down.delete('Tab')")
        page.evaluate('() => game.previewServer.killSelf?.(0, true)')
        time.sleep(1.5)
        q.shot(page, f'hud-{mode}-dead.png')
        time.sleep(3)
        page.evaluate("() => game.previewServer.endMatch?.('red')")
        time.sleep(0.8)
        q.shot(page, f'hud-{mode}-end.png')
        print(mode, 'errors:', [l for l in logs if 'error' in l][:5])
        page.close()
    b.close()
