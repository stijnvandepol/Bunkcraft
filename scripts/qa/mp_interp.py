"""
Multiplayer QA: how smoothly does a browser draw a walking friend? A protocol bot (walker-bot.ts) walks at a
constant 4.317 blocks/s with 20 Hz updates; the browser samples the remote player's drawn position every frame.

  python3 scripts/qa/mp_interp.py [http://localhost:5191] [http://localhost:3471]
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

VITE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5191'
SERVER = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:3471'
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

req = urllib.request.Request(f'{SERVER}/api/rooms', data=json.dumps({'name': 'Interp', 'gameMode': 'creative', 'seed': 'interp'}).encode(),
                             headers={'content-type': 'application/json'}, method='POST')
code = json.loads(urllib.request.urlopen(req).read())['code']
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--use-angle=metal'])
    page = browser.new_page(viewport={'width': 960, 'height': 600})
    page.goto(f'{VITE}/?join={code}')
    page.wait_for_function('() => window.game && document.querySelector(".mc-btn")', timeout=30000)
    page.get_by_placeholder('Your name (3–16 letters)').fill('Watcher')
    page.get_by_role('button', name='Join Game', exact=True).click()
    page.wait_for_function("() => ['playing', 'paused'].includes(game.state)", timeout=60000)
    page.evaluate("() => { game.input.locked = true; game.state = 'playing'; }")
    bot = subprocess.Popen(['npx', 'tsx', 'scripts/qa/walker-bot.ts', SERVER, code, '14'], cwd=REPO)
    page.wait_for_function("() => game.remote.list.some(r => r.name === 'Walker')", timeout=15000)
    time.sleep(2)
    samples = page.evaluate('''() => new Promise((res) => { const out = []; const t0 = performance.now();
      const r = game.remote.list.find(r => r.name === 'Walker');
      const tick = () => { out.push([performance.now(), r.mob.x]); if (performance.now() - t0 < 8000) requestAnimationFrame(tick); else res(out); };
      requestAnimationFrame(tick); })''')
    fps = len(samples) / 8
    speeds = [abs(x2 - x1) / ((t2 - t1) / 1000) for (t1, x1), (t2, x2) in zip(samples, samples[1:]) if t2 > t1]
    # Ignore the frames around the turn-arounds (speed passes through 0 there).
    walking = [s for s in speeds if s > 1.0]
    stalls = sum(1 for s in speeds if s < 0.05)
    mean = sum(walking) / max(1, len(walking))
    sd = (sum((s - mean) ** 2 for s in walking) / max(1, len(walking))) ** 0.5
    big = sum(1 for s in walking if abs(s - 4.317) > 1.5)
    print(f'browser {fps:.0f} fps; drawn speed mean {mean:.2f} b/s (true 4.317), stdev {sd:.2f} ({sd / max(mean, 1e-9) * 100:.0f} %), '
          f'{stalls} frames standing still, {big} frames off by > 1.5 b/s, of {len(speeds)}')
    # Where does it come from? The snapshot buffer: arrival-time gaps and steps between consecutive snapshots.
    buf = page.evaluate("() => game.remote.list.find(r => r.name === 'Walker').buffer.map(s => [s.t, s.x])")
    gaps = [round((b[0] - a[0]) * 1000) for a, b in zip(buf, buf[1:])]
    steps = [round(abs(b[1] - a[1]), 3) for a, b in zip(buf, buf[1:])]
    print(f'last {len(buf)} snapshots: arrival gaps ms {gaps}')
    print(f'position steps (expected ~0.216 per 50 ms): {steps}')
    bot.wait()
    browser.close()
