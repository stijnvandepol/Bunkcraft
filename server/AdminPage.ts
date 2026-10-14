/**
 * The admin page: static HTML, no framework, no secrets inside. It asks for the ADMIN_TOKEN, keeps it in
 * sessionStorage for this tab only and talks to /api/admin/*. Everything dynamic is inserted with
 * textContent, never as HTML.
 */
export const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  .skin-thumb { width:64px; height:64px; image-rendering:pixelated; background:repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0 / 16px 16px; border:1px solid var(--line); }
  .hash { font-family: ui-monospace, monospace; font-size:11px; word-break:break-all; }
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
    <section id="matches" hidden>
      <h2>Match containers</h2>
      <div class="mute" id="matchinfo"></div>
      <div class="wrap"><table id="matchtable"><thead><tr><th>Runner</th><th>State</th><th>Game</th><th>Players</th><th>CPU</th><th>Memory</th><th>Tick p99</th><th>Up</th><th>Version</th></tr></thead><tbody></tbody></table></div>
    </section>
    <h2>Blocked addresses</h2>
    <form id="banform" class="row"><input id="banip" placeholder="IP address" size="24" aria-label="IP address"><button type="submit">Block</button></form>
    <ul id="bans" class="players"></ul>
    <section id="accounts" hidden>
      <h2>Accounts</h2>
      <form id="accform" class="row"><input id="accq" placeholder="Search username (empty = newest)" size="32" aria-label="Search accounts"><button type="submit">Search</button></form>
      <div class="mute" id="accinfo"></div>
      <div id="accrecovery" class="card" hidden role="status"></div>
      <div class="wrap"><table id="acctable"><thead><tr><th>Name</th><th>Level</th><th>Created</th><th>Sessions</th><th>State</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
    <section id="skins" hidden>
      <h2>Skin reports</h2>
      <div class="mute" id="skininfo"></div>
      <div class="wrap"><table id="skinreports"><thead><tr><th>Skin</th><th>Reports</th><th>Worn by</th><th></th></tr></thead><tbody></tbody></table></div>
      <h2>Banned skins</h2>
      <form id="skinbanform" class="row"><input id="skinbanhash" placeholder="Skin hash (64 hex characters)" size="48" aria-label="Skin hash"><button type="submit">Ban hash</button></form>
      <ul id="skinbans" class="players"></ul>
    </section>
  </section>
</main>
<script>
(function () {
  var tokenKey = 'bunkcraft.admin';
  var token = '';
  try { token = sessionStorage.getItem(tokenKey) || ''; } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var timer = 0;
  var accountsTried = false;
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
        if (p.suspicion !== undefined) li.append(el('span', 'suspicion ' + p.suspicion + ' / strikes ' + p.strikes, p.suspicion >= 40 ? 'err' : 'mute'));
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

  function renderMatches(m) {
    $('matches').hidden = m.isolation !== 'container';
    if (m.isolation !== 'container') return;
    var avg = m.counters.startMs.length ? Math.round(m.counters.startMs.reduce(function (a, b) { return a + b; }, 0) / m.counters.startMs.length) : 0;
    $('matchinfo').textContent = 'Driver ' + m.driver + ', ' + m.runners.length + ' runners, start ' + avg + ' ms on average, ' +
      m.counters.startFailures + ' failed starts, ' + m.counters.deaths + ' lost, ' + m.fallbacks + ' lobbies in-process (cap or no driver).';
    var body = $('matchtable').tBodies[0]; body.textContent = '';
    m.runners.forEach(function (r) {
      var tr = el('tr');
      tr.append(el('td', r.id.slice(0, 8)), el('td', r.state + (r.adopted ? ' (adopted)' : '')), el('td', r.room || '-'), el('td', r.players),
        el('td', Math.round(r.cpu * 100) + '%'), el('td', mb(r.memBytes) + (r.memLimitBytes ? ' / ' + mb(r.memLimitBytes) : '')),
        el('td', r.tickP99Ms.toFixed(2) + ' ms'), el('td', fmtTime(r.uptimeSec)), el('td', r.version, 'mute'));
      body.append(tr);
    });
  }

  function renderSkins(s) {
    $('skins').hidden = false;
    $('skininfo').textContent = s.count + ' skins stored, ' + (s.bytes / 1048576).toFixed(1) + ' of ' + Math.round(s.maxBytes / 1048576) + ' MB. A banned skin is never served again.';
    var body = $('skinreports').tBodies[0]; body.textContent = '';
    s.reports.forEach(function (r) {
      var tr = el('tr'); var pic = el('td'); var last = el('td');
      var img = el('img', undefined, 'skin-thumb'); img.alt = 'reported skin'; img.width = 64; img.height = 64;
      if (!r.banned) img.src = '/skins/' + r.hash + '.png';
      pic.append(img, el('div', r.hash, 'hash'));
      last.append(act(r.banned ? 'Unban' : 'Ban hash', function () {
        api('POST', '/skins/' + (r.banned ? 'unban' : 'ban'), { hash: r.hash }).then(refresh, fail);
      }, !r.banned), ' ', act('Dismiss', function () { api('POST', '/skins/dismiss', { hash: r.hash }).then(refresh, fail); }));
      tr.append(pic, el('td', r.count + (r.banned ? ' (banned)' : '')), el('td', r.names.join(', '), 'mute'), last);
      body.append(tr);
    });
    if (!s.reports.length) { var none = el('tr'); none.append(el('td', 'No reports', 'mute')); body.append(none); }
    var ul = $('skinbans'); ul.textContent = '';
    s.bans.forEach(function (h) {
      var li = el('li'); li.append(el('span', h, 'hash'), act('Unban', function () { api('POST', '/skins/unban', { hash: h }).then(refresh, fail); }));
      ul.append(li);
    });
    if (!s.bans.length) ul.append(el('li', 'None', 'mute'));
  }

  function loadAccounts() {
    return api('GET', '/accounts?q=' + encodeURIComponent($('accq').value.trim())).then(function (r) {
      $('accounts').hidden = false;
      $('accinfo').textContent = r.count + ' accounts in total, showing ' + r.accounts.length + '.';
      var body = $('acctable').tBodies[0]; body.textContent = '';
      r.accounts.forEach(function (a) {
        var tr = el('tr'); var last = el('td');
        var post = function (what, extra) { return api('POST', '/accounts/' + what, { name: a.name }).then(function (j) { if (extra) extra(j); loadAccounts(); }, fail); };
        last.append(act(a.locked ? 'Unlock' : 'Lock', function () { post(a.locked ? 'unlock' : 'lock'); }), ' ',
          act('Log out', function () { post('logout'); }), ' ',
          act('Recovery code', function () {
            if (!confirm('Issue a new recovery code for ' + a.name + '? The old code and all sessions stop working. Only do this after the owner proved ownership out-of-band.')) return;
            post('recovery', function (j) {
              var box = $('accrecovery'); box.textContent = ''; box.hidden = false;
              var close = act('Hide', function () { box.hidden = true; box.textContent = ''; });
              box.append(el('div', 'Recovery code for ' + j.name + ' (shown once, hand it to the owner privately):'), el('b', j.recovery, 'hash'), close);
            });
          }), ' ',
          act('Delete', function () { if (confirm('Delete account ' + a.name + ' and its profile for good?')) post('delete'); }, true));
        tr.append(el('td', a.name), el('td', a.level), el('td', new Date(a.created).toISOString().slice(0, 10), 'mute'), el('td', a.sessions),
          el('td', a.locked ? 'locked' : 'active', a.locked ? 'err' : 'mute'), last);
        body.append(tr);
      });
      if (!r.accounts.length) { var none = el('tr'); none.append(el('td', 'No accounts', 'mute')); body.append(none); }
    }, function (e) { if (e.message === 'Accounts are disabled') $('accounts').hidden = true; else fail(e); });
  }

  function refresh() {
    if (!token) return Promise.resolve();
    // The skins list is optional: a server with SKINS=off answers 404 and the section stays hidden.
    var skins = api('GET', '/skins').catch(function () { return null; });
    var matches = api('GET', '/matches').catch(function () { return { isolation: 'inprocess', runners: [] }; });
    return Promise.all([api('GET', '/stats'), api('GET', '/rooms'), api('GET', '/ip-bans'), skins, matches]).then(function (r) {
      $('err').textContent = ''; $('app').hidden = false; $('logout').hidden = false;
      render(r[0], r[1], r[2]);
      if (r[3]) renderSkins(r[3]); else $('skins').hidden = true;
      renderMatches(r[4]);
      // Accounts load once (a search result must not jump every 5 seconds, and a recovery code must stay on screen).
      if ($('accounts').hidden && !accountsTried) { accountsTried = true; loadAccounts(); }
    }, function (e) { fail(e); if (e.message === 'Wrong token') signOut(); });
  }
  function signOut() {
    token = ''; accountsTried = false; $('accounts').hidden = true; $('accrecovery').hidden = true; try { sessionStorage.removeItem(tokenKey); } catch (e) {}
    $('app').hidden = true; $('logout').hidden = true; clearInterval(timer);
  }
  $('login').onsubmit = function (e) {
    e.preventDefault();
    token = $('token').value.trim(); $('token').value = '';
    try { sessionStorage.setItem(tokenKey, token); } catch (err) {}
    refresh().then(function () { clearInterval(timer); timer = setInterval(refresh, 5000); });
  };
  $('logout').onclick = signOut;
  $('accform').onsubmit = function (e) { e.preventDefault(); loadAccounts(); };
  $('skinbanform').onsubmit = function (e) {
    e.preventDefault();
    var hash = $('skinbanhash').value.trim().toLowerCase(); if (!hash) return;
    api('POST', '/skins/ban', { hash: hash }).then(function () { $('skinbanhash').value = ''; refresh(); }, fail);
  };
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
