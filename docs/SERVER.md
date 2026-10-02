# BunkCraft server draaien

Eén Node.js-proces serveert de game (de gebouwde `dist/`) **en** de multiplayer-server
(WebSocket op `/ws`) op dezelfde poort. Je hoeft dus maar één ding te hosten.

```
Browser ──HTTP──▶  /            → dist/ (de game)
        ──HTTP──▶  /api/rooms   → een game aanmaken (POST) of opzoeken (GET /api/rooms/<CODE>)
        ──WS────▶  /ws          → hoofdwereld
        ──WS────▶  /ws/<CODE>   → een game van een speler
        ──HTTP──▶  /health      → {"ok":true,"players":2,"rooms":3}
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

- **Create Game:** kies een naam, spelmodus en eventueel een seed. Je krijgt een code van zes tekens
  (bijvoorbeeld `K7Q-M2X`) en een uitnodigingslink (`https://jouwdomein/?join=K7QM2X`).
  Ook later in het spel: **Esc → Invite Friends**.
- **Join Game:** een vriend opent de link (naam invullen, klaar) of typt de code of plakt de link in het
  codeveld. Recente games staan als knop in het menu.
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

Voorbeeld: `SEED=bunk GAMEMODE=creative WORLD_NAME="Bouwserver" npm start`

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
- **Commando's in de chat:** `/help`, `/list`, `/seed`, `/spawn`, `/time set day|noon|night|midnight`.

## Mobs, items en TNT op de server

De server draait dezelfde mob-AI als singleplayer (varken, koe, schaap, kip, zombie, creeper, skeleton, spin),
met terrein uit de seed plus de edits van de spelers, geladen rond de spelers. Elke mob volgt de dichtstbijzijnde
speler; 's nachts spawnen vijanden rond iedereen. Spelers sturen alleen verzoeken (aanvallen, schieten, TNT
aansteken, item pakken of droppen), de server controleert bereik, wat je vasthoudt en de snelheid, en
stuurt 10 keer per seconde de entiteiten om je heen terug. Schade komt als bericht naar de speler; explosies
sturen de verwijderde blokken mee. Een lege game geeft zijn geheugen vrij.

Kosten: ongeveer 0,03 ms CPU per tick in rust en ~0,3 ms terwijl chunks genereren, plus een paar MB per
geladen game.

## Speltypes: Minecraft, Team Deathmatch en Free For All

Een game heeft een speltype. **Minecraft** (standaard) is de sandbox hierboven. De twee arcade-types zijn
rondes op één vaste arena, in de geest van Krunker: snelle beweging, hitscan-wapens, health die terugkomt
en een scorebord.

| Speltype | `gameType` | Wat |
|---|---|---|
| Minecraft | `minecraft` | Bouwen, mijnen, mobs, spelmodus naar keuze |
| Team Deathmatch | `tdm` | Rood tegen blauw; het team met de meeste kills wint |
| Free For All | `ffa` | Ieder voor zich; wie de scorelimiet haalt (of aan het eind de meeste kills heeft) wint |

Een game aanmaken (`POST /api/rooms`) accepteert `{ name, gameMode, seed, gameType?, scoreLimit?, timeLimitSec?, mapId? }`:

| Veld | Standaard (tdm / ffa) | Grenzen |
|---|---|---|
| `gameType` | `minecraft` | `minecraft`, `tdm`, `ffa` (onbekend = `minecraft`) |
| `scoreLimit` | 30 / 20 | 5 tot 100 (kills van het team in tdm, kills van de speler in ffa) |
| `timeLimitSec` | 600 / 600 | 120 tot 1800 seconden |
| `mapId` | `classic` | `classic`, `suburb`, `quarter`, `dockyard`, `desert` of `rotate` (onbekend = `classic`) |

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

De instelling `rotate` speelt elke volgende match op de volgende kaart (in de volgorde hierboven). Bij een nieuwe
kaart vervangt de server zijn kogelwereld en stuurt hij `match` met `info.map`; de client ziet dat dit niet zijn kaart
is en **voegt zich opnieuw bij de game** (nieuw `welcome`, nieuwe wereld). De kaart reist als `worldType`
`arena:<mapId>` (`arena` = classic) door de workers en `ServerWorld`; in het protocol staat hij als optionele
`MatchInfo.map` (zonder protocolversie te verhogen: oude clients negeren het veld).

Alleen bestaande blokken, op een vlakke vloer. De server houdt spelers binnen de muur van de gekozen kaart.

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
- **Inventory en health worden door de client opgegeven:** valsspelen met de inventory is mogelijk. Plaats de server daarom niet publiek zonder vertrouwde spelers, of voeg wachtwoorden en whitelisting toe (roadmap).
- **Items:** blokdrops, Q en doodsdrops gaan via de server en zijn voor iedereen zichtbaar; wie het eerst bij een item komt, krijgt het.
- **Geen accounts:** spelersnamen zijn niet beveiligd. Wie dezelfde naam gebruikt in dezelfde game, neemt die speler over. Een game is alleen toegankelijk met de code (zes tekens uit 31, met een limiet op het aantal pogingen per bezoeker), dus deel hem alleen met vrienden.
- **Aanmaken is beperkt:** zes games per uur per bezoeker en `MAX_ROOMS` in totaal, zodat een publieke server niet volloopt.
- **Advancements** staan uit in multiplayer.

## Ontwikkelen

```bash
npm run server     # gameserver op :3000 (herstart bij wijzigingen)
npm run dev        # Vite op :5173, stuurt /ws door naar :3000
```
