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
| Schaap | 8 | 0,9×1,3 | dwalen, vluchten, gras eten | 1 wol in zijn kleur (geschoren: geen), 1–2 schapenvlees |
| Kip | 4 | 0,4×0,7 | dwalen, fladderen, geen valschade | 1 kip, 0–2 veren |
| Zombie | 20 | 0,6×1,95 | achtervolgen, slaan (3), brandt in de zon | 0–2 rot vlees |
| Creeper | 20 | 0,6×1,7 | achtervolgen, 1,5 s opzwellen, explosie (kracht 3) | 0–2 buskruit |
| Skelet | 20 | 0,6×1,99 | afstand houden, pijlen schieten, brandt in de zon | 0–2 botten, 0–2 pijlen |
| Spin | 16 | 1,4×0,9 | klimt, springt, neutraal bij helder licht | 0–2 draad, soms een spinnenoog |
| Wolf | 8 (tam 40) | 0,6×0,85 | neutraal; bot temt (1/3), zit/volgt, vecht mee met de eigenaar, roedel wordt boos | niets |
| Enderman | 40 | 0,6×2,9 | neutraal; boos bij 5 ticks aankijken (64 blokken), teleporteert na schade en in water, slaat 7 | 0–1 ender pearl |
| Slime | 16 / 4 / 1 | 0,52 × grootte | springt, slaat 3 / 2 / 0, splitst in 2–4 kleinere | kleine: 0–2 slimeballs |
| Drowned | 20 | 0,6×1,95 | zwemt achter je aan, slaat 3, brandt niet | 0–2 rot vlees, 11 % goudstaaf (onzeker) |
| Husk | 20 | 0,6×1,95 | woestijnzombie, brandt niet | 0–2 rot vlees |
| Stray | 20 | 0,6×1,99 | skelet van sneeuwgebieden (slowness-pijlen volgen met effecten) | botten, pijlen |
| Cave spider | 12 | 0,7×0,5 | klein, vergif 7 s per beet | draad, spinnenoog |
| Witch | 26 | 0,6×1,95 | gooit elke 3 s een drankje binnen 10 blokken (nu: vergif 5 s, tot de effecten er zijn) | 3× 0–2 uit glowstone, buskruit, redstone, spinnenoog, suiker, stok |
| Paard | 15–30 | 1,4×1,6 | temmen door te rijden (temper), zadel, sturen met WASD, springen | 0–2 leer |

![Nieuwe mobs](screenshots/mobs-new-a-front.jpg)
![Nieuwe mobs van opzij](screenshots/mobs-new-b-side.jpg)

### AI (Minecraft-goals, `src/entities/ai/`)

- **Goal selector** (`Goal.ts`): elke mob heeft prioriteiten-lijsten met goals (`canUse`, `canContinue`, `start`, `tick`, `stop`) en vlaggen MOVE/LOOK/JUMP/TARGET; een goal met een lager nummer onderbreekt een lopende goal met dezelfde vlag. Doelkeuze (`targetGoals`) loopt apart. Per soort staan de lijsten in `brains.ts`, in de volgorde van de Java-klassen.
- **Goals:** zwemmen, paniek, lokken met voer, fokken, ouder volgen, wandelen (alleen op droge grond in geladen chunks), naar spelers kijken, rondkijken, gras eten, melee, creeper-lont, sprong (spin), boog (skelet, 3 s), schaduw zoeken (skelet in de zon), wolven ontwijken (skelet), zitten, eigenaar volgen en teleporteren (≥ 12 blokken), verdedigen/meevechten, prooi, enderman-blik en teleport, slime-sprongen, drowned-zwemmen, witch-drankjes, eieren leggen, paard berijden.
- **Pad zoeken** (`Pathfinder.ts`, `Navigator.ts`): A* op het voxelrooster (1 blok omhoog, tot 3 omlaag, diagonaal als beide buren vrij zijn; lava en cactus nooit, water duurder of verboden). Knoopbudget per zoektocht (160), herberekening elke 10–20 ticks per mob, een rechte lijn zonder zoektocht als die vrij is, en per tick maximaal 6 zoektochten voor alle mobs samen. Is het doel onbereikbaar, dan loopt de mob het beste deelpad. Deuren: nog dicht = muur.
- **Kosten:** `npx tsx scripts/bench-spawn.ts` (laatste blok): 51 mobs van elke soort rond 8 spelers op de serverwereld, 0,73 ms per tick inclusief wereld en vloeistoffen, 1,1 zoektochten en ~155 knopen per tick. De Vitest-check houdt 40 mobs achter obstakels onder 1 ms per tick.

### Fokken, baby's en boerderij

- **Voer** gaat via *tags* (`Breeding.ts`): koe/schaap tarwe, varken wortel/aardappel/bietwortel, kip zaden (tarwe, pompoen, meloen, bietwortel, torchflower: wat er bestaat telt), wolf vlees, paard gouden appel/wortel. Nieuwe gewassen werken dus vanzelf zodra het item bestaat.
- Voeren geeft 30 s love mode (hartjes), twee dieren lopen naar elkaar toe en krijgen na 3 s samen een baby; daarna 5 minuten afkoeling. XP 1–7 via `MobEvents.xp` (TODO: koppelen aan `awardXp` van het XP-systeem).
- **Baby's** groeien in 20 minuten op (voeren haalt 10 % van de resttijd af), zijn half zo groot met een relatief grote kop, volgen een ouder, praten hoger en laten niets vallen. 5 % van de natuurlijke dieren is een baby.
- **Schapen** eten gras (gras → aarde, tufjes weg) en krijgen zo hun wol terug; scheren met een schaar geeft 1–3 wol in hun kleur, verf kleurt ze. Natuurlijke kleuren: wit 81,8 %, zwart/grijs/lichtgrijs 5 %, bruin 3 %, roze 0,16 %.
- **Koeien** geven melk in een emmer (nieuw item `milk_bucket`), kippen leggen elke 5–10 minuten een ei (nieuw item `egg`).
- **Paarden:** rechtsklik met lege hand = opstappen; een wild paard gooit je na 2–5 s af en wordt elke keer makkelijker (temper +5) tot het tam is. Tam paard + zadel = sturen met WASD en springen; snelheid 4,9–14,6 blokken/s en springhoogte per paard (Minecraft-formules). Alleen singleplayer.

![Baby's](screenshots/mobs-babies.jpg)
![Schapen](screenshots/mobs-sheep.jpg)
![Wolven temmen](screenshots/mobs-wolf-taming.jpg)

- **Spawnen** (`src/entities/MobSpawner.ts`, dezelfde code in singleplayer en op de server):
  - Dieren: bij het genereren van een grasrijke chunk komt in een kwart van de chunks een groepje van 2–4 (gewichten schaap 12, varken 10, kip 10, koe 8; vaste kans per seed en chunk). Daarnaast vult elke 10 s overdag een nieuw groepje aan tot ongeveer 28 dieren in de buurt, met een wereldplafond van 80.
  - Monsters: twee spawnpogingen per tick per speler, 24–48 blokken weg, nooit dichterbij. Op elke vloer met twee vrije blokken erboven (gras, bloemen en tufjes tellen als vrij), bij block light 0 en een sky light min de duisternis van de dag ≤ willekeurig 0..7. Dat geldt 's nachts overal buiten en altijd in grotten en andere donkere plekken.
  - Helft van de pogingen kijkt naar het oppervlak, de andere helft naar willekeurige diepte (tot 40 blokken onder de speler), zodat grotten ook overdag spawnen.
  - Biomen en diepte (extra worpen, de hoofdtabel blijft gelijk): enderman (10) en witch (5) als zeldzame pakken; in de woestijn is 80 % van de zombies een husk, in sneeuw 80 % van de skeletten een stray; in slime chunks (1 op 10, vast per seed) spawnen onder y 40 slimes van grootte 1, 2 of 4; diep in grotten is de helft van de spinnen een cave spider; in de oceaan zoekt een kwart van de pogingen drowned in water van minstens 3 diep. Bossen en taiga's krijgen soms een roedel wolven, vlaktes een kudde paarden.
  - Tabel: zombie 100, skelet 100, creeper 100, spin 100. Groepen: zombie en skelet 4, creeper 1, spin 1–2. Leden staan binnen een paar blokken van elkaar, met drie pogingen per lid.
  - Plafond: 40 monsters voor één speler (+20 per extra speler, max 100), overdag 40 % daarvan, zodat de grotten niet het hele plafond opeten.
- **Despawnen:** monsters verdwijnen direct verder dan 128 blokken, en verder dan 32 blokken met kans 1/800 per tick. Overdag verdwijnen monsters in open zon buiten bereik na gemiddeld ongeveer 12 s, zodat de ochtend de oppervlakte opruimt zonder dat zombies en skeletten allemaal tegelijk in vlammen opgaan. Dieren verdwijnen met hun chunk en keren terug vanuit de seed.
- **Controle:** F3 toont `Mobs within 64: x hostile · y passive`. `npx tsx scripts/bench-spawn.ts` meet de aantallen op de serverwereld, `tests/mobSpawner.test.ts` test de regels.
- **Gezichten:** de ogen worden per gezichtsbreedte getekend (`eyes()` in `MobTypes.ts`): brede koppen krijgen wit + pupil, smalle (schaap 6 px, kip 4 px) alleen pupillen aan de randen. Vaste posities lieten bij een smal gezicht de ogen samensmelten of overschreven er een.
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

## Inhoud van 1.21 (blokken, tools, harnas, voedsel)

Onderzoek, ontwerp en tellingen: [`CONTENT.md`](CONTENT.md). Kort:

- **Blokken:** 8 houtsoorten (eik, spar, berk, jungle, acacia, donkere eik, mangrove, kers) met logs, stripped logs, planken, bladeren,
  slabs, trappen, deuren, luiken, hekken en hekpoorten; steen (graniet, diorite, andesiet en hun gepolijste varianten, tuff, calciet,
  deepslate-set, stenen bakstenen met mossy/cracked/chiseled, modderstenen); zandsteen en rood zandsteen met chiseled/cut/smooth;
  16 kleuren wol, beton, terracotta, geglazuurd terracotta, glas, ruiten, tapijt en bedden; muren, ijzeren tralies, ladders, kisten,
  lantaarns; ertsen en opslagblokken; hooibaal, pompoen, meloen, ijs, bloemen, paddenstoelen, saplings en suikerriet.
- **Tools:** hout, steen, ijzer, goud en diamant met de echte snelheid en duurzaamheid; zwaard 4/5/6/4/7 schade, bijl 7/9/9/7/9,
  houweel 2/3/4/2/5, schop 2,5-5,5, schoffel 1. Schaar (wol, bladeren, spinnenweb). Gouden gereedschap is het snelst maar heeft oogstniveau hout.
- **Gereedschap gebruiken (rechtermuisknop):** schoffel maakt akkergrond van gras en aarde (en aarde van grof aarde), schop maakt paden,
  bijl stript logs, schaar snijdt een pompoen uit (en geeft zaden).
- **Ertsen:** koper en lapis vragen steen, redstone en smaragd ijzer, goud en diamant ijzer; opbrengst koper 2-5 rauw koper, lapis 4-9, redstone 4-5.
  IJzer, goud en koper geven rauw erts dat je smelt.
- **Harnas:** helm, borstplaat, broek en schoenen van leer, maliën, ijzer, goud en diamant (maliën alleen in creative). Rechtermuisknop
  met een stuk in de hand draagt het; de survival-inventory heeft vier harnasslots (shift-klik werkt ook). De armor-balk toont 0-20 punten;
  schade wordt verminderd met `min(20, max(armor/5, armor − schade/(2 + toughness/4)))/25`, en elk stuk verliest `max(1, ⌊schade/4⌋)` duurzaamheid.
  Val, verdrinken, honger, de void en gif negeren harnas.
- **Voedsel:** appel, brood, koekje, aardappel en gebakken aardappel, wortel, gouden appel en wortel, meloenschijf, pompoentaart, paddenstoelenstoofpot
  (geeft de kom terug), vis, bessen, bieten, konijn, met de vanilla-waarden.
- **Kist:** 27 slots, rechtermuisknop opent, shift-klik verplaatst stapels, breken laat de inhoud vallen. Opgeslagen per wereld; **alleen singleplayer**
  (de multiplayer-server bewaart geen containers; daar kun je geen kist plaatsen).
- **Bed:** twee blokken, rechtermuisknop zet je respawnpunt en slaapt 's nachts door tot de ochtend (singleplayer).
- **Ladder:** klimmen met springen of tegen de muur aan lopen, sneaken houdt je vast; hekken en muren zijn 1,5 blok hoog.
- **Recepten:** ongeveer 420, met vanilla-aantallen. Het receptenboek heeft tabs (Now, All, Build, Wood, Tools, Combat, Food, Items, Colors, Smelt)
  en een zoekveld; alleen recepten van stations binnen 4 blokken worden getoond.

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

## Groei en vallende blokken

Random ticks zoals Minecraft (`randomTickSpeed` 3): elke tick krijgen per 16³-sectie binnen 8 chunks van de speler (server: 3 chunks
rond elke speler) 3 willekeurige blokken een tick. Secties zonder iets dat groeit worden overgeslagen; een tijdbudget (0,5 ms) en
een maximum aan blokwijzigingen per tick houden het goedkoop, wat niet past gaat de volgende tick verder.

| Wat | Regel |
|---|---|
| Sapling | 7 houtsoorten (eik, spar, berk, jungle, acacia, dark oak, kers). Licht ≥ 9 boven de sapling (nacht telt mee), kans 1/7 per random tick op een volgende fase; fase 2 wordt een boom als de stam ruimte heeft. Alleen te planten op aarde, gras, podzol, grof zand-aarde, mycelium, mos, modder of farmland |
| Bomen | Eik 4–6, berk 5–7, spar 6–9, jungle 6–9 (ronde kruin), acacia 5–6 (geknikte stam, platte kruin), dark oak en kers met een brede kruin. Jungle en dark oak groeien hier uit één sapling (Minecraft: 2×2) |
| Bladverval | Bladeren die via andere bladeren meer dan 6 stappen van een stam zitten vallen weg bij een random tick (drop: sapling 5 %, jungle 2,5 %, stokken, appel 0,5 % bij eik en dark oak). Zelf geplaatste bladeren blijven altijd |
| Gras en mycelium | Verspreiden naar aarde binnen (±1, −3..+1, ±1) bij licht ≥ 9, 4 pogingen per tick; onder een ondoorzichtig blok of onder vol water wordt het aarde |
| Suikerriet, cactus | Leeftijd 0–15, groeit tot 3 hoog. Riet heeft water naast zijn grond nodig, cactus zand en geen blok ernaast (anders breekt hij en valt als item) |
| Paddenstoelen | 1/25 kans per tick om zich te verspreiden in het donker (licht < 13), hooguit 5 in een gebied van 9×3×9 |
| IJs | Water aan de oever bevriest in koude biomen (sneeuwbiomen en boven de sneeuwgrens), smelt bij bloklicht > 11 |
| Bone meal | Sapling: 45 % kans op een groeifase. Gras: strooit gras en bloemen rondom. Wordt in survival verbruikt |
| Vallend zand en grind | Zand, rood zand en grind zonder steun vallen 2 ticks na een wijziging ernaast (zwaartekracht 0,04/tick², 2 % weerstand). Breekt fakkels en bloemen waar het landt; kan het niet landen dan wordt het een item. Hooguit 128 tegelijk |
| Planten zonder grond | Saplings, riet en cactus breken (met drop) zodra hun grond verdwijnt; een rietstengel valt helemaal om |

In multiplayer rekent de server alles uit en stuurt de wijzigingen in dezelfde batch als stromend water; leeftijden en groeifases
gaan niet over het net (ze veranderen niets aan wat je ziet). Vallende blokken komen als apart `fall`-bericht. Zie
[`docs/screenshots/growth-trees.png`](screenshots/growth-trees.png), `growth-leaf-decay.png`, `growth-falling-sand.png` en `growth-cane-cactus.png`.

**Voor andere systemen (landbouw):** `RandomTicker.register(blockId, (w, x, y, z) => …)` voegt gedrag toe zonder `RandomTicks.ts` aan te
passen (`w.setBlock`, `w.setMeta` voor een stille leeftijd, `w.brightness`, `w.randomInt`, `w.breakBlock`); `registerBoneMeal` en
`registerSupportedPlant`/`registerBlockUpdate` (`BlockUpdates.ts`) werken op dezelfde manier.

## Roadmap

1. **Block states:** **gedaan** voor slabs, trappen, deuren en vloeistoffen ([`BLOCKSTATES.md`](BLOCKSTATES.md)); ladders, muurfakkels, gewassen en een oven met een richting volgen op dezelfde basis.
2. **Vloeistofstroming:** **gedaan** (water en lava, emmers).
3. **Vallend zand en grind** als entity.
4. **Meer mobs:** skeleton (pijlen) en spin (klimmen).
5. **Meer blokken en items:** XP-orbs en de XP-balk, landbouw met groeifases, enchanting (de `ItemStack.data` is er klaar voor), brouwen, anvil, schilden en boten (zie `CONTENT.md`, tier 2).
6. **Multiplayer:** zie [`MULTIPLAYER.md`](MULTIPLAYER.md).

## Bronnen

- Minecraft Wiki: [Game mode](https://minecraft.wiki/w/Game_mode), [Health](https://minecraft.wiki/w/Health), [Hunger](https://minecraft.wiki/w/Hunger), [Damage](https://minecraft.wiki/w/Damage), [Mob spawning](https://minecraft.wiki/w/Mob_spawning), [Zombie](https://minecraft.wiki/w/Zombie), [Creeper](https://minecraft.wiki/w/Creeper), [Pig](https://minecraft.wiki/w/Pig), [Cow](https://minecraft.wiki/w/Cow), [Sheep](https://minecraft.wiki/w/Sheep), [Chicken](https://minecraft.wiki/w/Chicken), [Lava](https://minecraft.wiki/w/Lava), [Torch](https://minecraft.wiki/w/Torch), [Breaking](https://minecraft.wiki/w/Breaking), [Item (entity)](https://minecraft.wiki/w/Item_(entity)), [Heads-up display](https://minecraft.wiki/w/Heads-up_display)
