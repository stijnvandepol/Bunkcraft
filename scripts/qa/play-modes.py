"""
QA play test: every arcade mode on every map with two real browser clients against a real server
(through the Vite dev server), driven through game.input only. Per combination:

  - both players join, the right map loads, teams differ (team modes), the match goes live
  - spawn check: standing on a block, not inside one, not in sight of the other player
  - honest movement: players walk walk-graph paths (stairs, drops, jumps) and wander with bunny hops;
    every server correction (`teleport`) is counted, with the anti-cheat rule counters from /metrics
  - the mode's goal: a kill (tdm, ffa, gun game level-up, elimination round), standing on the hill
    (hardpoint score), capturing a point (domination), stealing and capturing the flag (ctf)
  - stuck detection (no progress for 3 s while walking) with a screenshot
  - a HUD screenshot per combination: docs/qa/shots/arcade/play-<mode>-<map>.png

Needs: game server (ROOM_CREATE_LIMIT=1000), Vite with scripts/qa/vite.qa.config.mjs and
scripts/qa/route-server.ts. See docs/qa/ARCADE.md.

  python3 scripts/qa/play-modes.py out.json [mode,mode ...] [map,map ...]
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

ROUTES = 'http://localhost:5418'
METRICS = 'http://localhost:3417/metrics'
MODES = ['tdm', 'ffa', 'gungame', 'elimination', 'hardpoint', 'domination', 'ctf']
ALL_MAPS = ['classic', 'suburb', 'quarter', 'dockyard', 'desert', 'atomic', 'bunker', 'villa', 'yacht', 'town', 'station']
SCORE = {'tdm': 10, 'ffa': 10, 'gungame': 10, 'elimination': 2, 'hardpoint': 100, 'domination': 50, 'ctf': 1}
TIME = {'elimination': 90}

DRIVER = """
() => {
  if (window.__drv) return;
  const g = window.game, inp = g.input;
  const d = window.__drv = { mode: 'idle', path: null, i: 0, stuck: [], target: 0, shots: 0, lastProgress: 0, done: false, wanderYaw: 0, nextTurn: 0 };
  const release = () => { for (const k of ['KeyW', 'KeyA', 'KeyD', 'Space', 'Mouse0']) inp.down.delete(k); };
  const solid = (x, y, z) => { const id = g.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); return id !== 0; };
  d.los = (ax, ay, az, bx, by, bz) => {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz), n = Math.ceil(len / 0.15);
    for (let k = 1; k < n; k++) { const t = k / n; if (solid(ax + dx * t, ay + dy * t, az + dz * t)) return false; }
    return true;
  };
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  d.follow = (path) => { d.mode = 'path'; d.path = path; d.i = 1; d.done = false; d.lastProgress = performance.now(); };
  d.wander = () => { d.mode = 'wander'; d.nextTurn = 0; d.lastProgress = performance.now(); d.lastPos = [g.player.x, g.player.z]; };
  d.stop = () => { d.mode = 'idle'; release(); };
  const tick = () => {
    requestAnimationFrame(tick);
    const p = g.player, now = performance.now();
    g.input.locked = true;
    if (g.state === 'paused') g.state = 'playing';
    const a = g.arcade;
    if (!a || a.dead) { release(); return; }
    // Fight: when the target is visible, aim at its chest and fire; this overrides walking.
    if (d.target && g.remote.pose(d.target, pose) && g.remote.isAlive(d.target)) {
      const ex = p.x, ey = p.y + 1.62, ez = p.z, tx = pose.x, ty = pose.y + 1.25, tz = pose.z;
      const dist = Math.hypot(tx - ex, tz - ez);
      if (dist < 70 && d.los(ex, ey, ez, tx, ty, tz)) {
        p.yaw = Math.atan2(-(tx - ex), -(tz - ez));
        p.pitch = Math.atan2(ty - ey, dist);
        // Short-range weapons (shotgun, knife in gun game) close in while shooting.
        if (dist > Math.max(6, a.weapon.range * 0.8)) { inp.down.add('KeyW'); if (((now / 500) | 0) % 3 === 0) inp.down.add('Space'); else inp.down.delete('Space'); }
        else { inp.down.delete('KeyW'); inp.down.delete('Space'); }
        if (a.weapon.auto) inp.down.add('Mouse0');
        else if (((now / 120) | 0) % 2) inp.pressed.add('Mouse0');
        d.shots++;
        d.lastProgress = now;
        return;
      }
    }
    inp.down.delete('Mouse0');
    if (d.mode === 'path' && d.path) {
      const w = d.path[d.i];
      if (!w) { d.done = true; d.mode = 'idle'; release(); return; }
      const tx = w[0] + 0.5, ty = w[1], tz = w[2] + 0.5, dx = tx - p.x, dz = tz - p.z, dd = Math.hypot(dx, dz);
      if (dd < 0.5 && Math.abs(p.y - ty) < 0.6) { d.i++; d.lastProgress = now; return; }
      p.yaw = Math.atan2(-dx, -dz); p.pitch = -0.1;
      inp.down.add('KeyW');
      const prev = d.path[d.i - 1];
      const gap = Math.abs(w[0] - prev[0]) + Math.abs(w[2] - prev[2]) >= 2;
      if ((ty > p.y + 0.4 && dd < 1.4) || (gap && dd < 2.4 && dd > 0.8)) inp.down.add('Space'); else inp.down.delete('Space');
      if (now - d.lastProgress > 3000) {
        d.stuck.push({ at: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], wp: w, t: now });
        d.mode = 'idle'; release();
      }
    } else if (d.mode === 'wander') {
      if (now > d.nextTurn) { d.wanderYaw = Math.random() * Math.PI * 2; d.nextTurn = now + 1200 + Math.random() * 1500; }
      p.yaw = d.wanderYaw; p.pitch = 0;
      inp.down.add('KeyW');
      if (((now / 700) | 0) % 2 === 0) inp.down.add('Space'); else inp.down.delete('Space');
      if (Math.hypot(p.x - d.lastPos[0], p.z - d.lastPos[1]) > 1) { d.lastPos = [p.x, p.z]; d.lastProgress = now; }
      else if (now - d.lastProgress > 700) { d.wanderYaw += Math.PI / 2; d.lastProgress = now; }
    }
  };
  requestAnimationFrame(tick);
}
"""


def get(url):
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def cheat_counts():
    out = {}
    with urllib.request.urlopen(METRICS) as r:
        for line in r.read().decode().splitlines():
            if line.startswith('bunkcraft_cheat_events_total{'):
                k, v = line.rsplit(' ', 1)
                out[k[len('bunkcraft_cheat_events_total'):]] = float(v)
    return out


def state(page):
    return page.evaluate("""() => {
      const g = window.game, p = g.player, a = g.arcade;
      const solid = (x, y, z) => g.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;
      return { id: g.net?.selfId ?? g.arcade?.d?.selfId, x: p.x, y: p.y, z: p.z, onGround: p.onGround,
        inBlock: solid(p.x, p.y + 0.1, p.z) || solid(p.x, p.y + 1.5, p.z), team: a?.team, phase: a?.phase, dead: a?.dead,
        map: g.arenaMap, health: a?.health, weapon: a?.weapon?.id, state: g.state };
    }""")


def path(map_id, seed, a, b):
    frm = f"{a[0]:.2f},{a[1]:.2f},{a[2]:.2f}"
    to = f"{b[0]:.2f},{b[1]:.2f},{b[2]:.2f}"
    return get(f'{ROUTES}/path?map={map_id}&seed={seed}&from={frm}&to={to}').get('path')


def msgs(page, kind=None):
    return page.evaluate('(k) => __qa.msgs.filter((m) => !k || m.t === k)', kind)


def walk_to(page, map_id, seed, target, timeout, stop_when=None):
    """Follows a planned path to target; re-plans after a stall. Returns (arrived, stucks)."""
    t0 = time.time()
    stucks = []
    while time.time() - t0 < timeout:
        s = state(page)
        if s['dead']:
            time.sleep(0.5)
            continue
        if abs(s['x'] - target[0]) + abs(s['z'] - target[2]) < 1.6 and abs(s['y'] - target[1]) < 1.5:
            return True, stucks
        pth = path(map_id, seed, (s['x'], s['y'], s['z']), target)
        if not pth:
            return False, stucks + [{'noPath': [round(s['x'], 1), round(s['y'], 1), round(s['z'], 1)]}]
        page.evaluate('(p) => __drv.follow(p)', pth)
        while time.time() - t0 < timeout:
            time.sleep(0.4)
            if stop_when and stop_when():
                return True, stucks
            d = page.evaluate('() => ({ mode: __drv.mode, done: __drv.done, stuck: __drv.stuck.length, dead: game.arcade?.dead })')
            if d['dead']:
                break
            if d['mode'] == 'idle':
                if d['stuck'] > len(stucks):
                    stucks = page.evaluate('() => __drv.stuck')
                break
    return False, stucks


def run_combo(browser, mode, map_id, shots_taken):
    res = {'mode': mode, 'map': map_id, 'notes': []}
    code = q.create_room(mode, map_id, SCORE[mode], TIME.get(mode, 300), name=f'QA {mode} {map_id}')
    ctx_a, ctx_b = browser.new_context(viewport={'width': 1280, 'height': 720}), browser.new_context(viewport={'width': 960, 'height': 540})
    logs = []
    pages = []
    for ctx, name in ((ctx_a, 'Alpha'), (ctx_b, 'Bravo')):
        page = ctx.new_page()
        page.on('pageerror', lambda e, n=name: logs.append(f'{n} pageerror: {e}'))
        page.on('console', lambda m, n=name: logs.append(f'{n} {m.type}: {m.text}') if m.type == 'error' else None)
        page.goto(q.VITE + '/')
        page.wait_for_function('() => window.game && window.game.state === "menu" && !!window.game.world', timeout=60000)
        time.sleep(0.5)
        q.join_room(page, code, name)
        page.evaluate(DRIVER)
        pages.append(page)
    a, b = pages
    seed = a.evaluate('() => game.meta.seed')
    sa, sb = state(a), state(b)
    res['mapLoaded'] = sa['map']
    if sa['map'] != map_id:
        res['notes'].append(f"map fell back to {sa['map']}")
    map_used = sa['map']
    res['teams'] = [sa['team'], sb['team']]
    # Live.
    t0 = time.time()
    while time.time() - t0 < 30 and a.evaluate('() => game.arcade?.phase') != 'live':
        time.sleep(0.5)
    res['live'] = a.evaluate('() => game.arcade?.phase') == 'live'
    res['liveAfter'] = round(time.time() - t0, 1)
    time.sleep(1.2)
    # Spawn checks (both players), right after the live respawn.
    spawns = []
    for page in pages:
        s = state(page)
        spawns.append(s)
    res['spawn'] = [{'pos': [round(s['x'], 2), round(s['y'], 2), round(s['z'], 2)], 'onGround': s['onGround'], 'inBlock': s['inBlock']} for s in spawns]
    sa, sb = spawns
    res['spawnDist'] = round(((sa['x'] - sb['x']) ** 2 + (sa['z'] - sb['z']) ** 2) ** 0.5, 1)
    res['spawnLOS'] = a.evaluate('([x,y,z]) => __drv.los(game.player.x, game.player.y + 1.62, game.player.z, x, y + 1.4, z)', [sb['x'], sb['y'], sb['z']])
    cheat0 = cheat_counts()
    ida = a.evaluate('() => game.net.selfId ?? 0') if a.evaluate('() => !!game.net && "selfId" in game.net') else None
    ids = a.evaluate('() => game.arcade ? [...game.arcade.players.keys()] : []')
    idb = b.evaluate('() => game.arcade ? [...game.arcade.players.keys()] : []')
    # The self id is the one key both know about only on their own side first; use the roster names instead.
    roster = a.evaluate('() => game.arcade.roster.map((r) => [r.id, r.name])')
    by_name = {n: i for i, n in roster}
    id_a, id_b = by_name.get('Alpha'), by_name.get('Bravo')
    res['ids'] = [id_a, id_b]
    del ida, ids, idb

    goal = {}
    if mode in ('tdm', 'ffa', 'gungame', 'elimination'):
        # Both hunt each other: Alpha walks to Bravo, both shoot on sight.
        a.evaluate(f'() => {{ __drv.target = {id_b}; }}')
        b.evaluate(f'() => {{ __drv.target = {id_a}; }}')
        b.evaluate('() => __drv.wander()')
        t1 = time.time()
        killed = lambda: len(msgs(a, 'kill')) > 0  # noqa: E731
        stucks = []
        while time.time() - t1 < 50 and not killed():
            sb_ = state(b)
            ok, st = walk_to(a, map_used, seed, (sb_['x'], sb_['y'], sb_['z']), 6, killed)
            stucks += st
        goal['kill'] = killed()
        goal['killAfter'] = round(time.time() - t1, 1)
        goal['stucks'] = stucks
        kills = msgs(a, 'kill')
        goal['kills'] = [(k['killer'], k['victim'], k['weapon'], k['head']) for k in kills]
        hits = msgs(a, 'hit') + msgs(b, 'hit')
        goal['hits'] = len(hits)
        goal['shotsFrames'] = a.evaluate('() => __drv.shots') + b.evaluate('() => __drv.shots')
        ev = [m['kind'] for m in msgs(a, 'event') + msgs(b, 'event')]
        goal['events'] = sorted(set(ev))
        if mode == 'gungame':
            goal['levelUp'] = 'level-up' in ev
        if mode == 'elimination':
            time.sleep(2)
            goal['mode'] = a.evaluate('() => __qa.mode')
            goal['roundWin'] = 'round-win' in ev or 'round-win' in [m['kind'] for m in msgs(a, 'event')]
    elif mode in ('hardpoint', 'domination'):
        st = a.evaluate('() => __qa.mode')
        zones = st['zones'] if st else []
        if mode == 'hardpoint':
            target = next((z for z in zones if z['active']), zones[0] if zones else None)
        else:
            s = state(a)
            target = min(zones, key=lambda z: (z['x'] - s['x']) ** 2 + (z['z'] - s['z']) ** 2) if zones else None
        goal['zone'] = target and target['name']
        if target:
            t1 = time.time()
            ok, stucks = walk_to(a, map_used, seed, (target['x'], target['y'], target['z']), 40)
            goal['reached'] = ok
            goal['reachAfter'] = round(time.time() - t1, 1)
            goal['stucks'] = stucks
            score0 = a.evaluate('() => game.arcade.scores')
            time.sleep(9 if mode == 'domination' else 6)
            score1 = a.evaluate('() => game.arcade.scores')
            team = state(a)['team']
            goal['scoreGain'] = score1[team] - score0[team]
            zs = a.evaluate('() => __qa.mode.zones')
            goal['owner'] = next((z['owner'] for z in zs if z['name'] == target['name']), None)
            goal['events'] = sorted(set(m['kind'] for m in msgs(a, 'event')))
    elif mode == 'ctf':
        st = a.evaluate('() => __qa.mode')
        team = state(a)['team']
        flags = {f['team']: f for f in st['flags']} if st else {}
        enemy = 'blue' if team == 'red' else 'red'
        if flags:
            ef, of = flags[enemy], flags[team]
            t1 = time.time()
            taken = lambda: any(m['kind'] == 'flag-taken' for m in msgs(a, 'event'))  # noqa: E731
            ok, stucks = walk_to(a, map_used, seed, (ef['x'], ef['y'], ef['z']), 45, taken)
            goal['taken'] = taken()
            goal['takeAfter'] = round(time.time() - t1, 1)
            hx, hy, hz = of['hx'], of['hy'], of['hz']
            captured = lambda: any(m['kind'] == 'flag-captured' for m in msgs(a, 'event'))  # noqa: E731
            ok2, st2 = walk_to(a, map_used, seed, (hx, hy, hz), 45, captured)
            time.sleep(1)
            goal['captured'] = captured()
            goal['captureAfter'] = round(time.time() - t1, 1)
            goal['stucks'] = stucks + st2
            goal['events'] = sorted(set(m['kind'] for m in msgs(a, 'event')))
    # Bravo wanders a bit as an honest bunny-hopper if it did not already.
    b.evaluate('() => __drv.wander()')
    time.sleep(3)
    res['goal'] = goal
    shot_name = f'play-{mode}-{map_used}.png'
    a.evaluate('() => __drv.stop()')
    q.shot(a, shot_name)
    res['shot'] = shot_name
    for page, nm in ((a, 'Alpha'), (b, 'Bravo')):
        tps = msgs(page, 'teleport')
        res[f'teleports{nm}'] = [[round(t['x'], 1), round(t['y'], 1), round(t['z'], 1)] for t in tps]
        kicks = msgs(page, 'kick')
        if kicks:
            res['notes'].append(f'{nm} kicked: {kicks}')
    cheat1 = cheat_counts()
    res['cheatEvents'] = {k: v - cheat0.get(k, 0) for k, v in cheat1.items() if v - cheat0.get(k, 0) > 0}
    res['errors'] = logs[:8]
    ctx_a.close()
    ctx_b.close()
    return res


def main():
    out = sys.argv[1]
    modes = sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else MODES
    maps = sys.argv[3].split(',') if len(sys.argv) > 3 else ALL_MAPS
    results = []
    shots_taken = [0]
    with sync_playwright() as pw:
        browser = q.launch(pw)
        for mode in modes:
            for map_id in maps:
                t = time.time()
                try:
                    r = run_combo(browser, mode, map_id, shots_taken)
                except Exception as e:  # keep going: one broken combination must not hide the others
                    r = {'mode': mode, 'map': map_id, 'error': repr(e)[:400]}
                r['seconds'] = round(time.time() - t, 1)
                results.append(r)
                g = r.get('goal', {})
                print(f"{mode:12} {map_id:9} live={r.get('live')} spawnDist={r.get('spawnDist')} los={r.get('spawnLOS')} "
                      f"goal={ {k: v for k, v in g.items() if k not in ('stucks', 'kills', 'mode')} } stucks={len(g.get('stucks', []))} "
                      f"tp={len(r.get('teleportsAlpha', []))}/{len(r.get('teleportsBravo', []))} cheat={r.get('cheatEvents')} "
                      f"err={len(r.get('errors', []))} {r.get('error', '')} {r.get('notes', '')}", flush=True)
                json.dump(results, open(out, 'w'), indent=1)
        browser.close()


main()
