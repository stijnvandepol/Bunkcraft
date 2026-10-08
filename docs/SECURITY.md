# Beveiliging van BunkCraft

Beveiligingsaudit van server, client, dependencies en deployment (oktober 2026). Alles hieronder is
getest tegen een lokale server (`scripts/security/`), niet alleen gelezen. Regressietests staan in
`tests/security/`.

Niet in scope (andere ontwikkelaar bouwt dit): wachtwoorden, ops, metrics, `ALLOWED_ORIGINS` en
verbindingslimieten. Waar de audit daar iets over zegt, staat het als **open** met een verwijzing.

## Dreigingsmodel

| Actor | Wil | Kan |
|---|---|---|
| Anonieme internetbezoeker | Server laten crashen, vol laten lopen, games van anderen overnemen | HTTP, `/api/*`, WebSocket naar elke game waarvan hij de code raadt of kent |
| Speler in een game (kwaadwillend) | Valsspelen, andere spelers hinderen, server of mede-spelers laten crashen | Alle `ClientMessage`-types, met zijn eigen naam |
| Kwaadaardige server (Direct Connect) | Client laten crashen, scripts uitvoeren in de browser van de speler | Elk `ServerMessage`, ook ongeldige |
| Kwaadaardig bestand | Browser laten vastlopen via een resource pack | Een `.zip` of `.jar` die de speler zelf importeert |
| Kwaadwillende website | De browser van een speler gebruiken als springplank | Cross-site WebSocket naar een server in het lokale netwerk (open: O-06) |
| Host (jij) | Veilig draaien op een domein | Docker, Caddy, omgevingsvariabelen |

Vertrouwensgrenzen: de server vertrouwt alleen wat hij zelf controleert (bereik, snelheid, ids, rates);
de client vertrouwt de server niet voor HTML (alles gaat via `textContent`) maar wel voor spelstaat.
Er zijn geen accounts, geen cookies, geen sessies en geen externe verzoeken: dat beperkt het aanvalsoppervlak sterk.

## Bevindingen

Ernst: **Hoog** = op afstand en zonder voorwaarden uitbuitbaar met groot effect; **Midden** = voorwaarden of beperkt effect;
**Laag** = defense in depth.

| Id | Ernst | Status | Waar | Reproduceren | Oplossing |
|---|---|---|---|---|---|
| S-01 | Hoog | opgelost | `server/GameServer.ts:297` (`accept`) | Stuur de tekst `null` (of `5`, `[]`) over een WebSocket naar elke game: `msg.t` gooit een TypeError in de event-handler, het hele Node-proces stopt, alle games gaan neer. Zonder login mogelijk. `node scripts/security/server-attacks.mjs` | Alleen objecten met een string-`t` zijn berichten; handlers staan in try/catch en sluiten alleen die socket |
| S-02 | Hoog | opgelost | `server/GameServer.ts` (`onPos`) | Rapporteer positie `y=-100`, dan `x=5e6`: de snelheidscheck werd bij `y <= -60` overgeslagen. Gratis teleporteren door de hele wereld, op elke plek bouwen/slaan, en de server genereert chunks op grote afstand (`1e300` ook). Script: "speed check cannot be bypassed" | Snelheidscheck geldt altijd; posities buiten de wereldrand (±29 999 984) of `y` buiten -512..1024 worden genegeerd |
| S-03 | Midden | opgelost | `server/GameServer.ts` (`sendRaw`) | Open een WebSocket, lees nooit (`socket.pause()`), laat anderen chatten of laat snapshots lopen: `ws.send` bufferde onbeperkt in het servergeheugen. Test: `slow readers` | Bij meer dan 4 MB `bufferedAmount` wordt de client verbroken |
| S-04 | Midden | opgelost | `server/index.ts` | Slowloris: stuur een halve request en houd de socket open; Node-standaard houdt hem 300 s (headers 60 s) en controleert maar elke 30 s. Zonder CSP/headers had één XSS-bug directe gevolgen. Script: "slowloris", "CSP header present" | `headersTimeout` 15 s, `requestTimeout` 30 s, `keepAliveTimeout` 5 s, controle elke 5 s, `maxHeaderSize` 16 KB, `maxHeadersCount` 64; alleen GET/HEAD voor statische bestanden; CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP/CORP (`server/security.ts`, Caddyfile) |
| S-05 | Midden | opgelost | `server/GameServer.ts` (`playerRecord`) | Log in als `__proto__`, `constructor` of `toString` (de naamregex staat het toe): opzoeken in `world.players` raakte `Object.prototype`; `__proto__` zette de prototype van de hele spelerslijst, zodat nieuwe spelers andermans positie en inventory erfden. Ook werd `state.inventory` ongecontroleerd opgeslagen (geneste objecten, 64 x onbeperkt grote rijen) | Opzoeken met `Object.hasOwn`, schrijven met `defineProperty`; inventory wordt teruggebracht tot rijen van maximaal 8 eindige getallen |
| S-06 | Midden | opgelost | `src/rendering/TexturePacks.ts:343` | Importeer een zip van 20 KB met een PNG van 4 GB na uitpakken, of een PNG-header van 60 000 x 60 000: de tab loopt vast (client-DoS). Test: `texturePack.test.ts` | Limieten voor archief (512 MB), per bestand (4 MB), totaal (48 MB) op de *aangegeven* grootte vóór het uitpakken, plus controle van PNG-handtekening en afmetingen (max 2048 breed). Padnamen zijn al veilig: alleen een vaste regex en whitelist komen door, er wordt nooit naar schijf geschreven |
| S-07 | Midden | opgelost | `server/Rooms.ts` (`get`), `server/index.ts` (upgrade) | Een beschadigde `world.json` van een game (schijf vol, handmatig bewerkt) liet `JSON.parse` gooien in de upgrade-handler: server stopt. Test: `rooms.test.ts` | Falen levert `null` (404) op en een logregel; die ene game is onbeschikbaar |
| S-08 | Laag | opgelost | `server/ServerEntities.ts:163` | `drop`-berichten gebruiken `force`, dat de itemlimiet van de manager omzeilt: 30 per seconde, items blijven 5 minuten, snapshots groeien mee. `damage` werd ongecontroleerd doorgestuurd | Servergrens van 400 items; `damage` moet een geheel getal 0..100 000 zijn |
| S-09 | Laag | opgelost | `server/index.ts` | Een fout in `createReadStream` (rechten, race) was een onverwerkte `error`-event en dus een crash; ongeldige request-URL gaf een exception | Foutafhandeling op de stream, 400 bij een kapotte URL, socketfouten bij upgrades afgevangen |
| S-10 | Midden | opgelost | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | Container draaide als root met alle devDependencies; `npm start` als PID 1 gaf SIGTERM niet door (wereld niet opgeslagen); CI had schrijfrechten en actions op een beweegbare tag | Multi-stage, `npm ci --omit=dev`, `USER node`, `HEALTHCHECK`, `node` als PID 1; compose met `read_only`, `cap_drop: ALL`, `no-new-privileges`, geheugen/cpu/pids-limieten; CI met `contents: read`, actions vastgezet op SHA, `npm audit`. `.dockerignore` sluit `.env`, `.claude`, `.github` uit |
| S-11 | Laag | opgelost | `server/security.ts` (`clientAddress`) | Met `TRUST_PROXY=1` en een proxy die `X-Forwarded-For` *aanvult* (nginx `$proxy_add_x_forwarded_for`) was het eerste item door de client te kiezen: limieten per bezoeker omzeild | Het laatste item wordt gebruikt (dat voegt de proxy zelf toe); Caddy overschrijft de header; nginx-voorbeeld in `docs/SERVER.md` aangepast |
| O-01 | Hoog | open (andere ontwikkelaar: wachtwoorden) | `server/GameServer.ts:333` (`login`) | Log in met de naam van een ander: de oude sessie wordt eruit gegooid ("logged in from another location") en je krijgt zijn opgeslagen positie en inventory in de `welcome`. Geen authenticatie | Wachtwoord of token per naam; tot dan: games alleen via een code delen met vertrouwde mensen |
| O-02 | Midden | open | `server/GameServer.ts:423` (`state`), `:490` (`held`), `ServerEntities.drop` | De server kent de inventory niet: een client kan zeggen dat hij een boog, vuurslag of diamanten zwaard vasthoudt, en `drop` laat elk bestaand item uit het niets ontstaan. Valsspelen in survival | Inventory server-side bijhouden (slots valideren bij bouwen, drop en gebruik). Groot werk |
| O-03 | Midden | open (andere ontwikkelaar: verbindingslimieten) | `server/index.ts` (upgrade) | 300 stille sockets van één IP worden geaccepteerd; elke naam die inlogt krijgt een record in `world.json`, dus een bot met duizenden namen laat het bestand groeien | Limiet per IP en per game; recordlimiet; verwijder records van spelers zonder activiteit |
| O-04 | Midden | open | `server/GameServer.ts:224` (`save`) | `world.edits` groeit onbeperkt (20 edits/s per speler); het hele bestand wordt elke 30 s synchroon met `writeFileSync` weggeschreven, dus een groot bestand blokkeert de event loop voor alle games | Bovengrens op edits per game of per wereldbestand; asynchroon schrijven; per-chunk opslag |
| O-05 | Laag | open | `server/index.ts:69` | De zoeklimiet (40/min per adres) wordt gedeeld met WebSocket-verbindingen: wie achter dezelfde NAT (school, mobiel netwerk) zit, kan elkaar blokkeren. Limieten gebruiken het volledige IPv6-adres, dus een /64 geeft onbeperkt "nieuwe" bezoekers | Aparte limiter voor WebSocket; IPv6 op /64 afkappen |
| O-06 | Laag | open (andere ontwikkelaar: `ALLOWED_ORIGINS`) | `server/index.ts` (upgrade) | De `Origin` van een WebSocket wordt niet gecontroleerd: elke website kan een socket naar een BunkCraft-server openen (ook naar `localhost` of een LAN-server) en erop spelen | Origin-allowlist |
| O-07 | Laag | open | `src/net/NetClient.ts`, `src/core/Game.ts` | Een kwaadaardige server (Direct Connect) kan de tab laten vastlopen met enorme `edits`, `blocks` of `ent`-lijsten. Code-uitvoering is niet mogelijk: er is geen `innerHTML`, alle servertekst gaat via `textContent` en de CSP staat geen inline script toe | Lengtes en getalbereiken van serverberichten controleren |
| O-08 | Laag | open | `src/net/protocol.ts` (`NAME_PATTERN`) | Namen zijn ASCII, dus `Il1` / `O0` lijken op elkaar (`BoB` tegen `B0B`); sessies worden hoofdletterongevoelig vervangen maar records zijn hoofdlettergevoelig | Namen vergelijken na normalisatie |
| O-09 | Laag | open | `server/Match.ts:256` | In arcade-games bepaalt de client met `ads` zelf of hij met de kleinere spreiding schiet | Server: `ads` alleen toestaan als de speler stilstaat of een zoomtijd heeft gehad |
| O-10 | Laag | open | `server/GameServer.ts` (`login`, `onChat`) | De hoofdwereld logt `[join]`, `[leave]` en elk chatbericht met speler naam (zie Privacy). Docker bewaart die logs onbeperkt | Chat niet loggen, of logrotatie instellen |

Gecontroleerd en in orde: padtraversal in de statische server (`..%2f`, `%2e%2e`, backslashes, `%5c`, NUL, dubbele
slash, symlinks (`dist/` bevat er geen)), kamercode naar pad (alleen `[A-Z0-9]{6}`), JSON-body met `null`,
`__proto__`, `Infinity`, `NaN` en gigantische getallen op `POST /api/rooms`, body-limiet (4 KB), kamernaam met
besturingstekens en HTML (wordt nergens als HTML gerenderd), X-Forwarded-For zonder `TRUST_PROXY`, binaire frames,
frames van 100 KB (limiet 64 KB), berichtenstorm, type confusion in elk berichttype, blokbewerkingen buiten bereik,
`y` buiten 1..127, bedrock/UNLOADED, ongeldige meta. XSS: nergens `innerHTML`, `insertAdjacentHTML`,
`outerHTML`, `document.write`, `eval`, `new Function`, `window.open`, `postMessage` naar andere vensters of `href`/`src`
uit gebruikersdata (alleen `Image.src` met een `blob:`-URL van het eigen resource pack). Chat, spelersnamen,
kamernamen, MOTD, wereldnamen, packnamen en advancements gebruiken `textContent`. Poisoned `localStorage`
(instellingen worden gevalideerd, recente games ook) leidt niet tot uitvoering. Invite-links (`?join=`) gaan door
`normalizeCode` en worden daarna uit de URL gehaald. `npm audit`: 0 kwetsbaarheden; alle 131 pakketten in
`package-lock.json` hebben `resolved` (npmjs.org) en `integrity`.

## Arcade: anti-cheat en netcode (`server/anticheat/`)

De arcade-modes vertrouwden de client tot nu toe bijna volledig (zie `docs/research/ARCADE.md` §5: geen botsing met
blokken, y tot vloer+40, `dt` geklemd op 0,05 s, iedereen kreeg iedereen in `snap`, schoten tot 1,6 blok naast de
server-positie, 350 ms lag-compensatie). Nu geldt per arcade-kamer:

**Bewegingscontrole** (`Movement.ts`, DOM-vrij). Elke `pos` gaat langs dezelfde botsingscode als de client
(`boxIntersectsSolid` uit `src/player/Collision.ts`, met blokstanden), tegen de arena van de server:

| Regel | Wat | Drempel |
|---|---|---|
| `noclip` | positie in een vast blok | spelerbox 0,6 × 1,8, 0,03 marge |
| `wall` | geen botsingsvrije route van de laatste geldige positie (verticaal/horizontaal in beide volgordes, recht of om een hoek; korte gebogen routes ≤ 3 blok via een flood fill tot 0,5 blok naast de lijn), of buiten de kaart | monsters per 0,25 blok |
| `speed` / `teleport` | horizontale afstand tegen een token bucket die met de *fysicaklok* vult (zie onder) | `sprint × 1,3 × moveSpeed van het wapen × 1,03`; bucket 0,25 s + 0,75 blok (zonder klok: 0,5 s); > 10 blok in één keer = teleport |
| `rise` / `fall` | verticale snelheid | sprong 8,9 b/s (+0,6 step-up), val ≤ 60 b/s |
| `fly` | zonder ondergrond (of water/ladder) moet de speler de sprongparabool volgen: niet zweven, glijden of klimmen | apex 1,32 blok, 0,05 s timing-marge (zonder klok 0,2 s), bunny hops en kopstoten herkend via de grond (tot 1,5 blok) onder de afzet |
| `clock` | de fysicaklok van de client loopt achteruit (replay) of sneller dan de echte tijd | klok mag maximaal 2 s voorlopen (een opgehouden lag-burst) |

**Tijdbasis.** Aankomsttijden zijn onder last geen klok: een server of netwerk die achterloopt levert seconden beweging
binnen een paar ms af, en de sprongcurve en de snelheidsbucket zagen dan een onmogelijke sprong of sprint (ronde 2:
een eerlijke vlagdrager op het jacht kreeg 7 correcties). Clients sturen daarom `step` mee in `pos`: het aantal 60 Hz
fysica-stappen. De bewegingsregels rekenen met die klok; een tweede token bucket houdt hem binnen de echte tijd (2 s
marge). Zonder `step` (oude clients, scripts) geldt de aankomsttijd zoals voorheen; wie `step` één keer stuurde en het
daarna weglaat, krijgt geen tijd. Een vertraging (vlag opgepakt, langzamer wapen) geldt pas na 2 s, want de client hoort
het een round trip later.

Wapenwissel: een seconde lang (bij een vertraging twee) geldt de hoogste van oude en nieuwe snelheid. CTF: de vlagdrager mag 10 % langzamer
(`params.carrySlow`), ook op de server. Een overtreding zet de speler terug op de laatste geldige positie
(`teleport`; latere `pos` worden genegeerd tot hij daar is) en geeft strafpunten per regel (noclip/teleport/wall 3,
fly/rise 2, speed 1) die met 0,2 per seconde afnemen. Bij 10 punten volgt een kick, na drie kicks binnen 30 minuten een
ban in die kamer (alleen op naam, geen IP-hash: gedeelde netwerken). Ops houden hun kick, de eigenaar wordt nooit
gekickt. Een lag-piek (stilte > 150 ms, daarna een burst) wordt wel gecorrigeerd maar telt niet, zolang de afstand
binnen de looptijd sinds de laatste geldige positie past en het niet vaker dan 4× kort na elkaar gebeurt.
Logregel `cheat` (`kind: movement`, `rule`, `strikes`, `action`), `/metrics`: `bunkcraft_cheat_events_total{rule}`,
`bunkcraft_cheat_kicks_total`, `bunkcraft_cheat_bans_total`.

*Vals-positiefvrij*: `tests/anticheatMovement.test.ts` speelt willekeurige invoer (lopen, strafen, draaien, bunny hops,
tegen muren aan) door de echte `Player.step` op alle arcade-kaarten en een Minecraft-wereld met trappen, slabs,
ladders, water en vliegen, met 20-30 Hz `pos`, jitter tot 60 ms en bursts van 4 pakketten. Standaard 64 seeds per
kaart (volledige wapenlijst, alle kaarten); met `MOVE_SEEDS=600` nul overtredingen. De validator kent de route tussen
twee `pos` niet (een framehapering stuurt tot 0,4 s beweging in één keer): hij vraagt of er een route *bestaat*
(rechte lijn, L-vormen, daarna een 3D-zoekopdracht door een gang rond beide posities) en welke afzet de hoogte
verklaart (vloer, slabrand, pad; alle passende sprongcurves blijven bijgehouden, pas als geen enkele past volgt een
tweede zoekronde over de hele rechthoek tussen de posities). "Grond" is wat de client grond noemt: een vloer onder de
voetafdruk, nooit een muur die de zijkant van het lichaam raakt (een speler die in de lucht tegen een muur drukt
werd daardoor als staand gezien). Vaste gevallen die ooit onterecht gecorrigeerd werden staan als regressietest in
het bestand, ook de lift-pad van Flight Deck (`carrier`) die daarom ooit weg moest. Daarnaast vlagdragers onder last (framehaperingen tot
0,4 s, serverstalls en achterstanden tot 1 s) op elke kaart met vlaggen en over de dekroute van het jacht: met de
fysicaklok nul correcties, ook geen vergeven lag-correcties. `scripts/cheat-bots.ts`: twee eerlijke bots lopen en
vechten 120 s, 0 correcties, 0 strafpunten.

**Schoten** (`AimCheck.ts`, `LagComp.ts`, `Suspicion.ts`).
- De richting moet een eenheidsvector zijn (|d| = 1 ± 0,02), anders wordt het schot genegeerd (`aim-vector`).
- De oorsprong mag hoogstens 0,6 blok van het server-oog liggen, geëxtrapoleerd langs de laatste snelheid over de
  tijd sinds de laatste `pos` (max 0,1 s); anders schiet de server vanuit zijn eigen oog (`origin`).
- Lag-compensatie: `min(250 ms, RTT/2 + interpolatievertraging)` (was RTT + 100 ms, max 350 ms).
- Peeker's advantage: een slachtoffer dat 150 ms vóór het schot al achter dekking stond (gezien vanuit de oorsprong,
  drie lichaamspunten) wordt niet verder teruggespoeld. Test: slachtoffer rent achter dekking, schutter met 200 ms
  ping schiet 200 ms later: mis; 100 ms later: nog raak (normale lag-compensatie).
- Verdenkingsscore 0-100 per speler over de laatste 40 schoten: headshot-ratio van de treffers, trefkans op meer
  dan 30 blok, "snap"-treffers (≥ 20° en ≥ 600°/s sinds het vorige schot) en schoten waarvan de richting > 25° afwijkt
  van de kijkrichting uit de laatste `pos`. Vanaf 40: logregel `cheat` (`kind: aim`) en
  `bunkcraft_suspicion_flags_total`; zichtbaar (alleen-lezen) in `/admin` per speler. Nooit een automatische ban;
  een kick alleen met `ARCADE_AUTOKICK_SCORE` (standaard uit). Eerlijke bots: 0, de aimbot in `cheat-bots.ts`: 40-55.

**Informatie verbergen (anti-wallhack)** (`Visibility.ts`). Tijdens een lopende match krijgt elke speler alleen
vijanden die hij kan zien: zichtlijn (alleen ondoorzichtige volle blokken blokkeren; glas, slabs, hekken niet) van
zijn oog nu of in de laatste 0,5 s naar voeten, borst of hoofd, met 0,45 blok zijmarge rond borst en hoofd; of
binnen 12 blok; of de vijand schoot in de laatste 0,5 s. Teamgenoten en spelers die dood zijn (toeschouwer) krijgen
iedereen. Een vijand die uit beeld raakt gaat 300 ms met vlag 8 (`stale`, laatste zichtbare positie) mee, daarna
niet meer; de client verbergt naamlabel, model en wapen en begint de interpolatie opnieuw als hij terugkomt (geen
glijden door muren). De roster en het scorebord blijven compleet. Zichtlijnen worden per paar op 10 Hz gecached
(gespreid); kosten met 16 spelers ongeveer 0,03-0,1 ms per tick (`scripts/bench-arena.ts`). `ARCADE_CULLING=off`
schakelt het uit.

**Tickrate en snapshotgrootte.** Arcade-kamers tikken op `ARCADE_TICK_HZ` (standaard 30); clients interpoleren twee
ticks terug (67 ms) en sturen hun positie tot 30 Hz. Binair formaat versie 2 (`binv: 2` in `hello`,
`binaryVersion: 2` in `welcome`): posities als int16 in 1/32 blok rond een kamer-oorsprong, hoeken als u16, een
vlaggenbyte: 13 i.p.v. 21 bytes per speler. Oude clients houden versie 1 of JSON. Meting (16 spelers, tdm op classic,
60 s, eerlijke bots, `scripts/bench-arena.ts`; tijden zijn ruisig op een gedeelde machine):

| Configuratie | `snap` B/s per speler | totaal uit per speler | tick() gemiddeld | CPU per seconde |
|---|---|---|---|---|
| vóór: 20 Hz, JSON, geen culling | 8 625 | 14,9 KiB/s | 0,073 ms | 6,7 ms |
| 20 Hz, binair v1 | 6 780 | 13,2 KiB/s | 0,033 ms | 5,2 ms |
| 30 Hz, binair v1 | 10 170 | 18,4 KiB/s | 0,032 ms | 6,8 ms |
| 30 Hz, binair v2 (gekwantiseerd) | 6 510 | 14,4 KiB/s | 0,053 ms | 6,4-12,6 ms |
| **na: 30 Hz, binair v2, culling** | **5 937** | **14,2 KiB/s** | 0,053-0,113 ms | 7,2-11,2 ms |
| 30 Hz, JSON-client, culling | 11 763 | 19,9 KiB/s | 0,305 ms | 21,5 ms |

Dus 1,5× zo vaak bijwerken voor ~30 % minder snapshotbytes dan vroeger. De rest van het verkeer (tracers, ammo,
treffers) is nu groter dan de snapshots. Culling bespaart op open kaarten weinig bytes; het doel is dat een wallhack
niets ziet.

**Wat er nog openstaat.** Geen server-side simulatie van invoer (de server controleert wat mogelijk is, niet wat
de toetsen deden): een speedhack binnen 3 % of een mini-zweef < 0,9 blok boven de grond blijft onopgemerkt. Positie-
en aim-gegevens van teamgenoten gaan naar iedereen in het team. Tracers (`shot`) gaan naar iedereen en onthullen de
schutter (bewust, net als de 0,5 s-regel). De verdenkingsscore is een heuristiek met vaste drempels; met echte
spelersdata kalibreren. Geen client-integriteit (een gemodde client kan nog steeds zijn eigen camera automatiseren
zolang hij de kijkrichting in `pos` meestuurt).

## Content-Security-Policy

```
default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:;
media-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'
```

Getest met `scripts/security/csp-smoke.py` (Playwright, productiebuild): een singleplayer-wereld start, chunk-workers,
WebGL, het pixellettertype en de Pixel Perfection-textures werken, nul `securitypolicyviolation`-events.

Keuzes:

- **Geen inline script, geen `eval`**, ook niet in workers (die zijn gebundelde modules op dezelfde origin).
- **`style-src-attr 'unsafe-inline'`** is nodig omdat de UI een paar `style="..."`-attributen zet (afmetingen,
  kleuren uit vaste tabellen). Stylesheets zelf zijn `'self'`.
- **`connect-src ... ws: wss:`** staat elke host toe, omdat Direct Connect naar andere servers moet kunnen. Een host die alleen zijn eigen
  server wil, vervangt dat door `connect-src 'self'` (de speler kan dan alleen op die server spelen). Besluit:
  standaard open, omdat Direct Connect een feature is en de CSP script-injectie al blokkeert.
- **`blob:`** voor `img-src` en `worker-src` is voor resource packs van de speler.
- **COOP `same-origin`** en **CORP `same-origin`** zijn veilig (geen popups, geen cross-origin embeds). **COEP** staat uit: er is geen
  `SharedArrayBuffer` nodig en `require-corp` zou niets opleveren.
- **HSTS** zet alleen Caddy (`max-age=31536000`); de Node-server spreekt zelf geen HTTPS.
- Dezelfde waarden staan in `server/security.ts` en in de `Caddyfile`; `tests/security/headers.test.ts` controleert dat ze gelijk blijven.
  De PWA-ontwikkelaar die een service worker toevoegt, past `worker-src`/`manifest-src` hier aan als dat nodig is.

## Aanvalsscripts

Alle scripts staan in `scripts/security/` en draaien tegen een lokale server:

```bash
npm run build
ROOM_CREATE_LIMIT=1000 PORT=3100 DATA_DIR=/tmp/bunk-sec npm start &     # hoge limiet, anders blokkeert onze eigen limiter
node scripts/security/server-attacks.mjs 127.0.0.1:3100                 # ~100 s; exit 1 bij een kwetsbaarheid
python3 scripts/security/csp-smoke.py http://127.0.0.1:3100             # CSP en spelstart in Chromium
```

`server-attacks.mjs` doet: padtraversal (9 varianten via ruwe TCP), te grote headers, slowloris (25 s), CSP-headers, te grote
body, `null`/`__proto__`/NaN in de API, kamernaam met besturingstekens, XFF-spoofing, `null`-berichten voor en na de hello,
type confusion in 14 berichttypes, binaire en reuzenframes, berichtenstorm, teleport via `y<-60`, `1e300`-coördinaten,
gereserveerde namen en 300 stille sockets. Stand na de fixes: 32 van 32 geslaagd (vóór de fixes crashte de server
op de `null`-test, en faalden de header- en slowloris-checks).

## Hardening-checklist voor hosten op een domein

- [ ] `DOMAIN=play.example.com COMPOSE_PROFILES=caddy docker compose up -d` (Caddy regelt HTTPS en HSTS); poort 3000 niet publiek (compose publiceert hem niet; alleen `install.sh --proxy none` doet dat, zie SERVER.md "Achter een Cloudflare Tunnel").
- [ ] `TRUST_PROXY=1` alleen achter een proxy die `X-Forwarded-For` overschrijft (Caddyfile doet dat; nginx: `proxy_set_header X-Forwarded-For $remote_addr;`). Staat er nog een CDN (Cloudflare) voor Caddy, gebruik dan de header van de CDN en stel Caddy's `trusted_proxies` in.
- [ ] Bestaand volume uit een oudere versie? De container draait nu als `node` (uid 1000): `docker run --rm -v bunkcraft-data:/d alpine chown -R 1000:1000 /d`.
- [ ] Basisimage vastzetten op een digest (`FROM node:22-alpine@sha256:...` via `docker buildx imagetools inspect node:22-alpine`) en `caddy:2-alpine` idem; Dependabot of Renovate aanzetten voor npm, Docker en Actions.
- [ ] Firewall: alleen 80, 443 (en 443/udp) open.
- [ ] `MAX_ROOMS`, `ROOM_MAX_PLAYERS`, `ROOM_CREATE_LIMIT` en `ROOM_EXPIRE_DAYS` passend instellen; `MAIN_WORLD=off` als je alleen games met een code wilt.
- [ ] Back-ups van het volume `bunkcraft-data` (een `world.json` per game); controleer schijfruimte, want edits groeien (O-04).
- [ ] Logrotatie voor Docker (`logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }`), want chat en namen worden gelogd (O-10).
- [ ] Open items O-01 (wachtwoorden), O-03 (verbindingslimieten) en O-06 (origin-allowlist) zijn bij de beheer-ontwikkelaar; zet een publieke server pas open als die erin zitten, of deel codes alleen met vertrouwde spelers.
- [ ] Na elke update: `npm audit`, `npm test`, en `node scripts/security/server-attacks.mjs` tegen een testinstantie.

## Privacy: korte tekst voor hosts

**In de browser van de speler** (nooit naar een server gestuurd, behalve zoals hieronder): IndexedDB `bunkcraft`
(singleplayer-werelden, bewerkte chunks, wereldfoto's, geïmporteerde resource packs met Minecrafts eigen
textures) en `localStorage`: `bunkcraft.settings` (opties en toetsen), `bunkcraft.name` (laatst gebruikte spelersnaam),
`bunkcraft.server` (laatste Direct Connect-adres), `bunkcraft.games` (de laatste vijf game-codes en -namen).
Er zijn geen cookies, geen analytics, geen externe fonts of scripts (de CSP laat dat ook niet toe).

**Wat naar de server gaat** bij multiplayer: de spelersnaam, positie, blokbewerkingen, chat, en inventory en gezondheid
(om je terug te zetten waar je was). Andere spelers in dezelfde game zien je naam, positie en chat. Een game is alleen
bereikbaar met zijn code.

**Op de server** (`DATA_DIR`): per game een `world.json` met wereldnaam, seed, bewerkingen, en per spelersnaam de laatste positie,
inventory en statistieken. Dit is geen account en bevat geen e-mail of wachtwoord. Games zonder bezoek worden na
`ROOM_EXPIRE_DAYS` (standaard 60) verwijderd; een speler die zijn gegevens kwijt wil, vraagt de host zijn game te verwijderen
(de map `rooms/<CODE>`).

**IP-adressen**: de applicatie schrijft ze nergens weg; ze staan alleen kort in het geheugen voor de limieten per bezoeker
(`ROOM_CREATE_LIMIT` en de zoeklimiet) en verdwijnen na de venstertijd. Caddy logt standaard geen requests; zet je het `log`-blok aan, dan
staan IP's in die logs en geldt de AVG voor jou als host. De hoofdwereld logt in de console naam bij binnenkomen en vertrek en elk
chatbericht (games met een code niet), dus Docker-logs bevatten dan namen en chat; stel logrotatie in.
