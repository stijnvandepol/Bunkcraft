# BunkCraft server draaien

Eén Node.js-proces serveert de game (de gebouwde `dist/`) **en** de multiplayer-server
(WebSocket op `/ws`) op dezelfde poort. Je hoeft dus maar één ding te hosten.

```
Browser ──HTTP──▶  /            → dist/ (de game)
        ──WS────▶  /ws          → GameServer (gedeelde wereld, spelers, chat)
        ──HTTP──▶  /health      → {"ok":true,"players":2}
```

## Snel starten

Vereist Node.js 20 of nieuwer.

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

Open de site, kies **Multiplayer** en vul een naam in. Het serveradres staat standaard op de
server waar de pagina vandaan komt.

## Configuratie (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3000` | HTTP- en WebSocket-poort |
| `DATA_DIR` | `./data` | Map voor `world.json` (wereld, wijzigingen, spelers, tijd) |
| `WORLD_NAME` | `BunkCraft Server` | Naam van de wereld |
| `SEED` | willekeurig | Seed: een getal of tekst. Geldt alleen bij een nieuwe wereld. |
| `GAMEMODE` | `survival` | `survival`, `creative`, `hardcore` of `spectator` |
| `MOTD` | `Welcome to BunkCraft!` | Bericht bij het inloggen |
| `MAX_PLAYERS` | `20` | Maximum aantal spelers |

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

- **Geen mobs:** multiplayer-werelden zijn vredig. Gedeelde mobs moeten door de server gesimuleerd worden; dat staat op de roadmap.
- **Drops zijn lokaal:** dropped items zie je alleen zelf.
- **Inventory en health worden door de client opgegeven:** valsspelen met de inventory is mogelijk. Plaats de server daarom niet publiek zonder vertrouwde spelers, of voeg wachtwoorden en whitelisting toe (roadmap).
- **Geen accounts:** spelersnamen zijn niet beveiligd. Wie dezelfde naam gebruikt, neemt die speler over.

## Ontwikkelen

```bash
npm run server     # gameserver op :3000 (herstart bij wijzigingen)
npm run dev        # Vite op :5173, stuurt /ws door naar :3000
```
