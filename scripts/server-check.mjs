// BunkCraft deploy checks, run INSIDE the game server container (it has Node and ADMIN_TOKEN in its environment):
//
//   docker compose exec -T bunkcraft node --input-type=module - <command> [args] < scripts/server-check.mjs
//
// The host needs neither curl nor jq, and the admin token never appears on a command line.
//   health             print /health; exit 0 when ok
//   players            print "<players in play> <players online>" (auto-update waits for the first to be 0)
//   announce <text>    system chat line in every game (exit 3: admin disabled, no ADMIN_TOKEN)
//   save               write every loaded world to disk now (exit 3: admin disabled)
//   smoke              post-deploy smoke test: /health, the game page and its script, the JSON API, and with
//                      ADMIN_TOKEN a throw-away game that is created, looked up and deleted again
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const token = process.env.ADMIN_TOKEN || '';
const [cmd = 'health', ...args] = process.argv.slice(2);

async function get(path, init = {}) {
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: await res.text() };
}
const admin = (path, body = {}) => get(`/api/admin/${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exit(1); };

try {
  if (cmd === 'health') {
    const h = await get('/health');
    console.log(h.text);
    process.exit(h.status === 200 && JSON.parse(h.text).ok === true ? 0 : 1);
  }
  if (cmd === 'players') {
    const h = JSON.parse((await get('/health')).text);
    // Servers from before playersInPlay existed: every online player counts.
    console.log(`${h.playersInPlay ?? h.players ?? 0} ${h.players ?? 0}`);
    process.exit(0);
  }
  if (cmd === 'announce' || cmd === 'save') {
    if (!token) { console.log('admin disabled (no ADMIN_TOKEN)'); process.exit(3); }
    const r = cmd === 'announce' ? await admin('announce', { text: args.join(' ') }) : await admin('save');
    console.log(r.text);
    process.exit(r.status === 200 ? 0 : 1);
  }
  if (cmd === 'smoke') {
    const h = await get('/health');
    if (h.status !== 200 || JSON.parse(h.text).ok !== true) fail(`/health ${h.status}`);
    const version = JSON.parse(h.text).version;
    const page = await get('/');
    if (page.status !== 200 || !page.text.includes('<script')) fail(`game page ${page.status}`);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    if (!script) fail('game page has no /assets/*.js script');
    const js = await get(script);
    if (js.status !== 200 || js.text.length < 1000) fail(`${script} ${js.status}`);
    const server = await get('/api/server');
    if (server.status !== 200) fail(`/api/server ${server.status}`);
    const info = JSON.parse(server.text);
    let game = 'games off';
    if (info.rooms && token) {
      const made = await get('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Deploy smoke test' }) });
      if (made.status === 429) {
        game = 'game create rate-limited (skipped)';
      } else {
        if (made.status !== 201) fail(`create game ${made.status} ${made.text}`);
        const { code } = JSON.parse(made.text);
        const look = await get(`/api/rooms/${code}`);
        const del = await admin(`rooms/${code}/close`, { remove: true });
        if (look.status !== 200) fail(`look up game ${code}: ${look.status}`);
        if (del.status !== 200) fail(`delete game ${code}: ${del.status}`);
        game = 'game created+deleted';
      }
    } else if (info.rooms) {
      const list = await get('/api/rooms?public=1');
      if (list.status !== 200) fail(`/api/rooms?public=1 ${list.status}`);
      game = 'game list';
    }
    console.log(`OK ${version}: health, page, ${script.split('/').pop()}, api, ${game}`);
    process.exit(0);
  }
  console.log(`unknown command ${cmd}`);
  process.exit(2);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
