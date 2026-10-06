"""
Survival play-through of BunkCraft like a new player, through the real game input and UI.

  QA_PORT=5231 npx vite --config scripts/qa/vite.qa.config.ts      # in another terminal
  python3 scripts/qa/survival.py --port 5231 --profile /tmp/bc-qa --new            # all phases from a new world
  python3 scripts/qa/survival.py --port 5231 --profile /tmp/bc-qa --phases cave,ores   # continue the saved world

The browser profile (IndexedDB) keeps the world between runs, so phases can be run one at a time.
Results go to docs/qa/survival-run.json (+ screenshots in docs/qa/shots/).
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

SEED = '779050144'
WORLD = 'QA Survival'
B_AIR, B_STONE, B_GRASS, B_DIRT, B_COBBLE, B_WATER, B_COAL, B_IRON, B_LAVA, B_TABLE, B_FURNACE, B_TORCH = 0, 1, 2, 3, 4, 12, 13, 14, 44, 45, 46, 43


def log_ids(qa: QA) -> list[int]:
    return qa.js("__R.BLOCK_DEFS.filter(d => d && d.name.endsWith('_log') && !d.name.startsWith('stripped')).map(d => d.id)")


def name_of(qa: QA, block_id: int) -> str:
    return qa.js('(i) => __R.getBlockDef(i)?.name', block_id)


def wait_loaded(qa: QA, timeout: float = 60) -> float:
    t0 = time.time()
    while time.time() - t0 < timeout:
        qa.page.bring_to_front()
        if qa.js('game.state') not in ('loading', 'menu'):
            break
        time.sleep(0.1)
    return round(time.time() - t0, 1)


def save(qa: QA) -> None:
    qa.js('game.saveGame()')
    qa.wait(0.5)


# ============================================================================ phases

def phase_create(qa: QA) -> None:
    """Title screen → Singleplayer → Create New World (Survival, fixed seed)."""
    qa.begin('Nieuwe survival-wereld via het menu')
    page = qa.page
    qa.wait(1.5)
    qa.shot('00_title')
    page.get_by_role('button', name='Singleplayer').click()
    qa.wait(0.5)
    qa.shot('01_worlds')
    page.get_by_role('button', name='Create New World').click()
    qa.wait(0.3)
    page.locator('.screen:not(.hidden) input.mc-input').first.fill(WORLD)
    mode = page.locator('.mc-btn', has_text='Game Mode').inner_text()
    qa.note(f'default mode button: {mode}')
    page.locator('button.tab', has_text='World').click()
    page.locator('.screen:not(.hidden) input.mc-input').nth(1).fill(SEED)
    qa.shot('02_create')
    page.locator('.mc-btn', has_text='Create New World').last.click()
    secs = wait_loaded(qa)
    qa.note(f'world loaded in {secs}s, state after load: {qa.js("game.state")} (pointer lock fails in automation)')
    qa.relock()
    qa.instrument()
    qa.wait(2)
    s = qa.st()
    qa.note(f'spawn at {s["x"]:.1f},{s["y"]:.1f},{s["z"]:.1f} clock {s["clock"]}, mobs near: {s["hostile"]} hostile / {s["passive"]} passive')
    qa.note(f'inventory at start: {qa.js("qa.inv()")}')
    qa.shot('03_spawn')
    qa.end(True)


def continue_world(qa: QA) -> None:
    qa.begin('Bestaande wereld laden (Play Selected World)')
    page = qa.page
    qa.wait(1)
    page.get_by_role('button', name='Singleplayer').click()
    qa.wait(0.6)
    page.locator('.world-entry, .world-item, .world-list > *', has_text=WORLD).first.click()
    page.get_by_role('button', name='Play Selected World').click()
    secs = wait_loaded(qa)
    qa.relock()
    qa.instrument()
    qa.wait(1.5)
    s = qa.st()
    qa.note(f'loaded in {secs}s at {s["x"]:.1f},{s["y"]:.1f},{s["z"]:.1f}, clock {s["clock"]} day {s["day"]}, hp {s["health"]} food {s["hunger"]}')
    qa.note(f'inventory: {[(i["name"], i["count"]) for i in qa.js("qa.inv()")]}')
    qa.end(True)


def phase_tree(qa: QA) -> None:
    qa.begin('Boom slaan met de hand (logs verzamelen)')
    logs = log_ids(qa)
    times = []
    t_start = time.time()
    trees = 0
    while qa.js('qa.inv().filter(s => s.name.endsWith(" Log")).reduce((a, s) => a + s.count, 0)') < 7 and trees < 4:
        found = qa.js(f'qa.find({logs}, 28, -4, 6, 40)')
        if not found:
            qa.note('no tree within 28 blocks')
            break
        # Nearest trunk: go down the column to its lowest log.
        x, y, z, bid, _ = found[0]
        while qa.block(x, y - 1, z) == bid:
            y -= 1
        s = qa.st()
        d = math.hypot(x + 0.5 - s['x'], z + 0.5 - s['z'])
        k = max(0.0, (d - 1.6) / d) if d > 0 else 0
        ok = qa.walk_to(s['x'] + (x + 0.5 - s['x']) * k, s['z'] + (z + 0.5 - s['z']) * k, tol=0.7, timeout=25)
        qa.note(f'tree {name_of(qa, bid)} at {x},{y},{z}: walked there ok={ok}')
        for dy in range(0, 5):
            if qa.block(x, y + dy, z) != bid:
                break
            secs = qa.mine(x, y + dy, z, timeout=15)
            times.append(secs)
            if secs is None:
                qa.note(f'could not break log at height +{dy}')
                break
        qa.wait(0.8)
        left = qa.collect_items(radius=6, timeout=8)
        trees += 1
        qa.note(f'log break times so far (s): {times}; items left on ground: {left}')
        if trees == 1:
            qa.shot('04_tree')
    inv = qa.js('qa.inv()')
    qa.note(f'inventory: {[(i["name"], i["count"]) for i in inv]}; total {round(time.time() - t_start)}s')
    qa.end(any(i['name'].endswith('Log') for i in inv))


def wood_name(qa: QA) -> str:
    inv = qa.js('qa.inv()')
    logs = [i for i in inv if i['name'].endswith(' Log')]
    return logs[0]['name'][:-4] if logs else 'Oak'


def phase_craft_wood(qa: QA) -> None:
    qa.begin('Planken, stokken, werkbank en houten pikhouweel via het receptenboek')
    wood = wood_name(qa)
    qa.ui_open_inventory()
    qa.shot('05_inventory_open')
    qa.ui_close_inventory()
    n_logs = qa.js('qa.inv().filter(s => s.name.endsWith(" Log")).reduce((a, s) => a + s.count, 0)')
    made = qa.ui_craft(f'{wood} Planks', times=n_logs)
    planks = qa.js('(n) => qa.count(n)', wood.lower().replace(' ', '_') + '_planks')
    qa.note(f'{wood} Planks crafted {made}x (from {n_logs} logs) -> planks {planks}')
    made = qa.ui_craft('Stick', times=2)
    sticks = qa.js('qa.count("stick")')
    qa.note(f'Stick crafted {made}x -> {sticks} sticks')
    made = qa.ui_craft('Crafting Table', times=1)
    qa.note(f'Crafting Table crafted {made}x')
    # Before placing: can a pickaxe be crafted by hand? (should not)
    qa.ui_open_inventory()
    qa.page.locator('.screen.inventory:not(.hidden) .recipe-tab', has_text='All').first.click()
    qa.page.fill('.screen.inventory:not(.hidden) .recipe-search', 'pickaxe')
    qa.wait(0.2)
    n_vis = qa.page.locator('.screen.inventory:not(.hidden) .recipe-list .inv-slot').count()
    qa.note(f'recipe search "pickaxe" without table shows {n_vis} recipes')
    qa.shot('06_recipes_no_table')
    qa.page.fill('.screen.inventory:not(.hidden) .recipe-search', '')
    qa.ui_close_inventory()
    # Place the table on the ground in front.
    ok_sel = qa.select_item('crafting_table')
    x, y, z = qa.cell()
    s = qa.st()
    placed = False
    for (dx, dz) in ((0, -2), (2, 0), (0, 2), (-2, 0), (1, -1), (-1, 1)):
        gx, gz = x + dx, z + dz
        gy = y - 1
        while qa.block(gx, gy + 1, gz) not in (0, 23) and gy < y + 2:
            gy += 1
        while qa.block(gx, gy, gz) in (0, 23) and gy > y - 3:
            gy -= 1
        if qa.place_on(gx, gy, gz):
            placed = qa.block(gx, gy + 1, gz) == B_TABLE
            if placed:
                qa.note(f'table placed at {gx},{gy + 1},{gz}')
                qa.table = (gx, gy + 1, gz)
                break
    qa.note(f'select ok={ok_sel}, placed={placed}')
    made = qa.ui_craft('Wooden Pickaxe', times=1)
    qa.note(f'Wooden Pickaxe crafted {made}x')
    made_s = qa.ui_craft('Wooden Sword', times=1)
    qa.note(f'Wooden Sword crafted {made_s}x')
    qa.ui_open_inventory()
    qa.shot('07_inventory_wood_tools')
    qa.ui_close_inventory()
    qa.end(placed and made == 1)


def phase_stone(qa: QA) -> None:
    qa.begin('Steen hakken met het houten pikhouweel (trap naar beneden)')
    qa.select_item('wooden_pickaxe')
    s = qa.st()
    t0 = time.time()
    # Stone break time with a wooden pickaxe, measured on the first stone block we dig.
    target = (math.floor(s['x']) + 20, math.floor(s['y']) - 14, math.floor(s['z']))
    stone_times = []
    orig_mine = qa.mine

    def timed_mine(x, y, z, timeout=20.0):
        b = qa.block(x, y, z)
        r = orig_mine(x, y, z, timeout)
        if b == B_STONE and r:
            stone_times.append(r)
        return r
    qa.mine = timed_mine
    try:
        ok = qa.dig_to(*target, max_steps=40, until=lambda: qa.js('qa.count("cobblestone")') >= 18)
    finally:
        qa.mine = orig_mine
    qa.collect_items(radius=5, timeout=5)
    cob = qa.js('qa.count("cobblestone")')
    qa.note(f'cobblestone {cob} after {round(time.time() - t0)}s; stone break times with wooden pickaxe: {stone_times[:8]}')
    qa.note(f'wooden pickaxe damage: {[i for i in qa.js("qa.inv()") if i["name"] == "Wooden Pickaxe"]}')
    qa.shot('08_staircase')
    qa.end(cob >= 11)


def go_to_table(qa: QA) -> bool:
    t = getattr(qa, 'table', None)
    if not t:
        found = qa.js(f'qa.find([{B_TABLE}], 30, -20, 20, 1)')
        if not found:
            return False
        t = tuple(found[0][:3])
        qa.table = t
    s = qa.st()
    if math.dist((s['x'], s['y'], s['z']), (t[0] + 0.5, t[1], t[2] + 0.5)) < 3.5:
        return True
    # Walk back up the staircase: retrace by digging towards the table.
    return qa.dig_to(t[0], t[1], t[2], reach=3.2, max_steps=60)


def phase_stone_tools(qa: QA) -> None:
    qa.begin('Stenen gereedschap en oven maken (bij de werkbank)')
    near = go_to_table(qa)
    qa.note(f'back at the table: {near}')
    res = {}
    for item in ('Stone Pickaxe', 'Stone Sword', 'Furnace'):
        res[item] = qa.ui_craft(item, 1)
    qa.note(f'crafted: {res}')
    # Place the furnace next to the table.
    pos = qa.place_near('furnace', B_FURNACE)
    qa.furnace = pos
    qa.note(f'furnace placed at {pos}')
    qa.shot('09_table_furnace')
    qa.end(all(v == 1 for v in res.values()) and pos is not None)


PICKS = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']


def ensure_pickaxe(qa: QA, min_tier: str = 'stone') -> bool:
    """A real player notices the pickaxe is gone and makes a new one (carrying planks for a table)."""
    order = PICKS[:PICKS.index(f'{min_tier}_pickaxe') + 1]
    for p in order:
        if qa.js('(n) => qa.count(n)', p) > 0:
            held = qa.js('qa.state().held') == qa.js('(n) => __I.itemId(n)', p)
            if not held:
                qa.select_item(p)
            return True
    qa.note(f'pickaxe gone (broke without a sound/particle cue?) - making a new {min_tier} pickaxe; inventory {[(i["name"], i["count"]) for i in qa.js("qa.inv()")]}')
    wood = wood_name(qa)
    if qa.js(f'qa.find([{B_TABLE}], 4, -2, 3, 1).length') == 0:
        planks = qa.js('qa.inv().filter(s => s.name.endsWith(" Planks")).reduce((a, s) => a + s.count, 0)')
        if planks < 6:
            qa.ui_craft(f'{wood} Planks', times=2)
        qa.ui_craft('Crafting Table', 1)
        pos = qa.place_near('crafting_table', B_TABLE, rings=(1, 2))
        qa.note(f'new crafting table at {pos}')
    if qa.js('qa.count(`stick`)') < 2:
        qa.ui_craft('Stick', 1)
    made = qa.ui_craft(f'{min_tier.capitalize()} Pickaxe', 1)
    qa.note(f'new {min_tier} pickaxe crafted: {made}')
    if made:
        qa.select_item(f'{min_tier}_pickaxe')
    return made > 0


def mine_ore(qa: QA, block: int, want_item: str, want: int, radius: int = 24, label: str = '') -> dict:
    """Find the nearest ore of a kind, dig to it, mine it and its vein, pick the drops up. Repeat until enough."""
    info = {'veins': 0, 'mined': 0, 'times': [], 'dig_failures': 0}
    tries = 0
    while qa.js('(n) => qa.count(n)', want_item) < want and tries < 6:
        tries += 1
        found = qa.js(f'qa.find([{block}], {radius}, -16, 10, 30)')
        if not found:
            qa.note(f'{label}: no ore within {radius} blocks')
            break
        # Prefer ore that is already exposed (cave walls), else the nearest.
        exposed = [f for f in found if qa.js('([x, y, z]) => qa.exposed(x, y, z)', f[:3])]
        x, y, z = (exposed or found)[0][:3]
        if not ensure_pickaxe(qa, 'stone'):
            break
        ok = qa.dig_to(x, y, z, max_steps=70)
        if qa.st()['dead']:
            qa.note(f'{label}: died while digging')
            break
        if not ok:
            info['dig_failures'] += 1
            qa.note(f'{label}: could not reach ore at {x},{y},{z}')
            continue
        info['veins'] += 1
        # Mine the vein: every ore block of this kind within reach.
        for _ in range(12):
            near = qa.js(f'qa.find([{block}], 4, -3, 4, 12)')
            reach = [n for n in near if math.dist((n[0] + .5, n[1] + .5, n[2] + .5), (qa.st()['x'], qa.st()['y'] + 1.62, qa.st()['z'])) < 4.4]
            if not reach:
                break
            if not ensure_pickaxe(qa, 'stone'):
                break
            t = qa.mine(*reach[0][:3], timeout=20)
            if t is None:
                break
            info['mined'] += 1
            info['times'].append(t)
        qa.wait(0.5)
        qa.collect_items(radius=5, timeout=6)
    return info


def phase_coal(qa: QA) -> None:
    qa.begin('Kolen zoeken en hakken')
    qa.select_item('stone_pickaxe')
    t0 = time.time()
    info = mine_ore(qa, B_COAL, 'coal', 6, label='coal')
    qa.note(f'coal {qa.js("qa.count(`coal`)")} in {round(time.time() - t0)}s; {info}')
    qa.shot('10_coal')
    qa.end(qa.js('qa.count(`coal`)') > 0)


def phase_iron(qa: QA) -> None:
    qa.begin('IJzererts zoeken en hakken (stenen pikhouweel)')
    qa.select_item('stone_pickaxe')
    t0 = time.time()
    info = mine_ore(qa, B_IRON, 'raw_iron', 8, radius=28, label='iron')
    qa.note(f'raw iron {qa.js("qa.count(`raw_iron`)")} in {round(time.time() - t0)}s; {info}')
    qa.shot('11_iron')
    qa.end(qa.js('qa.count(`raw_iron`)') > 0)


def phase_torches(qa: QA) -> None:
    qa.begin('Fakkels maken en plaatsen')
    if qa.js('qa.count(`stick`)') < 2:
        qa.ui_craft('Stick', 1)
    made = qa.ui_craft('Torch', times=2)
    n = qa.js('qa.count(`torch`)')
    qa.note(f'torch crafted {made}x -> {n} torches')
    pos = qa.place_near('torch', B_TORCH, rings=(1, 2))
    light = qa.js('([x, y, z]) => game.world.getLight(x, y, z) & 15', list(pos)) if pos else None
    qa.note(f'torch placed at {pos}, block light there {light}')
    qa.shot('12_torch')
    qa.end(pos is not None)


def phase_smelt(qa: QA) -> None:
    qa.begin('IJzer smelten in de oven (rechtsklik, invoer + brandstof slepen, wachten, output pakken)')
    ok = go_to_block(qa, B_FURNACE)
    qa.note(f'at furnace: {ok}')
    raw = qa.js('qa.count(`raw_iron`)')
    coal0 = qa.js('qa.count(`coal`)')
    made = smelt_in_furnace(qa, 'raw_iron', 'coal', 'iron_ingot', raw)
    qa.note(f'raw iron {raw} -> ingots {made}; coal {coal0} -> {qa.js("qa.count(`coal`)")}; xp level {qa.js("game.stats.xp?.level")}')
    qa.end(made > 0)


def furnace_ui(qa: QA, furnace) -> bool:
    qa.aim(furnace[0] + 0.5, furnace[1] + 0.5, furnace[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(0.5)
    qa.js('game.input.locked = false')
    return qa.page.locator('.screen.inventory:not(.hidden) .furnace-in').count() > 0


def inv_slot(qa: QA, i: int):
    base = '.screen.inventory:not(.hidden)'
    if i < 9:
        return qa.page.locator(f'{base} .inv-hotbar .inv-slot').nth(i)
    return qa.page.locator(f'{base} .inv-armor-row > .inv-grid .inv-slot').nth(i - 9)


def smelt_in_furnace(qa: QA, item: str, fuel: str, result: str, n: int) -> int:
    """Through the furnace screen like a player: drag the stack into the input, fuel into the fuel slot, wait, take it out."""
    f = qa.js(f'qa.find([{B_FURNACE}], 6, -3, 4, 1)')
    if not f or n <= 0:
        qa.note(f'smelt: furnace near={bool(f)}, items={n}')
        return 0
    before = qa.js('(n) => qa.count(n)', result)
    if not furnace_ui(qa, f[0][:3]):
        qa.note('smelt: right click did not open a furnace screen')
        qa.shot('err_furnace_ui')
        qa.relock()
        return 0
    base = '.screen.inventory:not(.hidden)'
    page = qa.page
    s_in = qa.js('(n) => qa.slotOf(n)', item)
    inv_slot(qa, s_in).click()
    page.locator(f'{base} .furnace-in').click()
    # Fuel: one coal smelts 8 items; take half the stack with a right click when we have more.
    s_f = qa.js('(n) => qa.slotOf(n)', fuel)
    need = max(1, math.ceil(n / 8))
    inv_slot(qa, s_f).click()
    for _ in range(need):
        page.locator(f'{base} .furnace-fuel').click(button='right')
    inv_slot(qa, s_f).click()  # the rest back
    qa.wait(0.5)
    qa.shot('furnace_running')
    t0 = time.time()
    slots = lambda: qa.js('game.survivalInventory.box?.slots.map(s => s.count)')  # noqa: E731
    while time.time() - t0 < 12 * n + 10:
        qa.page.bring_to_front()
        time.sleep(1)
        sl = slots()
        if sl and sl[0] == 0 and sl[2] > 0:
            break
    first = round(time.time() - t0, 1)
    qa.note(f'furnace slots after {first}s: {slots()} (input, fuel, output)')
    qa.shot('furnace_done')
    page.locator(f'{base} .furnace-out').click(modifiers=['Shift'])
    qa.wait(0.3)
    qa.js('document.activeElement && document.activeElement.blur()')
    qa.key('KeyE')
    qa.wait(0.3)
    qa.relock()
    return qa.js('(n) => qa.count(n)', result) - before


def phase_place_furnace(qa: QA) -> None:
    qa.begin('Oven neerzetten')
    if qa.js('qa.count(`furnace`)') == 0:
        qa.note('no furnace in the inventory')
        qa.end(qa.js(f'qa.find([{B_FURNACE}], 40, -30, 30, 1).length') > 0)
        return
    pos = qa.place_near('furnace', B_FURNACE)
    qa.note(f'furnace placed at {pos}')
    qa.shot('09_table_furnace')
    qa.end(pos is not None)


TIME_SHORTCUTS: list[str] = []


def set_clock(qa: QA, t: float, why: str) -> None:
    """Test shortcut (singleplayer has no /time command): move the day cycle. Logged in the report."""
    before = qa.st()['clock']
    qa.js('(t) => { game.cycle.time = t; game.cycle.compute(); }', t)
    msg = f'TIME SHORTCUT: clock {before} -> {qa.st()["clock"]} ({why})'
    TIME_SHORTCUTS.append(msg)
    qa.note(msg)


def go_surface(qa: QA) -> bool:
    """Back to the surface near spawn by digging a staircase up (like a player would)."""
    sp = qa.js('game.meta.spawn')
    sx, sz = math.floor(sp['x']), math.floor(sp['z'])
    sy = qa.js('([x, z]) => game.world.surfaceY(x, z)', [sx, sz])
    s = qa.st()
    if s['y'] >= sy - 1 and qa.js('([x, y, z]) => game.world.getLight(x, y, z) >> 4', [math.floor(s['x']), math.floor(s['y'] + 1), math.floor(s['z'])]) >= 14:
        return True
    ensure_pickaxe(qa, 'wooden')
    return qa.dig_to(sx, sy, sz, reach=3.5, max_steps=120)


def jump_place(qa: QA, x: int, y: int, z: int, face=(0, 1, 0), tries: int = 4) -> bool:
    """Jump and place against a face that is only visible from higher up (roofs, pillars)."""
    nx, ny, nz = face
    for _ in range(tries):
        qa.hold('Space')
        qa.wait(0.12)
        qa.release('Space')
        qa.wait(0.08)
        if qa.place_on(x, y, z, face):
            return True
        qa.wait(0.5)
    return qa.block(x + nx, y + ny, z + nz) != 0


def phase_shelter(qa: QA) -> None:
    qa.begin('Schuilplaats bouwen voor de nacht (muren, dak, fakkel)')
    ok = go_surface(qa)
    qa.note(f'back on the surface: {ok} at {[round(v, 1) for v in (qa.st()["x"], qa.st()["y"], qa.st()["z"])]}')
    # A flat-ish spot: walk a few blocks away from the table/furnace.
    x, y, z = qa.cell()
    material = 'cobblestone' if qa.js('qa.count(`cobblestone`)') >= 26 else 'dirt'
    have = qa.js('qa.count(`cobblestone`) + qa.count(`dirt`)')
    qa.note(f'building blocks: {have} (cobblestone + dirt)')
    placed = failed = 0
    ring = [(dx, dz) for dx in (-1, 0, 1) for dz in (-1, 0, 1) if (dx, dz) != (0, 0)]
    for h in (0, 1):
        for dx, dz in ring:
            cx, cz = x + dx, z + dz
            if qa.block(cx, y + h, cz) not in (0, 23, 24, 25):
                continue
            # Fill a gap in the ground first.
            if qa.block(cx, y + h - 1, cz) == 0:
                failed += 1
                continue
            if not qa.select_item(material):
                material = 'dirt' if material == 'cobblestone' else 'cobblestone'
                qa.select_item(material)
            if qa.place_on(cx, y + h - 1, cz):
                placed += 1
            else:
                failed += 1
    qa.note(f'walls: {placed} placed, {failed} failed')
    roof_ok = roof_fail = 0
    for dx, dz in ring:
        cx, cz = x + dx, z + dz
        if qa.block(cx, y + 2, cz) != 0:
            continue
        qa.select_item(material) or qa.select_item('dirt') or qa.select_item('cobblestone')
        if jump_place(qa, cx, y + 1, cz):
            roof_ok += 1
        else:
            roof_fail += 1
    # The block over the head: against the side of a roof block.
    qa.select_item(material) or qa.select_item('dirt') or qa.select_item('cobblestone')
    centre = qa.block(x, y + 2, z) != 0 or qa.place_on(x + 1, y + 2, z, (-1, 0, 0))
    qa.note(f'roof: {roof_ok} placed, {roof_fail} failed, centre {centre}')
    # A torch on the floor inside.
    torch = False
    if qa.select_item('torch'):
        torch = qa.place_on(x, y - 1, z)
    qa.note(f'torch inside: {torch}')
    # Is the shelter closed? Count open cells around feet/head level and above.
    holes = [(x + dx, y + h, z + dz) for h in (0, 1) for dx, dz in ring if qa.block(x + dx, y + h, z + dz) in (0, 23)]
    roof_holes = [(x + dx, y + 2, z + dz) for dx in (-1, 0, 1) for dz in (-1, 0, 1) if qa.block(x + dx, y + 2, z + dz) == 0]
    qa.note(f'holes in walls: {holes}, roof holes: {roof_holes}')
    qa.hut = (x, y, z)
    qa.look(0, -200)
    qa.shot('13_shelter_inside')
    qa.end(not holes and not roof_holes)


def phase_night(qa: QA) -> None:
    qa.begin('De nacht overleven: in de schuilplaats en daarna buiten vechten met het stenen zwaard')
    s = qa.st()
    h = s['time']
    if not (0.52 <= h <= 0.95):
        set_clock(qa, 0.55, 'jump to dusk instead of waiting up to 20 real minutes')
    # Inside the shelter for a while: does anything get in? Watch the mobs gather.
    t0 = time.time()
    hp0 = qa.st()['health']
    max_hostile = 0
    near_hut = []
    while time.time() - t0 < 60:
        qa.wait(5)
        s = qa.st()
        max_hostile = max(max_hostile, s['hostile'])
        near_hut.append(len([m for m in qa.js('qa.mobs(16)') if m['hostile']]))
    qa.note(f'60 s inside at {qa.st()["clock"]}: hostile within 64 max {max_hostile}, within 16 per 5 s: {near_hut}; hp {hp0} -> {qa.st()["health"]}')
    qa.shot('14_night_inside')
    # Go outside: break a wall block and fight.
    x, y, z = getattr(qa, 'hut', qa.cell())
    qa.select_item('stone_sword')
    qa.clear_cell(x + 1, y, z)
    qa.clear_cell(x + 1, y + 1, z)
    qa.select_item('stone_sword')
    qa.walk_to(x + 2.5, z + 0.5, tol=0.5, timeout=4)
    hp_out = qa.st()['health']
    t1 = time.time()
    res = {'swings': 0, 'hits': 0, 'kills': 0, 'seen': []}
    # Fight in rounds; retreat into the hut when low.
    while time.time() - t1 < 150:
        r = qa.fight(15, hostile_only=True, max_dist=2.9, chase=10)
        for k in ('swings', 'hits', 'kills'):
            res[k] += r[k]
        res['seen'] = sorted(set(res['seen']) | set(r['seen']))
        s = qa.st()
        if s['dead']:
            break
        if s['health'] <= 7:
            qa.note(f'retreating with {s["health"]} hp')
            qa.walk_to(x + 0.5, z + 0.5, tol=0.4, timeout=8)
            break
        if not qa.js('qa.mobs(24)').__len__():
            qa.wait(2)
    s = qa.st()
    qa.note(f'outside {round(time.time() - t1)}s: {res}; hp {hp_out} -> {s["health"]}, dead={s["dead"]}, sword {[i for i in qa.js("qa.inv()") if "Sword" in i["name"]]}')
    qa.shot('15_night_fight')
    qa.end(not s['dead'])


def phase_food(qa: QA) -> None:
    qa.begin('Eten: dier doden, vlees bakken in de oven, eten')
    if qa.st()['dead']:
        qa.js('document.querySelector(".mc-btn") && [...document.querySelectorAll(".mc-btn")].find(b => b.textContent === "Respawn")?.click()')
        qa.wait(2)
        qa.relock()
    s = qa.st()
    qa.note(f'hunger {s["hunger"]}, saturation {s["sat"]:.1f}')
    t0 = time.time()
    raw = ['porkchop', 'beef', 'mutton', 'chicken']
    have_raw = lambda: sum(qa.js('(n) => qa.count(n)', r) for r in raw)  # noqa: E731
    qa.select_item('stone_sword') or qa.select_item('wooden_sword')
    for _ in range(4):
        if have_raw() >= 2:
            break
        animals = [m for m in qa.js('qa.mobs(60)') if m['kind'] in ('pig', 'cow', 'sheep', 'chicken')]
        if not animals:
            qa.note('no animals within 60 blocks')
            break
        a = animals[0]
        qa.walk_to(a['x'], a['z'], tol=2.5, timeout=25)
        r = qa.fight(25, hostile_only=False, kinds=(a['kind'],), max_dist=2.9, chase=14, stop_when_none=True)
        qa.wait(0.6)
        qa.collect_items(radius=6, timeout=6)
        qa.note(f'hunt {a["kind"]}: {r}; raw meat now {have_raw()}')
    qa.note(f'raw meat {have_raw()} after {round(time.time() - t0)}s')
    cooked = 0
    if go_to_block(qa, B_FURNACE):
        for rname, cname in (('porkchop', 'Cooked Porkchop'), ('beef', 'Steak'), ('mutton', 'Cooked Mutton'), ('chicken', 'Cooked Chicken')):
            n = qa.js('(n) => qa.count(n)', rname)
            if n:
                cooked += qa.ui_craft(cname, times=n, search=cname.split()[-1])
    qa.note(f'cooked {cooked}')
    food = [i for i in qa.js('qa.inv()') if i['name'] in ('Cooked Porkchop', 'Steak', 'Cooked Mutton', 'Cooked Chicken', 'Raw Porkchop', 'Raw Beef', 'Raw Mutton', 'Raw Chicken', 'Apple')]
    s0 = qa.st()
    ate = False
    if food and s0['hunger'] < 20:
        it = food[0]
        qa.select_item(qa.js('(i) => __I.getItemDef(i).name', it['id']))
        qa.hold('Mouse2')
        t1 = time.time()
        while time.time() - t1 < 4 and qa.st()['hunger'] == s0['hunger']:
            qa.wait(0.1)
        qa.release('Mouse2')
        s1 = qa.st()
        ate = s1['hunger'] > s0['hunger']
        qa.note(f'ate {it["name"]} in {round(time.time() - t1, 2)}s: hunger {s0["hunger"]} -> {s1["hunger"]}, sat {s0["sat"]:.1f} -> {s1["sat"]:.1f}')
    else:
        qa.note(f'not eaten: food={food}, hunger={s0["hunger"]} (eating only works below 20)')
    qa.end(ate)


def find_cave_entrance(qa: QA, r: int = 48):
    """Open air below the terrain surface that sees the sky: a cave mouth or ravine."""
    return qa.js("""(r) => {
      const g = game, w = g.world, p = g.player;
      const px = Math.floor(p.x), pz = Math.floor(p.z);
      let best = null;
      for (let dz = -r; dz <= r; dz += 2) for (let dx = -r; dx <= r; dx += 2) {
        const x = px + dx, z = pz + dz;
        const top = w.generator.heightAt(x, z);
        for (let y = top - 4; y > top - 14; y--) {
          if (w.getBlock(x, y, z) === 0 && w.getBlock(x, y + 1, z) === 0 && w.getBlock(x, y - 1, z) !== 0 && w.getBlock(x, y - 1, z) !== 12 && (w.getLight(x, y, z) >> 4) >= 8) {
            const d = dx * dx + dz * dz;
            if (!best || d < best[3]) best = [x, y, z, d, top];
            break;
          }
        }
      }
      return best;
    }""", r)


def phase_cave(qa: QA) -> None:
    qa.begin('Grotingang zoeken, naar binnen, fakkels plaatsen, ertsen hakken')
    go_surface(qa)
    ent = find_cave_entrance(qa)
    qa.note(f'cave entrance candidate: {ent}')
    if not ent:
        qa.end(False)
        return
    x, y, z, _, top = ent
    t0 = time.time()
    ok = qa.walk_to(x + 0.5, z + 0.5, tol=1.0, timeout=60)
    s = qa.st()
    qa.note(f'walked to the entrance: {ok} in {round(time.time() - t0)}s, now y={s["y"]:.1f} (cave floor y={y}, surface {top})')
    if s['y'] > y + 2:
        ensure_pickaxe(qa, 'wooden')
        qa.dig_to(x, y - 1, z, reach=2.5, max_steps=40)
    qa.shot('16_cave_entrance')
    # Inside: walk deeper following air, place torches every ~8 blocks, mine exposed ores.
    torches = 0
    ores = {'coal': 0, 'iron': 0, 'other': 0}
    explore_t = time.time()
    last_torch = None
    while time.time() - explore_t < 120:
        s = qa.st()
        if s['dead']:
            break
        cell = (math.floor(s['x']), math.floor(s['y']), math.floor(s['z']))
        light = qa.js('([x, y, z]) => game.world.getLight(x, y, z)', list(cell))
        if (light & 15) < 8 and (light >> 4) < 8 and (last_torch is None or math.dist(cell, last_torch) > 6):
            if qa.place_near('torch', B_TORCH, rings=(1,)):
                torches += 1
                last_torch = cell
        exposed = [f for f in qa.js('qa.find([13, 14, 15, 16], 4, -3, 4, 10)') if qa.js('([x, y, z]) => qa.exposed(x, y, z)', f[:3])]
        if exposed:
            ensure_pickaxe(qa, 'stone')
            for f in exposed[:3]:
                if qa.mine(*f[:3], timeout=15) is not None:
                    ores['coal' if f[3] == 13 else 'iron' if f[3] == 14 else 'other'] += 1
            qa.collect_items(radius=5, timeout=4)
        # Next: the farthest reachable air cell a few blocks away at a lower or equal height.
        nxt = qa.js("""() => {
          const w = game.world, p = game.player;
          const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
          let best = null;
          for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) for (let dy = -3; dy <= 1; dy++) {
            const x = px + dx, y = py + dy, z = pz + dz;
            if (w.getBlock(x, y, z) || w.getBlock(x, y + 1, z) || !w.getBlock(x, y - 1, z) || w.getBlock(x, y - 1, z) === 12 || w.getBlock(x, y - 1, z) === 44) continue;
            if ((w.getLight(x, y, z) >> 4) > 10) continue;
            const v = (window.__qaVisited = window.__qaVisited || new Set());
            if (v.has(x + ',' + z)) continue;
            const score = Math.hypot(dx, dz) - dy * 1.5;
            if (!best || score > best[3]) best = [x, y, z, score];
          }
          if (best) window.__qaVisited.add(best[0] + ',' + best[2]);
          return best;
        }""")
        if not nxt:
            break
        qa.walk_to(nxt[0] + 0.5, nxt[2] + 0.5, tol=0.8, timeout=8)
    s = qa.st()
    qa.note(f'explored {round(time.time() - explore_t)}s, now at y={s["y"]:.1f}; torches placed {torches}; ores mined {ores}; hostile within 16: {[m["kind"] for m in qa.js("qa.mobs(16)") if m["hostile"]]}')
    qa.shot('17_cave_inside')
    qa.end(torches > 0 or sum(ores.values()) > 0)


def phase_armor(qa: QA) -> None:
    qa.begin('Harnas: ijzeren stukken maken en aantrekken, armor-balk')
    ingots = qa.js('qa.count(`iron_ingot`)')
    if qa.js('qa.count(`raw_iron`)') and go_to_block(qa, B_FURNACE):
        ingots += qa.ui_craft('Iron Ingot', qa.js('qa.count(`raw_iron`)'), search='iron')
    made = []
    if ingots >= 4:
        if not go_to_block(qa, B_TABLE):
            qa.ui_craft('Crafting Table', 1)
            qa.place_near('crafting_table', B_TABLE, rings=(1, 2))
        for piece, cost in (('Iron Chestplate', 8), ('Iron Leggings', 7), ('Iron Helmet', 5), ('Iron Boots', 4)):
            if qa.js('qa.count(`iron_ingot`)') >= cost and qa.ui_craft(piece, 1):
                made.append(piece)
    qa.note(f'iron ingots {ingots}; crafted {made}')
    worn = []
    for piece in made:
        name = piece.lower().replace(' ', '_')
        if qa.select_item(name):
            qa.press('Mouse2')
            qa.wait(0.2)
            if qa.js('(n) => qa.count(n)', name) == 0:
                worn.append(piece)
    armor = qa.st()['armor']
    qa.note(f'worn by right click: {worn}; armor points {armor}')
    qa.ui_open_inventory()
    qa.shot('18_armor_inventory')
    qa.ui_close_inventory()
    qa.shot('19_armor_hud')
    qa.end(armor > 0)


def phase_bed(qa: QA) -> None:
    qa.begin('Bed: wol van schapen, bed maken, slapen')
    t0 = time.time()
    qa.select_item('stone_sword') or qa.select_item('wooden_sword')
    for _ in range(6):
        if qa.js('qa.count(`White Wool`)') >= 3:
            break
        sheep = [m for m in qa.js('qa.mobs(70)') if m['kind'] == 'sheep']
        if not sheep:
            qa.note('no sheep within 70 blocks')
            break
        a = sheep[0]
        qa.walk_to(a['x'], a['z'], tol=2.5, timeout=30)
        qa.fight(20, hostile_only=False, kinds=('sheep',), chase=14, stop_when_none=True)
        qa.wait(0.6)
        qa.collect_items(radius=6, timeout=6)
    wool = qa.js('qa.count(`White Wool`)')
    qa.note(f'white wool {wool} after {round(time.time() - t0)}s')
    made = 0
    if wool >= 3:
        planks = qa.js('qa.inv().filter(s => s.name.endsWith(" Planks")).reduce((a, s) => a + s.count, 0)')
        if planks < 3:
            qa.ui_craft(f'{wood_name(qa)} Planks', 1)
        if not qa.js(f'qa.find([{B_TABLE}], 4, -2, 3, 1).length'):
            if planks < 7:
                qa.ui_craft(f'{wood_name(qa)} Planks', 1)
            qa.ui_craft('Crafting Table', 1)
            qa.place_near('crafting_table', B_TABLE, rings=(1, 2))
        made = qa.ui_craft('White Bed', 1, search='bed')
    qa.note(f'bed crafted {made}')
    if not made:
        qa.end(False)
        return
    bed_id = qa.js('__R.BLOCK.BED')
    pos = qa.place_near('white_bed', bed_id, rings=(2, 3))
    qa.note(f'bed placed at {pos}')
    if not pos:
        qa.end(False)
        return
    # Sleep: day first (Minecraft: "You can sleep only at night"), then at night with and without monsters around.
    s0 = qa.st()
    qa.place_on(pos[0], pos[1] - 1, pos[2]) if False else None
    qa.aim(pos[0] + 0.5, pos[1] + 0.3, pos[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(0.5)
    s1 = qa.st()
    qa.note(f'right click bed at {s0["clock"]}: clock now {s1["clock"]}; spawn {qa.js("game.meta.spawn")}')
    if not (0.52 <= s1['time'] <= 0.95):
        set_clock(qa, 0.6, 'make it night to test sleeping')
    hostile = [m for m in qa.js('qa.mobs(10)') if m['hostile']]
    s2 = qa.st()
    qa.aim(pos[0] + 0.5, pos[1] + 0.3, pos[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(1.5)
    qa.shot('20_bed_sleeping')
    msgs = qa.js("[...document.querySelectorAll('.chat-line, .chat .line, .chat div')].slice(-4).map(e => e.textContent)")
    qa.note(f'chat after clicking the bed: {msgs}')
    qa.wait(5)
    s3 = qa.st()
    qa.note(f'sleep at {s2["clock"]} with {len(hostile)} hostile mobs within 10 blocks: clock -> {s3["clock"]} (day {s2["day"] + 1} -> {s3["day"] + 1}), player pos unchanged {abs(s3["x"] - s2["x"]) < 0.01}')
    qa.shot('20_bed')
    qa.end(s3['time'] < 0.1)


def phase_death(qa: QA) -> None:
    qa.begin('Doodgaan (val van een zelfgebouwde pilaar) en respawnen')
    inv_before = qa.js('qa.inv()')
    n_items = sum(i['count'] for i in inv_before)
    block = 'dirt' if qa.js('qa.count(`dirt`)') >= 20 else 'cobblestone'
    qa.note(f'pillar material {block}: {qa.js("(n) => qa.count(n)", block)}')
    qa.select_item(block)
    y0 = qa.st()['y']
    for i in range(26):
        x, y, z = qa.cell()
        if qa.block(x, y + 2, z) != 0:
            break
        if not qa.select_item(block):
            break
        if not jump_place(qa, x, y - 1, z, tries=3):
            qa.note(f'pillar stopped at step {i}')
            break
        qa.wait(0.2)
    s = qa.st()
    qa.note(f'pillar height {s["y"] - y0:.1f}')
    qa.shot('21_pillar_top')
    # Step off.
    qa.look(-700, 0)
    qa.hold('KeyW')
    t0 = time.time()
    while time.time() - t0 < 6 and not qa.st()['dead']:
        qa.wait(0.2)
    qa.release('KeyW')
    s = qa.st()
    qa.note(f'dead={s["dead"]} message="{s["deathMessage"]}" state={s["state"]}')
    if not s['dead']:
        qa.end(False)
        return
    death_pos = (s['x'], s['z'])
    qa.wait(1)
    qa.shot('22_death_screen')
    dropped = qa.js('game.entities.items.length')
    qa.note(f'items on the ground after death: {dropped} entities (inventory had {len(inv_before)} stacks / {n_items} items)')
    qa.page.locator('.mc-btn', has_text='Respawn').click()
    secs = wait_loaded(qa, 30)
    qa.relock()
    qa.wait(1.5)
    s = qa.st()
    qa.note(f'respawned in {secs}s at {s["x"]:.1f},{s["y"]:.1f},{s["z"]:.1f} (spawn {qa.js("game.meta.spawn")}), hp {s["health"]} food {s["hunger"]}, inventory {qa.js("qa.inv()")}')
    # Run back and pick the items up.
    t1 = time.time()
    qa.walk_to(death_pos[0], death_pos[1], tol=1.5, timeout=60, sprint=True)
    qa.collect_items(radius=8, timeout=10)
    back = sum(i['count'] for i in qa.js('qa.inv()'))
    qa.note(f'ran back in {round(time.time() - t1)}s and got {back}/{n_items} items back')
    qa.end(True)


def phase_save_reload(qa: QA) -> None:
    qa.begin('Opslaan en opnieuw laden (Save and Quit to Title → Play Selected World)')
    s0 = qa.st()
    inv0 = qa.js('qa.inv().map(s => [s.name, s.count]).sort().join()')
    edits0 = qa.js('game.world.edits.size')
    marker = qa.cell()
    qa.js('game.pause()')
    qa.wait(0.5)
    qa.shot('23_pause_menu')
    qa.page.locator('.mc-btn', has_text='Save and Quit to Title').click()
    qa.wait(2)
    qa.page.get_by_role('button', name='Singleplayer').click()
    qa.wait(0.6)
    qa.shot('24_world_list')
    qa.page.locator('.screen:not(.hidden)', has_text=WORLD).locator(f'text={WORLD}').first.click()
    qa.page.get_by_role('button', name='Play Selected World').click()
    secs = wait_loaded(qa)
    qa.relock()
    qa.wait(1.5)
    s1 = qa.st()
    inv1 = qa.js('qa.inv().map(s => [s.name, s.count]).sort().join()')
    qa.note(f'reload {secs}s; pos {[round(s0[k], 1) for k in "xyz"]} -> {[round(s1[k], 1) for k in "xyz"]}; clock {s0["clock"]} -> {s1["clock"]}; hp {s0["health"]}->{s1["health"]} food {s0["hunger"]}->{s1["hunger"]}')
    qa.note(f'inventory same: {inv0 == inv1}; edited chunks {edits0} -> {qa.js("game.world.edits.size")}')
    qa.end(inv0 == inv1 and abs(s0['x'] - s1['x']) < 1 and abs(s0['z'] - s1['z']) < 1)


def phase_settings(qa: QA) -> None:
    qa.begin('Instellingen-menu’s doorlopen (Options, Video, Sound, Controls, Key Binds)')
    page = qa.page
    qa.js('game.pause()')
    qa.wait(0.4)
    page.locator('.mc-btn', has_text='Options...').click()
    qa.wait(0.4)
    qa.shot('25_options')
    found = {}
    for sub, shot in (('Video Settings...', '26_video'), ('Music & Sounds...', '27_sound'), ('Controls...', '28_controls')):
        btn = page.locator('.screen:not(.hidden) .mc-btn', has_text=sub)
        found[sub] = btn.count()
        if btn.count():
            btn.first.click()
            qa.wait(0.4)
            qa.shot(shot)
            if sub == 'Controls...':
                kb = page.locator('.screen:not(.hidden) .mc-btn', has_text='Key Binds...')
                if kb.count():
                    kb.first.click()
                    qa.wait(0.4)
                    qa.shot('29_keybinds')
                    page.locator('.screen:not(.hidden) .mc-btn', has_text='Done').last.click()
                    qa.wait(0.3)
            page.locator('.screen:not(.hidden) .mc-btn', has_text='Done').last.click()
            qa.wait(0.3)
    qa.note(f'sub screens found: {found}')
    v0 = qa.js('JSON.stringify(game.settings.values)')
    qa.note(f'settings: {v0[:400]}')
    page.locator('.screen:not(.hidden) .mc-btn', has_text='Done').last.click()
    qa.wait(0.3)
    page.locator('.mc-btn', has_text='Back to Game').click()
    qa.wait(0.5)
    qa.relock()
    qa.end(all(found.values()))


def phase_farm(qa: QA) -> None:
    qa.begin('Dieren fokken: zaden uit gras, twee kippen voeren')
    go_surface(qa)
    # Seeds: break grass tufts (12.5 % chance each).
    t0 = time.time()
    broken = 0
    for _ in range(40):
        if qa.js('qa.count(`wheat_seeds`)') >= 4:
            break
        tufts = qa.js(f'qa.find([{qa.js("__R.BLOCK.TALL_GRASS")}], 12, -3, 3, 5)')
        if not tufts:
            qa.walk_to(qa.st()['x'] + 8, qa.st()['z'], timeout=4)
            continue
        x, y, z = tufts[0][:3]
        qa.walk_to(x + 0.5, z + 0.5, tol=2.5, timeout=6)
        if qa.mine(x, y, z, timeout=3) is not None:
            broken += 1
        qa.collect_items(4, 2)
    seeds = qa.js('qa.count(`wheat_seeds`)')
    qa.note(f'seeds {seeds} from {broken} grass tufts in {round(time.time() - t0)}s')
    if seeds < 2:
        qa.end(False)
        return
    fed = 0
    babies0 = qa.js('game.entities.mobs.filter(m => m.type.kind === "chicken" && m.age < 0 || m.baby).length')
    for _ in range(4):
        if fed >= 2:
            break
        hens = [m for m in qa.js('qa.mobs(60)') if m['kind'] == 'chicken']
        if not hens:
            qa.note('no chickens within 60 blocks')
            break
        c = hens[min(fed, len(hens) - 1)]
        qa.walk_to(c['x'], c['z'], tol=2.0, timeout=25)
        qa.select_item('wheat_seeds')
        c = [m for m in qa.js('qa.mobs(6)') if m['kind'] == 'chicken']
        if not c:
            continue
        n0 = qa.js('qa.count(`wheat_seeds`)')
        qa.aim(c[0]['x'], c[0]['y'] + 0.4, c[0]['z'])
        qa.press('Mouse2')
        qa.wait(0.4)
        if qa.js('qa.count(`wheat_seeds`)') < n0:
            fed += 1
    qa.wait(6)
    kids = qa.js('game.entities.mobs.filter(m => m.type.kind === "chicken" && (m.baby || m.age < 0 || m.growingAge < 0)).length')
    qa.note(f'fed {fed} chickens; baby chickens before {babies0} after {kids}; XP level {qa.js("game.stats.xp?.level")}')
    qa.shot('30_breeding')
    qa.end(fed >= 2)


def phase_enchant(qa: QA) -> None:
    qa.begin('Betoveren (enchanting table) - SETUP SHORTCUT: tafel, lapis en levels gegeven')
    xp0 = qa.js('game.stats.xp.level')
    qa.note(f'XP level earned by playing so far: {xp0}')
    qa.js("""() => {
      const inv = game.playerInventory;
      inv.add({ id: __I.itemId('enchanting_table'), count: 1 });
      inv.add({ id: __I.itemId('lapis_lazuli'), count: 6 });
      if (game.stats.xp.level < 5) game.stats.xp.add(160);
    }""")
    TIME_SHORTCUTS.append('ENCHANT SETUP: gave enchanting_table, 6 lapis and XP up to ~level 10')
    pos = qa.place_near('enchanting_table', qa.js('__R.BLOCK.ENCHANTING_TABLE'), rings=(2, 1, 3))
    qa.note(f'table at {pos}, level now {qa.js("game.stats.xp.level")}')
    if not pos:
        qa.end(False)
        return
    target = 'stone_sword' if qa.js('qa.count(`stone_sword`)') else 'stone_pickaxe'
    qa.aim(pos[0] + 0.5, pos[1] + 0.6, pos[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(0.5)
    qa.js('game.input.locked = false')
    base = '.screen.inventory:not(.hidden)'
    box = qa.page.locator(f'{base} .inv-box .inv-slot')
    if box.count() < 2:
        qa.note('right click did not open the enchanting screen')
        qa.relock()
        qa.end(False)
        return
    inv_slot(qa, qa.js('(n) => qa.slotOf(n)', target)).click()
    box.nth(0).click()
    inv_slot(qa, qa.js('qa.slotOf(`lapis_lazuli`)')).click()
    box.nth(1).click()
    qa.wait(0.4)
    offers = qa.page.locator(f'{base} .ench-offer')
    info = [(offers.nth(i).get_attribute('class'), offers.nth(i).get_attribute('title')) for i in range(offers.count())]
    qa.note(f'offers: {info}')
    qa.shot('31_enchanting')
    ok_offers = qa.page.locator(f'{base} .ench-offer.ok')
    enchanted = None
    if ok_offers.count():
        ok_offers.first.click()
        qa.wait(0.4)
        enchanted = qa.js('game.survivalInventory.box?.slots[0]')
    qa.note(f'item after enchanting: {enchanted}; level {qa.js("game.stats.xp.level")}')
    qa.shot('32_enchanted')
    qa.js('document.activeElement && document.activeElement.blur()')
    qa.key('KeyE')
    qa.wait(0.3)
    qa.relock()
    qa.end(bool(enchanted and enchanted.get('data')))


def phase_creative(qa: QA) -> None:
    qa.begin('Creative: nieuwe wereld, inventory-tabs, zoeken, vliegen')
    page = qa.page
    qa.js('game.pause()')
    qa.wait(0.4)
    page.locator('.mc-btn', has_text='Save and Quit to Title').click()
    qa.wait(2)
    page.get_by_role('button', name='Singleplayer').click()
    qa.wait(0.5)
    page.get_by_role('button', name='Create New World').click()
    qa.wait(0.3)
    page.locator('.screen:not(.hidden) input.mc-input').first.fill('QA Creative')
    mode = page.locator('.mc-btn', has_text='Game Mode')
    for _ in range(4):
        if 'Creative' in mode.inner_text():
            break
        mode.click()
    page.locator('.mc-btn', has_text='Create New World').last.click()
    wait_loaded(qa)
    qa.relock()
    qa.wait(1.5)
    qa.key('KeyE')
    qa.wait(0.4)
    qa.js('game.input.locked = false')
    tabs = page.locator('.inv-tab')
    n = tabs.count()
    names = []
    for i in range(n):
        t = tabs.nth(i)
        names.append(t.get_attribute('title') or t.inner_text())
        if i < n - 1:
            t.click()
            qa.wait(0.15)
            if i in (0, 3, 7):
                qa.shot(f'33_creative_tab{i}')
    qa.note(f'{n} tabs: {names}')
    tabs.nth(min(5, n - 1)).click()
    search = page.locator('.inv-search:visible')
    if search.count():
        search.first.fill('diamond')
        qa.wait(0.3)
        qa.note(f'search "diamond": {page.locator(".creative-grid .inv-slot img, .inv-grid .inv-slot img").count()} icons')
        qa.shot('34_creative_search')
    qa.js('document.activeElement && document.activeElement.blur()')
    qa.key('KeyE')
    qa.wait(0.3)
    qa.relock()
    # Double jump to fly.
    y0 = qa.st()['y']
    # Double tap inside the page (Playwright round trips are slower than the 0.3 s window).
    qa.js("""() => new Promise((ok) => {
      const i = game.input;
      i.pressed.add('Space'); i.down.add('Space');
      setTimeout(() => { i.down.delete('Space'); }, 60);
      setTimeout(() => { i.pressed.add('Space'); i.down.add('Space'); ok(); }, 160);
    })""")
    qa.hold('Space')
    qa.wait(1.0)
    qa.release('Space')
    s = qa.st()
    flying = qa.js('game.player.flying')
    qa.note(f'double space: flying={flying}, rose {s["y"] - y0:.1f} blocks')
    qa.end(n > 3 and flying)


def phase_kit(qa: QA) -> None:
    """SETUP SHORTCUT for the second session: the items the first session had mined/crafted before dying."""
    qa.begin('SETUP: uitrusting uit de eerste sessie (stenen gereedschap, ruw ijzer, kolen, planken, steen, fakkels)')
    kit = [('stone_pickaxe', 1), ('stone_sword', 1), ('stone_axe', 1), ('raw_iron', 11), ('coal', 12), ('oak_planks', 24), ('stick', 8),
           ('cobblestone', 48), ('dirt', 16), ('torch', 8), ('furnace', 1), ('crafting_table', 1)]
    qa.js('(kit) => { for (const [n, c] of kit) game.playerInventory.add({ id: __I.itemId(n), count: c }); }', kit)
    TIME_SHORTCUTS.append(f'KIT: {kit}')
    qa.note(f'kit given: {kit}')
    pos_t = qa.place_near('crafting_table', B_TABLE, rings=(2, 3))
    pos_f = qa.place_near('furnace', B_FURNACE, rings=(1, 2, 3))
    qa.note(f'table {pos_t}, furnace {pos_f}')
    qa.end(bool(pos_t and pos_f))


def phase_redstone(qa: QA) -> None:
    qa.begin('Redstone-basis: hendel maken, deur maken, hendel naast de deur zet hem open')
    go_surface(qa)
    wood = wood_name(qa)
    planks = qa.js('qa.inv().filter(s => s.name.endsWith(" Planks")).reduce((a, s) => a + s.count, 0)')
    if planks < 6:
        qa.ui_craft(f'{wood} Planks', 2)
    if not qa.js(f'qa.find([{B_TABLE}], 4, -2, 3, 1).length'):
        qa.ui_craft('Crafting Table', 1)
        qa.place_near('crafting_table', B_TABLE, rings=(1, 2))
    if qa.js('qa.count(`stick`)') < 1:
        qa.ui_craft('Stick', 1)
    lever = qa.ui_craft('Lever', 1)
    doors = qa.js('qa.inv().filter(s => s.name.endsWith(" Door")).map(s => s.name)')
    if not doors:
        qa.ui_craft(f'{wood} Door', 1, search='door')
        doors = qa.js('qa.inv().filter(s => s.name.endsWith(" Door")).map(s => s.name)')
    qa.note(f'lever crafted {lever}; doors {doors}')
    if not lever or not doors:
        qa.end(False)
        return
    door_block = qa.js('__R.BLOCK.DOOR')
    lever_block = qa.js('__R.BLOCK.LEVER')
    pos = qa.place_near(doors[0], door_block, rings=(2, 3))
    qa.note(f'door at {pos}')
    if not pos:
        qa.end(False)
        return
    dx, dy, dz = pos
    open0 = qa.js('([x, y, z]) => game.world.getMeta(x, y, z)', [dx, dy, dz])
    # Lever on the ground right next to the door (any side that is free).
    placed = None
    qa.select_item('Lever')
    for ox, oz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        gx, gz = dx + ox, dz + oz
        if qa.block(gx, dy, gz) == 0 and qa.block(gx, dy - 1, gz) not in (0, 12, 44):
            if qa.place_on(gx, dy - 1, gz) and qa.block(gx, dy, gz) == lever_block:
                placed = (gx, dy, gz)
                break
    qa.note(f'lever placed at {placed}')
    if not placed:
        qa.end(False)
        return
    qa.aim(placed[0] + 0.5, placed[1] + 0.2, placed[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(0.6)
    open1 = qa.js('([x, y, z]) => game.world.getMeta(x, y, z)', [dx, dy, dz])
    qa.shot('35_redstone_lever_door')
    qa.aim(placed[0] + 0.5, placed[1] + 0.2, placed[2] + 0.5)
    qa.press('Mouse2')
    qa.wait(0.6)
    open2 = qa.js('([x, y, z]) => game.world.getMeta(x, y, z)', [dx, dy, dz])
    qa.note(f'door meta closed {open0} -> lever on {open1} -> lever off {open2}')
    qa.end(open1 != open0 and open2 == open0)


def go_to_block(qa: QA, block: int) -> bool:
    found = qa.js(f'qa.find([{block}], 64, -40, 40, 1)')
    if not found:
        return False
    x, y, z = found[0][:3]
    s = qa.st()
    if math.dist((s['x'], s['y'], s['z']), (x + 0.5, y, z + 0.5)) < 3.5:
        return True
    return qa.dig_to(x, y, z, reach=3.2, max_steps=80)


PHASES = {
    'tree': phase_tree,
    'craft_wood': phase_craft_wood,
    'stone': phase_stone,
    'stone_tools': phase_stone_tools,
    'furnace': phase_place_furnace,
    'coal': phase_coal,
    'torches': phase_torches,
    'iron': phase_iron,
    'smelt': phase_smelt,
    'shelter': phase_shelter,
    'night': phase_night,
    'food': phase_food,
    'cave': phase_cave,
    'armor': phase_armor,
    'bed': phase_bed,
    'death': phase_death,
    'save_reload': phase_save_reload,
    'settings': phase_settings,
    'farm': phase_farm,
    'enchant': phase_enchant,
    'creative': phase_creative,
    'redstone': phase_redstone,
    'kit': phase_kit,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5231)
    ap.add_argument('--profile', default='/tmp/bunkcraft-qa-profile')
    ap.add_argument('--new', action='store_true')
    ap.add_argument('--phases', default=','.join(PHASES))
    ap.add_argument('--report', default='docs/qa/survival-run.json')
    ap.add_argument('--headed', action='store_true')
    ap.add_argument('--browser', default='chromium', help='chromium (with --use-angle=metal) or webkit')
    a = ap.parse_args()
    qa = QA(a.port, 'docs/qa', a.profile, headless=not a.headed, browser=a.browser)
    if a.browser != 'chromium':
        qa.shot_prefix = f'{a.browser}_'
    try:
        qa.open()
        if a.new:
            phase_create(qa)
        else:
            continue_world(qa)
        for name in a.phases.split(','):
            try:
                s = qa.st()
                if s['dead'] or s['state'] == 'dead':
                    qa.begin(f'Onverwachte dood vóór fase {name}')
                    qa.note(f'death message: {s["deathMessage"]}')
                    qa.shot(f'death_before_{name}')
                    qa.page.locator('.mc-btn', has_text='Respawn').click()
                    wait_loaded(qa, 30)
                    qa.relock()
                    qa.wait(1)
                    qa.end(False)
                elif s['health'] < 10 and name not in ('death',):
                    # A real player waits to heal before the next risky thing.
                    t0 = time.time()
                    while time.time() - t0 < 40 and qa.st()['health'] < 14:
                        qa.wait(2)
                    print(f'    (healed {s["health"]:.1f} -> {qa.st()["health"]:.1f} in {round(time.time() - t0)}s, food {qa.st()["hunger"]})', flush=True)
                PHASES[name](qa)
            except Exception as e:  # keep going: a failing step is a finding
                qa.note(f'EXCEPTION {type(e).__name__}: {str(e)[:300]}')
                qa.note(f'navigations so far: {qa.navigations}')
                qa.end(False)
                if 'qa is not defined' in str(e) or 'context was destroyed' in str(e):
                    # The page reloaded under us: open it again and continue the saved world.
                    qa.page.wait_for_timeout(2000)
                    qa.open()
                    continue_world(qa)
                try:
                    qa.shot(f'error_{name}')
                except Exception:
                    pass
            save(qa)
    finally:
        # Merge with an earlier run's report so phases run separately add up.
        old = {}
        if os.path.exists(a.report) and not a.new:
            old = json.load(open(a.report))
        qa.write_report(a.report + '.tmp')
        new = json.load(open(a.report + '.tmp'))
        os.remove(a.report + '.tmp')
        if old:
            new['steps'] = old.get('steps', []) + new['steps']
            new['console'] = old.get('console', []) + new['console']
        new['time_shortcuts'] = (old.get('time_shortcuts', []) if old else []) + TIME_SHORTCUTS
        json.dump(new, open(a.report, 'w'), indent=1, ensure_ascii=False)
        qa.close()


if __name__ == '__main__':
    main()
