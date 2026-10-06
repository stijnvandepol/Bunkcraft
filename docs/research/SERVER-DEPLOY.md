# Server op Linux: metingen, keuzes en aanbeveling

Vraag van Stijn: BunkCraft makkelijk op een eigen Linux-server zetten, met technologie die de gameplay goed houdt en
zo min mogelijk serverresources kost. Dit document meet eerst, vergelijkt dan opties en eindigt met wat nu is gedaan en
wat nog een beslissing van Stijn is. Installatie zelf: docs/SERVER.md, "Op je eigen Linux-server in 5 minuten".

## 1. Hoe gemeten

- **Bots:** `scripts/load/` (`npm run load -- --steps survival:10x8,tdm:4x12`). Protocol-bots zonder browser, in aparte
  processen. Survival-bots lopen over het echte terrein, hakken en plaatsen blokken, rapen items op, chatten en vechten tegen
  mobs; de eigenaar zet de tijd op middernacht, dus vijandige mobs spawnen (~38 mobs zichtbaar per speler). Eén op de acht
  verkent en laat de server nieuwe chunks genereren. Arcade-bots lopen tussen vrije cellen (langs de anti-cheat, die door
  muren lopen kickt), kiezen een wapen en schieten op zichtbare vijanden.
- **Meetwaarden:** CPU van het proces en van alleen de main thread, RSS, heap, GC-pauzes, tick-tijd p50/p99, event-loop-lag
  (hoe laat timers afgaan; het eerste signaal van overbelasting), bytes per speler, latenties aan botkant (ping, chat, edit).
  Alles via `/metrics`; de nieuwe metrics (lag, GC, main-thread-CPU, tick-venster) zijn nu standaard (zie SERVER.md).
- **Idle en opstarten:** `scripts/load/idle.ts`. **Deterministische CPU** zonder netwerk: `scripts/load/bench-room.ts`
  (4 games × 8 spelers, nep-klok, CPU-tijd per tick).
- **Machine:** M1 Pro (8 cores), Node 25. Tijdens de metingen draaiden andere agents (load average 10-35), dus losse runs
  wisselen ±30 %, vooral bij lag en p99. CPU-percentages zijn "procent van één core". Een gedeelde vCPU bij een VPS is
  grofweg 1,5-2× trager dan een M1-core: reken capaciteiten daarmee om (gedaan in §4).

## 2. Metingen

### 2.1 Vóór/na de buildstap (tsx tijdens runtime → gebundelde JS)

| | tsx (oud, `node --import tsx server/index.ts`) | bundle (nieuw, `node dist-server/index.js`) |
|---|---|---|
| Opstarttijd tot `/health` | 276-374 ms | **132-173 ms** |
| Geheugen leeg proces (incl. kindprocessen) | 103 MB (node + esbuild-hulpproces van tsx) | **69 MB** |
| 20 lege games geladen | 124 MB | **95 MB** |
| 80 spelers (10 survival-games) RSS | 287-293 MB | **263 MB** |
| CPU bij 80 spelers | 28-29 % | 28-30 % (gelijk binnen ruis) |
| Docker-image runtime-laag | `node_modules` (tsx, esbuild-binary, ws, fflate) + `src/` + `server/` | alleen `dist/` + één JS-bestand van 938 KB |

De bundle verandert niets aan de gamelogica (zelfde bron, esbuild zonder minify): alle 1483 tests en de 33
integratietests slagen ook tegen de bundle (`BUNK_SERVER_ENTRY=bundle npx vitest run tests/integration`).

### 2.2 Belasting (bundle)

| Scenario | Spelers | CPU % (main thread) | RSS MB | Tick p50/p99 ms | Lag p99 ms | GC | Uit per speler |
|---|---|---|---|---|---|---|---|
| survival 1 × 8 | 8 | 4,5 (3,9) | 107 | 1,4 / 3,5 | 3 | 0,8/s, langste 0,9 ms | 13,4 KiB/s |
| survival 4 × 8 | 32 | 12,3 (10,7) | 171 | 1,1 / 2,2 | 4 | 1,1/s, langste 4,7 ms | 14,1 KiB/s |
| survival 10 × 8 | 80 | 28-30 (25-27) | 263-293 | 1,0 / 6 | 5-8 | 1,5-1,9/s, langste 2-8 ms | 14,8 KiB/s |
| survival 20 × 8 | 160 | 37-42 (33-37) | 365-375 | 0,7 / 4-6 | **5-52** | 2,2/s, langste 2-8 ms | 14,4 KiB/s |
| arcade TDM 1 × 16 | 16 | 8,5 (7,8) | 89 | 1,7 / 6,7 | 8 | langste 1,9 ms | 8,9 KiB/s |
| arcade TDM 4 × 12 | 48 | 12,5 (11,3) | 97 | 0,6 / 4,0 | 10 | langste 3,1 ms | 4,4 KiB/s |
| arcade TDM 8 × 12 | 96 | 18,3 (17,5) | 117 | 0,3 / 3,1 | 7 | langste 2,5 ms | 4,4 KiB/s |

- Eén survival-game met 8 spelers en ~40 mobs kost ~3-4 % van een core en ~15-20 MB extra geheugen. Arcade is veel
  goedkoper (geen mobs, geen chunks): ~1,5 % per game van 12.
- De snapshot-cadans blijft netjes: snap-gap p99 53-58 ms (ideaal 50) tot 80 spelers.
- **Bij 160 spelers springt de event-loop-lag** in sommige runs naar p99 ~50 ms (max 57-180 ms; in een rustige run 5 ms).
  Oorzaak volgens het CPU-profiel: chunks genereren (verkenners) gebeurt synchroon op de main thread. Zie §2.4.
- **Bandbreedte:** survival ~14,5 KiB/s per speler uit (~120 kbit/s), vooral `ent`-frames (alle mobs binnen bereik, 10× per
  seconde, volledig). 160 spelers = ~2,3 MB/s = ~19 Mbit/s. Arcade 4-9 KiB/s per speler.
- **GC** is geen probleem: 1-3 pauzes per seconde, samen 1-4 ms per seconde, langste meestal < 8 ms.

### 2.3 Idle

| | |
|---|---|
| Leeg proces | 69 MB RSS, 0,3-0,5 % CPU |
| 20 geladen lege games (10 survival, 10 arcade) | +1,2 MB per game, 1,2 % CPU totaal |
| Na het uitladen | RSS blijft ~93 MB (V8 geeft geheugen niet terug aan het OS), heap 13 MB |

Lege games tikken al bijna gratis (de tick stopt direct als er niemand is, mobs en chunks worden meteen vrijgegeven).
Uitladen na 5 minuten bespaart dus weinig; het is nu instelbaar (`ROOM_IDLE_UNLOAD_MIN`) maar de standaard blijft.

### 2.4 Waar de CPU heen gaat (profiel, 160 survival-spelers)

| Onderdeel | Aandeel van de bezette tijd |
|---|---|
| Mobs: AI, pad zoeken, spawnen (`EntityManager`, `Mob`, `Navigator`) | ~28 % |
| Chunks laden: `ServerWorld.update`, waarvan **terreingeneratie 19 %** | ~27 % |
| Random ticks (groei, bladverval) | ~12 % |
| Licht voor spawnregels (`getLight`) | ~8 % |
| WebSocket verzenden (`ws` + socket writes) | ~7 % |
| GC | ~1,6 % |

Twee goedkope verbeteringen zijn meteen doorgevoerd (§5): `ServerWorld.update` deed elke tick de hele ring-scan
ook als niemand van chunk wisselde, en `getLight` liep alle lichtbronnen van 9 chunks af (een chunk kan honderden
lavablokken diep onder de grond hebben). **Resultaat (bench-room, CPU per game-tick): 1,51 → 1,30 ms (−14 %), in de
stabiele fase 1,24 → 1,00 ms (−19 %).** Uitkomsten zijn identiek (test `serverWorldPerf.test.ts` vergelijkt met de oude
berekening).

### 2.5 Node-flags

`--max-semi-space-size=32` (minder young-gen-GC's) en `--max-old-space-size=192` gaven bij 160 spelers geen meetbare winst
boven de ruis van deze machine; 192 MB gaf eerder langere pauzes. De heap gebruikt bij 160 spelers ~70 MB. Daarom:
`--max-old-space-size=384 --max-semi-space-size=16` als **vangrail** (een lek of overbelasting wordt eerst trage GC en een
nette fout in de log in plaats van de OOM-killer), niet als snelheidswinst. Containerlimiet 640 MB.

### 2.6 Chunkgeneratie op worker threads (voorstel A, gedaan)

Opzet (`server/chunkgen/`): één pool van `worker_threads` voor alle games (`CHUNK_WORKERS`, standaard min(2, cores − 1),
cores ook begrensd door een Docker-CPU-limiet; `0` = het oude pad op de main thread). De worker draait dezelfde generator
als de client (`createGenerator`) en rekent meteen de lichtdata uit die de server bijhoudt (hoogste lichtblokkerende blok
per kolom, lijst van lichtbronnen); de buffers gaan als transferable terug. De main thread legt alleen nog de opgeslagen
edits erop (0,06 ms per chunk). Verzoeken krijgen als prioriteit de ring-afstand tot de dichtstbijzijnde speler, worden
per wereld en chunk ontdubbeld (een dichterbij gekomen speler schuift een verzoek naar voren), en de wachtrij is begrensd
(4096; nieuwe dichtbije chunks duwen de verste eruit). Een chunk die nog niet binnen is leest als UNLOADED, zoals eerst ook
al voor chunks die nog aan de beurt moesten komen. Synchroon blijft: arena's (36 chunks bij het laden van een kaart, nodig
voor hitscan en anticheat) en `ensureChunk` bij een blokwijziging binnen reikwijdte in een chunk die nog niet binnen is, zodat
de inventory-controle het echte blok ziet. Uitkomst byte voor byte gelijk aan het synchrone pad: getest tegen de golden
hashes van generatorversie 1, 2 en 3, 54 losse chunks over drie seeds, alle arena-kaarten, en een complete `ServerWorld`
met edits en licht (`tests/chunkGenPool.test.ts`).

**Metingen** (zelfde bundle, `CHUNK_WORKERS=0` tegen `2`, elk drie keer, machine load 2-5). Het meetvenster begint direct
nadat alle bots gejoind zijn (`--warmup 0 --measure 30`), dus terwijl de 9×9 chunks rond iedereen nog binnenkomen:

| Join-fase | Spelers | Tick p50 / p99 / max ms | Lag p99 / max ms | Main thread CPU % | Proces CPU % | RSS MB | Chunks in venster |
|---|---|---|---|---|---|---|---|
| main thread (0) | 80 | 0,6-1,0 / **5,9-6,0** / 8-27 | 5,1-6,4 / 9-37 | 17-26 | 20-29 | 204-209 | 5,7-5,9/s, 12-13 ms/s main |
| workers (2) | 80 | 0,8-0,9 / **3,6-4,1** / 7-9 | 4,3-5,7 / 8-13 | 21-24 | 27-29 | 251-261 | 5,8-7,4/s op workers |
| main thread (0) | 160 | 0,5-0,6 / **5,0-5,7** / 12-31 | 5,3-7,5 / **10-52** | 31-35 | 36-40 | 298-345 | 14-28/s, 29-58 ms/s main |
| workers (2) | 160 | 0,5-0,6 / **1,5-2,4** / 3-7 | 2,2-2,8 / **7-8** | 29-30 | 36-37 | 367-381 | 9-10/s op workers |

Met een draaiende wereld (20 s warm-up, 45 s meten, twee rondes plus de oude bundle als referentie) genereren de bots nog maar
~0,8 chunk/s (2-3 ms/s CPU): daar is geen verschil boven de ruis (tick p99 1,5-8 ms, lag-max 15-75 ms in alle drie de
varianten). De resterende pieken in die fase komen dus niet van terrein; volgende kandidaat volgens het profiel: mobs (§2.4).

- **Winst:** zolang er terrein gegenereerd wordt (spelers die joinen, verkennen, teleporteren) is tick p99 2-3× lager en
  verdwijnen de lagpieken van 30-50 ms bij 160 spelers. De main thread wint ~2-4 procentpunt in de join-fase; het
  genereren zelf (~2,3 ms per chunk) gebeurt op de andere cores.
- **Kosten:** ~20-25 MB RSS per worker (eigen V8-isolate met de generatorcode), dus ~+45 MB met twee. Op een machine met één
  core staat de pool standaard uit.
- `/metrics` heeft nu `bunkcraft_chunkgen_*` (workers, wachtrij, gegenereerd/gedropt/mislukt, worker-tijd) en
  `bunkcraft_chunk_main_thread_seconds_total{phase="generate"|"install"}`; `npm run load` toont per stap waar de chunks
  gegenereerd werden.

## 3. Opties

| Optie | Oordeel | Waarom |
|---|---|---|
| **Server bundelen met esbuild** | **gedaan** | −34 MB, 2× sneller opstarten, geen `node_modules`/TypeScript in de image, kleiner aanvalsoppervlak. Dev blijft `tsx watch`. |
| **Node 24 LTS** (was 22) | **gedaan** (Docker) | Huidige LTS, nieuwere V8; `process.threadCpuUsage` voor de main-thread-metric. Bundle draait op 22+. |
| `ws` met permessage-deflate | **uit laten** (is al uit) | Snapshots zijn al binair en klein; deflate kost per verbinding een zlib-context (honderden KB met context takeover) en CPU op de hete paden. Caddy kan WebSocket-frames niet comprimeren. |
| uWebSockets.js i.p.v. `ws` | **niet nu** (voorstel C) | Verzenden is ~7 % van de CPU; uWS wint daar hooguit de helft van. Niet op npm, native binary per platform (Alpine/ARM), andere API. |
| Chunkgeneratie in `worker_threads` | **gedaan** (§2.6) | Tick p99 2-3× lager en geen lagpieken meer zolang er terrein gegenereerd wordt; ~+20-25 MB per worker. `CHUNK_WORKERS=0` zet het uit. |
| Delta/interest-managed `ent`-frames | **voorstel B** | ~90 % van het survival-verkeer. Alleen gewijzigde mobs sturen, verre mobs minder vaak: geschat −50-70 % bandbreedte en minder allocaties (GC). Protocolwijziging (binaire versie omhoog, client + server). |
| Eén proces per game / meerdere processen | **voorstel D, later** | Eén proces haalt ~150-200 spelers per core (§4). Pas daarboven nodig. Kost ~70 MB per proces plus routering op gamecode en een gedeelde serverlijst. |
| Lege games/chunks eerder uitladen | **instelbaar gemaakt** | Gemeten winst klein (§2.3); `ROOM_IDLE_UNLOAD_MIN` voor kleine machines. |
| Tickrate | **laten** | 20 Hz survival (Minecraft), 30 Hz arcade (`ARCADE_TICK_HZ`). Een tick kost < 1,5 ms per game; lager maakt de gameplay slechter voor weinig winst. |
| Statische bestanden | **al goed** | Vite schrijft `.br`/`.gz`, de server serveert die met `immutable` cache voor gehashte bestanden; Caddy doet zstd/gzip voor de rest. |
| Caddy vs nginx | **Caddy** | Automatisch HTTPS en vernieuwing, HTTP/3 standaard (443/udp), zstd. nginx is iets lichter maar vraagt certbot en meer config. Caddy ~30-40 MB RAM. |
| Docker vs systemd | **Docker standaard, systemd gedocumenteerd** | Docker: één commando, geïsoleerd, read-only, makkelijke updates; kost ~50-80 MB voor dockerd/containerd en ~0 CPU. systemd: `deploy/bunkcraft.service` met dezelfde hardening voor wie geen Docker wil. |
| Kant-en-klare images (GHCR, multi-arch) | **voorstel E** | Nu bouwt de server zelf de image (TypeScript + Vite: > 1 GB RAM, daarom maakt `install.sh` swap op kleine machines). Een CI-workflow die amd64+arm64-images publiceert maakt installeren en updaten seconden werk en een 1 GB-VPS probleemloos. |
| Prometheus/Grafana standaard | **nee** | Te zwaar voor een kleine VPS. `/health` heeft nu tick/lag/geheugen; `/metrics` met token voor wie wil scrapen (voorbeeld in SERVER.md). |

## 4. Welke VPS en hoeveel spelers

Grens per Node-proces: de main thread. Houd die onder ~50-60 % voor marge (GC, pieken, verkennende spelers). Gemeten: 160
survival-spelers ≈ 35 % main thread op een M1-core; op een VPS-vCPU (1,5-2× trager) ≈ 55-70 %. Geheugen ~375 MB bij 160.

| VPS | Indicatie prijs | Survival-spelers | Alleen arcade | Opmerking |
|---|---|---|---|---|
| 1 vCPU / 1 GB | €2-5/mnd | ~40-60 | ~100 | Caddy, Docker en GC delen de ene core; image bouwen alleen met swap (het script regelt dat). |
| **2 vCPU / 4 GB (Hetzner CAX11 ARM of CX22)** | ~€4-5/mnd | **~120-150** | ~200+ | **Aanbevolen.** Tweede core voor Caddy/TLS, GC-threads en het OS; bouwen zonder swap. ARM werkt (alles is pure JS, image is multi-arch). |
| 4 vCPU / 8 GB | €8-15/mnd | ~150-200 | ~300 | Terreingeneratie gebruikt nu de extra cores (§2.6); voor de gamelogica zelf pas meer met voorstel D (meerdere processen). |

Verkeer: 150 survival-spelers continu = ~19 Mbit/s, ~6 TB/maand bij 24/7 vol; Hetzner geeft 20 TB inbegrepen.
Realistischer (paar uur per avond) is < 1 TB.

## 5. Wat nu gedaan is

- `npm run build` bundelt ook de server (`scripts/build-server.mjs` → `dist-server/index.js`); `npm start` en Docker draaien
  plain JS. Runtime-image zonder `node_modules`; `tsx` en `esbuild` zijn dev-afhankelijkheden.
- `ServerWorld`: chunk-update overslaan als niemand van chunk wisselt; lichtbronnen per chunk op hoogte gesorteerd (−14-19 %).
- Metrics: event-loop-lag, tick-venster, GC-pauzes, main-thread-CPU; `/health` met `roomsLoaded`, `tickP99Ms`,
  `loopLagP99Ms`, `rssMB`.
- Compose: geheugen/CPU-limieten via `.env` (Docker weigert meer CPU's dan de machine heeft: de oude vaste `cpus: 2` faalde op
  een 1-vCPU-VPS), heap-vangrail, logrotatie (3 × 10 MB), Caddy start pas als de game gezond is.
- `scripts/install.sh` (idempotent, `--dry-run`), `scripts/update.sh` (back-up → pull → bouwen terwijl de oude draait →
  herstart met opslaan → health-check, rollback-commando bij falen), `scripts/backup.sh` (dagelijks via systemd-timer of cron,
  14 bewaard), `bunkcraft`-commando, `deploy/bunkcraft.service` + `HOST`-instelling voor de systemd-variant.
- Laadtest en idle-meting als scripts, zodat elke volgende wijziging opnieuw gemeten kan worden.
- Voorstel A: chunkgeneratie op worker threads (§2.6), `CHUNK_WORKERS`; de bundle heeft `dist-server/genWorker.js` erbij.

### Getest

- **Image** (`node:24-alpine`, arm64): 243 MB, waarvan het grootste deel de Node-basisimage. Container met de compose-hardening
  (read-only, `cap_drop: ALL`, 640 MB, 1 CPU): `/health` gezond, `scripts/load/smoke.ts` maakt een game aan, joint via
  WebSocket, krijgt welcome, klok en chat-echo. `docker stop` slaat netjes op in < 1 s.
- **`install.sh` echt gedraaid** in een kale `ubuntu:24.04`-container (privileged, Docker-in-Docker): dry-run, installatie
  van Docker uit de officiële repo, build, Caddy met HTTPS (`https://localhost/health` 200, HTTP/2), tweede run idempotent
  (tokens blijven), `bunkcraft status`/`backup`/`restart` (een `.env`-wijziging komt in de container aan).
  Niet getest in die container: systemd-timer en ufw (geen systemd in een container; daar valt het script terug op cron en een
  hint), en `update.sh` tegen een echte remote.
- shellcheck: schoon.

## 6. Open beslissingen voor Stijn

- **A. Chunkgeneratie naar een worker thread:** gedaan (§2.6). Het "19 %" uit het profiel bleek vooral de join-fase te zijn; in
  een draaiende wereld met deze bots is terrein < 1 % van de CPU. Daar is de winst dus vooral soepelheid bij joinen en verkennen.
- **B. Delta-`ent`-frames?** Halveert tot derdeelt het survival-verkeer per speler. Protocolwijziging.
- **C. uWebSockets.js?** Advies: nee, tenzij verzenden later > 20 % van de CPU wordt.
- **D. Meerdere processen per server?** Pas nodig boven ~150-200 gelijktijdige spelers per machine.
- **E. Images publiceren op GHCR via CI?** Maakt installeren en updaten op een kleine VPS veel sneller en betrouwbaarder.
- **Repo publiek of privé?** De one-liner in SERVER.md haalt `install.sh` van GitHub; bij een privé-repo moet de server een
  deploy-key of token hebben (of je kopieert de map zelf en draait `./scripts/install.sh`).
