# QA: arcade-modes speeltest

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

1. **Anti-cheat: eerlijke bunny-hopper gecorrigeerd** (`speed`, yacht; en twee `lag`-correcties). Alleen gezien onder zware
   CPU-belasting (frame-haperingen). Daarnaast faalt `tests/anticheatMovement.test.ts` op town al op de huidige branch
   (`noclip` bij smg ADSL en sniper-bursts), ook zonder mijn kaartwijziging. Voor de anti-cheat-agent: de bewegingsvalidator en de
   clientfysica zijn het op town (en mogelijk bij slabs) niet eens.
2. **Integratietests `arcade.tdm/ffa.it.test.ts` ("kill within 40 shots")** faalden tijdens de speeltest onder belasting; los
   gedraaid niet opnieuw onderzocht.
3. **Villa: verzonken stenen pad (bottom slabs in de vloerlaag, x ±10..14).** Vanaf het pad (y 64,5) is een richel van 1 blok
   1,5 hoog: daar kun je niet op springen, wel overal ernaast. Voelt als een onzichtbare muur. Shot: `walk-villa`-incident
   bij (12, 65, -26).
4. **Classic variant 1:** het midden van zone "West Lane" (-22, 4) ligt in een gele krat (variant-dekking); vangen werkt
   (y-tolerantie), maar de zonemarker staat in het blok.
5. **Gun Game begint met de shotgun.** Op grote open kaarten (classic, villa, yacht) duurde de eerste kill > 50 s: je ziet elkaar
   op 40–80 m en de shotgun doet daar niets. Overweeg een allround-wapen als eerste trede.
6. **HUD:** het "Spawn protection"-label schijnt door het eindscherm; in gun game staat "Leader: …" twee keer (onder de timer
   en in het ladderpaneel) en het scoreboard ligt over het ladderpaneel (`hud-gungame-board.jpg`).
7. **Dev-preview-race:** `game.arcadePreview()` aangeroepen voordat `start()` klaar is, wordt door `enterMenu()` weggegooid
   (wacht in tests op `game.world`).
8. **Yacht is niet helemaal eerlijk:** de rode spawn is vanaf 215 plekken op de blauwe helft te zien, de blauwe vanaf 71
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
