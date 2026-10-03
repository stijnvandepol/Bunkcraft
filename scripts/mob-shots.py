"""
Screenshots of the mobs (new kinds front and side, babies, sheep colours, wolf taming, enderman, horses) through the
dev build. Needs a Vite dev server without HMR or file watching on the given port (see CLAUDE.md).

  python3 scripts/mob-shots.py <outdir> [port]
"""
import sys
import time

from playwright.sync_api import sync_playwright

out = sys.argv[1]
port = sys.argv[2] if len(sys.argv) > 2 else '5199'

# Builds a stone stage in front of the player and spawns `lineup` (kind, options) in a row facing `yaw`.
STAGE = """
async ([lineup, yaw, spacing, camBack, camUp, pitch]) => {
  const R = await import('/src/world/BlockRegistry.ts');
  const g = window.game, w = g.world, B = R.BLOCK;
  if (!window.__stage) {
    const x0 = Math.floor(g.player.x), z0 = Math.floor(g.player.z) - 10, y0 = Math.floor(g.player.y) + 6;
    for (let x = -24; x <= 24; x++) for (let z = -8; z <= 14; z++) {
      w.setBlock(x0 + x, y0 - 1, z0 + z, B.GRASS);
      for (let y = 0; y < 8; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0);
    }
    window.__stage = [x0, y0, z0];
  }
  const [x0, y0, z0] = window.__stage;
  if (g.entities.__tick) g.entities.tick = g.entities.__tick;
  for (const m of g.entities.mobs) m.removed = true;
  g.entities.mobs.length = 0;
  g.entities.hostileSpawning = false;
  g.entities.passiveSpawning = false;
  const n = lineup.length;
  const mobs = lineup.map(([kind, o], i) => {
    const m = g.entities.spawnMob(kind, x0 + (i - (n - 1) / 2) * spacing + 0.5, y0, z0 + 0.5);
    m.yaw = m.prevYaw = yaw;
    m.persistent = true;
    if (o.baby) m.setBaby(true);
    if (o.variant !== undefined) m.variant = o.variant;
    if (o.size) { m.size = o.size; m.refreshSize(); }
    // Owned by an absent player, so the wolf does not teleport to the camera.
    if (o.tamed) m.ownerId = 99;
    if (o.sitting) m.sitting = true;
    if (o.saddled) m.saddled = true;
    if (o.angry) m.angryTicks = 100000;
    if (o.dz) m.setPosition(m.x, m.y, m.z + o.dz);
    return m;
  });
  g.player.setPosition(x0 + 0.5, y0 + camUp, z0 + camBack);
  g.player.yaw = 0; g.player.pitch = pitch;
  g.player.flying = true;
  window.__mobs = mobs;
  window.__yaw = yaw;
  return mobs.length;
}
"""

# Freezes the scene: entity ticks stop (rendering goes on), every mob back at its spot and facing.
HOLD = """
() => {
  const g = window.game;
  g.entities.__tick ??= g.entities.tick;
  g.entities.tick = () => {};
  for (const m of window.__mobs) {
    m.yaw = m.prevYaw = window.__yaw; m.vx = m.vz = 0; m.limbAmount = 0; m.headYaw = 0; m.headPitch = 0;
    m.prevX = m.x; m.prevY = m.y; m.prevZ = m.z;
  }
}
"""


def settle(page, n=8):
    for _ in range(n):
        page.bring_to_front()
        time.sleep(0.25)


def shot(page, name, lineup, yaw, spacing=2.6, back=9.0, up=1.6, pitch=-0.12, extra=None):
    page.evaluate(STAGE, [lineup, yaw, spacing, back, up, pitch])
    page.evaluate(HOLD)
    settle(page)
    if extra:
        page.evaluate(extra)
        settle(page, 2)
    page.locator('#game').screenshot(path=f'{out}/{name}.png')
    print('shot', name)


NEW_A = [['wolf', {}], ['wolf', {'tamed': True}], ['enderman', {}], ['slime', {'size': 4}], ['slime', {'size': 2}], ['slime', {'size': 1}]]
NEW_B = [['drowned', {}], ['husk', {}], ['stray', {}], ['cave_spider', {}], ['witch', {}], ['horse', {'variant': 2}]]

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1600, 'height': 800})
    logs = []
    page.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append('PAGEERR ' + str(e)))
    page.goto(f'http://localhost:{port}/')
    page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=30000)
    page.evaluate("window.game.createWorld('mobshots', '777', 'creative')")
    for _ in range(300):
        page.bring_to_front()
        if page.evaluate("window.game.state") in ('playing', 'paused'):
            break
        time.sleep(0.2)
    page.evaluate("window.game.input.locked = true; window.game.state = 'playing'")
    settle(page, 6)

    shot(page, 'new-a-front', NEW_A, 3.14159, spacing=2.2, back=9, up=1.8)
    shot(page, 'new-a-side', NEW_A, 1.5708, spacing=2.2, back=9, up=1.8)
    shot(page, 'new-b-front', NEW_B, 3.14159, spacing=2.2, back=9, up=1.8)
    shot(page, 'new-b-side', NEW_B, 1.5708, spacing=2.2, back=9, up=1.8)
    shot(page, 'babies', [['pig', {}], ['pig', {'baby': True}], ['cow', {}], ['cow', {'baby': True}], ['sheep', {'variant': 6}],
                          ['sheep', {'baby': True, 'variant': 6}], ['chicken', {}], ['chicken', {'baby': True}],
                          ['wolf', {'tamed': True}], ['wolf', {'baby': True, 'tamed': True}], ['horse', {'variant': 4}],
                          ['horse', {'baby': True, 'variant': 4}]], 2.6, spacing=1.9, back=8, up=1.5)
    shot(page, 'sheep', [['sheep', {'variant': c}] for c in [0, 15, 7, 8, 12, 6, 14, 11, 4]] + [['sheep', {'variant': 16}]],
         3.14159, spacing=1.6, back=7, up=1.6)
    shot(page, 'wolf-taming', [['wolf', {'tamed': True, 'sitting': True}], ['wolf', {'tamed': True, 'variant': 11}],
                               ['wolf', {'angry': True}], ['wolf', {}]], 2.4, spacing=1.8, back=6, up=1.3, pitch=-0.15,
         extra="() => { const g = window.game; const r = g.mobRenderer; for (const m of window.__mobs.slice(0, 2)) r.emote('tame', m.x, m.y + m.height, m.z, m.width); r.emote('smoke', window.__mobs[3].x, window.__mobs[3].y + 0.9, window.__mobs[3].z); }")
    shot(page, 'enderman', [['enderman', {}], ['enderman', {'angry': True}]], 2.8, spacing=2.4, back=5.5, up=1.6, pitch=0.12)
    shot(page, 'horses', [['horse', {'variant': c, 'tamed': True, 'saddled': c % 2 == 0}] for c in range(7)], 1.5708,
         spacing=2.0, back=8, up=1.8)
    print('\n'.join(logs[:20]))
    browser.close()
