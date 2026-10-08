# BunkCraft server draaien

## Op je eigen Linux-server in 5 minuten

Nodig: een Ubuntu- of Debian-server (vanaf 1 vCPU / 1 GB; aanbevolen 2 vCPU / 2-4 GB, zie hieronder) en een
domein met een A-record (en eventueel AAAA) naar die server.

```bash
curl -fsSL https://raw.githubusercontent.com/stijnvandepol/Bunkcraft/main/scripts/install.sh \
  | sudo bash -s -- --domain play.example.com
```

Of vanuit een clone: `sudo ./scripts/install.sh --domain play.example.com [--admin-token GEHEIM]`.
Het script installeert wat ontbreekt (Docker Engine + compose uit de officiële apt-repository, git), zet de code in
`/opt/bunkcraft`, schrijft `.env` (domein, gegenereerde `ADMIN_TOKEN` en `METRICS_TOKEN`, CPU- en geheugenlimieten
passend bij de machine), opent poort 80/443 in `ufw` als die actief is, haalt de kant-en-klare image op, start de game
achter Caddy (automatisch HTTPS, HTTP/3) en zet een dagelijkse back-up en [automatische updates](#automatisch-deployen) klaar.
Opnieuw draaien is veilig: bestaande instellingen en werelden blijven staan. `--dry-run` laat zien wat het zou doen.
Zonder Caddy (eigen proxy, Cloudflare Tunnel): [Achter een Cloudflare Tunnel](#achter-een-cloudflare-tunnel).

**De image komt kant-en-klaar van GHCR** (`ghcr.io/stijnvandepol/bunkcraft`, amd64 en arm64, gebouwd door CI na elke
groene push naar `main`). Op de server wordt niets gebouwd: installeren en updaten kost seconden en een VPS met 1 GB
heeft geen swap nodig. De versie kies je met `BUNKCRAFT_TAG` in `.env` (of `--tag` bij install/update):

| `BUNKCRAFT_TAG` | Wat |
|---|---|
| `latest` (standaard) | nieuwste versie van `main` (elke groene push) |
| `stable` | nieuwste release (git-tag `v1.2.3`; pre-releases zoals `v1.3.0-rc.1` tellen niet) |
| `sha-1a2b3c4` | één bepaalde commit |
| `1.2.0`, `1.2`, `1` | een release (git-tag `v1.2.0`) |
| `latest@sha256:…` | precies één build, vastgepind op digest (staat in de samenvatting van de CI-run) |

Zelf bouwen kan nog: `sudo ./scripts/install.sh --build …` of later `bunkcraft update --build`. Dat zet
`COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml` in `.env` (alle `docker compose`-commando's bouwen dan) en maakt
op machines met minder dan 2 GB een swapfile. `bunkcraft update --pull` gaat terug naar de kant-en-klare image.

Daarna open je `https://play.example.com`. Beheer gaat met één commando:

| Commando | Wat |
|---|---|
| `bunkcraft status` | containers, draaiende image (id/digest) en `/health` (spelers, games, tick p99, geheugen) |
| `bunkcraft logs` | serverlog volgen |
| `bunkcraft update` | `git pull`, nieuwe image ophalen terwijl de oude draait, back-up, herstart (werelden worden eerst opgeslagen), wachten tot hij gezond is en de smoketest haalt. **Niet gezond binnen 2 minuten of smoketest mislukt: automatisch terug naar de vorige image en commit.** Opties: `--tag`, `--build`, `--pull`, `--force`, `--dry-run` |
| `bunkcraft autoupdate on\|off\|status` | automatische updates aan/uit, of: instelling, timer, wacht er een update, deploylog |
| `bunkcraft deploy` | nu de auto-update-flow draaien (ook als `AUTOUPDATE=off`); dit draait een push-deploy vanuit GitHub |
| `bunkcraft rollback` | terug naar de image van vóór de laatste update (nog een keer: weer vooruit) |
| `bunkcraft backup` | back-up nu, naar `/var/backups/bunkcraft` (de dagelijkse timer bewaart er 14) |
| `bunkcraft restart` | herstart na een wijziging in `/opt/bunkcraft/.env` |

**Firewall:** het script opent 80/tcp, 443/tcp en 443/udp alleen in een *actieve* `ufw`. Zet je hem zelf aan, sta dan eerst
SSH toe: `ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable`. Let op: Docker
publiceert poorten langs ufw heen; een firewall van je cloudprovider ervoor is de strengere optie.

**Welke server?** Gemeten met bots (docs/research/SERVER-DEPLOY.md): één survival-game met 8 spelers en ~40 mobs kost
~4-5 % van één core en ~14 KiB/s per speler; een arcade-game met 12 spelers ~4 %. Het servergeheugen groeit van ~70 MB leeg
naar ~375 MB bij 160 spelers.

| VPS | Prijs (indicatie) | Verwachte capaciteit |
|---|---|---|
| 1 vCPU / 1 GB (kleinste VPS bij de meeste aanbieders) | ~€2-5/mnd | ~40-60 survival-spelers (5-8 games), arcade ~100 |
| **2 vCPU / 4 GB (Hetzner CAX11 ARM of CX22)** — aanbevolen | ~€4-5/mnd | ~120-150 survival-spelers (arcade 200+) |
| 4 vCPU / 8 GB | ~€8-15/mnd | ~150-200: de gamelogica van één Node-proces draait op één core (terrein al op aparte threads, `CHUNK_WORKERS`); meer pas met meerdere processen |

**Zonder Docker** (systemd): zie [Zonder Docker](#zonder-docker-systemd).

### Back-up terugzetten

```bash
cd /opt/bunkcraft
docker compose stop bunkcraft
docker compose run --rm --no-deps -T --entrypoint sh bunkcraft \
  -c 'rm -rf /app/data/* && tar -xzf - -C /app' < /var/backups/bunkcraft/bunkcraft-JJJJMMDD-UUMMSS.tar.gz
docker compose up -d
```

### Automatisch deployen

Twee manieren, ze werken naast elkaar. **Pull** staat aan na `install.sh` en heeft geen servergegevens in GitHub nodig.
**Push** is optioneel: GitHub zet de update direct na de build via SSH door, met een sleutel die alleen dat kan.

**Pull: de server haalt zelf (standaard).** Een systemd-timer draait elke 5 minuten `bunkcraft autoupdate`:

1. Is er iets nieuws? Eén klein verzoek aan de registry (digest van het kanaal-tag, er wordt niets gedownload) en vergelijk
   met de draaiende image. Een tag op digest (`latest@sha256:…`) of `sha-1a2b3c4` verandert nooit, dus die blijft staan.
2. Wachten op een rustig moment: niemand in een Minecraft-wereld en geen lopende match (`playersInPlay` in `/health`),
   hooguit `AUTOUPDATE_MAX_WAIT_MIN` minuten. Daarna toch, met een chatmelding aan iedereen 60 s vooraf.
3. Alle werelden opslaan, dan `bunkcraft update`: back-up, pull, herstart, health check en smoketest (gamepagina, script,
   API, een testgame aanmaken en weer verwijderen). **Mislukt iets: automatisch terug** naar de vorige versie. Een build die
   is teruggedraaid probeert hij niet opnieuw; de volgende nieuwe build wel.

Er draait nooit meer dan één update tegelijk (lock gedeeld met `bunkcraft update`). Spelers krijgen bij de herstart een
reconnect en zijn binnen seconden terug.

| `.env` | Standaard | Wat |
|---|---|---|
| `AUTOUPDATE` | `on` | `off`: geen automatische updates (`bunkcraft autoupdate off`, of `install.sh --no-autoupdate`) |
| `AUTOUPDATE_INTERVAL` | `5min` | hoe vaak kijken (`5min`, `15m`, `1h`); na wijzigen: `bunkcraft autoupdate on` |
| `AUTOUPDATE_WAIT_FOR_EMPTY` | `1` | `0`: niet wachten op een rustig moment (de 60 s-waarschuwing blijft) |
| `AUTOUPDATE_MAX_WAIT_MIN` | `30` | zo lang hooguit wachten op een rustig moment |
| `AUTOUPDATE_WARN_SEC` | `60` | zoveel seconden vooraf waarschuwen als er toch gespeeld wordt |
| `DEPLOY_WEBHOOK_URL` | leeg | Discord- of Slack-webhook: bericht bij elke update, rollback of fout |

De waarschuwing en het opslaan gaan via de admin-API, dus zonder `ADMIN_TOKEN` (install.sh zet er een) slaat hij die over;
de server slaat bij afsluiten toch alles op. Logs: `journalctl -u bunkcraft-autoupdate` en één regel per deploy in
`/var/log/bunkcraft-deploy.log` (`bunkcraft autoupdate status` toont de laatste).

**Kanalen en releasen.** `BUNKCRAFT_TAG=latest` volgt elke groene push naar `main`; `stable` alleen releases. Een release:

```bash
git tag v1.0.0 && git push origin v1.0.0     # of: git push --tags
```

CI draait alle checks en publiceert dan `1.0.0`, `1.0`, `1` en `stable`. Een pre-release (`v1.1.0-rc.1`) krijgt alleen zijn
eigen tag. Een server overzetten: `bunkcraft update --tag stable` (of terug: `--tag latest`).

**Welke versie draait er?** `https://<domein>/health` (`"version":"1.0.0+1a2b3c4"`), links onder in het titelscherm
(`BunkCraft 1.0 (1a2b3c4)`) en `bunkcraft status`. De commit hoort bij `https://github.com/stijnvandepol/Bunkcraft/commit/1a2b3c4`.

**Terugdraaien.** Gaat vanzelf als de nieuwe versie niet gezond is. Met de hand: `bunkcraft rollback` (vorige image; nog een
keer = weer vooruit). Een bepaalde versie vasthouden: `bunkcraft update --tag sha-1a2b3c4` of `--tag 1.0.0` (auto-update
volgt dan die tag, die niet meer verandert); terug naar het kanaal met `--tag latest` of `--tag stable`. Data terugzetten:
[Back-up terugzetten](#back-up-terugzetten).

**Push: GitHub deployt direct (optioneel).** De CI-job `deploy` draait na een gepubliceerde image en doet
`ssh <server> deploy`. Op de server mag die sleutel alleen `bunkcraft deploy` draaien (forced command, geen shell, geen
port forwarding), als een eigen gebruiker zonder Docker-rechten die via sudo precies dat ene commando mag.

1. Sleutel maken (op je laptop): `ssh-keygen -t ed25519 -N '' -f bunkcraft-deploy -C github-actions`.
2. Op de server (vervang de sleutel door de inhoud van `bunkcraft-deploy.pub`):

   ```bash
   sudo useradd --system --create-home --shell /bin/sh bunkcraft-deploy
   sudo install -d -m 700 -o bunkcraft-deploy -g bunkcraft-deploy /home/bunkcraft-deploy/.ssh
   echo 'command="sudo -n /usr/local/bin/bunkcraft deploy",restrict ssh-ed25519 AAAA... github-actions' \
     | sudo tee /home/bunkcraft-deploy/.ssh/authorized_keys >/dev/null
   sudo chown bunkcraft-deploy: /home/bunkcraft-deploy/.ssh/authorized_keys
   sudo chmod 600 /home/bunkcraft-deploy/.ssh/authorized_keys
   echo 'bunkcraft-deploy ALL=(root) NOPASSWD: /usr/local/bin/bunkcraft deploy' | sudo tee /etc/sudoers.d/bunkcraft-deploy >/dev/null
   sudo chmod 440 /etc/sudoers.d/bunkcraft-deploy && sudo visudo -cf /etc/sudoers.d/bunkcraft-deploy
   ```

   Staat SSH alleen voor bepaalde gebruikers open (`AllowUsers` in `sshd_config`), voeg `bunkcraft-deploy` toe.
3. Host key vastleggen: `ssh-keyscan -t ed25519 play.example.com` op je laptop; controleer de vingerafdruk tegen
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` op de server.
4. GitHub, repository → **Settings → Environments → New environment** `production`. Optioneel: **Required reviewers**
   (jezelf: elke deploy wacht op een klik) en **Deployment branches and tags** → *Selected*: `main` en `v*`.
   Onder **Environment secrets**: `DEPLOY_HOST` (`play.example.com`), `DEPLOY_USER` (`bunkcraft-deploy`), `DEPLOY_SSH_KEY`
   (de inhoud van het private bestand `bunkcraft-deploy`) en `DEPLOY_KNOWN_HOSTS` (de regel uit stap 3). Gooi daarna de
   lokale private key weg.
5. **Settings → Secrets and variables → Actions → Variables**: `DEPLOY_ENABLED` = `true` (en `DEPLOY_PORT` als SSH niet op
   22 luistert). Zonder die variabele slaat CI de job over; zonder secrets meldt de job dat en stopt hij netjes.

`bunkcraft deploy` volgt het kanaal van de server: een push naar `main` doet niets op een server met `BUNKCRAFT_TAG=stable`,
een release wel. Laat `AUTOUPDATE` gerust aan: de timer is dan het vangnet als een push-deploy mislukt (lock voorkomt
dubbel werk). Alleen push: `bunkcraft autoupdate off`, `bunkcraft deploy` blijft werken.

### Achter een Cloudflare Tunnel

Draait `cloudflared` al ergens (op deze machine of een andere) en wil je geen Caddy, geen poort 80/443 en geen DNS-check?
Dan start `--proxy none` alleen de game-server en publiceert die op één poort. Updates blijven automatisch: de standaard
is kanaal `latest` (= elke groene push naar `main`) met `AUTOUPDATE=on`.

Vanuit een bestaande clone (met `--domain` gaat alleen `ALLOWED_ORIGINS=https://play.example.com` in `.env`; het domein is
optioneel):

```bash
sudo ./scripts/install.sh --proxy none --domain play.example.com            # cloudflared draait op deze machine
sudo ./scripts/install.sh --proxy none --domain play.example.com --bind 0.0.0.0 --trust-from 192.168.1.20   # cloudflared draait elders (op dat IP)
```

`--port 3000` verandert de poort op de host (standaard 3000). De keuze (`PROXY`, `BIND_ADDR`, `BUNKCRAFT_PORT`) blijft in
`.env`, dus `bunkcraft update`, `rollback`, `restart` en de autoupdate-timer werken zonder extra opties. Opnieuw draaien met
`--proxy caddy --domain …` gaat terug naar Caddy (en andersom wordt de Caddy-container verwijderd).

**Tunnel instellen** (Cloudflare Zero Trust → Networks → Tunnels → je tunnel → *Public Hostname* → *Add*; het script print
dit ook):

| Veld | Waarde |
|---|---|
| Hostname | `play.example.com` |
| Service | `HTTP` met URL `127.0.0.1:3000` (cloudflared op dezelfde machine, `--bind 127.0.0.1`) of `<ip van deze server>:3000` (`--bind 0.0.0.0`) |

WebSockets (`/ws`) werken door een tunnel zonder extra instelling. Cloudflare regelt HTTPS; HSTS zet je in het dashboard
(SSL/TLS → Edge Certificates), want de Caddyfile doet dat in deze modus niet.

**Bezoekers-IP.** `--proxy none` zet `TRUST_PROXY=0` en, als de server weet wie de tunnel is, `TRUST_CLOUDFLARE=1` met
`TRUSTED_PROXY_ADDRS` in `.env`. De limieten per bezoeker gebruiken dan de `CF-Connecting-IP`-header, maar **alleen** op
verbindingen vanaf die adressen; van ieder ander wordt de header genegeerd (anders kan iedereen die de poort bereikt zijn eigen
IP kiezen). Met `--bind 127.0.0.1` vertrouwt hij automatisch deze machine en de Docker-netwerken. Met `--bind 0.0.0.0` geef je
het IP van de cloudflared-machine op met `--trust-from` (meerdere adressen of IPv4-CIDR's met komma's); zonder die optie wordt de
header niet vertrouwd en waarschuwt het script. Beperk de poort daarnaast tot de cloudflared-machine via de firewall van je
cloudprovider of `iptables` in de `DOCKER-USER`-chain (Docker publiceert poorten langs `ufw` heen).

**Controleren of autoupdate draait:**

```bash
bunkcraft autoupdate status   # instelling, timer (volgende run), of er een nieuwe build klaarstaat, laatste deploylog
bunkcraft status              # image, /health, en op welk adres de game is gepubliceerd
curl http://127.0.0.1:3000/health
```

Een nieuwe `latest` komt binnen ≤ 5 minuten (`AUTOUPDATE_INTERVAL`) binnen: back-up, herstart, health check en smoketest, en bij
een fout automatisch terug. Zelf terugdraaien: `bunkcraft rollback`. Bestaande Caddy-installs veranderen niet: de eerste
`bunkcraft update` na deze wijziging zet `PROXY=caddy` en `COMPOSE_PROFILES=caddy` in `.env` (Caddy is nu een compose-profiel;
zonder die regel start `docker compose up -d` alleen de game).

## Overzicht

Eén Node.js-proces serveert de game (de gebouwde `dist/`) **en** de multiplayer-server
(WebSocket op `/ws`) op dezelfde poort. Je hoeft dus maar één ding te hosten.

```
Browser ──HTTP──▶  /            → dist/ (de game)
        ──HTTP──▶  /api/rooms   → een game aanmaken (POST), opzoeken (GET /api/rooms/<CODE>) of de serverlijst (GET /api/rooms?public=1)
        ──WS────▶  /ws          → hoofdwereld
        ──WS────▶  /ws/<CODE>   → een game van een speler
        ──HTTP──▶  /health      → {"ok":true,"version":"1.0.0","uptime":3600,"players":2,"rooms":3,"roomsLoaded":1,"tickP99Ms":2.1,"loopLagP99Ms":1.4,"rssMB":96}
        ──HTTP──▶  /metrics     → Prometheus (alleen lokaal of met token)
        ──HTTP──▶  /admin       → beheerpagina (alleen met ADMIN_TOKEN), API op /api/admin/*
```

## Snel starten

Vereist Node.js 22 of nieuwer.

```bash
npm install
npm run build      # dist/ (de game) + dist-server/index.js (de server als één JS-bestand)
npm start          # node dist-server/index.js → http://localhost:3000
```

`npm run server` (tsx watch) blijft de ontwikkelversie: TypeScript direct, herstart bij elke wijziging.

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
DOMAIN=play.example.com COMPOSE_PROFILES=caddy docker compose up -d   # Caddy is het compose-profiel "caddy"
```

Open daarna `https://play.example.com`. De wereld staat in het volume `bunkcraft-data` en overleeft
herstarts en updates (`./scripts/update.sh`, of met de hand `git pull && docker compose up -d --build`). Instellingen zet je in een `.env`
naast `docker-compose.yml`, bijvoorbeeld `ROOM_MAX_PLAYERS=12`.

Heb je al een reverse proxy? Zie de voorbeelden verderop; zet dan `TRUST_PROXY=1`, zodat de
limieten per bezoeker werken in plaats van per proxy.

## Configuratie (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3000` | HTTP- en WebSocket-poort |
| `HOST` | alle interfaces | Luisteradres; `127.0.0.1` als de reverse proxy op dezelfde machine draait (systemd) |
| `DATA_DIR` | `./data` | Map voor `world.json` (wereld, wijzigingen, spelers, tijd) |
| `WORLD_NAME` | `BunkCraft Server` | Naam van de wereld |
| `SEED` | willekeurig | Seed: een getal of tekst. Geldt alleen bij een nieuwe wereld. |
| `GAMEMODE` | `survival` | `survival`, `creative`, `hardcore` of `spectator` |
| `MOTD` | `Welcome to BunkCraft!` | Bericht bij het inloggen |
| `MAX_PLAYERS` | `20` | Maximum aantal spelers in de hoofdwereld |
| `TRUST_PROXY` | `0` | `1` achter een reverse proxy: gebruik `X-Forwarded-For` voor de limieten per bezoeker |
| `TRUST_CLOUDFLARE` | `0` | `1` achter een Cloudflare Tunnel: gebruik de `CF-Connecting-IP`-header voor de limieten per bezoeker (gaat voor op `X-Forwarded-For`). Alleen aanzetten als de server uitsluitend via Cloudflare bereikbaar is: anders kan iedereen die de poort direct bereikt de header zelf meesturen. Zonder deze optie wordt de header genegeerd. `install.sh --proxy none` zet hem aan. |
| `MAIN_WORLD` | `on` | De hoofdwereld op `/ws` (knop *Join Public Server*) |
| `ROOMS` | `on` | Spelers kunnen zelf games aanmaken (`off` = alleen de hoofdwereld) |
| `MAX_ROOMS` | `200` | Maximum aantal games op de server |
| `ROOM_MAX_PLAYERS` | `12` | Spelers per game |
| `ROOM_CREATE_LIMIT` | `6` | Games die één bezoeker per uur mag aanmaken |
| `ROOM_EXPIRE_DAYS` | `60` | Games zonder bezoek worden na zoveel dagen verwijderd (`0` = nooit) |
| `PROFILES` | `on` | Realms-voortgang: profielen, XP, levels en ontgrendelingen (`off` = geen XP, alles vrij) |
| `MAX_PROFILES` | `50000` | Maximum aantal profielen in `DATA_DIR/profiles/`; daarna maakt de server geen nieuwe meer aan |
| `PROFILE_CREATE_LIMIT` | `10` | Nieuwe profielen per bezoeker per uur |
| `PROFILE_SECRET` | niet gezet | HMAC-geheim voor profieltokens (minstens 16 tekens). Leeg = een willekeurig geheim in `DATA_DIR/profiles/secret.key` (mode 0600). Zet het als meerdere servers dezelfde profielen delen. |
| `ROOM_IDLE_UNLOAD_MIN` | `5` | Minuten dat een lege game in het geheugen blijft voordat hij wordt opgeslagen en uitgeladen |
| `CHUNK_WORKERS` | `min(2, cores − 1)` | Threads die nieuw terrein genereren voor alle survival-games samen, zodat verkennende spelers de ticks niet ophouden. `0` = op de main thread (het oude pad, ook de standaard met één core). Cores = die van de machine, of minder als Docker een CPU-limiet zet (`BUNKCRAFT_CPUS`). Elke thread kost ~20-25 MB RSS. Meer dan 2 helpt pas bij honderden verkennende spelers. |
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
| `QUICKPLAY_BOTS` | `8` | Nieuwe Snel spelen-lobby's vullen met server-bots tot zoveel spelers; bots maken plaats voor wie erbij komt (`0` = geen bots). Zie GAMEMODES.md §Bots. |
| `QUICKPLAY_BOT_DIFFICULTY` | `normal` | Niveau van die bots: `easy`, `normal`, `hard` of `veteran` |
| `BOT_PREWARM` | `on` | Bouwt bij het opstarten op de achtergrond de navigatiegrafen van alle kaarten (~1 s CPU, ~20 MB), zodat een lobby nooit midden in een potje hapert |
| `BACKUP_KEEP` | `12` | Aantal back-ups per wereld (`0` = geen back-ups) |
| `BACKUP_INTERVAL_MIN` | `60` | Minuten tussen back-ups |
| `RECONNECT_HINT_MS` | `8000` | Bij afsluiten (SIGTERM) krijgen spelers de hint om zoveel milliseconden later opnieuw te verbinden |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` of `error` |
| `SLOW_TICK_MS` | `20` | Een game-tick die langer duurt telt als traag (`bunkcraft_slow_ticks_total`) en komt, hooguit één keer per 10 s per game, als `slow tick` in de log met wandkloktijd, CPU-tijd en de tijd per fase. |
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

## Realms-profielen (XP en levels zonder accounts)

Realms houdt per speler een profiel bij: level 1-55 met 10 prestiges, statistieken, wapen-XP met camo's, dagelijkse en
wekelijkse uitdagingen en de gekozen titel en visitekaartjes. Er zijn geen accounts: de server geeft een browser één keer
een **ondertekend profieltoken** (`v1.<id>.<hmac>`, HMAC-SHA256 met `PROFILE_SECRET` of `profiles/secret.key`), de
browser bewaart het in `localStorage` per serverhost (`bunkcraft.profile.<host>`), net als de owner-tokens van games.

- **API** (token in de `Authorization: Bearer`-header, nooit in een URL):
  `POST /api/profile` (`{name}`; het profiel van het token, of een nieuw profiel + token met `201`),
  `GET /api/profile`, `POST /api/profile/equip` (`{title?, card?, camos?}`; alleen wat ontgrendeld is, anders `409`),
  `POST /api/profile/prestige` (alleen op level 55). Limieten: 60 verzoeken per minuut en `PROFILE_CREATE_LIMIT` nieuwe
  profielen per uur per adres. `GET /api/server` meldt `features.profiles`.
- **XP is server-authoritative.** Er bestaat geen bericht waarmee een client XP kan geven. De client stuurt het token mee
  in `hello` (`profile`); de server telt tijdens een live match kills, assists, headshots, treffers, vlaggen en zones
  (`server/progression/MatchRecorder.ts`) en geeft de XP precies één keer: bij het einde van de match, of bij vertrek
  halverwege (zonder voltooiings- en winstbonus). Daarna krijgt de speler een `progress`-bericht met de opbouw.
  Bots en gasten zonder profiel krijgen niets. Een vals of aangepast token wordt genegeerd (geen profiel, geen XP).
- **Tegen farmen:** maximaal 6000 XP per match (uitdagingen komen erbovenop), kills op hetzelfde slachtoffer leveren na
  6 keer nog 25 XP op, voltooiings- en winstbonus pas na 45 s in de match, en één profiel telt maar één keer per lobby
  (twee tabbladen in dezelfde lobby verdubbelen niets). XP komt uit openbare en privé-lobby's.
  **Bots:** kills, headshots, meskills en assists op een bot leveren 25 % XP op (maximaal 600 XP per match in totaal), en
  tellen voor uitdagingen en wapen-XP/camo's maar voor de eerste 3 per match. In een lobby met minder dan 2 mensen is ook de
  objective-, voltooiings-, win- en gelijkspel-XP 25 %, en tellen potjes, winsten en objectives niet voor uitdagingen
  (`BOT_XP_FACTOR`, `BOT_XP_CAP`, `BOT_COUNT_CAP`, `LOBBY_BOT_FACTOR` in `src/modes/progression/XpRules.ts`); het
  XP-overzicht na het potje toont dit als "×0.25". Kill Confirmed geeft XP voor bevestigde (50) en ontkende (25) tags en
  heeft een eigen uitdaging. Klasse-uitdagingen ("5 sniper-kills") worden alleen aangeboden als het wapen ontgrendeld is.
- **Ontgrendelingen** gelden ook op de server: een `loadout` met een wapen, vizier of perk boven je level wordt het
  standaardonderdeel (`lockClass` in `src/modes/progression/Unlocks.ts`).

**Bestanden:** `DATA_DIR/profiles/secret.key` (het geheim; kwijt = alle tokens ongeldig) en
`DATA_DIR/profiles/<xx>/<id>.json`, één klein JSON-bestand per profiel (enkele kB; `<xx>` = de eerste twee tekens van het
id). De server schrijft gewijzigde profielen elke 5 s en bij afsluiten (tmp + rename), houdt er hooguit 2000 in het
geheugen en weigert bestanden groter dan 32 kB. Alles wat van schijf komt gaat door `sanitizeProfile` (onbekende velden
weg, getallen begrensd, laatste 10 matches). De ingebouwde back-ups (`BACKUP_KEEP`) kopiëren ook `profiles/`
(met `secret.key`) naar `data/backups/profiles/<tijdstempel>/` zodra er iets veranderd is; `scripts/backup.sh` neemt de hele
`data/` mee en waarschuwt als `profiles/secret.key` ontbreekt. Terugzetten: stop de server, kopieer een snapshot terug naar
`data/profiles/`. `PROFILE_SECRET` in de omgeving staat niet in de back-up: bewaar die zelf.

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
| `POST /api/admin/announce` | `{"text":"..."}`: servermelding in de chat van elke game (auto-update waarschuwt zo voor een herstart) |
| `POST /api/admin/save` | elke geladen wereld nu naar schijf (auto-update doet dit vlak voor de back-up) |

`/admin` is één statische HTML-pagina zonder framework en zonder geheimen erin: je plakt het token in (alleen in
`sessionStorage` van dat tabblad), ziet elke 5 seconden de cijfers en kunt games sluiten of verwijderen, spelers kicken en
adressen blokkeren. Alle data gaat via `textContent` de pagina in en een strikte CSP verbiedt externe scripts.

## Observability en betrouwbaarheid

- **Logs:** een JSON-object per regel (`{"ts","level","msg",...velden}`), met `room` op regels van een game. Handig met
  `docker logs bunkcraft | jq`. `LOG_LEVEL` en `LOG_FORMAT=text` voor leesbare regels.
- **`/health`:** `{ok, version, uptime, players, playersInPlay, rooms, roomsLoaded, tickP99Ms, loopLagP99Ms, rssMB}` (tick en
  lag over de laatste ~5 s); 503 terwijl de server afsluit. `version` is `<package.json>+<commit>` (bijv. `1.0.0+1a2b3c4`);
  `playersInPlay` telt spelers die een herstart nu zou storen (Minecraft-werelden en lopende matches). Genoeg voor een uptime-checker (bijv. Uptime Kuma of een cloud-monitor):
  alarm bij geen 200, of bij `loopLagP99Ms` structureel boven ~20 (de server loopt achter).
- **`/metrics`** (Prometheus): `bunkcraft_players`, `bunkcraft_rooms_loaded`, `bunkcraft_rooms_total`, `bunkcraft_connections`,
  `bunkcraft_tick_duration_seconds{quantile="0.5"|"0.99"|"1"}`, `bunkcraft_tick_window_seconds{quantile}` (laatste ~5 s),
  `bunkcraft_tick_cpu_window_seconds{quantile}` (CPU-tijd van diezelfde ticks: een tick die veel langer duurt dan zijn
  CPU-tijd wachtte op een core, de machine is dan te druk, niet de game), `bunkcraft_tick_phase_seconds_total{phase=
  "world"|"blocks"|"spawn"|"mobs"|"other"|"snapshots"}` (waar de ticktijd heen gaat), `bunkcraft_slow_ticks_total`,
  `bunkcraft_event_loop_lag_seconds{quantile}` (hoe laat timers afgaan: hét overbelastingssignaal),
  `bunkcraft_gc_pauses_total`, `bunkcraft_gc_pause_seconds_total`, `bunkcraft_gc_pause_max_seconds`,
  `process_resident_memory_bytes`, `process_heap_used_bytes`, `process_cpu_seconds_total`,
  `process_main_thread_cpu_seconds_total` (de core waarop alle gamelogica draait; Node 22.19+), `bunkcraft_ws_messages_{received,sent}_total`, `bunkcraft_ws_bytes_{received,sent}_total`,
  `bunkcraft_ws_messages_per_second{direction}`, `bunkcraft_ws_bytes_per_second{direction}`,
  `bunkcraft_rate_limit_hits_total{kind}`, `bunkcraft_connections_refused_total`, `bunkcraft_logins_failed_total`,
  `bunkcraft_inventory_rejects_total`, `bunkcraft_cheat_events_total{rule}`, `bunkcraft_cheat_kicks_total`,
  `bunkcraft_cheat_bans_total`, `bunkcraft_suspicion_flags_total` (arcade anti-cheat, zie SECURITY.md); met `CHUNK_WORKERS` > 0 ook
  `bunkcraft_chunkgen_workers`, `bunkcraft_chunkgen_queue{state="queued"|"in_flight"}`,
  `bunkcraft_chunkgen_chunks_total{result="generated"|"dropped"|"failed"}` en `bunkcraft_chunkgen_seconds_total`. Scrape-config: `bearer_token: <METRICS_TOKEN>` of scrape lokaal.
- **Prometheus/Grafana (optioneel, niet standaard):** draai ze liever op een andere machine of als losse compose-stack. Minimale
  scrape-config:

  ```yaml
  scrape_configs:
    - job_name: bunkcraft
      scheme: https
      metrics_path: /metrics
      authorization: { credentials: <METRICS_TOKEN uit .env> }
      static_configs: [{ targets: ['play.example.com'] }]
  ```

  Nuttige panelen/alerts: `bunkcraft_players`, `bunkcraft_event_loop_lag_seconds{quantile="0.99"} > 0.02` (5 min),
  `bunkcraft_tick_window_seconds{quantile="0.99"}`, `rate(process_main_thread_cpu_seconds_total[5m]) > 0.6` (tijd voor een
  grotere server of een tweede proces), `process_resident_memory_bytes`, `rate(bunkcraft_ws_bytes_sent_total[5m])`.
- **Afsluiten (SIGTERM/SIGINT):** de server stopt met nieuwe verbindingen, slaat alle werelden op, stuurt elke speler
  `kick` met `reconnect: <ms>` en sluit de sockets met code 1012. De client toont "Server restarting" en probeert tot vijf keer
  zelf opnieuw te joinen. Docker stuurt SIGTERM en wacht 10 seconden: ruim genoeg.
- **Back-ups:** elke `BACKUP_INTERVAL_MIN` minuten een kopie van elke gewijzigde `world.json` naar
  `data/backups/<main|CODE>/<tijdstempel>.json`, de nieuwste `BACKUP_KEEP` blijven. Hetzelfde voor de profielen:
  `data/profiles/` (profielbestanden + `secret.key`) naar `data/backups/profiles/<tijdstempel>/`. Back-ups van verwijderde games blijven
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
docker run -d -p 3000:3000 -v bunkcraft-data:/app/data -e GAMEMODE=survival --name bunkcraft \
  ghcr.io/stijnvandepol/bunkcraft:latest
# of zelf bouwen:
docker build -t bunkcraft . && docker run -d -p 3000:3000 -v bunkcraft-data:/app/data --name bunkcraft bunkcraft
```

CI (`.github/workflows/ci.yml`, job `image`) publiceert na elke groene push naar `main` en bij elke `v*`-tag een
multi-arch image (linux/amd64 + linux/arm64): tags `latest` (alleen `main`), `sha-<commit>` en bij releases
`1.2.0`/`1.2`/`1`, met OCI-labels, SBOM en provenance. De build-stage draait op het platform van de builder (de uitvoer is
platformonafhankelijke JS) en de runtime-stage heeft geen `RUN`, dus arm64 bouwt zonder emulatie. Vóór het publiceren
start de job de amd64-image en controleert hij `/health`.

De wereld staat in het volume `bunkcraft-data` en overleeft herstarts en updates. De image bevat alleen Node, `dist/`,
`dist-server/index.js` en `dist-server/genWorker.js` (de terreingeneratie-thread; geen `node_modules`, geen TypeScript tijdens het draaien). Standaard
`NODE_OPTIONS=--max-old-space-size=384 --max-semi-space-size=16`; `docker-compose.yml` zet geheugen- (`BUNKCRAFT_MEMORY`,
standaard 640m), CPU- (`BUNKCRAFT_CPUS`) en heap-limiet (`BUNKCRAFT_NODE_OPTIONS`) via `.env`, roteert de logs (3 × 10 MB) en
herstart bij een crash.

## Zonder Docker (systemd)

Voor wie liever geen Docker draait: Node.js 22+ en Caddy uit de pakketbronnen, de server als systemd-service.

```bash
# Node.js 24 LTS (NodeSource) en Caddy (apt.caddyserver.com, zie caddyserver.com/docs/install)
sudo git clone https://github.com/stijnvandepol/Bunkcraft.git /opt/bunkcraft && cd /opt/bunkcraft
sudo npm ci && sudo npm run build                     # dist/ en dist-server/
echo "ADMIN_TOKEN=$(openssl rand -hex 24)" | sudo tee /etc/bunkcraft.env && sudo chmod 600 /etc/bunkcraft.env
sudo cp deploy/bunkcraft.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now bunkcraft
# Caddy: dezelfde Caddyfile, met de upstream op localhost
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=DOMAIN=play.example.com UPSTREAM=127.0.0.1:3000\n' | sudo tee /etc/systemd/system/caddy.service.d/bunkcraft.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

De service draait als tijdelijke gebruiker (`DynamicUser`), luistert alleen op `127.0.0.1`, bewaart de werelden in
`/var/lib/bunkcraft` en is dichtgezet (`ProtectSystem=strict`, geen capabilities). Updaten:
`cd /opt/bunkcraft && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart bunkcraft`.
Back-up: `tar -czf bunkcraft-$(date +%F).tar.gz -C /var/lib bunkcraft` (de bestanden worden atomair geschreven).

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
HTTPS en WebSockets automatisch. De meegeleverde `Caddyfile` doet hetzelfde plus de beveiligingsheaders; zet daarvoor
`DOMAIN` en `UPSTREAM=127.0.0.1:3000` in Caddy's omgeving (zie *Zonder Docker*).

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

Kosten: ongeveer 0,03 ms CPU per tick in rust, plus een paar MB per geladen game. Nieuw terrein (~1-2 ms per chunk)
wordt op aparte threads gegenereerd (`CHUNK_WORKERS`): dichtstbijzijnde chunks eerst, en een chunk die nog niet klaar is
telt als "niet geladen" (mobs wachten, water stroomt er nog niet in), net als in de client. Breekt of plaatst een speler
een blok in zo'n chunk, dan maakt de server die ene chunk meteen zelf. De uitkomst is byte voor byte gelijk aan genereren
op de main thread (getest met de golden hashes van elke generatorversie).

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
| `mapId` | `classic` | een id uit `MAP_IDS` (`classic`, `suburb`, `quarter`, `dockyard`, `desert`, `atomic`, `bunker`, `villa`, `yacht`, `town`, `station`, `plaza`, `site`, `carrier`, `shanty`, `mall`, `scrap`) of `rotate` (onbekend = `classic`) |

**Realms-endpoints:**

- `POST /api/quickplay { gameType }` (alleen arcade-types): `200 { code, created: false }` voor een bestaande open lobby,
  `201 { code, created: true }` voor een nieuwe (openbaar, `rotate`, standaardlimieten, naam "Team Deathmatch #K7Q").
  Eigen limiet van 20 verzoeken per minuut per adres; alleen het **openen** van een lobby telt mee voor
  `ROOM_CREATE_LIMIT` (anders `429`). Keuzeregels: `src/modes/Realms.ts`.
- `GET /api/realms`: `{ modes: [{ gameType, players, lobbies }] }` per arcade-mode (spelers in alle geladen games van die
  mode, openbare lobby's zonder wachtwoord met spelers). Valt onder de lijstlimiet.
- `GET /api/rooms?public=1&kind=minecraft|arcade`: de serverlijst voor Multiplayer of Realms; zonder `kind` beide (oudere
  clients). Arcade-lobby's met spelers hebben ook `phase`, `timeLeft` en `currentMap`.
- `POST /api/rooms` accepteert ook `maxPlayers` (2 tot `ROOM_MAX_PLAYERS`, alleen arcade); dat staat in `world.json`.
- `POST /api/rooms` accepteert voor arcade ook `bots` (0 tot lobbygrootte − 1) en `botDifficulty`; dat staat als `bots` in `world.json`. De publieke lijst meldt `bots` naast `players` (mensen).
- Na een potje in een lobby met `rotate` stemmen de spelers over de volgende kaart (`vote`-berichten, zie `docs/GAMEMODES.md`).
- Arcade-games zonder eigenaar (Snel spelen) bewaren geen naamclaims; een tweede speler met dezelfde naam wordt geweigerd
  zolang de eerste speelt.

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
| `atomic` | Atomic Lane | 72 × 48 | Vrije kaart: twee huizen met interieur, een bus, een verhuiswagen en een rotonde |
| `bunker` | Bunker Flag | 64 × 40 | Capture the flag: rivierbedding, bruggen, een duiker en een bunker per team |
| `villa` | Skyline Villa | 88 × 64 | Vrije kaart: witte villa met atrium en dakterras, leeg zwembad, basketbalveld, garage |
| `yacht` | Riptide | 88 × 56 | Vrije kaart: superjacht in een jachthaven met benedendek, salon, brug en helikopterdek |
| `town` | Sundown | 80 × 68 | Vrije kaart: stoffig dorp met tankstation, cantina, markt, klokkentoren en steegjes |
| `station` | Terminus | 84 × 68 | Vrije kaart: station met twee treinen, perrons, loopbruggen, tunnels en twee hallen |
| `plaza` | Fountain Square | 68 × 48 | Vrije kaart: stadsplein met fontein, hotel, café, tram en winkelgalerij |
| `site` | Rebar | 64 × 44 | Vrije kaart: bouwplaats met betonnen casco, steiger, graafmachine en kranen |
| `carrier` | Flight Deck | 72 × 40 | Vrije kaart: vliegdek met hangars, eilanden, jets en een verhoogde lift |
| `shanty` | Tin Roofs | 64 × 44 | Vrije kaart: sloppenwijk met dakbruggen, steegjes en een watertoren |
| `mall` | Galleria | 64 × 44 | Vrije binnenkaart: winkelcentrum met mezzanine, foodcourt en draaimolen |
| `scrap` | Scrapyard | 60 × 42 | Vrije kaart: autosloperij met autostapels, bandenberg en portaalkraan |

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
| `teamFor`, `keepTeams` | team van een nieuwe speler; de mode verdeelt de teams zelf (Match balanceert dan nooit) |
| `speedMul`, `damageMul` | snelheidsfactor (ook in de bewegingscontrole van `GameServer`) en schadefactor per treffer |
| `objectives(p)` | doelen voor server-bots (`BotGoal`: capture, defend, pickup, defuse, hunt, flee) |

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
  De drager is via `speedMul` 10% trager.
- `confirm.ts` (kill confirmed): elke dood laat een tag vallen (max. 40); aanraken (1,6 blokken) door een tegenstander = +1 team,
  door een teamgenoot = geweigerd; `pts` = opgeraapte tags; tags verlopen na 30 s.
- `snd.ts` (search & destroy, `extends RoundsLogic`): planten = 4 s een levende aanvaller op een bomsite (weg = opnieuw), daarna
  `setPhase('live', fuseSec)`; ontmantelen = 6 s een verdediger op de bom. Wipe-regels per kant, na de plant beslist de bom.
  Zijwissel elke `scoreLimit − 1` rondes; aanvallers spawnen aan de rode kant (`pickSpawn`). `pts` = plants + defuses.
- `infected.ts`: `keepTeams`; na 8 s wordt een willekeurige overlevende (blauw) besmet (rood, mes via `giveGear`); doden worden
  besmet; `speedMul` 1,12 voor besmetten en de laatste overlevende, `damageMul` 2 op het mes van besmetten; `scores` = aantallen.
- `sharpshooter.ts`: `loadoutFor` = het gedeelde wapen + pistool + mes; elke 45 s `giveGear` voor iedereen.
- `koth.ts`: zone-rotatie zoals hardpoint, maar wie alleen in de heuvel staat krijgt `pts`; `mode` = `zones` met variant `koth`
  en `holder`.

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
