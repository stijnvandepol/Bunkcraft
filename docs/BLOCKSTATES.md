# Block states: ontwerp

Een blok is nu `id` (Uint8). Een block state voegt een `meta`-byte toe: de variant van dat ene blok
(helft van een slab, richting van een trap, open deur, waterniveau). Namen en regels volgen Minecraft Java 1.21.

## Datalayout

- `Chunk.meta: Uint8Array | null`, zelfde index als `blocks` (`x | z<<4 | y<<8`, 32 KB). **Lazy:** `null` tot er een
  blok met meta ongelijk aan 0 in staat. De generatoren (terrein, arena) leveren geen meta: natuurlijk water is een
  bron en dat is meta 0. Een gewone chunk kost dus 0 extra bytes; de worker-berichten dragen `null` voor chunks zonder meta.
- Meta per soort (de rest van de bits is 0):
  - slab: `0` onder, `1` boven, `2` dubbel;
  - trap: bit 0-1 richting (0 N, 1 Z, 2 W, 3 O = de kant waar de rugleuning staat), bit 2 omgekeerd (boven). De vorm
    (recht, binnen-/buitenhoek) wordt **afgeleid** uit de buren door `stairShape()`, zoals Minecraft bij elke buurupdate doet;
    zo hoeven buren niet te worden herschreven en reist er geen extra meta over het net;
  - deur: bit 0-1 richting, bit 2 bovenste helft, bit 3 scharnier rechts, bit 4 open;
  - vloeistof: bit 0-2 niveau (0 = bron, 1-7 = stromend, hoger is lager), bit 3 vallend (Minecraft's `level` 0-15).
- Edits: `EditMap` houdt per chunk `blockIndex → id | meta << 8`. Save-record v2: `index << 16 | meta << 8 | id`
  (31 bits, past in een Uint32). `SAVE_VERSION` 2 met migratie; v1-records worden bij het laden met meta 0 gelezen.
  `world.json` op de server bewaart dezelfde packed waarde (`id | meta << 8`); oude bestanden blijven geldig (meta 0).

## Gevolgen per onderdeel

- **Registry:** nieuwe vorm `partial` (slab, trap, deur) met `SOLID = 1` maar zonder `OPAQUE`. `LIGHT_FILTER = 15` voor
  slabs en trappen, zodat een dak van trappen het licht tegenhoudt zonder de naburige vlakken te verbergen.
- **Mesher (worker):** ontvangt per buur `meta | null`; een 48×48×130 `metaRegion` wordt alleen gevuld als er meta is.
  Gewone kubussen lezen meta niet (de lus voor kubusvlakken blijft ongewijzigd, alleen een extra test als de buur `partial` is).
  Gedeeltelijke blokken krijgen een eigen pass met boxen per toestand; vlakken die op de blokrand liggen en tegen een
  opaak blok aan zitten worden weggelaten, kubusvlakken worden weggelaten tegen een gedeeltelijk blok dat dat vlak geheel bedekt.
- **Licht:** ongewijzigd (BFS gebruikt `OPAQUE` en `LIGHT_FILTER`).
- **Botsing en raycast:** `collisionBoxes(id, meta, …)` geeft 1-2 boxen (slab de helft, trap 2 boxen, deur een dunne plaat);
  `clipAxis` krijgt een optionele `getMeta`. De speler krijgt, zoals in Minecraft, een stap-omhoog van 0,6 zodat trappen en
  slabs lopend te nemen zijn. De raycast test partial blokken tegen hun boxen (zodat je door een open deur heen wijst).
- **Netwerk:** `PROTOCOL_VERSION` 4. `block`, `reject` krijgen `meta`; `welcome.edits` wordt `x, y, z, id, meta, …`.
  De server valideert id en meta (toegestane bits per soort) en bewaart de packed waarde.
- **Server:** `ServerWorld` houdt `meta` lazy per chunk (alleen voor edits en botsing van mobs). Vloeistoffen worden daar
  gesimuleerd met een tick-queue en een budget per tick; de client in multiplayer simuleert niet maar spiegelt.
- **Prestaties:** meshtijd en geheugen worden voor en na gemeten (zie het eindrapport in de commits); geen allocaties per frame,
  de vloeistof-queue is een vaste ringbuffer met een plafond.
