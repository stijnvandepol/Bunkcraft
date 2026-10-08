"""
Aim feel numbers in a local preview match (bots, real renderer): mouse-to-camera latency, how much of a mouse delta reaches
the view in the frame that reads it (smoothing), flick settle and overshoot, sway at rest while aiming, the aim-down-sights
time to full zoom, and the recoil climb and recovery of a spray.

  QA_SERVER_PORT=3743 npx vite --config scripts/qa/vite.qa.config.mjs --port 5743
  QA_VITE=http://localhost:5743 python3 scripts/qa/aim-feel.py [out.json]

Mouse movement comes from real (CDP) mouse events; Pointer Lock does not exist in automation, so `document.pointerLockElement`
is pointed at the canvas and the game's own mousemove handler takes the events as if locked. Every frame the camera's angles
are logged right after the render call.
"""
import json
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

SETUP = """() => {
  const g = window.game, cam = g.cam.camera, canvas = document.getElementById('game');
  Object.defineProperty(document, 'pointerLockElement', { get: () => canvas, configurable: true });
  const L = window.__aim = { frames: [], events: [], mark: 0 };
  const r = g.renderer, orig = r.render.bind(r);
  r.render = (...a) => {
    orig(...a);
    L.frames.push([performance.now(), cam.rotation.y, cam.rotation.x, cam.fov, g.player.yaw, g.player.pitch]);
    if (L.frames.length > 6000) L.frames.splice(0, 3000);
  };
  document.addEventListener('mousemove', (e) => L.events.push([e.timeStamp, e.movementX, e.movementY]));
}"""

DEG = 180 / 3.141592653589793


def equip(page, wid, optic):
    page.evaluate(f"() => {{ game.arcade.applyGear('{wid}', 'pistol', '{optic}', 'none'); game.arcade.equipSlot(0, false); }}")
    time.sleep(0.6)


def reset_view(page):
    page.evaluate('() => { game.player.yaw = 0.3; game.player.pitch = 0; game.arcade.recoil.reset(); }')


def clear(page):
    page.evaluate('() => { __aim.frames.length = 0; __aim.events.length = 0; }')


def frames(page):
    return page.evaluate('() => __aim.frames.slice()')


def latency(page, n=40):
    """Event timestamp -> end of the render call of the first frame whose camera moved; share of the delta in that frame."""
    clear(page)
    x = 640
    for i in range(n):
        x += 24 if i % 2 == 0 else -24
        page.mouse.move(x, 360)
        time.sleep(0.09 + (i % 7) * 0.004)
    res = page.evaluate("""() => {
      const F = __aim.frames, E = __aim.events, out = [];
      for (const [t, mx] of E) {
        if (mx === 0) continue;
        let i = F.findIndex((f) => f[0] > t);
        if (i < 1) continue;
        // First frame after the event whose yaw changed.
        let j = i;
        while (j < F.length && Math.abs(F[j][1] - F[j - 1][1]) < 1e-9) j++;
        if (j >= F.length - 8) continue;
        const total = F[j + 6][1] - F[j - 1][1];
        const first = F[j][1] - F[j - 1][1];
        out.push({ ms: F[j][0] - t, frames: j - i + 1, share: total !== 0 ? first / total : 0, ft: F[j][0] - F[j - 1][0] });
      }
      return out;
    }""")
    return res


def flick(page, ads, px=320):
    """One big mouse move; how the view settles: overshoot and time to settle within 0.02 degrees of where it ends up."""
    page.evaluate("() => game.input.down.add('Mouse2')" if ads else "() => game.input.down.delete('Mouse2')")
    time.sleep(1.2)
    clear(page)
    time.sleep(0.15)
    page.mouse.move(640, 360)
    time.sleep(0.05)
    page.evaluate('() => { __aim.mark = performance.now(); }')
    page.mouse.move(640 + px, 360)
    time.sleep(0.5)
    r = page.evaluate("""() => {
      const F = __aim.frames, m = __aim.mark;
      const k = F.findIndex((f) => f[0] > m);
      const base = F[k - 1][1], end = F[F.length - 1][1];
      const span = end - base;
      let over = 0, settle = 0;
      for (let i = k; i < F.length; i++) {
        const d = (F[i][1] - base) / (span || 1);
        over = Math.max(over, d - 1);
        if (Math.abs(F[i][1] - end) * 57.2958 > 0.02) settle = F[i][0] - m;
      }
      // Frames from the event to the view reaching 95% of the turn.
      let reach = -1;
      for (let i = k; i < F.length; i++) if (Math.abs(F[i][1] - base) >= 0.95 * Math.abs(span)) { reach = F[i][0] - m; break; }
      return { turnDeg: span * 57.2958, overshootPct: over * 100, settleMs: settle, reach95Ms: reach };
    }""")
    page.evaluate("() => game.input.down.delete('Mouse2')")
    time.sleep(0.5)
    return r


def sway(page, sec=2.0):
    """Peak-to-peak drift of the view with the sights up and no input (degrees)."""
    page.evaluate("() => game.input.down.add('Mouse2')")
    time.sleep(1.5)
    clear(page)
    time.sleep(sec)
    f = frames(page)
    page.evaluate("() => game.input.down.delete('Mouse2')")
    time.sleep(0.5)
    ys = [r[1] for r in f]
    ps = [r[2] for r in f]
    return {'yawPP': (max(ys) - min(ys)) * DEG, 'pitchPP': (max(ps) - min(ps)) * DEG}


def ads_time(page):
    """Seconds from the aim button to the field of view within 1% (and 10%) of the aimed field of view."""
    page.evaluate("() => game.input.down.delete('Mouse2')")
    time.sleep(1.0)
    clear(page)
    t0 = page.evaluate("() => { game.input.down.add('Mouse2'); return performance.now(); }")
    time.sleep(1.0)
    f = frames(page)
    page.evaluate("() => game.input.down.delete('Mouse2')")
    time.sleep(0.6)
    hip = f[0][3]
    end = f[-1][3]
    t99 = next((r[0] - t0 for r in f if r[0] > t0 and abs(r[3] - end) <= abs(hip - end) * 0.01), -1)
    t90 = next((r[0] - t0 for r in f if r[0] > t0 and abs(r[3] - end) <= abs(hip - end) * 0.1), -1)
    return {'hipFov': hip, 'adsFov': end, 'to90Ms': t90, 'to99Ms': t99}


def recoil(page, hold=1.0):
    """Hold the trigger aimed (`hold` seconds), let go: peak climb, rest climb, time back within 0.05 degrees of the rest."""
    page.evaluate("() => { game.arcade.ammo.forEach((a) => { a.mag = 60; a.reloading = false; }); game.input.down.add('Mouse2'); }")
    time.sleep(1.2)
    reset_view(page)
    time.sleep(0.2)
    clear(page)
    page.evaluate("() => { __aim.mark = performance.now(); game.input.down.add('Mouse0'); }")
    time.sleep(hold)
    rel = page.evaluate("() => { game.input.down.delete('Mouse0'); return performance.now(); }")
    time.sleep(1.2)
    f = frames(page)
    page.evaluate("() => { game.input.down.delete('Mouse2'); game.arcade.ammo.forEach((a) => { a.mag = 60; a.reloading = false; }); }")
    time.sleep(0.4)
    base = f[0][5]
    peak = max(r[5] for r in f) - base
    rest = f[-1][5] - base
    back = 0.0
    for r in f:
        if r[0] > rel and abs(r[5] - f[-1][5]) * DEG > 0.05:
            back = r[0] - rel
    yaws = [r[4] for r in f]
    return {'peakDeg': peak * DEG, 'restDeg': rest * DEG, 'recoverMs': back, 'yawSpreadDeg': (max(yaws) - min(yaws)) * DEG}


def fps(page):
    f = frames(page)
    dts = [b[0] - a[0] for a, b in zip(f, f[1:])]
    return 1000 / statistics.mean(dts) if dts else 0


def summarize(rows):
    ms = [r['ms'] for r in rows]
    share = [r['share'] for r in rows]
    return {
        'n': len(rows), 'meanMs': statistics.mean(ms), 'p95Ms': sorted(ms)[int(len(ms) * 0.95) - 1], 'maxMs': max(ms),
        'firstFrameShareMin': min(share), 'firstFrameShareMean': statistics.mean(share), 'framesMax': max(r['frames'] for r in rows),
        'frameMs': statistics.mean(r['ft'] for r in rows),
    }


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'tdm', 'classic')
    time.sleep(2)
    q.force_playing(page)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    page.evaluate(SETUP)
    gpu = q.gpu(page)
    out = {'gpu': gpu, 'sensitivity': page.evaluate('() => game.settings.values.sensitivity'), 'rawInput': page.evaluate('() => game.settings.values.rawInput')}
    equip(page, 'rifle', 'iron')
    reset_view(page)
    time.sleep(0.5)
    out['fps'] = fps(page)
    out['latencyHip'] = summarize(latency(page))
    out['flickHip'] = flick(page, False)
    out['flickAds'] = flick(page, True, 160)
    out['latencyAds'] = None
    page.evaluate("() => game.input.down.add('Mouse2')")
    time.sleep(1.0)
    out['latencyAds'] = summarize(latency(page, 30))
    page.evaluate("() => game.input.down.delete('Mouse2')")
    time.sleep(0.5)
    combos = [('rifle', 'iron'), ('rifle', 'reddot'), ('rifle', 'holo'), ('lmg', 'iron'), ('rifle', 'combat'), ('dmr', 'scope'), ('sniper', 'scope')]
    out['ads'] = {}
    for wid, optic in combos:
        equip(page, wid, optic)
        reset_view(page)
        out['ads'][f'{wid}:{optic}'] = {**ads_time(page), **sway(page)}
    out['recoil'] = {}
    for wid in ('rifle', 'smg', 'lmg', 'battle'):
        equip(page, wid, 'iron')
        out['recoil'][wid] = recoil(page)
    print(json.dumps(out, indent=1))
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'w') as fh:
            json.dump(out, fh, indent=1)
    print('\n'.join(logs[:10]) or 'no console errors')
    b.close()
