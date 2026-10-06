"""
QA: walks every map with the real player physics (arcade preview, no server) along the tour from
walk-routes.ts: every high spot, every raised platform and a floor grid. Reports legs where the
player gets stuck (no progress for 2.5 s), falls off the route, or leaves the arena, with a
screenshot per incident in docs/qa/shots/arcade/walk-<map>-<n>.png.

  npx tsx scripts/qa/walk-routes.ts /tmp/routes.json
  python3 scripts/qa/walk-maps.py /tmp/routes.json [mapId ...]
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

DRIVER = """
(route) => {
  const g = window.game, p = g.player, inp = g.input;
  const legs = route.legs;
  const st = window.__walk = { leg: 0, i: 0, done: false, events: [], paused: false, steps: 0, teleports: 0, legTimes: [], dist: 0 };
  let lastProgress = performance.now(), legStart = performance.now(), unstickPhase = 0;
  let lastX = p.x, lastZ = p.z;
  const release = () => { inp.down.delete('KeyW'); inp.down.delete('Space'); inp.down.delete('KeyA'); inp.down.delete('KeyD'); };
  const event = (kind, extra) => {
    const leg = legs[st.leg], w = leg.path[st.i];
    st.events.push({ kind, leg: st.leg, label: leg.label, i: st.i, wp: w, pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], ...extra });
  };
  const tick = () => {
    if (st.done) { release(); return; }
    requestAnimationFrame(tick);
    if (st.paused) { release(); lastProgress = performance.now(); return; }
    g.input.locked = true; if (g.state !== 'playing') g.state = 'playing';
    const now = performance.now();
    st.dist += Math.hypot(p.x - lastX, p.z - lastZ); lastX = p.x; lastZ = p.z;
    const leg = legs[st.leg];
    const w = leg.path[st.i];
    const tx = w[0] + 0.5, ty = w[1], tz = w[2] + 0.5;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    const last = st.i === leg.path.length - 1;
    if (d < 0.5 && Math.abs(p.y - ty) < 0.6) {
      st.i++; st.steps++; lastProgress = now; unstickPhase = 0;
      if (st.i >= leg.path.length) {
        st.legTimes.push([leg.label, (now - legStart) / 1000]);
        st.leg++; st.i = 1; legStart = now;
        if (st.leg >= legs.length) { st.done = true; release(); }
      }
      return;
    }
    // Fell below the route (missed a jump, slid off a ledge).
    if (p.onGround && p.y < ty - 1.5 && w[1] > 65) {
      event('fell'); st.paused = true;
      p.setPosition(tx, ty, tz); p.vx = p.vz = 0; st.teleports++;
      return;
    }
    if (p.y < 60 || !(Math.abs(p.x) < 60 && Math.abs(p.z) < 60)) { event('outside'); st.paused = true; p.setPosition(tx, ty, tz); return; }
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = -0.25;
    inp.down.add('KeyW');
    const up = ty > p.y + 0.4;
    // A gap jump: this waypoint is two columns away from the previous one (planned by walk-routes).
    const prev = leg.path[Math.max(0, st.i - 1)];
    const gap = Math.abs(w[0] - prev[0]) + Math.abs(w[2] - prev[2]) >= 2;
    if ((up && d < 1.4) || (gap && d < 2.4 && d > 0.8)) inp.down.add('Space'); else inp.down.delete('Space');
    // Slow down near the target so we do not overshoot onto a drop (but keep going when we are
    // still above it, e.g. hanging on the edge of a neighbouring block).
    if (last && d < 0.55 && p.y < ty + 0.4) inp.down.delete('KeyW');
    if (now - lastProgress > 2500 && unstickPhase === 0) {
      event('stuck'); unstickPhase = 1; st.paused = true;
    } else if (unstickPhase === 1 && now - lastProgress > 1500) {
      // Wiggle: jump and strafe.
      inp.down.add('Space'); inp.down.add(((now / 400) | 0) % 2 ? 'KeyA' : 'KeyD');
      if (now - lastProgress > 4500) {
        event('teleported'); unstickPhase = 0; lastProgress = now;
        p.setPosition(tx, ty, tz); p.vx = p.vz = 0; st.teleports++;
        inp.down.delete('KeyA'); inp.down.delete('KeyD');
      }
    }
  };
  requestAnimationFrame(tick);
}
"""


def main():
    routes = json.load(open(sys.argv[1]))
    maps = sys.argv[2:] or q.MAPS
    summary = {}
    with sync_playwright() as pw:
        browser = q.launch(pw)
        for map_id in maps:
            route = routes[map_id]
            page = q.open_game(browser)
            q.start_preview(page, 'ffa', map_id)
            start = route['legs'][0]['path'][0]
            page.evaluate(f'() => {{ const p = game.player; p.setPosition({start[0] + 0.5}, {start[1]}, {start[2] + 0.5}); }}')
            time.sleep(0.5)
            page.evaluate(DRIVER, route)
            t0 = time.time()
            shots = 0
            seen = 0
            while True:
                time.sleep(0.5)
                st = page.evaluate('() => ({ done: __walk.done, leg: __walk.leg, n: __walk.events.length, paused: __walk.paused, steps: __walk.steps })')
                if st['n'] > seen:
                    ev = page.evaluate(f'() => __walk.events[{st["n"] - 1}]')
                    if ev['kind'] in ('stuck', 'fell', 'outside') and shots < 12:
                        shots += 1
                        q.shot(page, f'walk-{map_id}-{shots}.png')
                        ev['shot'] = f'walk-{map_id}-{shots}.png'
                        page.evaluate(f'(s) => {{ __walk.events[{st["n"] - 1}].shot = s; }}', ev['shot'])
                    seen = st['n']
                if st['paused']:
                    page.evaluate('() => { __walk.paused = false; }')
                if st['done'] or time.time() - t0 > 600:
                    break
            res = page.evaluate('() => __walk')
            res['wall_seconds'] = round(time.time() - t0, 1)
            summary[map_id] = res
            stuck = [e for e in res['events'] if e['kind'] != 'teleported']
            print(f"{map_id}: legs {res['leg']}/{len(route['legs'])}, steps {res['steps']}, walked {res['dist']:.0f} blocks in {res['wall_seconds']} s, "
                  f"incidents {len(stuck)}, teleports {res['teleports']}")
            for e in res['events']:
                print('   ', e['kind'], e['label'], 'wp', e['wp'], 'at', e['pos'], e.get('shot', ''))
            page.close()
        browser.close()
    json.dump(summary, open('/tmp/walk-summary.json' if len(sys.argv) < 2 else sys.argv[1].replace('.json', '-walk.json'), 'w'), indent=1)


main()
