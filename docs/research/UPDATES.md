# Minecraft Java Edition: updategeschiedenis en wat BunkCraft ervan moet halen

Onderzoek van 2 oktober 2026. Doel: de volledige featureset van Minecraft Java Edition in kaart brengen, afzetten tegen BunkCraft en een geprioriteerde bouwlijst maken.

**Methode en betrouwbaarheid.** De nieuwste releases (2025-2026) zijn gelezen op minecraft.wiki (versiepagina's). De oudere updates (Alpha tot 1.21) komen uit eerdere kennis en zijn niet allemaal opnieuw per pagina geverifieerd; waar een datum of detail niet zeker is staat "onzeker" of een `~`. Samenvattingen van de wiki zijn via een automatische samenvatter binnengehaald; feature-lijsten van 26.x zijn dus een hoofdlijn, niet volledig. Verifieer een detail op de wikipagina voordat je het als spec gebruikt.

## 0. Nieuwste versie en nieuw versieschema

| Punt | Bevinding |
|---|---|
| Nieuwste volledige release (op 2 okt 2026) | **Java Edition 26.3 "Wilderness Bound"**, uitgebracht 15 september 2026 |
| Versieschema | Sinds 2026 jaar-gebaseerd: `JJ.n` (26.1, 26.2, 26.3, ...). Het eerste getal is het jaar, het tweede de feature drop van dat jaar; hotfixes zijn `26.1.1`, `26.1.2`. Na 1.21.11 volgde direct 26.1 |
| Release-ritme | Vier "game drops" per jaar (rond maart, juni, september, Q4), elk met een naam en een snapshot-periode |
| Komend | **26.4 "Fourth Drop 2026"**, gepland Q4 2026, 2 snapshots tot nu toe: ijsgrotten (ice caves), frostbite-mob, Freezing-effect, ijsballen |
| Technisch | 26.1 vereist Java 25 en gebruikt ZGC; 26.2 heeft een optionele experimentele Vulkan-renderer; "environment attributes" en "timelines" (1.21.11) maken sky/fog/tijd data-driven |

Bronnen: https://minecraft.wiki/w/Java_Edition_version_history, https://minecraft.wiki/w/Java_Edition_26.3, https://minecraft.wiki/w/Java_Edition_26.4, https://minecraft.wiki/w/Planned_versions

## 1. BunkCraft vandaag (uitgangspunt)

Gelezen uit `CLAUDE.md`, `docs/ROADMAP.md`, `docs/GAMEPLAY.md`, `BlockRegistry.ts` (ids 0-66 + 255), `ItemRegistry.ts`, `MobTypes.ts`, `Biomes.ts`.

| Gebied | Aanwezig |
|---|---|
| Wereld | 16x16x128 chunks, 8 biomes (Ocean, Beach, Plains, Forest, Desert, Taiga, Snowy Plains, Mountains), bomen (eik/berk/spar), cactus, bloemen, grotten met lavameren onder y=11, ertsen (kool, ijzer, goud, diamant), meta-byte per blok |
| Blokken | steen, aarde, gras, zand, grind, hout (3 soorten), bladeren, glas, wol (5 kleuren), klei, obsidiaan, sneeuw, fakkel, werkbank, oven (alleen station), TNT, bakstenen, boekenkast, glowstone, 9 slab- en 9 trapmaterialen, eikenhouten deur |
| Vloeistoffen | Stromend water/lava (Minecraft 1.21-regels), emmers, obsidiaan/cobble-generatie |
| Items | houten/stenen/ijzeren/gouden/diamanten tools, boog + pijl, vlees (rauw/gaar), vuursteen en staal, buskruit, draad, veer, bot |
| Mobs | varken, koe, schaap, kip, zombie, creeper, skeleton, spin (alle op de server gesimuleerd) |
| Speler | health/honger/saturatie/adem volgens vanilla-getallen, valschade, game modes (survival, creative, hardcore, spectator), 10 advancements, kritieke treffers, knockback |
| Systeem | dag/nacht + wolken + schaduwen, multiplayer (server-authoritative mobs/items/TNT/vloeistof), save met migraties, keybinds, texturepacks |

**Niet aanwezig:** kisten, bed/slapen, landbouw, harnas, XP, enchanting, brouwen, dorpen/villagers/trading, structuren (dungeon, mijnschacht, dorp), weer, rivieren, extra biomes, ladders, hekken, vallend zand/grind, dimensies, vissen, fokken, redstone.

## 2. Tijdlijn per update

Kolommen: datum, thema, kopadditions per categorie. Waarde = "Waarde voor BunkCraft" gegeven de randvoorwaarden: browser/WebGL2, wereld 128 hoog, ids < 256 + meta-byte, geen Mojang-assets (alles procedureel of CC BY-SA), geen Nether/End, 1-20 spelers.

### 2.1 Pre-release en Beta

| Versie | Datum | Thema | Blokken / items | Mobs | Wereldgen | Mechanica / techniek | Waarde |
|---|---|---|---|---|---|---|---|
| Classic / Indev / Infdev | 2009 - feb 2010 | Prototypes | blokken, fakkels, ertsen (Indev) | - | oneindige wereld (Infdev) | chunks, dag/nacht begin | geen: al gedekt |
| Alpha 1.0 - 1.2 | jun - dec 2010 | Survival-basis, multiplayer (SMP) | oven, kisten, bedden, minecarts, boten | varken, schaap?, creeper-varianten, spin, skeleton | Nether (Alpha 1.2, ~dec 2010) | SMP, kist-opslag | hoog voor kist/bed, geen voor Nether |
| Beta 1.0 - 1.7 | dec 2010 - jun 2011 | Uitbreiding | pistons, cake, sneeuw/ijs, wolf, squid | wolf (tamen), cave spider-fix | biomes (1.2) | lichtberekening, skylight | middel: kist/bed/piston |
| Beta 1.8 "Adventure Update" | 14 sep 2011 | Adventure | enchanting table (prerelease 1.9), gouden appel, melon, pompoen, fence gates, nether-brick | - | strongholds, mijnschachten, villages (NPC), ravijnen, nieuwe biomes | **honger-balk**, **XP**, creative mode, combat-update | **hoog**: dit is de kern van de survival-loop |

Onzeker: exacte Alpha/Beta-versie per feature; voor BunkCraft is alleen de eindstaat (1.0) relevant.

### 2.2 1.0 t/m 1.12 (2011 - 2017)

| Versie | Datum | Thema | Blokken / items | Mobs | Wereldgen | Mechanica / techniek | Waarde |
|---|---|---|---|---|---|---|---|
| **1.0** | 18 nov 2011 | Officiele release | enchanting table, brewing stand, ender-items, anvil niet | Ender Dragon, enderman, blaze, magma cube, silverfish | End, strongholds, Nether-fortress | enchanting, brouwen, XP, End | middel: enchanting/XP/brouwen ja, End nee |
| 1.1 | 12 jan 2012 | Kleine update | - | - | Superflat | taalopties | geen |
| 1.2 | 1 mrt 2012 | Jungle/ocelot | jungle-hout, ladders-tweaks, steen-brick-varianten, cobwebs | ocelot | jungle-biome, Anvil-formaat, **256 hoog** | zwaardere wereldformaat | middel: jungle |
| 1.3 | 1 aug 2012 | Singleplayer = LAN-server | emerald-erts, ender chest, tripwire, command block, sandstone-stairs | villager (trading) | woestijn- en jungletempels, | **villagers + trading (emeralds)**, achievements | **hoog**: trading, tempel-loot |
| 1.4 | 25 okt 2012 | "Pretty Scary" | anvil, flower pot, cobble walls, carrot, potato, golden carrot | wither, witch, bat, zombie villager | - | enchantment-balk, command blocks | middel: anvil, gewassen |
| 1.5 | 13 mrt 2013 | Redstone | redstone-blok, daylight sensor, hopper, dropper, comparator, quartz, trapped chest | - | - | redstone-uitbreiding | laag: redstone is grote ingreep |
| 1.6 | 1 jul 2013 | Horse Update | hay bale, hardened clay, coal block, lead, horse armor | horse, donkey, mule | - | resource pack-systeem, launcher | middel: paarden, hooi |
| 1.7 | 22 okt 2013 | "The Update that Changed the World" | stained glass, 12 bloemen, packed ice, podzol | - | **veel nieuwe biomes** (mesa, savanna, roofed forest, mega taiga, ice spikes, ...), nieuw terrein | nieuwe worldgen, biome-diversiteit | **hoog**: biome-diversiteit |
| 1.8 | 2 sep 2014 | Bountiful Update | prismarine, slime block, banner, armor stand, granite/diorite/andesite, doors (alle hout), sea lantern | rabbit, guardian, endermite | ocean monuments | spectator, tellers, killer rabbit | middel: nieuwe steensoorten en deuren |
| 1.9 | 29 feb 2016 | Combat Update | shield, elytra, boats, end rods, chorus fruit, beetroot, lingering potions, tipped arrows, offhand | shulker, ender dragon-gevecht | **End cities**, End-gateways | **aanvalscooldown**, off-hand, nieuwe combat | middel: cooldown/schild goed voor PvP |
| 1.10 | 8 jun 2016 | Frostburn | magma block, nether wart block, bone block, structure block | polar bear, stray, husk | polar-biome-fixes | - | laag |
| 1.11 | 14 nov 2016 | Exploration | totem of undying, shulker box, observer | llama, vindicator, evoker, vex | **woodland mansion** | - | middel: totem, shulker box |
| 1.12 | 7 jun 2017 | World of Color | concrete, concrete powder, glazed terracotta, 16 bedkleuren | parrot | - | **recipe book**, **advancements** | middel: concrete en kleuren |

Opmerking: sommige details (1.0 en 1.3 mob/blok-lijsten) zijn uit geheugen; versie-aanwijzer = wiki-pagina's per versie.

### 2.3 1.13 t/m 1.21 (2018 - 2025)

| Versie | Datum | Thema | Blokken / items | Mobs | Wereldgen | Mechanica / techniek | Waarde |
|---|---|---|---|---|---|---|---|
| **1.13** "Update Aquatic" | 18 jul 2018 | Oceaan | koraal, kelp, zeegras, sea pickle, stripped logs, blue ice, trident, turtle shell, phantom membrane | dolphin, turtle, drowned, phantom, cod/salmon/pufferfish | nieuwe oceaan-biomes, schipwrakken, ocean ruins, buried treasure, ocean monument aanpassing | **zwemmen**, **data packs/tags**, command-herschrijving, "flattening" (block ids als namen) | middel: zwemmen en oceaan; flattening geen (BunkCraft is al data-driven) |
| **1.14** "Village & Pillage" | 23 apr 2019 | Dorpen en raids | campfire, barrel, smoker, blast furnace, loom, grindstone, stonecutter, cartographer table, lectern, composter, bell, scaffolding, sweet berries, bamboo, crossbow, suspicious stew | pillager, ravager, illager-captain, panda, cat, fox, wandering trader, trader llama | **nieuwe dorpen per biome**, pillager outposts, bamboo jungle, nieuwe sneeuw/dorp-biomes | **villager-beroepen en trading, raids, village-AI, nieuwe lichtengine (Light 2)**, nieuwe bed-tekst | **hoog**: dorpen en trading zijn de hoofdreden om te blijven spelen |
| 1.15 "Buzzy Bees" | 10 dec 2019 | Bijen | beehive, bee nest, honey block, honeycomb, honey bottle | bee | bee nests in bomen | nieuwe renderer en lichtfixes | laag |
| **1.16** "Nether Update" | 23 jun 2020 | Nether | netherite, soul fire, crimson/warped, respawn anchor, lodestone, blackstone, ancient debris, shield-uitbreiding | piglin, hoglin, strider, zombified piglin | nieuwe Nether-biomes, **bastion remnants**, ruined portals | piglin-bartering, 1.16 attribute modifiers | laag: Nether ontbreekt |
| **1.17** "Caves & Cliffs I" | 8 jun 2021 | Grotten (deel 1) | **koper**, **amethyst**, **spyglass**, powder snow, candles, tinted glass, glow lichen, lightning rod, dripstone, sculk sensor, azalea, moss, glow berries | axolotl, glow squid, goat | geodes, lush caves (eerste), dripstone caves | wereldhoogte-prep, Java 16 | middel: koper/amethyst/kaarsen veel bouwwaarde |
| **1.18** "Caves & Cliffs II" | 30 nov 2021 | Grotten (deel 2) | deepslate-ertsen, copper-erts | - | **wereldhoogte -64 .. 320**, **noise caves** (cheese, spaghetti, noodle), **nieuwe terreingen** (meer bergen, biome-hoogte), nieuwe biomes (meadow, grove, snowy slopes, jagged peaks, frozen peaks, stony peaks) | **nieuwe worldgen**, ertsverdeling opnieuw | **hoog** (grotten), maar hoogte 128 vs 384 is een harde grens |
| **1.19** "The Wild Update" | 7 jun 2022 | Wild | mud, mangrove, **sculk** (catalyst, shrieker), recovery compass, boats met chest, froglight | **warden**, allay, frog, tadpole | **mangrove swamp**, **deep dark** met **ancient city** | **chat-ondertekening**, warden-AI | middel: mangrove; deep dark/warden laag |
| **1.20** "Trails & Tales" | 7 jun 2023 | Verhalen | **archeologie** (brush, suspicious sand), **armor trims**, smithing templates, bamboo wood, hanging signs, chiseled bookshelf, decorated pots | camel, sniffer | **cherry grove**, **trail ruins**, ancient-city-loot | armor trims, **bamboo/kers-hout**, tekst op signs | middel: cherry grove en bamboe sfeervol; archeologie laag |
| **1.21** "Tricky Trials" | 13 jun 2024 | Trials | **mace**, **wind charge**, **crafter**, **copper bulbs/grates/doors**, tuff-varianten, trial keys, ominous bottle, vault | **breeze**, bogged, armadillo | **trial chambers** | trial spawner, nieuwe schilderijen, wolf armor | laag-middel: crafter en tuff goed, trial chambers duur |
| 1.21.2 "Bundles of Bravery" | 22 okt 2024 | Bundels | **bundle**, 2 banner-patronen | baby-varianten, salmon-maten | pale garden experimenteel | minecart-verbeteringen | laag-middel: bundle |
| 1.21.4 "The Garden Awakens" | 3 dec 2024 | Pale Garden | pale oak-set, resin (bricks), eyeblossom, pale moss | **creaking** | **pale garden**, creaking heart | mob-pickup van uitrusting | laag |
| 1.21.5 "Spring to Life" | 25 mrt 2025 | Lente | leaf litter, wildflowers, bushes, cactus flower, firefly bush, dry grass | variant koe/varken/kip (koud/warm), wolf-geluiden | fallen trees, nieuwe plantenstructuren | cartographer-trades, wandering trader koopt | middel: leaf litter en variant-dieren voor sfeer |
| 1.21.6 "Chase the Skies" | 17 jun 2025 | Lucht | harness, saddle recept | **happy ghast** | - | **player locator bar**, dialog-API, waypoints | laag |
| 1.21.9 "The Copper Age" | 30 sep 2025 | Koper | koperen tools, koperen armor, copper chest/torch/lantern/chain/bars, **shelf**, oxidatie + wax | **copper golem** | - | mannequin, `/fetchprofile` | middel: koperen tools/armor passen bij bestaande metaal-ladder |
| 1.21.11 "Mounts of Mayhem" | 9 dec 2025 | Rijdieren | **spear** (7 materialen), Lunge | **nautilus** (tambaar), zombie nautilus, camel husk | - | environment attributes, timelines, AF-opties | laag |
| **26.1** "Tiny Takeover" | 24 mrt 2026 | Baby-mobs | golden dandelion, name tag-recept | nieuwe baby-modellen/-geluiden | - | wereld-klokken, data-driven villager trades, nieuwe lightmap-algoritme, Java 25 | laag (visueel), middel (trade-data) |
| **26.2** "Chaos Cubed" | 16 jun 2026 | Zwavel | sulfur- en cinnabar-blokken met varianten, sulfur spikes, potent sulfur (geyser) | **sulfur cube** | **sulfur caves**, sulfur springs | experimentele Vulkan-renderer, friends list | laag-middel: nieuwe blokset, simpele mob |
| **26.3** "Wilderness Bound" | 15 sep 2026 | Wildernis | poplar-houtset, wolstairs/slabs, concrete stairs/slabs, **straw bed**, rode struiken, shelf mushroom | **cushion** (zit-entity) | **dappled forest**, **abandoned camps** (16 biomes) | explorer maps, `/compute`, `/posteffect` | middel: herfstbos en kampen; stairs/slabs voor wol/concrete |
| 26.4 (gepland) | Q4 2026 | IJsgrotten | ice balls, Potion/Arrow of Freezing | **frostbite** | **ice caves** met icicles | Freezing-effect | laag |

Bronnen: https://minecraft.wiki/w/Java_Edition_1.21.11, https://minecraft.wiki/w/Java_Edition_1.21.9, https://minecraft.wiki/w/Java_Edition_1.21.6, https://minecraft.wiki/w/Java_Edition_1.21.5, https://minecraft.wiki/w/Java_Edition_1.21.4, https://minecraft.wiki/w/Java_Edition_1.21.2, https://minecraft.wiki/w/Java_Edition_26.1, https://minecraft.wiki/w/Java_Edition_26.2, https://minecraft.wiki/w/Java_Edition_26.3, https://minecraft.wiki/w/Java_Edition_26.4 en voor oudere versies https://minecraft.wiki/w/Java_Edition_version_history (en de daaruit gelinkte versiepagina's).

Onzeker (te verifieren): exacte Alpha/Beta-versies per feature, 1.7-biome-lijst, 1.21.3/1.21.7/1.21.8/1.21.10 (hotfix- en kleine releases, hier niet apart behandeld).

## 3. "Wat doet het": belangrijkste feature per update

| Update | Wat het in de praktijk toevoegt |
|---|---|
| Beta 1.8 | De survival-lus: een **honger-balk** (BunkCraft heeft die al), **XP** voor verdiende levels, **strongholds, mijnschachten, ravijnen en dorpen** als doel om op uit te trekken. Creative mode erbij. |
| 1.0 | **Enchanting** (XP-levels omzetten in tool/armor-bonussen op de enchanting table, afhankelijk van boekenkasten eromheen), **brouwen** (potions via brewing stand + nether wart), **End** met eindbaas en credits. |
| 1.3 | **Villagers** met beroepen waarmee je met **emeralds** ruilt; tempels met loot. Geeft een economische tweede progressie naast mijnen. |
| 1.7 | Veel **biome-diversiteit** en bloemen: mesa, savanna, roofed forest, mega taiga, ijs-spikes. Verandert de wereld van "grasland met varianten" naar herkenbare regio's. |
| 1.9 | **Aanvalscooldown** (zwaard-damage schaalt met de laadbalk), **schild**, off-hand, elytra en End-steden. Het gevecht wordt tactisch. |
| 1.12 | **Recipe book** en **advancements** (BunkCraft heeft beide deels). Ook concrete en glazed terracotta voor bouwers. |
| 1.13 | **Zwemmen** als echte beweging, **oceanen** met schipwrakken, koraal, dolphins; **drowned**. Data-driven blokken/tags (BunkCraft is dat al). |
| 1.14 | **Nieuwe dorpen** per biome met **villagers die een beroep kiezen** op een werkblok (smoker, barrel, lectern, enz.), **raids** door pillagers en een **crossbow**. Het dorp is het sociale centrum van de wereld. |
| 1.16 | **Nether-herziening** met netherite en piglin-ruil; hier nul directe waarde zonder Nether. |
| 1.17/1.18 | **Koper** (oxideert, wax), **amethyst-geodes**, **noise caves** en **wereldhoogte -64..320**: grotten worden ruimer en spectaculairder (cheese/spaghetti/noodle caves, aquifers, meer ertsen). |
| 1.19 | **Deep dark** met **ancient city** en **warden**, **mangrove swamp** met modder en mangrove-hout, **allay** en **frog**. |
| 1.20 | **Archeologie** (brush -> pottery sherds, suspicious sand), **armor trims** (smithing templates), **cherry grove**, **camel** en **sniffer**. |
| 1.21 | **Trial chambers** met trial spawners en vaults, **mace** (smash-aanval via val-hoogte), **wind charge**, **crafter** (geautomatiseerd craften), **copper bulbs/doors/grates**, tuff-bouwset. |
| 1.21.4 | **Pale garden** met **creaking** (mob die alleen beweegt als je er niet naar kijkt) en **resin** (bricks via furnace). |
| 1.21.5 | Sfeer: **leaf litter, wildflowers, firefly bushes, fallen trees**; variant-dieren per klimaat. |
| 1.21.9 | **Copper Age**: koperen gereedschappen/armor en **copper golem** die items sorteert. |
| 1.21.11 | **Spear** (jab en charged attack), **nautilus** als rijdier; **environment attributes** (tijd, kleur, mist per biome). |
| 26.1 | Baby-mob-art, **golden dandelion** (leeftijd pauzeren), datagedreven villager-trades; vooral technische opschoning. |
| 26.2 | **Sulfur caves** met sulfur/cinnabar-blokken, **geysers** (potent sulfur + water) en de **sulfur cube**. Een volledig nieuwe cave-biome met eigen blokpalet. |
| 26.3 | **Dappled forest** met poplar-bomen in herfstkleuren, **abandoned camps**, **cushions**, **straw beds** (alleen slapen, zet geen spawn), wol-/concrete-stairs. |
| 26.4 (snap.) | **Ice caves** met icicles en de **frostbite**-mob en een **Freezing**-effect. |

## 4. Cross-check: headline-features versus BunkCraft

Effort: S = dagen, M = ~1-2 weken, L = enkele weken, XL = maand+ of zeer riskant. Status op basis van code en docs (zie sectie 1).

### 4.1 Wereld en biomes

| Feature | Status | Effort | Opmerking |
|---|---|---|---|
| Noise caves (1.18) | Gedeeltelijk | L | Grotten bestaan, andere developer bouwt de grotgeneratie nu; cheese/spaghetti/aquifers beoordelen na hun oplevering |
| Wereldhoogte -64..320 | Ontbreekt | XL | 128 hoog is vast in chunk-index `x\|z<<4\|y<<8`, mesher, licht (48x48x130), netwerk, save; zie aanbeveling over hoogte |
| Extra biomes: jungle, savanna, swamp/mangrove, badlands/mesa, cherry grove, dappled forest | Ontbreekt | M per stuk | `Biomes.ts` heeft 8; kleine gen-uitbreiding |
| Rivieren | Ontbreekt | M | Noise-gebaseerd |
| Dorpen (1.14) | Ontbreekt | L | Structuur-engine + villager-AI nodig |
| Dungeons, mijnschachten (Beta 1.8) | Ontbreekt | M per stuk | Kisten nodig |
| Strongholds, woodland mansion, ocean monuments, trial chambers | Ontbreekt | L-XL | Eind-spel; trial chambers vereisen spawner + vault |
| Abandoned camps (26.3) | Ontbreekt | S-M | Kleine structuur, kist nodig |
| Geodes (amethyst) | Ontbreekt | M | Past op 128 hoog |
| Dripstone, lush caves, sulfur caves, ice caves | Ontbreekt | M per stuk | Nieuwe cave-biomes; ice caves (26.4) nog niet uit |
| Weer (regen, sneeuw, onweer) | Ontbreekt | M | Sky, deeltjes, mobs, vuur, server-sync |
| Ocean-biomes, schipwrakken | Gedeeltelijk | M | Ocean-biome bestaat; wrakken/koraal niet |

### 4.2 Blokken en bouw

| Feature | Status | Effort | Opmerking |
|---|---|---|---|
| Slabs en stairs | Aanwezig | - | 9 materialen; wol/concrete (26.3) kunnen mee |
| Deuren | Gedeeltelijk | S | Alleen eiken; andere houtsoorten + trapdoors |
| Hekken, fence gates, muren (walls) | Ontbreekt | S-M | `partial`-machinerie bestaat |
| Ladders, muurfakkels, signs | Ontbreekt | S-M | Meta-richting |
| Kisten en opslag | Ontbreekt | M | Block entity + UI + netwerk |
| Oven met UI, brandstof, voortgang | Gedeeltelijk | M | Alleen crafting-station nu |
| Bed | Ontbreekt | M | 2 blokken met meta; spawnpunt, nacht overslaan |
| Vallend zand/grind | Ontbreekt | S-M | Entity of tick |
| Glas, kaarsen, lantaarns, banners | Gedeeltelijk | S per stuk | Glas wel, rest niet |
| Beton, wol-kleuren, terracotta | Gedeeltelijk | S | 5 wolkleuren; 16 kleuren + dye-systeem ontbreekt |
| Koper (oxidatie, wax), amethyst | Ontbreekt | M | Past op meta of aparte ids |
| Tuff, deepslate, andere steensoorten | Ontbreekt | S | Granite/diorite/andesite; deepslate hoort bij hoogte |
| Redstone | Ontbreekt | XL | Aparte ontwerp-ronde nodig |

### 4.3 Items en progressie

| Feature | Status | Effort | Opmerking |
|---|---|---|---|
| Tool-ladder (hout-diamant), goud | Aanwezig | - | Netherite, koper ontbreken |
| Boog en pijl | Aanwezig | - | Crossbow, trident ontbreken |
| Harnas (armor + armor-bar) | Ontbreekt | M | Leer/ijzer/diamant/goud; bar in HUD |
| XP-orbs en XP-balk | Ontbreekt | S-M | Orb-entity + levelcurve |
| Enchanting | Ontbreekt | M-L | Table, boekenkasten, lijst van 15-20 enchants |
| Anvil, grindstone | Ontbreekt | M | Reparatie en combineren |
| Brouwen | Ontbreekt | L | Effecten-systeem nodig |
| Landbouw (tarwe, wortel, aardappel, saplings) | Ontbreekt | M | Groeifase in meta, hoe/schoffel, botmeel |
| Fokken van dieren, wol scheren | Ontbreekt | M | AI-uitbreiding |
| Vissen | Ontbreekt | M | Vishengel, loot-tabel |
| Schild, aanvalscooldown | Ontbreekt | M | Combat-herziening; ook voor PvP |
| Bundle, shulker box | Ontbreekt | S-M | Container-items |
| Mace, spear, wind charge | Ontbreekt | M per stuk | Nieuwe combatregels |

### 4.4 Mobs

| Feature | Status | Effort | Opmerking |
|---|---|---|---|
| Passieve boerderijdieren | Aanwezig | - | varken, koe, schaap, kip |
| Zombie, creeper, skeleton, spin | Aanwezig | - | In overeenstemming met ROADMAP |
| Enderman, witch, slime, zombie-varianten (husk, drowned) | Ontbreekt | S-M per stuk | De andere developer werkt aan mobs; niet dubbel doen |
| Villager, wandering trader, iron golem | Ontbreekt | L | Trading-UI, beroepen, AI |
| Paard, wolf, kat, ocelot, vos | Ontbreekt | M per stuk | Taming/rijden |
| Aquatische mobs (vis, squid, dolphin) | Ontbreekt | M | Zwem-AI |
| Warden, creaking, breeze, sulfur cube, frostbite | Ontbreekt | M per stuk | Speciale AI; lage prioriteit |
| Illager-raids | Ontbreekt | L | Op villages |

### 4.5 Mechanica en techniek

| Feature | Status | Effort | Opmerking |
|---|---|---|---|
| Block states (meta-byte) | Aanwezig | - | Voor slabs/deuren/vloeistof |
| Vloeistoffen, emmers | Aanwezig | - | Waterlogging ontbreekt |
| Dag/nacht, wolken, schaduw | Aanwezig | - | Maanfasen, sterren: niet gecontroleerd |
| Slapen / nacht overslaan | Ontbreekt | M | Bed + server-regel (percentage spelers) |
| Weer | Ontbreekt | M | Zie 4.1 |
| Zwemmen (1.13-beweging) | Onzeker | S | Verifieer in `Player.ts` |
| Advancements | Gedeeltelijk | S | 10 van ~120 |
| Recipe book | Aanwezig | - | In recepten-UI |
| Commands (`/gamemode`, `/give`, `/tp`, ...) | Gedeeltelijk | M | Chat bestaat; commandoset onzeker |
| Wereldhoogte, hoogte-gerelateerde ertsen | Ontbreekt | XL | Zie hierboven |
| Dimensies (Nether/End) | Ontbreekt | XL | Buiten scope tot basis af is |
| Data packs, tags | Ontbreekt | M | BunkCraft is eigen data-driven; geen directe behoefte |
| Environment attributes / timelines | Ontbreekt | M | Mooi ontwerp voor biome-gebonden mist/sky |

## 5. Aanbevolen volgorde: de eerstvolgende 25 features

Rangorde = waarde per moeite voor een Minecraft-getrouwe ervaring, met afhankelijkheden meegewogen. Systemen die nodig zijn: **block entities** (kist, oven, spawner), **container-UI**, **entity-AI**, **structuurgeneratie** en **servervalidatie** (alles in multiplayer gesynchroniseerd).

Opmerking over parallel werk: nu bouwt een ander team content, mobs en grotten. Items 1-4 raken hun gebied niet; coordineer bij mobs (15-16, 21, 24) en cave-biomes (18).

### Fundamenten (S/M): ontsluiten veel meer

**1. Block entities en kisten (M).** In Minecraft is een kist een blok met een inventaris van 27 slots (dubbele kist: 54), geopend via rechtsklik, met loot-tabellen bij structuren. BunkCraft heeft `meta` per blok maar geen per-blok data. Nodig: een `Map<index, TileEntity>` per chunk, opslag in de save (apart van de blok-edits, record versie 3), netwerk-berichten voor open/move/close, een container-UI hergebruikend `SurvivalInventory`, server-validatie van afstand. Blokkeert: structuren, loot, villagers (opslag), enchanting-boekenkasten.

**2. Oven met UI, brandstof en voortgang (M).** Minecraft: een oven smelt 1 item per 10 s (200 ticks) met een brandstofbalk (kool = 80 s, hout = 15 s), 3 slots (input, brandstof, output), richting naar de speler en brandende lichtstaat. Nu is de oven alleen een station. Nodig: block entity (item 1), tick-lus op chunks met werkende ovens (server-side), meta voor richting + `lit`, UI. Smoker en blast furnace volgen later (2x snelheid voor eten/erts).

**3. Landbouw (M).** Tarwe (zaad uit gras, hoe nodig om de grond om te zetten naar farmland, groei in 8 fasen via willekeurige ticks, water in de buurt versnelt), wortel, aardappel, pompoen, meloen, suikerriet; brood; botmeel. Nodig: farmland-blok met vochtigheidsmeta, gewassen met groeifase in `meta`, **random ticks** per chunk (Minecraft: 3 per chunk-sectie per tick), schoffel, zaad-drops, replant bij oogst. Basis voor een hernieuwbaar voedselsysteem.

**4. Ladders, hekken, trapdoors, muurfakkels, signs (S-M).** Allemaal kleine vormen op de bestaande `partial`/meta-machinerie: ladder (klimmen met de toets, aan een muur), fence en fence gate (verbinden met buren), trapdoor (open/dicht, boven/onder), muurfakkel (richting). Tekst op signs vraagt een kleine block entity. Grote bouwwaarde, lage kans op regressies.

**5. Bed, spawnpunt en nacht overslaan (M).** Minecraft: bed (wol + planken) = 2 blokken; slapen kan alleen 's nachts of bij onweer; als alle spelers slapen (in Java: percentage via gamerule `playersSleepingPercentage`, standaard 100%) gaat de tijd naar de ochtend; zet het spawnpunt. Nodig: bed-blok (2 meta, kleur), slaap-state in `Game`, serverregel voor multiplayer (percentage van wakker-spelers), spawnpunt in spelerrecord, waarschuwing bij monsters in de buurt. Bed van 26.3 ("straw bed") zet GEEN spawn: dat is een aparte variant en geen vervanging.

### Survival-loop (M)

**6. Harnas en armor-bar (M).** Leer, ijzer, goud, diamant (en koper sinds 1.21.9; chain onzeker): helm, borstplaat, broek, laarzen, elk met een armor-waarde (diamant totaal 20) en duurzaamheid; schadereductie via `min(20, max(defense/5, defense - damage/(2 + toughness/4)))`, zoals op de wiki (verifieer formule). Nodig: nieuwe item-categorie, equipment-slots in de inventory, armor-bar in de HUD, rendering op spelers en mobs, schaderegels, netwerk-sync van uitrusting.

**7. XP-orbs, levels en de XP-balk (S-M).** Mobs, erts, smelten en fokken laten orbs vallen die op de speler af vliegen; de balk toont niveau en voortgang. Levelcurve: 17 XP voor lvl 0-15, daarna groeiend (verifieer exacte formule op https://minecraft.wiki/w/Experience). Nodig: orb-entity (lijkt op `ItemEntity`), `PlayerStats`-uitbreiding, HUD, saves en netwerk.

**8. Enchanting (M-L).** Een table + lapis + XP-levels geven een keuze uit drie enchants afhankelijk van de boekenkasten (max 15) rond de table; Efficiency, Unbreaking, Sharpness, Protection, Fortune, Silk Touch, Power enzovoort. Nodig: per-item `enchantments` in het item-slot (nu heeft een slot waarschijnlijk alleen id+count+damage: verifieer), de afgeleide effecten in mining/combat/schade, tooltip, de table-UI. Vereist items 1 en 7. Anvil en grindstone daarna.

**9. Aanvalscooldown, schild en kritieke treffers (M).** De 1.9-combat: een zwaardslag doet volle schade bij een volle laadbalk en minder bij spam; kritiek bij valpartij; schild blokkeert 100% frontaal. Past bij PvP en bij boog/crossbow. Nodig: cooldown-teller in `Interaction`, een schild-item en blokkeerrichting in de schaderegels, HUD-indicator. Optioneel in settings (sommige spelers houden van 1.8).

**10. Vissen, fokken en scheren (M).** Vishengel (cast, wachttijd, bite, loot-tabel voor vis/schatten); dieren fokken met voer (varken: wortel, schaap en koe: tarwe, kip: zaden) geeft een baby; schapen scheren met schaar. Nodig: nieuwe AI-doelen (loving, follow-parent), baby-modellen (schaal 0,5), loot-tabel-systeem (hergebruik voor kisten). Samen met landbouw een volledig voedselsysteem.

### Wereld en structuren (M-L)

**11. Loot-tabel-systeem (S-M).** Gewogen tabellen met ranges, nodig voor kisten in structuren, mob-drops en vissen. In Minecraft zijn dat JSON loot tables; hier een kleine TypeScript-datastructuur met seed-gebaseerde rolls (server-side voor multiplayer).

**12. Biomes uitbreiden: jungle, savanna, moeras, badlands, cherry/dappled forest (M per stuk).** Elk biome = temperatuur/vochtigheid-ruimte (Minecraft 1.18 gebruikt 6 klimaatparameters; een vereenvoudiging met temperatuur+humidity volstaat), eigen oppervlakteblokken, boomtype, flora en kleurenpalet (`BiomeColors.ts`). Het 128-hoge terrein past: de 1.7-biome-set had dit al. 26.3 voegt het herfstbos toe (poplar-bomen) als goedkope sfeeruitbreiding. Coordineer met de cave-ontwikkelaars over `Biomes.ts`.

**13. Dungeons en mijnschachten (M per stuk).** Dungeon: kleine cobble-kamer met spawner (zombie/skeleton/spider) en 1-2 kisten onder y=~60. Mijnschacht: lange houten gangen met rails, steunbalken, spinnenwebben en kisten. Nodig: structuur-pass in `TerrainGenerator` (deterministisch, chunk-overstijgend zoals bomen), spawner-blok als block entity (item 1), loot (item 11), `meta` voor rails/ladders.

**14. Dorpen (L).** Minecraft-dorpen genereren per biome (plains, desert, savanna, taiga, snowy) met huizen, bronnen, wegen en farmland, en villagers die op beroepsblokken werken. Nodig: structuurengine met templates (procedureel gebouwd uit blokken, geen Mojang-NBT), pad-vlakker, bedden en werkblokken, villager-entity met dagritme (item 16).

**15. Villagers en trading (L).** Beroepen (boer, bibliothecaris, smid, enz.) bepaald door het werkblok; elk met een lijst trades (emerald voor goederen); niveaus 1-5 door te handelen; prijzen reageren op vraag. Nodig: emerald-item en -erts, trading-UI, villager-AI (dagritme, bed, werkblok), server-autoriteit. Sinds 26.1 zijn trades data-driven: een kans om dat meteen netjes te doen. Coordineer met mob-team.

**16. Weer: regen, sneeuw, onweer (M).** Regen komt en gaat (willekeurige duur, ~12000 ticks tussen buien), blust vuur, laat gewassen groeien, sneeuw in koude biomes (meta-laag sneeuw), onweer met bliksem en zombie-spawn. Nodig: weerstate op de server (sync), sky/mist-uitbreiding in `Sky.ts`/`Materials.ts`, regen/sneeuwdeeltjes, biome-temperatuur per kolom, geluid.

**17. Rivieren en een oceaan-afwerking (M).** Rivier = lage kronkelende vallei die het biome overschrijft, met zand/klei in de bedding en riet. Plus koraalrif/kelp en schipwrakken later. Nodig: derde noise-laag op het terrein, riet-blok (suikerriet) en klei-generatie.

### Inhoud en sfeer (S-M)

**18. Cave-biomes en geodes (M per stuk).** Lush caves (azalea, moss, glow berries), dripstone, amethyst-geodes; 26.2 voegt sulfur caves toe, 26.4 ice caves. In BunkCraft past dit als biome-parameter in de 3D-grotgen (na oplevering van het cave-werk) en als losse blokken. Let op: hoogte -64 bestaat niet, dus deepslate-laag en de "deep dark" zijn lage prioriteit.

**19. Kleuren en bouwblokken (S).** Dye-systeem (16 kleuren: bloemen, kleurstoffen, craften), wol/glas/beton/terracotta in 16 kleuren, wol- en betonstairs/slabs (26.3), kaarsen, lantaarns. Procedurele textures zijn goedkoop; ids < 256 vraagt mogelijk een **kleur-in-meta** ontwerp (1 id + 16 meta) in plaats van 16 ids per blok.

**20. Koper en amethyst (M).** Koper-erts, oxidatie-fasen (4) door random ticks, wax met honingraat, koperen tools en armor (1.21.9), spyglass uit amethyst + koper; bouwblokken met trap/slab-varianten. Past bij random-tick-systeem (item 3) en bij het meta-ontwerp; stages passen in `meta` van 1 blok.

**21. Meer mobs (M per stuk), coordineer met mob-team.** Wolf (taming met bot, volgt, valt aan), kat, paard (zadel, rijden, springen), enderman (teleporteert, kijken = agro), slime, witch, husk/drowned; aquatische mobs (vis, squid). Nodig: AI-goal-uitbreiding (follow, tame, ride, teleport), rijdier-physics en netwerk.

**22. Commands en server-beheer (M).** `/gamemode`, `/give`, `/tp`, `/time`, `/weather`, `/kill`, `/seed`, `/gamerule`, plus ops/permissie (ROADMAP-punt 7.4). Eenvoudig te ontsluiten via de bestaande chat; maakt testen en beheer veel sneller.

**23. Advancements uitbreiden (S).** Van 10 naar ~40: Husbandry (landbouw, fokken, vissen), Nether valt weg, Adventure uitbreiden (structuren). Per feature in de lijst hierboven direct meenemen; in multiplayer opslaan in het spelersrecord.

**24. Redstone-lite (L-XL).** Alleen de kern: redstone-draad, toorts, hendel, knop, drukplaat, piston, lamp, deur-reactie. Signaalsterkte 0-15 past in `meta`. Groot ontwerp, hoge community-waarde (automatiseren), maar veel regressie-risico in meshing, lichtberekening en netwerk. Pas na stabiliteit van 1-10.

**25. Wereldhoogte-uitbreiding (XL, onderzoek eerst).** Minecraft 1.18+ gebruikt -64..320 (384 blokken); BunkCraft is 128. Ruimte voor spectaculaire bergen (1.18-terrein), diepe grotten en deepslate-lagen. Raakt chunkformaat (`x | z<<4 | y<<8` met 128 hoogte past in 16 bit; 256 y past in 12 bit + id), mesher-vertexformaat (pos x16 in Uint16: y tot 4095 past), licht-BFS-regio (48x48x130), netwerk, saves (migratie), prestaties (meer data per chunk). Aanbeveling: eerst 256 (Minecraft 1.2-hoogte) overwegen als compromis; pas als de rest staat.

### Samenvattende rangorde (waarde/effort)

| # | Feature | Effort | Waarde | Afhankelijkheid |
|---|---|---|---|---|
| 1 | Block entities + kisten | M | Hoog | - |
| 2 | Oven met UI | M | Hoog | 1 |
| 3 | Landbouw + random ticks | M | Hoog | - |
| 4 | Ladders, hekken, trapdoors, signs | S-M | Hoog | - |
| 5 | Bed en slapen | M | Hoog | - |
| 6 | Harnas | M | Hoog | - |
| 7 | XP | S-M | Hoog | - |
| 8 | Enchanting | M-L | Hoog | 1, 7 |
| 9 | Combat (cooldown, schild) | M | Middel | - |
| 10 | Vissen, fokken, scheren | M | Middel | 3, 11 |
| 11 | Loot-tabellen | S-M | Hoog | - |
| 12 | Biomes (jungle, savanna, moeras, badlands, herfstbos) | M per stuk | Hoog | - |
| 13 | Dungeons en mijnschachten | M | Hoog | 1, 11 |
| 14 | Dorpen | L | Hoog | 1, 11, 15 |
| 15 | Villagers en trading | L | Hoog | 14 |
| 16 | Weer | M | Middel-hoog | - |
| 17 | Rivieren | M | Middel | - |
| 18 | Cave-biomes en geodes | M | Middel | cave-werk |
| 19 | Kleuren en bouwblokken | S | Middel | meta-ontwerp |
| 20 | Koper en amethyst | M | Middel | 3 |
| 21 | Meer mobs | M | Hoog | mob-team |
| 22 | Commands | M | Middel | - |
| 23 | Advancements uitbreiden | S | Laag-middel | per feature |
| 24 | Redstone-lite | L-XL | Middel | stabiliteit |
| 25 | Wereldhoogte | XL | Hoog maar riskant | onderzoek |

## 6. Strategische observaties

- **Eerste 10 uur van een Minecraft-sessie** = hout, steen, oven, bed, voedsel, mijnen, grot, armor, een dorp zien. BunkCraft mist bed, kist, armor, dorp: dat zijn de eerste prioriteiten (1, 2, 5, 6, 13, 14).
- **Multiplayer is het onderscheid.** Block entities, loot en trading moeten van het begin af server-autoritatief zijn; bouw ze niet eerst client-side.
- **Geen Mojang-assets:** structuren, textures en geluiden blijven procedureel; structuren moeten als code/data worden beschreven, niet uit NBT-bestanden overgenomen.
- **Ids < 256 is een plafond.** Er zijn nu 67 ids gebruikt. Gebruik `meta` voor kleur, groeifase, oxidatie en richting (1 id, meerdere staten) om niet binnen enkele weken door de 255 heen te zijn.
- **Release-ritme van Mojang (4 drops per jaar)** betekent dat "volledig" een bewegend doel is: de realistische doelstelling is "Minecraft ~1.12-1.14 survival-ervaring + moderne cave- en biome-sfeer", niet pariteit met 26.x.

Bronnen sectie 4-6: https://minecraft.wiki/w/Experience, https://minecraft.wiki/w/Armor, https://minecraft.wiki/w/Village, https://minecraft.wiki/w/Trading, https://minecraft.wiki/w/Bed, https://minecraft.wiki/w/Farming, https://minecraft.wiki/w/Enchanting, https://minecraft.wiki/w/Furnace, https://minecraft.wiki/w/Weather, https://minecraft.wiki/w/Tutorials, https://minecraft.wiki/w/Java_Edition_version_history (formules en cijfers uit geheugen: verifieer voor implementatie).
