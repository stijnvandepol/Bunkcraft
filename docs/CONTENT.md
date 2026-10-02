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
| Redstone Blocks | 50 | Alleen lijst: knoppen, drukplaten, hendels, repeaters, comparators, zuigers, dispensers, hoppers, rails, observers, redstone lamp. Tier 2 (redstone-systeem ontbreekt). Redstone stof en redstoneblok zijn wel items/blokken |
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

## 4. Status

Wordt bijgewerkt bij de oplevering (zie de eindtelling hieronder).
