"""Smoke test of the QA harness: title screen → Singleplayer → Create New World (survival) → in game.

  python3 scripts/qa/smoke.py [port] [profile_dir]
"""
import sys
import time

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from qa_lib import QA  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5231
profile = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bunkcraft-qa-smoke'
qa = QA(port, 'docs/qa', profile)
qa.open()
page = qa.page
qa.wait(2)
page.get_by_role('button', name='Singleplayer').click()
qa.wait(0.5)
page.get_by_role('button', name='Create New World').click()
qa.wait(0.3)
print(page.locator('.mc-btn', has_text='Game Mode').inner_text())
t0 = time.time()
page.locator('.mc-btn', has_text='Create New World').last.click()
for _ in range(300):
    qa.page.bring_to_front()
    if qa.js('game.state') not in ('loading', 'menu'):
        break
    time.sleep(0.2)
print('loaded in', round(time.time() - t0, 1), 's; state', qa.js('game.state'))
qa.relock()
qa.wait(2)
print(qa.st())
qa.key('F3')
qa.wait(0.6)
qa.shot('smoke')
print(qa.console[:10])
qa.close()
