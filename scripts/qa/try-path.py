"""
QA reproduction helper: drives the real player physics (arcade preview, no server) along a list of
block waypoints on a map and reports whether every waypoint was reached. Takes a screenshot at the
end (docs/qa/shots/arcade/<name>.png).

  python3 scripts/qa/try-path.py <map> <name> x,y,z x,y,z ...
  (the first waypoint is the start; y = feet level = the block you stand on + 1)
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

map_id, name = sys.argv[1], sys.argv[2]
wps = [[int(v) for v in a.split(',')] for a in sys.argv[3:]]

DRIVE = """
(wps) => new Promise((done) => {
  const g = window.game, p = g.player, inp = g.input;
  let i = 1, last = performance.now();
  const log = [];
  const tick = () => {
    g.input.locked = true; g.state = 'playing';
    const w = wps[i];
    if (!w) { inp.down.clear(); return done({ ok: true, log }); }
    const tx = w[0] + 0.5, ty = w[1], tz = w[2] + 0.5, dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d < 0.5 && Math.abs(p.y - ty) < 0.6) { log.push(['reached', w, +p.y.toFixed(2)]); i++; last = performance.now(); }
    p.yaw = Math.atan2(-dx, -dz); p.pitch = 0.2;
    inp.down.add('KeyW');
    if (ty > p.y + 0.4 && d < 1.4) inp.down.add('Space'); else inp.down.delete('Space');
    if (performance.now() - last > 4000) { inp.down.clear(); return done({ ok: false, stuckAt: [p.x, p.y, p.z], maxY: log, waypoint: w }); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})
"""

with sync_playwright() as pw:
    b = q.launch(pw)
    page = q.open_game(b)
    q.start_preview(page, 'ffa', map_id)
    s = wps[0]
    page.evaluate(f'() => game.player.setPosition({s[0] + 0.5}, {s[1]}, {s[2] + 0.5})')
    time.sleep(1.5)
    res = page.evaluate(DRIVE, wps)
    print(res)
    time.sleep(0.5)
    print('shot', q.shot(page, f'{name}.png'))
    b.close()
