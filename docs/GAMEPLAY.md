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
