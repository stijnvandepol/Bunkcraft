# QA: arcade-modes speeltest

## Ronde 2: BunkCraft Realms, arsenaal, geluid, anti-cheat (oktober 2026)

Getest na de Realms-hub (snel spelen, lobby's bekijken, privélobby, lobbypaneel, kaartstemming), de nieuwe wapens en optieken,
Create-a-Class met perks, de geluidsronde en de anti-cheat. Echte Chromium (`--use-angle=metal`, M1 Pro) via de menu's, 2-3
browsers per test, aangevuld met protocolbots tot 12-16 spelers. Let op: de machine was druk (andere agents; load average
15-20, een tijd lang zelfs 150+), dus tijdmetingen zijn eerder te hoog dan te laag.

### Wat er getest is

| Onderdeel | Hoe | Resultaat |
|---|---|---|
| Snel spelen, elke mode | `realms-flow.py quickplay`: titel → Realms → mode kiezen → Snel spelen (A) en dubbelklik (B), bots tot 12 (tdm 16), live, Esc → Disconnect | 7/7 modes: zelfde lobby, juiste mode, lobbypaneel met mode/kaart/"Wacht op spelers (1/2)", live met 12-16 spelers, terug in de playlist, geen console-errors |
| Volle lobby | 16/16 in een tdm-lobby, derde browser drukt Snel spelen | krijgt een nieuwe lobby |
| Lobby's bekijken | B filtert op Domination en joint A's lobby | rij toont mode, kaart, 1/16, fase; join werkt |
| Privélobby | CTF op Bunker Flag, niet zichtbaar; vriend joint met code (met streepje) | code + link, voorbeeldregel bij het typen, niet in de lijst, onbekende code geeft "Game not found", 1v1 gaat live |
| Kaartstemming | privé tdm, wisselende maps, score 10, 14 bots | na 10 kills drie kaarten, stemmen met 3 (en wisselen 2 → 3), beide clients gaan naar de gekozen kaart (classic → Terminus), weg via Esc → Realms |
| Wapens | `weapon-check.py` (preview): elk primair wapen × elke optiek, secundaire wapens | ADS-tijd, zoom, scope-overlay (wapen weg), reticle bij red dot/holo, adem inhouden (sway 0,32 → 0,035, na 4 s 0,60, geluiden), elk schot hoorbaar, terugslag, herladen + geluiden, wisseltijd 0,28 s / Quickdraw 0,14 s, Extended Mags 42, demper-geluid, killfeed "You DMR Nova" |
| Klassen op de server | `class-guard.ts` | rommel (onbekende wapens, verkeerde slots, `{"toString":1}`, 5000 tekens) → altijd geldige uitrusting; optiek die niet past → eigen optiek; na 3 s wacht een klasse op het volgende leven; elke preset komt aan; anderen zien optiek en demper (`holds`); gun game negeert klassen |
| Protocolbots | `arena-bots.ts` (5 kaarten × tdm/ffa), `modes-bots.ts`, `cheat-bots.ts` | alles groen (na de fixes hieronder): 24/24 per kaart, 42/42 modes, 19/19 anti-cheat |
| Geluid | `audio-report.py`, captions in de preview (NL) | elk geluid hoorbaar en zonder clipping (hardst: stinger winst −6,1 dBFS, bolt-action −8,7); captions "Geweerschot ↗", "Voetstappen", "Dubbele kill" |
| Lobby openen tijdens een match | `room-stall.ts`: 6 nieuwe lobby's terwijl er gespeeld wordt | langste gat tussen snapshots 59 ms (normaal 44), aanmaken 21-28 ms |

### Prestaties (16 spelers: 15 bots + 1 Chromium die rent, richt en schiet; `arcade-perf.py`)

| Kaart | FPS (vsync) | frame p99 | max | JS/frame gem. / p95 | zonder vsync-cap |
|---|---|---|---|---|---|
| Terminus (station) | 120 | 10,2 ms | 10,4 ms | 0,76 / 1,18 ms | 536 fps, p99 4,5 ms |
| Skyline Villa | 120 | 10,2 ms | 10,4 ms | 1,04 / 1,45 ms | 530 fps, p99 4,2 ms |
| Sundown (town) | 120 | 10,2 ms | 16,6 ms | 1,06 / 1,40 ms | 517 fps, p99 4,7 ms |

Gelijk aan de roadmapmeting (classic: 120 fps, p99 10,4 ms, JS 0,58 ms; zonder cap 637 fps). Zonder cap zit er per run 1-2 keer
een frame van 220-270 ms in; met vsync niet (vermoedelijk een GPU-stall bij het eerste schot of model, niet verder onderzocht).
**Server** (`bench-arena.ts 16 30`, geïsoleerd): tick gem. 0,08-0,10 ms, 0,8-1,1% van een core op classic, station, villa, town
en yacht (roadmap: 0,085 ms, 0,93%). De `tick_duration`-p99 van een draaiende server liep op tot 36-60 ms, maar dat volgde de
machinebelasting; de geïsoleerde meting en `room-stall.ts` laten geen haperingen zien.
**Audio:** in een vuurgevecht met 16 spelers staat de stemmenlimiet constant op 64/64 (35-75 drops/s). Worst case uit
`audio-report.py`: 0,59 ms planning per frame (budget 0,3; roadmap 0,26), gemeten bij load 16: opnieuw meten op een rustige machine.

### Gerepareerd (met regressietest)

1. **Red dot/holo: je keek tegen de achterkant van een blok.** Bij richten vulde de platte achterkant van de receiver (vlak voor
   het oog) het beeld onder de stip. Het richtbeeld snijdt het wapen nu vlak achter het venster van de optiek af
   (`adsCutZ` in `WeaponModels.ts`). Test: `arcadeFeel.test.ts`. Shots: `r2-reddot-before.jpg`, `r2-reddot-after.jpg`.
2. **Eindscherm (met kaartstemming) over de scorebalk, killfeed en panelen:** "Red team wins!" stond op de timer en de
   stemkaarten op health/munitie. Het eindscherm verbergt de HUD eronder. e2e: `arcade-hud.spec.ts`. Shot: `r2-end-overlap.jpg`.
   **Create-a-Class lag over de scorebalk** (en "Match starts in 1" en het lobbypaneel schenen erdoor). Het menu verbergt nu de
   match-HUD eronder en heeft een donkerder achtergrond. e2e: `arcade-hud.spec.ts`. Shots: `r2-cac-before.jpg`, `r2-cac-after-nl.jpg`.
3. **Match-HUD alleen Engels.** Alles is nu NL/EN (135 keys `arc.*`/`mode.*`), ook de regels die de server stuurt
   (`localizeServerText`). Test: `arcadeI18n.test.ts`. Daarbij: een level-up in gun game toonde de wapen-id ("Level up: smg").
4. **Zonemarker aan de schermrand afgekapt** ("CONTESTED"/"BETWIST" half buiten beeld). De zijmarge houdt nu rekening met de
   breedte van het label. e2e: `arcade-hud.spec.ts` (faalt zonder fix). Shot: `r2-marker-clipped.jpg`.
5. **Captions over de wapenslots en munitie.** In de arcade staan ze nu erboven. e2e: `arcade-hud.spec.ts` (faalt zonder fix).
   Shot: `r2-captions-overlap.jpg`.
6. **Terugslag zakte terug tijdens het sproeien.** Herstel begon na 0,09 s zonder schot, maar de rifle (600/min) schiet elke
   0,1 s: hij klom maar half zo veel als ontworpen. Automatische wapens herstellen nu pas na een pauze langer dan hun interval.
   Test: `arcadeFeel.test.ts`. Gemeten in de browser: rifle klimt 9,5° per magazijn (was 7,0°).
7. **Burst rifle:** een burst die door een leeg magazijn werd afgebroken, schoot na het herladen vanzelf af. Test: `weapons.test.ts`.
8. **Server: `loadout` met een niet-string-veld** (`{"toString":1}`) liet `String()` gooien: ERROR in het log en de speler werd
   eruit gegooid (1011). Niet-strings tellen nu als afwezig. Test: `arcadeRoom.test.ts`.
9. **Voetstappen van een vijand vlakbij vielen weg** in een groot vuurgevecht (ambient-prioriteit, stemmen vol met schoten).
   Binnen 12 m hebben ze nu de prioriteit van een schot. Test: `audio.test.ts`.
10. **Privélobby bood 16 spelers aan** op een server met `ROOM_MAX_PLAYERS=8` (de standaard), die er stil 8 van maakte. `/api/server`
    meldt `roomMaxPlayers`; het menu biedt alleen wat mag. Tests: `realms.test.ts`, `rooms.it.test.ts`.
11. **Villa: richel van 1,5 bij het verzonken pad** (open punt 3 hieronder): het pad stopt nu een rij voor de stoeprand en de
    auto. `arena.test.ts` zoekt op alle kaarten naar slabvloeren naast zo'n trede (alleen villa had ze: 14).
12. **QA-gereedschap:** `arcade-perf-bots` liep met cover-variant 0 door de kratten van classic en werd voor noclip gekickt
    (gebruikt nu kaart en variant uit `welcome`); bots liepen over slabvloer op +1 (fly); een volle lobby liet de bots crashen;
    `arena-bots` vond op station geen duelplek; `/metrics` met `ADMIN_TOKEN` (`QA_METRICS_TOKEN`). Nieuw: `realms-flow.py`,
    `weapon-check.py`, `class-guard.ts`, `room-stall.ts`; `play-modes.py` kan onder last (`QA_FILL_BOTS`).

### Open (groter of een keuze voor Stijn)

1. **`ROOM_MAX_PLAYERS` staat standaard op 8.** Snel-spelen-lobby's krijgen die grootte, dus een 6v6 (BO-standaard) kan niet zonder
   de variabele. Advies: 12 voor arcade-lobby's (Docker/compose is van een andere agent).
2. **Bots op Terminus blijven op hun eigen helft.** De botpaden (`scripts/lib/arenaPath.ts`) lopen alleen over vloerhoogte; de
   perrons (+1) scheiden de helften. Voor tests en een toekomstige "bots in lege lobby's" (roadmap 7b-7) is pathing met stappen
   nodig.
3. **Yacht-spawns zijn nog steeds te zien** vanaf 215 (rood) / 71 (blauw) plekken op de andere helft, dichtstbij 42-44 m
   (`map-audit.ts`, ongewijzigd sinds ronde 1). Met de bolt-action (one-shot headshot) een spawntrap-risico.
4. **Audio worst case 0,59 ms/frame** (budget 0,3) en de 64/64 stemmen bij 16 spelers: opnieuw meten op een rustige machine; zo
   nodig minder stemmen per verre schot of een lagere `REMOTE_SHOTS_PER_FRAME`.
5. **Dev-preview:** de nep-server bevestigt de laatste kogel van een magazijn niet (de client toont "1" en herlaadt); alleen de
   preview, de echte server telt goed (25/25 bij de SMG).
6. **Lange frame zonder vsync** (220-270 ms, 1-2 keer per run van 30 s), zie prestaties.
7. **Rubber-banding van eerlijke spelers onder last (open punt 1 van ronde 1): nog steeds, op yacht.** `play-modes.py` met
   12 extra bots (`QA_FILL_BOTS=12`), load 15-20: tdm op yacht, villa, town en station 0 correcties voor de browsers, ctf op
   station 0, maar **ctf op yacht: 7 correcties voor Alpha** (de vlagdrager-route over het dek, (-32..-28, 69-70, 1-4), en de
   steiger bij (-34,5, 65, -13)); serverregels in die run: `lag` 4, `speed` 2, `fly` 1. In een eerdere run bij load 150+ ook
   5× op station (14, 70-72, 19,5), bij een rustigere herhaling niet. Repro: `QA_FILL_BOTS=12 python3 scripts/qa/play-modes.py
   out.json ctf yacht`. Vermoeden: de token bucket van de snelheidscontrole is te krap voor frame-haperingen plus de
   bunny-hop-sprongen van de drager op de trappen van het jacht. Shot: `r2-rubberband-ctf-yacht.jpg`.

Screenshots ronde 2: `docs/qa/shots/arcade/r2-*.jpg`.

## Ronde 1

Stand: 2026-10. Elke mode (tdm, ffa, gungame, elimination, hardpoint, domination, ctf) op elke kaart (11) gespeeld met
twee echte Chromium-clients (`--use-angle=metal`, headless) tegen een echte server via Vite, plus een looptoer met de echte
spelerfysica over elke kaart (dev-preview). Invoer alleen via `game.input`. Scripts staan in `scripts/qa/` (zie onderaan).

## Samenvatting

| Onderdeel | Resultaat |
|---|---|
| Joinen, kaart laden, teams, warm-up → live | 77/77 combinaties OK (desert valt voor hardpoint/domination/ctf terug op classic: geen zones/vlaggen; het menu filtert dat al) |
| Spawns | Altijd op een blok, nooit in een blok, nooit zicht op de tegenstander bij de start (afstand 43–95 m) |
| Doel van de mode | tdm/ffa/elimination: kill (en `round-win`) op alle kaarten; hardpoint: heuvel bereikt en +1/s op alle kaarten; domination: punt veroverd (`zone-captured`) overal; ctf: vlag gepakt én gescoord op alle 10 kaarten met vlaggen; gun game: `level-up` overal waar de bots elkaar vonden (zie balans) |
| Vast komen te zitten | 0 keer in de 77 multiplayer-sessies; looptoer: 5 oude kaarten 0 incidenten; nieuwe kaarten: zie kaartproblemen |
| Rubber-banding van eerlijke spelers | 3 correcties in ~80 sessies, allemaal bij de bunny-hoppende bot onder zware machinebelasting (2× `lag`, 1× `speed`, yacht bij (-24, 66, -16)) |
| Console-errors | 0 |

## Gerepareerd (met regressietest)

1. **Eindscherm over het doodscherm heen.** Als de laatste kill van de match jou doodde, bleef "You were eliminated by …",
   "Respawning in 3" en de spectate-hint door het eindscherm heen staan. `ArcadeSession.onMatchEnd` sluit nu het doodscherm en
   het spectaten. Test: `tests/e2e/arcade-hud.spec.ts` (faalt zonder de fix). Shot: `shots/arcade/repro-death-then-end-tdm.jpg`.
2. **Eindscherm toonde de oude score bij objective-modes.** De server stuurt `matchend` vóór de laatste `match`/`roster`
   (bij ctf/zones komt de score pas daarna), dus het eindscherm zei "RED 0 – 0 BLUE" terwijl rood met 1 capture won.
   Het eindscherm wordt nu opnieuw getekend als score of roster na `matchend` binnenkomt. Test: `tests/e2e/arcade-hud.spec.ts`.
   Shot: `shots/arcade/play-ctf-villa.jpg` (vóór de fix).
3. **Objective-markers over de munitie- en healthpanelen.** Een marker van een zone onder of achter je werd tegen de onderrand
   geplakt, bovenop "30 / ∞". `placeMarker` heeft nu een `bottomMargin`; de HUD houdt ~30% van de hoogte onderin vrij.
   Test: `tests/modeView.test.ts`. Shots: `play-hardpoint-dockyard.jpg`, `play-domination-town.jpg` (vóór de fix).
4. **Town: dakladder van de herberg niet te beklimmen.** De eerste trede (-25, 70, -1) zat onder het dak (blok op y 72), dus de
   sprong naar de tweede trede stootte je hoofd; de high ground (-21, 73, 0) en zijn gedraaide kopie waren onbereikbaar.
   Het dakluik is één blok groter. Bevestigd met echte fysica (`try-path.py`): vóór vast op 70,1, na op het dak.
   Shots: `town-roof-ladder.jpg`, `town-roof-ladder-fixed.jpg`.
5. **Regressietests voor bereikbaarheid aangescherpt.** De flood-fill in `tests/arena.test.ts` en `tests/helpers/mapAnalysis.ts`
   telde een stap omhoog ook als er een plafond 2 blokken boven de afzet zat, en zag hekken/muren (1,5 hoog) als opstapjes.
   Beide regels zitten er nu in; zo vond de test de town-ladder.

## Open (groter, of van een andere agent)

1. *(Ronde 2: zie daar, punt 7.)* **Anti-cheat: eerlijke bunny-hopper gecorrigeerd** (`speed`, yacht; en twee `lag`-correcties). Alleen gezien onder zware
   CPU-belasting (frame-haperingen), op de anti-cheat-versie van vóór de laatste merge. Na de merge slagen alle tests
   (`npm test`: 1480/1480, ook `anticheatMovement` op town en de arcade-integratietests); de speeltest is daarop niet opnieuw
   gedraaid. Advies: `play-modes.py` nog eens draaien en op `tp=`/`cheat=` letten.
2. *(vervallen: de integratietests die onder belasting faalden slagen na de merge.)*
3. *(Gerepareerd in ronde 2.)* **Villa: verzonken stenen pad (bottom slabs in de vloerlaag, x ±10..14).** Vanaf het pad (y 64,5) is een richel van 1 blok
   1,5 hoog: daar kun je niet op springen, wel overal ernaast. Voelt als een onzichtbare muur. Shot: `walk-villa`-incident
   bij (12, 65, -26).
4. **Classic variant 1:** het midden van zone "West Lane" (-22, 4) ligt in een gele krat (variant-dekking); vangen werkt
   (y-tolerantie), maar de zonemarker staat in het blok.
5. *(Gerepareerd: de ladder begint met de rifle.)* **Gun Game begint met de shotgun.** Op grote open kaarten (classic, villa, yacht) duurde de eerste kill > 50 s: je ziet elkaar
   op 40–80 m en de shotgun doet daar niets. Overweeg een allround-wapen als eerste trede.
6. *(Gerepareerd: eindscherm zet de bescherming uit, leider alleen in het ladderpaneel, het paneel wijkt voor Tab.)* **HUD:** het "Spawn protection"-label schijnt door het eindscherm; in gun game staat "Leader: …" twee keer (onder de timer
   en in het ladderpaneel) en het scoreboard ligt over het ladderpaneel (`hud-gungame-board.jpg`).
7. **Dev-preview-race:** `game.arcadePreview()` aangeroepen voordat `start()` klaar is, wordt door `enterMenu()` weggegooid
   (wacht in tests op `game.world`).
8. *(Nog open, ronde 2 punt 3.)* **Yacht is niet helemaal eerlijk:** de rode spawn is vanaf 215 plekken op de blauwe helft te zien, de blauwe vanaf 71
   (`map-audit.ts`).

## Statische kaartaudit (`scripts/qa/map-audit.ts`)

Geen vallen (plekken waar je niet meer weg komt), niemand komt op of over de muur, alle spawns staan goed, alle zones en vlaggen
bereikbaar (behalve het krat-geval hierboven). Eerste contact 7–12 s lopen. Spawn naar spawn nergens zicht.

## Scripts

Servers: `PORT=3417 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts`, `QA_SERVER_PORT=3417 npx vite --config scripts/qa/vite.qa.config.mjs --port 5417`
(herstarten na elke codewijziging), `npx tsx scripts/qa/route-server.ts 5418`.

| Script | Wat |
|---|---|
| `map-audit.ts` | statische audit: bereikbaarheid, vallen, spawnzicht, objectives, lange lijnen |
| `walkgraph.ts`, `walk-routes.ts`, `walk-maps.py` | looptoer met echte fysica langs alle platforms en high ground |
| `play-modes.py` | elke mode × kaart met twee browsers: spawns, doel, rubber-banding, anti-cheat-tellers, screenshot |
| `hud-shots.py` | HUD-screenshots per mode (spelen, Tab, dood, einde) in de preview |
| `try-path.py`, `blocks-at.ts` | een vastloopplek reproduceren en de blokken eromheen tonen |
| `repro-death-end.py` | repro van bug 1 |
| `curate-shots.py` | screenshots verkleinen voor de repo |
| `realms-flow.py` | ronde 2: Realms via de menu's (snel spelen per mode, volle lobby, lobby's bekijken, privélobby, kaartstemming), met bots; `QA_SERVER_LOG` telt anti-cheat-hits |
| `weapon-check.py` | ronde 2: elk wapen × optiek in de preview (ADS, scope, adem, terugslag, herladen, wisselen, demper, killfeed) |
| `class-guard.ts` | ronde 2: klassen tegen de echte server (rommel, 3 s-venster, presets, `holds`, gun game) |
| `room-stall.ts` | ronde 2: hapert een lopende match als er lobby's worden geopend? |
| `arcade-perf.py` | 15 bots + 1 Chromium, frametijden en servertick (`QA_METRICS_TOKEN` bij een server met `ADMIN_TOKEN`) |

`play-modes.py` neemt nu `QA_ROUTES`, `QA_SERVER`, `QA_METRICS_TOKEN` en `QA_FILL_BOTS=n` (n bots erbij: spelen onder last).
