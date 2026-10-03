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
| Verhongeren | 1 per 4 s bij honger 0 (Easy tot 10 HP, Normal tot ½ hartje, Hard en Hardcore dodelijk) |

- **Onkwetsbaarheid:** 10 ticks na een treffer. Een zwaardere klap telt alleen voor het verschil.
- **Uitputting:** sprinten 0,1/m, springen 0,05 (sprint-sprong 0,2), blok breken 0,005, zwemmen 0,01/m, schade 0,1. Elke 4 punten uitputting kost eerst saturatie, daarna honger.
- **Regeneratie:** 1 HP per 80 ticks bij honger ≥ 18, of per 10 ticks bij volle honger met saturatie.
- **Sprinten:** niet mogelijk bij honger ≤ 6.

## Schade, moeilijkheid en game rules (Foundation 3)

**Eén schade-pijplijn** (`src/player/Damage.ts`, DOM-vrij, gedeeld door client, server en tests). Alle schade aan speler
én mobs gaat door `dealDamage` met een getypte `DamageSource` (`mob`, `player`, `arrow`, `explosion`, `fall`, `fire`,
`lava`, `drown`, `cactus`, `void`, `suffocate`, `starve`, `poison`, `wither`, `magic`, `lightning`, `anvil`, `generic`),
in de volgorde van Minecraft:

1. game rules (`fallDamage`, `fireDamage`, `drowningDamage`) en Fire Resistance;
2. moeilijkheid (alleen mob-schade aan de speler): Peaceful ×0, Easy `min(D/2+1, D)`, Normal ×1, Hard ×1,5;
3. onkwetsbaarheid (10 ticks; een zwaardere klap telt alleen voor het verschil);
4. schild (`blocked`-hook);
5. enchantment-hooks fase `pre` (`registerDamageModifier`);
6. harnas: `schade × (1 − min(20, max(armor/5, armor − 4·schade/(toughness+8)))/25)`, slijtage `max(1, floor(schade/4))` per stuk;
7. Resistance (−20 % per level; niet tegen void en verhongeren);
8. enchantment-hooks fase `post` (Protection-types, Feather Falling: `protectionFactor(epf)` helpt);
9. absorption, dan health.

Doodsberichten volgen Minecraft ("Stijn was slain by Zombie", "was shot by Skeleton", "blew up", "fell from a high
place", "tried to swim in lava", "withered away", ...). In singleplayer verschijnen ze in de chat (`showDeathMessages`).

**Moeilijkheid** per wereld (Create World, pauzemenu, `/difficulty` voor ops; opgeslagen in `WorldMeta` en `world.json`,
naar clients via `welcome` en het `rules`-bericht). Hardcore staat altijd op Hard.

| | Peaceful | Easy | Normal | Hard |
|---|---|---|---|---|
| Vijandige mobs | verdwijnen, spawnen niet | ja | ja | ja |
| Mob-schade | 0 | `min(D/2+1, D)` | D | 1,5·D |
| Honger | vult zich, ~1 HP/s herstel | | | |
| Verhongeren tot | n.v.t. | 10 HP | ½ hartje | dood |

**Game rules** (`src/world/GameRules.ts`, getypte tabel; alleen afwijkingen worden opgeslagen): `keepInventory`,
`doMobSpawning`, `doDaylightCycle`, `doWeatherCycle`, `randomTickSpeed`, `naturalRegeneration`, `fallDamage`,
`fireDamage`, `drowningDamage`, `mobGriefing` (creeper-blokschade; TNT breekt altijd), `showDeathMessages`,
`playersSleepingPercentage`. `/gamerule <naam> [waarde]` in singleplayer en voor ops op de server; scherm "Game Rules"
in Create World (tab World) en in het pauzemenu (singleplayer). `randomTickSpeed` is alleen gedefinieerd
(`rules.get('randomTickSpeed')`) voor het random-tick-systeem.

## Gevecht (1.9+)

- **Attack cooldown** (`src/player/Melee.ts`): `T = 20/snelheid` ticks; schade × `0,2 + ((t+0,5)/T)² × 0,8`.
  Snelheden: zwaard 1,6; bijl hout/steen 0,8, ijzer 0,9, diamant/goud 1,0; houweel 1,2; schop 1,0; schoffel 1–4; hand 4.
  Wisselen van item of in de lucht slaan reset de cooldown. Een balkje onder het richtkruis toont de lading.
- **Crit:** vallend, niet sprintend, niet in water en ≥ 84,8 % geladen: ×1,5 met een vonkenregen.
- **Sprint-knockback:** sprintend met volle lading (nooit samen met een crit of sweep).
- **Sweep:** zwaard, op de grond, geladen: 1 schade aan mobs binnen 1 blok van het doelwit.
- **Server:** de server telt de cooldown zelf per speler (laatste klap, laatste itemwissel uit `held`) en schaalt de schade
  net zo; spam-klikken levert alleen de zwakke klappen op. Crits op de server: niet op de grond, niet sprintend en dalend.
- **Schild** (id 339, 336 duurzaamheid, 6 planken + 1 ijzer): Use ingedrukt houden (5 ticks opwarmen) blokkeert mob-,
  pijl- en explosieschade uit een boog van 100° vóór je; je loopt dan op sluipsnelheid. Vanaf 3 schade slijt het
  schild `1 + floor(schade)`. Een bijl zet het 5 s uit (`onShieldBlock(…, true)`; wacht op PvP of bijl-mobs).
- **Strength/Weakness** tellen mee (+3 / −4 per level).

## Bedden, spawnpunt en slapen

- Rechtsklik op een bed zet altijd je spawnpunt ("Respawn point set"), per speler opgeslagen (`WorldMeta.bed`,
  server-record `bed`). Slapen kan alleen 's nachts of bij onweer ("You can only sleep at night") en niet met vijandige
  mobs binnen 8 blokken horizontaal en 5 verticaal ("You may not rest now, there are monsters nearby").
- Slapen: het scherm wordt zwart; na 100 ticks wordt het ochtend en klaart het weer op. Sluipen of springen = uit bed.
- Multiplayer: de server telt slapers; de nacht gaat voorbij zodra `playersSleepingPercentage` (standaard 100 %) van de
  spelers 100 ticks slaapt. Weglopen van het bed maakt je wakker.
- Respawn: naast het bed (eerst naast het hoofdeinde), anders bovenop. Is het bed weg of geblokkeerd, dan
  "Your home bed was missing or obstructed" en terug naar het wereldspawnpunt. `/spawnpoint [naam]` (ops; in
  singleplayer altijd) zet het spawnpunt op je huidige plek.

## Statuseffecten

`src/player/Effects.ts`: Speed, Slowness, Haste, Mining Fatigue, Strength, Weakness, Instant Health/Damage, Jump Boost,
Regeneration, Resistance, Fire Resistance, Water Breathing, Invisibility, Night Vision, Hunger, Poison, Wither,
Absorption, Saturation, Levitation. Amplifier + duur in ticks; een sterker effect vervangt een zwakker, een gelijk
effect alleen als het langer duurt.

| Effect | Regel |
|---|---|
| Regeneration | 1 HP per `50 >> amp` ticks |
| Poison | 1 schade per `25 >> amp` ticks, nooit onder ½ hartje |
| Wither | 1 schade per `40 >> amp` ticks, kan doden |
| Hunger | +0,005 × level uitputting per tick |
| Saturation | +level honger en saturatie per tick |
| Instant Health / Damage | `4 << amp` herstel / `6 << amp` schade |
| Absorption | `4 × level` extra HP (gouden hartjes) zolang het effect duurt |
| Speed / Slowness | +20 % / −15 % loopsnelheid per level |
| Haste / Mining Fatigue | +20 % per level / ×0,3, 0,09, 0,0027, 0,00081 mijnsnelheid |
| Jump Boost | sneller springen, level blokken minder valschade |
| Levitation | stijgen met 0,9 blok/s per level |
| Resistance, Fire Resistance, Water Breathing | in de schade-pijplijn en het lucht-systeem |
| Night Vision, Invisibility | alleen icoon (cosmetisch, nog geen render-effect) |

Iconen met timer rechtsboven (procedureel getekend, laatste 10 s knipperend). Spinnenoog geeft Poison via dit systeem;
een gouden appel Regeneration II (5 s) en Absorption (2 min). `/effect give|clear` in singleplayer, op de server voor ops
en in creative. Effecten zijn client-autoritatief (net als health en honger) en gaan mee in `state` en het spelerrecord.

Schermafdrukken: `docs/screenshots/survival-*.png` (`scripts/survival-shots.py`).

## Mobs

| Mob | HP | Hitbox | Gedrag | Drops |
|---|---|---|---|---|
| Varken | 10 | 0,9×0,9 | dwalen, vluchten bij schade | 1–3 rauw varkensvlees |
| Koe | 10 | 0,9×1,4 | dwalen, vluchten | 1–3 rauw rundvlees |
| Schaap | 8 | 0,9×1,3 | dwalen, vluchten | 1 witte wol, 1–2 schapenvlees |
| Kip | 4 | 0,4×0,7 | dwalen, fladderen, geen valschade | 1 kip, 0–2 veren |
| Zombie | 20 | 0,6×1,95 | achtervolgen, slaan (3), brandt in de zon | 0–2 rot vlees |
| Creeper | 20 | 0,6×1,7 | achtervolgen, 1,5 s opzwellen, explosie (kracht 3) | 0–2 buskruit |
| Skelet | 20 | 0,6×1,99 | afstand houden, pijlen schieten, brandt in de zon | 0–2 botten, 0–2 pijlen |
| Spin | 16 | 1,4×0,9 | klimt, springt, neutraal bij helder licht | 0–2 draad, soms een spinnenoog |

- **Spawnen** (`src/entities/MobSpawner.ts`, dezelfde code in singleplayer en op de server):
  - Dieren: bij het genereren van een grasrijke chunk komt in een kwart van de chunks een groepje van 2–4 (gewichten schaap 12, varken 10, kip 10, koe 8; vaste kans per seed en chunk). Daarnaast vult elke 10 s overdag een nieuw groepje aan tot ongeveer 28 dieren in de buurt, met een wereldplafond van 80.
  - Monsters: twee spawnpogingen per tick per speler, 24–48 blokken weg, nooit dichterbij. Op elke vloer met twee vrije blokken erboven (gras, bloemen en tufjes tellen als vrij), bij block light 0 en een sky light min de duisternis van de dag ≤ willekeurig 0..7. Dat geldt 's nachts overal buiten en altijd in grotten en andere donkere plekken.
  - Helft van de pogingen kijkt naar het oppervlak, de andere helft naar willekeurige diepte (tot 40 blokken onder de speler), zodat grotten ook overdag spawnen.
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

## Roadmap

1. **Block states:** **gedaan** voor slabs, trappen, deuren en vloeistoffen ([`BLOCKSTATES.md`](BLOCKSTATES.md)); ladders, muurfakkels, gewassen en een oven met een richting volgen op dezelfde basis.
2. **Vloeistofstroming:** **gedaan** (water en lava, emmers).
3. **Vallend zand en grind** als entity.
4. **Meer mobs:** skeleton (pijlen) en spin (klimmen).
5. **Meer blokken en items:** XP-orbs en de XP-balk, landbouw met groeifases, enchanting (de `ItemStack.data` is er klaar voor), brouwen, anvil, schilden en boten (zie `CONTENT.md`, tier 2).
6. **Multiplayer:** zie [`MULTIPLAYER.md`](MULTIPLAYER.md).

## Bronnen

- Minecraft Wiki: [Game mode](https://minecraft.wiki/w/Game_mode), [Health](https://minecraft.wiki/w/Health), [Hunger](https://minecraft.wiki/w/Hunger), [Damage](https://minecraft.wiki/w/Damage), [Mob spawning](https://minecraft.wiki/w/Mob_spawning), [Zombie](https://minecraft.wiki/w/Zombie), [Creeper](https://minecraft.wiki/w/Creeper), [Pig](https://minecraft.wiki/w/Pig), [Cow](https://minecraft.wiki/w/Cow), [Sheep](https://minecraft.wiki/w/Sheep), [Chicken](https://minecraft.wiki/w/Chicken), [Lava](https://minecraft.wiki/w/Lava), [Torch](https://minecraft.wiki/w/Torch), [Breaking](https://minecraft.wiki/w/Breaking), [Item (entity)](https://minecraft.wiki/w/Item_(entity)), [Heads-up display](https://minecraft.wiki/w/Heads-up_display)
