"""
One screenshot per optic, fully aimed at a bot in a local preview match: iron sights, red dot, holographic, combat scope,
the DMR's scope and the bolt-action sniper's scope at both zoom levels.

  QA_SERVER_PORT=3743 npx vite --config scripts/qa/vite.qa.config.mjs --port 5743
  QA_VITE=http://localhost:5743 python3 scripts/qa/scope-shots.py [out-dir=docs/screenshots/arcade]

Output: <out-dir>/scope-<name>.png
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

q.SHOTS = sys.argv[1] if len(sys.argv) > 1 else 'docs/screenshots/arcade'

# Turn towards a living bot in the open between 12 and 70 blocks (the range finder must see it), frozen in place.
AIM_AT_BOT = """() => {
  const a = game.arcade, p = game.player, pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  let best = null;
  for (const id of a.players.keys()) {
    if (id === a.d.selfId || !game.remote.isAlive(id) || !game.remote.pose(id, pose)) continue;
    const dx = pose.x - p.x, dy = pose.y + 1.45 - p.eyeY, dz = pose.z - p.z, d = Math.hypot(dx, dy, dz);
    if (d < 12 || d > 70) continue;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const oy = p.yaw, op = p.pitch;
    p.yaw = yaw; p.pitch = pitch;
    const r = a.rangeAhead();
    p.yaw = oy; p.pitch = op;
    if (Math.abs(r - d) < 1.5 && (!best || d < best.d)) best = { yaw, pitch, d };
  }
  if (best) { p.yaw = best.yaw; p.pitch = best.pitch; }
  return best ? best.d : -1;
}"""

SHOTS = [
    ('iron', 'rifle', 'iron', 0), ('reddot', 'rifle', 'reddot', 0), ('holo', 'rifle', 'holo', 0), ('combat', 'rifle', 'combat', 0),
    ('dmr', 'dmr', 'scope', 0), ('sniper', 'sniper', 'scope', 0), ('sniper-zoom', 'sniper', 'scope', 1),
]

with sync_playwright() as pw:
    b = q.launch(pw)
    logs = []
    page = q.open_game(b, logs=logs)
    q.start_preview(page, 'ffa', 'classic')
    time.sleep(3)
    q.force_playing(page)
    page.evaluate('() => { game.previewServer.botsAggressive = false; game.stack.clear(); }')
    # The spawn sits behind glass (bullets and the range finder stop there): stand where a bot stands, out in the arena.
    page.evaluate("""() => {
      const a = game.arcade, p = game.player, pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
      let far = null;
      for (const id of a.players.keys()) {
        if (id === a.d.selfId || !game.remote.pose(id, pose)) continue;
        const d = Math.hypot(pose.x - p.x, pose.z - p.z);
        if (!far || d > far.d) far = { d, x: pose.x, y: pose.y, z: pose.z };
      }
      if (far) p.setPosition(far.x + 0.5, far.y, far.z + 0.5);
    }""")
    time.sleep(1.5)
    for name, wid, optic, level in SHOTS:
        page.evaluate(f"() => {{ game.arcade.applyGear('{wid}', 'pistol', '{optic}', 'none'); game.arcade.equipSlot(0, false); }}")
        time.sleep(0.6)
        d = -1
        for _ in range(40):
            d = page.evaluate(AIM_AT_BOT)
            if d > 0:
                break
            time.sleep(0.25)
        page.evaluate("() => game.input.down.add('Mouse2')")
        time.sleep(0.8)
        if level:
            page.evaluate('() => { game.input.wheel = -1; }')
            time.sleep(0.4)
        page.evaluate(AIM_AT_BOT)
        time.sleep(0.12)
        print(name, f'bot at {d:.1f}' if d > 0 else 'no bot in view', q.shot(page, f'scope-{name}.png'))
        page.evaluate("() => { game.input.down.delete('Mouse2'); game.input.wheel = 1; }")
        time.sleep(0.5)
    print('\n'.join(logs[:10]) or 'no console errors')
    b.close()
