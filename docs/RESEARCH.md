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
