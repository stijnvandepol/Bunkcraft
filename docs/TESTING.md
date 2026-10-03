# Testen in BunkCraft

Er zijn vier lagen, van snel naar traag. Alles draait lokaal en in CI (`.github/workflows/ci.yml`).

| Laag | Commando | Duur | Wat |
|---|---|---|---|
| Unit, property en fuzz | `npm test` | ~45 s (samen met integratie) | DOM-vrije modules: wereld, speler, items, entities, net, save, modes, server |
| Server-integratie | `npm test` (map `tests/integration/`) | zit in de 45 s | De echte `server/index.ts` als proces, echte WebSocket-clients |
| Coverage | `npm run test:coverage` | ~50 s | Zelfde suite met v8-coverage, plus een tabel per gebied |
| Browser end-to-end | `npm run test:e2e` | ~2 min | Playwright: Chromium en WebKit tegen Vite (dev) en de gameserver |
| Performance | `npm run test:perf` | ~1 min | Mesh- en arena-benchmark tegen `scripts/perf-budget.json` |
| Bundelgrootte | `npm run build && npm run size:check` | seconden | Main chunk en chunk worker tegen `scripts/bundle-budget.json` |

Daarnaast blijven `npx tsc --noEmit` en `npm run build` verplicht na elke wijziging.

## Unit-, property- en fuzztests (`tests/*.test.ts`, `tests/fuzz/`)

- **Vitest** in Node, config in `vitest.config.ts`. Alleen DOM-vrije code; een paar tests stubben `fetch`,
  `localStorage`, `WebSocket` of `indexedDB` (`fake-indexeddb`).
- **Property tests** met [fast-check](https://fast-check.dev) (`tests/props.test.ts`, `tests/combat.test.ts`,
  `tests/protocol.test.ts`, `tests/playerExtra.test.ts`): packing van block states, chunk keys, block index en
  edit-encoding (round trips), inventory-invarianten (nooit lege of te volle slots, aantallen kloppen), recepten
  (alles bestaat, geen dubbele, alles maakbaar vanaf grondstoffen), terrein-determinisme in willekeurige chunkvolgorde,
  World-edit- en licht-invarianten, ray marching tegen een brute-force referentie.
- **Protocol-fuzzing** (`tests/fuzz/protocolFuzz.test.ts`): duizenden willekeurige en kapotte berichten per
  berichttype, ruwe binaire frames en afgekapte JSON naar een Minecraft-, tdm- en ffa-server. De server mag nooit
  gooien en moet daarna nog spelers binnenlaten.
- **Mob-AI** (`tests/mobAi.test.ts`, `tests/mobBehavior.test.ts`): met een nepwereld. `Math.random` is daar
  geseed via `useSeededRandom()` uit `tests/helpers/seededRandom.ts`, zodat elke run gelijk is.

## Server-integratie (`tests/integration/`)

`tests/integration/harness.ts` start `server/index.ts` als echt proces op een vrije poort met een tijdelijke
`DATA_DIR`, `ROOM_CREATE_LIMIT=1000`, `TRUST_PROXY=1` (elke test krijgt een eigen `X-Forwarded-For`-adres, zodat de
limieten per bezoeker tests niet aan elkaar koppelen) en `LOG_LEVEL=info` (de harness wacht op de regel
`server started`). `Client` is een echte `ws`-client die alle berichten bijhoudt (`waitFor`, `waitType`, `mark`).

Wat erin zit: HTTP-API (aanmaken, opzoeken, limieten, 400/404/429/503), twee spelers in een room, blokken die
synchroniseren en geweigerd worden, chat-limiet, naamconflicten, oude protocolversie, kapotte JSON, te grote
berichten, herverbinden met behoud van edits en inventory, server-herstart (alles terug van schijf), verlopen rooms,
heartbeat (> 30 s, echte tijd), `NetClient` van de browser tegen de echte server, en een volledige tdm- en ffa-match
(warm-up, live, vijf headshot-kills met respawns, einde van de match).

De tdm-, ffa- en heartbeat-bestanden duren elk 25–40 s, maar Vitest draait bestanden parallel.

## Browser end-to-end (`tests/e2e/`)

```bash
npx playwright install chromium webkit   # eenmalig
npm run test:e2e                          # alles
npx playwright test -c tests/e2e/playwright.config.ts --project=chromium multiplayer   # één bestand
```

Playwright start en stopt zelf de gameserver (poort 3197, tijdelijke `DATA_DIR`) en Vite in dev-modus met
`tests/e2e/vite.e2e.config.ts` (poort 5197, geen HMR, geen file watching, proxy naar 3197). Andere poorten:
`E2E_GAME_PORT` en `E2E_VITE_PORT`. De tests sturen het spel via de dev-hook `window.game` (en `await import('/src/…')`
voor modules), volgens de regels in `CLAUDE.md`: pointer lock wordt nagebootst met `forcePlaying()`, klikken gaan via
`game.input.pressed/down`, nooit `page.mouse.move`, en wachten gebeurt met `play()` die het venster vooraan houdt.

- `smoke.spec.ts`: titelscherm, Select World en Create New World, met screenshot-vergelijking (canvas gemaskeerd).
- `singleplayer.spec.ts`: wereld maken, lopen, blok breken en plaatsen, craften, opslaan, herladen; settings blijven
  bewaard (ook bij kapotte opslag).
- `features.spec.ts`: één creatieve wereld en per systeem een basischeck: worldgen v3 en biomes, commando's (xp,
  effects, gamerules, weer, difficulty, enchant), oven en kist (ook na herladen), redstone, random ticks, fokken,
  bedden en de Nederlandse UI.
- `multiplayer.spec.ts`: twee browsers, game maken via het menu, joinen via de uitnodigingslink, chat en blokken;
  arcade tdm, ctf en hardpoint: joinen, match gaat live, schieten.

Elke flow faalt bij console-errors of uncaught exceptions (fixture `consoleErrors` in `fixtures.ts`, met een korte
lijst onschuldige meldingen). WebKit (Safari-engine) draait de tests met `@webkit` in de naam.

**Screenshot-baselines** staan in `tests/e2e/baselines/<browser>-<os>/`. De eerste run op een platform schrijft ze
(en die run faalt één keer met "writing actual"); daarna wordt er vergeleken met een tolerantie van 3–4 % pixels.
In CI wordt de vergelijking overgeslagen zolang er voor `linux` geen baselines zijn; om ze toe te voegen: draai de
suite op Linux (bijvoorbeeld in de Playwright-container) en commit `tests/e2e/baselines/*-linux/`.
Bewust een scherm veranderd? `npx playwright test -c tests/e2e/playwright.config.ts --update-snapshots`.

## Performance en bundelgrootte

- `npm run test:perf` (`scripts/perf-smoke.ts`) draait `bench-mesh.ts` en `bench-arena.ts` en vergelijkt met
  `scripts/perf-budget.json`. De grenzen zijn ruime plafonds; in CI (`CI=true`) gaan ze maal `ciFactor`. Bandbreedte
  per speler heeft geen factor. Een bewuste verslechtering: budget in dezelfde commit ophogen.
- `npm run size:check` (`scripts/bundle-size.ts`) faalt als de gzip-grootte van de main chunk of de chunk worker
  meer dan 10 % boven `scripts/bundle-budget.json` komt. Bewuste groei: `npm run size:check -- --update` en de JSON
  committen.

## Coverage

`npm run test:coverage` schrijft `coverage/` (lcov, json-summary) en print een tabel per gebied
(`scripts/coverage-areas.ts`). CI bewaart `coverage/` als artifact. Tijdsgebonden asserts in unit-tests worden onder
coverage met `TIME_SLACK` (`tests/helpers/timing.ts`) verruimd, want instrumentatie maakt hete lussen trager.

## Tests toevoegen

- Pure logica: een `tests/<onderwerp>.test.ts` naast de bestaande. Hulpjes: `tests/helpers.ts` (`TestWorld`,
  `makeTestWorld`, `fnv1a`), `tests/helpers/` (`seededRandom`, `matchHost`, `serverHarness`, …).
- Iets met invarianten (packing, inventory, parsers)? Liever een fast-check-property dan drie voorbeelden.
- Gebruikt de code `Math.random`? Zet `useSeededRandom()` bovenaan het bestand in plaats van een assert te verruimen.
- Servergedrag over het netwerk: `tests/integration/` met `startServer()` en `Client`. Houd elk bestand onder ~40 s.
- Een gevonden bug die je niet zelf oplost: schrijf de test als `it.fails(...)` met een commentaar `// BUG (...)`;
  zodra de fix er is, slaagt `it.fails` niet meer en wordt het een gewone regressietest.
- Een browserflow: `tests/e2e/<flow>.spec.ts` met `test`/`expect` uit `./fixtures` (dan krijg je de console-check).
  Voeg `@webkit` toe aan de titel als hij ook in Safari moet draaien.

## Bekende gevoelige plekken

- **Zwaar belaste machine.** De integratietests starten tot ~8 serverprocessen tegelijk. Op een laptop waar ook
  andere builds of agents draaien liepen tdm/ffa en de heartbeat-test een paar keer tegen time-outs aan (socket 1006,
  start-time-out). Ruime time-outs (`hookTimeout` 60 s, `waitFor` 10 s) vangen dat op; in CI is het niet gezien.
- **Achtergrondvensters.** Een Playwright-venster achter andere vensters rendert op 1–10 FPS; `play()` en de polls
  roepen daarom steeds `bringToFront()` aan. Een klik (`input.pressed`) duurt één frame; tests klikken opnieuw tot
  het effect er is.
- **Tijdsbudgetten in unit-tests** (`mobAi` path budget, `mobSpawner`, `growthServer`) meten wandkloktijd; zie
  `TIME_SLACK`.
- **WebKit** draait alleen de `@webkit`-tests: multiplayer en arcade lopen op Chromium.
- **Arcade-kills in de browser** worden niet getest (twee spelers precies laten mikken is broos); de kills, respawns
  en het einde van de match zitten in `tests/integration/arcade.*.it.test.ts`.
