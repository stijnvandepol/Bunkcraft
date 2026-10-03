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
- **Open:** blokken plaatsen die je niet hebt (items uit het niets), schokkerige interpolatie van andere spelers, en de nacht
  is erg zwaar als vrienden bij elkaar staan.

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

## Open bugs (geprioriteerd)

### 1. Items uit het niets via plaatsen en breken (hoog, anti-cheat)

De server controleert bij `block` niet of je het blok hebt. Een aangepaste client plaatst diamanterts, breekt het, laat de
diamant vallen (gedekt door het breekkrediet), raapt hem op en de inventory wordt geaccepteerd.

- Repro: `npx tsx scripts/qa/mp-sandbox.ts guard` (check *placing a block you do not own*).
- Voorstel: bij plaatsen in survival het item van de pool afboeken (`spendTransfer` op `itemFromState(id, meta)`) en
  weigeren als het er niet is. Let op: dan moet de client vlak na craften eerst een `state` sturen, anders worden legitiem
  gecrafte blokken geweigerd. Een goedkopere tussenstap: breekkrediet niet geven voor blokken die dezelfde speler de
  laatste 60 s zelf plaatste en die hij niet in zijn pool had.

### 2. Andere spelers bewegen schokkerig (middel)

Een bot loopt met precies 4,32 blokken/s en stuurt 20 keer per seconde zijn positie; een browser op 120 fps tekent hem.

| Meting | Waarde |
|---|---|
| Snapshots aankomst | regelmatig, 48–55 ms |
| Stap per snapshot (verwacht 0,216) | wisselend 0 / 0,22 / 0,44 |
| Getekende snelheid | gemiddeld 4,6–4,8 b/s, stdev 26–29 % |
| Frames zonder beweging tijdens lopen | 7–10 % |

Oorzaak: de server zet in elke 20 Hz-tick de laatst ontvangen positie in `snap`. De `pos`-berichten van de client komen ook
op 20 Hz maar niet in fase met de tick, dus soms staan er twee in één tick en soms geen: de beweging stottert, ook al komt
alles netjes binnen.

- Repro: `python3 scripts/qa/mp_interp.py` (met `start-servers.sh`).
- Voorstel: een volgnummer of client-tijd in `pos` en de remote buffer interpoleren op die tijdlijn, of de server de positie
  laten bemonsteren op ontvangsttijd (lineair tussen de laatste twee `pos`).

### 3. De nacht is te zwaar voor vrienden die bij elkaar staan (middel, balans)

Drie spelers staan stil bij de spawn (geen wapens, niet vechten). Na `/time set midnight` gingen ze in 45 s **negen keer**
dood. De mobcap telt per extra speler 8 vijanden bij (`hostileCapPerExtraPlayer`), maar al die vijanden komen op dezelfde
plek af als de spelers samen staan: drie keer de dichtheid van singleplayer.

- Repro: `mp_browser.py` (sectie *mobs at night*, regels *X died*).
- Voorstel: de extra cap alleen geven voor spelers die ver uit elkaar staan (bijv. > 64 blokken), of de cap per groep spelers
  in plaats van per speler.

### 4. Kleine dingen (laag)

- **Wachtwoordlimiet geldt per adres over alle games.** Vijf typfouten van één huisgenoot blokkeren het hele huishouden 10
  minuten voor elke game met wachtwoord (`mp-sandbox.ts pwlimit`). Overweeg de limiet per adres én per game.
- **Ban op adres raakt huisgenoten** (gedocumenteerd). In de test kwam een tweede speler van hetzelfde IP niet meer binnen.
- **Melding na herstart** toonde nog de oude doodsmelding eronder: *Server restarting. Reconnecting automatically... /
  You died. Alice was slain by Zombie*.
- **Docs:** `SERVER.md` noemde `/weather` een stub en zei dat kisten niet bestaan; bijgewerkt.

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
