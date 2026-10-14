import { createHash } from 'node:crypto';

/**
 * The ops dashboard (/ops, also reached through /admin): one static page, no framework, no secrets inside, in the
 * BunkCraft/Bunkhosting look (the --bc-* tokens of src/ui/shell.css, Manrope over Inter from /fonts).
 *
 * Login: a browser that is logged in to the game as an admin account is let in at once (the game's session token in
 * localStorage, same origin); otherwise username + password through the account API, or the ADMIN_TOKEN. A session
 * or token made here lives in sessionStorage of this tab only. It talks to /api/ops/* (Cloudflare's WAF blocks
 * /api/admin/*). Everything dynamic is inserted with textContent, never as HTML. The CSP allows exactly this script
 * and this style (by hash), images and fonts from this origin, and fetches to it.
 */

const STYLE = `
@font-face { font-family: 'Manrope'; src: url('/fonts/manrope-var-latin.woff2') format('woff2'); font-weight: 200 800; font-display: swap; }
@font-face { font-family: 'Inter'; src: url('/fonts/inter-var-latin.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
:root {
  color-scheme: dark;
  --bc-ink0:#0c0e12; --bc-ink1:#111318; --bc-ink2:#1e2024; --bc-ink3:#282a2e; --bc-ink4:#33353a;
  --bc-text:#e2e2e8; --bc-dim:#a3a7b9; --bc-accent:#00dbe7; --bc-accent-dark:#007e85; --bc-blue-brand:#006af2;
  --bc-info:#b0c6ff; --bc-danger:#ffb4ab; --bc-ok:#7ee2a8; --bc-warn:#ffd27a;
  --bc-line:rgba(66,70,86,.7); --bc-line-strong:rgba(140,144,161,.5); --bc-line-accent:rgba(0,219,231,.4);
  --bc-fill:rgba(255,255,255,.045); --bc-fill-hover:rgba(255,255,255,.09);
  --bc-grad-btn:linear-gradient(90deg,var(--bc-blue-brand),var(--bc-accent-dark));
  --bc-grad-text:linear-gradient(90deg,var(--bc-blue-brand),var(--bc-accent));
  --bc-dots:radial-gradient(rgba(0,219,231,.10) 1px,transparent 0);
  --bc-font:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  --bc-font-head:'Manrope','Inter',ui-sans-serif,system-ui,sans-serif;
  --bc-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { background: var(--bc-ink1); background-image: var(--bc-dots); background-size: 22px 22px; color: var(--bc-text); font: 14px/1.45 var(--bc-font); min-height: 100vh; }
header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(17,19,24,.92); border-bottom: 1px solid var(--bc-line); backdrop-filter: blur(6px); }
.mark { font: 800 18px/1 var(--bc-font-head); letter-spacing: -.02em; text-transform: uppercase; white-space: nowrap; }
.mark i { font-style: normal; background: var(--bc-grad-text); -webkit-background-clip: text; background-clip: text; color: transparent; }
.mark small { margin-left: 8px; font: 600 11px/1 var(--bc-font); letter-spacing: .12em; color: var(--bc-dim); }
header .grow { flex: 1; }
.who { color: var(--bc-dim); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who b { color: var(--bc-text); font-weight: 600; }
.live { width: 8px; height: 8px; border-radius: 50%; background: var(--bc-line-strong); flex: none; }
.live.on { background: var(--bc-ok); box-shadow: 0 0 0 3px rgba(126,226,168,.15); }
.live.err { background: var(--bc-danger); }
main { max-width: 1320px; margin: 0 auto; padding: 20px; }
h1, h2, h3 { font-family: var(--bc-font-head); letter-spacing: -.01em; margin: 0; }
h2 { font-size: 17px; font-weight: 700; }
.panel { background: rgba(30,32,36,.88); border: 1px solid var(--bc-line); border-radius: 8px; padding: 16px; }
.login { max-width: 380px; margin: 9vh auto 0; display: grid; gap: 12px; }
.login h1 { font-size: 22px; }
.login p { margin: 0; color: var(--bc-dim); }
label.f { display: grid; gap: 4px; font-size: 12px; color: var(--bc-dim); }
input, select, textarea { font: inherit; color: var(--bc-text); background: var(--bc-ink0); border: 1px solid var(--bc-line); border-radius: 2px; padding: 7px 9px; min-width: 0; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--bc-line-accent); outline-offset: 1px; }
button { font: 600 13px/1 var(--bc-font); color: var(--bc-text); background: var(--bc-fill); border: 1px solid var(--bc-line-strong); border-radius: 2px; padding: 7px 11px; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--bc-fill-hover); border-color: var(--bc-line-accent); }
button.primary { background: var(--bc-grad-btn); border-color: transparent; color: #fff; }
button.danger { color: var(--bc-danger); }
button.danger:hover { border-color: var(--bc-danger); }
button.link { background: none; border: 0; padding: 0; color: var(--bc-accent); font-weight: 500; }
button:disabled { opacity: .45; cursor: default; }
.err { color: var(--bc-danger); min-height: 1.2em; font-size: 13px; }
.ok { color: var(--bc-ok); }
.dim { color: var(--bc-dim); }
.mono { font-family: var(--bc-mono); font-size: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; margin-bottom: 18px; }
.card { background: rgba(30,32,36,.88); border: 1px solid var(--bc-line); border-radius: 4px; padding: 12px 14px; min-width: 0; }
.card span { display: block; color: var(--bc-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.card b { display: block; font: 700 22px/1.25 var(--bc-font-head); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card em { display: block; font-style: normal; color: var(--bc-dim); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card.hot b { color: var(--bc-warn); }
nav.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--bc-line); margin-bottom: 14px; overflow-x: auto; }
nav.tabs button { background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 10px 14px; color: var(--bc-dim); font-weight: 600; }
nav.tabs button[aria-selected="true"] { color: var(--bc-text); border-bottom-color: var(--bc-accent); }
section[hidden] { display: none; }
.head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 10px; flex-wrap: wrap; }
.head .dim { font-size: 13px; }
.wrap { overflow-x: auto; border: 1px solid var(--bc-line); border-radius: 4px; background: rgba(17,19,24,.7); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--bc-line); vertical-align: middle; white-space: nowrap; }
th { color: var(--bc-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; background: rgba(30,32,36,.9); position: sticky; top: 0; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--bc-fill); }
tr.sel td { background: rgba(0,219,231,.06); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td .row { flex-wrap: wrap; min-width: 180px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; border: 1px solid currentColor; }
.s-assigned { color: var(--bc-ok); } .s-warm { color: var(--bc-accent); } .s-starting { color: var(--bc-info); }
.s-draining, .s-stopping { color: var(--bc-warn); } .s-process { color: var(--bc-dim); }
.bar { display: inline-block; width: 54px; height: 5px; background: var(--bc-ink4); border-radius: 3px; vertical-align: middle; margin-right: 6px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--bc-grad-text); }
.bar.hot i { background: var(--bc-warn); }
.detail { margin-top: 12px; }
.detail .head { justify-content: space-between; }
pre.logs { margin: 0; max-height: 420px; overflow: auto; background: var(--bc-ink0); border: 1px solid var(--bc-line); border-radius: 4px; padding: 10px; font: 12px/1.45 var(--bc-mono); white-space: pre-wrap; word-break: break-all; }
pre.logs .e { color: var(--bc-danger); }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--bc-line); flex-wrap: wrap; }
ul.plain li:last-child { border-bottom: 0; }
.settings { display: grid; gap: 0; }
.set { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(120px, 1fr) minmax(160px, 1.4fr) auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--bc-line); }
.set:last-child { border-bottom: 0; }
.set b { display: block; font-weight: 600; }
.set .dim { font-size: 12px; }
.set .tag { font-size: 11px; color: var(--bc-warn); }
.set.off { opacity: .5; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.notice { border-left: 3px solid var(--bc-accent); padding: 8px 12px; background: var(--bc-fill); font-size: 13px; margin-bottom: 12px; }
.recovery { margin-top: 10px; }
.stack { display: grid; gap: 12px; }
.grow1 { flex: 1; }
.mt { margin-top: 12px; }
.mb { margin-bottom: 10px; }
.ml { margin-left: 8px; }
.skin { width: 48px; height: 48px; image-rendering: pixelated; border: 1px solid var(--bc-line); background: var(--bc-ink0); }
@media (max-width: 720px) {
  main { padding: 14px; } header { padding: 10px 14px; gap: 10px; } .mark small { display: none; }
  .set { grid-template-columns: 1fr; gap: 6px; }
}
`;

const SCRIPT = `
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var OWN = 'bunkcraft.ops';
  var GAME = 'bunkcraft.profile.' + location.host;
  var auth = null; // { token, source: 'game' | 'own' | 'token' }
  var timer = 0;
  var tab = 'containers';
  var selected = null; // { kind: 'players' | 'logs', code?, runner? }
  var accountsLoaded = false;
  var isolation = 'inprocess';
  var settingsRows = [];

  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'text') e.textContent = String(props[k]);
      else if (k === 'cls') e.className = props[k];
      else if (k === 'on') e.onclick = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c !== null && c !== undefined) e.append(c); }
    return e;
  }
  function btn(text, fn, cls) { return el('button', { type: 'button', text: text, on: fn, cls: cls || '' }); }
  function fmtDur(s) { s = Math.max(0, Math.round(s)); var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + 'd ' + h + 'u' : h ? h + 'u ' + m + 'm' : m + 'm ' + (s % 60) + 's'; }
  function mb(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB'; }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function bar(frac, hot) { var b = el('span', { cls: 'bar' + (hot ? ' hot' : '') }); var i = el('i'); i.style.width = Math.max(0, Math.min(100, frac * 100)) + '%'; b.append(i); return b; }
  function store(kind) { try { return kind === 'local' ? localStorage : sessionStorage; } catch (e) { return null; } }
  function say(msg) { $('err').textContent = msg || ''; }

  function api(method, path, body) {
    var headers = { authorization: 'Bearer ' + auth.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch('/api/ops' + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'omit' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ('Fout ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  function act(method, path, body, after) {
    return api(method, path, body).then(function (j) { say(''); if (after) after(j); refresh(); return j; }, function (e) { say(e.message); if (e.status === 401) signOut(); });
  }

  // ------------------------------------------------------------------ login
  function tryLogin(a, quiet) {
    auth = a;
    return api('GET', '/whoami').then(function (w) {
      $('login').hidden = true; $('app').hidden = false; $('bar').hidden = false;
      $('who').textContent = ''; $('who').append(document.createTextNode('Ingelogd als '), el('b', { text: w.who }), document.createTextNode(' · v' + w.version));
      $('signout').textContent = a.source === 'game' ? 'Verlaten' : 'Uitloggen';
      refresh();
      clearInterval(timer); timer = setInterval(refresh, 3000);
      return true;
    }, function (e) {
      auth = null;
      if (!quiet) $('lerr').textContent = e.status === 403 ? 'Dit account heeft geen beheerrechten.' : e.status === 429 ? 'Te veel pogingen, probeer het later opnieuw.' : e.status === 401 ? 'Niet (meer) geldig: log opnieuw in.' : e.message;
      else if (e.status === 403) $('lerr').textContent = 'Je bent in het spel ingelogd met een account zonder beheerrechten.';
      return false;
    });
  }
  function signOut() {
    clearInterval(timer);
    var a = auth; auth = null; accountsLoaded = false; selected = null;
    var s = store('session'); if (s) s.removeItem(OWN);
    if (a && a.source === 'own') fetch('/api/account/logout', { method: 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: '{}' }).catch(function () {});
    $('app').hidden = true; $('bar').hidden = true; $('login').hidden = false;
  }
  $('lform').onsubmit = function (e) {
    e.preventDefault(); $('lerr').textContent = '';
    var name = $('lname').value.trim(), pw = $('lpass').value;
    if (!name || !pw) return;
    fetch('/api/account/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, password: pw }), credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (r) {
        $('lpass').value = '';
        if (!r.ok || !r.j.token) { $('lerr').textContent = r.j.error === 'invalid_credentials' ? 'Onbekende naam of verkeerd wachtwoord.' : r.j.error === 'account_locked' ? 'Dit account is geblokkeerd.' : r.status === 429 ? 'Te veel pogingen, probeer het later opnieuw.' : 'Inloggen mislukt (' + (r.j.error || r.status) + ').'; return; }
        var a = { token: r.j.token, source: 'own' };
        tryLogin(a).then(function (ok) {
          var s = store('session');
          if (ok) { if (s) s.setItem(OWN, JSON.stringify(a)); }
          else fetch('/api/account/logout', { method: 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: '{}' }).catch(function () {});
        });
      }, function () { $('lerr').textContent = 'Geen verbinding met de server.'; });
  };
  $('tform').onsubmit = function (e) {
    e.preventDefault(); $('lerr').textContent = '';
    var t = $('ltoken').value.trim(); $('ltoken').value = '';
    if (!t) return;
    var a = { token: t, source: 'token' };
    tryLogin(a).then(function (ok) { var s = store('session'); if (ok && s) s.setItem(OWN, JSON.stringify(a)); });
  };
  $('usetoken').onclick = function () { $('tform').hidden = !$('tform').hidden; };
  $('signout').onclick = signOut;

  // ------------------------------------------------------------------ tabs
  var TABS = ['containers', 'lobbies', 'settings', 'accounts', 'moderation', 'audit'];
  function showTab(t) {
    tab = t;
    TABS.forEach(function (x) { $('t-' + x).setAttribute('aria-selected', String(x === t)); $('p-' + x).hidden = x !== t; });
    if (t === 'settings') loadSettings();
    if (t === 'accounts' && !accountsLoaded) loadAccounts();
    refresh();
  }
  TABS.forEach(function (x) { $('t-' + x).onclick = function () { showTab(x); }; });

  // ------------------------------------------------------------------ overview
  function card(label, value, sub, hot) {
    var c = el('div', { cls: 'card' + (hot ? ' hot' : '') }, el('span', { text: label }), el('b', { text: value }));
    if (sub) c.append(el('em', { text: sub }));
    return c;
  }
  function renderOverview(o) {
    isolation = o.isolation;
    var c = o.containers;
    var cards = [
      card('Versie', o.version, 'uptime ' + fmtDur(o.uptimeSec)),
      card('Isolatie', o.isolation === 'container' ? 'containers' : 'in-process', o.driver ? 'driver ' + o.driver + (o.driverAvailable === false ? ' (niet bereikbaar)' : '') : 'MATCH_ISOLATION=inprocess', o.driverAvailable === false),
      card('Matches', String(o.matches), o.gamesLoaded + ' geladen · ' + o.gamesTotal + ' op schijf'),
    ];
    if (c) cards.push(card('Containers', c.assigned + ' / ' + c.max, c.warm + ' warm (doel ' + c.warmTarget + ')' + (c.starting ? ' · ' + c.starting + ' start' : ''), c.total >= c.max));
    cards.push(
      card('Spelers', String(o.playersInMatches), o.playersOnline + ' online · ' + o.connections + ' verbindingen'),
      card('CPU control plane', pct(o.cpu), o.host.cpus + ' cores · load ' + o.host.load[0], o.cpu > 0.8),
      card('Geheugen', mb(o.rssBytes), 'heap ' + mb(o.heapBytes) + ' · host vrij ' + mb(o.host.memFree)),
      card('Loop lag p99', o.loopLagP99Ms.toFixed(1) + ' ms', 'tick p99 ' + o.tickP99Ms.toFixed(2) + ' ms', o.loopLagP99Ms > 50),
      card('In-process fallback', String(o.fallbacks), o.counters ? o.counters.startFailures + ' mislukte starts · ' + o.counters.deaths + ' verloren' : 'lobby\\'s draaien in dit proces', o.fallbacks > 0 && !!c));
    if (o.counters) cards.push(card('Starttijd', o.counters.avgStartMs + ' ms', o.counters.starts + ' gestart · ' + o.counters.capped + 'x max bereikt'));
    $('cards').replaceChildren.apply($('cards'), cards);
  }

  // ------------------------------------------------------------------ containers + lobbies
  function gameActions(g) {
    return el('div', { cls: 'row' },
      btn('Spelers', function () { selected = { kind: 'players', code: g.code }; refresh(); }),
      btn('Sluiten', function () { if (confirm('Iedereen in ' + g.code + ' loskoppelen? De lobby blijft op schijf.')) act('POST', '/rooms/' + g.code + '/close', { remove: false }); }, 'danger'));
  }
  function renderContainers(d) {
    var byCode = {};
    d.games.forEach(function (g) { byCode[g.code] = g; });
    var isCont = d.isolation === 'container';
    $('c-cont').hidden = !isCont; $('c-inproc').hidden = isCont;
    if (isCont) {
      $('c-info').textContent = 'driver ' + d.driver + ' · image ' + (d.image || '-') + (d.limits ? ' · per container ' + d.limits.cpus + ' CPU, ' + d.limits.memoryMb + ' MB' : '');
      var body = $('c-table').tBodies[0];
      var rows = d.runners.map(function (r) {
        var g = r.room ? byCode[r.room] : null;
        var cpuFrac = d.limits ? r.cpu / d.limits.cpus : r.cpu;
        var memFrac = r.memLimitBytes ? r.memBytes / r.memLimitBytes : 0;
        var actions = el('div', { cls: 'row' }, btn('Logs', function () { selected = { kind: 'logs', runner: r.id, name: r.name }; loadLogs(); renderSel(); }));
        if (r.room) actions.append(btn('Spelers', function () { selected = { kind: 'players', code: r.room }; refresh(); }));
        if (r.state !== 'stopping' && r.state !== 'draining') {
          actions.append(btn('Stop', function () {
            if (confirm(r.room ? 'Container van lobby ' + r.room + ' stoppen? XP wordt uitbetaald en de spelers verbinden opnieuw met een verse container.' : 'Warme container ' + r.name + ' stoppen?')) act('POST', '/containers/' + r.id + '/stop', {});
          }, 'danger'));
        }
        if (r.room) actions.append(btn('Lobby sluiten', function () { if (confirm('Lobby ' + r.room + ' sluiten? Spelers worden losgekoppeld.')) act('POST', '/rooms/' + r.room + '/close', { remove: false }); }, 'danger'));
        var tr = el('tr', { cls: selected && (selected.runner === r.id || (r.room && selected.code === r.room)) ? 'sel' : '' },
          el('td', null, el('div', { text: r.name, cls: 'mono' }), el('div', { text: r.id + (r.adopted ? ' · overgenomen' : ''), cls: 'dim mono' })),
          el('td', null, el('span', { cls: 'badge s-' + r.state, text: r.state })),
          el('td', { cls: 'mono dim', title: r.image || '' }, (r.version || '-') + (r.image && r.image !== 'process' ? ' · ' + String(r.image).replace(/^sha256:/, '').slice(0, 12) : '')),
          el('td', { cls: 'mono', text: r.room || '-' }),
          el('td', { text: r.gameType || (g ? g.gameType : '-') }),
          el('td', { text: r.map || (g && g.map) || '-' }),
          el('td', { cls: 'num', text: r.room ? r.players + ' / ' + (r.maxPlayers || (g ? g.maxPlayers : '?')) : '-' }),
          el('td', { cls: 'num', text: r.room ? String(r.bots) : '-' }),
          el('td', { cls: 'num', text: fmtDur(r.uptimeSec) }),
          el('td', { cls: 'num' }, bar(cpuFrac, cpuFrac > 0.85), document.createTextNode(Math.round(r.cpu * 100) + '%')),
          el('td', { cls: 'num' }, r.memLimitBytes ? bar(memFrac, memFrac > 0.85) : null, document.createTextNode(mb(r.memBytes) + (r.memLimitBytes ? ' / ' + mb(r.memLimitBytes) : ''))),
          el('td', { cls: 'num', text: r.tickP99Ms ? r.tickP99Ms.toFixed(2) + ' ms' : '-' }),
          el('td', null, actions));
        return tr;
      });
      if (!rows.length) rows.push(el('tr', null, el('td', { colspan: '13', cls: 'dim', text: 'Geen containers. Een warme container start vanzelf (MATCH_WARM_POOL).' })));
      body.replaceChildren.apply(body, rows);
    }
    renderGames(d.games, isCont);
  }
  function renderGames(games, isCont) {
    var mk = function (g) {
      return el('tr', { cls: selected && selected.code === g.code ? 'sel' : '' },
        el('td', { cls: 'mono', text: g.code }), el('td', { text: g.name }), el('td', { text: g.gameType }),
        el('td', { text: g.map || '-' }), el('td', { text: g.phase ? g.phase + (g.timeLeft !== null ? ' · ' + fmtDur(g.timeLeft) : '') : '-' }),
        el('td', { cls: 'num', text: g.players + ' / ' + g.maxPlayers }), el('td', { cls: 'num', text: String(g.bots) }),
        el('td', null, el('span', { cls: 'badge ' + (g.remote ? 's-assigned' : 's-process'), text: g.remote ? 'container' : 'proces' })),
        el('td', { cls: 'dim', text: [g.listed ? 'openbaar' : '', g.locked ? 'wachtwoord' : ''].filter(Boolean).join(', ') || '-' }),
        el('td', null, gameActions(g)));
    };
    var empty = function (n) { return el('tr', null, el('td', { colspan: String(n), cls: 'dim', text: 'Geen geladen lobby\\'s.' })); };
    [$('l-table'), $('ip-table')].forEach(function (t) {
      if (!t) return;
      var rows = games.map(mk);
      if (!rows.length) rows.push(empty(10));
      t.tBodies[0].replaceChildren.apply(t.tBodies[0], rows);
    });
    $('l-count').textContent = games.length + ' geladen' + (isCont ? ' · ' + games.filter(function (g) { return g.remote; }).length + ' in containers' : '');
  }

  function renderSel() {
    var box = $('sel');
    if (!selected) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    var title = selected.kind === 'logs' ? 'Logs van ' + selected.name : 'Spelers in ' + selected.code;
    var head = el('div', { cls: 'head' }, el('h2', { text: title }), el('div', { cls: 'row' }));
    if (selected.kind === 'logs') {
      var tail = el('select', { 'aria-label': 'Aantal regels' });
      [100, 200, 500].forEach(function (n) { var o = el('option', { value: String(n), text: n + ' regels' }); if (n === (selected.tail || 200)) o.selected = true; tail.append(o); });
      tail.onchange = function () { selected.tail = Number(tail.value); loadLogs(); };
      head.lastChild.append(tail, btn('Vernieuwen', loadLogs));
    }
    head.lastChild.append(btn('Sluiten', function () { selected = null; renderSel(); }));
    var content = el('div', { id: 'selbody' });
    if (selected.kind === 'logs') content.append(el('pre', { cls: 'logs', id: 'logpre', text: 'Laden...' }));
    box.replaceChildren(head, content);
  }
  function loadLogs() {
    if (!selected || selected.kind !== 'logs') return;
    var id = selected.runner;
    api('GET', '/containers/' + id + '/logs?tail=' + (selected.tail || 200)).then(function (j) {
      var pre = $('logpre'); if (!pre || !selected || selected.runner !== id) return;
      pre.replaceChildren.apply(pre, j.lines.length ? j.lines.map(function (l) { return el('div', { cls: l.stream === 'err' ? 'e' : '', text: l.text }); }) : [document.createTextNode('(nog geen uitvoer)')]);
      pre.scrollTop = pre.scrollHeight;
    }, function (e) { var pre = $('logpre'); if (pre) pre.textContent = e.message; });
  }
  function loadPlayers() {
    if (!selected || selected.kind !== 'players') return;
    var code = selected.code;
    api('GET', '/rooms/' + code + '/players').then(function (j) {
      var b = $('selbody'); if (!b || !selected || selected.code !== code) return;
      var ul = el('ul', { cls: 'plain' });
      j.players.forEach(function (p) {
        ul.append(el('li', null, el('b', { text: p.name }), el('span', { cls: 'dim mono', text: (p.ip || '?') + ' · ' + (p.pingMs !== undefined ? p.pingMs + ' ms' : '') }),
          p.suspicion !== undefined ? el('span', { cls: p.suspicion >= 40 ? 'err' : 'dim', text: 'verdenking ' + p.suspicion + ' · strikes ' + p.strikes }) : null,
          btn('Kick', function () { act('POST', '/rooms/' + code + '/kick', { name: p.name }); }),
          p.ip ? btn('IP blokkeren', function () { if (confirm('Adres ' + p.ip + ' blokkeren?')) act('POST', '/ip-bans', { ip: p.ip }); }, 'danger') : null));
      });
      if (!j.players.length) ul.append(el('li', { cls: 'dim', text: 'Geen spelers verbonden.' }));
      b.replaceChildren(ul);
    }, function (e) { say(e.message); });
  }

  // ------------------------------------------------------------------ settings
  var LABELS = {
    maxMatchContainers: ['Max. containers', 'Meer lobby\\'s dan dit draaien in-process.'],
    matchWarmPool: ['Warme containers', 'Klaar voor quick play, zonder starttijd.'],
    matchCpus: ['CPU per container', 'Cores; maximaal wat de Docker gate toestaat.'],
    matchMemoryMb: ['Geheugen per container', 'MB; maximaal wat de Docker gate toestaat.'],
    matchIdleGraceSec: ['Lege container leeft nog', 'Seconden na de laatste speler.'],
    motd: ['Welkomstbericht (MOTD)', 'Voor nieuwe lobby\\'s.'],
    roomMaxPlayers: ['Max. spelers per lobby', 'Grootste lobby die Realms aanbiedt.'],
    quickPlayBots: ['Bots in quick play', '0 = geen bots die lobby\\'s vullen.'],
  };
  function loadSettings() {
    api('GET', '/settings').then(function (j) { settingsRows = j.settings; renderSettings(j.isolation); }, function (e) { say(e.message); });
  }
  function renderSettings(iso) {
    var box = $('s-list');
    var rows = settingsRows.map(function (s) {
      var lab = LABELS[s.key] || [s.key, ''];
      var off = s.container && iso !== 'container';
      var input = s.kind === 'text'
        ? el('input', { type: 'text', maxlength: String(s.max || 120), 'data-key': s.key, 'aria-label': lab[0] })
        : el('input', { type: 'number', min: String(s.min), max: String(s.max), step: s.kind === 'num' ? '0.1' : '1', 'data-key': s.key, 'aria-label': lab[0] });
      input.value = String(s.value);
      if (off) input.disabled = true;
      var when = s.applies === 'now' ? 'direct actief' : s.container ? 'alleen nieuwe containers' : 'nieuwe lobby\\'s';
      return el('div', { cls: 'set' + (off ? ' off' : '') },
        el('div', null, el('b', { text: lab[0] }), el('div', { cls: 'dim', text: lab[1] })),
        input,
        el('div', null, el('div', { cls: 'dim mono', text: s.env + ' = ' + s.envValue + (s.kind !== 'text' ? ' · ' + s.min + '–' + s.max : '') }), el('div', { cls: 'tag', text: off ? 'alleen met MATCH_ISOLATION=container' : when + (s.overridden ? ' · aangepast' : '') })),
        btn('Reset', function () { act('POST', '/settings/reset', { keys: [s.key] }, function (j) { settingsRows = j.settings; renderSettings(iso); }); }, s.overridden ? '' : 'link'));
    });
    box.replaceChildren.apply(box, rows);
  }
  $('s-form').onsubmit = function (e) {
    e.preventDefault();
    var values = {};
    settingsRows.forEach(function (s) {
      var inp = document.querySelector('[data-key="' + s.key + '"]');
      if (!inp || inp.disabled) return;
      var v = s.kind === 'text' ? inp.value : Number(inp.value);
      if (String(v) !== String(s.value)) values[s.key] = v;
    });
    if (!Object.keys(values).length) { $('s-msg').textContent = 'Niets gewijzigd.'; return; }
    api('POST', '/settings', { values: values }).then(function (j) {
      settingsRows = j.settings; renderSettings(isolation); $('s-msg').textContent = 'Opgeslagen: ' + j.changed.join(', '); $('s-msg').className = 'ok'; say(''); refresh();
    }, function (err) { $('s-msg').textContent = err.message; $('s-msg').className = 'err'; });
  };
  $('a-form').onsubmit = function (e) {
    e.preventDefault();
    var text = $('a-text').value.trim(); if (!text) return;
    act('POST', '/announce', { text: text }, function (j) { $('a-text').value = ''; $('a-msg').textContent = 'Verstuurd naar ' + j.reached + ' spelers.'; });
  };
  $('save-all').onclick = function () { act('POST', '/save', {}, function () { $('a-msg').textContent = 'Alle werelden opgeslagen.'; }); };

  // ------------------------------------------------------------------ accounts
  function loadAccounts() {
    accountsLoaded = true;
    return api('GET', '/accounts?q=' + encodeURIComponent($('acc-q').value.trim())).then(function (r) {
      $('acc-info').textContent = r.count + ' accounts, ' + r.accounts.length + ' getoond.';
      var body = $('acc-table').tBodies[0];
      var post = function (what, a, extra, after) { return act('POST', '/accounts/' + what, Object.assign({ name: a.name }, extra || {}), function (j) { if (after) after(j); loadAccounts(); }); };
      var rows = r.accounts.map(function (a) {
        return el('tr', null, el('td', null, el('b', { text: a.name }), a.admin ? el('span', { cls: 'badge s-warm ml', text: 'admin' }) : null),
          el('td', { cls: 'num', text: String(a.level) }), el('td', { cls: 'dim', text: new Date(a.created).toISOString().slice(0, 10) }),
          el('td', { cls: 'num', text: String(a.sessions) }), el('td', { cls: a.locked ? 'err' : 'dim', text: a.locked ? 'geblokkeerd' : 'actief' }),
          el('td', null, el('div', { cls: 'row' },
            btn(a.admin ? 'Admin intrekken' : 'Admin maken', function () { if (confirm((a.admin ? 'Beheerrechten van ' : 'Beheerrechten geven aan ') + a.name + '?')) post('admin', a, { admin: !a.admin }); }),
            btn(a.locked ? 'Deblokkeren' : 'Blokkeren', function () { post(a.locked ? 'unlock' : 'lock', a); }),
            btn('Uitloggen', function () { post('logout', a); }),
            btn('Herstelcode', function () {
              if (!confirm('Nieuwe herstelcode voor ' + a.name + '? De oude code en alle sessies vervallen. Alleen nadat de eigenaar zich buiten het spel heeft bewezen.')) return;
              post('recovery', a, null, function (j) {
                var box = $('acc-rec'); box.hidden = false;
                box.replaceChildren(el('div', { text: 'Herstelcode voor ' + j.name + ' (eenmalig zichtbaar, geef hem privé door):' }), el('b', { cls: 'mono', text: j.recovery }), document.createTextNode(' '), btn('Verbergen', function () { box.hidden = true; box.replaceChildren(); }));
              });
            }),
            btn('Verwijderen', function () { if (confirm('Account ' + a.name + ' en zijn profiel definitief verwijderen?')) post('delete', a); }, 'danger'))));
      });
      if (!rows.length) rows.push(el('tr', null, el('td', { colspan: '6', cls: 'dim', text: 'Geen accounts.' })));
      body.replaceChildren.apply(body, rows);
    }, function (e) { $('acc-info').textContent = e.message; });
  }
  $('acc-form').onsubmit = function (e) { e.preventDefault(); loadAccounts(); };

  // ------------------------------------------------------------------ moderation
  function loadModeration() {
    api('GET', '/ip-bans').then(function (j) {
      var ul = $('bans');
      var items = j.ips.map(function (ip) { return el('li', null, el('span', { cls: 'mono', text: ip }), btn('Deblokkeren', function () { act('DELETE', '/ip-bans/' + encodeURIComponent(ip)); })); });
      if (!items.length) items.push(el('li', { cls: 'dim', text: 'Geen geblokkeerde adressen.' }));
      ul.replaceChildren.apply(ul, items);
    }, function () {});
    api('GET', '/skins').then(function (s) {
      $('skins').hidden = false;
      $('skin-info').textContent = s.count + ' skins, ' + (s.bytes / 1048576).toFixed(1) + ' van ' + Math.round(s.maxBytes / 1048576) + ' MB.';
      var ul = $('skin-list');
      var items = s.reports.map(function (r) {
        var img = el('img', { cls: 'skin', alt: 'gemelde skin', width: '48', height: '48' });
        if (!r.banned) img.src = '/skins/' + r.hash + '.png';
        return el('li', null, img, el('span', { cls: 'mono dim', text: r.hash.slice(0, 16) + '…' }), el('span', { text: r.count + ' meldingen' + (r.banned ? ' (verbannen)' : '') }), el('span', { cls: 'dim', text: r.names.join(', ') }),
          btn(r.banned ? 'Toestaan' : 'Verbannen', function () { act('POST', '/skins/' + (r.banned ? 'unban' : 'ban'), { hash: r.hash }); }, r.banned ? '' : 'danger'),
          btn('Negeren', function () { act('POST', '/skins/dismiss', { hash: r.hash }); }));
      });
      if (!items.length) items.push(el('li', { cls: 'dim', text: 'Geen meldingen.' }));
      ul.replaceChildren.apply(ul, items);
    }, function () { $('skins').hidden = true; });
  }
  $('ban-form').onsubmit = function (e) { e.preventDefault(); var ip = $('ban-ip').value.trim(); if (ip) act('POST', '/ip-bans', { ip: ip }, function () { $('ban-ip').value = ''; }); };

  // ------------------------------------------------------------------ audit
  function loadAudit() {
    api('GET', '/audit').then(function (j) {
      var body = $('au-table').tBodies[0];
      var rows = j.entries.map(function (a) {
        return el('tr', null, el('td', { cls: 'dim', text: new Date(a.at).toLocaleString('nl-NL') }), el('td', null, el('b', { text: a.who })),
          el('td', { cls: 'mono', text: a.action }), el('td', { cls: 'mono dim', text: a.detail || '' }), el('td', { cls: a.status < 300 ? 'ok num' : 'err num', text: String(a.status) }), el('td', { cls: 'mono dim', text: a.ip }));
      });
      if (!rows.length) rows.push(el('tr', null, el('td', { colspan: '6', cls: 'dim', text: 'Nog geen acties sinds de laatste start.' })));
      body.replaceChildren.apply(body, rows);
    }, function () {});
  }

  // ------------------------------------------------------------------ refresh loop
  var busy = false;
  function refresh() {
    if (!auth || busy) return;
    busy = true;
    Promise.all([api('GET', '/overview'), api('GET', '/containers')]).then(function (r) {
      $('live').className = 'live on';
      renderOverview(r[0]);
      renderContainers(r[1]);
      if (selected && $('sel').hidden) renderSel();
      if (selected && selected.kind === 'players') loadPlayers();
      if (tab === 'audit') loadAudit();
      if (tab === 'moderation') loadModeration();
    }, function (e) {
      $('live').className = 'live err';
      say(e.message);
      if (e.status === 401 || e.status === 403) signOut();
    }).then(function () { busy = false; });
  }

  // A browser logged in to the game as an admin gets in at once; else a session or token from this tab.
  var own = null;
  try { var raw = store('session') && store('session').getItem(OWN); own = raw ? JSON.parse(raw) : null; } catch (e) { own = null; }
  var game = null;
  try { var gt = store('local') && store('local').getItem(GAME); if (gt && gt.indexOf('s1.') === 0) game = { token: gt, source: 'game' }; } catch (e) { game = null; }
  (own ? tryLogin(own, true) : Promise.resolve(false)).then(function (ok) {
    if (!ok && own) { var s = store('session'); if (s) s.removeItem(OWN); }
    if (!ok && game) return tryLogin(game, true);
    return ok;
  }).then(function () { $('boot').hidden = true; if (!auth) $('login').hidden = false; });
})();
`;

const BODY = `<header id="bar" hidden>
  <span class="live" id="live" title="Live: vernieuwt elke 3 seconden"></span>
  <span class="mark">Bunk<i>Craft</i><small>OPS</small></span>
  <span class="grow"></span>
  <span class="who" id="who"></span>
  <button type="button" id="signout">Uitloggen</button>
</header>
<main>
  <p id="boot" class="dim">Laden...</p>
  <div id="login" class="panel login" hidden>
    <div class="mark">Bunk<i>Craft</i><small>OPS</small></div>
    <h1>Beheer</h1>
    <p>Log in met een BunkCraft-account met beheerrechten.</p>
    <form id="lform" class="stack" autocomplete="on">
      <label class="f">Gebruikersnaam<input id="lname" name="username" autocomplete="username" required maxlength="16"></label>
      <label class="f">Wachtwoord<input id="lpass" name="password" type="password" autocomplete="current-password" required maxlength="64"></label>
      <button type="submit" class="primary">Inloggen</button>
    </form>
    <div id="lerr" class="err" role="alert"></div>
    <button type="button" class="link" id="usetoken">Inloggen met de admin-token</button>
    <form id="tform" class="row" hidden autocomplete="off">
      <input id="ltoken" class="grow1" type="password" placeholder="ADMIN_TOKEN" aria-label="Admin-token">
      <button type="submit">Ga</button>
    </form>
  </div>
  <div id="app" hidden>
    <div id="err" class="err" role="alert"></div>
    <div class="cards" id="cards"></div>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" id="t-containers" aria-selected="true">Containers</button>
      <button type="button" role="tab" id="t-lobbies" aria-selected="false">Lobby's</button>
      <button type="button" role="tab" id="t-settings" aria-selected="false">Instellingen</button>
      <button type="button" role="tab" id="t-accounts" aria-selected="false">Accounts</button>
      <button type="button" role="tab" id="t-moderation" aria-selected="false">Moderatie</button>
      <button type="button" role="tab" id="t-audit" aria-selected="false">Audit log</button>
    </nav>
    <section id="p-containers">
      <div id="c-cont" hidden>
        <div class="head"><h2>Match-containers</h2><span class="dim" id="c-info"></span></div>
        <div class="wrap"><table id="c-table"><thead><tr><th>Container</th><th>Status</th><th>Versie · image</th><th>Lobby</th><th>Modus</th><th>Map</th><th class="num">Spelers</th><th class="num">Bots</th><th class="num">Uptime</th><th class="num">CPU</th><th class="num">Geheugen</th><th class="num">Tick p99</th><th></th></tr></thead><tbody></tbody></table></div>
      </div>
      <div id="c-inproc" hidden>
        <div class="notice">MATCH_ISOLATION=inprocess: alle lobby's draaien in dit serverproces, er zijn geen containers.</div>
        <div class="head"><h2>Lobby's</h2></div>
        <div class="wrap"><table id="ip-table"><thead><tr><th>Code</th><th>Naam</th><th>Modus</th><th>Map</th><th>Fase</th><th class="num">Spelers</th><th class="num">Bots</th><th>Waar</th><th>Vlaggen</th><th></th></tr></thead><tbody></tbody></table></div>
      </div>
    </section>
    <section id="p-lobbies" hidden>
      <div class="head"><h2>Geladen lobby's</h2><span class="dim" id="l-count"></span></div>
      <div class="wrap"><table id="l-table"><thead><tr><th>Code</th><th>Naam</th><th>Modus</th><th>Map</th><th>Fase</th><th class="num">Spelers</th><th class="num">Bots</th><th>Waar</th><th>Vlaggen</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
    <div id="sel" class="panel detail" hidden></div>
    <section id="p-settings" hidden>
      <div class="grid2">
        <form id="s-form" class="panel">
          <div class="head"><h2>Instellingen</h2><span class="dim">overschrijven de .env, bewaard in DATA_DIR/ops-settings.json</span></div>
          <div class="settings" id="s-list"></div>
          <div class="row mt"><button type="submit" class="primary">Opslaan</button><span id="s-msg" class="dim"></span></div>
        </form>
        <div class="panel">
          <div class="head"><h2>Aankondiging</h2></div>
          <form id="a-form" class="row"><input id="a-text" maxlength="200" placeholder="Bericht aan alle spelers in alle games" aria-label="Aankondiging" class="grow1"><button type="submit" class="primary">Versturen</button></form>
          <div class="row mt"><button type="button" id="save-all">Alle werelden nu opslaan</button></div>
          <p id="a-msg" class="ok"></p>
        </div>
      </div>
    </section>
    <section id="p-accounts" hidden>
      <div class="head"><h2>Accounts</h2><span class="dim" id="acc-info"></span></div>
      <form id="acc-form" class="row mb"><input id="acc-q" placeholder="Zoek op naam (leeg = nieuwste)" aria-label="Zoek accounts" size="30"><button type="submit">Zoeken</button></form>
      <div id="acc-rec" class="panel recovery" hidden role="status"></div>
      <div class="wrap"><table id="acc-table"><thead><tr><th>Naam</th><th class="num">Level</th><th>Aangemaakt</th><th class="num">Sessies</th><th>Status</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
    <section id="p-moderation" hidden>
      <div class="grid2">
        <div class="panel">
          <div class="head"><h2>Geblokkeerde adressen</h2></div>
          <form id="ban-form" class="row mb"><input id="ban-ip" placeholder="IP-adres" aria-label="IP-adres"><button type="submit" class="danger">Blokkeren</button></form>
          <ul class="plain" id="bans"></ul>
        </div>
        <div class="panel" id="skins" hidden>
          <div class="head"><h2>Skin-meldingen</h2><span class="dim" id="skin-info"></span></div>
          <ul class="plain" id="skin-list"></ul>
        </div>
      </div>
    </section>
    <section id="p-audit" hidden>
      <div class="head"><h2>Audit log</h2><span class="dim">de laatste 200 beheeracties sinds de start (alles staat ook in de serverlog)</span></div>
      <div class="wrap"><table id="au-table"><thead><tr><th>Tijd</th><th>Wie</th><th>Actie</th><th>Details</th><th class="num">Status</th><th>Adres</th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>
</main>`;

const hash = (s: string): string => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/** Only this page's own script and style (by hash), its fonts and images from this origin, and fetches to it. */
export const OPS_CSP = [
  "default-src 'none'", `style-src ${hash(STYLE)}`, `script-src ${hash(SCRIPT)}`, "img-src 'self'", "font-src 'self'",
  "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

export const OPS_HTML = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BunkCraft beheer</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;
