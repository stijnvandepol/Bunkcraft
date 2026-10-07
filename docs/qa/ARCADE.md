# QA: arcade-modes speeltest

## Ronde 3a: spelen als een speler, wapens, one-hit kills (oktober 2026)

Aanleiding: Stijn vond na zelf spelen "nog te veel bugs" (de klasse uit de warm-up werkte pas na je volgende dood, en de
eerdere QA zag dat niet omdat die interne state porde). Deze ronde is gespeeld zoals een speler speelt: de **productiebuild**
(`npm run build`, `node dist-server/index.js`, eigen poort, `ROOM_CREATE_LIMIT=1000`), Chromium (`--use-angle=metal`) **en**
WebKit, alleen echte invoer (klikken, toetsen B, Tab, Esc, 1-8, R, rechtermuis, Shift) en alleen wat de pagina laat zien
(DOM-tekst, screenshots). Productie heeft geen `window.game`. Headless browsers hebben geen Pointer Lock: `scripts/qa/human.ts`
emuleert die zoals Chrome en Safari doen (een gebaar nodig, Esc wordt door de browser opgegeten en geeft de muis vrij, binnen 1 s
na Esc opnieuw vergrendelen wordt geweigerd, focusverlies geeft vrij). De code van het spel blijft daarbij ongewijzigd.

### Wat er getest is

| Onderdeel | Script | Resultaat |
|---|---|---|
| Klasse kiezen in elke fase | `r3-classes.ts` (Chromium en WebKit), 3 protocolbots maken de match live en schieten je dood | warm-up, live vlak na spawn, live midden in je leven (pas volgend leven), doodscherm met cijfertoets en met B, na respawn: 10/10 in beide browsers |
| Tussen rondes (Elimination), na de kaartstemming | `r3-modes.ts elim vote` | klasse tussen de rondes zit in je handen bij de volgende ronde; na stemmen (toets 2) laadt de gekozen kaart, klasse en lobby blijven |
| Privélobby, joinen met code (Safari), met link, lobby's bekijken, weggaan en terugkomen | `r3-flows.ts private browse leave` | code + link, voorbeeldregel bij het typen (kleine letters, streepje), alle drie in één lobby, link verdwijnt uit de adresbalk, CTF-panelen live, terug naar de playlist; dubbelklik in Lobby's bekijken; terugkomen in dezelfde lobby met dezelfde klasse, geen spookspeler |
| Taal NL in een match, venstergroottes, tabwissel, Esc + direct terug, instellingen | `r3-flows.ts lang resize focus settings` | zie bugs 3, 4, 7; FOV-slider werkt in de match |
| Elk wapen × elke optiek in de hand | `r3-weapons.ts` (Chromium, WebKit voor scope/combat) | 33/33 combinaties: HUD-naam klopt, heup/ADS/schot/herladen als screenshot |
| Modes met bots | `r3-modes.ts gungame ctf hardpoint domination` | live, dood, Tab, geen page errors; zie bugs 6, 8, 9 |
| Server herstart midden in een match | `r3-restart.ts` | "Reconnecting automatically", zelfde lobby, zelfde klasse, zonder klikken |
| Terugkerende speler na een update | `r3-returning.ts` (persistent profiel met service worker, oude/kapotte localStorage) | nieuwe build laadt, update-toast verschijnt, kapotte opgeslagen klasse valt terug op geldige uitrusting |
| Shotgun en sniper voor/na | `r3-gunfeel.ts` (de servercode zelf: `rayPlayer`, `spreadDirection`, `pelletPattern`, `damageAt`) | zie wapenoordeel |

### Gerepareerd (met regressietest die faalt zonder de fix)

1. **Create-a-Class: de editor bleef je oude Custom-klasse tonen na een preset-klik** (je kiest Breacher, de kolommen zeggen nog
   Assault Rifle: de keuze lijkt niets te doen). Repro: B → klik "3 Breacher". De editor toont nu de gekozen klasse en aanpassen
   begint vanaf die klasse. Ook **schenen de chatregels door het menu**, en de regel onderaan zei altijd "Applies at once right
   after spawning, else from your next life". Die regel volgt nu de serverregel (`classApplies`, één bron voor client en server):
   "Applies now" / "Je zit in een gevecht: geldt vanaf je volgende leven" / "Geldt zodra je respawnt", en loopt mee met de klok.
   e2e: `realms-classes.spec.ts`; unit: `arcadeClasses.test.ts`. Shots: `r3-cac-before.jpg`, `r3-cac-after.jpg`.
2. **Realms: 429 Too Many Requests voor een huishouden.** Drie browsers achter één adres met de playlist open (LAN-party, gezin)
   kregen 429 op de spelersaantallen en een fout in Lobby's bekijken (30 lijstverzoeken/min per adres, de playlist pollde elke 5 s,
   ook onder andere schermen). Nu 120/min (lijsten zijn 5 s gecachet) en de playlist pollt elke 10 s, alleen als hij bovenaan staat
   in een zichtbare tab. Test: `realms.it.test.ts`.
3. **Taal wisselen in een match liet de HUD Engels** ("HEALTH", lobbypaneel, stempaneel, het hele Create-a-Class-menu) tot de
   volgende match; de chatregels bij het joinen (mode-uitleg, spelcode) waren altijd Engels; "Click to play" ook. Alles wordt nu
   opnieuw getekend bij een taalwissel. In het Nederlands liep "GEZONDHEID" tegen het getal aan ("GEZONDHEID100").
   e2e: `realms-classes.spec.ts`. Shots: `r3-nl-health-before.jpg`, `r3-nl-hud-after.jpg`.
4. **Hardpoint: "Hill moves in 0" in de warm-up** (de server heeft dan nog geen heuveltimer). De regel staat er nu alleen als de
   ronde live is. e2e: `realms-classes.spec.ts`. Shot: `r3-hill-0-wall-before.jpg`.
5. **216 spawns keken tegen een muur op 1-4 blokken** (richting het midden, maar met een hut of krat ervoor): elk leven begon met
   "waar ben ik?". Een spawn draait nu tot 75° van het midden af naar het meest open zicht, over alle dekkingsvarianten. Over: de
   vier teamspawns in de kamers van Bunker (3 blokken). Test: `spawnFacing.test.ts`, audit: `scripts/qa/spawn-facing.ts`.
6. **Killfeed over de score** (1280×720: een lange regel bedekte de blauwe score) en **tussen Elimination-rondes stapelden banner,
   rondetoast, spawn-protection-label en lobbypaneel op elkaar**; daarna liep in het midden de chat door het label. Killfeed blijft
   nu rechts van de scorebalk (lange regel breekt af), het protection-label staat onderaan in het midden. e2e: `arcade-hud.spec.ts`.
   Shots: `r3-feed-over-score-before.jpg`, `r3-protect-over-chat-before.jpg`, `r3-elim-roundend-after.jpg`.
7. **Eindscherm met kaartstemming sneed de onderste rijen af**: in een lobby van zes zag de laatste speler zijn eigen regel niet
   (en bij 12 spelers de helft). De borden laten nu de laagste rijen vallen (nooit de jouwe) met "... en nog N" en passen opnieuw
   als de stemming binnenkomt of het venster verandert. Ook het Tab-bord. e2e: `arcade-hud.spec.ts`. Shot: `r3-vote-own-row-before.jpg`.
8. **Objectmarkers ("CAPTURE 44m") over het Tab-scorebord.** Verborgen zolang het bord open is. e2e. Shot: `r3-marker-over-board-before.jpg`.
9. **Gun game: "2 Knife 3 Knife"** (de modus geeft het mes ook als secundair). Eén messlot. e2e. Shots: `r3-gungame-two-knives-before.jpg`,
   `r3-gungame-after.jpg`.
10. **Safari: "Click to play" flitste na het sluiten van een menu.** Safari's `requestPointerLock` geeft geen promise terug en
    vergrendelt een moment later; het spel besloot meteen "niet vergrendeld", zette de wereld op pauze en toonde het
    klik-scherm voor een frame. `requestLock` wacht nu op het lock- of error-event (max. 250 ms). e2e met Safari-gedrag.
11. **Quick play stuurde iedereen naar "Game not found"** als de bestanden van een publieke lobby weg waren (met de hand gewist,
    backup teruggezet): de lobby bleef in de lijst. Gevonden toen twee QA-servers een datamap deelden. Test: `realms.test.ts`.
12. **Herladen:** een herlading eindigde op de client pas als de server het bevestigde (een halve ronde ná de animatie: zichtbaar
    wachten), en een herlaadverzoek in de 0,25 s na een wapenwissel weigerde de server terwijl de client de animatie speelde
    (tellers liepen uit elkaar). Nu eindigt de client op zijn eigen klok met dezelfde `reloadTimeFor`, accepteert de server een
    schot tot 0,1 s vóór zijn timer, en vraagt de client niet te vroeg. Test: `match.test.ts`.
13. **De camerakick lag niet in het richtpunt**: tijdens een rifle-spray stond het richtkruis ~1,2° boven waar de kogels gingen, en
    vlak na een DMR-schot stond de scope 0,2° te hoog. Tijdens het richten geen camerakick meer, vanaf de heup weinig bij automaten
    (`viewKick`). Test: `arcadeFeel.test.ts`.

### Wapens: voor → na

`r3-gunfeel.ts`, richtfout σ 0,6° (een goede speler), 4000 schoten per cel, kans dat **één schot doodt**:

| Shotgun (heup) | 3 m | 5 m | 7 m | 9 m | 11 m |
|---|---|---|---|---|---|
| voor (10 × 13, willekeurige kegel 4,5°) | 100% | 91% | 44% | 12% | 0% |
| na (8 × 18, vast patroon 3,2°) | 100% | 100% | 99% | 86% | 31% |

| Bolt-Action Sniper (gericht) | 15 m | 30 m | 50 m | 70 m | 90 m |
|---|---|---|---|---|---|
| voor (85 schade, alleen headshot doodt) | 3% | 10% | 8% | 6% | 3% |
| na (100 schade tot 70 m) | 95% | 65% | 38% | 25% | 4% |

(Bij σ 1,2° doodt de nieuwe shotgun op 7 m nog in 84%, de oude in 38%. De sniper-percentages zijn gewoon de trefkans: elk lichaamsschot tot 70 m is een kill.)

| Wapen | Voor | Na |
|---|---|---|
| Shotgun | Willekeurige kegel: op 7 m doodde een gecentreerde pomp in 44% van de gevallen, "pellets in de lucht". Pomp 0,86 s | Vast hagelpatroon (midden, binnenring, buitenring, per schot gedraaid), één pomp doodt tot ~8 m, pomp 0,75 s, zwaardere kick |
| Bolt-Action Sniper | Alleen een headshot doodde; 0,42 s richten; scope zwaaide meteen 0,32°: een hoofd op 40 m (0,57°) was een gok | Eén bodyshot doodt tot 70 m; 0,3 s richten; de eerste ~0,45 s in de scope 20% sway (quickscope), daarna in ~1 s de volle (0,24°); geen camerakick tijdens richten |
| Semi-Auto Sniper | Twee bodyshots, geen one-shot headshot | Twee bodyshots **of één headshot** op elke afstand (×1,85) |
| DMR | Drie schoten tot 60 m | Drie schoten tot 90 m: de lange-afstandskoning naast de semi |
| Revolver | Twee treffers | Eén headshot doodt tot 30 m (was al zo, nu benoemd), sneller herladen |
| Mes | Twee steken | **Eén steek** |
| Alle wapens | Herladen 1,1-4,2 s, altijd even lang | ~20% sneller (rifle 1,3 s, pistol 0,95 s, LMG 3,4 s blijft het traagst, dan de grendel-snipers), tactisch herladen (kogels over) 75% |
| Nieuw: Battle Rifle | – | Zware automaat met combat scope, vier treffers tot 45 m, snelste op 60 m, 20 kogels, hard te beheersen |
| Nieuw: Lever-Action Carbine | – | Eén headshot doodt tot ~45 m, twee bodyshots, snel richten (0,24 s), trage hendel; wapen voor wie op het hoofd mikt |
| Nieuw: Anti-Materiel Rifle | – | Eén treffer doodt op elke afstand; traagst met richten (0,5 s), lopen (×0,85) en doorladen (2 s), 3 kogels, 6,3× scope |
| Nieuw: Combat Scope (2-2,5×) | – | Op rifle, burst, LMG, battle, DMR, semi-auto en lever; bredere lens, dunne vignet, oplichtende chevron, geen sway |
| Gun Game | Eindigde met burst, revolver, SMG, mes | Eindigt met one-hit wapens: shotgun, revolver, sniper, mes (één steek wint) |

Elk wapen houdt een niche (`arcadeBalance.test.ts`, bewust aangepast: one-shot kills tellen als niche, grendelwapens rekenen met 70%
van de richtfactor, het dominantie-criterium kijkt ook naar bodyshot-STK). Tabellen: `docs/GAMEMODES.md`, `npx tsx scripts/ttk-matrix.ts`.
Screenshots: `r3-cac-new-weapons.jpg`, `r3-combat-scope.jpg`, `r3-sniper-scope.jpg`, `r3-battle-rifle.jpg`, `r3-lever-carbine.jpg`, `r3-antimat.jpg`.

Hitregistratie, hitmarkers en het geluid van wapens/inslagen zijn van een andere agent; daar heb ik niets aan veranderd (de nieuwe
wapens hebben alleen een geluidsprofiel en herlaadstappen in `weaponSounds.ts` gekregen, naar het voorbeeld van de bestaande).

### Open (prioriteit)

1. **(Hoog, movement-agent)** De bewegingsvalidator corrigeert een eerlijke vlagdrager onder last: station, revolversnelheid,
   seed 1333, regel `wall`. Kwam boven toen de wapenlijst groeide (de seed-runs pakken een wapen per index); `anticheatMovement.test.ts`
   gebruikt nu de oude vaste lijst, de false positive zelf is niet opgelost.
2. **(Midden)** Een lege quick-play lobby vult zich sinds de merge met 8 serverbots: de e2e-suite zet `QUICKPLAY_BOTS=0`. Of de
   warm-up met bots goed voelt ("Wacht op spelers" verschijnt nooit), is niet als speler getest.
3. **(Midden)** Op 800×600 overlapt het spawn-protection-label het munitiepaneel, en het lobbypaneel de zonemarker; vanaf 1024 breed is
   alles vrij. Kleinere schaal of het lobbypaneel smaller maken.
4. **(Laag)** Serverteksten blijven Engels in het Nederlands: MOTD, "X joined the game", "Server restarting. Reconnecting
   automatically...", "Game not found".
5. **(Laag)** Het rode-stip/holo-venster is klein bij het richten (het huis staat ver van het oog); de pauzemenu-knoppen
   Advancements/Statistics/Copy Seed zijn in de arcade zinloos (grijs). De update-toast verschijnt ook midden in een match.
6. **(Laag)** "Back to Title Screen" op het disconnect-scherm na een Realms-match gaat naar de titel, niet naar de playlist.
7. **(Info)** De Lever-Action Carbine staat in het TTK-model laag (het model ziet alleen bodyshots en rekent grendelwapens met 70%
   richtfactor); zijn rol is de headshot. Speel hem met echte spelers voor er getuned wordt.
8. **(Info)** Echt richten met de hand tegen bots kon headless niet; het wapenoordeel steunt op de servercode met een richtfout-model
   (`r3-gunfeel.ts`) en op de screenshots van elk wapen in de hand.

Scripts ronde 3: `scripts/qa/human.ts` (helpers + Pointer-Lock-shim), `r3-classes.ts`, `r3-flows.ts`, `r3-modes.ts`, `r3-weapons.ts`,
`r3-restart.ts`, `r3-returning.ts`, `r3-gunfeel.ts`, `spawn-facing.ts`, `r3-explore.ts`.
Let op: de scratchpad van deze sessie wordt door meerdere agents gedeeld; gebruik een eigen submap voor `DATA_DIR`, logs en pid-bestanden.

## Ronde 3b: hit registration, hitmarkers, geluid (oktober 2026)

Melding van Stijn: "hit registration is vaag". Gemeten, oorzaken gevonden en gerepareerd (zie *Treffers en lag compensation* in
`docs/GAMEMODES.md`).

**Oorzaken (met meting):**
1. Terugspoelen te kort: de server spoelde ping/2 + interpolatie terug, het scherm loopt een volle ping + interpolatie achter.
   Een rennend doel (7,3 b/s) stond bij 150 ms 0,5-0,7 blok verder dan getekend. Nu stuurt de client de getekende servertick mee
   (`fire.rk`); gemeten afstand tussen getekend en getest doel: gem. 0,005-0,03 blok (was 0,2-0,3 in de simulatie).
2. Model en hitbox liepen uiteen: het model was 2,0 hoog, de hitbox 1,8 (bovenkant van het hoofd raakte niets, schouders
   telden als hoofd) en de armen (tot 0,5 opzij) vielen buiten de 0,6 brede doos. Nu model op 0,9 en hitboxen per modeldeel.
3. Spreiding was apart willekeurig op client en server: je tracer zei niets over de kogel. Nu met een gedeeld zaadje.
4. De cameraterugslag tilde het beeld (en het richtkruis) boven de kogelrichting; het richtkruis zakt nu mee, bij ADS geen camerakick.
5. Kleinere: een speler die terugkwam in beeld werd op zijn nieuwste positie getekend (vóór de interpolatie), een gerespawnde
   speler hield `deathTime` 20, glasscherven overschreven het richtpunt van de volgende hagelkorrels.

**Simulatie** (`npx tsx scripts/hitreg-sim.ts`: echte servercode, de echte snapshotklok, schieten op willekeurige punten van het
getekende model, 30 s per regel; miss% = schoten die op het scherm raak waren maar niet telden):

| beweging | ping ± jitter | voor | na |
|---|---|---|---|
| stil | 0 | 20,0% | 0,3% |
| strafen | 0 / 50±10 / 150±30 | 15,7% / 33,0% / 76,2% | 0,0% / 1,4% / 1,0% |
| springen | 50±10 / 150±30 | 33,0% / 79,5% | 1,4% / 1,4% |
| rennen | 50±10 / 150±30 | 29,2% / 70,8% | 0,3% / 0,3% |

Overgebleven missers: voeten in volle pas (de beendoos dekt ±80° zwaai niet helemaal). Regressietest: `tests/hitreg.test.ts`
(0/50/150 ms met jitter, strafen/springen/rennen/stil: hoogstens 3% missers op hoofd/romp/armen).

**Echte browsers** (`npx tsx scripts/qa/hitreg-browser.ts --rtt=… --jitter=…`: eigen server, lagproxy, QA-Vite, twee bots die in
het zicht strafen, een tweede Chromium die strafet en springt, de schutter zet het richtkruis op getekende modeldelen; geteld:
op het scherm raak, server zegt mis; schoten na een dodelijk schot tellen niet). Machine druk (andere agents), 90-120 s per run:

| ping ± jitter | voor (oude code, DMR) | na (nieuwe code) |
|---|---|---|
| 0 | 16% (7/44) | 8% (7/86) |
| 50 ± 10 | 15-19% | 9% (9/97) |
| 150 ± 30 | 43-55% | 10-12% (14/113) |

Let op: de "na"-runs schoten met de rifle (ADS-spreiding 0,4°; de DMR is sinds de Realms-voortgang pas vanaf level 4 te kiezen en
de client hield dat tegen), de "voor"-runs met de DMR (0,1°). Bij de nieuwe code stond het geteste doel steeds op 0,01 blok van
het getekende (`ARCADE_SHOT_DEBUG=1`); de resterende afkeuringen zijn dus spreiding op 20-45 blokken en voeten in volle pas,
geen lag. Open: de browsermeting overdoen met een spreidingsvrij wapen voor beide (DMR ontgrendelen of de claim op de
voorspelde kogel baseren) en langere runs.

**Hitmarkers:** alleen na serverbevestiging, X van vier balkjes met pop en fade, wit/goud/rood, schadegetallen als optie,
boven de scope, op het richtpunt. **Geluid:** inslagen per materiaal, langsfluitende kogels, ducking onder treffer/kill/schade,
hartslag bij lage health, punchier schoten met variatie, herlaadklop; captions voor de nieuwe geluiden. `audio-report.py` en
cheat-bots/modes-bots zijn na de laatste merge nog niet opnieuw gedraaid (usage-limiet).

**Kogels door glas:** gebouwd en getest (één raam of haag, 20%/10% minder schade, tweede raam stopt), maar staat UIT
(`GLASS_PASSES_DEFAULT`): de nieuwe kaarten schermen hun spawns af met glas en bladeren. Eerst die ramen dicht, dan aanzetten.

## Ronde 2: BunkCraft Realms, arsenaal, geluid, anti-cheat (oktober 2026)

Getest na de Realms-hub (snel spelen, lobby's bekijken, privélobby, lobbypaneel, kaartstemming), de nieuwe wapens en optieken,
Create-a-Class met perks, de geluidsronde en de anti-cheat. Echte Chromium (`--use-angle=metal`, M1 Pro) via de menu's, 2-3
browsers per test, aangevuld met protocolbots tot 12-16 spelers. Let op: de machine was druk (andere agents; load average
15-20, een tijd lang zelfs 150+), dus tijdmetingen zijn eerder te hoog dan te laag.

### Wat er getest is

| Onderdeel | Hoe | Resultaat |
|---|---|---|
| Snel spelen, elke mode | `realms-flow.py quickplay`: titel → Realms → mode kiezen → Snel spelen (A) en dubbelklik (B), bots tot 12 (tdm 16), live, Esc → Disconnect | 7/7 modes: zelfde lobby, juiste mode, lobbypaneel met mode/kaart/"Wacht op spelers (1/2)", live met 12-16 spelers, terug in de playlist, geen console-errors |
| Volle lobby | 16/16 in een tdm-lobby, derde browser drukt Snel spelen | krijgt een nieuwe lobby |
| Lobby's bekijken | B filtert op Domination en joint A's lobby | rij toont mode, kaart, 1/16, fase; join werkt |
| Privélobby | CTF op Bunker Flag, niet zichtbaar; vriend joint met code (met streepje) | code + link, voorbeeldregel bij het typen, niet in de lijst, onbekende code geeft "Game not found", 1v1 gaat live |
| Kaartstemming | privé tdm, wisselende maps, score 10, 14 bots | na 10 kills drie kaarten, stemmen met 3 (en wisselen 2 → 3), beide clients gaan naar de gekozen kaart (classic → Terminus), weg via Esc → Realms |
| Wapens | `weapon-check.py` (preview): elk primair wapen × elke optiek, secundaire wapens | ADS-tijd, zoom, scope-overlay (wapen weg), reticle bij red dot/holo, adem inhouden (sway 0,32 → 0,035, na 4 s 0,60, geluiden), elk schot hoorbaar, terugslag, herladen + geluiden, wisseltijd 0,28 s / Quickdraw 0,14 s, Extended Mags 42, demper-geluid, killfeed "You DMR Nova" |
| Klassen op de server | `class-guard.ts` | rommel (onbekende wapens, verkeerde slots, `{"toString":1}`, 5000 tekens) → altijd geldige uitrusting; optiek die niet past → eigen optiek; na 3 s wacht een klasse op het volgende leven; elke preset komt aan; anderen zien optiek en demper (`holds`); gun game negeert klassen |
| Protocolbots | `arena-bots.ts` (5 kaarten × tdm/ffa), `modes-bots.ts`, `cheat-bots.ts` | alles groen (na de fixes hieronder): 24/24 per kaart, 42/42 modes, 19/19 anti-cheat |
| Geluid | `audio-report.py`, captions in de preview (NL) | elk geluid hoorbaar en zonder clipping (hardst: stinger winst −6,1 dBFS, bolt-action −8,7); captions "Geweerschot ↗", "Voetstappen", "Dubbele kill" |
| Lobby openen tijdens een match | `room-stall.ts`: 6 nieuwe lobby's terwijl er gespeeld wordt | langste gat tussen snapshots 59 ms (normaal 44), aanmaken 21-28 ms |

### Prestaties (16 spelers: 15 bots + 1 Chromium die rent, richt en schiet; `arcade-perf.py`)

| Kaart | FPS (vsync) | frame p99 | max | JS/frame gem. / p95 | zonder vsync-cap |
|---|---|---|---|---|---|
| Terminus (station) | 120 | 10,2 ms | 10,4 ms | 0,76 / 1,18 ms | 536 fps, p99 4,5 ms |
| Skyline Villa | 120 | 10,2 ms | 10,4 ms | 1,04 / 1,45 ms | 530 fps, p99 4,2 ms |
| Sundown (town) | 120 | 10,2 ms | 16,6 ms | 1,06 / 1,40 ms | 517 fps, p99 4,7 ms |

Gelijk aan de roadmapmeting (classic: 120 fps, p99 10,4 ms, JS 0,58 ms; zonder cap 637 fps). Zonder cap zit er per run 1-2 keer
een frame van 220-270 ms in; met vsync niet (vermoedelijk een GPU-stall bij het eerste schot of model, niet verder onderzocht).
**Server** (`bench-arena.ts 16 30`, geïsoleerd): tick gem. 0,08-0,10 ms, 0,8-1,1% van een core op classic, station, villa, town
en yacht (roadmap: 0,085 ms, 0,93%). De `tick_duration`-p99 van een draaiende server liep op tot 36-60 ms, maar dat volgde de
machinebelasting; de geïsoleerde meting en `room-stall.ts` laten geen haperingen zien.
**Audio:** in een vuurgevecht met 16 spelers staat de stemmenlimiet constant op 64/64 (35-75 drops/s). Worst case uit
`audio-report.py`: 0,59 ms planning per frame (budget 0,3; roadmap 0,26), gemeten bij load 16: opnieuw meten op een rustige machine.

### Gerepareerd (met regressietest)

1. **Red dot/holo: je keek tegen de achterkant van een blok.** Bij richten vulde de platte achterkant van de receiver (vlak voor
   het oog) het beeld onder de stip. Het richtbeeld snijdt het wapen nu vlak achter het venster van de optiek af
   (`adsCutZ` in `WeaponModels.ts`). Test: `arcadeFeel.test.ts`. Shots: `r2-reddot-before.jpg`, `r2-reddot-after.jpg`.
2. **Eindscherm (met kaartstemming) over de scorebalk, killfeed en panelen:** "Red team wins!" stond op de timer en de
   stemkaarten op health/munitie. Het eindscherm verbergt de HUD eronder. e2e: `arcade-hud.spec.ts`. Shot: `r2-end-overlap.jpg`.
   **Create-a-Class lag over de scorebalk** (en "Match starts in 1" en het lobbypaneel schenen erdoor). Het menu verbergt nu de
   match-HUD eronder en heeft een donkerder achtergrond. e2e: `arcade-hud.spec.ts`. Shots: `r2-cac-before.jpg`, `r2-cac-after-nl.jpg`.
3. **Match-HUD alleen Engels.** Alles is nu NL/EN (135 keys `arc.*`/`mode.*`), ook de regels die de server stuurt
   (`localizeServerText`). Test: `arcadeI18n.test.ts`. Daarbij: een level-up in gun game toonde de wapen-id ("Level up: smg").
4. **Zonemarker aan de schermrand afgekapt** ("CONTESTED"/"BETWIST" half buiten beeld). De zijmarge houdt nu rekening met de
   breedte van het label. e2e: `arcade-hud.spec.ts` (faalt zonder fix). Shot: `r2-marker-clipped.jpg`.
5. **Captions over de wapenslots en munitie.** In de arcade staan ze nu erboven. e2e: `arcade-hud.spec.ts` (faalt zonder fix).
   Shot: `r2-captions-overlap.jpg`.
6. **Terugslag zakte terug tijdens het sproeien.** Herstel begon na 0,09 s zonder schot, maar de rifle (600/min) schiet elke
   0,1 s: hij klom maar half zo veel als ontworpen. Automatische wapens herstellen nu pas na een pauze langer dan hun interval.
   Test: `arcadeFeel.test.ts`. Gemeten in de browser: rifle klimt 9,5° per magazijn (was 7,0°).
7. **Burst rifle:** een burst die door een leeg magazijn werd afgebroken, schoot na het herladen vanzelf af. Test: `weapons.test.ts`.
8. **Server: `loadout` met een niet-string-veld** (`{"toString":1}`) liet `String()` gooien: ERROR in het log en de speler werd
   eruit gegooid (1011). Niet-strings tellen nu als afwezig. Test: `arcadeRoom.test.ts`.
9. **Voetstappen van een vijand vlakbij vielen weg** in een groot vuurgevecht (ambient-prioriteit, stemmen vol met schoten).
   Binnen 12 m hebben ze nu de prioriteit van een schot. Test: `audio.test.ts`.
10. **Privélobby bood 16 spelers aan** op een server met `ROOM_MAX_PLAYERS=8` (de standaard), die er stil 8 van maakte. `/api/server`
    meldt `roomMaxPlayers`; het menu biedt alleen wat mag. Tests: `realms.test.ts`, `rooms.it.test.ts`.
11. **Villa: richel van 1,5 bij het verzonken pad** (open punt 3 hieronder): het pad stopt nu een rij voor de stoeprand en de
    auto. `arena.test.ts` zoekt op alle kaarten naar slabvloeren naast zo'n trede (alleen villa had ze: 14).
12. **QA-gereedschap:** `arcade-perf-bots` liep met cover-variant 0 door de kratten van classic en werd voor noclip gekickt
    (gebruikt nu kaart en variant uit `welcome`); bots liepen over slabvloer op +1 (fly); een volle lobby liet de bots crashen;
    `arena-bots` vond op station geen duelplek; `/metrics` met `ADMIN_TOKEN` (`QA_METRICS_TOKEN`). Nieuw: `realms-flow.py`,
    `weapon-check.py`, `class-guard.ts`, `room-stall.ts`; `play-modes.py` kan onder last (`QA_FILL_BOTS`).

### Open (groter of een keuze voor Stijn)

1. **`ROOM_MAX_PLAYERS` staat standaard op 8.** Snel-spelen-lobby's krijgen die grootte, dus een 6v6 (BO-standaard) kan niet zonder
   de variabele. Advies: 12 voor arcade-lobby's (Docker/compose is van een andere agent).
2. ~~**Bots op Terminus blijven op hun eigen helft.**~~ Opgelost: `arenaPath` zoekt over alle stahoogtes (perrons, slabs,
   traptreden) met de botsingstest van de validator; een stap omhoog of omlaag is één `pos` zodra de bot de looptijd ervoor
   heeft gespaard. Test: `tests/arenaPath.test.ts` (rode spawn → blauwe spawn → ffa-spawns op elke kaart, door de validator).
3. ~~**Yacht-spawns zijn nog steeds te zien**~~ Opgelost: de boeg loopt taps toe waar het vierkante achterschip de kade
   afsluit. Kratten langs de noordrand van beide kades en twee fenders naast de boegloopplank: 0 / 0 plekken op de andere
   helft (was 215 / 71), 587 / 567 in totaal (was 1360 / 914). Test: `tests/spawnExposure.test.ts`.
4. **Audio worst case 0,59 ms/frame** (budget 0,3) en de 64/64 stemmen bij 16 spelers: opnieuw meten op een rustige machine; zo
   nodig minder stemmen per verre schot of een lagere `REMOTE_SHOTS_PER_FRAME`.
5. **Dev-preview:** de nep-server bevestigt de laatste kogel van een magazijn niet (de client toont "1" en herlaadt); alleen de
   preview, de echte server telt goed (25/25 bij de SMG).
6. **Lange frame zonder vsync** (220-270 ms, 1-2 keer per run van 30 s), zie prestaties.
7. ~~**Rubber-banding van eerlijke spelers onder last**~~ Opgelost (zie onder). Oorzaak: de validator rekende met
   aankomsttijden; onder last komen die in klonten (server- of netwerkachterstand), en bij framehaperingen valt een
   bunny-hop-afzet tussen twee rapporten op meer dan 1 blok onder de speler (de zoekdiepte was 1, de apex 1,32), of botst
   het hoofd tegen een lamp. Nu: `pos` draagt de fysicaklok (`step`), de regels rekenen daarmee en een tweede bucket houdt die
   klok binnen de echte tijd; afzetten tot 1,5 blok diep, dalende rapporten boven de oude curve, korte gebogen routes (om een
   schuurhoek en een paal in één haperend frame) en 2 s respijt bij een vertraging (vlag opgepakt). Repro en regressie:
   vlagdragerruns onder last op elke kaart met vlaggen en de dekroute van het jacht in `tests/anticheatMovement.test.ts`
   (oude validator: 14 rode tests). Oorspronkelijke melding: `play-modes.py` met
   12 extra bots (`QA_FILL_BOTS=12`), load 15-20: tdm op yacht, villa, town en station 0 correcties voor de browsers, ctf op
   station 0, maar **ctf op yacht: 7 correcties voor Alpha** (de vlagdrager-route over het dek, (-32..-28, 69-70, 1-4), en de
   steiger bij (-34,5, 65, -13)); serverregels in die run: `lag` 4, `speed` 2, `fly` 1. In een eerdere run bij load 150+ ook
   5× op station (14, 70-72, 19,5), bij een rustigere herhaling niet. Repro: `QA_FILL_BOTS=12 python3 scripts/qa/play-modes.py
   out.json ctf yacht`. Vermoeden: de token bucket van de snelheidscontrole is te krap voor frame-haperingen plus de
   bunny-hop-sprongen van de drager op de trappen van het jacht. Shot: `r2-rubberband-ctf-yacht.jpg`.

Screenshots ronde 2: `docs/qa/shots/arcade/r2-*.jpg`.

## Ronde 1

Stand: 2026-10. Elke mode (tdm, ffa, gungame, elimination, hardpoint, domination, ctf) op elke kaart (11) gespeeld met
twee echte Chromium-clients (`--use-angle=metal`, headless) tegen een echte server via Vite, plus een looptoer met de echte
spelerfysica over elke kaart (dev-preview). Invoer alleen via `game.input`. Scripts staan in `scripts/qa/` (zie onderaan).

## Samenvatting

| Onderdeel | Resultaat |
|---|---|
| Joinen, kaart laden, teams, warm-up → live | 77/77 combinaties OK (desert valt voor hardpoint/domination/ctf terug op classic: geen zones/vlaggen; het menu filtert dat al) |
| Spawns | Altijd op een blok, nooit in een blok, nooit zicht op de tegenstander bij de start (afstand 43–95 m) |
| Doel van de mode | tdm/ffa/elimination: kill (en `round-win`) op alle kaarten; hardpoint: heuvel bereikt en +1/s op alle kaarten; domination: punt veroverd (`zone-captured`) overal; ctf: vlag gepakt én gescoord op alle 10 kaarten met vlaggen; gun game: `level-up` overal waar de bots elkaar vonden (zie balans) |
| Vast komen te zitten | 0 keer in de 77 multiplayer-sessies; looptoer: 5 oude kaarten 0 incidenten; nieuwe kaarten: zie kaartproblemen |
| Rubber-banding van eerlijke spelers | 3 correcties in ~80 sessies, allemaal bij de bunny-hoppende bot onder zware machinebelasting (2× `lag`, 1× `speed`, yacht bij (-24, 66, -16)) |
| Console-errors | 0 |

## Gerepareerd (met regressietest)

1. **Eindscherm over het doodscherm heen.** Als de laatste kill van de match jou doodde, bleef "You were eliminated by …",
   "Respawning in 3" en de spectate-hint door het eindscherm heen staan. `ArcadeSession.onMatchEnd` sluit nu het doodscherm en
   het spectaten. Test: `tests/e2e/arcade-hud.spec.ts` (faalt zonder de fix). Shot: `shots/arcade/repro-death-then-end-tdm.jpg`.
2. **Eindscherm toonde de oude score bij objective-modes.** De server stuurt `matchend` vóór de laatste `match`/`roster`
   (bij ctf/zones komt de score pas daarna), dus het eindscherm zei "RED 0 – 0 BLUE" terwijl rood met 1 capture won.
   Het eindscherm wordt nu opnieuw getekend als score of roster na `matchend` binnenkomt. Test: `tests/e2e/arcade-hud.spec.ts`.
   Shot: `shots/arcade/play-ctf-villa.jpg` (vóór de fix).
3. **Objective-markers over de munitie- en healthpanelen.** Een marker van een zone onder of achter je werd tegen de onderrand
   geplakt, bovenop "30 / ∞". `placeMarker` heeft nu een `bottomMargin`; de HUD houdt ~30% van de hoogte onderin vrij.
   Test: `tests/modeView.test.ts`. Shots: `play-hardpoint-dockyard.jpg`, `play-domination-town.jpg` (vóór de fix).
4. **Town: dakladder van de herberg niet te beklimmen.** De eerste trede (-25, 70, -1) zat onder het dak (blok op y 72), dus de
   sprong naar de tweede trede stootte je hoofd; de high ground (-21, 73, 0) en zijn gedraaide kopie waren onbereikbaar.
   Het dakluik is één blok groter. Bevestigd met echte fysica (`try-path.py`): vóór vast op 70,1, na op het dak.
   Shots: `town-roof-ladder.jpg`, `town-roof-ladder-fixed.jpg`.
5. **Regressietests voor bereikbaarheid aangescherpt.** De flood-fill in `tests/arena.test.ts` en `tests/helpers/mapAnalysis.ts`
   telde een stap omhoog ook als er een plafond 2 blokken boven de afzet zat, en zag hekken/muren (1,5 hoog) als opstapjes.
   Beide regels zitten er nu in; zo vond de test de town-ladder.

## Open (groter, of van een andere agent)

1. *(Ronde 2: zie daar, punt 7.)* **Anti-cheat: eerlijke bunny-hopper gecorrigeerd** (`speed`, yacht; en twee `lag`-correcties). Alleen gezien onder zware
   CPU-belasting (frame-haperingen), op de anti-cheat-versie van vóór de laatste merge. Na de merge slagen alle tests
   (`npm test`: 1480/1480, ook `anticheatMovement` op town en de arcade-integratietests); de speeltest is daarop niet opnieuw
   gedraaid. Advies: `play-modes.py` nog eens draaien en op `tp=`/`cheat=` letten.
2. *(vervallen: de integratietests die onder belasting faalden slagen na de merge.)*
3. *(Gerepareerd in ronde 2.)* **Villa: verzonken stenen pad (bottom slabs in de vloerlaag, x ±10..14).** Vanaf het pad (y 64,5) is een richel van 1 blok
   1,5 hoog: daar kun je niet op springen, wel overal ernaast. Voelt als een onzichtbare muur. Shot: `walk-villa`-incident
   bij (12, 65, -26).
4. **Classic variant 1:** het midden van zone "West Lane" (-22, 4) ligt in een gele krat (variant-dekking); vangen werkt
   (y-tolerantie), maar de zonemarker staat in het blok.
5. *(Gerepareerd: de ladder begint met de rifle.)* **Gun Game begint met de shotgun.** Op grote open kaarten (classic, villa, yacht) duurde de eerste kill > 50 s: je ziet elkaar
   op 40–80 m en de shotgun doet daar niets. Overweeg een allround-wapen als eerste trede.
6. *(Gerepareerd: eindscherm zet de bescherming uit, leider alleen in het ladderpaneel, het paneel wijkt voor Tab.)* **HUD:** het "Spawn protection"-label schijnt door het eindscherm; in gun game staat "Leader: …" twee keer (onder de timer
   en in het ladderpaneel) en het scoreboard ligt over het ladderpaneel (`hud-gungame-board.jpg`).
7. **Dev-preview-race:** `game.arcadePreview()` aangeroepen voordat `start()` klaar is, wordt door `enterMenu()` weggegooid
   (wacht in tests op `game.world`).
8. *(Nog open, ronde 2 punt 3.)* **Yacht is niet helemaal eerlijk:** de rode spawn is vanaf 215 plekken op de blauwe helft te zien, de blauwe vanaf 71
   (`map-audit.ts`).

## Statische kaartaudit (`scripts/qa/map-audit.ts`)

Geen vallen (plekken waar je niet meer weg komt), niemand komt op of over de muur, alle spawns staan goed, alle zones en vlaggen
bereikbaar (behalve het krat-geval hierboven). Eerste contact 7–12 s lopen. Spawn naar spawn nergens zicht.

## Scripts

Servers: `PORT=3417 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts`, `QA_SERVER_PORT=3417 npx vite --config scripts/qa/vite.qa.config.mjs --port 5417`
(herstarten na elke codewijziging), `npx tsx scripts/qa/route-server.ts 5418`.

| Script | Wat |
|---|---|
| `map-audit.ts` | statische audit: bereikbaarheid, vallen, spawnzicht, objectives, lange lijnen |
| `walkgraph.ts`, `walk-routes.ts`, `walk-maps.py` | looptoer met echte fysica langs alle platforms en high ground |
| `play-modes.py` | elke mode × kaart met twee browsers: spawns, doel, rubber-banding, anti-cheat-tellers, screenshot |
| `hud-shots.py` | HUD-screenshots per mode (spelen, Tab, dood, einde) in de preview |
| `try-path.py`, `blocks-at.ts` | een vastloopplek reproduceren en de blokken eromheen tonen |
| `repro-death-end.py` | repro van bug 1 |
| `curate-shots.py` | screenshots verkleinen voor de repo |
| `realms-flow.py` | ronde 2: Realms via de menu's (snel spelen per mode, volle lobby, lobby's bekijken, privélobby, kaartstemming), met bots; `QA_SERVER_LOG` telt anti-cheat-hits |
| `weapon-check.py` | ronde 2: elk wapen × optiek in de preview (ADS, scope, adem, terugslag, herladen, wisselen, demper, killfeed) |
| `class-guard.ts` | ronde 2: klassen tegen de echte server (rommel, 3 s-venster, presets, `holds`, gun game) |
| `room-stall.ts` | ronde 2: hapert een lopende match als er lobby's worden geopend? |
| `arcade-perf.py` | 15 bots + 1 Chromium, frametijden en servertick (`QA_METRICS_TOKEN` bij een server met `ADMIN_TOKEN`) |

`play-modes.py` neemt nu `QA_ROUTES`, `QA_SERVER`, `QA_METRICS_TOKEN` en `QA_FILL_BOTS=n` (n bots erbij: spelen onder last).
