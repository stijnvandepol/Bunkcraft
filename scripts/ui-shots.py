"""
UI screenshot suite: every menu and HUD screen at GUI scales 1-4 and three window sizes, plus a pixel-diff
regression check against stored baselines.

Needs the dev build (window.game is a dev-only hook) served by Vite WITHOUT hmr/file watching, e.g. a temporary
config next to vite.config.ts:

    // vite.shots.config.ts
    import base from './vite.config';
    export default { ...base, server: { ...base.server, port: 5199, hmr: false, watch: null } };

    npx vite --config vite.shots.config.ts

Restart the Vite server after source changes: with watching off it keeps serving the old files.

Usage:
    python3 scripts/ui-shots.py [--port 5199] [--out docs/screenshots/ui/matrix]      # full matrix (sizes x scales)
    python3 scripts/ui-shots.py --set after --out docs/screenshots/ui/after            # 1280x800 @ scale 2 only
    python3 scripts/ui-shots.py --update-baselines                                     # write docs/screenshots/ui/baseline
    python3 scripts/ui-shots.py --check                                                # diff against the baselines

Baseline and check runs use a "stable" mode: the 3D canvas is hidden, animations and transitions are frozen and
random texts (splash, tips, dates) are hidden, so only real layout changes show up in the diff.
Never call page.mouse.move while the game believes the pointer is locked; this script only clicks DOM buttons.
"""
import argparse
import os
import sys
import time

from playwright.sync_api import sync_playwright

SIZES = [(1280, 800), (1920, 1080), (800, 600)]
SCALES = [1, 2, 3, 4]
BASELINE_DIR = 'docs/screenshots/ui/baseline'

STABLE_CSS = """
#game { visibility: hidden !important; }
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.splash, .loading-tip, .world-meta, .footer-left, .toasts, .chat-log { visibility: hidden !important; }
"""

# Clicks the first enabled pixel button in the top screen whose label starts with `text`.
HELPERS = """
window.__click = (text) => {
  const screens = [...document.querySelectorAll('#screens > .screen:not(.hidden)')];
  const top = screens[screens.length - 1];
  if (!top) return false;
  const b = [...top.querySelectorAll('button')].find((x) => !x.disabled && x.textContent.trim().startsWith(text));
  if (!b) return false;
  b.click();
  return true;
};
window.__back = () => window.game.stack.depth > 1 && window.game.stack.pop();
"""


def settle(page, t=0.35):
    end = time.time() + t
    while time.time() < end:
        page.bring_to_front()
        time.sleep(0.08)


def shot(page, out, name, size, scale, single):
    eff = page.evaluate("parseInt(getComputedStyle(document.documentElement).getPropertyValue('--s'))")
    if eff != scale:
        return None  # this window is too small for that GUI scale (Minecraft clamps it too)
    fname = f'{name}.png' if single else f'{size[0]}x{size[1]}_s{scale}_{name}.png'
    path = os.path.join(out, fname)
    page.screenshot(path=path)
    return path


def menu_screens(page):
    """(name, setup js or callable) for the screens reachable from the title screen."""
    def opt(*path):
        def go():
            page.evaluate("window.game.menu.showTitle(); window.game.openOptions()")
            for p in path:
                if not page.evaluate(f"window.__click({p!r})"):
                    return False
            return True
        return go

    def worlds(*then):
        def go():
            page.evaluate("window.game.menu.showTitle(); window.game.menu.showBuild()")
            page.evaluate("window.__click('Singleplayer')")
            settle(page, 0.4)
            for p in then:
                if callable(p):
                    p()
                elif not page.evaluate(f"window.__click({p!r})"):
                    return False
            return True
        return go

    def tab(i):
        return lambda: page.evaluate(f"document.querySelectorAll('#screens .tab')[{i}]?.click()")

    return [
        ('title', lambda: page.evaluate("window.game.menu.showTitle()") or True),
        ('options', opt()),
        ('video', opt('Video Settings')),
        ('sound', opt('Music & Sound')),
        ('controls', opt('Controls')),
        ('mouse', opt('Controls', 'Mouse Settings')),
        ('keybinds', opt('Controls', 'Key Binds')),
        ('chat_settings', opt('Chat Settings')),
        ('language', opt('Language')),
        ('credits', opt('Credits')),
        ('worlds', worlds()),
        ('create_game', worlds('Create New World')),
        ('create_world', worlds('Create New World', tab(1))),
        ('create_more', worlds('Create New World', tab(2))),
        ('edit_world', worlds('Edit')),
        ('delete_world', worlds('Delete')),
    ]


def game_screens(page):
    def pause():
        page.evaluate("window.game.input.locked = false; window.game.pause()")
        return True

    def stats():
        pause()
        return page.evaluate("window.__click('Statistics')")

    def hud():
        page.evaluate("const g = window.game; g.stack.clear(); g.input.locked = true; g.state = 'playing'; g.hud.setVisible(true)")
        return True

    def chat():
        hud()
        page.evaluate("""() => {
          const g = window.game; g.chat.setVisible(true); g.chat.clear();
          g.chat.add('Welcome to the UI test world', true); g.chat.add('<Player> hello §cred§r and §aGreen');
          g.chat.openInput('/we');
        }""")
        return True

    def f3():
        hud()
        page.evaluate("if (!window.game.debug.isVisible) window.game.debug.toggle()")
        return True

    def loading():
        page.evaluate("const u = window.game.menu.showLoading('Loading world'); u('Generating terrain...', 0.42)")
        return True

    def death():
        page.evaluate("""async () => {
          const m = await import('/src/ui/MainMenu.ts');
          const g = window.game; g.stack.clear();
          g.stack.push(m.deathScreen({ hardcore: false, message: 'Player was slain by Zombie', score: 42, respawn() {}, spectate() {}, title() {} }));
        }""")
        return True

    def survival_inv():
        page.evaluate("""() => {
          const g = window.game; g.stack.clear(); g.state = 'inventory'; g.input.locked = false;
          g.survivalInventory.open(new Set(['table']));
        }""")
        return True

    def creative_inv():
        page.evaluate("const g = window.game; g.survivalInventory.close(); g.stack.clear(); g.state = 'inventory'; g.inventory.open()")
        return True

    return [
        ('hud', hud), ('chat', chat), ('f3', f3), ('pause', pause), ('statistics', stats),
        ('loading', loading), ('death', death), ('survival_inventory', survival_inv), ('creative_inventory', creative_inv),
    ]


def cleanup(page):
    page.evaluate("""() => {
      const g = window.game;
      try { g.chat.close(); } catch (e) {}
      try { if (g.debug.isVisible) g.debug.toggle(); } catch (e) {}
      try { g.inventory.close(); g.survivalInventory.close(); } catch (e) {}
    }""")


def run(args):
    os.makedirs(args.out, exist_ok=True)
    single = args.set is not None or args.check or args.update_baselines
    sizes = [(1280, 800)] if single else SIZES
    scales = [2] if single else SCALES
    stable = args.check or args.update_baselines
    written = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': sizes[0][0], 'height': sizes[0][1]})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script("try { localStorage.setItem('bunkcraft.settings', JSON.stringify({ language: 'en', guiScale: 2 })); } catch (e) {}")
        page.goto(f'http://localhost:{args.port}/')
        page.wait_for_function('!!(window.game && window.game.menu)', timeout=60000)
        page.evaluate(HELPERS)
        if stable:
            page.add_style_tag(content=STABLE_CSS)
        # One world so the world list, Edit and Delete have something to show.
        page.evaluate("window.game.createWorld('UI Test World', 'ui-shots', 'survival')")
        for _ in range(400):
            page.bring_to_front()
            if page.evaluate("window.game.state") in ('playing', 'paused'):
                break
            time.sleep(0.2)
        # The test player must not die mid-run (falls, mobs): the death screen would cover the other screens.
        page.evaluate("window.game.stats.damage = () => false")
        settle(page, 1.5)

        def matrix(screens):
            for (w, hgt) in sizes:
                page.set_viewport_size({'width': w, 'height': hgt})
                for s in scales:
                    page.evaluate(f"window.game.settings.set('guiScale', {s})")
                    for name, setup in screens:
                        try:
                            ok = setup()
                        except Exception as e:  # a screen missing in an older build
                            print('skip', name, e)
                            ok = False
                        if ok is False:
                            print('skip', name)
                            continue
                        settle(page)
                        path = shot(page, args.out, name, (w, hgt), s, single)
                        if path:
                            written.append(path)
                        cleanup(page)

        matrix(game_screens(page))
        # Back to the title for the menu screens (the world is saved and listed).
        page.evaluate("window.game.quitToTitle()")
        for _ in range(100):
            page.bring_to_front()
            if page.evaluate("window.game.state") == 'menu':
                break
            time.sleep(0.2)
        settle(page, 1)
        matrix(menu_screens(page))
        # Leave no test world behind in the browser profile (it is a fresh one anyway).
        if errors:
            print('page errors:', errors[:5])
        browser.close()
    print(f'{len(written)} screenshots in {args.out}')
    return written


def diff(a, b, tolerance=24):
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    if ia.size != ib.size:
        return 1.0
    d = ImageChops.difference(ia, ib).convert('L').point(lambda v: 255 if v > tolerance else 0)
    hist = d.histogram()
    return hist[255] / (ia.size[0] * ia.size[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='5199')
    ap.add_argument('--out', default='docs/screenshots/ui/matrix')
    ap.add_argument('--set', default=None, help='single size/scale set (1280x800 @ 2), e.g. "after"')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--update-baselines', action='store_true')
    ap.add_argument('--max-diff', type=float, default=0.01, help='fraction of changed pixels that fails a screen')
    args = ap.parse_args()
    if args.update_baselines:
        args.out = BASELINE_DIR
        run(args)
        return
    if args.check:
        args.out = os.path.join('docs/screenshots/ui', '_check')
        written = run(args)
        failed = []
        for path in written:
            base = os.path.join(BASELINE_DIR, os.path.basename(path))
            if not os.path.exists(base):
                print('no baseline for', os.path.basename(path))
                continue
            frac = diff(base, path)
            status = 'FAIL' if frac > args.max_diff else 'ok'
            print(f'{status:4} {os.path.basename(path):28} {frac * 100:.2f}% changed')
            if frac > args.max_diff:
                failed.append(path)
        sys.exit(1 if failed else 0)
    run(args)


if __name__ == '__main__':
    main()
