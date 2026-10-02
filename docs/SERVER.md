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

## Bekende beperkingen (v1)

- **Geen mobs of TNT:** multiplayer-werelden zijn vredig en explosies worden nog niet gesynchroniseerd. Gedeelde mobs moeten door de server gesimuleerd worden; dat staat op de roadmap.
- **Drops zijn lokaal:** dropped items zie je alleen zelf.
- **Inventory en health worden door de client opgegeven:** valsspelen met de inventory is mogelijk. Plaats de server daarom niet publiek zonder vertrouwde spelers, of voeg wachtwoorden en whitelisting toe (roadmap).
- **Geen accounts:** spelersnamen zijn niet beveiligd. Wie dezelfde naam gebruikt in dezelfde game, neemt die speler over. Een game is alleen toegankelijk met de code (zes tekens uit 31, met een limiet op het aantal pogingen per bezoeker), dus deel hem alleen met vrienden.
- **Aanmaken is beperkt:** zes games per uur per bezoeker en `MAX_ROOMS` in totaal, zodat een publieke server niet volloopt.

## Ontwikkelen

```bash
npm run server     # gameserver op :3000 (herstart bij wijzigingen)
npm run dev        # Vite op :5173, stuurt /ws door naar :3000
```
