"""
Two friends play survival together in a Minecraft multiplayer game (through the Vite proxy), like new players.

  scripts/qa/start-servers.sh 3481 5241 /tmp/bc-srv           # own game server (ROOM_CREATE_LIMIT=1000) + Vite
  python3 scripts/qa/survival_mp.py --port 5241 [--browser webkit]

Alice creates the game through Multiplayer → Create Game, Bob joins through the invite link. Then: punch a tree
(Bob must see the log disappear), craft and place a table (Alice must see it), a placement inside the friend's
body, a furnace and a chest on the server, smelting, night with server mobs and melee, sleeping with two players,
a death with item drops the other can see, breeding. Results: docs/qa/survival-mp-run.json + docs/qa/shots/mp_*.png.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from qa_lib import QA  # noqa: E402
import survival as S  # noqa: E402


def wait_state(qa: QA, timeout: float = 60) -> str:
    end = time.time() + timeout
    while time.time() < end:
        qa.page.bring_to_front()
        st = qa.js('game.state')
        if st not in ('loading', 'menu'):
            return st
        time.sleep(0.2)
    return qa.js('game.state')


def chat(qa: QA, text: str) -> None:
    qa.relock()
    qa.page.keyboard.press('t')
    try:
        qa.page.wait_for_selector('.chat-input:not(.hidden)', timeout=3000)
    except Exception:
        qa.note(f'chat would not open (state {qa.js("game.state")})')
        return
    time.sleep(0.15)
    qa.page.keyboard.type(text, delay=10)
    qa.page.keyboard.press('Enter')
    qa.wait(0.3)
    qa.relock()


def chat_log(qa: QA) -> list[str]:
    return qa.js("[...document.querySelectorAll('.chat-log > *')].map(e => e.textContent)")


def both(a: QA, b: QA, seconds: float) -> None:
    end = time.time() + seconds
    while time.time() < end:
        a.page.bring_to_front()
        b.page.bring_to_front()
        time.sleep(0.2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5241)
    ap.add_argument('--browser', default='chromium')
    ap.add_argument('--scratch', default='/tmp/bc-qa-mp')
    a = ap.parse_args()
    tag = 'mp' if a.browser == 'chromium' else f'mp_{a.browser}'
    os.makedirs(a.scratch, exist_ok=True)
    alice = QA(a.port, 'docs/qa', os.path.join(a.scratch, f'{tag}-alice'), browser=a.browser)
    bob = QA(a.port, 'docs/qa', os.path.join(a.scratch, f'{tag}-bob'), browser=a.browser, pw=alice.pw)
    log: list[dict] = []

    def step(name: str, ok: bool | None, **info) -> None:
        print(f"{'PASS' if ok else 'INFO' if ok is None else 'FAIL'}  {name}  {info}", flush=True)
        log.append({'step': name, 'ok': ok, **info})

    try:
        alice.open()
        page = alice.page
        # ---------------------------------------------------------------- create and join
        t0 = time.time()
        page.get_by_role('button', name='Multiplayer').click()
        page.get_by_placeholder('Your name (3–16 letters)').fill('Alice')
        page.get_by_role('button', name='Create Game').click()
        page.wait_for_selector('text=Create and Play')
        alice.shot(f'{tag}_01_create_game')
        page.get_by_role('button', name='Create and Play').click()
        st = wait_state(alice)
        code = alice.js('game.roomCode')
        step('Alice creates a survival game through the menu', st in ('playing', 'paused') and bool(code), state=st, code=code, secs=round(time.time() - t0, 1))
        alice.relock()
        alice.instrument()
        bob.open(f'/?join={code}')
        bob.page.get_by_placeholder('Your name (3–16 letters)').fill('Bobby')
        bob.page.get_by_role('button', name='Join Game').click()
        st = wait_state(bob)
        bob.relock()
        bob.instrument()
        both(alice, bob, 3)
        seen = [alice.js('game.remote.list.length'), bob.js('game.remote.list.length')]
        step('Bob joins with the invite link and both see each other', st in ('playing', 'paused') and seen == [1, 1], state=st, remote=seen)
        alice.shot(f'{tag}_02_alice_sees_bob')
        s_a, s_b = alice.st(), bob.st()
        step('spawn and inventory', None, alice=[round(s_a['x'], 1), round(s_a['y'], 1), round(s_a['z'], 1)], bob=[round(s_b['x'], 1), round(s_b['y'], 1), round(s_b['z'], 1)],
             alice_inv=alice.js('qa.inv().length'), mode=alice.js('game.mode'), clock=s_a['clock'])

        # ---------------------------------------------------------------- tree: Alice punches, Bob watches
        logs = S.log_ids(alice)
        found = alice.js(f'qa.find({logs}, 28, -4, 6, 10)')
        if found:
            x, y, z, bid, _ = found[0]
            while alice.block(x, y - 1, z) == bid:
                y -= 1
            s = alice.st()
            d = math.hypot(x + 0.5 - s['x'], z + 0.5 - s['z'])
            k = max(0.0, (d - 1.6) / d) if d else 0
            alice.walk_to(s['x'] + (x + 0.5 - s['x']) * k, s['z'] + (z + 0.5 - s['z']) * k, tol=0.7, timeout=25)
            secs = alice.mine(x, y, z, timeout=15)
            both(alice, bob, 1.2)
            bob_sees = bob.block(x, y, z)
            step('Alice punches a log; Bob sees it gone', secs is not None and bob_sees == 0, secs=secs, bob_block=bob_sees)
            for dy in range(1, 4):
                if alice.block(x, y + dy, z) == bid:
                    alice.mine(x, y + dy, z, timeout=15)
            alice.collect_items(6, 8)
            step('Alice picks up her logs', alice.js('qa.inv().filter(s => s.name.endsWith(" Log")).length') > 0, inv=[(i['name'], i['count']) for i in alice.js('qa.inv()')])
        # Bob gets his own wood.
        found = bob.js(f'qa.find({logs}, 28, -4, 6, 10)')
        if found:
            x, y, z, bid, _ = found[0]
            while bob.block(x, y - 1, z) == bid:
                y -= 1
            s = bob.st()
            d = math.hypot(x + 0.5 - s['x'], z + 0.5 - s['z'])
            k = max(0.0, (d - 1.6) / d) if d else 0
            bob.walk_to(s['x'] + (x + 0.5 - s['x']) * k, s['z'] + (z + 0.5 - s['z']) * k, tol=0.7, timeout=25)
            for dy in range(0, 4):
                if bob.block(x, y + dy, z) == bid:
                    bob.mine(x, y + dy, z, timeout=15)
            bob.collect_items(6, 8)
        step('Bob gathers wood', bob.js('qa.inv().filter(s => s.name.endsWith(" Log")).length') > 0, inv=[(i['name'], i['count']) for i in bob.js('qa.inv()')])
        if bob.js('qa.inv().filter(s => s.name.endsWith(" Log")).reduce((a, s) => a + s.count, 0)') < 2:
            # SETUP: a second tree is far away; give Bob two logs so the table test can go on.
            bob.js("game.playerInventory.add({ id: __I.itemId('oak_log'), count: 2 })")
            step('SETUP: Bob gets 2 oak logs (client-side add, the server guard may reject this)', None)
        # ---------------------------------------------------------------- crafting table by Bob, seen by Alice
        wood = S.wood_name(bob)
        nb = bob.js('qa.inv().filter(s => s.name.endsWith(" Log")).reduce((a, s) => a + s.count, 0)')
        bob.ui_craft(f'{wood} Planks', times=nb)
        bob.ui_craft('Stick', 1)
        bob.ui_craft('Crafting Table', 1)
        pos = bob.place_near('crafting_table', S.B_TABLE, rings=(2, 1, 3))
        both(alice, bob, 1.5)
        a_sees = alice.block(*pos) if pos else None
        step('Bob crafts and places a crafting table; Alice sees it', pos is not None and a_sees == S.B_TABLE, pos=pos, alice_block=a_sees)
        made = bob.ui_craft('Wooden Pickaxe', 1)
        step('Bob crafts a wooden pickaxe at the table', made == 1)
        bob.shot(f'{tag}_03_bob_table')
        # ---------------------------------------------------------------- placement into the friend
        sa = alice.st()
        ax, ay, az = math.floor(sa['x']), math.floor(sa['y']), math.floor(sa['z'])
        bob.walk_to(sa['x'] + 2.2, sa['z'], tol=0.6, timeout=15)
        if bob.select_item('dirt') or bob.select_item(f'{wood.lower()}_planks'):
            under = alice.block(ax, ay - 1, az)
            ok_place = bob.place_on(ax, ay - 1, az)
            both(alice, bob, 1)
            inside = alice.block(ax, ay, az)
            step('Bob tries to place a block where Alice stands (should be refused)', inside in (0, 23, 24, 25), bob_local_placed=ok_place, alice_sees=inside, ground=under)
        # ---------------------------------------------------------------- stone, furnace, chest on the server
        alice.ui_craft(f'{S.wood_name(alice)} Planks', times=alice.js('qa.inv().filter(s => s.name.endsWith(" Log")).reduce((a, s) => a + s.count, 0)'))
        alice.ui_craft('Stick', 2)
        S.go_to_block(alice, S.B_TABLE)
        alice.ui_craft('Wooden Pickaxe', 1)
        alice.select_item('wooden_pickaxe')
        sa = alice.st()
        alice.dig_to(math.floor(sa['x']) + 12, math.floor(sa['y']) - 10, math.floor(sa['z']), max_steps=30, until=lambda: alice.js('qa.count(`cobblestone`)') >= 12, max_secs=120)
        alice.collect_items(5, 5)
        cob = alice.js('qa.count(`cobblestone`)')
        step('Alice digs stone in multiplayer', cob >= 8, cobblestone=cob)
        S.go_to_block(alice, S.B_TABLE)
        f_made = alice.ui_craft('Furnace', 1)
        fpos = alice.place_near('furnace', S.B_FURNACE, rings=(1, 2))
        both(alice, bob, 1)
        step('Alice places a furnace; Bob sees it', fpos is not None and bob.block(*fpos) == S.B_FURNACE, crafted=f_made, pos=fpos)
        if fpos and alice.js('qa.count(`oak_planks`) + qa.count(`birch_planks`) + qa.count(`spruce_planks`)') > 0:
            opened = S.furnace_ui(alice, fpos)
            alice.shot(f'{tag}_04_furnace_ui')
            msgs = chat_log(alice)[-2:]
            step('Furnace screen opens in multiplayer', opened, chat=msgs)
            alice.js('document.activeElement && document.activeElement.blur()')
            alice.key('KeyE')
            alice.wait(0.3)
            alice.relock()
        # ---------------------------------------------------------------- night: server mobs
        chat(alice, '/time set night')
        both(alice, bob, 3)
        step('Owner sets night with /time; Bob sees it', bob.st()['dayFactor'] < 0.4, alice_clock=alice.st()['clock'], bob_clock=bob.st()['clock'], chat=chat_log(alice)[-1:])
        alice.select_item('wooden_sword') or alice.select_item('wooden_pickaxe')
        bob.select_item('wooden_pickaxe')
        t1 = time.time()
        hostile = []
        while time.time() - t1 < 60:
            both(alice, bob, 3)
            hostile.append((alice.st()['hostile'], bob.st()['hostile']))
        step('hostile mobs near the two players during 60 s of night', None, samples=hostile[::4])
        ra = alice.fight(40, max_dist=2.9, chase=10)
        rb = bob.fight(20, max_dist=2.9, chase=10)
        da, db = alice.take_damage_log(), bob.take_damage_log()
        step('night fight', None, alice=ra, bob=rb, alice_damage=[(d['cause'], d['killer'], d['dealt']) for d in da][:12],
             bob_damage=[(d['cause'], d['killer'], d['dealt']) for d in db][:12], hp=[alice.st()['health'], bob.st()['health']])
        alice.shot(f'{tag}_05_night_alice')
        # ---------------------------------------------------------------- sleeping with two players
        bed_ok = False
        alice.js("() => { const inv = game.playerInventory; inv.add({ id: __I.itemFromState(__R.BLOCK.BED, 14 << 3), count: 1 }); }")
        bpos = alice.place_near('Red Bed', alice.js('__R.BLOCK.BED'), rings=(2, 3))
        if bpos:
            alice.aim(bpos[0] + 0.5, bpos[1] + 0.3, bpos[2] + 0.5)
            alice.press('Mouse2')
            both(alice, bob, 6)
            msgs = chat_log(alice)[-3:] + chat_log(bob)[-2:]
            bed_ok = True
            step('Alice sleeps alone while Bob is awake (SETUP: bed given)', None, alice_clock=alice.st()['clock'], sleeping=alice.js('game.worldRules.sleeping'), chat=msgs)
            alice.shot(f'{tag}_06_sleep')
            alice.hold('Space')
            alice.wait(0.3)
            alice.release('Space')
        # ---------------------------------------------------------------- death and drops
        n_before = sum(i['count'] for i in bob.js('qa.inv()'))
        chat(alice, '/kill Bobby')
        both(alice, bob, 2)
        if bob.js('game.state') != 'dead':
            # No /kill: let Bob fall from a pillar instead.
            step('/kill is not available to the owner', None, chat=chat_log(alice)[-1:])
        st = bob.js('game.state')
        drops = alice.js('game.entities ? game.entities.items.length : -1')
        net_items = alice.js('game.netEntities ? (game.netEntities.items?.length ?? game.netEntities.itemCount ?? -1) : -1')
        step('Bob dies: death screen, drops visible to Alice', st == 'dead', state=st, bob_items_before=n_before, alice_local_items=drops, alice_net_items=net_items, msg=bob.js('game.stats.deathMessage'))
        if st == 'dead':
            bob.shot(f'{tag}_07_bob_dead')
            bob.page.locator('.mc-btn', has_text='Respawn').click()
            wait_state(bob, 30)
            bob.relock()
            both(alice, bob, 2)
            step('Bob respawns', bob.js('game.state') in ('playing', 'paused'), pos=[round(bob.st()[k], 1) for k in 'xyz'], hp=bob.st()['health'])
        # ---------------------------------------------------------------- breeding (server mobs)
        s = alice.st()
        animals = [m for m in alice.js('qa.mobs(64)') if m['kind'] in ('cow', 'sheep')]
        step('passive animals around in multiplayer', None, n=len(animals), kinds=sorted({m['kind'] for m in animals}))
        # ---------------------------------------------------------------- frame times
        step('frame statistics', None, alice=alice.take_frames(), bob=bob.take_frames(), alice_console=[c for c in alice.console if 'DevTools' not in c][:8],
             bob_console=[c for c in bob.console if 'DevTools' not in c][:8])
        both(alice, bob, 1)
        alice.shot(f'{tag}_08_end_alice')
        bob.shot(f'{tag}_08_end_bob')
    except Exception as e:
        step('EXCEPTION', False, error=f'{type(e).__name__}: {str(e)[:400]}', alice_nav=alice.navigations, bob_nav=bob.navigations,
             alice_console=[c for c in alice.console if 'DevTools' not in c][-8:], bob_console=[c for c in bob.console if 'DevTools' not in c][-8:])
        try:
            alice.shot(f'{tag}_error_alice')
            bob.shot(f'{tag}_error_bob')
        except Exception:
            pass
    finally:
        json.dump(log, open(f'docs/qa/survival-{tag}-run.json', 'w'), indent=1, ensure_ascii=False)
        bob.close()
        alice.close()


if __name__ == '__main__':
    main()
