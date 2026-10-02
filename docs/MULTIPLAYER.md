# BunkCraft multiplayer: onderzoek en plan

> **Status (oktober 2026):** gebouwd als **dedicated Node-server**: fase 2 hieronder, maar zonder
> externe dienst. Eén proces serveert de game en de WebSocket (`server/`), zodat alles op één webserver
> draait. Zie [`SERVER.md`](SERVER.md). De WebRTC-variant (fase 1) is niet meer nodig.

Samenvatting van het multiplayer-onderzoek (oktober 2026). Bronnen staan onderaan.

## Wat de huidige code al meebrengt

- `TerrainGenerator`, `Noise`, `BlockRegistry` en de player-physics (`Collision`, `Physics`, `Player`) hebben geen DOM- of Three.js-afhankelijkheden. Ze draaien ongewijzigd in een server, een worker of de browser van een host.
- Het terrein is **deterministisch vanuit de seed**. Over het netwerk gaan dus alleen de **wijzigingen** (block edits), nooit hele chunks.
- `World.edits` slaat wijzigingen al compact op (blokindex → `id | meta << 8`, de packed block state). Dat kan direct het wire-formaat zijn.

## Opties

| Optie | Kosten | Hosting | Valsspelen | Geschikt voor |
|---|---|---|---|---|
| **WebRTC P2P, host = server** (Trystero / PeerJS) | €0 (eventueel een TURN-relay) | Geen; werkt met GitHub Pages | Host wordt vertrouwd | 2–8 spelers, "Open to LAN" |
| **Node.js + WebSocket-server** | Render free (slaapt na 15 min) of vanaf ~$5/mnd | Laag tot gemiddeld | Volledig server-authoritative | Vaste servers |
| **Cloudflare Durable Objects** | Free plan: 100k requests/dag | Laag (`wrangler deploy`) | Volledig authoritative | Eén object per wereld |
| Colyseus / Nakama / Rivet | Self-host gratis, cloud betaald | Gemiddeld tot hoog | Volledig | Overkill voor een blokkengame |
| Supabase Realtime / Firebase | Gratis tiers | Geen | **Geen autoriteit** (alleen relay) | Niet aan te raden |
| Hathora | — | — | — | **Opgeheven per mei 2026** |

UDP (Geckos.io) is niet nodig: een blokkengame op 20 Hz werkt prima met betrouwbare, geordende kanalen.

## Hoe anderen het doen

- **Minecraft Java:** server-authoritative op 20 TPS. Bewegingen gaan als relatieve delta's, rotaties in 1/256-slagen. Bij block edits hoort een sequence-nummer, zodat "ghost blocks" teruggedraaid kunnen worden.
- **Eaglercraft:** "Shared Worlds" werken via WebRTC P2P met de host als server; een kleine relay doet alleen de signaling. **Dit is precies fase 1 hieronder.**
- **Voxelize:** Rust-server met een TypeScript/Three.js-client via WebSocket. Architectonisch het dichtst bij BunkCraft.

## Wat er gesynchroniseerd wordt

| Bericht | Inhoud | Frequentie / grootte |
|---|---|---|
| Join | protocolversie, seed, tijd, spawn, speler-id + edits van chunks in zicht | eenmalig |
| Block edit | seq, x, y, z, id, prevId | ~13 bytes, zeldzaam |
| Snapshot (server → client) | per speler: id, positie, yaw/pitch (u8), flags | 20 Hz, ~17 bytes per speler |
| Input (client → server) | tick + input-bits + kijkrichting | 20 Hz |
| Chat | JSON | zeldzaam |

Bij 8 spelers is dat ongeveer 19 KB/s upload voor de host: prima voor een gewone internetverbinding.

## Netcode

1. **Client-side prediction:** de eigen speler beweegt direct lokaal. De server rekent met dezelfde `Player`-code en corrigeert bij afwijkingen.
2. **Interpolatie:** andere spelers worden ~100 ms in het verleden getoond, vloeiend tussen twee snapshots.
3. **Block edits:** worden lokaal meteen toegepast en naar de server gestuurd. Bij een weigering zet de client `prevId` terug.
4. **Conflicten:** de server verwerkt edits op volgorde van aankomst. Met `prevId` worden verouderde edits geweigerd.
5. **Block states (protocol 4):** een `block`-bericht heeft een optionele `meta` (weggelaten = 0); de server weigert een meta die het blok niet kan hebben (`isValidMeta`). `welcome.edits` is een platte lijst `x, y, z, id, meta`. Een oudere client krijgt "Outdated client".
6. **Vloeistoffen:** de server simuleert water en lava (`LiquidSim` in `ServerWorld`, alleen terwijl er spelers zijn) met een budget van 600 updates en 200 blokwijzigingen per tick. De wijzigingen gaan als `blocks`-berichten (`x, y, z, id, meta, …`, hoogstens 100 per bericht) naar alle clients, dus maximaal ~4000 wijzigingen per seconde in een extreme vloed; een client simuleert zelf niet.

## Aanbevolen plan

**Kern:** één transport-onafhankelijke `GameServer` in pure TypeScript. In fase 1 draait die in de browser van de host, in fase 2 dezelfde code in Node of een Durable Object.

### Fase 1: "Open to LAN" via WebRTC (~2–3 weken parttime)

- Signaling via Trystero (publieke Nostr/MQTT-relays, €0); geschikt voor GitHub Pages.
- Pauzemenu → **Open to LAN** → roomcode van 6 tekens en een link (`#join=ABC123`).
- De host bewaart de wereld; vertrekt de host, dan stopt de sessie.
- Voor ~15–25 % van de verbindingen is een TURN-relay nodig.

### Fase 2: dedicated server (~2–3 weken extra)

- Bij voorkeur Cloudflare Durable Objects (één per wereld, gratis tier). Alternatief: Node + `ws` op Render.
- De server moet `wss://` gebruiken, omdat GitHub Pages HTTPS is.

### Modules

```
src/net/       protocol.ts, Transport.ts, transports/{Rtc,Ws,Loopback}Transport.ts,
               NetClient.ts, RemotePlayers.ts, Chat.ts
server/        GameServer.ts, ServerWorld.ts, RateLimiter.ts, adapters/{node,durableObject}.ts
src/ui/        MultiplayerMenu.ts (serverlijst, Direct Connect, deelnemen via link)
```

### Beveiliging

- **Block edits valideren:** bereik ≤ 5 blokken, geladen chunk, geldig blok, `prevId` klopt, niet in een andere speler, en optioneel line-of-sight.
- **Rate limits (token bucket):** ~20 edits/s, ~30 input-berichten/s, 1 chatbericht/s en een maximale berichtgrootte.
- **Beweging:** snelheidscap per tick, en terugzetten bij een botsingsfout.
- **Sessie:** versiecheck, namen en chat opschonen (alleen tonen via `textContent`), een onraadbare roomcode en een optioneel wachtwoord.

## Bronnen

- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Render free tier](https://render.com/docs/free)
- [Colyseus pricing](https://colyseus.io/pricing/)
- [Trystero](https://github.com/dmotz/trystero)
- [Geckos.io](https://github.com/geckosio/geckos.io)
- [TURN-gebruik (bloggeek)](https://bloggeek.me/webrtcglossary/turn/)
- [Minecraft Java protocol](https://minecraft.wiki/w/Java_Edition_protocol/Packets)
- [Eaglercraft shared worlds](https://playeagler.blog/blog/eaglercraft-shared-world-fix/)
- [prismarine-web-client](https://github.com/PrismarineJS/prismarine-web-client)
- [ClassiCube hosting](https://www.classicube.net/server/host/)
- [Voxelize](https://github.com/voxelize/voxelize)
- [Hathora shutdown](https://gameye.com/blog/game-server-shake-up-2026/)
