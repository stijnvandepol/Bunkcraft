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

## De types

| Type | Id | Regels |
|---|---|---|
| Minecraft | `minecraft` | De sandbox (Multiplayer): bouwen, delven, mobs, survival/creative/hardcore. Seed en game mode kies je bij het aanmaken. |
| Team Deathmatch | `tdm` | Rood tegen blauw op de arena. Elke kill telt voor je team; het eerste team op de score limit wint. |
| Free For All | `ffa` | Iedereen voor zichzelf. De eerste speler op de score limit wint. |
| Gun Game | `gungame` | Elke kill geeft je het volgende wapen van een ladder van 18 (begint met de rifle, eindigt met het mes); een meskill zet het slachtoffer een niveau terug. Wie het laatste niveau afmaakt wint. Geen loadoutkeuze. |
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
- **Ladder** (gun game): niveau, huidig wapen, volgend wapen, voortgangsblokjes en de koploper (alleen hier, niet ook onder de timer); links bovenin `7/18`. Het paneel wijkt als het scoreboard (Tab) openstaat.
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

| Wapen | Slot | Modus | Schade | Headshot | Schoten/min | Magazijn | Herladen | Spreiding heup / ADS | Volle schade tot / val-af tot | ADS-tijd | Zoom (per optiek) | Snelheid | Optieken |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Assault Rifle | primair | auto | 20 | ×2 | 600 | 30 | 1.6 s | 2.2° / 0.4° | 32 / 80 m (min. 55%) | 0.24 s | 1.3× / 1.3× / 1.4× | ×1 | iron, reddot, holo |
| SMG | primair | auto | 15 | ×1.8 | 900 | 25 | 1.3 s | 2.6° / 1.2° | 16 / 50 m (min. 50%) | 0.17 s | 1.2× / 1.2× / 1.3× | ×1.08 | iron, reddot, holo |
| Shotgun | primair | semi | 10 × 13 | ×1.5 | 70 | 6 | 2.4 s | 4.5° / 3.5° | 7 / 22 m (min. 15%) | 0.20 s | 1.1× / 1.2× | ×0.97 | iron, reddot |
| LMG | primair | auto | 19 | ×1.7 | 720 | 75 | 4.2 s | 3.2° / 0.55° | 38 / 95 m (min. 62%) | 0.42 s | 1.3× / 1.3× / 1.4× | ×0.88 | iron, reddot, holo |
| Burst Rifle | primair | burst (3) | 22 | ×1.6 | 900 (cyclus 0.34 s) | 30 | 1.7 s | 2° / 0.25° | 45 / 85 m (min. 55%) | 0.25 s | 1.3× / 1.3× / 1.4× | ×1 | iron, reddot, holo |
| DMR | primair | semi | 34 | ×2 | 270 | 12 | 2 s | 3.5° / 0.1° | 60 / 140 m (min. 70%) | 0.28 s | 1.4× / 1.5× / 1.6× / 2.2× | ×0.96 | iron, reddot, holo, scope |
| Semi-Auto Sniper | primair | semi | 55 | ×1.7 | 125 | 6 | 2.6 s | 7° / 0.05° | 70 / 160 m (min. 80%) | 0.36 s | 3.0× | ×0.93 | scope |
| Bolt-Action Sniper | primair | grendel | 85 | ×1.6 | 45 | 4 | 2.2 s | 9° / 0° | 300 / 300 m (min. 100%) | 0.42 s | 4.5× | ×0.92 | scope |
| Pistol | secundair | semi | 18 | ×2 | 400 | 12 | 1.1 s | 1.8° / 0.5° | 25 / 60 m (min. 50%) | 0.15 s | 1.1× | ×1.04 | iron |
| Machine Pistol | secundair | auto | 12 | ×1.6 | 1000 | 20 | 1.5 s | 3.2° / 1.5° | 9 / 30 m (min. 45%) | 0.14 s | 1.1× | ×1.05 | iron |
| Revolver | secundair | semi | 52 | ×2 | 150 | 6 | 2.4 s | 2.5° / 0.15° | 30 / 70 m (min. 60%) | 0.20 s | 1.2× | ×1 | iron |
| Knife | melee | semi | 55 | ×1 | 120 | – | – | – | 2.6 / 2.6 m | – | – | ×1.08 | – |

De spreiding is de halve openingshoek van de kegel waarin een kogel kan landen. Een scope op de DMR kost 0,08 s extra ADS-tijd.

**Terugslag** is een vast, leerbaar patroon per wapen (`pattern`, `recoilX`): elk schot tilt je richtpunt `recoil × 0,32`°
op (30% minder als je richt) en duwt het zijwaarts volgens het patroon; laat je de trekker los, dan zakt ~70% terug.
Bij automatische wapens begint dat terugzakken pas na een pauze langer dan het schotinterval (×1,3, minstens 0,09 s), dus
een vastgehouden trekker blijft klimmen, ook bij de rifle (600/min = elke 0,1 s). Het
richtpunt zelf beweegt (yaw/pitch), dus wat je ziet is waar de server schiet. De LMG klimt het meest maar heeft 75 kogels.

**Grendel:** de Bolt-Action Sniper werkt na elk schot de grendel (geluid en animatie, de kadans blijft `rpm`).

### Rollen en balans (time to kill)

Model in `src/modes/Balance.ts`, tabel met `npx tsx scripts/ttk-matrix.ts` (`--summary` voor alleen deze tabel). Realistische
TTK in ms (body, richtfactor 0,75, kans dat een kogel binnen de hitbox valt door de spreiding, ADS-tijd erbij vanaf 7 m;
**vet** = snelste primaire wapen op die afstand):

| Wapen | 4 m | 10 m | 20 m | 35 m | 60 m | 90 m | Rol |
|---|---|---|---|---|---|---|---|
| Assault Rifle | 567 | 807 | **807** | 940 | 1073 | 1880 | Allrounder: wint op middenafstand, redt zich dichtbij en ver |
| SMG | 556 | **726** | 814 | 1683 | >5 s | >5 s | Snelst te voet; wint dichtbij, zakt weg na 20 m |
| Shotgun | **286** | 1629 | >5 s | >5 s | – | – | Eén schot op armlengte; nutteloos voorbij 15 m |
| LMG | 583 | 1003 | 1003 | 1003 | 1190 | 2804 | Groot magazijn (9,4 kills per magazijn op 20 m, de rest ≤ 4,3): houdt een lane en wint multikills; traag richten en herladen |
| Burst Rifle | 611 | 861 | 861 | **861** | 997 | 1403 | Strakke bursts van drie: beloont precisie op 30–40 m |
| DMR | 667 | 947 | 947 | 947 | **947** | 1243 | Drie schoten; met scope voor lange lijnen |
| Semi-Auto Sniper | 800 | 1160 | 1160 | 1160 | 1160 | **1160** | Twee snelle bodyshots op elke afstand; geen one-shot headshot (55 × 1,7 = 93) |
| Bolt-Action Sniper | 3365 | 2642 | 2642 | 2642 | 2642 | 2642 | Eén headshot is een kill op elke afstand (85 × 1,6 = 136); traag en zwak dichtbij |
| Pistol | 1050 | 1200 | 1200 | 1400 | 3500 | >5 s | Snelle, precieze backup |
| Machine Pistol | 660 | 800 | 1040 | >5 s | >5 s | – | Volautomatische paniekknop voor dichtbij |
| Revolver | 667 | 867 | 867 | 1400 | 1400 | 1933 | Twee treffers, traag herladen |

Bewaakt door `tests/arcadeBalance.test.ts`: elk primair wapen heeft een niche (snelste op een afstand, meeste kills per
magazijn, one-shot headshot of snelst te voet), geen wapen is op meer dan twee van de zes afstanden de snelste, geen wapen
domineert een ander van zijn slot (TTK op alle afstanden, magazijn, snelheid, ADS-tijd, herladen en headshot), een secundair
wapen is nergens sneller dan het beste primaire, en niets doodt met één bodyshot.

## Klassen (Create-a-Class)

Een klasse is **primair wapen + optiek + secundair wapen + één perk** (`ClassSpec` in `src/modes/Loadouts.ts`):

| Optiek | Effect |
|---|---|
| Iron Sights | De eigen vizieren van het wapen |
| Red Dot | Rode stip in een klein huis, iets meer zoom (×0,95 FOV) |
| Holographic | Ring met stip, nog iets meer zoom (×0,9 FOV) |
| Scope | Vergroting per wapen (DMR 2,2×, Semi-Auto 3×, Bolt-Action 4,5×), zwarte scope-overlay met mil-dots; het wapen verdwijnt uit beeld als je volledig richt. Sway; **Shift ingedrukt = adem inhouden** (4 s stil, daarna 2,5 s naar adem happen met meer sway). Vijanden zien een **glinstering** als je door een scope naar ze kijkt. |

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
  van dat wapen. Een klasse die je binnen **3 s na je spawn en vóór je eerste schot** kiest, gaat direct in (`gear`), anders bij
  je volgende leven. `spawn`/`gear` dragen `optic` en `perk`; `holds` draagt `optic`, `sup` (demper) en `quiet` (Ninja) zodat
  anderen het juiste model, de demper en de glinstering zien en je stappen goed horen.
- **Gun Game** houdt zijn vaste ladder (geen klassen, geen perks). De ladder begint nu met de rifle in plaats van de shotgun
  (eerste kill duurde op grote kaarten > 50 s, zie `docs/qa/ARCADE.md`) en bevat alle 11 vuurwapens (18 treden).

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
3. **Kaartdata:** heeft het type zones, vlaggen of bomsites nodig, zet ze in `objectives` van de kaarten (`src/modes/maps/*`, wereld-
   coördinaten; `scripts/objective-eval.ts` toetst kandidaten aan de regels van `tests/mapObjectives.test.ts`, `scripts/site-scan.ts`
   zoekt bomsites). Hooks voor regels die meer doen dan scoren: `teamFor`, `keepTeams`, `speedMul`, `damageMul`, `pickSpawn`,
   `loadoutFor` (mag per speler `undefined` geven) en `objectives` voor server-bots.
4. **Client:** een nieuwe `ModeState`-soort in `protocol.ts` plus een widget in `ModeHud.ts`/`ModeView.ts`; de rest
   (fases, banners, respawnregel, ladder) volgt uit de def.
5. **Tests:** Vitest met de stub-host (`tests/helpers/matchHost.ts`, voorbeelden in `tests/modes.test.ts`) en een run met echte
   bots: `ROOM_CREATE_LIMIT=1000 npm run server` en `npx tsx scripts/modes-bots.ts <type>`.
