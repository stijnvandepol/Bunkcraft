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
| Elke blokwijziging remesht 9 chunks, met een volledige lichtberekening (~2,6 MB kopiëren) | M/L: alleen buren remeshen als hun randlicht verandert; lichtcache per chunk |
| Allocaties per frame (`rayHit`-arrays, closures, template-strings, iterators) | S |
| Lege mob-meshes nog steeds in de render-loop; `getLight` per mob per frame | S |
| Gedeelde GLSL voor licht en mist (5 kopieën lopen nu uiteen; entities missen de onderwater-mist) | S |
| Worker-crash: jobs blijven "in flight" en het streamen stopt | S/M: worker vervangen, job opnieuw inplannen |
| `Game.ts` (~1000 regels) opsplitsen: GameStateMachine, WorldSession, SimulationLoop, Combat, DebugInfo | M |
| Save-formaatversie en migraties, nodig vóór block states | S |
| Instellingen valideren (min/max/enum) uit `localStorage` | S |
| Standaardpreset kiezen op basis van de hardware | **Gedaan:** GPU-naam, cores en `deviceMemory` bij de eerste start (software-GPU, Intel HD/UHD, Mali, Adreno → Low) |
| Dynamische resolutie voor zwakke GPU's en Retina | **Gedaan:** interne resolutie zakt bij < 48 FPS tot 0,5 px per CSS-pixel, en stijgt weer bij headroom. Software-GPU op Medium: 11–16 → 26–28 FPS |
| Menu-blur (`backdrop-filter`) kostte zwakke GPU's het grootste deel van de frame | **Gedaan:** uit bij Fast of verlaagde resolutie (pauzemenu op een software-GPU: 14 → 45 FPS); `-webkit-`-prefix voor Safari < 18 |
| Shadow map begrenzen op `maxTextureSize` | S |
| Bij minimale resolutie en nog steeds traag: render distance tijdelijk verlagen | S |

## 3. Testen en tooling

- **Vitest** voor de DOM-vrije modules:
  - terrein-determinisme (golden hashes);
  - mesher (1 kubus = 6 quads, een vloer = 1 quad);
  - collision en raycast;
  - PlayerStats-regels;
  - inventory en recepten;
  - SaveSystem met `fake-indexeddb`.
- **CI** met GitHub Actions: typecheck, lint (Biome), tests en build op elke PR.
- **Bundel:** three.js in een aparte vendor-chunk, zodat die over deploys heen gecachet wordt.

## 4. Gameplay en motivatie (op volgorde van plezier per moeite)

1. **Elke drop een nut geven (S):**
   - goud-ingot en gouden tools: **Gedaan** (goudeerts smelten; snelheid 12, duurzaamheid 32, oogstniveau hout);
   - TNT (5 buskruit + 4 zand), Flint and Steel (ijzer + vuursteen): **Gedaan** (lont 80 ticks, kracht 4, kettingreactie met korte lont, onder water geen blokschade). In multiplayer blijft TNT inert tot de server explosies synchroniseert;
   - vuursteen: **Gedaan** (grind, 10%);
   - bed (wol + planken: spawnpunt en nacht overslaan): wacht op block states (een bed is 2 blokken met een richting);
   - pijl en boog: wacht op spin (draad) en skeleton.
2. **~15 advancements (S–M):** "Getting Wood", "Stone Age", "Acquire Hardware", "Diamonds!", met toast-meldingen. Ze dienen ook als tutorial.
3. **Kisten met loot (M):** nodig voor alle structuren.
4. **Block states (L):** een `meta`-array per chunk. Dit ontgrendelt stromend water en lava, obsidiaan, slabs, trappen, deuren, ladders, muurfakkels, gewassen en een oven met een richting.
5. **Landbouw (M):** saplings, tarwe, brood en een schoffel. Hernieuwbaar hout en voedsel.
6. **Meer survival-inhoud (M):** harnas met een armor-bar, skeleton (bogen) en spin, XP-orbs met een XP-balk.
7. **Structuren (M per stuk):** dungeon met spawner en kisten, mijnschachten, later dorpen.
8. **Eindspel (L):** een "Underworld"-dimensie of een stronghold met een eindbaas en credits.

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

- **Werkende keybind-remapping (S):** het scherm bestaat al, maar de knoppen doen nog niets.
- **Contexthints en ontdekken van recepten (S):** voor nieuwe spelers.
- **Toegankelijkheid (S–M):** ondertitels voor geluiden, reduced motion (hurt cam, bobbing en FOV-kick uit) en kleurenblind-veilige balken.
- **`navigator.storage.persist()`:** **Gedaan.** Safari wist anders werelden na 7 dagen zonder bezoek.
- **Gamepad (M)** via de Gamepad API.
- **Touchbediening (L):** joystick, slepen om te kijken en knoppen. Vereist voor mobiele portals.

## 7. Multiplayer (vervolg op v1)

v1 is gebouwd: één Node-server serveert de game en de WebSocket, met een gedeelde wereld,
spelers, chat, tijd en per speler opgeslagen data. Zie `docs/SERVER.md`. Volgende stappen:

1. **Mobs op de server simuleren.** `EntityManager` en `Mob` zijn DOM-vrij. De server heeft daarvoor terreingeneratie per chunk nodig (TerrainGenerator draait al server-side) en een lichtschatting.
2. **Gedeelde item-drops** en eventueel PvP.
3. **Server-authoritative inventory** (anti-cheat): breken en craften door de server laten bevestigen.
4. **Wachtwoord, whitelist en ops**, en accounts of tokens per naam.
5. **Binair protocol** voor snapshots, als er veel spelers zijn.

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
   - block states;
   - stromend water en lava;
   - kisten en dungeons;
   - landbouw, harnas, skeleton en spin;
   - weer.
3. **Later:**
   - eindspel;
   - nieuwe biomes en dorpen;
   - touch en gamepad;
   - portals.
