# Overdracht (stand 9 oktober 2026)

Korte, actuele overdracht voor een nieuwe sessie of een nieuwe ontwikkelaar. Lees daarna `CLAUDE.md` (commando's,
architectuur, valkuilen) en `docs/ROADMAP.md` (wat open staat). Taal: docs in het Nederlands, code, commentaar en
commitberichten in het Engels.

## 1. Wat het product nu is

BunkCraft is een **online arenashooter in de browser** (TypeScript, Three.js r186 op WebGL2, Vite) op een eigen
voxel-engine. Het begon als Minecraft-kloon; de shooter is nu de voordeur en de voxel-sandbox zit achter
**Bouwen & Survival (bèta)**. De menu's volgen de **Bunkhosting-huisstijl** (Manrope en Inter, tokens in
`src/ui/shell.css` en `src/ui/Brand.ts`); het pixelfont blijft voor de in-game HUD en de survival-menu's.

Shooter (de kern):

- **12 modi:** Team Deathmatch, Free For All, Gun Game, Team Elimination, Hardpoint, Domination, Capture the Flag,
  Kill Confirmed, Search & Destroy, Infected, Sharpshooter, King of the Hill (`src/modes/GameTypes.ts`,
  server-regels in `server/modes/`).
- **17 maps** (`src/modes/maps/`), vrije puntsymmetrische kaarten met zones, vlaggen en bomsites; jump pads op trage routes.
- **Krunker-achtige beweging:** slide, slide-hop, bunny hop met momentum, air strafe, crouch. De anti-cheat modelleert de
  slide-envelop exact.
- **Wapens en richten:** Create-a-Class (primair, optiek, secundair, perk), red dot/holo/scopes met variabele zoom,
  terugslagpatronen, per-klasse ADS-curves, geen aim assist. Arcade-tempo met trager, eerlijker time-to-kill
  (`src/modes/Balance.ts`, `scripts/ttk-sim.ts`).
- **Hitregistratie:** exacte rewind (lag-compensatie max 250 ms), hitboxes die het model volgen, geseede spreiding,
  kogels door glas en bladeren, binaire schotframes (binary versie 3).
- **Voortgang:** XP, levels 1-55 met prestige, ontgrendelingen, wapen-XP en camo's, dagelijkse en wekelijkse uitdagingen,
  rangen, titels en visitekaartjes. XP komt alleen van de server (ondertekend profieltoken).
- **Server-bots** vullen lege plekken (`server/bots/`), zijn echte matchspelers en slaan de anti-cheat niet over.
- **Party's** (tot 6 vrienden, `server/Parties.ts`), **rejoin** na een weggevallen verbinding (`REJOIN_GRACE_SEC`, 120 s),
  **eigen spelersskins** (klassiek 64x64, `server/skins/`), privéwedstrijden met code of link, kaartstemming.

Sandbox: survival/creative/hardcore/spectator, 27 biomes (generator v3), block states, vloeistoffen, redstone, landbouw,
enchanting, mobs met goal-AI, multiplayer met gedeelde mobs en kisten. Staat grotendeels stil (zie ROADMAP).

Versie: `1.1.<buildnummer>` (MAJOR.MINOR uit `package.json`, buildnummer = het GitHub-runnummer; lokaal `1.1-dev`).

## 2. Deployment

Live op **https://craft.bunkhosting.nl**, achter een **Cloudflare Tunnel**. Geïnstalleerd met
`sudo ./scripts/install.sh --proxy none` (geen Caddy, geen poort 80/443). Uitleg en opties: `docs/SERVER.md`
(secties "Automatisch deployen" en "Achter een Cloudflare Tunnel").

- **Image:** CI bouwt na elke groene push naar `main` een multi-arch image op GHCR (`ghcr.io/stijnvandepol/bunkcraft`),
  rookt hem (hardening, `/health`, spelpagina, API, wegwerpgame) en publiceert pas daarna.
- **Auto-update:** kanaal `latest` (`BUNKCRAFT_TAG=latest`, elke groene `main`-push), systemd-timer elke 5 min
  (`bunkcraft autoupdate`). Wacht op een rustig moment (`playersInPlay` in `/health`, max 30 min), maakt een back-up,
  herstart, controleert de gezondheid en rolt zichzelf terug als de nieuwe versie niet gezond wordt. Kanaal `stable` =
  alleen release-tags (`v1.2.3`). Optioneel push-deploy via SSH (`DEPLOY_ENABLED`), niet nodig.
- **Bezoekers-IP:** `TRUST_PROXY=0`, `TRUST_CLOUDFLARE=1` en `TRUSTED_PROXY_ADDRS`: `CF-Connecting-IP` wordt alleen
  vertrouwd op verbindingen van de cloudflared-host. Anders kan iedereen die de poort bereikt zijn eigen IP kiezen en
  de limieten per bezoeker omzeilen.
- **Welke versie draait er live?**
  ```bash
  curl -s https://craft.bunkhosting.nl/health     # {"ok":true,"version":"1.1.<build>+<sha7>",...,"playersInPlay":N}
  git ls-remote origin refs/heads/main            # de sha7 hoort bij deze commit
  ```
  Ook zichtbaar linksonder op het titelscherm en met `bunkcraft status` op de server. Loopt de live sha achter op
  `main`: wacht 5-10 min (CI + timer), kijk anders naar de CI-run en `bunkcraft autoupdate status`.
- **Beheer op de server:** `bunkcraft status | update | rollback | autoupdate status | restart | backup`, logs met
  `journalctl -u bunkcraft-autoupdate`, deploylog `/var/log/bunkcraft-deploy.log`. Data in het Docker-volume
  (`/app/data`: `world.json` per game, `profiles/`, `skins/`); dagelijkse back-up naar `/var/backups/bunkcraft` (14 bewaard).
- **Admin:** `/admin` met `ADMIN_TOKEN` (spelers, verdenkingsscores, skins modereren).

## 3. Repo-indeling in het kort

| Pad | Inhoud |
|---|---|
| `src/core`, `src/world`, `src/rendering` | Game loop, renderer, chunks, generator (genVersion!), mesher, licht, shaders |
| `src/entities`, `src/items`, `src/player` | Mobs, items, recepten, spelerfysica en -stats (sandbox) |
| `src/modes` | Arcade: wapens, balans, hitscan, loadouts, maps (`maps/`), progressieregels (`progression/`), party-regels |
| `src/net` | Gedeeld protocol (`protocol.ts`), NetClient, binaire frames, `Rejoin.ts`, `PartyApi.ts`, `SkinApi.ts`, `ProfileApi.ts` |
| `src/ui` | Home, Realms-menu, ArcadeHud, party-paneel, shell-stijl (`shell.css`), i18n NL/EN (`i18n.ts`) |
| `src/skins` | Skinformaat (gedeeld door client en server) |
| `server/` | `GameServer`, `Match`, `Rooms`, `Parties`, `anticheat/`, `modes/`, `bots/`, `progression/`, `skins/`, `chunkgen/` |
| `scripts/` | Installatie en deploy (`install.sh`, `update.sh`, `autoupdate.sh`, `backup.sh`), benchmarks, QA (`qa/`), laadtest (`load/`) |
| `tests/` | Vitest (unit en `integration/`), Playwright (`e2e/`) |
| `docs/` | `SERVER.md` (server en deploy), `GAMEMODES.md` (modi, wapens, bots, voortgang), `SECURITY.md`, `TESTING.md`, `research/` (IDENTITY, MAPS, KRUNKER, SERVER-DEPLOY), `qa/` (rapporten) |

## 4. Testen

Alles staat in `docs/TESTING.md`. De korte versie:

```bash
npx tsc --noEmit && npm run build     # verplicht na elke wijziging
npm test                               # Vitest: unit, property, fuzz en server-integratie (~45 s)
npm run test:coverage                  # wat CI draait (v8-coverage)
npm run test:e2e                       # Playwright, Chromium en WebKit (~2 min)
npm run test:perf && npm run size:check   # mesh/arena-budget en bundelbudget
npm run load -- --steps survival:10x8,tdm:4x12   # botlaadtest tegen de gebouwde server
```

- **Bot-suites:** `tests/botMatch.test.ts` (hele matches tot het einde, nul anti-cheat-meldingen), `botNav`, `botBalance`,
  `botPerf`; `scripts/modes-bots.ts` (alle modi tegen een echte server), `scripts/cheat-bots.ts` (speedhacks moeten
  gevangen worden), `scripts/arena-bots.ts`, `scripts/qa/` (browser-QA: `weapon-glitch.py`, `hitreg-browser.ts`,
  `map-audit.ts`, `map-flow.ts`, `aim-feel.py`, `slide-check.py`, `smoke.py`).
- **CI** (`.github/workflows/ci.yml`, acties vastgezet op SHA, `contents: read`): `check` (npm audit, typecheck,
  coverage, build, bundelbudget, precompressed-controle), `perf`, `e2e` (Chromium op SwiftShader en WebKit),
  `image` (alleen `main` en `v*`-tags, na de drie andere), optioneel `deploy`.
- **Bekende gevoeligheden:**
  - Trage runners: wandklok-asserts zijn verruimd (`TIME_SLACK`, `testTimeout` 90 s onder coverage) en Vitest probeert
    in CI twee keer opnieuw (`retry: 2`); de anticheat-walk, growth-sync en arcade-flowtests zijn deterministisch gemaakt.
    Een test die in CI faalt maar lokaal slaagt: eerst opnieuw draaien, pas dan een nieuwe time-out of fix.
  - e2e-screenshotbaselines bestaan alleen voor macOS (`tests/e2e/baselines/*-darwin`); in CI wordt de pixelvergelijking
    overgeslagen. Bewust een scherm veranderd: `--update-snapshots` lokaal en de baselines meecommitten.
  - Playwright-vensters op de achtergrond draaien op 1-10 FPS (`bringToFront()`), pointer lock bestaat niet in
    geautomatiseerde browsers (e2e forceert `locked`; skins-e2e moet de echte lock eerst loslaten), en de testserver
    deelt één IP, dus zonder `ROOM_CREATE_LIMIT`, profiel- en partylimieten faalt de suite op 429.
  - Prestaties meten: Chromium met `--use-angle=metal`, anders meet je SwiftShader.
  - Bundelbudget faalt bij > 10 % groei: bewust groeien met `npm run size:check -- --update`.

## 5. Conventies

- **Branch:** `feature/bunkcraft-engine`; `main` is wat live gaat. Controleer `git branch --show-current` vóór een merge:
  de main checkout is ooit ongemerkt op een lokale `main` beland.
- **Pushen (afspraak met Stijn: vaak commit en push na elke geverifieerde merge of fix, nooit rood):**
  ```bash
  git push origin HEAD:feature/bunkcraft-engine
  git push origin HEAD:main                      # dit triggert CI en daarna auto-deploy
  git ls-remote origin refs/heads/main refs/heads/feature/bunkcraft-engine   # moet gelijk zijn aan git rev-parse HEAD
  ```
  Altijd een expliciete `HEAD:`-refspec en daarna `ls-remote` vergelijken voordat je "gepusht" meldt; een stale lokale
  branch gaf eerder "Everything up-to-date" terwijl er niets op de remote kwam.
- **Commitberichten:** Engels, beschrijvend (wat en waarom), eindigend met de Co-Authored-By-regel. Docs in het Nederlands.
- **Agents:** Sonnet of Haiku voor lichter werk (merges, testruns, QA-herhalingen, docs, kleine fixes); Opus voor
  netcode, anti-cheat, engine en lastige debugging. Houd het aantal parallelle agents laag (tokenverbruik) en laat ze
  in eigen worktrees werken (`.claude/worktrees/`).
- **Generator-uitvoer verandert nooit** voor bestaande werelden: nieuwe `genVersion` toevoegen, golden hashes behouden.
- **Geen Mojang-assets** in de repo; texturepacks van de speler blijven in zijn eigen browser.
- **Geen allocaties in per-frame-code**; prestatiedoel is 60+ FPS op een geïntegreerde GPU.
- **Prestatiebudgetten** (`scripts/perf-budget.json`, `bundle-budget.json`) bewust ophogen in dezelfde commit als de oorzaak.

## 6. Open punten en volgende stappen

Uitgebreid en geprioriteerd: `docs/ROADMAP.md`. De kop:

1. **ADS-validatie op de server** (SECURITY O-09): de server vertrouwt de `ads`-vlag van de client voor de kleinere
   spreiding. Werk loopt; afmaken en testen met `scripts/cheat-bots.ts`.
2. **Playtest met echte spelers** van de nieuwe wapenbalans (time-to-kill), richtgevoel en standaardgevoeligheid, plus
   de weapon-glitch-fixes (`scripts/qa/weapon-glitch.py`). Daarna eventueel Classic compacter of uit de rotatie.
3. **Hide & Seek / Prop Hunt:** bewust nog niet gebouwd; vraagt een hitbox per speler in `rayPlayer`, een
   blokvermomming die op het raster snapt en rendering van verstopte spelers.
4. **In-game HUD in de shell-typografie** (nu pixelfont) en een eventueel eigen display-font (keuze van Stijn; fontbestand
   downloaden en licentie controleren). Create-a-Class ook vanaf de home.
5. **Skins:** eerste-persoonshand met eigen skin, skins bij Direct Connect, opruimen van skins zonder eigenaar.
6. **Rejoin en party's:** bewaarde plekken en party's overleven geen serverherstart; party-chat of pushkanaal.
7. **Geparkeerd:** survival een eigen twist geven (en de survival-menu's in de shell-look); **dorpen en villagers** zijn
   gestopt (alleen onderzoek in `docs/research/STRUCTURES-VILLAGES.md`, geen code); CrazyGames/Poki pas na touch voor de shooter.

Bekende kleinere risico's: spawnkills in FFA na de snellere respawn (6,4 % in botmatches), aparte rate-limiter voor
WebSocket-verbindingen (SECURITY O-05), `og:image` met absolute URL per deployment, en accounts/herstel van een verloren
profieltoken (er zijn geen echte accounts; identiteit is een ondertekend token in de browser).
