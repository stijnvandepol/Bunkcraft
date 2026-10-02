/**
 * The admin page: static HTML, no framework, no secrets inside. It asks for the ADMIN_TOKEN, keeps it in
 * sessionStorage for this tab only and talks to /api/admin/*. Everything dynamic is inserted with
 * textContent, never as HTML.
 */
export const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BunkCraft admin</title>
<style>
  :root { color-scheme: dark light; --bg:#14161a; --fg:#e6e8eb; --mute:#8b93a1; --card:#1d2026; --line:#2c313a; --accent:#6cc070; --bad:#e06c6c; }
  @media (prefers-color-scheme: light) { :root { --bg:#f4f5f7; --fg:#1b1e23; --mute:#5d6674; --card:#fff; --line:#d9dde3; --accent:#2f8a3a; --bad:#c0392b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.4 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; } h2 { font-size: 15px; margin: 24px 0 8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:8px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .card b { display:block; font-size:20px; } .card span { color:var(--mute); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mute); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  input { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; min-width:0; }
  button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; }
  button:hover { border-color: var(--accent); } button.danger:hover { border-color: var(--bad); color: var(--bad); }
  .mute { color:var(--mute); } .err { color:var(--bad); min-height:1.4em; } code { font-family: ui-monospace, monospace; }
  .players { margin: 4px 0 0; padding: 0; list-style: none; } .players li { display:flex; gap:8px; align-items:center; padding:2px 0; }
  .wrap { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>BunkCraft admin</h1>
  <form id="login" class="row" autocomplete="off">
    <input id="token" type="password" placeholder="Admin token" size="36" aria-label="Admin token">
    <button type="submit">Sign in</button>
    <button type="button" id="logout" hidden>Sign out</button>
  </form>
  <div id="err" class="err" role="alert"></div>
  <section id="app" hidden>
    <div class="cards" id="stats"></div>
    <h2>Games</h2>
    <div class="wrap"><table id="rooms"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Players</th><th>Flags</th><th></th></tr></thead><tbody></tbody></table></div>
    <h2>Blocked addresses</h2>
    <form id="banform" class="row"><input id="banip" placeholder="IP address" size="24" aria-label="IP address"><button type="submit">Block</button></form>
    <ul id="bans" class="players"></ul>
  </section>
</main>
<script>
(function () {
  var tokenKey = 'bunkcraft.admin';
  var token = '';
  try { token = sessionStorage.getItem(tokenKey) || ''; } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var timer = 0;
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (cls) e.className = cls; return e; }
  function api(method, path, body) {
    return fetch('/api/admin' + path, {
      method: method,
      headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(r.status === 401 ? 'Wrong token' : (j.error || 'Error ' + r.status));
        return j;
      });
    });
  }
  function fmtTime(s) { var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }
  function mb(b) { return Math.round(b / 1048576) + ' MB'; }
  function stat(label, value) { var c = el('div', undefined, 'card'); c.append(el('b', value), el('span', label)); return c; }
  function act(label, fn, danger) { var b = el('button', label, danger ? 'danger' : ''); b.type = 'button'; b.onclick = fn; return b; }
  function fail(e) { $('err').textContent = e.message; }

  function playersList(owner, code) {
    var ul = el('ul', undefined, 'players');
    return api('GET', owner === 'main' ? '/main/players' : '/rooms/' + code + '/players').then(function (r) {
      r.players.forEach(function (p) {
        var li = el('li');
        li.append(el('span', p.name + (p.op ? ' (op)' : '')), el('span', p.ip + ' / ' + p.pingMs + ' ms', 'mute'));
        li.append(act('Kick', function () {
          api('POST', owner === 'main' ? '/main/kick' : '/rooms/' + code + '/kick', { name: p.name }).then(refresh, fail);
        }), act('Block IP', function () {
          api('POST', '/ip-bans', { ip: p.ip }).then(refresh, fail);
        }, true));
        ul.append(li);
      });
      return ul;
    });
  }

  function render(stats, rooms, bans) {
    var s = $('stats'); s.textContent = '';
    s.append(stat('Players', stats.players), stat('Games loaded', stats.roomsLoaded + ' / ' + stats.roomsTotal), stat('Connections', stats.connections),
      stat('Uptime', fmtTime(stats.uptimeSeconds)), stat('CPU', Math.round(stats.cpu * 100) + '%'), stat('Memory', mb(stats.rssBytes)),
      stat('Tick p50 / p99', stats.tickP50Ms.toFixed(2) + ' / ' + stats.tickP99Ms.toFixed(2) + ' ms'),
      stat('Traffic out', Math.round(stats.bytesOutPerSec / 1024) + ' KiB/s'), stat('Version', stats.version));
    var body = $('rooms').tBodies[0]; body.textContent = '';
    var all = rooms.main ? [{ code: 'main', name: rooms.main.name, gameType: 'main world', players: rooms.main.players, flags: [] }] : [];
    rooms.rooms.forEach(function (r) {
      var flags = []; if (r.locked) flags.push('password'); if (r.listed) flags.push('listed'); if (!r.loaded) flags.push('idle');
      all.push({ code: r.code, name: r.name, gameType: r.gameType + ' / ' + r.gameMode, players: r.players, flags: flags });
    });
    all.forEach(function (r) {
      var tr = el('tr'); var last = el('td'); var pl = el('td');
      tr.append(el('td', r.code), el('td', r.name), el('td', r.gameType), pl, el('td', r.flags.join(', '), 'mute'), last);
      pl.append(el('span', r.players));
      if (r.players > 0) {
        var open = act('Show', function () {
          open.remove();
          playersList(r.code === 'main' ? 'main' : 'room', r.code).then(function (ul) { pl.append(ul); }, fail);
        });
        pl.append(' ', open);
      }
      if (r.code !== 'main') {
        last.append(act('Close', function () {
          if (confirm('Disconnect everybody in ' + r.code + '? The game stays on disk.')) api('POST', '/rooms/' + r.code + '/close', { remove: false }).then(refresh, fail);
        }), ' ', act('Delete', function () {
          if (confirm('Delete game ' + r.code + ' (' + r.name + ') for good?')) api('POST', '/rooms/' + r.code + '/close', { remove: true }).then(refresh, fail);
        }, true));
      }
      body.append(tr);
    });
    var ul = $('bans'); ul.textContent = '';
    bans.ips.forEach(function (ip) {
      var li = el('li'); li.append(el('code', ip), act('Unblock', function () { api('DELETE', '/ip-bans/' + encodeURIComponent(ip)).then(refresh, fail); }));
      ul.append(li);
    });
    if (!bans.ips.length) ul.append(el('li', 'None', 'mute'));
  }

  function refresh() {
    if (!token) return Promise.resolve();
    return Promise.all([api('GET', '/stats'), api('GET', '/rooms'), api('GET', '/ip-bans')]).then(function (r) {
      $('err').textContent = ''; $('app').hidden = false; $('logout').hidden = false;
      render(r[0], r[1], r[2]);
    }, function (e) { fail(e); if (e.message === 'Wrong token') signOut(); });
  }
  function signOut() {
    token = ''; try { sessionStorage.removeItem(tokenKey); } catch (e) {}
    $('app').hidden = true; $('logout').hidden = true; clearInterval(timer);
  }
  $('login').onsubmit = function (e) {
    e.preventDefault();
    token = $('token').value.trim(); $('token').value = '';
    try { sessionStorage.setItem(tokenKey, token); } catch (err) {}
    refresh().then(function () { clearInterval(timer); timer = setInterval(refresh, 5000); });
  };
  $('logout').onclick = signOut;
  $('banform').onsubmit = function (e) {
    e.preventDefault();
    var ip = $('banip').value.trim(); if (!ip) return;
    api('POST', '/ip-bans', { ip: ip }).then(function () { $('banip').value = ''; refresh(); }, fail);
  };
  if (token) { refresh().then(function () { timer = setInterval(refresh, 5000); }); }
})();
</script>
</body>
</html>
`;
