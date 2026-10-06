"""
BunkCraft Realms through the real menus, with 2-3 Chromium browsers (--use-angle=metal) and protocol bots that
fill the lobbies (scripts/qa/arcade-perf-bots.ts).

  scripts/qa/start-servers.sh 3523 5523 /tmp/bunkqa
  QA_VITE=http://localhost:5523 QA_SERVER=http://localhost:3523 python3 scripts/qa/realms-flow.py [part ...]

Parts (default: all):
  quickplay  Title -> Realms -> Quick Play for every mode with two browsers: same lobby, lobby panel, bots fill the
             lobby to 12, the match goes live, HUD and console checked, then both leave (Esc -> Disconnect) back to
             the Realms playlist.
  browse     A quick-plays, B finds the lobby under Browse Lobbies (filter by mode) and joins it.
  private    A creates a private lobby (mode, map, hidden from the list), B joins with the code; the lobby is not
             listed, a bad code gives an error.
  vote       A private rotating TDM lobby (score 10) with 14 bots: the match ends, both browsers vote with the
             number keys, the voted map is the next one and both clients follow it.
Screenshots go to QA_SHOTS (default /tmp/bunkqa-shots/realms).
"""
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

SERVER = os.environ.get('QA_SERVER', 'http://localhost:3523')
SHOTS = os.environ.get('QA_SHOTS', '/tmp/bunkqa-shots/realms')
os.makedirs(SHOTS, exist_ok=True)
MODES = ['tdm', 'ffa', 'gungame', 'elimination', 'hardpoint', 'domination', 'ctf']
MODE_NAMES = {'tdm': 'Team Deathmatch', 'ffa': 'Free For All', 'gungame': 'Gun Game', 'elimination': 'Team Elimination',
              'hardpoint': 'Hardpoint', 'domination': 'Domination', 'ctf': 'Capture the Flag'}
results = []
bots = []


def check(name, ok, detail=''):
    results.append((ok, name))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  - {detail}' if detail != '' else ''), flush=True)
    return ok


def info(name, detail):
    print(f'INFO  {name}  - {detail}', flush=True)


def spawn_bots(code, n, seconds, map_id='classic'):
    p = subprocess.Popen(['npx', 'tsx', 'scripts/qa/arcade-perf-bots.ts', SERVER, code, str(n), str(seconds), map_id],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    bots.append(p)
    return p


def stop_bots():
    for p in bots:
        if p.poll() is None:
            p.terminate()
    bots.clear()


class P:
    """One player: own browser context (own localStorage = own identity)."""

    def __init__(self, browser, name):
        self.name = name
        self.ctx = browser.new_context(viewport={'width': 1280, 'height': 720})
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(f'pageerror: {e}'))
        self.page.on('console', lambda m: self.errors.append(f'console: {m.text}') if m.type == 'error' else None)

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def btn(self, text, exact=True):
        self.page.get_by_role('button', name=text, exact=exact).first.click()

    def shot(self, label):
        self.page.screenshot(path=f'{SHOTS}/{label}.png')

    def title(self):
        self.page.goto(q.VITE + '/')
        self.page.wait_for_function('() => window.game && window.game.state === "menu" && !!document.querySelector("button")', timeout=60000)

    def realms(self):
        """Title -> BunkCraft Realms (asks the name once)."""
        self.btn('BunkCraft Realms')
        self.page.wait_for_selector('.realms-screen, input.mc-input', timeout=10000)
        if self.page.locator('.realms-screen').count() == 0:
            self.page.locator('input.mc-input:visible').first.fill(self.name)
            self.page.keyboard.press('Enter')
        self.page.wait_for_selector('.realms-screen .realms-item', timeout=10000)

    def wait_world(self, timeout=90):
        end = time.time() + timeout
        while time.time() < end:
            self.page.bring_to_front()
            st = self.js('() => game.state')
            if st not in ('loading', 'menu') and self.js('() => !!game.arcade'):
                return True
            time.sleep(0.25)
        return False

    def lock(self):
        self.js("() => { game.input.locked = true; if (game.state !== 'playing' && game.state !== 'chat') game.state = 'playing'; document.querySelector('.click-to-play')?.remove(); }")

    def code(self):
        return self.js('() => game.roomCode')

    def arcade(self):
        return self.js('''() => { const a = game.arcade; if (!a) return null;
          return { type: a.info.type, map: a.info.map, phase: a.phase, team: a.team, roster: a.roster.length }; }''')

    def leave_ui(self):
        """Esc -> pause menu -> Disconnect, like a player would."""
        self.page.bring_to_front()
        self.js("() => { game.state = 'playing'; }")
        self.page.keyboard.press('Escape')
        time.sleep(0.4)
        if self.page.get_by_role('button', name='Disconnect').count() == 0:
            self.js('() => game.pause && game.pause()')
            time.sleep(0.3)
        self.btn('Disconnect')
        try:
            self.page.wait_for_selector('.realms-screen .realms-item', timeout=15000)
            return True
        except Exception:
            return False


def pump(players, seconds, lock=True):
    end = time.time() + seconds
    while time.time() < end:
        for p in players:
            p.page.bring_to_front()
            if lock:
                p.lock()
        time.sleep(0.3)


def wait_phase(players, phase, timeout):
    end = time.time() + timeout
    while time.time() < end:
        got = []
        for p in players:
            p.page.bring_to_front()
            p.lock()
            a = p.arcade()
            got.append(a and a['phase'])
        if all(g == phase for g in got):
            return True
        time.sleep(0.5)
    return False


def hud_texts(p):
    return p.js('''() => {
      const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).filter(Boolean);
      return { top: vis('.arc-top, .arc-timer, .arc-clock').slice(0, 3), ammo: vis('.arc-ammo').slice(0, 1), feed: vis('.arc-feed > *').slice(0, 4),
               lobby: vis('.mlobby-status'), banner: vis('.arc-banner, .arc-center').slice(0, 2) };
    }''')


# ---------------------------------------------------------------- parts

def part_quickplay(br):
    a, b = P(br, 'qa_alpha'), P(br, 'qa_bravo')
    a.title(); b.title()
    a.realms(); b.realms()
    check('realms playlist shows 7 modes', a.page.locator('.realms-item').count() == 7)
    mode_names = {m: a.page.locator(f'.realms-item[data-mode="{m}"] .world-name').text_content() for m in MODES}
    for mode in MODES:
        a.page.locator(f'.realms-item[data-mode="{mode}"]').click()
        a.btn('Quick Play')
        ok = a.wait_world()
        check(f'{mode}: A quick play joins a lobby', ok)
        if not ok:
            a.shot(f'qp-{mode}-fail')
            continue
        a.lock()
        info_a = a.arcade()
        check(f'{mode}: lobby runs the right mode', info_a and info_a['type'] == mode, str(info_a))
        pump([a], 1.0)
        lob = a.js("() => { const e = document.querySelector('.mlobby'); return e && !e.classList.contains('hidden') ? e.textContent : ''; }")
        check(f'{mode}: lobby panel shown in the warm-up', mode_names[mode] in lob and 'qa_alpha' in lob, lob[:120])
        # B: double-click the row (the other way to start quick play).
        b.page.locator(f'.realms-item[data-mode="{mode}"]').dblclick()
        okb = b.wait_world()
        same = okb and b.code() == a.code()
        check(f'{mode}: B is matched into the same lobby', same, f'{a.code()} / {okb and b.code()}')
        fill = 14 if mode == 'tdm' else 10
        spawn_bots(a.code(), fill, 75, info_a['map'] or 'classic')
        live = wait_phase([a, b], 'live', 45)
        check(f'{mode}: {fill + 2} players, the match goes live', live, f"{a.arcade()} {b.arcade()}")
        pump([a, b], 8)
        hud = hud_texts(a)
        info(f'{mode}: HUD', str(hud))
        a.shot(f'qp-{mode}-{info_a["map"]}')
        roster = a.arcade()['roster']
        check(f'{mode}: roster has {fill + 2}', roster == fill + 2, str(roster))
        if mode == 'tdm':
            # The lobby is full (16): quick play must open a new lobby for a third player instead.
            c = P(br, 'qa_charlie')
            c.title(); c.realms()
            c.page.locator('.realms-item[data-mode="tdm"]').click()
            c.btn('Quick Play')
            okc = c.wait_world()
            check('tdm: quick play skips the full lobby and opens a new one', okc and c.code() != a.code(), f'{okc and c.code()} vs {a.code()}')
            c.ctx.close()
        back = a.leave_ui()
        check(f'{mode}: A leaves (Esc -> Disconnect) back to the Realms playlist', back)
        b.js('() => game.quitToTitle()')
        b.page.wait_for_selector('.realms-screen .realms-item', timeout=15000)
        stop_bots()
        if not back:
            a.title(); a.realms()
    for p in (a, b):
        check(f'{p.name}: no console errors', not p.errors, '; '.join(p.errors[:5]))
    a.ctx.close(); b.ctx.close()


def part_browse(br):
    a, b = P(br, 'qa_host'), P(br, 'qa_finder')
    a.title(); a.realms()
    a.page.locator('.realms-item[data-mode="domination"]').click()
    a.btn('Quick Play')
    check('browse: A in a domination lobby', a.wait_world())
    code = a.code()
    b.title(); b.realms()
    b.btn('Browse Lobbies')
    b.page.wait_for_selector('.realms-screen .realms-item, .world-empty', timeout=10000)
    # Filter until Domination.
    for _ in range(9):
        if 'Domination' in b.page.get_by_role('button', name='Mode:', exact=False).first.text_content():
            break
        b.page.get_by_role('button', name='Mode:', exact=False).first.click()
    row = b.page.locator(f'.realms-item[data-code="{code}"]')
    check('browse: the lobby is listed under its mode', row.count() == 1)
    if row.count():
        text = row.text_content()
        check('browse: row shows mode, map, players', 'Domination' in text and '1/' in text, text)
        b.shot('browse-list')
        row.click()
        b.btn('Join Lobby')
        check('browse: B joined that lobby', b.wait_world() and b.code() == code)
    b.js('() => game.quitToTitle()'); a.js('() => game.quitToTitle()')
    for p in (a, b):
        check(f'browse {p.name}: no console errors', not p.errors, '; '.join(p.errors[:5]))
    a.ctx.close(); b.ctx.close()


def part_private(br):
    a, b, c = P(br, 'qa_owner'), P(br, 'qa_friend'), P(br, 'qa_stranger')
    a.title(); a.realms()
    a.btn('Private Lobby')
    for _ in range(8):
        if 'Capture the Flag' in a.page.get_by_role('button', name='Mode:', exact=False).first.text_content():
            break
        a.page.get_by_role('button', name='Mode:', exact=False).first.click()
    for _ in range(12):
        if 'Bunker' in a.page.get_by_role('button', name='Map:', exact=False).first.text_content():
            break
        a.page.get_by_role('button', name='Map:', exact=False).first.click()
    a.shot('private-create')
    a.btn('Create Lobby', exact=False)
    a.page.wait_for_selector('.realms-code', timeout=10000)
    code = a.page.locator('.realms-code').text_content().replace('-', '').replace(' ', '')
    link = a.page.locator('input.mc-input').input_value()
    check('private: code and invite link shown', len(code) == 6 and code in link.replace('-', ''), f'{code} {link}')
    a.shot('private-created')
    a.btn('Play')
    ok = a.wait_world()
    ia = a.arcade()
    check('private: owner joins a ctf lobby on Bunker Flag', ok and ia['type'] == 'ctf' and ia['map'] == 'bunker', str(ia))
    # Not listed for strangers.
    c.title(); c.realms(); c.btn('Browse Lobbies')
    time.sleep(1.5)
    check('private: a private lobby is not listed', c.page.locator(f'.realms-item[data-code="{code}"]').count() == 0)
    # Bad code.
    c.btn('Back'); c.btn('Join with Code', exact=False)
    c.page.locator('input.mc-input:visible').fill('ZZZZZZ')
    c.page.keyboard.press('Enter')
    time.sleep(1.5)
    err = c.page.locator('.error:visible').first.text_content() if c.page.locator('.error:visible').count() else ''
    check('private: an unknown code gives an error', bool(err.strip()), err)
    # Friend joins by code (typed with a dash, like it is shown).
    b.title(); b.realms(); b.btn('Join with Code', exact=False)
    b.page.locator('input.mc-input:visible').fill(code[:3] + '-' + code[3:])
    time.sleep(1.0)
    prev = b.page.locator('.hint').all_text_contents()
    check('private: code preview shows the lobby', any('Capture the Flag' in t for t in prev), str(prev))
    b.page.keyboard.press('Enter')
    check('private: friend joined with the code', b.wait_world() and b.code() == code)
    live = wait_phase([a, b], 'live', 40)
    check('private: 1v1 ctf goes live', live)
    a.shot('private-live-ctf-bunker')
    for p in (a, b, c):
        check(f'private {p.name}: no console errors', not p.errors, '; '.join(p.errors[:5]))
    a.js('() => game.quitToTitle()'); b.js('() => game.quitToTitle()')
    a.ctx.close(); b.ctx.close(); c.ctx.close()


def part_vote(br):
    a, b = P(br, 'qa_voter1'), P(br, 'qa_voter2')
    a.title(); a.realms()
    a.btn('Private Lobby')
    # TDM, rotating maps, score 10, 16 players.
    for _ in range(8):
        if '10' in a.page.get_by_role('button', name='Score Limit', exact=False).first.text_content():
            break
        a.page.get_by_role('button', name='Score Limit', exact=False).first.click()
    for _ in range(8):
        if '16' in a.page.get_by_role('button', name='Max Players', exact=False).first.text_content():
            break
        a.page.get_by_role('button', name='Max Players', exact=False).first.click()
    a.btn('Create Lobby', exact=False)
    a.page.wait_for_selector('.realms-code', timeout=10000)
    code = a.page.locator('.realms-code').text_content().replace('-', '').replace(' ', '')
    a.btn('Play')
    check('vote: owner in the rotating lobby', a.wait_world())
    first_map = a.arcade()['map']
    b.title(); b.realms(); b.btn('Join with Code', exact=False)
    b.page.locator('input.mc-input:visible').fill(code)
    b.page.keyboard.press('Enter')
    check('vote: B joined', b.wait_world() and b.code() == code)
    spawn_bots(code, 14, 400, first_map)
    check('vote: 16 players go live', wait_phase([a, b], 'live', 45), str(a.arcade()))
    # Bots fight to 10 kills.
    end = time.time() + 300
    while time.time() < end:
        pump([a, b], 2)
        if a.js('() => !!document.querySelector(".mvote:not(.hidden)")'):
            break
    voting = a.js('() => !!document.querySelector(".mvote:not(.hidden)")')
    check('vote: the match ended and the map vote is shown', voting)
    if not voting:
        a.shot('vote-missing')
        stop_bots()
        return
    a.shot('vote-shown')
    opts = a.js('() => [...document.querySelectorAll(".mvote-name")].map((e) => e.textContent)')
    info('vote: options', str(opts))
    check('vote: three maps offered', len(opts) == 3)
    for p in (a, b):
        p.page.bring_to_front()
        p.page.keyboard.press('Digit3')
        time.sleep(0.5)
    time.sleep(1.0)
    mine = a.js('() => document.querySelector(".mvote-mine")?.textContent || ""')
    counts = a.js('() => [...document.querySelectorAll(".mvote-count")].map((e) => e.textContent)')
    check('vote: key 3 registers the vote and the counts update', opts[2] in mine and '2' in counts[2], f'{mine} {counts}')
    # Change the vote (allowed) and back.
    b.page.bring_to_front(); b.page.keyboard.press('Digit2'); time.sleep(0.6)
    b.page.keyboard.press('Digit3'); time.sleep(0.6)
    a.shot('vote-cast')
    # Wait for the next match on the voted map (clients re-join on their own).
    from_name = {'Classic': 'classic'}
    end = time.time() + 60
    nxt = None
    while time.time() < end:
        pump([a, b], 1)
        ia, ib = a.arcade(), b.arcade()
        if ia and ib and ia['map'] != first_map and ib['map'] == ia['map'] and ia['phase'] in ('warmup', 'live'):
            nxt = ia['map']
            break
    name = a.js('(id) => game.arcade ? document.querySelector(".mlobby-map")?.textContent : ""')
    check('vote: both clients moved to the voted map', nxt is not None and opts[2] == name, f'{first_map} -> {nxt} ({name}), voted {opts[2]}')
    a.shot('vote-next-map')
    back = a.leave_ui()
    check('vote: leaving goes back to Realms', back)
    stop_bots()
    for p in (a, b):
        check(f'vote {p.name}: no console errors', not p.errors, '; '.join(p.errors[:5]))
    a.ctx.close(); b.ctx.close()


PARTS = {'quickplay': part_quickplay, 'browse': part_browse, 'private': part_private, 'vote': part_vote}

if __name__ == '__main__':
    want = sys.argv[1:] or list(PARTS)
    with sync_playwright() as pw:
        browser = q.launch(pw)
        try:
            for part in want:
                print(f'== {part}', flush=True)
                try:
                    PARTS[part](browser)
                except Exception as e:  # keep going with the next part
                    check(f'{part}: ran without an exception', False, repr(e)[:300])
                finally:
                    stop_bots()
        finally:
            browser.close()
    fails = [n for ok, n in results if not ok]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
