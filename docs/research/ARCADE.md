# BunkCraft Arcade: onderzoek en plan (Krunker-stijl modes, wapens, kaarten, netcode, retentie)

Stand: 2026-10. Gebaseerd op de code in `src/modes/*`, `server/Match.ts`, `server/Combat.ts`, `server/GameServer.ts`, de vijf kaarten in
`src/modes/maps/*` en webonderzoek (bronnenlijst onderaan). Wat ik niet kon verifiëren is gemarkeerd met **onzeker**.
Bij dit onderzoek horen drie scripts (alleen data, geen gamecode): `scripts/ttk-matrix.ts`, `scripts/map-metrics.ts` en het bestaande
`scripts/ascii-map.ts`.

## 0. Samenvatting

**Waar we staan.** Arcade = twee modes (TDM, FFA), vijf spiegelsymmetrische kaarten, zes wapens, kill-limit als enige doel. De basis is
degelijk: server-autoritaire hitscan met lag compensation, health-regen, spawn-bescherming, spectator, loadout bij de dood. Het ontbreekt aan
*doelen* (objectives), *rondes*, *variatie in wapens* en *redenen om terug te komen*.

**Top 6 modes (volgorde van bouwen).**

| # | Mode | Inspanning | Waarom |
|---|---|---|---|
| 1 | Gun Game | S | Bijna alleen data + `loadoutFor`; bewijst de `ModeLogic`-abstractie |
| 2 | Hardpoint (+ Domination als variant) | M | Krunkers ranked-mode; zones zijn data; levert objective-HUD en map-objectives |
| 3 | Team Elimination (rondes, geen respawn) | M | Rondelaag in `Match`; fundament voor Search & Destroy, Infected, Block Hunt, LMS |
| 4 | Capture the Flag | L | Het meest herkenbare teamdoel; vlag-entity met 3 toestanden |
| 5 | Infected | M | Rolwissel + zombieklasse; past bij Minecraft-thema; hergebruikt rondes |
| 6 | Block Hunt (Prop Hunt, hiders worden een blok) | L | Meest "Minecraft" van de arcade-modes; veel streamer/vrienden-fun |

**Top 5 wapen/kaart-wijzigingen.**
1. **Shotgun repareren**: max 72 schade per schot (8 × 9) betekent dat hij zelfs op 1 blok niet in één schot doodt (TTK 800 ms, de traagste
   kill van de hele arsenal op korte afstand); realistisch is hij onbruikbaar vanaf ~10 blokken. Voorstel 10 × 13 (130), val-af 6 → 20 blokken: one-shot tot ~4 m, daarbuiten twee schoten.
2. **SMG krijgt een identiteit**: nu is de SMG op elke afstand gelijk of trager dan de Assault Rifle (467 vs 400 ms perfect). Maak schade 15
   (7 schoten, 400 ms) met kortere reikwijdte, en snelheid/hipfire als voordeel.
3. **Arsenal uitbreiden** met LMG, DMR, burst rifle, revolver, akimbo SMGs, raketwerper, granaten (tabel in §3) en 6 klassen met perks.
4. **Kaarten krijgen objective-data en een `symmetry`-optie.** `ArenaMap` spiegelt nu altijd in x én z; dat sluit asymmetrische kaarten
   (S&D, Block Hunt) uit en bevat geen vlaggen/zones. Extra: Desert heeft *geen* lange zichtlijnen op grondniveau (zie §4).
5. **Pickups op de kaart** (rocket, armor, health) en kaartpositie voor killstreak-drops; geeft kaarten een reden om te lopen.

**Netcode-risico's (kort).** (a) Arcade vertrouwt client-posities volledig: geen botsing met blokken, y tot +40, snelheidslimiet 40 b/s
(legitiem maximum ligt rond ~10-12), dus vliegen/noclip/speedhack binnen de limiet kan. (b) `dt` wordt op ≥ 0,05 s gezet: gebufferde
positiepakketten (Krunkers "fake lag"-exploit) passeren de snelheidscheck. (c) `snap` bevat altijd alle spelers: wallhack leest posities
rechtstreeks. (d) Geen aimbot-detectie. (e) 20 Hz-tick met 100 ms interpolatie is voor hitscan prima maar de ondergrens; 30 Hz binair is
de aanbevolen stap. Details in §5.

## 1. Krunker.io en vergelijkbare shooters

### 1.1 Krunker: kenmerken

| Onderdeel | Krunker | BunkCraft nu |
|---|---|---|
| Stijl | Voxel/low-poly arcade-FPS in de browser, matches van 4-10 min, 8 spelers in FFA, 4v4 in TDM (guides) | Zelfde schaal; kaarten van 64×40 tot 96×96 |
| Klassen | 13 klassen met eigen wapen, o.a. Triggerman (AR), Run N Gun (SMG), Hunter (sniper), Spray N Pray (LMG, tank), Vince (shotgun), Detective (revolver), Marksman (semi-auto), Rocketeer, Agent (dual Uzi), Runner (mes), Bowman, Commando (burst), Trooper | Eén primair wapen kiezen, pistol + mes vast |
| Beweging | Slide-hop (springen, bij landing crouch, weer springen), bunny hop, air-strafe, slide-strafe, wall-jump (sommige klassen), "slide cancel" | Bunny hop (airAccel 8) en altijd sprinten; **geen slide, geen crouch, geen wall-jump** |
| Richten | ADS, scope, quickscope met sniper | ADS en scope (sniper) |
| Modi (publiek) | FFA, TDM, Hardpoint, CTF, Domination (zoekresultaat) + party/speciaal: Infected, Parkour/BHOP, Gun Game, Sharp Shooter, Chaos Sniper | TDM, FFA |
| Community-modes | Hide & Seek, Smooth & Silenced en vele via de map-editor | n.v.t. |
| Ranked | 4v4 Hardpoint, best-of-3, vanaf level 10; divisies Bronze tot Master, 125 punten per divisie, +25 per winst (fandom-wiki) | Geen |
| Progressie | Levels, skins, loadouts, challenges, hardcore "Challenge Mode" met extra beloning (zoekresultaten) | Geen |
| Anti-cheat | Checks in WASM die de server verifieert; exploits bleven (zie 1.4) | Geen |
| Maps | Community-kaarten via editor; dit is de grote retentiemotor | Vijf vaste kaarten |

Modi als Prop Hunt, Deposit, Race, Simon Says en Last Man Standing zitten volgens mijn herinnering in Krunker (community/custom
games), maar mijn bronnen bevestigen ze niet: **onzeker**. Het ontwerpidee blijft bruikbaar.

### 1.2 Krunker: klassen en wapenstatistieken (voor vergelijking)

Bron: officiële guides en fan-statistieken; getallen kunnen per update verschillen (**onzeker** op detail).

| Wapen (klasse) | Schade lichaam / hoofd | Vuurinterval | Magazijn | Opmerking |
|---|---|---|---|---|
| Assault Rifle (Triggerman) | 23 / 34,5 (benen 11,5) | 110 ms (~545 rpm) | 28 | 5 schoten lichaam = ~440 ms |
| SMG (Run N Gun) | 18 / 27 | 90 ms (~667 rpm) | 30 | snelste beweging |
| Sniper (Hunter) | 100 / 150 | 900 ms | 3 | one-shot lichaam |
| Shotgun (Vince) | 50 × 5 pellets / 75 × 5 | 450 ms | 2 | one-shot dichtbij |
| LMG (Spray N Pray) | n.v.t. | n.v.t. | ~100 | tank, meer HP (170 volgens een bron, **onzeker**) |

Vergelijking: de BunkCraft-rifle (20 dmg, 600 rpm, 400 ms) zit dicht bij Krunkers AR (440 ms). Krunkers shotgun en sniper doden in één
schot; BunkCraft's niet (sniper 85 = 2 schoten lichaam, shotgun 72 max). Benen doen bij Krunker de helft: BunkCraft heeft alleen hoofd/lichaam.

### 1.3 Beweging

Slide-hop (springen, vlak voor landing crouch, glijden, weer springen) is Krunkers kernmechaniek; leaning is in mijn bronnen geen kernmechaniek (**onzeker**). Grootste gat in BunkCraft: **slide**
(sprint + crouch = 0,9 s glijden met boost, hitbox 1,2 hoog). Inspanning M: `Player`-physics, hitbox-hoogte via een `flags`-bit in `pos`, animatie. Niet nodig voor de modes hieronder.

### 1.4 Netcode en anti-cheat van Krunker (wat openbaar is)

- De client stuurt knoppen/inputs op een vaste `clientSendRate` naar de server (AnticheatJS-repo).
- Gedocumenteerde exploits: **fake lag** (inputs bufferen en pas vrijgeven, spelers "teleporteren" op andermans scherm, ideaal als je alleen
  vrijgeeft vlak voordat iemand je kan raken), **hoekmanipulatie** (client begrenst hoeken, server niet: yaw + n·2π draait de speler visueel),
  **server overload** met enorme buffers, speedhacks (sneller schieten/herladen).
- Antwoord van Krunker: checks in WASM die server verifieert; client-side obfuscatie. Het blijft kat-en-muis; er zijn ML-aimbots en
  hardware-aimbots.
- Les: **valideer elke clientwaarde server-side** (hoeken, buffergrootte, berichtsnelheid), en vertrouw geen client-tijd. Zie §5.

### 1.5 Vergelijkbare browser- en Minecraft-shooters

| Spel | Wat het doet | Wat we ervan leren |
|---|---|---|
| Voxiom.io | Voxel-FPS met **destructibele kaarten**, bouwen, modes: Battle Royale, Capture the Gems, Survival, FFA; 5 hotbar/ammo/rugzakslots; cosmetica via coins, niet pay-to-win | Voxel-destructie en bouwen is het onderscheidende hoogtepunt; BunkCraft heeft de engine al |
| Shell Shockers | Eieren met wapens; FFA, Teams, **Capture the Spatula** (CTF), **King of the Coop** (KOTH) | Simpele objective-varianten werken al in een heel klein spel |
| Venge.io | Korte matches, compacte kaarten, **helden met abilities**; doelen: zones, Black Coins, payload, gun progression (Gun Game) | Objectives + gun progression in dezelfde loop; abilities geven identiteit |
| Bullet Force | Team/objective-modes, **loadouts** met primair, secundair, perks, equipment | Perk/equipment-laag is de diepte; past bij onze klassen (§3) |
| Hypixel Bed Wars | Elk team een eiland met bed; zolang het bed bestaat respawn je; generators (iron/gold in basis, diamond tussen, emerald in midden); shop; na 30 min alle bedden kapot, na 40 min draken | Twee levensfasen (veilig/kwetsbaar), economie-loop, comeback en eindtimer |
| Hypixel SkyWars | Eiland per speler/team, loot in kisten, last alive; solo/doubles, "insane" met betere uitrusting | Loot + void-knockoff; aantrekkelijk voor korte sessies |
| Hypixel Murder Mystery | Rollen Murderer/Detective/Innocent; modes Classic, Double Up, Assassins, Infection | Verborgen rollen = sociale deductie met bijna geen kaartwerk |
| Hypixel Build Battle | Thema, bouwen, stemmen; Solo, Teams, Pro, Guess the Build, Speed Builders | Uniek voor Minecraft; geen shooter nodig |
| Hypixel TNT Run / Bow Spleef / PVP Run / TNT Tag | Vloer verdwijnt onder je voeten, bow spleef laat TNT-blokken vallen | Minuutspellen met extreem lage regeldrempel |
| Hypixel Hide and Seek | Prop Hunt (hiders vermommen zich) en Party Pooper | Zelfde als Block Hunt hieronder |
| Hypixel CTF | Alleen als communityvoorstel gevonden, niet officieel (**onzeker**) | n.v.t. |
| Hunger Games, Parkour, Duels | Niet onderzocht (**onzeker**) | n.v.t. |

**Wat deze spellen leuk maakt (synthese).**
1. **Korte, duidelijke lus**: 3-10 min, directe respawn of snel opnieuw beginnen, nooit lang wachten.
2. **Eén zin uitleg**: "houd de zone", "pak de vlag", "wees de laatste".
3. **Ongelijke rollen of toestanden** (bed aan/uit, hider vs seeker, besmet vs overlever) geven spanning zonder complexe regels.
4. **Comeback en timers** voorkomen dat een verloren match saai doorloopt (Bed Wars: bedden vallen, draken).
5. **Skill-plafond in beweging** (slide-hop, rocket-jump), niet alleen in richten.
6. **Kosmetica en progressie zonder pay-to-win** (Voxiom, Hypixel temporary upgrades).
7. **Gemeenschapscontent** (Krunker-editor): kaarten en modes door spelers.

## 2. Game mode-catalogus voor BunkCraft

### 2.1 Wat de huidige code toelaat

- `GameType = 'minecraft' | 'tdm' | 'ffa'` met `GameTypeDef { arcade, teams, scoreLimit, timeLimitSec }`. Geen veld voor regels.
- `server/Match.ts` is één klasse met `teams: boolean`; scoring = kills (`checkScoreLimit`, `endMatch`), fases `warmup | live | ended`,
  respawn altijd na `RESPAWN_SECONDS` (3), spawnkeuze in `pickSpawn`. Geen rondes, geen objectives, geen rolwissel (alleen `rebalance`).
- `ArenaMap` is **altijd 4-voudig gespiegeld** (red links/blue rechts én z-gespiegeld), met `teamSpawns`, `ffaSpawns`, `highGround`. Geen
  plek voor vlaggen, zones, sites of props.
- Arcade-spelers hebben geen blokinteractie (`Interaction.arcade`) en servers sturen geen mobs in arcade.
- Protocol (`src/net/protocol.ts`) kent `match`, `roster`, `spawn`, `hp`, `ammo`, `shot`, `hit`, `damaged`, `kill`, `matchend`, `holds`.

### 2.2 Catalogus

Inspanning: S ≈ 1-2 dagen, M ≈ 3-6 dagen, L ≈ 1-2 weken, XL ≥ 3 weken (één ontwikkelaar, inclusief tests en HUD). Fun 1-5 (mijn inschatting
op basis van §1.5, geen speltest). Rang = fun gedeeld door gewogen inspanning, met bonus voor modes die iets voor latere modes opleveren.

| Mode | Regels en score (kort) | Rondeverloop | Kaart/props | Wat moet veranderen | Balansrisico | Inspanning | Fun | Rang |
|---|---|---|---|---|---|---|---|---|
| **Gun Game** | Elke kill = volgend wapen in ladder (12-14 niveaus), laatste niveau mes; wie het mes-niveau scoort wint; mes-kill op iemand degradeert hem een niveau | Eén lange ronde, respawn 1-2 s, FFA | Bestaande kaarten (kleine) | `loadoutFor`, `onKill`; HUD-niveau; spawn-bescherming zonder wapenwissel | Snelle spawns bij camperskills; ladder-volgorde | **S** | 4 | 1 |
| **Hardpoint / KOTH** | Eén zone actief (60-90 s), team dat alleen erin staat scoort 1 punt/s; zone verspringt; 250 of 4 min | Doorlopend, respawn 3-5 s | Zones: 5 posities per kaart (data) | Zone-tick in `Match`, `mode`-bericht, HUD (zoneboog, volgende zone), spawnkeuze | Camperen in de zone, spawns nabij zone | **M** | 5 | 2 |
| **Domination** | 3 vlaggen A/B/C; bezet (3 s in de buurt) en houd; punten per seconde per vlag in bezit | Doorlopend | 3 punten per kaart (data) | Zelfde zonecode als Hardpoint, ander capture-gedrag | Eén team houdt twee vlaggen op 2 zijden | **S** na Hardpoint | 4 | 3 |
| **Team Elimination (rondes)** | Eén leven per ronde; ronde gewonnen als ander team dood is; best-of 7 (4 rondes winnen); wissel van kant bij helft | Voor-ronde 5 s, ronde max 90 s, na-ronde 5 s | Alle kaarten | **Rondelaag**: `phase: 'preround' | 'round' | 'postround'`, geen respawn, spectate teamgenoten, ronde-HUD | Eerste kill beslist; TTK-druk | **M** | 4 | 4 |
| **Capture the Flag** | Eigen vlag thuis; pak de vlag van de vijand, breng terug naar eigen basis (alleen als eigen vlag thuis is); 3 caps of 8 min; drager zichtbaar, 10% trager; vlag blijft 12 s liggen en wordt teruggezet | Doorlopend, respawn 3-5 s | Vlagposities per team in kaart-data, vlagmodel | Vlag-entity (home/carried/dropped), pickup/capture per tick, `mode`-bericht, vlag-HUD en -model, kill-reward | Camperen, snelle drager; asymmetrische routes | **L** | 5 | 5 |
| **Infected** | Eén random "besmet" (zombie, mes, snel, 150 HP); wie gedood wordt wordt zombie; overlevenden winnen na 3 min, zombies als allen besmet zijn | Rondes van 3 min, 5 s voor-ronde | Bestaande kaarten (kleine, donker thema) | Rolwissel mid-ronde (`team` verandert), `loadoutFor`, zombie-hitbox/-model, rondelaag | Eerste zombie te sterk/zwak; laatste overlever campt | **M** | 4 | 6 |
| **Hide & Seek / Block Hunt** | Hiders worden een blok (of mob), seekers moeten ze vinden en schieten; verkeerd blok raken kost seeker 5 HP | Voor-ronde 20 s (hiders verstoppen, seekers blind), ronde 3 min | Kaarten met veel losse blokken/decor; prop-lijst per kaart | Vermomming in rendering van `RemotePlayers`, server-hitbox = blok, taunt/ping, rondelaag, seeker-blinding | Hiders die niet bewegen, camp-spots | **L** | 4 | 7 |
| **Last Man Standing** | FFA, één leven (of 3), laatste levende wint; optioneel krimpende grens | Rondes 2-4 min | Alle kaarten | Rondelaag + FFA-eliminatie; optioneel `border` | Eerste dood wacht lang; spectate-tijd | **S** na rondes | 3 | 8 |
| **Murder Mystery** (bonus) | Eén moordenaar (mes), één detective (boog), rest onschuldig; rollen geheim | Rondes 3 min | Kleine kaarten | Rollen privé sturen, speciale wapens (werpmes, boog), rondelaag | Moordenaar die wacht | **M** | 4 | 9 |
| **Search & Destroy lite** | Aanvallers plaatsen bom op site (4 s vasthouden), verdedigers defusen (6 s); geen respawn, wapen-economie niet nodig | Ronde 100 s, bom 40 s | **Asymmetrische** kaart met 2 sites | Asymmetrie in `ArenaMap`, gebruik-toets, bom-entity, rondelaag | Asymmetrische balans, TTK tegen geen-respawn | **L** | 5 | 10 |
| **Spleef / TNT Run** | Vloer verdwijnt onder voeten (TNT Run) of door slaan/schieten (Spleef); laatste levende wint | Rondes 1-3 min | Vloerlagen over void | Server breekt blokken onder spelers (bestaande `blocks`-pipeline), val = dood, rondelaag, arcade-blokinteractie | Eenvoudig, lag-gevoelig (client-positie bepaalt standblok) | **M** | 3 | 11 |
| **Parkour-race** | Checkpoints, tijd, ghost/leaderboard; eerste die finisht of beste tijd | Doorlopend, respawn bij checkpoint | Nieuwe parcoursen (data) | Checkpoint-logica, timer-HUD, per-parcours-leaderboard | Skips (geen botsingscontrole!) | **M** | 3 | 12 |
| **SkyWars** | Eilanden, loot-kisten, void-knockoff, last alive | Rondes 8-12 min | Eilandkaarten; kisten | Kisten/loot, blokbouw of vaste kaart, void-val, arcade-melee/boog | Loot-RNG; langdurige matches | **L-XL** | 4 | 13 |
| **Build Battle** | Thema, plot per speler, bouwen, stemmen | 5 min bouwen + stemmen | Plots in creative-wereld | Creative in arcade-room, plotbescherming, thema/stem-UI, scorescherm | Stem-spam, trollen | **L** | 3 | 14 |
| **Wave survival (co-op)** | Teams tegen mobgolven, valuta voor wapens/muren | 10-20 golven | Bestaande kaarten + mob-spawns | Mobs in arcade-room, mob-schade op Match-health, golfbeheer, kopen | Twee schademodellen (Match vs EntityManager) | **L-XL** | 5 | 15 |
| **Bed Wars** | Bed per team, generators, shop, bruggen; bed weg = geen respawn | Rondes 15-30 min | Eilandkaarten | Blokken plaatsen/breken in arcade, resource-entities, shop-UI, bed-blok, void, sterk uitgebreide match | Heel veel balanskeuzes | **XL** | 5 | 16 |

Opmerkingen over de rangorde: Bed Wars en Wave survival hebben de hoogste fun maar vragen nieuwe systemen (economie, mobs) en komen daarom
na de eerste zes; **Search & Destroy** wacht op asymmetrische kaarten. Murder Mystery, LMS, Domination zijn goedkope vervolgmodes (S-M)
zodra rondes en zones er zijn.

### 2.3 Data-gedreven `GameTypeDef` en `ModeLogic`

Doel: een nieuwe mode is vooral een `GameTypeDef`-regel plus (zo nodig) een kleine `ModeLogic`-klasse; `Match` blijft eigenaar van spelers,
combat, health, respawntimers, lag compensation.

```ts
// src/modes/GameTypes.ts (voorstel)
export type GameType = 'minecraft' | 'tdm' | 'ffa' | 'gungame' | 'hardpoint' | 'domination' | 'elimination' | 'ctf' | 'infected' | 'blockhunt';

export type MapFeature = 'zones' | 'flags' | 'sites' | 'props' | 'asymmetric' | 'void';
export type RespawnRule = 'timer' | 'never' | 'wave' | 'on-capture';

export interface GameTypeDef {
  id: GameType; name: string; description: string;
  arcade: boolean; teams: boolean; scoreLimit: number; timeLimitSec: number;   // bestaand
  logic: 'deathmatch' | 'zones' | 'rounds' | 'ctf' | 'gungame' | 'infected' | 'blockhunt';  // welke ModeLogic-klasse
  scoring: { kill: number; death: number; headshot: number; assist: number; objective: number };
  respawn: { rule: RespawnRule; seconds: number; protectionSec: number };
  rounds?: { winsNeeded: number; roundSec: number; preSec: number; postSec: number; swapSides: boolean };
  loadout: 'free' | 'class' | 'ladder' | 'fixed';          // wie kiest wapens
  ladder?: string[];                                          // weapon ids voor gungame
  friendlyFire: boolean;
  requires: MapFeature[];                                     // kaartfilter in het menu
  params: Record<string, number>;                             // modespecifiek: captureSec, flagReturnSec, zoneSec...
  hud: ('score' | 'zone' | 'flag' | 'roundWins' | 'ladder' | 'role')[]; // welke HUD-onderdelen
}

// server/ModeLogic.ts
export interface ModeCtx { match: Match; def: GameTypeDef; now: number; send(id: number, m: ServerMessage): void; broadcast(m: ServerMessage): void }
export interface ModeLogic {
  onStart(ctx: ModeCtx): void;                                   // nieuwe match/ronde
  onTick(ctx: ModeCtx, dt: number): void;                        // zones, vlag-timers
  onKill(ctx: ModeCtx, killer: MatchPlayer | null, victim: MatchPlayer, weapon: WeaponDef, head: boolean): void;
  onUse?(ctx: ModeCtx, p: MatchPlayer): void;                    // vlag/bom/zone-interactie (nieuw client-bericht `use`)
  pickSpawn?(ctx: ModeCtx, p: MatchPlayer): Spawn;               // override (bv. weg van zone/vlag)
  loadoutFor?(ctx: ModeCtx, p: MatchPlayer): { primary: string; secondary?: string };
  canDamage?(ctx: ModeCtx, attacker: MatchPlayer, victim: MatchPlayer): boolean;
  checkEnd(ctx: ModeCtx): { winnerTeam: Team | ''; winnerId: number } | null;
  hudState(ctx: ModeCtx): Record<string, unknown>;               // gaat in één `mode`-bericht naar clients
}
```

Wijzigingen in de rest:
- **Protocol (v4):** `{ t: 'mode', state }` (HUD-toestand, ~2 Hz en bij wijziging), `{ t: 'event', kind, ... }` (vlag gepakt, zone verspringt),
  `{ t: 'use' }` van client. Oude clients negeren onbekende berichten (zoals bij `MatchInfo.map`).
- **`ArenaMapDef`:** `symmetry?: 'xz' | 'x' | 'none'` (nu impliciet `xz`), `layout?` (volledige builder bij `none`) en
  `objectives?: { zones?: {u,v,r}[]; flags?: {team,u,v}[]; sites?: ...; props?: BlockId[]; pickups?: ... }`.
- **`Match`:** `phase` uitbreiden met `preround | round | postround`; `scores` van `{red, blue}` naar `Record<string, number>` of `scoreboard`; de
  `endMatch`-winnaarsbepaling uit `logic.checkEnd` halen. De bestaande `rebalance`/`planBalance` blijft voor `teams`.
- **Client:** `ArcadeSession` bewaart `modeState`; `ArcadeHud` heeft widgets per `hud`-entry (zoneboog, vlagicoon, rondepuntjes, ladder, rol).
- **Tests:** `tests/match.test.ts` (581 regels) krijgt per `ModeLogic` een eigen testbestand met een nep-`MatchHost`.

### 2.4 De eerste zes: ontwerp per mode

**1. Gun Game (S).**
- *Regels:* 14 niveaus; kill met niveau-wapen = volgend niveau; kill met mes op iemand = die speler zakt één niveau; jouw kill met mes in het laatste
  niveau wint. Headshot-kill levert geen bonus (kans op ontsnappen). Geen granaten.
- *Ladder (nu al mogelijk, met het huidige arsenal herhaald):* shotgun, SMG, rifle, pistol, sniper, rifle, SMG, shotgun, pistol, rifle, sniper, SMG, pistol, mes.
  Met het uitgebreide arsenal (§3): raket, shotgun, akimbo, SMG, burst, rifle, LMG, DMR, revolver, sniper, pistol, mes.
- *Mechanisme:* `loadoutFor(p) = { primary: ladder[p.level] }`; `onKill` verhoogt `level` en stuurt `spawn`-loadout/`ammo` direct; magazijn vol.
  Respawn 1,5 s, spawnbescherming 1 s; FFA-spawns.
- *Balans:* sniper- en shotgun-niveaus zijn kansniveaus; zet ze niet direct achter elkaar. De match duurt tot het laatste niveau of de timer (8 min): wie dan het hoogste niveau heeft wint.
  Risico: spawnkills; daarom 1 s spawnbescherming en spawns die weg van vijanden kiezen.
- *HUD:* ladder-balk met huidig wapen en volgende; kill-feed met niveaus.

**2. Hardpoint (M) en Domination (S).**
- *Regels:* de "hill" (cirkel 6 blokken) is 60 s actief; 1 punt per seconde voor het team dat er alleen staat; contested = niemand scoort;
  daarna 5 s pauze, volgende zone in vaste volgorde. Eerste team op 200 punten of meeste na 6 min. Respawn 4 s.
- *Data:* `params: { zoneSec: 60, gapSec: 5, captureRadius: 6 }`; per kaart 5 `zones` (in quadrant-coördinaten, zo spiegel je gratis; kies posities
  op de middenas en op de flanken zodat de volgorde afwisselt).
- *Server:* `onTick` telt per zone de levende spelers per team (afstand horizontaal ≤ radius, |Δy| ≤ 3); scoort 1/s; broadcast `mode` bij verandering.
- *Spawns:* `pickSpawn` kiest de teamspawn die het verst van de actieve zone én van vijanden ligt, om spawnkills in de zone te beperken.
- *Domination:* dezelfde `zones` logica maar statisch: drie punten, `captureSec` 3 s, bezit blijft tot ander team het neemt; 1 punt/2 s per punt.
- *Balansrisico:* zones in kleine kaarten (suburb) liggen dicht bij spawns; gebruik alleen kaarten ≥ 80 breed of beperk zones.

**3. Team Elimination (M).**
- *Regels:* 4v4 (tot 8v8), één leven per ronde, ronde 90 s, tijdsoverschrijding: team met meeste levende spelers wint (gelijk = ronde
  gedeeld). Eerste op 4 rondewinsten (best-of-7), kant wisselen na ronde 3 (bij kaarten met asymmetrie later relevant).
- *Rondelaag in `Match`:* fases `warmup → (preround → round → postround)* → ended`. Dode spelers spectaten teamgenoten (bestaande `spectateCandidates`).
  Wapenkeuze (`nextPrimary`) geldt vanaf volgende ronde. Health-regen aan, maar geen respawn.
- *HUD:* ronde-stand (puntjes), levende spelers per team, "x-v-y"-melding bij clutch.
- *Balans:* TTK van ~400 ms is aanvaardbaar; zonder respawn voelt de eerste kill zwaar, dus spawnbescherming 2 s alleen tot de ronde "live" gaat.
  Geef alle spelers ook 1 granaat (flash of frag) om de eerste ontmoeting niet te laten beslissen.

**4. Capture the Flag (L).**
- *Regels:* elke basis heeft een vlag. Pak de vijandelijke vlag door erin te lopen (radius 1,5); drager is 10% trager, kan niet sprinten met de sniper en
  toont een pijl/markering voor zijn team en het vijandelijke team (alleen op 5 s-interval, anders zie je hem altijd). Score bij terugbrengen naar de eigen basis terwijl
  de eigen vlag thuis ligt. Drager gedood: vlag valt, blijft 12 s liggen, teamgenoot raakt aan = direct terug, vijand raakt aan = pak. Eerste op 3 caps of meeste na 8 min.
- *Vlag-state:* `home | carried(playerId) | dropped(x,y,z,returnAt)` per team. Client krijgt dit in `mode.state`; render een banner-model (box-model past bij de stijl).
- *Server:* `onTick` controleert aanraking (met lag-compensatie niet nodig, positie van client vertrouwen is nu hier een risico: een speedhack kan vlaggen
  pakken, zie §5); `onKill` laat de drager vallen; extra punten voor drager-kill (+1) en vlag-terugbreng (+1) voor MVP.
- *Kaart:* de huidige 4-voudige spiegeling levert twee kopieën van elke zone; vlag in de achterste-midden-zone (waar `teamSpawns` zitten).
  Nieuwe kaart "Bunker Flag" (§4.5) is op CTF toegesneden.
- *Balansrisico:* campers rond de vlag en één te snelle drager; oplossing: vlagruimte zonder dominante hoge grond, drager 10% trager, respawn 4 s en een aparte vlagteruggave na 12 s.

**5. Infected (M).**
- *Regels:* ronde 3 min, 6-16 spelers. Eén random besmet (met 8 s voorsprong, sneller 1,15×, mes + lunge, 150 HP, gloeiende ogen), de rest overlevenden met
  volledig arsenal. Dode overlevende wordt besmet. Overlevenden winnen op de klok of als allen besmet zijn; zombies winnen bij 0 overlevenden.
- *Server:* `onKill`: als de dader een zombie is, krijgt het slachtoffer `team='red'` (zombies) en een zombie-loadout; `loadoutFor` regelt klasse. `rebalance` uitschakelen
  voor deze mode (`teams` maar met dynamische teams).
- *HUD:* "survivors left", zombie-kleurfilter, knippering bij heartbeat in de laatste 30 s.
- *Balans:* zombies respawnen na 2 s op een veilige spawn; overlevenden krijgen geen respawn. Eerste besmette: slechts 1 per 8 spelers, extra besmet na 60 s als er niemand besmet is.

**6. Block Hunt (L).**
- *Regels:* kleine groep seekers (1 per 5 spelers). Voor-ronde 20 s: seekers zien een zwart scherm (geen verblinding op de server, alleen client; server weigert `fire`), hiders kiezen een blok
  uit de prop-lijst van de kaart (b.v. kist, vat, bank, kolom) en worden dat blok (hitbox 1×1×1 in plaats van 0,6×1,8). Hiders kunnen 1×/10 s een taunt (geluid + ping) doen.
  Seekers schieten; verkeerd blok raken kost 5 HP (seeker sterft bij 0 HP). Hiders kunnen tijdelijk bevriezen (lock, onzichtbaar voor positie-ruis).
- *Server:* spelerstoestand `prop?: BlockId`; `positionAt` geeft blokpositie; `rayPlayer` gebruikt blokhitbox; `snap` stuurt de blok-id; `mode.state` stuurt aantallen.
- *Client:* `RemotePlayers` rendert het blokmodel in plaats van de speler; eigen camera derde persoon voor hiders.
- *Kaart:* kaarten met veel decor (Maple Court-huizen, Old Quarter-steegjes); `props` is een lijst van blokken die al in de kaart voorkomen.
- *Balans:* hiders mogen niet bewegen om te winnen (anti-camp: elke 30 s een verplichte beweging of ping).

## 3. Wapens en progressie

### 3.1 Huidig arsenal en bevindingen van `scripts/ttk-matrix.ts`

Het script (`npx tsx scripts/ttk-matrix.ts [afstand] [--current] [--aim=0.75]`) rekent twee TTK's: *perfect* (alle schoten raak, `(STK − 1) × interval`) en
*realistisch* (kans dat een kogel in de lichaamshitbox valt, `min(1, (θ/spread)²)`, maal een aim-factor, plus herlaadtijd). Gezondheid 100, geen armor. Heupvuur t/m 7 blokken.

Huidige wapens, perfect (ms van eerste tot laatste schot), uit het script:

| Wapen | rpm | 5 m lichaam | 5 m hoofd | 30 m lichaam | 60 m lichaam | Opmerking |
|---|---|---|---|---|---|---|
| Assault Rifle | 600 | 5x 400 | 3x 200 | 5x 400 | 6x 500 | stabiel; referentie |
| SMG | 900 | 8x 467 | 5x 267 | 9x 533 | 16x 1000 | **nooit sneller dan de rifle** |
| Shotgun | 75 | 2x 800 | 1x 0 | 7x 7200 | n.v.t. | max 72 per schot: nooit one-shot lichaam |
| Sniper | 45 | 2x 1333 | 1x 0 | 2x 1333 | 2x 1333 | hoofd = one-shot; lichaam 2 schoten |
| Pistol | 400 | 6x 750 | 3x 300 | 6x 750 | 12x 1650 | goede secundair |
| Knife | 120 | 2 slagen = 500 | | | | 55 per slag |

Bevindingen:
1. **SMG is gedomineerd:** rifle wint op elke afstand van of is gelijkwaardig aan SMG (duel-matrix 5 m: -67 ms voor de rifle, 30 m: -333 ms).
   De SMG heeft alleen snelheid (1,06). Voorstel (`SMG v2` in het script): 15 schade (7 schoten, 400 ms), val-af eerder (16/50), snelheid 1,08, heupspread 2,6°. Resultaat: realistisch 533 ms tegen 600 ms van de rifle op 5 en 15 m (SMG wint ~70-130 ms), op 30 m gelijk aan de oude SMG (933 ms) en dus ruim verliezend, en 60 m onbruikbaar zoals bedoeld.
2. **Shotgun is kapot:** 72 max = altijd 2 schoten (800 ms); op 15 m ADS raakt maar ~25% van de pellets het lichaam (spreiding 4,2°).
   Voorstel (staat als `shotgun v2` in het script): 10 pellets × 13 (130), spread 4,5°/3,5°, val-af 6 → 20 m, min 15%. Perfect: one-shot (0 ms). Realistisch (aim 0,75) blijft het 2 schoten = 857 ms op 5 m, dus one-shot vraagt vrijwel alle pellets: de shotgun wordt een wapen voor ≤ 4 m, met een tweede schot als vangnet, in plaats van een wapen dat nooit wint.
3. **Sniper:** hoofd 136 (one-shot), lichaam 85 (twee schoten, 1,33 s). Aanbevolen: 90 lichaam op < 120 m, dan val-af tot 70; maakt quickscope-lichaam geen one-shot,
   dat past bij 100 HP. Voeg een **ADS-tijd** (0,25 s) toe zodat quickscoping niet gratis is.
4. **Pistol/mes:** prima. Mes mist achterwaartse bonus: voeg "backstab ×2,0" toe (kill van achteren).
5. **Geen afstandsrollen:** de rifle is van 5 tot 60 m bruikbaar (STK 5-6). De nieuwe wapens moeten elk een afstandsband winnen (zie 3.3).

### 3.2 Voorgesteld arsenal (stats naast het huidige)

Schade uit 100 HP; "val-af" = volle schade tot / minimum bij; `adsSpread` en `spread` in graden (halve kegel). Nieuwe velden: `burst`, `projectile`, `splash`.

| Wapen | Slot | Auto | Schade (hoofd) | Pellets | rpm | Mag | Herlaad | Spread heup/ADS | Val-af (min) | Snelheid | Terugslag | STK lichaam/hoofd | TTK lichaam perfect |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Assault Rifle (huidig) | p | ja | 20 (×2) | 1 | 600 | 30 | 1,6 | 2,2/0,4 | 40/90 (60%) | 1,00 | 0,9 | 5/3 | 400 ms |
| SMG (huidig → voorstel) | p | ja | 13 → **15** (×1,8) | 1 | 900 | 25 | 1,3 | 3,4 → **2,6**/1,2 | 22 → **16/50** (50%) | 1,06 → **1,08** | 0,6 | 8 → **7**/5 | 467 → **400 ms** |
| Shotgun (huidig → voorstel) | p | nee | 9 → **13** (×1,5) | 8 → **10** | 75 → 70 | 6 | 2,4 | 5,5/4,2 → **4,5/3,5** | 10/28 → **6/20** (20% → 15%) | 0,97 | 4 | 2/2 → **1 (≥ 8 pellets) of 2** | 800 → 0 ms perfect, 857 ms realistisch |
| Sniper (huidig) | p | nee | 85 (×1,6) | 1 | 45 | 4 | 2,2 | 9/0 | 300 (100%) | 0,92 | 3 | 2/1 | 1333 ms |
| **LMG** | p | ja | 16 (×1,8) | 1 | 700 | 60 | 3,8 | 2,8/1,0 (+bloom) | 35/80 (60%) | 0,90 | 0,7 (opbouw) | 7/4 | 514 ms |
| **DMR** | p | nee | 34 (×2) | 1 | 270 | 12 | 2,0 | 3,5/0,1 | 60/140 (70%) | 0,96 | 1,6 | 3/2 | 444 ms |
| **Burst Rifle** | p | burst 3 | 22 (×1,6) | 1 | 900 binnen burst, 0,38 s cyclus | 30 | 1,7 | 2,0/0,25 | 45/100 (60%) | 1,00 | 1,2 | 5/3 | 447 ms |
| **Akimbo SMGs** | p | ja | 10 (×1,5) | 1 | 1400 | 40 | 2,1 | 4,0/3,2 | 14/40 (40%) | 1,08 | 0,5 | 10/7 | 386 ms |
| **Revolver** | p | nee | 52 (×2) | 1 | 150 | 6 | 2,4 | 2,5/0,15 | 30/70 (60%) | 1,00 | 4,5 | 2/1 | 400 ms |
| **Raketwerper** | p | nee | direct 90 + splash 4 m (max 80, 40% op eigen) | 1 (projectiel 40 b/s) | 40 | 1 | 2,8 | 1,5/0,6 | splash-radius 4 | 0,92 | 5 | 2 treffers of 1 direct+splash | 1500 ms (cyclus) |
| Pistol (huidig) | s | nee | 18 (×2) | 1 | 400 | 12 | 1,1 | 1,8/0,5 | 25/60 (50%) | 1,04 | 1,1 | 6/3 | 750 ms |
| Mes (huidig) | m | nee | 55 | 1 | 120 | n.v.t. | n.v.t. | n.v.t. | 2,6 | 1,08 | 0 | 2 | 500 ms |
| **Machete** | m | nee | 70 | 1 | 90 | n.v.t. | n.v.t. | n.v.t. | 2,4 | 1,05 | 0 | 2 | 667 ms; 1-slag-achterwaarts |
| **Dagger** | m | nee | 36 (backstab ×2,8) | 1 | 220 | n.v.t. | n.v.t. | n.v.t. | 2,2 | 1,10 | 0 | 3 | 545 ms |

Gooibare (equipment, 1-2 per leven, toets G/4): **frag** (3 s lont, straal 4, 90 midden tot 20 rand, kook-bare), **flash** (straal 12, zicht + gehoor
tot 2,5 s afhankelijk van kijkhoek en zicht-LOS), **rookgranaat** (straal 4, 8 s, breekt vizier), **werpmes** (100 schade op lichaam, 30 blokken, valt neer en kan worden
opgeraapt; **onzeker** of dit in Krunker bestaat, eigen ontwerp). Alle projectielen draaien server-side op 20 Hz met een eenvoudige parabool en voxel-botsing
(geen hitscan); de client toont het projectiel en neemt de explosie van de server over. Nodig: nieuw `projectile`-entity in `Match` (S-M), `boom`-achtig bericht (bestaat voor Minecraft).

### 3.3 TTK-richtlijnen (doelen)

Gemiddelde reactietijd 200-250 ms; TTK onder 200 ms is "zeer laag", 300-600 ms gemiddeld, boven 500 ms hoog (bron: TTK-calculators, zie bronnen).

| Duel | Doel | Waarom |
|---|---|---|
| Rifle vs SMG, ≤ 7 m | SMG wint met 50-100 ms | Close-quarters identiteit |
| Rifle vs SMG, 15 m | gelijk (±50 ms) | Overgang |
| Rifle vs SMG, ≥ 30 m | Rifle wint met ≥ 150 ms | SMG moet vallen met afstand |
| DMR vs Rifle, ≤ 15 m | Rifle wint ~50-150 ms (aim-afhankelijk) | DMR voor precisie, niet voor close |
| DMR vs Rifle, ≥ 40 m | DMR wint ~150 ms | Rol: 40-80 m |
| Shotgun vs alles, ≤ 4 m | Shotgun wint (one-shot bij ≥ 8 pellets, anders 2 schoten) | Nu 800 ms = slechter dan alles |
| Sniper vs Rifle | Rifle wint dichtbij en op middenafstand; sniper wint op hoofd | Sniper is bijna altijd one-shot hoofd |
| LMG vs Rifle | Rifle wint ≥ 100 ms, LMG wint na langdurig vuur (suppressie) | Meer mag, trager beweging |
| Burst vs Rifle | Burst wint bij precisie op ≥ 20 m (ADS 0,25°), Rifle in close | Verschil in spreiding |
| Revolver vs Rifle | gelijk bij 2-schots-kans; verliest op hoofd-gemist | Hoog risico, hoge beloning |
| Raket vs alle | Raket wint met één direct treffer + splash; verliest in duel op rechte baan (1,5 s cyclus) | Gebiedscontrole |

Simpele balanscontrole (de formules in het script): `STK(d) = ceil(100 / (dmg(d) × pellets × hit))`, `TTK = (STK − 1) × 60/rpm (+ herlaad)`.
`dmg(d)` is lineair tussen `range` en `falloffEnd` (zie `damageAt` in `Weapons.ts`). Voor ontwerp: kies schade zodat `100 / dmg` net onder een geheel getal ligt
(20 → exact 5; 22 → 4,55 → 5; 24 → 4,17 → 5; 25 → 4 schoten exact), en zorg dat er maximaal één STK-trede binnen het "kernbereik" valt.
Rijen uit het script (realistisch, aim 0,75, ADS): rifle 600/600/600/700 ms, DMR 667/667/667/667 ms, burst 760 ms, revolver 800 ms, akimbo 557 ms bij 5 m en onbruikbaar vanaf 30 m (11% spread-hit).
Draai het script na elke aanpassing; het toont ook de volledige duel-matrix.

### 3.4 Terugslag en spreidingsmodellen

Nu: uniform in een kegel (`spreadDirection`), vaste `spread`/`adsSpread`, plus +15% lopend en +40% in de lucht (`currentSpread`); terugslag is een visuele camerakick (client).
Voorstellen:
1. **Bloom (server-autoritair):** `spread_eff = base + bloom`, `bloom += perShot` bij elk schot (cap `maxBloom`), `bloom −= recover × dt`. Server kent de schotenreeks al; client toont dezelfde crosshair. Eerste schot nauwkeurig.
2. **Patroon in plaats van pure random** voor auto-wapens: per schotindex een vaste verticale klim en een horizontale driftcurve, `pitch_i = k·√i`, `yaw_i = a·sin(0,9·i)`; de client past hem toe op de camera,
   de server telt hem bij de kijkrichting op als `shotIndex` binnen één trekkerhaal. Spelers leren het patroon (skill), cheaters kunnen het alleen met pull-down compenseren zoals gewone spelers.
3. **ADS-overgang:** `ads` blijft een float 0..1; sniper hip-spread blijft 9° (geen quickscope-gratis).
4. **Bewegingsstraf:** `moving` 1,15 → per wapen (LMG 1,35, SMG 1,05, sniper 2,0) om rollen te onderscheiden.
5. **Limb-multiplier:** hoofd ×1,5-2, lichaam ×1, benen ×0,75 (onder 0,8 blok boven voeten). Het kost één band-check in `rayPlayer`; geeft Krunker-achtige tradeoffs.
6. **Headshot-ontwerp:** hoofdhitbox is 0,4 van 1,8 (22%); houd het vast. Multiplier per wapen: rifle ×2 (200 ms-kill), sniper ×1,6 (136 = one-shot), revolver ×2, shotgun ×1,5.
7. **Reikwijdte-ontwerp:** drie banden per wapen (vol, val-af, minimum) in plaats van twee; documenteer "STK-banden" zodat spelers de afstand leren.

### 3.5 Munitie, herladen, pickups

- **Reserve:** nu oneindig (`magazijn / ∞`). Voor TDM/FFA behouden; voor eliminatie/S&D beperken (3 magazijnen) zodat het herladen strategisch wordt.
- **Tactisch herladen:** herladen met rest in het magazijn is 20% sneller (`reloadSec × 0,8`); herladen onderbreekbaar door wisselen of schieten (shotgun/revolver per kogel).
- **Schietklok per wapen:** `FIRE_SLACK = 0,04` blijft; auto-wapens met `burst` krijgen een eigen cyclus.
- **Pickups (server-entity):** posities in `ArenaMapDef.objectives.pickups`; typen: `health` (+50, 30 s), `armor` (+25 overshield, 45 s), `rocket` (1 raket, 60 s), `sniper` (1 magazijn, 60 s).
  Server controleert afstand ≤ 1,2 en geeft `pickup`-bericht; kaarten krijgen reden voor zones in het midden. Effort M.

### 3.6 Klassen, perks, attachments, killstreaks

**Zes klassen** (loadout-menu `B`; één klasse per leven):

| Klasse | Wapens | Perks (vast) | HP | Snelheid | Rol |
|---|---|---|---|---|---|
| Soldier | Rifle, Burst | niets (referentie) | 100 | 1,00 | Alleskunner |
| Scout | SMG, Akimbo | +8% snelheid, geen val-dempers | 90 | 1,12 | Flankeren, dichtbij |
| Heavy | LMG | +20 HP, 15% minder explosieschade | 120 | 0,90 | Front, suppress |
| Marksman | DMR, Sniper | stille stappen, +zoom, 25% snellere ADS | 100 | 0,98 | Afstand |
| Demolition | Raketwerper, Shotgun | 2 granaten, 50% minder zelf-explosieschade (rocket jump), start met frag | 100 | 0,95 | Gebiedscontrole |
| Engineer | Shotgun, Pistol, Revolver | **3 dekkingsblokken per leven** (verdwijnen na 20 s), repareert eigen vlag | 100 | 1,00 | Unieke Minecraft-link |

Engineer is het onderscheidende element ten opzichte van Krunker/Voxiom: het gebruikt de bestaande blok-plaatsing (de server valideert blokken al in Minecraft-games) in een arcade-context.
Server moet dan tijdelijke blokken met timer en bounding-controle toestaan (M).

**Attachments (twee slots: optiek en onderdeel; ontgrendeld met level):**

| Slot | Opties | Effect |
|---|---|---|
| Optiek | Red dot | adsSpread −10%, zoom 0,75 |
| | 4x scope (DMR/Sniper) | zoom 0,25, heupspread +10% |
| Onderdeel | Extended mag | +50% magazijn, herladen +10% |
| | Silencer | geen minimap/tracer-markering voor vijand buiten 25 m, schade −5%, bereik +5% |
| | Grip | terugslag −15%, spread bij lopen −10% |
| | Speed boost-handvat (Scout) | +4% snelheid, herladen +15% |

**Perks (kies 2 van 6):** Quick Hands (herladen −20%), Lightweight (+4% snelheid), Flak Jacket (−50% explosie), Scavenger (kill = 25% mag terug), Dead Silence (geen stapgeluid),
Hardline (killstreak −1). Perks zijn bewust klein: de TTK-matrix wordt niet door perks verstoord.

**Killstreaks (kills zonder te sterven, alleen in doorlopende modes; reset bij dood):**

| Kills | Beloning | Details |
|---|---|---|
| 3 | **Radar-pulse** | 8 s: vijanden verschijnen op kaartoverlay; server stuurt alleen dan hun posities (past bij fog-of-war in §5) |
| 5 | **Supply drop** | Doos naast je met armor +25 en volle munitie; ook vijand kan hem pakken |
| 7 | **Airstrike** | Markeer een punt; na 2 s drie explosies met 3 m straal, 90 schade |
| 10 | **Juggernaut-pak** | 150 HP, LMG, trager (0,85), 30 s of tot dood |

Krunkers eigen killstreaks zijn voor mij niet bevestigd (**onzeker**); dit is eigen ontwerp.

### 3.7 Progressie

- **XP per match:** kills (100), headshot (+25), assists (50), objective (zone-tick 5, vlag 250), match gewonnen (500), MVP (200). Level 1-60, XP-curve `xp(l) = 800 + 120·l`.
- **Ontgrendelen:** level 1: Soldier + Rifle/SMG; 5: Scout, Pistol; 8: Marksman; 10: ranked/ELO-modus; 12: Heavy; 15: Demolition; 20: Engineer; attachments verspreid; perks vanaf 10.
- **Challenges** (dagelijks 3, wekelijks 3): "30 headshots", "win een Hardpoint met 3 zone-captures", "10 kills met de DMR"; beloning: XP en kosmetica (§6).
- **Geen pay-to-win:** alle wapens ontgrendel je met levels; kosmetica geven geen statistiek (Voxiom en Hypixel).
- **Opslag:** zonder accounts alleen lokaal (`localStorage`/IndexedDB); voor ranked zie §6.

## 4. Kaarten

### 4.1 Ontwerpprincipes voor snelle shooters

Eigen synthese uit gangbare praktijk (niet uit geraadpleegde bronnen, dus **onzeker** op detail):
1. **Zichtlijnen:** korte (< 20 m) en middellange (20-40 m) lijnen domineren; maximaal 1-2 lange lanes (> 50 m) per kaart, met dekking aan beide uiteinden en duidelijke tegenmaatregel.
2. **Lanes:** drie (links, midden, rechts) met verbindende kruisingen; elke 12-20 m een beslissing (links/rechts of omhoog). Geen doodlopende gangen langer dan 8 m.
3. **Verticaliteit:** twee tot drie niveaus; hoge grond heeft altijd een tegenstrategie (trap van twee kanten, open aan één zijde, of overkapping). Eén dominante toren is een slechte kaart.
4. **Dekking:** dekking op 6-10 m afstand van elkaar; 15-25% van de grond geblokt (zie metrics hieronder).
5. **Spawnlogica:** teamspawns gescheiden (> 55 blokken, geen LOS: bestaand), eerste ontmoeting binnen 7-12 s lopen; spawnkeuze weg van vijanden (nu in `pickSpawn`); FFA-spawns na kill ver van de dichtstbijzijnde vijand.
6. **Symmetrie vs asymmetrie:** symmetrie (nu) = eerlijk voor TDM/CTF; asymmetrie is nodig voor aanvallen/verdedigen (S&D) en Block Hunt (decor rijker).
7. **Objective-plaatsing:** zones en vlaggen in de zone *tussen* spawns, bereikbaar in ~10-15 s vanaf spawn; vlag in de basis met één hoofdingang en één flankroute; Hardpoint-zones op alternerende assen.
8. **Leesbaarheid:** teamkleuren op de vloer/wanden (wol); verschillende kleurpalen op oriëntatiepunten; geen grote lege gebieden > 20 m zonder dekking.

### 4.2 Metrics per kaart (`scripts/map-metrics.ts`)

Op grondniveau, horizontale rays op ooghoogte vanuit willekeurige open cellen (20.000 samples), BFS tussen eerste rode en blauwe spawn:

| Kaart | Grootte | Dekking % | Gem. zicht (blokken) | ≥ 40 m % | Route/rechte lijn | Spawn-zicht | Dichtstbijzijnde spawnpaar |
|---|---|---|---|---|---|---|---|
| Classic | 96×96 | 11,5 | 17,7 | 10 | 1,19 | 16,2 | 73 |
| Maple Court | 64×40 | 25,0 | 7,0 | 0 | 1,28 | 5,9 | 53 |
| Old Quarter | 80×64 | 19,6 | 7,3 | 1 | 1,20 | 8,0 | 67 |
| Harbor Yard | 88×64 | 32,0 | 6,6 | 0 | 1,37 | 7,8 | 75 |
| Dust Bazaar | 96×64 | 19,1 | 7,7 | 1 | 1,21 | 7,7 | 81 |

Loopsnelheid ~7,3 b/s (Minecraft-sprint 5,6 × 1,3): eerste contact 7 s (Maple Court) tot 11 s (Dust Bazaar).

### 4.3 Kritiek op de vijf kaarten (met ASCII uit `scripts/ascii-map.ts`)

Het script print één kwadrant (x ≥ 0, z ≥ 0; `#` geblokt, `g` glas, `S` spawn, rechts hoogtes). Doordat elke kaart 4-voudig is gespiegeld, ziet de rest er hetzelfde uit.

**Classic (96×96).** Rechts de teamspawns in de hoek, middenplatform (hoogte 2) bij x 19-27, z 35-44, twee lange muren op z=19 en z=24.
- Probleem 1: met 11,5% dekking en 10% lange rays is Classic een grote, open vlakte voor het aantal spelers (8-16): kwadrant z 0-18 x 9-46 is vrijwel leeg. Veel sprinten, weinig duelleren.
- Probleem 2: de twee lange muren (x 14-30, op z = 19 en z = 24) vormen een gang van 4 breed en 17 lang zonder zijuitgangen: een rushlijn waarin je niet kunt uitwijken.
- Voorstel: halveer open vlakken met 6-8 dekkingsgroepen van 2×2 en 3×1; breek de gangmuur in het midden; maak het middenplatform dubbel zo klein met trap aan beide kanten.

**Maple Court (64×40).** Compact; huizen op x 14-19, z 9-11 en garages; dekking 25%, gemiddeld zicht 7 blokken.
- Sterk: korte eerste contacttijd (7 s) en veel dekking; goed voor 2v2-4v4 en Gun Game.
- Probleem: slechts één `highGround` (21,4) in het kwadrant; daken zijn bijna nergens verbonden; geen langere lijnen (0% ≥ 40 m) betekent geen rol voor sniper/DMR.
- Voorstel: open één lange straat (z 0-2) van 28 blokken met dekking aan beide kanten; tweede dak-toegang via garage; geschikt voor Domination (3 punten: huis, straat, tuin).

**Old Quarter (80×64).** Binnenplaats (x 15-25, z 0-10), poortgebouw, gebouwblokken hoogte 5-6 met steegjes van 4 breed ertussen.
- Sterk: goede verticaliteit (`highGround` op 5 posities), drie routes, 19,6% dekking en gebouwen met begaanbare binnenruimtes (hoogte 5-6 volgens de ASCII).
- Probleem: tussen z = 15 en z = 25 liggen drie gebouwen (x 0-10, 15-25, 30-38) met steegjes van 4 breed ertussen; die twee steegjes zijn de enige doorgang over 10 blokken lengte: chokepoints die met granaten of raketten (§3) bijna ondoordringbaar worden.
- Voorstel: één extra doorgang (poort of gat in de zijmuur) per gebouw; Hardpoint-zones op de binnenplaats en op de twee steegkruisingen.

**Harbor Yard (88×64).** Containerstapels (kleur), loods, kraandek op pilaren, schip als massieve romp (x 6-36, z 25-30, hoogte 4, brug 7).
- Sterk: hoogste dekking (32%), duidelijke teamkleuren.
- Probleem: het schip is in de ASCII een massief blok van 31×6 (x 6-36, z 25-30) met een brug op hoogte 7 (x 27-33); de enige zichtbare toegang is een trap van 2 breed bij x 25-26. Wie bovenop staat, ziet een groot deel van de kaart: dominante high ground met één toegang (interpretatie van de ASCII, **onzeker**).
- Voorstel: maak de romp hol met twee ingangen, voeg een tweede trap toe en geef de kraan een eigen hoogte als tegenhanger.

**Dust Bazaar (96×64).** Beschrijving belooft "lange zichtlijnen", maar `map-metrics` geeft 1% rays ≥ 40 m en gemiddeld 7,7 blokken: de markt verstopt de baan.
- Sterk: sluipschuttertorens (hoogte 6-7) achter de teambasis; veel daken.
- Probleem: de torens (trap en platform, hoogte 6-7) staan bij de teambasis (x 40-46, z 20-27) en kijken over een kaart die zelf vol marktkramen en muren staat (x 3-12 en x 15-30 op z 3-27); echte lange lanes bestaan niet.
- Voorstel: één echte baan van 60+ blokken (b.v. z 28-30, nu open en kaal) met twee lage muren als dekking; beschrijving aanpassen of lijnen openen.

**Algemeen.**
1. De 4-voudige spiegeling is eerlijk maar beperkt: geen asymmetrische kaarten, geen objectives; voeg `symmetry` en `objectives` toe (zie §2.3).
2. Teamspawns liggen in de achterste rand bij de middenas (u 26-44, v 1-14) en zien elkaar niet (`scripts/spawn-los.ts`: 0 van 64 paren; dichtstbijzijnde 53-81 blokken). Gebruik per mode `pickSpawn` weg van
   de zone of vlag; Maple Court (53 blokken) is te klein voor Hardpoint-zones dicht bij het midden.
3. Geen verschil in kaartgrootte per speleraantal: kleine kaarten voor 2v2 en Gun Game, grote voor Infected/CTF; kaartfilter in het menu via `requires` en `minPlayers/maxPlayers` in `GameTypeDef`.

### 4.4 Vijf nieuwe kaartconcepten

Schetsen op ~1:2 schaal, alle uit bestaande blokken te bouwen. `#` muur/dekking, `.` open, `~` water, `=` brug of dak, `F` vlag, `Z` zone (cijfer = volgorde), `A/B` bomsite of blauwe zone,
`R`/`B` spawns (rood/blauw), `H` verstopplek, `p` pijppad.

**4.4.1 Bunker Flag (CTF, 64×40, `symmetry: 'x'`).** Rivier met twee bruggen en een tunnel (`T`) eronder; elke vlag in een bunker met één deur naar het midden. Zichtlijn over de brug ~28 m, de tunnel is de flankroute.
```
################################################
#RRR................~~~~~~~~................BBB#
#RRR........##......~~~~~~~~......##........BBB#
#....#####..##......========......##..#####....#
#....#...#..........~~~~~~~~..........#...#....#
#.....F..#.....##...TTTTTTTT...##.....#..F.....#
#....#...#..........~~~~~~~~..........#...#....#
#....#####..##......========......##..#####....#
#RRR........##......~~~~~~~~......##........BBB#
#RRR................~~~~~~~~................BBB#
################################################
```
**4.4.2 Plaza Zeta (Hardpoint/Domination, 80×80, `symmetry: 'xz'`).** Vijf zones: middenplein met toren (zone 1) en vier hoekpleinen; volgorde 1 → 2 → 3 → 4 → 5 wisselt van kant. Huizenblokken geven dekking en daken (hoogte 4).
```
################################################
#......ZZZ...........................ZZZ.......#
#......Z4Z......##............##.....Z2Z.......#
#......ZZZ...........................ZZZ.......#
#RR.###.....###......######.....###.....###..BB#
#RR.###.....###......#Z11Z#.....###.....###..BB#
#RR.###.....###......######.....###.....###..BB#
#......ZZZ...........................ZZZ.......#
#......Z5Z......##............##.....Z3Z.......#
#......ZZZ...........................ZZZ.......#
################################################
```
**4.4.3 Foundry (Search & Destroy lite, 70×50, `symmetry: 'none'`).** Aanvallers (west) hebben drie routes: yardgang, pijppad en dakbrug; verdedigers (oost) houden site A (hal) en site B (ketelruimte) met een binnenpad van ~6 s ertussen. Bom 40 s, plant 4 s, defuse 6 s.
```
################################################
#RRRR...#...............#...###########.########
#RRRR...#...###.........#...............#.....##
#RRRR...#...###.........#.....A..A......#..BBB##
#.......#...............................#..BBB##
#.................pppppp....###########....B..##
#.......#...............................#.....##
#RRRR...#...###.........#...............#.....##
#RRRR...#...###.........#...............#.....##
#RRRR...#...==roof===================...########
################################################
```
**4.4.4 Manor (Block Hunt, 56×56, `symmetry: 'none'`).** Landhuis met hal, keuken, schuur, tuin met vijver en een kelder (twee verdiepingen); overal prop-plekken (kisten, vaten, banken, potten). Seekers starten in een afgesloten kamer.
```
################################################
#............##########..###########..########.#
#.~~~~~~~~...#.hall...#..#.kitchen.#..#.shed.#.#
#.~~~~~~~~...#......H.#..#.......H.#..#......#.#
#.~~~~~~~~...#.H......#..#..H......#..#.H....#.#
#............#........#..#.........#..#......#.#
#...H........##########..###########..########.#
#............#######################........H..#
#.........H..#..cellar........H....#...........#
#............#######################...........#
################################################
```
**4.4.5 Colosseum (Gun Game/FFA, 36×36, `symmetry: 'xz'`).** Achthoekige ring met vier doorgangen naar een centrale put (3 diep, `:`) met een raketpickup (`R`); 12 FFA-spawns op de ring. Klein genoeg voor 6-10 spelers, veel hoeken.
```
          #############          
        ###...........###        
      ###...............###      
    ###...................###    
  ###.......##.#.####.......###  
  ##......###:::::::###......##  
  ##.....##.:::::::::.##.....##  
  ##.....#..:::R:::::..#.....##  
  ##.....##.:::::::::.##.....##  
  ##......###:::::::###......##  
  ###.......####.#.##.......###  
    ###...................###    
      ###...............###      
        ###...........###        
          #############          
```

## 5. Netcode en anti-cheat

### 5.1 Hoe het nu werkt (uit code)

| Onderdeel | Waarde | Plaats |
|---|---|---|
| Tick server | 20 Hz (`TICK_MS = 50`) | `GameServer.ts` |
| Positie-uplink | client `pos` elke 0,05 s (20 Hz), JSON | `NetClient.ts` |
| Snapshot-downlink | `snap` met **alle** spelers, 20 Hz, JSON, 3 decimalen | `GameServer.tick` |
| Interpolatie client | 100 ms (2 snapshots) | `RemotePlayers.ts` |
| Hitscan | server: voxel-trace + rayPlayer; de client stuurt oog + richting | `Match.fire` |
| Lag compensation | `rewind = min(0,35, ping/1000 + 0,1)`; history 24 samples (≈ 1,2 s), gerecord per tick | `Match.ts` |
| Origin-vertrouwen | client-oog mag ≤ 1,6 blok afwijken van server-oog | `MAX_ORIGIN_DRIFT` |
| Snelheidscheck | `dist > 40·dt + 4` met `dt ≥ 0,05` | `GameServer.onPos` |
| Bounds | binnen kaart, y ∈ [floor−2, floor+40] | `GameServer.onPos` |
| Ping | WS ping/pong elke 3 s | `PING_INTERVAL_TICKS` |

De rewind-formule klopt als model: wat de schutter ziet is `neerwaartse delay + interpolatie` oud, en zijn schot komt een `opwaartse delay` later aan: `rewind = RTT + interpolatie` (Valve doet het zelfde met `cl_interp` 0,1 s en `sv_maxunlag` 1 s).

### 5.2 Hoe goed houdt het stand

**Wat goed is:** server-autoritaire hit-detectie, 1 s history (genoeg), rewind-cap 350 ms (maximaal ~250 ms ping speelbaar), eigen `ammo`/health/loadout op de server, spawn-bescherming, fire-rate-controle,
lag-comp met interpolatie tussen samples, bullets stoppen op blokken.

**Zwakke punten (volgorde van ernst):**

| # | Risico | Gevolg | Fix | Kosten |
|---|---|---|---|---|
| 1 | **Geen botsingscontrole tegen blokken** (alleen kaartgrens, y ≤ floor+40) | Noclip/fly/teleport binnen de grens; vlag-/zone-modes direct te omzeilen | Gezwaaide controle per `pos`: 3 voxel-rays (voeten, middel, hoofd) van oud naar nieuw; weiger bij raak (`traceBlocks` bestaat al) | S-M |
| 2 | Snelheidslimiet 40 b/s + 4 slack, horizontaal | Legitiem max ~10-12 b/s (bhop). Speedhack tot 30 b/s zonder detectie | Leaky bucket: per seconde mag je `maxSpeed × 1 s + 3` blokken afleggen; `maxSpeed` ≈ 14 (**onzeker**, meten met een testbot) | S |
| 3 | `dt` klemt op ≥ 0,05 s: pakketten in een burst passeren (Krunkers fake-lag) | Teleporteren/hold-and-release | Tijdbudget: elk `pos` verbruikt 50 ms van een emmer die met echte tijd vult (max 150 ms); te snelle pakketten afknijpen | S |
| 4 | Y-richting alleen begrensd | Vliegen (hover) | Luchttijd bijhouden met `flags & 4` (on ground) en maximale sprong- en valsnelheid | S |
| 5 | Client bepaalt schotorigin binnen 1,6 | Schieten "om de hoek" 1,6 blok | Verlaag naar 0,6 en baseer op eigen server-positie van de laatste `pos` | S |
| 6 | **Wallhack:** `snap` stuurt iedereen | ESP/wallhack leest positie | Zie 5.3 | M |
| 7 | Geen aim-analyse | Aimbot/triggerbot | Zie 5.4 | M-L |
| 8 | Client-hoeken ongecontroleerd | yaw met meervoud van 2π (Krunker-exploit) | Normaliseer yaw/pitch server-side (`pitch ∈ ±π/2`) en weiger NaN/Infinity | S |
| 9 | JSON bandbreedte | Bij 16 spelers ~180 kbps per client | Binair protocol, zie 5.5 | M |

### 5.3 Fog-of-war voor `snap` (anti-wallhack)

Valorant stuurt vijandposities alleen als een speler ze mogelijk kan zien; de implementatie gebruikt een voorberekende visibility-set en kost < 2% van de server-frametijd,
met uitbreiding van de bounding box voor latentie en "look-ahead" om peekers-voordeel te voorkomen.

Voor BunkCraft:
- Per ontvanger en doel: 3 `traceBlocks`-rays (ooghoogte van ontvanger naar hoofd, borst en voeten van doel); zichtbaar als één ray vrij is; doelen binnen 8 blokken altijd.
- Hysterese: blijf het doel 0,3 s sturen nadat zicht verdween; stuur 0,15 s vóór zicht (extrapolatie met snelheid 7,3 b/s: `reveal_distance ≈ 2 blokken`).
- Wegvallend doel: client toont de speler niet (fade out), geen "bevroren" model; naamtags blijven client-LOS maar worden niet meer nodig.
- Uitzonderingen: killcam (killer 1 s sturen), teamgenoten altijd (tdm/elim), radar-pulse killstreak, spectating.
- Geluid/tracers: `shot` heeft de origin van de schutter; stuur alleen binnen 60 blokken of met LOS (geluid is toch gedempt met afstand).
- Kosten: N(N−1) paren × 3 rays × 20 Hz; bij N=16 is dat 14.400 rays/s, elk ≤ 80 voxelstappen ≈ 1,2 M stappen/s: orde 3-8% van één kern (**onzeker**; meten met `scripts/bench-arena.ts`). Hieruit volgt dat je met 30 Hz en 24 spelers niet verder dan 20% komt.
- Effort M (server) plus S (client: ontbrekende spelers in `RemotePlayers`).
- Beperking (zoals bij Valorant): werkt op eenvoudige kaarten; voor open kaarten (Classic) vermindert het de wallhack weinig voor spelers in LOS, maar muren worden wel dicht.

### 5.4 Aimbot-heuristieken

Server kent per speler de kijkrichting op 20 Hz (in `pos`) en bij elke `fire` (richting). Voeg een kleine `CheatMonitor` toe die scores bijhoudt en niets automatisch bant:

| Heuristiek | Meting | Verdacht als | Vals-positief |
|---|---|---|---|
| Snap-aim | hoek tussen twee opeenvolgende `pos`-richtingen > 60° én de eindrichting ligt binnen 1° van een vijand-hoofd en `fire` volgt binnen 1 tick | ≥ 3 keer per ronde | Snelle spelers met sniper-flick (zeldzaam) |
| Headshot-ratio | % headshots over laatste 30 hits op > 15 m voor niet-sniper | > 70% | Duelisten met DMR/revolver |
| Reactietijd | tijd tussen eerste zicht (LOS) van een vijand en eerste raak | < 120 ms herhaald | Peek-aan-peek |
| Tracking-ruis | variantie van de hoekfout tijdens ononderbroken schieten | onmenselijk laag (< 0,05°) | Hoge ADS met sniper |
| No-recoil | pitch-drift tijdens ≥ 10 opeenvolgende schoten bij auto-wapen | bijna 0 | Spelers die goed compenseren |
| Triggerbot | `fire` precies bij eerste LOS-tick | Altijd < 1 tick | n.v.t. |

Maatregelen: log naar server-console + `/api` admin-endpoint; vlag in roster voor de host; room-eigenaar kan kicken. Geen auto-ban (accounts ontbreken); wel
"shadow" optie later (aimbot-gebruikers spelen met elkaar). Effort M (heuristieken) en L (tuning met opgenomen demo's); doe een testbot-suite (`scripts/arena-bots.ts` bestaat) die aimbot-gedrag simuleert.

### 5.5 Tickrate, compressie en input

| Maatregel | Winst | Kosten |
|---|---|---|
| **30 Hz voor arcade-kamers** (pos + snap) | Interpolatie 100 → 67 ms (2 snapshots), hit-registratie nauwkeuriger | M (alle timers in `GameServer`/`NetClient` kamer-afhankelijk) |
| 60 Hz | Alleen als meting laat zien dat het scheelt | L, CPU ×3, JSON te duur |
| **Binair snapshotformaat** | Per speler ~14 byte (id 1, x/y/z als int16 in 1/32 blok, yaw/pitch als uint8/int8, flags 1, held 1) in plaats van ~70 byte JSON; 5× kleiner | M (encoder/decoder + tests; arcade-only) |
| Delta-snapshots | Alleen veranderde spelers/waarden; ~40% extra | M-L |
| Input-buffer (client stuurt laatste 3 `pos` mee) | Herstelt verloren pakketten; WebSocket is TCP-geordend, dus alleen nuttig voor late pakketten | S (laag) |
| Server herberekent hit met 2 snapshots | Al aanwezig | n.v.t. |
| Spelersvoorspelling | Beweging is client-autoritair, dus geen reconciliatie nodig behalve bij `teleport`; hit-markers zijn server-bevestigd (~RTT vertraging) | n.v.t. |

Bandbreedte nu: 16 spelers × 70 B × 20 Hz × 16 ontvangers ≈ 360 KB/s totaal; per speler 22 KB/s. Binair 30 Hz: 16 × 14 B × 30 Hz = 6,7 KB/s per speler.

Peeker's advantage: rewind tot 350 ms betekent dat een verdediger die 7,3 b/s rent tot 2,5 blok achter dekking nog geraakt kan worden. Verlaag `MAX_REWIND` naar 250 ms voor ranked en toon
spelers met > 150 ms ping een waarschuwing in het scorebord.

## 6. Retentie en sociale functies

| Functie | Wat | Inspanning | Opmerking |
|---|---|---|---|
| **Eindscherm** | Winnaar, scorebord met K/D, schade, nauwkeurigheid, headshot-%, langste serie, beste wapen, MVP | S-M | Server telt al kills/deaths; voeg `damage`, `shots`, `hits`, `headshots` toe aan `MatchPlayer` en `roster` |
| **MVP** | `score = kills + 0,5·assists + 3·objective + 0,25·headshots`; bij CTF/Hardpoint objective zwaar | S | Assists vereisen schadelog (≥ 30 schade in 5 s) |
| **Rematch / stemming** | Tijdens `ENDED_SECONDS` (12 s) stemmen over kaart (3 opties) en mode (2); winnaar wint | S-M | Nieuw `vote`-bericht |
| **Kill cam** | Client houdt 4 s ringbuffer van `snap`-posities (inclusief yaw/pitch); bij dood speelt een replay vanuit de ogen van de schutter, 3 s | S-M | Geen servercode nodig (nu volgt de camera 1 s de killer) |
| **Spectator (volledig)** | Vrije camera/volg-modus voor spelers die niet meespelen; ook voor wachtende spelers (te veel spelers) | M | Fog-of-war: spectators ontvangen alles |
| **Partijcodes** | Aanwezig (room-codes). Voeg "kopieer link" en "partij met vrienden" (team-reservering) toe | S | |
| **Leaderboards** | Per mode: dagelijks/wekelijks (kills, caps, Gun Game-tijd, parkour-tijd) | M | Geen accounts: anoniem apparaat-token + naam; server bewaart top-N |
| **Ranked/ELO** | Hardpoint of Elimination 4v4, ELO of Glicko-lite per apparaat-token, K = 24 (nieuw), team-gemiddelde; divisies zoals Krunker (125 punten per divisie, +25 per winst is Krunkers model) | L | Vereist identiteit en anti-smurf; zie §5 voor fairness; **onzeker** of dit het eerste doel is |
| **Dagelijkse/wekelijkse challenges** | 3 per dag (zie §3.7); beloning XP en kosmetica | S-M | Lokaal opgeslagen; cheaters raken alleen hun eigen kosmetica |
| **Seizoenen** | 8-weken, kosmetische beloning aan top-ranglijst | M | Pas na ranked |
| **Community-kaarten** | Kaarten bouwen in Minecraft-creative en exporteren naar arcade (lijst blokken + spawns + objectives) | XL | Krunkers editor is de belangrijkste groeimotor (§1.1); BunkCraft heeft de sandbox al |

**Kosmetica zonder Mojang-assets (ontwerp):**
- Spelerskin: kleurenpaletten, patronen (strepen, camo, pixelpatronen) en haarband/hoed-modellen uit boxmodellen (geen Minecraft-skin).
- Wapenskins: palet-swaps van de `WEAPON_MODELS`-boxmodellen, met "stickers" van 8×8 pixelkunst (eigen editor).
- Tracer-kleuren en -vormen, hit-marker-stijlen (tik, kruis, stip), kill-feed-iconen, richtkruis-editor (Krunker heeft er een; **onzeker** op details).
- Sprays: 16×16 pixelspray die de speler tekent; moderatie via lokale opslag en alleen zichtbaar in dezelfde kamer.
- Emotes/taunts in boxmodel-animatie; naamplaat-badges (level, seizoen, MVP-sterren); killcam-banners.
- Alles ontgrendel je met levels/challenges: nooit stat-verhogend.

**Retentie-prioriteiten (kosten laag naar hoog):** eindscherm + MVP → rematch/stemming → kill cam → challenges → leaderboards → ranked/seizoenen → community-kaarten.

## 7. Aanbevolen roadmap

1. **Fase 0 (1 week):** `ModeLogic`/`GameTypeDef`-refactor met TDM/FFA als eerste logics (gedrag ongewijzigd); netcode-hardening (§5.2, punt 2-5 en 8, daarna 1); shotgun/SMG-fixes (3.1).
2. **Fase 1 (2 weken):** Gun Game, Hardpoint (+ Domination), `objectives` in `ArenaMapDef`, eindscherm/MVP.
3. **Fase 2 (2-3 weken):** rondelaag, Team Elimination, Infected, arsenal-uitbreiding (LMG/DMR/burst/revolver/akimbo/raket) met `ttk-matrix`.
4. **Fase 3 (3-4 weken):** CTF + Bunker Flag, fog-of-war (§5.3) en binair 30 Hz (§5.5), pickups, klassen/perks.
5. **Fase 4 (4+ weken):** Block Hunt, killcam/stemming, leaderboards; daarna ranked, S&D (Foundry), grote inzetten (Wave survival, Bed Wars).

Strategische observatie: de eigenlijke concurrentiekracht van BunkCraft is de combinatie sandbox + arcade: destructibele dekking (raket breekt blokken, herstelt na 20 s), Engineer-klasse, Block Hunt
en later community-kaarten uit creative. Dat doet Krunker (editor) niet zo en Voxiom alleen in beperkte vorm.

## Bronnen

- Krunker: [klassen](https://krunker.io/guides/classes/), [modes](https://krunker.io/guides/game-modes/), [ranked](https://krunkerio.fandom.com/wiki/Ranked) (fetch gaf 402, gegevens uit zoekresultaat), [wapenstats](https://muncho4.github.io/krunker/) en [fan-quiz](https://www.jetpunk.com/user-quizzes/336208/krunkerio-weapons/stats), [beweging](https://www.speedrun.com/krunker/guides/vm2um), [anti-cheat/netcode](https://github.com/hrt/AnticheatJS), [overige modes](https://www.snokido.com/game/krunkerio)
- Vergelijkbaar: [Voxiom](https://www.crazygames.com/game/voxiom-io), [Shell Shockers](https://en.wikipedia.org/wiki/Shell_Shockers), [Venge.io](https://zapgames.io/venge-io), [Bullet Force](https://shellshockers.co.uk/game/bullet-force/)
- Hypixel: [Bed Wars](https://hypixel.fandom.com/wiki/Bed_Wars), [Murder Mystery](https://hypixel.fandom.com/wiki/Murder_Mystery), [Build Battle](https://hypixel.fandom.com/wiki/Build_Battle), [Games](https://hypixel.fandom.com/wiki/Games), [TNT Games](https://hypixel.fandom.com/wiki/TNT_Games), [Hide and Seek](https://hypixel.fandom.com/wiki/Hide_and_Seek), [retentie (forum)](https://hypixel.net/threads/retention-of-players.5806021/)
- Netcode: [Valve Source networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) (fetch gaf 403, uit zoekresultaat), [Gambetta](https://www.gabrielgambetta.com/client-server-game-architecture.html), [Valorant Fog of War](https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war), [CS2FOW (secundair)](https://gameriv.com/cs2-modder-builds-a-server-side-anti-wallhack-that-could-also-boost-your-fps/)
- TTK: [xbitlabs](https://www.xbitlabs.com/ttk-calculator/), [moderncombat wiki](https://moderncombat.fandom.com/wiki/Time-to-kill)
- Intern: `docs/GAMEMODES.md`, `docs/SERVER.md`, `src/modes/*`, `server/Match.ts`, `server/Combat.ts`, `server/GameServer.ts`, `scripts/ttk-matrix.ts`, `scripts/map-metrics.ts`, `scripts/ascii-map.ts`
