# Eigen identiteit: van Minecraft-kloon naar arenashooter

Ontwerpdocument (oktober 2026). Stijn heeft besloten dat BunkCraft geen Minecraft-kloon meer is, maar een online multiplayer-shooter met een eigen karakter. De shootermodi (12 modi, 17 maps, progressie, bots, quick play) zijn de voordeur. Survival gaat voorlopig opzij: het blijft werken, maar zit achter een kleinere deur en krijgt later een eigen twist.

Dit document legt vast hoe het spel er nu uitziet en waarom. De code staat in `src/ui/Brand.ts` (kleuren, embleem, woordmerk), `src/ui/shell.css` (de menu-look), `src/ui/HomeScreen.ts` (de voordeur) en `src/ui/RealmsMenu.ts` (de flows achter de voordeur). Screenshots staan in [`docs/screenshots/identity/`](../screenshots/identity/).

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

- **Eigen display-font.** Zie typografie: nog niet gebundeld.
- **Multiplayer-sandboxmenu's** (Create Game, Direct Connect, Browse Games) zijn nog alleen Engels. Ze vallen onder survival, dus die laten we tot de survival-ronde.
- **Loadouts aanpassen buiten een wedstrijd.** Het Loadouts-scherm kiest de klasse voor de volgende wedstrijd. Een eigen klasse bouwen kan alleen in de wedstrijd (Create-a-Class), omdat die editor nu aan de HUD vastzit.
- **Survival-twist.** Ideeën staan in `docs/ROADMAP.md`.
