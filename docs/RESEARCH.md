# BunkCraft — onderzoek: Minecraft-look, performance & technologie

Samenvatting van drie onderzoeken (oktober 2026) en wat daarvan in de engine is verwerkt.
Bronnen staan per sectie onderaan.

---

## 1. Minecraft: versies, content en graphics

### Wat de "Minecraft-look" bepaalt (per versie)

| Versie | Visueel / wereldgeneratie |
|---|---|
| Beta 1.7.3 | "Old gen": 3D-noise overhangs, kleine biomes, strand van zand/grind, wolken op y≈108. |
| Beta 1.8 | Nieuwe lightmap (block light + sky light), vloeiende dag/nacht, oranje fog/wolken bij zonsop/-ondergang, grotere biomes, ravijnen. |
| 1.7 | Biomes in klimaatbanden (sneeuw grenst niet meer aan woestijn), nieuwe biomes (savanna, mesa, mega taiga). |
| 1.13 | Water grijs en per biome getint (standaard `#3F76E4`), onderwater-fog. |
| 1.14 (Texture Update, Jappa) | Alle textures opnieuw: duidelijke silhouetten, weinig ruis, 4–6 tinten per blok. **Dé moderne look.** |
| 1.18 | Terrein via continentalness / erosion / peaks-and-valleys, noise caves (cheese, spaghetti, noodle), aquifers, wereld −64..320, wolken op y=192. |
| 1.19–1.21 | Mangrove, deep dark, cherry grove, vallende bladeren-particles, wildflowers, leaf litter. |

### Concrete constanten

- **Biome tint:** gras en bladeren zijn grijze textures × kleur per biome. Plains gras `#91BD59` / foliage `#77AB2F`, forest `#79C05A` / `#59AE30`, desert `#BFB755`, taiga `#86B783`, snowy `#80B497`. Berk `#80A755`, spar `#619961` (vast). Grenzen worden 5×5 uitgemiddeld.
- **Lichtcurve:** `b = f / (4 − 3f)` met `f = level/15`.
- **Face shading:** boven 1.0, N/Z 0.8, O/W 0.6, onder 0.5.
- **Smooth lighting/AO:** per hoek 2 zijkanten + diagonaal; quad-diagonaal flippen op AO.
- **Wolken:** cellen van 12×12×4, langzaam naar −X drijvend.
- **HUD:** hotbar 182×22 GUI-pixels, selectie 24×24, crosshair met invert-blend, FOV 70, sprint-FOV ×1.1.
- **Breken:** 10 crack-stadia; ~64 deeltjes (4×4×4) uit de textuur van het blok.

### Texture packs — wat mag juridisch?

| Pack | Licentie | Mojang-afgeleid? | Oordeel |
|---|---|---|---|
| **Pixel Perfection** (XSSheep) | CC BY-SA 4.0 | Nee (originele art) | ✅ **Gekozen** — naamsvermelding + share-alike op de textures |
| Minetest Game textures | CC BY-SA 3.0 | Nee | ✅ Bruikbaar, minder MC-achtig |
| Kenney Voxel Pack | CC0 | Nee | ✅ Maar cartoony, geen 16×16 |
| Faithful | eigen licentie | **Ja** (upscale van Mojang) | ❌ |
| Dokucraft, Sphax, John Smith | proprietary | gemaakt voor MC | ❌ zonder toestemming |

### Geïmplementeerd

- Texture pack-systeem (`src/rendering/TexturePacks.ts`) met Pixel Perfection als standaard, procedurele textures als fallback/alternatief (Settings → Textures). Overlays (`stone^mineral_coal`) worden gecomposit.
- Biome-tinting met 5×5 blend (`src/world/BiomeColors.ts`, mesher), ook op break-particles en inventory-icons.
- Face shading richting Minecraft-waarden.

---

## 2. Performance (doel: soepel 60+ FPS zonder grafische concessies)

### Gemeten (geïntegreerde AMD Radeon / Ryzen APU, Chrome/ANGLE, 1280×720, hoge schaduwen)

| Render distance | Vóór optimalisaties | Na |
|---|---|---|
| 8 (Medium) | 54–64 FPS | **118–144 FPS** (schermlimiet), worst frame 21 → 14 ms |
| 12 (High) | — | 84–88 FPS |
| 16 (Ultra) | 43–48 FPS | 61–68 FPS |

### Gemeten (Apple M1 Pro, oktober 2026)

Playwright, 1280×800, wandelen en draaien in een survival-wereld, render distance 8:

| Browser | Backend | Mediaan frame | p99 | Haperingen > 30 ms |
|---|---|---|---|---|
| Chromium | ANGLE Metal | 8,3 ms (120 FPS, schermlimiet) | 9,3 ms | 0 in 25 s (na de fixes hieronder) |
| Chromium | SwiftShader (software, "slechtste GPU") | 33 ms | 100 ms | regelmatig |
| WebKit (Safari-engine) | Metal | 16,7 ms (60 FPS, vsync) | – | – |

De CPU kost per frame ~0,4–0,8 ms (renderen) en vrijwel niets voor chunks; de rest is GPU-tijd of wachten op vsync.

- **Hapering bij het betreden van een wereld (~250 ms):** shaders van mobs, items, pijlen, TNT en de hand compileerden pas bij hun eerste gebruik. Ze worden nu tijdens het titelscherm voorgecompileerd (`compileAsync`).
- **Hapering elke 30 s:** elke autosave las een frame terug van de GPU voor de wereldthumbnail (synchroon). De thumbnail wordt nu alleen bij pauzeren, afsluiten of een wereld zonder icoon gemaakt.
- **Nog open (was):** garbage collection tijdens het streamen, `updateMatrixWorld` over alle chunk-meshes: opgelost in de ronde hieronder. `toDataURL` voor de hotbar-iconen (eenmalig ~6 ms) staat nog open.

### Meetscript: `scripts/perf-report.py`

`python3 scripts/perf-report.py [--browser chromium|webkit] [--distance 16] [--cpu 4] [--seconds 30]` start een eigen Vite-server (vrije poort, `hmr: false`, `watch: null`), maakt een creative-wereld (seed 1234) en vliegt 30 s met sprintsnelheid (~21 blokken/s) in een flauwe S-bocht. Chromium draait met `--use-angle=metal`. Het script drukt één tabel af: mediaan/p95/p99/slechtste frame, frames > 20 en > 33 ms, GC-pauzes van de main thread (CDP-trace, `MinorGC`/`MajorGC`), draw calls, JS-heap en de render distance aan het eind. `--cpu 4` vertraagt de main thread 4× (zwakke laptop; GC-pauzes worden dan ook 4× langer), `--profile` toont de duurste functies, `--alloc` de grootste allocatieplekken, `--eval` voert JS uit vóór de vlucht (experimenten). Redstone: `npx tsx --expose-gc scripts/bench-redstone.ts [lijnen] [lengte] [ticks]`.

### Gemeten: streaming, culling en GC (Apple M1 Pro, 120 Hz, oktober 2026)

`feature/bunkcraft-engine` vóór deze ronde tegen erna (zelfde machine, na elkaar, 30 s vlucht):

| | rd 8 | rd 16 | rd 16, CPU 4× | WebKit rd 8 (60 Hz) |
|---|---|---|---|---|
| Mediaan frame | 8,3 → 8,3 ms | 8,3 → 8,3 ms | 16,6 → **8,7 ms** | 17,0 → 16,0 ms |
| p99 | 10,3 → 10,3 ms | 10,3 → 10,3 ms | 31,7 → **18,4 ms** | 19 → 19 ms |
| Frames > 20 ms | 0 → 0 | 0 → 0 | 240 → **6** | 6 → 10 (ruis) |
| GC-pauzes (aantal / totaal) | 35 / 55 ms → 25 / 32 ms | 54 / 113 ms → **14 / 26 ms** | 25 / 177 ms → **13 / 73 ms** | – |
| Major GC's | 26 → 8 | 42 → **4** | 17 → 3 | – |
| Draw calls | 190 → 150 | 673 → 600 | 675 → 599 | 199 → 154 |

Let op: de commit van de culling noemt 577 → 135 draw calls bij rd 16. Die meting klopte niet: het script zette de render distance zonder `settings.set`, waardoor de mist (en dus de culling) op 8 chunks bleef staan. De tabel hierboven is met de gecorrigeerde meting.

Op normale snelheid haalt de M1 Pro de schermlimiet al; de winst zit in de 4× vertraagde main thread (zwakke laptop): de CPU-tijd per frame zakt van boven naar onder de 8,3 ms. Zonder vertraging duurt geen enkele GC-pauze langer dan 4 ms.

Wat er gebeurde:

1. **CPU-culling per chunkkolom** (`ChunkManager.cull`): één box-test per kolom in plaats van de bol-test van three.js per mesh (opaque, cutout en water). Verborgen meshes verliezen alleen layer 0, de schaduwcamera ziet alle layers, dus schaduwen van chunks achter de speler blijven. Kolommen die volledig in de mist liggen worden overgeslagen. De chunkgroepen slaan `updateMatrixWorld` over (three r186 loopt anders nog steeds door ~1000 kinderen). Profiel bij rd 16, CPU 4×: `projectObject` 5,6 → 3,6 s en `updateMatrixWorld` 3,8 → ~0 s per 25 s.
2. **Geen ArrayBuffer-churn bij het streamen.** Mesh-verzoeken stoppen de 3×3 buurt in één gepoolde buffer die wordt *overgedragen* (niet gekloond: was ~300 KB kopie per mesh) en terugkomt. Resultaat-arrays en chunk-arrays gaan terug naar een `BufferPool` in de worker zodra three.js ze naar de GPU heeft gekopieerd. De CPU-kopie van alle chunkgeometrie (~25–40 MB bij rd 8) bestaat dus niet meer. Elke nieuwe ArrayBuffer telt bij V8 als externe geheugendruk en trok een volledige mark-compact.
3. **Kleine lekken van garbage:** sorteerfuncties voor three.js die gehele getallen teruggeven (three's eigen `a.z - b.z` boxt een heap-getal per vergelijking), hergebruik van geometrie, mesh en bounding-volumes, `forEach` in `unloadFar`, geen herscan zolang alle workers bezig zijn, een toroïdaal grid voor chunk-lookups (berekende sleutels > 2^31 boxen bij elke `Map.get`), stilstaande deeltjes slaan hun upload over.
4. **Adaptieve budgetten:** mesh-uploads per frame begrensd op bytes én ~2 ms main-thread-tijd, en kleiner als frames lang duren (`ChunkManager.adapt`). Generatie, meshing en uploads doen chunks vóór de speler eerst.
5. **Render distance tijdelijk verlagen** (`DynamicResolution`): blijft de framerate laag terwijl de resolutie al minimaal is, dan gaat de render distance per 3 s één chunk omlaag (nooit onder 4) en komt na 12 s soepel spelen op volle resolutie terug (langer wachten na een terugval). F3 toont `(adaptive -n)`. Test met CPU 12× bij rd 16: eindigt op rd 14 en resolutie 69 %.
6. **Redstone:** de >20 ms tick-pieken waren GC. Het oplossen van een stroomnetwerk maakte per keer nieuwe arrays, Maps en `Uint8Array`s (`neighbours()` met `out.length = 0` hergroeit elke aanroep). Nu met hergebruikte typed arrays, een eigen hashtabel en gelinkte emmers: 1500 schakelende dust (100 lijnen × 15, hendels elke 4 ticks) maakt 750 → 94 MB garbage per 2000 ticks, mediane tick 0,95 → 0,26 ms. De rest zit in `requeueWire`/`Set.add` met sleutels > 2^31.

### Gemeten: geheugen over 10 minuten vliegen (rd 8, ~3,3 km)

JS-heap na geforceerde GC: 14,3 MB na 30 s, 14,6 MB na 10 minuten. three.js-geometrieën stabiel rond 600, textures 10, mesh-pool ≤ 100, pack-buffers 8. Geen lek gevonden. GPU-geometrie van de chunks ~25–40 MB; die bestaat nu alleen nog op de GPU.

### Gemeten: laden en bundel (productie-server, cache uit)

| | Vóór | Na |
|---|---|---|
| Overgedragen tot titelscherm | 1498 KB | **488 KB** |
| Titelscherm op Fast 3G (562 ms RTT, 1,44 Mbit/s) | 18,6 s | **11,4 s** |
| Titelscherm op 4G (170 ms RTT, 9 Mbit/s) | 4,84 s | **3,47 s** |

- three.js zit in een eigen chunk (532 KB, brotli 107 KB) met lange cache; een game-update downloadt hem niet opnieuw.
- `vite build` schrijft brotli- (niveau 11) en gzip-kopieën; `server/App.ts` levert ze voor gehashte assets. Caddy geeft voorgecomprimeerde antwoorden ongewijzigd door. De PWA-precache slaat `.br`/`.gz` over.
- Preload-hints in de HTML voor de chunk-worker, het pixelfont en de 56 PNG's van Pixel Perfection: het titelscherm wachtte op die afbeeldingen, en ze begonnen pas nadat de bundel draaide.
- De arcade-client (`ArcadeSession`, HUD's, wapenmodellen; 46 KB) is een aparte chunk die vóór een multiplayer-join of de arcade-preview laadt. Singleplayer downloadt hem niet.
- **Nog open:** de 56 losse PNG's kosten op HTTP/1.1 ~10 round trips (6 verbindingen). Een spritesheet van het standaardpack bij de build zou het titelscherm op 3G nog ~4 s sneller maken. Met Caddy (HTTP/2) speelt dit veel minder. fflate staat nog in de hoofdbundel omdat `WorldArchive` het statisch importeert.

### Gemeten: opstarten (dev, warme cache)

Titelscherm 0,34 s na navigatie; `new Game` ~50 ms, waarvan renderer 29 ms (texture-atlas 9 ms) en het schilderen van mob-textures 13 ms. Shaders worden na het titelscherm asynchroon voorgecompileerd. Een wereld betreden (25 chunks rond de spawn) duurt 0,8 s, vrijwel alleen workertijd. Opstarten is dus netwerkgebonden, niet CPU-gebonden.

### Doorgevoerd (geen visuele trade-off)

1. **Opaque / cutout split.** Massieve blokken renderen zonder `discard` → early-Z blijft actief. Alleen bladeren/glas/planten zijn alpha-tested.
2. **Shadow map cache.** Alleen opnieuw renderen bij zonbeweging > ~0.18°, verplaatsing > 4 blokken of gewijzigde geometrie. Shadow pass kost op de meeste frames niets.
3. **ANGLE-vriendelijk vertexformaat.** Alle attributen 4-componentig (`Int16×4` positie+uv, `Uint8×4` data, `Uint8×4` tint); ANGLE/D3D11 converteert 3-component shorts anders op de CPU.
4. **Echte upload-budgettering** (bytes per frame) + nieuwe meshes één frame geforceerd tekenen, zodat GPU-uploads niet pas plaatsvinden als de camera draait.
5. **Geen per-frame allocaties** in game loop en shadow pass.
6. **Worker pool** `hardwareConcurrency − 2` → main thread en GPU-proces houden ruimte.
7. **CPU-culling per kolom, overgedragen en gepoolde chunkbuffers, adaptief upload-budget en render distance** (zie de metingen hierboven).

### Roadmap (volgende stappen, op volgorde van impact)

1. **16×16×16 secties** — strakkere frustum culling, kleinere remeshes.
2. **Cave/occlusion culling** (Tommo's visibility graph, zoals Minecraft/Sodium) — 50–80 % minder geometrie ondergronds. Vereist 16×16×16 secties: met kolommen van 128 hoog is een chunk nooit volledig ingesloten, dus de goedkope variant levert niets op.
3. **Multi-draw** (`BatchedMesh` / `WEBGL_multi_draw`) — van ~550 naar ~4 draw calls per pass.
4. **Per-richting face culling** — vlakken die van de camera af wijzen overslaan (30–50 % minder vertices).
5. **Light cache per chunk + SharedArrayBuffer** (vereist COOP/COEP headers) — sneller streamen.
6. GPU-timers (`EXT_disjoint_timer_query_webgl2`) in de F3-overlay.

---

## 3. Technologiekeuze

**Advies: blijf op Three.js met WebGL2.** Vervang niet de engine, maar het draw-pad.

- WebGPU zit in alle grote browsers, maar Three.js `WebGPURenderer` is in meerdere benchmarks nog trager dan WebGL, en multi-draw-indirect zit nog achter een flag. Firefox op Linux heeft nog geen WebGPU.
- Babylon, PlayCanvas, Godot, Unity en Bevy vragen een volledige rewrite plus bundles van 1–40 MB, zonder aantoonbaar voordeel voor voxels.
- Alle succesvolle web-Minecraft-clones (minecraft-web-client, Eaglercraft, noa) draaien op WebGL2. Ze wonnen met batching en culling, niet door van API te wisselen.
- Rust/WASM verhoogt de FPS niet, want generatie en meshing draaien al in workers. Het helpt alleen de laadsnelheid van chunks. Binary greedy meshing levert meer op dan WASM.

**Later naar WebGPU** als: (a) multi-draw-indirect standaard is, (b) Firefox WebGPU op Linux heeft, en (c) `WebGPURenderer` op onze benchmark-scene minstens even snel is als WebGL. Nieuwe shaders kunnen al in TSL, dat sinds r184 ook onder WebGL draait.

---

### Bronnen

- Minecraft Wiki: [Biome](https://minecraft.wiki/w/Biome), [Light](https://minecraft.wiki/w/Light), [Cloud](https://minecraft.wiki/w/Cloud), [Water](https://minecraft.wiki/w/Water), [Breaking](https://minecraft.wiki/w/Breaking), [1.18](https://minecraft.wiki/w/Java_Edition_1.18), [Texture Update](https://minecraft.wiki/w/Texture_Update)
- Textures: [Pixel Perfection](https://github.com/minetest-texture-packs/Pixel-Perfection), [Minetest Game license](https://github.com/minetest/minetest_game/blob/master/mods/default/license.txt), [Faithful License](https://faithfulpack.net/license)
- Performance: [ANGLE performance](https://github.com/microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE), [Tommo's cave culling](https://tomcc.github.io/2014/08/31/visibility-2.html), [Sodium pipeline](https://deepwiki.com/CaffeineMC/sodium/3.1-chunk-rendering-pipeline), [Vertex pooling](https://nickmcd.me/2021/04/04/high-performance-voxel-engine/), [Binary greedy meshing](https://github.com/cgerikj/binary-greedy-meshing), [EXT_disjoint_timer_query_webgl2](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)
- Technologie: [WebGPU support](https://web.dev/blog/webgpu-supported-major-browsers), [Three.js WebGPU vs WebGL](https://discourse.threejs.org/t/why-webgpurenderer-performance-significantly-lower-than-webglrenderer/77629), [BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html), [caniuse WEBGL_multi_draw](https://caniuse.com/wf-webgl-multi-draw), [minecraft-web-client](https://github.com/zardoy/minecraft-web-client), [noa](https://github.com/VoxelSrv/noa-engine), [Godot web export](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html)

---

## 4. Ondergrond: grotten, ravijnen en ertsen (generator versie 2)

Feedback: "er zijn geen grotten en geen grotingangen te zien". Versie 1 had een grof 3D-rooster (`sampleCaves`, elke 4 blokken)
met te smalle tunnels en een deksel van 7 blokken onder zee en land; ertsen waren losse random walks per chunk. Versie 2
(`src/world/CaveCarver.ts`, `OreTable.ts`, `GenVersion.ts`) volgt de noise-grotten van Minecraft 1.18+ op onze wereldhoogte
(0..127, zeeniveau 62; Minecraft −64..320 komt ondergronds ruwweg overeen met y_onze = (y_mc + 64) · 0,49).

### Ontwerp

Alles is een pure functie van seed en wereldpositie. Er zijn geen random walks per chunk, dus chunks sluiten op hun randen
op elkaar aan en de volgorde van genereren doet er niet toe (Vitest: andere volgorde, verse generator, andere seed).

| Onderdeel | Hoe |
|---|---|
| Cheese (grote holen) | 3D-noise (freq 0,010 / 0,019 verticaal): hol waar de waarde boven een drempel komt. De drempel zakt onder y 22 (grotere holen diep), stijgt vlak onder het oppervlak, en zakt in "entrancezones" |
| Spaghetti (lange tunnels) | Twee 3D-noises: tunnel waar `a² + b² < w²` (snijlijn van twee nulvlakken). Dikte `w` wisselt langzaam via een derde noise; vlak onder het oppervlak dunner, maar ze breken er nog door |
| Noodle (dunne tunnels) | Zelfde, hogere frequentie (0,03), alleen y 8..100 en niet in de bovenste 3 blokken |
| Ingangen | Brede spaghetti in alleen de bovenste 28 blokken en alleen in zones die een 2D-noise kiest (grotingangen in heuvels komen in clusters voor) |
| Ravijnen | Nulcontouren van een 2D-noise (freq 0,0045 + wat 0,016 voor kronkels), via een tweede noise geselecteerd (~25 % van de contouren). De afstand tot de middenlijn komt uit `|r| / |∇r|`. Doorsnede: breed boven (tot ±5), smal onder, wand-jitter per kolom. Vloer y 7..34 en nooit dieper dan 56 onder het oppervlak; soms een waterplas (+3) en soms lava op de bodem |
| Aquifers | Zones (2D-noise) met een waterstand per kwartslag-niveau (y 18, 24, … 42): grotlucht eronder wordt water. Op de rand van een zone en bij een niveausprong blijft een "barrière" van steen staan (onder y 48), zodat een meer altijd door rots wordt vastgehouden in plaats van door een muur van water in een open grot (zoals de barrières in Minecraft) |
| Lavameren | Grotlucht op y ≤ 10 wordt lava (ons y −54 van Minecraft). Nooit bedrock (y < 5 wordt niet geraakt) |
| Zee en kust | `carveLimit`: onder een oceaankolom, of naast een oceaankolom, wordt vanaf 3 blokken onder de bodem niet gegraven. Grotten onder zee bestaan dus nog wel, maar de zeebodem blijft heel en er komt nooit zeewater naast lucht (Vitest) |

Prestaties per chunk: de noises worden op een rooster van 4 blokken (uitgelijnd op wereldcoördinaten, dus gedeeld met de
buurchunk) gesampled en trilineair geïnterpoleerd. Een cel van 4×4×4 waarvan de acht hoekwaarden een familie niet kunnen
laten toeslaan (trilineair blijft binnen min/max van de hoeken) wordt overgeslagen zonder zijn 64 voxels te bekijken. Het
rooster loopt alleen tot de hoogste plek waar gegraven mag worden; noodle en ingangen worden alleen in hun hoogtebereik gesampled.

**Bomen en ondersteuning.** Een boom of cactus wordt niet geplaatst als zijn stamkolom is weggegraven. Bladeren van
een boom in de buurchunk komen alleen mee als die stam wel staat: de buurchunk vraagt dat via `CaveCarver.carvedAt()`, dat
dezelfde hoekwaarden door dezelfde rekenstappen haalt als de chunk-generatie (Vitest vergelijkt duizenden voxels incl. chunkranden,
0 afwijkingen). `TerrainGenerator.surfaceOpen()` doet hetzelfde voor de spawn-zoektocht, zodat niemand in een gat spawnt.

**Ertsen.** Eén tabel (`ORE_TABLE`): blok, pogingen per chunk (breuk = kans), blobgrootte (Minecraft-veingrootte), y-bereik,
uniform of driehoek, `discardOnAir` (kans dat een blok naast lucht wordt overgeslagen; 1 = alleen ingebedde ertsen) en
`minGen`. Blobs zijn ellipsoïdes langs een lijnstuk (zoals Minecraft). Elke chunk speelt de pogingen van zichzelf én de
8 buren opnieuw af en houdt alleen zijn eigen blokken, dus blobs lopen over chunkranden zonder afhankelijkheid van de
volgorde. De pogingen per laag zijn die van Minecraft (onze laag telt voor twee van hen, de veingrootte blijft), zodat het
percentage erts in het gesteente ongeveer gelijk blijft. Rijen voor blokken die nog niet bestaan (lapis, redstone, koper,
smaragd) staan er al in en doen niets zolang het blok ontbreekt of `minGen` hoger is dan de wereldversie. Ertsen vervangen
alleen steen, dus ze liggen ook in de wand van grotten en ravijnen.

### Versies en bestaande werelden

Chunks worden bij elke keer laden opnieuw uit de seed gegenereerd; alleen bewerkingen staan in de save. Een nieuwe generator
verandert dus bestaande werelden. Daarom heeft elke wereld een `genVersion` (`GenVersion.ts`): 1 = oude generator
(onveranderd, golden hashes in `tests/terrain.test.ts` bewijzen dat), 2 = deze. Het oppervlak (hoogte, biome, bomen) is in
beide versies hetzelfde, alleen de ondergrond verschilt. De versie zit in `WorldMeta.genVersion` (save-versie 3: een wereld
zonder wordt 1), in het `world.json` van de server (zonder = 1), optioneel in `welcome.genVersion` (zonder = 1, geen
protocolversie nodig) en in elk `generate`-verzoek aan de workers. Arena's negeren hem.

### Gemeten (`scripts/gen-stats.ts`, 4 seeds × 24×24 chunks, `scripts/bench-gen.ts`)

| | versie 1 | versie 2 |
|---|---|---|
| Lucht onder zeeniveau (landkolommen) | 7,4 % | 11,7 % |
| Grotopeningen aan het oppervlak per 100 landchunks | 13 | 56 |
| Grotlucht per chunk (blokken) | 1095 | 2016 |
| Lava / ondergronds water per chunk (blokken) | 187 / 0 | 332 / 449 |
| Lava boven y 10 | 0 | 0 |
| Kolen / ijzer / goud / diamant per chunk | 38 / 27 / 5,9 / 2,7 | 62 / 43 / 9,4 / 10,9 |
| Diamant per laag | y 1..15 | y 1..38 (de meeste onder 32) |
| `generate` per chunk (stille machine) | 0,82–1,09 ms | 1,13–1,67 ms (1,4–1,6×) |
| `heightAt` + `biomeAt` (+ `surfaceOpen`) per kolom | 0,8 µs | 0,8 µs (+ ~6 µs `surfaceOpen`, alleen bij de spawn-zoektocht) |
| Meshtijd (`bench-mesh.ts`, seed 12345) | 3,47 ms, 3492 driehoeken | 3,61 ms, 4286 driehoeken |

Een "opening" is een landkolom waarvan het oppervlakteblok weg is en waaronder minstens 3 blokken lucht volgen; geteld per chunk
als samenhangende groep kolommen. Het licht (`Lighting.ts`: 48×48 regio, BFS-wachtrij 2^19 tegen 300 000 cellen) heeft geen
aanpassing nodig: de skylight daalt door ingangen en ravijnen naar beneden en de regio is groot genoeg voor de holen. Mobs
spawnen ondergronds via de bestaande regel (twee blokken lucht boven een massief blok, licht 0).

### Niet gedaan / ideeën

- Ertsen: lapis, redstone, koper, smaragd, deepslate en tuff wachten op de blokken (zie `OreTable.ts`). Granite, diorite en andesite ook.
- Dripstone, mos, lush/dripstone-caves en glow berries.
- Stilstaand water in grotten stroomt pas als iemand het aanraakt (de vloeistofsimulatie draait alleen bij bewerkingen).
- De rand van een grotingang wordt niet opnieuw begroeid (kale dirt/steen in de wand; Minecraft zet daar gras).
