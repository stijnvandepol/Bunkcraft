# Block states: ontwerp

Een blok is `id` (Uint8). Een block state voegt een `meta`-byte toe: de variant van dat ene blok (helft van een
slab, richting van een trap, open deur, waterniveau). Namen en regels volgen Minecraft Java 1.21. Arcade-rooms
gebruiken geen block states.

## Datalayout

- `Chunk.meta: Uint8Array | null`, zelfde index als `blocks` (`x | z<<4 | y<<8`, 32 KB). **Lazy:** `null` tot er een blok
  met meta ongelijk aan 0 in staat. De generatoren leveren geen meta (natuurlijk water is een bron = meta 0), dus een
  gewone chunk kost 0 extra bytes. Altijd alloceren kostte 10 MB bij render distance 8 en +0,1 ms per mesh (`scripts/bench-meta.ts`).
- Meta per soort (de rest is 0), constanten in `src/world/BlockStates.ts`:
  - slab: `0` onder, `1` boven, `2` dubbel;
  - trap: bit 0-1 richting (N, Z, W, O = kant van de rugleuning = waar de speler naartoe keek), bit 2 omgekeerd. De hoekvorm
    (recht, binnen-/buitenhoek) wordt **afgeleid** uit de buren (`stairShape`, Minecraft's `getStairsShape`) in plaats van opgeslagen:
    een buur plaatsen of weghalen hoeft dan niets te herschrijven en niets over het net te sturen;
  - deur: bit 0-1 richting, bit 2 bovenste helft, bit 3 scharnier rechts, bit 4 open (beide helften zijn hetzelfde blok-id);
  - vloeistof: Minecraft's `level`: `0` bron, `1-7` stromend (hoeveelheid = 8 − level), bit 3 vallend. Bron = 0 en niet 8, zodat
    de generatie niets hoeft te schrijven.
- Edits: `EditMap` houdt per chunk `blockIndex → id | meta << 8`. Save-record v2: `index << 16 | meta << 8 | id`; `SAVE_VERSION` 2
  met migratie, v1-records lezen als meta 0. `world.json` bewaart dezelfde packed waarde, oude bestanden blijven geldig.

## Gevolgen

- **Vormen:** slabs en trappen zijn unies van 8×8×8-stukjes (octants, 8 bits). Dat geeft geometrie, botsboxen (`octantBoxes`, ≤ 4)
  en de gezichtsculling met één mechanisme: een vlak verdwijnt als het aangrenzende octant bezet is. Deuren zijn één dunne box.
- **Mesher (worker):** krijgt per chunk `meta | null`; `metaRegion` wordt alleen gevuld als er meta is. Kubussen lezen meta niet. Alle
  texturen lopen door over het blok (een onderste slab toont de onderste helft), AO en licht worden per hoekpunt geïnterpoleerd.
  Vloeistoffen krijgen hun eigen pass: bovenvlak op het echte niveau (hoekhoogtes gemiddeld zoals `LiquidBlockRenderer`).
- **Licht:** slabs en trappen ontvangen licht maar geven het niet door (`LIGHT_STOP`), zodat een dak donker blijft en aangrenzende vlakken niet zwart worden.
- **Botsing en raycast:** `collisionBoxes` per toestand, `clipAxis(…, getMeta)`; de speler loopt 0,6 omhoog zonder te springen. De raycast raakt de echte vorm.
- **Netwerk:** protocol 4. `block`/`reject` krijgen `meta`, `welcome.edits` is `x, y, z, id, meta, …`, `blocks` is een batch (vloeistof).
- **Vloeistoffen (`src/world/Liquids.ts`, puur):** ticks alleen naast een bewerking (`notify`), water elke 5 en lava elke 30 ticks. Budget per tick:
  600 updates en 200 blokwijzigingen (de rest schuift een tick op), hoogstens 50 000 geplande ticks. Singleplayer tikt in `World`; in
  multiplayer tikt `ServerWorld` en spiegelen de clients. Wat bewust ontbreekt staat in `ROADMAP.md`.
