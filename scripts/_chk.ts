const R = '/Users/stijnvandepol/Documents/GitHub/Bunkcraft/.claude/worktrees/agent-a1c6075eb42006da4';
const { ARENA_FLOOR_Y, getMap } = await import(R + '/src/modes/maps');
const { reachable, keyOf, openShare, standable } = await import(R + '/tests/helpers/mapAnalysis');
const map = getMap(process.argv[2] as never);
const at = (x: number, y: number, z: number) => map.blockAt(0, x, y, z);
const sp = map.spawns.red[0];
const seen = reachable(map, 0, Math.floor(sp.x), Math.floor(sp.z));
for (const [kind, list] of Object.entries(map.spawns)) {
  list.forEach((s, i) => {
    const bad: string[] = [];
    for (const dy of [1, 2]) for (const [ox, oz] of [[0, 0], [0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]]) if (at(Math.floor(s.x + ox), ARENA_FLOOR_Y + dy, Math.floor(s.z + oz)) !== 0) bad.push(`${dy}:${ox},${oz}`);
    const ok = seen.has(keyOf(Math.floor(s.x), Math.floor(s.z), ARENA_FLOOR_Y));
    if (bad.length || !ok) console.log(kind, i, s.x, s.z, bad.length ? 'BLOCKED' : '', ok ? '' : 'UNREACHABLE');
  });
}
for (const z of map.zones) console.log('zone', z.name, z.x, z.z, 'y', z.y, 'reach', seen.has(keyOf(Math.floor(z.x), Math.floor(z.z), z.y - 1)), 'open', openShare(map, 0, z.x, z.z, z.y, z.r).toFixed(2));
for (const f of map.flags) console.log('flag', f.team, f.x, f.z, 'reach', seen.has(keyOf(Math.floor(f.x), Math.floor(f.z), f.y - 1)), 'open', openShare(map, 0, f.x, f.z, f.y, 1.6).toFixed(2));
for (const f of map.sites) console.log('site', f.name, f.x, f.z, 'reach', seen.has(keyOf(Math.floor(f.x), Math.floor(f.z), ARENA_FLOOR_Y)), 'open', openShare(map, 0, f.x, f.z, f.y, 3).toFixed(2));
void standable;
