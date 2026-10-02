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
3. **Kisten met loot (M):** nodig voor alle structuren.
4. **Block states (L):** **Gedaan** (ontwerp in [`BLOCKSTATES.md`](BLOCKSTATES.md)).
   - Een `meta`-byte per blok in een lazy `Chunk.meta`, door de generatie-workers, de mesher, botsing, raycast, save (record v2 + migratie) en netwerk (protocol 4) heen.
   - **Slabs en trappen** (9 materialen, Minecraft-plaatsingsregels, hoekvormen afgeleid uit de buren, loopt omhoog met stap 0,6) en de **eikenhouten deur** (2 blokken, scharnier, open/dicht, breekt samen).
   - **Stromend water en lava** met de Minecraft 1.21-regels (water 7 blokken per 5 ticks, lava 3 blokken per 30 ticks, oneindige bron, obsidiaan/cobblestone, vallend water) en **emmers** (ijzeren emmer, water- en lavaemmer). Budget van 600 updates en 200 blokwijzigingen per tick; in multiplayer simuleert de server.
   - Nog te doen op deze basis: **ladders, muurfakkels, gewassen** (groeifase in `meta`), **oven met een richting** (en een brandende staat), **bed** (2 blokken), vallend zand en grind, waterlogged slabs, stroming die entities meeduwt, lava-fakkels/vuur, trapdoors en hekken (zelfde `partial`-machinerie).
   - Bewust anders dan Minecraft: de trapvorm wordt afgeleid uit de buren (niet opgeslagen) en lava vertraagt niet willekeurig (`random.nextInt(4)`).
5. **Landbouw (M):** saplings, tarwe, brood en een schoffel. Hernieuwbaar hout en voedsel.
6. **Meer survival-inhoud (M):** harnas met een armor-bar: **Gedaan** (zie §4b). XP-orbs met een XP-balk. Skeleton (schiet elke 2 s, verbrandt in daglicht; drops botten en pijlen) en spin (klimt, springt, neutraal in fel licht; drops draad en spinnenoog met Poison) zijn **Gedaan**.
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
- **Nog te doen (tier 2):** landbouw (tarwe, wortels en aardappels, hoofdreden dat brood, koekjes en modderstenen nog niet te maken zijn), enchanting, brouwen, smithing en
  netherite, anvil, grindstone, blast furnace, smoker, schild, hengel, kaarsen, banners, koraal, ruitjes met doorzichtigheid (gekleurd glas is alpha-getest),
  kisten in multiplayer, een echte kist-animatie, kisten met richting-afhankelijke dubbele variant, vallend zand en grind, en dat de worldgen de nieuwe blokken
  (graniet, diorite, andesiet, tuff, calciet, deepslate, nieuwe ertsen, bloemen, junglebomen) nog moet plaatsen.

## 5. Sfeer

| Item | Effort |
|---|---|
| Grotgeluiden en muziek die per biome wisselt | S |
| Vuurvliegjes en vallende bladeren | S |
| Suikerriet, pompoenen, meloenen, paddenstoelen, waterlelies | S–M |
| Regen en sneeuw, daarna onweer | M |
| Rivieren | M |
| Nieuwe biomes: moeras, savanne, jungle, badlands | M per stuk |

## 6. Gebruiksgemak en toegankelijkheid

- **Werkende keybind-remapping:** **Gedaan.** Key Binds-scherm zoals Minecraft 1.21 (categorieën, `> key <`, Esc = Not Bound, conflicten rood, Reset Keys); toetsen en muisknoppen, opgeslagen in `bunkcraft.settings`. Centrale tabel in `src/core/Keybinds.ts`.
- **Contexthints en ontdekken van recepten (S):** voor nieuwe spelers.
- **Toegankelijkheid (S–M):** ondertitels voor geluiden, reduced motion (hurt cam, bobbing en FOV-kick uit) en kleurenblind-veilige balken.
- **`navigator.storage.persist()`:** **Gedaan.** Safari wist anders werelden na 7 dagen zonder bezoek.
- **Gamepad (M)** via de Gamepad API.
- **Touchbediening (L):** joystick, slepen om te kijken en knoppen. Vereist voor mobiele portals.

## 7. Multiplayer (vervolg op v1)

v1 is gebouwd: één Node-server serveert de game en de WebSocket, met een gedeelde wereld,
spelers, chat, tijd en per speler opgeslagen data. Zie `docs/SERVER.md`.

**Gedaan:** spelers maken zelf een game aan en delen een code of link (`?join=CODE`), recente games in het menu,
`Invite Friends` in het pauzemenu, meerdere games per server, hartslag voor proxies en een
`docker-compose.yml` met Caddy voor een eigen domein met HTTPS.

Volgende stappen:

1. **Mobs op de server simuleren: Gedaan** (zie `docs/SERVER.md`). Mob-AI, items, pijlen en TNT draaien op de server met een eigen `ServerWorld`.
2. **Gedeelde item-drops: Gedaan.** PvP in de Minecraft-sandbox staat nog open; PvP bestaat wel in de arcade-game types (zie 7b).
3. **Server-authoritative inventory** (anti-cheat): breken en craften door de server laten bevestigen.
4. **Wachtwoord, whitelist en ops**, en accounts of tokens per naam.
5. **Binair protocol** voor snapshots, als er veel spelers zijn.

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

**Open:**

1. **Integratie met de serverbranch** verifiëren: zie de checklist in de overdracht (arena-wereld via `worldType`,
   snelheidscontrole voor 1,3× sprint, `damaged.dx/dz`-richting, `holds` bij joinen).
2. **Meer kaarten en varianten:** per kaart meerdere dekkingsindelingen via de seed (nu alleen Classic), een stemronde voor de
   volgende kaart in plaats van vast `rotate`, en bij een kaartwissel de wereld ter plekke herbouwen (nu een korte
   herverbinding met laadscherm).
3. **Meer wapens en perks**, scorestreaks, kill cam, headshot-statistieken, teamchat.
4. **Lag compensation** voor hitscan (server) en client-side tracer-voorspelling tegen spelers.
5. **Bots** voor lege servers, en een snelle "Quick Play"-knop die een open arcade-game zoekt.
6. **Mobiel:** touchbediening voor schieten en richten (hoort bij de touch-taak in 6).

## 8. Distributie

- **Eigen server:** Docker of Node; zie `docs/SERVER.md`.
- **PWA (S):** installeerbaar en offline speelbaar in singleplayer.
- **itch.io (S):** een zip met `index.html`, alleen singleplayer.
- **CrazyGames en Poki (M–L):** pas na touchbediening. Verberg daarvoor de Minecraft-jar-import en zwak de 1-op-1 Minecraft-styling af (risico op IP-problemen).
- **Delen:** seed in de URL, F2-screenshots, en export/import van werelden als zip (fflate is al aanwezig).

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
