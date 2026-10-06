"""
Multiplayer QA, arcade: 4 real browsers play Team Deathmatch through the Vite dev proxy.

  scripts/qa/start-servers.sh 3471 5191 /tmp/bunkqa
  python3 scripts/qa/mp_arcade_browser.py [http://localhost:5191]

Ann creates a TDM game through the menu (score limit 10, 5 min, map rotation), three friends join with the
invite link. Checks teams, HUD, warm-up → live, then a red player walks to a duel spot opposite a blue player,
aims (yaw/pitch computed from positions) and holds the trigger: hit markers, kill feed on all four screens,
scoreboard, death screen of the victim and respawn. Red keeps hunting until the score limit → end screen →
next match on the next map (clients re-join by themselves).
"""
import math
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5191'
SHOTS = os.environ.get('QA_SHOTS', '/tmp/bunkqa-shots')
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(name, ok, detail=''):
    results.append(('PASS' if ok else 'FAIL', name))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  — {detail}' if detail != '' else ''), flush=True)
    return ok


def info(name, detail):
    print(f'INFO  {name}  — {detail}', flush=True)


class P:
    def __init__(self, browser, name):
        self.name = name
        self.ctx = browser.new_context(viewport={'width': 960, 'height': 600})
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def click(self, text, exact=True):
        self.page.get_by_role('button', name=text, exact=exact).first.click()

    def shot(self, label):
        self.page.screenshot(path=f'{SHOTS}/arcade-{self.name}-{label}.png')

    def lock(self):
        self.js("() => { game.input.locked = true; if (game.state === 'paused') game.state = 'playing'; }")

    def team(self):
        return self.js("() => game.arcade ? (game.arcade.team ?? game.arcade.myTeam ?? '') : ''")


def pump(players, seconds):
    end = time.time() + seconds
    while time.time() < end:
        for p in players:
            p.page.bring_to_front()
            p.lock()
        time.sleep(0.2)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--use-angle=metal'])
        ann, ben, cas, dee = (P(browser, n) for n in ('Ann', 'Ben', 'Cas', 'Dee'))
        everyone = [ann, ben, cas, dee]

        ann.page.goto(BASE)
        ann.page.wait_for_function('() => window.game && document.querySelector(".mc-btn")', timeout=30000)
        ann.click('Multiplayer')
        ann.page.get_by_placeholder('Your name (3–16 letters)').fill('Ann')
        ann.click('Create Game')
        for _ in range(5):
            if 'Team Deathmatch' in ann.page.inner_text('body'):
                break
            ann.page.get_by_role('button', name='Game Type:', exact=False).click()
        while 'Score Limit: 10' not in ann.page.inner_text('body'):
            ann.page.get_by_role('button', name='Score Limit:', exact=False).click()
        while 'Time Limit: 5' not in ann.page.inner_text('body'):
            ann.page.get_by_role('button', name='Time Limit:', exact=False).click()
        for _ in range(8):
            if 'Map: Rotate' in ann.page.inner_text('body') or 'Map: Rotation' in ann.page.inner_text('body'):
                break
            ann.page.get_by_role('button', name='Map:', exact=False).click()
        ann.shot('create')
        info('create screen', ' | '.join(l for l in ann.page.inner_text('body').split('\n') if ':' in l)[:300])
        ann.click('Create and Play')
        ann.page.wait_for_function("() => ['playing', 'paused'].includes(game.state)", timeout=60000)
        ann.lock()
        code = ann.js('() => game.roomCode')
        check('arcade: TDM game created through the menu', bool(code) and ann.js('() => !!game.arcade'), code)

        for p in (ben, cas, dee):
            p.page.goto(f'{BASE}/?join={code}')
            p.page.wait_for_function('() => window.game && document.querySelector(".mc-btn")', timeout=30000)
            p.page.get_by_placeholder('Your name (3–16 letters)').fill(p.name)
            p.click('Join Game')
        for p in (ben, cas, dee):
            p.page.wait_for_function("() => ['playing', 'paused'].includes(game.state)", timeout=60000)
            p.lock()
        pump(everyone, 2)
        teams = {p.name: p.js("() => game.arcade.team") for p in everyone}
        info('teams', teams)
        check('arcade: 2 v 2 teams', sorted(teams.values()) == ['blue', 'blue', 'red', 'red'], teams)
        hud = [p.js("() => { const el = game.arcade.hud.el; return !!el && el.isConnected && getComputedStyle(el).display !== 'none'; }") for p in everyone]
        check('arcade: the arcade HUD is visible for everyone', all(hud), hud)
        ann.shot('warmup')

        # Wait for live.
        end = time.time() + 30
        while time.time() < end and ann.js("() => game.arcade.phase") != 'live':
            pump(everyone, 0.5)
        phase = ann.js("() => game.arcade.phase")
        check('arcade: warm-up ends, match is live', phase == 'live', phase)
        pump(everyone, 2.5)

        reds = [p for p in everyone if teams[p.name] == 'red']
        blues = [p for p in everyone if teams[p.name] == 'blue']
        kills_done = 0
        for rnd in range(14):
            if ann.js("() => game.arcade.phase") != 'live':
                break
            shooter, victim = reds[rnd % 2], blues[rnd % 2]
            # Duel spots on the shooter's copy of the arena: open floor, clear line at eye height, 7 blocks apart.
            spots = shooter.js('''() => { const g = (x, y, z) => game.world.getBlock(x, y, z); const p = game.player; const fy = Math.floor(p.y);
              const free = (x, z) => g(x, fy - 1, z) !== 0 && g(x, fy, z) === 0 && g(x, fy + 1, z) === 0;
              for (let r = 0; r < 40; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz; let ok = true;
                for (let i = 0; i <= 7 && ok; i++) ok = free(x + i, z);
                if (ok) return [[x + 0.5, fy, z + 0.5], [x + 7.5, fy, z + 0.5]]; }
              return null; }''')
            if not spots:
                info('round', 'no duel spot near the shooter'); continue
            a, b = spots
            # Walk both there (≤ 1.2 blocks per 50 ms = 24 b/s, under the server's 40).
            for _ in range(200):
                done = True
                for p, tgt in ((shooter, a), (victim, b)):
                    far = p.js('''([x, y, z]) => { const p = game.player; const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
                      if (d < 0.3) { p.setPosition(x, Math.max(p.y, y), z); return false; }
                      const k = Math.min(1, 1.2 / d); p.setPosition(p.x + dx * k, Math.max(p.y, y) + 0.01, p.z + dz * k); return true; }''', tgt)
                    done = done and not far
                time.sleep(0.05)
                if done:
                    break
            pump([shooter, victim], 2.2)  # spawn protection of a fresh respawn
            killed_before = len(ann.js("() => game.arcade.hud?.feedEntries?.() ?? []") or [])
            t_shots = time.time()
            kills_before = shooter.js("() => game.arcade.selfKills")
            for _ in range(60):
                aim = shooter.js('''(name) => { const r = game.remote.list.find(r => r.name === name); if (!r) return null; const p = game.player;
                  const dx = r.mob.x - p.x, dy = r.mob.y + 1.2 - (p.y + 1.62), dz = r.mob.z - p.z;
                  p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); game.input.down.add('Mouse0'); return Math.hypot(dx, dz); }''', victim.name)
                shooter.page.bring_to_front()
                shooter.lock()
                time.sleep(0.1)
                k = shooter.js("() => game.arcade.selfKills")
                if k > kills_before:
                    break
            shooter.js("() => game.input.down.delete('Mouse0')")
            k = shooter.js("() => game.arcade.selfKills")
            if k > kills_before:
                kills_done += 1
                if kills_done == 1:
                    victim.page.bring_to_front()
                    time.sleep(0.3)
                    victim.shot('death')
                    shooter.shot('kill')
                    dtext = victim.page.inner_text('body')
                    check('arcade: the victim sees the death screen with the killer', shooter.name in dtext and ('eliminated' in dtext.lower() or 'killed' in dtext.lower()), dtext[:120].replace('\n', ' | '))
                    feeds = [p.page.inner_text('body').count(victim.name) > 0 for p in everyone]
                    check('arcade: the kill feed names the victim on all four screens', all(feeds), feeds)
            info(f'round {rnd}', f'{shooter.name} → {victim.name}: aim distance {aim and round(aim, 1)}, kills {k} (+{k - kills_before}) in {time.time() - t_shots:.1f}s')
            pump(everyone, 3.4)
        check('arcade: red reaches 10 kills through real clients', kills_done >= 10, kills_done)

        # End screen and next map.
        pump(everyone, 1.5)
        txt = ann.page.inner_text('body')
        ann.shot('end')
        check('arcade: end screen with the winner', 'win' in txt.lower() or 'Next match' in txt, txt[:160].replace('\n', ' | '))
        map0 = ann.js('() => game.arenaMap')
        end = time.time() + 25
        while time.time() < end and ann.js('() => game.arenaMap') == map0:
            pump(everyone, 1)
        pump(everyone, 4)
        maps = [p.js('() => game.arenaMap') for p in everyone]
        states = [p.js('() => game.state') for p in everyone]
        check('arcade: next match on the next map, every client re-joined by itself', len(set(maps)) == 1 and maps[0] != map0 and all(s in ('playing', 'paused') for s in states), f'{map0} → {maps} {states}')
        ann.shot('next-map')
        for p in everyone:
            if p.errors:
                info(f'page errors {p.name}', p.errors[:3])
        browser.close()
    print(f"\n{sum(1 for r in results if r[0] == 'PASS')} passed, {sum(1 for r in results if r[0] == 'FAIL')} failed")


if __name__ == '__main__':
    main()
