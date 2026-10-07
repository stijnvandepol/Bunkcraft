"""
Screenshots of the menu shell (docs/research/IDENTITY.md): the home screen, the arena menus, settings, the
in-arena lobby and the match end, in Chromium (real GPU through Metal on macOS) and WebKit.

Needs a game server and the dev build served by Vite without HMR/watching, on their own ports, e.g.:

    PORT=3297 DATA_DIR=/tmp/bunk-shots ROOM_CREATE_LIMIT=1000 MAX_CONN_PER_IP=1000 npx tsx server/index.ts
    E2E_GAME_PORT=3297 E2E_VITE_PORT=5297 npx vite --config tests/e2e/vite.e2e.config.ts --host 127.0.0.1

Restart Vite after code changes (watching is off). Then:

    python3 scripts/identity-shots.py [--port 5297] [--out docs/screenshots/identity] [--browsers chromium,webkit] [--only home,lobby]
"""
import argparse
import os
import sys
import time

from playwright.sync_api import sync_playwright

PROFILE_REPORT = {
    'lines': [{'key': 'kills', 'xp': 900, 'count': 9}, {'key': 'headshots', 'xp': 150, 'count': 3},
              {'key': 'win', 'xp': 500}, {'key': 'completion', 'xp': 200}],
    'xp': 1750,
    'before': {'xp': 300, 'level': 1, 'prestige': 0},
    'after': {'xp': 2050, 'level': 3, 'prestige': 0},
    'unlocks': [], 'camos': [], 'challenges': [], 'weaponLevels': [],
}


def settle(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        page.bring_to_front()
        page.wait_for_timeout(200)


def wait_home(page):
    page.wait_for_function("() => window.game && window.game.state === 'menu' && document.querySelector('.home')", timeout=90000)


def click(page, text):
    """Clicks the first visible enabled button of the top screen whose text starts with `text`."""
    ok = page.evaluate("""(text) => {
      const screens = [...document.querySelectorAll('#screens > .screen:not(.hidden)')];
      const top = screens[screens.length - 1];
      if (!top) return false;
      const b = [...top.querySelectorAll('button')].find((x) => !x.disabled && x.offsetParent && x.textContent.trim().toLowerCase().startsWith(text.toLowerCase()));
      if (!b) return false;
      b.click();
      return true;
    }""", text)
    if not ok:
        raise RuntimeError(f'no button "{text}"')
    page.wait_for_timeout(250)


def back(page):
    page.evaluate("() => window.game.stack.pop()")
    page.wait_for_timeout(200)


def run(browser_name, pw, args):
    os.makedirs(args.out, exist_ok=True)
    launch = {'args': ['--use-angle=metal']} if browser_name == 'chromium' and sys.platform == 'darwin' else {}
    browser = getattr(pw, browser_name).launch(**launch)
    only = set(args.only.split(',')) if args.only else None
    base = f'http://127.0.0.1:{args.port}'

    def want(name):
        return only is None or name in only

    def shot(page, name):
        path = os.path.join(args.out, f'{name}-{browser_name}.jpg')
        page.screenshot(path=path, type='jpeg', quality=82)
        print('  ', path)

    ctx = browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
    page = ctx.new_page()
    page.on('pageerror', lambda e: print('PAGE ERROR', e))
    page.goto(f'{base}/?menuMap=atomic')
    wait_home(page)
    settle(page, 3.5)
    if want('home-guest'):
        shot(page, 'home-guest')

    # Name prompt from the profile card, then the home screen with a profile.
    page.locator('.home-profile').click()
    page.wait_for_timeout(300)
    if want('name'):
        shot(page, 'name')
    page.locator('input.mc-input:visible').first.fill('Stijn_vdP')
    page.keyboard.press('Enter')
    page.wait_for_function("() => document.querySelector('.home-profile .rank-badge')", timeout=15000)
    settle(page, 1.5)
    if want('home'):
        shot(page, 'home')

    if want('lobbies'):
        click(page, 'Lobbies')
        settle(page, 0.8)
        shot(page, 'lobbies')
        back(page)
    if want('private') or want('created'):
        click(page, 'Private match')
        settle(page, 0.4)
        if want('private'):
            shot(page, 'private')
        click(page, 'Create')
        page.wait_for_selector('.realms-code', timeout=10000)
        settle(page, 0.4)
        if want('created'):
            shot(page, 'created')
        back(page)
    for name, label in [('loadouts', 'Loadouts'), ('armory', 'Armory'), ('stats', 'Stats')]:
        if want(name):
            click(page, label)
            settle(page, 0.4)
            shot(page, name)
            back(page)
    if want('challenges'):
        click(page, 'All challenges')
        settle(page, 0.4)
        shot(page, 'challenges')
        back(page)
    if want('profile'):
        page.locator('.home-profile').click()
        settle(page, 0.4)
        shot(page, 'profile')
        back(page)
    if want('settings') or want('settings-video'):
        page.locator('.home-util button[aria-label="Settings"]').click()
        settle(page, 0.4)
        if want('settings'):
            shot(page, 'settings')
        click(page, 'Video Settings')
        settle(page, 0.4)
        if want('settings-video'):
            shot(page, 'settings-video')
        back(page)
        back(page)
    if want('build'):
        page.locator('.home-build').click()
        settle(page, 0.4)
        shot(page, 'build')
        back(page)
    if want('home-nl'):
        page.evaluate("() => { window.game.settings.set('language', 'nl'); window.game.menu.showTitle(); }")
        settle(page, 1.2)
        shot(page, 'home-nl')
        page.evaluate("() => { window.game.settings.set('language', 'en'); window.game.menu.showTitle(); }")
        settle(page, 0.5)
    if want('focus'):
        page.keyboard.press('ArrowDown')
        page.keyboard.press('ArrowRight')
        settle(page, 0.3)
        shot(page, 'focus')

    for size, name in [((1920, 1080), 'home-1080'), ((800, 600), 'home-800'), ((390, 844), 'home-phone')]:
        if want(name):
            page.set_viewport_size({'width': size[0], 'height': size[1]})
            page.evaluate("() => window.dispatchEvent(new Event('resize'))")
            settle(page, 1.2)
            shot(page, name)
    page.set_viewport_size({'width': 1280, 'height': 720})
    page.evaluate("() => window.dispatchEvent(new Event('resize'))")

    # In the arena: quick play (alone: the warm-up lobby waits for a second player), then a staged match end.
    if want('lobby') or want('match-end') or want('pause') or want('loading'):
        page.evaluate("() => window.game.menu.showTitle()")
        page.wait_for_timeout(300)
        page.locator('.mode-card[data-mode="tdm"]').click()
        page.locator('.bc-play').click()
        if want('loading'):
            try:
                page.wait_for_selector('.loading.bc', timeout=5000)
                shot(page, 'loading')
            except Exception:
                pass
        page.wait_for_function("() => window.game.state !== 'menu' && window.game.state !== 'loading' && window.game.arcade", timeout=90000)
        page.evaluate("() => { const g = window.game; g.input.locked = true; g.state = 'playing'; document.querySelector('.click-to-play')?.remove(); }")
        settle(page, 3)
        if want('lobby'):
            shot(page, 'lobby')
        if want('pause'):
            page.evaluate("() => window.game.pause()")
            settle(page, 0.5)
            shot(page, 'pause')
            page.evaluate("() => { const g = window.game; g.stack.clear(); g.input.locked = true; g.state = 'playing'; }")
    # The match end on the dev preview server (a real lobby would have to be played to the end).
    if want('match-end'):
        page.evaluate("() => window.game.quitToTitle()")
        wait_home(page)
        page.evaluate("() => window.game.arcadePreview('tdm', 'Stijn_vdP', 'atomic')")
        page.wait_for_function("() => { const g = window.game; return g.state !== 'loading' && g.state !== 'menu' && !!g.previewServer; }", timeout=90000)
        page.evaluate("() => { const g = window.game; g.input.locked = true; g.state = 'playing'; g.previewServer.botsAggressive = false; }")
        settle(page, 2)
        page.evaluate("""(report) => {
          const g = window.game;
          g.previewServer.endMatch('red');
          document.querySelector('.click-to-play')?.remove();
          g.onServerMessage({ t: 'progress', report });
          g.onServerMessage({ t: 'vote', options: ['atomic', 'villa', 'dockyard'], counts: [2, 1, 0], mine: 0, endsIn: 12 });
        }""", PROFILE_REPORT)
        settle(page, 1.5)
        shot(page, 'match-end')
    ctx.close()
    browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5297)
    ap.add_argument('--out', default='docs/screenshots/identity')
    ap.add_argument('--browsers', default='chromium,webkit')
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    with sync_playwright() as pw:
        for b in args.browsers.split(','):
            print(b)
            run(b, pw, args)


if __name__ == '__main__':
    main()
