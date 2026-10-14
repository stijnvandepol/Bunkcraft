# Schalen: container per match, autoscaling of eerst iets kleiners?

Vraag van Stijn: auto-scaling van containers, of elke match in een eigen container? Dit is een onderzoek, geen code.
Basis: `docs/research/SERVER-DEPLOY.md` (metingen), `docs/SERVER.md`, en de code (`server/App.ts`, `Rooms.ts`, `Parties.ts`).

## Update 14 oktober 2026: gebouwd achter een schakelaar

Stijn koos voor optie D: "een control container draait, en per lobby wordt een container gestart met de resources om die match
soepel te draaien". Gebouwd als `MATCH_ISOLATION=container`; **standaard blijft `inprocess`** tot het op de live server bewezen is.
Gebruik en instellingen: `docs/SERVER.md` ("Een container per lobby"); dreigingsmodel: `docs/SECURITY.md`.

Wat er is (`server/match/`):

| Onderdeel | Bestand | Wat |
|---|---|---|
| Control plane | `ControlPlane.ts`, `RemoteRoom.ts` | De bestaande server; arena-lobby's worden `RemoteRoom`s die uit heartbeats antwoorden. Interne API (ready, heartbeat, award, seen, skin-report, save, stopping) met HMAC-sleutel per runner |
| Match runner | `MatchRunner.ts` | Zelfde image, `ROLE=match`: precies één lobby (Match, bots, anticheat, hitreg), geen statische bestanden, geen profielopslag |
| Gateway | `WsProxy.ts` | `/ws/<CODE>` door de control plane naar de runner: frames 1-op-1, backpressure, ping/pong door (lag-compensatie meet de speler), sluitcodes |
| Pool | `MatchPool.ts` | starting → idle (warm) → assigned → stopping; warme pool, cap, start- en heartbeat-timeouts, backoff, adoptie na herstart |
| Orkestratie | `Drivers.ts`, `ContainerSpec.ts` | Docker Engine API via `docker-socket-proxy`, één gevalideerde containerspec; of child processes (`MATCH_DRIVER=process`) |

De open vragen uit §1 zijn zo beantwoord:

1. **Routing:** de control plane is de gateway (geen Caddy-`map`, geen subdomeinen): één domein en één tunnel blijven werken.
2. **Gedeelde state:** profielen, accounts, skins, parties en de roomlijst blijven in de control plane. De runner krijgt per
   verbinding wie de speler is (profiel, rang, skin) mee; XP gaat als grant terug en wordt alleen daar toegekend (eenmalig per
   grant-id, geklemd, alleen voor spelers die de control plane zelf in die lobby liet). Rejoin-plekken leven in de runner en
   overleven daardoor een herstart van de control plane. Party-holds gaan in volgorde naar de runner vóór de verbinding van het
   partylid.
3. **Levenscyclus:** de pool start, telt en stopt; lege lobby's stoppen na `MATCH_IDLE_GRACE_SEC`; een runner zonder heartbeat
   (15 s) is dood en zijn lobby wordt vergeten; zonder control plane stopt een lege runner na 5 minuten zelf.
4. **Observability:** heartbeats (tick p99, CPU, RSS) en Docker stats per lobby in `/metrics` (`bunkcraft_match_*`) en `/admin`.

**Updates:** een nieuwe control plane adopteert lopende matchcontainers; spelers hebben een korte verbindingsonderbreking en
komen via rejoin terug op dezelfde plek, in dezelfde match met dezelfde score. Dat is beter dan nu (een deploy beëindigt elke
match). Lopende matches houden hun oude image; nieuwe starten op het nieuwe.

**Bij volle cap** draait een nieuwe lobby in-process (zoals vandaag) in plaats van "server vol".

**Gemeten** (lokaal, Docker Desktop op een M1 Pro, image uit deze branch; `scripts/qa/container-smoke.sh` en
`tests/matchIsolation.test.ts`):

| Meting | Waarde |
|---|---|
| Containerstart (create → `ready`) | 0,40-0,59 s |
| Lobby aanmaken → `welcome` (warme pool) | 0,27-0,39 s; in-process 0,31 s |
| Proxy-overhead per round trip (zelfde proces, `scripts/qa/proxy-latency.ts`) | p50 +0,035 ms, p99 +0,05 ms (200 B); +0,04 / +0,06 ms (2 KB) |
| Ping van de speler zoals de server die meet (Docker Desktop, host → VM) | mediaan 5 ms via de proxy, 4 ms in-process (ruis van de VM-netwerklaag) |
| Geheugen per match (TDM, 1 speler + 6 bots) | ~50 MB (`docker stats`), limiet 256 MB; lege warme runner ~36 MB |
| CPU per match | 2-7 % van een core, tick p99 2-5 ms |
| Control plane herstarten (update) | 2 s; match liep door, adoptie en rejoin op dezelfde plek |

Conclusie: de extra hop is verwaarloosbaar (ruim onder 1 ms), het geheugen per lobby is ~50 MB i.p.v. ~1,5 MB in-process
(eigen V8-heap per container): dat is de echte prijs van isolatie. Op een CX23 (4 GB) passen zo tientallen lobby's.

**Later:** Survival/Bouwen in containers (chunkgeneratie en grotere state; eerst meten of het nodig is), een eigen proxy die
de create-body controleert of rootless Docker (SECURITY), rate limits per bezoeker over runners heen (wachtwoordpogingen tellen
nu per runner), autoupdate zonder op een rustig moment te wachten (matches overleven het nu), en meerdere hosts (dan wordt de
control plane een echte scheduler).

## Kort antwoord

**Nee, nu niet.** Eén Node-proces op een kleine VPS heeft bij de gemeten belasting nog >10× marge. Per-match containers lossen
een probleem op dat BunkCraft niet heeft (zware, onvoorspelbare matches die elkaar hinderen) en kosten een gateway, gedeelde
state en een nieuw deployproces. Doe nu: meten op de live `/metrics`, de CPU-limiet verruimen, en een tweede proces alleen
als een meting daarom vraagt. Horizontaal schalen pas bij honderden gelijktijdige spelers, en dan met *meerdere vaste
instanties*, niet met een container per match.

## 0. Uitgangspunten uit de metingen

- Survival: 8 spelers + ~40 mobs ≈ 4 % van één core, ~15-20 MB. Arcade: 96 spelers ≈ 18 %, 12 spelers per game ≈ 1,5 %.
- 160 survival-spelers: 37-42 % van een core (M1). Een gedeelde vCPU is ~1,5-2× trager: reken ~60-80 %.
- Tickpieken onder load kwamen van de meetmachine (CPU-tijd van de langste tick 2-9 ms bij 40-500 ms wandklok).
- Terrein draait al op `worker_threads` (`CHUNK_WORKERS`). Idle games kosten ~1,2 MB en bijna geen CPU.
- Let op: `docker-compose.yml` zet standaard `cpus: 1` en `mem_limit: 640m`. Dat is nu de echte plafond-instelling, niet de VPS.
- Eén Node-proces gebruikt voor de gamelogica één core. Meer cores helpen alleen voor chunk-workers, GC en `ws`-I/O.

Praktisch plafond (schatting, één proces, gedeelde vCPU): **~150-250 gelijktijdige spelers**, afhankelijk van het
moduspatroon. Pas daarboven heeft schalen zin. Bandbreedte: 160 survival ≈ 19 Mbit/s uit; Hetzner heeft 20 TB/mnd inbegrepen
(EU), dus geen bottleneck. Via Cloudflare Tunnel is dit geen probleem voor WebSocket-verkeer.

## 1. Per-match isolatie: opties

| Optie | Isolatie | Opstarttijd | Complexiteit | Past bij ons? |
|---|---|---|---|---|
| A. Alles in één proces (nu) | geen (gedeelde event loop) | 0 | laagst | Ja, tot ~150-250 spelers |
| B. `worker_threads` per match (zelfde proces) | event loop per match; crash in worker niet in main | ~30-100 ms + 20-25 MB per isolate | middel: sim-state, sockets en profielen over berichten | Mogelijk, zie §3 |
| C. Child process per match (`fork`) | OS-proces; eigen heap/GC, eigen core | ~150 ms (bundle start 132-173 ms) | middel-hoog: socket doorgeven of gateway | Alleen als B te beperkt blijkt |
| D. Docker-container per match via kleine orchestrator | cgroup-limieten, eigen netwerk | 0,5-2 s (image al lokaal), +69 MB leeg | hoog: Docker-socket-toegang, poorten/routing, log/metrics | Nee: overkill, groot beveiligingsrisico (docker.sock) |
| E. Agones op Kubernetes | volledig, allocatie via API, FleetAutoscaler | seconden (warme buffer van klare servers) | zeer hoog: cluster, mTLS-allocator, GameServer-SDK | Nee voor een kleine operator |
| F. Gehoste fleets (Edgegap, Hathora, Rivet e.d.) | volledig, regio's | seconden | middel: SDK/API, vendor-lock-in | Pas bij echte multi-regio vraag |

### Wat elke per-match-aanpak moet oplossen

1. **Routing.** Spelers komen nu via `wss://domein/ws/<CODE>`; `server/App.ts` pakt het pad op het `upgrade`-event. Een Cloudflare Tunnel
   routeert op hostname en pad via ingress rules naar *vaste* origins ([Cloudflare docs](https://developers.cloudflare.com/tunnel/routing)),
   maar niet dynamisch per match. Dus nodig: een **gateway** (dun Node-proces of Caddy/nginx met `map` op de code) die
   `/ws/<CODE>` doorstuurt naar het proces/de poort van die match. Een extra WebSocket-hop is ~0,2-1 ms op dezelfde host;
   voor latency verwaarloosbaar, voor CPU niet gratis (elke byte wordt twee keer verwerkt, tenzij je de socket handoff doet).
   Subdomein per match (`abc123.craft…`) kan alleen met een wildcard-ingress en is lastiger voor Origin/CORS-checks.
2. **Gedeelde state die nu in-memory of op één schijf zit:**
   - Profielen/accounts/skins (`DATA_DIR/profiles`, `accounts`, `skins`): bestanden, atomair via tmp+rename, accounts worden bij start in RAM geladen.
     Bij meerdere schrijvers is dat niet veilig. Oplossing: één **state-service** (het hoofdproces) die schrijft; matchprocessen sturen alleen een
     "XP-uitbetaling"-bericht. XP komt volgens de regels sowieso alleen van de server.
   - Parties (`server/Parties.ts`, in-memory, polled): moeten in het hoofdproces blijven; matchprocessen vragen alleen "wie hoort bij code X".
   - Rejoin-plekken (`REJOIN_GRACE_SEC`, in de match zelf): kan blijven bij de match zolang de gateway de code kent. Matchproces dood = plek weg (nu ook zo bij restart).
   - Roomlijst (`Rooms.ts`, meta op schijf): hoofdproces als registry; matchprocessen melden spelers/status.
   - Anticheat-/rate-limits per IP: nu over alle games samen. Moet naar de gateway, anders kan iemand per proces opnieuw beginnen.
3. **Levenscyclus:** wie start, telt, stopt en ruimt op, en wat als een match crasht (watchdog + markeren als beëindigd).
4. **Observability:** `/metrics` wordt per proces; je hebt aggregatie nodig (Prometheus met labels) of het hoofdproces moet samenvoegen.

Conclusie §1: de **supervisor + gateway + state-service** is het echte werk (niet de container). Dat is 2-4 weken werk en
een blijvende bron van fouten (bots, parties en rejoin raken allemaal elkaar). Doe dat alleen met een meetbare reden.

## 2. Autoscaling

### Wanneer helpt het?

- Eén VPS is vol bij ~150-250 spelers (§0). Een kleine operator haalt dat zelden; het overgrote deel van de tijd is het
  proces bijna idle (0,3-0,5 % CPU leeg, 69 MB).
- **Verticaal eerst:** een grotere VPS is goedkoper en simpeler dan een tweede machine. Het proces gebruikt maar 1 core voor de
  gamelogica, dus verticaal helpt alleen tot ~2-3 cores (chunk-workers, `ws`, GC) en daarna moet je meerdere processen draaien.
- **Horizontaal** (meer machines) begint pas zinvol als je een tweede proces nodig hebt: ~250+ gelijktijdige spelers, of
  een kritieke eis aan regio's (EU+US latency) of uptime.
- **Scale-to-zero** is voor ons niet nodig: een leeg proces kost 69 MB en bijna geen CPU. Het bespaart alleen op de VPS-prijs, en die is vast.
  Het is wel relevant bij gehoste fleets, waar je per vCPU-minuut betaalt.

### Kosten (indicatie, 14 okt 2026)

- **Hetzner Cloud:** CX23 (2 vCPU, 4 GB) €3,99/mnd, CX33 (4 vCPU, 8 GB) €6,49/mnd; de CPX- en CCX-lijn is op 15 juni 2026 fors
  duurder geworden (CPX22 €7,99 → €19,49; CCX13 €42,99) en bestaande servers houden hun oude prijs
  ([wz-it](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/), [costgoat](https://costgoat.com/pricing/hetzner)).
  Los van een prijslijst: controleer vóór aanschaf zelf op hetzner.com; deze bronnen zijn blogs.
  Bij CX (gedeelde vCPU) kan een buur de piek verstoren; "steal time" meten (§3).
- **Gehoste fleet (Edgegap):** $0,00115 per vCPU-minuut ≈ $0,069/vCPU-uur, 2 GB RAM per vCPU inbegrepen, egress $0,10/GB
  ([Edgegap pricing](https://edgegap.com/pricing)). Een vCPU die 24/7 draait ≈ $50/mnd, tien keer een heel CX33.
  Per-match betalen loopt alleen gunstig bij zeer lage bezetting en per-match starten; hier betaal je dus voor wat je niet nodig hebt.
  Hathora zou volgens de (partijdige) vergelijking van Edgegap een platformfee van $10.000/mnd rekenen: zelf navragen. Rivet: geen prijs gevonden, niet beoordeeld.
- **Agones:** gratis software, maar je betaalt de Kubernetes-nodes en de beheertijd. Een FleetAutoscaler houdt een buffer van
  gereedstaande GameServers aan en schaalt mee met allocaties ([Agones docs](https://agones.dev/site/docs/getting-started/create-fleetautoscaler/)).
  Zinvol voor een team dat toch al Kubernetes draait en zware servers per match heeft (Unreal/Unity, 1 proces = 1 match).
  Bij ons is 1 match ≈ 1,5 % van een core; een pod per match zou de overhead (kubelet, sidecar, 69 MB leeg) groter maken dan de match zelf.

### Updates met veel instanties (draining)

- Nu: `close()` zet `draining` (`/health` geeft dan 503, nieuwe WebSockets worden geweigerd), slaat alle werelden op en stuurt
  een kick met reconnect-hint. `update.sh` doet backup, health-check en rollback; een lopende match valt dus bij elke deploy weg
  (rejoin binnen `REJOIN_GRACE_SEC` vangt dat deels op, als het proces snel terugkomt).
- Bij meerdere instanties moet je rolling doen: instantie markeren als "draining" (geen nieuwe matches), wachten tot de lopende
  matches klaar zijn (arena: max 10-30 min), dan pas herstarten. Agones heeft dit ingebouwd (GameServers gaan "Shutdown" na de match);
  zelf bouwen = een `drain`-endpoint plus de gateway die nieuwe matches alleen naar niet-draining instanties stuurt.
- Auto-deploy op elke groene push naar `main` past slecht bij lange matches: overweeg een tijdvenster of "wacht tot leeg" (max N minuten).

## 3. Goedkopere tussenstappen met de meeste winst

Volgorde: meten, instellingen, kleine codewijzigingen, pas dan architectuur.

1. **Meten op de live server (0,5 dag).** Scrape `/metrics` (met `METRICS_TOKEN`) minstens 1 week, bij voorkeur met Prometheus/Grafana of
   een cron die de volgende reeksen wegschrijft:
   - `bunkcraft_tick_duration_seconds` p99 en `bunkcraft_tick_cpu_window_seconds` p99 (CPU-tijd, niet wandklok: verschil = host).
   - `bunkcraft_event_loop_lag_seconds` p99/max, `bunkcraft_slow_ticks_total`, `bunkcraft_tick_phase_seconds_total{phase}`.
   - `bunkcraft_players` en `bunkcraft_rooms_loaded` (piekbezetting), GC-pauzes, `chunk_main_thread_seconds_total`.
   - Op host: CPU steal (`/proc/stat`, `top`), cgroup-throttling (`cpu.stat` `nr_throttled`). Met `cpus: 1` is throttling de eerste verdachte.
   - Drempel om verder te gaan: event-loop-lag p99 > 20 ms of tick-CPU p99 > 15 ms (bij 50 ms tickbudget voor de 20 Hz-tick) aanhoudend, of CPU > 70 % van de limiet in de piek.
   - Wat er nog ontbreekt: **CPU per room** (nu alleen totalen per fase). Kleine toevoeging in `TickPhases.ts`: tijd per game optellen
     (labels op game-id zijn te zwaar voor Prometheus; bewaar de top 5 en toon die in `/admin`).
2. **Limiet verruimen (minuten, gratis).** `BUNKCRAFT_CPUS=1` naar 2 (met `CHUNK_WORKERS=2`) en memory naar 1g. Een CX23 of CX33 heeft de ruimte al.
3. **Zware bronnen verder weghalen van de main thread (dagen).** Profiel (160 spelers): mobs ~28 %, chunkpad ~27 %, random ticks ~12 %,
   licht ~8 %, `ws`-verzending ~7 %. Chunkgeneratie zit al in workers; kandidaten: `permessage-deflate` en JSON-serialisatie van `ent`-frames
   (10 Hz, alle mobs) naar delta's of binair, en random ticks in tijdsbudget (`ROOM_TICK_BUDGET_MS`) met doorschuiven naar de volgende tick.
4. **Per-room CPU-budget (1-2 dagen).** Eén ronde-robin over games met een maximum tick-tijd per game; een game die structureel over budget gaat krijgt
   lagere mob-cap of lagere snapshotrate. Beschermt arena-matches tegen een survival-wereld met veel mobs, zonder processplitsing.
5. **Arena's in `worker_threads` (1-2 weken, eerste echte isolatie).** Arena-matches zijn deterministisch, zonder chunks, en hebben weinig
   gedeelde state (profielen via berichten, parties via lookup). Voordeel: een zware survival-wereld of een lange GC-pauze in main
   vertraagt de hitscan en lag-compensatie niet meer; één kapotte match kan de worker laten crashen zonder de rest.
   Kosten: ~20-25 MB per worker en berichtenverkeer voor sockets (de `ws`-socket blijft in main; de worker krijgt invoer en geeft snapshots terug, dus de serialisatie verhuist, de I/O niet).
   Alternatief: socket-handoff naar een child process (niet beschikbaar voor `ws` in worker_threads zonder omweg).
   Beslismoment: pas doen als punt 1 laat zien dat arena-tick p99 gelijk loopt met survival-pieken.
6. **Tweede identiek proces (1 week, na punt 1).** Als één proces toch te weinig is: twee processen op dezelfde VPS, het hoofdproces voor de
   publieke wereld en profielen, het tweede voor arena-lobbies, met een gateway op `/ws/<CODE>` (de code bepaalt het proces via een prefix).
   Dit is in feite optie C met precies twee vaste processen, zonder dynamische orchestrator.

## 4. Aanbeveling in fases

| Fase | Wanneer | Wat | Inspanning |
|---|---|---|---|
| 1. Nu | altijd | Scrape `/metrics` (1 week), bekijk steal en cgroup-throttling, `BUNKCRAFT_CPUS=2`, drempels vastleggen in `docs/SERVER.md`. Optioneel: top-5 CPU per room in `/admin`. | 0,5-1 dag |
| 2. Bij veel pieken of ~100 gelijktijdige spelers | tick-CPU p99 of lag over de drempel | Per-room CPU-budget en lichtere `ent`-frames (§3.3-3.4). Eventueel grotere VPS (CX33). | 2-4 dagen |
| 3. Bij ~150-250 spelers of merkbare arena-hitches | meting toont main-thread verzadigd | Arena's in `worker_threads` (of tweede vast proces met gateway), `drain`-endpoint en rolling update. | 2-4 weken |
| 4. Later (>300-500 spelers, multi-regio) | echte vraag buiten NL/EU | Meerdere vaste instanties per regio met één state-service (accounts/profielen in SQLite/Postgres), gateway, Prometheus. Overweeg dan Agones of Edgegap, niet eerder. | 1-3 maanden |

Wat **niet** doen: een container per match zonder gateway/state-service; Kubernetes alleen om te kunnen autoscalen;
scale-to-zero om een paar euro per maand te besparen.

## 5. Risico's en kansen (zakelijk)

- Het grootste risico is niet CPU maar **single point of failure** (één VPS, één tunnel): een goede back-up en snelle restore
  (er is `scripts/bunkcraft.sh` en autoupdate met rollback) zijn belangrijker dan autoscaling.
- Een piek door een streamer of Reddit-post is de realistische schaalreden. Een grotere VPS in een paar minuten (Hetzner rescale) is dan de goedkoopste noodknop; rescale kost wel een herstart en nieuwe tarieven.
- Gedeelde vCPU's (CX) zijn de waarschijnlijkste oorzaak van tickpieken in productie, zoals ook op de meetmachine; één dedicated core is dus mogelijk meer waard dan een tweede proces.
- Profielen/accounts als losse JSON-bestanden zijn het eerste dat horizontaal schalen blokkeert. Een SQLite-laag (WAL) of kleine Postgres is een
  voorwaarde voor fase 4 en ook goed voor back-ups; plan dat los van de schaaldiscussie.

## Bronnen

- Hetzner: https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/ , https://costgoat.com/pricing/hetzner
- Edgegap: https://edgegap.com/pricing , https://edgegap.com/comparison/edgegap-vs-hathora
- Agones: https://agones.dev/site/docs/getting-started/create-fleetautoscaler/
- Cloudflare Tunnel routing: https://developers.cloudflare.com/tunnel/routing
- Eigen metingen: `docs/research/SERVER-DEPLOY.md` §2
