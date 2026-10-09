# BunkCraft roadmap

Stand: 9 oktober 2026. Wat af is staat kort in §3 (de details staan in de docs die erbij horen), wat open staat in §2 en §4.
De overdracht voor een nieuwe sessie staat in [`HANDOFF.md`](HANDOFF.md).

## 1. Koers

BunkCraft is een **online arenashooter met een eigen identiteit**, geen Minecraft-kloon meer. De shooter is de voordeur
(Play, playlist, lobby's, party's, profiel); de voxel-sandbox zit achter **Bouwen & Survival (bèta)** en krijgt alleen
onderhoud tot er een beslissing over valt. Ontwerp en keuzes: [`research/IDENTITY.md`](research/IDENTITY.md); de shell
volgt de Bunkhosting-huisstijl. Live op https://craft.bunkhosting.nl (Cloudflare Tunnel, auto-update, zie
[`SERVER.md`](SERVER.md)).

## 2. Volgende stappen (op volgorde)

**Nu (afmaken)**

1. **ADS server-side valideren (S-M, bezig).** De server vertrouwt de `ads`-vlag van de client voor de kleinere spreiding
   (SECURITY O-09). Toestaan alleen na een zoomtijd of bij stilstaan, gedeeld met de clientregels; `scripts/cheat-bots.ts`
   uitbreiden met een ADS-claimende bot.
2. **Playtest met echte spelers (S, geen code).** Time-to-kill na de balans-pass (`ttk-sim.ts`, GAMEMODES §Rollen en balans),
   richtgevoel (standaardgevoeligheid 100 % = 0,126°/count is snel met raw input), de weapon-glitch-fixes
   (`scripts/qa/weapon-glitch.py`) en per kaart de looplijnen. Uitkomst: balanswijzigingen in `Balance.ts`, Classic compacter
   of uit de rotatie, Villa/Terminus/Harbor Yard inkorten of jump pads op de lange routes.
3. **Controleren dat deploy en CI stabiel zijn (S).** Na de laatste CI-verharding (Vitest `retry: 2`, deterministische
   anticheat-walk) een week meekijken of er nog flaky tests zijn; Linux-baselines voor de e2e-screenshots toevoegen
   (nu alleen `*-darwin`, dus in CI wordt de pixelvergelijking overgeslagen).

**Daarna (product)**

4. **Hide & Seek / Prop Hunt (L).** Bewust nog niet gebouwd: vraagt een hitbox per speler in `rayPlayer` (nu één maat),
   een blokvermomming die op het raster snapt en door de anti-wallhack-filtering heen klopt, en eigen rendering van
   verstopte spelers. Pas starten met de hitreg-simulatie (`scripts/hitreg-sim.ts`) als vangnet. Ontwerp: `research/ARCADE.md`.
5. **In-game HUD naar de shell-typografie (M).** Scorebalk, killfeed en doodscherm gebruiken nog het pixelfont. Een eigen
   display-font (bijvoorbeeld Chakra Petch of Saira Condensed, OFL, lokaal gebundeld) is een keuze voor Stijn; de shell zelf
   gebruikt al Manrope en Inter.
6. **Create-a-Class vanaf de home (M).** De editor loskoppelen van de match-HUD; meerdere opgeslagen klassen (nu één),
   attachments (grip, laser) en een tweede perk.
7. **Skins afmaken (S-M).** Eerste-persoonshand met de eigen skin, skins van andere servers (Direct Connect) en opruimen van
   skins zonder eigenaar. Zie SERVER.md §Spelersskins.
8. **Rejoin en party's robuuster (M).** Bewaarde plekken en party's overleven geen serverherstart (alleen de XP wordt
   uitbetaald); een FFA-leider die weg was telt niet mee voor de winnaar; party-chat of pushkanaal (nu pollen elke 1,5 s);
   uitnodiging in de game; klaar-controle voor de start.
9. **Realms vervolg (M).** Skill-based matchmaking (K/D per naam, bij party's het gemiddelde), adaptieve botmoeilijkheid
   in Snel spelen, playlist-rotatie met tijdelijke modi, lege open lobby's sneller opruimen, lobbylijst pagineren.

**Later**

10. **Mobiel voor de shooter (L):** touchbediening voor schieten en richten, crouch/slide-knop, test op echte toestellen;
    daarna pas CrazyGames/Poki (de Minecraft-jar-import verbergen).
11. **Anti-cheat vervolg (M-L):** server-side invoersimulatie (de server speelt `Player.step` na), drempels van de
    verdenkingsscore kalibreren met echte data, tracers alleen naar wie de schutter mag zien, delta-snapshots.
12. **Schaal (L, beslissing Stijn):** delta-`ent`-frames (~90 % van het survival-verkeer), meerdere processen boven
    ~150-200 spelers. uWebSockets.js: advies nee.

**Geparkeerd of gestopt**

- **Survival een eigen twist geven** en daarna de survival-menu's (wereldlijst, wereld maken, pauze) in de shell-look: geparkeerd.
- **Dorpen, villagers en structuren:** gestopt. Alleen onderzoek ([`research/STRUCTURES-VILLAGES.md`](research/STRUCTURES-VILLAGES.md)),
  de `Structures.ts`-registry en structuurkisten met loot; geen dorpen in de generator. Hervatten vraagt een nieuwe `genVersion` (4).
- **Eindspel/dimensies, brouwen, netherite, redstone-comparator/observer:** niet gepland.

## 3. Gedaan

**Shooter en platform**

- **Voordeur en look:** home met PLAY, playlist met live spelers, lobby's, privéwedstrijd en spelen met code, profielkaart,
  loadouts, wapenkamer, statistieken; "Realms" is intern gebleven (protocol, bestandsnamen), niet in de UI. Bunkhosting-stijl
  voor de hele shell (Manrope en Inter, tokens), embleem en woordmerk uit `Brand.ts`, NL/EN overal incl. de Multiplayer-sandboxmenu's.
- **12 modi** (tdm, ffa, gun game, elimination, hardpoint, domination, ctf, kill confirmed, search & destroy, infected,
  sharpshooter, king of the hill) met server-autoritaire regels (`server/modes/`), objective-HUD en bots die elke modus spelen.
- **17 maps** met zones, vlaggen en bomsites; analyse en meetscripts in [`research/MAPS.md`](research/MAPS.md); spawns zijn
  niet zichtbaar vanaf de vijandelijke helft.
- **Krunker-beweging:** slide, slide-hop, bunny hop, air strafe, crouch, jump pads, perk Lightfoot en klasse Scout; anti-cheat
  modelleert de slide-envelop; tempo (respawn 2,5-3 s, bescherming eindigt bij je eerste schot, radarscan bij 5 kills).
- **Hitregistratie:** exacte rewind, hitboxes die het model volgen, geseede spreiding, kogels door glas en bladeren, hit
  markers, binaire schotframes (arenaverkeer per speler 14,3 naar 9,5 KiB/s).
- **Richten en wapens:** same-frame zoom, exacte vizieruitlijning, red dot/holo/scope-reticles, variabele sniperzoom,
  ADS-curves per klasse, ADS-gevoeligheid, crosshairstijlen; wapenbalans met trager, eerlijker time-to-kill (headshots
  1,4-1,5x); LMG, DMR, burst rifle, revolver, lever carbine, anti-materiel rifle; klassen, perks, optieken; weapon-glitch-pass
  (vuurbeheer, viewmodel, reload-annulering); gelaagde procedurele wapengeluiden.
- **Voortgang:** XP, levels 1-55 en prestige, ontgrendelingen, wapen-XP en camo's, uitdagingen, rangen, titels, profieltoken
  (identiteit zonder account), eerlijke XP tegen bots, profielback-ups.
- **Server-bots** (`server/bots/`): navigatiegraaf per kaartvariant, vijf moeilijkheden, balans getoetst tegen referentiespelers,
  geen anti-cheat-meldingen; vullen Snel spelen en privélobby's.
- **Party's** (tot 6, zelfde lobby en team), **rejoin** (120 s plek, score en XP bewaard), **eigen skins**
  (strikte PNG-decoder, content-addressed opslag, moderatie in `/admin`), kaartstemming, Create-a-Class.
- **Anti-cheat:** bewegingscontrole met de gedeelde botsingscode en de fysicaklok van de client, schotcontrole,
  lag-compensatie, anti-wallhack-culling, verdenkingsscore; movement validator zonder valse correcties op verborgen routes.

**Deploy en kwaliteit**

- **Eigen server:** `install.sh` (Docker + Caddy, of `--proxy none` voor een Cloudflare Tunnel met `TRUST_CLOUDFLARE` en
  `TRUSTED_PROXY_ADDRS`), back-ups, `bunkcraft`-CLI, systemd-unit in `deploy/`, server als esbuild-bundel, chunkgeneratie
  op worker threads.
- **Auto-deploy:** multi-arch GHCR-images na groene CI, smoketest vóór publiceren, auto-update-timer met rustig-moment-wachten,
  automatische rollback, kanalen `latest` en `stable`, optionele push-deploy. Versie `1.1.<build>` in `/health` en op het titelscherm.
- **CI en tests:** vastgezette actions en minimale rechten, `npm audit`, coverage, bundel- en prestatiebudgetten, e2e op
  Chromium en WebKit, bot-integratietests, browser-QA-scripts. Beveiligingsaudit: [`SECURITY.md`](SECURITY.md).
- **PWA, itch.io-build, `.bunkworld` delen, gamepad, touch (sandbox), toegankelijkheid** (zie [`DISTRIBUTION.md`](DISTRIBUTION.md), [`CONTROLS.md`](CONTROLS.md)).

**Sandbox en engine** (detail in [`GAMEPLAY.md`](GAMEPLAY.md), [`RESEARCH.md`](RESEARCH.md), [`CONTENT.md`](CONTENT.md), [`BLOCKSTATES.md`](BLOCKSTATES.md))

- Alle 15 bugs uit de eerste code-review en de robuustheidsfixes uit de engine-audit (save, WebGL-contextverlies, workercrash).
- Generator v1-v3 met `genVersion` (grotten, ravijnen, ertsen, 27 biomes, rivieren), block states, stromend water en lava,
  random ticks (saplings, bladverval, vallend zand), landbouw, redstone (minimaal), XP en enchanting, harnas, weer.
- Mobs met goal-AI en A* (fokken, wolven, enderman, slime, drowned, husk, stray, witch, skeleton, spin), server-simulatie
  en gedeelde drops, kisten en ovens op de server, wachtwoord/whitelist/ops, binair `snap`/`ent`, `/metrics`.
- Prestaties: bundel 1498 naar 488 KB tot het titelscherm, dynamische resolutie, garbagevrije hete paden, standaard
  texturepack als één bundel, perf-budgetten in CI. Audio volledig procedureel (`src/core/audio/`).
- Keybinds, ondertitels, NL/EN, Minecraft-1.21-niveau menu's voor de sandbox.

## 4. Open per gebied

### Shooter

- **Beweging:** crouch-jump en wall-jump (variabele botsingsbox in client én validator), richting-jump pads met horizontale
  impuls, bots die sliden in `flow-metrics.ts` en `cheat-bots.ts`, spawnkills in FFA verder omlaag (6,4 % in botmatches).
- **Kaarten:** meerdere dekkingsindelingen per kaart via de seed (nu alleen Classic); bij een kaartwissel de wereld ter plekke
  herbouwen in plaats van een korte herverbinding.
- **Modi:** S&D met bomdrager, plant/ontmantel-actie en explosieschade; Infected met UAV-ping voor de besmetten; Kill Confirmed
  met tags die op de grond vallen; Domination/Hardpoint-varianten per kaart; een parkour/race-modus; S&D op een asymmetrische kaart.
- **Objectives:** dragerpijl met interval, MVP-punten, overtime bij gelijkspel in ctf, granaten voor elimination, de vlag als
  derde-persoonsmodel op de rug.
- **Wapens en klassen:** granaat/launcher (pas als de server projectielen kent; nu alles hitscan), meer scorestreaks, kill cam,
  headshot-statistieken, teamchat, glinstering ook in de dev-preview, ingesproken announcer.
- **Voortgang:** profiel overzetten naar een ander apparaat (token als QR/code), camo's zichtbaar voor anderen, seizoensleaderboards,
  XP-curve en farm-limieten bijstellen met echte speeldata, `profiles/` in de ingebouwde back-ups.
- **Bots:** granaten en perks zodra die er zijn, bunny-hop en slide, een host-commando om bots tijdens het potje bij te stellen.
- **Mobiel/toegankelijkheid:** teamkleuren ook met patroon of icoon, schermlezertekst voor de inventaris, gamepad-knoppen herbinden.

### Server en netwerk

- Open uit SECURITY.md: aparte rate limiter voor WebSocket (O-05), ADS-validatie (O-09, zie §2), accounts of een herstelroute voor
  een verloren profieltoken, Grafana-voorbeelddashboard en alerting, rate limits per game in `/admin`.
- Delta-compressie van `snap`, client-naar-server `pos` binair, delta-`ent`-frames, tracers alleen naar wie het mag zien.

### Distributie

- `og:image` met een absolute URL per deployment, export van multiplayer-werelden (server-kant), HUD in screenshots,
  CrazyGames/Poki (na touch), Esc-vergrendeling in fullscreen op een echt toestel testen.

### Sandbox (parkeerstand, alleen als er een beslissing over valt)

- **Mobs:** melk die effecten wist, witch die zelf drinkt, mob-drops via `rollLoot`, getemde wolven en paarden bewaren, deuren
  in het pad, enderman die blokken pakt, vleermuizen/inktvissen/vissen. De server kent de health van de speler niet.
- **Inhoud:** tier 2 uit [`CONTENT.md`](CONTENT.md) (cacao, brouwen, smithing, schild, hengel, kaarsen, banners, koraal, kisten met
  richting), waterlelies, ladders/muurfakkels/trapdoors op de block-statemachinerie, oven met richting, bed als 2-bloksblok.
- **Redstone:** comparator, observer, hopper, dispenser/dropper, rails, slime, zuigeranimatie, quasi-connectivity.
- **Enchanting:** Sweeping Edge, vloeken, Frost Walker, Soul Speed, kruisboog/trietand/hengel, zwevend boek; XP is nog client-autoritatief.
- **Weer en sfeer:** regengeluid en donder via `AudioEngine.setWeather`, sneeuwlagen, vuurvliegjes, mangrove/mushroom fields/ice spikes.
- **Engine:** `Game.ts` opsplitsen (GameStateMachine, WorldSession, SimulationLoop), 16x16x16-secties met cave culling en multi-draw
  (rd 16: ~600 draw calls), persistente lichtcache per chunk, mob-render-garbage verder omlaag, `RedstoneSim.key` boxt boven 2^31.
- **Overig:** health/honger en stationcontrole server-side, PvP in de sandbox, zaadjes planten in de guard, correctie van de
  inventory na een geweigerde plaatsing.
