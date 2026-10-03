# BunkCraft game types

Naast de Minecraft-sandbox heeft multiplayer zeven **arcade-game types** in de stijl van Krunker:
snel, wapens met hitscan en een vaste arena. Bij het aanmaken van een game kies je het type
(*Create Game → Game Type*). Het contract staat in `src/modes/GameTypes.ts`, `src/modes/Weapons.ts`
en het arcade-deel van `src/net/protocol.ts` (protocol v3). Dit document beschrijft de **client**;
de server (match, hitscan, health, respawn) staat in `docs/SERVER.md`.

## De types

| Type | Id | Regels |
|---|---|---|
| Minecraft | `minecraft` | De sandbox: bouwen, delven, mobs, survival/creative/hardcore. Seed en game mode kies je bij het aanmaken. |
| Team Deathmatch | `tdm` | Rood tegen blauw op de arena. Elke kill telt voor je team; het eerste team op de score limit wint. |
| Free For All | `ffa` | Iedereen voor zichzelf. De eerste speler op de score limit wint. |
| Gun Game | `gungame` | Elke kill geeft je het volgende wapen van een ladder van 16 (eindigt met het mes); een meskill zet het slachtoffer een niveau terug. Wie het laatste niveau afmaakt wint. Geen loadoutkeuze. |
| Team Elimination | `elimination` | Rondes met één leven: wie het andere team uitschakelt wint de ronde, het eerste team op het rondelimiet wint. Doden spectaten hun team tot de volgende ronde. |
| Hardpoint | `hardpoint` | Eén zone (de heuvel) telt: het team dat er alleen staat krijgt 1 punt per seconde, samen = betwist. De heuvel verspringt elke 60 s (met 5 s pauze). Eerste op 250 punten. |
| Domination | `domination` | Drie vaste punten: alleen in een punt staan neemt het in 6 s in (een punt van de ander eerst neutraliseren); elk eigen punt geeft 1 punt per 2 s. Eerste op 100. |
| Capture the Flag | `ctf` | Pak de vlag van de ander door hem aan te raken, breng hem naar je eigen vlag terwijl die thuis staat. Drager is 10% trager, laat de vlag vallen bij zijn dood; je eigen team brengt een gevallen vlag direct terug, anders na 12 s. Eerste op 3 captures. |

Bij een arcade-game stel je de limieten in die het type aanbiedt (uit `GameTypeDef.options`: bijvoorbeeld **Score Limit**
10–50 kills bij tdm, **Rounds to Win** en **Round Time** bij elimination, **Captures to Win** bij ctf; gun game heeft geen
scorelimiet, de ladder is de limiet) en een **Map**. De kaartknop toont alleen kaarten met de data die het type nodig heeft
(zones voor hardpoint/domination, vlaggen voor ctf). Wie bij het eindsignaal de meeste kills heeft wint. Het menu stuurt
`{ name, gameMode, seed, gameType, scoreLimit, timeLimitSec, mapId }` naar `POST /api/rooms`;
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
| Bunker Flag | `bunker` | Voor capture the flag (64 × 40): een droge rivierbedding met oevers van 2 hoog, twee oversteekplaatsen en een overdekte duiker in het midden; elke vlag in een betonnen bunker met één deur achter een scherfmuur, spawns in een ommuurde tuin erachter. | zones, vlaggen |

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
- **Ladder** (gun game): niveau, huidig wapen, volgend wapen, voortgangsblokjes en de koploper; links bovenin `7/16`.
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
| Loadout-menu | B |
| Chat | T |
| HUD verbergen | F1 |

Op het doodscherm kies je met 1–4 het primaire wapen voor je volgende leven. Esc opent het pauzemenu;
de match loopt op de server gewoon door.

## HUD

- **Health** linksonder (getal en balk, knippert rood onder 30), **munitie** rechtsonder (`magazijn / ∞`,
  wapennaam, herlaadbalk) en de drie wapenslots.
- **Richtkruis** dat meegroeit met de spreiding (heup groter, richten kleiner, bewegen en in de lucht groter)
  en verdwijnt achter de scope van de sniper.
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
Schade is uit 100 health.

| Wapen | Slot | Schade | Headshot | Kogels | Schoten/min | Magazijn | Herladen | Spreiding heup / ADS | Volle schade tot / val-af tot | Zoom | Snelheid | Terugslag |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Assault Rifle (automatisch) | primair | 20 | ×2 | 1 | 600 | 30 | 1.6 s | 2.2° / 0.4° | 40 / 90 m (min. 60%) | ×1.3 | ×1 | 0.9° |
| SMG (automatisch) | primair | 15 | ×1.8 | 1 | 900 | 25 | 1.3 s | 2.6° / 1.2° | 16 / 50 m (min. 50%) | ×1.2 | ×1.08 | 0.6° |
| Shotgun (semi) | primair | 13 | ×1.5 | 10 | 70 | 6 | 2.4 s | 4.5° / 3.5° | 6 / 20 m (min. 15%) | ×1.1 | ×0.97 | 4° |
| Sniper Rifle (semi) | primair | 85 | ×1.6 | 1 | 45 | 4 | 2.2 s | 9° / 0° | 300 / 300 m (min. 100%) | ×4.0 | ×0.92 | 3° |
| DMR (semi) | primair | 34 | ×2 | 1 | 270 | 12 | 2.0 s | 3.5° / 0.1° | 60 / 140 m (min. 70%) | ×1.8 | ×0.96 | 1.6° |
| Burst Rifle (3 schoten per klik) | primair | 22 | ×1.6 | 1 | 900 binnen de burst, 0,38 s per cyclus | 30 | 1.7 s | 2.0° / 0.25° | 45 / 100 m (min. 60%) | ×1.25 | ×1 | 1.2° |
| Pistol (semi) | secundair | 18 | ×2 | 1 | 400 | 12 | 1.1 s | 1.8° / 0.5° | 25 / 60 m (min. 50%) | ×1.1 | ×1.04 | 1.1° |
| Revolver (semi) | secundair | 52 | ×2 | 1 | 150 | 6 | 2.4 s | 2.5° / 0.15° | 30 / 70 m (min. 60%) | ×1.2 | ×1 | 4.5° |
| Knife (semi) | melee | 55 | ×1 | 1 | 120 | – | – | – | 2.6 / 2.6 m (min. 100%) | – | ×1.08 | 0° |

De spreiding is de halve openingshoek van de kegel waarin een kogel kan landen. Je start elk leven met je gekozen
primaire wapen, je secundaire wapen (standaard de pistol) en het mes.

**Klassen (loadout-presets)** staan in `src/modes/Loadouts.ts` en kiezen primair en secundair in één klik
(bericht `loadout { primary, secondary? }`; de server controleert de ids): Assault (rifle + pistol), Rusher (SMG + pistol),
Breacher (shotgun + pistol), Marksman (DMR + revolver), Burst (burst rifle + pistol) en Sniper (sniper + pistol).
In het loadout-menu (B) staan de klassen boven de losse primaire kaarten; op het doodscherm kies je met 1-6 een klas voor je
volgende leven. Balans: `npx tsx scripts/ttk-matrix.ts --current` (SMG wint close-range van de rifle, de rifle op 30 m; de shotgun
doodt in één schot tot ongeveer 4 m; de DMR wint van de rifle pas ver weg).

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
- Een loadout-keuze geldt vanaf je **volgende leven**.

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
