"""
Aim-down-sights check in the dev preview (no server): every weapon x optic fully aimed, one screenshot each, plus the screen
position of the sight line (the optic's window, or the front post and rear notch of the open sights) in pixels from the centre
of the 1280x720 viewport. Fully aimed it must be (0, 0): that is where the bullets go.

  QA_SERVER_PORT=3799 npx vite --config scripts/qa/vite.qa.config.mjs --port 5731
  QA_VITE=http://localhost:5731 python3 scripts/qa/aim-shots.py <out-dir> [prefix=aim] [only=weapon[:optic],...] [map=classic] [--hold-fire]

Output: <out-dir>/<prefix>-<weapon>-<optic>.png and a table of the sight offsets. With --hold-fire the shots are taken while a
burst of shots is going out (the sight must stay put while the weapon kicks).
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {a for a in sys.argv[1:] if a.startswith('--')}
out_dir = args[0] if len(args) > 0 else 'docs/screenshots/arcade'
prefix = args[1] if len(args) > 1 else 'aim'
only = set((args[2] if len(args) > 2 else '').split(',')) - {''}
map_id = args[3] if len(args) > 3 else 'classic'
q.SHOTS = out_dir

MEASURE = """async () => {
  const vm = game.arcade.viewmodel;
  const M = await import('/src/rendering/WeaponModels.ts');
  vm.root.updateMatrixWorld(true);
  vm.camera.updateMatrixWorld(true);
  const id = vm.weaponId, optic = vm.optic;
  const m = M.WEAPON_MODELS[id];
  const zs = [];
  if (optic === 'iron') {
    const iron = m.boxes.filter((b) => b[7] === 'iron');
    zs.push(Math.min(...iron.map((b) => b[2])) + 0.01);
    zs.push(iron.length > 1 ? Math.max(...iron.map((b) => b[2])) + 0.01 : 0.04);
  } else zs.push(m.rail[1] + M.OPTIC_MODELS[optic].windowZ);
  return zs.map((z) => {
    const v = new vm.camera.position.constructor(0, vm.sightY, z);
    vm.root.localToWorld(v);
    v.project(vm.camera);
    return [v.x, v.y];
  });
}"""


def equip(page, wid, optic, slot=0):
    # The server's word on the gear (the class swap window is closed after the first seconds of a life).
    pri, sec = (wid, 'pistol') if slot == 0 else ('rifle', wid)
    page.evaluate(f"() => {{ game.arcade.applyGear('{pri}', '{sec}', '{optic}', 'none'); game.arcade.equipSlot({slot}, false); }}")
    time.sleep(0.7)


def aim(page, on):
    page.evaluate("() => game.input.down.add('Mouse2')" if on else "() => game.input.down.delete('Mouse2')")
    time.sleep(1.0 if on else 0.6)


with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'tdm', map_id)
    time.sleep(3)
    q.force_playing(page)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    print('gpu', q.gpu(page))
    yaw = page.evaluate('() => game.player.yaw')
    combos = page.evaluate("""async () => {
      const W = await import('/src/modes/Weapons.ts');
      return W.WEAPONS.filter((w) => w.slot !== 'melee').map((w) => [w.id, [...w.optics], w.slot === 'primary' ? 0 : 1]);
    }""")
    w, h = page.viewport_size['width'], page.viewport_size['height']
    print(f'{"weapon":12} {"optic":8} {"dx px":>7} {"dy px":>7}')
    worst = 0.0
    for wid, optics, slot in combos:
        for optic in optics:
            if only and f'{wid}:{optic}' not in only and wid not in only:
                continue
            equip(page, wid, optic, slot)
            page.evaluate(f'() => {{ game.player.yaw = {yaw}; game.player.pitch = 0; }}')
            aim(page, True)
            if '--hold-fire' in flags:
                page.evaluate("() => { game.input.down.add('Mouse0'); }")
                time.sleep(0.25)
            pts = page.evaluate(MEASURE)
            nx = max(abs(p[0]) for p in pts)
            ny = max(abs(p[1]) for p in pts)
            worst = max(worst, nx * w / 2, ny * h / 2)
            print(f'{wid:12} {optic:8} {nx * w / 2:7.1f} {ny * h / 2:7.1f}')
            q.shot(page, f'{prefix}-{wid}-{optic}.png')
            if '--hold-fire' in flags:
                page.evaluate("() => { game.input.down.delete('Mouse0'); }")
                page.evaluate("() => { game.arcade.ammo.forEach((a) => { a.mag = 30; a.reloading = false; }); }")
            aim(page, False)
    print(f'worst sight offset: {worst:.1f} px')
    print('\n'.join(logs[:20]) or 'no console errors')
    b.close()
