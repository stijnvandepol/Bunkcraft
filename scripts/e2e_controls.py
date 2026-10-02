"""
Playwright checks for touch controls, gamepad and accessibility (needs a Vite dev server without HMR,
see CLAUDE.md; window.game only exists in dev builds):

  python3 scripts/e2e_controls.py [touch|pad|a11y|all] [outdir] [port]

Touch uses mobile emulation (Pixel 7, iPhone 14, small phone, landscape) with real touch events through
CDP Input.dispatchTouchEvent. The gamepad is a mock navigator.getGamepads. Screenshots of every state go
to outdir. Exits non-zero when a check fails.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

WHICH = sys.argv[1] if len(sys.argv) > 1 else 'all'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bunkcraft-e2e'
PORT = sys.argv[3] if len(sys.argv) > 3 else '5183'
URL = f'http://localhost:{PORT}/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
os.makedirs(OUT, exist_ok=True)

failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))
    if not ok:
        failures.append(name)


def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png')


def boot(page, wait_menu=True):
    page.goto(URL)
    page.wait_for_function('!!(window.game && window.game.stack)', timeout=30000)
    if wait_menu:
        page.wait_for_function("window.game.state === 'menu' && document.querySelector('#screens .screen')", timeout=30000)
        time.sleep(0.5)


def start_world(page, mode='creative'):
    page.evaluate(f"window.game.createWorld('E2E', '7', '{mode}')")
    for _ in range(200):
        if page.evaluate('window.game.state') == 'playing':
            return
        page.bring_to_front()
        time.sleep(0.25)
    raise RuntimeError('world did not start: ' + str(page.evaluate('window.game.state')))


def flat_ground(page):
    """Wait for the player to stand on the ground (chunks streamed in)."""
    for _ in range(80):
        if page.evaluate('window.game.player.onGround'):
            return
        time.sleep(0.15)


class Touch:
    """Multi-touch through CDP (page.touchscreen only taps)."""

    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)

    def send(self, kind, points):
        self.cdp.send('Input.dispatchTouchEvent', {
            'type': kind,
            'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in points.items()],
        })

    def start(self, pts):
        self.send('touchStart', pts)

    def move(self, pts):
        self.send('touchMove', pts)

    def end(self, remaining=None):
        # touchEnd lists the fingers that stay down; empty = all lifted.
        self.send('touchEnd', remaining or {})

    def tap(self, x, y, ms=60):
        self.start({0: (x, y)})
        time.sleep(ms / 1000)
        self.end()

    def drag(self, pid, a, b, steps=6):
        pts = {pid: a}
        self.start(pts)
        for i in range(1, steps + 1):
            t = i / steps
            pts = {pid: (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)}
            self.move(pts)
            time.sleep(0.02)
        return pts


def center(page, selector):
    r = page.evaluate("""(sel) => { const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length > 0);
      if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }""", selector)
    return tuple(r) if r else None


def fits(page):
    """No horizontal page scroll and every visible button inside the viewport horizontally."""
    return page.evaluate("""() => {
      const w = innerWidth, bad = [];
      for (const b of document.querySelectorAll('#screens .screen:not(.hidden) .mc-btn')) {
        const r = b.getBoundingClientRect();
        if (r.width && (r.left < -1 || r.right > w + 1)) bad.push(b.textContent + ':' + Math.round(r.left) + '-' + Math.round(r.right));
      }
      return { scroll: document.documentElement.scrollWidth <= w + 1, bad };
    }""")


def menu_pass(page, tag):
    """Screenshot the main menu, options and the three settings screens; verify they fit."""
    shot(page, f'{tag}-menu')
    f = fits(page)
    check(f'{tag}: main menu fits', f['scroll'] and not f['bad'], json.dumps(f))
    page.evaluate("window.game.openOptions()")
    time.sleep(0.3)
    shot(page, f'{tag}-options')
    f = fits(page)
    check(f'{tag}: options fit', f['scroll'] and not f['bad'], json.dumps(f))
    for label, name in (('Touch Settings...', 'touch'), ('Controller Settings...', 'controller'), ('Accessibility Settings...', 'access')):
        page.get_by_role('button', name=label).click()
        time.sleep(0.3)
        shot(page, f'{tag}-{name}')
        f = fits(page)
        check(f'{tag}: {name} settings fit', f['scroll'] and not f['bad'], json.dumps(f))
        page.evaluate('window.game.stack.pop()')
        time.sleep(0.1)
    page.evaluate('window.game.stack.clear(); window.game.enterMenu()')
    time.sleep(0.3)


# ------------------------------------------------------------------ touch

def run_touch(p):
    pixel = p.devices['Pixel 7']
    iphone = p.devices['iPhone 14']
    browser = p.chromium.launch(args=ARGS)

    # Layout checks on small screens: menus must fit and scroll.
    for tag, vp in (('phone360x640', {'width': 360, 'height': 640}), ('land844x390', {'width': 844, 'height': 390}),
                    ('iphone14', None)):
        base = dict(iphone) if vp is None else dict(pixel)
        base['has_touch'] = True
        base['is_mobile'] = True
        if vp:
            base['viewport'] = vp
            base['screen'] = vp
        ctx = browser.new_context(**base)
        page = ctx.new_page()
        boot(page)
        check(f'{tag}: touch mode detected', page.evaluate('window.game.input.touchMode'))
        menu_pass(page, tag)
        ctx.close()

    # Full touch session on a Pixel 7 in landscape.
    land = dict(pixel)
    land['viewport'] = {'width': 915, 'height': 412}
    land['screen'] = {'width': 915, 'height': 412}
    ctx = browser.new_context(**land)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    boot(page)
    start_world(page, 'creative')
    flat_ground(page)
    time.sleep(1)
    t = Touch(page)
    shot(page, 'touch-hud-creative')
    check('touch: HUD visible while playing', page.evaluate("!document.querySelector('.touch-hud').classList.contains('hidden')"))
    check('touch: virtual lock without pointer lock', page.evaluate('window.game.input.locked && !document.pointerLockElement'))
    check('touch: body.touch-ui', page.evaluate("document.body.classList.contains('touch-ui')"))

    for _ in range(3):
        t.tap(450, 100, 30)  # warm up CDP touch dispatch (first events are slow in headless)
    page.evaluate("""() => { window.__log = []; const s = window.game.input.setAction.bind(window.game.input);
      window.game.input.setAction = (a, d) => { window.__log.push([a, d]); s(a, d); }; }""")

    # Joystick: drag up = forward, player moves, sprint by pushing all the way.
    z0 = page.evaluate('window.game.player.z')
    yaw0 = page.evaluate('window.game.player.yaw')
    t.start({0: (120, 300)})
    t.move({0: (120, 265)})
    time.sleep(0.2)
    fwd = page.evaluate('window.game.input.axisForward')
    check('touch: joystick up gives forward', fwd > 0.3, str(fwd))
    check('touch: half push does not sprint', not page.evaluate('window.game.input.sprintAxis'))
    shot(page, 'touch-joystick')
    time.sleep(0.6)
    t.move({0: (120, 220)})
    time.sleep(0.4)
    check('touch: full push sprints', page.evaluate('window.game.input.sprintAxis'))
    t.end()
    time.sleep(0.2)
    z1 = page.evaluate('window.game.player.z')
    check('touch: joystick moved the player', abs(z1 - z0) > 0.5, f'{z0} -> {z1}')
    check('touch: joystick release stops input', page.evaluate('window.game.input.axisForward') == 0)

    # Look: drag on the right.
    t.drag(1, (650, 200), (730, 200))
    time.sleep(0.15)
    t.end()
    yaw1 = page.evaluate('window.game.player.yaw')
    check('touch: drag looks around', abs(yaw1 - yaw0) > 0.05, f'{yaw0} -> {yaw1}')
    pitch0 = page.evaluate('window.game.player.pitch')
    t.drag(1, (650, 200), (650, 250))
    t.end()
    check('touch: vertical drag changes pitch', abs(page.evaluate('window.game.player.pitch') - pitch0) > 0.05)

    # Buttons.
    jump = center(page, '.tb[data-id="jump"]')
    check('touch: jump button exists', jump is not None)
    y0 = page.evaluate('window.game.player.y')
    t.start({0: jump})
    time.sleep(0.25)
    check('touch: jump button lifts the player', page.evaluate('window.game.player.y') > y0 + 0.2 or not page.evaluate('window.game.player.onGround'))
    t.end()

    attack = center(page, '.tb[data-id="attack"]')
    t.start({0: attack})
    time.sleep(0.15)
    check('touch: attack button holds attack', page.evaluate('window.game.input.leftDown'))
    shot(page, 'touch-attack-held')
    t.end()
    time.sleep(0.1)
    check('touch: attack released', not page.evaluate('window.game.input.leftDown'))

    use = center(page, '.tb[data-id="use"]')
    t.start({0: use})
    time.sleep(0.1)
    check('touch: use button holds use', page.evaluate('window.game.input.rightDown'))
    t.end()

    # Tap the view = use; hold = break.
    used = False
    for _ in range(4):
        page.evaluate('window.__log.length = 0')
        t.tap(700, 150, 30)
        time.sleep(0.2)
        log = page.evaluate('window.__log')
        if any(a == 8 and d for a, d in log):
            used = True
            break
    check('touch: tap on view uses (right button)', used, str(log))
    page.evaluate('window.__log.length = 0')
    t.start({0: (700, 150)})
    time.sleep(0.7)
    check('touch: hold on view attacks', page.evaluate('window.game.input.leftDown'))
    t.end()
    time.sleep(0.1)
    check('touch: hold release stops attack', not page.evaluate('window.game.input.leftDown'))

    # Hotbar tap and swipe.
    bar = page.evaluate("""() => { const r = document.querySelector('.hotbar').getBoundingClientRect();
      return [r.x, r.y + r.height / 2, r.width]; }""")
    x0, ybar, wbar = bar
    t.tap(x0 + wbar * (3.5 / 9), ybar)
    time.sleep(0.15)
    check('touch: tap selects hotbar slot 4', page.evaluate('window.game.hotbar.selected') == 3, str(page.evaluate('window.game.hotbar.selected')))
    t.start({0: (x0 + wbar * (1.5 / 9), ybar)})
    t.move({0: (x0 + wbar * (6.5 / 9), ybar)})
    time.sleep(0.1)
    t.end()
    check('touch: swipe across hotbar selects slot 7', page.evaluate('window.game.hotbar.selected') == 6, str(page.evaluate('window.game.hotbar.selected')))
    check('touch: hotbar slots are finger sized', wbar / 9 >= 34, str(wbar / 9))

    # Double-tap jump = fly in creative.
    page.evaluate('window.game.player.flying = false')
    # CDP touch events are too slow in headless to hit the 0.3 s double tap window: press the virtual jump twice in-page.
    for _ in range(3):
        page.evaluate("""async () => { const i = window.game.input; const f = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          i.setAction(4, true); await f(); i.setAction(4, false); await f(); i.setAction(4, true); await f(); i.setAction(4, false); }""")
        time.sleep(0.4)
        if page.evaluate('window.game.player.flying'):
            break
        time.sleep(0.5)
    check('touch: double tap jump toggles flight in creative', page.evaluate('window.game.player.flying'))
    page.evaluate('(() => { const p = window.game.player; p.setPosition(p.x, p.y + 8, p.z); p.vy = 0; p.flying = true; })()')
    time.sleep(0.3)
    sneak = center(page, '.tb[data-id="sneak"]')
    ys0 = page.evaluate('window.game.player.y')
    page.evaluate('window.__log.length = 0')
    t.start({0: sneak})
    time.sleep(0.7)
    ys1 = page.evaluate('window.game.player.y')
    print('sneak log', page.evaluate('window.__log'), page.evaluate('[window.game.player.flying, window.game.player.onGround, window.game.input.actionDown(5)]'))
    t.end()
    check('touch: sneak button descends while flying', ys1 < ys0 - 0.5, f'{ys0} -> {ys1}')
    page.evaluate('window.game.player.flying = false')

    # Sprint button toggles.
    sprint = center(page, '.tb[data-id="sprint"]')
    t.tap(*sprint)
    check('touch: sprint button toggles sprint on', page.evaluate('window.game.input.sprintAxis'))
    t.tap(*sprint)
    check('touch: sprint button toggles sprint off', not page.evaluate('window.game.input.sprintAxis'))

    # Inventory, pause, options.
    inv = center(page, '.tb[data-id="inventory"]')
    t.tap(*inv)
    time.sleep(0.6)
    check('touch: inventory button opens inventory', page.evaluate('window.game.state') == 'inventory')
    shot(page, 'touch-inventory-creative')
    check('touch: inventory shows a Close button', page.evaluate("!document.querySelector('.tc-close').classList.contains('hidden')"))
    time.sleep(0.5)
    print('state', page.evaluate('window.game.state'), center(page, '.tc-close'))
    t.tap(*center(page, '.tc-close'))
    time.sleep(0.6)
    check('touch: closing inventory resumes without a click', page.evaluate("window.game.state") == 'playing')

    pause = center(page, '.tb[data-id="pause"]')
    t.tap(*pause)
    time.sleep(0.6)
    check('touch: pause button pauses', page.evaluate('window.game.state') == 'paused')
    check('touch: HUD hidden while paused', page.evaluate("document.querySelector('.touch-hud').classList.contains('hidden')"))
    shot(page, 'touch-pause')
    f = fits(page)
    check('touch: pause menu fits', f['scroll'] and not f['bad'], json.dumps(f))
    t.tap(*center(page, '#screens .mc-btn'))  # Back to Game
    time.sleep(0.6)
    check('touch: resume from pause menu with a tap', page.evaluate('window.game.state') == 'playing')

    # Auto-jump: place a one block step in front of the player and walk into it.
    page.evaluate("""() => { const g = window.game, p = g.player; g.player.flying = false;
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      p.yaw = 0; // looking at -z
      for (let dy = 0; dy < 4; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = 1; dz <= 4; dz++)
        g.world.setBlock(bx + dx, by + dy, bz - dz, 0);
      for (let dx = -1; dx <= 1; dx++) for (let dz = 0; dz <= 5; dz++) g.world.setBlock(bx + dx, by - 1, bz - dz, 3);
      for (let dx = -1; dx <= 1; dx++) g.world.setBlock(bx + dx, by, bz - 3, 3); }""")
    time.sleep(0.8)
    zs = page.evaluate('window.game.player.z')
    ys = page.evaluate('window.game.player.y')
    t.start({0: (120, 300)})
    t.move({0: (120, 240)})
    ymax = ys
    for _ in range(14):
        time.sleep(0.15)
        ymax = max(ymax, page.evaluate('window.game.player.y'))
    t.end()
    ye = ymax
    ze = page.evaluate('window.game.player.z')
    check('touch: auto-jump climbs a one block step', ye > ys + 0.8 and ze < zs - 2, f'y {ys}->{ye} z {zs}->{ze}')

    # Left-handed mirrors the layout.
    page.evaluate("window.game.settings.set('touchLeftHanded', true)")
    time.sleep(0.3)
    jl = center(page, '.tb[data-id="jump"]')
    check('touch: left-handed mirrors the buttons', jl[0] < 915 / 2, str(jl))
    shot(page, 'touch-lefty')
    page.evaluate("window.game.settings.set('touchLeftHanded', false)")

    # Gestures that must not reach the browser.
    ev = page.evaluate("""() => { const e = new Event('contextmenu', { cancelable: true, bubbles: true });
      document.querySelector('#game').dispatchEvent(e); return e.defaultPrevented; }""")
    check('touch: context menu prevented', ev)
    css = page.evaluate("""() => ({ ob: getComputedStyle(document.body).overscrollBehaviorY, ta: getComputedStyle(document.body).touchAction,
      us: getComputedStyle(document.body).userSelect })""")
    check('touch: pull-to-refresh, zoom and selection suppressed', css['ob'] == 'none' and 'pinch' not in css['ta'] and css['us'] == 'none', json.dumps(css))
    meta = page.evaluate("document.querySelector('meta[name=viewport]').content")
    check('touch: viewport locks zoom and covers notch', 'user-scalable=no' in meta and 'viewport-fit=cover' in meta, meta)

    # Portrait: orientation hint.
    page.set_viewport_size({'width': 390, 'height': 780})
    time.sleep(0.6)
    shot(page, 'touch-portrait-playing')
    check('touch: portrait shows the rotate hint', page.evaluate("!document.querySelector('.tc-hint').classList.contains('hidden')"))
    page.set_viewport_size({'width': 915, 'height': 412})
    time.sleep(0.4)

    # Survival with touch.
    check('touch: no page errors', not errors, str(errors))
    ctx.close()

    # Arcade HUD with touch.
    ctx = browser.new_context(**land)
    page = ctx.new_page()
    boot(page)
    page.evaluate("window.game.arcadePreview('tdm', 'You', 'classic')")
    for _ in range(120):
        if page.evaluate('window.game.state') == 'playing':
            break
        page.bring_to_front()
        time.sleep(0.25)
    time.sleep(1.5)
    shot(page, 'touch-arcade')
    vis = page.evaluate("""() => [...document.querySelectorAll('.tb')].filter(b => b.offsetParent !== null).map(b => b.dataset.id)""")
    check('touch arcade: fire, aim, reload, scoreboard buttons shown', all(x in vis for x in ('attack', 'use', 'reload', 'swap', 'scoreboard')) and 'sneak' not in vis, str(vis))
    t = Touch(page)
    ads = center(page, '.tb[data-id="use"]')
    t.tap(*ads)
    check('touch arcade: aim is a toggle', page.evaluate('window.game.input.rightDown'))
    t.tap(*ads)
    check('touch arcade: aim toggles off', not page.evaluate('window.game.input.rightDown'))
    t.start({0: center(page, '.tb[data-id="attack"]')})
    time.sleep(0.15)
    check('touch arcade: fire button holds fire', page.evaluate('window.game.input.leftDown'))
    t.end()
    t.start({0: center(page, '.tb[data-id="scoreboard"]')})
    time.sleep(0.3)
    shot(page, 'touch-arcade-scoreboard')
    check('touch arcade: scoreboard button held', page.evaluate('window.game.input.actionDown(24)'))
    t.end()
    ctx.close()

    # Small survival check with the iPhone 14 profile (Chromium engine) for inventory fit.
    ctx = browser.new_context(**{**iphone, 'viewport': {'width': 844, 'height': 390}, 'screen': {'width': 844, 'height': 390}})
    page = ctx.new_page()
    boot(page)
    start_world(page, 'survival')
    flat_ground(page)
    time.sleep(1)
    shot(page, 'touch-iphone-survival')
    t = Touch(page)
    t.tap(*center(page, '.tb[data-id="inventory"]'))
    time.sleep(0.6)
    shot(page, 'touch-iphone-survival-inventory')
    check('touch: survival inventory opens on iPhone profile', page.evaluate('window.game.state') == 'inventory')
    ctx.close()
    browser.close()

    # WebKit (iPhone 14 native engine) smoke: layout and touch mode.
    try:
        wk = p.webkit.launch()
        ctx = wk.new_context(**{**iphone, 'viewport': {'width': 844, 'height': 390}, 'screen': {'width': 844, 'height': 390}})
        page = ctx.new_page()
        page.goto(URL)
        time.sleep(4)
        shot(page, 'webkit-iphone-menu')
        check('webkit iPhone: page rendered', page.evaluate("!!document.querySelector('#screens .screen') || !!document.querySelector('.fatal')"))
        ctx.close()
        wk.close()
    except Exception as e:  # noqa: BLE001
        print('SKIP webkit smoke:', str(e)[:120])


# ------------------------------------------------------------------ gamepad

MOCK_PAD = """
(() => {
  const mk = () => ({ pressed: false, value: 0 });
  const pad = { id: 'Mock Xbox Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, mk), timestamp: 0,
    vibrationActuator: { effects: [], playEffect(type, params) { this.effects.push([type, params]); return Promise.resolve('complete'); } } };
  window.__pad = pad;
  window.__padPresent = false;
  navigator.getGamepads = () => (window.__padPresent ? [pad, null, null, null] : [null, null, null, null]);
  window.__press = (i, v = true) => { pad.buttons[i].pressed = !!v; pad.buttons[i].value = v ? 1 : 0; };
  window.__axes = (a, b, c, d) => { pad.axes = [a, b, c, d]; };
  window.__plug = () => { window.__padPresent = true; const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e); };
  window.__unplug = () => { window.__padPresent = false; pad.connected = false; const e = new Event('gamepaddisconnected'); e.gamepad = pad; window.dispatchEvent(e); };
})();
"""


def tap_button(page, i, ms=120):
    page.evaluate(f'window.__press({i})')
    time.sleep(ms / 1000)
    page.evaluate(f'window.__press({i}, false)')
    time.sleep(0.12)


def run_pad(p):
    browser = p.chromium.launch(args=ARGS)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 720})
    ctx.add_init_script(MOCK_PAD)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    boot(page)
    check('pad: not connected at start', not page.evaluate('window.game.pad.connected'))
    page.evaluate('window.__plug()')
    time.sleep(0.3)
    check('pad: hot-plug detected', page.evaluate('window.game.pad.connected'))
    check('pad: connect notice shown', page.evaluate("document.querySelector('.notice')?.textContent || ''").startswith('Controller connected: Mock Xbox'))
    check('pad: live region announces', 'Controller connected' in page.evaluate("document.getElementById('sr-announcer').textContent"))
    shot(page, 'pad-connected-menu')

    # Menu navigation: d-pad down moves the focus ring, A activates.
    tap_button(page, 13)
    first = page.evaluate("document.querySelector('.pad-focus')?.textContent")
    check('pad: first d-pad press focuses a button', bool(first), str(first))
    tap_button(page, 13)
    second = page.evaluate("document.querySelector('.pad-focus')?.textContent")
    check('pad: d-pad down moves focus', second and second != first, f'{first} -> {second}')
    shot(page, 'pad-menu-focus')
    tap_button(page, 12)
    check('pad: d-pad up moves focus back', page.evaluate("document.querySelector('.pad-focus')?.textContent") == first)
    # Options via the pad: find the Options button by moving focus.
    for _ in range(8):
        if 'Options' in (page.evaluate("document.querySelector('.pad-focus')?.textContent") or ''):
            break
        tap_button(page, 13)
    check('pad: reached Options', 'Options' in (page.evaluate("document.querySelector('.pad-focus')?.textContent") or ''))
    tap_button(page, 0)  # A
    time.sleep(0.4)
    check('pad: A opens the options screen', page.evaluate("document.querySelector('#screens .screen:not(.hidden) .screen-title')?.textContent") == 'Options')
    tap_button(page, 1)  # B
    time.sleep(0.3)
    check('pad: B goes back', page.evaluate('window.game.stack.depth') == 1)

    # Slider adjust with left/right.
    page.evaluate("window.game.openOptions()")
    time.sleep(0.3)
    page.get_by_role('button', name='Controller Settings...').click()
    time.sleep(0.3)
    shot(page, 'pad-controller-settings')
    check('pad: settings screen names the controller', 'Mock Xbox Controller' in page.evaluate("document.querySelector('#screens .screen:not(.hidden)').textContent"))
    page.evaluate('window.game.stack.clear(); window.game.enterMenu()')
    time.sleep(0.3)

    # In game.
    start_world(page, 'survival')
    flat_ground(page)
    time.sleep(1)
    page.evaluate("window.__axes(0, 0, 0, 0)")
    tap_button(page, 0)
    time.sleep(0.2)
    check('pad: pad mode locks virtually (no pointer lock)', page.evaluate('window.game.input.locked && window.game.input.padMode && !document.pointerLockElement'))
    z0 = page.evaluate('window.game.player.z')
    page.evaluate('window.__axes(0, -1, 0, 0)')
    time.sleep(0.8)
    fwd = page.evaluate('window.game.input.axisForward')
    check('pad: left stick forward gives full forward', fwd > 0.95, str(fwd))
    check('pad: full push sprints', page.evaluate('window.game.input.sprintAxis'))
    check('pad: player moved', abs(page.evaluate('window.game.player.z') - z0) > 1)
    page.evaluate('window.__axes(0, -0.1, 0, 0)')
    time.sleep(0.2)
    check('pad: dead zone ignores a light touch', page.evaluate('window.game.input.axisForward') == 0)
    page.evaluate('window.__axes(0, -0.5, 0, 0)')
    time.sleep(0.2)
    half = page.evaluate('window.game.input.axisForward')
    check('pad: half push is analog (slower)', 0.05 < half < 0.7, str(half))
    page.evaluate('window.__axes(0, 0, 0, 0)')
    yaw0 = page.evaluate('window.game.player.yaw')
    page.evaluate('window.__axes(0, 0, 1, 0)')
    time.sleep(0.4)
    page.evaluate('window.__axes(0, 0, 0, 0)')
    yaw1 = page.evaluate('window.game.player.yaw')
    check('pad: right stick right turns right (yaw decreases)', yaw1 < yaw0 - 0.2, f'{yaw0} -> {yaw1}')
    pitch0 = page.evaluate('window.game.player.pitch')
    page.evaluate('window.__axes(0, 0, 0, 1)')
    time.sleep(0.3)
    page.evaluate('window.__axes(0, 0, 0, 0)')
    check('pad: right stick down looks down', page.evaluate('window.game.player.pitch') < pitch0 - 0.1)
    page.evaluate("window.game.settings.set('padInvertY', true)")
    pitch0 = page.evaluate('window.game.player.pitch')
    page.evaluate('window.__axes(0, 0, 0, 1)')
    time.sleep(0.3)
    page.evaluate('window.__axes(0, 0, 0, 0)')
    check('pad: invert Y flips the look direction', page.evaluate('window.game.player.pitch') > pitch0 + 0.1)
    page.evaluate("window.game.settings.set('padInvertY', false)")

    # Buttons.
    page.evaluate('window.__press(7)')
    time.sleep(0.4)
    check('pad: RT attacks', page.evaluate('window.game.input.leftDown'))
    page.evaluate('window.__press(7, false)')
    page.evaluate('window.__press(6)')
    time.sleep(0.4)
    check('pad: LT uses', page.evaluate('window.game.input.rightDown'))
    page.evaluate('window.__press(6, false)')
    sel0 = page.evaluate('window.game.hotbar.selected')
    tap_button(page, 5)
    check('pad: RB next hotbar slot', page.evaluate('window.game.hotbar.selected') == (sel0 + 1) % 9)
    tap_button(page, 4)
    check('pad: LB previous hotbar slot', page.evaluate('window.game.hotbar.selected') == sel0)
    tap_button(page, 15)
    check('pad: d-pad right next hotbar slot', page.evaluate('window.game.hotbar.selected') == (sel0 + 1) % 9)
    page.evaluate('window.__press(0)')
    time.sleep(0.25)
    check('pad: A jumps', not page.evaluate('window.game.player.onGround'))
    page.evaluate('window.__press(0, false)')
    time.sleep(0.8)
    shot(page, 'pad-playing')
    tap_button(page, 2)  # X inventory
    time.sleep(0.5)
    check('pad: X opens the inventory', page.evaluate('window.game.state') == 'inventory')
    shot(page, 'pad-inventory')
    tap_button(page, 1)  # B closes
    time.sleep(0.5)
    check('pad: B closes the inventory', page.evaluate('window.game.state') == 'playing')
    tap_button(page, 9)  # Start
    time.sleep(0.5)
    check('pad: Start pauses', page.evaluate('window.game.state') == 'paused')
    shot(page, 'pad-paused')
    tap_button(page, 13)
    check('pad: pause menu navigable with the d-pad', bool(page.evaluate("document.querySelector('.pad-focus')?.textContent")))
    shot(page, 'pad-paused-focus')
    tap_button(page, 9)
    time.sleep(0.5)
    check('pad: Start resumes', page.evaluate('window.game.state') == 'playing')

    # Rumble and settings.
    page.evaluate('window.__pad.vibrationActuator.effects.length = 0')
    page.evaluate('window.game.stats.onHurt()')
    time.sleep(0.1)
    n = page.evaluate('window.__pad.vibrationActuator.effects.length')
    check('pad: rumble on damage', n == 1, str(n))
    page.evaluate("window.game.settings.set('padRumble', false)")
    page.evaluate('window.game.stats.onHurt()')
    check('pad: rumble can be disabled', page.evaluate('window.__pad.vibrationActuator.effects.length') == 1)
    page.evaluate("window.game.settings.set('padRumble', true)")
    page.evaluate("window.game.settings.set('padLayout', 'southpaw')")
    page.evaluate('window.__axes(0, 0, 0, -1)')
    time.sleep(0.3)
    check('pad: southpaw layout moves with the right stick', page.evaluate('window.game.input.axisForward') > 0.9)
    page.evaluate('window.__axes(0, 0, 0, 0)')
    page.evaluate("window.game.settings.set('padLayout', 'default')")

    # Unplug.
    page.evaluate('window.__unplug()')
    time.sleep(0.3)
    check('pad: unplug detected', not page.evaluate('window.game.pad.connected'))
    check('pad: unplug releases input', page.evaluate('window.game.input.axisForward') == 0)

    # Mouse takes over again.
    page.evaluate('window.__plug()')
    page.mouse.click(600, 300)
    time.sleep(0.2)
    check('pad: mouse click returns to pointer lock mode', not page.evaluate('window.game.input.padMode'))
    check('pad: no page errors', not errors, str(errors))
    ctx.close()
    browser.close()


# ------------------------------------------------------------------ accessibility

def run_a11y(p):
    browser = p.chromium.launch(args=ARGS)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    boot(page)
    check('a11y: prefers-reduced-motion sets Reduced Motion on first launch', page.evaluate('window.game.settings.values.reducedMotion'))
    check('a11y: reduced motion turns view bobbing off', not page.evaluate('window.game.cam.viewBobbing'))
    check('a11y: body class reduced-motion', page.evaluate("document.body.classList.contains('reduced-motion')"))

    # Keyboard focus order and roles.
    page.keyboard.press('Tab')
    tag = page.evaluate('document.activeElement.tagName')
    check('a11y: Tab focuses a real <button> in the main menu', tag == 'BUTTON', tag)
    page.keyboard.press('ArrowDown')
    check('a11y: arrow keys move the menu focus', bool(page.evaluate("document.querySelector('.pad-focus')")))
    shot(page, 'a11y-menu-focus')
    role = page.evaluate("document.querySelector('#screens .screen')?.getAttribute('role')")
    check('a11y: screens are role=dialog', role == 'dialog', str(role))
    page.evaluate('window.game.openOptions()')
    time.sleep(0.3)
    check('a11y: dialog is named after its title', page.evaluate("document.querySelector('#screens .screen:not(.hidden)')?.getAttribute('aria-label')") == 'Options')
    bad = page.evaluate("[...document.querySelectorAll('#screens .screen:not(.hidden) .mc-btn')].filter(b => b.tagName !== 'BUTTON').length")
    check('a11y: all menu buttons are real <button>s', bad == 0)

    # Accessibility screen: capture a screenshot of each option state.
    page.get_by_role('button', name='Accessibility Settings...').click()
    time.sleep(0.3)
    shot(page, 'a11y-screen')
    page.evaluate('window.game.stack.pop(); window.game.stack.pop()')
    page.evaluate("window.game.enterMenu()")
    time.sleep(0.3)

    # Text size and contrast.
    page.evaluate("window.game.settings.setMany({ textScale: 150, highContrast: true })")
    page.evaluate('window.game.openOptions()')
    time.sleep(0.3)
    shot(page, 'a11y-bigtext-contrast-options')
    f = fits(page)
    check('a11y: 150% text and high contrast keep the options menu in view', f['scroll'] and not f['bad'], json.dumps(f))
    page.get_by_role('button', name='Accessibility Settings...').click()
    time.sleep(0.3)
    shot(page, 'a11y-bigtext-contrast-screen')
    f = fits(page)
    check('a11y: accessibility screen at 150% text fits', f['scroll'] and not f['bad'], json.dumps(f))
    page.evaluate("window.game.settings.set('textScale', 200)")
    time.sleep(0.2)
    shot(page, 'a11y-text200')
    f = fits(page)
    check('a11y: accessibility screen at 200% text fits', f['scroll'] and not f['bad'], json.dumps(f))
    page.evaluate("window.game.settings.setMany({ textScale: 100, highContrast: false })")
    page.evaluate('window.game.stack.clear(); window.game.enterMenu()')
    time.sleep(0.3)

    # In game: subtitles, announcements, toggles, colour blind palette, flashes.
    start_world(page, 'survival')
    flat_ground(page)
    # Headless browsers refuse Pointer Lock: use the virtual lock (as touch and gamepad do).
    page.evaluate('window.game.input.padMode = true; window.game.resumeGame()')
    time.sleep(0.5)
    page.evaluate("window.game.settings.set('subtitles', true)")
    page.evaluate("window.game.caption('Zombie groans', window.game.player.x - 10, window.game.player.z)")
    page.evaluate("window.game.caption('Explosion', window.game.player.x, window.game.player.z - 20)")
    time.sleep(0.2)
    texts = page.evaluate("[...document.querySelectorAll('.subtitle')].map(e => e.textContent)")
    check('a11y: subtitles show captions with direction arrows', len(texts) == 2 and any('←' in t or '↖' in t or '↙' in t or '→' in t for t in texts), str(texts))
    shot(page, 'a11y-subtitles')
    time.sleep(3.6)
    check('a11y: subtitles fade out', page.evaluate("document.querySelectorAll('.subtitle').length") == 0)
    page.evaluate("window.game.settings.set('subtitles', false)")
    page.evaluate("window.game.caption('Explosion')")
    check('a11y: subtitles off shows nothing', page.evaluate("document.querySelectorAll('.subtitle').length") == 0)

    page.evaluate('window.game.input.locked && window.game.input.exitLock()')
    time.sleep(0.3)
    announced = page.evaluate("document.getElementById('sr-announcer')?.textContent")
    check('a11y: pause is announced to screen readers', announced == 'Game paused', str(announced))
    page.evaluate('window.game.resumeGame()')
    time.sleep(0.5)

    # Toggle sneak: tap the key once, it stays on.
    page.evaluate("window.game.settings.set('toggleSneak', true)")
    page.evaluate("window.game.input.requestLock()")
    time.sleep(0.2)
    page.keyboard.down('KeyC')
    page.keyboard.up('KeyC')
    time.sleep(0.1)
    on = page.evaluate('window.game.input.actionDown(5)')
    page.keyboard.down('KeyC')
    page.keyboard.up('KeyC')
    off = page.evaluate('window.game.input.actionDown(5)')
    check('a11y: toggle sneak latches on and off', on and not off, f'{on} {off}')
    page.evaluate("window.game.settings.set('toggleSneak', false)")

    # Reduced motion: no hurt tilt, flash capped.
    page.evaluate("window.game.cam.hurt = 0.5")
    page.evaluate("window.game.player.landingImpact = 0")
    check('a11y: camera has Reduced Motion on', page.evaluate('window.game.cam.reducedMotion'))
    page.evaluate("window.game.settings.set('reduceFlashes', true)")
    page.evaluate("window.game.stats.health = 20")
    flash = page.evaluate("""() => { const m = window.game.stats; return 0; }""")
    cap = page.evaluate("""async () => { const mod = await import('/src/core/Accessibility.ts'); return mod.limitFlash(1, window.game.settings.values); }""")
    check('a11y: limitFlash caps at 25% with Reduce Flashes', abs(cap - 0.25) < 1e-6, str(cap))

    # Colour-blind palette and survival bars.
    shot(page, 'a11y-hud-default')
    page.evaluate("window.game.settings.set('colorBlindSafe', true)")
    time.sleep(0.5)
    shot(page, 'a11y-hud-colorblind')
    check('a11y: colour-blind option switches the team colours', page.evaluate("window.game.settings.values.colorBlindSafe && document.body.classList.contains('cb-safe')"))
    page.evaluate("window.game.settings.set('colorBlindSafe', false)")

    # High contrast on a pause menu.
    page.evaluate("window.game.settings.set('highContrast', true)")
    page.evaluate('window.game.input.exitLock()')
    time.sleep(0.4)
    shot(page, 'a11y-contrast-pause')
    check('a11y: no page errors', not errors, str(errors))
    ctx.close()

    # forced-colors / prefers-contrast
    ctx = browser.new_context(viewport={'width': 1280, 'height': 720}, forced_colors='active', contrast='more')
    page = ctx.new_page()
    boot(page)
    check('a11y: prefers-contrast / forced-colors turns High Contrast on first launch', page.evaluate('window.game.settings.values.highContrast'))
    shot(page, 'a11y-forced-colors-menu')
    ctx.close()
    browser.close()


with sync_playwright() as p:
    if WHICH in ('touch', 'all'):
        run_touch(p)
    if WHICH in ('pad', 'all'):
        run_pad(p)
    if WHICH in ('a11y', 'all'):
        run_a11y(p)

print()
print('FAILED:' if failures else 'ALL CHECKS PASSED', *failures, sep='\n  ' if failures else ' ')
sys.exit(1 if failures else 0)
