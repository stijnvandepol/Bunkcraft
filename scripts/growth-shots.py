"""
Screenshots and an in-browser measurement of the random tick system: saplings growing into every tree type, leaves
decaying after the trunks are cut, falling sand and gravel, sugar cane and cactus. Needs a Vite dev server without
HMR or file watching on the given port (see CLAUDE.md), e.g. a temporary config with
`server: { hmr: false, watch: null }`.

  python3 scripts/growth-shots.py <outdir> [port]
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
  const G = await import('/src/world/Growth.ts');
  window.__R = R; window.__G = G;
  const g = window.game, w = g.world, B = R.BLOCK;
  const x0 = Math.floor(g.player.x) - 20, z0 = Math.floor(g.player.z) - 40, y0 = Math.floor(g.player.y) + 6;
  w.batch(() => {
    for (let x = -2; x < 44; x++) for (let z = -2; z < 30; z++) {
      w.setBlock(x0 + x, y0 - 2, z0 + z, B.STONE);
      w.setBlock(x0 + x, y0 - 1, z0 + z, B.GRASS);
      for (let y = 0; y < 16; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0);
    }
  });
  window.__o = [x0, y0, z0];
  return window.__o;
}
"""

SAPLINGS = """
() => {
  const g = window.game, w = g.world, B = window.__R.BLOCK;
  const [x0, y0, z0] = window.__o;
  for (let v = 0; v < 7; v++) w.setBlock(x0 + 3 + v * 6, y0, z0 + 8, B.SAPLING, v);
  g.player.setPosition(x0 + 21.5, y0 + 3, z0 + 22);
  g.player.yaw = 0; g.player.pitch = -0.12; g.player.flying = true;
}
"""

GROW = """
() => {
  const w = window.game.world, G = window.__G, R = window.__R;
  const [x0, y0, z0] = window.__o;
  const grown = [];
  w.batch(() => {
    for (let v = 0; v < 7; v++) {
      const x = x0 + 3 + v * 6;
      w.setBlock(x, y0, z0 + 8, R.BLOCK.SAPLING, v | R.SAPLING_STAGE_BIT);
      grown.push(G.growTree(w.randomTicker, x, y0, z0 + 8));
    }
  });
  window.game.player.setPosition(x0 + 21.5, y0 + 6, z0 + 26);
  window.game.player.pitch = -0.2;
  return grown;
}
"""

CUT = """
() => {
  const w = window.game.world, R = window.__R;
  const [x0, y0, z0] = window.__o;
  // Cut the trunks of the oak, birch, acacia and cherry; the leaves have nothing left to hold on to.
  for (const v of [0, 2, 4, 6]) {
    const x = x0 + 3 + v * 6;
    for (let y = 0; y < 14; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const id = w.getBlock(x + dx, y0 + y, z0 + 8 + dz);
      if (R.getBlockDef(id)?.name.endsWith('_log')) w.setBlock(x + dx, y0 + y, z0 + 8 + dz, 0);
    }
  }
  w.randomTicker.setSpeed(150);
}
"""

FALL = """
() => {
  const g = window.game, w = g.world, B = window.__R.BLOCK;
  const [x0, y0, z0] = window.__o;
  w.randomTicker.setSpeed(3);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 4; z++) {
    w.setBlock(x0 + 18 + x, y0 + 14 + ((x + z) % 3), z0 + 18 + z, (x + z) % 2 ? B.SAND : B.GRAVEL);
  }
  g.player.setPosition(x0 + 21, y0 + 6, z0 + 34);
  g.player.pitch = -0.05;
}
"""

CANE = """
() => {
  const g = window.game, w = g.world, B = window.__R.BLOCK, CU = window.__R.CUBE_ID;
  const [x0, y0, z0] = window.__o;
  w.batch(() => {
    for (let x = 2; x < 16; x++) {
      w.setBlock(x0 + x, y0 - 1, z0 + 22, B.WATER);
      w.setBlock(x0 + x, y0 - 1, z0 + 21, B.SAND);
      w.setBlock(x0 + x, y0 - 1, z0 + 23, B.SAND);
      if (x % 2 === 0) { w.setBlock(x0 + x, y0, z0 + 21, CU.sugar_cane); w.setBlock(x0 + x, y0, z0 + 23, CU.sugar_cane); }
    }
    for (let x = 20; x < 30; x += 2) { w.setBlock(x0 + x, y0 - 1, z0 + 22, B.SAND); w.setBlock(x0 + x, y0, z0 + 22, B.CACTUS); }
  });
  w.randomTicker.setSpeed(1500);
  g.player.setPosition(x0 + 15, y0 + 4, z0 + 32);
  g.player.yaw = 0; g.player.pitch = -0.2;
}
"""

MEASURE = """
async () => {
  const g = window.game, w = g.world;
  w.randomTicker.setSpeed(3);
  w.randomTicker.budgetMs = 1.5;
  const samples = [];
  const handled = [];
  let last = w.randomTicker.stats.ticks;
  const t0 = performance.now();
  while (performance.now() - t0 < 12000) {
    await new Promise((r) => setTimeout(r, 25));
    const s = w.randomTicker.stats;
    if (s.ticks !== last) { last = s.ticks; samples.push(s.lastMs); handled.push(s.handled); }
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { renderDistance: w.chunks.renderDistance, chunks: w.chunks.chunks.size, ticks: samples.length, avg, p50: samples[samples.length >> 1],
    p99: samples[Math.floor(samples.length * 0.99)], max: samples[samples.length - 1], handledPerTick: handled.reduce((a, b) => a + b, 0) / handled.length,
    fps: g.debug?.fps ?? null };
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
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=60000)
    page.evaluate("window.game.createWorld('growth', '4242', 'creative')")
    for _ in range(1500):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    print('state', page.evaluate("window.game.state"))
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    # The pause overlay ("Click to play") stays up when pointer lock is faked: hide it for the pictures.
    page.add_style_tag(content='.click-hint { display: none !important; }')
    page.evaluate("window.game.world.chunks.renderDistance = 12")
    settle(page, 3)
    print('prep', page.evaluate(PREP))

    page.evaluate(SAPLINGS)
    settle(page, 2.5)
    page.screenshot(path=f'{out}/growth-saplings.png')
    print('grown', page.evaluate(GROW))
    settle(page, 2.5)
    page.screenshot(path=f'{out}/growth-trees.png')

    page.evaluate(CUT)
    settle(page, 2.0)
    page.screenshot(path=f'{out}/growth-leaf-decay.png')
    settle(page, 6)
    page.screenshot(path=f'{out}/growth-leaf-decay-later.png')

    page.evaluate(FALL)
    settle(page, 0.9)
    page.screenshot(path=f'{out}/growth-falling-sand.png')
    settle(page, 3)
    page.screenshot(path=f'{out}/growth-sand-landed.png')

    page.evaluate(CANE)
    settle(page, 6)
    page.screenshot(path=f'{out}/growth-cane-cactus.png')

    # The per-tick cost at render distance 12 while the player stands in the world (speed 3).
    page.evaluate("window.game.player.setPosition(window.game.player.x, window.game.player.y + 30, window.game.player.z)")
    settle(page, 5)
    print('measure', json.dumps(page.evaluate(MEASURE)))
    print('logs', logs[:10])
    browser.close()
