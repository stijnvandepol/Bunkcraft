"""
Weapon glitch hunt in a real room (real server, real client, Chromium on the GPU): every weapon x optic is driven through
ADS in/out, a spray, reloads, weapon switches during ADS / reload and sniper bolt cycles while every rendered frame is logged
(zoom, ADS blend, viewmodel pose and geometry, scope overlay, ammo counter, recoil) together with the sounds and the `fire`
messages the client sends. The log is searched for the glitches a player sees:

  - ADS: the zoom or the weapon jumping between two frames (snaps), the scope overlay and the gun model disagreeing for a frame
    (flicker), the aim blend not reaching 1 in about the weapon's aim time
  - viewmodel: pose jumps (pops) when switching and when the model changes between its hip and aimed cut
  - shots: fire messages vs gunshot sounds vs ammo counter (double fires, dropped shots), bursts of the wrong size
  - recoil: the aim not coming back after the trigger is released
  - reload: the animation and the ammo counter disagreeing, a fire/ADS during a reload, a switch cancelling it, reload sounds
  - sniper / lever bolt: the cycle sound and animation order, ADS out and in during the bolt

  PORT=3871 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts
  QA_SERVER_PORT=3871 npx vite --config scripts/qa/vite.qa.config.mjs --port 5871
  QA_PROFILE_TOKEN=<token> QA_VITE=http://localhost:5871 python3 scripts/qa/weapon-glitch.py [weapon,weapon] [--sheets] [--out=dir]

A solo room stays in the warm-up (nobody to fight, any class applies at once), which makes it a sandbox for the weapon feel.
`--sheets` also saves contact sheets of the frames around each ADS transition and weapon switch.
"""
import json
import math
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

VITE_HOST = q.VITE.split('//')[1]
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
OPTS = dict(a[2:].split('=', 1) if '=' in a else (a[2:], '1') for a in sys.argv[1:] if a.startswith('--'))
ONLY = ARGS[0].split(',') if ARGS else None
OUT = OPTS.get('out', 'docs/qa/shots/glitch')
SHEETS = 'sheets' in OPTS
findings = []


def finding(tag, kind, detail):
    findings.append((tag, kind, detail))
    print(f'GLITCH  {tag}: {kind} - {detail}', flush=True)


INSTALL = """() => {
  const g = window.game, a = g.arcade, vm = a.viewmodel, cam = g.cam.camera;
  if (window.__gl) return;
  const L = window.__gl = { frames: [], sounds: [], sent: [], geo: new Map(), cap: false, caps: [] };
  const canvas = document.getElementById('game');
  const small = document.createElement('canvas'); small.width = 320; small.height = 180;
  const sctx = small.getContext('2d');
  const scopeEl = document.querySelector('.arc-scope');
  const r = g.renderer, orig = r.render.bind(r);
  r.render = (...args) => {
    orig(...args);
    const geo = vm.weaponMesh.geometry;
    if (!L.geo.has(geo.uuid)) L.geo.set(geo.uuid, L.geo.size);
    const am = a.ammo[a.slot];
    const ret = vm.reticle;
    L.frames.push([
      performance.now(), g.cam.zoom, a.ads, a.adsEased, a.slot, am.mag, am.reloading ? 1 : 0, a.pending,
      vm.root.position.x, vm.root.position.y, vm.root.position.z, vm.root.rotation.x, vm.root.rotation.y, vm.root.rotation.z, vm.root.scale.x,
      vm.weaponMesh.visible ? 1 : 0, L.geo.get(geo.uuid), vm.armsMesh.visible ? 1 : 0, vm.flash.visible ? 1 : 0,
      scopeEl && !scopeEl.classList.contains('hidden') ? 1 : 0, ret && ret.visible ? ret.material.opacity : -1,
      g.player.pitch, g.player.yaw, vm.kick, vm.equip, vm.bolt, a.weapon.id, a.optic, cam.fov,
    ]);
    if (L.cap) { sctx.drawImage(canvas, 0, 0, 320, 180); L.caps.push([performance.now(), small.toDataURL('image/jpeg', 0.7)]); }
  };
  g.audio.addSoundListener((name, x) => L.sounds.push([name, performance.now(), Number.isNaN(x)]));
  const d = a.d, send = d.send;
  d.send = (m) => { if (m.t === 'fire' || m.t === 'reload' || m.t === 'weapon') L.sent.push([m.t, performance.now(), m.slot]); return send(m); };
}"""

FIELDS = ['t', 'zoom', 'ads', 'eased', 'slot', 'mag', 'reloading', 'pending', 'px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx',
          'wvis', 'geo', 'avis', 'flash', 'scope', 'reticle', 'pitch', 'yaw', 'kick', 'equip', 'bolt', 'weapon', 'optic', 'fov']
IDX = {k: i for i, k in enumerate(FIELDS)}


def pump(page, sec):
    end = time.time() + sec
    while time.time() < end:
        page.evaluate("() => { game.input.locked = true; if (game.state !== 'playing') game.state = 'playing'; }")
        time.sleep(0.04)


def hold(page, key, on):
    page.evaluate(f"() => game.input.down.{'add' if on else 'delete'}('{key}')")


def press(page, key):
    page.evaluate(f"() => game.input.pressed.add('{key}')")


def click(page):
    """A real click: pressed for the frame and held until released."""
    page.evaluate("() => { game.input.pressed.add('Mouse0'); game.input.down.add('Mouse0'); }")
    time.sleep(0.04)
    page.evaluate("() => game.input.down.delete('Mouse0')")


def mark(page):
    # The log restarts at every mark (indexes into a trimmed log would slice the wrong frames).
    return page.evaluate('() => { const L = window.__gl; L.frames.length = 0; L.sounds.length = 0; L.sent.length = 0; return [0, 0, 0, performance.now()]; }')


def since(page, m):
    return page.evaluate('(m) => { const L = window.__gl; return { frames: L.frames.slice(m[0]), sounds: L.sounds.slice(m[1]), sent: L.sent.slice(m[2]) }; }', m)


def row(f, k):
    return f[IDX[k]]


def equip(page, primary, optic, secondary='pistol'):
    page.evaluate(f"() => game.arcade.chooseClass({{ primary: '{primary}', optic: '{optic}', secondary: '{secondary}', perk: 'none' }}, false)")
    pump(page, 0.5)
    press(page, 'Digit1')
    pump(page, 0.5)
    page.evaluate('() => { game.player.pitch = 0.5; game.arcade.recoil.reset(); }')  # look at the sky: no hits, readable recoil


def topup(page, w):
    """A full magazine and no reload running (the scenarios must not start in the middle of the previous one's reload)."""
    pump(page, 60 / w['rpm'] + 0.1)  # the previous scenario's last shot must be over (a 2 s bolt)
    for _ in range(3):
        pump(page, 0.1)
        st = page.evaluate('() => ({ r: game.arcade.ammo[game.arcade.slot].reloading, mag: game.arcade.ammo[game.arcade.slot].mag, cap: game.arcade.weapon.magazine })')
        if st['r']:
            pump(page, w['reloadSec'] + 0.3)
        elif st['cap'] and st['mag'] < st['cap']:
            press(page, 'KeyR')
            pump(page, w['reloadSec'] + 0.5)
        else:
            break


def reset(page):
    for k in ('Mouse0', 'Mouse2', 'ShiftLeft'):
        hold(page, k, False)
    page.evaluate('() => { game.player.pitch = 0.5; game.arcade.recoil.reset(); }')
    pump(page, 0.3)


# ---------------------------------------------------------------- analysis


def max_jump(frames, k, lo=0, hi=None):
    best, at = 0.0, -1
    for i in range(max(1, lo), len(frames) if hi is None else hi):
        d = abs(row(frames[i], k) - row(frames[i - 1], k))
        if d > best:
            best, at = d, i
    return best, at


def check_ads(tag, w, optic, ads_time, data):
    fr = data['frames']
    if len(fr) < 10:
        finding(tag, 'no frames', str(len(fr)))
        return
    zoom_min = min(row(f, 'zoom') for f in fr)
    zoom_total = 1 - zoom_min
    dts = [row(fr[i], 't') - row(fr[i - 1], 't') for i in range(1, len(fr))]
    dt_med = sorted(dts)[len(dts) // 2] / 1000
    # Largest zoom step per frame vs. what a smooth ADS of this weapon's aim time allows (ease-in curves peak at ~2.5x the mean slope).
    # The ADS-out is quicker than the ADS-in (up to 2x), and a 0.16 s aim time is only ten frames: allow 4.5x the mean slope of this frame's dt.
    worst, at = 0.0, -1
    for i in range(1, len(fr)):
        dt_i = max(1e-3, (row(fr[i], 't') - row(fr[i - 1], 't')) / 1000)
        over = abs(row(fr[i], 'zoom') - row(fr[i - 1], 'zoom')) / max(0.02, zoom_total / max(0.05, ads_time) * dt_i * 4.5)
        if over > worst:
            worst, at = over, i
    if worst > 1.4 and zoom_total > 0.05:
        finding(tag, 'zoom snap', f'{worst:.1f}x the smooth rate at frame {at}, ads {row(fr[at - 1], "ads"):.2f}->{row(fr[at], "ads"):.2f}')
    # Weapon / scope overlay disagreeing: for a scope the overlay should be on exactly when the gun is hidden.
    if optic in ('scope', 'combat'):
        bad = [i for i, f in enumerate(fr) if row(f, 'scope') == 1 and row(f, 'wvis') == 1 and row(f, 'ads') > 0.5]
        gone = [i for i, f in enumerate(fr) if row(f, 'scope') == 0 and row(f, 'wvis') == 0 and row(f, 'ads') > 0.5 and row(f, 'equip') >= 1]
        if bad:
            finding(tag, 'scope overlay and gun model visible together', f'{len(bad)} frames, first at {bad[0]} (ads {row(fr[bad[0]], "ads"):.2f})')
        if gone:
            finding(tag, 'gun hidden without scope overlay (see-through flash)', f'{len(gone)} frames, first at {gone[0]} (ads {row(fr[gone[0]], "ads"):.2f})')
        # Flicker: overlay toggling more than twice per ADS cycle.
        flips = sum(1 for i in range(1, len(fr)) if row(fr[i], 'scope') != row(fr[i - 1], 'scope'))
        if flips > 4:
            finding(tag, 'scope overlay flicker', f'{flips} on/off changes')
    # Viewmodel pose pops (position in view units; a smooth ADS moves ~0.7 units over the aim time).
    # The pose travels ~0.2 units over the aim time; allow 3.5x the mean speed (the ease-in peak) of this frame's dt.
    for k in ('px', 'py', 'pz'):
        worst, at = 0.0, -1
        for i in range(1, len(fr)):
            dt_i = max(1e-3, (row(fr[i], 't') - row(fr[i - 1], 't')) / 1000)
            over = abs(row(fr[i], k) - row(fr[i - 1], k)) / (0.02 + 0.2 * dt_i / max(0.05, ads_time) * 3.5)
            if over > worst:
                worst, at = over, i
        if worst > 1:
            finding(tag, f'viewmodel {k} pop', f'{worst:.1f}x the smooth speed at frame {at} (ads {row(fr[at], "ads"):.2f}, eased {row(fr[at], "eased"):.2f})')
    # Geometry swaps (hip cut <-> aimed cut) while the ADS blend is changing: how big is the pop on screen? Report where.
    swaps = [i for i in range(1, len(fr)) if row(fr[i], 'geo') != row(fr[i - 1], 'geo') and row(fr[i], 'weapon') == row(fr[i - 1], 'weapon')]
    for i in swaps[:4]:
        finding(tag, 'weapon model swaps cut mid-transition', f'frame {i}: eased {row(fr[i - 1], "eased"):.2f}->{row(fr[i], "eased"):.2f}, arms {row(fr[i - 1], "avis")}->{row(fr[i], "avis")}')


def run_ads(page, w, optic, tag):
    ads_time = w['adsTime'] + (0.08 if optic == 'scope' and w['optics'][0] != 'scope' else 0.05 if optic == 'combat' and w['optics'][0] != 'combat' else 0)
    reset(page)
    m = mark(page)
    hold(page, 'Mouse2', True)
    t0 = time.time()
    reached = None
    while time.time() - t0 < 2.5:
        pump(page, 0.02)
        s = page.evaluate('() => game.arcade.ads')
        if s >= 0.999 and reached is None:
            reached = time.time() - t0
            break
    pump(page, 0.6)
    hold(page, 'Mouse2', False)
    pump(page, 0.7)
    # Quick in and out (a flick): in for 80 ms, out again, in again.
    for _ in range(3):
        hold(page, 'Mouse2', True)
        pump(page, 0.09)
        hold(page, 'Mouse2', False)
        pump(page, 0.09)
    pump(page, 0.5)
    data = since(page, m)
    if reached is None or reached > ads_time + 0.3:
        finding(tag, 'ADS slower than the aim time', f'{reached} s for {ads_time:.2f} s')
    check_ads(tag, w, optic, ads_time, data)
    return data


# ---------------------------------------------------------------- shooting


def shots_vs_sounds(tag, w, data, expect_shots=None):
    sent = [s for s in data['sent'] if s[0] == 'fire']
    snd = [s for s in data['sounds'] if s[2] and s[0] in (f"weapon.{w['id']}", f"weapon.{w['id']}.suppressed")]
    mags = [row(f, 'mag') - row(f, 'pending') for f in data['frames']]
    if len(sent) != len(snd):
        finding(tag, 'fire messages vs gunshot sounds differ', f'{len(sent)} sent, {len(snd)} heard')
    # Double fires: two shots closer than 55% of the fire interval (burst weapons use their in-burst interval).
    gap = 60 / w['rpm'] * 0.55
    ts = [s[1] / 1000 for s in sent]
    for i in range(1, len(ts)):
        if ts[i] - ts[i - 1] < gap:
            finding(tag, 'double fire', f'{(ts[i] - ts[i - 1]) * 1000:.0f} ms between shots (interval {60 / w["rpm"] * 1000:.0f} ms)')
            break
    if expect_shots is not None and len(sent) != expect_shots:
        finding(tag, 'wrong number of shots', f'{len(sent)} sent, expected {expect_shots}')
    reloaded = any(row(f, 'reloading') == 1 for f in data['frames'])
    if mags and mags[-1] > mags[0] and not reloaded:
        finding(tag, 'ammo counter went up while shooting', f'{mags[0]} -> {mags[-1]}')
    return len(sent)


def run_fire(page, w, optic, tag, ads):
    reset(page)
    topup(page, w)
    if ads:
        hold(page, 'Mouse2', True)
        pump(page, max(0.5, w['adsTime'] + 0.4))
    p0 = page.evaluate('() => game.player.pitch')
    m = mark(page)
    mode = w['mode']
    peak = p0
    if mode == 'auto':
        hold(page, 'Mouse0', True)
        n = 0
        t_end = time.time() + min(1.2, 60 / w['rpm'] * min(w['magazine'], 14) + 0.1)
        while time.time() < t_end:
            pump(page, 0.03)
            peak = max(peak, page.evaluate('() => game.player.pitch'))
        hold(page, 'Mouse0', False)
    elif mode == 'burst':
        for _ in range(3):
            click(page)
            pump(page, w['burstCycle'] + 0.05)
            peak = max(peak, page.evaluate('() => game.player.pitch'))
    else:
        # Semi / bolt: a click every interval (and twice as fast to check the fire rate holds).
        for i in range(5):
            click(page)
            pump(page, 60 / w['rpm'] + 0.03)
            peak = max(peak, page.evaluate('() => game.player.pitch'))
        for i in range(3):
            click(page)
            pump(page, 0.03)
    pump(page, 1.0)
    p1 = page.evaluate('() => game.player.pitch')
    hold(page, 'Mouse2', False)
    pump(page, 0.4)
    data = since(page, m)
    tagf = f'{tag}{" ADS" if ads else " hip"}'
    shots_vs_sounds(tagf, w, data, expect_shots=None)
    if mode == 'burst':
        sent = [s for s in data['sent'] if s[0] == 'fire']
        if len(sent) != 9:
            finding(tagf, 'burst count wrong', f'{len(sent)} shots from 3 trigger pulls (3 each expected)')
    pitches = [row(f, 'pitch') for f in data['frames']]
    if pitches:
        p0, peak, p1 = pitches[0], max(pitches), pitches[-1]
    if peak > p0 + 1e-4:
        rec = (peak - p1) / (peak - p0)
        if rec < 0.35 and not ads:
            finding(tagf, 'recoil did not come back', f'climb {math.degrees(peak - p0):.2f} deg, recovered {rec:.0%}')
        if rec < 0.35 and ads and mode == 'auto':
            finding(tagf, 'recoil did not come back', f'climb {math.degrees(peak - p0):.2f} deg, recovered {rec:.0%}')
    # Camera pitch jumps larger than the weapon's kick (camera fighting the crosshair drop).
    fr = data['frames']
    j, at = max_jump(fr, 'pitch')
    if j > math.radians(w['recoil'] * 0.6 + 0.6):
        finding(tagf, 'pitch jumped', f'{math.degrees(j):.2f} deg in one frame (kick {w["recoil"]} deg)')
    # Muzzle flash on every shot frame: count flash on-sets vs shots.
    flashes = sum(1 for i in range(1, len(fr)) if row(fr[i], 'flash') == 1 and row(fr[i - 1], 'flash') == 0)
    shots = len([s for s in data['sent'] if s[0] == 'fire'])
    if shots and abs(flashes - shots) > max(1, shots // 6) and not (mode == 'auto' and shots > 8):
        finding(tagf, 'muzzle flashes vs shots', f'{flashes} flashes for {shots} shots')
    return data


def run_reload(page, w, optic, tag):
    """Shoot a few rounds, reload with extra input in the middle: fire and ADS must be refused, ammo and animation must agree."""
    reset(page)
    topup(page, w)
    for _ in range(3):
        click(page)
        pump(page, 60 / w['rpm'] + 0.05)
    pump(page, 0.4)
    m = mark(page)
    press(page, 'KeyR')
    pump(page, 0.15)
    s = page.evaluate('() => ({ r: game.arcade.ammo[game.arcade.slot].reloading, mag: game.arcade.ammo[game.arcade.slot].mag })')
    if not s['r']:
        finding(tag, 'reload did not start', json.dumps(s))
        return
    t_start = time.time()
    # In the middle: try to fire and to aim.
    pump(page, w['reloadSec'] * 0.35)
    hold(page, 'Mouse2', True)
    click(page)
    pump(page, 0.1)
    ads_mid = page.evaluate('() => game.arcade.ads')
    hold(page, 'Mouse2', False)
    pump(page, w['reloadSec'] * 0.9)
    data = since(page, m)
    fired = [s for s in data['sent'] if s[0] == 'fire']
    if fired:
        finding(tag, 'fired during a reload', f'{len(fired)} fire message(s)')
    if ads_mid > 0.05:
        finding(tag, 'aimed during a reload', f'ads {ads_mid:.2f}')
    fr = data['frames']
    # The counter must change exactly once (to the full magazine), within the reload time + a frame, and the animation must end with it.
    mags = [row(f, 'mag') for f in fr]
    changes = [(i, mags[i - 1], mags[i]) for i in range(1, len(mags)) if mags[i] != mags[i - 1]]
    if len(changes) != 1 or changes[0][2] != w['magazine']:
        finding(tag, 'ammo counter during reload', f'changes {changes[:4]}')
    else:
        i = changes[0][0]
        dur = (row(fr[i], 't') - row(fr[0], 't')) / 1000
        rl = [k for k, f in enumerate(fr) if row(f, 'reloading') == 1]
        if rl:
            last = rl[-1]
            if abs(last - i) > 3:
                finding(tag, 'reload animation and ammo counter disagree', f'animation ends frame {last}, counter changes frame {i}')
    steps = [s[0] for s in data['sounds'] if s[0].startswith('weapon.mech')]
    if len(steps) < 2:
        finding(tag, 'reload sounds', f'only {steps}')
    if len(steps) != len(set(zip(steps, range(len(steps))))) and len(steps) > 6:
        finding(tag, 'reload sounds repeated', str(steps))


def run_switch(page, w, optic, tag):
    """Weapon swap while aiming, while reloading, and rapid swapping."""
    reset(page)
    # 1. swap while aimed
    hold(page, 'Mouse2', True)
    pump(page, w['adsTime'] + 0.5)
    m = mark(page)
    press(page, 'Digit2')
    pump(page, 0.6)
    d1 = since(page, m)
    fr = d1['frames']
    if fr:
        j, at = max_jump(fr, 'zoom')
        if j > 0.12:
            finding(tag, 'swap while aimed: zoom snap', f'{j:.2f} FOV scale in one frame')
        jp = max(max_jump(fr, k)[0] for k in ('px', 'py', 'pz'))
        if jp > 0.15:
            finding(tag, 'swap while aimed: viewmodel pop', f'{jp:.2f} units in one frame')
    hold(page, 'Mouse2', False)
    pump(page, 0.3)
    # 2. swap back and fire immediately: the first shot must wait for the swap time, not be eaten or doubled
    m = mark(page)
    press(page, 'Digit1')
    for _ in range(6):
        click(page)
        pump(page, 0.07)
    pump(page, 0.4)
    d2 = since(page, m)
    sent = [s for s in d2['sent'] if s[0] == 'fire']
    snd = [s for s in d2['sounds'] if s[2] and s[0].startswith('weapon.') and not s[0].startswith('weapon.mech') and not s[0].startswith('weapon.kill') and 'empty' not in s[0]]
    if len(sent) != len(snd):
        finding(tag, 'swap then fire: messages vs sounds differ', f'{len(sent)} sent, {len(snd)} heard: {[s[0] for s in snd]}')
    # 3. swap during reload and back
    reset(page)
    for _ in range(2):
        click(page)
        pump(page, 60 / w['rpm'] + 0.05)
    pump(page, 0.3)
    mag_before = page.evaluate('() => game.arcade.ammo[0].mag')
    m = mark(page)
    press(page, 'KeyR')
    pump(page, w['reloadSec'] * 0.4)
    press(page, 'Digit2')
    pump(page, 0.5)
    state_sec = page.evaluate('() => ({ r0: game.arcade.ammo[0].reloading, mag0: game.arcade.ammo[0].mag, slot: game.arcade.slot })')
    pump(page, w['reloadSec'] + 0.3)
    press(page, 'Digit1')
    pump(page, 0.5)
    state_back = page.evaluate('() => ({ r0: game.arcade.ammo[0].reloading, mag0: game.arcade.ammo[0].mag, slot: game.arcade.slot, hudAmmo: (document.querySelector(".arc-ammo") || {}).textContent })')
    if state_sec['r0']:
        finding(tag, 'reload not cancelled by a weapon switch', json.dumps(state_sec))
    if state_back['mag0'] != mag_before:
        finding(tag, 'switching during a reload changed the magazine', f'before {mag_before}, after {state_back["mag0"]}')
    d3 = since(page, m)
    steps = [s[0] for s in d3['sounds'] if s[0].startswith('weapon.mech') and 'switch' not in s[0] and 'ads' not in s[0]]
    # 4. rapid swapping x6
    m = mark(page)
    for i in range(6):
        press(page, 'Digit2' if i % 2 == 0 else 'Digit1')
        pump(page, 0.06)
    pump(page, 0.6)
    d4 = since(page, m)
    fr = d4['frames']
    jp = max(max_jump(fr, k)[0] for k in ('px', 'py', 'pz')) if fr else 0
    if jp > 0.45:
        finding(tag, 'rapid swapping: viewmodel pop', f'{jp:.2f}')
    snd = [s[0] for s in d4['sounds'] if s[0] == 'weapon.mech.switch']
    if len(snd) > 6:
        finding(tag, 'switch sound overlap', f'{len(snd)} switch sounds for 6 swaps')
    reset(page)
    press(page, 'Digit1')
    pump(page, 0.5)


def run_bolt(page, w, optic, tag):
    """Bolt actions: after the shot the bolt is worked; ADS out/in during the cycle, fire during the cycle."""
    reset(page)
    topup(page, w)
    hold(page, 'Mouse2', True)
    pump(page, w['adsTime'] + 0.4)
    m = mark(page)
    click(page)
    pump(page, 0.12)
    hold(page, 'Mouse2', False)    # leave the scope during the bolt
    pump(page, 0.3)
    hold(page, 'Mouse2', True)    # and aim again
    click(page)                   # a click inside the cycle must not fire
    pump(page, 0.6)
    pump(page, 60 / w['rpm'] + 0.2)
    data = since(page, m)
    snds = [s[0] for s in data['sounds'] if s[0] in ('weapon.mech.boltback', 'weapon.mech.boltfwd')]
    sent = [s for s in data['sent'] if s[0] == 'fire']
    if snds[:2] != ['weapon.mech.boltback', 'weapon.mech.boltfwd']:
        finding(tag, 'bolt cycle sounds out of order', str(snds))
    if len(sent) > 2:
        finding(tag, 'fired inside the bolt cycle', f'{len(sent)} fire messages')
    fr = data['frames']
    # Scoped: leaving the scope mid-bolt must show the gun at once (no frames without gun and overlay).
    gone = [i for i, f in enumerate(fr) if row(f, 'scope') == 0 and row(f, 'wvis') == 0 and row(f, 'equip') >= 1]
    if gone:
        finding(tag, 'bolt: gun invisible without scope overlay', f'{len(gone)} frames')
    hold(page, 'Mouse2', False)
    pump(page, 0.4)


def sheet(page, tag, label, action):
    """Contact sheet of the frames while `action` runs."""
    from PIL import Image, ImageDraw
    import base64
    import io
    page.evaluate('() => { const L = window.__gl; L.caps.length = 0; L.cap = true; }')
    action()
    page.evaluate('() => { window.__gl.cap = false; }')
    caps = page.evaluate('() => window.__gl.caps.splice(0)')
    if not caps:
        return
    os.makedirs(OUT, exist_ok=True)
    step = max(1, len(caps) // 24)
    sel = caps[::step][:24]
    cols = 6
    rows = (len(sel) + cols - 1) // cols
    im = Image.new('RGB', (cols * 320, rows * 180))
    for i, (t, url) in enumerate(sel):
        fr = Image.open(io.BytesIO(base64.b64decode(url.split(',')[1])))
        ImageDraw.Draw(fr).text((4, 4), f'{(t - sel[0][0]):.0f}ms', fill=(255, 255, 0))
        im.paste(fr, ((i % cols) * 320, (i // cols) * 180))
    im.save(f'{OUT}/{tag.replace(" ", "_").replace("+", "-")}-{label}.png')


AUTOPILOT = """() => {
  const g = window.game, a = g.arcade, p = g.player, inp = g.input;
  if (window.__ap) return;
  const ap = window.__ap = { on: true, target: 0, shots: 0, last: performance.now(), strafe: 1, strafeAt: 0, kills: 0, deaths: 0, wasDead: false };
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const hold = (k, on) => (on ? inp.down.add(k) : inp.down.delete(k));
  const step = () => {
    requestAnimationFrame(step);
    const now = performance.now(), dt = Math.min(0.1, (now - ap.last) / 1000); ap.last = now;
    if (!ap.on || g.state !== 'playing') return;
    inp.locked = true;
    if (a.dead) { if (!ap.wasDead) ap.deaths++; ap.wasDead = true; for (const k of ['Mouse0', 'Mouse2', 'KeyW', 'KeyA', 'KeyD']) inp.down.delete(k); return; }
    ap.wasDead = false;
    let best = null, bd = 1e9;
    for (const id of g.remote.players.keys()) {
      if (id === g.net.id || !g.remote.isAlive(id) || !g.remote.pose(id, pose)) continue;
      const info = a.players.get(id);
      if (a.teams && info && info.team === a.team) continue;
      const d = Math.hypot(pose.x - p.x, pose.z - p.z);
      if (d < bd) { bd = d; best = { x: pose.x, y: pose.y, z: pose.z, id }; }
    }
    if (!best) { for (const k of ['Mouse0', 'Mouse2', 'KeyA', 'KeyD']) inp.down.delete(k); hold('KeyW', true); p.yaw += dt * 0.8; return; }
    const dx = best.x - p.x, dz = best.z - p.z, dy = best.y + 1.35 - p.eyeY;
    const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    let dyaw = wantYaw - p.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const maxTurn = 9 * dt;
    p.yaw += Math.max(-maxTurn, Math.min(maxTurn, dyaw));
    p.pitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - p.pitch));
    const w = a.weapon;
    const shoot = bd < Math.min(70, w.maxRange) && Math.abs(dyaw) < 0.12;
    const ads = bd > 12 && w.zoom < 1 && Math.abs(dyaw) < 0.4;
    hold('Mouse2', ads);
    // Semi weapons need a click per shot: click at their rate.
    if (w.auto) hold('Mouse0', shoot);
    else if (shoot && now - ap.shotAt > 60000 / w.rpm + 15) { ap.shotAt = now; inp.pressed.add('Mouse0'); inp.down.add('Mouse0'); setTimeout(() => inp.down.delete('Mouse0'), 40); }
    else if (!shoot) inp.down.delete('Mouse0');
    hold('KeyW', bd > 18);
    if (now > ap.strafeAt) { ap.strafe = -ap.strafe; ap.strafeAt = now + 500 + Math.random() * 700; }
    hold('KeyA', ap.strafe < 0 && bd < 40); hold('KeyD', ap.strafe > 0 && bd < 40);
    if (a.ammo[a.slot].mag < 0.25 * w.magazine && !shoot && Math.random() < 0.02) inp.pressed.add('KeyR');
  };
  step();
}"""


def match_analysis(data, weapons):
    """Whole-match checks on the frame log."""
    fr = data['frames']
    byid = {w['id']: w for w in weapons}
    stuck = [i for i, f in enumerate(fr) if row(f, 'scope') == 1 and row(f, 'ads') < 0.5]
    if stuck:
        finding('match', 'scope overlay on while not aiming', f'{len(stuck)} frames, first at {stuck[0]} ({row(fr[stuck[0]], "weapon")})')
    hidden = [i for i, f in enumerate(fr) if row(f, 'wvis') == 0 and row(f, 'scope') == 0 and row(f, 'equip') >= 1]
    if len(hidden) > 3:
        finding('match', 'weapon invisible without a scope overlay', f'{len(hidden)} frames, first at {hidden[0]} ({row(fr[hidden[0]], "weapon")}, ads {row(fr[hidden[0]], "ads"):.2f})')
    # Reload animation stuck beyond its time.
    run_start = None
    for i, f in enumerate(fr):
        if row(f, 'reloading') == 1 and run_start is None:
            run_start = i
        if (row(f, 'reloading') == 0 or i == len(fr) - 1) and run_start is not None:
            w = byid.get(row(fr[run_start], 'weapon'))
            dur = (row(f, 't') - row(fr[run_start], 't')) / 1000
            if w and dur > w['reloadSec'] * 1.25 + 0.4:
                finding('match', 'reload longer than its time', f'{w["id"]}: {dur:.2f} s (reload {w["reloadSec"]} s)')
            run_start = None
    # Ammo counter out of range.
    for f in fr:
        w = byid.get(row(f, 'weapon'))
        if w and w['magazine'] and (row(f, 'mag') < 0 or row(f, 'mag') > w['magazine'] * 1.4 + 0.5):
            finding('match', 'ammo counter out of range', f'{w["id"]}: {row(f, "mag")}')
            break
    # Frame hitches (>120 ms) in the log.
    hitches = [i for i in range(1, len(fr)) if row(fr[i], 't') - row(fr[i - 1], 't') > 120]
    print(f'  frames {len(fr)}, hitches>120ms {len(hitches)}', flush=True)
    sent = [s for s in data['sent'] if s[0] == 'fire']
    snd = [s for s in data['sounds'] if s[2] and s[0].startswith('weapon.') and s[0].count('.') == 1 and s[0] not in ('weapon.kill', 'weapon.empty')]
    print(f'  fire messages {len(sent)}, own gunshot sounds {len(snd)}', flush=True)
    if sent and abs(len(sent) - len(snd)) > max(3, len(sent) * 0.03):
        finding('match', 'fire messages vs gunshot sounds differ', f'{len(sent)} vs {len(snd)}')


def run_match(page, weapons, seconds):
    import urllib.request
    body = json.dumps({'name': 'Glitch match', 'gameMode': 'creative', 'seed': 'qa', 'gameType': 'tdm', 'scoreLimit': 100000,
                       'timeLimitSec': 3600, 'mapId': 'classic', 'bots': 7, 'botDifficulty': 'normal'}).encode()
    req = urllib.request.Request(q.VITE + '/api/rooms', data=body, headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req) as r:
        code = json.loads(r.read())['code']
    q.join_room(page, code, 'GlitchMatch')
    page.evaluate(INSTALL)
    page.evaluate(AUTOPILOT)
    # Wait for the match to go live.
    t0 = time.time()
    while time.time() - t0 < 60 and page.evaluate('() => game.arcade.phase') in ('warmup', 'countdown'):
        time.sleep(0.5)
    print('phase', page.evaluate('() => game.arcade.phase'), flush=True)
    prim = [w for w in weapons if w['slot'] == 'primary' and (ONLY is None or w['id'] in ONLY)]
    for w in prim:
        optic = w['optics'][-1] if w['optics'][-1] in ('scope', 'combat') else w['optics'][0]
        print(f'-- match with {w["id"]}+{optic}', flush=True)
        # A class applies right after a spawn; wait for the next life when needed.
        page.evaluate(f"() => game.arcade.chooseClass({{ primary: '{w['id']}', optic: '{optic}', secondary: 'pistol', perk: 'none' }}, false)")
        end = time.time() + seconds
        while time.time() < end and page.evaluate('() => game.arcade.weapon.id') != w['id']:
            page.evaluate("() => { game.input.locked = true; }")
            time.sleep(0.3)
        m = mark(page)
        end = time.time() + seconds
        while time.time() < end:
            page.evaluate("() => { game.input.locked = true; if (game.state !== 'playing') game.state = 'playing'; }")
            time.sleep(0.2)
        d = since(page, m)
        st = page.evaluate('() => ({ kills: __ap.kills, deaths: __ap.deaths })')
        print(f'   deaths so far {st["deaths"]}', flush=True)
        match_analysis(d, weapons)
        shots_vs_sounds(f'match {w["id"]}', w, d)
        # Reset for the next weapon: nothing else (the autopilot keeps playing).


def main():
    with sync_playwright() as pw:
        b = q.launch(pw)
        logs = []
        page = q.open_game(b, logs=logs)
        page.on('response', lambda r: logs.append(f'error: {r.status} {r.url}') if r.status >= 400 else None)
        print(q.gpu(page), flush=True)
        token = os.environ.get('QA_PROFILE_TOKEN') or (open(OPTS['token-file']).read().strip() if 'token-file' in OPTS else None)
        if token:
            # A prestige profile (every optic and weapon unlocked): create one with POST /api/profile and raise "prestige" in its file.
            page.evaluate("([k, t]) => localStorage.setItem(k, t)", [f"bunkcraft.profile.{VITE_HOST}", token])
            page.reload()
            page.wait_for_function('() => window.game && window.game.state === "menu" && !!window.game.world', timeout=60000)
            page.evaluate("async () => { const m = await import('/src/net/ProfileApi.ts'); await m.loadProfile('Glitch'); }")
            rank = page.evaluate("async () => (await import('/src/net/ProfileApi.ts')).currentRank()")
            print('rank', rank, flush=True)
        weapons = page.evaluate("""async () => {
          const m = await import('/src/modes/Weapons.ts');
          return m.WEAPONS.map((w) => ({ id: w.id, slot: w.slot, mode: m.fireMode(w), rpm: w.rpm, magazine: w.magazine, reloadSec: w.reloadSec,
            adsTime: w.adsTime, optics: w.optics, burst: w.burst || 0, burstCycle: w.burstCycleSec || 0, recoil: w.recoil, bolt: !!w.bolt }));
        }""")
        if 'match' in OPTS:
            run_match(page, weapons, float(OPTS['match']) if OPTS['match'] != '1' else 40.0)
            errs = [l for l in logs if 'error' in l.lower()]
            if errs:
                finding('console', 'errors', '; '.join(errs[:5]))
            b.close()
            print(f'\n{len(findings)} findings')
            return
        code = q.create_room('tdm', 'classic', name='Glitch sandbox')
        q.join_room(page, code, 'Glitch')
        pump(page, 2.0)
        page.evaluate(INSTALL)
        prim = [w for w in weapons if w['slot'] == 'primary' and (ONLY is None or w['id'] in ONLY)]
        sec = [w for w in weapons if w['slot'] == 'secondary' and (ONLY is None or w['id'] in ONLY)]
        for w in prim:
            for optic in w['optics']:
                tag = f"{w['id']}+{optic}"
                print(f'-- {tag}', flush=True)
                equip(page, w['id'], optic)
                cur = page.evaluate('() => [game.arcade.weapon.id, game.arcade.optic]')
                if cur != [w['id'], optic]:
                    finding(tag, 'class change did not apply', str(cur))
                    continue
                run_ads(page, w, optic, tag)
                if SHEETS:
                    sheet(page, tag, 'ads', lambda: (hold(page, 'Mouse2', True), pump(page, w['adsTime'] + 0.5), hold(page, 'Mouse2', False), pump(page, 0.5)))
                run_fire(page, w, optic, tag, ads=True)
                if w['bolt']:
                    run_bolt(page, w, optic, tag)
                # The rest does not depend on the sights: once per weapon, with its default optic.
                if optic == w['optics'][0]:
                    run_fire(page, w, optic, tag, ads=False)
                    run_reload(page, w, optic, tag)
                    run_switch(page, w, optic, tag)
        for w in sec:
            tag = f"{w['id']}"
            print(f'-- {tag}', flush=True)
            equip(page, 'rifle', 'iron', secondary=w['id'])
            press(page, 'Digit2')
            pump(page, 0.6)
            if page.evaluate('() => game.arcade.weapon.id') != w['id']:
                finding(tag, 'secondary not in hand', page.evaluate('() => game.arcade.weapon.id'))
                continue
            run_ads(page, w, 'iron', tag)
            run_fire(page, w, 'iron', tag, ads=False)
            run_fire(page, w, 'iron', tag, ads=True)
            run_reload(page, w, 'iron', tag)
            press(page, 'Digit1')
            pump(page, 0.5)
        errs = [l for l in logs if 'error' in l.lower()]
        if errs:
            finding('console', 'errors', '; '.join(errs[:5]))
        b.close()
    print(f'\n{len(findings)} findings')
    for f in findings:
        print(' ', f)


if __name__ == '__main__':
    main()
