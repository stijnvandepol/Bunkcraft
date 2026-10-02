# Overdracht: verder op de MacBook

## Stap 1: code ophalen (op de Mac)

```bash
git clone https://github.com/stijnvandepol/Game.git && cd Game   # of: git pull in een bestaande clone
git checkout feature/bunkcraft-engine
brew install node        # Node 20+ (of via nvm)
npm install
```

> Push de branch eerst vanaf de Windows-pc (`git push`) als dat nog niet is gebeurd.

## Stap 2: deze prompt plakken in Claude Code op de Mac

```text
Ik zet hier de ontwikkeling van BunkCraft voort, die op mijn Windows-pc begonnen is. Lees eerst
CLAUDE.md (projectoverzicht, commando's, regels en test-valkuilen), daarna docs/ROADMAP.md en
docs/SERVER.md. Antwoord in het Nederlands.

Stand van zaken (branch feature/bunkcraft-engine, laatste commits):
- Engine: chunks met greedy meshing, smooth lighting met AO, biome-tinting, cached schaduwen,
  texture packs (Pixel Perfection + eigen Minecraft-jar importeren), kwaliteitspresets
  Low→Extreme, menu's in Minecraft 1.21-stijl.
- Gameplay: Survival, Creative, Hardcore en Spectator; health, honger en adem; mobs (varken, koe,
  schaap, kip, zombie, creeper met explosies); items, tools en crafting (werkbank, oven); fakkels
  en lava; first-person hand.
- Multiplayer v1: één Node-server (server/) serveert de game en de WebSocket op /ws, met een
  gedeelde wereld, chat, spelers en validatie. Getest met 2 spelers in 2 tabs: blokken, chat,
  rollback en remote players werken. Multiplayer is nog vredig (geen mobs).
- 15 bugs uit een code-review en de robuustheidsfixes uit de engine-audit zijn gedaan (zie
  docs/ROADMAP.md, gemarkeerd als "Gedaan").

Stap 1, testen op de Mac (Apple Silicon + Safari/Chrome):
1. npm run build en npm start, open http://localhost:3000 in Safari én Chrome. Controleer:
   hoofdmenu, singleplayer survival (boom hakken → planken → werkbank → houten pickaxe),
   creative, mobs 's nachts, fakkels en lava, F3-overlay, Options → Video Settings-presets.
2. Meet de FPS per preset met F3 en vergelijk met de Windows-meting (geïntegreerde AMD:
   Low 130–140, Medium 144, High ~110, Ultra ~68, Extreme ~43). Noteer de resultaten in
   docs/RESEARCH.md.
3. Safari-specifiek: pointer lock, de hotbar-tekst/font, WebGL2-schaduwen, de audio-unlock
   en de import van ~/Library/Application Support/minecraft/versions/<versie>/<versie>.jar
   via Options → Resource Packs.
4. Multiplayer: start de server en join vanaf Mac + een tweede apparaat in het netwerk
   (http://<ip-van-de-mac>:3000). Test samen bouwen, chat, /time set night en opnieuw inloggen
   (positie en inventory blijven bewaard).
5. Docker: docker build -t bunkcraft . && docker run -p 3000:3000 -v bunkcraft-data:/app/data bunkcraft
Repareer wat stuk is (met typecheck + build), en rapporteer kort wat je gevonden hebt.

Stap 2, verder bouwen volgens docs/ROADMAP.md, in deze volgorde:
1. Mobs op de multiplayer-server (EntityManager/Mob zijn DOM-vrij; de server heeft al
   TerrainGenerator; mob-snapshots versturen zoals spelers).
2. Gebruik voor drops waar nu niets mee kan: goud + gouden tools, TNT, bed (spawnpunt + nacht
   overslaan), vuursteen, pijl en boog.
3. ~15 advancements met toasts die ook als tutorial dienen.
4. Werkende keybind-remapping (het scherm bestaat al).
5. Vitest-tests + GitHub Actions CI.
6. Daarna block states (meta-array) voor stromend water, trappen, slabs en deuren.
Doe eerst kort onderzoek waar nodig, laat een plan zien, en bouw dan. Commit per afgeronde stap op
feature/bunkcraft-engine en push alleen als ik daarom vraag.
```

## Notities

- **Werelden staan per browser.** Singleplayer-werelden staan in IndexedDB van de browser, dus op de Mac begin je met een lege lijst. Werelden overzetten kan pas als export/import is gebouwd (roadmap).
- **Multiplayer-werelden** staan in `data/world.json` op de server; kopieer die map om een serverwereld mee te nemen.
- **Line endings:** Windows waarschuwde over LF/CRLF; `.gitattributes` (`text=auto`) normaliseert dit, dus op de Mac is niets nodig.
