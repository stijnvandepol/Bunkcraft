"""
Arcade movement in a real match: a browser player slides and slide-hops in a live team deathmatch on a real
server, a teammate in a second browser watches the slide pose arrive over the network, and the server must
not correct either of them. Saves a frame sequence of the slide (first person) and of the remote slider to
docs/screenshots/arcade/.

  PORT=3412 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts
  QA_SERVER_PORT=3412 npx vite --config scripts/qa/vite.qa.config.mjs --port 5412
  QA_VITE=http://localhost:5412 QA_SERVER=http://localhost:3412 python3 scripts/qa/slide-check.py [map=classic]

Exits 0 when every check passed.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

map_id = sys.argv[1] if len(sys.argv) > 1 else 'classic'
server = os.environ.get('QA_SERVER', 'http://localhost:3412')
OUT = 'docs/screenshots/arcade'
os.makedirs(OUT, exist_ok=True)
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  ({detail})' if detail else ''))


def pump(*pages, n=1, dt=0.05):
    for _ in range(n):
        for p in pages:
            p.bring_to_front()
        time.sleep(dt)


# Samples the local player every animation frame for `ms` milliseconds while the script presses keys.
TRACE = """
async ([ms, actions]) => {
  const g = window.game, p = g.player, inp = g.input;
  const out = [];
  const t0 = performance.now();
  return await new Promise((resolve) => {
    function frame(now) {
      const t = now - t0;
      for (const a of actions) {
        if (!a.done && t >= a.at) {
          a.done = true;
          if (a.down) { inp.down.add(a.key); inp.pressed.add(a.key); } else inp.down.delete(a.key);
        }
      }
      out.push({ t, speed: Math.hypot(p.vx, p.vz), sliding: p.sliding, crouching: p.crouching, ground: p.onGround,
        eye: p.eye, y: p.y, slides: p.slideStarts, run: 5.61 * p.speedMultiplier, fov: g.cam.camera.fov });
      if (t < ms) requestAnimationFrame(frame); else resolve(out);
    }
    requestAnimationFrame(frame);
  });
}
"""

with sync_playwright() as pw:
    browser = q.launch(pw)
    logs = []
    a = q.open_game(browser, 1280, 720, logs)
    b = q.open_game(browser, 1280, 720, logs)
    c = q.open_game(browser, 640, 360, logs)
    print('gpu', q.gpu(a), file=sys.stderr)
    code = q.create_room('tdm', map_id, score=1000, time_limit=1800, name='Slide check')
    q.join_room(a, code, 'Slider')
    # An idle third player fills the other team, so the watcher joins the slider's team (teammates are never culled).
    q.join_room(c, code, 'Idle')
    q.join_room(b, code, 'Watcher')
    for p in (a, b):
        p.add_style_tag(content='.click-to-play { display: none !important; }')
    # Wait for the match to go live (10 s warm-up once two players are in).
    for _ in range(400):
        pump(a, b)
        if a.evaluate('() => window.game.arcade && window.game.arcade.phase') == 'live':
            break
    check('the match is live', a.evaluate('() => window.game.arcade.phase') == 'live')
    pump(a, b, n=20)
    q.force_playing(a)
    q.force_playing(b)
    ids = a.evaluate('() => [window.game.net.id, window.game.arcade.team]')
    team_b = b.evaluate('() => window.game.arcade.team')
    check('watcher and slider are teammates', ids[1] == team_b and ids[1] != '', f'{ids[1]} / {team_b}')
    slider_id = ids[0]

    # Face the open middle of the map from the spawn and keep the watcher looking at the slider.
    a.evaluate('() => { const p = window.game.player; p.yaw = Math.atan2(p.x, p.z); p.pitch = 0; }')
    look = f"""() => {{
      const g = window.game, me = g.player, o = {{ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }};
      if (!g.remote.pose({slider_id}, o)) return false;
      me.yaw = Math.atan2(me.x - o.x, me.z - o.z);
      me.pitch = -Math.atan2(me.y + 1.62 - (o.y + 0.8), Math.hypot(o.x - me.x, o.z - me.z));
      return true;
    }}"""
    teleports_before = a.evaluate("() => window.__qa.msgs.filter((m) => m.t === 'teleport').length")

    # Run 0.8 s, slide (crouch press), then hold the slide; trace every frame.
    a.bring_to_front()
    trace = a.evaluate(TRACE, [1700, [
        {'at': 0, 'key': 'KeyW', 'down': True},
        {'at': 800, 'key': 'KeyC', 'down': True},
        {'at': 1650, 'key': 'KeyC', 'down': False},
    ]])
    run = trace[0]['run']
    slide = [f for f in trace if f['sliding']]
    peak = max((f['speed'] for f in trace), default=0)
    check('a slide starts on the crouch press while running', len(slide) > 0 and trace[-1]['slides'] >= 1)
    check('the slide bursts to about 1.45 x the run speed', 1.3 * run < peak <= 1.46 * run, f'peak {peak:.2f}, run {run:.2f}')
    check('the camera drops into the slide', min((f['eye'] for f in slide), default=9) < 1.15)
    check('the slide FOV kick', max((f['fov'] for f in slide), default=0) > trace[0]['fov'] + 1)
    # First person, mid-slide.
    pump(a, n=24)
    a.evaluate('() => { const p = window.game.player; p.yaw += Math.PI; const i = window.game.input; i.down.add("KeyW"); }')
    pump(a, n=16)
    a.evaluate('() => { const i = window.game.input; i.down.add("KeyC"); i.pressed.add("KeyC"); }')
    pump(a, n=3, dt=0.04)
    a.screenshot(path=f'{OUT}/slide-first-person.png')
    a.evaluate('() => { const i = window.game.input; i.down.delete("KeyW"); i.down.delete("KeyC"); }')

    # Slide-hop: slide, then jump out of it after 0.15 s; the momentum must survive the air time.
    pump(a, n=24)
    a.bring_to_front()
    trace2 = a.evaluate(TRACE, [1600, [
        {'at': 0, 'key': 'KeyW', 'down': True},
        {'at': 300, 'key': 'KeyC', 'down': True},
        {'at': 450, 'key': 'Space', 'down': True},
        {'at': 470, 'key': 'KeyC', 'down': False},
        {'at': 520, 'key': 'Space', 'down': False},
    ]])
    if os.environ.get('QA_DEBUG'):
        for f in trace2[::4]:
            print(f"{f['t']:.0f} v={f['speed']:.2f} slide={f['sliding']} ground={f['ground']} y={f['y']:.2f} n={f['slides']}", file=sys.stderr)
    air = [f for f in trace2 if not f['ground'] and f['t'] > 470]
    hop_speed = min((f['speed'] for f in air[:20]), default=0)
    check('a slide-hop keeps the slide speed in the air', len(air) > 5 and hop_speed > 1.2 * run, f'{hop_speed:.2f} vs run {run:.2f}')

    # Frame sequence of a slide seen by the teammate.
    a.evaluate('() => { const i = window.game.input; i.down.delete("KeyW"); i.down.delete("KeyC"); }')
    pump(a, b, n=30)
    # The slider runs across the watcher's view (sideways to the line between them), on a free lane.
    toward = f"""() => {{
      const g = window.game, me = g.player, o = {{ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }};
      const id = g.arcade.roster.find((r) => r.name === 'Watcher')?.id;
      if (!id || !g.remote.pose(id, o)) return false;
      const d = Math.hypot(o.x - me.x, o.z - me.z) || 1;
      const free = (dx, dz) => {{
        for (let k = 1; k <= 7; k++) for (const h of [1, 2]) if (g.getBlock(Math.floor(me.x + dx * k), Math.floor(me.y) + h - 1, Math.floor(me.z + dz * k)) !== 0) return false;
        return true;
      }};
      let best = null;
      for (const s of [1, -1]) {{
        const dx = s * (o.z - me.z) / d, dz = -s * (o.x - me.x) / d;
        if (free(dx, dz)) {{ best = [dx, dz]; break; }}
      }}
      if (!best) best = [(me.x - o.x) / d, (me.z - o.z) / d];
      me.yaw = Math.atan2(-best[0], -best[1]);
      return d;
    }}"""
    dist = a.evaluate(toward)
    print('slider to watcher', dist, file=sys.stderr)
    b.evaluate(look)
    a.evaluate('() => { const i = window.game.input; i.down.add("KeyW"); }')
    pump(a, b, n=8)
    a.evaluate('() => { const i = window.game.input; i.down.add("KeyC"); i.pressed.add("KeyC"); }')
    seen_flag = False
    for k in range(6):
        pump(a, b, n=2, dt=0.04)
        b.evaluate(look)
        seen_flag = seen_flag or bool(b.evaluate(f'() => (window.game.remote.flagsOf({slider_id}) & 64) !== 0'))
        b.screenshot(path=f'{OUT}/slide-remote-{k}.png')
    a.evaluate('() => { const i = window.game.input; i.down.delete("KeyW"); i.down.delete("KeyC"); }')
    check('the teammate receives the slide pose (snapshot flag)', seen_flag)
    pump(a, b, n=20)
    teleports = a.evaluate("() => window.__qa.msgs.filter((m) => m.t === 'teleport').length") - teleports_before
    check('the server never corrected the slider', teleports == 0, f'{teleports} teleports')
    bad = [l for l in logs if 'pageerror' in l]
    check('no page errors', not bad, '; '.join(bad[:2]))
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{'all %d checks passed' % len(results) if not failed else '%d of %d checks FAILED' % (len(failed), len(results))}")
sys.exit(1 if failed else 0)
