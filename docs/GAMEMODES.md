# BunkCraft game types

Singleplayer en **Multiplayer** zijn Minecraft: Multiplayer maakt, toont en joint alleen Minecraft-games. De twaalf
**arcade-game types** (snel, wapens met hitscan, een vaste arena) zitten onder **BunkCraft Realms** op het titelscherm.
Het contract staat in `src/modes/GameTypes.ts`, `src/modes/Weapons.ts` en het arcade-deel van `src/net/protocol.ts`.
Dit document beschrijft de **client**; de server (match, hitscan, health, respawn) staat in `docs/SERVER.md`.

## BunkCraft Realms (de minigames-hub)

Opbouw zoals de wereld- en serverlijst van Minecraft 1.21 (`src/ui/RealmsMenu.ts`, stijl in `src/ui/realms.css`,
alle teksten NL/EN in `src/ui/i18n.ts` onder `realms.*` en `lobby.*`):

- **Naam:** de eerste keer vraagt Realms een spelersnaam (3-16 tekens). Die wordt in deze browser onthouden
  (`bunkcraft.name`, `src/ui/playerName.ts`) en is dezelfde naam als bij Multiplayer. *Naam wijzigen...* staat in de kop.
- **Playlist:** een rij per mode met een eigen 16×16-pixelicoon (`src/ui/RealmsIcons.ts`, in code getekend), naam,
  korte uitleg en live "N spelers in M lobby's" (`GET /api/realms`, elke 5 s ververst). Dubbelklikken, Enter, het
  play-pijltje op het icoon of **Snel spelen** start matchmaking voor de gekozen mode.
- **Snel spelen** (`POST /api/quickplay { gameType }`): de server kiest de **volste openbare lobby** van die mode die nog
  plek heeft en niet bijna klaar is (live met minder dan 75 s over, of de leider op 80% van de limiet; bij rondemodes telt
  alleen de stand). Bij gelijke drukte wint een lobby in warm-up of tussen twee potjes. Is er geen, dan opent de server een
  nieuwe openbare lobby met wisselende kaarten (start op een willekeurige kaart die de mode ondersteunt) en de standaard-
  limieten. De regels zijn puur en getest: `src/modes/Realms.ts` (`pickLobby`, `joinable`).
- **Lobby's bekijken:** alle openbare arcade-lobby's (mode, kaart die nu gespeeld wordt of "Wisselende maps",
  spelers/max, fase en resterende tijd), filterbaar per mode. Lobby's met een wachtwoord tonen "Wachtwoord" en vragen het.
- **Privélobby:** mode, kaart (alleen kaarten met de data die de mode nodig heeft, of *Wisselend (stemmen)*), score- en
  tijdslimiet uit `GameTypeDef.options`, **Max. spelers** (2-16; het menu biedt alleen groottes tot `ROOM_MAX_PLAYERS`, dat `/api/server` als `roomMaxPlayers` meldt) en
  *Tonen bij Lobby's bekijken*. Daarna verschijnt de code en de uitnodigingslink, met **Spelen**.
- **Code invoeren:** joint elke code of link. Een code van een Realms-lobby die bij Multiplayer wordt ingetypt, of een
  uitnodigingslink (`?join=CODE`) naar een arcade-game, gaat via Realms. Wie een Realms-match verlaat komt terug in de
  playlist.

**In de lobby** (`src/ui/MatchLobby.ts`, gestuurd door `ArcadeSession`): tijdens de warm-up (en tussen rondes) staat
rechts een paneel met mode, kaart, "Wacht op spelers (1/2)" of "Het potje begint over N" en de spelers per team (of
één lijst bij ffa/gun game); de grote banner onder de timer zegt hetzelfde. **Kaartstemming:** in lobby's met wisselende
kaarten biedt de server na elk potje drie kaarten aan (de volgende uit de rotatie eerst, plus twee willekeurige die de
mode ondersteunt). Stemmen met 1, 2, 3 (de wapentoetsen), aanpassen mag; meeste stemmen wint, gelijk = de rotatiekaart.
De pauze tussen potjes duurt dan 12 + 10 s. Server-autoritair: `vote`-berichten (client → `{ t: 'vote', map }`,
server → `{ t: 'vote', options, counts, mine?, endsIn }`), additief op protocol v4; oudere clients negeren ze.

**Open lobby's** (door Snel spelen geopend, zonder eigenaar) bewaren geen namen: een naam is alleen bezet zolang iemand
ermee speelt, zodat een vreemde met dezelfde naam je niet uit de lobby duwt en jij er later met een andere browser weer in
kunt.

## Party's (samen in dezelfde lobby en hetzelfde team)

Vrienden groeperen zich in een **party** (maximaal 6) en spelen samen. Op de home staat een paneel **Party**
(`src/ui/PartyPanel.ts`, tussen Lobby's/Privéwedstrijd en "Speel met vrienden"):

- **Maken en joinen:** *Party maken* geeft een code van 5 tekens (alfabet van de lobbycodes zonder I, L, O, 0, 1) en een
  link (`/?party=CODE`, knop *Link kopiëren*). Iemand anders typt de code in het partyveld (of in het gewone codeveld op de home:
  vijf tekens of een `?party=`-link betekent party, zes tekens een lobby) of opent de link. Een lobbycode en een partycode
  zijn dus nooit te verwarren.
- **Paneel:** per lid het rang-icoon (level of prestige, een gast heeft er geen), de naam, een kroon voor de leider en een
  chip: *Klaar* / *Niet klaar* / *Offline* / *In een potje*. De leider heeft per lid twee knoppen: leider maken en
  verwijderen. *Verlaten* staat in de kop. Een leesregel (`aria-live`) meldt wie er bijkomt of weggaat.
- **Leider en leden:** de leider kiest de mode (de playlist van de leden volgt) en drukt op **PLAY**: dat is Snel spelen voor
  de hele party. De PLAY-knop van een lid is **KLAAR** (aan/uit); klaar-vlaggen zijn informatief (de leider kan altijd
  starten) en worden na elke start gewist. De leider kan ook een lobby uit *Lobby's* of een code kiezen, of een privélobby
  starten: dat gaat ook voor de hele party (een lid dat zelf een lobby kiest krijgt "Alleen de leider kiest de lobby").
- **Matchmaking voor een party** (`src/modes/Realms.ts`: `partyFits`, `pickLobby(..., partySize)`; server in
  `Rooms.quickPlay`/`Rooms.joinLobby`): alleen een lobby waar de **hele party** past: genoeg plekken (mensen + vastgehouden
  plekken van andere party's; bots geven plek op) en, in teammodi met mensen erin, een team dat ze allemaal kan nemen zonder
  dat de lobby scheef gaat (kleinste team + partygrootte ≤ de helft van de plekken, naar boven afgerond). Past ze nergens, dan
  opent de server een nieuwe openbare lobby; die vult met bots tot twee keer de partygrootte (maximaal de lobbygrootte).
  Een party groter dan `ROOM_MAX_PLAYERS` krijgt "te klein". Vrije-voor-allen-modi en infected kennen geen teamlimiet.
- **Plekken vasthouden:** de server houdt de plekken in de gekozen lobby **45 s** vast (`GameServer.reserve`). Vreemden
  kunnen ze niet innemen, bots in een volle quick-play-lobby stappen op en blijven weg (`BotHost.reserved`,
  `BotManager.makeRoom(team)`); lukt het niet binnen 45 s, dan komen de bots terug. Een lid verbindt met de sleutel van het
  ticket in `hello.party`; de sleutel hoort bij die ene lobby en is voor niemand anders te raden (128 bit).
- **Zelfde team:** bij het vasthouden kiest de server het kleinste team (vastgehouden plekken meegeteld); elk lid dat met de
  sleutel binnenkomt gaat daarheen (`Match.join(..., { party, team })`). De balans (`planBalance`, `rebalance` na een potje)
  verplaatst nooit iemand weg van zijn party: alleen spelers zonder partygenoot in de match komen in aanmerking.
- **Na het potje** blijft de party bestaan; elke speler komt terug op de home met het paneel, de leider drukt opnieuw op PLAY.
  Leden die nog in een ander potje zitten (status *In een potje*) of offline zijn worden niet meegeteld en krijgen geen plek.
- **Server-autoritair, in het geheugen, met verloop** (`server/Parties.ts`, `src/modes/Party.ts`): clients pollen elke 1,5 s
  (4 s tijdens een potje) `GET /api/party`; de server pusht niets. Een lid is *offline* na 12 s zonder poll, wordt na 5 min
  verwijderd; een leider die 20 s weg is geeft de kroon aan het langst aanwezige online lid; een party zonder polls verdwijnt
  na 10 min. **Leider weg of verlaat de party: nieuwe leider** (langst aanwezige online lid). Geen accounts en geen
  persoonsgegevens: alleen een gamertag, het rang-icoon en een willekeurig lidtoken (alleen de hash staat op de server;
  geen IP-adressen of profiel-id's in wat leden terugkrijgen of in logs).
- **Herladen:** het lidtoken staat in `sessionStorage` (`bunkcraft.party.<host>`): een herlaadde pagina zit meteen weer in de
  party. Een nieuw tabblad of een herstart van de browser vindt de party via het profieltoken (`POST /api/party/resume`; het
  oude lidtoken vervalt). Een ticket dat deze browser al volgde (`bunkcraft.party.ticket.<host>`) speelt na een herlaad niet
  opnieuw af.
- **Limieten:** party's per adres per uur `PARTY_CREATE_LIMIT` (20), meedoen 30 per minuut per adres (code raden), poll 120 per
  minuut per lid, acties 40 per minuut per lid, 900 verzoeken per minuut per adres in totaal, `MAX_PARTIES` (2000) tegelijk.
  `PARTIES=off` zet het uit (`/api/server` meldt `features.party`).
- **Tests:** `tests/party.test.ts` (logica met nepklok: vol, leider weg, kick, verloop, herstel, ticket), `tests/partyMatchmaking.test.ts`
  (past de hele party, zelfde team, plekken vasthouden, bots maken plek, balans splitst nooit), `tests/partyServer.test.ts`
  (drie clients vormen een party, de leider speelt, alles in één lobby en hetzelfde team; limieten),
  `tests/partyClient.test.ts` en `tests/e2e/party.spec.ts` (twee browsers).

## De types

| Type | Id | Regels |
|---|---|---|
| Minecraft | `minecraft` | De sandbox (Multiplayer): bouwen, delven, mobs, survival/creative/hardcore. Seed en game mode kies je bij het aanmaken. |
| Team Deathmatch | `tdm` | Rood tegen blauw op de arena. Elke kill telt voor je team; het eerste team op de score limit wint. |
| Free For All | `ffa` | Iedereen voor zichzelf. De eerste speler op de score limit wint. |
| Gun Game | `gungame` | Elke kill geeft je het volgende wapen van een ladder van 19 (begint met de rifle, eindigt met shotgun, revolver, sniper en het mes: one-hit wapens); een meskill zet het slachtoffer een niveau terug. Wie het laatste niveau afmaakt wint. Geen loadoutkeuze. |
| Team Elimination | `elimination` | Rondes met één leven: wie het andere team uitschakelt wint de ronde, het eerste team op het rondelimiet wint. Doden spectaten hun team tot de volgende ronde. |
| Hardpoint | `hardpoint` | Eén zone (de heuvel) telt: het team dat er alleen staat krijgt 1 punt per seconde, samen = betwist. De heuvel verspringt elke 60 s (met 5 s pauze). Eerste op 250 punten. |
| Domination | `domination` | Drie vaste punten: alleen in een punt staan neemt het in 6 s in (een punt van de ander eerst neutraliseren); elk eigen punt geeft 1 punt per 2 s. Eerste op 100. |
| Capture the Flag | `ctf` | Pak de vlag van de ander door hem aan te raken, breng hem naar je eigen vlag terwijl die thuis staat. Drager is 10% trager, laat de vlag vallen bij zijn dood; je eigen team brengt een gevallen vlag direct terug, anders na 12 s. Eerste op 3 captures. |
| Kill Confirmed | `killconfirmed` | Team deathmatch, maar een kill telt pas als iemand de **dog tag** pakt die het slachtoffer laat vallen: een tegenstander bevestigt (+1 voor zijn team), een teamgenoot van het slachtoffer weigert (niemand scoort). Tags verdwijnen na 30 s. Eerste op 50. |
| Search & Destroy | `snd` | Rondes met één leven. De aanvallers planten de bom door 4 s op bomsite **A** of **B** te staan (weglopen = opnieuw); daarna wordt de rondeklok de lont (35 s) en ontmantelt een verdediger hem door 6 s op de bom te staan. Aanvallers winnen door ontploffing of door alle verdedigers uit te schakelen; verdedigers door ontmantelen, door alle aanvallers vóór de plant uit te schakelen of als de tijd zonder bom afloopt. Na de plant beslist alleen de bom nog (of het uitschakelen van alle verdedigers). Rust: zijwissel na *limiet − 1* rondes. Eerste op 4 rondes. |
| Infected | `infected` | Iedereen begint als overlevende met eigen klasse. Na 8 s raakt één willekeurige speler besmet: alleen een mes, 12% sneller, één steek is dodelijk. Wie sterft (en wie later joint) wordt besmet. De laatste overlevende wordt omgeroepen, krijgt 3 bonuspunten en dezelfde snelheid. Besmetten winnen zodra niemand meer overleeft, overlevenden als de tijd (5 min) afloopt. Punten: 1 per kill, overlevenden 1 per 10 s. |
| Sharpshooter | `sharpshooter` | Free for all zonder wapenkeuze: iedereen heeft hetzelfde willekeurige wapen (plus pistool en mes), elke 45 s een ander (nooit twee keer hetzelfde achter elkaar). Eerste op 30 kills. |
| King of the Hill | `koth` | Free for all op één wandelende heuvel (de hardpoint-zones, elke 45 s een andere, 4 s pauze): wie er **alleen** staat krijgt 1 punt per seconde, met z'n tweeën = betwist. Kills tellen niet. Eerste op 60 punten. |

Bij een privélobby (Realms) stel je de limieten in die het type aanbiedt (uit `GameTypeDef.options`: bijvoorbeeld **Score Limit**
10–50 kills bij tdm, **Rounds to Win** en **Round Time** bij elimination, **Captures to Win** bij ctf; gun game heeft geen
scorelimiet, de ladder is de limiet) en een **Map**. De kaartknop toont alleen kaarten met de data die het type nodig heeft
(zones voor hardpoint/domination, vlaggen voor ctf). Wie bij het eindsignaal de meeste kills heeft wint. Het menu stuurt
`{ name, gameMode, seed, gameType, scoreLimit, timeLimitSec, mapId, maxPlayers, listed }` naar `POST /api/rooms`;
`GET /api/rooms/:code` geeft dezelfde velden terug (`map` voor `mapId`), zodat het joinscherm en de lijst met recente games
het type en de kaart tonen.

## Kaarten

De knop **Map** in *Create Game* wisselt tussen de kaarten en toont onder de knop een regel uitleg. De kaarten
staan in `src/modes/maps/` en zijn eigen, originele indelingen in de geest van bekende shooterkaarten: elk met een eigen
kleurenpalet, spiegelsymmetrisch voor tdm, omheind en met spawns die ver uit elkaar liggen en elkaar niet kunnen zien
(spawnkillen is moeilijk).

| Kaart | Id | Wat | Objectives |
|---|---|---|---|
| Classic | `classic` | De oorspronkelijke arena, compact (72 × 72, was 96 × 96): middenplatform, corridors, uitkijkpost, dekking, gesloten bases. Steen en hout. | zones, vlaggen |
| Maple Court | `suburb` | Klein en snel (64 × 40): twee bakstenen huizen met tuin tegenover elkaar, een straat met auto's en een bestelbus, garages op de hoeken, trappen naar de platte daken. Close quarters. | zones, vlaggen, bommen |
| Old Quarter | `quarter` | Stedelijk (80 × 64): een binnenplaats met fontein, een poortgebouw, hoge bakstenen blokken met balkons en dakstairs, steegjes van 4 breed als flanken, een omheind plein per team. | zones, vlaggen, bommen |
| Harbor Yard | `dockyard` | Industrieel (88 × 64): containerstapels van gekleurde wol (teamkleuren aan de eigen kant), een grote loods in het midden, een kraandek op houten pilaren en een schip met een brug om vanaf te snipen. | zones, vlaggen, bommen |
| Dust Bazaar | `desert` | Lange zichtlijnen (96 × 64): zand en zandsteen, een markt met gestreepte kramen, platte daken langs een lange open baan en een sluipschuttertoren aan elk uiteinde, achter de ommuurde teambasis. | zones, vlaggen, bommen |
| Atomic Lane | `atomic` | Vrije (puntsymmetrische) kaart (72 × 48): twee huizen van twee verdiepingen, een bus, een verhuiswagen en een rotonde, zie hieronder. Standaard in het menu. | zones, vlaggen, bommen |
| Skyline Villa | `villa` | Vrije (puntsymmetrische) kaart (88 × 64): een witte villa op een heuvel, zie hieronder. | zones, vlaggen |
| Riptide | `yacht` | Vrije kaart (88 × 56): een superjacht in een jachthaven, zie hieronder. | zones, vlaggen |
| Sundown | `town` | Vrije kaart (80 × 68): een stoffig kruispuntdorp, zie hieronder. | zones, vlaggen |
| Terminus | `station` | Vrije kaart (84 × 68): een treinstation, zie hieronder. | zones, vlaggen |
| Fountain Square | `plaza` | Vrije kaart (68 × 48): een stadsplein met fontein, hotel, caféterrassen, tramhalte en winkelgalerij, zie hieronder. | zones, vlaggen, bommen |
| Rebar | `site` | Vrije kaart (64 × 44): een bouwplaats met een betonnen casco, hellingen, steiger en graafmachine, zie hieronder. | zones, vlaggen, bommen |
| Flight Deck | `carrier` | Vrije kaart (72 × 40): het vliegdek van een vliegdekschip, zie hieronder. | zones, vlaggen, bommen |
| Tin Roofs | `shanty` | Vrije kaart (64 × 44): een dichte sloppenwijk met plankbruggen over de daken en een watertoren, zie hieronder. | zones, vlaggen, bommen |
| Galleria | `mall` | Vrije binnenkaart (64 × 44): een winkelcentrum van twee verdiepingen onder één dak, zie hieronder. | zones, vlaggen, bommen |
| Scrapyard | `scrap` | Vrije kaart (60 × 42): een autosloperij als doolhof van geplette auto's, zie hieronder. | zones, vlaggen, bommen |
| Bunker Flag | `bunker` | Voor capture the flag (64 × 40): een droge rivierbedding met oevers van 2 hoog, twee oversteekplaatsen en een overdekte duiker in het midden; elke vlag in een betonnen bunker met één deur achter een scherfmuur, spawns in een ommuurde tuin erachter. | zones, vlaggen |

### Vrije kaarten in BO2-stijl

Net als Atomic Lane getekend met `layout: 'free'`: één helft wordt getekend en voor de andere helft 180° om het midden
gedraaid (`turned()` in `helpers.ts`), met een eigen palet en eigen details per helft. De routes zijn daardoor eerlijk,
maar de twee kanten zien er anders uit. Screenshots: `docs/screenshots/maps/<id>-*.png` (`python3 scripts/shots.py <id> docs/screenshots/maps <poort>`).

- **Atomic Lane** (`atomic`, het visitekaartje): een doodlopende straat uit de jaren 50 op een testterrein. Een geel huis
  (rood) en een mintgroen huis (blauw) staan tegenover elkaar, elk met een volledig interieur: keuken met zwart-wit
  geblokte vloer, koelkast en fornuis, woonkamer met bank en tv, een trap naar boven, een kinderkamer en een slaapkamer.
  De open ramen boven kijken over de straat; uit het voorraam spring je op het verandadak. De garage (met auto) heeft een
  plat dak: bereikbaar via kratten in de achtertuin of een springkussen (jump pad) op de oprit, en door het zijraam loop
  je zo de bovenverdieping in. Spawns in de achtertuin achter een schutting; aan de ene kant een tuin met schommel en
  zandbak, aan de andere een opzetzwembad. Drie lanes: achter de schoolbus (doorloopbaar, open ramen), de straat over de
  rotonde (heg rond een grote boom), achter de verhuiswagen. Geparkeerde auto's, tuinmuurtjes, heggen en brievenbussen
  breken de straat op: de huisgevels zien elkaar alleen nog vanaf de bovenramen.
- **Fountain Square** (`plaza`): een plein rond een fontein met twee bassins en een gouden beeld. Per team een hotel van
  twee verdiepingen (lobby met balie en lift, suites, een balkon boven het plein), een café met dakterras en een
  loopbrug ertussen boven de poort naar het voorplein waar het team spawnt. De ene zijbaan is een tramstraat (tram om
  doorheen te rennen, taxi, kiosk, abri), de andere een winkelgalerij waarvan het platte dak een verhoogde looproute is.
  Jump pads naar het galerijdak en naar het hotelbalkon.
- **Rebar** (`site`): een bouwplaats. In het midden het betonnen casco van een kantoor: kolommen, een eerste verdieping met
  een groot atriumgat, een trappenhuis, een helling buiten en een jump pad in het atrium, en een klein topdek in twee
  hoeken. Per team een omheinde bouwkeet-compound (schutting in teamkleur) en een materiaalwerf. Zijbanen: een
  graafbaan (grindheuvel om op te klimmen, graafmachine, houtstapel) en een steigerbaan langs een halve bakstenen muur
  met een steiger als verhoogde loopbrug. Boven elke zijbaan een torenkraan.
- **Flight Deck** (`carrier`): het vliegdek van een vliegdekschip. Elk team spawnt in een hangar aan zijn eind van het dek
  en heeft een eiland (de toren) met een brug op de verdieping, open ramen over het dek en een radarmast. Zijbanen: een
  rij jets met opgeklapte vleugels onder het eiland, en een verhoogde vliegtuiglift met een helikopter. In het midden
  jets op de katapulten, een straalscherm, een bergingskraan, trekkers en munitiekarren.
- **Tin Roofs** (`shanty`): een sloppenwijk vol krotten van leem, planken en geverfd beton onder roestige golfplaten.
  Plankbruggen verbinden de bovenverdieping van de huizen met de platte daken aan de overkant: een tweede route over de
  wijk. In het midden een binnenplaats met een watertoren op vier poten en basketbalpalen. Zijbanen: een steeg met
  waslijnen en scooters (jump pad naar een dak), en een marktsteeg met kramen. Spawns in een ommuurd erf.
- **Galleria** (`mall`): een overdekt winkelcentrum met een lichtkoepel boven het atrium. Spawns in het warenhuis aan elk
  eind (paspoppen in de etalage), de vlag in het magazijn erachter. Beneden winkels langs beide lange wanden
  (elektronica, speelgoed, sport, boeken, café, mode), een foodcourt met burgerkraam en een draaimolen in het midden;
  boven een mezzanine met een speelhal, een bioscoopfoyer, een bowlingbaan en een speelhoek, bereikbaar met roltrappen
  en jump pads. Winkels, toiletten en magazijnen maken het ook een goede verstopkaart.
- **Scrapyard** (`scrap`): een autosloperij. Muren van geplette auto's (twee, drie hoog) vormen een doolhof van smalle
  gangen; een portaalkraan staat over het midden met een auto aan de magneet boven de middelste zone. Per team een
  poortplein achter een plaatijzeren hek, een kantoor op palen. Zijbanen: een bandenberg om op te klimmen (jump pad naar
  een autostapel) en een baan met autostapels en een camper.
- **Skyline Villa** (`villa`): een moderne witte villa van twee verdiepingen met glazen gevels rond een open atrium (de
  middelste zone). Boven de begane grond een dakterras met glazen balustrade, trappen naar het platte dak van de
  slaapvleugel. Rood heeft een leeg zwembad (een verzonken bak van blauwe wol) met ligstoelen en parasols, blauw een
  verzonken basketbalveld met tribune; rood een garage met auto's, blauw een fitnessruimte. Spawns op een grindvoorplein
  achter een witte muur met heg; fontein en plantenbakken op het gazon, een beplante heuvelrand langs de lange kanten.
- **Riptide** (`yacht`): een superjacht in het midden van een beloopbare blauwe "zee". Teakdek met reling, een benedendek
  met gang en hutten in de romp (zijdeuren vanaf het water), een salon midscheeps (de middelste zone) met een zonnedek
  erop, de brug aan de boegkant en een sky lounge aan de achterkant. Op de puntige boeg een bubbelbad, op de vierkante
  achtersteven een helikopterdek met helikopter. De teams spawnen op de steigers achter boeg (rood) en achtersteven
  (blauw); steigers, speedboten, boeien en een rotseilandje geven dekking op het water.
- **Sundown** (`town`): een stoffig dorp op een kruispunt. In het midden een tankstation met luifel en pompen, eromheen een
  cantina van twee verdiepingen met dakterras, een marktplein met kramen en een put, smalle steegjes tussen krotten en
  huizen met buitentrappen naar het platte dak. Rood heeft een kerk met klokkentoren (wenteltrap naar de klokkenstoel) en
  een kerkhof, blauw een raadhuis met klokkentoren en een tuin. Spawns in een ommuurd boerenerf aan elk eind.
- **Terminus** (`station`): twee sporen noord-zuid door het midden, elk met een trein langs een verhoogd perron. De treinen
  staan verspringend, zodat de sporen in het midden een overweg vormen (de middelste zone); elke wagon heeft deuren aan
  beide kanten om doorheen te rennen. Elk spoor eindigt in een tunnel in de muur. Twee loopbruggen over de sporen (met een
  opening waar je op een treindak springt), perronkappen, en per kant een hal met balkon: de bakstenen stationshal (rood)
  en de stenen goederenhal (blauw). Spawns op het voorplein achter de hal.

**Objectives** (`objectives` in de kaartdefinitie, wereldcoördinaten): 4–5 zones in hardpoint-volgorde (midden, dan om en om
rood en blauw; spiegel- of puntsymmetrisch zoals de kaart), welke daarvan domination-punten zijn, en per team een vlag. Een
zone of vlag in een gebouw krijgt een `level` (hoogte boven de vloer). `tests/mapObjectives.test.ts` eist: staanplek met
hoofdruimte, ≥ 60% open schijf, bereikbaar vanaf beide spawns, niet zichtbaar vanaf vijandelijke spawns, vlag 8–25 blokken
van de eigen en > 30 van de vijandelijke spawns. Kandidaten toetsen: `npx tsx scripts/objective-eval.ts <map> zone x z r flag x z`.
Bomplaatsen (search and destroy, `sites`, A en B in de blauwe helft) plaats je met `npx tsx scripts/site-scan.ts <map>`;
`tests/mapSites.test.ts` controleert ze.

**Kaartkwaliteit meten** (zie `docs/research/MAPS.md`): `npx tsx scripts/map-metrics.ts` (dekking, zichtlijnen, `vis%`),
`npx tsx scripts/qa/map-flow.ts` (botsimulatie: tijd tot eerste contact, gevechtsafstand), `npx tsx scripts/qa/map-audit.ts`
(bereikbaarheid, vallen, spawn-blootstelling) en `npx tsx scripts/ascii-map.ts <map>` (bovenaanzicht in tekst).
`tests/spawnExposure.test.ts` eist op alle kaarten dat geen plek op de vijandelijke helft een spawn ziet.

Met **Rotate** speelt elke volgende match op de volgende kaart (die het type ondersteunt); de client voegt zich dan automatisch opnieuw bij de
game (even het laadscherm). Tijdens een match valt er niets aan de kaart te kiezen.

## Objective-modes

De regels draaien op de server (`server/modes/<logic>.ts`, zie `docs/SERVER.md`); de client tekent alleen wat de server in
`mode` (toestand, ~4 Hz) en `event` (gebeurtenis) stuurt. De HUD-onderdelen hangen aan `GameTypeDef.hud`:

- **Zones** (`src/ui/ModeHud.ts`): een markering in de wereld boven elke zone, **zichtbaar door muren**, met een letter
  (domination) of cirkel (hardpoint), een ring met de inname-voortgang in teamkleur, de opdracht (CAPTURE, DEFEND, ATTACK,
  CONTESTED, CAPTURING, LOSING) en de afstand. Buiten beeld plakt de markering aan de schermrand (onder de topbalk). Op de grond
  ligt een gekleurde ring met de straal van de zone (`src/rendering/ModeVisuals.ts`). Hardpoint toont de actieve heuvel en
  "Hill moves in N"; tijdens de pauze de volgende heuvel.
- **Scorebalk** onder de timer: rood en blauw naar de limiet (zones en ctf).
- **Vlaggen:** een boxmodel per team (voet, paal, wapperend doek met witte streep); een gedragen vlag hangt op de rug van de
  drager, een gevallen vlag ligt scheef. Markeringen met TAKE / DEFEND / RETURN / ESCORT / KILL CARRIER / CAPTURE, en links
  twee statusregels ("Red flag: taken by Ann", "Blue flag: dropped 8"). Als drager loop je 10% langzamer.
- **Rondes:** pips per team voor de gewonnen rondes en "2 v 3" levende spelers; banners "Round 4 starts in 5" (intermission),
  "3-2-1" (countdown) en na de ronde "Red wins the round". Uitgeschakeld = "Eliminated: you are back next round" en spectaten.
- **Ladder** (gun game): niveau, huidig wapen, volgend wapen, voortgangsblokjes en de koploper (alleen hier, niet ook onder de timer); links bovenin `7/19`. Het paneel wijkt als het scoreboard (Tab) openstaat.
  Het scoreboard heeft een kolom **Level** (gun game) of **Caps** (ctf).
- **Gebeurtenissen** geven een korte banner en een geluid (`AudioEngine.playModeCue`: goed, slecht, alarm als je eigen vlag
  wordt gepakt, neutraal).

Screenshots: `docs/screenshots/modes/` (gemaakt met `python3 scripts/mode-shots.py <map> [poort]` en, voor de modes hieronder,
`python3 scripts/mode-shots-extra.py <map> [poort]`).

### Kill Confirmed, Search & Destroy, Infected, Sharpshooter, King of the Hill (oktober 2026)

Elke mode is een `GameTypeDef` plus een klasse in `server/modes/` (`confirm.ts`, `snd.ts`, `infected.ts`, `sharpshooter.ts`,
`koth.ts`). Alles is server-autoritair: de client tekent alleen de `mode`-toestand en `event`s.

- **Kill Confirmed:** zwevende, draaiende dog tags in de kleur van het team van de gevallen speler (één `InstancedMesh`, max.
  40 tags) en markeringen door muren voor de **4 dichtstbijzijnde** (CONFIRM geel, DENY blauw). Alleen je eigen pick-ups geven
  een banner ("Kill confirmed" / "Kill denied"), anders zou elke tag van het potje het scherm vullen. Scoreboardkolom **Tags**.
- **Search & Destroy:** markeringen **A** en **B** met de plant- of ontmantelvoortgang als ring, opdracht per kant (PLANT,
  PLANTING, DEFEND, STOP THE PLANT; na de plant GUARD of DEFUSE en alleen nog de bomsite), oranje ringen op de grond, een bom-
  model met een rood lampje dat sneller knippert naarmate de lont opraakt. Links: rondepips, "3 v 2", je rol
  ("Attack: plant the bomb at A or B" / "Defend A and B"), knipperend "Bomb at A: 21" en "Sides swap in N rounds". Aanvallers
  starten altijd aan de rode kant (x < 0) en verdedigers bij de sites, ongeacht hun teamkleur. Kolom **Bomb** (plants + defuses).
- **Infected:** teams zijn rollen: blauw = overlevenden, rood = besmet (`GameTypeDef.teamRoles`); de topbalk toont de aantallen
  en het eindscherm "De besmetten winnen!" / "De overlevenden winnen!". Paneel: "Infection in 5", daarna je opdracht en
  "3 survivors · 2 infected". Teams worden nooit herverdeeld (`ModeLogic.keepTeams`). Snelheid en mesdamage via de nieuwe
  hooks `speedMul` (ook in de bewegingscontrole van de server) en `damageMul`; de client neemt dezelfde factor over met
  `modeSpeedMul` (`src/modes/ModeView.ts`), net als de vlagdrager in ctf.
- **Sharpshooter:** paneel "EVERYONE HAS / Bolt-Action Sniper / New weapon in 17" en een banner bij elke wissel; de server deelt
  het wapen uit via `gear` (volle magazijnen, wapen in de hand).
- **King of the Hill:** de heuvel kleurt **goud** als jij hem houdt, rood als een ander, oranje bij betwisting (HOLDING / TAKE IT /
  CAPTURE). Linksboven `27/60` (je punten), geen team-scorebalk. Kolom **Points**.
- **Geluid:** de bestaande cues (`playModeCue`): alarm bij plant en uitbraak, goed/slecht bij ontmantelen, ontploffen,
  bevestigen en besmetten, neutraal bij zijwissel en wapenwissel; start-stinger bij elke live-fase.
- **Bomsites op de kaarten:** `objectives.sites` (`SiteDef`: naam, x, z, r = 3, `level` standaard 0 = de vloer, ook onder een
  dak). Alle elf kaarten hebben er twee, in de blauwe helft. `scripts/site-scan.ts` zoekt kandidaten: in elke dekkingsvariant
  open vloer, voor beide kanten bereikbaar, niet zichtbaar vanaf de aanvallersspawns, verdedigers er duidelijk eerst (looptijd
  ≤ 75% van de aanvallers, mikpunt ~45%), A en B op ≥ 16 blokken en (bij vrije kaarten) aanvallerslooptijden binnen 15%.
  `tests/mapSites.test.ts` bewaakt dezelfde regels.
- **Server-bots:** `ModeLogic.objectives(m, p)` geeft per speler doelen (`BotGoal`: capture, defend, pickup, defuse, hunt, flee
  met positie, straal, prioriteit en eventueel een doelspeler): tags oprapen, planten/bewaken/ontmantelen, de heuvel in,
  besmetten jagen op de dichtstbijzijnde overlevende en overlevenden houden afstand. Sharpshooter heeft geen doel (gewoon vechten).
- **Tests:** Vitest per mode (`tests/modeKillConfirmed|SearchDestroy|Infected|Sharpshooter|KingOfTheHill.test.ts`), view-teksten
  (`tests/modeViewNew.test.ts`), quick play en limieten (`tests/modesQuickPlay.test.ts`), bomsites (`tests/mapSites.test.ts`), en
  `scripts/modes-bots.ts killconfirmed snd infected sharpshooter koth` speelt elke mode met twee bots **tot het einde** tegen
  een echte server (ontploffing én ontmanteling, één messteek, wapenwissel, heuvel tot de limiet; zonder bewegingscorrecties).
- **Bewust niet gebouwd: Hide & Seek / Prop Hunt.** Eerlijk en server-gevalideerd vraagt het een kleinere hitbox per speler in
  de hitscan (`rayPlayer` kent nu één maat), een blokvermomming die op het raster snapt en door de anti-wallhack-filtering heen
  klopt, en eigen rendering van verstopte spelers. Dat raakt hitregistratie en rendering waar andere agents nu aan werken; zie
  de roadmap.

## Bots

Server-side bots (`server/bots/`) zorgen dat een speler alleen (of met een paar vrienden) altijd een volle, leuke match
heeft. Ze zijn **echte matchspelers**: een sessie zonder socket in `GameServer`, met dezelfde rate limits, en alles wat ze
doen gaat als gewoon clientbericht (`pos`, `fire`, `reload`, `weapon`, `loadout`) door `handleArcade`. Dus dezelfde
bewegingscontrole (`ArcadeGuard`/`MovementValidator`, ook de `step`-klok), dezelfde schotcontrole (eenheidsvector, oorsprong
binnen 0,6 blok), dezelfde schade, spawnlogica, lag-compensatie en aim-statistiek als mensen. Ze weten niet meer dan een
client: hun eigen staat, zichtlijnen (kogeldoorlatende blokken, dus niet door glas), de HUD-modusstatus, schoten binnen
gehoorsafstand (40 blokken, met demper 12) en wie hen raakt.

- **Herkenbaar:** naam `[BOT] Viper` enz. (haken mogen niet in spelersnamen, dus niemand kan zich als bot voordoen) en
  `bot: 1` in de roster. Scorebord, killfeed en naamtags tonen de tag vanzelf. Bots komen en gaan zonder chatregel.
- **Vullen:** Snel spelen-lobby's vullen tot `QUICKPLAY_BOTS` spelers (standaard 8, niveau `QUICKPLAY_BOT_DIFFICULTY`).
  Elke seconde stelt de server bij: komt er een mens bij, dan gaat er eerst een bot weg (uit het grotere team, liefst een
  dode, nooit een vlagdrager als het anders kan); een volle lobby met bots weigert nooit een mens. Teams blijven gelijk: bij
  twee of meer verschil verlaat een bot het grote team en komt er een terug in het kleine. Met de laatste mens gaan ook
  de bots weg (de kamer wordt leeg en laadt uit). Matchmaking en lijsten tellen alleen mensen; de lijst toont `+N bots`.
- **Privélobby:** *Bots* (0 tot lobbygrootte − 1) en *Botniveau* in het scherm *Privélobby maken*; die bots blijven,
  maar maken ook plaats als een mens een plek nodig heeft. Opgeslagen als `bots` in `world.json`.
- **Niveaus** (`server/bots/BotSkill.ts`): reactietijd (0,7 / 0,45 / 0,32 / 0,25 s), draaisnelheid (170-450 °/s, altijd
  onder de 600 °/s waarop de aim-controle een "snap" ziet), een zwevende richtfout die na het oppakken van een doel uitdooft
  (Ornstein-Uhlenbeck), volgvertraging op bewegende doelen, kans op hoofd i.p.v. borst (4-28 %), blikveld en
  waarneemafstand, terugtrekken bij weinig health, strafe-neiging en richten door het vizier. Elke bot varieert ±10 %.
  Terugslag duwt hun blik omhoog zoals bij een speler; ze vuren pas als hun blik op het punt staat waar ze *denken* dat het
  doel is, dus de fout wordt echte missers.
- **Balans** (`tests/botBalance.test.ts`, gesimuleerde duels met echte `Match`-gevechten tegen twee referentiespelers in
  `tests/helpers/humanProfiles.ts`): makkelijk wint ~14 % tegen een gemiddelde speler, normaal ~38 %, moeilijk ~58 %,
  veteraan ~79 %; tegen een geoefende speler wint moeilijk ~17 % en veteraan ~34 %.
- **Bewegen:** dezelfde `Player`-fysica als de browser (botsing, step-up, springen, luchtcontrole), op 60 Hz op de echte
  klok, met `step` in elk positierapport. Paden over een **navigatiegraaf** per kaartvariant (`NavGraph.ts`): staanplekken
  per halve blokhoogte en bewegingen (lopen, diagonaal, halve trede, springen tot 1 blok, vallen tot 4, ladders), allemaal
  getoetst met `MovementValidator.inSolid`, dus elke route is er een die de anti-cheat accepteert. De graaf bouwt uit elke
  blokbron (nieuwe kaarten werken zonder aanpassing), wordt per kaartvariant gedeeld door alle lobby's en bij het opstarten
  op de achtergrond voorgebouwd (`BOT_PREWARM`). A* met typed arrays; bochten afsnijden alleen waar het hele lijf past.
- **Spelen per mode:** tdm/ffa/gun game/elimination: jagen (geluid, geraakt worden, laatst gezien), anders zwerven richting
  de vijandelijke helft. Hardpoint: naar de actieve heuvel en daarbinnen telkens een andere plek. Domination: het goedkoopste
  punt om te nemen of te verdedigen, verspreid over het team. CTF: een derde verdedigt de eigen basis, de rest haalt de
  vlag; de drager rent naar huis (eerst de eigen vlag terughalen als die ligt), anderen jagen op de vijandelijke drager of
  escorteren de eigen. Gun game: altijd het ladderwapen, mes-niveau = erop af. Tijdens warm-up lopen ze rond zonder te
  vechten, in intermission/countdown/roundend staan ze stil.
- **Gevecht:** doelkeuze (dichtbij, in het vizier, wie schiet, vlagdrager), afstand houden per wapen (shotgun 5, smg 9,
  geweren 18, sniper/DMR 35), strafen op begaanbare plekken, af en toe springen (moeilijk/veteraan), wisselen naar het
  secundaire wapen als het primaire leeg is op korte afstand, herladen als het rustig is. **Dekking:** onder de
  terugtrekgrens (of herladend op afstand) zoekt een bot een plek binnen 11 blokken die de dreiging niet kan zien, wacht tot
  de health terug is en gaat weer.
- **Klassen:** een preset naar kaartgrootte (grote kaarten meer lange wapens, kleine meer smg/shotgun) via het gewone
  `loadout`-bericht. Bots hebben geen Realms-profiel: zoals een gast spelen ze met de unlocks van level 1 (geweer, smg,
  shotgun, pistool) en verdienen ze geen XP.
- **Kosten** (`scripts/bench-bots.ts`, M1 Pro): 1 mens + 11 bots ≈ 0,1 ms per lobbytick van 33 ms; 6 zulke lobby's samen
  0,7 ms per tick (p99 1,7 ms). Denken (waarnemen, kiezen, paden) loopt gespreid op ~10 Hz per bot met een budget van
  1,5 ms per tick per lobby en hooguit 3 padzoektochten per tick; bewegen en richten elke tick.
- **Tests:** `botNav` (graaf op elke kaart en variant, alle spawns/zones/vlaggen bereikbaar, elke kant een geldige move),
  `botDecisions` (aim, klasse, CTF/hardpoint-doelen, dekking, vulregels), `botMatch` (hele TDM- en CTF-matches tot het
  einde, hardpoint/domination/gun game, elke kaart, vulregels, kamerinstellingen, en **nul** anti-cheat-meldingen:
  geen correcties, geen vervangen schotoorsprong, aim-verdenking onder de waarschuwingsgrens), `botBalance`, `botPerf`.

## Wat anders is dan in de sandbox

- Geen hotbar, hartjes, honger of lucht: een eigen HUD (`src/ui/ArcadeHud.ts`).
- Geen blokken breken of plaatsen, geen mobs, geen items, geen inventory of crafting (`Interaction.arcade`).
  Chat blijft werken.
- Geen valschade en geen honger. De server bepaalt je health.
- **Beweging:** altijd sprinten (1,3× Minecraft-sprint, met de `moveSpeed` van je wapen), plus slide, slide-hop,
  bunny hop met momentum, air strafe, crouch en jump pads (zie *Beweging* hieronder). Geen vliegen.

## Beweging (slide, slide-hop, bunny hop, jump pads)

Krunker-achtig, met eigen getallen (onderzoek: `docs/research/KRUNKER.md`). Alles staat in `src/player/ArcadeMove.ts`
en geldt alleen in arcade-games (`Player.arcadeMove`); de Minecraft-beweging is ongewijzigd (tests bewaken dat).

| Techniek | Hoe | Wat er gebeurt |
|---|---|---|
| **Slide** | Crouch-toets (C) indrukken terwijl je rent, of ingedrukt houden tijdens een landing | Snelheid springt naar 1,45× de rensnelheid en dooft uit (grond 2,4/s); max 0,8 s grondtijd; camera zakt naar 1,0 blok, FOV-kick, lichte kanteling, slide-geluid. Cooldown 0,9 s. Met strafe + muis buig je de slide (curve slide). |
| **Slide-hop** | Springen tijdens de slide | De slide-snelheid gaat mee de lucht in en dooft daar langzaam uit (0,8/s). Ritme: springen → crouch vlak voor de landing → meteen weer springen. |
| **Bunny hop** | Springen op het moment van landen (spatie vasthouden) | De sprongstap gebruikt luchtbesturing: geen grondwrijving, momentum blijft. |
| **Air strafe** | Strafe-toets + muis dezelfde kant op in de lucht | De baan draait mee (4/s) zonder snelheid te winnen. Achteruit sturen remt. |
| **Trap/helling-slide** | Sliden over treden of slabs omlaag | Elke trede omlaag is een mini-sprongetje: daar geldt de lage luchtwrijving en telt de slide-tijd niet, dus de slide houdt langer snelheid. |
| **Crouch** | Crouch-toets vasthouden zonder te sliden | 55% snelheid, oog 1,27, hitbox 1,5 hoog. |
| **Jump pad** | Over een jump pad lopen (blok `JUMP_PAD`, gloeiend groen-blauw) | Lanceert met 16 blokken/s recht omhoog (top ≈ 4,3 blokken); je rensnelheid blijft. Kaarten plaatsen ze met `jumpPad()` in `src/modes/maps/helpers.ts`. |

- Snelheid *winnen* boven de rensnelheid kan alleen met de slide-boost; elke andere toestand laat het overschot minstens zo snel
  uitdoven als 0,8/s. Een perfecte slide-chain haalt gemiddeld ~1,3× de rensnelheid.
- **Perk Lightfoot** (+8% snelheid, slide-cooldown 0,65 s) en de preset **Scout** (SMG, pistool, Lightfoot) zijn de snelle klasse.
- **Server:** `pos` draagt `sl` (de fysica-stap van je laatste slide-start) en de vlaggen crouch (32) en slide (64). De
  bewegingsvalidator (`server/anticheat/Movement.ts`) accepteert een slide-start alleen binnen het meldvenster en na de cooldown,
  en verhoogt dan het snelheidsbudget met precies de envelop `max × 0,45 × e^(−0,8·t)`; zonder gemelde slide geldt het oude
  budget. Jump pads verhogen de sprongcurve alleen als er een pad onder het pad van de speler lag. Een snelheidshack die elke
  melding een slide claimt wordt teruggezet (`scripts/cheat-bots.ts`).
- **Hitbox:** de server gelooft een pose alleen als die kan (slide: een geaccepteerde slide-start, crouch: op de grond en op
  crouch-tempo) en schiet dan op die hitbox (slide 1,15 hoog, crouch 1,5, hoofd de bovenste 0,4). Lag compensation neemt bij een
  pose-wissel in het terugspoelvenster de hoogste hitbox. Anderen zien dezelfde pose: lichaam leunt achterover (slide) of voorover
  (crouch), boven de voeten.
- **Tests:** `tests/arcadeMovement.test.ts` (slide-curve, cooldown, momentum, envelop-bovengrens, jump pads, claims),
  `tests/anticheatMovement.test.ts` (replay van slides, slide-hops, bhop-chains en air strafe op elke kaart, met lag, bursts en
  frame-hitches: nooit gecorrigeerd), `scripts/qa/slide-check.py` (Playwright in een echte match; screenshots
  `docs/screenshots/arcade/slide-*.png`).

## Besturing

Alles is aan te passen in *Options → Controls → Key Binds* (categorie **Arcade**).

| Actie | Standaard |
|---|---|
| Lopen, springen | W A S D, spatie |
| Crouch / slide (tijdens rennen) | C (de Sneak-toets, *Sneak / Crouch & Slide*) |
| Schieten | linkermuisknop (vasthouden bij automatische wapens, klikken bij semi-automatische) |
| Richten (ADS) | rechtermuisknop vasthouden (of één keer drukken: Opties → Muis → Richtmodus) |
| Herladen | R |
| Wapen kiezen | 1 primair, 2 secundair, 3 melee, of het muiswiel |
| Vorig wapen (quick switch) | Q |
| Scoreboard | Tab (vasthouden) |
| Create-a-Class (klassen) | B |
| Scope stilhouden (adem inhouden) | Shift ingedrukt tijdens het richten door een scope |
| Sniper-scope zoomen (twee standen) | muiswiel tijdens het richten door de scope (omhoog: in, omlaag: uit) |
| Chat | T |
| HUD verbergen | F1 |

Op het doodscherm kies je met 1–9 de klasse voor je volgende leven (8 presets en je Custom-klasse); binnen 3 s na je
spawn en vóór je eerste schot gaat een nieuwe klasse direct in. Esc opent het pauzemenu;
de match loopt op de server gewoon door.

## HUD

Alle teksten zijn NL/EN (`arc.*` en `mode.*` in `src/ui/i18n.ts`). De Engelse regels die de server stuurt (onder de timer,
gebeurtenissen) vertaalt de client bij binnenkomst (`localizeServerText` in `src/modes/ModeView.ts`); wapen-, perk-, optiek-
en kaartnamen blijven zoals ze zijn.

- **Health** linksonder (getal en balk, knippert rood onder 30), **munitie** rechtsonder (`magazijn / ∞`,
  wapennaam, herlaadbalk) en de drie wapenslots.
- **Richtkruis** dat meegroeit met de spreiding (heup groter, richten kleiner, bewegen en in de lucht groter)
  en verdwijnt bij richten (de vizieren, de rode stip of de holo-ring nemen het over) en achter de scope. Het opent direct
  tot de echte kegel en sluit zacht (`CrosshairBloom`); het vervaagt tijdens het opkomen van de vizieren. Opties → Besturing
  → Dradenkruis: stijl (kruis, stip, cirkel), kleur, grootte en "opent met spreiding" (uit = vaste opening).
- **Medailles** onder het richtkruis (double/triple/multi kill, killstreak 3/5/10) en de ademmeter in de scope.
- **Hit markers:** alleen bij treffers die de server bevestigt (`hit`), zonder vertraging bovenop de ping: een scherpe X van
  vier balkjes vanuit het richtpunt (schaalt met de GUI-schaal, hele pixels), die opploft (×1,45) en in 0,3 s vervaagt. Wit
  bij een treffer, goud en groter bij een headshot, rood, groter en langer (0,55 s) bij een kill; ook zichtbaar in de scope.
  **Schadegetallen** (Opties → Video → Schadegetallen, standaard uit) zweven rechtsboven het richtpunt (wit/goud/rood).
- **Richtpunt = kogelrichting:** de terugslagkick van de camera tilt het beeld even op terwijl de kogels niet meegaan; het
  richtkruis, de hit marker en de schadegetallen zakken daarom mee naar waar de kogels echt gaan. Bij richten (ADS) zit de kick
  in het wapenmodel en niet in de camera, dus de vizieren en de scope wijzen altijd waar je schiet.
- **F3** toont "Hit reg: N on-screen hits, x% denied": schoten die op je scherm raak leken en hoeveel de server afkeurde.
- **Schade-indicatoren:** rode streepjes rond het richtkruis wijzen naar de schutter en draaien met je blik mee.
- **Killfeed** rechtsboven (schutter, wapen, `HS` bij een headshot, slachtoffer; teamkleuren, jouw regels omlijnd).
- **Timer** bovenin met de teamscores (tdm) of jouw kills tegen de limiet en de koploper (ffa).
- **Scoreboard** op Tab, gesorteerd op kills (dan minder deaths, dan naam), met teamkleuren, K/D en ping.
- Spawn-bescherming (2 s), "Warm-up: match starts in N", het doodscherm
  ("You were eliminated by X" met aftelling) en het eindscherm (winnaar, eindstand, "Next match in N").
- **Spectaten na je dood:** de camera volgt je moordenaar de eerste seconde en laat je daarna met de linker- of rechtermuisknop
  door je levende teamgenoten (tdm) of alle andere spelers (ffa) bladeren; onderin staat "Spectating NAAM". De camera hangt achter
  het hoofd van de gevolgde speler (en komt dichterbij als er blokken in de weg zitten). Het gebruikt de posities uit `snap`;
  er is geen servercode voor nodig.

## Wapens

Alle getallen komen uit `src/modes/Weapons.ts` en zijn **autoritatief op de server**. De client voorspelt
alleen het uiterlijk (terugslag, mondingsvuur, tracer) en neemt munitie (`ammo`) en treffers (`hit`) van de server over.
Schade is uit 100 health. Zoom per optiek in de volgorde van de kolom *Optieken*.

| Wapen | Slot | Modus | Schade | Headshot | Schoten/min | Magazijn | Herladen leeg (tactisch) | Spreiding heup / ADS | Volle schade tot / val-af tot | ADS-tijd | Zoom (per optiek) | Snelheid | Optieken |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Assault Rifle | primair | auto | 20 | ×1,5 | 560 | 30 | 1,3 s (0,98 s) | 2,2° / 0,25° | 32 / 80 m (min. 55%) | 0,16 s | 1,3× / 1,3× / 1,4× / 2,2× | ×1 | iron, reddot, holo, combat |
| SMG | primair | auto | 13 | ×1,4 | 950 | 25 | 1,1 s (0,83 s) | 2,6° / 1° | 14 / 50 m (min. 45%) | 0,13 s | 1,2× / 1,2× / 1,3× | ×1,08 | iron, reddot, holo |
| Shotgun | primair | semi | 8 × 16 | ×1,5 | 80 | 6 | 1,9 s (1,42 s) | 3,2° / 2,6° | 9 / 24 m (min. 20%) | 0,14 s | 1,1× / 1,2× | ×0,97 | iron, reddot |
| LMG | primair | auto | 17 | ×1,5 | 660 | 75 | 3,4 s (2,55 s) | 3,2° / 0,35° | 38 / 95 m (min. 62%) | 0,27 s | 1,3× / 1,3× / 1,4× / 2× | ×0,88 | iron, reddot, holo, combat |
| Burst Rifle | primair | burst (3) | 20 | ×1,4 | 900 (cyclus 0,36 s) | 30 | 1,35 s (1,01 s) | 2° / 0,15° | 45 / 85 m (min. 55%) | 0,17 s | 1,3× / 1,3× / 1,4× / 2,2× | ×1 | iron, reddot, holo, combat |
| DMR | primair | semi | 34 | ×1,5 | 240 | 12 | 1,6 s (1,2 s) | 3,5° / 0,06° | 90 / 160 m (min. 70%) | 0,18 s | 1,4× / 1,5× / 1,6× / 2× / 2,2× (+4×) | ×0,96 | iron, reddot, holo, combat, scope |
| Semi-Auto Sniper | primair | semi | 55 | ×1,85 | 125 | 6 | 1,9 s (1,42 s) | 7° / 0,03° | 70 / 160 m (min. 80%) | 0,23 s | 3× (+5,5×) / 2,4× | ×0,93 | scope, combat |
| Bolt-Action Sniper | primair | grendel | 100 | ×1,5 | 45 | 4 | 2,1 s (1,58 s) | 9° / 0° | 70 / 160 m (min. 85%) | 0,19 s | 4,5× (+8,3×) | ×0,92 | scope |
| Battle Rifle | primair | auto | 30 | ×1,5 | 400 | 20 | 1,6 s (1,2 s) | 2,8° / 0,22° | 45 / 100 m (min. 60%) | 0,2 s | 2,3× / 1,3× / 1,4× / 1,5× | ×0,95 | combat, iron, reddot, holo |
| Lever-Action Carbine | primair | hendel | 50 | ×2,1 | 120 | 8 | 1,9 s (1,42 s) | 2,4° / 0,06° | 40 / 90 m (min. 70%) | 0,16 s | 1,4× / 1,5× / 2,2× | ×1 | iron, reddot, combat |
| Anti-Materiel Rifle | primair | grendel | 150 | ×1,2 | 30 | 3 | 2,4 s (1,8 s) | 12° / 0° | 120 / 300 m (min. 80%) | 0,32 s | 6,3× (+11,4×) | ×0,85 | scope |
| Pistol | secundair | semi | 18 | ×2 | 400 | 12 | 0,95 s (0,71 s) | 1,8° / 0,3° | 25 / 60 m (min. 50%) | 0,12 s | 1,1× | ×1,04 | iron |
| Machine Pistol | secundair | auto | 12 | ×1,6 | 1000 | 20 | 1,2 s (0,9 s) | 3,2° / 1,2° | 9 / 30 m (min. 45%) | 0,11 s | 1,1× | ×1,05 | iron |
| Revolver | secundair | semi | 52 | ×2 | 150 | 6 | 1,8 s (1,35 s) | 2,5° / 0,09° | 30 / 70 m (min. 60%) | 0,14 s | 1,2× | ×1 | iron |
| Knife | melee | semi | 100 | ×1 | 120 | – | – | – | 2,6 / 2,6 m | – | – | ×1,08 | – |

De spreiding is de halve openingshoek van de kegel waarin een kogel kan landen. Een scope op een wapen dat er niet voor gebouwd
is kost 0,08 s extra ADS-tijd, de combat scope 0,05 s (niet op de Battle Rifle, die er standaard een heeft). Sniper-scopes
hebben een tweede, diepere zoomstand (tussen haakjes; `opticZoomLevels`): het scrolwiel wisselt zolang je door de scope kijkt
(omhoog = inzoomen) in plaats van van wapen te wisselen. De gevoeligheid schaalt mee met de zoomstand. (Zoom in deze tabel is
1 / FOV-factor; de uitlezing in de scope rekent met de tangens van de halve hoeken, dus de bolt-action toont 5,2x en 9,4x.)

**Herladen:** met kogels in het magazijn is het een tactische herlading (75% van de lege, `reloadTimeFor`). De client speelt
animatie en geluid op die tijd en is klaar zodra de animatie klaar is; de server neemt een schot tot 0,1 s vóór zijn eigen
timer aan (het schot reist dezelfde halve ronde als het verzoek), dus na de animatie wacht je nergens op.

**Richten (ADS):** `src/modes/AimMath.ts` (puur, getest in `tests/aimMath.test.ts`).
- *Curves per wapenklasse* (op `adsTime`: tot 0,14 s licht, tot 0,21 s middel, daarboven zwaar): het beeld komt voorop geladen
  omhoog (begint meteen te bewegen, geen smoothstep vanuit stilstand) en laat de vizieren 1,4 tot 1,9× sneller los. De
  gameplay-waarde (`ads`, lineair in de ADS-tijd van wapen, optiek en perk) blijft apart van de beeldwaarde (`adsEased`);
  omkeren halverwege geeft geen sprong (`AdsBlend`). De camera zet de zoom zonder eigen smoothing (`Camera.zoom`; ervoor
  liep de FOV ~50 ms achter de vizieren aan) en toont sway, terugslag en zoom die de sessie later in het frame zet nog in
  datzelfde frame (`Camera.syncAim`). Komen de vizieren aan, dan zakt het wapenmodel 0,14 s een fractie in om het vizier
  (`adsSettle`, alleen beeld; het richtpunt staat stil).
- *Vizier staat op het midden:* het wapen draait bij kick, sway en bob om zijn vizierlijn (`WeaponViewmodel`), de rode stip en
  de holo-ring hangen in het beeld op het exacte midden (in schermpixels, schalen met de hoogte) en de open vizieren zijn een
  korrel met een lichte punt in een open kimme. `scripts/qa/aim-shots.py` projecteert elke wapen × optiek en meldt de afwijking
  (nu 0,0 px voor alle 36 combinaties) en maakt de screenshots (`docs/screenshots/arcade/aim-*.png`).
- *Gevoeligheid:* Opties → Muis → *ADS-gevoeligheid* (25-200 %, bovenop de schaling), *ADS-schaling* (**Uniform** = de
  FOV-verhouding van de optiek, zoals voorheen; **Schermafstand** = tangens van de halve hoeken: dezelfde afstand op het scherm,
  iets trager bij sterke zoom) en *Richtmodus* (vasthouden of schakelen: een druk aan, een druk uit; herladen, wisselen en
  doodgaan zetten de vizieren omlaag).
- *Geen sway door open vizieren:* iron sights, rode stip, holo en combat scope staan doodstil (`opticSways`); alleen de
  sniper-scope zwaait nog (klein, zie hieronder). De oude drift van 0,07-0,17° trok het richtpunt van een doel af terwijl je
  stil hield (aim-feel-meting: 0,13° top-top op een rifle).
- *Spreiding heup tegen ADS (gedeeld met de server via `currentSpread`/`shotSpread`):* bewegen kost heupvuur ×1,3 en richten
  ×1,08, de lucht ×1,4 tegen ×1,25 (daarvoor ×1,15 en ×1,4 voor allebei). De ADS-spreiding van de enkelkogelwapens is
  ~40% kleiner (aim-feel-pass): elk richtschot blijft binnen een speler op de volle-schade-afstand van het wapen.

**One-hit wapens:** de Bolt-Action Sniper doodt met één bodyshot tot 70 m (daarna 85 schade: twee schoten of een headshot),
de Anti-Materiel Rifle met één treffer op elke afstand, het mes met één steek. Eén headshot doodt met de Semi-Auto Sniper (op
elke afstand), de Lever-Action Carbine (tot ~45 m) en de revolver (tot ~30 m). De shotgun doodt met één pomp tot ~8 m.

**Shotgun-patroon:** de 8 hagelkorrels vallen niet willekeurig in de kegel maar in een vast patroon (één in het midden, drie op
45%, vier op 85% van de kegel), per schot gedraaid en een beetje verschoven (`pelletPattern` in `server/Combat.ts`). Zo is de
schade op een afstand voorspelbaar: een gecentreerde pomp op 8 m doodt altijd.

**Scope en quickscope:** de sniper-scope zwaait 0,15° (was 0,24°; adem inhouden 0,02°). De eerste ~0,45 s na het inzoomen
zwaait hij maar 20% daarvan, daarna groeit het naar de volle sway in ~1 s (`SCOPE_SETTLE`); Shift houdt de adem in zoals
voorheen. Tijdens het richten geeft de camera geen
terugslag-kick meer (`viewKick`): wat in het midden van de scope staat is waar de kogel heen gaat. De combat scope zwaait niet.

**Richtkruizen per optiek** (`src/ui/ScopeReticles.ts` als SVG, scherp op elke resolutie; rode stip en holo als textuur in
`WeaponViewmodel`; screenshots `docs/screenshots/arcade/scope-*.png`, `scripts/qa/scope-shots.py`):
- *Rode stip:* stip met witte kern in een dunne ring. *Holo:* 65 MOA-ring met drie streepjes, stip en twee chevrons eronder.
- *Combat scope:* rode chevron waarvan de punt het richtpunt is, fijne lijn met mil-streepjes, en afstandsstreepjes onder het
  midden in bullet-drop-stijl. Kogels vallen niet (hitscan), dus het zijn geen holdovers: elk streepje is zo breed als een speler
  op de afstand ernaast (25/50/75/100 m). Past een doel er precies in, dan weet je de afstand.
- *Sniper-scope:* duplex (zware buitenpalen, fijne binnenlijnen) met mil-dots, een vrij midden met een verlichte rode stip,
  afstandsmeter (blokken tot wat in het midden staat: de eerste speler of wat een kogel stopt) en de zoomstand.
- *Lens:* donkere rand met een lichte buisrand, coating-tint, randschaduw en een glans; de rand verschuift een paar pixels
  tegen de kijkrichting en de pas in (parallax, uit bij Reduced Motion), het richtkruis blijft op het midden.
- *Geluid:* een zachte oogschelp-tik bij het inkijken (`scopein`) en een klik van de zoomring (`zoom`). Vijanden zien een
  scope-glinstering zodra je door een sniper-scope ongeveer naar ze kijkt (bestond al).

**Terugslag** is een vast, leerbaar patroon per wapen (`pattern`, `recoilX`): elk schot tilt je richtpunt `recoil × 0,25`°
op (40% minder als je richt) en duwt het zijwaarts volgens het patroon; laat je de trekker los, dan zakt 80% terug, binnen
~0,25 s (`RECOIL_RECOVER`; was 70% in ~0,75 s). De camera-kick bij heupvuur is gehalveerd en korter (hoogstens 3,4°, weg in
~0,2 s). Bij automatische wapens begint dat terugzakken pas na een pauze langer dan het schotinterval (×1,3, minstens 0,08 s), dus
een vastgehouden trekker blijft klimmen, ook bij de rifle (600/min = elke 0,1 s). Het
richtpunt zelf beweegt (yaw/pitch), dus wat je ziet is waar de server schiet. De LMG klimt het meest maar heeft 75 kogels.

**Grendel/hendel:** de Bolt-Action Sniper, de Anti-Materiel Rifle en de Lever-Action Carbine werken na elk schot de grendel of
hendel (geluid en animatie, de kadans blijft `rpm`).

### Rollen en balans (time to kill)

Model in `src/modes/Balance.ts`, tabel met `npx tsx scripts/ttk-matrix.ts` (`--summary` voor alleen deze tabel). Realistische
TTK in ms (body, richtfactor 0,75, kans dat een kogel binnen de hitbox valt door de spreiding, ADS-tijd erbij vanaf 7 m;
**vet** = snelste primaire wapen op die afstand):

| Wapen | 4 m | 10 m | 20 m | 35 m | 60 m | 90 m | Rol |
|---|---|---|---|---|---|---|---|
| Assault Rifle | 607 | 767 | **767** | 910 | 1053 | 1481 | Allrounder: wint op middenafstand, redt zich dichtbij en ver |
| SMG | 611 | 741 | 825 | 1314 | >5 s | >5 s | Snelst te voet; sloopt alles dichtbij, zakt weg na 20 m |
| Shotgun | **250** | **390** | >5 s | >5 s | – | – | Eén pomp doodt tot ~8 m; nutteloos voorbij 15 m |
| LMG | 636 | 906 | 906 | 906 | 1028 | 1391 | Groot magazijn (9,4 kills per magazijn op 20 m, de rest ≤ 4,3): houdt een lane en wint multikills; traag richten en herladen |
| Burst Rifle | 644 | 814 | 814 | **814** | 1099 | 1632 | Strakke bursts van drie: beloont precisie op 30–40 m |
| DMR | 750 | 930 | 930 | 930 | 930 | **930** | Drie schoten tot 90 m; met scope voor lange lijnen |
| Semi-Auto Sniper | 800 | 1030 | 1030 | 1030 | 1030 | 1030 | Twee snelle bodyshots of één headshot (55 × 1,85 = 102) op elke afstand |
| Bolt-Action Sniper | 2023 | 1396 | 1396 | 1396 | 1396 | 3936 | Eén bodyshot doodt tot 70 m; quickscope (0,24 s), trage grendel, geen heupvuur |
| Battle Rifle | 650 | 850 | 850 | 850 | **850** | 1050 | Zware automaat met combat scope: vier treffers tot 45 m, hard te beheersen, klein magazijn |
| Lever-Action Carbine | – | – | – | – | – | – | Eén headshot doodt tot ~45 m, twee bodyshots; snel richten, trage hendel |
| Anti-Materiel Rifle | 9350 | 2130 | 2130 | 2130 | 2130 | 2130 | Eén treffer doodt op elke afstand; het traagst met richten, lopen en doorladen |
| Pistol | 1050 | 1170 | 1170 | 1370 | 3320 | 3320 | Snelle, precieze backup |
| Machine Pistol | 660 | 770 | 1010 | >5 s | >5 s | – | Volautomatische paniekknop voor dichtbij |
| Revolver | 667 | 807 | 807 | 1340 | 1340 | 1873 | Eén headshot tot 30 m, twee bodyshots; traag herladen |

(De Lever-Action Carbine staat in het model op 1,6–2,6 s: het rekent een grendelwapen met 70% van de richtfactor, `BOLT_PRECISION`,
en ziet alleen bodyshots. Zijn rol is de headshot.)

**Tempo:** de tabel hierboven is het ontwerpmodel; wat een speler voelt meet `npx tsx scripts/ttk-sim.ts` met de echte
`Match`-gevechten en mensachtige duelbots (TTK van de eerste treffer tot de dood, alleen kills in één salvo), en
`npx tsx scripts/bot-pace.ts` (kills per minuut en levensduur in botwedstrijden). Na de headshot-vermenigvuldigers van ×1,4-1,5
(was ×1,6-2) en de lichtere automaten dood je met een automaat in 400-550 ms (mediaan, `ttk-sim`) en kost een headshot-spree
minstens 250 ms; de gemiddelde levensduur in botwedstrijden steeg van 14,6 naar 18,3 s. De ADS-tijden zijn korter (rifle 0,16 s,
LMG 0,27 s, snipers 0,19 / 0,23 s, battle rifle 0,2 s, DMR 0,18 s, anti-materiel 0,32 s) met dezelfde onderlinge volgorde.

Bewaakt door `tests/arcadeBalance.test.ts`: elk primair wapen heeft een niche (snelste op een afstand, meeste kills per
magazijn, one-shot bodyshot op 60 m of headshot op 35 m, of snelst te voet), geen wapen is op meer dan twee van de zes afstanden
de snelste, geen wapen domineert een ander van zijn slot (TTK op alle afstanden, magazijn, snelheid, ADS-tijd, herladen,
bodyshot- en headshot-STK), een secundair wapen is nergens sneller dan het beste primaire, en one-shot kills zijn bewust: één
bodyshot alleen met de twee grendel-snipers, één headshot alleen met snipers, lever en revolver. Grendelwapens rekenen met 70%
van de richtfactor (`BOLT_PRECISION`): één precies schot door een zwaaiende scope, een misser kost een hele grendelslag.

## Klassen (Create-a-Class)

Een klasse is **primair wapen + optiek + secundair wapen + één perk** (`ClassSpec` in `src/modes/Loadouts.ts`):

| Optiek | Effect |
|---|---|
| Iron Sights | De eigen vizieren van het wapen |
| Red Dot | Rode stip in een klein huis, iets meer zoom (×0,95 FOV) |
| Holographic | Ring met stip, nog iets meer zoom (×0,9 FOV) |
| Combat Scope | 2–2,5× prismavizier (rifle 2,2×, burst 2,2×, LMG 2×, battle 2,3×, DMR 2×, semi-auto 2,4×, lever 2,2×): een bredere lens met een dunne vignet en een oplichtende chevron, **geen sway**; 0,05 s trager richten op een wapen dat er niet voor gebouwd is. |
| Scope | Vergroting per wapen (DMR 2,2×, Semi-Auto 3×, Bolt-Action 4,5×, Anti-Materiel 6,3×), zwarte scope-overlay met mil-dots; het wapen verdwijnt uit beeld als je volledig richt. Sway, de eerste ~0,45 s maar 20% (quickscope); **Shift ingedrukt = adem inhouden** (4 s stil, daarna 2,5 s naar adem happen met meer sway). Vijanden zien een **glinstering** als je door een scope naar ze kijkt. |

| Perk | Effect |
|---|---|
| Extended Mags | +40% magazijn op beide geweren |
| Quickdraw | 40% sneller richten, wapenwissel twee keer zo snel (ook op de server) |
| Ninja | Je voetstappen zijn voor anderen alleen dichtbij (≤ 7 m) te horen in plaats van tot 26 m |
| Suppressor | Demper op het wapen: stille "thwip", tot 24 m hoorbaar, klein mondingsvuur; 20% korter schadebereik |
| Lightfoot | 8% sneller te voet (ook in het snelheidsbudget van de server), slide-cooldown 0,65 s in plaats van 0,9 s |

- **Presets als quick picks:** Assault (rifle + red dot, pistol, Quickdraw), Rusher (SMG, machine pistol, Ninja), Breacher
  (shotgun, pistol, Ninja), Support (LMG + holo, pistol, Extended Mags), Marksman (DMR + scope, revolver), Burst (burst + holo,
  pistol, Suppressor), Sniper (bolt-action, machine pistol, Quickdraw), Scout (SMG, pistol, Lightfoot: slide erin, mes of
  spray, slide eruit).
- **Menu (B):** de presets bovenaan (1–7), daaronder de **Custom**-klasse (8) met per kolom primair, optiek (optieken die het
  wapen niet kan dragen zijn grijs), secundair en perk, plus de stats van het gekozen wapen. Elke wijziging maakt de klasse je
  Custom-klasse en bewaart hem in `localStorage` (`bunkcraft.arcadeClass`); de laatst gekozen klasse (`bunkcraft.arcadeClass.last`)
  gaat bij het joinen meteen naar de server. Op het doodscherm kies je met 1–8.
- **Server:** bericht `loadout { primary, secondary?, optic?, perk? }`. Elk veld wordt gecontroleerd (`validateClass`): onbekend
  of niet toegestaan → standaard (rifle, iron, pistol, geen perk); een optiek die het wapen niet kan dragen wordt de standaardoptiek
  van dat wapen. Een klasse gaat direct in (`gear`) **buiten een live ronde** (warm-up, aftellen, tussen rondes) en in een live
  ronde **binnen 3 s na je spawn en vóór je eerste schot**, anders bij je volgende leven. De regel staat één keer in
  `classApplies` (`src/modes/Loadouts.ts`); het menu zegt er per situatie bij wanneer je keuze ingaat. Het menu toont de
  gekozen klasse in de editor; aanpassen begint vanaf die klasse en maakt er je Custom-klasse van. `spawn`/`gear` dragen `optic` en `perk`; `holds` draagt `optic`, `sup` (demper) en `quiet` (Ninja) zodat
  anderen het juiste model, de demper en de glinstering zien en je stappen goed horen.
- **Gun Game** houdt zijn vaste ladder (geen klassen, geen perks). De ladder begint met de rifle (eerste kill duurde met de
  shotgun op grote kaarten > 50 s, zie `docs/qa/ARCADE.md`), bevat alle 14 vuurwapens (19 treden) en eindigt op one-hit wapens
  (`GUN_GAME_FINALE`): shotgun, revolver, Bolt-Action Sniper, dan het mes (één steek) dat wint.

Screenshots: `docs/screenshots/arcade/` (`scripts/qa/weapon-shots.py`): `rifle-reddot-ads.png`, `rifle-holo-ads.png`,
`lmg-holo-ads.png`, `sniper-scope.png`, `dmr-scope-breath.png`, `class-menu.png`, `model-*.png`.

## Voortgang (XP, levels, ontgrendelingen)

Realms heeft CoD/Krunker-achtige voortgang zonder accounts: de server geeft je browser een ondertekend profieltoken en
houdt het profiel bij in `DATA_DIR/profiles/` (zie [`SERVER.md`](SERVER.md#realms-profielen-xp-en-levels-zonder-accounts)).
Je voortgang blijft na herladen bewaard en telt in elke lobby op dezelfde server. Regels: `src/modes/progression/*`
(gedeeld door client en server, Vitest in `tests/progression.test.ts`).

- **Levels:** 1-55, daarna **prestige** (tot 10) via *Profiel* in de Realms-hub: terug naar level 1 met een nieuw
  rangicoon, ontgrendelingen, statistieken en camo's blijven. Level L→L+1 kost `800 + 120·(L−1)` XP: level 2 is ongeveer
  één match, level 55 rond de 180 matches van tien minuten.
- **XP per match** (`XpRules.ts`, alleen de server telt): kill 100 (na 6 kills op hetzelfde slachtoffer 25), headshot +25,
  meskill +25, assist 40 (schade binnen 10 s voor de kill), vlag veroveren 300, vlag terugbrengen 75, zone veroveren 150
  (iedereen van het team in de zone), hardpoint 5 per seconde in de heuvel, match uitgespeeld 250, winst +400, gelijkspel
  +150. Maximaal 6000 per match; uitdagingen komen erbovenop. Wie halverwege vertrekt houdt de XP tot dan, zonder bonus.
- **Ontgrendelingen** (`Unlocks.ts`): level 1 heeft al assault rifle, SMG, shotgun, pistool, red dot, Extended Mags,
  Quickdraw en Ninja (de presets Assault en Breacher). Daarna: 2 holo, 3 machine pistol, 4 DMR, 5 LMG, 6 scope,
  7 suppressor, 8 burst rifle, 9 revolver, 10 semi-auto sniper, 12 bolt-action sniper. Create-a-Class toont wat op slot
  zit grijs met het level (`Lv 7`); de server zet een vergrendeld onderdeel terug naar de standaard.
- **Wapen-XP en camo's** (`Camos.ts`): elk wapen krijgt XP voor kills (100), headshots (25) en assists (30), tot
  wapenlevel 25. Camo's (procedurele kleurpatronen op het voxelmodel, `src/rendering/WeaponCamo.ts`): Woodland (2),
  Desert (4), Arctic (6), Urban (8), Tiger (10), Crimson (13), Cobalt (16), Gold (20), Diamond (25). Kiezen in de
  *Armory*; alleen jij ziet je camo (first person).
- **Uitdagingen** (`Challenges.ts`): elke dag (UTC) 3 dagelijkse (750 XP) en elke maandag 3 wekelijkse (2500 XP), voor
  iedereen dezelfde, gekozen uit een vaste pool ("10 kills met een SMG", "verover 3 zones", "win 2 potjes").
- **Cosmetica:** titels (Recruit, Soldier ... Legend, Grinder na 10 uitdagingen, Prestige Master) en visitekaartjes
  (procedurele achtergronden van de profielbalk), ontgrendeld per level, prestige of aantal uitdagingen.
- **Rangicoon** naast namen in het scoreboard, de killfeed en het lobbypaneel (`roster.rk` = prestige·100 + level).
- **UI:** profielbalk met level en XP-balk bovenaan de Realms-hub, knoppen *Stats* (K/D, winst, trefzekerheid,
  favoriete wapen, per modus, laatste 10 matches), *Challenges* en *Armory*; klik op de balk voor titel, kaartje en
  prestige. Na een match staat de XP-opbouw met level-up, ontgrendelingen en nieuwe camo's op het eindscherm.

## Geluid

Alles procedureel (geen samples), data in `src/core/audio/weaponSounds.ts`, recepten in `AudioEngine`:

- **Schot per wapen in lagen:** transient (korte felle crack), body (band-beperkte ruis + dalende sinus-thump) en een staart.
  Buiten (`env.enclosure` laag) een lange donkere echo met een late "slap" van verre muren; binnen vroege reflecties en een korte
  heldere ruimte. Eigen schoten krijgen ook de klik van het mechaniek.
- **Afstand en muren:** elk wapen heeft een hoorafstand (machine pistol 55 m … bolt-action 160 m, gedempt 24 m); ver weg wordt
  het een gedempte "pop + boem", en de bestaande ruimtelijke keten (afstand, luchtdemping, occlusie door blokken, stereo/HRTF)
  maakt schoten achter muren dof.
- **Handelingen:** herlaadsequenties per wapenklasse (magazijn eruit/erin, grendel/charging handle; shotgun patroon per patroon +
  pomp; revolver cilinder open, hulzen, patronen, dicht; LMG klep open, band, klep dicht), grendel na elk sniperschot, droog
  klikken, stoffen ritsel bij richten in/uit, wapenwissel. De stappen volgen de herlaadvoortgang, dus een afgebroken herlading
  stopt ook in het geluid.
- **Vijanden horen aankomen:** voetstappen van andere spelers per ondergrond, positioneel (tot 26 m, Ninja 7 m) met wat
  uitrusting-rammel; bij Subtitles een caption "Footsteps" met richting. Stappen binnen 12 m hebben de prioriteit van een
  schot (`remoteStepPriority`): in een vuurgevecht met 16 spelers zit de stemmenlimiet vol en verdwenen ze anders.
  In de arcade staan de captions boven de wapenslots en de munitie.
- **Feedback:** hitmarker als droge, korte "thwack" (tik op een lage klop), headshot een heldere metalen *tink* die naklinkt,
  kill confirm (thunk + twee tonen), medailles voor double/triple/multi
  kill (binnen 3,5 s) en killstreaks 3/5/10 (koperachtige arpeggio's + tekst onder het richtkruis), stingers bij matchstart en
  -einde (winst, verlies, gelijkspel). Adem inhouden/uitblazen bij de scope.
- **Ducking:** treffer, headshot, kill, schade en de hartslag laten de wereldgeluiden (en de muziek iets minder) heel even
  zakken (`AudioEngine.duck`, mixer-knoop `duck`), zodat ze in een vuurgevecht doorkomen.
- **Kogels om je heen:** inslagen per materiaal (steen: crack + splinters, soms een ricochet; hout: tok; metaal: ping;
  glas: rinkelende scherven; aarde/zand: doffe plof; wol; bladeren), en een kogel die binnen 2,2 blok langs je hoofd gaat
  geeft een supersonische crack met een dalend gefluit van waar hij langskwam.
- **Schoten:** per schot ±1 dB en een paar procent toonhoogte variatie, en een korte breedbandige klik (een paar ms) voor de
  punch; herlaadstappen hebben een lage klop als het magazijn of de grendel vastklikt.
- **Lage health:** onder 35 een hartslag (onder 20 sneller).
- **Volume en toegankelijkheid:** alles via de sfx/ui-bussen (volume-instellingen gelden); elk geluid meldt zich bij de
  Subtitles-luisteraar, en de arcade-sessie geeft captions voor schoten ("Gunshot", "Suppressed shot", "Distant gunfire"),
  voetstappen, medailles, match start/einde, langsfluitende kogels, de hartslag en brekend glas.
- **Budget:** schoten van anderen gebruiken drie stemmen (crack, body die in de ruimtestaart overgaat, thump), ver weg één, en er
  worden er hooguit drie per frame gebouwd; de stemmenlimiet (64, prioriteiten) doet de rest. `python3 scripts/audio-report.py`:
  alle geluiden binnen de grenzen, worst case (16 spelers SMG + explosie) 0,26 ms/frame (budget 0,3).

## Matchregels

- Een match begint met een **warm-up** (aftelling), daarna `live`, en eindigt (`ended`) bij de score limit of als
  de tijd om is; na `restartIn` seconden begint een nieuwe match.
- Rondemodes (elimination) hebben daartussen per ronde `intermission` (iedereen terug bij de spawn, wapen kiezen, geen
  schade), `countdown` (3 s), `live` (de rondetijd) en `roundend` (uitslag, 4 s). De klok toont dan "NEXT ROUND".
- De respawntijd en spawnbescherming komen uit het type: 2,5 s / 2 s (tdm, ffa), 1,5 s / 1 s (gun game), 3 s / 2 s
  (hardpoint, domination, ctf), geen respawn binnen een ronde (elimination). Spawnbescherming **eindigt bij je eerste schot**.
- Je respawnt na de timer op de server (`spawn`), met volledige health, je geladen loadout en spawn-bescherming.
- **Spawnkeuze** (`Match.pickSpawn`): zo ver mogelijk van de dichtstbijzijnde levende tegenstander, −8 als een tegenstander
  binnen 35 blokken de plek kan zien, −3 per schot in de buurt (14 blokken) in de laatste 3 s, +1 met een teamgenoot binnen 25
  blokken, plus wat willekeur. Sterkere straffen kozen in botmatches dichterbij verstopte plekken en gaven méér spawnkills.
- **Killstreak:** elke 5e kill in één leven geeft een **radarscan**: de posities van de levende tegenstanders, 4 s zichtbaar als
  rode ruiten voor jou en je team (`radar`-bericht). Geen airstrikes of nuke.
- **Lage health:** onder 35 pulseert de schermrand rood (Reduce Flashes begrenst het).
- Health regenereert na `REGEN_DELAY` (5 s) zonder schade met `REGEN_PER_SECOND` (25) per seconde.
- Hitboxen volgen het getekende model (zie *Treffers en lag compensation*): hoofd 1,35-1,8, romp, de opgeheven armen, benen;
  1,8 hoog staand, 1,5 gehurkt, 1,15 in een slide.
- Een klasse geldt vanaf je **volgende leven**, behalve als je hem binnen 3 s na je spawn en vóór je eerste schot kiest: dan meteen.

### Terugkeren na een verbroken verbinding (rejoin)

Wie uit een arcade-match valt (netwerk, pagina herladen, browsercrash, de server die een speler voor lag verwijdert) hoeft niet
opnieuw te beginnen. **Niet** voor valsspelen, een ban of een kick van een operator, en niet als je zelf via "Terug naar
titelscherm" weggaat (de client stuurt dan `bye`: de plek is meteen vrij en het ticket weg).

- **Wat de server bewaart** (`Match.parked`, `REJOIN_GRACE_SEC` = 120 s): team, kills, deaths, doelpunten (`pts`: gun-game-level,
  vlaggen, zones), killstreak, de gekozen class, de rank en de **match-XP** (de `MatchRecorder`-tally; de klok van "tijd gespeeld"
  staat stil zolang je weg bent). Niet bewaard: het leven zelf (health, munitie, positie): je spawnt vers.
- **De plek blijft bezet.** Bots nemen hem niet (ze tellen bewaarde plekken als mensen voor het aantal, maar spelen alleen als er
  iemand verbonden is), Snel spelen rekent hem mee als bezet, het team blijft in balans (`seatedTeamSize`), een nieuwe speler met
  jouw naam wordt geweigerd. Een lobby bewaart hooguit de helft van zijn plekken tegelijk (daarna vervalt de oudste), zodat niemand
  een lobby kan dichtzetten door te bellen en weg te vallen. Blijven er alleen bewaarde plekken over, dan **staat de match stil** en wordt
  een lobby die helemaal leegloopt na de grace opnieuw begonnen; de kamer blijft zo lang geladen.
- **Wie mag terugkomen** (`hello.rejoin` of een van de twee andere bewijzen, altijd met dezelfde naam): het **rejoin-token** uit de
  vorige `welcome` (192 bit, alleen de hash staat op de server, eenmalig: elke welcome geeft een nieuwe), de **identiteitssleutel**
  van de browser (de naamclaim), of het **ondertekende profieltoken**. Een token geldt alleen in de lobby die het uitgaf; een
  ander token, naam of lobby geeft gewoon een nieuwe speler en raakt de bewaarde plek niet. Een login die nog open staat
  (herladen vóór de server de oude socket zag sluiten) neemt de plek over.
- **Geen misbruik:** een terugkerende speler spawnt pas na `max(3 s, de respawn waar hij op wachtte)`; wie binnen 5 s na schade
  wegviel krijgt de **dood** alsnog (geen ontsnappen, genezen of herladen door opnieuw te verbinden); deaths, score en streak
  worden nooit gereset; spawnbescherming is de gewone van een respawn. In een rondemode kom je terug als toeschouwer tot de volgende ronde.
- **Match afgelopen terwijl je weg was:** de XP voor de gespeelde tijd wordt aan het einde uitbetaald (resultaat naar je team;
  in een vrij-voor-allen beslissen de aanwezigen), precies één keer; het rapport (`progress`) wacht op je terugkeer. Loopt de
  plek af midden in een match, dan krijg je wat je tot dan deed zonder voltooiings- of winbonus (zoals bij weggaan). Bij een
  nieuwe match beginnen de bewaarde plekken ook op nul en worden opnieuw ingedeeld.
- **Client:** valt de verbinding weg dan toont het spel "Opnieuw verbinden..." en probeert het opnieuw met een pauze die
  groeit (1, 2, 4, 8 s, daarna 8 s) tot de grace (+20 s) voorbij is; een weigering van de server (vol, naam bezet, ban) stopt het
  meteen. Het rejoin-token staat samen met de lobbycode in `sessionStorage` en `localStorage` (`bunkcraft.rejoin`, `src/net/Rejoin.ts`).
  Na een herlading staat op het startscherm **"Ga terug naar je match (code XYZ, nog 1:45)"**, na een controle bij
  `POST /api/rejoin`.
- **Build & Survival** kent geen grace: positie, inventory en health staan per speler in `world.json` en horen bij de naam. Een
  verbinding die wegvalt (of een herlading die de server voor is) levert dezelfde staat op; de server schrijft die nu ook
  binnen twee seconden na het weggaan weg (niet pas bij de volgende 30-secondenronde). De client verbindt zelf opnieuw.

### Tempo gemeten (botmatches)

`npx tsx scripts/flow-metrics.ts 8 300 --maps=classic,suburb,quarter,town,dockyard --type=tdm|ffa --seed=1..3`: 8 bots via de echte
server, 5 kaarten × 300 s, gemiddeld over 3 seeds. Bots lopen eerlijke paden (6 b/s, geen slides) en schieten na 0,6 s
reactietijd. *Naar gevecht* = mediaan van spawn tot eerste schade; *stil* = gemiddelde pauze tussen gevechten tijdens een leven;
*spawnkill* = dood binnen 3 s na spawn (*passief*: zonder zelf geschoten te hebben); *hete spawn* = vijand binnen 20 blokken.

| | kills/min | leven (s) | naar gevecht (s) | stil (s) | spawnkill % | passief % | hete spawn % |
|---|---|---|---|---|---|---|---|
| TDM voor | 20,6 | 19,5 | 6,3 | 7,2 | 1,4 | 0,0 | 11,6 |
| TDM na | 22,1 | 18,4 | 6,1 | 7,3 | 3,0 | 0,0 | 13,5 |
| FFA voor | 34,2 | 11,1 | 3,0 | 4,6 | 2,7 | 0,1 | 14,1 |
| FFA na | 37,8 | 10,3 | 2,9 | 4,3 | 6,4 | 0,1 | 20,5 |

Sneller respawnen geeft +8% (TDM) tot +11% (FFA) kills per minuut. Spawnkills stijgen omdat bescherming nu eindigt bij je eerste
schot (bots schieten na 0,6 s terug en verliezen dan hun schild); *passieve* spawnkills (je schoot niet) blijven ~0. De grootste
tempowinst voor echte spelers komt van de beweging (slides) en van jump pads op de kaarten; die zitten niet in de bots.

## Treffers en lag compensation

De server beslist (`server/Match.ts`), met dezelfde code als de client (`src/modes/Hitscan.ts`), zodat wat je ziet is wat telt:

- **Terugspoelen naar wat jij zag.** Snapshots dragen het servertick-nummer (`snap.k`, binair formaat 3); de client stuurt bij
  elk schot de (fractionele) tick die hij op dat moment tekende (`fire.rk`, uit de snapshotklok in `SnapshotClock.ts`) en de
  server spoelt de doelen precies daarheen terug (positie, yaw en pitch uit de geschiedenis). De claim mag niet verder terug
  dan ping + interpolatie + 0,15 s (`rewindLimit`), nooit meer dan 0,4 s. Oude clients: de volle ping (niet de halve) +
  interpolatie. De peek-grens (een doel dat al 0,15 s achter dekking stond wordt niet terug de open ruimte in gespoeld) blijft.
- **Hitboxen = het model.** De speler wordt op schaal 0,9 getekend (32 px = 1,8 blok, gelijk aan de botsingsdoos; het oog op
  1,62 zit in het hoofd). De hitboxen zijn de modeldelen: hoofd (8 px kubus op de nek, kantelt met de pitch), romp, beide armen
  zoals ze het wapen vasthouden (draaien met yaw en pitch), benen (diep genoeg voor de meeste pas). Overal 0,04 marge; waar
  marges van hoofd en arm overlappen beslist het echte model wie ervoor zit. Hoofd telt als headshot, de rest als lichaam.
  Hurken (1,5) en sliden (1,15): het model en de hitboxen worden vanaf de voeten lager geschaald (`rayPlayer`, laatste argument).
- **Spreiding met een zaadje.** De server deelt per speler een zaadje uit (`spawn.ss`); schot n en hagelkorrel k krijgen
  dezelfde willekeur op client en server (`spreadRandom`), met dezelfde regel (`shotSpread`: heup/ADS, bewegen, in de lucht;
  `fire.mv`/`fire.air`, de server zet `mv` zelf als hij je ziet rennen). `ammo.sn` en `ammo.seq` houden de teller gelijk.
  Je tracers (ook alle hagelkorrels) zijn dus de kogels die de server test, en eindigen op de speler die ze raken.
- **Kogels door glas (schakelaar `GLASS_PASSES_DEFAULT` in `Hitscan.ts`, staat AAN).** De spawns van suburb, quarter,
  atomic, plaza en mall zijn afgeschermd met massieve blokken (`spawnExposure.test.ts` draait met glas aan). Glas,
  glazen panelen, gebrandschilderd glas en bladeren laten een kogel door: één raam of haag per
  kogel (twee glazen blokken achter elkaar tellen als één ruit), 20% schade minder (bladeren 10%). Een tweede raam of een
  muur van vijf glasblokken stopt hem. Slabs, trappen, hekken en muren stoppen kogels alleen waar hun vorm zit; ijzeren
  tralies als een blok. De client tekent glasscherven en speelt een glasgeluid waar een kogel door een ruit gaat (ook bij
  schoten van anderen). Ramen breken niet: dan worden ramen doorgangen (bewegingscheck, spawnzichtlijnen), dat is een
  kaartkeuze. De anti-wallhack-culling liet spelers achter glas al zien (alleen ondoorzichtige blokken blokkeren zicht).
- **Meten:** `npx tsx scripts/hitreg-sim.ts` (gesimuleerd netwerk, echte servercode, missers per ping en beweging) en
  `npx tsx scripts/qa/hitreg-browser.ts --rtt=100 --jitter=20` (echte browsers en bots, zie `docs/qa/ARCADE.md`).
  `ARCADE_SHOT_DEBUG=1` op de server stuurt per schot `shotdbg` (terugspoeltijd en geteste posities) naar de schutter.

## Netwerk (client)

Client → server: `loadout` (`primary`, optioneel `secondary`), `fire` (oog, richting, `ads`; max. `fireInterval` per slot), `reload`, `weapon`.
Server → client: `match` (met optioneel `text`: de regel onder de timer), `roster` (optioneel `pts`), `spawn` (optioneel `secondary`),
`hp`, `ammo`, `shot`, `hit`, `damaged`, `kill`, `matchend`, `holds`, en voor de objective-modes `mode` (zones, vlaggen of rondes),
`event` (vlag gepakt/gevallen/terug/gescoord, zone ingenomen/verloren/verplaatst, ronde gestart/gewonnen, niveau op/af) en `gear`
(de server wisselt je wapens tijdens je leven: gun game). Alles is optioneel en achterwaarts compatibel: protocolversie blijft 4.

- `shot` van andere spelers geeft een tracer van de loop naar `end`, een stofwolkje als `end` op een blok ligt en een
  geluid met afstandsdemping. De eigen `shot` wordt genegeerd: je eigen tracer en effecten komen direct.
- `damaged.dx/dz` wijzen **van jou naar de schutter** (wereldrichting); de indicator draait met je blik mee.
- Andere spelers dragen een shirt en haarband in teamkleur, hun naamtag heeft de teamkleur en ze houden het wapen uit
  `holds` vast met opgeheven armen. **Naamtags** worden nooit door muren heen getekend: een tag verschijnt alleen als er een
  vrij blokpad is van de camera naar het hoofd (raycast, per speler om de 100 ms, binnen 60 blokken) en vervaagt in en uit;
  dat geldt voor teamgenoten en tegenstanders. Na een kill ligt het lichaam kort op de grond en verdwijnt tot de respawn.

## Ontwikkelen en testen zonder server

In een dev-build (`npm run dev`) start `window.game.arcadePreview(type)` (elk arcade-type) een lokale testarena met een nep-server
(`src/core/ArcadePreview.ts`): bots lopen rond en schieten, jouw schoten leveren `ammo`, `shot`, `hit` en `kill` op en je
respawnt echt. Via `game.previewServer` kun je gebeurtenissen forceren (`damage`, `killSelf`, `killBot`, `botKill`,
`fillScores`, `endMatch`, en voor de objective-modes `demo()` (een typische zone-, vlag-, ronde- of laddertoestand op de
gekozen kaart), `setPhase(phase, sec, text)`, `event(kind, team, id, text)`, `modeState(state)`, `ladder(level)`). Met een derde argument (`arcadePreview('tdm', 'You', 'dockyard')`) speel je op de echte kaart
in plaats van de nep-arena. Zet voor automatische tests `game.input.locked = true; game.state = 'playing'` en stuur
invoer via `game.input.down.add('Mouse0')` (zie de gotchas in `CLAUDE.md`). In een productiebuild bestaat de preview niet.

## Een nieuw game type toevoegen

1. **Data:** een regel in `GAME_TYPES` (`src/modes/GameTypes.ts`): id, naam, beschrijving, `teams`, limieten en hun keuzes
   (`options`), `respawn` (`timer` of `never`), `rounds` (fases), `loadout` (`free` of `ladder`), `requires` (kaartdata),
   `params`, `scoring`, `hud` en eventueel `scoreColumn`. Breid het type `GameType` uit. Menu, room-API (limieten worden op de
   keuzes van het type begrensd), recente games en joinscherm pakken het vanzelf op.
2. **Regels:** een kleine klasse in `server/modes/<id>.ts` die `ModeLogic` implementeert (meestal `extends BaseLogic`, dat
   deathmatch-gedrag geeft) en een regel in `createLogic` (`server/modes/index.ts`). Zie `docs/SERVER.md`.
3. **Kaartdata:** heeft het type zones, vlaggen of bomsites nodig, zet ze in `objectives` van de kaarten (`src/modes/maps/*`, wereld-
   coördinaten; `scripts/objective-eval.ts` toetst kandidaten aan de regels van `tests/mapObjectives.test.ts`, `scripts/site-scan.ts`
   zoekt bomsites). Hooks voor regels die meer doen dan scoren: `teamFor`, `keepTeams`, `speedMul`, `damageMul`, `pickSpawn`,
   `loadoutFor` (mag per speler `undefined` geven) en `objectives` voor server-bots.
4. **Client:** een nieuwe `ModeState`-soort in `protocol.ts` plus een widget in `ModeHud.ts`/`ModeView.ts`; de rest
   (fases, banners, respawnregel, ladder) volgt uit de def.
5. **Tests:** Vitest met de stub-host (`tests/helpers/matchHost.ts`, voorbeelden in `tests/modes.test.ts`) en een run met echte
   bots: `ROOM_CREATE_LIMIT=1000 npm run server` en `npx tsx scripts/modes-bots.ts <type>`.
