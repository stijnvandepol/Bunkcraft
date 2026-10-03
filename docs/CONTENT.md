# Content: blokken en items uit Minecraft Java 1.21

Onderzoek en ontwerp voor de uitbreiding van de creative inventory. Bronnen: de Minecraft Wiki
(creative inventory, armor, tools, food) en de Java 1.21-registers. De tellingen zijn afgerond; de
eindtelling per groep staat onderaan bij **Status**.

## 1. Wat Minecraft heeft, per creative-tab

| Tab | Ca. items in vanilla | Besluit |
|---|---|---|
| Building Blocks | 600+ (hout x11, steen, baksteen, koper, quartz, nether) | Tier 1: hout (8 soorten), steenvarianten, zandsteen, deepslate-set, tuff, calcite, baksteen, modderbaksteen, metaalblokken, slabs, trappen, deuren, hekken, muren. Nooit: Nether/End (blackstone, crimson/warped, purpur, end stone, prismarine, quartz), oxidatie van koper |
| Colored Blocks | 250+ (wol, beton, terracotta, glas, tapijt, bedden, kaarsen, banners, shulkers) | Tier 1: wol, beton, terracotta, geglazuurd terracotta, gekleurd glas + ruiten, tapijt, bedden (16 kleuren). Tier 2: kaarsen, banners, shulkerkisten, concrete powder (zwaartekracht) |
| Natural Blocks | 250+ (grond, erts, planten, bloemen, koraal) | Tier 1: aarde-varianten, zand, erts (kool, ijzer, goud, diamant, koper, lapis, redstone, smaragd), bladeren (8), saplings (7), bloemen, pompoen, meloen, sneeuw, ijs, klei, mos, hooibaal. Tier 2: koraal, amethist, dripstone, azalea, kelp, bamboe. Nooit: Nether-erts en -planten |
| Functional Blocks | 150 (torches, kisten, ovens, tafels, borden, deuren) | Tier 1: crafting table, furnace, kist (27 slots), boekenkast, ladder, fakkel, lantaarn, zeelantaarn, glowstone, TNT. Tier 2: blast furnace, smoker, anvil, grindstone, enchanting, brewing, borden, vaten (container-systemen) |
| Redstone Blocks | 50 | Alleen lijst: knoppen, drukplaten, hendels, repeaters, comparators, zuigers, dispensers, hoppers, rails, observers, redstone lamp. Minimaal systeem gebouwd (zie hieronder, Redstone); comparators, observers, hoppers, dispensers en rails nog niet |
| Tools & Utilities | 80 | Tier 1: houweel, bijl, schop, schoffel (5 tiers), schaar, emmers, vuur-en-staal. Tier 2: hengel, kompas, klok, kaart, boten, minecarts |
| Combat | 60 | Tier 1: zwaarden (5 tiers), harnas (leer, maliën, ijzer, goud, diamant: 20 stukken), boog, pijl, bijl. Tier 2: schild, kruisboog, trident, enchanting, totem. Nooit: netherite (smithing), elytra |
| Food & Drinks | 70 | Tier 1: brood, appel, gouden appel, koekje, gebakken aardappel, wortel, aardappel, vlees (rauw en gebakken), meloen, pompoentaart, stoofpot, vis. Tier 2: potions, melk, honing (brewing, vee). Nooit: Nether/End-voedsel |
| Ingredients | 80 | Tier 1: kool, houtskool, ingots (ijzer, goud, koper), diamant, smaragd, lapis, redstone, quartz is Nether (nooit), stok, leer, papier, boek, kleurstoffen (16), klei, baksteen, snowball, kleurstoffen |
| Spawn Eggs | 90 | Overgeslagen |

## 2. ID-budget en identiteit van items (de kern)

Chunks bewaren `Uint8Array` blok-ids, dus er zijn 255 ids (nu 67 in gebruik). Een 1:1-tabel (één id per
Minecraft-blok) past niet: dat zijn er 400+. Daarom drie lagen:

1. **Eigen id** voor blokken met een eigen gedrag of eigen textuur die geen kleur is (graniet, kist, ladder, ...).
2. **`meta`-byte als variant** voor families die zich gelijk gedragen:
   - 16 kleuren van wol, beton, terracotta, geglazuurd terracotta, gekleurd glas, tapijt, ruiten en bedden:
     `meta & 15` = kleur. De textuur is één grijze basistextuur die per **hoekpunt** met de kleur wordt vermenigvuldigd
     (de mesher kent al een tint per hoekpunt, dus 0 extra texturen en 0 extra draw calls);
   - houtsoort van slabs, trappen, deuren, hekken, trapdeuren, hekpoorten en steensoort van slabs, trappen en muren:
     het materiaal zit in de hoge bits van `meta`; de textuurlaag komt uit een kleine tabel (`VARIANT_LAYER`);
   - positiebits (richting, helft, open) blijven in de lage bits (zie `BLOCKSTATES.md`).
3. **Items die niet-blokken zijn** houden ids ≥ 256 (max 1023).

### Item-identiteit

`ItemStack` blijft `{ id, count, damage? }`; alleen de betekenis van `id` is uitgebreid:

| Bereik | Betekenis |
|---|---|
| 1..255 | blok met meta 0 (zoals nu) |
| 256..1023 | niet-blok-items (voedsel, tools, harnas, materialen) |
| ≥ 1024 | variant-blok: `id = 1024 + blockId + (meta << 8)` met `meta ≠ 0` (alleen de variantbits) |

Zo is de identiteit een formule zonder tabel: een save blijft geldig ongeacht de volgorde van registratie,
stapelen werkt op `id`, recepten en inventories (ook `inventory` op de server) veranderen niet, en oude items
(`id < 1024`) lezen zoals voorheen. Hulpfuncties: `itemFromState`, `itemBlock`, `itemMeta` in `ItemRegistry`.
Per blok bepaalt `variantMask` welke metabits bij het item horen; de rest (richting, open) komt uit de plaatsing.

Oude saves: de wolkleuren met eigen id (rood 39, blauw 40, geel 41, groen 42) blijven bestaan als verborgen
blokken en worden bij het laden van een inventory naar het nieuwe item vertaald (`LEGACY_ITEMS`). Geen id wordt hernummerd.

### Textuurlagen

`FACE_LAYER` is een `Uint8Array`, dus hooguit 255 lagen (WebGL2 garandeert er 256). Er zijn er nu 72. Dankzij
tint-kleuren en materiaal-tabellen blijft het totaal onder de 256; een Vitest bewaakt dat.

## 3. Wat er in tier 1 komt (volgorde van waarde)

1. Item-identiteit, kleurfamilies, hout (8 soorten), steenvarianten, ertsen, metaalblokken, natuurblokken.
2. Slabs, trappen en deuren per materiaal (via meta), tabbed creative inventory met zoeken en scrollen.
3. Tools met echte tiers (schoffel, schaar, schop-paden, bijl-strippen, schoffel-farmland), mining-tabel op hardheid.
4. Harnas: 20 stukken, armor-slots in de survival-inventory, harnasbalk, schadeformule, slijtage.
5. Voedsel en materialen met echte honger- en verzadigingswaarden.
6. Recepten (vanilla aantallen) en smelten, crafting-UI met categorieën en zoeken.
7. Kist met 27 slots (singleplayer; opgeslagen per wereld).
8. Dunne vormen: tapijt, ladder, trapdeur, hek, hekpoort, muur, glasruit, bed, lantaarn.

Tier 2 (systeem ontbreekt): redstone, brouwen, enchanting, smithing/netherite, landbouw met groeifases, dorpelingen, anvil,
grindstone, blast furnace, smoker, borden, banners, kaarsen, schild, kruisboog, hengel, boten.
Nooit (buiten scope): Nether, End, Deep Dark, Trial Chambers, spawn eggs, operator-blokken.

Formules (uit de wiki): schade na harnas = `damage × (1 − min(20, max(armor/5, armor − damage/(2 + toughness/4)))/25)`.
Harnaspunten helm/borst/broek/laars: leer 1/3/2/1, maliën 2/5/4/1, ijzer 2/6/5/2, goud 2/5/3/1, diamant 3/8/6/3 (toughness 2 per diamantstuk).
Duurzaamheid = basis (11/16/15/13) × multiplier (leer 5, maliën 15, ijzer 15, goud 7, diamant 33).

## 4. Wat er is gebouwd

### Telling per tab (items in de creative inventory)

| Tab | Items | Voorbeelden |
|---|---|---|
| Building Blocks | 147 | 8 houtsoorten (log, stripped log, planken), steenfamilie, zandsteen, deepslate, modder, metaalblokken, glas, 9 + 24 slab- en trapmaterialen, deuren, luiken, hekken, poorten, muren |
| Colored Blocks | 129 | 16 × (wol, tapijt, bed, terracotta, geglazuurd, beton, glas, glasruit) + terracotta |
| Natural Blocks | 70 | grond, erts, logs, 8 bladsoorten, 7 saplings, 10 bloemen, paddenstoelen, suikerriet, pompoen, meloen, hooibaal, spinnenweb |
| Functional Blocks | 15 | werkbank, oven, kist, boekenkast, ladder, fakkel, lantaarn, glowstone, zeelantaarn, uitgesneden pompoen, TNT, tralies, glasruit |
| Redstone Blocks | 19 | stof, fakkel, redstoneblok, repeater, (sticky) zuiger, hendel, knoppen, drukplaten, nootblok, lamp, TNT, deur, luik, hekpoort |
| Tools & Utilities | 26 | schop, houweel, bijl, schoffel (5 tiers), schaar, vuur-en-staal, emmers, kom |
| Combat | 32 | zwaarden en bijlen (5 tiers), boog, pijl, 20 harnasstukken |
| Food & Drinks | 29 | 10 vleessoorten, appel, gouden appel, brood, koekje, aardappel, wortel, meloen, taart, stoofpot, vis, bessen |
| Ingredients | 50 | kolen, houtskool, rauwe en gesmolten metalen, edelstenen, 16 kleurstoffen, papier, boek, leer, zaden |

Totaal: **182 bloktypes** (hoogste id 185 van 254, dus nog ruim 60 vrij), ~480 uniek vindbare items, **~420 recepten** (106 zonder werkbank, 271 met werkbank,
43 smelten), **223 textuurlagen** van de 255 die `FACE_LAYER` toelaat.

### Ontwerpkeuzes

- **Kleurfamilies via tint:** wol, beton, terracotta, geglazuurd terracotta, gekleurd glas, tapijt, ruiten en bedden gebruiken één grijze basistextuur
  (alpha 128 = "vermenigvuldig met de hoekpunttint" voor ondoorzichtige blokken) en `meta & 15` kiest de kleur. Voor een geïmporteerd Minecraft-jar
  wordt `white_*` met dezelfde tint vermenigvuldigd. Gekleurd glas is alpha-getest en dus niet doorzichtig; echte transparantie is tier 2.
- **Materiaal in de state:** `SLAB_X` (bits 2-6, 24 materialen), `STAIRS_X` (bits 3-7), deuren (bits 5-7), luiken (bits 4-7), hekpoorten (bits 3-5), hekken (bits 0-2)
  en muren (bits 0-4). Het materiaal bepaalt via `VARIANT_LAYER` de textuurlaag, geluid, hardheid en gereedschap. De mesher leest daarvoor alleen
  `meta` voor deze vormen, kubussen blijven goedkoop (kleur en voorkant zijn de enige uitzonderingen).
- **Eigen id's voor wat de worldgen moet kunnen plaatsen:** granite, diorite, andesite, tuff, calcite, deepslate-set, ertsen, bloemen, paddenstoelen,
  suikerriet, pompoen, melon, ijs, cobweb, en de logs en bladeren van jungle, acacia, dark oak, mangrove en cherry zijn gewone blok-id's. **Voor het
  terrein-team:** deze blokken staan klaar (`CUBE_ID.<naam>`, bijv. `CUBE_ID.granite`, `CUBE_ID.jungle_log`) maar worden nog door niets gegenereerd.
- **Dunne vormen** (`src/world/BoxShapes.ts`): tapijt, luik, hekpoort, hek, muur, glasruit/tralies, ladder en bed zijn een paar boxen waarvan
  zichtbare vorm, botsing en raycast uit dezelfde functies komen. Hekken, muren en ruiten leiden hun verbindingen af uit de buren (zoals trappen),
  hekken en muren zijn 1,5 hoog (de botsing kijkt daarom één cel lager). Een bed is twee blokken, een ladder klimt via `Player.step`.
- **Furnace, kist en pompoenen** hebben een richting (`meta & 3` bepaalt welke zijde de voorkant toont). `meta 0` is de oude vaste voorkant, dus
  bestaande ovens veranderen niet.
- **Block entities** (`src/world/BlockEntities.ts`): kist en oven bewaren hun inhoud per positie in een `BlockEntityStore`
  per wereld. Ze ontstaan bij plaatsen, verdwijnen bij breken (inhoud valt eruit in survival) en tikken alleen als ze iets
  te doen hebben en hun chunk geladen is. Opslag: singleplayer `WorldMeta.blockEntities` (save-versie 4; de oude
  `WorldMeta.containers` wordt bij het laden omgezet), de server in `world.json` (`blockEntities`). Andere soorten (spawner,
  bord, bed, banner) registreren zich met `registerBlockEntityKind`.
- **Dubbele kist:** een kist naast een kist met dezelfde richting wordt één kist van 54 slots. State-bits: 0-1 richting,
  bit 2 = linker/lage helft (houdt de 54 slots), bit 3 = rechter/hoge helft. Breek je één helft, dan vallen de 27 slots van
  die helft eruit en blijft de andere een enkele kist. Een helft zonder echte partner telt als enkele kist. Beide helften
  zien er nog uit als twee enkele kisten (geen eigen textuur).
- **Oven** (`src/items/Smelting.ts`): input-, brandstof- en outputslot, kooktijd 200 ticks (blast furnace en smoker 100,
  klaar in de code maar nog zonder blok), brandstoftabel van de wiki (lavaemmer 20000 → lege emmer, kolenblok 16000, kool en
  houtskool 1600, hout 300, houten gereedschap 200, stok 100, ...), voortgang zakt 2 per tick zonder vuur. XP per recept
  wordt in de oven bewaard (`xpStored`) en bij het pakken van de output uitgedeeld (`takeXp()`, hook `onXpAwarded` /
  `Game.onFurnaceXp` voor het XP-systeem). Brandend is een eigen blok-id `lit_furnace` (86) met licht 13 en een gloeiende
  voorkant; het valt als gewone oven. De smelt-recepten in het receptenboek zijn naslag: smelten gaat alleen in een oven.
- **Loot-tabellen** (`src/items/Loot.ts`): pools met rolls, gewogen entries, aantallen en condities (`killed_by_player`,
  `chance`, `looting_chance`), deterministisch met `seededRng(hashSeed(...))`. `fillContainer` strooit de stacks over
  willekeurige vrije slots zoals Minecraft.
- **Per-stack data:** `ItemStack.data?: Record<string, number>` met een append-only sleutellijst (`ITEM_DATA_KEYS`). Opslagformaat
  `[id, count, damage, sleutel, waarde, ...]`, dus oude saves (3 getallen) blijven geldig; `drop` en `taken` dragen `data` mee.
- **Harnas** zit als 4 extra records (slot 36-39) in `PlayerInventory.serialize()`: oude saves en de server (limiet 64 records) blijven werken.

- **Enchantments en naam** staan in dezelfde `data`: elke enchantment is een sleutel met het level, `repair_cost` is de prior-work-straf
  van de anvil en een eigen naam staat in `custom_name` t/m `custom_name_7` (drie UTF-16-tekens per getal, max 24 tekens; `EnchantRules.customName`).
  Een rij mag daarom 40 getallen lang zijn (server: `InventoryGuard`, `drop`). Het **enchanted book** is item 900 met zijn enchantments in `data`.
  Enchanting table (250), anvil (251, variant: chipped/damaged in bits 2-3) en grindstone (252) hebben id's bovenin het bereik zodat de
  append-only content-tabellen eronder kunnen groeien.

### Wat bewust anders is dan vanilla

- Beton heeft geen poeder (4 zand + 4 grind + kleurstof → 8 beton); kleurstoffen: bruin (cacao), zwart (inktzak) en grijs (heeft zwart nodig) hebben nog geen bron.
- Een bed zet je respawnpunt en slaapt 's nachts door, zonder spelers-in-bed-telling of monstercheck.
- Mud bricks en hooi vragen tarwe, dus landbouw (tier 2). Het brood-, koekje- en taartrecept zijn er, maar wat ze als grondstof nodig hebben ontbreekt nog in de wereld
  (tarwe, cacao, eieren). Koeien laten sinds de balans-audit 0–2 leer vallen (`docs/qa/BALANCE.md`). `tests/recipes.test.ts` houdt dit lijstje bij ("OUT_OF_REACH").
- Een kist is een volle kubus (geen kleinere kist met deksel) en heeft geen dubbele variant.
- Boekenkast blijft 6 planken (vanilla: + 3 boeken); nu leer van koeien komt, kan het vanilla-recept terug.
- Gouden appel geeft honger en saturatie maar nog geen Absorption en Regeneration (geen effectensysteem).
- Het bed, de kist en de lantaarn hebben procedurele texturen (in een Minecraft-jar zijn ze entity-textures); de rest wordt wel uit een geïmporteerd jar geladen.
- Een ontploft blok laat een gekleurd blok als witte wol vallen (`World.explode` kent de state van vernietigde blokken niet).

### Tier 2 en nooit

Tier 2: comparator, observer, hopper, dispenser, rails, landbouw met groeifases en random ticks, brouwen, smithing en netherite, blast furnace, smoker,
stonecutter, schild, kruisboog, hengel en vis, boten en minecarts, kaarsen, banners, borden, koraal, amethist, dripstone, azalea, kelp en bamboe, concrete powder,
doorzichtig glas en ijs, kisten in multiplayer, dubbele kisten, vallende blokken. Nooit: Nether en End (blackstone, crimson/warped, quartz, purpur, end stone,
prismarine), Deep Dark, Trial Chambers, spawn eggs en operator-blokken.

### Pixel Perfection

Voor de nieuwe blokken zijn uit de Pixel Perfection-repo (CC BY-SA 4.0) 38 textures toegevoegd in `public/texturepacks/pixel-perfection/`: jungle- en acaciahout, kistzijden,
metaalblokken, rood zand, ijs, ladder, suikerriet, hooi, paddenstoelen, tulp en saplings. Alles wat het pack niet heeft blijft procedureel
(`src/rendering/ContentPainters.ts`). De namen voor een Minecraft-jar staan in `MINECRAFT_LAYOUT` (`MINECRAFT_SAME_NAME` voor de textures met dezelfde naam).

### Redstone

Zie `ROADMAP.md` 4d voor gedrag en vereenvoudigingen. Blok-ids: stof 87, hendel 88, knop 89 (de vrije ids na `LIT_FURNACE`), repeater 241,
drukplaat 242, onderdeel 243–249 (zuigerkop 243, sticky zuiger 244, zuiger 245, nootblok 246, lamp aan 247, lamp 248, fakkel 249).
Box-vormen 12–19 (`RedstoneShapes.ts`). State bytes:

| Blok | Bits |
|---|---|
| stof | 0-3 signaal (verbindingen afgeleid uit de buren) |
| hendel, knop, fakkel | 0-2 richting van het blok waaraan hij vastzit (vlakvolgorde +X −X +Y −Y +Z −Z), bit 3 aan/ingedrukt/uit (fakkel), knop bit 4 eik |
| drukplaat | 0 ingedrukt, 1 eik |
| repeater | 0-1 richting van het signaal, 2-3 vertraging − 1, 4 aan |
| nootblok | 0-4 toon, 5 gevoed |
| zuiger / kop | 0-2 richting, bit 3 uitgeschoven / sticky |

Textures procedureel (`RedstonePainters.ts`, 14 lagen); de Minetest-`mesecons`-textures zijn niet gebruikt (andere stijl, niet in Pixel Perfection).
