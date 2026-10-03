"""
Shared helpers for the arcade QA scripts (Python Playwright against a Vite dev server).

Start the servers first (see docs/qa/ARCADE.md):
  PORT=3417 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts
  QA_SERVER_PORT=3417 npx vite --config scripts/qa/vite.qa.config.mjs --port 5417
"""
import json
import os
import time
import urllib.request

VITE = os.environ.get('QA_VITE', 'http://localhost:5417')
SHOTS = os.environ.get('QA_SHOTS', 'docs/qa/shots/arcade')
ARGS = ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required']
MAPS = ['classic', 'suburb', 'quarter', 'dockyard', 'desert']


def launch(p, headless=True):
    return p.chromium.launch(headless=headless, args=ARGS)


def open_game(browser, w=1280, h=720, logs=None):
    page = browser.new_page(viewport={'width': w, 'height': h})
    if logs is not None:
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(VITE + '/')
    # The game starts in state "menu" before start() has run; start() enters the menu (and would
    # throw away anything started earlier), so wait for the menu world.
    page.wait_for_function('() => window.game && window.game.state === "menu" && !!window.game.world', timeout=60000)
    time.sleep(1.0)
    return page


def gpu(page):
    return page.evaluate("""() => {
      const c = document.createElement('canvas').getContext('webgl2');
      const e = c && c.getExtension('WEBGL_debug_renderer_info');
      return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
    }""")


def wait_playing(page, timeout=90):
    page.wait_for_function('() => window.game.state !== "loading" && window.game.state !== "menu"', timeout=timeout * 1000)
    page.evaluate('() => { const g = window.game; g.input.locked = true; g.state = "playing"; }')


def force_playing(page):
    page.evaluate('() => { const g = window.game; g.input.locked = true; if (g.state === "paused") g.state = "playing"; }')


def start_preview(page, mode='tdm', map_id='classic', calm=True):
    page.evaluate(f'() => window.game.arcadePreview("{mode}", "You", "{map_id}")')
    wait_playing(page)
    if calm:
        page.evaluate('() => { window.game.previewServer.botsAggressive = false; }')
    time.sleep(1.0)
    force_playing(page)


def create_room(game_type='tdm', map_id='classic', score=30, time_limit=600, name='QA arena'):
    body = json.dumps({'name': name, 'gameMode': 'creative', 'seed': 'qa', 'gameType': game_type,
                       'scoreLimit': score, 'timeLimitSec': time_limit, 'mapId': map_id}).encode()
    req = urllib.request.Request(VITE + '/api/rooms', data=body, headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['code']


# Captures every server message the game receives into window.__qa.msgs (with a timestamp), and
# exposes simple helpers. Install after the game joined (game.net exists).
HOOK = """
() => {
  const g = window.game;
  if (window.__qa) return;
  const qa = window.__qa = { msgs: [], keep: new Set(['hit','damaged','kill','shot','spawn','hp','ammo','match','matchend','teleport','welcome']) };
  const orig = g.onServerMessage.bind(g);
  g.onServerMessage = (m) => {
    if (qa.keep.has(m.t)) qa.msgs.push({ ...m, at: performance.now() });
    return orig(m);
  };
}
"""


def install_hook(page):
    page.evaluate(HOOK)


def join_room(page, code, name):
    page.evaluate(f'() => window.game.joinServer("{name}", "", "{code}")')
    wait_playing(page)
    install_hook(page)


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    path = os.path.join(SHOTS, name)
    page.screenshot(path=path)
    return path
