# Distributie: PWA, delen, statische hosting

## PWA

- `public/manifest.webmanifest`: naam, `display: standalone`, `orientation: landscape`, kleuren `#1c1a18`, iconen 192/512 (any en maskable). Alle paden zijn relatief, dus het werkt ook onder een submap.
- Iconen, apple-touch-icon en `social-preview.png` komen uit `scripts/make-icons.ts` (procedureel getekend, geen Mojang-assets). Opnieuw genereren: `npx tsx scripts/make-icons.ts`; de uitvoer staat in git.
- `public/sw.js` is een handgeschreven service worker. `scripts/vite-pwa.ts` vult bij `vite build` de precache-lijst (alle gebouwde bestanden behalve `texturepacks/`, `*.map`, `404.html`) en een versie (hash van de inhoud) in.
  - Precache `bunkcraft-precache-<hash>`; een nieuwe build installeert ernaast en wacht (geen `skipWaiting`) tot de speler op "Reload" klikt in de toast (`src/pwa/Pwa.ts`).
  - `index.html` (navigaties): network-first, 4 s timeout, dan de gecachete pagina. Dit houdt `?join=` en `?seed=` links werkend, ook offline.
  - Texturepacks, fonts, iconen: cache-first met achtergrondverversing in `bunkcraft-runtime`.
  - Nooit gecachet: niet-GET, andere origins, `/api/*`, `/ws*`, `/health`.
  - Alleen geregistreerd in productiebuilds (`import.meta.env.PROD`).
- Installeren: `beforeinstallprompt` wordt vroeg opgevangen (`initPwa()` in `main.ts`); de knop "Install App" verschijnt op het titelscherm en in Options zolang de browser installatie aanbiedt. iOS gebruikt Deel → Zet op beginscherm (meta-tags staan in `index.html`).
- Strikte CSP: de service worker, het manifest en de iconen zijn same-origin; nodig zijn `worker-src 'self' blob:` (workers voor terrein/meshing), `manifest-src 'self'`, `img-src 'self' data: blob:` (wereldiconen zijn data-URL's). De PWA-code gebruikt geen inline `<style>`; alleen `src/ui/dom.ts` zet `style`-attributen (bestond al).

## Werelden exporteren en importeren

`src/save/WorldArchive.ts` (zuiver, getest in `tests/worldArchive.test.ts`) en `src/save/WorldTransfer.ts` (opslag + downloads).

Een `.bunkworld` is een zip: `level.json` (`format: "bunkworld"`, `formatVersion`, `saveVersion`, meta), `player.json`, `advancements.json`, `icon.png`, `chunks/<key>.v<n>.bin` (little-endian Uint32, n = versie van het chunk-record). Een backup is een zip van `.bunkworld`-bestanden.

Import is defensief: bestandsgrootte 64 MB, 20.000 entries, 192 MB uitgepakt (totaal, ook voor geneste backups), per entry een eigen maximum (chunk 128 KiB), alleen toegestane bestandsnamen (geen paden), de werkelijke grootte na uitpakken wordt opnieuw gecontroleerd, alle velden worden gevalideerd en overgenomen (nooit gespreid), chunk-entries moeten binnen de chunk vallen. Nieuwere formaat- of save-versies worden geweigerd; oudere lopen door `migrateMeta`. Een bestaand id geeft de geimporteerde wereld een nieuw id.

## Delen

- `/?seed=<tekst of getal>&mode=survival|creative|hardcore|spectator` opent Create World ingevuld (`src/save/share.ts`).
- F2: `canvas.toBlob` direct na het renderen, bestandsnaam `bunkcraft-YYYY-MM-DD_HH.MM.SS.png`. Alleen het 3D-beeld (hand inbegrepen); de HUD is DOM en zit er dus niet in.
- Pauzemenu: "Copy Seed" (singleplayer).
- Options: "Lock Esc in Fullscreen" (alleen Chromium, standaard uit, `localStorage` `bunkcraft.lockEsc`): `navigator.keyboard.lock(['Escape'])` in fullscreen; Esc pauzeert dan de game in plaats van fullscreen te verlaten.

## Statische build (itch.io e.a.)

```bash
npm run build:static     # dist-static/ + bunkcraft-static.zip
npx http-server dist-static -p 8080
```

- `vite.config.ts` gebruikt `base: './'` en `outDir: dist-static` bij `BUNK_STATIC=1`; `VITE_STATIC=1` zorgt dat Direct Connect om een serveradres vraagt (er is geen server op de pagina zelf). `/api/server` ontbreekt of geeft geen `rooms`/`main` terug: dan toont Multiplayer alleen Direct Connect.
- itch.io: maak een project van het type "HTML", upload `bunkcraft-static.zip`, vink "This file will be played in the browser" aan, kies een viewport van bijvoorbeeld 960x600 en zet "Fullscreen button" aan. Niet op itch.io zelf getest (alleen lokaal onder een submap): controleer pointer lock in de iframe en of de service worker daar registreert.
- `public/404.html` stuurt onbekende paden (GitHub Pages, Netlify) naar `/` met behoud van `?join=` en `?seed=`. Onder een submap moet je dat bestand aanpassen. De eigen Node-server serveert voor onbekende paden altijd `index.html`.

## Gemeten

- Offline (Playwright, `context.set_offline(True)`, herladen): titelscherm, wereld aanmaken en laden werken, geen mislukte requests. Gecontroleerd op de Node-server (`/`), `http-server` op `/` en onder `/game/`.
- Chrome `Page.getInstallabilityErrors`: leeg; `getAppManifest`: geen fouten.
- Lighthouse 13.5 (headless, software-GL): Accessibility 100, Best Practices 100, SEO 100, Performance 33 (software rendering, niet representatief). Lighthouse 13 heeft geen PWA-categorie meer.
