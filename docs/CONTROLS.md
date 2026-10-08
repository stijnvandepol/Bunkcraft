# Bediening en toegankelijkheid

Alle apparaten sturen dezelfde acties aan (`src/core/Keybinds.ts`, `Input.setAction`), dus toggle/hold-opties en de spellogica gelden overal.

## Toetsenbord en muis

Standaard, aanpasbaar via Options > Controls > Key Binds.

| Actie | Standaard |
|---|---|
| Lopen | W A S D |
| Springen (dubbel tikken: vliegen in creative) | Spatie |
| Sneak / omlaag vliegen (arcade: crouch, tijdens rennen: slide) | C |
| Sprint | Linker Shift |
| Aanvallen / breken | Linkermuisknop |
| Gebruiken / plaatsen | Rechtermuisknop |
| Blok kiezen (creative) | Middelste muisknop |
| Hotbar | 1-9, scrollwiel |
| Inventaris / droppen | E / Q |
| Chat / commando | T / / |
| Arcade: herladen, scoreboard, loadout | R, Tab (vasthouden), B |
| Arcade: wapens | 1, 2, 3, Q (snel wisselen); muiswiel zoomt door een sniper-scope |
| Menu | Pijltjestoetsen verplaatsen de focus, Tab, Enter |
| Debug / HUD verbergen | F3 / F1 |

## Gamepad

Standard mapping (Xbox, PlayStation, Switch Pro via de browser). Een controller wordt automatisch herkend; bij de eerste knop of stick-beweging schakelt het spel over naar de pad (geen pointer lock nodig). Een muisklik schakelt terug.

| Knop | Spel (sandbox) | Arcade | Menu |
|---|---|---|---|
| Linker stick | Lopen (analoog), helemaal vooruit = sprint | idem | Focus verplaatsen |
| Rechter stick | Kijken | Kijken | |
| A | Springen | Springen | Activeren |
| B | Sneak / omlaag | Sneak | Terug |
| X | Inventaris | Herladen | |
| Y | Blok kiezen | Snel wisselen | |
| RT / LT | Aanvallen / gebruiken | Vuren / richten | |
| LB / RB, d-pad links/rechts | Hotbar | Wapen wisselen | Sliders / focus |
| D-pad onder / boven | Droppen / - | - / loadout | Focus |
| L3 (stick indrukken) | Sprint | | |
| Back | Chat | Scoreboard (vasthouden) | |
| Start | Pauze | Pauze | Hervatten |

Controller Settings: gevoeligheid, dode zone, invert Y, stick-curve, layout (Default of Southpaw: sticks gewisseld) en trillen (schade, explosies, hit markers). De tabel staat in `PAD_BINDINGS` (`src/core/InputMath.ts`).

## Touch

Verschijnt op touchapparaten (`any-pointer: coarse`) of na de eerste aanraking; Options > Touch Settings: Auto, ON of OFF.

| Gebaar of knop | Actie |
|---|---|
| Linkerhelft slepen | Zwevende joystick (lopen); helemaal naar voren duwen = sprint |
| Rechterhelft slepen | Kijken (gevoeligheid instelbaar) |
| Korte tik op het beeld | Gebruiken / plaatsen |
| Vasthouden op het beeld | Aanvallen / breken |
| JUMP (dubbel tikken: vliegen in creative) | Springen |
| SNEAK | Sneak / omlaag vliegen (vasthouden) |
| RUN | Sprint (aan/uit) |
| HIT / USE | Aanvallen en gebruiken (vasthouden) |
| Hotbar tikken of erover vegen | Slot kiezen |
| INV, CHAT, II, FS | Inventaris, chat, pauze, fullscreen |
| Arcade: FIRE, AIM (aan/uit), RELOAD, SWAP, TAB, GUNS | Vuren, richten, herladen, wapen wisselen, scoreboard, loadout |

Extra: auto-jump, linkshandig, knopgrootte en dekking, rotatiehint in portret, safe-area-marges, geen pull-to-refresh, pinch-zoom, tekstselectie of contextmenu. Een X-knop sluit de inventaris en chat. Aim-assist bestaat niet (staat uit).

## Toegankelijkheid

Options > Accessibility Settings:

- Subtitles met richtingspijl (`[Zombie groans] <-`), Reduce Flashes, High Contrast, Colour-Blind Colours, Text Size 100-200%, GUI Scale.
- Reduced Motion (zet zichzelf aan bij `prefers-reduced-motion`): geen hurt-tilt, bobbing, landingsdip, recoil-kick, wapenzwaai, bladzwaai; minder particles. FOV Effects-schuif voor sprint, water en boog.
- Hold of Toggle voor sneak, sprint, attack en use. Een getoggelde sprint stopt als je stilstaat.
- Stick Curve en Menu Key Repeat (vertraging voor herhalende menutoetsen).
- `prefers-contrast` en `forced-colors` worden gerespecteerd; menu's zijn `role=dialog` met naam, knoppen zijn echte `<button>`s met focusring, chat, toasts, ondertitels en spelstatus (pauze, dood, controller) gaan via aria-live.

Voor ontwikkelaars: gebruik `limitFlash(intensiteit, settings)` en `FlashLimiter.allow(tijd, settings)` (`src/core/Accessibility.ts`) voor bliksem of andere schermflitsen, en `Game.caption(label, x, z)` voor ondertitels.

## Testen

`python3 scripts/e2e_controls.py [touch|pad|a11y|all] [uitmap] [poort]` (Vite dev-server zonder HMR; zie CLAUDE.md). Touch gebruikt mobiele emulatie met echte aanraakevents via CDP, de gamepad een mock van `navigator.getGamepads`. Pure logica: `tests/inputMath.test.ts`, `tests/accessibility.test.ts`, `tests/settings.test.ts`.
