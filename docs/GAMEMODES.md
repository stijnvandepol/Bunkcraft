# BunkCraft game types

Singleplayer en **Multiplayer** zijn Minecraft: Multiplayer maakt, toont en joint alleen Minecraft-games. De zeven
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
| Classic | `classic` | De oorspronkelijke arena (96 × 96): middenplatform, corridors, dekking. Steen en hout. | zones, vlaggen |
| Maple Court | `suburb` | Klein en snel (64 × 40): twee bakstenen huizen met tuin tegenover elkaar, een straat met auto's en een bestelbus, garages op de hoeken, trappen naar de platte daken. Close quarters. | zones |
| Old Quarter | `quarter` | Stedelijk (80 × 64): een binnenplaats met fontein, een poortgebouw, hoge bakstenen blokken met balkons en dakstairs, steegjes van 4 breed als flanken, een omheind plein per team. | zones, vlaggen |
| Harbor Yard | `dockyard` | Industrieel (88 × 64): containerstapels van gekleurde wol (teamkleuren aan de eigen kant), een grote loods in het midden, een kraandek op houten pilaren en een schip met een brug om vanaf te snipen. | zones, vlaggen |
| Dust Bazaar | `desert` | Lange zichtlijnen (96 × 64): zand en zandsteen, een markt met gestreepte kramen, platte daken langs een lange open baan en een sluipschuttertoren aan elk uiteinde, achter de ommuurde teambasis. | – |
| Atomic Lane | `atomic` | Vrije (puntsymmetrische) kaart (80 × 52): twee huizen, een bus en een rotonde. Standaard in het menu. | zones, vlaggen |
| Skyline Villa | `villa` | Vrije (puntsymmetrische) kaart (88 × 64): een witte villa op een heuvel, zie hieronder. | zones, vlaggen |
| Riptide | `yacht` | Vrije kaart (88 × 56): een superjacht in een jachthaven, zie hieronder. | zones, vlaggen |
| Sundown | `town` | Vrije kaart (80 × 68): een stoffig kruispuntdorp, zie hieronder. | zones, vlaggen |
| Terminus | `station` | Vrije kaart (84 × 68): een treinstation, zie hieronder. | zones, vlaggen |
| Bunker Flag | `bunker` | Voor capture the flag (64 × 40): een droge rivierbedding met oevers van 2 hoog, twee oversteekplaatsen en een overdekte duiker in het midden; elke vlag in een betonnen bunker met één deur achter een scherfmuur, spawns in een ommuurde tuin erachter. | zones, vlaggen |

### Vrije kaarten in BO2-stijl

Net als Atomic Lane getekend met `layout: 'free'`: één helft wordt getekend en voor de andere helft 180° om het midden
gedraaid (`turned()` in `helpers.ts`), met een eigen palet en eigen details per helft. De routes zijn daardoor eerlijk,
maar de twee kanten zien er anders uit. Screenshots: `docs/screenshots/maps/<id>-*.png` (`python3 scripts/shots.py <id> docs/screenshots/maps <poort>`).

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

Screenshots: `docs/screenshots/modes/` (gemaakt met `python3 scripts/mode-shots.py <map> [poort]`).

## Wat anders is dan in de sandbox

- Geen hotbar, hartjes, honger of lucht: een eigen HUD (`src/ui/ArcadeHud.ts`).
- Geen blokken breken of plaatsen, geen mobs, geen items, geen inventory of crafting (`Interaction.arcade`).
  Chat blijft werken.
- Geen valschade en geen honger. De server bepaalt je health.
- **Beweging:** altijd sprinten (1,3× Minecraft-sprint, met de `moveSpeed` van je wapen), meer luchtbesturing
  (`airAccel` 8 tegen 4,5) zodat bunny hoppen werkt: je behoudt je snelheid bij het landen als je blijft
  springen. Geen sneak en geen vliegen.

## Besturing

Alles is aan te passen in *Options → Controls → Key Binds* (categorie **Arcade**).

| Actie | Standaard |
|---|---|
| Lopen, springen | W A S D, spatie |
| Schieten | linkermuisknop (vasthouden bij automatische wapens, klikken bij semi-automatische) |
| Richten (ADS) | rechtermuisknop vasthouden |
| Herladen | R |
| Wapen kiezen | 1 primair, 2 secundair, 3 melee, of het muiswiel |
| Vorig wapen (quick switch) | Q |
| Scoreboard | Tab (vasthouden) |
| Create-a-Class (klassen) | B |
| Scope stilhouden (adem inhouden) | Shift ingedrukt tijdens het richten door een scope |
| Chat | T |
| HUD verbergen | F1 |

Op het doodscherm kies je met 1–8 de klasse voor je volgende leven (7 presets en je Custom-klasse). Esc opent het pauzemenu;
de match loopt op de server gewoon door.

## HUD

Alle teksten zijn NL/EN (`arc.*` en `mode.*` in `src/ui/i18n.ts`). De Engelse regels die de server stuurt (onder de timer,
gebeurtenissen) vertaalt de client bij binnenkomst (`localizeServerText` in `src/modes/ModeView.ts`); wapen-, perk-, optiek-
en kaartnamen blijven zoals ze zijn.

- **Health** linksonder (getal en balk, knippert rood onder 30), **munitie** rechtsonder (`magazijn / ∞`,
  wapennaam, herlaadbalk) en de drie wapenslots.
- **Richtkruis** dat meegroeit met de spreiding (heup groter, richten kleiner, bewegen en in de lucht groter)
  en verdwijnt bij richten (de vizieren, de rode stip of de holo-ring nemen het over) en achter de scope.
- **Medailles** onder het richtkruis (double/triple/multi kill, killstreak 3/5/10) en de ademmeter in de scope.
- **Hit markers:** wit tikje bij een treffer, goud bij een headshot, rood met een geluid bij een kill.
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
| Assault Rifle | primair | auto | 20 | ×2 | 600 | 30 | 1,3 s (0,98 s) | 2,2° / 0,4° | 32 / 80 m (min. 55%) | 0,24 s | 1,3× / 1,3× / 1,4× / 2,2× | ×1 | iron, reddot, holo, combat |
| SMG | primair | auto | 15 | ×1,8 | 900 | 25 | 1,1 s (0,83 s) | 2,6° / 1,2° | 16 / 50 m (min. 50%) | 0,17 s | 1,2× / 1,2× / 1,3× | ×1,08 | iron, reddot, holo |
| Shotgun | primair | semi | 8 × 18 | ×1,5 | 80 | 6 | 1,9 s (1,42 s) | 3,2° / 2,6° | 9 / 24 m (min. 20%) | 0,2 s | 1,1× / 1,2× | ×0,97 | iron, reddot |
| LMG | primair | auto | 19 | ×1,7 | 720 | 75 | 3,4 s (2,55 s) | 3,2° / 0,55° | 38 / 95 m (min. 62%) | 0,42 s | 1,3× / 1,3× / 1,4× / 2× | ×0,88 | iron, reddot, holo, combat |
| Burst Rifle | primair | burst (3) | 22 | ×1,6 | 900 (cyclus 0,34 s) | 30 | 1,35 s (1,01 s) | 2° / 0,25° | 45 / 85 m (min. 55%) | 0,25 s | 1,3× / 1,3× / 1,4× / 2,2× | ×1 | iron, reddot, holo, combat |
| DMR | primair | semi | 34 | ×2 | 270 | 12 | 1,6 s (1,2 s) | 3,5° / 0,1° | 90 / 160 m (min. 70%) | 0,28 s | 1,4× / 1,5× / 1,6× / 2× / 2,2× | ×0,96 | iron, reddot, holo, combat, scope |
| Semi-Auto Sniper | primair | semi | 55 | ×1,85 | 125 | 6 | 1,9 s (1,42 s) | 7° / 0,05° | 70 / 160 m (min. 80%) | 0,36 s | 3× / 2,4× | ×0,93 | scope, combat |
| Bolt-Action Sniper | primair | grendel | 100 | ×1,5 | 45 | 4 | 2,1 s (1,58 s) | 9° / 0° | 70 / 160 m (min. 85%) | 0,3 s | 4,5× | ×0,92 | scope |
| Battle Rifle | primair | auto | 30 | ×1,6 | 420 | 20 | 1,6 s (1,2 s) | 2,8° / 0,35° | 45 / 100 m (min. 60%) | 0,32 s | 2,3× / 1,3× / 1,4× / 1,5× | ×0,95 | combat, iron, reddot, holo |
| Lever-Action Carbine | primair | hendel | 50 | ×2,1 | 120 | 8 | 1,9 s (1,42 s) | 2,4° / 0,1° | 40 / 90 m (min. 70%) | 0,24 s | 1,4× / 1,5× / 2,2× | ×1 | iron, reddot, combat |
| Anti-Materiel Rifle | primair | grendel | 150 | ×1,2 | 30 | 3 | 2,4 s (1,8 s) | 12° / 0° | 120 / 300 m (min. 80%) | 0,5 s | 6,3× | ×0,85 | scope |
| Pistol | secundair | semi | 18 | ×2 | 400 | 12 | 0,95 s (0,71 s) | 1,8° / 0,5° | 25 / 60 m (min. 50%) | 0,15 s | 1,1× | ×1,04 | iron |
| Machine Pistol | secundair | auto | 12 | ×1,6 | 1000 | 20 | 1,2 s (0,9 s) | 3,2° / 1,5° | 9 / 30 m (min. 45%) | 0,14 s | 1,1× | ×1,05 | iron |
| Revolver | secundair | semi | 52 | ×2 | 150 | 6 | 1,8 s (1,35 s) | 2,5° / 0,15° | 30 / 70 m (min. 60%) | 0,2 s | 1,2× | ×1 | iron |
| Knife | melee | semi | 100 | ×1 | 120 | – | – | – | 2,6 / 2,6 m | – | – | ×1,08 | – |

De spreiding is de halve openingshoek van de kegel waarin een kogel kan landen. Een scope op een wapen dat er niet voor gebouwd
is kost 0,08 s extra ADS-tijd, de combat scope 0,05 s (niet op de Battle Rifle, die er standaard een heeft).

**Herladen:** met kogels in het magazijn is het een tactische herlading (75% van de lege, `reloadTimeFor`). De client speelt
animatie en geluid op die tijd en is klaar zodra de animatie klaar is; de server neemt een schot tot 0,1 s vóór zijn eigen
timer aan (het schot reist dezelfde halve ronde als het verzoek), dus na de animatie wacht je nergens op.

**One-hit wapens:** de Bolt-Action Sniper doodt met één bodyshot tot 70 m (daarna 85 schade: twee schoten of een headshot),
de Anti-Materiel Rifle met één treffer op elke afstand, het mes met één steek. Eén headshot doodt met de Semi-Auto Sniper (op
elke afstand), de Lever-Action Carbine (tot ~45 m) en de revolver (tot ~30 m). De shotgun doodt met één pomp tot ~8 m.

**Shotgun-patroon:** de 8 hagelkorrels vallen niet willekeurig in de kegel maar in een vast patroon (één in het midden, drie op
45%, vier op 85% van de kegel), per schot gedraaid en een beetje verschoven (`pelletPattern` in `server/Combat.ts`). Zo is de
schade op een afstand voorspelbaar: een gecentreerde pomp op 8 m doodt altijd.

**Scope en quickscope:** de eerste ~0,45 s na het inzoomen zwaait de scope maar 20% van zijn sway, daarna groeit het naar de
volle sway in ~1 s (`SCOPE_SETTLE`); Shift houdt de adem in zoals voorheen. Tijdens het richten geeft de camera geen
terugslag-kick meer (`viewKick`): wat in het midden van de scope staat is waar de kogel heen gaat. De combat scope zwaait niet.

**Terugslag** is een vast, leerbaar patroon per wapen (`pattern`, `recoilX`): elk schot tilt je richtpunt `recoil × 0,32`°
op (30% minder als je richt) en duwt het zijwaarts volgens het patroon; laat je de trekker los, dan zakt ~70% terug.
Bij automatische wapens begint dat terugzakken pas na een pauze langer dan het schotinterval (×1,3, minstens 0,09 s), dus
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
| Assault Rifle | 567 | 807 | **807** | 940 | 1073 | 1880 | Allrounder: wint op middenafstand, redt zich dichtbij en ver |
| SMG | 556 | 726 | 814 | 1683 | >5 s | >5 s | Snelst te voet; sloopt alles dichtbij, zakt weg na 20 m |
| Shotgun | **250** | **450** | >5 s | >5 s | – | – | Eén pomp doodt tot ~8 m; nutteloos voorbij 15 m |
| LMG | 583 | 1003 | 1003 | 1003 | 1190 | 2804 | Groot magazijn (9,4 kills per magazijn op 20 m, de rest ≤ 4,3): houdt een lane en wint multikills; traag richten en herladen |
| Burst Rifle | 611 | 861 | 861 | **861** | 997 | 1403 | Strakke bursts van drie: beloont precisie op 30–40 m |
| DMR | 667 | 947 | 947 | 947 | 947 | **947** | Drie schoten tot 90 m; met scope voor lange lijnen |
| Semi-Auto Sniper | 800 | 1160 | 1160 | 1160 | 1160 | 1160 | Twee snelle bodyshots of één headshot (55 × 1,85 = 102) op elke afstand |
| Bolt-Action Sniper | 2023 | 1506 | 1506 | 1506 | 1506 | 4046 | Eén bodyshot doodt tot 70 m; quickscope (0,3 s), trage grendel, geen heupvuur |
| Battle Rifle | 619 | 939 | 939 | 939 | **939** | 1130 | Zware automaat met combat scope: vier treffers tot 45 m, hard te beheersen, klein magazijn |
| Lever-Action Carbine | – | – | – | – | – | – | Eén headshot doodt tot ~45 m, twee bodyshots; snel richten, trage hendel |
| Anti-Materiel Rifle | 9350 | 2310 | 2310 | 2310 | 2310 | 2310 | Eén treffer doodt op elke afstand; het traagst met richten, lopen en doorladen |
| Pistol | 1050 | 1200 | 1200 | 1400 | 3350 | >5 s | Snelle, precieze backup |
| Machine Pistol | 660 | 800 | 1040 | >5 s | >5 s | – | Volautomatische paniekknop voor dichtbij |
| Revolver | 667 | 867 | 867 | 1400 | 1400 | 1933 | Eén headshot tot 30 m, twee bodyshots; traag herladen |

(De Lever-Action Carbine staat in het model op 1,6–2,6 s: het rekent een grendelwapen met 70% van de richtfactor, `BOLT_PRECISION`,
en ziet alleen bodyshots. Zijn rol is de headshot.)

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

- **Presets als quick picks:** Assault (rifle + red dot, pistol, Quickdraw), Rusher (SMG, machine pistol, Ninja), Breacher
  (shotgun, pistol, Ninja), Support (LMG + holo, pistol, Extended Mags), Marksman (DMR + scope, revolver), Burst (burst + holo,
  pistol, Suppressor), Sniper (bolt-action, machine pistol, Quickdraw).
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
- **Feedback:** hitmarker-tik, metalen headshot-*ding*, kill confirm (thunk + twee tonen), medailles voor double/triple/multi
  kill (binnen 3,5 s) en killstreaks 3/5/10 (koperachtige arpeggio's + tekst onder het richtkruis), stingers bij matchstart en
  -einde (winst, verlies, gelijkspel). Adem inhouden/uitblazen bij de scope.
- **Volume en toegankelijkheid:** alles via de sfx/ui-bussen (volume-instellingen gelden); elk geluid meldt zich bij de
  Subtitles-luisteraar, en de arcade-sessie geeft captions voor schoten ("Gunshot", "Suppressed shot", "Distant gunfire"),
  voetstappen, medailles en match start/einde.
- **Budget:** schoten van anderen gebruiken drie stemmen (crack, body die in de ruimtestaart overgaat, thump), ver weg één, en er
  worden er hooguit drie per frame gebouwd; de stemmenlimiet (64, prioriteiten) doet de rest. `python3 scripts/audio-report.py`:
  alle geluiden binnen de grenzen, worst case (16 spelers SMG + explosie) 0,26 ms/frame (budget 0,3).

## Matchregels

- Een match begint met een **warm-up** (aftelling), daarna `live`, en eindigt (`ended`) bij de score limit of als
  de tijd om is; na `restartIn` seconden begint een nieuwe match.
- Rondemodes (elimination) hebben daartussen per ronde `intermission` (iedereen terug bij de spawn, wapen kiezen, geen
  schade), `countdown` (3 s), `live` (de rondetijd) en `roundend` (uitslag, 4 s). De klok toont dan "NEXT ROUND".
- De respawntijd en spawnbescherming komen uit het type: 3 s / 2 s (tdm, ffa), 1,5 s / 1 s (gun game), 4 s / 2 s
  (hardpoint, domination, ctf), geen respawn binnen een ronde (elimination).
- Je respawnt `RESPAWN_SECONDS` (3 s) na een kill op de server (`spawn`), met volledige health, je geladen
  loadout en spawn-bescherming.
- Health regenereert na `REGEN_DELAY` (5 s) zonder schade met `REGEN_PER_SECOND` (25) per seconde.
- Hitbox: 0,6 breed, 1,8 hoog, de bovenste 0,4 is het hoofd (headshot).
- Een klasse geldt vanaf je **volgende leven**, behalve als je hem binnen 3 s na je spawn en vóór je eerste schot kiest: dan meteen.

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
3. **Kaartdata:** heeft het type zones of vlaggen nodig, zet ze in `objectives` van de kaarten (`src/modes/maps/*`, wereld-
   coördinaten; `scripts/objective-eval.ts` toetst kandidaten aan de regels van `tests/mapObjectives.test.ts`).
4. **Client:** een nieuwe `ModeState`-soort in `protocol.ts` plus een widget in `ModeHud.ts`/`ModeView.ts`; de rest
   (fases, banners, respawnregel, ladder) volgt uit de def.
5. **Tests:** Vitest met de stub-host (`tests/helpers/matchHost.ts`, voorbeelden in `tests/modes.test.ts`) en een run met echte
   bots: `ROOM_CREATE_LIMIT=1000 npm run server` en `npx tsx scripts/modes-bots.ts <type>`.
