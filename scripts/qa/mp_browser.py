"""
Multiplayer QA with real browsers: 2-3 friends in a survival game through the Vite dev proxy.

  scripts/qa/start-servers.sh 3471 5191 /tmp/bunkqa      # game server + Vite (no HMR) on own ports
  QA_SERVER_PORT=3471 QA_DATA_DIR=/tmp/bunkqa/data python3 scripts/qa/mp_browser.py [http://localhost:5191]

Flow: Alice creates a survival game through the menu, Bob joins with the invite link, Carol types the code.
Then chat, /help, /time, building and a block race, a drop and who picks it up, mobs at night (same mobs?
damage?), interpolation smoothness of a walking friend, reconnect with inventory, kick/ban, a locked game
with a typo'd password, and (with QA_SERVER_PORT + QA_DATA_DIR) a server restart. Prints PASS/FAIL/INFO lines and writes
screenshots to $QA_SHOTS (default /tmp/bunkqa-shots).

Input goes through game internals only (game.input.*, world.setBlock); never page.mouse.move while locked.
"""
import json
import os
import signal
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5191'

SHOTS = os.environ.get('QA_SHOTS', '/tmp/bunkqa-shots')
os.makedirs(SHOTS, exist_ok=True)
results = []


def check(name, ok, detail=''):
    results.append(('PASS' if ok else 'FAIL', name, str(detail)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  — {detail}' if detail else ''), flush=True)
    return ok


def info(name, detail):
    results.append(('INFO', name, str(detail)))
    print(f'INFO  {name}  — {detail}', flush=True)


class Player:
    def __init__(self, browser, name):
        self.name = name
        self.ctx = browser.new_context(viewport={'width': 960, 'height': 600})
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('console', lambda m: self.errors.append(m.text) if m.type == 'error' else None)

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def front(self):
        self.page.bring_to_front()

    def shot(self, label):
        self.page.screenshot(path=f'{SHOTS}/{self.name}-{label}.png')

    def click(self, text, exact=True):
        # The sandbox menus sit behind the home screen's Build & Survival door.
        if text in ('Multiplayer', 'Singleplayer') and self.page.locator('.home:visible').count() and not self.page.get_by_role('button', name=text, exact=exact).count():
            self.page.locator('.home-build').click()
        self.page.get_by_role('button', name=text, exact=exact).first.click()

    def open_title(self, url=BASE):
        self.page.goto(url)
        self.page.wait_for_function('() => window.game && document.querySelector("#screens button")', timeout=30000)

    def wait_playing(self, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            self.front()
            st = self.js('() => window.game.state')
            if st not in ('loading', 'menu'):
                # Force the input state like a locked pointer (pointer lock does not work in automation).
                # Pointer lock is refused in automation, so a fresh world shows "Click to play" (paused): that counts.
                self.js("() => { game.input.locked = true; if (game.state === 'paused') game.state = 'playing'; }")
                return 'playing' if st in ('playing', 'paused') else st
            time.sleep(0.3)
        return self.js('() => window.game.state')

    def menu_text(self):
        return self.js('() => document.body.innerText')

    def chat(self, text):
        """Opens chat with T and sends a line, like a player."""
        self.front()
        self.respawn_if_dead()
        self.js("() => { game.input.locked = true; game.state = 'playing'; }")
        self.page.keyboard.press('t')
        try:
            self.page.wait_for_selector('.chat-input:not(.hidden)', timeout=3000)
        except Exception:
            info(f'chat could not be opened for {self.name}', self.js('() => game.state'))
            return
        time.sleep(0.15)  # the input takes focus a moment after T (keys typed before that are lost)
        self.page.keyboard.type(text, delay=15)
        self.page.keyboard.press('Enter')
        self.js("() => { game.input.locked = true; game.state = 'playing'; }")

    def respawn_if_dead(self):
        if self.js('() => game.state') == 'dead':
            info(f'{self.name} died', 'respawning')
            self.shot('death')
            self.click('Respawn')
            time.sleep(1)

    def chat_log(self):
        return self.js("() => [...document.querySelectorAll('.chat-log > *')].map(e => e.textContent)")


def wait_until(players, cond, timeout=10, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        for p in players:
            p.front()
        if cond():
            return True
        time.sleep(step)
    return cond()


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'])
        alice, bob, carol = Player(browser, 'Alice'), Player(browser, 'Bobby'), Player(browser, 'Carol')

        # ---------------------------------------------------------------- create via the menu
        alice.open_title()
        alice.click('Multiplayer')
        alice.page.get_by_placeholder('Your name (3–16 letters)').fill('Alice')
        alice.click('Create Game')
        alice.page.wait_for_selector('text=Create and Play')
        alice.shot('create-game')
        alice.click('Create and Play')
        st = alice.wait_playing()
        check('menu: Create Game → Create and Play puts the creator in the world', st == 'playing', st)
        code = alice.js('() => game.roomCode')
        check('menu: the game has a 6-character code', bool(code) and len(code) == 6, code)
        log = alice.chat_log()
        check('chat shows the game code and how to invite', any('Game code' in l for l in log), log[-3:])

        # Invite friends screen.
        alice.js('() => game.pause()')
        time.sleep(0.4)
        alice.shot('pause')
        has_invite = 'Invite Friends' in alice.menu_text()
        check('pause menu has Invite Friends', has_invite)
        if has_invite:
            alice.click('Invite Friends')
            time.sleep(0.3)
            txt = alice.menu_text() + ' ' + ' '.join(alice.js('() => [...document.querySelectorAll("input")].map(i => i.value)'))
            check('invite screen shows the link', f'?join={code}' in txt, txt[:200].replace('\n', ' | '))
            alice.shot('invite')
            alice.click('Done')
            time.sleep(0.3)
        alice.click('Back to Game')
        alice.wait_playing()

        # ---------------------------------------------------------------- join by link and by code
        bob.open_title(f'{BASE}/?join={code}')
        time.sleep(1)
        bob.shot('invite-link')
        bob.page.get_by_placeholder('Your name (3–16 letters)').fill('Bobby')
        prefilled = bob.page.get_by_placeholder('Game code or invite link').input_value()
        check('invite link opens Multiplayer with the code filled in', code in prefilled.replace('-', ''), prefilled)
        bob.click('Join Game')
        st = bob.wait_playing()
        check('friend joins through the invite link', st == 'playing', st)
        check('invite link is removed from the address bar after joining', 'join=' not in bob.page.url, bob.page.url)

        carol.open_title()
        carol.click('Multiplayer')
        carol.page.get_by_placeholder('Your name (3–16 letters)').fill('Carol')
        carol.page.get_by_placeholder('Game code or invite link').fill(f'{code[:3].lower()}-{code[3:].lower()}')
        time.sleep(0.6)
        preview = carol.menu_text()
        info('join screen preview of a typed code', [l for l in preview.split('\n') if 'Survival' in l or 'player' in l.lower()][:3])
        carol.click('Join Game')
        st = carol.wait_playing()
        check('friend joins by typing the code (lower case with dash)', st == 'playing', st)

        ok = wait_until([alice, bob, carol], lambda: all(p.js('() => game.remote.list.length') == 2 for p in (alice, bob, carol)), 10)
        check('everyone sees the two others as remote players', ok, [p.js('() => game.remote.list.length') for p in (alice, bob, carol)])

        # ---------------------------------------------------------------- chat and commands
        bob.chat('hoi allemaal')
        ok = wait_until([alice, carol], lambda: any('hoi allemaal' in l for l in alice.chat_log()) and any('hoi allemaal' in l for l in carol.chat_log()), 5)
        check('chat message reaches the others', ok)
        alice.chat('/help')
        time.sleep(0.8)
        check('/help for the owner lists moderation commands', any('/kick' in l for l in alice.chat_log()), alice.chat_log()[-1][:120])
        bob.chat('/time set night')
        time.sleep(0.8)
        check('/time by a non-op is refused with a message', any('permission' in l for l in bob.chat_log()), bob.chat_log()[-1])
        t0 = bob.js('() => game.cycle.time')
        time.sleep(1.1)
        alice.chat('/time set night')
        ok = wait_until([bob], lambda: abs(bob.js('() => game.cycle.time') - 0.55) < 0.02, 4)
        check('/time set night changes the time for friends', ok, f'{t0:.3f} → {bob.js("() => game.cycle.time"):.3f}')
        time.sleep(1.1)
        alice.chat('/weather rain')
        ok = wait_until([bob], lambda: bob.js('() => game.weatherSys.rainTarget ?? game.weatherSys.target?.rain ?? -1') not in (0, -1), 4)
        info('/weather rain on the friend', bob.js('() => JSON.stringify(Object.fromEntries(Object.entries(game.weatherSys).filter(([k,v]) => typeof v === "number")))'))
        time.sleep(1.1)
        alice.chat('/time set day')
        time.sleep(0.5)
        alice.shot('chat')

        # ---------------------------------------------------------------- building together
        # Survival placing costs the item (InventoryGuard.authorizeEdit): give everybody bricks and glass the way an op
        # can (a game mode switch makes each player's next inventory the server's baseline).
        alice.chat('/gamemode creative')
        time.sleep(1.1)
        alice.chat('/gamemode survival')
        time.sleep(1.1)
        for p in (alice, bob, carol):
            p.js('''() => { game.playerInventory.set(0, { id: 45, count: 64 }); game.playerInventory.set(1, { id: 11, count: 64 });
              game.saveGame(); }''')
        time.sleep(0.5)
        spot = alice.js('''() => { const p = game.player; const x = Math.floor(p.x) + 2, z = Math.floor(p.z);
          let y = Math.floor(p.y) + 1; while (game.world.getBlock(x, y, z) !== 0 && y < p.y + 4) y++; return [x, y, z]; }''')
        alice.js('([x, y, z]) => game.world.setBlock(x, y, z, 45)', spot)  # bricks
        ok = wait_until([bob, carol], lambda: bob.js('([x,y,z]) => game.world.getBlock(x,y,z)', spot) == 45 and carol.js('([x,y,z]) => game.world.getBlock(x,y,z)', spot) == 45, 4)
        check('a placed block shows up for both friends', ok, spot)
        # Race: Bob breaks it while Carol replaces it with glass at the same moment.
        bob.js('([x,y,z]) => game.world.setBlock(x,y,z,0)', spot)
        carol.js('([x,y,z]) => game.world.setBlock(x,y,z,11)', spot)
        time.sleep(1.5)
        views = [p.js('([x,y,z]) => game.world.getBlock(x,y,z)', spot) for p in (alice, bob, carol)]
        check('block race: all three end with the same block', len(set(views)) == 1, views)

        # Out of reach edit is rolled back.
        far = [spot[0] + 30, spot[1], spot[2]]
        bob.js('([x,y,z]) => game.world.setBlock(x,y,z,45)', far)
        time.sleep(1)
        check('out-of-reach edit is rolled back on the client', bob.js('([x,y,z]) => game.world.getBlock(x,y,z)', far) != 45)

        # ---------------------------------------------------------------- drops: who gets them
        # Alice mines a block next to her the way Interaction does (edit, then the block's drop).
        drop = alice.js('''() => { const p = game.player; let x = 0, y = 0, z = 0, id = 0;
          for (let dx = -2; dx <= 2 && !id; dx++) for (let dz = -2; dz <= 2 && !id; dz++) for (let dy = -3; dy <= 0 && !id; dy++) {
            if (!dx && !dz) continue;
            const b = game.world.getBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
            if ((b === 2 || b === 3) && game.world.getBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy + 1, Math.floor(p.z) + dz) === 0) {
              x = Math.floor(p.x) + dx; y = Math.floor(p.y) + dy; z = Math.floor(p.z) + dz; id = b; }
          }
          game.world.setBlock(x, y, z, 0);
          game.entities.dropItem({ id: 3, count: 1 }, x + 0.5, y + 0.5, z + 0.5, 10); return [x + 0.5, y, z + 0.5, id]; }''')
        info('Alice mined', f'block {drop[3]} at {drop[:3]} (drops dirt)')
        seen = wait_until([bob], lambda: bob.js('() => game.entities.items.filter(i => !i.removed && i.stack.id === 3).length') > 0, 4)
        check('a dropped item is visible to a friend', seen)
        before = {p.name: p.js('() => game.playerInventory.count ? game.playerInventory.count(3) : game.playerInventory.serialize().filter(r => r[0] === 3).reduce((s, r) => s + r[1], 0)') for p in (alice, bob)}
        bob.js('([x,y,z]) => { game.player.setPosition(x, game.player.y, z); }', drop)
        time.sleep(2)
        after = {p.name: p.js('() => game.playerInventory.serialize().filter(r => r[0] === 3).reduce((s, r) => s + r[1], 0)') for p in (alice, bob)}
        info('drop pickup', f'cobblestone before {before} after {after} (Bob walked onto Alice\'s drop)')
        check('the friend who walks onto a drop picks it up', after['Bobby'] >= 1, after)

        # ---------------------------------------------------------------- mobs at night
        alice.chat('/time set midnight')
        print('      (night: 45 s for mobs)', flush=True)
        hp0 = {p.name: p.js('() => game.stats.health') for p in (alice, bob)}
        t_end = time.time() + 45
        while time.time() < t_end:
            for p in (alice, bob, carol):
                p.front()
                p.respawn_if_dead(); p.js("() => { game.input.locked = true; game.state = 'playing'; }")
            time.sleep(1)
        mob_sets = [set(p.js('() => game.entities.mobs.filter(m => !m.removed && !m.dead && Math.hypot(m.x - game.player.x, m.z - game.player.z) < 40).map(m => m.netId)')) for p in (alice, bob)]
        kinds = alice.js('() => game.entities.mobs.filter(m => !m.removed).map(m => m.type.kind).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {})')
        info('mobs Alice sees at midnight', kinds)
        shared = len(mob_sets[0] & mob_sets[1])
        check('Alice and Bob see the same mobs (net ids within 40 blocks)', shared >= min(len(mob_sets[0]), len(mob_sets[1])) - 2 and shared > 0, f'{len(mob_sets[0])}/{len(mob_sets[1])} shared {shared}')
        hp1 = {p.name: p.js('() => game.stats.health') for p in (alice, bob)}
        info('health after 45 s of night standing still', f'{hp0} → {hp1}')
        alice.shot('night')
        bob.shot('night')

        # Fight: Alice swings at the nearest hostile from up close (attack through the interaction path).
        target = alice.js('''() => { const p = game.player; const hostile = ['zombie','skeleton','spider','creeper'];
          const m = game.entities.mobs.filter(m => !m.removed && !m.dead && hostile.includes(m.type.kind) && Math.abs(m.y - p.y) < 3)
            .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
          return m ? { id: m.netId, kind: m.type.kind, d: Math.hypot(m.x - p.x, m.z - p.z) } : null; }''')
        info('nearest hostile for the fight', target)
        if target:
            for _ in range(60):
                alive = alice.js('(id) => { const m = game.entities.mobs.find(m => m.netId === id && !m.removed); if (!m || m.dead) return false; '
                                 'const p = game.player; const d = Math.hypot(m.x - p.x, m.z - p.z); if (d > 2.5) { const k = Math.min(1.2, d - 2) / d; '
                                 'p.setPosition(p.x + (m.x - p.x) * k, m.y, p.z + (m.z - p.z) * k); return true; } game.net.sendAttack(id); return true; }', target['id'])
                if not alive:
                    break
                alice.front()
                time.sleep(0.7)
            dead_for_bob = bob.js('(id) => { const m = game.entities.mobs.find(m => m.netId === id); return !m || m.removed || m.dead; }', target['id'])
            check(f'Alice kills the {target["kind"]} and Bob sees it die', not alive and dead_for_bob)
        alice.chat('/time set day')

        # ---------------------------------------------------------------- interpolation smoothness
        # Bob walks forward; Carol samples his remote position every animation frame for 3 s.
        bob.js("() => { game.input.locked = true; game.state = 'playing'; game.input.down.add('KeyW'); }")
        carol.front()
        samples = carol.js('''(id) => new Promise((res) => { const out = []; const t0 = performance.now();
          const r = game.remote.list.find(r => r.name === 'Bobby');
          const tick = () => { out.push([performance.now(), r.mob.x, r.mob.z]); if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(out); };
          requestAnimationFrame(tick); })''', 0)
        bob.js("() => game.input.down.delete('KeyW')")
        speeds = []
        for (t1, x1, z1), (t2, x2, z2) in zip(samples, samples[1:]):
            if t2 > t1:
                speeds.append(((x2 - x1) ** 2 + (z2 - z1) ** 2) ** 0.5 / ((t2 - t1) / 1000))
        moving = [s for s in speeds if s > 0.5]
        if moving:
            mean = sum(moving) / len(moving)
            var = (sum((s - mean) ** 2 for s in moving) / len(moving)) ** 0.5
            stalls = sum(1 for s in speeds if s < 0.2) if speeds else 0
            info('remote player interpolation (Carol watching Bob walk)', f'{len(samples)} frames, speed mean {mean:.2f} b/s, stdev {var:.2f}, {stalls} frames without movement')
            check('a walking friend moves smoothly (speed stdev < 25 % of mean)', var < mean * 0.25, f'{var / mean * 100:.0f} %')
        else:
            check('a walking friend moves for the others', False, f'{len(samples)} samples, no movement')

        # ---------------------------------------------------------------- reconnect keeps the inventory
        inv_before = bob.js('() => JSON.stringify(game.playerInventory.serialize().filter(r => r[0]))')
        bob.js('() => game.pause()')
        time.sleep(0.4)
        bob.click('Disconnect')
        time.sleep(1.5)
        bob.shot('after-disconnect')
        txt = bob.menu_text()
        recent = 'Recent Games' in txt
        info('screen after Disconnect', txt[:160].replace('\n', ' | '))
        if 'Multiplayer' in txt and not recent:
            bob.click('Multiplayer')
            time.sleep(0.6)
            recent = 'Recent Games' in bob.menu_text()
        check('Recent Games lists the game after leaving', recent)
        if recent:
            bob.page.get_by_role('button', name=f'({code[:3]}-{code[3:]})', exact=False).first.click()
            bob.wait_playing()
            time.sleep(1.5)
            inv_after = bob.js('() => JSON.stringify(game.playerInventory.serialize().filter(r => r[0]))')
            check('inventory comes back after rejoining', inv_before == inv_after, f'{inv_before} vs {inv_after}')
            corrected = any('corrected' in l for l in bob.chat_log())
            check('no "The server corrected your inventory" during normal play', not corrected, [l for l in bob.chat_log() if 'corrected' in l])

        # ---------------------------------------------------------------- moderation
        time.sleep(1.1)
        alice.chat('/kick Carol be nice')
        ok = wait_until([carol], lambda: 'be nice' in carol.menu_text(), 5)
        carol.shot('kicked')
        check('a kicked friend sees the reason', ok, carol.menu_text()[:120].replace('\n', ' | '))

        # ---------------------------------------------------------------- locked game, typo in the password
        dave = Player(browser, 'Dave')
        alice2 = bob  # Bob makes a locked, listed game
        bob.js('() => game.pause()'); time.sleep(0.3)
        bob.click('Disconnect'); time.sleep(1)
        if 'Multiplayer' in bob.menu_text() and 'Create Game' not in bob.menu_text():
            bob.click('Multiplayer'); time.sleep(0.5)
        bob.page.get_by_placeholder('Your name (3–16 letters)').fill('Bobby')
        bob.click('Create Game')
        bob.page.get_by_placeholder('Optional password').fill('geheim')
        bob.page.get_by_role('button', name='Show in Server List: No').click()
        bob.click('Create and Play')
        bob.wait_playing()
        locked_code = bob.js('() => game.roomCode')
        dave.open_title()
        dave.click('Multiplayer')
        dave.page.get_by_placeholder('Your name (3–16 letters)').fill('Dave')
        dave.click('Browse Games')
        time.sleep(1)
        dave.shot('browse')
        listing = dave.menu_text()
        check('Browse Games shows the listed locked game', "Bobby's Game" in listing, listing[:200].replace('\n', ' | '))
        dave.page.get_by_role('button', name="Bobby's Game", exact=False).first.click()
        time.sleep(0.6)
        asked = 'Password Required' in dave.menu_text()
        check('joining a locked game asks for the password', asked)
        if asked:
            dave.page.get_by_placeholder('Password').fill('gehiem')  # typo
            dave.click('Join Game')
            time.sleep(2)
            dave.shot('wrong-password')
            first = dave.menu_text()
            check('a wrong password gives a clear message', 'Wrong password' in first, first[:120].replace('\n', ' | '))
            # Try again like a person would: back to the list, click the game again.
            for label in ('Back to Title Screen', 'Back to Title', 'Back'):
                if dave.page.get_by_role('button', name=label, exact=True).count():
                    dave.click(label); break
            time.sleep(0.4)
            if 'Browse Games' not in dave.menu_text():
                dave.click('Multiplayer'); time.sleep(0.5)
                dave.page.get_by_placeholder('Your name (3–16 letters)').fill('Dave')
            dave.click('Browse Games'); time.sleep(1)
            dave.page.get_by_role('button', name="Bobby's Game", exact=False).first.click()
            time.sleep(2)
            second = dave.menu_text()
            dave.shot('retry-password')
            check('after a typo the game asks for the password again (instead of reusing the wrong one)', 'Password Required' in second, second[:160].replace('\n', ' | '))

        # ---------------------------------------------------------------- server restart
        port, data = os.environ.get('QA_SERVER_PORT'), os.environ.get('QA_DATA_DIR')
        if port and data:
            pid = int(subprocess.check_output(['lsof', '-tiTCP:' + port, '-sTCP:LISTEN']).split()[0])
            os.kill(pid, signal.SIGTERM)  # the game server process itself (never anything else)
            time.sleep(1.5)
            alice.shot('restart-1')
            msg = alice.menu_text()
            check('server restart: players see a reconnecting message', 'Reconnecting' in msg or 'restarting' in msg.lower(), msg[:120].replace('\n', ' | '))
            env = dict(os.environ, PORT=port, DATA_DIR=data, ROOM_CREATE_LIMIT='1000', MAX_CONN_PER_IP='100', LOG_FORMAT='text')
            repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            subprocess.Popen(['npx', 'tsx', 'server/index.ts'], cwd=repo, env=env,
                             stdout=open(os.path.join(os.path.dirname(data), 'server-restarted.log'), 'a'), stderr=subprocess.STDOUT)
            back = wait_until([alice], lambda: alice.js('() => game.state') in ('playing', 'paused'), 30, 0.5)
            check('server restart: the client rejoins by itself', back, alice.js('() => game.state'))

        for p in (alice, bob, carol, dave):
            errs = [e for e in p.errors if 'favicon' not in e]
            if errs:
                info(f'console errors for {p.name}', errs[:5])
        browser.close()
    fails = sum(1 for r in results if r[0] == 'FAIL')
    print(f"\n{sum(1 for r in results if r[0] == 'PASS')} passed, {fails} failed")
    with open(f'{SHOTS}/results.json', 'w') as f:
        json.dump(results, f, indent=1)


if __name__ == '__main__':
    main()
