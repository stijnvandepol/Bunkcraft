# BunkCraft verbeterplan

Samenvatting van drie onderzoeken (oktober 2026): een bug-review van de gameplay-code, een
engine- en performance-audit, en een game-design- en distributie-analyse. **Gedaan** staat bij
wat al is doorgevoerd.

## 1. Bugs (code-review)

| # | Bug | Status |
|---|---|---|
| 1 | Respawn in een niet-geladen spawn-chunk: speler wordt 64 blokken omhoog gezet, stikt en sterft opnieuw | **Gedaan:** respawn gaat via het laadpad; ongeladen chunks laten je niet stikken |
| 2 | Hardcore-leven te omzeilen door het tabblad te sluiten op het doodscherm; dode saves "genezen" | **Gedaan:** hardcore wordt direct spectator; een dode save respawnt bij de spawn |
| 3 | `suppressPause` kon blijven hangen, waardoor Esc niets meer deed | **Gedaan** |
| 4 | De wereld bleef doorlopen achter "Click to play" (mobs, honger) | **Gedaan:** de game staat dan op pauze |
| 5 | Eén log telde als ingrediënt én brandstof (gratis kolen) | **Gedaan:** ingrediënten worden gesimuleerd afgeboekt |
| 6 | Doodgaan met de inventory open stelde het doodscherm uit | **Gedaan** |
| 7 | Items op de inventory-cursor gingen verloren bij het sluiten van het tabblad | **Gedaan** |
| 8 | Death-drops verdwenen bij de entity-limiet | **Gedaan** |
| 9 | In het water springen terwijl je brandt gaf 1 schade | **Gedaan** |
| 10 | Brandende zombies huppelden elke seconde | **Gedaan** |
| 11 | Mobs met één oog (schaap: pupillen samengesmolten, kip: één oog overschreven) en koppen die zijwaarts bleven staan | **Gedaan:** ogen per gezichtsbreedte, kop-blikken blijven binnen 20° en zakken terug |
| 12 | Te weinig dieren en monsters: één spawnpoging per seconde, plafond 16, planten telden als geblokkeerd | **Gedaan:** `MobSpawner` met pakken, plafond 40 en groepjes dieren; zie `docs/GAMEPLAY.md` |
| 11 | Zombies sloegen en creepers ontploften door muren heen | **Gedaan:** line-of-sight-check |
| 12 | Gedropte items voegden samen voorbij hun stackgrootte | **Gedaan** |
| 13 | Explosies lieten erts- en glasblokken als zichzelf vallen | **Gedaan:** normale drop-regels |
| 14 | Wisselen van eten tijdens het eten behield de voortgang | **Gedaan** |
| 15 | Explosies lieten fakkels en bloemen zweven | **Gedaan** |

## 2. Engine en robuustheid

| Item | Status / effort |
|---|---|
| Save: de dirty-set werd geleegd vóór de commit; mislukte writes gingen verloren | **Gedaan** |
| IndexedDB `onblocked`: een tweede tabblad liet de start hangen | **Gedaan** |
| WebGL context loss: pauzeren, melding tonen, herstellen | **Gedaan** |
| Leeg scherm als de renderer niet kan starten | **Gedaan:** foutmelding |
| Audio pauzeren in een verborgen tabblad, geen inhaalstap bij terugkomst | **Gedaan** |
| De shadow map werd bij elke verre chunk-upload opnieuw gerenderd | **Gedaan:** alleen chunks binnen het schaduwbereik |
| Elke blokwijziging remesht 9 chunks, met een volledige lichtberekening (~2,6 MB kopiëren) | **Gedaan:** alleen buren die de bewerking raken (rand) worden direct opnieuw gemesht; de overige alleen als het randlicht van de bewerkte chunk veranderde (`ChunkManager.propagateLight`). Gemeten over 48 bewerkingen (sterk licht en rand-gevallen): 8,7 → 4,4 mesh-jobs en 41 → 21 ms workertijd per bewerking; een steen in open lucht: 8,6 → 1 job. Het licht komt overeen met een volledige remesh (0 afwijkingen in 57 chunks). Een persistente lichtcache per chunk is niet gedaan |
| Allocaties per frame (`rayHit`-arrays, closures, template-strings, iterators) | **Gedaan:** `rayHit` uitgerold, iterators/closures/vectoren weg uit `MobRenderer`, `RemotePlayers`, `Game`, `Interaction`; `World.chunkAt` heeft een cache (de `chunkKey` valt buiten het Smi-bereik, dus elke `Map.get` alloceerde een heap-getal). Heap-sampling met 29 mobs + 43 items: 58 → 25 KB/frame |
| Lege mob-meshes nog steeds in de render-loop; `getLight` per mob per frame | **Gedaan:** mobtypes zonder instances worden niet getekend, mobs voorbij de mist-afstand worden overgeslagen, licht wordt per entity maar elke 6 frames opnieuw opgevraagd |
| Gedeelde GLSL voor licht en mist (5 kopieën lopen nu uiteen; entities missen de onderwater-mist) | **Gedaan:** `LIGHT_GLSL`, `FOG_GLSL` en `ATLAS_GLSL` in `Materials.ts`; mobs, items, deeltjes en pijlen gebruiken nu dezelfde lichtcurve en mist (incl. zonsondergang-gloed en onderwater-mist), de hand dezelfde lichtcurve. Items zijn in schemerige gebieden iets donkerer (ze volgen nu de curve van de blokken) |
| Worker-crash: jobs blijven "in flight" en het streamen stopt | **Gedaan:** worker vervangen, job opnieuw ingepland (max. 3 pogingen, daarna laat `ChunkManager` de chunk opnieuw proberen); Vitest met nep-worker |
| Grotten, ravijnen en ertsen (feedback: "geen grotten en grotingangen te zien") | **Gedaan:** generator versie 2 (`CaveCarver.ts`, `OreTable.ts`): cheese, spaghetti, noodle, ingangen in heuvels, ravijnen met lava/water, aquifer-meren met barrières, lavameren onder y 10, ertsblobs uit één tabel. Grotopeningen per 100 landchunks 13 → 56, lucht onder zeeniveau 7,4 → 11,7 %, `generate` 1,4–1,6× (zie RESEARCH.md §4). Zee, kust en bedrock blijven heel; geen bomen boven gaten |
| Generatorversies (`genVersion`) zodat een nieuwe generator bestaande werelden niet stuk maakt | **Gedaan:** `WorldMeta.genVersion` (save-versie 3, zonder = 1), `world.json`, optioneel veld in `welcome`, `generate`-verzoek. Versie 1 blijft bitgelijk (golden hashes). Nieuwe wereld = versie 2 |
| Ertsen voor nieuwe blokken (lapis, redstone, koper, smaragd) | S: de rijen staan al in `ORE_TABLE` met `minGen: 3`; zodra de blokken bestaan `GEN_VERSION_CURRENT` op 3 zetten en golden hashes bijwerken |
| Dripstone, mos en andere grotbiomes; deepslate-laag onder y ~8 | M (wacht op blokken) |
| `Game.ts` (~1000 regels) opsplitsen: GameStateMachine, WorldSession, SimulationLoop, Combat, DebugInfo | M |
| Save-formaatversie en migraties, nodig vóór block states | **Gedaan:** `version` op `WorldMeta` en op de chunk-edit-records, lijst `MIGRATIONS` + `migrateMeta`, nieuwere records worden overgeslagen i.p.v. verkeerd gelezen; Vitest met `fake-indexeddb`. **Versie 2 (block states):** edit-record `index << 16 \| meta << 8 \| id`, v1-records worden met meta 0 gelezen (`decodeEdit`); `world.json` op de server bewaart `id \| meta << 8`, oude bestanden blijven geldig |
| Meshtijd na block states (`scripts/bench-mesh.ts`, seed 12345, 25 chunks) | **Gedaan:** 3,55 ms gemiddeld per chunk tegen 3,96 ms ervoor (gemeten afwisselend op dezelfde machine): de nieuwe vormen zijn betaald met een snellere skylight-kolom (`LIGHT_COLUMN`, 1 opzoeking) en een allocatievrije regio-kopie. Meta kost niets zolang een chunk er geen heeft (lazy; altijd alloceren: 10 MB bij render distance 8 en +0,1 ms per mesh) |
| Instellingen valideren (min/max/enum) uit `localStorage` | **Gedaan:** `sanitizeSettings` begrenst getallen op het bereik van het menu, valideert enums, negeert onbekende sleutels; Vitest |
| Standaardpreset kiezen op basis van de hardware | **Gedaan:** GPU-naam, cores en `deviceMemory` bij de eerste start (software-GPU, Intel HD/UHD, Mali, Adreno → Low) |
| Dynamische resolutie voor zwakke GPU's en Retina | **Gedaan:** interne resolutie zakt bij < 48 FPS tot 0,5 px per CSS-pixel, en stijgt weer bij headroom. Software-GPU op Medium: 11–16 → 26–28 FPS |
| Menu-blur (`backdrop-filter`) kostte zwakke GPU's het grootste deel van de frame | **Gedaan:** uit bij Fast of verlaagde resolutie (pauzemenu op een software-GPU: 14 → 45 FPS); `-webkit-`-prefix voor Safari < 18 |
| Shadow map begrenzen op `maxTextureSize` | **Gedaan:** `ShadowRenderer.configure` klemt de grootte op `capabilities.maxTextureSize` |
| Bij minimale resolutie en nog steeds traag: render distance tijdelijk verlagen | S |

## 3. Testen en tooling

- **Vitest** voor de DOM-vrije modules (`npm test`, tests in `tests/`):
  - terrein-determinisme (golden hashes): **Gedaan**;
  - mesher (1 kubus = 6 quads, een vloer van 15×15 = 1 quad; 16×16 = 4 quads door de merge-limiet van 15): **Gedaan**;
  - collision en raycast: **Gedaan**;
  - PlayerStats-regels: **Gedaan**;
  - inventory, recepten en mining-regels: **Gedaan**;
  - SaveSystem met `fake-indexeddb`: nog open.
- **CI** met GitHub Actions: typecheck, tests en build op elke push en PR: **Gedaan** (`.github/workflows/ci.yml`). Lint (Biome) nog open.
- **Bundel:** three.js in een aparte vendor-chunk, zodat die over deploys heen gecachet wordt.

## 4. Gameplay en motivatie (op volgorde van plezier per moeite)

1. **Elke drop een nut geven (S):**
   - goud-ingot en gouden tools: **Gedaan** (goudeerts smelten; snelheid 12, duurzaamheid 32, oogstniveau hout);
   - TNT (5 buskruit + 4 zand), Flint and Steel (ijzer + vuursteen): **Gedaan** (lont 80 ticks, kracht 4, kettingreactie met korte lont, onder water geen blokschade). In multiplayer blijft TNT inert tot de server explosies synchroniseert;
   - vuursteen: **Gedaan** (grind, 10%);
   - bed (wol + planken: spawnpunt en nacht overslaan): kan nu, block states zijn er (een bed is 2 blokken met een richting, net als een deur: `meta` met richting + helft);
   - pijl en boog: **Gedaan** (boog: 3 stokken + 3 draad, 384 gebruik, kracht (f²+2f)/3, kritiek bij volle spanning, FOV-zoom; pijl: vuursteen + stok + veer → 4, zwaartekracht 0,05/tick, blijft steken en is op te rapen).
2. **Advancements (S–M):** **Gedaan** (`src/player/Advancements.ts`, 10 stuks met de officiële 1.21-teksten: Minecraft, Stone Age, Getting an Upgrade, Acquire Hardware, Isn't It Iron Pick, Diamonds!, Ice Bucket Challenge, Adventure, Monster Hunter, Take Aim). Toast rechtsboven met geluid, Advancements-scherm via het pauzemenu (tabs, boom, tooltips, x/y), opgeslagen per wereld in `WorldMeta.advancements`. Alleen in survival/hardcore en niet in multiplayer (daar blijft het uit, tot de server ze in het spelersrecord bewaart). Bewust weggelaten: advancements die niet in 1.21 bestaan (Getting Wood, Benchmarking, Time to Mine!) en alles wat emmers, bed, harnas, enchanting, fokken of een crossbow nodig heeft. Sniper Duel (skelet op 50 m) en de Husbandry-tab volgen met die inhoud.
3. **Kisten met loot (M): Gedaan als basis.** Block entities (`src/world/BlockEntities.ts`), dubbele kisten, loot-tabellen met seed (`src/items/Loot.ts`: `dungeon_chest`, `mineshaft_chest`, `village_chest`, `spawn_bonus_chest`) en `BlockEntityStore.setLoot()` / `lootAt` voor structuurkisten die bij de eerste keer openen rollen. Open: structuren die ze plaatsen, mob-drops omzetten naar `rollLoot`.
4. **Block states (L):** **Gedaan** (ontwerp in [`BLOCKSTATES.md`](BLOCKSTATES.md)).
   - Een `meta`-byte per blok in een lazy `Chunk.meta`, door de generatie-workers, de mesher, botsing, raycast, save (record v2 + migratie) en netwerk (protocol 4) heen.
   - **Slabs en trappen** (9 materialen, Minecraft-plaatsingsregels, hoekvormen afgeleid uit de buren, loopt omhoog met stap 0,6) en de **eikenhouten deur** (2 blokken, scharnier, open/dicht, breekt samen).
   - **Stromend water en lava** met de Minecraft 1.21-regels (water 7 blokken per 5 ticks, lava 3 blokken per 30 ticks, oneindige bron, obsidiaan/cobblestone, vallend water) en **emmers** (ijzeren emmer, water- en lavaemmer). Budget van 600 updates en 200 blokwijzigingen per tick; in multiplayer simuleert de server.
   - Nog te doen op deze basis: **ladders, muurfakkels, gewassen** (groeifase in `meta`), **oven met een richting** (en een brandende staat), **bed** (2 blokken), vallend zand en grind, waterlogged slabs, stroming die entities meeduwt, lava-fakkels/vuur, trapdoors en hekken (zelfde `partial`-machinerie).
   - Bewust anders dan Minecraft: de trapvorm wordt afgeleid uit de buren (niet opgeslagen) en lava vertraagt niet willekeurig (`random.nextInt(4)`).
5. **Landbouw (M):** saplings (**gedaan**), tarwe, brood en een schoffel. Hernieuwbaar hout en voedsel.
6. **Meer survival-inhoud (M):** harnas met een armor-bar: **Gedaan** (zie §4b). XP-orbs met een XP-balk, enchanting, anvil en grindstone: **Gedaan** (zie §4c). Skeleton (schiet elke 2 s, verbrandt in daglicht; drops botten en pijlen) en spin (klimt, springt, neutraal in fel licht; drops draad en spinnenoog met Poison) zijn **Gedaan**.
7. **Structuren (M per stuk):** dungeon met spawner en kisten, mijnschachten, later dorpen.
8. **Eindspel (L):** een "Underworld"-dimensie of een stronghold met een eindbaas en credits.

## 4b. Inhoud van Minecraft 1.21 (creative inventory en wat je ermee kunt)

Ontwerp, tellingen en tier-lijst: [`CONTENT.md`](CONTENT.md). **Gedaan:**

- **Item-identiteit voor varianten:** item-id's ≥ 1024 zijn `blok + variantbits`, kleuren en materialen zitten in de `meta`-byte (geen nieuwe
  blok-id's per kleur). Dyed blokken gebruiken één grijze textuur met een tint per hoekpunt in de mesher (0 extra lagen, meshtijd gelijk:
  3,5-3,8 ms per chunk tegen 3,5-3,7 ms ervoor). Slabs, trappen, deuren, hekken, luiken, poorten en muren hebben het materiaal in de state.
- **`ItemStack.data`** (enchants en dergelijke) is er, wordt opgeslagen en over het netwerk meegestuurd; stapels met verschillende data voegen nooit samen.
- Harnas (armor-balk, schadeformule, slijtage), schoffel, schaar, tooluse (akkergrond, paden, strippen, pompoen snijden), kist (27 slots), bed, ladder.
- Creative inventory met tabs, scrollen, zoeken en tooltips; receptenboek met tabs en zoeken; ~420 recepten.
- **Nog te doen (tier 2):** landbouw (tarwe, wortels en aardappels, hoofdreden dat brood, koekjes en modderstenen nog niet te maken zijn), brouwen, smithing en
  netherite, blast furnace, smoker, schild, hengel, kaarsen, banners, koraal, ruitjes met doorzichtigheid (gekleurd glas is alpha-getest),
  kisten in multiplayer, een echte kist-animatie, kisten met richting-afhankelijke dubbele variant, vallend zand en grind, en dat de worldgen de nieuwe blokken
  (graniet, diorite, andesiet, tuff, calciet, deepslate, nieuwe ertsen, bloemen, junglebomen) nog moet plaatsen.

## 4c. Ervaring en enchanting (klaar)

Screenshots: `docs/screenshots/xp-bar-orbs.png`, `enchanting-table.png`, `sword-tooltip.png`, `anvil.png`, `grindstone.png`, `enchant-blocks.png`
(`scripts/enchant-shots.py`).

- **XP:** `src/player/Experience.ts` (formules van de wiki, getest per tabelwaarde), orbs als entity (`src/entities/XpOrb.ts`, 11 groottes,
  aantrekking binnen 8 blokken, samenvoegen, 5 minuten levensduur, pulserend groen/geel, `XpOrbRenderer`: één draw call). Bronnen: mobs
  (monsters 5, dieren 1–3), ertsen (kolen 0–2, lapis 2–5, redstone 1–5, diamant en smaragd 3–7, niet met Silk Touch), oven (via de
  `onFurnaceXp`-hook van de block entities: orbs bij de speler), grindstone. Hooks: `awardXp(entities, x, y, z, n)`, `breedingXp`, `fishingXp`,
  `SMELT_XP`. XP-balk en level boven de hotbar, plingetje bij oppakken, klokje elk 5e level. Dood: `min(7 × level, 100)` als orbs
  (een `keepInventory`-gamerule op `WorldMeta.rules` slaat dit over). Opgeslagen als `stats[5]` (punten) en `stats[6]` (enchant-seed).
- **Enchantments:** 25 stuks (`src/items/EnchantRules.ts`) met vanilla max-levels, conflicten, gewichten en anvil-kosten; effecten op
  breken (Efficiency, Aqua Affinity, Silk Touch, Fortune), drops (Looting, brandende dieren laten gebakken vlees vallen), melee (Sharpness,
  Smite, Bane, Knockback, Fire Aspect), boog (Power, Punch, Flame, Infinity), slijtage (Unbreaking), harnas (Protection-familie als `post`-modifier via
  `registerDamageModifier` in `Damage.ts`, Thorns, Respiration, Depth Strider) en Mending. Paarse glint op iconen (CSS-mask), hotbar, hand en
  gevallen items (shader); tooltips met romeinse cijfers, aqua naam, cursief bij een eigen naam.
- **Blokken:** enchanting table (250), anvil (251, met chipped/damaged als variant, 12% slijtage per gebruik) en grindstone (252) als
  box-modellen met procedurele textures, recepten en creative-items. Enchanting table: boekenkasten in de 5×5-ring (max 15), drie aanbiedingen
  met Minecraft's algoritme, seed per speler, glyph-tekst. Anvil: repareren met materiaal, combineren, boeken, hernoemen, prior-work-straf,
  "Too Expensive!" vanaf 40. Grindstone: haalt enchantments weg en geeft XP terug. `/enchant <naam> [level]` en `/xp <n>[L]` (creative).
- **Nog te doen:** Sweeping Edge heeft geen effect zolang er geen sweep-aanval is; de vloeken (Binding, Vanishing), Frost Walker, Soul Speed,
  Swift Sneak en alles van kruisboog, trietand en hengel; een zwevend boek op de enchanting table en glyph-deeltjes van de boekenkasten; de
  server bewaakt XP niet (de client stuurt zijn punten mee, zoals health); dood-XP en erts-XP zijn in multiplayer lokale orbs; creative-tab met kant-en-klare enchanted books.

## 4d. Redstone (minimaal, klaar)

Screenshots: `docs/screenshots/redstone_lever_lamp.png`, `redstone_clock_a.png`, `redstone_plate_door.png`, `redstone_piston_closed.png`
(`scripts/redstone-shots.py`, controleert ook de werking).

- **Kern:** `src/world/Redstone.ts` (`RedstoneSim`, puur, getest met een nep-grid in `tests/redstone.test.ts`). Signaal 0–15 in de meta van stof,
  sterke en zwakke voeding zoals Java, een volledig stofnetwerk wordt in één keer opgelost (afname 1 per blok, ook trapjes op en af).
  Vertragingen als geplande ticks: repeater 2–8, fakkel 2, lamp uit 4, knop 20/30, zuiger 2 game ticks; fakkels branden door (8 keer in 60 ticks, 160 ticks uit).
  Budgetten per tick: 4000 updates, 800 blokwijzigingen, 2500 updates per chunk, 50 000 geplande ticks; netwerken tot 2048 stof per pass.
- **Componenten:** stof, hendel, knop (steen/eik), drukplaat (steen/eik), redstonefakkel (vloer + muur), redstoneblok, repeater (1–4),
  lamp, nootblok (25 tonen, instrument naar het blok eronder), TNT, deuren/luiken/hekpoorten, (sticky) zuigers (12 blokken, niet obsidiaan/bedrock/
  kisten/ovens/deuren/bedden; planten en stof breken).
- **Weergave:** stofkleur via de per-vertex tint (geen extra textures), vorm uit de buren zoals hekken; kleurwijzigingen worden max. 5×/s per
  chunk opnieuw gemesht. 14 textuurlagen.
- **Multiplayer:** `ServerWorld` simuleert, wijzigingen gaan mee in de bestaande `blocks`-batch; clients simuleren niet. Protocol ongewijzigd.
  Arcade-rooms hebben geen redstone. Geluiden (klik, zuiger, noot, deur) leidt de client af uit binnenkomende wijzigingen.
- **Metingen:** 510 stof (34 netwerken) aan/uit: server ~0,5 ms per tick (mediaan), singleplayer 720 stof ~0,6–1 ms per tick (mediaan, uitschieters
  door GC/drukke machine).
- **Bewust vereenvoudigd:** geen quasi-connectivity/BUD, geen repeater-lock, comparator, observer, dropper/dispenser, hopper, slime; zuigers
  verschuiven direct (geen animatie, geen entities meeduwen); zuigerkop breken laat de basis gewoon intrekken; sticky piston heeft geen recept
  (geen slijmbal); lamp/deur-updates hebben geen Minecraft-updatevolgorde; netwerken > 2048 stof worden in delen opgelost; een uitgedoofde
  redstonefakkel geeft nog steeds licht 7 (licht per blok-id).
- **Nog te doen:** comparator, observer, hopper, dispenser/dropper, rails, slijmbal + slime block, zuigeranimatie, quasi-connectivity.
  `BlockUpdates` (2 ticks, 400 checks) is bewust niet hergebruikt: redstone heeft directe stofpropagatie, vertragingen tot 160 ticks en de
  tweede ring via sterk gevoede blokken nodig.

## 5. Sfeer

| Item | Effort |
|---|---|
| ~~Grotgeluiden en muziek die per biome wisselt~~ (klaar, zie hieronder) | S |
| Vuurvliegjes en vallende bladeren | S |
| Suikerriet, pompoenen, meloenen, paddenstoelen, waterlelies | S–M |
| Weer: regen, sneeuw, onweer, bliksem, maanfasen, sterren met twinkel | **Gedaan** (`Weather.ts`, `Precipitation.ts`, `Lightning.ts`; zie [`GAMEPLAY.md`](GAMEPLAY.md#weer-en-lucht)). Open: regengeluid en donder via `AudioEngine.setWeather`, sneeuwlagen en bevriezend water (block states + random ticks), farmland-hydratatie en vuur-blussen via `Weather.isRainingAt`, geladen creepers, onweer-slapen |
| Rivieren | M |
| Nieuwe biomes: moeras, savanne, jungle, badlands | M per stuk |

### Audio-herziening (klaar, `src/core/audio/*`)

Alle audio blijft procedureel (geen assets). `AudioEngine` in `Audio.ts` houdt zijn publieke methodes; het geluidsontwerp zit in losse bestanden.

- **Blokgeluiden:** `SOUND_PROFILES` in `audio/profiles.ts` is het register. Een nieuw blok declareert alleen `sound: '<type>'`; een nieuw type is één regel in dat register (het `BlockSound`-type volgt vanzelf). Er zijn nu 14 types: stone, wood, grass, gravel, sand, glass, wool, snow, metal, ladder, bamboo, dirt, wetgrass, water. Elk geluid is gelaagd (korrelige ruis, resonante body, sinus-thump, korte tonen), met pitch-variatie en nooit twee dezelfde varianten achter elkaar.
- **Beweging:** `PlayerSounds` (stappen per ondergrond op afstand, lopen/sprinten/sluipen, sprong, landing naar valhoogte, plons, zwemslag, pantser-clink als haak) en `MobSteps` (zachte mobvoetstappen per soort).
- **Sfeer:** grotten (druppels, drones, gerommel, extra galm; op basis van skylight, een goedkope enclosure-schatting met 18 stralen en diepte), onderwater (low-pass plus bubbels), wind op bergen/hoogte, krekels 's nachts en vogels overdag per biome, lava- en vuurgeknetter, stromend water, regen- en onweerslagen. Het weer roept `audio.setWeather(rain, thunder)` en `audio.playThunder(afstand)` aan.
- **Muziek:** `setMusicMode('menu'|'game'|'arcade'|'off')`. Pianofrasen per biome en tijdstip (modi/pentatoniek), lange stiltes, donkere galm, dempen in grotten en onder water. In arcade-modus een subtiele puls zolang de match `live` is (`setMusicIntensity`).
- **Mix:** master met compressor en soft-clipper (piek blijft onder 0,92), volumes voor geluid/ambient/interface/muziek, globale stemlimiet (64) met prioriteit, positionele geluiden met afstandsdemping, stereo-pan of HRTF (instelling "3D Sound"), occlusie door blokken (gedrosselde raycast).
- **Haken:** `audio.addSoundListener(fn)` / `audio.onSound` geven elke klank door met naam en positie (ondertitels); `audio.playUi(name)` voor interfacegeluid (`src/ui/uiSound.ts` koppelt dat via event delegation aan knoppen en slots).
- **Verificatie:** `tests/audio.test.ts` (Vitest, pure logica) en `python3 scripts/audio-report.py` (OfflineAudioContext in Playwright: niveau per geluid, clipping, WAV-previews in `tests/audio-previews/`, worst-case scene).

Nog open: gebakken buffers voor veelgebruikte geluiden (minder CPU), geluiden van andere spelers hun blokedits, echte regen/onweer-visuals en lightning-flash koppelen aan `setLightningHandler`, een rustig "nether"-achtig thema, mix en timbre door een mens laten beoordelen (alles is alleen met meters gecontroleerd).

## 6. Gebruiksgemak en toegankelijkheid

- **Werkende keybind-remapping:** **Gedaan.** Key Binds-scherm zoals Minecraft 1.21 (categorieën, `> key <`, Esc = Not Bound, conflicten rood, Reset Keys); toetsen en muisknoppen, opgeslagen in `bunkcraft.settings`. Centrale tabel in `src/core/Keybinds.ts`.
- **Contexthints en ontdekken van recepten (S):** voor nieuwe spelers.
- **Toegankelijkheid (S–M):** **Gedaan** (zie `docs/CONTROLS.md`): ondertitels met richtingspijlen, reduced motion (default uit `prefers-reduced-motion`), reduce flashes (`limitFlash`/`FlashLimiter` in `src/core/Accessibility.ts` voor de weer-ontwikkelaar), kleurenblind-veilig palet, hoog contrast (ook `prefers-contrast`/`forced-colors`), tekstgrootte, hold/toggle voor sneak, sprint, attack en use, FOV-effecten, stick-curve, menu-herhaalvertraging, `role=dialog`, aria-live en echte `<button>`s. **Nog open:** patronen/iconen op teamkleuren (nu alleen palet), ondertitels voor blokgeluiden, volledige screenreader-tekst voor de inventaris.
- **UI op Minecraft 1.21-niveau:** **Gedaan** (zie [`docs/UI.md`](UI.md)): Nederlands/Engels (`src/ui/i18n.ts`), Language-, Mouse- en Chat Settings-schermen, Max Framerate/Entity Distance/FOV Effects/Attack Indicator/Auto-Jump/Raw Input, chatgeschiedenis en `/`-aanvulling, Allow Cheats en chat in singleplayer, Statistics, laadscherm met tips, F3 zoals 1.21, effect-hearts, inventory-sneltoetsen, en een screenshot- en pixel-diff-suite (`scripts/ui-shots.py`).
- **UI vervolg (S–M):** drag-split en muiswiel in de inventory, 2×2 crafting-raster, offhand-slot en speler-preview (eerst API afstemmen met furnace/enchanting), toegankelijkheidsknop op het titelscherm, overige schermen vertalen (sleutels toevoegen aan `i18n.ts`), aanvals-cooldown koppelen aan `hud.setAttackCharge`.
- **`navigator.storage.persist()`:** **Gedaan.** Safari wist anders werelden na 7 dagen zonder bezoek.
- **Gamepad (M):** **Gedaan.** Standard mapping, dode zone en curve, menunavigatie met focusring, hot-plug, rumble, Controller Settings, southpaw. **Nog open:** knoppen herbinden in de UI en een muiscursor voor de inventaris.
- **Touchbediening (L):** **Gedaan.** Zwevende joystick, kijken door slepen, tikken om te gebruiken en vasthouden om te breken, knoppen, hotbar tikken en vegen, auto-jump, arcade-knoppen, safe-area, fullscreen en oriëntatiehint. **Nog open:** test op echte toestellen, aim-assist voor arcade (staat bewust uit) en haptics op telefoons.

## 7. Multiplayer (vervolg op v1)

v1 is gebouwd: één Node-server serveert de game en de WebSocket, met een gedeelde wereld,
spelers, chat, tijd en per speler opgeslagen data. Zie `docs/SERVER.md`.

**Gedaan:** spelers maken zelf een game aan en delen een code of link (`?join=CODE`), recente games in het menu,
`Invite Friends` in het pauzemenu, meerdere games per server, hartslag voor proxies en een
`docker-compose.yml` met Caddy voor een eigen domein met HTTPS.

Volgende stappen:

1. **Mobs op de server simuleren: Gedaan** (zie `docs/SERVER.md`). Mob-AI, items, pijlen en TNT draaien op de server met een eigen `ServerWorld`. Spawnen en despawnen delen `MobSpawner` met singleplayer; de server-sky-light is open-lucht of niet, genoeg voor de spawnregels.
2. **Gedeelde item-drops: Gedaan.** PvP in de Minecraft-sandbox staat nog open; PvP bestaat wel in de arcade-game types (zie 7b).
3. **Server-authoritative inventory: Gedaan (gedeeltelijk).** Survival-inventories worden door de server gecontroleerd
   (pickups, recepten, drops die een blokbreuk of voorraad nodig hebben). Kisten en ovens staan nu op de server; overdrachten
   tussen inventory en container lopen via de guard (`creditTransfer`/`spendTransfer`). Stationcontrole en health/honger staan
   nog open. Precies wat wel en niet: `docs/SERVER.md`.
4. **Wachtwoord, whitelist, ops en tokens: Gedaan.** Wachtwoord per game (scrypt), eigenaarstoken, namen gebonden aan een
   browsersleutel, `/kick /ban /unban /op /deop /whitelist /say /tp /gamemode /time /weather /give`, opt-in serverlijst
   (*Browse Games*), `/admin` met `ADMIN_TOKEN`. Open: echte accounts (e-mail of passkey) en een herstelroute voor een
   verloren naam of eigenaarstoken.
5. **Binair protocol: Gedaan voor `snap` en `ent`** (-54 % en -44 %, minder CPU), onderhandeld in `hello`. Client-naar-server
   (`pos`) en de overige berichten zijn nog JSON; delta-compressie van `snap` (alleen wat bewoog) is de volgende stap.
6. **Observability en beheer: Gedaan.** JSON-logs, `/metrics`, `/health`, back-ups, verbindingslimieten, `ALLOWED_ORIGINS`,
   gracieus afsluiten met reconnect-hint. Open: Grafana-dashboard als voorbeeld, rate limits per game in `/admin`, alerting.
7. **Weer in multiplayer** (`/weather` is een stub tot het weersysteem op de server draait) (kisten en ovens zijn klaar, zie `docs/MULTIPLAYER.md`).

## 7b. Arcade-game types (Krunker-stijl)

Naast de sandbox: **Team Deathmatch** en **Free For All** op een vaste arena, met hitscan-wapens, health die
regenereert, respawns en een scoreboard. Beschrijving, besturing en wapentabel: [`GAMEMODES.md`](GAMEMODES.md).

**Gedaan (client):**

- Menu: Game Type, Score Limit en Time Limit bij *Create Game*; het type staat in het joinscherm en in de recente games.
- `ArcadeSession` (match, roster, health, munitie, killfeed, fire control) en `ArcadeHud` (health, munitie, richtkruis met
  spreiding, hit markers, schade-indicatoren, killfeed, timer en scores, scoreboard, warm-up, doodscherm, eindscherm,
  loadout-menu); `Game.ts` delegeert alleen.
- Wapens als boxmodellen (first person met sway, terugslag, mondingsvuur, herladen, ADS en scope; third person met
  teamshirt, haarband en naamtag in teamkleur), tracers, inslagdeeltjes en procedurele geluiden per wapen.
- Always-sprint, bunny hop-luchtbesturing, geen valschade, honger of blokinteractie (`Interaction.arcade`).
- Arcade-toetsen in het Key Binds-scherm; toetsen mogen gedeeld worden tussen sandbox-only en arcade-only acties.
- Dev-preview met nep-server (`game.arcadePreview()`), Vitest voor de pure logica.
- **Kaarten: Gedaan.** Vijf kaarten (Classic, Maple Court, Old Quarter, Harbor Yard, Dust Bazaar) met een Map-knop bij het
  aanmaken en optioneel `rotate`; de kaart zit in `world.json`, `welcome`/`match` (`MatchInfo.map`) en het worldType.
- **Naamtags: Gedaan.** Nooit door muren, met zichtlijn-raycast en fade.
- **Spectaten na je dood: Gedaan.** Moordenaar eerst, daarna bladeren met de muis.
- **Teambalans: Gedaan.** Late joiners naar het kleinste team; bij vertrek wisselt de laatste joiner bij de volgende respawn.
- **Modeframework: Gedaan.** `GameTypeDef` (data) + `ModeLogic` per mode in `server/modes/`; rondefases (warm-up, countdown,
  live, roundend, intermission, ended); Create Game toont modes, limieten en kaarten uit de registry.
- **Nieuwe modes: Gedaan.** Gun Game, Team Elimination, Hardpoint, Domination en Capture the Flag, met objective-HUD (markeringen
  door muren, scorebalk, vlagstatus, rondepips, ladder), vlagmodellen, geluidscues, Vitest per mode en `scripts/modes-bots.ts`.
- **Kaartobjectives: Gedaan.** Zones en/of vlaggen op Classic, Maple Court, Old Quarter, Harbor Yard en Atomic Lane, plus de
  nieuwe CTF-kaart Bunker Flag.
- **Vier nieuwe vrije kaarten in BO2-stijl: Gedaan.** Skyline Villa (villa met zwembad), Riptide (jacht), Sundown (dorp) en
  Terminus (station), puntsymmetrisch met per helft een eigen palet; alle met zones en vlaggen (zie `docs/GAMEMODES.md`).
- **Wapenherziening: Gedaan.** Shotgun 10 × 13 (one-shot dichtbij), SMG 15, nieuwe DMR, burst rifle en revolver, klassen in het
  loadoutmenu.

**Open:**

1. **Integratie met de serverbranch** verifiëren: zie de checklist in de overdracht (arena-wereld via `worldType`,
   snelheidscontrole voor 1,3× sprint, `damaged.dx/dz`-richting, `holds` bij joinen).
2. **Meer kaarten en varianten:** per kaart meerdere dekkingsindelingen via de seed (nu alleen Classic), een stemronde voor de
   volgende kaart in plaats van vast `rotate`, en bij een kaartwissel de wereld ter plekke herbouwen (nu een korte
   herverbinding met laadscherm).
3. **Meer modes:** Infected en Block Hunt (onderzoek §2.4), Search & Destroy op een asymmetrische kaart (Foundry), en
   Domination/Hardpoint-varianten per kaart (meer zones op kleine kaarten, spawnkeuze weg van de actieve heuvel).
4. **Objective-afwerking:** dragerpijl met interval voor de vijand, MVP-punten (dragerkill, terugbrengen), overtime bij een
   gelijkspel in ctf, rondes met zijwissel, granaten voor elimination, de vlag als echt derde-persoonsmodel op de rug.
5. **Meer wapens en perks**, scorestreaks, kill cam, headshot-statistieken, teamchat.
6. **Lag compensation** voor hitscan (server) en client-side tracer-voorspelling tegen spelers.
7. **Bots** voor lege servers, en een snelle "Quick Play"-knop die een open arcade-game zoekt.
8. **Mobiel:** touchbediening voor schieten en richten (hoort bij de touch-taak in 6).

## 8. Distributie

- **Eigen server:** Docker of Node; zie `docs/SERVER.md`.
- **PWA (S): klaar.** Manifest, handgeschreven service worker (versioned precache, runtime-cache voor texturepacks, `index.html` network-first, update-toast), installknoppen, iOS-meta, offline singleplayer getest met Playwright. Zie `docs/DISTRIBUTION.md`.
- **itch.io (S): klaar.** `npm run build:static` geeft `dist-static/` + `bunkcraft-static.zip` (relatieve base, werkt onder een submap, multiplayer vraagt om serveradres).
- **CrazyGames en Poki (M–L):** pas na touchbediening. Verberg daarvoor de Minecraft-jar-import en zwak de 1-op-1 Minecraft-styling af (risico op IP-problemen).
- **Delen: klaar.** `?seed=&mode=` opent Create World ingevuld, F2-screenshot, Copy Seed in het pauzemenu, `.bunkworld` export/import met zipbom-bescherming, Backup All, Edit en Re-Create in Select World.
- **Nog open:** `og:image` met absolute URL per deployment (scrapers negeren relatieve URL's), Lighthouse-PWA-categorie bestaat niet meer (v13: alleen installability via Chrome), Esc-vergrendeling in fullscreen is alleen op code getest (headless Chrome ondersteunt geen Keyboard Lock), HUD in screenshots (nu alleen canvas), export van multiplayer-werelden (server-kant), menu-orbit en andere gameplay-animaties bij `prefers-reduced-motion` (hoort bij toegankelijkheid), CrazyGames/Poki.

## Plan vanaf oktober 2026 (op basis van het onderzoek)

Onderzoek: `docs/research/UPDATES.md` (versiegeschiedenis tot Java 26.3 "Wilderness Bound", feature-vergelijking)
en `docs/research/MECHANICS.md` (exacte regels en getallen, 30 mechanics in drie fasen).

**Nu in uitvoering (parallel):** content (alle blokken en items, tabs in het creative-scherm, harnas, `ItemStack.data`),
mobs (varkensoog, nachtelijke spawns in groepen, dierdichtheid), wereldgeneratie (grotten met ingangen, ravijnen,
ertsaders, `genVersion` voor bestaande werelden).

**Fundamenten die bijna alles blokkeren (eerst):**
1. Random-tick systeem: **Gedaan** (`RandomTicks.ts`, `Growth.ts`, `BlockUpdates.ts`, `Trees.ts`; zie [`GAMEPLAY.md`](GAMEPLAY.md#groei-en-vallende-blokken)).
   Saplings (alle 7 houtsoorten), bladverval, gras/mycelium, suikerriet, cactus, paddenstoelen, ijs, bone meal, vallend zand en grind; singleplayer en server.
   Meting (`scripts/bench-randomticks.ts`, CPU-tijd op een zwaar belaste machine): singleplayer render distance 12 / sim-afstand 8 chunks ≈ 0,1 ms per tick,
   server ≈ 0,05–0,08 ms per speler; in de browser (Playwright, `scripts/growth-shots.py`) p50 0,2 ms. Open: farmland en gewassen (via
   `RandomTicker.register` en `registerBoneMeal`), vuur, sneeuwlagen (geen blok), bamboe/kelp/vines (geen blokken), grote 2×2-bomen (dark oak, jungle,
   spruce), big oak, de `/gamerule randomTickSpeed`-UI (setter: `RandomTicker.setSpeed`, server: `ServerEntities.setRandomTickSpeed`), geluid bij landen.
2. Block entities (kisten, ovens, spawners) met opslag per wereld en server-sync. **Gedaan voor kist, dubbele kist en oven** (singleplayer save v4, `world.json` op de server, `container`-protocol); spawner, bord, bed en banner kunnen zich registreren met `registerBlockEntityKind`.
3. Eén centrale schade-pijplijn (moeilijkheidsgraad, harnas, effecten, enchantments). **Gedaan** (zie `GAMEPLAY.md`):
   `Damage.ts` met difficulty, i-frames, schild, harnas, Resistance, enchant-hooks en absorption; game rules en
   difficulty per wereld (UI, `/difficulty`, `/gamerule`); 1.9+-gevecht (cooldown, crits, sweep, server-check);
   bedden met spawnpunt en slapen (multiplayer-regel); statuseffecten met HUD en `/effect`; schild.
   **Nog open:** enchantments vullen `registerDamageModifier` (Protection, Feather Falling, Sharpness via
   `meleeDamage.enchantBonus`, Sweeping Edge via `sweepDamage(…, edge)`); Night Vision/Invisibility renderen;
   blok-pose en model van het schild in de hand; bijl-mobs/PvP voor het uitschakelen van schilden; doodsberichten in
   multiplayer-chat (de server ziet de dood niet: health is client-autoritatief); zombies die deuren breken op Hard;
   Easy-specifieke mobregels (cave spiders); `difficulty`/`rules`/`bed`/`effects` in `.bunkworld`-export;
   slapen versnelt nu direct naar de ochtend
   (geen tijd-animatie) en de server kent geen fase "iedereen in bed maar nog geen 100 ticks" in de HUD.

**Fase 1, early game loop:** ~~saplings en bladverval~~ (gedaan), landbouw (schoffel, farmland, tarwe, brood, bone meal), bed met
spawnpunt en nacht overslaan, difficulty en game rules, harnas, attack cooldown met crits en sweep, kist met loot-tabellen,
~~vallend zand en grind~~ (gedaan), XP-orbs, ladders/hekken/trapdoors/knoppen, echte oven met kooktijd.

**Fase 2, mid game:** fokken en baby's, weer, dungeons met spawner, meer mobs (enderman, witch, slime, wolf, paard),
status-effecten, schild, vuur, enchanting, anvil en grindstone, mijnschachten en kleine structuren, vissen, meer planten.

**Fase 3, late game:** minimale redstone (**gedaan**, zie 4d), dorpen met handel, brewing, Nether-lite, extra biomes (jungle, savanne, moeras,
badlands), rivieren.

Onzeker en eerst te verifiëren: verdrinkings- en lava-intervallen in de code tegen de wiki, de void-grens (y < −64 terwijl
de wereld 0–127 loopt), sapling-groeilicht en de XP-tabel (zie "onzeker" in MECHANICS.md).

## Voorgestelde volgorde

1. **Komende 2 weken:**
   - recepten voor de ongebruikte drops;
   - advancements en hints;
   - keybind-remapping;
   - CI met tests;
   - PWA;
   - mobs op de multiplayer-server.
2. **Komende maand:**
   - block states (**Gedaan**);
   - stromend water en lava (**Gedaan**);
   - kisten en dungeons;
   - landbouw, harnas, skeleton en spin;
   - weer.
3. **Later:**
   - eindspel;
   - nieuwe biomes en dorpen;
   - touch en gamepad;
   - portals.

## Mobs 2 (oktober 2026)

**Gedaan:** goal-AI met A* (`src/entities/ai/`), fokken en baby's, schapen scheren/verven/grazen, melk, eieren,
wolven (temmen, zitten, volgen, meevechten, halsband), enderman, slime (splitsen, slime chunks), drowned, husk, stray,
cave spider, witch (drankje = vergif als placeholder), paard (minimaal rijden in singleplayer), hartjes/rook boven
mobs, blob-schaduwen, nieuwe geluiden en ondertitels, server-sync (`NET_MOB_KINDS` uitgebreid, vlaggen en variant-byte).

**Open, op volgorde:**
1. Effecten zijn gekoppeld (`MobEffects.ts`: cave-spider-vergif, husk-honger, stray-slowness, witch-drankjes) en
   fokken geeft XP-bollen. Open: melk drinken die effecten wist, witch die zelf drankjes drinkt, de server kent de
   gezondheid van de speler niet (witch kiest dan als bij volle gezondheid).
2. Mob-drops naar `rollLoot` (`src/items/Loot.ts`).
3. Getemde wolven en paarden opslaan in de wereld (nu verdwijnen ze bij afsluiten; ze blijven wel geladen zolang je
   speelt) en rijden in multiplayer (de server moet de paardsnelheid toestaan).
4. Deuren in het pad zoeken (openen door zombies op Hard), enderman die blokken oppakt, wolf-bedel-goal, paard-
   uitrusting en ezels/muildieren.
5. Ambient en water: vleermuizen, inktvissen en vissen (eigen spawn-caps per categorie).

