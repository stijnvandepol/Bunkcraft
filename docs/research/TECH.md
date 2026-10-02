# BunkCraft technisch onderzoek: rendering, threads, opslag, netwerk, architectuur, mobiel

Stand: 2 oktober 2026. Commit `209f712` (branch `feature/bunkcraft-engine`). Methode: code gelezen
(`Game.ts`, `ChunkManager`, `ChunkMesher`, `workers/*`, `server/*`), web-bronnen geraadpleegd, en vier
wegwerp-experimenten gedraaid in `scripts/experiments/`. Alles wat niet gemeten of uit een betrouwbare bron komt, staat als
**onzeker**. Bronnen met een `*` zijn secundaire bronnen (blogs, prijsaggregators): gebruik ze als richting, niet als feit.

Meetmachine: Apple Silicon (M1 Pro), Node v25.6 (V8). Dezelfde V8 draait in Chrome, maar Safari (JavaScriptCore) en
mobiele CPU's zullen andere verhoudingen geven. **Alle ms-cijfers zijn desktop-Node, geen browser.**

---

## 0. Kernconclusies

| # | Conclusie | Basis |
|---|---|---|
| 1 | De worker-tijd is bijna volledig **meshing (3,8 ms) en licht (1,35 ms daarvan)**, niet terreingeneratie (0,8 ms) | gemeten, §2.2 |
| 2 | WASM voor terrein is nu zinloos (max. 17 % van de workertijd). SIMD-WASM is wel 4,8× sneller dan onze JS-simplex, relevant **zodra 1.18-grotten (3D-noise) landen** | gemeten, §2.4 |
| 3 | `postMessage` met 290 KiB aan buurchunks kost 0,057 ms tegen 3,8 ms meshing: **SharedArrayBuffer/COOP+COEP is niet de moeite** | gemeten, §2.3 |
| 4 | De vertex-indeling (76 B per quad) is de grootste hefboom voor GPU-geheugen: ~127 KiB per chunk, ~100-140 MB bij render distance 16. Instanced quads (16 B/quad) maken dat 4,7× kleiner | gemeten + berekend, §1.6 |
| 5 | **WebGPU: no-go voor nu.** Multi-draw-indirect is nog experimenteel, Firefox Linux niet stabiel, `WebGPURenderer` niet aantoonbaar sneller | bronnen, §1.1-1.3 |
| 6 | WebTransport is sinds Safari 26.4 (maart 2026) Baseline, maar Node heeft geen serverkant. **Eerst binair protocol + quantisatie** (3× minder bytes) | bronnen + gemeten, §4 |
| 7 | De statische server comprimeert niets (`server/index.ts`): eerste load is waarschijnlijk 3-4× te zwaar. Gratis winst | code, §5.5 |
| 8 | Saves bewaren alleen edits boven de seed. Dat is compact (4 B per edit), maar **elke wijziging aan de generator corrumpeert bestaande werelden** zonder `genVersion` | code, §3.4 |

---

## 1. Rendering-technologie

### 1.1 WebGPU-status (oktober 2026)

| Browser | Status | Bron |
|---|---|---|
| Chrome/Edge | Stabiel sinds 113 (2023). Android sinds 121 (Android 12+, Qualcomm/ARM). **Linux alleen Intel Gen12+ en recente NVIDIA** | [Wikipedia WebGPU](https://en.wikipedia.org/wiki/WebGPU), [web.dev](https://web.dev/blog/webgpu-supported-major-browsers) |
| Safari | Safari 26 (juni 2025): macOS Tahoe 26, iOS 26, iPadOS 26, visionOS 26, standaard aan | [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) |
| Firefox | Windows sinds 141 (juli 2025), macOS Tahoe ARM64 sinds 145. **Linux: alleen Nightly, "verwacht in 2026"**. Android: achter flag | idem |
| Baseline | Sinds januari 2026 "Baseline" op desktop; de gaten zijn Linux en oudere mobiele GPU's | [webgpu.com*](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/) |

Wat BunkCraft zou willen gebruiken, en de stand daarvan:

| Feature | Stand | Nodig voor |
|---|---|---|
| Storage buffers + compute shaders | Core in WebGPU | GPU-meshing, culling, vertex pulling |
| `multiDrawIndirect` / `multiDrawIndexedIndirect` | Alleen als `chromium-experimental-multi-draw-indirect` achter `chrome://flags/#enable-unsafe-webgpu`; voorstel [gpuweb#2315](https://github.com/gpuweb/gpuweb/pull/2315), niet in de spec ([Chrome 131 notes](https://developer.chrome.com/blog/new-in-webgpu-131)). **Onzeker** of dit in oktober 2026 veranderd is: ik vond geen nieuwer bewijs | Alle chunks in 1 call |
| `indirect-first-instance` | Optionele feature in de spec | Compacted draws |
| `timestamp-query` | Optionele feature | GPU-timing (WebGL heeft dit niet in Safari/Firefox) |

### 1.2 Three.js `WebGPURenderer`

- Laatste cijfers die ik vond zijn van r176 (mei 2025): losse meshes ~4× trager dan WebGL, `InstancedMesh` 31k tegen 62k boxes op 60 FPS, maar bij 10 000 draw calls juist beter ([forum](https://discourse.threejs.org/t/why-webgpurenderer-performance-significantly-lower-than-webglrenderer/77629), [issue #31055](https://github.com/mrdoob/three.js/issues/31055), [issue #30560](https://github.com/mrdoob/three.js/issues/30560): UBO-systeem traag bij veel render items).
- r184 (april 2026) verwijderde het oude multi-draw-instancing-pad van `BatchedMesh` ([samenvatting*](https://www.utsubo.com/blog/threejs-2026-what-changed)).
- TSL draait sinds r184 ook onder WebGL (volgens `RESEARCH.md`): nieuwe shaders in TSL schrijven houdt de WebGPU-deur open.
- **Onzeker:** geen openbare r186-cijfers gevonden. Zelf meten, zie §1.3.

### 1.3 Go/no-go en meetplan

Projectregel: "WebGPU alleen als multi-draw-indirect standaard is en het wint van WebGL op onze benchmark".

| Criterium | Nu | Oordeel |
|---|---|---|
| Multi-draw-indirect standaard | Nee, experimenteel achter flag | niet gehaald |
| Firefox Linux | Nightly | niet gehaald |
| Wint op onze benchmark | Niet gemeten; publieke cijfers wisselend | onbekend |

**Besluit: no-go voor een migratie, wel een begrensde spike** (2 weken, aparte branch, geen merge-doel).

Nuance op de regel: multi-draw-indirect is niet strikt nodig. Met een compute-pass die zichtbare quads compact in één buffer schrijft,
volstaat één `drawIndirect` met `instanceCount` (vertex pulling, zoals [binary greedy meshing](https://github.com/cgerikj/binary-greedy-meshing) en
[Aokana](https://arxiv.org/html/2505.02017v1)). Dat vraagt wel een eigen renderpad buiten Three's materiaalsysteem. Stel voor de regel te herformuleren:
"compute-compaction werkt op Chrome, Safari en Firefox Windows/macOS, en wint op de benchmark".

**Meetplan (voordat er een regel code voor WebGPU komt):**

1. Bouw eerst de benchmark (§5, stap 2): vaste seed, vaste camerapad (wandelen + 360° draaien), `render distance` 8/16/24.
2. Metrics: frame-tijd p50/p95/p99, CPU-tijd render (`performance.now` rond `renderer.render`), GPU-tijd (WebGL: `EXT_disjoint_timer_query_webgl2`, alleen Chrome; WebGPU: `timestamp-query`), GPU-geheugen (Chrome `about:gpu`), laadtijd tot `state !== 'loading'`.
3. Apparaten: M1 Pro, een Intel UHD-laptop, een middenklasse Android (Adreno 6xx of Mali-G7x), een iPhone.
4. Spike: zelfde scene als standalone WebGPU-demo met vertex pulling (16 B/quad) + compute-frustum/cave-culling + één `drawIndirect`, tegen de WebGL2-versie met instanced quads (§1.6).
5. **Go-criterium:** ≥ 25 % lagere p99 frame-tijd of ≥ 40 % hogere render distance bij gelijke frame-tijd op ≥ 2 van de 3 desktop/mobiele apparaten, geen regressie in laadtijd, en fallback-pad naar WebGL2 blijft bestaan.

Wat WebGPU zou opleveren versus kosten:

| Voordeel | Waarde voor BunkCraft | Kosten |
|---|---|---|
| Multi-draw / indirect | Draw calls 550 → 1-4. Nu CPU-tijd render slechts 0,4-0,8 ms op M1: **winst vooral op zwakke CPU's/mobiel** | Eigen renderpad |
| Compute meshing | Mesher is 80 % van de workertijd, maar draait al parallel in workers; GPU-meshing wint pas bij hoge streamingdruk | Volledige herschrijving + licht-BFS op de GPU is lastig |
| Storage buffers / vertex pulling | 8-16 B/quad (§1.6), maar ook te bereiken in WebGL2 met instancing | Geen |
| Geen KHR_parallel_shader_compile-gedoe | Klein (compileAsync bestaat al) | |
| Twee backends onderhouden | | Hoog: Safari < 26, Firefox Linux/Android en oudere Android blijven WebGL2 nodig, dus **je onderhoudt beide** |

### 1.4 WebGL2-extensies

| Extensie | Support | Gebruik | Oordeel |
|---|---|---|---|
| `KHR_parallel_shader_compile` | Chrome/Firefox; Safari **onzeker** | Al in gebruik via `compileAsync` | Houden |
| `WEBGL_multi_draw` | ~93 % globaal; Chrome 86+, Safari 15+, **Firefox niet** ([caniuse](https://caniuse.com/wf-webgl-multi-draw)) | Eén call voor alle zichtbare chunks | Alleen met fallback-lus; zie §1.5 |
| `EXT_disjoint_timer_query_webgl2` | Chrome; Firefox en Safari niet (**onzeker**, bekend vanwege timing-aanvallen) | GPU-timing in F3 | Alleen als dev-hulpmiddel |
| `EXT_texture_compression_bptc/rgtc`, `WEBGL_compressed_texture_s3tc/etc/astc` | Verschilt per platform: desktop BC/S3TC, mobiel ASTC/ETC2 | Atlas comprimeren | Niet voor de standaardatlas, zie hieronder |
| `OVR_multiview2` | Chrome/Firefox, Safari niet | VR | Niet relevant |

**Texture-compressie.** De standaardatlas is 72 lagen × 16² × 4 B = 74 KB (met mips ~98 KB): compressie is zinloos.
Het probleem zit bij **hoge-resolutie packs** die de speler zelf importeert:

| Pack-resolutie | RGBA8 + mips (72 lagen) | ASTC 8 bpp / BC7 | ETC1S (~4 bpp) |
|---|---|---|---|
| 16 | 0,1 MB | | |
| 64 | 1,6 MB | | |
| 128 | 6,3 MB | | |
| 256 | 25 MB | 6 MB | 3 MB |
| 512 | 101 MB | 25 MB | 13 MB |

Op het niveau van een gebruikers-jar is transcoderen met Basis/KTX2 ([`KTX2Loader`](https://threejs.org/docs/pages/KTX2Loader.html) kent
`CompressedArrayTexture`) overkill. Goedkoper: bij import **downscalen naar maximaal 128 of 256 px** en een instelling "texture-resolutie" tonen. Pack-import telt dus als geheugenrisico op mobiel, niet de default.

### 1.5 Draw-pad: instancing, samengevoegde geometrie, multi-draw

Nu: per chunk tot 3 `THREE.Mesh` (opaque/cutout/water), `frustumCulled = false` met eigen culling in `ChunkManager`, `matrixAutoUpdate = false` (goed). Dat is ~550 draw calls per pass bij render distance 8, en de shadowpass komt daar bovenop.

| Aanpak | Draw calls | Geheugen | Complexiteit in Three | Oordeel |
|---|---|---|---|---|
| Nu: 1 mesh per chunk per type | ~550 (rd 8), ~2 400 (rd 16) | Veel kleine buffers | Geen | Prima op desktop (0,4-0,8 ms CPU op M1) |
| `BatchedMesh` | 1-3 | Vaste pool, matrices in texture | Matig; chunk-lokale `packed` positie moet de batching-matrix gebruiken. **Onzeker** of ons custom materiaal dit netjes ondersteunt | Eerst prototypen |
| Eigen vertex/index-pool + `WEBGL_multi_draw` | 1-3 | Eén grote buffer, suballocatie (zie [vertex pooling](https://nickmcd.me/2021/04/04/high-performance-voxel-engine/)) | Hoog: buiten Three's render-lijst | Pas na meting op zwakke CPU |
| Instanced quads, één draw per chunk | ~550 | 4,7× kleiner (§1.6) | Laag | **Eerst dit** |
| Indirect culling op GPU | 1 | | Alleen WebGPU | §1.3 |

Advies: de CPU-kant van draw calls is op desktop niet het knelpunt (gemeten). Het wordt dat op Chromebooks/Mali. Dus **eerst meten op een zwak apparaat** voordat er een multi-draw-pool komt.

### 1.6 Vertex-indeling: gemeten en alternatieven

Gemeten (`bench-pipeline.ts`, seed 12345): **6 823 vertices en 127 KiB per chunk, 19,1 B per vertex inclusief indices.**
Huidig: `Uint16×4` (pos×16 + uv) + `Uint8×4` (laag, normaal/AO/flags, sky, block) + `Uint8×4` (tint) = 16 B per vertex, ×4 per quad + 6 indices × 2 B = **76 B per quad**.

| Indeling | B/quad | GPU per chunk | Bij rd 16 (~800 meshes) | Opmerking |
|---|---|---|---|---|
| Huidig (4 vertices + index) | 76 | 127 KiB | **~100 MB** | ANGLE-vriendelijk, werkt overal |
| Instanced quad (per-instance attributes, `vertexAttribDivisor`) | 16 | ~27 KiB | ~21 MB | WebGL2-compatibel; 4 vertices uit `gl_VertexID` + statische quad |
| Idem + hoekwaarden gepakt | 16 | | | pos 15 b + breedte/hoogte 8 b, laag 7 b, normaal 3 b, AO 4×2 b, licht 4 hoeken × (4+4) b = 32 b (+32 b voor positie/maat/laag) |
| Binary greedy (vertex pulling, WebGPU) | 8 | ~14 KiB | ~11 MB | Geen smooth light/AO per hoek; wij hebben dat wel, dus 16 B realistisch |

Daarbij komt: minder bytes uploaden en over `postMessage` sturen (de mesh-resultaten worden getransfereerd), 4,7× kleinere `index`-buffer valt weg.
Risico: AO-quadrant-flip en smooth light per hoek moeten in de shader uit gepakte bits komen; greedy-merges beperken tot 15 breed (UV-packing) verdwijnt als breedte apart wordt opgeslagen (nu: UV `u16 + v16*241`).
Voeg erbij: **quads per richting groeperen** (6 draw-ranges per chunk) en richtingen weglaten die van de camera af wijzen: 30-50 % minder vertices ([RESEARCH.md](../RESEARCH.md)).

### 1.7 Culling en occlusie

| Techniek | Winst | Kosten | Oordeel |
|---|---|---|---|
| Chunk-frustum (aanwezig) | basis | | |
| Per-richting face-culling | 30-50 % vertices | Quads per richting sorteren in de mesher | **Doen** (samen met §1.6) |
| Tommo's cave culling ([visibility graph](https://tomcc.github.io/2014/08/31/visibility-2.html)) | 50-80 % geometrie ondergronds (volgens RESEARCH.md); bovengronds weinig | Per chunk 6×6 bitmatrix uit flood-fill in de mesher (~0,1-0,3 ms), BFS op main thread per frame | **Doen**; wordt belangrijker met 1.18-grotten |
| 16³-secties | Strakkere culling, kleinere remeshes bij een edit (nu: hele 16×16×128-kolom) | Mesher/ChunkManager-refactor | Waardevol, zie §3.1 |
| `ANY_SAMPLES_PASSED_CONSERVATIVE` occlusion queries | 1 frame latentie, pop-in | Veel queries = veel stalls op tilers | **Niet doen** (visibility graph is beter) |
| Hi-Z occlusion | Hoog | Alleen met compute (WebGPU) | later |

### 1.8 Schaduwen en AO

| Optie | Nu / advies |
|---|---|
| Eén ortho shadow map met cache (aanwezig: alleen opnieuw bij zon > 0,18° of verplaatsing > 4 blokken) | Behouden. Pass kost op de meeste frames niets |
| Cascaded shadow maps (2-3) | Pas bij schaduwafstand > 64 blokken; 2-3× schaduwkosten. Niet nodig |
| AO per vertex (aanwezig, met quad-flip) | Behouden; gratis, beter dan SSAO voor blokken |
| SSAO / contact shadows | Mist-pass + diepte-buffer; duur op iGPU en tilers. **Niet doen** |
| Baked skylight in vertex (aanwezig) | Behouden; vandaar dat schaduwmap alleen voor directe zon dient |

### 1.9 LOD voor verre chunks

Het terrein komt deterministisch uit de seed. Dat is een groot voordeel: **verre LOD hoeft nergens opgeslagen te worden** (Distant Horizons moet LOD-data persisteren, [DH](https://gitlab.com/distant-horizons-team/distant-horizons)).

| Aanpak | Effect | Kosten | Oordeel |
|---|---|---|---|
| Heightmap-ring: 2D hoogte+kleur per 4×4 kolommen, één grid-mesh per 16×16 chunks, tot 48 chunks, mist verbergt de overgang | Schijnbare afstand 16 → 48 chunks voor ~+10 % GPU (schatting) | Aparte 2D-pass in de generator-worker (`height()` + biome; waarschijnlijk < 0,1 ms/chunk, **onzeker**), eigen shader zonder licht-BFS, overgangsrand | **Hoogste visuele winst per euro** |
| Octree-voxel-LOD (DH/Voxy) | Mooiste resultaat | Hoog, ook bewerkingen moeten LOD-data bijwerken | Niet nu |
| Verlaagde detail-meshing per afstand (geen AO, geen cutout) | 15-25 % goedkoper per verre chunk | Tweede mesher-pad | Alleen als goedkope tussenstap |

Houd er rekening mee dat bewerkte chunks (edits) in LOD ontbreken; edits ver weg zijn zeldzaam, dus 1× per edit-chunk de kolom invalideren is genoeg.

---

## 2. Workers en threads

### 2.1 Huidige opzet

- `WorkerPool`: grootte `max(1, min(4, hardwareConcurrency − 2))`, twee prioriteitsniveaus, crash-herstel (3 pogingen), fabriek-injectie voor tests.
- Mesh-aanvraag: 9 buurchunks + 9 biome-arrays + metas worden **gekloond** (niet getransfereerd); mesh-resultaten worden wel getransfereerd.
- `maxInFlight = pool.size × 2`; upload-budget 1,5 MiB per frame.

### 2.2 Waar de workertijd heen gaat (gemeten)

`scripts/experiments/bench-mesh-phases.ts`, 147 meshes, seed 12345:

| Fase | ms/chunk | Aandeel |
|---|---|---|
| Terreingeneratie (apart, stabiel) | 0,80 | |
| Mesh totaal | 3,82 | 100 % |
| ... licht-BFS (`LightEngine.compute`, 48×48×130) | 1,35 | 35 % |
| ... greedy meshing (6 vlakken) | 1,94 | 51 % |
| ... crosses (planten) | 0,24 | 6 % |
| ... tints | 0,11 | 3 % |
| ... region-kopie | 0,07 | 2 % |
| ... licht uitlezen | 0,05 | 1 % |

Totaal per chunk (genereren + meshen): ~4,6 ms. Voor render distance 16 (~800 chunks) is dat 3,7 s CPU-tijd, ~0,9 s bij 4 workers (ideaal). De bestaande "mesh alleen buren die de bewerking raken"-optimalisatie is dus terecht; **licht herberekenen is het eerste doelwit** (de "persistente lichtcache per chunk" staat nog open in `ROADMAP.md`).

Vergelijking met de literatuur: binary greedy meshing haalt gemiddeld 74 µs voor een 64³-chunk in native code op een Ryzen 3800X, 50-200 µs bereik ([README](https://github.com/cgerikj/binary-greedy-meshing)) zonder licht/AO. Wij zitten op 3,8 ms voor 16×16×128 (32k voxels): dus enkele orden langzamer per voxel, maar met smooth light, AO en meta. Een groot deel van dat gat is licht-BFS, niet greedy.

### 2.3 Payload-kosten: SharedArrayBuffer is niet nodig

Gemeten (`bench-pipeline.ts`): payload van één mesh-aanvraag = 290 KiB.

| Methode | Kosten per aanvraag |
|---|---|
| `structuredClone` (huidig) | 0,057 ms |
| `postMessage` + ontvangen | 0,055 ms |
| Klein descriptor-bericht (zoals bij een SAB-pool) | 0,002 ms |
| Mesh zelf | 3,8-4,2 ms |

De kloon is **1,4 % van de meshtijd**. Bij een burst van 30 aanvragen is dat ~1,7 ms verspreid over frames. De winst van SAB zou vooral in minder GC-allocaties zitten (290 KiB × aanvragen), niet in rekentijd.

**COOP/COEP-set en wat het kost:**

| Header (op het hoofddocument) | Waarde |
|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` (of `credentialless`: Chrome 96+, Firefox 119+, **niet in Safari tot en met 27**, [caniuse](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)) |
| Subresources cross-origin | `Cross-Origin-Resource-Policy: cross-origin` of CORS (`crossorigin`-attribuut) |
| Controle | `self.crossOriginIsolated === true` ([web.dev](https://web.dev/articles/cross-origin-isolation-guide)) |

| Wat breekt | Gevolg voor BunkCraft |
|---|---|
| Cross-origin iframes/embeds zonder CORP (YouTube, analytics, advertenties) | CrazyGames/Poki/itch-embeds: wij zijn dan zelf de iframe; zij moeten isolatie toestaan. **Onzeker** per portal; itch.io heeft een SAB-optie (niet geverifieerd) |
| OAuth/betaalpop-ups | Breken met `same-origin`; `same-origin-allow-popups` is een mildere variant |
| Safari + `credentialless` | Valt terug op `require-corp`, dus elke externe afbeelding/font moet CORP hebben |

Advies: **niet doen**. Gemeten winst ≈ 0, distributiekosten hoog. Houd het als optie voor een toekomstige WASM-threads-mesher.

### 2.4 WASM-microbenchmark (gemeten)

Toolchain: Rust, Zig, Emscripten en wabt waren **niet geïnstalleerd**; `clang` heeft geen wasm32-target. Alleen **AssemblyScript** (via npm) was beschikbaar,
met SIMD (`--enable simd`). Rust/Zig geven normaal gelijkwaardige of iets snellere code; Rust-cijfers hieronder zijn dus een **schatting uit literatuur (onzeker)**, de AS-cijfers zijn gemeten.

`scripts/experiments/bench-wasm-noise.ts`: 16×128×16 = 32 768 samples 3D-noise, 400 rondes na 100 warm-up, Node 25.

| Variant | ms/chunk | ns/sample | Versnelling |
|---|---|---|---|
| JS simplex3 (de `SimplexNoise` uit het spel, f64) | 1,217 | 37,1 | basis |
| JS Perlin-3D (gelijk algoritme als WASM, f64) | 1,878 | 57,3 | 1× |
| WASM scalar Perlin (AssemblyScript, f32) | 0,822 | 25,1 | 2,3× |
| **WASM SIMD Perlin** (4 lanes in x, f32x4, geen tabel-gathers) | **0,255** | 7,8 | **7,4×** (4,8× t.o.v. de simplex van het spel) |

Correctheid: maximale afwijking WASM-JS 8,3e-7 (f32 tegenover f64). De output is dus bruikbaar, maar **niet bit-identiek**: bij WASM-terrein moet de generator op client én server dezelfde implementatie draaien, anders verschillen werelden (zie §3.4).

Wat dit betekent:

| Vraag | Antwoord |
|---|---|
| Is WASM nu zinvol voor terrein? | **Nee.** Volledige generatie is 0,8 ms (< één volle 3D-noise-fill van 1,2 ms: de generator gebruikt dus vooral 2D-noise). Tegen 4,6 ms totale pijplijn is dat max. 17 % |
| Wanneer wel? | Als 1.18-grotten (3 × 3D-noise, octaven) landen: 3 noises × 2-3 octaven ≈ 7-11 ms in JS per chunk volledig uitgerekend |
| Goedkoper alternatief? | Minecraft **sampelt op een grof raster en interpoleert** (celgrootte 4×8×4 = 5×17×5 = 425 samples in plaats van 32 768, 77× minder). In JS ~16 µs per noise. **Eerst dit** (S), WASM later |
| WASM voor de mesher? | Mogelijk 2-4× op licht + greedy (schatting uit literatuur, **onzeker**). Eerst algoritme: bit-rij-greedy (zie §2.5) |
| Kost van WASM | Buildketen (Rust/AS) in Vite, geheugen-copy over de JS/WASM-grens (Uint8Array → lineair geheugen, ~32 KB × 9), debuggen, bit-exacte parity met de server |

### 2.5 Snellere mesher in JS (aanbeveling)

Een chunk is 16 breed: een rij past in **één 16-bits getal**. Binary greedy meshing (bitmasks, `Math.clz32`/`ctz`) is dus natuurlijk in JS, zonder BigInt. Verwachting: greedy-deel (1,94 ms) 2-4×, **onzeker**. Eisen: golden-tests (`tests/mesher.test.ts`) moeten dezelfde quads opleveren, en 15-merge-limiet vervalt als de breedte apart wordt gepakt (§1.6).
Licht-BFS (1,35 ms): beperk tot de sectie die verandert en cache per chunk (alleen kolommen waar de buren veranderden).

### 2.6 Aantal workers

| Situatie | Formule nu (`min(4, hc − 2)`) | Advies |
|---|---|---|
| 2 cores | 1 | OK |
| 4 cores (Chromebook/telefoon) | 2 | OK: GPU- en UI-thread houden ruimte; **op mobiel max. 2 vanwege thermiek** |
| 8-12 cores (desktop) | 4 | Cap verhogen naar 6 bij hc ≥ 10: ~30 % snellere initiële laadtijd bij rd 16 (schatting, **onzeker**; geheugen: elke worker heeft ~3 MB regionbuffers + mesher) |

Eerste meshes mogen sneller via "eerst dichtbij" (bestaat: offsetlijst gesorteerd op afstand).

### 2.7 OffscreenCanvas / render in worker

| Voordeel | Nadeel |
|---|---|
| Main thread vrij van `render()`; GC-pauzes raken frames niet | `Game.ts` en 30+ modules praten rechtstreeks met Three en DOM; pointer lock/input blijft op main (extra latentie via `postMessage`) |
| | Safari-support voor WebGL in workers is recent (Safari 17+, **onzeker** op details); debuggen lastiger |

CPU-tijd van render is 0,4-0,8 ms. **No-go**: te veel herschrijving voor te weinig winst. Heroverweeg alleen als de UI/DOM de main thread belast.

### 2.8 Main-thread budget per frame

| Frame | Budget bij 60 Hz | Bij 120 Hz | Nu (M1 Pro, gemeten) |
|---|---|---|---|
| Totaal | 16,7 ms | 8,3 ms | mediaan 8,3 ms (schermlimiet), p99 9,3 ms |
| Render (CPU) | ≤ 3 ms | ≤ 2 ms | 0,4-0,8 ms |
| Chunk-uploads | ≤ 2 ms (budget 1,5 MiB/frame) | ≤ 1 ms | binnen budget |
| Fysica + tick + AI | ≤ 3 ms | ≤ 2 ms | klein |
| UI/DOM | ≤ 1 ms | | klein |
| Marge voor GC | ≥ 3 ms | | `WorkerPool.onmessage` en `Map.get` met grote sleutels alloceren nog (zie `RESEARCH.md`) |

Yielden: `scheduler.yield()` Chrome 129+, Firefox 142+, **Safari niet**; `isInputPending()` alleen Chromium en niet meer aanbevolen ([web.dev](https://web.dev/articles/optimize-long-tasks)). Voor ons weinig relevant: de zware arbeid zit in workers, de main thread heeft geen lange taken. Gebruik `requestIdleCallback` alleen voor autosave-voorbereiding (niet in Safari: fallback `setTimeout`).

---

## 3. Geheugen en opslag

### 3.1 Chunk-geheugenlay-outs

Gemeten op 81 chunks (seed 12345), per chunk 32 KiB ruw (`x | z<<4 | y<<8`, dus één 16³-sectie is 4 096 opeenvolgende bytes):

| Representatie | KiB per chunk | Opmerking |
|---|---|---|
| Ruw `Uint8Array` 16×16×128 (nu) | 32,0 | O(1) `getBlock`, geen decodeerkosten |
| Palet per 16³-sectie (bits per blok) | 7,9 | 30 % van de secties is uniform (lucht/steen): 1 byte. `getBlock` kost een extra opzoeking |
| RLE (waarde, lengte) in kolomvolgorde | 2,4 | Alleen voor opslag/netwerk; niet voor hot paths |
| deflate level 6 (fflate) | 0,9 | 0,30 ms op level 1 voor 32 KiB |
| gzip level 1 | 1,2 | |

Geheugen bij render distance 16 (~960 chunks incl. generatie-radius): blokdata ~30 MB ruw (palet: ~8 MB), GPU-geometrie ~100-140 MB (§1.6). **Geometrie, niet blokdata, is de grote post.**
Secties (16³) zijn vooral een **mesh- en cullingwinst** (kleinere remeshes en culling), niet een geheugenwinst; ze veranderen `Chunk.blocks`, de mesher-regio en de wereld-API in één keer. Plan: eerst mesh-secties over de bestaande kolom (lees-venster van 16 hoog), pas daarna de opslag.

Block-state `meta` is lazy (0 bytes tot gebruikt, `BLOCKSTATES.md`): goed.

### 3.2 IndexedDB: patronen en quota

Huidig (`SaveSystem.ts`): twee stores (`worlds`, `chunks` met sleutel `[worldId, chunkKey]`), per vuile chunk één `put` van een `Uint32Array` met alle edits van die chunk; dirty-set wordt pas gewist na commit; retry bij falen.

| Punt | Beoordeling |
|---|---|
| Schrijfpatroon | Goed: alleen vuile chunks, één transactie. Schrijfamplificatie: één edit herschrijft de hele chunk-edit-array (bij 10 000 edits = 39 KiB), verwaarloosbaar |
| Opslaggrootte | 4 B per edit. 10 000 edits = 39 KiB, 1 miljoen = 3,8 MiB. Een wereld blijft dus klein; groei wordt gedreven door **gebouwde** blokken, niet door verkende terrein |
| Quota Chrome | ~60 % van de schijf per origin ([web.dev storage](https://web.dev/articles/storage-for-the-web)), **onzeker** op exacte waarden |
| Safari ITP | Alle scriptbare opslag (IndexedDB, localStorage, SW) wordt gewist na **7 dagen Safari-gebruik zonder interactie met de site** ([WebKit](https://webkit.org/tracking-prevention/)); **geïnstalleerde home-screen web-apps zijn vrijgesteld** ([Apple forum](https://developer.apple.com/forums/thread/710157)). `storage.persist()` is sinds Safari 17 betekenisvoller, heuristisch toegekend (bv. home-screen app); of het sterker beschermt dan ITP is niet gedocumenteerd |
| Wat de code al doet | `navigator.storage.persist()` aangeroepen (ROADMAP: gedaan) |

Aanvullend (S): toon in het wereldmenu `navigator.storage.estimate()` en bij Safari (zonder PWA) een hint "installeer op beginscherm of exporteer je wereld"; **export/import als zip** (fflate is aanwezig) is dé verdediging tegen ITP en tegen verlies.

### 3.3 OPFS als alternatief

| | IndexedDB | OPFS + `FileSystemSyncAccessHandle` |
|---|---|---|
| Support | Overal | Async API: Safari 15.2+; sync handle in dedicated worker: Safari 16.4+ ([PowerSync*](https://powersync.com/blog/sqlite-persistence-on-the-web), `readwrite-unsafe` alleen Chrome 121+) |
| Snelheid grote binaire blokken | Basislijn | ~3-4× sneller; 100 MB: 90 ms tegenover 850 ms (secundaire bron*) |
| Past bij ons? | Onze writes zijn KB-groot en zeldzaam | Zinvol bij **volledige chunkopslag** (als de seed-aanpak wegvalt) of SQLite-WASM |
| ITP | Onderhevig | OPFS is ook scriptbare opslag, dus ook onderhevig (**onzeker**) |

**Besluit:** IndexedDB behouden. OPFS pas bij een besluit voor volledige chunkopslag.

### 3.4 Het echte risico: edits-over-seed

De wereld = `generator(seed)` + edits. Elke wijziging aan `TerrainGenerator` (nieuwe grotten, ravijnen, ertsaders, structuren: allemaal in uitvoering) verandert de basis en dus wat bestaande edits *betekenen*: gebouwen hangen in de lucht, grotten snijden door huizen. `grep genVersion` vindt **nog niets** op deze branch (het staat in de ROADMAP als "in uitvoering").

| Strategie | Kosten | Oordeel |
|---|---|---|
| `genVersion` per wereld; oude generators bevriezen (kopie van de code per versie) | Codegroei, maar eenvoudig | Minimaal nodig |
| Bij laden van een wereld met oudere `genVersion`: chunk **eenmalig volledig opslaan** zodra deze bezocht is (lazy-freeze) | 0,9 KiB per bezochte chunk met deflate (gemeten); een verkende wereld van 2 000 chunks = ~2 MB | **Aanbevolen**: nieuwe werelden profiteren van nieuwe generator, oude blijven intact |
| Altijd volledige chunks opslaan (Minecraft-model) | ~0,9-8 KiB per chunk, grotere schrijfvolumes | Alleen als structuren/grotten sterk blijven veranderen |

Bij multiplayer geldt hetzelfde: `world.json` en `welcome.edits` moeten `genVersion` meenemen, en client en server moeten dezelfde generator-versie draaien (anders ziet een client een andere wereld).

### 3.5 Compressie

| Waar | Nu | Voorstel |
|---|---|---|
| Wereldsave in IDB | Edit-lijst, 4 B/edit, onge-comprimeerd | Niet nodig bij edit-model; bij lazy-freeze: `CompressionStream('deflate-raw')` of fflate level 1 (0,30 ms per chunk in JS) in een worker |
| `welcome.edits` (JSON `x, y, z, id, meta`) | ~20 B per edit als tekst | Binair (Uint32 `index<<16 \| state` + chunkkey) + deflate: ~4 B/edit ruw, minder met deflate (geschat 2-3× extra, **niet gemeten**) |
| Snapshots | JSON | zie §4.3 |
| Export zip | fflate aanwezig | Ja (§3.2) |

`CompressionStream` is breed beschikbaar (Chrome 80, Firefox 113, Safari 16.4; uit mijn geheugen, niet opnieuw geverifieerd) en asynchroon, dus main-thread-vriendelijk.

### 3.6 GPU-geheugenbudget

| Post | Grootte | Opmerking |
|---|---|---|
| Chunk-geometrie rd 8 / 16 / 24 | ~30 / ~100-140 / ~230 MB | Op basis van 127 KiB per chunk × ~(π(rd+0,5)²) meshes; grotten en bergen maken het meer (**onzeker**) |
| Shadow map 2048² depth | 16 MB | 4096²: 64 MB; wordt geklemd op `maxTextureSize` |
| Atlas (16 px, 72 lagen) | 0,1 MB | Pack-import: tot 100 MB bij 512 px (§1.4) |
| Framebuffer | 1280×720×(4+4) ≈ 7 MB; Retina-scale ×4 | Dynamische resolutie bestaat |
| iOS-limiet | **~384 MB totaal canvasgeheugen**, daarna context loss of tab-crash ([WebKit-bugs*](https://bugs.webkit.org/show_bug.cgi?id=261331), **onzeker**; Apple documenteert dit niet) | Budget voor mobiel: totaal ≤ 200-250 MB, dus rd ≤ 8-10 en shadows uit/low |

Consequentie: de **instanced-quad-indeling (§1.6)** is voor iOS geen luxe maar de manier om rd 12+ binnen het budget te houden.

---

## 4. Netwerk

### 4.1 Transportopties

| | WebSocket (nu) | WebTransport | WebRTC DataChannel |
|---|---|---|---|
| Betrouwbaarheid | Betrouwbaar, geordend (TCP, head-of-line-blocking) | Streams + **unreliable datagrams** | Per kanaal instelbaar (unreliable/unordered) |
| Support client | Overal | **Baseline sinds maart 2026**: Chrome 97+, Firefox 114+, Safari 26.4+, ~91 % wereldwijd ([caniuse](https://caniuse.com/webtransport)) | Overal |
| Serverkant Node | `ws` (volwassen) | **Geen ingebouwde ondersteuning**; community-pakket `@fails-components/webtransport` (libquiche) wordt als "duct tape" omschreven ([bron*](https://websocket.org/comparisons/webtransport/)) | `node-datachannel` e.d.; signalering via WS |
| Infra | Past achter Caddy/nginx | Vereist HTTP/3 (UDP 443) en geldig certificaat; Caddy-proxying van WebTransport **onzeker**; Cloudflare Durable Objects bieden hier voor zover ik weet geen serverkant (**onzeker**) | NAT-traversal, TURN-kosten |
| Winst | | Geen HOL-blocking, 0-RTT | Idem, meer opzet |

**Wat levert het voor 20 Hz snapshots?** Alleen bij pakketverlies. Bij 0 % verlies (bedraad/wifi dichtbij) is er geen verschil. Bij 1-3 % verlies (mobiel, hotel-wifi) vertraagt TCP een verloren segment ~1 RTT + RTO, en alle volgende snapshots staan erachter: hapering van 100-300 ms (schatting, **niet gemeten**). Voor positie-updates is een late snapshot waardeloos. Dus het helpt de arcade-modes (hitscan, bunny-hop) het meest.

**Advies:** nu **geen** nieuw transport. Eerst (a) binair, gequantiseerd protocol (§4.3), (b) een `Transport`-interface (`send(unreliable|reliable, bytes)`, `onmessage`) tussen `NetClient`/`GameServer` en de socket, zodat WebTransport later bijsteekt als er Node-support komt. Herbeoordeel wanneer Node zelf `WebTransport` levert of arcade breed gespeeld wordt.

### 4.2 Gemeten fan-out-kosten van één Node-proces

`scripts/experiments/bench-ws-fanout.ts`: `ws`-server op één kern, 8-spelerssnapshot (409 B JSON) naar N sockets op 20 Hz, 100 ticks, clients in een worker thread (localhost, dus netwerkstack-kosten zijn lager dan internet).

| Sockets | Event-loop bezet, zonder deflate | Met `perMessageDeflate` |
|---|---|---|
| 16 | 2,0 % | 2,4 % |
| 64 | 1,6 % | 13,3 % |
| 256 | **6,1 %** | **16,1 %** |

Dat is ~12 µs per `send` zonder deflate, ~60 µs met deflate (3-5× duurder, plus ~300 KB zlib-context per socket als `*NoContextTakeover` niet is gezet; `ws` waarschuwt hier zelf voor geheugenfragmentatie).
De winst is klein: JSON 409 B → deflate 112 B (gemeten), maar binair-gequantiseerd is ~137 B zonder CPU-kosten. **Zet `perMessageDeflate` uit voor snapshots** (`ws` heeft dat standaard uit); gebruik compressie alleen voor grote eenmalige berichten (`welcome.edits`), met `threshold` ≥ 1 KB.

### 4.3 Snapshots: delta, quantisatie, interest

Gemeten (`bench-pipeline.ts`), 8 spelers per snapshot:

| Formaat | Bytes | Bandbreedte per ontvanger bij 20 Hz | Opmerking |
|---|---|---|---|
| JSON (nu) | 409 | 8,0 KiB/s | `JSON.stringify` 1,3 µs, 1× per broadcast |
| JSON + deflate level 1 | 112 | 2,2 KiB/s | 28 µs per snapshot (JS) |
| Binair, gequantiseerd (17 B/speler) | ~137 | 2,7 KiB/s | Geen CPU-kosten |
| Binair + delta t.o.v. vorige tick (varint, ~6-8 B/speler) | ~60-70 (schatting) | ~1,3 KiB/s | **Onzeker**, niet gebouwd |

Quantisatie: positie in 1/32 blok (i32 of i24 relatief aan een anker), yaw/pitch 1 byte (1,4°), flags 1 byte, `held` 2 bytes. Voor een room van 8: uitgaand 65 KiB/s (JSON) tegenover ~22 KiB/s (binair). Bij 100 actieve rooms is dat 52 Mbit/s tegenover 17 Mbit/s (traffic is bij de meeste VPS-aanbieders innegrepen, dus dit is vooral latentie/CPU, geen kostenpost).

**Interest management:** mobs en items zijn al radius-gebaseerd (SERVER.md); spelers-`snap` gaat naar iedereen. Bij ≤ 16 spelers prima. Bij grotere rooms: radius (64-96 blokken) en lagere frequentie voor verre spelers (5 Hz).

**Protocolversie:** `PROTOCOL_VERSION` is één getal met strikte gelijkheid (`GameServer.ts:320` kickt anders). Dat dwingt lock-step deploys af en botst met een PWA/service worker die een oude client cachet. Zie §5.4.

### 4.4 Hoeveel rooms/spelers per kern?

Gemeten per tick (SERVER.md en eigen metingen): idle 0,03 ms, ~0,3 ms tijdens chunkgeneratie; arcade-room met 16 spelers: 0,05 ms + ~0,1 ms berichten; fan-out 16 sockets × 12 µs = 0,19 ms. **Niet end-to-end gemeten**: ingaande `pos`-berichten (JSON-parse + validatie), GC-jitter, schijf-saves.

| Scenario | CPU per tick | Aandeel van 50 ms | Rooms bij 50 % van één kern |
|---|---|---|---|
| Arcade, 16 spelers, schieten | ~0,35 ms | 0,7 % | ~70 rooms (1 100 spelers) |
| Minecraft-sandbox, 8 spelers, mobs, rustig | ~0,15-0,3 ms | 0,3-0,6 % | ~80-160 rooms (640-1 280 spelers) |
| Minecraft met veel chunkgeneratie (nieuwe wereld) | piek 1-3 ms | 2-6 % | beperkt door pieken, geen gemiddelde |

Geheugen: "een paar MB per geladen game" (SERVER.md), dus 200 rooms ≈ 0,5-1 GB (**onzeker**; mobs en chunks tellen mee). `MAX_ROOMS` staat op 200.
Realistisch plafond voor één Node-proces vóór je tick-vertraging (p99) ziet: ~50-70 actieve rooms. **Meet `tick lateness` (p50/p99) in `/health`** voordat je schaalt.

### 4.5 Schalen over processen

Rooms zijn onafhankelijk: geen gedeelde staat. Dat maakt sharding eenvoudig.

1. **Eén proces per kern**, N processen achter Caddy/nginx. `cluster` van Node is ongeschikt (WebSocket-sticky), dus gebruik **routering op roomcode**: Caddy `lb_policy uri_hash`-achtig of nginx `hash $uri consistent` op `/ws/<CODE>` (**onzeker**: exacte directive controleren).
2. Roomcodes zo genereren dat `hash(code) % N` de shard kiest; `POST /api/rooms` stuurt de client naar de juiste shard (of de client maakt de code lokaal aan). Geen centraal register nodig.
3. `data/rooms/<CODE>/` blijft lokaal bij de shard (`DATA_DIR` per proces); hoofdwereld op shard 0.
4. `/health` + `/metrics` (tick lateness, rooms, spelers, heap) en een eenvoudige alert.

### 4.6 Hosting (indicatief; controleer actuele prijzen, bronnen zijn deels secundair*)

| Optie | Prijs (indicatief) | Past bij BunkCraft? |
|---|---|---|
| Hetzner Cloud CX23 (voorheen CX22): 2 vCPU, 4 GB | ~€6/mnd (prijzen zijn in 2026 verhoogd, [Hetzner](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)) | **Beste prijs/prestatie**; 1 proces/kern, Docker + Caddy zoals nu. Locaties: EU/VS |
| Fly.io Machines: shared-cpu-1x 256 MB | ~$2,19/mnd na prijsstijging 1 okt 2026* ([bron*](https://fly.io/pricing/)) | Multi-regio dichtbij spelers; UDP ondersteund (relevant bij WebTransport); per-machine opslag via volumes |
| Cloudflare Durable Objects | Workers Paid + $0,15 per miljoen requests (na 1 M) en $12,50 per miljoen GB-s (na 400 k); inkomende WS-berichten tellen 20:1; uitgaand gratis ([docs](https://developers.cloudflare.com/durable-objects/platform/pricing)) | Eén DO per room; opslag in DO-storage. Zie berekening hieronder |

**Durable Object-rekenvoorbeeld (eigen schatting):** arcade-room, 16 spelers, 20 Hz `pos`: 320 inkomende berichten/s → 1,15 M/uur → 57,6 k "requests" (20:1) = $0,009/uur. Duur: DO blijft wakker bij 20 Hz-tick, 128 MB × 3 600 s = 460 GB-s/uur = $0,006/uur. **≈ $0,015 per room-uur, $0,001 per speleruur.** Goedkoop, maar: poort van `ws`+Node-worker naar Workers-runtime (L), geen `worker_threads` voor terreingeneratie (arcade-arena is plat, Minecraft-rooms zouden in de DO zelf genereren), 128 MB-limiet, en leveranciers-lock-in. **Aanbeveling:** Hetzner/Fly nu; DO eventueel later voor arcade-rooms (nul-onderhoud, wereldwijd, geen sharding).

---

## 5. Architectuurreview

### 5.1 Waar het schuurt

| Punt | Bewijs | Impact |
|---|---|---|
| `Game.ts` doet alles | 1 501 regels (1 426 gevuld), ~63 imports, tientallen velden, staten menu/loading/playing/paused/inventory/dead/chat. ROADMAP noemde "~1 000 regels" al een probleem | Merge-conflicten tussen parallelle features; elke feature raakt hetzelfde bestand |
| Modus via nullable velden | 24× `this.net`, 32× `this.arcade`, plus `roomCode`, `previewServer`, `afterLoad` | Drie spelsoorten (singleplayer, multiplayer-sandbox, arcade) in één klasse; bugs door vergeten null-checks |
| Eén `tsconfig` voor alles | `lib` heeft `DOM`+`WebWorker`, `types` heeft `node`; `server/` importeert `../src/...` (~30 importregels uit `src/`) | Er is geen afgedwongen grens: serverbestand kan per ongeluk `document` of Three gebruiken; client kan `node:` importeren |
| Protocol | 41 berichttypen JSON, één integerversie met strikte gelijkheid, geen capability-onderhandeling | Elke wijziging forceert een lock-step-deploy; oude gecachete clients worden gekickt |
| Savemigraties | `version` + `MIGRATIONS`-lijst (goed), maar **geen `genVersion`** (§3.4) en geen automatische back-up vóór migratie | Hoogste dataverliesrisico |
| Singleton-achtig | Module-level registries (`BlockRegistry`, `TEXTURE_NAMES`) en `window.game` in dev | Registers zijn data, acceptabel; testbaarheid van `Game` is laag (geen injectie) |
| Entity-code | `Entity/Mob` zijn zuiver (geen DOM/Three), renderers apart. **Dit is goed.** Canvas-gebruik zit alleen in `ItemRenderer`/`MobRenderer` (iconen/atlas) | Geen actie |
| Positief | `WorkerPool(factory)` en `ChunkManager(pool)` zijn geïnjecteerd en getest (`workerPool.test.ts`); pure modules (`Liquids`, `Collision`, `ArcadeLogic`) hebben Vitest; CI draait typecheck+test+build | Patroon om te herhalen |
| Build/CI | Vite 8, TS 7, Vitest 4; CI op Node 22; geen lint (Biome open); geen bundle-budget; geen prestatie-regressietest | Zie §5.5 |

### 5.2 Voorgestelde doelarchitectuur

```
src/
  shared/            (geen DOM, geen Three, geen node:) protocol, constants, world/terrain, entities-logica,
                     player/stats, items, modes   <- ook door server gebruikt
  client/
    app/             Game (dunne compositie), GameStateMachine, SimulationLoop (60 Hz fysica + 20 Hz tick)
    session/         WorldSession (singleplayer: world+save), NetSession (multiplayer), ArcadeSession
    systems/         CombatSystem, InteractionSystem, AudioSystem, AdvancementSystem, DebugInfo
    input/           Input -> Actions -> PlayerCommand (command-pattern)
    render/          Renderer, ChunkManager, mesher, materials, sky, HUD-bruggen
    ui/
  server/            GameServer, Rooms, ServerWorld, Match  (importeert alleen shared/)
```

Kernideeën:

- **`Session`-interface** (`update(dt)`, `onMessage`, `dispose`) met drie implementaties vervangt de nullable `net`/`arcade`-velden. `Game` heeft precies één actieve sessie.
- **`SimulationLoop`** bezit de accumulator (fixed 60 Hz fysica, 20 Hz tick) en roept `session.step()` aan; geen eigen DOM.
- **Command-pattern voor input:** `Input` (toetsen, muis, later touch, gamepad) levert `PlayerCommand`s (`move`, `jump`, `use`, `attack`, `hotbar(n)`). Eén pad voor toetsenbord, touch, gamepad, bots en replay; ook de basis voor server-side voorspelling en lag compensation.
- **Event-bus:** klein, getypeerd (`events.on('block-broken', ...)`), alleen voor dwarsverbanden (advancements, audio, toasts). Geen globale string-bus.
- **ECS: niet nu.** ~8 mobtypes met één `InstancedMesh` per lichaamsdeel en data-gedreven `MobType` werken; ECS loont bij honderden tot duizenden entiteiten met wisselende componenten. Wel een lichte componentenaanpak voor statuseffecten en AI-goals (de ROADMAP vraagt om één schade-pijplijn).
- **Grens afdwingen:** twee `tsconfig`'s (`tsconfig.shared.json` met `lib: ES2022`, geen `DOM`, `types: []`), plus een importregel (Biome/eslint `no-restricted-imports`) dat `shared/` niets uit `client/` of `server/` importeert.

### 5.3 Incrementeel refactorplan (waarde ÷ risico)

Elke stap: eigen PR van ≤ ~400 regels, **gedrag onveranderd**, `npm run typecheck && npm test && npm run build` groen, F3-overlay en benchmark vergelijkbaar.

| # | Stap | Waarde | Risico | Inspanning |
|---|---|---|---|---|
| 1 | Veiligheidsnet: Playwright-smoke (laden, wacht `state !== 'loading'`, blok breken/plaatsen, 5 s wandelen, geen console-errors, frame-tijd < drempel) + mesh/gen-benchmarks met drempel in CI | Hoog (alles hierna) | Laag | S-M |
| 2 | `DebugInfo` (F3-tekst, regels ~1 449+) naar eigen klasse; verplaats alleen code | Middel | Zeer laag | S |
| 3 | `SimulationLoop` (accumulator, fixed step, `gameTick`, `updatePlaying`) uit `Game` | Hoog | Laag-middel | M |
| 4 | `CombatSystem` (explode, hurtByServer, aanvallen, death/respawn) | Middel | Laag | S-M |
| 5 | `NetSession` en `ArcadeSession` achter één `Session`-interface; `WorldSession` voor singleplayer (save/autosave/world-instantie). Hier verdwijnen de null-checks | Hoog | Middel | M-L |
| 6 | `GameStateMachine` (menu/loading/playing/paused/inventory/dead/chat) met expliciete toegestane overgangen en testen | Middel | Laag | S-M |
| 7 | `Input` → `PlayerCommand` (voorwaarde voor touch/gamepad) | Hoog | Middel | M |
| 8 | `src/shared/` verplaatsen + tweede tsconfig | Middel | Laag (`git mv` + imports) | M |
| 9 | Protocol: `hello {v, minV, caps}` en berichtencodec-laag | Middel | Middel | M |

Eerst 1 en 2 (laagste risico, snel winst), dan 3-6 in volgorde. Stappen 7 en 8 raken veel bestanden: plan ze in een stille week.

### 5.4 Protocol- en saveversies

| Onderwerp | Voorstel |
|---|---|
| Handshake | `hello {v, minV, caps: ['bin-snap','deflate-edits']}`; server kiest hoogste gemeenschappelijke versie en antwoordt met `welcome {v, caps}`. Strikte gelijkheid vervalt |
| Binair | Messagetype-byte + payload voor `snap`, `pos`, `blocks`, `welcome.edits`; JSON blijft voor zeldzame berichten (chat, join). `Transport`-interface (§4.1) |
| Validatie | Runtime-validatie van elk `ClientMessage` aan de serverkant (type/lengte/grenzen). **Onzeker** hoe volledig dat nu is; fuzz-test toevoegen |
| Save | `version` + `genVersion` (§3.4); bij migratie eerst een back-up-record maken; export als zip |
| Compat-testmatrix | Vitest: oude edit-records (v1, v2) lezen; protocol v4-client tegen v5-server (kick met duidelijke melding) |

### 5.5 Build en deploy

| Punt | Nu | Voorstel |
|---|---|---|
| Statische server comprimeert niet | `createReadStream(file).pipe(res)` zonder `content-encoding` | `vite-plugin-compression` of een postbuild-stap voor `.br`/`.gz`; server kiest op `Accept-Encoding`. Een Vite-build met three.js is ordegrootte 1 MB+ (limiet `chunkSizeWarningLimit` staat op 1 200 kB): verwacht ~250-350 kB brotli. Achter Caddy: `encode zstd gzip` aanzetten (staat niet in het genoemde voorbeeld, **onzeker** voor de gebundelde `docker-compose.yml`) |
| Cache | `assets/*` immutable (goed), rest `no-cache` | OK |
| Beveiligingsheaders | Geen CSP, geen COOP | CSP (script-src 'self', worker-src 'self' blob:) is makkelijk; COOP alleen als SAB komt |
| Lint | Open in ROADMAP | Biome (S) |
| Bundelbudget | Geen | `size-limit` in CI |
| Node-versie | CI 22, lokaal 25, Dockerfile **onzeker** | Eén versie vastzetten (`.nvmrc`/`engines`) |
| PWA | Open | Service worker + manifest (S); let op protocolversie-mismatch (§4.3) |

### 5.6 Refactoren naast gelijktijdig featurewerk

| Maatregel | Waarom |
|---|---|
| Trunk-achtig: korte takken vanaf `feature/bunkcraft-engine`, merge dagelijks; refactor-PR's ≤ 400 regels | Kleine diff = weinig conflicten |
| **"Move-only"-commits** (pure verplaatsing met `git mv`/functie-extractie, geen logica) apart van wijzigingen | Reviewbaar, bisect-vriendelijk |
| **Strangler-patroon:** nieuwe klasse wordt aangemaakt in `Game`, oude methode delegeert (zelfde signatuur) en verdwijnt pas later | Parallelle takken die `Game.ts` aanpassen blijven compileren |
| Afspraak met parallelle agents/takken: **nieuwe functionaliteit in nieuwe bestanden**, in `Game.ts` hoogstens een aanroep | Voorkomt dat `Game.ts` verder groeit |
| Refactor-vensters: voor een grote verplaatsing (stap 5, 7, 8) eerst alle open takken mergen, dan 1 dag bevriezen | Anders onvermijdelijke conflicten |
| Feature flags: `?flags=newloop,session` of `localStorage['bunkcraft.flags']`, geïntegreerd in `Settings`; oud pad blijft één release | Snel terugvallen zonder revert |
| Safety net: golden hashes (terrein), mesher-tests, `bench-mesh` (±25 %), Playwright-smoke, protocol-roundtrip-tests | Zie stap 1 |

---

## 6. Mobiel en low-end

### 6.1 Apparaatklassen

| Klasse | Voorbeelden | GPU-karakter | Wat werkt (schatting, **onzeker**; niet op deze apparaten gemeten) |
|---|---|---|---|
| Apple A15-A18 / M-serie | iPhone 13+, iPad, MacBook | Snel, TBDR, veel bandbreedte | rd 8-12 op 60 FPS; geheugen (~384 MB canvas) is de grens |
| Adreno 6xx/7xx | Snapdragon-telefoons | TBDR, middenklasse | rd 6-8, shadows low/uit |
| Mali-G5x/G6x/G7x | Budget- en middenklasse Android | TBDR, bandbreedte-beperkt, thermisch | rd 4-6, geen shadows |
| Intel UHD 620 / 24-32 EU | Oudere laptops | iGPU, deelt RAM | rd 6-8 op 720p; dynamische resolutie nodig (aanwezig) |
| Chromebook (Celeron N4xxx, Kompanio) | School | Zwakke CPU én GPU, 4 GB RAM, 2-4 cores | rd 4-6, workers: 1-2, geen shadows |
| Software GPU (SwiftShader) | Headless/CI | CPU | Alleen tests: gemeten mediaan 33 ms |

Het project heeft al: hardware-detectie bij eerste start (`suggestPreset`: Intel HD/UHD, Mali, Adreno, software → Low), dynamische resolutie (< 48 FPS → 0,5 px), context-loss-afhandeling, schaduwklem.

### 6.2 Mobiele tier-voorstel

| Instelling | Low (nu) | **Mobile (nieuw)** | Reden |
|---|---|---|---|
| Render distance | 4 | 6 | 6 blijft ver genoeg met mist; geheugen ~20 MB geometrie |
| Pixel ratio | 0,75 schaal | `min(devicePixelRatio, 2)`, dynamisch tot 1 | DPR 3 op telefoons is verspilling |
| Schaduwen | off | off | Extra pass is duur op TBDR |
| Workers | `min(4, hc−2)` | **max. 2** | Thermiek: meshing concurreert met GPU om de warmtebudget |
| Deeltjes / wolken | minimal | minimal / eenvoudig | Fill-rate |
| Alpha-test (`discard`) | Cutout apart (aanwezig) | Bladeren "fast" (ondoorzichtig) | Op tilers breekt `discard` de early-Z/HSR-optimalisatie |
| Frame cap | schermfrequentie | optie 30/45 FPS ("batterijbesparing") | Thermiek na 5-10 min |
| Pack-import | Elke resolutie | Downscale naar 64-128 px | §1.4 |

### 6.3 Thermiek, geheugen en context loss

- Thermische throttling is de dominante faalmodus op telefoons: eerste minuten vlot, daarna 30-50 % lagere kloksnelheid (algemene ervaring, **niet gemeten voor BunkCraft**). Meet dus **sustained** frame-tijd (10 min) naast korte benchmarks.
- iOS: canvasgeheugen ~384 MB totaal, context loss en tab-crashes zijn gedocumenteerd in WebKit-bugs en Apple-forum ([voorbeeld*](https://developer.apple.com/forums/thread/778735)); `webglcontextlost` is afgehandeld in de game. Voorkom grote texturen en grote schaduwmaps (`maxTextureSize` klem is aanwezig).
- Verlies van één canvas door resizen veroorzaakt lekken op iOS (forum*): hergebruik één canvas, verander alleen `setSize`/`setPixelRatio`, maak nooit een tweede `WebGLRenderer`.

### 6.4 Touch en PWA

| Onderwerp | Implicatie |
|---|---|
| Input | Geen pointer lock op touch. Linkerduim: virtuele joystick; rechterduim: slepen = kijken; knoppen springen/bouwen/breken; lang indrukken = breken. Vereist `PlayerCommand`-laag (§5.3 stap 7), `touch-action: none`, `Pointer Events` |
| Fullscreen | iPhone-Safari heeft geen Fullscreen API voor willekeurige elementen: **PWA met `display: fullscreen`/`standalone`** is de route |
| Opslag | Geïnstalleerde PWA is vrijgesteld van de 7-dagen-ITP-wipe (§3.2): een extra reden voor "Zet op beginscherm" |
| Service worker | Offline singleplayer en snelle start; cache-versie koppelen aan de build; **protocol-mismatch** met multiplayer-server (kick) moet netjes een "update beschikbaar"-melding geven (§4.3) |
| Audio | Procedurele audio vereist een gebruikersgebaar om te starten (`AudioContext.resume`); bij touch op de eerste tap |
| Schermvergrendeling | Wake Lock API (Safari 16.4+) tijdens spelen; orientation-lock niet op iOS |
| Portals (CrazyGames, Poki) | Vereisen touch en een IP-vriendelijke look (ROADMAP §8) |
| Haptiek | `navigator.vibrate` bestaat niet op iOS |

---

## 7. Experimenten (reproduceerbaar)

Alle bestanden in `scripts/experiments/`. Geen spelcode gewijzigd.

| Script | Wat | Resultaat |
|---|---|---|
| `bench-wasm-noise.ts` + `wasm/noise.as.ts` + `wasm/noise.wasm` | 3D-noise fill 16×128×16: JS simplex, JS Perlin, WASM scalar, WASM SIMD (AssemblyScript) | 1,22 / 1,88 / 0,82 / **0,255 ms**; SIMD 7,4× JS-Perlin, 4,8× JS-simplex van het spel |
| `bench-mesh-phases.ts` | Fases van `ChunkMesher.mesh` | Licht 35 %, greedy 51 %, rest 14 % van 3,8 ms |
| `bench-pipeline.ts` | Gen/mesh, payloadkloon, opslaglay-outs, snapshotgrootte | Gen 0,80 ms, mesh 4,24 ms, 6 823 verts, 127 KiB/chunk; kloon 0,057 ms; palet 7,9 KiB, RLE 2,4, deflate 0,9 KiB; snap JSON 409 B/binair 137 B |
| `bench-ws-fanout.ts` | `ws`-fan-out 16/64/256 sockets, met/zonder deflate | 256 sockets: 6,1 % tegenover 16,1 % event loop |

Bouwen van de WASM: `npm i assemblyscript` in een tijdelijke map en `asc scripts/experiments/wasm/noise.as.ts -o ...noise.wasm --enable simd --runtime stub -O3 --noAssert --initialMemory 4` (zie kop van het script).
Beperkingen: Node 25 op Apple Silicon (niet Chrome/Safari/Firefox, niet x86), één seed, geen browser-GPU-metingen, WASM alleen met AssemblyScript (Rust/Zig/emcc ontbraken).

---

## 8. Top 15 technische investeringen (gerangschikt)

Waarde = effect op spelers/ontwikkelsnelheid; Risico = kans op regressies; Inspanning S ≤ 2 dagen, M ≤ 1-2 weken, L > 2 weken.

| # | Investering | Waarde | Inspanning | Risico | Waarom (kort) |
|---|---|---|---|---|---|
| 1 | **Compressie en headers** van de statische server (brotli/gzip, CSP) | Hoog | S | Zeer laag | Eerste-load 3-4× kleiner (§5.5) |
| 2 | **Benchmark- en regressie-harnas** (Playwright-smoke, frame-tijd p50/p99, mesh/gen-drempel in CI) | Hoog | S-M | Laag | Voorwaarde voor elke volgende optimalisatie en voor refactors |
| 3 | **`genVersion` + lazy-freeze + back-up/zip-export** van werelden | Hoog | S-M | Laag | Voorkomt dat grotten/ravijnen/structuren bestaande werelden slopen (§3.4) |
| 4 | **`Game.ts` splitsen** (DebugInfo, SimulationLoop, Combat, Session-interface) | Hoog | M-L | Middel | Minder conflicten, minder null-check-bugs (§5.3) |
| 5 | **Licht-cache + secties (16³ mesh-vensters)** | Hoog | M | Middel | Licht = 35 % van meshtijd; kleinere remeshes bij edits |
| 6 | **Per-richting face culling + cave culling** | Hoog | M | Middel | 30-50 % minder vertices, 50-80 % minder geometrie ondergronds |
| 7 | **Instanced-quad-indeling (16 B/quad)** | Hoog | M-L | Middel | GPU-geheugen en upload ÷4,7; essentieel voor mobiel (§1.6) |
| 8 | **Gesampelde 3D-noise (4×8×4) voor grotten** + workerpool-cap 6 op ≥ 10 cores | Middel-hoog | S-M | Laag | 77× minder samples; schuift de WASM-behoefte op (§2.4) |
| 9 | **Binair protocol v5** (gequantiseerde snapshots, `hello`-capabilities, gecomprimeerde `welcome.edits`) + `Transport`-interface | Middel | M | Middel | 3× minder bytes, geen lock-step deploys (§4.3, §5.4) |
| 10 | **Heightmap-LOD-ring** (verre terrein tot ~48 chunks) | Hoog (visueel) | L | Middel | Schijnbare afstand ×3 zonder opslag dankzij deterministische seed (§1.9) |
| 11 | **Mobile-tier + touch (`PlayerCommand`) + PWA/service worker** | Hoog (bereik) | L | Middel | Portals en telefoons; PWA lost ook ITP op (§6) |
| 12 | **Bit-rij-greedy mesher in JS** (16-bit rijen) | Middel | M | Middel | Greedy = 51 % van meshtijd; golden-tests als vangnet (§2.5) |
| 13 | **Multi-draw-pool** (`WEBGL_multi_draw` met fallback) of `BatchedMesh`-prototype | Middel | M-L | Middel-hoog | Alleen als meting op zwakke CPU draw calls als knelpunt toont (§1.5) |
| 14 | **Server-metrics + sharding op roomcode** | Middel | M | Laag | Pas nodig vanaf ~50 actieve rooms; metrics nu (§4.4-4.5) |
| 15 | **WebGPU-spike (2 weken, timeboxed)** met compute-culling + één `drawIndirect` | Onbekend | M | Laag (aparte branch) | Beslist met data of de regel herzien kan worden (§1.3) |

**Bewust niet doen (nu):**

| Idee | Reden |
|---|---|
| SharedArrayBuffer + COOP/COEP | Gemeten winst ≈ 0 (1,4 % van meshtijd); breekt embeds/portals |
| OffscreenCanvas-render in worker | Render-CPU 0,4-0,8 ms; enorme herschrijving |
| WASM voor terrein (nu) | Max. 17 % van workertijd; eerst sampling; bit-exacte pariteit met server nodig |
| WebTransport / WebRTC | Geen Node-serverkant; winst alleen bij pakketverlies; eerst binair protocol |
| KTX2/Basis voor standaardatlas | Atlas is 0,1 MB |
| SSAO/contact shadows/CSM | Vertex-AO + gecachete schaduw zijn beter op iGPU |
| ECS | Te weinig entiteiten; klassen + data-gedreven types volstaan |
| Verhuizen naar Durable Objects | Port L, lock-in; overweeg later voor arcade |
| Occlusion queries | Visibility graph is beter; stalls op tilers |

---

## 9. Onzekerheden en vervolgmetingen

| Onzeker | Hoe te beantwoorden |
|---|---|
| Of multi-draw-indirect/`indirect-first-instance` in oktober 2026 in stabiele Chrome zit | `chrome://gpu` + [gpuweb status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) controleren |
| `WebGPURenderer` r186-prestaties | Benchmark-scene (§1.3) |
| Echte browser-meshtijden (Safari JSC, mobiel) | `bench-mesh` in een worker in de browser, op 3 apparaten |
| Rust-WASM-snelheid van mesher/licht | Alleen na stap 8, met AS/Rust-prototype van de licht-BFS |
| Pakketverlies-effect op snapshots | `tc netem` (1-3 % verlies, 50 ms) met arena-bots (`scripts/arena-bots.ts`) |
| Serverplafond (p99 tick-lateness) | 50-100 bots in rooms, `monitorEventLoopDelay` |
| iOS geheugenplafond | Echte iPhone + Web Inspector (Safari Technology Preview), rd 8/12 |
| Portals en COOP/COEP | Specifieke portal-documentatie lezen vóór elke SAB-keuze |
| Of `PlayerCommand`-refactor `Interaction.ts` raakt | Code-audit bij stap 7 |

### Bronnen

[WebGPU (Wikipedia)](https://en.wikipedia.org/wiki/WebGPU), [web.dev: WebGPU in alle grote browsers](https://web.dev/blog/webgpu-supported-major-browsers), [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [gpuweb#2315 multi draw indirect](https://github.com/gpuweb/gpuweb/pull/2315), [Chrome 131 WebGPU](https://developer.chrome.com/blog/new-in-webgpu-131), [three.js forum: WebGPURenderer-prestaties](https://discourse.threejs.org/t/why-webgpurenderer-performance-significantly-lower-than-webglrenderer/77629), [three.js #31055](https://github.com/mrdoob/three.js/issues/31055), [three.js #30560](https://github.com/mrdoob/three.js/issues/30560), [caniuse WEBGL_multi_draw](https://caniuse.com/wf-webgl-multi-draw), [caniuse WebTransport](https://caniuse.com/webtransport), [caniuse COEP credentialless](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless), [web.dev cross-origin isolation](https://web.dev/articles/cross-origin-isolation-guide), [WebKit tracking prevention](https://webkit.org/tracking-prevention/), [Apple forum: PWA-opslag](https://developer.apple.com/forums/thread/710157), [Binary greedy meshing](https://github.com/cgerikj/binary-greedy-meshing), [Tommo's cave culling](https://tomcc.github.io/2014/08/31/visibility-2.html), [Aokana](https://arxiv.org/html/2505.02017v1), [Vertex pooling](https://nickmcd.me/2021/04/04/high-performance-voxel-engine/), [Distant Horizons](https://gitlab.com/distant-horizons-team/distant-horizons), [KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html), [web.dev: optimize long tasks](https://web.dev/articles/optimize-long-tasks), [Cloudflare DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing), [Hetzner prijsaanpassing](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [Fly.io pricing](https://fly.io/pricing/).
Secundair (*): [webgpu.com](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/), [utsubo.com](https://www.utsubo.com/blog/threejs-2026-what-changed), [websocket.org](https://websocket.org/comparisons/webtransport/), [PowerSync](https://powersync.com/blog/sqlite-persistence-on-the-web), [WebKit bug 261331](https://bugs.webkit.org/show_bug.cgi?id=261331), [Apple forum 778735](https://developer.apple.com/forums/thread/778735).
Niet opnieuw geraadpleegd in deze sessie (kennis/eerder onderzoek): Eaglercraft/minecraft-web-client-architectuur, Vintage Story/Luanti-engine-notities, 0fps-meshingartikelen. Daar steunen geen cijfers in dit document op.
