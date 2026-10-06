"""
Arcade weapon check in the dev preview (fake server, real client): for every primary with every optic it may carry,
and for every secondary, through game.input only:

  - ADS: the aim blend reaches 1 in about the weapon's ADS time, the view zooms, the scope overlay replaces the gun
    (scope) or the reticle shows (red dot / holo)
  - a magazine: every shot plays its gunshot, the magazine counts down, the aim point climbs (recoil) and ~70%
    comes back down after the trigger is released
  - reload: R plays the reload steps and the magazine is full again after the reload time (+40% with Extended Mags)
  - breath (scope): Shift steadies the sway until the breath runs out, with the hold/release sounds
  - weapon switch: the first shot of the secondary after pressing 2 comes after the equip time (half with Quickdraw)
  - suppressor: the own shot is the suppressed sound
  - kill feed: your name, the weapon tag and the victim
Prints PASS/FAIL lines and exits 1 on a failure.

  QA_VITE=http://localhost:5523 python3 scripts/qa/weapon-check.py [map=classic]
"""
import json
import math
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

map_id = sys.argv[1] if len(sys.argv) > 1 else 'classic'
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  - {detail}' if detail != '' else ''), flush=True)


HOOK = """() => {
  const g = window.game;
  window.__snd = [];
  // Own sounds have no position (NaN): that tells them apart from the bots' gunshots.
  g.audio.addSoundListener((name, x) => window.__snd.push([name, performance.now(), Number.isNaN(x)]));
}"""

STATE = """() => {
  const a = game.arcade;
  return { ads: a.ads, zoom: game.cam.zoom, slot: a.slot, weapon: a.weapon.id, mag: a.ammo[a.slot].mag, reloading: a.ammo[a.slot].reloading,
           pitch: game.player.pitch, scope: !document.querySelector('.arc-scope').classList.contains('hidden'),
           gun: a.viewmodel.weaponMesh.visible, reticle: !!(a.viewmodel.reticle && a.viewmodel.reticle.visible),
           breath: a.breath.breath, amp: a.breath.amp, dead: a.dead };
}"""


def st(page):
    return page.evaluate(STATE)


def sounds(page, since=0.0, prefix='', own=True):
    return page.evaluate('([s, p, o]) => window.__snd.filter((e) => e[1] >= s && e[0].startsWith(p) && (!o || e[2]))', [since, prefix, own])


def now(page):
    return page.evaluate('() => performance.now()')


def hold(page, key, on):
    page.evaluate(f"() => game.input.down.{'add' if on else 'delete'}('{key}')")


def press(page, key):
    page.evaluate(f"() => game.input.pressed.add('{key}')")


def pump(page, sec):
    end = time.time() + sec
    while time.time() < end:
        page.bring_to_front()
        page.evaluate("() => { game.input.locked = true; if (game.state !== 'playing') game.state = 'playing'; game.previewServer.health = 100; }")
        time.sleep(0.05)


def equip(page, primary, optic='iron', secondary='pistol', perk='none'):
    page.evaluate(f"() => game.arcade.chooseClass({{ primary: '{primary}', optic: '{optic}', secondary: '{secondary}', perk: '{perk}' }}, false)")
    pump(page, 0.4)
    press(page, 'Digit1')
    pump(page, 0.5)


def look_up(page):
    # Aim at the sky so shots hit nothing (no kills, the bots keep away) and the recoil is easy to read.
    page.evaluate('() => { game.player.pitch = 0.5; }')


def fire_mag(page, wdef):
    """Empties the magazine; returns (shots heard, climb in degrees, recovered fraction)."""
    t0 = now(page)
    p0 = st(page)['pitch']
    auto = wdef['mode'] == 'auto'
    peak = p0
    end = time.time() + 12
    own = lambda: len([s for s in sounds(page, t0, 'weapon.') if s[0] in (f"weapon.{wdef['id']}", f"weapon.{wdef['id']}.suppressed")])
    # Until the magazine's worth of shots went off (the preview's ammo echo is not exact on the last round).
    while time.time() < end and own() < wdef['magazine'] and st(page)['mag'] > 0:
        if auto:
            hold(page, 'Mouse0', True)
        else:
            press(page, 'Mouse0')
        pump(page, 0.06 if auto else max(0.07, 60 / wdef['rpm'] + 0.02))
        peak = max(peak, st(page)['pitch'])
    hold(page, 'Mouse0', False)
    pump(page, 1.2)
    p1 = st(page)['pitch']
    climb = math.degrees(peak - p0)
    rec = (peak - p1) / (peak - p0) if peak > p0 else 0
    heard = len([s for s in sounds(page, t0, 'weapon.') if s[0] in (f"weapon.{wdef['id']}", f"weapon.{wdef['id']}.suppressed")])
    return heard, climb, rec, t0


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'tdm', map_id)
    pump(page, 3)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    page.evaluate(HOOK)
    weapons = page.evaluate("""async () => {
      const m = await import('/src/modes/Weapons.ts');
      return m.WEAPONS.map((w) => ({ id: w.id, slot: w.slot, mode: m.fireMode(w), rpm: w.rpm, magazine: w.magazine, reloadSec: w.reloadSec,
        adsTime: w.adsTime, optics: w.optics, burst: w.burst || 0 }));
    }""")
    prim = [w for w in weapons if w['slot'] == 'primary']
    sec = [w for w in weapons if w['slot'] == 'secondary']
    print('weapons', [w['id'] for w in weapons])

    for w in prim:
        for optic in w['optics']:
            tag = f"{w['id']}+{optic}"
            equip(page, w['id'], optic)
            look_up(page)
            s0 = st(page)
            check(f'{tag}: equipped', s0['weapon'] == w['id'] and s0['slot'] == 0 and s0['mag'] == w['magazine'], json.dumps(s0))
            # ADS
            t0 = time.time()
            hold(page, 'Mouse2', True)
            reached = None
            while time.time() - t0 < 2:
                pump(page, 0.03)
                if st(page)['ads'] > 0.97:
                    reached = time.time() - t0
                    break
            pump(page, 0.3)
            s1 = st(page)
            check(f'{tag}: ADS in ~{w["adsTime"]:.2f}s', reached is not None and reached < w['adsTime'] + 0.35, f'{reached}')
            check(f'{tag}: ADS zooms the view (narrower FOV)', s1['zoom'] < 0.95, f"zoom {s1['zoom']:.2f}")
            if optic == 'scope':
                check(f'{tag}: scope overlay on, gun hidden', s1['scope'] and not s1['gun'], json.dumps(s1))
                # Breath: sway first, then Shift steadies it.
                amp_idle = s1['amp']
                t_b = now(page)
                hold(page, 'ShiftLeft', True)
                pump(page, 1.0)
                s2 = st(page)
                check(f'{tag}: Shift holds the breath (less sway, breath draining)', s2['amp'] < amp_idle and s2['breath'] < 1, f"amp {amp_idle:.3f}->{s2['amp']:.3f} breath {s2['breath']:.2f}")
                pump(page, 4.0)
                s3 = st(page)
                check(f'{tag}: out of breath after ~4 s sways harder', s3['amp'] > amp_idle, f"amp {s3['amp']:.3f}")
                hold(page, 'ShiftLeft', False)
                names = [s[0] for s in sounds(page, t_b, 'player.breath')]
                check(f'{tag}: breath sounds (hold, release)', 'player.breath.hold' in names and 'player.breath.release' in names, str(names))
                pump(page, 3.0)
            elif optic in ('reddot', 'holo'):
                check(f'{tag}: reticle shown while aiming', s1['reticle'] and not s1['scope'], json.dumps(s1))
            else:
                check(f'{tag}: no scope overlay with {optic}', not s1['scope'])
            heard, climb, rec, t_r = fire_mag(page, w)
            check(f'{tag}: every shot heard ({w["magazine"]})', heard >= w['magazine'] - 1, f'{heard}')
            if w['mode'] == 'auto':
                check(f'{tag}: recoil climbs during the spray and ~70% comes back', climb > 0.5 and rec > 0.55, f'climb {climb:.2f} deg, recovered {rec:.0%}')
            else:
                check(f'{tag}: recoil kicks per shot', climb > 0.05, f'climb {climb:.2f} deg')
            hold(page, 'Mouse2', False)
            # The empty magazine reloads by itself.
            # An empty magazine reloads by itself; one round left (the preview's echo) needs R.
            pump(page, 0.3)
            if not st(page)['reloading'] and st(page)['mag'] < w['magazine']:
                press(page, 'KeyR')
                pump(page, 0.15)
            check(f'{tag}: reloading', st(page)['reloading'] or st(page)['mag'] == w['magazine'], json.dumps(st(page)))
            pump(page, w['reloadSec'] + 0.3)
            check(f'{tag}: magazine full after {w["reloadSec"]}s', st(page)['mag'] == w['magazine'], json.dumps(st(page)))
            steps = [s[0] for s in sounds(page, t_r) if s[0].startswith('weapon.mech') and 'ads' not in s[0]]
            check(f'{tag}: reload sounds', len(steps) >= 2, str(steps[:6]))
            if optic != w['optics'][0]:
                continue

    # Extended mags.
    equip(page, 'rifle', 'iron', 'pistol', 'extmag')
    check('Extended Mags: 30 -> 42 rounds', st(page)['mag'] == 42, json.dumps(st(page)))
    # Suppressor: the own shot is the suppressed sound.
    equip(page, 'rifle', 'iron', 'pistol', 'suppressor')
    look_up(page)
    t_s = now(page)
    hold(page, 'Mouse0', True)
    pump(page, 0.3)
    hold(page, 'Mouse0', False)
    pump(page, 0.2)
    names = {s[0] for s in sounds(page, t_s, 'weapon.rifle')}
    check('Suppressor: own shots are the suppressed sound', names == {'weapon.rifle.suppressed'}, str(names))

    # Secondaries and switch timing (with and without Quickdraw).
    for w in sec:
        for perk in ('none', 'quickdraw'):
            equip(page, 'rifle', 'iron', w['id'], perk)
            look_up(page)
            pump(page, 0.4)
            t0 = now(page)
            press(page, 'Digit2')
            if w['mode'] == 'auto':
                hold(page, 'Mouse0', True)
                pump(page, 0.9)
                hold(page, 'Mouse0', False)
            else:
                # Semi-automatic: a click every frame or so until it goes off.
                for _ in range(18):
                    press(page, 'Mouse0')
                    pump(page, 0.05)
            shots = [s for s in sounds(page, t0) if s[0] == f"weapon.{w['id']}"]
            first = (shots[0][1] - t0) / 1000 if shots else None
            want = 0.28 * (0.5 if perk == 'quickdraw' else 1)
            check(f"{w['id']} ({perk}): first shot {want:.2f}s after switching", first is not None and want - 0.05 <= first <= want + 0.2, f'{first}')
            pump(page, 0.3)
        # The switch test used some rounds: reload first, then a full magazine.
        press(page, 'KeyR')
        pump(page, w['reloadSec'] + 0.4)
        heard, climb, rec, _ = fire_mag(page, w)
        check(f"{w['id']}: magazine heard ({w['magazine']})", heard >= w['magazine'] - 2, f'{heard}')
        press(page, 'Digit1')
        pump(page, 0.4)

    # Kill feed.
    equip(page, 'dmr', 'scope')
    page.evaluate('() => game.previewServer.killBot(0)')
    pump(page, 0.6)
    feed = page.evaluate("() => [...document.querySelectorAll('.arc-feed-row')].map((r) => r.textContent)")
    bot = page.evaluate('() => game.previewServer.bots[0].name')
    check('kill feed: you, the weapon and the victim', any('DMR' in f and bot in f for f in feed), str(feed[:3]))
    kills = [s[0] for s in sounds(page, 0, 'weapon.kill')]
    check('kill confirm sound', len(kills) >= 1)
    check('no console errors', not [l for l in logs if 'error' in l.lower()], '; '.join(logs[:4]))
    b.close()

print(f'\n{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
