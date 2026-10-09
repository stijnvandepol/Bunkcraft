"""
Screenshots of the in-match banners and the other banner-like elements (docs/research/IDENTITY.md, "Bunkhosting-stijl"):
phase banners (round start, countdown, fight), medals, mode event banners, the death screen, the Tab scoreboard, the match
end (team win, free-for-all win, XP report with level-up and unlocks) and the system toasts. Uses the dev preview server of
the game (`game.arcadePreview`, no game server needed for these), in Chromium on the real GPU (Metal on macOS).

Needs the dev build served by Vite without HMR/watching on its own port, e.g.:

    E2E_GAME_PORT=3611 E2E_VITE_PORT=5611 npx vite --config tests/e2e/vite.e2e.config.ts --host 127.0.0.1

Restart Vite after code changes (watching is off). Then:

    python3 scripts/banner-shots.py [--port 5611] [--out docs/screenshots/bunkhosting/banners/after] [--only medal-double,death]
"""
import argparse
import os
import sys
import time

from playwright.sync_api import sync_playwright

REPORT = {
    'lines': [{'key': 'kills', 'xp': 900, 'count': 9}, {'key': 'headshots', 'xp': 150, 'count': 3},
              {'key': 'win', 'xp': 500}, {'key': 'completion', 'xp': 200}],
    'xp': 1750,
    'before': {'xp': 300, 'level': 1, 'prestige': 0},
    'after': {'xp': 2050, 'level': 3, 'prestige': 0},
    'unlocks': [{'kind': 'primary', 'id': 'smg', 'level': 3}],
    'camos': [], 'challenges': [], 'weaponLevels': [],
}


def settle(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        page.bring_to_front()
        page.wait_for_timeout(100)


def start_preview(page, mode, name='Stijn_vdP', map_id='atomic'):
    page.evaluate(f'() => window.game.arcadePreview("{mode}", "{name}", "{map_id}")')
    page.wait_for_function("() => { const g = window.game; return g.state !== 'loading' && g.state !== 'menu' && !!g.previewServer; }", timeout=90000)
    page.evaluate("() => { const g = window.game; g.input.locked = true; g.state = 'playing'; g.previewServer.botsAggressive = false; if (['tdm', 'ffa'].includes(g.previewServer.info.type)) g.previewServer.info.scoreLimit = 99; document.querySelector('.click-to-play')?.remove(); }")
    settle(page, 3)
    page.evaluate("() => { const g = window.game; if (g.state === 'paused') g.state = 'playing'; g.input.locked = true; }")


def stop(page):
    page.evaluate("() => window.game.quitToTitle()")
    page.wait_for_function("() => window.game.state === 'menu' && document.querySelector('.home')", timeout=90000)
    settle(page, 1)


def run(args):  # noqa: C901
    os.makedirs(args.out, exist_ok=True)
    only = set(args.only.split(',')) if args.only else None
    base = f'http://127.0.0.1:{args.port}'
    launch = {'args': ['--use-angle=metal']} if sys.platform == 'darwin' else {}

    def want(*names):
        return only is None or any(n in only for n in names)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**launch)
        ctx = browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda e: print('PAGE ERROR', e))
        page.goto(f'{base}/?menuMap=atomic')
        page.wait_for_function("() => window.game && window.game.state === 'menu' && document.querySelector('.home')", timeout=90000)
        settle(page, 2)
        if args.lang != 'en':
            ev0 = page.evaluate
            ev0("(l) => window.game.settings.set('language', l)", args.lang)
            settle(page, 0.5)

        def shot(name):
            path = os.path.join(args.out, f'{name}.jpg')
            page.screenshot(path=path, type='jpeg', quality=88)
            print('  ', path)

        ev = lambda js, *a: page.evaluate(js, *a)  # noqa: E731

        # ---- team deathmatch: phase banners, medals, event banners, death, board, team win -------------------------
        if want('phase-intermission', 'phase-countdown', 'phase-fight', 'medal-double', 'medal-streak', 'medal-radar',
                'event-flag-taken', 'event-flag-captured', 'event-zone-captured', 'event-zone-lost', 'event-bomb-planted',
                'event-bomb-defused', 'event-round-win', 'event-round-start', 'event-side-swap', 'death', 'board', 'end-team',
                'toast-notice'):
            start_preview(page, 'tdm')
            if want('phase-intermission'):
                ev("() => game.previewServer.setPhase('intermission', 5)"); settle(page, 0.5); shot('phase-intermission')
            if want('phase-countdown'):
                ev("() => game.previewServer.setPhase('countdown', 3)"); settle(page, 0.4); shot('phase-countdown')
            if want('phase-fight'):
                ev("() => game.previewServer.setPhase('countdown', 0)"); settle(page, 0.4); shot('phase-fight')
            ev("() => game.previewServer.setPhase('live', 300)"); settle(page, 0.6)

            def event(name, js):
                if want(name):
                    ev(js); settle(page, 0.35); shot(name)
                    settle(page, 3)

            ev("() => { game.previewServer.fillScores(); game.previewServer.setScores(3, 2); }")
            event('event-flag-taken', "() => game.previewServer.event('flag-taken', 'blue', game.previewServer.bots[0].id)")
            event('event-flag-captured', "() => game.previewServer.event('flag-captured', 'red', game.previewServer.selfId)")
            event('event-zone-captured', "() => game.previewServer.event('zone-captured', 'blue', 0, 'Bravo')")
            event('event-zone-lost', "() => game.previewServer.event('zone-lost', 'red', 0, 'Alpha')")
            event('event-bomb-planted', "() => game.previewServer.event('bomb-planted', 'red', 0, 'A')")
            event('event-bomb-defused', "() => game.previewServer.event('bomb-defused', 'blue')")
            event('event-round-win', "() => game.previewServer.event('round-win', 'red')")
            event('event-round-start', "() => game.previewServer.event('round-start', '', 0, 'Round 3 · first to 4')")
            event('event-side-swap', "() => game.previewServer.event('side-swap', 'red')")

            if want('medal-double'):
                ev("() => { game.previewServer.killBot(0); game.previewServer.killBot(1); }"); settle(page, 0.4); shot('medal-double')
                settle(page, 2.6)
            if want('medal-streak'):
                ev("() => { const s = game.previewServer; for (let i = 0; i < 6; i++) s.killBot(i); }"); settle(page, 0.5)
                ev("() => game.previewServer.killBot(2)"); settle(page, 0.4)
                ev("() => game.previewServer.killBot(3)"); settle(page, 0.4)
                shot('medal-streak')
                settle(page, 2.6)
            if want('medal-radar'):
                ev("() => game.onServerMessage({ t: 'radar', pts: [], by: game.previewServer.selfId, sec: 6 })"); settle(page, 0.4); shot('medal-radar')
                settle(page, 2.6)
            if want('toast-notice'):
                ev("() => { const m = document.createElement('div'); m.className = 'notice show'; m.textContent = 'Controller connected: Xbox Wireless Controller'; document.body.append(m); }")
                settle(page, 0.3); shot('toast-notice')
                ev("() => document.querySelector('.notice')?.remove()")
                ev("async () => { const { showToast } = await import('/src/pwa/Toast.ts'); showToast('Screenshot saved: bunkcraft-0001.png', 8000); }")
                settle(page, 0.3); shot('toast-pwa')
                ev("() => document.querySelector('.pwa-toast')?.remove()")
            if want('board'):
                ev("() => game.input.down.add('Tab')"); settle(page, 0.5); shot('board')
                ev("() => game.input.down.delete('Tab')"); settle(page, 0.3)
            if want('death'):
                ev("() => game.previewServer.killSelf(0, true)"); settle(page, 1.2); shot('death')
                settle(page, 3.5)
                ev("() => { const g = game; g.input.locked = true; if (g.state === 'paused') g.state = 'playing'; }")
            if want('end-team'):
                ev("""(report) => {
                  const g = window.game;
                  g.previewServer.endMatch('red');
                  document.querySelector('.click-to-play')?.remove();
                  g.onServerMessage({ t: 'progress', report });
                  g.onServerMessage({ t: 'vote', options: ['atomic', 'villa', 'dockyard'], counts: [2, 1, 0], mine: 0, endsIn: 12 });
                }""", REPORT)
                settle(page, 1.6); shot('end-team')
            stop(page)

        # ---- free for all: "You win!" -------------------------------------------------------------------------------
        if want('end-self'):
            start_preview(page, 'ffa')
            ev("() => game.previewServer.fillScores()")
            ev("""(report) => {
              const g = window.game;
              g.previewServer.endMatch('self');
              document.querySelector('.click-to-play')?.remove();
              g.onServerMessage({ t: 'progress', report });
            }""", REPORT)
            settle(page, 1.6); shot('end-self')
            stop(page)

        # ---- gun game: level up banner ------------------------------------------------------------------------------
        if want('event-level-up'):
            start_preview(page, 'gungame')
            ev("() => game.previewServer.demo()"); settle(page, 0.6)
            ev("() => game.previewServer.event('level-up', '', game.previewServer.selfId, 'smg')"); settle(page, 0.4); shot('event-level-up')
            stop(page)

        # ---- round modes: the round panels (elimination, search and destroy) and the planted bomb -----------------------
        for name, mode in (('round-elimination', 'elimination'), ('round-snd', 'snd')):
            if want(name):
                start_preview(page, mode)
                ev("() => game.previewServer.demo()"); settle(page, 0.8)
                ev("() => game.previewServer.setPhase('live', 90, 'Round 4 · first to 4')"); settle(page, 0.6)
                shot(name)
                if mode == 'snd' and want('round-snd-planted'):
                    ev("() => game.previewServer.plantBomb(21)"); settle(page, 0.8); shot('round-snd-planted')
                stop(page)
        if want('round-snd-planted') and not want('round-snd'):
            start_preview(page, 'snd')
            ev("() => game.previewServer.demo(); game.previewServer.plantBomb(21)"); settle(page, 0.9); shot('round-snd-planted')
            stop(page)

        # ---- Create-a-Class title and the start-up error screen ---------------------------------------------------
        if want('loadout'):
            start_preview(page, 'tdm')
            ev("() => { const a = game.arcade; a.openLoadout(); }"); settle(page, 0.6); shot('loadout')
            ev("() => game.arcade.closeLoadout?.()")
            stop(page)
        # ---- confirmed: tag banner ----------------------------------------------------------------------------------
        if want('event-tag-confirmed'):
            start_preview(page, 'killconfirmed')
            ev("() => game.previewServer.demo()"); settle(page, 0.6)
            ev("() => game.previewServer.event('tag-confirmed', 'red', game.previewServer.selfId)"); settle(page, 0.4); shot('event-tag-confirmed')
            stop(page)

        if want('fatal'):
            # Same markup as fail() in src/main.ts, shown over the menu.
            ev("""() => {
              const el = document.createElement('div');
              el.className = 'fatal';
              el.style.zIndex = '99';
              el.innerHTML = '<div class="home-wordmark">BUNK<span class="craft">CRAFT</span></div><div class="fatal-text">BunkCraft needs WebGL2. Please use a recent version of Chrome, Edge, Firefox or Safari.</div>';
              document.getElementById('app').append(el);
            }"""); settle(page, 0.3); shot('fatal')

        # ---- home, loading, pause, lobby: see scripts/identity-shots.py (wordmark and panel titles) --------------------
        browser.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5611)
    ap.add_argument('--out', default='docs/screenshots/bunkhosting/banners/after')
    ap.add_argument('--only', default='')
    ap.add_argument('--lang', default='en', help='en or nl')
    run(ap.parse_args())


if __name__ == '__main__':
    main()
