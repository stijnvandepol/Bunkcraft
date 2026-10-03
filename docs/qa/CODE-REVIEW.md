# Code review: de laatste ~40 commits op `feature/bunkcraft-engine`

Datum: 2026-10-03. Basis: `b185ac0`. Bekeken: de hand-opgeloste merges (`45942bf`, `e478504`, `6db5bfd`, `27efadd`, `e12786c`) en de bijbehorende features: server-admin en security, audio en weer, content (items, armor, kleurfamilies), mobs, en de netwerklaag (`binary.ts`, `protocol.ts`, `NetEntities`, `ServerEntities`).

Elke bevestigde bug heeft een regressietest die eerst faalde. Na de fixes slagen `npx tsc --noEmit`, `npm test` (596 tests) en `npm run build`.

## Bevestigde bugs (opgelost)

| # | Ernst | Plaats | Bug | Commit |
|---|---|---|---|---|
| 1 | Hoog | `server/InventoryGuard.ts:166-186` | Craften verbruikte de ingrediënten niet | `a4d539a` |
| 2 | Hoog | `server/InventoryGuard.ts:123-160`, `server/GameServer.ts:837`, `src/items/ItemRegistry.ts:574` | Drops van gebroken blokken werden geweigerd en verdwenen | `f970707` |
| 3 | Middel | `server/InventoryGuard.ts:59` | Oude wol-id's gaven een eindeloze correctie-lus | `19a7211` |
| 4 | Middel | `server/App.ts:380` | Per-IP-slot lekte bij een mislukte handshake | `e347810` |
| 5 | Middel | `server/Commands.ts:218` | `/time set constructor` maakte de wereldtijd NaN | `41809ff` |
| 6 | Laag | `server/Rooms.ts:324` | Verlopen games bleven in Browse Games staan | `ff28381` |

### 1. Craften verbruikte de ingrediënten niet (dupe-exploit)

`check()` keek alleen of een *winst* uit het recept te maken was. Of de ingrediënten daarna ook echt uit de inventory verdwenen waren, controleerde het niet. Met 1 log stuurde een client `log 1 + planks 4` en dat werd geaccepteerd. Elke volgende state gaf weer 4 planks extra: oneindige items in elk "guarded" survival-spel.

- **Bewijs:** `new InventoryGuard([{OAK_LOG,1}]).check([[OAK_LOG,1],[OAK_PLANKS,4]]).ok === true`.
- **Fix:** gecraftte items gaan in de werkpool. Na het craften mag geen enkel id meer in de nieuwe state zitten dan de pool toelaat. Ingrediënten worden eerst genomen van alternatieven die de speler echt kwijt is (bijvoorbeeld berkenplanks gebruikt, eikenplanks gehouden), zodat eerlijke clients geen valse weigering krijgen.
- **Tests:** `tests/inventoryGuard.test.ts`, "crafting consumes its ingredients" en "uses the alternative the player actually spent".

### 2. Drops van gebroken blokken werden geweigerd en verdwenen

`creditBreak(blockId)` kreeg de state-byte niet mee en rolde de random drop zelf opnieuw. Gevolgen in survival multiplayer met de guard aan:

- Rode wol werd gecrediteerd als witte wol. Elke gekleurde of variant-drop (wol, concrete, terracotta, saplings, `SLAB_X`, hekken) werd geweigerd en ging verloren.
- Ertsen met een random aantal (lapis 4–9, redstone 4–5, koper 2–5, glowstone, meloen) werden geweigerd als de client hoger rolde dan de server.
- Bladeren (sapling, 1–2 sticks, appel) en dead bush/gras (seeds) werden meestal geweigerd.
- Een geweigerde drop verbruikte bovendien het krediet dat wél matchte.

De fix:

- **`possibleBlockDrops(blockId, meta)`** (nieuw): geeft elke stack die `blockDrop` kan opleveren, op het hoogste aantal.
- **`GameServer.onBlock`:** geeft de meta door aan de guard.
- **`authorizeDrop`:** verbruikt kredieten alleen als de drop geaccepteerd wordt.
- **Tests:** drie gerichte tests, plus een volledigheidstest die voor elk blok, elke variant-state en zes tools controleert dat `blockDrop` binnen `possibleBlockDrops` blijft.

### 3. Oude gekleurde wol-id's gaven een eindeloze correctie-lus

Spelersrecords van vóór de kleurfamilies bevatten de id's 39–42 (rood/blauw/geel/groen wol). De client zet die bij het laden om naar wol-varianten (`stackFromArray` → `normalizeItem`), de guard deed dat niet.

- **Gevolg:** de guard zag variant-wol "uit het niets" verschijnen en stuurde elke 2 s een correctie terug naar de oude id's. De inventory van die speler werd dus nooit meer opgeslagen.
- **Fix:** `parseInventory` normaliseert de id's net als de client.
- **Test:** `tests/inventoryGuardContent.test.ts`, "old coloured wool ids".

### 4. Per-IP-WebSocketslot lekte bij een mislukte handshake

`perIp` werd verhoogd vóór `wss.handleUpgrade`. Bij een ongeldige handshake (bijvoorbeeld een slechte `Sec-WebSocket-Key`) antwoordt `ws` met 400 zonder de callback aan te roepen, dus `close` en de decrement kwamen nooit.

- **Gevolg:** na `MAX_CONN_PER_IP` (10) kapotte handshakes was dat adres tot een herstart buitengesloten (429). Achter NAT trof dat iedereen op dat adres; een aanvaller kan het met één regel script doen.
- **Fix:** het slot wordt pas in de callback geteld (`handleUpgrade` is synchroon, dus de limietcheck blijft kloppen).
- **Test:** `tests/serverAdmin.test.ts`, "a handshake that ws refuses".

### 5. `/time set constructor` maakte de wereldtijd NaN (prototype-lookup)

`key in TIME_PRESETS` is ook waar voor `constructor`, `toString` en `__proto__`. De wereldtijd werd dan een functie, daarna `NaN` voor iedereen (de dag/nacht-cyclus en de `time`-broadcasts gingen stuk).

- **Wie kon dit:** in rooms zonder moderatie mag iedere speler `/time` gebruiken.
- **Fix:** `Object.hasOwn`.
- **Test:** `tests/commands.test.ts` (nieuw, met een stub-host).

### 6. Verlopen games bleven in de publieke lijst

`Rooms.expire()` verwijderde de map van een verlopen, gelistte game, maar niet de entry in `listedMeta`. Browse Games bleef zo een code tonen die niet meer bestaat.

- **Test:** `tests/security/rooms.test.ts`, "Rooms expiry".

## Open bevindingen (niet opgelost: geen kleine lokale fix of niet bevestigd)

| Ernst | Plaats | Bevinding |
|---|---|---|
| Middel | `server/ServerEntities.ts:136` | Meleeschade komt van `p.held` uit het `pos`-bericht van de client. Een survival-client kan een diamanten zwaard claimen zonder het te hebben. De guard ziet `held` niet; je zou `held` tegen de laatst geaccepteerde hotbar moeten checken. |
| Middel | `server/GameServer.ts:610` | Als het opgeslagen spelersrecord niet door `parseInventory` komt (bijvoorbeeld een item dat later uit het spel verdwijnt of een duurzaamheid die omlaag gaat), start de guard leeg. De client laadt het record wel, dus bij de eerste state wordt de hele inventory "gecorrigeerd" naar leeg. Beter: ongeldige rijen per slot weggooien in plaats van alles. |
| Laag | `server/GameServer.ts:558` | De wachtwoordlimiet is niet atomair: `allowed()` gebeurt vóór de async scrypt en `record()` erna. Parallelle verbindingen vanaf één IP (tot `MAX_CONN_PER_IP`) kunnen de limiet per ronde met ~9 pogingen overschrijden. Begrensd, maar zo is de limiet zachter dan bedoeld. |
| Laag | `src/entities/MobSpawner.ts` | De commit `b185ac0` meldt "40 hostiles binnen 64 blokken in singleplayer". Ik vond geen pad dat de cap omzeilt: er is één spawnpunt, `recount()` per tick en de cap is globaal. Waarschijnlijk was dat een meting op oude code (HMR). Opnieuw meten met F3 na een harde reload. |
| Laag | `server/App.ts:189` | Een body `null` of een array op `POST /api/rooms` geeft 500 in plaats van 400 (TypeError in de catch). Geen securityprobleem. |
| Laag | `server/GameServer.ts:715` | `drop.data` accepteert niet-gehele waarden. Wie zo'n item oppakt, krijgt een state die `parseInventory` weigert ("bad item data"). Dat herstelt zichzelf via de correctie, maar dan ben je de data kwijt. Beter: afronden of weigeren bij de drop. |
| Laag | `server/Commands.ts:84` | `/give red_wool` vindt het legacy blok-id 39 en niet de wol-variant. Variant-namen ("Red Wool") zijn niet op naam te vinden. |
| Laag | `src/net/NetEntities.ts:206` | Na `taken` kan een `ent`-snapshot die al onderweg was het item één frame terugzetten (ghost). Cosmetisch. |
| Cosmetisch | `src/core/Audio.ts:404` | Dubbele JSDoc ("One thunderclap ...") boven `playThunderRumble`: een merge-restant. |

## Gecontroleerd en in orde

- **Merges:** in `Game.ts`, `GameServer.ts`, `ServerEntities.ts`, `SaveSystem.ts` en `BlockRegistry.ts` is geen logica dubbel of verloren gegaan. Elke `ServerMessage` heeft precies één handler: `weather` en `bolt` lopen via `WeatherSystem.onServerMessage` in de `default`-tak.
- **Protocol:** `PROTOCOL_VERSION` (4) is gedeeld. De binaire codec dekt alleen `snap` en `ent`, met dezelfde velden als JSON. Het hoogste variant-item-id (58434) past in de u16 van `ItemEntry`.
- **Block-id's en item-id's:** geen dubbele id's of namen. Alle blokken zijn < 256, items liggen onder `VARIANT_ITEM_BASE`, alle receptresultaten en ingrediënten zijn geldige items. Bestaande block-id's zijn sinds de content-update niet veranderd.
- **Async login:** een close tijdens de scrypt-check geeft geen zwevende sessie. De `welcome` → `onMessage`-overgang op de client verliest geen berichten (de continuation loopt als microtask vóór het volgende message-event).
- **Prototype pollution:** `players`, `claims` en de command-lookup gebruiken own-property-lookups. Alleen `/time` niet (fix 5).
- **Allocaties per frame:** de audio-update, `WeatherSystem.update`, `NetEntities.update`, de precipitatie en de bliksem alloceren niet per frame.
- **Tests:** geen verzwakte tests gevonden. De mobspawner-tests zijn bij de tuning omgezet naar de `SPAWN`-constanten in plaats van vaste getallen; dat is terecht.
