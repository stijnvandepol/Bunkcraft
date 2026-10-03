# Structuren, dorpen en villagers: onderzoek en ontwerp voor BunkCraft

Onderzoek van 3 oktober 2026, voor Minecraft Java Edition 26.x. Doel: per overworld-structuur vastleggen wat het is, hoe het genereert,
wat erin zit en hoe BunkCraft het bouwt; daarna dorpen, villagers en trading, met een MVP en een bouwvolgorde.

**Bronnen en betrouwbaarheid.** Loot-tabellen en trade-tabellen zijn letterlijk uit de wiki-data gehaald (`Module:LootChest/chests`,
de gerenderde tabellen op `Trading`). Plaatsing (spacing/separation/salt) komt van `Structure set`. Interne stukgrammatica (mijnschacht-
kansen, dorp-pools) staat niet volledig op de wiki en komt uit eerdere kennis: daar staat **onzeker**. Verifieer die tegen de wiki of de
datapack-JSON van de jar (alleen lezen, nooit kopiëren) voordat je ze als spec gebruikt.

## 0. Uitgangspunt in de code

| Punt | Stand nu | Gevolg voor structuren |
|---|---|---|
| Wereld | 16×16×128, zeeniveau 62, biomes: ocean, beach, plains, forest, desert, taiga, snowy, mountains | Geen jungle, savanne, moeras, badlands: jungletempel, savannedorp, heksenhut en trail ruins in jungle vallen af |
| Generator | `TerrainGenerator.generate(cx, cz, blocks, biomes)`, deterministisch, in worker én server; bomen met `PAD = 3` | Structuren zijn groter dan 3 blokken: er is een aparte structuurpass nodig die stukken per chunk uitsnijdt (zie 1.1) |
| Meta | Gegenereerd terrein heeft `chunk.meta = null` (alles state 0) | Trappen, deuren, bedden, gekleurde wol in templates hebben meta nodig: de generator moet een **meta-array** kunnen teruggeven |
| Versie | `GEN_VERSION_CURRENT = 2` | Structuren veranderen het terrein: dat wordt **genVersion 3**; v2-werelden blijven zonder structuren |
| Kisten | `ContainerStore` (27 slots), opgeslagen in `WorldMeta.containers`, alleen singleplayer; lege kisten worden niet opgeslagen | Structuurkisten moeten "al geopend" kunnen onthouden, ook als ze leeg zijn |
| Mobs | zombie, skeleton, spider, creeper, 4 dieren; mobs worden niet opgeslagen | Villagers en golems moeten persistent worden (nieuw) |
| Ids | 182 bloktypes, hoogste id 185 (ca. 69 vrij); 223 van 255 textuurlagen | **Textuurlagen zijn de krapste grens**: 13 werkblokken × 2-3 lagen past niet. MVP: 5 werkblokken + bel + spawner + rail |
| Ontbreekt | XP, status-effecten, enchanting, minecarts, redstone, landbouw met groei, waterlogging | Bepaalt wat in loot/trades vervangen of geschrapt wordt |

## 1. Overworld-structuren

### 1.1 Gedeelde machinerie (in Minecraft en voor BunkCraft)

**Random spread.** De wereld is in regio's van `spacing × spacing` chunks verdeeld. Per regio kiest de RNG (wereldseed + regio-x/z + salt)
één startchunk op offset `[0, spacing − separation)` in x en z (lineair; monument en mansion gebruiken een driehoeksverdeling). Daarna moet
het biome op het startpunt kloppen, anders geen structuur in die regio. Mijnschachten gebruiken spacing 1 met een kans per chunk.

| Structuurset | Spacing | Separation | Salt | Opmerking |
|---|---|---|---|---|
| Villages | 34 | 8 | 10387312 | |
| Desert pyramid | 32 | 8 | 14357617 | |
| Jungle temple | 32 | 8 | 14357619 | |
| Igloo | 32 | 8 | 14357618 | |
| Swamp hut | 32 | 8 | 14357620 | |
| Pillager outpost | 32 | 8 | 165745296 | frequency 0,2; niet binnen 10 chunks van een dorp |
| Ruined portal | 40 | 15 | 34222645 | |
| Shipwreck | 24 | 4 | 165745295 | |
| Ocean ruins | 20 | 8 | 14357621 | |
| Trail ruins | 34 | 8 | 83469867 | |
| Trial chambers | 34 | 12 | 94251327 | |
| Ancient city | 24 | 8 | 20083232 | |
| Monument / mansion | 32/5, 80/20 | | 10387313 / 10387319 | driehoeksverdeling |
| Mineshaft | 1 | 0 | 0 | 0,4 % per chunk |
| Stronghold | ringen: distance 32, count 128, spread 3 | | | |

Dungeons (monster rooms) en de desert well zijn geen structuren maar **features**: ze worden per chunk geprobeerd, zonder spacing.

**Jigsaw.** Dorpen, outposts, trail ruins, ancient cities, bastions en trial chambers zijn jigsaw-structuren: een startstuk uit een
`start_pool`, daarna een wachtrij van open verbindingspunten ("jigsaw blocks"). Per punt worden stukken uit de doel-pool gewogen-willekeurig
geprobeerd (draaiing alleen horizontaal), met een fallback-pool (de "terminators", bijv. straat-eindes). Een stuk wordt geweigerd als het
buiten de buitenbox valt (`2 × max_distance_from_center + 1`, dorpen 80 → 161 blokken breed) of een ander stuk overlapt. Na `size` niveaus
diepte (dorp: 6) gebruikt het alleen nog de fallback. Stukken zijn "rigid" (één hoogte) of "terrain_matching" (straten volgen per kolom het
terrein). Daarna draaien processors (verwering, mos, gewas-variatie).

**BunkCraft-ontwerp: "jigsaw-lite" in eigen code.**

| Onderdeel | Voorstel |
|---|---|
| Plaatsing | `src/world/structures/Placement.ts`: `RandomSpread {spacing, separation, salt}`; `startFor(regionX, regionZ)` = pure functie van seed. Eigen salts mogen (de RNG is toch niet die van Minecraft, seeds komen niet overeen) |
| Layout | `layoutAt(start)` bouwt de lijst `PlacedPiece {template, x, y, z, rot, bbox}` volledig uit (seed + startchunk), met `heightAt`/`biomeAt` van de generator. LRU-cache per worker (layout is ~0,1-1 ms) |
| Uitsnijden | `generate(cx, cz)` vraagt alle starts in de regio's die de chunk kunnen raken (dorp: radius 80 blokken = 6 chunks marge) en schrijft alleen de blokken binnen de chunk. Zelfde idee als bomen over de chunkgrens, maar met grotere marge |
| Template | Eigen layouts in TypeScript (zie 2.6): lagen als tekst, een palet per teken, materiaal-rollen per biome. Geen NBT, geen Mojang-bestanden |
| Fundering | Onder een rigid stuk kolommen tot de grond vullen (aarde/zand/zandsteen per biome), erboven tot 3 blokken lucht vrijmaken |
| Uitvoer | `blocks`, nieuw `meta`, en een lijst **side-data**: `{kind:'loot', pos, table}`, `{kind:'spawner', pos, mob}`, `{kind:'entity', pos, type, data}` |
| Volgorde | Na terrein, grotten en ertsen, vóór vegetatie (geen bomen in huizen). Dungeons vóór ertsen zodat ze in steen landen |
| Tests | Golden hashes voor v3 naast v1/v2 in `tests/terrain.test.ts`; per template: palet compleet, rotatie 4× consistent, verbindingspunten op de rand |

**Loot zonder opslag bij generatie.** Minecraft zet in een structuurkist alleen `LootTable` + `LootTableSeed` en rolt bij de eerste opening.
BunkCraft doet hetzelfde: de generator meldt `loot` side-data, de kist zelf is een gewoon `CHEST`-blok. Bij openen vraagt de world aan de
generator (of een cache van side-data per chunk) of hier een ongerolde loot-kist staat; zo ja, rol met seed `hash(worldSeed, x, y, z, table)`
en sla de inhoud op in `ContainerStore`, met vlag `rolled`. Een geopende, geleegde kist moet bewaard blijven (nu worden lege containers niet
geserialiseerd: aanpassen of een aparte lijst `lootRolled` bijhouden). Breken van een ongeopende loot-kist rolt eerst en laat de inhoud vallen.
In multiplayer rolt alleen de server.

**Ontbrekende items in loot-tabellen.** Gewichten blijven exact; een item dat BunkCraft niet heeft wordt `empty` (geen item). Zo blijven de
kansen van de rest identiek aan vanilla. Tijdelijke vervangers alleen waar een tabel anders leeg wordt (genoemd per tabel).

### 1.2 Dungeon (monster room)

| Aspect | Minecraft |
|---|---|
| Wat | Kamer van cobble met 75 % mossy-vloer, 1 spawner in het midden, 0-2 kisten tegen de muur |
| Maat | binnenruimte 7 of 9 breed/lang (onafhankelijk), 6 hoog incl. vloer en plafond |
| Generatie | Feature: 14 pogingen per chunk (10 boven y 0, 4 in deepslate). Vloer en plafond moeten volledig solide zijn, de muren moeten **1-5 openingen** (2 hoog lucht) op vloerhoogte hebben: dungeons hangen altijd aan een grot |
| Kisten | 2 kisten, elk 3 pogingen: plek moet leeg zijn en precies 1 solide buur hebben (dus tegen een muur) |
| Spawner | zombie 50 %, skeleton 25 %, spider 25 %. Activeert bij speler < 16 blokken, spawnt 4 mobs per cyclus in een 9×3×9-volume, wacht 200-799 ticks, max 6 gelijke mobs in de buurt, lichtregels van de mob |

Loot (`simple_dungeon`, gewicht en aantal):

| Pool | Rolls | Items (gewicht, aantal) |
|---|---|---|
| 1 (totaal 144) | 1-3 | leather 20 (1-5), name tag 20, golden apple 15, music disc 13 15, disc cat 15, iron horse armor 15, copper horse armor 15, golden horse armor 10, enchanted book 10, diamond horse armor 5, enchanted golden apple 2, disc otherside 2 |
| 2 (totaal 125) | 1-4 | bread 20, wheat 20 (1-4), redstone 15 (1-4), coal 15 (1-4), iron ingot 10 (1-4), bucket 10, melon/pumpkin/beetroot seeds 10 elk (2-4), gold ingot 5 (1-4) |
| 3 (totaal 40) | 3 | bone, gunpowder, rotten flesh, string: elk 10 (1-8) |

**BunkCraft.** Pogingen: 8 per chunk op y 8-56 (onze 128-hoge wereld, alleen in steen; aantal tunen tot ca. 1 dungeon per 3-4 chunks met
grot, **onzeker**). De openingen-regel maakt dat dungeons alleen bij v2-grotten verschijnen, dus de grotpass moet eerst lopen. Nieuw blok
`SPAWNER` (1 id, 1 textuurlaag, kooi-model als `box` of alpha-test-kubus); **mob-type in `meta`** (0 zombie, 1 skeleton, 2 spider,
3 cave spider), dus geen opgeslagen block entity nodig: de wachttimer is runtime-state (bij laden opnieuw 200-799). Spawner-logica draait in
de tick van `EntityManager` (singleplayer) en `ServerWorld` (multiplayer), alleen voor spawners in geladen chunks binnen 16 blokken van een
speler. Loot-ontbrekers: name tag, horse armor, discs, enchanted book, beetroot seeds worden `empty`. Breken: geen drop (vanilla: XP 15-43).
Moeite **S-M**. Afhankelijk van: structuurframework (meta, side-data), loot-tabellen.

### 1.3 Mijnschacht

| Aspect | Minecraft |
|---|---|
| Generatie | Elk overworld-biome behalve deep dark, 0,4 % per chunk; badlands-variant aan de oppervlakte met dark oak |
| Startkamer | 10×10 (variabel, **onzeker**), 6 hoog, gewelfd plafond, 1-4 uitgangen per zijde, vloer van aarde |
| Stukken | gang (corridor), kruising (crossing, 5×5, soms dubbel verdiept), trap (diagonale tunnel zonder trapblokken), startkamer |
| Grammatica | per open einde: 70 % gang, 10 % trap, 20 % kruising; maximale diepte 8 stukken; niets verder dan 80 blokken van de start (**onzeker**, uit decompilatie-kennis) |
| Gang | 3 breed, 3 hoog, lengte 2-4 secties van 5 blokken (**onzeker**). Elke sectie: steunbalk = 2 hekken + plank-bovenligger. Ontbrekende planken, fakkels, spinnenwebben bij het plafond |
| Rails | 1 op 3 gangen heeft rails (onvolledig); kist-minecarts komen alleen op rails voor (ca. 1 % per sectie per zijde, **onzeker**) |
| Spinnengang | gang zonder rails met kans ca. 1/23 (**onzeker**): vol spinnenweb rond een cave-spider-spawner |
| Over lucht | bruggen van planken, met logs eronder of kettingen erboven; tegen aquifers een barrière van blokken |

Loot (`abandoned_mineshaft`):

| Pool | Rolls | Items |
|---|---|---|
| 1 (71) | 1 | name tag 30, golden apple 20, enchanted book 10, iron pickaxe 5, empty 5, enchanted golden apple 1 |
| 2 (98) | 2-4 | bread 15 (1-3), glow berries 15 (3-6), iron ingot 10 (1-5), coal 10 (3-8), melon/pumpkin/beetroot seeds 10 (2-4), gold ingot 5 (1-3), redstone 5 (4-9), lapis 5 (4-9), diamond 3 (1-2) |
| 3 (50) | 3 | rail 20 (4-8), torch 15 (1-16), powered/detector/activator rail 5 elk (1-4) |

**BunkCraft.** Stukken als code-generatoren (geen templates: het zijn parametrische tunnels), met dezelfde wachtrij als jigsaw-lite. Start
y 12-48. Nieuw blok `RAIL` (1 id, 2 lagen recht/bocht, vorm in meta; puur decor tot minecarts bestaan). **Afwijking:** zonder minecart-entity
komt de kist als `CHEST`-blok in een nis naast de rails (gedocumenteerd). Cave spider ontbreekt: eerst spider-spawner, later cave spider
(spider op schaal 0,7 met gif zodra effecten bestaan). Moeite **M**. Afhankelijk van: framework, loot, spawner, rail.

### 1.4 Woestijnpiramide en desert well

| Aspect | Minecraft |
|---|---|
| Biome | desert (spacing 32/8) |
| Vorm | 21×21 grondvlak, zandsteen in alle varianten, oranje en blauwe terracotta (ankh-motief op de torens), zandsteen-trappen en -slabs; ingang voor, twee ingangen achter boven, raam in de top |
| Schat | onder het blauwe terracotta-blok in het midden: schacht naar een kamer met **4 kisten** en een stone pressure plate boven **9 TNT** |
| Kelder | 5×5-kamer met 6-8 suspicious sand (archeologie) |
| Mobs | geen eigen (husks spawnen in de woestijn) |

Loot (`desert_pyramid`, per kist): pool 1 (247, 2-4 rolls): bone 25 (4-6), spider eye 25 (1-3), rotten flesh 25 (3-7), leather 20 (1-5),
enchanted book 20, golden apple 20, iron ingot 15 (1-5), gold ingot 15 (2-7), emerald 15 (1-3), iron/copper horse armor 15, golden horse
armor 10, empty 15, diamond 5 (1-3), diamond horse armor 5, enchanted golden apple 2. Pool 2 (50, 4 rolls): bone, gunpowder, rotten flesh,
string, sand elk 10 (1-8). Pool 3: dune armor trim 1/7.

**Desert well** (feature, ca. 1 op 500 woestijnchunks, **onzeker**): 5×5 zandsteen met water en een overkapping. Een template van 30 regels.

**BunkCraft.** Eén vaste template (zandsteenvarianten en terracotta bestaan al via meta). TNT bestaat; pressure plate ontbreekt: nieuw blok
`STONE_PRESSURE_PLATE` (1 id, hergebruikt de smooth-stone-laag) dat TNT in een 3×3 onder zich ontsteekt (geen redstone nodig: een vaste
koppeling "plaat triggert TNT binnen 2 blokken eronder"). Kelder zonder suspicious sand tot archeologie bestaat. Moeite **S** (well) en **S-M**
(piramide). Afhankelijk van: framework, loot.

### 1.5 Jungletempel

Cobble, mossy cobble en vines; 3 verdiepingen; hendelpuzzel (3 levers, pistons) met een verborgen kist; tripwire-gang met 2 dispensers
(2-7 pijlen per stack). Loot: pool 1 (89, 2-6 rolls) bone 20 (4-6), rotten flesh 16 (3-7), gold ingot 15 (2-7), bamboo 15, iron ingot 10 (1-5),
diamond 3 (1-3), leather 3, emerald 2 (1-3), horse armor ×4 en enchanted book 1 elk; wild armor trim 1/3.
**BunkCraft: overslaan** tot er een jungle-biome is; de puzzel vraagt redstone. Later **M**.

### 1.6 Iglo

| Aspect | Minecraft |
|---|---|
| Biome | snowy plains, snowy taiga, zelden snowy slopes (32/8) |
| Bovenkant | 94 snow blocks, wit en lichtgrijs tapijt, rood bed, oven, werkbank, 2 ijsramen, redstone torch |
| Kelder | 50 %: luik onder het 3e tapijt, ladderschacht van stone bricks (deels infested), kelder met brouwstandaard (splash weakness), cauldron, kist, en twee cellen met een villager en een zombie villager (cleric) |

Loot (`igloo_chest`): pool 1 (63, 2-8 rolls) apple 15 (1-3), coal 15 (1-4), gold nugget 10 (1-3), rotten flesh 10, wheat 10 (2-3), stone axe 2,
emerald 1; pool 2: altijd 1 golden apple. **BunkCraft:** de bovenkant kan nu al (snow block, ijs, tapijt, bed, oven bestaan); kelder met ladder
en kist ook, de cellen pas met villagers. Moeite **S**. Afhankelijk van: framework, loot; kelder-mobs na villagers.

### 1.7 Ruined portal

Obsidian- en crying-obsidian-portaalresten met goudblokken, netherrack- en magmaveld, 10 normale en 3 grote varianten, per biome ondergronds/
half begraven/oppervlak, mossigheid 0,2-0,8. Loot (`ruined_portal`, 4-8 rolls, 398): obsidian, flint, iron nugget (9-18), flint and steel, fire
charge elk 40; golden apple, gold nugget (4-24), 9 enchanted golden tools/armor elk 15; o.a. golden carrot en gold ingot 5; enchanted golden
apple, bell, gold block 1. **BunkCraft: overslaan.** Netherrack, magma en crying obsidian staan op de "nooit"-lijst (Nether); zonder Nether
is het een raadsel zonder betekenis. Eventueel later als decoratieve ruïne zonder netherrack (**S**).

### 1.8 Shipwreck en ocean ruins

| | Shipwreck | Ocean ruins |
|---|---|---|
| Plaatsing | 24/4; oceanen, soms beach (dan "beached", boven water) | 20/8; koude (stone bricks) en warme (zandsteen) variant |
| Vorm | Rechtop, op de zij of ondersteboven; vaak boeg, achtersteven of mast weg. 2 houtsoorten per schip | Kleine (ca. 5×5-8×8) en grote ruïnes, grote vaak in clusters (**onzeker**: 30 % groot, 90 % kans op cluster) |
| Kisten | max 3: map chest (boeg), supply en treasure (achtersteven) | 1 kist (klein: `underwater_ruin_small`, groot: `_big`) |
| Mobs | geen | drowned |

Loot, de drie shipwreck-kisten: **supply** (3-10 rolls, 84): suspicious stew 10, paper 8 (1-12), potato, moss, poisonous potato, carrot,
wheat (8-21) elk 7, coal 6 (2-8), rotten flesh 5 (5-24), gunpowder 3, 4 leather armor stukken 3, bamboo en pumpkin 2, TNT 1.
**Treasure**: pool 1 (3-6 rolls, 150) iron ingot 90 (1-5), emerald 40 (1-5), gold ingot 10, diamond 5, bottle o' enchanting 5; pool 2 (2-5 rolls, 80)
iron nugget 50 (1-10), lapis 20 (1-10), gold nugget 10 (1-10). **Map**: buried treasure map 1×; 3 rolls paper 20 (1-10), feather 10 (1-5),
book 5 (1-5), compass/empty map/clock 1. Alle drie: coast armor trim 1/6 en (sinds 2025) nautilus armor 37/185.
Ocean ruin small: 2-8 rolls coal 10 (1-4), wheat 10 (2-3), rotten flesh 5, stone axe 2, stone spear 2, emerald 1; plus 1 roll uit enchanted
fishing rod 5, buried treasure map 5, leather tunic 1, golden helmet 1.

**BunkCraft.** Het grote probleem is **waterlogging**: trappen, slabs, hekken en luiken onder water worden in BunkCraft luchtzakken. Opties:
(a) alleen volle blokken in onderwatertemplates (planken, logs) en open plekken met water vullen; (b) eerst waterlogging als 1 metabit
(**M**, raakt mesher en vloeistoffen). Advies: (a) voor de MVP-schepen. Moeite **M** (3-4 schipdelen × 3 oriëntaties programmatisch
roteren/kantelen), ocean ruins **S-M**. Drowned ontbreekt: zombies in water als tijdelijke vervanging is niet nodig, gewoon geen mobs.

### 1.9 Pillager outpost

4 verdiepingen hoge toren van dark oak, birch en cobble met 1 kist bovenin; tot 4 bijstukken (kooi met iron golem, tenten, logstapel,
schietschijven); pillagers met een captain; niet binnen 10 chunks van een dorp; biomes = dorpbiomes + bergen. Loot: crossbow 0-1, wheat
(3-5)/potato/carrot 2-3 rolls, dark oak log 1-3 rolls (2-3), bottle o' enchanting 7, string 4, arrow 4 (2-7), tripwire hook 3, iron ingot 3,
enchanted book 1, goat horn 0-1, sentry trim 1/4. **BunkCraft: na dorpen**, samen met pillager (crossbow-AI) en de start van raids. **M**.

### 1.10 Trail ruins

Grotendeels begraven ruïne (taiga, snowy taiga, old growth, jungle) met een toren van (geglazuurde) terracotta, wegen van cobble/stone bricks,
gevuld met grind, aarde en **suspicious gravel**; geen kisten, de beloning is archeologie (scherven, trims). Jigsaw met ca. 60 stukken.
**BunkCraft: later**, na archeologie (borstel + suspicious-blokken, **M**). De structuur zelf is dan **M**.

### 1.11 Stronghold en trial chambers

| | Waarom overslaan |
|---|---|
| Stronghold | Bestaat om het End-portaal; geen End, geen eyes of ender. Bibliotheek-loot is enchanted books. Pas zinvol met een eindbaas-plan |
| Trial chambers | Liggen op y −40 tot −20 en zijn ca. 40-60 blokken hoog (**onzeker**); passen in 128 hoogte alleen op y 5-50, dus ze zouden het grottenstelsel opeten. Vragen trial spawner, vault, trial key, breeze, wind charge, mace: **XL** |

## 2. Dorpen en villagers

### 2.1 Dorpgeneratie in Minecraft

| Aspect | Waarde |
|---|---|
| Biomes en stijlen | plains (plains, meadow), desert, savanna, taiga, snowy (snowy plains). Stijl bepaald door het biome op het startpunt |
| Plaatsing | random spread 34/8, salt 10387312; ca. 50 % kans op een dorp binnen 500 blokken van spawn |
| Jigsaw | start-pool = dorpskern (plains: fountain + 3 meeting points; desert: 3 meeting points), `size` 6, `max_distance_from_center` 80 (**onzeker**: waarden uit eerdere kennis) |
| Pools per stijl | `town_centers` → `streets` (recht, bocht, kruising, lang; terrain-matching) → `houses` (huizen, werkplaatsen, boerderijen, dierenhokken; fallback `terminators`) → `decor` (lantaarnpalen, hooi, bomen) → `villagers`/`animals` |
| Huizen plains | small house 1-8, medium house 1-2, big house, butcher shop 1-2, tool smith, fletcher, shepherd, armorer, fisher cottage, tannery, cartographer, library 1-2, mason, weaponsmith, temple 3-4, farm 1-2, large farm, animal pen 1-3, stable, accessory (lijst uit de jar-mapstructuur; gewichten **onzeker**) |
| Paden | plains/taiga/snowy: dirt path; desert: smooth sandstone; boven water planken van de stijl |
| Fundering | onder overhangende delen een vierkant platform van gras/zand/steen |
| Bewoners | villagers alleen in huizen met bedden (1 per bed), 1 iron golem bij de kern, dieren in hokken, desert: 1 kameel |
| Verlaten | 2 %: zombie villagers, geen deuren/fakkels, mossy cobble, spinnenweb, bruin glas |
| Dorpsdefinitie (Java) | geen vaste grens: elke subchunk met een geclaimd bed, bel of werkblok plus de 26 buur-subchunks |

Kist-loot in dorpen (voorbeelden): **plains house** 3-8 rolls (43): potato 10 (1-7), bread 10 (1-4), apple 10 (1-5), oak sapling 5 (1-2),
emerald 2 (1-4), dandelion 2, poppy, book, feather, gold nugget 1. **Desert house** 3-8 rolls (36): cactus 10 (1-4), wheat 10 (1-7), bread 10, dead bush 2,
clay ball, green dye, book, emerald (1-3) 1. **Weaponsmith** 3-8 rolls (107): bread en apple 15, iron ingot 10 (1-5), iron pickaxe/sword/armor 5 elk,
obsidian 5 (3-7), oak sapling 5 (3-7), gold ingot 5, diamond 3 (1-3). **Toolsmith** 3-8 rolls (53): stick 20, bread 15, iron ingot/pickaxe/shovel 5,
diamond, gold, coal 1. **Armorer** 1-5 rolls (8): bread 4 (1-4), iron ingot 2 (1-3), iron helmet 1, emerald 1. **Butcher** 1-5 rolls (28):
porkchop, wheat, beef, mutton elk 6 (1-3), coal 3, emerald 1. **Fletcher** 1-5 (23): feather, flint, stick elk 6, arrow 2, egg 2, emerald 1.
**Mason** 1-5 (13): stone 2, stone bricks 2, bread 4, clay ball, flower pot, yellow dye, smooth stone, emerald 1. **Temple** 3-8 (19): bread 7,
rotten flesh 7, redstone 2, lapis, gold ingot, emerald 1 (1-4).

### 2.2 Villager-AI (Java)

| Onderdeel | Minecraft | BunkCraft-vereenvoudiging |
|---|---|---|
| Stats | 20 HP, snelheid 0,5, past door 1-brede deur | Zelfde; box-model (hoofd met neus, armen gekruist, robe) |
| Rooster | 10 wander; 2000-9000 work (baby's: play); 9000-11000 gather (bij de bel); 11000 wander/naar huis; 12000-24000 sleep | Zelfde tijden op de 20 Hz-tick: `schedule(time) → 'work' / 'wander' / 'gather' / 'home' / 'sleep'` |
| POI's | bed, werkblok, bel. Werkloze claimt het dichtstbijzijnde vrije werkblok binnen 48 blokken; claim definitief op ≤ 2 blokken; voorlopige claim vervalt na 60 s | POI-index per chunk (bedden, werkblokken, bellen), bijgewerkt in `World.onEdit`; claim-map `pos → villagerId` |
| Werken | bij het werkblok staan; 2× per dag restock (alleen als het werkblok bereikt is) | Zelfde; restock = `uses = 0` + demand-update |
| Slapen | ligt in bed (pootje = kussenblok), wordt wakker bij duwen, slaan, bel | Liggend model op het bed, geen pathfinding 's nachts |
| Paniek | rent weg bij zombies en na schade | Hergebruik flee-goal van dieren |
| Beroep kwijt | alleen novice zonder trade verliest beroep als het werkblok weg is | Zelfde regel |
| Pathfinding | A* met deuren openen | **Eerste echte A*-pathfinder** nodig (nu lopen mobs naar doel met stap-omhoog). Deuren openen = `meta`-bit flippen. Bereik 48 blokken, maximaal 1 padberekening per villager per seconde, verspreid over ticks (geen allocaties per frame: hergebruikte buffers) |

**Gossip** (reputatie per speler, per villager):

| Bron | Type | Winst | Verval per 20 min | Deel-kosten | Max | Multiplier |
|---|---|---|---|---|---|---|
| Elke trade | trading | 4 | 2 | 20 | 25 | 1 |
| Genezen | major_positive | 20 | 0 (permanent) | 100 (nooit gedeeld) | 20 | 5 |
| Genezen | minor_positive | 25 | 1 | 5 | 25 | 1 |
| Aanvallen | minor_negative | 25 | 20 | 20 | 200 | −1 |
| Villager doden in de buurt | major_negative | 25 | 10 | 10 | 100 | −5 |

Reputatie = Σ waarde × multiplier. Golems worden vijandig bij reputatie ≤ −100. **BunkCraft-vereenvoudiging:** geen delen tussen villagers
in de MVP (dat is het "gossip"-deel); wel de vijf types per villager en het verval. Later: delen als twee villagers bij de bel staan.

**Fokken.** Villager is "willing" bij ≥ 12 voedingspunten in de inventory (brood 4, wortel/aardappel/biet 1): dus 3 brood of 12 wortels.
Twee willing villagers die elkaar ontmoeten (niet tijdens werktijd) maken een baby als er een **vrij, bereikbaar bed** is binnen 48 blokken; daarna
5 minuten cooldown. Baby wordt na 20 minuten volwassen. Villagers rapen brood/wortels/aardappels/bieten/tarwe op; boeren delen eten.
BunkCraft: eten oprapen hergebruikt `ItemEntity`-pickup; boer-oogsten pas met landbouw (groeifases). MVP: fokken op brood dat de speler gooit.

**Iron golem.** 100 HP, snelheid 0,25, terugslag-immuun, schade Normal 7,5-21,5 (**onzeker**, wiki-infobox), gooit doelwit omhoog.
Ontstaat (a) 1× bij dorpsgeneratie, (b) door villagers: 5 villagers die samen roddelen en recent sliepen, of 3 in paniek, zonder golem binnen
16 blokken, cooldown 30 s; (c) door de speler (4 ijzerblokken in T + carved pumpkin, onvijandig voor de bouwer). Drop: 3-5 ijzer, 0-2 papavers.
Ijzer-ingot op een golem herstelt 25 HP. Valt hostile mobs aan (niet creepers).

**Genezen.** Zombie villager + Weakness + golden apple → na 3-5 minuten villager (sneller met bedden/ijzeren tralies in de buurt), met
reputatie major_positive 20 + minor_positive 25 = **125** voor de genezer. Vereist status-effecten en zombie villagers: **buiten MVP**, maar
het datamodel (gossip-types) houdt er rekening mee.

**Raids:** buiten scope (vereist pillager, vindicator, evoker, ravager, Bad Omen, golven per moeilijkheid). Pas na outposts.

### 2.3 Trading-mechaniek

| Regel | Waarde |
|---|---|
| Niveaus | Novice 0, Apprentice 10, Journeyman 70, Expert 150, Master 250 villager-XP |
| Aanbod | per niveau 2 trades (willekeurig gekozen als de pool groter is, Java); max 10 trades. Vergrendeld na de eerste trade |
| Voorraad | per trade `maxUses` (meestal 12 of 16, enchanted gear 3); 2× per dag restock aan het werkblok |
| Speler-XP | 3-6 per trade, +5 bij level-up van de villager (BunkCraft: pas als XP bestaat) |
| Level-up | 10 s Regeneration I voor de villager, groene deeltjes |
| Prijs | alleen het eerste item verandert, begrensd op 1..stapelgrootte |

Prijsformule (Java): `prijs = clamp( floor(p × (1 + m × max(0, d))) − floor(m × r) − held, 1, stack )`, met `p` basisprijs, `m` price
multiplier (0,05 voor grondstoffen, 0,2 voor gereedschap/harnas), `d` demand, `r` reputatie, `held` = Hero of the Village-korting
(`max(1, floor(p × (0,3 + 0,0625 × (level − 1))))`). **Demand** start op 0 (**onzeker**: de wiki noemt een negatieve beginwaarde) en wordt bij elke restock `d = d + 2 × uses − maxUses`
(veel kopen → duurder, weinig → zakt terug). Voorbeeld genezen: 20 tarwe → `floor(0,05 × 125) = 6` korting = 14 tarwe; een ijzeren
borstplaat 9 emerald met m 0,2 → `floor(0,2 × 125) = 25` korting → 1 emerald.

### 2.4 Trade-tabellen (Java, volledig)

Notatie: `wil → geeft`, `[voorraad, villager-XP, multiplier]`. "2 van N" = 2 willekeurige uit N. Items die BunkCraft niet heeft zijn
*cursief*; die trades vallen in de MVP weg (of worden vervangen, zie 2.5).

| Beroep (werkblok) | Niveau | Trades |
|---|---|---|
| **Armorer** (blast furnace) | 1 (2 van 5) | 15 kool → 1 em [16,2,0.05]; 5 em → ijzeren helm, 9 em → borstplaat, 7 em → broek, 4 em → laarzen [12,1,0.2] |
| | 2 (2 van 4) | 4 ijzer → 1 em [12,10,0.05]; 36 em → *bel*; 3 em → maliënbroek; 1 em → maliënlaarzen [12,5,0.2] |
| | 3 (2 van 5) | 1 lavaemmer → 1 em; 1 diamant → 1 em [12,20,0.05]; 1 em → maliënhelm; 4 em → maliënborstplaat; 5 em → *schild* [12,10,0.2] |
| | 4 | 19-33 em → *enchanted* diamanten broek; 13-27 em → *enchanted* diamanten laarzen [3,15,0.2] |
| | 5 | 13-27 em → *enchanted* diamanten helm; 21-35 em → *enchanted* diamanten borstplaat [3,30,0.2] |
| **Butcher** (smoker) | 1 (2 van 4) | 14 rauwe kip, 4 rauw konijn, 7 rauw varkensvlees → 1 em [16,2]; 1 em → *rabbit stew* [12,1] |
| | 2 (2 van 3) | 15 kool → 1 em [16,2]; 1 em → 8 gebakken kip, 1 em → 5 gebakken varkensvlees [16,5] |
| | 3 | 10 rauw rundvlees → 1 em; 7 rauw schapenvlees → 1 em [16,20] |
| | 4 | 10 *dried kelp block* → 1 em [12,30] |
| | 5 | 10 zoete bessen → 1 em [12,30] (alle 0.05) |
| **Cartographer** (cartography table) | 1 | 24 papier → 1 em [12,2]; 7 em → *lege kaart* [12,1] |
| | 2 | 11 glasruit → 1 em [12,10]; 8 em + *kompas* → *dorpskaart* [12,5,0.2] |
| | 3 (2 van 3) | *kompas* → 1 em [12,10]; 13 em + kompas → *monumentkaart*; 12 em + kompas → *trial-chamberkaart* [12,10,0.2] |
| | 4 | 7 em → *item frame*; 3 em → *banner* [12,15] |
| | 5 | 8 em → *globe banner pattern* [12,30]; 14 em + kompas → *mansion-kaart* [12,30,0.2] |
| **Cleric** (brewing stand) | 1 | 32 rotten flesh → 1 em [16,2]; 1 em → 2 redstone [12,1] |
| | 2 | 3 goud → 1 em [12,10]; 1 em → 1 lapis [12,5] |
| | 3 | 2 *rabbit's foot* → 1 em [12,20]; 4 em → 1 glowstone [12,10] |
| | 4 (2 van 3) | 4 *turtle scute* → 1 em, 9 *glass bottle* → 1 em [12,30]; 5 em → *ender pearl* [12,15] |
| | 5 | 22 *nether wart* → 1 em; 3 em → *bottle o' enchanting* [12,30] |
| **Farmer** (composter) | 1 (2 van 5) | 20 tarwe, 26 aardappel, 22 wortel, 15 biet → 1 em [16,2]; 1 em → 6 brood [16,1] |
| | 2 (2 van 3) | 6 pompoen → 1 em [12,10]; 1 em → 4 pompoentaart [12,5]; 1 em → 4 appels [16,5] |
| | 3 | 4 meloen → 1 em [12,20]; 3 em → 18 koekjes [12,10] |
| | 4 | 1 em → *suspicious stew*; 1 em → *cake* [12,15] |
| | 5 | 3 em → 3 gouden wortels; 4 em → 3 *glistering melon* [12,30] (alle 0.05) |
| **Fisherman** (barrel) | 1 (2 van 4) | 20 touw → 1 em; 10 kool → 1 em [16,2]; 3 em → *emmer kabeljauw*; 6 rauwe kabeljauw + 1 em → 6 gebakken [16,1] |
| | 2 (2 van 3) | 15 rauwe kabeljauw → 1 em [16,10]; 2 em → *kampvuur* [12,5]; 6 rauwe zalm + 1 em → 6 gebakken [16,5] |
| | 3 | 13 rauwe zalm → 1 em [16,20]; 8-22 em → *enchanted hengel* [3,10,0.2] |
| | 4 | 6 *tropische vis* → 1 em [12,30] |
| | 5 | 4 *pufferfish* → 1 em; 1 *boot* (hout per biome) → 1 em [12,30] |
| **Fletcher** (fletching table) | 1 (2 van 3) | 32 stokken → 1 em [16,2]; 1 em → 16 pijlen [12,1]; 10 grind + 1 em → 10 vuursteen [12,1] |
| | 2 | 26 vuursteen → 1 em [12,10]; 2 em → boog [12,5] |
| | 3 | 14 touw → 1 em [16,20]; 3 em → *kruisboog* [12,10] |
| | 4 | 24 veren → 1 em [16,30]; 7-21 em → *enchanted* boog [3,15] |
| | 5 (2 van 3) | 8 *tripwire hook* → 1 em [12,30]; 8-22 em → *enchanted kruisboog* [3,15]; 2 em + 5 pijlen → 5 *tipped arrows* [12,30] |
| **Leatherworker** (cauldron) | 1 (2 van 3) | 6 leer → 1 em [16,2]; 3 em → leren broek; 7 em → leren tuniek [12,1,0.2] |
| | 2 (2 van 3) | 26 vuursteen → 1 em [12,10]; 5 em → leren kap; 4 em → leren laarzen [12,5,0.2] |
| | 3 | 9 *rabbit hide* → 1 em [12,20]; 7 em → leren tuniek (geverfd) [12,10,0.2] |
| | 4 | 4 *turtle scute* → 1 em [12,30]; 6 em → *leather horse armor* [12,15,0.2] |
| | 5 | 5 em → leren kap (geverfd); 6 em → *zadel* [12,30,0.2] |
| **Librarian** (lectern) | 1 (2 van 3) | 24 papier → 1 em [16,2]; 9 em → boekenkast [12,1]; 5-64 em + boek → *enchanted book* [12,1,0.2] |
| | 2 (2 van 3) | 4 boeken → 1 em [12,10]; 1 em → lantaarn [12,5]; *enchanted book* [12,5,0.2] |
| | 3 (2 van 3) | 5 inktzakken → 1 em [12,20]; 1 em → 4 glas [12,10]; *enchanted book* [12,10,0.2] |
| | 4 (2 van 4) | *book and quill* → 1 em [12,30]; 4 em → *kompas*; 5 em → *klok* [12,15]; *enchanted book* [12,15,0.2] |
| | 5 | 3 em → *kaars* (rood of geel) [12,30] |
| **Mason** (stonecutter) | 1 | 10 klei → 1 em [16,2]; 1 em → 10 baksteen [16,1] |
| | 2 | 20 steen → 1 em [16,10]; 1 em → 4 chiseled stone bricks [16,5] |
| | 3 (2 van 7) | 16 graniet / andesiet / dioriet → 1 em [16,20]; 1 em → 4 *dripstone* / 4 gepolijst andesiet / dioriet / graniet [16,10] |
| | 4 (2 van 3) | 12 *nether quartz* → 1 em [12,30]; 1 em → 1 terracotta (willekeurige kleur); 1 em → 1 geglazuurde terracotta [12,15] |
| | 5 | 1 em → *quartz pillar*; 1 em → *quartz block* [12,30] |
| **Shepherd** (loom) | 1 (2 van 5) | 18 wol (wit/bruin/zwart/grijs) → 1 em [16,2]; 2 em → schaar [12,1] |
| | 2 (2 van 7) | 12 kleurstof (wit/grijs/zwart/lichtblauw/lime) → 1 em [16,10]; 1 em → 1 wol (kleur); 1 em → 4 tapijt (kleur) [16,5] |
| | 3 (2 van 6) | 12 kleurstof (geel/lichtgrijs/oranje/rood/roze) → 1 em [16,20]; 3 em → bed (kleur) [12,10] |
| | 4 (2 van 7) | 12 kleurstof (bruin/paars/blauw/groen/magenta/cyaan) → 1 em [16,30]; 3 em → *banner* [12,15] |
| | 5 | 2 em → 3 *schilderijen* [12,30] |
| **Toolsmith** (smithing table) | 1 (2 van 5) | 15 kool → 1 em [16,2]; 1 em → stenen bijl / schep / houweel / schoffel [12,1,0.2] |
| | 2 | 4 ijzer → 1 em [12,10]; 36 em → *bel* [12,5,0.2] |
| | 3 (2 van 5) | 30 vuursteen → 1 em [12,20]; 6-20 / 7-21 / 8-22 em → *enchanted* ijzeren bijl / schep / houweel; 4 em → diamanten schoffel [3,10,0.2] |
| | 4 (2 van 3) | 1 diamant → 1 em [12,30]; 17-31 em → *enchanted* diamanten bijl; 10-24 em → *enchanted* diamanten schep [3,15,0.2] |
| | 5 | 18-32 em → *enchanted* diamanten houweel [3,30,0.2] |
| **Weaponsmith** (grindstone) | 1 (2 van 3) | 15 kool → 1 em [16,2]; 3 em → ijzeren bijl [12,1,0.2]; 7-21 em → *enchanted* ijzeren zwaard [3,1] |
| | 2 | 4 ijzer → 1 em [12,10]; 36 em → *bel* [12,5,0.2] |
| | 3 | 24 vuursteen → 1 em [12,20] |
| | 4 | 1 diamant → 1 em [12,30]; 17-31 em → *enchanted* diamanten bijl [3,15,0.2] |
| | 5 | 13-27 em → *enchanted* diamanten zwaard [3,30,0.2] |

Zonder multiplier vermeld = 0.05. Enchanted-prijzen in Java = basisprijs + enchant-level (bij boeken 2 + 3×level + rand, verdubbeld voor
treasure; tabel op de wiki). Nitwit en werkloze villager traden niet; de wandering trader is een apart systeem (buiten scope).

### 2.5 MVP-scope voor BunkCraft

**Doel:** een speler vindt binnen 500-1000 blokken een levend dorp, ruilt met emeralds en ziet villagers een dagritme volgen. Multiplayer
server-autoritatief vanaf dag 1.

| In de MVP | Bewust niet |
|---|---|
| Plains- en desertdorpen (stijl via palet, 1 set layouts) | Savanna, taiga, snowy (wel voorbereid via palet-rollen) |
| 6 huistemplates + 5 werkplaatsen + kern met bel + put + 2 straattypes + boerderij (decoratief) + lantaarnpaal | Tempels, stallen, dierenhokken met dieren (eerst varkens/schapen hergebruiken mag) |
| Villager-entity: werkloos, 5 beroepen, baby, nitwit; 5 niveaus; dagritme, bed, werkblok | Gossip delen, boeren die oogsten, kat, wandering trader |
| Trades: Farmer, Butcher, Armorer, Fletcher, Mason | Librarian, Toolsmith, Weaponsmith, Cleric (wachten op enchanting/effecten); Cartographer (kaarten) |
| Prijs met demand en reputatie (trading-gossip, aanval/dood negatief) | Genezen, Hero of the Village, raids |
| Fokken op brood/wortels/aardappels met bedden-limiet | Voedsel delen tussen villagers |
| Iron golem: 1 bij generatie + spelergebouwd, verdedigt tegen hostiles | Golem-spawning door roddelende villagers (fase 2) |

**Gekozen beroepen en hun MVP-trades** (de rest van 2.4 staat in data maar met `enabled: false` tot het item bestaat):

| Beroep | Werkblok (nieuw) | Wegvallend in MVP | Vervanging |
|---|---|---|---|
| Farmer | composter | suspicious stew, cake, glistering melon | geen: expert/master krijgen alleen de bestaande trades (gouden wortel) |
| Butcher | smoker | rabbit stew, dried kelp block | expert-trade 10 dried kelp block → eigen vervanging 12 gebakken kabeljauw → 1 em (gemarkeerd), anders heeft expert geen trade |
| Armorer | blast furnace | bel, schild, enchanted diamond | enchanted → gewone diamanten stukken tegen de **ondergrens** van de prijs (19, 13, 13, 21 em), tot enchanting bestaat |
| Fletcher | fletching table | kruisboog, tripwire hook, tipped arrows | enchanted boog → gewone boog 7 em |
| Mason | stonecutter | dripstone, quartz | quartz-trades → `empty`; master: 1 em → 4 smooth stone (eigen vervanging, gemarkeerd) |

Nieuwe blokken MVP: composter, smoker, blast furnace, fletching table, stonecutter, bell = **6 ids, ca. 14 textuurlagen** (bovenkant,
zijkant, voorkant), plus spawner en rail uit hoofdstuk 1 (3 lagen). Totaal ca. 17 van de 32 vrije lagen: dat moet in een budgettabel in
`docs/CONTENT.md`. Smoker en blast furnace worden later echte ovens (2× snelheid); in de MVP zijn ze werkblok + oven-station.

### 2.6 Dataformaten

**Template** (`src/world/structures/templates/*.ts`, eigen ontwerpen, geen kopie van vanilla-layouts):

```ts
export const SMALL_HOUSE_1: Template = {
  id: 'village/small_house_1',
  size: [7, 6, 7],                       // x, y, z; y = 0 is de vloer op padhoogte
  palette: {                             // teken → materiaalrol of vast blok
    '#': 'WALL', 'P': 'PLANKS', 'L': 'LOG_Y', 'r': 'ROOF_STAIRS_N', 'd': 'DOOR_S', 'g': 'GLASS_PANE',
    'b': { block: 'bed', state: { facing: 'E', color: 'red', part: 'foot' } }, '.': 'AIR', ' ': 'KEEP',
  },
  layers: [ ['LPPPPPL', 'P.....P', /* ... z-rijen */], /* ... y-lagen */ ],
  connectors: [{ pos: [3, 0, -1], facing: 'S', pool: 'village/streets', name: 'door' }],
  markers: [
    { pos: [5, 1, 1], type: 'loot', table: 'village/plains_house' },
    { pos: [2, 1, 5], type: 'villager_spawn' },
  ],
  weight: 2, rigid: true,
};
```

Materiaalrollen per stijl: `village/plains`: WALL = cobblestone, PLANKS = oak_planks, LOG_Y = oak_log, ROOF_STAIRS = oak_stairs,
PATH = dirt_path; `village/desert`: WALL = smooth_sandstone, PLANKS = cut_sandstone, LOG_Y = chiseled_sandstone, ROOF_STAIRS =
smooth_sandstone_slab (plat dak), PATH = smooth_sandstone. Eén layout geeft zo twee biomes; desert-layouts met platte daken krijgen
daarnaast eigen templates waar het silhouet echt anders moet. Rotatie draait `layers` en zet `facing`-states om (één functie, getest).

**Loot-tabel** (`src/items/LootTables.ts`):

```ts
{ id: 'simple_dungeon', pools: [
  { rolls: [1, 3], entries: [{ item: 'leather', w: 20, n: [1, 5] }, { item: 'golden_apple', w: 15 }, { item: null, w: 109 } /* ontbrekend */] },
  { rolls: [1, 4], entries: [{ item: 'bread', w: 20 }, { item: 'wheat', w: 20, n: [1, 4] } /* ... */] },
]}
```

Rollen met een eigen `mulberry32(hash(seed, x, y, z, tableId))`; stacks over willekeurige lege slots verdeeld (vanilla splitst stacks ook).

**Trade-definitie** (`src/entities/villager/Trades.ts`, data-driven zoals sinds 26.1):

```ts
{ prof: 'farmer', level: 1, want: ['wheat', 20], give: ['emerald', 1], maxUses: 16, xp: 2, mult: 0.05 }
```

**Villager-save** (singleplayer `WorldMeta.villagers`, server `data/world.json` → `villagers`):

```ts
interface VillagerSave {
  id: number; x: number; y: number; z: number; yaw: number;
  style: 'plains' | 'desert';          // uiterlijk
  prof: 'none' | 'nitwit' | 'farmer' | 'butcher' | 'armorer' | 'fletcher' | 'mason';
  level: number; xp: number; locked: boolean;   // locked = er is ooit getraded
  offers: [tradeIndex: number, uses: number, demand: number][];
  gossip: Record<string, number[]>;     // speler-uuid → [trading, majorPos, minorPos, minorNeg, majorNeg]
  bed?: [number, number, number]; job?: [number, number, number];
  ageTicks?: number; food: number; restocks: number; lastRestockDay: number; hp: number;
}
```

Plus `WorldMeta.structures = { populated: string[] }`: ids van structuur-starts (`"village:12,-4"`) waarvan de mobs al gespawnd zijn,
zodat herladen geen tweede set villagers maakt. Golems volgen hetzelfde record met `kind: 'iron_golem', playerBuilt`.

### 2.7 Protocol- en save-impact

| Laag | Wijziging |
|---|---|
| Save singleplayer | `WorldMeta.version` +1; nieuwe velden `villagers`, `golems`, `structures.populated`, `lootRolled` (of lege structuurkisten bewaren); `genVersion: 3` voor nieuwe werelden. Oude saves laden ongewijzigd |
| Server-opslag | `world.json`: idem; containers moeten eerst server-side bestaan (blokkerende afhankelijkheid "block entities") |
| Worker-bericht | generator-respons krijgt `meta?: Uint8Array` (null als de chunk geen structuur raakt) en `side: SideData[]`; transferables, geen kopie |
| `welcome` | draagt al `genVersion`; geen wijziging behalve de nieuwe waarde 3 |
| Entities (`ent`, binair) | nieuwe mob-kinds `villager`, `iron_golem`; 1 extra byte `prof | level<<4 | style<<7` voor het uiterlijk; slaap-pose als vlag |
| Nieuwe berichten C→S | `trade_open {eid}`, `trade_do {eid, offer, times}`, `trade_close {}` |
| Nieuwe berichten S→C | `trade_offers {eid, level, xp, offers: [want, want2?, give, uses, maxUses, price]}` (prijs al berekend voor die speler), `trade_result {ok, inv}` |
| Validatie server | afstand ≤ 8 blokken, villager wakker en niet in paniek, inventory bevat de (gekorte) prijs, voorraad, rate-limit 10 trades/s |
| Singleplayer | zelfde `TradeService` lokaal (zoals `MobSpawner` gedeeld is), dus één codepad |

## 3. Aanbevolen bouwvolgorde (na block entities)

| # | Stap | Moeite | Levert op | Hangt af van |
|---|---|---|---|---|
| 1 | Structuurframework: genVersion 3, meta-uitvoer uit de generator, side-data, random spread, template-formaat + rotatie, golden hashes | M | niets zichtbaar, wel de basis | block entities |
| 2 | Loot-tabellen + luie loot-kisten (rollen bij openen, server-side) | S-M | herbruikbaar voor alles | 1 |
| 3 | Spawner-blok (mob in meta) + dungeons | S-M | eerste beloning ondergronds | 1, 2 |
| 4 | Desert well, woestijnpiramide (+ pressure plate), iglo zonder kelder-mobs | S-M | bovengrondse doelen in desert/snowy | 1, 2 |
| 5 | Mijnschachten + rail-blok | M | grote ondergrondse netwerken | 1-3 |
| 6 | Dorp-structuren (plains + desert, 6 huizen + 5 werkplaatsen, straten, bel, put) zonder villagers | L | dorpen in de wereld | 1, 2, werkblokken |
| 7 | Villager-entity: model, A*-pathfinder met deuren, dagritme, POI-claims, persistentie | L | levende dorpen | 6, entity-opslag |
| 8 | Trading: data, `TradeService`, UI (2 invoerslots + uitvoer, lijst links), demand/reputatie, protocol | M | economie | 7 |
| 9 | Iron golem (generatie + spelergebouwd), fokken, gossip-verval | M | dorp verdedigt en groeit | 7 |
| 10 | Shipwrecks en ocean ruins (alleen volle blokken onder water) | M | oceaan-loot | 1, 2 |
| 11 | Overige beroepen na enchanting/effecten: librarian, toolsmith, weaponsmith, cleric; genezen, zombie villagers, verlaten dorpen | M-L | volledige trading | enchanting, effecten |
| 12 | Pillager outpost → raids; jungletempel (na jungle), trail ruins (na archeologie) | L | eind-mid-game | 9, nieuwe mobs |

**Risico's en kansen (kort).**
- **Textuurbudget** is de echte bottleneck (32 lagen vrij). Plan voor werkblokken samen met eventuele andere content; anders eerst
  `FACE_LAYER` naar `Uint16Array` (WebGL2 garandeert 256 lagen in een texture array, dus een tweede array of grotere arrays vergt
  shaderwerk, **onzeker** in kosten).
- **Workerkosten:** dorp-layout uitrekenen bij elke chunk binnen 80 blokken is alleen goedkoop met een layout-cache per start; zonder
  cache kost elke chunk tientallen `heightAt`-calls per stuk. Meten met de chunk-gen-benchmark.
- **Determinisme:** layouts mogen alleen van seed + startchunk afhangen, nooit van laadvolgorde; dezelfde test als voor bomen over de rand.
- **Pathfinding** is het grootste nieuwe systeem; het komt ook zombies (deuren breken), golems en later raids ten goede.
- **Kans:** dorpen zijn volgens `UPDATES.md` "de hoofdreden om te blijven spelen". Met trading in multiplayer krijgt een gedeelde server
  een economie; data-driven trades maken server-eigen trade-sets (custom servers) bijna gratis.

Bronnen: https://minecraft.wiki/w/Structure_set, https://minecraft.wiki/w/Monster_Room, https://minecraft.wiki/w/Mineshaft,
https://minecraft.wiki/w/Mineshaft/Structure, https://minecraft.wiki/w/Desert_Pyramid, https://minecraft.wiki/w/Jungle_Pyramid,
https://minecraft.wiki/w/Igloo, https://minecraft.wiki/w/Ruined_Portal, https://minecraft.wiki/w/Shipwreck, https://minecraft.wiki/w/Pillager_Outpost,
https://minecraft.wiki/w/Trail_Ruins, https://minecraft.wiki/w/Village, https://minecraft.wiki/w/Village/Structure, https://minecraft.wiki/w/Jigsaw_structure,
https://minecraft.wiki/w/Villager, https://minecraft.wiki/w/Trading, https://minecraft.wiki/w/Iron_Golem, https://minecraft.wiki/w/Zombie_Villager,
https://minecraft.wiki/w/Monster_Spawner, https://minecraft.wiki/w/Module:LootChest/chests (loot-data, opgehaald 3 okt 2026).
