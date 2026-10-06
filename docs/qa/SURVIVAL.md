# QA: survival als nieuwe speler (singleplayer, multiplayer, WebKit)

Datum: 6 oktober 2026. Branch: `feature/bunkcraft-engine` (lokaal, met Realms-hub, placement guard, server-workers
voor chunks, mob cap per chunk en vloeiende remote players) gemerged in de QA-branch.
Machine: M1 Pro, Chromium 145 headless met `--use-angle=metal` (GPU: "ANGLE Metal Renderer: Apple M1 Pro"),
plus Playwright WebKit voor de basis. Eigen poorten: game-server :3481 (`ROOM_CREATE_LIMIT=1000`), Vite :5241
(`scripts/qa/vite.qa.config.ts`, geen HMR/watch, na elke codewijziging herstart).

## Hoe er gespeeld is

Alle input loopt via het spel zelf: `game.input.down/pressed` voor toetsen en muisknoppen, `game.input.mouseDX/DY`
om te kijken (nooit `page.mouse.move` met geforceerde lock), en echte DOM-klikken in menu's, receptenboek, oven,
betoveringstafel en inventory. De bot loopt, springt, hakt trappen, mijnt aders en raapt drops op.

| Script | Wat |
|---|---|
| `scripts/qa/survival.py` | Doorlopende sessie: menu → boom → planken/werkbank/houten pikhouweel → steen → stenen gereedschap + oven → kolen → fakkels → ijzer → schuilplaats → smelten → nacht → eten → harnas → fokken → bed → redstone → grot → betoveren → dood → opslaan/laden → instellingen → creative. `--browser webkit` voor WebKit. |
| `scripts/qa/scenarios.py` | Losse scenario's met een kleine, gelogde setup (item gegeven, mob voor je neergezet, klok verzet), daarna de mechaniek via echte input. Voor de latere fases waar de bot in de doorlopende sessie te vaak doodging. |
| `scripts/qa/survival_mp.py` | Twee spelers (Alice maakt een game via Multiplayer → Create Game, Bob komt binnen via de invite-link). |
| `scripts/qa/verify_fixes.py` | Controleert de fixes hieronder in de browser. |
| `scripts/qa/gl_probe.py` | Zoekt welk three.js-object een WebGL-fout geeft (zie bug 1). |
| `scripts/qa/qa_lib.py` | Gedeelde helpers (lopen, mijnen, graven, plaatsen, vechten, receptenboek, damage- en frame-log). |

Ruwe resultaten: `docs/qa/survival-run.json`, `scenarios-chromium-run.json`, `survival-mp-run.json`,
`survival-webkit-run.json`. Screenshots: `docs/qa/shots/`.

**Testshortcuts (eerlijk gemeld):** de klok is voor de nacht- en bedtests verzet (singleplayer heeft geen `/time`),
en scenario's krijgen hun items via `playerInventory.add`. Alles wat via een shortcut ging staat in de JSON onder
`setup` of `time_shortcuts`.

## Resultaat per stap (singleplayer, Chromium)

| Stap | Werkt? | Tijd / cijfers | Minecraft | Screenshot |
|---|---|---|---|---|
| Wereld maken via menu | ja | laden 0,2 s | | `shots/02_create.png`, `03_spawn.png` |
| Boom slaan met de hand | ja | 3,2 s per log (eerste 5,8 s incl. lopen), 10 logs in 41 s | 3,0 s | `04_tree.png` |
| Planken, stokken, werkbank, houten pikhouweel en zwaard (receptenboek) | ja | 11 s | | `07_inventory_wood_tools.png` |
| Steen met houten pikhouweel | ja | 1,22 s per blok, 18 cobblestone in 41 s | 1,15 s | `08_staircase.png` |
| Stenen pikhouweel, zwaard, oven | ja | 15 s | | `09_table_furnace.png` |
| Kolen | ja | 14 kolen in 105 s, 3 aders | | `10_coal.png` |
| Fakkels | ja | 2 kolen + stokken → 8 fakkels, block light 14 | 14 | `12_torch.png` |
| IJzererts (stenen pikhouweel) | ja | 11 raw iron in 85 s | | `11_iron.png` |
| Smelten in de oven (UI) | ja | 10 s per stuk, 11 staven in 108,6 s, 2 kolen verbruikt, XP level 1 | 10 s, 1 kool = 8 | `furnace_running.png`, `furnace_done.png` |
| Eten (rauw rundvlees) | ja | 1,69 s, honger +3, saturatie +1,8 | 1,6 s, +3 / +1,8 | |
| Koe doden (stenen zwaard) | ja | 2 slagen (10 → 5 → dood), 3 beef + 1 leer, 3 XP | 2 slagen | |
| Koeien fokken met tarwe | ja | 2 gevoerd, 1 kalf | | `sc_breeding.png` |
| IJzeren harnas aantrekken (rechtsklik) | **na fix** | 15 armor-punten | 15 | `sc_armor_hud.png` |
| Zombie-schade | ja | 3 per klap zonder harnas, 1,38 met volledig ijzer (Normal) | 3 / 1,38 | |
| Bed | ja | overdag "You can only sleep at night", met zombie dichtbij "You may not rest now, there are monsters nearby", alleen: 20:56 → 06:31, dag 2, respawnpunt gezet | idem | `sc_sleeping.png` |
| Redstone: hendel naast deur | ja | deur open/dicht | | `sc_lever_door.png` |
| Redstone: hendel → 2× stof → lamp | ja | lamp gaat aan | | `fix_lamp.png` |
| Betoveren (ijzeren pikhouweel, geen boekenkasten) | ja | 3 aanbiedingen (Efficiency I / Unbreaking I / Efficiency I), level 20 → 17, lapis 9 → 6 | | `sc_enchanting.png`, `sc_enchanted.png` |
| Val van 24 blokken, doodscherm | ja | "Player fell from a high place", 41 item-entities op de grond | | `sc_death_screen.png` |
| Respawn en spullen terughalen | ja | alles terug (3 stapels) | | |
| Opslaan → titelscherm → laden | ja | 0,7 s, positie, inventory, tijd, honger en 167 bewerkte chunks gelijk | | `23_pause_menu.png`, `24_world_list.png` |
| Instellingen (Options, Video, Sound, Controls, Key Binds) | ja | alle schermen open | | `25_options.png` … `29_keybinds.png` |
| Creative: tabs en zoeken | ja | 11 tabs, "diamond" geeft 22 items | | `33_creative_tab0.png`, `34_creative_search.png` |
| Creative: dubbel springen = vliegen | **na fix** | was ~50 % kans, nu 10/10 | | |

Framerate (Chromium, M1 Pro): mediaan 120 fps (vsync-cap), p10 120, laagste sample 108; CPU 1,3 tot 3 ms per
frame; slechtste frame 10 tot 33 ms (wereld laden, veel mobs). Geen console-errors behalve bug 1.

## Multiplayer (2 spelers, Chromium)

| Stap | Werkt? | Cijfers | Screenshot |
|---|---|---|---|
| Alice maakt een survival-game via Multiplayer → Create Game | ja | 3,2 s; **de eerste keer na het starten van de server 35,8 s** | `mp_01_create_game.png` |
| Bob komt binnen via de invite-link, ze zien elkaar | ja | remote players 1/1 | `mp_02_alice_sees_bob.png` |
| Alice slaat een log, Bob ziet hem verdwijnen | ja | | |
| Bob maakt en zet een werkbank, Alice ziet hem | ja | | `mp_03_bob_table.png` |
| Bob zet een blok op de plek waar Alice staat | geweigerd (goed) | | |
| Alice graaft steen | ja | 9 cobblestone | |
| `/time set night` door de eigenaar | ja | beide 19:16, chat "Alice set the time to night" | |
| Nacht | 16 tot 19 hostile mobs binnen 64 blokken bij beide spelers, in 100 s kwam er geen binnen ~12 blokken | | `mp_05_night_alice.png` |
| WebGL/console | 0 fouten, 108 tot 120 fps bij beide | | |

Niet gelukt of niet getest in multiplayer (bot of tijd): oven/kist op de server, slapen met twee spelers, fokken,
redstone, dood + drops zien bij de ander (`/kill` bestaat niet; zie "Niet getest").

## WebKit (basis)

Wereld maken, boom slaan (3,2 s per log), receptenboek, werkbank, houten en stenen gereedschap, steen hakken
(1,2 tot 1,4 s), opslaan/laden en alle instellingen-schermen werken zoals in Chromium. Headless WebKit haalt 34 tot
60 fps (laagste sample 12); dat zegt weinig over Safari met GPU. Screenshots: `shots/webkit_*.png`.

## Gefikste bugs (met regressietest)

| # | Bug | Fix | Test |
|---|---|---|---|
| F1 | **Dubbel springen om te vliegen werkte maar ~half.** De jump-druk leeft één frame, physics draait op 60 Hz; bij 120 fps draait elke tweede frame geen physics-stap, dus een druk op zo'n frame ging verloren. Ook gewone sprongen konden zo wegvallen. | `latchPress` in `src/core/InputMath.ts`: de druk blijft staan tot een physics-stap hem gebruikt (`Game.updatePlaying`). In de browser: 10/10. | `tests/jumpLatch.test.ts` |
| F2 | **Harnas aantrekken met rechtsklik werkte alleen als je naar een blok keek.** In de lucht kijken deed niets. | `wearsArmorOnUse` in `Interaction.ts`: overal, behalve als je op een bruikbaar blok (deur, kist, bed) klikt. | `tests/armorUse.test.ts` |
| F3 | **F3 toonde de omgekeerde windrichting** ("south (Towards positive Z)" terwijl je naar −Z kijkt), en na de merge stond de richting dubbel ("south (Towards positive Z) ()"). | `facingFromCameraYaw` in `src/core/Facing.ts`. | `tests/facing.test.ts` |
| F4 | **Twee "Advancement Made!"-toasts zodra een wereld laadt** ("Minecraft" en "Adventure") voordat je iets gedaan hebt. Vanilla tab-roots hebben `show_toast: false`. | `showsToast` in `Advancements.ts`, Game slaat de toast over. | `tests/advancements.test.ts` |
| F5 | **Gereedschap of harnas dat op is verdwijnt zonder geluid.** De speler merkt het pas als hij 15 s op ijzererts staat te slaan zonder drop (gebeurde de bot ook). | `PlayerInventory.onBreak` → breekgeluid. Deeltjes zoals in Minecraft ontbreken nog. | `tests/toolBreak.test.ts` |

## Openstaande bugs (geprioriteerd)

### 1. P1: chunk-mesh wordt soms niet getekend (WebGL "Vertex buffer is not big enough")
- **Wat de speler ziet:** een stuk terrein (één chunk-mesh) ontbreekt een paar seconden; in de console honderden
  `GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough for the draw call`.
- **Bewijs:** `gl_probe.py` hangt aan elk object een `gl.getError()`-check. Het foute object is een chunk-mesh
  (attributen `packed/data/tint`) met **6396 indices maar 3976 vertices** (6396 indices vragen 4264 vertices),
  `drawRange.count = null`. De fouten duren een paar seconden en verdwijnen als de chunk opnieuw gemesht wordt.
- **Hoe vaak:** in 3 van ongeveer 10 sessies, telkens in de eerste seconden na laden en vooral als de machine druk was
  (meerdere browsers tegelijk). Met een extra controle in `ChunkManager.setGeometry` (CPU-kant: grootste index <
  aantal vertices) kwam hij niet voor, en die controle vond ook geen foute data. De data is dus goed bij aankomst;
  het gaat mis tussen `setGeometry` en de upload.
- **Verdachten:** `gpuOnly()` geeft na de upload de ArrayBuffer terug aan de workers (`pool.recycle`), en
  `setGeometry` hergebruikt het `BufferGeometry`-object na `dispose()` (three.js registreert hem opnieuw). Als een
  index-buffer en vertex-buffers uit verschillende uploads aan elkaar raken (VAO/bindings-cache op `geometry.id`, of
  een gerecyclede buffer die nog niet geüpload was), krijg je precies dit.
- **Repro:** `python3 scripts/qa/gl_probe.py 5241` een paar keer, liefst met een tweede browser ernaast; of
  `scenarios.py` (de console-warnings staan in `scenarios-chromium-run.json`).
- **Opgelost.** Oorzaak zat in de mesher, niet in de upload: `GeometryBuilder` had 1,5 index per vertex aan
  capaciteit, maar dubbelzijdige quads (kruisplanten) maken 12 indices per 4 vertices. Chunk −2,3 van seed 4242
  (precies 3976 vertices en 6396 indices) schreef op een verse worker voorbij het einde; die schrijfacties vallen
  stil weg, dus de staart van de index-buffer hield oude bytes uit de buffer-pool. Nu 3 per vertex; regressietests
  in `tests/mesher.test.ts`, en `scripts/qa/chunk_gl_repro.py` (10 runs, CPU ×4, afstand 14: 0 GL-fouten).

### 2. P2: heks bij spawn: spawn-kill-lus 's nachts en de doodsboodschap mist de dader
- In de doorlopende sessie ging de speler na respawnen twee keer binnen een minuut opnieuw dood:
  `poison` 1 per tik plus `magic` 5 tot 6 per worp (gif- en harming-drankjes). Doodscherm: "Player was killed by
  magic" (`shots/death_witch_magic.png`). Minecraft: "Player was killed by Witch using magic".
- De worpen zelf kloppen met Minecraft (Instant Damage I = 6). Het probleem voor een nieuwe speler: spawnen in het
  donker met een heks in de buurt is onontkoombaar zonder bed, en de boodschap zegt niet wat je doodde.
- Fix (klein, niet gedaan omdat het in de effect-pijplijn zit): de werper meegeven aan het effect, zodat
  `deathMessage` "by Witch" kan zeggen.

### 3. P2: multiplayer: "unbacked drop" en een inventory die uit de pas loopt
- Eerste MP-run: de server logde `WARN unbacked drop {"name":"Bobby","item":266,"count":4,"mode":"enforce"}`
  (4 stokken). Bob had daarna geen planken meer voor zijn werkbank. In de tweede run (zelfde stappen) gebeurde het
  niet. Oorzaak niet gevonden; mogelijk een drop van de cursor-stack bij het sluiten van het receptenboek die de
  guard niet kent. Om te onderzoeken met de server-log en `survival_mp.py`.

### 4. P2: beide spelers spawnen op exact hetzelfde punt
- Alice en Bob staan allebei op `0.5, 65, 0.5` en zitten in elkaar (`mp_02_alice_sees_bob.png`: Bob is niet te
  zien). Minecraft spreidt nieuwe spelers binnen `spawnRadius` (10).
- **Opgelost:** de server zet een nieuwe speler op een droge plek binnen 10 blokken, gekozen uit de naam
  (`spreadSpawn` in `src/world/Spawn.ts`).

### 5. P3: spawn op een boomkruin
- Seed 779050144 en 4242: spawn op y 73, de grond eronder op y 64 tot 66. De eerste stappen geven valschade
  (2 HP in drie runs). Minecraft zoekt een vast grasblok.
- **Opgelost:** `findStandingSpot` (`src/world/Spawn.ts`) kiest de dichtstbijzijnde kolom binnen 8 blokken
  waarvan de bovenkant grond is, geen blad, stam, water of lava. Spawn-zoektocht en generator zijn ongewijzigd.

### 6. P3: de eerste multiplayer-game na het starten van de server duurt 36 s
- Daarna 3 s. Waarschijnlijk het opwarmen van de server-workers voor chunk-generatie. Een voortgangsmelding of een
  warme pool bij het starten scheelt de eerste speler veel wachten.

### 7. P3: kleinere dingen
- Betoverings-aanbiedingen staan alleen in de native browser-tooltip (`title`), niet in de Minecraft-stijl-tooltip
  die de rest van de UI gebruikt.
- Een lavapoel ligt 6 blokken van de spawn bij een grotingang (seed 779050144, rond 2, 52, −6). De bot liep er
  twee keer in. Geen bug, wel een harde eerste ervaring.
- `tests/mobAi.test.ts > path budget` faalt soms als de hele suite parallel draait (tijdslimiet), alleen draaien
  slaagt. Niet aangeraakt (ander team werkt aan mob-AI).
- Eén keer navigeerde de pagina tijdens een lange sessie zonder aanwijsbare oorzaak in de code (geen
  `location.reload` behalve in de PWA, en die is alleen in productie actief). Mogelijk testinfrastructuur. De
  harness logt navigaties nu (`qa.navigations`).

## Gevoel tegenover Minecraft

- **Tempo klopt.** Hakken (3,2 s per log, 1,2 s per steen met hout), smelten (10 s per stuk), eten (1,7 s) en
  zombieschade (3 per klap, 1,38 met ijzer) zitten op de vanilla-waarden. Een eerste uitrusting tot ijzer kost de
  bot ongeveer 7 minuten speeltijd (boom tot en met ijzer smelten).
- **De eerste nacht is pittig.** 16 tot 19 monsters binnen 64 blokken, heksen bij de spawn, lava vlakbij. Dat is
  Minecraft-achtig, maar zonder bed of schuilplaats ben je snel in een respawn-lus.
- **Feedback ontbrak** bij kapot gereedschap (nu geluid; deeltjes ontbreken nog) en bij de doodsoorzaak (heks).
- **Crafting via het receptenboek** is snel, maar een nieuwe speler moet over iconen hoveren om de naam te zien; de
  zoekfunctie helpt. Recepten voor de werkbank verschijnen pas als je er dichtbij staat, zoals in Minecraft.
- **Multiplayer voelt direct.** Blokken, werkbank en tijd verschijnen meteen bij de ander; de placement guard werkt.

## Niet getest

- Echte pointer lock en echte muisbewegingen (alles via `game.input`); geluid alleen als hook, niet beluisterd.
- Multiplayer: kist en oven op de server, slapen met twee spelers, fokken, redstone, drops na de dood bij de ander.
- Grotverkenning met fakkels en ertsen in een echte grot (de bot liep in lava), en lange-termijn honger.
- WebKit: nacht, gevecht, oven en betoveren.
- Safari met GPU (alleen headless WebKit).

## Herhalen

```bash
scripts/qa/start-servers.sh 3481 5241 /tmp/bc-srv           # eigen server + Vite, nooit poort 3000
python3 scripts/qa/survival.py --port 5241 --profile /tmp/bc-sp --new
python3 scripts/qa/scenarios.py --port 5241 --profile /tmp/bc-scen
python3 scripts/qa/survival_mp.py --port 5241 --scratch /tmp/bc-mp
python3 scripts/qa/survival.py --port 5241 --browser webkit --profile /tmp/bc-wk --new --phases tree,craft_wood,stone,stone_tools,save_reload,settings
python3 scripts/qa/verify_fixes.py 5241
kill $(cat /tmp/bc-srv/pids)
```
