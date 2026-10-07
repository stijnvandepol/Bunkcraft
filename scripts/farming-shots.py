"""
Screenshots of farming (see src/world/Farming.ts): a farm with every crop at every growth stage, the same farm young and
ripe, wet and dry farmland, a field that really grows (random ticks sped up) and the F3 line of a crop. Needs a Vite dev
server without HMR or file watching on the given port (see CLAUDE.md), e.g. tests/e2e/vite.e2e.config.ts with
E2E_VITE_PORT set.

  python3 scripts/farming-shots.py <outdir> [port]
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5198'

PREP = """
async () => {
  const R = await import('/src/world/BlockRegistry.ts');
  const C = await import('/src/world/Crops.ts');
  window.__R = R; window.__C = C;
  const g = window.game, w = g.world, B = R.BLOCK;
  const x0 = Math.floor(g.player.x) - 9, z0 = Math.floor(g.player.z) - 24, y0 = Math.floor(g.player.y) + 4;
  w.batch(() => {
    for (let x = -4; x < 24; x++) for (let z = -4; z < 22; z++) {
      w.setBlock(x0 + x, y0 - 2, z0 + z, B.DIRT);
      w.setBlock(x0 + x, y0 - 1, z0 + z, B.GRASS);
      for (let y = 0; y < 14; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0);
    }
  });
  window.__o = [x0, y0, z0];
  return window.__o;
}
"""

# The farm: 17 x 12 farmland with a water channel in the middle (x = 8), two rows per crop kind.
# mode: 'stages' (stage grows along x), 'young', 'ripe', 'bare' (no crops), 'drywet' (left wet, right dry, no crops).
FARM = """
(mode) => {
  const g = window.game, w = g.world, B = window.__R.BLOCK, CU = window.__R.CUBE_ID, C = window.__C;
  const [x0, y0, z0] = window.__o;
  // Far rows first: the wheat is nearest to the camera.
  const kinds = ['pumpkin_stem', 'melon_stem', 'beetroots', 'potatoes', 'carrots', 'wheat'];
  w.batch(() => {
    for (let x = -3; x < 21; x++) for (let z = -3; z < 15; z++) {
      w.setBlock(x0 + x, y0 - 1, z0 + z, B.GRASS);
      w.setBlock(x0 + x, y0, z0 + z, 0);
    }
    for (let x = 0; x < 17; x++) for (let z = 0; z < 12; z++) {
      if (x === 8) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.WATER); continue; }
      const wet = mode !== 'drywet' || x < 8;
      const f = C.farmlandState(wet);
      w.setBlock(x0 + x, y0 - 1, z0 + z, f.id, f.meta);
      if (mode === 'bare' || mode === 'drywet') continue;
      const kind = kinds[z >> 1];
      const col = x < 8 ? x : x - 1; // 0..15
      const stage = mode === 'young' ? Math.floor(col / 6) : mode === 'ripe' ? 99 : Math.floor((col / 15) * 7.99);
      const s = C.cropState(kind, kind === 'beetroots' && mode === 'stages' ? Math.floor(stage / 2) : stage);
      w.setBlock(x0 + x, y0, z0 + z, s.id, s.meta);
    }
    // Ripe stems in the far row carry their fruit beyond the farm: attached stems bent towards pumpkins and melons.
    if (mode === 'ripe') {
      for (const x of [0, 2, 4, 6, 10, 12, 14, 16]) {
        const melon = x % 4 === 2;
        w.setBlock(x0 + x, y0 - 1, z0 - 1, B.DIRT);
        w.setBlock(x0 + x, y0, z0 - 1, melon ? CU.melon : CU.pumpkin);
        w.setBlock(x0 + x, y0, z0, melon ? C.CROP_BLOCK.MELON_STEM : C.CROP_BLOCK.PUMPKIN_STEM, C.attachedStemMeta(0));
      }
    }
  });
}
"""

VIEW = """
([dx, dy, dz, pitch]) => {
  const g = window.game, [x0, y0, z0] = window.__o;
  g.player.setPosition(x0 + dx, y0 + dy, z0 + dz);
  g.player.yaw = 0; g.player.pitch = pitch; g.player.flying = true;
}
"""

# A real field: 16 x 9 of seeds on wet farmland (rows of each crop), random ticks sped up so it grows in seconds.
GROW = """
() => {
  const g = window.game, w = g.world, B = window.__R.BLOCK, C = window.__C;
  const [x0, y0, z0] = window.__o;
  const kinds = ['wheat', 'wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin_stem', 'melon_stem'];
  w.batch(() => {
    for (let x = -3; x < 21; x++) for (let z = -3; z < 15; z++) {
      w.setBlock(x0 + x, y0 - 1, z0 + z, B.GRASS);
      w.setBlock(x0 + x, y0, z0 + z, 0);
    }
    for (let x = 0; x < 17; x++) for (let z = 0; z < 13; z++) {
      if (x === 8) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.WATER); continue; }
      w.setBlock(x0 + x, y0 - 1, z0 + z, C.FARMLAND, 0); // tilled: dry until its first random tick
      // Stems get every other row free so their fruit has somewhere to go.
      const kind = kinds[z >> 1];
      if (kind && !((kind.endsWith('stem')) && (z & 1))) w.setBlock(x0 + x, y0, z0 + z, C.cropBlock(kind), 0);
    }
  });
  // Sped up (and a small radius with a big time budget) so the field grows in seconds.
  w.randomTicker.radius = 2; w.randomTicker.budgetMs = 20; w.randomTicker.setSpeed(200);
}
"""

COUNT = """
() => {
  const w = window.game.world, C = window.__C, R = window.__R;
  const [x0, y0, z0] = window.__o;
  const ages = {};
  let pumpkins = 0, melons = 0, wet = 0;
  for (let x = -1; x < 18; x++) for (let z = -1; z < 14; z++) {
    const id = w.getBlock(x0 + x, y0, z0 + z), meta = w.getMeta(x0 + x, y0, z0 + z);
    const spec = C.cropSpec(id);
    if (spec) (ages[spec.kind] ??= []).push(C.cropAge(id, meta));
    if (id === R.CUBE_ID.pumpkin) pumpkins++;
    if (id === R.CUBE_ID.melon) melons++;
    if (w.getBlock(x0 + x, y0 - 1, z0 + z) === C.FARMLAND && (w.getMeta(x0 + x, y0 - 1, z0 + z) & 7) === 7) wet++;
  }
  const mean = Object.fromEntries(Object.entries(ages).map(([k, a]) => [k, +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2)]));
  return { mean, pumpkins, melons, wet };
}
"""

F3 = """
() => {
  const g = window.game, [x0, y0, z0] = window.__o;
  // Aim at the wheat in front (the nearest rows of the 'stages' farm), column 5.
  g.player.setPosition(x0 + 5.5, y0 + 0.4, z0 + 12.6);
  g.player.yaw = 0; g.player.pitch = -0.75;
  if (!g.debug.isVisible) g.debug.toggle();
}
"""


def settle(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        page.bring_to_front()
        time.sleep(0.2)


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    # The title screen must be up first (a world created before it is replaced by the menu panorama).
    page.wait_for_function("!!(window.game && window.game.createWorld && window.game.state === 'menu' && document.querySelector('button'))", timeout=60000)
    page.evaluate("window.game.createWorld('farming', '4242', 'creative')")
    for i in range(1500):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        if i % 50 == 49 and page.evaluate("window.game.state") == 'menu':
            page.evaluate("window.game.createWorld('farming', '4242', 'creative')")
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    page.add_style_tag(content='.click-hint, .chat { display: none !important; }')
    # No HUD and no hand in the pictures (F1).
    page.evaluate("window.game.hudHidden = true; window.game.hud.setVisible(false); window.game.renderer.afterMain = null")
    page.evaluate("window.game.chat.onSend('/weather clear'); window.game.chat.onSend('/gamerule doDaylightCycle false')")
    settle(page, 3)
    print('prep', page.evaluate(PREP))
    # Freeze growth while posing the farm.
    page.evaluate("window.game.world.randomTicker.setSpeed(0)")

    for name, mode, view in [
        ('farming-stages', 'stages', [8.5, 4.2, 17.5, -0.42]),
        ('farming-stages-closeup', 'stages', [4.5, 1.9, 13.2, -0.38]),
        ('farming-young', 'young', [8.5, 4.2, 17.5, -0.42]),
        ('farming-ripe', 'ripe', [8.5, 4.2, 17.5, -0.42]),
        ('farming-wet-dry', 'drywet', [8.5, 4.6, 16.5, -0.62]),
    ]:
        page.evaluate(FARM, mode)
        page.evaluate(VIEW, view)
        settle(page, 2.5)
        page.screenshot(path=f'{out}/{name}.png')

    page.evaluate(FARM, 'stages')
    page.evaluate(F3)
    settle(page, 2.5)
    page.screenshot(path=f'{out}/farming-f3.png')
    page.evaluate("window.game.debug.toggle()")

    page.evaluate(GROW)
    page.evaluate(VIEW, [8.5, 4.2, 18.5, -0.42])
    settle(page, 1.0)
    print('grow t=1s', json.dumps(page.evaluate(COUNT)))
    page.screenshot(path=f'{out}/farming-growing-1.png')
    settle(page, 5)
    print('grow t=6s', json.dumps(page.evaluate(COUNT)))
    page.screenshot(path=f'{out}/farming-growing-2.png')
    settle(page, 15)
    print('grow t=21s', json.dumps(page.evaluate(COUNT)))
    page.screenshot(path=f'{out}/farming-growing-3.png')
    page.evaluate("window.game.world.randomTicker.setSpeed(3)")
    print('logs', logs[:10])
    browser.close()
