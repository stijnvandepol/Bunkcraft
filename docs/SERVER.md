# BunkCraft server draaien

Eén Node.js-proces serveert de game (de gebouwde `dist/`) **en** de multiplayer-server
(WebSocket op `/ws`) op dezelfde poort. Je hoeft dus maar één ding te hosten.

```
Browser ──HTTP──▶  /            → dist/ (de game)
        ──HTTP──▶  /api/rooms   → een game aanmaken (POST), opzoeken (GET /api/rooms/<CODE>) of de serverlijst (GET /api/rooms?public=1)
        ──WS────▶  /ws          → hoofdwereld
        ──WS────▶  /ws/<CODE>   → een game van een speler
        ──HTTP──▶  /health      → {"ok":true,"version":"1.0.0","uptime":3600,"players":2,"rooms":3}
        ──HTTP──▶  /metrics     → Prometheus (alleen lokaal of met token)
        ──HTTP──▶  /admin       → beheerpagina (alleen met ADMIN_TOKEN), API op /api/admin/*
```

## Snel starten

Vereist Node.js 20 of nieuwer.

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

## Spelen met vrienden: games aanmaken en joinen

Je hoeft niets in te stellen. Op de server kiest iedere speler **Multiplayer**:

- **Create Game:** kies een naam, spelmodus en eventueel een seed, een **wachtwoord** en of de game in de
  **serverlijst** mag staan. Je krijgt een code van zes tekens
  (bijvoorbeeld `K7Q-M2X`) en een uitnodigingslink (`https://jouwdomein/?join=K7QM2X`).
  Ook later in het spel: **Esc → Invite Friends**.
- **Join Game:** een vriend opent de link (naam invullen, klaar) of typt de code of plakt de link in het
  codeveld. Recente games staan als knop in het menu.
- **Browse Games:** de publieke serverlijst: games waarvan de maker "Show in Server List" aanzette.
- **Join Public Server:** de altijd-aanwezige hoofdwereld (zet uit met `MAIN_WORLD=off`).
- **Direct Connect:** een ander BunkCraft-adres, voor wie een eigen server draait.

Elke game is een eigen wereld met eigen spelers, tijd en chat. Games worden opgeslagen op de server in
`data/rooms/<CODE>/`, zijn tot 8 spelers groot en blijven bestaan tot niemand er 60 dagen in is geweest.
Lege games worden na 5 minuten uit het geheugen gehaald en bij de volgende join weer geladen.

## Op je eigen domein (HTTPS)

Het snelst met Docker en Caddy, die het certificaat automatisch regelt:

```bash
# DNS: een A-record van play.example.com naar je server; poort 80 en 443 open.
git clone <deze repo> && cd Game
DOMAIN=play.example.com docker compose up -d
```

Open daarna `https://play.example.com`. De wereld staat in het volume `bunkcraft-data` en overleeft
herstarts en updates (`git pull && docker compose up -d --build`). Instellingen zet je in een `.env`
naast `docker-compose.yml`, bijvoorbeeld `ROOM_MAX_PLAYERS=12`.

Heb je al een reverse proxy? Zie de voorbeelden verderop; zet dan `TRUST_PROXY=1`, zodat de
limieten per bezoeker werken in plaats van per proxy.

## Configuratie (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3000` | HTTP- en WebSocket-poort |
| `DATA_DIR` | `./data` | Map voor `world.json` (wereld, wijzigingen, spelers, tijd) |
| `WORLD_NAME` | `BunkCraft Server` | Naam van de wereld |
| `SEED` | willekeurig | Seed: een getal of tekst. Geldt alleen bij een nieuwe wereld. |
| `GAMEMODE` | `survival` | `survival`, `creative`, `hardcore` of `spectator` |
| `MOTD` | `Welcome to BunkCraft!` | Bericht bij het inloggen |
| `MAX_PLAYERS` | `20` | Maximum aantal spelers in de hoofdwereld |
| `TRUST_PROXY` | `0` | `1` achter een reverse proxy: gebruik `X-Forwarded-For` voor de limieten per bezoeker |
| `MAIN_WORLD` | `on` | De hoofdwereld op `/ws` (knop *Join Public Server*) |
| `ROOMS` | `on` | Spelers kunnen zelf games aanmaken (`off` = alleen de hoofdwereld) |
| `MAX_ROOMS` | `200` | Maximum aantal games op de server |
| `ROOM_MAX_PLAYERS` | `8` | Spelers per game |
| `ROOM_CREATE_LIMIT` | `6` | Games die één bezoeker per uur mag aanmaken |
| `ROOM_EXPIRE_DAYS` | `60` | Games zonder bezoek worden na zoveel dagen verwijderd (`0` = nooit) |
| `ADMIN_TOKEN` | niet gezet | Geheim voor `/admin` en `/api/admin/*`. Leeg = beheer staat uit. Minstens 16 willekeurige tekens (`openssl rand -hex 24`). Wie dit token als `owner` meestuurt, is ook operator in elke game. |
| `METRICS_TOKEN` | niet gezet | Bearer-token voor `/metrics`. Zonder `METRICS_TOKEN` en `ADMIN_TOKEN` is `/metrics` alleen bereikbaar vanaf deze machine (niet via een reverse proxy). |
| `OPS` | leeg | Komma-gescheiden namen die operator zijn in de **hoofdwereld** (games hebben hun eigen eigenaar). |
| `ALLOWED_ORIGINS` | leeg (alles) | Komma-gescheiden `Origin`-lijst voor WebSocket en API-CORS, bijv. `https://play.example.com`. `same-origin` staat alleen de eigen host toe. |
| `MAX_CONNECTIONS` | `500` | Maximum aantal gelijktijdige WebSocket-verbindingen |
| `MAX_CONN_PER_IP` | `10` | Maximum aantal verbindingen per adres (let op: een huishouden achter één IP) |
| `PASSWORD_FAIL_LIMIT` | `5` | Foute wachtwoorden per adres per 10 minuten, daarna geweigerd |
| `LIST_MAX` | `50` | Maximum aantal games in de publieke serverlijst |
| `INVENTORY_GUARD` | `enforce` | Inventory-controle in survival: `enforce` (terugdraaien), `warn` (alleen loggen) of `off` |
| `BINARY_PROTOCOL` | `on` | Binaire `snap`/`ent`-frames voor clients die erom vragen (`off` = altijd JSON) |
| `ARCADE_TICK_HZ` | `30` | Tickrate van arcade-kamers (10-60); Minecraft-werelden blijven 20 Hz |
| `ARCADE_CULLING` | `on` | Anti-wallhack: arcade-snapshots per speler zonder onzichtbare vijanden (`off` = iedereen naar iedereen) |
| `ARCADE_AUTOKICK_SCORE` | `0` | Kick bij deze aim-verdenkingsscore (0-100; `0` = nooit, alleen loggen) |
| `BACKUP_KEEP` | `12` | Aantal back-ups per wereld (`0` = geen back-ups) |
| `BACKUP_INTERVAL_MIN` | `60` | Minuten tussen back-ups |
| `RECONNECT_HINT_MS` | `8000` | Bij afsluiten (SIGTERM) krijgen spelers de hint om zoveel milliseconden later opnieuw te verbinden |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` of `error` |
| `LOG_FORMAT` | `json` | `json` (een object per regel) of `text` |

`world.json` bevat ook `genVersion`, de versie van de terreingenerator (zie RESEARCH.md §4). Een nieuw bestand krijgt de huidige versie, een bestand zonder het veld (van voor versies) is versie 1 en blijft dat: zijn terrein blijft hetzelfde.

Voorbeeld: `SEED=bunk GAMEMODE=creative WORLD_NAME="Bouwserver" npm start`

## Wachtwoorden, privacy en namen

- **Wachtwoord per game** (optioneel, bij *Create Game*). De server bewaart alleen een `scrypt`-hash in `world.json`
  (`scrypt$N$r$p$salt$hash`); het wachtwoord zelf wordt nergens teruggestuurd of gelogd. `GET /api/rooms/<CODE>` meldt
  alleen `"locked": true`, waarna het menu om het wachtwoord vraagt. Het wachtwoord gaat in het `hello`-bericht over de
  WebSocket, dus gebruik HTTPS (`wss://`).
- **Brute force:** `PASSWORD_FAIL_LIMIT` foute pogingen per adres per 10 minuten, over alle games samen. Daarna weigert de
  server zelfs het juiste wachtwoord totdat het venster voorbij is, zonder de (dure) scrypt-controle uit te voeren.
- **Privé of in de lijst:** een game staat standaard **niet** in de serverlijst. Alleen "Show in Server List" zet hem erin.
  `GET /api/rooms?public=1` geeft per game `code`, `name`, `gameType`, `gameMode`, `players`, `maxPlayers`, `locked` en bij
  arcade-games `map`: maximaal `LIST_MAX` stuks, vijf seconden gecachet, begrensd per adres. De lijst komt uit een klein
  `meta.json` naast elke `world.json`, zodat een lijst nooit werelden hoeft te laden. Games van vóór deze versie hebben geen
  `meta.json` en staan dus niet in de lijst.
- **Eigenaar:** `POST /api/rooms` geeft **één keer** een `ownerToken` terug (alleen de SHA-256 staat in `world.json`). De
  browser van de maker bewaart hem in `localStorage` (`bunkcraft.owner.<CODE>`) en stuurt hem mee bij het joinen: dat maakt
  hem eigenaar en operator, zonder wachtwoord en zonder dat een ban of whitelist hem buitensluit. Raak je dat token kwijt,
  dan ben je geen eigenaar meer; de beheerder kan de game dan nog sluiten via `/admin`.
- **Namen zijn gebonden aan een browser.** Elke browser maakt per server en game een geheime sleutel (`bunkcraft.key.<host>/<CODE>`)
  en stuurt hem mee. De eerste login met een naam claimt die naam in die game (`claims` in `world.json`, alleen de hash).
  Wie later dezelfde naam met een andere sleutel gebruikt, wordt geweigerd. Zo kan niemand zich voordoen als operator.
  Oude clients zonder sleutel kunnen nog joinen onder namen die niemand claimde, maar zijn nooit operator. Een claim is
  geen account: wie zijn browserdata wist, verliest zijn naam (vraag de eigenaar `/unban`/een nieuwe naam).

## Operators en commando's

Een game heeft een **eigenaar** (de maker, via het token) en **operators** (`/op`). Alles wordt op de server gecontroleerd; de
client stuurt alleen de chattekst. `/help` toont alleen wat jij mag gebruiken.

| Commando | Wie | Wat |
|---|---|---|
| `/help`, `/list`, `/seed`, `/spawn` | iedereen | |
| `/say <tekst>` | operator | Systeembericht aan iedereen |
| `/kick <naam> [reden]` | operator | Speler verwijderen (hij kan terugkomen) |
| `/ban <naam> [reden]`, `/unban <naam>`, `/banlist` | operator | Ban op naam én op adres (gehasht met een zout) als de speler online was |
| `/op <naam>`, `/deop <naam>` | eigenaar | Operators beheren; alleen de eigenaar kan een operator kicken of bannen |
| `/whitelist add\|remove <naam>`, `on`, `off`, `list` | operator | Alleen genoemde namen (en operators) mogen joinen |
| `/tp <naam>` of `/tp <naam> to <naam>` | operator | Teleporteren |
| `/gamemode survival\|creative\|hardcore\|spectator` | operator | Geldt voor iedereen in die game |
| `/time set day\|noon\|night\|midnight` | operator | |
| `/weather clear\|rain\|thunder [seconden]` | operator | Zet het weer voor iedereen in die game (niet in arcade-games) |
| `/give <naam> <item> [aantal]` | operator | **Alleen in creative-games** |

Opslag: `ops`, `bans` en `whitelist` staan in `world.json` en overleven herstarts. Een game die van vóór de eigenaars-tokens
dateert, heeft geen eigenaar: daar bestaan geen moderatiecommando's en blijft `/time` open voor iedereen, zoals vroeger.
De hoofdwereld krijgt operators via `OPS` (namen, gebonden via de sleutel) of via `ADMIN_TOKEN` als `owner`.

## Beheer: `/admin` en `/api/admin/*`

Alleen actief met `ADMIN_TOKEN`. Elk verzoek heeft `Authorization: Bearer <token>` nodig; het token wordt in constante tijd
vergeleken (`timingSafeEqual` over SHA-256) en 20 foute pogingen per adres per 10 minuten geven 429. Zet `/admin` bij voorkeur
alleen open via HTTPS, of beperk het in je reverse proxy tot je eigen IP.

| Verzoek | Doet |
|---|---|
| `GET /api/admin/stats` | uptime, spelers, games, verbindingen, CPU, geheugen, tick p50/p99, verkeer |
| `GET /api/admin/rooms` | hoofdwereld en alle games (ook die niet in het geheugen staan) |
| `GET /api/admin/rooms/<CODE>/players`, `GET /api/admin/main/players` | spelers met adres en ping |
| `POST /api/admin/rooms/<CODE>/kick`, `POST /api/admin/main/kick` | `{"name":"..."}` |
| `POST /api/admin/rooms/<CODE>/close` | iedereen eruit en uit het geheugen; `{"remove":true}` verwijdert ook de data |
| `GET/POST /api/admin/ip-bans`, `DELETE /api/admin/ip-bans/<ip>` | adressen blokkeren (bewaard in `data/ip-bans.json`); open verbindingen sluiten direct |

`/admin` is één statische HTML-pagina zonder framework en zonder geheimen erin: je plakt het token in (alleen in
`sessionStorage` van dat tabblad), ziet elke 5 seconden de cijfers en kunt games sluiten of verwijderen, spelers kicken en
adressen blokkeren. Alle data gaat via `textContent` de pagina in en een strikte CSP verbiedt externe scripts.

## Observability en betrouwbaarheid

- **Logs:** een JSON-object per regel (`{"ts","level","msg",...velden}`), met `room` op regels van een game. Handig met
  `docker logs bunkcraft | jq`. `LOG_LEVEL` en `LOG_FORMAT=text` voor leesbare regels.
- **`/health`:** `{ok, version, uptime, players, rooms}`; 503 terwijl de server afsluit.
- **`/metrics`** (Prometheus): `bunkcraft_players`, `bunkcraft_rooms_loaded`, `bunkcraft_rooms_total`, `bunkcraft_connections`,
  `bunkcraft_tick_duration_seconds{quantile="0.5"|"0.99"}`, `process_resident_memory_bytes`, `process_heap_used_bytes`,
  `process_cpu_seconds_total`, `bunkcraft_ws_messages_{received,sent}_total`, `bunkcraft_ws_bytes_{received,sent}_total`,
  `bunkcraft_ws_messages_per_second{direction}`, `bunkcraft_ws_bytes_per_second{direction}`,
  `bunkcraft_rate_limit_hits_total{kind}`, `bunkcraft_connections_refused_total`, `bunkcraft_logins_failed_total`,
  `bunkcraft_inventory_rejects_total`, `bunkcraft_cheat_events_total{rule}`, `bunkcraft_cheat_kicks_total`,
  `bunkcraft_cheat_bans_total`, `bunkcraft_suspicion_flags_total` (arcade anti-cheat, zie SECURITY.md). Scrape-config: `bearer_token: <METRICS_TOKEN>` of scrape lokaal.
- **Afsluiten (SIGTERM/SIGINT):** de server stopt met nieuwe verbindingen, slaat alle werelden op, stuurt elke speler
  `kick` met `reconnect: <ms>` en sluit de sockets met code 1012. De client toont "Server restarting" en probeert tot vijf keer
  zelf opnieuw te joinen. Docker stuurt SIGTERM en wacht 10 seconden: ruim genoeg.
- **Back-ups:** elke `BACKUP_INTERVAL_MIN` minuten een kopie van elke gewijzigde `world.json` naar
  `data/backups/<main|CODE>/<tijdstempel>.json`, de nieuwste `BACKUP_KEEP` blijven. Back-ups van verwijderde games blijven
  30 dagen. De wereld zelf wordt al atomair geschreven (tijdelijk bestand + rename). Is een `world.json` toch onleesbaar, dan
  gebruikt de server de nieuwste leesbare back-up (en bewaart het kapotte bestand als `world.json.corrupt-<tijd>`); zonder
  back-up weigert hij te starten in plaats van de wereld te overschrijven. Terugzetten: kopieer een back-up naar `world.json`
  terwijl de server uit staat.
- **Verbindingslimieten:** `MAX_CONNECTIONS` globaal, `MAX_CONN_PER_IP` per adres (503 / 429 vóór de WebSocket-handshake),
  `ALLOWED_ORIGINS` voor de `Origin`-header (browsers sturen die altijd; clients zonder Origin, zoals bots en curl, vallen niet
  onder deze controle). Zonder `TRUST_PROXY=1` ziet de server achter een proxy overal hetzelfde adres: zet het aan.
- **Fouten:** een onverwachte fout in één game wordt gelogd (`uncaught exception`) zonder de rest te stoppen; mislukt het opslaan
  (schijf vol), dan blijft de wereld in het geheugen en probeert de server het over 30 seconden opnieuw.

## Server-authoritative inventory (survival)

De client beheert nog steeds het inventoryscherm (geen server-roundtrip per klik), maar in **survival- en hardcore-games**
accepteert de server een `state`-bericht alleen als de wijziging uit te leggen is. Een afgewezen inventory wordt niet
opgeslagen; de client krijgt `{t:"state", inventory, reason}` terug met de laatste goedgekeurde inventory plus de pickups en
drops die de server sindsdien zag, en laadt die. Creative en spectator zijn uitgezonderd (daar bestaat een onbeperkte
inventory), maar ook daar moet de vorm kloppen. `INVENTORY_GUARD=warn` logt alleen (handig om te testen), `off` schakelt uit.

**Wat de server controleert** (`server/InventoryGuard.ts`):

- Vorm: maximaal 36 slots, alleen gehele getallen, bestaand item-id, stackgrootte `1..maxStack` (gereedschap stapelt niet),
  gereedschapsschade binnen de levensduur.
- Items komen alleen binnen via een **pickup** die de server zelf stuurde (`taken`) of via **craften/smelten**: een
  toename die geen pickup verklaart, moet te maken zijn uit de vorige inhoud met `RECIPES`, ook ketens (blok hout → planken →
  stokken) tot drie niveaus diep.
- **`drop`-berichten** (blokdrops, Q, doodsdrops) maken alleen een itementiteit als er een **blok was dat deze speler brak**
  (de server zag de `block`-wijziging; krediet 60 seconden, het zwaarste gereedschap als maximum, grind mag vuursteen geven)
  of het item **in zijn inventory zit**. Een gesmeed `drop` van 64 diamanten maakt dus niets, en dezelfde drop herhalen
  dupliceert niet: elk stuk wordt van het saldo afgeboekt. Drop en weer oppakken geeft het saldo één keer terug.

**Wat niet wordt voorkomen** (eerlijk, zodat je weet waar de grenzen liggen):

- Welk werkblad of welke oven werd gebruikt en of die dichtbij stond: de recepten zelf worden gecontroleerd, het station niet.
- Opgegeten items: verbruik wordt vertrouwd (het verlaagt alleen het saldo). Geplaatste blokken worden wél afgeboekt
  (`authorizeEdit`): een blok dat de speler niet heeft en ook niet uit zijn voorraad kan craften, wordt geweigerd.
- Gereedschapsschade terugzetten naar 0 (repareren zonder recept) en de volgorde van slots.
- Health, honger en `stats`: die geeft de client op (alleen getallen en lengte worden gecontroleerd).
- Een speler die al vóór deze versie vals speelde: zijn opgeslagen inventory geldt als beginsituatie.
- Een legitieme drop zonder blokbreuk die de server niet kent (bijvoorbeeld bladverval aan de clientkant) wordt geweigerd:
  `INVENTORY_GUARD=warn` laat zien of dat gebeurt (`unbacked drop` in de logs).
- Kisten en ovens staan op de server (`server/Containers.ts`): elke klik draagt de inventory mee, gaat langs de guard en geeft krediet (`creditTransfer`) of boekt af (`spendTransfer`).

## Binair protocol voor `snap` en `ent`

Arcade-kamers gebruiken daarnaast versie 2: `hello` met `binv: 2` → `welcome` met `binaryVersion: 2` en `tickHz`, en
`snap` als gekwantiseerd frame (soort 3, 13 bytes per speler, zie `binary.ts` en `docs/SECURITY.md` §Arcade).

De twee berichten met de meeste bytes kunnen als binaire WebSocket-frames (`src/net/binary.ts`, `DataView`, geen
afhankelijkheid). De client zet `bin: true` in `hello`; de server antwoordt `binary: true` in `welcome` en verstuurt vanaf dan
alleen `snap` en `ent` binair. Alle andere berichten, en alles van client naar server, blijven JSON. Een client begrijpt altijd
beide vormen, dus oude en nieuwe clients kunnen in dezelfde game zitten. Layout: zie de kop van `binary.ts`
(snap 21 bytes per speler, mob 27, item 20, pijl 21, TNT 18).

Meting (`npx tsx scripts/bench-binary.ts`, 16 spelers, willekeurige maar realistische waarden):

| Bericht | JSON | Binair | Besparing | Encode (JSON / bin) | Decode (JSON / bin) |
|---|---|---|---|---|---|
| `snap`, 16 spelers, 20 Hz | 737 B | 339 B | **54 %** | 2,6 / 1,0 µs | 4,2 / 0,6 µs |
| `ent`, rustig (6 mobs, 2 items), 10 Hz | 395 B | 211 B | **47 %** | 1,5 / 1,2 µs | 2,6 / 0,8 µs |
| `ent`, druk (24 mobs, 12 items, 4 pijlen, 3 TNT) | 1832 B | 1035 B | **44 %** | 7,4 / 2,4 µs | 12,0 / 1,2 µs |

Per client in een volle game: 14,4 → 6,6 KiB/s voor `snap`; de server verstuurt met 16 spelers ongeveer 230 → 106 KiB/s aan `snap`
alleen. De CPU gaat omlaag in plaats van omhoog (binair is goedkoper dan `JSON.stringify` en `JSON.parse`), en de besparing is
boven de 40 %, dus staat het standaard aan. Een deflate-compressie van de JSON (`permessage-deflate`) haalt vergelijkbare
bytes (400 B voor `snap`), maar kost CPU per bericht en per verbinding op de server; dat staat daarom uit. Gevolg: hoeken
hebben 0,0001 rad resolutie en posities zijn `float32` (< 1 cm fout tot 100 000 blokken).

## Docker

```bash
docker build -t bunkcraft .
docker run -d -p 3000:3000 -v bunkcraft-data:/app/data -e GAMEMODE=survival --name bunkcraft bunkcraft
```

De wereld staat in het volume `bunkcraft-data` en overleeft herstarts en updates.

## Achter een reverse proxy (HTTPS)

Op een HTTPS-site gebruikt de game automatisch `wss://`. De proxy moet WebSocket-upgrades
doorgeven. Voor **nginx**:

```nginx
server {
    listen 443 ssl;
    server_name bunkcraft.example.com;
    # ssl_certificate ... (bijv. via certbot)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # Overschrijf X-Forwarded-For (geen $proxy_add_x_forwarded_for): clients kunnen dat anders zelf kiezen.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
    }
}
```

Met **Caddy** volstaat `bunkcraft.example.com { reverse_proxy 127.0.0.1:3000 }`. Caddy regelt
HTTPS en WebSockets automatisch.

## Wat de server doet

- **Gedeelde wereld:** het terrein komt uit de seed, dus de server bewaart en verstuurt alleen
  blokwijzigingen. Nieuwe spelers krijgen bij het inloggen de volledige lijst wijzigingen.
- **Controles:**
  - Blokwijzigingen: reikwijdte (≤ 8 blokken), een geldig blok-id, geen bedrock, en maximaal 20 per seconde. Een geweigerde wijziging wordt bij de speler teruggedraaid.
  - Beweging: onmogelijke snelheden zetten de speler terug.
  - Chat: maximaal 1 bericht per seconde, opgeschoond.
- **Spelersdata per naam:** positie, inventory en health worden bewaard en hersteld bij de volgende login.
- **Tijd:** de dag/nachtcyclus loopt op de server (alleen als er spelers online zijn) en wordt gesynchroniseerd.
- **Opslaan:** elke 30 seconden en bij afsluiten (Ctrl+C / SIGTERM), atomisch via
  een tijdelijk bestand, zodat een crash nooit een half geschreven wereld achterlaat.
- **Commando's in de chat:** zie *Operators en commando's*.

## Mobs, items en TNT op de server

De server draait dezelfde mob-AI als singleplayer (varken, koe, schaap, kip, zombie, creeper, skeleton, spin),
met terrein uit de seed plus de edits van de spelers, geladen rond de spelers. Elke mob volgt de dichtstbijzijnde
speler; 's nachts spawnen vijanden rond iedereen. Spelers sturen alleen verzoeken (aanvallen, schieten, TNT
aansteken, item pakken of droppen), de server controleert bereik, wat je vasthoudt en de snelheid, en
stuurt 10 keer per seconde de entiteiten om je heen terug. Schade komt als bericht naar de speler; explosies
sturen de verwijderde blokken mee. Een lege game geeft zijn geheugen vrij.

Kosten: ongeveer 0,03 ms CPU per tick in rust en ~0,3 ms terwijl chunks genereren, plus een paar MB per
geladen game.

## Speltypes: Minecraft en de arcade-modes

Een game heeft een speltype. **Minecraft** (standaard) is de sandbox hierboven. De twee arcade-types zijn
rondes op één vaste arena, in de geest van Krunker: snelle beweging, hitscan-wapens, health die terugkomt
en een scorebord.

| Speltype | `gameType` | Wat |
|---|---|---|
| Minecraft | `minecraft` | Bouwen, mijnen, mobs, spelmodus naar keuze |
| Team Deathmatch | `tdm` | Rood tegen blauw; het team met de meeste kills wint |
| Free For All | `ffa` | Ieder voor zich; wie de scorelimiet haalt (of aan het eind de meeste kills heeft) wint |
| Gun Game | `gungame` | Wapenladder van 16 niveaus (eindigt met het mes); kill = niveau omhoog, meskill = slachtoffer omlaag |
| Team Elimination | `elimination` | Rondes met één leven; het team dat de ander uitschakelt wint de ronde |
| Hardpoint | `hardpoint` | Wisselende heuvel, 1 punt/s voor het team dat er alleen staat, tot 250 |
| Domination | `domination` | Drie punten innemen en vasthouden, 1 punt per 2 s per punt, tot 100 |
| Capture the Flag | `ctf` | Vijandelijke vlag naar de eigen (thuis staande) vlag brengen, tot 3 captures |

Een game aanmaken (`POST /api/rooms`) accepteert `{ name, gameMode, seed, gameType?, scoreLimit?, timeLimitSec?, mapId? }`:

| Veld | Standaard (tdm / ffa) | Grenzen |
|---|---|---|
| `gameType` | `minecraft` | een id uit `GAME_TYPES` (onbekend = `minecraft`) |
| `scoreLimit` | van het type (30 / 20 / 4 / 250 / 100 / 3) | 5 tot 100, verruimd met de keuzes van het type (1 capture, 250 punten); gun game negeert het (de ladder) |
| `timeLimitSec` | van het type (600; elimination 90 = rondetijd) | 120 tot 1800 seconden, verruimd met de keuzes van het type (rondetijd 60 s) |
| `mapId` | `classic` | een id uit `MAP_IDS` (`classic`, `suburb`, `quarter`, `dockyard`, `desert`, `atomic`, `bunker`, `villa`, `yacht`, `town`, `station`) of `rotate` (onbekend = `classic`) |

`GET /api/rooms/<CODE>` geeft ook `gameType`, `scoreLimit` en `timeLimitSec` terug (0 bij Minecraft) en bij arcade-games
`map` (de instelling: een kaart of `rotate`). De instellingen staan in `world.json` van de game (`mapId`). De spelmodus
(`gameMode`) en de seed zijn voor een arcade-game niet van belang: de seed kiest alleen een van drie indelingen van de
dekking op de Classic-kaart. De limieten voor
het aanmaken van games (`ROOM_CREATE_LIMIT`, `MAX_ROOMS`) gelden ongewijzigd.

**De kaarten** staan in `src/modes/maps/` (een bestand per kaart, gedeeld door workers, server en client). Elke kaart is
deterministisch, spiegelsymmetrisch (rood links, blauw rechts), omheind door een muur en gebouwd uit bestaande blokken; de
rode en blauwe wol markeert de teamzones. Elke kaart heeft eigen spawns die ver uit elkaar liggen en elkaar niet kunnen zien.

| `mapId` | Naam | Grootte | Stijl |
|---|---|---|---|
| `classic` | Classic | 96 × 96 | Middenplatform, corridors en dekking (drie indelingen via de seed) |
| `suburb` | Maple Court | 64 × 40 | Klein en snel: twee huizen tegenover elkaar, straat, garages en tuinen |
| `quarter` | Old Quarter | 80 × 64 | Stedelijk: binnenplaats, balkons, dakstairs en steegjes |
| `dockyard` | Harbor Yard | 88 × 64 | Industrieel: containerstapels, centrale loods, kraandek en een schip |
| `desert` | Dust Bazaar | 96 × 64 | Lange zichtlijnen: markt, daken en sluipschuttertorens aan beide uiteinden |
| `atomic` | Atomic Lane | 80 × 52 | Vrije kaart: twee huizen, een bus en een rotonde |
| `bunker` | Bunker Flag | 64 × 40 | Capture the flag: rivierbedding, bruggen, een duiker en een bunker per team |
| `villa` | Skyline Villa | 88 × 64 | Vrije kaart: witte villa met atrium en dakterras, leeg zwembad, basketbalveld, garage |
| `yacht` | Riptide | 88 × 56 | Vrije kaart: superjacht in een jachthaven met benedendek, salon, brug en helikopterdek |
| `town` | Sundown | 80 × 68 | Vrije kaart: stoffig dorp met tankstation, cantina, markt, klokkentoren en steegjes |
| `station` | Terminus | 84 × 68 | Vrije kaart: station met twee treinen, perrons, loopbruggen, tunnels en twee hallen |

De instelling `rotate` speelt elke volgende match op de volgende kaart (in de volgorde hierboven). Bij een nieuwe
kaart vervangt de server zijn kogelwereld en stuurt hij `match` met `info.map`; de client ziet dat dit niet zijn kaart
is en **voegt zich opnieuw bij de game** (nieuw `welcome`, nieuwe wereld). De kaart reist als `worldType`
`arena:<mapId>` (`arena` = classic) door de workers en `ServerWorld`; in het protocol staat hij als optionele
`MatchInfo.map` (zonder protocolversie te verhogen: oude clients negeren het veld).

Alleen bestaande blokken, op een vlakke vloer. De server houdt spelers binnen de muur van de gekozen kaart.

**Het modeframework** (`server/Match.ts` + `server/modes/*`): `Match` is eigenaar van spelers, teams, hitscan, health,
munitie, respawntimers, lag compensation en de berichten. Wat een mode anders maakt staat als data in de `GameTypeDef`
(respawnregel, spawnbescherming, rondefases, loadout, benodigde kaartdata, params, scoring, HUD) en in een kleine klasse die
`ModeLogic` implementeert (`server/modes/ModeLogic.ts`, standaardgedrag in `BaseLogic`):

| Hook | Wanneer |
|---|---|
| `onStart` | de warm-up is voorbij (scores op nul); standaard `match.startLive()` |
| `onTick(dt)` | elke servertick buiten warm-up en uitslag (zones tellen, vlaggen aanraken) |
| `onPhaseEnd(phase)` | de timer van een fase loopt af (`countdown`, `live`, `roundend`, `intermission`); standaard eindigt `live` de match |
| `onKill`, `onSpawn`, `onJoin`, `onLeave`, `onReset` | levensloop van spelers en matches |
| `respawnDelay`, `loadoutFor`, `pickSpawn`, `canStart` | regels per leven (negatief = pas volgende ronde; ladderwapen; ...) |
| `checkEnd`, `winner`, `scoreText`, `modeState` | einde, winnaar, de regel onder de timer en de HUD-toestand (`mode`-bericht) |

`Match` biedt de modes `setPhase(phase, sec)`, `startLive()`, `respawnAll()`, `endMatch(result?)`, `giveGear()`, `event()`,
`markModeDirty()`, `scores`, `teamSize`/`aliveCount`. De klassen:

- `deathmatch.ts` (tdm, ffa): ongewijzigd gedrag; `tests/match.test.ts` en `scripts/arena-bots.ts` zijn het vangnet.
- `gungame.ts`: `pts` = niveau; elke kill `giveGear` met het volgende ladderwapen (plus mes); meskill zet het slachtoffer een
  niveau terug; een kill op het laatste niveau wint, op tijd wint het hoogste niveau. FFA-spawns, respawn 1,5 s.
- `rounds.ts` (elimination): `intermission` (5 s, iedereen respawnt) → `countdown` (3 s) → `live` (rondetijd) → `roundend` (4 s).
  Uitschakelen van het hele andere team wint de ronde, op tijd wint het team met meer levenden (gelijk = geen punt). Late
  joiners kijken mee tot de volgende ronde; is een team leeg, dan terug naar warm-up.
- `zones.ts` (hardpoint, domination): aanwezigheid = levende spelers binnen de straal en -1,2..+3,5 blokken hoogte. Hardpoint:
  één heuvel in kaartvolgorde, 60 s plus 5 s pauze, 1 punt/s bij alleenbezit, betwist = niets. Domination: inname in 6 s
  (eigen punt eerst neutraliseren), 1 punt per 2 s per eigen punt.
- `ctf.ts`: vlag aanraken (1,6 blokken, 2,6 hoog) pakt hem op; eigen vlag aanraken terwijl die thuis staat en je de andere
  draagt = capture (+1 team, +1 `pts`); dood/vertrek laat de vlag vallen, eigen team brengt hem terug of na 12 s vanzelf.

De HUD-toestand gaat 4× per seconde (en direct bij een verandering) als `mode` naar iedereen, gebeurtenissen als `event`, een
puntwijziging direct als `match`. Kaarten zonder de benodigde `objectives` worden voor dat type overgeslagen (`mapFor`,
`nextMap(id, requires)`). Botrun tegen een echte server: `npx tsx scripts/modes-bots.ts [mode...] --url=http://localhost:3000`.

**Het matchverloop:**

1. **Warm-up:** zodra er twee spelers zijn telt 10 seconden af (met één speler blijft het wachten). Bewegen en
   schieten mag, maar er is geen schade. Daarna begint de wedstrijd en spawnt iedereen opnieuw.
2. **Live:** tot de scorelimiet of de tijdlimiet. Bij gelijke stand is het gelijkspel.
3. **Ended:** 12 seconden resultaat, daarna begint de volgende wedstrijd: scores op nul, teams
   herbalanceerd, iedereen spawnt opnieuw.

**Spelers en wapens (server-authoritative):**

- Health 100, na 5 seconden zonder schade komt er 25 per seconde bij. Dood = 3 seconden respawn, 2 seconden
  bescherming na elke spawn. Nieuwe spelers komen bij het kleinste team (tdm; bij gelijke grootte bij het team dat
  achterstaat) en spawnen direct, ook in een lopende match. Als er spelers vertrekken en de teams twee of meer
  verschillen, wisselt de laatst gejoinde speler van het grotere team bij zijn volgende respawn van team
  (systeembericht in de chat: "X moved to the red team to even the teams"); nooit midden in een leven.
- Spawnpunten: tdm in de eigen basis, het punt het verst van levende tegenstanders; ffa het punt het verst van
  alle anderen.
- Wapens (`src/modes/Weapons.ts`): rifle, smg, shotgun en sniper als primair, pistool en mes altijd. De keuze
  (`loadout`) geldt vanaf de volgende spawn. De server houdt per slot het magazijn bij, begrenst het vuurtempo
  (`rpm`), de herlaadtijd en de wisselvertraging (0,25 s).
- Schot: de server controleert dat de oorsprong dicht bij het oog staat (anders gebruikt hij zijn eigen oog),
  rolt de kogels binnen de spreiding (kleiner bij `ads`), volgt de straal door de blokken (muren en glas
  stoppen hem) en toetst hem aan de hitbox van levende spelers (0,6 × 1,8; de bovenste 0,4 is het hoofd).
  Schade volgt de afstand (`damageAt`) × headshot-factor. Geen friendly fire in tdm.
- Lag compensation: de server bewaart 1 seconde positiegeschiedenis per speler en toetst tegenstanders op de
  positie van `ping + 0,1 s` geleden (maximaal 0,35 s). Ping komt uit WebSocket-ping/pong, elke 3 seconden;
  de client hoeft daar niets voor te doen.
- Geen bouwen of breken (`block` wordt teruggedraaid), geen mobs, items, TNT of valschade; het is altijd middag.
  De snelheidslimiet is hoger (40 blokken per seconde incl. marge).

Kosten: met 16 gesimuleerde spelers die continu op elkaar schieten kost een tick gemiddeld 0,05 ms
(`npx tsx scripts/bench-arena.ts`), plus ongeveer 0,1 ms voor de berichten van alle spelers in dat tick; samen
minder dan 0,5 % van het budget van 50 ms. Uitgaand verkeer: ~20 KiB/s per speler.

**Testen met bots:** `ROOM_CREATE_LIMIT=1000 npm run server` in de ene terminal, en in de andere
`npx tsx scripts/arena-bots.ts tdm` (of `ffa`; optioneel een kaart en een serveradres erachter, bijvoorbeeld
`npx tsx scripts/arena-bots.ts tdm dockyard http://localhost:3000`). Het script maakt een
game aan, laat twee bots over WebSocket joinen, wacht op `live`, laat de ene bot de andere doodschieten en
controleert alle berichten, inclusief de kaart in `welcome` en het terugvallen op `classic` bij een onbekende `mapId`.
Duurt zo'n 25 seconden. Hulpscripts voor kaarten: `scripts/ascii-map.ts` (bovenaanzicht in tekst), `scripts/spawn-los.ts`
(zien spawns elkaar?), `scripts/bench-maps.ts` (generatietijd per chunk, rond 0,1 ms) en `scripts/shots.py` (screenshots via
Playwright en de dev-preview).

## Bekende beperkingen

Beveiliging (dreigingsmodel, bevindingen, hardening-checklist voor een domein): zie [SECURITY.md](SECURITY.md).

- **Geen PvP in Minecraft-games:** pijlen en explosies raken wel mobs en de speler die in de buurt is. PvP bestaat alleen in de arcade-speltypes.
- **Arcade-games vertrouwen de positie van de client** (alleen snelheid en arena-grenzen worden gecontroleerd): er is geen botsingscontrole tegen de blokken en geen server-side beweging.
- **Health en honger worden door de client opgegeven.** De inventory wordt in survival gecontroleerd, met de grenzen die onder *Server-authoritative inventory* staan. Gebruik voor een publieke server wachtwoorden of de whitelist.
- **Items:** blokdrops, Q en doodsdrops gaan via de server en zijn voor iedereen zichtbaar; wie het eerst bij een item komt, krijgt het.
- **Geen accounts, wel gebonden namen:** een naam hoort bij de browser die hem het eerst gebruikte (zie *Wachtwoorden, privacy en namen*); er is geen herstel als je je browserdata wist. Een game is toegankelijk met de code (zes tekens uit 31, met een limiet op het aantal pogingen per bezoeker) en eventueel een wachtwoord. De whitelist werkt op naam: iemand kan een naam claimen die nog nooit gebruikt is, dus combineer hem met een wachtwoord als dat telt.
- **Ban op adres** raakt iedereen achter hetzelfde IP (huishouden, school). Bans op naam helpen weinig tegen iemand die een andere naam kiest; gebruik daarvoor een wachtwoord of de whitelist.
- **Weer** loopt op de server (regen, onweer, bliksem) en `/weather` werkt voor operators; arcade-games zijn altijd helder.
- **Aanmaken is beperkt:** zes games per uur per bezoeker en `MAX_ROOMS` in totaal, zodat een publieke server niet volloopt.
- **Advancements** staan uit in multiplayer.

## Ontwikkelen

```bash
npm run server     # gameserver op :3000 (herstart bij wijzigingen)
npm run dev        # Vite op :5173, stuurt /ws door naar :3000
```
