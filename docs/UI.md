# UI-audit: BunkCraft tegen Minecraft Java 1.21

> **Oktober 2026:** het titelscherm is vervangen door de home van de arenashooter, en de arenamenu's, instellingen, lobby
> en het einde van een wedstrijd hebben een eigen look (zie [`research/IDENTITY.md`](research/IDENTITY.md)). Deze audit
> geldt nog voor de survival-menu's achter Bouwen & Survival.

Audit van de 2D-interface (menu's, HUD, inventory, chat, F3) tegen Minecraft Java 1.21 en de GUI-pagina's van de wiki.
Per bevinding: wat er afweek, wat er nu is, en wat nog open staat. Maten zijn in GUI-pixels (`--s`).

Screenshots: `docs/screenshots/ui/before/` (stand vóór deze ronde, commit `7055e73`) en `docs/screenshots/ui/after/`,
beide 1280×800 op GUI-schaal 2. De volledige matrix (GUI-schaal 1–4 × 1280×800, 1920×1080, 800×600, 225 beelden)
maak je met `scripts/ui-shots.py`; die staat niet in git (99 MB).

| Scherm | Voor | Na |
|---|---|---|
| Titelscherm | [before](screenshots/ui/before/title.jpg) | [after](screenshots/ui/after/title.jpg) |
| Options | [before](screenshots/ui/before/options.jpg) | [after](screenshots/ui/after/options.jpg) |
| Video Settings | [before](screenshots/ui/before/video.jpg) | [after](screenshots/ui/after/video.jpg) |
| Music & Sounds | [before](screenshots/ui/before/sound.jpg) | [after](screenshots/ui/after/sound.jpg) |
| Controls | [before](screenshots/ui/before/controls.jpg) | [after](screenshots/ui/after/controls.jpg) |
| Mouse Settings | (bestond niet) | [after](screenshots/ui/after/mouse.jpg) |
| Chat Settings | (bestond niet) | [after](screenshots/ui/after/chat_settings.jpg) |
| Language | (bestond niet) | [after](screenshots/ui/after/language.jpg) |
| Key Binds | [before](screenshots/ui/before/keybinds.jpg) | [after](screenshots/ui/after/keybinds.jpg) |
| Select World | [before](screenshots/ui/before/worlds.jpg) | [after](screenshots/ui/after/worlds.jpg) |
| Create World (Game / World / More) | [before](screenshots/ui/before/create_game.jpg) | [game](screenshots/ui/after/create_game.jpg), [world](screenshots/ui/after/create_world.jpg), [more](screenshots/ui/after/create_more.jpg) |
| Edit World | [before](screenshots/ui/before/edit_world.jpg) | [after](screenshots/ui/after/edit_world.jpg) |
| Wereld verwijderen | [before](screenshots/ui/before/delete_world.jpg) | [after](screenshots/ui/after/delete_world.jpg) |
| Laadscherm | [before](screenshots/ui/before/loading.jpg) | [after](screenshots/ui/after/loading.jpg) |
| Pauzemenu | [before](screenshots/ui/before/pause.jpg) | [after](screenshots/ui/after/pause.jpg) |
| Statistics | (bestond niet) | [after](screenshots/ui/after/statistics.jpg) |
| Doodscherm | [before](screenshots/ui/before/death.jpg) | [after](screenshots/ui/after/death.jpg) |
| HUD | [before](screenshots/ui/before/hud.jpg) | [after](screenshots/ui/after/hud.jpg) |
| Chat met suggesties | [before](screenshots/ui/before/chat.jpg) | [after](screenshots/ui/after/chat.jpg) |
| F3 | [before](screenshots/ui/before/f3.jpg) | [after](screenshots/ui/after/f3.jpg) |
| Survival-inventory | [before](screenshots/ui/before/survival_inventory.jpg) | [after](screenshots/ui/after/survival_inventory.jpg) |
| Creative-inventory | [before](screenshots/ui/before/creative_inventory.jpg) | [after](screenshots/ui/after/creative_inventory.jpg) |

## 1. Bevindingen en status

### Algemeen

| # | Bevinding (afwijking van 1.21) | Status |
|---|---|---|
| A1 | Knoppen 200×20, halve knoppen 98×20, rijen 24 uit elkaar, header/footer 33 | Klopte al |
| A2 | Lijstschermen: 1.20.5+ gebruikt een vervaagd panorama met donkere lijst en scheidingslijnen, geen dirt meer | Klopte al. Dirt alleen nog op het laadscherm, zoals in 1.21 (procedurele tegel, geen Mojang-asset) |
| A3 | Geen toetsenbordnavigatie: pijltjes deden niets, focus was onzichtbaar op sliders en lijstitems | **Gedaan:** de pijltjes/controller-navigatie is `src/ui/MenuNav.ts` van de accessibility-ontwikkelaar (mijn eigen versie is bij de merge vervallen). Van deze ronde: witte focusrand op sliders, tabs en werelden, en werelden zijn met Tab/Enter/Spatie te kiezen |
| A4 | Alles alleen Engels | **Gedaan:** `src/ui/i18n.ts` met getypte sleuteltabel, Engels + Nederlands, `t(key, fallback)` voor schermen van anderen. Taal wordt bij de eerste start uit de browser gehaald |

### Titelscherm

| # | Bevinding | Status |
|---|---|---|
| T1 | Panorama, logo, "Browser Edition", knoppen op 25% + 48 | Klopte al |
| T2 | Splash: schaal 1,8 × 100 / (breedte + 32) en de puls | Klopte al |
| T3 | Datum-splashes (kerst, nieuwjaar, Halloween) ontbraken | **Gedaan:** `dateSplash()` |
| T4 | Taalknop (wereldbol) links naast Options ontbrak | **Gedaan:** pixel-wereldbol op 20×20, buiten de 200-kolom zoals in 1.21 |
| T5 | Toegankelijkheidsknop rechts naast Quit | Open: het scherm bestaat nu (`accessibilityScreen`), alleen het icoon op het titelscherm nog toevoegen |

### Options

| # | Bevinding | Status |
|---|---|---|
| O1 | Geen Language, Chat Settings, Mouse Settings, Accessibility in de hub | **Gedaan.** Accessibility, Touch en Controller komen van de accessibility-ontwikkelaar en staan nu (vertaald) in dezelfde hub |
| O2 | Video: Max Framerate, Entity Distance, Attack Indicator ontbraken | **Gedaan:** Max Framerate 30–250/Unlimited met een goedkope frame-limiter in `Game.frame` (een refresh overslaan, geen timers); Entity Distance 50–500% schaalt de mob-cullafstand; Attack Indicator (Crosshair/Hotbar/Off) zie H6. FOV Effects staat, net als in 1.21, onder Accessibility |
| O3 | VSync, Biome Blend, Distortion Effects | Bewust niet: VSync kan niet in de browser, Biome Blend overgeslagen, Distortion Effects hoort bij het accessibility-scherm |
| O4 | Music & Sounds: Minecraft heeft 9 categorieën | Alleen wat de audio-engine heeft: Master, Music, Blocks & Actions, Ambient, Interface, 3D Sound. Geen lege sliders |
| O5 | Controls: Mouse Settings-submenu en Auto-Jump ontbraken | **Gedaan:** Mouse Settings (gevoeligheid, invert, Raw Input = `unadjustedMovement`), Auto-Jump (gebruikt dezelfde `needsAutoJump` als de touch-bediening) |
| O6 | Chat Settings ontbrak | **Gedaan:** tekstdekking, tekstgrootte, regelafstand, breedte, kleuren aan/uit, commandosuggesties |

### Wereldlijst en wereld maken

| # | Bevinding | Status |
|---|---|---|
| W1 | Regel 3 toonde seed; 1.21 toont modus, cheats en versie | **Gedaan:** "Survival Mode, Cheats, Version: 1.0"; datum als `yyyy/MM/dd HH:mm` |
| W2 | Geen play-pijl over het icoon bij hover | **Gedaan** (ook bij toetsenbordfocus; Enter speelt, Spatie selecteert) |
| W3 | Sortering | Laatst gespeeld eerst (zoals Minecraft); zoeken bestond al |
| W4 | Edit World: alleen naam en modus | **Gedaan:** Allow Cheats, "Back Up World" (download), seed. "Open World Folder" kan niet in de browser |
| W5 | Create World: tab More ontbrak, geen Allow Cheats | **Gedaan:** Game / World / More. World: type, seed, Generate Structures en Bonus Chest (uitgeschakelde placeholders). More: Allow Cheats (standaard aan in Creative, uit elders, zoals Minecraft) en Game Rules (het scherm van de combat-ontwikkelaar). Game: naam, modus, Difficulty |
| W6 | Allow Cheats deed niets; singleplayer had geen chat | **Gedaan:** <kbd>T</kbd> en <kbd>/</kbd> openen nu ook in singleplayer de chat; berichten worden getoond, `/`-commando's alleen met cheats (`WorldMeta.cheats`, oude werelden: aan in Creative) |
| W7 | Verwijderen: Minecraft bevestigt alleen met een knop | Klopte al |
| W8 | Laadscherm: kaal, geen percentage, geen tips | **Gedaan:** dirt-achtergrond, balk van 182 breed met rand, status + percentage, elke 5 s een tip uit de echte toetsen van de speler (`tip.1`–`tip.14`) |

### Pauze, dood en statistieken

| # | Bevinding | Status |
|---|---|---|
| P1 | Layout Back to Game / Advancements + Statistics / Copy Seed + Report Bugs / Options + LAN / Save and Quit | Klopte al; de Difficulty + Game Rules-rij van de combat-ontwikkelaar staat erin, vertaald |
| P2 | Statistics was een dode knop | **Gedaan:** `StatTracker` (blokken gedolven/geplaatst, mobs gedood, doden, afstand, sprongen, speeltijd), opgeslagen in `WorldMeta.statistics`, scherm in Minecraft-stijl. Alleen singleplayer |
| D1 | "You died!" op dubbele schaal, oorzaak wit, "Score:" grijs met geel getal, Respawn/Title Screen | Klopte al; nu vertaald |

### HUD

| # | Bevinding | Status |
|---|---|---|
| H1 | Hotbar 182×22, selectieframe 24×24 | Klopte al |
| H2 | Hearts alleen vol/half/leeg | **Gedaan:** hardcore-hart, gif (groen) en wither (zwart, klaar voor het effects-werk), goud voor absorption, witte rand-flits bij schade, regeneratiegolf (één hart springt na het ander op), honger-trillen bij saturatie 0. Nog steeds alleen hertekend bij verandering |
| H3 | Armor-rij boven de hearts, lucht boven honger | Klopte al |
| H4 | XP-balk | Van de XP/enchanting-ontwikkelaar |
| H5 | Crosshair 9×9 met difference-blend | Klopte al |
| H6 | Attack Indicator ontbrak | **Gedaan:** de instelling kiest tussen de cooldown-balk onder de crosshair (EffectsHud van de combat-ontwikkelaar), een vierkant naast de hotbar (`hud.setAttackCharge`) of Off |
| H7 | F1 / F2 / F11 | F1 en F2 bestonden; **F11** schakelt nu volledig scherm; screenshot-toast vertaald |

### Chat

| # | Bevinding | Status |
|---|---|---|
| C1 | Breedte 320, onder op 40, 10 regels dicht / 20 open | Klopte al |
| C2 | Vervagen: Minecraft toont 10 s en vervaagt de laatste seconde | **Gedaan:** 9 s zichtbaar + 1 s lineaire fade (was 10 s + 0,5 s) |
| C3 | Geen geschiedenis met ↑/↓ | **Gedaan:** `ChatHistory` (100 regels, concept blijft bewaard) |
| C4 | Geen `/`-suggesties of Tab-aanvulling | **Gedaan:** lijst boven de invoer, Tab vult het gemeenschappelijke deel aan en bladert dan (Shift+Tab terug). Commandonamen en vaste argumenten (`/weather clear|rain|thunder`, `/gamemode`, `/time set`) komen uit dezelfde usage-regels als `server/Commands.ts`; een test bewaakt dat ze gelijk blijven |
| C5 | Kleurcodes `§a` werden letterlijk getoond | **Gedaan:** omgezet naar spans (nooit HTML), uit te zetten via Chat Settings > Colors |

### F3

| # | Bevinding | Status |
|---|---|---|
| F1 | Indeling week af | **Gedaan:** links versie, fps, `C:`/`E:`-tellers, dan XYZ (Y met 5 decimalen), Block, Chunk ("x y z in cx cz"), Facing met "Towards negative Z", Light, Biome, tijd, weer; rechts Mem, CPU, Display, GPU, dan Targeted Block. F3 blijft Engels, net als in Minecraft |

### Inventory

| # | Bevinding | Status |
|---|---|---|
| I1 | Slots 18×18, tooltip-kader paars | Klopte al |
| I2 | Hotbar-rij stond onder de armor-kolom in plaats van onder de 27 opslagslots | **Gedaan** |
| I3 | Tooltip: alleen een naam | **Gedaan:** naam wit, daaronder grijze regels (itemdata, "Durability: x / y") |
| I4 | Toetsen boven een slot: 1–9 wisselen met de hotbar, Q gooit één item (Ctrl+Q de stapel) | **Gedaan** |
| I5 | Dubbelklik verzamelt alles van dezelfde soort op de cursor | **Gedaan** |
| I6 | Cursor-stapel en tooltip volgen via `left/top` (layout per muisbeweging) | **Gedaan:** alleen `transform: translate3d` + `will-change` |
| I7 | Drag-split (slepen over slots verdeelt), muiswiel in de inventory | Open |
| I8 | 2×2 crafting-raster, offhand-slot, speler-preview die de muis volgt | Open: het receptenboek craft direct; een raster vraagt een API-wijziging in `SurvivalInventory`, die nu ook door het furnace- en enchanting-werk wordt aangepast. Eerst afstemmen |
| I9 | Duurzaamheidsbalk groen → rood (HSV-tint) en tellertje met schaduw rechtsonder | Klopte al |

## 2. Performance

- HUD: hearts/honger alleen hertekend bij een nieuwe sleutel; het attack-indicator-DOM alleen bij een nieuwe 1/16-stap.
- Chat: één timer per regel, fade via CSS-opacity met `will-change`.
- Inventory: geen layout meer per muisbeweging (I6).
- Frame-limiter kost niets als hij op Unlimited staat.

## 3. Afstemming met andere ontwikkelaars

- **Accessibility/touch:** hun schermen (Accessibility, Touch, Controller) staan in de Options-hub; de labels in die schermen zijn nog Engels (sleutels toevoegen aan `i18n.ts`). Distortion Effects hoort daar.
- **Combat/effects:** gekoppeld (cooldown, gif/wither-harten uit de `EffectSet`). Absorption tekent hun `EffectsHud`; het `absorption`-veld van `SurvivalHud` blijft ongebruikt. Furnace-, kist-, Game Rules- en effectteksten zijn nog Engels.
- **Andere schermen vertalen:** sleutel toevoegen aan `EN` en `NL` in `src/ui/i18n.ts` en `t('sleutel')` gebruiken; tot dan werkt `t('sleutel', 'English')` met de fallback.

## 4. Testen

- `npm test`: `tests/i18n.test.ts` (elke sleutel in beide talen, gelijke placeholders), `tests/chatLogic.test.ts` (geschiedenis, aanvulling, kleurcodes, synchroon met `server/Commands.ts`), `tests/statTracker.test.ts`.
- `python3 scripts/ui-shots.py --check`: pixel-diff van 25 schermen tegen `docs/screenshots/ui/baseline/` in een stabiele modus (3D-canvas verborgen, animaties bevroren, willekeurige teksten verborgen). Faalt bij meer dan 1% gewijzigde pixels. Na een bewuste wijziging: `--update-baselines`. Zie de kop van het script voor de Vite-config zonder HMR.
