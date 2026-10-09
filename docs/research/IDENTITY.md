# Eigen identiteit: van Minecraft-kloon naar arenashooter

Ontwerpdocument (oktober 2026). Stijn heeft besloten dat BunkCraft geen Minecraft-kloon meer is, maar een online multiplayer-shooter met een eigen karakter. De shootermodi (12 modi, 17 maps, progressie, bots, quick play) zijn de voordeur. Survival gaat voorlopig opzij: het blijft werken, maar zit achter een kleinere deur en krijgt later een eigen twist.

Dit document legt vast hoe het spel er nu uitziet en waarom. De code staat in `src/ui/Brand.ts` (kleuren, embleem, woordmerk), `src/ui/shell.css` (de menu-look), `src/ui/HomeScreen.ts` (de voordeur) en `src/ui/RealmsMenu.ts` (de flows achter de voordeur). Screenshots staan in [`docs/screenshots/identity/`](../screenshots/identity/) (eerste versie) en [`docs/screenshots/bunkhosting/`](../screenshots/bunkhosting/) (Bunkhosting-stijl).

## Naam en tagline

We houden **BunkCraft**. De naam is al bekend bij de spelers, de URL's en de PWA-installaties gebruiken hem, en "bunk" past bij bunker en shooter. "Craft" verwijst naar de voxels en de bouwmodus, dus de naam blijft kloppen nu survival een bijrol krijgt. Een nieuwe naam levert pas iets op als er ook een marketingmoment bij hoort, en dat is er nu niet.

Alternatieven die we bekeken hebben, voor als er later toch een rebrand komt:

| Naam | Waarom wel | Waarom niet |
|---|---|---|
| **Bunkr** | Kort, past bij een domein en een app-icoon | Lijkt op bestaande merken met dezelfde spelling |
| **Blockfire** | Zegt meteen wat het is: blokken en schieten | Generiek, en lastig als zoekterm |
| **Voxel Ops** | Klinkt als een shooter | Te dicht bij militaire shooter-titels |
| **Frag Block** | Speels, past bij de toon | Voelt als een tijdelijke werktitel |

Taglines, met de gekozen versie bovenaan:

- **Voxel arena shooter** / **Voxel-arenashooter.** Staat onder het woordmerk en in de social preview. Beschrijvend, zodat iemand die de link krijgt meteen weet wat het is.
- **Drop in. Frag out.** Voor een trailer of store-pagina, niet in de UI.
- **Pak je loadout. Kies je modus. Gaan.** Nederlandse variant voor posts.

## Visuele identiteit

> **Eerste versie.** Kleur, typografie, vorm en logo in deze sectie beschrijven de eerste uitwerking (volt). Ze zijn vervangen door [Bunkhosting-stijl](#bunkhosting-stijl) hieronder; wat we niet willen (Minecraft, Call of Duty, Krunker) en de redenering blijven staan.

Het uitgangspunt: een strakke, moderne game-UI die niets van Minecraft overneemt (geen stenen knoppen, geen dirt-achtergrond, geen pixel-logo met extrusie) en ook niet lijkt op Call of Duty (zwart met oranje en militaire stencils) of Krunker (felle cartoonkleuren). Het voxel-karakter zit in de wereld zelf en in het embleem, niet in de knoppen.

### Kleur

| Token | Waarde | Gebruik |
|---|---|---|
| `ink0` | `#07090d` | Diepste achtergrond, tekst op volt |
| `ink1` | `#0e1218` | Panelen, icoontegel |
| `ink2` / `ink3` | `#161c25` / `#232b37` | Verhoogde vlakken, gloed |
| `text` | `#eef2f6` | Gewone tekst |
| `dim` | `#9aa6b5` | Secundaire tekst (contrast ruim 7:1 op ink) |
| **`volt`** | **`#d4ff3a`** | Het enige echte accent: PLAY, XP-balk, focusring, live tellers, actieve keuze |
| `cyan` | `#4ad8ff` | Info, het bèta-label |
| `danger` | `#ff6b6f` | Fouten, vergrendeld |

Eén accentkleur, bewust. Volt (limoengeel) valt op tegen de blauwe lucht en het grijs van de maps, en geen bekende shooter gebruikt hem als hoofdkleur. Omdat alles wat telt volt is, weet een speler zonder te lezen waar hij moet klikken. Rood en blauw blijven voorbehouden aan de teams. Inktzwart met een vleugje blauw in plaats van puur zwart houdt de panelen rustig boven de 3D-achtergrond.

### Typografie

- **Woordmerk:** eigen letters, geen font. Vierkante letters met afgeschuinde hoeken van 45 graden, zwaar, licht schuin naar voren (`wordmarkSvg()` in `Brand.ts`). BUNK in wit, CRAFT in volt.
- **UI-tekst:** de systeem-sans (SF Pro, Segoe UI, Roboto). Titels in heavy italic hoofdletters, labels in kleine hoofdletters met wat extra letterafstand, getallen met `tabular-nums`.
- **Pixelfont (OFL):** blijft voor de in-game HUD en de survival-menu's. In de shell gebruiken we hem niet meer, omdat hij het sterkst naar Minecraft verwijst.

Een eigen display-font (bijvoorbeeld een OFL-font als Chakra Petch of Saira Condensed, lokaal gebundeld) is nog niet toegevoegd. Daarvoor moet een fontbestand gedownload en gecontroleerd worden, en dat is een keuze voor Stijn. De systeem-sans is nu een bewuste keuze: scherp op elk scherm, nul kilobyte extra. Het verschil per besturingssysteem is klein omdat de vorm vooral uit gewicht, italic en hoofdletters komt.

### Vorm en beweging

- **Afgeschuinde hoek** als terugkerend motief: de PLAY-knop heeft twee gesneden hoeken, de geselecteerde modus een volt hoekje. Het verwijst naar bunker- en hardware-vormen zonder militair te worden.
- **Hazard-streepjes** in de PLAY-knop en in de social preview.
- Panelen met 1 px rand, lichte transparantie en blur, zodat de map erdoorheen blijft leven.
- Weinig animatie: hover is een kleurwissel, de XP-balk loopt op. Met reduced motion staat alles stil.

### Logo-concept

Het embleem is een isometrische voxel in drie tinten volt met een vizier in inkt op de voorste hoek: **een blok in het vizier**. Het zegt in één beeld "voxels" en "schieten" en werkt van 16 px (favicon) tot 512 px. Het woordmerk staat ernaast. Alles is in code getekend (SVG), zonder assets van derden. Favicon, PWA-iconen, apple-touch-icon en de social preview worden met `npx tsx scripts/make-icons.ts` uit dezelfde bron gemaakt.

### Toon

Kort, direct en vriendelijk: "Play", "Speel met vrienden", "Open lobby". Geen militaire taal, geen grootspraak. Spelers spreken we aan met "je". Foutmeldingen zeggen wat er mis is en wat je kunt doen.

## Bunkhosting-stijl

Stijn is eigenaar van Bunkhosting (https://bunkhosting.nl; het spel draait op craft.bunkhosting.nl) en wil dat de menu's meer in de huisstijl van Bunkhosting staan. Dit is zijn eigen merk, dus de stijl wordt bewust overgenomen. Sinds oktober 2026 gelden de waarden hieronder voor de hele shell (home, arenamenu's, lobby en party, einde wedstrijd, instellingen, pauzemenu in de arena, laadscherm). De eerste versie (volt, schuine italic titels, afgeschuinde PLAY-knop) staat hierboven en is vervangen. Wat we níet willen (Minecraft, Call of Duty, Krunker) blijft staan.

Bron: de HTML en `/assets/site.css` van bunkhosting.nl (Tailwind, bekeken op 9 oktober 2026). Screenshots van de site en vergelijkingen: [`docs/screenshots/bunkhosting/`](../screenshots/bunkhosting/) (`site/`, `before/`, `after/`, `compare-*.jpg`).

### Wat de site doet

- **Donker.** `<html class="dark">`, `theme-color` `#111318`. Er is geen lichte variant. Houtskoolblauw (niet zwart), met een stippenraster van 32 px (`radial-gradient(rgba(0,219,231,.12) 1px, transparent 0)`) en twee grote, vervaagde gloeden: blauw rechtsboven, cyaan linksonder.
- **Merk.** Cyaan `#00dbe7` is het accent, `#006af2` het merkblauw. Primaire knoppen en het woord "VPS" in de kop lopen van blauw naar teal of cyaan.
- **Logo.** Een Material-icoon (`dns`, twee gestapelde serverbalken) in cyaan, naast "BUNK HOSTING": Manrope 800, hoofdletters, `tracking-tighter` (-0.05em). Favicon: een cyaan "B" op een `#111318` tegel met 6/32 afronding.
- **Lettertypes.** Manrope (400/600/700/800) voor koppen en het woordmerk, Inter (400-700) voor lopende tekst. Beide OFL, via Google Fonts. Mono (`ui-monospace`) voor de terminal. Koppen staan in gewone hoofd- en kleine letters ("Kies je VPS-pakket"), niet in kapitalen. Kapitalen zijn voor kleine labels: 10-12 px, bold, `tracking-widest` (0.1-0.3em), in cyaan of gedempt grijs ("DIRECTE ACTIVATIE", "GEEN CONTRACTEN • MAANDELIJKS OPZEGBAAR").
- **Vorm.** Heel kleine radii: knoppen en invoer 2 px (`.rounded`), kaarten 4 px (`rounded-lg`), de terminal 8 px (`rounded-xl`), badges pillen (`rounded-full`). Randen zijn 1 px `outline-variant` op 10-30% dekking; de aanbevolen kaart heeft 2 px cyaan.
- **Knoppen.** Primair: gradient `#006af2` naar `#007e85`, witte bold tekst, `shadow-lg` in blauw (20%). Hover: `brightness(1.15)` en `0 4px 24px rgba(0,219,231,.28)`; actief `scale(.97)`. Secundair: vlak `#1e2024`, rand `outline-variant/20`, hover-rand cyaan 35%. Geen kapitalen, geen iconen in de knop.
- **Kaarten.** `#1e2024` met 1 px rand, 32 px padding, 32 px tussenruimte. Hover: rand cyaan 20% plus `0 8px 32px rgba(0,219,231,.1)` en 4 px omhoog (`card-glow`). Iconen staan in een vierkante tegel (`#282a2e`, 40 px, 4 px radius).
- **Toon.** Nederlands, "je", direct en concreet, geen grootspraak: "Binnen twee minuten online", "Geen contracten", "Direct Bestellen", "Start je VPS". Dat sluit aan bij de bestaande toon van het spel ("Speel met vrienden", "Open lobby").

### Kleurtokens

| Bunkhosting-naam | Waarde | Token in de shell | Gebruik in BunkCraft |
|---|---|---|---|
| `surface-container-lowest` | `#0c0e12` | `--bc-ink0` | Invoervelden, tekst op accent |
| `surface` | `#111318` | `--bc-ink1` | Basis van schermen, scrim, laadscherm |
| `surface-container` | `#1e2024` | `--bc-ink2` (panelen: `--bc-panel`, 82% + blur) | Panelen en kaarten |
| `surface-container-high` | `#282a2e` | `--bc-ink3` (hover: `--bc-ink4` `#33353a`) | Knoppen, modus-kaarten, balken |
| `on-surface` | `#e2e2e8` | `--bc-text` | Tekst |
| `on-surface-variant` | `#c2c6d8` op 80% | `--bc-dim` `#a3a7b9` | Secundaire tekst (7,8:1 op `#111318`) |
| `tertiary` | **`#00dbe7`** | `--bc-accent` | Het accent: focusring, XP, live tellers, gekozen modus, labels |
| `tertiary-container` | `#007e85` | `--bc-accent-dark` | Einde van de knopgradient |
| `primary-container` | **`#006af2`** | `--bc-blue-brand` | Begin van gradients (PLAY, primaire knoppen, XP-balken, "CRAFT") |
| `primary` | `#b0c6ff` | `--bc-info` | Info-tekst, codes, bèta-label |
| `error` | `#ffb4ab` | `--bc-danger` | Fouten en vergrendeld |
| `outline-variant` / `outline` | `#424656` / `#8c90a1` | `--bc-line` (70%) / `--bc-line-strong` (50%) | Randen |
| `on-tertiary` | `#00363a` | `--bc-on-accent` | Tekst op cyaan vlak |

Teamkleuren (rood `#ff5a4f`, blauw `#4a9dff`) blijven spelinhoud en veranderen niet. `Brand.ts` (`BRAND`) en het `:root`-blok in `shell.css` bevatten dezelfde waarden; wie de shell opnieuw wil stylen past alleen die twee aan.

Gradients: knop `linear-gradient(90deg, #006af2, #007e85)` (`--bc-grad-btn`), tekst en balken `linear-gradient(90deg, #006af2, #00dbe7)` (`--bc-grad-text`).

### Contrast (WCAG AA)

| Combinatie | Verhouding |
|---|---|
| Tekst `#e2e2e8` op `#111318` / op `#1e2024` | 14,4:1 / 12,6:1 |
| Gedempt `#a3a7b9` op `#111318` / `#1e2024` / `#282a2e` | 7,8:1 / 6,8:1 / 6,0:1 |
| Accent `#00dbe7` op `#111318` / `#1e2024` / `#282a2e` | 10,9:1 / 9,5:1 / 8,4:1 |
| Wit op `#006af2` (begin knop) / `#007e85` (einde knop) | 4,8:1 / 4,9:1 |
| `#00363a` op `#00dbe7` | 7,7:1 |
| Info `#b0c6ff` op `#111318` | 10,9:1 |
| Fout `#ffb4ab` op `#111318` | 10,9:1 |
| `#006af2` op `#111318` (alleen grote titel "CRAFT", verloopt naar cyaan) | 3,8:1 (grote tekst: 3:1 nodig) |

Daarom staat de kleine tekst op de PLAY-knop in volledig wit (geen 70% dekking) en is `#006af2` nooit tekstkleur voor kleine tekst.

### Typografie in de shell

- `--bc-font-head`: Manrope 800 voor titels, de PLAY-knop, paneelkoppen, spelersnamen en scores. Gewone hoofdletters, `letter-spacing` -0.01 tot -0.05em.
- `--bc-font`: Inter voor knoppen (700, geen kapitalen), invoer en lopende tekst.
- Kleine labels (eyebrows, kolomkoppen, taglines): Inter 700, kapitalen, 0.1-0.16em.
- Het woordmerk is nu tekst (BUNK in wit, CRAFT in de blauw-naar-cyaan-gradient) in plaats van getekende letters. Het embleem (voxel met vizier) blijft, nu in drie cyaan-tinten (`#00dbe7`, `#00a9b3`, `#007e85`), op een `#111318` tegel voor de iconen. De tagline is de "Directe activatie"-badge van de site: een pil met bliksem.
- Fonts staan lokaal in `public/fonts/` (`manrope-var-latin.woff2` 24 kB, `inter-var-latin.woff2` 48 kB, variabele latin-subset, OFL, licentie in `LICENSE-OFL-inter-manrope.txt`). Er is geen font-CDN tijdens runtime; de CSP (`style-src`/`font-src 'self'`) blijft gelijk. In productie krijgen beide een `preload`. Het pixelfont blijft voor de HUD en de survival-menu's.

### Wat er veranderd is in de componenten

| Onderdeel | Voor | Na |
|---|---|---|
| PLAY | Limoen, afgeschuinde hoeken, hazardstreepjes, italic | Gradient blauw naar teal, 4 px radius, blauwe gloed, stippenraster rechts, "Play" in Manrope 800 |
| Knoppen | Doorzichtig wit, kapitalen met letterafstand | `#282a2e` met cool-grijze rand, 700 normaal, rand wordt cyaan bij hover; primair = gradient |
| Kaarten en panelen | Wit 5-10% | `#1e2024` 82% + blur, 4 px (kaart) of 8 px (paneel) radius, cyaan gloed bij hover |
| Gekozen modus, lobby, loadout | Limoen rand + hoekje | Cyaan rand van 1 px plus ring en zachte gloed (de "Meest populair"-kaart van de site) |
| Titels | Italic heavy kapitalen met schuine balk | Manrope 800, gewone letters, kleine verticale blauw-naar-cyaan balk |
| Achtergrond | Donkere scrim | Charcoal scrim met het stippenraster en de blauwe en cyaan gloed |
| Balken (XP, stemmen, laden) | Effen limoen | Pil met gradient blauw naar cyaan |
| Voettekst | Alleen spelinfo | Extra regel "A game by BUNK HOSTING" (link naar bunkhosting.nl, `rel="noopener noreferrer"`) |

Bewust niet overgenomen: de 4 px optilbeweging van `card-glow` (in menu's met toetsenbord- en controllernavigatie springt de lay-out anders) en de zwevende/pulserende animaties. Hover is een kleur- en gloedwissel. Hoog contrast en `forced-colors` hebben eigen regels onderaan `shell.css`: PLAY en primaire knoppen worden zwart met witte tekst en cyaan rand, de gradient-tekst valt terug op een effen kleur. Toetsenbord, controller, NL/EN en de GUI-schaal werken zoals voorheen.

Niet aangepast: de survival-menu's, inventories, de survival-HUD, de rangbadges en de calling cards van het profiel (spelinhoud, eigen kleuren). In de arena-HUD blijven de scorebalk, gezondheid, munitie, killfeed en wapenslots in het pixelfont; alles wat iets aankondigt (zie hieronder) is wel omgezet.

### Logo's en banners

Dezelfde typografie als de menu's, op alles wat een naam of aankondiging draagt. De tokens staan op één plek: het `:root`-blok bovenaan `shell.css` (`--bc-banner-xl/l/m/s`, `--bc-hud-t/xs`, `--bc-halo`, `--bc-plate`) en `BRAND` in `Brand.ts`.

| Soort | Stijl |
|---|---|
| Logo's (home, laadscherm, favicon, PWA-iconen, social preview, startfoutscherm) | Embleem plus woordmerk in Manrope 800 hoofdletters, `-0.05em`; BUNK wit, CRAFT blauw naar cyaan. De iconen bevatten alleen het embleem, de social preview bevat tekst en stond al in Manrope. Het startfoutscherm (`fail()` in `main.ts`) gebruikt nu hetzelfde woordmerk. |
| Tekst direct op de wereld (fasebanner "Ronde 3 begint over 5", 3-2-1, "Fight!", medailles, doodscherm, wereldmarkeringen) | Manrope 800 met een donkere halo (`--bc-halo`), geen vlak erachter. Korte banners (cijfers, "Fight!") krijgen het grote formaat in de accentkleur. Medailles houden hun speleigen kleur (goud voor reeksen, oranje voor killstreaks). |
| Aankondigingen met een zin of teamkleur (vlag genomen, zone veroverd, bomhandelingen, level-up van gun game, kill confirmed) | Plaat (`--bc-plate`, 82% inkt plus blur), 1 px rand, 4 px radius, Manrope 800. De teamkleur (of het accent bij neutrale events) is de linkerrand en een lichte tint in de plaat; de tekst blijft `--bc-text`, dus ook rood en blauw blijven leesbaar. |
| Objectivepaneel (rondepips, rol, bomlont, gun game-ladder, besmet) | Dezelfde platen met Inter 700 en Manrope 800 voor de getallen. |
| Tab-scoreboard, einde wedstrijd, XP-rapport (level-up, unlocks), kaartstem | Het paneel en de rijen van de shell: kolomkoppen in kleine hoofdletters, "ROOD 13 - 2 BLAUW" in Manrope 800. |
| Create-a-Class in de wedstrijd | Shell-look (chips, kolommen, statistiekbalken in de gradient), titel in Manrope. |
| Systeemmeldingen ("Screenshot saved", update-toast, controller verbonden) | Paneel met Inter 700 en shell-knoppen. |

Leesbaarheid: de kleinste banner (event-plaat) is 30 px op 720p (GUI-schaal 3), de regels in het objectivepaneel 19,5 px, op een telefoon minstens 16 en 13 px; alles schaalt mee met de GUI-schaal en de tekstgrootte (`--u`, `--ts`); ze staan absoluut gepositioneerd, dus een andere tekst verschuift niets. Hoog contrast geeft de platen zwart met witte rand. Screenshots voor en na staan in [`docs/screenshots/bunkhosting/banners/`](../screenshots/bunkhosting/banners/) (`before/`, `after/`, `after/nl/`, `after/ui/`), gemaakt met `scripts/banner-shots.py`.

## Wat er verandert in de front-end

| Voor | Na | Waarom |
|---|---|---|
| Titelscherm in Minecraft 1.21-stijl met Singleplayer, Multiplayer en BunkCraft Realms | **Home**: grote PLAY (quick play in de laatst gekozen modus), de playlist met live spelers, lobby's, privéwedstrijd, spelen met code, profielkaart met level en XP-balk, dagelijkse uitdagingen, loadouts, wapenkamer, statistieken, instellingen en taal | De shooter is het spel. Eén klik naar een wedstrijd. |
| Achtergrond: panorama boven survival-terrein | Live vlucht over een arenamap, per bezoek een andere (`MENU_MAPS` in `Game.ts`, de naam staat rechtsonder) | Je ziet meteen waar je gaat spelen |
| "BunkCraft Realms" als aparte hub | Opgegaan in de home. In de UI heet het gewoon spelen, playlist, lobby's en privéwedstrijd | Het is geen bijzaak meer, dus een eigen merknaam voegt niets toe |
| Singleplayer en Multiplayer op het titelscherm | Achter **Bouwen & Survival (bèta)** linksonder | Survival werkt nog, maar is niet meer de voordeur |
| Sub-menu's, instellingen, lobby en einde wedstrijd in Minecraft-stijl | In de shell-look | Eén look voor alles rond de shooter |

Wat bewust hetzelfde blijft: de survival-menu's (wereldlijst, wereld maken, pauzemenu in survival, inventory, doodscherm) en de in-game HUD. Die krijgen een eigen ronde als survival zijn twist krijgt.

**Compatibiliteit.** Intern heet alles nog Realms: `RealmsMenu`, `/api/realms`, `/api/quickplay`, het protocol en de localStorage-sleutels. Invite-links (`?join=CODE`) werken zoals voorheen: een arenalobby opent op de home, vraagt zo nodig een naam en joint, een survival-code opent Multiplayer.

**Toegankelijkheid.** PLAY is het eerste focusbare element, dus pijltjes, Tab en een controller (MenuNav) landen daar. De modus-kaarten zijn knoppen met `aria-pressed`, de statusregel is een live region, icoonknoppen hebben een label. Focus is overal één volt ring. Hoog contrast en forced colors hebben eigen regels in `shell.css`. De GUI-schaal en tekstgrootte uit de instellingen werken ook in de shell.

## Open punten

- **Multiplayer-sandboxmenu's** (Create Game, Direct Connect, Browse Games) zijn nog alleen Engels. Ze vallen onder survival, dus die laten we tot de survival-ronde.
- **Loadouts aanpassen buiten een wedstrijd.** Het Loadouts-scherm kiest de klasse voor de volgende wedstrijd. Een eigen klasse bouwen kan alleen in de wedstrijd (Create-a-Class), omdat die editor nu aan de HUD vastzit.
- **Survival-twist.** Ideeën staan in `docs/ROADMAP.md`.
