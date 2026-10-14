# Kaarten: wat maakt een kleine shooterkaart leuk?

Onderzoek voor de Realms-shooterkaarten (oktober 2026). Vraag van Stijn: "de maps moeten leuker, iets als Nuketown".
Daarna: "Atomic Lane is te open, maak meer en leukere maps".

## Wat de beste kleine Black Ops 2-kaarten gemeen hebben

Nuketown, Hijacked, Raid, Standoff, Slums en Express zijn de kaarten die spelers na tien jaar nog noemen
([Nuketown-analyse](https://medium.com/@Shiiver/nuketown-level-analysis-1c61077928be),
[Activision Map Snapshot](https://blog.activision.com/call-of-duty/2019-10/Call-of-Duty-Mobile-Map-Snapshot-Nuketown),
[BO2-ranglijst](https://www.mmoexp.com/News/cod-black-ops-2-maps-ranked-all-launch-maps-tier-list-from-worst-to-best-number.html)).
Wat ze delen:

- **Drie lanes.** Twee flanken en een midden, met dwarsverbindingen. Raid en Standoff zijn het schoolvoorbeeld; zelfs
  Nuketown (huis, straat, huis) speelt zo: achter de bus, over de straat, achter de truck.
- **Korte weg naar het gevecht.** Nuketown: ~5 s van spawn tot eerste contact. Hijacked is zo klein dat je in drie
  seconden schiet. Geen lange looppartijen naar "waar het gebeurt".
- **Dekking om de paar meter, maar een paar bewuste lange lijnen.** Elk ander gevecht is close/medium; de lange lijn
  (Nuketown: raam tot raam, Express: langs de sporen) is een keuze, niet het hele midden.
- **Verticaliteit.** Ramen waar je uit springt, balkons, daken, een bovenverdieping: wie hoog staat ziet meer, maar staat
  ook bloot.
- **Herkenbare landmarks en set pieces.** De bus, de mannequins, het bubbelbad van Hijacked, het basketbalveld van Raid,
  het tankstation van Standoff. Je weet altijd waar je bent ("bij de bus") en het praat makkelijk in een team.
- **Interieurs die kloppen.** Een keuken, een slaapkamer, een garage: plekken met een eigen soort gevecht (deurposten,
  hoeken, trappen).
- **Geen dode zones.** Elke plek ligt op een route; er is geen stuk kaart waar nooit iemand komt.
- **Eerlijk.** (Punt)symmetrie, spawns die je niet vanaf de vijandelijke helft kunt beschieten.

## Hoe we meten

Alle scripts draaien zonder browser of server:

| Script | Meet |
|---|---|
| `scripts/map-metrics.ts` | `cover%` (dichte vloer), `freepath` (hoe ver je gemiddeld kijkt), `vis%` (gemiddeld deel van de vloer dat je ziet), `ctr%` (deel van de vloer zichtbaar vanuit het midden) |
| `scripts/qa/map-flow.ts` | Botsimulatie 6 tegen 6 (eerlijke routes, kogeltrace, simpel TTK-model): `first` (start tot eerste zicht), `spawn→see` (spawn tot eerste vijand in zicht), `gap` (tijd zonder vijand tussen gevechten), `kpm`, `range` (mediane gevechtsafstand), `long%` (tijd dat je een vijand > 40 blokken ver ziet) |
| `scripts/qa/map-audit.ts` | Bereikbaarheid (ook via jump pads), vallen, spawn-blootstelling (plekken op de vijandelijke helft die in een spawn kijken), looptijd spawn tot spawn |
| `scripts/ascii-map.ts` | Bovenaanzicht in tekst, hele kaart voor vrije kaarten |

De botsimulatie is optimistisch (360° zicht, perfecte routes): vergelijk kaarten onderling en voor/na, niet met echte
potjes. Gevechten starten binnen 40 blokken; zicht verder weg telt als `long%`.

## Oordeel per kaart (vóór deze ronde)

| Kaart | vis% | range | spawn→see | lopen spawn-spawn | vijand ziet spawn | Oordeel |
|---|---|---|---|---|---|---|
| Classic | 23,7 | 35 | 3,3 s | 9,9 s | 1554 plekken | Groot, vlak en open (96 × 96). Lange lijnen over het hele veld, spawns te beschieten vanaf de vijandelijke helft. Saai, maar blijft de standaard voor oude saves. |
| Maple Court | 15,4 | 36 | 2,6 s | 7,3 s | 90 | Klein en snel, maar de straat is één lange rechte lijn en een spawn lag in het verlengde van beide garagedeuren. Geen vlaggen. |
| Old Quarter | 8,8 | 26 | 4,9 s | 10,1 s | 14 | Dicht genoeg, maar groot: lange wandelingen door 4 brede steegjes. Een spawn was te zien vanaf het poortgebouwdak. |
| Harbor Yard | 7,4 | 19 | 6,3 s | 11,1 s | 106 | Containerdoolhof: traag (langste spawn→see), weinig landmark behalve het schip, en vanaf het scheepsdek keek je in een spawn. |
| Dust Bazaar | 8,3 | 29 | 5,8 s | 11,7 s | 0 | Bewust een lange-lijnenkaart, maar traag en zonder objectives (geen hardpoint/domination/CTF). |
| Atomic Lane (oud) | 29,6 | 38 | 3,3 s | 10,1 s | 6 | De opzet klopte (twee huizen, bus, rotonde), maar het midden was een leeg grasveld en een lege straat: de meest open kaart van allemaal, gevechten op maximale afstand, kale huizen. |
| Bunker Flag | 12,1 | 27 | 3,6 s | 9,2 s | 0 | Prima CTF-kaart, weinig verticaliteit. |
| Skyline Villa | 15,8 | 30 | 5,0 s | 12,3 s | 0 | Mooi, maar groot (88 × 64) en traag; lange lijnen over het gazon. |
| Riptide | 18,2 | 26 | 4,3 s | 10,3 s | 0 | Sterk set piece; het water rond het jacht is open en leeg. |
| Sundown | 12,8 | 32 | 4,2 s | 10,4 s | 0 | Goede drie lanes, iets groot. |
| Terminus | 10,9 | 25 | 5,8 s | 12,2 s | 0 | Mooi station, maar traag: langste looptijd. |

## Wat er veranderd is

**Atomic Lane, het visitekaartje** (72 × 48, was 80 × 52): twee huizen van twee verdiepingen met een volledig interieur
(geblokte keuken met koelkast en fornuis, woonkamer met tv, trap, kinderkamer, slaapkamer met mannequin), open ramen
boven, verandadak, garage met plat dak (kratten of jump pad) en een zijraam naar boven, schuttingen rond de achtertuin,
een schommeltuin en een zwembadtuin, een doorloopbare schoolbus en verhuiswagen, een heg rond een grote boom op de
rotonde, geparkeerde auto's, tuinmuren, brievenbussen. Kleurrijk jaren 50: geel tegenover mint.

| Atomic Lane | vis% | ctr% | range | long% | spawn→see | lopen spawn-spawn | vijand ziet spawn |
|---|---|---|---|---|---|---|---|
| Oud | 29,6 | 31,5 | 38 | 11,6 | 3,3 s | 10,1 s | 6 |
| Nieuw | 11,0 | 10,4 | 25 | 1,2 | 3,5 s | 9,0 s | 0 |

Zichtbare vloer van bijna een derde naar een negende, gevechten op 25 in plaats van 38 blokken, lange lijnen bijna weg; de tijd tot het eerste
zicht blijft ~3,5 s.

**Zes nieuwe kleine kaarten** (60–72 breed, allemaal drie lanes, landmark, verticaliteit, zones, vlaggen en bomplaatsen):

| Kaart | Landmark | vis% | range | long% | spawn→see | lopen spawn-spawn | kpm |
|---|---|---|---|---|---|---|---|
| Fountain Square (`plaza`) | fontein met gouden beeld, tram | 13,1 | 25 | 0,7 | 3,5 s | 9,2 s | 61 |
| Rebar (`site`) | betonnen casco met atrium, kranen | 14,2 | 23 | 0,5 | 3,3 s | 8,4 s | 65 |
| Flight Deck (`carrier`) | jets, eilanden met brug, helikopter | 17,0 | 22 | 0,8 | 3,8 s | 9,7 s | 61 |
| Tin Roofs (`shanty`) | watertoren, dakbruggen | 11,3 | 20 | 0,0 | 4,0 s | 8,8 s | 59 |
| Galleria (`mall`) | draaimolen onder lichtkoepel, bowling | 17,5 | 31 | 1,7 | 3,1 s | 7,8 s | 64 |
| Scrapyard (`scrap`) | portaalkraan met auto aan de magneet | 12,4 | 22 | 0,1 | 3,2 s | 8,0 s | 65 |

Ter vergelijking de oude grote kaarten: spawn→see 4,1–6,4 s, lopen 10–12 s, kpm 47–57.

**Oudere kaarten**: Maple Court, Old Quarter en Harbor Yard hebben elk één spawn per kwadrant verplaatst; geen enkele plek
op de vijandelijke helft kijkt nog in een spawn (alle kaarten, ook Classic, staan nu in `tests/spawnExposure.test.ts`).
Dust Bazaar kreeg zones en vlaggen, Maple Court vlaggen, zodat elke kaart elke mode kan hosten.

**Classic, compact** (72 × 72, was 96 × 96): de kaart-id en het kwadrantensysteem blijven (oude arena-saves behouden hun
kaart-id, maar de geometrie is nieuw). Twee gesloten bases met deuren in de zijmuur en een tweede deur in de voormuur
waarvan de zichtlijnen in de corridormuur eindigen (geen enkele plek op de vijandelijke helft ziet nog een spawn: 1554
plekken naar 0), de lange noord-zuidlijn in het midden is met muurtjes en kratten in stukken gehakt, de uitkijkpost
heeft een jump pad vanuit het achterveld. Bomplaatsen, zones en vlaggen staan op nieuwe plekken (alle kaarttests groen).

| Classic | vis% | range | long% | first | spawn→see | kpm | lopen spawn-spawn | vijand ziet spawn |
|---|---|---|---|---|---|---|---|---|
| Oud (96 × 96) | 23,7 | 34 | 8,5 | 4,0 s | 3,2 s | 54,1 | 9,9 s | 1730 |
| Nieuw (72 × 72) | 11,5 | 24 | 0,6 | 3,2 s | 4,1 s | 56,4 | 8,6-9,0 s | 0 |

`spawn→see` is langer omdat spawns niet meer vanaf de vijandelijke helft te beschieten zijn; de rest is korter en dichter.

**Jump pads** liggen waar een route anders traag of onmogelijk is: oprit naar garagedak (Atomic Lane), plein naar
galerijdak en hotelbalkon (Fountain Square), atrium naar de eerste verdieping (Rebar), steeg naar krotdak (Tin Roofs),
gang naar de mezzanine (Galleria), bandenberg naar autostapel (Scrapyard). Een pad naast de liftrand op Flight Deck gaf
onder netwerkachterstand een `fly`-correctie en is toen weggehaald. De oorzaak zat in de bewegingsvalidator (afzet van
een pad die de rechte lijn tussen twee `pos` net mist, een muur die als grond gold) en is verholpen; de pads van de
lift zijn als regressietest teruggelegd (`tests/anticheatMovement.test.ts`) en liggen sinds de validator-fix ook weer op
de kaart zelf (`carrier.ts`, naast de liftrand).

## Reuzenhuis-kaarten (de_rats-gedachte)

Drie kaarten waar je een muis in een gewoon huis bent (alleen de mechaniek, eigen namen en indelingen): `pantry` (keuken),
`couch` (woonkamer) en `workshop` (garage), 68 × 44, puntsymmetrisch met een eigen palet per helft. Het meubilair is het level:
tafels, banken en een werkbank als hoog terrein met hellingen van boeken, dozen en kisten (jump pad via een autoband op de
werkbank), poten als pilaren, tunnels onder bank, salontafel en speelgoedauto, borden/blikken/dozen als dekking, een stopcontact
en een tegelvloer als schaalhint. Gedeelde bouwstenen staan in `src/modes/maps/giant.ts`. Vlaggen, zones en bomplaatsen staan in
alle drie (alle modes werken); alle kaarttests, spawnExposure (0 plekken) en de anticheat-bewegingsreplay zijn groen.

| Kaart | vis% | range | long% | first | spawn→see | gap | kpm |
|---|---|---|---|---|---|---|---|
| Atomic Lane (ter vergelijking) | 17,2 | 29 | 2,8 | 2,1 s | 3,3 s | 2,9 s | 64,7 |
| Pantry Panic | 13,7 | 23 | 2,7 | 2,5 s | 3,6 s | 3,1 s | 61,2 |
| Couch Canyon | 10,9 | 20 | 0,0 | 4,4 s | 4,1 s | 3,3 s | 59,6 |
| Workbench Run | 10,6 | 21 | 0,2 | 3,6 s | 3,9 s | 3,3 s | 60,0 |

Gevechten beginnen dichter bij (20-23 tegen 29 blokken) en lange lijnen zijn weg, maar de eerste contacten komen later
(Couch Canyon ~2 s later dan Atomic Lane: de bibliotheekkast en de luidspreker sluiten de lanes af bij het midden). Eerste les bij het
bouwen: bots lopen langs de rand tussen lane en midden, dus de lange lijnen zaten niet in de lanes zelf maar op die rand; een
blokker van 3-4 breed en 7-8 hoog op elke rand bracht `long%` van 11 naar 0. Schermafbeeldingen: `docs/screenshots/maps/{pantry,couch,workshop}-*.png`.

### Reuzenhuis ronde 2: dichte kamer (plafond, schaalhints)

De open lucht en lage muren maakten van het meubilair blokken. Nu zijn de drie kaarten een echte kamer:

- **Engine**: `room?: { ceiling, playHeight }` op `ArenaMapDef`/`FreeArenaMapDef`. `wallHeight` is dan de kamerhoogte (40), de dekkingsopslag
  loopt door tot `ceiling` (42 lagen i.p.v. `MAX_COVER` = 10) en de laag boven de muur (het plafond) ligt ook over de muurring
  (`ArenaMap.aboveWall`). `playHeight` (14) is wat `heightAt` (zones, vlaggen) nog als oppervlak telt, zodat wat aan het plafond hangt
  of tegen de muur zit nooit een oppervlak wordt. Kaarten zonder `room` zijn byte-identiek: `tests/room.test.ts` heeft gouden hashes van
  alle 17 andere kaarten (genomen voor deze wijziging) en test dat elke roomkaart een dicht plafond heeft. Chunkhoogte 128 en vloer 64
  geven plaats tot laag 63; de kamer gebruikt 42.
- **Licht**: nieuw blok `CEILING` (id 234, textuur van calciet, `transparent` + `lightFilter 0`, onzichtbaar in de inventaris). Het is
  solide (kogels, granaten en spelers stuiten) maar laat skylight rechtdoor vallen, dus de kamer blijft even helder als de open arena;
  zeelantaarns in het plafond zijn de lichtpanelen en de hanglamp (alleen optisch: blokslicht reikt 15 blokken). Let op: in de preview
  deed de schaduwpass niet mee (0 shadow-calls); met schaduwen aan werpt het plafond schaduw over de hele kamer (de zon telt dan niet
  meer mee, ambient/skylight blijft), nog niet apart beoordeeld.
- **Prestaties** (Chromium `--use-angle=metal`, 1280 × 720, drie standpunten): atomic en pantry halen allebei de 120 FPS-vsync
  (p50 8,3 ms, p99 10,3 ms); drawcalls 79 (atomic) tegen 54 (pantry), driehoeken 52k tegen 60k. Het plafond is één greedy vlak per chunk.
- **Schaalhints**: raam met gordijnen en vensterbank, deur met een lichtstreep eronder en paneelnaden, klok, drie posters, plinten,
  handvatten en ladevoorkant op het aanrecht, stekker van de broodrooster in het stopcontact, en een munt, kroonkurk en potlood op
  de vloer (pantry), speelgoedblokjes en een sok (couch), een potlood en tl-lichtpanelen (workshop). Props staan buiten de
  looplijnen: een munt onder de deegrollerbrug zette `first` van 2,5 naar 3,2 s en een kroonkurk/munt bij de vlag brak de vlagtest
  (`map-flow`/`mapObjectives`), dus die staan nu op randen.
- **Flow** (`map-flow`, kaartvergelijking met ronde 1): Pantry 2,6/3,7/3,1 s (ronde 1: 2,5/3,6/3,1), Couch 4,6/4,1/3,3 (4,4/4,1/3,3),
  Workshop 3,4/3,9/3,3 (3,6/3,9/3,3): first/spawn→see/gap, geen verslechtering.
- Schermafbeeldingen: `docs/screenshots/maps/{pantry,couch,workshop}-{room,ceiling,window,door,...}.png` (`scripts/shots.py`; de
  `top`-view zit nu onder het plafond, op 39 blokken).

## Wat nog beter kan

- **Classic** is compact gemaakt (zie boven); echte playtests moeten uitwijzen of de deuren van de bases niet te veel kampeerplekken geven.
- **Skyline Villa, Terminus, Harbor Yard** zijn 88 breed: inkorten naar ~72 of jump pads op de lange routes (Terminus:
  perron naar loopbrug; Villa: gazon naar dakterras) zou spawn→see onder 4 s brengen.
- **Riptide**: drijvende dekking (steigers, boten) op het open water rond het jacht.
- De bowlingbaan en het bioscoopfoyer van Galleria zijn nog kaal; de muren van de huizen in Atomic Lane missen
  details (lijsten, schilderijen kunnen niet zonder blockstates).
- Echte playtests: de botsimulatie mist zichtveld, geluid en gedrag. `docs/qa/ARCADE.md` per kaart bijwerken na een
  potje met mensen.
