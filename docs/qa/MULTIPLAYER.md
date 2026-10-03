# QA multiplayer (oktober 2026)

Getest op `feature/bunkcraft-engine` (stand na de merge van kisten/ovens op de server, redstone, groei, XP, mobs 2 en de
nieuwe arcade-modi). Alles via een eigen server (`ROOM_CREATE_LIMIT=1000`, eigen poort en `DATA_DIR`) en voor de
browsertests via de Vite-devproxy (`scripts/qa/vite.qa.config.ts`: geen HMR, geen watch).

## Kort

- **Werkt goed:** game maken via het menu, joinen via link en via code, chat, commando's en rechten, kick/ban/op/whitelist,
  bouwen samen, drops oppakken, gedeelde kisten (ook bij gelijktijdig grijpen), mobs 's nachts (iedereen ziet dezelfde),
  TNT, inventory en positie na reconnect, herstart van de server met automatisch terugkomen, en de volledige
  TDM-flow met 4 browsers (teams, HUD, killfeed, scorebord, eindscherm, volgende kaart).
- **Gerepareerd in deze ronde (met regressietests in `tests/multiplayerQa.test.ts`):** gelijktijdige blokwijzigingen gaven
  verschillende werelden, emmers/melk/stoofpot werden door de inventory guard "gecorrigeerd", en een typfout in een
  wachtwoord werd voor altijd hergebruikt.
- **Gerepareerd in ronde 2:** blokken plaatsen die je niet hebt (items uit het niets), schokkerige interpolatie van andere
  spelers, de te zware nacht voor vrienden bij elkaar, de wachtwoordlimiet over alle games en de blijvende doodsmelding.
  Zie *Ronde 2* hieronder.
- **Open:** zie *Nog open* onderaan *Ronde 2*.

## Gerepareerd

### 1. Gelijktijdig hetzelfde blok wijzigen gaf twee verschillende werelden (hoog)

Speler A plaatst steen, speler B op hetzelfde moment glas op dezelfde plek. De server verwerkte beide en stuurde elk alleen
naar de ander: A zag glas, B zag steen, de server (en wie later joinde) glas. Dat bleef zo tot iemand opnieuw joinde.

- Repro: `npx tsx scripts/qa/mp-sandbox.ts edits` (check *simultaneous edits*), of in de browser `mp_browser.py` (*block race*).
- Fix: de client stuurt in `block` mee welk blok-id hij zag (`prev`, optioneel veld, geen protocolversie nodig). Wijkt de
  server af, dan wordt de wijziging geweigerd en krijgt de afzender direct het serverblok terug. Alleen het id telt (niet de
  state), zodat groei of redstone geen klikken weigeren. Oude clients zonder `prev` werken zoals voorheen.

### 2. Inventory guard "corrigeerde" gewone acties (hoog)

In survival kreeg je *The server corrected your inventory* na water scheppen (emmer → wateremmer), water gieten, melk
drinken, stoofpot eten (kom komt terug) en een koe melken. Bij gieten kreeg je zelfs de wateremmer terug terwijl het water al
lag (water dupliceren).

- Repro: `npx tsx scripts/qa/mp-sandbox.ts guard`.
- Fix: `CONVERSIONS` in `server/InventoryGuard.ts` kent nu emmer ↔ water/lava/melk en elke `food.returns` (kom). Een
  `mobused` met `give` (melken) geeft krediet zoals een pickup.

### 3. Verkeerd wachtwoord werd steeds opnieuw gebruikt (middel)

Typfout bij een game met wachtwoord → "Wrong password." Daarna vroeg het menu nooit meer om het wachtwoord: het foute bleef in
het geheugen en ging bij elke poging mee, tot de pagina herladen werd. Elke poging telde ook mee voor de limiet van 5 per 10
minuten (en die limiet geldt per adres voor álle games).

- Repro: `mp_browser.py` (*after a typo the game asks for the password again*).
- Fix: `NetClient` vergeet het wachtwoord van die game bij een `kick` met `code: 'password'`.

## Ronde 2: de open bugs gerepareerd

### 4. Items uit het niets via plaatsen en breken (hoog, anti-cheat): gerepareerd

Een aangepaste client plaatste diamanterts, brak het en hield de diamant.

- Fix: `InventoryGuard.authorizeEdit` (aangeroepen in `GameServer.onBlock`, alleen survival met `inventoryGuard: enforce`)
  bepaalt per blokwijziging wat die kost (`classifyEdit`):
  - **plaatsen** boekt één item af: `itemFromState(id, meta)` (kleur- en houtvarianten blijven, richting/helft valt weg),
    redstone-stof → `redstone`, een slab op een slab (dubbel) kost een tweede slab, een andere kleur op dezelfde plek is
    een nieuw blok;
  - net gecraft maar nog geen `state` gestuurd: de guard craft het blok ter plekke uit de pool (log → planken → geplaatst);
  - **deuren en bedden**: de tweede helft is gratis, maar alleen direct na de betaalde eerste helft op de juiste plek;
  - **emmers**: gieten vraagt een volle emmer en geeft de lege terug, scheppen vult een lege;
  - **gratis**: breken, hendels/deuren/luiken omzetten, een tweede kist die een dubbele kist maakt, schoffel/schop/bijl
    (akkerland, pad, gestripte stam; schaar op pompoen geeft alleen zaadkrediet als je een schaar hebt);
  - creative en de eerste `state` na een modewissel worden niet gecontroleerd (`trustNextState`).
  Geweigerd → `reject`, de client zet het blok terug. Botten, vuur en groei door beendermeel doet de server zelf, die komen
  nooit als `block` binnen. Zaadjes planten bestaat in het spel nog niet.
- Tests: `tests/placementGuard.test.ts` plaatst **alle 507 creative-blokitems** (incl. varianten 1024+, slabs, trappen,
  deuren, bedden, planten, redstone) in zes richtingen met precies één item: nooit geweigerd en de pool is daarna leeg;
  zonder het item wordt elk geweigerd. Plus slab-dubbel, deur-/bedhelften, emmers, craft-op-plaatsen, gereedschap.
  `tests/containersServer.test.ts` controleert de weigering over echte WebSockets.
- QA-scripts: `mp-sandbox.ts` en `mp_browser.py` geven de bots hun blokken nu eerlijk (via een modewissel), want plaatsen
  uit het niets mag niet meer. `mp-sandbox.ts guard edits drops chest tnt persist restart`: alles PASS, ook *placing a
  block you do not own … does NOT create a diamond*.

### 5. Andere spelers bewegen schokkerig (middel): gerepareerd

- Server (`server/PoseTrail.ts`): de laatste `pos`-berichten staan op een ontvangsttijdlijn; elke Minecraft-snapshot toont
  de positie 60 ms in het verleden op een vaste tickklok (stapt per tick, trekt langzaam bij naar de echte tijd, springt bij
  een stall of teleport). Arcade houdt het nieuwste bericht (lag compensation is daarop gebouwd).
- Client (`RemotePlayers`): snapshots krijgen een tijdstempel op een vaste klok (één tick per snapshot) in plaats van het
  moment waarop de pagina het bericht afhandelde; na de nieuwste snapshot wordt maximaal 100 ms geëxtrapoleerd in plaats van
  stil te staan. Nog steeds 100 ms achter.
- Meting (`mp_interp.py`, nu op de frameklok van de game en met de machinebelasting erbij; de machine had een load van
  40–75 door andere processen, dus de getallen schommelen). A/B door elkaar, oude versie op eigen poorten:

| | Voor | Na |
|---|---|---|
| Stap per snapshot (verwacht 0,216) | 0 / 0,22 / 0,44 | 0,21–0,24 |
| Getekende snelheid, stdev | 17–34 % | 8–9 % (één uitschieter 30 % bij load 76) |
| Frames stilstand tijdens lopen | 30–242 van ~950 (3–25 %) | 0 |
| Gemiddelde snelheid (echt 4,317) | 4,4–5,0 | 4,25–4,34 |

  Bij lage load (eerder in de sessie, alleen de serverfix): stdev 5–10 %, 0 frames stilstand; zonder fix 31–34 %, 9–10 %.
- Test: `tests/poseTrail.test.ts` (ongelijke stappen met de oude manier, gelijke met de trail; teleport, yaw).

### 6. De nacht is te zwaar voor vrienden bij elkaar (middel): gerepareerd

- Fix: `hostileCapPerExtraPlayer` is weg. De cap schaalt zoals in Minecraft met het aantal chunks binnen 4 chunks van een
  speler, elke chunk één keer geteld (`capAreas` in `MobSpawner.ts`): drie spelers bij elkaar ≈ 1,2 × de
  singleplayer-cap (18 → ~22 in plaats van 34), spelers ver uit elkaar elk een volle cap (max 48).
- Tests: `tests/mobSpawner.test.ts` (chunks één keer tellen; drie spelers samen op middernacht krijgen ~singleplayer).
- Niet opnieuw met browsers gemeten (de 9 doden in 45 s); de cap is wel de oorzaak die het rapport aanwees.

### 7. Kleine dingen: gerepareerd

- **Wachtwoordlimiet** geldt nu per game én adres (`<code>|<ip>`). Test in `tests/serverRooms.test.ts`.
  `mp-sandbox.ts pwlimit` meldt nu *another game still works*.
- **Oude doodsmelding**: dat was de onzichtbare schermlezer-regio (`#sr-announcer`), die "You died. …" bewaarde. Respawnen
  leegt hem nu en het verbroken-scherm kondigt zijn eigen tekst aan.

### Nog open

- Na een geweigerde plaatsing krijgt de client alleen het blok terug, niet het item (de lokale inventory loopt dan één
  achter tot de volgende `state`). Bij eerlijk spel komt weigeren niet voor; een correctie sturen kan net gecrafte items
  wissen, daarom bewust niet gedaan.
- Ban op adres raakt huisgenoten (gedocumenteerd).
- Mobs 's nachts met 3 browsers opnieuw meten (`mp_browser.py`, sectie *mobs at night*).

## Wat goed werkt

- **Menu en uitnodigen:** Create Game → code en link in de chat, *Invite Friends* in het pauzemenu, de link vult de code in en
  verdwijnt na het joinen uit de adresbalk. Een code in kleine letters met streepje werkt, het joinscherm toont vooraf
  "Minecraft · Survival · 2/8 players". *Recent Games* werkt na Disconnect.
- **Commando's:** `/help` toont per speler alleen wat hij mag, `/time` en `/weather` bereiken iedereen, `/op`/`/deop`,
  `/kick` met reden, `/ban` en `/unban`, whitelist, `/tp`, `/spawn`, `/gamemode`, `/give` alleen in creative. Een op kan de
  eigenaar niet kicken. Namen zijn gebonden aan de browser (een tweede browser met dezelfde naam wordt geweigerd).
- **Bouwen:** edits komen binnen ~5 ms bij de ander. Buiten bereik, y = 0 en bedrock worden teruggedraaid. 60 edits in één
  keer: 20 geweigerd (bucket 20/s, burst 40), zoals bedoeld.
- **Drops:** wie het eerst `take` stuurt krijgt het item, precies één keer. Twee keer dezelfde drop sturen dupliceert niet.
  Ruwe drop-aantallen (lapis 4–9) en gekleurde blokken worden nu goed gecrediteerd (dat was in de eerste ronde nog fout en is
  intussen op de branch opgelost).
- **Kisten:** twee spelers openen dezelfde kist en zien wijzigingen live; tegelijk hetzelfde slot pakken levert de stack
  één keer op; wie het niet kreeg kan het ook niet "claimen"; een volle kist breken sluit het scherm en morst de inhoud één keer.
- **Mobs:** beide spelers zien dezelfde mobs (25/25 en 30/30 gedeeld, posities identiek). Samen een zombie doodslaan werkt,
  beiden zien de hurt-flash en de loot.
- **TNT:** lont ~4,1 s, beide spelers zien de TNT-entiteit en de explosie, een latere joiner ziet de krater (96/96 blokken).
- **Persistentie:** positie, inventory (met armor-slots en gereedschapsschade), health en honger komen terug na reconnect, en
  worden daarna niet gecorrigeerd. Na een doodsdrop wordt de lege inventory geaccepteerd.
- **Herstart:** SIGTERM → spelers krijgen "Server restarting" (close 1012, `reconnect: 8000`), de browser komt zelf terug;
  bouwwerk, positie en op-rechten zijn er nog.
- **Arcade (TDM, 4 browsers):** game maken via het menu (type, scorelimiet 10, 5 minuten, Rotate), 2 tegen 2, HUD voor
  iedereen, warm-up → live, geen friendly fire, kills met hitmarkers, doodscherm ("You were eliminated by Ann", spectaten),
  killfeed op alle vier schermen, eindscherm "Red team wins!" met scorebord, daarna de volgende kaart (classic → suburb) en
  alle vier clients joinen zelf opnieuw. Teambalans na vertrek: "RedTwo moved to the blue team to even the teams".

## Metingen

**Server, 4 spelers die rondlopen** (`npx tsx scripts/qa/mp-load.ts`, binaire `snap`/`ent`, M1 Pro):

| | Overdag | Middernacht |
|---|---|---|
| Mobs rond de spelers | 25 | 54 (o.a. 11 zombies, 9 skeletten, 8 creepers) |
| Server-CPU | 5,8 % van één core | 4,4 % |
| Tick p50 / p99 | 1,5 / 10,2 ms | 1,7 / 6,1 ms (budget 50) |
| Uitgaand totaal | 26 KiB/s | 56 KiB/s |
| Per speler binnen | 5–9 KiB/s | 11–17 KiB/s (waarvan `ent` 15,7) |
| `snap` | 19,4/s, gap p99 58 ms | 19,4/s, gap p99 55 ms |
| `ent` | 9,7/s | 9,7/s |

In de eerste minuut (chunks genereren) piekt de tick-p99 tot ~110 ms. Daarna ruim binnen het budget. Bandbreedte wordt
gedomineerd door `ent` (mobs): ~300 bytes per mob per seconde.

**Arcade:** 4 bots in TDM, ping in het scorebord 1–7 ms lokaal, killfeed op alle clients gelijk.

## Scripts

| Script | Wat |
|---|---|
| `scripts/qa/start-servers.sh [serverPoort] [vitePoort] [map]` | Wegwerpserver + Vite zonder HMR op eigen poorten |
| `npx tsx scripts/qa/mp-sandbox.ts [secties]` | Protocolbots: `rooms mod edits drops guard chest mobs tnt persist restart pwlimit` (eigen server op 3472) |
| `npx tsx scripts/qa/mp-arcade.ts` | TDM met 4 bots: teams, kills, eindstand, kaartrotatie, teambalans (eigen server op 3474) |
| `npx tsx scripts/qa/mp-load.ts [warmup] [meten]` | CPU, tick, bandbreedte, snapshot-cadans met 4 spelers (eigen server op 3473) |
| `python3 scripts/qa/mp_browser.py` | 3–4 browsers: menu, link, code, chat, commando's, bouwen, drops, nacht, reconnect, kick, wachtwoord, herstart (`QA_SERVER_PORT` + `QA_DATA_DIR` voor de herstart) |
| `python3 scripts/qa/mp_arcade_browser.py` | 4 browsers spelen TDM tot de scorelimiet en de volgende kaart |
| `python3 scripts/qa/mp_interp.py` | Hoe vloeiend een lopende speler getekend wordt |

Gotcha voor wie de browserscripts aanpast: een nieuwe wereld start in automatisering op "Click to play" (geen pointer lock),
dus `paused` telt als in de wereld; open het pauzemenu met `game.pause()` in plaats van Escape.
