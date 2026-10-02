# BunkCraft game types

Naast de Minecraft-sandbox heeft multiplayer twee **arcade-game types** in de stijl van Krunker:
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

Bij een arcade-game stel je **Score Limit** (10, 20, 30 of 50 kills) en **Time Limit** (5, 10 of 15 minuten)
in, en een **Map** (kaart; zie hieronder). Wie bij het eindsignaal de meeste kills heeft wint. Het menu stuurt
`{ name, gameMode, seed, gameType, scoreLimit, timeLimitSec, mapId }` naar `POST /api/rooms`;
`GET /api/rooms/:code` geeft dezelfde velden terug (`map` voor `mapId`), zodat het joinscherm en de lijst met recente games
het type en de kaart tonen.

## Kaarten

De knop **Map** in *Create Game* wisselt tussen de kaarten en toont onder de knop een regel uitleg. De kaarten
staan in `src/modes/maps/` en zijn eigen, originele indelingen in de geest van bekende shooterkaarten: elk met een eigen
kleurenpalet, spiegelsymmetrisch voor tdm, omheind en met spawns die ver uit elkaar liggen en elkaar niet kunnen zien
(spawnkillen is moeilijk).

| Kaart | Id | Wat |
|---|---|---|
| Classic | `classic` | De oorspronkelijke arena (96 × 96): middenplatform, corridors, dekking. Steen en hout. |
| Maple Court | `suburb` | Klein en snel (64 × 40): twee bakstenen huizen met tuin tegenover elkaar, een straat met auto's en een bestelbus, garages op de hoeken, trappen naar de platte daken. Close quarters. |
| Old Quarter | `quarter` | Stedelijk (80 × 64): een binnenplaats met fontein, een poortgebouw, hoge bakstenen blokken met balkons en dakstairs, steegjes van 4 breed als flanken, een omheind plein per team. |
| Harbor Yard | `dockyard` | Industrieel (88 × 64): containerstapels van gekleurde wol (teamkleuren aan de eigen kant), een grote loods in het midden, een kraandek op houten pilaren en een schip met een brug om vanaf te snipen. |
| Dust Bazaar | `desert` | Lange zichtlijnen (96 × 64): zand en zandsteen, een markt met gestreepte kramen, platte daken langs een lange open baan en een sluipschuttertoren aan elk uiteinde, achter de ommuurde teambasis. |

Met **Rotate** speelt elke volgende match op de volgende kaart; de client voegt zich dan automatisch opnieuw bij de
game (even het laadscherm). Tijdens een match valt er niets aan de kaart te kiezen.

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
- Je respawnt `RESPAWN_SECONDS` (3 s) na een kill op de server (`spawn`), met volledige health, je geladen
  loadout en spawn-bescherming.
- Health regenereert na `REGEN_DELAY` (5 s) zonder schade met `REGEN_PER_SECOND` (25) per seconde.
- Hitbox: 0,6 breed, 1,8 hoog, de bovenste 0,4 is het hoofd (headshot).
- Een loadout-keuze geldt vanaf je **volgende leven**.

## Netwerk (client)

Client → server: `loadout`, `fire` (oog, richting, `ads`; max. `fireInterval` per slot), `reload`, `weapon`.
Server → client: `match`, `roster`, `spawn`, `hp`, `ammo`, `shot`, `hit`, `damaged`, `kill`, `matchend`, `holds`.

- `shot` van andere spelers geeft een tracer van de loop naar `end`, een stofwolkje als `end` op een blok ligt en een
  geluid met afstandsdemping. De eigen `shot` wordt genegeerd: je eigen tracer en effecten komen direct.
- `damaged.dx/dz` wijzen **van jou naar de schutter** (wereldrichting); de indicator draait met je blik mee.
- Andere spelers dragen een shirt en haarband in teamkleur, hun naamtag heeft de teamkleur en ze houden het wapen uit
  `holds` vast met opgeheven armen. **Naamtags** worden nooit door muren heen getekend: een tag verschijnt alleen als er een
  vrij blokpad is van de camera naar het hoofd (raycast, per speler om de 100 ms, binnen 60 blokken) en vervaagt in en uit;
  dat geldt voor teamgenoten en tegenstanders. Na een kill ligt het lichaam kort op de grond en verdwijnt tot de respawn.

## Ontwikkelen en testen zonder server

In een dev-build (`npm run dev`) start `window.game.arcadePreview('tdm' | 'ffa')` een lokale testarena met een nep-server
(`src/core/ArcadePreview.ts`): bots lopen rond en schieten, jouw schoten leveren `ammo`, `shot`, `hit` en `kill` op en je
respawnt echt. Via `game.previewServer` kun je gebeurtenissen forceren (`damage`, `killSelf`, `killBot`, `botKill`,
`fillScores`, `endMatch`). Met een derde argument (`arcadePreview('tdm', 'You', 'dockyard')`) speel je op de echte kaart
in plaats van de nep-arena. Zet voor automatische tests `game.input.locked = true; game.state = 'playing'` en stuur
invoer via `game.input.down.add('Mouse0')` (zie de gotchas in `CLAUDE.md`). In een productiebuild bestaat de preview niet.

## Een nieuw game type toevoegen

1. **Contract:** voeg een regel toe aan `GAME_TYPES` in `src/modes/GameTypes.ts` (id, naam, beschrijving, `arcade`, `teams`,
   standaard score- en tijdlimiet) en breid het type `GameType` uit. Menu (`MainMenu.ts`), recente games en het joinscherm
   pakken het type vanzelf op.
2. **Server:** laat de room-API het type accepteren en implementeer de matchregels (zie `docs/SERVER.md`): wanneer
   telt een punt, wanneer is de match voorbij, spawns en teams.
3. **Client:** de HUD, wapens en besturing hangen aan `def.arcade`, de teamweergave aan `def.teams`. Een nieuw type met
   dezelfde wapens werkt dus zonder clientcode. Heeft het eigen regels of een eigen HUD-onderdeel (bijvoorbeeld een
   vlag), voeg dat dan toe in `ArcadeSession.ts` (state en berichten) en `ArcadeHud.ts` (weergave); de wereldkaart
   hoort bij `worldType` in het `welcome`-bericht.
4. **Wapens:** nieuwe wapens komen in `WEAPONS` (`Weapons.ts`), een boxmodel in `WEAPON_MODELS`
   (`src/rendering/WeaponModels.ts`) en een geluid in `AudioEngine.playGun`.
5. **Tests:** pure logica (spreiding, scoreboard, killfeed) in `src/modes/ArcadeLogic.ts` met tests in `tests/arcade.test.ts`.
