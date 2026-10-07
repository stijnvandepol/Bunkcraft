# Krunker-gevoel voor de Realms-shooters

Onderzoek (oktober 2026) naar wat Krunker.io zo snel en verslavend maakt, en wat daarvan in
BunkCraft past. We nemen **mechanieken** over, nooit namen, assets, geluiden of branding: alle
klassen, perks en blokken hieronder hebben eigen namen en eigen (procedurele) visuals.

Bronnen: [Krunker controls guide](https://krunker.io/guides/controls/),
[movement-glossary (PhilzGoodman)](https://www.philzgoodman.com/krunkerio-guides/the-movement-techniques-in-krunker-in-2020),
[movement-mechanics (shapes.inc)](https://shapes.inc/fandom/krunker/movement-mechanics),
[klassen-overzicht (fandom)](https://krunkerio.fandom.com/wiki/Classes),
[Nuke (fandom)](https://krunkerio.fandom.com/wiki/Nuke),
[editor-changelog (GameFAQs)](https://gamefaqs.gamespot.com/pc/304507-krunker/faqs/78864/krunker-changelog).
Exacte getallen publiceert Krunker niet; waar hieronder getallen staan zijn het onze eigen keuzes.

## Hoe Krunker beweegt

| Techniek | Wat het is | Waarom het leuk is |
|---|---|---|
| **Slide** | Crouch terwijl je rent: je glijdt laag weg met een snelheidsboost die snel uitdooft. | Snelle, lage peek; moeilijk te raken. |
| **Slide-hop** | Springen *uit* een slide: de slide-snelheid gaat mee de lucht in. Ritme: springen → crouch vlak voor de landing → meteen weer springen. | Dé kernvaardigheid: skill-expressie, snelheid boven rennen. |
| **Bunny hop** | Springen op het moment van landen: geen grondwrijving, momentum blijft. | Flow, je verliest niets door te springen. |
| **Air strafe / strafe-hop / curve-slide** | Strafe-toets + muis meedraaien in de lucht of in de slide: de baan buigt mee zonder snelheid te verliezen. | Hoeken nemen op volle snelheid, aim van de tegenstander ontwijken. |
| **Crouch-jump** | Benen intrekken in de lucht om net hoger te komen. | Randen halen, kleine shortcuts. |
| **Ramp slide** | Een slide die naar beneden loopt dooft minder snel uit. | Kaarten met hoogteverschil belonen. |
| **Jump/bounce pads** | Blok dat je omhoog (of een richting in) lanceert, sterkte per pad in de editor. | Routes naar hoge plekken, snelle rotatie. |
| **Wall-jump** | Afzetten tegen een muur (één klasse). | Klasse-identiteit. |

Kenmerkend: je verliest **nooit** zomaar snelheid door te springen of te sliden; de grondwrijving
is de vijand, en de skill zit in zo weinig mogelijk grond aanraken. Diagonaal rennen is in Krunker
sneller (strafe-multiplier 1,2); dat nemen we bewust **niet** over (het voelt als een bug en maakt
het snelheidsbudget van de anticheat ruimer).

## Pace en flow

- **Respawn**: ongeveer direct (1-3 s), je spawnt ver van vijanden en kiest bij de respawn je klasse.
- **Spawnbescherming**: kort, en ze vervalt zodra je schiet.
- **Klassen** verschillen in HP, snelheid en wapen: een tanky langzame klasse (130 HP, 0,86×),
  standaardklassen (100 HP, 1,0-1,05×) en snelle klassen (1,18-1,2×) met SMG of alleen een mes.
  Wisselen kan bij elke respawn, zonder menu-gedoe.
- **Killstreaks**: beloningen op 7/12/15/20/25 kills, met als topper een "nuke" op 25 die iedereen
  doodt. Vooral de lage streaks worden echt gehaald.
- **Feedback**: harde hitmarker en kill-ding, damage-richting, killcam/spectate van je killer,
  korte wapenwissel (secondary als snelle backup).

## Wat past bij BunkCraft

| Onderdeel | Besluit | Waarom |
|---|---|---|
| Slide, slide-hop, bhop, air strafe | **Nu** | Kern van het gevoel; past op voxels (vlakke vloeren). |
| Ramp/trap slide | **Nu**, in voxel-vorm | Elke traptrede omlaag is een mini-sprongetje met de lage luchtwrijving: een slide de trap af houdt vanzelf langer snelheid. |
| Crouch (lage hitbox, langzamer) | **Nu** | Nodig voor de slide-pose; server-hitbox moet meedoen. |
| Jump pads (alleen verticaal) | **Nu**: mechaniek + helper `jumpPad()`; plaatsing doet de map-agent | Verticaal is exact te valideren door de server; richting-pads later. |
| Snellere respawn, protectie eindigt bij schieten | **Nu** | Goedkoop, grote impact op flow. |
| Klasse wisselen bij respawn | Bestaat al (cijfertoetsen op het death screen, `CLASS_SWAP_WINDOW`); we voegen een snelle klasse toe. |
| Snelle "Scout"-klasse + perk **Lichtvoetig** | **Nu** | Eigen naam; +10% snelheid en kortere slide-cooldown. Mes + pistool-spel kan met elke klasse via slot 3. |
| Raket-klasse | **Overgeslagen** | Ons servermodel is hitscan; projectielen + splash is een eigen project. |
| Killstreak: radar-ping (UAV-achtig) op 5 kills | **Nu** | Goedkoop (één servermelding), geen airstrikes. |
| Nuke / airstrikes / juggernaut | **Niet** | Frustrerend voor de rest van de lobby, grote engine-impact. |
| Wall-jump, crouch-jump (collision box krimpt) | **Later** | Vergt variabele collision box in client én validator. |
| Diagonale strafe-boost | **Nooit** | Zie boven. |
| Richting-jump pads, launch-pads met horizontale boost | **Later** | Validator moet dan horizontale impulsen modelleren. |

## Ontwerp (onze getallen)

Alles staat in `src/player/ArcadeMove.ts` (gedeeld door client en server):

- **Slide**: start bij crouch-druk (of crouch ingedrukt houden tijdens de landing) met minstens
  60% van de rensnelheid. Snelheid springt naar `max(huidig, ren × 1,45)` en dooft daarna exponentieel
  uit (grond: 2,4/s, lucht: 0,8/s) richting rensnelheid. Maximaal 0,8 s grondtijd, cooldown 0,9 s
  (Lichtvoetig: 0,65 s). Camera zakt naar 1,0 blok, FOV-kick, eigen slide-geluid.
- **Slide-hop / bhop**: springen op de grond (ook uit een slide) gebruikt die stap luchtbesturing, dus
  geen grondwrijving. In de lucht blijft snelheid boven de rensnelheid behouden (0,8/s uitdoving) en
  draai je de baan mee met strafe + muis (air strafe). Snelheid *winnen* met strafen kan niet: de enige
  bron van extra snelheid is de slide-boost. Dat maakt het servermodel exact.
- **Crouch**: 55% snelheid, oog 1,27, hitbox 1,5 hoog; slide-hitbox 1,15 hoog.
- **Jump pad**: blok in de vloer, lanceert met 16 blokken/s omhoog (top ≈ 4,3 blokken), horizontale
  snelheid blijft.

**Anticheat-model**: de client meldt in `pos` de stap waarop zijn laatste slide begon (`sl`). De
server accepteert dat alleen met de cooldown ertussen en geeft dan een snelheidsenvelop
`max × (1 + 0,45·e^(−0,8·t))` die precies de bovengrens van de clientfysica is (elke vorm van
uitdoving in de client is minstens zo snel als 0,8/s). Zonder gemelde slide blijft het oude
budget gelden. Pads verhogen de sprongcurve alleen als er echt een pad-blok onder het pad van
de speler lag.
