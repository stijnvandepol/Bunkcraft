# BunkCraft gameplay: onderzoek en implementatie

Samenvatting van het gameplay-onderzoek (game modes, mobs, animaties, blokken, items) en wat daarvan
in BunkCraft zit. Getallen komen uit de Minecraft Wiki, tenzij anders vermeld.

## Game modes

| Mode | Regels in BunkCraft |
|---|---|
| **Survival** | Health 20, honger 20 (saturatie 5), adem 300 ticks. Blokken breken kost tijd, en drops pak je op. Niet vliegen. |
| **Creative** | Onkwetsbaar (behalve in de void), vliegen met dubbel spatie, direct breken, oneindig blokken, creative inventory. |
| **Hardcore** | Survival met één leven: na de dood volgt "Game over!" en kun je alleen nog toekijken (Spectate World). |
| **Spectator** | Vliegen door blokken (noclip), geen interactie, geen hotbar. |

### Schade en herstel (vanilla-waarden)

| Bron | Schade |
|---|---|
| Vallen | `ceil(valafstand − 3)` |
| Verdrinken | 2 per seconde, na 300 ticks zonder lucht |
| Lava | 4 per 0,5 s, daarna 15 s branden (1 per seconde; water blust) |
| Cactus | 1 bij contact |
| Void | 4 per 0,5 s onder y = −64 (ook in Creative) |
| Stikken | 1 per 0,5 s met je hoofd in een vast blok |
| Verhongeren | 1 per 4 s bij honger 0 (in Survival niet onder ½ hartje) |

- **Onkwetsbaarheid:** 10 ticks na een treffer. Een zwaardere klap telt alleen voor het verschil.
- **Uitputting:** sprinten 0,1/m, springen 0,05 (sprint-sprong 0,2), blok breken 0,005, zwemmen 0,01/m, schade 0,1. Elke 4 punten uitputting kost eerst saturatie, daarna honger.
- **Regeneratie:** 1 HP per 80 ticks bij honger ≥ 18, of per 10 ticks bij volle honger met saturatie.
- **Sprinten:** niet mogelijk bij honger ≤ 6.

## Mobs

| Mob | HP | Hitbox | Gedrag | Drops |
|---|---|---|---|---|
| Varken | 10 | 0,9×0,9 | dwalen, vluchten bij schade | 1–3 rauw varkensvlees |
| Koe | 10 | 0,9×1,4 | dwalen, vluchten | 1–3 rauw rundvlees |
| Schaap | 8 | 0,9×1,3 | dwalen, vluchten | 1 witte wol, 1–2 schapenvlees |
| Kip | 4 | 0,4×0,7 | dwalen, fladderen, geen valschade | 1 kip, 0–2 veren |
| Zombie | 20 | 0,6×1,95 | achtervolgen, slaan (3), brandt in de zon | 0–2 rot vlees |
| Creeper | 20 | 0,6×1,7 | achtervolgen, 1,5 s opzwellen, explosie (kracht 3) | 0–2 buskruit |

- **Spawnen:**
  - Dieren verschijnen in groepjes van 2–4 op gras zodra een chunk genereert, met een vaste kans per seed.
  - Monsters spawnen 24–48 blokken van de speler, bij block light 0 en een verduisterde sky light ≤ willekeurig 0..7. Dat gebeurt 's nachts en in grotten.
- **Despawnen:** monsters verdwijnen direct verder dan 128 blokken, en verder dan 32 blokken met kans 1/800 per tick. Dieren verdwijnen met hun chunk en keren terug vanuit de seed.
- **Animatie:**
  - Benen: `cos(limbSwing · 0,6662) · 1,4 · limbAmount`.
  - De kop volgt het doel.
  - Rode flits bij schade; bij de dood omrollen in 20 ticks.
  - Creepers zwellen op en knipperen wit.
- **Rendering:** één `InstancedMesh` per lichaamsdeel per soort, dus ongeveer 6 draw calls per soort, hoeveel mobs er ook zijn.
- **Gevecht:**
  - Vuist 1 schade. Zwaarden doen 4–7, bijlen 7–10.
  - Knockback (verder bij sprinten).
  - Tools slijten.

## Speler

- **First-person hand:**
  - Arm, vastgehouden blok als 3D-kubus, items als sprite.
  - Swing (6 ticks), equip (zakken en weer opkomen bij wisselen), bob tijdens lopen, eet-animatie.
- **Hurt cam:** het beeld kantelt met `−sin(t⁴·π)·14°` naar de kant van de klap, met een rode vignette.
- **Doodscherm:**
  - "You died!" met doodsoorzaak, Respawn en Title Screen; je inventory valt op de grond.
  - In Hardcore: "Game over!" met Spectate World.

## Weer en lucht

- **Weer-statemachine** (`src/world/Weather.ts`, zonder DOM, met tests): twee vlaggen met timers in ticks, zoals Minecraft. Regen duurt 12 000–24 000 ticks en blijft 12 000–180 000 ticks weg; onweer duurt 3 600–15 600 ticks en telt alleen mee tijdens regen. Het niveau (`rain`, `thunder = thunderLevel × rainLevel`) loopt met 0,01 per tick (5 s) mee.
- **`/weather clear|rain|thunder [seconden]`:** in singleplayer lokaal (`WeatherSystem.localCommand`), in multiplayer op de server (iedereen mag het nog; de server-admin-ontwikkelaar voegt rechten toe). Zonder duur kiest hij een willekeurige duur uit het bereik hierboven. Arcade-kamers hebben altijd helder weer.
- **Opslag en sync:** `WorldMeta.weather` en `WorldMeta.day` (optioneel) in singleplayer, `weather` en `day` in `world.json`. Multiplayer: optionele berichten `weather { rain, thunder, ticksToChange?, snap? }` (bij joinen en bij elke wijziging; clients faden zelf) en `bolt { x, y, z }`; `time` en `welcome` krijgen een optionele `day`. Oude clients negeren de nieuwe berichten.
- **Neerslag:** één instanced draw call rond de camera (tot 6 000 deeltjes, 2 400 bij Particles: Minimal), volledig in de vertex shader. Een 64×64 top-down masker (hoogte van het hoogste blok dat regen tegenhoudt, soort neerslag en water-vlag, 2 rijen per frame ververst) bepaalt per kolom waar het valt: niet onder daken of bomen, op de grond en op water een rimpel. Biome bepaalt de soort: regen, sneeuw in Snowy Plains en boven y 106 (Mountains vanaf 94), geen in woestijn (`precipitationFor`).
- **Lucht tijdens regen:** grijzere, donkerdere lucht en mist (mist 30% korter), zon, maan, sterren en zonsondergang verdwijnen, wolken worden dikker, lager en grijzer (extra wolkcellen groeien uit het niets). `daylight` krijgt Minecraft's factor `(1 − 5/16 regen)(1 − 5/16 onweer)`.
- **Bliksem:** tijdens onweer slaat het gemiddeld eens per 30 s per speler in op 12–64 blokken afstand (server-gesimuleerd in multiplayer, alle clients tekenen dezelfde flits). Gekartelde lijn met takken, hemelflits en vertraagde donder. Binnen 3 blokken: 5 schade en 8 s brand voor spelers en mobs. `WeatherSystem.onLightningFire` is de haak voor vuur op het getroffen blok. De flits respecteert `Settings.reduceFlashes` (als die bestaat): geen flikkering, 25% sterkte.
- **Effecten voor gameplay:** regen blust een brandende speler die de lucht kan zien; `Weather.isRainingAt(world, x, y, z)` is de API voor farmland, vuurverspreiding en cauldrons; `Weather.skyDarkness` (3 × regen + 2 × onweer) telt mee als extra duisternis voor hostile spawns (`Game.gameTick` en `ServerEntities.tick`).
- **Maanfasen en dag:** `DayCycle.day` telt hele dagen (opgeslagen); de maan doorloopt 8 fases (0 vol … 4 nieuw), elke 8e dag volle maan, als pixel-bol met terminator en kraters in de sky shader. F3 toont `Day N · Moon: fase`.
- **Hemel:** grotere zon (16×16 pixels met rand) en maan, twinkelende sterren plus enkele grote kleurige, bredere zonsondergangsband met paarse tegenkant, en de kleur onder en op de horizon is exact de mistkleur (geen naad met het ver terrein).

## Items, tools en crafting

- **Breektijd** volgens Minecraft's formule: `snelheid / hardheid / (oogstbaar ? 30 : 100)` per tick, ×5 trager in de lucht of onder water.
  - Steen en ertsen hebben een pikhouweel nodig om iets te laten vallen; ijzererts minstens steen, diamant minstens ijzer.
- **Drops:**
  - Gras → aarde, steen → cobblestone.
  - Kolen- en diamanterts → kolen en diamant.
  - Bladeren → soms een stok; glas → niets.
  - Items dobberen, worden aangetrokken en opgepakt, en stapels met hetzelfde item voegen samen.
- **Crafting** via een receptenlijst zoals het receptenboek:
  - Zonder werkbank: planken, stokken, werkbank, fakkels.
  - Bij een werkbank (binnen 4 blokken): oven en houten, stenen, ijzeren en diamanten tools.
  - Bij een oven (binnen 4 blokken): glas, steen, ijzerstaaf, houtskool en gebakken vlees.
- **Eten:** rechtermuisknop 1,6 s ingedrukt houden. Herstelt honger en saturatie volgens de vanilla-tabel.
- **Inventory:**
  - 27 slots plus de hotbar.
  - Links klikken pakt een stack op, legt hem neer, voegt samen of wisselt; rechts klikken splitst of legt er één neer.
  - Met Q laat je een item vallen.

## Nieuwe blokken

| Blok | Details |
|---|---|
| Fakkel | Licht 14, eigen 3D-model (2×10×2 px), heeft een blok eronder nodig |
| Lava | Licht 15, geanimeerd, schade en vertraging; lavameren in grotten onder y = 11 |
| Werkbank, oven | Crafting-stations |
| Slabs en trappen | Stone, cobblestone, mossy cobblestone, stone brick, brick, sandstone, oak, birch en spruce. 3 blokken → 6 slabs, 6 blokken → 4 trappen. Een slab komt op de aangeklikte helft, twee gelijke worden een dubbele slab (geeft 2 drops); een trap kijkt de kant van de speler op en klapt om aan een plafond of de bovenste helft. Je loopt ze op zonder te springen (stap 0,6) |
| Eikenhouten deur | 6 eikenhouten planken → 3 deuren. Twee blokken hoog, scharnier links of rechts (naast een muur of andere deur zoals in Minecraft), rechtermuisknop opent en sluit, breken haalt beide helften weg. Staat op een blok met een stevige bovenkant |
| Water en lava | Stromend: water 7 blokken ver, elke 5 ticks; lava 3 blokken ver, elke 30 ticks. Twee waterbronnen naast elkaar maken een nieuwe bron; water naast lava geeft obsidiaan (bron) of cobblestone (stromend). Stromend water spoelt planten en fakkels weg |
| Emmers | Ijzeren emmer (3 ijzerstaven); rechtermuisknop op een bron schept hem op, een volle emmer plaatst een bron (survival: je krijgt een lege emmer terug) |

Een geïmporteerd Minecraft-resourcepack levert ook textures voor `torch`, `lava_still`, `crafting_table_*` en `furnace_*`.

## Roadmap

1. **Block states:** **gedaan** voor slabs, trappen, deuren en vloeistoffen ([`BLOCKSTATES.md`](BLOCKSTATES.md)); ladders, muurfakkels, gewassen en een oven met een richting volgen op dezelfde basis.
2. **Vloeistofstroming:** **gedaan** (water en lava, emmers).
3. **Vallend zand en grind** als entity.
4. **Meer mobs:** skeleton (pijlen) en spin (klimmen).
5. **Meer blokken en items:** kist, TNT, harnas, XP-orbs en de XP-balk.
6. **Multiplayer:** zie [`MULTIPLAYER.md`](MULTIPLAYER.md).

## Bronnen

- Minecraft Wiki: [Game mode](https://minecraft.wiki/w/Game_mode), [Health](https://minecraft.wiki/w/Health), [Hunger](https://minecraft.wiki/w/Hunger), [Damage](https://minecraft.wiki/w/Damage), [Mob spawning](https://minecraft.wiki/w/Mob_spawning), [Zombie](https://minecraft.wiki/w/Zombie), [Creeper](https://minecraft.wiki/w/Creeper), [Pig](https://minecraft.wiki/w/Pig), [Cow](https://minecraft.wiki/w/Cow), [Sheep](https://minecraft.wiki/w/Sheep), [Chicken](https://minecraft.wiki/w/Chicken), [Lava](https://minecraft.wiki/w/Lava), [Torch](https://minecraft.wiki/w/Torch), [Breaking](https://minecraft.wiki/w/Breaking), [Item (entity)](https://minecraft.wiki/w/Item_(entity)), [Heads-up display](https://minecraft.wiki/w/Heads-up_display)
