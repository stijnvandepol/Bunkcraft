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
- **Nog open:** garbage collection tijdens het streamen van chunks (`WorkerPool.pump`, `onmessage`), `updateMatrixWorld` over alle chunk-meshes per frame (statische meshes kunnen `matrixAutoUpdate = false`), en `toDataURL` voor de hotbar-iconen (eenmalig ~6 ms).

### Doorgevoerd (geen visuele trade-off)

1. **Opaque / cutout split.** Massieve blokken renderen zonder `discard` → early-Z blijft actief. Alleen bladeren/glas/planten zijn alpha-tested.
2. **Shadow map cache.** Alleen opnieuw renderen bij zonbeweging > ~0.18°, verplaatsing > 4 blokken of gewijzigde geometrie. Shadow pass kost op de meeste frames niets.
3. **ANGLE-vriendelijk vertexformaat.** Alle attributen 4-componentig (`Int16×4` positie+uv, `Uint8×4` data, `Uint8×4` tint); ANGLE/D3D11 converteert 3-component shorts anders op de CPU.
4. **Echte upload-budgettering** (bytes per frame) + nieuwe meshes één frame geforceerd tekenen, zodat GPU-uploads niet pas plaatsvinden als de camera draait.
5. **Geen per-frame allocaties** in game loop en shadow pass.
6. **Worker pool** `hardwareConcurrency − 2` → main thread en GPU-proces houden ruimte.

### Roadmap (volgende stappen, op volgorde van impact)

1. **16×16×16 secties** — strakkere frustum culling, kleinere remeshes.
2. **Cave/occlusion culling** (Tommo's visibility graph, zoals Minecraft/Sodium) — 50–80 % minder geometrie ondergronds.
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
