"""
Focused survival scenarios with a small, logged setup (items given, a mob spawned next to the player, the clock moved),
then the mechanic itself through the real input: eating, killing a cow, breeding, armor, zombie damage with and
without armor, bed and sleeping, redstone (lever → door, lever → dust → lamp), enchanting, a fall death with item
recovery, creative flight. Complements survival.py, whose bot dies a lot in the later, riskier phases.

  python3 scripts/qa/scenarios.py --port 5241 [--browser webkit]
Results: docs/qa/scenarios-run.json, screenshots docs/qa/shots/sc_*.png.
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

RESULTS: list[dict] = []


def result(name: str, ok, setup: str, **info) -> None:
    print(f"{'PASS' if ok else 'INFO' if ok is None else 'FAIL'}  {name}  {info}", flush=True)
    RESULTS.append({'name': name, 'ok': ok, 'setup': setup, **info})


def give(qa: QA, *items) -> None:
    qa.js('(kit) => { for (const [n, c] of kit) game.playerInventory.add({ id: __I.itemId(n), count: c }); }', [list(i) for i in items])


def clear_inv(qa: QA) -> None:
    qa.js('game.playerInventory.clear(); for (let k = 0; k < 4; k++) game.playerInventory.setArmor(k, { id: 0, count: 0 });')


def spawn_next(qa: QA, kind: str, dist: float = 2.0, yaw_off: float = 0.0) -> None:
    """Spawn a mob a few blocks in front of the player, on the ground (setup)."""
    qa.js("""([kind, d, off]) => {
      const p = game.player, yaw = p.yaw + off;
      const x = p.x - Math.sin(yaw) * d, z = p.z - Math.cos(yaw) * d;
      const y = game.world.surfaceY(Math.floor(x), Math.floor(z)) + 1;
      return game.entities.spawnMob(kind, x, y, z) && true;
    }""", [kind, dist, yaw_off])


def nearest(qa: QA, kind: str, r: float = 8):
    m = [x for x in qa.js(f'qa.mobs({r})') if x['kind'] == kind]
    return m[0] if m else None


def hit_until_dead(qa: QA, kind: str, timeout: float = 20, interval: float = 0.7) -> dict:
    t0 = time.time()
    swings = 0
    hp = []
    while time.time() - t0 < timeout:
        m = nearest(qa, kind, 6)
        if not m:
            break
        hp.append(round(m['h'], 1))
        qa.aim(m['x'], m['y'] + S.QA.MOB_HEIGHT.get(kind, 1.0) * 0.6, m['z'], tries=2)
        if m['d'] > 2.8:
            qa.hold('KeyW')
            qa.wait(0.2)
            qa.release('KeyW')
            continue
        qa.press('Mouse0')
        swings += 1
        qa.wait(interval)
    return {'swings': swings, 'hp_trace': hp, 'secs': round(time.time() - t0, 1), 'dead': nearest(qa, kind, 6) is None}


def flat_spot(qa: QA) -> None:
    """Clear a 9×9 flat stone floor around the player (setup) so the scenarios are not about terrain."""
    qa.js("""() => {
      const p = game.player, w = game.world, x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = Math.floor(p.y);
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        w.setBlock(x0 + dx, y0 - 1, z0 + dz, 1);
        for (let dy = 0; dy < 5; dy++) w.setBlock(x0 + dx, y0 + dy, z0 + dz, 0);
      }
    }""")
    qa.wait(0.5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5241)
    ap.add_argument('--browser', default='chromium')
    ap.add_argument('--profile', default='/tmp/bc-qa-scen')
    a = ap.parse_args()
    tag = '' if a.browser == 'chromium' else f'{a.browser}_'
    qa = QA(a.port, 'docs/qa', a.profile, browser=a.browser)
    qa.shot_prefix = f'sc_{tag}'
    try:
        qa.open()
        S.WORLD = f'QA Scenarios {a.browser}'
        S.phase_create(qa)
        qa.end()
        info = qa.js('({ gpu: game.gpuName, ua: navigator.userAgent })')
        result('browser', None, '', **info)
        flat_spot(qa)
        qa.wait(1)
        s = qa.st()
        result('frame time on a flat spot', None, '', fps=s['fps'], cpu_ms=round(s['frameMs'], 2), worst_ms=s['worstMs'])

        # ---- eating
        give(qa, ('beef', 2))
        qa.js('game.stats.hunger = 12; game.stats.saturation = 0')
        qa.select_item('beef')
        qa.look(0, -300)
        h0 = qa.st()['hunger']
        qa.hold('Mouse2')
        t0 = time.time()
        while time.time() - t0 < 4 and qa.st()['hunger'] == h0:
            qa.wait(0.05)
        qa.release('Mouse2')
        h1 = qa.st()
        result('eat raw beef (hold right mouse)', h1['hunger'] == h0 + 3, 'beef given, hunger set to 12',
               secs=round(time.time() - t0, 2), hunger=[h0, h1['hunger']], sat=round(h1['sat'], 1), minecraft='1.6 s, +3 hunger, +1.8 saturation')

        # ---- kill a cow with a stone sword: hits, drops, XP
        give(qa, ('stone_sword', 1))
        qa.select_item('stone_sword')
        spawn_next(qa, 'cow', 2.2)
        qa.wait(0.6)
        lvl0 = qa.js('game.stats.xp.points ?? game.stats.xp.total ?? 0')
        r = hit_until_dead(qa, 'cow')
        qa.wait(1.2)
        qa.collect_items(5, 5)
        qa.wait(1)
        result('kill a cow with a stone sword', r['dead'], 'cow spawned 2 blocks in front', **r,
               drops=[(i['name'], i['count']) for i in qa.js('qa.inv()') if i['name'] in ('Raw Beef', 'Leather')],
               xp=[lvl0, qa.js('game.stats.xp.points ?? game.stats.xp.total ?? 0')], minecraft='stone sword 5 dmg, cow 10 hp: 2 hits; 1-3 beef, 0-2 leather, 1-3 xp')

        # ---- breeding cows with wheat
        give(qa, ('wheat', 4))
        spawn_next(qa, 'cow', 2.0, -0.4)
        spawn_next(qa, 'cow', 2.0, 0.4)
        qa.wait(0.8)
        qa.select_item('wheat')
        fed = 0
        for m in [x for x in qa.js('qa.mobs(5)') if x['kind'] == 'cow'][:2]:
            n0 = qa.js('qa.count(`wheat`)')
            qa.aim(m['x'], m['y'] + 0.9, m['z'], tries=3)
            qa.press('Mouse2')
            qa.wait(0.3)
            fed += qa.js('qa.count(`wheat`)') < n0
        qa.wait(6)
        babies = qa.js('game.entities.mobs.filter(m => m.type.kind === "cow" && !m.dead && (m.baby || m.age < 0 || m.growingAge < 0 || m.scale < 1)).length')
        qa.shot('breeding')
        result('breed two cows with wheat', fed == 2 and babies > 0, 'two cows spawned in front, 4 wheat given', fed=fed, babies=babies)

        # ---- armor: right click into the sky
        give(qa, ('iron_chestplate', 1), ('iron_helmet', 1), ('iron_leggings', 1), ('iron_boots', 1))
        qa.look(0, -900)  # straight up: no block targeted
        worn = []
        for piece in ('iron_chestplate', 'iron_helmet', 'iron_leggings', 'iron_boots'):
            qa.select_item(piece)
            qa.press('Mouse2')
            qa.wait(0.2)
            if qa.js('(n) => qa.count(n)', piece) == 0:
                worn.append(piece)
        armor = qa.st()['armor']
        qa.look(0, 900)
        qa.shot('armor_hud')
        result('wear iron armor with a right click while looking at the sky', len(worn) == 4, 'four iron pieces given', worn=worn, armor=armor, minecraft='15 armor points')

        # ---- zombie damage with full iron vs without
        def zombie_hits(n: int) -> list:
            qa.take_damage_log()
            qa.js("game.stats.health = 20")
            spawn_next(qa, 'zombie', 1.5)
            t0 = time.time()
            while time.time() - t0 < 12 and len([d for d in qa.js('window.__qaLog.damage') if d['cause'] == 'mob']) < n:
                qa.wait(0.25)
            d = [x for x in qa.take_damage_log() if x['cause'] == 'mob']
            qa.js('game.entities.mobs.filter(m => m.type.kind === "zombie").forEach(m => { m.health = 0; })')
            qa.wait(1.2)
            return [x['dealt'] for x in d]
        qa.js('(t) => { game.cycle.time = t; game.cycle.compute(); }', 0.6)
        with_armor = zombie_hits(3)
        qa.js('for (let k = 0; k < 4; k++) game.playerInventory.setArmor(k, { id: 0, count: 0 })')
        no_armor = zombie_hits(3)
        diff = qa.js('game.stats.difficulty ?? game.worldRules?.difficulty')
        result('zombie damage per hit: full iron vs none', None, 'night, zombie spawned 1.5 blocks away', difficulty=diff, iron=with_armor, none=no_armor,
               minecraft='Normal: 3 per hit; full iron (15 points): 3 × (1 − 13.5/25) = 1.38')

        # ---- bed: day click, night with a zombie next to it, night alone
        clear_inv(qa)
        give(qa, ('white_bed', 1)) if qa.js('(() => { try { __I.itemId("white_bed"); return true; } catch { return false; } })()') else qa.js('game.playerInventory.add({ id: __I.itemFromState(__R.BLOCK.BED, 0), count: 1 })')
        qa.js('(t) => { game.cycle.time = t; game.cycle.compute(); }', 0.2)
        bed = qa.place_near('White Bed', qa.js('__R.BLOCK.BED'), rings=(2, 3))
        msgs = []
        if bed:
            def click_bed():
                qa.aim(bed[0] + 0.5, bed[1] + 0.3, bed[2] + 0.5)
                qa.press('Mouse2')
                qa.wait(0.6)
                return qa.js("[...document.querySelectorAll('.chat-log > *')].slice(-1).map(e => e.textContent)[0] || ''")
            msgs.append(('day', click_bed()))
            qa.js('(t) => { game.cycle.time = t; game.cycle.compute(); }', 0.62)
            spawn_next(qa, 'zombie', 3.0, 1.2)
            qa.wait(0.3)
            msgs.append(('night+zombie', click_bed()))
            qa.js('game.entities.mobs.filter(m => m.type.hostile).forEach(m => { m.health = 0; })')
            qa.wait(1.5)
            c0 = qa.st()['clock']
            msgs.append(('night', click_bed()))
            qa.shot('sleeping')
            qa.wait(6)
            s1 = qa.st()
            result('bed: day message, monsters nearby, sleep through the night', s1['time'] < 0.1, 'bed given, clock moved, zombie spawned',
                   messages=msgs, clock=[c0, s1['clock']], day=s1['day'] + 1, spawn=qa.js('game.worldRules.bed'))
        else:
            result('bed placed', False, 'bed given')

        # ---- redstone: lever → door, lever → dust → lamp
        clear_inv(qa)
        give(qa, ('lever', 2), ('oak_door', 1), ('redstone', 8), ('redstone_lamp', 1))
        door = qa.place_near('Oak Door', qa.js('__R.BLOCK.DOOR'), rings=(2,))
        if door:
            lever = None
            qa.select_item('lever')
            for ox, oz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                gx, gz = door[0] + ox, door[2] + oz
                if qa.block(gx, door[1], gz) == 0 and qa.place_on(gx, door[1] - 1, gz) and qa.block(gx, door[1], gz) == qa.js('__R.BLOCK.LEVER'):
                    lever = (gx, door[1], gz)
                    break
            m0 = qa.js('([x, y, z]) => game.world.getMeta(x, y, z)', list(door))
            if lever:
                qa.aim(lever[0] + 0.5, lever[1] + 0.15, lever[2] + 0.5)
                qa.press('Mouse2')
                qa.wait(0.5)
            m1 = qa.js('([x, y, z]) => game.world.getMeta(x, y, z)', list(door))
            qa.shot('lever_door')
            result('lever next to a door opens it', lever is not None and m1 != m0, 'lever + oak door given', lever=lever, door_meta=[m0, m1])
        lamp = qa.place_near('redstone_lamp', None, rings=(3,))
        wire_ok = None
        if lamp:
            # Dust from the lamp towards the player, lever at the end.
            p = qa.cell()
            dx = (p[0] > lamp[0]) - (p[0] < lamp[0])
            dz = 0 if dx else (p[2] > lamp[2]) - (p[2] < lamp[2])
            cells = [(lamp[0] + dx * k, lamp[1], lamp[2] + dz * k) for k in (1, 2)]
            qa.select_item('redstone')
            for c in cells:
                qa.place_on(c[0], c[1] - 1, c[2])
            lev = (lamp[0] + dx * 3, lamp[1], lamp[2] + dz * 3)
            qa.select_item('lever')
            qa.place_on(lev[0], lev[1] - 1, lev[2])
            qa.aim(lev[0] + 0.5, lev[1] + 0.15, lev[2] + 0.5)
            qa.press('Mouse2')
            qa.wait(0.6)
            lit = qa.block(*lamp) == qa.js('__R.BLOCK.REDSTONE_LAMP_LIT')
            light = qa.js('([x, y, z]) => game.world.getLight(x, y + 1, z) & 15', list(lamp))
            qa.shot('lamp')
            result('lever → 2 redstone dust → lamp lights up', lit, 'lever, dust and lamp given',
                   wire=[qa.block(*c) for c in cells], lever=qa.block(*lev), lamp_lit=lit, block_light_above=light)

        # ---- enchanting
        clear_inv(qa)
        give(qa, ('enchanting_table', 1), ('lapis_lazuli', 9), ('iron_pickaxe', 1))
        qa.js('game.stats.xp.add(550)')
        lvl = qa.js('game.stats.xp.level')
        et = qa.place_near('enchanting_table', qa.js('__R.BLOCK.ENCHANTING_TABLE'), rings=(2,))
        if et:
            qa.aim(et[0] + 0.5, et[1] + 0.6, et[2] + 0.5)
            qa.press('Mouse2')
            qa.wait(0.5)
            qa.js('game.input.locked = false')
            base = '.screen.inventory:not(.hidden)'
            box = qa.page.locator(f'{base} .inv-box .inv-slot')
            if box.count() >= 2:
                S.inv_slot(qa, qa.js('qa.slotOf(`iron_pickaxe`)')).click()
                box.nth(0).click()
                S.inv_slot(qa, qa.js('qa.slotOf(`lapis_lazuli`)')).click()
                box.nth(1).click()
                qa.wait(0.4)
                offers = qa.page.locator(f'{base} .ench-offer')
                info = [(offers.nth(i).get_attribute('class'), (offers.nth(i).get_attribute('title') or '').replace('\n', ' | ')) for i in range(offers.count())]
                qa.shot('enchanting')
                ok_o = qa.page.locator(f'{base} .ench-offer.ok')
                got = None
                if ok_o.count():
                    ok_o.last.click()
                    qa.wait(0.4)
                    got = qa.js('game.survivalInventory.box?.slots[0]')
                    qa.shot('enchanted')
                result('enchant an iron pickaxe (no bookshelves)', bool(got and got.get('data')), 'table, 9 lapis, iron pickaxe, ~level 20 given',
                       level=[lvl, qa.js('game.stats.xp.level')], offers=info, item=got)
            else:
                result('enchanting screen opens', False, 'table given')
            qa.js('document.activeElement && document.activeElement.blur()')
            qa.key('KeyE')
            qa.wait(0.3)
            qa.relock()

        # ---- fall death, death screen, respawn, item recovery
        clear_inv(qa)
        give(qa, ('cobblestone', 20), ('iron_ingot', 3), ('stone_sword', 1))
        p = qa.st()
        qa.js('([x, y, z]) => game.player.setPosition(x, y + 24, z)', [p['x'], p['y'], p['z']])
        t0 = time.time()
        while time.time() - t0 < 6 and not qa.st()['dead']:
            qa.wait(0.1)
        s = qa.st()
        qa.wait(0.8)
        qa.shot('death_screen')
        dropped = qa.js('game.entities.items.length')
        result('fall from 24 blocks', s['dead'], 'player moved 24 blocks up', message=s['deathMessage'], items_on_ground=dropped, minecraft='21 damage → dead, "Player fell from a high place"')
        if s['dead']:
            qa.page.locator('.mc-btn', has_text='Respawn').click()
            S.wait_loaded(qa, 30)
            qa.relock()
            qa.wait(1)
            s2 = qa.st()
            qa.walk_to(p['x'], p['z'], tol=1.0, timeout=30, sprint=True)
            qa.collect_items(6, 8)
            back = [(i['name'], i['count']) for i in qa.js('qa.inv()')]
            result('respawn and pick the items up again', len(back) == 3, '', respawn=[round(s2['x'], 1), round(s2['y'], 1), round(s2['z'], 1)], hp=s2['health'], items=back)

        # ---- creative flight
        qa.js("game.setMode('creative')")
        qa.wait(0.3)
        y0 = qa.st()['y']
        qa.js("""() => new Promise((ok) => {
          const i = game.input;
          i.pressed.add('Space'); i.down.add('Space');
          setTimeout(() => { i.down.delete('Space'); }, 60);
          setTimeout(() => { i.pressed.add('Space'); i.down.add('Space'); ok(); }, 160);
        })""")
        qa.hold('Space')
        qa.wait(1.0)
        qa.release('Space')
        result('creative: double jump toggles flying', qa.js('game.player.flying'), 'mode switched to creative', rose=round(qa.st()['y'] - y0, 1))
        result('frames over the whole scenario run', None, '', **qa.take_frames(), console=[c for c in qa.console if 'DevTools' not in c][:10])
    except Exception as e:
        result('EXCEPTION', False, '', error=f'{type(e).__name__}: {str(e)[:400]}')
        try:
            qa.shot('error')
        except Exception:
            pass
    finally:
        json.dump(RESULTS, open(f'docs/qa/scenarios-{a.browser}-run.json', 'w'), indent=1, ensure_ascii=False)
        qa.close()


if __name__ == '__main__':
    main()
